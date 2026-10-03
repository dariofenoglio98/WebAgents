#!/usr/bin/env python3
"""Contract-overhead benchmark: local latency of the package-to-execution contract.

Measures, for each current signed package, the wall-clock time from "the
package bytes are in memory" to "the interpreter is about to dispatch the first
workflow node", through the real production operations and nothing else:

    t0  ControlPlane._open_bytes        snapshot, container, integrity, schema,
    t1                                   runtime profile, Ed25519, publisher trust
        ControlPlane.authorize          digest-bound authorization receipt,
    t2                                   with the host's resource grants
        ControlPlane.evaluate_models    host catalog and tool registry against
        ControlPlane.evaluate_tools     the package's declarations
    t3
        ControlPlane.prepare_run_plan   frozen, hashed Run Plan plus preflight
    t4
        validate_input, run_plan,       the plugin's run-start revalidation reads,
        summary, authorization,         then the one-time snapshot lease
        [evaluate_tools],
        issue_execution_lease
    t5
        ExecutionSession execution.begin   the runner's independent re-verification
    t6
        ExecutionSession execution.run     Workflow construction and run prologue,
    t7                                     stopped at the first-wave dispatch

No model, tool, network, subprocess or human decision is involved; guards make
any attempt fail loudly. See DESIGN.md and README.md.

Run from the repository root with the agentpkg virtualenv:

    agentpkg/.venv/bin/python experiments/contract_overhead/benchmark.py
"""

from __future__ import annotations

import argparse
import asyncio
import csv
import gc
import hashlib
import json
import os
import platform
import random
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import zipfile
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from uuid import uuid4

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
FIXTURES = HERE / "fixtures"
RESULTS = HERE / "results"

BENCHMARK_NAME = "contract_overhead"
BENCHMARK_VERSION = "1.1.0"

# Paper protocol defaults (README, "Protocol").
DEFAULT_WARMUP = 50
DEFAULT_BATCHES = 5
DEFAULT_ITERATIONS = 200
DEFAULT_SEED = 20261001
DEFAULT_AUDIT_WARMUP = 200
DEFAULT_AUDIT_BATCHES = 5
DEFAULT_AUDIT_REPEATS = 5
DEFAULT_COMPONENT_WARMUP = 20
DEFAULT_COMPONENT_ITERATIONS = 100

MODEL_ID = "ollama/qwen3:30b"
SESSION_TTL_SECONDS = 7200  # The recorded runs' plugin configuration.
OPENCLAW_VERIFIED = "2026.9.5"

# The production operations, in order, each a direct interval between two
# consecutive boundary timestamps t0..t7.
STAGES = (
    "package_open_verify",
    "authorization_receipt",
    "compatibility_evaluation",
    "run_plan_preparation",
    "host_revalidation_lease",
    "runner_verification",
    "workflow_start",
)
STAGE_LABELS = {
    "package_open_verify": "Package open and verification",
    "authorization_receipt": "Authorization receipt",
    "compatibility_evaluation": "Model and tool compatibility",
    "run_plan_preparation": "Run Plan preparation",
    "host_revalidation_lease": "Host revalidation and lease",
    "runner_verification": "Runner re-verification",
    "workflow_start": "Workflow instantiation and start checks",
}
STAGE_OPERATIONS = {
    "package_open_verify": "ControlPlane._open_bytes",
    "authorization_receipt": (
        "ControlPlane.authorize (with the host resource registry and selections)"
    ),
    "compatibility_evaluation": "ControlPlane.evaluate_models + ControlPlane.evaluate_tools",
    "run_plan_preparation": "ControlPlane.prepare_run_plan (with the host resource registry)",
    "host_revalidation_lease": (
        "ControlPlane.validate_input + run_plan + summary + authorization "
        "[+ evaluate_tools when tools are bound] + issue_execution_lease"
    ),
    "runner_verification": "ExecutionSession('execution.begin')",
    "workflow_start": "ExecutionSession('execution.run') until Workflow dispatches its first wave",
}
# Paper-facing groups: (first boundary, last boundary) over t0..t7, so each is
# one direct interval rather than a sum of summaries.
GROUPS = {
    "verification": (0, 1),
    "authorization_and_binding": (1, 3),
    "run_plan": (3, 4),
    "revalidation": (4, 7),
}
GROUP_LABELS = {
    "verification": "Package verification",
    "authorization_and_binding": "Authorization and binding",
    "run_plan": "Run Plan preparation",
    "revalidation": "Pre-execution revalidation",
}
GROUP_STAGES = {
    "verification": ("package_open_verify",),
    "authorization_and_binding": ("authorization_receipt", "compatibility_evaluation"),
    "run_plan": ("run_plan_preparation",),
    "revalidation": ("host_revalidation_lease", "runner_verification", "workflow_start"),
}
TOTAL = "total_pre_execution"
SECONDARY = "local_file_read"

SAMPLE_FIELDS = (
    "package_key",
    "package_id",
    "package_version",
    "batch",
    "iteration",
    "position",
    "kind",
    "stage",
    "elapsed_ns",
)
TIMESTAMP_FIELDS = (
    "package_key",
    "package_id",
    "package_version",
    "batch",
    "iteration",
    "position",
    "read_ns",
    *(f"t{index}_ns" for index in range(8)),
)


@dataclass(frozen=True)
class PackageSpec:
    key: str
    label: str
    archive: Path
    publisher_key: Path
    task_input: Path
    # A committed audit stream of a recorded live run of this package, for the
    # optional audit-event microbenchmark; None when the repository holds none.
    recorded_audit: Path | None = None


