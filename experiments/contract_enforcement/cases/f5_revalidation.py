"""F5 — immutable bindings: a prepared Run Plan is acted on only if the world still matches it.

Every case prepares a ready plan through the real page flow, then changes one
fact between `prepareRunPlan` and `startExecution`, and only then presses Run.
"""

from __future__ import annotations

import copy
import os
import stat

from harness import oracle
from harness.world import experiment_definitions, model_host

from . import boundaries as B
from .base import Env, Template, base_plan, host, key_pin
from .f4_compatibility import TOOLS, _qwen, model_used, tool_executed

BOTH = ("meeting-agenda", "literature-review")
LR = ("literature-review",)
HISTORICAL = {
    "meeting-agenda": "meeting-agenda-0.2.1.agent.pkg",
    "literature-review": "literature-review-0.2.4.agent.pkg",
}


def _decisions(plan, **changes):
    decisions = {**plan.decisions, **changes.get("decisions", {})}
    approvals = {**plan.approvals, **changes.get("approvals", {})}
    return (
        [{"permissionId": k, "decision": v} for k, v in decisions.items()],
        [{"toolId": k, "approved": v} for k, v in approvals.items()],
    )


class Reauthorized(Template):
    def variants(self, package, env, rng, budget):
        out = [
            self.variant(
                package,
                "identical",
                {"mode": "identical"},
                "the person authorizes again with identical decisions",
            ),
            self.variant(
                package,
                "permission_withdrawn",
                {"mode": "permission_withdrawn"},
                "the person authorizes again, now denying a required permission",
            ),
        ]
        if package == "literature-review":
            out.append(
                self.variant(
                    package,
                    "approval_withdrawn",
                    {"mode": "approval_withdrawn"},
                    "the person authorizes again, withdrawing a tool approval",
                )
            )
        return out

    def plan(self, variant, kind, env):
        plan = base_plan(env, variant.package)
        if kind == "violation":
            mode = variant.params["mode"]
            required = "memory.session"

            async def reauthorize(ctx):
                changes = {}
                if mode == "permission_withdrawn":
                    changes = {"decisions": {required: "deny"}}
                elif mode == "approval_withdrawn":
                    changes = {"approvals": {"citation-resolver": False}}
                decisions, approvals = _decisions(plan, **changes)
                await ctx.page(
                    "hooks", "authorize", ctx.session_id, ctx.digest, decisions, approvals
                )

            plan.hook("after_prepare", reauthorize)
        return plan, B.executed


REAUTHORIZED = Reauthorized(
    "F5.reauthorized_after_plan",
    "F5",
    "Consent changed after the plan was frozen",
    "After a ready plan exists, the person authorizes again (identically, or withdrawing a "
    "permission or an approval), and then presses Run on the earlier plan.",
    "A plan is bound to the one receipt it was prepared under; newer consent supersedes it.",
    "revalidation",
    "revalidate",
    ("run_plan_absent", "authorization_superseded", "run_plan_identity"),
    "The superseded plan's run starts executing.",
    "The same plan, started with no intervening authorization.",
    "finite",
    BOTH,
    "minus_plan_revalidation",
    "immutable Run Plan",
    "consent changed after plan",
)


class TrustWithdrawn(Template):
    MODES = (
        ("pin_removed", "the operator removes the publisher's pin"),
        ("pin_rebound", "the publisher's key is re-pinned for a different publisher id"),
        ("pin_rescoped", "the publisher's key is re-pinned for the other package only"),
    )

    def variants(self, package, env, rng, budget):
        return [
            self.variant(
                package,
                mode,
                {"mode": mode},
                description,
                control_params={"mode": "unrelated_pin_added"},
                control_description=(
                    "an unrelated key is pinned after the plan; this publisher stays trusted"
                ),
            )
            for mode, description in self.MODES
        ]

    def plan(self, variant, kind, env):
        from agentpkg.browser.trust import public_key_from_pem

        from harness.paths import PACKAGES

        plan = base_plan(env, variant.package)
        mode = variant.params["mode"] if kind == "violation" else "unrelated_pin_added"
        other = "literature-review" if variant.package == "meeting-agenda" else "meeting-agenda"

        async def change(ctx):
            key = public_key_from_pem(env.publisher_pem(variant.package))
            from agentpkg.signing import fingerprint

            fp = fingerprint(key)
            if mode == "unrelated_pin_added":
                pin = key_pin(
                    env.key("other-publisher"),
                    variant.package,
                    publisher_id="another-publisher",
                    prefix=None,
                )
                ctx.control.trust_add(
                    public_key_from_pem(pin.public_pem),
                    display_name="Unrelated",
                    publisher_id="another-publisher",
                )
                return
            ctx.control.trust_remove(fp)
            if mode == "pin_rebound":
                ctx.control.trust_add(
                    key, display_name="Re-pinned", publisher_id="another-publisher"
                )
            elif mode == "pin_rescoped":
                ctx.control.trust_add(
                    key,
                    display_name="Re-pinned",
                    publisher_id="webagents-research",
                    package_id_prefix=PACKAGES[other]["package_id"],
                )

        plan.hook("after_prepare", change)
        return plan, B.executed


