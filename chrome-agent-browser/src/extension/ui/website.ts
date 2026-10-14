/**
 * The website card: what a page advertises, as untrusted locations with Inspect. Shared by
 * the side panel (from the tab's content script) and the full page (from the address bar).
 */
import type { Candidate, DiscoveryStatus } from "../../core/discovery.js";
import { button, card, chip, el, list } from "./dom.js";

export interface WebsiteCardInput {
  pageUrl: string;
  pageOrigin: string;
  status: DiscoveryStatus;
  candidates: Candidate[];
  linksNotListed: number;
}

export interface WebsiteCardActions {
  /** "Always detect agents on this site" (T16, D-190): ask Chrome for the site's origin in the click, then tell the worker. */
  onDetectSite?: (origin: string) => void;
  /** Whether the site's origin is already granted (the button then says so). */
  siteDetected?: boolean;
}

export function renderWebsiteCard(input: WebsiteCardInput, onInspect: (candidate: Candidate) => void, actions: WebsiteCardActions = {}): HTMLElement {
  const accepted = input.candidates.filter((candidate) => candidate.accepted);
  const rejected = input.candidates.filter((candidate) => !candidate.accepted);
  const intro =
    accepted.length === 0
      ? input.candidates.length === 0
        ? "This website advertises no agent package."
        : "This website advertises agent packages, but none at an address this browser accepts."
      : accepted.length === 1
        ? "This website says an agent package is available at the address below. That is only a location: who published it, whether it is intact and signed, and what it would be allowed to do are unknown until you inspect it."
        : "This website advertises several agent packages. Each is only a location until you inspect it; none is chosen for you.";
  return card(
    "Website",
    el("p", { className: "ab-website-url", text: input.pageUrl }),
    accepted.length > 0 ? chip(`${accepted.length} agent package${accepted.length === 1 ? "" : "s"} advertised`, "warn") : null,
    el("p", { className: "ab-hint", text: intro }),
    accepted.length > 0
      ? list(
          accepted.map((candidate) =>
            el(
              "div",
              { className: "ab-candidate", attrs: { "data-candidate": String(candidate.index) } },
              el("code", { className: "ab-candidate-url", text: candidate.resolved_url ?? "" }),
              el("div", { className: "ab-candidate-meta" }, chip("Unverified candidate", "warn"), candidate.type_hint ? chip(candidate.type_hint, "neutral") : null),
              button("Inspect agent package", () => onInspect(candidate), { variant: "primary" }),
            ),
          ),
          "ab-candidate-list",
        )
      : null,
    rejected.length > 0
      ? el(
          "div",
          { className: "ab-rejected" },
          el("h4", { text: "Not accepted" }),
          list(rejected.map((candidate) => el("div", {}, el("code", { text: candidate.href ?? "(no href)" }), " ", chip(candidate.rejection_reason ?? "rejected", "bad"), el("p", { className: "ab-hint", text: candidate.rejection_message ?? "" })))),
        )
      : null,
    input.linksNotListed > 0 ? el("p", { className: "ab-hint", text: `${input.linksNotListed} more advertised link${input.linksNotListed === 1 ? " was" : "s were"} not listed.` }) : null,
    actions.onDetectSite
      ? el(
          "div",
          { className: "ab-actions ab-detect-site" },
          actions.siteDetected
            ? chip("Agents detected on this site", "good")
            : button("Always detect agents on this site", () => actions.onDetectSite?.(input.pageOrigin), { variant: "ghost", title: `Let this browser read ${input.pageOrigin} pages for agent links and show the badge there` }),
          el("p", { className: "ab-hint", text: actions.siteDetected ? "This browser reads this site's pages for agent links and shows the badge. Revoke it under Settings → Permissions." : "By default this browser reads a page only when you click its button. Allowing this site shows the badge on its pages from now on." }),
        )
      : null,
    el("p", { className: "ab-hint", text: "rel=\"agent-package\" is an experimental WebAgents convention, not a web standard. Only packages served by the page's own origin are accepted." }),
  );
}
