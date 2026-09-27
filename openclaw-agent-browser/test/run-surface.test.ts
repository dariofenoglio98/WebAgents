/**
 * The backend half of the Run surface, against a real control plane and a
 * real runner.
 *
 * The page asks four new things of the backend — may this plan run now, is
 * this task valid, give me this artifact in slices, and show me runs that
 * finished before a restart — and uses the existing `execution.start` and
 * `execution.cancel`. These tests hold the authority properties underneath:
 * the exact plan, package, model and bindings are what run; nothing the page
 * sends can name a model, a binding, a path or a method; a file is readable
 * only as a capability under a granted permission; and finished runs are
 * evidence, not authority.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { AgentBrowserBackend } from "../src/backend.js";
import plugin from "../src/index.js";
import { contract } from "../src/contract.js";
import type { HostLlm } from "../src/host-llm.js";
import type { ModelHost } from "../src/host-models.js";
import type { HttpTransport } from "../src/tool-broker.js";
import { BUILT_IN_BINDINGS } from "../src/tool-registry.js";
import { AGENTPKG_BIN, DIST, HOST_CONFIG_WITH_MODEL_OVERRIDE, hasAgentpkg } from "./fixtures.js";
import { makePdf } from "./pdf.js";

const runs = hasAgentpkg();
const log = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
const AGENDA = join(DIST, "meeting-agenda.agent.pkg");
const REVIEW = join(DIST, "literature-review.agent.pkg");
const INPUT = {
  goal: "Decide whether to adopt agent.pkg for the next research prototype",
  participants: [
    { name: "Ari", role: "researcher" },
    { name: "Blair", role: "security reviewer" },
    { name: "Casey", role: "systems engineer" },
  ],
  context: "A deterministic fixture meeting used by the run-surface suite.",
  duration: 45,
};
const REVIEW_TASK = {
  question: "What defenses have been proposed against prompt injection attacks?",
  seeds: [],
  documents: {},
  mode: "live",
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

function makeHost(state: { offered: string[] }): ModelHost {
  return {
    config: HOST_CONFIG_WITH_MODEL_OVERRIDE,
    runtimeVersion: "2026.9.5",
    browse: async () => ({
      byProvider: new Map([["acme", new Set(state.offered)]]),
      modelCatalog: [BIG] as never,
      modelNames: new Map([["acme/big", "Big Model"]]),
    }),
  };
}

/** Answers Meeting Agenda's three tasks from their own data, like a model would. */
function agendaLlm(options: { delayMs?: number } = {}) {
  const calls: string[] = [];
  const aborted: string[] = [];
  const llm: HostLlm = {
    complete: async (params) => {
      const task = /^## Task\n(.+)$/mu.exec(params.systemPrompt ?? "")?.[1]?.trim() ?? "";
      calls.push(`${params.model}:${task}`);
      if (options.delayMs) {
        await new Promise((resolve, reject) => {
          const timer = setTimeout(resolve, options.delayMs);
          params.signal?.addEventListener("abort", () => {
            clearTimeout(timer);
            aborted.push(task);
            reject(Object.assign(new Error("aborted"), { code: "LLM_COMPLETION_ABORTED" }));
          });
        });
      }
      const data = JSON.parse(params.messages[0]?.content ?? "{}") as Record<string, any>;
      let output: unknown;
      if (task === "plan") {
        output = { focus: ["Scope"], perspectives: data.participants.map((p: any) => ({ name: p.name, role: p.role })) };
      } else if (task === "perspective") {
        output = [{ role: data.participant.role, priorities: ["p"], questions: ["q"] }];
      } else {
        const people = data.request.participants as Array<{ name: string; role: string }>;
        const share = Math.floor(data.request.duration / people.length);
        const rest = data.request.duration - share * people.length;
        output = {
          goal: data.request.goal,
          duration: data.request.duration,
          agenda: people.map((person, index) => ({ topic: `About ${person.role}`, minutes: share + (index === 0 ? rest : 0), owner: person.name })),
          preparation_items: ["Read"],
          decisions: ["Adopt"],
          questions: ["Rollback?"],
        };
      }
      return {
        text: JSON.stringify(output),
        provider: "acme",
        model: "big",
        responseModel: "big-1",
        stopReason: "stop",
        usage: { inputTokens: 500, outputTokens: 100, totalTokens: 600, costUsd: 0 },
        execution: { mode: "direct-provider", owner: { kind: "provider", id: "acme" } },
      };
    },
  };
  return { llm, calls, aborted };
}

