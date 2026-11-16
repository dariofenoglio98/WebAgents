"""link.v0 in the reference beyond the enforcement cases (spec/link-v0.md): the authority
boundary between a caller and a linked package, the reservation and the settlement, the composed
bound, a denial of a publisher's key, the record a host writes, `inspect` and the CLI."""

import asyncio
import copy
import json

import network_probe as base
import pytest
from link_probe import FULL_TOUR, Scenario, scenario, write
from test_link_cases import build, events, link_host, run_fixture

from agentpkg.cli import main
from agentpkg.delegation.analysis import activation_costs, link_cost, worst_case
from agentpkg.fixtures import fixture_adapters
from agentpkg.links.analysis import composed_requirement, link_operations, package_worst_case
from agentpkg.links.host import link_multiplicity, plan_hash
from agentpkg.links.records import link_records
from agentpkg.package import inspect_package, load_package
from agentpkg.runtime import PolicyError, Runtime, digest
from agentpkg.workflow import Workflow


def tour(tmp_path, keys):
    built = write(tmp_path / "probe", scenario("planned-walk"), keys)
    return built, run_fixture(built)


# -- the bound ---------------------------------------------------------------------------------


def test_the_worst_case_of_a_plain_package_is_its_declaration(tmp_path, keys):
    built = build(tmp_path, keys)
    index = load_package(built.archives["index"])
    scribe = load_package(built.archives["scribe"])
    assert package_worst_case(index.graph, index.policy) | {"requirement": None} == {
        "model_calls": 0,
        "tool_calls": {"lookup": 1},
        "compute_calls": 0,
        "remote_calls": 0,
        "tokens": 1,
        "seconds": 60,
        "requirement": None,
    }
    worst = package_worst_case(scribe.graph, scribe.policy)
    assert (worst["model_calls"], worst["tool_calls"], worst["tokens"]) == (1, {}, 1500)


def test_a_links_cost_stands_beside_the_role_workers_budget(tmp_path, keys):
    built = build(tmp_path, keys)
    package = load_package(built.caller)
    links = link_host(built, package, fixture_adapters(package)[0])
    own = activation_costs(package.graph, "Writer", False)
    composed = activation_costs(package.graph, "Writer", links.worst_cases)
    assert own["tokens"] == 0 and own["model_calls"] == 0
    assert composed["tokens"] == 1500 and composed["model_calls"] == 1
    assert composed["seconds"] == own["seconds"]
    assert activation_costs(package.graph, "Lookup", links.worst_cases)["tool_calls"] == {
        "index:lookup": 1
    }
    # The declaration alone cannot state a planned link's cost; the composition can.
    alone = worst_case(package.graph, package.policy)
    bound = worst_case(package.graph, package.policy, links=links.worst_cases)
    assert alone["model_calls"] == 8 and bound["model_calls"] == 9
    assert bound["tool_calls"] == {"index:lookup": 2}
    assert bound["relaxation"]["tokens"] == 4 * 2000 + 2 * 1 + 1500
    assert composed_requirement(package.graph, package.policy, links.worst_cases) is None
    assert link_multiplicity(package.graph, "index") == 2
    assert link_multiplicity(package.graph, "scribe") == 1


def test_a_denied_links_role_is_never_activated_in_the_bound(tmp_path, keys):
    built = build(tmp_path, keys, "denied-link-excluded")
    package = load_package(built.caller)
    links = link_host(built, package, fixture_adapters(package)[0])
    bound = worst_case(package.graph, package.policy, links=links.worst_cases)
    assert bound["activations"]["Lookup"] == 0
    assert bound["tool_calls"] == {}
    assert (
        bound["model_calls"] == 2 * 2 + 1
    )  # Desk twice (the entry, and after Writer), scribe once


def test_a_slot_costs_its_ceiling_and_one_model_call():
    step = {
        "type": "link",
        "slot": "helper",
        "budget": {"model_calls": 2, "tool_calls": 3, "tokens": 900},
    }
    assert link_cost(step) == {
        "model_calls": 3,
        "tool_calls": {"helper:*": 3},
        "compute_calls": 0,
        "remote_calls": 0,
        "tokens": 900,
    }


