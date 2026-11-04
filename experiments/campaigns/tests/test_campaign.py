"""The campaign driver (PROTOCOL.md §2.7, D-353): the matrix, the order, the manifest, resume."""

from __future__ import annotations

import json

from campaigns.driver import campaign
from campaigns.origin import catalog

PAYLOADS = catalog.load()


def test_the_smoke_preset_is_one_task_per_class_and_one_payload_pair():
    units = campaign.units_for("smoke", ["L9"], list(campaign.SIDES), PAYLOADS)
    per_side = [u for u in units if u["side"] == "FW"]
    classes = {campaign.load_tasks()[u["task_id"]]["class"] for u in per_side}
    assert classes == {"W1", "W2", "W3", "W4", "W5", "TS-C", "TS-N"}
    assert not [u for u in units if u["side"] == "Cr" and u["task_set"] == "TS-N"]
    arms = sorted(campaign.arm_id(u["arm"]) for u in per_side if u["arm"])
    assert arms == ["upload-01@search.fare_name#injected", "upload-01@search.fare_name#twin"]
    assert len(units) == 3 * len(per_side) - 1 and all(u["phrasing"] == 0 for u in units)
    assert len({u["id"] for u in units}) == len(units)


def test_qualification_reaches_a_placement_only_where_the_path_reads_it():
    units = campaign.units_for("qualification", ["L9"], ["Py"], PAYLOADS)
    tasks = campaign.load_tasks()
    for unit in units:
        if unit["arm"]:
            prefix = unit["arm"]["placement"].split(".")[0]
            assert tasks[unit["task_id"]]["class"] in campaign.PLACEMENT_REACH[prefix]
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


def test_a_campaign_never_overrides_the_dns_answer():
    """§2.1: the real DNS answer is classified; only offline tests may override it."""
    for name in ("campaign.py", "py_driver.py", "cr_driver.py"):
        assert "dns_override" not in (campaign.EXPERIMENTS / "campaigns/driver" / name).read_text()
    assert "dns_override" not in (campaign.EXPERIMENTS / "campaigns/baseline/agent.py").read_text()
