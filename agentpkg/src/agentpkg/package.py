"""Deterministic data-only artifacts and safe source/archive loading."""

from __future__ import annotations

import hashlib
import io
import os
import re
import stat
import struct
import zipfile
from dataclasses import dataclass
from pathlib import Path, PurePosixPath

import rfc8785

from .errors import IntegrityError, ValidationError
from .validation import parse_json, validate_document, validate_payload

MAX_FILES = 256
MAX_MEMBER_BYTES = 8 * 1024 * 1024
MAX_TOTAL_BYTES = 32 * 1024 * 1024
INTEGRITY_PATH = "integrity.json"
SIGNATURE_PATH = "signatures/publisher.json"
ENVELOPE = {INTEGRITY_PATH, SIGNATURE_PATH}
ALLOWED_SUFFIXES = {".json", ".md", ".txt", ".bib", ".csv"}
# compute.v0 (agentpkg 0.5.0): the one binary member class, a WebAssembly core module. It is
# admitted by its header, bounded, and must be declared in the graph with its SHA-256; the
# graph's reader then decides whether it is a tier-1 module (`agentpkg.compute`).
BINARY_SUFFIXES = {".wasm"}
WASM_HEADER = b"\x00asm\x01\x00\x00\x00"
PORTABLE_PATH = re.compile(r"^[A-Za-z0-9_-][A-Za-z0-9_.-]*(?:/[A-Za-z0-9_-][A-Za-z0-9_.-]*)*$")
WINDOWS_RESERVED = {
    "CON",
    "PRN",
    "AUX",
    "NUL",
    *(f"COM{x}" for x in range(1, 10)),
    *(f"LPT{x}" for x in range(1, 10)),
}


def canonical_json(value) -> bytes:
    """RFC 8785 JSON Canonicalization Scheme, including ECMAScript numbers."""
    try:
        return rfc8785.dumps(value)
    except (ValueError, TypeError, RecursionError) as exc:
        raise ValidationError(f"value cannot be represented as canonical JCS JSON: {exc}") from exc


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _safe_name(name: str):
    if len(name) > 240 or not PORTABLE_PATH.fullmatch(name):
        raise ValidationError(f"unsafe/nonportable package path: {name!r}")
    for part in name.split("/"):
        if part.endswith(".") or part.split(".")[0].upper() in WINDOWS_RESERVED:
            raise ValidationError(f"nonportable reserved path component: {part!r}")
        if part.lower() in {"node_modules", "venv", "__pycache__", "id_rsa", "id_ed25519"}:
            raise ValidationError(f"forbidden package directory/file: {part!r}")
    if (
        name != "MANIFEST.agent"
        and PurePosixPath(name).suffix.lower() not in ALLOWED_SUFFIXES | BINARY_SUFFIXES
    ):
        raise ValidationError(
            f"{name}: only declared UTF-8 data formats allowed, never executable payloads"
        )
    if re.search(r"(?:^|[/_.-])(?:private[-_]?key|secrets?|credentials)(?:[/_.-]|$)", name, re.I):
        raise ValidationError(f"{name}: private credentials must remain outside the package")


