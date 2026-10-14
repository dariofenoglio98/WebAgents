"""Validate the memory.v0 specification's examples against its machine contracts. Offline.

    agentpkg/.venv/bin/python scripts/check_memory_spec.py [--json]

Reads `spec/memory-v0.md`, the contracts under `spec/memory-v0/` and the two worked examples under
`spec/memory-v0/examples/`, and checks that every example record, export file, proposals document,
policy, tool, export declaration and fixture answer is what the text says it is: the frontmatter
subset (M-7), the canonical order (M-9, M-57), the record schema, the type schemas of the starter
taxonomy, the sealed-value rules (M-4, M-24), the record view construction (M-16), the proposal
checks (M-40), the schema patches (applied in memory to copies of the agentpkg schemas) and the
folder rules (M-55, M-58). It is also the reference reader and writer of the record format: the
worked examples were written with `record_to_document`.

Prints a JSON report and exits 1 if any check fails. No network, no execution, no package built.
"""

from __future__ import annotations

import argparse
import copy
import hashlib
import json
import re
import sys
import unicodedata
from pathlib import Path

from agentpkg.package import canonical_json
from jsonschema import Draft202012Validator

ROOT = Path(__file__).resolve().parents[1]
SPEC = ROOT / "spec" / "memory-v0.md"
CONTRACTS = ROOT / "spec" / "memory-v0"
EXAMPLES = CONTRACTS / "examples"
AGENTPKG_SCHEMAS = ROOT / "agentpkg" / "src" / "agentpkg" / "schemas"
BUNDLE_SCHEMA = ROOT / "spec" / "extensions" / "policy-bundle-v0.schema.json"

RELATIONS = ("about", "prefers", "pays_with", "belongs_to", "supersedes", "derived_from", "related")
RESERVED = frozenset(
    [
        "id",
        "type",
        "title",
        "scope",
        "created",
        "updated",
        "valid_until",
        "source",
        "sealed",
        "links",
        "tags",
        "demo",
        "body",
        "memory",
        "aliases",
        "cssclasses",
        *RELATIONS,
    ]
)
SOURCE_KEYS = {
    "person": [],
    "package": ["package_id", "package_version", "run_id", "proposal", "accepted"],
    "agent": ["package_id", "package_version", "run_id"],
    "import": ["from", "imported"],
    "migration": ["from_type", "migrated"],
}
SEALED_PLACEHOLDER = "sealed:omitted"
MIRROR_MARK = "<!-- memory.v0 links -->"
MIN_SEALED_LENGTH = 6
MAX_BODY_BYTES = 16384
KEY_RE = re.compile(r"^([a-z][a-z0-9_]{0,63}):(?: (.*))?$")
PLAIN_RE = re.compile(r"^[^\"'\[\]{}#&*!|>%@,\s][^#]*$")
NUMBER_RE = re.compile(r"^-?(0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?$")
WIKILINK_RE = re.compile(r"\[\[([^\[\]|]+)(?:\|([^\[\]]+))?\]\]")
FENCE_RE = re.compile(r"^```([^\n]*)\n(.*?)^```\s*$", re.MULTILINE | re.DOTALL)
RULE_RE = re.compile(r"\bM-(\d+)\b")
RULE_DEF_RE = re.compile(r"^M-(\d+)\. ", re.MULTILINE)


class FrontmatterError(ValueError):
    pass


# -- the YAML subset (M-7) -----------------------------------------------------------------------
def _scalar(text: str, line: int):
    text = text.strip()
    if text.startswith('"'):
        try:
            value = json.loads(text)
        except json.JSONDecodeError as error:
            raise FrontmatterError(f"line {line}: bad quoted string ({error.msg})") from None
        if not isinstance(value, str):
            raise FrontmatterError(f"line {line}: a quoted scalar must be a string")
        return value
    if text.startswith("[") and text.endswith("]"):
        inner = text[1:-1].strip()
        if not inner:
            return []
        return [_scalar(item, line) for item in _split_flow(inner, line)]
    if not PLAIN_RE.match(text):
        raise FrontmatterError(f"line {line}: scalar outside the subset: {text[:40]!r}")
    if text in ("true", "false", "null") or NUMBER_RE.match(text):
        return json.loads(text)
    return text


def _split_flow(inner: str, line: int) -> list[str]:
    items, current, quoted = [], [], False
    for char in inner:
        if char == '"':
            quoted = not quoted
        if char == "," and not quoted:
            items.append("".join(current))
            current = []
        else:
            current.append(char)
    if quoted:
        raise FrontmatterError(f"line {line}: unterminated string in a flow sequence")
    items.append("".join(current))
    return [item.strip() for item in items]


def parse_frontmatter(text: str) -> dict:
    entries: list[tuple[int, int, str]] = []
    for number, raw in enumerate(text.split("\n"), 1):
        if raw.strip() == "":
            raise FrontmatterError(f"line {number}: blank line inside the frontmatter")
        if "\t" in raw:
            raise FrontmatterError(f"line {number}: tab")
        indent = len(raw) - len(raw.lstrip(" "))
        if indent % 2:
            raise FrontmatterError(f"line {number}: odd indentation")
        entries.append((number, indent, raw[indent:]))
    value, index = _mapping(entries, 0, 0)
    if index != len(entries):
        raise FrontmatterError(f"line {entries[index][0]}: unexpected content")
    return value


