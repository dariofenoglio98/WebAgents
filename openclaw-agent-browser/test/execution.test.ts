/**
 * The whole execution stack except the provider, end to end.
 *
 * Real `agentpkg browser-serve` control plane, real authorization, real run
 * plan, real execution lease, real inherited descriptors, real `agentpkg
 * execution-run` child, real `Workflow` interpreter running the signed Meeting
 * Agenda package's own graph — and one stub in place of OpenClaw's completion
 * runtime, so the suite is deterministic and spends nothing.
 *
 * What is under test is the host's half: the authority chain in front of the
 * first token, the handoff of immutable bytes, the lifecycle, and what the run
 * record does and does not contain.
 */
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { AgentBrowserBackend } from "../src/backend.js";
import { AgentBrowserError } from "../src/errors.js";
import { BUILT_IN_BINDINGS } from "../src/tool-registry.js";
import type { HostLlm } from "../src/host-llm.js";
import type { ModelHost } from "../src/host-models.js";
import { AGENTPKG_BIN, DIST, HOST_CONFIG_WITH_MODEL_OVERRIDE, hasAgentpkg } from "./fixtures.js";

const runs = hasAgentpkg();
const log = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
const AGENDA = join(DIST, "meeting-agenda.agent.pkg");
const LITERATURE = join(DIST, "literature-review.agent.pkg");

const INPUT = {
  goal: "Decide whether to adopt agent.pkg for the next research prototype",
  participants: [
    { name: "Ari", role: "researcher" },
    { name: "Blair", role: "security reviewer" },
    { name: "Casey", role: "systems engineer" },
  ],
  context: "A deterministic fixture meeting used by the execution test suite.",
  duration: 45,
};

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

function makeHost(state: { rows: Row[]; offered: string[]; version: string | null }): ModelHost {
  return {
    config: HOST_CONFIG_WITH_MODEL_OVERRIDE,
    get runtimeVersion() {
      return state.version;
    },
    browse: async () => ({
      byProvider: new Map([["acme", new Set(state.offered)]]),
      modelCatalog: state.rows as never,
      modelNames: new Map(state.rows.map((row) => [`acme/${row.id}`, String(row.name)])),
    }),
  };
}

/**
 * A provider stand-in that answers each task the way the package's own schemas
 * require. It reads the task out of the rendered system text, exactly as a real
 * model would, so the request under test is the one the runtime actually built.
 */
function stubLlm(options: { delayMs?: number; failAfter?: number } = {}) {
  const calls: Array<Record<string, unknown>> = [];
  const llm: HostLlm = {
    complete: async (params) => {
      calls.push(params as unknown as Record<string, unknown>);
      if (options.failAfter !== undefined && calls.length > options.failAfter) {
        throw Object.assign(new Error("provider is down"), { code: "LLM_RUNTIME_UNAVAILABLE" });
      }
      if (options.delayMs) {
        await new Promise((resolve, reject) => {
          const timer = setTimeout(resolve, options.delayMs);
          params.signal?.addEventListener("abort", () => {
            clearTimeout(timer);
            reject(Object.assign(new Error("aborted"), { code: "LLM_COMPLETION_ABORTED" }));
          });
        });
      }
      const task = /^## Task\n(.+)$/mu.exec(params.systemPrompt ?? "")?.[1]?.trim() ?? "";
      const data = JSON.parse(params.messages[0]?.content ?? "{}") as Record<string, never>;
      return {
        text: answer(task, data),
        provider: "acme",
        model: "big",
        responseModel: "big-2026-09-01",
        stopReason: "stop",
        usage: { inputTokens: 900, outputTokens: 180, totalTokens: 1080, costUsd: 0.0012 },
        execution: { mode: "direct-provider", owner: { kind: "provider", id: "acme" } },
      };
    },
  };
  return { llm, calls };
}

