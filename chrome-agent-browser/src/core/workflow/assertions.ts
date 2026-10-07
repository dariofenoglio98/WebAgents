/**
 * Three bounded data invariants for validate nodes (`agentpkg/workflow_assertions.py`); no
 * scripts or callbacks. `failed_check` names only what the package declared: the assertion's
 * index and kind, the failure, and the pointers it compared.
 */
import { ValidationError } from "../errors.js";
import type { JsonObject, JsonValue } from "../json.js";
import { select } from "../references.js";
import { pyStrip } from "../trust.js";
import { evaluate, identity, pyEqual, type Environment } from "./values.js";

export class AssertionFailure extends ValidationError {
  override readonly name: string = "AssertionFailure";
  readonly failed_check: Record<string, unknown>;

  constructor(index: number, rule: JsonObject, failure: string, message: string, declared: Record<string, JsonValue> = {}) {
    super(`assertion ${index} (${rule.kind}): ${message}`);
    this.failed_check = { check: "assertion", index, kind: rule.kind, failure, ...declared };
  }
}

/** JavaScript's safe-integer range: within it a JSON integral number is read as a Python int. */
const SAFE_INTEGER = 2 ** 53;

/**
 * CPython's builtin `sum()` over JSON numbers, as `workflow_assertions.py` uses it (T4 review
 * 1, finding 3). CPython >= 3.12 (`bltinmodule.c`) adds ints exactly while the running total is
 * an int, converts once at the first float, and from there adds floats with Neumaier's
 * compensated summation and ints plainly (`f_result += (double)value`); the compensation is
 * added at the end unless it is not finite. So `sum([0.1, 0.2, 0.3]) == 0.6` holds in both
 * runtimes, and a naive left fold would not.
 *
 * JavaScript reads a JSON `1.0` and a JSON `1` as the same number. The port treats an integral
 * number within the safe-integer range as the int Python reads from `1`, which is the spelling
 * Python's own `json.dumps` and the Chrome core's `pyjson` write for ints; a package whose
 * values arrive spelled `1.0` between floats whose rounding error the compensation would have
 * kept is the one documented divergence (`test/fixtures/py-sum-vectors.json`, D-066, B-115).
 */
export function pySum(values: readonly number[]): number {
  let index = 0;
  let total = 0;
  const isInt = (value: number): boolean => Number.isInteger(value) && Math.abs(value) <= SAFE_INTEGER;
  // The int phase: exact while every summand is an int (a double is exact within 2^53).
  while (index < values.length && isInt(values[index]!)) {
    total += values[index]!;
    index += 1;
  }
  if (index === values.length) return total;
  // The first float: `PyNumber_Add(int, float)`, one rounding, no compensation yet.
  let result = total + values[index]!;
  index += 1;
  let compensation = 0;
  for (; index < values.length; index += 1) {
    const value = values[index]!;
    if (isInt(value)) {
      result += value;
      continue;
    }
    const t = result + value;
    if (Math.abs(result) >= Math.abs(value)) compensation += result - t + value;
    else compensation += value - t + result;
    result = t;
  }
  // "Avoid losing the sign on a negative result, and don't let adding the compensation convert
  // an infinite or overflowed sum to a NaN."
  if (compensation !== 0 && Number.isFinite(compensation)) result += compensation;
  return result;
}

export function checkAssertions(assertions: readonly JsonValue[], env: Environment): void {
  assertions.forEach((raw, index) => {
    const rule = raw as JsonObject;
    const fail = (failure: string, message: string, declared: Record<string, JsonValue> = {}): never => {
      throw new AssertionFailure(index, rule, failure, message, declared);
    };
    if (rule.kind === "equal") {
      if (!pyEqual(evaluate(rule.left!, env), evaluate(rule.right!, env))) fail("values_differ", "values differ");
    } else if (rule.kind === "sum") {
      const rows = evaluate(rule.rows!, env);
      if (!Array.isArray(rows)) fail("rows_not_array", "rows must be an array");
      const values = (rows as JsonValue[]).map((row) => select(row, String(rule.path)));
      if (values.some((value) => typeof value !== "number")) fail("summand_not_number", "summands must be numbers", { path: rule.path! });
      if (!pyEqual(pySum(values as number[]), evaluate(rule.equals!, env))) fail("sum_differs", "sum differs from required value", { path: rule.path! });
    } else {
      const rows = evaluate(rule.rows!, env);
      const targets = evaluate(rule.targets!, env);
      if (!Array.isArray(rows) || !Array.isArray(targets)) fail("operands_not_arrays", "relation operands must be arrays");
      const index_ = new Map<string, JsonValue>();
      for (const target of targets as JsonValue[]) {
        const key = identity(select(target, String(rule.target_key)));
        if (index_.has(key)) fail("duplicate_target_key", "duplicate target key", { target_key: rule.target_key! });
        index_.set(key, target);
      }
      const where = rule.where as JsonObject | undefined;
      for (const row of rows as JsonValue[]) {
        if (where && !pyEqual(select(row, String(where.path)), where.equals!)) continue;
        const selected = select(row, String(rule.row_key));
        const keys = rule.many === true ? selected : [selected];
        if (!Array.isArray(keys) || keys.length === 0) fail("no_key", "relation requires at least one key", { row_key: rule.row_key! });
        for (const key of keys as JsonValue[]) {
          const target = index_.get(identity(key));
          if (target === undefined) {
            fail("missing_target_key", "missing target key", { row_key: rule.row_key!, target_key: rule.target_key! });
          }
          for (const [path, value] of Object.entries((rule.target_values as JsonObject | undefined) ?? {})) {
            if (!pyEqual(select(target!, path), value)) fail("target_value_mismatch", "target value mismatch", { path });
          }
          for (const raw of (rule.compare as JsonValue[] | undefined) ?? []) {
            const pair = raw as JsonObject;
            const left = select(row, String(pair.left));
            const right = select(target!, String(pair.right));
            const valid =
              pair.op === "eq"
                ? pyEqual(left, right)
                : typeof left === "string" && typeof right === "string" && pyStrip(left).length > 0 && right.includes(left);
            if (!valid) {
              fail("fields_do_not_match", "related fields do not match", { compare: { left: pair.left!, right: pair.right!, op: pair.op! } });
            }
          }
        }
      }
    }
  });
}
