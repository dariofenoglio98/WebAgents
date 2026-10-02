#!/usr/bin/env python3
"""Run the contract-enforcement experiment: build, calibrate, generate, execute, analyze.

    RUN="agentpkg/.venv/bin/python experiments/contract_enforcement/run.py"
    $RUN --preset smoke
    $RUN --preset qualification --jobs 6
    $RUN --preset paper --jobs 6 --label paper
    $RUN --resume <results-dir> --jobs 6

1. Build every profile the preset names: the plugin compiled from its own
   sources (patched privately for an ablation) and, for an ablation with
   Python sites, a private patched copy of agentpkg (`harness/build.py`).
2. Calibrate: one benign run of each package on the full system
   (`cases/calibration.py`).
3. Generate the catalog from the seed, the preset and the calibration
   (`cases/__init__.py`) and write it before anything is executed.
4. Execute: `--jobs` worker processes, each one profile shard
   (`harness/worker.py`), appending one fsync'd record per case.
5. Analyze (`analyze.py`) into summaries, tables and the report.

`--resume DIR` validates the directory's configuration (experiment version,
seed, preset, profiles, build keys, calibration and catalog hashes) against a
fresh derivation and then executes only the cases without a record. Nothing
here contacts a network service or needs a credential.
"""

from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import os
import platform
import subprocess
import sys
import tempfile
import time
from datetime import UTC, datetime
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

from harness import paths  # noqa: E402
from harness.paths import (  # noqa: E402
    AGENTPKG_SRC,
    EXPERIMENT_NAME,
    EXPERIMENT_VERSION,
    PACKAGES,
    RESULTS,
    ROOT,
    THREAT_MODEL_VERSION,
    rel,
    sha256_file,
)

DEFAULT_SEED = 20261002


def _run(command: list[str]) -> str | None:
    try:
        return subprocess.run(
            command, cwd=ROOT, capture_output=True, text=True, timeout=60, check=True
        ).stdout.strip()
    except Exception:  # noqa: BLE001 - metadata is best effort
        return None


def git_state() -> dict:
    status = _run(["git", "status", "--porcelain", "--untracked-files=all"]) or ""
    lines = [line for line in status.splitlines() if line]
    # This experiment's own outputs are not inputs: excluding them keeps the
    # fingerprint of one run independent of the results earlier runs wrote.
    outputs = rel(RESULTS) + "/"
    lines = [line for line in lines if not line[3:].startswith(outputs)]
    tracked = sorted(line[3:] for line in lines if not line.startswith("??"))
    untracked = sorted(line[3:] for line in lines if line.startswith("??"))
    digest = hashlib.sha256()
    digest.update((_run(["git", "diff", "HEAD", "--binary"]) or "").encode())
    for name in untracked:
        path = ROOT / name
        if path.is_file():
            digest.update(name.encode() + b"\0" + sha256_file(path).encode() + b"\n")
    return {
        "git_commit": _run(["git", "rev-parse", "HEAD"]),
        "git_dirty": bool(lines),
        "git_tracked_changes": tracked,
        "git_untracked_count": len(untracked),
        "git_production_paths_modified": [
            path
            for path in tracked
            if path.startswith(("agentpkg/src", "openclaw-agent-browser/src", "dist/"))
        ],
        "dirty_fingerprint": digest.hexdigest() if lines else None,
    }


