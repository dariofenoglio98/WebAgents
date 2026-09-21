"""Finite data constructors and JSON Pointer selection; no executable expressions."""

from __future__ import annotations

import copy

from .errors import ValidationError


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
    return [evaluate(value, environment) for value in expression["array"]]


def references(expression):
    if "from" in expression:
        yield expression["from"], expression["path"]
    elif "object" in expression:
        for value in expression["object"].values():
            yield from references(value)
    elif "coalesce" in expression:
        for value in expression["coalesce"]:
            yield from references(value)
    elif "array" in expression:
        for value in expression["array"]:
            yield from references(value)