def _mapping(entries, index, indent):
    result: dict = {}
    while index < len(entries):
        number, found, content = entries[index]
        if found < indent or content.startswith("- "):
            break
        if found > indent:
            raise FrontmatterError(f"line {number}: unexpected indentation")
        match = KEY_RE.match(content)
        if not match:
            raise FrontmatterError(f"line {number}: expected `key: value`")
        key, rest = match.group(1), match.group(2)
        if key in result:
            raise FrontmatterError(f"line {number}: duplicate key {key}")
        if rest is None or rest == "":
            index += 1
            if index < len(entries) and entries[index][1] >= indent:
                _, nested, next_content = entries[index]
                if next_content.startswith("- ") and nested in (indent, indent + 2):
                    value, index = _sequence(entries, index, nested)
                elif nested == indent + 2 and not next_content.startswith("- "):
                    value, index = _mapping(entries, index, nested)
                else:
                    raise FrontmatterError(f"line {number}: {key} has no value")
            else:
                raise FrontmatterError(f"line {number}: {key} has no value")
        else:
            value = _scalar(rest, number)
            index += 1
        result[key] = value
    return result, index


def _sequence(entries, index, indent):
    items: list = []
    while index < len(entries):
        number, found, content = entries[index]
        if found != indent or not content.startswith("- "):
            break
        item = content[2:]
        if KEY_RE.match(item):
            entries[index] = (number, indent + 2, item)
            value, index = _mapping(entries, index, indent + 2)
        else:
            value = _scalar(item, number)
            index += 1
        items.append(value)
    return items, index


def _write_scalar(value) -> str:
    if isinstance(value, str):
        return json.dumps(value, ensure_ascii=False)
    if isinstance(value, bool) or value is None or isinstance(value, (int, float)):
        return json.dumps(value)
    raise FrontmatterError(f"not a scalar: {type(value).__name__}")


def _write_mapping(mapping: dict, indent: int) -> list[str]:
    lines: list[str] = []
    pad = " " * indent
    for key, value in mapping.items():
        if isinstance(value, dict):
            if not value:
                raise FrontmatterError(f"{key}: an empty mapping is outside the subset")
            lines.append(f"{pad}{key}:")
            lines.extend(_write_mapping(value, indent + 2))
        elif isinstance(value, list):
            if not value:
                lines.append(f"{pad}{key}: []")
            else:
                lines.append(f"{pad}{key}:")
                lines.extend(_write_sequence(value, indent + 2))
        else:
            lines.append(f"{pad}{key}: {_write_scalar(value)}")
    return lines


def _write_sequence(items: list, indent: int) -> list[str]:
    lines: list[str] = []
    pad = " " * indent
    for item in items:
        if isinstance(item, dict):
            nested = _write_mapping(item, indent + 2)
            lines.append(f"{pad}- {nested[0].lstrip(' ')}")
            lines.extend(nested[1:])
        elif isinstance(item, list):
            raise FrontmatterError("a sequence inside a sequence is outside the subset")
        else:
            lines.append(f"{pad}- {_write_scalar(item)}")
    return lines


def write_frontmatter(mapping: dict) -> str:
    return "\n".join(_write_mapping(mapping, 0))


# -- records ------------------------------------------------------------------------------------
def split_document(text: str) -> tuple[str, str]:
    if not text.startswith("---\n"):
        raise FrontmatterError("line 1: the file does not start with `---`")
    end = text.find("\n---\n", 3)
    if end < 0:
        if text.endswith("\n---"):
            return text[4:-4], ""
        raise FrontmatterError("the frontmatter is not closed by `---`")
    head = text[4:end]
    body = text[end + 5 :]
    if body.startswith("\n"):
        body = body[1:]
    return head, body


def normalize_body(body: str) -> str:
    body = unicodedata.normalize("NFC", body.replace("\r\n", "\n"))
    return body.rstrip()


def pointer_get(value, pointer: str, default=None):
    current = value
    for part in pointer.split("/")[1:]:
        part = part.replace("~1", "/").replace("~0", "~")
        if not isinstance(current, dict) or part not in current:
            return default
        current = current[part]
    return current


def schema_at(schema: dict, pointer: str) -> dict | None:
    current = schema
    for part in pointer.split("/")[1:]:
        props = current.get("properties") if isinstance(current, dict) else None
        if not isinstance(props, dict) or part not in props:
            return None
        current = props[part]
    return current if isinstance(current, dict) else None


def order_fields(fields: dict, schema: dict) -> dict:
    """Declared order first (the schema's `properties`), then the rest by code point (M-9)."""
    props = schema.get("properties") if isinstance(schema, dict) else None
    declared = list(props.keys()) if isinstance(props, dict) else []
    ordered: dict = {}
    for key in declared + sorted(key for key in fields if key not in declared):
        if key not in fields:
            continue
        value = fields[key]
        if isinstance(value, dict):
            value = order_fields(value, props.get(key, {}) if isinstance(props, dict) else {})
        elif isinstance(value, list):
            item_schema = (props.get(key, {}) if isinstance(props, dict) else {}).get("items", {})
            value = [
                order_fields(item, item_schema) if isinstance(item, dict) else item
                for item in value
            ]
        ordered[key] = value
    return ordered


def order_source(source: dict) -> dict:
    kind = source.get("kind")
    ordered = {"kind": kind}
    for key in SOURCE_KEYS.get(kind, []):
        if key in source:
            ordered[key] = source[key]
    for key in sorted(key for key in source if key not in ordered):
        ordered[key] = source[key]
    return ordered


