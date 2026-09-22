"""Immutable run plans: the last artifact before execution, and still not it.

A run plan answers *exactly what would run, with whose authority, on which
model* — and then stops. It binds five things that must not be able to drift
apart between the moment a person decided and the moment something runs:

    these bytes  ·  this signer and trust state  ·  this authorization receipt
    ·  this host model  ·  this catalog state

The plan itself is frozen and hashed. What can change is the world around it,
so readiness is **recomputed on every read** rather than stored as a verdict.
A plan that was ready when it was prepared can become stale, and saying so is
the point of separating the two.

Execution-mode requirements live here rather than in the package. A package may
declare its model permission optional because it can also run from fixtures;
choosing a model-backed run is a *run-time* decision that needs that permission
anyway. The package manifest is never rewritten to express this.
"""

from __future__ import annotations

from datetime import UTC, datetime
from uuid import uuid4

from ..package import Package, canonical_json, sha256
from .authorization import DENY, BrowserPolicy
from .errors import ControlPlaneError
from .hostmodels import INCOMPATIBLE, UNVERIFIED, catalog_reference

RUN_PLAN_SCHEMA = "agentpkg-run-plan-v0"
RUN_PLAN_VERSION = "0.1"

# The only execution mode a run plan can request today. Fixture and extractive
# runs remain development modes of the CLI; they are not offered by the browser
# and do not get a plan.
MODE_MODEL = "model"
EXECUTION_MODES = (MODE_MODEL,)

BINDING_SINGLE_MODEL = "single_model"
BINDING_STRATEGIES = (BINDING_SINGLE_MODEL,)

# Permission kinds a run mode needs on top of whatever the package marked
# required. Expressed as kinds, not identifiers, so no package name is ever
# special-cased: the runtime itself authorizes every declared permission of
# kind `model` before it will dispatch a model call.
MODE_REQUIRED_PERMISSION_KINDS = {MODE_MODEL: ("model",)}


def mode_permission_ids(package: Package, mode: str) -> list[str]:
    kinds = MODE_REQUIRED_PERMISSION_KINDS.get(mode, ())
    return sorted(
        permission["id"]
        for permission in package.policy["permissions"]
        if permission["kind"] in kinds
    )


def validate_mode(mode) -> str:
    if mode not in EXECUTION_MODES:
        raise ControlPlaneError(
            "unsupported_execution_mode",
            f"execution_mode must be one of {list(EXECUTION_MODES)}; got {mode!r}",
        )
    return mode


def validate_binding(strategy) -> str:
    if strategy not in BINDING_STRATEGIES:
        raise ControlPlaneError(
            "unsupported_binding_strategy",
            f"binding_strategy must be one of {list(BINDING_STRATEGIES)}; got {strategy!r}",
        )
    return strategy


def _reason(code: str, message: str, subject=None) -> dict:
    return {"code": code, "message": message, "subject": subject}


def preparation_blockers(
    package: Package,
    *,
    mode: str,
    evaluation: dict,
    receipt: dict | None,
    publisher: dict,
    compatibility: dict | None,
    policy: BrowserPolicy,
) -> list[dict]:
    """Every reason this run plan may not be prepared or is not ready.

    Returned in a stable code form so a UI can route a person back to the exact
    control that fixes it, instead of restating prose.
    """
    reasons: list[dict] = []
    if receipt is None:
        reasons.append(
            _reason(
                "authorization_missing",
                "Authorize the package before preparing a run.",
            )
        )
        return reasons
    if receipt["package"]["digest"] != package.digest:
        reasons.append(
            _reason(
                "authorization_package_mismatch",
                "The authorization receipt was issued for different package bytes.",
            )
        )
    if not receipt["runnable"]:
        for blocked in receipt["blocking_reasons"]:
            reasons.append(
                _reason(
                    "authorization_not_runnable",
                    f"Authorization is blocked: {blocked['message']}",
                    blocked.get("subject"),
                )
            )
    # Run-mode permissions: separate from, and additional to, whatever the
    # package marked required.
    required_ids = mode_permission_ids(package, mode)
    if not required_ids:
        reasons.append(
            _reason(
                "execution_mode_permission_undeclared",
                "This package declares no model permission, so it cannot request a "
                "model-backed run.",
            )
        )
    for permission_id in required_ids:
        if receipt["decisions"].get(permission_id, DENY) == DENY:
            reasons.append(
                _reason(
                    "execution_mode_permission_denied",
                    f"A model-backed run requires permission {permission_id!r}. "
                    "Update the permission and authorize again.",
                    permission_id,
                )
            )
    if policy.require_valid_signature and publisher["signature_status"] != "valid":
        reasons.append(
            _reason(
                "signature_not_valid",
                f"Browser policy requires a valid publisher signature "
                f"(status: {publisher['signature_status']}).",
            )
        )
    if policy.require_trusted_publisher and publisher["trust_status"] != "trusted":
        reasons.append(
            _reason(
                "publisher_not_trusted",
                f"Browser policy requires an operator-pinned publisher key "
                f"(status: {publisher['trust_status']}).",
            )
        )
    if compatibility is None:
        reasons.append(_reason("model_not_selected", "Select a model for this run."))
        return reasons
    if not compatibility["available"]:
        reasons.append(
            _reason(
                "model_unavailable",
                "The selected model is not currently usable on this host.",
                compatibility["model_id"],
            )
        )
    if not compatibility["selectable"]:
        reasons.append(
            _reason(
                "model_not_selectable",
                "This host does not allow this model to be chosen manually.",
                compatibility["model_id"],
            )
        )
    if compatibility["status"] == INCOMPATIBLE:
        reasons.append(
            _reason(
                "model_incompatible",
                "The selected model does not satisfy this package's model requirements.",
                compatibility["model_id"],
            )
        )
    elif compatibility["status"] == UNVERIFIED and policy.require_confirmed_model_compatibility:
        unknown = ", ".join(compatibility["unknown"]) or "one or more requirements"
        reasons.append(
            _reason(
                "model_compatibility_unverified",
                f"This host does not report enough about the selected model to confirm {unknown}.",
                compatibility["model_id"],
            )
        )
    if evaluation["package_digest"] != package.digest:
        reasons.append(
            _reason(
                "evaluation_package_mismatch",
                "The compatibility evaluation was computed for different package bytes.",
            )
        )
    return reasons


