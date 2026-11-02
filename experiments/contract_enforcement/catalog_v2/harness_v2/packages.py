"""The probe archives a catalog run executes (D-300).

Every case is one of agentpkg's four probe packages with one change, written by the conformance
suite's own drivers (`conformance/drivers/{memory,compute,conversation,network}_probe.py`), which
write each probe exactly as agentpkg's unit tests build it; catalog v2 adds a few changes of its
own (`cases_v2/*.py`, `extra` mutations: the new memory case, the T24 sentence, the parametric
values), applied to the probe's members before they are written. Each source is archived and
signed with a key generated for the run, without validating it (the conformance drivers'
`signed_archive`), so that a package both runtimes must refuse reaches their loaders. A
`tamper` case changes one member's bytes after signing, as an attacker who edits a package would.

Archives are built in the parent process with the production agentpkg, once per run, and the
same bytes go to both runtimes and every profile.
"""

from __future__ import annotations

import importlib.util
import io
import json
import shutil
import stat
import sys
import zipfile
from pathlib import Path

from .paths import AGENTPKG_TESTS, CONFORMANCE_DRIVERS, sha256_file

_DRIVERS: dict[str, object] = {}


def driver(name: str):
    """A conformance probe driver, loaded by path (memory, compute, conversation, network)."""
    if name not in _DRIVERS:
        if str(AGENTPKG_TESTS) not in sys.path:
            sys.path.insert(0, str(AGENTPKG_TESTS))
        spec = importlib.util.spec_from_file_location(
            f"catalog_v2_{name}_probe_driver", CONFORMANCE_DRIVERS / f"{name}_probe.py"
        )
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        _DRIVERS[name] = module
    return _DRIVERS[name]


def probe(name: str):
    """agentpkg's own test package module (`memory_probe`, `compute_probe`, ...)."""
    driver(name)
    return sys.modules[f"{name}_probe"]


def generate_key(directory: Path) -> tuple[Path, Path]:
    from agentpkg.signing import keygen

    directory.mkdir(parents=True, exist_ok=True)
    private, public = directory / "throwaway.key.pem", directory / "throwaway.pub.pem"
    if not private.exists():
        keygen(private, public)
    return private, public


def _rewrite_json(source: Path, name: str, change) -> None:
    path = source / name
    value = json.loads(path.read_text())
    change(value)
    path.write_text(json.dumps(value, indent=2, ensure_ascii=False) + "\n")


def _members(source: Path) -> dict:
    """The written source as the dict of relative path -> JSON value (or text) the probes use."""
    files = {}
    for path in sorted(source.rglob("*")):
        if path.is_file():
            name = path.relative_to(source).as_posix()
            if name.endswith(".json") or name == "MANIFEST.agent":
                files[name] = json.loads(path.read_text())
            elif name.endswith(".wasm"):
                files[name] = path.read_bytes()
            else:
                files[name] = path.read_text()
    return files


def _write_members(source: Path, files: dict) -> None:
    shutil.rmtree(source)
    for name, value in files.items():
        path = source / name
        path.parent.mkdir(parents=True, exist_ok=True)
        if isinstance(value, bytes):
            path.write_bytes(value)
        elif isinstance(value, str):
            path.write_text(value, encoding="utf-8")
        else:
            path.write_text(json.dumps(value, indent=2, ensure_ascii=False) + "\n")


def write_source(source_spec: dict, out: Path, extra=None, pre=None) -> Path:
    """Write one case's probe source into `out` (a new directory), exactly as the conformance
    driver of its probe writes it; `pre(members)` may change the members after the case's own
    variant and before the probe writes them (and, for the network probe, before its fixture is
    generated from the network), `extra(files)` may change the written members afterwards."""
    kind = source_spec["probe"]
    if kind == "memory":
        name = source_spec["variant"]
        change = driver("memory").VARIANTS[name]

        def apply(files):
            files["MANIFEST.agent"]["package_id"] = f"org.webagents.catalog-v2.memory-{name}"
            change(files)
            if pre is not None:
                pre(files)

        probe("memory").write_probe(out, apply)
    elif kind == "compute":
        if pre is not None:
            raise ValueError("compute cases change the probe through the case itself")
        case = dict(source_spec["case"])
        driver("compute").write_case(out, case)
        _rewrite_json(
            out,
            "MANIFEST.agent",
            lambda m: m.update(package_id=f"org.webagents.catalog-v2.compute-{case['id']}"),
        )
    elif kind in ("conversation", "network"):
        # `conformance/drivers/{conversation,network}_probe.py::write_case`, with `pre` added.
        case = dict(source_spec["case"])
        module = probe(kind)
        mutate = module.VARIANTS[case["variant"]] if case.get("variant") else None
        options = {"remote_tool": True} if case.get("remote_tool") else {}

        def apply(members):
            members["MANIFEST.agent"]["package_id"] = (
                f"org.webagents.catalog-v2.{kind}-{case['id']}"
            )
            if mutate is not None:
                mutate(members)
            if pre is not None:
                pre(members)

        module.write_probe(out, mutate=apply, **options)
    else:
        raise ValueError(f"unknown probe {kind!r}")
    for leftover in out.parent.glob(f"{out.name}.*.json"):
        # The conformance drivers' grants/transcript files: the catalog states its own.
        leftover.unlink()
    if extra is not None:
        files = _members(out)
        extra(files)
        _write_members(out, files)
    return out


def sign(source: Path, archive: Path, private_key: Path) -> Path:
    driver("memory").signed_archive(source, archive, private_key)
    return archive


def tamper(archive: Path, member: str) -> None:
    """Re-zip the archive with one byte of one member changed (agentpkg's
    `test_compute_cases._tamper`): the ZIP is well formed, the integrity statement refuses it."""
    with zipfile.ZipFile(io.BytesIO(archive.read_bytes())) as zf:
        members = {info.filename: zf.read(info) for info in zf.infolist()}
    changed = bytearray(members[member])
    changed[-1] ^= 0x01
    members[member] = bytes(changed)
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", compression=zipfile.ZIP_STORED, allowZip64=False) as out:
        for name, data in sorted(members.items()):
            info = zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
            info.create_system = 3
            info.external_attr = (stat.S_IFREG | 0o644) << 16
            info.compress_type = zipfile.ZIP_STORED
            out.writestr(info, data)
    archive.write_bytes(buffer.getvalue())


def build_archive(case, workdir: Path, private_key: Path) -> dict:
    """Source, archive and its identity for one case (a `cases_v2.base.Case`)."""
    source = workdir / "sources" / case.slug
    if source.exists():
        shutil.rmtree(source)
    source.parent.mkdir(parents=True, exist_ok=True)
    write_source(case.source, source, case.extra, case.pre)
    archive = workdir / "packages" / f"{case.slug}.agent.pkg"
    archive.parent.mkdir(parents=True, exist_ok=True)
    sign(source, archive, private_key)
    if case.tamper:
        tamper(archive, case.tamper)
    return {"archive": str(archive), "archive_sha256": sha256_file(archive)}
