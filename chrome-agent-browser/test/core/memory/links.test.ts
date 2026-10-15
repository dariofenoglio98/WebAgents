/**
 * Body wikilinks (M-3), the record view (M-15) and its positional reversal (M-42), over the forms
 * the spec's `view_reversal` check demonstrates.
 */
import { describe, expect, it } from "vitest";

import { bodyLinkIds, normalizeBodyLinks, restoreViewLinks, viewBody } from "../../../src/core/memory/links.js";

const A = `mem_${"a".repeat(32)}`;
const B = `mem_${"b".repeat(32)}`;
const C = `mem_${"c".repeat(32)}`;
const titles = new Map([
  [A, "Trip ideas"],
  [B, "Packing list"],
  ["self", "Dario"],
]);

describe("normalizeBodyLinks (M-3)", () => {
  it("resolves a plain link to the one record with that title, keeps an alias, adds an alias to a bare id, leaves escapes, dangling ids and ambiguous text", () => {
    const twins = new Map([...titles, [C, "Trip ideas"]]);
    expect(normalizeBodyLinks("See [[Packing list]] and [[packing list|the list]] and [[self]] and \\[[Packing list]] and [[Nothing]]", titles)).toBe(`See [[${B}|Packing list]] and [[${B}|the list]] and [[self|Dario]] and \\[[Packing list]] and [[Nothing]]`);
    expect(normalizeBodyLinks("[[Trip ideas]]", twins)).toBe("[[Trip ideas]]");
    const dangling = `mem_${"d".repeat(32)}`;
    expect(normalizeBodyLinks(`[[${dangling}]]`, titles)).toBe(`[[${dangling}]]`);
    expect(bodyLinkIds(`[[${A}|x]] \\[[${B}]] [[${C}]] [[plain]]`)).toEqual([A, C]);
  });
});

describe("viewBody and restoreViewLinks (M-15, M-42)", () => {
  const stored = `Pack as in [[${B}|Packing list]], see [[${A}|Trip ideas]] and [[${A}|Trip ideas]], a dangling [[${C}]], id-shaped [[${A}|self]], plain [[Trip ideas]], escaped \\[[${B}|x]] and granted [[self|Dario]].`;

  it("hides ungranted links without their ids, escapes an id-shaped alias, says [[missing record]] for a bare dangling id, and keeps the rest", () => {
    const { body, occurrences } = viewBody(stored, new Set(["self"]));
    expect(body).toBe("Pack as in [[Packing list]], see [[Trip ideas]] and [[Trip ideas]], a dangling [[missing record]], id-shaped \\[[self]], plain [[Trip ideas]], escaped \\[[" + B + "|x]] and granted [[self|Dario]].");
    expect(occurrences.map((occurrence) => occurrence.hidden)).toEqual([B, A, A, C, A, null, null, null]);
    expect(viewBody(stored, new Set(["self", B])).body).toContain(`[[${B}|Packing list]]`);
  });

  it("an exact echo restores the stored body and carries nothing", () => {
    const { body, occurrences } = viewBody(stored, new Set(["self"]));
    const restored = restoreViewLinks(body, occurrences);
    expect(restored.body).toBe(stored);
    expect(restored.carried).toEqual([]);
  });

  it("a body that drops a hidden occurrence keeps its edge as related, and a later occurrence of the same text may take an earlier position", () => {
    const { occurrences } = viewBody(stored, new Set(["self"]));
    const dropped = restoreViewLinks("Only [[Trip ideas]] once, nothing else.", occurrences);
    expect(dropped.body).toBe(`Only [[${A}|Trip ideas]] once, nothing else.`);
    // B and C were never placed; A was placed once (its first occurrence) so it is not carried.
    expect(dropped.carried).toEqual([B, C].sort());
    const beyond = restoreViewLinks("[[Trip ideas]] [[Trip ideas]] [[Trip ideas]] [[Trip ideas]]", occurrences);
    // Three view occurrences of the text (two hidden, one plain): the fourth stays as typed.
    expect(beyond.body).toBe(`[[${A}|Trip ideas]] [[${A}|Trip ideas]] [[Trip ideas]] [[Trip ideas]]`);
  });

  it("plain text beside a hidden link of the same words is restored to what it was at that position, never a new edge", () => {
    const text = `[[${A}|Trip ideas]] and [[Trip ideas]]`;
    const { body, occurrences } = viewBody(text, new Set());
    expect(body).toBe("[[Trip ideas]] and [[Trip ideas]]");
    expect(restoreViewLinks(body, occurrences).body).toBe(text);
    // The echo with the first occurrence dropped: the plain text takes the hidden edge's position (the spec's reworded M-42).
    const partial = restoreViewLinks("and [[Trip ideas]]", occurrences);
    expect(partial.body).toBe(`and [[${A}|Trip ideas]]`);
    expect(partial.carried).toEqual([]);
  });
});