def build_run_plan(
    package: Package,
    *,
    session_id: str,
    source: dict,
    archive_sha256: str,
    evaluation: dict,
    catalog: dict,
    descriptor: dict,
    compatibility: dict,
    receipt: dict,
    publisher: dict,
    trust_state: dict,
    evaluation_layers: dict,
    policy: BrowserPolicy,
    instance_id: str,
    mode: str,
    binding_strategy: str,
    expires_at: str,
    blocking_reasons: list[dict],
) -> dict:
    """Freeze one decision into a hashed, self-describing artifact."""
    created = datetime.now(UTC)
    plan = {
        "schema": RUN_PLAN_SCHEMA,
        "run_plan_version": RUN_PLAN_VERSION,
        "run_plan_id": f"rp_{uuid4().hex}",
        "created_at": created.isoformat(),
        "expires_at": expires_at,
        "session_id": session_id,
        "control_plane": {
            "service": "agentpkg-browser-control-plane",
            "api_version": "v0",
            "instance_id": instance_id,
        },
        "source": dict(source),
        "package": {
            "package_id": package.manifest["package_id"],
            "name": package.manifest["name"],
            "version": package.manifest["version"],
            "digest": package.digest,
            "archive_sha256": archive_sha256,
            "entrypoint": package.manifest["entrypoint"],
            "execution_profile": package.graph.get("profile", package.manifest["entrypoint"]),
        },
        "publisher": {
            "claimed_id": package.manifest["publisher"]["id"],
            "claimed_name": package.manifest["publisher"]["name"],
            "signer_fingerprint": publisher["signer_fingerprint"],
            "signature_status": publisher["signature_status"],
            "trust_status": publisher["trust_status"],
            "trust_reason": publisher["trust_reason"],
        },
        "trust_store": dict(trust_state),
        "validation": dict(evaluation_layers),
        "authorization": {
            "receipt_id": receipt["receipt_id"],
            "receipt_sha256": receipt["receipt_sha256"],
            "issued_at": receipt["issued_at"],
            "expires_at": receipt["expires_at"],
            "runnable": receipt["runnable"],
            "decisions": dict(sorted(receipt["decisions"].items())),
            "tool_approvals": dict(sorted(receipt["tool_approvals"].items())),
            "granted_permission_ids": list(receipt["granted_permission_ids"]),
        },
        "execution": {
            "profile": package.graph.get("profile", package.manifest["entrypoint"]),
            "mode": mode,
            "binding_strategy": binding_strategy,
            "required_permission_ids": mode_permission_ids(package, mode),
            "performed": False,
            "note": (
                "A run plan is a preflight artifact. This control plane never executes a "
                "package; a later runner must re-verify the digest, archive hash, signature, "
                "trust, receipt and model availability before dispatching anything."
            ),
        },
        "model_binding": {
            "strategy": binding_strategy,
            "selected_at": created.isoformat(),
            "host_model_id": descriptor["id"],
            "provider_id": descriptor["provider_id"],
            "model_id": descriptor["model_id"],
            "display_name": descriptor["display_name"],
            # The exact descriptor the verdict was computed from, so a later
            # runner can compare the host's answer then against its answer now.
            "descriptor": descriptor,
            "compatibility": compatibility,
            "catalog": catalog_reference(catalog),
        },
        "model_requirements": evaluation["requirements"],
        "browser_policy": policy.as_json(),
        "readiness": {
            "state": "ready" if not blocking_reasons else "blocked",
            "ready": not blocking_reasons,
            "compatibility_status": compatibility["status"],
            "blocking_reasons": blocking_reasons,
        },
    }
    plan["run_plan_sha256"] = sha256(canonical_json(plan))
    return plan


