/**
 * The full-page agent browser (D-035): an address bar that takes a package URL or a website
 * URL, the website card, the agent page, the Trust page, and Library, Runs and Settings as
 * placeholders with their intended layout. A thin view over the service worker; routing is
 * the location hash.
 */
import type { Candidate } from "../../core/discovery.js";
import type { JsonObject } from "../../core/json.js";
import { looksLikePackageUrl } from "../../core/policy.js";
import type { TrustEntry, TrustState } from "../../core/trust.js";
import type { AuthorizationView, ModelsView, SessionDescriptor, SessionView, SettingsView, StatusInfo, VaultView, WebsiteResult } from "../messages.js";
import { renderAgentPage } from "../ui/agent-page.js";
import { bindAuthorization, type AuthorizationController } from "../ui/authorization-flow.js";
import { describeError, send, subscribe } from "../ui/client.js";
import { button, card, chip, el, list, replace, row, whenText } from "../ui/dom.js";
import { newSettingsPageState, renderSettingsPage, type SettingsPageState, type SettingsSection } from "../ui/settings-page.js";
import { renderTrustPage } from "../ui/trust-page.js";
import { newVaultPageState, renderVaultPage, type VaultPageState } from "../ui/vault-page.js";
import { renderWebsiteCard } from "../ui/website.js";

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
  vault: VaultView | null;
  vaultPage: VaultPageState;
  busy: string | null;
  error: { code: string; message: string; details: Record<string, unknown> } | null;
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
  vault: null,
  vaultPage: newVaultPageState(),
  busy: null,
  error: null,
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

function route(): void {
  const hash = location.hash.replace(/^#/u, "");
  const [view, query] = hash.split("?");
  const params = new URLSearchParams(query ?? "");
  if (view?.startsWith("session=")) {
    state.view = "open";
    void showSession(decodeURIComponent(view.slice("session=".length)));
    return;
  }
  state.view = (["open", "library", "runs", "trust", "settings", "data"] as View[]).includes(view as View) ? (view as View) : "open";
  if (params.get("url")) state.address = params.get("url")!;
  const section = params.get("section");
  if (state.view === "settings" && (section === "models" || section === "policies" || section === "about")) state.settingsPage.section = section as SettingsSection;
  void load();
}

async function load(): Promise<void> {
  try {
    if (state.view === "trust") state.trust = await send({ type: "trust.list" });
    if (state.view === "library" || state.view === "open") state.sessions = (await send<{ sessions: SessionDescriptor[] }>({ type: "sessions.list" })).sessions;
    if (state.view === "settings") {
      state.status = await send({ type: "status.get" });
      state.settings = await send({ type: "settings.get" });
    }
    if (state.view === "data") state.vault = await send({ type: "vault.get" });
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
  } catch (error) {
    state.open = null;
    flow.reset();
    state.error = describeError(error);
  }
  render();
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
    nodes.push(
      renderAgentPage(open, {
        onTrust: (scope) => void trustSession(scope),
        onClose: () => {
          void send({ type: "package.release", sessionId: open.session.id, viewId: VIEW_ID }).catch(() => undefined);
          state.open = null;
          flow.reset();
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
        el("p", { className: "ab-hint", text: "Enter a website address to see which agent package it advertises, or a package address to inspect it directly. Nothing runs in this version: the browser verifies and shows what an agent would need." }),
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
      el("p", { className: "ab-hint", text: "Agents you have inspected in this browser session; open one to see its authorization and run plan. Saving agents for later arrives with runs from the browser (T5)." }),
      state.sessions.length === 0 ? el("p", { className: "ab-empty", text: "Nothing is open." }) : list(state.sessions.map((session) => sessionRow(session))),
    ),
  ];
}

function runsView(): HTMLElement[] {
  return [
    card(
      "Runs",
      el("p", { className: "ab-hint", text: "This version of the extension executes nothing. Runs, their progress, results and hash-linked audit trails arrive with the execution core (T4, T5)." }),
      el("div", { className: "ab-placeholder" }, row("Status", "no runs"), row("Model routes", "local Ollama, OpenAI, Anthropic, Chrome built-in (planned)"), row("Audit", "hash-linked, verified before display (planned)")),
    ),
  ];
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
  const refreshSettings = async () => {
    state.settings = await send({ type: "settings.get" });
    render();
  };
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
      onProbe: (provider) => {
        state.settingsPage.probes[provider] = "running";
        render();
        send({ type: "models.probe", provider }).then(
          (result) => {
            state.settingsPage.probes[provider] = result as NonNullable<SettingsPageState["probes"][typeof provider]>;
            void refreshSettings();
          },
          (error: unknown) => {
            delete state.settingsPage.probes[provider];
            state.error = describeError(error);
            render();
          },
        );
      },
      rerender: () => render(),
    }),
  ].filter((node): node is HTMLElement => node !== null);
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
  if (event.type === "event.authorization" && state.open && event.sessionId === state.open.session.id) void flow.load().then(() => render());
  if ((event.type === "event.vault" || event.type === "event.settings") && state.open) void flow.load().then(() => render());
});
window.addEventListener("hashchange", route);
route();
