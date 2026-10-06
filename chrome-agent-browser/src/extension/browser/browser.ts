/**
 * The full-page agent browser (D-035): an address bar that takes a package URL or a website
 * URL, the website card, the agent page, the Trust page, and Library, Runs and Settings as
 * placeholders with their intended layout. A thin view over the service worker; routing is
 * the location hash.
 */
import type { Candidate } from "../../core/discovery.js";
import { looksLikePackageUrl } from "../../core/policy.js";
import type { TrustEntry, TrustState } from "../../core/trust.js";
import type { SessionDescriptor, SessionView, StatusInfo, WebsiteResult } from "../messages.js";
import { renderAgentPage } from "../ui/agent-page.js";
import { describeError, send, subscribe } from "../ui/client.js";
import { button, card, chip, el, list, replace, row, whenText } from "../ui/dom.js";
import { renderTrustPage } from "../ui/trust-page.js";
import { renderWebsiteCard } from "../ui/website.js";

type View = "open" | "library" | "runs" | "trust" | "settings";

interface PageState {
  view: View;
  address: string;
  website: WebsiteResult | null;
  open: SessionView | null;
  sessions: SessionDescriptor[];
  trust: { entries: TrustEntry[]; state: TrustState } | null;
  status: StatusInfo | null;
  busy: string | null;
  error: { code: string; message: string; details: Record<string, unknown> } | null;
}

const app = document.getElementById("app") as HTMLElement;
const state: PageState = { view: "open", address: "", website: null, open: null, sessions: [], trust: null, status: null, busy: null, error: null };

function route(): void {
  const hash = location.hash.replace(/^#/u, "");
  const [view, query] = hash.split("?");
  const params = new URLSearchParams(query ?? "");
  if (view?.startsWith("session=")) {
    state.view = "open";
    void showSession(decodeURIComponent(view.slice("session=".length)));
    return;
  }
  state.view = (["open", "library", "runs", "trust", "settings"] as View[]).includes(view as View) ? (view as View) : "open";
  if (params.get("url")) state.address = params.get("url")!;
  void load();
}

async function load(): Promise<void> {
  try {
    if (state.view === "trust") state.trust = await send({ type: "trust.list" });
    if (state.view === "library" || state.view === "open") state.sessions = (await send<{ sessions: SessionDescriptor[] }>({ type: "sessions.list" })).sessions;
    if (state.view === "settings") state.status = await send({ type: "status.get" });
  } catch (error) {
    state.error = describeError(error);
  }
  render();
}

async function showSession(sessionId: string): Promise<void> {
  try {
    state.open = await send<SessionView>({ type: "package.get", sessionId });
    state.error = null;
  } catch (error) {
    state.open = null;
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
      state.open = await send<SessionView>({ type: "package.open", url: address, advertisedOn: null });
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
    state.open = await send<SessionView>({ type: "package.open", url: candidate.resolved_url, advertisedOn: state.website.final_url });
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
          void send({ type: "package.close", sessionId: open.session.id }).catch(() => undefined);
          state.open = null;
          location.hash = "open";
          render();
        },
      }),
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
      el("p", { className: "ab-hint", text: "Agents you have inspected in this browser session. Saving agents for later, with their trusted keys and your preferred settings, arrives with authorization (T3)." }),
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
  const status = state.status;
  return [
    card(
      "Settings",
      el("p", { className: "ab-hint", text: "Models, policies and your personal vault arrive with authorization (T3) and execution (T5). This page shows the limits in force." }),
      status
        ? el(
            "div",
            {},
            row("Extension", status.version),
            row("Core", `${status.core_version} (agentpkg-runtime-v0 ${status.runtime_version})`),
            row("Open packages", `${status.sessions} of ${status.max_sessions}`),
            row("Snapshot cache", `${(status.cached_bytes / (1024 * 1024)).toFixed(1)} of ${(status.max_cache_bytes / (1024 * 1024)).toFixed(0)} MiB`),
            row("Session lifetime", `${status.session_ttl_seconds / 60} minutes`),
            row("Execution", status.execution),
          )
        : el("p", { className: "ab-busy", text: "Loading…" }),
      el("h4", { text: "Planned" }),
      list(["Models: local Ollama (needs OLLAMA_ORIGINS to include chrome-extension://*), OpenAI and Anthropic with your own keys, Chrome built-in Gemini Nano", "Policies: privacy-first, balanced and convenience presets", "Your data: typed records a package can ask for by type, never by name"]),
    ),
  ];
}

function render(): void {
  for (const link of document.querySelectorAll<HTMLAnchorElement>(".ab-nav a")) {
    link.classList.toggle("ab-nav-active", link.dataset.view === state.view);
  }
  const children = state.view === "open" ? openView() : state.view === "library" ? libraryView() : state.view === "runs" ? runsView() : state.view === "trust" ? trustView() : settingsView();
  replace(app, children);
}

subscribe((event) => {
  if (event.type === "event.sessions" || event.type === "event.trust") void load();
  if (event.type === "event.sessions" && state.open) void showSession(state.open.session.id);
});
window.addEventListener("hashchange", route);
route();
