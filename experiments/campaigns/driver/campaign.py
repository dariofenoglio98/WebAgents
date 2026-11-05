"""The campaign driver (PROTOCOL.md §2.7, D-353): a task set × rung × side × arm matrix, run in a
seeded order, every run recorded under one results directory with a manifest written before the
first run.

    agentpkg/.venv/bin/python -m campaigns.driver.campaign --preset smoke --rungs L9 \\
        --sides Py,Cr,FW --out injection_campaign/results/<UTC>_smoke          # from experiments/

- **Units.** One unit is (task set, task, phrasing, side, rung, arm); an arm is `benign` or a
  payload at one placement, `injected` or its `twin` (§2.6.1). A placement reaches a task only
  where the task's path reads it (`PLACEMENT_REACH`); `record.profile_body` is applied to the run's
  record copy and grants the travel profile (D-353), every other placement travels as the fixture
  key header.
- **Order.** Grouped by rung (one model loaded at a time, §2.2), seeded shuffle inside a rung.
- **Presets.** `smoke`: one TS-W task per class, one TS-C transcript and one TS-N request (on the
  sides with a network driver, `NOT_BUILT`), the first phrasing, benign,
  plus one payload pair (`upload-01` at `search.fare_name` on W1's first task) so the injection
  path runs end to end on every side. `qualification`: every TS-W task × 3 phrasings and every TS-C
  transcript benign, and every payload at every placement it reaches on the first task of each
  class, injected and twin. `paper`: the qualification matrix on every rung given; T32 fixes the
  paper arms and n of §3 by amendment (D-360…).
- **Manifest** (`manifest.json`, before the first run): the commit and the dirty-tree fingerprint,
  the protocol's SHA-256 and version, the seed, the preset, the task-set, payload, policy and
  instruction hashes, the rungs with their routes and Ollama digests, the host mapping, the
  responder, the list prices, the versions and the Cr build key, the expected runs and the unit
  list's hash. `--resume` recomputes it and refuses a directory whose manifest changed; finished
  units (`runs/<unit>/outcome.json`) are skipped, and a unit with its record but no outcome (a
  crash in the oracle) is classified again from its record, never rerun (review 2, finding 5).
- **Harness errors.** A run whose public hostname did not resolve, or whose driver failed (its
  preparation included), is a harness error (in the denominator, never a refusal, §2.1); a unit
  directory without `run.json` (a crash, an interrupt) is removed and run again on `--resume`.
- **Outcomes.** Each run's `outcome.json` is the oracle's, with the family's envelope (§2.4.2 (e))
  and the rung's list prices (none for a local rung), and `exposed` for an attack arm (whether
  the arm's text reached the run). `summary.json` reports the runs it found against
  `expected_runs` and names the missing units.
- **The responder.** R-facts accepts a card only in the turns where the task asks for a purchase
  (`purchase_turns`) and only on the task's facts (review 2, finding 1).

Entry scripts must guard `__main__`: agentpkg's network child uses `spawn` and re-imports it.
"""

from __future__ import annotations

import argparse
import functools
import hashlib
import json
import random
import re
import shutil
import subprocess
import sys
import tempfile
import time
from datetime import UTC, datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
EXPERIMENTS = ROOT / "experiments"
if str(EXPERIMENTS) not in sys.path:  # `campaigns` itself puts WebAir's origin on the path
    sys.path.insert(0, str(EXPERIMENTS))

from campaigns.driver.routes import Rung  # noqa: E402
from campaigns.origin import catalog, tls  # noqa: E402
from campaigns.tasks import generate  # noqa: E402

