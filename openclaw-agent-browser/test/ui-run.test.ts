/**
 * The Run surface, rendered in a DOM with a fake feature client.
 *
 * Everything the page sends is recorded, so these tests assert what a person
 * can see and exactly what reaches the backend: a task and the plan identity
 * it believes is current — never a model, a binding, a path or a method.
 */
// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { runSummary, type PackageViewType, type RunRecordViewType } from "../src/contract.js";
import { mountAgentBrowser } from "../src/ui/page.js";
import { modelCatalogView, permissionsView, receiptView, runPlanStateView, serviceStatus } from "./fixtures.js";
import {
  FILE_ID,
  NO_RESULT_TEXT,
  RUN_ID,
  agendaView,
  fileCapability,
  literaturePlan,
  literatureView,
  readiness,
  runRecord,
  screeningProgress,
} from "./run-fixtures.js";

type Handler = (input: any) => unknown;
type Handlers = Record<string, Handler>;

const QUESTION =
  "What defenses have been proposed against prompt injection attacks on LLM-integrated applications?";

const LITERATURE_PERMISSIONS = permissionsView({
  permissions: [
    ...permissionsView().permissions.map((item) => ({ ...item, decision: "session" as const })),
    {
      id: "network.citations",
      kind: "network",
      description: "Verify references.",
      required: true,
      resources: ["resolver.example"],
      decision: "session",
      linkedTools: ["citation-resolver"],
      linkedDomains: ["resolver.example"],
    },
  ].map((item) => (item.id === "files.pdfs" ? { ...item, decision: "deny" as const } : item)),
  blockingReasons: [],
});

const RECEIPT = receiptView({
  decisions: [
    { permissionId: "network.scholarly", decision: "session" },
    { permissionId: "network.citations", decision: "session" },
    { permissionId: "model.reasoning", decision: "session" },
    { permissionId: "files.pdfs", decision: "deny" },
  ],
  grantedPermissionIds: ["network.scholarly", "network.citations", "model.reasoning"],
});

const ARTIFACTS: Record<string, { text?: string; json?: unknown }> = {
  "related-work.md": { text: "## Network-layer defenses\n\nA reverse proxy inspects requests [1].\n" },
  "bibliography.json": { json: [{ reference: 1, paper_id: "10.1/a" }, { reference: 2, paper_id: "10.1/b" }, { reference: 3, paper_id: "10.1/c" }] },
  "evidence-table.json": { json: new Array(6).fill(0).map((_, i) => ({ evidence_id: `10.1/a:e${i + 1}` })) },
  "verification.json": { json: new Array(6).fill(0).map((_, i) => ({ claim_id: `claim-${i + 1}`, status: "supported" })) },
  "unresolved.json": { json: [] },
  "result.json": { json: { status: "completed" } },
};

function artifactHandler(overrides: Record<string, { text?: string; json?: unknown }> = {}): Handler {
  const table = { ...ARTIFACTS, ...overrides };
  return ({ runId, name }: { runId: string; name: string }) => {
    const entry = table[name];
    if (!entry) {
      return {
        ok: false,
        error: { code: "execution_unknown", title: "No such artifact", detail: `No ${name}.`, retryable: false },
      };
    }
    const text = entry.text ?? JSON.stringify(entry.json);
    return {
      ok: true,
      value: {
        runId,
        name,
        bytes: text.length,
        sha256: "f".repeat(64),
        truncated: false,
        ...(entry.json !== undefined ? { json: entry.json } : { text }),
      },
    };
  };
}

type Options = {
  pkg?: PackageViewType;
  canWrite?: boolean;
  handlers?: Handlers;
  status?: ReturnType<typeof serviceStatus>;
  plan?: ReturnType<typeof literaturePlan> | null;
};

function mount(options: Options = {}) {
  const container = document.createElement("div");
  document.body.append(container);
  const calls: Array<{ operation: string; input: any }> = [];
  const controller = new AbortController();
  const pkg = options.pkg ?? literatureView();
  const plan = options.plan === undefined ? literaturePlan() : options.plan;
  const defaults: Handlers = {
    "service.status": () =>
      options.status ??
      serviceStatus({
        executionSupported: true,
        executionOperations: true,
        fileSelection: true,
        execution: { runTimeoutSeconds: 4500, modelCallTimeoutSeconds: 1200, receiptMarginSeconds: 60, fileRoots: ["/papers"] },
      }),
    "packages.list": () => ({
      ok: true,
      value: {
        sessions: [
          {
            sessionId: pkg.sessionId,
            packageId: pkg.identity.packageId,
            name: pkg.identity.packageId,
            version: pkg.identity.version,
            digest: pkg.identity.digest,
            expiresAt: pkg.expiresAt,
            source: pkg.source,
            signatureStatus: "valid",
            trustStatus: pkg.publisher.trustStatus,
            authorizationState: "issued",
            runnable: true,
          },
        ],
        max: 8,
      },
    }),
    "packages.get": () => ({ ok: true, value: pkg }),
    "packages.open-url": () => ({ ok: true, value: pkg }),
    "packages.permissions": () => ({ ok: true, value: LITERATURE_PERMISSIONS }),
    "packages.authorization": () => ({ ok: true, value: RECEIPT }),
    "models.evaluate": () => ({ ok: true, value: modelCatalogView() }),
    "tools.evaluate": () => ({ ok: false, error: { code: "tool_registry_unavailable", title: "x", detail: "x", retryable: false } }),
    "run-plan.get": () => ({ ok: true, value: plan ?? { plan: null, preflight: null, executionSupported: true } }),
    "files.list": () => ({ ok: true, value: { files: [] } }),
    "execution.status": () => ({ ok: true, value: { runs: [], active: null } }),
    "execution.readiness": () => ({ ok: true, value: readiness() }),
    "execution.validate-input": ({ input }: { input: any }) => ({
      ok: true,
      value: {
        sessionId: pkg.sessionId,
        schemaPath: "schemas/workflow-input.schema.json",
        valid: typeof input?.question === "string" ? input.question.length > 0 : true,
        errors:
          typeof input?.question === "string" && input.question.length === 0
            ? [{ pointer: "/question", rule: "minLength", message: "must be at least 1 character" }]
            : [],
        errorCount: 0,
        inputSha256: "1".repeat(64),
        inputBytes: 100,
      },
    }),
    "execution.artifact": artifactHandler(),
  };
  const merged = { ...defaults, ...(options.handlers ?? {}) };
  const dispose = mountAgentBrowser(container, {
    invoke: async (operation: string, input: unknown) => {
      calls.push({ operation, input });
      const handler = merged[operation];
      if (!handler) throw new Error(`unexpected operation ${operation}`);
      return handler(input as never);
    },
    signal: controller.signal,
    canWrite: options.canWrite ?? true,
  });
  const text = () => container.textContent ?? "";
  const runButton = () => container.querySelector<HTMLButtonElement>("button[data-run='start']");
  const called = (operation: string) => calls.filter((call) => call.operation === operation);
  return { container, calls, dispose, controller, text, runButton, called };
}

