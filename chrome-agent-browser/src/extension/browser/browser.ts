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
import type { AuthorizationView, ExportBundle, FilesView, IndexesView, LibraryItemView, LibraryView, ModelsView, PermissionsView, PolicyView, RunListView, RunSummary, RunView, SearchResultView, SearchView, SecretsView, KeychainView, SessionDescriptor, SessionView, SettingsView, StatusInfo, MemoryView, WebsiteResult } from "../messages.js";
import { addressKind } from "../../core/resolve/types.js";
import { renderFoundVia, renderLibrary, renderSearchResults } from "../ui/search.js";
import { renderAgentPage } from "../ui/agent-page.js";
import { bindAuthorization, type AuthorizationController } from "../ui/authorization-flow.js";
import { describeError, originOfUrl, refusedOrigins, requestNativeMessaging, requestOrigins, send, subscribe } from "../ui/client.js";
import { needsUnlock, newUnlockState, renderLockChip, renderUnlockSheet, type UnlockState } from "../ui/unlock.js";
import { button, card, chip, el, list, replace, row, whenText } from "../ui/dom.js";
import { newSettingsPageState, refreshProbes, renderSettingsPage, SETTINGS_SECTIONS, type SettingsPageState, type SettingsSection } from "../ui/settings-page.js";
import type { ProviderId } from "../../core/models/catalog.js";
import { renderTrustPage } from "../ui/trust-page.js";
import { newMemoryPageState, renderMemoryPage, renderMemorySettings, type MemoryPageState } from "../ui/memory/page.js";
import { renderMemoryGraph } from "../ui/memory/graph.js";
import { renderWebsiteCard } from "../ui/website.js";
import { mimeFor, renderRunList, RunPanel, saveBlob } from "../ui/run.js";
import { writeZip } from "../ui/zip.js";

type View = "open" | "library" | "runs" | "trust" | "settings" | "memory";

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
  /** The Memory page (T19): the worker's view and the page's own UI state. */
  memory: MemoryView | null;
  memoryPage: MemoryPageState;
  busy: string | null;
  error: { code: string; message: string; details: Record<string, unknown> } | null;
  runs: RunListView | null;
  runsNotice: string | null;
  /** The run chosen on the Runs page (`#run=…`), shown above the list (D-160); null for the list alone. */
  runsShowing: string | null;
  /** The last search's results (T8): shown on the Open page until an agent or a website is opened. */
  search: SearchView | null;
  library: LibraryView | null;
  /** Settings → Search and the policy subscription (T8). */
  indexes: IndexesView | null;
  policy: PolicyView | null;
  /** The secret store (T16): the chip in the nav and the Unlock sheet. */
  secrets: SecretsView | null;
  unlock: UnlockState;
  /** Settings → Security's keychain card (T17): what the helper said when last asked. */
  keychain: KeychainView | null;
  /** Settings → Permissions (T16). */
  permissions: PermissionsView | null;
  /** What to run again after Allow on an `origin_not_granted` error (T16). */
  retry: (() => void) | null;
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
  memory: null,
  memoryPage: newMemoryPageState(),
  busy: null,
  error: null,
  runs: null,
  runsNotice: null,
  runsShowing: null,
  search: null,
  library: null,
  indexes: null,
  policy: null,
  secrets: null,
  unlock: newUnlockState(),
  keychain: null,
  permissions: null,
  retry: null,
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
    location.hash = section === "data" || section === "memory" ? "memory" : `settings?section=${section}`;
  },
  rerender: () => render(),
  unlock: (retry) => openUnlock(null, retry),
  requestOrigins,
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
  unlock: (retry) => openUnlock(null, retry),
  requestOrigins,
  changed: () => void load(),
  runChanged: (runId) => {
    // The panel moved to another run on its own (a click in "Earlier runs", an active run
    // adopted): the Runs page keeps showing it and the address names it (review 2, nit 4).
    if (state.view !== "runs" || runId === null || runId === state.runsShowing) return;
    state.runsShowing = runId;
    history.replaceState(null, "", `#run=${encodeURIComponent(runId)}`);
    render();
    revealRun();
  },
});
const RUN_VIEW_ID = `run:${crypto.randomUUID()}`;

