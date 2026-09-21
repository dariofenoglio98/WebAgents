"""Generic format tests use an unrelated offline meeting-agenda agent."""

import json
import os
import stat
import zipfile

import pytest

from agentpkg.errors import SignatureError, ValidationError
from agentpkg.package import (
    MAX_MEMBER_BYTES,
    archive_bytes,
    build_package,
    canonical_json,
    inspect_package,
    load_package,
    permissions_summary,
    unpack_package,
)
from agentpkg.signing import keygen, sign_package, verify_package
from agentpkg.validation import validate_instance


def make_source(root):
    root.mkdir()
    manifest = {
        "spec_version": "0.1",
        "package_id": "org.example.agenda",
        "name": "Meeting Agenda",
        "version": "1.0.0",
        "description": "Organize user-supplied meeting topics without network access.",
        "publisher": {"id": "org.example", "name": "Example research publisher"},
        "created_at": "2026-09-19T00:00:00Z",
        "runtime": {"api": "agentpkg-runtime-v0", "minimum_version": "0.1.0"},
        "capabilities": ["agenda"],
        "entrypoint": "example.agenda",
        "graph": "graph.json",
        "policy": "policy.json",
        "skills": [{"id": "organize", "version": "1.0.0", "path": "skills/organize.md"}],
        "tools": [],
        "schemas": [{"id": "state", "path": "schemas/state.json"}],
        "model_requirements": {
            "tasks": [],
            "routing": "host",
            "fallback_policy": "deny",
            "extensions": {},
        },
        "evals": [],
        "attestations": [],
        "dependencies": [],
        "update": {"channel": "local", "locator": None},
        "extensions": {},
    }
    documents = {
        "MANIFEST.agent": manifest,
        "graph.json": {
            "spec_version": "0.1",
            "coordinator": "Coordinator",
            "workers": [
                {
                    "id": "Coordinator",
                    "kind": "packaged",
                    "skills": ["organize"],
                    "tools": [],
                    "max_instances": 1,
                    "budget": {"tokens": 100, "remote_calls": 0},
                    "state_read": ["topics"],
                    "state_write": ["agenda"],
                }
            ],
            "stages": [
                {
                    "id": "organize",
                    "worker": "Coordinator",
                    "depends_on": [],
                    "parallel": False,
                    "merge": "replace",
                    "extensions": {},
                }
            ],
            "extensions": {},
        },
        "policy.json": {
            "spec_version": "0.1",
            "permissions": [],
            "network": {"allowed_domains": [], "https_only": True, "allow_redirects": False},
            "memory": {
                "scope": "session",
                "retention": "session",
                "raw_documents": False,
                "state_schema": "schemas/state.json",
                "sharing": "explicit_views",
            },
            "budget": {
                "estimated_tokens": 10,
                "hard_tokens": 100,
                "max_remote_calls": 0,
                "max_calls_per_tool": {},
                "max_parallel_workers": 1,
                "estimated_cost_usd": None,
                "approval_threshold_tokens": None,
            },
            "delegation": {"max_depth": 1, "approved_roles": [], "allow_remote": False},
            "extensions": {},
        },
        "schemas/state.json": {
            "$schema": "https://json-schema.org/draft/2020-12/schema",
            "type": "object",
            "properties": {
                "topics": {"type": "array", "items": {"type": "string"}},
                "agenda": {"type": "string"},
            },
            "additionalProperties": False,
        },
    }
    for name, value in documents.items():
        path = root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(value, indent=2) + "\n")
    (root / "skills").mkdir()
    (root / "skills/organize.md").write_text(
        "# Organize agenda\nGroup related user-supplied topics.\n"
    )
    return root


@pytest.fixture
def source(tmp_path):
    return make_source(tmp_path / "source")


def mutate(source, path, operation):
    file = source / path
    data = json.loads(file.read_text())
    operation(data)
    file.write_text(json.dumps(data))


