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
#: The planner 0.2.0's source and the join fixture, beside the generator until 0.2.0 is signed.
STAGED = ROOT / "examples" / "link" / "travel-planner-0.2.0"
JOIN_FIXTURE = ROOT / "examples" / "link" / "join-fixture.json"
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
    # 0.2.0: the two planned links and the slot's view (D-683's condition, both versions).
    staged = load_package(STAGED)
    assert [step.get("slot") for _, step, _, _ in link_operations(staged.graph)] == [
        None,
        None,
        "named-hotel",
    ]
    assert open_sources(staged) == []


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


# -- the planner 0.2.0: FindHotel, the search and the slot (unsigned until the go/no-go) ----------


def test_the_staged_planner_and_the_join_fixture_are_the_generator_output(generator):
    staged = generator.staged()
    members = staged.pop(generator.STAGED)
    committed = {
        path.relative_to(STAGED).as_posix()
        for path in STAGED.rglob("*")
        if path.is_file() and path.name != ".DS_Store"
    }
    assert committed == set(members)
    for member, value in members.items():
        text = (STAGED / member).read_text(encoding="utf-8")
        assert (text == value) if isinstance(value, str) else (json.loads(text) == value), member
    for name, value in staged.items():
        assert json.loads((STAGED.parent / name).read_text(encoding="utf-8")) == value, name
    # 0.1.0 is untouched by the generator's second version: same sources, same digests pinned.
    assert (
        load_package(STAGED).manifest["dependencies"]
        == (load_package(AGENTS / "travel-planner").manifest["dependencies"])
    )
    assert load_package(STAGED).manifest["version"] == "0.2.0"


def staged_run(
    tmp_path, capsys, *, attended=True, input_value=None, fixture=JOIN_FIXTURE, completes=True
):
    """The planner 0.2.0 from its source through the CLI, with the two shipped linked archives
    and, when a person is there, the join fixture (the hotel's recorded page, its shipped
    archive, the recorded decision)."""
    from agentpkg.cli import main

    tmp_path.mkdir(parents=True, exist_ok=True)
    out = tmp_path / "out"
    link = ROOT / "examples" / "link"
    argv = ["run", str(STAGED), "--mode", "fixture"]
    argv += ["--grants", str(link / "travel-planner-0.2.0-grants.json")]
    for dependency, name in LINKED.items():
        argv += ["--link", f"{dependency}={ROOT / 'dist' / (name + '-0.1.0.agent.pkg')}"]
        argv += ["--link-grants", f"{dependency}={link / (name + '-grants.json')}"]
    for tool in (
        "check-calendar",
        "web.search",
        "webair-flights:search-flights",
        "hotel-aggregator:search-hotels",
    ):
        argv += ["--approve-tool", tool]
    if attended:
        argv += ["--join-fixture", str(fixture)]
    if input_value is not None:
        path = tmp_path / "input.json"
        path.write_text(json.dumps(input_value), encoding="utf-8")
        argv += ["--input", str(path)]
    status = main(argv + ["--out", str(out)])
    assert (status == 0) is completes, capsys.readouterr().err
    capsys.readouterr()
    return out


def read(out, name):
    return json.loads((out / name).read_text(encoding="utf-8"))


