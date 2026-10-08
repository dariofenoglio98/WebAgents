/**
 * The full-page agent browser (D-035): an address bar that takes a package URL or a website
 * URL, the website card, the agent page with its authorization flow and run surface (T5), the
 * Runs history, the Trust page, Your data and Settings. A thin view over the service worker;
 * routing is the location hash.
 */
import type { Candidate } from "../../core/discovery.js";
import type { JsonObject } from "../../core/json.js";
import { looksLikePackageUrl } from "../../core/policy.js";
import type { TrustEntry, TrustState } from "../../core/trust.js";
import type { AuthorizationView, ExportBundle, FilesView, ModelsView, RunListView, RunSummary, RunView, SessionDescriptor, SessionView, SettingsView, StatusInfo, VaultView, WebsiteResult } from "../messages.js";
import { renderAgentPage } from "../ui/agent-page.js";
import { bindAuthorization, type AuthorizationController } from "../ui/authorization-flow.js";
import { describeError, send, subscribe } from "../ui/client.js";
import { button, card, chip, el, list, replace, row, whenText } from "../ui/dom.js";
import { newSettingsPageState, refreshProbes, renderSettingsPage, SETTINGS_SECTIONS, type SettingsPageState, type SettingsSection } from "../ui/settings-page.js";
import type { ProviderId } from "../../core/models/catalog.js";
import { renderTrustPage } from "../ui/trust-page.js";
import { newVaultPageState, renderVaultPage, type VaultPageState } from "../ui/vault-page.js";
import { renderWebsiteCard } from "../ui/website.js";
import { mimeFor, renderRunList, RunPanel, saveBlob } from "../ui/run.js";
import { writeZip } from "../ui/zip.js";

type View = "open" | "library" | "runs" | "trust" | "settings" | "data";

interface PageState {
  view: View;
  address: string;
  website: WebsiteResult | null;
  open: SessionView | null;
  authorization: AuthorizationView | null;
  models: ModelsView | null;
  sessions: SessionDescriptor[];
  trust: { entries: TrustEntry[]; state: TrustState } | null;
  status: StatusInfo | null;
  settings: SettingsView | null;
  settingsPage: SettingsPageState;
  /** Settings → Files (T6): the PDFs runs may read. */
  files: FilesView | null;
  vault: VaultView | null;
  vaultPage: VaultPageState;
  busy: string | null;
  error: { code: string; message: string; details: Record<string, unknown> } | null;
  runs: RunListView | null;
  runsNotice: string | null;
  /** The run chosen on the Runs page (`#run=…`), shown under the list; null for the list alone. */
  runsShowing: string | null;
}

const app = document.getElementById("app") as HTMLElement;
/** This page's identity toward the service worker (D-035): a session ends when no view holds it. */
const VIEW_ID = `browser:${crypto.randomUUID()}`;
const state: PageState = {
  view: "open",
  address: "",
  website: null,
  open: null,
  authorization: null,
  models: null,
  sessions: [],
  trust: null,
  status: null,
  settings: null,
  settingsPage: newSettingsPageState(),
  files: null,
  vault: null,
  vaultPage: newVaultPageState(),
  busy: null,
  error: null,
  runs: null,
  runsNotice: null,
  runsShowing: null,
};

/** The authorization flow for the open session (T3). */
const flow: AuthorizationController = bindAuthorization({
  session: () => state.open,
  get: () => state.authorization,
  set: (view) => {
    state.authorization = view;
  },
  models: () => state.models,
  setModels: (models) => {
    state.models = models;
  },
  setBusy: (text) => {
    state.busy = text;
  },
  setError: (error) => {
    state.error = error ? { ...error, details: {} } : null;
  },
  openSettings: (section) => {
    location.hash = section === "data" ? "data" : `settings?section=${section}`;
  },
  rerender: () => render(),
});

