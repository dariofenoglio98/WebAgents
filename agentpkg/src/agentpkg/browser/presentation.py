"""What a browser may show a person about a package's task, and whether a task is valid.

Three bounded, read-only services for a Run surface, none of which executes
anything:

* **the task input schema**, bundled into one self-contained document so a
  browser can render a form from the package's own declared input contract;
* **presentation hints** from the noncritical `agentpkg:presentation` graph
  extension — human-readable node and stage labels, input widget hints, the
  wording of the Run button and which export is the primary result — validated,
  bounded and reduced to a closed vocabulary;
* **task validation** against the package's input schema with the same offline
  validator the runner uses, reported as pointers and host-written messages.

Presentation is cosmetic by construction. A hint cannot grant a permission,
approve a tool, select a model, change the graph or skip a check, and a host
that ignores every hint runs the package identically. The host also keeps its
own action vocabulary: a Run button label that does not say "run" is dropped,
because a package must not be able to make the button that spends tokens read
as something else.
"""

from __future__ import annotations

import re
import unicodedata

from ..errors import ValidationError
from ..package import Package, canonical_json, sha256
from ..validation import _schema_reference, schema_validator

EXTENSION_KEY = "agentpkg:presentation"
PRESENTATION_SCHEMA = "agentpkg-presentation-v0"
INPUT_SCHEMA_VERSION = "agentpkg-task-input-v0"

MAX_INPUT_SCHEMA_BYTES = 64 * 1024
MAX_TASK_INPUT_BYTES = 256 * 1024
MAX_ERRORS = 16
MAX_LABEL = 80
MAX_TEXT = 300
MAX_RUN_LABEL = 40
MAX_STAGES = 32
MAX_SUMMARY = 8
WIDGETS = frozenset({"multiline", "selected_files"})
GROUPS = frozenset({"primary", "optional", "advanced"})
_CONTROL = re.compile(r"[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩]")


class PresentationError(ValueError):
    """The presentation extension is malformed as a whole; it is then ignored."""


# -- text ------------------------------------------------------------------------
def _text(value, limit: int) -> str | None:
    """Plain display text: normalized, control and bidi characters removed, bounded."""
    if not isinstance(value, str):
        return None
    cleaned = " ".join(_CONTROL.sub(" ", unicodedata.normalize("NFC", value)).split())
    if not cleaned:
        return None
    return cleaned if len(cleaned) <= limit else cleaned[: limit - 1].rstrip() + "…"


# -- the task input schema -------------------------------------------------------
def _bundle(package: Package, path: str) -> dict | bool:
    """One self-contained schema: package-relative references moved into `$defs`."""
    documents = {
        entry["path"]: package.json(entry["path"]) for entry in package.manifest["schemas"]
    }
    names = {name: f"s{index}" for index, name in enumerate(sorted(documents))}
    included: dict[str, object] = {}
    pending = [path]

    def rewrite(value, base):
        if isinstance(value, list):
            return [rewrite(item, base) for item in value]
        if not isinstance(value, dict):
            return value
        out = {key: rewrite(item, base) for key, item in value.items() if key != "$schema"}
        if "$ref" in value:
            target, fragment = _schema_reference(base, value["$ref"])
            if target not in names:
                raise ValidationError(f"{base}: undeclared schema reference {target!r}")
            out["$ref"] = "#/$defs/" + names[target] + fragment
            if names[target] not in included and target not in pending:
                pending.append(target)
        return out

    root = documents[path]
    if not _has_ref(root):
        return (
            {key: value for key, value in root.items() if key != "$schema"}
            if isinstance(root, dict)
            else root
        )
    while pending:
        current = pending.pop()
        included[names[current]] = rewrite(documents[current], current)
    return {"$ref": "#/$defs/" + names[path], "$defs": included}


def _has_ref(value) -> bool:
    if isinstance(value, dict):
        return "$ref" in value or any(_has_ref(item) for item in value.values())
    if isinstance(value, list):
        return any(_has_ref(item) for item in value)
    return False