def stem_of(title: str) -> str:
    text = unicodedata.normalize("NFC", title)
    text = re.sub(r'[\\/:*?"<>|\x00-\x1f\x7f]', "-", text)
    text = re.sub(r"\s+", " ", text).strip(" .")
    return text[:100]


def stems_for(records: list[dict]) -> dict[str, str]:
    """Record id -> file stem (M-55); a shared stem gets the id suffix after the first record."""
    by_stem: dict[str, list[str]] = {}
    for record in records:
        by_stem.setdefault(stem_of(record["title"]), []).append(record["id"])
    result: dict[str, str] = {}
    for stem, ids in by_stem.items():
        for position, record_id in enumerate(sorted(ids)):
            if position == 0:
                result[record_id] = stem
            else:
                prefix = record_id.split("_", 1)[1][:8] if "_" in record_id else record_id[:8]
                result[record_id] = f"{stem} ({prefix})"
    return result


def record_to_document(
    record: dict,
    type_def: dict,
    *,
    export: bool = False,
    stems: dict[str, str] | None = None,
    titles: dict[str, str] | None = None,
    omit_sealed: bool = False,
) -> str:
    """The canonical document of a record (M-9), or its export file (M-57)."""
    stems = stems or {}
    titles = titles or {}
    fields = order_fields(copy.deepcopy(record.get("fields", {})), type_def["schema"])
    if export and omit_sealed:
        for pointer in record.get("sealed", []):
            parent = (
                pointer_get(fields, pointer.rsplit("/", 1)[0]) if "/" in pointer[1:] else fields
            )
            if isinstance(parent, dict):
                parent[pointer.rsplit("/", 1)[1]] = SEALED_PLACEHOLDER
    head: dict = {
        "id": record["id"],
        "type": record["type"],
        "title": record["title"],
        "scope": record["scope"],
    }
    head["created"] = record["created"]
    head["updated"] = record["updated"]
    if record.get("valid_until"):
        head["valid_until"] = record["valid_until"]
    if record.get("demo"):
        head["demo"] = True
    if record.get("tags"):
        head["tags"] = list(record["tags"])
    head.update(fields)
    if record.get("sealed"):
        head["sealed"] = list(record["sealed"])
    links = record.get("links", [])
    if links:
        if export:
            for relation in RELATIONS:
                targets = [link["to"] for link in links if link["rel"] == relation]
                if targets:
                    head[relation] = [f"[[{_link_target(to, stems, titles)}]]" for to in targets]
        else:
            head["links"] = [{"to": link["to"], "rel": link["rel"]} for link in links]
    head["source"] = order_source(record["source"])
    body = normalize_body(record.get("body", ""))
    if export:
        body = WIKILINK_RE.sub(lambda match: _export_wikilink(match, stems, titles), body)
        if links:
            mirror = [MIRROR_MARK, "## Links"]
            for link in links:
                mirror.append(f"- {link['rel']}: [[{_link_target(link['to'], stems, titles)}]]")
            body = (body + "\n\n" if body else "") + "\n".join(mirror)
    text = "---\n" + write_frontmatter(head) + "\n---\n"
    if body:
        text += "\n" + body + "\n"
    return text


def _link_target(to: str, stems: dict[str, str], titles: dict[str, str]) -> str:
    return stems.get(to) or titles.get(to) or to


def _export_wikilink(match: re.Match, stems: dict[str, str], titles: dict[str, str]) -> str:
    target, alias = match.group(1), match.group(2)
    stem = stems.get(target)
    if stem is None:
        return f"[[{alias or titles.get(target) or target}]]"
    if alias is None or alias == titles.get(target):
        return f"[[{stem}]]"
    return f"[[{stem}|{alias}]]"


def document_to_record(
    text: str,
    *,
    export: bool = False,
    resolve: dict[str, str] | None = None,
    titles: dict[str, str] | None = None,
) -> dict:
    """Parse a stored document, or an export file (relations as properties, wikilinks by stem)."""
    head_text, body = split_document(text)
    head = parse_frontmatter(head_text)
    record: dict = {}
    fields: dict = {}
    links: list[dict] = []
    for key, value in head.items():
        if key in RELATIONS and export:
            if not isinstance(value, list):
                raise FrontmatterError(f"{key} must be a list of wikilinks")
            for item in value:
                match = WIKILINK_RE.fullmatch(item) if isinstance(item, str) else None
                if not match:
                    raise FrontmatterError(f"{key}: {item!r} is not a whole-value wikilink")
                target = (resolve or {}).get(match.group(1))
                if target is None:
                    raise FrontmatterError(f"{key}: unresolved link [[{match.group(1)}]]")
                links.append({"to": target, "rel": key})
        elif key in RESERVED:
            record[key] = value
        else:
            fields[key] = value
    body = normalize_body(body)
    if export:
        marker = body.find(MIRROR_MARK)
        if marker >= 0:
            mirror = body[marker:].rstrip()
            body = body[:marker].rstrip()
            inverse = resolve_inverse(resolve)
            expected = [MIRROR_MARK, "## Links"] + [
                f"- {link['rel']}: [[{inverse.get(link['to'], link['to'])}]]" for link in links
            ]
            if mirror != "\n".join(expected):
                raise FrontmatterError("the links mirror does not match the frontmatter links")
        body = WIKILINK_RE.sub(
            lambda match: _import_wikilink(match, resolve or {}, titles or {}), body
        )
        if links:
            record["links"] = links
    record["fields"] = fields
    record["body"] = body
    return record