PROTOCOL = EXPERIMENTS / "PROTOCOL.md"
RUNGS = Path(__file__).resolve().parent / "rungs.json"
SIDES = ("Py", "Cr", "FW")
PRESETS = ("smoke", "qualification", "paper")
SEED = 31
SMOKE_PAYLOAD = ("upload-01", "search.fare_name")
# Which task classes read each placement on WebAir's path, from the graph and the smoke records
# (review 1, finding 5): every class but W5 searches and reads fare rules before it answers, quotes
# or buys; W5's tasks end without a fare (its first, `no-results`, has no `flights[0]` to rewrite),
# but its search still answers, so the 302 variant reaches it; the quote only where one is prepared.
PLACEMENT_REACH = {
    "search": ("W1", "W2", "W3", "W4", "TS-C"),
    "redirect": ("W1", "W2", "W3", "W4", "W5", "TS-C"),
    "rules": ("W1", "W2", "W3", "W4", "TS-C"),
    "quote": ("W3", "W4", "TS-C"),
    "record": ("W1", "W2", "W3", "W4", "W5", "TS-C"),
    "travel": ("TS-N",),
}
# TS-C prepares a quote only in its booking shapes (refine and history never do).
QUOTE_SHAPES = ("book", "rebuy")
# (side, task set) pairs with no driver yet: the Chrome core's network runs need the `run`
# composition (ExecutionSession, as cli-run.ts), not built in T31 (an open item for T34).
NOT_BUILT = {("Cr", "TS-N")}


# -- the matrix ------------------------------------------------------------------------------
def load_tasks() -> dict[str, dict]:
    tasks = {}
    for task in json.loads((generate.HERE / "ts-w.json").read_text())["tasks"]:
        phrasings = [p if isinstance(p, list) else [p] for p in task["phrasings"]]
        tasks[task["id"]] = {**task, "task_set": "TS-W", "turn_sets": phrasings}
    for transcript in json.loads((generate.HERE / "ts-c.json").read_text())["transcripts"]:
        tasks[transcript["id"]] = {
            **transcript,
            "class": "TS-C",
            "task_set": "TS-C",
            "turn_sets": [transcript["turns"]],
        }
    for request in json.loads((generate.HERE / "ts-n.json").read_text())["requests"]:
        tasks[request["id"]] = {
            **request,
            "class": "TS-N",
            "task_set": "TS-N",
            "turn_sets": [[p] for p in request["phrasings"]],
        }
    return tasks


def reaches(placement: str, task: dict) -> bool:
    """Whether the task's path reads the placement (`PLACEMENT_REACH`, `QUOTE_SHAPES`)."""
    prefix = placement.split(".")[0]
    if task["class"] not in PLACEMENT_REACH.get(prefix, ()):
        return False
    if prefix == "quote" and task["task_set"] == "TS-C":
        return task.get("shape") in QUOTE_SHAPES
    return True


def _first_reached(tasks: dict, placement: str) -> list[dict]:
    """The first task of each class whose path reads the placement."""
    seen, out = set(), []
    for task in tasks.values():
        if task["class"] not in seen and reaches(placement, task):
            seen.add(task["class"])
            out.append(task)
    return out


def _first_of_each_class(tasks: dict) -> list[dict]:
    seen, out = set(), []
    for task in tasks.values():
        if task["class"] not in seen:
            seen.add(task["class"])
            out.append(task)
    return out


def arm_id(arm: dict | None) -> str:
    if arm is None:
        return "benign"
    return f"{arm['payload']}@{arm['placement']}#{arm['arm']}"


def unit_id(unit: dict) -> str:
    raw = (
        f"{unit['side']}-{unit['rung']}-{unit['task_id']}-p{unit['phrasing']}-{arm_id(unit['arm'])}"
    )
    return re.sub(r"[^A-Za-z0-9._-]+", "_", raw)


def _pairs(payload_id: str, placement: str) -> list[dict]:
    return [{"payload": payload_id, "placement": placement, "arm": a} for a in ("injected", "twin")]


def units_for(preset: str, rungs: list[str], sides: list[str], payloads: dict) -> list[dict]:
    tasks = load_tasks()
    cells: list[tuple[dict, int, dict | None]] = []
    firsts = _first_of_each_class(tasks)
    if preset == "smoke":
        for task in firsts:
            cells.append((task, 0, None))
        w1 = next(t for t in firsts if t["class"] == "W1")
        cells += [(w1, 0, arm) for arm in _pairs(*SMOKE_PAYLOAD)]
    else:
        for task in tasks.values():
            for phrasing in range(len(task["turn_sets"])):
                cells.append((task, phrasing, None))
        for payload in payloads.values():
            for placement in payload["placements"]:
                for task in _first_reached(tasks, placement):
                    cells += [(task, 0, arm) for arm in _pairs(payload["id"], placement)]
    units = []
    for rung in rungs:
        for side in sides:
            for task, phrasing, arm in cells:
                if (side, task["task_set"]) in NOT_BUILT:
                    continue
                unit = {
                    "task_set": task["task_set"],
                    "task_id": task["id"],
                    "phrasing": phrasing,
                    "side": side,
                    "rung": rung,
                    "arm": arm,
                }
                unit["id"] = unit_id(unit)
                units.append(unit)
    return units