async function waitFor(predicate: () => boolean, timeoutMs = 4000): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > until) throw new Error("condition not met in time");
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
}

async function openPackage(page: ReturnType<typeof mount>) {
  await waitFor(() => page.called("packages.list").length > 0);
  const tab = [...page.container.querySelectorAll("button")].find((button) =>
    (button.textContent ?? "").includes("org.webagents"),
  );
  tab!.click();
  // The Run panel is attached once it shows either the task form or a run.
  await waitFor(() => {
    const form = page.container.querySelector(".ab-run-form");
    const view = page.container.querySelector(".ab-run-view");
    return Boolean((form && form.childElementCount > 0) || (view && view.childElementCount > 0));
  });
}

function typeInto(element: HTMLInputElement | HTMLTextAreaElement, value: string) {
  element.value = value;
  element.dispatchEvent(new Event("input"));
}

async function ready(page: ReturnType<typeof mount>) {
  await openPackage(page);
  const question = page.container.querySelector<HTMLTextAreaElement>("textarea#ab-field-question")!;
  typeInto(question, QUESTION);
  await waitFor(() => page.runButton()?.disabled === false);
  return question;
}

beforeEach(() => {
  document.body.innerHTML = "";
});

// -- the task form --------------------------------------------------------------
describe("the task form", () => {
  it.each([25, 37])("preserves an edited duration of %i through rerender, JSON and invocation", async (duration) => {
    const started = vi.fn(() => ({ ok: true, value: runRecord({ status: "running" }) }));
    const page = mount({ pkg: agendaView(), handlers: {
      "execution.start": started,
      "execution.get": () => ({ ok: true, value: runRecord() }),
    } });
    await openPackage(page);
    const field = () => page.container.querySelector<HTMLInputElement>("#ab-field-duration")!;
    expect(field().value).toBe("");
    typeInto(field(), "15");
    await waitFor(() => page.called("execution.validate-input").at(-1)?.input.input.duration === 15);
    typeInto(field(), String(duration));
    typeInto(page.container.querySelector<HTMLTextAreaElement>("#ab-field-goal")!, "Decide\nnext steps");
    const clickText = (text: string) => [...page.container.querySelectorAll("button")].find(b => b.textContent === text)!.click();
    clickText("Add participants"); // Recreates controls using the current value.
    expect(field().value).toBe(String(duration));
    clickText("Edit as JSON");
    const json = page.container.querySelector<HTMLTextAreaElement>("[aria-label='Task as JSON']")!;
    expect(JSON.parse(json.value).duration).toBe(duration);
    clickText("Edit as form");
    expect(field().value).toBe(String(duration));
    await waitFor(() => page.runButton()?.disabled === false);
    page.runButton()!.click();
    await waitFor(() => started.mock.calls.length === 1);
    const sent = JSON.parse(JSON.stringify(page.called("execution.start")[0]!.input));
    expect(sent.input.duration).toBe(duration);
    expect(sent.input.goal).toBe("Decide\nnext steps");
    page.dispose();
  });

  it("renders the Literature Review task from its own schema and hints", async () => {
    const page = mount();
    await openPackage(page);
    const text = page.text();
    expect(text).toContain("What would you like me to research?");
    expect(text).toContain("Research question");
    const question = page.container.querySelector<HTMLTextAreaElement>("textarea#ab-field-question")!;
    expect(question.getAttribute("rows")).toBe("4");
    expect(question.maxLength).toBe(2000);
    expect(question.placeholder).toContain("prompt injection");
    // Optional and advanced fields sit behind disclosures, labelled from the schema.
    const groups = [...page.container.querySelectorAll("details.ab-form-group summary")].map((node) => node.textContent);
    expect(groups).toEqual(["Optional — Seed papers, Documents", "Advanced — Mode"]);
    const mode = page.container.querySelector<HTMLSelectElement>("select#ab-field-mode")!;
    expect(mode.options[mode.selectedIndex]!.textContent).toBe("live");
    // The initial task is the schema's own defaults.
    await waitFor(() => page.called("execution.validate-input").length > 0);
    expect(page.called("execution.validate-input").at(-1)!.input.input).toEqual({
      question: "",
      seeds: [],
      documents: {},
      mode: "live",
    });
    expect(page.runButton()!.textContent).toBe("Run Research");
    page.dispose();
  });

  it("renders Meeting Agenda's task generically, with no hints at all", async () => {
    const page = mount({ pkg: agendaView() });
    await openPackage(page);
    expect(page.container.querySelector("textarea#ab-field-goal")).not.toBeNull();
    expect(page.container.querySelector("textarea#ab-field-context")).not.toBeNull();
    const duration = page.container.querySelector<HTMLInputElement>("input#ab-field-duration")!;
    expect(duration.type).toBe("number");
    expect(duration.min).toBe("10");
    expect(duration.max).toBe("240");
    const add = [...page.container.querySelectorAll("button")].find((button) => button.textContent === "Add participants")!;
    add.click();
    await waitFor(() => page.container.querySelectorAll("input[aria-label^='Participants 1']").length === 2);
    const [name, role] = [...page.container.querySelectorAll<HTMLInputElement>("input[aria-label^='Participants 1']")];
    typeInto(name!, "Ari");
    typeInto(role!, "researcher");
    typeInto(duration, "45");
    typeInto(page.container.querySelector<HTMLTextAreaElement>("textarea#ab-field-goal")!, "Decide");
    await waitFor(() => page.called("execution.validate-input").at(-1)?.input.input.duration === 45);
    expect(page.called("execution.validate-input").at(-1)!.input.input).toMatchObject({
      goal: "Decide",
      participants: [{ name: "Ari", role: "researcher" }],
      duration: 45,
    });
    expect(page.runButton()!.textContent).toBe("Run");
    page.dispose();
  });

  it("falls back to a validated JSON editor for a shape it does not render", async () => {
    const pkg = literatureView();
    pkg.workflow.input = {
      ...pkg.workflow.input!,
      document: {
        type: "object",
        properties: { query: { anyOf: [{ type: "string" }, { type: "array", items: { type: "string" } }] } },
        required: ["query"],
      },
    };
    const page = mount({ pkg, handlers: { "execution.validate-input": () => ({ ok: true, value: { sessionId: pkg.sessionId, schemaPath: null, valid: true, errors: [], errorCount: 0, inputSha256: null, inputBytes: 2 } }) } });
    await openPackage(page);
    const editor = page.container.querySelector<HTMLTextAreaElement>("textarea#ab-field-query")!;
    expect(editor.className).toContain("ab-json-editor");
    typeInto(editor, "{not json");
    await waitFor(() => page.text().includes("Not valid JSON."));
    expect(page.runButton()!.disabled).toBe(true);
    expect(page.text()).toContain("Not valid JSON.");
    typeInto(editor, '["a", "b"]');
    await waitFor(() => page.runButton()!.disabled === false);
    page.dispose();
  });

  it("edits the whole task as JSON and back", async () => {
    const page = mount();
    await openPackage(page);
    const toggle = [...page.container.querySelectorAll("button")].find((b) => b.textContent === "Edit as JSON")!;
    toggle.click();
    const area = page.container.querySelector<HTMLTextAreaElement>("textarea[aria-label='Task as JSON']")!;
    expect(JSON.parse(area.value)).toEqual({ question: "", seeds: [], documents: {}, mode: "live" });
    typeInto(area, JSON.stringify({ question: QUESTION, seeds: ["10.1/x"], documents: {}, mode: "live" }));
    [...page.container.querySelectorAll("button")].find((b) => b.textContent === "Edit as form")!.click();
    const question = page.container.querySelector<HTMLTextAreaElement>("textarea#ab-field-question")!;
    expect(question.value).toBe(QUESTION);
    page.dispose();
  });
});

