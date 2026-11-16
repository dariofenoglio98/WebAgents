"""`scripts/verify_link_run.py` (T65, D-697): a run of a composition verifies from its record
and the declarations alone, and each check fails on the defect it exists for."""

import importlib.util
import json
import subprocess
import sys
from pathlib import Path

import pytest
from link_probe import scenario, write

from agentpkg.cli import main

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "scripts" / "verify_link_run.py"


@pytest.fixture(scope="module")
def verifier():
    spec = importlib.util.spec_from_file_location("verify_link_run", SCRIPT)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def run(tmp_path, keys, variant="planned-walk"):
    """One CLI run of the probe; the built composition and the record's directory."""
    built = write(tmp_path / "probe", scenario(variant), keys)
    grants = tmp_path / "grants.json"
    grants.write_text(json.dumps(built.grants), encoding="utf-8")
    out = tmp_path / "out"
    argv = ["run", str(built.caller), "--mode", "fixture", "--grants", str(grants)]
    assert main(argv + built.argv(tmp_path) + ["--out", str(out)]) == 0
    return built, out


def check(verifier, built, out, **options):
    return verifier.verify(
        out, package=built.caller, links={**built.archives, **built.joinable}, **options
    )


def failed(result):
    return [] if result["passed"] else [item["check"] for item in result["checks"]]


def rewrite(path, change):
    value = json.loads(path.read_text(encoding="utf-8"))
    change(value)
    path.write_text(json.dumps(value), encoding="utf-8")


@pytest.mark.parametrize("variant", ["planned-walk", "denied-link-excluded", "link-in-map", None])
def test_a_run_verifies_from_its_record(verifier, tmp_path, keys, capsys, variant):
    built, out = run(tmp_path, keys, variant)
    result = check(verifier, built, out)
    assert result["passed"], result["checks"]
    assert isinstance(result["checks"], int) and result["checks"] > 20
    for figure in ("model_calls", "tokens", "remote_calls"):
        assert result["observed"][figure] <= result["at_most"][figure]
    if variant == "planned-walk":
        # The full tour attains the composed calls: the bound is recomputed, not read.
        assert result["observed"]["model_calls"] == result["at_most"]["model_calls"] == 9
        assert result["observed"]["tool_calls"] == result["at_most"]["tool_calls"]
        assert [link["runs"] for link in result["links"]] == [2, 1]
    if variant == "denied-link-excluded":
        assert {link["dependency"]: link["decision"] for link in result["links"]} == {
            "index": "denied",
            "scribe": "accepted",
        }
        assert result["at_most"]["activations"]["Lookup"] == 0


def test_the_script_prints_json_and_its_status(tmp_path, keys, capsys):
    built, out = run(tmp_path, keys)
    capsys.readouterr()
    argv = [sys.executable, str(SCRIPT), str(out), "--package", str(built.caller)]
    for name, archive in built.archives.items():
        argv += ["--link", f"{name}={archive}"]
    done = subprocess.run(argv, capture_output=True, text=True, check=False)
    assert done.returncode == 0, done.stdout[-800:]
    assert json.loads(done.stdout)["passed"] is True
    (out / "links.json").unlink()
    done = subprocess.run(argv, capture_output=True, text=True, check=False)
    assert done.returncode == 1 and "Traceback" not in done.stderr
    assert json.loads(done.stdout)["passed"] is False


def test_an_inner_run_of_a_denied_link_fails(verifier, tmp_path, keys):
    built, out = run(tmp_path, keys)

    def deny(record):
        record["links"][0]["decision"] = "denied"

    rewrite(out / "links.json", deny)
    names = failed(check(verifier, built, out))
    assert "no inner run of a denied link" in names
    assert any("started on an accepted decision" in name for name in names)


def test_a_changed_inner_plan_fails(verifier, tmp_path, keys):
    built, out = run(tmp_path, keys)

    def widen(record):
        record["links"][0]["plan"]["decisions"]["desk.read"] = "always"

    rewrite(out / "links.json", widen)
    assert "link index: its inner plan is hash-bound to this caller" in failed(
        check(verifier, built, out)
    )


def test_a_missing_or_edited_inner_record_fails(verifier, tmp_path, keys):
    built, out = run(tmp_path, keys)
    inner = sorted(out.glob("link-*.audit.json"))
    rewrite(inner[0], lambda audit: audit[2].update(action="tool.completed"))
    assert any("one valid chain" in name for name in failed(check(verifier, built, out)))
    inner[1].unlink()
    assert any(
        "its record is beside the caller's" in n for n in failed(check(verifier, built, out))
    )


def test_usage_that_does_not_sum_fails(verifier, tmp_path, keys):
    built, out = run(tmp_path, keys)
    rewrite(out / "usage.json", lambda usage: usage.update(tokens=usage["tokens"] - 1))
    assert "the caller's tokens are its own calls plus every inner run's" in failed(
        check(verifier, built, out)
    )


