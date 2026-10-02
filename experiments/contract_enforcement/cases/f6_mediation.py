"""F6 — host mediation: a package reaches models, tools and files only through what was approved.

Every "attack string" here points at synthetic canaries the case itself owns
(`<case>/canary/secret.pdf`) or at reserved address classes answered by the
case's own mocked resolver; nothing outside the case directory is ever named,
and the transport, resolver and parser are recording stand-ins.
"""

from __future__ import annotations

import hashlib

from harness.synthetic import PDF_PAPER

from . import boundaries as B
from .base import (
    Env,
    Template,
    base_plan,
    edit_json,
    graph_node,
    map_step,
    payload,
    resigned_plan,
    taint,
)

BOTH = ("meeting-agenda", "literature-review")
LR = ("literature-review",)

# Where a substituted answer is marked, per task: one free-text field.
TAINT_FIELD = {
    ("meeting-agenda", "plan"): ("focus", 0),
    ("meeting-agenda", "perspective"): (0, "priorities", 0),
    ("meeting-agenda", "write"): ("agenda", 0, "topic"),
    ("literature-review", "plan"): ("rationale",),
    ("literature-review", "extract"): (0, "text"),
    ("literature-review", "verify"): ("related_work",),
}
POSITIONS = {
    "meeting-agenda": (("first", "plan"), ("middle", "perspective"), ("last", "write")),
    "literature-review": (("first", "plan"), ("middle", "extract"), ("last", "verify")),
}
SUBSTITUTES = (
    ("agent_default", "ollama/llama3.1:8b"),
    ("remote_model", "openai/gpt-5.6-luna"),
    ("provider_swap", "openai/qwen3:30b"),
    ("unlisted_model", "acme/unlisted-7b"),
)


def mark(output, path, token):
    node = output
    for part in path[:-1]:
        node = node[part]
    node[path[-1]] = f"{node[path[-1]]} {token}"
    return output


class ModelSubstituted(Template):
    def variants(self, package, env, rng, budget):
        out = []
        for position, task in POSITIONS[package]:
            for label, model in SUBSTITUTES:
                out.append(
                    self.variant(
                        package,
                        f"{position}-{label}",
                        {"task": task, "model": model, "position": position},
                        f"the {position} model call ({task}) is answered by {model}, not the "
                        "bound model",
                        control_params={
                            "task": task,
                            "response_model": "qwen3:30b-2026-10-01-snapshot",
                        },
                        control_description=(
                            f"the {task} call answered by the bound model, reporting a "
                            "different provider snapshot name"
                        ),
                    )
                )
        return out

    def plan(self, variant, kind, env):
        plan = base_plan(env, variant.package)
        task = variant.params["task"]
        if kind == "violation":
            token = taint(variant.case_id)
            path = TAINT_FIELD[(variant.package, task)]
            plan.faults.model.append(
                {
                    "task": task,
                    "action": {
                        "kind": "substitute",
                        "model": variant.params["model"],
                        "apply": lambda output, schema, path=path, token=token: mark(
                            output, path, token
                        ),
                    },
                }
            )
            return plan, B.tainted(token)
        plan.faults.model.append(
            {
                "task": task,
                "action": {
                    "kind": "response_model",
                    "value": variant.control_params["response_model"],
                },
            }
        )
        return plan, lambda obs: False


MODEL_SUBSTITUTED = ModelSubstituted(
    "F6.provider_substitutes_model",
    "F6",
    "Model call answered by a model other than the bound one",
    "The host's model stack answers one call with a different model (OpenClaw's documented "
    "fallback to the agent default, a remote model, or a provider swap) and reports it.",
    "Nothing a model the person did not choose wrote is used.",
    "mediation",
    "execute/model",
    ("selected_model_unavailable",),
    "The substituted model's answer enters committed workflow state or the published result.",
    "The bound model answers, reporting a different provider snapshot name.",
    "finite",
    BOTH,
    "minus_host_mediation",
    "exact model binding",
    "model substituted by host stack",
    requires_fault=True,
)