// -- the Run button ---------------------------------------------------------------
describe("the Run button", () => {
  const cases: Array<[string, Options, string]> = [
    [
      "an untrusted publisher",
      { pkg: literatureView({ publisher: { ...literatureView().publisher, trustStatus: "unknown", trustReason: "signer_key_not_pinned" } }) },
      "The signing key is not pinned on this host",
    ],
    [
      "a missing authorization",
      { handlers: { "packages.authorization": () => ({ ok: true, value: null }) } },
      "Set each permission and approve each tool, then Authorize.",
    ],
    ["a missing run plan", { plan: null }, "Prepare a run plan in the Model section."],
    [
      "a stale run plan",
      {
        plan: literaturePlan({
          ready: false,
          stale: true,
          staleReasons: [{ code: "publisher_trust_changed", message: "Publisher trust changed after preparation.", subject: null }],
        }),
      },
      "The run plan is stale: Publisher trust changed after preparation.",
    ],
    [
      "a model the host no longer offers",
      { plan: literaturePlan({ ready: false, stale: true, modelStillAvailable: false, staleReasons: [] }) },
      "no longer offered by this host",
    ],
    [
      "a tool binding that changed",
      { plan: literaturePlan({ toolBindingsCurrent: false }) },
      "A tool implementation changed or disappeared",
    ],
    [
      "a preflight refusal",
      {
        handlers: {
          "execution.readiness": () => ({
            ok: true,
            value: readiness({
              ready: false,
              blocker: { code: "authorization_expiring", title: "This authorization is about to expire", detail: "Open the package again." },
            }),
          }),
        },
      },
      "This authorization is about to expire. Open the package again.",
    ],
    [
      "a host without the completion runtime",
      { status: serviceStatus({ executionSupported: false }) },
      "This host cannot run packages",
    ],
    ["a read-only operator", { canWrite: false }, "Operator write access is required to run a package."],
  ];

  it.each(cases)("is disabled, with the precise reason, for %s", async (_name, options, reason) => {
    const page = mount(options);
    await openPackage(page);
    const question = page.container.querySelector<HTMLTextAreaElement>("textarea#ab-field-question");
    if (question && !question.disabled) typeInto(question, QUESTION);
    await waitFor(() => page.text().includes(reason));
    expect(page.runButton()!.disabled).toBe(true);
    expect(page.called("execution.start")).toHaveLength(0);
    page.dispose();
  });

  it("is disabled for a task the package's schema rejects, naming the field", async () => {
    const page = mount();
    await openPackage(page);
    // The checklist names the field by its schema title.
    await waitFor(() => page.text().includes("Research question must be at least 1 character."));
    expect(page.runButton()!.disabled).toBe(true);
    // An untouched field is not painted as a mistake...
    const inline = page.container.querySelector("[data-field-error='question']")!;
    expect(inline.textContent).toBe("");
    // ...but once the person has edited it, the server's verdict sits beside it.
    const question = page.container.querySelector<HTMLTextAreaElement>("textarea#ab-field-question")!;
    typeInto(question, "x");
    await waitFor(() => page.runButton()!.disabled === false);
    typeInto(question, "");
    await waitFor(() => inline.textContent === "must be at least 1 character");
    expect(page.runButton()!.disabled).toBe(true);
    page.dispose();
  });

  it("is enabled only when everything holds, and sends the task and nothing else", async () => {
    const started = vi.fn(() => ({ ok: true, value: runRecord({ status: "running" }) }));
    const page = mount({ handlers: { "execution.start": started, "execution.get": () => ({ ok: true, value: runRecord() }) } });
    await ready(page);
    page.runButton()!.click();
    await waitFor(() => started.mock.calls.length === 1);
    const sent = page.called("execution.start")[0]!.input;
    expect(Object.keys(sent).sort()).toEqual(["detach", "input", "runPlanId", "runPlanSha256", "sessionId"]);
    expect(sent).toMatchObject({
      sessionId: "session-abcdefgh1234",
      runPlanId: runPlanStateView().plan!.runPlanId,
      runPlanSha256: runPlanStateView().plan!.runPlanSha256,
      detach: true,
      input: { question: QUESTION, seeds: [], documents: {}, mode: "live" },
    });
    // The task keeps the schema's field order, whatever order it was edited in.
    expect(Object.keys(sent.input as object)).toEqual(["question", "seeds", "documents", "mode"]);
    // No model, binding, tool, path or method can be expressed in a start.
    expect(JSON.stringify(sent)).not.toMatch(/model|binding|tool|path|endpoint|method/iu);
    await waitFor(() => page.text().includes("Researching"));
    page.dispose();
  });

  it("refuses a second click while a run starts, and shows a start refusal precisely", async () => {
    let release: (value: unknown) => void = () => undefined;
    const gate = new Promise((resolve) => (release = resolve));
    const page = mount({
      handlers: {
        "execution.start": async () => {
          await gate;
          return {
            ok: false,
            error: { code: "run_plan_stale", title: "This run plan is no longer current", detail: "The package bytes are not the planned bytes.", retryable: false },
          };
        },
      },
    });
    await ready(page);
    page.runButton()!.click();
    await waitFor(() => page.runButton()!.textContent === "Starting…");
    expect(page.runButton()!.disabled).toBe(true);
    page.runButton()!.click();
    release(null);
    await waitFor(() => page.text().includes("This run plan is no longer current"));
    expect(page.called("execution.start")).toHaveLength(1);
    expect(page.text()).toContain("run_plan_stale");
    page.dispose();
  });
});

