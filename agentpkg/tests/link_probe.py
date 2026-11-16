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


#: Where the package a slot can join is published, in the recorded web of a join scenario.
HELPER_PAGE = "https://helper.example/"
HELPER_ARCHIVE = "https://helper.example/agent.pkg"
PAGE_WITH_PACKAGE = (
    '<!doctype html><html><head><title>Helper</title><link rel="agent-package" '
    'type="application/vnd.webagents.agent-package" href="/agent.pkg"></head>'
    "<body>A fictional helper.</body></html>"
)
PAGE_WITHOUT_PACKAGE = (
    "<!doctype html><html><head><title>Helper</title></head><body>Nothing here.</body></html>"
)


def helper_files() -> dict:
    """The package a slot can join: `index` under another publisher's identity, its whole run
    inside fifteen seconds, so that its worst case fits the probe's slot (0 model calls, 1 tool
    call, 0 remote calls, 1 token, 15 seconds)."""
    members = index_files()
    manifest = members["MANIFEST.agent"]
    manifest["package_id"] = "org.example.link-probe.helper"
    manifest["name"] = "Helper"
    manifest["description"] = "A test package for link.v0: a helper a slot can join."
    graph = members["graph.json"]
    graph["deadline_seconds"] = 15
    graph["nodes"][0]["timeout_seconds"] = 10
    graph["nodes"][1]["timeout_seconds"] = 5
    return members


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
    #: The run-time half (spec sections 6 and 7), None for a scenario without it: what the
    #: person put in the request (`url`), the recorded web (`page`, the `candidate`'s members,
    #: `unsigned`, the key that signs it), and the person's recorded decisions (`decisions`:
    #: the slot's join cards in order; `raise`: the budget-raise card; a missing key means
    #: nobody is there to ask). `answer` replaces the request-building call's fixture answer.
    join: dict | None = None


@dataclass
class Built:
    caller: Path
    archives: dict
    decisions: dict
    grants: dict
    limits: dict | None
    public_keys: list
    join_fixture: Path | None = None
    #: The archive a slot can join, by slot id: what a verifier is handed beside the links'.
    joinable: dict = field(default_factory=dict)

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
        if self.join_fixture is not None:
            argv += ["--join-fixture", str(self.join_fixture)]
        return argv


def slot_of(members) -> tuple[str, dict] | None:
    """The role that holds the caller's slot step, and the step."""
    network = members["graph.json"].get("network") or {"roles": {}}
    for role_id, role in network["roles"].items():
        for step in role["steps"]:
            if step.get("type") == "link" and "slot" in step:
                return role_id, step
    return None


def _fixtures(scenario: Scenario, candidate=None) -> dict:
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
    # Which of the slot's cards the person accepts, in order (the slot is in `Lookup`).
    joined = [bool(d.get("accepted")) for d in (scenario.join or {}).get("decisions") or []]
    if (scenario.join or {}).get("url") is not None:
        caller["input"]["url"] = scenario.join["url"]
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
            if candidate is not None and joined and joined.pop(0):
                # The request-building call (L-37): its data is the slot's view and the joined
                # package's name, description and input schema, exactly; its answer is the
                # joined package's input.
                from agentpkg.workflow import bundle_schema

                manifest = candidate.manifest
                data = {
                    "view": {"query": text},
                    "package": {
                        "name": manifest["name"],
                        "description": manifest["description"],
                        "input_schema": bundle_schema(candidate, candidate.graph["input_schema"]),
                    },
                }
                answer = (scenario.join or {}).get("answer", {"query": text})
                base._append(caller["models"]["read"], {"input": data, "output": answer})
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
    join_fixture, candidate, joinable = _write_join(directory, scenario, keys)
    fixtures = _fixtures(scenario, candidate)
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
        join_fixture=join_fixture,
        joinable=joinable,
    )


