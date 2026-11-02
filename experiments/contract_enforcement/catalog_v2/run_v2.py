"""Run catalog v2 (E1, T30): every case of a preset, on both runtimes, under each profile.

    agentpkg/.venv/bin/python experiments/contract_enforcement/catalog_v2/run_v2.py \\
        --preset smoke|qualification|paper [--jobs N] [--seed S] [--label L] \\
        [--profiles a,b] [--runtimes py,ts] [--out DIR]

Steps: the private builds of every profile in both runtimes (`harness_v2/build.py`); the signed
probe archives of every case, under a key generated for the run; `manifest.json` (the commit, the
dirty-tree fingerprint, the seed, the preset, the profiles, the build keys, the patch and the
private-copy hashes, the catalog hash, the expected executions) written before the first case
runs; the cases, sharded over `--jobs` worker processes; each record classified by the oracle and
appended to `raw/<runtime>-<profile>.jsonl`; the production trees' hashes taken again at the end
(`run.json`); then `analyze_v2.py`. Results go to a new directory
`results/<UTC>_v2-<preset>[_<label>]/`; an existing directory is never written into.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import subprocess
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import UTC, datetime
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

from cases_v2 import PRESETS, catalog, catalog_hash  # noqa: E402
from harness_v2 import packages  # noqa: E402
from harness_v2.ablations import BY_NAME, PROFILES, SMOKE_PROFILES  # noqa: E402
from harness_v2.build import BUILDS, node_build, py_build  # noqa: E402
from harness_v2.oracle import classify  # noqa: E402
from harness_v2.paths import (  # noqa: E402
    AGENTPKG_PACKAGE,
    CACHE,
    CHROME_SRC,
    EXPERIMENT_NAME,
    EXPERIMENT_VERSION,
    RESULTS,
    ROOT,
    RUNTIMES,
    rel,
    tree_digest,
)
from harness_v2.pool import Worker  # noqa: E402

DEFAULT_SEED = 20261101
SHARD_SIZE = 40


def _git(*args) -> str | None:
    try:
        return subprocess.run(
            ["git", *args], cwd=ROOT, capture_output=True, text=True, check=True
        ).stdout.strip()
    except (OSError, subprocess.CalledProcessError):
        return None


def git_state() -> dict:
    status = _git("status", "--porcelain", "--untracked-files=no") or ""
    diff = _git("diff", "HEAD") or ""
    return {
        "commit": _git("rev-parse", "HEAD"),
        "branch": _git("rev-parse", "--abbrev-ref", "HEAD"),
        "dirty": bool(status),
        "dirty_fingerprint": hashlib.sha256(diff.encode()).hexdigest() if status else None,
    }


def production_hashes() -> dict:
    return {
        "agentpkg/src/agentpkg": tree_digest(AGENTPKG_PACKAGE, (".py", ".json")),
        "chrome-agent-browser/src": tree_digest(CHROME_SRC, (".ts", ".json")),
    }


def experiment_fingerprint() -> str:
    digest = hashlib.sha256()
    for pattern in ("harness_v2/*.py", "harness_v2/driver_node/*", "cases_v2/*.py", "*.py"):
        for path in sorted(HERE.glob(pattern)):
            if path.is_file():
                digest.update(path.relative_to(HERE).as_posix().encode() + b"\0")
                digest.update(path.read_bytes() + b"\0")
    return digest.hexdigest()


def build_all(profiles: list[str], runtimes: list[str]) -> dict:
    builds = {}
    for name in profiles:
        profile = BY_NAME[name]
        for runtime in runtimes:
            if runtime == "py":
                directory = py_build(name, list(profile.py))
            else:
                directory = node_build(name, list(profile.ts))
            meta = json.loads((directory / "build.json").read_text())
            builds[(runtime, name)] = {"dir": directory, "meta": meta}
    return builds


def results_directory(preset: str, label: str | None, out: str | None) -> Path:
    if out:
        target = Path(out)
    else:
        stamp = datetime.now(UTC).strftime("%Y-%m-%dT%H-%M-%SZ")
        target = RESULTS / f"{stamp}_v2-{preset}{'_' + label if label else ''}"
    if target.exists():
        raise SystemExit(f"refusing to write into an existing directory: {target}")
    target.mkdir(parents=True)
    return target


class Progress:
    def __init__(self, total: int):
        self.total, self.done, self.lock, self.started = total, 0, threading.Lock(), time.time()
        self.outcomes: dict[str, int] = {}

    def tick(self, outcome: str):
        with self.lock:
            self.done += 1
            self.outcomes[outcome] = self.outcomes.get(outcome, 0) + 1
            if self.done % 100 == 0 or self.done == self.total:
                rate = self.done / max(time.time() - self.started, 1e-6)
                outcomes = dict(sorted(self.outcomes.items()))
                print(f"  {self.done}/{self.total} ({rate:.1f}/s) {outcomes}", flush=True)


def run_shard(runtime, profile, build, cases, inputs, results: Path, progress, lock) -> int:
    raw = results / "raw" / f"{runtime}-{profile}.jsonl"
    log = results / "logs" / f"worker-{runtime}-{profile}-{os.getpid()}-{threading.get_ident()}.log"
    with Worker(runtime, build["dir"], build["meta"]["key"], log=log) as worker:
        for case in cases:
            record = worker.run(inputs[case.id])
            verdict = classify(case.to_json(), record, runtime)
            line = {
                "case": case.id,
                "family": case.family,
                "kind": case.kind,
                "runtime": runtime,
                "profile": profile,
                **verdict,
                "record": record,
            }
            # Records never carry a local absolute path (the archives live in the cache).
            text = json.dumps(line, ensure_ascii=False, default=str)
            text = text.replace(str(ROOT), "<repo>").replace(str(Path.home()), "~")
            with lock:
                with open(raw, "a", encoding="utf-8") as stream:
                    stream.write(text + "\n")
            progress.tick(verdict["outcome"])
    return len(cases)


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--preset", choices=sorted(PRESETS), required=True)
    parser.add_argument("--jobs", type=int, default=2)
    parser.add_argument("--seed", type=int, default=DEFAULT_SEED)
    parser.add_argument("--label")
    parser.add_argument("--profiles", help="comma-separated profile names")
    parser.add_argument("--runtimes", default="py,ts")
    parser.add_argument(
        "--out", help="a new results directory (default: results/<UTC>_v2-<preset>)"
    )
    parser.add_argument("--no-analyze", action="store_true")
    args = parser.parse_args(argv)

    runtimes = [r for r in args.runtimes.split(",") if r]
    if not set(runtimes) <= set(RUNTIMES):
        raise SystemExit(f"--runtimes: choose from {RUNTIMES}")
    if args.profiles:
        profiles = args.profiles.split(",")
    elif args.preset == "smoke":
        profiles = list(SMOKE_PROFILES)
    else:
        profiles = [p.name for p in PROFILES]
    unknown = sorted(set(profiles) - set(BY_NAME))
    if unknown:
        raise SystemExit(f"unknown profiles: {unknown}")

    started = datetime.now(UTC)
    before = production_hashes()
    git = git_state()
    print(f"catalog v2 · preset {args.preset} · seed {args.seed} · profiles {len(profiles)}")
    cases = catalog(args.preset, args.seed)
    builds = build_all(profiles, runtimes)
    results = results_directory(args.preset, args.label, args.out)
    for sub in ("raw", "logs", "patches"):
        (results / sub).mkdir()

    workdir = CACHE / "runs" / results.name
    private_key, public_key = packages.generate_key(workdir / "key")
    shutil.copy2(public_key, results / "throwaway.pub.pem")
    archives = {}
    for case in cases:
        archives[case.id] = packages.build_archive(case, workdir, private_key)
    inputs = {
        case.id: case.driver_input(archives[case.id]["archive"], str(public_key)) for case in cases
    }

    catalog_doc = {
        "schema": "contract-enforcement.catalog.v2",
        "preset": args.preset,
        "seed": args.seed,
        "catalog_sha256": catalog_hash(cases),
        "cases": [
            {**case.to_json(), "archive_sha256": archives[case.id]["archive_sha256"]}
            for case in cases
        ],
    }
    (results / "catalog.json").write_text(json.dumps(catalog_doc, indent=1, ensure_ascii=False))
    for (runtime, name), build in builds.items():
        target = results / "patches" / name
        target.mkdir(exist_ok=True)
        shutil.copy2(build["dir"] / "patch.diff", target / f"{runtime}.diff")
    manifest = {
        "experiment": EXPERIMENT_NAME,
        "version": EXPERIMENT_VERSION,
        "experiment_sha256": experiment_fingerprint(),
        "git": git,
        "preset": args.preset,
        "seed": args.seed,
        "jobs": args.jobs,
        "runtimes": runtimes,
        "profiles": [BY_NAME[name].as_json() for name in profiles],
        "builds": {
            f"{runtime}/{name}": {
                "key": build["meta"]["key"],
                "source_sha256": build["meta"]["source_sha256"],
                "patches": build["meta"]["patches"],
                **({"tools": build["meta"]["tools"]} if runtime == "ts" else {}),
                **({"driver_sha256": build["meta"]["driver_sha256"]} if runtime == "ts" else {}),
                "patch_diff_sha256": hashlib.sha256(
                    (build["dir"] / "patch.diff").read_bytes()
                ).hexdigest(),
            }
            for (runtime, name), build in builds.items()
        },
        "production_sha256_before": before,
        "catalog_sha256": catalog_doc["catalog_sha256"],
        "cases": len(cases),
        "expected_executions": len(cases) * len(runtimes) * len(profiles),
        "machine": {
            "platform": sys.platform,
            "python": sys.version.split()[0],
            "cpus": os.cpu_count(),
        },
        "started_at": started.isoformat(),
        "builds_dir": str(BUILDS.relative_to(ROOT)),
    }
    (results / "manifest.json").write_text(json.dumps(manifest, indent=2, ensure_ascii=False))
    print(f"  results: {rel(results)} · {manifest['expected_executions']} executions")

    shards = []
    for name in profiles:
        for runtime in runtimes:
            for start in range(0, len(cases), SHARD_SIZE):
                shards.append((runtime, name, cases[start : start + SHARD_SIZE]))
    # The slowest shards first, so that the pool ends together.
    shards.sort(key=lambda s: (s[1] != "compute_limits", s[0] != "py"))
    progress, lock = Progress(manifest["expected_executions"]), threading.Lock()
    t0 = time.time()
    with ThreadPoolExecutor(max_workers=max(1, args.jobs)) as pool:
        futures = [
            pool.submit(
                run_shard, rt, name, builds[(rt, name)], chunk, inputs, results, progress, lock
            )
            for rt, name, chunk in shards
        ]
        for future in as_completed(futures):
            future.result()
    after = production_hashes()
    run = {
        "ended_at": datetime.now(UTC).isoformat(),
        "wall_seconds": round(time.time() - t0, 1),
        "executions": progress.done,
        "production_sha256_after": after,
        "production_untouched": after == before,
    }
    (results / "run.json").write_text(json.dumps(run, indent=2))
    print(
        f"  done in {run['wall_seconds']} s · production untouched: {run['production_untouched']}"
    )
    if not run["production_untouched"]:
        print("  the production trees changed during the run", file=sys.stderr)
        return 1
    if not args.no_analyze:
        from analyze_v2 import analyze, print_table

        summary = analyze(results)
        print_table(summary)
    return 0


if __name__ == "__main__":
    sys.exit(main())
