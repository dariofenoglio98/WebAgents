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
      const sum = (values as number[]).reduce((total, value) => total + value, 0);
      if (!pyEqual(sum, evaluate(rule.equals!, env))) fail("sum_differs", "sum differs from required value", { path: rule.path! });
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
