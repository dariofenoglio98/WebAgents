"""Executable developer commands; application execution is explicit host dispatch."""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
from pathlib import Path

from ..errors import AgentPkgError, ValidationError
from ..package import (
    _open_parent,
    build_package,
    create_directory,
    inspect_package,
    load_package,
    permissions_summary,
    unpack_package,
    write_new,
)
from ..signing import keygen, sign_package, verify_package
from ..validation import parse_json


def _json_file(path, expected_type=dict):
    value = parse_json(Path(path).read_bytes(), str(path))
    if not isinstance(value, expected_type):
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


def _write_result(directory, result):
    destination = _output_directory(directory)

    def save(name, value):
        data = (json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False) + "\n").encode(
            "utf-8"
        )
        write_new(destination / name, data, mode=0o600)

    save("result.json", result)
    if "related_work" in result:
        write_new(
            destination / "related-work.md", result["related_work"].encode("utf-8"), mode=0o600
        )
        for field in ("bibliography", "evidence_table", "unresolved", "evals"):
            save(field.replace("_", "-") + ".json", result[field])
        bibtex = "\n\n".join(
            entry["bibtex"] for entry in result["bibliography"] if entry.get("bibtex")
        )
        write_new(destination / "bibliography.bib", (bibtex + "\n").encode("utf-8"), mode=0o600)
    for field in ("audit", "usage", "provenance"):
        if field in result:
            save(field + ".json", result[field])
    return destination


def parser():
    root = argparse.ArgumentParser(
        prog="agentpkg",
        description="Agent Package v0: inspectable declarations, host-controlled authority",
    )
    root.add_argument(
        "--version", action="version", version="agentpkg 0.1.0 (experimental spec 0.1)"
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
    run = commands.add_parser("run", help="Execute a declared entrypoint supported by this host")
    run.add_argument("package")
    run.add_argument("--question", required=True)
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
        "--seed",
        action="append",
        default=[],
        help="Optional seed title; repeat for multiple papers",
    )
    run.add_argument("--seeds", help="JSON list of seed title strings or paper metadata objects")
    run.add_argument("--pdf-map", help="JSON map of paper identifiers to selected file IDs")
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
        from ..openclaw import stage_openclaw

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
    if command in ("run", "eval") and package.manifest["entrypoint"] != "literature.review":
        raise AgentPkgError(
            f"No installed host workflow for {package.manifest['entrypoint']!r}; "
            "format validation is independent of installed workflows"
        )
    if command == "run":
        from .literature import run_review

        if args.mode == "live" and not args.trust_key:
            raise AgentPkgError("Live run requires a signed artifact and --trust-key PUBLIC_KEY")
        if args.trust_key:
            verified = verify_package(args.package, trusted_key=args.trust_key)
            if verified["digest"] != package.digest:
                raise AgentPkgError("Package changed between loading and signature verification")
        router = None
        if args.router_config:
            from ..models import HTTPRouter

            router = HTTPRouter.from_config(args.router_config)
        seeds = (_json_file(args.seeds, list) if args.seeds else []) + args.seed
        grants = _json_file(args.grants)
        options = {"mode": args.mode, "grants": grants, "router": router, "seeds": seeds}
        for flag, key in [
            ("pdf_map", "pdfs"),
            ("selected_files", "selected_files"),
            ("limits", "limits"),
        ]:
            path = getattr(args, flag)
            if path:
                options[key] = _json_file(path)
        if args.resolver_base_url:
            options["resolver_base_url"] = args.resolver_base_url
        # Detect destination conflicts before executing any charged operation.
        if (
            Path(args.out).exists()
            or Path(args.out).is_symlink()
            or not Path(args.out).parent.is_dir()
        ):
            raise ValidationError("run --out must name a new directory under an existing parent")
        parent_fd, _ = _open_parent(args.out)
        import os

        os.close(parent_fd)
        try:
            result = asyncio.run(run_review(package, args.question, **options))
        except Exception as exc:
            report = getattr(exc, "execution_report", None)
            if report is not None:
                _write_result(args.out, report)
            raise
        destination = _write_result(args.out, result)
        return {
            "output": str(destination),
            "mode": args.mode,
            "usage": result["usage"],
            "unresolved_count": len(result["unresolved"]),
            "evals": result["evals"],
        }
    if command == "eval":
        from .literature_evals import run_evals

        result = asyncio.run(run_evals(package))
        if args.out:
            _write_result(args.out, result)
        return result
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


if __name__ == "__main__":
    raise SystemExit(main())
