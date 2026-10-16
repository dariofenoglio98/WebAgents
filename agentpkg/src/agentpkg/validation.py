"""Closed, offline JSON Schema and package-wide semantic validation."""

from __future__ import annotations

import json
import re
from pathlib import Path, PurePosixPath
from urllib.parse import unquote, urlsplit

from jsonschema import Draft202012Validator, FormatChecker
from jsonschema.exceptions import SchemaError
from jsonschema.exceptions import ValidationError as JsonValidationError
from referencing import Registry, Resource
from referencing.exceptions import NoSuchResource

from .errors import ValidationError

SCHEMAS = Path(__file__).parent / "schemas"
FORMAT_CHECKER = FormatChecker()


def parse_json(data: bytes, name: str):
    def pairs(items):
        result = {}
        for key, value in items:
            if key in result:
                raise ValidationError(f"{name}: duplicate JSON key {key!r}")
            result[key] = value
        return result

    try:
        return json.loads(
            data.decode("utf-8"),
            object_pairs_hook=pairs,
            parse_constant=lambda value: (_ for _ in ()).throw(ValueError(value)),
        )
    except (UnicodeDecodeError, ValueError, RecursionError) as exc:
        raise ValidationError(f"{name}: invalid strict UTF-8 JSON: {exc}") from exc


def validate_document(value, schema_name: str, label: str):
    schema = json.loads((SCHEMAS / f"{schema_name}.schema.json").read_text())
    errors = sorted(
        Draft202012Validator(schema, format_checker=FORMAT_CHECKER).iter_errors(value),
        key=lambda e: tuple(str(p) for p in e.absolute_path),
    )
    if errors:
        error = errors[0]
        path = "/".join(map(str, error.absolute_path)) or "<root>"
        raise ValidationError(f"{label}/{path}: {error.message}")


def _unique(items, label):
    result = {}
    for item in items:
        key = item["id"]
        if key in result:
            raise ValidationError(f"{label}: duplicate id {key!r}")
        result[key] = item
    return result