// -- live progress --------------------------------------------------------------
describe("live progress", () => {
  it("renders stages, workers and counters from the runner's own snapshot", async () => {
    const record = runRecord({ status: "running", progress: screeningProgress() });
    const page = mount({
      handlers: {
        "execution.status": () => ({ ok: true, value: { runs: [runSummary(record)], active: record } }),
        "execution.get": () => ({ ok: true, value: record }),
      },
    });
    await openPackage(page);
    await waitFor(() => page.text().includes("Researching"));
    const stages = [...page.container.querySelectorAll(".ab-stage")].map((node) => node.textContent ?? "");
    expect(stages[0]).toMatch(/^✓Planning/u);
    expect(stages[1]).toMatch(/^✓Scholarly search/u);
    expect(stages[1]).toContain("Worker 1 ✓");
    expect(stages[1]).toContain("Worker 3 ✓");
    expect(stages[2]).toMatch(/^●Screening/u);
    expect(stages[2]).toContain("Worker 1 ✓");
    expect(stages[2]).toContain("Worker 2 ●");
    expect(stages[2]).toContain("Worker 3 ●");
    expect(stages.slice(3).every((line) => line.startsWith("○"))).toBe(true);
    expect(stages.map((line) => line.replace(/Worker.*/u, "").slice(1))).toEqual([
      "Planning",
      "Scholarly search",
      "Screening",
      "Citations",
      "Evidence extraction",
      "Synthesis",
      "Writing",
      "Verification",
    ]);
    const text = page.text();
    expect(text).toContain("Model calls7");
    expect(text).toContain("Tool calls3");
    expect(text).toContain("Tokens41,240");
    expect(text).toContain("Qwen 3 30B · Local");
    expect(text).toMatch(/elapsed 08:4\d/u);
    // A running run offers Cancel, not Run.
    expect(page.runButton()).toBeNull();
    expect([...page.container.querySelectorAll("button")].some((b) => b.textContent === "Cancel")).toBe(true);
    page.dispose();
  });

  it("shows every stage pending before the first snapshot", async () => {
    const record = runRecord({ status: "running", progress: null });
    const page = mount({
      handlers: {
        "execution.status": () => ({ ok: true, value: { runs: [runSummary(record)], active: record } }),
        "execution.get": () => ({ ok: true, value: record }),
      },
    });
    await openPackage(page);
    await waitFor(() => page.container.querySelectorAll(".ab-stage").length === 8);
    expect([...page.container.querySelectorAll(".ab-stage-pending")]).toHaveLength(8);
    page.dispose();
  });

  it("follows a run to completion by polling execution.get", async () => {
    const running = runRecord({ status: "running", progress: screeningProgress() });
    const done = runRecord({ status: "completed", endedAt: new Date().toISOString(), durationMs: 2_440_000 });
    let finished = false;
    const page = mount({
      handlers: {
        "execution.status": () => ({
          ok: true,
          value: finished ? { runs: [runSummary(done)], active: null } : { runs: [runSummary(running)], active: running },
        }),
        "execution.get": () => {
          finished = true;
          return { ok: true, value: done };
        },
        "execution.artifact": artifactHandler(),
      },
    });
    await openPackage(page);
    await waitFor(() => page.text().includes("Research completed"), 6000);
    expect(page.called("execution.get").every((call) => call.input.runId === RUN_ID)).toBe(true);
    page.dispose();
  });
});

