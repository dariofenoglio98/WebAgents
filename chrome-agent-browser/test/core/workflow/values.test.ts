/**
 * `allocate` and `lookup` (test_workflow_allocate.py, test_workflow_lookup.py), Python
 * equality, and the constructors' refusals.
 */
import { describe, expect, it } from "vitest";

import { ValidationError } from "../../../src/core/errors.js";
import type { JsonObject, JsonValue } from "../../../src/core/json.js";
import { references } from "../../../src/core/references.js";
import { evaluate, LookupFailure, pyEqual } from "../../../src/core/workflow/values.js";
import { change, loadSource, sourceTree } from "../../helpers/source-tree.js";

const expression = () => ({ allocate: { rows: { from: "state", path: "/records" }, total: { from: "state", path: "/capacity" }, field: "units" } });

function allocate(rows: JsonValue, total: JsonValue): JsonValue {
  return evaluate(expression(), { state: { records: rows, capacity: total } });
}

describe("allocate (test_workflow_allocate.py)", () => {
  it("proportions, stable ties and no mutation of the source", () => {
    const rows: JsonValue = [{ units: 2, payload: { a: 1 } }, { units: 2 }, { units: 2 }];
    const original = JSON.parse(JSON.stringify(rows)) as JsonValue;
    const result = allocate(rows, 10) as JsonObject[];
    expect(result.map((row) => row.units)).toEqual([4, 3, 3]);
    (result[0]!.payload as JsonObject).a = 2;
    expect(rows).toEqual(original);
    expect(allocate(rows, 6)).toEqual(rows);
    expect((allocate(rows, 3) as JsonObject[]).map((row) => row.units)).toEqual([1, 1, 1]);
    expect((allocate([{ units: 1 }, { units: 3 }], 10) as JsonObject[]).map((row) => row.units)).toEqual([3, 7]);
  });

  const invalid: Array<[JsonValue, JsonValue]> = [
    [[], 10],
    [Array.from({ length: 257 }, () => ({ units: 1 })), 300],
    [[{ units: 1 }, { units: 1 }, { units: 1 }], 2],
    [[{ units: 1 }], true],
    [[{ units: 1 }], 1.5],
    [[{ units: 1 }], 2147483648],
    [[{ units: 0 }], 10],
    [[{ units: -1 }], 10],
    [[{ units: true }], 10],
    [[{ units: 1.5 }], 10],
    [[{}], 10],
    [{}, 10],
  ];
  for (const [rows, total] of invalid) {
    it(`impossible or invalid allocation fails: ${JSON.stringify(rows).slice(0, 40)} / ${JSON.stringify(total)}`, () => {
      expect(() => allocate(rows, total)).toThrow(ValidationError);
    });
  }

  it("exact totals, positive units and idempotence, with products beyond 2^53", () => {
    for (const weights of [[1], [1, 1, 1], [1, 100, 3, 7], [2147483647, 1]]) {
      const rows = weights.map((units) => ({ units }));
      for (let total = rows.length; total < 241; total += 1) {
        const result = allocate(rows, total) as JsonObject[];
        expect(result.reduce((sum, row) => sum + (row.units as number), 0)).toBe(total);
        expect(result.every((row) => (row.units as number) >= 1)).toBe(true);
        expect(allocate(result, total)).toEqual(result);
      }
    }
  });

  it("both operands participate in authority checks", () => {
    expect([...references(expression())]).toEqual([
      ["state", "/records"],
      ["state", "/capacity"],
    ]);
  });

  for (const operand of ["rows", "total"] as const) {
    it(`a nested ${operand} operand cannot read unauthorized state`, async () => {
      const files = sourceTree("meeting-agenda");
      change(files, "graph.json", (graph) => {
        const value: JsonObject = { allocate: { rows: { literal: [{ units: 1 }] }, total: { literal: 25 }, field: "units" } };
        (value.allocate as JsonObject)[operand] = { from: "state", path: "/agenda" };
        (graph.nodes as JsonObject[])[0]!.input = value;
      });
      await expect(loadSource(files)).rejects.toThrow(/state_read/u);
    });
  }

  it("integer-valued JSON numbers follow schema integer semantics", () => {
    expect(allocate([{ units: 2.0 }, { units: 6.0 }], 10.0)).toEqual([{ units: 3 }, { units: 7 }]);
  });
});

const RECORDS: JsonValue[] = [
  { id: "a", record: { title: "A", optional: null, authors: [{ name: "X" }] } },
  { id: "b", record: { title: "B" } },
  { id: 1, record: { title: "integer one" } },
];