def _write_join(directory: Path, scenario: Scenario, keys: dict):
    """The join fixture of a scenario (`agentpkg run --join-fixture`): the recorded web (the
    page the person named and the candidate's archive, built and signed here with its own
    publisher's key) and the person's recorded decisions. Returns the fixture's path and the
    candidate's package, or `(None, None)` for a scenario without the run-time half."""
    import json

    from agentpkg.package import build_package, load_package
    from agentpkg.signing import sign_package

    join = scenario.join
    if join is None:
        return None, None, {}
    document = {"schema": "agentpkg-join-fixture-v0"}
    candidate, joinable = None, {}
    if "archive" in join:
        # A candidate taken as it is: some signed archive the page advertises.
        import shutil

        archive = directory / "helper.agent.pkg"
        shutil.copyfile(join["archive"], archive)
        candidate = load_package(archive)
        slot = slot_of(scenario.caller)
        joinable = {slot[1]["slot"] if slot else "helper": archive}
        document["pages"] = {HELPER_PAGE: {"body": join.get("page", PAGE_WITH_PACKAGE)}}
        document["packages"] = {HELPER_ARCHIVE: archive.name}
    elif "candidate" in join:
        members = copy.deepcopy(join["candidate"])
        # The joined package replays its own fixture: one lookup per query a walk can send it.
        queries = [reply for target, reply in scenario.walk if target == "Lookup"] or ["none"]
        members.setdefault(
            "fixtures/workflow.json",
            {
                "profile": "workflow.fixture.v0",
                "input": {"query": queries[0]},
                "models": {},
                "tools": {
                    "lookup": [
                        {"input": {"query": q}, "output": {"query": q, "answer": f"helped:{q}"}}
                        for q in dict.fromkeys(queries)
                    ]
                },
            },
        )
        source = base.write(directory / "candidate", members)
        archive = build_package(source, directory / "helper.unsigned.agent.pkg")
        if not join.get("unsigned"):
            private_key, _ = keys.get(join.get("key", "helper"), keys["default"])
            archive = sign_package(archive, private_key, directory / "helper.agent.pkg")
        candidate = load_package(archive)
        slot = slot_of(scenario.caller)
        joinable = {slot[1]["slot"] if slot else "helper": Path(archive)}
        document["pages"] = {HELPER_PAGE: {"body": join.get("page", PAGE_WITH_PACKAGE)}}
        document["packages"] = {HELPER_ARCHIVE: Path(archive).name}
    decisions = {}
    if "decisions" in join:
        slot = slot_of(scenario.caller)
        decisions["joins"] = {slot[1]["slot"] if slot else "helper": list(join["decisions"])}
    if "raise" in join:
        decisions["raise"] = dict(join["raise"])
    if decisions:
        document["decisions"] = decisions
    path = directory / "join-fixture.json"
    path.write_text(json.dumps(document, indent=2) + "\n", encoding="utf-8")
    return path, candidate, joinable


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


def _slot_input(s):
    # The whole message by reference: the card could name none of the fields that would go to
    # the request-building call.
    add_slot(s, input=message())


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


def add_echo(index) -> None:
    """One WebAssembly step (compute.v0's `echo` case module) after an index-like package's
    lookup, so that each of its runs makes one compute call."""
    import hashlib

    module = (ROOT / "examples" / "compute" / "cases" / "modules" / "echo.wasm").read_bytes()
    index["modules/echo.wasm"] = module
    graph = index["graph.json"]
    graph["modules"] = [
        {"id": "echo", "path": "modules/echo.wasm", "sha256": hashlib.sha256(module).hexdigest()}
    ]
    lookup, output = graph["nodes"]
    echo = {
        "id": "echo",
        "type": "compute",
        "worker": "Coordinator",  # it reads `result`, which Finder's view does not hold
        "depends_on": ["lookup"],
        "input": state("/result"),
        "input_schema": "schemas/answer.schema.json",
        "output_schema": "schemas/answer.schema.json",
        "timeout_seconds": 20,
        "writes": {"/result": {"from": "result", "path": ""}},
        "module": "echo",
        "function": "run",
    }
    graph["nodes"] = [lookup, echo, {**output, "depends_on": ["echo"]}]
    index["policy/policy.json"]["permissions"].append(
        {
            "id": "compute.modules",
            "kind": "compute",
            "description": "Run the package's own WebAssembly module, which can only compute.",
            "required": True,
            "resources": ["echo"],
        }
    )


def _linked_compute(s):
    """`index` passes its answer through one WebAssembly module, so each of its inner runs
    makes one compute call; the caller declares no module. The caller's usage holds those calls
    (L-26)."""
    s.walk = list(FULL_TOUR)
    add_echo(s.linked["index"])
    s.decisions["index"]["grants"]["compute.modules"] = "session"