def input_form(package: Package) -> dict:
    """The package's declared task input contract, as one bounded document."""
    graph = package.graph
    path = graph.get("input_schema")
    if not path or "nodes" not in graph:
        return {
            "schema": INPUT_SCHEMA_VERSION,
            "schema_path": None,
            "schema_sha256": None,
            "document": None,
            "bytes": 0,
            "note": "This execution profile declares no task input schema.",
        }
    declared = package.json(path)
    bundled = _bundle(package, path)
    data = canonical_json(bundled)
    too_large = len(data) > MAX_INPUT_SCHEMA_BYTES
    return {
        "schema": INPUT_SCHEMA_VERSION,
        "schema_path": path,
        "schema_sha256": sha256(canonical_json(declared)),
        "document": None if too_large else bundled,
        "bytes": len(data),
        "note": (
            f"The input schema exceeds {MAX_INPUT_SCHEMA_BYTES} bytes; edit the task as JSON."
            if too_large
            else "The package's own declared input schema. The runner validates every run "
            "against it again before any instruction reaches a model."
        ),
    }


# -- validating a task -----------------------------------------------------------
def _pointer(parts) -> str:
    return "".join("/" + str(part).replace("~", "~0").replace("/", "~1") for part in parts)


def _describe(error) -> list[tuple[str, str]]:
    """Pointers and host-written messages. The person's own text is never echoed."""
    rule = str(error.validator)
    value = error.validator_value
    location = list(error.absolute_path)
    if rule == "required":
        instance = error.instance if isinstance(error.instance, dict) else {}
        missing = [name for name in value if name not in instance]
        if missing:
            return [(_pointer([*location, name]), "is required") for name in missing]
    messages = {
        "minLength": lambda: f"must be at least {value} character{'s' if value != 1 else ''}",
        "maxLength": lambda: f"must be at most {value} characters",
        "minItems": lambda: f"must have at least {value} item{'s' if value != 1 else ''}",
        "maxItems": lambda: f"must have at most {value} items",
        "minimum": lambda: f"must be at least {value}",
        "maximum": lambda: f"must be at most {value}",
        "exclusiveMinimum": lambda: f"must be greater than {value}",
        "exclusiveMaximum": lambda: f"must be less than {value}",
        "enum": lambda: "must be one of: " + ", ".join(str(item) for item in value)[:200],
        "const": lambda: "has a fixed value that was not supplied",
        "pattern": lambda: "does not have the required format",
        "type": lambda: (
            "must be " + (" or ".join(value) if isinstance(value, list) else str(value))
        ),
        "additionalProperties": lambda: "contains a field this package does not accept",
        "uniqueItems": lambda: "must not repeat items",
        "format": lambda: f"must be a valid {value}",
    }
    message = messages.get(rule, lambda: f"does not satisfy the schema rule {rule!r}")()
    return [(_pointer(location), message)]


def validate_task_input(package: Package, value) -> dict:
    """Validate one proposed task against the package's own input schema."""
    path = package.graph.get("input_schema")
    report = {
        "schema_path": path,
        "valid": False,
        "errors": [],
        "error_count": 0,
        "input_sha256": None,
        "input_bytes": 0,
    }
    try:
        data = canonical_json(value)
    except ValidationError:
        report["errors"] = [{"pointer": "", "rule": "json", "message": "is not finite JSON"}]
        report["error_count"] = 1
        return report
    report["input_sha256"] = sha256(data)
    report["input_bytes"] = len(data)
    if len(data) > MAX_TASK_INPUT_BYTES:
        report["errors"] = [
            {
                "pointer": "",
                "rule": "size",
                "message": f"is larger than the {MAX_TASK_INPUT_BYTES}-byte task limit",
            }
        ]
        report["error_count"] = 1
        return report
    if not path:
        report["errors"] = [
            {"pointer": "", "rule": "schema", "message": "this package declares no task input"}
        ]
        report["error_count"] = 1
        return report
    errors = sorted(
        schema_validator(package.files, path).iter_errors(value),
        key=lambda item: ([str(part) for part in item.absolute_path], str(item.validator)),
    )
    described = []
    for error in errors:
        for pointer, message in _describe(error):
            entry = {"pointer": pointer, "rule": str(error.validator), "message": message}
            if entry not in described:
                described.append(entry)
    report["errors"] = described[:MAX_ERRORS]
    report["error_count"] = len(described)
    report["valid"] = not described
    return report


