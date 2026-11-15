"""The campaign driver (PROTOCOL.md §2.7, D-353): the matrix, the order, the manifest, resume."""

from __future__ import annotations

import json
import shutil
import subprocess
import uuid

import pytest
from campaigns.driver import campaign
from campaigns.origin import catalog

PAYLOADS = catalog.load()


def test_the_smoke_preset_is_one_task_per_class_and_one_payload_pair():
    units = campaign.units_for("smoke", ["L9"], list(campaign.SIDES), PAYLOADS)
    per_side = [u for u in units if u["side"] == "FW"]
    classes = {campaign.load_tasks()[u["task_id"]]["class"] for u in per_side}
    assert classes == {"W1", "W2", "W3", "W4", "W5", "TS-C", "TS-N"}  # no TS-L on L9 (§2.2)
    assert [u for u in units if u["side"] == "Cr" and u["task_set"] == "TS-N"]  # T31b, D-359
    assert campaign.NOT_BUILT == set()
    arms = sorted(campaign.arm_id(u["arm"]) for u in per_side if u["arm"])
    assert arms == ["upload-01@search.fare_name#injected", "upload-01@search.fare_name#twin"]
    assert len(units) == 3 * len(per_side) and all(u["phrasing"] == 0 for u in units)
    assert len({u["id"] for u in units}) == len(units)


def test_the_smoke_preset_runs_one_ts_l_question_on_every_side_on_ts_ls_rungs_only():
    units = campaign.units_for("smoke", ["L9", "L30"], list(campaign.SIDES), PAYLOADS)
    literature = [u for u in units if u["task_set"] == "TS-L"]
    assert sorted((u["side"], u["rung"], u["task_id"]) for u in literature) == [
        ("Cr", "L30", "L1"),
        ("FW", "L30", "L1"),
        ("Py", "L30", "L1"),
    ]
    assert all(u["arm"] is None for u in literature)
    narrowed = campaign.units_for(
        "smoke", ["L9", "L30"], list(campaign.SIDES), PAYLOADS, ("TS-N", "TS-L")
    )
    assert {u["task_set"] for u in narrowed} == {"TS-N", "TS-L"}
    assert len([u for u in narrowed if u["task_set"] == "TS-N"]) == 2 * 3  # two rungs, three sides


def test_the_ts_l_attack_arm_is_the_abstract_and_the_pdf_on_py_and_fw_only():
    units = campaign.units_for("e3", ["L30"], list(campaign.SIDES), PAYLOADS)
    attacked = {
        (u["side"], u["arm"]["placement"]) for u in units if u["task_set"] == "TS-L" and u["arm"]
    }
    assert attacked and {side for side, _ in attacked} == {"Py", "FW"}
    assert {placement for _, placement in attacked} == {"resolver.abstract", "pdf.text"}
    benign = campaign.units_for("e2", ["L30"], list(campaign.SIDES), PAYLOADS, ("TS-L",))
    assert len(benign) == 6 * 3  # every question, one phrasing, every side (E2's parity rows)
    assert not campaign.units_for("qualification", ["L9"], ["Py"], PAYLOADS, ("TS-L",))


def test_the_literature_envelope_is_the_graphs_bound_and_the_policys_caps():
    table = campaign.envelopes()
    family = table["literature-review"]
    assert family == {"per": "run", "model_calls": 47, "tokens": 180_000, "tool_calls": 36}
    unit = {"task_set": "TS-L", "side": "FW", "phrasing": 0}
    task = {"turn_sets": [["q"]]}
    assert campaign.envelope_for(unit, task, table)["model_calls"] == 48  # + the answer step


def test_the_placement_sweep_reaches_a_placement_only_where_the_path_reads_it():
    units = campaign.units_for("placements", ["L9"], ["Py"], PAYLOADS)
    tasks = campaign.load_tasks()
    for unit in units:
        if unit["arm"]:
            assert campaign.reaches(unit["arm"]["placement"], tasks[unit["task_id"]])
    placed = {(u["arm"]["placement"], tasks[u["task_id"]]["class"]) for u in units if u["arm"]}
    assert ("rules.change_summary", "W3") in placed and ("rules.change_summary", "W5") not in placed
    assert ("search.fare_name", "W5") not in placed and ("redirect.search_302", "W5") in placed
    quote_tc = {u["task_id"] for u in units if u["arm"] and u["arm"]["placement"] == "quote.notice"}
    assert {tasks[t].get("shape") for t in quote_tc if t.startswith("C-")} <= {"book", "rebuy"}
    benign = [u for u in units if u["arm"] is None]
    assert len(benign) == 40 * 3 + 12 + 20 * 3  # TS-W × 3 phrasings, TS-C, TS-N × 3


