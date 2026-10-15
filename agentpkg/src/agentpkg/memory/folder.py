"""A memory folder (§8, M-63): the Python reference's memory is an export folder given to
`agentpkg run --memory-dir`, with its sealed values in clear (the operator's choice) and the key
file `memory.key` inside it, generated when absent.

The folder is read with the import rules of M-59 (the mirror stripped unread, links by stem then
by title, an id-form link kept as that id), validated with the store's checks of M-24, and never
rewritten, except that a completed live run commits its package's agent document into
`agent.memory/` (M-50, M-63). `index.md` is not rewritten: it is for people and not
authoritative over the files (M-58). The CLI keeps no usage log (M-32 applies the rules it can).
"""

from __future__ import annotations

import base64
import copy
import json
import os
import secrets
import stat
from datetime import UTC, datetime
from pathlib import Path

from jsonschema import Draft202012Validator

from ..errors import ValidationError
from ..package import canonical_json
from .model import (
    AGENT_TYPE,
    MARKER_LINE_RE,
    MAX_AGENT_BODY_CHARS,
    MAX_BODY_CHARS,
    MAX_FIELDS_CHARS,
    MIN_SEALED_LENGTH,
    RESERVED_KEYS,
    SEALED_PLACEHOLDER,
    FrontmatterError,
    MemoryError_,
    agent_document_id,
    canonical_links,
    document_to_record,
    parse_frontmatter,
    pointer_delete,
    pointer_get,
    pointer_set,
    record_digest,
    record_to_document,
    record_view,
    resolver_for,
    sealed_pointer_schema,
    split_document,
    stem_key,
    stems_for,
)
from .proposals import sealed_free_schema
from .registry import TypeRegistry, contract, schema_sha256

KEY_FILE = "memory.key"
KEY_SCHEMA = "memory.v0 key"
INDEX_FILE = "index.md"
AGENT_FOLDER = AGENT_TYPE


def _now() -> str:
    return datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


def _b64url_decode(text: str) -> bytes:
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


