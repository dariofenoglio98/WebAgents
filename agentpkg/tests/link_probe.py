"""A small generic link.v0 composition (spec/link-v0.md), written into a directory so that each
test can change one thing. The caller is network.v0's help desk (`network_probe`) with its two
specialists turned into links: `Lookup` asks the linked package `index` (one local tool) and
`Writer` asks the linked package `scribe` (one model step). Each linked package is its own
publisher's: its own permissions, grants, approvals and fixture.

`scenario()` is the composition before anything is written; a variant of `VARIANTS` (the named
mutations of `examples/link/cases/cases.json`) changes one thing; `write()` builds and signs
the linked archives, pins them in the caller's dependency records, generates the three fixtures
from one scripted walk with the runtime's own route data, and writes the caller's source. A
conformance driver reuses all of it.
"""

from __future__ import annotations

import copy
from collections import Counter
from dataclasses import dataclass, field
from pathlib import Path

import network_probe as base
from network_probe import SCHEMA, message, state, steps

ROOT = Path(__file__).resolve().parents[2]
CASES = ROOT / "examples" / "link" / "cases"
CONVERSATIONAL = ROOT / "examples" / "conversation" / "conversation-test.agent.pkg"
CALLER_ID = "org.example.link-probe"
#: The full tour: every specialist as often as its edges allow, so the composed bound is attained.
FULL_TOUR = [
    ("Lookup", "look up hello"),
    ("Lookup", "look up more"),
    ("Writer", "write it up"),
    ("done", "all done"),
]
ANSWER = {
    "type": "object",
    "properties": {"query": {"type": "string"}, "answer": {"type": "string"}},
    "required": ["query", "answer"],
    "additionalProperties": False,
}