def resolve_inverse(resolve: dict[str, str] | None) -> dict[str, str]:
    return {record_id: stem for stem, record_id in (resolve or {}).items()}


def _import_wikilink(match: re.Match, resolve: dict[str, str], titles: dict[str, str]) -> str:
    target, alias = match.group(1), match.group(2)
    record_id = resolve.get(target)
    if record_id is None:
        return match.group(0)
    return f"[[{record_id}|{alias or titles.get(record_id) or target}]]"


def record_digest_input(record: dict, type_schema_sha256: str) -> dict:
    return {
        "schema": "memory-v0-record-digest",
        "id": record["id"],
        "type": record["type"],
        "type_schema_sha256": type_schema_sha256,
        "title": record["title"],
        "fields": record.get("fields", {}),
        "body": record.get("body", ""),
        "links": [{"to": link["to"], "rel": link["rel"]} for link in record.get("links", [])],
        "tags": list(record.get("tags", [])),
    }


# -- types and views ----------------------------------------------------------------------------
def sha256_canonical(value) -> str:
    return hashlib.sha256(canonical_json(value)).hexdigest()


def record_view_schema(type_def: dict) -> dict:
    """M-16: the record view schema of a type, built from the template."""
    template = json.loads((CONTRACTS / "memory-record-view.template.json").read_text())
    fields_schema = copy.deepcopy(type_def["schema"])
    fields_schema.pop("$schema", None)
    template["properties"]["type"] = {"const": type_def["id"]}
    template["properties"]["fields"] = fields_schema
    return template


def sealed_free_schema(type_def: dict) -> dict:
    """M-40 step 4: the type schema with the sealed pointers removed from `required`."""
    schema = copy.deepcopy(type_def["schema"])
    top_sealed = {
        pointer.split("/")[1] for pointer in type_def["sealed_fields"] if pointer.count("/") == 1
    }
    if "required" in schema:
        schema["required"] = [name for name in schema["required"] if name not in top_sealed]
    return schema


def schema_mentions(schema, keywords=("$ref", "$id", "$dynamicRef", "$anchor")) -> bool:
    if isinstance(schema, dict):
        return any(key in keywords for key in schema) or any(
            schema_mentions(v, keywords) for v in schema.values()
        )
    if isinstance(schema, list):
        return any(schema_mentions(item, keywords) for item in schema)
    return False


def apply_patch(document, patch: list[dict]):
    """RFC 6902 `add` and `replace` over JSON Pointers, which is all the patches use."""
    result = copy.deepcopy(document)
    for operation in patch:
        parts = [
            part.replace("~1", "/").replace("~0", "~") for part in operation["path"].split("/")[1:]
        ]
        parent = result
        for part in parts[:-1]:
            parent = parent[int(part)] if isinstance(parent, list) else parent[part]
        last = parts[-1]
        if operation["op"] == "add":
            if isinstance(parent, list):
                if last == "-":
                    parent.append(operation["value"])
                else:
                    parent.insert(int(last), operation["value"])
            else:
                parent[last] = operation["value"]
        elif operation["op"] == "replace":
            if isinstance(parent, list):
                parent[int(last)] = operation["value"]
            else:
                if last not in parent:
                    raise KeyError(operation["path"])
                parent[last] = operation["value"]
        else:
            raise ValueError(f"unsupported op {operation['op']}")
    return result


# -- the report ----------------------------------------------------------------------------------
class Report:
    def __init__(self):
        self.checks: list[dict] = []

    def check(self, name: str, passed: bool, detail=None):
        self.checks.append({"name": name, "passed": bool(passed), "detail": detail})
        return passed

    def run(self, name: str, function):
        """Run `function`; an exception is a failed check with the message as its detail."""
        try:
            detail = function()
        except Exception as error:  # noqa: BLE001 - every failure is a report line
            return self.check(name, False, f"{type(error).__name__}: {error}")
        return self.check(name, True, detail)

    @property
    def passed(self) -> bool:
        return all(check["passed"] for check in self.checks)


def validate(schema: dict, instance, label: str) -> None:
    errors = sorted(Draft202012Validator(schema).iter_errors(instance), key=lambda e: list(e.path))
    if errors:
        first = errors[0]
        where = "/" + "/".join(str(part) for part in first.path)
        raise ValueError(f"{label}: {first.message} at {where}")


def load_json(path: Path):
    return json.loads(path.read_text())


class Contracts:
    def __init__(self):
        self.record = load_json(CONTRACTS / "memory-record.schema.json")
        self.type = load_json(CONTRACTS / "memory-type.schema.json")
        self.proposals = load_json(CONTRACTS / "memory-proposals.schema.json")
        self.taxonomy = load_json(CONTRACTS / "taxonomy.json")
        self.types = {entry["id"]: entry for entry in self.taxonomy["types"]}
        self.policy = apply_patch(
            load_json(AGENTPKG_SCHEMAS / "policy.schema.json"),
            load_json(CONTRACTS / "policy.schema.patch.json"),
        )
        self.workflow = apply_patch(
            load_json(AGENTPKG_SCHEMAS / "workflow.schema.json"),
            load_json(CONTRACTS / "workflow.schema.patch.json"),
        )
        self.bundle = apply_patch(
            load_json(BUNDLE_SCHEMA), load_json(CONTRACTS / "policy-bundle-v0.schema.patch.json")
        )
        self.tool = load_json(AGENTPKG_SCHEMAS / "tool.schema.json")

    def type_of(self, type_id: str) -> dict:
        if type_id in self.types:
            return self.types[type_id]
        raise ValueError(f"unknown type {type_id}")