def read_or_create_key(root: Path) -> bytes:
    """M-63: `{"schema": "memory.v0 key", "key": "<base64url of 32 random bytes>"}`, mode 0600,
    generated when absent; never followed through a symlink."""
    path = root / KEY_FILE
    if not path.exists() and not path.is_symlink():
        key = secrets.token_bytes(32)
        document = {"schema": KEY_SCHEMA, "key": base64.urlsafe_b64encode(key).decode().rstrip("=")}
        flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0)
        fd = os.open(path, flags, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as stream:
            stream.write(json.dumps(document) + "\n")
        return key
    if path.is_symlink() or not path.is_file():
        raise ValidationError(f"{path}: the memory key must be a regular file")
    if stat.S_IMODE(path.stat().st_mode) & 0o077:
        raise ValidationError(f"{path}: the memory key must not be readable by others (0600)")
    try:
        document = json.loads(path.read_text(encoding="utf-8"))
        key = _b64url_decode(document["key"])
    except (ValueError, KeyError, TypeError) as exc:
        raise ValidationError(f"{path}: not a memory.v0 key file") from exc
    if document.get("schema") != KEY_SCHEMA or len(key) != 32:
        raise ValidationError(f"{path}: not a memory.v0 key file")
    return key


def _first_error(schema: dict, instance) -> str | None:
    errors = sorted(
        Draft202012Validator(schema).iter_errors(instance),
        key=lambda error: tuple(str(part) for part in error.absolute_path),
    )
    if not errors:
        return None
    where = "/".join(str(part) for part in errors[0].absolute_path) or "<root>"
    return f"{where}: {errors[0].message}"


def check_record(record: dict, type_def: dict | None) -> None:
    """M-24 over a parsed record (the checks a read needs; a CLI folder is never written by a
    package): schemas, sealed rules, caps, links. Raises `MemoryError_`."""
    problem = _first_error(contract("memory-record.schema.json"), record)
    if problem is not None:
        raise MemoryError_("frontmatter_invalid", f"record {record.get('id')}: {problem}")
    if type_def is None:
        return
    problem = _first_error(type_def["schema"], record["fields"])
    if problem is not None:
        raise MemoryError_(
            "frontmatter_invalid", f"record {record['id']}: {type_def['display_name']} {problem}"
        )
    sealed = record.get("sealed", [])
    missing = [pointer for pointer in type_def["sealed_fields"] if pointer not in sealed]
    if missing:
        raise MemoryError_(
            "sealed_field_invalid", f"record {record['id']}: sealed must list {missing}"
        )
    values: list[str] = []
    for pointer in sealed:
        if sealed_pointer_schema(type_def["schema"], pointer) is None:
            raise MemoryError_(
                "sealed_field_invalid", f"record {record['id']}: {pointer} is not a string member"
            )
        value = pointer_get(record["fields"], pointer)
        if value is None:
            continue
        if not isinstance(value, str) or len(value) < MIN_SEALED_LENGTH:
            raise MemoryError_(
                "sealed_field_invalid",
                f"record {record['id']}: {pointer} is not a string of {MIN_SEALED_LENGTH}+ chars",
            )
        values.append(value.lower())
    haystack = " ".join([record["title"], *record.get("tags", []), record.get("body", "")]).lower()
    if any(value in haystack for value in values):
        raise MemoryError_(
            "sealed_value_in_text", f"record {record['id']}: a sealed value appears in the text"
        )
    agent = record["scope"] == "agent"
    if len(record.get("body", "")) > (MAX_AGENT_BODY_CHARS if agent else MAX_BODY_CHARS):
        raise MemoryError_("memory_record_too_large", f"record {record['id']}: body too long")
    if not agent and MARKER_LINE_RE.search(record.get("body", "")):
        raise MemoryError_(
            "body_reserved_marker", f"record {record['id']}: the body holds the mirror marker"
        )
    if len(canonical_json(record["fields"]).decode("utf-8")) > MAX_FIELDS_CHARS:
        raise MemoryError_("memory_record_too_large", f"record {record['id']}: fields too long")
    for field in record["fields"]:
        if field in RESERVED_KEYS:
            raise MemoryError_(
                "reserved_field_name", f"record {record['id']}: reserved field {field}"
            )
    if record["type"] == AGENT_TYPE:
        expected = agent_document_id(record["fields"]["package_id"])
        if record["id"] != expected:
            raise MemoryError_(
                "frontmatter_invalid", f"record {record['id']}: an agent document is {expected}"
            )


class MemoryFolder:
    """One memory folder, read once at the start of a run."""

    def __init__(self, root, *, types: TypeRegistry | None = None):
        root = Path(root)
        if root.is_symlink() or not root.is_dir():
            raise ValidationError(f"--memory-dir must be an existing directory: {root}")
        self.root = root
        self.types = types or TypeRegistry()
        self.key = read_or_create_key(root)
        self.paths: dict[str, Path] = {}
        self.records: dict[str, dict] = {}
        self.incomplete: set[str] = set()
        self._load()

    def _files(self) -> list[Path]:
        found = []
        for path in sorted(self.root.rglob("*.md")):
            relative = path.relative_to(self.root)
            if relative.as_posix() == INDEX_FILE:
                continue
            if any(part.startswith(".") for part in relative.parts):
                continue
            if path.is_symlink() or not path.is_file():
                raise ValidationError(f"{relative}: a memory folder holds regular files only")
            found.append(path)
        return found

    def _load(self) -> None:
        files = self._files()
        heads = {}
        for path in files:
            try:
                head_text, _ = split_document(path.read_text(encoding="utf-8"))
                heads[path] = parse_frontmatter(head_text)
            except FrontmatterError as exc:
                raise MemoryError_(
                    "frontmatter_invalid", f"{path.relative_to(self.root)}: {exc}"
                ) from None
        stems: dict[str, str] = {}
        titles: dict[str, str] = {}
        seen: set[str] = set()
        for path, head in heads.items():
            if stem_key(path.stem) in seen:
                raise MemoryError_(
                    "frontmatter_invalid", f"two files share the stem {path.stem!r} (M-55)"
                )
            seen.add(stem_key(path.stem))
            record_id = head.get("id")
            if not isinstance(record_id, str) or not isinstance(head.get("title"), str):
                raise MemoryError_(
                    "frontmatter_invalid",
                    f"{path.relative_to(self.root)}: a record needs an id and a title",
                )
            if record_id in stems:
                raise MemoryError_("frontmatter_invalid", f"two files hold the record {record_id}")
            stems[record_id] = path.stem
            titles[record_id] = head["title"]
        resolve = resolver_for(stems, titles)
        for path in files:
            try:
                record = document_to_record(
                    path.read_text(encoding="utf-8"), export=True, resolve=resolve, titles=titles
                )
            except FrontmatterError as exc:
                raise MemoryError_(
                    "frontmatter_invalid", f"{path.relative_to(self.root)}: {exc}"
                ) from None
            type_def = self.types.get(record.get("type", ""))
            incomplete = False
            if type_def is not None:
                # A placeholder is not a value (M-56): a field that holds one is missing here.
                for pointer in record.get("sealed", []):
                    if pointer_get(record["fields"], pointer) == SEALED_PLACEHOLDER:
                        pointer_delete(record["fields"], pointer)
                        incomplete = True
            if incomplete:
                # A required sealed value omitted from the folder: the record is kept, checked
                # without that requirement, and never granted (M-59).
                type_def = {**type_def, "schema": sealed_free_schema(type_def)}
            check_record(record, type_def)
            if incomplete:
                self.incomplete.add(record["id"])
            self.records[record["id"]] = record
            self.paths[record["id"]] = path

    # -- reads ---------------------------------------------------------------------------------
    def digest(self, record: dict) -> str:
        type_def = self.types.get(record["type"])
        schema = type_def["schema"] if type_def else {}
        return record_digest(record, schema_sha256(schema), self.key)

    def record(self, record_id: str) -> dict | None:
        found = self.records.get(record_id)
        return copy.deepcopy(found) if found is not None else None

    def grant(self, permission: dict, record_id: str) -> dict:
        """A `--memory-grant`: the record exists, is a user record of the permission's type
        (a legacy id resolves to its type, M-17) and has every sealed value readable."""
        resource_type = permission["resources"][0]
        record = self.records.get(record_id)
        type_def = self.types.resolve(resource_type)
        if type_def is None:
            raise ValidationError(
                f"memory_type_unknown: {permission['id']} names {resource_type}, which this "
                "host does not hold"
            )
        if record is None:
            raise ValidationError(f"resource_removed: the memory holds no record {record_id}")
        if record["scope"] != "user" or record["type"] != type_def["id"]:
            raise ValidationError(
                f"resource_selection_required: {record_id} is not a {type_def['id']} record"
            )
        if record_id in self.incomplete:
            raise ValidationError(
                f"resource_selection_required: {record_id} lacks a sealed value in this folder"
            )
        return {
            "permission_id": permission["id"],
            "resource_type": resource_type,
            "resource_id": record_id,
            "resource_digest": self.digest(record),
        }

    def scan_records(self) -> list[dict]:
        return [record for record in self.records.values() if record["scope"] == "user"]

    def view(self, record_id: str, granted) -> dict:
        return record_view(self.records[record_id], granted)

    def legacy_answer(self, record_id: str, legacy_id: str) -> dict:
        """M-17: the projection of the record's fields under its legacy type."""
        found = self.types.legacy_of(legacy_id)
        if found is None:
            raise ValidationError(f"memory_type_unknown: {legacy_id}")
        _, alias = found
        fields = self.records[record_id]["fields"]
        answer: dict = {}
        for old, new in alias["projection"].items():
            value = pointer_get(fields, new)
            if value is not None:
                pointer_set(answer, old, copy.deepcopy(value))
        return answer

    def agent_document(self, package_id: str) -> dict | None:
        record = self.records.get(agent_document_id(package_id))
        if record is None or record["scope"] != "agent":
            return None
        return {"body": record.get("body", ""), "updated": record["updated"]}

    # -- the one write: an agent document on completion (M-50, M-63) ----------------------------
    def commit_agent_document(self, package, run_id: str, body: str) -> Path:
        manifest = package.manifest
        package_id = manifest["package_id"]
        record_id = agent_document_id(package_id)
        now = _now()
        previous = self.records.get(record_id)
        record = {
            "id": record_id,
            "type": AGENT_TYPE,
            "title": manifest["name"],
            "scope": "agent",
            "created": previous["created"] if previous else now,
            "updated": now,
            "fields": {"package_id": package_id},
            "source": {
                "kind": "agent",
                "package_id": package_id,
                "package_version": manifest["version"],
                "run_id": run_id,
            },
            "body": body,
        }
        type_def = self.types.get(AGENT_TYPE)
        check_record(record, type_def)
        path = self.paths.get(record_id)
        if path is None:
            records = [*(r for r in self.records.values()), record]
            stem = stems_for(records)[record_id]
            folder = self.root / AGENT_FOLDER
            folder.mkdir(mode=0o700, exist_ok=True)
            path = folder / f"{stem}.md"
            if path.exists() or path.is_symlink():
                raise ValidationError(f"{path}: the agent document's file name is taken")
        text = record_to_document(record, type_def, export=True, stems={}, titles={})
        temporary = path.with_name(f".{path.name}.{secrets.token_hex(4)}.tmp")
        flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0)
        fd = os.open(temporary, flags, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as stream:
            stream.write(text)
        os.replace(temporary, path)
        self.records[record_id] = record
        self.paths[record_id] = path
        return path


__all__ = ["MemoryFolder", "canonical_links", "check_record", "read_or_create_key"]