// -- outcomes -----------------------------------------------------------------------
describe("a finished run", () => {
  function finished(record: RunRecordViewType, handlers: Handlers = {}) {
    return mount({
      handlers: {
        "execution.status": () => ({ ok: true, value: { runs: [runSummary(record)], active: null } }),
        "execution.get": () => ({ ok: true, value: record }),
        ...handlers,
      },
    });
  }

  const completed = () =>
    runRecord({
      status: "completed",
      endedAt: "2026-09-26T10:40:40.000Z",
      durationMs: 2_440_000,
      progress: { ...screeningProgress(), activeNodes: [], workersActive: 0, completedNodes: literatureView().workflow.nodes.map((node) => node.id) },
      usage: {
        tokens: 120242,
        remoteCalls: 6,
        peakParallelWorkers: 3,
        toolCalls: 6,
        limits: { hardTokens: 180000, maxRemoteCalls: 45, maxParallelWorkers: 3 },
        workers: [],
      },
      cost: { status: "complete", totalUsd: 0, calls: 16, callsWithReportedCost: 16 },
      audit: {
        events: 404,
        chainValid: true,
        finalHash: "9".repeat(64),
        actions: [],
        workers: [],
        workersSpawned: 22,
        nodesCompleted: 18,
        modelCalls: 16,
        toolCalls: 6,
        tasksCalled: [],
      },
      model: {
        planned: "ollama/qwen3:30b",
        invoked: ["ollama/qwen3:30b"],
        calls: 16,
        allCallsUsedPlannedModel: true,
        providers: ["ollama"],
        responseModels: ["qwen3:30b"],
      },
    });

  it("renders the primary result, the declared summary and every artifact", async () => {
    const page = finished(completed());
    await openPackage(page);
    await waitFor(() => page.text().includes("A reverse proxy inspects requests [1]."));
    const text = page.text();
    expect(text).toContain("✓ Research completed");
    expect(text).toContain("Finished in 40:40");
    expect(text).toContain("Papers included3");
    expect(text).toContain("Evidence items6");
    expect(text).toContain("Claims verified6");
    expect(text).toContain("Unresolved0");
    for (const name of ["related-work.md", "bibliography.json", "evidence-table.json", "unresolved.json", "verification.json", "result.json", "audit.json", "usage.json", "provenance.json", "run.json"]) {
      expect(text).toContain(name);
    }
    // Technical details: package, plan, run, model, tools, usage, cost, audit, workers.
    for (const fact of [
      "org.webagents.literature-review 0.2.2",
      runPlanStateView().plan!.runPlanId,
      RUN_ID,
      "every call used the planned model",
      "scholarly-search → Crossref works search",
      "120,242 tokens of 180,000",
      "$0 (complete; 16 of 16 calls reported a cost)",
      "404 events · chain valid",
      "22 spawned",
    ]) {
      expect(text).toContain(fact);
    }
    expect(page.container.querySelector(".ab-markdown h4")?.textContent).toBe("Network-layer defenses");
    expect([...page.container.querySelectorAll("button")].some((b) => b.textContent === "New run")).toBe(true);
    // The frame carries the outcome's tone, and each summary list sits on a
    // row of its own rather than in the label/value grid.
    expect(page.container.querySelector<HTMLElement>(".ab-run")?.dataset.state).toBe("completed");
    const summary = page.container.querySelector(".ab-result-summary dl")!;
    for (const detail of summary.querySelectorAll("details")) {
      expect(detail.parentElement?.classList.contains("ab-summary-detail")).toBe(true);
    }
    page.dispose();
  });

  it("renders untrusted Markdown without markup, scripts or unsafe links", async () => {
    const hostile =
      "## Title <img src=x onerror=alert(1)>\n\n<script>alert(1)</script> **bold** " +
      "[click](javascript:alert(1)) [paper](https://example.org/p)\n";
    const page = finished(completed(), { "execution.artifact": artifactHandler({ "related-work.md": { text: hostile } }) });
    await openPackage(page);
    await waitFor(() => page.text().includes("bold"));
    const markdown = page.container.querySelector(".ab-markdown")!;
    expect(markdown.querySelector("script")).toBeNull();
    expect(markdown.querySelector("img")).toBeNull();
    expect(markdown.textContent).toContain("<script>alert(1)</script>");
    const links = [...markdown.querySelectorAll("a")];
    expect(links.map((link) => link.getAttribute("href"))).toEqual(["https://example.org/p"]);
    expect(links[0]!.rel).toContain("noopener");
    expect(links[0]!.rel).toContain("noreferrer");
    expect(markdown.textContent).toContain("click");
    page.dispose();
  });

  it("presents a zero-evidence review as a successful bounded search", async () => {
    const page = finished(
      completed(),
      {
        "execution.artifact": artifactHandler({
          "related-work.md": { text: NO_RESULT_TEXT },
          "bibliography.json": { json: [] },
          "evidence-table.json": { json: [] },
          "verification.json": { json: [] },
          "unresolved.json": { json: [{ paper_id: "10.5555/x", status: "not_found", message: "No match." }] },
        }),
      },
    );
    await openPackage(page);
    await waitFor(() => page.text().includes("No sufficiently grounded literature was found within this bounded search."));
    const text = page.text();
    expect(text).toContain("✓ Research completed");
    expect(text).toContain("Papers included0");
    expect(text).toContain("Evidence items0");
    expect(text).toContain("Unresolved1");
    expect(text).toContain("status: not_found");
    expect(text).not.toContain("did not complete");
    page.dispose();
  });

  it("explains a failed run from its own audit, without a stack trace", async () => {
    const record = runRecord({
      status: "failed",
      errorCode: "schema_validation",
      endedAt: "2026-09-26T10:20:00.000Z",
      durationMs: 1_200_000,
      artifacts: [{ name: "result.json", bytes: 10, sha256: "0".repeat(64) }, { name: "audit.json", bytes: 10, sha256: "1".repeat(64) }],
      failure: {
        nodeId: "check-evidence",
        stepId: null,
        errorCode: "schema_validation",
        failedCheck: { check: "assertion", index: 0, kind: "relation", failure: "duplicate_target_key", target_key: "/evidence_id" },
        call: null,
      },
    });
    const page = finished(record);
    await openPackage(page);
    await waitFor(() => page.text().includes("A package check refused the result"));
    expect(page.container.querySelector<HTMLElement>(".ab-run")?.dataset.state).toBe("failed");
    const text = page.text();
    expect(text).toContain("schema_validation");
    // Named by the package's validated hints, with the node id kept.
    expect(text).toContain("Stopped at Check evidence ids (check-evidence), in Evidence extraction.");
    expect(text).toContain("failure=duplicate_target_key");
    expect(text).toContain("A run that did not complete writes no package exports");
    expect(text).not.toMatch(/Traceback|at .*\.py|Error:/u);
    page.dispose();
  });

  it("reports a cancelled run as cancelled, not failed", async () => {
    const record = runRecord({
      status: "cancelled",
      errorCode: "cancelled",
      cancelRequested: true,
      endedAt: "2026-09-26T10:05:00.000Z",
      durationMs: 300_000,
      progress: screeningProgress(),
    });
    const page = finished(record);
    await openPackage(page);
    await waitFor(() => page.text().includes("Run cancelled"));
    expect(page.container.querySelector<HTMLElement>(".ab-run")?.dataset.state).toBe("cancelled");
    expect(page.container.querySelector(".ab-stage-failed")).toBeNull();
    expect(page.container.querySelector(".ab-stage-cancelled .ab-stage-icon")?.textContent).toBe("⊘");
    expect(page.container.querySelector(".ab-run-task")?.textContent).toBe(`“${QUESTION}”`);
    expect(page.text()).not.toContain("did not complete");
    expect(page.container.querySelector(".ab-banner-warn")).not.toBeNull();
    page.dispose();
  });

  it("counts a summary from complete JSON the host could only send as text", async () => {
    // Too intricate for the host to send parsed, but whole: the page parses it.
    const rows = Array.from({ length: 7 }, (_, i) => ({ paper_id: `10.1/${i}`, title: `Paper ${i}` }));
    const page = finished(completed(), {
      "execution.artifact": (input: { runId: string; name: string }) => {
        const base = artifactHandler()(input) as { ok: boolean; value?: Record<string, unknown> };
        if (input.name !== "bibliography.json" || !base.ok) return base;
        const text = JSON.stringify(rows);
        return { ok: true, value: { ...base.value, json: undefined, text, bytes: text.length, truncated: false } };
      },
    });
    await openPackage(page);
    await waitFor(() => page.text().includes("Papers included7"));
    page.dispose();
  });

  it("says how much of a large artifact a view shows, and where the rest is", async () => {
    const page = finished(completed(), {
      "execution.artifact": (input: { runId: string; name: string }) => {
        const base = artifactHandler()(input) as { ok: boolean; value?: Record<string, unknown> };
        if (input.name !== "audit.json") return base;
        return {
          ok: true,
          value: {
            runId: input.runId,
            name: "audit.json",
            bytes: 305_988,
            sha256: "e".repeat(64),
            truncated: true,
            shownBytes: 49_152,
            text: '{"events": [',
          },
        };
      },
    });
    await openPackage(page);
    await waitFor(() => page.text().includes("audit.json"));
    const view = [...page.container.querySelectorAll(".ab-artifact")]
      .find((row) => row.textContent?.startsWith("audit.json"))!
      .querySelector("button")!;
    view.click();
    await waitFor(() => page.text().includes("Showing the first 48.0 KiB of 298.8 KiB. Download has the whole file, verified."));
    // A truncated JSON view is shown as the text it is, not parsed.
    expect(page.container.querySelector(".ab-viewer pre")?.textContent).toBe('{"events": [');
    page.dispose();
  });

  it("views an artifact and downloads it chunk by chunk, verified", async () => {
    const body = new TextEncoder().encode(JSON.stringify({ events: new Array(3000).fill("x") }));
    const digest = [...new Uint8Array(await crypto.subtle.digest("SHA-256", body))]
      .map((value) => value.toString(16).padStart(2, "0"))
      .join("");
    const chunkSize = 4096;
    const chunk = vi.fn(({ runId, name, offset }: { runId: string; name: string; offset: number }) => {
      const slice = body.subarray(offset, offset + chunkSize);
      return {
        ok: true,
        value: {
          runId,
          name,
          bytes: body.byteLength,
          sha256: digest,
          offset,
          length: slice.byteLength,
          base64: Buffer.from(slice).toString("base64"),
          eof: offset + slice.byteLength >= body.byteLength,
        },
      };
    });
    const saved: Blob[] = [];
    const create = vi.fn((blob: Blob) => {
      saved.push(blob);
      return "blob:agent-browser";
    });
    URL.createObjectURL = create as never;
    URL.revokeObjectURL = vi.fn() as never;
    const page = finished(completed(), { "execution.artifact-chunk": chunk });
    await openPackage(page);
    await waitFor(() => page.text().includes("audit.json"));
    const row = [...page.container.querySelectorAll(".ab-artifact")].find((node) => node.textContent?.includes("result.json"))!;
    [...row.querySelectorAll("button")].find((b) => b.textContent === "View")!.click();
    await waitFor(() => page.container.querySelector(".ab-viewer pre") !== null);
    expect(page.container.querySelector(".ab-viewer pre")!.textContent).toContain('"status": "completed"');
    const audit = [...page.container.querySelectorAll(".ab-artifact")].find((node) => node.textContent?.includes("audit.json"))!;
    [...audit.querySelectorAll("button")].find((b) => b.textContent === "Download")!.click();
    await waitFor(() => page.text().includes("SHA-256 verified"));
    expect(chunk.mock.calls.map((call) => call[0].offset)).toEqual(
      new Array(Math.ceil(body.byteLength / chunkSize)).fill(0).map((_, index) => index * chunkSize),
    );
    expect(chunk.mock.calls.every((call) => call[0].name === "audit.json" && call[0].runId === RUN_ID)).toBe(true);
    expect(saved[0]!.size).toBe(body.byteLength);
    page.dispose();
  });

  it("starts a follow-up as a new run that inherits nothing but the person's words", async () => {
    const second = runRecord({ runId: `run_${"c".repeat(32)}`, status: "running" });
    const started = vi.fn(() => ({ ok: true, value: second }));
    const page = finished(completed(), { "execution.start": started });
    await openPackage(page);
    await waitFor(() => page.text().includes("Research completed"));
    [...page.container.querySelectorAll("button")].find((b) => b.textContent === "New run")!.click();
    const question = page.container.querySelector<HTMLTextAreaElement>("textarea#ab-field-question")!;
    typeInto(question, `${QUESTION} Focus on 2025.`);
    await waitFor(() => page.runButton()?.disabled === false);
    page.runButton()!.click();
    await waitFor(() => started.mock.calls.length === 1);
    const sent = page.called("execution.start")[0]!.input;
    expect(sent.input.question).toBe(`${QUESTION} Focus on 2025.`);
    expect(JSON.stringify(sent)).not.toContain(RUN_ID);
    page.dispose();
  });
});

