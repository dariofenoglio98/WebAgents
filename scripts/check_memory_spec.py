"""Validate the memory.v0 specification's examples against its machine contracts. Offline.

    agentpkg/.venv/bin/python scripts/check_memory_spec.py [--json]

Reads `spec/memory-v0.md`, the contracts under `spec/memory-v0/` and the two worked examples under
`spec/memory-v0/examples/`, and checks that every example record, export file, proposals document,
policy, tool, export declaration, plan grant and fixture answer is what the text says it is: the
frontmatter subset (M-7), the canonical order (M-9, M-57), the record schema, the type schemas of
the starter taxonomy, the sealed-value rules (M-4, M-24), the record view construction (M-16),
the agent tool schemas (M-48), the proposal checks in order with their codes (M-40, the sealed-value
scan of step 7 included, proposal by proposal), the custom-type rules (M-19), the schema patches
(applied in memory to copies of the agentpkg schemas, idempotently), the folder rules (M-55, M-58),
the import of an export with sealed values omitted (M-56, M-59, M-60), an export-then-import round
trip over every link form with a dangling target and the hub after "Forget everything" (M-57, M-59,
M-60), and the negative cases of §10 that need no runtime. It is also the reference reader and
writer of the record format: the worked examples were written with `record_to_document`.

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
RESERVED_FAMILIES = ("person.", "payment.", "agent.", "memory.")
SOURCE_KEYS = {
    "person": [],
    "package": ["package_id", "package_version", "run_id", "proposal", "accepted"],
    "agent": ["package_id", "package_version", "run_id"],
    "import": ["from", "imported"],
    "migration": ["from_type", "migrated"],
}
USAGE_USES = ("read", "proposed", "accepted", "agent_read", "agent_write")
SEALED_PLACEHOLDER = "sealed:omitted"
MIRROR_MARK = "<!-- memory.v0 links -->"
MIN_SEALED_LENGTH = 6
MAX_BODY_CHARS = 16384
MAX_AGENT_BODY_CHARS = 32768
RESERVED_TYPES = frozenset(["person.self", "agent.memory"])
MAX_FIELDS_CHARS = 16384
MAX_SCANNED_STRINGS = 1 << 20
AGENT_READ, AGENT_WRITE = "host.memory.agent.read", "host.memory.agent.write"
AGENT_TOOL_SCHEMAS = {
    AGENT_READ: ("memory-empty-input.schema.json", "memory-agent-read.output.schema.json"),
    AGENT_WRITE: ("memory-agent-write.input.schema.json", "memory-agent-write.output.schema.json"),
}
KEY_RE = re.compile(r"^([a-z][a-z0-9_]{0,63}):(?: (.*))?$")
PLAIN_RE = re.compile(r"^[^\"'\[\]{}#&*!|>%@,\s][^#]*$")
NUMBER_RE = re.compile(r"^-?(0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?$")
WIKILINK_RE = re.compile(r"\[\[([^\[\]|]+)(?:\|([^\[\]]+))?\]\]")
RECORD_ID_RE = re.compile(r"^(self|mem_[0-9a-f]{32}|agent_[0-9a-f]{16})$")
WELL_KNOWN_ID_RE = re.compile(r"^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$")
FENCE_RE = re.compile(r"^```([^\n]*)\n(.*?)^```\s*$", re.MULTILINE | re.DOTALL)
RULE_RE = re.compile(r"\bM-(\d+)\b")
RULE_DEF_RE = re.compile(r"^M-(\d+)\. ", re.MULTILINE)
CASE_RE = re.compile(r"^\| N(\d+) ", re.MULTILINE)


class FrontmatterError(ValueError):
    pass


class Refusal(ValueError):
    """A refusal with the code (and reason) the specification names, so a test can assert it."""

    def __init__(self, code: str, reason: str | None, message: str):
        self.code, self.reason = code, reason
        label = f"{code} ({reason})" if reason else code
        super().__init__(f"{label}: {message}")


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


def pointer_parts(pointer: str) -> list[str]:
    return [part.replace("~1", "/").replace("~0", "~") for part in pointer.split("/")[1:]]


def pointer_get(value, pointer: str, default=None):
    current = value
    for part in pointer_parts(pointer):
        if not isinstance(current, dict) or part not in current:
            return default
        current = current[part]
    return current


def pointer_set(value: dict, pointer: str, new) -> None:
    parts = pointer_parts(pointer)
    current = value
    for part in parts[:-1]:
        current = current.setdefault(part, {})
    current[parts[-1]] = new


def pointer_delete(value: dict, pointer: str) -> None:
    parts = pointer_parts(pointer)
    parent = pointer_get(value, "/" + "/".join(parts[:-1])) if len(parts) > 1 else value
    if isinstance(parent, dict):
        parent.pop(parts[-1], None)


def schema_at(schema: dict, pointer: str) -> dict | None:
    current = schema
    for part in pointer_parts(pointer):
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
    """M-55: the file stem of a title."""
    text = unicodedata.normalize("NFC", title)
    text = re.sub(r'[\\/:*?"<>|\[\]#^\x00-\x1f\x7f]', "-", text)
    text = re.sub(r"\s+", " ", text).strip(" .")
    return text[:100]


def stem_key(stem: str) -> str:
    """Stems are compared case-insensitively (M-55), as the file systems they land on do."""
    return unicodedata.normalize("NFC", stem).casefold()


def superseded_ids(records: list[dict]) -> set[str]:
    return {
        link["to"]
        for record in records
        for link in record.get("links", [])
        if link["rel"] == "supersedes"
    }


def stems_for(records: list[dict]) -> dict[str, str]:
    """Record id -> file stem (M-55): equal stems (case-insensitively) are ordered heads first,
    then by id; the first keeps the bare stem, the others get the id suffix."""
    superseded = superseded_ids(records)
    by_stem: dict[str, list[tuple[int, str, str]]] = {}
    for record in records:
        stem = stem_of(record["title"])
        by_stem.setdefault(stem_key(stem), []).append(
            (1 if record["id"] in superseded else 0, record["id"], stem)
        )
    result: dict[str, str] = {}
    for group in by_stem.values():
        for position, (_, record_id, stem) in enumerate(sorted(group)):
            if position == 0:
                result[record_id] = stem
            else:
                prefix = record_id.split("_", 1)[1][:8] if "_" in record_id else record_id[:8]
                result[record_id] = f"{stem} ({prefix})"
    return result


def canonical_links(links: list[dict]) -> list[dict]:
    """M-9: links sorted by relation in vocabulary order, then by target; duplicates dropped."""
    unique = {(link["rel"], link["to"]) for link in links}
    return [
        {"to": to, "rel": rel}
        for rel, to in sorted(unique, key=lambda pair: (RELATIONS.index(pair[0]), pair[1]))
    ]


def title_index(titles: dict[str, str]) -> dict[str, str]:
    """Title key (NFC, case-folded) -> record id, for the titles exactly one record carries."""
    groups: dict[str, list[str]] = {}
    for record_id, title in titles.items():
        groups.setdefault(stem_key(title), []).append(record_id)
    return {key: ids[0] for key, ids in groups.items() if len(ids) == 1}


def normalize_body_links(body: str, titles: dict[str, str]) -> str:
    """M-3 at write time: a bare `[[<id>]]` whose record exists gains the title as its alias; a
    plain link whose text is the title of exactly one record becomes `[[<id>|<text>]]` (the alias
    kept when given); anything else (a dangling id, text that names no record) is left as it is."""
    by_title = title_index(titles)

    def rewrite(match: re.Match) -> str:
        target, alias = match.group(1), match.group(2)
        if RECORD_ID_RE.match(target):
            if alias is None and target in titles:
                return f"[[{target}|{titles[target]}]]"
            return match.group(0)
        record_id = by_title.get(stem_key(target))
        if record_id is None:
            return match.group(0)
        return f"[[{record_id}|{alias or target}]]"

    return WIKILINK_RE.sub(rewrite, body)


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
            if pointer_get(fields, pointer) is not None:  # M-56: only a field that holds a value
                pointer_set(fields, pointer, SEALED_PLACEHOLDER)
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
    links = canonical_links(record.get("links", []))  # M-9: the stored order is canonical
    if links:
        if export:
            for relation in RELATIONS:
                targets = [link["to"] for link in links if link["rel"] == relation]
                if targets:
                    head[relation] = [f"[[{_link_target(to, stems)}]]" for to in targets]
        else:
            head["links"] = links
    head["source"] = order_source(record["source"])
    body = normalize_body_links(normalize_body(record.get("body", "")), titles)  # M-3, M-24
    if export:
        body = WIKILINK_RE.sub(lambda match: _export_wikilink(match, stems, titles), body)
        if links:
            mirror = [MIRROR_MARK, "## Links"]
            for link in links:
                mirror.append(f"- {link['rel']}: [[{_link_target(link['to'], stems)}]]")
            body = (body + "\n\n" if body else "") + "\n".join(mirror)
    text = "---\n" + write_frontmatter(head) + "\n---\n"
    if body:
        text += "\n" + body + "\n"
    return text


def _link_target(to: str, stems: dict[str, str]) -> str:
    """M-57: the target's stem, or the id itself for a dangling target (id form)."""
    return stems.get(to, to)


