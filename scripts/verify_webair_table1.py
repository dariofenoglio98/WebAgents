"""Table I evidence for WebAir: one matched local/API pair of live search runs.

    agentpkg/.venv/bin/python scripts/verify_webair_table1.py \\
        [--local RUN_ID] [--api RUN_ID] \\
        [--report examples/verification/webair-030-table1-runs.json]

The paper's end-to-end table (Table I) reports one workflow execution per package and model
binding, read from the Agent Browser's own run records. This script does the same for WebAir
0.3.0. It reads, and never writes, two run records in `~/.openclaw/agent-browser/runs/<id>/`
(`run.json`, `audit.json`, `usage.json`, `search.json`, `fare-rules.json`, `booking.json`),
re-verifies each hash-chained audit, and checks that the two runs are matched: the same signed
archive and task input, the same permission decisions and host-resource grants, the same tool
bindings, limits and public origin, the same path through the graph. Only the host-selected
model may differ.

The metrics use the definitions of the existing Meeting Agenda and Literature Review rows, which
are re-derived from their own run records (`--existing`) as a cross-check:

* model calls: `run.json` `model.calls` (cross-checked against `model.called` audit events);
* external tool calls: tool calls dispatched to a remote binding, i.e. requests to a public
  service (WebAir's API here; Crossref and the Citation Resolver for Literature Review);
* host-resource reads: tool calls dispatched to a local binding (WebAir's travel profile), which
  Table I reports separately rather than mixing them with remote calls;
* peak parallel workers, reported tokens: `usage.peakParallelWorkers`, `usage.tokens`;
* workflow duration: `durationMs` / 1000;
* audit events: `audit.events` (cross-checked against the audit file);
* model cost: `cost.totalUsd`, reported only for a remote model (a local model's provider cost
  is zero and hardware or energy cost is not measured).

The report holds no credential, no host-resource value or label, no model text and no path on
the operator's machine.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

from agentpkg.execution.report import verify_audit_chain  # noqa: E402

RUNS = Path.home() / ".openclaw" / "agent-browser" / "runs"
ARCHIVE = ROOT / "dist/webair-0.3.0.agent.pkg"
DEFAULT_REPORT = ROOT / "examples/verification/webair-030-table1-runs.json"

# The only Qwen3-30B and GPT-5.6 Luna WebAir 0.3.0 search runs that share one Agent Browser
# session, receipt decisions, host resources and task input (2026-10-03).
CANONICAL = {
    "local": "run_8dcfcde45f3344edb7f52d950083a680",
    "api": "run_a3a1337cd6454cc3989ca19ad72b0950",
}
# The run records behind the current Table I rows, for a definition cross-check.
EXISTING = {
    ("meeting-agenda", "local"): "run_34fdabdec10f45d19f60ff33077b9503",
    ("meeting-agenda", "api"): "run_1c2ca9749ead4151b9ddc276271c5604",
    ("literature-review", "local"): "run_322dca7785ba45cca1551243e1a35b23",
    ("literature-review", "api"): "run_a71e5b0fa7574328aa87597ae8882c85",
}
PAPER_TABLE_I = {
    ("meeting-agenda", "local"): (5, 0, 3, 11346, 154.3, 92, None),
    ("meeting-agenda", "api"): (5, 0, 3, 5198, 29.4, 102, 0.0147),
    ("literature-review", "local"): (18, 6, 3, 100352, 1489.8, 572, None),
    ("literature-review", "api"): (18, 6, 3, 68398, 417.6, 678, 0.2005),
}
EXPECTED_FARES = {
    "WA101-20261009-BASIC": 704,
    "WA101-20261009-STANDARD": 858,
    "WA105-20261009-BASIC": 749,
}
EXPECTED_QUERY = {
    "origin": "BOS",
    "destination": "ZRH",
    "date": "2026-10-09",
    "passengers": 1,
    "nonstop_only": True,
    "max_price_usd": 900,
    "cabin": "economy",
}

CHECKS: list[dict] = []


def check(identifier: str, passed: bool, detail=None) -> bool:
    CHECKS.append(
        {"id": identifier, "passed": bool(passed), **({"detail": detail} if detail else {})}
    )
    return bool(passed)


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def canonical(value) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def fingerprint(value) -> str:
    return sha256_bytes(canonical(value).encode())


def load_record(run_id: str) -> dict:
    """One run directory, read only; every file's SHA-256 is kept as provenance."""
    directory = RUNS / run_id
    files = {}
    data = {}
    for name in (
        "run.json",
        "audit.json",
        "usage.json",
        "search.json",
        "fare-rules.json",
        "booking.json",
    ):
        path = directory / name
        if not path.is_file():
            continue
        raw = path.read_bytes()
        files[name] = {"bytes": len(raw), "sha256": sha256_bytes(raw)}
        data[name] = json.loads(raw)
    if "run.json" not in data or "audit.json" not in data:
        raise SystemExit(f"{run_id}: run record incomplete (run.json and audit.json required)")
    return {"run_id": run_id, "files": files, **data}


