"""The well-behaved run, measured once before any case is generated.

Several templates corrupt *one* answer of one model call or tool. Which
locations exist in that answer (an optional field that is present, a list that
is not empty) is a property of the benign run, not of the schema, so those
templates are derived from a calibration: both packages, the full system, the
synthetic model and services, no fault. The calibration records, per model
task, the output schema the production router sent and the well-behaved answer
for each map item, and, for Literature Review, which papers the run selected.
It records no request and no prompt.

A violation derived from the calibration is checked to be one (the corrupted
answer must fail the router's own schema) and a control to be benign (its
answer must still pass) before either enters the catalog; the provider checks
both again at run time, so a case that does not inject what it claims can
never be scored.

Two values in the recorded answers are generated per run by the production
path itself: the Crossref adapter's `retrieved_at` timestamps (wall clock) and
the selected-file capability id (random). They are replaced by fixed
placeholders of the same form, so the calibration, and therefore the catalog,
is a function of the seed and the artifacts only.
"""

from __future__ import annotations

import hashlib
import json
import re
from pathlib import Path

from harness import oracle
from harness.synthetic import BY_DOI, PDF_PAPER

PACKAGE_ORDER = ("meeting-agenda", "literature-review")


FIXED_TIMESTAMP = "2026-01-01T00:00:00.000Z"
FIXED_FILE_ID = "file_" + "0" * 32
FILE_ID = re.compile(r"^file_[0-9a-f]{32}$")


def stable(value):
    """`value` with the run-specific timestamps and capability ids replaced."""
    if isinstance(value, dict):
        return {
            key: FIXED_TIMESTAMP
            if key == "retrieved_at" and isinstance(item, str)
            else stable(item)
            for key, item in value.items()
        }
    if isinstance(value, list):
        return [stable(item) for item in value]
    if isinstance(value, str) and FILE_ID.match(value):
        return FIXED_FILE_ID
    return value


class CalibrationError(RuntimeError):
    """The benign run was not accepted, so nothing can be derived from it."""


def task_map(files: dict[str, bytes]) -> dict[str, dict]:
    """task -> the node that asks for it, its output schema, and whether it is a map step."""
    graph = json.loads(files["graph.json"])
    tasks: dict[str, dict] = {}
    for node in graph["nodes"]:
        if node["type"] == "llm":
            tasks[node["task"]] = {
                "node": node["id"],
                "schema_path": node["output_schema"],
                "map": False,
            }
        elif node["type"] == "map":
            for step in node["steps"]:
                if step["type"] == "llm":
                    tasks[step["task"]] = {
                        "node": node["id"],
                        "schema_path": step["output_schema"],
                        "map": True,
                    }
    return tasks


def summarize(package: str, files: dict[str, bytes], obs: dict) -> dict:
    tasks = task_map(files)
    found: dict[str, dict] = {}
    for call in oracle.model_dispatches(obs):
        task = call["task"]
        if task not in tasks or "answer" not in call:
            continue
        entry = found.setdefault(
            task, {**tasks[task], "schema": call.get("schema"), "answers": {}, "items": []}
        )
        item = call.get("item", "")
        if item not in entry["answers"]:
            entry["answers"][item] = stable(call["answer"])
            entry["items"].append(item)
    for entry in found.values():
        entry["items"] = sorted(entry["items"])
    summary: dict = {"tasks": found, "usage": usage_of(obs), "caps": output_caps(files)}
    if package == "literature-review":
        selected = (found.get("select") or {}).get("answers", {}).get("", []) or []
        plan = (found.get("plan") or {}).get("answers", {}).get("", {}) or {}
        summary["selected"] = [
            {
                "paper_id": paper.get("paper_id"),
                "doi": paper.get("doi"),
                "resolver": BY_DOI[paper["doi"]].resolver if paper.get("doi") in BY_DOI else None,
                "has_document": paper.get("doi") == PDF_PAPER.doi,
            }
            for paper in selected
        ]
        normalized = (found.get("normalize") or {}).get("answers", {}).get("", {}) or {}
        summary["candidates"] = [
            {"paper_id": paper.get("paper_id"), "doi": paper.get("doi")}
            for paper in normalized.get("candidate_papers", [])
        ]
        summary["search_queries"] = list(plan.get("queries") or [])
    return summary


