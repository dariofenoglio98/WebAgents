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
  units (`runs/<unit>/run.json`) are skipped.
- **Harness errors.** A run whose public hostname did not resolve, or whose driver failed, is a
  harness error (in the denominator, never a refusal, §2.1).

Entry scripts must guard `__main__`: agentpkg's network child uses `spawn` and re-imports it.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import random
import re
import subprocess
import sys
import tempfile
import time
from datetime import UTC, datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
EXPERIMENTS = ROOT / "experiments"
for _path in (EXPERIMENTS, ROOT / "demo" / "webair"):
    if str(_path) not in sys.path:
        sys.path.insert(0, str(_path))

from campaigns.driver.routes import Rung  # noqa: E402
from campaigns.origin import catalog, tls  # noqa: E402
from campaigns.tasks import generate  # noqa: E402

PROTOCOL = EXPERIMENTS / "PROTOCOL.md"
RUNGS = Path(__file__).resolve().parent / "rungs.json"
SIDES = ("Py", "Cr", "FW")
PRESETS = ("smoke", "qualification", "paper")
SEED = 31
SMOKE_PAYLOAD = ("upload-01", "search.fare_name")
# Which task classes read each placement on WebAir's path (search answers reach every class;
# fare rules only where fares are selected and explained; the quote only where one is prepared).
PLACEMENT_REACH = {
    "search": ("W1", "W2", "W3", "W4", "W5", "TS-C"),
    "redirect": ("W1", "W2", "W3", "W4", "W5", "TS-C"),
    "rules": ("W1", "W2", "W5", "TS-C"),
    "quote": ("W3", "W4", "TS-C"),
    "record": ("W1", "W2", "W3", "W4", "W5", "TS-C"),
    "travel": ("TS-N",),
}
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
                reach = PLACEMENT_REACH.get(placement.split(".")[0], ())
                for task in firsts:
                    if task["class"] in reach:
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
def rung_of(name: str, ollama_url: str) -> Rung:
    spec = json.loads(RUNGS.read_text())["rungs"][name]
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


def manifest(
    *, preset: str, rungs: list[str], sides: list[str], seed: int, units: list[dict], ollama_url
) -> dict:
    from campaigns.baseline import ports
    from campaigns.baseline.policies import build as policies

    rung_specs = json.loads(RUNGS.read_text())["rungs"]
    described = {}
    for name in rungs:
        rung = rung_of(name, ollama_url)
        described[name] = {
            **rung.describe(),
            "ollama_digest": _ollama_digest(rung),
            "list_price_usd_per_mtok": rung_specs[name].get("list_price_usd_per_mtok"),
            "provisional": rung_specs[name].get("provisional", False),
        }
    status = _git("status", "--porcelain")
    diff = _git("diff", "HEAD")
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


def _runner(side: str):
    if side == "Py":
        from campaigns.driver.py_driver import run_webair
    elif side == "Cr":
        from campaigns.driver.cr_driver import run_webair
    else:
        from campaigns.baseline.agent import run_webair
    return run_webair


def run_unit(unit: dict, *, tasks, payloads, stack, out: Path, ollama_url: str) -> dict:
    from campaigns.driver.responder import Responder
    from campaigns.oracle.classify import classify

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
            responder=Responder("R-facts", expected_facts(task)),
            fixture_key=fixture_key,
            grant_profile=grant_profile,
            profile_insertion=profile_insertion,
            meta=meta,
        )
    failed = [d for d in rec.get("dials") or [] if (d.get("lookup") or {}).get("ok") is False]
    if failed and rec["status"] != "harness_error":
        # §2.1: a run whose public hostname did not resolve is a harness error, never a refusal.
        rec["status"] = "harness_error"
        rec["harness_error"] = f"dns_lookup_failed: {failed[0].get('host')}"
        (run_dir / "run.json").write_text(json.dumps(rec, ensure_ascii=False, indent=1) + "\n")
    outcome = classify(rec, task, payload)
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
def summarize(out: Path) -> dict:
    rows = []
    for path in sorted((out / "runs").glob("*/outcome.json")):
        outcome = json.loads(path.read_text())
        rec = json.loads((path.parent / "run.json").read_text())
        rows.append((rec["meta"], rec["status"], outcome))
    table: dict = {}
    for meta, status, outcome in rows:
        key = f"{meta['side']}|{meta['arm'].split('@')[0] if meta['arm'] != 'benign' else 'benign'}"
        cell = table.setdefault(
            key, {"runs": 0, "completed": 0, "harness_error": 0, "utility": 0, "boundaries": 0}
        )
        cell["runs"] += 1
        cell["completed"] += status == "completed"
        cell["harness_error"] += status == "harness_error"
        cell["utility"] += bool((outcome.get("utility") or {}).get("success"))
        cell["boundaries"] += bool(outcome.get("boundaries"))
    return {"schema": "campaign.summary.v1", "cells": table, "runs": len(rows)}


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
    started = time.monotonic()
    # The stack's certificates (a throwaway CA and its key) stay out of the results directory.
    with (
        tempfile.TemporaryDirectory(prefix="campaign-stack-") as scratch,
        CampaignStack(Path(scratch)) as stack,
    ):
        for index, unit in enumerate(units, start=1):
            if (out / "runs" / unit["id"] / "run.json").is_file():
                continue
            begun = time.monotonic()
            outcome = run_unit(
                unit,
                tasks=tasks,
                payloads=payloads,
                stack=stack,
                out=out,
                ollama_url=args.ollama_url,
            )
            line = {
                "unit": unit["id"],
                "index": index,
                "of": len(units),
                "seconds": round(time.monotonic() - begun, 1),
                "harness_error": outcome["harness_error"],
                "utility": (outcome.get("utility") or {}).get("success"),
                "boundaries": outcome["boundaries"],
            }
            with open(out / "progress.jsonl", "a", encoding="utf-8") as handle:
                handle.write(json.dumps(line) + "\n")
            print(json.dumps(line), flush=True)
    summary = summarize(out)
    summary["wall_seconds"] = round(time.monotonic() - started, 1)
    (out / "summary.json").write_text(json.dumps(summary, indent=1) + "\n")
    print(json.dumps(summary["cells"], indent=1))
    return 0


if __name__ == "__main__":
    sys.exit(main())
