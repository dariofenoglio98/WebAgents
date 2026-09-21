"""Offline semantic checks for the workflow.v0 execution profile."""

from __future__ import annotations

from .errors import ValidationError
from .validation import _schema_reference, _unique, parse_json, validate_document, validate_instance
from .workflow_values import references, tokens


def _at_schema(schema, parts, path, documents, label, seen=None):
    """Reject statically impossible pointers; optional data is checked again at runtime."""
    seen = set() if seen is None else seen
    if schema is True or schema == {}:
        return {}
    if not isinstance(schema, dict):
        raise ValidationError(f"{label}: projection targets a forbidden schema")
    if "$ref" in schema:
        target, fragment = _schema_reference(path, schema["$ref"])
        key = (target, fragment, tuple(parts))
        if key in seen:
            raise ValidationError(f"{label}: recursive projection cannot be resolved")
        from .workflow_values import select

        return _at_schema(
            select(documents[target], fragment), parts, target, documents, label, seen | {key}
        )
    if not parts:
        return schema
    for union in ("anyOf", "oneOf", "allOf"):
        if union in schema:
            for choice in schema[union]:
                try:
                    return _at_schema(choice, parts, path, documents, label, seen)
                except ValidationError:
                    pass
            raise ValidationError(f"{label}: no schema alternative contains projection")
    key, *rest = parts
    if schema.get("type") == "array":
        if not key.isdigit() or str(int(key)) != key:
            raise ValidationError(f"{label}: array projection needs a canonical numeric index")
        child = schema.get("items", {})
    else:
        types = schema.get("type", ["object"])
        types = [types] if isinstance(types, str) else types
        if "object" not in types:
            raise ValidationError(f"{label}: cannot traverse a scalar schema")
        child = schema.get("properties", {}).get(key)
        if child is None:
            child = schema.get("additionalProperties", True)
            if child is False:
                raise ValidationError(f"{label}: state/data path component {key!r} not declared")
    return _at_schema(child, rest, path, documents, label, seen)