function answer(task: string, data: Record<string, never>): string {
  if (task === "plan") {
    const participants = (data.participants ?? []) as Array<{ name: string; role: string }>;
    return JSON.stringify({
      focus: ["Scope", "Risks"],
      perspectives: participants.map((item) => ({ name: item.name, role: item.role })),
    });
  }
  if (task === "perspective") {
    const participant = data.participant as unknown as { role: string };
    return JSON.stringify([
      {
        role: participant.role,
        priorities: [`${participant.role} priority`],
        questions: [`What matters to the ${participant.role}?`],
      },
    ]);
  }
  if (task === "write") {
    const request = data.request as unknown as typeof INPUT;
    const people = request.participants;
    const share = Math.floor(request.duration / people.length);
    const remainder = request.duration - share * people.length;
    return JSON.stringify({
      goal: request.goal,
      duration: request.duration,
      agenda: people.map((person, index) => ({
        topic: `Discuss ${person.role} considerations`,
        minutes: share + (index === 0 ? remainder : 0),
        owner: person.name,
      })),
      preparation_items: ["Read the proposal"],
      decisions: ["Adopt or defer"],
      questions: ["What is the rollback plan?"],
    });
  }
  throw new Error(`unscripted task ${task}`);
}

let stateDir = "";
let backend: AgentBrowserBackend;
let hostState: { rows: Row[]; offered: string[]; version: string | null };
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
async function prepared(artifact = AGENDA, decision: "session" | "once" | "deny" = "session") {
  const view = unwrap(await backend.openLocal(artifact));
  await backend.pinSessionPublisher(view.sessionId, view.publisher.signerFingerprint!, "publisher");
  const refreshed = unwrap(await backend.getPackage(view.sessionId));
  const permissions = unwrap(await backend.getPermissions(view.sessionId));
  const receipt = unwrap(
    await backend.authorize(
      view.sessionId,
      refreshed.identity.digest,
      permissions.permissions.map((item) => ({ permissionId: item.id, decision })),
      // A declared tool needs its own approval as well as its permission.
      permissions.toolApprovals.map((item) => ({ toolId: item.toolId, approved: true })),
    ),
  );
  await backend.evaluateModels(view.sessionId);
  const state = unwrap(
    await backend.prepareRunPlan(
      view.sessionId,
      refreshed.identity.digest,
      receipt.receiptId,
      "acme/big",
    ),
  );
  return {
    sessionId: view.sessionId,
    digest: refreshed.identity.digest,
    receipt,
    plan: state.plan!,
  };
}

function start(session: { sessionId: string; plan: { runPlanId: string; runPlanSha256: string } }, input: unknown = INPUT) {
  return backend.startExecution(
    session.sessionId,
    session.plan.runPlanId,
    session.plan.runPlanSha256,
    input,
  );
}

