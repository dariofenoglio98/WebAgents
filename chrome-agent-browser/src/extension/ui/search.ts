/**
 * Search results, the Library, and what an index said about an opened package (T8). Results are
 * agent cards: what the index says the agent is, who published the index, whether the signer it
 * claims is one you trust (claimed, checked again when opened), and Open, which is the ordinary
 * open-and-verify. Nothing here ranks by anything but trust status and the index's order (D-104).
 * Every index string reaches the document through `textContent`.
 */
import type { FoundVia, LibraryItemView, LibraryView, SearchResultView, SearchView, SessionDescriptor } from "../messages.js";
import { button, card, chip, el, list, shortHash, whenText, type Child } from "./dom.js";

const TRUST_WORDS: Record<string, [text: string, tone: "good" | "warn" | "bad"]> = {
  trusted: ["publisher key trusted", "good"],
  unknown: ["publisher key not trusted yet", "warn"],
  mismatch: ["possible impersonation", "bad"],
};

function trustChip(status: string, reason: string): HTMLElement {
  if (reason === "signer_not_stated") return chip("signer not stated by the index", "warn");
  const [text, tone] = TRUST_WORDS[status] ?? ["unknown", "warn"];
  return chip(reason === "policy_anchor" ? "publisher key trusted by your policy" : text, tone);
}

function resultCard(result: SearchResultView, onOpen: (result: SearchResultView) => void): HTMLElement {
  const candidate = result.candidate;
  const source = candidate.source;
  return el(
    "div",
    { className: "ab-result", attrs: { "data-package-id": candidate.package_id, "data-package-url": candidate.package_url } },
    el("div", { className: "ab-result-head" }, el("strong", { className: "ab-result-name", text: candidate.name }), el("span", { className: "ab-muted", text: ` ${candidate.version}` }), trustChip(result.trust.status, result.trust.reason)),
    el("p", { className: "ab-result-publisher", text: `Publisher, as the index states it: ${candidate.publisher.name ?? candidate.publisher.id ?? "not stated"}` }),
    el("p", { className: "ab-access-text", text: candidate.description }),
    candidate.tags.length > 0 ? el("div", { className: "ab-inline" }, ...candidate.tags.map((tag) => chip(tag))) : null,
    ...candidate.claims.map((claim) => el("p", { className: "ab-hint", text: `${claim.label}, as the index claims it (not checked): ${claim.value}` })),
    el("code", { className: "ab-candidate-url", text: candidate.package_url }),
    el(
      "p",
      { className: "ab-hint ab-result-source", text: `Found in ${source.label}${source.version ? ` ${source.version}` : ""}${source.verified_by ? `, signed by ${shortHash(source.verified_by, 20)} (the key you pinned for it)` : ", unverified"} · entry ${source.position + 1}. The index says where the package is and what it is; opening it downloads and verifies the package itself.` },
    ),
    button("Open and verify", () => onOpen(result), { variant: "primary" }),
  );
}

export interface SearchActions {
  open: (result: SearchResultView) => void;
  settings: () => void;
}

export function renderSearchResults(view: SearchView, actions: SearchActions): HTMLElement {
  const children: Child[] = [];
  if (view.enabled_indexes === 0) {
    children.push(el("p", { className: "ab-hint", text: "No agent index is enabled, so nothing was searched. Add one in Settings → Search: an index is fetched only after you add it." }), button("Open Settings → Search", actions.settings));
  } else {
    children.push(
      el("p", { className: "ab-hint", text: `${view.results.length === 0 ? "No agent matches" : `${view.results.length} agent${view.results.length === 1 ? "" : "s"} for`} “${view.query.text}”${view.query.kind === "locator" ? " (an agent name)" : ""} in ${view.searched.map((item) => `${item.label} ${item.version}`).join(", ") || "no verified index"}. Ordered by whether you trust the publisher's key, then by each index's own order; nothing else ranks them.` }),
      view.results.length > 0 ? list(view.results.map((result) => resultCard(result, actions.open)), "ab-results") : null,
    );
  }
  if (view.notes.length > 0) children.push(el("div", { className: "ab-notes" }, ...view.notes.map((note) => el("p", { className: "ab-hint", attrs: { "data-note": note.code } }, el("code", { text: note.code }), " ", el("span", { text: `${note.source}: ${note.detail ?? ""}` })))));
  return card("Search results", ...children);
}