def test_the_tour_attains_the_composed_calls_and_stays_inside_the_tokens(tmp_path, keys):
    built, (package, links, report, error) = tour(tmp_path, keys)
    assert error is None
    bound = worst_case(package.graph, package.policy, links=links.worst_cases)
    usage = report["usage"]
    assert usage["tool_calls"] == {"index:lookup": 2} == bound["tool_calls"]
    assert usage["links"]["index"]["runs"] == 2 and usage["links"]["scribe"]["runs"] == 1
    own = sum(e["tokens"] for e in events(report, "model.completed"))
    inner = sum(link["tokens"] for link in usage["links"].values())
    # One usage record holds every call (L-26): the caller's own and each inner run's.
    assert usage["tokens"] == own + inner and inner > 0
    assert usage["tokens"] <= bound["tokens"]
    assert usage["reserved_tokens"] == 0


# -- the authority boundary ---------------------------------------------------------------------


def test_an_inner_run_is_built_from_its_binding_alone(tmp_path, keys):
    built, (package, links, report, _) = tour(tmp_path, keys)
    started = events(report, "link.started")
    for event in started:
        binding = links.binding(event["dependency"])
        inner = report["inner_runs"][event["inner_run_id"]]
        opened = [e for e in inner["audit"] if e["action"] == "runtime.started"][0]
        # Its own package, its own grants, its own run id and chain.
        assert opened["package_digest"] == binding.link.package.digest
        assert opened["grant_scopes"] == binding.grants
        assert opened["run_id"] == event["inner_run_id"] != report["audit"][0]["run_id"]
        assert inner["audit"][0]["previous_hash"] is None
        # Of the caller it holds the link's input instance, nothing else.
        assert set(inner["state"]) == {"request", "result"}
        assert event["input_hash"] == digest(inner["state"]["request"])
    # The caller sees results, never an inner run's events.
    assert not [e for e in report["audit"] if e["run_id"] != report["audit"][0]["run_id"]]


def test_a_callers_grant_and_approval_do_not_reach_a_linked_package(tmp_path, keys):
    """The caller declares, is granted and approves the very tool and permission the linked
    package declares; the linked package's card grants nothing: its inner run is refused."""
    made = scenario()
    donor = base.files()
    made.caller["MANIFEST.agent"]["tools"] = [{"id": "lookup", "path": "tools/lookup.tool.json"}]
    made.caller["tools/lookup.tool.json"] = donor["tools/lookup.tool.json"]
    made.caller["policy/policy.json"]["permissions"].append(
        next(p for p in donor["policy/policy.json"]["permissions"] if p["id"] == "desk.read")
    )
    made.caller["policy/policy.json"]["budget"]["max_calls_per_tool"] = {"lookup": 1}
    made.grants["desk.read"] = "session"
    made.decisions["index"] = {
        "decision": "accepted",
        "grants": {"memory.session": "session", "desk.read": "deny"},
        "approved_tools": ["lookup"],
    }
    built = write(tmp_path / "probe", made, keys)
    package = load_package(built.caller)
    router, _, input_value = fixture_adapters(package)
    calls = []

    async def callers_handler(ctx, payload):
        calls.append(payload)
        return {"query": payload["query"], "answer": "from the caller"}

    links = link_host(built, package, router)
    workflow = Workflow(
        package,
        grants=built.grants,
        handlers={"desk.lookup": callers_handler},
        router=router,
        approved_tools=["lookup"],
        links=links,
    )
    with pytest.raises(Exception) as failure:
        asyncio.run(workflow.run(input_value))
    report = failure.value.execution_report
    assert report["error_code"] == "link_error"
    assert events(report, "link.failed")[0]["error_code"] == "permission_denied"
    inner = next(iter(report["inner_runs"].values()))
    refused = [
        e for e in inner["audit"] if e["action"] == "permission.checked" and not e["allowed"]
    ]
    assert refused and refused[0]["permission"] == "desk.read"
    assert calls == []  # the caller's handler for the same binding was never the inner run's


