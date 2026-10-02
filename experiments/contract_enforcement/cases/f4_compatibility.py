"""F4 — requirements and compatibility: a package runs only where its declarations are met.

Requirements are not permissions: every case here grants every permission and
approval, and changes only what the host offers.
"""

from __future__ import annotations

import copy
import json

from harness import oracle
from harness.paths import ROOT
from harness.world import PLANNED_MODEL, experiment_definitions, model_host

from . import boundaries as B
from .base import Template, base_plan, edit_json, host, payload, publisher_pin, resigned_plan

BOTH = ("meeting-agenda", "literature-review")
LR = ("literature-review",)
TOOLS = ("scholarly-search", "citation-resolver", "paper-reader")
TOOL_PATH = {"scholarly-search": "/works", "citation-resolver": "/resolve"}


def _qwen(spec: dict) -> dict:
    return next(row for row in spec["rows"] if row["id"] == "qwen3:30b")


def model_used(obs) -> bool:
    """A completion was dispatched to the host model runtime at all."""
    return bool(oracle.model_dispatches(obs))


def tool_executed(tool: str):
    def predicate(obs) -> bool:
        if tool == "paper-reader":
            return B.document_read(obs)
        return any(
            item["path"] == TOOL_PATH[tool] or not item["authorized"]
            for item in oracle.transports(obs)
        )

    predicate.__name__ = f"tool_executed[{tool}]"
    return predicate


