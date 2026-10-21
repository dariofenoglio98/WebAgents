"""A small generic conversation.v0 package (spec/conversation-v0.md), written into a directory so
that each test can change one thing: the conversation object, a consent step, the tool it gates,
the persistent state, the fixture transcript. The shape is the ticket desk of
`examples/conversation/conversation-test`, reduced: one model step that reads a message (its
replay cases are keyed by the text alone, so a scenario's history never changes them), one consent
step before one write tool, two joins that carry the history and the orders across turns.

`VARIANTS` are the named mutations the enforcement cases use (`examples/conversation/cases/
cases.json`); a conformance driver reuses them.
"""

from __future__ import annotations

import copy
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
CASES = ROOT / "examples" / "conversation" / "cases"
CONTRACTS = ROOT / "spec" / "conversation-v0"
SCHEMA = "https://json-schema.org/draft/2020-12/schema"
DECISION_SCHEMA = json.loads((CONTRACTS / "consent-decision.schema.json").read_text())

MESSAGES = {
    "order A": {
        "intent": "order",
        "show": "Show A",
        "quantity": 1,
        "reply": "Order one ticket to Show A?",
    },
    "order B": {
        "intent": "order",
        "show": "Show B",
        "quantity": 2,
        "reply": "Order two tickets to Show B?",
    },
    "hello": {"intent": "chat", "show": None, "quantity": None, "reply": "Hello! Which show?"},
    "done": {"intent": "done", "show": None, "quantity": None, "reply": "Goodbye."},
}
ORDERS = {
    ("Show A", 1): {"order_id": "TD-0001", "show": "Show A", "quantity": 1, "total_usd": 40},
    ("Show B", 2): {"order_id": "TD-0002", "show": "Show B", "quantity": 2, "total_usd": 90},
}


def _json(path: Path, value) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


def state(path):
    return {"from": "state", "path": path}


def message(text):
    return {"text": text}


def transcript(*turns, end=None):
    """`transcript(("order A", {"confirm": True}), "done")`: a turn is a text or a (text,
    consents) pair."""
    document = {"schema": "conversation.transcript.v0", "turns": []}
    for turn in turns:
        text, consents = (turn, None) if isinstance(turn, str) else turn
        entry = {"message": message(text)}
        if consents is not None:
            entry["consents"] = consents
        document["turns"].append(entry)
    if end is not None:
        document["end"] = end
    return document


def grants(**overrides) -> dict:
    base = {"model.reasoning": "session", "memory.session": "session", "orders.place": "session"}
    base.update(overrides)
    return base