def _approval_threshold(s):
    """The caller declares an approval threshold its own calls stay under and `scribe`'s worst
    case (1,500 tokens) crosses: the link's reservation meets it as a model call's does."""
    s.walk = list(FULL_TOUR)
    s.caller["policy/policy.json"]["budget"]["approval_threshold_tokens"] = 2000


# -- the run-time half: the join (section 6) and the raise (section 7) ---------------------------

HELPER_GRANTS = {"model.reasoning": "session", "memory.session": "session", "desk.read": "session"}
#: The person accepts the helper's card, with that package's own grants and tool approval.
ACCEPT = {"accepted": True, "grants": HELPER_GRANTS, "approved_tools": ["lookup"]}


def with_join(s, *, role_id="Lookup", slot=None, **join) -> dict:
    """A slot in one of the caller's roles, the address of the helper's page in the request,
    and the recorded web that serves the helper. The role's worker gets a token budget: the
    request-building call is its own."""
    step = add_slot(s, role_id, **(slot or {}))
    base.worker(s.caller, role_id)["budget"]["tokens"] = 800
    # The slot at its ceiling and the worker's budget are inside the caller's own budget (L-21).
    s.caller["policy/policy.json"]["budget"].update(estimated_tokens=14000, hard_tokens=14000)
    s.join = {"url": HELPER_PAGE, "candidate": helper_files(), **join}
    return step


def _ceiling(**figures) -> dict:
    return {"model_calls": 1, "tool_calls": 1, "remote_calls": 0, "tokens": 400} | figures


def _unattended_join(s):
    with_join(s)


def _join_declined(s):
    with_join(s, decisions=[{"accepted": False}])


def _join_cap(s):
    with_join(s, decisions=[ACCEPT])
    s.walk = list(FULL_TOUR)


def _join_not_found(s):
    with_join(s, decisions=[ACCEPT], page=PAGE_WITHOUT_PACKAGE)


def _join_verification(s):
    with_join(s, decisions=[ACCEPT], unsigned=True)


def _join_nested(s):
    # A candidate that declares a dependency and holds a link step: its run could start a
    # further run.
    with_join(s, decisions=[ACCEPT])
    helper = s.join["candidate"]
    helper["MANIFEST.agent"]["dependencies"] = [
        {
            "id": "deep",
            "package_id": "org.example.deep",
            "version": "0.1.0",
            "digest": "1" * 64,
            "locator": "https://packages.example/deep.agent.pkg",
        }
    ]
    node = helper["graph.json"]["nodes"][0]
    node.pop("tool")
    node.update(type="link", dependency="deep")
    helper["fixtures/workflow.json"] = {
        "profile": "workflow.fixture.v0",
        "input": {"query": "none"},
        "models": {},
        "tools": {"lookup": []},
    }


def _join_conversational(s):
    # The page advertises a signed conversation package: not something a link can run, and
    # nothing a worst case is computed for.
    with_join(s, decisions=[ACCEPT])
    del s.join["candidate"]
    s.join["archive"] = CONVERSATIONAL


def _declined_key_planned_link(s):
    # `index` is accepted at the review. Writer's slot then finds a package `index`'s key
    # signed, and the person declines its card: that key is denied for the rest of the run,
    # so the planned link to `index`, reached afterwards, starts no inner run.
    with_join(s, role_id="Writer", decisions=[{"accepted": False}], key="index")
    s.walk = [("Writer", "write it up"), ("Lookup", "look up hello"), ("done", "all done")]


def _join_denied_publisher(s):
    # The person denied `index`'s publisher at the review; the page the slot looks at
    # advertises a package that key signed.
    with_join(s, role_id="Writer", decisions=[ACCEPT], key="index")
    s.decisions["index"] = {"decision": "denied"}
    s.walk = [("Writer", "write it up"), ("done", "all done")]


def _over_model_calls(s):
    # A candidate with one model step, under a ceiling of none.
    with_join(s, decisions=[ACCEPT], slot={"budget": _ceiling(model_calls=0)})
    candidate = scribe_files()
    candidate["MANIFEST.agent"]["package_id"] = "org.example.link-probe.helper"
    candidate["fixtures/workflow.json"] = {
        "profile": "workflow.fixture.v0",
        "input": {"answers": [], "text": "none"},
        "models": {"draft": []},
        "tools": {},
    }
    s.join["candidate"] = candidate


