// @vitest-environment happy-dom
/**
 * The T6 views: Literature Review's task form offers the picked PDFs for its `documents` map (a
 * `selected_files` hint) and writes opaque ids only; Settings → Files lists picks and removes
 * them, Settings → Services saves the Crossref contact, Settings → Policies → Run limits saves
 * typed limits and the long-run preset; and two run-surface carry-overs: a missing plan is named
 * as such in the checklist (Demo 3 rehearsal, F-09), and a late `openRun` reply never replaces a
 * later one (T5 review 3, nit 5).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { DEFAULT_HOST_LIMITS } from "../../src/core/execution/limits.js";
import type { AuthorizationView, AuthorizeResult, FilesView, Request, RunView, SessionView, SettingsView } from "../../src/extension/messages.js";
import type { Settings } from "../../src/extension/storage/settings.js";
import { buildFormModel, hintsFrom, TaskForm } from "../../src/extension/ui/form.js";
import { RunPanel } from "../../src/extension/ui/run.js";
import { LONG_RUN_LIMITS, newSettingsPageState, renderSettingsPage } from "../../src/extension/ui/settings-page.js";
import { ROOT, SHIPPED } from "../helpers/paths.js";
import { readerPackage, READER_URL } from "../helpers/reader-package.js";
import { LITERATURE_URL, makeHarness, PACKAGE_MEDIA_TYPE, PAGE } from "../helpers/shell.js";

const PROBE = new Uint8Array(readFileSync(join(ROOT, "examples", "probe-files", "paper-reader-probe.pdf")));

async function literature() {
  const h = makeHarness();
  const view = (await h.controller.handle({ type: "package.open", url: LITERATURE_URL, advertisedOn: null, viewId: "ui" }, PAGE)) as SessionView;
  await h.controller.handle({ type: "trust.pin", sessionId: view.session.id, signerFingerprint: SHIPPED.literatureReview.fingerprint, scope: "publisher" }, PAGE);
  const session = (await h.controller.handle({ type: "package.get", sessionId: view.session.id }, PAGE)) as SessionView;
  return { h, session };
}

describe("Literature Review's documents field offers the picked PDFs", () => {
  it("renders a document picker over Settings → Files and writes the opaque id, never the name", async () => {
    const { h, session } = await literature();
    const files = ((await h.controller.handle({ type: "files.add", name: "attention-paper.pdf", base64: Buffer.from(PROBE).toString("base64") }, PAGE)) as FilesView).files;
    const model = buildFormModel(session.summary.workflow.input!.document, hintsFrom(session.summary.workflow.presentation));
    const documents = model.fields.find((field) => field.name === "documents")!;
    expect(documents.kind).toBe("files");
    expect(documents.keyLabel).toBe("Paper DOI");
    const values: unknown[] = [];
    let opened = 0;
    const form = new TaskForm(model, null, { canWrite: true, files: () => files, openFiles: () => (opened += 1) }, (value) => values.push(value));
    document.body.append(form.root);
    const add = [...form.root.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Add a document")!;
    expect(add.disabled).toBe(false);
    add.click();
    const key = form.root.querySelector<HTMLInputElement>('input[aria-label="Documents 1 Paper DOI"]')!;
    key.value = "10.1234/example";
    key.dispatchEvent(new Event("input"));
    const select = form.root.querySelector<HTMLSelectElement>('select[aria-label="Documents 1 document"]')!;
    expect([...select.options].map((option) => option.textContent)).toEqual(["Choose a picked PDF…", expect.stringMatching(/^attention-paper\.pdf · 1\.\d KiB$/u)]);
    select.value = files[0]!.file_id;
    select.dispatchEvent(new Event("change"));
    const last = values.at(-1) as { documents?: Record<string, string> };
    expect(last.documents).toEqual({ "10.1234/example": files[0]!.file_id });
    expect(JSON.stringify(values)).not.toContain("attention-paper");
    [...form.root.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Settings → Files")!.click();
    expect(opened).toBe(1);
    form.root.remove();
  });

  it("with no PDF picked, the field says where to pick one and cannot add a row; a removed pick is a local error", async () => {
    const { session } = await literature();
    const model = buildFormModel(session.summary.workflow.input!.document, hintsFrom(session.summary.workflow.presentation));
    let held = [{ file_id: `file_${"a".repeat(32)}`, display_name: "a.pdf", bytes: 10 }];
    const form = new TaskForm(model, { documents: { "10.1/x": `file_${"a".repeat(32)}` } }, { canWrite: true, files: () => held }, () => undefined);
    document.body.append(form.root);
    expect(form.errors().size).toBe(0);
    held = [];
    form.refresh();
    expect([...form.errors().values()]).toEqual(["A chosen document is no longer held by this browser; pick it again in Settings → Files."]);
    expect([...form.root.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Add a document")!.disabled).toBe(true);
    expect(form.root.textContent).toContain("Pick the PDFs a run may read in Settings → Files");
    form.root.remove();
  });
});

describe("Settings → Files, Services and Run limits", () => {
  const settingsOf = async () => {
    const h = makeHarness();
    return { h, view: (await h.controller.handle({ type: "settings.get" }, PAGE)) as SettingsView };
  };

  it("Files lists the picks by name, size and hash, and removes one", async () => {
    const { h, view } = await settingsOf();
    const files = (await h.controller.handle({ type: "files.add", name: "probe.pdf", base64: Buffer.from(PROBE).toString("base64") }, PAGE)) as FilesView;
    const state = newSettingsPageState("files");
    const removed: string[] = [];
    let picks = 0;
    const root = renderSettingsPage(view, null, state, { onSave: () => undefined, onSetKey: () => undefined, onProbe: () => undefined, rerender: () => undefined, onPickFiles: () => (picks += 1), onRemoveFile: (id) => removed.push(id) }, files);
    document.body.append(root);
    expect([...root.querySelectorAll('[role="tab"]')].map((tab) => tab.textContent)).toEqual(["Models", "Policies", "Files", "Services", "About"]);
    const rowNode = root.querySelector<HTMLElement>(`[data-file-id="${files.files[0]!.file_id}"]`)!;
    expect(rowNode.textContent).toContain("probe.pdf");
    expect(rowNode.textContent).toContain(`sha256:${files.files[0]!.sha256.slice(0, 12)}`);
    [...rowNode.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Remove")!.click();
    [...root.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Pick PDFs…")!.click();
    expect([removed, picks]).toEqual([[files.files[0]!.file_id], 1]);
    expect(root.textContent).toContain("1 of 16 files");
    root.remove();
  });

  it("Services saves a trimmed contact or none; Run limits saves typed values, the long-run limits and the defaults", async () => {
    const { view } = await settingsOf();
    const saved: Settings[] = [];
    const actions = { onSave: (next: Settings) => saved.push(next), onSetKey: () => undefined, onProbe: () => undefined, rerender: () => undefined };
    const services = renderSettingsPage(view, null, newSettingsPageState("services"), actions);
    document.body.append(services);
    const contact = services.querySelector<HTMLInputElement>('input[name="crossref-contact"]')!;
    contact.value = "  someone@example.org ";
    [...services.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Save")!.click();
    expect(saved.at(-1)!.services.crossref_contact).toBe("someone@example.org");
    expect(services.textContent).toContain("no contact address");
    services.remove();
    const policies = renderSettingsPage(view, null, newSettingsPageState("policies"), actions);
    document.body.append(policies);
    const timeout = policies.querySelector<HTMLInputElement>('input[name="limit-run_timeout_seconds"]')!;
    expect(timeout.value).toBe(String(DEFAULT_HOST_LIMITS.run_timeout_seconds));
    timeout.value = "900";
    [...policies.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Save limits")!.click();
    expect(saved.at(-1)!.limits).toEqual({ ...DEFAULT_HOST_LIMITS, run_timeout_seconds: 900 });
    [...policies.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Use the long-run limits")!.click();
    expect(saved.at(-1)!.limits).toEqual(LONG_RUN_LIMITS);
    expect([...policies.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Restore the defaults")!.disabled).toBe(true);
    policies.remove();
  });
});

describe("run-surface carry-overs", () => {
  it("without a run plan, the Tools row names the missing plan, not a host implementation (F-09)", async () => {
    const { h, session } = await literature();
    const authorization = (await h.controller.handle({ type: "authorization.get", sessionId: session.session.id }, PAGE)) as AuthorizationView;
    expect(authorization.run_plan).toBeNull();
    const panel = new RunPanel({ send: <T>(request: Request) => h.controller.handle(request, PAGE) as Promise<T>, loaded: () => ({ session, authorization }) });
    document.body.append(panel.root);
    await panel.attachSession(session.session.id);
    const tools = panel.root.querySelector<HTMLElement>('[data-check="tools"]') ?? [...panel.root.querySelectorAll<HTMLElement>("li")].find((node) => node.textContent?.includes("Tools bound"));
    expect(tools?.textContent).toContain("No run plan yet: press Use this agent.");
    expect(panel.root.textContent).not.toContain("Every approved tool needs a host implementation");
    panel.dispose();
    panel.root.remove();
  });

  it("a late reply to an earlier openRun never replaces the run asked for later (nit 5)", async () => {
    // Two real runs of the reader package, then the Runs page asks for the first and, before its
    // reply arrives, for the second.
    const pkg = await readerPackage();
    const h = makeHarness();
    h.routes[READER_URL] = { headers: { "content-type": PACKAGE_MEDIA_TYPE, "content-length": String(pkg.bytes.length) }, body: pkg.bytes };
    const view = (await h.controller.handle({ type: "package.open", url: READER_URL, advertisedOn: null, viewId: "ui" }, PAGE)) as SessionView;
    await h.controller.handle({ type: "trust.pin", sessionId: view.session.id, signerFingerprint: pkg.fingerprint, scope: "publisher" }, PAGE);
    const settings = ((await h.controller.handle({ type: "settings.get" }, PAGE)) as SettingsView).settings;
    settings.models.default_model = "ollama/qwen3:30b";
    await h.controller.handle({ type: "settings.set", settings }, PAGE);
    const file = ((await h.controller.handle({ type: "files.add", name: "probe.pdf", base64: Buffer.from(PROBE).toString("base64") }, PAGE)) as FilesView).files[0]!;
    const runIds: string[] = [];
    for (let index = 0; index < 2; index += 1) {
      const result = (await h.controller.handle({ type: "authorization.authorize", sessionId: view.session.id, packageDigest: pkg.digest, decisions: { "files.pdfs": "session", "model.reasoning": "session", "memory.session": "session" }, toolApprovals: { "paper-reader": true }, resourceSelections: {}, provenance: null, prepare: true }, PAGE)) as AuthorizeResult;
      const plan = result.run_plan!.run_plan;
      runIds.push(((await h.controller.handle({ type: "run.start", sessionId: view.session.id, runPlanId: plan.run_plan_id, runPlanSha256: plan.run_plan_sha256, input: { file_id: file.file_id } }, PAGE)) as RunView).runId);
      await h.host.drain();
    }
    let releaseFirst: (() => void) | null = null;
    const shown: Array<string | null> = [];
    const panel = new RunPanel({
      send: async <T>(request: Request) => {
        if (request.type === "run.get" && request.runId === runIds[0]) await new Promise<void>((resolve) => (releaseFirst = resolve));
        return h.controller.handle(request, PAGE) as Promise<T>;
      },
      loaded: () => null,
      runChanged: (runId) => shown.push(runId),
    });
    const first = panel.openRun(runIds[0]!);
    await panel.openRun(runIds[1]!);
    releaseFirst!();
    await first;
    expect(panel.currentRun()?.runId).toBe(runIds[1]);
    expect(shown).toEqual([runIds[1]]);
    panel.dispose();
  });
});