# -- presentation hints ----------------------------------------------------------
def _input_hints(raw, properties: set[str], notes: list[str]) -> dict:
    hints = {}
    if not isinstance(raw, dict):
        return hints
    for name, value in raw.items():
        if name not in properties or not isinstance(value, dict):
            notes.append(f"input hint for undeclared field {str(name)[:40]!r} ignored")
            continue
        hint = {}
        widget = value.get("widget")
        if widget in WIDGETS:
            hint["widget"] = widget
        elif widget is not None:
            notes.append(f"unknown widget for {name!r} ignored")
        group = value.get("group")
        if group in GROUPS:
            hint["group"] = group
        rows = value.get("rows")
        if isinstance(rows, int) and not isinstance(rows, bool) and 1 <= rows <= 12:
            hint["rows"] = rows
        for key, limit in (
            ("label", MAX_LABEL),
            ("placeholder", MAX_TEXT),
            ("item_placeholder", MAX_TEXT),
            ("key_label", MAX_LABEL),
            ("key_placeholder", MAX_TEXT),
        ):
            text = _text(value.get(key), limit)
            if text:
                hint[key] = text
        if hint:
            hints[name] = hint
    return hints


def _stages(raw, node_ids: list[str], notes: list[str]) -> list[dict]:
    stages, seen = [], set()
    if not isinstance(raw, list):
        return stages
    for entry in raw[:MAX_STAGES]:
        if not isinstance(entry, dict):
            continue
        label = _text(entry.get("label"), MAX_LABEL)
        nodes = [
            node
            for node in entry.get("nodes", [])
            if isinstance(node, str) and node in node_ids and node not in seen
        ]
        if not label or not nodes:
            notes.append("a stage without a label or known nodes was ignored")
            continue
        seen.update(nodes)
        stages.append({"label": label, "nodes": nodes})
    return stages


def presentation_hints(package: Package) -> tuple[dict | None, list[str]]:
    """Validated hints and notes about what was dropped; `None` when absent or unusable."""
    graph = package.graph
    raw = graph.get("extensions", {}).get(EXTENSION_KEY)
    if raw is None:
        return None, []
    if not isinstance(raw, dict) or raw.get("schema") != PRESENTATION_SCHEMA:
        return None, [f"{EXTENSION_KEY} is not {PRESENTATION_SCHEMA}; ignored"]
    notes: list[str] = []
    node_ids = [node["id"] for node in graph.get("nodes", [])]
    try:
        input_schema = package.json(graph["input_schema"]) if graph.get("input_schema") else {}
    except ValidationError:
        input_schema = {}
    properties = (
        set(input_schema.get("properties", {})) if isinstance(input_schema, dict) else set()
    )
    exports = {export["path"]: export["format"] for export in graph.get("exports", [])}

    task_raw = raw.get("task") if isinstance(raw.get("task"), dict) else {}
    task = {}
    for key, limit in (
        ("prompt", MAX_TEXT),
        ("running_label", MAX_LABEL),
        ("completed_label", MAX_LABEL),
    ):
        text = _text(task_raw.get(key), limit)
        if text:
            task[key] = text
    run_label = _text(task_raw.get("run_label"), MAX_RUN_LABEL)
    if run_label and re.search(r"\brun\b", run_label, re.IGNORECASE):
        task["run_label"] = run_label
    elif run_label:
        notes.append("run_label must say 'Run'; the host label is used instead")

    labels = {}
    raw_labels = raw.get("nodes") if isinstance(raw.get("nodes"), dict) else {}
    for node_id, label in raw_labels.items():
        text = _text(label, MAX_LABEL)
        if node_id in node_ids and text:
            labels[node_id] = text

    result_raw = raw.get("result") if isinstance(raw.get("result"), dict) else {}
    result: dict = {}
    primary = result_raw.get("primary_export")
    if isinstance(primary, str):
        if exports.get(primary) == "text":
            result["primary_export"] = primary
        else:
            notes.append("primary_export must name a declared text export; ignored")
    summary = []
    for entry in (result_raw.get("summary") or [])[:MAX_SUMMARY]:
        if not isinstance(entry, dict):
            continue
        label = _text(entry.get("label"), MAX_LABEL)
        export = entry.get("export")
        if label and exports.get(export) == "json":
            summary.append({"label": label, "export": export})
        else:
            notes.append("a summary entry without a label or a declared JSON export was ignored")
    if summary:
        result["summary"] = summary

    return (
        {
            "schema": PRESENTATION_SCHEMA,
            "task": task,
            "input": _input_hints(raw.get("input"), properties, notes),
            "nodes": labels,
            "stages": _stages(raw.get("stages"), node_ids, notes),
            "result": result,
            "noncritical": True,
        },
        notes[:16],
    )


__all__ = [
    "EXTENSION_KEY",
    "PRESENTATION_SCHEMA",
    "PresentationError",
    "input_form",
    "presentation_hints",
    "validate_task_input",
]