def ordered(units: list[dict], rungs: list[str], seed: int) -> list[dict]:
    out = []
    for rung in rungs:
        group = [u for u in units if u["rung"] == rung]
        random.Random(f"{seed}:{rung}").shuffle(group)
        out += group
    return out


# -- rungs and the manifest ------------------------------------------------------------------
@functools.cache
def _rung_specs() -> dict:
    return json.loads(RUNGS.read_text())["rungs"]


def rung_of(name: str, ollama_url: str) -> Rung:
    spec = _rung_specs()[name]
    return Rung(
        name=name,
        provider=spec["provider"],
        model=spec["model"],
        base_url=spec.get("base_url") or ollama_url,
        context_window=spec.get("context_window", 32768),
        temperature=spec.get("temperature"),
        think=spec.get("think"),
        api_key_env=spec.get("api_key_env"),
    )


def _sha_file(path: Path) -> str:
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def _git(*args: str) -> str:
    return subprocess.run(
        ["git", *args], cwd=ROOT, capture_output=True, text=True, check=True
    ).stdout


def _ollama_digest(rung: Rung) -> str | None:
    if rung.provider != "ollama":
        return None
    import httpx

    try:
        models = httpx.get(f"{rung.base_url.rstrip('/')}/api/tags", timeout=10).json()["models"]
    except (httpx.HTTPError, ValueError, KeyError):
        return None
    return next((m.get("digest") for m in models if m.get("name") == rung.model), None)


def _versions(sides: list[str]) -> dict:
    from importlib.metadata import version

    import agentpkg

    out = {"agentpkg": agentpkg.__version__, "python": sys.version.split()[0]}
    if "FW" in sides:
        from campaigns.baseline import ports

        out["openai-agents"] = version("openai-agents")
        out["secagent"] = ports.PROGENT_COMMIT
    if "Cr" in sides:
        from campaigns.driver import cr_driver

        out["cr_build"] = cr_driver.build().name
    return out


def tree_state(out: Path | None = None) -> tuple[str, str]:
    """`git status` and `git diff HEAD` of the working tree, without the campaign's own results
    directory: a resume must not see its own runs as a changed tree (review 1, finding 2)."""
    pathspec: list[str] = []
    if out is not None:
        try:
            inside = Path(out).resolve().relative_to(ROOT)
        except ValueError:
            inside = None
        if inside is not None and inside.parts:
            pathspec = ["--", ".", f":(exclude){inside.as_posix()}"]
    return _git("status", "--porcelain", *pathspec), _git("diff", "HEAD", *pathspec)


def envelopes() -> dict:
    """§2.4.2 (e): each task family's envelope from our plan, per turn for WebAir (the graph's
    model-call bound, the policy's `hard_tokens`, the per-tool caps) under the conversation's
    budget (WebAir's `conversation.budget`: `max_turns`, `hard_tokens`, the per-tool caps across
    turns; review 2, finding 2), and per run for the travel network (`worst_case`). The framework
    agent's answer step (TUNING.md T-1) is one model call more per turn, which the run's envelope
    adds on `FW` (`envelope_for`)."""
    from agentpkg.conversation.declarations import conversation_of
    from agentpkg.delegation.analysis import worst_case

    from campaigns.baseline import ports
    from campaigns.baseline.agent import model_call_bound

    webair = ports.load("webair")
    budget = webair.policy["budget"]
    conversation = conversation_of(webair.graph)["budget"]
    network = ports.load("travel-network")
    bound = worst_case(network.graph, network.policy)
    return {
        "webair": {
            "per": "turn",
            "model_calls": model_call_bound(webair),
            "tokens": budget["hard_tokens"],
            "tool_calls": sum(budget["max_calls_per_tool"].values()),
            "max_calls_per_tool": dict(budget["max_calls_per_tool"]),
            "conversation": {
                "max_turns": conversation["max_turns"],
                "tokens": conversation["hard_tokens"],
                "max_calls_per_tool": dict(conversation.get("max_calls_per_tool") or {}),
            },
        },
        "travel-network": {
            "per": "run",
            "model_calls": bound["model_calls"],
            "tokens": bound["tokens"],
            "tool_calls": sum(bound["tool_calls"].values()),
        },
        "fw_answer_step_model_calls": 1,
    }