/** True until the page's first route: only a page that just opened adopts a run in flight. */
let firstRoute = true;

/** Open the Unlock sheet (T16); `retry` runs after a successful unlock. */
function openUnlock(reason: string | null, retry: (() => void) | null): void {
  state.unlock.open = { reason, retry };
  state.unlock.error = null;
  render();
}

/**
 * The card for a status request the worker itself rejected: "Helper failed" with the problem and
 * Check again, never "Asking the helper…" with no way on (T17 review 1, nit 5).
 */
function failedKeychain(error: unknown, previous: KeychainView | null = state.keychain): KeychainView {
  const { code, message } = describeError(error);
  const known = previous ?? { permission: true, enabled: false, enabled_at: null, ollama: null };
  return { permission: known.permission, enabled: known.enabled, enabled_at: known.enabled_at, ollama: known.ollama, helper: "failed", helper_version: null, problem: { code, message } };
}

/** Ask the helper through the worker (T17); the card shows "Asking the helper…" meanwhile. */
async function loadKeychain(previous: KeychainView | null = state.keychain): Promise<void> {
  try {
    state.keychain = await send<KeychainView>({ type: "keychain.status" });
  } catch (error) {
    state.keychain = failedKeychain(error, previous);
  }
  render();
}

async function loadSecrets(): Promise<void> {
  try {
    state.secrets = await send<SecretsView>({ type: "secrets.status" });
  } catch {
    state.secrets = null;
  }
}

/**
 * The store was unlocked, locked or set up: a `store_locked` error shown before it no longer
 * applies once unlocked, and the view re-reads what it shows (the user's walk-through, T16: the
 * banner stayed on Your data after Unlock until the page changed).
 */
async function secretsChanged(): Promise<void> {
  await loadSecrets();
  if (state.secrets?.state === "unlocked" && state.error && needsUnlock(state.error)) state.error = null;
  await load();
}

/**
 * Run an action that may be refused for a missing origin or a locked store (T16): the origins
 * were asked for in the click already (a refusal is Chrome's), so a refusal here offers Allow
 * beside the error and runs the action again; a locked store opens the Unlock sheet and retries.
 */
async function guarded(action: () => Promise<void>): Promise<void> {
  state.retry = null;
  try {
    await action();
  } catch (error) {
    const described = describeError(error);
    if (needsUnlock(described)) {
      openUnlock(null, () => void guarded(action));
      return;
    }
    state.error = described;
    if (refusedOrigins(described).length > 0) state.retry = () => void guarded(action);
    throw error;
  }
}

/** An error raised as the page leaves for another address, which that address shows (D-161; review 1, finding 1). */
let errorForNextRoute: PageState["error"] = null;

/**
 * Go to `hash` and show `error` there. Setting the error before the address would lose it: the
 * `hashchange` that follows runs `route()`, which starts the new address without an error.
 */
function navigateWithError(hash: string, error: NonNullable<PageState["error"]>): void {
  if (location.hash === `#${hash}`) {
    state.error = error;
    return;
  }
  errorForNextRoute = error;
  location.hash = hash;
}