PACKAGES = (
    PackageSpec(
        key="meeting-agenda",
        label="Meeting Agenda",
        archive=ROOT / "dist/meeting-agenda.agent.pkg",
        publisher_key=ROOT / "examples/keys/meeting-agenda-publisher.pub.pem",
        task_input=FIXTURES / "meeting-agenda-input.json",
        recorded_audit=ROOT / "examples/meeting-agenda-022-qwen/audit.json",
    ),
    PackageSpec(
        key="literature-review",
        label="Literature Review",
        archive=ROOT / "dist/literature-review.agent.pkg",
        publisher_key=ROOT / "examples/keys/literature-review-publisher.pub.pem",
        task_input=FIXTURES / "literature-review-input.json",
        recorded_audit=ROOT / "examples/literature-review-live/audit.json",
    ),
    PackageSpec(
        key="webair",
        label="WebAir",
        # The versioned artifact: the `webair.agent.pkg` alias deliberately stays 0.1.0.
        archive=ROOT / "dist/webair-0.3.0.agent.pkg",
        publisher_key=ROOT / "examples/keys/webair-publisher.pub.pem",
        task_input=FIXTURES / "webair-input.json",
    ),
)


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as stream:
        for chunk in iter(lambda: stream.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _load_json(path: Path):
    return json.loads(Path(path).read_text(encoding="utf-8"))


# -- guards -----------------------------------------------------------------
class OfflineViolation(RuntimeError):
    """Something in the measured process tried to leave it."""


class OfflineGuard:
    """Refuse, and count, every socket connection, DNS lookup and child process.

    Installed around the whole benchmark. Nothing on the measured path should
    reach any of these; a refusal is recorded even if a caller swallows the
    exception, and the benchmark fails when the count is not zero.
    """

    def __init__(self):
        self.violations: list[str] = []
        self._saved: list[tuple[object, str, object]] = []

    def _refuse(self, kind: str):
        def refused(*_args, **_kwargs):
            self.violations.append(kind)
            raise OfflineViolation(f"contract_overhead benchmark refused {kind}")

        return refused

    def _patch(self, owner, name: str, kind: str) -> None:
        if hasattr(owner, name):
            self._saved.append((owner, name, getattr(owner, name)))
            setattr(owner, name, self._refuse(kind))

    def __enter__(self):
        self._patch(socket.socket, "connect", "socket.connect")
        self._patch(socket.socket, "connect_ex", "socket.connect_ex")
        self._patch(socket, "create_connection", "socket.create_connection")
        self._patch(socket, "getaddrinfo", "socket.getaddrinfo")
        self._patch(subprocess, "Popen", "subprocess.Popen")
        for name in ("fork", "forkpty", "posix_spawn", "posix_spawnp", "system"):
            self._patch(os, name, f"os.{name}")
        return self

    def __exit__(self, *_exc):
        while self._saved:
            owner, name, value = self._saved.pop()
            setattr(owner, name, value)
        return False


class ForbiddenDispatch(RuntimeError):
    """The runner tried to send something other than a progress snapshot."""


class RunnerWire:
    """The runner's outbound byte stream, held in memory instead of stdout.

    In production these bytes go to the plugin over a pipe. Only two frame
    kinds can legitimately be written here: the progress snapshot the runner
    derives from its own audit, and the bridge's `$/cancel` notification that
    withdraws that snapshot's pending request when the tracker closes. Any
    other frame — a `model.*` or `tool.call` request — is refused at the write,
    so a dispatch fails immediately instead of waiting for an answer that will
    never come.
    """

    ALLOWED = (b'"method":"execution.progress"', b'"method":"$/cancel"')
    ALLOWED_METHODS = frozenset({"execution.progress", "$/cancel"})

    def __init__(self):
        self.frames: list[bytes] = []
        self.refused: list[bytes] = []
        self.closed = False

    def write(self, data: bytes) -> None:
        if not any(marker in data for marker in self.ALLOWED):
            self.refused.append(bytes(data[:256]))
            raise ForbiddenDispatch("benchmark runner refused a non-progress outbound frame")
        self.frames.append(bytes(data))

    async def drain(self) -> None:
        return None

    def close(self) -> None:
        self.closed = True

    def methods(self) -> list[str]:
        from agentpkg.hostbridge import protocol as bridge_protocol

        found = []
        for frame in self.frames:
            decoded = bridge_protocol.decode(
                frame, version=_execution_protocol().EXECUTION_PROTOCOL_VERSION
            )
            found.append(decoded.get("method"))
        return found


def _execution_protocol():
    from agentpkg.execution import protocol

    return protocol


class FirstWaveReached(Exception):  # noqa: N818 - a control signal, not an error
    """Raised in place of dispatching the first wave of workflow nodes."""


class FirstWaveStop:
    """Stop `Workflow.run` exactly where it would start running nodes.

    `Workflow.run` validates the input and the initial state, authorizes state
    access, then hands the first ready wave of node coroutines to the static
    `Workflow._gather`. This replaces that one method, for this process only,
    with a stop that reads the clock, records the wave, closes the coroutines
    (none has started, so no node event exists), and raises. Every line before
    the call is unmodified production code.
    """

    def __init__(self):
        self.reset()
        self._original = None

    def reset(self) -> None:
        self.at_ns: int | None = None
        self.nodes: list[str] | None = None
        self.audit_actions: list[str] | None = None
        self.hits = 0

    def __enter__(self):
        from agentpkg.workflow import Workflow

        self._workflow = Workflow
        self._original = Workflow.__dict__["_gather"]
        stop = self

        async def first_wave(coroutines):
            at = time.perf_counter_ns()
            stop.hits += 1
            nodes = []
            runtime = None
            for coroutine in coroutines:
                frame = coroutine.cr_frame
                if frame is not None:
                    nodes.append(frame.f_locals["node"]["id"])
                    runtime = frame.f_locals["self"].runtime
                coroutine.close()
            if stop.at_ns is None:
                stop.at_ns = at
                stop.nodes = nodes
                stop.audit_actions = (
                    [event["action"] for event in runtime.audit] if runtime is not None else []
                )
            raise FirstWaveReached

        self._workflow._gather = staticmethod(first_wave)
        return self

    def __exit__(self, *_exc):
        self._workflow._gather = self._original
        return False


# -- the runner's view of a plan -------------------------------------------
def _str(value) -> str:
    return value if isinstance(value, str) else ""


def _record(value) -> dict:
    return value if isinstance(value, dict) else {}


def project_for_runner(plan: dict, receipt: dict) -> tuple[dict, dict]:
    """The bounded `run_plan` and `authorization` the plugin sends to the runner.

    A field-for-field mirror of the object `preflight.ts` (`revalidate`, model
    mode) returns as `binding`, and of the authorization `execution.ts`
    (`drive`) sends. It selects fields; it checks nothing. The runner refuses
    unknown fields, so this must match exactly, and
    `tests/test_fidelity.py` compares it with the real TypeScript output.
    That includes the host-resource grants the plan froze, by reference,
    which `revalidate` adds only when there are any (`plannedResources`).
    """
    planned = _record(plan.get("package"))
    publisher = _record(plan.get("publisher"))
    execution = _record(plan.get("execution"))
    tools = [_record(item) for item in plan.get("tool_bindings") or []]
    resources = [
        {
            "permission_id": _str(grant.get("permission_id")),
            "resource_type": _str(grant.get("resource_type")),
            "resource_id": _str(grant.get("resource_id")),
            "resource_digest": _str(grant.get("resource_digest")),
        }
        for grant in (_record(item) for item in plan.get("resource_grants") or [])
    ]
    model = _record(plan.get("model_binding"))
    descriptor = _record(model.get("descriptor"))
    compatibility = _record(model.get("compatibility"))
    required = execution.get("required_permission_ids")
    binding = {
        "run_plan_id": _str(plan.get("run_plan_id")),
        "run_plan_sha256": _str(plan.get("run_plan_sha256")),
        "session_id": _str(plan.get("session_id")),
        "package": {
            "package_id": _str(planned.get("package_id")),
            "name": _str(planned.get("name")),
            "version": _str(planned.get("version")),
            "digest": _str(planned.get("digest")),
            "archive_sha256": _str(planned.get("archive_sha256")),
            "execution_profile": _str(planned.get("execution_profile")),
        },
        "publisher": {
            "signer_fingerprint": _str(publisher.get("signer_fingerprint")),
            "signature_status": _str(publisher.get("signature_status")),
            "trust_status": _str(publisher.get("trust_status")),
        },
        "execution": {
            "mode": "model",
            "profile": _str(execution.get("profile")),
            "required_permission_ids": [_str(item) for item in required]
            if isinstance(required, list)
            else [],
            "required_tool_ids": sorted(_str(item.get("tool_id")) for item in tools),
        },
        "tool_bindings": tools,
        **({"resource_grants": resources} if resources else {}),
        "model_binding": {
            "host_model_id": _str(model.get("host_model_id")),
            "provider_id": _str(model.get("provider_id")),
            "model_id": _str(model.get("model_id")),
            "display_name": _str(model.get("display_name")),
            "compatibility_status": _str(compatibility.get("status")),
            "evidence_strength": _str(compatibility.get("evidence_strength")),
            "capabilities": {
                name: {
                    "value": _record(answer).get("value"),
                    "basis": _str(_record(answer).get("basis")) or None,
                }
                for name, answer in _record(descriptor.get("capabilities")).items()
            },
            "limits": _record(descriptor.get("limits")),
            "properties": {"local": _record(descriptor.get("properties")).get("local")},
        },
    }
    authorization = {
        "receipt_id": _str(receipt.get("receipt_id")),
        "receipt_sha256": _str(receipt.get("receipt_sha256")),
        "issued_at": _str(receipt.get("issued_at")) or None,
        "expires_at": _str(receipt.get("expires_at")) or None,
        "decisions": {key: _str(value) for key, value in _record(receipt.get("decisions")).items()},
        "tool_approvals": {
            key: value is True for key, value in _record(receipt.get("tool_approvals")).items()
        },
    }
    return binding, authorization


def runner_limits(policy: dict) -> dict:
    """The `limits` object `execution.ts` (`drive`) sends with `execution.begin`."""
    return {
        "total_tokens": policy["totalTokens"],
        "max_remote_calls": policy["maxRemoteCalls"],
        "max_parallel_workers": policy["maxParallelWorkers"],
        "max_output_tokens_per_call": policy["maxOutputTokensPerCall"],
        "run_timeout_seconds": policy["runTimeoutSeconds"],
        "max_calls_per_tool": policy["maxCallsPerTool"],
        "model_call_timeout_seconds": policy["modelCallTimeoutSeconds"],
    }


# -- fixtures ----------------------------------------------------------------
@dataclass
class Fixtures:
    catalog: dict
    registry: dict
    policy: dict
    authorization: dict
    inputs: dict
    # What the host holds for the person: ids, labels and digests, no value.
    # The benchmark's host holds resources, so, as the plugin's backend does,
    # every authorize and prepare_run_plan call carries it, for every package.
    resource_registry: dict | None = None
    files: dict = field(default_factory=dict)

    @classmethod
    def load(cls, packages=PACKAGES) -> Fixtures:
        files = {
            "host-model-catalog.json": FIXTURES / "host-model-catalog.json",
            "host-tool-registry.json": FIXTURES / "host-tool-registry.json",
            "host-resource-registry.json": FIXTURES / "host-resource-registry.json",
            "host-execution-policy.json": FIXTURES / "host-execution-policy.json",
            "authorization.json": FIXTURES / "authorization.json",
        }
        for spec in packages:
            files[spec.task_input.name] = spec.task_input
        return cls(
            catalog=_load_json(files["host-model-catalog.json"]),
            registry=_load_json(files["host-tool-registry.json"]),
            policy=_load_json(files["host-execution-policy.json"]),
            authorization=_load_json(files["authorization.json"])["packages"],
            inputs={spec.key: _load_json(spec.task_input) for spec in packages},
            resource_registry=_load_json(files["host-resource-registry.json"]),
            files={
                name: {"path": _rel(path), "sha256": _sha256_file(path)}
                for name, path in files.items()
            },
        )


def _rel(path: Path) -> str:
    try:
        return str(Path(path).resolve().relative_to(ROOT))
    except ValueError:
        return Path(path).name


# -- one observation -----------------------------------------------------------
@dataclass
class Observation:
    package_key: str
    read_ns: int
    stamps: list[int]
    checks: dict


class ContractPipeline:
    """One long-lived control plane, as `browser-serve` holds, plus a runner per run."""

    def __init__(self, workdir: Path, fixtures: Fixtures, packages=PACKAGES):
        from agentpkg.browser import ControlPlane, ControlPlaneConfig

        self.workdir = Path(workdir)
        self.fixtures = fixtures
        self.packages = {spec.key: spec for spec in packages}
        self.control = ControlPlane(
            ControlPlaneConfig(
                cache_dir=self.workdir / "cache",
                trust_store_path=self.workdir / "trust.json",
                session_ttl_seconds=SESSION_TTL_SECONDS,
            )
        )
        self.limits = runner_limits(fixtures.policy)
        self.host = {
            "runtime": "openclaw",
            "runtime_version": fixtures.catalog["host"]["runtime_version"],
            "verified_version": OPENCLAW_VERIFIED,
        }
        self.loop = asyncio.new_event_loop()
        self.stop = FirstWaveStop()
        self.identity: dict[str, dict] = {}
        self.evidence: dict[str, dict] = {}
        for spec in packages:
            self._pin_publisher(spec)

    def close(self) -> None:
        self.control.shutdown()
        self.loop.close()

    # The operator's one-time "Trust this publisher key" action, at package
    # scope, through the same production call the page uses. Not timed.
    def _pin_publisher(self, spec: PackageSpec) -> None:
        from agentpkg.browser.hostresources import RESOURCE_PERMISSION_KINDS
        from agentpkg.package import read_regular_bytes

        data = read_regular_bytes(spec.archive, self.control.config.max_package_bytes + 1)
        summary = self.control._open_bytes(data, {"kind": "file", "display": str(spec.archive)})
        session_id = summary["session"]["id"]
        try:
            self.control.trust_session_publisher(
                session_id,
                signer_fingerprint=summary["publisher"]["signer_fingerprint"],
                scope="package",
            )
            fresh = self.control.summary(session_id)
            package = self.control._session(session_id).package
            with zipfile.ZipFile(spec.archive) as archive:
                entries = len(archive.infolist())
            self.identity[spec.key] = {
                "label": spec.label,
                "archive": _rel(spec.archive),
                "archive_sha256": fresh["snapshot"]["archive_sha256"],
                "archive_bytes": fresh["snapshot"]["archive_bytes"],
                "archive_entries": entries,
                "package_id": package.manifest["package_id"],
                "package_name": package.manifest["name"],
                "package_version": package.manifest["version"],
                "package_digest": package.digest,
                "signer_fingerprint": fresh["publisher"]["signer_fingerprint"],
                "signature_status": fresh["publisher"]["signature_status"],
                "trust_status": fresh["publisher"]["trust_status"],
                "publisher_key": _rel(spec.publisher_key),
                "entrypoint": package.manifest["entrypoint"],
                "runtime_minimum_version": package.manifest["runtime"]["minimum_version"],
                "payload_files": len(package.files),
                "graph_nodes": len(package.graph["nodes"]),
                "graph_node_types": sorted({node["type"] for node in package.graph["nodes"]}),
                "worker_roles": len(package.graph["workers"]),
                "root_nodes": sorted(
                    node["id"] for node in package.graph["nodes"] if not node["depends_on"]
                ),
                "declared_tools": sorted(package.tools),
                "remote_tools": sorted(
                    tool_id
                    for tool_id, tool in package.tools.items()
                    if tool.get("execution") == "remote"
                ),
                "local_tools": sorted(
                    tool_id
                    for tool_id, tool in package.tools.items()
                    if tool.get("execution") != "remote"
                ),
                "declared_tool_details": [
                    {
                        "id": tool_id,
                        "execution": tool.get("execution"),
                        "binding": tool.get("binding"),
                        "permissions": list(tool.get("permissions") or []),
                        "side_effects": tool.get("side_effects"),
                    }
                    for tool_id, tool in sorted(package.tools.items())
                ],
                "declared_permissions": [
                    {
                        "id": item["id"],
                        "kind": item["kind"],
                        "required": item["required"],
                        "resources": list(item.get("resources") or []),
                    }
                    for item in package.policy["permissions"]
                ],
                # Permissions whose scope names a type of host-owned resource.
                "host_resource_permissions": [
                    {
                        "id": item["id"],
                        "resource_types": list(item.get("resources") or []),
                        "required": item["required"],
                    }
                    for item in package.policy["permissions"]
                    if item["kind"] in RESOURCE_PERMISSION_KINDS
                ],
                "model_tasks": len(package.manifest["model_requirements"]["tasks"]),
                "model_capabilities_required": sorted(
                    {
                        capability
                        for task in package.manifest["model_requirements"]["tasks"]
                        for capability in task["capabilities"]
                    }
                ),
                "model_context_window_required": max(
                    task["context_window"]
                    for task in package.manifest["model_requirements"]["tasks"]
                ),
            }
        finally:
            self.control.close(session_id)

    def run_once(self, key: str) -> Observation:
        """Bytes in memory -> first workflow wave about to dispatch. Then tear down."""
        from agentpkg.execution import protocol as execution_protocol
        from agentpkg.execution.session import ExecutionSession
        from agentpkg.hostbridge.errors import BridgeError
        from agentpkg.hostbridge.peer import BridgePeer
        from agentpkg.package import read_regular_bytes

        spec = self.packages[key]
        control = self.control
        fixtures = self.fixtures
        decided = fixtures.authorization[self.identity[key]["package_id"]]
        task = fixtures.inputs[key]
        catalog = fixtures.catalog
        registry = fixtures.registry
        # On a host that holds resources the plugin's backend sends its resource
        # registry with every authorize (plus the person's picks, empty when the
        # package requests none) and every prepare_run_plan. Decided per host,
        # never per package.
        resources = fixtures.resource_registry
        authorize_resources = (
            {
                "resource_registry": resources,
                "resource_selections": decided.get("resource_selections") or {},
            }
            if resources is not None
            else {}
        )
        plan_resources = {"resource_registry": resources} if resources is not None else {}
        run_id = f"run_{uuid4().hex}"
        artifacts_dir = Path(tempfile.mkdtemp(prefix="artifacts-", dir=self.workdir))
        self.stop.reset()
        wire = RunnerWire()
        holder: dict = {}
        session_id = None
        lease_id = None
        fds: list[int] = []

        async def begin(params):
            reader = asyncio.StreamReader(limit=execution_protocol_limit())
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
            return await runner("execution.begin", params)

        async def run():
            return await holder["runner"]("execution.run", {})

        # Secondary metric only: the operator file read `open_file` performs.
        r0 = time.perf_counter_ns()
        data = read_regular_bytes(spec.archive, control.config.max_package_bytes + 1)
        r1 = time.perf_counter_ns()
        # Installed before t0 so that patching costs nothing inside the timers.
        self.stop.__enter__()
        try:
            t0 = time.perf_counter_ns()
            # 1. Open: snapshot, layered validation, signature, trust, summary.
            summary = control._open_bytes(data, {"kind": "file", "display": str(spec.archive)})
            t1 = time.perf_counter_ns()
            session_id = summary["session"]["id"]
            digest = summary["package"]["digest"]
            # 2. The recorded decisions, turned into a receipt.
            receipt = control.authorize(
                session_id,
                package_digest=digest,
                decisions=decided["decisions"],
                tool_approvals=decided["tool_approvals"],
                **authorize_resources,
            )
            t2 = time.perf_counter_ns()
            # 3. What the page shows before a model is chosen.
            models = control.evaluate_models(session_id, package_digest=digest, catalog=catalog)
            tools = control.evaluate_tools(
                session_id, package_digest=digest, tool_registry=registry
            )
            t3 = time.perf_counter_ns()
            # 4. Freeze it.
            prepared = control.prepare_run_plan(
                session_id,
                package_digest=digest,
                receipt_id=receipt["receipt_id"],
                model_id=MODEL_ID,
                catalog=catalog,
                tool_registry=registry,
                **plan_resources,
            )
            t4 = time.perf_counter_ns()
            # 5. Run start in the plugin: input, then `revalidate`'s reads, then the lease.
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
            binding, authorization = project_for_runner(state["run_plan"], held)
            issued = control.issue_execution_lease(
                session_id,
                package_digest=binding["package"]["digest"],
                run_plan_id=binding["run_plan_id"],
                run_plan_sha256=binding["run_plan_sha256"],
            )
            t5 = time.perf_counter_ns()
            lease_id = issued["lease"]["lease_id"]
            # 6. The runner: descriptors in, independent re-verification, binding.
            fds.append(os.open(issued["lease"]["path"], os.O_RDONLY | os.O_NOFOLLOW))
            fds.append(os.open(artifacts_dir, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW))
            begun = self.loop.run_until_complete(
                begin(
                    {
                        "run_id": run_id,
                        "run_plan": binding,
                        "authorization": authorization,
                        "limits": self.limits,
                        "input": task,
                        "attachments": [],
                        "host": self.host,
                    }
                )
            )
            t6 = time.perf_counter_ns()
            # 7. execution.run, up to the first wave the interpreter dispatches.
            outcome = self.loop.run_until_complete(run())
            t7 = self.stop.at_ns
            if t7 is None:
                raise AssertionError(f"{key}: the workflow never reached its first wave")
        finally:
            self.stop.__exit__(None, None, None)
            peer = holder.get("peer")
            if peer is not None:
                self.loop.run_until_complete(
                    peer.close(BridgeError("bridge_closed", "benchmark iteration ended"))
                )
            for fd in fds:
                os.close(fd)
            if session_id is not None:
                if lease_id is not None:
                    control.release_execution_lease(session_id, lease_id)
                control.close(session_id)
            shutil.rmtree(artifacts_dir, ignore_errors=True)

        checks = self._check(
            key,
            summary=summary,
            receipt=receipt,
            models=models,
            tools=tools,
            prepared=prepared,
            state=state,
            current=current,
            issued=issued,
            begun=begun,
            outcome=outcome,
            wire=wire,
        )
        return Observation(
            package_key=key,
            read_ns=r1 - r0,
            stamps=[t0, t1, t2, t3, t4, t5, t6, t7],
            checks=checks,
        )

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
        begun,
        outcome,
        wire,
    ) -> dict:
        """Every observation proves its own preconditions, outside the timed region."""
        identity = self.identity[key]
        decided = self.fixtures.authorization[identity["package_id"]]
        failures = []

        def expect(condition, message):
            if not condition:
                failures.append(message)

        validation = summary["validation"]
        for layer in ("container_status", "integrity_status", "schema_status"):
            expect(validation[layer] == "valid", f"{layer} is {validation[layer]}")
        expect(validation["runtime_status"] == "compatible", "runtime profile not compatible")
        expect(summary["publisher"]["signature_status"] == "valid", "signature not valid")
        expect(summary["publisher"]["trust_status"] == "trusted", "publisher not trusted")
        expect(summary["snapshot"]["archive_sha256"] == identity["archive_sha256"], "archive hash")
        expect(summary["package"]["digest"] == identity["package_digest"], "package digest")
        expect(receipt["runnable"] is True, "receipt not runnable")
        compatible = [m for m in models["models"] if m["model_id"] == MODEL_ID]
        expect(compatible and compatible[0]["status"] == "compatible", "model not compatible")
        expect(
            sorted(t["tool_id"] for t in tools["tools"] if t["status"] == "bound")
            == identity["declared_tools"],
            "not every declared tool is bound",
        )
        plan = prepared["run_plan"]
        expect(plan["readiness"]["ready"] is True, "run plan not ready")
        expect(prepared["preflight"]["ready"] is True, "prepared preflight not ready")
        expect(
            state["preflight"]["ready"] is True and not state["preflight"]["stale"],
            "revalidated preflight not ready",
        )
        expect(current["package"]["digest"] == plan["package"]["digest"], "summary digest moved")
        expect(issued["preflight"]["ready"] is True, "lease preflight not ready")
        expect(len(plan["tool_bindings"]) == len(identity["declared_tools"]), "tool bindings")
        expect(begun["package"]["signature_status"] == "valid", "runner signature")
        expect(
            begun["package"]["archive_sha256"] == identity["archive_sha256"], "runner archive hash"
        )
        expect(len(begun["package"]["verified"]) == 9, "runner verification list")
        expect(begun["router"]["model_id"] == MODEL_ID, "runner router model")
        expect(
            begun["execution"]["tool_handlers"] == len(identity["declared_tools"]), "tool handlers"
        )

        # Host resources: exactly the picks, frozen by id and digest in the
        # receipt, carried unchanged by the plan, re-checked by the runner; and
        # every denied permission reaches the runner denied.
        def refs(grants):
            return [
                (g["permission_id"], g["resource_type"], g["resource_id"], g["resource_digest"])
                for g in grants
            ]

        receipt_grants = receipt.get("resource_grants") or []
        expect(
            sorted((g["permission_id"], g["resource_id"]) for g in receipt_grants)
            == sorted((decided.get("resource_selections") or {}).items()),
            "receipt resource grants are not the selections",
        )
        expect(refs(plan.get("resource_grants") or []) == refs(receipt_grants), "plan grants")
        expect(
            refs((begun.get("resources") or {}).get("grants") or []) == refs(receipt_grants),
            "runner resource grants",
        )
        if self.fixtures.resource_registry is not None:
            expect(receipt.get("resource_registry") is not None, "receipt names no registry")
        denied = sorted(pid for pid, d in decided["decisions"].items() if d == "deny")
        expect(begun["authorization"]["denied_permission_ids"] == denied, "runner denied set")
        expect(self.stop.hits == 1, f"first-wave stop hit {self.stop.hits} times")
        expect(
            sorted(self.stop.nodes or []) == identity["root_nodes"], f"first wave {self.stop.nodes}"
        )
        actions = self.stop.audit_actions or []
        expect("node.started" not in actions, "a node started before the stop")
        expect(
            not any(a.startswith(("model.", "tool.")) for a in actions), "model/tool audit event"
        )
        expect(outcome["error_code"] == "worker_error", f"run outcome {outcome.get('error_code')}")
        expect(outcome["audit"]["model_calls"] == 0, "model calls recorded")
        expect(outcome["audit"]["tool_calls"] == 0, "tool calls recorded")
        expect(not wire.refused, "runner attempted a non-progress dispatch")
        methods = wire.methods()
        expect(
            all(method in RunnerWire.ALLOWED_METHODS for method in methods),
            f"wire methods {methods}",
        )
        if failures:
            raise AssertionError(f"{key}: observation invalid: {failures}")
        if key not in self.evidence:
            self.evidence[key] = {
                "run_plan_schema": plan["schema"],
                "run_plan_tool_bindings": len(plan["tool_bindings"]),
                "receipt_runnable": receipt["runnable"],
                "model_compatibility": compatible[0]["status"],
                "tool_verdicts": {t["tool_id"]: t["status"] for t in tools["tools"]},
                "runner_verified": list(begun["package"]["verified"]),
                "runner_capabilities": begun["capabilities"],
                "runner_model_check": begun["model"],
                "runner_effective_deadline_seconds": begun["limits"]["effective_deadline_seconds"],
                "runner_denied_permission_ids": begun["authorization"]["denied_permission_ids"],
                "resource_grants": [
                    {k: g[k] for k in ("permission_id", "resource_type", "resource_id")}
                    for g in receipt_grants
                ],
                "receipt_resource_registry": receipt.get("resource_registry"),
                "run_plan_resource_registry": plan.get("resource_registry"),
                "first_wave_nodes": list(self.stop.nodes or []),
                "audit_actions_at_stop": actions,
                "runner_outbound_methods": methods,
                "outcome_after_stop": {
                    "status": outcome["status"],
                    "error_code": outcome["error_code"],
                    "model_calls": outcome["audit"]["model_calls"],
                    "tool_calls": outcome["audit"]["tool_calls"],
                },
            }
        return {"first_wave": list(self.stop.nodes or []), "runner_frames": methods}


