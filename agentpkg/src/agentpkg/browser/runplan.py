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
from .hostresources import (
    grant_staleness,
    grants_report,
    resource_tool_blockers,
)
from .hostresources import (
    registry_reference as resource_registry_reference,
)
from .hosttools import (
    AMBIGUOUS as TOOL_AMBIGUOUS,
)
from .hosttools import (
    BOUND as TOOL_BOUND,
)
from .hosttools import (
    INCOMPATIBLE as TOOL_INCOMPATIBLE,
)
from .hosttools import (
    UNAVAILABLE as TOOL_UNAVAILABLE,
)
from .hosttools import (
    UNBOUND as TOOL_UNBOUND,
)
from .hosttools import (
    UNVERIFIED as TOOL_UNVERIFIED,
)
from .hosttools import (
    plan_tool_bindings,
    registry_reference,
)
from .profiles import profile_denied_tools

RUN_PLAN_SCHEMA = "agentpkg-run-plan-v0"
RUN_PLAN_VERSION = "0.1"

# The execution modes a run plan can request. Fixture and extractive runs remain
# development modes of the CLI; they are not offered by the browser and do not
# get a plan.
#
# `model` is authority to run the package's own graph: it needs a model, and it
# needs *every* declared tool bound, approved and permitted, because a run that
# discovered an unbound tool halfway through would already have spent whatever
# came before it. The one exception is a tool the person's selected profile
# left out and that they did not approve (D-022, D-090): it is denied, never
# bound, and the runtime refuses any call to it.
#
# `tool_probe` is authority to make **one mediated call to one declared tool**
# and nothing else. It is a strictly smaller thing, and it is a separate mode
# rather than a relaxation of the first so that no artifact can be mistaken for
# the other: a `tool_probe` plan binds no model, names the one tool it is for,
# and is refused by the runner as a workflow. A package whose other tools this
# host cannot implement is still not runnable here, and says so.
MODE_MODEL = "model"
MODE_TOOL_PROBE = "tool_probe"
EXECUTION_MODES = (MODE_MODEL, MODE_TOOL_PROBE)

BINDING_SINGLE_MODEL = "single_model"
BINDING_STRATEGIES = (BINDING_SINGLE_MODEL,)

# Permission kinds a run mode needs on top of whatever the package marked
# required. Expressed as kinds, not identifiers, so no package name is ever
# special-cased: the runtime itself authorizes every declared permission of
# kind `model` before it will dispatch a model call.
MODE_REQUIRED_PERMISSION_KINDS = {MODE_MODEL: ("model",), MODE_TOOL_PROBE: ()}


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


# Every tool verdict that is not `bound` blocks a plan, with its own code so a
# UI can send the person to the control that fixes it. `unverified` blocks only
# under the same browser policy that governs an unverified model, for the same
# reason: calling an unconfirmed contract "ready" would be the dishonesty the
# tri-state exists to prevent.
_TOOL_BLOCKERS = {
    TOOL_UNBOUND: (
        "tool_not_bound",
        "This host registers no implementation for tool {tool}. The package declares what it "
        "needs; a host that cannot supply it cannot run the package.",
    ),
    TOOL_INCOMPATIBLE: (
        "tool_contract_mismatch",
        "The host implementation of tool {tool} does not satisfy the contract the package "
        "declares.",
    ),
    TOOL_AMBIGUOUS: (
        "tool_binding_ambiguous",
        "This host registers more than one implementation for tool {tool}; exactly one must "
        "satisfy a declaration.",
    ),
    TOOL_UNAVAILABLE: (
        "tool_unavailable",
        "The host implementation of tool {tool} is registered but not currently usable.",
    ),
}


