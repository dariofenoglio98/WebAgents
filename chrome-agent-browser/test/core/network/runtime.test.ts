/**
 * network.v0 in the Chrome runtime, beyond the enforcement cases:
 * - a refused chosen route is re-asked, as a host may (R-28), with the route check named in the
 *   feedback line and in the re-ask's `model.called`, and every decision recorded;
 * - the node's own timeout is named `timeout` by `network.failed` too (R-15, R-18);
 * - the execution session records the envelope, under the deadline its watchdog enforces, and
 *   refuses a plan whose envelope differs from the signed declaration's (R-24).
 */
import { describe, expect, it } from "vitest";

import { canonicalJson } from "../../../src/core/canonical.js";
import type { ExecutionError } from "../../../src/core/execution/errors.js";
import { localExecutionPlan } from "../../../src/core/execution/plan.js";
import { ExecutionSession } from "../../../src/core/execution/runner.js";
import { fixtureAdapters } from "../../../src/core/fixtures.js";
import { sha256HexSync } from "../../../src/core/hash.js";
import type { JsonObject, JsonValue } from "../../../src/core/json.js";
import type { ModelRequest, ModelResult } from "../../../src/core/models/contract.js";
import { FixtureRouter } from "../../../src/core/models/fixture.js";
import { loadPackageBytes } from "../../../src/core/package.js";
import type { AuditEvent } from "../../../src/core/types.js";
import { runWorkflow, type ExecutionReport } from "../../../src/core/workflow/interpreter.js";
import { NETWORK_TEST_ARCHIVE, probeCases, probeGrants } from "../../helpers/network-package.js";
import { readBytes } from "../../helpers/paths.js";
import { change, loadSource } from "../../helpers/source-tree.js";

const NETWORK_TEST_FINGERPRINT = "sha256:f081f81d9f71207ba8fdeb5d3f142c8c1e1ebb839c71e2b799916ddeb387ea00";
const events = (audit: readonly AuditEvent[], action: string): JsonObject[] => audit.filter((event) => event.action === action) as unknown as JsonObject[];

/** The fixture's answers, except that a route offered a target with no uses left first names it (once), as a model that overshoots a cap would. */
class OvershootingRouter extends FixtureRouter {
  override readonly nonconformingRetries = 2;
  readonly requests: ModelRequest[] = [];
  private overshot = false;

  override async complete(request: ModelRequest, maxOutputTokens: number): Promise<ModelResult> {
    this.requests.push(request);
    const targets = ((request.data as JsonObject).targets ?? []) as JsonObject[];
    const spent = targets.find((target) => target.uses_left === 0);
    if (request.task === "route" && spent !== undefined && !this.overshot && request.feedback === undefined) {
      this.overshot = true;
      const output = { next: spent.role, message: { text: "once more" } } as JsonValue;
      return { output, input_tokens: await this.countTokens(request), output_tokens: 8 };
    }
    return super.complete(request, maxOutputTokens);
  }
}

/** A router that never answers: the call waits until it is cancelled. */
class SilentRouter extends FixtureRouter {
  override complete(_request: ModelRequest, _maxOutputTokens: number, signal?: AbortSignal): Promise<ModelResult> {
    return new Promise((_resolve, reject) => signal?.addEventListener("abort", () => reject(signal.reason), { once: true }));
  }
}

async function run(pkg: Awaited<ReturnType<typeof loadSource>>, router: FixtureRouter, grants: Record<string, "once" | "session" | "always" | "deny">): Promise<ExecutionReport> {
  const { handlers, input } = fixtureAdapters(pkg);
  try {
    return await runWorkflow(pkg, input, { grants, handlers, router, approvedTools: ["lookup"] });
  } catch (error) {
    const report = (error as { execution_report?: ExecutionReport }).execution_report;
    if (report === undefined) throw error;
    return report;
  }
}

