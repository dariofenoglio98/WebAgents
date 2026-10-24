"""What a package may declare about a conversation, checked at validation (conversation.v0 §2–§4,
V-1…V-20), before any host runs a turn.

Refusals are `ValidationError`s whose text starts with the specification's code, so that both
runtimes refuse a package with the same message (the conformance suite compares refusals).
"""

from __future__ import annotations

import json
from pathlib import Path

from jsonschema import Draft202012Validator

from ..errors import ValidationError
from ..validation import FORMAT_CHECKER, parse_json, release, validate_instance
from ..workflow_values import references

CONVERSATION_MINIMUM_VERSION = "0.6.0"
MAX_TURNS = 256
MAX_TEXT_CHARS = 2000
MAX_STATE_KEYS = 64
#: Permission kinds a consent step may not decide: a model call and the run's own state are not
#: consequential actions a person confirms one by one; they are granted at authorization.
GATE_EXEMPT_KINDS = frozenset({"model", "memory"})
#: Tools bound to the host's memory (memory.v0): host-owned, consented through their permission
#: and the memory's own review, so a conversation never needs a second card for them.
UNGATED_BINDING_PREFIX = "host.memory."
#: The one value a conditional consent step may yield when it is not asked.
DENIAL = {"literal": {"accepted": False}}
CONTRACTS = Path(__file__).resolve().parents[1] / "schemas" / "conversation"
DECISION_SCHEMA = "consent-decision.schema.json"
TRANSCRIPT_INPUT_SCHEMA = "transcript-input.schema.json"
TRANSCRIPT_SCHEMA = "transcript.schema.json"
TRANSCRIPT_SCHEMA_ID = "conversation.transcript.v0"


def contract(name: str) -> dict:
    return json.loads((CONTRACTS / name).read_text(encoding="utf-8"))


def _refuse(code: str, message: str) -> ValidationError:
    error = ValidationError(f"{code}: {message}")
    error.code = code
    return error


def conversation_of(graph) -> dict | None:
    return graph.get("conversation")


def consent_nodes(graph) -> list[dict]:
    return [node for node in graph.get("nodes", []) if node["type"] == "consent"]


def gated_permissions(graph) -> dict[str, list[str]]:
    """Every permission a consent step decides, with the steps that name it (V-9)."""
    gated: dict[str, list[str]] = {}
    for node in consent_nodes(graph):
        for permission_id in node["permissions"]:
            gated.setdefault(permission_id, []).append(node["id"])
    return gated


def persistent_keys(package) -> list[str]:
    """The persistent state's keys, in the order its schema declares them (V-3)."""
    conversation = conversation_of(package.graph)
    if conversation is None:
        return []
    return list(package.json(conversation["state_schema"]).get("properties", {}))


def validate_transcript_document(value, *, form: str, label: str) -> dict:
    """A transcript against the input or the output contract; the message names the first
    error as `validate_document` does."""
    name = TRANSCRIPT_INPUT_SCHEMA if form == "input" else TRANSCRIPT_SCHEMA
    errors = sorted(
        Draft202012Validator(contract(name), format_checker=FORMAT_CHECKER).iter_errors(value),
        key=lambda e: tuple(str(p) for p in e.absolute_path),
    )
    if errors:
        error = errors[0]
        path = "/".join(map(str, error.absolute_path)) or "<root>"
        raise ValidationError(f"{label}/{path}: {error.message}")
    return value


def conversation_initial_env(graph, documents, schema_paths) -> dict:
    """The extra source a conversational graph's `initial_state` may read: the persisted state,
    typed by `conversation.state_schema` (V-4). A graph without a conversation that reads it is
    refused here with the code, before the generic scope check would name the source."""
    conversation = conversation_of(graph)
    referenced = any(source == "conversation" for source, _ in references(graph["initial_state"]))
    if conversation is None:
        if referenced:
            raise _refuse(
                "conversation_source_scope",
                "initial_state reads the conversation state and the graph declares no conversation",
            )
        return {}
    path = conversation["state_schema"]
    if path not in schema_paths:
        raise _refuse(
            "conversation_state_schema_undeclared",
            f"conversation.state_schema {path!r} is not a declared schema",
        )
    return {"conversation": (documents[path], path)}


