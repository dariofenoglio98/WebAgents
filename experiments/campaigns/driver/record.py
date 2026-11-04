"""The campaign run record (D-352): one `run.json` per run, the same shape on every side.

The oracle (`oracle/`) reads only this file, so an outcome never depends on which side wrote it
(rule 11). Fields:

- `meta`: run id, side (`Py`, `Cr`, `FW`), task set, task id, phrasing index, arm (family, payload
  id, placement, `injected` | `twin` | `none`), responder, seed.
- `rung`, `package` (id, version, digest; for `FW` the package the port mirrors).
- `status`: `completed`, `failed` (a run the runtime or the agent ended without completing) or
  `harness_error`; `harness_error`: the driver's failure text, or null.
- `turns`: per turn the campaign answer (`tasks/answer.schema.json`; for TS-N `{"plan"}`), the raw
  reply, the status and the error code; `answer`: the last turn's.
- `audit`: our side's audit events (null for `FW`); `tool_calls`: every call that crossed the tool
  seam (ours) or the instrumented tool layer (`FW`): tool, role, arguments, outcome, answer;
  `refused`: the calls a policy layer refused before they ran (ours: from the audit; `FW`: Progent's
  denials and the ask step's), with the reason.
- `model_calls`: every request the route received (system and user text) with its outcome and usage.
- `consent`: the cards shown (step, facts, the responder's decision); `proposals`: memory proposals.
- `dials`, `origin_log`, `sink_log`: the transport's records for this run.
- `usage`: tokens in and out, model calls, tool calls, remote calls, seconds.
"""

from __future__ import annotations

import json
from pathlib import Path

from campaigns.tasks.score import from_webair_result

SCHEMA = "campaign.run.v1"


def write(run_dir: Path, rec: dict) -> dict:
    path = Path(run_dir) / "run.json"
    path.write_text(json.dumps(rec, ensure_ascii=False, indent=1, default=str) + "\n")
    return rec


def _package(package) -> dict | None:
    if package is None:
        return None
    return {
        "package_id": package.manifest["package_id"],
        "version": package.manifest["version"],
        "digest": package.digest,
    }


def _refused_from_audit(audit: list[dict]) -> list[dict]:
    """Our side's refusals (PROTOCOL.md §2.4.2): `tool.failed` with its reason, `permission.checked`
    with `allowed: false`, `model.refused`, `network.refused`."""
    refused = []
    for event in audit or []:
        action = event.get("action")
        if action == "permission.checked" and event.get("allowed") is False:
            refused.append(
                {"kind": action, "reason": event.get("reason"), "tool": event.get("tool")}
            )
        elif action in ("tool.failed", "model.refused", "network.refused"):
            refused.append(
                {
                    "kind": action,
                    "reason": event.get("reason") or event.get("error_code") or event.get("error"),
                    "tool": event.get("tool"),
                }
            )
    return refused


def _usage(
    model_calls: list[dict], tool_calls: list[dict], seconds: float, remote_calls=None
) -> dict:
    return {
        "input_tokens": sum((c.get("usage") or {}).get("input_tokens") or 0 for c in model_calls),
        "output_tokens": sum((c.get("usage") or {}).get("output_tokens") or 0 for c in model_calls),
        "model_calls": len(model_calls),
        "tool_calls": len(tool_calls),
        "remote_calls": remote_calls,
        "seconds": round(seconds, 3),
    }


def _proposals(replies: list) -> list:
    found = []
    for reply in replies:
        if isinstance(reply, dict):
            found.extend(((reply.get("memory_proposals") or {}).get("proposals")) or [])
    return found


def from_py_conversation(
    *,
    meta,
    rung,
    result,
    harness_error,
    model_calls,
    tool_calls,
    consent,
    responder,
    dials,
    origin_log,
    sink_log,
    seconds,
    package,
) -> dict:
    turns = []
    audit = None
    remote = None
    status = "harness_error" if harness_error else "failed"
    if result is not None:
        audit = result.get("audit")
        remote = (result.get("usage") or {}).get("remote_calls")
        status = "completed" if result.get("status") == "completed" else "failed"
        for turn in result["transcript"]["turns"]:
            reply = turn.get("reply")
            turns.append(
                {
                    "turn": turn["turn"],
                    "status": turn["status"],
                    "error_code": turn.get("error_code"),
                    "answer": from_webair_result(reply),
                    "reply": reply,
                }
            )
    return {
        "schema": SCHEMA,
        "meta": meta,
        "rung": rung.describe(),
        "package": _package(package),
        "status": status,
        "harness_error": harness_error,
        "turns": turns,
        "answer": turns[-1]["answer"] if turns else None,
        "audit": audit,
        "tool_calls": tool_calls,
        "refused": _refused_from_audit(audit),
        "model_calls": model_calls,
        "consent": consent,
        "responder": responder,
        "proposals": _proposals([t["reply"] for t in turns]),
        "dials": dials,
        "origin_log": origin_log,
        "sink_log": sink_log,
        "usage": _usage(model_calls, tool_calls, seconds, remote),
    }


def from_py_workflow(
    *,
    meta,
    rung,
    result,
    harness_error,
    model_calls,
    tool_calls,
    dials,
    origin_log,
    sink_log,
    seconds,
    package,
) -> dict:
    audit = (result or {}).get("audit")
    output = (result or {}).get("output")
    completed = result is not None and result.get("status") == "completed"
    answer = {"plan": output.get("plan")} if completed and isinstance(output, dict) else None
    return {
        "schema": SCHEMA,
        "meta": meta,
        "rung": rung.describe(),
        "package": _package(package),
        "status": "harness_error" if harness_error else ("completed" if completed else "failed"),
        "harness_error": harness_error,
        "turns": [
            {
                "turn": 1,
                "status": (result or {}).get("status"),
                "error_code": ((result or {}).get("error") or {}).get("code")
                if isinstance((result or {}).get("error"), dict)
                else None,
                "answer": answer,
                "reply": output,
            }
        ],
        "answer": answer,
        "audit": audit,
        "tool_calls": tool_calls,
        "refused": _refused_from_audit(audit),
        "model_calls": model_calls,
        "consent": [],
        "responder": [],
        "proposals": [],
        "dials": dials,
        "origin_log": origin_log,
        "sink_log": sink_log,
        "usage": _usage(
            model_calls,
            tool_calls,
            seconds,
            ((result or {}).get("usage") or {}).get("remote_calls"),
        ),
    }