def _export_wikilink(match: re.Match, stems: dict[str, str], titles: dict[str, str]) -> str:
    target, alias = match.group(1), match.group(2)
    stem = stems.get(target)
    if stem is None:  # a dangling id (kept in id form, M-57) or plain text (M-3): unchanged
        return match.group(0)
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
    """Parse a stored document, or an export file (relations as properties, wikilinks by stem).

    `resolve` maps a stem key or a title key (M-55, case-folded; the imported set's stems first,
    then the store's unambiguous titles, M-59) to a record id, and `titles` a record id to its
    title. A link in id form is kept as that id, dangling or not (M-27, M-59); the mirror is
    stripped unread (M-57); a property item that names no record is kept in the body as text."""
    head_text, body = split_document(text)
    head = parse_frontmatter(head_text)
    resolve = resolve or {}
    titles = titles or {}
    record: dict = {}
    fields: dict = {}
    links: list[dict] = []
    unresolved: list[str] = []
    for key, value in head.items():
        if key in RELATIONS and export:
            if not isinstance(value, list):
                raise FrontmatterError(f"{key} must be a list of wikilinks")
            for item in value:
                match = WIKILINK_RE.fullmatch(item) if isinstance(item, str) else None
                if not match:
                    raise FrontmatterError(f"{key}: {item!r} is not a whole-value wikilink")
                target = match.group(1)
                if RECORD_ID_RE.match(target):  # id form: an edge, dangling or not
                    links.append({"to": target, "rel": key})
                    continue
                record_id = resolve.get(stem_key(target))
                if record_id is None:  # no record: not an edge; kept as body text, reported
                    unresolved.append(target)
                    continue
                links.append({"to": record_id, "rel": key})
        elif key in RESERVED:
            record[key] = value
        else:
            fields[key] = value
    body = normalize_body(body)
    if export:
        marker = body.find(MIRROR_MARK)
        if marker >= 0:  # generated on export, stripped on import, never read (M-57, M-59)
            body = body[:marker].rstrip()
        body = WIKILINK_RE.sub(lambda match: _import_wikilink(match, resolve, titles), body)
        if unresolved:
            kept = "\n".join(f"[[{text}]]" for text in unresolved)
            body = (body + "\n\n" if body else "") + kept
        if links:
            record["links"] = canonical_links(links)
    record["fields"] = fields
    record["body"] = body
    return record


def _import_wikilink(match: re.Match, resolve: dict[str, str], titles: dict[str, str]) -> str:
    """M-59: `[[<stem>]]` -> `[[<id>|<title>]]`, `[[<stem>|<alias>]]` -> `[[<id>|<alias>]]`; an
    id-form link (dangling or not) and text that names no record are left as written."""
    target, alias = match.group(1), match.group(2)
    if RECORD_ID_RE.match(target):
        return match.group(0)
    record_id = resolve.get(stem_key(target))
    if record_id is None:
        return match.group(0)
    return f"[[{record_id}|{alias or titles.get(record_id) or target}]]"


def merge_hub(store_hub: dict, imported: dict, now: str) -> dict:
    """M-59: the imported hub's title, fields, body and `updated` replace the store's; links are
    united (`updated` becomes `now` when the union adds a link the file did not carry); `created`
    is the earlier of the two; `source` stays `person`; the id stays `self`."""
    imported_links = canonical_links(imported.get("links", []))
    links = canonical_links([*imported_links, *store_hub.get("links", [])])
    merged = {
        **copy.deepcopy(imported),
        "id": "self",
        "created": min(store_hub["created"], imported["created"]),
        "source": {"kind": "person"},
    }
    if links != imported_links:
        merged["updated"] = now
    if links:
        merged["links"] = links
    else:
        merged.pop("links", None)
    return merged


def restore_placeholders(record: dict, stored: dict | None) -> dict:
    """M-59: a placeholder is removed before validation and restored from the store by id.

    Returns `{restored: [pointers], missing: [pointers]}`; a missing required pointer makes the
    record incomplete (the caller decides)."""
    restored, missing = [], []
    for pointer in record.get("sealed", []):
        if pointer_get(record["fields"], pointer) != SEALED_PLACEHOLDER:
            continue
        value = pointer_get(stored["fields"], pointer) if stored else None
        if value is None:
            pointer_delete(record["fields"], pointer)
            missing.append(pointer)
        else:
            pointer_set(record["fields"], pointer, value)
            restored.append(pointer)
    return {"restored": restored, "missing": missing}


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


def agent_document_id(package_id: str) -> str:
    """M-49: `agent_` + the first 16 hex characters of SHA-256(package id)."""
    return "agent_" + hashlib.sha256(package_id.encode("utf-8")).hexdigest()[:16]


def record_view_schema(type_def: dict) -> dict:
    """M-16: the record view schema of a type, built from the template."""
    template = json.loads((CONTRACTS / "memory-record-view.template.json").read_text())
    fields_schema = copy.deepcopy(type_def["schema"])
    fields_schema.pop("$schema", None)
    template["properties"]["type"] = {"const": type_def["id"]}
    template["properties"]["fields"] = fields_schema
    return template


def record_view(record: dict) -> dict:
    """M-15: what a `memory.read` tool returns for a granted record."""
    return {
        "id": record["id"],
        "type": record["type"],
        "title": record["title"],
        "fields": copy.deepcopy(record.get("fields", {})),
        "body": record.get("body", ""),
        "tags": list(record.get("tags", [])),
        "sealed": list(record.get("sealed", [])),
    }


