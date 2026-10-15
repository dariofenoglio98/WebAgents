"""memory.v0 types (§4, §11): the starter taxonomy, legacy aliases, record view schemas and the
custom types a package may declare (M-13…M-19).

The contracts are a copy of `spec/memory-v0/` under `agentpkg/schemas/memory/`, kept equal to the
specification's files by `tests/test_memory_contracts.py`. The refusal texts match the Chrome
core's (`src/core/memory/types.ts`), so both CLIs refuse a package with the same message.
"""

from __future__ import annotations

import copy
import json
from functools import cache
from pathlib import Path

from .model import (
    POINTER_RE,
    RESERVED_FAMILIES,
    RESERVED_KEYS,
    WELL_KNOWN_TYPE_ID,
    sha256_canonical,
)

CONTRACTS = Path(__file__).resolve().parents[1] / "schemas" / "memory"
COMBINATORS = (
    "allOf",
    "anyOf",
    "oneOf",
    "not",
    "if",
    "then",
    "else",
    "patternProperties",
    "propertyNames",
    "dependentSchemas",
    "unevaluatedProperties",
    "unevaluatedItems",
    "prefixItems",
    "contains",
)
SCALAR_TYPES = frozenset(["string", "number", "integer", "boolean", "null"])


class MemoryTypeError(ValueError):
    def __init__(self, code: str, message: str):
        self.code = code
        super().__init__(message)


@cache
def _contract_text(name: str) -> str:
    return (CONTRACTS / name).read_text(encoding="utf-8")


def contract(name: str):
    """One memory.v0 contract (`memory-record.schema.json`, `taxonomy.json`, ...), a fresh copy."""
    return json.loads(_contract_text(name))


def starter_types() -> list[dict]:
    return contract("taxonomy.json")["types"]


def schema_sha256(schema) -> str:
    return sha256_canonical(schema)


def record_view_schema(type_def: dict) -> dict:
    """M-16: the record view schema of a type, from the template, and nothing else."""
    template = contract("memory-record-view.template.json")
    fields_schema = copy.deepcopy(type_def["schema"])
    fields_schema.pop("$schema", None)
    template["properties"]["type"] = {"const": type_def["id"]}
    template["properties"]["fields"] = fields_schema
    return template


def sealed_starter_names(types=None) -> list[str]:
    """M-19: the sealed field names of the starter types, computed from the taxonomy."""
    names: list[str] = []
    for type_def in types if types is not None else starter_types():
        if type_def["declared_by"]["kind"] != "spec":
            continue
        for pointer in type_def["sealed_fields"]:
            name = pointer.split("/")[1]
            if name not in names:
                names.append(name)
    return names


def property_names(schema, found: list[str] | None = None) -> list[str]:
    """Every property name at any depth of a fields schema, in declaration order (M-19)."""
    found = [] if found is None else found
    if isinstance(schema, list):
        for item in schema:
            property_names(item, found)
        return found
    if not isinstance(schema, dict):
        return found
    properties = schema.get("properties")
    if isinstance(properties, dict):
        for name, child in properties.items():
            if name not in found:
                found.append(name)
            property_names(child, found)
    if "items" in schema:
        property_names(schema["items"], found)
    return found


def _is_scalar(value) -> bool:
    return value is None or isinstance(value, (str, int, float, bool))


def open_schema_reason(schema, path: str = "") -> str | None:
    """M-19: why a custom fields schema is not **closed**, or None."""
    where = path or "/"
    if not isinstance(schema, dict):
        return f"{where}: not an object schema"
    for keyword in COMBINATORS:
        if keyword in schema:
            return f"{where}: {keyword}"
    if "const" in schema:
        return (
            None if _is_scalar(schema["const"]) else f"{where}: const holds an object or an array"
        )
    if "enum" in schema:
        values = schema["enum"]
        if isinstance(values, list) and all(_is_scalar(value) for value in values):
            return None
        return f"{where}: enum holds an object or an array"
    declared = schema.get("type")
    if not isinstance(declared, str):
        return f"{where}: untyped"
    if declared == "object":
        properties = schema.get("properties")
        if not isinstance(properties, dict):
            return f"{where}: an object without properties"
        if schema.get("additionalProperties") is not False:
            return f"{where}: additionalProperties is not false"
        for name, child in properties.items():
            reason = open_schema_reason(child, f"{path}/{name}")
            if reason is not None:
                return reason
        return None
    if declared == "array":
        if "items" not in schema:
            return f"{where}: an array without items"
        return open_schema_reason(schema["items"], f"{path}/items")
    return None if declared in SCALAR_TYPES else f"{where}: type {declared}"


