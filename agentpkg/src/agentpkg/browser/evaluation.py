"""Layered evaluation of one immutable snapshot.

Each layer is reported on its own. A browser UI must be able to say "the
archive parsed but its hashes disagree" or "the signature is cryptographically
valid but nobody has pinned that key" without any layer implying another.

Ordering matters: nothing downstream of a failed layer is evaluated, because
values read out of an unverified payload would not mean anything.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from ..errors import IntegrityError, SignatureError, ValidationError
from ..package import Package, read_archive
from ..signing import check_signature, embedded_public_key, fingerprint
from ..validation import validate_payload

SUPPORTED_EXECUTION_PROFILES = ("workflow.v0",)
RUNTIME_API = "agentpkg-runtime-v0"

NOT_EVALUATED = "not_evaluated"


@dataclass
class Evaluation:
    """Per-layer outcome plus the loaded package when every layer passed."""

    container_status: str = NOT_EVALUATED
    integrity_status: str = NOT_EVALUATED
    schema_status: str = NOT_EVALUATED
    runtime_status: str = NOT_EVALUATED
    errors: list = None
    package: Package | None = None

    def __post_init__(self):
        if self.errors is None:
            self.errors = []

    @property
    def structurally_valid(self) -> bool:
        return (
            self.container_status == "valid"
            and self.integrity_status == "valid"
            and self.schema_status == "valid"
        )

    def as_json(self) -> dict:
        return {
            "container_status": self.container_status,
            "integrity_status": self.integrity_status,
            "schema_status": self.schema_status,
            "runtime_status": self.runtime_status,
            "supported_execution_profiles": list(SUPPORTED_EXECUTION_PROFILES),
            "errors": list(self.errors),
        }


def evaluate_snapshot(path: str | Path) -> Evaluation:
    """Validate container, integrity, schema and runtime compatibility separately."""
    report = Evaluation()
    try:
        files, statement, signature = read_archive(path)
        report.container_status = "valid"
        report.integrity_status = "valid"
    except IntegrityError as exc:
        # The ZIP structure and payload gate passed; only the hashes disagree.
        report.container_status = "valid"
        report.integrity_status = "invalid"
        report.errors.append({"layer": "integrity", "message": str(exc)})
        return report
    except ValidationError as exc:
        report.container_status = "invalid"
        report.errors.append({"layer": "container", "message": str(exc)})
        return report

    try:
        manifest, graph, policy, tools = validate_payload(files)
        report.schema_status = "valid"
    except ValidationError as exc:
        report.schema_status = "invalid"
        report.errors.append({"layer": "schema", "message": str(exc)})
        return report

    report.package = Package(
        manifest, graph, policy, tools, files, statement, signature, Path(path), True
    )
    profile = manifest["entrypoint"]
    compatible = (
        profile in SUPPORTED_EXECUTION_PROFILES
        and manifest["runtime"]["api"] == RUNTIME_API
        and graph.get("profile", profile) == profile
    )
    report.runtime_status = "compatible" if compatible else "incompatible"
    if not compatible:
        report.errors.append(
            {
                "layer": "runtime",
                "message": (
                    f"Execution profile {profile!r} is not installed in this host; the package "
                    "remains inspectable but cannot be authorized for execution"
                ),
            }
        )
    return report


def signature_report(package: Package) -> dict:
    """Self-consistency only: `valid` here never means the publisher is trusted."""
    signature = package.signature
    if signature is None:
        return {
            "signature_status": "absent",
            "signature_reason": "no_signature_member",
            "signer_fingerprint": None,
            "signed_digest_matches": False,
        }
    try:
        key = embedded_public_key(signature)
    except SignatureError as exc:
        return {
            "signature_status": "invalid",
            "signature_reason": str(exc),
            "signer_fingerprint": None,
            "signed_digest_matches": False,
        }
    signer = fingerprint(key)
    try:
        check_signature(package, key)
    except SignatureError as exc:
        return {
            "signature_status": "invalid",
            "signature_reason": str(exc),
            # Reported so an operator can see which key failed, never as trust.
            "signer_fingerprint": signer,
            "signed_digest_matches": signature["digest"] == package.digest,
        }
    return {
        "signature_status": "valid",
        "signature_reason": "self_consistent_ed25519_signature",
        "signer_fingerprint": signer,
        "signed_digest_matches": True,
    }
