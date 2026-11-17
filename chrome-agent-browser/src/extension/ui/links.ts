/**
 * Agent Links on the extension's pages (T66; link.v0 §3, §6, §7; D-702…D-704): the review's
 * "Linked agents" card, the join card and the budget-raise card of a run, and the delegation view.
 *
 * Thin views (D-035): every fact shown is one the service worker or the core computed (the
 * `LinksView` of the review, the validated facts of a card, the fold of the run's own audit).
 * Three things here are somebody's words and are shown as such, quoted, with whose they are: a
 * publisher's name for itself, a package's name and description (the publisher's), and a slot's
 * stated reason (the agent's). Everything reaches the document through `textContent`. Nothing here
 * decides: a card shows what an answer would grant, the person presses, and no answer is a no.
 */
import type { JsonObject } from "../../core/json.js";
import type { ActivationNode, DelegationTree, LinkNode } from "../../core/links/delegation.js";
import type { Decision, Reason } from "../../core/types.js";
import type { LinkReviewItem, LinksView, RunView } from "../messages.js";
import type { RunCardPending } from "../storage/runs.js";
import { append, button, card, chip, definition, el, list, row, shortHash, type Child } from "./dom.js";

// -- words --------------------------------------------------------------------------------------
const plural = (count: number, noun: string): string => `${count.toLocaleString("en-US")} ${noun}${count === 1 ? "" : "s"}`;

/** A worst case in words: the six figures of an "at most", each tool named. */
export function figuresText(worst: JsonObject): string {
  const tools = Object.entries((worst.tool_calls as Record<string, number> | undefined) ?? {});
  const parts = [plural(Number(worst.model_calls ?? 0), "model call")];
  if (tools.length > 0) parts.push(`tool calls: ${tools.map(([tool, count]) => `${tool} ×${count}`).join(", ")}`);
  else if (typeof worst.tool_calls === "number") parts.push(plural(worst.tool_calls, "tool call"));
  if (Number(worst.compute_calls ?? 0) > 0) parts.push(plural(Number(worst.compute_calls), "compute call"));
  parts.push(plural(Number(worst.remote_calls ?? 0), "remote call"), `${Number(worst.tokens ?? 0).toLocaleString("en-US")} tokens`);
  if (typeof worst.seconds === "number") parts.push(`${worst.seconds.toLocaleString("en-US")} seconds`);
  return parts.join(" · ");
}

/** Somebody's words, quoted and attributed: never shown as a fact of the browser's. */
export function quoted(text: string, whose: string, className = "ab-quoted"): HTMLElement {
  return el("span", { className, attrs: { "data-words": whose } }, el("q", { text }), el("span", { className: "ab-muted", text: ` (${whose})` }));
}

function trustChip(status: string, signature: string): HTMLElement {
  if (signature !== "valid") return chip("Signature not valid", "bad");
  if (status === "trusted") return chip("Signature valid · publisher trusted", "good");
  if (status === "mismatch") return chip("Signature valid · publisher does not match your pins", "bad");
  return chip("Signature valid · publisher unknown", "warn");
}

const DECISION_WORDS: Record<string, string> = { deny: "denied", once: "allowed once", session: "allowed for this session" };

function reasonsList(problems: readonly Reason[], title: string): HTMLElement | null {
  if (problems.length === 0) return null;
  return el("div", { className: "ab-reasons" }, el("h4", { text: title }), list(problems.map((problem) => el("span", {}, el("code", { text: problem.code }), ` ${problem.message}`))));
}

// -- the review (D-702) -------------------------------------------------------------------------
export interface LinksCardActions {
  /** Fetch the linked agents; the click is the gesture for Chrome's origin prompt. */
  onResolve: (origins: string[]) => void;
  onDecide: (dependency: string, decision: "denied" | "undecided") => void;
  /** Pin the key that signed one linked package, from that package's own session. */
  onTrust: (sessionId: string, signerFingerprint: string, scope: "package" | "publisher") => void;
}