def sealed_free_schema(type_def: dict, extra: tuple[str, ...] = ()) -> dict:
    """M-40 step 4: the type schema with the sealed pointers removed from `required`."""
    schema = copy.deepcopy(type_def["schema"])
    top_sealed = {
        pointer.split("/")[1]
        for pointer in (*type_def["sealed_fields"], *extra)
        if pointer.count("/") == 1
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
    """RFC 6902 `add` and `replace` over JSON Pointers, which is all the patches use.

    Idempotent: an `add` whose value is already there (a list member, or an equal key) is skipped,
    so the check keeps passing once T19 and T20 have applied the patches to the live schemas."""
    result = copy.deepcopy(document)
    for operation in patch:
        parts = pointer_parts(operation["path"])
        parent = result
        for part in parts[:-1]:
            parent = parent[int(part)] if isinstance(parent, list) else parent[part]
        last = parts[-1]
        value = operation["value"]
        if operation["op"] == "add":
            if isinstance(parent, list):
                if value in parent:
                    continue
                if last == "-":
                    parent.append(value)
                else:
                    parent.insert(int(last), value)
            else:
                if last in parent and parent[last] != value:
                    raise ValueError(f"{operation['path']} exists with a different value")
                parent[last] = value
        elif operation["op"] == "replace":
            if isinstance(parent, list):
                parent[int(last)] = value
            else:
                if last not in parent:
                    raise KeyError(operation["path"])
                parent[last] = value
        else:
            raise ValueError(f"unsupported op {operation['op']}")
    return result


# -- sealed values (M-36's scanner) -------------------------------------------------------------
def scan_strings(value, limit: int = MAX_SCANNED_STRINGS) -> list[str]:
    """Every string of a JSON value, keys included, lower-cased; iterative, no depth cut-off."""
    found: list[str] = []
    stack = [value]
    while stack:
        current = stack.pop()
        if isinstance(current, str):
            if len(found) >= limit:
                raise Refusal("permission_denied", "scan_incomplete", "too many strings to scan")
            found.append(current.lower())
        elif isinstance(current, dict):
            stack.extend(current.keys())
            stack.extend(current.values())
        elif isinstance(current, list):
            stack.extend(current)
    return found


def sealed_values_of(records: list[dict]) -> list[tuple[str, str, str]]:
    """The scan set of a run opened with these records (M-36): (record id, pointer, value)."""
    found = []
    for record in records:
        for pointer in record.get("sealed", []):
            value = pointer_get(record["fields"], pointer)
            if isinstance(value, str) and value != SEALED_PLACEHOLDER:
                found.append((record["id"], pointer, value))
    return found


def find_sealed(value, sealed_values) -> tuple[str, str] | None:
    strings = scan_strings(value)
    for record_id, pointer, sealed in sealed_values:
        needle = sealed.lower()
        if any(needle in text for text in strings):
            return record_id, pointer
    return None


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
        self.legacy = {
            legacy["id"]: (entry, legacy)
            for entry in self.taxonomy["types"]
            for legacy in entry.get("legacy", [])
        }
        self.sealed_names = sorted(
            {
                pointer.split("/")[1]
                for entry in self.taxonomy["types"]
                for pointer in entry["sealed_fields"]
                if pointer.count("/") == 1
            }
        )
        self.agent_tools = {
            binding: (load_json(CONTRACTS / inp), load_json(CONTRACTS / out))
            for binding, (inp, out) in AGENT_TOOL_SCHEMAS.items()
        }
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

    def resolve_resource_type(self, resource_type: str) -> dict:
        """A memory type id, or a legacy id answered by the type whose `legacy` names it (M-17)."""
        if resource_type in self.legacy:
            return self.legacy[resource_type][0]
        return self.type_of(resource_type)


def check_record(contracts: Contracts, record: dict, label: str) -> dict:
    """M-24 over a parsed record: schemas, sealed rules, caps, link shape. Returns the type."""
    validate(contracts.record, record, f"{label}: record schema")
    type_def = contracts.type_of(record["type"])
    validate(type_def["schema"], record["fields"], f"{label}: {type_def['display_name']} fields")
    sealed = record.get("sealed", [])
    missing = [pointer for pointer in type_def["sealed_fields"] if pointer not in sealed]
    if missing:
        raise ValueError(f"{label}: `sealed` must list every sealed pointer of the type {missing}")
    values: list[str] = []
    for pointer in sealed:
        value = pointer_get(record["fields"], pointer)
        if value is None:
            continue  # an optional sealed field that is absent (M-4)
        if value == SEALED_PLACEHOLDER:
            raise ValueError(f"{label}: sealed field {pointer} holds the export placeholder")
        if not isinstance(value, str) or len(value) < MIN_SEALED_LENGTH:
            raise ValueError(
                f"{label}: sealed field {pointer} is not a string of {MIN_SEALED_LENGTH}+ chars"
            )
        values.append(value.lower())
    haystack = " ".join([record["title"], *record.get("tags", []), record.get("body", "")]).lower()
    for value in values:
        if value in haystack:
            raise ValueError(f"{label}: a sealed value appears in the title, tags or body (M-4)")
    cap = MAX_AGENT_BODY_CHARS if record["scope"] == "agent" else MAX_BODY_CHARS  # M-3
    if len(record.get("body", "")) > cap:
        raise ValueError(f"{label}: body over {cap} characters (memory_record_too_large)")
    if len(canonical_json(record["fields"]).decode("utf-8")) > MAX_FIELDS_CHARS:
        raise ValueError(f"{label}: fields over {MAX_FIELDS_CHARS} characters (M-24)")
    for link in record.get("links", []):
        if link["to"] == record["id"]:
            raise ValueError(f"{label}: a record cannot link to itself")
    if record.get("links") and record["links"] != canonical_links(record["links"]):
        raise ValueError(f"{label}: links are not in canonical order (M-9)")
    for field in record["fields"]:
        if field in RESERVED:
            raise ValueError(f"{label}: reserved field name {field}")
    if record["type"] == "agent.memory":
        expected = agent_document_id(record["fields"]["package_id"])
        if record["id"] != expected:
            raise ValueError(f"{label}: an agent document's id must be {expected} (M-49)")
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
        if not WELL_KNOWN_ID_RE.fullmatch(entry["id"]):
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
        # M-19's name rule holds inside the taxonomy too: a sealed name is sealed wherever it is.
        if not entry["sealed_fields"]:
            clash = sorted(property_names(entry["schema"]) & set(contracts.sealed_names))
            if clash:
                raise ValueError(f"{label}: unsealed property named like a sealed field {clash}")
    if len(set(legacy_ids)) != len(legacy_ids):
        raise ValueError("a legacy id is claimed twice")
    self_type = contracts.types["person.self"]
    if self_type["sealed_fields"] or self_type["identity"]:
        raise ValueError("person.self has sealed or identity fields")
    agent_type = contracts.types["agent.memory"]
    if agent_type["sealed_fields"] or agent_type["default_links"]:
        raise ValueError("agent.memory has sealed fields or default links")
    return {
        "types": len(ids),
        "legacy_ids": legacy_ids,
        "sealed_types": [entry["id"] for entry in taxonomy["types"] if entry["sealed_fields"]],
        "sealed_names": contracts.sealed_names,
    }


def property_names(schema, found: set[str] | None = None) -> set[str]:
    """Every property name at any depth of a fields schema (M-19): the object's `properties`,
    nested objects and array items; no `$ref` exists in these schemas (M-13)."""
    found = set() if found is None else found
    if isinstance(schema, dict):
        props = schema.get("properties")
        if isinstance(props, dict):
            found.update(props)
            for value in props.values():
                property_names(value, found)
        property_names(schema.get("items"), found)
    elif isinstance(schema, list):
        for item in schema:
            property_names(item, found)
    return found


def check_custom_type(contracts: Contracts, declaration: dict, schema: dict) -> dict:
    """M-18, M-19: a package's custom type declaration, with its schema loaded. Raises Refusal.

    The policy schema comes first: a declaration that lists `sealed_fields` (or anything else
    `memory_types` does not admit) is `schema_validation` at validation, before any rule here."""
    type_id = str(declaration.get("id", "?"))
    try:
        validate(
            contracts.policy["properties"]["memory_types"]["items"],
            declaration,
            f"{type_id} declaration",
        )
    except ValueError as error:
        raise Refusal("schema_validation", None, str(error)) from None
    if type_id in contracts.types or type_id in contracts.legacy:
        raise Refusal("custom_type_reserved", None, f"{type_id} is a well-known id")
    if type_id.startswith(RESERVED_FAMILIES):
        raise Refusal("custom_type_reserved", None, f"{type_id} is in a reserved family")
    try:
        validate(contracts.type["$defs"]["fields_schema"], schema, f"{type_id} schema")
        Draft202012Validator.check_schema(schema)
    except ValueError as error:
        raise Refusal("schema_validation", None, str(error)) from None
    if schema_mentions(schema):
        raise Refusal("schema_validation", None, f"{type_id} schema uses $ref/$id")
    clash = sorted(property_names(schema) & set(contracts.sealed_names))
    if clash:
        raise Refusal(
            "custom_type_shadows_sealed_type",
            None,
            f"{type_id} has unsealed properties named like sealed fields {clash}",
        )
    return {"id": type_id, "schema_sha256": sha256_canonical(schema)}


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
        *((f"agent tool {b} input", s[0]) for b, s in contracts.agent_tools.items()),
        *((f"agent tool {b} output", s[1]) for b, s in contracts.agent_tools.items()),
    ):
        Draft202012Validator.check_schema(schema)
    kinds = contracts.policy["properties"]["permissions"]["items"]["properties"]["kind"]["enum"]
    if "memory.read" not in kinds or "memory.write" not in kinds or "personal.read" not in kinds:
        raise ValueError("policy kinds")
    formats = contracts.workflow["properties"]["exports"]["items"]["properties"]["format"]["enum"]
    if set(formats) != {"json", "text", "memory.proposal"} or len(formats) != 3:
        raise ValueError(f"export formats {formats}")
    decisions = contracts.bundle["properties"]["decisions"]["properties"]
    if "memory.read" not in decisions or "memory.write" not in decisions:
        raise ValueError("bundle decisions")
    # Applying a patch twice changes nothing (the live schemas will carry it after T19 and T20).
    for name, patched, patch in (
        ("policy", contracts.policy, "policy.schema.patch.json"),
        ("workflow", contracts.workflow, "workflow.schema.patch.json"),
        ("bundle", contracts.bundle, "policy-bundle-v0.schema.patch.json"),
    ):
        if apply_patch(patched, load_json(CONTRACTS / patch)) != patched:
            raise ValueError(f"the {name} patch is not idempotent")
    links = contracts.proposals["$defs"]["proposal"]["properties"]["links"]["items"]
    if "supersedes" in links["properties"]["rel"]["enum"]:
        raise ValueError("a proposal link may not carry supersedes (M-39)")
    # The body caps agree (M-3, M-51): what the agent write tool accepts is always committable.
    write_cap = contracts.agent_tools[AGENT_WRITE][0]["properties"]["body"]["maxLength"]
    scopes = contracts.record["allOf"][0]
    if (
        write_cap != MAX_AGENT_BODY_CHARS
        or contracts.record["properties"]["body"]["maxLength"] != MAX_AGENT_BODY_CHARS
        or scopes["then"]["properties"]["body"]["maxLength"] != MAX_AGENT_BODY_CHARS
        or scopes["else"]["properties"]["body"]["maxLength"] != MAX_BODY_CHARS
    ):
        raise ValueError("the agent write cap and the record body caps disagree (M-3, M-51)")
    declaration = contracts.policy["properties"]["memory_types"]["items"]
    if "sealed_fields" in declaration["properties"] or declaration["additionalProperties"]:
        raise ValueError("a custom type declaration admits sealed_fields (M-19)")
    # Backward compatibility: the shipped policies still validate under the patched schema.
    for package in ("webair", "literature-review", "meeting-agenda"):
        manifest = load_json(ROOT / "agents" / package / "MANIFEST.agent")
        validate(
            contracts.policy,
            load_json(ROOT / "agents" / package / manifest["policy"]),
            f"{package} policy under the patched schema",
        )
    return {
        "formats": formats,
        "policy_kinds": kinds,
        "idempotent": True,
        "body_caps": {"user": MAX_BODY_CHARS, "agent": MAX_AGENT_BODY_CHARS},
    }


