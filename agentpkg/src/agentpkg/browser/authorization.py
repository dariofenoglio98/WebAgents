"""Authorization drafting and receipts.

The package REQUESTS authority; the browser GRANTS it. Nothing inside an
artifact can raise its own decision above `deny`, and a receipt is bound to the
exact bytes it was issued for, so it can never be replayed against a different
package that happens to share an ID and version.
"""

from __future__ import annotations

import copy
from dataclasses import dataclass
from datetime import UTC, datetime
from uuid import uuid4

from ..package import Package, canonical_json, sha256
from .errors import ControlPlaneError
from .hostresources import registry_reference

REQUEST_SCHEMA = "agentpkg-authorization-request-v0"
RECEIPT_SCHEMA = "agentpkg-authorization-receipt-v0"
DENY = "deny"
# `always` is deliberately absent: the runtime accepts the word but keeps such a
# grant only for the lifetime of one Runtime object, so offering it in a browser
# would tell the user something false. See docs/browser-control-plane.md.
SUPPORTED_DECISIONS = (DENY, "once", "session")
UNSUPPORTED_DECISIONS = {
    "always": (
        "Not offered: this host has no persistent authorization store. The runtime accepts "
        "'always', but that grant lasts only for a single Runtime instance, so presenting it "
        "as durable consent would misinform the user. Use 'session'."
    )
}


@dataclass(frozen=True)
class BrowserPolicy:
    """What this host requires before it will call a package runnable."""

    require_valid_signature: bool = True
    require_trusted_publisher: bool = True
    require_supported_profile: bool = True
    # A model whose hard requirements are neither confirmed nor refuted by the
    # host is `unverified`. By default that is not good enough for a ready run
    # plan: saying "ready" about a capability nobody confirmed would be the
    # same dishonesty as calling an unpinned signature a trusted publisher.
    require_confirmed_model_compatibility: bool = True
    # The same rule for a tool implementation. A host binding that declares no
    # schema digests may still be correct, but nothing has established that it
    # speaks the contract the package's data will be built against.
    require_confirmed_tool_contract: bool = True

    def as_json(self) -> dict:
        return {
            "require_valid_signature": self.require_valid_signature,
            "require_trusted_publisher": self.require_trusted_publisher,
            "require_supported_profile": self.require_supported_profile,
            "require_confirmed_model_compatibility": self.require_confirmed_model_compatibility,
            "require_confirmed_tool_contract": self.require_confirmed_tool_contract,
        }


def initial_decisions(package: Package) -> dict:
    """Every declared permission starts denied, required or not."""
    return {permission["id"]: DENY for permission in package.policy["permissions"]}


def approval_candidates(package: Package) -> list:
    """Tools the runtime refuses to dispatch without a separate host approval.

    **Every declared tool**, not only the side-effecting ones. A permission
    grant and a tool approval answer different questions: `network.x = session`
    says a class of destination is allowed, and an approval says *this exact
    host implementation of this exact declared tool* may be used. Deriving the
    second from the first would mean that granting one network permission
    silently authorized every network-capable tool the package declares.

    `approval_required` and a non-read `side_effects` remain visible on each
    row, because they change how consequential a yes is, not whether one is
    needed.
    """
    return sorted(tool["id"] for tool in package.tools.values())


def initial_tool_approvals(package: Package) -> dict:
    return {tool_id: False for tool_id in approval_candidates(package)}


def _linked(package: Package, permission_id: str) -> tuple[list, list]:
    tools = sorted(
        tool["id"] for tool in package.tools.values() if permission_id in tool["permissions"]
    )
    domains = sorted(
        {
            domain
            for tool in package.tools.values()
            if permission_id in tool["permissions"]
            for domain in tool["domains"]
        }
    )
    return tools, domains


def build_request(
    package: Package, *, session_id: str, decisions: dict, tool_approvals: dict
) -> dict:
    """The machine-readable authorization request a UI renders and answers."""
    permissions = []
    for permission in package.policy["permissions"]:
        tools, domains = _linked(package, permission["id"])
        permissions.append(
            {
                "id": permission["id"],
                "kind": permission["kind"],
                "description": permission["description"],
                "required": permission["required"],
                "resources": list(permission["resources"]),
                "decision": decisions.get(permission["id"], DENY),
                "linked_tools": tools,
                "linked_domains": domains,
            }
        )
    policy = package.policy
    return {
        "schema": REQUEST_SCHEMA,
        "session_id": session_id,
        "package_id": package.manifest["package_id"],
        "package_version": package.manifest["version"],
        "package_digest": package.digest,
        "decision_model": {
            "supported": list(SUPPORTED_DECISIONS),
            "default": DENY,
            "unsupported": dict(UNSUPPORTED_DECISIONS),
            "note": "Authority is granted per permission ID and expires with this session.",
        },
        "permissions": permissions,
        "required_permission_ids": sorted(item["id"] for item in permissions if item["required"]),
        "optional_permission_ids": sorted(
            item["id"] for item in permissions if not item["required"]
        ),
        "tool_approvals": [
            {
                "tool_id": tool_id,
                "approval_required": package.tools[tool_id]["approval_required"],
                "side_effects": package.tools[tool_id]["side_effects"],
                "execution": package.tools[tool_id]["execution"],
                "binding": package.tools[tool_id]["binding"],
                "domains": list(package.tools[tool_id]["domains"]),
                "permissions": list(package.tools[tool_id]["permissions"]),
                "decision": bool(tool_approvals.get(tool_id, False)),
            }
            for tool_id in approval_candidates(package)
        ],
        "tool_approval_note": (
            "Every declared tool needs its own approval. A granted permission describes a "
            "class of authority; an approval names one host implementation of one tool."
        ),
        "network": copy.deepcopy(policy["network"]),
        "memory": copy.deepcopy(policy["memory"]),
        "budget": copy.deepcopy(policy["budget"]),
        "delegation": copy.deepcopy(policy["delegation"]),
    }