/** Two deliberate presses, narrowest scope first, for one linked publisher's key. */
function linkPinControls(item: LinkReviewItem, onTrust: LinksCardActions["onTrust"]): HTMLElement {
  let armed = false;
  const scope = el("select", { className: "ab-select", attrs: { name: `trust-scope-${item.dependency}`, "aria-label": "Trust scope" } });
  scope.append(el("option", { text: `Only this agent (${item.package.package_id})`, attrs: { value: "package" } }), el("option", { text: `Any agent signed with this key by ${item.publisher.claimed_id}`, attrs: { value: "publisher" } }));
  const confirm = button("Trust this publisher key", () => {
    if (!armed) {
      armed = true;
      confirm.textContent = "Press again to trust this key";
      confirm.className = "ab-button ab-button-danger";
      return;
    }
    onTrust(item.session_id, item.publisher.signer_fingerprint ?? "", scope.value === "publisher" ? "publisher" : "package");
  }, { variant: "primary" });
  confirm.dataset.linkTrust = item.dependency;
  return el("div", { className: "ab-pin" }, el("p", { className: "ab-hint", text: "Trusting a key is a lasting decision on this device, made for this key alone: the agent that links it does not vouch for it. It grants no permission." }), el("label", { className: "ab-field" }, "Scope ", scope), confirm);
}

function linkItem(item: LinkReviewItem, actions: LinksCardActions, busy: boolean): HTMLElement {
  const denied = item.decision === "denied";
  const granted = item.permissions.filter((permission) => (item.decided.decisions[permission.id] ?? "deny") !== "deny");
  const refused = item.permissions.filter((permission) => (item.decided.decisions[permission.id] ?? "deny") === "deny");
  const decisionChip = denied ? chip("Denied by you", "bad") : item.decision === "accepted" ? chip("Accepted", "good") : chip("Not decided yet", "neutral");
  const node = el(
    "div",
    { className: "ab-link-item", attrs: { "data-dependency": item.dependency, "data-decision": item.decision, "data-trust": item.publisher.trust_status } },
    el("h4", { className: "ab-link-name" }, quoted(item.package.name, "the publisher's name for it"), " ", decisionChip),
    row("Package", el("code", { text: `${item.package.package_id} ${item.package.version}` }), " · digest ", el("code", { text: shortHash(item.package.digest) })),
    item.package.description ? row("Described as", quoted(item.package.description, "the publisher's words")) : null,
    row("Asked by", item.steps.length > 0 ? item.steps.map((step) => step.step).join(", ") : "no step of this agent"),
  );
  if (denied) {
    node.append(el("p", { className: "ab-hint ab-link-denied", text: "This run will not ask it. The steps that would are unbound: a role whose only step asks it is never chosen, and nothing of it is fetched again, run or contacted." }));
    return node;
  }
  append(node, [
    row("It would be able to", granted.length > 0 ? list(granted.map((permission) => el("span", {}, el("code", { text: permission.id }), ` (${permission.kind}), ${DECISION_WORDS[item.decided.decisions[permission.id] as Decision] ?? "allowed"}`))) : "nothing"),
    refused.length > 0 ? row("It would not", refused.map((permission) => permission.id).join(", ")) : null,
    row(
      "Its tools",
      item.tools.length > 0
        ? list(item.tools.map((tool) => el("span", { attrs: { "data-tool": tool.id } }, el("code", { text: tool.id }), tool.endpoint ? el("span", {}, " → ", el("code", { text: `${tool.method ?? "POST"} ${tool.endpoint}` })) : ` (${tool.execution})`, item.decided.tool_approvals[tool.id] === true ? chip("approved", "good") : chip("not approved", "neutral"))))
        : "none",
    ),
    row("Your records it asks for", item.records.length > 0 ? item.records.join(", ") : "none"),
    row("Model", item.model.tasks.length > 0 ? `your model, for ${item.model.tasks.map((task) => `${task.id} (${[...task.capabilities, `${task.context_window.toLocaleString("en-US")} tokens of context`].join(", ")})`).join("; ")}${item.model.privacy ? ` · ${item.model.privacy}` : ""}` : "none"),
    row("At most, each time it is asked", figuresText(item.worst_case)),
    reasonsList(item.problems, "Before it can be used"),
  ]);
  if (item.publisher.trust_status !== "trusted" && item.publisher.signature_status === "valid") node.append(linkPinControls(item, actions.onTrust));
  void busy;
  return node;
}

