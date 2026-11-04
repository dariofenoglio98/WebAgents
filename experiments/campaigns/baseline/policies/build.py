"""Progent's manually written policy for each ported package (PROTOCOL.md §2.5 rule 7, D-350).

Rule 7 runs one configuration: Progent's hand-written policy, written from the package's
declaration: allow exactly the package's tools with the argument constraints the bindings' schemas
state, forbid every other tool. In Progent's DSL (`secagent.tool`, read at `b02783b`) that is, per
tool, one rule `(priority 1, effect 0 allow, {argument: JSON Schema}, fallback 0 deny)`; a tool with
no rule is denied by `check_tool_call`, and every destination is fixed by the tool's declared
endpoint, so no argument names one. Each argument's schema is the declared input schema's property
with its `$ref`s inlined (Progent validates each top-level argument on its own, without the root's
`$defs`).

The files are written by this script from the signed package's declarations, not by a model, and a
test (`tests/test_baseline.py`) proves the committed files equal what it writes:

    agentpkg/.venv/bin/python -m campaigns.baseline.policies.build   # from experiments/
"""

from __future__ import annotations

import copy
import hashlib
import json
from pathlib import Path

from campaigns.baseline import ports

HERE = Path(__file__).resolve().parent


def _inline(value, defs: dict):
    if isinstance(value, dict):
        ref = value.get("$ref")
        if isinstance(ref, str) and ref.startswith("#/$defs/"):
            target = copy.deepcopy(defs[ref.removeprefix("#/$defs/")])
            rest = {k: v for k, v in value.items() if k != "$ref"}
            return _inline({**target, **rest}, defs)
        return {k: _inline(v, defs) for k, v in value.items()}
    if isinstance(value, list):
        return [_inline(v, defs) for v in value]
    return value


def argument_rules(schema: dict) -> dict:
    defs = schema.get("$defs") or {}
    return {
        name: _inline(prop, defs) for name, prop in sorted((schema.get("properties") or {}).items())
    }


def policy_for(port: str) -> dict:
    package = ports.load(port)
    rules = {}
    for tool in ports.function_tool_specs(package):
        rules[tool["name"]] = [[1, 0, argument_rules(tool["schema"]), 0]]
    return {
        "schema": "campaign.progent-policy.v1",
        "port": port,
        "package": {
            "package_id": package.manifest["package_id"],
            "version": package.manifest["version"],
            "digest": package.digest,
        },
        "progent": {"repository": ports.PROGENT_REPOSITORY, "commit": ports.PROGENT_COMMIT},
        "dsl": "tool -> [[priority, effect (0 allow, 1 forbid), {argument: JSON Schema}, "
        "fallback (0 deny)]]; a tool with no rule is denied",
        "rules": dict(sorted(rules.items())),
    }


def text_of(policy: dict) -> str:
    return json.dumps(policy, ensure_ascii=False, indent=1, sort_keys=False) + "\n"


def path_of(port: str) -> Path:
    return HERE / f"{port}.json"


def load(port: str) -> dict:
    return json.loads(path_of(port).read_text())


def sha256(port: str) -> str:
    return hashlib.sha256(path_of(port).read_bytes()).hexdigest()


def progent_rules(policy: dict) -> dict:
    """The committed file in Progent's in-memory form (`update_security_policy`)."""
    return {tool: [tuple(rule) for rule in rules] for tool, rules in policy["rules"].items()}


def main() -> None:
    for port in ports.PORTS:
        path_of(port).write_text(text_of(policy_for(port)))
        print(path_of(port))


if __name__ == "__main__":
    main()
