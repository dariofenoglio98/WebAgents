/**
 * The proposal review sheet on the run page (T19; design `memory-ui.md` §5; memory.v0 M-41, M-42,
 * M-44; D-223): what a completed run proposes to remember, one card per proposal with Accept,
 * Edit and Reject, the facts acceptance will use (what an update keeps from the record it
 * replaces, an identity match, a replaced-since target, a new type, a sealed required field to
 * type), Accept all and Reject all, and the decisions sent together after the last one. Nothing
 * is written until then; afterwards the sheet collapses to "Remembered n things".
 */
import type { JsonObject, JsonValue } from "../../../core/json.js";
import { relationWords } from "../../../core/memory/words.js";
import type { ReviewDecision } from "../../../core/memory/proposals.js";
import type { Request, ReviewOutcome, RunReviewView } from "../../messages.js";
import { button, chip, el, list } from "../dom.js";
import { fill, MASK, STRINGS } from "./strings.js";

export interface ReviewState {
  runId: string;
  view: RunReviewView | null;
  error: string | null;
  /** The person's decision per proposal index, until the last one sends them together. */
  decisions: Record<number, "accept" | "reject">;
  /** Edits per proposal (title, body, tags, unsealed fields as JSON text, typed sealed values). */
  edits: Record<number, { open: boolean; title: string; body: string; tags: string; fields: string; sealed: Record<string, string> }>;
  replacedSince: Record<number, "head" | "keep_new">;
  identity: Record<number, "replace" | "keep_both">;
  busy: boolean;
  outcome: ReviewOutcome | null;
}

export function newReviewState(runId: string): ReviewState {
  return { runId, view: null, error: null, decisions: {}, edits: {}, replacedSince: {}, identity: {}, busy: false, outcome: null };
}

export interface ReviewActions {
  send<T>(request: Request): Promise<T>;
  rerender(): void;
  /** Open the Memory page, on the record just accepted when one is known (B-215). */
  openMemory(recordId: string | null): void;
  /** The store is locked and a decision needs it: open the Unlock sheet, then run `then`. */
  unlock?: (then: () => void) => void;
  locked: boolean;
}

export function reviewDecisions(state: ReviewState): ReviewDecision[] {
  const view = state.view?.review;
  if (!view) return [];
  return view.document.proposals.map((proposal, index) => {
    const decision = state.decisions[index] ?? "reject";
    const edit = state.edits[index];
    const out: ReviewDecision = { index, decision };
    if (decision === "accept" && edit) {
      const edits: NonNullable<ReviewDecision["edits"]> = {};
      if (edit.title !== proposal.title) edits.title = edit.title;
      if (edit.body !== (proposal.body ?? "")) edits.body = edit.body;
      const tags = edit.tags.split(",").map((tag) => tag.trim()).filter(Boolean);
      if (tags.join(",") !== (proposal.tags ?? []).join(",")) edits.tags = tags;
      try {
        const fields = JSON.parse(edit.fields) as JsonObject;
        if (JSON.stringify(fields) !== JSON.stringify(proposal.fields)) edits.fields = fields;
      } catch {
        // an unparsable edit keeps the proposal's fields
      }
      const sealed = Object.fromEntries(Object.entries(edit.sealed).filter(([, value]) => value.length > 0));
      if (Object.keys(sealed).length > 0) edits.sealed_values = sealed;
      if (Object.keys(edits).length > 0) out.edits = edits;
    } else if (decision === "accept") {
      const sealed = Object.fromEntries(Object.entries(state.edits[index]?.sealed ?? {}).filter(([, value]) => value.length > 0));
      if (Object.keys(sealed).length > 0) out.edits = { sealed_values: sealed };
    }
    if (state.replacedSince[index]) out.replaced_since = state.replacedSince[index];
    if (state.identity[index]) out.identity = state.identity[index];
    return out;
  });
}