TRUST_WITHDRAWN = TrustWithdrawn(
    "F5.trust_withdrawn_after_plan",
    "F5",
    "Publisher trust withdrawn after the plan was frozen",
    "After a ready plan exists, the operator removes or re-scopes the publisher's pin, so "
    "the signer is no longer trusted for this package.",
    "Trust is re-checked at start, not inherited from preparation time.",
    "revalidation",
    "revalidate",
    ("publisher_trust_changed", "publisher_not_trusted", "publisher"),
    "The run starts executing after trust was withdrawn.",
    "An unrelated pin added after the plan; this publisher remains trusted.",
    "finite",
    BOTH,
    "minus_plan_revalidation",
    "trust revalidation",
    "trust withdrawn after plan",
)


class ModelChanged(Template):
    MODES = (
        ("removed", "the selected model is removed from the host", "other_removed"),
        ("not_routable", "the selected model can no longer be routed", "other_not_routable"),
        ("deprecated", "the selected model is marked deprecated", "other_deprecated"),
        (
            "override_disabled",
            "exact-model requests are no longer permitted to the plugin",
            "allowlist_keeps",
        ),
        (
            "allowlist_excludes",
            "the plugin's allowlist now excludes the selected model",
            "allowlist_keeps",
        ),
    )

    def variants(self, package, env, rng, budget):
        return [
            self.variant(
                package,
                mode,
                {"mode": mode},
                description,
                control_params={"mode": control},
                control_description={
                    "other_removed": "an unused model is removed from the host",
                    "other_not_routable": "an unused model becomes unroutable",
                    "other_deprecated": "an unused model is marked deprecated",
                    "allowlist_keeps": (
                        "an allowlist is introduced that still permits the selected model"
                    ),
                }[control],
            )
            for mode, description, control in self.MODES
        ]

    @staticmethod
    def changed(mode: str) -> dict:
        spec = model_host()
        if mode == "removed":
            spec["rows"] = [r for r in spec["rows"] if r["id"] != "qwen3:30b"]
            spec["routable"]["ollama"] = ["llama3.1:8b"]
            spec["picker"] = copy.deepcopy(spec["routable"])
        elif mode == "not_routable":
            spec["routable"]["ollama"] = ["llama3.1:8b"]
            spec["picker"] = copy.deepcopy(spec["routable"])
        elif mode == "deprecated":
            _qwen(spec)["status"] = "deprecated"
        elif mode == "override_disabled":
            spec["plugin_llm"] = {"allowModelOverride": False}
        elif mode == "allowlist_excludes":
            spec["plugin_llm"] = {
                "allowModelOverride": True,
                "allowedModels": ["ollama/llama3.1:8b"],
            }
        elif mode == "other_removed":
            spec["rows"] = [r for r in spec["rows"] if r["id"] != "gpt-5.6-luna"]
            spec["routable"].pop("openai")
            spec["picker"] = copy.deepcopy(spec["routable"])
        elif mode == "other_not_routable":
            spec["routable"]["openai"] = []
            spec["picker"] = copy.deepcopy(spec["routable"])
        elif mode == "other_deprecated":
            next(r for r in spec["rows"] if r["id"] == "gpt-5.6-luna")["status"] = "deprecated"
        elif mode == "allowlist_keeps":
            spec["plugin_llm"] = {
                "allowModelOverride": True,
                "allowedModels": ["ollama/qwen3:30b", "ollama/llama3.1:8b"],
            }
        return spec

    def plan(self, variant, kind, env):
        plan = base_plan(env, variant.package)
        mode = (variant.params if kind == "violation" else variant.control_params)["mode"]

        async def change(ctx):
            await ctx.update_host(model_host=self.changed(mode))

        plan.hook("after_prepare", change)
        return plan, B.any_of(
            B.unplanned_model_executed, model_used
        ) if kind == "violation" else model_used


MODEL_CHANGED = ModelChanged(
    "F5.model_changed_after_plan",
    "F5",
    "Bound model withdrawn or substituted after the plan was frozen",
    "After a ready plan exists, the host stops offering the bound model (removed, "
    "unroutable, retired, or no longer permitted), where OpenClaw would otherwise fall back "
    "silently to its default model or refuse.",
    "Every completion is made on the plan's model, or not at all; no silent substitution.",
    "revalidation",
    "revalidate",
    ("selected_model_unavailable", "model_available"),
    "Any completion is dispatched under the plan after its model stopped being offered.",
    "The same kind of host change applied to a model the plan does not use.",
    "finite",
    BOTH,
    "minus_plan_revalidation",
    "immutable model binding",
    "model changed after plan",
)


