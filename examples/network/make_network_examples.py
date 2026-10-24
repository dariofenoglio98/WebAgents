"""Write the network.v0 example sources and build the test package's unsigned archive.

    agentpkg/.venv/bin/python examples/network/make_network_examples.py [--force]

Writes `network-test/` (`org.webagents.network-test`, a fictional help desk) and
`travel-network/` (`org.webagents.travel-network`, a front-man with flight, hotel and calendar
roles, the shape of the deck's agent collaboration chain), each with a fixture whose route cases
carry exactly the request data the runtime builds (`agentpkg.delegation.analysis.route_data`),
then validates both and builds `network-test.agent.pkg` (unsigned; `--force` replaces it). The
sources are committed; a test regenerates them and asserts nothing changed. Signing is a
separate, deliberate step with the development key, never done here:

    agentpkg/.venv/bin/agentpkg sign examples/network/network-test.agent.pkg \\
        --private-key ~/.config/agentpkg/keys/webagents-network-test.private.pem

A changed source is a new version and a new signature (D-003).
"""

from __future__ import annotations

import json
import shutil
import sys
from collections import Counter
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
sys.path.insert(0, str(ROOT / "agentpkg" / "src"))

from agentpkg.delegation.analysis import route_data
from agentpkg.package import build_package, load_package

SCHEMA = "https://json-schema.org/draft/2020-12/schema"
CREATED = "2026-10-24T12:00:00Z"
PUBLISHER = {"id": "webagents-research", "name": "WebAgents Research"}
ID_PATTERN = "^[A-Za-z][A-Za-z0-9_.:-]{0,127}$"


def state(path):
    return {"from": "state", "path": path}


def message(path=""):
    return {"from": "message", "path": path}


def steps(path):
    return {"from": "steps", "path": path}


def literal(value):
    return {"literal": value}