def test_a_linked_packages_compute_calls_are_inside_the_callers_usage(verifier, tmp_path, keys):
    """L-26: the caller's `compute_calls` holds every inner run's, though the caller declares no
    module; the verifier checks the sum and reads the observed figure from it."""
    built, out = run(tmp_path, keys, "linked-compute")
    usage = json.loads((out / "usage.json").read_text())
    assert usage["compute_calls"] == 2 == usage["links"]["index"]["compute_calls"]
    result = check(verifier, built, out)
    assert result["passed"], result["checks"]
    assert result["observed"]["compute_calls"] == result["at_most"]["compute_calls"] == 2
    rewrite(out / "usage.json", lambda usage: usage.update(compute_calls=0))
    assert "the caller's compute calls are its own plus every inner run's" in failed(
        check(verifier, built, out)
    )


def test_a_node_beside_the_network_has_its_place_in_the_bound(verifier, tmp_path, keys):
    """The bound is the package's worst case (L-18), not the network's alone: a top-level link
    beside the network is observed, so it is in the "at most" too."""
    from link_probe import add_node, add_worker

    made = scenario("planned-walk")
    add_worker(made.caller, "Aside")
    add_node(
        made.caller,
        {
            "id": "aside",
            "type": "link",
            "dependency": "index",
            "worker": "Aside",
            "depends_on": [],
            "input": {"object": {"query": {"literal": "look up hello"}}},
            "output_schema": "schemas/answer.schema.json",
            "timeout_seconds": 20,
            "writes": {},
        },
    )
    built = write(tmp_path / "probe", made, keys)
    grants = tmp_path / "grants.json"
    grants.write_text(json.dumps(built.grants), encoding="utf-8")
    out = tmp_path / "out"
    argv = ["run", str(built.caller), "--mode", "fixture", "--grants", str(grants)]
    assert main(argv + built.argv(tmp_path) + ["--out", str(out)]) == 0
    result = check(verifier, built, out)
    assert result["passed"], result["checks"]
    assert result["observed"]["tool_calls"] == {"index:lookup": 3}
    assert result["at_most"]["tool_calls"] == {"index:lookup": 3}


def test_a_figure_past_the_recomputed_bound_fails(verifier, tmp_path, keys):
    """A caller whose declaration allows fewer lookups than the record holds: the bound comes
    from the declaration the verifier is given, never from the record."""
    built, out = run(tmp_path, keys)
    tighter = write(tmp_path / "tighter", scenario(), keys)
    graph = tighter.caller / "graph.json"
    rewrite(graph, lambda g: g["network"]["roles"]["Desk"]["edges"][0].update(max_uses=1))
    names = failed(verifier.verify(out, package=tighter.caller, links=built.archives))
    assert "the caller's package is the one that ran" in names
    assert "tool_calls.index:lookup inside the composed bound" in names


def test_another_archive_under_the_same_name_fails(verifier, tmp_path, keys):
    built, out = run(tmp_path, keys)
    swapped = {"index": built.archives["scribe"], "scribe": built.archives["scribe"]}
    names = failed(verifier.verify(out, package=built.caller, links=swapped))
    assert "link index: the archive is the pinned one" in names


def test_the_canary_hook_binds_observations_to_the_audit(verifier, tmp_path, keys):
    built, out = run(tmp_path, keys)
    links = json.loads((out / "links.json").read_text())
    lookup = next(r["inner_run_id"] for r in links["runs"] if r["dependency"] == "index")
    sent = {lookup: {"tool_arguments": [{"query": "look up hello"}]}}
    clean = check(verifier, built, out, observations=sent, canaries=["CANARY-7"])
    assert clean["passed"], clean["checks"]
    assert clean["inner_dispatches"][lookup]["tool_arguments"] == 1
    # A value the inner audit never hashed is not evidence.
    unknown = {lookup: {"tool_arguments": [{"query": "something else"}]}}
    names = failed(check(verifier, built, out, observations=unknown, canaries=["CANARY-7"]))
    assert any("every observed value is one its audit hashed" in name for name in names)
    # A canary, exact or encoded, in what an inner run sent.
    for needle in ("look up hello", "bG9vayB1cCBoZWxsbw", "olleh pu kool"):
        assert needle in verifier.encodings("look up hello")
    names = failed(check(verifier, built, out, observations=sent, canaries=["look up hello"]))
    assert any("no canary in what it sent" in name for name in names)


# -- the run-time half: a join and a raise (D-697) ------------------------------------------------


def test_a_run_with_a_join_verifies_and_recomputes_the_candidates_worst_case(
    verifier, tmp_path, keys
):
    built, out = run(tmp_path, keys, "join-accepted")
    result = check(verifier, built, out)
    assert result["passed"], result["checks"]
    assert result["joins"] == [
        {
            "slot": "helper",
            "joined": True,
            "reason": None,
            "decided_by": "person",
            "package_id": "org.example.link-probe.helper",
        }
    ]
    # The slot is in the bound at its ceiling, whatever joined.
    assert result["at_most"]["tool_calls"]["helper:*"] == 2
    assert result["observed"]["tool_calls"]["helper:lookup"] == 1