describe.runIf(runs)("executing a signed package", () => {
  beforeAll(async () => {
    stateDir = await mkdtemp(join(tmpdir(), "agent-browser-exec-"));
    hostState = { rows: [BIG], offered: ["big"], version: "2026.9.5" };
    stub = stubLlm();
    backend = new AgentBrowserBackend({
      config: {
        agentpkgPath: AGENTPKG_BIN,
        localPackages: { roots: [DIST] },
        execution: { runTimeoutSeconds: 120 },
      },
      logger: log,
      stateDir,
      modelHost: makeHost(hostState),
      llm: { complete: (params) => stub.llm.complete(params) },
    });
    await backend.initialize();
    await backend.launch();
  }, 90_000);

  afterEach(async () => {
    for (const open of unwrap(await backend.listSessions()).sessions) {
      await backend.closeSession(open.sessionId);
    }
    await backend.clearExecutions();
    stub = stubLlm();
    hostState.version = "2026.9.5";
  });

  afterAll(async () => {
    await backend?.stop();
    await rm(stateDir, { recursive: true, force: true });
  }, 30_000);

  it("runs the package's own graph on the model its plan bound", async () => {
    const session = await prepared();
    const record = unwrap(await start(session));

    expect(record.status).toBe("completed");
    expect(record.errorCode).toBeNull();
    expect(record.package.packageId).toBe("org.webagents.meeting-agenda");
    expect(record.package.executionProfile).toBe("workflow.v0");

    // Planner, three bounded perspective workers, writer.
    expect(record.audit?.modelCalls).toBe(5);
    expect(record.audit?.workersSpawned).toBe(5);
    expect(record.audit?.chainValid).toBe(true);
    expect(record.audit?.toolCalls).toBe(0);
    expect(record.audit?.tasksCalled).toEqual(
      expect.arrayContaining([
        { task: "plan", count: 1 },
        { task: "perspective", count: 3 },
        { task: "write", count: 1 },
      ]),
    );

    // Every call used exactly the planned model.
    expect(record.model?.planned).toBe("acme/big");
    expect(record.model?.invoked).toEqual(["acme/big"]);
    expect(record.model?.allCallsUsedPlannedModel).toBe(true);
    expect(record.model?.calls).toBe(5);
    expect(stub.calls.every((call) => call.model === "acme/big")).toBe(true);

    // Real usage, and a cost that is only ever the sum of reported costs.
    expect(record.usage?.tokens).toBeGreaterThan(0);
    expect(record.usage?.remoteCalls).toBe(10);
    expect(record.usage?.peakParallelWorkers).toBeGreaterThanOrEqual(2);
    expect(record.usage?.toolCalls).toBe(0);
    expect(record.cost?.status).toBe("complete");
    expect(record.cost?.totalUsd).toBeCloseTo(0.006, 6);

    expect(record.packageExecution).toEqual({
      workflowInstantiated: true,
      packageInstructionsLoaded: true,
      toolHandlersInstalled: 0,
      toolCalls: 0,
    });
    expect(record.host).toMatchObject({ runtimeVersion: "2026.9.5", versionVerified: true });
  }, 120_000);

  it("writes the package's declared export beside the host's own artifacts", async () => {
    const session = await prepared();
    const record = unwrap(await start(session));
    expect(record.artifacts.map((item) => item.name).sort()).toEqual([
      "agenda.json",
      "audit.json",
      "provenance.json",
      "result.json",
      "usage.json",
    ]);

    const agenda = unwrap(await backend.readExecutionArtifact(record.runId, "agenda.json"));
    const value = agenda.json as typeof INPUT & { agenda: Array<{ minutes: number }> };
    expect(value.goal).toBe(INPUT.goal);
    expect(value.duration).toBe(45);
    expect(value.agenda.reduce((total, item) => total + item.minutes, 0)).toBe(45);

    // The run record is written beside them, by this process rather than the child.
    const files = await readdir(join(stateDir, "agent-browser", "runs", record.runId));
    expect(files.sort()).toEqual([
      "agenda.json",
      "audit.json",
      "provenance.json",
      "result.json",
      "run.json",
      "usage.json",
    ]);
    const stored = JSON.parse(
      await readFile(join(stateDir, "agent-browser", "runs", record.runId, "run.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(stored.runId).toBe(record.runId);
    expect(stored.status).toBe("completed");
  }, 120_000);

  it("leaves the run plan exactly as it was", async () => {
    const session = await prepared();
    const record = unwrap(await start(session));
    const after = unwrap(await backend.getRunPlan(session.sessionId));
    expect(after.plan!.runPlanSha256).toBe(session.plan.runPlanSha256);
    expect(after.plan!.execution.performed).toBe(false);
    // This host can run model-backed plans; the plan itself still performs nothing.
    expect(after.executionSupported).toBe(true);
    // The evidence that a plan ran is a run record that references it.
    expect(record.runPlanSha256).toBe(session.plan.runPlanSha256);
    expect(record.runInvocationSha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(record.inputSha256).toMatch(/^[0-9a-f]{64}$/u);
  }, 120_000);

  it("never returns a path, a token or the package's output", async () => {
    const session = await prepared();
    const record = unwrap(await start(session));
    const serialized = JSON.stringify(record);
    expect(serialized).not.toContain(stateDir);
    expect(serialized).not.toContain("/runs/");
    expect(serialized).not.toContain(".agent.pkg");
    expect(serialized).not.toContain("lease");
    // The agenda's own text is in the artifacts, not in the record.
    expect(serialized).not.toContain("Discuss researcher considerations");
  }, 120_000);

  it("releases the execution lease when the run ends", async () => {
    const session = await prepared();
    unwrap(await start(session));
    // A second run would be refused outright if a lease were still outstanding.
    const again = unwrap(await start(session));
    expect(again.status).toBe("completed");
  }, 180_000);

  // -- authority -------------------------------------------------------------
  it("refuses a run plan the caller did not read", async () => {
    const session = await prepared();
    const wrongHash = expectError(
      await backend.startExecution(
        session.sessionId,
        session.plan.runPlanId,
        "0".repeat(64),
        INPUT,
      ),
    );
    expect(wrongHash.code).toBe("probe_refused");
  }, 60_000);

  it("refuses after the authorization behind the plan is replaced", async () => {
    const session = await prepared();
    const permissions = unwrap(await backend.getPermissions(session.sessionId));
    await backend.authorize(
      session.sessionId,
      session.digest,
      permissions.permissions.map((item) => ({ permissionId: item.id, decision: "session" as const })),
    );
    const error = expectError(await start(session));
    // Re-authorizing discards the plan, so there is nothing left to run.
    expect(["run_plan_absent", "run_plan_stale"]).toContain(error.code);
  }, 60_000);

  it("refuses when the publisher is no longer trusted", async () => {
    const session = await prepared();
    const trust = unwrap(await backend.listTrust());
    for (const entry of trust.publishers) await backend.removeTrust(entry.fingerprint);
    const error = expectError(await start(session));
    expect(error.code).toBe("run_plan_stale");
  }, 60_000);

  it("refuses when the selected model is no longer offered", async () => {
    const session = await prepared();
    hostState.offered = [];
    const error = expectError(await start(session));
    expect(error.code).toBe("selected_model_unavailable");
    hostState.offered = ["big"];
  }, 60_000);

  it("refuses a `once` grant rather than widening it to a session", async () => {
    const session = await prepared(AGENDA, "once");
    const error = expectError(await start(session));
    expect(error.code).toBe("execution_refused");
    expect(error.detail).toContain("once");
    expect(stub.calls).toHaveLength(0);
  }, 60_000);

  it("refuses a plan for a package whose tools this host cannot all implement", async () => {
    // A host that implements one of the three tools the reference review
    // package declares. A partially bound package is refused at plan time
    // rather than halfway through a run that already spent tokens, and the
    // refusal names the tools rather than the package. (The plugin ships all
    // three; this host is restricted through the definitions test seam.)
    const partialDir = await mkdtemp(join(tmpdir(), "agent-browser-partial-"));
    const partial = new AgentBrowserBackend({
      config: {
        agentpkgPath: AGENTPKG_BIN,
        localPackages: { roots: [DIST] },
        execution: { runTimeoutSeconds: 120 },
      },
      logger: log,
      stateDir: partialDir,
      modelHost: makeHost(hostState),
      llm: { complete: (params) => stub.llm.complete(params) },
      toolDefinitions: BUILT_IN_BINDINGS.filter(
        (item) => item.toolId === "citation-resolver" || item.toolId === "test.echo",
      ),
    });
    await partial.initialize();
    await partial.launch();
    try {
      const view = unwrap(await partial.openLocal(LITERATURE));
      await partial.pinSessionPublisher(
        view.sessionId,
        view.publisher.signerFingerprint!,
        "publisher",
      );
      const refreshed = unwrap(await partial.getPackage(view.sessionId));
      const permissions = unwrap(await partial.getPermissions(view.sessionId));
      const receipt = unwrap(
        await partial.authorize(
          view.sessionId,
          refreshed.identity.digest,
          permissions.permissions.map((item) => ({
            permissionId: item.id,
            decision: "session" as const,
          })),
          permissions.toolApprovals.map((item) => ({ toolId: item.toolId, approved: true })),
        ),
      );
      const tools = unwrap(await partial.evaluateTools(view.sessionId));
      const bound = tools.tools.filter((tool) => tool.status === "bound").map((tool) => tool.toolId);
      const unbound = tools.tools
        .filter((tool) => tool.status === "unbound")
        .map((tool) => tool.toolId);
      expect(bound).toEqual(["citation-resolver"]);
      expect(unbound.sort()).toEqual(["paper-reader", "scholarly-search"]);

      await partial.evaluateModels(view.sessionId);
      const refused = expectError(
        await partial.prepareRunPlan(
          view.sessionId,
          refreshed.identity.digest,
          receipt.receiptId,
          "acme/big",
        ),
      );
      expect(refused.code).toBe("run_plan_refused");
      expect(refused.detail).toMatch(/paper-reader|scholarly-search/u);
      expect(stub.calls).toHaveLength(0);
    } finally {
      await partial.stop();
      await rm(partialDir, { recursive: true, force: true });
    }
  }, 90_000);

  it("refuses input the package's own schema rejects, before any token is spent", async () => {
    const session = await prepared();
    const error = expectError(await start(session, { goal: "no duration" }));
    // Refused by the control plane's validator before a lease exists or a
    // runner is spawned, naming the fields — and the runner would refuse it
    // again if it got that far.
    expect(error.code).toBe("input_invalid");
    expect(error.detail).toContain("/duration is required");
    expect(error.detail).toContain("/participants is required");
    expect(stub.calls).toHaveLength(0);
    expect(unwrap(await backend.listExecutions(session.sessionId)).runs).toHaveLength(0);
  }, 60_000);

  it("refuses oversized input without reaching the control plane", async () => {
    const session = await prepared();
    const error = expectError(await start(session, { ...INPUT, context: "x".repeat(300_000) }));
    expect(error.code).toBe("invalid_request");
    expect(stub.calls).toHaveLength(0);
  }, 60_000);

  it("refuses an OpenClaw release the accounting was not verified against", async () => {
    const session = await prepared();
    hostState.version = "2099.1.1";
    const error = expectError(await start(session));
    expect(error.code).toBe("execution_refused");
    expect(error.detail).toContain("2026.9.5");
    expect(stub.calls).toHaveLength(0);
  }, 60_000);

  // -- lifecycle -------------------------------------------------------------
  it("refuses a second run while one is in flight", async () => {
    stub = stubLlm({ delayMs: 1_500 });
    const session = await prepared();
    const running = start(session);
    await waitForActive();
    const error = expectError(await start(session));
    expect(error.code).toBe("execution_active");
    const record = unwrap(await running);
    expect(record.status).toBe("completed");
  }, 180_000);

  it("cancels a running workflow and still reports its audit and usage", async () => {
    stub = stubLlm({ delayMs: 30_000 });
    const session = await prepared();
    const running = start(session);
    const active = await waitForActive();
    const cancelled = unwrap(await backend.cancelExecution(active.runId));
    expect(cancelled.cancelRequested).toBe(true);
    const record = unwrap(await running);
    expect(record.status).toBe("cancelled");
    expect(record.audit?.chainValid).toBe(true);
    expect(record.artifacts.map((item) => item.name)).toContain("result.json");
  }, 180_000);

  it("reports a provider failure as a classified run failure", async () => {
    stub = stubLlm({ failAfter: 0 });
    const session = await prepared();
    const record = unwrap(await start(session));
    expect(record.status).toBe("failed");
    expect(record.errorCode).toBe("model_error");
    expect(record.audit?.chainValid).toBe(true);
  }, 120_000);

  it("bounds one model call by the host's per-call timeout and cancels it at the model", async () => {
    // Host policy, not a package's: the child waits this long for one
    // completion, then cancels it, and the abort reaches the host model call.
    const dir = await mkdtemp(join(tmpdir(), "agent-browser-call-timeout-"));
    const shared = backend;
    const aborted: number[] = [];
    stub = stubLlm({ delayMs: 20_000 });
    backend = new AgentBrowserBackend({
      config: {
        agentpkgPath: AGENTPKG_BIN,
        localPackages: { roots: [DIST] },
        execution: { runTimeoutSeconds: 120, modelCallTimeoutSeconds: 2 },
      },
      logger: log,
      stateDir: dir,
      modelHost: makeHost(hostState),
      llm: {
        complete: (params) => {
          params.signal?.addEventListener("abort", () => aborted.push(Date.now()));
          return stub.llm.complete(params);
        },
      },
    });
    await backend.initialize();
    await backend.launch();
    try {
      const session = await prepared();
      const started = Date.now();
      const record = unwrap(await start(session));
      expect(record.status).toBe("failed");
      expect(record.errorCode).toBe("model_error");
      expect(record.limits.host.modelCallTimeoutSeconds).toBe(2);
      expect(aborted.length).toBeGreaterThan(0);
      // Well before the stub would have answered, and before the backstop.
      expect(Date.now() - started).toBeLessThan(20_000);
    } finally {
      for (const open of unwrap(await backend.listSessions()).sessions) {
        await backend.closeSession(open.sessionId);
      }
      await backend.stop();
      backend = shared;
      await rm(dir, { recursive: true, force: true });
    }
  }, 120_000);

  it("lists, reads and clears ephemeral run records", async () => {
    const session = await prepared();
    const record = unwrap(await start(session));
    const listed = unwrap(await backend.listExecutions(session.sessionId));
    expect(listed.runs.map((item) => item.runId)).toContain(record.runId);
    expect(listed.active).toBeNull();
    expect(unwrap(await backend.getExecution(record.runId))?.runId).toBe(record.runId);
    expect(unwrap(await backend.clearExecutions(record.runId)).cleared).toBe(1);
    expect(unwrap(await backend.getExecution(record.runId))).toBeNull();
  }, 120_000);

  it("refuses to start when a run could outlast its authorization", async () => {
    // A run may take up to `runTimeoutSeconds`; consent that expires before then
    // would leave the run in a state nobody decided about.
    const shortDir = await mkdtemp(join(tmpdir(), "agent-browser-expiry-"));
    const brief = new AgentBrowserBackend({
      config: {
        agentpkgPath: AGENTPKG_BIN,
        localPackages: { roots: [DIST] },
        // Far longer than the control plane's 900-second session lifetime.
        execution: { runTimeoutSeconds: 86_400 },
      },
      logger: log,
      stateDir: shortDir,
      modelHost: makeHost(hostState),
      llm: { complete: (params) => stub.llm.complete(params) },
    });
    await brief.initialize();
    await brief.launch();
    try {
      const view = unwrap(await brief.openLocal(AGENDA));
      await brief.pinSessionPublisher(
        view.sessionId,
        view.publisher.signerFingerprint!,
        "publisher",
      );
      const refreshed = unwrap(await brief.getPackage(view.sessionId));
      const permissions = unwrap(await brief.getPermissions(view.sessionId));
      const receipt = unwrap(
        await brief.authorize(
          view.sessionId,
          refreshed.identity.digest,
          permissions.permissions.map((item) => ({
            permissionId: item.id,
            decision: "session" as const,
          })),
        ),
      );
      await brief.evaluateModels(view.sessionId);
      const state = unwrap(
        await brief.prepareRunPlan(
          view.sessionId,
          refreshed.identity.digest,
          receipt.receiptId,
          "acme/big",
        ),
      );
      const error = expectError(
        await brief.startExecution(
          view.sessionId,
          state.plan!.runPlanId,
          state.plan!.runPlanSha256,
          INPUT,
        ),
      );
      expect(error.code).toBe("authorization_expiring");
      expect(stub.calls).toHaveLength(0);
    } finally {
      await brief.stop();
      await rm(shortDir, { recursive: true, force: true });
    }
  }, 120_000);

  it("records a run whose child dies as failed, and releases its lease", async () => {
    const dyingDir = await mkdtemp(join(tmpdir(), "agent-browser-dead-"));
    const dying = new AgentBrowserBackend({
      config: { agentpkgPath: AGENTPKG_BIN, localPackages: { roots: [DIST] } },
      logger: log,
      stateDir: dyingDir,
      modelHost: makeHost(hostState),
      llm: { complete: (params) => stub.llm.complete(params) },
      // Stands in for a runner that exits mid-session: the parent sees the
      // child go away and every pending call fails.
      createExecutionBridge: () => ({
        run: async () => {
          throw new AgentBrowserError(
            "bridge_unavailable",
            "The agentpkg bridge exited",
            "The agentpkg bridge exited (signal SIGKILL).",
            true,
          );
        },
        cancel: async () => false,
      }),
    });
    await dying.initialize();
    await dying.launch();
    try {
      const view = unwrap(await dying.openLocal(AGENDA));
      await dying.pinSessionPublisher(
        view.sessionId,
        view.publisher.signerFingerprint!,
        "publisher",
      );
      const refreshed = unwrap(await dying.getPackage(view.sessionId));
      const permissions = unwrap(await dying.getPermissions(view.sessionId));
      const receipt = unwrap(
        await dying.authorize(
          view.sessionId,
          refreshed.identity.digest,
          permissions.permissions.map((item) => ({
            permissionId: item.id,
            decision: "session" as const,
          })),
        ),
      );
      await dying.evaluateModels(view.sessionId);
      const state = unwrap(
        await dying.prepareRunPlan(
          view.sessionId,
          refreshed.identity.digest,
          receipt.receiptId,
          "acme/big",
        ),
      );
      const error = expectError(
        await dying.startExecution(
          view.sessionId,
          state.plan!.runPlanId,
          state.plan!.runPlanSha256,
          INPUT,
        ),
      );
      expect(error.code).toBe("bridge_unavailable");
      const listed = unwrap(await dying.listExecutions(view.sessionId));
      expect(listed.active).toBeNull();
      expect(listed.runs[0]?.status).toBe("failed");
      expect(listed.runs[0]?.errorCode).toBe("bridge_unavailable");
      // The lease was released, so a second attempt is not blocked by it.
      const again = expectError(
        await dying.startExecution(
          view.sessionId,
          state.plan!.runPlanId,
          state.plan!.runPlanSha256,
          INPUT,
        ),
      );
      expect(again.code).toBe("bridge_unavailable");
    } finally {
      await dying.stop();
      await rm(dyingDir, { recursive: true, force: true });
    }
  }, 120_000);

  it("cancels runs in flight when the plugin stops", async () => {
    const stoppingDir = await mkdtemp(join(tmpdir(), "agent-browser-stop-"));
    let release: (() => void) | null = null;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const stopping = new AgentBrowserBackend({
      config: { agentpkgPath: AGENTPKG_BIN, localPackages: { roots: [DIST] } },
      logger: log,
      stateDir: stoppingDir,
      modelHost: makeHost(hostState),
      llm: { complete: (params) => stub.llm.complete(params) },
      createExecutionBridge: () => ({
        run: async () => {
          await held;
          throw new AgentBrowserError("model_call_cancelled", "cancelled", "stopped");
        },
        cancel: async () => true,
      }),
    });
    await stopping.initialize();
    await stopping.launch();
    try {
      const view = unwrap(await stopping.openLocal(AGENDA));
      await stopping.pinSessionPublisher(
        view.sessionId,
        view.publisher.signerFingerprint!,
        "publisher",
      );
      const refreshed = unwrap(await stopping.getPackage(view.sessionId));
      const permissions = unwrap(await stopping.getPermissions(view.sessionId));
      const receipt = unwrap(
        await stopping.authorize(
          view.sessionId,
          refreshed.identity.digest,
          permissions.permissions.map((item) => ({
            permissionId: item.id,
            decision: "session" as const,
          })),
        ),
      );
      await stopping.evaluateModels(view.sessionId);
      const state = unwrap(
        await stopping.prepareRunPlan(
          view.sessionId,
          refreshed.identity.digest,
          receipt.receiptId,
          "acme/big",
        ),
      );
      const running = stopping.startExecution(
        view.sessionId,
        state.plan!.runPlanId,
        state.plan!.runPlanSha256,
        INPUT,
      );
      await new Promise((resolve) => setTimeout(resolve, 200));
      const before = unwrap(await stopping.listExecutions());
      expect(before.active?.status).toBe("running");
      const runId = before.active!.runId;

      // The Gateway stops the plugin while the run is in flight.
      const stopped = stopping.stop();
      await new Promise((resolve) => setTimeout(resolve, 50));
      release?.();
      await stopped;
      await running.catch(() => undefined);

      // Every operation is refused after the plugin stops, so the record is
      // read where the backend wrote it.
      expect(expectError(await stopping.listExecutions()).code).toBe("service_unavailable");
      const record = JSON.parse(
        await readFile(join(stoppingDir, "agent-browser", "runs", runId, "run.json"), "utf8"),
      ) as { status: string; errorCode: string; endedAt: string | null };
      expect(record.status).toBe("cancelled");
      expect(record.errorCode).toBe("gateway_stopped");
      expect(record.endedAt).not.toBeNull();
    } finally {
      release?.();
      await stopping.stop().catch(() => undefined);
      await rm(stoppingDir, { recursive: true, force: true });
    }
  }, 120_000);

  it("lets the page reach execution only through the Run panel, never a probe", async () => {
    const { readFile: read } = await import("node:fs/promises");
    const { fileURLToPath } = await import("node:url");
    const here = fileURLToPath(new URL(".", import.meta.url));
    const browser = [
      "../src/ui/page.ts",
      "../src/ui/run.ts",
      "../src/ui/form.ts",
      "../src/ui/markdown.ts",
      "../src/ui/dom.ts",
      "../src/control-ui.ts",
    ];
    for (const file of browser) {
      const source = await read(join(here, file), "utf8");
      // Probes and record deletion stay operator-only.
      for (const operation of ["router.probe", "execution.tool-probe", "execution.clear"]) {
        expect(source).not.toContain(operation);
      }
      // Starting and cancelling a run live in exactly one module.
      if (!file.endsWith("run.ts")) {
        expect(source).not.toContain("execution.start");
        expect(source).not.toContain("execution.cancel");
      }
    }
  });

  it("refuses an artifact name that is not one plain filename", async () => {
    const session = await prepared();
    const record = unwrap(await start(session));
    expect(expectError(await backend.readExecutionArtifact(record.runId, "../run.json")).code).toBe(
      "invalid_request",
    );
    expect(expectError(await backend.readExecutionArtifact(record.runId, "absent.json")).code).toBe(
      "execution_unknown",
    );
  }, 120_000);
});

async function waitForActive() {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const listed = unwrap(await backend.listExecutions());
    if (listed.active) return listed.active;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("no run became active");
}

describe("the host execution policy", () => {
  it("keeps the previous per-call timeout by default and caps what an operator sets", async () => {
    const { resolvePolicy, MAX_MODEL_CALL_TIMEOUT_SECONDS } = await import("../src/execution.js");
    expect(resolvePolicy({}).modelCallTimeoutSeconds).toBe(300);
    expect(resolvePolicy({ modelCallTimeoutSeconds: 1800 }).modelCallTimeoutSeconds).toBe(1800);
    expect(resolvePolicy({ modelCallTimeoutSeconds: 99_999 }).modelCallTimeoutSeconds).toBe(
      MAX_MODEL_CALL_TIMEOUT_SECONDS,
    );
    for (const bad of [0, -5, 1.5, "600", null]) {
      expect(resolvePolicy({ modelCallTimeoutSeconds: bad }).modelCallTimeoutSeconds).toBe(300);
    }
  });
});
