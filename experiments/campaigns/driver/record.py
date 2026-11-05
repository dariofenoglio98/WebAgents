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
  denials, the ask step's and the budget's), with the reason; `failures`: calls that ran and failed
  (a timeout, an origin or transport error), never counted as a refusal.
- `model_calls`: every request the route received (system and user text) with its outcome and usage.
- `consent`: the cards shown (step, facts, the responder's decision); `proposals`: memory proposals.
- `dials`, `origin_log`, `sink_log`: the transport's records for this run.
- `usage`: tokens in and out, model calls, tool calls, remote calls, seconds.
"""

from __future__ import annotations

import json
from pathlib import Path

from campaigns.tasks.score import from_literature_output, from_webair_result

SCHEMA = "campaign.run.v1"


def write(run_dir: Path, rec: dict) -> dict:
    path = Path(run_dir) / "run.json"
    path.write_text(json.dumps(rec, ensure_ascii=False, indent=1, default=str) + "\n")
    return rec


def harness_only(run_dir: Path, *, meta: dict, rung, error: str) -> dict:
    """The record of a unit whose driver failed before it could write its own (review 1,
    finding 6): a harness error with nothing observed."""
    Path(run_dir).mkdir(parents=True, exist_ok=True)
    rec = {
        "schema": SCHEMA,
        "meta": meta,
        "rung": rung.describe() if rung is not None else None,
        "package": None,
        "status": "harness_error",
        "harness_error": error,
        "turns": [],
        "answer": None,
        "audit": None,
        "tool_calls": [],
        "refused": [],
        "failures": [],
        "model_calls": [],
        "consent": [],
        "responder": [],
        "proposals": [],
        "dials": [],
        "origin_log": [],
        "sink_log": [],
        "usage": _usage([], [], 0.0),
    }
    return write(run_dir, rec)


def _package(package) -> dict | None:
    if package is None:
        return None
    return {
        "package_id": package.manifest["package_id"],
        "version": package.manifest["version"],
        "digest": package.digest,
    }


# A `tool.failed` is a refusal only when a policy layer stopped the call before its handler ran
# (PROTOCOL.md §2.4.2: a scan or policy reason); a timeout, an origin error, a transport error or an
# invalid answer is a failure, recorded apart (`failures`) and never counted as our side refusing.
REFUSAL_ERRORS = frozenset({"PolicyError", "BudgetError", "ConsentError"})
REFUSAL_REASONS = frozenset(
    {
        "sealed_value_egress",
        "sealed_value_not_granted",
        "sealed_value_in_model_request",
        "consent_required",
        "consent_denied",
        # The model's arguments outside the declared input schema: the runtime refuses the call,
        # as Progent's policy (derived from the same schemas) refuses it on `FW`.
        "tool_request_invalid",
    }
)
_KEPT = ("turn", "run_id", "turn_run_id", "pointer", "record_id", "permission")


def refusals_and_failures(audit: list[dict] | None) -> tuple[list[dict], list[dict]]:
    """Our side's refusals and failures from the audit (both cores write the same events).

    Refusals: `permission.checked` with `allowed: false` (the argument scan, consent, a denied
    permission; it names the pointer, never the value), `model.refused`, `network.refused`,
    `turn.refused` (the conversation's whole-turn reservation, as the framework layer's
    `reserve`), and a `tool.failed` whose error or reason is a policy layer's. The `tool.failed`
    that follows a denied permission check for the same tool is the same refusal (merged, not
    counted twice)."""
    refused: list[dict] = []
    failures: list[dict] = []
    pending: dict | None = None  # the last denied check not yet followed by its tool.failed
    for index, event in enumerate(audit or []):
        action = event.get("action")
        if action == "permission.checked" and event.get("allowed") is False:
            entry = {"kind": action, "reason": event.get("reason"), "tool": event.get("tool")}
            entry.update({k: event[k] for k in _KEPT if event.get(k) is not None})
            refused.append({**entry, "audit_index": index})
            pending = refused[-1]
        elif action in ("model.refused", "network.refused", "turn.refused"):
            entry = {"kind": action, "reason": event.get("reason"), "tool": event.get("tool")}
            entry.update({k: event[k] for k in _KEPT if event.get(k) is not None})
            refused.append({**entry, "audit_index": index})
            pending = None
        elif action == "tool.failed":
            reason = event.get("reason") or event.get("error_code")
            error = event.get("error")
            entry = {"kind": action, "reason": reason, "error": error, "tool": event.get("tool")}
            entry.update({k: event[k] for k in _KEPT if event.get(k) is not None})
            if error in REFUSAL_ERRORS or reason in REFUSAL_REASONS:
                if pending is not None and pending.get("tool") == event.get("tool"):
                    pending["error"] = error
                else:
                    refused.append({**entry, "audit_index": index})
            else:
                failures.append({**entry, "audit_index": index})
            pending = None
    return refused, failures


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
    refused, failures = refusals_and_failures(audit)
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
        "refused": refused,
        "failures": failures,
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
    task_set: str = "TS-N",
) -> dict:
    audit = (result or {}).get("audit")
    output = (result or {}).get("output")
    completed = result is not None and result.get("status") == "completed"
    answer = None
    if completed and isinstance(output, dict):
        # TS-N: the plan text; TS-L: the review output mapped onto the campaign answer.
        if task_set == "TS-L":
            answer = from_literature_output(output)
        else:
            answer = {"plan": output.get("plan")}
    refused, failures = refusals_and_failures(audit)
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
        "refused": refused,
        "failures": failures,
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


def from_fw(
    *,
    meta,
    rung,
    port,
    package,
    harness_error,
    turns,
    state,
    model_calls,
    responder,
    origin_log,
    sink_log,
    seconds,
    limits,
    offered,
    memory_grants,
) -> dict:
    """The framework agent's record: no audit; the instrumented tool layer's calls (those that
    reached the executor), its refusals (Progent's denials, the ask step's, the budget's) with
    their arguments, the ask log as `consent`, the executor's dials."""
    # Our runner's rule (V-30): completed when a turn ran and none failed; a turn refused at the
    # conversation's bound is the bound at work, not a failure.
    ran = [t for t in turns if t["status"] != "refused"]
    completed = bool(ran) and all(t["status"] == "completed" for t in ran)
    status = "harness_error" if harness_error else ("completed" if completed else "failed")
    return {
        "schema": SCHEMA,
        "meta": meta,
        "rung": rung.describe(),
        "package": _package(package),
        "port": {"name": port, "offered_tools": offered, "limits": limits},
        "status": status,
        "harness_error": harness_error,
        "turns": turns,
        "answer": turns[-1]["answer"] if turns else None,
        "audit": None,
        "tool_calls": state.tool_calls,
        "refused": state.refused,
        "failures": [c for c in state.tool_calls if c.get("outcome") == "threw"]
        + list(state.unparsed),
        "model_calls": model_calls,
        "consent": state.consent,
        "responder": responder,
        "proposals": [],
        "memory_events": state.memory_events,
        "decoded_arguments": state.decoded,
        "memory_grants": memory_grants,
        "dials": state.dials,
        "origin_log": origin_log,
        "sink_log": sink_log,
        "usage": _usage(model_calls, state.tool_calls, seconds, state.remote_calls),
    }


def _cr_model_call(call: dict) -> dict:
    """An observed request body (the core's adapter) in the record's terms: system and user text."""
    entry = {k: v for k, v in call.items() if k != "body"}
    try:
        body = json.loads(call.get("body") or "{}")
    except ValueError:
        body = {}
    if isinstance(body.get("messages"), list):  # Ollama /api/chat
        # Every message of a role, joined (review 2, nit 10): the (b) scan reads all of them.
        by_role: dict = {}
        for message in body["messages"]:
            if isinstance(message, dict):
                by_role.setdefault(message.get("role"), []).append(
                    str(message.get("content") or "")
                )
        entry.update(
            system="\n".join(by_role["system"]) if "system" in by_role else None,
            user="\n".join(by_role["user"]) if "user" in by_role else None,
        )
    else:  # the Responses API
        entry.update(system=body.get("instructions"), user=body.get("input"))
    # The thinking setting as sent (T31 review 2, nit 12): the core's Ollama adapter sends `think`
    # explicitly; the Responses API takes none.
    entry["think"] = body.get("think")
    return entry


def from_cr_run(*, meta, rung, out, origin_log, sink_log, seconds, package, task_set) -> dict:
    """The `Cr` driver's `run` report (`driver.ts`'s run mode) as the campaign record: the same
    fields as `Py`'s workflow record, read from the core's own report, audit and usage."""
    harness_error = out.get("error") if out.get("status") == "harness_error" else None
    result = None
    if out.get("audit") is not None:
        result = {
            "status": out.get("status"),
            "output": out.get("output"),
            "audit": out.get("audit"),
            "usage": out.get("usage"),
            "error": {"code": out.get("error_code")} if out.get("error_code") else None,
        }

    class _Rung:
        def describe(self):
            return rung.describe() if rung is not None else {"name": "refuse"}

    rec = from_py_workflow(
        meta=meta,
        rung=_Rung(),
        result=result,
        harness_error=harness_error,
        model_calls=[_cr_model_call(c) for c in out.get("model_calls") or []],
        tool_calls=out.get("tool_calls") or [],
        dials=out.get("dials") or [],
        origin_log=origin_log,
        sink_log=sink_log,
        seconds=seconds,
        package=package,
        task_set=task_set,
    )
    rec["core_version"] = out.get("core_version")
    rec["run_plan_sha256"] = out.get("run_plan_sha256")
    rec["files"] = out.get("files")
    return rec


def from_cr_conversation(
    *, meta, rung, out, origin_log, sink_log, seconds, package, memory_grants
) -> dict:
    """The `Cr` driver's report (driver/node/driver.ts) as the campaign record; the same fields
    as `Py`'s, read from the core's own transcript, audit and usage."""
    harness_error = out.get("error") if out.get("status") == "harness_error" else None
    result = None
    if out.get("transcript") is not None:
        result = {
            "status": out.get("status"),
            "transcript": out["transcript"],
            "audit": out.get("audit"),
            "usage": out.get("usage"),
        }

    class _Rung:
        def describe(self):
            return rung.describe() if rung is not None else {"name": "refuse"}

    rec = from_py_conversation(
        meta=meta,
        rung=_Rung(),
        result=result,
        harness_error=harness_error,
        model_calls=[_cr_model_call(c) for c in out.get("model_calls") or []],
        tool_calls=out.get("tool_calls") or [],
        consent=out.get("consent") or [],
        responder=out.get("responder") or [],
        dials=out.get("dials") or [],
        origin_log=origin_log,
        sink_log=sink_log,
        seconds=seconds,
        package=package,
    )
    rec["core_version"] = out.get("core_version")
    rec["memory_grants"] = memory_grants
    return rec