def execution_protocol_limit() -> int:
    from agentpkg.hostbridge import protocol as bridge_protocol

    return bridge_protocol.MAX_FRAME_BYTES


# -- protocol ------------------------------------------------------------------
@dataclass
class Config:
    warmup: int = DEFAULT_WARMUP
    batches: int = DEFAULT_BATCHES
    iterations: int = DEFAULT_ITERATIONS
    seed: int = DEFAULT_SEED
    audit: bool = True
    audit_warmup: int = DEFAULT_AUDIT_WARMUP
    audit_batches: int = DEFAULT_AUDIT_BATCHES
    audit_repeats: int = DEFAULT_AUDIT_REPEATS
    components: bool = True
    component_warmup: int = DEFAULT_COMPONENT_WARMUP
    component_iterations: int = DEFAULT_COMPONENT_ITERATIONS
    packages: tuple[str, ...] = tuple(spec.key for spec in PACKAGES)

    def as_json(self) -> dict:
        return {
            "warmup_iterations_per_package": self.warmup,
            "batches": self.batches,
            "iterations_per_batch": self.iterations,
            "measured_observations_per_package": self.batches * self.iterations,
            "seed": self.seed,
            "order": (
                "same process; within each (batch, iteration) every package runs once, in an "
                "order drawn from random.Random(seed); warmup uses the same scheme"
            ),
            "gc": "enabled (Python default)",
            "packages": list(self.packages),
            "audit_microbenchmark": {
                "enabled": self.audit,
                "warmup_events": self.audit_warmup,
                "batches": self.audit_batches,
                "stream_repeats_per_batch": self.audit_repeats,
            },
            "component_decomposition": {
                "enabled": self.components,
                "warmup_iterations_per_package": self.component_warmup,
                "batches": self.batches,
                "iterations_per_batch": self.component_iterations,
            },
        }


