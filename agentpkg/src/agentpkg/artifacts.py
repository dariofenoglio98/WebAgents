"""One trusted writer for the files a finished run leaves behind.

Two hosts write the same artifacts: the developer CLI, which owns a directory
path, and the execution runner, which owns only an inherited directory
descriptor and must never be able to name a path at all. Both need identical
rules about which names exist, which are reserved, and how a package-declared
export is turned into bytes, so the rules live here once.

What a package can influence is deliberately small: an export's filename, which
`workflow_validation` has already constrained to one safe portable filename that
cannot collide with a reserved host name, and an export's value, which is a data
constructor over the final workflow result. Nothing here interprets a filename
as anything but a filename.
"""

from __future__ import annotations

import json
import os
import stat
from pathlib import Path

from .errors import ValidationError
from .package import create_directory, write_new
from .workflow_values import evaluate

# Names the host writes itself. `workflow_validation` refuses an export that
# collides with the first four; `run.json` is refused by the execution host,
# which is a host capability limit rather than a package-format rule.
HOST_RESULT_NAMES = ("result.json", "audit.json", "usage.json", "provenance.json")
RUN_RECORD_NAME = "run.json"
ARTIFACT_MODE = 0o600
# One artifact is a rendered JSON document or a text export. The container
# limits mean a result is bounded by what the interpreter already validated;
# this is a second, blunt stop on a pathological export.
MAX_ARTIFACT_BYTES = 64 * 1024 * 1024


def _encode_json(value) -> bytes:
    return (json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False) + "\n").encode("utf-8")


def artifact_records(result: dict, package=None) -> list[tuple[str, bytes]]:
    """Render one execution report, and its package exports, into named bytes.

    `result` is either a completed `Workflow.run` return value or the
    `execution_report` carried by a classified failure. Exports are written only
    for a completed run, because an export selects from a final output that a
    failed run does not have.
    """
    records: list[tuple[str, bytes]] = [("result.json", _encode_json(result))]
    for field in ("audit", "usage", "provenance"):
        if field in result:
            records.append((f"{field}.json", _encode_json(result[field])))
    if package is not None and result.get("status") == "completed":
        for export in package.graph.get("exports", []):
            value = evaluate(export["value"], {"result": result["output"]})
            # A `memory.proposal` export (memory.v0 M-38) is JSON; the interpreter checked it
            # (M-40) before the run completed, so a refused document never reaches this writer.
            if export["format"] in ("json", "memory.proposal"):
                data = _encode_json(value)
            else:
                if not isinstance(value, str):
                    raise ValidationError("Text exports must select strings")
                data = value.encode("utf-8")
            records.append((export["path"], data))
    names = [name for name, _ in records]
    if len(set(name.lower() for name in names)) != len(names):
        raise ValidationError("run artifacts would collide on a case-insensitive filesystem")
    for name, data in records:
        if len(data) > MAX_ARTIFACT_BYTES:
            raise ValidationError(f"run artifact {name} exceeds {MAX_ARTIFACT_BYTES} bytes")
    return records


def write_artifacts(directory, records: list[tuple[str, bytes]]) -> Path:
    """Write records into a NEW private directory identified by a path."""
    destination = Path(directory)
    if destination.exists() or destination.is_symlink():
        raise ValidationError(f"output requires a new directory; refusing to overwrite {directory}")
    if not destination.parent.is_dir():
        raise ValidationError(f"output parent does not exist: {destination.parent}")
    create_directory(destination)
    for name, data in records:
        write_new(destination / name, data, mode=ARTIFACT_MODE)
    return destination


def write_artifacts_fd(dir_fd: int, records: list[tuple[str, bytes]]) -> list[str]:
    """Write records into an already-open directory, which is the only reachable one.

    The runner receives this descriptor from its trusted parent and never learns
    a path, so there is no directory it could write to instead. Each file is
    created exclusively and without following a symlink, so an existing name is
    an error rather than an overwrite.
    """
    if not stat.S_ISDIR(os.fstat(dir_fd).st_mode):
        raise ValidationError("the run artifact descriptor is not a directory")
    written: list[str] = []
    for name, data in records:
        if "/" in name or name in {"", ".", ".."} or name.startswith("."):
            # workflow_validation already refuses these; refuse again at the
            # boundary that actually creates a file.
            raise ValidationError(f"unsafe run artifact name: {name!r}")
        flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0)
        fd = os.open(name, flags, ARTIFACT_MODE, dir_fd=dir_fd)
        with os.fdopen(fd, "wb") as stream:
            stream.write(data)
        written.append(name)
    return written


__all__ = [
    "ARTIFACT_MODE",
    "HOST_RESULT_NAMES",
    "MAX_ARTIFACT_BYTES",
    "RUN_RECORD_NAME",
    "artifact_records",
    "write_artifacts",
    "write_artifacts_fd",
]