def usage_of(obs: dict) -> dict:
    """What the benign run consumed, from the runtime's own audit (budget.updated events)."""
    peak = 0
    reservations = []
    used: dict[str, int] = {}
    worker_need: dict[str, int] = {}
    role_of: dict[str, str] = {}
    role_first: dict[str, int] = {}
    for event in obs.get("audit_raw") or []:
        action = event.get("action")
        worker = event.get("worker")
        if action == "budget.updated" and "tokens" in event:
            peak = max(peak, int(event.get("tokens", 0)) + int(event.get("reserved_tokens", 0)))
        if action == "model.called":
            reserved = int(event.get("reserved_tokens", 0))
            reservations.append(reserved)
            role_of[worker] = event.get("role")
            role_first.setdefault(event.get("role"), reserved)
            # What this worker instance must be allowed: everything it used before, plus this hold.
            worker_need[worker] = max(worker_need.get(worker, 0), used.get(worker, 0) + reserved)
        if action in ("model.completed", "model.failed"):
            used[worker] = used.get(worker, 0) + int(
                event.get("tokens", event.get("tokens_charged", 0)) or 0
            )
    role_need: dict[str, int] = {}
    for worker, need in worker_need.items():
        role = role_of[worker]
        role_need[role] = max(role_need.get(role, 0), need)
    remote_tools = {"scholarly-search", "citation-resolver"}
    per_instance: dict[str, int] = {}
    instance_role: dict[str, str] = {}
    for event in obs.get("audit_raw") or []:
        if event.get("action") == "tool.called" and event.get("tool") in remote_tools:
            per_instance[event.get("worker")] = per_instance.get(event.get("worker"), 0) + 1
            instance_role[event.get("worker")] = event.get("role")
    role_remote_need: dict[str, int] = {}
    for worker, count in per_instance.items():
        role = instance_role[worker]
        role_remote_need[role] = max(role_remote_need.get(role, 0), count)
    usage = ((obs.get("runner_run") or {}).get("usage")) or {}
    tool_calls = {}
    for event in oracle.audit_actions(obs, "tool.called"):
        tool_calls[event.get("tool")] = tool_calls.get(event.get("tool"), 0) + 1
    return {
        "tokens": int(usage.get("tokens") or 0),
        "peak_tokens": peak,
        "max_reservation": max(reservations, default=0),
        "first_reservation": reservations[0] if reservations else 0,
        "model_calls": len(reservations),
        "role_first_reservation": role_first,
        "role_need": role_need,
        "role_remote_need": role_remote_need,
        "remote_calls": int(usage.get("remote_calls") or 0),
        "tool_calls": tool_calls,
    }


def output_caps(files: dict[str, bytes]) -> dict:
    """The output cap each model operation declares (`max_output_tokens`)."""
    graph = json.loads(files["graph.json"])
    caps = {}
    for node in graph["nodes"]:
        if node["type"] == "llm":
            caps[node["id"]] = node["max_output_tokens"]
        for step in node.get("steps") or []:
            if step["type"] == "llm":
                caps[f"{node['id']}/{step['id']}"] = step["max_output_tokens"]
    return caps


async def calibrate(helper, env, root: Path, *, probe=None, guard=None) -> dict:
    """Run both packages once, benignly, on the profile `helper` was built for."""
    from harness.pipeline import run_case

    from .base import base_plan, payload

    result: dict = {"packages": {}}
    for index, package in enumerate(PACKAGE_ORDER):
        plan = base_plan(env, package)
        plan.record_answers = True
        obs = await run_case(
            plan, helper, Path(root) / f"calibration-{index}", probe=probe, guard=guard
        )
        verdict = oracle.judge("control", obs, lambda _obs: False)
        if verdict.outcome != oracle.BENIGN_ACCEPT:
            raise CalibrationError(
                f"{package}: benign run was {verdict.outcome}: {verdict.as_json()}"
            )
        result["packages"][package] = summarize(package, payload(env, package), obs)
    result["sha256"] = digest(result)
    return result


def digest(calibration: dict) -> str:
    body = {key: value for key, value in calibration.items() if key != "sha256"}
    return hashlib.sha256(
        json.dumps(body, sort_keys=True, separators=(",", ":")).encode()
    ).hexdigest()


def load(path: Path) -> dict:
    calibration = json.loads(Path(path).read_text())
    if calibration.get("sha256") != digest(calibration):
        raise CalibrationError(f"{path}: calibration digest does not match its content")
    return calibration
