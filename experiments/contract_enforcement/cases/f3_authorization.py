"""F3 — authorization: nothing runs on authority the person did not grant, or on stale consent."""

from __future__ import annotations

from harness import oracle
from harness.paths import PACKAGES
from harness.world import DECISIONS

from . import boundaries as B
from .base import Template, base_plan, host

BOTH = ("meeting-agenda", "literature-review")
LR = ("literature-review",)
REQUIRED = {
    "meeting-agenda": ("model.reasoning", "memory.session"),
    "literature-review": ("network.scholarly", "network.citations", "memory.session"),
}
TOOLS = ("scholarly-search", "citation-resolver", "paper-reader")
ONCE = {
    "meeting-agenda": ("model.reasoning", "memory.session"),
    "literature-review": (
        "network.scholarly",
        "network.citations",
        "memory.session",
        "model.reasoning",
        "files.pdfs",
    ),
}
KIND = {
    "model.reasoning": "model",
    "memory.session": "memory",
    "network.scholarly": "network",
    "network.citations": "network",
    "files.pdfs": "files.read",
}
PERMISSION_TOOLS = {
    "network.scholarly": ("scholarly-search",),
    "network.citations": ("citation-resolver",),
    "files.pdfs": ("paper-reader",),
}


class RequiredDenied(Template):
    def variants(self, package, env, rng, budget):
        return [
            self.variant(package, pid, {"permission": pid}, f"required permission {pid} denied")
            for pid in REQUIRED[package]
        ]

    def plan(self, variant, kind, env):
        plan = base_plan(env, variant.package)
        if kind == "violation":
            plan.decisions = {**plan.decisions, variant.params["permission"]: "deny"}
        return plan, B.prepared_or_executed


REQUIRED_DENIED = RequiredDenied(
    "F3.required_permission_denied",
    "F3",
    "Required permission denied",
    "The person denies one permission the package marks required; every other decision, "
    "approval, requirement and the trust state are unchanged.",
    "A run proceeds only with every required permission granted.",
    "authorization",
    "authorize",
    ("required_permission_denied",),
    "A Run Plan, lease or execution exists although a required permission is denied.",
    "Every permission granted for the session.",
    "finite",
    BOTH,
    "minus_authorization",
    "authorization receipt",
    "required permission denied",
)


class ModeDenied(Template):
    def variants(self, package, env, rng, budget):
        return [
            self.variant(
                package,
                "model.reasoning",
                {"permission": "model.reasoning"},
                "the model permission (optional in the package, required for a model-backed run) "
                "denied",
            )
        ]

    def plan(self, variant, kind, env):
        plan = base_plan(env, variant.package)
        if kind == "violation":
            plan.decisions = {**plan.decisions, "model.reasoning": "deny"}
        return plan, B.prepared_or_executed


MODE_DENIED = ModeDenied(
    "F3.run_mode_permission_denied",
    "F3",
    "Model-run permission denied",
    "Literature Review declares its model permission optional (it can replay fixtures); a "
    "model-backed run needs it anyway. The person denies it.",
    "A model-backed run requires the package's model permission even when the package calls it "
    "optional.",
    "authorization",
    "authorize",
    ("execution_mode_permission_denied",),
    "A Run Plan, lease or execution exists without the model permission.",
    "The model permission granted.",
    "finite",
    LR,
    "minus_authorization",
    "run-mode permission",
    "model permission denied",
)


class ToolApprovalWithheld(Template):
    def variants(self, package, env, rng, budget):
        return [
            self.variant(
                package, tool, {"tool": tool}, f"tool {tool} declared and bound but not approved"
            )
            for tool in TOOLS
        ]

    def plan(self, variant, kind, env):
        plan = base_plan(env, variant.package)
        if kind == "violation":
            plan.approvals = {**plan.approvals, variant.params["tool"]: False}
        return plan, B.prepared_or_executed


TOOL_APPROVAL = ToolApprovalWithheld(
    "F3.tool_approval_withheld",
    "F3",
    "Tool approval withheld",
    "Every permission is granted, but one declared, host-bound tool is not explicitly approved.",
    "A granted permission is not an approval: every tool needs its own.",
    "authorization",
    "authorize",
    ("tool_not_approved",),
    "A Run Plan, lease or execution exists although a bound tool is unapproved.",
    "Every tool approved.",
    "finite",
    LR,
    "minus_authorization",
    "per-tool approval",
    "tool approval withheld",
)


