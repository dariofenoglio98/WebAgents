"""The transport-free control plane: open, inspect, authorize. Never execute.

A package is DATA here. Opening one captures its bytes exactly once, and every
later answer about that session is computed from that immutable snapshot, so
no verify/reload race can substitute different bytes behind a decision.
"""

from __future__ import annotations

import os
import shutil
import tempfile
import threading
import time
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from pathlib import Path
from secrets import token_urlsafe
from uuid import uuid4

from .. import __version__
from ..errors import AgentPkgError, ValidationError
from ..package import Package, read_regular_bytes, sha256
from ..signing import embedded_public_key
from . import discovery
from .authorization import (
    BrowserPolicy,
    blocking_reasons,
    build_receipt,
    build_request,
    initial_decisions,
    initial_tool_approvals,
    normalize_decisions,
    normalize_tool_approvals,
)
from .errors import ControlPlaneError
from .evaluation import evaluate_snapshot, signature_report
from .fetch import FetchLimits, download_to_file
from .hostmodels import evaluate_catalog, find_model, normalize_catalog, requirement_set
from .hostresources import (
    evaluate_resources,
    normalize_resource_registry,
    normalize_resource_selections,
)
from .hosttools import (
    IMPLEMENTATION_KINDS,
    evaluate_registry,
    normalize_registry,
    tool_requirement_set,
)
from .lease import DEFAULT_LEASE_TTL_SECONDS, ExecutionLease
from .lease import issue as issue_lease
from .lease import release as release_lease
from .presentation import validate_task_input
from .runplan import (
    BINDING_SINGLE_MODEL,
    EXECUTION_MODES,
    MODE_MODEL,
    MODE_TOOL_PROBE,
    build_run_plan,
    mode_permission_ids,
    preflight,
    preparation_blockers,
    validate_binding,
    validate_mode,
)
from .summary import build_summary
from .trust import TrustStore

SERVICE = "agentpkg-browser-control-plane"
API_VERSION = "v0"
SNAPSHOT_NAME = "package.agent.pkg"
SESSION_MARKER = ".agentpkg-browser-session"
SESSION_PREFIX = "session-"
# The container limit plus the ZIP envelope slack `_archive_files` already allows.
MAX_PACKAGE_BYTES = 32 * 1024 * 1024 + 256 * 1024


@dataclass(frozen=True)
class ControlPlaneConfig:
    cache_dir: Path
    trust_store_path: Path
    session_ttl_seconds: int = 900
    max_sessions: int = 8
    max_package_bytes: int = MAX_PACKAGE_BYTES
    max_cache_bytes: int = 128 * 1024 * 1024
    download_timeout_seconds: float = 60.0
    execution_lease_ttl_seconds: int = DEFAULT_LEASE_TTL_SECONDS
    policy: BrowserPolicy = field(default_factory=BrowserPolicy)

    def as_json(self) -> dict:
        return {
            "session_ttl_seconds": self.session_ttl_seconds,
            "max_sessions": self.max_sessions,
            "max_package_bytes": self.max_package_bytes,
            "max_cache_bytes": self.max_cache_bytes,
            "download_timeout_seconds": self.download_timeout_seconds,
            "execution_lease_ttl_seconds": self.execution_lease_ttl_seconds,
            "browser_policy": self.policy.as_json(),
        }


@dataclass
class Session:
    session_id: str
    directory: Path
    snapshot_path: Path
    archive_sha256: str
    archive_bytes: int
    source: dict
    created_at: str
    expires_at: str
    expires_monotonic: float
    package: Package
    evaluation: dict
    publisher: dict
    summary: dict
    decisions: dict
    tool_approvals: dict
    receipt: dict | None = None
    # The last host catalog this session was shown, its evaluation, and the
    # plan frozen from them. All three die with the session.
    catalog: dict | None = None
    model_evaluation: dict | None = None
    # The same three facts for the host's tool implementations. A registry is
    # a live statement about the host, so it is re-supplied rather than cached
    # across decisions; what is kept is the last one this session was shown.
    tool_registry: dict | None = None
    tool_evaluation: dict | None = None
    # The last host resource registry this session was shown. Like a tool
    # registry it is a live statement about the host, re-supplied before every
    # decision and every read that compares against it; it never holds values.
    resource_registry: dict | None = None
    run_plan: dict | None = None
    # One-time private copies of this snapshot, issued to a trusted runner.
    leases: dict[str, ExecutionLease] = field(default_factory=dict)
    # Receipts whose `once` grants a run has already used. `once` means one
    # run: a plan under such a receipt is stale until the person decides again.
    spent_receipt_ids: set[str] = field(default_factory=set)

    def descriptor(self) -> dict:
        return {
            "session_id": self.session_id,
            "created_at": self.created_at,
            "expires_at": self.expires_at,
            "source": dict(self.source),
            "archive_sha256": self.archive_sha256,
            "archive_bytes": self.archive_bytes,
            "package_id": self.package.manifest["package_id"],
            "version": self.package.manifest["version"],
            "digest": self.package.digest,
            "signature_status": self.publisher["signature_status"],
            "trust_status": self.publisher["trust_status"],
            "authorization": {
                "state": "issued" if self.receipt else "pending",
                "receipt_id": self.receipt["receipt_id"] if self.receipt else None,
                "runnable": bool(self.receipt and self.receipt["runnable"]),
            },
            "run_plan": {
                "state": "prepared" if self.run_plan else "absent",
                "run_plan_id": self.run_plan["run_plan_id"] if self.run_plan else None,
                "ready": bool(self.run_plan and self.run_plan["readiness"]["ready"]),
            },
        }