def files(*, minimum_version="0.6.0", side_effects="write", remote_tool=False) -> dict:
    """Every member of the probe as JSON values (and the skill's text), before any mutation."""
    order = {
        "type": "object",
        "properties": {
            "order_id": {"type": "string"},
            "show": {"type": "string"},
            "quantity": {"type": "integer", "minimum": 1},
            "total_usd": {"type": "integer", "minimum": 0},
        },
        "required": ["order_id", "show", "quantity", "total_usd"],
        "additionalProperties": False,
    }
    entry = {
        "type": "object",
        "properties": {"text": {"type": "string"}, "intent": {"enum": ["order", "chat", "done"]}},
        "required": ["text", "intent"],
        "additionalProperties": False,
    }
    interpretation = {
        "type": "object",
        "properties": {
            "intent": {"enum": ["order", "chat", "done"]},
            "show": {"type": ["string", "null"]},
            "quantity": {"type": ["integer", "null"], "minimum": 1},
            "reply": {"type": "string", "minLength": 1},
        },
        "required": ["intent", "show", "quantity", "reply"],
        "additionalProperties": False,
    }
    reply = {
        "type": "object",
        "properties": {
            "reply": {"type": "string"},
            "intent": {"enum": ["order", "chat", "done"]},
            "order": {"anyOf": [order, {"type": "null"}]},
        },
        "required": ["reply", "intent", "order"],
        "additionalProperties": False,
    }
    tool = {
        "spec_version": "0.1",
        "id": "place",
        "version": "0.1.0",
        "description": "Place one order at the fictional desk.",
        "execution": "remote" if remote_tool else "local",
        "binding": "desk.place_order",
        "endpoint": "https://desk.example.org/api/orders" if remote_tool else None,
        "method": "POST" if remote_tool else None,
        "input_schema": "schemas/order-input.schema.json",
        "output_schema": "schemas/order.schema.json",
        "permissions": ["orders.place"] + (["network.desk"] if remote_tool else []),
        "domains": ["desk.example.org"] if remote_tool else [],
        "timeout_seconds": 10,
        "retries": 0,
        "side_effects": side_effects,
        "approval_required": True,
        "extensions": {},
    }
    permissions = [
        {
            "id": "model.reasoning",
            "kind": "model",
            "description": "Read each message.",
            "required": True,
            "resources": ["host-router"],
        },
        {
            "id": "memory.session",
            "kind": "memory",
            "description": "Turn state.",
            "required": True,
            "resources": ["session"],
        },
        {
            "id": "orders.place",
            "kind": "payment",
            "description": "Place an order (simulated).",
            "required": False,
            "resources": ["desk"],
        },
    ]
    if remote_tool:
        permissions.append(
            {
                "id": "network.desk",
                "kind": "network",
                "description": "Reach the desk.",
                "required": True,
                "resources": ["desk.example.org"],
            }
        )
    nodes = [
        {
            "id": "interpret",
            "type": "llm",
            "worker": "Clerk",
            "depends_on": [],
            "task": "interpret",
            "max_output_tokens": 300,
            "input": {"object": {"text": state("/request/text")}},
            "output_schema": "schemas/interpretation.schema.json",
            "timeout_seconds": 30,
            "writes": {"/interpretation": {"from": "result", "path": ""}},
        },
        {
            "id": "confirm",
            "type": "consent",
            "worker": "Coordinator",
            "depends_on": ["interpret"],
            "when": {
                "left": state("/interpretation/intent"),
                "op": "eq",
                "right": {"literal": "order"},
            },
            "otherwise": {"literal": {"accepted": False}},
            "permissions": ["orders.place"],
            "text": state("/interpretation/reply"),
            "input": {
                "object": {
                    "show": state("/interpretation/show"),
                    "quantity": state("/interpretation/quantity"),
                }
            },
            "output_schema": "schemas/consent-decision.schema.json",
            "timeout_seconds": 30,
            "writes": {"/decision": {"from": "result", "path": ""}},
        },
        {
            "id": "place",
            "type": "tool",
            "worker": "Desk",
            "depends_on": ["confirm"],
            "tool": "place",
            "when": {"left": state("/decision/accepted"), "op": "eq", "right": {"literal": True}},
            "otherwise": {"literal": None},
            "input": {
                "object": {
                    "show": state("/interpretation/show"),
                    "quantity": state("/interpretation/quantity"),
                }
            },
            "output_schema": "schemas/order-result.schema.json",
            "timeout_seconds": 20,
            "writes": {"/order": {"from": "result", "path": ""}},
        },
        {
            "id": "orders",
            "type": "join",
            "worker": "Coordinator",
            "depends_on": ["place"],
            "when": {"left": state("/order"), "op": "ne", "right": {"literal": None}},
            "otherwise": state("/orders"),
            "input": {"array": [state("/orders"), {"array": [state("/order")]}]},
            "output_schema": "schemas/orders.schema.json",
            "timeout_seconds": 10,
            "writes": {"/orders": {"from": "result", "path": ""}},
        },
        {
            "id": "history",
            "type": "join",
            "worker": "Coordinator",
            "depends_on": ["interpret"],
            "input": {
                "array": [
                    state("/history"),
                    {
                        "array": [
                            {
                                "object": {
                                    "text": state("/request/text"),
                                    "intent": state("/interpretation/intent"),
                                }
                            }
                        ]
                    },
                ]
            },
            "output_schema": "schemas/history.schema.json",
            "timeout_seconds": 10,
            "writes": {"/history": {"from": "result", "path": ""}},
        },
        {
            "id": "assemble",
            "type": "validate",
            "worker": "Coordinator",
            "depends_on": ["orders", "history"],
            "input": {
                "object": {
                    "reply": state("/interpretation/reply"),
                    "intent": state("/interpretation/intent"),
                    "order": state("/order"),
                }
            },
            "output_schema": "schemas/reply.schema.json",
            "timeout_seconds": 10,
            "writes": {"/reply": {"from": "result", "path": ""}},
        },
        {
            "id": "output",
            "type": "output",
            "worker": "Coordinator",
            "depends_on": ["assemble"],
            "input": state("/reply"),
            "output_schema": "schemas/output.schema.json",
            "timeout_seconds": 10,
            "writes": {},
        },
    ]
    graph = {
        "spec_version": "0.1",
        "profile": "workflow.v0",
        "coordinator": "Coordinator",
        "workers": [
            {
                "id": "Coordinator",
                "kind": "packaged",
                "skills": [],
                "tools": [],
                "max_instances": 1,
                "budget": {"tokens": 0, "remote_calls": 0},
                "state_read": [
                    "request",
                    "history",
                    "orders",
                    "interpretation",
                    "decision",
                    "order",
                    "reply",
                ],
                "state_write": ["decision", "orders", "history", "reply"],
            },
            {
                "id": "Clerk",
                "kind": "packaged",
                "skills": ["desk"],
                "tools": [],
                "max_instances": 1,
                "budget": {"tokens": 4000, "remote_calls": 0},
                "state_read": ["request"],
                "state_write": ["interpretation"],
            },
            {
                "id": "Desk",
                "kind": "packaged",
                "skills": [],
                "tools": ["place"],
                "max_instances": 1,
                "budget": {"tokens": 0, "remote_calls": 1 if remote_tool else 0},
                "state_read": ["interpretation", "decision"],
                "state_write": ["order"],
            },
        ],
        "input_schema": "schemas/input.schema.json",
        "output_schema": "schemas/output.schema.json",
        "initial_state": {
            "object": {
                "request": {"from": "input", "path": ""},
                "history": {"from": "conversation", "path": "/history"},
                "orders": {"from": "conversation", "path": "/orders"},
                "interpretation": {"literal": None},
                "decision": {"literal": None},
                "order": {"literal": None},
                "reply": {"literal": None},
            }
        },
        "deadline_seconds": 60,
        "conversation": {
            "state_schema": "schemas/conversation-state.schema.json",
            "initial": {"literal": {"history": [], "orders": []}},
            "budget": {
                "max_turns": 4,
                "hard_tokens": 16000,
                "max_remote_calls": 4,
                "max_calls_per_tool": {"place": 2},
            },
            "end": {
                "when": {
                    "left": {"from": "result", "path": "/intent"},
                    "op": "eq",
                    "right": {"literal": "done"},
                }
            },
            "fixture": "fixtures/transcript.json",
        },
        "fixture": "fixtures/workflow.json",
        "exports": [
            {"path": "reply.json", "format": "json", "value": {"from": "result", "path": ""}}
        ],
        "nodes": nodes,
        "extensions": {},
    }
    return {
        "MANIFEST.agent": {
            "spec_version": "0.1",
            "package_id": "org.example.conversation-probe",
            "name": "Conversation Probe",
            "version": "0.1.0",
            "description": "A test package for conversation.v0.",
            "publisher": {"id": "example", "name": "Example"},
            "created_at": "2026-10-21T00:00:00Z",
            "runtime": {"api": "agentpkg-runtime-v0", "minimum_version": minimum_version},
            "capabilities": [],
            "entrypoint": "workflow.v0",
            "graph": "graph.json",
            "policy": "policy/policy.json",
            "skills": [{"id": "desk", "version": "0.1.0", "path": "skills/desk/SKILL.md"}],
            "tools": [{"id": "place", "path": "tools/place.tool.json"}],
            "schemas": [
                {"id": name, "path": f"schemas/{name}.schema.json"}
                for name in (
                    "input",
                    "state",
                    "conversation-state",
                    "interpretation",
                    "consent-decision",
                    "order-input",
                    "order",
                    "order-result",
                    "history",
                    "orders",
                    "reply",
                    "output",
                    "any",
                )
            ],
            "model_requirements": {
                "tasks": [
                    {
                        "id": "interpret",
                        "capabilities": ["structured_output"],
                        "context_window": 8000,
                        "preferred_tier": "reasoning",
                    }
                ],
                "routing": "host",
                "fallback_policy": "deny",
                "extensions": {},
            },
            "evals": [],
            "attestations": [],
            "dependencies": [],
            "update": {"channel": "local", "locator": None},
            "extensions": {},
        },
        "policy/policy.json": {
            "spec_version": "0.1",
            "permissions": permissions,
            "network": {
                "allowed_domains": ["desk.example.org"] if remote_tool else [],
                "https_only": True,
                "allow_redirects": False,
            },
            "memory": {
                "scope": "session",
                "retention": "session",
                "raw_documents": False,
                "state_schema": "schemas/state.schema.json",
                "sharing": "explicit_views",
            },
            "budget": {
                "estimated_tokens": 500,
                "hard_tokens": 4000,
                "max_remote_calls": 1 if remote_tool else 0,
                "max_calls_per_tool": {"place": 1},
                "max_parallel_workers": 2,
                "estimated_cost_usd": None,
                "approval_threshold_tokens": None,
            },
            "delegation": {
                "max_depth": 1,
                "approved_roles": ["Clerk", "Desk"],
                "allow_remote": False,
            },
            "extensions": {},
        },
        "tools/place.tool.json": tool,
        "graph.json": graph,
        "skills/desk/SKILL.md": "# Desk\n\nRead the message; answer the JSON object.\n",
        "schemas/input.schema.json": {
            "$schema": SCHEMA,
            "type": "object",
            "properties": {"text": {"type": "string", "minLength": 1}},
            "required": ["text"],
            "additionalProperties": False,
        },
        "schemas/any.schema.json": {"$schema": SCHEMA},
        "schemas/history.schema.json": {
            "$schema": SCHEMA,
            "type": "array",
            "items": entry,
            "maxItems": 256,
        },
        "schemas/orders.schema.json": {
            "$schema": SCHEMA,
            "type": "array",
            "items": order,
            "maxItems": 256,
        },
        "schemas/conversation-state.schema.json": {
            "$schema": SCHEMA,
            "type": "object",
            "properties": {
                "history": {"$ref": "history.schema.json"},
                "orders": {"$ref": "orders.schema.json"},
            },
            "required": ["history", "orders"],
            "additionalProperties": False,
        },
        "schemas/interpretation.schema.json": {"$schema": SCHEMA, **interpretation},
        "schemas/consent-decision.schema.json": copy.deepcopy(DECISION_SCHEMA),
        "schemas/order-input.schema.json": {
            "$schema": SCHEMA,
            "type": "object",
            "properties": {
                "show": {"type": "string"},
                "quantity": {"type": "integer", "minimum": 1},
            },
            "required": ["show", "quantity"],
            "additionalProperties": False,
        },
        "schemas/order.schema.json": {"$schema": SCHEMA, **order},
        "schemas/order-result.schema.json": {
            "$schema": SCHEMA,
            "anyOf": [{"$ref": "order.schema.json"}, {"type": "null"}],
        },
        "schemas/reply.schema.json": {"$schema": SCHEMA, **reply},
        "schemas/output.schema.json": {"$schema": SCHEMA, **reply},
        "schemas/state.schema.json": {
            "$schema": SCHEMA,
            "type": "object",
            "properties": {
                "request": {"$ref": "input.schema.json"},
                "history": {"$ref": "history.schema.json"},
                "orders": {"$ref": "orders.schema.json"},
                "interpretation": {
                    "anyOf": [{"$ref": "interpretation.schema.json"}, {"type": "null"}]
                },
                "decision": {"anyOf": [{"$ref": "consent-decision.schema.json"}, {"type": "null"}]},
                "order": {"$ref": "order-result.schema.json"},
                "reply": {"anyOf": [{"$ref": "reply.schema.json"}, {"type": "null"}]},
            },
            "required": [
                "request",
                "history",
                "orders",
                "interpretation",
                "decision",
                "order",
                "reply",
            ],
            "additionalProperties": False,
        },
        "fixtures/workflow.json": {
            "profile": "workflow.fixture.v0",
            "input": message("order A"),
            "models": {
                "interpret": [
                    {"input": {"text": text}, "output": answer} for text, answer in MESSAGES.items()
                ]
            },
            "tools": {
                "place": [
                    {"input": {"show": show, "quantity": quantity}, "output": answer}
                    for (show, quantity), answer in ORDERS.items()
                ]
            },
        },
        "fixtures/transcript.json": transcript(("order A", {"confirm": True}), "done"),
    }