def package_identity(key: str) -> dict:
    from harness import artifacts

    spec = PACKAGES[key]
    archive = Path(spec["archive"]).read_bytes()
    members = artifacts.read_members(archive)
    manifest = json.loads(members["MANIFEST.agent"])
    graph = json.loads(members["graph.json"])
    signature = json.loads(members["signatures/publisher.json"])
    return {
        "package": key,
        "package_id": manifest["package_id"],
        "version": manifest["version"],
        "archive": rel(spec["archive"]),
        "archive_sha256": hashlib.sha256(archive).hexdigest(),
        "digest": signature.get("digest"),
        "signer_fingerprint": signature.get("key_fingerprint"),
        "publisher_key": rel(spec["publisher_key"]),
        "publisher_key_sha256": sha256_file(Path(spec["publisher_key"])),
        "workflow": {
            "profile": graph.get("profile"),
            "nodes": len(graph["nodes"]),
            "workers": len(graph["workers"]),
            "model_tasks": sorted({t["id"] for t in manifest["model_requirements"]["tasks"]}),
            "tools": sorted(tool["id"] for tool in manifest.get("tools") or []),
            "deadline_seconds": graph.get("deadline_seconds"),
            "runtime_minimum_version": manifest["runtime"]["minimum_version"],
        },
    }


def experiment_fingerprint() -> str:
    """The experiment's own code: a resumed run must execute exactly what the original did."""
    digest = hashlib.sha256()
    files = sorted(
        path
        for pattern in ("harness/*.py", "harness/*.mjs", "cases/*.py", "run.py", "analyze.py")
        for path in HERE.glob(pattern)
    )
    for path in files:
        digest.update(path.relative_to(HERE).as_posix().encode() + b"\0" + path.read_bytes())
    return digest.hexdigest()


def manifest_for(config: dict, metadata: dict, catalog: dict) -> dict:
    """The frozen experiment definition, written before any case executes."""
    return {
        "experiment": EXPERIMENT_NAME,
        "experiment_version": EXPERIMENT_VERSION,
        "threat_model_version": THREAT_MODEL_VERSION,
        "experiment_code_sha256": config["experiment_code_sha256"],
        "git_commit": metadata.get("git_commit"),
        "git_dirty": metadata.get("git_dirty"),
        "dirty_fingerprint": metadata.get("dirty_fingerprint"),
        "git_production_paths_modified": metadata.get("git_production_paths_modified"),
        "packages": [
            {
                key: package[key]
                for key in (
                    "package",
                    "package_id",
                    "version",
                    "archive_sha256",
                    "digest",
                    "signer_fingerprint",
                )
            }
            for package in metadata["packages"]
        ],
        "seed": config["seed"],
        "preset": {key: config[key] for key in ("preset", "budget", "limit", "preset_description")},
        "profiles": config["profiles"],
        "builds": {
            name: {
                key: build[key]
                for key in (
                    "typescript_key",
                    "agentpkg_key",
                    "python_patches",
                    "typescript_patches",
                    "browser_policy",
                )
            }
            for name, build in config["builds"].items()
            if name in config["profiles"]
        },
        "calibration_sha256": config["calibration_sha256"],
        "catalog_sha256": catalog["sha256"],
        "counts": catalog["counts"],
        "expected_executions": config["expected_executions"],
    }


def build_profiles(names: list[str]) -> dict:
    from harness.ablations import BY_NAME
    from harness.build import build_diff, py_build, ts_build

    builds = {}
    for name in names:
        profile = BY_NAME[name]
        started = time.perf_counter()
        ts_dir = ts_build(name, list(profile.ts))
        py_dir = py_build(name, list(profile.py))
        agentpkg_root = (py_dir / "agentpkg") if py_dir is not None else (AGENTPKG_SRC / "agentpkg")
        builds[name] = {
            "typescript": rel(ts_dir),
            "typescript_key": ts_dir.name,
            "agentpkg_root": rel(agentpkg_root),
            "agentpkg_key": py_dir.parent.name if py_dir is not None else "production",
            "pythonpath": rel(py_dir) if py_dir is not None else rel(AGENTPKG_SRC),
            "python_patches": [patch.site for patch in profile.py],
            "typescript_patches": [patch.site for patch in profile.ts],
            "browser_policy": dict(profile.browser_policy),
            "build_seconds": round(time.perf_counter() - started, 3),
        }
        builds[name]["_diff_py"] = (
            build_diff(paths.AGENTPKG_PACKAGE, agentpkg_root, sorted({p.file for p in profile.py}))
            if profile.py
            else ""
        )
        builds[name]["_diff_ts"] = (
            build_diff(paths.PLUGIN_SRC, ts_dir / "src", sorted({p.file for p in profile.ts}))
            if profile.ts
            else ""
        )
    return builds


