"""Stable, machine-readable execution failures.

Codes are the contract. A caller branches on `code`, never on prose, and a
message never carries package payload content, model output, provider detail,
a credential or a filesystem path.
"""

from __future__ import annotations

from ..hostbridge.errors import BridgeError


class ExecutionError(BridgeError):
    """One refused or failed execution operation with a stable code."""


# Authority and handoff
ARTIFACT_INVALID = "execution_artifact_invalid"
ARTIFACT_MISMATCH = "execution_artifact_mismatch"
SIGNATURE_INVALID = "execution_signature_invalid"
PLAN_INVALID = "execution_plan_invalid"
INPUT_INVALID = "execution_input_invalid"

# Consent
PERMISSION_DENIED = "execution_permission_denied"
GRANT_UNSUPPORTED = "execution_grant_unsupported"

# The bound model cannot satisfy what the package declares
MODEL_INCOMPATIBLE = "execution_model_incompatible"

# Host capability limits of THIS milestone, not limits of the package format
TOOLS_NOT_SUPPORTED = "tools_not_supported"
OUTPUT_CAP_TOO_LARGE = "execution_output_cap_too_large"
EXPORT_PATH_RESERVED = "execution_export_path_reserved"

# Lifecycle
NOT_BOUND = "execution_not_bound"
ALREADY_STARTED = "execution_already_started"
ARTIFACTS_FAILED = "execution_artifacts_failed"


def invalid(message: str, **detail) -> ExecutionError:
    return ExecutionError(PLAN_INVALID, message, detail=detail or None)


__all__ = [
    "ALREADY_STARTED",
    "ARTIFACTS_FAILED",
    "ARTIFACT_INVALID",
    "ARTIFACT_MISMATCH",
    "EXPORT_PATH_RESERVED",
    "GRANT_UNSUPPORTED",
    "INPUT_INVALID",
    "MODEL_INCOMPATIBLE",
    "NOT_BOUND",
    "OUTPUT_CAP_TOO_LARGE",
    "PERMISSION_DENIED",
    "PLAN_INVALID",
    "SIGNATURE_INVALID",
    "TOOLS_NOT_SUPPORTED",
    "ExecutionError",
    "invalid",
]
