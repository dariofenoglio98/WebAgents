// @vitest-environment happy-dom
/**
 * compute.v0 in the browser's own surfaces (T22): the agent page's statement and module hashes,
 * a module package run end to end through the controller, the execution host and the run Worker's
 * engine port (in process here; `scripts/e2e-compute.mjs` does the same in Chrome), the run
 * surface's compute steps and call count, the privacy observer, and Settings → Run limits.
 */
import { afterEach, describe, expect, it } from "vitest";

import { sha256HexSync } from "../../src/core/hash.js";
import type { AuthorizeResult, ObservationsView, Request, RunView, SessionView, SettingsView } from "../../src/extension/messages.js";
import type { Settings } from "../../src/extension/storage/settings.js";
import { renderAgentPage } from "../../src/extension/ui/agent-page.js";
import { RunPanel, stagesFor } from "../../src/extension/ui/run.js";
import { newSettingsPageState, renderSettingsPage } from "../../src/extension/ui/settings-page.js";
import { DEFAULT_HOST_LIMITS } from "../../src/core/execution/limits.js";
import { inProcessComputeEngine } from "../helpers/compute.js";
import { caseModule, probeBytes, REQUEST } from "../helpers/compute-package.js";
import { scriptedOllama, scriptedOrigin, webairModelAnswers } from "../helpers/host.js";
import { makeHarness, PACKAGE_MEDIA_TYPE, PAGE, SITE_ORIGIN, webairRoutes, type Harness } from "../helpers/shell.js";

const PROBE_URL = `${SITE_ORIGIN}/compute-probe.agent.pkg`;
const ECHO = caseModule("echo");

afterEach(() => {
  document.body.replaceChildren();
});

/** A harness serving a signed probe (the echo module in one compute node, an unused model permission) whose key is pinned. */
async function probeWorld(options: { compute?: boolean } = {}): Promise<{ h: Harness; session: SessionView; modelSeen: number }> {
  const { bytes, key } = await probeBytes({ modelPermission: true });
  const routes = webairRoutes();
  routes[PROBE_URL] = { headers: { "content-type": PACKAGE_MEDIA_TYPE, "content-length": String(bytes.length) }, body: bytes };
  const model = scriptedOllama(webairModelAnswers());
  const h = makeHarness({ routes, transports: { model: model.transport, tool: scriptedOrigin().transport }, hostOptions: { compute: options.compute === false ? null : inProcessComputeEngine() } });
  const opened = (await h.controller.handle({ type: "package.open", url: PROBE_URL, advertisedOn: null, viewId: "compute" }, PAGE)) as SessionView;
  await h.controller.handle({ type: "trust.pin", sessionId: opened.session.id, signerFingerprint: key.fingerprint, scope: "publisher" }, PAGE);
  const settings = ((await h.controller.handle({ type: "settings.get" }, PAGE)) as SettingsView).settings;
  settings.models.default_model = "ollama/qwen3:30b";
  settings.developer = { record_requests: true };
  await h.controller.handle({ type: "settings.set", settings }, PAGE);
  const session = (await h.controller.handle({ type: "package.get", sessionId: opened.session.id }, PAGE)) as SessionView;
  return { h, session, modelSeen: model.seen.length };
}

async function authorize(h: Harness, session: SessionView): Promise<AuthorizeResult> {
  return (await h.controller.handle(
    {
      type: "authorization.authorize",
      sessionId: session.session.id,
      packageDigest: session.page.technical.digest,
      decisions: { "memory.session": "session", "compute.modules": "session", "model.unused": "session" },
      toolApprovals: {},
      resourceSelections: {},
      provenance: null,
      prepare: true,
    },
    PAGE,
  )) as AuthorizeResult;
}

describe("the agent page of a package that ships modules", () => {
  it("says the package runs code that can only compute, and lists each module with its hash, functions and memory", async () => {
    const { session } = await probeWorld();
    expect(session.summary.warnings.map((warning) => warning.code)).toContain("runs_code_that_can_only_compute");
    const group = session.page.access.find((item) => item.kind === "compute");
    expect(group).toMatchObject({ title: "Code it runs on your device", items: [expect.objectContaining({ id: "compute.modules", required: true, resources: ["echo"] })] });
    expect(group!.explanation).toMatch(/import nothing, so they can only compute/u);
    // The echo case module: one page at least, sixteen at most, the function the graph names.
    expect(session.page.technical.modules).toEqual([{ id: "echo", path: "modules/echo.wasm", sha256: sha256HexSync(ECHO), size: ECHO.length, functions: ["run"], memory_min_pages: 1, memory_max_pages: 16 }]);
    // The page a person reads: the group under what it may do, the hash under Technical details.
    const page = renderAgentPage(session);
    document.body.append(page);
    expect(page.textContent).toContain("Code it runs on your device");
    expect(page.textContent).toContain("Code it runs (WebAssembly modules)");
    const row = page.querySelector<HTMLElement>('.ab-module[data-module="echo"]')!;
    expect(row).not.toBeNull();
    expect(row.querySelector("code")?.textContent).toBe(sha256HexSync(ECHO));
    expect(row.textContent).toContain("calls run");
    expect(row.textContent).toContain("no imports");
  });
});

