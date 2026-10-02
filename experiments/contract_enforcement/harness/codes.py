"""The vocabulary of contract refusals: which component and lifecycle stage made each one.

Every entry is a refusal the production code issues on purpose, with a stable
code (or, for the plugin's `revalidate`, a fixed message), found by reading the
code — not by running the experiment. A failure that is not in this vocabulary
(a crash, an unclassified `worker_error`, a broken bridge) is *incidental*: it
stopped the run, but no contract layer said why.

Components (what kind of check):
    verification  trust  authorization  compatibility  revalidation
    mediation     validation  resource

Stages (where in the lifecycle the run was stopped):
    acquire/open  verify  trust  authorize  compatibility  prepare  revalidate
    execute/model  execute/tool  validate  resource  finalize

`tests/test_oracles.py` checks that every literal listed here occurs in the
production source it is attributed to.
"""

from __future__ import annotations

COMPONENTS = (
    "verification",
    "trust",
    "authorization",
    "compatibility",
    "revalidation",
    "mediation",
    "validation",
    "resource",
)
STAGES = (
    "acquire/open",
    "verify",
    "trust",
    "authorize",
    "compatibility",
    "prepare",
    "revalidate",
    "execute/model",
    "execute/tool",
    "validate",
    "resource",
    "finalize",
)

# Control-plane route errors (agentpkg.browser.*: ControlPlaneError.code).
CONTROL = {
    "package_rejected": ("verification", "verify"),
    "source_rejected": ("verification", "acquire/open"),
    "package_too_large": ("resource", "acquire/open"),
    "request_too_large": ("resource", "revalidate"),
    "digest_mismatch": ("revalidation", "prepare"),
    "receipt_mismatch": ("revalidation", "prepare"),
    "authorization_absent": ("authorization", "prepare"),
    "model_unknown": ("compatibility", "compatibility"),
    "tool_registry_missing": ("compatibility", "compatibility"),
    "run_plan_absent": ("revalidation", "revalidate"),
    "run_plan_mismatch": ("revalidation", "revalidate"),
    "snapshot_unstable": ("revalidation", "revalidate"),
    "execution_lease_unstable": ("revalidation", "revalidate"),
    "execution_lease_active": ("resource", "revalidate"),
    "session_unknown": ("revalidation", "revalidate"),
    "signature_not_valid": ("verification", "trust"),
    "fingerprint_mismatch": ("trust", "trust"),
    "unknown_permission": ("authorization", "authorize"),
    "invalid_decision": ("authorization", "authorize"),
    "unsupported_decision": ("authorization", "authorize"),
    "unknown_tool_approval": ("authorization", "authorize"),
}
# `package_rejected` is refined by the failed layer.
LAYER = {
    "container": ("verification", "verify"),
    "integrity": ("verification", "verify"),
    "schema": ("verification", "verify"),
}

# Receipt blocking reasons and run-plan preparation blockers
# (agentpkg.browser.authorization.blocking_reasons, runplan.preparation_blockers).
BLOCKERS = {
    "container_invalid": ("verification", "verify"),
    "integrity_invalid": ("verification", "verify"),
    "schema_invalid": ("verification", "verify"),
    "signature_not_valid": ("verification", "verify"),
    "publisher_not_trusted": ("trust", "trust"),
    "required_permission_denied": ("authorization", "authorize"),
    "authorization_missing": ("authorization", "authorize"),
    "authorization_package_mismatch": ("revalidation", "prepare"),
    "execution_mode_permission_denied": ("authorization", "authorize"),
    "execution_mode_permission_undeclared": ("authorization", "authorize"),
    "tool_not_approved": ("authorization", "authorize"),
    "tool_permission_denied": ("authorization", "authorize"),
    "tool_permission_undeclared": ("authorization", "authorize"),
    "execution_profile_unsupported": ("compatibility", "compatibility"),
    "tool_registry_missing": ("compatibility", "compatibility"),
    "tool_not_bound": ("compatibility", "compatibility"),
    "tool_contract_mismatch": ("compatibility", "compatibility"),
    "tool_binding_ambiguous": ("compatibility", "compatibility"),
    "tool_unavailable": ("compatibility", "compatibility"),
    "tool_contract_unverified": ("compatibility", "compatibility"),
    "model_not_selected": ("compatibility", "compatibility"),
    "model_unavailable": ("compatibility", "compatibility"),
    "model_not_selectable": ("compatibility", "compatibility"),
    "model_incompatible": ("compatibility", "compatibility"),
    "model_compatibility_unverified": ("compatibility", "compatibility"),
    "evaluation_package_mismatch": ("revalidation", "prepare"),
}
# `authorization_not_runnable` relays the receipt's own reasons; the relayed
# reason (by message) decides the class. Order of precedence when a plan has
# several blockers: the earliest contract layer wins.
PRECEDENCE = (
    "verification",
    "trust",
    "authorization",
    "compatibility",
    "revalidation",
    "mediation",
    "validation",
    "resource",
)