def _check_payload(files, *, envelope=False):
    limit = MAX_FILES + len(ENVELOPE) if envelope else MAX_FILES
    if not files or len(files) > limit:
        raise ValidationError(f"package must contain 1..{MAX_FILES} files")
    seen, total, spellings = set(), 0, {}
    for name, data in files.items():
        _safe_name(name)
        lower = name.lower()
        parts = name.split("/")
        for index in range(1, len(parts) + 1):
            spelling = "/".join(parts[:index])
            folded = spelling.lower()
            if folded in spellings and spellings[folded] != spelling:
                raise ValidationError(f"case-colliding path component: {spelling}")
            spellings[folded] = spelling
        if lower in seen:
            raise ValidationError(f"case-colliding package member: {name}")
        seen.add(lower)
        if any("/".join(lower.split("/")[:i]) in seen for i in range(1, len(lower.split("/")))):
            raise ValidationError(f"file/directory package path collision: {name}")
        if any(prior.startswith(lower + "/") for prior in seen):
            raise ValidationError(f"file/directory package path collision: {name}")
        if len(data) > MAX_MEMBER_BYTES:
            raise ValidationError(f"{name}: exceeds {MAX_MEMBER_BYTES} byte member limit")
        total += len(data)
        if total > MAX_TOTAL_BYTES:
            raise ValidationError(f"package exceeds {MAX_TOTAL_BYTES} byte expanded limit")
        if PurePosixPath(name).suffix.lower() in BINARY_SUFFIXES:
            from .compute.module import MAX_MODULE_BYTES

            if len(data) > MAX_MODULE_BYTES:
                raise ValidationError(
                    f"{name}: a WebAssembly module is at most {MAX_MODULE_BYTES} bytes"
                )
            if not data.startswith(WASM_HEADER):
                raise ValidationError(
                    f"{name}: not a WebAssembly core module (magic number and version 1)"
                )
            # The credential scan below reads the bytes as text; a module is never decoded.
            content = data.decode("latin-1")
        else:
            try:
                content = data.decode("utf-8")
            except UnicodeDecodeError as exc:
                raise ValidationError(f"{name}: payload must be UTF-8 text") from exc
            if "\x00" in content:
                raise ValidationError(f"{name}: NUL bytes are not allowed")
        if re.search(
            r"-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----|\b(?:sk-proj-|sk-ant-)[A-Za-z0-9_-]{12,}",
            content,
        ):
            raise ValidationError(f"{name}: apparent private key or API credential in payload")
        if name.endswith(".json") or name == "MANIFEST.agent":
            canonical_json(parse_json(data, name))


def integrity_statement(files):
    return {
        "format": "agent.pkg-integrity-v0.1",
        "files": {name: sha256(data) for name, data in sorted(files.items())},
    }


@dataclass(frozen=True)
class Package:
    manifest: dict
    graph: dict
    policy: dict
    tools: dict
    files: dict[str, bytes]
    integrity: dict
    signature: dict | None = None
    source: Path | None = None
    is_archive: bool = False

    def json(self, path):
        if path not in self.files:
            raise ValidationError(f"missing package member {path}")
        return parse_json(self.files[path], path)

    @property
    def digest(self):
        return sha256(canonical_json(self.integrity))


