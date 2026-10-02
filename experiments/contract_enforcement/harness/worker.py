"""One profile's worker process: one shard of the catalog, through one host helper.

Started by `run.py` as

    python -m harness.worker --results DIR --profile NAME --shard I --shards N [--calibrate]

with `PYTHONPATH` naming the profile's own agentpkg (the private patched copy
for an ablation, `agentpkg/src` otherwise) and then the experiment directory.
The worker refuses to start if the agentpkg it imported is not the one its
profile names, so an ablation can never run against production code or the
other way round.

Each case gets a fresh directory, control plane, plugin backend, synthetic
model and services; nothing survives a case except this process's patched
modules, which are the profile itself. Records are appended, one fsync'd
line per case, to `raw/<profile>-<shard>.jsonl`; a key already present in
any of the profile's shard files is skipped, which is what `--resume` relies on.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import shutil
import sys
import tempfile
import time
import traceback
from pathlib import Path


def _say(message: dict) -> None:
    sys.stdout.write(json.dumps(message, sort_keys=True) + "\n")
    sys.stdout.flush()


def check_import(expected_root: str) -> str:
    import agentpkg

    actual = str(Path(agentpkg.__file__).resolve().parent)
    if not actual.startswith(str(Path(expected_root).resolve())):
        raise SystemExit(f"worker imported agentpkg from {actual}, expected {expected_root}")
    return actual


async def main(argv=None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--results", required=True)
    parser.add_argument("--profile", required=True)
    parser.add_argument("--shard", type=int, default=0)
    parser.add_argument("--shards", type=int, default=1)
    parser.add_argument("--calibrate", action="store_true")
    args = parser.parse_args(argv)

    from .paths import ROOT

    results = Path(args.results)
    config = json.loads((results / "config.json").read_text())
    build = config["builds"][args.profile]
    check_import(str(ROOT / build["agentpkg_root"]))

    from cases import entry_plan
    from cases.base import Env
    from cases.calibration import calibrate, load

    from . import oracle, records
    from .ablations import BY_NAME
    from .guards import PythonGuard, StateProbe
    from .host import HostHelper
    from .pipeline import run_case

    profile = BY_NAME[args.profile]
    work = Path(tempfile.mkdtemp(prefix=f"ce-{args.profile}-{args.shard}-"))
    logs = Path(tempfile.gettempdir()) / "contract_enforcement-logs" / results.name
    logs.mkdir(parents=True, exist_ok=True)

    async def start_helper() -> HostHelper:
        helper = HostHelper(
            ROOT / build["typescript"], log_path=logs / f"helper-{args.profile}-{args.shard}.log"
        )
        await helper.start()
        return helper

    helper = await start_helper()
    probe = StateProbe()
    probe.install()
    env = Env(int(config["seed"]), built_in_bindings=helper.hello["built_in_bindings"])

    if args.calibrate:
        with PythonGuard() as guard:
            calibration = await calibrate(helper, env, work, probe=probe, guard=guard)
        (results / "calibration.json").write_text(
            json.dumps(calibration, sort_keys=True, indent=1) + "\n"
        )
        await helper.stop()
        shutil.rmtree(work, ignore_errors=True)
        _say({"calibrated": calibration["sha256"]})
        return 0

    env.calibration = load(results / "calibration.json")
    catalog = json.loads((results / "case_catalog.json").read_text())
    raw = results / "raw"
    raw.mkdir(exist_ok=True)
    mine = raw / f"{args.profile}-{args.shard}.jsonl"
    records.repair(mine)
    done = set()
    for path in raw.glob(f"{args.profile}-*.jsonl"):
        records.repair(path)
        done.update(record["key"] for record in records.read(path))
    entries = [
        entry for index, entry in enumerate(catalog["cases"]) if index % args.shards == args.shard
    ]
    todo = [entry for entry in entries if f"{args.profile}::{entry['case_id']}" not in done]
    _say({"profile": args.profile, "shard": args.shard, "cases": len(entries), "todo": len(todo)})

    guard = PythonGuard()

    async def restart(old: HostHelper) -> HostHelper:
        # Starting a process is exactly what the guard refuses, so it steps aside
        # for the one child this worker owns, and only for as long as that takes.
        guard.__exit__(None, None, None)
        try:
            await old.stop()
            return await start_helper()
        finally:
            guard.__enter__()

    with guard:
        for number, entry in enumerate(todo):
            case_dir = work / f"{number:05d}"
            started = time.perf_counter()
            from cases import BY_ID

            template = BY_ID[entry["template_id"]]
            try:
                (plan, boundary), template = entry_plan(entry, env.at(case_dir))
                plan.host.browser_policy = {**plan.host.browser_policy, **profile.browser_policy}
            except Exception as exc:  # noqa: BLE001 - a case that cannot be planned is the harness's
                records.append(mine, _planning_failure(entry, template, args.profile, exc))
                continue
            try:
                obs = await run_case(plan, helper, case_dir, probe=probe, guard=guard)
            except Exception as exc:  # noqa: BLE001 - the helper broke: record, restart, go on
                records.append(
                    mine, _planning_failure(entry, template, args.profile, exc, stage="run")
                )
                helper = await restart(helper)
                continue
            verdict = oracle.judge(
                entry["kind"], obs, boundary, requires_fault=template.requires_fault
            )
            record = records.make_record(
                entry,
                template,
                args.profile,
                plan,
                obs,
                verdict,
                case_dir=str(case_dir),
                run={
                    "run_id": results.name,
                    "seed": env.seed,
                    "shard": args.shard,
                    "sequence": number,
                },
            )
            record["wall_ms"] = round((time.perf_counter() - started) * 1000, 3)
            records.append(mine, record)
            _say({"done": record["key"], "outcome": record["outcome"]})
            if helper.process is None or helper.process.returncode is not None:
                helper = await restart(helper)
    await helper.stop()
    probe.uninstall()
    shutil.rmtree(work, ignore_errors=True)
    return 0


def _planning_failure(entry, template, profile, exc, stage="plan") -> dict:
    from . import oracle
    from .records import scrub

    return {
        "key": f"{profile}::{entry['case_id']}",
        "profile": profile,
        "case_id": entry["case_id"],
        "kind": entry["kind"],
        "template_id": entry["template_id"],
        "family": template.family,
        "package": entry["package"],
        "variant_id": entry["variant_id"],
        "control_id": entry["control_id"],
        "outcome": oracle.HARNESS_ERROR,
        "forbidden_boundary_reached": False,
        "harness_problems": [f"{stage}_failed"],
        "refusal": None,
        "expected_component": template.component,
        "expected_stage": template.expected_stage,
        "expected_codes": list(template.expected_codes),
        "observed_component": None,
        "observed_stage": None,
        "stage_match": None,
        "component_match": None,
        "code_match": None,
        "evidence": scrub(
            {"error": f"{type(exc).__name__}: {exc}"[:800], "trace": traceback.format_exc()[-2000:]}
        ),
    }


if __name__ == "__main__":
    os.environ.setdefault("PYTHONHASHSEED", "0")
    raise SystemExit(asyncio.run(main()))