def check_conversation_declarations(
    manifest,
    graph,
    policy,
    tools,
    files,
    *,
    documents,
    schema,
    expression,
    ancestors,
    nodes,
) -> dict | None:
    """The conversation object, the consent steps, the gate and the fixture transcript against
    the rest of the graph; called by `validate_workflow` after the nodes were checked. A graph
    without a conversation returns None (and may hold no consent step)."""
    from ..package import canonical_json

    conversation = conversation_of(graph)
    consents = consent_nodes(graph)
    if conversation is None:
        if consents:
            raise _refuse(
                "consent_outside_conversation",
                f"node {consents[0]['id']}: a consent step belongs to a conversational graph "
                "(the graph declares no conversation)",
            )
        return None
    if release(manifest["runtime"]["minimum_version"]) < release(CONVERSATION_MINIMUM_VERSION):
        raise _refuse(
            "conversation_minimum_version",
            f"a conversation requires runtime.minimum_version {CONVERSATION_MINIMUM_VERSION} "
            "or later",
        )
    state_path = conversation["state_schema"]
    state_schema = documents[state_path]
    turn_state = documents[policy["memory"]["state_schema"]]
    properties = state_schema.get("properties") if isinstance(state_schema, dict) else None
    if (
        not isinstance(state_schema, dict)
        or state_schema.get("type") != "object"
        or state_schema.get("additionalProperties") is not False
        or not isinstance(properties, dict)
        or len(properties) > MAX_STATE_KEYS
    ):
        raise _refuse(
            "conversation_state_schema_open",
            f"{state_path}: the persistent state is a closed object schema (type object, "
            f"additionalProperties false) of at most {MAX_STATE_KEYS} properties",
        )
    keys = list(properties)
    missing = [key for key in keys if key not in turn_state.get("properties", {})]
    if missing:
        raise _refuse(
            "conversation_state_key_undeclared",
            f"persistent key {missing[0]!r} is not a top-level key of the turn's state schema "
            f"{policy['memory']['state_schema']}",
        )
    initial = conversation["initial"]
    if "literal" not in initial:
        raise _refuse("conversation_initial_literal", "conversation.initial must be a literal")
    try:
        validate_instance(files, state_path, initial["literal"], "conversation.initial")
    except ValidationError as exc:
        raise _refuse("conversation_initial_invalid", str(exc)) from exc
    budget = conversation["budget"]
    turn_budget = policy["budget"]
    if (
        budget["hard_tokens"] < turn_budget["hard_tokens"]
        or budget["max_remote_calls"] < turn_budget["max_remote_calls"]
    ):
        raise _refuse(
            "conversation_budget_below_turn",
            "conversation.budget must admit at least one turn: hard_tokens >= "
            f"{turn_budget['hard_tokens']} and max_remote_calls >= "
            f"{turn_budget['max_remote_calls']}",
        )
    unknown = sorted(set(budget.get("max_calls_per_tool", {})) - set(tools))
    if unknown:
        raise _refuse(
            "conversation_tool_unknown",
            f"conversation.budget.max_calls_per_tool names undeclared tool {unknown[0]!r}",
        )
    end = conversation.get("end")
    if end is not None:
        env = {
            "result": schema(graph["output_schema"], "conversation.end"),
            "state": (state_schema, state_path),
        }
        for side in ("left", "right"):
            expression(end["when"][side], env, "conversation.end/when/" + side)
    permissions = {p["id"]: p for p in policy["permissions"]}
    coordinator = graph["coordinator"]
    decision = canonical_json(contract(DECISION_SCHEMA))
    for node in consents:
        label = f"workflow node {node['id']}"
        if node["worker"] != coordinator:
            raise _refuse(
                "consent_role", f"{label}: a consent step runs on the coordinator, not on a worker"
            )
        for permission_id in node["permissions"]:
            permission = permissions.get(permission_id)
            if permission is None:
                raise _refuse(
                    "consent_permission_unknown",
                    f"{label}: permission {permission_id!r} is not declared",
                )
            if permission["kind"] in GATE_EXEMPT_KINDS:
                raise _refuse(
                    "consent_permission_kind",
                    f"{label}: a consent step cannot decide a permission of kind "
                    f"{permission['kind']} ({permission_id})",
                )
        if canonical_json(documents[node["output_schema"]]) != decision:
            raise _refuse(
                "consent_decision_schema",
                f"{label}: output_schema must be the consent decision contract "
                f"({DECISION_SCHEMA}) exactly",
            )
        if "otherwise" in node and node["otherwise"] != DENIAL:
            raise _refuse(
                "consent_otherwise_accepts",
                f"{label}: a consent step that is not asked yields "
                '{"literal": {"accepted": false}} and nothing else',
            )
    gated = gated_permissions(graph)
    from ..delegation.analysis import role_steps

    for nid, node in nodes.items():
        operations = (
            [(node["id"], node)]
            if node["type"] == "tool"
            else [
                (f"{nid}/{step['id']}", step)
                for step in node.get("steps", [])
                if step["type"] == "tool"
            ]
        )
        if node["type"] == "network":
            # network.v0: a role's tool step runs inside the network node, so the node holding
            # the network must depend on the consent step that gates the permission.
            operations = [
                (name, step) for name, step in role_steps(graph) if step["type"] == "tool"
            ]
        for name, operation in operations:
            for permission_id in tools[operation["tool"]]["permissions"]:
                steps = gated.get(permission_id)
                if steps and not any(step in ancestors[nid] for step in steps):
                    raise _refuse(
                        "consent_missing_before_tool",
                        f"workflow node {name}: tool {operation['tool']!r} links "
                        f"{permission_id}, which consent step(s) {steps} decide, and the node "
                        "does not depend on one of them",
                    )
    for tool_id, tool in sorted(tools.items()):
        binding = tool["binding"] or ""
        if (
            tool["side_effects"] == "write"
            and not binding.startswith(UNGATED_BINDING_PREFIX)
            and not any(permission_id in gated for permission_id in tool["permissions"])
        ):
            raise _refuse(
                "consent_required_for_write",
                f"tool {tool_id!r} has write side effects and links no permission a consent "
                "step decides; in a conversation every consequential tool is behind a consent "
                "step",
            )
    fixture_path = conversation.get("fixture")
    if fixture_path is not None:
        _check_fixture(graph, files, fixture_path, consents, budget)
    return {"keys": keys, "gated": gated, "consent_steps": [node["id"] for node in consents]}