const transport: HttpTransport = async () => ({ status: 500, contentType: "application/json", body: "{}" });

function unwrap<T>(result: { ok: true; value: T } | { ok: false; error: { code: string; detail?: string } }): T {
  if (!result.ok) throw new Error(`expected ok, got ${result.error.code}: ${result.error.detail ?? ""}`);
  return result.value;
}

function refusal(result: { ok: true; value: unknown } | { ok: false; error: { code: string; detail: string; title: string } }) {
  if (result.ok) throw new Error("expected a refusal");
  return result.error;
}

async function waitUntil(predicate: () => Promise<boolean>, timeoutMs = 60_000): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() > until) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

let stateDir = "";
let backend: AgentBrowserBackend;
let host = { offered: ["big"] };
let stub = agendaLlm();

function newBackend(dir: string, extra: Record<string, unknown> = {}) {
  return new AgentBrowserBackend({
    config: {
      agentpkgPath: AGENTPKG_BIN,
      localPackages: { roots: [DIST] },
      localFiles: { roots: [join(dir, "selectable")] },
      execution: { runTimeoutSeconds: 120 },
    },
    logger: log,
    stateDir: dir,
    modelHost: makeHost(host),
    llm: { complete: (params) => stub.llm.complete(params) },
    toolDefinitions: [...BUILT_IN_BINDINGS],
    toolTransport: transport,
    ...extra,
  });
}

async function prepare(
  target: AgentBrowserBackend,
  artifact = AGENDA,
  decide: (permission: { id: string; kind: string }) => "session" | "deny" = () => "session",
) {
  const view = unwrap(await target.openLocal(artifact));
  await target.pinSessionPublisher(view.sessionId, view.publisher.signerFingerprint!, "package");
  const refreshed = unwrap(await target.getPackage(view.sessionId));
  const permissions = unwrap(await target.getPermissions(view.sessionId));
  const receipt = unwrap(
    await target.authorize(
      view.sessionId,
      refreshed.identity.digest,
      permissions.permissions.map((item) => ({ permissionId: item.id, decision: decide(item) })),
      permissions.toolApprovals.map((item) => ({ toolId: item.toolId, approved: true })),
    ),
  );
  if (refreshed.tools.length > 0) await target.evaluateTools(view.sessionId);
  await target.evaluateModels(view.sessionId);
  const state = unwrap(await target.prepareRunPlan(view.sessionId, refreshed.identity.digest, receipt.receiptId, "acme/big"));
  return { sessionId: view.sessionId, view: refreshed, receipt, plan: state.plan! };
}

function childrenRunning(): string[] {
  try {
    // -A: a runner has no controlling terminal, so a plain `ps` would not list it.
    const out = execFileSync("ps", ["-A", "-o", "pid=,ppid=,command="], { encoding: "utf8" });
    return out
      .split("\n")
      .filter((line) => {
        const [, ppid] = line.trim().split(/\s+/u);
        return Number(ppid) === process.pid && line.includes("execution-run");
      });
  } catch {
    return [];
  }
}