def check_record(contracts: Contracts, record: dict, label: str) -> dict:
    """M-24 over a parsed record: schemas, sealed rules, link shape. Returns the type."""
    validate(contracts.record, record, f"{label}: record schema")
    type_def = contracts.type_of(record["type"])
    validate(type_def["schema"], record["fields"], f"{label}: {type_def['display_name']} fields")
    sealed = record.get("sealed", [])
    missing = [
        pointer
        for pointer in type_def["sealed_fields"]
        if pointer not in sealed and pointer_get(record["fields"], pointer) is not None
    ]
    if missing:
        raise ValueError(f"{label}: sealed must include the type's sealed fields {missing}")
    values: list[str] = []
    for pointer in sealed:
        value = pointer_get(record["fields"], pointer)
        if value is None:
            continue
        if not isinstance(value, str) or len(value) < MIN_SEALED_LENGTH:
            raise ValueError(
                f"{label}: sealed field {pointer} is not a string of {MIN_SEALED_LENGTH}+ chars"
            )
        values.append(value.lower())
    haystack = " ".join([record["title"], *record.get("tags", []), record.get("body", "")]).lower()
    for value in values:
        if value != SEALED_PLACEHOLDER and value in haystack:
            raise ValueError(f"{label}: a sealed value appears in the title, tags or body (M-4)")
    if len(record.get("body", "").encode("utf-8")) > MAX_BODY_BYTES:
        raise ValueError(f"{label}: body over {MAX_BODY_BYTES} bytes")
    for link in record.get("links", []):
        if link["to"] == record["id"]:
            raise ValueError(f"{label}: a record cannot link to itself")
    for field in record["fields"]:
        if field in RESERVED:
            raise ValueError(f"{label}: reserved field name {field}")
    return type_def


def check_taxonomy(contracts: Contracts) -> dict:
    taxonomy = contracts.taxonomy
    if taxonomy.get("schema") != "memory.v0 taxonomy":
        raise ValueError("taxonomy.schema")
    ids = [entry["id"] for entry in taxonomy["types"]]
    if len(set(ids)) != len(ids):
        raise ValueError("duplicate type ids")
    legacy_ids: list[str] = []
    for entry in taxonomy["types"]:
        label = f"type {entry['id']}"
        validate(contracts.type, entry, label)
        if not re.fullmatch(r"[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*", entry["id"]):
            raise ValueError(f"{label}: not a well-known id")
        Draft202012Validator.check_schema(entry["schema"])
        if schema_mentions(entry["schema"]):
            raise ValueError(f"{label}: schema uses $ref/$id")
        for pointer in entry["sealed_fields"]:
            target = schema_at(entry["schema"], pointer)
            if not target or target.get("type") != "string":
                raise ValueError(f"{label}: sealed {pointer} is not a string field of the schema")
        for pointer in (
            entry["identity"]
            + entry["display"]["summary"]
            + ([entry["display"]["title_from"]] if entry["display"]["title_from"] else [])
        ):
            if schema_at(entry["schema"], pointer) is None:
                raise ValueError(f"{label}: pointer {pointer} is not in the schema")
        for legacy in entry.get("legacy", []):
            legacy_ids.append(legacy["id"])
            Draft202012Validator.check_schema(legacy["schema"])
            for old, new in legacy["projection"].items():
                if (
                    schema_at(legacy["schema"], old) is None
                    or schema_at(entry["schema"], new) is None
                ):
                    raise ValueError(f"{label}: projection {old} -> {new} does not resolve")
        if entry["declared_by"] != {"kind": "spec"}:
            raise ValueError(f"{label}: starter types are declared by the spec")
    if len(set(legacy_ids)) != len(legacy_ids):
        raise ValueError("a legacy id is claimed twice")
    sealed_types = [entry for entry in taxonomy["types"] if entry["sealed_fields"]]
    for entry in taxonomy["types"]:
        if entry["sealed_fields"]:
            continue
        names = set(entry["schema"]["properties"])
        for sealed in sealed_types:
            if names and names >= set(sealed["schema"]["properties"]):
                raise ValueError(
                    f"{entry['id']} shadows the sealed type {sealed['id']} (M-19 would refuse it)"
                )
    self_type = contracts.types["person.self"]
    if self_type["sealed_fields"] or self_type["identity"]:
        raise ValueError("person.self has sealed or identity fields")
    agent_type = contracts.types["agent.memory"]
    if agent_type["sealed_fields"] or agent_type["default_links"]:
        raise ValueError("agent.memory has sealed fields or default links")
    return {
        "types": len(ids),
        "legacy_ids": legacy_ids,
        "sealed_types": [entry["id"] for entry in sealed_types],
    }