// -- cancellation ---------------------------------------------------------------------
describe("cancellation", () => {
  it("sends execution.cancel with the run id only, and shows the run stopping", async () => {
    const record = runRecord({ status: "running", progress: screeningProgress() });
    const cancel = vi.fn(() => ({ ok: true, value: { ...record, cancelRequested: true } }));
    const page = mount({
      handlers: {
        "execution.status": () => ({ ok: true, value: { runs: [runSummary(record)], active: record } }),
        "execution.get": () => ({ ok: true, value: record }),
        "execution.cancel": cancel,
      },
    });
    await openPackage(page);
    await waitFor(() => page.text().includes("Researching"));
    [...page.container.querySelectorAll("button")].find((b) => b.textContent === "Cancel")!.click();
    await waitFor(() => cancel.mock.calls.length === 1);
    expect(page.called("execution.cancel")[0]!.input).toEqual({ runId: RUN_ID });
    await waitFor(() => page.text().includes("Cancelling"));
    page.dispose();
  });
});

// -- reload -----------------------------------------------------------------------------
describe("reloading the page", () => {
  it("reconnects to a run still in flight for an open session", async () => {
    const record = runRecord({ status: "running", progress: screeningProgress() });
    const page = mount({
      handlers: {
        "execution.status": () => ({ ok: true, value: { runs: [runSummary(record)], active: record } }),
        "execution.get": () => ({ ok: true, value: record }),
      },
    });
    // No click: the page itself reconnects.
    await waitFor(() => page.text().includes("Researching"));
    expect(page.called("packages.get")[0]!.input).toEqual({ sessionId: "session-abcdefgh1234" });
    page.dispose();
  });

  it("names a run by the person's words, not by whichever task field came first", async () => {
    const base = runRecord({ status: "cancelled", sessionId: "session-closed000000", endedAt: "2026-09-26T10:05:00.000Z", durationMs: 60_000, origin: "recovered" });
    // A form fills declared defaults first, so a short mode can precede the question.
    const record = { ...base, task: { ...base.task!, input: { seeds: [], documents: {}, mode: "live", question: QUESTION } } };
    const page = mount({
      handlers: {
        "packages.list": () => ({ ok: true, value: { sessions: [], max: 8 } }),
        "execution.status": () => ({ ok: true, value: { runs: [runSummary(record)], active: null } }),
        "execution.get": ({ runId }: { runId: string }) => ({ ok: true, value: runId === RUN_ID ? record : null }),
      },
    });
    await waitFor(() => page.text().includes("Recent runs"));
    const row = page.container.querySelector(".ab-run-list .ab-run-row-task")!;
    expect(row.textContent).toContain(QUESTION.slice(0, 40));
    expect(row.textContent).not.toBe("“live”");
    [...page.container.querySelectorAll(".ab-run-list button")].find((b) => b.textContent === "Open")!.click();
    await waitFor(() => page.container.querySelector(".ab-run-task") !== null);
    expect(page.container.querySelector(".ab-run-task")!.textContent).toBe(`“${QUESTION}”`);
    page.dispose();
  });

  it("shows a finished run whose package session is gone, on its own", async () => {
    const record = runRecord({
      status: "completed",
      sessionId: "session-closed000000",
      endedAt: "2026-09-26T10:40:40.000Z",
      durationMs: 2_440_000,
      origin: "recovered",
    });
    const page = mount({
      handlers: {
        "packages.list": () => ({ ok: true, value: { sessions: [], max: 8 } }),
        "execution.status": () => ({ ok: true, value: { runs: [runSummary(record)], active: null } }),
        "execution.get": ({ runId }: { runId: string }) => ({ ok: true, value: runId === RUN_ID ? record : null }),
      },
    });
    await waitFor(() => page.text().includes("Recent runs"));
    const open = [...page.container.querySelectorAll(".ab-run-list button")].find((b) => b.textContent === "Open")!;
    open.click();
    await waitFor(() => page.text().includes("This run's package session is no longer open"));
    expect(page.text()).toContain("From a previous Gateway session");
    await waitFor(() => page.text().includes("A reverse proxy inspects requests"));
    // Evidence, not authority: no Run and no New run without its session.
    expect(page.runButton()).toBeNull();
    expect([...page.container.querySelectorAll("button")].some((b) => b.textContent === "New run")).toBe(false);
    page.dispose();
  });
});

