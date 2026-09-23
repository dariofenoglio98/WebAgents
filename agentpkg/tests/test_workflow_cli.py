"""CLI, artifact security, deterministic packaging, and staging on both profiles."""

import json
from pathlib import Path

import pytest
from jsonschema import Draft202012Validator, FormatChecker

from agentpkg.cli import main
from agentpkg.openclaw import stage_openclaw
from agentpkg.package import build_package, load_package, unpack_package
from agentpkg.signing import keygen, sign_package, verify_package
from agentpkg.validation import SCHEMAS

ROOT = Path(__file__).resolve().parents[2]


@pytest.mark.parametrize("name", ["literature-review", "meeting-agenda"])
def test_cli_build_sign_verify_run_unpack_stage(name, tmp_path, capsys):
    source = ROOT / "agents" / name
    first = build_package(source, tmp_path / "first.agent.pkg")
    second = build_package(source, tmp_path / "second.agent.pkg")
    assert first.read_bytes() == second.read_bytes()
    private, public = tmp_path / "publisher.private.pem", tmp_path / "publisher.pem"
    keygen(private, public)
    sign_package(first, private)
    sign_package(second, private)
    assert first.read_bytes() == second.read_bytes()
    assert verify_package(first, public)["valid"]
    for command in ["inspect", "validate", "permissions"]:
        assert main([command, str(first)]) == 0
        assert json.loads(capsys.readouterr().out)
    out = tmp_path / "result"
    # A granted permission is not a tool approval: the operator names each
    # declared tool, and a run that omits one is refused rather than degraded.
    approvals = [flag for tool in load_package(first).tools for flag in ("--approve-tool", tool)]
    assert (
        main(
            [
                "run",
                str(first),
                "--grants",
                str(ROOT / "examples" / f"{name}-grants.json"),
                "--mode",
                "fixture",
                "--trust-key",
                str(public),
                *approvals,
                "--out",
                str(out),
            ]
        )
        == 0
    )
    capsys.readouterr()
    result = json.loads((out / "result.json").read_text())
    assert result["provenance"]["interpreter"] == "agentpkg.workflow.Workflow"
    audit_schema = json.loads((SCHEMAS / "audit-event.schema.json").read_text())
    validator = Draft202012Validator(audit_schema, format_checker=FormatChecker())
    for event in result["audit"]:
        validator.validate(event)
    for export in load_package(first).graph["exports"]:
        assert (out / export["path"]).is_file()
    unpacked = unpack_package(first, tmp_path / "unpacked")
    rebuilt = build_package(unpacked, tmp_path / "rebuilt.agent.pkg")
    assert load_package(rebuilt).digest == load_package(first).digest
    receipt = stage_openclaw(first, tmp_path / "workspace", trusted_key_path=public)
    assert receipt["status"] == "staged"
    assert receipt["digest"] == load_package(first).digest
    assert main(["eval", str(first)]) == 0
    assert json.loads(capsys.readouterr().out)["passed"]


def test_cli_failure_writes_audit_and_preserves_output_conflict(tmp_path, capsys):
    source = ROOT / "agents/meeting-agenda"
    limits = tmp_path / "limits.json"
    limits.write_text('{"hard_tokens":0}')
    out = tmp_path / "failed"
    args = [
        "run",
        str(source),
        "--grants",
        str(ROOT / "examples/meeting-agenda-grants.json"),
        "--out",
        str(out),
    ]
    assert main(args + ["--limits", str(limits)]) == 2
    assert "budget_exhausted" in capsys.readouterr().err
    report = json.loads((out / "result.json").read_text())
    assert report["status"] == "failed"
    before = (out / "result.json").read_bytes()
    assert main(args) == 2
    assert (out / "result.json").read_bytes() == before


def test_live_signature_gate_before_model_dispatch(tmp_path, capsys):
    assert (
        main(
            [
                "run",
                str(ROOT / "agents/meeting-agenda"),
                "--mode",
                "live",
                "--grants",
                str(ROOT / "examples/meeting-agenda-grants.json"),
                "--out",
                str(tmp_path / "result"),
            ]
        )
        == 2
    )
    assert "trust-key" in capsys.readouterr().err
    assert not (tmp_path / "result").exists()