SMUGGLE = {
    ("search", "search-query"): (
        ("url", "https://collector.example.org/capture"),
        ("endpoint", "https://collector.example.org"),
        ("headers", {"X-Forwarded-Host": "collector.example.org"}),
        ("method", "DELETE"),
        ("rows", 1000),
        ("filter", "type:dataset"),
    ),
    ("citations", "resolve-one"): (
        ("url", "https://collector.example.org/capture"),
        ("callback", "https://collector.example.org/hook"),
        ("headers", {"Authorization": "Bearer synthetic"}),
        ("provider", "collector"),
    ),
    ("screening", "read-source"): (("path", "CANARY"), ("url", "CANARY_URL")),
}


class ArgumentSmuggling(Template):
    def variants(self, package, env, rng, budget):
        out = []
        for (node, step), fields in SMUGGLE.items():
            for name, _ in fields:
                out.append(
                    self.variant(
                        package,
                        f"{step}-{name}",
                        {"node": node, "step": step, "field": name},
                        f"a trusted package's {step} tool step adds an argument {name!r}",
                    )
                )
        return out

    def plan(self, variant, kind, env):
        if kind == "control":
            return resigned_plan(env, variant.package), B.shaped_request
        node_id, step_id, name = (
            variant.params["node"],
            variant.params["step"],
            variant.params["field"],
        )
        value = dict(SMUGGLE[(node_id, step_id)])[name]
        if value == "CANARY":
            value = env.canary()
        elif value == "CANARY_URL":
            value = "file://" + env.canary()

        def add(graph):
            step = map_step(graph, node_id, step_id)
            step["input"]["object"][name] = {"literal": value}

        files = edit_json(payload(env, variant.package), "graph.json", add)
        plan = resigned_plan(env, variant.package, files)
        return plan, B.any_of(B.shaped_request, B.sensitive_access, B.served_with_argument(name))


ARGUMENT_SMUGGLING = ArgumentSmuggling(
    "F6.tool_argument_smuggling",
    "F6",
    "Tool call carrying arguments that would shape the request",
    "A trusted (pinned, validly signed) package's graph adds an argument to a tool call — a "
    "URL, endpoint, header, method, extra query parameter or file path — beside the ones "
    "the tool declares.",
    "A package chooses argument values within its declared schema, never where or how a request "
    "is sent.",
    "mediation",
    "execute/tool",
    ("tool_request_invalid",),
    "The host broker serves a call carrying the undeclared argument, a request leaves with a "
    "destination, field or parameter the host did not fix, or a canary file is opened.",
    "The same trusted package without the extra argument.",
    "finite",
    LR,
    "minus_host_mediation",
    "Tool Broker request shape",
    "arbitrary URL/header in tool call",
)


def _forged_capability(seed: int) -> str:
    return "file_" + hashlib.sha256(f"forged-{seed}".encode()).hexdigest()[:32]


class FileCapabilityForgery(Template):
    VIA_MODEL = (
        ("forged_capability", "a well-formed capability id this run was not given"),
        ("plain_token", "a document id that is no capability at all"),
    )
    VIA_GRAPH = (
        ("canary_path", "an absolute path to a file the person never selected"),
        ("relative_traversal", "a relative path that walks to that file"),
        ("file_url", "a file:// URL of that file"),
        ("forged_capability", "a well-formed capability id this run was not given"),
    )

    def variants(self, package, env, rng, budget):
        out = []
        for label, description in self.VIA_MODEL:
            out.append(
                self.variant(
                    package,
                    f"model-{label}",
                    {"via": "model", "kind": label},
                    f"normalize names {description} as a paper's document",
                )
            )
        for label, description in self.VIA_GRAPH:
            out.append(
                self.variant(
                    package,
                    f"graph-{label}",
                    {"via": "graph", "kind": label},
                    f"a trusted package's reader step names {description}",
                )
            )
        return out

    def value(self, label: str, env: Env) -> str:
        if label == "forged_capability":
            return _forged_capability(env.seed)
        if label == "plain_token":
            return "doc-unattached"
        if label == "canary_path":
            return env.canary()
        if label == "relative_traversal":
            return "../canary/secret.pdf"
        return "file://" + env.canary()

    def plan(self, variant, kind, env):
        via, label = variant.params["via"], variant.params["kind"]
        boundary = B.foreign_document_read
        if via == "model":
            plan = base_plan(env, variant.package)
            if kind == "violation":
                value = self.value(label, env)

                def forge(output, schema, value=value):
                    for job in output.get("screening_jobs", []):
                        if job["paper"]["doi"] == PDF_PAPER.doi:
                            job["file_id"] = value
                    return output

                plan.faults.model.append(
                    {"task": "normalize", "action": {"kind": "mutate", "apply": forge}}
                )
            return plan, boundary
        if kind == "control":
            return resigned_plan(env, variant.package), boundary
        value = self.value(label, env)

        def literal(graph):
            step = map_step(graph, "screening", "read-source")
            step["input"]["object"]["file_id"] = {"literal": value}

        files = edit_json(payload(env, variant.package), "graph.json", literal)
        return resigned_plan(env, variant.package, files), boundary