/** Whether every proposal has a decision and every accepted create with a sealed required field has it typed. */
export function reviewComplete(state: ReviewState): { complete: boolean; missing: number[] } {
  const view = state.view?.review;
  if (!view) return { complete: false, missing: [] };
  const missing: number[] = [];
  for (const facts of view.facts) {
    const decision = state.decisions[facts.index];
    if (decision === undefined) missing.push(facts.index);
    else if (decision === "accept" && facts.sealed_required.some((field) => !(state.edits[facts.index]?.sealed[field.pointer] ?? "").length)) missing.push(facts.index);
  }
  return { complete: missing.length === 0, missing };
}

export async function loadReview(state: ReviewState, actions: ReviewActions): Promise<void> {
  try {
    state.view = await actions.send<RunReviewView>({ type: "memory.review", runId: state.runId });
    state.error = null;
  } catch (error) {
    state.error = error instanceof Error ? error.message : "Could not read the proposals.";
  }
  actions.rerender();
}

function ensureEdit(state: ReviewState, index: number, proposal: RunReviewView["review"] extends infer R ? (R extends { document: { proposals: Array<infer P> } } ? P : never) : never): NonNullable<ReviewState["edits"][number]> {
  const p = proposal as { title: string; body?: string; tags?: string[]; fields: JsonObject };
  state.edits[index] ??= { open: false, title: p.title, body: p.body ?? "", tags: (p.tags ?? []).join(", "), fields: JSON.stringify(p.fields, null, 1), sealed: {} };
  return state.edits[index]!;
}

function fieldsLine(fields: JsonObject): string {
  return Object.entries(fields)
    .map(([name, value]) => `${name.replace(/_/gu, " ")}: ${typeof value === "string" ? value : JSON.stringify(value)}`)
    .join(" · ");
}

function decide(state: ReviewState, actions: ReviewActions): void {
  const { complete } = reviewComplete(state);
  if (!complete || state.busy) return;
  const work = () => {
    state.busy = true;
    actions.rerender();
    void actions.send<ReviewOutcome>({ type: "memory.decide", runId: state.runId, decisions: reviewDecisions(state) }).then(
      (outcome) => {
        state.outcome = outcome;
        state.busy = false;
        void loadReview(state, actions);
      },
      (error: unknown) => {
        state.busy = false;
        state.error = error instanceof Error ? error.message : "The decisions could not be applied.";
        actions.rerender();
      },
    );
  };
  if (actions.locked && actions.unlock) actions.unlock(work);
  else work();
}