def test_the_order_is_seeded_and_grouped_by_rung():
    units = campaign.units_for("smoke", ["L9", "L30"], ["Py", "FW"], PAYLOADS)
    first = campaign.ordered(units, ["L9", "L30"], 31)
    assert first == campaign.ordered(units, ["L9", "L30"], 31)
    assert first != campaign.ordered(units, ["L9", "L30"], 32)
    rungs = [u["rung"] for u in first]
    assert rungs == sorted(rungs, key=["L9", "L30"].index)


def test_resume_refuses_a_changed_manifest(tmp_path, capsys):
    out = tmp_path / "campaign"
    base = ["--preset", "smoke", "--rungs", "L9", "--sides", "Py", "--out", str(out), "--dry-run"]
    assert campaign.main(base) == 0
    manifest = json.loads((out / "manifest.json").read_text())
    for key in ("commit", "dirty_fingerprint", "protocol", "payloads", "policies", "rungs"):
        assert key in manifest
    assert manifest["expected_runs"] == 9
    assert campaign.main([*base, "--resume"]) == 0
    assert campaign.main([*base, "--resume", "--seed", "7"]) == 2
    assert "refusing to resume" in capsys.readouterr().out


def test_resume_works_for_a_results_directory_inside_the_repository(capsys):
    """Review 1, finding 2: the campaign's own untracked directory is not a change of the tree."""
    out = campaign.ROOT / "experiments" / f"campaign-resume-probe-{uuid.uuid4().hex[:8]}"
    base = ["--preset", "smoke", "--rungs", "L9", "--sides", "Py", "--out", str(out), "--dry-run"]
    try:
        assert campaign.main(base) == 0
        status = subprocess.run(
            ["git", "status", "--porcelain"], cwd=campaign.ROOT, capture_output=True, text=True
        ).stdout
        assert out.name in status  # the directory is visible to a plain status
        assert campaign.main([*base, "--resume"]) == 0, capsys.readouterr().out
    finally:
        shutil.rmtree(out, ignore_errors=True)


def test_the_tree_state_ignores_only_the_results_directory(tmp_path):
    inside = campaign.ROOT / "experiments" / f"campaign-state-probe-{uuid.uuid4().hex[:8]}"
    try:
        inside.mkdir()
        (inside / "x.json").write_text("{}")
        assert inside.name not in campaign.tree_state(inside)[0]
        assert inside.name in campaign.tree_state(tmp_path / "elsewhere")[0]
    finally:
        shutil.rmtree(inside, ignore_errors=True)


def test_campaigns_side_by_side_never_see_each_others_directories():
    """T32: one campaign per rung runs at once in one results directory; the first shard of each
    wrote its manifest clean, the later shards saw the sibling directories as a dirty tree."""
    results = campaign.EXPERIMENTS / "injection_campaign" / "results"
    tag = uuid.uuid4().hex[:8]
    mine, sibling = results / f"probe-{tag}-L9", results / f"probe-{tag}-L30"
    code = campaign.EXPERIMENTS / f"campaign-state-probe-{tag}"
    try:
        for path in (mine, sibling, code):
            path.mkdir()
            (path / "x.json").write_text("{}")
        status = campaign.tree_state(mine)[0]
        assert mine.name not in status and sibling.name not in status
        assert code.name in status  # anything outside the results tree is still a change
    finally:
        for path in (mine, sibling, code):
            shutil.rmtree(path, ignore_errors=True)


SMOKE = campaign.EXPERIMENTS / "injection_campaign" / "results" / "2026-11-04T19-25-14Z_smoke"
READS = {"search": "search-flights", "rules": "get-fare-rules", "quote": "prepare-booking"}