describe.runIf(runs)("the Run surface's backend", () => {
  beforeAll(async () => {
    stateDir = await mkdtemp(join(tmpdir(), "agent-browser-run-surface-"));
    await mkdir(join(stateDir, "selectable"));
    backend = newBackend(stateDir);
    await backend.initialize();
    await backend.launch();
  }, 120_000);

  afterEach(async () => {
    for (const open of unwrap(await backend.listSessions()).sessions) await backend.closeSession(open.sessionId);
    host.offered = ["big"];
    stub = agendaLlm();
  });

  afterAll(async () => {
    await backend?.stop();
    if (stateDir) await rm(stateDir, { recursive: true, force: true });
  }, 60_000);

  // -- readiness -------------------------------------------------------------
  it("reports a ready plan with the checks it passed and the consent it has left", async () => {
    const { sessionId, plan } = await prepare(backend);
    const ready = unwrap(await backend.runReadiness(sessionId));
    expect(ready.ready).toBe(true);
    expect(ready.blocker).toBeNull();
    expect(ready.runPlanId).toBe(plan.runPlanId);
    expect(ready.runPlanSha256).toBe(plan.runPlanSha256);
    expect(ready.checks).toEqual(
      expect.arrayContaining(["run_plan_identity", "package_digest", "publisher_trust", "receipt_outlasts_run_deadline", "model_available"]),
    );
    expect(ready.receipt!.requiredSeconds).toBe(180);
    expect(ready.receipt!.remainingSeconds!).toBeGreaterThan(180);
    // Asking changed nothing: the plan is byte-identical and still unperformed.
    const after = unwrap(await backend.getRunPlan(sessionId));
    expect(after.plan!.runPlanSha256).toBe(plan.runPlanSha256);
    expect(after.plan!.execution.performed).toBe(false);
  }, 90_000);

  it("names the first thing that would refuse a start", async () => {
    // Not authorized yet.
    const view = unwrap(await backend.openLocal(AGENDA));
    const early = unwrap(await backend.runReadiness(view.sessionId));
    expect(early.ready).toBe(false);
    expect(early.blocker!.code).toBe("run_plan_absent");
    await backend.closeSession(view.sessionId);

    // A model the host stopped offering.
    const { sessionId, view: pkg, receipt } = await prepare(backend);
    host.offered = [];
    expect(unwrap(await backend.runReadiness(sessionId)).blocker!.code).toBe("selected_model_unavailable");
    host.offered = ["big"];

    // Publisher trust withdrawn.
    for (const entry of unwrap(await backend.listTrust()).publishers) await backend.removeTrust(entry.fingerprint);
    const untrusted = unwrap(await backend.runReadiness(sessionId));
    expect(untrusted.blocker!.code).toBe("run_plan_stale");
    expect(untrusted.checks).toContain("run_plan_identity");

    // A newer authorization discards the plan.
    const permissions = unwrap(await backend.getPermissions(sessionId));
    await backend.pinSessionPublisher(sessionId, pkg.publisher.signerFingerprint!, "package");
    await backend.authorize(sessionId, pkg.identity.digest, permissions.permissions.map((item) => ({ permissionId: item.id, decision: "session" as const })));
    expect(receipt.receiptId).toBeTruthy();
    expect(unwrap(await backend.runReadiness(sessionId)).blocker!.code).toBe("run_plan_absent");
  }, 120_000);

  it("refuses readiness while a run is already in flight for the session", async () => {
    stub = agendaLlm({ delayMs: 20_000 });
    const { sessionId, plan } = await prepare(backend);
    const record = unwrap(await backend.startExecution(sessionId, plan.runPlanId, plan.runPlanSha256, INPUT, undefined, true));
    const busy = unwrap(await backend.runReadiness(sessionId));
    expect(busy.ready).toBe(false);
    expect(busy.blocker!.code).toBe("execution_active");
    expect(busy.activeRunId).toBe(record.runId);
    await backend.cancelExecution(record.runId);
    await waitUntil(async () => unwrap(await backend.getExecution(record.runId))!.status === "cancelled");
  }, 120_000);

  it("reports a host without the completion runtime as unable to run", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agent-browser-no-llm-"));
    await mkdir(join(dir, "selectable"));
    const bare = newBackend(dir, { llm: undefined });
    await bare.initialize();
    await bare.launch();
    try {
      const { sessionId } = await prepare(bare);
      const status = await bare.status();
      expect(status.executionSupported).toBe(false);
      const verdict = unwrap(await bare.runReadiness(sessionId));
      expect(verdict.executionAvailable).toBe(false);
      expect(verdict.blocker!.code).toBe("bridge_unavailable");
    } finally {
      await bare.stop();
      await rm(dir, { recursive: true, force: true });
    }
  }, 120_000);

  // -- the task --------------------------------------------------------------------
  it("validates a task with the package's own schema, and names the fields", async () => {
    const { sessionId } = await prepare(backend);
    expect(unwrap(await backend.validateInput(sessionId, INPUT)).valid).toBe(true);
    const bad = unwrap(await backend.validateInput(sessionId, { ...INPUT, duration: 5, model: "remote/x" }));
    expect(bad.valid).toBe(false);
    expect(bad.errors.map((error) => `${error.pointer}:${error.rule}`).sort()).toEqual(["/duration:minimum", ":additionalProperties"]);
    expect(JSON.stringify(bad)).not.toContain("remote/x");
    expect(refusal(await backend.validateInput("session-does-not-exist", INPUT)).code).toBe("session_expired");
  }, 90_000);

  // -- start: exactly the plan ------------------------------------------------------
  it("runs exactly the plan, package, model and bindings the page was shown", async () => {
    const { sessionId, plan, view } = await prepare(backend);
    const record = unwrap(await backend.startExecution(sessionId, plan.runPlanId, plan.runPlanSha256, INPUT));
    expect(record.status).toBe("completed");
    expect(record.runPlanId).toBe(plan.runPlanId);
    expect(record.runPlanSha256).toBe(plan.runPlanSha256);
    expect(record.package.digest).toBe(view.identity.digest);
    expect(record.package.archiveSha256).toBe(view.snapshot.archiveSha256);
    expect(record.selectedModel.hostModelId).toBe(plan.modelBinding!.hostModelId);
    expect(record.model!.invoked).toEqual(["acme/big"]);
    expect(stub.calls.every((call) => call.startsWith("acme/big:"))).toBe(true);
    expect(record.origin).toBe("live");
    // The final record carries the runner's own settled progress.
    expect(record.progress!.completedNodes).toEqual(["plan", "perspectives", "join", "write", "validate", "output"]);
    expect(record.progress!.workers!.every((worker) => worker.state === "completed")).toBe(true);
    expect(record.failure).toBeNull();
  }, 120_000);

  it("refuses a start for a package that was never opened, or a plan it did not read", async () => {
    const unopened = refusal(await backend.startExecution("session-never-opened", "rp_x", "0".repeat(64), INPUT));
    expect(["session_expired", "run_plan_absent", "invalid_request"]).toContain(unopened.code);
    const { sessionId, plan } = await prepare(backend);
    expect(refusal(await backend.startExecution(sessionId, plan.runPlanId, "1".repeat(64), INPUT)).code).toBe("probe_refused");
    expect(stub.calls).toHaveLength(0);
  }, 90_000);

  // -- artifacts ------------------------------------------------------------------------
  it("serves an artifact in verified slices, and nothing outside the run's own files", async () => {
    const { sessionId, plan } = await prepare(backend);
    const record = unwrap(await backend.startExecution(sessionId, plan.runPlanId, plan.runPlanSha256, INPUT));
    const disk = await readFile(join(stateDir, "agent-browser", "runs", record.runId, "result.json"));
    const parts: Buffer[] = [];
    let offset = 0;
    let digest = "";
    for (;;) {
      const chunk = unwrap(await backend.readExecutionArtifactChunk(record.runId, "result.json", offset));
      parts.push(Buffer.from(chunk.base64, "base64"));
      offset += chunk.length;
      digest = chunk.sha256;
      expect(chunk.bytes).toBe(disk.byteLength);
      if (chunk.eof) break;
    }
    const assembled = Buffer.concat(parts);
    expect(assembled.equals(disk)).toBe(true);
    expect(createHash("sha256").update(assembled).digest("hex")).toBe(digest);
    for (const name of ["../result.json", "..", ".hidden", "result.json/../../x", "a/b"]) {
      expect(refusal(await backend.readExecutionArtifactChunk(record.runId, name, 0)).code).toBe("invalid_request");
    }
    expect(refusal(await backend.readExecutionArtifactChunk(record.runId, "absent.json", 0)).code).toBe("execution_unknown");
    expect(refusal(await backend.readExecutionArtifactChunk(record.runId, "result.json", disk.byteLength + 1)).code).toBe("invalid_request");
    expect(refusal(await backend.readExecutionArtifactChunk(`run_${"0".repeat(32)}`, "result.json", 0)).code).toBe("execution_unknown");
    // A view of a JSON artifact comes back parsed, with the right size and hash.
    const view = unwrap(await backend.readExecutionArtifact(record.runId, "agenda.json"));
    expect((view.json as { duration: number }).duration).toBe(45);
    expect(view.sha256).toBe(
      createHash("sha256").update(await readFile(join(stateDir, "agent-browser", "runs", record.runId, "agenda.json"))).digest("hex"),
    );
  }, 120_000);

  // -- cancellation ------------------------------------------------------------------
  it("cancels a detached run through the whole chain and leaves no child behind", async () => {
    stub = agendaLlm({ delayMs: 30_000 });
    const { sessionId, plan } = await prepare(backend);
    const started = unwrap(await backend.startExecution(sessionId, plan.runPlanId, plan.runPlanSha256, INPUT, undefined, true));
    expect(started.status).toBe("running");
    await waitUntil(async () => stub.calls.length > 0);
    expect(childrenRunning().length).toBeGreaterThan(0);
    const asked = unwrap(await backend.cancelExecution(started.runId));
    expect(asked.cancelRequested).toBe(true);
    await waitUntil(async () => unwrap(await backend.getExecution(started.runId))!.status === "cancelled");
    const record = unwrap(await backend.getExecution(started.runId))!;
    // Cancelled, not failed; the pending model call was aborted at the provider.
    expect(record.status).toBe("cancelled");
    expect(stub.aborted.length).toBeGreaterThan(0);
    expect(record.audit!.chainValid).toBe(true);
    expect(record.progress!.workers!.some((worker) => worker.state === "active")).toBe(false);
    expect(record.progress!.activeNodes).toEqual([]);
    await waitUntil(async () => childrenRunning().length === 0, 15_000);
    expect(unwrap(await backend.listExecutions(sessionId)).active).toBeNull();
  }, 120_000);

  // -- recovery -------------------------------------------------------------------------
  it("recovers finished runs after a restart as read-only evidence", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agent-browser-recover-"));
    await mkdir(join(dir, "selectable"));
    const first = newBackend(dir);
    await first.initialize();
    await first.launch();
    const { sessionId, plan } = await prepare(first);
    const record = unwrap(await first.startExecution(sessionId, plan.runPlanId, plan.runPlanSha256, INPUT));
    await first.stop();
    // Records a restart must not trust: a torn file, a record for another id,
    // and a record that claims to be still running.
    const runsDir = join(dir, "agent-browser", "runs");
    const torn = `run_${"1".repeat(32)}`;
    const foreign = `run_${"2".repeat(32)}`;
    const live = `run_${"3".repeat(32)}`;
    for (const name of [torn, foreign, live]) await mkdir(join(runsDir, name));
    await writeFile(join(runsDir, torn, "run.json"), "{ not json");
    const stored = JSON.parse(await readFile(join(runsDir, record.runId, "run.json"), "utf8"));
    await writeFile(join(runsDir, foreign, "run.json"), JSON.stringify(stored));
    await writeFile(join(runsDir, live, "run.json"), JSON.stringify({ ...stored, runId: live, status: "running" }));
    await mkdir(join(runsDir, "not-a-run-id"));

    const second = newBackend(dir);
    await second.initialize();
    await second.launch();
    try {
      const listed = unwrap(await second.listExecutions()).runs;
      expect(listed.map((item) => item.runId)).toEqual([record.runId]);
      const recovered = unwrap(await second.getExecution(record.runId))!;
      expect(recovered.origin).toBe("recovered");
      expect(recovered.status).toBe("completed");
      expect(recovered.runPlanSha256).toBe(plan.runPlanSha256);
      // Its artifacts are still readable by name, and only by name.
      expect((unwrap(await second.readExecutionArtifact(record.runId, "agenda.json")).json as { duration: number }).duration).toBe(45);
      // Evidence, not authority: its session and plan are gone, so nothing can run from it.
      expect(refusal(await second.startExecution(recovered.sessionId, recovered.runPlanId, recovered.runPlanSha256, INPUT)).code).toMatch(
        /session_expired|run_plan_absent|invalid_request/u,
      );
      expect(unwrap(await second.cancelExecution(record.runId)).status).toBe("completed");
    } finally {
      await second.stop();
      await rm(dir, { recursive: true, force: true });
    }
  }, 180_000);

  // -- selected files -------------------------------------------------------------------
  it("refuses documents unless a granted permission and an attached capability cover them", async () => {
    const pdf = join(stateDir, "selectable", "defenses.pdf");
    await writeFile(pdf, makePdf(["A defense against prompt injection."]));
    // files.pdfs denied, everything else allowed.
    const denied = await prepare(backend, REVIEW, (permission) => (permission.kind === "files.read" ? "deny" : "session"));
    const file = unwrap(await backend.selectFile(denied.sessionId, pdf));
    expect(JSON.stringify(file)).not.toContain(stateDir);
    const withDocument = { ...REVIEW_TASK, documents: { "10.1/defense": file.fileId } };
    const noPermission = refusal(
      await backend.startExecution(denied.sessionId, denied.plan.runPlanId, denied.plan.runPlanSha256, withDocument, [file.fileId]),
    );
    expect(noPermission.code).toBe("execution_refused");
    expect(noPermission.detail).toContain("files.pdfs");
    // A task that names a capability the run was not given.
    const notAttached = refusal(
      await backend.startExecution(denied.sessionId, denied.plan.runPlanId, denied.plan.runPlanSha256, withDocument),
    );
    expect(notAttached.code).toBe("invalid_request");
    // An id no host issued, or a path, is not a capability.
    for (const bogus of [`file_${"0".repeat(32)}`]) {
      expect(
        refusal(await backend.startExecution(denied.sessionId, denied.plan.runPlanId, denied.plan.runPlanSha256, REVIEW_TASK, [bogus])).code,
      ).toBe("invalid_request");
    }
    const pathAsDocument = unwrap(await backend.validateInput(denied.sessionId, { ...REVIEW_TASK, documents: { "10.1/x": pdf } }));
    expect(pathAsDocument.valid).toBe(false);
    expect(pathAsDocument.errors[0]!.rule).toBe("pattern");
    // A released capability is stale.
    await backend.releaseFile(denied.sessionId, file.fileId);
    expect(
      refusal(await backend.startExecution(denied.sessionId, denied.plan.runPlanId, denied.plan.runPlanSha256, withDocument, [file.fileId])).code,
    ).toBe("invalid_request");
    expect(unwrap(await backend.listExecutions(denied.sessionId)).runs).toHaveLength(0);
  }, 180_000);

  it("gives a run exactly the selected files its task names, by opaque id", async () => {
    const seen: Array<Record<string, unknown>> = [];
    const dir = await mkdtemp(join(tmpdir(), "agent-browser-attach-"));
    await mkdir(join(dir, "selectable"));
    const seam = newBackend(dir, {
      createExecutionBridge: (options: { packageFd: number; artifactsFd: number }) => {
        closeSync(options.packageFd);
        closeSync(options.artifactsFd);
        return {
          run: async (request: Record<string, unknown>, hooks: { onBegin?: (begin: Record<string, unknown>) => void } = {}) => {
            seen.push(request);
            const begin = { invocation: { run_invocation_sha256: "1".repeat(64), input_sha256: "2".repeat(64) } };
            hooks.onBegin?.(begin);
            return { begin, result: { status: "cancelled", error_code: "cancelled", artifacts: [] } };
          },
          cancel: async () => true,
          probe: async () => ({ begin: {}, report: {} }),
        };
      },
    });
    await seam.initialize();
    await seam.launch();
    try {
      const pdf = join(dir, "selectable", "paper.pdf");
      await writeFile(pdf, makePdf(["Selected."]));
      const granted = await prepare(seam, REVIEW);
      const file = unwrap(await seam.selectFile(granted.sessionId, pdf));
      unwrap(
        await seam.startExecution(
          granted.sessionId,
          granted.plan.runPlanId,
          granted.plan.runPlanSha256,
          { ...REVIEW_TASK, documents: { "10.1/paper": file.fileId } },
          [file.fileId],
        ),
      );
      expect(seen).toHaveLength(1);
      const request = seen[0]!;
      expect(request.attachments).toEqual([
        { file_id: file.fileId, sha256: file.sha256, bytes: file.bytes, media_type: "application/pdf" },
      ]);
      expect((request.input as { documents: Record<string, string> }).documents).toEqual({ "10.1/paper": file.fileId });
      const serialized = JSON.stringify(request);
      expect(serialized).not.toContain(dir);
      expect(serialized).not.toContain("paper.pdf");
      // The model and bindings come from the plan, never from the caller.
      expect((request.run_plan as { model_binding: { host_model_id: string } }).model_binding.host_model_id).toBe("acme/big");
      expect((request.run_plan as { tool_bindings: unknown[] }).tool_bindings).toHaveLength(3);
    } finally {
      await seam.stop();
      await rm(dir, { recursive: true, force: true });
    }
  }, 180_000);
});

