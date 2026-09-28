"""Finite data constructors, JSON Pointer selection and keyed selection; no executable
expressions."""

from __future__ import annotations

import copy
import json

from .errors import ValidationError


class LookupFailure(ValidationError):
    """A declared keyed selection that did not find exactly one member.

    Like an assertion failure, `failed_check` names only the package's own
    pointers, never a value from the data.
    """

    def __init__(self, failure, message, spec):
        super().__init__(f"lookup: {message}")
        self.failed_check = {
            "check": "lookup",
            "failure": failure,
            "key": spec["key"],
            "path": spec["path"],
        }


def _identity(value):
    """The canonical JSON form `runtime.digest` hashes, so a lookup key compares exactly as a
    relation key does. Kept here because validation-only hosts must not import the runtime."""
    return json.dumps(
        value, sort_keys=True, separators=(",", ":"), ensure_ascii=False, allow_nan=False
    )


def tokens(path):
    return (
        [part.replace("~1", "/").replace("~0", "~") for part in path[1:].split("/")] if path else []
    )


def select(value, path, label="value"):
    try:
        for key in tokens(path):
            if isinstance(value, list):
                if not key.isdigit() or str(int(key)) != key:
                    raise KeyError(key)
                value = value[int(key)]
            else:
                value = value[key]
    except (KeyError, IndexError, TypeError, ValueError) as exc:
        raise ValidationError(f"{label}: missing data at {path!r}") from exc
    return copy.deepcopy(value)


def evaluate(expression, environment):
    if "literal" in expression:
        return copy.deepcopy(expression["literal"])
    if "from" in expression:
        source = expression["from"]
        if source not in environment:
            raise ValidationError(f"Unavailable projection source {source!r}")
        return select(environment[source], expression["path"], source)
    if "coalesce" in expression:
        for child in expression["coalesce"]:
            value = evaluate(child, environment)
            if value is not None:
                return value
        return None
    if "object" in expression:
        return {key: evaluate(value, environment) for key, value in expression["object"].items()}
    if "lookup" in expression:
        return lookup(expression["lookup"], environment)
    return [evaluate(value, environment) for value in expression["array"]]


def lookup(spec, environment):
    """Select `path` from the one member of `in` whose `key` equals `equals`.

    The constructive counterpart of a `relation` assertion's keyed match:
    identical key equality, and exactly one match required. No match, several
    matches, a non-array or a missing pointer fail; nothing is defaulted.
    """
    members = evaluate(spec["in"], environment)
    if not isinstance(members, list):
        raise LookupFailure("not_array", "lookup `in` must be an array", spec)
    wanted = _identity(evaluate(spec["equals"], environment))
    matches = [m for m in members if _identity(select(m, spec["key"], "lookup")) == wanted]
    if not matches:
        raise LookupFailure("no_match", "no member has the requested key", spec)
    if len(matches) > 1:
        raise LookupFailure("duplicate_key", "several members have the requested key", spec)
    return select(matches[0], spec["path"], "lookup")


def references(expression):
    if "from" in expression:
        yield expression["from"], expression["path"]
    elif "lookup" in expression:
        yield from references(expression["lookup"]["in"])
        yield from references(expression["lookup"]["equals"])
    elif "object" in expression:
        for value in expression["object"].values():
            yield from references(value)
    elif "coalesce" in expression:
        for value in expression["coalesce"]:
            yield from references(value)
    elif "array" in expression:
        for value in expression["array"]:
            yield from references(value)
