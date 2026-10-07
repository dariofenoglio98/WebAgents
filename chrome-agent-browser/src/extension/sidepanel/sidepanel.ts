/**
 * The side panel: the current tab's advertised packages, Inspect, and the agent page in
 * compact form (D-035). A thin view over the service worker.
 */
import type { Candidate } from "../../core/discovery.js";
import type { AuthorizationView, CandidateState, ModelsView, SessionView } from "../messages.js";
import { renderAgentPage } from "../ui/agent-page.js";
import { bindAuthorization, type AuthorizationController } from "../ui/authorization-flow.js";
import { describeError, send, subscribe } from "../ui/client.js";
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
  error: { code: string; message: string } | null;
}

const state: PanelState = { tabId: null, candidates: null, open: null, authorization: null, models: null, busy: null, error: null };
/** This view's identity toward the service worker (D-035): a session ends when no view holds it. */
const VIEW_ID = `sidepanel:${crypto.randomUUID()}`;

async function currentTab(): Promise<chrome.tabs.Tab | null> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab ?? null;
}

function emptyState(): HTMLElement {
  return card(
    "No agent package on this page",
    el("p", { className: "ab-hint", text: "This extension looks for <link rel=\"agent-package\"> in a page's head: a website saying it publishes a signed agent that your browser can inspect and, later, run with your own models and permissions." }),
    el("p", { className: "ab-hint", text: "Try the WebAir demo: https://webagents-webair-production.up.railway.app/" }),
    button("Open the agent browser", () => openFullPage()),
  );
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
  changed: () => render(),
});

async function inspect(candidate: Candidate): Promise<void> {
  if (!candidate.resolved_url || !state.candidates) return;
  state.busy = "Downloading and verifying the package…";
  state.error = null;
  render();
  try {
    state.open = await send<SessionView>({ type: "package.open", url: candidate.resolved_url, advertisedOn: state.candidates.pageUrl, viewId: VIEW_ID });
    flow.reset();
    runs.detach();
    await flow.load();
    await runs.attachSession(state.open.session.id);
  } catch (error) {
    state.error = describeError(error);
  } finally {
    state.busy = null;
    render();
  }
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
  if (state.error) children.push(el("div", { className: "ab-error", attrs: { role: "alert" } }, el("strong", { text: state.error.code }), " ", el("span", { text: state.error.message })));
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
    children.push(renderWebsiteCard(state.candidates, (candidate) => void inspect(candidate)));
  } else {
    children.push(emptyState());
  }
  replace(app, children);
}

async function refresh(): Promise<void> {
  const tab = await currentTab();
  state.tabId = tab?.id ?? null;
  state.candidates = state.tabId === null ? null : await send<CandidateState | null>({ type: "candidates.get", tabId: state.tabId });
  render();
}

subscribe((event) => {
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
});
chrome.tabs.onActivated.addListener(() => void refresh());
chrome.tabs.onUpdated.addListener((tabId, change) => {
  if (tabId === state.tabId && change.status === "complete") void refresh();
});

void refresh();