def _source_files(path):
    files = {}
    total = 0
    for current, directories, names in os.walk(path, followlinks=False):
        for name in directories + names:
            child = Path(current) / name
            info = child.lstat()
            if stat.S_ISLNK(info.st_mode):
                raise ValidationError(f"symlink source member forbidden: {child.relative_to(path)}")
            if name in directories:
                if not stat.S_ISDIR(info.st_mode):
                    raise ValidationError(f"non-directory source entry: {name}")
                relative = str(child.relative_to(path).as_posix())
                # Directory names obey the same portable character rules.
                if not PORTABLE_PATH.fullmatch(relative) or any(
                    part.lower() in {"venv", "node_modules", "__pycache__"}
                    for part in relative.split("/")
                ):
                    raise ValidationError(f"unsafe source directory: {relative}")
                continue
            relative = child.relative_to(path).as_posix()
            _safe_name(relative)
            if relative in ENVELOPE:
                raise ValidationError(
                    f"{relative}: generated envelope belongs in archives; remove it from source"
                )
            if not stat.S_ISREG(info.st_mode) or info.st_mode & 0o111:
                raise ValidationError(
                    f"{relative}: nonregular or executable source member forbidden"
                )
            if len(files) >= MAX_FILES or info.st_size > MAX_MEMBER_BYTES:
                raise ValidationError(f"{relative}: source resource limit exceeded")
            total += info.st_size
            if total > MAX_TOTAL_BYTES:
                raise ValidationError("source exceeds total size limit")
            fd = os.open(child, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
            with os.fdopen(fd, "rb") as stream:
                current_info = os.fstat(stream.fileno())
                if not stat.S_ISREG(current_info.st_mode) or (
                    current_info.st_dev,
                    current_info.st_ino,
                ) != (info.st_dev, info.st_ino):
                    raise ValidationError(f"{relative}: source member changed while reading")
                data = stream.read(MAX_MEMBER_BYTES + 1)
            files[relative] = data
    return files


def _archive_files(path):
    if path.stat().st_size > MAX_TOTAL_BYTES + MAX_FILES * 1024:
        raise ValidationError("archive exceeds total size limit")
    return _archive_payload(path.read_bytes())


def _archive_payload(raw: bytes):
    files = {}
    if (
        len(raw) > MAX_TOTAL_BYTES + MAX_FILES * 1024
        or len(raw) < 22
        or not raw.startswith(b"PK\x03\x04")
        or raw[-22:-18] != b"PK\x05\x06"
    ):
        raise ValidationError(
            "artifact must be a standalone ZIP without prefix, suffix, or comments"
        )
    eocd = struct.unpack("<4s4H2LH", raw[-22:])
    if eocd[1] or eocd[2] or eocd[3] != eocd[4] or eocd[7] or eocd[5] + eocd[6] != len(raw) - 22:
        raise ValidationError("split, extended, or noncanonical ZIP directory unsupported")
    try:
        with zipfile.ZipFile(io.BytesIO(raw), "r") as archive:
            infos = archive.infolist()
            if len(infos) > MAX_FILES + len(ENVELOPE):
                raise ValidationError("archive member count exceeds limit")
            total = 0
            expected_offset = 0
            for info in sorted(infos, key=lambda item: item.header_offset):
                if (
                    info.header_offset != expected_offset
                    or info.extra
                    or info.comment
                    or info.flag_bits & 8
                ):
                    raise ValidationError(
                        "ZIP gaps, extra fields, entry comments, and data descriptors unsupported"
                    )
                header = raw[info.header_offset : info.header_offset + 30]
                if len(header) != 30:
                    raise ValidationError("truncated ZIP local header")
                local = struct.unpack("<4s5H3L2H", header)
                if (
                    local[0] != b"PK\x03\x04"
                    or local[-1]
                    or local[7] != info.compress_size
                    or local[8] != info.file_size
                ):
                    raise ValidationError("inconsistent ZIP local header or extra fields")
                expected_offset += 30 + local[-2] + info.compress_size
                name = info.filename
                _safe_name(name)
                if "\x00" in info.orig_filename or info.is_dir() or name in files:
                    raise ValidationError(f"duplicate, NUL, or directory archive member: {name}")
                mode = info.external_attr >> 16
                if stat.S_IFMT(mode) not in (0, stat.S_IFREG) or mode & 0o111:
                    raise ValidationError(
                        f"{name}: symlink, special or executable archive member forbidden"
                    )
                if info.flag_bits & 1 or info.compress_type != zipfile.ZIP_STORED:
                    raise ValidationError(
                        f"{name}: encrypted/compressed members unsupported; use ZIP_STORED"
                    )
                total += info.file_size
                if info.file_size > MAX_MEMBER_BYTES or total > MAX_TOTAL_BYTES:
                    raise ValidationError(f"{name}: archive resource limit exceeded")
                with archive.open(info) as stream:
                    files[name] = stream.read(MAX_MEMBER_BYTES + 1)
            if archive.comment or expected_offset != archive.start_dir or len(infos) != eocd[4]:
                raise ValidationError("archive directory layout is inconsistent")
    except (zipfile.BadZipFile, RuntimeError, NotImplementedError) as exc:
        raise ValidationError(f"invalid ZIP artifact: {exc}") from exc
    _check_payload(files, envelope=True)
    if INTEGRITY_PATH not in files:
        raise ValidationError("artifact missing generated integrity.json; use agentpkg build")
    statement = parse_json(files.pop(INTEGRITY_PATH), INTEGRITY_PATH)
    validate_document(statement, "integrity", INTEGRITY_PATH)
    signature = (
        parse_json(files.pop(SIGNATURE_PATH), SIGNATURE_PATH) if SIGNATURE_PATH in files else None
    )
    if signature is not None:
        validate_document(signature, "signature", SIGNATURE_PATH)
    _check_payload(files)
    expected = integrity_statement(files)
    if statement != expected:
        missing = set(statement["files"]) - set(files)
        extra = set(files) - set(statement["files"])
        changed = [
            name
            for name in files
            if name in statement["files"] and statement["files"][name] != expected["files"][name]
        ]
        raise IntegrityError(
            f"content integrity mismatch: missing={sorted(missing)}, "
            f"extra={sorted(extra)}, changed={changed}"
        )
    return files, statement, signature


def read_archive(path: str | Path):
    """Container and integrity layers only: returns (payload, integrity, signature).

    Structural, portability and resource failures raise `ValidationError`; a
    payload that contradicts its own integrity statement raises the narrower
    `IntegrityError`. Callers that need the parsed manifest use `load_package`.
    """
    return _archive_files(Path(path))


def read_archive_bytes(data: bytes):
    """The same container/integrity layers over bytes already held in memory.

    A caller that received an artifact through an inherited file descriptor has
    no path to reopen, and reopening one would reintroduce the verify/reload
    race this format is careful about. The parsing rules are identical: this is
    the same function `read_archive` runs, without the filesystem step.
    """
    if not isinstance(data, (bytes, bytearray)):
        raise ValidationError("archive bytes expected")
    if len(data) > MAX_TOTAL_BYTES + MAX_FILES * 1024:
        raise ValidationError("archive exceeds total size limit")
    return _archive_payload(bytes(data))


def load_package_bytes(data: bytes, source: Path | None = None) -> Package:
    """Load one verified artifact from bytes, with no path to reopen."""
    files, statement, signature = read_archive_bytes(data)
    manifest, graph, policy, tools = validate_payload(files)
    return Package(manifest, graph, policy, tools, files, statement, signature, source, True)


def read_regular_bytes(path: str | Path, limit: int) -> bytes:
    """Read one bounded snapshot; do not follow a symlink at the final component."""
    path = Path(path)
    try:
        fd = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
        with os.fdopen(fd, "rb") as stream:
            if not stat.S_ISREG(os.fstat(stream.fileno()).st_mode):
                raise ValidationError(f"Expected a regular file: {path}")
            value = stream.read(limit + 1)
    except OSError as exc:
        raise ValidationError(f"Cannot read regular file {path}: {exc.strerror}") from exc
    if len(value) > limit:
        raise ValidationError(f"Input exceeds the adapter's {limit}-byte limit: {path}")
    return value


def load_package(path: str | Path) -> Package:
    path = Path(path)
    if path.is_symlink():
        raise ValidationError("package source/artifact itself cannot be a symlink")
    if path.is_dir():
        files = _source_files(path)
        _check_payload(files)
        statement, signature = integrity_statement(files), None
        archive = False
    elif path.is_file():
        files, statement, signature = _archive_files(path)
        archive = True
    else:
        raise ValidationError(f"package source/artifact not found: {path}")
    manifest, graph, policy, tools = validate_payload(files)
    return Package(manifest, graph, policy, tools, files, statement, signature, path, archive)


def archive_bytes(files, signature=None):
    payload = dict(files)
    payload[INTEGRITY_PATH] = canonical_json(integrity_statement(files))
    if signature is not None:
        payload[SIGNATURE_PATH] = canonical_json(signature)
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", compression=zipfile.ZIP_STORED, allowZip64=False) as archive:
        for name, data in sorted(payload.items()):
            info = zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
            info.create_system = 3
            info.external_attr = (stat.S_IFREG | 0o644) << 16
            info.compress_type = zipfile.ZIP_STORED
            archive.writestr(info, data)
    return buffer.getvalue()


def _open_parent(path):
    """Open the parent without following symlinks in any path component."""
    path = Path(path).absolute()
    if ".." in path.parts:
        raise ValidationError("output paths cannot contain parent traversal")
    flags = os.O_RDONLY | os.O_DIRECTORY | getattr(os, "O_NOFOLLOW", 0)
    fd = os.open(path.anchor, flags)
    try:
        for component in path.parts[1:-1]:
            next_fd = os.open(component, flags, dir_fd=fd)
            os.close(fd)
            fd = next_fd
        return fd, path.name
    except OSError as exc:
        os.close(fd)
        raise ValidationError(
            f"output parent must exist and contain no symlinks: {path.parent}"
        ) from exc


def create_directory(path):
    """Create a private new destination, with no symlink-following ancestors."""
    path = Path(path)
    fd, name = _open_parent(path)
    try:
        os.mkdir(name, mode=0o700, dir_fd=fd)
    except FileExistsError as exc:
        raise ValidationError(f"output requires a new destination directory: {path}") from exc
    finally:
        os.close(fd)
    return path


def write_new(path, data, mode=0o644):
    path = Path(path)
    parent_fd, name = _open_parent(path)
    try:
        try:
            fd = os.open(
                name,
                os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0),
                mode,
                dir_fd=parent_fd,
            )
        except FileExistsError as exc:
            raise ValidationError(f"refusing to overwrite existing output: {path}") from exc
        with os.fdopen(fd, "wb") as stream:
            stream.write(data)
    finally:
        os.close(parent_fd)
    return path