def test_an_unapproved_linked_tool_is_refused_whatever_the_caller_approved(tmp_path, keys):
    made = scenario()
    made.decisions["index"]["approved_tools"] = []
    built = write(tmp_path / "probe", made, keys)
    _, _, report, error = run_fixture(built)
    assert report["error_code"] == "link_error"
    assert events(report, "link.failed")[0]["error_code"] == "permission_denied"


def test_denying_one_dependency_denies_its_publishers_key(tmp_path, keys):
    """L-13: both linked packages signed by one key; the person denies one of them."""
    made = scenario()
    made.decisions["index"] = {"decision": "denied"}
    built = write(tmp_path / "probe", made, {"default": keys["default"]})
    package = load_package(built.caller)
    links = link_host(built, package, fixture_adapters(package)[0])
    assert {name: b.decision for name, b in links.bindings.items()} == {
        "index": "denied",
        "scribe": "denied",
    }
    assert links.worst_cases == {"index": None, "scribe": None}


def test_a_mediator_refuses_links_resolved_for_another_package(tmp_path, keys):
    built = build(tmp_path, keys)
    package = load_package(built.caller)
    other = write(tmp_path / "other", scenario("planned-walk"), keys)
    changed = load_package(other.caller)
    assert changed.digest != package.digest
    links = link_host(built, package, fixture_adapters(package)[0])
    with pytest.raises(PolicyError, match="^link_unresolved: "):
        Runtime(changed, grants=built.grants, links=links)
    with pytest.raises(PolicyError, match="^link_unresolved: "):
        Runtime(package, grants=built.grants)


# -- the reservation ----------------------------------------------------------------------------


def test_the_reservation_is_held_while_the_inner_run_works_and_released_after(tmp_path, keys):
    built = build(tmp_path, keys, "planned-walk")
    package = load_package(built.caller)
    router, handlers, input_value = fixture_adapters(package)
    links = link_host(built, package, router)
    workflow = Workflow(package, grants=built.grants, router=router, approved_tools=[], links=links)
    held = []
    replay = links.binding("index").handlers["desk.lookup"]

    async def spying(ctx, payload):
        usage = workflow.runtime._global
        held.append((usage.reserved_tokens, usage.reserved_remote_calls))
        return await replay(ctx, payload)

    links.binding("index").handlers["desk.lookup"] = spying
    report = asyncio.run(workflow.run(input_value))
    assert report["status"] == "completed"
    assert held == [(1, 0), (1, 0)]  # index's worst case: one token, no remote call
    assert workflow.runtime._global.reserved_tokens == 0
    assert workflow.runtime._global.reserved_remote_calls == 0


def test_an_inner_run_that_cannot_be_built_charges_nothing_and_is_recorded(tmp_path, keys):
    """T65 review 1, nit 8: no inner run, no charge; the audit says why the link did not run."""
    built = build(tmp_path, keys, "planned-walk")
    package = load_package(built.caller)
    router, _, input_value = fixture_adapters(package)
    links = link_host(built, package, router)
    start = links.start

    def refusing(binding, **options):
        if binding.link.dependency == "scribe":
            raise PolicyError("the inner run could not be built")
        return start(binding, **options)

    links.start = refusing
    workflow = Workflow(package, grants=built.grants, router=router, approved_tools=[], links=links)
    with pytest.raises(Exception) as failure:
        asyncio.run(workflow.run(input_value))
    report = failure.value.execution_report
    step = [e for e in events(report, "node.failed") if e["node_id"] == "delegate/Writer/draft"]
    assert step[0]["error_code"] == "link_error"
    failed = events(report, "link.failed")
    assert [(e["dependency"], e["inner_run_id"], e["error_code"]) for e in failed] == [
        ("scribe", None, "permission_denied")
    ]
    assert [e["dependency"] for e in events(report, "link.started")] == ["index", "index"]
    usage = report["usage"]
    # The 1,500 tokens held for scribe were released, not charged.
    own = sum(e["tokens"] for e in events(report, "model.completed"))
    assert usage["tokens"] == own and usage["reserved_tokens"] == 0
    assert usage["links"]["scribe"]["runs"] == 0 and usage["links"]["scribe"]["tokens"] == 0
    assert [run["dependency"] for run in report["links"]["runs"]] == ["index", "index"]