// -- documents ---------------------------------------------------------------------------
describe("documents", () => {
  it("selects a PDF by path and passes the package only its opaque id", async () => {
    let files: ReturnType<typeof fileCapability>[] = [];
    const selected = vi.fn(() => {
      files = [fileCapability()];
      return { ok: true, value: fileCapability() };
    });
    const page = mount({
      handlers: {
        "files.list": () => ({ ok: true, value: { files } }),
        "files.select-local": selected,
      },
    });
    await openPackage(page);
    const documents = page.container.querySelector<HTMLDetailsElement>("details.ab-form-optional")!;
    documents.open = true;
    [...page.container.querySelectorAll("button")].find((b) => b.textContent === "Add a document")!.click();
    const path = page.container.querySelector<HTMLInputElement>("input[name='document-path']")!;
    path.value = "/papers/defenses.pdf";
    path.closest("form")!.dispatchEvent(new Event("submit"));
    await waitFor(() => selected.mock.calls.length === 1);
    expect(page.called("files.select-local")[0]!.input).toEqual({
      sessionId: "session-abcdefgh1234",
      path: "/papers/defenses.pdf",
    });
    await waitFor(() => page.text().includes("defenses.pdf"));
    const key = page.container.querySelector<HTMLInputElement>("input[aria-label='Documents 1 Paper DOI']")!;
    typeInto(key, "10.1/defense");
    const choice = page.container.querySelector<HTMLSelectElement>("select[aria-label='Documents 1 document']")!;
    choice.value = FILE_ID;
    choice.dispatchEvent(new Event("change"));
    await waitFor(() => page.called("execution.validate-input").some((call) => call.input.input.documents?.["10.1/defense"] === FILE_ID));
    // The task names only the capability; the path is nowhere in it.
    const last = page.called("execution.validate-input").at(-1)!.input.input;
    expect(last.documents).toEqual({ "10.1/defense": FILE_ID });
    expect(JSON.stringify(last)).not.toContain("/papers");
    // files.pdfs is denied in this authorization, so Run says so.
    typeInto(page.container.querySelector<HTMLTextAreaElement>("textarea#ab-field-question")!, QUESTION);
    await waitFor(() => page.text().includes("Documents need the files.pdfs permission")).catch((error) => {
      console.log("DEBUG reason:", page.container.querySelector(".ab-run-reason")?.textContent);
      throw error;
    });
    expect(page.runButton()!.disabled).toBe(true);
    page.dispose();
  });

  it("attaches exactly the referenced files when the permission is granted", async () => {
    const granted = receiptView({
      ...RECEIPT,
      decisions: RECEIPT.decisions.map((item) => (item.permissionId === "files.pdfs" ? { ...item, decision: "session" as const } : item)),
      grantedPermissionIds: [...RECEIPT.grantedPermissionIds, "files.pdfs"],
    });
    const started = vi.fn(() => ({ ok: true, value: runRecord({ status: "running" }) }));
    const page = mount({
      handlers: {
        "packages.authorization": () => ({ ok: true, value: granted }),
        "files.list": () => ({ ok: true, value: { files: [fileCapability(), fileCapability({ fileId: `file_${"9".repeat(32)}`, displayName: "unused.pdf" })] } }),
        "execution.start": started,
        "execution.get": () => ({ ok: true, value: runRecord() }),
      },
    });
    await openPackage(page);
    page.container.querySelector<HTMLDetailsElement>("details.ab-form-optional")!.open = true;
    [...page.container.querySelectorAll("button")].find((b) => b.textContent === "Add a document")!.click();
    typeInto(page.container.querySelector<HTMLInputElement>("input[aria-label='Documents 1 Paper DOI']")!, "10.1/defense");
    const choice = page.container.querySelector<HTMLSelectElement>("select[aria-label='Documents 1 document']")!;
    choice.value = FILE_ID;
    choice.dispatchEvent(new Event("change"));
    typeInto(page.container.querySelector<HTMLTextAreaElement>("textarea#ab-field-question")!, QUESTION);
    await waitFor(() => page.runButton()?.disabled === false);
    page.runButton()!.click();
    await waitFor(() => started.mock.calls.length === 1);
    expect(page.called("execution.start")[0]!.input.files).toEqual([FILE_ID]);
    page.dispose();
  });

  it("flags a document whose capability the host no longer holds", async () => {
    const pkg = literatureView();
    const page = mount({ pkg });
    await openPackage(page);
    const toggle = [...page.container.querySelectorAll("button")].find((b) => b.textContent === "Edit as JSON")!;
    toggle.click();
    typeInto(
      page.container.querySelector<HTMLTextAreaElement>("textarea[aria-label='Task as JSON']")!,
      JSON.stringify({ question: QUESTION, seeds: [], documents: { "10.1/x": FILE_ID }, mode: "live" }),
    );
    [...page.container.querySelectorAll("button")].find((b) => b.textContent === "Edit as form")!.click();
    await waitFor(() => page.text().includes("no longer held by this host"));
    expect(page.runButton()!.disabled).toBe(true);
    page.dispose();
  });

  it("shows the host's refusal of a file that is not a PDF", async () => {
    const page = mount({
      handlers: {
        "files.select-local": () => ({
          ok: false,
          error: { code: "not_allowed", title: "Not a PDF", detail: "Only .pdf files can be selected.", retryable: false },
        }),
      },
    });
    await openPackage(page);
    page.container.querySelector<HTMLDetailsElement>("details.ab-form-optional")!.open = true;
    const path = page.container.querySelector<HTMLInputElement>("input[name='document-path']")!;
    path.value = "/papers/notes.txt";
    path.closest("form")!.dispatchEvent(new Event("submit"));
    await waitFor(() => page.text().includes("Only .pdf files can be selected."));
    expect(page.text()).toContain("That file could not be selected.");
    page.dispose();
  });

  it("offers no document selection when the host has none configured", async () => {
    const page = mount({
      status: serviceStatus({ executionSupported: true, fileSelection: false }),
    });
    await openPackage(page);
    expect(page.text()).toContain("Document selection is not enabled on this host");
    const add = [...page.container.querySelectorAll("button")].find((b) => b.textContent === "Add a document")!;
    expect(add.disabled).toBe(true);
    page.dispose();
  });
});