def fenced_blocks(text: str) -> list[tuple[str, str]]:
    return [(match.group(1).strip(), match.group(2)) for match in FENCE_RE.finditer(text)]


def spec_records() -> tuple[list[tuple[str, str]], list[dict]]:
    """The fenced blocks of the spec and its `md memory.record` examples, parsed (the store)."""
    blocks = fenced_blocks(SPEC.read_text())
    return blocks, [document_to_record(c) for info, c in blocks if info == "md memory.record"]


def resolver_for(stems: dict[str, str], titles: dict[str, str]) -> dict[str, str]:
    """M-59: a stem of the set first, then a title exactly one record carries."""
    resolve = {stem_key(stem): record_id for record_id, stem in stems.items()}
    for key, record_id in title_index(titles).items():
        resolve.setdefault(key, record_id)
    return resolve


def check_spec_examples(contracts: Contracts) -> dict:
    blocks, records = spec_records()
    counts = {"memory.record": len(records), "memory.export": 0, "memory.proposals": 0}
    titles = {record["id"]: record["title"] for record in records}
    record_blocks = [content for info, content in blocks if info == "md memory.record"]
    for record, block in zip(records, record_blocks, strict=True):
        type_def = check_record(contracts, record, f"spec record {record.get('id')}")
        if record_to_document(record, type_def, titles=titles) != block:
            raise ValueError(f"spec record {record['id']} is not in canonical form (M-9)")
    stems = stems_for(records)
    resolve = resolver_for(stems, titles)
    profile = "mem_7c1f0a4e9b2d4c5e8f6a1b2c3d4e5f60"
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
                granted={profile: "travel.profile"},
                sealed_values=sealed_values_of(records),  # the spec's records are the store
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


def check_proposals(
    contracts: Contracts,
    document: dict,
    *,
    declared,
    granted: dict[str, str],
    sealed_values,
    label: str,
    targets: dict[str, dict] | None = None,
) -> dict:
    """M-40 in order: schema, declared type, no sealed field, sealed-free schema, target, links,
    no sealed value anywhere. Steps 1 and 7 run once over the document; steps 2 to 6 run proposal
    by proposal in index order (N19). `granted` maps the ids this run was granted to their type
    (M-12); `sealed_values` is the run's scan set (M-36); `targets` holds the store's records by
    id, so that an update is checked against its target's own `sealed` list (step 3). Raises
    `Refusal` with the code the spec names."""
    try:
        validate(contracts.proposals, document, f"{label}: proposals schema")
    except ValueError as error:
        raise Refusal("schema_validation", None, str(error)) from None
    for index, proposal in enumerate(document["proposals"]):
        where = f"{label}: proposal {index}"
        if proposal["type"] not in declared:
            raise Refusal(
                "permission_denied",
                "memory_proposal_type_undeclared",
                f"{where}: type {proposal['type']} not declared",
            )
        if proposal["type"] in RESERVED_TYPES:  # never proposable (M-22, M-49), M-40 step 2
            raise Refusal(
                "permission_denied",
                "memory_proposal_type_undeclared",
                f"{where}: a reserved type cannot be proposed",
            )
        type_def = contracts.type_of(proposal["type"])
        target_record = (targets or {}).get(proposal.get("target", ""))
        extra = tuple(target_record.get("sealed", [])) if target_record else ()
        for pointer in (*type_def["sealed_fields"], *extra):  # the target's additions too (M-40.3)
            if pointer_get(proposal["fields"], pointer) is not None:
                raise Refusal(
                    "schema_validation",
                    "memory_proposal_sealed_field",
                    f"{where}: carries sealed field {pointer}",
                )
        try:
            validate(sealed_free_schema(type_def, extra), proposal["fields"], f"{where}: fields")
        except ValueError as error:
            raise Refusal("schema_validation", None, str(error)) from None
        if proposal["action"] == "update":
            target = proposal["target"]
            if granted.get(target) != proposal["type"]:
                raise Refusal(
                    "permission_denied",
                    "memory_proposal_target_not_granted",
                    f"{where}: target {target} is not a granted record of type {proposal['type']}",
                )
        for link in proposal.get("links", []):
            to = link["to"]
            if to.startswith("#"):
                sibling = int(to[1:])
                if sibling == index or sibling >= len(document["proposals"]):
                    raise Refusal(
                        "schema_validation", None, f"{where}: link {to} names no other proposal"
                    )
            elif to != "self" and to not in granted:
                raise Refusal(
                    "permission_denied",
                    "memory_proposal_link_not_granted",
                    f"{where}: link to {to}, which this run was not granted",
                )
    hit = find_sealed(document, sealed_values)
    if hit is not None:
        raise Refusal(
            "permission_denied",
            "sealed_value_in_proposal",
            f"{label}: a sealed value of {hit[0]} at {hit[1]} appears in the document",
        )
    return {"proposals": len(document["proposals"])}