def worker_env(build: dict, home: Path) -> dict:
    env = {
        "PATH": os.environ.get("PATH", "/usr/bin:/bin"),
        "PYTHONPATH": os.pathsep.join([str(ROOT / build["pythonpath"]), str(HERE)]),
        "PYTHONHASHSEED": "0",
        "PYTHONDONTWRITEBYTECODE": "1",
        "HOME": str(home),
        "TMPDIR": tempfile.gettempdir(),
        "LANG": "C.UTF-8",
    }
    return env


async def run_worker(
    results: Path,
    profile: str,
    shard: int,
    shards: int,
    build: dict,
    *,
    calibrate=False,
    progress=None,
) -> int:
    home = Path(tempfile.mkdtemp(prefix="ce-home-"))
    command = [
        sys.executable,
        "-m",
        "harness.worker",
        "--results",
        str(results),
        "--profile",
        profile,
        "--shard",
        str(shard),
        "--shards",
        str(shards),
    ]
    if calibrate:
        command.append("--calibrate")
    process = await asyncio.create_subprocess_exec(
        *command,
        cwd=str(HERE),
        env=worker_env(build, home),
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )

    async def pump_stdout():
        async for line in process.stdout:
            try:
                message = json.loads(line)
            except ValueError:
                continue
            if progress is not None:
                progress(profile, shard, message)

    async def pump_stderr():
        log = results / "logs"
        log.mkdir(exist_ok=True)
        with open(
            log / f"worker-{profile}-{shard}{'-calibration' if calibrate else ''}.log", "ab"
        ) as stream:
            async for line in process.stderr:
                stream.write(line)

    try:
        await asyncio.gather(pump_stdout(), pump_stderr())
        return await process.wait()
    finally:
        import shutil

        shutil.rmtree(home, ignore_errors=True)


class Progress:
    def __init__(self, total: int):
        self.total = total
        self.done = 0
        self.outcomes: dict[str, int] = {}
        self.started = time.perf_counter()
        self.last = 0.0

    def __call__(self, profile, shard, message):
        if "done" in message:
            self.done += 1
            self.outcomes[message["outcome"]] = self.outcomes.get(message["outcome"], 0) + 1
            now = time.perf_counter()
            if now - self.last > 15 or self.done == self.total:
                self.last = now
                rate = self.done / max(now - self.started, 1e-9)
                left = (self.total - self.done) / rate if rate else float("inf")
                print(
                    f"[{self.done}/{self.total}] {json.dumps(self.outcomes, sort_keys=True)} "
                    f"{rate:.2f} cases/s, ~{left / 60:.1f} min left",
                    flush=True,
                )


def write_catalog(results: Path, catalog: dict) -> None:
    import csv

    from cases import CSV_FIELDS, csv_rows

    (results / "case_catalog.json").write_text(
        json.dumps(catalog, sort_keys=True, indent=1, ensure_ascii=False) + "\n"
    )
    with open(results / "case_catalog.csv", "w", newline="", encoding="utf-8") as stream:
        writer = csv.DictWriter(stream, fieldnames=list(CSV_FIELDS))
        writer.writeheader()
        writer.writerows(csv_rows(catalog))