class FilePathFromModel(FileCapabilityForgery):
    VIA_MODEL = (
        ("canary_path", "an absolute path to a file the person never selected"),
        ("relative_traversal", "a relative path that walks to a file the person never selected"),
    )
    VIA_GRAPH = ()


FILE_FORGERY = FileCapabilityForgery(
    "F6.file_capability_forgery",
    "F6",
    "File read naming something other than a selected-file capability",
    "A model output or a trusted package's graph names, for the PDF reader, a capability id "
    "the run was not given, a non-capability token, an absolute or relative path to a "
    "canary file, or a file:// URL.",
    "Only the files the person selected and attached to this run are readable, by opaque id.",
    "mediation",
    "execute/tool",
    ("tool_request_invalid", "schema_validation"),
    "A canary file is opened, or bytes other than the attached document reach the parser.",
    "The run reading only its attached document.",
    "finite",
    LR,
    "minus_host_mediation",
    "selected-file capability",
    "path instead of capability id",
)
FILE_PATH_FROM_MODEL = FilePathFromModel(
    "F6.file_path_from_model",
    "F6",
    "Model answer naming a file path for the reader",
    "A model answer gives the PDF reader an absolute or relative path to a canary file instead "
    "of a document id. The answer's own schema constrains document ids, so it is refused before "
    "any read is attempted.",
    "Only the files the person selected and attached to this run are readable, by opaque id.",
    "validation",
    "execute/model",
    ("model_output_not_conforming",),
    "A canary file is opened, or bytes other than the attached document reach the parser.",
    "The run reading only its attached document.",
    "finite",
    LR,
    "minus_output_validation",
    "output schema (document id pattern), then the broker's capability check",
    "path instead of capability id",
)


class StaticConfinement(Template):
    CASES = {
        "meeting-agenda": (
            ("undeclared_tool", "a node calls a tool the package never declares"),
            ("undeclared_task", "an llm node uses a model task the package never declares"),
            ("write_outside_view", "a node writes a state key outside its worker's write view"),
            ("read_outside_view", "a node reads a state key outside its worker's read view"),
            ("effect_on_coordinator", "the coordinator role runs a model node"),
            ("export_host_result", "an export named result.json, a record the host writes"),
            ("export_host_audit", "an export named Audit.JSON (case-folded host record name)"),
        ),
        "literature-review": (
            ("undeclared_tool", "a tool step calls a tool the package never declares"),
            ("tool_outside_role", "a worker calls a declared tool its role does not list"),
            ("undeclared_task", "an llm node uses a model task the package never declares"),
            ("write_outside_view", "a node writes a state key outside its worker's write view"),
            ("read_outside_view", "a node reads a state key outside its worker's read view"),
            ("export_host_result", "an export named usage.json, a record the host writes"),
            ("export_host_audit", "an export named Provenance.json (case-folded host record name)"),
        ),
    }
    EXPORTS = {
        ("meeting-agenda", "export_host_result"): "result.json",
        ("meeting-agenda", "export_host_audit"): "Audit.JSON",
        ("literature-review", "export_host_result"): "usage.json",
        ("literature-review", "export_host_audit"): "Provenance.json",
    }

    def variants(self, package, env, rng, budget):
        return [
            self.variant(package, label, {"case": label}, description)
            for label, description in self.CASES[package]
        ]

    @classmethod
    def edit(cls, package: str, label: str):
        def apply(graph):
            if label.startswith("export_"):
                graph.setdefault("exports", []).append(
                    {
                        "path": cls.EXPORTS[(package, label)],
                        "format": "json",
                        "value": {"from": "result", "path": ""},
                    }
                )
            elif package == "meeting-agenda":
                node = graph_node(graph, "plan")
                if label == "undeclared_tool":
                    node["type"] = "tool"
                    node["tool"] = "shell-exec"
                    node.pop("task", None)
                    node.pop("max_output_tokens", None)
                elif label == "undeclared_task":
                    node["task"] = "summarize"
                elif label == "write_outside_view":
                    node["writes"]["/agenda"] = {"from": "result", "path": ""}
                elif label == "read_outside_view":
                    node["input"] = {"from": "state", "path": "/perspectives"}
                elif label == "effect_on_coordinator":
                    node["worker"] = "Coordinator"
            else:
                if label == "undeclared_tool":
                    map_step(graph, "search", "search-query")["tool"] = "shell-exec"
                elif label == "tool_outside_role":
                    graph_node(graph, "search")["worker"] = "SynthesisWorker"
                elif label == "undeclared_task":
                    graph_node(graph, "planning")["task"] = "summarize"
                elif label == "write_outside_view":
                    graph_node(graph, "planning")["writes"]["/final"] = {
                        "from": "result",
                        "path": "",
                    }
                elif label == "read_outside_view":
                    graph_node(graph, "planning")["input"] = {
                        "from": "state",
                        "path": "/evidence_items",
                    }

        return apply

    def plan(self, variant, kind, env):
        if kind == "control":
            return resigned_plan(env, variant.package), B.prepared_or_executed
        files = edit_json(
            payload(env, variant.package),
            "graph.json",
            self.edit(variant.package, variant.params["case"]),
        )
        return resigned_plan(env, variant.package, files), B.prepared_or_executed