function route(): void {
  const hash = location.hash.replace(/^#/u, "");
  // An error belongs to the view it happened on: a new address starts without one, unless the
  // page navigated here because of it (D-161).
  state.error = errorForNextRoute;
  errorForNextRoute = null;
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
  state.view = view === "data" ? "memory" : (["open", "library", "runs", "trust", "settings", "memory"] as View[]).includes(view as View) ? (view as View) : "open";
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
    if (state.view === "library") state.library = await send<LibraryView>({ type: "library.get" });
    if (state.view === "settings") {
      state.status = await send({ type: "status.get" });
      state.settings = await send({ type: "settings.get" });
      if (state.settingsPage.section === "files") state.files = await send<FilesView>({ type: "files.list" });
      if (state.settingsPage.section === "search") state.indexes = await send<IndexesView>({ type: "indexes.list" });
      if (state.settingsPage.section === "policies") state.policy = await send<PolicyView>({ type: "policy.get" });
      if (state.settingsPage.section === "security") {
        await loadSecrets();
        if (state.keychain === null) void loadKeychain();
      }
      if (state.settingsPage.section === "permissions") state.permissions = await send<PermissionsView>({ type: "permissions.get" });
    }
    if (state.view === "memory" || (state.view === "settings" && state.settingsPage.section === "memory")) state.memory = await send({ type: "memory.get" });
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

/**
 * Show one stored run on the Runs page (D-160): above the list, scrolled to and focused. A run
 * that cannot be shown says why on the Runs page, and the list stays (D-161).
 */
async function openStoredRun(runId: string): Promise<void> {
  // Both entries (the address, and Open on the run already in it) start without the last error.
  state.error = null;
  await load();
  const failed = await runs.openRun(runId);
  if (state.view !== "runs" || state.runsShowing !== runId) return;
  // A run shown keeps an error `load()` met reading the list; a run not shown says why (review 1, nit 4).
  if (failed) state.error = { ...failed, details: {} };
  render();
  if (!failed) revealRun();
}

/** Bring the shown run to the top of the window and give its heading the focus (D-160). */
function revealRun(): void {
  const heading = runs.root.querySelector<HTMLElement>(".ab-run-title h2");
  if (!heading || !runs.root.isConnected) return;
  heading.tabIndex = -1;
  // The "All runs" line above the run comes into view with it, so the heading is not flush with the edge.
  const back = runs.root.previousElementSibling;
  (back?.classList.contains("ab-runs-back") ? back : heading).scrollIntoView({ block: "start" });
  heading.focus({ preventScroll: true });
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

/**
 * The address bar (T8): an address opens as before (a package, or a website whose advertised
 * agents are listed); words or an agent name such as `name@host.example` search the enabled
 * indexes, and the results are agent cards.
 */
async function openAddress(address: string): Promise<void> {
  if (address.length > 0 && addressKind(address) === "search") return runSearch(address);
  state.address = address;
  state.error = null;
  state.search = null;
  state.busy = looksLikePackageUrl(address) ? "Downloading and verifying the package…" : "Reading the website…";
  render();
  // The origin is asked for in the Open click (the gesture); Chrome's answer decides, the worker refuses by name (D-193).
  const origin = originOfUrl(address);
  if (origin) await requestOrigins([origin]);
  try {
    await guarded(async () => {
      if (looksLikePackageUrl(address)) {
        state.open = await send<SessionView>({ type: "package.open", url: address, advertisedOn: null, viewId: VIEW_ID });
        state.website = null;
        location.hash = `session=${encodeURIComponent(state.open.session.id)}`;
      } else {
        state.website = await send<WebsiteResult>({ type: "website.discover", url: address });
        state.open = null;
      }
    });
  } catch {
    // shown by `guarded`
  } finally {
    state.busy = null;
    render();
  }
}

async function runSearch(text: string): Promise<void> {
  state.address = text;
  state.error = null;
  state.busy = "Searching your indexes…";
  render();
  try {
    state.search = await send<SearchView>({ type: "search.query", text });
    state.website = null;
    if (state.open) {
      // Searching leaves the agent shown so far: its session stays open under Library → Open now.
      state.open = null;
      flow.reset();
      runs.detach();
      history.replaceState(null, "", "#open");
    }
  } catch (error) {
    state.error = describeError(error);
  } finally {
    state.busy = null;
    render();
  }
}

/** Open a search result: the ordinary open-and-verify, telling the worker which index it came from. */
async function openResult(result: SearchResultView): Promise<void> {
  state.busy = "Downloading and verifying the package…";
  render();
  const origin = originOfUrl(result.candidate.package_url);
  if (origin) await requestOrigins([origin]);
  try {
    await guarded(async () => {
      const foundVia = result.candidate.source.resolver === "static-index" ? { indexId: result.candidate.source.resolver_id } : null;
      state.open = await send<SessionView>({ type: "package.open", url: result.candidate.package_url, advertisedOn: null, viewId: VIEW_ID, foundVia });
      state.error = null;
      location.hash = `session=${encodeURIComponent(state.open.session.id)}`;
    });
  } catch {
    // shown by `guarded`
  } finally {
    state.busy = null;
    render();
  }
}

/** Open a Library entry again: download and verify, as from the address bar. */
async function openLibraryEntry(entry: LibraryItemView): Promise<void> {
  state.view = "open";
  state.busy = "Downloading and verifying the package…";
  render();
  const origin = originOfUrl(entry.package_url);
  if (origin) await requestOrigins([origin]);
  try {
    state.open = await send<SessionView>({ type: "package.open", url: entry.package_url, advertisedOn: entry.advertised_on, viewId: VIEW_ID });
    state.error = null;
    location.hash = `session=${encodeURIComponent(state.open.session.id)}`;
  } catch (error) {
    const described = describeError(error);
    if (refusedOrigins(described).length > 0) state.retry = () => void openLibraryEntry(entry);
    navigateWithError("open", described);
  } finally {
    state.busy = null;
    render();
  }
}

async function setPinned(pinned: boolean): Promise<void> {
  if (!state.open) return;
  try {
    await send(pinned ? { type: "library.pin", sessionId: state.open.session.id } : { type: "library.unpin", packageUrl: state.open.source.display });
    await showSession(state.open.session.id);
  } catch (error) {
    state.error = describeError(error);
    render();
  }
}

/** Where the open agent came from (an index's claims compared) and whether it is pinned. */
function sessionExtras(open: SessionView): HTMLElement {
  return el(
    "div",
    { className: "ab-session-extras" },
    open.found_via ? renderFoundVia(open.found_via) : null,
    el("div", { className: "ab-actions" }, button(open.pinned ? "Unpin from Library" : "Pin to Library", () => void setPinned(!open.pinned), { variant: "ghost" })),
  );
}

async function inspect(candidate: Candidate): Promise<void> {
  if (!candidate.resolved_url || !state.website) return;
  state.busy = "Downloading and verifying the package…";
  render();
  const origin = originOfUrl(candidate.resolved_url);
  if (origin) await requestOrigins([origin]);
  const website = state.website;
  try {
    await guarded(async () => {
      state.open = await send<SessionView>({ type: "package.open", url: candidate.resolved_url!, advertisedOn: website.final_url, viewId: VIEW_ID });
      state.error = null;
      location.hash = `session=${encodeURIComponent(state.open.session.id)}`;
    });
  } catch {
    // shown by `guarded`
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

const SVG_NS = "http://www.w3.org/2000/svg";

/** A magnifier drawn inline: no image file and no remote resource (D-140). */
function searchIcon(): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  for (const [name, value] of Object.entries({ class: "ab-address-icon", viewBox: "0 0 24 24", "aria-hidden": "true", focusable: "false", fill: "none", stroke: "currentColor", "stroke-width": "2", "stroke-linecap": "round" })) svg.setAttribute(name, value);
  const lens = document.createElementNS(SVG_NS, "circle");
  for (const [name, value] of Object.entries({ cx: "10.5", cy: "10.5", r: "6.5" })) lens.setAttribute(name, value);
  const handle = document.createElementNS(SVG_NS, "path");
  handle.setAttribute("d", "M15.5 15.5 21 21");
  svg.append(lens, handle);
  return svg;
}

/** "WebAgents" as text: one coloured span per letter, the name read once from the heading (D-141). */
function wordmark(): HTMLElement {
  return el("h1", { className: "ab-wordmark", attrs: { "aria-label": "WebAgents" } }, ...[..."WebAgents"].map((letter) => el("span", { text: letter, attrs: { "aria-hidden": "true" } })));
}

/** The compact page's wordmark leads back to the start page (D-162). */
function homeLink(): HTMLElement {
  const link = el("a", { className: "ab-wordmark-home", attrs: { href: "#open", title: "Back to the start page" } }, wordmark());
  link.addEventListener("click", (event) => {
    // A middle click or a click with a modifier opens the start page elsewhere, as links do (review 1, nit 7).
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    goHome();
  });
  return link;
}

/**
 * Back to the start page (D-162): the search, the website card, the error and the box's text go.
 * An open agent is set aside, not closed: its session stays listed under "Open now".
 */
function goHome(): void {
  // An open or a search in flight would land on the start page afterwards: let it finish (review 1, nit 6).
  if (state.busy) return;
  state.search = null;
  state.website = null;
  state.error = null;
  state.address = "";
  if (state.open) {
    state.open = null;
    flow.reset();
    runs.detach();
  }
  if (location.hash !== "#open") history.pushState(null, "", "#open");
  state.view = "open";
  void load();
  render();
  document.querySelector<HTMLInputElement>('input[name="package-url"]')?.focus();
}

function addressBar(): HTMLElement {
  const input = el("input", { className: "ab-input ab-address-input", attrs: { name: "package-url", type: "text", placeholder: "Search agents, or paste an agent.pkg URL or a locator like flights@webair.example", autocomplete: "off", "aria-label": "Search agents or open an address" } });
  input.value = state.address;
  // What is typed survives a re-render from an event (B-150 item 6).
  input.addEventListener("input", () => {
    state.address = input.value;
  });
  const form = el("form", { className: "ab-address" }, searchIcon(), input, button("Open", () => void openAddress(input.value.trim()), { variant: "primary" }));
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    void openAddress(input.value.trim());
  });
  return form;
}

function errorBox(): HTMLElement | null {
  if (!state.error) return null;
  const validation = state.error.details.validation as { errors?: Array<{ layer: string; message: string }> } | undefined;
  const origins = refusedOrigins(state.error);
  const retry = state.retry;
  return el(
    "div",
    { className: "ab-error", attrs: { role: "alert" } },
    el("strong", { text: state.error.code }),
    " ",
    el("span", { text: state.error.message }),
    validation?.errors ? list(validation.errors.map((item) => `${item.layer}: ${item.message}`)) : null,
    // T16, D-193: the origin Chrome does not grant, asked for in this click, then the same action again.
    origins.length > 0 && retry
      ? button(`Allow ${origins.join(", ")}`, () => {
          void requestOrigins(origins).then(() => {
            state.error = null;
            retry();
          });
        }, { variant: "primary" })
      : null,
  );
}

/**
 * The Open view (D-140): a start page (the wordmark, the box, a hint and the open sessions) while
 * nothing is shown, and a compact page (a small wordmark beside the same box, the content below) once
 * there are results, a website, an agent, a busy state or an error. Only the layout differs.
 */
function openView(): HTMLElement[] {
  const start = !state.open && !state.website && !state.search && !state.busy && !state.error;
  const head = el("div", { className: "ab-open-head" }, start ? wordmark() : homeLink(), el("p", { className: "ab-tagline", text: "Find agents on the web. Run them on your terms." }), addressBar());
  const nodes: Array<HTMLElement | null> = [head, errorBox(), state.busy ? el("p", { className: "ab-busy", text: state.busy }) : null];
  if (state.open) {
    const open = state.open;
    const showRun = state.authorization !== null && state.authorization.receipt !== null;
    nodes.push(
      showRun ? runs.root : null,
      sessionExtras(open),
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
        { onDetectSite: (origin) => void detectSite(origin), siteDetected: siteDetected(state.website.page_origin) },
      ),
    );
  } else if (state.search) {
    nodes.push(el("div", { className: "ab-open-results" }, renderSearchResults(state.search, { open: (result) => void openResult(result), settings: () => (location.hash = "settings?section=search") })));
  } else if (!state.busy) {
    nodes.push(
      el(
        "div",
        { className: "ab-open-start" },
        el("p", { className: "ab-hint ab-open-intro", text: "Words or name@host search your indexes; a website shows the agents it advertises; a package URL opens it to inspect. Nothing runs until you authorize an agent and press Run." }),
        el("p", { className: "ab-open-links" }, el("a", { text: "Manage indexes", attrs: { href: "#settings?section=search" } })),
        state.sessions.length > 0 ? el("h4", { text: "Open now" }) : null,
        state.sessions.length > 0 ? list(state.sessions.map((session) => sessionRow(session))) : null,
      ),
    );
  }
  return [el("section", { className: `ab-open ab-open--${start ? "start" : "compact"}` }, ...nodes)];
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
  const apply = (request: Parameters<typeof send>[0]) => {
    send<LibraryView>(request).then(
      (library) => {
        state.library = library;
        render();
      },
      (error: unknown) => {
        state.error = describeError(error);
        render();
      },
    );
  };
  return [
    errorBox(),
    ...renderLibrary(state.library, state.sessions, sessionRow, {
      open: (entry) => void openLibraryEntry(entry),
      show: (sessionId) => (location.hash = `session=${encodeURIComponent(sessionId)}`),
      unpin: (entry) => apply({ type: "library.unpin", packageUrl: entry.package_url }),
      forget: (entry) => apply({ type: "library.forget", packageUrl: entry.package_url }),
    }),
  ].filter((node): node is HTMLElement => node !== null);
}

function runsView(): HTMLElement[] {
  const list = state.runs;
  const current = runs.currentRun();
  const open = (runId: string) => {
    const hash = `#run=${encodeURIComponent(runId)}`;
    // The run already in the address: no hashchange follows, so show it again here (D-160).
    if (location.hash === hash) {
      state.runsShowing = runId;
      void openStoredRun(runId);
    } else location.hash = hash;
  };
  const shown = current && state.runsShowing === current.runId ? current : null;
  return [
    errorBox(),
    // The chosen run first, whether or not a package is open in this tab (D-160; review 1, finding 5).
    shown ? el("p", { className: "ab-runs-back" }, el("a", { text: "← All runs", attrs: { href: "#runs" } })) : null,
    shown ? runs.root : null,
    card(
      "Runs",
      el("p", { className: "ab-hint", text: "Every run this browser made, newest first, from its own records (IndexedDB). Open one to read its result, artifacts and audit; Export writes the run directory as a zip (run.json, run-plan.json, input.json and every artifact); Clear removes a finished run." }),
      state.runsNotice ? el("div", { className: "ab-banner ab-banner-neutral", attrs: { role: "status" } }, el("span", { text: state.runsNotice })) : null,
      !list ? el("p", { className: "ab-busy", text: "Loading…" }) : list.runs.length === 0 ? el("p", { className: "ab-empty", text: "No run yet. Authorize an agent and press Run." }) : renderRunList(list.runs, { open, export: (runId) => void exportRun(runId), clear: (runId) => void clearRun(runId) }),
    ),
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
        if ((state.settingsPage.section === "search" && state.indexes === null) || (state.settingsPage.section === "policies" && state.policy === null)) void load();
        if ((state.settingsPage.section === "security" && state.secrets === null) || (state.settingsPage.section === "permissions" && state.permissions === null)) void load();
        if (state.settingsPage.section === "memory" && state.memory === null) void loadMemory();
        render();
      },
      onSecrets: (request) => {
        send<SecretsView>(request).then(
          (secrets) => {
            state.secrets = secrets;
            state.error = null;
            state.settingsPage.notice =
              request.type === "secrets.setup"
                ? "Passphrase set. Your keys and records are encrypted at rest and unlocked for this session."
                : request.type === "secrets.unlock"
                  ? "Unlocked."
                  : request.type === "secrets.lock"
                    ? "Locked."
                    : request.type === "secrets.changePassphrase"
                      ? "Passphrase changed."
                      : "Every key and record is gone.";
            render();
          },
          (error: unknown) => {
            const described = describeError(error);
            state.settingsPage.notice = described.code === "passphrase_wrong" ? "That passphrase does not open the store." : `${described.code}: ${described.message}`;
            render();
          },
        );
      },
      onKeychain: (action) => {
        void (async () => {
          try {
            if (action === "enable") {
              // The click is the gesture Chrome needs for the optional permission (D-204).
              if (!(await requestNativeMessaging())) {
                state.settingsPage.notice = "Chrome did not grant the permission; keychain unlock stays off.";
                render();
                return;
              }
              state.keychain = await send<KeychainView>({ type: "keychain.enable" });
              state.settingsPage.notice = "Keychain unlock is on: Unlock now offers the macOS keychain.";
            } else if (action === "disable") {
              state.keychain = await send<KeychainView>({ type: "keychain.disable" });
              state.settingsPage.notice = "Keychain unlock is off; your passphrase unlocks as before.";
            } else {
              const previous = state.keychain;
              state.keychain = null;
              render();
              await loadKeychain(previous);
            }
            await loadSecrets();
          } catch (error) {
            const described = describeError(error);
            state.settingsPage.notice = `${described.code}: ${described.message}`;
            state.keychain = await send<KeychainView>({ type: "keychain.status" }).catch((again: unknown) => failedKeychain(again));
          }
          render();
        })();
      },
      onDetectEverywhere: (enabled) => {
        // The checkbox click is the gesture Chrome needs; what Chrome decides is then told to the worker.
        void (async () => {
          try {
            if (enabled) {
              const granted = await requestOrigins(["*"]);
              if (!granted) {
                state.settingsPage.notice = "Chrome did not grant access to every site.";
                render();
                return;
              }
              state.permissions = await send<PermissionsView>({ type: "permissions.granted", origins: ["*"], purpose: { kind: "everywhere", subject: "everywhere" } });
              state.settingsPage.notice = "Agents are detected on every HTTPS page from now on.";
            } else {
              state.permissions = await send<PermissionsView>({ type: "permissions.revoke", origins: ["*"] });
              state.settingsPage.notice = "Access to every site revoked.";
            }
          } catch (error) {
            state.error = describeError(error);
          }
          render();
        })();
      },
      onRevoke: (origins) => {
        send<PermissionsView>({ type: "permissions.revoke", origins }).then(
          (permissions) => {
            state.permissions = permissions;
            state.settingsPage.notice = `Revoked ${origins.join(", ")}. A prepared plan that needs it names it before Run.`;
            render();
          },
          (error: unknown) => {
            state.error = describeError(error);
            render();
          },
        );
      },
      onIndex: (request) => {
        state.settingsPage.notice = request.type === "indexes.add" ? "Fetching and verifying the index…" : null;
        render();
        send<IndexesView>(request).then(
          (indexes) => {
            state.indexes = indexes;
            state.error = null;
            state.settingsPage.notice = request.type === "indexes.add" ? "Index added and verified." : request.type === "indexes.refresh" ? "Checked for updates." : null;
            if (request.type === "indexes.add") state.settingsPage.forms.indexUrl = state.settingsPage.forms.indexPem = "";
            render();
          },
          (error: unknown) => {
            state.error = describeError(error);
            state.settingsPage.notice = null;
            render();
          },
        );
      },
      onPolicy: (request) => {
        state.settingsPage.notice = request.type === "policy.subscribe" ? "Fetching and verifying the policy…" : null;
        render();
        send<PolicyView>(request).then(
          (policy) => {
            state.policy = policy;
            state.error = null;
            state.settingsPage.notice = request.type === "policy.subscribe" ? "Subscribed. The policy now pre-decides your authorizations; every decision it makes says so." : request.type === "policy.unsubscribe" ? "Unsubscribed. Plans authorized under the policy are stale; authorize again." : "Checked for updates.";
            if (request.type === "policy.subscribe") state.settingsPage.forms.policyUrl = state.settingsPage.forms.policyPem = "";
            render();
          },
          (error: unknown) => {
            state.error = describeError(error);
            state.settingsPage.notice = null;
            render();
          },
        );
      },
    }, state.files, { indexes: state.indexes, policy: state.policy, secrets: state.secrets, keychain: state.keychain, memory: state.settingsPage.section === "memory" ? renderMemorySettings(state.memory, state.memoryPage, { ...memoryActions(), openMemory: () => (location.hash = "memory"), preset: state.settings?.settings.preset ?? "balanced", forgetTyped: state.settingsPage.forgetMemory ?? "", setForgetTyped: (value) => { state.settingsPage.forgetMemory = value; render(); } }) : null, permissions: state.permissions }),
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
        // A closed dialog fires `cancel` (Chrome 113+) and no `change`: settle with nothing
        // picked rather than leave the promise pending (T6 review, nit 9).
        input.addEventListener("cancel", () => resolve([]));
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