/** The review's card: the caller's linked agents, one group per publisher key, and the composed "at most". */
export function linksCard(view: LinksView, actions: LinksCardActions, busy: boolean): HTMLElement {
  const slots = ((view.composed.slots as JsonObject[] | undefined) ?? []) as Array<JsonObject & { slot: string; step: string; max_joins: number; view: string[]; ceiling: JsonObject }>;
  const children: Child[] = [el("p", { className: "ab-hint", text: view.note })];
  if (view.locators.length > 0 && !view.resolved) {
    const origins = [...new Set(view.locators.map((item) => item.origin).filter((origin): origin is string => origin !== null))].sort();
    const load = button("Load linked agents", () => actions.onResolve(origins), { variant: "primary", disabled: busy });
    load.dataset.links = "resolve";
    children.push(
      el("p", { text: `This agent asks ${plural(view.locators.length, "other agent")} for help, each pinned by its digest in the signed manifest. They are not loaded yet.` }),
      list(view.locators.map((item) => el("span", { attrs: { "data-locator": item.dependency } }, el("code", { text: `${item.package_id} ${item.version}` }), " from ", el("code", { text: item.origin ?? item.locator })))),
      load,
      el("p", { className: "ab-hint", text: "Loading fetches each package from the address its record names: one request each, with no cookie and no referrer. Nothing runs, and nothing is granted." }),
    );
  }
  if (view.resolved && view.links.length > 0) {
    for (const group of view.publishers) {
      const items = view.links.filter((item) => group.dependencies.includes(item.dependency));
      const first = items[0]!;
      const decide = group.denied
        ? button("Allow this publisher again", () => actions.onDecide(first.dependency, "undecided"), { disabled: busy })
        : button("Deny this publisher", () => actions.onDecide(first.dependency, "denied"), { variant: "danger", disabled: busy });
      decide.dataset.linkDecide = first.dependency;
      children.push(
        el(
          "div",
          { className: "ab-link-publisher", attrs: { "data-publisher": group.signer_fingerprint, "data-denied": String(group.denied) } },
          el("div", { className: "ab-link-publisher-head" }, el("strong", {}, quoted(group.claimed_name, "the publisher's name for itself")), " ", trustChip(group.trust_status, first.publisher.signature_status)),
          row("Signer key", el("code", { text: shortHash(group.signer_fingerprint, 20) })),
          ...items.map((item) => linkItem(item, actions, busy)),
          el("div", { className: "ab-actions" }, decide),
        ),
      );
    }
  }
  const composed = view.composed.worst_case as JsonObject;
  if (view.resolved) {
    children.push(el("div", { className: "ab-link-at-most", attrs: { "data-at-most": "composed" } }, el("h4", { text: "At most, in any run, with its linked agents" }), el("p", { text: figuresText(composed) }), el("p", { className: "ab-hint", text: "A linked agent's tool is named with the link that asks it. A denied publisher's part is left out." })));
  }
  for (const slot of slots) {
    const forbidden = view.run_cards.join === "forbid";
    children.push(
      el(
        "div",
        { className: "ab-link-slot", attrs: { "data-slot": slot.slot, "data-join": view.run_cards.join } },
        el("h4", { text: "During a run it may ask an agent it finds" }),
        forbidden
          ? el("p", { text: `Your policy ${view.run_cards.policy ?? ""} forbids joining an agent found during a run: this step answers “policy”, nothing is looked at and no card is shown.` })
          : el("p", { text: `Step ${slot.step} may look at up to three pages (an address you give it, or one its search returns) and fetch one package from the first that offers one. You are asked on a card before anything of that package reaches the model or runs; no answer is a no. At most ${plural(slot.max_joins, "card")} for this step and ${view.run_cards.max_join_cards} in a run.` }),
        forbidden ? null : el("p", { className: "ab-hint ab-link-slot-origins", text: "This browser reads only sites you allowed it to read (Settings → Permissions). A page it may not read is listed in the run as not read, and the step then finds nothing." }),
        row("It may send that agent", slot.view.length > 0 ? slot.view.join(", ") : "nothing"),
        row("At most, for this step", figuresText(slot.ceiling)),
        el("p", { className: "ab-hint", text: `One of those model calls is this agent's own, to write its request; the rest is the most the joined agent may use, and “${slot.slot}:*” stands for its tools, whose names are not known before the join. The “at most” above already holds this, so it does not change when you accept a join.` }),
      ),
    );
  }
  if (view.run_cards.raise === "forbid") children.push(el("p", { className: "ab-hint", attrs: { "data-raise": "forbid" }, text: `Your policy ${view.run_cards.policy ?? ""} forbids raising your run limit during a run: a run that reaches it stops there, without asking.` }));
  return el("div", { attrs: { "data-links": view.resolved ? "resolved" : "unresolved" } }, card("Linked agents", ...children));
}