/** The run surface (T5) for the open session; on the Runs page it shows one past run read-only. */
const runs = new RunPanel({
  send,
  loaded: () => (state.open ? { session: state.open, authorization: state.authorization } : null),
  reveal: (section) => {
    if (section === "model") location.hash = "settings?section=models";
    else document.querySelector(".ab-authorize")?.scrollIntoView({ block: "start" });
  },
  openFiles: () => {
    location.hash = "settings?section=files";
  },
  changed: () => void load(),
  runChanged: (runId) => {
    // The panel moved to another run on its own (a click in "Earlier runs", an active run
    // adopted): the Runs page keeps showing it and the address names it (review 2, nit 4).
    if (state.view !== "runs" || runId === null || runId === state.runsShowing) return;
    state.runsShowing = runId;
    history.replaceState(null, "", `#run=${encodeURIComponent(runId)}`);
    render();
  },
});
const RUN_VIEW_ID = `run:${crypto.randomUUID()}`;

/** True until the page's first route: only a page that just opened adopts a run in flight. */
let firstRoute = true;

function route(): void {
  const hash = location.hash.replace(/^#/u, "");
  const [view, query] = hash.split("?");
  const params = new URLSearchParams(query ?? "");
  const wasOnModels = state.view === "settings" && state.settingsPage.section === "models";
  const opening = firstRoute;
  firstRoute = false;
  if (view?.startsWith("session=")) {
    state.view = "open";
    void showSession(decodeURIComponent(view.slice("session=".length)));
    return;
  }
  if (view?.startsWith("run=")) {
    // A past run, read-only, with or without its session.
    state.view = "runs";
    state.runsShowing = decodeURIComponent(view.slice("run=".length));
    void openStoredRun(state.runsShowing);
    return;
  }
  state.view = (["open", "library", "runs", "trust", "settings", "data"] as View[]).includes(view as View) ? (view as View) : "open";
  state.runsShowing = null;
  if (state.view === "open") void reattachRuns();
  if (opening && state.view === "open" && !params.get("url")) void adoptRunInFlight();
  if (params.get("url")) state.address = params.get("url")!;
  const section = params.get("section");
  if (state.view === "settings" && (SETTINGS_SECTIONS as readonly string[]).includes(section ?? "")) state.settingsPage.section = section as SettingsSection;
  void load().then(() => {
    // Settings → Models opened: test the enabled connections now, rather than show an old answer.
    // A route that stays on it (the same address again) leaves the results as they are (review 1, nit 6).
    if (state.view === "settings" && state.settingsPage.section === "models" && !wasOnModels) openModels();
  });
}

/** Test one connection; at most one test per provider is in flight, and its chip names when it ran. */
function probeProvider(provider: ProviderId): void {
  if (state.settingsPage.probes[provider] === "running") return;
  state.settingsPage.probes[provider] = "running";
  render();
  send({ type: "models.probe", provider }).then(
    (result) => {
      state.settingsPage.probes[provider] = result as NonNullable<SettingsPageState["probes"][typeof provider]>;
      state.settingsPage.checkedAt[provider] = new Date().toISOString();
      // The chip shows the result now, whatever the follow-up read does (T5a review 2: it stayed at
      // "Testing…" until the settings came back, and a failed read was an unhandled rejection).
      render();
      send<SettingsView>({ type: "settings.get" }).then(
        (settings) => {
          state.settings = settings;
          render();
        },
        (error: unknown) => {
          state.error = describeError(error);
          render();
        },
      );
    },
    (error: unknown) => {
      delete state.settingsPage.probes[provider];
      delete state.settingsPage.checkedAt[provider];
      state.error = describeError(error);
      render();
    },
  );
}

function openModels(): void {
  if (state.settings) refreshProbes(state.settings, state.settingsPage, probeProvider);
  render();
}

async function load(): Promise<void> {
  try {
    if (state.view === "trust") state.trust = await send({ type: "trust.list" });
    if (state.view === "library" || state.view === "open") state.sessions = (await send<{ sessions: SessionDescriptor[] }>({ type: "sessions.list" })).sessions;
    if (state.view === "settings") {
      state.status = await send({ type: "status.get" });
      state.settings = await send({ type: "settings.get" });
      if (state.settingsPage.section === "files") state.files = await send<FilesView>({ type: "files.list" });
    }
    if (state.view === "data") state.vault = await send({ type: "vault.get" });
    if (state.view === "runs") state.runs = await send({ type: "run.list", sessionId: null });
  } catch (error) {
    state.error = describeError(error);
  }
  render();
}

async function showSession(sessionId: string): Promise<void> {
  try {
    state.open = await send<SessionView>({ type: "package.get", sessionId, viewId: VIEW_ID });
    state.error = null;
    if (state.authorization?.session_id !== sessionId) flow.reset();
    await flow.load();
    render();
    await runs.attachSession(sessionId);
    runs.sync();
  } catch (error) {
    state.open = null;
    flow.reset();
    runs.detach();
    state.error = describeError(error);
  }
  render();
}

/**
 * D-076, as in the side panel: a full page opened fresh (no `#session=`, e.g. from the panel's
 * "Open the agent browser") while a run is in flight shows that run's session. Only on the page's
 * first route, so Close followed by `#open` does not bring the session straight back.
 */
async function adoptRunInFlight(): Promise<void> {
  let run: RunView | null;
  try {
    run = await send<RunView | null>({ type: "run.active", pageUrl: null });
  } catch {
    return;
  }
  if (run === null || run.sessionId === null || state.open || state.website || state.busy || state.view !== "open") return;
  history.replaceState(null, "", `#session=${encodeURIComponent(run.sessionId)}`);
  await showSession(run.sessionId);
}

/** The Runs page showed another run on the shared panel: back on the open package, attach its session again (review 1, finding 5). */
async function reattachRuns(): Promise<void> {
  if (!state.open || runs.hasSession()) return;
  await runs.attachSession(state.open.session.id);
  runs.sync();
  render();
}

async function openStoredRun(runId: string): Promise<void> {
  await load();
  await runs.openRun(runId);
  render();
}

async function exportRun(runId: string): Promise<void> {
  state.runsNotice = `Exporting ${runId}…`;
  render();
  try {
    const bundle = await send<ExportBundle>({ type: "run.export", runId });
    const decode = (text: string) => Uint8Array.from(atob(text), (character) => character.charCodeAt(0));
    const zip = writeZip(bundle.entries.map((entry) => ({ name: entry.name, bytes: decode(entry.base64) })));
    const name = `${runId}.zip`;
    const hash = await saveBlob(name, new Blob([zip as BlobPart], { type: mimeFor(name) }));
    state.runsNotice = `Saved ${name} (${bundle.entries.length} files${hash ? `, zip sha256:${hash.slice(0, 16)}…` : ""}).`;
  } catch (error) {
    const described = describeError(error);
    state.runsNotice = `Export failed: ${described.code}: ${described.message}`;
  }
  render();
}

async function clearRun(runId: string): Promise<void> {
  try {
    await send({ type: "run.clear", runId });
    state.runsNotice = `Cleared ${runId}.`;
    if (runs.currentRun()?.runId === runId) runs.detach();
  } catch (error) {
    const described = describeError(error);
    state.runsNotice = `${described.code}: ${described.message}`;
  }
  await load();
}

async function openAddress(address: string): Promise<void> {
  state.address = address;
  state.error = null;
  state.busy = looksLikePackageUrl(address) ? "Downloading and verifying the package…" : "Reading the website…";
  render();
  try {
    if (looksLikePackageUrl(address)) {
      state.open = await send<SessionView>({ type: "package.open", url: address, advertisedOn: null, viewId: VIEW_ID });
      state.website = null;
      location.hash = `session=${encodeURIComponent(state.open.session.id)}`;
    } else {
      state.website = await send<WebsiteResult>({ type: "website.discover", url: address });
      state.open = null;
    }
  } catch (error) {
    state.error = describeError(error);
  } finally {
    state.busy = null;
    render();
  }
}

async function inspect(candidate: Candidate): Promise<void> {
  if (!candidate.resolved_url || !state.website) return;
  state.busy = "Downloading and verifying the package…";
  render();
  try {
    state.open = await send<SessionView>({ type: "package.open", url: candidate.resolved_url, advertisedOn: state.website.final_url, viewId: VIEW_ID });
    state.error = null;
    location.hash = `session=${encodeURIComponent(state.open.session.id)}`;
  } catch (error) {
    state.error = describeError(error);
  } finally {
    state.busy = null;
    render();
  }
}

async function trustSession(scope: "package" | "publisher"): Promise<void> {
  if (!state.open?.page.trust.signer_fingerprint) return;
  try {
    await send({ type: "trust.pin", sessionId: state.open.session.id, signerFingerprint: state.open.page.trust.signer_fingerprint, scope });
    await showSession(state.open.session.id);
  } catch (error) {
    state.error = describeError(error);
    render();
  }
}

function addressBar(): HTMLElement {
  const input = el("input", { className: "ab-input ab-address-input", attrs: { name: "package-url", type: "url", placeholder: "https://… a website, or a package URL ending in .pkg", autocomplete: "off" } });
  input.value = state.address;
  const form = el("form", { className: "ab-address" }, input, button("Open", () => void openAddress(input.value.trim()), { variant: "primary" }));
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    void openAddress(input.value.trim());
  });
  return form;
}

