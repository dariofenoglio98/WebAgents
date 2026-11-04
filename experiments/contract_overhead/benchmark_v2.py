#!/usr/bin/env python3
"""Contract-overhead benchmark v2 (E7, `experiments/PROTOCOL.md` §3 E7; T38, D-305).

The package-to-execution contract on **both runtimes**, for Meeting Agenda 0.2.2 (the unchanged
baseline), Literature Review 0.2.9, WebAir 0.8.0 and the Travel Network 0.1.0, with v1's protocol
(50 warmup, 5 x 200, seeded package order, offline guards, every observation kept; three runs
pooled by `aggregate_v2.py`), plus the per-operation run-time costs of the extensions.

* **Python** (`runtime=py`): v1's seven production operations, in this process: `ControlPlane`
  open, authorize, evaluate, prepare, the run start's revalidation and lease, then the runner's
  `ExecutionSession` `execution.begin` and `execution.run` up to the first wave. WebAir 0.8.0 is a
  conversation, which the one-shot execution host refuses by design (V-28): its runner stages are
  `agentpkg converse`'s composition (the leased bytes verified, the conversation started) and its
  first turn's prologue up to the first wave.
* **Node** (`runtime=ts`): the same seven operations on the Chrome core, in the order the
  extension's service worker and execution host call them (`node/bench.ts`), bundled here with
  the core's own esbuild and spawned once per arm. A conversation's turn runs through the same
  `ExecutionSession` with its `TurnStart`, as the extension runs it.
* **Per-operation arms** (both runtimes, one production call per observation): the egress
  scanner (the model-request scan, M-37, and the tool-argument scan, M-36) over documents of 1 KiB
  ... 1 MiB and scan sets of 10 ... 1,000 sealed values; a compute call cold and warm; the
  delegation worst case, the exact enumerator under its effort cap and a route request's
  availability for networks of 3 ... 8 roles; the transition check; the consent gate.

`benchmark.py` and `analyze.py` (v1) are imported for their guards, the first-wave stop, the
runner projection and the machine facts, never edited (rule 2). Nothing is pooled with v1
(D-019). Run from the repository root:

    agentpkg/.venv/bin/python experiments/contract_overhead/benchmark_v2.py --label v2-run1
"""

from __future__ import annotations

import argparse
import asyncio
import copy
import csv
import hashlib
import json
import os
import random
import shutil
import string
import subprocess
import sys
import tempfile
import time
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from uuid import uuid4

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))

import benchmark as v1

FIXTURES = HERE / "fixtures_v2"
RESULTS = HERE / "results"
NODE_DIR = HERE / "node"
CACHE = HERE / ".cache"
CHROME = ROOT / "chrome-agent-browser"
CHROME_NODE_MODULES = CHROME / "node_modules"
TSC = CHROME_NODE_MODULES / "typescript" / "bin" / "tsc"
ESBUILD = CHROME_NODE_MODULES / "esbuild" / "lib" / "main.js"
PROTOCOL = ROOT / "experiments" / "PROTOCOL.md"
WORLD = CHROME / "test" / "fixtures" / "authorization" / "inputs.json"

BENCHMARK_NAME = "contract_overhead_v2"
BENCHMARK_VERSION = "2.0.0"
DEFAULT_WARMUP = 50
DEFAULT_BATCHES = 5
DEFAULT_ITERATIONS = 200
DEFAULT_SEED = 20261104
MODEL_ID = "ollama/qwen3:30b"
SESSION_TTL_SECONDS = 7200
FIXTURE_CAPTURED_AT = "2026-11-04T00:00:00.000Z"
RUNTIMES = ("py", "ts")
PY_IMPLEMENTATION_KINDS = (
    "json_http",
    "local_builtin",
    "selected_file",
    "host_resource",
)
# The binding fields `hosttools.py::normalize_binding` accepts (the extension adds `fallback`, its
# Crossref fallback endpoint, which the reference shell has no notion of).
PY_BINDING_FIELDS = frozenset(
    {
        "id",
        "tool_id",
        "binding",
        "implementation_kind",
        "implementation_id",
        "implementation_version",
        "display_name",
        "description",
        "remote",
        "available",
        "availability_reason",
        "enabled",
        "endpoint",
        "contract",
        "limits",
        "credentials",
        "resource_type",
    }
)

STAGES = v1.STAGES
TOTAL = v1.TOTAL
# The paper's four groups (v1's Table III rows), as stage ranges.
GROUPS = {
    "verification": ("package_open_verify",),
    "authorization_and_binding": ("authorization_receipt", "compatibility_evaluation"),
    "run_plan": ("run_plan_preparation",),
    "revalidation": (
        "host_revalidation_lease",
        "runner_verification",
        "workflow_start",
    ),
}

# The per-operation grids (D-305).
SCAN_PAYLOAD_KIB = (1, 16, 256, 1024)
SCAN_SET_SIZES = (10, 100, 1000)
NETWORK_ROLES = (3, 4, 5, 6, 7, 8)
NETWORK_TOPOLOGIES = ("star", "mesh")
COMPUTE_INPUT = {
    "currency": "USD",
    "tax_rate_bps": 810,
    "items": [
        {"label": "Fare", "amount_cents": 61200, "quantity": 1},
        {"label": "Seat", "amount_cents": 2500, "quantity": 1},
    ],
}


@dataclass(frozen=True)
class PackageSpec:
    key: str
    label: str
    archive: Path
    publisher_key: Path
    task_input: Path


PACKAGES = (
    PackageSpec(
        "meeting-agenda",
        "Meeting Agenda",
        ROOT / "dist/meeting-agenda-0.2.2.agent.pkg",
        ROOT / "examples/keys/meeting-agenda-publisher.pub.pem",
        FIXTURES / "meeting-agenda-input.json",
    ),
    PackageSpec(
        "literature-review",
        "Literature Review",
        ROOT / "dist/literature-review-0.2.9.agent.pkg",
        ROOT / "examples/keys/literature-review-publisher.pub.pem",
        FIXTURES / "literature-review-input.json",
    ),
    PackageSpec(
        "webair",
        "WebAir",
        ROOT / "dist/webair-0.8.0.agent.pkg",
        ROOT / "examples/keys/webair-publisher.pub.pem",
        FIXTURES / "webair-input.json",
    ),
    PackageSpec(
        "travel-network",
        "Travel Network",
        ROOT / "dist/travel-network-0.1.0.agent.pkg",
        ROOT / "examples/keys/travel-network-publisher.pub.pem",
        FIXTURES / "travel-network-input.json",
    ),
)
SPECS = {spec.key: spec for spec in PACKAGES}


def sha256_file(path: Path) -> str:
    return v1._sha256_file(path)


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def load_json(path: Path):
    return json.loads(Path(path).read_text(encoding="utf-8"))


def rel(path: Path) -> str:
    try:
        return str(Path(path).resolve().relative_to(ROOT))
    except ValueError:
        return str(path)


# -- host fixtures -------------------------------------------------------------------------------
FIXTURE_FILES = (
    "host-model-catalog.json",
    "host-resource-registry.json",
    "authorization.json",
    *(f"host-tool-registry.{spec.key}.json" for spec in PACKAGES),
    *(spec.task_input.name for spec in PACKAGES),
)


def fixture_hashes() -> dict:
    return {name: sha256_file(FIXTURES / name) for name in FIXTURE_FILES}