def _check_fixture(graph, files, path, consents, budget) -> None:
    if path not in files:
        raise _refuse("conversation_fixture_missing", f"missing conversation fixture {path}")
    transcript = parse_json(files[path], path)
    try:
        validate_transcript_document(transcript, form="input", label=path)
    except ValidationError as exc:
        raise _refuse("conversation_fixture_invalid", str(exc)) from exc
    if not graph.get("fixture"):
        raise _refuse(
            "conversation_fixture_requires_graph_fixture",
            f"{path}: a conversation fixture replays the graph's own fixture, which the graph "
            "does not declare",
        )
    turns = transcript["turns"]
    if len(turns) > budget["max_turns"]:
        raise _refuse(
            "conversation_fixture_turns",
            f"{path}: {len(turns)} turns, above the conversation's max_turns of "
            f"{budget['max_turns']}",
        )
    steps = {node["id"] for node in consents}
    for index, turn in enumerate(turns, start=1):
        try:
            validate_instance(
                files, graph["input_schema"], turn["message"], f"{path} turn {index} message"
            )
        except ValidationError as exc:
            raise _refuse("conversation_fixture_message", str(exc)) from exc
        unknown = sorted(set(turn.get("consents", {})) - steps)
        if unknown:
            raise _refuse(
                "consent_step_unknown",
                f"{path} turn {index}: no consent step {unknown[0]!r} in the graph",
            )
    graph_fixture = parse_json(files[graph["fixture"]], graph["fixture"])
    if graph_fixture.get("input") != turns[0]["message"]:
        raise _refuse(
            "conversation_fixture_input",
            f"{graph['fixture']}: its input must equal the conversation fixture's first message",
        )


def conversation_records(package) -> dict | None:
    """The conversation as `inspect` and the agent page list it (V-20): the persistent keys, the
    budget, the end rule, and each consent step with the permissions it decides."""
    conversation = conversation_of(package.graph)
    if conversation is None:
        return None
    steps = [
        {
            "id": node["id"],
            "permissions": list(node["permissions"]),
            "timeout_seconds": node["timeout_seconds"],
            "conditional": "when" in node,
            "depends_on": list(node["depends_on"]),
        }
        for node in consent_nodes(package.graph)
    ]
    return {
        "state_schema": conversation["state_schema"],
        "persistent_keys": persistent_keys(package),
        "budget": {
            "max_turns": conversation["budget"]["max_turns"],
            "hard_tokens": conversation["budget"]["hard_tokens"],
            "max_remote_calls": conversation["budget"]["max_remote_calls"],
            "max_calls_per_tool": dict(conversation["budget"].get("max_calls_per_tool", {})),
        },
        "end_declared": "end" in conversation,
        "fixture_declared": "fixture" in conversation,
        "consent_steps": steps,
        "gated_permissions": gated_permissions(package.graph),
    }


__all__ = [
    "CONVERSATION_MINIMUM_VERSION",
    "DECISION_SCHEMA",
    "DENIAL",
    "GATE_EXEMPT_KINDS",
    "MAX_STATE_KEYS",
    "MAX_TEXT_CHARS",
    "MAX_TURNS",
    "TRANSCRIPT_INPUT_SCHEMA",
    "TRANSCRIPT_SCHEMA",
    "TRANSCRIPT_SCHEMA_ID",
    "UNGATED_BINDING_PREFIX",
    "check_conversation_declarations",
    "consent_nodes",
    "contract",
    "conversation_initial_env",
    "conversation_of",
    "conversation_records",
    "gated_permissions",
    "persistent_keys",
    "validate_transcript_document",
]