def schedule(config: Config, rng: random.Random, rounds: int) -> list[list[str]]:
    """Per round, the order the packages run in."""
    orders = []
    for _ in range(rounds):
        order = list(config.packages)
        rng.shuffle(order)
        orders.append(order)
    return orders


def rows_for(
    observation: Observation, identity: dict, *, batch: int, iteration: int, position: int
):
    """Tidy sample rows for one observation: stages, groups, total, secondary."""
    stamps = observation.stamps
    base = {
        "package_key": observation.package_key,
        "package_id": identity["package_id"],
        "package_version": identity["package_version"],
        "batch": batch,
        "iteration": iteration,
        "position": position,
    }
    rows = []
    for index, stage in enumerate(STAGES):
        rows.append(
            {
                **base,
                "kind": "stage",
                "stage": stage,
                "elapsed_ns": stamps[index + 1] - stamps[index],
            }
        )
    for group, (start, end) in GROUPS.items():
        rows.append(
            {**base, "kind": "group", "stage": group, "elapsed_ns": stamps[end] - stamps[start]}
        )
    rows.append({**base, "kind": "total", "stage": TOTAL, "elapsed_ns": stamps[7] - stamps[0]})
    rows.append(
        {**base, "kind": "secondary", "stage": SECONDARY, "elapsed_ns": observation.read_ns}
    )
    stamp_row = {
        **base,
        "read_ns": observation.read_ns,
        **{f"t{index}_ns": stamps[index] - stamps[0] for index in range(8)},
    }
    return rows, stamp_row