function errorBox(): HTMLElement | null {
  if (!state.error) return null;
  const validation = state.error.details.validation as { errors?: Array<{ layer: string; message: string }> } | undefined;
  return el(
    "div",
    { className: "ab-error", attrs: { role: "alert" } },
    el("strong", { text: state.error.code }),
    " ",
    el("span", { text: state.error.message }),
    validation?.errors ? list(validation.errors.map((item) => `${item.layer}: ${item.message}`)) : null,
  );
}

function openView(): HTMLElement[] {
  const nodes: Array<HTMLElement | null> = [addressBar(), errorBox(), state.busy ? el("p", { className: "ab-busy", text: state.busy }) : null];
  if (state.open) {
    const open = state.open;
    const showRun = state.authorization !== null && state.authorization.receipt !== null;
    nodes.push(
      showRun ? runs.root : null,
      renderAgentPage(open, {
        onTrust: (scope) => void trustSession(scope),
        onClose: () => {
          void send({ type: "package.release", sessionId: open.session.id, viewId: VIEW_ID }).catch(() => undefined);
          state.open = null;
          flow.reset();
          runs.detach();
          location.hash = "open";
          render();
        },
      }),
      flow.render((scope) => void trustSession(scope)),
    );
  } else if (state.website) {
    nodes.push(
      renderWebsiteCard(
        { pageUrl: state.website.final_url, pageOrigin: state.website.page_origin, status: state.website.discovery_status, candidates: state.website.candidates, linksNotListed: state.website.links_not_listed },
        (candidate) => void inspect(candidate),
      ),
    );
  } else if (!state.busy) {
    nodes.push(
      card(
        "Open an agent",
        el("p", { className: "ab-hint", text: "Enter a website address to see which agent package it advertises, or a package address to inspect it directly. Nothing runs until you authorize an agent and press Run." }),
        state.sessions.length > 0 ? el("h4", { text: "Open now" }) : null,
        state.sessions.length > 0 ? list(state.sessions.map((session) => sessionRow(session))) : null,
      ),
    );
  }
  return nodes.filter((node): node is HTMLElement => node !== null);
}