def metrics(record: dict) -> dict:
    """The Table I quantities of one run, with the definitions in the module docstring."""
    run, audit = record["run.json"], record["audit.json"]
    remote = {tool["toolId"]: tool["remote"] is True for tool in run.get("tools") or []}
    called = [event for event in audit if event["action"] == "tool.called"]
    by_tool = Counter(event["tool"] for event in called)
    external = sum(count for tool, count in by_tool.items() if remote.get(tool) is True)
    local = sum(count for tool, count in by_tool.items() if remote.get(tool) is False)
    model_events = [event for event in audit if event["action"] == "model.called"]
    verdict = verify_audit_chain(audit)
    selected = run["selectedModel"]
    cost = run.get("cost") or {}
    usage = run["usage"]
    return {
        "run_id": run["runId"],
        "status": run["status"],
        "error_code": run.get("errorCode"),
        "created_at": run["createdAt"],
        "model": {
            "host_model_id": selected["hostModelId"],
            "provider_id": selected["providerId"],
            "model_id": selected["modelId"],
            "display_name": selected["displayName"],
            "local": selected["local"],
            "invoked": run["model"]["invoked"],
            "all_calls_used_planned_model": run["model"]["allCallsUsedPlannedModel"],
        },
        "model_calls": run["model"]["calls"],
        "model_calls_in_audit": len(model_events),
        "model_tasks_in_audit": dict(sorted(Counter(e["task"] for e in model_events).items())),
        "external_tool_calls": external,
        "host_resource_reads": local,
        "tool_calls_total": usage["toolCalls"],
        "tool_calls_by_tool": dict(sorted(by_tool.items())),
        "external_call_domains": sorted(
            {domain for event in called for domain in event.get("domains") or []}
        ),
        "peak_parallel_workers": usage["peakParallelWorkers"],
        "reported_tokens": usage["tokens"],
        "workflow_duration_ms": run["durationMs"],
        "workflow_duration_s": round(run["durationMs"] / 1000, 1),
        "audit_events": run["audit"]["events"],
        "audit_events_in_file": len(audit),
        "audit_chain_valid_recorded": run["audit"]["chainValid"],
        "audit_chain_valid_reverified": bool(verdict.get("valid")),
        "audit_final_hash": verdict.get("final_hash"),
        "model_cost_usd": None if selected["local"] else cost.get("totalUsd"),
        "model_cost_status": cost.get("status"),
        "model_cost_note": (
            "local model: no provider charge recorded; hardware and energy cost not measured"
            if selected["local"]
            else "provider-reported cost of every model call"
        ),
        "deadline_exceeded": run.get("deadlineExceeded"),
    }