def run_protocol(pipeline: ContractPipeline, config: Config, *, progress=None):
    rng = random.Random(config.seed)
    warmup_rows, sample_rows, stamp_rows = [], [], []
    for iteration, order in enumerate(schedule(config, rng, config.warmup)):
        for position, key in enumerate(order):
            observation = pipeline.run_once(key)
            rows, _ = rows_for(
                observation,
                pipeline.identity[key],
                batch=-1,
                iteration=iteration,
                position=position,
            )
            warmup_rows.extend(rows)
    if progress:
        progress(f"warmup done ({config.warmup} per package)")
    orders = []
    for batch in range(config.batches):
        batch_orders = schedule(config, rng, config.iterations)
        orders.append(batch_orders)
        started = time.perf_counter()
        for iteration, order in enumerate(batch_orders):
            for position, key in enumerate(order):
                observation = pipeline.run_once(key)
                rows, stamp = rows_for(
                    observation,
                    pipeline.identity[key],
                    batch=batch,
                    iteration=iteration,
                    position=position,
                )
                sample_rows.extend(rows)
                stamp_rows.append(stamp)
        if progress:
            progress(
                f"batch {batch + 1}/{config.batches} done in {time.perf_counter() - started:.1f} s"
            )
    return warmup_rows, sample_rows, stamp_rows, orders