async def execute(results: Path, config: dict, jobs: int) -> None:
    catalog = json.loads((results / "case_catalog.json").read_text())
    from harness import records

    done = set()
    for path in (results / "raw").glob("*.jsonl") if (results / "raw").exists() else []:
        done.update(record["key"] for record in records.read(path))
    total = sum(
        1
        for profile in config["profiles"]
        for entry in catalog["cases"]
        if f"{profile}::{entry['case_id']}" not in done
    )
    print(
        f"executing {total} case runs ({len(done)} already recorded) with {jobs} workers",
        flush=True,
    )
    progress = Progress(total)
    shards = max(1, jobs)
    queue: asyncio.Queue = asyncio.Queue()
    for profile in config["profiles"]:
        for shard in range(shards):
            queue.put_nowait((profile, shard))
    failures = []

    async def runner():
        while not queue.empty():
            profile, shard = queue.get_nowait()
            code = await run_worker(
                results, profile, shard, shards, config["builds"][profile], progress=progress
            )
            if code != 0:
                failures.append((profile, shard, code))

    await asyncio.gather(*(runner() for _ in range(jobs)))
    if failures:
        raise SystemExit(f"workers failed: {failures} (see {rel(results / 'logs')})")


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument("--preset", choices=("smoke", "qualification", "paper"), default="smoke")
    parser.add_argument("--seed", type=int, default=DEFAULT_SEED)
    parser.add_argument("--profiles", help="comma-separated subset of the preset's profiles")
    parser.add_argument("--jobs", type=int, default=max(1, min(4, (os.cpu_count() or 2) // 2)))
    parser.add_argument("--results-dir", default=str(RESULTS))
    parser.add_argument("--label")
    parser.add_argument("--resume", help="an existing results directory to complete")
    args = parser.parse_args(argv)

    import analyze
    from cases import PRESETS, generate
    from cases.calibration import load

    if args.resume:
        results = Path(args.resume).resolve()
        config = json.loads((results / "config.json").read_text())
        fresh_builds = build_profiles(config["profiles"])
        problems = []
        if config["experiment_version"] != EXPERIMENT_VERSION:
            problems.append("experiment version changed")
        for name in config["profiles"]:
            for key in ("typescript_key", "agentpkg_key"):
                if fresh_builds[name][key] != config["builds"][name][key]:
                    problems.append(f"{name}: {key} changed (production or patch sources differ)")
        if experiment_fingerprint() != config["experiment_code_sha256"]:
            problems.append(
                "the experiment's own code changed (harness, cases, run.py or analyze.py)"
            )
        manifest_path = results / "paper_manifest.json"
        if hashlib.sha256(manifest_path.read_bytes()).hexdigest() != config["manifest_sha256"]:
            problems.append("paper_manifest.json was modified")
        calibration = load(results / "calibration.json")
        if calibration["sha256"] != config["calibration_sha256"]:
            problems.append("calibration changed")
        catalog = generate(config["seed"], config["preset"], calibration)
        if catalog["sha256"] != config["catalog_sha256"]:
            problems.append("catalog changed")
        if problems:
            raise SystemExit("refusing to resume: " + "; ".join(problems))
        print(
            f"resuming {rel(results)}: configuration, builds, calibration and catalog verified",
            flush=True,
        )
    else:
        preset = PRESETS[args.preset]
        profiles = list(preset.profiles)
        if args.profiles:
            wanted = args.profiles.split(",")
            unknown = [name for name in wanted if name not in profiles]
            if unknown:
                raise SystemExit(f"profiles not in preset {preset.name}: {unknown}")
            profiles = wanted
        if "full" not in profiles:
            profiles = ["full", *profiles]
        started = datetime.now(UTC)
        name = (
            started.strftime("%Y-%m-%dT%H-%M-%SZ")
            + f"_{preset.name}"
            + (f"_{args.label}" if args.label else "")
        )
        results = Path(args.results_dir).resolve() / name
        results.mkdir(parents=True, exist_ok=False)  # never overwrite a prior result
        (results / "command.txt").write_text(
            " ".join(
                [
                    Path(sys.executable).name,
                    rel(Path(__file__)),
                    *(argv if argv is not None else sys.argv[1:]),
                ]
            )
            + "\n"
        )
        print(f"results: {rel(results)}", flush=True)
        print("building profiles ...", flush=True)
        builds = build_profiles(sorted(set(profiles) | {"full"}))
        patches = results / "patches"
        patches.mkdir()
        for profile_name, build in builds.items():
            for suffix in ("py", "ts"):
                diff = build.pop(f"_diff_{suffix}")
                if diff:
                    (patches / f"{profile_name}.{suffix}.diff").write_text(diff)
        config = {
            "experiment": EXPERIMENT_NAME,
            "experiment_version": EXPERIMENT_VERSION,
            "threat_model_version": THREAT_MODEL_VERSION,
            "seed": args.seed,
            "preset": preset.name,
            "preset_description": preset.description,
            "budget": preset.budget,
            "limit": preset.limit,
            "profiles": profiles,
            "jobs": args.jobs,
            "started_utc": started.isoformat(),
            "experiment_code_sha256": experiment_fingerprint(),
            "execution_order": (
                "Each profile's cases are split into --jobs shards by catalog index (index mod "
                "shards); a "
                "worker runs its shard in catalog order; shards are queued profile by profile in "
                "the order "
                "of `profiles`. Each record carries its shard and sequence number."
            ),
            "builds": builds,
        }
        (results / "config.json").write_text(json.dumps(config, indent=1, sort_keys=True) + "\n")
        print("calibrating (benign runs on the full system) ...", flush=True)
        code = asyncio.run(run_worker(results, "full", 0, 1, builds["full"], calibrate=True))
        if code != 0:
            raise SystemExit(f"calibration failed (see {rel(results / 'logs')})")
        calibration = load(results / "calibration.json")
        catalog = generate(args.seed, preset.name, calibration)
        write_catalog(results, catalog)
        config["calibration_sha256"] = calibration["sha256"]
        config["catalog_sha256"] = catalog["sha256"]
        config["counts"] = catalog["counts"]
        config["expected_executions"] = (
            catalog["counts"]["violations"] + catalog["counts"]["controls"]
        ) * len(profiles)
        (results / "config.json").write_text(json.dumps(config, indent=1, sort_keys=True) + "\n")
        metadata = {
            **git_state(),
            "python": platform.python_version(),
            "node": _run(["node", "--version"]),
            "platform": platform.platform(),
            "agentpkg_production": rel(AGENTPKG_SRC),
            "packages": [package_identity(key) for key in PACKAGES],
            "openclaw_verified_by_plugin": paths.OPENCLAW_VERIFIED,
            "network": "none: every model, tool, DNS answer and PDF parse is synthetic; sockets, "
            "child processes and sensitive opens are refused in every worker",
        }
        (results / "metadata.json").write_text(
            json.dumps(metadata, indent=1, sort_keys=True) + "\n"
        )
        manifest = manifest_for(config, metadata, catalog)
        manifest_bytes = (json.dumps(manifest, indent=1, sort_keys=True) + "\n").encode()
        (results / "paper_manifest.json").write_bytes(manifest_bytes)
        config["manifest_sha256"] = hashlib.sha256(manifest_bytes).hexdigest()
        (results / "config.json").write_text(json.dumps(config, indent=1, sort_keys=True) + "\n")
        print(
            f"catalog: {catalog['counts']['templates']} templates, "
            f"{catalog['counts']['violations']} violations, "
            f"{catalog['counts']['controls']} controls x {len(profiles)} profiles = "
            f"{config['expected_executions']} runs",
            flush=True,
        )
        print(
            f"manifest frozen: paper_manifest.json sha256 {config['manifest_sha256'][:16]}",
            flush=True,
        )
    started = time.perf_counter()
    asyncio.run(execute(results, config, args.jobs))
    print(f"executed in {time.perf_counter() - started:.1f} s; analyzing ...", flush=True)
    summary = analyze.analyze(results)
    print(analyze.headline(summary), flush=True)
    print(f"report: {rel(results / 'report.md')}", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