def write(directory: Path, members: dict) -> Path:
    directory.mkdir(parents=True, exist_ok=True)
    for name, value in members.items():
        path = directory / name
        if isinstance(value, str):
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(value, encoding="utf-8")
        else:
            _json(path, value)
    return directory


def write_probe(directory: Path, *, mutate=None, **options) -> Path:
    """Write the probe into `directory`, after `mutate(members)` changed what the test wants."""
    members = files(**options)
    if mutate is not None:
        mutate(members)
    return write(directory, members)


def node(members, node_id):
    return next(n for n in members["graph.json"]["nodes"] if n["id"] == node_id)


# -- the named mutations of the enforcement cases ----------------------------------------------


def _no_conversation(m):
    del m["graph.json"]["conversation"]
    m["graph.json"]["initial_state"]["object"]["history"] = {"literal": []}
    m["graph.json"]["initial_state"]["object"]["orders"] = {"literal": []}


def _consent_outside(m):
    _no_conversation(m)


def _plain(m):
    """The same desk as a one-shot package: no conversation, no consent step, a read tool."""
    _no_conversation(m)
    m["graph.json"]["nodes"] = [n for n in m["graph.json"]["nodes"] if n["id"] != "confirm"]
    place = node(m, "place")
    place["depends_on"] = ["interpret"]
    place["when"] = {
        "left": state("/interpretation/intent"),
        "op": "eq",
        "right": {"literal": "order"},
    }
    m["tools/place.tool.json"]["side_effects"] = "read"