# -- component decomposition -------------------------------------------------
COMPONENTS = (
    "container_integrity",
    "schema_validation",
    "signature",
    "publisher_trust",
    "inspection_summary",
)
COMPONENT_OPERATIONS = {
    "container_integrity": "agentpkg.package.read_archive_bytes",
    "schema_validation": "agentpkg.validation.validate_payload",
    "signature": "agentpkg.browser.evaluation.signature_report",
    "publisher_trust": "agentpkg.browser.trust.TrustStore.evaluate",
    "inspection_summary": "agentpkg.browser.summary.build_summary",
}
COMPONENT_FIELDS = ("package_key", "batch", "iteration", "position", "component", "elapsed_ns")


def component_benchmark(pipeline: ContractPipeline, config: Config, *, progress=None) -> list[dict]:
    """Where package verification spends its time, one production function at a time.

    A diagnostic, not part of the pipeline totals. Each function is the one the
    open path (and, for the first three, the runner path) calls, invoked
    separately on the same in-memory bytes with its own timer, in the order
    `evaluate_snapshot` / `_publisher_report` / `build_summary` use them.
    """
    from agentpkg.browser.evaluation import signature_report
    from agentpkg.browser.summary import build_summary
    from agentpkg.package import Package, read_archive_bytes, read_regular_bytes
    from agentpkg.validation import validate_payload

    control = pipeline.control
    data = {
        key: read_regular_bytes(spec.archive, control.config.max_package_bytes + 1)
        for key, spec in pipeline.packages.items()
    }
    evaluation = {
        "container_status": "valid",
        "integrity_status": "valid",
        "schema_status": "valid",
        "runtime_status": "compatible",
        "supported_execution_profiles": ["workflow.v0"],
        "errors": [],
    }

    def once(key: str) -> list[int]:
        t0 = time.perf_counter_ns()
        files, statement, signature = read_archive_bytes(data[key])
        t1 = time.perf_counter_ns()
        manifest, graph, policy, tools = validate_payload(files)
        t2 = time.perf_counter_ns()
        package = Package(manifest, graph, policy, tools, files, statement, signature, None, True)
        t3a = time.perf_counter_ns()
        report = signature_report(package)
        t3 = time.perf_counter_ns()
        trust = control.trust.evaluate(
            signer_fingerprint=report["signer_fingerprint"],
            claimed_publisher_id=manifest["publisher"]["id"],
            package_id=manifest["package_id"],
        )
        t4 = time.perf_counter_ns()
        build_summary(
            package,
            evaluation=evaluation,
            publisher={
                "claimed_id": manifest["publisher"]["id"],
                "claimed_name": manifest["publisher"]["name"],
                **report,
                **trust,
            },
        )
        t5 = time.perf_counter_ns()
        if report["signature_status"] != "valid" or trust["trust_status"] != "trusted":
            raise AssertionError(f"{key}: component check failed: {report} {trust}")
        return [t1 - t0, t2 - t1, t3 - t3a, t4 - t3, t5 - t4]

    rng = random.Random(config.seed + 1)
    rows: list[dict] = []
    for _ in range(config.component_warmup):
        for key in schedule(config, rng, 1)[0]:
            once(key)
    for batch in range(config.batches):
        for iteration, order in enumerate(schedule(config, rng, config.component_iterations)):
            for position, key in enumerate(order):
                for component, elapsed in zip(COMPONENTS, once(key), strict=True):
                    rows.append(
                        {
                            "package_key": key,
                            "batch": batch,
                            "iteration": iteration,
                            "position": position,
                            "component": component,
                            "elapsed_ns": elapsed,
                        }
                    )
    if progress:
        progress("component decomposition done")
    return rows


# -- audit microbenchmark ------------------------------------------------------
AUDIT_FIELDS = ("variant", "stream", "batch", "event_index", "chain_length", "action", "elapsed_ns")
_STANDARD_AUDIT_KEYS = {
    "schema_version",
    "run_id",
    "sequence",
    "timestamp",
    "action",
    "worker",
    "role",
    "parent",
    "depth",
    "node_id",
    "previous_hash",
    "event_hash",
}


def recorded_stream(path: Path) -> list[tuple[str, dict]]:
    """(action, metadata) for every event of a recorded run's audit, in order."""
    events = _load_json(path)
    return [
        (event["action"], {k: v for k, v in event.items() if k not in _STANDARD_AUDIT_KEYS})
        for event in events
    ]


