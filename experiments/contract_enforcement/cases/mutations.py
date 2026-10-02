"""Schema-driven output mutations: where a node's declared schema can be violated, and how.

Sites are enumerated from the package's own schema documents (following
package-relative and local `$ref`s), never from a run. A site is a JSON
pointer *pattern* (`/agenda/*/minutes`) plus the subschema that governs it.
An operator turns a valid value into one the subschema refuses:

    missing_required  extra_property  wrong_type  invalid_enum
    below_minimum     min_items       max_items   min_length   pattern

At run time `apply` resolves the pattern against the synthetic model's actual
answer (first matching location) and applies the operator. The provider then
checks the mutated answer against the schema the production router sent; an
answer that is still valid is reported as a harness anomaly, so a "violation"
that violates nothing can never be scored.

`valid_perturbation` is the matched control: a change at a free-text or
free-enum location that the schema and the package's relations still accept.
"""

from __future__ import annotations

import copy
import json
import re
from dataclasses import dataclass

OPERATORS = (
    "missing_required",
    "extra_property",
    "wrong_type",
    "invalid_enum",
    "below_minimum",
    "min_items",
    "max_items",
    "min_length",
    "pattern",
)


@dataclass(frozen=True)
class Site:
    pointer: str  # pattern; "*" matches an array index
    operator: str
    detail: dict

    def as_json(self) -> dict:
        return {"pointer": self.pointer, "operator": self.operator, **self.detail}


def _load(files: dict[str, bytes], path: str):
    return json.loads(files[path])


def _follow(schema, base: str, files, root_doc=None):
    """Resolve `$ref` chains: package-relative files and local JSON pointers."""
    seen = 0
    document = root_doc if root_doc is not None else _load(files, base)
    while isinstance(schema, dict) and "$ref" in schema and seen < 16:
        seen += 1
        ref = schema["$ref"]
        target, _, fragment = ref.partition("#")
        if target:
            base = str(_join(base, target))
            document = _load(files, base)
        node = document
        for token in [part for part in fragment.split("/") if part]:
            node = node[token.replace("~1", "/").replace("~0", "~")]
        schema = node
    return schema, base, document


def _join(base: str, target: str) -> str:
    parts = base.split("/")[:-1] + target.split("/")
    out: list[str] = []
    for part in parts:
        if part == "..":
            out.pop()
        elif part and part != ".":
            out.append(part)
    return "/".join(out)


def _types(schema) -> list[str]:
    value = schema.get("type") if isinstance(schema, dict) else None
    if value is None:
        if isinstance(schema, dict) and ("anyOf" in schema or "oneOf" in schema):
            return []
        return []
    return [value] if isinstance(value, str) else list(value)


def sites(files: dict[str, bytes], schema_path: str, *, max_depth: int = 4) -> list[Site]:
    """Every (pointer, operator) the schema refuses, depth-first, in a stable order."""
    found: list[Site] = []

    def walk(schema, base, document, pointer, depth):
        schema, base, document = _follow(schema, base, files, document)
        if not isinstance(schema, dict) or depth > max_depth:
            return
        types = _types(schema)
        if "enum" in schema:
            found.append(Site(pointer, "invalid_enum", {"enum": list(schema["enum"])}))
        if types and "null" not in types:
            found.append(Site(pointer, "wrong_type", {"types": types}))
        if "minimum" in schema and "integer" in types:
            found.append(Site(pointer, "below_minimum", {"minimum": schema["minimum"]}))
        if "minLength" in schema and schema["minLength"] >= 1:
            found.append(Site(pointer, "min_length", {"minLength": schema["minLength"]}))
        if "pattern" in schema:
            found.append(Site(pointer, "pattern", {"pattern": schema["pattern"]}))
        if "array" in types or "items" in schema:
            if schema.get("minItems", 0) >= 1:
                found.append(Site(pointer, "min_items", {"minItems": schema["minItems"]}))
            if "maxItems" in schema:
                found.append(Site(pointer, "max_items", {"maxItems": schema["maxItems"]}))
            if "items" in schema:
                walk(schema["items"], base, document, f"{pointer}/*", depth + 1)
        if "object" in types or "properties" in schema:
            properties = schema.get("properties") or {}
            for name in schema.get("required") or []:
                found.append(Site(pointer, "missing_required", {"property": name}))
            if schema.get("additionalProperties") is False:
                found.append(Site(pointer, "extra_property", {"allowed": sorted(properties)}))
            for name, child in properties.items():
                walk(child, base, document, f"{pointer}/{name}", depth + 1)

    walk({"$ref": schema_path.split("/")[-1]}, schema_path, _load(files, schema_path), "", 0)
    unique, seen = [], set()
    for site in found:
        key = (site.pointer, site.operator, json.dumps(site.detail, sort_keys=True))
        if key not in seen:
            seen.add(key)
            unique.append(site)
    return unique