/** The origins of the tools the review would approve for the linked agents the person did not deny (D-193): asked of Chrome in the Authorize click. */
export function linkOrigins(view: LinksView | null): string[] {
  const origins = new Set<string>();
  for (const item of view?.links ?? []) {
    if (item.decision === "denied") continue;
    for (const tool of item.tools) {
      if (item.decided.tool_approvals[tool.id] !== true || tool.endpoint === null) continue;
      try {
        const url = new URL(tool.endpoint);
        if (url.protocol === "https:") origins.add(url.origin);
      } catch {
        // not a URL: the worker refuses the tool by name
      }
    }
  }
  return [...origins].sort();
}

// -- a run's cards (D-703) ----------------------------------------------------------------------
export interface RunCardActions {
  /** `origins`: what the approved tools reach, asked of Chrome in the click before the answer is sent. */
  onDecide: (cardId: string, answer: { accepted: boolean; grants?: Record<string, string>; approvedTools?: string[]; pin?: "package" | "publisher" | null }, origins: string[]) => void;
}

interface JoinFacts extends JsonObject {
  slot: string;
  publisher: { signer: string; trust: string };
  package: { package_id: string; version: string; digest: string; archive_sha256: string; name: string; description: string };
  source: { page_url: string | null; package_url: string | null };
  requirements: {
    permissions: Array<{ id: string; kind: string; description: string | null; required: boolean | null; resources: string[] | null }>;
    tools: Array<{ id: string; execution: string; endpoint: string | null; method: string | null; domains: string[]; permissions: string[]; side_effects: string }>;
    allowed_domains: string[];
    model: { tasks: Array<{ id: string; capabilities: string[]; context_window: number }>; privacy: string | null };
  };
  view: string[];
  worst_case: JsonObject;
  ceiling: JsonObject;
  at_most_unchanged: boolean;
  left: { tokens: number; remote_calls: number };
  reason: string | null;
  cards: { slot: { shown: number; max: number }; run: { shown: number; max: number } };
}

const deadlineText = (pending: RunCardPending): string => {
  const deadline = new Date(Date.parse(pending.requested_at) + pending.timeout_seconds * 1000);
  return Number.isNaN(deadline.getTime()) ? `within ${Math.floor(pending.timeout_seconds)} seconds` : `by ${deadline.toLocaleTimeString()}`;
};

