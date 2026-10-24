"""A small generic network.v0 package (spec/network-v0.md), written into a directory so that each
test can change one thing: the network object, a role, an edge, a cap, the state views, the walk
the model takes. A fictional help desk: `Desk` (the entry, a model-chosen route) hands off to
`Lookup` (one local tool, a fixed return) or `Writer` (one model step, a fixed return) and ends.

The fixture is generated from the (mutated) network and a scripted walk with the same
`route_data` the runtime builds, so a scenario's route answers replay exactly; a variant that
changes a cap changes the data and the fixture with it. `VARIANTS` are the named mutations the
enforcement cases use (`examples/network/cases/cases.json`); a conformance driver reuses them.
"""

from __future__ import annotations

import copy
import json
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
CASES = ROOT / "examples" / "network" / "cases"
SCHEMA = "https://json-schema.org/draft/2020-12/schema"
INPUT_TEXT = "hello"
#: The scripted walk: what Desk answers at each of its activations (next, message).
DEFAULT_WALK = [("Lookup", "look up hello"), ("Writer", "write it up"), ("done", "all done")]
NOTES = {"hello": "greeting", "write it up": "drafting", "all done": "closing"}
ANSWERS = {"look up hello": "hello is a greeting"}


def _json(path: Path, value) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


def state(path):
    return {"from": "state", "path": path}


def message(path=""):
    return {"from": "message", "path": path}


def steps(path):
    return {"from": "steps", "path": path}


def grants(**overrides) -> dict:
    base = {"model.reasoning": "session", "memory.session": "session", "desk.read": "session"}
    base.update(overrides)
    return base