def test_a_link_past_its_steps_time_fails_as_timeout_and_settles(tmp_path, keys):
    made = scenario()
    base.role(made.caller, "Lookup")["steps"][0]["timeout_seconds"] = 0.05
    built = write(tmp_path / "probe", made, keys)
    package = load_package(built.caller)
    router, _, input_value = fixture_adapters(package)
    links = link_host(built, package, router)

    async def slow(ctx, payload):
        await asyncio.sleep(5)

    links.binding("index").handlers["desk.lookup"] = slow
    workflow = Workflow(package, grants=built.grants, router=router, approved_tools=[], links=links)
    with pytest.raises(Exception) as failure:
        asyncio.run(workflow.run(input_value))
    report = failure.value.execution_report
    step = [e for e in events(report, "node.failed") if e["node_id"] == "delegate/Lookup/lookup"]
    assert step[0]["error_code"] == "timeout"
    assert len(events(report, "link.started")) == len(events(report, "link.failed")) == 1
    assert workflow.runtime._global.reserved_tokens == 0
    assert report["links"]["runs"][0]["status"] == "failed"


# -- the record, inspect and the CLI ------------------------------------------------------------


def test_the_run_record_lists_the_links_and_their_inner_plans(tmp_path, keys):
    built, (package, links, report, _) = tour(tmp_path, keys)
    record = report["links"]
    assert record["schema"] == "agentpkg-run-links-v0"
    assert [link["dependency"] for link in record["links"]] == ["index", "scribe"]
    for link in record["links"]:
        assert link["decision"] == "accepted"
        assert link["plan"]["parent"] == {
            "package_digest": package.digest,
            "dependency": link["dependency"],
        }
        assert link["plan_hash"] == plan_hash(link["plan"])
        assert link["plan"]["decisions"] == built.decisions[link["dependency"]]["grants"]
    assert [run["status"] for run in record["runs"]] == ["completed"] * 3
    assert {run["node_id"] for run in record["runs"]} == {
        "delegate/Lookup/lookup",
        "delegate/Writer/draft",
    }


def test_inspect_lists_the_links_and_composes_them_when_resolved(tmp_path, keys):
    built = build(tmp_path, keys)
    package = load_package(built.caller)
    listing = inspect_package(package)["links"]
    assert listing["resolved"] is False
    assert [d["id"] for d in listing["dependencies"]] == ["index", "scribe"]
    assert listing["dependencies"][0]["steps"] == [
        {"step": "delegate/Lookup/lookup", "where": "role"}
    ]
    links = link_host(built, package, fixture_adapters(package)[0])
    resolved = {name: b.link for name, b in links.bindings.items()}
    composed = link_records(package, resolved)
    assert composed["resolved"] is True
    assert composed["worst_case"]["model_calls"] == 9
    assert composed["worst_case"]["tool_calls"] == {"index:lookup": 2}
    assert composed["dependencies"][1]["resolved"]["worst_case"]["tokens"] == 1500
    assert [label for label, *_ in link_operations(package.graph)] == [
        "delegate/Lookup/lookup",
        "delegate/Writer/draft",
    ]