/** The actions the Memory page and Settings → Memory share (T19): the worker's messages, a reload, the Unlock sheet for a write on a locked store. */
function memoryActions() {
  return {
    send: <T,>(request: Parameters<typeof send>[0]) => send<T>(request),
    rerender: () => render(),
    reload: () => void loadMemory(),
    unlock: (action: string, then: () => void) => openUnlock(`Your memory is locked. Unlock to ${action}.`, then),
    openRun: (runId: string) => (location.hash = `run=${encodeURIComponent(runId)}`),
    saveBlob,
    graph: renderMemoryGraph,
  };
}

async function loadMemory(): Promise<void> {
  try {
    state.memory = await send<MemoryView>({ type: "memory.get" });
    state.error = null;
  } catch (error) {
    state.error = describeError(error);
  }
  render();
}

function memoryView(): HTMLElement[] {
  if (!state.memory) {
    const locked = state.error && needsUnlock(state.error);
    return [
      errorBox(),
      locked ? el("div", { className: "ab-actions" }, button(state.secrets?.state === "no_passphrase" ? "Set a passphrase" : "Unlock", () => (state.secrets?.state === "no_passphrase" ? (location.hash = "settings?section=security") : openUnlock(null, () => void loadMemory())), { variant: "primary" })) : null,
      locked ? null : el("p", { className: "ab-busy", text: "Loading…" }),
    ].filter((node): node is HTMLElement => node !== null);
  }
  return [errorBox(), renderMemoryPage(state.memory, state.memoryPage, memoryActions())].filter((node): node is HTMLElement => node !== null);
}