def matched_fields(record: dict) -> dict:
    """Everything that must be identical across a matched pair, as comparable values."""
    run, audit = record["run.json"], record["audit.json"]
    called = [event for event in audit if event["action"] == "tool.called"]
    return {
        "package": run["package"],
        "task_input_sha256": run["inputSha256"],
        "task_input": run["task"]["input"],
        "attachments": run["task"]["attachments"],
        "decisions": run["grants"]["decisions"],
        "granted_permission_ids": run["grants"]["grantedPermissionIds"],
        "runtime_grant_scopes": audit[0].get("grant_scopes"),
        "resource_grants": run.get("resources") or [],
        "tool_bindings": [
            {k: tool[k] for k in ("toolId", "bindingId", "bindingSha256", "remote")}
            for tool in run["tools"]
        ],
        "host_limits": run["limits"],
        "package_budget_limits": run["usage"]["limits"],
        "host_runtime": run["host"],
        "agent_browser_session": run["sessionId"],
        "tool_call_sequence": [
            {
                k: event.get(k)
                for k in ("node_id", "tool", "binding", "permissions", "domains", "input_hash")
            }
            for event in called
        ],
        "completed_nodes": run["progress"]["completedNodes"],
        "skipped_nodes": run["progress"]["skippedNodes"],
        "live_search_answer_sha256": record["files"].get("search.json", {}).get("sha256"),
        "live_fare_rules_answer_sha256": record["files"].get("fare-rules.json", {}).get("sha256"),
    }


def sanitized_grants(run: dict) -> list[dict]:
    return [
        {
            "permission": grant["permissionId"],
            "type": grant["resourceType"],
            "resource_id": grant["resourceId"],
            "digest_prefix": grant["resourceDigest"][:12],
        }
        for grant in run.get("resources") or []
    ]


