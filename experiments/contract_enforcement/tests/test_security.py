"""Offline, credential-free, canary-only: the experiment cannot reach anything real."""

from __future__ import annotations

import socket
import subprocess

import pytest

from harness.guards import GuardViolation, PythonGuard


def test_python_guard_refuses_network_processes_and_sensitive_opens(tmp_path):
    canary = tmp_path / "canary.pdf"
    canary.write_bytes(b"%PDF canary")
    with PythonGuard(sensitive_prefixes=[str(tmp_path)]) as guard:
        with pytest.raises(GuardViolation):
            socket.create_connection(("192.0.2.1", 9))
        with pytest.raises(GuardViolation):
            socket.getaddrinfo("example.invalid", 443)
        with pytest.raises(GuardViolation):
            socket.socket().connect(("192.0.2.1", 9))
        with pytest.raises(GuardViolation):
            subprocess.Popen(["true"])
        with pytest.raises(GuardViolation):
            open(canary, "rb")
        kinds = [item["kind"] for item in guard.refused]
    assert {
        "socket.create_connection",
        "socket.getaddrinfo",
        "socket.connect",
        "subprocess.Popen",
        "open",
    } <= set(kinds)
    # Restored on exit.
    assert open(canary, "rb").read() == b"%PDF canary"


def test_node_helper_refuses_everything_the_guards_exist_for(host, tmp_path):
    canary = tmp_path / "canary" / "secret.pdf"
    canary.parent.mkdir()
    canary.write_bytes(b"%PDF canary")
    host.run(
        host.helper.call(
            "helper.configure",
            {"sensitive_prefixes": [str(canary.parent)], "sensitive_substrings": []},
        )
    )
    try:
        result = host.run(host.helper.call("helper.selftest", {"canary": str(canary)}))
    finally:
        host.run(
            host.helper.call(
                "helper.configure", {"sensitive_prefixes": [], "sensitive_substrings": []}
            )
        )
    assert set(result["outcome"].values()) == {"refused"}, result


def test_helper_environment_carries_no_credentials(host):
    assert host.helper.hello["node"].startswith("v")
    assert host.helper.child_env_names == [
        "HOME",
        "NODE_OPTIONS",
        "NO_COLOR",
        "PATH",
        "TMPDIR",
    ] or (host.helper.child_env_names == ["HOME", "NODE_OPTIONS", "NO_COLOR", "PATH"])


def test_worker_environment_carries_no_credentials(tmp_path):
    import run

    env = run.worker_env({"pythonpath": "agentpkg/src"}, tmp_path)
    assert set(env) == {
        "PATH",
        "PYTHONPATH",
        "PYTHONHASHSEED",
        "PYTHONDONTWRITEBYTECODE",
        "HOME",
        "TMPDIR",
        "LANG",
    }
    assert env["HOME"] == str(tmp_path)


def test_experiment_keys_are_derived_in_memory_only(tmp_path):
    from harness.world import experiment_key

    first = experiment_key(1, "trusted-publisher")
    second = experiment_key(1, "trusted-publisher")
    assert first.private_bytes_raw() == second.private_bytes_raw()
    assert experiment_key(2, "trusted-publisher").private_bytes_raw() != first.private_bytes_raw()


def test_canary_reads_are_refused_and_recorded(run_entry, calibration):
    """A forged file reference (here: a trusted graph literal naming the canary) never reads it."""
    from conftest import SEED

    import cases

    catalog = cases.generate(SEED, "paper", calibration)
    entry = next(
        e
        for e in catalog["cases"]
        if e["template_id"] == "F6.file_capability_forgery"
        and e["variant_id"] == "graph-canary_path"
    )
    obs, verdict = run_entry(entry)
    assert verdict.outcome == "EXPLICIT_BLOCK", verdict.as_json()
    assert not obs["python_sensitive"]
    assert not (obs["helper"].get("guard") or {}).get("fs_sensitive")
    assert obs["canaries"].pdf_parses == [] or all(
        item["known"] for item in obs["canaries"].pdf_parses
    )


def test_no_transport_leaves_for_an_unauthorized_destination(run_entry, calibration):
    from conftest import SEED

    import cases

    catalog = cases.generate(SEED, "paper", calibration)
    entry = next(
        e
        for e in catalog["cases"]
        if e["template_id"] == "F6.destination_redirect" and e["kind"] == "violation"
    )
    obs, verdict = run_entry(entry)
    assert verdict.outcome == "EXPLICIT_BLOCK", verdict.as_json()
    assert all(item["authorized"] for item in obs["canaries"].transports)


def test_result_files_hold_no_secrets_or_home_paths(tmp_path):
    """Scan a results directory written by this experiment (if one exists)."""
    from pathlib import Path

    from harness.paths import RESULTS

    home = str(Path.home())
    directories = (
        sorted(path for path in RESULTS.glob("*") if path.is_dir()) if RESULTS.exists() else []
    )
    for directory in directories:
        for path in directory.rglob("*"):
            if path.is_file() and path.suffix in {
                ".json",
                ".jsonl",
                ".csv",
                ".md",
                ".tex",
                ".txt",
                ".svg",
            }:
                text = path.read_text(encoding="utf-8", errors="replace")
                assert "PRIVATE KEY" not in text, path
                assert home not in text, path
