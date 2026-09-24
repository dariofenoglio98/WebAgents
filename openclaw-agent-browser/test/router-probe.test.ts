/**
 * The whole stack except the provider, end to end.
 *
 * Real `agentpkg browser-serve` control plane, real run plan, real `agentpkg
 * host-bridge` child, real `ModelRouter` — and one stub in place of OpenClaw's
 * completion runtime, so the suite is deterministic and spends nothing. What is
 * under test is the authority chain in front of the first token and the shape
 * of what comes back.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { AgentBrowserBackend } from "../src/backend.js";
import type { HostLlm } from "../src/host-llm.js";
import type { ModelHost } from "../src/host-models.js";
import { AGENTPKG_BIN, DIST, HOST_CONFIG_WITH_MODEL_OVERRIDE, hasAgentpkg } from "./fixtures.js";

const runs = hasAgentpkg();
const log = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
const AGENDA = join(DIST, "meeting-agenda.agent.pkg");
const REVIEW = join(DIST, "literature-review.agent.pkg");

type Row = Record<string, unknown>;

const BIG: Row = {
  id: "big",
  name: "Big Model",
  provider: "acme",
  reasoning: true,
  input: ["text"],
  contextWindow: 400_000,
  contextTokens: 200_000,
  compat: { supportsTools: true, supportsJsonSchemaResponseFormat: true },
};

function makeHost(state: { rows: Row[]; offered: string[] }): ModelHost {
  return {
    config: HOST_CONFIG_WITH_MODEL_OVERRIDE,
    runtimeVersion: "2026.9.5",
    browse: async () => ({
      byProvider: new Map([["acme", new Set(state.offered)]]),
      modelCatalog: state.rows as never,
      modelNames: new Map(state.rows.map((row) => [`acme/${row.id}`, String(row.name)])),
    }),
  };
}

/** A provider stand-in that answers the probe exactly as asked. */
function stubLlm(overrides: Record<string, unknown> = {}) {
  const calls: Array<Record<string, unknown>> = [];
  const llm: HostLlm = {
    complete: async (params) => {
      calls.push(params as unknown as Record<string, unknown>);
      return {
        text: '{"status":"ok","echo":"router probe"}',
        provider: "acme",
        model: "big",
        responseModel: "big-2026-09-01",
        stopReason: "stop",
        usage: { inputTokens: 640, outputTokens: 11, totalTokens: 651, costUsd: 0.00051 },
        execution: { mode: "direct-provider", owner: { kind: "provider", id: "acme" } },
        ...overrides,
      };
    },
  };
  return { llm, calls };
}

let stateDir = "";
let backend: AgentBrowserBackend;
let hostState: { rows: Row[]; offered: string[] };
let stub: ReturnType<typeof stubLlm>;

function unwrap<T>(
  result: { ok: true; value: T } | { ok: false; error: { code: string; detail?: string } },
): T {
  if (!result.ok) {
    throw new Error(`expected ok, got ${result.error.code}: ${result.error.detail ?? ""}`);
  }
  return result.value;
}

function expectError(
  result: { ok: true; value: unknown } | { ok: false; error: { code: string; detail?: string } },
) {
  if (result.ok) throw new Error("expected a failure");
  return result.error;
}

/** Trust, authorize, evaluate and prepare — the path a person takes in the UI. */
async function prepared(modelId = "acme/big", artifact = AGENDA) {
  const view = unwrap(await backend.openLocal(artifact));
  await backend.pinSessionPublisher(view.sessionId, view.publisher.signerFingerprint!, "package");
  const refreshed = unwrap(await backend.getPackage(view.sessionId));
  const permissions = unwrap(await backend.getPermissions(view.sessionId));
  const receipt = unwrap(
    await backend.authorize(
      view.sessionId,
      refreshed.identity.digest,
      permissions.permissions.map((item) => ({
        permissionId: item.id,
        decision: "session" as const,
      })),
      // A declared tool needs its own approval before a plan can bind it.
      permissions.toolApprovals.map((item) => ({ toolId: item.toolId, approved: true })),
    ),
  );
  await backend.evaluateModels(view.sessionId);
  const state = unwrap(
    await backend.prepareRunPlan(
      view.sessionId,
      refreshed.identity.digest,
      receipt.receiptId,
      modelId,
    ),
  );
  return { sessionId: view.sessionId, digest: refreshed.identity.digest, receipt, plan: state.plan! };
}

