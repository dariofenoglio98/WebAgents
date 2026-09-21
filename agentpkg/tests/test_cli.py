import json
import subprocess
from pathlib import Path

import pytest

from agentpkg.dev.legacy_cli import main
from agentpkg.package import build_package
from agentpkg.signing import keygen, sign_package

ROOT = Path(__file__).resolve().parents[2]
SOURCE = ROOT / "agents/literature-review-legacy"


def test_cli_build_sign_verify_run_and_failed_run_export(tmp_path, capsys):
    artifact = tmp_path / "review.agent.pkg"
    build_package(SOURCE, artifact)
    private, public = tmp_path / "private.pem", tmp_path / "public.pem"
    keygen(private, public)
    sign_package(artifact, private)
    assert main(["verify", str(artifact), "--trust-key", str(public)]) == 0
    assert json.loads(capsys.readouterr().out)["valid"]
    output = tmp_path / "review"
    assert (
        main(
            [
                "run",
                str(artifact),
                "--question",
                "Dynamic agent selection topology",
                "--grants",
                str(ROOT / "examples/fixture-grants.json"),
                "--out",
                str(output),
            ]
        )
        == 0
    )
    capsys.readouterr()
    result = json.loads((output / "result.json").read_text())
    assert result["evals"]["passed"] and (output / "audit.json").exists()
    limits = tmp_path / "limits.json"
    limits.write_text('{"max_remote_calls":0}')
    failed = tmp_path / "failed"
    assert (
        main(
            [
                "run",
                str(artifact),
                "--question",
                "Dynamic agents",
                "--grants",
                str(ROOT / "examples/fixture-grants.json"),
                "--limits",
                str(limits),
                "--out",
                str(failed),
            ]
        )
        == 2
    )
    assert json.loads((failed / "result.json").read_text())["status"] == "failed"
    assert (failed / "audit.json").exists()


def test_live_run_requires_external_key_before_any_network(tmp_path, capsys):
    assert (
        main(
            [
                "run",
                str(SOURCE),
                "--mode",
                "live",
                "--question",
                "Research",
                "--grants",
                str(ROOT / "examples/grants.session.json"),
                "--out",
                str(tmp_path / "out"),
            ]
        )
        == 2
    )
    assert "trust-key" in capsys.readouterr().err
    assert not (tmp_path / "out").exists()


def test_resolver_schema_snapshot_matches_real_service_contract():
    python = ROOT / "citation-resolver/.venv/bin/python"
    if not python.exists():
        pytest.skip(
            "Install the existing Citation Resolver development environment for contract test"
        )
    code = (
        "import json; from pydantic import TypeAdapter; "
        "from app.models import ResolveRequest,ResolveResponse,ErrorResponse; "
        "print(json.dumps([ResolveRequest.model_json_schema(),"
        "TypeAdapter(ResolveResponse|ErrorResponse).json_schema()]))"
    )
    result = subprocess.run(
        [str(python), "-c", code],
        cwd=ROOT / "citation-resolver",
        check=True,
        capture_output=True,
        text=True,
        timeout=15,
    )
    expected = json.loads(result.stdout)
    for name, schema in zip(("resolver-input", "resolver-output"), expected):
        snapshot = json.loads((SOURCE / "schemas" / f"{name}.schema.json").read_text())
        snapshot.pop("$schema")
        assert snapshot == schema