def test_the_join_fixture_walk_joins_the_named_hotel_and_attains_the_envelope(tmp_path, capsys):
    out = staged_run(tmp_path, capsys)
    audit, record = read(out, "audit.json"), read(out, "links.json")
    step = "plan-trip/FindHotel/ask"
    order = [
        e["action"]
        for e in audit
        if e["node_id"] == step
        and e["action"]
        in ("link.requested", "link.decided", "model.called", "link.started", "link.completed")
    ]
    assert order == [
        "link.requested",
        "link.decided",
        "model.called",
        "link.started",
        "link.completed",
    ]
    (requested,) = [e for e in audit if e["action"] == "link.requested"]
    (decided,) = [e for e in audit if e["action"] == "link.decided"]
    hotel = load_package(ROOT / "dist" / "hotel-salitubam-0.1.0.agent.pkg")
    assert [(f["kind"], f["status"]) for f in requested["fetches"]] == [
        ("discovery", "ok"),
        ("package", "ok"),
    ]
    assert requested["candidate"]["digest"] == hotel.digest
    assert (decided["accepted"], decided["decided_by"], decided["provenance"]) == (
        True,
        "person",
        "fixture",
    )
    # The hotel the aggregator does not list, from its own agent.
    output = read(out, "result.json")["output"]
    assert output["named_hotel"]["joined"] is True
    assert output["named_hotel"]["result"]["recommended"] == "SAL-STD-20270309-5N"
    assert "SAL-STD-20270309-5N" in output["plan"] and "$910" in output["plan"]
    assert record["joins"][0]["package"]["package_id"] == "org.webagents.hotel-salitubam"
    # The envelope stated before consent holds the join at its ceiling, and the tour attains
    # its model calls: 10 of the planner, one of each of the three other publishers' packages,
    # and the request-building call.
    planner = load_package(STAGED)
    usage = read(out, "usage.json")
    models = sum(1 for e in audit if e["action"] == "model.called") + sum(
        link["model_calls"] for link in usage["links"].values()
    )
    walk = [e["role"] for e in audit if e["action"] == "network.activated"]
    assert walk.count("FrontMan") == 5 and walk[5] == "FindHotel"
    readme = (STAGED / "README.md").read_text(encoding="utf-8").replace("\n", " ")
    assert "at most 8 handoffs; FrontMan at most 5 times" in readme
    assert "at most 1 model call, 1 tool call, 3 remote calls and 6,000 tokens" in readme
    slot = next(step for _, step, _, _ in link_operations(planner.graph) if "slot" in step)
    assert slot["budget"] == {
        "model_calls": 1,
        "tool_calls": 1,
        "compute_calls": 0,
        "remote_calls": 3,
        "tokens": 6000,
    }
    assert models == 14
    assert usage["tool_calls"]["named-hotel:check-availability"] == 1


def test_without_a_person_the_join_is_refused_and_the_plan_names_the_aggregators_hotel(
    tmp_path, capsys
):
    out = staged_run(tmp_path, capsys, attended=False)
    audit = read(out, "audit.json")
    (decided,) = [e for e in audit if e["action"] == "link.decided"]
    assert (decided["accepted"], decided["decided_by"], decided["reason"]) == (
        False,
        "runtime",
        "unattended",
    )
    # Nothing was looked at, no card, no inner run of the hotel, no request-building call.
    assert not [e for e in audit if e["action"] == "link.requested"]
    assert not [e for e in audit if e["action"] == "link.started" and "slot" in e]
    output = read(out, "result.json")["output"]
    assert output["named_hotel"] == {"joined": False, "reason": "unattended", "result": None}
    assert "Harbour Guesthouse" in output["plan"] and output["hotel_pick"]["id"] == "H-HAF"


def test_the_address_the_person_gave_is_looked_at_before_the_search_results(
    tmp_path, capsys, generator
):
    # The by-URL request: the same trip with the hotel's page in `hotel_url`. The slot looks
    # at that address; the first search result is not consulted.
    given = {**generator.NAMED_INPUT, "hotel_url": generator.HOTEL_PAGE + "#rooms"}
    out = staged_run(tmp_path / "given", capsys, input_value=given)
    (requested,) = [e for e in read(out, "audit.json") if e["action"] == "link.requested"]
    assert requested["fetches"][0]["url"] == given["hotel_url"]
    assert read(out, "result.json")["output"]["named_hotel"]["joined"] is True
    # An address of the person's that advertises no package: `not_found`, and the search
    # result's page, which does advertise one, is not looked at in its place.
    elsewhere = "https://elsewhere.example/hotel"
    fixture = json.loads(JOIN_FIXTURE.read_text())
    fixture["pages"][elsewhere] = {"body": "<html><head><title>x</title></head></html>"}
    fixture["packages"] = {
        url: str((JOIN_FIXTURE.parent / path).resolve())
        for url, path in fixture["packages"].items()
    }
    (tmp_path / "elsewhere").mkdir()
    path = tmp_path / "elsewhere" / "join-fixture.json"
    path.write_text(json.dumps(fixture), encoding="utf-8")
    # The package's fixture replays two walks (joined, unattended), so this one stops at the
    # planner's next model call; its record up to there is what is read.
    out = staged_run(
        tmp_path / "elsewhere",
        capsys,
        input_value={**given, "hotel_url": elsewhere},
        fixture=path,
        completes=False,
    )
    audit = read(out, "audit.json")
    (requested,) = [e for e in audit if e["action"] == "link.requested"]
    assert [(f["url"], f["status"]) for f in requested["fetches"]] == [(elsewhere, "no_candidate")]
    (decided,) = [e for e in audit if e["action"] == "link.decided"]
    assert decided["reason"] == "not_found"