def add_tool(source):
    tool = {
        "spec_version": "0.1",
        "id": "calendar",
        "version": "1.0.0",
        "description": "Read calendar events",
        "execution": "remote",
        "binding": "calendar.read",
        "endpoint": "https://calendar.example.com/events",
        "method": "GET",
        "input_schema": "schemas/state.json",
        "output_schema": "schemas/state.json",
        "permissions": ["calendar-network"],
        "domains": ["calendar.example.com"],
        "timeout_seconds": 10,
        "retries": 0,
        "side_effects": "read",
        "approval_required": False,
        "extensions": {},
    }
    (source / "tools").mkdir()
    (source / "tools/calendar.json").write_text(json.dumps(tool))
    mutate(
        source,
        "MANIFEST.agent",
        lambda m: m["tools"].append({"id": "calendar", "path": "tools/calendar.json"}),
    )

    def policy(p):
        p["network"]["allowed_domains"] = ["calendar.example.com"]
        p["permissions"] = [
            {
                "id": "calendar-network",
                "kind": "network",
                "description": "Calendar host",
                "required": True,
                "resources": ["calendar.example.com"],
            }
        ]
        p["budget"]["max_calls_per_tool"] = {"calendar": 2}
        p["budget"]["max_remote_calls"] = 2

    mutate(source, "policy.json", policy)


def test_unrelated_generic_package_accepted(source):
    package = load_package(source)
    assert package.manifest["package_id"] == "org.example.agenda"
    assert package.tools == {}
    assert len(package.digest) == 64
    assert permissions_summary(package)["permissions"] == []
    assert inspect_package(package)["signature_trust"] == "not verified by inspect"


@pytest.mark.parametrize(
    "mutation,match",
    [
        (lambda m: m.pop("publisher"), "publisher"),
        (lambda m: m.update(spec_version="0.2"), "0.1"),
        (lambda m: m.update(unknown_security_field=True), "Additional properties"),
        (lambda m: m["runtime"].update(minimum_version="99.0.0"), "minimum_version"),
        (lambda m: m["runtime"].update(api="unknown"), "agentpkg-runtime-v0"),
        (lambda m: m["skills"].append(dict(m["skills"][0])), "duplicate id"),
        (lambda m: m["extensions"].update(unsafe=True), "does not match"),
        (lambda m: m["dependencies"].append({"id": "another"}), "package_id"),
        (lambda m: m.update(graph="../outside.json"), "does not match"),
    ],
)
def test_manifest_fail_closed(source, mutation, match):
    mutate(source, "MANIFEST.agent", mutation)
    with pytest.raises(ValidationError, match=match):
        load_package(source)


@pytest.mark.parametrize(
    "mutation,match",
    [
        (lambda g: g["workers"][0]["skills"].append("missing"), "unknown skills"),
        (lambda g: g["workers"][0]["tools"].append("missing"), "unknown tools"),
        (lambda g: g["workers"][0]["state_read"].append("secret"), "state view"),
        (lambda g: g["workers"][0]["budget"].update(tokens=101), "budgets"),
        (lambda g: g["workers"][0].update(max_instances=2), "coordinator"),
        (lambda g: g["stages"][0]["depends_on"].append("organize"), "cyclic"),
        (lambda g: g["stages"][0]["depends_on"].append("missing"), "unknown dependency"),
        (lambda g: g["stages"][0].update(worker="Unknown"), "unknown worker"),
    ],
)
def test_graph_constraints(source, mutation, match):
    mutate(source, "graph.json", mutation)
    with pytest.raises(ValidationError, match=match):
        load_package(source)


@pytest.mark.parametrize(
    "mutation,match",
    [
        (lambda p: p["budget"].update(estimated_tokens=101), "estimated_tokens"),
        (lambda p: p["budget"].update(approval_threshold_tokens=101), "approval_threshold"),
        (lambda p: p["budget"]["max_calls_per_tool"].update(nonexistent=1), "exactly every tool"),
        (lambda p: p["delegation"].update(max_depth=2), "1 was expected"),
        (lambda p: p["delegation"].update(approved_roles=["Coordinator"]), "approved_roles"),
        (lambda p: p["network"]["allowed_domains"].append("*.example.com"), "domain"),
    ],
)
def test_policy_constraints(source, mutation, match):
    mutate(source, "policy.json", mutation)
    with pytest.raises(ValidationError, match=match):
        load_package(source)