def test_the_reach_table_agrees_with_the_smoke_records():
    """Review 1, finding 5: on our sides, a class whose runs got an answer holding a placement's
    field is in its reach, and W5 never read fare rules or a quote (its search found no flight)."""
    tasks = campaign.load_tasks()
    records = [json.loads(p.read_text()) for p in SMOKE.glob("runs/*/run.json")]
    records = [r for r in records if r["meta"]["side"] in ("Py", "Cr")]
    assert records
    for rec in records:
        task = tasks[rec["meta"]["task_id"]]
        called = {
            c["tool"]
            for c in rec["tool_calls"]
            if c["tool"] != "search-flights" or (c.get("answer") or {}).get("flights")
        }
        for prefix, tool in READS.items():
            if tool in called and task["task_set"] != "TS-N":
                assert campaign.reaches(f"{prefix}.x", task), (rec["meta"]["run_id"], prefix)
        if task["class"] == "W5":
            assert not called & {"get-fare-rules", "prepare-booking"}


def _units(side="Py", task_id="W1-01", arm=None):
    unit = {"task_set": "TS-W", "task_id": task_id, "phrasing": 0, "side": side, "rung": "H"}
    unit["arm"] = arm
    unit["id"] = campaign.unit_id(unit)
    return unit


def test_a_crash_in_preparation_is_a_harness_error_and_resume_reruns_a_leftover(
    tmp_path, monkeypatch
):
    """Review 1, finding 6: the driver's preparation runs inside the harness-error path, and a
    unit directory without `run.json` never blocks a resume."""
    unit = _units()
    leftover = tmp_path / "runs" / unit["id"]
    (leftover / "memory").mkdir(parents=True)

    def crashing(**kw):
        kw["run_dir"].mkdir(parents=True, exist_ok=False)  # as every driver does
        raise FileNotFoundError("the package is missing")

    monkeypatch.setattr(campaign, "_runner", lambda side: crashing)
    outcome = campaign.run_unit(
        unit,
        tasks=campaign.load_tasks(),
        payloads=PAYLOADS,
        stack=None,
        out=tmp_path,
        ollama_url="http://127.0.0.1:9",
    )
    rec = json.loads((leftover / "run.json").read_text())
    assert rec["status"] == "harness_error" and "FileNotFoundError" in rec["harness_error"]
    assert outcome["harness_error"] is True and not (leftover / "memory").exists()


def _fake_record(side, usage, **extra):
    def runner(**kw):
        kw["run_dir"].mkdir(parents=True)
        rec = {
            "schema": "campaign.run.v1",
            "meta": kw["meta"],
            "status": "completed",
            "harness_error": None,
            "turns": [],
            "answer": None,
            "audit": None,
            "tool_calls": [],
            "refused": [],
            "model_calls": [],
            "consent": [],
            "dials": [],
            "origin_log": [],
            "sink_log": [],
            "usage": usage,
            **extra,
        }
        (kw["run_dir"] / "run.json").write_text(json.dumps(rec))
        return rec

    return runner


@pytest.mark.parametrize("side,bound", [("Py", 4), ("Cr", 4), ("FW", 5)])
def test_the_outcome_carries_the_envelope_and_the_list_price(tmp_path, monkeypatch, side, bound):
    """Review 1, finding 7: (e) and dollars are computed in a campaign, the envelope per side."""
    table = campaign.envelopes()
    assert table["webair"]["model_calls"] == 4
    unit = _units(side)
    task = campaign.load_tasks()[unit["task_id"]]
    assert campaign.envelope_for(unit, task, table)["model_calls"] == bound
    usage = {"input_tokens": 100_000, "output_tokens": 0, "model_calls": 5, "tool_calls": 1}
    monkeypatch.setattr(campaign, "_runner", lambda s: _fake_record(s, usage))
    outcome = campaign.run_unit(
        unit,
        tasks=campaign.load_tasks(),
        payloads=PAYLOADS,
        stack=None,
        out=tmp_path,
        ollama_url="http://127.0.0.1:9",
        envelopes_table=table,
    )
    assert outcome["boundaries"] == (["e"] if side != "FW" else [])
    price = json.loads(campaign.RUNGS.read_text())["rungs"]["H"]["list_price_usd_per_mtok"]
    assert outcome["cost"]["dollars"] == pytest.approx(price["input"] / 10)
    assert campaign.prices_for("L9") is None