def check_legacy_against_webair(contracts: Contracts) -> dict:
    host = {
        entry["id"]: entry["schema"]
        for entry in load_json(ROOT / "demo" / "webair" / "host-resources.json")["types"]
    }
    compared = []
    for entry in contracts.taxonomy["types"]:
        for legacy in entry.get("legacy", []):
            shipped = load_json(
                ROOT / "agents" / "webair" / "schemas" / "host" / f"{legacy['id']}.schema.json"
            )
            if canonical_json(shipped) != canonical_json(legacy["schema"]) or canonical_json(
                host[legacy["id"]]
            ) != canonical_json(legacy["schema"]):
                raise ValueError(f"legacy schema {legacy['id']} differs from WebAir's")
            compared.append(legacy["id"])
    if len(compared) != 3:
        raise ValueError(f"expected 3 legacy ids, found {compared}")
    return {"compared": compared}


def check_patches(contracts: Contracts) -> dict:
    for name, schema in (
        ("policy", contracts.policy),
        ("workflow", contracts.workflow),
        ("bundle", contracts.bundle),
        ("record", contracts.record),
        ("type", contracts.type),
        ("proposals", contracts.proposals),
    ):
        Draft202012Validator.check_schema(schema)
    kinds = contracts.policy["properties"]["permissions"]["items"]["properties"]["kind"]["enum"]
    if "memory.read" not in kinds or "memory.write" not in kinds or "personal.read" not in kinds:
        raise ValueError("policy kinds")
    formats = contracts.workflow["properties"]["exports"]["items"]["properties"]["format"]["enum"]
    if formats != ["json", "text", "memory.proposal"]:
        raise ValueError(f"export formats {formats}")
    decisions = contracts.bundle["properties"]["decisions"]["properties"]
    if "memory.read" not in decisions or "memory.write" not in decisions:
        raise ValueError("bundle decisions")
    # Backward compatibility: the shipped policies still validate under the patched schema.
    for package in ("webair", "literature-review", "meeting-agenda"):
        manifest = load_json(ROOT / "agents" / package / "MANIFEST.agent")
        validate(
            contracts.policy,
            load_json(ROOT / "agents" / package / manifest["policy"]),
            f"{package} policy under the patched schema",
        )
    return {"formats": formats, "policy_kinds": kinds}


def fenced_blocks(text: str) -> list[tuple[str, str]]:
    return [(match.group(1).strip(), match.group(2)) for match in FENCE_RE.finditer(text)]


def check_spec_examples(contracts: Contracts) -> dict:
    text = SPEC.read_text()
    blocks = fenced_blocks(text)
    records: list[dict] = []
    counts = {"memory.record": 0, "memory.export": 0, "memory.proposals": 0}
    for info, content in blocks:
        if info == "md memory.record":
            record = document_to_record(content)
            type_def = check_record(contracts, record, f"spec record {record.get('id')}")
            canonical = record_to_document(record, type_def)
            if canonical != content:
                raise ValueError(f"spec record {record['id']} is not in canonical form (M-9)")
            records.append(record)
            counts["memory.record"] += 1
    titles = {record["id"]: record["title"] for record in records}
    stems = stems_for(records)
    resolve = {stem: record_id for record_id, stem in stems.items()}
    for info, content in blocks:
        if info == "md memory.export":
            record = document_to_record(content, export=True, resolve=resolve, titles=titles)
            type_def = check_record(contracts, record, f"spec export {record.get('id')}")
            # The export example is the §2.1 record plus a link to the §7.2 proposal's record.
            again = record_to_document(record, type_def, export=True, stems=stems, titles=titles)
            if again != content:
                raise ValueError(
                    f"spec export {record['id']} is not in canonical export form (M-57)"
                )
            counts["memory.export"] += 1
        elif info == "json memory.proposals":
            document = json.loads(content)
            check_proposals(
                contracts,
                document,
                declared=("travel.preference", "travel.profile"),
                granted=("mem_7c1f0a4e9b2d4c5e8f6a1b2c3d4e5f60",),
                label="spec proposals",
            )
            counts["memory.proposals"] += 1
    if (
        counts["memory.record"] < 12
        or counts["memory.export"] < 1
        or counts["memory.proposals"] < 1
    ):
        raise ValueError(f"too few examples found: {counts}")
    ids = [record["id"] for record in records]
    if len(set(ids)) != len(ids):
        raise ValueError("duplicate record ids among the spec examples")
    types_shown = {record["type"] for record in records}
    missing = set(contracts.types) - types_shown
    if missing:
        raise ValueError(f"no example record for {sorted(missing)}")
    return counts


def check_proposals(contracts: Contracts, document: dict, *, declared, granted, label: str) -> dict:
    """M-40 in order: schema, declared type, no sealed field, sealed-free schema, target, links."""
    validate(contracts.proposals, document, f"{label}: proposals schema")
    for index, proposal in enumerate(document["proposals"]):
        where = f"{label}: proposal {index}"
        if proposal["type"] not in declared:
            raise ValueError(
                f"{where}: type {proposal['type']} not declared (memory_proposal_type_undeclared)"
            )
        type_def = contracts.type_of(proposal["type"])
        for pointer in type_def["sealed_fields"]:
            if pointer_get(proposal["fields"], pointer) is not None:
                raise ValueError(
                    f"{where}: carries sealed field {pointer} (memory_proposal_sealed_field)"
                )
        validate(sealed_free_schema(type_def), proposal["fields"], f"{where}: fields")
        if proposal["action"] == "update" and proposal["target"] not in granted:
            raise ValueError(f"{where}: target not granted (memory_proposal_target_not_granted)")
        for link in proposal.get("links", []):
            to = link["to"]
            if to.startswith("#"):
                sibling = int(to[1:])
                if sibling == index or sibling >= len(document["proposals"]):
                    raise ValueError(f"{where}: link {to} names no other proposal")
            elif to != "self" and to not in granted:
                raise ValueError(f"{where}: link to {to}, which this run was not granted")
        if proposal["type"] == "agent.memory" or proposal["type"] == "person.self":
            raise ValueError(f"{where}: a reserved type cannot be proposed")
    return {"proposals": len(document["proposals"])}


