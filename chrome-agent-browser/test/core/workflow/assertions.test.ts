/**
 * The `sum` assertion adds the way CPython's `sum()` adds (T4 review 1, finding 3): exact ints,
 * Neumaier-compensated floats. The vectors are the reference's own results, produced by
 * `scripts/make-py-sum-vectors.py` under the venv's CPython; a case that spells an integral
 * value as a JSON float records Python's result for that spelling too, and the test prints
 * every such case instead of hiding the one class of divergence JavaScript's number type forces.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { JsonObject } from "../../../src/core/json.js";
import { checkAssertions, pySum } from "../../../src/core/workflow/assertions.js";
import { PROJECT } from "../../helpers/paths.js";

interface Vector {
  name: string;
  values: Array<number | string>;
  expected: number | string;
  expected_float_spelling?: number | string;
  spellings_agree?: boolean;
}

const FILE = JSON.parse(readFileSync(join(PROJECT, "test", "fixtures", "py-sum-vectors.json"), "utf8")) as { python: string; vectors: Vector[] };
const number = (value: number | string): number => (value === "inf" ? Number.POSITIVE_INFINITY : value === "-inf" ? Number.NEGATIVE_INFINITY : value === "nan" ? Number.NaN : (value as number));

describe("pySum against CPython's results", () => {
  it("the vectors come from CPython >= 3.12, the first release with compensated float summation", () => {
    expect(FILE.python >= "3.12").toBe(true);
    expect(FILE.vectors.length).toBeGreaterThan(20);
  });

  for (const vector of FILE.vectors) {
    it(`${vector.name}: sum(${JSON.stringify(vector.values)}) is ${JSON.stringify(vector.expected)}`, () => {
      const result = pySum(vector.values.map(number));
      const expected = number(vector.expected);
      // Object.is: -0 and +0 stay apart, NaN equals NaN; Python's `==` would call -0.0 == 0.0 true, but the port reproduces the value.
      expect(Object.is(result, expected) || (Number.isNaN(result) && Number.isNaN(expected))).toBe(true);
      if (vector.spellings_agree === false) {
        console.log(`${vector.name}: a JSON float spelling of its integral values gives Python ${JSON.stringify(vector.expected_float_spelling)}, the port ${JSON.stringify(vector.expected)} (D-066)`);
      }
    });
  }

  it("is not a naive left fold", () => {
    expect([0.1, 0.2, 0.3].reduce((total, value) => total + value, 0)).not.toBe(0.6);
    expect(pySum([0.1, 0.2, 0.3])).toBe(0.6);
    expect(pySum([0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1])).toBe(1);
  });
});

describe("the sum assertion", () => {
  const rule = (equals: number): JsonObject => ({ kind: "sum", rows: { from: "input", path: "/rows" }, path: "/price", equals: { literal: equals } });
  const env = (prices: number[]) => ({ input: { rows: prices.map((price) => ({ price })) }, state: {}, result: null }) as never;

  it("passes where Python passes: decimal prices that a naive fold would reject", () => {
    expect(() => checkAssertions([rule(0.6)], env([0.1, 0.2, 0.3]))).not.toThrow();
    expect(() => checkAssertions([rule(1)], env([0.1, 0.2, 0.3, 0.4]))).not.toThrow();
    expect(() => checkAssertions([rule(6)], env([1, 2, 3]))).not.toThrow();
  });

  it("still fails a wrong total and a non-number summand, naming the declared path only", () => {
    try {
      checkAssertions([rule(0.7)], env([0.1, 0.2, 0.3]));
      expect.unreachable();
    } catch (error) {
      expect((error as { failed_check: JsonObject }).failed_check).toEqual({ check: "assertion", index: 0, kind: "sum", failure: "sum_differs", path: "/price" });
    }
    expect(() => checkAssertions([rule(1)], { input: { rows: [{ price: "1" }] }, state: {}, result: null } as never)).toThrow(/summands must be numbers/u);
  });
});
