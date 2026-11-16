"""What a package may declare about links, checked at validation (link.v0 §2 and L-21), before
any host fetches or runs anything.

Refusals are `ValidationError`s whose text starts with the specification's code, so that both
runtimes refuse a package with the same message. Only the caller's own package is read here:
what needs a linked package's declaration (its digest, its profile, the composed bound of a
planned link) is checked at preparation, by `resolve`. Nothing here imports the interpreter.
"""

from __future__ import annotations

from ..errors import ValidationError
from ..validation import release
from ..workflow_values import tokens
from .analysis import composed_requirement, link_operations

LINK_MINIMUM_VERSION = "0.8.0"
MAX_DEPENDENCIES = 8
MAX_SLOTS = 2
MAX_LOCATE_REFERENCES = 3
MAX_REASON_CHARS = 500
#: The members of a slot step's outcome, which the runtime builds (L-8).
OUTCOME_MEMBERS = ("joined", "reason", "result")
#: What `locate` may read (L-7): the run's own input and a tool step's result.
LOCATE_SOURCES = ("input", "steps")


def _refuse(code: str, message: str) -> ValidationError:
    error = ValidationError(f"{code}: {message}")
    error.code = code
    return error


def locate_references(locate) -> list[dict] | None:
    """The references of a `locate` constructor in order, or None when it has another form: a
    reference, an `array` of references, or a `coalesce` of those (L-7)."""
    if not isinstance(locate, dict):
        return None
    if "from" in locate:
        return [locate]
    members = locate.get("array", locate.get("coalesce"))
    if members is None or set(locate) - {"array", "coalesce"}:
        return None
    found = []
    for member in members:
        inner = locate_references(member)
        if inner is None:
            return None
        found += inner
    return found


def _is_uri_string(schema) -> bool:
    """A string of `format: uri`, nullable allowed."""
    if not isinstance(schema, dict):
        return False
    for union in ("anyOf", "oneOf"):
        if union in schema:
            choices = schema[union]
            return any(_is_uri_string(c) for c in choices) and all(
                _is_uri_string(c) or c == {"type": "null"} for c in choices
            )
    kinds = schema.get("type")
    kinds = [kinds] if isinstance(kinds, str) else list(kinds or [])
    return schema.get("format") == "uri" and "string" in kinds and set(kinds) <= {"string", "null"}


def check_link_declarations(
    manifest, graph, policy, files, *, documents, schema, expression, at_schema
) -> dict | None:
    """The dependency records, every `link` step against them, the slots (their place, their
    `locate`, their request task, their outcome schema, the caps) and the slots' ceilings
    against the package's own budget; called by `validate_workflow` after the nodes and the
    network were checked. A package without a dependency or a `link` step returns None."""
    dependencies = manifest.get("dependencies", [])
    operations = list(link_operations(graph))
    if not dependencies and not operations:
        return None
    if release(manifest["runtime"]["minimum_version"]) < release(LINK_MINIMUM_VERSION):
        raise _refuse(
            "link_minimum_version",
            f"a dependency or a link step requires runtime.minimum_version "
            f"{LINK_MINIMUM_VERSION} or later",
        )
    if len(dependencies) > MAX_DEPENDENCIES:
        raise _refuse("link_caps", f"a package declares at most {MAX_DEPENDENCIES} dependencies")
    records = {}
    for record in dependencies:
        if "id" not in record:
            raise _refuse(
                "link_dependency_unused",
                f"dependency {record['package_id']!r} carries no id, so no link step can name it",
            )
        if record["id"] in records:
            raise _refuse("link_dependency_duplicate", f"two dependencies named {record['id']!r}")
        if not record["locator"].startswith("https://"):
            raise _refuse(
                "link_locator_scheme",
                f"dependency {record['id']!r}: a link's locator is an https:// URL",
            )
        if record["package_id"] == manifest["package_id"]:
            raise _refuse(
                "link_nested", f"dependency {record['id']!r} names this package itself (a cycle)"
            )
        records[record["id"]] = record
    for export in graph.get("exports", []):
        name = export["path"].lower()
        if name == "links.json" or name.startswith("link-"):
            # The host writes the run's links and each inner run's record under these names.
            raise ValidationError(f"duplicate or reserved export path {name}")
    used = set()
    slots = []
    for label, step, where, role_id in operations:
        if "slot" in step:
            if where != "role":
                raise _refuse(
                    "link_slot_scope",
                    f"link step {label}: a slot is a step of a network role's program",
                )
            slots.append((label, step, role_id))
        else:
            if step["dependency"] not in records:
                raise _refuse(
                    "link_dependency_unknown",
                    f"link step {label}: dependency {step['dependency']!r} is not declared",
                )
            used.add(step["dependency"])
    unused = sorted(set(records) - used)
    if unused:
        raise _refuse(
            "link_dependency_unused",
            f"dependency {unused[0]!r} is declared and no link step names it",
        )
    if len(slots) > MAX_SLOTS:
        raise _refuse("link_caps", f"a graph holds at most {MAX_SLOTS} slot steps")
    names = [step["slot"] for _, step, _ in slots]
    for name in names:
        if names.count(name) > 1:
            raise _refuse("link_slot_duplicate", f"two slot steps named {name!r}")
        if name in records:
            # A slot and a dependency share the names of the usage record and the audit.
            raise _refuse("link_slot_duplicate", f"slot {name!r} is named as a dependency is")
    for label, step, role_id in slots:
        _check_slot(
            label,
            step,
            role_id,
            manifest,
            graph,
            documents=documents,
            schema=schema,
            expression=expression,
            at_schema=at_schema,
        )
    # A slot's ceiling is this package's own declaration, so its place in the bound is checked
    # here (L-21); a planned link's needs the linked declaration and waits for preparation.
    excess = composed_requirement(graph, policy)
    if excess is not None:
        name, needed, cap = excess
        raise _refuse(
            "link_bound_exceeds_budget",
            f"with its slots at their ceilings the package's worst case is {needed} "
            f"{name.replace('_', ' ')}, above its own budget of {cap}",
        )
    return {"dependencies": sorted(records), "slots": sorted(names)}


