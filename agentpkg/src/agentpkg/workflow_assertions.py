"""Three bounded data invariants for validate nodes; no scripts or callbacks."""

from __future__ import annotations

from .errors import ValidationError
from .runtime import digest
from .workflow_values import evaluate, select


def check_assertions(assertions, env):
    for index, rule in enumerate(assertions):
        label = f"assertion {index} ({rule['kind']})"
        if rule["kind"] == "equal":
            if evaluate(rule["left"], env) != evaluate(rule["right"], env):
                raise ValidationError(f"{label}: values differ")
        elif rule["kind"] == "sum":
            rows = evaluate(rule["rows"], env)
            if not isinstance(rows, list):
                raise ValidationError(f"{label}: rows must be an array")
            values = [select(row, rule["path"]) for row in rows]
            if any(isinstance(v, bool) or not isinstance(v, (int, float)) for v in values):
                raise ValidationError(f"{label}: summands must be numbers")
            if sum(values) != evaluate(rule["equals"], env):
                raise ValidationError(f"{label}: sum differs from required value")
        else:
            rows = evaluate(rule["rows"], env)
            targets = evaluate(rule["targets"], env)
            if not isinstance(rows, list) or not isinstance(targets, list):
                raise ValidationError(f"{label}: relation operands must be arrays")
            lookup = {}
            for target in targets:
                key = digest(select(target, rule["target_key"]))
                if key in lookup:
                    raise ValidationError(f"{label}: duplicate target key")
                lookup[key] = target
            for row in rows:
                where = rule.get("where")
                if where and select(row, where["path"]) != where["equals"]:
                    continue
                keys = select(row, rule["row_key"])
                keys = keys if rule.get("many", False) else [keys]
                if not isinstance(keys, list) or not keys:
                    raise ValidationError(f"{label}: relation requires at least one key")
                for key in keys:
                    target = lookup.get(digest(key))
                    if target is None:
                        raise ValidationError(f"{label}: missing target key")
                    for path, value in rule.get("target_values", {}).items():
                        if select(target, path) != value:
                            raise ValidationError(f"{label}: target value mismatch")
                    for pair in rule.get("compare", []):
                        left, right = select(row, pair["left"]), select(target, pair["right"])
                        if pair["op"] == "eq":
                            valid = left == right
                        else:
                            valid = (
                                isinstance(left, str)
                                and isinstance(right, str)
                                and bool(left.strip())
                                and left in right
                            )
                        if not valid:
                            raise ValidationError(f"{label}: related fields do not match")