def check_views(contracts: Contracts) -> dict:
    hashes = {}
    for type_id, type_def in contracts.types.items():
        view = record_view_schema(type_def)
        Draft202012Validator.check_schema(view)
        if (
            view["properties"]["type"] != {"const": type_id}
            or "$schema" in view["properties"]["fields"]
            or "sealed" not in view["required"]
        ):
            raise ValueError(f"view of {type_id}")
        hashes[type_id] = sha256_canonical(view)
    return {"view_sha256": hashes}


def _check_tools(contracts: Contracts, folder: Path, policy: dict, label: str) -> dict:
    """M-33 and M-48 over a package's tool files; returns tool id -> definition."""
    permissions = {entry["id"]: entry for entry in policy["permissions"]}
    agent_permissions = [
        entry
        for entry in policy["permissions"]
        if entry["kind"] == "memory"
        if entry["resources"] == ["agent"]
    ]
    tools: dict[str, dict] = {}
    views_checked, agent_bindings, legacy_checked = [], [], []
    for path in sorted((folder / "tools").glob("*.tool.json")):
        tool = load_json(path)
        validate(contracts.tool, tool, f"{label} tool {path.name}")
        tools[tool["id"]] = tool
        binding = tool["binding"]
        if not binding.startswith(("host.memory.", "host.resource.")):
            continue
        if tool["execution"] != "local" or tool["domains"] or tool["approval_required"] is not True:
            raise ValueError(f"{path.name}: a memory tool is local, approved, with no domains")
        linked = [permissions[pid] for pid in tool["permissions"]]
        if len(linked) != 1:
            raise ValueError(f"{path.name}: must link exactly one permission")
        shipped_in = load_json(folder / tool["input_schema"])
        shipped_out = load_json(folder / tool["output_schema"])
        if binding in AGENT_TOOL_SCHEMAS:
            expected_in, expected_out = contracts.agent_tools[binding]
            if canonical_json(shipped_in) != canonical_json(expected_in) or canonical_json(
                shipped_out
            ) != canonical_json(expected_out):
                raise ValueError(
                    f"{path.name}: agent tool schemas differ (binding_schema_mismatch)"
                )
            if linked[0]["kind"] != "memory" or linked[0]["resources"] != ["agent"]:
                raise ValueError(f"{path.name}: must link the memory/agent permission (M-48)")
            if policy["memory"]["scope"] != "agent-scoped":
                raise ValueError(f"{path.name}: reserved agent binding outside agent-scoped")
            expected_effect = "read" if binding == AGENT_READ else "write"
            if tool["side_effects"] != expected_effect:
                raise ValueError(f"{path.name}: side_effects must be {expected_effect}")
            if (
                binding == AGENT_WRITE
                and policy["budget"]["max_calls_per_tool"].get(tool["id"]) != 1
            ):
                raise ValueError(
                    f"{path.name}: max_calls_per_tool must be 1 (agent_memory_write_cap)"
                )
            agent_bindings.append(binding)
            continue
        if canonical_json(shipped_in) != canonical_json(contracts.agent_tools[AGENT_READ][0]):
            raise ValueError(f"{path.name}: input schema is not the empty object")
        if tool["side_effects"] != "read":
            raise ValueError(f"{path.name}: a memory read has side_effects read")
        if binding.startswith("host.memory."):
            type_id = binding[len("host.memory.") :]
            type_def = contracts.type_of(type_id)
            if linked[0]["kind"] != "memory.read" or linked[0]["resources"] != [type_id]:
                raise ValueError(f"{path.name}: must link the memory.read permission of {type_id}")
            if canonical_json(shipped_out) != canonical_json(record_view_schema(type_def)):
                raise ValueError(
                    f"{path.name}: output schema is not the view of {type_id} "
                    "(binding_schema_mismatch)"
                )
            views_checked.append(type_id)
        else:
            legacy_id = binding[len("host.resource.") :]
            if legacy_id not in contracts.legacy:
                raise ValueError(f"{path.name}: {legacy_id} is not a legacy id of the taxonomy")
            if linked[0]["kind"] != "personal.read" or linked[0]["resources"] != [legacy_id]:
                raise ValueError(f"{path.name}: must link the personal.read permission")
            if canonical_json(shipped_out) != canonical_json(
                contracts.legacy[legacy_id][1]["schema"]
            ):
                raise ValueError(f"{path.name}: output schema is not the legacy schema (M-17)")
            legacy_checked.append(legacy_id)
    if policy["memory"]["scope"] == "agent-scoped" and not agent_permissions:
        raise ValueError(f"{label}: agent-scoped without the memory/agent permission (M-48)")
    if agent_permissions and policy["memory"]["scope"] != "agent-scoped":
        raise ValueError(f"{label}: a memory/agent permission outside agent-scoped")
    return {
        "tools": tools,
        "memory_read_types": views_checked,
        "legacy_types": legacy_checked,
        "agent_bindings": sorted(agent_bindings),
    }


def _check_fixtures(
    contracts: Contracts, folder: Path, tools: dict, grants: dict, by_id: dict, label: str
) -> dict:
    """Fixture answers are what the granted records give (M-62): the view, the legacy projection,
    the agent document's body."""
    answered, agent_write_body = [], None
    for path in sorted((folder / "fixture").glob("*.json")):
        answer = load_json(path)
        tool = tools.get(answer["tool"])
        if tool is None:
            raise ValueError(f"{path.name}: unknown tool {answer['tool']}")
        binding = tool["binding"]
        where = f"{label} fixture {path.name}"
        if binding == AGENT_READ:
            validate(contracts.agent_tools[binding][1], answer["output"], where)
            if answer["input"] != {}:
                raise ValueError(f"{where}: an agent read takes no arguments")
        elif binding == AGENT_WRITE:
            validate(contracts.agent_tools[binding][0], answer["input"], where)
            validate(contracts.agent_tools[binding][1], answer["output"], where)
            if answer["output"]["bytes"] != len(answer["input"]["body"].encode("utf-8")):
                raise ValueError(f"{where}: bytes is the UTF-8 size of the staged body")
            agent_write_body = answer["input"]["body"]
        else:
            if answer["input"] != {}:
                raise ValueError(f"{where}: a memory read takes no arguments")
            resource_type = binding.split(".", 2)[2]
            grant = next((g for g in grants.values() if g["resource_type"] == resource_type), None)
            if grant is None:
                raise ValueError(f"{where}: no plan grant for {resource_type}")
            record = by_id[grant["resource_id"]]
            if binding.startswith("host.memory."):
                validate(
                    record_view_schema(contracts.type_of(resource_type)), answer["output"], where
                )
                if answer["output"] != record_view(record):
                    raise ValueError(f"{where}: the answer is not the granted record's view (M-15)")
            else:
                type_def, legacy = contracts.legacy[resource_type]
                validate(legacy["schema"], answer["output"], where)
                projected = {}
                for old, new in legacy["projection"].items():
                    value = pointer_get(record["fields"], new)
                    if value is not None:
                        pointer_set(projected, old, value)
                if answer["output"] != projected:
                    raise ValueError(
                        f"{where}: the answer is not the projection of the record (M-17)"
                    )
        answered.append(answer["tool"])
    return {"fixtures": answered, "agent_write_body": agent_write_body}