def run_made(tmp_path, keys, made):
    """`run` for a composition a test put together itself."""
    built = write(tmp_path / "probe", made, keys)
    grants = tmp_path / "grants.json"
    grants.write_text(json.dumps(built.grants), encoding="utf-8")
    out = tmp_path / "out"
    argv = ["run", str(built.caller), "--mode", "fixture", "--grants", str(grants)]
    assert main(argv + built.argv(tmp_path) + ["--out", str(out)]) == 0
    return built, out


def test_a_slot_that_joins_twice_verifies(verifier, tmp_path, keys):
    import link_probe as probe

    # `max_joins: 2`: the slot's step runs at each activation of its role and joins at both,
    # the same package under the same inner plan, so a join is known by its decision's place
    # in the audit and not by its slot.
    made = scenario()
    probe.with_join(made, decisions=[probe.ACCEPT, probe.ACCEPT], slot={"max_joins": 2})
    made.walk = list(probe.FULL_TOUR)
    built, out = run_made(tmp_path, keys, made)
    result = check(verifier, built, out)
    assert result["passed"], result["checks"]
    assert [join["joined"] for join in result["joins"]] == [True, True]
    assert result["observed"]["tool_calls"]["helper:lookup"] == 2
    audit = json.loads((out / "audit.json").read_text())
    starts = [e for e in audit if e["action"] == "link.started" and "slot" in e]
    assert len(starts) == 2 and len({e["inner_plan_hash"] for e in starts}) == 1


def test_a_call_or_an_inner_run_at_a_slot_step_without_an_accepted_decision_fails(
    verifier, tmp_path, keys
):
    built, out = run(tmp_path, keys, "join-accepted")

    def declined(audit):
        (card,) = [e for e in audit if e["action"] == "link.decided"]
        card["accepted"] = False

    rewrite(out / "audit.json", declined)
    assert (
        "at a slot step, a model call and an inner run follow an accepted decision of it"
        in failed(check(verifier, built, out))
    )


def test_a_planned_link_started_after_its_key_was_declined_fails(
    verifier, tmp_path, keys, monkeypatch
):
    from agentpkg.links.host import LinkHost

    # A runtime that reads only the review's decision, as before the rule: `index` runs after
    # the person declined a card of the key that signed it.
    monkeypatch.setattr(LinkHost, "denied", lambda self, binding: binding.decision != "accepted")
    built, out = run(tmp_path, keys, "declined-key-planned-link")
    assert failed(check(verifier, built, out)) == ["no inner run of a key declined on a card"]


@pytest.mark.parametrize(
    "variant", ["join-declined", "unattended-join", "join-cap", "join-conversational"]
)
def test_a_run_with_a_refused_join_verifies(verifier, tmp_path, keys, variant):
    built, out = run(tmp_path, keys, variant)
    result = check(verifier, built, out)
    assert result["passed"], result["checks"]
    assert [join["joined"] for join in result["joins"]] == (
        [True, False] if variant == "join-cap" else [False]
    )


def test_a_join_plan_of_another_run_fails(verifier, tmp_path, keys):
    built, out = run(tmp_path, keys, "join-accepted")

    def another_run(record):
        record["joins"][0]["package"]["plan"]["parent"]["run_id"] = "0" * 8

    rewrite(out / "links.json", another_run)
    assert (
        "join helper: its inner plan is hash-bound to this plan, this run and this slot"
        in failed(check(verifier, built, out))
    )


def test_a_candidate_past_the_slots_ceiling_fails(verifier, tmp_path, keys):
    built, out = run(tmp_path, keys, "join-accepted")
    # The same record against a caller whose slot allows the joined package no tool call.
    tighter = tmp_path / "tighter"
    import shutil

    shutil.copytree(built.caller, tighter)
    graph = json.loads((tighter / "graph.json").read_text())
    slot = graph["network"]["roles"]["Lookup"]["steps"][-1]
    slot["budget"]["tool_calls"] = 0
    (tighter / "graph.json").write_text(json.dumps(graph))
    result = verifier.verify(out, package=tighter, links={**built.archives, **built.joinable})
    assert any("fits the slot's ceiling" in name for name in failed(result))


def test_a_run_with_a_raise_verifies_and_a_raise_under_another_plan_fails(verifier, tmp_path, keys):
    built, out = run(tmp_path, keys, "raise-accepted")
    result = check(verifier, built, out)
    assert result["passed"], result["checks"]
    assert result["raises"] == [{"limit": "tokens", "from": 1700, "to": result["raises"][0]["to"]}]
    assert result["raises"][0]["to"] <= 1700 + 850

    def another_plan(record):
        record["caller_plan"]["limits"] = {}
        record["caller_plan_hash"] = "0" * 64

    rewrite(out / "links.json", another_plan)
    names = failed(check(verifier, built, out))
    assert "a raise names this run and its plan, and was asked for these figures" in names
    assert "the caller's plan is the one its hash names" in names


def test_a_canary_in_an_address_a_slot_fetched_fails(verifier, tmp_path, keys):
    built, out = run(tmp_path, keys, "join-declined")
    assert check(verifier, built, out, canaries=["helper.example"])["passed"] is False
    assert check(verifier, built, out, canaries=["NOT-THERE"])["passed"]