def generate_fixtures(bundle: Path, out_dir: Path) -> None:
    """The host fixtures: the model catalog and resource registry of the conformance world (both
    runtimes' control planes normalize them, conformance/drivers), and per package the tool
    registry the extension's own `buildHostToolRegistry` builds for it on a host whose memory
    store holds no record (the production host of these packages; the OpenClaw plugin is frozen,
    D-029, and knows none of their extensions)."""
    out_dir.mkdir(parents=True, exist_ok=True)
    world = load_json(WORLD)
    (out_dir / "host-model-catalog.json").write_text(
        json.dumps(world["catalog"], indent=2) + "\n"
    )
    (out_dir / "host-resource-registry.json").write_text(
        json.dumps(world["resource_registry"], indent=2) + "\n"
    )
    config = {
        "out_dir": str(out_dir),
        "captured_at": FIXTURE_CAPTURED_AT,
        "packages": [
            {"key": spec.key, "archive": str(spec.archive)} for spec in PACKAGES
        ],
    }
    with tempfile.TemporaryDirectory() as scratch:
        node_op(bundle, "fixtures", config, Path(scratch))
    # The Python control plane is the reference shell's (`agentpkg/browser/hosttools.py`): it
    # knows four implementation kinds and no `memory_agent` (Agent Memory's agent-document tools,
    # which only the extension binds). Its host registers what it has: the same bindings without
    # those. A package that needs them gets no ready plan there, which the run records (D-305).
    for spec in PACKAGES:
        path = out_dir / f"host-tool-registry.{spec.key}.json"
        registry = load_json(path)
        registry["bindings"] = [
            {field: value for field, value in b.items() if field in PY_BINDING_FIELDS}
            for b in registry["bindings"]
            if b["implementation_kind"] in PY_IMPLEMENTATION_KINDS
        ]
        path.write_text(json.dumps(registry, indent=2) + "\n")


def check_fixtures(bundle: Path) -> list[str]:
    """Regenerate into a scratch directory and compare byte for byte."""
    with tempfile.TemporaryDirectory() as scratch:
        generate_fixtures(bundle, Path(scratch) / "fixtures")
        problems = []
        for name in ("host-model-catalog.json", "host-resource-registry.json") + tuple(
            f"host-tool-registry.{spec.key}.json" for spec in PACKAGES
        ):
            fresh = (Path(scratch) / "fixtures" / name).read_bytes()
            if fresh != (FIXTURES / name).read_bytes():
                problems.append(name)
        return problems


# -- the Node build ------------------------------------------------------------------------------
# esbuild's onLoad hook appends one line to the network runner, so that the module-private
# transition check is reachable by the benchmark (it is timed in both runtimes); no statement
# of the file changes.
EXPOSE_SUFFIX = "\nexport { checkTransition };\n"
BUNDLE = """
import {{ build }} from {esbuild};
import {{ readFile }} from "node:fs/promises";
const expose = {{
  name: "expose-check-transition",
  setup(b) {{
    b.onLoad({{ filter: /core[\\\\/]network[\\\\/]runner\\.ts$/ }}, async (args) => ({{
      contents: (await readFile(args.path, "utf8")) + {suffix},
      loader: "ts",
    }}));
  }},
}};
const common = {{
  bundle: true, minify: false, sourcemap: false, legalComments: "inline", logLevel: "warning",
  format: "esm", platform: "node", target: ["node24"],
}};
await build({{ ...common, entryPoints: [{bench}], outfile: {bench_out}, plugins: [expose] }});
await build({{ ...common, entryPoints: [{worker}], outfile: {worker_out} }});
"""


def tree_digest(base: Path, suffixes: tuple[str, ...]) -> str:
    digest = hashlib.sha256()
    for path in sorted(base.rglob("*")):
        if path.is_file() and path.suffix in suffixes:
            digest.update(str(path.relative_to(base)).encode())
            digest.update(b"\0")
            digest.update(path.read_bytes())
    return digest.hexdigest()


def tool_versions() -> dict:
    return {
        "typescript": load_json(CHROME_NODE_MODULES / "typescript" / "package.json")[
            "version"
        ],
        "esbuild": load_json(CHROME_NODE_MODULES / "esbuild" / "package.json")[
            "version"
        ],
        "node": subprocess.run(
            ["node", "--version"], capture_output=True, text=True, check=False
        ).stdout.strip(),
    }


def node_build() -> tuple[Path, dict]:
    """The Node benchmark bundled over the production Chrome core (cached by input hash)."""
    tools = tool_versions()
    key = hashlib.sha256(
        (
            tree_digest(CHROME / "src", (".ts", ".json"))
            + tree_digest(NODE_DIR, (".ts", ".json"))
            + (CHROME / "package-lock.json").read_text()
            + json.dumps(tools, sort_keys=True)
            + BUNDLE
        ).encode()
    ).hexdigest()[:20]
    target = CACHE / f"node-{key}"
    info_path = target / "build.json"
    if info_path.is_file():
        return target, load_json(info_path)
    staging = CACHE / f".staging-node-{key}-{os.getpid()}"
    shutil.rmtree(staging, ignore_errors=True)
    staging.mkdir(parents=True)
    checked = subprocess.run(
        ["node", str(TSC), "-p", str(NODE_DIR / "tsconfig.json")],
        cwd=ROOT,
        capture_output=True,
        text=True,
        timeout=900,
        check=False,
    )
    if checked.returncode != 0:
        raise RuntimeError(
            f"tsc failed:\n{checked.stdout[-4000:]}\n{checked.stderr[-2000:]}"
        )
    script = BUNDLE.format(
        esbuild=json.dumps(ESBUILD.as_uri()),
        suffix=json.dumps(EXPOSE_SUFFIX),
        bench=json.dumps(str(NODE_DIR / "bench.ts")),
        bench_out=json.dumps(str(staging / "bench.js")),
        worker=json.dumps(str(CHROME / "src" / "compute-worker-node.ts")),
        worker_out=json.dumps(str(staging / "compute-worker.js")),
    )
    bundled = subprocess.run(
        ["node", "--input-type=module", "-e", script],
        cwd=ROOT,
        capture_output=True,
        text=True,
        timeout=600,
        check=False,
    )
    if bundled.returncode != 0:
        raise RuntimeError(f"esbuild failed:\n{bundled.stderr[-4000:]}")
    info = {
        "key": key,
        "tools": tools,
        "typechecked": True,
        "chrome_src_sha256": tree_digest(CHROME / "src", (".ts", ".json")),
        "bench_source_sha256": sha256_file(NODE_DIR / "bench.ts"),
        "bench_bundle_sha256": sha256_file(staging / "bench.js"),
        "compute_worker_bundle_sha256": sha256_file(staging / "compute-worker.js"),
        "exposed": {
            "file": "chrome-agent-browser/src/core/network/runner.ts",
            "appended": EXPOSE_SUFFIX,
        },
    }
    (staging / "build.json").write_text(json.dumps(info, indent=2) + "\n")
    if target.exists():
        shutil.rmtree(staging, ignore_errors=True)
    else:
        os.replace(staging, target)
    return target, info


def node_op(bundle: Path, op: str, config: dict, workdir: Path) -> dict:
    """Run one op of the Node benchmark in its own process; returns its last stdout line."""
    workdir.mkdir(parents=True, exist_ok=True)
    config_path = workdir / f"node-{op}-{uuid4().hex[:8]}.json"
    config_path.write_text(json.dumps(config))
    completed = subprocess.run(
        ["node", str(bundle / "bench.js"), op, str(config_path)],
        cwd=ROOT,
        capture_output=True,
        text=True,
        check=False,
    )
    if completed.returncode != 0:
        raise RuntimeError(
            f"node {op} failed ({completed.returncode}):\n{completed.stderr[-4000:]}"
        )
    return json.loads(completed.stdout.strip().splitlines()[-1])


# -- the Python pipeline ---------------------------------------------------------------------------
class Fixtures:
    def __init__(self):
        self.catalog = load_json(FIXTURES / "host-model-catalog.json")
        self.resource_registry = load_json(FIXTURES / "host-resource-registry.json")
        self.authorization = load_json(FIXTURES / "authorization.json")["packages"]
        self.registries = {
            spec.key: load_json(FIXTURES / f"host-tool-registry.{spec.key}.json")
            for spec in PACKAGES
        }
        self.inputs = {spec.key: load_json(spec.task_input) for spec in PACKAGES}