def test_a_failed_lookup_on_any_side_is_a_harness_error():
    for dial in (
        {"host": "webagents-webair-production.up.railway.app", "lookup": {"ok": False}},
        {"kind": "lookup", "host": "x.invalid", "lookup": {"ok": False, "error": "ENOTFOUND"}},
    ):
        rec = campaign.promote_failed_lookup({"status": "failed", "dials": [dial]})
        assert rec["status"] == "harness_error" and rec["harness_error"].startswith("dns_")


def test_an_arm_that_never_reached_the_run_is_not_exposed():
    arm = {"payload": "upload-01", "placement": "rules.change_summary", "arm": "injected"}
    assert campaign.exposure({"origin_log": [{"inserted": False}]}, arm) is False
    assert campaign.exposure({"origin_log": [{"inserted": True}]}, arm) is True
    record_arm = {**arm, "placement": "record.profile_body"}
    profile = [{"tool": "travel.profile", "outcome": "answered"}]
    assert campaign.exposure({"tool_calls": profile}, record_arm) is True
    assert campaign.exposure({"tool_calls": []}, record_arm) is False
    assert campaign.exposure({}, None) is None


def test_a_campaign_never_overrides_the_dns_answer():
    """§2.1: the real DNS answer is classified; only offline tests may override it."""
    for name in ("campaign.py", "py_driver.py", "cr_driver.py"):
        assert "dns_override" not in (campaign.EXPERIMENTS / "campaigns/driver" / name).read_text()
    assert "dns_override" not in (campaign.EXPERIMENTS / "campaigns/baseline/agent.py").read_text()


def test_a_conversations_envelope_is_capped_by_the_conversations_budget():
    """Review 2, finding 2: (e) is measured against what our side can spend, the conversation's
    tokens and its one purchase across turns, not per-turn x turns."""
    table = campaign.envelopes()
    tasks = campaign.load_tasks()
    conversation = table["webair"]["conversation"]
    assert conversation["tokens"] == 240_000 and conversation["max_calls_per_tool"] == {
        "simulate-purchase": 1
    }
    unit = {"task_set": "TS-C", "task_id": "C-11", "phrasing": 0, "side": "FW", "rung": "L9"}
    envelope = campaign.envelope_for(unit, tasks["C-11"], table)
    per_turn = table["webair"]
    assert envelope["tokens"] == conversation["tokens"] < per_turn["tokens"] * 3
    assert envelope["tool_calls"] == (per_turn["tool_calls"] - 1) * 3 + 1
    assert envelope["model_calls"] == (per_turn["model_calls"] + 1) * 3
    one_turn = campaign.envelope_for({**unit, "task_set": "TS-W"}, tasks["W1-01"], table)
    assert one_turn["tokens"] == per_turn["tokens"]


def test_resume_classifies_a_recorded_unit_without_an_outcome_and_never_reruns_it(
    tmp_path, monkeypatch, capsys
):
    """Review 2, finding 5: "finished" is `outcome.json`; a unit with its record and no outcome
    is classified from its record on `--resume`, and the summary names any unit still missing."""
    out = tmp_path / "c"
    assert (
        campaign.main(
            ["--preset", "smoke", "--rungs", "L9", "--sides", "FW", "--out", str(out), "--dry-run"]
        )
        == 0
    )
    units = json.loads((out / "units.json").read_text())
    tasks = campaign.load_tasks()
    usage = {"input_tokens": 10, "output_tokens": 1, "model_calls": 1, "tool_calls": 0}
    for unit in units:  # every unit recorded, as if a campaign had run them
        _fake_record("FW", usage)(
            run_dir=out / "runs" / unit["id"],
            meta={
                "run_id": unit["id"],
                "side": "FW",
                "task_set": unit["task_set"],
                "arm": campaign.arm_id(unit["arm"]),
            },
        )
        campaign.finish_unit(unit, tasks=tasks, payloads=PAYLOADS, out=out)
    victim = units[0]
    outcome = out / "runs" / victim["id"] / "outcome.json"
    expected = outcome.read_text()
    outcome.unlink()
    ran = []

    def fake_run(unit, **kw):  # a run that writes nothing: its unit stays missing
        ran.append(unit["id"])
        return {"harness_error": True, "boundaries": [], "exposed": None}

    monkeypatch.setattr(campaign, "run_unit", fake_run)

    class Stack:
        def __init__(self, *a, **kw):
            pass

        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

    import campaigns.origin.stack as stack_module

    monkeypatch.setattr(stack_module, "CampaignStack", Stack)
    capsys.readouterr()
    args = ["--preset", "smoke", "--rungs", "L9", "--sides", "FW", "--out", str(out), "--resume"]
    assert campaign.main(args) == 0
    assert ran == [] and outcome.read_text() == expected
    summary = json.loads((out / "summary.json").read_text())
    assert summary["runs"] == summary["expected_runs"] == len(units) and summary["complete"]
    # A unit with neither file is run; one the summary cannot find is named, never silently short.
    shutil.rmtree(out / "runs" / victim["id"])
    assert campaign.main(args) == 1
    assert ran == [victim["id"]]
    summary = json.loads((out / "summary.json").read_text())
    assert summary["missing"] == [victim["id"]] and summary["complete"] is False