def _check_slot(label, step, role_id, manifest, graph, *, documents, schema, expression, at_schema):
    name = f"link step {label}"
    tasks = {task["id"] for task in manifest["model_requirements"]["tasks"]}
    if step["request"]["task"] not in tasks:
        raise _refuse(
            "link_request_task_unknown",
            f"{name}: request task {step['request']['task']!r} is not a declared model task",
        )
    outcome = documents.get(step["output_schema"])
    properties = outcome.get("properties") if isinstance(outcome, dict) else None
    if (
        not isinstance(properties, dict)
        or outcome.get("type") != "object"
        or outcome.get("additionalProperties") is not False
        or set(properties) != set(OUTCOME_MEMBERS)
    ):
        raise _refuse(
            "link_slot_outcome_schema",
            f"{name}: a slot's output_schema is a closed object over "
            f"{', '.join(OUTCOME_MEMBERS)}, which the runtime builds",
        )
    network = graph["network"]
    role = network["roles"][role_id]
    earlier = {}
    for other in role["steps"]:
        if other is step:
            break
        earlier[other["id"]] = other
    references = locate_references(step["locate"])
    if references is None:
        raise _refuse(
            "link_locate_source",
            f"{name}: locate is a reference, an array of references or a coalesce of those",
        )
    if len(references) > MAX_LOCATE_REFERENCES:
        raise _refuse(
            "link_caps", f"{name}: locate names at most {MAX_LOCATE_REFERENCES} references"
        )
    for reference in references:
        source, parts = reference["from"], tokens(reference["path"])
        if source not in LOCATE_SOURCES:
            raise _refuse(
                "link_locate_source",
                f"{name}: locate reads {source!r}; it may read only the run's input or a tool "
                "step's result, never something a model can write",
            )
        if source == "input":
            root, path = schema(graph["input_schema"], name)
        else:
            producer = earlier.get(parts[0]) if parts else None
            if producer is None or producer["type"] != "tool":
                raise _refuse(
                    "link_locate_source",
                    f"{name}: locate reads steps{reference['path']!r}, which is not the result "
                    "of an earlier tool step of this role",
                )
            root, path = schema(producer["output_schema"], name)
            parts = parts[1:]
        try:
            target = at_schema(root, parts, path, documents, name + "/locate")
        except ValidationError as exc:
            raise _refuse("link_locate_source", str(exc)) from exc
        if not _is_uri_string(target):
            raise _refuse(
                "link_locate_source",
                f"{name}: locate reads {source}{reference['path']!r}, whose schema is not a "
                "string of format uri",
            )
    if "reason" in step:
        env = {
            "state": schema(network["state_schema"], name),
            "message": schema(network["message_schema"], name),
            "steps": {key: schema(other["output_schema"], name) for key, other in earlier.items()},
        }
        expression(step["reason"], env, name + "/reason", role_id, None)


__all__ = [
    "LINK_MINIMUM_VERSION",
    "LOCATE_SOURCES",
    "MAX_DEPENDENCIES",
    "MAX_LOCATE_REFERENCES",
    "MAX_REASON_CHARS",
    "MAX_SLOTS",
    "OUTCOME_MEMBERS",
    "check_link_declarations",
    "locate_references",
]
