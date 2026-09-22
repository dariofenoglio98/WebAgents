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
    policy: BrowserPolicy = field(default_factory=BrowserPolicy)

    def as_json(self) -> dict:
        return {
            "session_ttl_seconds": self.session_ttl_seconds,
            "max_sessions": self.max_sessions,
            "max_package_bytes": self.max_package_bytes,
            "max_cache_bytes": self.max_cache_bytes,
            "download_timeout_seconds": self.download_timeout_seconds,
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
        }


def _now() -> str:
    return datetime.now(UTC).isoformat()


class ControlPlane:
    """Thread-safe control plane. Holds no signing key and runs no package code."""

    def __init__(self, config: ControlPlaneConfig, *, transport=None):
        self.config = config
        self.instance_id = str(uuid4())
        self.started_at = _now()
        self.trust = TrustStore(config.trust_store_path)
        self._transport = transport
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
            expired = [s for s in self._sessions.values() if s.expires_monotonic <= now]
            for session in expired:
                self._drop(session)
            return len(expired)

    def _drop(self, session: Session) -> None:
        self._sessions.pop(session.session_id, None)
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
    def authorize(self, session_id: str, *, package_digest, decisions, tool_approvals=None):
        """Record explicit decisions and issue a digest-bound receipt."""
        session = self._session(session_id)
        if not isinstance(package_digest, str) or not package_digest:
            raise ControlPlaneError(
                "invalid_request",
                "package_digest is required: the caller must echo the digest it showed the user",
            )
        if package_digest != session.package.digest:
            raise ControlPlaneError(
                "digest_mismatch",
                "package_digest does not match this session's package; refusing to authorize",
                status=409,
                details={
                    "session_digest": session.package.digest,
                    "submitted_digest": package_digest,
                },
            )
        granted = normalize_decisions(session.package, decisions)
        approvals = normalize_tool_approvals(session.package, tool_approvals)
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
        )
        with self._lock:
            session.decisions = granted
            session.tool_approvals = approvals
            session.receipt = receipt
            session.summary["authorization"] = {
                "state": "issued",
                "receipt_id": receipt["receipt_id"],
                "runnable": receipt["runnable"],
            }
        return receipt

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
                    "authorize": True,
                    "execute": False,
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