def _uses(obs, permission: str) -> int:
    """How many times the run actually used one permission's authority."""
    kind = KIND[permission]
    if kind == "model":
        return len(oracle.audit_actions(obs, "model.called"))
    if kind == "memory":
        return len(oracle.audit_actions(obs, "worker.spawned"))
    tools = PERMISSION_TOOLS.get(permission, ())
    return len([e for e in oracle.audit_actions(obs, "tool.called") if e.get("tool") in tools])


class OnceOverused(Template):
    def variants(self, package, env, rng, budget):
        return [
            self.variant(
                package,
                pid,
                {"permission": pid},
                f"{pid} granted 'once', though this graph uses it more than once",
            )
            for pid in ONCE[package]
        ]

    def plan(self, variant, kind, env):
        plan = base_plan(env, variant.package)
        pid = variant.params["permission"]
        if kind == "violation":
            plan.decisions = {**plan.decisions, pid: "once"}

        def boundary(obs, pid=pid):
            return _uses(obs, pid) > 1

        return plan, boundary


ONCE_OVERUSED = OnceOverused(
    "F3.once_grant_exceeded",
    "F3",
    "One-time grant the workflow would use repeatedly",
    "The person grants a permission 'once'; the package's graph would consume that kind of "
    "authority more than once.",
    "A once-only grant is used at most once; it is never silently widened to the session.",
    "authorization",
    "authorize",
    ("execution_grant_unsupported",),
    "The once-granted authority is exercised more than once.",
    "The same permission granted for the session.",
    "finite",
    BOTH,
    "minus_authorization",
    "grant scope",
    "once-only grant overused",
)


class SelectedFileDenied(Template):
    MODES = (
        ("attached_pdf", "files.pdfs denied while the person attaches a selected PDF to the run"),
    )

    def variants(self, package, env, rng, budget):
        return [
            self.variant(package, mode, {"mode": mode}, description)
            for mode, description in self.MODES
        ]

    def plan(self, variant, kind, env):
        plan = base_plan(env, variant.package)
        if kind == "violation":
            plan.decisions = {**plan.decisions, "files.pdfs": "deny"}
            if variant.params["mode"] == "named_document":
                plan.attach_pdf = False

                def name_document(task, ctx):
                    from harness.synthetic import PDF_PAPER

                    return {**task, "documents": {PDF_PAPER.doi: "doc-unattached"}}

                plan.input_patch = name_document

                def boundary(obs):
                    return B.document_read(obs) or any(
                        e.get("tool") == "paper-reader"
                        for e in oracle.audit_actions(obs, "tool.dispatched")
                    )

                return plan, boundary
        return plan, B.any_of(B.document_read, B.executed)


class NamedDocumentDenied(SelectedFileDenied):
    MODES = (
        ("named_document", "files.pdfs denied; the task names a document id (no file attached)"),
    )


SELECTED_FILE_DENIED = SelectedFileDenied(
    "F3.selected_file_without_permission",
    "F3",
    "Selected document without the file permission",
    "A person's document is attached to (or named by) a run whose selected-file permission "
    "is denied. The permission is optional in the package, so the plan itself is legal.",
    "Reading a selected file requires the file permission, separately from selecting it.",
    "authorization",
    "revalidate",
    ("file_permission", "permission_denied"),
    "The document is parsed, or a paper-reader call is dispatched to the host.",
    "The selected-file permission granted with the document attached.",
    "finite",
    LR,
    "minus_authorization",
    "selected-file permission",
    "file read without permission",
)
NAMED_DOCUMENT_DENIED = NamedDocumentDenied(
    "F3.named_document_without_permission",
    "F3",
    "Document named by the task without the file permission",
    "The task names a document id for a run whose selected-file permission is denied and to "
    "which no file is attached. Nothing at start refers to a file, so the read itself is the "
    "decision point.",
    "Reading a selected file requires the file permission at the moment of the read.",
    "authorization",
    "execute/tool",
    ("permission_denied",),
    "The document is parsed, or a paper-reader call is dispatched to the host.",
    "The selected-file permission granted with the document attached.",
    "finite",
    LR,
    "minus_authorization",
    "per-call grant check",
    "file read without permission",
)