def build_package(source: str | Path, output: str | Path) -> Path:
    package = load_package(source)
    if package.is_archive:
        raise ValidationError("build expects a source directory")
    if not str(output).endswith(".agent.pkg"):
        raise ValidationError("output artifact must end in .agent.pkg")
    # JCS normalizes JSON documents; Markdown and other text retain exact bytes.
    files = {
        name: canonical_json(parse_json(data, name))
        if name.endswith(".json") or name == "MANIFEST.agent"
        else data
        for name, data in package.files.items()
    }
    _check_payload(files)
    return write_new(output, archive_bytes(files))


def permissions_summary(package: Package) -> dict:
    return {
        "package_id": package.manifest["package_id"],
        "version": package.manifest["version"],
        **{
            key: package.policy[key]
            for key in ("permissions", "network", "memory", "budget", "delegation")
        },
    }


def inspect_package(package: Package) -> dict:
    return {
        "manifest": package.manifest,
        "digest": package.digest,
        "integrity_valid": True,
        "signature_present": package.signature is not None,
        "signature_trust": "not verified by inspect",
        "files": sorted(package.files),
        "workers": package.graph["workers"],
        "execution_profile": package.graph.get("profile", "legacy-host-entrypoint"),
        "nodes" if "nodes" in package.graph else "stages": package.graph.get(
            "nodes", package.graph.get("stages", [])
        ),
        **_module_listing(package),
    }


def _module_listing(package: Package) -> dict:
    """compute.v0: the modules a graph declares, with their hashes, where it declares any."""
    if not package.graph.get("modules"):
        return {}
    from .compute.declarations import module_records

    return {"modules": module_records(package)}


def unpack_package(path: str | Path, destination: str | Path) -> Path:
    package = load_package(path)
    if not package.is_archive:
        raise ValidationError("unpack expects a built .agent.pkg artifact")
    destination = Path(destination)
    if destination.exists() or destination.is_symlink():
        raise ValidationError(f"unpack requires a new destination directory: {destination}")
    if not destination.parent.is_dir():
        raise ValidationError("unpack destination parent must already exist")
    create_directory(destination)
    # All paths and case collisions were validated before any filesystem mutation.
    for name, data in sorted(package.files.items()):
        output = destination / name
        output.parent.mkdir(parents=True, exist_ok=True)
        write_new(output, data)
    return destination
