/**
 * The side panel: the current tab's advertised packages, Inspect, and the agent page in
 * compact form (D-035). A thin view over the service worker.
 */
import type { Candidate } from "../../core/discovery.js";
import type { AuthorizationView, CandidateState, ModelsView, PermissionsView, RunView, SecretsView, SessionView } from "../messages.js";
import { renderAgentPage } from "../ui/agent-page.js";
import { bindAuthorization, type AuthorizationController } from "../ui/authorization-flow.js";
import { describeError, originOfUrl, refusedOrigins, requestOrigins, send, subscribe } from "../ui/client.js";
import { needsUnlock, newUnlockState, renderLockChip, renderUnlockSheet, type UnlockState } from "../ui/unlock.js";
import { button, card, el, replace } from "../ui/dom.js";
import { RunPanel } from "../ui/run.js";
import { renderWebsiteCard } from "../ui/website.js";

const app = document.getElementById("app") as HTMLElement;

interface PanelState {
  tabId: number | null;
  candidates: CandidateState | null;
  open: SessionView | null;
  authorization: AuthorizationView | null;
  models: ModelsView | null;
  busy: string | null;
  error: { code: string; message: string; details?: Record<string, unknown> } | null;
  /** The secret store (T16): the chip and the Unlock sheet. */
  secrets: SecretsView | null;
  unlock: UnlockState;
  permissions: PermissionsView | null;
  /** The tab whose page could not be read (no activeTab, no granted origin), so the panel says how to allow it. */
  unreadable: { tabId: number; message: string } | null;
  /** The last tab the discovery script was injected into by this panel, so a refresh does not inject twice. */
  readTab: number | null;
}

const state: PanelState = { tabId: null, candidates: null, open: null, authorization: null, models: null, busy: null, error: null, secrets: null, unlock: newUnlockState(), permissions: null, unreadable: null, readTab: null };
/** This view's identity toward the service worker (D-035): a session ends when no view holds it. */
const VIEW_ID = `sidepanel:${crypto.randomUUID()}`;

async function currentTab(): Promise<chrome.tabs.Tab | null> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab ?? null;
}

function emptyState(): HTMLElement {
  const unreadable = state.unreadable !== null && state.unreadable.tabId === state.tabId;
  return card(
    unreadable ? "This page was not read" : "No agent package on this page",
    el("p", { className: "ab-hint", text: "This extension looks for <link rel=\"agent-package\"> in a page's head: a website saying it publishes a signed agent that your browser can inspect and, later, run with your own models and permissions." }),
    unreadable
      ? el("p", { className: "ab-banner ab-banner-warn", attrs: { role: "status" }, text: "This browser reads a page only when you ask: click the WebAgents button on the page (or use its context-menu item), or allow the site for good under Settings → Permissions." })
      : el("p", { className: "ab-hint", text: "By default this browser reads a page only when you click its button; nothing else is read. Try the WebAir demo: https://webagents-webair-production.up.railway.app/" }),
    el("div", { className: "ab-actions" }, button("Look again", () => void readCurrentTab(true), { variant: "ghost" }), button("Open the agent browser", () => openFullPage())),
  );
}

/** Open the Unlock sheet (T16); `retry` runs after a successful unlock. */
function openUnlock(reason: string | null, retry: (() => void) | null): void {
  state.unlock.open = { reason, retry };
  state.unlock.error = null;
  render();
}

async function loadSecrets(): Promise<void> {
  try {
    state.secrets = await send<SecretsView>({ type: "secrets.status" });
  } catch {
    state.secrets = null;
  }
}

/** The store changed: once unlocked, a `store_locked` error shown before no longer applies. */
async function secretsChanged(): Promise<void> {
  await loadSecrets();
  if (state.secrets?.state === "unlocked" && state.error && needsUnlock(state.error)) state.error = null;
  render();
}

/**
 * Read the current tab's advertised links (T16, D-190): the content script is injected under the
 * `activeTab` the action click granted (or a granted origin) and reports as usual; the worker then
 * broadcasts the candidates. A tab Chrome refuses is remembered, so the panel says how to allow it.
 */
async function readCurrentTab(force = false): Promise<void> {
  if (state.tabId === null) return;
  if (!force && state.readTab === state.tabId) return;
  state.readTab = state.tabId;
  // A URL Chrome shows this panel without a grant is the extension's own or a browser page: nothing to read there.
  const tab = await currentTab();
  if (tab?.id === state.tabId && typeof tab.url === "string" && !tab.url.startsWith("https://")) {
    state.unreadable = null;
    render();
    return;
  }
  try {
    await send({ type: "discovery.readTab", tabId: state.tabId });
    state.unreadable = null;
  } catch (error) {
    state.unreadable = { tabId: state.tabId, message: describeError(error).message };
  }
  render();
}