def _source_outside(m):
    del m["graph.json"]["conversation"]
    m["graph.json"]["nodes"] = [n for n in m["graph.json"]["nodes"] if n["id"] != "confirm"]
    node(m, "place")["depends_on"] = ["interpret"]
    m["tools/place.tool.json"]["side_effects"] = "read"


def _state_schema_undeclared(m):
    m["graph.json"]["conversation"]["state_schema"] = "schemas/missing.schema.json"


def _state_schema_open(m):
    del m["schemas/conversation-state.schema.json"]["additionalProperties"]


def _state_key_undeclared(m):
    m["schemas/conversation-state.schema.json"]["properties"]["notes"] = {"type": "string"}


def _initial_not_literal(m):
    m["graph.json"]["conversation"]["initial"] = {"from": "input", "path": ""}


def _initial_invalid(m):
    m["graph.json"]["conversation"]["initial"] = {"literal": {"history": [], "orders": "none"}}


def _budget_below_turn(m):
    m["graph.json"]["conversation"]["budget"]["hard_tokens"] = 100


def _tool_cap_unknown(m):
    m["graph.json"]["conversation"]["budget"]["max_calls_per_tool"] = {"other": 1}


def _consent_on_worker(m):
    confirm = node(m, "confirm")
    confirm["worker"] = "Clerk"
    confirm["text"] = {"literal": "Order?"}
    confirm["input"] = {"literal": {}}
    del confirm["when"]
    del confirm["otherwise"]
    clerk = next(w for w in m["graph.json"]["workers"] if w["id"] == "Clerk")
    clerk["state_write"].append("decision")


