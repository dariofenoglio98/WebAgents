"""Independent verification of the exact bytes this runner was handed.

The parent already checked everything before it opened the descriptor: the
control plane's preflight re-verified digest, archive hash, signature, trust,
receipt and model, and the snapshot it leased has been immutable since the
package was opened. This module checks the cryptographic half of that again,
here, against the run plan the same message carried.

That duplication is the point. The runner is the process that will put package
instructions in front of a model, so it should not have to believe a claim
about which bytes it received — it should be able to compute it. Publisher
*trust* remains the host's decision, because a trust store is operator
configuration and not something bytes can establish; what the runner confirms
is that the identity it holds is the identity that was trusted.

Fail closed on any mismatch: there is no repair, no re-fetch, and no path to
reopen, by construction.
"""

from __future__ import annotations

import os
import stat
from secrets import compare_digest

from ..errors import AgentPkgError
from ..package import MAX_FILES, MAX_TOTAL_BYTES, Package, load_package_bytes, sha256
from ..signing import check_signature, embedded_public_key, fingerprint
from .errors import ARTIFACT_INVALID, ARTIFACT_MISMATCH, SIGNATURE_INVALID, ExecutionError

# The container limit plus the ZIP envelope slack the archive reader allows.
MAX_ARCHIVE_BYTES = MAX_TOTAL_BYTES + MAX_FILES * 1024


def read_execution_artifact(fd: int) -> bytes:
    """Read the whole archive from an inherited read-only descriptor.

    The descriptor must be a regular file. A symlink cannot be a descriptor —
    the parent resolved it when it opened the file, and it opened with
    `O_NOFOLLOW` — so what is checked here is that this is not a pipe, a device,
    a directory or a socket dressed up as package bytes.
    """
    try:
        info = os.fstat(fd)
    except OSError as exc:
        raise ExecutionError(
            ARTIFACT_INVALID,
            "The execution runner was not given a package descriptor. It is spawned by a "
            "trusted host with the immutable package archive on a dedicated descriptor.",
        ) from exc
    if not stat.S_ISREG(info.st_mode):
        raise ExecutionError(ARTIFACT_INVALID, "The package descriptor is not a regular file")
    if info.st_size > MAX_ARCHIVE_BYTES:
        raise ExecutionError(
            ARTIFACT_INVALID,
            f"The package archive exceeds the {MAX_ARCHIVE_BYTES}-byte container limit",
        )
    os.lseek(fd, 0, os.SEEK_SET)
    chunks: list[bytes] = []
    remaining = MAX_ARCHIVE_BYTES + 1
    while remaining > 0:
        chunk = os.read(fd, min(remaining, 1024 * 1024))
        if not chunk:
            break
        chunks.append(chunk)
        remaining -= len(chunk)
    data = b"".join(chunks)
    if len(data) > MAX_ARCHIVE_BYTES:
        raise ExecutionError(ARTIFACT_INVALID, "The package archive exceeds the container limit")
    if not data:
        raise ExecutionError(ARTIFACT_INVALID, "The package descriptor is empty")
    return data


def verify_execution_artifact(data: bytes, expected: dict) -> tuple[Package, dict]:
    """Load these bytes and confirm they are the artifact the run plan names.

    `expected` carries only identity: the archive hash, the package digest, the
    package id and version, and the signer fingerprint the host trusted.
    """
    archive_sha256 = sha256(data)
    if not compare_digest(archive_sha256, str(expected["archive_sha256"])):
        raise ExecutionError(
            ARTIFACT_MISMATCH,
            "The archive handed to the runner is not the archive the run plan names",
            detail={"expected": expected["archive_sha256"], "received": archive_sha256},
        )
    try:
        package = load_package_bytes(data)
    except AgentPkgError as exc:
        raise ExecutionError(
            ARTIFACT_INVALID, f"The execution artifact failed structural validation: {exc}"
        ) from exc
    if not compare_digest(package.digest, str(expected["digest"])):
        raise ExecutionError(
            ARTIFACT_MISMATCH,
            "The package digest does not match the run plan",
            detail={"expected": expected["digest"], "received": package.digest},
        )
    manifest = package.manifest
    for field, key in (("package_id", "package_id"), ("version", "version")):
        if manifest[field] != expected[key]:
            raise ExecutionError(
                ARTIFACT_MISMATCH,
                f"The package {field} does not match the run plan",
                detail={"expected": expected[key], "received": manifest[field]},
            )
    if package.signature is None:
        raise ExecutionError(
            SIGNATURE_INVALID, "The execution artifact carries no publisher signature"
        )
    try:
        key = embedded_public_key(package.signature)
        signer = fingerprint(key)
        check_signature(package, key)
    except AgentPkgError as exc:
        raise ExecutionError(
            SIGNATURE_INVALID, f"The execution artifact signature is not valid: {exc}"
        ) from exc
    if not compare_digest(signer, str(expected["signer_fingerprint"])):
        # The signature verifies, but against a different key than the one the
        # operator's trust decision was made about. Trust is the host's, so the
        # runner cannot re-evaluate it; it can and does refuse to run a package
        # whose cryptographic identity is not the trusted one.
        raise ExecutionError(
            ARTIFACT_MISMATCH,
            "The artifact was signed by a different key than the run plan recorded",
            detail={"expected": expected["signer_fingerprint"], "received": signer},
        )
    if manifest["entrypoint"] != "workflow.v0":
        raise ExecutionError(
            ARTIFACT_INVALID,
            f"This runner executes workflow.v0 only; the package selects "
            f"{manifest['entrypoint']!r}",
        )
    evidence = {
        "archive_sha256": archive_sha256,
        "archive_bytes": len(data),
        "digest": package.digest,
        "package_id": manifest["package_id"],
        "version": manifest["version"],
        "signer_fingerprint": signer,
        "signature_status": "valid",
        "entrypoint": manifest["entrypoint"],
        "execution_profile": package.graph.get("profile", manifest["entrypoint"]),
        "verified": [
            "archive_sha256",
            "container",
            "integrity",
            "schema",
            "package_digest",
            "package_identity",
            "publisher_signature",
            "signer_fingerprint",
            "execution_profile",
        ],
        "note": (
            "Publisher trust remains the host's decision. The runner confirms that the "
            "cryptographic identity it received is the identity the run plan recorded."
        ),
    }
    return package, evidence


__all__ = ["MAX_ARCHIVE_BYTES", "read_execution_artifact", "verify_execution_artifact"]