/**
 * The join card (L-34; D-681's facts in their order): the publisher's key and trust state, the
 * package, where it was found, what it would use, what the agent may send it, why the agent asks,
 * its worst case inside the slot's ceiling, what the run has left. Declining is the default.
 */
export function joinCard(pending: RunCardPending, actions: RunCardActions, busy: boolean): HTMLElement {
  const facts = pending.facts as unknown as JoinFacts;
  const requirements = facts.requirements;
  const records = requirements.permissions.filter((permission) => permission.kind === "personal.read" || permission.kind === "memory.read").flatMap((permission) => permission.resources ?? []);
  // What an acceptance would grant: each permission the package declares, chosen here; required ones start allowed for the session.
  const grantSelects = new Map<string, HTMLSelectElement>();
  const permissionRows = requirements.permissions.map((permission) => {
    const select = el("select", { className: "ab-select", attrs: { name: `grant-${permission.id}`, "aria-label": `Decision for ${permission.id}` } });
    select.append(el("option", { text: "Deny", attrs: { value: "deny" } }), el("option", { text: "Allow once", attrs: { value: "once" } }), el("option", { text: "Allow for this session", attrs: { value: "session" } }));
    select.value = permission.required === true ? "session" : "deny";
    grantSelects.set(permission.id, select);
    return el("span", { attrs: { "data-permission": permission.id } }, el("code", { text: permission.id }), ` (${permission.kind}${permission.required === true ? ", required by the package" : ""}) `, select, permission.description ? el("span", { className: "ab-muted" }, " ", quoted(permission.description, "the publisher's words")) : null);
  });
  const toolChecks = new Map<string, HTMLInputElement>();
  const toolRows = requirements.tools.map((tool) => {
    const check = el("input", { attrs: { type: "checkbox", name: `tool-${tool.id}`, "aria-label": `Approve ${tool.id}` } });
    check.checked = true;
    toolChecks.set(tool.id, check);
    return el("label", { attrs: { "data-tool": tool.id } }, check, " ", el("code", { text: tool.id }), tool.endpoint ? el("span", {}, " → ", el("code", { text: `${tool.method ?? "POST"} ${tool.endpoint}` })) : ` (${tool.execution})`, ` · needs ${tool.permissions.join(", ") || "no permission"} · ${tool.side_effects}`);
  });
  const pin = el("select", { className: "ab-select", attrs: { name: "join-pin", "aria-label": "Trust this publisher key" } });
  pin.append(el("option", { text: "Do not pin its key", attrs: { value: "" } }), el("option", { text: `Trust this key for this agent only (${facts.package.package_id})`, attrs: { value: "package" } }), el("option", { text: "Trust this key for any agent it signs for this publisher", attrs: { value: "publisher" } }));
  const accept = button("Use it for this run", () => {
    const grants: Record<string, string> = {};
    for (const [id, select] of grantSelects) if (select.value === "once" || select.value === "session") grants[id] = select.value;
    const approved = [...toolChecks].filter(([, check]) => check.checked).map(([id]) => id);
    const origins = new Set<string>();
    for (const tool of requirements.tools) {
      if (!approved.includes(tool.id) || tool.endpoint === null) continue;
      try {
        origins.add(new URL(tool.endpoint).origin);
      } catch {
        // not a URL: the host refuses the tool by name
      }
    }
    actions.onDecide(pending.card_id, { accepted: true, grants, approvedTools: approved, pin: pin.value === "package" || pin.value === "publisher" ? pin.value : null }, [...origins].sort());
  }, { disabled: busy });
  accept.dataset.cardDecide = "accept";
  const decline = button("No, continue without it", () => actions.onDecide(pending.card_id, { accepted: false }, []), { variant: "primary", disabled: busy });
  decline.dataset.cardDecide = "decline";
  return el(
    "div",
    { className: "ab-run-card ab-join-card", attrs: { role: "group", "aria-label": "An agent found during this run", "data-card": pending.card_id, "data-kind": pending.kind, "data-slot": facts.slot } },
    el("h3", { className: "ab-consent-title", text: "This run found another agent. Use it?" }),
    el("p", { className: "ab-hint", text: "Nothing of it has reached the model or run. This browser fetched its page and its package with a plain request, verified the package, and computed what follows from its signed bytes." }),
    definition([
      ["Publisher key", el("span", {}, el("code", { text: shortHash(facts.publisher.signer, 20) }), " ", trustChip(facts.publisher.trust, "valid"))],
      ["Agent", el("span", {}, el("code", { text: `${facts.package.package_id} ${facts.package.version}` }), " · digest ", el("code", { text: shortHash(facts.package.digest) }))],
      ["Named", quoted(facts.package.name, "the publisher's name for it")],
      ["Described as", quoted(facts.package.description, "the publisher's words")],
      ["Found on", el("span", {}, el("code", { text: facts.source.page_url ?? "" }), " · package ", el("code", { text: facts.source.package_url ?? "" }))],
      ["Its tools", toolRows.length > 0 ? list(toolRows) : "none"],
      ["Its permissions", permissionRows.length > 0 ? list(permissionRows) : "none"],
      ["Your records it asks for", records.length > 0 ? records.join(", ") : "none"],
      ["Model", requirements.model.tasks.length > 0 ? `your model, for ${requirements.model.tasks.map((task) => task.id).join(", ")}${requirements.model.privacy ? ` · ${requirements.model.privacy}` : ""}` : "none"],
      ["The agent may send it", facts.view.length > 0 ? facts.view.join(", ") : "nothing"],
      ["Why the agent asks", facts.reason ? quoted(facts.reason, "the agent's words") : "it states no reason"],
      ["At most, if you accept", figuresText(facts.worst_case)],
      ["Within the step's ceiling", figuresText(facts.ceiling)],
      ["The “at most” you accepted", facts.at_most_unchanged ? "unchanged: it already held this join at the ceiling" : "changed"],
      ["This run has left", `${facts.left.tokens.toLocaleString("en-US")} tokens · ${plural(facts.left.remote_calls, "remote call")}`],
      ["Cards", `${facts.cards.slot.shown} of ${facts.cards.slot.max} for this step · ${facts.cards.run.shown} of ${facts.cards.run.max} in this run`],
    ]),
    el("label", { className: "ab-field" }, "Its key ", pin),
    el("p", { className: "ab-hint ab-card-deadline", text: `Answer ${deadlineText(pending)}. No answer is a no, and a no lasts for this run: this publisher's key is not offered again in it.` }),
    el("div", { className: "ab-inline" }, decline, accept),
  );
}