function openFullPage(sessionId?: string, hash?: string): void {
  const url = chrome.runtime.getURL(`browser.html${hash ? `#${hash}` : sessionId ? `#session=${encodeURIComponent(sessionId)}` : ""}`);
  void chrome.tabs.create({ url });
}

/** The authorization flow for the open session (T3): loads the view and the models, renders below the agent page. */
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
    state.error = error;
  },
  openSettings: (section) => openFullPage(undefined, section === "data" ? "data" : `settings?section=${section}`),
  rerender: () => render(),
  compact: true,
  unlock: (retry) => openUnlock(null, retry),
  requestOrigins,
});

/** The run surface (T5): compact in the panel; the full page has the Runs history. */
const runs = new RunPanel({
  send,
  loaded: () => (state.open ? { session: state.open, authorization: state.authorization } : null),
  compact: true,
  reveal: (section) => {
    if (section === "trust" || section === "authorization" || section === "plan") document.querySelector(".ab-authorize")?.scrollIntoView({ block: "start" });
    else openFullPage(undefined, "settings?section=models");
  },
  openFiles: () => openFullPage(undefined, "settings?section=files"),
  unlock: (retry) => openUnlock(null, retry),
  requestOrigins,
  changed: () => render(),
});

/** Show a session this view now holds: its authorization flow and its run surface, from the start. */
async function showSession(view: SessionView): Promise<void> {
  state.open = view;
  flow.reset();
  runs.detach();
  await flow.load();
  // Adopts the session's run in flight, or its latest run (`loadHistory(true)`).
  await runs.attachSession(view.session.id);
}

async function inspect(candidate: Candidate): Promise<void> {
  if (!candidate.resolved_url || !state.candidates) return;
  state.busy = "Downloading and verifying the package…";
  state.error = null;
  render();
  // The package's origin is asked for in the Inspect click (the gesture, D-193); the worker refuses by name otherwise.
  const origin = originOfUrl(candidate.resolved_url);
  if (origin) await requestOrigins([origin]);
  try {
    // A panel still finding its run finishes first, so the hold this Inspect takes is the last one (D-076).
    await reattaching;
    // The same bytes from the same page while a run of them is in flight come back as that run's
    // session (D-076), so Inspect pressed again shows the run rather than a fresh copy.
    await showSession(await send<SessionView>({ type: "package.open", url: candidate.resolved_url, advertisedOn: state.candidates.pageUrl, viewId: VIEW_ID }));
  } catch (error) {
    state.error = describeError(error);
  } finally {
    state.busy = null;
    render();
  }
}

/** "Always detect agents on this site" (T16, D-190). */
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

async function trust(scope: "package" | "publisher"): Promise<void> {
  if (!state.open) return;
  const fingerprint = state.open.page.trust.signer_fingerprint;
  if (!fingerprint) return;
  try {
    await send({ type: "trust.pin", sessionId: state.open.session.id, signerFingerprint: fingerprint, scope });
    state.open = await send<SessionView>({ type: "package.get", sessionId: state.open.session.id, viewId: VIEW_ID });
    await flow.load();
    state.error = null;
  } catch (error) {
    state.error = describeError(error);
  }
  render();
}

function render(): void {
  const children: Array<HTMLElement | null> = [];
  children.push(renderLockChip(state.secrets, { onLock: () => void send<SecretsView>({ type: "secrets.lock" }).then(() => loadSecrets().then(render)), onOpen: () => openUnlock(null, null), openSettings: () => openFullPage(undefined, "settings?section=security") }));
  if (state.error) {
    const error = state.error;
    const origins = refusedOrigins({ code: error.code, details: error.details ?? {} });
    children.push(
      el(
        "div",
        { className: "ab-error", attrs: { role: "alert" } },
        el("strong", { text: error.code }),
        " ",
        el("span", { text: error.message }),
        origins.length > 0 ? button(`Allow ${origins.join(", ")}`, () => void requestOrigins(origins).then(() => render()), { variant: "primary" }) : null,
        needsUnlock(error) ? button("Unlock", () => openUnlock(null, null), { variant: "primary" }) : null,
      ),
    );
  }
  if (state.busy) children.push(el("p", { className: "ab-busy", text: state.busy }));
  if (state.open) {
    const open = state.open;
    // The run surface sits above the agent page once the agent is authorized, so a running or
    // finished run is the first thing a reopened panel shows; before that, the authorize flow leads.
    const showRun = state.authorization?.receipt !== null && state.authorization !== null;
    if (!runs.hasSession()) void runs.attachSession(open.session.id);
    children.push(
      showRun ? runs.root : null,
      renderAgentPage(open, {
        compact: true,
        onTrust: (scope) => void trust(scope),
        onClose: () => {
          // Release this view's hold: the session ends only when no other view (a full page
          // opened on it) still shows it, so panel inspections do not accumulate toward the
          // session limit and Close here does not end a full page's session (review 2, nit 5).
          void send({ type: "package.release", sessionId: open.session.id, viewId: VIEW_ID }).catch(() => undefined);
          state.open = null;
          flow.reset();
          runs.detach();
          render();
        },
        onOpenFullPage: () => openFullPage(open.session.id),
      }),
      flow.render((scope) => void trust(scope)),
    );
  } else if (state.candidates && state.candidates.candidates.length > 0) {
    children.push(renderWebsiteCard(state.candidates, (candidate) => void inspect(candidate), { onDetectSite: (origin) => void detectSite(origin), siteDetected: siteDetected(state.candidates.pageOrigin) }));
  } else {
    children.push(emptyState());
  }
  const sheet = renderUnlockSheet(state.unlock, state.secrets, { rerender: render, openSettings: () => openFullPage(undefined, "settings?section=security"), onUnlocked: () => void secretsChanged() });
  replace(app, sheet ? [...children, sheet] : children);
}

