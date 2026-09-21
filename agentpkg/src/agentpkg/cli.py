"""Executable developer commands; application execution is explicit host dispatch."""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
from pathlib import Path

from .errors import AgentPkgError, ValidationError
from .package import (
    _open_parent,
    build_package,
    create_directory,
    inspect_package,
    load_package,
    permissions_summary,
    unpack_package,
    write_new,
)
from .signing import keygen, sign_package, verify_package
from .validation import parse_json


def _json_file(path, expected_type=dict):
    value = parse_json(Path(path).read_bytes(), str(path))
    if expected_type is not None and not isinstance(value, expected_type):
        raise ValidationError(f"{path}: expected JSON {expected_type.__name__}")
    return value


def _print(value):
    print(json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False))


def _output_directory(path):
    path = Path(path)
    if path.exists() or path.is_symlink():
        raise ValidationError(f"output requires a new directory; refusing to overwrite {path}")
    if not path.parent.is_dir():
        raise ValidationError(f"output parent does not exist: {path.parent}")
    return create_directory(path)


def _write_result(directory, result, package=None):
    destination = _output_directory(directory)

    def save(name, value):
        data = (json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False) + "\n").encode(
            "utf-8"
        )
        write_new(destination / name, data, mode=0o600)

    save("result.json", result)
    for field in ("audit", "usage", "provenance"):
        if field in result:
            save(field + ".json", result[field])
    if package is not None and result.get("status") == "completed":
        from .workflow_values import evaluate

        for export in package.graph.get("exports", []):
            value = evaluate(export["value"], {"result": result["output"]})
            if export["format"] == "json":
                save(export["path"], value)
            else:
                if not isinstance(value, str):
                    raise ValidationError("Text exports must select strings")
                write_new(destination / export["path"], value.encode("utf-8"), mode=0o600)
    return destination


def parser():
    root = argparse.ArgumentParser(
        prog="agentpkg",
        description="Agent Package v0: inspectable declarations, host-controlled authority",
    )
    root.add_argument(
        "--version", action="version", version="agentpkg 0.2.0 (agent.pkg 0.1, workflow.v0)"
    )
    commands = root.add_subparsers(dest="command", required=True)
    for name, help_text in [
        ("validate", "Validate source or artifact structure, schemas, references, and hashes"),
        ("inspect", "Inspect metadata without asserting publisher trust"),
        ("permissions", "Render requested permissions and execution limits"),
    ]:
        command = commands.add_parser(name, help=help_text)
        command.add_argument("package")
    build = commands.add_parser(
        "build", help="Validate and reproducibly build a ZIP_STORED artifact"
    )
    build.add_argument("source")
    build.add_argument("-o", "--output", required=True)
    keys = commands.add_parser("keygen", help="Generate an Ed25519 key pair; never overwrite a key")
    keys.add_argument("--private-key", required=True)
    keys.add_argument("--public-key", required=True)
    sign = commands.add_parser(
        "sign", help="Sign a built artifact with an owner-only Ed25519 private key"
    )
    sign.add_argument("package")
    sign.add_argument("--private-key", required=True)
    sign.add_argument("-o", "--output")
    verify = commands.add_parser(
        "verify", help="Verify hashes and publisher signature against an external pinned key"
    )
    verify.add_argument("package")
    verify.add_argument("--trust-key", required=True)
    unpack = commands.add_parser(
        "unpack", help="Extract validated payload as a source tree in a new directory"
    )
    unpack.add_argument("package")
    unpack.add_argument("-o", "--output", required=True)
    install = commands.add_parser(
        "install-openclaw", help="Verify and stage package in a NEW OpenClaw-compatible workspace"
    )
    install.add_argument("package")
    install.add_argument("--workspace", required=True)
    install.add_argument("--trust-key", required=True)
    run = commands.add_parser("run", help="Execute any workflow.v0 package")
    run.add_argument("package")
    run.add_argument("--input", help="JSON input matching the package workflow input schema")
    run.add_argument("--mode", choices=["fixture", "live"], default="fixture")
    run.add_argument(
        "--grants",
        required=True,
        help="Host JSON map of permission IDs to once/session/always/deny",
    )
    run.add_argument(
        "--router-config",
        help="Host vendor-neutral router configuration; secrets remain in environment",
    )
    run.add_argument(
        "--trust-key",
        help="Required for live mode; validates the archive publisher before dispatch",
    )
    run.add_argument(
        "--selected-files", help="Host JSON map of selected file IDs to local PDF paths"
    )
    run.add_argument(
        "--resolver-base-url", help="Host HTTPS resolver override; cannot extend declared domains"
    )
    run.add_argument(
        "--limits", help="Optional host JSON limits, which can only lower package budgets"
    )
    run.add_argument("--out", required=True, help="New private output directory")
    evaluate = commands.add_parser(
        "eval", help="Run the supported host evaluation harness with explicit synthetic fixtures"
    )
    evaluate.add_argument("package")
    evaluate.add_argument("--out", help="Optional new directory for the evaluation report")
    return root