def tool_blockers(
    evaluation: dict | None,
    *,
    receipt: dict,
    policy: BrowserPolicy,
    only: str | None = None,
) -> list[dict]:
    """Every reason a declared tool is not ready to be bound into a plan.

    Three separate facts, kept separate: is there an implementation, did the
    person approve *that* implementation, and are the permissions it travels
    under granted. None of the three implies another.

    `only` narrows the question to one tool. A `tool_probe` plan is authority
    for exactly one call, so a package whose *other* tools this host cannot
    implement still cannot be run here — and that remains true and visible,
    because a model-mode plan asks the unrestricted question.
    """
    if evaluation is None:
        return [
            _reason(
                "tool_registry_missing",
                "This package declares tools, and no host tool registry was supplied, so no "
                "implementation can be bound.",
            )
        ]
    reasons: list[dict] = []
    denied = profile_denied_tools(receipt)
    for tool in evaluation["tools"]:
        subject = tool["tool_id"]
        if only is not None and subject != only:
            continue
        if subject in denied and only is None:
            # Outside the profile the person chose and not approved (D-022,
            # D-090): it gets no binding, blocks nothing, and the runtime
            # refuses any call to it. A probe of it is refused below as any
            # unapproved tool is.
            continue
        blocker = _TOOL_BLOCKERS.get(tool["status"])
        if blocker is not None:
            code, message = blocker
            reasons.append(
                _reason(
                    code,
                    message.format(tool=subject)
                    + (f" {tool['reason']}" if tool.get("reason") else ""),
                    subject,
                )
            )
            continue
        if tool["status"] == TOOL_UNVERIFIED and policy.require_confirmed_tool_contract:
            unknown = ", ".join((tool["binding"] or {}).get("unknown", [])) or "its contract"
            reasons.append(
                _reason(
                    "tool_contract_unverified",
                    f"This host does not state enough about its implementation of {subject} to "
                    f"confirm {unknown}.",
                    subject,
                )
            )
            continue
        if receipt["tool_approvals"].get(subject) is not True:
            reasons.append(
                _reason(
                    "tool_not_approved",
                    f"Tool {subject} is declared and bound, but this host implementation was "
                    "not explicitly approved. A granted permission is not an approval.",
                    subject,
                )
            )
        # A denied *required* permission means the package cannot run. A denied
        # optional one is an operating profile the package itself declared it
        # supports, and `Runtime` refuses the call if the graph reaches the
        # tool anyway; the plan records the tool as unusable rather than
        # refusing to exist.
        for permission_id in tool["required_permission_ids"]:
            if receipt["decisions"].get(permission_id, DENY) == DENY:
                reasons.append(
                    _reason(
                        "tool_permission_denied",
                        f"Tool {subject} needs required permission {permission_id!r}, which is "
                        "denied.",
                        subject,
                    )
                )
        if not tool["permission_ids"]:
            reasons.append(
                _reason(
                    "tool_permission_undeclared",
                    f"Tool {subject} links to no declared permission, so no authority can be "
                    "checked before it runs.",
                    subject,
                )
            )
    return reasons