def normalize_decisions(package: Package, submitted) -> dict:
    """Apply submitted decisions onto the deny-by-default baseline, strictly."""
    decisions = initial_decisions(package)
    if submitted is None:
        return decisions
    if not isinstance(submitted, dict):
        raise ControlPlaneError(
            "invalid_request", "decisions must be an object of permission ID to decision"
        )
    declared = set(decisions)
    for permission_id, decision in submitted.items():
        if permission_id not in declared:
            raise ControlPlaneError(
                "unknown_permission",
                f"{permission_id!r} is not declared by this package",
            )
        if decision in UNSUPPORTED_DECISIONS:
            raise ControlPlaneError(
                "unsupported_decision", UNSUPPORTED_DECISIONS[decision], status=400
            )
        if decision not in SUPPORTED_DECISIONS:
            raise ControlPlaneError(
                "invalid_decision",
                f"Decision must be one of {list(SUPPORTED_DECISIONS)}; got {decision!r}",
            )
        decisions[permission_id] = decision
    return decisions


def normalize_tool_approvals(package: Package, submitted) -> dict:
    approvals = initial_tool_approvals(package)
    if submitted is None:
        return approvals
    if not isinstance(submitted, dict):
        raise ControlPlaneError("invalid_request", "tool_approvals must be an object")
    for tool_id, approved in submitted.items():
        if tool_id not in approvals:
            raise ControlPlaneError(
                "unknown_tool_approval",
                f"{tool_id!r} does not require a separate host approval in this package",
            )
        if not isinstance(approved, bool):
            raise ControlPlaneError("invalid_request", "tool approvals must be booleans")
        approvals[tool_id] = approved
    return approvals


def blocking_reasons(
    package: Package, *, evaluation: dict, publisher: dict, decisions: dict, policy: BrowserPolicy
) -> list:
    """Every reason this package is not runnable, in stable code form."""
    reasons = []

    def block(code, message, subject=None):
        reasons.append({"code": code, "message": message, "subject": subject})

    for layer in ("container", "integrity", "schema"):
        if evaluation[f"{layer}_status"] != "valid":
            block(f"{layer}_invalid", f"Package {layer} validation did not pass.")
    if policy.require_supported_profile and evaluation["runtime_status"] != "compatible":
        block(
            "execution_profile_unsupported",
            "No installed execution profile can run this package.",
        )
    if policy.require_valid_signature and publisher["signature_status"] != "valid":
        block(
            "signature_not_valid",
            f"Browser policy requires a valid publisher signature "
            f"(status: {publisher['signature_status']}).",
        )
    if policy.require_trusted_publisher and publisher["trust_status"] != "trusted":
        block(
            "publisher_not_trusted",
            f"Browser policy requires an operator-pinned publisher key "
            f"(status: {publisher['trust_status']}).",
        )
    for permission in package.policy["permissions"]:
        if permission["required"] and decisions.get(permission["id"], DENY) == DENY:
            block(
                "required_permission_denied",
                f"Required permission {permission['id']!r} is denied.",
                permission["id"],
            )
    return reasons


def build_receipt(
    package: Package,
    *,
    session_id: str,
    source: dict,
    archive_sha256: str,
    evaluation: dict,
    publisher: dict,
    trust_state: dict,
    decisions: dict,
    tool_approvals: dict,
    policy: BrowserPolicy,
    instance_id: str,
    expires_at: str,
    resource_grants: list | None = None,
    resource_registry: dict | None = None,
) -> dict:
    """Bind decisions to these exact bytes, this signer, and this trust state.

    `resource_grants` are the host resources the person picked for the
    permissions that request one, already validated against
    `resource_registry`: opaque id, type and digest, never a value or a label.
    They are part of the receipt hash, so a plan that names this receipt names
    exactly these resources.
    """
    reasons = blocking_reasons(
        package,
        evaluation=evaluation,
        publisher=publisher,
        decisions=decisions,
        policy=policy,
    )
    receipt = {
        "schema": RECEIPT_SCHEMA,
        "receipt_id": str(uuid4()),
        "issued_at": datetime.now(UTC).isoformat(),
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
        "validation": dict(evaluation),
        "browser_policy": policy.as_json(),
        "decisions": dict(sorted(decisions.items())),
        "tool_approvals": dict(sorted(tool_approvals.items())),
        "granted_permission_ids": sorted(
            pid for pid, decision in decisions.items() if decision != DENY
        ),
        "resource_grants": [dict(grant) for grant in resource_grants or []],
        "resource_registry": registry_reference(resource_registry),
        "runnable": not reasons,
        "blocking_reasons": reasons,
        "execution": {
            "performed": False,
            "note": (
                "This control plane never executes packages. A later run milestone consumes "
                "this receipt and must re-verify the digest and archive hash first."
            ),
        },
    }
    receipt["receipt_sha256"] = sha256(canonical_json(receipt))
    return receipt