const CLAIM_LABELS: Record<keyof FoundVia["claims"], string> = { package_id: "package id", version: "version", digest: "package digest", archive_sha256: "archive SHA-256", signer_fingerprint: "signer" };

/** What the index said about the package now open, compared with its bytes. */
export function renderFoundVia(found: FoundVia): HTMLElement {
  const entries = Object.entries(found.claims) as Array<[keyof FoundVia["claims"], string]>;
  const differs = entries.filter(([, check]) => check === "differs").map(([field]) => CLAIM_LABELS[field]);
  const stated = entries.filter(([, check]) => check !== "not_stated").map(([field]) => CLAIM_LABELS[field]);
  const text =
    differs.length > 0
      ? `Found in ${found.label} ${found.version}, but this package differs from what the index said (${differs.join(", ")}). The index may be stale or wrong; what you see below is what the package itself says and proves.`
      : `Found in ${found.label} ${found.version}. The package matches what the index said (${stated.join(", ") || "nothing stated"}); the checks below are the package's own.`;
  return el("div", { className: `ab-banner ab-banner-${differs.length > 0 ? "warn" : "neutral"} ab-found-via`, attrs: { role: "status", "data-claims": differs.length > 0 ? "differs" : "matches" } }, el("span", { text }));
}

export interface LibraryActions {
  open: (entry: LibraryItemView) => void;
  show: (sessionId: string) => void;
  unpin: (entry: LibraryItemView) => void;
  forget: (entry: LibraryItemView) => void;
}

function libraryRow(entry: LibraryItemView, actions: LibraryActions, recent: boolean): HTMLElement {
  return el(
    "div",
    { className: "ab-library-row", attrs: { "data-package-url": entry.package_url } },
    el("div", { className: "ab-result-head" }, el("strong", { text: entry.name }), el("span", { className: "ab-muted", text: ` ${entry.version} · ${entry.publisher.name}` }), trustChip(entry.trust_status, entry.trust_reason), entry.pinned && recent ? chip("pinned") : null),
    el("p", { className: "ab-hint", text: `${entry.package_url}${entry.advertised_on ? ` (advertised on ${entry.advertised_on})` : ""} · ${recent ? "opened" : "pinned"} ${whenText(entry.at)}` }),
    el(
      "div",
      { className: "ab-actions" },
      entry.open_session_id ? button("Show", () => actions.show(entry.open_session_id!), { variant: "primary" }) : button("Open and verify", () => actions.open(entry), { variant: "primary" }),
      recent ? button("Forget", () => actions.forget(entry), { variant: "ghost" }) : button("Unpin", () => actions.unpin(entry), { variant: "ghost" }),
    ),
  );
}

/** The Library: pinned agents, recently opened ones, and the packages open now. */
export function renderLibrary(view: LibraryView | null, sessions: SessionDescriptor[], sessionRow: (session: SessionDescriptor) => HTMLElement, actions: LibraryActions): HTMLElement[] {
  if (view === null) return [el("p", { className: "ab-busy", text: "Loading…" })];
  return [
    card(
      "Pinned",
      el("p", { className: "ab-hint", text: "Agents you pinned from their agent page. Opening one downloads and verifies the package again; nothing here is trusted because it is pinned." }),
      view.pinned.length === 0 ? el("p", { className: "ab-empty", text: "Nothing pinned yet: open an agent and press “Pin to Library”." }) : list(view.pinned.map((entry) => libraryRow(entry, actions, false))),
    ),
    card(
      "Recently opened",
      view.recent.length === 0 ? el("p", { className: "ab-empty", text: "No agent opened yet." }) : list(view.recent.map((entry) => libraryRow(entry, actions, true))),
    ),
    card(
      "Open now",
      el("p", { className: "ab-hint", text: "Agents open in this browser session; open one to see its authorization, run plan and runs. Past runs stay under Runs after a session ends." }),
      sessions.length === 0 ? el("p", { className: "ab-empty", text: "Nothing is open." }) : list(sessions.map((session) => sessionRow(session))),
    ),
  ];
}