def test_the_cli_runs_a_composition_and_writes_the_inner_records(tmp_path, keys, capsys):
    built = build(tmp_path, keys, "planned-walk")
    grants = tmp_path / "grants.json"
    grants.write_text(json.dumps(built.grants), encoding="utf-8")
    out = tmp_path / "out"
    argv = ["run", str(built.caller), "--mode", "fixture", "--grants", str(grants)]
    argv += built.argv(tmp_path) + ["--out", str(out)]
    assert main(argv) == 0, capsys.readouterr().err
    summary = json.loads(capsys.readouterr().out)
    assert summary["passed"] and summary["usage"]["links"]["index"]["runs"] == 2
    links = json.loads((out / "links.json").read_text())
    assert len(links["runs"]) == 3
    for run in links["runs"]:
        inner = json.loads((out / f"link-{run['inner_run_id']}.audit.json").read_text())
        assert inner[0]["run_id"] == run["inner_run_id"]
        assert (out / f"link-{run['inner_run_id']}.result.json").is_file()
    assert "inner_runs" not in json.loads((out / "result.json").read_text())
    assert main(["inspect", str(built.caller)] + built.argv(tmp_path)[:4]) == 0
    assert json.loads(capsys.readouterr().out)["links"]["worst_case"]["model_calls"] == 9
    # With only some dependencies supplied there is no composed figure: inspect says which is
    # missing (T65 review 1, nit 12), and names a link the package does not declare.
    assert main(["inspect", str(built.caller)] + built.argv(tmp_path)[:2]) == 2
    assert capsys.readouterr().err.startswith("agentpkg: link_unresolved: ")
    stray = ["--link", f"nobody={built.archives['index']}"]
    assert main(["inspect", str(built.caller)] + built.argv(tmp_path)[:4] + stray) == 2
    assert capsys.readouterr().err.startswith("agentpkg: link_dependency_unknown: ")


def test_a_linked_publishers_key_does_not_verify_the_caller(tmp_path, keys, capsys):
    """T65 review 1, finding 4: the first `--trust-key` pins the caller's publisher; a key given
    to trust a linked publisher never does. A caller signed by `index`'s publisher is refused
    when the operator pinned `default` for it, though `index`'s key is also given."""
    from agentpkg.package import build_package
    from agentpkg.signing import sign_package

    built = build(tmp_path, keys, "planned-walk")
    grants = tmp_path / "grants.json"
    grants.write_text(json.dumps(built.grants), encoding="utf-8")
    unsigned = build_package(built.caller, tmp_path / "caller.unsigned.agent.pkg")
    by_linked = sign_package(unsigned, keys["index"][0], tmp_path / "caller.by-index.agent.pkg")
    by_own = sign_package(unsigned, keys["default"][0], tmp_path / "caller.by-default.agent.pkg")
    link_args = built.argv(tmp_path)

    def run(archive, order, out):
        trust = [arg for name in order for arg in ("--trust-key", str(keys[name][1]))]
        argv = ["run", str(archive), "--mode", "fixture", "--grants", str(grants)]
        status = main(argv + link_args + trust + ["--out", str(tmp_path / out)])
        return status, capsys.readouterr().err

    status, err = run(by_linked, ("default", "index", "scribe"), "out-linked")
    assert status == 2 and not (tmp_path / "out-linked").exists(), err
    assert "trusted" in err or "signature" in err.lower(), err
    # The caller's own key first: it runs, and the linked publishers' keys trust the links.
    status, err = run(by_own, ("default", "index", "scribe"), "out-own")
    assert status == 0, err
    links = json.loads((tmp_path / "out-own" / "links.json").read_text())
    assert {link["trust"] for link in links["links"]} == {"trusted"}
    # The same keys with a linked publisher's first: that key is not the caller's.
    status, err = run(by_own, ("index", "default", "scribe"), "out-order")
    assert status == 2 and not (tmp_path / "out-order").exists(), err


def test_the_cli_refuses_before_the_run(tmp_path, keys, capsys):
    built = build(tmp_path, keys, "digest-mismatch")
    grants = tmp_path / "grants.json"
    grants.write_text(json.dumps(built.grants), encoding="utf-8")
    out = tmp_path / "out"
    argv = ["run", str(built.caller), "--mode", "fixture", "--grants", str(grants)]
    assert main(argv + built.argv(tmp_path) + ["--out", str(out)]) == 2
    assert capsys.readouterr().err.startswith("agentpkg: link_digest_mismatch: ")
    assert not out.exists()
    # An undecided dependency, and a decision that names no dependency.
    built = build(tmp_path / "second", keys)
    run = ["run", str(built.caller), "--mode", "fixture", "--grants", str(grants)]
    link_args = built.argv(tmp_path)
    cut = link_args.index(f"scribe={tmp_path / 'scribe.grants.json'}")
    partial = link_args[: cut - 1] + link_args[cut + 1 :]
    assert main(run + partial + ["--out", str(out)]) == 2
    assert capsys.readouterr().err.startswith("agentpkg: link_undecided: ")
    assert main(run + link_args + ["--deny-link", "nobody", "--out", str(out)]) == 2
    assert capsys.readouterr().err.startswith("agentpkg: link_dependency_unknown: ")