export function renderReview(state: ReviewState, actions: ReviewActions): HTMLElement | null {
  const view = state.view;
  if (view === null) return state.error ? el("div", { className: "ab-banner ab-banner-bad", text: state.error }) : null;
  if (view.decided) {
    return el(
      "section",
      { className: "ab-review ab-review-done" },
      el("div", { className: "ab-banner ab-banner-good" }, el("strong", { text: fill("memory.review.done", { n: view.decided.accepted }) }), el("span", { text: view.decided.rejected > 0 ? ` · ${view.decided.rejected} rejected` : "" }), el("span", { text: " · " }), button("Open in Memory", () => actions.openMemory(state.outcome?.accepted[0]?.id ?? null))),
    );
  }
  if (view.review === null) {
    if (view.count > 0 && view.offered === 0) return el("p", { className: "ab-hint ab-review-not-offered", text: fill("memory.review.not_offered", { n: view.count, reason: view.reason ?? "not offered" }) });
    return null;
  }
  const review = view.review;
  const cards = review.document.proposals.map((proposal, index) => {
    const facts = review.facts[index]!;
    const decision = state.decisions[index];
    const edit = ensureEdit(state, index, proposal);
    const links = [...(proposal.links ?? [])].map((link) => `${relationWords(link.rel as never).forward} → ${link.to.startsWith("#") ? `proposal ${Number(link.to.slice(1)) + 1}` : (facts.link_titles[link.to] ?? (link.to === "self" ? "Me" : link.to))}`);
    const rejectedLinks = (proposal.links ?? []).filter((link) => link.to.startsWith("#") && state.decisions[Number(link.to.slice(1))] === "reject");
    const kept: string[] = [...facts.kept.sealed.map((field) => `${field} ${MASK}`), ...facts.kept.links.map((link) => `${relationWords(link.rel).forward} → ${link.title}`), ...facts.kept.related.map((title) => `in text: ${title}`)];
    const sealedInputs = facts.sealed_required.map((field) => {
      const input = el("input", { className: "ab-input", attrs: { type: "text", name: `sealed-${index}-${field.pointer}`, placeholder: fill("memory.review.sealed_input", { field: field.field }), autocomplete: "off" } });
      input.value = edit.sealed[field.pointer] ?? "";
      input.addEventListener("input", () => {
        edit.sealed[field.pointer] = input.value;
      });
      return el("label", { className: "ab-field" }, el("span", { className: "ab-row-label", text: fill("memory.review.sealed_input", { field: field.field }) }), input);
    });
    const choice = (name: string, current: string | undefined, options: Array<[value: string, label: string]>, set: (value: string) => void): HTMLElement =>
      el("div", { className: "ab-inline" }, ...options.map(([value, label]) => {
        const input = el("input", { attrs: { type: "radio", name: `${name}-${index}`, value } });
        input.checked = (current ?? options[0]![0]) === value;
        input.addEventListener("change", () => {
          set(value);
          actions.rerender();
        });
        return el("label", { className: "ab-inline" }, input, el("span", { text: label }));
      }));
    const editor = edit.open
      ? el(
          "div",
          { className: "ab-review-editor" },
          el("label", { className: "ab-field" }, el("span", { className: "ab-row-label", text: "Title" }), (() => {
            const input = el("input", { className: "ab-input", attrs: { type: "text", name: `edit-title-${index}`, maxlength: "200" } });
            input.value = edit.title;
            input.addEventListener("input", () => {
              edit.title = input.value;
            });
            return input;
          })()),
          el("label", { className: "ab-field" }, el("span", { className: "ab-row-label", text: "Fields (JSON)" }), (() => {
            const area = el("textarea", { className: "ab-textarea", attrs: { name: `edit-fields-${index}`, rows: "4" } });
            area.value = edit.fields;
            area.addEventListener("input", () => {
              edit.fields = area.value;
            });
            return area;
          })()),
          el("label", { className: "ab-field" }, el("span", { className: "ab-row-label", text: "Body" }), (() => {
            const area = el("textarea", { className: "ab-textarea", attrs: { name: `edit-body-${index}`, rows: "4", maxlength: "16384" } });
            area.value = edit.body;
            area.addEventListener("input", () => {
              edit.body = area.value;
            });
            return area;
          })()),
          el("label", { className: "ab-field" }, el("span", { className: "ab-row-label", text: "Tags (comma-separated)" }), (() => {
            const input = el("input", { className: "ab-input", attrs: { type: "text", name: `edit-tags-${index}` } });
            input.value = edit.tags;
            input.addEventListener("input", () => {
              edit.tags = input.value;
            });
            return input;
          })()),
        )
      : null;
    const title = proposal.action === "update" ? `Update ${facts.type_display_name}` : `New ${facts.type_display_name}`;
    return el(
      "div",
      { className: `ab-review-card${decision ? ` ab-review-${decision}` : ""}`, attrs: { "data-proposal": String(index) } },
      el("div", { className: "ab-row" }, el("strong", { text: `${index + 1} · ${title}  “${edit.title}”` }), proposal.action === "update" && facts.target_title ? el("span", { className: "ab-muted", text: ` (replaces your record “${facts.target_title}”)` }) : null, decision ? chip(decision === "accept" ? "accepted" : "rejected", decision === "accept" ? "good" : "neutral") : null),
      facts.new_type ? el("p", { className: "ab-hint", text: fill("memory.review.new_type", { display_name: facts.type_display_name, description: facts.type_description ?? "" }) }) : null,
      el("p", { className: "ab-review-fields", text: fieldsLine(proposal.fields) }),
      proposal.body ? el("p", { className: "ab-review-body", text: `“${proposal.body}”` }) : null,
      links.length > 0 ? el("p", { className: "ab-hint", text: `Links: ${links.join(" · ")}` }) : null,
      rejectedLinks.length > 0 ? el("p", { className: "ab-hint ab-muted", text: rejectedLinks.map((link) => `${link.to}: ${fill("memory.review.rejected_link", { n: Number(link.to.slice(1)) + 1 })}`).join(" · ") }) : null,
      kept.length > 0 ? el("p", { className: "ab-hint", text: fill("memory.review.kept", { items: kept.join(" · ") }) }) : null,
      facts.target_replaced_since ? el("div", {}, el("p", { className: "ab-hint", text: fill("memory.review.replaced_since", { title: facts.target_replaced_since.head_title }) }), choice("replaced", state.replacedSince[index], [["head", fill("memory.review.replace_head", { title: facts.target_replaced_since.head_title })], ["keep_new", STRINGS["memory.review.keep_new"]]], (value) => {
        state.replacedSince[index] = value as "head" | "keep_new";
      })) : null,
      facts.identity_match ? el("div", {}, el("p", { className: "ab-hint", text: fill("memory.replace.offer", { title: facts.identity_match.title, fields: facts.identity_match.fields.join(", ") }) }), choice("identity", state.identity[index], [["replace", STRINGS["memory.replace.yes"]], ["keep_both", STRINGS["memory.replace.no"]]], (value) => {
        state.identity[index] = value as "replace" | "keep_both";
      })) : null,
      ...sealedInputs,
      editor,
      el("p", { className: "ab-hint ab-review-says", text: fill("memory.review.says", { package: view.package.name ?? view.package.package_id, rationale: proposal.rationale }) }),
      el(
        "div",
        { className: "ab-inline" },
        review.memory_full
          ? el("span", {}, el("span", { text: `${STRINGS["memory.full"].replace("{cap}", String(review.cap))} · ` }), button("Tidy up", () => actions.openMemory(null)))
          : button("Accept", () => {
              state.decisions[index] = "accept";
              actions.rerender();
            }, { variant: decision === "accept" ? "primary" : "ghost" }),
        button(edit.open ? "Close editor" : "Edit…", () => {
          edit.open = !edit.open;
          actions.rerender();
        }),
        button("Reject", () => {
          state.decisions[index] = "reject";
          actions.rerender();
        }, { variant: decision === "reject" ? "primary" : "ghost" }),
      ),
    );
  });
  const { complete, missing } = reviewComplete(state);
  const all = (decision: "accept" | "reject") => {
    for (const facts of review.facts) state.decisions[facts.index] = decision;
    actions.rerender();
  };
  return el(
    "section",
    { className: "ab-review", attrs: { "aria-label": fill("memory.review.title", { n: review.document.proposals.length }) } },
    el("h3", { text: fill("memory.review.title", { n: review.document.proposals.length }) }),
    el("p", { className: "ab-hint", text: fill("memory.review.from", { package: view.package.name ?? view.package.package_id, version: view.package.package_version, run: view.run_id.slice(0, 8), date: view.proposed_at ? new Date(view.proposed_at).toLocaleString() : "" }) }),
    state.error ? el("div", { className: "ab-banner ab-banner-bad", text: state.error }) : null,
    ...cards,
    el(
      "div",
      { className: "ab-inline ab-review-footer" },
      review.memory_full ? null : button("Accept all", () => all("accept")),
      button("Reject all", () => all("reject")),
      button(state.busy ? "Saving…" : "Save decisions", () => decide(state, actions), { variant: "primary", disabled: !complete || state.busy, title: complete ? "Apply every decision together" : `Decide proposal${missing.length === 1 ? "" : "s"} ${missing.map((index) => index + 1).join(", ")} first` }),
      el("span", { className: "ab-muted", text: `Memory: ${review.records.toLocaleString("en-US")} of ${review.cap.toLocaleString("en-US")} records` }),
    ),
    list([]),
  );
}

export type { JsonValue };
