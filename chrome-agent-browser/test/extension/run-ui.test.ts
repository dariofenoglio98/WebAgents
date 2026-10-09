// @vitest-environment happy-dom
/**
 * The run surface (T5) over the worker's real answers and the in-process execution host: the
 * task form built from WebAir's input schema, the checklist and the Run gating reasons, a run
 * from the Run button to the rendered result (markdown, artifacts, Technical details), a
 * reconnecting panel adopting the stored run, Cancel while a model call is in flight, the Runs
 * list with Export and Clear, the zip writer the export uses, and the Settings additions (the
 * Ollama commands, the B-117 diagnosis, the test-mode switch).
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { HttpTransport } from "../../src/core/models/transport.js";
import type { AuthorizationView, AuthorizeResult, ProbeView, Request, RunSummary, RunView, SessionView, SettingsView } from "../../src/extension/messages.js";
import { buildFormModel, descriptionAdds, hintsFrom, TaskForm } from "../../src/extension/ui/form.js";
import { formatElapsed, modelFailureFigures, refusalFigures, renderRunList, RunPanel, stagesFor } from "../../src/extension/ui/run.js";
import { newSettingsPageState, OLLAMA_ORIGIN_COMMANDS, renderSettingsPage } from "../../src/extension/ui/settings-page.js";
import { writeZip } from "../../src/extension/ui/zip.js";
import { scriptedOllama, scriptedOrigin, webairModelAnswers } from "../helpers/host.js";
import { ROOT, SHIPPED } from "../helpers/paths.js";
import { makeHarness, PAGE, SITE_ORIGIN, WEBAIR_040_URL, type Harness } from "../helpers/shell.js";
import { listMembers } from "../helpers/zip.js";

const QWEN = "ollama/qwen3:30b";
const SEARCH_TEXT = "Find me a nonstop flight from Boston to Zurich on 9 October under $900.";
/** WebAir's own label for the Run button (`agentpkg:presentation`, `task.run_label`), or the default. */
const RUN_LABEL = "Run WebAir";

async function openWebair(h: Harness): Promise<SessionView> {
  const view = (await h.controller.handle({ type: "package.open", url: WEBAIR_040_URL, advertisedOn: `${SITE_ORIGIN}/`, viewId: "ui" }, PAGE)) as SessionView;
  await h.controller.handle({ type: "trust.pin", sessionId: view.session.id, signerFingerprint: SHIPPED.webair040.fingerprint, scope: "publisher" }, PAGE);
  const settings = ((await h.controller.handle({ type: "settings.get" }, PAGE)) as SettingsView).settings;
  settings.models.default_model = QWEN;
  await h.controller.handle({ type: "settings.set", settings }, PAGE);
  return (await h.controller.handle({ type: "package.get", sessionId: view.session.id }, PAGE)) as SessionView;
}

function scripted(): Harness {
  return makeHarness({ transports: { model: scriptedOllama(webairModelAnswers()).transport, tool: scriptedOrigin().transport } });
}

/** A panel over the controller, as the pages mount it. */
function mountPanel(h: Harness, session: SessionView, options: { compact?: boolean } = {}) {
  let authorization: AuthorizationView | null = null;
  const reveals: string[] = [];
  const panel = new RunPanel({
    send: <T>(request: Request) => h.controller.handle(request, PAGE) as Promise<T>,
    loaded: () => ({ session, authorization }),
    compact: options.compact,
    reveal: (section) => reveals.push(section),
  });
  document.body.append(panel.root);
  const sync = async () => {
    authorization = (await h.controller.handle({ type: "authorization.get", sessionId: session.session.id }, PAGE)) as AuthorizationView;
    panel.sync();
  };
  const text = () => panel.root.textContent ?? "";
  const button = (label: string) => [...panel.root.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent === label);
  const settle = (ms = 420) => new Promise((resolve) => setTimeout(resolve, ms));
  return { panel, sync, text, button, settle, reveals };
}