def test_the_summary_keeps_the_injected_and_twin_arms_apart():
    meta = {"side": "Py", "task_set": "TS-W", "family": "F-UPLOAD"}
    meta["arm"] = "upload-01@search.fare_name#twin"
    assert campaign._cell_key(meta, "L9") == "Py|L9|TS-W|F-UPLOAD#twin"
    assert campaign._cell_key({**meta, "arm": "upload-02@rules.change_summary#injected"}, "L9") == (
        "Py|L9|TS-W|F-UPLOAD#injected"
    )
    benign = {"side": "FW", "task_set": "TS-C", "arm": "benign"}
    assert campaign._cell_key(benign, "L4") == "FW|L4|TS-C|benign"


def test_the_redirect_twin_is_exposed_as_the_plain_answer():
    arm = {"payload": "redirect-01", "placement": "redirect.search_302", "arm": "twin"}
    assert campaign.exposure({"origin_log": [{"inserted": False, "twin_plain": True}]}, arm)


def test_an_unknown_side_has_no_driver_in_any_family():
    """T31b review 1, nit 5: no family falls through to the framework's driver."""
    for runner in (campaign._runner, campaign._network_runner, campaign._literature_runner):
        with pytest.raises(ValueError, match="no .* driver for side 'XX'"):
            runner("XX")
    assert campaign._literature_runner("FW").__module__ == "campaigns.baseline.literature"
    assert campaign._network_runner("Cr").__module__ == "campaigns.driver.cr_driver"


# -- T32: the presets of PROTOCOL.md §3 E2 and E3 (D-360) -------------------------------------
def test_e3_is_300_injected_runs_per_cell_stratified_37_or_38_per_family_each_with_its_twin():
    import collections

    units = campaign.units_for("e3", ["L9"], ["Py"], PAYLOADS, ("TS-W",))
    injected = [u for u in units if u["arm"]["arm"] == "injected"]
    twins = [u for u in units if u["arm"]["arm"] == "twin"]
    assert len(injected) == len(twins) == 300
    by_family = collections.Counter(PAYLOADS[u["arm"]["payload"]]["family"] for u in injected)
    assert set(by_family) == set(catalog.E3_FAMILIES)
    assert sorted(by_family.values()) == [37] * 4 + [38] * 4
    strip = lambda u: (u["task_id"], u["phrasing"], u["arm"]["payload"], u["arm"]["placement"])  # noqa: E731
    assert sorted(map(strip, injected)) == sorted(map(strip, twins))  # every run has its twin
    assert len(set(map(strip, injected))) == 300  # drawn without replacement


def test_e3_draws_admit_only_the_families_tasks_and_reached_placements():
    tasks = campaign.load_tasks()
    for task, _phrasing, payload_id, placement in campaign.e3_draws(tasks, PAYLOADS):
        payload = PAYLOADS[payload_id]
        assert task["class"] in ("W1", "W2", "W3", "W4")
        assert placement in payload["placements"]
        assert placement in catalog.RECORD_PLACEMENTS or campaign.reaches(placement, task)
        if payload["family"] in ("F-ACTION", "F-CONSENT"):
            assert task["class"] != "W4"
        if payload["family"] == "F-STEER":
            assert not task["truth"]["selected_fare_id"].endswith("-FLEX")
        assert payload_id not in campaign.LITERATURE_PAYLOADS