class ToolChanged(Template):
    def variants(self, package, env, rng, budget):
        out = []
        for tool in TOOLS:
            modes = ["disabled", "timeout", "version", "removed"]
            if tool != "paper-reader":
                modes += ["origin", "path"]
            for mode in modes:
                out.append(
                    self.variant(
                        package,
                        f"{tool}-{mode}",
                        {"tool": tool, "mode": mode},
                        f"{tool}: the host binding is {mode} after the plan",
                        control_params={"tool": tool, "mode": "relabelled"},
                        control_description=(
                            f"{tool}: the binding's display name changes after the plan"
                        ),
                    )
                )
        return out

    def plan(self, variant, kind, env):
        params = variant.params if kind == "violation" else variant.control_params
        tool, mode = params["tool"], params["mode"]
        plan = base_plan(env, variant.package)

        async def change(ctx):
            definitions = experiment_definitions(ctx.helper.hello["built_in_bindings"])
            tools = None
            if mode == "disabled":
                tools = {"bindings": [{"toolId": tool, "enabled": False}]}
            elif mode == "timeout":
                tools = {"bindings": [{"toolId": tool, "timeoutSeconds": 7}]}
            elif mode == "origin":
                tools = {"bindings": [{"toolId": tool, "origin": "https://mirror.example.org"}]}
            elif mode == "path":
                tools = {
                    "bindings": [
                        {
                            "toolId": tool,
                            "path": "/v2"
                            + ("/works" if tool == "scholarly-search" else "/resolve"),
                        }
                    ]
                }
            elif mode == "relabelled":
                tools = {"bindings": [{"toolId": tool, "displayName": "Relabelled implementation"}]}
            elif mode == "version":
                target = next(d for d in definitions if d["toolId"] == tool)
                target["implementationVersion"] = target["implementationVersion"] + "-patch1"
            elif mode == "removed":
                definitions = [d for d in definitions if d["toolId"] != tool]
            await ctx.update_host(tools=tools, definitions=definitions)

        plan.hook("after_prepare", change)
        return plan, tool_executed(tool)


TOOL_CHANGED = ToolChanged(
    "F5.tool_binding_changed_after_plan",
    "F5",
    "Approved tool implementation changed after the plan was frozen",
    "After a ready plan exists, the host's implementation of one approved tool is disabled, "
    "retargeted, re-bounded, re-versioned or removed.",
    "A plan binds one exact implementation (by digest); a different one is never substituted.",
    "revalidation",
    "revalidate",
    ("tool_bindings", "tool_binding_changed", "tool_unavailable", "tool_binding_removed"),
    "The tool executes through the changed (or no longer approved) implementation.",
    "The same binding relabelled after the plan (labels are not part of its identity).",
    "finite",
    LR,
    "minus_plan_revalidation",
    "binding digest",
    "tool binding changed after plan",
)