def preparation_blockers(
    package: Package,
    *,
    mode: str,
    evaluation: dict,
    receipt: dict | None,
    publisher: dict,
    compatibility: dict | None,
    policy: BrowserPolicy,
    tool_evaluation: dict | None = None,
    probe_tool_id: str | None = None,
    resource_registry: dict | None = None,
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
    if not required_ids and MODE_REQUIRED_PERMISSION_KINDS.get(mode):
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
    # A package declaring tools cannot be partially ready. Every declared tool
    # needs an implementation, an approval and its permissions before any of
    # the graph may run, because a run that discovers an unbound tool halfway
    # through has already spent whatever came before it. A tool the selected
    # profile denied is not part of the run at all (D-090).
    if package.tools:
        reasons.extend(
            tool_blockers(tool_evaluation, receipt=receipt, policy=policy, only=probe_tool_id)
        )
    # The host resources the person picked must still be exactly those
    # resources, and a tool that returns one must have one to return.
    reasons.extend(grant_staleness(receipt.get("resource_grants") or [], resource_registry))
    reasons.extend(
        reason
        for reason in resource_tool_blockers(tool_evaluation, receipt=receipt)
        if probe_tool_id is None or reason["subject"] == probe_tool_id
    )
    if mode == MODE_TOOL_PROBE:
        # A probe binds no model, so model compatibility is not its business.
        # It is authority to make one tool call; that is the whole artifact.
        if probe_tool_id is None:
            reasons.append(
                _reason("tool_probe_tool_missing", "A tool probe must name the tool it is for.")
            )
        elif probe_tool_id not in package.tools:
            reasons.append(
                _reason(
                    "tool_not_declared",
                    f"This package declares no tool named {probe_tool_id!r}.",
                    probe_tool_id,
                )
            )
        return reasons
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
    tool_evaluation: dict | None = None,
    tool_registry: dict | None = None,
    probe_tool_id: str | None = None,
    resource_registry: dict | None = None,
) -> dict:
    """Freeze one decision into a hashed, self-describing artifact."""
    created = datetime.now(UTC)
    tool_bindings = plan_tool_bindings(tool_evaluation) if tool_evaluation else []
    # A tool the selected profile left out and the person did not approve is
    # denied (D-090): the plan binds no implementation of it and says so.
    denied = profile_denied_tools(receipt)
    tool_bindings = [item for item in tool_bindings if item["tool_id"] not in denied]
    if probe_tool_id is not None:
        # A probe binds the one tool it is for. Carrying the others would make
        # the artifact look like authority it is not.
        tool_bindings = [item for item in tool_bindings if item["tool_id"] == probe_tool_id]
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
            "required_tool_ids": (
                [probe_tool_id]
                if probe_tool_id is not None
                else sorted(set(package.tools) - denied)
            ),
            "probe_tool_id": probe_tool_id,
            "tool_binding_count": len(tool_bindings),
            "performed": False,
            "note": (
                "A run plan is a preflight artifact. This control plane never executes a "
                "package; a later runner must re-verify the digest, archive hash, signature, "
                "trust, receipt, model availability and every tool binding digest before "
                "dispatching anything."
                + (
                    " This plan is authority for ONE mediated call to one declared tool. It "
                    "binds no model and is not authority to run this package's graph."
                    if probe_tool_id is not None
                    else ""
                )
            ),
        },
        # What would actually run for each declared tool: one exact host
        # implementation, its digest, and the approval that authorized it.
        # No credential, no header and no registry travels in here.
        "tool_bindings": tool_bindings,
        "tool_registry": registry_reference(tool_registry) if tool_registry else None,
        # Which host-owned resource each resource-bearing permission was granted
        # for, exactly as the receipt froze it: opaque id, type and digest. No
        # value and no label; a later runner compares, it never looks inside.
        "resource_grants": [dict(grant) for grant in receipt.get("resource_grants") or []],
        "resource_registry": resource_registry_reference(resource_registry),
        # A tool probe binds no model at all, so no router can be constructed
        # from it: "no model was called" is then a property of the artifact
        # rather than a claim about a run.
        "model_binding": (
            None
            if descriptor is None
            else {
                "strategy": binding_strategy,
                "selected_at": created.isoformat(),
                "host_model_id": descriptor["id"],
                "provider_id": descriptor["provider_id"],
                "model_id": descriptor["model_id"],
                "display_name": descriptor["display_name"],
                # The exact descriptor the verdict was computed from, so a later
                # runner can compare the host's answer then against its now.
                "descriptor": descriptor,
                "compatibility": compatibility,
                "catalog": catalog_reference(catalog),
            }
        ),
        "model_requirements": evaluation["requirements"],
        "browser_policy": policy.as_json(),
        "readiness": {
            "state": "ready" if not blocking_reasons else "blocked",
            "ready": not blocking_reasons,
            "compatibility_status": (compatibility or {}).get("status"),
            "blocking_reasons": blocking_reasons,
        },
    }
    if receipt.get("profile") is not None:
        # Only a plan made through a profile carries these, so every other
        # plan keeps exactly its earlier shape and hash.
        plan["execution"]["denied_tool_ids"] = sorted(denied)
        plan["execution"]["note"] += (
            " Declared tools the selected profile left out and the person did not approve are "
            "listed in denied_tool_ids; the runtime refuses any call to them (D-022)."
        )
    plan["run_plan_sha256"] = sha256(canonical_json(plan))
    return plan