def files(*, minimum_version="0.7.0") -> dict:
    """Every member of the probe as JSON values (and the skills' text), before any mutation and
    before the fixture is generated."""
    text = {
        "$schema": SCHEMA,
        "type": "object",
        "properties": {"text": {"type": "string", "minLength": 1}},
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
            "answers": {"type": "array", "items": answer},
            "draft": {"type": ["string", "null"]},
        },
        "required": ["reply", "answers", "draft"],
        "additionalProperties": False,
    }
    network_state = {
        "$schema": SCHEMA,
        "type": "object",
        "properties": {
            "notes": {"type": "array", "items": {"type": "string"}, "maxItems": 64},
            "answers": {"type": "array", "items": answer, "maxItems": 64},
            "draft": {"type": ["string", "null"]},
        },
        "required": ["notes", "answers", "draft"],
        "additionalProperties": False,
    }
    roles = {
        "Desk": {
            "description": "Reads each message, keeps notes, decides who helps next.",
            "steps": [
                {
                    "id": "read",
                    "type": "llm",
                    "task": "read",
                    "max_output_tokens": 200,
                    "input": {"object": {"text": message("/text")}},
                    "output_schema": "schemas/note.schema.json",
                    "timeout_seconds": 30,
                },
                {
                    "id": "notes",
                    "type": "join",
                    "input": {"array": [state("/notes"), {"array": [steps("/read/note")]}]},
                    "output_schema": "schemas/notes.schema.json",
                    "timeout_seconds": 10,
                },
            ],
            "writes": {"/notes": steps("/notes")},
            "route": {
                "task": "route",
                "max_output_tokens": 200,
                "input": {"object": {"text": message("/text"), "notes": steps("/notes")}},
            },
            "timeout_seconds": 60,
            "edges": [{"to": "Lookup", "max_uses": 2}, {"to": "Writer", "max_uses": 1}],
            "may_end": True,
        },
        "Lookup": {
            "description": "Looks one query up in the desk's index and reports the answer.",
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
                    "input": {"array": [state("/answers"), {"array": [steps("/lookup")]}]},
                    "output_schema": "schemas/answers.schema.json",
                    "timeout_seconds": 10,
                },
            ],
            "writes": {"/answers": steps("/collect")},
            "route": {"next": "Desk", "message": {"object": {"text": steps("/lookup/answer")}}},
            "timeout_seconds": 30,
            "edges": [{"to": "Desk", "max_uses": 2}],
            "may_end": False,
        },
        "Writer": {
            "description": "Drafts the reply from the answers found so far.",
            "steps": [
                {
                    "id": "draft",
                    "type": "llm",
                    "task": "draft",
                    "max_output_tokens": 300,
                    "input": {"object": {"answers": state("/answers"), "text": message("/text")}},
                    "output_schema": "schemas/draft.schema.json",
                    "timeout_seconds": 30,
                }
            ],
            "writes": {"/draft": steps("/draft/draft")},
            "route": {"next": "Desk", "message": {"object": {"text": steps("/draft/draft")}}},
            "timeout_seconds": 30,
            "edges": [{"to": "Desk", "max_uses": 1}],
            "may_end": False,
        },
    }
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
                "state_read": ["request", "result"],
                "state_write": ["result"],
            },
            {
                "id": "Desk",
                "kind": "packaged",
                "skills": ["desk"],
                "tools": [],
                "max_instances": 1,
                "budget": {"tokens": 2000, "remote_calls": 0},
                "state_read": ["notes", "answers", "draft"],
                "state_write": ["notes"],
            },
            {
                "id": "Lookup",
                "kind": "packaged",
                "skills": [],
                "tools": ["lookup"],
                "max_instances": 1,
                "budget": {"tokens": 500, "remote_calls": 0},
                "state_read": ["answers"],
                "state_write": ["answers"],
            },
            {
                "id": "Writer",
                "kind": "packaged",
                "skills": ["writer"],
                "tools": [],
                "max_instances": 1,
                "budget": {"tokens": 2000, "remote_calls": 0},
                "state_read": ["answers", "notes"],
                "state_write": ["draft"],
            },
        ],
        "input_schema": "schemas/message.schema.json",
        "output_schema": "schemas/result.schema.json",
        "initial_state": {
            "object": {"request": {"from": "input", "path": ""}, "result": {"literal": None}}
        },
        "deadline_seconds": 300,
        "network": {
            "entry": "Desk",
            "max_hops": 6,
            "state_schema": "schemas/network-state.schema.json",
            "initial": {"literal": {"notes": [], "answers": [], "draft": None}},
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
            {"path": "result-copy.json", "format": "json", "value": {"from": "result", "path": ""}}
        ],
        "nodes": [
            {
                "id": "delegate",
                "type": "network",
                "worker": "Coordinator",
                "depends_on": [],
                "input": state("/request"),
                "output_schema": "schemas/result.schema.json",
                "timeout_seconds": 120,
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
    return {
        "MANIFEST.agent": {
            "spec_version": "0.1",
            "package_id": "org.example.network-probe",
            "name": "Network Probe",
            "version": "0.1.0",
            "description": "A test package for network.v0.",
            "publisher": {"id": "example", "name": "Example"},
            "created_at": "2026-10-24T00:00:00Z",
            "runtime": {"api": "agentpkg-runtime-v0", "minimum_version": minimum_version},
            "capabilities": [],
            "entrypoint": "workflow.v0",
            "graph": "graph.json",
            "policy": "policy/policy.json",
            "skills": [
                {"id": "desk", "version": "0.1.0", "path": "skills/desk/SKILL.md"},
                {"id": "writer", "version": "0.1.0", "path": "skills/writer/SKILL.md"},
            ],
            "tools": [{"id": "lookup", "path": "tools/lookup.tool.json"}],
            "schemas": [
                {"id": name, "path": f"schemas/{name}.schema.json"}
                for name in (
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
                    "any",
                )
            ],
            "model_requirements": {
                "tasks": [
                    {
                        "id": task,
                        "capabilities": ["structured_output"],
                        "context_window": 8000,
                        "preferred_tier": "reasoning",
                    }
                    for task in ("read", "route", "draft")
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
            "permissions": [
                {
                    "id": "model.reasoning",
                    "kind": "model",
                    "description": "Read messages, route, draft.",
                    "required": True,
                    "resources": ["host-router"],
                },
                {
                    "id": "memory.session",
                    "kind": "memory",
                    "description": "Run state.",
                    "required": True,
                    "resources": ["session"],
                },
                {
                    "id": "desk.read",
                    "kind": "files.read",
                    "description": "Read the desk's index (local, fictional).",
                    "required": True,
                    "resources": ["desk-index"],
                },
            ],
            "network": {"allowed_domains": [], "https_only": True, "allow_redirects": False},
            "memory": {
                "scope": "session",
                "retention": "session",
                "raw_documents": False,
                "state_schema": "schemas/state.schema.json",
                "sharing": "explicit_views",
            },
            "budget": {
                "estimated_tokens": 2000,
                "hard_tokens": 11000,
                "max_remote_calls": 0,
                "max_calls_per_tool": {"lookup": 4},
                "max_parallel_workers": 2,
                "estimated_cost_usd": None,
                "approval_threshold_tokens": None,
            },
            "delegation": {
                "max_depth": 1,
                "approved_roles": ["Desk", "Lookup", "Writer"],
                "allow_remote": False,
            },
            "extensions": {},
        },
        "tools/lookup.tool.json": {
            "spec_version": "0.1",
            "id": "lookup",
            "version": "0.1.0",
            "description": "Look one query up in the fictional desk index.",
            "execution": "local",
            "binding": "desk.lookup",
            "endpoint": None,
            "method": None,
            "input_schema": "schemas/query.schema.json",
            "output_schema": "schemas/answer.schema.json",
            "permissions": ["desk.read"],
            "domains": [],
            "timeout_seconds": 10,
            "retries": 0,
            "side_effects": "read",
            "approval_required": False,
            "extensions": {},
        },
        "graph.json": graph,
        "skills/desk/SKILL.md": "# Desk\n\nRead the message; keep a note; choose who helps next.\n",
        "skills/writer/SKILL.md": "# Writer\n\nDraft the reply from the answers.\n",
        "schemas/message.schema.json": text,
        "schemas/any.schema.json": {"$schema": SCHEMA},
        "schemas/note.schema.json": {
            "$schema": SCHEMA,
            "type": "object",
            "properties": {"note": {"type": "string"}},
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
            "properties": {"query": {"type": "string"}},
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
            "properties": {"draft": {"type": "string"}},
            "required": ["draft"],
            "additionalProperties": False,
        },
        "schemas/result.schema.json": result,
        "schemas/network-state.schema.json": network_state,
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
    }


def _append(cases: list, entry: dict) -> None:
    """A fixture lists each input once (validation refuses duplicates)."""
    if all(case["input"] != entry["input"] for case in cases):
        cases.append(entry)


def build_fixture(members: dict, walk) -> dict:
    """The fixture of the probe for one scripted walk: the `read`, `draft` and `lookup` cases
    the walk needs, and a `route` case per Desk activation keyed by the exact route data the
    runtime builds (`route_data`), computed over the (mutated) network. The script may lead the
    model past a cap: the runtime then refuses the transition and the later cases go unused."""
    graph = members["graph.json"]
    network = graph.get("network")
    fixture = {
        "profile": "workflow.fixture.v0",
        "input": {"text": INPUT_TEXT},
        "models": {"read": [], "route": [], "draft": []},
        "tools": {"lookup": []},
    }
    for text, note in {**NOTES, **members.get("_reads", {})}.items():
        _append(fixture["models"]["read"], {"input": {"text": text}, "output": {"note": note}})
    if network is None:
        return fixture
    try:
        _simulate(network, fixture, walk)
    except KeyError:
        # A mutation that names an undeclared role: validation refuses the package before any
        # replay, so the fixture needs no route cases.
        pass
    return fixture


def _simulate(network, fixture, walk) -> None:
    from agentpkg.delegation.analysis import route_data

    notes: list = []
    answers: list = []
    uses: Counter = Counter()
    activations: Counter = Counter({"Desk": 1})
    hop = 0
    current = "Desk"
    text = INPUT_TEXT
    script = list(walk)
    while True:
        if current == "Desk":
            note = NOTES.get(text, f"note:{text}")
            _append(fixture["models"]["read"], {"input": {"text": text}, "output": {"note": note}})
            notes = notes + [note]
            if not script:
                break
            target, reply = script.pop(0)
            data = route_data(
                network, "Desk", {"text": text, "notes": list(notes)}, uses, activations, hop
            )
            _append(
                fixture["models"]["route"],
                {"input": data, "output": {"next": target, "message": {"text": reply}}},
            )
            if target == "done" or not isinstance(reply, str) or target not in network["roles"]:
                # The end, or an answer the runtime refuses before any further activation.
                break
            next_text = reply
        elif current == "Lookup":
            found = {"query": text, "answer": ANSWERS.get(text, f"answer:{text}")}
            _append(fixture["tools"]["lookup"], {"input": {"query": text}, "output": found})
            answers = answers + [found]
            target, next_text = "Desk", found["answer"]
        elif current == "Writer":
            draft = f"draft:{text}"
            _append(
                fixture["models"]["draft"],
                {"input": {"answers": list(answers), "text": text}, "output": {"draft": draft}},
            )
            target, next_text = "Desk", draft
        else:
            break
        uses[(current, target)] += 1
        hop += 1
        activations[target] += 1
        current, text = target, next_text


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


def write_probe(directory: Path, *, mutate=None, walk=None, **options) -> Path:
    """Write the probe into `directory`, after `mutate(members)` changed what the test wants;
    the fixture is generated last, from the mutated network and the walk (`members["_walk"]`
    when a mutation sets one, else `walk`, else the default)."""
    members = files(**options)
    if mutate is not None:
        mutate(members)
    script = members.pop("_walk", None)
    if script is None:
        script = DEFAULT_WALK if walk is None else walk
    members["fixtures/workflow.json"] = build_fixture(members, script)
    members.pop("_reads", None)
    return write(directory, members)


def node(members, node_id):
    return next(n for n in members["graph.json"]["nodes"] if n["id"] == node_id)


def role(members, role_id):
    return members["graph.json"]["network"]["roles"][role_id]


def worker(members, role_id):
    return next(w for w in members["graph.json"]["workers"] if w["id"] == role_id)


# -- the named mutations of the enforcement cases ----------------------------------------------


def _no_node(m):
    m["graph.json"]["nodes"] = [n for n in m["graph.json"]["nodes"] if n["id"] != "delegate"]
    node(m, "output")["depends_on"] = []
    node(m, "output")["input"] = {
        "object": {
            "reply": state("/request/text"),
            "answers": {"literal": []},
            "draft": {"literal": None},
        }
    }


def _two_nodes(m):
    second = copy.deepcopy(node(m, "delegate"))
    second["id"] = "delegate2"
    second["writes"] = {}
    m["graph.json"]["nodes"].insert(1, second)
    node(m, "output")["depends_on"].append("delegate2")


def _node_on_worker(m):
    delegate = node(m, "delegate")
    delegate["worker"] = "Desk"
    delegate["input"] = {"literal": {"text": "hi"}}
    worker(m, "Desk")["state_write"].append("result")


def _route_cap_too_large(m):
    role(m, "Desk")["route"]["max_output_tokens"] = 1000000


def _worker_shared(m):
    m["graph.json"]["nodes"].insert(
        1,
        {
            "id": "extra",
            "type": "llm",
            "worker": "Writer",
            "depends_on": [],
            "task": "read",
            "max_output_tokens": 100,
            "input": {"literal": {"text": "extra"}},
            "output_schema": "schemas/note.schema.json",
            "timeout_seconds": 10,
            "writes": {},
        },
    )
    node(m, "output")["depends_on"].append("extra")


def _without_declaration(m):
    del m["graph.json"]["network"]
    for role_id in ("Desk", "Lookup", "Writer"):
        worker(m, role_id)["state_read"] = []
        worker(m, role_id)["state_write"] = []


def _minimum_version(m):
    m["MANIFEST.agent"]["runtime"]["minimum_version"] = "0.6.0"


def _entry_unknown(m):
    m["graph.json"]["network"]["entry"] = "Nobody"


def _role_unknown(m):
    roles = m["graph.json"]["network"]["roles"]
    roles["Nobody"] = copy.deepcopy(roles["Writer"])


def _role_coordinator(m):
    roles = m["graph.json"]["network"]["roles"]
    roles["Coordinator"] = copy.deepcopy(roles["Writer"])


def _role_reserved(m):
    roles = m["graph.json"]["network"]["roles"]
    roles["done"] = copy.deepcopy(roles["Writer"])


def _edge_unknown(m):
    role(m, "Desk")["edges"].append({"to": "Nobody", "max_uses": 1})


def _edge_duplicate(m):
    role(m, "Desk")["edges"].append({"to": "Lookup", "max_uses": 1})


def _dead_end(m):
    role(m, "Lookup")["edges"] = []


def _state_schema_undeclared(m):
    m["graph.json"]["network"]["state_schema"] = "schemas/missing.schema.json"


def _state_schema_open(m):
    del m["schemas/network-state.schema.json"]["additionalProperties"]


def _state_key_undeclared(m):
    worker(m, "Desk")["state_read"].append("other")


def _initial_not_literal(m):
    m["graph.json"]["network"]["initial"] = {"from": "input", "path": ""}


def _initial_invalid(m):
    m["graph.json"]["network"]["initial"] = {
        "literal": {"notes": "none", "answers": [], "draft": None}
    }


def _message_schema_undeclared(m):
    m["graph.json"]["network"]["message_schema"] = "schemas/missing.schema.json"


def _read_outside_view(m):
    # Lookup's view is `answers`; its step reads `notes`.
    role(m, "Lookup")["steps"][0]["input"] = {"object": {"query": state("/notes/0")}}


def _source_outside(m):
    role(m, "Lookup")["steps"][0]["input"] = {
        "object": {"query": {"from": "input", "path": "/text"}}
    }


def _write_outside_view(m):
    role(m, "Lookup")["writes"]["/draft"] = {"literal": "x"}


def _step_duplicate(m):
    role(m, "Desk")["steps"].append(copy.deepcopy(role(m, "Desk")["steps"][0]))


def _route_task_unknown(m):
    role(m, "Desk")["route"]["task"] = "decide"


def _edge_undeclared(m):
    role(m, "Lookup")["route"]["next"] = "Writer"


def _end_not_allowed(m):
    role(m, "Lookup")["route"]["next"] = "done"


def _bound_exceeds_budget(m):
    # Desk may be activated four times at 2,000 tokens each, plus the others: 11,000 at most;
    # a package budget of 6,000 cannot hold the worst case.
    m["policy/policy.json"]["budget"]["hard_tokens"] = 6000


def _hops_exhausted(m):
    # Two hops admit Desk → Lookup → Desk; the script then asks for Writer at hop 2.
    m["graph.json"]["network"]["max_hops"] = 2


def _edge_exhausted(m):
    # One use of Desk → Lookup; the script takes it twice.
    role(m, "Desk")["edges"][0]["max_uses"] = 1
    m["_walk"] = [("Lookup", "look up hello"), ("Lookup", "look up again"), ("done", "all done")]


def _role_exhausted(m):
    # The edge admits two uses, the role one activation; the script takes it twice.
    role(m, "Lookup")["max_activations"] = 1
    m["_walk"] = [("Lookup", "look up hello"), ("Lookup", "look up again"), ("done", "all done")]


def _two_lookups(m):
    # Control: two lookups within the caps.
    m["_walk"] = [("Lookup", "look up hello"), ("Lookup", "look up again"), ("done", "all done")]


def _target_not_in_enum(m):
    m["_walk"] = [("Nobody", "who?")]


def _message_invalid(m):
    m["_walk"] = [("Lookup", 5)]


def _end_only(m):
    # Control: the entry ends at once; no handoff.
    m["_walk"] = [("done", "nothing to do")]


def _budget_overrun_in_role(m):
    # The Writer's own token budget cannot hold one draft call.
    worker(m, "Writer")["budget"]["tokens"] = 10


def _reservation_refused(m):
    # A model call before the network spends tokens, and the budget is exactly the bound.
    m["graph.json"]["workers"].append(
        {
            "id": "Greeter",
            "kind": "packaged",
            "skills": [],
            "tools": [],
            "max_instances": 1,
            "budget": {"tokens": 1000, "remote_calls": 0},
            "state_read": ["request"],
            "state_write": [],
        }
    )
    m["policy/policy.json"]["delegation"]["approved_roles"].append("Greeter")
    m["graph.json"]["nodes"].insert(
        0,
        {
            "id": "pre",
            "type": "llm",
            "worker": "Greeter",
            "depends_on": [],
            "task": "read",
            "max_output_tokens": 100,
            "input": {"literal": {"text": "pre"}},
            "output_schema": "schemas/note.schema.json",
            "timeout_seconds": 10,
            "writes": {},
        },
    )
    node(m, "delegate")["depends_on"] = ["pre"]
    m["_reads"] = {"pre": "before"}


def _patch_outside_schema(m):
    # The network's state schema admits no string draft; the Writer writes one.
    m["schemas/network-state.schema.json"]["properties"]["draft"] = {"type": ["integer", "null"]}


def _fixed_route_exhausted(m):
    # Lookup may return once; the script sends it twice.
    role(m, "Lookup")["edges"][0]["max_uses"] = 1
    m["_walk"] = [("Lookup", "look up hello"), ("Lookup", "look up again"), ("done", "all done")]


def _read_uninitialized(m):
    # The state schema no longer requires `draft` and `initial` no longer sets it, while Desk's
    # view still reads it: an activation of Desk before the Writer's would see no `draft`.
    m["schemas/network-state.schema.json"]["required"] = ["notes", "answers"]
    del m["graph.json"]["network"]["initial"]["literal"]["draft"]


def _patch_outside_schema_chosen(m):
    # Desk's patch (its notes) leaves the shared state outside its schema, and Desk routes by
    # the model: the patch is refused before any route is asked or paid for.
    m["schemas/network-state.schema.json"]["properties"]["notes"]["maxItems"] = 0


def _answer_check(expected):
    def mutate(m):
        # The Writer's draft step checks its answer, reading it as `result` (workflow.v0 §5).
        role(m, "Writer")["steps"][0]["checks"] = [
            {
                "kind": "equal",
                "left": {"from": "result", "path": "/draft"},
                "right": {"literal": expected},
            }
        ]

    return mutate


VARIANTS = {
    "no-node": _no_node,
    "two-nodes": _two_nodes,
    "node-on-worker": _node_on_worker,
    "worker-shared": _worker_shared,
    "without-declaration": _without_declaration,
    "minimum-version": _minimum_version,
    "entry-unknown": _entry_unknown,
    "role-unknown": _role_unknown,
    "role-coordinator": _role_coordinator,
    "role-reserved": _role_reserved,
    "edge-unknown": _edge_unknown,
    "edge-duplicate": _edge_duplicate,
    "dead-end": _dead_end,
    "state-schema-undeclared": _state_schema_undeclared,
    "state-schema-open": _state_schema_open,
    "state-key-undeclared": _state_key_undeclared,
    "initial-not-literal": _initial_not_literal,
    "initial-invalid": _initial_invalid,
    "message-schema-undeclared": _message_schema_undeclared,
    "read-outside-view": _read_outside_view,
    "source-outside": _source_outside,
    "write-outside-view": _write_outside_view,
    "step-duplicate": _step_duplicate,
    "route-task-unknown": _route_task_unknown,
    "edge-undeclared": _edge_undeclared,
    "end-not-allowed": _end_not_allowed,
    "bound-exceeds-budget": _bound_exceeds_budget,
    "hops-exhausted": _hops_exhausted,
    "edge-exhausted": _edge_exhausted,
    "role-exhausted": _role_exhausted,
    "two-lookups": _two_lookups,
    "target-not-in-enum": _target_not_in_enum,
    "message-invalid": _message_invalid,
    "end-only": _end_only,
    "budget-overrun-in-role": _budget_overrun_in_role,
    "reservation-refused": _reservation_refused,
    "patch-outside-schema": _patch_outside_schema,
    "fixed-route-exhausted": _fixed_route_exhausted,
    "route-cap-too-large": _route_cap_too_large,
    "read-uninitialized": _read_uninitialized,
    "patch-outside-schema-chosen": _patch_outside_schema_chosen,
    "answer-check-refused-in-role": _answer_check("something else"),
    "answer-check-in-role": _answer_check("draft:write it up"),
}