# Preflight stale reasons (agentpkg.browser.runplan.preflight, tool_staleness).
STALE = {
    code: ("revalidation", "revalidate")
    for code in (
        "package_changed",
        "authorization_cleared",
        "authorization_superseded",
        "authorization_changed",
        "run_plan_expired",
        "authorization_expired",
        "signature_status_changed",
        "publisher_trust_changed",
        "signer_changed",
        "signature_not_valid",
        "publisher_not_trusted",
        "tool_registry_unknown",
        "tool_binding_removed",
        "tool_binding_replaced",
        "tool_binding_changed",
        "tool_contract_changed",
        "tool_unavailable",
        "tool_binding_stale",
        "tool_approval_withdrawn",
    )
}

# The plugin's `revalidate` refuses with fixed messages (preflight.ts); its
# browser codes are run_plan_stale / probe_refused / selected_model_unavailable
# / authorization_expiring. Message prefix -> (check, component).
REVALIDATE = (
    (
        "This session's run plan is not the one the caller asked for.",
        "run_plan_identity",
        "revalidation",
    ),
    ("The run plan changed after the caller read it.", "run_plan_identity", "revalidation"),
    ("The run plan was never ready to run.", "run_plan_readiness", "revalidation"),
    (
        "Only a model-backed run plan or a tool probe can be acted on.",
        "execution_mode",
        "revalidation",
    ),
    ("This plan is authority for", "execution_mode", "revalidation"),
    ("This run plan is not in a preflight state.", "execution_mode", "revalidation"),
    ("The package bytes are not the planned bytes.", "package_digest", "revalidation"),
    ("The package archive hash is not the planned hash.", "archive_sha256", "revalidation"),
    ("This host executes the workflow.v0 profile only.", "execution_profile", "compatibility"),
    ("Package container is not valid.", "package_validation", "verification"),
    ("Package integrity is not valid.", "package_validation", "verification"),
    ("Package schema is not valid.", "package_validation", "verification"),
    ("No installed execution profile can run this package.", "execution_profile", "compatibility"),
    ("The publisher signature status changed", "publisher", "revalidation"),
    ("The publisher trust status changed", "publisher", "revalidation"),
    ("The publisher signer fingerprint changed", "publisher", "revalidation"),
    (
        "A newer authorization replaced the one this plan was prepared under.",
        "authorization_receipt",
        "revalidation",
    ),
    (
        "The authorization receipt changed after this plan was prepared.",
        "authorization_receipt",
        "revalidation",
    ),
    ("The authorization receipt expired.", "receipt_not_expired", "revalidation"),
    ("The authorization receipt is not runnable.", "receipt_runnable", "authorization"),
    ("This run mode declares no model permission.", "model_permission_granted", "authorization"),
    ("This plan needs permission", "model_permission_granted", "authorization"),
    (
        "This plan binds host tool implementations and no current registry",
        "tool_bindings",
        "revalidation",
    ),
    ("This host no longer registers an implementation for", "tool_bindings", "revalidation"),
    ("A different implementation now satisfies", "tool_bindings", "revalidation"),
    ("The host implementation of", "tool_bindings", "revalidation"),
    ("The contract", "tool_bindings", "revalidation"),
    ("is no longer approved.", "tool_approvals", "authorization"),
    ("The run plan binds no host model.", "model_available", "revalidation"),
    ("This OpenClaw host no longer offers", "model_available", "revalidation"),
    ("The host's identity for the selected model changed", "model_identity", "revalidation"),
    ("The selected model is incompatible.", "model_compatibility", "compatibility"),
    ("A run may take up to", "receipt_outlasts_run_deadline", "revalidation"),
    # The control plane's own preflight, relayed by revalidate (its first stale reason).
    ("The session's package bytes are not the planned bytes.", "cp_preflight", "revalidation"),
    ("The authorization receipt is gone.", "cp_preflight", "revalidation"),
    ("A newer authorization replaced", "cp_preflight", "revalidation"),
    ("The authorization receipt changed after preparation.", "cp_preflight", "revalidation"),
    ("This run plan has expired.", "cp_preflight", "revalidation"),
    ("The authorization receipt has expired.", "cp_preflight", "revalidation"),
    ("Publisher ", "cp_preflight", "revalidation"),
    ("The signature is no longer valid.", "cp_preflight", "revalidation"),
    ("The publisher is no longer trusted.", "cp_preflight", "revalidation"),
    ("This plan bound host tool implementations", "cp_preflight", "revalidation"),
    ("This host no longer registers", "cp_preflight", "revalidation"),
    ("A different implementation now", "cp_preflight", "revalidation"),
    ("Tool ", "cp_preflight", "revalidation"),
)