/**
 * D-076: a panel that opens while a run is in flight shows that run, not the website card. Chrome
 * gives a closing panel no chance to release its session, so the session and its run are still
 * in the service worker; a reopened panel (a new document, a new view id, nothing open) only has
 * to find them: a run opened from the active tab's page first, else the most recent one. The
 * panel then holds that session as if it had just opened it.
 */
async function reattach(): Promise<void> {
  if (state.open || state.busy) return;
  let run: RunView | null;
  try {
    run = await send<RunView | null>({ type: "run.active", pageUrl: state.candidates?.pageUrl ?? null });
  } catch {
    return; // nothing to reattach to is not an error the person can act on
  }
  if (run === null || run.sessionId === null || state.open || state.busy) return;
  let view: SessionView;
  try {
    view = await send<SessionView>({ type: "package.get", sessionId: run.sessionId, viewId: VIEW_ID });
  } catch {
    return; // the session ended in between: the website card stays
  }
  // Inspect pressed meanwhile waits for this to finish and then takes this view's hold itself.
  if (state.open || state.busy) return;
  try {
    await showSession(view);
  } catch {
    // The view holds the session and shows it even if its run could not be read yet (the worker
    // restarting): `render()` attaches the run surface again (review 1, finding 2).
  }
  render();
}

async function refresh(): Promise<void> {
  const tab = await currentTab();
  state.tabId = tab?.id ?? null;
  state.candidates = state.tabId === null ? null : await send<CandidateState | null>({ type: "candidates.get", tabId: state.tabId });
  render();
  // Nothing known about this tab yet: read it now, under the activeTab the click granted (D-190).
  if (state.candidates === null) await readCurrentTab();
}

subscribe((event) => {
  if (event.type === "event.secrets") void secretsChanged();
  if (event.type === "event.permissions") {
    void send<PermissionsView>({ type: "permissions.get" }).then((permissions) => {
      state.permissions = permissions;
      render();
    }, () => undefined);
  }
  if (event.type === "event.candidates" && event.tabId === state.tabId) void refresh();
  if (event.type === "event.sessions" && state.open) {
    const id = state.open.session.id;
    send<SessionView>({ type: "package.get", sessionId: id, viewId: VIEW_ID }).then(
      (view) => {
        state.open = view;
        render();
      },
      () => {
        state.open = null;
        flow.reset();
        render();
      },
    );
  }
  if ((event.type === "event.authorization" && state.open && event.sessionId === state.open.session.id) || event.type === "event.vault" || event.type === "event.settings") {
    void flow.load().then(() => {
      render();
      runs.sync();
    });
  }
  if (event.type === "event.run") runs.onRunEvent(event);
  if (event.type === "event.files") runs.onFilesEvent();
});
chrome.tabs.onActivated.addListener(() => void refresh());
chrome.tabs.onUpdated.addListener((tabId, change) => {
  if (tabId === state.tabId && change.status === "complete") {
    // A new page in the same tab: its links are read again when Chrome lets this panel (a granted site), else the empty state says how.
    state.readTab = null;
    void refresh();
  }
});
void loadSecrets().then(render);
void send<PermissionsView>({ type: "permissions.get" }).then((permissions) => {
  state.permissions = permissions;
}, () => undefined);

const reattaching: Promise<void> = refresh()
  .catch(() => undefined)
  .then(() => reattach())
  .catch(() => undefined);