class ContextInsufficient(Template):
    FIXED = (15999, 12000, 8192, 4096)

    def variants(self, package, env, rng, budget):
        values = list(self.FIXED)
        while len(values) < max(budget, len(self.FIXED)):
            candidate = rng.randrange(1024, 15999)
            if candidate not in values:
                values.append(candidate)
        # The declared requirement (16000) is below what the calls reserve (input
        # bound plus the declared output cap), so the boundary control is the
        # smallest context the calibrated run actually needs, not 16000.
        need = env.calibrated(package)["usage"]["max_reservation"]
        minimal = max(16000, -(-need // 1024) * 1024)
        out = []
        for index, value in enumerate(values[: max(budget, 1)]):
            field = "contextTokens" if index % 2 == 0 else "contextWindow_only"
            control = minimal if value == 15999 else 65536
            out.append(
                self.variant(
                    package,
                    f"{field}-{value}",
                    {"field": field, "value": value},
                    f"the planned model reports a {value}-token context ({field}); the package "
                    "needs 16000",
                    control_params={"field": field, "value": control},
                    control_description=(
                        f"the same model reporting {control} tokens"
                        + (
                            " (the smallest context the calibrated calls need)"
                            if control == minimal
                            else ""
                        )
                    ),
                )
            )
        return out

    def plan(self, variant, kind, env):
        params = variant.control_params if kind == "control" else variant.params
        spec = model_host()
        row = _qwen(spec)
        if params["field"] == "contextTokens":
            row["contextTokens"] = params["value"]
        else:
            row.pop("contextTokens", None)
            row["contextWindow"] = params["value"]
        return base_plan(env, variant.package, host=host(model_host=spec)), model_used


CONTEXT_INSUFFICIENT = ContextInsufficient(
    "F4.model_context_insufficient",
    "F4",
    "Selected model's context window below the package requirement",
    "The host's descriptor for the selected model reports fewer context tokens than the "
    "package's model requirements declare.",
    "The bound model satisfies every declared hard requirement.",
    "compatibility",
    "compatibility",
    ("model_incompatible",),
    "A completion is dispatched to the model that does not meet the requirement.",
    "The same model reporting a sufficient context window (at the boundary: the smallest "
    "context the calibrated calls reserve).",
    "parametric",
    BOTH,
    "minus_compatibility",
    "model requirements",
    "insufficient context window",
)


class CapabilityMissing(Template):
    MODES = (
        ("reasoning_false", "the catalog declares reasoning=false for the selected model"),
        ("reasoning_absent", "the catalog states nothing about reasoning for the selected model"),
    )

    def variants(self, package, env, rng, budget):
        return [
            self.variant(package, mode, {"mode": mode}, description)
            for mode, description in self.MODES
        ]

    def plan(self, variant, kind, env):
        spec = model_host()
        if kind == "violation":
            row = _qwen(spec)
            if variant.params["mode"] == "reasoning_false":
                row["reasoning"] = False
            else:
                row.pop("reasoning", None)
        return base_plan(env, variant.package, host=host(model_host=spec)), model_used


CAPABILITY_MISSING = CapabilityMissing(
    "F4.model_capability_missing",
    "F4",
    "Selected model lacks (or does not confirm) a required capability",
    "The selected model is declared not to support reasoning, or its catalog row is silent "
    "about it, while every package task requires it.",
    "A capability the host cannot confirm is not assumed.",
    "compatibility",
    "compatibility",
    ("model_incompatible", "model_compatibility_unverified"),
    "A completion is dispatched to the model that does not (verifiably) meet the requirement.",
    "The same model declaring the capability.",
    "finite",
    BOTH,
    "minus_compatibility",
    "model requirements",
    "required capability missing",
)


class ModelNotOffered(Template):
    MODES = (
        ("not_routable", "the selected model's row exists but OpenClaw cannot route it"),
        (
            "override_not_allowed",
            "the plugin may not request an exact model (allowModelOverride off)",
        ),
        ("not_allowlisted", "the plugin's model allowlist excludes the selected model"),
        ("deprecated", "the selected model's catalog status is deprecated"),
        ("disabled", "the selected model's catalog status is disabled"),
    )

    def variants(self, package, env, rng, budget):
        return [
            self.variant(package, mode, {"mode": mode}, description)
            for mode, description in self.MODES
        ]

    def plan(self, variant, kind, env):
        spec = model_host()
        if kind == "violation":
            mode = variant.params["mode"]
            if mode == "not_routable":
                spec["routable"]["ollama"] = [
                    m for m in spec["routable"]["ollama"] if m != "qwen3:30b"
                ]
                spec["picker"] = copy.deepcopy(spec["routable"])
            elif mode == "override_not_allowed":
                spec["plugin_llm"] = {"allowModelOverride": False}
            elif mode == "not_allowlisted":
                spec["plugin_llm"] = {
                    "allowModelOverride": True,
                    "allowedModels": ["ollama/llama3.1:8b"],
                }
            else:
                _qwen(spec)["status"] = mode
        return base_plan(env, variant.package, host=host(model_host=spec)), model_used


MODEL_NOT_OFFERED = ModelNotOffered(
    "F4.model_not_offered",
    "F4",
    "Selected model not usable on this host",
    "The model the person selects is listed but not routable, not permitted to the plugin, "
    "or retired.",
    "A plan binds only a model the host can actually invoke for this plugin.",
    "compatibility",
    "compatibility",
    ("model_unknown", "model_unavailable", "model_not_selectable"),
    "A completion is dispatched for a model the host does not offer.",
    "The same model offered by the host.",
    "finite",
    BOTH,
    "minus_compatibility",
    "host model availability",
    "model not offered by host",
)


class ToolUnbound(Template):
    def variants(self, package, env, rng, budget):
        out = []
        for tool in TOOLS:
            out.append(
                self.variant(
                    package,
                    f"{tool}-disabled",
                    {"tool": tool, "mode": "disabled"},
                    f"the operator disables the {tool} binding",
                )
            )
            out.append(
                self.variant(
                    package,
                    f"{tool}-absent",
                    {"tool": tool, "mode": "absent"},
                    f"this host ships no implementation of {tool}",
                )
            )
        out.append(
            self.variant(
                package,
                "broker-disabled",
                {"tool": "scholarly-search", "mode": "broker_disabled"},
                "the operator disables the host tool broker entirely",
            )
        )
        return out

    def plan(self, variant, kind, env):
        tool, mode = variant.params["tool"], variant.params["mode"]
        definitions = experiment_definitions(env.built_in_bindings)
        tools = None
        if kind == "violation":
            if mode == "disabled":
                tools = {"bindings": [{"toolId": tool, "enabled": False}]}
            elif mode == "absent":
                definitions = [d for d in definitions if d["toolId"] != tool]
            else:
                tools = {"enabled": False}
        plan = base_plan(env, variant.package, host=host(tools=tools, definitions=definitions))
        return plan, tool_executed(tool)


TOOL_UNBOUND = ToolUnbound(
    "F4.tool_unbound",
    "F4",
    "Declared tool without a usable host implementation",
    "Every permission and approval is granted, but the host offers no enabled implementation "
    "of one declared tool (or of any).",
    "Every declared tool is bound to an enabled host implementation before anything runs.",
    "compatibility",
    "compatibility",
    ("tool_unavailable", "tool_not_bound"),
    "The tool's (absent or disabled) implementation executes.",
    "Every declared tool bound to its enabled built-in implementation.",
    "finite",
    LR,
    "minus_compatibility",
    "tool binding",
    "tool unavailable on host",
)


class ToolContract(Template):
    MUTATIONS = (
        ("input_digest", "the binding declares a different input-schema digest"),
        ("output_digest", "the binding declares a different output-schema digest"),
        ("no_digests", "the binding declares no schema digests"),
        ("binding_name", "the binding implements a different capability name"),
        ("side_effects", "the binding declares write side effects"),
        ("permission_kinds", "the binding travels under a different permission kind"),
        ("origin", "the operator points the binding at a different origin"),
        ("path", "the operator points the binding at a different path"),
        ("method", "the operator changes the binding's HTTP method"),
        ("ambiguous", "the host registers two implementations of the tool"),
    )
    REMOTE_ONLY = {"origin", "path", "method"}

    def variants(self, package, env, rng, budget):
        out = []
        for tool in TOOLS:
            for mutation, description in self.MUTATIONS:
                if tool == "paper-reader" and mutation in self.REMOTE_ONLY:
                    continue
                out.append(
                    self.variant(
                        package,
                        f"{tool}-{mutation}",
                        {"tool": tool, "mutation": mutation},
                        f"{tool}: {description}",
                    )
                )
        return out

    def plan(self, variant, kind, env):
        tool, mutation = variant.params["tool"], variant.params["mutation"]
        definitions = experiment_definitions(env.built_in_bindings)
        tools = None
        if kind == "violation":
            target = next(d for d in definitions if d["toolId"] == tool)
            if mutation == "input_digest":
                target["inputSchemaSha256"] = "0" * 64
            elif mutation == "output_digest":
                target["outputSchemaSha256"] = "f" * 64
            elif mutation == "no_digests":
                target["inputSchemaSha256"] = None
                target["outputSchemaSha256"] = None
            elif mutation == "binding_name":
                target["binding"] = target["binding"] + ".v2"
            elif mutation == "side_effects":
                target["sideEffects"] = "write"
            elif mutation == "permission_kinds":
                target["permissionKinds"] = (
                    ["network"] if tool == "paper-reader" else ["files.read"]
                )
            elif mutation == "origin":
                tools = {"bindings": [{"toolId": tool, "origin": "https://mirror.example.org"}]}
            elif mutation == "path":
                tools = {"bindings": [{"toolId": tool, "path": TOOL_PATH[tool] + "-v2"}]}
            elif mutation == "method":
                method = "GET" if target.get("method") == "POST" else "POST"
                tools = {"bindings": [{"toolId": tool, "method": method}]}
            elif mutation == "ambiguous":
                twin = copy.deepcopy(target)
                twin["id"] = target["id"] + ":twin"
                definitions.append(twin)
        plan = base_plan(env, variant.package, host=host(tools=tools, definitions=definitions))
        return plan, tool_executed(tool)


TOOL_CONTRACT = ToolContract(
    "F4.tool_contract_mismatch",
    "F4",
    "Host tool implementation does not match the declared contract",
    "The host's implementation of a declared tool differs from the package's signed "
    "declaration: schema digests, capability name, side effects, permission class, "
    "destination, method, or more than one candidate.",
    "The bound implementation speaks exactly the contract the package declared.",
    "compatibility",
    "compatibility",
    ("tool_contract_mismatch", "tool_contract_unverified", "tool_binding_ambiguous"),
    "The mismatched implementation executes.",
    "The tool's exact built-in implementation.",
    "finite",
    LR,
    "minus_compatibility",
    "tool contract",
    "binding contract mismatch",
)


class HostRuntime(Template):
    VERSIONS = ("2026.9.4", "2026.10.0", "2027.1.0")

    def variants(self, package, env, rng, budget):
        return [
            self.variant(
                package,
                version,
                {"version": version},
                f"the OpenClaw host reports release {version}",
            )
            for version in self.VERSIONS
        ]

    def plan(self, variant, kind, env):
        spec = model_host()
        if kind == "violation":
            spec["runtime_version"] = variant.params["version"]
        return base_plan(env, variant.package, host=host(model_host=spec)), B.executed


HOST_RUNTIME = HostRuntime(
    "F4.host_runtime_unverified",
    "F4",
    "Host runtime release the accounting was not verified against",
    "The OpenClaw host reports a release other than the one the plugin's token accounting "
    "was verified on, with the default policy that requires a verified host.",
    "Execution runs only on the host release whose accounting the contract was verified against.",
    "compatibility",
    "revalidate",
    ("host_runtime",),
    "Package instructions start executing on the unverified host.",
    "The verified OpenClaw release (2026.9.5).",
    "finite",
    BOTH,
    "minus_compatibility",
    "host runtime check",
    "unverified host release",
)


class RuntimeTooOld(Template):
    VERSIONS = ("0.2.3", "0.3.0", "1.0.0")

    def variants(self, package, env, rng, budget):
        return [
            self.variant(
                package,
                f"min-{version}",
                {"minimum_version": version},
                f"a trusted package requiring agentpkg >= {version} (installed: 0.2.2)",
            )
            for version in self.VERSIONS
        ]

    def plan(self, variant, kind, env):
        files = payload(env, variant.package)
        if kind == "violation":

            def bump(manifest):
                manifest["runtime"]["minimum_version"] = variant.params["minimum_version"]

            files = edit_json(files, "MANIFEST.agent", bump)
        return resigned_plan(env, variant.package, files), B.prepared_or_executed


RUNTIME_TOO_OLD = RuntimeTooOld(
    "F4.runtime_too_old",
    "F4",
    "Package requires a newer runtime than the host has",
    "A trusted, validly signed package declares a minimum runtime version above the "
    "installed agentpkg.",
    "A package runs only on a runtime that meets its declared minimum version.",
    "compatibility",
    "verify",
    ("runtime_minimum_version",),
    "The package reaches a ready Run Plan, a lease or execution.",
    "The same trusted package declaring the installed minimum version.",
    "finite",
    BOTH,
    "minus_compatibility",
    "runtime version requirement",
    "runtime too old",
)


class ExecutionProfile(Template):
    def variants(self, package, env, rng, budget):
        return [
            self.variant(
                package,
                "legacy_profile",
                {"artifact": "literature-review-legacy.agent.pkg"},
                "the archived pre-workflow.v0 Literature Review artifact (signed, publisher "
                "pinned)",
            )
        ]

    def plan(self, variant, kind, env):
        if kind == "control":
            return base_plan(env, variant.package), B.prepared_or_executed
        from harness.plan import Pin

        pem = (ROOT / "examples/keys/publisher.pub.pem").read_bytes()
        plan = base_plan(env, variant.package, archive=env.historical(variant.params["artifact"]))
        plan.pins = [publisher_pin(env, variant.package), Pin(pem, "Legacy publisher", None, None)]
        return plan, B.prepared_or_executed


EXECUTION_PROFILE = ExecutionProfile(
    "F4.execution_profile_unsupported",
    "F4",
    "Package for an execution profile this host does not install",
    "A real, signed and trusted artifact whose entrypoint is a profile other than workflow.v0.",
    "A package executes only under an installed execution profile.",
    "compatibility",
    "compatibility",
    ("execution_profile_unsupported",),
    "The package reaches a ready Run Plan, a lease or execution.",
    "The current workflow.v0 artifact of the same package.",
    "finite",
    LR,
    "minus_compatibility",
    "execution profile",
    "unsupported execution profile",
)

TEMPLATES = (
    CONTEXT_INSUFFICIENT,
    CAPABILITY_MISSING,
    MODEL_NOT_OFFERED,
    TOOL_UNBOUND,
    TOOL_CONTRACT,
    HOST_RUNTIME,
    RUNTIME_TOO_OLD,
    EXECUTION_PROFILE,
)
_ = (json, PLANNED_MODEL)
