"""Assemble the public WebAir origin's deployment bundle: an allowlist, never a directory.

    python3 demo/webair/deploy/bundle.py --package dist/webair-0.8.0.agent.pkg --out <new dir>

The bundle holds exactly what the public origin runs:

    railway.toml  railpack.json            how Railway builds, starts and health-checks it
    .python-version                        (this directory; Railpack plans the image before
                                           railway.toml's start command applies, so both say it)
    requirements.txt                       the origin's pinned runtime dependencies
    origin/**.py, **.html, **.css          the origin's code, templates and stylesheet
    agent.pkg                              the one signed package /agent.pkg serves, verbatim
    demo/agent-index.json                  the WebAgents demo documents served beside the
    demo/policies/webagents-research.json  airline (T8, `origin/demo_documents.py`): the signed
    demo/packages/literature-review-…      index, the signed example policy, and the signed
    demo/packages/travel-network-0.1.0…    Literature Review packages (0.2.9, which the index
                                           lists, and 0.2.8, 0.2.7, 0.2.6 and 0.2.5, which
                                           indexes 1.3.0 to 1.0.0 listed) and the travel
                                           network (T26), verbatim
    BUNDLE.json                            what is in it: every file's size and SHA-256

Nothing else from the repository goes in. In particular the demo host's own configuration
(`demo/webair/host-resources.json`, the fictional passengers and payment methods a person's
host holds, and `demo/webair/host-bindings.json`) lives next to the origin's code but belongs
to the person's runtime, not to WebAir, so it is never part of the bundle; the bundle is
checked for every resource id, name, email and label that file holds before it is written.

The same inputs give byte-identical output (BUNDLE.json has no timestamp), so a deployed bundle
can be compared with the repository at any commit. Standard library only.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import shutil
import sys
import zipfile
from pathlib import Path

DEPLOY = Path(__file__).resolve().parent
DEMO = DEPLOY.parent
ORIGIN = DEMO / "origin"
REPO = DEMO.parent.parent
# The WebAgents demo documents (T8): bundle path → repository source, all signed artifacts.
DEMO_DOCUMENTS = {
    "demo/agent-index.json": REPO / "examples" / "agent-index.json",
    "demo/policies/webagents-research.json": REPO
    / "examples"
    / "policies"
    / "webagents-research.json",
    "demo/packages/literature-review-0.2.9.agent.pkg": REPO
    / "dist"
    / "literature-review-0.2.9.agent.pkg",
    "demo/packages/literature-review-0.2.8.agent.pkg": REPO
    / "dist"
    / "literature-review-0.2.8.agent.pkg",
    "demo/packages/literature-review-0.2.7.agent.pkg": REPO
    / "dist"
    / "literature-review-0.2.7.agent.pkg",
    "demo/packages/literature-review-0.2.6.agent.pkg": REPO
    / "dist"
    / "literature-review-0.2.6.agent.pkg",
    "demo/packages/literature-review-0.2.5.agent.pkg": REPO
    / "dist"
    / "literature-review-0.2.5.agent.pkg",
    # The travel network (network.v0, T26, D-290), which index 1.6.0 names.
    "demo/packages/travel-network-0.1.0.agent.pkg": REPO
    / "dist"
    / "travel-network-0.1.0.agent.pkg",
}
HOST_RESOURCES = DEMO / "host-resources.json"
MAX_PACKAGE_BYTES = 16 * 1024 * 1024
ORIGIN_SUFFIXES = {".py", ".html", ".css"}
# The campaign origin's injection mode (T31, D-351) lives beside the origin's code but is never
# deployed: the public bundle cannot enable what it does not contain.
ORIGIN_EXCLUDED = {"injection.py"}
# Files this bundle may never carry, whatever the allowlist above says.
HOST_FILES = {"host-resources.json", "host-bindings.json"}


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def package_identity(data: bytes, source: Path) -> dict:
    """The package id and version from the archive's manifest. Not a verification."""
    import io

    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        manifest = json.loads(archive.read("MANIFEST.agent"))
    return {
        "source": source.name,
        "package_id": manifest["package_id"],
        "version": manifest["version"],
        "bytes": len(data),
        "sha256": sha256(data),
    }