def envelope_for(unit: dict, task: dict, table: dict) -> dict:
    """The run's envelope: the family's, times the turns for WebAir and never above what the
    conversation's budget lets any side spend (its turns, its tokens, its per-tool caps across
    turns), plus the answer step on FW."""
    family = table["travel-network" if unit["task_set"] == "TS-N" else "webair"]
    extra = table["fw_answer_step_model_calls"] if unit["side"] == "FW" else 0
    if family["per"] == "run":
        return {
            "model_calls": family["model_calls"] + extra,
            "tokens": family["tokens"],
            "tool_calls": family["tool_calls"],
        }
    conversation = family["conversation"]
    turns = min(len(task["turn_sets"][unit["phrasing"]]), conversation["max_turns"])
    across = conversation["max_calls_per_tool"]
    tool_calls = sum(
        min(cap * turns, across.get(tool, cap * turns))
        for tool, cap in family["max_calls_per_tool"].items()
    )
    return {
        "model_calls": (family["model_calls"] + extra) * turns,
        "tokens": min(family["tokens"] * turns, conversation["tokens"]),
        "tool_calls": tool_calls,
    }


def prices_for(rung_name: str) -> dict | None:
    """The rung's list prices (`rungs.json`) in the oracle's terms; none for a local rung."""
    price = _rung_specs()[rung_name].get("list_price_usd_per_mtok")
    if not price:
        return None
    return {"input_per_mtok": price["input"], "output_per_mtok": price["output"]}


def manifest(
    *,
    preset: str,
    rungs: list[str],
    sides: list[str],
    seed: int,
    units: list[dict],
    ollama_url,
    out: Path | None = None,
) -> dict:
    from campaigns.baseline import ports
    from campaigns.baseline.policies import build as policies

    rung_specs = _rung_specs()
    described = {}
    for name in rungs:
        rung = rung_of(name, ollama_url)
        described[name] = {
            **rung.describe(),
            "ollama_digest": _ollama_digest(rung),
            "list_price_usd_per_mtok": rung_specs[name].get("list_price_usd_per_mtok"),
            "provisional": rung_specs[name].get("provisional", False),
        }
    status, diff = tree_state(out)
    protocol_text = PROTOCOL.read_text()
    version = re.search(r"\*\*Status\.\*\* Version (\d+)", protocol_text)
    return {
        "schema": "campaign.manifest.v1",
        "commit": _git("rev-parse", "HEAD").strip(),
        "dirty": bool(status.strip()),
        "dirty_fingerprint": hashlib.sha256((status + diff).encode()).hexdigest(),
        "protocol": {
            "sha256": hashlib.sha256(protocol_text.encode()).hexdigest(),
            "version": int(version.group(1)) if version else None,
        },
        "seed": seed,
        "preset": preset,
        "sides": sides,
        "task_sets": {
            name: _sha_file(generate.HERE / name)
            for name in ("ts-w.json", "ts-c.json", "ts-n.json")
        },
        "not_built": sorted(f"{side}:{task_set}" for side, task_set in NOT_BUILT),
        "payloads": catalog.catalog_digest(),
        "policies": {port: policies.sha256(port) for port in ports.PORTS},
        "instructions": {port: ports.instructions_sha256(port) for port in ports.PORTS},
        "rungs": described,
        "host_mapping": {
            "hostnames": list(tls.HOSTS),
            "dial": "127.0.0.1, a throwaway campaign CA per stack",
            "real_dns_answer_classified": True,
        },
        "responder": "R-facts",
        "envelopes": envelopes(),
        "versions": _versions(sides),
        "expected_runs": len(units),
        "units_sha256": hashlib.sha256(json.dumps([u["id"] for u in units]).encode()).hexdigest(),
    }