def check_views(contracts: Contracts) -> dict:
    hashes = {}
    for type_id, type_def in contracts.types.items():
        view = record_view_schema(type_def)
        Draft202012Validator.check_schema(view)
        if (
            view["properties"]["type"] != {"const": type_id}
            or "$schema" in view["properties"]["fields"]
        ):
            raise ValueError(f"view of {type_id}")
        hashes[type_id] = sha256_canonical(view)
    return {"view_sha256": hashes}


def check_example_package(contracts: Contracts, folder: Path, *, package_name: str) -> dict:
    policy = load_json(folder / "policy.json")
    validate(contracts.policy, policy, f"{package_name} policy")
    permissions = {entry["id"]: entry for entry in policy["permissions"]}
    reads = [entry for entry in policy["permissions"] if entry["kind"] == "memory.read"]
    writes = [entry for entry in policy["permissions"] if entry["kind"] == "memory.write"]
    for entry in reads + writes:
        for type_id in entry["resources"]:
            contracts.type_of(type_id)
    if len(writes) > 1:
        raise ValueError("more than one memory.write permission")
    declared = tuple(writes[0]["resources"]) if writes else ()
    # Tools: a memory.read tool is local, takes the empty object, ships the type's view (M-33).
    tools = sorted((folder / "tools").glob("*.tool.json"))
    views_checked = []
    for path in tools:
        tool = load_json(path)
        validate(contracts.tool, tool, f"{package_name} tool {path.name}")
        if not tool["binding"].startswith("host.memory."):
            continue
        type_id = tool["binding"][len("host.memory.") :]
        type_def = contracts.type_of(type_id)
        if (
            tool["execution"] != "local"
            or tool["domains"]
            or tool["side_effects"] != "read"
            or tool["approval_required"] is not True
        ):
            raise ValueError(
                f"{path.name}: a memory read tool is local, read-only, approved, with no domains"
            )
        linked = [permissions[pid] for pid in tool["permissions"]]
        if (
            len(linked) != 1
            or linked[0]["kind"] != "memory.read"
            or linked[0]["resources"] != [type_id]
        ):
            raise ValueError(
                f"{path.name}: must link exactly the memory.read permission of {type_id}"
            )
        empty = load_json(folder / tool["input_schema"])
        if (
            empty != {"type": "object", "properties": {}, "additionalProperties": False}
            and empty.get("properties") != {}
        ):
            raise ValueError(f"{path.name}: input schema is not the empty object")
        shipped = load_json(folder / tool["output_schema"])
        if canonical_json(shipped) != canonical_json(record_view_schema(type_def)):
            raise ValueError(
                f"{path.name}: output schema is not the view of {type_id} (binding_schema_mismatch)"
            )
        views_checked.append(type_id)
    # Exports: one memory.proposal export at proposals.json iff memory.write is declared (M-38).
    exports_document = load_json(folder / "graph.exports.json")
    exports_schema = {
        "$schema": contracts.workflow["$schema"],
        "type": "object",
        "properties": {"exports": contracts.workflow["properties"]["exports"]},
        "required": ["exports"],
        "$defs": contracts.workflow.get("$defs", {}),
    }
    validate(exports_schema, exports_document, f"{package_name} exports")
    proposal_exports = [
        entry for entry in exports_document["exports"] if entry["format"] == "memory.proposal"
    ]
    if bool(writes) != (len(proposal_exports) == 1) or (
        proposal_exports and proposal_exports[0]["path"] != "proposals.json"
    ):
        raise ValueError(
            "memory.write and the proposals.json export come together (memory_proposal_undeclared)"
        )
    # Fixture answers validate against the view; their ids are what the run was granted.
    granted = []
    for path in sorted((folder / "fixture").glob("*.read.json")):
        answer = load_json(path)
        type_def = contracts.type_of(answer["output"]["type"])
        validate(
            record_view_schema(type_def), answer["output"], f"{package_name} fixture {path.name}"
        )
        if answer["input"] != {}:
            raise ValueError(f"{path.name}: a memory read takes no arguments")
        granted.append(answer["output"]["id"])
    proposals = load_json(folder / "proposals.json")
    check_proposals(
        contracts,
        proposals,
        declared=declared,
        granted=tuple(granted),
        label=f"{package_name} proposals.json",
    )
    folder_report = check_memory_folder(
        contracts, folder / "memory", label=f"{package_name} memory folder"
    )
    return {
        "memory_read_types": views_checked,
        "memory_write_types": list(declared),
        "granted": granted,
        "proposals": len(proposals["proposals"]),
        **folder_report,
    }