// -- the contract refuses what the page must never be able to send ---------------------
describe("what an execution operation accepts", () => {
  function registered() {
    const actions = new Map<string, (action: unknown) => Promise<unknown>>();
    plugin.register({
      id: contract.pluginId,
      name: "Agent Browser",
      source: "test",
      registrationMode: "full",
      config: {},
      pluginConfig: { agentpkgPath: "/nonexistent/agentpkg" },
      logger: log,
      registerSessionAction: (registration: Record<string, unknown>) =>
        actions.set(String(registration.id), registration.handler as never),
      registerService: () => undefined,
      registerTool: () => undefined,
      registerCommand: () => undefined,
    } as never);
    return actions;
  }

  const PLAN = { sessionId: "session-abcdefgh1234", runPlanId: "rp_x", runPlanSha256: "9".repeat(64), input: {} };

  it.each([
    ["a model override", { ...PLAN, modelId: "remote/other" }],
    ["a tool binding override", { ...PLAN, toolBindings: [{ toolId: "scholarly-search", bindingId: "evil" }] }],
    ["a package path", { ...PLAN, path: "/tmp/other.agent.pkg" }],
    ["an arbitrary URL", { ...PLAN, url: "https://attacker.example/" }],
    ["a host method", { ...PLAN, method: "model.complete" }],
    ["a raw file path as a file", { ...PLAN, files: ["/etc/passwd"] }],
  ])("refuses %s in execution.start before any handler runs", async (_name, payload) => {
    const start = registered().get("execution.start")!;
    const result = (await start({ payload })) as Record<string, unknown>;
    expect(result.ok).toBe(false);
    expect(String(result.code)).toBe("INVALID_INPUT");
  });

  it.each([
    ["execution.get", { runId: "../../etc/passwd" }],
    ["execution.get", { runId: "run_x" }],
    ["execution.cancel", { runId: "run_" + "g".repeat(32) }],
    ["execution.artifact", { runId: `run_${"a".repeat(32)}`, name: "../run.json" }],
    ["execution.artifact", { runId: `run_${"a".repeat(32)}`, name: ".hidden" }],
    ["execution.artifact-chunk", { runId: `run_${"a".repeat(32)}`, name: "result.json", offset: -1 }],
    ["execution.readiness", { sessionId: "../x" }],
    ["execution.validate-input", { sessionId: "session-abcdefgh1234", input: {}, modelId: "x" }],
  ])("refuses a malformed %s request", async (operation, payload) => {
    const handler = registered().get(operation)!;
    const result = (await handler({ payload })) as Record<string, unknown>;
    expect(result.ok).toBe(false);
    expect(String(result.code)).toBe("INVALID_INPUT");
  });
});