def _over_tool_calls(s):
    with_join(s, decisions=[ACCEPT], slot={"budget": _ceiling(tool_calls=0)})


def _over_compute_calls(s):
    with_join(s, decisions=[ACCEPT])
    add_echo(s.join["candidate"])


def _over_remote_calls(s):
    with_join(s, decisions=[ACCEPT])
    s.join["candidate"]["policy/policy.json"]["budget"]["max_remote_calls"] = 2


def _over_tokens(s):
    with_join(s, decisions=[ACCEPT], slot={"budget": _ceiling(tokens=0)})


def _over_seconds(s):
    with_join(s, decisions=[ACCEPT], slot={"timeout_seconds": 10})


def _join_budget(s):
    # The candidate's own cap is 900 tokens, inside the slot's ceiling; the host's limit
    # leaves the run less than that when the slot is reached, and enough for the rest.
    with_join(s, decisions=[ACCEPT], slot={"budget": _ceiling(tokens=1000)})
    s.join["candidate"]["policy/policy.json"]["budget"].update(
        estimated_tokens=900, hard_tokens=900
    )
    s.limits = {"hard_tokens": JOIN_BUDGET_LIMIT}
    s.walk = [("Lookup", "look up hello"), ("done", "all done")]


def _join_request_nonconforming(s):
    with_join(s, decisions=[ACCEPT], answer={"q": "not the joined package's input"})


def _join_inner_failed(s):
    # The person accepts the card and denies the one permission the helper's tool needs.
    with_join(s, decisions=[{**ACCEPT, "grants": {**HELPER_GRANTS, "desk.read": "deny"}}])


def _join_accepted(s):
    with_join(s, decisions=[ACCEPT])


#: The host's token limits of the raise cases: `scribe`'s reservation (1,500 tokens) does not fit
#: what the run has left under RAISE_LIMIT and fits after a raise of less than half of it;
#: under SECOND_RAISE_LIMIT Desk's own route call asks the one raise of the run first.
RAISE_LIMIT = 1700
SECOND_RAISE_LIMIT = 500
JOIN_BUDGET_LIMIT = 1200


def _raise_accepted(s):
    s.limits = {"hard_tokens": RAISE_LIMIT}
    s.join = {"raise": {"accepted": True}}


def _raise_denied(s):
    s.limits = {"hard_tokens": RAISE_LIMIT}
    s.join = {"raise": {"accepted": False}}


def _raise_unattended(s):
    s.limits = {"hard_tokens": RAISE_LIMIT}


def _package_cap_never_raised(s):
    # Desk's own budget, the package's declaration, is what refuses its route call; the person
    # is there and would say yes.
    base.worker(s.caller, "Desk")["budget"]["tokens"] = DESK_BUDGET
    s.join = {"raise": {"accepted": True}}


def _second_raise_refused(s):
    s.limits = {"hard_tokens": SECOND_RAISE_LIMIT}
    s.join = {"raise": {"accepted": True}}


DESK_BUDGET = 400

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
    "linked-compute": _linked_compute,
    "approval-threshold": _approval_threshold,
    "unattended-join": _unattended_join,
    "join-declined": _join_declined,
    "join-cap": _join_cap,
    "join-not-found": _join_not_found,
    "join-verification": _join_verification,
    "join-nested": _join_nested,
    "join-denied-publisher": _join_denied_publisher,
    "join-over-ceiling-model-calls": _over_model_calls,
    "join-over-ceiling-tool-calls": _over_tool_calls,
    "join-over-ceiling-compute-calls": _over_compute_calls,
    "join-over-ceiling-remote-calls": _over_remote_calls,
    "join-over-ceiling-tokens": _over_tokens,
    "join-over-ceiling-seconds": _over_seconds,
    "join-budget": _join_budget,
    "join-request-nonconforming": _join_request_nonconforming,
    "join-inner-failed": _join_inner_failed,
    "join-accepted": _join_accepted,
    "raise-accepted": _raise_accepted,
    "raise-denied": _raise_denied,
    "raise-unattended": _raise_unattended,
    "package-cap-never-raised": _package_cap_never_raised,
    "second-raise-refused": _second_raise_refused,
    "slot-input": _slot_input,
    "join-conversational": _join_conversational,
    "declined-key-planned-link": _declined_key_planned_link,
}