def check_memory_folder(contracts: Contracts, folder: Path, *, label: str) -> dict:
    files = sorted(path for path in folder.rglob("*.md") if path.name != "index.md")
    heads = {}
    for path in files:
        head_text, _ = split_document(path.read_text())
        head = parse_frontmatter(head_text)
        heads[path] = head
    resolve = {path.stem: head["id"] for path, head in heads.items()}
    if len(resolve) != len(files):
        raise ValueError(f"{label}: two files share a stem")
    titles = {head["id"]: head["title"] for head in heads.values()}
    records: list[dict] = []
    for path in files:
        record = document_to_record(path.read_text(), export=True, resolve=resolve, titles=titles)
        type_def = check_record(contracts, record, f"{label} {path.name}")
        if path.parent.name != record["type"].replace(":", "-"):
            raise ValueError(f"{label}: {path.name} is not in its type folder")
        records.append(record)
    stems = stems_for(records)
    for path, record in zip(files, records, strict=True):
        if stems[record["id"]] != path.stem:
            raise ValueError(
                f"{label}: {path.name} should be named {stems[record['id']]}.md (M-55)"
            )
        type_def = contracts.type_of(record["type"])
        omitted = any(
            pointer_get(record["fields"], pointer) == SEALED_PLACEHOLDER
            for pointer in record.get("sealed", [])
        )
        again = record_to_document(
            record, type_def, export=True, stems=stems, titles=titles, omit_sealed=omitted
        )
        if again != path.read_text():
            raise ValueError(f"{label}: {path.name} is not in canonical export form (M-57)")
    ids = [record["id"] for record in records]
    if len(set(ids)) != len(ids):
        raise ValueError(f"{label}: duplicate ids")
    if ids.count("self") != 1:
        raise ValueError(f"{label}: exactly one self record expected (M-22)")
    # Links: targets exist (no dangling links in the examples), supersedes acyclic, one superseder.
    by_id = {record["id"]: record for record in records}
    superseded_by: dict[str, str] = {}
    for record in records:
        for link in record.get("links", []):
            if link["to"] not in by_id:
                raise ValueError(f"{label}: {record['id']} links to a missing record {link['to']}")
            if link["rel"] == "supersedes":
                if link["to"] in superseded_by:
                    raise ValueError(f"{label}: {link['to']} superseded twice")
                superseded_by[link["to"]] = record["id"]
    for start in superseded_by:
        seen, current = set(), start
        while current in superseded_by:
            if current in seen:
                raise ValueError(f"{label}: supersedes cycle at {current}")
            seen.add(current)
            current = superseded_by[current]
    index_text = (folder / "index.md").read_text()
    for record in records:
        if f"[[{stems[record['id']]}]]" not in index_text or record["id"] not in index_text:
            raise ValueError(f"{label}: index.md does not list {record['id']}")
    usage_path = folder / "memory-usage.json"
    usage = load_json(usage_path) if usage_path.exists() else []
    for entry in usage:
        if entry["record_id"] not in by_id or entry["use"] not in (
            "read",
            "proposed",
            "accepted",
            "agent_read",
            "agent_write",
        ):
            raise ValueError(f"{label}: usage entry {entry}")
    return {
        "records": len(records),
        "superseded": sorted(superseded_by),
        "usage_entries": len(usage),
    }


def check_rule_numbers() -> dict:
    text = SPEC.read_text()
    definitions = [int(number) for number in RULE_DEF_RE.findall(text)]
    if definitions != sorted(definitions) or len(set(definitions)) != len(definitions):
        raise ValueError(f"rule definitions out of order or duplicated: {definitions}")
    if definitions != list(range(1, definitions[-1] + 1)):
        missing = sorted(set(range(1, definitions[-1] + 1)) - set(definitions))
        raise ValueError(f"missing rule definitions {missing}")
    cited = {int(number) for number in RULE_RE.findall(text)}
    unknown = sorted(number for number in cited if number not in set(definitions))
    if unknown:
        raise ValueError(f"cited rules without a definition: {unknown}")
    table_start = text.find("### 13.1")
    table_end = text.find("### 13.2")
    rows = [
        line
        for line in text[table_start:table_end].splitlines()
        if line.startswith("| ") and "M-" in line
    ]
    if len(rows) < 12:
        raise ValueError(f"the D-184 table has {len(rows)} rows")
    return {"rules": definitions[-1], "d184_rows": len(rows)}


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--json", action="store_true", help="print the report as JSON (default)")
    parser.parse_args(argv)
    report = Report()
    try:
        contracts = Contracts()
    except Exception as error:  # noqa: BLE001
        report.check("contracts_load", False, f"{type(error).__name__}: {error}")
        print(json.dumps({"passed": False, "checks": report.checks}, indent=2))
        return 1
    report.check("contracts_load", True, {"types": len(contracts.types)})
    report.run("taxonomy", lambda: check_taxonomy(contracts))
    report.run("legacy_schemas_match_webair", lambda: check_legacy_against_webair(contracts))
    report.run("patches_apply_and_keep_old_policies_valid", lambda: check_patches(contracts))
    report.run("record_views", lambda: check_views(contracts))
    report.run("spec_examples", lambda: check_spec_examples(contracts))
    report.run(
        "example_webair_0_6_0",
        lambda: check_example_package(
            contracts, EXAMPLES / "webair-0.6.0", package_name="WebAir 0.6.0"
        ),
    )
    report.run(
        "example_literature_review_0_2_8",
        lambda: check_example_package(
            contracts, EXAMPLES / "literature-review-0.2.8", package_name="Literature Review 0.2.8"
        ),
    )
    report.run("rule_numbers", check_rule_numbers)
    output = {"passed": report.passed, "spec": str(SPEC.relative_to(ROOT)), "checks": report.checks}
    print(json.dumps(output, indent=2))
    return 0 if report.passed else 1


if __name__ == "__main__":
    sys.exit(main())
