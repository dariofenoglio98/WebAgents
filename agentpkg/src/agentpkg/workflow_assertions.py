"""Three bounded data invariants for validate nodes and answer checks; no scripts or callbacks."""

from __future__ import annotations

from .errors import AgentPkgError, ValidationError
from .runtime import digest
from .workflow_values import evaluate, select


class AssertionFailure(ValidationError):
    """A declared assertion that did not hold, and which part of it.

    `failed_check` names only what the package itself declared — the
    assertion's index and kind, the failure, and the JSON pointers it compared —
    never a value from the data, so it can be recorded in the audit.
    """

    def __init__(self, index, rule, failure, message, **declared):
        super().__init__(f"assertion {index} ({rule['kind']}): {message}")
        self.failed_check = {
            "check": "assertion",
            "index": index,
            "kind": rule["kind"],
            "failure": failure,
            **declared,
        }


class AnswerCheckFailure(AgentPkgError):
    """A model answer that a declared answer check refused: a non-conforming answer.

    Not a `ValidationError`: the answer, not the package, is at fault, so the node fails as
    `model_error` and the audit says `model_output_not_conforming`, as for an answer that breaks
    its schema. `failed_check` names the check by the package's own index, kind and pointers.
    """

    code = "model_output_not_conforming"

    def __init__(self, index, rule, failure, **declared):
        super().__init__(f"answer check {index} ({rule['kind']}): {failure}")
        self.failed_check = {
            "check": "answer_check",
            "index": index,
            "kind": rule["kind"],
            "failure": failure,
            **declared,
        }
        self.audit_facts = {"output_failure": "check"}


def check_answer(checks, env, answer):
    """Evaluate an llm node's `checks` on its schema-valid answer, in order.

    The answer is the `result` source; every other source is the operation's own. A check that
    cannot be evaluated on this answer (a selector finds no data, a lookup finds no member) fails
    as `not_evaluable`: the answer did not provide what its check needs.
    """
    scope = env | {"result": answer}
    for index, rule in enumerate(checks):
        try:
            check_assertions([rule], scope)
        except AssertionFailure as exc:
            facts = exc.failed_check
            declared = {k: v for k, v in facts.items() if k not in ("check", "index", "kind")}
            failure = declared.pop("failure")
            raise AnswerCheckFailure(index, rule, failure, **declared) from exc
        except ValidationError as exc:
            raise AnswerCheckFailure(index, rule, "not_evaluable") from exc


def check_assertions(assertions, env):
    for index, rule in enumerate(assertions):

        def fail(failure, message, **declared):
            raise AssertionFailure(index, rule, failure, message, **declared)

        if rule["kind"] == "equal":
            if evaluate(rule["left"], env) != evaluate(rule["right"], env):
                fail("values_differ", "values differ")
        elif rule["kind"] == "sum":
            rows = evaluate(rule["rows"], env)
            if not isinstance(rows, list):
                fail("rows_not_array", "rows must be an array")
            values = [select(row, rule["path"]) for row in rows]
            if any(isinstance(v, bool) or not isinstance(v, (int, float)) for v in values):
                fail("summand_not_number", "summands must be numbers", path=rule["path"])
            if sum(values) != evaluate(rule["equals"], env):
                fail("sum_differs", "sum differs from required value", path=rule["path"])
        else:
            rows = evaluate(rule["rows"], env)
            targets = evaluate(rule["targets"], env)
            if not isinstance(rows, list) or not isinstance(targets, list):
                fail("operands_not_arrays", "relation operands must be arrays")
            lookup = {}
            for target in targets:
                key = digest(select(target, rule["target_key"]))
                if key in lookup:
                    fail(
                        "duplicate_target_key",
                        "duplicate target key",
                        target_key=rule["target_key"],
                    )
                lookup[key] = target
            for row in rows:
                where = rule.get("where")
                if where and select(row, where["path"]) != where["equals"]:
                    continue
                keys = select(row, rule["row_key"])
                keys = keys if rule.get("many", False) else [keys]
                if not isinstance(keys, list) or not keys:
                    fail("no_key", "relation requires at least one key", row_key=rule["row_key"])
                for key in keys:
                    target = lookup.get(digest(key))
                    if target is None:
                        fail(
                            "missing_target_key",
                            "missing target key",
                            row_key=rule["row_key"],
                            target_key=rule["target_key"],
                        )
                    for path, value in rule.get("target_values", {}).items():
                        if select(target, path) != value:
                            fail("target_value_mismatch", "target value mismatch", path=path)
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
                            fail(
                                "fields_do_not_match",
                                "related fields do not match",
                                compare={
                                    "left": pair["left"],
                                    "right": pair["right"],
                                    "op": pair["op"],
                                },
                            )