# The plugin's own start checks (execution.ts ExecutionService.start).
START = (
    ("The workflow input is too large", "input_size", "resource"),
    ("The workflow input is not JSON", "input_size", "validation"),
    ("The task names a file this run was not given", "referenced_files", "mediation"),
    ("Unknown selected file", "attach_files", "mediation"),
    ("This OpenClaw version has not been verified for execution", "host_runtime", "compatibility"),
    ("Selected files need a permission that is denied", "file_permission", "authorization"),
    ("This package reads no selected files", "file_reader", "mediation"),
    ("The task does not match this package's input", "input_schema", "validation"),
)
START_CODES = {
    "input_invalid": ("validation", "revalidate"),
    "execution_active": ("resource", "revalidate"),
    "authorization_expiring": ("revalidation", "revalidate"),
    "selected_model_unavailable": ("revalidation", "revalidate"),
    "run_plan_stale": ("revalidation", "revalidate"),
    "probe_refused": ("revalidation", "revalidate"),
}

# The execution runner's refusals (agentpkg.execution.errors, toolbridge.errors).
RUNNER = {
    "execution_artifact_mismatch": ("revalidation", "revalidate"),
    "execution_artifact_invalid": ("verification", "verify"),
    "execution_signature_invalid": ("verification", "verify"),
    "execution_plan_invalid": ("revalidation", "revalidate"),
    "execution_input_invalid": ("validation", "revalidate"),
    "execution_permission_denied": ("authorization", "authorize"),
    "execution_grant_unsupported": ("authorization", "authorize"),
    "execution_model_incompatible": ("compatibility", "compatibility"),
    "execution_output_cap_too_large": ("resource", "resource"),
    "execution_export_path_reserved": ("mediation", "revalidate"),
    "execution_runtime_refused": ("verification", "verify"),
    "tools_not_supported": ("compatibility", "compatibility"),
    "tool_not_declared": ("mediation", "revalidate"),
    "tool_not_bound": ("compatibility", "compatibility"),
    "tool_not_approved": ("authorization", "authorize"),
    "tool_permission_denied": ("authorization", "authorize"),
    "tool_contract_mismatch": ("compatibility", "compatibility"),
    "tool_binding_stale": ("revalidation", "revalidate"),
    "tool_binding_ambiguous": ("compatibility", "compatibility"),
}

# Call-level refusal reasons recorded in the runtime audit (`reason` on
# model.failed / tool.failed / model.refused): agentpkg.hostbridge.router,
# toolbridge.handler, runtime, and the plugin's broker / host-llm codes.
CALL_REASONS = {
    # model call: output and termination contract
    "model_output_not_conforming": ("validation", "execute/model"),
    "model_output_too_large": ("validation", "execute/model"),
    "model_output_truncated": ("validation", "execute/model"),
    "model_turn_failed": ("validation", "execute/model"),
    "model_usage_invalid": ("resource", "resource"),
    "model_usage_unavailable": ("resource", "resource"),
    "model_request_invalid": ("mediation", "execute/model"),
    "selected_model_unavailable": ("mediation", "execute/model"),
    # `model_call_not_authorized` is OpenClaw's own refusal, which this
    # experiment's provider stand-in produces; it is deliberately absent, so
    # the experiment never credits WebAgents with a refusal its simulation made.
    "bridge_timeout": ("resource", "resource"),
    # model.refused reasons (Runtime.call_model reservation)
    "context_window": ("resource", "resource"),
    "global_token_budget": ("resource", "resource"),
    "worker_token_budget": ("resource", "resource"),
    # tool call
    "tool_request_invalid": ("mediation", "execute/tool"),
    "tool_response_invalid": ("validation", "execute/tool"),
    "tool_binding_stale": ("revalidation", "execute/tool"),
    "tool_contract_mismatch": ("mediation", "execute/tool"),
    "tool_not_bound": ("mediation", "execute/tool"),
    "tool_unavailable": ("mediation", "execute/tool"),
    "tool_timeout": ("resource", "resource"),
    "tool_transport_error": ("mediation", "execute/tool"),
}
# Workflow failure codes (agentpkg.workflow.failure_code) that are contract
# refusals in their own right; `worker_error`, `model_error` and `tool_error`
# are not, unless an audited call reason above explains them.
WORKFLOW = {
    "schema_validation": ("validation", "validate"),
    "budget_exhausted": ("resource", "resource"),
    "timeout": ("resource", "resource"),
    "permission_denied": ("authorization", "execute/tool"),
}
GENERIC = {"worker_error", "model_error", "tool_error", "cancelled"}


def revalidate_check(detail: str) -> tuple[str, str] | None:
    for prefix, check, component in REVALIDATE:
        if prefix in detail:
            return check, component
    return None


def start_check(detail: str) -> tuple[str, str] | None:
    for prefix, check, component in START:
        if prefix in detail:
            return check, component
    return None
