"""The memory.v0 record (spec/memory-v0.md §2, §3, §5, §8): the YAML subset, the canonical
document and its export form, the digest, body wikilinks and the record view.

Ported from the specification's reference reader and writer (`scripts/check_memory_spec.py`),
which stays the independent check of the worked examples; `tests/test_memory_model.py` holds both
to the same bytes. Nothing here touches a file or a key: `folder.py` reads and writes a memory
folder, `run.py` holds what one run sees.
"""

from __future__ import annotations

import copy
import hashlib
import hmac
import json
import re
import unicodedata
from datetime import datetime

from ..package import canonical_json

RELATIONS = ("about", "prefers", "pays_with", "belongs_to", "supersedes", "derived_from", "related")
RESERVED_KEYS = frozenset(
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
SELF_ID = "self"
SELF_TYPE = "person.self"
AGENT_TYPE = "agent.memory"
NOTE_TYPE = "document.note"
RESERVED_TYPES = frozenset([SELF_TYPE, AGENT_TYPE])
# The binding names a host answers from memory (§7.1, §7.4). Validation lets only the two
# reserved agent tools into `host.memory.agent.` (a `memory.read` of an `agent.` type is refused,
# D-235), so every scan point tells a record read from an agent tool by this prefix.
MEMORY_READ_BINDING_PREFIX = "host.memory."
LEGACY_READ_BINDING_PREFIX = "host.resource."
AGENT_BINDING_PREFIX = "host.memory.agent."
AGENT_TYPE_FAMILY = "agent."


def is_memory_binding(binding: str | None) -> bool:
    """A binding the memory host answers: a record read, a legacy read, or an agent tool."""
    return (binding or "").startswith((MEMORY_READ_BINDING_PREFIX, LEGACY_READ_BINDING_PREFIX))


def is_agent_binding(binding: str | None) -> bool:
    return (binding or "").startswith(AGENT_BINDING_PREFIX)


def is_record_read_binding(binding: str | None) -> bool:
    """`host.memory.<type>`: a read answered with a record view (M-15)."""
    return (binding or "").startswith(MEMORY_READ_BINDING_PREFIX) and not is_agent_binding(binding)


SEALED_PLACEHOLDER = "sealed:omitted"
MIRROR_MARK = "<!-- memory.v0 links -->"
MIN_SEALED_LENGTH = 6
MAX_BODY_CHARS = 16384
MAX_AGENT_BODY_CHARS = 32768
MAX_FIELDS_CHARS = 16384
MAX_STEM_CHARS = 100
MAX_STEM_BYTES = 200
MAX_PROPOSALS = 8
MAX_CUSTOM_TYPES_PER_PACKAGE = 8
DIGEST_SCHEMA = "memory-v0-record-digest"

KEY_RE = re.compile(r"^([a-z][a-z0-9_]{0,63}):(?: (.*))?$")
PLAIN_RE = re.compile(r"^[^\"'\[\]{}#&*!|>%@,\s][^#]*$")
NUMBER_RE = re.compile(r"^-?(0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?$")
WIKILINK_RE = re.compile(r"\[\[([^\[\]|]+)(?:\|([^\[\]]+))?\]\]")
# A body wikilink with the backslashes right before it: a link preceded by one is escaped text,
# never resolved and never an edge (M-3); an export adds one to every plain-text link, an import
# removes one (M-57, M-59).
BODY_LINK_RE = re.compile(r"(\\*)\[\[([^\[\]|]+)(?:\|([^\[\]]+))?\]\]")
RECORD_ID_RE = re.compile(r"^(self|mem_[0-9a-f]{32}|agent_[0-9a-f]{16})$")
WELL_KNOWN_TYPE_ID = re.compile(r"^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$")
POINTER_RE = re.compile(r"^(/[^/]+)+$")
# The mirror marker is reserved as a whole line (M-3), trailing whitespace ignored (D-228).
MARKER_LINE_RE = re.compile(r"(^|\n)<!-- memory\.v0 links -->[ \t]*(\r?\n|$)")
MIRROR_LINE_RE = re.compile(r"^- (" + "|".join(RELATIONS) + r"): \[\[[^\n]+\]\]$")
MISSING_RECORD_TEXT = "[[missing record]]"


class FrontmatterError(ValueError):
    """A file outside the YAML subset of M-7 (`frontmatter_invalid`, with the line)."""

    code = "frontmatter_invalid"


class MemoryError_(ValueError):  # noqa: N801 - `MemoryError` is a builtin
    """A refusal of a write or a read, with the store code the specification names (§7.7)."""

    def __init__(self, code: str, message: str):
        self.code = code
        super().__init__(f"{code}: {message}")


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
    if text == "{}":
        return {}
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
    items, current, quoted, index = [], [], False, 0
    while index < len(inner):
        char = inner[index]
        if quoted and char == "\\" and index + 1 < len(inner):
            current.append(char)
            current.append(inner[index + 1])
            index += 2
            continue
        if char == '"':
            quoted = not quoted
        if char == "," and not quoted:
            items.append("".join(current))
            current = []
        else:
            current.append(char)
        index += 1
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
                lines.append(f"{pad}{key}: {{}}")
            else:
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
            if not item:
                lines.append(f"{pad}- {{}}")
                continue
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


# -- documents, pointers, order ------------------------------------------------------------------
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
    """M-3: NFC, LF line endings, no trailing whitespace at the end."""
    return unicodedata.normalize("NFC", body.replace("\r\n", "\n")).rstrip()


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


def sealed_pointer_schema(schema: dict, pointer: str) -> dict | None:
    """M-24: a sealed pointer names a `string` member the schema declares at every step."""
    target = schema_at(schema, pointer)
    if not target or target.get("type") != "string":
        return None
    return target


def order_fields(fields: dict, schema: dict) -> dict:
    """M-9: declared order first (the schema's `properties`), then the rest by code point."""
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


def canonical_links(links: list[dict]) -> list[dict]:
    """M-9: links sorted by relation in vocabulary order, then by target; duplicates dropped."""
    unique = {(link["rel"], link["to"]) for link in links}
    return [
        {"to": to, "rel": rel}
        for rel, to in sorted(unique, key=lambda pair: (RELATIONS.index(pair[0]), pair[1]))
    ]


def instant(timestamp: str) -> datetime:
    """A frontmatter timestamp as an instant, compared as time and never as text."""
    return datetime.fromisoformat(timestamp.replace("Z", "+00:00"))


def code_points(text: str) -> int:
    """Every cap counts Unicode code points (D-212 amended); Python strings are code points."""
    return len(text)


# -- stems (M-55) --------------------------------------------------------------------------------
def stem_of(title: str) -> str:
    text = unicodedata.normalize("NFC", title)
    text = re.sub(r'[\\/:*?"<>|\[\]#^\x00-\x1f\x7f]', "-", text)
    text = re.sub(r"\s+", " ", text)[:MAX_STEM_CHARS]
    while len(text.encode()) > MAX_STEM_BYTES:
        text = text[:-1]
    return text.strip(" .") or "untitled"


def stem_suffix(record_id: str, *, full: bool = False) -> str:
    rest = record_id.split("_", 1)[1] if "_" in record_id else record_id
    return rest if full else rest[:8]


def stem_names(record_id: str, stem: str):
    if not RECORD_ID_RE.match(stem):
        yield stem
    yield f"{stem} ({stem_suffix(record_id)})"
    full = f"{stem} ({stem_suffix(record_id, full=True)})"
    yield full
    counter = 2
    while True:
        yield f"{full} ({counter})"
        counter += 1


def stem_key(stem: str) -> str:
    return unicodedata.normalize("NFC", stem).casefold()


def superseded_ids(records) -> set[str]:
    return {
        link["to"]
        for record in records
        for link in record.get("links", [])
        if link["rel"] == "supersedes"
    }


def stems_for(records: list[dict]) -> dict[str, str]:
    """Record id -> file name without `.md`, by one walk, heads first, then by id (M-55)."""
    superseded = superseded_ids(records)
    taken: set[str] = set()
    result: dict[str, str] = {}
    for record in sorted(records, key=lambda r: (r["id"] in superseded, r["id"])):
        for name in stem_names(record["id"], stem_of(record["title"])):
            if stem_key(name) not in taken:
                taken.add(stem_key(name))
                result[record["id"]] = name
                break
    return result


# -- body wikilinks (M-3, M-15, M-42, M-57, M-59) ------------------------------------------------
def title_index(titles: dict[str, str]) -> dict[str, str]:
    groups: dict[str, list[str]] = {}
    for record_id, title in titles.items():
        groups.setdefault(stem_key(title), []).append(record_id)
    return {key: ids[0] for key, ids in groups.items() if len(ids) == 1}


def alias_of(title: str) -> str:
    return re.sub(r"[\[\]|]", "-", title)


def normalize_body_links(body: str, titles: dict[str, str]) -> str:
    """M-3: the write-time resolution of a body written from an edit or an accepted proposal."""
    by_title = title_index(titles)

    def rewrite(match: re.Match) -> str:
        escapes, target, alias = match.group(1), match.group(2), match.group(3)
        if escapes:
            return match.group(0)
        if RECORD_ID_RE.match(target):
            if alias is None and target in titles:
                return f"[[{target}|{alias_of(titles[target])}]]"
            return match.group(0)
        record_id = by_title.get(stem_key(target))
        if record_id is None:
            return match.group(0)
        return f"[[{record_id}|{alias or target}]]"

    return BODY_LINK_RE.sub(rewrite, body)


def body_link_ids(body: str) -> list[str]:
    """The record ids a body links to (M-3): its unescaped wikilinks in id form."""
    return [
        match.group(2)
        for match in BODY_LINK_RE.finditer(body)
        if not match.group(1) and RECORD_ID_RE.match(match.group(2))
    ]


def _alias_is_id(alias: str) -> bool:
    """D-228 (T18 review 6, nit 2): an alias is id-shaped when its text before the first `|`
    is a well-formed record id."""
    return bool(RECORD_ID_RE.match(alias.split("|", 1)[0]))


def view_body(body: str, granted) -> tuple[str, list[tuple[str, str, str | None]]]:
    """M-15: the body a `memory.read` tool hands the run, and its link occurrences."""
    occurrences: list[tuple[str, str, str | None]] = []

    def rewrite(match: re.Match) -> str:
        escapes, target, alias = match.group(1), match.group(2), match.group(3)
        stored = match.group(0)
        if escapes or not RECORD_ID_RE.match(target) or target in granted:
            occurrences.append((stored, stored, None))
            return stored
        if alias is None:
            rendered = MISSING_RECORD_TEXT
        elif _alias_is_id(alias):
            rendered = f"\\[[{alias}]]"
        else:
            rendered = f"[[{alias}]]"
        occurrences.append((rendered, stored, target))
        return rendered

    return BODY_LINK_RE.sub(rewrite, body), occurrences


def restore_view_links(body: str, occurrences) -> tuple[str, list[str]]:
    """M-42 (`update`): the positional inverse of M-15."""
    positions: dict[str, list[int]] = {}
    for position, (rendered, _, _) in enumerate(occurrences):
        positions.setdefault(rendered, []).append(position)
    seen: dict[str, int] = {}
    restored: set[int] = set()

    def rewrite(match: re.Match) -> str:
        text = match.group(0)
        count = seen.get(text, 0)
        seen[text] = count + 1
        candidates = positions.get(text, [])
        if count >= len(candidates):
            return text
        restored.add(candidates[count])
        return occurrences[candidates[count]][1]

    body = BODY_LINK_RE.sub(rewrite, body)
    placed = {occurrences[position][2] for position in restored}
    carried = {target for _, _, target in occurrences if target is not None} - placed
    return body, sorted(carried)


def has_marker_line(body: str) -> bool:
    return bool(MARKER_LINE_RE.search(body))


# -- the document (M-9) and the export file (M-57) -----------------------------------------------
def record_to_document(
    record: dict,
    type_def: dict,
    *,
    export: bool = False,
    stems: dict[str, str] | None = None,
    titles: dict[str, str] | None = None,
    omit_sealed: bool = False,
    resolve_body: bool = True,
) -> str:
    """The canonical document of a record (M-9), or its export file (M-57).

    `resolve_body` applies M-3's write-time resolution to a stored `scope: user` body; a writer
    that stores a body already resolved (or a folder written back as it was read) passes False.
    """
    stems = stems or {}
    titles = titles or {}
    fields = order_fields(copy.deepcopy(record.get("fields", {})), type_def["schema"])
    if export and omit_sealed:
        for pointer in record.get("sealed", []):
            if pointer_get(fields, pointer) is not None:
                pointer_set(fields, pointer, SEALED_PLACEHOLDER)
    head: dict = {
        "id": record["id"],
        "type": record["type"],
        "title": record["title"],
        "scope": record["scope"],
        "created": record["created"],
        "updated": record["updated"],
    }
    if record.get("valid_until"):
        head["valid_until"] = record["valid_until"]
    if record.get("demo"):
        head["demo"] = True
    if record.get("tags"):
        head["tags"] = list(record["tags"])
    head.update(fields)
    if record.get("sealed"):
        head["sealed"] = list(record["sealed"])
    links = canonical_links(record.get("links", []))
    if links:
        if export:
            for relation in RELATIONS:
                targets = [link["to"] for link in links if link["rel"] == relation]
                if targets:
                    head[relation] = [f"[[{stems.get(to, to)}]]" for to in targets]
        else:
            head["links"] = links
    head["source"] = order_source(record["source"])
    body = normalize_body(record.get("body", ""))
    agent = record["scope"] == "agent"
    if not export and not agent and resolve_body:
        body = normalize_body_links(body, titles)
    if export and not agent:
        body = BODY_LINK_RE.sub(lambda match: _export_wikilink(match, stems, titles), body)
        if links:
            mirror = [MIRROR_MARK, "## Links"]
            for link in links:
                mirror.append(f"- {link['rel']}: [[{stems.get(link['to'], link['to'])}]]")
            body = (body + "\n\n" if body else "") + "\n".join(mirror)
    text = "---\n" + write_frontmatter(head) + "\n---\n"
    if body:
        text += "\n" + body + "\n"
    return text


def _export_wikilink(match: re.Match, stems: dict[str, str], titles: dict[str, str]) -> str:
    escapes, target, alias = match.group(1), match.group(2), match.group(3)
    if escapes or not RECORD_ID_RE.match(target):
        return "\\" + match.group(0)
    stem = stems.get(target)
    if stem is None:
        return match.group(0)
    if alias is None or alias == alias_of(titles.get(target, "")):
        return f"[[{stem}]]"
    return f"[[{stem}|{alias}]]"


def strip_mirror(body: str) -> str:
    """M-59: the mirror block, from the body's last marker line, removed unread."""
    lines = body.split("\n")
    marker = max((i for i, line in enumerate(lines) if line.rstrip() == MIRROR_MARK), default=-1)
    if marker < 0:
        return body
    end = marker + 1
    if end < len(lines) and lines[end] == "## Links":
        end += 1
    while end < len(lines) and MIRROR_LINE_RE.match(lines[end]):
        end += 1
    before, after = lines[:marker], lines[end:]
    while before and not before[-1].strip():
        before.pop()
    while after and not after[0].strip():
        after.pop(0)
    if before and after:
        return "\n".join([*before, "", *after])
    return "\n".join(before or after)


def _import_wikilink(match: re.Match, resolve: dict[str, str], titles: dict[str, str]) -> str:
    escapes, target, alias = match.group(1), match.group(2), match.group(3)
    if escapes:
        return match.group(0)[1:]
    if RECORD_ID_RE.match(target):
        return match.group(0)
    record_id = resolve.get(stem_key(target))
    if record_id is None:
        return match.group(0)
    return f"[[{record_id}|{alias or alias_of(titles.get(record_id) or target)}]]"


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
                if RECORD_ID_RE.match(target):
                    links.append({"to": target, "rel": key})
                    continue
                record_id = resolve.get(stem_key(target))
                if record_id is None:
                    unresolved.append(target)
                    continue
                links.append({"to": record_id, "rel": key})
        elif key in RESERVED_KEYS:
            record[key] = value
        else:
            fields[key] = value
    body = normalize_body(body)
    if export and record.get("scope") != "agent":
        body = strip_mirror(body)
        body = BODY_LINK_RE.sub(lambda match: _import_wikilink(match, resolve, titles), body)
        if unresolved:
            kept = "\n".join(f"[[{text}]]" for text in unresolved)
            body = (body + "\n\n" if body else "") + kept
        if links:
            record["links"] = canonical_links(links)
    record["fields"] = fields
    record["body"] = body
    return record


def resolver_for(stems: dict[str, str], titles: dict[str, str]) -> dict[str, str]:
    """M-59: a stem of the imported set first, then a title exactly one record carries."""
    resolve = {stem_key(stem): record_id for record_id, stem in stems.items()}
    for key, record_id in title_index(titles).items():
        resolve.setdefault(key, record_id)
    return resolve


def restore_placeholders(record: dict, stored: dict | None) -> dict:
    """M-59: a placeholder is removed before validation and restored from the store by id."""
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


# -- digest (M-11) and the record view (M-15) ----------------------------------------------------
def sha256_canonical(value) -> str:
    return hashlib.sha256(canonical_json(value)).hexdigest()


def record_digest_input(record: dict, type_schema_sha256: str) -> dict:
    return {
        "schema": DIGEST_SCHEMA,
        "id": record["id"],
        "type": record["type"],
        "type_schema_sha256": type_schema_sha256,
        "title": record["title"],
        "fields": record.get("fields", {}),
        "body": record.get("body", ""),
        "links": [{"to": link["to"], "rel": link["rel"]} for link in record.get("links", [])],
        "tags": list(record.get("tags", [])),
    }


def record_digest(record: dict, type_schema_sha256: str, key: bytes) -> str:
    """M-11: HMAC-SHA256 under the host's memory key of the canonical digest input."""
    message = canonical_json(record_digest_input(record, type_schema_sha256))
    return hmac.new(key, message, hashlib.sha256).hexdigest()


def agent_document_id(package_id: str) -> str:
    """M-49: `agent_` + the first 16 hex characters of SHA-256(package id)."""
    return "agent_" + hashlib.sha256(package_id.encode("utf-8")).hexdigest()[:16]


def record_view(record: dict, granted) -> dict:
    """M-15: what a `memory.read` tool returns for a granted record."""
    return {
        "id": record["id"],
        "type": record["type"],
        "title": record["title"],
        "fields": copy.deepcopy(record.get("fields", {})),
        "body": view_body(record.get("body", ""), granted)[0],
        "tags": list(record.get("tags", [])),
        "sealed": list(record.get("sealed", [])),
    }


def sealed_values_of(record: dict) -> list[tuple[str, str]]:
    """(pointer, value) for every sealed pointer of a record that holds a string value."""
    found = []
    for pointer in record.get("sealed", []):
        value = pointer_get(record.get("fields", {}), pointer)
        if isinstance(value, str) and value != SEALED_PLACEHOLDER:
            found.append((pointer, value))
    return found