def _manifest(package_id, name, *, skills, tools, schemas, tasks, minimum_version="0.8.0"):
    return {
        "spec_version": "0.1",
        "package_id": package_id,
        "name": name,
        "version": "0.1.0",
        "description": f"A test package for link.v0: {name}.",
        "publisher": {"id": "example", "name": "Example"},
        "created_at": "2026-11-15T00:00:00Z",
        "runtime": {"api": "agentpkg-runtime-v0", "minimum_version": minimum_version},
        "capabilities": [],
        "entrypoint": "workflow.v0",
        "graph": "graph.json",
        "policy": "policy/policy.json",
        "skills": [{"id": s, "version": "0.1.0", "path": f"skills/{s}/SKILL.md"} for s in skills],
        "tools": [{"id": t, "path": f"tools/{t}.tool.json"} for t in tools],
        "schemas": [{"id": s, "path": f"schemas/{s}.schema.json"} for s in schemas],
        "model_requirements": {
            "tasks": [
                {
                    "id": task,
                    "capabilities": ["structured_output"],
                    "context_window": 8000,
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


def _policy(permissions, *, hard_tokens, tool_caps, roles):
    described = {
        "model.reasoning": ("model", "Draft.", ["host-router"]),
        "memory.session": ("memory", "Run state.", ["session"]),
        "desk.read": ("files.read", "Read the desk's index (local, fictional).", ["desk-index"]),
    }
    return {
        "spec_version": "0.1",
        "permissions": [
            {
                "id": pid,
                "kind": described[pid][0],
                "description": described[pid][1],
                "required": True,
                "resources": described[pid][2],
            }
            for pid in permissions
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
            "estimated_tokens": hard_tokens,
            "hard_tokens": hard_tokens,
            "max_remote_calls": 0,
            "max_calls_per_tool": dict(tool_caps),
            "max_parallel_workers": 2,
            "estimated_cost_usd": None,
            "approval_threshold_tokens": None,
        },
        "delegation": {"max_depth": 1, "approved_roles": list(roles), "allow_remote": False},
        "extensions": {},
    }


def _plain_graph(worker, node, *, input_schema, output_schema):
    """A one-step workflow.v0 graph: the worker's node over the whole request, then the output."""
    return {
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
            worker,
        ],
        "input_schema": input_schema,
        "output_schema": output_schema,
        "initial_state": {
            "object": {"request": {"from": "input", "path": ""}, "result": {"literal": None}}
        },
        "deadline_seconds": 60,
        "fixture": "fixtures/workflow.json",
        "exports": [],
        "nodes": [
            {
                **node,
                "worker": worker["id"],
                "depends_on": [],
                "input": state("/request"),
                "output_schema": output_schema,
                "timeout_seconds": 20,
                "writes": {"/result": {"from": "result", "path": ""}},
            },
            {
                "id": "output",
                "type": "output",
                "worker": "Coordinator",
                "depends_on": [node["id"]],
                "input": state("/result"),
                "output_schema": output_schema,
                "timeout_seconds": 10,
                "writes": {},
            },
        ],
        "extensions": {},
    }


def _state_schema(request, result):
    return {
        "$schema": SCHEMA,
        "type": "object",
        "properties": {
            "request": {"$ref": request},
            "result": {"anyOf": [{"$ref": result}, {"type": "null"}]},
        },
        "required": ["request", "result"],
        "additionalProperties": False,
    }


def index_files() -> dict:
    """The linked package `index`: one local tool over a fictional index, no model."""
    worker = {
        "id": "Finder",
        "kind": "packaged",
        "skills": [],
        "tools": ["lookup"],
        "max_instances": 1,
        "budget": {"tokens": 0, "remote_calls": 0},
        "state_read": ["request"],
        "state_write": ["result"],
    }
    members = base.files()
    return {
        "MANIFEST.agent": _manifest(
            "org.example.link-probe.index",
            "Index",
            skills=[],
            tools=["lookup"],
            schemas=["query", "answer", "state"],
            tasks=[],
        ),
        "policy/policy.json": _policy(
            # A model permission it never uses: the control plane plans a model-backed run only
            # for a package that declares one.
            ["model.reasoning", "memory.session", "desk.read"],
            hard_tokens=1,
            tool_caps={"lookup": 1},
            roles=["Finder"],
        ),
        "graph.json": _plain_graph(
            worker,
            {"id": "lookup", "type": "tool", "tool": "lookup"},
            input_schema="schemas/query.schema.json",
            output_schema="schemas/answer.schema.json",
        ),
        "tools/lookup.tool.json": members["tools/lookup.tool.json"],
        "schemas/query.schema.json": members["schemas/query.schema.json"],
        "schemas/answer.schema.json": {"$schema": SCHEMA, **ANSWER},
        "schemas/state.schema.json": _state_schema("query.schema.json", "answer.schema.json"),
    }


def scribe_files() -> dict:
    """The linked package `scribe`: one model step that drafts a reply from the answers."""
    worker = {
        "id": "Scribe",
        "kind": "packaged",
        "skills": ["writer"],
        "tools": [],
        "max_instances": 1,
        "budget": {"tokens": 1500, "remote_calls": 0},
        "state_read": ["request"],
        "state_write": ["result"],
    }
    members = base.files()
    return {
        "MANIFEST.agent": _manifest(
            "org.example.link-probe.scribe",
            "Scribe",
            skills=["writer"],
            tools=[],
            schemas=["draft-request", "draft", "state"],
            tasks=["draft"],
        ),
        "policy/policy.json": _policy(
            ["model.reasoning", "memory.session"], hard_tokens=1500, tool_caps={}, roles=["Scribe"]
        ),
        "graph.json": _plain_graph(
            worker,
            {"id": "draft", "type": "llm", "task": "draft", "max_output_tokens": 300},
            input_schema="schemas/draft-request.schema.json",
            output_schema="schemas/draft.schema.json",
        ),
        "skills/writer/SKILL.md": members["skills/writer/SKILL.md"],
        "schemas/draft-request.schema.json": {
            "$schema": SCHEMA,
            "type": "object",
            "properties": {
                "answers": {"type": "array", "items": ANSWER, "maxItems": 64},
                "text": {"type": "string"},
            },
            "required": ["answers", "text"],
            "additionalProperties": False,
        },
        "schemas/draft.schema.json": members["schemas/draft.schema.json"],
        "schemas/state.schema.json": _state_schema(
            "draft-request.schema.json", "draft.schema.json"
        ),
    }


def caller_files() -> dict:
    """The caller: the help desk whose `Lookup` and `Writer` each hold one `link` step. It
    declares no tool and no drafting task: both belong to the linked packages now."""
    members = base.files(minimum_version="0.8.0")
    manifest = members["MANIFEST.agent"]
    manifest["package_id"] = CALLER_ID
    manifest["name"] = "Link Probe"
    manifest["description"] = "A test package for link.v0."
    manifest["tools"] = []
    manifest["model_requirements"]["tasks"] = [
        task for task in manifest["model_requirements"]["tasks"] if task["id"] != "draft"
    ]
    manifest["schemas"].append({"id": "outcome", "path": "schemas/outcome.schema.json"})
    del members["tools/lookup.tool.json"]
    policy = members["policy/policy.json"]
    policy["permissions"] = [p for p in policy["permissions"] if p["id"] != "desk.read"]
    policy["budget"]["max_calls_per_tool"] = {}
    # A person may put an address in the request: the one thing a slot's `locate` reads (L-7).
    members["schemas/message.schema.json"]["properties"]["url"] = {
        "type": ["string", "null"],
        "format": "uri",
    }
    members["schemas/outcome.schema.json"] = {
        "$schema": SCHEMA,
        "type": "object",
        "properties": {
            "joined": {"type": "boolean"},
            "reason": {"type": ["string", "null"]},
            "result": {},
        },
        "required": ["joined", "reason", "result"],
        "additionalProperties": False,
    }
    for role_id in ("Lookup", "Writer"):
        worker = base.worker(members, role_id)
        worker["tools"] = []
        worker["budget"]["tokens"] = 0
    lookup = base.role(members, "Lookup")["steps"][0]
    lookup.pop("tool")
    lookup.update(type="link", dependency="index", timeout_seconds=20)
    draft = base.role(members, "Writer")["steps"][0]
    for key in ("task", "max_output_tokens"):
        draft.pop(key)
    draft.update(type="link", dependency="scribe", timeout_seconds=25)
    return members


def map_caller_files() -> dict:
    """A caller without a network: one map whose step asks `index` once per query."""
    queries = {"$schema": SCHEMA, "type": "array", "items": {"type": "string"}, "maxItems": 3}
    answers = {"$schema": SCHEMA, "type": "array", "items": ANSWER, "maxItems": 3}
    worker = {
        "id": "Fan",
        "kind": "packaged",
        "skills": [],
        "tools": [],
        "max_instances": 2,
        "budget": {"tokens": 0, "remote_calls": 0},
        "state_read": ["request"],
        "state_write": ["result"],
    }
    graph = _plain_graph(
        worker,
        {
            "id": "ask",
            "type": "map",
            "item_schema": "schemas/item.schema.json",
            "max_items": 3,
            "max_parallel": 2,
            "steps": [
                {
                    "id": "one",
                    "type": "link",
                    "dependency": "index",
                    "input": {"object": {"query": {"from": "item", "path": ""}}},
                    "output_schema": "schemas/answer.schema.json",
                    "timeout_seconds": 20,
                }
            ],
            "yield": steps("/one"),
        },
        input_schema="schemas/queries.schema.json",
        output_schema="schemas/answers.schema.json",
    )
    return {
        "MANIFEST.agent": _manifest(
            "org.example.link-probe.map",
            "Link Map Probe",
            skills=[],
            tools=[],
            schemas=["queries", "item", "answer", "answers", "state"],
            tasks=[],
        ),
        "policy/policy.json": _policy(
            ["memory.session"], hard_tokens=10, tool_caps={}, roles=["Fan"]
        ),
        "graph.json": graph,
        "schemas/queries.schema.json": queries,
        "schemas/item.schema.json": {"$schema": SCHEMA, "type": "string"},
        "schemas/answer.schema.json": {"$schema": SCHEMA, **ANSWER},
        "schemas/answers.schema.json": answers,
        "schemas/state.schema.json": _state_schema("queries.schema.json", "answers.schema.json"),
    }


@dataclass
class Scenario:
    """One composition before it is written: the caller, its linked packages, the person's
    decisions, and what a variant overrides."""

    caller: dict = field(default_factory=caller_files)
    linked: dict = field(default_factory=lambda: {"index": index_files(), "scribe": scribe_files()})
    #: The person's decision per dependency (`links.operator.operator_links`'s shape).
    decisions: dict = field(
        default_factory=lambda: {
            "index": {
                "decision": "accepted",
                "grants": {
                    "model.reasoning": "session",
                    "memory.session": "session",
                    "desk.read": "session",
                },
                "approved_tools": ["lookup"],
            },
            "scribe": {
                "decision": "accepted",
                "grants": {"model.reasoning": "session", "memory.session": "session"},
                "approved_tools": [],
            },
        }
    )
    grants: dict = field(
        default_factory=lambda: {"model.reasoning": "session", "memory.session": "session"}
    )
    limits: dict | None = None
    walk: list = field(default_factory=lambda: list(base.DEFAULT_WALK))
    #: Linked packages left unsigned, an archive taken as it is, fields of a pinned record
    #: replaced, records added.
    unsigned: set = field(default_factory=set)
    archives: dict = field(default_factory=dict)
    record_overrides: dict = field(default_factory=dict)
    extra_records: list = field(default_factory=list)
    #: A map caller's input, and the inner fixture cases its queries need.
    queries: list | None = None


@dataclass
class Built:
    caller: Path
    archives: dict
    decisions: dict
    grants: dict
    limits: dict | None
    public_keys: list

    def argv(self, directory: Path) -> list[str]:
        """The `agentpkg run` arguments beside the package and `--out`: what a conformance
        runner passes to either CLI."""
        import json

        argv = []
        for name, archive in sorted(self.archives.items()):
            argv += ["--link", f"{name}={archive}"]
        for name, decision in sorted(self.decisions.items()):
            if decision["decision"] != "accepted":
                argv += ["--deny-link", name]
                continue
            path = directory / f"{name}.grants.json"
            path.write_text(json.dumps(decision["grants"]), encoding="utf-8")
            argv += ["--link-grants", f"{name}={path}"]
            for tool in decision.get("approved_tools", []):
                argv += ["--approve-tool", f"{name}:{tool}"]
        if self.limits:
            path = directory / "limits.json"
            path.write_text(json.dumps(self.limits), encoding="utf-8")
            argv += ["--limits", str(path)]
        return argv


def _fixtures(scenario: Scenario) -> dict:
    """The three fixtures of one scripted walk: the caller's `read` and `route` cases (the route
    data as the runtime builds it, a denied link's role left out), `index`'s lookups and
    `scribe`'s drafts."""
    from agentpkg.delegation.analysis import route_data

    caller = {
        "profile": "workflow.fixture.v0",
        "input": {"text": base.INPUT_TEXT},
        "models": {"read": [], "route": []},
        "tools": {},
    }
    index = {"profile": "workflow.fixture.v0", "input": None, "models": {}, "tools": {"lookup": []}}
    scribe = {"profile": "workflow.fixture.v0", "input": None, "models": {"draft": []}, "tools": {}}
    network = scenario.caller["graph.json"].get("network")
    denied = {
        role_id
        for role_id, role in (network or {"roles": {}})["roles"].items()
        if any(
            step.get("type") == "link"
            and scenario.decisions.get(step.get("dependency"), {}).get("decision") == "denied"
            for step in role["steps"]
        )
    }
    notes, answers = [], []
    uses, activations = Counter(), Counter({"Desk": 1})
    hop, current, text = 0, "Desk", base.INPUT_TEXT
    script = list(scenario.walk)
    while network is not None:
        if current == "Desk":
            note = base.NOTES.get(text, f"note:{text}")
            base._append(
                caller["models"]["read"], {"input": {"text": text}, "output": {"note": note}}
            )
            notes = notes + [note]
            if not script:
                break
            target, reply = script.pop(0)
            data = route_data(
                network,
                "Desk",
                {"text": text, "notes": list(notes)},
                uses,
                activations,
                hop,
                denied,
            )
            base._append(
                caller["models"]["route"],
                {"input": data, "output": {"next": target, "message": {"text": reply}}},
            )
            if target == "done" or target not in network["roles"]:
                break
            next_text = reply
        elif current == "Lookup":
            found = {"query": text, "answer": base.ANSWERS.get(text, f"answer:{text}")}
            base._append(index["tools"]["lookup"], {"input": {"query": text}, "output": found})
            answers = answers + [found]
            target, next_text = "Desk", found["answer"]
        elif current == "Writer":
            request = {"answers": list(answers), "text": text}
            draft = f"draft:{text}"
            base._append(scribe["models"]["draft"], {"input": request, "output": {"draft": draft}})
            target, next_text = "Desk", draft
        else:
            break
        uses[(current, target)] += 1
        hop += 1
        activations[target] += 1
        current, text = target, next_text
    for query in scenario.queries or []:
        found = {"query": query, "answer": f"answer:{query}"}
        base._append(index["tools"]["lookup"], {"input": {"query": query}, "output": found})
    if scenario.queries is not None:
        caller["input"] = list(scenario.queries)
        caller["models"] = {}
    # A fixture names an input its package accepts, used or not.
    index["input"] = (index["tools"]["lookup"] or [{"input": {"query": "none"}}])[0]["input"]
    scribe["input"] = (scribe["models"]["draft"] or [{"input": {"answers": [], "text": "none"}}])[
        0
    ]["input"]
    return {"caller": caller, "index": index, "scribe": scribe}


def write(directory: Path, scenario: Scenario, keys: dict) -> Built:
    """Write one composition: each linked package built and signed (unless a variant says
    otherwise) with its own publisher's key (`keys`: `{name: (private, public)}`, `default` for
    a name it does not hold), its identity and digest pinned in the caller's records, then the
    caller's source with its fixture. Nothing here validates the caller: a test or a CLI does."""
    from agentpkg.package import build_package, load_package
    from agentpkg.signing import _read_key, fingerprint, sign_package

    directory.mkdir(parents=True, exist_ok=True)
    fixtures = _fixtures(scenario)
    archives, records = {}, []
    for name, members in scenario.linked.items():
        private_key, public_key = keys.get(name, keys["default"])
        if name in scenario.archives:
            archive = Path(scenario.archives[name])
        else:
            members = copy.deepcopy(members)
            if "fixtures/workflow.json" not in members and name in fixtures:
                members["fixtures/workflow.json"] = fixtures[name]
            source = base.write(directory / "linked" / name, members)
            unsigned = build_package(source, directory / f"{name}.unsigned.agent.pkg")
            archive = unsigned
            if name not in scenario.unsigned:
                archive = sign_package(unsigned, private_key, directory / f"{name}.agent.pkg")
        archives[name] = Path(archive)
        package = load_package(archive)
        record = {
            "id": name,
            "package_id": package.manifest["package_id"],
            "version": package.manifest["version"],
            "digest": package.digest,
            "locator": f"https://packages.example/{name}.agent.pkg",
            "signer": fingerprint(_read_key(public_key)),
        }
        record.update(scenario.record_overrides.get(name, {}))
        records.append({key: value for key, value in record.items() if value is not None})
    caller = copy.deepcopy(scenario.caller)
    caller["MANIFEST.agent"]["dependencies"] = records + copy.deepcopy(scenario.extra_records)
    caller["fixtures/workflow.json"] = fixtures["caller"]
    return Built(
        caller=base.write(directory / "caller", caller),
        archives=archives,
        decisions=copy.deepcopy(scenario.decisions),
        grants=dict(scenario.grants),
        limits=scenario.limits,
        public_keys=sorted({public for _, public in keys.values()}),
    )


def scenario(variant: str | None = None) -> Scenario:
    built = Scenario()
    if variant is not None:
        replaced = VARIANTS[variant](built)
        if replaced is not None:
            built = replaced
    return built


# -- helpers of the variants -------------------------------------------------------------------


def slot_step(**overrides) -> dict:
    """A valid slot step for a role of the caller: it looks at the address the person put in the
    request and may send the query."""
    step = {
        "id": "ask",
        "type": "link",
        "slot": "helper",
        "locate": {"from": "input", "path": "/url"},
        "input": {"object": {"query": message("/text")}},
        "request": {"task": "read", "max_output_tokens": 200},
        "max_joins": 1,
        "budget": {"model_calls": 1, "tool_calls": 1, "remote_calls": 0, "tokens": 400},
        "output_schema": "schemas/outcome.schema.json",
        "timeout_seconds": 20,
    }
    step.update(overrides)
    return step


def add_slot(scenario: Scenario, role_id="Lookup", **overrides) -> dict:
    step = slot_step(**overrides)
    base.role(scenario.caller, role_id)["steps"].append(step)
    return step


def add_worker(members, worker_id, **fields) -> dict:
    worker = {
        "id": worker_id,
        "kind": "packaged",
        "skills": [],
        "tools": [],
        "max_instances": 1,
        "budget": {"tokens": 0, "remote_calls": 0},
        "state_read": ["request"],
        "state_write": [],
    }
    worker.update(fields)
    members["graph.json"]["workers"].append(worker)
    members["policy/policy.json"]["delegation"]["approved_roles"].append(worker_id)
    return worker


def add_node(members, node) -> None:
    graph = members["graph.json"]
    graph["nodes"].insert(0, node)
    base.node(members, "output")["depends_on"].append(node["id"])


# -- the named mutations of the enforcement cases ----------------------------------------------


def _minimum_version(s):
    s.caller["MANIFEST.agent"]["runtime"]["minimum_version"] = "0.7.0"


def _dependency_unknown(s):
    base.role(s.caller, "Lookup")["steps"][0]["dependency"] = "catalog"


def _dependency_duplicate(s):
    s.extra_records.append(
        {
            "id": "index",
            "package_id": "org.example.other",
            "version": "0.1.0",
            "digest": "1" * 64,
            "locator": "https://packages.example/other.agent.pkg",
        }
    )


def _dependency_unused(s):
    s.extra_records.append(
        {
            "id": "spare",
            "package_id": "org.example.spare",
            "version": "0.1.0",
            "digest": "1" * 64,
            "locator": "https://packages.example/spare.agent.pkg",
        }
    )


def _locator_scheme(s):
    s.record_overrides["index"] = {"locator": "nanda:org.example.index"}


def _cycle(s):
    s.record_overrides["index"] = {"package_id": CALLER_ID}


def _input_outside_view(s):
    base.role(s.caller, "Lookup")["steps"][0]["input"] = {"object": {"query": state("/notes/0")}}


def _slot_in_map(s):
    add_worker(s.caller, "Fan", max_instances=1)
    add_node(
        s.caller,
        {
            "id": "fan",
            "type": "map",
            "worker": "Fan",
            "depends_on": [],
            "input": {"array": [state("/request/text")]},
            "item_schema": "schemas/any.schema.json",
            "max_items": 1,
            "max_parallel": 1,
            "steps": [slot_step(input={"object": {"query": {"from": "item", "path": ""}}})],
            "yield": steps("/ask"),
            "output_schema": "schemas/any.schema.json",
            "timeout_seconds": 30,
            "writes": {},
        },
    )


def _slot_at_top_level(s):
    add_worker(s.caller, "Fan")
    add_node(
        s.caller,
        {
            **slot_step(input={"object": {"query": state("/request/text")}}),
            "worker": "Fan",
            "depends_on": [],
            "writes": {},
        },
    )


def _locate_source(s):
    step = slot_step(locate=steps("/read/note"))
    base.role(s.caller, "Desk")["steps"].append(step)


def _locate_message(s):
    add_slot(s, locate=message("/url"))


def _slot_caps(s):
    add_slot(s, locate={"array": [{"from": "input", "path": "/url"}] * 4})


def _slot_bound(s):
    add_slot(s, budget={"model_calls": 1, "tokens": 100000})


def _digest_mismatch(s):
    s.record_overrides["index"] = {"digest": "0" * 64}


def _signer_mismatch(s):
    s.record_overrides["index"] = {"signer": "sha256:" + "0" * 64}


def _identity_mismatch(s):
    s.record_overrides["index"] = {"version": "0.2.0"}


def _signature_absent(s):
    s.unsigned.add("index")
    s.record_overrides["index"] = {"signer": None}


def _target_conversational(s):
    s.archives["scribe"] = CONVERSATIONAL
    s.record_overrides["scribe"] = {"signer": None}


def _nested(s):
    scribe = s.linked["scribe"]
    scribe["MANIFEST.agent"]["dependencies"] = [
        {
            "id": "deep",
            "package_id": "org.example.deep",
            "version": "0.1.0",
            "digest": "1" * 64,
            "locator": "https://packages.example/deep.agent.pkg",
        }
    ]
    scribe["MANIFEST.agent"]["model_requirements"]["tasks"] = []
    node = scribe["graph.json"]["nodes"][0]
    for key in ("task", "max_output_tokens"):
        node.pop(key)
    node.update(type="link", dependency="deep")
    scribe["fixtures/workflow.json"] = {
        "profile": "workflow.fixture.v0",
        "input": {"answers": [], "text": "none"},
        "models": {},
        "tools": {},
    }


def _nested_slot(s):
    # A linked package that is itself a network holding a slot: it declares no dependency, and
    # its run could still join a further package.
    members = base.files(minimum_version="0.8.0")
    members["MANIFEST.agent"]["package_id"] = "org.example.link-probe.joiner"
    members["MANIFEST.agent"]["schemas"].append(
        {"id": "outcome", "path": "schemas/outcome.schema.json"}
    )
    members["schemas/outcome.schema.json"] = caller_files()["schemas/outcome.schema.json"]
    members["schemas/message.schema.json"]["properties"]["url"] = {
        "type": ["string", "null"],
        "format": "uri",
    }
    base.role(members, "Lookup")["steps"].append(slot_step())
    members["policy/policy.json"]["budget"]["hard_tokens"] = 12000
    members["fixtures/workflow.json"] = base.build_fixture(members, base.DEFAULT_WALK)
    s.linked["scribe"] = members


def _bound_exceeds_budget(s):
    s.caller["policy/policy.json"]["budget"]["hard_tokens"] = 9000


def _model_incompatible(s):
    s.linked["scribe"]["MANIFEST.agent"]["model_requirements"]["tasks"][0]["context_window"] = (
        2_000_000
    )


def _undecided(s):
    del s.decisions["scribe"]


def _once_across_link(s):
    s.decisions["index"]["grants"]["desk.read"] = "once"


def _input_schema(s):
    base.role(s.caller, "Lookup")["steps"][0]["input"] = {
        "object": {"query": message("/text"), "extra": {"literal": 1}}
    }


def _result_schema(s):
    lookup = base.role(s.caller, "Lookup")
    lookup["steps"][0]["output_schema"] = "schemas/draft.schema.json"
    lookup["steps"][1]["input"] = {"array": [state("/answers")]}
    lookup["route"]["message"] = {"object": {"text": steps("/lookup/draft")}}


def _grant_not_inherited(s):
    s.decisions["scribe"]["grants"]["model.reasoning"] = "deny"


def _reservation_refused(s):
    s.limits = {"hard_tokens": 1400}


def _inner_over_budget(s):
    scribe = s.linked["scribe"]
    scribe["policy/policy.json"]["budget"].update(estimated_tokens=250, hard_tokens=250)
    scribe["graph.json"]["workers"][1]["budget"]["tokens"] = 250


def _denied_link_node(s):
    add_worker(s.caller, "Aside")
    add_node(
        s.caller,
        {
            "id": "aside",
            "type": "link",
            "dependency": "index",
            "worker": "Aside",
            "depends_on": [],
            "input": {"object": {"query": state("/request/text")}},
            "output_schema": "schemas/answer.schema.json",
            "timeout_seconds": 20,
            "writes": {},
        },
    )
    s.decisions["index"] = {"decision": "denied"}
    s.walk = [("Writer", "write it up"), ("done", "all done")]


def _denied_link_excluded(s):
    s.decisions["index"] = {"decision": "denied"}
    s.walk = [("Writer", "write it up"), ("done", "all done")]


def _planned_walk(s):
    s.walk = list(FULL_TOUR)


def _link_in_map(s):
    return Scenario(
        caller=map_caller_files(),
        linked={"index": index_files()},
        decisions={"index": copy.deepcopy(s.decisions["index"])},
        grants={"memory.session": "session"},
        queries=["alpha", "beta", "gamma"],
    )


VARIANTS = {
    "minimum-version": _minimum_version,
    "dependency-unknown": _dependency_unknown,
    "dependency-duplicate": _dependency_duplicate,
    "dependency-unused": _dependency_unused,
    "locator-scheme": _locator_scheme,
    "cycle": _cycle,
    "input-outside-view": _input_outside_view,
    "slot-in-map": _slot_in_map,
    "slot-at-top-level": _slot_at_top_level,
    "locate-source": _locate_source,
    "locate-message": _locate_message,
    "slot-caps": _slot_caps,
    "slot-bound-exceeds-budget": _slot_bound,
    "digest-mismatch": _digest_mismatch,
    "signer-mismatch": _signer_mismatch,
    "identity-mismatch": _identity_mismatch,
    "signature-absent": _signature_absent,
    "target-conversational": _target_conversational,
    "nested": _nested,
    "nested-slot": _nested_slot,
    "bound-exceeds-budget": _bound_exceeds_budget,
    "model-incompatible": _model_incompatible,
    "undecided": _undecided,
    "once-across-link": _once_across_link,
    "input-schema": _input_schema,
    "result-schema": _result_schema,
    "grant-not-inherited": _grant_not_inherited,
    "reservation-refused": _reservation_refused,
    "inner-over-budget": _inner_over_budget,
    "denied-link-node": _denied_link_node,
    "denied-link-excluded": _denied_link_excluded,
    "planned-walk": _planned_walk,
    "link-in-map": _link_in_map,
}