function sessionRow(session: SessionDescriptor): HTMLElement {
  return el(
    "div",
    { className: "ab-session-row" },
    el("a", { text: `${session.name} v${session.version}`, attrs: { href: `#session=${encodeURIComponent(session.session_id)}` } }),
    " ",
    chip(session.trust_status, session.trust_status === "trusted" ? "good" : session.trust_status === "mismatch" ? "bad" : "warn"),
    el("p", { className: "ab-hint", text: `${session.source.display} · opened ${whenText(session.created_at)} · expires ${whenText(session.expires_at)}` }),
  );
}

function libraryView(): HTMLElement[] {
  return [
    card(
      "Library",
      el("p", { className: "ab-hint", text: "Agents open in this browser session; open one to see its authorization, run plan and runs. Past runs stay under Runs after a session ends." }),
      state.sessions.length === 0 ? el("p", { className: "ab-empty", text: "Nothing is open." }) : list(state.sessions.map((session) => sessionRow(session))),
    ),
  ];
}

function runsView(): HTMLElement[] {
  const list = state.runs;
  const current = runs.currentRun();
  const open = (runId: string) => {
    location.hash = `run=${encodeURIComponent(runId)}`;
  };
  return [
    errorBox(),
    card(
      "Runs",
      el("p", { className: "ab-hint", text: "Every run this browser made, newest first, from its own records (IndexedDB). Open one to read its result, artifacts and audit; Export writes the run directory as a zip (run.json, run-plan.json, input.json and every artifact); Clear removes a finished run." }),
      state.runsNotice ? el("div", { className: "ab-banner ab-banner-neutral", attrs: { role: "status" } }, el("span", { text: state.runsNotice })) : null,
      !list ? el("p", { className: "ab-busy", text: "Loading…" }) : list.runs.length === 0 ? el("p", { className: "ab-empty", text: "No run yet. Authorize an agent and press Run." }) : renderRunList(list.runs, { open, export: (runId) => void exportRun(runId), clear: (runId) => void clearRun(runId) }),
    ),
    // The chosen run, whether or not a package is open in this tab (review 1, finding 5).
    current && state.runsShowing === current.runId ? runs.root : null,
  ].filter((node): node is HTMLElement => node !== null);
}