def _locations(value, pattern: str) -> list[list]:
    """Concrete paths (lists of keys/indices) matching a pointer pattern, in order."""
    parts = [part for part in pattern.split("/") if part]
    results: list[list] = []

    def visit(node, index, path):
        if index == len(parts):
            results.append(path)
            return
        part = parts[index]
        if part == "*":
            if isinstance(node, list):
                for position, child in enumerate(node):
                    visit(child, index + 1, [*path, position])
        elif isinstance(node, dict) and part in node:
            visit(node[part], index + 1, [*path, part])

    visit(value, 0, [])
    return results


def _get(value, path):
    for key in path:
        value = value[key]
    return value


def _set(value, path, new):
    if not path:
        return new
    parent = _get(value, path[:-1])
    parent[path[-1]] = new
    return value


def apply(output, site: dict, token: str):
    """Apply one operator at the first concrete location of `site["pointer"]`.

    Returns (mutated, concrete_pointer) or (output, None) when the pattern does
    not occur in this answer.
    """
    value = copy.deepcopy(output)
    locations = _locations(value, site["pointer"])
    if not locations:
        return output, None
    path = locations[0]
    operator = site["operator"]
    target = _get(value, path)
    if operator == "missing_required":
        if not isinstance(target, dict) or site["property"] not in target:
            return output, None
        del target[site["property"]]
    elif operator == "extra_property":
        if not isinstance(target, dict):
            return output, None
        target[f"x_{token.lower().replace('-', '_')}"] = token
    elif operator == "wrong_type":
        types = set(site.get("types") or [])
        if "string" in types:
            replacement = {"injected": token}
        elif types & {"object", "array", "integer", "number", "boolean"}:
            replacement = token
        else:
            replacement = 0
        value = _set(value, path, replacement)
    elif operator == "invalid_enum":
        value = _set(value, path, token)
    elif operator == "below_minimum":
        value = _set(value, path, int(site["minimum"]) - 1)
    elif operator == "min_items":
        value = _set(value, path, [])
    elif operator == "max_items":
        items = target if isinstance(target, list) and target else None
        if items is None:
            return output, None
        extended = list(items)
        while len(extended) <= int(site["maxItems"]):
            extended.append(copy.deepcopy(items[len(extended) % len(items)]))
        value = _set(value, path, extended)
    elif operator == "min_length":
        value = _set(value, path, "")
    elif operator == "pattern":
        value = _set(value, path, f"/{token}/..")
    else:
        raise ValueError(operator)
    return value, "/" + "/".join(str(part) for part in path)


# Free-text and free-enum fields whose value no relation of either package
# depends on: a different value there is still a correct answer.
FREE_TEXT = {
    "focus",
    "priorities",
    "questions",
    "topic",
    "preparation_items",
    "decisions",
    "rationale",
    "screening_rationale",
    "label",
    "method_comparison",
    "limitations",
    "related_work",
    "reason",
    "checks",
    "title",
}
FREE_ENUM = {"strength", "category", "support_strength", "inference_level"}


def control_sites(files: dict[str, bytes], schema_path: str) -> list[Site]:
    """Locations a valid perturbation may change: free text and free enums."""
    found = []
    for site in sites(files, schema_path):
        leaf = site.pointer.rstrip("/").split("/")[-1]
        parent = site.pointer.rstrip("/").split("/")[-2] if site.pointer.count("/") >= 2 else ""
        if site.operator == "wrong_type" and "string" in site.detail.get("types", []):
            if leaf in FREE_TEXT or (leaf == "*" and parent in FREE_TEXT):
                found.append(Site(site.pointer, "change_text", {}))
        if site.operator == "invalid_enum" and leaf in FREE_ENUM and len(site.detail["enum"]) > 1:
            found.append(Site(site.pointer, "change_enum", {"enum": site.detail["enum"]}))
    return found


def valid_perturbation(output, site: dict, token: str):
    """The matched control: a value the schema and the package still accept."""
    value = copy.deepcopy(output)
    locations = _locations(value, site["pointer"])
    if not locations:
        return output, None
    path = locations[0]
    current = _get(value, path)
    if site["operator"] == "change_text":
        if not isinstance(current, str):
            return output, None
        replacement = f"{current} (reviewed {token[-6:]})".strip()
    elif site["operator"] == "change_enum":
        options = [item for item in site["enum"] if item != current]
        if not options:
            return output, None
        replacement = options[0]
    else:
        raise ValueError(site["operator"])
    value = _set(value, path, replacement)
    return value, "/" + "/".join(str(part) for part in path)


TOKEN_SAFE = re.compile(r"[^A-Za-z0-9_-]")
