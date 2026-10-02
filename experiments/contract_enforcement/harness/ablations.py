"""Enforcement profiles: the full system, and one experiment-only ablation per component.

An ablation removes **one enforcement component everywhere it is enforced** —
in the Python control plane and runner and in the TypeScript plugin host — and
nothing else. It is expressed as exact source patches (`build.Patch`) applied
to private copies of the production sources (`build.py`), plus, for a few
components, the control plane's existing `BrowserPolicy` switches. Every patch
must match exactly once; the build fails otherwise.

Nothing here reaches production: the patched copies live under
`experiments/contract_enforcement/.cache/builds/`, a profile's worker process
imports its own copy, and no flag, option or environment variable of agentpkg
or the plugin enables any of this. `tests/test_ablations.py` checks each
property.

Most sites are a decision `if CONDITION:` whose body refuses; the patch makes
the condition false and leaves the body in place, so the diff of a profile
reads as "this check, here, no longer fires". A few sites are a validation
call, a timeout or a state reset, replaced by its no-op.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field

from .build import Patch

PY = "py"
TS = "ts"


def py_if(site: str, file: str, line: str, note: str = "") -> Patch:
    """`if COND:` (one exact source line) -> `if False:`."""
    match = re.fullmatch(r"(\s*)(el)?if (.+):", line)
    if not match:
        raise ValueError(f"{site}: not a one-line Python condition: {line!r}")
    indent, elif_, _ = match.groups()
    return Patch(
        site, file, line + "\n", f"{indent}{elif_ or ''}if False:  # ABLATED {site}\n", note
    )


def ts_if(site: str, file: str, line: str, note: str = "") -> Patch:
    """`if (COND) {` (or a one-line `if (COND) stmt;`) -> `if (ablatedNever() && (COND)) ...`.

    `ablatedNever()` (appended to the patched file by `build.apply_patches`)
    always returns false. Keeping COND in place keeps TypeScript's narrowing
    inside the block intact, so the patched source still type-checks.
    """
    match = re.fullmatch(r"(\s*)if \((.+)\)( \{| .+;)", line)
    if not match:
        raise ValueError(f"{site}: not a one-line TypeScript condition: {line!r}")
    indent, condition, rest = match.groups()
    return Patch(
        site,
        file,
        line + "\n",
        f"{indent}if (ablatedNever() /* ABLATED {site} */ && ({condition})){rest}\n",
        note,
    )


def sub(site: str, file: str, find: str, replace: str, note: str = "") -> Patch:
    return Patch(site, file, find, replace, note)


@dataclass(frozen=True)
class Profile:
    name: str
    label: str
    component: str | None
    description: str
    py: tuple[Patch, ...] = ()
    ts: tuple[Patch, ...] = ()
    browser_policy: dict = field(default_factory=dict)

    def as_json(self) -> dict:
        return {
            "name": self.name,
            "label": self.label,
            "component": self.component,
            "description": self.description,
            "browser_policy": dict(self.browser_policy),
            "python_patches": [p.as_json() for p in self.py],
            "typescript_patches": [p.as_json() for p in self.ts],
        }


# -- verification ----------------------------------------------------------------------
VERIFICATION = Profile(
    "minus_verification",
    "-Verification",
    "verification",
    "Content integrity and publisher-signature verification removed wherever they are "
    "performed: the integrity statement is no longer compared with the payload (control "
    "plane, runner and interpreter), the Ed25519 signature and its digest binding are no "
    "longer checked, and a missing signature is no longer refused (browser policy and "
    "runner). Container parsing rules (ZIP layout, member names, strict JSON) and schema "
    "validation stay: they are what makes a payload readable at all.",
    py=(
        py_if("V.integrity.archive", "package.py", "    if statement != expected:"),
        sub(
            "V.signature.digest",
            "signing.py",
            '    if signature["digest"] != package.digest:\n'
            '        raise SignatureError("signed digest differs from package integrity statement")\n'
            "    try:\n"
            "        public_key.verify(\n",
            "    return None  # ABLATED V.signature.digest and V.signature.ed25519\n"
            "    try:\n"
            "        public_key.verify(\n",
        ),
        py_if(
            "V.signature.embedded_key",
            "signing.py",
            '    if signature["key_fingerprint"] != fingerprint(key):',
        ),
        py_if(
            "V.integrity.interpreter",
            "workflow.py",
            "        if integrity_statement(package.files) != package.integrity:",
        ),
        sub(
            "V.signature.runner_presence",
            "execution/artifact.py",
            "    if package.signature is None:\n"
            "        raise ExecutionError(\n"
            '            SIGNATURE_INVALID, "The execution artifact carries no publisher signature"\n'
            "        )\n"
            "    try:\n"
            "        key = embedded_public_key(package.signature)\n"
            "        signer = fingerprint(key)\n"
            "        check_signature(package, key)\n",
            "    try:\n"
            "        if package.signature is None:  # ABLATED V.signature.runner_presence\n"
            '            signer = str(expected["signer_fingerprint"])\n'
            "        else:\n"
            "            key = embedded_public_key(package.signature)\n"
            "            signer = fingerprint(key)\n"
            "            check_signature(package, key)\n",
        ),
    ),
    browser_policy={"require_valid_signature": False},
)

# -- trust -------------------------------------------------------------------------------
TRUST = Profile(
    "minus_trust",
    "-Trust",
    "trust",
    "Publisher trust no longer required: the control plane's own policy switch "
    "`require_trusted_publisher=False`, which removes the trust gate from receipts, run-plan "
    "preparation and preflight. Trust is still evaluated and recorded; nothing refuses on it.",
    browser_policy={"require_trusted_publisher": False},
)

# -- authorization -------------------------------------------------------------------------
AUTHORIZATION = Profile(
    "minus_authorization",
    "-Authorization",
    "authorization",
    "Consent no longer enforced: denied required permissions, missing model-run permissions "
    "and missing tool approvals no longer block a receipt or a plan; the plugin no longer "
    "checks receipt runnability, granted permissions, approvals or the selected-file "
    "permission at start; the runner no longer refuses denied or once-only grants or "
    "unapproved tools; and the runtime no longer checks a grant or an approval before a call.",
    py=(
        py_if(
            "A.receipt.required_permission",
            "browser/authorization.py",
            '        if permission["required"] and decisions.get(permission["id"], DENY) == DENY:',
        ),
        py_if(
            "A.prepare.mode_permission_undeclared",
            "browser/runplan.py",
            "    if not required_ids and MODE_REQUIRED_PERMISSION_KINDS.get(mode):",
        ),
        sub(
            "A.prepare.mode_permission_denied",
            "browser/runplan.py",
            "    for permission_id in required_ids:\n"
            '        if receipt["decisions"].get(permission_id, DENY) == DENY:\n',
            "    for permission_id in required_ids:\n"
            "        if False:  # ABLATED A.prepare.mode_permission_denied\n",
        ),
        py_if(
            "A.prepare.tool_not_approved",
            "browser/runplan.py",
            '        if receipt["tool_approvals"].get(subject) is not True:',
        ),
        sub(
            "A.prepare.tool_permission_denied",
            "browser/runplan.py",
            '        for permission_id in tool["required_permission_ids"]:\n'
            '            if receipt["decisions"].get(permission_id, DENY) == DENY:\n',
            '        for permission_id in tool["required_permission_ids"]:\n'
            "            if False:  # ABLATED A.prepare.tool_permission_denied\n",
        ),
        py_if(
            "A.prepare.tool_permission_undeclared",
            "browser/runplan.py",
            '        if not tool["permission_ids"]:',
        ),
        py_if(
            "A.runner.required_denied",
            "execution/policy.py",
            '        if decision == DENY and permission["required"]:',
        ),
        py_if(
            "A.runner.once_overused",
            "execution/policy.py",
            '        if decision == ONCE and counts.get(permission["kind"], 0) > 1:',
        ),
        py_if(
            "A.runner.mode_permission",
            "execution/session.py",
            '            if grants.get(permission_id, "deny") == "deny":',
        ),
        py_if(
            "A.runner.tool_not_approved",
            "execution/policy.py",
            "        if approvals.get(tool_id) is not True:",
        ),
        py_if("A.runner.tool_no_permission", "execution/policy.py", "        if not linked:"),
        py_if(
            "A.runner.tool_permission_denied", "execution/policy.py", "        if required_denied:"
        ),
        py_if(
            "A.runtime.grant",
            "runtime.py",
            '            if grant == "deny" or (grant == "once" and pid in self._once_used):',
        ),
        py_if(
            "A.runtime.tool_approval",
            "runtime.py",
            "            if tool_id not in self.approved_tools:",
        ),
    ),
    ts=(
        ts_if(
            "A.revalidate.receipt_runnable",
            "preflight.ts",
            '  if (receipt.runnable !== true) refuse("The authorization receipt is not runnable.");',
        ),
        ts_if(
            "A.revalidate.mode_permission_undeclared",
            "preflight.ts",
            '  if (mode === "model" && requiredPermissions.length === 0) {',
        ),
        ts_if(
            "A.revalidate.permission_granted", "preflight.ts", "    if (!granted.has(permission)) {"
        ),
        ts_if(
            "A.revalidate.tool_approved",
            "preflight.ts",
            "      if (toolApprovalsOf(receipt)[toolId] !== true) {",
        ),
        sub(
            "A.start.file_permission",
            "execution.ts",
            "    this.checkFilePermission(preflight, attached);\n",
            "    // ABLATED A.start.file_permission\n",
        ),
    ),
)

# -- compatibility -----------------------------------------------------------------------------
COMPATIBILITY = Profile(
    "minus_compatibility",
    "-Compatibility",
    "compatibility",
    "Requirement and capability matching removed: model availability, selectability and "
    "requirement verdicts, tool-binding contract verdicts and the execution-profile check no "
    "longer block a plan (and unverified ones are accepted through the control plane's own "
    "policy switches); the backend no longer re-checks model availability at prepare; the "
    "plugin no longer checks the host runtime version, the profile or the plan's "
    "compatibility at start; the runner no longer re-derives model capability, context, "
    "tool-binding contracts and coverage; the runtime no longer checks router capabilities "
    "per call; and the runtime minimum version is no longer enforced.",
    py=(
        py_if(
            "C.prepare.model_available",
            "browser/runplan.py",
            '    if not compatibility["available"]:',
        ),
        py_if(
            "C.prepare.model_selectable",
            "browser/runplan.py",
            '    if not compatibility["selectable"]:',
        ),
        py_if(
            "C.prepare.model_incompatible",
            "browser/runplan.py",
            '    if compatibility["status"] == INCOMPATIBLE:',
        ),
        sub(
            "C.prepare.tool_verdict",
            "browser/runplan.py",
            '        blocker = _TOOL_BLOCKERS.get(tool["status"])\n',
            "        blocker = None  # ABLATED C.prepare.tool_verdict\n",
        ),
        sub(
            "C.runner.model_capabilities",
            "execution/policy.py",
            "    missing = sorted(set(required) - capabilities)\n    if missing:\n",
            "    missing = sorted(set(required) - capabilities)\n"
            "    if False:  # ABLATED C.runner.model_capabilities\n",
        ),
        py_if(
            "C.runner.model_context",
            "execution/policy.py",
            "    if router.context_window < context:",
        ),
        py_if(
            "C.runner.model_locality",
            "execution/policy.py",
            '    if requirements.get("privacy") == "local-only" and router.remote:',
        ),
        py_if(
            "C.runner.tools_supported",
            "execution/policy.py",
            "    if (declared_tools or tool_nodes) and not bound:",
        ),
        sub(
            "C.runner.tools_bound",
            "execution/policy.py",
            "    missing = sorted(set(declared_tools) - bound)\n    if missing:\n",
            "    missing = sorted(set(declared_tools) - bound)\n"
            "    if False:  # ABLATED C.runner.tools_bound\n",
        ),
        sub(
            "C.runner.tool_declared",
            "execution/policy.py",
            "        tool = declared.get(tool_id)\n        if tool is None:\n",
            "        tool = declared.get(tool_id)\n"
            "        if False:  # ABLATED C.runner.tool_declared\n",
        ),
        py_if(
            "C.runner.tool_contract", "execution/policy.py", "            if expected != actual:"
        ),
        py_if(
            "C.runner.tool_destination",
            "execution/policy.py",
            '            if not origin.startswith("https://") or host_name not in permitted:',
        ),
        sub(
            "C.runner.plan_tools_bound",
            "execution/session.py",
            "    missing = sorted(\n"
            '        {_text(item, "required_tool_ids[]", limit=200) for item in required_tools}\n'
            '        - {binding["tool_id"] for binding in bindings}\n'
            "    )\n"
            "    if missing:\n",
            "    missing = sorted(\n"
            '        {_text(item, "required_tool_ids[]", limit=200) for item in required_tools}\n'
            '        - {binding["tool_id"] for binding in bindings}\n'
            "    )\n"
            "    if False:  # ABLATED C.runner.plan_tools_bound\n",
        ),
        py_if(
            "C.runner.entrypoint",
            "execution/artifact.py",
            '    if manifest["entrypoint"] != "workflow.v0":',
        ),
        py_if(
            "C.runtime.capabilities",
            "runtime.py",
            '        if set(req["capabilities"]) - capabilities:',
        ),
        py_if(
            "C.runtime.context_window",
            "runtime.py",
            '        if router.context_window < req["context_window"]:',
        ),
        sub(
            "C.runtime.locality",
            "runtime.py",
            "        if (\n"
            '            self.package.manifest["model_requirements"].get("privacy") == "local-only"\n'
            "            and router.remote\n"
            "        ):\n",
            "        if False:  # ABLATED C.runtime.locality\n",
        ),
        py_if(
            "C.validation.runtime_version",
            "validation.py",
            '    if release(manifest["runtime"]["minimum_version"]) > release(__version__):',
        ),
    ),
    ts=(
        sub(
            "C.start.host_runtime",
            "execution.ts",
            "    this.runs.assertNoActiveRun(request.runPlanId, request.sessionId);\n"
            "    this.checkHostRuntime();\n",
            "    this.runs.assertNoActiveRun(request.runPlanId, request.sessionId);\n"
            "    // ABLATED C.start.host_runtime\n",
        ),
        ts_if(
            "C.revalidate.profile",
            "preflight.ts",
            '  if (str(planned.execution_profile) !== "workflow.v0") {',
        ),
        ts_if(
            "C.revalidate.runtime_status",
            "preflight.ts",
            '  if (str(validation.runtime_status) !== "compatible") {',
        ),
        ts_if(
            "C.revalidate.model_compatibility",
            "preflight.ts",
            '  if (str(compatibility.status) === "incompatible") refuse("The selected model is incompatible.");',
        ),
        ts_if(
            "C.prepare.backend_model_available",
            "backend.ts",
            '      if (executionMode === "model" && !stillAvailable(catalog, modelId)) {',
        ),
    ),
    browser_policy={
        "require_supported_profile": False,
        "require_confirmed_model_compatibility": False,
        "require_confirmed_tool_contract": False,
    },
)

# -- plan revalidation (TOCTOU) ---------------------------------------------------------------
REVALIDATION = Profile(
    "minus_plan_revalidation",
    "-Plan revalidation",
    "revalidation",
    "Nothing re-checks a frozen plan against the world: the control plane's preflight never "
    "reports a plan stale, a new authorization no longer supersedes a prepared plan, the lease "
    "no longer re-hashes the snapshot, plan, receipt and digest echoes are no longer compared, "
    "the plugin's revalidate no longer compares plan identity, readiness, package, publisher, "
    "receipt, expiry, tool bindings or model availability and identity, and the runner no "
    "longer compares the bytes it was handed with the plan's identity.",
    py=(
        sub(
            "R.preflight.staleness",
            "browser/runplan.py",
            "    stale = bool(reasons)\n",
            "    reasons = []  # ABLATED R.preflight.staleness\n    stale = False\n",
        ),
        sub(
            "R.authorize.supersede",
            "browser/control.py",
            "            # any lease issued under it goes with it.\n"
            "            session.run_plan = None\n",
            "            # any lease issued under it goes with it.\n"
            "            pass  # ABLATED R.authorize.supersede\n",
        ),
        py_if(
            "R.prepare.receipt_echo",
            "browser/control.py",
            '        if not isinstance(receipt_id, str) or receipt_id != session.receipt["receipt_id"]:',
        ),
        py_if(
            "R.lease.plan_echo",
            "browser/control.py",
            '        if run_plan_id != plan["run_plan_id"] or run_plan_sha256 != plan["run_plan_sha256"]:',
        ),
        py_if(
            "R.digest_echo",
            "browser/control.py",
            "        if package_digest != session.package.digest:",
        ),
        py_if(
            "R.lease.snapshot_hash", "browser/lease.py", "    if sha256(data) != archive_sha256:"
        ),
        py_if(
            "R.lease.readback_hash",
            "browser/lease.py",
            "        if sha256(stored) != archive_sha256:",
        ),
        py_if(
            "R.prepare.receipt_package",
            "browser/runplan.py",
            '    if receipt["package"]["digest"] != package.digest:',
        ),
        py_if(
            "R.prepare.evaluation_package",
            "browser/runplan.py",
            '    if evaluation["package_digest"] != package.digest:',
        ),
        py_if(
            "R.runner.archive_hash",
            "execution/artifact.py",
            '    if not compare_digest(archive_sha256, str(expected["archive_sha256"])):',
        ),
        py_if(
            "R.runner.digest",
            "execution/artifact.py",
            '    if not compare_digest(package.digest, str(expected["digest"])):',
        ),
        py_if(
            "R.runner.identity",
            "execution/artifact.py",
            "        if manifest[field] != expected[key]:",
        ),
        py_if(
            "R.runner.signer",
            "execution/artifact.py",
            '    if not compare_digest(signer, str(expected["signer_fingerprint"])):',
        ),
    ),
    ts=(
        ts_if(
            "R.revalidate.plan_id",
            "preflight.ts",
            "  if (str(plan.run_plan_id) !== options.runPlanId) {",
        ),
        ts_if(
            "R.revalidate.plan_sha",
            "preflight.ts",
            "  if (str(plan.run_plan_sha256) !== options.runPlanSha256) {",
        ),
        ts_if(
            "R.revalidate.readiness",
            "preflight.ts",
            '  if (readiness.ready !== true) refuse("The run plan was never ready to run.");',
        ),
        ts_if(
            "R.revalidate.preflight_stale",
            "preflight.ts",
            "  if (preflight.stale === true || preflight.ready !== true) {",
        ),
        ts_if(
            "R.revalidate.performed",
            "preflight.ts",
            '  if (execution.performed !== false) refuse("This run plan is not in a preflight state.");',
        ),
        ts_if(
            "R.revalidate.package_digest",
            "preflight.ts",
            "  if (str(current.digest) !== str(planned.digest)) {",
        ),
        ts_if(
            "R.revalidate.archive_sha256",
            "preflight.ts",
            "  if (str(snapshot.archive_sha256) !== str(planned.archive_sha256)) {",
        ),
        ts_if(
            "R.revalidate.publisher",
            "preflight.ts",
            "    if (str(publisher[field]) !== str(plannedPublisher[field])) {",
        ),
        ts_if(
            "R.revalidate.receipt_id",
            "preflight.ts",
            "  if (str(receipt.receipt_id) !== str(plannedAuth.receipt_id)) {",
        ),
        ts_if(
            "R.revalidate.receipt_sha256",
            "preflight.ts",
            "  if (str(receipt.receipt_sha256) !== str(plannedAuth.receipt_sha256)) {",
        ),
        ts_if(
            "R.revalidate.receipt_expired",
            "preflight.ts",
            '  if (remainingMs !== null && remainingMs <= 0) refuse("The authorization receipt expired.");',
        ),
        ts_if(
            "R.revalidate.receipt_outlasts_run",
            "preflight.ts",
            "  if (required > 0 && remainingMs !== null && remainingMs < required) {",
        ),
        ts_if("R.revalidate.tool_registry", "preflight.ts", "    if (!options.toolRegistry) {"),
        ts_if(
            "R.revalidate.tool_removed",
            "preflight.ts",
            "      if (!current || current.binding === null) {",
        ),
        ts_if(
            "R.revalidate.tool_replaced",
            "preflight.ts",
            "      if (str(binding.binding_id) !== str(bound.binding_id)) {",
        ),
        ts_if(
            "R.revalidate.tool_changed",
            "preflight.ts",
            "      if (str(binding.binding_sha256) !== str(bound.binding_sha256)) {",
        ),
        ts_if(
            "R.revalidate.tool_contract",
            "preflight.ts",
            "      if (str(current!.contract_sha256) !== str(bound.contract_sha256)) {",
        ),
        ts_if(
            "R.revalidate.tool_status",
            "preflight.ts",
            '      if (str(current!.status) !== "bound") {',
        ),
        ts_if(
            "R.revalidate.model_bound",
            "preflight.ts",
            '  if (!modelId) refuse("The run plan binds no host model.");',
        ),
        ts_if(
            "R.revalidate.model_available",
            "preflight.ts",
            "  if (!stillAvailable(catalog, modelId)) {",
        ),
        sub(
            "R.revalidate.model_identity",
            "preflight.ts",
            "  if (\n"
            "    !live ||\n"
            "    live.provider_id !== str(descriptor.provider_id) ||\n"
            "    live.model_id !== str(descriptor.model_id)\n"
            "  ) {\n",
            "  if (ablatedNever() /* ABLATED R.revalidate.model_identity */) {\n",
        ),
    ),
)

# -- host mediation / capability confinement ---------------------------------------------------
MEDIATION = Profile(
    "minus_host_mediation",
    "-Host mediation",
    "mediation",
    "Capability confinement removed at every mediation point: the runtime no longer confines a "
    "worker to its declared tools, roles, delegation depth, state views and model tasks, no "
    "longer checks a tool's network contract or input schema; the node state-write "
    "authorization check is gone; the runner no longer refuses undeclared graph tools or "
    "host-reserved export names; the tool handler and model router no longer check the host's "
    "answer envelope, binding echo or the model that answered; and on the host the broker no "
    "longer resolves a call against the run's bindings, selected-file capabilities, argument "
    "names or destination address classes, the plugin no longer checks the files a task names, "
    "and the host no longer checks which model answered or what model.complete carries.",
    py=(
        py_if(
            "M.runtime.role_tools",
            "runtime.py",
            '            if tool is None or tool_id not in self.roles[ctx.role]["tools"]:',
        ),
        py_if(
            "M.runtime.tool_kind",
            "runtime.py",
            '            if tool["execution"] not in {"local", "remote"}:',
        ),
        py_if("M.runtime.retries", "runtime.py", '            if tool["retries"] != 0:'),
        sub(
            "M.runtime.network_contract",
            "runtime.py",
            '                    raise PolicyError("Tool network contract exceeds declared permission/policy")\n',
            "                    pass  # ABLATED M.runtime.network_contract\n",
        ),
        py_if("M.runtime.handler", "runtime.py", "            if handler is None:"),
        sub(
            "M.runtime.tool_input_schema",
            "runtime.py",
            '                validate_instance(self.package.files, tool["input_schema"], payload, "tool input")\n',
            "                pass  # ABLATED M.runtime.tool_input_schema\n",
        ),
        py_if(
            "M.runtime.worker_role",
            "runtime.py",
            "            if role == self.coordinator or role not in self.roles:",
        ),
        py_if(
            "M.runtime.worker_approved",
            "runtime.py",
            '            if role not in self.policy["delegation"]["approved_roles"]:',
        ),
        sub(
            "M.runtime.delegation_depth",
            "runtime.py",
            "            if (\n"
            "                parent is not self._root\n"
            "                or depth != parent.depth + 1\n"
            '                or depth > self.policy["delegation"]["max_depth"]\n'
            "            ):\n",
            "            if False:  # ABLATED M.runtime.delegation_depth\n",
        ),
        py_if(
            "M.runtime.state_read",
            "runtime.py",
            '            if not isinstance(inputs, dict) or set(inputs) - set(self.roles[role]["state_read"]):',
        ),
        py_if(
            "M.runtime.state_write",
            "runtime.py",
            '                if not return_value and set(patch) - set(self.roles[role]["state_write"]):',
        ),
        py_if("M.runtime.model_task", "runtime.py", "        if task not in declared:"),
        py_if(
            "M.workflow.node_write",
            "workflow.py",
            '                if set(patch) - set(self.runtime.roles[role]["state_write"]):',
        ),
        py_if("M.runner.graph_tool_declared", "execution/policy.py", "    if undeclared:"),
        py_if(
            "M.runner.export_reserved",
            "execution/policy.py",
            '        if export["path"].lower() in reserved:',
        ),
        py_if(
            "M.handler.args_size",
            "toolbridge/handler.py",
            '        if len(args.encode("utf-8")) > MAX_ARGS_BYTES:',
        ),
        py_if("M.handler.envelope_fields", "toolbridge/handler.py", "        if unknown:"),
        py_if(
            "M.handler.envelope_status",
            "toolbridge/handler.py",
            '        if answer.get("status") != "ok":',
        ),
        sub(
            "M.handler.binding_echo",
            "toolbridge/handler.py",
            "        if (\n"
            '            answer.get("tool_id") != self.tool_id\n'
            '            or answer.get("binding_id") != self.binding["binding_id"]\n'
            '            or answer.get("binding_sha256") != self.binding["binding_sha256"]\n'
            "        ):\n",
            "        if False:  # ABLATED M.handler.binding_echo\n",
        ),
        py_if(
            "M.handler.locality_echo",
            "toolbridge/handler.py",
            '        if answer.get("remote") is not self.remote:',
        ),
        py_if(
            "M.router.model_echo", "hostbridge/router.py", "        if invoked != self.model_id:"
        ),
    ),
    ts=(
        sub(
            "M.start.referenced_files",
            "execution.ts",
            "    this.checkReferencedFiles(request.input, attached);\n",
            "    // ABLATED M.start.referenced_files\n",
        ),
        sub(
            "M.files.attach",
            "file-capabilities.ts",
            "      if (!record || record.sessionId !== sessionId) {\n        refuse(\n",
            "      if (!record || record.sessionId !== sessionId) {\n"
            "        continue; // ABLATED M.files.attach\n"
            "        refuse(\n",
        ),
        ts_if("M.broker.params", "tool-broker.ts", "    if (!allowed.has(key)) {"),
        sub(
            "M.broker.bound",
            "tool-broker.ts",
            "    const bound = this.options.bound.find((item) => item.toolId === request.tool_id);\n"
            "    if (!bound) {\n",
            "    const bound = this.options.bound.find((item) => item.toolId === request.tool_id)!;\n"
            "    if (ablatedNever() /* ABLATED M.broker.bound */) {\n",
        ),
        sub(
            "M.broker.binding_echo",
            "tool-broker.ts",
            "      bound.bindingId !== request.binding_id ||\n"
            "      bound.bindingSha256 !== request.binding_sha256\n",
            "      ablatedNever() /* ABLATED M.broker.binding_echo */\n",
        ),
        sub(
            "M.broker.definition",
            "tool-broker.ts",
            "    const definition = findDefinition(this.options.definitions, bound.bindingId);\n"
            "    if (!definition || definition.enabled === false) {\n",
            "    const definition = findDefinition(this.options.definitions, bound.bindingId)!;\n"
            "    if (ablatedNever() /* ABLATED M.broker.definition */) {\n",
        ),
        sub(
            "M.broker.file_args",
            "tool-broker.ts",
            "    const record =\n"
            '      typeof args === "object" && args !== null && !Array.isArray(args)\n'
            "        ? (args as Record<string, unknown>)\n"
            "        : null;\n"
            '    if (!record || Object.keys(record).join(",") !== "file_id" || typeof record.file_id !== "string") {\n',
            "    const record: any =\n"
            '      typeof args === "object" && args !== null && !Array.isArray(args)\n'
            "        ? (args as Record<string, unknown>)\n"
            "        : null;\n"
            "    if (ablatedNever() /* ABLATED M.broker.file_args */) {\n",
        ),
        sub(
            "M.broker.file_capability",
            "tool-broker.ts",
            "    const capability = this.options.files?.get(record.file_id);\n    if (!capability) {\n",
            "    const capability = this.options.files?.get(record.file_id)!;\n"
            "    if (ablatedNever() /* ABLATED M.broker.file_capability */) {\n",
        ),
        ts_if("M.broker.address_policy", "tool-broker.ts", "      if (rejection) {"),
        sub(
            "M.broker.request_size",
            "tool-broker.ts",
            "      (body !== null && Buffer.byteLength(body) > maxRequest) ||\n"
            "      Buffer.byteLength(target) > Math.max(maxRequest, path.length)\n",
            "      ablatedNever() /* ABLATED M.broker.request_size */\n",
        ),
        ts_if(
            "M.adapter.argument_names",
            "tool-adapters.ts",
            '    if (key !== "query" && key !== "limit") {',
        ),
        ts_if("M.host_llm.model_echo", "host-llm.ts", "  if (invoked !== request.modelId) {"),
        sub(
            "M.bridge.complete_params",
            "bridge-core.ts",
            "    if (!allowed.has(key)) throw violation(`model.complete does not accept ${key}`);\n",
            "    // ABLATED M.bridge.complete_params\n",
        ),
    ),
)

# -- output / state validation ------------------------------------------------------------------
VALIDATION = Profile(
    "minus_output_validation",
    "-Output validation",
    "validation",
    "Schema and relational validation of what models and tools return, and of what the "
    "workflow writes, removed: the router no longer treats a turn the provider did not finish "
    "(stopped at the output limit, failed, aborted) as a failure and no longer validates model "
    "output against the node schema, the runtime no longer validates model or tool results against their schemas, "
    "the interpreter no longer validates node outputs, map items and outputs, state writes, "
    "wave commits, the workflow output and text exports, and validate/output nodes no longer "
    "evaluate their declared assertions; the broker no longer checks a response's content "
    "type or size. Parsing stays (an answer that is not JSON has no value to accept), as do "
    "the `lookup` constructors, which compute values rather than check them.",
    py=(
        py_if(
            "O.router.termination", "hostbridge/router.py", "        if termination is not None:"
        ),
        sub(
            "O.router.output_schema",
            "hostbridge/router.py",
            "            validator.validate(output)\n",
            "            pass  # ABLATED O.router.output_schema\n",
        ),
        sub(
            "O.runtime.model_output_schema",
            "runtime.py",
            '            Draft202012Validator(output_schema).validate(result["output"])\n',
            "            pass  # ABLATED O.runtime.model_output_schema\n",
        ),
        sub(
            "O.runtime.tool_output_schema",
            "runtime.py",
            '                validate_instance(self.package.files, tool["output_schema"], result, "tool output")\n',
            "                pass  # ABLATED O.runtime.tool_output_schema\n",
        ),
        py_if(
            "O.workflow.closed_validator",
            "workflow.py",
            "            if not validator.is_valid(result):",
        ),
        sub(
            "O.workflow.assertions",
            "workflow.py",
            '            check_assertions(node.get("assertions", []), env)\n',
            "            pass  # ABLATED O.workflow.assertions\n",
        ),
        sub(
            "O.workflow.node_output",
            "workflow.py",
            "            validate_instance(\n"
            '                self.package.files, node["output_schema"], result, f"node {node[\'id\']} output"\n'
            "            )\n",
            "            pass  # ABLATED O.workflow.node_output\n",
        ),
        sub(
            "O.workflow.skipped_output",
            "workflow.py",
            "                validate_instance(\n"
            "                    self.package.files,\n"
            '                    node["output_schema"],\n'
            "                    result,\n"
            "                    f\"node {node['id']} skipped output\",\n"
            "                )\n",
            "                pass  # ABLATED O.workflow.skipped_output\n",
        ),
        sub(
            "O.workflow.map_item",
            "workflow.py",
            "            validate_instance(\n"
            '                self.package.files, node["item_schema"], item, f"node {node[\'id\']} item"\n'
            "            )\n",
            "            pass  # ABLATED O.workflow.map_item\n",
        ),
        sub(
            "O.workflow.map_output",
            "workflow.py",
            "        validate_instance(\n"
            '            self.package.files, node["output_schema"], results, f"node {node[\'id\']} map output"\n'
            "        )\n",
            "        pass  # ABLATED O.workflow.map_output\n",
        ),
        sub(
            "O.workflow.state_write",
            "workflow.py",
            "            validate_instance(\n"
            "                self.package.files,\n"
            '                self.package.policy["memory"]["state_schema"],\n'
            "                snapshot | patch,\n"
            "                f\"node {node['id']} state write\",\n"
            "            )\n",
            "            pass  # ABLATED O.workflow.state_write\n",
        ),
        sub(
            "O.workflow.state_commit",
            "workflow.py",
            "                    validate_instance(\n"
            "                        self.package.files,\n"
            '                        self.package.policy["memory"]["state_schema"],\n'
            "                        next_state,\n"
            '                        "state commit",\n'
            "                    )\n",
            "                    pass  # ABLATED O.workflow.state_commit\n",
        ),
        sub(
            "O.workflow.output",
            "workflow.py",
            "            validate_instance(\n"
            '                self.package.files, self.graph["output_schema"], self._output, "workflow output"\n'
            "            )\n",
            "            pass  # ABLATED O.workflow.output\n",
        ),
        py_if(
            "O.workflow.text_export",
            "workflow.py",
            '                if export["format"] == "text" and not isinstance(value, str):',
        ),
    ),
    ts=(
        ts_if(
            "O.broker.content_type",
            "tool-broker.ts",
            '    if (contentType !== "application/json") {',
        ),
        ts_if(
            "O.broker.response_size",
            "tool-broker.ts",
            "    if (facts.response_bytes! > (definition.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES)) {",
        ),
    ),
)

# -- resource enforcement ---------------------------------------------------------------------
RESOURCES = Profile(
    "minus_resource_enforcement",
    "-Resource enforcement",
    "resource",
    "Budgets, caps and deadlines removed: the runtime no longer refuses a call for its remote, "
    "per-tool or token budget, its context-window reservation or its approval threshold, nor "
    "halts on a host that reports more usage than it reserved; maps no longer refuse more "
    "items than they declare; node, graph, tool (runtime, bridge and broker), model-call and "
    "host run deadlines no longer fire; the task-size bound is gone from the plugin's start "
    "check, the control plane's request bound and task validation, and the runner's input; "
    "the runner no longer refuses an output cap above the host ceiling; and the plugin no "
    "longer bounds the output cap a call may request, or how long a completion and a bridge "
    "session may take.",
    py=(
        py_if(
            "B.runtime.remote_global",
            "runtime.py",
            '        if self._global.remote_calls + count > self.budget["max_remote_calls"]:',
        ),
        py_if(
            "B.runtime.remote_worker",
            "runtime.py",
            '        if own.remote_calls + count > self.roles[ctx.role]["budget"]["remote_calls"]:',
        ),
        py_if(
            "B.runtime.tool_calls",
            "runtime.py",
            "                if self._global.tool_calls[tool_id] >= cap:",
        ),
        py_if(
            "B.runtime.context_window",
            "runtime.py",
            "        if reservation > router.context_window:",
        ),
        sub(
            "B.runtime.global_tokens",
            "runtime.py",
            "            if (\n"
            "                self._global.tokens + self._global.reserved_tokens + reservation\n"
            '                > self.budget["hard_tokens"]\n'
            "            ):\n",
            "            if False:  # ABLATED B.runtime.global_tokens\n",
        ),
        sub(
            "B.runtime.worker_tokens",
            "runtime.py",
            "            if (\n"
            "                own.tokens + own.reserved_tokens + reservation\n"
            '                > self.roles[ctx.role]["budget"]["tokens"]\n'
            "            ):\n",
            "            if False:  # ABLATED B.runtime.worker_tokens\n",
        ),
        sub(
            "B.runtime.approval_threshold",
            "runtime.py",
            "            if (\n"
            "                threshold is not None\n"
            "                and self._global.tokens + self._global.reserved_tokens + reservation > threshold\n"
            "            ):\n",
            "            if False:  # ABLATED B.runtime.approval_threshold\n",
        ),
        sub(
            "B.runtime.accounting_halt",
            "runtime.py",
            "            if not valid_counts or inp > input_bound or out > max_output_tokens:\n",
            "            if not valid_counts:  # ABLATED B.runtime.accounting_halt (overrun)\n",
        ),
        sub(
            "B.runtime.tool_timeout",
            "runtime.py",
            '            async with asyncio.timeout(tool["timeout_seconds"]):\n',
            "            async with asyncio.timeout(None):  # ABLATED B.runtime.tool_timeout\n",
        ),
        sub(
            "B.workflow.step_timeout",
            "workflow.py",
            "        try:\n"
            '            async with asyncio.timeout(node["timeout_seconds"]):\n'
            "                result = await self._operation(node, env, ctx)\n",
            "        try:\n"
            "            async with asyncio.timeout(None):  # ABLATED B.workflow.step_timeout\n"
            "                result = await self._operation(node, env, ctx)\n",
        ),
        sub(
            "B.workflow.node_timeout",
            "workflow.py",
            '            async with asyncio.timeout(node["timeout_seconds"]):\n'
            '                if node["type"] == "map":\n',
            "            async with asyncio.timeout(None):  # ABLATED B.workflow.node_timeout\n"
            '                if node["type"] == "map":\n',
        ),
        sub(
            "B.workflow.deadline",
            "workflow.py",
            '            async with asyncio.timeout(self.graph["deadline_seconds"]):\n',
            "            async with asyncio.timeout(None):  # ABLATED B.workflow.deadline\n",
        ),
        sub(
            "B.workflow.map_items",
            "workflow.py",
            '        if not isinstance(items, list) or len(items) > node["max_items"]:\n',
            "        if not isinstance(items, list):  # ABLATED B.workflow.map_items\n",
        ),
        sub(
            "B.runner.watchdog",
            "execution/session.py",
            "        await asyncio.sleep(seconds)\n",
            "        await asyncio.Event().wait()  # ABLATED B.runner.watchdog\n",
        ),
        py_if(
            "B.runner.output_cap",
            "execution/policy.py",
            "        if requested > limits.max_output_tokens_per_call:",
        ),
        sub(
            "B.server.request_size",
            "browser/server.py",
            "MAX_REQUEST_BYTES = 256 * 1024\n",
            "MAX_REQUEST_BYTES = 2**62  # ABLATED B.server.request_size\n",
        ),
        py_if(
            "B.control.task_size",
            "browser/presentation.py",
            "    if len(data) > MAX_TASK_INPUT_BYTES:",
        ),
        py_if(
            "B.runner.input_size", "execution/invocation.py", "    if len(data) > MAX_INPUT_BYTES:"
        ),
        sub(
            "B.router.call_timeout",
            "hostbridge/router.py",
            '        answer = await self._peer.call("model.complete", params, timeout=self.timeout)\n',
            '        answer = await self._peer.call("model.complete", params, timeout=None)  # ABLATED B.router.call_timeout\n',
        ),
        sub(
            "B.handler.call_timeout",
            "toolbridge/handler.py",
            "                timeout=self.timeout + BRIDGE_GRACE_SECONDS,\n",
            "                timeout=None,  # ABLATED B.handler.call_timeout\n",
        ),
    ),
    ts=(
        ts_if("B.start.input_size", "execution.ts", "    if (bytes > MAX_INPUT_BYTES) {"),
        sub(
            "B.bridge.output_cap",
            "bridge-core.ts",
            "    maxOutputTokens > Math.min(limits.maxOutputTokens, MAX_OUTPUT_TOKENS)\n",
            "    ablatedNever() /* ABLATED B.bridge.output_cap */\n",
        ),
        sub(
            "B.bridge.completion_timeout",
            "bridge-core.ts",
            "    const timeout = AbortSignal.timeout(this.limits.completionTimeoutMs);\n",
            "    const timeout = AbortSignal.timeout(2_147_483_647); // ABLATED B.bridge.completion_timeout\n",
        ),
        sub(
            "B.bridge.session_timeout",
            "bridge-core.ts",
            "    const deadline = AbortSignal.timeout(this.limits.sessionTimeoutMs);\n",
            "    const deadline = AbortSignal.timeout(2_147_483_647); // ABLATED B.bridge.session_timeout\n",
        ),
        sub(
            "B.broker.file_timeout",
            "tool-broker.ts",
            "    const deadline = AbortSignal.timeout(timeoutMs);\n"
            "    try {\n"
            "      return await this.options.pdfReader(",
            "    const deadline = AbortSignal.timeout(2_147_483_647); // ABLATED B.broker.file_timeout\n"
            "    try {\n"
            "      return await this.options.pdfReader(",
        ),
        sub(
            "B.broker.http_timeout",
            "tool-broker.ts",
            "    const deadline = AbortSignal.timeout(timeoutMs);\n"
            "    const transport = this.options.transport ?? nodeToolTransport;\n",
            "    const deadline = AbortSignal.timeout(2_147_483_647); // ABLATED B.broker.http_timeout\n"
            "    const transport = this.options.transport ?? nodeToolTransport;\n",
        ),
    ),
)

FULL = Profile(
    "full",
    "Full",
    None,
    "The production system, unmodified: the plugin compiled from its own sources and agentpkg "
    "imported from agentpkg/src.",
)

PROFILES = (
    FULL,
    VERIFICATION,
    TRUST,
    AUTHORIZATION,
    COMPATIBILITY,
    REVALIDATION,
    MEDIATION,
    VALIDATION,
    RESOURCES,
)
BY_NAME = {profile.name: profile for profile in PROFILES}
ABLATIONS = tuple(profile for profile in PROFILES if profile.component is not None)