def test_the_cli_denies_a_link_and_the_run_completes_without_it(tmp_path, keys, capsys):
    built = build(tmp_path, keys, "denied-link-excluded")
    grants = tmp_path / "grants.json"
    grants.write_text(json.dumps(built.grants), encoding="utf-8")
    out = tmp_path / "out"
    argv = ["run", str(built.caller), "--mode", "fixture", "--grants", str(grants)]
    assert "--deny-link" in built.argv(tmp_path)
    assert main(argv + built.argv(tmp_path) + ["--out", str(out)]) == 0, capsys.readouterr().err
    links = json.loads((out / "links.json").read_text())
    decisions = {link["dependency"]: link["decision"] for link in links["links"]}
    assert decisions == {"index": "denied", "scribe": "accepted"}
    assert [run["dependency"] for run in links["runs"]] == ["scribe"]


def test_a_composition_under_other_walks_stays_inside_the_bound(tmp_path, keys):
    for index, walk in enumerate(
        [FULL_TOUR, [("Writer", "write it up"), ("done", "bye")], [("done", "bye")]]
    ):
        made = Scenario(walk=copy.deepcopy(walk))
        built = write(tmp_path / f"probe{index}", made, keys)
        package, links, report, error = run_fixture(built)
        assert error is None
        bound = worst_case(package.graph, package.policy, links=links.worst_cases)
        usage = report["usage"]
        models = len(events(report, "model.called")) + sum(
            link["model_calls"] for link in usage["links"].values()
        )
        assert models <= bound["model_calls"]
        assert usage["tokens"] <= bound["tokens"]
        for tool, count in usage["tool_calls"].items():
            assert count <= bound["tool_calls"][tool]


def test_the_schema_patches_are_applied():
    """`spec/link-v0/*.schema.patch.json` describe the step and check the result: applying them
    to the live schemas again changes nothing."""
    from agentpkg.validation import SCHEMAS

    contracts = base.ROOT / "spec" / "link-v0"
    schemas = {
        name: json.loads((SCHEMAS / f"{name}.schema.json").read_text(encoding="utf-8"))
        for name in ("workflow", "manifest")
    }
    for name in ("workflow", "manifest"):
        patch = json.loads((contracts / f"{name}.schema.patch.json").read_text(encoding="utf-8"))
        live = schemas[name]
        for operation in patch:
            assert operation["op"] == "add"
            *parents, last = operation["path"].split("/")[1:]
            target = live
            for part in parents:
                target = target[int(part)] if isinstance(target, list) else target[part]
            if isinstance(target, list):
                assert operation["value"] in target, operation["path"]
            else:
                assert target[last] == operation["value"], operation["path"]
    for kind in ("step", "node"):
        assert "link" in schemas["workflow"]["$defs"][kind]["properties"]["type"]["enum"]


def test_the_conformance_driver_writes_a_case_a_cli_runs(tmp_path, capsys):
    import subprocess
    import sys

    driver = base.ROOT / "conformance" / "drivers" / "link_probe.py"
    done = subprocess.run(
        [sys.executable, str(driver), str(tmp_path / "case"), "planned-walk"],
        capture_output=True,
        text=True,
        check=True,
    )
    written = json.loads(done.stdout)
    assert written["case"]["id"] == "planned-walk"
    out = tmp_path / "out"
    argv = ["run", written["source"], "--mode", "fixture", "--grants", written["grants"]]
    assert main(argv + written["argv"] + ["--out", str(out)]) == 0, capsys.readouterr().err
    cases = subprocess.run(
        [sys.executable, str(driver), "--cases"], capture_output=True, text=True, check=True
    )
    assert len(json.loads(cases.stdout)) == 59
