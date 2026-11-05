"""The `Cr` driver's Python side (PROTOCOL.md §2.1, D-353): build the Node driver beside a private
copy of the Chrome core, run one job, and write the campaign run record.

The build copies `chrome-agent-browser/src` into `experiments/campaigns/.cache/cr-<key>/src`
(git-ignored; the production tree is only read), places `driver/node/driver.ts` beside it,
type-checks the copy with the core's own TypeScript and bundles the driver and the compute Worker
entry with the core's own esbuild (as T30's catalog builds do, D-301). The key hashes the core's
sources, the driver, the lockfile and the tool versions, so an unchanged tree is reused. It needs
`npm ci` in `chrome-agent-browser`.
"""

from __future__ import annotations

import hashlib
import json
import os
import shutil
import subprocess
import time
from pathlib import Path

from campaigns.driver import record
from campaigns.driver.py_driver import PACKAGES, prepare_memory, webair_grants
from campaigns.driver.responder import Responder
from campaigns.driver.routes import Rung
from campaigns.origin import tls

ROOT = Path(__file__).resolve().parents[3]
CHROME = ROOT / "chrome-agent-browser"
CHROME_SRC = CHROME / "src"
NODE_MODULES = CHROME / "node_modules"
TSC = NODE_MODULES / "typescript" / "bin" / "tsc"
ESBUILD = NODE_MODULES / "esbuild" / "lib" / "main.js"
DRIVER = Path(__file__).resolve().parent / "node"
CACHE = Path(__file__).resolve().parents[1] / ".cache"

BUNDLE = """
import {{ build }} from {esbuild};
const common = {{
  bundle: true, minify: false, sourcemap: false, legalComments: "inline", logLevel: "warning",
  format: "esm", platform: "node", target: ["node24"],
}};
await build({{ ...common, entryPoints: [{driver}], outfile: {driver_out} }});
await build({{ ...common, entryPoints: [{worker}], outfile: {worker_out} }});
"""


def _tree(root: Path, suffixes: tuple[str, ...]) -> str:
    digest = hashlib.sha256()
    for path in sorted(root.rglob("*")):
        if path.is_file() and path.suffix in suffixes:
            digest.update(path.relative_to(root).as_posix().encode() + b"\0")
            digest.update(path.read_bytes() + b"\0")
    return digest.hexdigest()


def _tools() -> str:
    tsc = json.loads((NODE_MODULES / "typescript" / "package.json").read_text())["version"]
    esb = json.loads((NODE_MODULES / "esbuild" / "package.json").read_text())["version"]
    node = subprocess.run(["node", "--version"], capture_output=True, text=True).stdout.strip()
    return f"tsc {tsc}; esbuild {esb}; node {node}"


def build_key() -> str:
    material = (
        _tree(CHROME_SRC, (".ts", ".json"))
        + _tree(DRIVER, (".ts", ".json"))
        + (CHROME / "package-lock.json").read_text()
        + _tools()
    )
    return hashlib.sha256(material.encode()).hexdigest()[:20]


def build() -> Path:
    """The bundled driver (`<build>/driver/driver.js`), built once per key."""
    if not TSC.is_file():
        raise RuntimeError("the Cr driver needs `npm ci` in chrome-agent-browser")
    key = build_key()
    target = CACHE / f"cr-{key}"
    if (target / ".complete").is_file():
        return target
    staging = CACHE / f".staging-cr-{key}-{os.getpid()}"
    shutil.rmtree(staging, ignore_errors=True)
    staging.mkdir(parents=True)
    shutil.copytree(CHROME_SRC, staging / "src")
    (staging / "driver").mkdir()
    for name in ("driver.ts", "tsconfig.json"):
        shutil.copy2(DRIVER / name, staging / "driver" / name)
    shutil.copy2(CHROME / "package.json", staging / "package.json")
    os.symlink(NODE_MODULES, staging / "node_modules")
    checked = subprocess.run(
        ["node", str(TSC), "-p", str(staging / "driver" / "tsconfig.json")],
        cwd=staging,
        capture_output=True,
        text=True,
        timeout=900,
    )
    if checked.returncode != 0:
        raise RuntimeError(f"tsc failed:\n{checked.stdout[-4000:]}\n{checked.stderr[-2000:]}")
    script = BUNDLE.format(
        esbuild=json.dumps(ESBUILD.as_uri()),
        driver=json.dumps(str(staging / "driver" / "driver.ts")),
        driver_out=json.dumps(str(staging / "driver" / "driver.js")),
        worker=json.dumps(str(staging / "src" / "compute-worker-node.ts")),
        worker_out=json.dumps(str(staging / "driver" / "compute-worker.js")),
    )
    bundled = subprocess.run(
        ["node", "--input-type=module", "-e", script],
        cwd=staging,
        capture_output=True,
        text=True,
        timeout=600,
    )
    if bundled.returncode != 0:
        raise RuntimeError(f"esbuild failed:\n{bundled.stderr[-4000:]}")
    (staging / "node_modules").unlink()
    (staging / "build.json").write_text(
        json.dumps(
            {
                "key": key,
                "tools": _tools(),
                "source_sha256": _tree(staging / "src", (".ts", ".json")),
                "driver_sha256": hashlib.sha256(
                    (staging / "driver" / "driver.js").read_bytes()
                ).hexdigest(),
            },
            indent=2,
        )
    )
    (staging / ".complete").write_text("")
    if target.exists():
        shutil.rmtree(staging)
    else:
        staging.rename(target)
    return target


