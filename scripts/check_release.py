"""Release-tree consistency checks; offline, no credentials, no execution.

    agentpkg/.venv/bin/python scripts/check_release.py [--built-wheel PATH]

Checks that the current signed example packages are exactly the documented ones
(identity, package digest, archive SHA-256, signer, execution profile), that the
SHA-256 list in dist/README.md matches every file in dist/, that the license
files and package metadata agree, and that material kept local is not tracked.
With --built-wheel, it also checks that a wheel freshly built from agentpkg/
has the same files and metadata as the shipped dist/agentpkg-*.whl.

Prints a JSON report and exits 1 if any check fails.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import subprocess
import sys
import tomllib
import zipfile
from pathlib import Path

from agentpkg.package import load_package
from agentpkg.signing import verify_package

ROOT = Path(__file__).resolve().parents[1]
DIST = ROOT / "dist"
WHEEL = DIST / "agentpkg-0.2.2-py3-none-any.whl"
# SHA-256 of https://www.apache.org/licenses/LICENSE-2.0.txt
APACHE_2_0_SHA256 = "cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30"

CURRENT_PACKAGES = {
    "meeting-agenda": {
        "package_id": "org.webagents.meeting-agenda",
        "version": "0.2.2",
        "digest": "dbd2eb816bb8687d4a5b3448f5b82bc0716c3884f9fee8a2c578af0c5e894679",
        "archive_sha256": "7b148e845c0f9e38d752a51a8d0b60a314842a3de3a2723b3bdf1a0c041921e1",
        "key": "examples/keys/meeting-agenda-publisher.pub.pem",
        "fingerprint": "sha256:2bcc374a7fe18e50622042b7d0375fcb24eb3607879a236f9f3c3ede1922c5c4",
        "tools": [],
    },
    "literature-review": {
        "package_id": "org.webagents.literature-review",
        "version": "0.2.5",
        "digest": "cef9ebd68df9db3b36c1ffeac9069d734b0e41a40d58445aaba1a60eaac155b5",
        "archive_sha256": "1669f83fafac3434748fc19d38a8d3d2c3352da83cf1cbb84796ce313bd4f571",
        "key": "examples/keys/literature-review-publisher.pub.pem",
        "fingerprint": "sha256:c5ca9763f9fc71253298ca381ec14c4d7432009c74dacc69df6344b71de05232",
        "tools": ["citation-resolver", "paper-reader", "scholarly-search"],
    },
    # The fictional WebAir origin's packages (demo/webair), new in v0.2.0. The current one has no
    # unversioned alias: `webair.agent.pkg` stays 0.1.0, which the recorded evidence pins.
    "webair-0.3.0": {
        "stem": "webair",
        "alias": False,
        "package_id": "org.webagents.webair",
        "version": "0.3.0",
        "digest": "ffe8f5b344f97c631498bb6da3e17217ae7e5730721935b0e66c5d595b335e94",
        "archive_sha256": "b537cf5cba06bce8137533eb75b491486f57caf3098af30f657343b741492887",
        "key": "examples/keys/webair-publisher.pub.pem",
        "fingerprint": "sha256:2e53accec575b37bf16c189e03cd3a6b2f2cfae2339ff05361bf585dc3d4a20b",
        "tools": [
            "get-fare-rules",
            "personal.passenger_identity",
            "personal.travel_profile",
            "prepare-booking",
            "search-flights",
            "simulate-purchase",
            "wallet.payment_method",
        ],
    },
    "webair": {
        "package_id": "org.webagents.webair",
        "version": "0.1.0",
        "digest": "3b7c61a7bd9584e0217dda802065248c86dd135d210b8a06ab25239835cc2fb6",
        "archive_sha256": "73872c3177a9ec281a8875ae154023a72ff10f9fe96c5a82ed1639a34ecb470c",
        "key": "examples/keys/webair-publisher.pub.pem",
        "fingerprint": "sha256:2e53accec575b37bf16c189e03cd3a6b2f2cfae2339ff05361bf585dc3d4a20b",
        "tools": ["get-fare-rules", "prepare-booking", "search-flights", "simulate-purchase"],
    },
}
# Present in the working copy, never in the published tree.
LOCAL_ONLY = (
    "Portable AI Agents and the OpenClaw Agent-Native Browser.pdf",
    "private/",
    "examples/demo-live/",
    "examples/demo-live-final/",
    "examples/demo-live-fulltext/",
)


def sha256_file(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def check_packages() -> dict:
    report = {}
    for name, expected in CURRENT_PACKAGES.items():
        versioned = DIST / f"{expected.get('stem', name)}-{expected['version']}.agent.pkg"
        archive = DIST / f"{name}.agent.pkg" if expected.get("alias", True) else versioned
        package = load_package(archive)
        signature = verify_package(archive, ROOT / expected["key"])
        observed = {
            "package_id": package.manifest["package_id"],
            "version": package.manifest["version"],
            "digest": package.digest,
            "archive_sha256": sha256_file(archive),
            "fingerprint": signature["key_fingerprint"],
            "tools": sorted(package.tools),
        }
        report[name] = {
            **observed,
            "signature_valid": signature["valid"] is True,
            "profile": package.graph["profile"],
            "identical_to_versioned_copy": versioned.read_bytes() == archive.read_bytes(),
            "matches_expected": all(observed[k] == expected[k] for k in observed),
        }
        report[name]["passed"] = (
            report[name]["matches_expected"]
            and report[name]["signature_valid"]
            and report[name]["profile"] == "workflow.v0"
            and report[name]["identical_to_versioned_copy"]
        )
    origin = ROOT / "package-origin/packages/literature-review-0.2.5.agent.pkg"
    report["package_origin_copy_identical"] = (
        origin.read_bytes() == (DIST / "literature-review.agent.pkg").read_bytes()
    )
    return report


def check_dist_manifest() -> dict:
    text = (DIST / "README.md").read_text(encoding="utf-8")
    listed = {name: digest for digest, name in re.findall(r"^([0-9a-f]{64})  (\S+)$", text, re.M)}
    present = {p.name for p in DIST.iterdir() if p.is_file() and p.name != "README.md"}
    mismatched = sorted(
        name
        for name, digest in listed.items()
        if (DIST / name).is_file() and sha256_file(DIST / name) != digest
    )
    return {
        "listed": len(listed),
        "unlisted_files": sorted(present - set(listed)),
        "listed_but_missing": sorted(set(listed) - present),
        "hash_mismatches": mismatched,
        "passed": bool(listed) and present == set(listed) and not mismatched,
    }


def check_license() -> dict:
    agentpkg = tomllib.loads((ROOT / "agentpkg/pyproject.toml").read_text())["project"]
    resolver = tomllib.loads((ROOT / "citation-resolver/pyproject.toml").read_text())["project"]
    plugin = json.loads((ROOT / "openclaw-agent-browser/package.json").read_text())
    with zipfile.ZipFile(WHEEL) as wheel:
        names = wheel.namelist()
        metadata = wheel.read("agentpkg-0.2.2.dist-info/METADATA").decode()
        wheel_license = (
            wheel.read("agentpkg-0.2.2.dist-info/licenses/LICENSE")
            if ("agentpkg-0.2.2.dist-info/licenses/LICENSE" in names)
            else b""
        )
    report = {
        "root_license_is_apache_2_0": sha256_file(ROOT / "LICENSE") == APACHE_2_0_SHA256,
        "agentpkg_license_copy_identical": (ROOT / "agentpkg/LICENSE").read_bytes()
        == (ROOT / "LICENSE").read_bytes(),
        "agentpkg_metadata": agentpkg.get("license") == "Apache-2.0"
        and agentpkg.get("license-files") == ["LICENSE"],
        "citation_resolver_metadata": resolver.get("license") == "Apache-2.0",
        "plugin_metadata": plugin.get("license") == "Apache-2.0",
        "wheel_license_expression": "License-Expression: Apache-2.0" in metadata.splitlines(),
        "wheel_carries_license_file": hashlib.sha256(wheel_license).hexdigest()
        == APACHE_2_0_SHA256,
        "third_party_notices_present": (ROOT / "THIRD_PARTY_NOTICES.md").is_file(),
    }
    report["passed"] = all(report.values())
    return report


def _git_paths(*args: str) -> set[str]:
    completed = subprocess.run(["git", *args, "-z"], cwd=ROOT, capture_output=True, check=True)
    return {path for path in completed.stdout.decode().split("\0") if path}


def check_tracked_tree() -> dict:
    """What `git add -A && git commit` would publish: tracked, minus deleted, plus unignored."""
    try:
        published = (_git_paths("ls-files") - _git_paths("ls-files", "--deleted")) | _git_paths(
            "ls-files", "--others", "--exclude-standard"
        )
    except (OSError, subprocess.CalledProcessError):
        return {"skipped": "not a git checkout", "passed": True}
    offending = sorted(
        path
        for path in published
        if any(
            path == item or (item.endswith("/") and path.startswith(item)) for item in LOCAL_ONLY
        )
    )
    return {"local_only_paths_published": offending, "passed": not offending}


def wheel_contents(path: Path) -> dict[str, bytes]:
    """Every file except RECORD, whose entries only restate the others' hashes."""
    with zipfile.ZipFile(path) as wheel:
        return {n: wheel.read(n) for n in wheel.namelist() if not n.endswith(".dist-info/RECORD")}


def check_built_wheel(built: Path) -> dict:
    shipped, fresh = wheel_contents(WHEEL), wheel_contents(built)
    differing = sorted(n for n in set(shipped) | set(fresh) if shipped.get(n) != fresh.get(n))
    return {"built": built.name, "differing_files": differing, "passed": not differing}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--built-wheel", type=Path, help="a wheel freshly built from agentpkg/")
    args = parser.parse_args()
    report = {
        "packages": check_packages(),
        "dist_manifest": check_dist_manifest(),
        "license": check_license(),
        "tracked_tree": check_tracked_tree(),
    }
    if args.built_wheel:
        report["built_wheel"] = check_built_wheel(args.built_wheel)
    packages = report["packages"]
    report["passed"] = (
        all(packages[name]["passed"] for name in CURRENT_PACKAGES)
        and packages["package_origin_copy_identical"]
        and all(section["passed"] for key, section in report.items() if key != "packages")
    )
    print(json.dumps(report, indent=2))
    return 0 if report["passed"] else 1


if __name__ == "__main__":
    sys.exit(main())
