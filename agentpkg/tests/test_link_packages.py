"""The Agent Links example packages (T65, D-683, D-695): the planner Tripwright and the three
packages it can ask, as sources. The committed trees are the generator's output; the planner's
fixture walk runs through both links and attains the composed envelope; every link's input is
built from closed fields; each linked package also runs alone."""

import asyncio
import importlib.util
import json
from pathlib import Path

import pytest

from agentpkg.delegation.analysis import worst_case
from agentpkg.fixtures import fixture_adapters
from agentpkg.links.analysis import link_operations, package_worst_case
from agentpkg.links.operator import operator_links
from agentpkg.package import build_package, load_package
from agentpkg.signing import _read_key, fingerprint, sign_package
from agentpkg.workflow import run_workflow
from agentpkg.workflow_validation import _at_schema
from agentpkg.workflow_values import references, tokens

ROOT = Path(__file__).resolve().parents[2]
AGENTS = ROOT / "agents"
LINKED = {"webair-flights": "webair-flights", "hotel-aggregator": "staymere-hotels"}
GRANTS = {"model.reasoning": "session", "memory.session": "session"}


@pytest.fixture(scope="module")
def generator():
    spec = importlib.util.spec_from_file_location(
        "make_link_examples", ROOT / "examples" / "link" / "make_link_examples.py"
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.fixture(scope="module")
def sources(generator):
    return generator.sources()


@pytest.mark.parametrize(
    "name", ["webair-flights", "staymere-hotels", "hotel-salitubam", "travel-planner"]
)
def test_the_committed_sources_are_the_generator_output(name, sources):
    members = sources[name]
    committed = {
        path.relative_to(AGENTS / name).as_posix()
        for path in (AGENTS / name).rglob("*")
        if path.is_file() and path.name != ".DS_Store"
    }
    assert committed == set(members)
    for member, value in members.items():
        text = (AGENTS / name / member).read_text(encoding="utf-8")
        if isinstance(value, str):
            assert text == value, member
        else:
            assert json.loads(text) == value, member


def test_the_planner_pins_the_linked_sources_by_digest_and_key(tmp_path):
    planner = load_package(AGENTS / "travel-planner")
    records = {r["id"]: r for r in planner.manifest["dependencies"]}
    assert set(records) == set(LINKED)
    keys = {"webair-flights": "webair", "hotel-aggregator": "staymere"}
    for dependency, name in LINKED.items():
        built = load_package(build_package(AGENTS / name, tmp_path / f"{name}.agent.pkg"))
        record = records[dependency]
        assert record["digest"] == built.digest
        assert (record["package_id"], record["version"]) == (
            built.manifest["package_id"],
            built.manifest["version"],
        )
        public = ROOT / "examples" / "keys" / f"{keys[dependency]}-publisher.pub.pem"
        assert record["signer"] == fingerprint(_read_key(public))
        assert record["locator"].startswith("https://")


def composition(tmp_path, keys, sources, generator, denied=()):
    """The planner and its two linked packages from the generator's members, the linked ones
    signed with test keys (the records' `signer` dropped: the real keys sign the shipped
    archives, which `test_link_shipped.py` checks)."""
    planner = json.loads(json.dumps(sources["travel-planner"]))
    for record in planner["MANIFEST.agent"]["dependencies"]:
        record.pop("signer")
    generator.base.write_tree(tmp_path / "planner", planner)
    archives, decisions = {}, {}
    for dependency, name in LINKED.items():
        generator.base.write_tree(tmp_path / name, sources[name])
        unsigned = build_package(tmp_path / name, tmp_path / f"{name}.unsigned.agent.pkg")
        key = keys["index" if dependency == "webair-flights" else "scribe"]
        archives[dependency] = sign_package(unsigned, key[0], tmp_path / f"{name}.agent.pkg")
        linked = load_package(archives[dependency])
        network = [p["id"] for p in linked.policy["permissions"] if p["kind"] == "network"]
        decisions[dependency] = (
            {"decision": "denied"}
            if dependency in denied
            else {
                "decision": "accepted",
                "grants": {**GRANTS, **{pid: "session" for pid in network}},
                "approved_tools": sorted(linked.tools),
            }
        )
    package = load_package(tmp_path / "planner")
    router, handlers, input_value = fixture_adapters(package)
    links = operator_links(
        package,
        archives=archives,
        decisions=decisions,
        router=router,
        adapters=lambda linked: fixture_adapters(linked)[:2],
    )
    return package, links, router, handlers, input_value


def events(report, action):
    return [event for event in report["audit"] if event["action"] == action]


def test_the_fixture_walk_is_the_full_tour_and_attains_the_envelope(
    tmp_path, keys, sources, generator
):
    package, links, router, handlers, input_value = composition(tmp_path, keys, sources, generator)
    report = asyncio.run(
        run_workflow(
            package,
            input_value,
            grants={**GRANTS, "network.webair": "session"},
            handlers=handlers,
            router=router,
            approved_tools=["check-calendar"],
            links=links,
        )
    )
    assert report["status"] == "completed"
    walk = [event["role"] for event in events(report, "network.activated")]
    assert walk == ["FrontMan", "Flights", "FrontMan", "Hotels", "FrontMan", "Calendar", "FrontMan"]
    started = events(report, "link.started")
    assert [e["dependency"] for e in started] == ["webair-flights", "hotel-aggregator"]
    assert len(events(report, "link.completed")) == 2 and not events(report, "link.failed")
    bound = worst_case(package.graph, package.policy, links=links.worst_cases)
    usage = report["usage"]
    models = len(events(report, "model.called")) + sum(
        link["model_calls"] for link in usage["links"].values()
    )
    # A star: the bound is exact in model and tool calls, and the full tour attains it.
    assert models == bound["model_calls"] == 10
    assert usage["tool_calls"] == bound["tool_calls"]
    assert usage["tokens"] <= bound["tokens"] and usage["remote_calls"] <= bound["remote_calls"]
    assert report["output"]["flight_pick"]["id"] == "WA205-20270309"
    assert report["output"]["hotel_pick"]["id"] == "H-HAF"
    # What the README tells a person is the computed envelope.
    readme = (AGENTS / "travel-planner" / "README.md").read_text(encoding="utf-8")
    assert f"at most {bound['model_calls']} model calls" in readme
    assert f"{bound['remote_calls']} remote calls and {bound['tokens']:,} tokens" in readme
    assert f"at most {bound['max_hops']} handoffs" in readme


def test_a_denied_publisher_leaves_the_plan_without_its_role(tmp_path, keys, sources, generator):
    """DENY-ONE: Staymere denied; the fixture's route cases name three targets, so the fixture
    walk cannot replay, and the bound and the targets are checked from the declaration."""
    package, links, *_ = composition(
        tmp_path, keys, sources, generator, denied=("hotel-aggregator",)
    )
    bound = worst_case(package.graph, package.policy, links=links.worst_cases)
    assert bound["activations"] == {"FrontMan": 3, "Flights": 1, "Hotels": 0, "Calendar": 1}
    assert bound["model_calls"] == 3 * 2 + 1
    assert "hotel-aggregator:search-hotels" not in bound["tool_calls"]


def closed(schema) -> bool:
    """A schema no free text fits: integers, numbers, booleans, null, strings bound by a
    pattern, an enum, a const or a date format; objects and arrays of those."""
    if not isinstance(schema, dict):
        return False
    for union in ("anyOf", "oneOf"):
        if union in schema:
            return all(closed(choice) for choice in schema[union])
    if "enum" in schema or "const" in schema:
        return True
    kinds = schema.get("type")
    kinds = [kinds] if isinstance(kinds, str) else list(kinds or [])
    if not kinds:
        return False
    for kind in kinds:
        if kind in ("integer", "number", "boolean", "null"):
            continue
        if kind == "string":
            if "pattern" not in schema and schema.get("format") not in ("date", "date-time"):
                return False
        elif kind == "object":
            if schema.get("additionalProperties") is not False:
                return False
            if not all(closed(child) for child in schema.get("properties", {}).values()):
                return False
        elif kind == "array":
            if not closed(schema.get("items")):
                return False
        else:
            return False
    return True


def open_sources(package) -> list[str]:
    """Every source of a link's input whose schema admits free text (D-683's condition)."""
    graph = package.graph
    documents = {s["path"]: package.json(s["path"]) for s in package.manifest["schemas"]}
    network = graph["network"]
    found = []
    for label, step, where, role_id in link_operations(graph):
        assert where == "role"
        role = network["roles"][role_id]
        roots = {
            "state": network["state_schema"],
            "message": network["message_schema"],
        }
        earlier = {}
        for other in role["steps"]:
            if other is step:
                break
            earlier[other["id"]] = other["output_schema"]
        for source, pointer in references(step["input"]):
            parts = tokens(pointer)
            if source == "steps":
                path, parts = earlier[parts[0]], parts[1:]
            else:
                path = roots[source]
            target = _at_schema(documents[path], parts, path, documents, label)
            if not closed(target):
                found.append(f"{label}: {source}{pointer}")
    return found


def test_every_link_input_of_the_planner_reads_closed_fields_only():
    planner = load_package(AGENTS / "travel-planner")
    assert len(list(link_operations(planner.graph))) == 2
    assert open_sources(planner) == []


@pytest.mark.parametrize(
    "source, pointer",
    [("message", "/text"), ("message", "/notes"), ("state", "/flight_pick/reason")],
)
def test_the_closed_field_walk_fails_on_free_text(tmp_path, sources, generator, source, pointer):
    planner = json.loads(json.dumps(sources["travel-planner"]))
    graph = planner["graph.json"]
    step = graph["network"]["roles"]["Hotels"]["steps"][0]
    step["input"]["object"]["city"] = {"from": source, "path": pointer}
    if source == "state":
        hotels = next(w for w in graph["workers"] if w["id"] == "Hotels")
        hotels["state_read"].append("flight_pick")
    generator.base.write_tree(tmp_path / "planner", planner)
    assert open_sources(load_package(tmp_path / "planner")) == [
        f"plan-trip/Hotels/search: {source}{pointer}"
    ]


@pytest.mark.parametrize("name", ["webair-flights", "staymere-hotels", "hotel-salitubam"])
def test_a_linked_package_runs_alone_and_states_its_worst_case(name):
    package = load_package(AGENTS / name)
    assert not package.manifest["dependencies"]
    router, handlers, input_value = fixture_adapters(package)
    network = [p["id"] for p in package.policy["permissions"] if p["kind"] == "network"]
    report = asyncio.run(
        run_workflow(
            package,
            input_value,
            grants={**GRANTS, **{pid: "session" for pid in network}},
            handlers=handlers,
            router=router,
            approved_tools=sorted(package.tools),
        )
    )
    assert report["status"] == "completed"
    assert report["output"]["recommended"] in {o["id"] for o in report["output"]["options"]}
    worst = package_worst_case(package.graph, package.policy)
    assert (worst["model_calls"], worst["remote_calls"], worst["tokens"]) == (1, 3, 6000)
    assert worst["tool_calls"] == {tool: 1 for tool in package.tools}
    readme = (AGENTS / name / "README.md").read_text(encoding="utf-8")
    assert "1 model call, 1 call of its tool, 3 remote calls, 6,000 tokens" in readme.replace(
        "\n", " "
    ).replace("  ", " ")