function trustView(): HTMLElement[] {
  if (!state.trust) return [el("p", { className: "ab-busy", text: "Loading…" })];
  return [
    errorBox(),
    renderTrustPage(state.trust.entries, state.trust.state, {
      onUnpin: (fingerprint) => {
        send({ type: "trust.unpin", fingerprint }).then(
          () => void load(),
          (error: unknown) => {
            state.error = describeError(error);
            render();
          },
        );
      },
      onPinKey: (input) => {
        send({ type: "trust.pinKey", ...input }).then(
          () => void load(),
          (error: unknown) => {
            state.error = describeError(error);
            render();
          },
        );
      },
    }),
  ].filter((node): node is HTMLElement => node !== null);
}

function settingsView(): HTMLElement[] {
  if (!state.settings) return [errorBox(), el("p", { className: "ab-busy", text: "Loading…" })].filter((node): node is HTMLElement => node !== null);
  return [
    errorBox(),
    renderSettingsPage(state.settings, state.status, state.settingsPage, {
      onSave: (settings) => {
        send<SettingsView>({ type: "settings.set", settings }).then(
          (saved) => {
            state.settings = saved;
            state.settingsPage.notice = "Saved.";
            render();
          },
          (error: unknown) => {
            state.error = describeError(error);
            render();
          },
        );
      },
      onSetKey: (provider, key) => {
        send<SettingsView>({ type: "settings.setKey", provider, key }).then(
          (saved) => {
            state.settings = saved;
            state.settingsPage.notice = key ? "Key stored in this browser." : "Key removed.";
            render();
          },
          (error: unknown) => {
            state.error = describeError(error);
            render();
          },
        );
      },
      onProbe: (provider) => probeProvider(provider),
      onOpenModels: () => openModels(),
      onPickFiles: () => void pickFiles(),
      onRemoveFile: (fileId) => {
        send<FilesView>({ type: "files.remove", fileId }).then(
          (files) => {
            state.files = files;
            state.settingsPage.notice = "Removed. A run already given it can no longer read it.";
            render();
          },
          (error: unknown) => {
            state.error = describeError(error);
            render();
          },
        );
      },
      rerender: () => {
        if (state.settingsPage.section === "files" && state.files === null) void load();
        render();
      },
    }, state.files),
  ].filter((node): node is HTMLElement => node !== null);
}

/** Read one picked file as base64 for `files.add`; the bytes travel once, to the service worker. */
async function base64Of(file: Blob): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  return btoa(binary);
}