/** "Always detect agents on this site" (T16, D-190): Chrome is asked in the click; the worker records the grant and registers the script. */
async function detectSite(origin: string): Promise<void> {
  try {
    if (!(await requestOrigins([origin]))) return;
    state.permissions = await send<PermissionsView>({ type: "permissions.granted", origins: [origin], purpose: { kind: "site", subject: origin } });
    state.error = null;
  } catch (error) {
    state.error = describeError(error);
  }
  render();
}

function siteDetected(origin: string): boolean {
  return state.permissions?.origins.some((item) => item.origin === origin && item.granted && item.purposes.some((purpose) => purpose.kind === "site")) === true || state.permissions?.detect_everywhere === true;
}

function render(): void {
  for (const link of document.querySelectorAll<HTMLAnchorElement>(".ab-nav a")) {
    link.classList.toggle("ab-nav-active", link.dataset.view === state.view);
  }
  const chipHost = document.getElementById("lock");
  if (chipHost) replace(chipHost, [renderLockChip(state.secrets, { onLock: () => void send<SecretsView>({ type: "secrets.lock" }).then(() => loadSecrets().then(render)), onOpen: () => openUnlock(null, null), openSettings: () => (location.hash = "settings?section=security") })]);
  const children =
    state.view === "open" ? openView() : state.view === "library" ? libraryView() : state.view === "runs" ? runsView() : state.view === "trust" ? trustView() : state.view === "memory" ? memoryView() : settingsView();
  const sheet = renderUnlockSheet(state.unlock, state.secrets, { rerender: render, openSettings: () => (location.hash = "settings?section=security"), onUnlocked: () => void secretsChanged() });
  replace(app, sheet ? [...children, sheet] : children);
}

subscribe((event) => {
  if (event.type === "event.secrets") void secretsChanged();
  if (event.type === "event.permissions") {
    void send<PermissionsView>({ type: "permissions.get" }).then((permissions) => {
      state.permissions = permissions;
      render();
    }, () => undefined);
  }
  if (event.type === "event.sessions" || event.type === "event.trust" || event.type === "event.settings") void load();
  if (event.type === "event.memory" && (state.view === "memory" || (state.view === "settings" && state.settingsPage.section === "memory"))) void loadMemory();
  if ((event.type === "event.library" && state.view === "library") || ((event.type === "event.indexes" || event.type === "event.policy") && state.view === "settings")) void load();
  if (event.type === "event.sessions" && state.open) void showSession(state.open.session.id);
  if (event.type === "event.authorization" && state.open && event.sessionId === state.open.session.id) {
    void flow.load().then(() => {
      render();
      runs.sync();
    });
  }
  if ((event.type === "event.memory" || event.type === "event.settings") && state.open) {
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
void loadSecrets().then(render);
void send<PermissionsView>({ type: "permissions.get" }).then((permissions) => {
  state.permissions = permissions;
}, () => undefined);
route();