@pytest.mark.parametrize(
    "mutation,match",
    [
        (lambda t: t.update(binding="../../execute"), "does not match"),
        (lambda t: t["permissions"].append("unknown"), "unknown permission"),
        (lambda t: t.update(endpoint="https://evil.example.com/"), "domain/method"),
        (
            lambda t: t.update(endpoint="https://user:password@calendar.example.com/"),
            "credential-free",
        ),
        (lambda t: t.update(endpoint="https://calendar.example.com:999/"), "credential-free"),
        (lambda t: t.update(input_schema="missing.json"), "declared schema"),
        (lambda t: t.update(side_effects="write"), "approval_required"),
        (lambda t: t.update(execution="local"), "local tools"),
    ],
)
def test_tool_constraints(source, mutation, match):
    add_tool(source)
    assert load_package(source).tools["calendar"]["binding"] == "calendar.read"
    mutate(source, "tools/calendar.json", mutation)
    with pytest.raises(ValidationError, match=match):
        load_package(source)


@pytest.mark.parametrize(
    "schema,match",
    [
        ({"type": "nonsense"}, "invalid JSON Schema"),
        ({"type": "object", "$ref": "https://example.com/schema"}, "offline"),
        ({"type": "object", "$ref": "../external.json"}, "traversal"),
        ({"type": "object", "$ref": "missing.json"}, "missing or undeclared"),
        ({"type": "object", "$ref": "#/no-such-definition"}, "unresolved schema"),
        ({"type": "object", "$id": "https://example.com/schema"}, "unsupported"),
        ({"type": "object", "$dynamicRef": "#node"}, "dynamic"),
    ],
)
def test_malformed_or_remote_schemas(source, schema, match):
    (source / "schemas/state.json").write_text(json.dumps(schema))
    with pytest.raises(ValidationError, match=match):
        load_package(source)


def test_offline_local_schema_reference(source):
    common = {"type": "string", "minLength": 3}
    (source / "schemas/common.json").write_text(json.dumps(common))
    mutate(
        source,
        "MANIFEST.agent",
        lambda m: m["schemas"].append({"id": "common", "path": "schemas/common.json"}),
    )
    mutate(
        source,
        "schemas/state.json",
        lambda s: s["properties"].update(agenda={"$ref": "common.json"}),
    )
    package = load_package(source)
    validate_instance(package.files, "schemas/state.json", {"agenda": "done"})
    with pytest.raises(ValidationError, match="minLength"):
        validate_instance(package.files, "schemas/state.json", {"agenda": "no"})


def test_duplicate_json_keys_and_nan_rejected(source):
    (source / "extra.json").write_text('{"a":1,"a":2}')
    with pytest.raises(ValidationError, match="duplicate JSON key"):
        load_package(source)
    (source / "extra.json").write_text('{"a":NaN}')
    with pytest.raises(ValidationError, match="strict UTF-8 JSON"):
        load_package(source)


def test_jcs_normalizes_numbers_and_keys():
    assert canonical_json({"z": 1.0, "a": 1e-7}) == b'{"a":1e-7,"z":1}'
    with pytest.raises(ValidationError):
        canonical_json({"large": 9007199254740993})


def test_build_is_reproducible_and_normalizes_json(source, tmp_path):
    a, b = tmp_path / "a.agent.pkg", tmp_path / "b.agent.pkg"
    build_package(source, a)
    mutate(source, "MANIFEST.agent", lambda m: None)
    os.utime(source / "skills/organize.md", (10, 10))
    build_package(source, b)
    assert a.read_bytes() == b.read_bytes()
    with zipfile.ZipFile(a) as archive:
        assert archive.namelist() == sorted(archive.namelist())
        assert {i.date_time for i in archive.infolist()} == {(1980, 1, 1, 0, 0, 0)}
        assert all(i.compress_type == zipfile.ZIP_STORED for i in archive.infolist())
    assert load_package(a).is_archive
    with pytest.raises(ValidationError, match="overwrite"):
        build_package(source, a)