/** The budget-raise card (L-43): the person's own run limit, what was needed, what it would become. Keeping the limit is the default. */
export function raiseCard(pending: RunCardPending, actions: RunCardActions, busy: boolean): HTMLElement {
  const facts = pending.facts as JsonObject & { limit: string; from: number; to: number; needed: number; used: number; package_cap: number; node_id: string | null; reason: string | null };
  const unit = facts.limit === "remote_calls" ? "remote calls" : "tokens";
  const number = (value: number) => value.toLocaleString("en-US");
  const keep = button("No, keep my limit", () => actions.onDecide(pending.card_id, { accepted: false }, []), { variant: "primary", disabled: busy });
  keep.dataset.cardDecide = "decline";
  const raise = button(`Raise my limit to ${number(facts.to)} ${unit} for this run`, () => actions.onDecide(pending.card_id, { accepted: true }, []), { disabled: busy });
  raise.dataset.cardDecide = "accept";
  return el(
    "div",
    { className: "ab-run-card ab-raise-card", attrs: { role: "group", "aria-label": "This run reached your limit", "data-card": pending.card_id, "data-kind": pending.kind } },
    el("h3", { className: "ab-consent-title", text: `This run reached your limit of ${number(facts.from)} ${unit}` }),
    el("p", { className: "ab-hint", text: "The limit is yours (Settings → Run limits), not the agent's: the agent's own cap is never raised. This is asked once in a run." }),
    definition([
      ["Used and held so far", `${number(facts.used)} ${unit}`],
      ["The next step needs", `${number(facts.needed)} ${unit}`],
      ["Your limit would become", `${number(facts.to)} ${unit} (from ${number(facts.from)})`],
      ["The agent's own cap", `${number(facts.package_cap)} ${unit}: what you accepted before the run still holds`],
      ["Asked at", el("code", { text: facts.node_id ?? pending.node_id ?? "the run" })],
      ["Why the agent asks", facts.reason ? quoted(facts.reason, "the agent's words") : "it states no reason"],
    ]),
    el("p", { className: "ab-hint ab-card-deadline", text: `Answer ${deadlineText(pending)}. No answer is a no: the run stops at your limit.` }),
    el("div", { className: "ab-inline" }, keep, raise),
  );
}