describe.runIf(runs)("the developer router probe", () => {
  beforeAll(async () => {
    stateDir = await mkdtemp(join(tmpdir(), "agent-browser-probe-"));
    hostState = { rows: [BIG], offered: ["big"] };
    stub = stubLlm();
    backend = new AgentBrowserBackend({
      config: { agentpkgPath: AGENTPKG_BIN, localPackages: { roots: [DIST] } },
      logger: log,
      stateDir,
      modelHost: makeHost(hostState),
      llm: { complete: (params) => stub.llm.complete(params) },
      bridgeLimits: { sessionTimeoutMs: 60_000, completionTimeoutMs: 30_000 },
    });
    await backend.initialize();
    await backend.launch();
  }, 90_000);

  afterEach(async () => {
    for (const open of unwrap(await backend.listSessions()).sessions) {
      await backend.closeSession(open.sessionId);
    }
    stub = stubLlm();
  });

  afterAll(async () => {
    await backend?.stop();
    await rm(stateDir, { recursive: true, force: true });
  });

  it("probes a plan that binds host tools, re-checking the bindings and calling none", async () => {
    const { sessionId, plan } = await prepared("acme/big", REVIEW);
    expect(plan.toolBindings.length).toBeGreaterThan(0);
    const report = unwrap(
      await backend.probeRouter(sessionId, plan.runPlanId, plan.runPlanSha256),
    );
    expect(report.status).toBe("ok");
    expect(report.model.invoked).toBe("acme/big");
    expect(report.workflowExecuted).toBe(false);
    // The bindings were revalidated against this host's live registry.
    expect(report.revalidated.some((item) => item.includes("tool"))).toBe(true);
    // One host-owned completion and nothing else: no tool was reached.
    expect(stub.calls).toHaveLength(1);
  }, 120_000);

  it("proves the router contract against the model the plan bound", async () => {
    const { sessionId, plan } = await prepared();
    const report = unwrap(
      await backend.probeRouter(sessionId, plan.runPlanId, plan.runPlanSha256),
    );

    expect(report.status).toBe("ok");
    expect(report.probe).toEqual({ status: "ok", echo: "router probe" });
    expect(report.model.planned).toBe("acme/big");
    expect(report.model.invoked).toBe("acme/big");
    expect(report.model.responseModel).toBe("big-2026-09-01");
    expect(report.runPlanSha256).toBe(plan.runPlanSha256);

    // The router declares what the adapter delivers, not what the catalog claims.
    expect(report.router.routerId).toBe("openclaw.host-bridge.v0");
    expect(report.router.capabilities.sort()).toEqual(["reasoning", "structured_output"]);
    expect(report.router.notDeclared.sort()).toEqual(["multimodal", "tool_use"]);
    expect(report.router.contextWindow).toBe(200_000);

    // Structured output was both requested and enforced.
    expect(report.structuredOutput).toMatchObject({
      validated: true,
      constrainedByHost: true,
      parse: "direct",
    });

    // The bound is the provable one, because this host publishes no tokenizer.
    expect(report.tokens.hostTokenizer).toBe(false);
    expect(report.tokens.basis).toBe("utf8_upper_bound");
    expect(report.tokens.framingAllowance).toBe(512);
    expect(report.usage.inputTokens).toBe(640);
    expect(report.usage.outputTokens).toBe(11);
    expect(report.usage.costUsd).toBeCloseTo(0.00051);
    expect(report.accounting).toMatchObject({
      inputWithinBound: true,
      outputWithinCap: true,
      maxOutputTokens: 4096,
    });

    // Nothing from the package took part.
    expect(report.workflowExecuted).toBe(false);
    expect(report.packageExecution).toEqual({
      workflowInstantiated: false,
      workersStarted: 0,
      toolsCalled: 0,
      packageInstructionsLoaded: false,
      exportsWritten: 0,
    });
    expect(report.package.packageId).toBe("org.webagents.meeting-agenda");

    // Every authority fact was re-checked between the plan and the first token.
    expect(report.revalidated).toEqual([
      "run_plan_identity",
      "run_plan_readiness",
      "run_plan_preflight",
      "execution_mode",
      "package_digest",
      "archive_sha256",
      "execution_profile",
      "package_validation",
      "signature_status",
      "publisher_trust",
      "signer_fingerprint",
      "authorization_receipt",
      "receipt_not_expired",
      "model_permission_granted",
      "model_available",
      "model_identity",
      "model_compatibility",
    ]);
  }, 180_000);

  it("sends no package content to the model", async () => {
    const { sessionId, plan } = await prepared();
    unwrap(await backend.probeRouter(sessionId, plan.runPlanId, plan.runPlanSha256));
    expect(stub.calls).toHaveLength(1);
    const sent = JSON.stringify(stub.calls[0]).toLowerCase();
    for (const word of ["meeting", "agenda", "participant", "facilitator", "perspective"]) {
      expect(sent).not.toContain(word);
    }
    expect(sent).toContain("router probe");
    // The host, not the child, chose the model; and the cap was forwarded.
    expect(stub.calls[0].model).toBe("acme/big");
    expect(stub.calls[0].maxTokens).toBe(4096);
    expect(stub.calls[0].responseFormat).toMatchObject({ type: "json_schema" });
  }, 180_000);

  it("refuses without a prepared run plan", async () => {
    const view = unwrap(await backend.openLocal(AGENDA));
    const error = expectError(
      await backend.probeRouter(view.sessionId, "rp_nothing", "0".repeat(64)),
    );
    expect(error.code).toBe("run_plan_absent");
  }, 120_000);

  it("refuses a run plan id or hash that is not the session's", async () => {
    const { sessionId, plan } = await prepared();
    expect(
      expectError(await backend.probeRouter(sessionId, "rp_other", plan.runPlanSha256)).code,
    ).toBe("probe_refused");
    expect(
      expectError(await backend.probeRouter(sessionId, plan.runPlanId, "f".repeat(64))).code,
    ).toBe("probe_refused");
  }, 120_000);

  it("refuses after the authorization that backed the plan is replaced", async () => {
    const { sessionId, digest, plan } = await prepared();
    const permissions = unwrap(await backend.getPermissions(sessionId));
    // Re-authorizing discards the plan in the control plane; the probe must not
    // fall back to the copy the caller is holding.
    await backend.authorize(
      sessionId,
      digest,
      permissions.permissions.map((item) => ({
        permissionId: item.id,
        decision: "session" as const,
      })),
    );
    const error = expectError(
      await backend.probeRouter(sessionId, plan.runPlanId, plan.runPlanSha256),
    );
    expect(error.code).toBe("run_plan_absent");
  }, 120_000);

  it("refuses after the publisher pin is withdrawn", async () => {
    const { sessionId, plan } = await prepared();
    const trust = unwrap(await backend.listTrust());
    for (const publisher of trust.publishers) await backend.removeTrust(publisher.fingerprint);
    const error = expectError(
      await backend.probeRouter(sessionId, plan.runPlanId, plan.runPlanSha256),
    );
    expect(error.code).toBe("run_plan_stale");
    expect(error.detail).toMatch(/trust|publisher/iu);
    // Restore the pin for the cases that follow.
    const view = unwrap(await backend.openLocal(AGENDA));
    await backend.pinSessionPublisher(
      view.sessionId,
      view.publisher.signerFingerprint!,
      "publisher",
    );
  }, 120_000);

  it("refuses after the selected model leaves the host catalog", async () => {
    const { sessionId, plan } = await prepared();
    hostState.offered = [];
    try {
      const error = expectError(
        await backend.probeRouter(sessionId, plan.runPlanId, plan.runPlanSha256),
      );
      expect(error.code).toBe("selected_model_unavailable");
    } finally {
      hostState.offered = ["big"];
    }
  }, 120_000);

  it("refuses when the host answers with a different model", async () => {
    const { sessionId, plan } = await prepared();
    stub = stubLlm({ model: "small" });
    const error = expectError(
      await backend.probeRouter(sessionId, plan.runPlanId, plan.runPlanSha256),
    );
    // The router and the host both check; either one refusing is enough.
    expect(["selected_model_unavailable", "bridge_failed"]).toContain(error.code);
  }, 120_000);

  it("reports a host that bills more input than the bound allowed", async () => {
    const { sessionId, plan } = await prepared();
    stub = stubLlm({ usage: { inputTokens: 5_000_000, outputTokens: 4 } });
    const report = unwrap(
      await backend.probeRouter(sessionId, plan.runPlanId, plan.runPlanSha256),
    );
    expect(report.status).toBe("contract_violation");
    expect(report.accounting.inputWithinBound).toBe(false);
  }, 120_000);

  it("fails when the model does not answer the schema", async () => {
    const { sessionId, plan } = await prepared();
    stub = stubLlm({ text: "I would rather not answer in JSON." });
    const error = expectError(
      await backend.probeRouter(sessionId, plan.runPlanId, plan.runPlanSha256),
    );
    expect(error.code).toBe("bridge_failed");
    expect(error.detail).toContain("model_output_not_conforming");
  }, 120_000);

  it("fails when the host reports no usage at all", async () => {
    const { sessionId, plan } = await prepared();
    stub = stubLlm({ usage: {} });
    const error = expectError(
      await backend.probeRouter(sessionId, plan.runPlanId, plan.runPlanSha256),
    );
    expect(error.detail).toContain("model_usage_unavailable");
  }, 120_000);

  it("leaves the run plan exactly as it was", async () => {
    const { sessionId, plan } = await prepared();
    unwrap(await backend.probeRouter(sessionId, plan.runPlanId, plan.runPlanSha256));
    const after = unwrap(await backend.getRunPlan(sessionId));
    expect(after.plan!.runPlanSha256).toBe(plan.runPlanSha256);
    expect(after.plan!.execution.performed).toBe(false);
    expect(after.preflight!.ready).toBe(true);
    expect(after.executionSupported).toBe(false);
  }, 180_000);
});