def validate_workflow(manifest, graph, policy, tools, files):
    if manifest["entrypoint"] != "workflow.v0":
        raise ValidationError("workflow.v0 graph requires entrypoint workflow.v0")
    schema_paths = {s["path"] for s in manifest["schemas"]}
    documents = {p: parse_json(files[p], p) for p in schema_paths}
    workers = {r["id"]: r for r in graph["workers"]}
    tasks = {t["id"] for t in manifest["model_requirements"]["tasks"]}
    nodes = _unique(graph["nodes"], "workflow nodes")
    state_path = policy["memory"]["state_schema"]
    coordinator = graph["coordinator"]
    if policy["delegation"]["max_depth"] != 1 or policy["delegation"]["allow_remote"]:
        raise ValidationError("workflow.v0 requires local delegation max_depth=1")
    if any(w["kind"] != "packaged" for w in workers.values()):
        raise ValidationError("workflow.v0 supports packaged workers only")
    if any(t["retries"] != 0 or t["execution"] == "agent" for t in tools.values()):
        raise ValidationError("workflow.v0 supports local/remote tools with retries=0")

    def schema(path, label):
        if path not in schema_paths:
            raise ValidationError(f"{label}: undeclared schema {path!r}")
        return documents[path], path

    schema(graph["input_schema"], "workflow input")
    schema(graph["output_schema"], "workflow output")
    ancestors = {}
    visiting = set()

    def visit(nid):
        if nid in visiting:
            raise ValidationError(f"workflow node {nid}: cyclic dependency")
        if nid in ancestors:
            return ancestors[nid]
        visiting.add(nid)
        node = nodes[nid]
        found = set()
        for dep in node["depends_on"]:
            if dep not in nodes:
                raise ValidationError(f"workflow node {nid}: unknown dependency {dep!r}")
            found.add(dep)
            found.update(visit(dep))
        visiting.remove(nid)
        ancestors[nid] = found
        return found

    for nid in nodes:
        visit(nid)
    outputs = [n for n in nodes.values() if n["type"] == "output"]
    if len(outputs) != 1:
        raise ValidationError("workflow requires exactly one output node")
    output = outputs[0]
    if ancestors[output["id"]] != set(nodes) - {output["id"]}:
        raise ValidationError(f"output node {output['id']} must depend on every other node")
    if output["output_schema"] != graph["output_schema"]:
        raise ValidationError("output node schema must equal workflow output_schema")
    reads = {nid: set() for nid in nodes}
    writes = {nid: set() for nid in nodes}

    def expression(value, env, label, role=None, nid=None):
        for source, pointer in references(value):
            if source not in env:
                raise ValidationError(f"{label}: source {source!r} is unavailable in this scope")
            parts = tokens(pointer)
            if source == "state":
                if not parts or parts[0] not in workers[role]["state_read"]:
                    raise ValidationError(f"{label}: projection exceeds {role} state_read")
                reads[nid].add(parts[0])
            if source == "steps":
                if not parts or parts[0] not in env["steps"]:
                    raise ValidationError(f"{label}: unknown or forward step reference")
                root, path = env["steps"][parts[0]]
                parts = parts[1:]
            else:
                root, path = env[source]
            _at_schema(root, parts, path, documents, label)

    expression(
        graph["initial_state"], {"input": schema(graph["input_schema"], "input")}, "initial_state"
    )

    def operation(node, role, env, label, nid):
        schema(node["output_schema"], label)
        expression(node["input"], env, label + "/input", role, nid)
        if "when" in node:
            for side in ("left", "right"):
                expression(node["when"][side], env, label + "/when", role, nid)
            expression(node["otherwise"], env, label + "/otherwise", role, nid)
        for assertion in node.get("assertions", []):
            for key in ("left", "right", "rows", "targets", "equals"):
                if key in assertion:
                    expression(assertion[key], env, label + "/assertions/" + key, role, nid)
        kind = node["type"]
        if kind == "llm" and node["task"] not in tasks:
            raise ValidationError(f"{label}: undeclared model task {node['task']!r}")
        if kind == "tool":
            if node["tool"] not in tools:
                raise ValidationError(f"{label}: unknown tool {node['tool']!r}")
            if node["tool"] not in workers[role]["tools"]:
                raise ValidationError(f"{label}: tool is not authorized for worker {role}")
        if kind == "map":
            if "when" in node:
                raise ValidationError(f"{label}: map conditions unsupported; use an empty array")
            if node["max_parallel"] > min(
                workers[role]["max_instances"], policy["budget"]["max_parallel_workers"]
            ):
                raise ValidationError(f"{label}: max_parallel exceeds worker/package limits")
            item = schema(node["item_schema"], label + "/item_schema")
            _unique(node["steps"], label + "/steps")
            step_env = env | {"item": item, "steps": {}}
            for step in node["steps"]:
                operation(step, role, step_env, label + "/" + step["id"], nid)
                step_env["steps"][step["id"]] = schema(step["output_schema"], label)
            expression(node["yield"], step_env, label + "/yield", role, nid)
        if kind in {"llm", "tool", "map"} and role == coordinator:
            raise ValidationError(f"{label}: effectful nodes require a non-coordinator worker")

    for nid, node in nodes.items():
        role = node["worker"]
        label = f"workflow node {nid}"
        if role not in workers:
            raise ValidationError(f"{label}: unknown worker {role!r}")
        env = {"state": (documents[state_path], state_path)}
        operation(node, role, env, label, nid)
        for pointer, value in node["writes"].items():
            parts = tokens(pointer)
            if len(parts) != 1 or parts[0] not in workers[role]["state_write"]:
                raise ValidationError(f"{label}: writes must target one authorized state_write key")
            writes[nid].add(parts[0])
            expression(
                value,
                {"result": schema(node["output_schema"], label)},
                label + "/writes/" + pointer,
                role,
                nid,
            )
        if node["type"] == "output" and node["writes"]:
            raise ValidationError(f"{label}: output cannot write state")
    # Unordered conflicting accesses are invalid, independent of incidental array order.
    for a in nodes:
        for b in nodes:
            if a != b and a not in ancestors[b] and b not in ancestors[a]:
                conflict = writes[a] & (reads[b] | writes[b])
                if conflict:
                    raise ValidationError(
                        f"workflow nodes {a}/{b}: unordered state conflict "
                        f"{sorted(conflict)}; add a dependency"
                    )
    initial = graph["initial_state"]
    initial_keys = (
        set(initial["object"])
        if "object" in initial
        else set(initial["literal"])
        if isinstance(initial.get("literal"), dict)
        else None
    )
    if initial_keys is not None:
        for nid in nodes:
            available = initial_keys | {key for dep in ancestors[nid] for key in writes[dep]}
            missing = reads[nid] - available
            if missing:
                raise ValidationError(
                    f"workflow node {nid}: read before initialization {sorted(missing)}"
                )
    exported = set()
    for export in graph.get("exports", []):
        from .package import _safe_name

        _safe_name(export["path"])
        name = export["path"].lower()
        if name in exported or name in {
            "result.json",
            "audit.json",
            "usage.json",
            "provenance.json",
        }:
            raise ValidationError(f"duplicate or reserved export path {name}")
        exported.add(name)
        expression(
            export["value"], {"result": schema(graph["output_schema"], "export")}, "export " + name
        )
    if graph.get("fixture"):
        path = graph["fixture"]
        if path not in files:
            raise ValidationError(f"missing workflow fixture {path}")
        fixture = parse_json(files[path], path)
        validate_document(fixture, "workflow-fixture", path)
        validate_instance(files, graph["input_schema"], fixture["input"], "fixture input")
        import json

        for cases in list(fixture["models"].values()) + list(fixture["tools"].values()):
            inputs = [json.dumps(c["input"], sort_keys=True) for c in cases]
            if len(set(inputs)) != len(inputs):
                raise ValidationError("fixture contains duplicate input cases")
        if set(fixture["models"]) - tasks or set(fixture["tools"]) - set(tools):
            raise ValidationError("fixture contains undeclared model task/tool")
        for tid, cases in fixture["tools"].items():
            for case in cases:
                for field in ("input", "output"):
                    validate_instance(
                        files,
                        tools[tid][field + "_schema"],
                        case[field],
                        f"fixture tool {tid} {field}",
                    )