@pytest.mark.parametrize(
    "name",
    [
        "../escape.json",
        "/absolute.json",
        "C:/escape.json",
        "dir\\escape.json",
        "CON.json",
        "dir/trailing..json",
        "bad.py",
        ".env",
        ".git/config.json",
    ],
)
def test_source_bad_paths_or_code_rejected(source, name):
    # Path spellings that the host normalizes are tested directly on archives below.
    if name == "dir/trailing..json":
        name = "dir/trailing."
    from agentpkg.package import _safe_name

    with pytest.raises(ValidationError):
        _safe_name(name)


def test_source_symlinks_executables_and_private_keys_rejected(source, tmp_path):
    (source / "link.json").symlink_to(source / "graph.json")
    with pytest.raises(ValidationError, match="symlink"):
        load_package(source)
    (source / "link.json").unlink()
    os.chmod(source / "skills/organize.md", 0o755)
    with pytest.raises(ValidationError, match="executable"):
        load_package(source)
    os.chmod(source / "skills/organize.md", 0o644)
    (source / "keys.txt").write_text("-----BEGIN PRIVATE KEY-----\nsecret\n")
    with pytest.raises(ValidationError, match="private key"):
        load_package(source)


@pytest.mark.parametrize(
    "case",
    [
        "traversal",
        "symlink",
        "duplicate",
        "case",
        "compressed",
        "executable",
        "oversized",
        "missing_integrity",
    ],
)
def test_archive_attacks_rejected(source, tmp_path, case):
    package = load_package(source)
    target = tmp_path / "attack.agent.pkg"
    if case == "missing_integrity":
        with zipfile.ZipFile(target, "w") as archive:
            for name, data in package.files.items():
                archive.writestr(name, data)
    else:
        target.write_bytes(archive_bytes(package.files))
        with zipfile.ZipFile(target, "a") as archive:
            info = zipfile.ZipInfo("extra.txt")
            data = b"hostile"
            if case == "traversal":
                info.filename = "../escape.txt"
            if case == "symlink":
                info.external_attr = (stat.S_IFLNK | 0o777) << 16
            if case == "duplicate":
                info.filename = "graph.json"
            if case == "case":
                info.filename = "GRAPH.json"
            if case == "compressed":
                info.compress_type = zipfile.ZIP_DEFLATED
            if case == "executable":
                info.external_attr = (stat.S_IFREG | 0o755) << 16
            if case == "oversized":
                data = b"x" * (MAX_MEMBER_BYTES + 1)
            archive.writestr(info, data)
    with pytest.raises(ValidationError):
        load_package(target)
    assert not (tmp_path / "escape.txt").exists()


def test_integrity_detects_tampered_extra_missing_files(source, tmp_path):
    package = load_package(source)
    original = tmp_path / "original.agent.pkg"
    original.write_bytes(archive_bytes(package.files))
    with zipfile.ZipFile(original) as archive:
        members = {name: archive.read(name) for name in archive.namelist()}
    for case in ("tamper", "extra", "missing"):
        altered = dict(members)
        if case == "tamper":
            altered["skills/organize.md"] = b"Tampered instructions"
        if case == "extra":
            altered["extra.txt"] = b"Unhashed member"
        if case == "missing":
            del altered["skills/organize.md"]
        target = tmp_path / f"{case}.agent.pkg"
        with zipfile.ZipFile(target, "w") as archive:
            for name, data in altered.items():
                archive.writestr(name, data)
        with pytest.raises(ValidationError, match="integrity mismatch"):
            load_package(target)