def run_job(job: dict, *, timeout: float = 3600) -> dict:
    built = build()
    try:
        done = subprocess.run(
            ["node", str(built / "driver" / "driver.js")],
            input=json.dumps(job),
            capture_output=True,
            text=True,
            timeout=timeout,
        )
    except subprocess.TimeoutExpired:
        # A stalled job (a hosted request that never answers) is this unit's harness error, not
        # the campaign's end (review 1, finding 9); `subprocess.run` has killed the child.
        return {"status": "harness_error", "error": f"the Cr driver ran over {timeout:g} s"}
    lines = [line for line in done.stdout.splitlines() if line.startswith("{")]
    if not lines:
        return {
            "status": "harness_error",
            "error": f"the Cr driver exited {done.returncode}: {done.stderr[-500:]}",
        }
    return json.loads(lines[-1])


def route_of(rung: Rung | None) -> dict:
    if rung is None:
        return {"kind": "refuse", "model": "refuse"}
    return {
        "kind": rung.provider,
        "model": rung.model,
        "base_url": rung.base_url,
        "context_window": rung.context_window,
        "temperature": rung.temperature,
        "think": rung.think,
        "api_key_env": rung.api_key_env,
        "timeout_seconds": rung.timeout_seconds,
    }


def record_texts(memory_dir: Path) -> list[str]:
    return [p.read_text() for p in sorted(Path(memory_dir).glob("*/*.md"))]


def webair_job(
    *,
    turns: list[str],
    rung: Rung | None,
    memory_dir: Path,
    stack,
    responder: Responder,
    fixture_key: str | None,
    grant_profile: bool = False,
    probe_proposals=None,
    tool_ids: list[str] | None = None,
) -> dict:
    grants, memory_flags = webair_grants(grant_profile)
    package, key = PACKAGES["webair"]
    job = {
        "package": str(package),
        "trust_key": str(key),
        "transcript": {
            "schema": "conversation.transcript.v0",
            "turns": [{"message": {"message": text}} for text in turns],
        },
        "grants": grants,
        "approved_tools": sorted(tool_ids if tool_ids is not None else _tool_ids()),
        "records": record_texts(memory_dir),
        "memory_grants": dict(flag.split("=", 1) for flag in memory_flags),
        "route": route_of(rung),
        "mapping": None
        if stack is None
        else {
            "hosts": {h: [a, p] for h, (a, p) in stack.hosts.items()},
            "ca": str(stack.ca),
            "fixture_key": fixture_key,
            "fixture_hosts": [tls.WEBAIR_HOST],
        },
        "responder": responder.describe(),
    }
    if probe_proposals is not None:
        job["probe_proposals"] = probe_proposals
    return job


def _tool_ids() -> list[str]:
    from campaigns.baseline import ports

    return list(ports.load("webair").tools)


def run_webair(
    *,
    turns: list[str],
    rung: Rung | None,
    run_dir: Path,
    stack,
    responder: Responder,
    fixture_key: str | None,
    grant_profile: bool = False,
    profile_insertion: str | None = None,
    meta: dict,
) -> dict:
    """One WebAir conversation (TS-W, TS-C) on `Cr`; returns the campaign run record."""
    from campaigns.baseline import ports

    run_dir.mkdir(parents=True, exist_ok=False)
    package = ports.load("webair")  # verified once per run
    memory_dir = prepare_memory(run_dir, profile_insertion)
    job = webair_job(
        turns=turns,
        rung=rung,
        memory_dir=memory_dir,
        stack=stack,
        responder=responder,
        fixture_key=fixture_key,
        grant_profile=grant_profile,
        tool_ids=list(package.tools),
    )
    origin_start = len(stack.origin_log) if stack else 0
    sink_start = len(stack.sink.log) if stack else 0
    started = time.monotonic()
    out = run_job(job)
    seconds = time.monotonic() - started
    responder.decisions.extend(out.get("responder") or [])
    return record.write(
        run_dir,
        record.from_cr_conversation(
            meta=meta,
            rung=rung,
            out=out,
            origin_log=stack.origin_log[origin_start:] if stack else [],
            sink_log=stack.sink.log[sink_start:] if stack else [],
            seconds=seconds,
            package=package,
            memory_grants=dict(job["memory_grants"]),  # the grants this run made
        ),
    )