def _now() -> str:
    return datetime.now(UTC).isoformat()


class ControlPlane:
    """Thread-safe control plane. Holds no signing key and runs no package code."""

    def __init__(self, config: ControlPlaneConfig, *, transport=None, discovery_network=None):
        self.config = config
        self.instance_id = str(uuid4())
        self.started_at = _now()
        self.trust = TrustStore(config.trust_store_path)
        self._transport = transport
        # Trusted test seam for website discovery: DNS and socket mechanics only.
        self._discovery_network = discovery_network
        self._sessions: dict[str, Session] = {}
        self._pending = 0  # Opens that reserved capacity but have not registered yet.
        self._pending_bytes = 0
        self._lock = threading.RLock()
        self.cache_dir = self._prepare_cache(Path(config.cache_dir))
        self.removed_stale_snapshots = self._clean_stale()

    # -- cache ---------------------------------------------------------------
    @staticmethod
    def _prepare_cache(path: Path) -> Path:
        if path.is_symlink():
            raise ControlPlaneError(
                "cache_unsafe", f"Cache directory must not be a symlink: {path}", status=500
            )
        path.mkdir(mode=0o700, parents=True, exist_ok=True)
        info = path.stat()
        if info.st_uid != os.getuid():
            raise ControlPlaneError(
                "cache_unsafe", f"Cache directory must be owned by this user: {path}", status=500
            )
        os.chmod(path, 0o700)
        return path

    def _clean_stale(self) -> int:
        """Startup sweep of marked session directories left by a crashed service.

        Only directories carrying this service's marker file are removed, so
        unrelated operator files in the cache directory are untouched. Run one
        service per cache directory: a second service started on the same
        directory removes the first service's snapshots. Pass a distinct
        --cache-dir to run two.
        """
        removed = 0
        for child in sorted(self.cache_dir.iterdir()):
            if child.is_symlink():
                continue
            if child.name.endswith(".part") and child.is_file():
                child.unlink(missing_ok=True)  # An interrupted download.
                removed += 1
            elif (
                child.name.startswith(SESSION_PREFIX)
                and child.is_dir()
                and (child / SESSION_MARKER).is_file()
            ):
                shutil.rmtree(child, ignore_errors=True)
                removed += 1
        return removed

    def _cached_bytes(self) -> int:
        return sum(session.archive_bytes for session in self._sessions.values())

    # -- lifetime ------------------------------------------------------------
    def purge_expired(self) -> int:
        with self._lock:
            now = time.monotonic()
            for session in self._sessions.values():
                for lease_id, lease in list(session.leases.items()):
                    if lease.expired(now):
                        release_lease(lease)
                        session.leases.pop(lease_id, None)
            expired = [s for s in self._sessions.values() if s.expires_monotonic <= now]
            for session in expired:
                self._drop(session)
            return len(expired)

    def _drop(self, session: Session) -> None:
        self._sessions.pop(session.session_id, None)
        for lease in list(session.leases.values()):
            release_lease(lease)
        session.leases.clear()
        # The whole session directory goes, leases included. A runner that
        # already holds an open descriptor keeps reading the bytes it verified.
        shutil.rmtree(session.directory, ignore_errors=True)

    def close(self, session_id: str) -> dict:
        with self._lock:
            session = self._sessions.get(session_id)
            if session is None:
                raise ControlPlaneError(
                    "session_unknown", f"No open package session {session_id!r}", status=404
                )
            self._drop(session)
            return {"session_id": session_id, "closed": True, "receipt_retained": False}

    def shutdown(self) -> None:
        with self._lock:
            for session in list(self._sessions.values()):
                self._drop(session)

    def _session(self, session_id: str) -> Session:
        with self._lock:
            self.purge_expired()
            session = self._sessions.get(session_id)
            if session is None:
                raise ControlPlaneError(
                    "session_unknown",
                    f"No open package session {session_id!r}; it may have expired",
                    status=404,
                )
            return session

    # -- opening -------------------------------------------------------------
    def open_file(self, path) -> dict:
        """Open a local artifact chosen by the trusted operator.

        This is deliberately a separate operation from URL opening: a local path
        must never be reachable through the URL endpoint.
        """
        if not isinstance(path, str) or not path:
            raise ControlPlaneError("invalid_request", "path must be a non-empty string")
        candidate = Path(path).expanduser()
        if not candidate.is_absolute():
            candidate = (Path.cwd() / candidate).resolve()
        if candidate.is_dir():
            raise ControlPlaneError(
                "source_rejected",
                "The control plane opens built .agent.pkg artifacts, not source directories",
            )
        try:
            # One byte of slack so an oversized artifact reports its own error code.
            data = read_regular_bytes(candidate, self.config.max_package_bytes + 1)
        except ValidationError as exc:
            raise ControlPlaneError("source_rejected", str(exc), status=400) from exc
        return self._open_bytes(data, {"kind": "file", "display": str(candidate)})

    def open_url(self, url) -> dict:
        """Download one artifact over SSRF-hardened HTTPS and open that snapshot."""
        limits = FetchLimits(
            max_bytes=self.config.max_package_bytes,
            timeout_seconds=self.config.download_timeout_seconds,
        )
        with self._lock:
            self.purge_expired()
            self._check_capacity(0)
        staging = self.cache_dir / f"download-{token_urlsafe(12)}.part"
        fd = os.open(staging, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        os.close(fd)
        try:
            download_to_file(url, staging, limits=limits, transport=self._transport)
            data = read_regular_bytes(staging, self.config.max_package_bytes + 1)
        finally:
            staging.unlink(missing_ok=True)
        return self._open_bytes(data, {"kind": "url", "display": str(url)})

    def discover_website(self, url) -> dict:
        """Report the agent packages one HTTPS web page advertises. Open none.

        Discovery is not acquisition. It reads one HTML page under the same URL
        and address policy as `open_url`, and it creates no session, writes no
        snapshot, touches no trust and fetches no package. Every candidate it
        returns is an untrusted location; inspecting one is a separate
        `open_url` call that a person makes.
        """
        return discovery.discover_website(url, network=self._discovery_network)

    def _check_capacity(self, incoming: int) -> None:
        """Concurrent opens must not collectively exceed a limit each one passes."""
        if len(self._sessions) + self._pending >= self.config.max_sessions:
            raise ControlPlaneError(
                "session_limit_reached",
                f"At most {self.config.max_sessions} package sessions may be open; close one",
                status=429,
            )
        if self._cached_bytes() + self._pending_bytes + incoming > self.config.max_cache_bytes:
            raise ControlPlaneError(
                "cache_limit_reached",
                f"Cached snapshots would exceed {self.config.max_cache_bytes} bytes",
                status=429,
            )

    def _open_bytes(self, data: bytes, source: dict) -> dict:
        """One capture, one hash, one on-disk snapshot, then evaluation only."""
        if len(data) > self.config.max_package_bytes:
            raise ControlPlaneError(
                "package_too_large",
                f"Package exceeds the {self.config.max_package_bytes}-byte limit",
                status=413,
            )
        archive_sha256 = sha256(data)
        with self._lock:
            self.purge_expired()
            self._check_capacity(len(data))
            session_id = token_urlsafe(18)
            directory = self.cache_dir / f"{SESSION_PREFIX}{session_id}"
            directory.mkdir(mode=0o700)
            self._pending += 1
            self._pending_bytes += len(data)
        snapshot = directory / SNAPSHOT_NAME
        try:
            (directory / SESSION_MARKER).write_text(f"{self.instance_id}\n")
            fd = os.open(snapshot, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
            with os.fdopen(fd, "wb") as stream:
                stream.write(data)
            # The snapshot is authoritative from here on; confirm it is byte-identical.
            stored = read_regular_bytes(snapshot, self.config.max_package_bytes)
            if sha256(stored) != archive_sha256:
                raise ControlPlaneError(
                    "snapshot_unstable", "Snapshot bytes changed while being written", status=500
                )
            session = self._evaluate(session_id, directory, snapshot, archive_sha256, data, source)
        except BaseException:
            with self._lock:
                self._pending -= 1
                self._pending_bytes -= len(data)
            shutil.rmtree(directory, ignore_errors=True)
            raise
        with self._lock:
            # Releasing the reservation and registering the session is one step, so
            # a concurrent open never sees a moment where neither is counted.
            self._pending -= 1
            self._pending_bytes -= len(data)
            self._sessions[session_id] = session
        return session.summary

    def _evaluate(self, session_id, directory, snapshot, archive_sha256, data, source) -> Session:
        evaluation = evaluate_snapshot(snapshot)
        if not evaluation.structurally_valid:
            raise ControlPlaneError(
                "package_rejected",
                "The package failed structural validation and was not opened",
                status=422,
                details={
                    "validation": evaluation.as_json(),
                    "archive_sha256": archive_sha256,
                    "source": dict(source),
                },
            )
        package = evaluation.package
        publisher = self._publisher_report(package)
        created = datetime.now(UTC)
        expires = created + timedelta(seconds=self.config.session_ttl_seconds)
        summary = build_summary(package, evaluation=evaluation.as_json(), publisher=publisher)
        session = Session(
            session_id=session_id,
            directory=directory,
            snapshot_path=snapshot,
            archive_sha256=archive_sha256,
            archive_bytes=len(data),
            source={**source, "opened_at": created.isoformat()},
            created_at=created.isoformat(),
            expires_at=expires.isoformat(),
            expires_monotonic=time.monotonic() + self.config.session_ttl_seconds,
            package=package,
            evaluation=evaluation.as_json(),
            publisher=publisher,
            summary=summary,
            decisions=initial_decisions(package),
            tool_approvals=initial_tool_approvals(package),
        )
        session.summary = self._compose_summary(session, summary)
        return session

    def _publisher_report(self, package: Package) -> dict:
        """Signature self-consistency first, then trust, never the other way round."""
        signature = signature_report(package)
        trust = self.trust.evaluate(
            signer_fingerprint=(
                signature["signer_fingerprint"]
                if signature["signature_status"] == "valid"
                else None
            ),
            claimed_publisher_id=package.manifest["publisher"]["id"],
            package_id=package.manifest["package_id"],
        )
        return {
            "claimed_id": package.manifest["publisher"]["id"],
            "claimed_name": package.manifest["publisher"]["name"],
            **signature,
            **trust,
        }

    def _compose_summary(self, session: Session, summary: dict) -> dict:
        """Attach session-scoped facts to a freshly built package summary."""
        return {
            **summary,
            "session": {
                "id": session.session_id,
                "created_at": session.created_at,
                "expires_at": session.expires_at,
                "ttl_seconds": self.config.session_ttl_seconds,
            },
            "source": dict(session.source),
            "snapshot": {
                "archive_sha256": session.archive_sha256,
                "archive_bytes": session.archive_bytes,
                "captured_once": True,
                "path": str(session.snapshot_path),
            },
            "authorization": {
                "state": "issued" if session.receipt else "pending",
                "receipt_id": session.receipt["receipt_id"] if session.receipt else None,
                "runnable": bool(session.receipt and session.receipt["runnable"]),
            },
            "run_plan": {
                "state": "prepared" if session.run_plan else "absent",
                "run_plan_id": session.run_plan["run_plan_id"] if session.run_plan else None,
                "ready": bool(session.run_plan and session.run_plan["readiness"]["ready"]),
            },
            "model_requirements_normalized": requirement_set(session.package),
            "tool_requirements": {
                "declared_tool_ids": sorted(session.package.tools),
                "tool_count": len(session.package.tools),
                "registry_evaluated": session.tool_evaluation is not None,
                "bound_tool_count": (
                    sum(1 for item in session.tool_evaluation["tools"] if item["binding"])
                    if session.tool_evaluation
                    else 0
                ),
                "note": (
                    "Declaring a tool is a request. A host implementation and an explicit "
                    "approval are separate facts, and both are required before a run plan "
                    "can bind one."
                ),
            },
            "execution": {
                "performed": False,
                "note": "Opening and inspecting a package never executes it.",
            },
        }

    def _refresh_trust(self) -> int:
        """Re-evaluate every open session after an operator trust change.

        Issued receipts are deliberately left alone: each one records the trust
        state at the moment consent was given. A caller that wants the new state
        reflected in a receipt must authorize again.
        """
        with self._lock:
            for session in self._sessions.values():
                session.publisher = self._publisher_report(session.package)
                session.summary = self._compose_summary(
                    session,
                    build_summary(
                        session.package,
                        evaluation=session.evaluation,
                        publisher=session.publisher,
                    ),
                )
            return len(self._sessions)

    # -- reads ---------------------------------------------------------------
    def summary(self, session_id: str) -> dict:
        return self._session(session_id).summary

    def permissions(self, session_id: str) -> dict:
        session = self._session(session_id)
        request = build_request(
            session.package,
            session_id=session.session_id,
            decisions=session.decisions,
            tool_approvals=session.tool_approvals,
        )
        request["blocking_reasons"] = blocking_reasons(
            session.package,
            evaluation=session.evaluation,
            publisher=session.publisher,
            decisions=session.decisions,
            policy=self.config.policy,
        )
        request["browser_policy"] = self.config.policy.as_json()
        return request

    def authorization(self, session_id: str) -> dict:
        session = self._session(session_id)
        if session.receipt is None:
            raise ControlPlaneError(
                "authorization_absent",
                "This session has no authorization receipt yet",
                status=404,
            )
        return session.receipt

    def list_sessions(self) -> dict:
        with self._lock:
            self.purge_expired()
            return {
                "sessions": [
                    session.descriptor()
                    for session in sorted(self._sessions.values(), key=lambda item: item.created_at)
                ],
                "max_sessions": self.config.max_sessions,
                "cached_bytes": self._cached_bytes(),
                "max_cache_bytes": self.config.max_cache_bytes,
            }

    # -- authorization -------------------------------------------------------
    def authorize(
        self,
        session_id: str,
        *,
        package_digest,
        decisions,
        tool_approvals=None,
        resource_registry=None,
        resource_selections=None,
    ):
        """Record explicit decisions and issue a digest-bound receipt.

        A permission that requests a host resource carries the person's pick,
        validated here against the host resource registry supplied with the
        same call, and frozen into the receipt by id and digest.
        """
        session = self._session(session_id)
        self._require_digest(session, package_digest)
        granted = normalize_decisions(session.package, decisions)
        approvals = normalize_tool_approvals(session.package, tool_approvals)
        registry = (
            normalize_resource_registry(resource_registry)
            if resource_registry is not None
            else None
        )
        resource_grants = normalize_resource_selections(
            session.package, registry, granted, resource_selections
        )
        receipt = build_receipt(
            session.package,
            session_id=session.session_id,
            source=session.source,
            archive_sha256=session.archive_sha256,
            evaluation=session.evaluation,
            publisher=session.publisher,
            trust_state=self.trust.state(),
            decisions=granted,
            tool_approvals=approvals,
            policy=self.config.policy,
            instance_id=self.instance_id,
            expires_at=session.expires_at,
            resource_grants=resource_grants,
            resource_registry=registry,
        )
        with self._lock:
            session.decisions = granted
            session.tool_approvals = approvals
            if registry is not None:
                session.resource_registry = registry
            session.receipt = receipt
            # A new consent decision supersedes any plan prepared under the old
            # one. Keeping a ready plan alive across a permission change is
            # exactly how a withdrawn decision would stay silently usable, and
            # any lease issued under it goes with it.
            session.run_plan = None
            self._release_all(session)
            session.summary["authorization"] = {
                "state": "issued",
                "receipt_id": receipt["receipt_id"],
                "runnable": receipt["runnable"],
            }
            session.summary["run_plan"] = {
                "state": "absent",
                "run_plan_id": None,
                "ready": False,
            }
        return receipt

    # -- host resources ------------------------------------------------------
    def evaluate_resources(self, session_id: str, *, package_digest, resource_registry) -> dict:
        """Evaluate a host-supplied resource registry against this package.

        Which declared permissions request a host resource this host offers,
        the options a person may choose from (opaque ids and display-safe
        labels), and which one the current receipt holds. The registry carries
        no values; this method reads declarations and compares strings.
        """
        session = self._session(session_id)
        self._require_digest(session, package_digest)
        registry = normalize_resource_registry(resource_registry)
        with self._lock:
            # Retained so `preflight` compares frozen grants with what the host
            # holds now, not with what it held when the person chose.
            session.resource_registry = registry
        return {
            "session_id": session.session_id,
            **evaluate_resources(
                session.package,
                registry,
                decisions=session.decisions,
                grants=(session.receipt or {}).get("resource_grants") or [],
            ),
        }

    # -- the task ------------------------------------------------------------
    def validate_input(self, session_id: str, *, input_value) -> dict:
        """Check one proposed task against the package's own input schema.

        The same offline validator the runner applies before any instruction
        reaches a model, run early so a person sees a precise reason instead
        of a refused run. It reads the snapshot and changes nothing.
        """
        session = self._session(session_id)
        return {
            "session_id": session.session_id,
            "package_digest": session.package.digest,
            **validate_task_input(session.package, input_value),
        }

    # -- tools ---------------------------------------------------------------
    def tool_requirements(self, session_id: str) -> dict:
        """What this package asks a host to implement, host-neutrally."""
        session = self._session(session_id)
        return {
            "session_id": session.session_id,
            "package_digest": session.package.digest,
            **tool_requirement_set(session.package),
            "implementation_kinds": list(IMPLEMENTATION_KINDS),
            "approval_model": {
                "per_tool": True,
                "note": (
                    "Every declared tool needs its own approval in the authorization receipt, "
                    "in addition to the permissions it links to."
                ),
            },
        }

    def evaluate_tools(self, session_id: str, *, package_digest, tool_registry) -> dict:
        """Evaluate a host-supplied tool registry against this package.

        The registry is the host's statement about its own implementations.
        This method validates its shape, refuses unknown fields, and compares
        it with what the package declares. It calls nothing.
        """
        session = self._session(session_id)
        self._require_digest(session, package_digest)
        normalized = normalize_registry(tool_registry)
        evaluation = evaluate_registry(
            session.package,
            normalized,
            decisions=session.decisions,
            tool_approvals=session.tool_approvals,
        )
        with self._lock:
            # Retained so `prepare_run_plan` binds the same registry state that
            # produced the verdicts a person was shown, and so `preflight` can
            # say whether those verdicts still hold.
            session.tool_registry = normalized
            session.tool_evaluation = evaluation
        return evaluation

    def _tool_evaluation(self, session: Session) -> dict | None:
        """Re-evaluate the last supplied registry against current consent."""
        if session.tool_registry is None:
            return None
        return evaluate_registry(
            session.package,
            session.tool_registry,
            decisions=session.decisions,
            tool_approvals=session.tool_approvals,
        )

    # -- models and run plans ------------------------------------------------
    def model_requirements(self, session_id: str) -> dict:
        """The package's declared model requirements, normalized generically."""
        session = self._session(session_id)
        return {
            "session_id": session.session_id,
            "package_digest": session.package.digest,
            "requirements": requirement_set(session.package),
            "execution_modes": list(EXECUTION_MODES),
            "binding_strategies": [BINDING_SINGLE_MODEL],
            "mode_required_permission_ids": {
                mode: mode_permission_ids(session.package, mode) for mode in EXECUTION_MODES
            },
        }

    def evaluate_models(self, session_id: str, *, package_digest, catalog) -> dict:
        """Evaluate a host-supplied model catalog against this package.

        The catalog is the host's statement about its own models. This method
        validates its shape, refuses unknown fields, and compares it with the
        package's declarations. It contacts nothing.
        """
        session = self._session(session_id)
        self._require_digest(session, package_digest)
        normalized = normalize_catalog(catalog)
        evaluation = evaluate_catalog(session.package, normalized)
        with self._lock:
            # Retained so `prepare_run_plan` binds the same catalog state that
            # produced the verdict a person was shown.
            session.catalog = normalized
            session.model_evaluation = evaluation
        return evaluation

    def prepare_run_plan(
        self,
        session_id: str,
        *,
        package_digest,
        receipt_id,
        model_id,
        catalog,
        tool_registry=None,
        probe_tool_id=None,
        execution_mode=MODE_MODEL,
        binding_strategy=BINDING_SINGLE_MODEL,
        resource_registry=None,
    ) -> dict:
        """Freeze one package + authorization + model + tools into a plan.

        A `tool_probe` plan is the same artifact with a strictly smaller
        authority: it names one declared tool, binds one implementation of it,
        binds no model, and asks nothing about the package's other tools. A
        package this host cannot run is still a package this host cannot run;
        the probe plan does not pretend otherwise, and a `model` plan for the
        same session still refuses.
        """
        session = self._session(session_id)
        self._require_digest(session, package_digest)
        mode = validate_mode(execution_mode)
        binding = validate_binding(binding_strategy)
        if session.receipt is None:
            raise ControlPlaneError(
                "authorization_absent",
                "Authorize this package before preparing a run plan",
                status=409,
            )
        if not isinstance(receipt_id, str) or receipt_id != session.receipt["receipt_id"]:
            # The same anti-confusion rule `authorize` applies to digests: a
            # caller must echo the authorization it showed the person.
            raise ControlPlaneError(
                "receipt_mismatch",
                "receipt_id does not match this session's current authorization receipt",
                status=409,
                details={"session_receipt_id": session.receipt["receipt_id"]},
            )
        probe = None
        if mode == MODE_TOOL_PROBE:
            if not isinstance(probe_tool_id, str) or not probe_tool_id:
                raise ControlPlaneError(
                    "invalid_request", "A tool probe plan must name the tool it is for"
                )
            probe = probe_tool_id
        elif probe_tool_id is not None:
            raise ControlPlaneError(
                "invalid_request", "probe_tool_id belongs to a tool_probe plan only"
            )
        normalized = normalize_catalog(catalog)
        descriptor = None
        compatibility = None
        if mode == MODE_MODEL:
            if not isinstance(model_id, str) or not model_id:
                raise ControlPlaneError("invalid_request", "model_id must be a non-empty string")
            descriptor = find_model(normalized, model_id)
            if descriptor is None:
                raise ControlPlaneError(
                    "model_unknown",
                    f"No model {model_id!r} in the supplied host catalog",
                    status=409,
                )
        evaluation = evaluate_catalog(session.package, normalized)
        if descriptor is not None:
            compatibility = next(
                item for item in evaluation["models"] if item["model_id"] == model_id
            )
        # A tool-bearing package needs a registry supplied with the plan, and a
        # tool-free one must not be able to acquire bindings by accident.
        registry = None
        tool_evaluation = None
        if session.package.tools:
            if tool_registry is None:
                raise ControlPlaneError(
                    "tool_registry_missing",
                    "This package declares tools, so a host tool registry must be supplied "
                    "before a run plan can bind them",
                    status=409,
                    details={"required_tool_ids": sorted(session.package.tools)},
                )
            registry = normalize_registry(tool_registry)
            tool_evaluation = evaluate_registry(
                session.package,
                registry,
                decisions=session.decisions,
                tool_approvals=session.tool_approvals,
            )
        elif tool_registry is not None:
            registry = normalize_registry(tool_registry)
            tool_evaluation = evaluate_registry(session.package, registry)
        # Host resources the receipt granted are compared with what the host
        # holds right now, supplied with this call, before a plan names them.
        resources = (
            normalize_resource_registry(resource_registry)
            if resource_registry is not None
            else session.resource_registry
        )
        blockers = preparation_blockers(
            session.package,
            mode=mode,
            evaluation=evaluation,
            receipt=session.receipt,
            publisher=session.publisher,
            compatibility=compatibility,
            policy=self.config.policy,
            tool_evaluation=tool_evaluation,
            probe_tool_id=probe,
            resource_registry=resources,
        )
        if blockers:
            # A run plan exists only when it is ready. Writing down a plan that
            # could not be run would create an artifact asserting a binding this
            # host refuses, and "prepared" would stop meaning anything. Every
            # reason is returned so a UI can send the person to the exact
            # control that fixes it. A plan that becomes unusable *later* is a
            # different thing, and that is what `preflight` reports.
            raise ControlPlaneError(
                "run_plan_refused",
                blockers[0]["message"],
                status=409,
                details={"blocking_reasons": blockers},
            )
        plan = build_run_plan(
            session.package,
            session_id=session.session_id,
            source=session.source,
            archive_sha256=session.archive_sha256,
            evaluation=evaluation,
            catalog=normalized,
            descriptor=descriptor,
            compatibility=compatibility,
            receipt=session.receipt,
            publisher=session.publisher,
            trust_state=self.trust.state(),
            evaluation_layers=session.evaluation,
            policy=self.config.policy,
            instance_id=self.instance_id,
            mode=mode,
            binding_strategy=binding,
            expires_at=session.expires_at,
            blocking_reasons=blockers,
            tool_evaluation=tool_evaluation,
            tool_registry=registry,
            probe_tool_id=probe,
            resource_registry=resources,
        )
        with self._lock:
            session.catalog = normalized
            session.model_evaluation = evaluation
            if registry is not None:
                session.tool_registry = registry
                session.tool_evaluation = tool_evaluation
            if resources is not None:
                session.resource_registry = resources
            self._release_all(session)
            session.run_plan = plan
            session.summary["run_plan"] = {
                "state": "prepared",
                "run_plan_id": plan["run_plan_id"],
                "ready": plan["readiness"]["ready"],
            }
        return {"run_plan": plan, "preflight": self._preflight(session)}

    def run_plan(self, session_id: str) -> dict:
        """The prepared plan plus a freshly recomputed readiness check."""
        session = self._session(session_id)
        if session.run_plan is None:
            raise ControlPlaneError(
                "run_plan_absent", "This session has no prepared run plan", status=404
            )
        return {"run_plan": session.run_plan, "preflight": self._preflight(session)}

    def clear_run_plan(self, session_id: str) -> dict:
        session = self._session(session_id)
        with self._lock:
            existing = session.run_plan
            session.run_plan = None
            self._release_all(session)
            session.summary["run_plan"] = {"state": "absent", "run_plan_id": None, "ready": False}
        return {
            "session_id": session_id,
            "cleared": existing is not None,
            "run_plan_id": existing["run_plan_id"] if existing else None,
        }

    # -- execution leases ----------------------------------------------------
    def issue_execution_lease(
        self, session_id: str, *, package_digest, run_plan_id, run_plan_sha256
    ) -> dict:
        """Hand one private, one-time copy of this snapshot to a trusted runner.

        This is the only operation that lets package bytes leave the control
        plane, and it is gated on the same question every other gate asks: is
        this session's run plan ready *right now*. The control plane still runs
        nothing; what it does here is copy bytes and say that it did.
        """
        session = self._session(session_id)
        self._require_digest(session, package_digest)
        if session.run_plan is None:
            raise ControlPlaneError(
                "run_plan_absent", "This session has no prepared run plan", status=404
            )
        plan = session.run_plan
        if run_plan_id != plan["run_plan_id"] or run_plan_sha256 != plan["run_plan_sha256"]:
            # The same anti-confusion rule `authorize` applies to digests: the
            # caller must echo the plan it read.
            raise ControlPlaneError(
                "run_plan_mismatch",
                "run_plan_id/run_plan_sha256 do not match this session's prepared plan",
                status=409,
                details={
                    "session_run_plan_id": plan["run_plan_id"],
                    "session_run_plan_sha256": plan["run_plan_sha256"],
                },
            )
        state = self._preflight(session)
        if not state["ready"] or state["stale"]:
            reasons = state["stale_reasons"] or state["blocking_reasons"]
            raise ControlPlaneError(
                "run_plan_stale",
                reasons[0]["message"] if reasons else "This run plan is not ready",
                status=409,
                details={"preflight": state},
            )
        with self._lock:
            self.purge_expired()
            live = [lease for lease in session.leases.values() if not lease.expired()]
            if live:
                # One active execution per session. A second lease would be a
                # second run against the same consent with no way to relate them.
                raise ControlPlaneError(
                    "execution_lease_active",
                    "An execution lease is already outstanding for this session; release it first",
                    status=409,
                    details={"lease_id": live[0].lease_id},
                )
            ttl = min(
                self.config.execution_lease_ttl_seconds,
                max(1, int(session.expires_monotonic - time.monotonic())),
            )
            lease = issue_lease(
                directory=session.directory,
                snapshot_path=session.snapshot_path,
                archive_sha256=session.archive_sha256,
                package_digest=session.package.digest,
                run_plan_id=plan["run_plan_id"],
                run_plan_sha256=plan["run_plan_sha256"],
                ttl_seconds=ttl,
                max_bytes=self.config.max_package_bytes,
            )
            session.leases[lease.lease_id] = lease
            if "once" in plan["authorization"]["decisions"].values():
                # Handing the bytes to a runner starts a run, and a run is
                # what a one-time grant was for.
                session.spent_receipt_ids.add(plan["authorization"]["receipt_id"])
        return {
            "session_id": session_id,
            "lease": lease.as_json(include_path=True),
            "preflight": state,
            "execution": {
                "performed": False,
                "note": (
                    "A lease is bytes plus permission to read them once. The control plane "
                    "does not run them, and a runner must re-verify them independently."
                ),
            },
        }

    def release_execution_lease(self, session_id: str, lease_id: str) -> dict:
        """Delete one lease's private copy. Safe to call more than once."""
        session = self._session(session_id)
        with self._lock:
            lease = session.leases.pop(lease_id, None)
            if lease is not None:
                release_lease(lease)
        return {
            "session_id": session_id,
            "lease_id": lease_id,
            "released": lease is not None,
        }

    def _preflight(self, session: Session) -> dict:
        plan = session.run_plan
        return preflight(
            plan,
            package=session.package,
            publisher=session.publisher,
            receipt=session.receipt,
            trust_state=self.trust.state(),
            policy=self.config.policy,
            tool_evaluation=self._tool_evaluation(session),
            resource_registry=session.resource_registry,
            once_spent=(
                plan["authorization"]["receipt_id"] in session.spent_receipt_ids
                and "once" in plan["authorization"]["decisions"].values()
            ),
        )

    def _release_all(self, session: Session) -> None:
        for lease in list(session.leases.values()):
            release_lease(lease)
        session.leases.clear()

    def _require_digest(self, session: Session, package_digest) -> None:
        if not isinstance(package_digest, str) or not package_digest:
            raise ControlPlaneError(
                "invalid_request",
                "package_digest is required: the caller must echo the digest it showed the user",
            )
        if package_digest != session.package.digest:
            raise ControlPlaneError(
                "digest_mismatch",
                "package_digest does not match this session's package",
                status=409,
                details={
                    "session_digest": session.package.digest,
                    "submitted_digest": package_digest,
                },
            )

    # -- trust ---------------------------------------------------------------
    def trust_list(self) -> dict:
        return {
            "trust_store": self.trust.state(),
            "publishers": [entry.as_json() for entry in self.trust.entries()],
            "note": (
                "Only this authenticated host API and the agentpkg CLI mutate these pins. "
                "No package operation can add, change or remove a trust entry."
            ),
        }

    def trust_add(self, key, **options) -> dict:
        entry = self.trust.add(key, **options)
        self._refresh_trust()
        return {"added": entry.as_json(), "trust_store": self.trust.state()}

    def trust_remove(self, key_fingerprint: str) -> dict:
        entry = self.trust.remove(key_fingerprint)
        self._refresh_trust()
        return {"removed": entry.as_json(), "trust_store": self.trust.state()}

    def trust_session_publisher(
        self,
        session_id: str,
        *,
        signer_fingerprint: str,
        scope: str = "package",
        notes: str | None = None,
        replace: bool = False,
    ) -> dict:
        """Pin the key that signed one open session, and nothing else.

        The key comes from that session's own verified signature envelope, so a
        caller never supplies key material and cannot pin a key belonging to a
        different artifact. The caller must echo the fingerprint it displayed,
        which is the same anti-confusion rule `authorize` applies to digests.
        """
        if scope not in {"package", "publisher"}:
            raise ControlPlaneError(
                "invalid_request", "scope must be 'package' (narrow) or 'publisher'"
            )
        session = self._session(session_id)
        if session.publisher["signature_status"] != "valid":
            raise ControlPlaneError(
                "signature_not_valid",
                "Only a self-consistent signature can have its key pinned; this package's "
                f"signature status is {session.publisher['signature_status']!r}",
                status=409,
            )
        if signer_fingerprint != session.publisher["signer_fingerprint"]:
            raise ControlPlaneError(
                "fingerprint_mismatch",
                "signer_fingerprint does not match this session's signer; refusing to pin",
                status=409,
                details={"session_signer_fingerprint": session.publisher["signer_fingerprint"]},
            )
        manifest = session.package.manifest
        key = embedded_public_key(session.package.signature)
        entry = self.trust.add(
            key,
            display_name=manifest["publisher"]["name"],
            publisher_id=manifest["publisher"]["id"],
            package_id_prefix=manifest["package_id"] if scope == "package" else None,
            notes=notes,
            replace=replace,
        )
        self._refresh_trust()
        return {
            "added": entry.as_json(),
            "scope": scope,
            "trust_store": self.trust.state(),
            "publisher": self._session(session_id).publisher,
        }

    # -- introspection -------------------------------------------------------
    def health(self) -> dict:
        return {
            "service": SERVICE,
            "status": "ok",
            "api_version": API_VERSION,
            "agentpkg_version": __version__,
            "package_format": "agent.pkg 0.1",
            "execution": "disabled",
        }

    def status(self) -> dict:
        with self._lock:
            self.purge_expired()
            return {
                **self.health(),
                "instance_id": self.instance_id,
                "started_at": self.started_at,
                "open_sessions": len(self._sessions),
                "cached_bytes": self._cached_bytes(),
                "cache_dir": str(self.cache_dir),
                "removed_stale_snapshots_at_startup": self.removed_stale_snapshots,
                "trust_store": self.trust.state(),
                "limits": self.config.as_json(),
                "capabilities": {
                    "open_file": True,
                    "open_url": True,
                    # Reads one web page for advertised candidates; opens none.
                    "discover_website": True,
                    "authorize": True,
                    "evaluate_models": True,
                    "evaluate_tools": True,
                    "prepare_run_plan": True,
                    # A lease hands immutable bytes to a separate trusted
                    # runner. This service still executes nothing itself.
                    "issue_execution_lease": True,
                    "execute": False,
                },
                "open_execution_leases": sum(
                    len(session.leases) for session in self._sessions.values()
                ),
                "execution_modes": list(EXECUTION_MODES),
                "binding_strategies": [BINDING_SINGLE_MODEL],
                "website_discovery": discovery.profile(),
                "host_model_catalog": {
                    "source": "supplied_by_host",
                    "note": (
                        "This service discovers no models of its own. A trusted host sends a "
                        "bounded, provider-neutral catalog; package requirement semantics and "
                        "run-plan integrity stay here."
                    ),
                },
                "host_tool_registry": {
                    "source": "supplied_by_host",
                    "implementation_kinds": list(IMPLEMENTATION_KINDS),
                    "note": (
                        "This service registers no tool implementation of its own and calls "
                        "none. A trusted host sends a bounded, service-neutral registry; "
                        "contract compatibility, binding digests and run-plan integrity "
                        "stay here."
                    ),
                },
            }


def default_cache_dir() -> Path:
    return Path(tempfile.gettempdir()) / "agentpkg-browser-cache"


def default_trust_store() -> Path:
    override = os.environ.get("AGENTPKG_TRUST_STORE")
    if override:
        return Path(override).expanduser()
    base = os.environ.get("XDG_CONFIG_HOME")
    root = Path(base).expanduser() if base else Path.home() / ".config"
    return root / "agentpkg" / "trust.json"


__all__ = [
    "AgentPkgError",
    "ControlPlane",
    "ControlPlaneConfig",
    "ControlPlaneError",
    "default_cache_dir",
    "default_trust_store",
]