def preflight(
    plan: dict,
    *,
    package: Package,
    publisher: dict,
    receipt: dict | None,
    trust_state: dict,
    policy: BrowserPolicy,
    now: datetime | None = None,
) -> dict:
    """Recompute whether a frozen plan still describes the current world.

    Deliberately conservative: anything that changed in the consent, the
    identity, or the trust evaluation behind a plan makes it stale rather than
    quietly ready. A stale plan is not repaired here — the person prepares a
    new one, which is the only way the new state gets recorded.
    """
    moment = now or datetime.now(UTC)
    reasons: list[dict] = []

    if package.digest != plan["package"]["digest"]:
        reasons.append(
            _reason("package_changed", "The session's package bytes are not the planned bytes.")
        )
    if receipt is None:
        reasons.append(_reason("authorization_cleared", "The authorization receipt is gone."))
    elif receipt["receipt_id"] != plan["authorization"]["receipt_id"]:
        reasons.append(
            _reason(
                "authorization_superseded",
                "A newer authorization replaced the one this plan was prepared under.",
            )
        )
    elif receipt["receipt_sha256"] != plan["authorization"]["receipt_sha256"]:
        reasons.append(
            _reason("authorization_changed", "The authorization receipt changed after preparation.")
        )
    try:
        expiry = datetime.fromisoformat(plan["expires_at"])
    except ValueError:
        expiry = None
    if expiry is not None and expiry <= moment:
        reasons.append(_reason("run_plan_expired", "This run plan has expired."))
    if receipt is not None:
        try:
            receipt_expiry = datetime.fromisoformat(receipt["expires_at"])
        except ValueError:
            receipt_expiry = None
        if receipt_expiry is not None and receipt_expiry <= moment:
            reasons.append(
                _reason("authorization_expired", "The authorization receipt has expired.")
            )

    planned_publisher = plan["publisher"]
    for field, code in (
        ("signature_status", "signature_status_changed"),
        ("trust_status", "publisher_trust_changed"),
        ("signer_fingerprint", "signer_changed"),
    ):
        if publisher[field] != planned_publisher[field]:
            reasons.append(
                _reason(
                    code,
                    f"Publisher {field.replace('_', ' ')} changed from "
                    f"{planned_publisher[field]!r} to {publisher[field]!r} after preparation.",
                )
            )
    if policy.require_valid_signature and publisher["signature_status"] != "valid":
        reasons.append(_reason("signature_not_valid", "The signature is no longer valid."))
    if policy.require_trusted_publisher and publisher["trust_status"] != "trusted":
        reasons.append(_reason("publisher_not_trusted", "The publisher is no longer trusted."))

    stale = bool(reasons)
    return {
        "schema": "agentpkg-run-plan-preflight-v0",
        "checked_at": moment.isoformat(),
        "run_plan_id": plan["run_plan_id"],
        "run_plan_sha256": plan["run_plan_sha256"],
        # A plan prepared with blocking reasons was never ready to begin with.
        "state": "stale" if stale else plan["readiness"]["state"],
        "ready": not stale and plan["readiness"]["ready"],
        "stale": stale,
        "stale_reasons": reasons,
        "blocking_reasons": list(plan["readiness"]["blocking_reasons"]),
        "trust_store_changed": trust_state.get("state_sha256")
        != plan["trust_store"].get("state_sha256"),
        "execution": {
            "performed": False,
            "note": "Execution is not implemented in this build.",
        },
    }


__all__ = [
    "BINDING_SINGLE_MODEL",
    "BINDING_STRATEGIES",
    "EXECUTION_MODES",
    "MODE_MODEL",
    "MODE_REQUIRED_PERMISSION_KINDS",
    "RUN_PLAN_SCHEMA",
    "RUN_PLAN_VERSION",
    "build_run_plan",
    "mode_permission_ids",
    "preflight",
    "preparation_blockers",
    "validate_binding",
    "validate_mode",
]
