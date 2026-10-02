"""One case's result record, and the append-only files records live in.

A record says what was expected (from the catalog, before the run) and what
was observed (from the oracle), and carries just enough evidence to re-judge
an unexpected outcome without re-running it. It never carries a prompt, a
model's text, a key, or an absolute local path: free-text fields are scrubbed
of the case directory and the home directory before they are written.
"""

from __future__ import annotations

import contextlib
import json
import os
import re
from pathlib import Path

from . import oracle
from .paths import EXPERIMENT_VERSION, PACKAGES, ROOT, sha256_bytes

HOME = str(Path.home())
EVIDENCE_LIMIT = 40


def scrub(value, case_dir: str | None = None):
    """Replace local paths in free text with stable placeholders."""
    if isinstance(value, str):
        text = value
        if case_dir:
            text = text.replace(case_dir, "<case>")
        text = text.replace(str(ROOT), "<repo>")
        text = text.replace(HOME, "~")
        text = re.sub(r"/(?:private/)?(?:var|tmp)/[^\s'\"]*", "<tmp>", text)
        return text
    if isinstance(value, list):
        return [scrub(item, case_dir) for item in value]
    if isinstance(value, dict):
        return {key: scrub(item, case_dir) for key, item in value.items()}
    return value


def _codes_match(refusal, expected) -> bool | None:
    if refusal is None:
        return None
    return refusal.code in expected or (refusal.check or "") in expected


def make_record(
    entry: dict,
    template,
    profile: str,
    plan,
    obs: dict,
    verdict,
    *,
    case_dir: str,
    run: dict | None = None,
) -> dict:
    """`run` carries the run's identity: run_id, seed, shard and the case's sequence in it."""
    run = run or {}
    kind = entry["kind"]
    refusal = verdict.refusal
    recognized = refusal is not None and refusal.recognized
    explicit = verdict.outcome == oracle.EXPLICIT_BLOCK
    canaries = oracle.canaries(obs)
    helper = obs.get("helper") or {}
    guard = helper.get("guard") or {}
    broker = helper.get("broker_calls") or []
    record = {
        "key": f"{profile}::{entry['case_id']}",
        "run_id": run.get("run_id"),
        "experiment_version": EXPERIMENT_VERSION,
        "seed": run.get("seed"),
        "shard": run.get("shard"),
        "sequence": run.get("sequence"),
        "profile": profile,
        "case_id": entry["case_id"],
        "kind": kind,
        "template_id": entry["template_id"],
        "family": template.family,
        "package": entry["package"],
        "package_id": PACKAGES[entry["package"]]["package_id"],
        "package_version": PACKAGES[entry["package"]]["version"],
        "variant_id": entry["variant_id"],
        "control_id": entry["control_id"],
        # The structural perturbation, as the catalog generated it (never a payload).
        "mutation": {
            "description": entry["description"],
            "params": entry["params"] if kind == "violation" else entry["control_params"],
        },
        "outcome": verdict.outcome,
        "forbidden_boundary_reached": verdict.boundary_reached,
        "detected_after_boundary": verdict.detected_after_boundary,
        "completed": verdict.completed,
        "fault_fired": verdict.fault_fired,
        "harness_problems": list(verdict.harness),
        "refusal": scrub(refusal.as_json(), case_dir) if refusal is not None else None,
        "expected_component": template.component,
        "expected_stage": template.expected_stage,
        "expected_codes": list(template.expected_codes),
        "observed_component": refusal.component if recognized else None,
        "observed_stage": refusal.stage if recognized else None,
        "stage_match": (refusal.stage == template.expected_stage)
        if (explicit and kind == "violation")
        else None,
        "component_match": (refusal.component == template.component)
        if (explicit and kind == "violation")
        else None,
        "code_match": _codes_match(refusal, template.expected_codes)
        if (explicit and kind == "violation")
        else None,
        "archive_sha256": sha256_bytes(plan.archive),
        "canaries": canaries.summary() if canaries is not None else None,
        "broker": {"calls": len(broker), "served": sum(1 for call in broker if call.get("ok"))},
        "guards": {
            "python_refused": len(obs.get("python_guard") or []),
            "python_sensitive": len(obs.get("python_sensitive") or []),
            "node_refused": len(guard.get("refused") or []),
            "node_fs_sensitive": len(guard.get("fs_sensitive") or []),
            "node_dns_lookups": len(guard.get("dns_lookups") or []),
        },
        "steps": [
            item["step"] + ("" if item.get("ok") else "!") for item in obs.get("trace") or []
        ],
        "run": {
            "status": (obs.get("run_record") or {}).get("status"),
            "error_code": (obs.get("run_record") or {}).get("errorCode"),
            "workflow_status": obs.get("workflow_status"),
            "workflow_error": obs.get("workflow_error"),
        },
        "faults_fired": [
            {
                key: value
                for key, value in fired.items()
                if key in ("where", "task", "kind", "tool", "hostname")
            }
            for fired in obs.get("faults_fired") or []
        ][:EVIDENCE_LIMIT],
        "elapsed_ms": obs.get("elapsed_ms"),
    }
    expected_outcome = oracle.EXPLICIT_BLOCK if kind == "violation" else oracle.BENIGN_ACCEPT
    if verdict.outcome != expected_outcome or (explicit and record["stage_match"] is False):
        record["evidence"] = evidence(obs, case_dir)
    return record


