// @vitest-environment happy-dom
/**
 * The T19 user-run carry-overs fixed in T22: the run page's "Open in Memory" lands on the record
 * just accepted (B-215), and a list-of-strings field on the Memory page takes what a person types
 * (B-218): one item per line or comma-separated, converted to the list; the JSON textarea stays
 * for lists of objects and names the shape it expects.
 */
import { describe, expect, it, vi } from "vitest";

import type { ReviewOutcome, RunReviewView } from "../../src/extension/messages.js";
import type { JsonValue } from "../../src/core/json.js";
import { fieldControl, isStringList, jsonExample, parseStringList } from "../../src/extension/ui/memory/page.js";
import { newReviewState, renderReview, type ReviewActions } from "../../src/extension/ui/memory/review.js";

const PACKAGE = { package_id: "org.example", version: "1.0.0", name: "Example" } as unknown as RunReviewView["package"];

function actions(openMemory: ReviewActions["openMemory"]): ReviewActions {
  return { send: () => Promise.reject(new Error("not used")), rerender: () => undefined, openMemory, locked: false };
}

describe("Open in Memory after a review (B-215)", () => {
  it("names the first accepted record when the decisions were made on this page, else opens the Memory page alone", () => {
    const state = newReviewState("run_1");
    state.view = { run_id: "run_1", package: PACKAGE, proposed_at: "2026-10-16T00:00:00Z", offered: 1, count: 1, reason: null, review: null, decided: { at: "2026-10-16T00:00:01Z", accepted: 1, rejected: 0 } };
    state.outcome = { accepted: [{ index: 0, id: "mem_152e897b", title: "Business class", supersedes: null, dropped_links: [] }], rejected: [] } as unknown as ReviewOutcome;
    const open = vi.fn();
    const sheet = renderReview(state, actions(open))!;
    const button = [...sheet.querySelectorAll<HTMLButtonElement>("button")].find((node) => node.textContent === "Open in Memory")!;
    button.click();
    expect(open).toHaveBeenCalledWith("mem_152e897b");
    // Reopened later (the stored run keeps the counts, not the ids): the page opens without a record.
    const later = newReviewState("run_1");
    later.view = state.view;
    const openLater = vi.fn();
    [...renderReview(later, actions(openLater))!.querySelectorAll<HTMLButtonElement>("button")].find((node) => node.textContent === "Open in Memory")!.click();
    expect(openLater).toHaveBeenCalledWith(null);
  });
});

describe("list fields on the Memory page (B-218)", () => {
  it("recognizes a list of strings and converts what the person typed", () => {
    expect(isStringList({ type: "array", items: { type: "string" } })).toBe(true);
    expect(isStringList({ type: ["array", "null"], items: { type: "string" } })).toBe(true);
    expect(isStringList({ type: "array", items: { type: "object", properties: { title: { type: "string" } } } })).toBe(false);
    expect(isStringList({ type: "string" })).toBe(false);
    expect(parseStringList("agents, memory ,  consent")).toEqual(["agents", "memory", "consent"]);
    expect(parseStringList("agents\nmemory\n\nconsent\n")).toEqual(["agents", "memory", "consent"]);
    // One line with commas is split; several lines keep a comma inside an item.
    expect(parseStringList("Smith, J.\nDoe, A.")).toEqual(["Smith, J.", "Doe, A."]);
    expect(parseStringList("   ")).toEqual([]);
    // A field that opened with stored items is one item per line: a comma inside an item stays.
    expect(parseStringList("Università della Svizzera italiana, Lugano", false)).toEqual(["Università della Svizzera italiana, Lugano"]);
    expect(parseStringList("agents\nmemory", false)).toEqual(["agents", "memory"]);
  });

  it("never splits a stored item that holds a comma when the person edits the field (T22 review 1, finding 3)", () => {
    const schema = { type: "array", items: { type: "string" } };
    const type = (area: HTMLTextAreaElement, text: string) => {
      area.value = text;
      area.dispatchEvent(new Event("input"));
    };
    // Editing a record: the stored list is prefilled one per line, and touching it keeps the item whole.
    const stored: JsonValue = ["Università della Svizzera italiana, Lugano"];
    const draft: Record<string, JsonValue> = { affiliations: [...stored] };
    let changes = 0;
    const area = fieldControl("affiliations", schema, draft, () => (changes += 1), stored) as HTMLTextAreaElement;
    expect(area.value).toBe("Università della Svizzera italiana, Lugano");
    expect(area.getAttribute("placeholder")).toBe("one per line");
    type(area, "Università della Svizzera italiana, Lugano ");
    expect(draft.affiliations).toEqual(["Università della Svizzera italiana, Lugano"]);
    type(area, "Università della Svizzera italiana, Lugano\nMIT Media Lab");
    expect(draft.affiliations).toEqual(["Università della Svizzera italiana, Lugano", "MIT Media Lab"]);
    expect(changes).toBe(2);
    // A field that opened empty (a new record, or a record without the field) also takes commas.
    const fresh: Record<string, JsonValue> = {};
    const empty = fieldControl("interests", schema, fresh, () => undefined) as HTMLTextAreaElement;
    expect(empty.getAttribute("placeholder")).toBe("one per line, or separated by commas");
    type(empty, "agents, memory");
    expect(fresh.interests).toEqual(["agents", "memory"]);
    type(empty, "");
    expect("interests" in fresh).toBe(false);
    const none = fieldControl("interests", schema, {}, () => undefined, []) as HTMLTextAreaElement;
    expect(none.getAttribute("placeholder")).toBe("one per line, or separated by commas");
  });

  it("names the JSON shape a structured field expects", () => {
    expect(jsonExample({ type: "array", items: { type: "object", properties: { title: { type: "string" }, doi: { type: "string" }, year: { type: "integer" }, url: { type: "string" } } } })).toBe('[{"title": …, "doi": …, "year": …}]');
    expect(jsonExample({ type: "array" })).toBe("[…]");
    expect(jsonExample({ type: "object", properties: { name: { type: "string" } } })).toBe('{"name": …}');
  });
});