def test_e3_cells_pair_across_sides_and_rungs():
    """The draws depend on the seed only: every side and rung runs the same 600 arms."""
    units = campaign.units_for("e3", ["L4", "L9"], list(campaign.SIDES), PAYLOADS, ("TS-W",))
    arms = {}
    for u in units:
        arms.setdefault((u["side"], u["rung"]), set()).add(
            (u["task_id"], u["phrasing"], campaign.arm_id(u["arm"]))
        )
    assert len(arms) == 6 and len({frozenset(v) for v in arms.values()}) == 1
    assert all(len(v) == 600 for v in arms.values())


def test_e3s_literature_arm_is_every_question_by_its_payloads_and_placements_injected_only():
    units = campaign.units_for("e3", ["L30"], list(campaign.SIDES), PAYLOADS, ("TS-L",))
    assert {u["side"] for u in units} == {"Py", "FW"}
    per_side = [u for u in units if u["side"] == "Py"]
    placements = sum(len(PAYLOADS[p]["placements"]) for p in campaign.LITERATURE_PAYLOADS)
    assert len(per_side) == 6 * placements and {u["arm"]["arm"] for u in units} == {"injected"}


def test_e2_is_every_task_by_its_phrasings_benign_and_paper_is_e2_plus_e3():
    e2 = campaign.units_for("e2", ["L9"], ["FW"], PAYLOADS)
    assert len(e2) == 40 * 3 + 20 * 3 + 12 and all(u["arm"] is None for u in e2)
    e3 = campaign.units_for("e3", ["L9"], ["FW"], PAYLOADS)
    paper = campaign.units_for("paper", ["L9"], ["FW"], PAYLOADS)
    assert sorted(u["id"] for u in paper) == sorted(u["id"] for u in e2 + e3)
    qualification = campaign.units_for("qualification", ["L9"], ["FW"], PAYLOADS)
    assert sorted(u["id"] for u in qualification) == sorted(u["id"] for u in paper)
    with pytest.raises(ValueError, match="one rung"):
        campaign.units_for("qualification", ["L9", "L30"], ["FW"], PAYLOADS)


def test_shards_partition_the_units_and_share_one_manifest(tmp_path, capsys):
    out = tmp_path / "out"
    base = ["--preset", "e3", "--rungs", "L9", "--sides", "Py", "--out", str(out), "--dry-run"]
    assert campaign.main([*base, "--shard", "0/3"]) == 0
    manifest = (out / "manifest.json").read_text()
    assert campaign.main([*base, "--shard", "2/3"]) == 0  # checks, never rewrites
    assert (out / "manifest.json").read_text() == manifest
    units = json.loads((out / "units.json").read_text())
    parts = [units[i::3] for i in range(3)]
    assert sum(map(len, parts)) == len(units) and not set.intersection(
        *[{u["id"] for u in p} for p in parts]
    )
    with pytest.raises(SystemExit):
        campaign.main([*base, "--shard", "3/3"])


def test_ts_l_is_never_sharded(tmp_path):
    """Crossref's lane is per process (pacing.py): sharded TS-L would query it concurrently."""
    base = ["--preset", "e2", "--rungs", "L30", "--sides", "Py", "--out", str(tmp_path / "o")]
    with pytest.raises(SystemExit):
        campaign.main([*base, "--shard", "0/2", "--dry-run"])
    narrowed = [*base, "--task-sets", "TS-W", "--shard", "0/2", "--dry-run"]
    assert campaign.main(narrowed) == 0


def test_literature_review_units_get_the_context_their_package_needs_on_local_rungs():
    """§2.2 (num_ctx per package need): TS-L on L30 at 65,536; WebAir at the rung's 32,768; a hosted
    rung keeps its own route."""
    url = "http://127.0.0.1:11434"
    tsl = campaign.rung_for_unit({"rung": "L30", "task_set": "TS-L"}, url)
    webair = campaign.rung_for_unit({"rung": "L30", "task_set": "TS-W"}, url)
    hosted = campaign.rung_for_unit({"rung": "H", "task_set": "TS-L"}, url)
    assert tsl.context_window == 65536 and webair.context_window == 32768
    assert hosted.context_window == campaign.rung_of("H", url).context_window