def allowlist(package: Path) -> dict[str, bytes]:
    files = {
        "railway.toml": (DEPLOY / "railway.toml").read_bytes(),
        "railpack.json": (DEPLOY / "railpack.json").read_bytes(),
        ".python-version": (DEPLOY / ".python-version").read_bytes(),
        "requirements.txt": (DEMO / "requirements.txt").read_bytes(),
        "agent.pkg": package.read_bytes(),
    }
    for name, source in DEMO_DOCUMENTS.items():
        files[name] = source.read_bytes()
    for path in sorted(ORIGIN.rglob("*")):
        if (
            path.is_file()
            and path.suffix in ORIGIN_SUFFIXES
            and "__pycache__" not in path.parts
            and path.name not in ORIGIN_EXCLUDED
        ):
            files[f"origin/{path.relative_to(ORIGIN).as_posix()}"] = path.read_bytes()
    return files


def host_values() -> list[str]:
    """What only the person's host holds: resource ids, labels, names, emails, preferences."""
    definitions = json.loads(HOST_RESOURCES.read_text(encoding="utf-8"))
    values = []
    for resource in definitions["resources"]:
        values.append(resource["id"])
        value = resource["value"]
        # A payment method's identifier and display name are WebAir's own vocabulary (the
        # demo methods its API and payment page accept); the host's wallet entry only refers
        # to one. Its resource id, above, is the host's.
        if "payment_method_id" in value:
            continue
        values.append(resource["label"])
        for field in ("given_name", "family_name", "contact_email"):
            if field in value:
                values.append(value[field])
        if "given_name" in value:
            values.append(f"{value['given_name']} {value['family_name']}")
    return values


def leaks(files: dict[str, bytes]) -> list[str]:
    found = []
    values = host_values()
    for name, data in files.items():
        if Path(name).name in HOST_FILES:
            found.append(f"{name}: a host configuration file")
            continue
        if name.endswith("agent.pkg"):
            continue  # signed bytes, checked by the package's own tests and by verification
        text = data.decode("utf-8", errors="replace")
        found += [f"{name}: {value!r}" for value in values if value in text]
    return found


def assemble(package: Path, out: Path, expect_sha256: str | None = None) -> dict:
    info = package.stat()
    if not package.is_file() or info.st_size == 0 or info.st_size > MAX_PACKAGE_BYTES:
        raise SystemExit(
            f"bundle: {package} must be a regular file of 1..{MAX_PACKAGE_BYTES} bytes"
        )
    files = allowlist(package)
    identity = package_identity(files["agent.pkg"], package)
    if expect_sha256 and identity["sha256"] != expect_sha256:
        raise SystemExit(f"bundle: {package} has SHA-256 {identity['sha256']}, not {expect_sha256}")
    problems = leaks(files)
    if problems:
        raise SystemExit("bundle: refusing to write host data:\n  " + "\n  ".join(problems))
    if out.exists() and any(out.iterdir()):
        raise SystemExit(f"bundle: {out} exists and is not empty")
    manifest = {
        "profile": "webair-deploy-bundle-v0",
        "note": "The public WebAir origin's deployment bundle, assembled by "
        "demo/webair/deploy/bundle.py. Fictional demo airline: no real booking or payment.",
        "agent_package": identity,
        "files": [
            {"path": name, "bytes": len(data), "sha256": sha256(data)}
            for name, data in sorted(files.items())
        ],
    }
    out.mkdir(parents=True, exist_ok=True)
    for name, data in files.items():
        target = out / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)
    rendered = (json.dumps(manifest, indent=2) + "\n").encode()
    (out / "BUNDLE.json").write_bytes(rendered)
    manifest["bundle_json_sha256"] = sha256(rendered)
    return manifest


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--package", required=True, type=Path, help="the signed .agent.pkg")
    parser.add_argument("--out", required=True, type=Path, help="a new or empty directory")
    parser.add_argument("--expect-sha256", help="refuse unless the package has this SHA-256")
    parser.add_argument("--force", action="store_true", help="replace an existing --out")
    args = parser.parse_args(argv)
    if args.force and args.out.exists():
        shutil.rmtree(args.out)
    manifest = assemble(args.package.resolve(), args.out.resolve(), args.expect_sha256)
    print(json.dumps(manifest, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