def _consent_permission_unknown(m):
    node(m, "confirm")["permissions"] = ["orders.other"]


def _consent_permission_kind(m):
    node(m, "confirm")["permissions"] = ["model.reasoning"]
    m["tools/place.tool.json"]["side_effects"] = "read"


def _consent_decision_schema(m):
    node(m, "confirm")["output_schema"] = "schemas/any.schema.json"


def _consent_otherwise_accepts(m):
    node(m, "confirm")["otherwise"] = {"literal": {"accepted": True}}


def _tool_before_consent(m):
    place = node(m, "place")
    place["depends_on"] = ["interpret"]
    place["input"] = {"literal": {"show": "Show A", "quantity": 1}}
    del place["when"]
    del place["otherwise"]
    node(m, "assemble")["depends_on"].append("confirm")


def _write_tool_ungated(m):
    # The consent step stays and decides nothing the tool links.
    m["policy/policy.json"]["permissions"].append(
        {
            "id": "orders.confirm",
            "kind": "payment",
            "description": "Confirm.",
            "required": False,
            "resources": ["desk"],
        }
    )
    node(m, "confirm")["permissions"] = ["orders.confirm"]


def _fixture_step_unknown(m):
    m["fixtures/transcript.json"]["turns"][0]["consents"] = {"other": True}