class ReceiptBinding(Template):
    MODES = (
        (
            "stale_receipt",
            "prepare names the session's previous receipt after a newer authorization",
        ),
        (
            "foreign_receipt",
            "prepare names a receipt issued to another session of the same package",
        ),
        ("foreign_digest", "authorize echoes the digest of a different package"),
    )

    def variants(self, package, env, rng, budget):
        return [
            self.variant(package, mode, {"mode": mode}, description)
            for mode, description in self.MODES
        ]

    def plan(self, variant, kind, env):
        plan = base_plan(env, variant.package)
        mode = variant.params["mode"]
        if kind == "control":
            return plan, B.prepared_or_executed
        if mode == "stale_receipt":

            async def reauthorize(ctx):
                ctx.prepare_receipt_override = ctx.receipt_id
                decisions = [{"permissionId": k, "decision": v} for k, v in plan.decisions.items()]
                approvals = [{"toolId": k, "approved": v} for k, v in plan.approvals.items()]
                await ctx.page(
                    "hooks", "authorize", ctx.session_id, ctx.digest, decisions, approvals
                )

            plan.hook("before_prepare", reauthorize)
        elif mode == "foreign_receipt":

            async def foreign(ctx):
                other = ctx.dir / "packages" / "second.agent.pkg"
                other.write_bytes(plan.archive)
                opened = await ctx.page("hooks", "openLocal", str(other))
                sid = opened["value"]["sessionId"]
                decisions = [{"permissionId": k, "decision": v} for k, v in plan.decisions.items()]
                approvals = [{"toolId": k, "approved": v} for k, v in plan.approvals.items()]
                await ctx.page("hooks", "authorize", sid, ctx.digest, decisions, approvals)
                ctx.prepare_receipt_override = ctx.control.authorization(sid)["receipt_id"]

            plan.hook("before_prepare", foreign)
        else:
            other_key = (
                "literature-review" if variant.package == "meeting-agenda" else "meeting-agenda"
            )

            async def digest_of_other(ctx):
                other = ctx.dir / "packages" / "other.agent.pkg"
                other.write_bytes(env.archive(other_key))
                opened = await ctx.page("hooks", "openLocal", str(other))
                ctx.authorize_digest_override = opened["value"]["identity"]["digest"]

            plan.hook("before_authorize", digest_of_other)
            return plan, B.prepared_or_executed
        return plan, B.prepared_or_executed


RECEIPT_BINDING = ReceiptBinding(
    "F3.receipt_binding",
    "F3",
    "Consent bound to the wrong session, receipt or bytes",
    "The caller prepares a plan against a receipt that is not this session's current one, "
    "or authorizes while echoing a different package's digest.",
    "A receipt is bound to the exact session and bytes it was issued for and cannot be replayed.",
    "revalidation",
    "prepare",
    ("receipt_mismatch", "digest_mismatch"),
    "A Run Plan, lease or execution is created from the mismatched consent.",
    "The same flow echoing this session's own receipt and digest.",
    "finite",
    BOTH,
    "minus_plan_revalidation",
    "receipt binding",
    "receipt replayed across sessions",
)


class ConsentLifetime(Template):
    TTLS = (600, 1800, 3600, 4500, 4540)

    def variants(self, package, env, rng, budget):
        return [
            self.variant(
                package,
                f"ttl-{ttl}",
                {"session_ttl_seconds": ttl},
                f"consent (session) lasts {ttl} s; the host run deadline is 4500 s (+60 s margin)",
                control_params={"session_ttl_seconds": 4800},
                control_description="consent that outlasts the run deadline (4800 s)",
            )
            for ttl in self.TTLS
        ]

    def plan(self, variant, kind, env):
        ttl = (variant.control_params if kind == "control" else variant.params)[
            "session_ttl_seconds"
        ]
        plan = base_plan(env, variant.package, host=host(session_ttl_seconds=ttl))
        return plan, B.lease_or_executed


CONSENT_LIFETIME = ConsentLifetime(
    "F3.consent_lifetime",
    "F3",
    "Consent that expires before the run could finish",
    "The authorization receipt is valid now but expires before the host's run deadline.",
    "A run starts only under consent that outlasts it.",
    "revalidation",
    "revalidate",
    ("authorization_expiring", "receipt_outlasts_run_deadline"),
    "A lease is issued or execution starts under consent that ends mid-run.",
    "Consent that outlasts the whole run deadline.",
    "finite",
    BOTH,
    "minus_plan_revalidation",
    "consent lifetime",
    "receipt expires mid-run",
)

TEMPLATES = (
    REQUIRED_DENIED,
    MODE_DENIED,
    TOOL_APPROVAL,
    ONCE_OVERUSED,
    SELECTED_FILE_DENIED,
    NAMED_DOCUMENT_DENIED,
    RECEIPT_BINDING,
    CONSENT_LIFETIME,
)
_ = (PACKAGES, DECISIONS)