describe("a module package run from the browser", () => {
  it("runs the module in the run's engine, shows the compute step and the call count, and makes no request", async () => {
    const { h, session, modelSeen } = await probeWorld();
    const result = await authorize(h, session);
    expect(result.run_plan?.preflight.ready, JSON.stringify(result.plan_refused)).toBe(true);
    const plan = result.run_plan!.run_plan;
    const started = (await h.controller.handle({ type: "run.start", sessionId: session.session.id, runPlanId: plan.run_plan_id, runPlanSha256: plan.run_plan_sha256, input: REQUEST }, PAGE)) as RunView;
    await h.h_drain();
    const record = (await h.controller.handle({ type: "run.get", runId: started.runId }, PAGE)) as RunView;
    expect(record.status, JSON.stringify(record.failure ?? null)).toBe("completed");
    expect(record.usage?.computeCalls).toBe(1);
    expect(record.progress?.completed_nodes).toEqual(expect.arrayContaining(["compute", "output"]));
    // The privacy observer records every model and tool request in test mode: a module has no path to one.
    const observed = (await h.controller.handle({ type: "run.observations", runId: started.runId }, PAGE)) as ObservationsView;
    expect(observed).toMatchObject({ recording: true, observations: [] });
    expect(h.host.started).toHaveLength(1);
    // The run surface: the compute node is a step of its own, and the counters say how many module calls ran.
    expect(stagesFor([{ id: "compute", type: "compute" }, { id: "output", type: "output" }], null).map((stage) => stage.nodes)).toEqual([["compute", "output"]]);
    expect(stagesFor([{ id: "read", type: "llm" }, { id: "compute", type: "compute" }], null).map((stage) => stage.nodes)).toEqual([["read"], ["compute"]]);
    const panel = new RunPanel({ send: <T>(request: Request) => h.controller.handle(request, PAGE) as Promise<T>, loaded: () => ({ session, authorization: null }) });
    document.body.append(panel.root);
    await panel.attachSession(session.session.id);
    for (let attempt = 0; attempt < 100 && panel.root.dataset.state !== "completed"; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 10));
    expect(panel.root.dataset.state).toBe("completed");
    const terms = [...panel.root.querySelectorAll("dt")].map((node) => [node.textContent, node.nextElementSibling?.textContent]);
    expect(terms).toContainEqual(["Compute calls", "1"]);
    expect(terms).toContainEqual(["Model calls", "0"]);
    panel.dispose();
    expect(modelSeen).toBe(0);
  });

  it("is refused before it starts on a host without an engine (the extension always has one)", async () => {
    const { h, session } = await probeWorld({ compute: false });
    const result = await authorize(h, session);
    expect(result.run_plan?.preflight.ready).toBe(true);
    const plan = result.run_plan!.run_plan;
    const started = (await h.controller.handle({ type: "run.start", sessionId: session.session.id, runPlanId: plan.run_plan_id, runPlanSha256: plan.run_plan_sha256, input: REQUEST }, PAGE)) as RunView;
    await h.h_drain();
    const record = (await h.controller.handle({ type: "run.get", runId: started.runId }, PAGE)) as RunView;
    expect(record.status).toBe("failed");
    // The execution layer refuses it before the runtime starts: no node ran, so there is no audit.
    expect(record.errorCode).toBe("compute_not_supported");
    expect(record.audit).toBeNull();
  });
});

describe("Settings → Run limits", () => {
  it("offers the memory and time per compute call, saves typed values, keeps fuel as it is, and says fuel is not metered here", async () => {
    const h = makeHarness();
    const view = (await h.controller.handle({ type: "settings.get" }, PAGE)) as SettingsView;
    const saved: Settings[] = [];
    const actions = { onSave: (next: Settings) => saved.push(next), onSetKey: () => undefined, onProbe: () => undefined, rerender: () => undefined };
    const policies = renderSettingsPage(view, null, newSettingsPageState("policies"), actions);
    document.body.append(policies);
    const text = policies.textContent ?? "";
    expect(text).toContain("Memory per compute call");
    expect(text).toContain("Time per compute call");
    expect(text).toContain("this browser meters no fuel");
    // Fuel is accepted for shape parity with the reference host (D-250) but never offered: Chrome cannot meter it.
    expect(policies.querySelector('input[name="limit-compute_fuel"]')).toBeNull();
    const pages = policies.querySelector<HTMLInputElement>('input[name="limit-compute_memory_pages"]')!;
    const seconds = policies.querySelector<HTMLInputElement>('input[name="limit-compute_wall_seconds"]')!;
    expect([pages.value, seconds.value]).toEqual([String(DEFAULT_HOST_LIMITS.compute_memory_pages), String(DEFAULT_HOST_LIMITS.compute_wall_seconds)]);
    pages.value = "256";
    seconds.value = "3";
    [...policies.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Save limits")!.click();
    expect(saved.at(-1)!.limits).toEqual({ ...DEFAULT_HOST_LIMITS, compute_memory_pages: 256, compute_wall_seconds: 3 });
  });
});