def _fixture_too_many_turns(m):
    m["fixtures/transcript.json"]["turns"] = [{"message": message("hello")}] * 5


def _fixture_message_invalid(m):
    m["fixtures/transcript.json"]["turns"][1]["message"] = {"text": ""}


def _fixture_input_mismatch(m):
    m["fixtures/workflow.json"]["input"] = message("hello")


def _consent_text_not_string(m):
    node(m, "confirm")["text"] = state("/interpretation/quantity")


def _tool_after_denied_consent(m):
    place = node(m, "place")
    place["input"] = {"literal": {"show": "Show A", "quantity": 1}}
    del place["when"]
    del place["otherwise"]


def _tool_after_skipped_consent(m):
    _tool_after_denied_consent(m)


def _state_outside_schema(m):
    # The turn builds a history entry the conversation's state schema refuses (an extra field),
    # while the turn's own state schema admits it.
    m["schemas/history.schema.json"]["items"]["properties"]["extra"] = {"type": "string"}
    turn_entry = copy.deepcopy(m["schemas/history.schema.json"])
    m["schemas/history.schema.json"] = turn_entry
    strict = copy.deepcopy(turn_entry)
    del strict["items"]["properties"]["extra"]
    m["schemas/history-strict.schema.json"] = strict
    m["MANIFEST.agent"]["schemas"].append(
        {"id": "history-strict", "path": "schemas/history-strict.schema.json"}
    )
    m["schemas/conversation-state.schema.json"]["properties"]["history"] = {
        "$ref": "history-strict.schema.json"
    }
    node(m, "history")["input"]["array"][1]["array"][0]["object"]["extra"] = {"literal": "x"}


def _minimum_version(m):
    m["MANIFEST.agent"]["runtime"]["minimum_version"] = "0.5.0"


def _tool_cap_one(m):
    m["graph.json"]["conversation"]["budget"]["max_calls_per_tool"] = {"place": 1}


VARIANTS = {
    "consent-outside-conversation": _consent_outside,
    "conversation-source-outside": _source_outside,
    "minimum-version": _minimum_version,
    "state-schema-undeclared": _state_schema_undeclared,
    "state-schema-open": _state_schema_open,
    "state-key-undeclared": _state_key_undeclared,
    "initial-not-literal": _initial_not_literal,
    "initial-invalid": _initial_invalid,
    "budget-below-turn": _budget_below_turn,
    "tool-cap-unknown": _tool_cap_unknown,
    "consent-on-worker": _consent_on_worker,
    "consent-permission-unknown": _consent_permission_unknown,
    "consent-permission-kind": _consent_permission_kind,
    "consent-decision-schema": _consent_decision_schema,
    "consent-otherwise-accepts": _consent_otherwise_accepts,
    "tool-before-consent": _tool_before_consent,
    "write-tool-ungated": _write_tool_ungated,
    "fixture-step-unknown": _fixture_step_unknown,
    "fixture-too-many-turns": _fixture_too_many_turns,
    "fixture-message-invalid": _fixture_message_invalid,
    "fixture-input-mismatch": _fixture_input_mismatch,
    "consent-text-not-string": _consent_text_not_string,
    "tool-after-denied-consent": _tool_after_denied_consent,
    "tool-after-skipped-consent": _tool_after_skipped_consent,
    "state-outside-schema": _state_outside_schema,
    "tool-cap-one": _tool_cap_one,
    "plain": _plain,
}