export function runCard(pending: RunCardPending, actions: RunCardActions, busy: boolean): HTMLElement {
  return pending.kind === "budget.raise" ? raiseCard(pending, actions, busy) : joinCard(pending, actions, busy);
}

// -- the delegation view (D-704) ----------------------------------------------------------------
const LINK_STATE: Record<string, { text: string; tone: "neutral" | "good" | "warn" | "bad" }> = {
  working: { text: "working", tone: "neutral" },
  answered: { text: "answered", tone: "good" },
  failed: { text: "failed", tone: "bad" },
  refused: { text: "not started", tone: "warn" },
  denied: { text: "denied by you", tone: "bad" },
  looking: { text: "found, deciding", tone: "neutral" },
  declined: { text: "declined by you", tone: "warn" },
  not_joined: { text: "not joined", tone: "warn" },
};

function usageText(usage: JsonObject | null): string {
  if (usage === null) return "not settled yet";
  const tools = Object.entries((usage.tool_calls as Record<string, number> | undefined) ?? {});
  return `${plural(Number(usage.model_calls ?? 0), "model call")} · ${tools.length > 0 ? tools.map(([tool, count]) => `${tool} ×${count}`).join(", ") : "no tool call"} · ${plural(Number(usage.remote_calls ?? 0), "remote call")} · ${Number(usage.tokens ?? 0).toLocaleString("en-US")} tokens`;
}

function linkLine(link: LinkNode, names: ReadonlyMap<string, string>): HTMLElement {
  const state = LINK_STATE[link.state] ?? { text: link.state, tone: "neutral" as const };
  const rows: Array<[string, Child]> = [];
  if (link.package_id) rows.push(["Package", el("span", {}, el("code", { text: link.package_id }), link.digest ? el("span", {}, " · digest ", el("code", { text: shortHash(link.digest) })) : null)]);
  if (link.fetches) rows.push(["Looked at", link.fetches.length > 0 ? list(link.fetches.map((fetch) => el("span", {}, el("code", { text: String((fetch as JsonObject).url) }), ` (${String((fetch as JsonObject).kind)}: ${String((fetch as JsonObject).status)})`))) : "nothing"]);
  if (link.decision) rows.push(["Decision", `${link.decision.accepted === true ? "accepted" : "not accepted"} by ${link.decision.decided_by === "person" ? "you" : "the runtime"}${link.decision.reason ? ` (${String(link.decision.reason)}${link.decision.figure ? `: ${String(link.decision.figure)}` : ""})` : ""}`]);
  if (link.reserved) rows.push(["Held for it", `${Number(link.reserved.tokens ?? 0).toLocaleString("en-US")} tokens · ${plural(Number(link.reserved.remote_calls ?? 0), "remote call")}`]);
  if (link.usage || link.state === "working") rows.push(["It used", usageText(link.usage)]);
  if (link.code && link.state !== "declined") rows.push(["Code", el("code", { text: link.code })]);
  if (link.input_hash) rows.push(["What was sent", el("span", {}, "sha256 ", el("code", { text: shortHash(link.input_hash) }))]);
  if (link.result_hash) rows.push(["What came back", el("span", {}, "sha256 ", el("code", { text: shortHash(link.result_hash) }))]);
  const title = link.kind === "join" ? `an agent found during the run (${link.name})` : (names.get(link.name) ?? link.name);
  return el(
    "li",
    { className: `ab-delegation-link ab-delegation-${link.state}`, attrs: { "data-link": link.name, "data-kind": link.kind, "data-state": link.state, "data-package": link.package_id ?? "" } },
    el("span", { className: "ab-delegation-link-head" }, link.kind === "join" ? "Asked " : "Asked ", el("strong", { text: title }), " ", chip(state.text, state.tone)),
    rows.length > 0 ? definition(rows) : null,
  );
}