def tool_staleness(plan: dict, evaluation: dict | None) -> list[dict]:
    """Whether every tool this plan bound is still exactly that implementation.

    Conservative on purpose. A binding whose digest moved is a different
    implementation, even when the host calls it by the same name, so the plan
    that named the old one is stale rather than quietly retargeted.
    """
    bound = plan.get("tool_bindings") or []
    if not bound:
        return []
    if evaluation is None:
        return [
            _reason(
                "tool_registry_unknown",
                "This plan bound host tool implementations, and no current host tool registry "
                "has been supplied to compare them against.",
            )
        ]
    current = {tool["tool_id"]: tool for tool in evaluation["tools"]}
    reasons: list[dict] = []
    for binding in bound:
        tool_id = binding["tool_id"]
        tool = current.get(tool_id)
        if tool is None or tool["binding"] is None:
            reasons.append(
                _reason(
                    "tool_binding_removed",
                    f"This host no longer registers an implementation for {tool_id}.",
                    tool_id,
                )
            )
            continue
        live = tool["binding"]
        if live["binding_id"] != binding["binding_id"]:
            reasons.append(
                _reason(
                    "tool_binding_replaced",
                    f"A different implementation now satisfies {tool_id}.",
                    tool_id,
                )
            )
        elif live["binding_sha256"] != binding["binding_sha256"]:
            reasons.append(
                _reason(
                    "tool_binding_changed",
                    f"The host implementation of {tool_id} changed after this plan was "
                    "prepared, so it is no longer the one that was approved.",
                    tool_id,
                )
            )
        if tool["contract_sha256"] != binding["contract_sha256"]:
            reasons.append(
                _reason(
                    "tool_contract_changed",
                    f"The contract {tool_id} was matched against is no longer the current one.",
                    tool_id,
                )
            )
        if tool["status"] == TOOL_UNAVAILABLE:
            reasons.append(
                _reason(
                    "tool_unavailable",
                    f"The host implementation of {tool_id} is no longer usable.",
                    tool_id,
                )
            )
        elif tool["status"] != TOOL_BOUND:
            reasons.append(
                _reason(
                    "tool_binding_stale",
                    f"The host implementation of {tool_id} is now {tool['status']}.",
                    tool_id,
                )
            )
    return reasons


def preflight(
    plan: dict,
    *,
    package: Package,
    publisher: dict,
    receipt: dict | None,
    trust_state: dict,
    policy: BrowserPolicy,
    tool_evaluation: dict | None = None,
    now: datetime | None = None,
    resource_registry: dict | None = None,
    once_spent: bool = False,
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
    tool_reasons = tool_staleness(plan, tool_evaluation)
    reasons.extend(tool_reasons)
    if receipt is not None:
        for binding in plan.get("tool_bindings") or []:
            if receipt["tool_approvals"].get(binding["tool_id"]) is not True:
                reasons.append(
                    _reason(
                        "tool_approval_withdrawn",
                        f"Tool {binding['tool_id']} is no longer approved.",
                        binding["tool_id"],
                    )
                )
    planned_grants = plan.get("resource_grants") or []
    resource_reasons = grant_staleness(planned_grants, resource_registry)
    reasons.extend(resource_reasons)
    if once_spent:
        # `once` means one run. The first execution lease issued under a
        # receipt that grants anything once spends it; running again needs the
        # person to decide again.
        reasons.append(
            _reason(
                "authorization_once_spent",
                "This authorization granted something once, and a run has already used it. "
                "Authorize again to run again.",
            )
        )

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
        "tool_bindings": {
            "bound": len(plan.get("tool_bindings") or []),
            "current": not tool_reasons,
            "evaluated": tool_evaluation is not None,
            "registry_sha256": (
                (tool_evaluation or {}).get("registry", {}).get("registry_sha256")
                if tool_evaluation
                else None
            ),
            "registry_changed": bool(
                tool_evaluation
                and plan.get("tool_registry")
                and tool_evaluation["registry"]["registry_sha256"]
                != plan["tool_registry"]["registry_sha256"]
            ),
        },
        "resource_grants": grants_report(planned_grants, resource_registry),
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
    "tool_blockers",
    "tool_staleness",
    "validate_binding",
    "validate_mode",
]