def _check_grants(contracts: Contracts, folder: Path, policy: dict, by_id: dict, label: str):
    """`plan.grants.json`: the plan's resource grants (M-12), one per read permission."""
    permissions = {entry["id"]: entry for entry in policy["permissions"]}
    grants = {}
    for grant in load_json(folder / "plan.grants.json"):
        permission = permissions[grant["permission_id"]]
        if permission["kind"] not in ("memory.read", "personal.read"):
            raise ValueError(f"{label}: grant {grant['permission_id']} is not a read permission")
        if permission["resources"] != [grant["resource_type"]]:
            raise ValueError(f"{label}: grant {grant['permission_id']} names another type")
        type_def = contracts.resolve_resource_type(grant["resource_type"])
        record = by_id.get(grant["resource_id"])
        if record is None or record["type"] != type_def["id"]:
            raise ValueError(
                f"{label}: grant {grant['resource_id']} is not a stored record of the type"
            )
        grants[grant["resource_id"]] = {**grant, "type": type_def["id"]}
    return grants


def check_example_package(contracts: Contracts, folder: Path, *, package_name: str) -> dict:
    policy = load_json(folder / "policy.json")
    validate(contracts.policy, policy, f"{package_name} policy")
    reads = [e for e in policy["permissions"] if e["kind"] in ("memory.read", "personal.read")]
    writes = [entry for entry in policy["permissions"] if entry["kind"] == "memory.write"]
    for entry in reads + writes:
        for type_id in entry["resources"]:
            contracts.resolve_resource_type(type_id)
    if len(writes) > 1:
        raise ValueError("more than one memory.write permission")
    declared = tuple(writes[0]["resources"]) if writes else ()
    if set(declared) & RESERVED_TYPES or any(
        "agent.memory" in entry["resources"] for entry in reads
    ):
        raise ValueError("a memory permission names a reserved type (memory_type_reserved, M-38)")
    tools_report = _check_tools(contracts, folder, policy, package_name)
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
    if len(proposal_exports) != (1 if writes else 0) or (
        proposal_exports and proposal_exports[0]["path"] != "proposals.json"
    ):
        raise ValueError(
            "memory.write and the proposals.json export come together (memory_proposal_undeclared)"
        )
    # The memory folder is the store the run was opened with (M-36): its sealed values are the
    # scan set.
    folder_report, records = check_memory_folder(
        contracts, folder / "memory", label=f"{package_name} memory folder"
    )
    by_id = {record["id"]: record for record in records}
    grants = _check_grants(contracts, folder, policy, by_id, package_name)
    fixtures = _check_fixtures(
        contracts, folder, tools_report["tools"], grants, by_id, package_name
    )
    if fixtures["agent_write_body"] is not None:
        agent_id = agent_document_id(policy_package_id(folder))
        committed = by_id.get(agent_id)
        if committed is None or committed["body"] != normalize_body(fixtures["agent_write_body"]):
            raise ValueError(f"{package_name}: the committed agent document is not the staged body")
    proposals = load_json(folder / "proposals.json")
    check_proposals(
        contracts,
        proposals,
        declared=declared,
        granted={record_id: grant["type"] for record_id, grant in grants.items()},
        sealed_values=sealed_values_of(records),
        label=f"{package_name} proposals.json",
        targets=by_id,
    )
    report = {
        "memory_read_types": tools_report["memory_read_types"],
        "legacy_types": tools_report["legacy_types"],
        "agent_bindings": tools_report["agent_bindings"],
        "memory_write_types": list(declared),
        "granted": sorted(grants),
        "fixtures": fixtures["fixtures"],
        "proposals": len(proposals["proposals"]),
        "scan_set": len(sealed_values_of(records)),
        **folder_report,
    }
    omitted = folder / "memory-export-omitted"
    if omitted.exists():
        report["export_omitted"] = check_export_omitted(
            contracts, omitted, records, label=f"{package_name} omitted export"
        )
    return report


def policy_package_id(folder: Path) -> str:
    return load_json(folder / "package.json")["package_id"]


def _folder_files(folder: Path) -> tuple[list[Path], dict, dict, dict]:
    """The record files of a folder (only `<root>/index.md` is the index, M-55), the resolver
    (stems first, then unambiguous titles, M-59), the stems and the titles by id."""
    files = sorted(path for path in folder.rglob("*.md") if path != folder / "index.md")
    heads = {}
    for path in files:
        head_text, _ = split_document(path.read_text())
        heads[path] = parse_frontmatter(head_text)
    seen: set[str] = set()
    for path in heads:
        key = stem_key(path.stem)
        if key in seen:
            raise ValueError(f"{folder.name}: two files share the stem {path.stem!r} (M-55)")
        seen.add(key)
    stems = {head["id"]: path.stem for path, head in heads.items()}
    titles = {head["id"]: head["title"] for head in heads.values()}
    return files, resolver_for(stems, titles), stems, titles


def check_memory_folder(contracts: Contracts, folder: Path, *, label: str) -> tuple[dict, list]:
    files, resolve, file_stems, titles = _folder_files(folder)
    records: list[dict] = []
    for path in files:
        record = document_to_record(path.read_text(), export=True, resolve=resolve, titles=titles)
        check_record(contracts, record, f"{label} {path.name}")
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
        again = record_to_document(record, type_def, export=True, stems=stems, titles=titles)
        if again != path.read_text():
            raise ValueError(f"{label}: {path.name} is not in canonical export form (M-57)")
    ids = [record["id"] for record in records]
    if len(set(ids)) != len(ids):
        raise ValueError(f"{label}: duplicate ids")
    if ids.count("self") != 1:
        raise ValueError(f"{label}: exactly one self record expected (M-22)")
    by_id = {record["id"]: record for record in records}
    # Links: targets exist (no dangling links in the examples), supersedes acyclic, one superseder.
    superseded_by: dict[str, str] = {}
    for record in records:
        for link in record.get("links", []):
            if link["to"] not in by_id:
                raise ValueError(f"{label}: {record['id']} links to a missing record {link['to']}")
            if link["rel"] == "supersedes":
                if link["to"] in superseded_by:
                    raise ValueError(f"{label}: {link['to']} superseded twice")
                superseded_by[link["to"]] = record["id"]
        # M-3: a stored body is in its write-time form (id links with an alias; no plain link
        # that names exactly one record).
        if normalize_body_links(record.get("body", ""), titles) != record.get("body", ""):
            raise ValueError(f"{label}: {record['id']} holds a body link not resolved as M-3 says")
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
        record = by_id.get(entry["record_id"])
        if record is None or entry["use"] not in USAGE_USES:
            raise ValueError(f"{label}: usage entry {entry}")
        if entry["use"].startswith("agent_") != (record["scope"] == "agent"):
            raise ValueError(f"{label}: usage {entry['use']} on a {record['scope']} record")
    # M-29, M-61: `proposed` is dated at the run's `memory.proposed` event, which follows every
    # tool call of the run; `accepted` follows `proposed`.
    by_run: dict[str, dict[str, list[str]]] = {}
    for entry in usage:
        by_run.setdefault(entry["run_id"], {}).setdefault(entry["use"], []).append(entry["at"])
    for run_id, uses in by_run.items():
        calls = [at for use in ("read", "agent_read", "agent_write") for at in uses.get(use, [])]
        proposed, accepted = uses.get("proposed", []), uses.get("accepted", [])
        if calls and proposed and max(calls) > min(proposed):
            raise ValueError(f"{label}: run {run_id} has a tool call dated after `proposed`")
        if proposed and accepted and max(proposed) > min(accepted):
            raise ValueError(f"{label}: run {run_id} has `proposed` dated after `accepted`")
    report = {
        "records": len(records),
        "superseded": sorted(superseded_by),
        "usage_entries": len(usage),
        "sealed_records": sorted(r["id"] for r in records if sealed_values_of([r])),
    }
    return report, records