def audit_benchmark(config: Config, packages=PACKAGES) -> tuple[list[dict], dict]:
    """Time `Runtime.record`: build one event, hash-link it, append it.

    Each recorded run's audit stream is replayed, event by event, through a
    fresh production `Runtime` constructed for the package that produced it,
    so event sizes are the real mix. Variant `no_observer` is the bookkeeping
    alone; `progress_observer` adds the runner's live-progress observer (its
    copy and counting; with no running loop it schedules no send).
    """
    from agentpkg.execution.progress import ProgressTracker
    from agentpkg.package import load_package_bytes
    from agentpkg.runtime import Runtime

    rows: list[dict] = []
    streams = {}
    for spec in packages:
        if spec.key not in config.packages or spec.recorded_audit is None:
            continue
        package = load_package_bytes(spec.archive.read_bytes())
        grants = {item["id"]: "session" for item in package.policy["permissions"]}
        streams[spec.key] = (package, grants, recorded_stream(spec.recorded_audit))

    def fresh(package, grants, variant):
        observer = ProgressTracker(None).observe if variant == "progress_observer" else None
        return Runtime(package, grants=grants, observer=observer)

    meta = {
        "streams": {},
        "packages_without_recorded_stream": [
            spec.key
            for spec in packages
            if spec.key in config.packages and spec.recorded_audit is None
        ],
    }
    for key, (_, _, stream) in streams.items():
        spec = next(item for item in packages if item.key == key)
        meta["streams"][key] = {
            "path": _rel(spec.recorded_audit),
            "sha256": _sha256_file(spec.recorded_audit),
            "events": len(stream),
        }
    for variant in ("no_observer", "progress_observer"):
        for key, (package, grants, stream) in streams.items():
            runtime = fresh(package, grants, variant)
            context = runtime.coordinator_context()
            done = 0
            while done < config.audit_warmup:
                for action, metadata in stream:
                    runtime.record(action, context=context, **metadata)
                    done += 1
                    if done >= config.audit_warmup:
                        break
            for batch in range(config.audit_batches):
                runtime = fresh(package, grants, variant)
                context = runtime.coordinator_context()
                index = 0
                for _ in range(config.audit_repeats):
                    for action, metadata in stream:
                        chain = len(runtime.audit)
                        start = time.perf_counter_ns()
                        runtime.record(action, context=context, **metadata)
                        end = time.perf_counter_ns()
                        rows.append(
                            {
                                "variant": variant,
                                "stream": key,
                                "batch": batch,
                                "event_index": index,
                                "chain_length": chain,
                                "action": action,
                                "elapsed_ns": end - start,
                            }
                        )
                        index += 1
                from agentpkg.execution.report import verify_audit_chain

                verdict = verify_audit_chain(runtime.audit)
                if not _chain_ok(verdict):
                    raise AssertionError(f"audit chain invalid after replay: {verdict}")
    return rows, meta


def _chain_ok(verdict) -> bool:
    if isinstance(verdict, bool):
        return verdict
    if isinstance(verdict, dict):
        return bool(verdict.get("valid", verdict.get("chain_valid", False)))
    return bool(verdict)


# -- metadata --------------------------------------------------------------
def _run(command: list[str], *, cwd: Path = ROOT) -> str | None:
    try:
        completed = subprocess.run(
            command, cwd=cwd, capture_output=True, text=True, timeout=20, check=False
        )
    except (OSError, subprocess.SubprocessError):
        return None
    return completed.stdout.strip() if completed.returncode == 0 else None


def machine_metadata() -> dict:
    """Interpretable, non-identifying environment facts. No user, host or serial."""
    system = platform.system()
    cpu = None
    memory = None
    os_version = platform.release()
    if system == "Darwin":
        cpu = _run(["sysctl", "-n", "machdep.cpu.brand_string"])
        raw = _run(["sysctl", "-n", "hw.memsize"])
        memory = int(raw) if raw and raw.isdigit() else None
        os_version = platform.mac_ver()[0] or os_version
    elif system == "Linux":
        try:
            for line in Path("/proc/cpuinfo").read_text().splitlines():
                if line.lower().startswith("model name"):
                    cpu = line.split(":", 1)[1].strip()
                    break
            for line in Path("/proc/meminfo").read_text().splitlines():
                if line.startswith("MemTotal:"):
                    memory = int(line.split()[1]) * 1024
                    break
        except OSError:
            pass
    performance_cores = (
        _run(["sysctl", "-n", "hw.perflevel0.logicalcpu"]) if system == "Darwin" else None
    )
    efficiency_cores = (
        _run(["sysctl", "-n", "hw.perflevel1.logicalcpu"]) if system == "Darwin" else None
    )
    return {
        "os": system,
        "os_version": os_version,
        "kernel": platform.release(),
        "architecture": platform.machine(),
        "cpu_model": cpu,
        "logical_cpus": os.cpu_count(),
        "performance_logical_cpus": int(performance_cores) if performance_cores else None,
        "efficiency_logical_cpus": int(efficiency_cores) if efficiency_cores else None,
        "memory_bytes": memory,
        "python_version": platform.python_version(),
        "python_implementation": platform.python_implementation(),
        "python_compiler": platform.python_compiler(),
        "timer": {
            "function": "time.perf_counter_ns",
            "implementation": time.get_clock_info("perf_counter").implementation,
            "resolution_s": time.get_clock_info("perf_counter").resolution,
            "monotonic": time.get_clock_info("perf_counter").monotonic,
        },
    }


def _load_average() -> list[float] | None:
    try:
        return [round(value, 2) for value in os.getloadavg()]
    except (AttributeError, OSError):
        return None


def software_metadata() -> dict:
    import agentpkg

    def version(module: str) -> str | None:
        try:
            from importlib.metadata import version as dist_version

            return dist_version(module)
        except Exception:  # noqa: BLE001 - metadata is best effort
            return None

    plugin = _load_json(ROOT / "openclaw-agent-browser/package.json")
    manifest = _load_json(ROOT / "openclaw-agent-browser/openclaw.plugin.json")
    source = Path(agentpkg.__file__).resolve()
    status = _run(["git", "status", "--porcelain"]) or ""
    tracked_changes = [
        line[3:] for line in status.splitlines() if line and not line.startswith("??")
    ]
    untracked = [line[3:] for line in status.splitlines() if line.startswith("??")]
    production_changes = [
        path
        for path in tracked_changes
        if path.startswith(("agentpkg/src", "openclaw-agent-browser/src", "dist/"))
    ]
    return {
        "git_commit": _run(["git", "rev-parse", "HEAD"]),
        "git_dirty": bool(status),
        "git_tracked_changes": tracked_changes,
        "git_untracked": untracked,
        "git_production_paths_modified": production_changes,
        "agentpkg_version": agentpkg.__version__,
        "agentpkg_source_in_repository": str(source).startswith(str(ROOT / "agentpkg/src")),
        "dependencies": {
            name: version(name) for name in ("jsonschema", "referencing", "cryptography", "rfc8785")
        },
        "agent_browser_plugin_version": plugin.get("version"),
        "agent_browser_manifest_version": manifest.get("version"),
        "openclaw_version_pinned_by_plugin": (plugin.get("devDependencies") or {}).get("openclaw"),
        "node_version": _run(["node", "--version"]),
        "node_in_measured_path": False,
        "openclaw_in_measured_path": False,
        "note": (
            "Node and OpenClaw do not run in the measured process. Node generated the host "
            "fixtures once (fixtures/generate_fixtures.mjs) through the plugin's own code; "
            "the OpenClaw version is the one the plugin verifies and the fixtures name."
        ),
    }


# -- output ------------------------------------------------------------------
def _write_csv(path: Path, fields, rows) -> None:
    with open(path, "w", newline="", encoding="utf-8") as stream:
        writer = csv.DictWriter(stream, fieldnames=list(fields))
        writer.writeheader()
        writer.writerows(rows)


