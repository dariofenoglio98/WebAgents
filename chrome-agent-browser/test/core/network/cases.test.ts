/**
 * network.v0 enforcement cases (`examples/network/cases/cases.json`, spec §7): every case ends at
 * the stage with the code the list expects, on this runtime, as `test_network_cases.py` asserts it
 * on the reference. The probes are written by the conformance driver from agentpkg's own
 * `network_probe.py`, so the two suites read the same mutated packages and fixtures.
 */
import { describe, expect, it } from "vitest";

import { ValidationError } from "../../../src/core/errors.js";
import { ExecutionError } from "../../../src/core/execution/errors.js";
import { normalizeHostLimits } from "../../../src/core/execution/limits.js";
import { checkCapabilities, normalizeGrants } from "../../../src/core/execution/policy.js";
import { fixtureAdapters } from "../../../src/core/fixtures.js";
import type { JsonObject } from "../../../src/core/json.js";
import type { Package } from "../../../src/core/package.js";
import type { AuditEvent } from "../../../src/core/types.js";
import { runWorkflow, type ExecutionReport } from "../../../src/core/workflow/interpreter.js";
import { caseList, probeCases } from "../../helpers/network-package.js";
import { loadSource } from "../../helpers/source-tree.js";

const LIST = caseList();

async function runFixture(pkg: Package, grants: Record<string, "once" | "session" | "always" | "deny">): Promise<{ report: ExecutionReport; failed: boolean }> {
  const { router, handlers, input } = fixtureAdapters(pkg);
  try {
    return { report: await runWorkflow(pkg, input, { grants, handlers, router, approvedTools: ["lookup"] }), failed: false };
  } catch (error) {
    const report = (error as { execution_report?: ExecutionReport }).execution_report;
    if (report === undefined) throw error;
    return { report, failed: true };
  }
}

const events = (audit: readonly AuditEvent[], action: string): JsonObject[] => audit.filter((event) => event.action === action) as unknown as JsonObject[];

describe("network.v0 enforcement cases (spec §7)", () => {
  it("lists the 46 cases of the reference", () => {
    expect(LIST).toHaveLength(46);
    expect(new Set(LIST.map((testCase) => testCase.id)).size).toBe(46);
  });

  for (const testCase of LIST) {
    it(`${testCase.id}: ${testCase.stage} ${testCase.code}`, async () => {
      const probe = probeCases().get(testCase.id)!;
      if (testCase.stage === "validation") {
        const refused = await loadSource(probe.files).then(
          () => null,
          (error: unknown) => error,
        );
        expect(refused).toBeInstanceOf(ValidationError);
        expect((refused as Error).message.startsWith(`${testCase.code}: `), (refused as Error).message).toBe(true);
        return;
      }
      const pkg = await loadSource(probe.files);
      if (testCase.stage === "grants") {
        expect(() => normalizeGrants(pkg, probe.grants)).toThrow(ExecutionError);
        try {
          normalizeGrants(pkg, probe.grants);
        } catch (error) {
          expect((error as ExecutionError).code).toBe(testCase.code);
        }
        return;
      }
      if (testCase.stage === "host") {
        let caught: ExecutionError | null = null;
        try {
          checkCapabilities(pkg, normalizeHostLimits(null), { fixture: true });
        } catch (error) {
          caught = error as ExecutionError;
        }
        expect(caught?.code).toBe(testCase.code);
        if (testCase.expect?.node) expect(caught?.detail.node).toBe(testCase.expect.node);
        return;
      }
      const { report, failed } = await runFixture(pkg, probe.grants);
      const audit = report.audit;
      const expectation = (testCase.expect ?? {}) as Record<string, unknown>;
      if (testCase.code === "completed") {
        expect(failed).toBe(false);
        expect(report.status).toBe("completed");
        expect(events(audit, "network.completed")).toHaveLength(1);
        expect(events(audit, "network.failed")).toHaveLength(0);
      } else {
        expect(failed).toBe(true);
        expect(report.status).toBe("failed");
        expect(report.error_code).toBe(testCase.code);
        const nodeFailed = events(audit, "node.failed").filter((event) => event.node_id === expectation.node);
        expect(nodeFailed[0]?.error_code).toBe(testCase.code);
        if (expectation.refused_before_start) {
          expect(events(audit, "network.refused")[0]?.reason).toBe(testCase.reason);
          expect(events(audit, "network.started")).toHaveLength(0);
          expect(events(audit, "network.activated")).toHaveLength(0);
        } else {
          expect(events(audit, "network.failed")[0]?.error_code).toBe(testCase.code);
        }
      }
      if (testCase.reason !== undefined && !expectation.refused_before_start) {
        const refused = events(audit, "route.decided").filter((event) => event.allowed === false);
        expect(refused).toHaveLength(1);
        expect(refused[0]!.reason).toBe(testCase.reason);
        expect(refused[0]!.chosen_by).toBe(expectation.chosen_by);
        if (expectation.chosen_by === "model") {
          // A refused chosen route is a non-conforming answer: charged, audited as a model failure
          // that names the route check, and nothing dispatched after it.
          const failedCalls = events(audit, "model.failed");
          expect(failedCalls.at(-1)?.reason).toBe("model_output_not_conforming");
          expect(failedCalls.at(-1)?.failed_check).toEqual({ check: "route", failure: testCase.reason, next: refused[0]!.next });
        }
      }
      if ("route_decided" in expectation) expect(events(audit, "route.decided")).toHaveLength(expectation.route_decided as number);
      if ("step" in expectation) expect(events(audit, "node.failed").find((event) => event.node_id === expectation.step)?.error_code).toBe(testCase.code);
      if ("refused" in expectation) expect(events(audit, "model.refused")[0]?.reason).toBe(expectation.refused);
      if ("activations" in expectation) {
        const counts: Record<string, number> = {};
        for (const event of events(audit, "network.activated")) counts[String(event.role)] = (counts[String(event.role)] ?? 0) + 1;
        expect(counts).toEqual(expectation.activations);
      }
      if ("hops" in expectation) expect(events(audit, "network.completed")[0]?.hops).toBe(expectation.hops);
      if (expectation.tool_called === false) expect(events(audit, "tool.called")).toHaveLength(0);
      if ("tool_calls" in expectation) expect(events(audit, "tool.called")).toHaveLength(expectation.tool_calls as number);
      if ("model_calls" in expectation) expect(events(audit, "model.completed")).toHaveLength(expectation.model_calls as number);
      if ("committed" in expectation) expect(events(audit, "network.state.committed")).toHaveLength(expectation.committed as number);
    });
  }
});