def test_real_signatures_trust_pin_tampering_and_key_permissions(source, tmp_path):
    artifact = build_package(source, tmp_path / "signed.agent.pkg")
    private, public = tmp_path / "key.pem", tmp_path / "public.pem"
    report = keygen(private, public)
    assert private.stat().st_mode & 0o777 == 0o600
    with pytest.raises(SignatureError, match="overwrite"):
        keygen(private, public)
    with pytest.raises(SignatureError, match="missing"):
        verify_package(artifact, public)
    sign_package(artifact, private)
    assert verify_package(artifact, public)["key_fingerprint"] == report["key_fingerprint"]
    signed = artifact.read_bytes()
    sign_package(artifact, private)
    assert artifact.read_bytes() == signed
    other_private, other_public = tmp_path / "other.pem", tmp_path / "other-public.pem"
    keygen(other_private, other_public)
    with pytest.raises(SignatureError, match="host-pinned"):
        verify_package(artifact, other_public)
    package = load_package(artifact)
    assert all(b"PRIVATE KEY" not in data for data in package.files.values())
    files = dict(package.files)
    files["skills/organize.md"] = b"Tampered but rehashed instructions"
    artifact.write_bytes(archive_bytes(files, package.signature))
    with pytest.raises(SignatureError, match="digest"):
        verify_package(artifact, public)
    os.chmod(private, 0o644)
    with pytest.raises(SignatureError, match="chmod 600"):
        sign_package(artifact, private)


def test_unpack_to_new_directory_rebuilds_same_payload(source, tmp_path):
    artifact = build_package(source, tmp_path / "original.agent.pkg")
    output = unpack_package(artifact, tmp_path / "unpacked")
    assert not (output / "integrity.json").exists()
    assert load_package(output).manifest["package_id"] == "org.example.agenda"
    rebuilt = build_package(output, tmp_path / "rebuilt.agent.pkg")
    assert artifact.read_bytes() == rebuilt.read_bytes()
    with pytest.raises(ValidationError, match="new destination"):
        unpack_package(artifact, output)
    link = tmp_path / "link"
    link.symlink_to(output, target_is_directory=True)
    with pytest.raises(ValidationError, match="new destination"):
        unpack_package(artifact, link)


def test_source_rejects_stale_envelope(source):
    (source / "integrity.json").write_text("{}")
    with pytest.raises(ValidationError, match="generated envelope"):
        load_package(source)


@pytest.mark.parametrize(
    "scope",
    [
        "ephemeral",
        "session",
        "agent-scoped",
        "publisher-scoped",
        "user-global",
        "enterprise-governed",
    ],
)
def test_memory_scope_is_representable_but_execution_fails_closed(source, scope):
    from agentpkg.runtime import PolicyError, Runtime

    path = source / "policy.json"
    value = json.loads(path.read_text())
    value["memory"]["scope"] = scope
    path.write_text(json.dumps(value))
    package = load_package(source)
    if scope in {"ephemeral", "session"}:
        Runtime(package)
    else:
        with pytest.raises(PolicyError, match="only implements"):
            Runtime(package)


@pytest.mark.parametrize(
    "kind,locator",
    [("remote", "https://agent.example/service"), ("nanda", "nanda:agent@example.org")],
)
def test_future_workers_are_inspectable_but_not_executable(source, kind, locator):
    from agentpkg.runtime import PolicyError, Runtime

    path = source / "graph.json"
    value = json.loads(path.read_text())
    value["workers"][0].update(kind=kind, locator=locator)
    path.write_text(json.dumps(value))
    package = load_package(source)
    with pytest.raises(PolicyError, match="packaged worker"):
        Runtime(package)


def test_pinned_dependency_is_inspectable_but_not_loaded(source):
    from agentpkg.runtime import PolicyError, Runtime

    path = source / "MANIFEST.agent"
    value = json.loads(path.read_text())
    value["dependencies"] = [
        {
            "package_id": "org.example.tools",
            "version": "1.0.0",
            "digest": "a" * 64,
            "locator": "https://agent.example/tools.agent.pkg",
        }
    ]
    path.write_text(json.dumps(value))
    with pytest.raises(PolicyError, match="Dependency"):
        Runtime(load_package(source))