describe("a refused chosen route is re-asked (R-28)", () => {
  it("names the route check, records every decision, and the walk completes within the envelope", async () => {
    const pkg = await loadPackageBytes(readBytes(NETWORK_TEST_ARCHIVE));
    const fixture = fixtureAdapters(pkg);
    const router = new OvershootingRouter((JSON.parse(new TextDecoder().decode(pkg.files.get(String(pkg.graph.fixture))!)) as JsonObject).models as JsonObject);
    const report = await runWorkflow(pkg, fixture.input, { grants: probeGrants(), handlers: fixture.handlers, router, approvedTools: ["lookup"] });
    expect(report.status).toBe("completed");
    const decided = events(report.audit, "route.decided");
    const refused = decided.filter((event) => event.allowed === false);
    expect(refused).toHaveLength(1);
    expect(refused[0]).toMatchObject({ chosen_by: "model", reason: "edge_exhausted" });
    // The refused decision is followed by the re-ask's decision at the same hop and activation.
    const after = decided[decided.indexOf(refused[0]!) + 1]!;
    expect(after).toMatchObject({ allowed: true, hop: refused[0]!.hop, activation: refused[0]!.activation });
    const failed = events(report.audit, "model.failed");
    expect(failed.at(-1)).toMatchObject({ reason: "model_output_not_conforming", failed_check: { check: "route", failure: "edge_exhausted", next: refused[0]!.next } });
    const reasked = events(report.audit, "model.called").filter((event) => event.attempt === 2);
    expect(reasked).toHaveLength(1);
    expect(reasked[0]!.after).toEqual({ output_failure: "check", failed_check: { check: "route", failure: "edge_exhausted", next: refused[0]!.next } });
    expect(reasked[0]!.node_id).toBe("delegate/Desk/route");
    const feedback = router.requests.find((request) => request.feedback !== undefined)!.feedback!;
    expect(feedback).toBe(
      `The previous answer was not accepted: the route check refused it: edge_exhausted for "${String(refused[0]!.next)}". Choose among the targets whose uses_left is above zero, or done where may_end is true. Return the complete JSON document again, corrected.`,
    );
    // The re-ask is a model call of the role, inside the envelope the plan states.
    expect(events(report.audit, "model.completed").length + failed.length).toBeLessThanOrEqual(9);
  });
});

describe("the node's own timeout is named by network.failed (R-15, R-18)", () => {
  it("records network.failed with timeout before node.failed, at the role and hop where it stopped", async () => {
    const probe = probeCases().get("fixture-walk")!;
    const files = new Map(probe.files);
    change(files, "graph.json", (graph) => {
      const node = (graph.nodes as JsonObject[]).find((item) => item.type === "network")!;
      node.timeout_seconds = 1;
    });
    const pkg = await loadSource(files);
    const report = await run(pkg, new SilentRouter({}), probe.grants);
    expect(report.status).toBe("failed");
    expect(report.error_code).toBe("timeout");
    const actions = report.audit.map((event) => event.action);
    const networkFailed = events(report.audit, "network.failed");
    expect(networkFailed).toHaveLength(1);
    expect(networkFailed[0]).toMatchObject({ error_code: "timeout", node_id: "delegate", role: "Desk", hop: 0 });
    const nodeFailed = report.audit.findIndex((event) => event.action === "node.failed" && event.node_id === "delegate");
    expect(actions.indexOf("network.failed")).toBeLessThan(nodeFailed);
    expect((report.audit[nodeFailed] as unknown as JsonObject).error_code).toBe("timeout");
  });
});

describe("the execution session and the envelope (R-24)", () => {
  async function session(options: { tamper?: (network: JsonObject) => void; limits?: JsonObject } = {}) {
    const bytes = readBytes(NETWORK_TEST_ARCHIVE);
    const pkg = await loadPackageBytes(bytes);
    const decisions = probeGrants();
    const { plan, authorization } = localExecutionPlan({ pkg, archiveSha256: sha256HexSync(bytes), signerFingerprint: NETWORK_TEST_FINGERPRINT, decisions, approvedTools: ["lookup"], fixture: true });
    if (options.tamper) options.tamper(plan.execution.network as JsonObject);
    const fixture = fixtureAdapters(pkg);
    const running = new ExecutionSession();
    const begin = running.begin({ run_id: "network_run", run_plan: plan, authorization, input: fixture.input, limits: options.limits }, { archive: bytes, fixture: { router: fixture.router, handlers: fixture.handlers } });
    return { running, begin, plan };
  }

  it("records the envelope under the host's deadline, and the run's network.started agrees with it", async () => {
    const { running, begin, plan } = await session({ limits: { run_timeout_seconds: 50 } });
    expect(plan.execution.network).not.toBeNull();
    const report = await begin;
    const recorded = (report.capabilities.network as JsonObject).worst_case as JsonObject;
    expect(recorded.seconds).toBe(50);
    const outcome = await running.run();
    expect(outcome.result.status).toBe("completed");
    const audit = JSON.parse(new TextDecoder().decode(outcome.files.find(([name]) => name === "audit.json")![1])) as JsonObject[];
    const started = audit.find((event) => event.action === "network.started")!;
    const bound = started.bound as JsonObject;
    for (const key of Object.keys(bound)) expect(canonicalJson(bound[key]), key).toEqual(canonicalJson(recorded[key]));
  });

  it("refuses a plan whose envelope differs from the signed declaration's", async () => {
    const { begin } = await session({
      tamper: (network) => {
        (network.worst_case as JsonObject).tokens = 1_000_000;
      },
    });
    const refused = await begin.then(
      () => null,
      (error: unknown) => error as ExecutionError,
    );
    expect(refused?.code).toBe("execution_plan_invalid");
    expect(refused?.message).toBe("The run plan's delegation envelope does not match the package's own declaration");
  });
});
