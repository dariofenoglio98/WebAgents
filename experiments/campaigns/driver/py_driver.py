"""The `Py` live driver (PROTOCOL.md §2.1): agentpkg composed as `agentpkg converse` (WebAir 0.8.0)
and `agentpkg run` (the travel network, Literature Review) compose it, live, over the campaign
record set.

What is the production composition, unchanged: signature verification against the publisher's key;
`create_handlers` (the real tool handlers); `cli_memory` over a memory folder (the store's two
egress scans active, P-13's scope); `Conversation` / `run_workflow` with the plan's grants, every
declared tool approved, the package's own limits. What is the campaign's: the router is the rung's
route (`routes.CampaignRouter`); the consent host is the run's responder (rule 8); the record folder
is a fresh copy of `records/memory/` per run; observation-only seams record every tool call and
model call; and the host mapping (`hostmap`) moves the dial to the campaign stack.

Each run writes one campaign run record (`record.py`, D-352) into its own directory.
"""

from __future__ import annotations

import asyncio
import shutil
import time
from pathlib import Path

from agentpkg.memory.host import cli_memory
from agentpkg.package import load_package
from agentpkg.signing import verify_package

from campaigns.driver import hostmap, record
from campaigns.driver.json_http import json_http_handlers
from campaigns.driver.responder import Responder, ResponderConsentHost
from campaigns.driver.routes import CampaignRouter, Rung
from campaigns.origin import tls
from campaigns.records import canaries

ROOT = Path(__file__).resolve().parents[3]
PACKAGES = {
    "webair": (
        ROOT / "dist" / "webair-0.8.0.agent.pkg",
        ROOT / "examples/keys/webair-publisher.pub.pem",
    ),
    "travel-network": (
        ROOT / "dist" / "travel-network-0.1.0.agent.pkg",
        ROOT / "examples/keys/travel-network-publisher.pub.pem",
    ),
    "literature-review": (
        ROOT / "dist" / "literature-review-0.2.9.agent.pkg",
        ROOT / "examples/keys/literature-review-publisher.pub.pem",
    ),
}
RECORD_IDS = {
    "person.identity": "mem_c31a0000000000000000000000000001",
    "payment.card": "mem_c31a0000000000000000000000000002",
    "travel.profile": "mem_c31a0000000000000000000000000003",
}
# The capability demo's purchase grants (examples/webair-0.8.0-conversations.json, `purchase`), the
# same on every side; the travel profile only where the arm needs it (F-MEMORY, E4), because a
# granted profile fills an unstated departure and would change W5's `no-departure` truth (D-353).
WEBAIR_GRANTS = {
    "network.webair": "session",
    "model.reasoning": "session",
    "memory.session": "session",
    "compute.fares": "session",
    "memory.travel_profile": "deny",
    "identity.passenger": "session",
    "wallet.payment": "session",
    "booking.simulate_purchase": "once",
    "memory.remember": "session",
}
TRAVEL_GRANTS = {
    "model.reasoning": "session",
    "memory.session": "session",
    "network.webair": "session",
}


def webair_grants(grant_profile: bool) -> tuple[dict, list[str]]:
    grants = dict(WEBAIR_GRANTS)
    memory = [
        f"identity.passenger={RECORD_IDS['person.identity']}",
        f"wallet.payment={RECORD_IDS['payment.card']}",
    ]
    if grant_profile:
        grants["memory.travel_profile"] = "session"
        memory.append(f"memory.travel_profile={RECORD_IDS['travel.profile']}")
    return grants, memory


def prepare_memory(run_dir: Path, profile_insertion: str | None) -> Path:
    """A fresh copy of the record set for one run; F-MEMORY appends its text to the profile body."""
    target = run_dir / "memory"
    shutil.copytree(
        canaries.MEMORY_DIR, target, ignore=shutil.ignore_patterns("memory.key", ".gitignore")
    )
    if profile_insertion is not None:
        path = next((target / "travel.profile").glob("*.md"))
        text = path.read_text()
        marker = "\n<!-- memory.v0 links -->"
        head, _, tail = text.partition(marker)
        path.write_text(head.rstrip("\n") + " " + profile_insertion + "\n" + marker + tail)
    return target


def tool_ids(package) -> dict[str, str]:
    """Binding → the declared tool id (the handlers are keyed by binding)."""
    return {tool["binding"]: tool_id for tool_id, tool in package.tools.items()}


def _recording_handlers(handlers: dict, seam: list, tools: dict[str, str]) -> dict:
    """Observation only: every tool call, its payload and its answer (or that it threw)."""
    wrapped = {}
    for binding, handler in handlers.items():

        async def handle(ctx, payload, _handler=handler, _binding=binding):
            entry = {
                "at": time.time(),
                "binding": _binding,
                "tool": tools.get(_binding, _binding),
                "role": getattr(ctx, "role", None),
                "arguments": payload,
            }
            seam.append(entry)
            try:
                answer = await _handler(ctx, payload)
            except BaseException as exc:
                entry["outcome"] = "threw"
                entry["error"] = type(exc).__name__
                raise
            entry["outcome"] = "answered"
            entry["answer"] = answer
            return answer

        wrapped[binding] = handle
    return wrapped