def outcome(record: dict) -> dict:
    search = record.get("search.json") or {}
    booking = record.get("booking.json") or {}
    fares = {}
    for flight in search.get("flights") or []:
        for fare in flight.get("fares") or []:
            fares[fare["fare_id"]] = fare["price_usd"]
    return {
        "search_query": search.get("query"),
        "fares_returned": dict(sorted(fares.items())),
        "booking": booking.get("booking"),
        "purchase": booking.get("purchase"),
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--local", default=CANONICAL["local"])
    parser.add_argument("--api", default=CANONICAL["api"])
    parser.add_argument("--report", type=Path, default=DEFAULT_REPORT)
    parser.add_argument(
        "--no-existing",
        action="store_true",
        help="skip re-deriving the existing Meeting Agenda / Literature Review rows",
    )
    args = parser.parse_args()

    archive = ARCHIVE.read_bytes()
    archive_sha256 = sha256_bytes(archive)
    records = {"local": load_record(args.local), "api": load_record(args.api)}
    rows = {binding: metrics(record) for binding, record in records.items()}
    fields = {binding: matched_fields(record) for binding, record in records.items()}

    # -- the artifact ---------------------------------------------------------------
    for binding, record in records.items():
        package = record["run.json"]["package"]
        check(
            f"{binding}_package_is_webair_030",
            package["packageId"] == "org.webagents.webair" and package["version"] == "0.3.0",
        )
        check(
            f"{binding}_archive_is_the_committed_artifact",
            package["archiveSha256"] == archive_sha256,
            {"run": package["archiveSha256"], "dist/webair-0.3.0.agent.pkg": archive_sha256},
        )

    # -- each run on its own ------------------------------------------------------------
    for binding, row in rows.items():
        check(f"{binding}_completed", row["status"] == "completed" and row["error_code"] is None)
        check(
            f"{binding}_audit_chain_valid",
            row["audit_chain_valid_recorded"] and row["audit_chain_valid_reverified"],
        )
        check(
            f"{binding}_audit_event_count_agrees",
            row["audit_events"] == row["audit_events_in_file"],
        )
        check(
            f"{binding}_model_calls_agree_with_audit",
            row["model_calls"] == row["model_calls_in_audit"],
        )
        check(
            f"{binding}_every_call_used_the_planned_model",
            row["model"]["all_calls_used_planned_model"]
            and row["model"]["invoked"] == [row["model"]["host_model_id"]],
        )
        check(
            f"{binding}_tool_calls_split_without_remainder",
            row["external_tool_calls"] + row["host_resource_reads"] == row["tool_calls_total"],
        )
        check(
            f"{binding}_external_calls_reach_only_the_public_webair_origin",
            row["external_call_domains"] == ["webagents-webair-production.up.railway.app"],
        )
        check(f"{binding}_within_deadline", row["deadline_exceeded"] is False)
        result = outcome(records[binding])
        check(
            f"{binding}_search_is_bos_zrh_economy_nonstop_under_900",
            result["search_query"] == EXPECTED_QUERY,
            result["search_query"],
        )
        check(
            f"{binding}_search_returned_the_three_expected_fares",
            result["fares_returned"] == EXPECTED_FARES,
            result["fares_returned"],
        )
        check(
            f"{binding}_no_booking_or_purchase",
            result["booking"] is None and result["purchase"] is None,
        )
    check(
        "local_binding_is_qwen3_30b",
        rows["local"]["model"]["host_model_id"] == "ollama/qwen3:30b"
        and rows["local"]["model"]["local"] is True,
    )
    check(
        "api_binding_is_gpt_5_6_luna",
        rows["api"]["model"]["host_model_id"] == "openai/gpt-5.6-luna"
        and rows["api"]["model"]["local"] is False,
    )

    # -- the pair: everything but the model is the same ---------------------------------
    comparison = {}
    for name in fields["local"]:
        same = fields["local"][name] == fields["api"][name]
        comparison[name] = {"identical": same, "sha256": fingerprint(fields["local"][name])}
        if not same:
            comparison[name]["sha256_api"] = fingerprint(fields["api"][name])
        check(f"pair_identical_{name}", same)
    differing = {
        "host_model": [
            rows["local"]["model"]["host_model_id"],
            rows["api"]["model"]["host_model_id"],
        ],
        "run_plan_sha256": [
            records["local"]["run.json"]["runPlanSha256"],
            records["api"]["run.json"]["runPlanSha256"],
        ],
        "note": (
            "Each Run Plan freezes its model binding, so the two plans differ by construction; "
            "the package, receipt decisions, resource grants and tool bindings they freeze are "
            "the identical fields above."
        ),
    }

    # -- the existing rows, same definitions --------------------------------------------
    existing = {}
    if not args.no_existing:
        for (package, binding), run_id in EXISTING.items():
            if not (RUNS / run_id / "run.json").is_file():
                existing[f"{package}/{binding}"] = {"run_id": run_id, "available": False}
                continue
            row = metrics(load_record(run_id))
            paper = PAPER_TABLE_I[(package, binding)]
            derived = (
                row["model_calls"],
                row["external_tool_calls"],
                row["peak_parallel_workers"],
                row["reported_tokens"],
                row["workflow_duration_s"],
                row["audit_events"],
                None if row["model_cost_usd"] is None else round(row["model_cost_usd"], 4),
            )
            existing[f"{package}/{binding}"] = {
                "run_id": run_id,
                "available": True,
                "package_version": load_record(run_id)["run.json"]["package"]["version"],
                "model": row["model"]["host_model_id"],
                "derived": dict(
                    zip(
                        (
                            "model_calls",
                            "external_tool_calls",
                            "peak_parallel_workers",
                            "reported_tokens",
                            "workflow_duration_s",
                            "audit_events",
                            "model_cost_usd",
                        ),
                        derived,
                        strict=True,
                    )
                ),
                "host_resource_reads": row["host_resource_reads"],
                "matches_paper_table_i": derived == paper,
            }
            check(
                f"existing_row_{package}_{binding}_matches_paper_definitions",
                derived == paper,
                {"derived": derived, "paper": paper},
            )

    table = []
    for binding in ("local", "api"):
        row = rows[binding]
        table.append(
            {
                "package": "WebAir",
                "binding": "Local" if binding == "local" else "API",
                "model": "Qwen3-30B" if binding == "local" else "GPT-5.6 Luna",
                "host_model_id": row["model"]["host_model_id"],
                "model_calls": row["model_calls"],
                "external_tool_calls": row["external_tool_calls"],
                "host_resource_reads": row["host_resource_reads"],
                "peak_parallel_workers": row["peak_parallel_workers"],
                "reported_tokens": row["reported_tokens"],
                "workflow_duration_s": row["workflow_duration_s"],
                "audit_events": row["audit_events"],
                "model_cost_usd": None
                if row["model_cost_usd"] is None
                else round(row["model_cost_usd"], 4),
            }
        )

    report = {
        "profile": "webair-table1-runs-v0",
        "purpose": (
            "The canonical WebAir 0.3.0 rows of the paper's end-to-end table (Table I): one "
            "profile-assisted search, run unchanged under a local and an API model binding."
        ),
        "command": "agentpkg/.venv/bin/python scripts/verify_webair_table1.py",
        "notice": "WebAir is a fictional airline. No real booking, payment or transaction occurs.",
        "package": {
            "artifact": "dist/webair-0.3.0.agent.pkg",
            "package_id": "org.webagents.webair",
            "version": "0.3.0",
            "archive_sha256": archive_sha256,
            "archive_bytes": len(archive),
            "package_digest": records["local"]["run.json"]["package"]["digest"],
        },
        "task": {
            "input": records["local"]["run.json"]["task"]["input"],
            "input_sha256": records["local"]["run.json"]["inputSha256"],
            "note": (
                "The request as typed in the Agent Browser for both runs, including its leading "
                "space. The search reads the host travel profile for what the request leaves "
                "unstated (origin, cabin, nonstop)."
            ),
        },
        "authorization": {
            "decisions": {
                item["permissionId"]: item["decision"]
                for item in records["local"]["run.json"]["grants"]["decisions"]
            },
            "resource_grants": sanitized_grants(records["local"]["run.json"]),
            "note": (
                "Both runs ran under one Agent Browser session's authorization, which allowed all "
                "seven declared permissions for the session and selected one resource of each "
                "host-resource type. The search path read only the travel profile: the passenger, "
                "payment, quote and purchase nodes were skipped and their tools made no call. "
                "This is broader consent than a search needs (the accepted demo search in "
                "webair-030-live-demo.json denies the identity, payment and purchase permissions); "
                "it is identical across the two runs."
            ),
        },
        "table_i_rows": table,
        "runs": {
            binding: {
                **rows[binding],
                "resource_grants": sanitized_grants(records[binding]["run.json"]),
                "outcome": outcome(records[binding]),
                "source": {
                    "run_record": f"agent-browser run record {records[binding]['run_id']}",
                    "files": records[binding]["files"],
                },
            }
            for binding in ("local", "api")
        },
        "pair_comparison": {"identical_fields": comparison, "differing_by_design": differing},
        "existing_table_i_rows": existing,
        "checks": CHECKS,
        "passed": all(item["passed"] for item in CHECKS),
    }
    text = json.dumps(report, indent=2, ensure_ascii=False) + "\n"
    if str(Path.home()) in text:
        raise SystemExit("refusing to write a report containing a local home path")
    args.report.write_text(text, encoding="utf-8")
    failed = [item["id"] for item in CHECKS if not item["passed"]]
    passed = len(CHECKS) - len(failed)
    print(f"{passed}/{len(CHECKS)} checks passed -> {args.report.relative_to(ROOT)}")
    for name in failed:
        print(f"FAILED: {name}", file=sys.stderr)
    return 0 if not failed else 1


if __name__ == "__main__":
    raise SystemExit(main())