def _replacement(env: Env, package: str, mode: str) -> bytes:
    original = env.archive(package)
    if mode == "other_release":
        return env.historical(HISTORICAL[package])
    if mode == "byte_flip":
        data = bytearray(original)
        data[len(data) // 2] ^= 0x01
        return bytes(data)
    return original[: len(original) // 2]


class SnapshotRewritten(Template):
    MODES = (
        ("other_release", "replaced in place by another signed release of the same package"),
        ("byte_flip", "one byte flipped in place"),
        ("truncated", "truncated in place"),
    )
    POINT = "snapshot"

    def variants(self, package, env, rng, budget):
        return [
            self.variant(
                package, mode, {"mode": mode}, f"the session's frozen {self.POINT} is {description}"
            )
            for mode, description in self.MODES
        ]

    def plan(self, variant, kind, env):
        plan = base_plan(env, variant.package)
        if kind == "violation":
            data = _replacement(env, variant.package, variant.params["mode"])

            async def rewrite(ctx):
                path = ctx.control._session(ctx.session_id).snapshot_path
                os.chmod(path, stat.S_IRUSR | stat.S_IWUSR)
                path.write_bytes(data)
                ctx.record("snapshot.rewritten", bytes=len(data))

            plan.hook("after_prepare", rewrite)
        return plan, B.executed


SNAPSHOT_REWRITTEN = SnapshotRewritten(
    "F5.snapshot_rewritten",
    "F5",
    "Frozen package snapshot changed after the plan",
    "After a ready plan exists, the control plane's private snapshot of the package is "
    "rewritten in place (another valid release, a flipped byte, or a truncation).",
    "The bytes that run are byte-for-byte the bytes that were verified and authorized.",
    "revalidation",
    "revalidate",
    ("snapshot_unstable",),
    "Package instructions start executing from the changed bytes.",
    "The same plan with the snapshot untouched.",
    "finite",
    BOTH,
    "minus_plan_revalidation",
    "snapshot identity",
    "package bytes changed after plan",
)


class LeaseRewritten(SnapshotRewritten):
    POINT = "execution lease"

    def plan(self, variant, kind, env):
        plan = base_plan(env, variant.package)
        if kind == "violation":
            data = _replacement(env, variant.package, variant.params["mode"])

            async def arm(ctx):
                ctx.lease_rewrite = data

            plan.hook("before_start", arm)
        return plan, B.executed


LEASE_REWRITTEN = LeaseRewritten(
    "F5.lease_rewritten",
    "F5",
    "Leased package bytes changed before the runner read them",
    "The one-time lease the host opened for the runner is rewritten in place after the "
    "lease was issued and before the runner reads it.",
    "The runner executes only the bytes the plan names (archive hash, digest, signer).",
    "revalidation",
    "revalidate",
    ("execution_artifact_mismatch",),
    "Package instructions start executing from the changed bytes.",
    "The same run with the lease untouched.",
    "finite",
    BOTH,
    "minus_plan_revalidation",
    "runner re-verification",
    "leased bytes substituted",
)


class StalePlanReference(Template):
    MODES = (
        ("superseded_plan", "Run names the session's previous plan after it was re-prepared"),
        ("wrong_sha", "Run names the current plan id with a different plan hash"),
        ("foreign_plan", "Run names a plan prepared in another session"),
    )

    def variants(self, package, env, rng, budget):
        return [
            self.variant(package, mode, {"mode": mode}, description)
            for mode, description in self.MODES
        ]

    def plan(self, variant, kind, env):
        plan = base_plan(env, variant.package)
        if kind == "control":
            return plan, B.executed
        mode = variant.params["mode"]

        async def stage(ctx):
            first = dict(ctx.plan_ref)
            if mode == "superseded_plan":
                await ctx.page(
                    "hooks",
                    "prepareRunPlan",
                    ctx.session_id,
                    ctx.digest,
                    ctx.receipt_id,
                    plan.model_id,
                )
                state = ctx.control.run_plan(ctx.session_id)["run_plan"]
                ctx.plan_ref = {
                    "run_plan_id": state["run_plan_id"],
                    "run_plan_sha256": state["run_plan_sha256"],
                }
                ctx.stale_ref = first
            elif mode == "wrong_sha":
                ctx.stale_ref = {"run_plan_id": first["run_plan_id"], "run_plan_sha256": "0" * 64}
            else:
                other = ctx.dir / "packages" / "second.agent.pkg"
                other.write_bytes(plan.archive)
                opened = await ctx.page("hooks", "openLocal", str(other))
                sid = opened["value"]["sessionId"]
                decisions, approvals = _decisions(plan)
                await ctx.page("hooks", "authorize", sid, ctx.digest, decisions, approvals)
                receipt = ctx.control.authorization(sid)["receipt_id"]
                await ctx.page("hooks", "prepareRunPlan", sid, ctx.digest, receipt, plan.model_id)
                state = ctx.control.run_plan(sid)["run_plan"]
                ctx.stale_ref = {
                    "run_plan_id": state["run_plan_id"],
                    "run_plan_sha256": state["run_plan_sha256"],
                }

        def override(start, ctx):
            return {**start, **ctx.stale_ref}

        plan.hook("after_prepare", stage)
        plan.start_override = override
        return plan, B.executed


STALE_PLAN = StalePlanReference(
    "F5.stale_plan_reference",
    "F5",
    "Run started against a plan other than the session's current one",
    "Run names a superseded plan, a wrong plan hash, or another session's plan.",
    "Run acts only on the exact plan (id and hash) the caller read and the session holds.",
    "revalidation",
    "revalidate",
    ("run_plan_identity",),
    "Package instructions start executing although the requested plan is not the session's plan.",
    "Run naming the session's current plan.",
    "finite",
    BOTH,
    "minus_plan_revalidation",
    "Run Plan identity",
    "stale plan reference",
)

TEMPLATES = (
    REAUTHORIZED,
    TRUST_WITHDRAWN,
    MODEL_CHANGED,
    TOOL_CHANGED,
    SNAPSHOT_REWRITTEN,
    LEASE_REWRITTEN,
    STALE_PLAN,
)
_ = (oracle, host)