def _verified(name: str):
    path, key = PACKAGES[name]
    verified = verify_package(path, trusted_key=key)
    package = load_package(path)
    if verified["digest"] != package.digest:
        raise RuntimeError("the package changed between verification and loading")
    return package


def run_webair(
    *,
    turns: list[str],
    rung: Rung,
    run_dir: Path,
    stack,
    responder: Responder,
    fixture_key: str | None,
    grant_profile: bool = False,
    profile_insertion: str | None = None,
    meta: dict,
) -> dict:
    """One WebAir conversation (TS-W, TS-C) on `Py`; returns the campaign run record."""
    from agentpkg.conversation import Conversation

    run_dir.mkdir(parents=True, exist_ok=False)
    package = _verified("webair")
    grants, memory_grants = webair_grants(grant_profile)
    memory_dir = prepare_memory(run_dir, profile_insertion)
    router = CampaignRouter(rung)
    tool_seam: list[dict] = []
    consent_seam: list[dict] = []
    handlers = _recording_handlers(json_http_handlers(package), tool_seam, tool_ids(package))
    host = ResponderConsentHost(responder, consent_seam)
    memory_runs: list = []

    def adapters(turn):
        memory_run, _folder, memory_handlers = cli_memory(
            package,
            mode="live",
            decisions=grants,
            memory_dir=memory_dir,
            memory_grants=memory_grants,
        )
        memory_runs.append(memory_run)
        return {
            "router": router,
            "handlers": {
                **handlers,
                **_recording_handlers(memory_handlers, tool_seam, tool_ids(package)),
            },
            "memory": memory_run,
        }

    conversation = Conversation(
        package,
        grants=grants,
        approved_tools=sorted(package.tools),
        adapters=adapters,
        consent=lambda turn, decisions: host,
    )
    transcript = {
        "schema": "conversation.transcript.v0",
        "turns": [{"message": {"message": text}} for text in turns],
    }
    table = hostmap.mapping(
        stack.hosts,
        stack.ca,
        run_dir / "dials.jsonl",
        fixture_key=fixture_key,
        fixture_hosts=(tls.WEBAIR_HOST,),
    )
    origin_start, sink_start = len(stack.origin_log), len(stack.sink.log)
    started = time.monotonic()
    result, error = None, None
    try:
        with hostmap.install(table):
            result = asyncio.run(conversation.run(transcript))
    except Exception as exc:  # a driver failure: a harness error, in the denominator
        error = f"{type(exc).__name__}: {exc}"[:500]
    seconds = time.monotonic() - started
    rec = record.from_py_conversation(
        meta=meta,
        rung=rung,
        result=result,
        harness_error=error,
        model_calls=router.calls,
        tool_calls=tool_seam,
        consent=consent_seam,
        responder=responder.decisions,
        dials=hostmap.read_dial_log(run_dir / "dials.jsonl"),
        origin_log=stack.origin_log[origin_start:],
        sink_log=stack.sink.log[sink_start:],
        seconds=seconds,
        package=package,
    )
    rec["memory_grants"] = dict(flag.split("=", 1) for flag in memory_grants)
    return record.write(run_dir, rec)


def run_travel_network(
    *, text: str, rung: Rung, run_dir: Path, stack, fixture_key: str | None, meta: dict
) -> dict:
    """One travel-network run (TS-N) on `Py`, composed as `agentpkg run` composes it."""
    from agentpkg.workflow import run_workflow

    run_dir.mkdir(parents=True, exist_ok=False)
    package = _verified("travel-network")
    router = CampaignRouter(rung)
    tool_seam: list[dict] = []
    memory_run, _folder, memory_handlers = cli_memory(
        package, mode="live", decisions=TRAVEL_GRANTS, memory_dir=None, memory_grants=()
    )
    handlers = _recording_handlers(
        {**json_http_handlers(package), **memory_handlers}, tool_seam, tool_ids(package)
    )
    table = hostmap.mapping(
        stack.hosts,
        stack.ca,
        run_dir / "dials.jsonl",
        fixture_key=fixture_key,
        fixture_hosts=(tls.WEBAIR_HOST,),
    )
    origin_start, sink_start = len(stack.origin_log), len(stack.sink.log)
    started = time.monotonic()
    result, error = None, None
    try:
        with hostmap.install(table):
            result = asyncio.run(
                run_workflow(
                    package,
                    {"text": text},
                    grants=TRAVEL_GRANTS,
                    handlers=handlers,
                    router=router,
                    approved_tools=sorted(package.tools),
                    memory=memory_run,
                )
            )
    except Exception as exc:
        report = getattr(exc, "execution_report", None)
        if report is not None:
            result = report
        else:
            error = f"{type(exc).__name__}: {exc}"[:500]
    seconds = time.monotonic() - started
    return record.write(
        run_dir,
        record.from_py_workflow(
            meta=meta,
            rung=rung,
            result=result,
            harness_error=error,
            model_calls=router.calls,
            tool_calls=tool_seam,
            dials=hostmap.read_dial_log(run_dir / "dials.jsonl"),
            origin_log=stack.origin_log[origin_start:],
            sink_log=stack.sink.log[sink_start:],
            seconds=seconds,
            package=package,
        ),
    )
