"""compute.v0 enforcement cases (examples/compute/cases/cases.json): every case ends at the stage
with the code the list expects, on the reference runtime. The same list is the catalog v2's
compute family and the conformance suite's input (T22, T27)."""

import asyncio
import io
import json
import zipfile

import pytest
from compute_probe import CASES, builder, case_module, compute_node, grants, write_probe

from agentpkg.compute import engine as compute_engine
from agentpkg.compute.engine import EngineUnavailable
from agentpkg.errors import IntegrityError, ValidationError
from agentpkg.fixtures import fixture_adapters
from agentpkg.package import build_package, load_package
from agentpkg.runtime import PolicyError
from agentpkg.workflow import WorkflowError, run_workflow

CASE_LIST = json.loads((CASES / "cases.json").read_text())


def _module_bytes(case):
    if case.get("generator") == "oversized":
        return builder().oversized()
    if case.get("generator") == "not-wasm":
        return b"not a module"
    return case_module(case["module"])


def _build(tmp_path, case):
    """The probe for one case: its module under the id `echo` unless a variant says otherwise."""
    data = _module_bytes(case)
    options = {}
    if case.get("output_schema"):
        options["output_schema"] = case["output_schema"]
    if case.get("input_schema"):
        options["input_schema"] = case["input_schema"]
    node = compute_node(limits=case.get("node_limits"))
    variant = case.get("variant")
    if variant == "hash-mismatch":
        options["declared"] = [{"id": "echo", "path": "modules/echo.wasm", "sha256": "0" * 64}]
    elif variant == "undeclared-member":
        options["extra_files"] = {"modules/other.wasm": case_module("echo")}
    elif variant == "unknown-module":
        node["module"] = "other"
    elif variant == "unused-module":
        return write_probe(
            tmp_path / "probe",
            modules={"echo": data, "spare": case_module("with-start")},
            nodes=[node],
        )
    elif variant == "no-permission":
        options["permission"] = False
    elif variant == "wrong-resources":
        options["permission_resources"] = ["echo", "other"]
    elif variant == "minimum-0.4.0":
        options["minimum_version"] = "0.4.0"
    return write_probe(tmp_path / "probe", modules={"echo": data}, nodes=[node], **options)


def _run(package, case, limits=None):
    router, handlers, value = fixture_adapters(package)
    return asyncio.run(
        run_workflow(
            package,
            value,
            router=router,
            handlers=handlers,
            grants=grants(package, **case.get("grants", {})),
            approved_tools=[],
            limits=limits,
        )
    )


@pytest.mark.parametrize("case", CASE_LIST["cases"], ids=lambda c: c["id"])
def test_enforcement_case(case, tmp_path, monkeypatch):
    source = _build(tmp_path, case)
    stage = case["stage"]
    if stage == "container":
        if case.get("variant") == "tamper-archive":
            archive = build_package(source, tmp_path / "probe.agent.pkg")
            tampered = _tamper(archive.read_bytes(), "modules/echo.wasm")
            (tmp_path / "tampered.agent.pkg").write_bytes(tampered)
            with pytest.raises(IntegrityError, match=case["message"]):
                load_package(tmp_path / "tampered.agent.pkg")
        else:
            with pytest.raises(ValidationError, match=case["message"]):
                load_package(source)
        return
    if stage == "validation":
        with pytest.raises(ValidationError, match=f"^{case['code']}: "):
            load_package(source)
        return
    package = load_package(source)
    if stage == "preflight":
        if case.get("variant") == "no-engine":

            def unavailable():
                raise EngineUnavailable("no engine here")

            monkeypatch.setattr(compute_engine, "default_engine", unavailable)
        with pytest.raises(PolicyError) as caught:
            _run(package, case)
        assert caught.value.code == case["code"]
        assert str(caught.value).startswith(case["code"] + ": ")
        return
    if case["code"] == "completed":
        result = _run(package, case)
        assert result["status"] == "completed"
        assert [e["action"] for e in result["audit"] if e["action"].startswith("compute.")] == [
            "compute.called",
            "compute.completed",
        ]
        return
    with pytest.raises(WorkflowError) as caught:
        _run(package, case)
    assert caught.value.code == case["code"]
    report = caught.value.execution_report
    assert report["status"] == "failed" and report["error_code"] == case["code"]
    failed = [e for e in report["audit"] if e["action"] == "compute.failed"]
    node_failed = [e for e in report["audit"] if e["action"] == "node.failed"]
    assert node_failed[0]["error_code"] == case["code"]
    if case["code"] == "permission_denied":
        assert not failed or failed[0].get("reason") is None
        assert not [e for e in report["audit"] if e["action"] == "compute.called"]
        denied = [e for e in report["audit"] if e["action"] == "permission.checked"]
        assert denied[-1]["allowed"] is False and denied[-1]["permission"] == "compute.modules"
        return
    assert len(failed) == 1
    assert failed[0]["reason"] == case["reason"]
    for key in ("trap_code", "detail", "memory_pages"):
        if key in case:
            assert failed[0][key] == case[key], key
    if case["code"] == "compute_error":
        assert node_failed[0]["compute"]["reason"] == case["reason"]
        assert failed[0]["engine"]["id"].startswith("wasmtime-py/")
        if case["reason"] == "deadline":
            assert failed[0]["engine"]["fuel_consumed"] is None
        elif case["reason"] == "fuel_exhausted":
            assert failed[0]["engine"]["fuel_consumed"] == case["node_limits"]["fuel"]
    if case["reason"] == "compute_input_invalid":
        assert not [e for e in report["audit"] if e["action"] == "compute.called"]


def _tamper(archive: bytes, member: str) -> bytes:
    """Re-zip the archive with one byte of one member changed, as an attacker who edits a
    package would: the ZIP is well formed, so what refuses it is the integrity statement."""
    import stat

    with zipfile.ZipFile(io.BytesIO(archive)) as zf:
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
    return buffer.getvalue()


def test_the_case_list_covers_every_reason_and_every_stage():
    reasons = {c.get("reason") for c in CASE_LIST["cases"]} - {None}
    assert {"trap", "fuel_exhausted", "deadline", "abi_violation", "output_not_json"} <= reasons
    assert {c["stage"] for c in CASE_LIST["cases"]} == {
        "container",
        "validation",
        "preflight",
        "run",
    }
    ids = [c["id"] for c in CASE_LIST["cases"]]
    assert len(ids) == len(set(ids))
    assert CASE_LIST["family"] == "compute"