def _dispatch(args):
    command = args.command
    if command == "build":
        path = build_package(args.source, args.output)
        return {"artifact": str(path), "digest": load_package(path).digest}
    if command == "keygen":
        return keygen(args.private_key, args.public_key)
    if command == "sign":
        path = sign_package(args.package, args.private_key, args.output)
        return {
            "artifact": str(path),
            "signed": True,
            "digest": load_package(path).digest,
            "trust": "Verify using a separately pinned publisher public key",
        }
    if command == "verify":
        return verify_package(args.package, trusted_key=args.trust_key)
    if command == "unpack":
        return {
            "source": str(unpack_package(args.package, args.output)),
            "signature_preserved": False,
        }
    if command == "install-openclaw":
        from .openclaw import stage_openclaw

        return stage_openclaw(args.package, args.workspace, trusted_key_path=args.trust_key)
    package = load_package(args.package)
    if command == "validate":
        return {
            "valid": True,
            "package_id": package.manifest["package_id"],
            "version": package.manifest["version"],
            "digest": package.digest,
            "signature_present": package.signature is not None,
            "publisher_trust": "not checked; use verify --trust-key",
        }
    if command == "inspect":
        return inspect_package(package)
    if command == "permissions":
        return permissions_summary(package)
    if command in ("run", "eval"):
        from .fixtures import fixture_adapters
        from .workflow import run_workflow

        if package.manifest["entrypoint"] != "workflow.v0":
            raise AgentPkgError(
                "Generic execution requires workflow.v0; use agentpkg-legacy "
                "for the archived development profile"
            )
        mode = args.mode if command == "run" else "fixture"
        if mode == "live" and not args.trust_key:
            raise AgentPkgError("Live run requires a signed artifact and --trust-key PUBLIC_KEY")
        if command == "run" and args.trust_key:
            verified = verify_package(args.package, trusted_key=args.trust_key)
            if verified["digest"] != package.digest:
                raise AgentPkgError("Package changed between loading and signature verification")
        if mode == "fixture":
            router, handlers, input_value = fixture_adapters(package)
        else:
            from .models import HTTPRouter
            from .tools import create_handlers

            if not args.router_config or not args.input:
                raise AgentPkgError("Live workflow execution requires --router-config and --input")
            router = HTTPRouter.from_config(args.router_config)
            handlers = create_handlers(
                package,
                selected_files=(_json_file(args.selected_files) if args.selected_files else None),
                resolver_base_url=args.resolver_base_url,
            )
            input_value = _json_file(args.input, None)
        grants = (
            _json_file(args.grants)
            if command == "run"
            else {p["id"]: "session" for p in package.policy["permissions"]}
        )
        if command == "run" and args.input:
            input_value = _json_file(args.input, None)
        options = dict(grants=grants, handlers=handlers, router=router)
        if command == "run" and args.limits:
            options["limits"] = _json_file(args.limits)
        if args.out:
            if (
                Path(args.out).exists()
                or Path(args.out).is_symlink()
                or not Path(args.out).parent.is_dir()
            ):
                raise ValidationError("--out must name a new directory under an existing parent")
            import os

            parent_fd, _ = _open_parent(args.out)
            os.close(parent_fd)
        try:
            result = asyncio.run(run_workflow(package, input_value, **options))
        except Exception as exc:
            report = getattr(exc, "execution_report", None)
            if report is not None and args.out:
                _write_result(args.out, report)
            raise
        if args.out:
            _write_result(args.out, result, package)
        return {
            "status": result["status"],
            "profile": "workflow.v0",
            "output_directory": args.out,
            "usage": result["usage"],
            "fixture_replay": mode == "fixture",
            "passed": result["status"] == "completed",
        }
    raise AgentPkgError(f"Unsupported command: {command}")


def main(argv=None):
    args = parser().parse_args(argv)
    try:
        result = _dispatch(args)
        _print(result)
        if args.command == "eval" and result.get("passed") is False:
            return 1
        return 0
    except (AgentPkgError, OSError, ValueError) as exc:
        print(f"agentpkg: {exc}", file=sys.stderr)
        return 2