function lookup(keyValue: JsonValue, options: { members?: JsonValue; key?: string; path?: string } = {}): JsonValue {
  return evaluate(
    { lookup: { in: { from: "state", path: "/records" }, key: options.key ?? "/id", equals: { literal: keyValue }, path: options.path ?? "/record" } },
    { state: { records: options.members ?? RECORDS } },
  );
}

describe("lookup (test_workflow_lookup.py)", () => {
  it("selects the one matching member exactly", () => {
    expect(lookup("a")).toEqual((RECORDS[0] as JsonObject).record);
    expect(lookup("b", { path: "/record/title" })).toBe("B");
    expect(lookup("a", { path: "" })).toEqual(RECORDS[0]);
  });

  it("returns a copy, not an alias", () => {
    const value = lookup("a") as JsonObject;
    (value.authors as JsonValue[]).push({ name: "Y" });
    expect(((RECORDS[0] as JsonObject).record as JsonObject).authors).toEqual([{ name: "X" }]);
  });

  it("key equality is exact canonical equality: no coercion of strings, booleans or numbers", () => {
    expect(lookup(1)).toEqual({ title: "integer one" });
    expect(() => lookup(true)).toThrow(LookupFailure);
    expect(() => lookup("1")).toThrow(LookupFailure);
  });

  const failures: Array<[JsonValue, JsonValue, string]> = [
    ["missing", RECORDS, "no_match"],
    ["a", [...RECORDS, { id: "a", record: {} }], "duplicate_key"],
    ["a", { not: "an array" }, "not_array"],
  ];
  for (const [value, members, failure] of failures) {
    it(`anything but exactly one match fails with attribution: ${failure}`, () => {
      let caught: LookupFailure | null = null;
      try {
        lookup(value, { members });
      } catch (error) {
        caught = error as LookupFailure;
      }
      expect(caught).toBeInstanceOf(LookupFailure);
      expect(caught!.failed_check).toEqual({ check: "lookup", failure, key: "/id", path: "/record" });
      expect(caught!.message).not.toContain("missing");
      expect(JSON.stringify(caught!.failed_check)).not.toContain("missing");
    });
  }

  it("missing pointers fail rather than default", () => {
    expect(() => lookup("a", { key: "/absent" })).toThrow(ValidationError);
    expect(() => lookup("a", { path: "/record/absent" })).toThrow(ValidationError);
  });

  it("references cover both operands", () => {
    const expr = { lookup: { in: { from: "state", path: "/records" }, key: "/id", equals: { from: "item", path: "/id" }, path: "" } };
    expect([...references(expr)]).toEqual([
      ["state", "/records"],
      ["item", "/id"],
    ]);
  });
});

describe("evaluate and Python equality", () => {
  it("constructs literals, projections, coalesce, objects and arrays", () => {
    const env = { state: { a: { b: [1, 2, { c: "x" }] }, n: null } };
    expect(evaluate({ literal: { k: [1] } }, env)).toEqual({ k: [1] });
    expect(evaluate({ from: "state", path: "/a/b/2/c" }, env)).toBe("x");
    expect(evaluate({ coalesce: [{ from: "state", path: "/n" }, { literal: "" }, { literal: "z" }] }, env)).toBe("");
    expect(evaluate({ object: { x: { literal: 1 }, y: { array: [{ literal: true }] } } }, env)).toEqual({ x: 1, y: [true] });
    expect(() => evaluate({ from: "item", path: "" }, env)).toThrow("Unavailable projection source 'item'");
    expect(() => evaluate({ from: "state", path: "/a/missing" }, env)).toThrow("state: missing data at '/a/missing'");
  });

  it("pyEqual follows Python ==: structural, numbers by value, booleans as 0 and 1", () => {
    expect(pyEqual({ a: [1, { b: null }] }, { a: [1, { b: null }] })).toBe(true);
    expect(pyEqual({ a: 1, b: 2 }, { b: 2, a: 1 })).toBe(true);
    expect(pyEqual(1, 1.0)).toBe(true);
    expect(pyEqual(true, 1)).toBe(true);
    expect(pyEqual(false, 0)).toBe(true);
    expect(pyEqual("1", 1)).toBe(false);
    expect(pyEqual(null, 0)).toBe(false);
    expect(pyEqual([1, 2], [2, 1])).toBe(false);
    expect(pyEqual({ a: 1 }, { a: 1, b: 2 })).toBe(false);
    expect(pyEqual([], {})).toBe(false);
  });
});
