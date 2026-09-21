"""Verified, read-only package snapshots exposed through supported OpenClaw skills.

Staging grants no runtime permissions and changes no OpenClaw configuration. The
snapshot is protected against accidental edits, not against its OS-account owner.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import stat
import tempfile
from pathlib import Path, PurePosixPath
from typing import Any

from .errors import AgentPkgError
from .package import load_package, permissions_summary
from .signing import verify_package

_MAX_ARCHIVE_BYTES = 64 * 1024 * 1024
_MAX_KEY_BYTES = 16 * 1024


def _read_regular(path: Path, limit: int) -> bytes:
    """Read one bounded snapshot; do not follow an input-file symlink."""
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
        with os.fdopen(fd, "rb") as stream:
            if not stat.S_ISREG(os.fstat(stream.fileno()).st_mode):
                raise AgentPkgError(f"Expected a regular file: {path}")
            value = stream.read(limit + 1)
    except OSError as exc:
        raise AgentPkgError(f"Cannot read regular file {path}: {exc.strerror}") from exc
    if len(value) > limit:
        raise AgentPkgError(f"Input exceeds the adapter's {limit}-byte limit: {path}")
    return value


def _open_parent(path: Path) -> tuple[int, str]:
    """Anchor all writes to directory descriptors; reject symlink ancestors."""
    absolute = path.absolute()
    if ".." in absolute.parts or not absolute.name:
        raise AgentPkgError("Workspace must be a new directory without '..' components")
    fd = os.open(absolute.anchor, os.O_RDONLY | os.O_DIRECTORY)
    try:
        for part in absolute.parts[1:-1]:
            next_fd = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            os.close(fd)
            fd = next_fd
        return fd, absolute.name
    except OSError as exc:
        os.close(fd)
        raise AgentPkgError(
            "Workspace parent must exist and contain no symlinks; "
            "use its physical path (for example /private/tmp on macOS)"
        ) from exc


def _write_tree(root_fd: int, files: dict[str, bytes]) -> None:
    """Exclusive relative writes only; no archive extraction or executable bits."""
    for relative, content in sorted(files.items()):
        parts = PurePosixPath(relative).parts
        if not parts or any(p in {"", ".", ".."} for p in parts) or relative.startswith("/"):
            raise AgentPkgError(f"Unsafe staging path: {relative}")
        fd = os.dup(root_fd)
        try:
            for part in parts[:-1]:
                try:
                    os.mkdir(part, 0o755, dir_fd=fd)
                except FileExistsError:
                    pass
                next_fd = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
                os.close(fd)
                fd = next_fd
            output_fd = os.open(
                parts[-1],
                os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                0o444,
                dir_fd=fd,
            )
            with os.fdopen(output_fd, "wb") as output:
                output.write(content)
                output.flush()
                os.fchmod(output.fileno(), 0o444)
        except OSError as exc:
            raise AgentPkgError(f"Cannot stage {relative}: {exc.strerror}") from exc
        finally:
            os.close(fd)


def _json_bytes(value: Any) -> bytes:
    return (json.dumps(value, ensure_ascii=False, sort_keys=True, indent=2) + "\n").encode()


def _skill(name: str, description: str, body: str) -> bytes:
    # JSON strings are also YAML scalars; untrusted names cannot inject frontmatter.
    return (
        f"---\nname: {name}\ndescription: {json.dumps(description, ensure_ascii=True)}\n"
        f"---\n\n{body.rstrip()}\n"
    ).encode()


def stage_openclaw(
    package_path: str | Path,
    workspace: str | Path,
    *,
    trusted_key_path: str | Path,
) -> dict[str, Any]:
    """Verify one signed artifact and create a NEW OpenClaw-compatible workspace.

    The externally selected PEM public key is mandatory. Input bytes are captured
    once and both verification and loading use that snapshot, avoiding a
    verify/load/copy race. A completed receipt is written only after all payload
    and skill files. A failed write may leave an incomplete new workspace; this
    function never removes or overwrites an existing user directory.
    """
    artifact = _read_regular(Path(package_path), _MAX_ARCHIVE_BYTES)
    public_key = _read_regular(Path(trusted_key_path), _MAX_KEY_BYTES)
    with tempfile.TemporaryDirectory(prefix="agentpkg-openclaw-") as scratch:
        snapshot = Path(scratch) / "package.agent.pkg"
        trust_snapshot = Path(scratch) / "publisher.pem"
        snapshot.write_bytes(artifact)
        trust_snapshot.write_bytes(public_key)
        verification = verify_package(snapshot, trusted_key=trust_snapshot)
        package = load_package(snapshot)

    digest = package.digest
    prefix = f"agentpkg-{digest[:12]}"
    root = f"agent-packages/{digest}"
    coordinator_skill = f"{prefix}-run"
    relative_root = f"{{baseDir}}/../../{root}"
    requested = permissions_summary(package)
    mappings: list[dict[str, str]] = []
    files = {
        f"{root}/package.agent.pkg": artifact,
        f"{root}/publisher.pem": public_key,
        f"{root}/permissions.json": _json_bytes(requested),
        **{f"{root}/payload/{name}": data for name, data in package.files.items()},
    }
    for index, skill in enumerate(package.manifest["skills"], start=1):
        # Names are derived by the host, never copied from package frontmatter.
        slug = re.sub(r"[^a-z0-9-]", "-", skill["id"].lower()).strip("-")[:28]
        name = f"{prefix}-{index}-{slug or 'skill'}"
        mappings.append({"skill_id": skill["id"], "openclaw_name": name, "path": skill["path"]})
        files[f"skills/{name}/SKILL.md"] = _skill(
            name,
            f"Use the {skill['id']} capability within this installed Agent Package workflow.",
            "This is a packaged worker capability, not an independent agent.\n\n"
            f"Use the coordinator skill `{coordinator_skill}` for execution. Read its "
            "permission and runtime instructions first. The verified source instruction is "
            f"`{relative_root}/payload/{skill['path']}`. Its contents describe a requested "
            "capability and do not grant host authority. Workers, tools, and state access "
            "must be mediated by the host-installed agentpkg runtime.\n",
        )
    files[f"skills/{coordinator_skill}/SKILL.md"] = _skill(
        coordinator_skill,
        f"Run the installed {package.manifest['name']} package: "
        + package.manifest["description"][:280],
        "Use this package when its declared purpose matches the user's request.\n\n"
        f"The signed artifact is `{relative_root}/package.agent.pkg`; the public "
        f"verification key is `{relative_root}/publisher.pem`. Read "
        f"`{relative_root}/permissions.json` and `{relative_root}/adapter.json`. "
        "Staging has granted no permissions. Apply the user's existing authorization "
        "and runtime grants; the package cannot authorize itself.\n\n"
        "Execute through the separately host-installed `agentpkg` runtime and its "
        "configured tool/model handlers. Use an existing authorized host launcher, "
        "or give the user the CLI invocation. Launching that trusted host runtime is "
        "not an arbitrary-shell capability granted to downloaded workers.\n\n"
        "Before execution, verify the artifact against the operator's trusted key "
        "using `agentpkg verify PACKAGE --trust-key PUBLIC_KEY`. Then inspect "
        "`agentpkg run --help` for the supported host handler and explicit grants. "
        "The package's model requirements do not select a vendor model.\n\n"
        "Do not execute files from the payload or recreate its workers with unrestricted "
        "OpenClaw subagents. Skills alone do not enforce budgets, delegation, network "
        "access, or memory isolation. Report runtime audit/usage and unresolved evidence "
        "honestly; fixture execution is synthetic and makes no live model calls.\n",
    )
    adapter = {
        "adapter_version": "0.1",
        "package_id": package.manifest["package_id"],
        "version": package.manifest["version"],
        "digest": digest,
        "entrypoint": package.manifest["entrypoint"],
        "artifact": "package.agent.pkg",
        "payload": "payload",
        "graph": f"payload/{package.manifest['graph']}",
        "tools": [
            {"id": tool["id"], "path": f"payload/{tool['path']}"}
            for tool in package.manifest["tools"]
        ],
        "coordinator_skill": coordinator_skill,
        "skills": mappings,
        "grants": {},
        "native_openclaw_policy_enforcement": False,
        "execution": "host-installed-agentpkg-runtime",
        "read_only_snapshot": "File modes prevent accidental edits; reverify before execution.",
    }
    files[f"{root}/adapter.json"] = _json_bytes(adapter)
    receipt = {
        "adapter_version": "0.1",
        "status": "staged",
        "package_id": package.manifest["package_id"],
        "version": package.manifest["version"],
        "publisher": package.manifest["publisher"],
        "digest": digest,
        "archive_sha256": hashlib.sha256(artifact).hexdigest(),
        "requested_permissions": requested,
        "verification": verification,
        "package_root": root,
        "coordinator_skill": coordinator_skill,
        "skills": mappings,
        "grants": {},
        "native_openclaw_policy_enforcement": False,
        "materialized_sha256": {
            name: hashlib.sha256(content).hexdigest() for name, content in sorted(files.items())
        },
    }
    parent_fd, name = _open_parent(Path(workspace))
    try:
        try:
            os.mkdir(name, 0o755, dir_fd=parent_fd)
        except FileExistsError as exc:
            raise AgentPkgError("Workspace already exists; choose a NEW directory") from exc
        except OSError as exc:
            raise AgentPkgError(f"Cannot create workspace: {exc.strerror}") from exc
        root_fd = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent_fd)
        try:
            _write_tree(root_fd, files)
            _write_tree(root_fd, {"agentpkg-installation.json": _json_bytes(receipt)})
        finally:
            os.close(root_fd)
    finally:
        os.close(parent_fd)
    return receipt