def custom_type(package_id: str, declaration: dict, schema, well_known=None) -> dict:
    """M-18, M-19: one custom type a package declares, qualified by its id; raises
    `MemoryTypeError` with the specification's code."""
    well_known = starter_types() if well_known is None else well_known
    local = declaration["id"]
    quoted = json.dumps(local, ensure_ascii=False)
    if not WELL_KNOWN_TYPE_ID.match(local):
        raise MemoryTypeError(
            "custom_type_reserved", f"custom type id {quoted} is not in the well-known form"
        )
    known = {t["id"] for t in well_known} | {
        alias["id"] for t in well_known for alias in t.get("legacy", [])
    }
    if local in known or local.startswith(RESERVED_FAMILIES):
        raise MemoryTypeError(
            "custom_type_reserved",
            f"custom type id {quoted} is a well-known id or in a reserved family",
        )
    properties = schema.get("properties") if isinstance(schema, dict) else None
    if (
        not isinstance(schema, dict)
        or schema.get("type") != "object"
        or not isinstance(properties, dict)
    ):
        raise MemoryTypeError(
            "custom_type_schema_open",
            f"custom type {local}: the schema must be an object schema with properties",
        )
    for name in properties:
        if name in RESERVED_KEYS:
            raise MemoryTypeError(
                "reserved_field_name", f"custom type {local}: {name} is a reserved key"
            )
    sealed_names = set(sealed_starter_names(well_known))
    for name in property_names(schema):
        if name in sealed_names:
            raise MemoryTypeError(
                "custom_type_shadows_sealed_type",
                f"custom type {local}: a property named {name} is a sealed field of a starter "
                "type; read that type by grant instead",
            )
    reason = open_schema_reason(schema)
    if reason is not None:
        raise MemoryTypeError(
            "custom_type_schema_open", f"custom type {local}: the schema is not closed ({reason})"
        )
    identity = list(declaration.get("identity", []))
    for pointer in identity:
        if not POINTER_RE.match(pointer):
            raise MemoryTypeError(
                "custom_type_schema_open",
                f"custom type {local}: identity pointer {pointer} is not a JSON Pointer",
            )
    return {
        "id": f"{package_id}:{local}",
        "display_name": declaration["display_name"],
        "description": declaration["description"],
        "schema": copy.deepcopy(schema),
        "sealed_fields": [],
        "identity": identity,
        "default_links": [],
        "display": {"title_from": None, "summary": [f"/{name}" for name in list(properties)[:4]]},
        "declared_by": {"kind": "package", "package_id": package_id},
    }


def custom_types_of(package_id: str, policy: dict, files: dict, well_known=None) -> list[dict]:
    from ..validation import parse_json

    declared = policy.get("memory_types") or []
    if len(declared) > 8:
        raise MemoryTypeError("custom_type_reserved", "a package declares at most 8 custom types")
    out = []
    for declaration in declared:
        data = files.get(declaration["schema"])
        if data is None:
            raise MemoryTypeError(
                "custom_type_schema_open",
                f"custom type {declaration['id']}: schema file {declaration['schema']} is not in "
                "the package",
            )
        schema = parse_json(data, declaration["schema"])
        out.append(custom_type(package_id, declaration, schema, well_known))
    return out


class TypeRegistry:
    """The types a host holds: the starter taxonomy plus a package's custom types (M-65)."""

    def __init__(self, types=None):
        self.types = {t["id"]: t for t in (types if types is not None else starter_types())}
        self.legacy = {
            alias["id"]: (type_def, alias)
            for type_def in self.types.values()
            for alias in type_def.get("legacy", [])
        }

    def get(self, type_id: str) -> dict | None:
        return self.types.get(type_id)

    def resolve(self, resource_type: str) -> dict | None:
        """A memory type id, or a legacy id answered by the type whose `legacy` names it."""
        if resource_type in self.legacy:
            return self.legacy[resource_type][0]
        return self.types.get(resource_type)

    def legacy_of(self, legacy_id: str):
        return self.legacy.get(legacy_id)

    def legacy_sealed(self, legacy_id: str) -> list[str]:
        """The legacy pointers whose record pointer the type seals (M-17)."""
        found = self.legacy.get(legacy_id)
        if found is None:
            return []
        type_def, alias = found
        return [old for old, new in alias["projection"].items() if new in type_def["sealed_fields"]]