def check_export_omitted(contracts: Contracts, folder: Path, store: list[dict], *, label: str):
    """An export with sealed values omitted (M-56), imported into the store it came from (M-59):
    every placeholder is restored by id and every digest input is the stored one (M-60)."""
    by_id = {record["id"]: record for record in store}
    files, resolve, file_stems, titles = _folder_files(folder)
    restored, placeholders = 0, 0
    for path in files:
        record = document_to_record(path.read_text(), export=True, resolve=resolve, titles=titles)
        stored = by_id.get(record["id"])
        if stored is None:
            raise ValueError(f"{label}: {path.name} is not in the store")
        had = sum(
            pointer_get(record["fields"], p) == SEALED_PLACEHOLDER for p in record.get("sealed", [])
        )
        outcome = restore_placeholders(record, stored)
        if outcome["missing"]:
            raise ValueError(f"{label}: {path.name} could not be completed from the store")
        type_def = check_record(contracts, record, f"{label} {path.name}")
        digest_sha = sha256_canonical(type_def["schema"])
        if record_digest_input(record, digest_sha) != record_digest_input(stored, digest_sha):
            raise ValueError(f"{label}: {path.name} does not reproduce the stored digest input")
        # The file itself is the omitted form of the stored record (M-56), byte for byte.
        again = record_to_document(
            stored, type_def, export=True, stems=file_stems, titles=titles, omit_sealed=True
        )
        if again != path.read_text():
            raise ValueError(f"{label}: {path.name} is not the omitted export of the store (M-56)")
        placeholders += had
        restored += len(outcome["restored"])
    if len(files) != len(store):
        raise ValueError(f"{label}: {len(files)} files for {len(store)} stored records")
    if placeholders == 0:
        raise ValueError(f"{label}: no placeholder found; the example exercises nothing")
    return {"files": len(files), "placeholders": placeholders, "restored": restored}


def check_negative_cases(contracts: Contracts) -> dict:
    """The negative cases of §10 that need no runtime, over the WebAir example (M-64)."""
    folder = EXAMPLES / "webair-0.6.0"
    _, records = check_memory_folder(contracts, folder / "memory", label="negative cases")
    by_id = {record["id"]: record for record in records}
    policy = load_json(folder / "policy.json")
    grants = _check_grants(contracts, folder, policy, by_id, "negative cases")
    granted = {record_id: grant["type"] for record_id, grant in grants.items()}
    scan_set = sealed_values_of(records)
    base = load_json(folder / "proposals.json")
    identity = next(r for r in records if r["type"] == "person.identity")
    email = pointer_get(identity["fields"], "/email")
    cases = {}

    def expect(case: str, code: str, reason: str | None, document, **overrides):
        try:
            check_proposals(
                contracts,
                document,
                declared=overrides.get("declared", ("travel.preference", "travel.profile")),
                granted=overrides.get("granted", granted),
                sealed_values=scan_set,
                label=case,
            )
        except Refusal as refusal:
            if refusal.code != code or refusal.reason != reason:
                raise ValueError(f"{case}: got {refusal}, expected {code} ({reason})") from None
            cases[case] = f"{code} ({reason})" if reason else code
            return
        raise ValueError(f"{case}: accepted, expected {code}")

    def with_proposal(**changes):
        document = copy.deepcopy(base)
        document["proposals"][0].update(changes)
        return document

    def with_proposals(*changes: dict):
        document = copy.deepcopy(base)
        for proposal, change in zip(document["proposals"], changes, strict=True):
            proposal.update(change)
        return document

    expect(
        "N1",
        "permission_denied",
        "memory_proposal_type_undeclared",
        with_proposal(type="person.preference", fields={"domain": "x", "key": "y", "value": "z"}),
    )
    expect(
        "N2",
        "schema_validation",
        "memory_proposal_sealed_field",
        with_proposal(
            type="contact",
            fields={"given_name": "Sam", "family_name": "T", "email": "sam@example.com"},
        ),
        declared=("contact",),
    )
    expect(
        "N8",
        "permission_denied",
        "memory_proposal_target_not_granted",
        with_proposal(
            action="update",
            type="travel.profile",
            target="mem_ffffffffffffffffffffffffffffffff",
            fields=base["proposals"][1]["fields"],
        ),
    )
    expect("N9", "schema_validation", None, with_proposal(links=[{"to": "#9", "rel": "related"}]))
    expect(
        "N13",
        "permission_denied",
        "sealed_value_in_proposal",
        with_proposal(fields={"kind": "other", "value": email}),
    )
    expect(
        "N13 body",
        "permission_denied",
        "sealed_value_in_proposal",
        with_proposal(body=f"Contact: {email.upper()}"),
    )
    expect(
        "N14",
        "permission_denied",
        "memory_proposal_link_not_granted",
        with_proposal(links=[{"to": "mem_ffffffffffffffffffffffffffffffff", "rel": "related"}]),
    )
    expect(
        "N15",
        "schema_validation",
        None,
        with_proposal(links=[{"to": next(iter(granted)), "rel": "supersedes"}]),
    )
    # N19: steps 2-6 run proposal by proposal, so proposal 0's link (step 6) is reported before
    # proposal 1's undeclared type (step 2).
    expect(
        "N19",
        "permission_denied",
        "memory_proposal_link_not_granted",
        with_proposals(
            {"links": [{"to": "mem_ffffffffffffffffffffffffffffffff", "rel": "related"}]},
            {"type": "person.preference", "fields": {"domain": "x", "key": "y", "value": "z"}},
        ),
    )
    # Update target of another type than the proposal (M-40 step 5).
    card = next(r["id"] for r in records if r["type"] == "payment.card")
    expect(
        "update of another type",
        "permission_denied",
        "memory_proposal_target_not_granted",
        with_proposal(
            action="update",
            type="travel.profile",
            target=card,
            fields=base["proposals"][1]["fields"],
        ),
    )

    def expect_type(case: str, code: str, declaration: dict, schema: dict):
        try:
            check_custom_type(contracts, declaration, schema)
        except Refusal as refusal:
            if refusal.code != code:
                raise ValueError(f"{case}: got {refusal}, expected {code}") from None
            cases[case] = code
            return
        raise ValueError(f"{case}: accepted, expected {code}")

    loyalty = {
        "id": "loyalty.member",
        "display_name": "Loyalty member",
        "description": "x",
        "schema": "schemas/loyalty.schema.json",
    }
    expect_type(
        "N16",
        "custom_type_shadows_sealed_type",
        loyalty,
        {
            "type": "object",
            "properties": {"given_name": {"type": "string"}, "email": {"type": "string"}},
            "additionalProperties": False,
        },
    )
    expect_type(
        "N17",
        "custom_type_reserved",
        {**loyalty, "id": "contact"},
        {
            "type": "object",
            "properties": {"given_name": {"type": "string"}},
            "additionalProperties": False,
        },
    )
    expect_type(
        "N17 family",
        "custom_type_reserved",
        {**loyalty, "id": "person.loyalty"},
        {
            "type": "object",
            "properties": {"tier": {"type": "string"}},
            "additionalProperties": False,
        },
    )
    expect_type(  # the policy schema admits no `sealed_fields`: refused before M-19 runs
        "custom sealed",
        "schema_validation",
        {**loyalty, "sealed_fields": ["/tier"]},
        {
            "type": "object",
            "properties": {"tier": {"type": "string"}},
            "additionalProperties": False,
        },
    )
    expect_type(  # the name rule holds at any depth (M-19)
        "N16 nested",
        "custom_type_shadows_sealed_type",
        loyalty,
        {
            "type": "object",
            "properties": {
                "member": {"type": "object", "properties": {"email": {"type": "string"}}}
            },
            "additionalProperties": False,
        },
    )
    accepted = check_custom_type(
        contracts,
        loyalty,
        {
            "type": "object",
            "properties": {"tier": {"type": "string"}, "number": {"type": "string"}},
            "additionalProperties": False,
        },
    )
    cases["custom accepted"] = accepted["id"]
    # The body cap is per scope (M-3): an agent document of 20,000 characters is a valid record
    # (what the write tool staged is committable, M-51); a user record of that size is not.
    stamp = "2026-10-14T12:00:00Z"
    package_id = "org.example.notes"
    check_record(
        contracts,
        {
            "id": agent_document_id(package_id),
            "type": "agent.memory",
            "title": "Notes",
            "scope": "agent",
            "created": stamp,
            "updated": stamp,
            "source": {
                "kind": "agent",
                "package_id": package_id,
                "package_version": "1.0.0",
                "run_id": "run-1",
            },
            "fields": {"package_id": package_id},
            "body": "x" * 20000,
        },
        "agent document of 20,000 characters",
    )
    cases["agent body 20,000"] = "accepted"
    try:
        check_record(
            contracts,
            {
                "id": "mem_00000000000000000000000000000001",
                "type": "document.note",
                "title": "Long",
                "scope": "user",
                "created": stamp,
                "updated": stamp,
                "source": {"kind": "person"},
                "fields": {},
                "body": "x" * 20000,
            },
            "note of 20,000 characters",
        )
    except ValueError:
        cases["user body 20,000"] = "memory_record_too_large"
    else:
        raise ValueError("a user record of 20,000 characters was accepted")
    # The positive document passes with the same inputs, so the refusals above are the changes'.
    check_proposals(
        contracts,
        base,
        declared=("travel.preference", "travel.profile"),
        granted=granted,
        sealed_values=scan_set,
        label="positive",
    )
    return cases