function activationLine(activation: ActivationNode, names: ReadonlyMap<string, string>): HTMLElement {
  const state = activation.state === "working" ? chip("working", "neutral") : activation.state === "failed" ? chip("failed", "bad") : chip(activation.next === "done" ? "answered, done" : `handed to ${activation.next ?? "?"}`, "good");
  const node = el(
    "li",
    { className: `ab-delegation-activation ab-delegation-${activation.state}`, attrs: { "data-activation": activation.role, "data-hop": String(activation.hop), "data-state": activation.state } },
    el("span", { className: "ab-delegation-role" }, el("strong", { text: activation.role }), activation.activation > 1 ? ` (time ${activation.activation})` : "", " ", state, activation.message_hash ? el("span", { className: "ab-muted" }, " · message sha256 ", el("code", { text: shortHash(activation.message_hash) })) : null),
  );
  if (activation.links.length > 0) node.append(el("ul", { className: "ab-delegation-links" }, ...activation.links.map((link) => linkLine(link, names))));
  return node;
}

/**
 * The delegation view: who was asked, who is working and who answered, each link's reservation and
 * settlement. Drawn from the fold of the run's own audit and from nothing the package says: a
 * message or an input is a hash, never a text.
 */
export function delegationView(tree: DelegationTree, links: RunView["links"]): HTMLElement {
  const names = new Map((links ?? []).map((link) => [link.dependency, `${link.package_id} (${link.dependency})`]));
  const denied = (links ?? []).filter((link) => link.decision === "denied");
  const node = el("div", { className: "ab-delegation-view", attrs: { "data-linked": String(tree.linked) } }, el("h4", { text: "Who was asked" }));
  if (tree.activations.length > 0) node.append(el("ol", { className: "ab-delegation-activations" }, ...tree.activations.map((activation) => activationLine(activation, names))));
  if (tree.links.length > 0) node.append(el("ul", { className: "ab-delegation-links" }, ...tree.links.map((link) => linkLine(link, names))));
  if (denied.length > 0) node.append(el("p", { className: "ab-hint", attrs: { "data-denied": denied.map((link) => link.dependency).join(",") }, text: `Not asked, because you denied the publisher: ${denied.map((link) => `${link.package_id} (${link.dependency})`).join(", ")}.` }));
  if (tree.raise) {
    const unit = tree.raise.limit === "remote_calls" ? "remote calls" : "tokens";
    node.append(el("p", { className: "ab-delegation-raise", attrs: { "data-raise": tree.raise.state }, text: `Your limit of ${tree.raise.from.toLocaleString("en-US")} ${unit} was reached${tree.raise.node_id ? ` at ${tree.raise.node_id}` : ""}: ${tree.raise.state === "raised" ? `you raised it to ${tree.raise.to.toLocaleString("en-US")}` : tree.raise.state === "asked" ? `asking whether to raise it to ${tree.raise.to.toLocaleString("en-US")}` : "it was kept"}.` }));
  }
  node.append(el("p", { className: "ab-hint", text: "Drawn by this browser from the run's own record. What crossed between agents is shown as a hash; the texts are in the run's files." }));
  return node;
}