def manifest(
    package_id, name, description, *, skills, tools, schemas, tasks, readme=True
):
    return {
        "spec_version": "0.1",
        "package_id": package_id,
        "name": name,
        "version": "0.1.0",
        "description": description,
        "publisher": PUBLISHER,
        "created_at": CREATED,
        "runtime": {"api": "agentpkg-runtime-v0", "minimum_version": "0.7.0"},
        "capabilities": [],
        "entrypoint": "workflow.v0",
        "graph": "graph.json",
        "policy": "policy/policy.json",
        "skills": [
            {"id": skill, "version": "0.1.0", "path": f"skills/{skill}/SKILL.md"}
            for skill in skills
        ],
        "tools": [{"id": tool, "path": f"tools/{tool}.tool.json"} for tool in tools],
        "schemas": [
            {"id": name, "path": f"schemas/{name}.schema.json"} for name in schemas
        ],
        "model_requirements": {
            "tasks": [
                {
                    "id": task,
                    "capabilities": ["structured_output"],
                    "context_window": 16000,
                    "preferred_tier": "reasoning",
                }
                for task in tasks
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
    }


def local_tool(tool_id, description, input_schema, output_schema, permission):
    return {
        "spec_version": "0.1",
        "id": tool_id,
        "version": "0.1.0",
        "description": description,
        "execution": "local",
        "binding": f"example.{tool_id.replace('-', '_')}",
        "endpoint": None,
        "method": None,
        "input_schema": f"schemas/{input_schema}.schema.json",
        "output_schema": f"schemas/{output_schema}.schema.json",
        "permissions": [permission],
        "domains": [],
        "timeout_seconds": 10,
        "retries": 0,
        "side_effects": "read",
        "approval_required": False,
        "extensions": {},
    }


def worker(role_id, *, skills=(), tools=(), tokens, remote_calls, read, write):
    return {
        "id": role_id,
        "kind": "packaged",
        "skills": list(skills),
        "tools": list(tools),
        "max_instances": 1,
        "budget": {"tokens": tokens, "remote_calls": remote_calls},
        "state_read": list(read),
        "state_write": list(write),
    }


def policy(
    permissions, *, state_schema, hard_tokens, max_remote_calls, tool_caps, roles
):
    return {
        "spec_version": "0.1",
        "permissions": permissions,
        "network": {
            "allowed_domains": [],
            "https_only": True,
            "allow_redirects": False,
        },
        "memory": {
            "scope": "session",
            "retention": "session",
            "raw_documents": False,
            "state_schema": state_schema,
            "sharing": "explicit_views",
        },
        "budget": {
            "estimated_tokens": min(hard_tokens, 4000),
            "hard_tokens": hard_tokens,
            "max_remote_calls": max_remote_calls,
            "max_calls_per_tool": tool_caps,
            "max_parallel_workers": 2,
            "estimated_cost_usd": None,
            "approval_threshold_tokens": None,
        },
        "delegation": {
            "max_depth": 1,
            "approved_roles": list(roles),
            "allow_remote": False,
        },
        "extensions": {},
    }


def base_permissions(extra):
    return [
        {
            "id": "model.reasoning",
            "kind": "model",
            "description": "Read messages, decide the next role, draft the answer.",
            "required": True,
            "resources": ["host-router"],
        },
        {
            "id": "memory.session",
            "kind": "memory",
            "description": "The run's state and the network's shared state, for this run only.",
            "required": True,
            "resources": ["session"],
        },
        *extra,
    ]


def write_tree(directory: Path, members: dict) -> None:
    if directory.exists():
        shutil.rmtree(directory)
    for name, value in members.items():
        path = directory / name
        path.parent.mkdir(parents=True, exist_ok=True)
        if isinstance(value, str):
            path.write_text(value, encoding="utf-8")
        else:
            path.write_text(
                json.dumps(value, indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
            )


def _append(cases: list, entry: dict) -> None:
    if all(case["input"] != entry["input"] for case in cases):
        cases.append(entry)


# -- the help desk -----------------------------------------------------------------------------

DESK_INPUT = "Hi, what does 'agent package' mean, and can you write it up for me?"
DESK_ANSWER = (
    "A signed, data-only bundle of declarations (skills, tools, schemas, a graph) that a user's "
    "own runtime verifies and runs."
)
DESK_DRAFT = (
    "Draft: An agent package is a signed, data-only bundle that a user's own runtime verifies "
    "and runs."
)
#: What Desk notes about each message it reads: the request, Lookup's answer, Writer's draft.
DESK_NOTES = {
    DESK_INPUT: "asks for the meaning of 'agent package' and a write-up",
    DESK_ANSWER: "the index answered: a signed bundle of declarations",
    DESK_DRAFT: "a draft is ready",
}
DESK_WALK = [
    ("Lookup", "What is an agent package?"),
    ("Writer", "Write a two-sentence answer from what was found."),
    (
        "done",
        (
            "An agent package is a signed, data-only bundle that a user's own runtime verifies "
            "and runs. The write-up is in the draft."
        ),
    ),
]
DESK_ANSWERS = {"What is an agent package?": DESK_ANSWER}


def desk_members() -> dict:
    text = {
        "$schema": SCHEMA,
        "type": "object",
        "properties": {"text": {"type": "string", "minLength": 1, "maxLength": 2000}},
        "required": ["text"],
        "additionalProperties": False,
    }
    answer = {
        "type": "object",
        "properties": {"query": {"type": "string"}, "answer": {"type": "string"}},
        "required": ["query", "answer"],
        "additionalProperties": False,
    }
    result = {
        "$schema": SCHEMA,
        "type": "object",
        "properties": {
            "reply": {"type": "string"},
            "answers": {"type": "array", "items": answer, "maxItems": 64},
            "draft": {"type": ["string", "null"]},
        },
        "required": ["reply", "answers", "draft"],
        "additionalProperties": False,
    }
    roles = {
        "Desk": {
            "description": "Reads each message, keeps a note of it and decides who helps next: "
            "Lookup for a fact, Writer for a write-up, or done with the answer.",
            "steps": [
                {
                    "id": "read",
                    "type": "llm",
                    "task": "read",
                    "max_output_tokens": 300,
                    "input": {"object": {"text": message("/text")}},
                    "output_schema": "schemas/note.schema.json",
                    "timeout_seconds": 60,
                },
                {
                    "id": "notes",
                    "type": "join",
                    "input": {
                        "array": [state("/notes"), {"array": [steps("/read/note")]}]
                    },
                    "output_schema": "schemas/notes.schema.json",
                    "timeout_seconds": 10,
                },
            ],
            "writes": {"/notes": steps("/notes")},
            "route": {
                "task": "route",
                "max_output_tokens": 400,
                "input": {
                    "object": {
                        "text": message("/text"),
                        "notes": steps("/notes"),
                        "answers": state("/answers"),
                        "draft": state("/draft"),
                    }
                },
            },
            "timeout_seconds": 120,
            "edges": [{"to": "Lookup", "max_uses": 2}, {"to": "Writer", "max_uses": 1}],
            "may_end": True,
        },
        "Lookup": {
            "description": "Looks one question up in the desk's index and reports the answer.",
            "steps": [
                {
                    "id": "lookup",
                    "type": "tool",
                    "tool": "lookup",
                    "input": {"object": {"query": message("/text")}},
                    "output_schema": "schemas/answer.schema.json",
                    "timeout_seconds": 10,
                },
                {
                    "id": "collect",
                    "type": "join",
                    "input": {
                        "array": [state("/answers"), {"array": [steps("/lookup")]}]
                    },
                    "output_schema": "schemas/answers.schema.json",
                    "timeout_seconds": 10,
                },
            ],
            "writes": {"/answers": steps("/collect")},
            "route": {
                "next": "Desk",
                "message": {"object": {"text": steps("/lookup/answer")}},
            },
            "timeout_seconds": 30,
            "edges": [{"to": "Desk", "max_uses": 2}],
            "may_end": False,
        },
        "Writer": {
            "description": "Drafts the write-up from the answers found so far.",
            "steps": [
                {
                    "id": "draft",
                    "type": "llm",
                    "task": "draft",
                    "max_output_tokens": 600,
                    "input": {
                        "object": {
                            "answers": state("/answers"),
                            "text": message("/text"),
                        }
                    },
                    "output_schema": "schemas/draft.schema.json",
                    "timeout_seconds": 60,
                }
            ],
            "writes": {"/draft": steps("/draft/draft")},
            "route": {
                "next": "Desk",
                "message": {"object": {"text": steps("/draft/draft")}},
            },
            "timeout_seconds": 90,
            "edges": [{"to": "Desk", "max_uses": 1}],
            "may_end": False,
        },
    }
    graph = {
        "spec_version": "0.1",
        "profile": "workflow.v0",
        "coordinator": "Coordinator",
        "workers": [
            worker(
                "Coordinator",
                tokens=0,
                remote_calls=0,
                read=["request", "result"],
                write=["result"],
            ),
            worker(
                "Desk",
                skills=["desk"],
                tokens=4000,
                remote_calls=4,
                read=["notes", "answers", "draft"],
                write=["notes"],
            ),
            worker(
                "Lookup",
                tools=["lookup"],
                tokens=0,
                remote_calls=0,
                read=["answers"],
                write=["answers"],
            ),
            worker(
                "Writer",
                skills=["writer"],
                tokens=4000,
                remote_calls=2,
                read=["answers", "notes"],
                write=["draft"],
            ),
        ],
        "input_schema": "schemas/message.schema.json",
        "output_schema": "schemas/result.schema.json",
        "initial_state": {
            "object": {
                "request": {"from": "input", "path": ""},
                "result": literal(None),
            }
        },
        "deadline_seconds": 600,
        "network": {
            "entry": "Desk",
            "max_hops": 6,
            "state_schema": "schemas/network-state.schema.json",
            "initial": literal({"notes": [], "answers": [], "draft": None}),
            "message_schema": "schemas/message.schema.json",
            "result": {
                "object": {
                    "reply": message("/text"),
                    "answers": state("/answers"),
                    "draft": state("/draft"),
                }
            },
            "roles": roles,
        },
        "fixture": "fixtures/workflow.json",
        "exports": [
            {
                "path": "answer.json",
                "format": "json",
                "value": {"from": "result", "path": ""},
            },
            {
                "path": "reply.txt",
                "format": "text",
                "value": {"from": "result", "path": "/reply"},
            },
        ],
        "nodes": [
            {
                "id": "delegate",
                "type": "network",
                "worker": "Coordinator",
                "depends_on": [],
                "input": state("/request"),
                "output_schema": "schemas/result.schema.json",
                "timeout_seconds": 500,
                "writes": {"/result": {"from": "result", "path": ""}},
            },
            {
                "id": "output",
                "type": "output",
                "worker": "Coordinator",
                "depends_on": ["delegate"],
                "input": state("/result"),
                "output_schema": "schemas/result.schema.json",
                "timeout_seconds": 10,
                "writes": {},
            },
        ],
        "extensions": {},
    }
    members = {
        "MANIFEST.agent": manifest(
            "org.webagents.network-test",
            "Network Test",
            "A fictional help desk that delegates between a desk, a lookup and a writer role "
            "under network.v0: the test package of the delegation profile.",
            skills=["desk", "writer"],
            tools=["lookup"],
            schemas=[
                "message",
                "state",
                "network-state",
                "note",
                "notes",
                "query",
                "answer",
                "answers",
                "draft",
                "result",
            ],
            tasks=["read", "route", "draft"],
        ),
        "policy/policy.json": policy(
            base_permissions(
                [
                    {
                        "id": "desk.index",
                        "kind": "files.read",
                        "description": "Read the desk's own index (local, fictional).",
                        "required": True,
                        "resources": ["desk-index"],
                    }
                ]
            ),
            state_schema="schemas/state.schema.json",
            hard_tokens=24000,
            max_remote_calls=20,
            tool_caps={"lookup": 2},
            roles=["Desk", "Lookup", "Writer"],
        ),
        "tools/lookup.tool.json": local_tool(
            "lookup",
            "Look one question up in the desk's index.",
            "query",
            "answer",
            "desk.index",
        ),
        "graph.json": graph,
        "skills/desk/SKILL.md": (
            "# Desk\n\nYou are the desk of a small help service. Read the message you were handed, "
            "write one short note about it, and decide who should act next among the targets you "
            "are offered: `Lookup` finds one fact in the index (send it the question as the "
            "message), `Writer` drafts a write-up from the answers found so far (send it what to "
            "write), `done` ends with your answer as the message. Take only targets with uses "
            "left; end when the answers and the draft cover the request.\n"
        ),
        "skills/writer/SKILL.md": (
            "# Writer\n\nDraft a short, plain write-up from the answers you are given and the "
            "instruction in the message. Return it as `draft`.\n"
        ),
        "schemas/message.schema.json": text,
        "schemas/note.schema.json": {
            "$schema": SCHEMA,
            "type": "object",
            "properties": {"note": {"type": "string", "maxLength": 500}},
            "required": ["note"],
            "additionalProperties": False,
        },
        "schemas/notes.schema.json": {
            "$schema": SCHEMA,
            "type": "array",
            "items": {"type": "string"},
            "maxItems": 64,
        },
        "schemas/query.schema.json": {
            "$schema": SCHEMA,
            "type": "object",
            "properties": {"query": {"type": "string", "minLength": 1}},
            "required": ["query"],
            "additionalProperties": False,
        },
        "schemas/answer.schema.json": {"$schema": SCHEMA, **answer},
        "schemas/answers.schema.json": {
            "$schema": SCHEMA,
            "type": "array",
            "items": answer,
            "maxItems": 64,
        },
        "schemas/draft.schema.json": {
            "$schema": SCHEMA,
            "type": "object",
            "properties": {"draft": {"type": "string", "maxLength": 4000}},
            "required": ["draft"],
            "additionalProperties": False,
        },
        "schemas/result.schema.json": result,
        "schemas/network-state.schema.json": {
            "$schema": SCHEMA,
            "type": "object",
            "properties": {
                "notes": {"type": "array", "items": {"type": "string"}, "maxItems": 64},
                "answers": {"type": "array", "items": answer, "maxItems": 64},
                "draft": {"type": ["string", "null"]},
            },
            "required": ["notes", "answers", "draft"],
            "additionalProperties": False,
        },
        "schemas/state.schema.json": {
            "$schema": SCHEMA,
            "type": "object",
            "properties": {
                "request": {"$ref": "message.schema.json"},
                "result": {"anyOf": [{"$ref": "result.schema.json"}, {"type": "null"}]},
            },
            "required": ["request", "result"],
            "additionalProperties": False,
        },
        "README.md": (
            "# Network Test\n\n`org.webagents.network-test`: a fictional help desk that exists to "
            "exercise [network.v0](../../../spec/network-v0.md) in both runtimes. `Desk` (the "
            "entry) reads each message, keeps a note and chooses, at a model-chosen route, between "
            "`Lookup` (one local tool call over a fictional index, a fixed return) and `Writer` "
            "(one model step, a fixed return), or ends with its answer; the shared state holds "
            "the notes, the answers and the draft, each role seeing only its declared part. The "
            "fixture walk is Desk, Lookup, Desk, Writer, Desk, done. The data is fictional.\n\n"
            "It is signed with a development key (`examples/keys/network-test-publisher.pub.pem`) "
            "for the test suites and the conformance suite, and is not shipped in `dist/`. "
            "Regenerate the sources with `python3 examples/network/make_network_examples.py`; a "
            "changed source is a new version of this package and a new signature.\n"
        ),
    }
    members["fixtures/workflow.json"] = desk_fixture(members)
    return members


def desk_fixture(members) -> dict:
    network = members["graph.json"]["network"]
    fixture = {
        "profile": "workflow.fixture.v0",
        "input": {"text": DESK_INPUT},
        "models": {"read": [], "route": [], "draft": []},
        "tools": {"lookup": []},
    }
    notes: list = []
    answers: list = []
    draft = None
    uses: Counter = Counter()
    activations: Counter = Counter({"Desk": 1})
    hop = 0
    current, text = "Desk", DESK_INPUT
    script = list(DESK_WALK)
    while True:
        if current == "Desk":
            note = DESK_NOTES[text]
            _append(
                fixture["models"]["read"],
                {"input": {"text": text}, "output": {"note": note}},
            )
            notes = notes + [note]
            target, reply = script.pop(0)
            data = route_data(
                network,
                "Desk",
                {
                    "text": text,
                    "notes": list(notes),
                    "answers": list(answers),
                    "draft": draft,
                },
                uses,
                activations,
                hop,
            )
            _append(
                fixture["models"]["route"],
                {"input": data, "output": {"next": target, "message": {"text": reply}}},
            )
            if target == "done":
                break
            next_text = reply
        elif current == "Lookup":
            found = {"query": text, "answer": DESK_ANSWERS[text]}
            _append(
                fixture["tools"]["lookup"], {"input": {"query": text}, "output": found}
            )
            answers = answers + [found]
            target, next_text = "Desk", found["answer"]
        else:
            draft = DESK_DRAFT
            _append(
                fixture["models"]["draft"],
                {
                    "input": {"answers": list(answers), "text": text},
                    "output": {"draft": draft},
                },
            )
            target, next_text = "Desk", draft
        uses[(current, target)] += 1
        hop += 1
        activations[target] += 1
        current, text = target, next_text
    return fixture


# -- the travel network ------------------------------------------------------------------------

TRIP = {
    "origin": "BOS",
    "destination": "ZRH",
    "date_out": "2027-03-09",
    "date_back": "2027-03-14",
    "travellers": 1,
}
TRAVEL_INPUT = (
    "Plan a trip from Boston to Zurich: out on 9 March 2027, back on the 14th, one traveller; "
    "check my calendar too."
)
FLIGHTS = [
    {
        "id": "WA201",
        "carrier": "WebAir",
        "depart": "2027-03-09T18:30",
        "price_usd": 640,
    },
    {
        "id": "WA203",
        "carrier": "WebAir",
        "depart": "2027-03-09T21:10",
        "price_usd": 585,
    },
]
HOTELS = [
    {
        "id": "H-ALT",
        "name": "Hotel Altstadt (fictional)",
        "nights": 5,
        "price_usd": 950,
    },
    {"id": "H-SEE", "name": "Seeblick Inn (fictional)", "nights": 5, "price_usd": 1120},
]
CALENDAR = [{"date": "2027-03-11", "title": "Group meeting (movable)"}]
TRAVEL_WALK = [
    (
        "Flights",
        "Find flights BOS to ZRH, out 2027-03-09, back 2027-03-14, one traveller.",
    ),
    ("Hotel", "Find a hotel in Zurich from 2027-03-09 to 2027-03-14."),
    ("Calendar", "Check the calendar from 2027-03-09 to 2027-03-14."),
    (
        "done",
        (
            "Boston to Zurich, 9 to 14 March 2027: WebAir WA203 at 21:10 ($585) and Hotel "
            "Altstadt for five nights ($950); one movable meeting on 11 March. Nothing is booked."
        ),
    ),
]
SUMMARIES = {
    0: "A Boston to Zurich trip, 9 to 14 March 2027, one traveller; the calendar is to be checked.",
    1: "Flights found; hotels and the calendar still to do.",
    2: "Flights and hotels found; the calendar still to do.",
    3: "Flights, hotels and the calendar are in; ready to answer.",
}


def travel_members() -> dict:
    text = {
        "$schema": SCHEMA,
        "type": "object",
        "properties": {"text": {"type": "string", "minLength": 1, "maxLength": 4000}},
        "required": ["text"],
        "additionalProperties": False,
    }
    trip = {
        "type": "object",
        "properties": {
            "origin": {"type": "string", "pattern": "^[A-Z]{3}$"},
            "destination": {"type": "string", "pattern": "^[A-Z]{3}$"},
            "date_out": {"type": "string", "format": "date"},
            "date_back": {"type": "string", "format": "date"},
            "travellers": {"type": "integer", "minimum": 1, "maximum": 9},
        },
        "required": ["origin", "destination", "date_out", "date_back", "travellers"],
        "additionalProperties": False,
    }
    flight = {
        "type": "object",
        "properties": {
            "id": {"type": "string"},
            "carrier": {"type": "string"},
            "depart": {"type": "string"},
            "price_usd": {"type": "integer", "minimum": 0},
        },
        "required": ["id", "carrier", "depart", "price_usd"],
        "additionalProperties": False,
    }
    hotel = {
        "type": "object",
        "properties": {
            "id": {"type": "string"},
            "name": {"type": "string"},
            "nights": {"type": "integer", "minimum": 1},
            "price_usd": {"type": "integer", "minimum": 0},
        },
        "required": ["id", "name", "nights", "price_usd"],
        "additionalProperties": False,
    }
    event = {
        "type": "object",
        "properties": {
            "date": {"type": "string", "format": "date"},
            "title": {"type": "string"},
        },
        "required": ["date", "title"],
        "additionalProperties": False,
    }
    shared = {
        "trip": {"anyOf": [trip, {"type": "null"}]},
        "flights": {"type": "array", "items": flight, "maxItems": 32},
        "hotels": {"type": "array", "items": hotel, "maxItems": 32},
        "calendar": {"type": "array", "items": event, "maxItems": 64},
    }
    result = {
        "$schema": SCHEMA,
        "type": "object",
        "properties": {"plan": {"type": "string"}, **shared},
        "required": ["plan", "trip", "flights", "hotels", "calendar"],
        "additionalProperties": False,
    }
    specialist_message = {
        "object": {"text": literal("Results are in the shared state.")}
    }
    roles = {
        "FrontMan": {
            "description": "Understands the traveller's request, keeps the trip facts, and decides "
            "which specialist to consult next or ends with the plan.",
            "steps": [
                {
                    "id": "understand",
                    "type": "llm",
                    "task": "understand",
                    "max_output_tokens": 600,
                    "input": {
                        "object": {
                            "text": message("/text"),
                            "trip": state("/trip"),
                            "flights": state("/flights"),
                            "hotels": state("/hotels"),
                            "calendar": state("/calendar"),
                        }
                    },
                    "output_schema": "schemas/understanding.schema.json",
                    "timeout_seconds": 90,
                }
            ],
            "writes": {"/trip": steps("/understand/trip")},
            "route": {
                "task": "route",
                "max_output_tokens": 600,
                "input": {
                    "object": {
                        "summary": steps("/understand/summary"),
                        "trip": steps("/understand/trip"),
                        "flights": state("/flights"),
                        "hotels": state("/hotels"),
                        "calendar": state("/calendar"),
                    }
                },
            },
            "timeout_seconds": 200,
            "edges": [
                {"to": "Flights", "max_uses": 1},
                {"to": "Hotel", "max_uses": 1},
                {"to": "Calendar", "max_uses": 1},
            ],
            "may_end": True,
        },
        "Flights": {
            "description": "Searches flights for the trip in the shared state (fictional airline data).",
            "steps": [
                {
                    "id": "search",
                    "type": "tool",
                    "tool": "search-flights",
                    "input": {
                        "object": {
                            "origin": state("/trip/origin"),
                            "destination": state("/trip/destination"),
                            "date": state("/trip/date_out"),
                            "travellers": state("/trip/travellers"),
                        }
                    },
                    "output_schema": "schemas/flight-options.schema.json",
                    "timeout_seconds": 20,
                }
            ],
            "writes": {"/flights": steps("/search/options")},
            "route": {"next": "FrontMan", "message": specialist_message},
            "timeout_seconds": 30,
            "edges": [{"to": "FrontMan", "max_uses": 1}],
            "may_end": False,
        },
        "Hotel": {
            "description": "Searches hotels at the destination for the trip's nights (fictional data).",
            "steps": [
                {
                    "id": "search",
                    "type": "tool",
                    "tool": "search-hotels",
                    "input": {
                        "object": {
                            "city": state("/trip/destination"),
                            "check_in": state("/trip/date_out"),
                            "check_out": state("/trip/date_back"),
                        }
                    },
                    "output_schema": "schemas/hotel-options.schema.json",
                    "timeout_seconds": 20,
                }
            ],
            "writes": {"/hotels": steps("/search/options")},
            "route": {"next": "FrontMan", "message": specialist_message},
            "timeout_seconds": 30,
            "edges": [{"to": "FrontMan", "max_uses": 1}],
            "may_end": False,
        },
        "Calendar": {
            "description": "Lists the traveller's calendar entries over the trip's dates (fictional data).",
            "steps": [
                {
                    "id": "check",
                    "type": "tool",
                    "tool": "check-calendar",
                    "input": {
                        "object": {
                            "from": state("/trip/date_out"),
                            "to": state("/trip/date_back"),
                        }
                    },
                    "output_schema": "schemas/calendar-entries.schema.json",
                    "timeout_seconds": 20,
                }
            ],
            "writes": {"/calendar": steps("/check/entries")},
            "route": {"next": "FrontMan", "message": specialist_message},
            "timeout_seconds": 30,
            "edges": [{"to": "FrontMan", "max_uses": 1}],
            "may_end": False,
        },
    }
    graph = {
        "spec_version": "0.1",
        "profile": "workflow.v0",
        "coordinator": "Coordinator",
        "workers": [
            worker(
                "Coordinator",
                tokens=0,
                remote_calls=0,
                read=["request", "result"],
                write=["result"],
            ),
            worker(
                "FrontMan",
                skills=["front-man"],
                tokens=8000,
                remote_calls=4,
                read=["trip", "flights", "hotels", "calendar"],
                write=["trip"],
            ),
            worker(
                "Flights",
                tools=["search-flights"],
                tokens=0,
                remote_calls=0,
                read=["trip"],
                write=["flights"],
            ),
            worker(
                "Hotel",
                tools=["search-hotels"],
                tokens=0,
                remote_calls=0,
                read=["trip"],
                write=["hotels"],
            ),
            worker(
                "Calendar",
                tools=["check-calendar"],
                tokens=0,
                remote_calls=0,
                read=["trip"],
                write=["calendar"],
            ),
        ],
        "input_schema": "schemas/message.schema.json",
        "output_schema": "schemas/result.schema.json",
        "initial_state": {
            "object": {
                "request": {"from": "input", "path": ""},
                "result": literal(None),
            }
        },
        "deadline_seconds": 900,
        "network": {
            "entry": "FrontMan",
            "max_hops": 6,
            "state_schema": "schemas/network-state.schema.json",
            "initial": literal(
                {"trip": None, "flights": [], "hotels": [], "calendar": []}
            ),
            "message_schema": "schemas/message.schema.json",
            "result": {
                "object": {
                    "plan": message("/text"),
                    "trip": state("/trip"),
                    "flights": state("/flights"),
                    "hotels": state("/hotels"),
                    "calendar": state("/calendar"),
                }
            },
            "roles": roles,
        },
        "fixture": "fixtures/workflow.json",
        "exports": [
            {
                "path": "plan.json",
                "format": "json",
                "value": {"from": "result", "path": ""},
            },
            {
                "path": "plan.txt",
                "format": "text",
                "value": {"from": "result", "path": "/plan"},
            },
        ],
        "nodes": [
            {
                "id": "plan-trip",
                "type": "network",
                "worker": "Coordinator",
                "depends_on": [],
                "input": state("/request"),
                "output_schema": "schemas/result.schema.json",
                "timeout_seconds": 800,
                "writes": {"/result": {"from": "result", "path": ""}},
            },
            {
                "id": "output",
                "type": "output",
                "worker": "Coordinator",
                "depends_on": ["plan-trip"],
                "input": state("/result"),
                "output_schema": "schemas/result.schema.json",
                "timeout_seconds": 10,
                "writes": {},
            },
        ],
        "extensions": {},
    }
    index = {
        "id": "travel.index",
        "kind": "files.read",
        "description": "Read the bundled, fictional airline, hotel and calendar data.",
        "required": True,
        "resources": ["travel-index"],
    }
    members = {
        "MANIFEST.agent": manifest(
            "org.webagents.travel-network",
            "Travel Network",
            "A front-man role that consults flight, hotel and calendar roles, chosen while it "
            "runs, within a declared envelope: the travel example of network.v0. All data is "
            "fictional; nothing is booked.",
            skills=["front-man"],
            tools=["search-flights", "search-hotels", "check-calendar"],
            schemas=[
                "message",
                "state",
                "network-state",
                "understanding",
                "flight-query",
                "flight-options",
                "hotel-query",
                "hotel-options",
                "calendar-query",
                "calendar-entries",
                "result",
            ],
            tasks=["understand", "route"],
        ),
        "policy/policy.json": policy(
            base_permissions([index]),
            state_schema="schemas/state.schema.json",
            hard_tokens=32000,
            max_remote_calls=16,
            tool_caps={"search-flights": 1, "search-hotels": 1, "check-calendar": 1},
            roles=["FrontMan", "Flights", "Hotel", "Calendar"],
        ),
        "tools/search-flights.tool.json": local_tool(
            "search-flights",
            "Search the fictional airline's flights for one date.",
            "flight-query",
            "flight-options",
            "travel.index",
        ),
        "tools/search-hotels.tool.json": local_tool(
            "search-hotels",
            "Search the fictional hotel index for a stay.",
            "hotel-query",
            "hotel-options",
            "travel.index",
        ),
        "tools/check-calendar.tool.json": local_tool(
            "check-calendar",
            "List the traveller's fictional calendar entries over a date range.",
            "calendar-query",
            "calendar-entries",
            "travel.index",
        ),
        "graph.json": graph,
        "skills/front-man/SKILL.md": (
            "# Front man\n\nYou coordinate a small travel service. From the message and the shared "
            "state, restate the trip (`trip`: IATA codes, ISO dates, travellers) and summarize "
            "what is known (`summary`). At the route, consult one specialist at a time among the "
            "targets you are offered, each at most once: `Flights`, `Hotel`, `Calendar`; send "
            "each a one-sentence request as the message. When the flights, the hotel and the "
            "calendar are in the state (or no target has uses left), choose `done` with the plan "
            "as the message: name the cheapest flight and hotel and any calendar conflict, and "
            "say that nothing is booked.\n"
        ),
        "schemas/message.schema.json": text,
        "schemas/understanding.schema.json": {
            "$schema": SCHEMA,
            "type": "object",
            "properties": {
                "trip": trip,
                "summary": {"type": "string", "maxLength": 1000},
            },
            "required": ["trip", "summary"],
            "additionalProperties": False,
        },
        "schemas/flight-query.schema.json": {
            "$schema": SCHEMA,
            "type": "object",
            "properties": {
                "origin": {"type": "string"},
                "destination": {"type": "string"},
                "date": {"type": "string", "format": "date"},
                "travellers": {"type": "integer", "minimum": 1},
            },
            "required": ["origin", "destination", "date", "travellers"],
            "additionalProperties": False,
        },
        "schemas/flight-options.schema.json": {
            "$schema": SCHEMA,
            "type": "object",
            "properties": {
                "options": {"type": "array", "items": flight, "maxItems": 32}
            },
            "required": ["options"],
            "additionalProperties": False,
        },
        "schemas/hotel-query.schema.json": {
            "$schema": SCHEMA,
            "type": "object",
            "properties": {
                "city": {"type": "string"},
                "check_in": {"type": "string", "format": "date"},
                "check_out": {"type": "string", "format": "date"},
            },
            "required": ["city", "check_in", "check_out"],
            "additionalProperties": False,
        },
        "schemas/hotel-options.schema.json": {
            "$schema": SCHEMA,
            "type": "object",
            "properties": {
                "options": {"type": "array", "items": hotel, "maxItems": 32}
            },
            "required": ["options"],
            "additionalProperties": False,
        },
        "schemas/calendar-query.schema.json": {
            "$schema": SCHEMA,
            "type": "object",
            "properties": {
                "from": {"type": "string", "format": "date"},
                "to": {"type": "string", "format": "date"},
            },
            "required": ["from", "to"],
            "additionalProperties": False,
        },
        "schemas/calendar-entries.schema.json": {
            "$schema": SCHEMA,
            "type": "object",
            "properties": {
                "entries": {"type": "array", "items": event, "maxItems": 64}
            },
            "required": ["entries"],
            "additionalProperties": False,
        },
        "schemas/result.schema.json": result,
        "schemas/network-state.schema.json": {
            "$schema": SCHEMA,
            "type": "object",
            "properties": shared,
            "required": ["trip", "flights", "hotels", "calendar"],
            "additionalProperties": False,
        },
        "schemas/state.schema.json": {
            "$schema": SCHEMA,
            "type": "object",
            "properties": {
                "request": {"$ref": "message.schema.json"},
                "result": {"anyOf": [{"$ref": "result.schema.json"}, {"type": "null"}]},
            },
            "required": ["request", "result"],
            "additionalProperties": False,
        },
        "README.md": (
            "# Travel Network\n\n`org.webagents.travel-network`: the travel example of "
            "[network.v0](../../../spec/network-v0.md), the shape of the deck's agent "
            "collaboration chain. `FrontMan` (the entry) restates the trip and, at a model-chosen "
            "route, consults `Flights`, `Hotel` and `Calendar` (each a local, fictional tool and "
            "a fixed return), each at most once within six handoffs, then ends with the plan. "
            "The worst case is exact for this star: the fixture walk is the full tour (FrontMan, "
            "Flights, FrontMan, Hotel, FrontMan, Calendar, FrontMan, done), and "
            "`agentpkg/tests/test_network_travel.py` enumerates every allowed walk and checks "
            "that the bound is attained. All data is fictional; nothing is booked.\n\n"
            "An unsigned source in T25; T26 ships it signed from `agents/travel-network/`. "
            "Regenerate with `python3 examples/network/make_network_examples.py`.\n"
        ),
    }
    members["fixtures/workflow.json"] = travel_fixture(members)
    return members


def travel_fixture(members) -> dict:
    network = members["graph.json"]["network"]
    fixture = {
        "profile": "workflow.fixture.v0",
        "input": {"text": TRAVEL_INPUT},
        "models": {"understand": [], "route": []},
        "tools": {
            "search-flights": [
                {
                    "input": {
                        "origin": TRIP["origin"],
                        "destination": TRIP["destination"],
                        "date": TRIP["date_out"],
                        "travellers": TRIP["travellers"],
                    },
                    "output": {"options": FLIGHTS},
                }
            ],
            "search-hotels": [
                {
                    "input": {
                        "city": TRIP["destination"],
                        "check_in": TRIP["date_out"],
                        "check_out": TRIP["date_back"],
                    },
                    "output": {"options": HOTELS},
                }
            ],
            "check-calendar": [
                {
                    "input": {"from": TRIP["date_out"], "to": TRIP["date_back"]},
                    "output": {"entries": CALENDAR},
                }
            ],
        },
    }
    shared = {"trip": None, "flights": [], "hotels": [], "calendar": []}
    uses: Counter = Counter()
    activations: Counter = Counter({"FrontMan": 1})
    hop = 0
    text = TRAVEL_INPUT
    for visit, (target, reply) in enumerate(TRAVEL_WALK):
        understanding = {"trip": TRIP, "summary": SUMMARIES[visit]}
        _append(
            fixture["models"]["understand"],
            {"input": {"text": text, **shared}, "output": understanding},
        )
        shared["trip"] = TRIP
        data = route_data(
            network,
            "FrontMan",
            {
                "summary": understanding["summary"],
                "trip": TRIP,
                "flights": shared["flights"],
                "hotels": shared["hotels"],
                "calendar": shared["calendar"],
            },
            uses,
            activations,
            hop,
        )
        _append(
            fixture["models"]["route"],
            {"input": data, "output": {"next": target, "message": {"text": reply}}},
        )
        if target == "done":
            break
        uses[("FrontMan", target)] += 1
        activations[target] += 1
        hop += 1
        shared = {
            **shared,
            **{
                "Flights": {"flights": FLIGHTS},
                "Hotel": {"hotels": HOTELS},
                "Calendar": {"calendar": CALENDAR},
            }[target],
        }
        uses[(target, "FrontMan")] += 1
        activations["FrontMan"] += 1
        hop += 1
        text = "Results are in the shared state."
    return fixture


def main(argv) -> int:
    for name, members in (
        ("network-test", desk_members()),
        ("travel-network", travel_members()),
    ):
        write_tree(HERE / name, members)
        package = load_package(HERE / name)
        print(
            f"{name}: validates as {package.manifest['package_id']} {package.manifest['version']}"
        )
    archive = HERE / "network-test.agent.pkg"
    if archive.exists():
        if "--force" not in argv:
            print(
                f"{archive} exists; pass --force to replace the unsigned archive",
                file=sys.stderr,
            )
            return 1
        archive.unlink()
    built = build_package(HERE / "network-test", archive)
    print("built:", built, "digest:", load_package(built).digest)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