def result_directory(base: Path, stamp: datetime, label: str | None) -> Path:
    name = stamp.strftime("%Y-%m-%dT%H-%M-%SZ")
    if label:
        name += f"_{label}"
    path = base / name
    path.mkdir(parents=True, exist_ok=False)  # Never overwrite a prior result.
    return path


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--warmup", type=int, default=DEFAULT_WARMUP)
    parser.add_argument("--batches", type=int, default=DEFAULT_BATCHES)
    parser.add_argument("--iterations", type=int, default=DEFAULT_ITERATIONS)
    parser.add_argument("--seed", type=int, default=DEFAULT_SEED)
    parser.add_argument("--no-audit", action="store_true", help="skip the audit microbenchmark")
    parser.add_argument(
        "--no-components", action="store_true", help="skip the component decomposition"
    )
    parser.add_argument("--component-warmup", type=int, default=DEFAULT_COMPONENT_WARMUP)
    parser.add_argument("--component-iterations", type=int, default=DEFAULT_COMPONENT_ITERATIONS)
    parser.add_argument("--audit-warmup", type=int, default=DEFAULT_AUDIT_WARMUP)
    parser.add_argument("--audit-batches", type=int, default=DEFAULT_AUDIT_BATCHES)
    parser.add_argument("--audit-repeats", type=int, default=DEFAULT_AUDIT_REPEATS)
    parser.add_argument("--results-dir", type=Path, default=RESULTS)
    parser.add_argument("--label", help="suffix for the result directory name, e.g. smoke")
    parser.add_argument("--quiet", action="store_true")
    args = parser.parse_args(argv)
    for name in (
        "warmup",
        "batches",
        "iterations",
        "audit_warmup",
        "audit_batches",
        "audit_repeats",
        "component_warmup",
        "component_iterations",
    ):
        if getattr(args, name) < 0 or (
            name in {"batches", "iterations"} and getattr(args, name) < 1
        ):
            parser.error(f"--{name.replace('_', '-')} is out of range")

    def say(message: str) -> None:
        if not args.quiet:
            print(f"[contract_overhead] {message}", flush=True)

    config = Config(
        warmup=args.warmup,
        batches=args.batches,
        iterations=args.iterations,
        seed=args.seed,
        audit=not args.no_audit,
        components=not args.no_components,
        component_warmup=args.component_warmup,
        component_iterations=args.component_iterations,
        audit_warmup=args.audit_warmup,
        audit_batches=args.audit_batches,
        audit_repeats=args.audit_repeats,
    )
    started = datetime.now(UTC)
    out = result_directory(Path(args.results_dir), started, args.label)
    (out / "command.txt").write_text(
        " ".join(
            [
                Path(sys.executable).name,
                _rel(Path(__file__)),
                *(argv if argv is not None else sys.argv[1:]),
            ]
        )
        + "\n",
        encoding="utf-8",
    )
    software = software_metadata()  # Before the guard: it runs git and node.
    machine = machine_metadata()
    fixtures = Fixtures.load()
    package_files = {spec.key: _sha256_file(spec.archive) for spec in PACKAGES}
    workdir = Path(tempfile.mkdtemp(prefix="contract-overhead-"))
    say(f"results -> {_rel(out)}")
    load_start = _load_average()
    wall0 = time.perf_counter()
    gc0 = gc.get_stats()
    try:
        with OfflineGuard() as guard:
            pipeline = ContractPipeline(workdir, fixtures)
            try:
                warmup_rows, sample_rows, stamp_rows, orders = run_protocol(
                    pipeline, config, progress=say
                )
                component_rows = (
                    component_benchmark(pipeline, config, progress=say) if config.components else []
                )
                audit_rows, audit_meta = audit_benchmark(config) if config.audit else ([], {})
            finally:
                pipeline.close()
            violations = list(guard.violations)
    finally:
        shutil.rmtree(workdir, ignore_errors=True)
    wall = time.perf_counter() - wall0
    machine["load_average_1_5_15"] = {"start": load_start, "end": _load_average()}
    if violations:
        raise SystemExit(
            f"offline guard refused {len(violations)} operations: {sorted(set(violations))}"
        )
    after = {spec.key: _sha256_file(spec.archive) for spec in PACKAGES}
    if after != package_files:
        raise SystemExit("package artifacts changed during the benchmark")

    _write_csv(out / "samples.csv", SAMPLE_FIELDS, sample_rows)
    _write_csv(out / "warmup_samples.csv", SAMPLE_FIELDS, warmup_rows)
    _write_csv(out / "timestamps.csv", TIMESTAMP_FIELDS, stamp_rows)
    if audit_rows:
        _write_csv(out / "audit_samples.csv", AUDIT_FIELDS, audit_rows)
    if component_rows:
        _write_csv(out / "component_samples.csv", COMPONENT_FIELDS, component_rows)
    metadata = {
        "benchmark": {
            "name": BENCHMARK_NAME,
            "version": BENCHMARK_VERSION,
            "script": _rel(Path(__file__)),
            "script_sha256": _sha256_file(Path(__file__)),
            "analysis_script_sha256": _sha256_file(HERE / "analyze.py"),
            "started_at_utc": started.isoformat(),
            "finished_at_utc": datetime.now(UTC).isoformat(),
            "wall_seconds": round(wall, 3),
            "config": config.as_json(),
            "stages": [
                {
                    "stage": stage,
                    "label": STAGE_LABELS[stage],
                    "production_operation": STAGE_OPERATIONS[stage],
                    "interval": [f"t{index}", f"t{index + 1}"],
                }
                for index, stage in enumerate(STAGES)
            ],
            "groups": [
                {
                    "group": group,
                    "label": GROUP_LABELS[group],
                    "stages": list(GROUP_STAGES[group]),
                    "interval": [f"t{start}", f"t{end}"],
                }
                for group, (start, end) in GROUPS.items()
            ],
            "total": {"stage": TOTAL, "interval": ["t0", "t7"]},
            "secondary": {
                "stage": SECONDARY,
                "operation": "agentpkg.package.read_regular_bytes (the read open_file performs)",
                "in_total": False,
            },
            "components": [
                {"component": name, "production_function": COMPONENT_OPERATIONS[name]}
                for name in COMPONENTS
            ],
            "units": {"raw": "ns", "summary": "ms", "audit_summary": "us"},
            "model_id_bound": MODEL_ID,
            "session_ttl_seconds": SESSION_TTL_SECONDS,
            "browser_policy": "production default (agentpkg.browser.authorization.BrowserPolicy())",
            "host_resources": (
                "The host holds resources (fixtures/host-resource-registry.json, the WebAir "
                "demo's host resources file). As the plugin's backend does on such a host, every "
                "authorize carries the resource registry and the package's selections (empty "
                "when it requests no host resource) and every prepare_run_plan carries the "
                "registry, for every package."
            ),
        },
        "packages": pipeline.identity,
        "package_file_sha256_before_after_equal": True,
        "fixtures": fixtures.files,
        "evidence": pipeline.evidence,
        "guards": {
            "offline_violations": violations,
            "refused": [
                "socket.connect",
                "socket.connect_ex",
                "socket.create_connection",
                "socket.getaddrinfo",
                "subprocess.Popen",
                "os.fork/forkpty/posix_spawn/posix_spawnp/system",
                "runner outbound frames other than execution.progress",
            ],
        },
        "batch_orders": orders,
        "audit": audit_meta if config.audit else None,
        "machine": machine,
        "software": software,
        "gc": {"stats_before": gc0, "stats_after": gc.get_stats(), "enabled": gc.isenabled()},
        "environment_note": (
            "No username, home directory, hostname or serial number is recorded. Paths are "
            "repository-relative."
        ),
    }
    (out / "metadata.json").write_text(json.dumps(metadata, indent=2) + "\n", encoding="utf-8")
    say(f"measurement done in {wall:.1f} s; analyzing")

    import analyze

    analyze.analyze(out)
    say(f"wrote {', '.join(sorted(path.name for path in out.iterdir()))}")
    print(str(out))
    return 0


if __name__ == "__main__":
    sys.path.insert(0, str(HERE))
    raise SystemExit(main())