/**
 * Settings → Files → Pick PDFs (T6, D-083): the File System Access picker where Chrome offers it,
 * else a file input. Each picked file is copied into this browser by the service worker; no
 * handle is kept, so a run reads exactly the bytes picked here.
 */
async function pickFiles(): Promise<void> {
  const picker = (window as unknown as { showOpenFilePicker?: (options: unknown) => Promise<Array<{ getFile(): Promise<File> }>> }).showOpenFilePicker;
  let files: File[] = [];
  try {
    if (typeof picker === "function") {
      const handles = await picker({ multiple: true, types: [{ description: "PDF documents", accept: { "application/pdf": [".pdf"] } }], excludeAcceptAllOption: true });
      files = await Promise.all(handles.map((handle) => handle.getFile()));
    } else {
      files = await new Promise<File[]>((resolve) => {
        const input = document.createElement("input");
        input.type = "file";
        input.accept = "application/pdf,.pdf";
        input.multiple = true;
        input.addEventListener("change", () => resolve([...(input.files ?? [])]));
        input.click();
      });
    }
  } catch {
    return; // The person closed the picker.
  }
  let added = 0;
  for (const file of files) {
    try {
      state.files = await send<FilesView>({ type: "files.add", name: file.name, base64: await base64Of(file) });
      added += 1;
    } catch (error) {
      state.error = describeError(error);
    }
  }
  if (added > 0) state.settingsPage.notice = `${added} PDF${added === 1 ? "" : "s"} copied into this browser.`;
  render();
}

function dataView(): HTMLElement[] {
  if (!state.vault) return [errorBox(), el("p", { className: "ab-busy", text: "Loading…" })].filter((node): node is HTMLElement => node !== null);
  const apply = (request: Parameters<typeof send>[0], notice: string) => {
    send<VaultView>(request).then(
      (vault) => {
        state.vault = vault;
        state.vaultPage.editing = null;
        state.vaultPage.notice = { text: notice, tone: "good" };
        state.error = null;
        render();
      },
      (error: unknown) => {
        const described = describeError(error);
        state.vaultPage.notice = { text: `${described.code}: ${described.message}`, tone: "bad" };
        render();
      },
    );
  };
  return [
    errorBox(),
    renderVaultPage(state.vault, state.vaultPage, {
      onPut: (record) => apply({ type: "vault.putRecord", record: record as unknown as JsonObject }, "Saved. A prepared run plan that named this record is now stale."),
      onDelete: (recordId) => apply({ type: "vault.deleteRecord", recordId }, "Deleted."),
      onInstallDemo: () => apply({ type: "vault.installDemo", records: true }, "Fictional demo data added. Every record is marked as such."),
      rerender: () => render(),
    }),
  ].filter((node): node is HTMLElement => node !== null);
}

function render(): void {
  for (const link of document.querySelectorAll<HTMLAnchorElement>(".ab-nav a")) {
    link.classList.toggle("ab-nav-active", link.dataset.view === state.view);
  }
  const children =
    state.view === "open" ? openView() : state.view === "library" ? libraryView() : state.view === "runs" ? runsView() : state.view === "trust" ? trustView() : state.view === "data" ? dataView() : settingsView();
  replace(app, children);
}

subscribe((event) => {
  if (event.type === "event.sessions" || event.type === "event.trust" || event.type === "event.settings" || event.type === "event.vault") void load();
  if (event.type === "event.sessions" && state.open) void showSession(state.open.session.id);
  if (event.type === "event.authorization" && state.open && event.sessionId === state.open.session.id) {
    void flow.load().then(() => {
      render();
      runs.sync();
    });
  }
  if ((event.type === "event.vault" || event.type === "event.settings") && state.open) {
    void flow.load().then(() => {
      render();
      runs.sync();
    });
  }
  if (event.type === "event.run") {
    runs.onRunEvent(event);
    if (state.view === "runs") void load();
  }
  if (event.type === "event.files") {
    runs.onFilesEvent();
    if (state.view === "settings" && state.settingsPage.section === "files") void load();
  }
});
void RUN_VIEW_ID;
window.addEventListener("hashchange", route);
route();