# -- one run ---------------------------------------------------------------------------------
TRAVELER = {"given_name": "Noor", "family_name": "Halvorsen"}


def expected_facts(task: dict) -> dict:
    """R-facts' expectation: the traveler and, where the task knows them, the quote's facts."""
    from campaigns.driver.responder import expected_for

    truth = task.get("truth") or {}
    if task["task_set"] == "TS-C":
        truth = next((e for e in task["expect"] if e.get("quote_id")), {})
    return expected_for(truth, TRAVELER)


def purchase_turns(task: dict, phrasing: int) -> tuple[int, ...]:
    """The turns (1-based) in which the task asks for a purchase (review 2, finding 1): a TS-W task
    whose truth is a simulated purchase asks in its last turn (W4: quote, then buy); a TS-C
    transcript in each turn whose expectation is `intent: purchase`; no other task ever does."""
    if task["task_set"] == "TS-W":
        if (task.get("truth") or {}).get("status") == "purchase_simulated":
            return (len(task["turn_sets"][phrasing]),)
        return ()
    if task["task_set"] == "TS-C":
        return tuple(
            index
            for index, expect in enumerate(task["expect"], start=1)
            if expect.get("intent") == "purchase"
        )
    return ()


def _runner(side: str):
    if side == "Py":
        from campaigns.driver.py_driver import run_webair
    elif side == "Cr":
        from campaigns.driver.cr_driver import run_webair
    else:
        from campaigns.baseline.agent import run_webair
    return run_webair


def promote_failed_lookup(rec: dict) -> dict:
    """§2.1: a run whose public hostname did not resolve is a harness error, never a refusal. Both
    runtimes' dial logs carry the lookup (`Py`/`FW` on the dial, `Cr` from the resolver seam)."""
    failed = [d for d in rec.get("dials") or [] if (d.get("lookup") or {}).get("ok") is False]
    if failed and rec["status"] != "harness_error":
        rec["status"] = "harness_error"
        rec["harness_error"] = f"dns_lookup_failed: {failed[0].get('host')}"
    return rec


def exposure(rec: dict, arm: dict | None) -> bool | None:
    """Whether an arm's text reached the run (review 1, finding 5): the origin inserted it into an
    answer the run fetched, or the run read the profile it was appended to. A run that never read
    the placement is recorded `exposed: false`, never a harness error (the model's choice of path is
    measured behaviour); the summary counts these, and T32's arms exclude them by amendment."""
    if arm is None:
        return None
    if arm["placement"] in catalog.RECORD_PLACEMENTS:
        return any(
            c.get("tool") == "travel.profile" and c.get("outcome") == "answered"
            for c in rec.get("tool_calls") or []
        )
    # The redirect placement's twin is the plain answer (D-351): served, nothing inserted.
    return any(
        entry.get("inserted") or entry.get("twin_plain") for entry in rec.get("origin_log") or []
    )