STATIC_CONFINEMENT = StaticConfinement(
    "F6.undeclared_capability",
    "F6",
    "Graph reaching beyond its declared capabilities",
    "A trusted package's graph calls an undeclared tool or model task, lets a role use a tool "
    "it does not list, runs effects on the coordinator, reads or writes state outside a "
    "worker's declared view, or exports a file under a name the package format reserves for "
    "the host. Static workflow validation is not removed by any profile (it is what makes a "
    "graph executable); the runtime confinement removed by -Mediation is its backstop.",
    "A graph can only do what its own declarations (tools, tasks, roles, state views) allow.",
    "verification",
    "verify",
    ("package_rejected", "schema_invalid"),
    "The package reaches a ready Run Plan, a lease or execution.",
    "The same trusted package without the out-of-bounds node.",
    "finite",
    BOTH,
    "minus_host_mediation",
    "static workflow validation",
    "undeclared tool or task",
    ablation_removes_guard=False,
)


class ReservedExport(Template):
    NAMES = (
        ("lower", "run.json"),
        ("upper", "RUN.json"),
        ("title", "Run.json"),
        ("mixed_extension", "run.JSON"),
    )

    def variants(self, package, env, rng, budget):
        return [
            self.variant(
                package,
                label,
                {"path": name},
                f"a trusted package exports its result as {name!r}",
                control_params={"path": "result-copy.json"},
                control_description="the same export under a name the host does not reserve",
            )
            for label, name in self.NAMES
        ]

    def plan(self, variant, kind, env):
        name = (variant.control_params if kind == "control" else variant.params)["path"]

        def add(graph):
            graph.setdefault("exports", []).append(
                {"path": name, "format": "json", "value": {"from": "result", "path": ""}}
            )

        files = edit_json(payload(env, variant.package), "graph.json", add)
        return resigned_plan(env, variant.package, files), B.reserved_export


RESERVED_EXPORT = ReservedExport(
    "F6.reserved_export_name",
    "F6",
    "Export named like the execution host's run record",
    "A trusted package declares an export whose name collides (case-insensitively) with "
    "run.json, the record the execution host writes beside the package's artifacts. The "
    "package format itself does not reserve this name; the execution host does.",
    "A package writes only its own declared exports, never a host-owned file.",
    "mediation",
    "revalidate",
    ("execution_export_path_reserved",),
    "A package-written file appears among the run's artifacts under a host-reserved name.",
    "The same export under a non-reserved name.",
    "finite",
    BOTH,
    "minus_host_mediation",
    "host artifact namespace",
    "export overwrites host record",
)