def check_round_trip(contracts: Contracts) -> dict:
    """Export then import gives back the same record (M-60) for every link form: links stored
    in canonical order (M-9), a body alias equal to the title, another alias, no alias, a target
    whose stem differs from its title, a dangling target in the frontmatter and in the body, a
    plain-text link that names no record (M-3, M-57, M-59); a property item that names no record
    is kept as body text; and the hub after "Forget everything" is restored byte for byte."""
    _, store = spec_records()
    titles = {record["id"]: record["title"] for record in store}
    coffee = next(r["id"] for r in store if r["title"] == "Coffee: no sugar")  # stem differs
    profile = next(r["id"] for r in store if r["type"] == "research.profile")
    gone = "mem_ffffffffffffffffffffffffffffffff"  # a deleted record (M-25, M-27)
    stamp = "2026-10-14T14:00:00Z"
    note = {
        "id": "mem_0123456789abcdef0123456789abcdef",
        "type": "document.note",
        "title": "Round trip",
        "scope": "user",
        "created": stamp,
        "updated": stamp,
        "source": {"kind": "person"},
        "fields": {},
        "tags": ["check"],
        "links": [  # deliberately not in canonical order, with a duplicate and a dangling target
            {"to": "self", "rel": "related"},
            {"to": profile, "rel": "about"},
            {"to": gone, "rel": "derived_from"},
            {"to": coffee, "rel": "related"},
            {"to": "self", "rel": "related"},
        ],
        "body": (
            f"Alias equal to the title: [[{coffee}|Coffee: no sugar]].\n"
            f"Another alias: [[{profile}|my profile]].\n"
            "No alias: [[self]].\n"
            f"Deleted: [[{gone}|Gone]].\n"
            "Plain text that names no record: [[Shopping list]]."
        ),
    }
    type_def = contracts.type_of("document.note")
    # The write (M-24): the stored document, re-read; the body and the links are normalized.
    stored = document_to_record(record_to_document(note, type_def, titles=titles))
    check_record(contracts, stored, "round trip: stored note")
    expected_links = [
        {"to": profile, "rel": "about"},
        {"to": gone, "rel": "derived_from"},
        {"to": coffee, "rel": "related"},
        {"to": "self", "rel": "related"},
    ]
    if stored["links"] != expected_links:
        raise ValueError(f"stored links are not canonical: {stored['links']}")
    if "[[self|Dario]]" not in stored["body"] or f"[[{gone}|Gone]]" not in stored["body"]:
        raise ValueError("the write did not normalize the body links as M-3 says")
    # The export (M-57).
    records = [*store, stored]
    stems = stems_for(records)
    all_titles = {record["id"]: record["title"] for record in records}
    exported = record_to_document(stored, type_def, export=True, stems=stems, titles=all_titles)
    head, body = split_document(exported)
    properties = parse_frontmatter(head)
    if (
        properties.get("about") != ["[[Research profile]]"]
        or properties.get("derived_from") != [f"[[{gone}]]"]
        or properties.get("related") != ["[[Coffee- no sugar]]", "[[Dario]]"]
    ):
        raise ValueError(f"export properties: {properties}")
    for expected in (
        "[[Coffee- no sugar]]",
        "[[Research profile|my profile]]",
        "No alias: [[Dario]]",
        f"[[{gone}|Gone]]",
        "[[Shopping list]]",
        f"- derived_from: [[{gone}]]",
    ):
        if expected not in body:
            raise ValueError(f"export body lacks {expected!r}")
    # The import (M-59): the same record, byte for byte and in its digest input (M-60).
    resolve = resolver_for(stems, all_titles)
    imported = document_to_record(exported, export=True, resolve=resolve, titles=all_titles)
    check_record(contracts, imported, "round trip: imported note")
    digest_sha = sha256_canonical(type_def["schema"])
    if record_digest_input(imported, digest_sha) != record_digest_input(stored, digest_sha):
        raise ValueError("the import does not reproduce the digest input")
    if record_to_document(imported, type_def, titles=all_titles) != record_to_document(
        stored, type_def, titles=all_titles
    ):
        raise ValueError("the import does not reproduce the stored document")
    # A property item that names no record is kept as body text, not an edge (M-59).
    edited = exported.replace('about:\n  - "[[Research profile]]"', 'about:\n  - "[[Nobody]]"')
    from_edit = document_to_record(edited, export=True, resolve=resolve, titles=all_titles)
    if any(link["rel"] == "about" for link in from_edit["links"]) or not from_edit["body"].endswith(
        "[[Nobody]]"
    ):
        raise ValueError("an unresolved property item was not kept as body text")
    # The hub after "Forget everything" (M-22) then an import of the old export (M-59, M-60).
    hub = next(r for r in store if r["id"] == "self")
    fresh = {
        "id": "self",
        "type": "person.self",
        "title": "Me",
        "scope": "user",
        "created": "2026-10-14T15:00:00Z",
        "updated": "2026-10-14T15:00:00Z",
        "source": {"kind": "person"},
        "fields": {"display_name": "Me"},
        "body": "",
    }
    self_type = contracts.type_of("person.self")
    merged = merge_hub(fresh, hub, "2026-10-14T15:01:00Z")
    if record_to_document(merged, self_type) != record_to_document(hub, self_type):
        raise ValueError("the hub is not restored byte for byte after Forget everything")
    # The ordinary case: the store's hub is older and holds a link the file does not.
    older = {**copy.deepcopy(hub), "created": "2026-10-01T09:00:00Z"}
    older["links"] = [{"to": profile, "rel": "about"}]
    merged = merge_hub(older, hub, "2026-10-14T15:01:00Z")
    if merged["created"] != "2026-10-01T09:00:00Z" or merged["updated"] != "2026-10-14T15:01:00Z":
        raise ValueError(f"hub merge: {merged['created']} {merged['updated']}")
    if merged["links"] != [{"to": profile, "rel": "about"}]:
        raise ValueError("hub merge lost the store's link")
    return {
        "links": len(expected_links),
        "dangling": 1,
        "body_link_forms": 5,
        "hub_restored": True,
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
    cases = [int(number) for number in CASE_RE.findall(text)]
    if cases != list(range(1, len(cases) + 1)):
        raise ValueError(f"negative cases out of order: {cases}")
    return {"rules": definitions[-1], "d184_rows": len(rows), "negative_cases": len(cases)}


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
    report.run("negative_cases", lambda: check_negative_cases(contracts))
    report.run("round_trip", lambda: check_round_trip(contracts))
    report.run("rule_numbers", check_rule_numbers)
    output = {"passed": report.passed, "spec": str(SPEC.relative_to(ROOT)), "checks": report.checks}
    print(json.dumps(output, indent=2))
    return 0 if report.passed else 1


if __name__ == "__main__":
    sys.exit(main())