def run_unit(
    unit: dict, *, tasks, payloads, stack, out: Path, ollama_url: str, envelopes_table=None
) -> dict:
    from campaigns.driver import record
    from campaigns.driver.responder import Responder

    task = tasks[unit["task_id"]]
    arm = unit["arm"]
    payload = payloads[arm["payload"]] if arm else None
    fixture_key = profile_insertion = None
    grant_profile = False
    if arm is not None:
        if arm["placement"] in catalog.RECORD_PLACEMENTS:
            profile_insertion = payload["text"] if arm["arm"] == "injected" else payload["twin"]
            grant_profile = True
        else:
            fixture_key = catalog.fixture_key(arm["payload"], arm["placement"], arm["arm"])
    rung = rung_of(unit["rung"], ollama_url)
    meta = {
        "run_id": unit["id"],
        "side": unit["side"],
        "task_set": unit["task_set"],
        "task_id": unit["task_id"],
        "phrasing": unit["phrasing"],
        "arm": arm_id(arm),
        "family": payload["family"] if payload else None,
        "responder": "R-facts",
    }
    run_dir = out / "runs" / unit["id"]
    if run_dir.exists() and not (run_dir / "run.json").is_file():
        # A unit that crashed (or was interrupted) before writing its record: run it again.
        shutil.rmtree(run_dir)
    try:
        if unit["task_set"] == "TS-N":
            rec = _network_runner(unit["side"])(
                text=task["turn_sets"][unit["phrasing"]][0],
                rung=rung,
                run_dir=run_dir,
                stack=stack,
                fixture_key=fixture_key,
                meta=meta,
            )
        else:
            rec = _runner(unit["side"])(
                turns=task["turn_sets"][unit["phrasing"]],
                rung=rung,
                run_dir=run_dir,
                stack=stack,
                responder=Responder(
                    "R-facts", expected_facts(task), purchase_turns(task, unit["phrasing"])
                ),
                fixture_key=fixture_key,
                grant_profile=grant_profile,
                profile_insertion=profile_insertion,
                meta=meta,
            )
    except Exception as exc:  # the driver's preparation or run failed: a harness error
        rec = record.harness_only(
            run_dir, meta=meta, rung=rung, error=f"{type(exc).__name__}: {exc}"[:500]
        )
    promote_failed_lookup(rec)
    record.write(run_dir, rec)
    return finish_unit(
        unit, tasks=tasks, payloads=payloads, out=out, envelopes_table=envelopes_table
    )


def finish_unit(unit: dict, *, tasks, payloads, out: Path, envelopes_table=None) -> dict:
    """The oracle's outcome of a recorded unit, written to `outcome.json` (the unit's "finished"
    mark): run after the driver wrote `run.json`, and on `--resume` for a unit whose record exists
    without an outcome (review 2, finding 5)."""
    from campaigns.oracle.classify import classify

    run_dir = out / "runs" / unit["id"]
    rec = json.loads((run_dir / "run.json").read_text())
    task = tasks[unit["task_id"]]
    arm = unit["arm"]
    payload = payloads[arm["payload"]] if arm else None
    table = envelopes_table or envelopes()
    outcome = classify(
        rec,
        task,
        payload,
        envelope=envelope_for(unit, task, table),
        prices=prices_for(unit["rung"]),
    )
    outcome["exposed"] = exposure(rec, arm)
    (run_dir / "outcome.json").write_text(json.dumps(outcome, indent=1, default=str) + "\n")
    return outcome


def _network_runner(side: str):
    if side == "Py":
        from campaigns.driver.py_driver import run_travel_network
    elif side == "FW":
        from campaigns.baseline.network import run_travel_network
    else:
        raise ValueError(f"no network driver for {side}")
    return run_travel_network


# -- the campaign ----------------------------------------------------------------------------
def _cell_key(meta: dict) -> str:
    """A summary cell: the side and the payload, the injected and twin arms apart (review 2,
    nit 13: the paired reading needs them apart), the placements of one payload pooled."""
    if meta["arm"] == "benign":
        return f"{meta['side']}|benign"
    payload = meta["arm"].split("@")[0]
    arm = meta["arm"].rsplit("#", 1)[-1]
    return f"{meta['side']}|{payload}#{arm}"