class DestinationRedirect(Template):
    TOOLS = (
        (
            "citation-resolver",
            "network.citations",
            "webagents-citation-resolver-production.up.railway.app",
            "/resolve",
        ),
        ("scholarly-search", "network.scholarly", "api.crossref.org", "/works"),
    )

    def variants(self, package, env, rng, budget):
        return [
            self.variant(
                package,
                tool,
                {"tool": tool},
                f"a trusted package declares {tool} at collector.example.org, with matching "
                "domains, "
                "permission resources and network policy",
            )
            for tool, _, _, _ in self.TOOLS
        ]

    def plan(self, variant, kind, env):
        if kind == "control":
            return resigned_plan(env, variant.package), B.unauthorized_transport
        tool, permission, original, path = next(
            t for t in self.TOOLS if t[0] == variant.params["tool"]
        )
        target = "collector.example.org"
        files = payload(env, variant.package)

        def tool_doc(doc):
            doc["endpoint"] = f"https://{target}{path}"
            doc["domains"] = [target]

        def policy(doc):
            for item in doc["permissions"]:
                if item["id"] == permission:
                    item["resources"] = [target]
            domains = [d for d in doc["network"]["allowed_domains"] if d != original]
            doc["network"]["allowed_domains"] = sorted({*domains, target})

        files = edit_json(files, f"tools/{tool}.tool.json", tool_doc)
        files = edit_json(files, "policy/policy.json", policy)
        return resigned_plan(env, variant.package, files), B.unauthorized_transport


DESTINATION_REDIRECT = DestinationRedirect(
    "F6.destination_redirect",
    "F6",
    "Package declares a tool destination the host binding does not serve",
    "A trusted package re-declares a remote tool at another domain (and grants itself that "
    "domain consistently), hoping the host will send the tool's data there — or will send "
    "it to its usual service under the new, differently-scoped permission.",
    "A package's declared endpoint bounds a binding; it never grants or redirects one.",
    "compatibility",
    "compatibility",
    ("tool_contract_mismatch",),
    "Tool data is sent to a destination outside the permission resources the person granted.",
    "The same trusted package with its original declarations.",
    "finite",
    LR,
    "minus_compatibility",
    "binding contract (destination)",
    "endpoint override",
)


class AddressPolicy(Template):
    HOSTS = (
        ("crossref", "api.crossref.org"),
        ("resolver", "webagents-citation-resolver-production.up.railway.app"),
    )
    CLASSES = (
        ("loopback", "127.0.0.1"),
        ("private", "10.0.0.8"),
        ("link_local_metadata", "169.254.169.254"),
        ("cgnat", "100.64.0.9"),
        ("ipv6_loopback", "::1"),
        ("ipv4_mapped", "::ffff:127.0.0.1"),
    )

    def variants(self, package, env, rng, budget):
        return [
            self.variant(
                package,
                f"{host_label}-{label}",
                {"hostname": hostname, "address": address, "class": label},
                f"the resolver answers {hostname} with a {label.replace('_', ' ')} address",
            )
            for host_label, hostname in self.HOSTS
            for label, address in self.CLASSES
        ]

    def plan(self, variant, kind, env):
        plan = base_plan(env, variant.package)
        if kind == "violation":
            plan.faults.dns[variant.params["hostname"]] = [variant.params["address"]]
        return plan, B.nonpublic_transport


ADDRESS_POLICY = AddressPolicy(
    "F6.nonpublic_destination",
    "F6",
    "Approved tool host resolves to a non-public address",
    "The approved binding's hostname resolves (for example after DNS rebinding) to a "
    "loopback, private, link-local/metadata, CGNAT or IPv4-mapped address.",
    "Tool traffic reaches only publicly routable destinations.",
    "mediation",
    "execute/tool",
    ("tool_unavailable",),
    "A connection is attempted to a non-public address.",
    "The same hostname resolving to a public address.",
    "finite",
    LR,
    "minus_host_mediation",
    "broker address policy",
    "DNS rebinding to private address",
)

TEMPLATES = (
    MODEL_SUBSTITUTED,
    ARGUMENT_SMUGGLING,
    FILE_FORGERY,
    FILE_PATH_FROM_MODEL,
    STATIC_CONFINEMENT,
    RESERVED_EXPORT,
    DESTINATION_REDIRECT,
    ADDRESS_POLICY,
)
