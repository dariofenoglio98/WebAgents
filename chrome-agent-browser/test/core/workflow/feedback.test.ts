/**
 * The re-ask's one feedback line (D-151), byte for byte: it names the refused check by the
 * package's own index, kind, failure and pointers, or the schema keyword and the answer's
 * location, and repeats at most three short key values, only values the model was given or wrote.
 */
import { describe, expect, it } from "vitest";

import type { JsonObject } from "../../../src/core/json.js";
import { disclosedScalars, feedbackLine, MAX_FEEDBACK_CHARS, pointer } from "../../../src/core/workflow/feedback.js";

const check = (failed_check: JsonObject, offending: Array<string | number | boolean | null | JsonObject> = []) => ({ kind: "check" as const, failed_check, offending });

describe("feedbackLine", () => {
  it("names a refused relation check by its index, kind, failure, pointer and the key values the answer itself holds", () => {
    const answer = { candidate_papers: [{ paper_id: "p3" }, { paper_id: "p3" }] };
    const line = feedbackLine(check({ check: "answer_check", index: 0, kind: "relation", failure: "duplicate_target_key", target_key: "/paper_id" }, ["p3"]), disclosedScalars({ question: "q" }, answer));
    expect(line).toBe('The previous answer was not accepted: answer check 0 (relation) failed: duplicate_target_key at /paper_id for "p3". Return the complete JSON document again, corrected.');
  });

  it("words each failure with the pointer it names", () => {
    const disclosed = disclosedScalars({ ids: ["a", "b"] }, { rows: [{ id: "paper-123" }, { id: "e1" }, { id: 7 }] });
    const cases: Array<[JsonObject, Array<string | number>, string]> = [
      [{ index: 1, kind: "relation", failure: "missing_target_key", row_key: "/paper_id", target_key: "/paper_id" }, ["paper-123"], 'answer check 1 (relation) failed: missing_target_key at /paper_id for "paper-123".'],
      [{ index: 0, kind: "relation", failure: "no_key", row_key: "/evidence_ids" }, [], "answer check 0 (relation) failed: no_key at /evidence_ids."],
      [{ index: 2, kind: "relation", failure: "target_value_mismatch", path: "/status" }, ["e1"], 'answer check 2 (relation) failed: target_value_mismatch at /status for "e1".'],
      [{ index: 0, kind: "relation", failure: "fields_do_not_match", compare: { left: "/quote", right: "/abstract", op: "contained_in" } }, ["e1"], 'answer check 0 (relation) failed: fields_do_not_match at /quote contained_in /abstract for "e1".'],
      [{ index: 0, kind: "relation", failure: "operands_not_arrays" }, [], "answer check 0 (relation) failed: operands_not_arrays."],
      [{ index: 3, kind: "sum", failure: "sum_differs", path: "/minutes" }, [], "answer check 3 (sum) failed: sum_differs at /minutes."],
      [{ index: 0, kind: "sum", failure: "summand_not_number", path: "/minutes" }, [], "answer check 0 (sum) failed: summand_not_number at /minutes."],
      [{ index: 0, kind: "equal", failure: "values_differ" }, [], "answer check 0 (equal) failed: values_differ."],
      [{ index: 4, kind: "equal", failure: "not_evaluable" }, [], "answer check 4 (equal) failed: not_evaluable."],
      // A whole-value pointer names no location; a number is repeated as JSON.
      [{ index: 0, kind: "relation", failure: "duplicate_target_key", target_key: "" }, [7], "answer check 0 (relation) failed: duplicate_target_key for 7."],
    ];
    for (const [failed, offending, reason] of cases) {
      expect(feedbackLine(check({ check: "answer_check", ...failed }, offending), disclosed)).toBe(`The previous answer was not accepted: ${reason} Return the complete JSON document again, corrected.`);
    }
  });

  it("repeats a value only when the request's data or the answer holds it, as a short scalar, at most three and a count", () => {
    const failed = { check: "answer_check", index: 0, kind: "relation", failure: "missing_target_key", row_key: "/id", target_key: "/id" };
    const long = "x".repeat(81);
    const disclosed = disclosedScalars({ seen: ["a", "b", "c", "d", "e", long, "x".repeat(80)] }, { flag: true });
    // "secret" was never given to or written by the model: it is not repeated.
    expect(feedbackLine(check(failed, ["secret"]), disclosed)).toBe("The previous answer was not accepted: answer check 0 (relation) failed: missing_target_key at /id. Return the complete JSON document again, corrected.");
    expect(feedbackLine(check(failed, ["a", "secret", "b", "c", "d", "e"]), disclosed)).toBe('The previous answer was not accepted: answer check 0 (relation) failed: missing_target_key at /id for "a", "b", "c" (and 2 more). Return the complete JSON document again, corrected.');
    // Longer than 80 characters, an object or null: never repeated; a disclosed boolean is.
    expect(feedbackLine(check(failed, [long, { id: "a" }, null, true]), disclosed)).toBe("The previous answer was not accepted: answer check 0 (relation) failed: missing_target_key at /id for true. Return the complete JSON document again, corrected.");
    expect(feedbackLine(check(failed, ["x".repeat(80)]), disclosed)).toContain(`for "${"x".repeat(80)}".`);
    // Without a disclosure set, no value at all.
    expect(feedbackLine(check(failed, ["a"]))).not.toContain('"a"');
  });

  it("names a schema miss by its keyword and the answer's location, and for `required` the missing names the schema declares", () => {
    expect(feedbackLine({ kind: "schema", keyword: "required", instance_path: ["candidate_papers", "2"], missing: ["title", "doi"] })).toBe("The previous answer was not accepted: it does not match the output schema: required at /candidate_papers/2 (missing: title, doi). Return the complete JSON document again, corrected.");
    expect(feedbackLine({ kind: "schema", keyword: "pattern", instance_path: ["search", "date"], missing: [] })).toBe("The previous answer was not accepted: it does not match the output schema: pattern at /search/date. Return the complete JSON document again, corrected.");
    expect(feedbackLine({ kind: "schema", keyword: "type", instance_path: [], missing: [] })).toBe("The previous answer was not accepted: it does not match the output schema: type at the document root. Return the complete JSON document again, corrected.");
    // Names that are not plain identifiers are left out; a pointer is escaped.
    expect(feedbackLine({ kind: "schema", keyword: "required", instance_path: ["a/b", "c~d"], missing: ["ok", "not ok"] })).toBe("The previous answer was not accepted: it does not match the output schema: required at /a~1b/c~0d (missing: ok). Return the complete JSON document again, corrected.");
  });

  it("names an answer that was not JSON, or empty, and anything else generically", () => {
    expect(feedbackLine({ kind: "not_json" })).toBe("The previous answer was not accepted: it is not one JSON document. Return the complete JSON document again, corrected.");
    expect(feedbackLine({ kind: "no_text" })).toBe("The previous answer was not accepted: it contained no text. Return the complete JSON document again, corrected.");
    expect(feedbackLine({ kind: "unknown" })).toBe("The previous answer was not accepted: it does not satisfy the output contract. Return the complete JSON document again, corrected.");
  });

  it("stays within the request's 1,000-character bound: values go first, then the location", () => {
    const long = `/${"p".repeat(1200)}`;
    const line = feedbackLine(check({ check: "answer_check", index: 0, kind: "relation", failure: "missing_target_key", row_key: long }, ["a"]), disclosedScalars({ a: "a" }));
    expect([...line].length).toBeLessThanOrEqual(MAX_FEEDBACK_CHARS);
    expect(line).toBe("The previous answer was not accepted: answer check 0 (relation) failed: missing_target_key. Return the complete JSON document again, corrected.");
  });

  it("writes JSON Pointers per RFC 6901", () => {
    expect(pointer([])).toBe("");
    expect(pointer(["a", "0", "b/c", "~"])).toBe("/a/0/b~1c/~0");
  });
});
