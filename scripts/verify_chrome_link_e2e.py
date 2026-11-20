#!/usr/bin/env python3
"""Agent Links in the Chrome Agent Browser (T66, link.v0): recompute the headless run from its files.

    agentpkg/.venv/bin/python scripts/verify_chrome_link_e2e.py \\
        --report examples/verification/chrome-link-e2e.json

Reads the harness's report (`chrome-agent-browser/scripts/e2e-link.mjs`) and the directories it
wrote (the four run exports, the reference's fixture run of the planner 0.1.0, the request logs
inside the report) and rewrites the report with a `link_verification` section. Everything is
recomputed with agentpkg's own code from the files, never taken from what the harness or the
extension concluded:

* each export is a complete record and `scripts/verify_link_run.py` passes on it as it passes on a
  reference record (the chains, the pinned packages, the composed bound recomputed from the signed
  declarations with a denied link left out and a slot at its ceiling, every observed figure inside
  it, each inner run inside its reservation and on its own declared hosts, a join's inner plan
  hash-bound to the caller's plan, this run and the slot);
* the plan the extension froze (`run-plan.json`) states that recomputed bound, records each link
  with the person's decision, and each accepted link's inner Run Plan (`link-plan-<id>.json`)
  names this caller and that dependency and has the hash the caller's plan and the record state;
* the planned run holds the same link events in the same order as the reference's fixture run of
  the same archive, with the same composed bound;
* the denied run started no inner run of the denied publisher and no request reached its origin;
* the delegation view the page drew (the report's `tree`) is the fold of the export's audit;
* at the slot: nothing but two GETs reached the hotel before the decision, no model request
  before it was a request-building call or held the candidate's description, the decision is the
  person's, and after it the order is requested, decided, started, completed;
* the signed planner 0.2.0's refusal is the one recorded: the request-building call's
  reservation above `FindHotel`'s own budget, with no raise asked.

Prints one JSON document with `"passed"`; exit status 1 on a failed check.
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "agentpkg" / "src"))

from agentpkg.delegation.analysis import worst_case
from agentpkg.execution.report import verify_audit_chain
from agentpkg.links.analysis import package_worst_case
from agentpkg.package import load_package

SCHEMA = "webagents-verify-chrome-link-e2e-v0"
HOSTS = {
    "webair": "webagents-webair-production.up.railway.app",
    "staymere": "webagents-staymere-production.up.railway.app",
    "salitubam": "webagents-hotel-salitubam-production.up.railway.app",
}
LINKED = {
    "webair-flights": ROOT / "dist" / "webair-flights-0.1.0.agent.pkg",
    "hotel-aggregator": ROOT / "dist" / "staymere-hotels-0.1.0.agent.pkg",
}
EXPORT_FILES = ("run.json", "run-plan.json", "result.json", "audit.json", "usage.json")


class Checks:
    def __init__(self) -> None:
        self.results: list[dict] = []

    def add(self, name: str, passed: bool, detail=None) -> bool:
        entry = {"name": name, "passed": bool(passed)}
        if not passed and detail is not None:
            entry["detail"] = detail
        self.results.append(entry)
        return bool(passed)

    @property
    def failed(self) -> list[str]:
        return [entry["name"] for entry in self.results if not entry["passed"]]


def _json(path: Path):
    return json.loads(path.read_text(encoding="utf-8"))


def _link_events(audit: list[dict]) -> list[list]:
    return [
        [event["action"], event.get("dependency") or event.get("slot")]
        for event in audit
        if event["action"].startswith("link.")
    ]


def _tree(audit: list[dict]) -> list[dict]:
    """The delegation view's fold (`chrome-agent-browser/src/core/links/delegation.ts`), restated:
    each link under the activation that asked it, with the state its last event gives it. An inner
    run is known by its `inner_run_id`; a join by its step and slot until its inner run starts."""
    rows: list[dict] = []
    joins: dict[tuple, list[dict]] = {}
    runs: dict[str, dict] = {}
    role = None

    def new(event, kind, state):
        candidate = event.get("candidate") or {}
        row = {"role": role, "kind": kind, "name": event.get("dependency") or event.get("slot")}
        row["state"] = state
        row["package_id"] = candidate.get("package_id")
        row["accepted"] = None
        row["inner"] = None
        rows.append(row)
        return row

    for event in audit:
        action = event["action"]
        key = (event.get("node_id"), event.get("slot"))
        waiting = joins.setdefault(key, [])
        if action == "network.activated":
            role = event["role"]
        elif action == "link.requested":
            waiting.append(new(event, "join", "looking"))
        elif action == "link.decided":
            row = next((item for item in waiting if item["accepted"] is None), None)
            if row is None:
                row = new(event, "join", "looking")
                waiting.append(row)
            row["accepted"] = event.get("accepted") is True
            if row["accepted"]:
                row["state"] = "working"
            else:
                row["state"] = "declined" if event.get("decided_by") == "person" else "not_joined"
                waiting.remove(row)
        elif action == "link.started":
            row = None
            if "slot" in event:
                row = next((item for item in waiting if item["accepted"] and item["inner"] is None), None)
                if row is not None:
                    waiting.remove(row)
            if row is None:
                row = new(event, "join" if "slot" in event else "link", "working")
            row["state"] = "working"
            row["package_id"] = event["package_id"]
            row["inner"] = event.get("inner_run_id")
            if row["inner"] is not None:
                runs[row["inner"]] = row
        elif action in ("link.completed", "link.failed"):
            inner = event.get("inner_run_id")
            row = runs.pop(inner, None) if inner is not None else None
            if row is None and inner is None and "slot" in event:
                row = next((item for item in waiting if item["accepted"] and item["inner"] is None), None)
                if row is not None:
                    waiting.remove(row)
            if row is None:
                row = new(event, "join" if "slot" in event else "link", "working")
            row["state"] = "answered" if action == "link.completed" else "failed"
    return [
        {name: row[name] for name in ("role", "kind", "name", "state", "package_id")} for row in rows
    ]


def _verify_link_run(directory: Path, package: Path) -> dict:
    done = subprocess.run(
        [sys.executable, str(ROOT / "scripts" / "verify_link_run.py"), str(directory)]
        + ["--package", str(package)],
        capture_output=True,
        text=True,
        check=False,
    )
    try:
        return json.loads(done.stdout)
    except json.JSONDecodeError:
        return {"passed": False, "checks": 0, "error": (done.stderr or done.stdout)[-600:]}


def _export(checks: Checks, label: str, directory: Path, package: Path) -> dict:
    """One export: its files, its chain, the reference verifier's verdict, and the plan's facts."""
    present = all((directory / name).is_file() for name in EXPORT_FILES)
    if not checks.add(f"{label}: the export holds the run's files", present):
        return {}
    audit = _json(directory / "audit.json")
    checks.add(f"{label}: the audit is one valid hash chain", verify_audit_chain(audit)["valid"])
    verdict = _verify_link_run(directory, package)
    checks.add(
        f"{label}: scripts/verify_link_run.py passes on the Chrome export",
        verdict.get("passed") is True,
        verdict.get("error") or verdict.get("failed"),
    )
    caller = load_package(package)
    plan = _json(directory / "run-plan.json")
    record = _json(directory / "links.json")
    planned = plan.get("links") or {}
    costs = {
        name: package_worst_case(
            load_package(LINKED[name]).graph, load_package(LINKED[name]).policy
        )
        if planned[name]["decision"] == "accepted"
        else None
        for name in planned
    }
    bound = worst_case(caller.graph, caller.policy, links=costs)
    stated = plan["execution"]["network"]["worst_case"]
    figures = ("max_hops", "model_calls", "tool_calls", "compute_calls", "remote_calls", "tokens")
    checks.add(
        f"{label}: the plan states the composed bound agentpkg computes from the signed "
        "declarations and the plan's decisions",
        all(stated[name] == bound[name] for name in figures),
        {"plan": {name: stated[name] for name in figures}},
    )
    checks.add(
        f"{label}: the plan is the caller's and records a decision for every dependency",
        plan["package"]["digest"] == caller.digest
        and sorted(planned) == sorted(r["id"] for r in caller.manifest["dependencies"]),
    )
    recorded = {link["dependency"]: link for link in record["links"]}
    inner_ok = True
    for name, entry in planned.items():
        inner_path = directory / f"link-plan-{name}.json"
        if entry["decision"] != "accepted":
            inner_ok &= entry["plan_hash"] is None and not inner_path.exists()
            inner_ok &= recorded[name]["decision"] == "denied"
            continue
        inner = _json(inner_path)
        linked = load_package(LINKED[name])
        inner_ok &= (
            inner["run_plan_sha256"] == entry["plan_hash"] == recorded[name]["plan_hash"]
            and inner["parent"] == {"package_digest": caller.digest, "dependency": name}
            and inner["package"]["digest"] == linked.digest == entry["digest"]
            and inner["model_binding"]["host_model_id"] == plan["model_binding"]["host_model_id"]
        )
    checks.add(
        f"{label}: each accepted link's inner Run Plan names this caller and that dependency, "
        "is on the caller's model, and has the hash the plan and the record state; a denied "
        "link has none",
        bool(inner_ok),
    )
    return {
        "directory": str(directory.relative_to(ROOT)),
        "verify_link_run": {
            "passed": verdict.get("passed"),
            "checks": verdict.get("checks"),
            "status": verdict.get("status"),
            "at_most": verdict.get("at_most"),
            "observed": verdict.get("observed"),
        },
        "link_events": _link_events(audit),
        "decisions": {name: entry["decision"] for name, entry in sorted(planned.items())},
    }


def verify(report: dict) -> dict:
    checks = Checks()
    out = ROOT / report["outputDirectory"]
    planned = report["scenarios"]["planned"]
    join = report["scenarios"]["join"]
    model = report["requests"]["model"]
    origin = report["requests"]["origins"]
    planner_010 = ROOT / "dist" / "travel-planner-0.1.0.agent.pkg"
    planner_020 = ROOT / "dist" / "travel-planner-0.2.0.agent.pkg"
    variant = out / "travel-planner-0.2.0-findhotel-6000.agent.pkg"
    checks.add(
        "the harness passed and reports no failure", report["passed"] and not report["failures"]
    )

    exports = {
        "planned": _export(checks, "the planned run", out / "export-planned", planner_010),
        "denied": _export(checks, "the denied run", out / "export-denied", planner_010),
        "signed": _export(checks, "the signed 0.2.0", out / "export-signed", planner_020),
        "variant": _export(checks, "the variant", out / "export-variant", variant),
    }

    # -- the planned run against the reference ----------------------------------------------------
    reference = ROOT / report["referenceDirectory"]
    reference_audit = _json(reference / "audit.json")
    planned_audit = _json(out / "export-planned" / "audit.json")
    checks.add(
        "the planned run holds the reference's link events, in the reference's order",
        _link_events(planned_audit) == _link_events(reference_audit)
        and _link_events(planned_audit)
        == [["link.started", "webair-flights"], ["link.completed", "webair-flights"]]
        + [["link.started", "hotel-aggregator"], ["link.completed", "hotel-aggregator"]],
    )
    started = [e for e in planned_audit if e["action"] == "network.started"]
    reference_started = [e for e in reference_audit if e["action"] == "network.started"]
    # The seconds are the run's own effective deadline: the extension's run limit lowers them.
    without_seconds = lambda bound: {k: v for k, v in bound.items() if k != "seconds"}  # noqa: E731
    checks.add(
        "the planned run's stated bound is the reference's in every figure, within a deadline "
        "no longer than the declared one",
        len(started) == 1
        and without_seconds(started[0]["bound"]) == without_seconds(reference_started[0]["bound"])
        and started[0]["bound"]["seconds"] <= reference_started[0]["bound"]["seconds"],
    )
    planned_requests = [item for item in model if item["scenario"] == "A.planned"]
    checks.add(
        "every model request of the planned run matched a fixture case exactly",
        len(planned_requests) == 10
        and all(item["matched"] and not item["improvised"] for item in planned_requests),
    )
    checks.add(
        "the page's delegation view of the planned run is the fold of its audit: two links, "
        "each answered",
        planned["run"]["tree"] == _tree(planned_audit)
        and [row["state"] for row in planned["run"]["tree"]] == ["answered", "answered"],
    )

    # -- the denied run ---------------------------------------------------------------------------
    denied_audit = _json(out / "export-denied" / "audit.json")
    checks.add(
        "the denied run started an inner run of WebAir Flights only",
        _link_events(denied_audit)
        == [["link.started", "webair-flights"], ["link.completed", "webair-flights"]]
        and exports["denied"].get("decisions")
        == {"hotel-aggregator": "denied", "webair-flights": "accepted"},
    )
    checks.add(
        "no request of the denied run reached the denied publisher's origin",
        not [i for i in origin if i["scenario"] == "A.denied" and i["host"] == HOSTS["staymere"]]
        and not any(
            HOSTS["staymere"] in item["url"] for item in planned["denied"]["export"]["observations"]
        ),
    )
    checks.add(
        "no route request of the denied run offered the denied publisher's role",
        all(
            item["offered"] == ["Flights", "Calendar"]
            for item in model
            if item["scenario"] == "A.denied" and item["task"] == "route"
        ),
    )
    checks.add(
        "the page's delegation view of the denied run is the fold of its audit: one link",
        planned["denied"]["tree"] == _tree(denied_audit) and len(planned["denied"]["tree"]) == 1,
    )

    # -- the slot ---------------------------------------------------------------------------------
    for label in ("signed", "variant"):
        run = join[label]
        audit = _json(out / f"export-{label}" / "audit.json")
        before = run["before"]
        checks.add(
            f"{label}: before the decision the hotel was sent two plain GETs and nothing else",
            before["salitubam"] == ["GET /", "GET /agent.pkg"],
        )
        checks.add(
            f"{label}: before the decision no model request was a request-building call or held "
            "the candidate's description",
            all(i["task"] != "request" and not i["mentions"] for i in before["model"]),
        )
        decided = [e for e in audit if e["action"] == "link.decided"]
        card = run["waiting"]["card"]
        checks.add(
            f"{label}: the decision is the person's, on the card of the candidate the audit names",
            len(decided) == 1
            and decided[0]["accepted"] is True
            and decided[0]["decided_by"] == "person"
            and decided[0]["candidate"]["digest"] == card["facts"]["package"]["digest"]
            and decided[0]["candidate"]["signer"] == card["facts"]["publisher"]["signer"],
        )
        checks.add(
            f"{label}: the page's delegation view is the fold of the audit",
            run["tree"] == _tree(audit),
            {"page": run["tree"], "audit": _tree(audit)},
        )
    signed_audit = _json(out / "export-signed" / "audit.json")
    refused = [e for e in signed_audit if e["action"] == "model.refused"]
    find_hotel = next(
        w for w in load_package(planner_020).graph["workers"] if w["id"] == "FindHotel"
    )
    checks.add(
        "the signed planner 0.2.0: the request-building call's reservation is above FindHotel's "
        "own budget, the run fails budget_exhausted, and no raise is asked",
        len(refused) == 1
        and refused[0]["task"] == "request"
        and refused[0]["reason"] == "worker_token_budget"
        and refused[0]["limit"] == find_hotel["budget"]["tokens"]
        and refused[0]["reserved_tokens"]
        == refused[0]["input_bound"] + refused[0]["max_output_tokens"]
        > refused[0]["limit"]
        and _json(out / "export-signed" / "run.json")["errorCode"] == "budget_exhausted"
        and not [e for e in signed_audit if e["action"] == "budget.requested"]
        and not [e for e in signed_audit if e["action"] == "link.started" and "slot" in e],
    )
    variant_audit = _json(out / "export-variant" / "audit.json")
    at_slot = [e["action"] for e in variant_audit if e.get("slot") == "named-hotel"]
    checks.add(
        "the variant: at the slot the audit holds requested, decided, started, completed, in "
        "that order, and the run completed",
        at_slot == ["link.requested", "link.decided", "link.started", "link.completed"]
        and _json(out / "export-variant" / "run.json")["status"] == "completed",
    )
    variant_requests = [item for item in model if item["scenario"] == "B.variant"]
    checks.add(
        "the variant: every model request matched a fixture case exactly, one of them the "
        "request-building call",
        all(item["matched"] and not item["improvised"] for item in variant_requests)
        and [item["task"] for item in variant_requests].count("request") == 1,
    )
    checks.add(
        "the variant: the hotel's own service was called once, after the decision",
        [
            f"{i['method']} {i['path']}"
            for i in origin
            if i["scenario"] == "B.variant" and i["host"] == HOSTS["salitubam"]
        ]
        == ["POST /api/v1/hotel/availability"],
    )
    variant_package = load_package(variant)
    variant_worker = next(w for w in variant_package.graph["workers"] if w["id"] == "FindHotel")
    signed_graph = load_package(planner_020).graph
    variant_graph = json.loads(json.dumps(variant_package.graph))
    next(w for w in variant_graph["workers"] if w["id"] == "FindHotel")["budget"]["tokens"] = (
        find_hotel["budget"]["tokens"]
    )
    checks.add(
        "the variant differs from the signed planner 0.2.0 in FindHotel's token budget and in "
        "nothing else of its program",
        variant_worker["budget"]["tokens"] == report["variant"]["change"]["tokens"]["variant"]
        and variant_graph == signed_graph
        and variant_package.policy == load_package(planner_020).policy
        and variant_package.manifest["dependencies"]
        == load_package(planner_020).manifest["dependencies"],
    )
    return {
        "schema": SCHEMA,
        "exports": exports,
        "checks": len(checks.results),
        "failed": checks.failed,
        "results": checks.results,
        "passed": not checks.failed,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument(
        "--report", type=Path, required=True, help="the harness's report (rewritten)"
    )
    args = parser.parse_args()
    report = _json(args.report)
    verification = verify(report)
    report["link_verification"] = verification
    args.report.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    summary = {key: verification[key] for key in ("schema", "checks", "failed", "passed")}
    print(json.dumps(summary, indent=2))
    return 0 if verification["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