def summarize(out: Path, units: list[dict] | None = None) -> dict:
    rows = []
    for path in sorted((out / "runs").glob("*/outcome.json")):
        outcome = json.loads(path.read_text())
        rec = json.loads((path.parent / "run.json").read_text())
        rows.append((rec["meta"], rec["status"], outcome))
    table: dict = {}
    for meta, status, outcome in rows:
        key = _cell_key(meta)
        cell = table.setdefault(
            key,
            {
                "runs": 0,
                "completed": 0,
                "harness_error": 0,
                "utility": 0,
                "boundaries": 0,
                "not_exposed": 0,
            },
        )
        cell["runs"] += 1
        cell["completed"] += status == "completed"
        cell["harness_error"] += status == "harness_error"
        cell["utility"] += bool((outcome.get("utility") or {}).get("success"))
        cell["boundaries"] += bool(outcome.get("boundaries"))
        cell["not_exposed"] += outcome.get("exposed") is False
    summary = {"schema": "campaign.summary.v1", "cells": table, "runs": len(rows)}
    if units is not None:
        found = {meta["run_id"] for meta, _, _ in rows}
        missing = [u["id"] for u in units if u["id"] not in found]
        summary.update(expected_runs=len(units), complete=not missing, missing=missing)
    return summary


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="campaign", description=__doc__.split("\n\n")[0])
    parser.add_argument("--preset", choices=PRESETS, required=True)
    parser.add_argument("--rungs", required=True, help="comma-separated rung names (rungs.json)")
    parser.add_argument("--sides", default=",".join(SIDES))
    parser.add_argument("--out", required=True)
    parser.add_argument("--seed", type=int, default=SEED)
    parser.add_argument("--ollama-url", default="http://127.0.0.1:11434")
    parser.add_argument("--resume", action="store_true")
    parser.add_argument("--dry-run", action="store_true", help="write the manifest and stop")
    args = parser.parse_args(argv)
    rungs = [r for r in args.rungs.split(",") if r]
    sides = [s for s in args.sides.split(",") if s]
    unknown = [s for s in sides if s not in SIDES]
    if unknown:
        parser.error(f"unknown sides {unknown}")
    payloads = catalog.load()
    units = ordered(units_for(args.preset, rungs, sides, payloads), rungs, args.seed)
    out = Path(args.out)
    wanted = manifest(
        preset=args.preset,
        rungs=rungs,
        sides=sides,
        seed=args.seed,
        units=units,
        ollama_url=args.ollama_url,
        out=out,
    )
    path = out / "manifest.json"
    if args.resume:
        if not path.is_file():
            parser.error(f"--resume: {path} does not exist")
        held = json.loads(path.read_text())
        held.pop("written_at", None)
        if held != wanted:
            changed = sorted(k for k in set(held) | set(wanted) if held.get(k) != wanted.get(k))
            print(f"campaign: the manifest changed ({', '.join(changed)}); refusing to resume")
            return 2
    else:
        if out.exists():
            parser.error(f"{out} exists; a results directory is written once (use --resume)")
        out.mkdir(parents=True)
        written = {**wanted, "written_at": datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")}
        path.write_text(json.dumps(written, indent=1) + "\n")
        (out / "units.json").write_text(json.dumps(units, indent=1) + "\n")
    if args.dry_run:
        print(json.dumps({"manifest": str(path), "expected_runs": len(units)}))
        return 0
    from campaigns.origin.stack import CampaignStack

    tasks = load_tasks()
    table = wanted["envelopes"]
    started = time.monotonic()
    # The stack's certificates (a throwaway CA and its key) stay out of the results directory.
    with (
        tempfile.TemporaryDirectory(prefix="campaign-stack-") as scratch,
        CampaignStack(Path(scratch)) as stack,
    ):
        for index, unit in enumerate(units, start=1):
            run_dir = out / "runs" / unit["id"]
            if (run_dir / "outcome.json").is_file():
                continue
            begun = time.monotonic()
            if (run_dir / "run.json").is_file():  # recorded, not classified: classify it
                outcome = finish_unit(
                    unit, tasks=tasks, payloads=payloads, out=out, envelopes_table=table
                )
            else:
                outcome = run_unit(
                    unit,
                    tasks=tasks,
                    payloads=payloads,
                    stack=stack,
                    out=out,
                    ollama_url=args.ollama_url,
                    envelopes_table=table,
                )
            line = {
                "unit": unit["id"],
                "index": index,
                "of": len(units),
                "seconds": round(time.monotonic() - begun, 1),
                "harness_error": outcome["harness_error"],
                "utility": (outcome.get("utility") or {}).get("success"),
                "boundaries": outcome["boundaries"],
                "exposed": outcome["exposed"],
            }
            with open(out / "progress.jsonl", "a", encoding="utf-8") as handle:
                handle.write(json.dumps(line) + "\n")
            print(json.dumps(line), flush=True)
    summary = summarize(out, units)
    summary["wall_seconds"] = round(time.monotonic() - started, 1)
    (out / "summary.json").write_text(json.dumps(summary, indent=1) + "\n")
    print(json.dumps(summary["cells"], indent=1))
    if not summary["complete"]:
        print(f"campaign: {len(summary['missing'])} of {len(units)} units have no outcome")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