describe("the task form from the package's input schema", () => {
  it("builds WebAir's fields (a multiline request, a booking checkbox, a purchase object) and reports the person's value", async () => {
    const session = await openWebair(scripted());
    const input = session.summary.workflow.input!;
    const model = buildFormModel(input.document, hintsFrom(session.summary.workflow.presentation));
    expect(model.structured).toBe(true);
    // The bundled schema is canonical (sorted keys); WebAir requires all three fields and defaults two of them.
    expect(model.fields.map((field) => [field.name, field.kind, field.required, field.group])).toEqual([
      ["booking", "boolean", true, "optional"],
      ["purchase", "object", true, "advanced"],
      ["request", "multiline", true, "primary"],
    ]);
    expect(model.fields.find((field) => field.name === "purchase")?.columns.map((column) => column.name)).toEqual(["fare_id", "quote_id"]);
    const values: unknown[] = [];
    const form = new TaskForm(model, null, { canWrite: true }, (value) => values.push(value));
    document.body.append(form.root);
    const request = form.root.querySelector<HTMLTextAreaElement>("textarea#ab-field-request")!;
    expect(request).not.toBeNull();
    request.value = SEARCH_TEXT;
    request.dispatchEvent(new Event("input"));
    const booking = form.root.querySelector<HTMLInputElement>("input#ab-field-booking")!;
    booking.checked = true;
    booking.dispatchEvent(new Event("change"));
    expect(form.current()).toEqual({ booking: true, purchase: { fare_id: "", quote_id: "" }, request: SEARCH_TEXT });
    // The worker's verdicts show beside touched fields; the JSON mode round-trips the value.
    form.showErrors([{ pointer: "/request", message: "is too short" }]);
    expect(form.root.querySelector('[data-field-error="request"]')?.textContent).toBe("is too short");
    expect(form.labelFor("/purchase/quote_id")).toBe("Simulate purchase of a quote (/purchase/quote_id)");
    expect(form.labelFor("")).toBe("The task");
    [...form.root.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent === "Edit as JSON")!.click();
    const area = form.root.querySelector<HTMLTextAreaElement>("textarea.ab-json-editor")!;
    expect(JSON.parse(area.value)).toEqual({ booking: true, purchase: { fare_id: "", quote_id: "" }, request: SEARCH_TEXT });
    area.value = "{ not json";
    area.dispatchEvent(new Event("input"));
    expect(form.errors().get("")).toBe("The task is not valid JSON.");
    expect(form.current()).toBeUndefined();
  });

  it("shows a field's description only when it adds to the placeholder and the label (F-11, D-110)", async () => {
    const session = await openWebair(scripted());
    const model = buildFormModel(session.summary.workflow.input!.document, hintsFrom(session.summary.workflow.presentation));
    const request = model.fields.find((field) => field.name === "request")!;
    // WebAir 0.4.0's description ends with the example the empty box already shows: not repeated.
    expect(request.placeholder).toBe("Find me a flight to Zurich on 9 October under $900.");
    expect(request.description).toBeNull();
    expect(model.fields.find((field) => field.name === "booking")!.description).toMatch(/^Ask WebAir for a booking quote/u);
    const form = new TaskForm(model, null, { canWrite: true }, () => undefined);
    const wrapper = form.root.querySelector("textarea#ab-field-request")!.closest(".ab-field")!;
    expect(wrapper.querySelector(".ab-hint")).toBeNull();
    // The rule itself: an example from `examples[0]` counts as the placeholder; case, quotes, spacing and final punctuation do not matter.
    const schema = { type: "object", properties: { topic: { type: "string", description: "The topic, for example “Multi-agent  LLM systems”.", examples: ["multi-agent LLM systems"] }, note: { type: "string", description: "Note." }, style: { type: "string", description: "One short paragraph, in the tone you would use for a colleague." } } };
    const fields = buildFormModel(schema).fields;
    expect(fields.map((field) => [field.name, field.placeholder, field.description])).toEqual([
      ["topic", "multi-agent LLM systems", null],
      ["note", null, null],
      ["style", null, "One short paragraph, in the tone you would use for a colleague."],
    ]);
    expect(descriptionAdds("Your travel request, in your own words.", "Find me a flight from Boston to Zurich on 9 October under $900", "Request")).toBe(true);
    expect(descriptionAdds("Request", null, "Request")).toBe(false);
    expect(descriptionAdds("   ", "x", "y")).toBe(false);
    expect(descriptionAdds(null, "x", "y")).toBe(false);
  });

  it("groups stages from the graph when the package declares none, and keeps the package's stage hints when it does", () => {
    const nodes = [
      { id: "interpret", type: "llm" },
      { id: "check", type: "validate" },
      { id: "search", type: "tool" },
      { id: "rules", type: "map" },
      { id: "answer", type: "llm" },
      { id: "out", type: "output" },
    ];
    expect(stagesFor(nodes, null).map((stage) => [stage.label, stage.nodes])).toEqual([
      ["Interpret", ["interpret", "check"]],
      ["Search", ["search"]],
      ["Rules", ["rules"]],
      ["Answer", ["answer", "out"]],
    ]);
    const hinted = stagesFor(nodes, { schema: "agentpkg-presentation-v0", task: {}, input: {}, nodes: { interpret: "Understanding" }, stages: [{ label: "Understanding", nodes: ["interpret", "check", "ghost"] }], result: {}, noncritical: true });
    expect(hinted.map((stage) => [stage.label, stage.nodes])).toEqual([
      ["Understanding", ["interpret", "check"]],
      ["Other steps", ["search", "rules", "answer", "out"]],
    ]);
    expect(formatElapsed(65_000)).toBe("01:05");
    expect(formatElapsed(3_725_000)).toBe("1:02:05");
  });
});