def _domain(value):
    if not isinstance(value, str) or len(value) > 253 or value != value.lower() or "." not in value:
        raise ValidationError(f"invalid explicit network domain {value!r}")
    if not all(
        re.fullmatch(r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?", label) for label in value.split(".")
    ):
        raise ValidationError(
            f"invalid explicit network domain {value!r}; no wildcards, ports or URLs"
        )
    if all(part.isdigit() for part in value.split(".")) or value.endswith((".localhost", ".local")):
        raise ValidationError(f"network domain must be a public DNS name: {value!r}")


def _schema_reference(base: str, ref: str) -> tuple[str, str]:
    parsed = urlsplit(ref)
    if parsed.scheme or parsed.netloc or parsed.query or parsed.path.startswith("/") or "\\" in ref:
        raise ValidationError(
            f"{base}: only offline package-relative JSON Schema references allowed: {ref!r}"
        )
    decoded = unquote(parsed.path)
    if any(part == ".." for part in PurePosixPath(decoded).parts):
        raise ValidationError(f"{base}: schema reference traversal is forbidden: {ref!r}")
    target = str(PurePosixPath(base).parent / decoded) if decoded else base
    return target, unquote(parsed.fragment)


def _walk_schema(value, path, documents):
    if isinstance(value, dict):
        # Nested identities, dynamic refs and non-2020 vocabularies complicate authority;
        # v0 keeps one offline address for each schema document.
        if "$id" in value:
            raise ValidationError(
                f"{path}: $id is unsupported in package schemas; use relative $ref"
            )
        if (
            "$schema" in value
            and value["$schema"] != "https://json-schema.org/draft/2020-12/schema"
        ):
            raise ValidationError(f"{path}: schemas must use draft 2020-12")
        if any(key in value for key in ("$dynamicRef", "$recursiveRef", "$vocabulary")):
            raise ValidationError(
                f"{path}: dynamic references and custom vocabularies unsupported in v0"
            )
        if "$ref" in value:
            target, fragment = _schema_reference(path, value["$ref"])
            if target not in documents:
                raise ValidationError(f"{path}: missing or undeclared schema reference {target!r}")
            current = documents[target]
            if fragment:
                if not fragment.startswith("/"):
                    raise ValidationError(
                        f"{path}: schema references require JSON Pointer fragments"
                    )
                try:
                    for token in fragment[1:].split("/"):
                        token = token.replace("~1", "/").replace("~0", "~")
                        current = (
                            current[int(token)] if isinstance(current, list) else current[token]
                        )
                except (KeyError, IndexError, ValueError, TypeError) as exc:
                    raise ValidationError(
                        f"{path}: unresolved schema fragment #{fragment}"
                    ) from exc
            if not isinstance(current, (dict, bool)):
                raise ValidationError(f"{path}: schema reference does not point to a schema")
        for child in value.values():
            _walk_schema(child, path, documents)
    elif isinstance(value, list):
        for child in value:
            _walk_schema(child, path, documents)


def schema_validator(files: dict[str, bytes], path: str):
    """Build a validator whose registry cannot retrieve any remote resource."""
    documents = {
        name: parse_json(data, name) for name, data in files.items() if name.endswith(".json")
    }

    def retrieve(uri):
        raise NoSuchResource(ref=uri)

    registry = Registry(retrieve=retrieve)
    for name, doc in documents.items():
        if isinstance(doc, (dict, bool)):
            registry = registry.with_resource(
                "https://package.invalid/" + name,
                Resource.from_contents(
                    doc,
                    default_specification=__import__(
                        "referencing.jsonschema", fromlist=["DRAFT202012"]
                    ).DRAFT202012,
                ),
            )
    root = documents[path]
    # A synthetic trusted base URI resolves package-relative references without I/O.
    if isinstance(root, dict):
        root = {"$id": "https://package.invalid/" + path, **root}
    return Draft202012Validator(root, registry=registry, format_checker=FORMAT_CHECKER)


def validate_instance(files, path, instance, label="instance"):
    try:
        schema_validator(files, path).validate(instance)
    except (JsonValidationError, RecursionError) as exc:
        rule = getattr(exc, "validator", "schema recursion limit")
        location = "/".join(map(str, getattr(exc, "absolute_path", []))) or "<root>"
        raise ValidationError(
            f"{label} does not match {path} at {location} (rule: {rule})"
        ) from exc


def validate_payload(files: dict[str, bytes]):
    def document(path, kind=None):
        if path not in files:
            raise ValidationError(f"missing referenced package member: {path}")
        value = parse_json(files[path], path)
        if kind:
            validate_document(value, kind, path)
        return value

    manifest = document("MANIFEST.agent", "manifest")
    from . import __version__

    def release(version):
        return tuple(int(x) for x in version.split("-")[0].split("."))

    if release(manifest["runtime"]["minimum_version"]) > release(__version__):
        raise ValidationError(
            f"manifest runtime.minimum_version exceeds reference runtime {__version__}"
        )
    workflow = manifest["entrypoint"] == "workflow.v0"
    graph = document(manifest["graph"], "workflow" if workflow else "graph")
    policy = document(manifest["policy"], "policy")
    skills = _unique(manifest["skills"], "skills")
    schemas = _unique(manifest["schemas"], "schemas")
    declarations = _unique(manifest["tools"], "tools")
    evaluations = _unique(manifest["evals"], "evals")
    _unique(manifest["model_requirements"]["tasks"], "model tasks")
    declared_paths = (
        [manifest["graph"], manifest["policy"]]
        + [
            entry["path"]
            for entries in (skills, schemas, declarations, evaluations)
            for entry in entries.values()
        ]
        + manifest["attestations"]
    )
    if len(set(declared_paths)) != len(declared_paths):
        raise ValidationError("each manifest document path must have exactly one declared role")
    for path in declared_paths:
        if path not in files:
            raise ValidationError(f"missing referenced package member: {path}")
    for skill in skills.values():
        if not skill["path"].endswith(".md"):
            raise ValidationError(f"skill {skill['id']}: path must be a Markdown instruction file")
    schema_paths = {entry["path"] for entry in schemas.values()}
    documents = {path: document(path) for path in schema_paths}
    for path, schema in documents.items():
        try:
            Draft202012Validator.check_schema(schema)
            _walk_schema(schema, path, documents)
        except (SchemaError, RecursionError) as exc:
            raise ValidationError(f"{path}: invalid JSON Schema: {exc}") from exc
    permissions = _unique(policy["permissions"], "permissions")
    domains = set(policy["network"]["allowed_domains"])
    for domain in domains:
        _domain(domain)
    if policy["memory"]["state_schema"] not in schema_paths:
        raise ValidationError("memory.state_schema must reference a declared schema")
    state_schema = documents[policy["memory"]["state_schema"]]
    if not isinstance(state_schema, dict) or state_schema.get("type") != "object":
        raise ValidationError("state schema must declare type object and top-level properties")
    state_keys = set(state_schema.get("properties", {}))
    tools = {}
    for tool_id, declaration in declarations.items():
        tool = document(declaration["path"], "tool")
        if tool["id"] != tool_id:
            raise ValidationError(
                f"tool id mismatch: manifest {tool_id!r} vs document {tool['id']!r}"
            )
        for field in ("input_schema", "output_schema"):
            if tool[field] not in schema_paths:
                raise ValidationError(f"tool {tool_id}: {field} must reference a declared schema")
        for permission_id in tool["permissions"]:
            if permission_id not in permissions:
                raise ValidationError(f"tool {tool_id}: unknown permission {permission_id!r}")
        for domain in tool["domains"]:
            _domain(domain)
            if domain not in domains:
                raise ValidationError(
                    f"tool {tool_id}: domain {domain} absent from policy allowlist"
                )
        if tool["execution"] == "remote":
            endpoint = urlsplit(tool["endpoint"] or "")
            if (
                endpoint.scheme != "https"
                or not endpoint.hostname
                or endpoint.username
                or endpoint.password
                or endpoint.port not in (None, 443)
                or endpoint.fragment
            ):
                raise ValidationError(
                    f"tool {tool_id}: remote endpoint must be credential-free HTTPS on port 443"
                )
            if endpoint.hostname not in tool["domains"] or tool["method"] is None:
                raise ValidationError(f"tool {tool_id}: endpoint domain/method not declared")
            grants = [
                permissions[x] for x in tool["permissions"] if permissions[x]["kind"] == "network"
            ]
            if any(
                not any(domain in grant["resources"] for grant in grants)
                for domain in tool["domains"]
            ):
                raise ValidationError(
                    f"tool {tool_id}: domains must have linked network permissions"
                )
        elif tool["execution"] == "local" and (
            tool["endpoint"] is not None or tool["method"] is not None or tool["domains"]
        ):
            raise ValidationError(
                f"tool {tool_id}: local tools cannot declare endpoints or domains"
            )
        if tool["side_effects"] == "write" and not tool["approval_required"]:
            raise ValidationError(
                f"tool {tool_id}: write side effects require approval_required=true"
            )
        tools[tool_id] = tool
    for permission in permissions.values():
        if permission["kind"] == "network":
            for domain in permission["resources"]:
                _domain(domain)
                if domain not in domains:
                    raise ValidationError(
                        f"network permission {permission['id']}: domain absent from allowlist"
                    )
    # The memory declarations (memory.v0 §7: M-18, M-19, M-33, M-38, M-48, M-67), checked here so
    # that both runtimes refuse the same packages before any host binds anything.
    from .memory.declarations import check_memory_graph, memory_declarations

    memory_declared = memory_declarations(manifest, policy, tools, files)
    budget = policy["budget"]
    if budget["estimated_tokens"] > budget["hard_tokens"]:
        raise ValidationError("estimated_tokens cannot exceed hard_tokens")
    if (
        budget["approval_threshold_tokens"] is not None
        and budget["approval_threshold_tokens"] > budget["hard_tokens"]
    ):
        raise ValidationError("approval_threshold_tokens cannot exceed hard_tokens")
    if set(budget["max_calls_per_tool"]) != set(tools):
        raise ValidationError("max_calls_per_tool must declare exactly every tool id")
    workers = _unique(graph["workers"], "workers")
    if graph["coordinator"] not in workers:
        raise ValidationError("graph coordinator must be a declared worker")
    if workers[graph["coordinator"]]["max_instances"] != 1:
        raise ValidationError("coordinator max_instances must be 1")
    if set(policy["delegation"]["approved_roles"]) != set(workers) - {graph["coordinator"]}:
        raise ValidationError(
            "delegation approved_roles must exactly match non-coordinator graph workers"
        )
    for role, worker in workers.items():
        for field, declared in [("skills", skills), ("tools", tools)]:
            if set(worker[field]) - set(declared):
                raise ValidationError(
                    f"worker {role}: unknown {field}: {sorted(set(worker[field]) - set(declared))}"
                )
        if (
            worker["budget"]["tokens"] > budget["hard_tokens"]
            or worker["budget"]["remote_calls"] > budget["max_remote_calls"]
        ):
            raise ValidationError(f"worker {role}: worker budgets cannot exceed package budgets")
        if worker["max_instances"] > budget["max_parallel_workers"]:
            raise ValidationError(f"worker {role}: max_instances exceeds max_parallel_workers")
        if (set(worker["state_read"]) | set(worker["state_write"])) - state_keys:
            raise ValidationError(
                f"worker {role}: state view refers to keys absent from state schema"
            )
    check_memory_graph(manifest, graph, memory_declared)
    if workflow:
        from .workflow_validation import validate_workflow

        validate_workflow(manifest, graph, policy, tools, files)
    else:
        stages = _unique(graph["stages"], "stages")
        for stage in stages.values():
            if stage["worker"] not in workers:
                raise ValidationError(f"stage {stage['id']}: unknown worker")
            if set(stage["depends_on"]) - set(stages):
                raise ValidationError(f"stage {stage['id']}: unknown dependency")
        visited, visiting = set(), set()

        def visit(stage):
            if stage in visiting:
                raise ValidationError(f"cyclic stage dependency involving {stage}")
            if stage in visited:
                return
            visiting.add(stage)
            for dependency in stages[stage]["depends_on"]:
                visit(dependency)
            visiting.remove(stage)
            visited.add(stage)

        for stage in stages:
            visit(stage)
    for eval_id, declaration in evaluations.items():
        evaluation = document(declaration["path"], "eval")
        if evaluation["id"] != eval_id:
            raise ValidationError(f"eval id mismatch: {eval_id}")
        _unique(evaluation["cases"], f"eval {eval_id} cases")
    for path in manifest["attestations"]:
        if not isinstance(document(path), dict):
            raise ValidationError(f"{path}: attestation must be a JSON object")
    return manifest, graph, policy, tools
