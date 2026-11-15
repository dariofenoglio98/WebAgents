"""Pack a campaign results directory for the repository (T32, the user's decision of 2026-11-15): its run tree
(`runs/`, `selected/`) and `progress.jsonl` go into one deterministic `runs.tar.gz` (sorted members, fixed
timestamps and owners, gzip without a date), and `runs.tar.gz.sha256` records its digest; `manifest.json`,
`units.json`, `summary.json`, `server.jsonl` and `findings.md` stay beside it, uncompressed. `analyze.py` reads a
packed directory as it reads an unpacked one. The unpacked original is kept where the campaign ran.

    agentpkg/.venv/bin/python experiments/injection_campaign/pack.py <directory> [--remove-unpacked]
"""

from __future__ import annotations

import argparse
import gzip
import hashlib
import io
import shutil
import sys
import tarfile
from pathlib import Path

PACKED = ("runs", "selected", "progress.jsonl")
ARCHIVE = "runs.tar.gz"


def _members(directory: Path) -> list[Path]:
    out = []
    for name in PACKED:
        path = directory / name
        if path.is_file():
            out.append(path)
        elif path.is_dir():
            out += sorted(p for p in path.rglob("*"))
    return sorted(out, key=lambda p: p.relative_to(directory).as_posix())


def pack(directory: Path) -> str:
    buffer = io.BytesIO()
    with tarfile.open(fileobj=buffer, mode="w", format=tarfile.PAX_FORMAT) as tar:
        for path in _members(directory):
            info = tar.gettarinfo(
                str(path), arcname=path.relative_to(directory).as_posix()
            )
            info.mtime, info.uid, info.gid, info.uname, info.gname = 0, 0, 0, "", ""
            info.mode = 0o755 if info.isdir() else 0o644
            if info.isfile():
                with open(path, "rb") as handle:
                    tar.addfile(info, handle)
            else:
                tar.addfile(info)
    data = gzip.compress(buffer.getvalue(), compresslevel=9, mtime=0)
    (directory / ARCHIVE).write_bytes(data)
    digest = hashlib.sha256(data).hexdigest()
    (directory / f"{ARCHIVE}.sha256").write_text(f"{digest}  {ARCHIVE}\n")
    return digest


def unpacked(directory: Path, scratch: Path) -> Path:
    """The directory itself when its run tree is there; else a copy unpacked into `scratch`."""
    if (directory / "runs").is_dir() or not (directory / ARCHIVE).is_file():
        return directory
    expected = (directory / f"{ARCHIVE}.sha256").read_text().split()[0]
    data = (directory / ARCHIVE).read_bytes()
    if hashlib.sha256(data).hexdigest() != expected:
        raise SystemExit(f"{directory / ARCHIVE}: its SHA-256 is not the recorded one")
    target = scratch / directory.name
    target.mkdir(parents=True)
    for name in (
        "manifest.json",
        "units.json",
        "summary.json",
        "server.jsonl",
        "findings.md",
    ):
        if (directory / name).is_file():
            shutil.copy2(directory / name, target / name)
    with tarfile.open(fileobj=io.BytesIO(data), mode="r:gz") as tar:
        tar.extractall(target, filter="data")
    return target


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("directory", type=Path)
    parser.add_argument("--remove-unpacked", action="store_true")
    args = parser.parse_args(argv)
    digest = pack(args.directory)
    if args.remove_unpacked:
        for name in PACKED:
            path = args.directory / name
            if path.is_dir():
                shutil.rmtree(path)
            elif path.is_file():
                path.unlink()
    print(f"{args.directory / ARCHIVE} {digest}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