def runner_limits() -> dict:
    """The execution host's default limits, the same in both runtimes (D-302), as `execution.begin` takes them."""
    from agentpkg.execution.policy import HostExecutionLimits

    return HostExecutionLimits().as_json()


class PyPipeline:
    """One long-lived control plane, as `browser-serve` holds it, plus a runner per run (v1)."""

    def __init__(self, workdir: Path, fixtures: Fixtures, keys: tuple[str, ...]):
        from agentpkg.browser import ControlPlane, ControlPlaneConfig

        self.workdir = Path(workdir)
        self.fixtures = fixtures
        self.keys = keys
        self.control = ControlPlane(
            ControlPlaneConfig(
                cache_dir=self.workdir / "cache",
                trust_store_path=self.workdir / "trust.json",
                session_ttl_seconds=SESSION_TTL_SECONDS,
            )
        )
        self.limits = runner_limits()
        self.host = {
            "runtime": "openclaw",
            "runtime_version": v1.OPENCLAW_VERIFIED,
            "verified_version": v1.OPENCLAW_VERIFIED,
        }
        self.loop = asyncio.new_event_loop()
        self.stop = v1.FirstWaveStop()
        self.identity: dict[str, dict] = {}
        self.evidence: dict[str, dict] = {}
        self.refusals: dict[str, dict] = {}
        for key in keys:
            self._pin(SPECS[key])
            refusal = self._probe(key)
            if refusal is not None:
                self.refusals[key] = refusal
        self.runnable = tuple(key for key in keys if key not in self.refusals)

    def _probe(self, key: str) -> dict | None:
        """Whether this control plane prepares a ready plan for the package at all (not timed):
        the refusal, by code and reasons, when it does not."""
        from agentpkg.browser.errors import ControlPlaneError
        from agentpkg.package import read_regular_bytes

        spec = SPECS[key]
        decided = self.fixtures.authorization[self.identity[key]["package_id"]]
        data = read_regular_bytes(
            spec.archive, self.control.config.max_package_bytes + 1
        )
        summary = self.control._open_bytes(
            data, {"kind": "file", "display": str(spec.archive)}
        )
        session_id = summary["session"]["id"]
        try:
            receipt = self.control.authorize(
                session_id,
                package_digest=summary["package"]["digest"],
                decisions=decided["decisions"],
                tool_approvals=decided["tool_approvals"],
                resource_registry=self.fixtures.resource_registry,
                resource_selections=decided.get("resource_selections") or {},
                profile_id=decided.get("profile_id"),
            )
            self.control.prepare_run_plan(
                session_id,
                package_digest=summary["package"]["digest"],
                receipt_id=receipt["receipt_id"],
                model_id=MODEL_ID,
                catalog=self.fixtures.catalog,
                tool_registry=self.fixtures.registries[key],
                resource_registry=self.fixtures.resource_registry,
            )
            return None
        except ControlPlaneError as exc:
            details = getattr(exc, "details", None) or {}
            reasons = details.get("blocking_reasons") or []
            return {
                "code": exc.code,
                "message": str(exc)[:400],
                "blocking_reasons": [
                    {"code": r.get("code"), "subject": r.get("subject")}
                    for r in reasons
                ],
            }
        finally:
            self.control.close(session_id)

    def close(self) -> None:
        self.control.shutdown()
        self.loop.close()

    def _pin(self, spec: PackageSpec) -> None:
        """The operator's one-time "Trust this publisher key" at package scope; not timed."""
        from agentpkg.package import read_regular_bytes

        data = read_regular_bytes(
            spec.archive, self.control.config.max_package_bytes + 1
        )
        summary = self.control._open_bytes(
            data, {"kind": "file", "display": str(spec.archive)}
        )
        session_id = summary["session"]["id"]
        try:
            self.control.trust_session_publisher(
                session_id,
                signer_fingerprint=summary["publisher"]["signer_fingerprint"],
                scope="package",
            )
            package = self.control._session(session_id).package
            self.identity[spec.key] = package_identity(spec, package, summary)
        finally:
            self.control.close(session_id)

    def run_once(self, key: str) -> list[int]:
        """Bytes in memory -> first workflow wave about to dispatch; returns t0 ... t7."""
        from agentpkg.package import read_regular_bytes

        spec = SPECS[key]
        control = self.control
        identity = self.identity[key]
        decided = self.fixtures.authorization[identity["package_id"]]
        task = self.fixtures.inputs[key]
        registry = self.fixtures.registries[key]
        resources = self.fixtures.resource_registry
        conversational = identity["conversational"]
        data = read_regular_bytes(spec.archive, control.config.max_package_bytes + 1)
        artifacts_dir = Path(tempfile.mkdtemp(prefix="artifacts-", dir=self.workdir))
        self.stop.reset()
        wire = v1.RunnerWire()
        holder: dict = {}
        session_id = lease_id = None
        fds: list[int] = []
        facts: dict = {}
        self.stop.__enter__()
        try:
            t0 = time.perf_counter_ns()
            summary = control._open_bytes(
                data, {"kind": "file", "display": str(spec.archive)}
            )
            t1 = time.perf_counter_ns()
            session_id = summary["session"]["id"]
            digest = summary["package"]["digest"]
            receipt = control.authorize(
                session_id,
                package_digest=digest,
                decisions=decided["decisions"],
                tool_approvals=decided["tool_approvals"],
                resource_registry=resources,
                resource_selections=decided.get("resource_selections") or {},
                profile_id=decided.get("profile_id"),
            )
            t2 = time.perf_counter_ns()
            models = control.evaluate_models(
                session_id, package_digest=digest, catalog=self.fixtures.catalog
            )
            tools = control.evaluate_tools(
                session_id, package_digest=digest, tool_registry=registry
            )
            t3 = time.perf_counter_ns()
            prepared = control.prepare_run_plan(
                session_id,
                package_digest=digest,
                receipt_id=receipt["receipt_id"],
                model_id=MODEL_ID,
                catalog=self.fixtures.catalog,
                tool_registry=registry,
                resource_registry=resources,
            )
            t4 = time.perf_counter_ns()
            checked = control.validate_input(session_id, input_value=task)
            if checked["valid"] is not True:
                raise AssertionError(f"{key}: task input refused: {checked['errors']}")
            state = control.run_plan(session_id)
            current = control.summary(session_id)
            held = control.authorization(session_id)
            if state["run_plan"].get("tool_bindings"):
                control.evaluate_tools(
                    session_id,
                    package_digest=state["run_plan"]["package"]["digest"],
                    tool_registry=registry,
                )
            binding, authorization = v1.project_for_runner(state["run_plan"], held)
            issued = control.issue_execution_lease(
                session_id,
                package_digest=binding["package"]["digest"],
                run_plan_id=binding["run_plan_id"],
                run_plan_sha256=binding["run_plan_sha256"],
            )
            t5 = time.perf_counter_ns()
            lease_id = issued["lease"]["lease_id"]
            fds.append(os.open(issued["lease"]["path"], os.O_RDONLY | os.O_NOFOLLOW))
            fds.append(
                os.open(artifacts_dir, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
            )
            if conversational:
                conversation, transcript = self._start_conversation(
                    fds[0], binding, authorization, task
                )
                t6 = time.perf_counter_ns()
                outcome = self.loop.run_until_complete(conversation.run(transcript))
                facts.update(begun=None, outcome=outcome)
            else:
                begun = self.loop.run_until_complete(
                    self._begin(holder, wire, fds, binding, authorization, task)
                )
                t6 = time.perf_counter_ns()
                outcome = self.loop.run_until_complete(
                    holder["runner"]("execution.run", {})
                )
                facts.update(begun=begun, outcome=outcome)
            t7 = self.stop.at_ns
            if t7 is None:
                raise AssertionError(
                    f"{key}: the workflow never reached its first wave"
                )
        finally:
            self.stop.__exit__(None, None, None)
            peer = holder.get("peer")
            if peer is not None:
                from agentpkg.hostbridge.errors import BridgeError

                self.loop.run_until_complete(
                    peer.close(BridgeError("bridge_closed", "iteration ended"))
                )
            for fd in fds:
                os.close(fd)
            if session_id is not None:
                if lease_id is not None:
                    control.release_execution_lease(session_id, lease_id)
                control.close(session_id)
            shutil.rmtree(artifacts_dir, ignore_errors=True)
        self._check(
            key,
            summary=summary,
            receipt=receipt,
            models=models,
            tools=tools,
            prepared=prepared,
            state=state,
            current=current,
            issued=issued,
            wire=wire,
            **facts,
        )
        return [t0, t1, t2, t3, t4, t5, t6, t7]

    async def _begin(self, holder, wire, fds, binding, authorization, task):
        from agentpkg.execution import protocol as execution_protocol
        from agentpkg.execution.session import ExecutionSession
        from agentpkg.hostbridge.peer import BridgePeer

        reader = asyncio.StreamReader(limit=v1.execution_protocol_limit())
        peer = BridgePeer(
            reader,
            wire,
            outbound_methods=execution_protocol.RUNNER_OUTBOUND_METHODS,
            inbound_methods=execution_protocol.EXECUTION_METHODS,
            prefix="x",
            version=execution_protocol.EXECUTION_PROTOCOL_VERSION,
        )
        runner = ExecutionSession(peer, package_fd=fds[0], artifacts_fd=fds[1])
        holder["peer"] = peer
        holder["runner"] = runner
        return await runner(
            "execution.begin",
            {
                "run_id": f"run_{uuid4().hex}",
                "run_plan": binding,
                "authorization": authorization,
                "limits": self.limits,
                "input": task,
                "attachments": [],
                "host": self.host,
            },
        )

    def _start_conversation(self, fd, binding, authorization, task):
        """`agentpkg converse`'s composition over the leased bytes: the artifact verified
        against the plan's identity (as the runner verifies it), the transcript checked, the
        turn's adapters, the conversation started (its grants, approvals and limits checked)."""
        from agentpkg.conversation import Conversation
        from agentpkg.conversation.transcript import check_transcript
        from agentpkg.execution.artifact import (
            read_execution_artifact,
            verify_execution_artifact,
        )
        from agentpkg.fixtures import fixture_adapters
        from agentpkg.memory.host import cli_memory

        planned = binding["package"]
        package, _evidence = verify_execution_artifact(
            read_execution_artifact(fd),
            {
                "archive_sha256": planned["archive_sha256"],
                "digest": planned["digest"],
                "package_id": planned["package_id"],
                "version": planned["version"],
                "signer_fingerprint": binding["publisher"]["signer_fingerprint"],
            },
        )
        grants = dict(authorization["decisions"])
        approved = sorted(t for t, ok in authorization["tool_approvals"].items() if ok)
        transcript = {
            "schema": "conversation.transcript.v0",
            "turns": [{"message": task}],
        }
        check_transcript(transcript, package, grants)
        router, handlers, _ = fixture_adapters(package)

        def adapters(_turn):
            memory_run, _folder, _handlers = cli_memory(
                package, mode="fixture", decisions=grants
            )
            return {"router": router, "handlers": handlers, "memory": memory_run}

        conversation = Conversation(
            package, grants=grants, approved_tools=approved, adapters=adapters
        )
        return conversation, transcript

    def _check(
        self,
        key,
        *,
        summary,
        receipt,
        models,
        tools,
        prepared,
        state,
        current,
        issued,
        wire,
        begun,
        outcome,
    ):
        identity = self.identity[key]
        decided = self.fixtures.authorization[identity["package_id"]]
        failures = []

        def expect(condition, message):
            if not condition:
                failures.append(message)

        validation = summary["validation"]
        for layer in ("container_status", "integrity_status", "schema_status"):
            expect(validation[layer] == "valid", f"{layer} is {validation[layer]}")
        expect(
            summary["publisher"]["signature_status"] == "valid", "signature not valid"
        )
        expect(
            summary["publisher"]["trust_status"] == "trusted", "publisher not trusted"
        )
        expect(
            summary["snapshot"]["archive_sha256"] == identity["archive_sha256"],
            "archive hash",
        )
        expect(receipt["runnable"] is True, "receipt not runnable")
        compatible = [m for m in models["models"] if m["model_id"] == MODEL_ID]
        expect(
            bool(compatible) and compatible[0]["status"] == "compatible",
            "model not compatible",
        )
        approved = sorted(t for t, ok in decided["tool_approvals"].items() if ok)
        bound = sorted(t["tool_id"] for t in tools["tools"] if t["status"] == "bound")
        expect(all(t in bound for t in approved), f"approved tools not bound: {bound}")
        plan = prepared["run_plan"]
        expect(plan["readiness"]["ready"] is True, "run plan not ready")
        expect(prepared["preflight"]["ready"] is True, "prepared preflight not ready")
        expect(
            state["preflight"]["ready"] is True and not state["preflight"]["stale"],
            "revalidated preflight",
        )
        expect(
            current["package"]["digest"] == plan["package"]["digest"],
            "summary digest moved",
        )
        expect(issued["preflight"]["ready"] is True, "lease preflight not ready")
        expect(
            sorted(b["tool_id"] for b in plan["tool_bindings"]) == approved,
            "plan tool bindings",
        )
        if begun is not None:
            expect(begun["package"]["signature_status"] == "valid", "runner signature")
            expect(
                begun["package"]["archive_sha256"] == identity["archive_sha256"],
                "runner archive hash",
            )
            expect(
                begun["execution"]["tool_handlers"] == len(approved), "tool handlers"
            )
            expect(
                outcome["error_code"] == "worker_error",
                f"run outcome {outcome.get('error_code')}",
            )
            expect(outcome["audit"]["model_calls"] == 0, "model calls recorded")
            expect(outcome["audit"]["tool_calls"] == 0, "tool calls recorded")
        else:
            turns = outcome["transcript"]["turns"]
            expect(
                len(turns) == 1 and turns[0]["status"] == "failed",
                f"turn outcome {turns}",
            )
        expect(self.stop.hits == 1, f"first-wave stop hit {self.stop.hits} times")
        expect(
            sorted(self.stop.nodes or []) == identity["root_nodes"],
            f"first wave {self.stop.nodes}",
        )
        actions = self.stop.audit_actions or []
        expect("node.started" not in actions, "a node started before the stop")
        expect(
            not any(a.startswith(("model.", "tool.")) for a in actions),
            "model/tool audit event",
        )
        expect(not wire.refused, "runner attempted a non-progress dispatch")
        if failures:
            raise AssertionError(f"{key}: observation invalid: {failures}")
        if key not in self.evidence:
            self.evidence[key] = {
                "run_plan_schema": plan["schema"],
                "tool_bindings": sorted(b["tool_id"] for b in plan["tool_bindings"]),
                "receipt_runnable": receipt["runnable"],
                "runner": "conversation (agentpkg converse composition)"
                if begun is None
                else "ExecutionSession",
                "runner_verified": None
                if begun is None
                else list(begun["package"]["verified"]),
                "first_wave_nodes": list(self.stop.nodes or []),
                "audit_actions_at_stop": actions,
                "runner_outbound_methods": wire.methods(),
            }


def package_identity(spec: PackageSpec, package, summary: dict) -> dict:
    import zipfile

    with zipfile.ZipFile(spec.archive) as archive:
        entries = len(archive.infolist())
    graph = package.graph
    return {
        "label": spec.label,
        "archive": rel(spec.archive),
        "archive_sha256": summary["snapshot"]["archive_sha256"],
        "archive_bytes": summary["snapshot"]["archive_bytes"],
        "archive_entries": entries,
        "package_id": package.manifest["package_id"],
        "package_version": package.manifest["version"],
        "package_digest": package.digest,
        "signer_fingerprint": summary["publisher"]["signer_fingerprint"],
        "publisher_key": rel(spec.publisher_key),
        "runtime_minimum_version": package.manifest["runtime"]["minimum_version"],
        "payload_files": len(package.files),
        "graph_nodes": len(graph["nodes"]),
        "graph_node_types": sorted({node["type"] for node in graph["nodes"]}),
        "worker_roles": len(graph["workers"]),
        "root_nodes": sorted(
            node["id"] for node in graph["nodes"] if not node["depends_on"]
        ),
        "declared_tools": sorted(package.tools),
        "declared_permissions": len(package.policy["permissions"]),
        "modules": len(graph.get("modules") or []),
        "conversational": graph.get("conversation") is not None,
        "network_roles": len((graph.get("network") or {}).get("roles") or {}),
    }


# -- the protocol -----------------------------------------------------------------------------
def schedule(keys, rng: random.Random, rounds: int) -> list[list[str]]:
    """Per round, the package order (v1's scheme, its own seed)."""
    orders = []
    for _ in range(rounds):
        order = list(keys)
        rng.shuffle(order)
        orders.append(order)
    return orders


def full_schedule(
    keys, seed: int, warmup: int, batches: int, iterations: int
) -> list[list[str]]:
    rng = random.Random(seed)
    return schedule(keys, rng, warmup + batches * iterations)


def stage_rows(runtime, key, identity, kind, batch, iteration, position, stamps):
    base = {
        "runtime": runtime,
        "package_key": key,
        "package_version": identity["package_version"],
        "kind": kind,
        "batch": batch,
        "iteration": iteration,
        "position": position,
    }
    rows = [
        {**base, "stage": stage, "elapsed_ns": stamps[index + 1] - stamps[index]}
        for index, stage in enumerate(STAGES)
    ]
    rows.append({**base, "stage": TOTAL, "elapsed_ns": stamps[7] - stamps[0]})
    return rows


def run_py_pre(
    workdir: Path,
    fixtures: Fixtures,
    keys,
    orders,
    warmup,
    batches,
    iterations,
    progress,
):
    pipeline = PyPipeline(workdir / "py", fixtures, keys)
    rows = []
    # The seeded order, without the packages this control plane prepares no plan for.
    orders = [[key for key in order if key in pipeline.runnable] for order in orders]
    try:
        index = 0
        for iteration in range(warmup):
            for position, key in enumerate(orders[index]):
                rows += stage_rows(
                    "py",
                    key,
                    pipeline.identity[key],
                    "warmup",
                    -1,
                    iteration,
                    position,
                    pipeline.run_once(key),
                )
            index += 1
        progress("py: warmup done")
        for batch in range(batches):
            started = time.perf_counter()
            for iteration in range(iterations):
                for position, key in enumerate(orders[index]):
                    rows += stage_rows(
                        "py",
                        key,
                        pipeline.identity[key],
                        "measured",
                        batch,
                        iteration,
                        position,
                        pipeline.run_once(key),
                    )
                index += 1
            progress(
                f"py: batch {batch + 1}/{batches} in {time.perf_counter() - started:.1f} s"
            )
        return rows, pipeline.identity, pipeline.evidence, pipeline.refusals
    finally:
        pipeline.close()


def node_pre_config(workdir: Path, keys, orders, warmup, batches, iterations) -> dict:
    return {
        "root": str(ROOT),
        "out": str(workdir / "ts-pre.jsonl"),
        "packages": [
            {
                "key": key,
                "archive": str(SPECS[key].archive),
                "publisher_key": str(SPECS[key].publisher_key),
                "input": str(SPECS[key].task_input),
                "registry": str(FIXTURES / f"host-tool-registry.{key}.json"),
            }
            for key in keys
        ],
        "catalog": str(FIXTURES / "host-model-catalog.json"),
        "resource_registry": str(FIXTURES / "host-resource-registry.json"),
        "authorization": str(FIXTURES / "authorization.json"),
        "model_id": MODEL_ID,
        "session_ttl_seconds": SESSION_TTL_SECONDS,
        "warmup": warmup,
        "batches": batches,
        "iterations": iterations,
        "schedule": orders,
    }


def run_ts_pre(
    bundle: Path, workdir: Path, keys, orders, warmup, batches, iterations, identity
):
    config = node_pre_config(workdir, keys, orders, warmup, batches, iterations)
    answer = node_op(bundle, "pre", config, workdir)
    rows = []
    with open(config["out"], encoding="utf-8") as stream:
        for line in stream:
            item = json.loads(line)
            key = item["package_key"]
            rows.append(
                {
                    "runtime": "ts",
                    "package_key": key,
                    "package_version": identity[key]["package_version"],
                    "kind": item["kind"],
                    "batch": item["batch"],
                    "iteration": item["iteration"],
                    "position": item["position"],
                    "stage": item["stage"],
                    "elapsed_ns": item["elapsed_ns"],
                }
            )
    return rows, answer


# -- the per-operation inputs (generated here, read by both runtimes) ----------------------------
def _word(rng: random.Random, length: int) -> str:
    return "".join(rng.choice(string.ascii_lowercase) for _ in range(length))


def scan_document(kib: int, seed: int) -> dict:
    """A model-request-shaped document of about `kib` KiB of short strings (no sealed value)."""
    rng = random.Random(seed * 7919 + kib)
    items, size = [], 0
    while size < kib * 1024:
        item = {
            "label": _word(rng, 8),
            "text": " ".join(_word(rng, rng.randint(3, 9)) for _ in range(8)),
            "code": _word(rng, 6).upper(),
        }
        items.append(item)
        size += len(json.dumps(item)) + 2
    return {
        "task": "answer",
        "instructions": ["Answer from the data."],
        "data": {"items": items},
    }


def scan_set(count: int, seed: int) -> list[dict]:
    rng = random.Random(seed * 104729 + count)
    return [
        {
            "record_id": f"rec-{index:04d}",
            "pointer": "/contact_email",
            "value": f"{_word(rng, 12)}@example.org",
        }
        for index in range(count)
    ]


def network_graph(roles: int, topology: str) -> dict:
    """A delegation network of `roles` roles shaped as the Travel Network's (the entry consults
    specialists cloned from its Flights role); `mesh` also lets every specialist hand off to
    every other one. `max_hops` is twice the specialists, so every specialist can be visited."""
    from agentpkg.package import load_package

    graph = copy.deepcopy(load_package(SPECS["travel-network"].archive).graph)
    network = graph["network"]
    template = network["roles"]["Flights"]
    worker_template = next(w for w in graph["workers"] if w["id"] == "Flights")
    entry = network["entry"]
    specialists = [f"S{index}" for index in range(1, roles)]
    new_roles = {entry: copy.deepcopy(network["roles"][entry])}
    new_roles[entry]["edges"] = [{"max_uses": 1, "to": name} for name in specialists]
    for name in specialists:
        role = copy.deepcopy(template)
        others = [n for n in specialists if n != name] if topology == "mesh" else []
        role["edges"] = [{"max_uses": 1, "to": entry}] + [
            {"max_uses": 1, "to": n} for n in others
        ]
        new_roles[name] = role
    network["roles"] = new_roles
    network["max_hops"] = 2 * len(specialists)
    kept = [w for w in graph["workers"] if w["id"] in ("Coordinator", entry)]
    for name in specialists:
        worker = copy.deepcopy(worker_template)
        worker["id"] = name
        kept.append(worker)
    graph["workers"] = kept
    return graph


def micro_inputs(workdir: Path, seed: int, scan_kib, scan_sizes, network_roles) -> dict:
    """Write every per-operation input once; both runtimes read these files."""
    from agentpkg.package import load_package

    base = workdir / "micro"
    base.mkdir(parents=True, exist_ok=True)
    files: dict[str, str] = {}

    def put(name, value) -> str:
        path = base / name
        path.write_text(json.dumps(value, separators=(",", ":")))
        files[name] = sha256_file(path)
        return str(path)

    scans = []
    for kib in scan_kib:
        document = put(f"document-{kib}KiB.json", scan_document(kib, seed))
        for count in scan_sizes:
            scans.append(
                {
                    "cell": f"{kib}KiB-{count}",
                    "kib": kib,
                    "count": count,
                    "document": document,
                    "scan_set": put(f"scan-set-{count}.json", scan_set(count, seed)),
                }
            )
    travel = load_package(SPECS["travel-network"].archive)
    policy = put("network-policy.json", travel.policy)
    networks = []
    for topology in NETWORK_TOPOLOGIES:
        for roles in network_roles:
            networks.append(
                {
                    "cell": f"{topology}-{roles}",
                    "roles": roles,
                    "topology": topology,
                    "graph": put(
                        f"network-{topology}-{roles}.json",
                        network_graph(roles, topology),
                    ),
                    "policy": policy,
                }
            )
    webair = load_package(SPECS["webair"].archive)
    gated_tool, plain_tool = "simulate-purchase", "search-flights"
    return {
        "files": files,
        "scans": scans,
        "compute": {
            "archive": str(SPECS["webair"].archive),
            "module": "fares",
            "function": "run",
            "input": put("compute-input.json", COMPUTE_INPUT),
        },
        "networks": networks,
        "transition": {"archive": str(SPECS["travel-network"].archive)},
        "consent": {
            "archive": str(SPECS["webair"].archive),
            "gated_tool": gated_tool,
            "gated_tool_permissions": list(webair.tools[gated_tool]["permissions"]),
            "plain_tool": plain_tool,
            "plain_tool_permissions": list(webair.tools[plain_tool]["permissions"]),
        },
    }


# -- the per-operation arms, Python -------------------------------------------------------------
def _repeat(rows, arm, cell, warmup, batches, iterations, call):
    for iteration in range(warmup):
        t0 = time.perf_counter_ns()
        call()
        rows.append(
            {
                "runtime": "py",
                "arm": arm,
                "cell": cell,
                "kind": "warmup",
                "batch": -1,
                "iteration": iteration,
                "elapsed_ns": time.perf_counter_ns() - t0,
            }
        )
    for batch in range(batches):
        for iteration in range(iterations):
            t0 = time.perf_counter_ns()
            call()
            rows.append(
                {
                    "runtime": "py",
                    "arm": arm,
                    "cell": cell,
                    "kind": "measured",
                    "batch": batch,
                    "iteration": iteration,
                    "elapsed_ns": time.perf_counter_ns() - t0,
                }
            )


def run_py_micro(
    spec: dict, warmup, batches, iterations, progress
) -> tuple[list[dict], dict]:
    from agentpkg.compute.engine import WasmtimeEngine
    from agentpkg.compute.limits import ComputeLimits
    from agentpkg.delegation.analysis import (
        DEFAULT_EFFORT,
        EffortExceeded,
        enumerate_walks,
        route_data,
        worst_case,
    )
    from agentpkg.delegation.runner import Walk, _check_transition
    from agentpkg.memory.scan import find_all_sealed, find_sealed
    from agentpkg.package import load_package
    from agentpkg.workflow import Workflow

    rows: list[dict] = []
    facts: dict = {}
    args = (warmup, batches, iterations)
    # 1. The egress scanner.
    for cell in spec["scans"]:
        document = load_json(cell["document"])
        scan = load_json(cell["scan_set"])
        if find_all_sealed(document, scan):
            raise AssertionError(
                f"scan cell {cell['cell']}: the document holds a sealed value"
            )
        _repeat(
            rows,
            "scan_model_request",
            cell["cell"],
            *args,
            lambda document=document, scan=scan: find_sealed(document, scan),
        )
        _repeat(
            rows,
            "scan_tool_arguments",
            cell["cell"],
            *args,
            lambda document=document, scan=scan: find_all_sealed(document, scan),
        )
        progress(f"py micro: scan {cell['cell']}")
    # 2. A compute call, cold and warm.
    package = load_package(spec["compute"]["archive"])
    module = next(
        m for m in package.graph["modules"] if m["id"] == spec["compute"]["module"]
    )
    wasm = package.files[module["path"]]
    sha = module["sha256"]
    data = Path(spec["compute"]["input"]).read_bytes()
    limits = ComputeLimits()
    loop = asyncio.new_event_loop()
    function = spec["compute"]["function"]

    # The host's engine, one per process as in production (`default_engine`). Cold: the module
    # compiled by it for the first time (under a cache key it has not seen; both engines key
    # their compiled modules by the declared digest and trust the caller's bytes), then the call;
    # warm: a call on the compiled module.
    warm_engine = WasmtimeEngine()
    counter = iter(range(1 << 30))

    def cold():
        key = f"{sha}#cold-{next(counter)}"
        warm_engine.compile(key, wasm)
        outcome = loop.run_until_complete(warm_engine.call(key, function, data, limits))
        if outcome.reason is not None:
            raise AssertionError(f"compute cold: {outcome.reason}")

    _repeat(rows, "compute_cold", spec["compute"]["module"], *args, cold)
    warm_engine.compile(sha, wasm)
    last = {}

    def warm():
        outcome = loop.run_until_complete(warm_engine.call(sha, function, data, limits))
        if outcome.reason is not None:
            raise AssertionError(f"compute warm: {outcome.reason}")
        last["output"] = outcome.output.decode("utf-8")

    _repeat(rows, "compute_warm", spec["compute"]["module"], *args, warm)
    facts["compute"] = {"output": last.get("output"), "engine": warm_engine.id}
    warm_engine.close()
    loop.close()
    progress("py micro: compute")
    # 3. Delegation analysis against graph size.
    networks = {}
    for cell in spec["networks"]:
        graph = load_json(cell["graph"])
        policy = load_json(cell["policy"])
        network = graph["network"]
        bound = worst_case(graph, policy)
        try:
            walks, capped = len(enumerate_walks(network, effort=DEFAULT_EFFORT)), False
        except EffortExceeded:
            walks, capped = None, True
        networks[cell["cell"]] = {
            "roles": cell["roles"],
            "topology": cell["topology"],
            "walks": walks,
            "effort_exceeded": capped,
            "max_activations": bound["max_activations"],
            "tokens": bound["tokens"],
            "model_calls": bound["model_calls"],
        }

        def enumerate_capped(network=network):
            try:
                enumerate_walks(network, effort=DEFAULT_EFFORT)
            except EffortExceeded:
                pass

        from collections import Counter

        entry = network["entry"]
        _repeat(
            rows,
            "network_worst_case",
            cell["cell"],
            *args,
            lambda graph=graph, policy=policy: worst_case(graph, policy),
        )
        _repeat(rows, "network_enumerate", cell["cell"], *args, enumerate_capped)
        _repeat(
            rows,
            "network_route_data",
            cell["cell"],
            *args,
            lambda network=network, entry=entry: route_data(
                network, entry, {"text": "x"}, Counter(), Counter({entry: 1}), 0
            ),
        )
    facts["networks"] = networks
    progress("py micro: networks")
    # 4. The transition check on the Travel Network's runtime.
    travel = load_package(spec["transition"]["archive"])
    grants = {p["id"]: "session" for p in travel.policy["permissions"]}
    workflow = Workflow(travel, grants=grants)
    runtime = workflow.runtime
    network = travel.graph["network"]
    entry = network["entry"]
    target = network["roles"][entry]["edges"][0]["to"]
    ctx = runtime.coordinator_context()
    node_id = next(n["id"] for n in travel.graph["nodes"] if n["type"] == "network")

    def transition():
        walk = Walk()
        walk.activations[entry] = 1
        _check_transition(
            runtime,
            ctx,
            node_id,
            network,
            entry,
            network["roles"][entry],
            walk,
            {"next": target, "message": {"text": "x"}},
            "model",
        )

    _repeat(rows, "transition_check", "travel-network", *args, transition)
    facts["transition"] = {"audit_events": len(runtime.audit)}
    # 5. The consent gate on WebAir 0.8.0's runtime.
    from agentpkg.conversation.chain import AuditChain
    from agentpkg.conversation.host import TranscriptConsent
    from agentpkg.conversation.runner import TurnContext
    from agentpkg.workflow_values import evaluate

    webair = load_package(spec["consent"]["archive"])
    conversation_id = str(uuid4())
    turn = TurnContext(
        conversation_id=conversation_id,
        turn=1,
        state=copy.deepcopy(evaluate(webair.graph["conversation"]["initial"], {})),
        chain=AuditChain(conversation_id),
        consent=TranscriptConsent({}),
    )
    workflow = Workflow(
        webair,
        grants={p["id"]: "session" for p in webair.policy["permissions"]},
        turn=turn,
    )
    runtime = workflow.runtime
    gated = [
        p for p in spec["consent"]["gated_tool_permissions"] if runtime._gated.get(p)
    ]
    if not gated:
        raise AssertionError("the gated tool links no gated permission")
    for permission in gated:
        runtime._consents[permission] = (
            True  # what an accepted consent step leaves (`call_consent`)
        )
    ctx = runtime.coordinator_context()
    consent = spec["consent"]
    _repeat(
        rows,
        "consent_gate",
        "gated_accepted",
        *args,
        lambda: runtime._check_consent(
            ctx, consent["gated_tool"], consent["gated_tool_permissions"]
        ),
    )
    _repeat(
        rows,
        "consent_gate",
        "not_gated",
        *args,
        lambda: runtime._check_consent(
            ctx, consent["plain_tool"], consent["plain_tool_permissions"]
        ),
    )
    facts["consent"] = {"gated_permissions": gated}
    progress("py micro: transition and consent")
    return rows, facts


def run_ts_micro(
    bundle: Path, workdir: Path, spec: dict, warmup, batches, iterations
) -> tuple[list[dict], dict]:
    config = {
        "root": str(ROOT),
        "out": str(workdir / "ts-micro.jsonl"),
        "warmup": warmup,
        "batches": batches,
        "iterations": iterations,
        "micro": spec,
    }
    answer = node_op(bundle, "micro", config, workdir)
    rows = []
    with open(config["out"], encoding="utf-8") as stream:
        for line in stream:
            item = json.loads(line)
            rows.append(
                {
                    "runtime": "ts",
                    **{
                        k: item[k]
                        for k in (
                            "arm",
                            "cell",
                            "kind",
                            "batch",
                            "iteration",
                            "elapsed_ns",
                        )
                    },
                }
            )
    return rows, answer


def cross_runtime_disagreements(facts: dict) -> list[str]:
    """The two runtimes computed the same thing on the same inputs: each network's bound and walk
    count, the compute call's output, the gated permissions. A difference fails the run."""
    if "py" not in facts or "ts" not in facts:
        return []
    py, ts = facts["py"], facts["ts"]
    problems = []
    for cell, value in py.get("networks", {}).items():
        if ts.get("networks", {}).get(cell) != value:
            problems.append(
                f"network {cell}: {value} != {ts.get('networks', {}).get(cell)}"
            )
    if json.loads(py["compute"]["output"]) != json.loads(ts["compute"]["output"]):
        problems.append("compute output differs")
    if py.get("consent") != ts.get("consent"):
        problems.append("consent gated permissions differ")
    return problems


# -- metadata and output ------------------------------------------------------------------------
def git(*args) -> str | None:
    return v1._run(["git", *args])


def software_metadata(build: dict | None) -> dict:
    import agentpkg

    status = git("status", "--porcelain") or ""
    tracked = [
        line[3:] for line in status.splitlines() if line and not line.startswith("??")
    ]
    untracked = [line[3:] for line in status.splitlines() if line.startswith("??")]
    production = [
        p
        for p in tracked
        if p.startswith(("agentpkg/src", "chrome-agent-browser/src", "dist/"))
    ]
    diff = subprocess.run(
        ["git", "diff", "HEAD"], cwd=ROOT, capture_output=True, check=False
    ).stdout
    return {
        "git_commit": git("rev-parse", "HEAD"),
        "git_dirty": bool(status),
        "git_tracked_changes": tracked,
        "git_untracked": untracked,
        "dirty_tree_sha256": sha256_bytes(diff) if diff else None,
        "git_production_paths_modified": production,
        "agentpkg_version": agentpkg.__version__,
        "agentpkg_source": rel(Path(agentpkg.__file__).resolve().parent),
        "chrome_core_version": load_json(CHROME / "package.json").get("version"),
        "node_build": build,
        "dependencies": {
            name: _version(name)
            for name in (
                "jsonschema",
                "referencing",
                "cryptography",
                "rfc8785",
                "wasmtime",
            )
        },
    }


def _version(name: str) -> str | None:
    try:
        from importlib.metadata import version

        return version(name)
    except Exception:  # noqa: BLE001 - best effort
        return None


def protocol_facts() -> dict:
    text = PROTOCOL.read_text(encoding="utf-8")
    version = next(
        (line for line in text.splitlines() if line.lower().startswith("**version")),
        None,
    )
    return {
        "path": rel(PROTOCOL),
        "sha256": sha256_file(PROTOCOL),
        "version_line": version,
        "section": "§3 E7",
    }


def write_csv(path: Path, fields, rows) -> None:
    with open(path, "w", newline="", encoding="utf-8") as stream:
        writer = csv.DictWriter(stream, fieldnames=list(fields))
        writer.writeheader()
        writer.writerows(rows)


SAMPLE_FIELDS = (
    "runtime",
    "package_key",
    "package_version",
    "kind",
    "batch",
    "iteration",
    "position",
    "stage",
    "elapsed_ns",
)
MICRO_FIELDS = ("runtime", "arm", "cell", "kind", "batch", "iteration", "elapsed_ns")

PRESETS = {
    # (warmup, batches, iterations, scan KiB, scan sizes, network roles)
    "paper": (
        DEFAULT_WARMUP,
        DEFAULT_BATCHES,
        DEFAULT_ITERATIONS,
        SCAN_PAYLOAD_KIB,
        SCAN_SET_SIZES,
        NETWORK_ROLES,
    ),
    "smoke": (2, 2, 3, (1, 16), (10, 100), (3, 4)),
}


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--preset", choices=sorted(PRESETS), default="paper")
    parser.add_argument(
        "--label", default=None, help="Result directory suffix, e.g. v2-run1"
    )
    parser.add_argument("--runtimes", default="py,ts")
    parser.add_argument("--arms", default="pre,micro", help="pre, micro or both")
    parser.add_argument("--packages", default=",".join(SPECS))
    parser.add_argument("--seed", type=int, default=DEFAULT_SEED)
    parser.add_argument(
        "--out",
        type=Path,
        default=RESULTS,
        help="Base directory for the new result directory",
    )
    parser.add_argument(
        "--generate-fixtures",
        action="store_true",
        help="Regenerate fixtures_v2/ and exit",
    )
    parser.add_argument(
        "--check-fixtures", action="store_true", help="Verify fixtures_v2/ and exit"
    )
    args = parser.parse_args(argv)

    bundle, build = node_build()
    if args.generate_fixtures:
        generate_fixtures(bundle, FIXTURES)
        print(json.dumps({"generated": fixture_hashes()}, indent=2))
        return 0
    if args.check_fixtures:
        problems = check_fixtures(bundle)
        print(json.dumps({"passed": not problems, "differs": problems}))
        return 0 if not problems else 1
    problems = check_fixtures(bundle)
    if problems:
        raise SystemExit(
            f"fixtures_v2 out of date: {problems}; run --generate-fixtures"
        )

    warmup, batches, iterations, scan_kib, scan_sizes, network_roles = PRESETS[
        args.preset
    ]
    runtimes = tuple(r for r in args.runtimes.split(",") if r)
    arms = tuple(a for a in args.arms.split(",") if a)
    keys = tuple(k for k in args.packages.split(",") if k)
    if (
        set(runtimes) - set(RUNTIMES)
        or set(arms) - {"pre", "micro"}
        or set(keys) - set(SPECS)
    ):
        raise SystemExit("unknown runtime, arm or package")
    label = args.label or f"v2-{args.preset}"
    if not label.startswith("v2"):
        label = f"v2-{label}"
    started = datetime.now(UTC)
    out = v1.result_directory(args.out, started, label)
    package_hashes_before = {key: sha256_file(SPECS[key].archive) for key in keys}
    orders = full_schedule(keys, args.seed, warmup, batches, iterations)
    config = {
        "preset": args.preset,
        "runtimes": list(runtimes),
        "arms": list(arms),
        "packages": list(keys),
        "warmup": warmup,
        "batches": batches,
        "iterations": iterations,
        "seed": args.seed,
        "order": "per (batch, iteration) every package once, order from random.Random(seed); both runtimes follow the same drawn schedule; warmup the same scheme",
        "scan_payload_kib": list(scan_kib),
        "scan_set_sizes": list(scan_sizes),
        "network_roles": list(network_roles),
        "network_topologies": list(NETWORK_TOPOLOGIES),
        "model_id": MODEL_ID,
        "session_ttl_seconds": SESSION_TTL_SECONDS,
    }
    # The manifest, before the first observation (PROTOCOL.md §2.7).
    manifest = {
        "benchmark": {
            "name": BENCHMARK_NAME,
            "version": BENCHMARK_VERSION,
            "script_sha256": sha256_file(Path(__file__)),
            "node_source_sha256": sha256_file(NODE_DIR / "bench.ts"),
            "v1_helpers_sha256": sha256_file(HERE / "benchmark.py"),
            "config": config,
            "stages": list(STAGES),
            "groups": {k: list(v) for k, v in GROUPS.items()},
        },
        "protocol": protocol_facts(),
        "fixtures": fixture_hashes(),
        "software": software_metadata(build),
        "machine": v1.machine_metadata(),
        "started_at": started.isoformat(),
        "command": " ".join([Path(sys.executable).name, *sys.argv]),
        "expected_observations": {
            "pre_per_runtime_package": batches * iterations if "pre" in arms else 0,
            "micro_per_runtime_cell": batches * iterations if "micro" in arms else 0,
        },
    }
    (out / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")

    def progress(message):
        print(
            f"[{datetime.now(UTC).strftime('%H:%M:%S')}] {message}",
            file=sys.stderr,
            flush=True,
        )

    fixtures = Fixtures()
    workdir = Path(tempfile.mkdtemp(prefix="contract-overhead-v2-"))
    guard = v1.OfflineGuard()
    samples, micro, results = (
        [],
        [],
        {"identity": {}, "evidence": {}, "node": {}, "micro_facts": {}},
    )
    try:
        spec = (
            micro_inputs(workdir, args.seed, scan_kib, scan_sizes, network_roles)
            if "micro" in arms
            else None
        )
        if spec is not None:
            results["micro_inputs"] = {
                "files": spec["files"],
                "cells": {
                    "scans": [c["cell"] for c in spec["scans"]],
                    "networks": [c["cell"] for c in spec["networks"]],
                },
            }
        timing = {}
        # The Python side runs under the offline guard; the Node side runs in its own process
        # under its own guard (bench.ts), spawned between the guarded Python arms.
        if "pre" in arms:
            if "py" in runtimes:
                t = time.perf_counter()
                with guard:
                    rows, identity, evidence, refusals = run_py_pre(
                        workdir,
                        fixtures,
                        keys,
                        orders,
                        warmup,
                        batches,
                        iterations,
                        progress,
                    )
                samples += rows
                results["identity"] = identity
                results["evidence"]["py"] = evidence
                results["py_unrunnable"] = refusals
                timing["py_pre_seconds"] = round(time.perf_counter() - t, 1)
            if "ts" in runtimes:
                if not results["identity"]:
                    results["identity"] = PyPipeline(
                        workdir / "id", fixtures, keys
                    ).identity
                t = time.perf_counter()
                rows, answer = run_ts_pre(
                    bundle,
                    workdir,
                    keys,
                    orders,
                    warmup,
                    batches,
                    iterations,
                    results["identity"],
                )
                samples += rows
                results["evidence"]["ts"] = answer["evidence"]
                results["node"]["pre"] = {
                    "identity": answer["identity"],
                    "guards": answer["guards"],
                }
                timing["ts_pre_seconds"] = round(time.perf_counter() - t, 1)
                progress("ts: pre done")
        if spec is not None:
            if "py" in runtimes:
                t = time.perf_counter()
                with guard:
                    rows, facts = run_py_micro(
                        spec, warmup, batches, iterations, progress
                    )
                micro += rows
                results["micro_facts"]["py"] = facts
                timing["py_micro_seconds"] = round(time.perf_counter() - t, 1)
            if "ts" in runtimes:
                t = time.perf_counter()
                rows, answer = run_ts_micro(
                    bundle, workdir, spec, warmup, batches, iterations
                )
                micro += rows
                results["micro_facts"]["ts"] = answer["facts"]
                results["node"]["micro"] = {"guards": answer["guards"]}
                timing["ts_micro_seconds"] = round(time.perf_counter() - t, 1)
                progress("ts: micro done")
    finally:
        shutil.rmtree(workdir, ignore_errors=True)
    measured = [r for r in samples if r["kind"] == "measured"]
    write_csv(out / "samples.csv", SAMPLE_FIELDS, measured)
    write_csv(
        out / "warmup_samples.csv",
        SAMPLE_FIELDS,
        [r for r in samples if r["kind"] == "warmup"],
    )
    if micro:
        write_csv(
            out / "micro_samples.csv",
            MICRO_FIELDS,
            [r for r in micro if r["kind"] == "measured"],
        )
        write_csv(
            out / "micro_warmup_samples.csv",
            MICRO_FIELDS,
            [r for r in micro if r["kind"] == "warmup"],
        )
    node_violations = [
        v for part in results["node"].values() for v in part["guards"]["violations"]
    ]
    disagreements = cross_runtime_disagreements(results["micro_facts"])
    results["micro_facts_agree"] = not disagreements
    results["micro_facts_disagreements"] = disagreements
    metadata = {
        **manifest,
        **results,
        "timing": timing,
        "finished_at": datetime.now(UTC).isoformat(),
        "guards": {
            "offline_violations": list(guard.violations),
            "node_violations": node_violations,
        },
        "package_file_sha256_before_after_equal": package_hashes_before
        == {key: sha256_file(SPECS[key].archive) for key in keys},
        "observations": {
            "pre": len(measured),
            "micro": len([r for r in micro if r["kind"] == "measured"]),
        },
    }
    (out / "metadata.json").write_text(json.dumps(metadata, indent=2) + "\n")
    import aggregate_v2

    aggregate_v2.analyze_run(out)
    passed = not guard.violations and not node_violations and not disagreements
    print(
        json.dumps(
            {
                "result_directory": rel(out),
                "observations": metadata["observations"],
                "timing": timing,
                "passed": passed,
            }
        )
    )
    return 0 if passed else 1


if __name__ == "__main__":
    raise SystemExit(main())