def evidence(obs: dict, case_dir: str) -> dict:
    """What an unexpected outcome needs for inspection (no prompts, no model text)."""
    helper = obs.get("helper") or {}
    return scrub(
        {
            "page_errors": (obs.get("page_errors") or [])[:EVIDENCE_LIMIT],
            "control_errors": [
                {
                    key: item.get(key)
                    for key in (
                        "route",
                        "code",
                        "status",
                        "blocking_reasons",
                        "stale_reasons",
                        "validation",
                        "validation_errors",
                        "message",
                    )
                }
                for item in (obs.get("control_errors") or [])[:EVIDENCE_LIMIT]
            ],
            "control_crashes": (obs.get("control_crashes") or [])[:EVIDENCE_LIMIT],
            "receipt_blocking": obs.get("receipt_blocking"),
            "preflight_before_start": obs.get("preflight_before_start"),
            "start_errors": (helper.get("start_errors") or [])[:EVIDENCE_LIMIT],
            "warnings": (helper.get("warnings") or [])[:EVIDENCE_LIMIT],
            "events": [
                {key: value for key, value in event.items() if key not in ("data",)}
                for event in (obs.get("events") or [])[:EVIDENCE_LIMIT]
            ],
            "audit": (obs.get("audit") or [])[-EVIDENCE_LIMIT:],
            "runner_begin": obs.get("runner_begin"),
            "runner_run": {
                key: value
                for key, value in (obs.get("runner_run") or {}).items()
                if key != "output"
            },
            "broker_calls": (helper.get("broker_calls") or [])[:EVIDENCE_LIMIT],
            "model_calls": [
                {
                    key: call.get(key)
                    for key in (
                        "index",
                        "task",
                        "item",
                        "requested_model",
                        "executed_model",
                        "max_tokens",
                        "fault",
                        "completed",
                        "error",
                        "mutation_schema_valid",
                    )
                }
                for call in (oracle.model_dispatches(obs))[:EVIDENCE_LIMIT]
            ],
            "transports": oracle.transports(obs)[:EVIDENCE_LIMIT],
            "anomalies": (
                oracle.canaries(obs).anomalies if oracle.canaries(obs) is not None else []
            )[:EVIDENCE_LIMIT],
            "committed_nodes": sorted(oracle.committed_nodes(obs)),
            "rpc_failures": (obs.get("rpc_failures") or [])[:EVIDENCE_LIMIT],
            "python_guard": (obs.get("python_guard") or [])[:EVIDENCE_LIMIT],
            "node_guard": helper.get("guard"),
            "artifacts": obs.get("artifacts"),
        },
        case_dir,
    )


# -- append-only JSON lines -------------------------------------------------------------------
def repair(path: Path) -> None:
    """Drop a trailing partial line left by an interrupted write."""
    if not path.exists():
        return
    data = path.read_bytes()
    if data and not data.endswith(b"\n"):
        cut = data.rfind(b"\n") + 1
        with open(path, "r+b") as stream:
            stream.truncate(cut)


def append(path: Path, record: dict) -> None:
    line = json.dumps(record, sort_keys=True, ensure_ascii=False, default=str) + "\n"
    with open(path, "a", encoding="utf-8") as stream:
        stream.write(line)
        stream.flush()
        os.fsync(stream.fileno())


def read(path: Path) -> list[dict]:
    records = []
    if not path.exists():
        return records
    with open(path, encoding="utf-8") as stream:
        for line in stream:
            line = line.strip()
            if not line:
                continue
            with contextlib.suppress(ValueError):
                records.append(json.loads(line))
    return records