describe("the run panel", () => {
  it("lists what is missing before authorization, then runs WebAir from the Run button to the rendered result", async () => {
    const h = scripted();
    const session = await openWebair(h);
    const { panel, sync, text, button, settle } = mountPanel(h, session);
    await panel.attachSession(session.session.id);
    await sync();
    // Before a receipt: the checklist names the first missing condition; Run is disabled with that reason.
    expect(text()).toContain("Permissions authorized — Choose a way to use the agent");
    const run = panel.root.querySelector<HTMLButtonElement>(".ab-run-button")!;
    expect(run.disabled).toBe(true);
    expect(run.textContent).toBe(RUN_LABEL);
    expect(panel.canRun()).toMatchObject({ enabled: false, reason: expect.stringContaining("Choose a way to use the agent") });
    // Authorize through the "Search flights" profile, as the summary card does.
    const result = (await h.controller.handle({ type: "authorization.useProfile", sessionId: session.session.id, packageDigest: SHIPPED.webair040.digest, profileId: "search", resourceSelections: {}, prepare: true }, PAGE)) as AuthorizeResult;
    expect(result.run_plan?.preflight.ready).toBe(true);
    await sync();
    await settle(); // readiness and the task validation round trips
    await settle();
    const checks = [...panel.root.querySelectorAll<HTMLElement>(".ab-checklist li")].map((item) => [item.dataset.check, item.classList.contains("ab-check-ok")]);
    expect(checks).toEqual(expect.arrayContaining([["verified", true], ["trusted", true], ["authorized", true], ["tools", true], ["model", true], ["plan", true], ["receipt", true]]));
    expect(text()).toContain("Tools bound (2 of 2 approved; 5 denied)");
    expect(text()).toContain("Model: qwen3:30b");
    // The empty request does not satisfy WebAir's schema (minLength 1): the exact verdict gates Run, named by the field's label.
    expect(checks).toContainEqual(["task", false]);
    expect(panel.canRun()).toEqual({ enabled: false, reason: "Request must be at least 1 character." });
    const request = panel.root.querySelector<HTMLTextAreaElement>("textarea#ab-field-request")!;
    request.value = SEARCH_TEXT;
    request.dispatchEvent(new Event("input"));
    await settle();
    expect(panel.canRun()).toEqual({ enabled: true, reason: null });
    panel.root.querySelector<HTMLButtonElement>(".ab-run-button")!.click();
    expect(panel.canRun()).toEqual({ enabled: false, reason: "Starting the run…" });
    // The start leases the bytes (hashing, re-digesting every binding) before the record exists.
    for (let attempt = 0; attempt < 300 && panel.root.dataset.state === "idle"; attempt += 1) await settle(10);
    expect(["preparing", "running", "completed"]).toContain(panel.root.dataset.state);
    await h.h_drain();
    // The views learn through event.run; the panel re-reads the record and renders the outcome.
    const events = h.events.filter((event) => event.type === "event.run") as Array<{ runId: string; sessionId: string; status: string }>;
    panel.onRunEvent(events.at(-1)!);
    await settle(100);
    expect(panel.root.dataset.state).toBe("completed");
    expect(text()).toContain("WebAir answered");
    expect(text()).toContain("Finished in");
    // The result: answer.md through the markdown renderer, the summary of the JSON exports, the artifacts and the technical details.
    await settle(100);
    expect(panel.root.querySelector(".ab-result .ab-markdown")?.textContent).toContain("Boston to Zurich");
    // The files are behind Inspect (F-13): closed by default, opened on request.
    expect(panel.root.querySelector(".ab-artifact")).toBeNull();
    button("Inspect")!.click();
    const artifactNames = [...panel.root.querySelectorAll(".ab-artifact code")].map((node) => node.textContent ?? "");
    // Package exports first (in the graph's export order), then the run evidence with run.json last.
    expect(artifactNames.slice(0, 4).sort()).toEqual(["answer.md", "booking.json", "fare-rules.json", "search.json"]);
    expect(artifactNames.slice(4)).toEqual(["result.json", "audit.json", "usage.json", "provenance.json", "run.json"]);
    const technical = panel.root.querySelector(".ab-run-technical")!.textContent ?? "";
    expect(technical).toContain("every call used the planned model");
    expect(technical).toContain("chain valid");
    expect(technical).toContain("Decided by");
    expect(technical).toContain("profile “Search flights”");
    expect(technical).toContain("preflight_ready");
    expect(panel.root.querySelector(".ab-run-head")?.textContent).toContain(`“${SEARCH_TEXT}”`);
    // View an artifact inline, with its hash.
    [...panel.root.querySelectorAll<HTMLButtonElement>("button")].filter((item) => item.textContent === "View")[1]!.click();
    await settle(50);
    expect(panel.root.querySelector(".ab-viewer")?.textContent).toContain("sha256:");
    // New run returns to the form with the checklist.
    button("New run")!.click();
    expect(panel.root.dataset.state).toBe("idle");
    expect(panel.root.querySelector("textarea#ab-field-request")).not.toBeNull();
    panel.dispose();
  });

  it("a reopened panel adopts the stored run (reconnect after close), and a past run opens read-only without its session", async () => {
    const h = scripted();
    const session = await openWebair(h);
    const result = (await h.controller.handle({ type: "authorization.useProfile", sessionId: session.session.id, packageDigest: SHIPPED.webair040.digest, profileId: "search", resourceSelections: {}, prepare: true }, PAGE)) as AuthorizeResult;
    const plan = result.run_plan!.run_plan;
    const started = (await h.controller.handle({ type: "run.start", sessionId: session.session.id, runPlanId: plan.run_plan_id, runPlanSha256: plan.run_plan_sha256, input: { request: SEARCH_TEXT, booking: false, purchase: { quote_id: "", fare_id: "" } } }, PAGE)) as RunView;
    await h.h_drain();
    // A panel opened afterwards (the side panel closed and reopened) shows that run at once.
    const again = mountPanel(h, session, { compact: true });
    await again.panel.attachSession(session.session.id);
    await again.settle(100);
    expect(again.panel.currentRun()?.runId).toBe(started.runId);
    expect(again.panel.root.dataset.state).toBe("completed");
    expect(again.panel.root.classList.contains("ab-run-compact")).toBe(true);
    // The Runs page: a run opened without its session is read-only and says so.
    const closed = new RunPanel({ send: <T>(request: Request) => h.controller.handle(request, PAGE) as Promise<T>, loaded: () => null });
    await h.controller.handle({ type: "package.close", sessionId: session.session.id }, PAGE);
    await closed.openRun(started.runId);
    expect(closed.root.dataset.state).toBe("completed");
    expect(closed.root.textContent).toContain("no longer open");
    expect([...closed.root.querySelectorAll("button")].map((item) => item.textContent)).not.toContain("New run");
    expect(closed.root.querySelector(".ab-run-button")).toBeNull();
    expect(closed.root.querySelector(".ab-run-technical")?.textContent).toContain("profile search");
    again.panel.dispose();
    closed.dispose();
  });

  it("opening another package's run drops the attached session's earlier runs and readiness (review 2, nit 5)", async () => {
    const h = scripted();
    const session = await openWebair(h);
    const run = async (sessionId: string, profileId: "search"): Promise<RunView> => {
      const result = (await h.controller.handle({ type: "authorization.useProfile", sessionId, packageDigest: SHIPPED.webair040.digest, profileId, resourceSelections: {}, prepare: true }, PAGE)) as AuthorizeResult;
      const plan = result.run_plan!.run_plan;
      const started = (await h.controller.handle({ type: "run.start", sessionId, runPlanId: plan.run_plan_id, runPlanSha256: plan.run_plan_sha256, input: { request: SEARCH_TEXT, booking: false, purchase: { quote_id: "", fare_id: "" } } }, PAGE)) as RunView;
      await h.h_drain();
      return started;
    };
    // Two runs of this session, so its panel lists an earlier one; and one run of a second session of the same package.
    await run(session.session.id, "search");
    await run(session.session.id, "search");
    const other = (await h.controller.handle({ type: "package.open", url: WEBAIR_040_URL, advertisedOn: `${SITE_ORIGIN}/`, viewId: "other" }, PAGE)) as SessionView;
    expect(other.session.id).not.toBe(session.session.id);
    const foreign = await run(other.session.id, "search");
    const mounted = mountPanel(h, session);
    await mounted.sync();
    await mounted.panel.attachSession(session.session.id);
    await mounted.settle(200);
    expect(mounted.text()).toContain("Earlier runs of this agent (1)");
    mounted.button("New run")!.click();
    await mounted.settle(200);
    expect(mounted.panel.root.querySelector(".ab-run-checklist")!.textContent, "the attached session's readiness checklist").not.toBe("");
    // The Runs page opens the other session's run on this panel: nothing of the attached session applies to it.
    await mounted.panel.openRun(foreign.runId);
    await mounted.settle(100);
    expect(mounted.panel.currentRun()?.runId).toBe(foreign.runId);
    expect(mounted.panel.hasSession()).toBe(false);
    expect(mounted.text()).not.toContain("Earlier runs of this agent");
    expect(mounted.panel.root.querySelector(".ab-run-checklist")!.textContent).toBe("");
    mounted.panel.dispose();
  });

  it("Download verifies the bytes against the hash the run recorded, not only against the worker's recomputation (review 1, nit 9)", async () => {
    const h = scripted();
    const session = await openWebair(h);
    const result = (await h.controller.handle({ type: "authorization.useProfile", sessionId: session.session.id, packageDigest: SHIPPED.webair040.digest, profileId: "search", resourceSelections: {}, prepare: true }, PAGE)) as AuthorizeResult;
    const plan = result.run_plan!.run_plan;
    const started = (await h.controller.handle({ type: "run.start", sessionId: session.session.id, runPlanId: plan.run_plan_id, runPlanSha256: plan.run_plan_sha256, input: { request: SEARCH_TEXT, booking: false, purchase: { quote_id: "", fare_id: "" } } }, PAGE)) as RunView;
    await h.h_drain();
    const { panel, settle } = mountPanel(h, session);
    await panel.attachSession(session.session.id);
    await settle(100);
    expect(panel.root.dataset.state).toBe("completed");
    [...panel.root.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent === "Inspect")!.click();
    const downloadOf = (name: string) => [...panel.root.querySelectorAll<HTMLElement>(".ab-artifact")].find((row) => row.querySelector("code")?.textContent === name)!.querySelector<HTMLButtonElement>("button:last-of-type")!;
    // The saved file is what the browser's download sees; the note names the record as the reference.
    const saved: string[] = [];
    URL.createObjectURL = () => "blob:test";
    URL.revokeObjectURL = () => undefined;
    HTMLAnchorElement.prototype.click = function click(this: HTMLAnchorElement) {
      saved.push(this.download);
    };
    downloadOf("search.json").click();
    await settle(100);
    expect(saved).toEqual(["search.json"]);
    expect(panel.root.textContent).toContain("SHA-256 verified against the run record");
    // The stored bytes change after the host wrote them (the record keeps the hash it recorded): the download is refused.
    const stored = h.runs.artifacts.get(`${started.runId}/search.json`)!;
    stored.bytes = new TextEncoder().encode(JSON.stringify({ tampered: true }));
    downloadOf("search.json").click();
    await settle(100);
    expect(saved).toEqual(["search.json"]);
    expect(panel.root.textContent).toContain("do not match the SHA-256 the run recorded");
    panel.dispose();
  });

  it("a finished run shows its files collapsed; Inspect opens the list; Download saves one verified zip of every file (F-13, D-112)", async () => {
    const h = scripted();
    const session = await openWebair(h);
    const result = (await h.controller.handle({ type: "authorization.useProfile", sessionId: session.session.id, packageDigest: SHIPPED.webair040.digest, profileId: "search", resourceSelections: {}, prepare: true }, PAGE)) as AuthorizeResult;
    const plan = result.run_plan!.run_plan;
    const started = (await h.controller.handle({ type: "run.start", sessionId: session.session.id, runPlanId: plan.run_plan_id, runPlanSha256: plan.run_plan_sha256, input: { request: SEARCH_TEXT, booking: false, purchase: { quote_id: "", fare_id: "" } } }, PAGE)) as RunView;
    await h.h_drain();
    const { panel, settle, button } = mountPanel(h, session);
    await panel.attachSession(session.session.id);
    await settle(100);
    expect(panel.root.dataset.state).toBe("completed");
    // The result summary stays open; the files are a count and two buttons.
    expect(panel.root.querySelector(".ab-result-summary")).not.toBeNull();
    expect(panel.root.querySelector(".ab-artifact")).toBeNull();
    expect(panel.root.querySelector(".ab-artifacts-counts")?.textContent).toBe("4 package exports · 5 evidence files");
    const inspect = () => panel.root.querySelector<HTMLButtonElement>(".ab-artifacts-inspect")!;
    expect([inspect().textContent, inspect().getAttribute("aria-expanded")]).toEqual(["Inspect", "false"]);
    inspect().click();
    expect([inspect().textContent, inspect().getAttribute("aria-expanded")]).toEqual(["Hide files", "true"]);
    expect([...panel.root.querySelectorAll(".ab-artifact-files h4")].map((node) => node.textContent)).toEqual(["Package exports", "Run evidence"]);
    expect(panel.root.querySelectorAll(".ab-artifact")).toHaveLength(9);
    inspect().click();
    expect(panel.root.querySelector(".ab-artifact")).toBeNull();
    // Download: one zip named after the run, every listed file under exports/ and evidence/, run.json at the top.
    const saved: Array<{ name: string; blob: Blob }> = [];
    let pendingBlob: Blob | null = null;
    URL.createObjectURL = (blob: Blob) => {
      pendingBlob = blob;
      return "blob:test";
    };
    URL.revokeObjectURL = () => undefined;
    HTMLAnchorElement.prototype.click = function click(this: HTMLAnchorElement) {
      saved.push({ name: this.download, blob: pendingBlob! });
    };
    panel.root.querySelector<HTMLButtonElement>(".ab-artifacts-download")!.click();
    for (let attempt = 0; attempt < 100 && saved.length === 0; attempt += 1) await settle(20);
    expect(saved.map((item) => item.name)).toEqual([`${started.runId}.zip`]);
    const zip = new Uint8Array(await saved[0]!.blob.arrayBuffer());
    const record = (await h.controller.handle({ type: "run.get", runId: started.runId }, PAGE)) as RunView;
    const exports = record.artifacts.filter((item) => !["result.json", "audit.json", "usage.json", "provenance.json", "run.json"].includes(item.name)).map((item) => item.name);
    const expected = ["run.json", ...exports.map((name) => `exports/${name}`), ...["result.json", "audit.json", "usage.json", "provenance.json"].map((name) => `evidence/${name}`)];
    expect([...listMembers(zip).keys()]).toEqual(expected);
    expect(exports.sort()).toEqual(["answer.md", "booking.json", "fare-rules.json", "search.json"]);
    // Read back by an independent reader (Python's zipfile, from the agentpkg venv the suite already needs): valid, every CRC right, the same names and bytes.
    const scratch = mkdtempSync(join(realpathSync(tmpdir()), "t9-zip-"));
    try {
      const path = join(scratch, `${started.runId}.zip`);
      writeFileSync(path, zip);
      const python = process.env.AGENTPKG_PYTHON ?? join(ROOT, "agentpkg", ".venv", "bin", "python");
      const read = JSON.parse(execFileSync(python, ["-I", "-c", "import hashlib, json, sys, zipfile\nz = zipfile.ZipFile(sys.argv[1])\nprint(json.dumps({'bad': z.testzip(), 'names': z.namelist(), 'sha256': {n: hashlib.sha256(z.read(n)).hexdigest() for n in z.namelist()}}))", path], { encoding: "utf8" })) as { bad: string | null; names: string[]; sha256: Record<string, string> };
      expect(read.bad).toBeNull();
      expect(read.names).toEqual(expected);
      for (const item of record.artifacts.filter((artifact) => artifact.name !== "run.json")) {
        expect(read.sha256[exports.includes(item.name) ? `exports/${item.name}` : `evidence/${item.name}`], item.name).toBe(item.sha256);
      }
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
    expect(panel.root.textContent).toContain(`Saved ${started.runId}.zip (9 files`);
    // A file whose stored bytes no longer match the record stops the zip; nothing is saved.
    h.runs.artifacts.get(`${started.runId}/search.json`)!.bytes = new TextEncoder().encode("{}");
    button("Download")!.click();
    await settle(200);
    expect(saved).toHaveLength(1);
    expect(panel.root.textContent).toContain("Download failed: The stored bytes of search.json do not match the SHA-256 the run recorded");
    panel.dispose();
  });

  it("a model call refused for its context window says so, with the figures from the audit, not 'a budget limit' (T9)", async () => {
    const h = scripted();
    const session = await openWebair(h);
    // The smallest context WebAir accepts (16,000): its first request, counted as one token per byte plus 6,000 for the answer, does not fit.
    const settings = ((await h.controller.handle({ type: "settings.get" }, PAGE)) as SettingsView).settings;
    settings.models.connections = settings.models.connections.map((connection) => (connection.provider === "ollama" ? { ...connection, overrides: { "qwen3:30b": { context_tokens: 16000 } } } : connection));
    await h.controller.handle({ type: "settings.set", settings }, PAGE);
    const result = (await h.controller.handle({ type: "authorization.useProfile", sessionId: session.session.id, packageDigest: SHIPPED.webair040.digest, profileId: "search", resourceSelections: {}, prepare: true }, PAGE)) as AuthorizeResult;
    const plan = result.run_plan!.run_plan;
    const started = (await h.controller.handle({ type: "run.start", sessionId: session.session.id, runPlanId: plan.run_plan_id, runPlanSha256: plan.run_plan_sha256, input: { request: SEARCH_TEXT, booking: false, purchase: { quote_id: "", fare_id: "" } } }, PAGE)) as RunView;
    await h.h_drain();
    const record = (await h.controller.handle({ type: "run.get", runId: started.runId }, PAGE)) as RunView;
    expect([record.status, record.errorCode, record.failure?.call?.action, record.failure?.call?.reason]).toEqual(["failed", "budget_exhausted", "model.refused", "context_window"]);
    const { panel, settle } = mountPanel(h, session);
    await panel.attachSession(session.session.id);
    await settle(200);
    const banner = panel.root.querySelector(".ab-outcome .ab-banner")!;
    expect(banner.querySelector("strong")?.textContent).toBe("The request was larger than the model's context window");
    expect(banner.textContent).toContain("budget_exhausted"); // the code is still shown
    expect(banner.textContent).toContain("raise its context in Settings → Models");
    expect(banner.textContent).not.toContain("A budget limit was reached");
    expect(banner.querySelector(".ab-refusal-figures")?.textContent).toMatch(/^Reserved [\d,]+ tokens \(the request counted as [\d,]+, plus 6,000 for the answer\); the model's context is 16,000\.$/u);
    panel.dispose();
  });

  it("modelFailureFigures says how a rejected answer ended and where it broke the schema (the Luna runs of 2026-10-09)", () => {
    const webair = [{ action: "model.failed", task: "interpret", reason: "model_output_not_conforming", failure_facts: { stop_reason: "stop", reported_input_tokens: 2442, reported_output_tokens: 60, output_failure: "schema", schema_keyword: "pattern", schema_location: "$defs/s27/properties/search/properties/date/pattern", schema_violations: 1 } }];
    expect(modelFailureFigures(webair)).toBe("The answer was complete (it stopped normally after 60 output tokens): this is not a token limit. It broke the schema's “pattern” rule at search.date.");
    const review = { events: [{ action: "model.failed", task: "normalize", reason: "model_output_not_conforming", failure_facts: { stop_reason: "stop", reported_output_tokens: 8965, output_failure: "schema", schema_keyword: "required", schema_location: "$defs/s15/required", schema_violations: 8 } }] };
    expect(modelFailureFigures(review)).toBe("The answer was complete (it stopped normally after 8,965 output tokens): this is not a token limit. It broke the schema's “required” rule (8 violations in all).");
    expect(modelFailureFigures([{ action: "model.failed", reason: "model_output_truncated", failure_facts: { stop_reason: "length", reported_output_tokens: 6000 } }])).toBe("It stopped at its output limit after 6,000 output tokens.");
    expect(modelFailureFigures([{ action: "model.failed", reason: "model_output_not_conforming", failure_facts: { stop_reason: "stop", output_failure: "not_json" } }])).toBe("The answer was complete (it stopped normally): this is not a token limit. It was not a single JSON document.");
    expect(modelFailureFigures([{ action: "model.called" }])).toBeNull();
  });

  it("a run whose model answer broke the package's schema says so on the panel, with the field (T9)", async () => {
    // The scripted model answers interpret with a date that breaks the plan schema's pattern.
    const answers = webairModelAnswers();
    const interpret = answers.interpret!;
    const h = makeHarness({ transports: { model: scriptedOllama({ ...answers, interpret: (user, system) => { const plan = interpret(user, system) as { search: Record<string, unknown> }; return { ...plan, search: { ...plan.search, date: "9 October 2026" } }; } }).transport, tool: scriptedOrigin().transport } });
    const session = await openWebair(h);
    const result = (await h.controller.handle({ type: "authorization.useProfile", sessionId: session.session.id, packageDigest: SHIPPED.webair040.digest, profileId: "search", resourceSelections: {}, prepare: true }, PAGE)) as AuthorizeResult;
    const plan = result.run_plan!.run_plan;
    await h.controller.handle({ type: "run.start", sessionId: session.session.id, runPlanId: plan.run_plan_id, runPlanSha256: plan.run_plan_sha256, input: { request: SEARCH_TEXT, booking: false, purchase: { quote_id: "", fare_id: "" } } }, PAGE);
    await h.h_drain();
    const { panel, settle } = mountPanel(h, session);
    await panel.attachSession(session.session.id);
    await settle(200);
    const banner = panel.root.querySelector(".ab-outcome .ab-banner")!;
    expect(banner.querySelector("strong")?.textContent).toBe("The model's answer did not match the package's format");
    expect(banner.textContent).toContain("model_error");
    expect(banner.querySelector(".ab-refusal-figures")?.textContent).toMatch(/this is not a token limit\. It broke the schema's “pattern” rule at search\.date\.$/u);
    panel.dispose();
  });

  it("refusalFigures reads the refused call's numbers (the Literature Review run of 2026-10-09)", () => {
    const audit = [{ action: "model.called", task: "plan", reserved_tokens: 14916 }, { action: "model.refused", task: "normalize", reason: "context_window", input_bound: 18917, max_output_tokens: 16000, reserved_tokens: 34917, context_window: 32700 }];
    expect(refusalFigures(audit)).toBe("Reserved 34,917 tokens (the request counted as 18,917, plus 16,000 for the answer); the model's context is 32,700.");
    expect(refusalFigures({ events: [{ action: "model.refused", reason: "global_token_budget", input_bound: 10, max_output_tokens: 5, reserved_tokens: 15, used_tokens: 119990, limit: 120000 }] })).toBe("Reserved 15 tokens (the request counted as 10, plus 5 for the answer); 119,990 already used of 120,000.");
    expect(refusalFigures([{ action: "model.called" }])).toBeNull();
    expect(refusalFigures(null)).toBeNull();
  });

  it("a session with a run in flight is never ended to make room for another (T9)", async () => {
    const hanging: HttpTransport = (request) => new Promise((_resolve, reject) => request.signal.addEventListener("abort", () => reject(request.signal.reason), { once: true }));
    const h = makeHarness({ limits: { maxSessions: 1 }, transports: { model: hanging, tool: scriptedOrigin().transport } });
    // Opened without a view, so only its run can keep it.
    const session = (await h.controller.handle({ type: "package.open", url: WEBAIR_040_URL, advertisedOn: `${SITE_ORIGIN}/` }, PAGE)) as SessionView;
    await h.controller.handle({ type: "trust.pin", sessionId: session.session.id, signerFingerprint: SHIPPED.webair040.fingerprint, scope: "publisher" }, PAGE);
    const settings = ((await h.controller.handle({ type: "settings.get" }, PAGE)) as SettingsView).settings;
    settings.models.default_model = QWEN;
    await h.controller.handle({ type: "settings.set", settings }, PAGE);
    const result = (await h.controller.handle({ type: "authorization.useProfile", sessionId: session.session.id, packageDigest: SHIPPED.webair040.digest, profileId: "search", resourceSelections: {}, prepare: true }, PAGE)) as AuthorizeResult;
    const plan = result.run_plan!.run_plan;
    const started = (await h.controller.handle({ type: "run.start", sessionId: session.session.id, runPlanId: plan.run_plan_id, runPlanSha256: plan.run_plan_sha256, input: { request: SEARCH_TEXT, booking: false, purchase: { quote_id: "", fare_id: "" } } }, PAGE)) as RunView;
    const other = h.controller.handle({ type: "package.open", url: WEBAIR_040_URL, advertisedOn: null }, PAGE);
    await expect(other).rejects.toMatchObject({ code: "session_limit_reached" });
    await h.controller.handle({ type: "run.cancel", runId: started.runId }, PAGE);
    await h.h_drain();
    // Settled: the session is no longer needed by a run and makes room.
    const opened = (await h.controller.handle({ type: "package.open", url: WEBAIR_040_URL, advertisedOn: null }, PAGE)) as SessionView;
    expect(opened.session.id).not.toBe(session.session.id);
  });

  it("Cancel is offered while a run is in flight and the panel settles as cancelled", async () => {
    let reached = 0;
    const hanging: HttpTransport = (request) =>
      new Promise((_resolve, reject) => {
        reached += 1;
        request.signal.addEventListener("abort", () => reject(request.signal.reason), { once: true });
      });
    const h = makeHarness({ transports: { model: hanging, tool: scriptedOrigin().transport } });
    const session = await openWebair(h);
    const result = (await h.controller.handle({ type: "authorization.useProfile", sessionId: session.session.id, packageDigest: SHIPPED.webair040.digest, profileId: "search", resourceSelections: {}, prepare: true }, PAGE)) as AuthorizeResult;
    const plan = result.run_plan!.run_plan;
    const started = (await h.controller.handle({ type: "run.start", sessionId: session.session.id, runPlanId: plan.run_plan_id, runPlanSha256: plan.run_plan_sha256, input: { request: SEARCH_TEXT, booking: false, purchase: { quote_id: "", fare_id: "" } } }, PAGE)) as RunView;
    for (let attempt = 0; attempt < 200 && reached === 0; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 10));
    // Wait for the first checkpoint (node.started interpret) to be written.
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const current = (await h.controller.handle({ type: "run.get", runId: started.runId }, PAGE)) as RunView;
      if (current.progress && current.progress.active_nodes.length > 0) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const { panel, button, settle, text } = mountPanel(h, session);
    await panel.attachSession(session.session.id);
    await settle(50);
    expect(panel.currentRun()?.runId).toBe(started.runId);
    expect(panel.root.dataset.state).toBe("running");
    expect(text()).toContain("elapsed");
    expect(panel.root.querySelector(".ab-stage-active")?.textContent).toContain("Understanding");
    button("Cancel")!.click();
    await settle(50);
    expect(button("Cancelling…")).toBeDefined();
    await h.h_drain();
    panel.onRunEvent({ runId: started.runId, sessionId: session.session.id, status: "cancelled" });
    await settle(50);
    expect(panel.root.dataset.state).toBe("cancelled");
    expect(text()).toContain("Run cancelled");
    panel.dispose();
  });
});

describe("the Runs list and the export", () => {
  it("renders runs newest first with Open, Export and Clear for finished runs only", () => {
    const summary = (runId: string, status: RunSummary["status"]): RunSummary => ({ runId, sessionId: "s", runPlanId: "p", status, createdAt: "2026-10-07T10:00:00Z", endedAt: null, durationMs: status === "running" ? null : 12_000, package: { packageId: "org.webagents.webair", name: "WebAir Travel Agent", version: "0.4.0" }, selectedModel: QWEN, cancelRequested: false, errorCode: null, taskText: "Find me a flight" });
    const opened: string[] = [];
    const exported: string[] = [];
    const cleared: string[] = [];
    const list = renderRunList([summary("run_b", "running"), summary("run_a", "completed")], { open: (id) => opened.push(id), export: (id) => exported.push(id), clear: (id) => cleared.push(id) });
    const rows = [...list.querySelectorAll<HTMLElement>(".ab-run-row")];
    expect(rows.map((row) => row.dataset.run)).toEqual(["run_b", "run_a"]);
    expect([...rows[0]!.querySelectorAll("button")].map((item) => item.textContent)).toEqual(["Open"]);
    expect([...rows[1]!.querySelectorAll("button")].map((item) => item.textContent)).toEqual(["Open", "Export", "Clear"]);
    [...rows[1]!.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent === "Export")!.click();
    expect(exported).toEqual(["run_a"]);
    expect(list.textContent).toContain("“Find me a flight”");
  });

  it("writes a STORED zip the strict reader accepts, byte-identical for the same files (D-073)", () => {
    const files = [
      { name: "run.json", bytes: new TextEncoder().encode('{"a":1}\n') },
      { name: "answer.md", bytes: new TextEncoder().encode("# Hello\n") },
    ];
    const zip = writeZip(files);
    expect(writeZip(files)).toEqual(zip);
    const members = listMembers(zip);
    expect([...members.keys()]).toEqual(["run.json", "answer.md"]);
    expect(new TextDecoder().decode(members.get("answer.md"))).toBe("# Hello\n");
  });
});

describe("Settings → Models additions (T5)", () => {
  it("shows the OLLAMA_ORIGINS commands with Copy, the B-117 diagnosis of a failed probe, and the test-mode switch under About", async () => {
    const h = makeHarness({ http: { "GET http://127.0.0.1:11434/api/tags": { status: 0, body: null } } });
    const copied: string[] = [];
    const saved: unknown[] = [];
    const state = newSettingsPageState();
    let view = (await h.controller.handle({ type: "settings.get" }, PAGE)) as SettingsView;
    const render = () => renderSettingsPage(view, null, state, { onSave: (next) => saved.push(next), onSetKey: () => undefined, onProbe: () => undefined, rerender: () => undefined, copy: async (text) => void copied.push(text) });
    let root = render();
    expect(root.textContent).toContain("Allow this extension in Ollama (once)");
    const commands = [...root.querySelectorAll(".ab-command-text")].map((node) => node.textContent);
    expect(commands).toEqual(OLLAMA_ORIGIN_COMMANDS.map((entry) => entry.command));
    expect(commands[0]).toBe('launchctl setenv OLLAMA_ORIGINS "chrome-extension://*"');
    [...root.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent === "Copy")!.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(copied).toEqual([commands[0]]);
    // A failed probe with the diagnosis the worker computed (here: nothing answers).
    const probe = await h.controller.probe("ollama");
    expect(probe.ok).toBe(false);
    expect(probe.diagnosis).toMatchObject({ state: "unknown" });
    state.probes.ollama = { ...probe, diagnosis: { state: "rejecting_origin", hint: "Ollama is running but rejects this extension's origin." } } as ProbeView;
    root = render();
    expect(root.querySelector<HTMLElement>(".ab-diagnosis")?.dataset.diagnosis).toBe("rejecting_origin");
    expect(root.textContent).toContain("rejects this extension's origin");
    // The built-in card says the Prompt API is not exposed in this (test) context.
    expect(root.textContent).toContain("not exposed in this Chrome");
    // About: the test-mode switch saves the developer setting.
    state.section = "about";
    root = render();
    const toggle = root.querySelector<HTMLInputElement>('input[name="developer-record-requests"]')!;
    expect(toggle.checked).toBe(false);
    toggle.checked = true;
    toggle.dispatchEvent(new Event("change"));
    expect((saved.at(-1) as SettingsView["settings"]).developer.record_requests).toBe(true);
    view = (await h.controller.handle({ type: "settings.set", settings: saved.at(-1) }, PAGE)) as SettingsView;
    expect(view.settings.developer.record_requests).toBe(true);
  });

  it("the worker tells 'not running' apart from 'rejecting this origin' when the shell can probe reachability", async () => {
    const down = makeHarness({ http: { "GET http://127.0.0.1:11434/api/tags": { status: 0, body: null } } });
    (down.controller as unknown as { deps: { reachable?: (url: string) => Promise<boolean> } }).deps.reachable = async () => false;
    expect((await down.controller.probe("ollama")).diagnosis).toMatchObject({ state: "not_running" });
    const rejecting = makeHarness({ http: { "GET http://127.0.0.1:11434/api/tags": { status: 0, body: null } } });
    (rejecting.controller as unknown as { deps: { reachable?: (url: string) => Promise<boolean> } }).deps.reachable = async () => true;
    const diagnosis = (await rejecting.controller.probe("ollama")).diagnosis;
    expect(diagnosis).toMatchObject({ state: "rejecting_origin" });
    expect(diagnosis?.hint).toContain("OLLAMA_ORIGINS");
    expect((await rejecting.controller.probe("openai")).diagnosis).toBeNull();
  });
});
