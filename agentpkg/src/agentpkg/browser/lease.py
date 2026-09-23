"""One-time execution leases: how immutable bytes leave the control plane.

The control plane holds the only authoritative copy of a package — captured
once, hashed, and never rewritten. A runner must execute *those* bytes. Handing
it the snapshot's path would work and would also be the wrong shape: the path
outlives the decision, it can be reopened, and nothing about it says "this was
allowed once".

A lease is the smaller thing. It is a fresh private copy of the snapshot,
created only when the session's run plan is ready, named by a random identifier
the caller cannot predict, valid for a bounded time, and consumable once. The
control plane still executes nothing: it copies bytes and records that it did.

    control-plane snapshot  (0600, written once, hashed, immutable)
            |  issue_execution_lease: copy + rehash, only if preflight is ready
            v
    lease file              (0400, new directory, random name, short TTL)
            |  the plugin backend opens it O_RDONLY|O_NOFOLLOW and inherits the fd
            v
    execution runner        (re-verifies hash, digest, signature, signer)

What the runner receives is a descriptor, never a name, so the path below never
leaves the two trusted host processes that need it.
"""

from __future__ import annotations

import os
import shutil
import time
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from pathlib import Path
from secrets import token_urlsafe

from ..package import read_regular_bytes, sha256
from .errors import ControlPlaneError

LEASE_SCHEMA = "agentpkg-execution-lease-v0"
LEASE_PREFIX = "lease-"
LEASE_FILE = "package.agent.pkg"
# Long enough for a run to start, short enough that a forgotten lease is not a
# lasting copy. The runner holds an open descriptor, so expiry never interrupts
# a run that already began.
DEFAULT_LEASE_TTL_SECONDS = 900


@dataclass
class ExecutionLease:
    """One private copy of a snapshot, issued against one ready run plan."""

    lease_id: str
    directory: Path
    path: Path
    archive_sha256: str
    archive_bytes: int
    package_digest: str
    run_plan_id: str
    run_plan_sha256: str
    created_at: str
    expires_at: str
    expires_monotonic: float
    consumed: bool = False

    def expired(self, now: float | None = None) -> bool:
        return self.expires_monotonic <= (time.monotonic() if now is None else now)

    def as_json(self, *, include_path: bool) -> dict:
        record = {
            "schema": LEASE_SCHEMA,
            "lease_id": self.lease_id,
            "archive_sha256": self.archive_sha256,
            "archive_bytes": self.archive_bytes,
            "package_digest": self.package_digest,
            "run_plan_id": self.run_plan_id,
            "run_plan_sha256": self.run_plan_sha256,
            "created_at": self.created_at,
            "expires_at": self.expires_at,
            "consumed": self.consumed,
            "note": (
                "A one-time private copy of this session's immutable snapshot. The control "
                "plane does not execute it; a runner must re-verify its hash, digest and "
                "signature before running anything."
            ),
        }
        if include_path:
            # Only the authenticated local host API sees this, and the plugin
            # backend turns it into an inherited descriptor without ever
            # projecting it to the page.
            record["path"] = str(self.path)
        return record


def issue(
    *,
    directory: Path,
    snapshot_path: Path,
    archive_sha256: str,
    package_digest: str,
    run_plan_id: str,
    run_plan_sha256: str,
    ttl_seconds: int,
    max_bytes: int,
) -> ExecutionLease:
    """Copy the snapshot into a new private lease directory, and rehash it.

    The copy is read through the snapshot's own bounded reader, compared with
    the hash the session recorded when it captured the bytes, written with
    exclusive creation into a directory that did not exist a moment ago, and
    then read back and compared again. A mismatch at either end is a refusal,
    not a repair.
    """
    data = read_regular_bytes(snapshot_path, max_bytes)
    if sha256(data) != archive_sha256:
        raise ControlPlaneError(
            "snapshot_unstable",
            "The session snapshot no longer hashes to the value recorded when it was captured",
            status=500,
        )
    lease_id = token_urlsafe(18)
    lease_dir = directory / f"{LEASE_PREFIX}{lease_id}"
    lease_dir.mkdir(mode=0o700)
    path = lease_dir / LEASE_FILE
    try:
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o400)
        with os.fdopen(fd, "wb") as stream:
            stream.write(data)
        stored = read_regular_bytes(path, max_bytes)
        if sha256(stored) != archive_sha256:
            raise ControlPlaneError(
                "execution_lease_unstable",
                "The execution lease bytes changed while being written",
                status=500,
            )
    except BaseException:
        shutil.rmtree(lease_dir, ignore_errors=True)
        raise
    created = datetime.now(UTC)
    return ExecutionLease(
        lease_id=lease_id,
        directory=lease_dir,
        path=path,
        archive_sha256=archive_sha256,
        archive_bytes=len(data),
        package_digest=package_digest,
        run_plan_id=run_plan_id,
        run_plan_sha256=run_plan_sha256,
        created_at=created.isoformat(),
        expires_at=(created + timedelta(seconds=ttl_seconds)).isoformat(),
        expires_monotonic=time.monotonic() + ttl_seconds,
    )


def release(lease: ExecutionLease) -> None:
    """Remove the lease's private copy. Called on use, expiry and shutdown."""
    shutil.rmtree(lease.directory, ignore_errors=True)


__all__ = [
    "DEFAULT_LEASE_TTL_SECONDS",
    "LEASE_FILE",
    "LEASE_PREFIX",
    "LEASE_SCHEMA",
    "ExecutionLease",
    "issue",
    "release",
]
