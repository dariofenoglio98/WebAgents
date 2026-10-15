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
import ast
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
# The current wheel, which CI rebuilds from agentpkg/ and compares file by file. The 0.2.2 wheel of
# the v0.2.0 release stays in dist/ for the paper line and is checked by the SHA-256 list only.
WHEEL = DIST / "agentpkg-0.4.0-py3-none-any.whl"
WHEEL_DIST_INFO = "agentpkg-0.4.0.dist-info"
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
    # T20: the current Literature Review, 0.2.8 (memory.v0, runtime minimum 0.4.0); 0.2.7, which
    # demo index 1.2.0 named, stays pinned below.
    "literature-review-0.2.8": {
        "stem": "literature-review",
        "alias": False,
        "package_id": "org.webagents.literature-review",
        "version": "0.2.8",
        "digest": "fb107c188d6995c5308e06b6ade751604455245c2413fce7a39c92841d4652b6",
        "archive_sha256": "0d03d1c8b366aabd6343b15958185c10cdab6639828f9c73bafbb26538db8330",
        "key": "examples/keys/literature-review-publisher.pub.pem",
        "fingerprint": "sha256:c5ca9763f9fc71253298ca381ec14c4d7432009c74dacc69df6344b71de05232",
        "tools": [
            "agent-notes.read",
            "agent-notes.write",
            "citation-resolver",
            "paper-reader",
            "research.profile",
            "scholarly-search",
        ],
    },
    # T15: Literature Review 0.2.7, by version. The unversioned alias above stays 0.2.5,
    # which the paper's experiments and the conformance reports describe; 0.2.6 (T10), which demo
    # index 1.1.0 names, stays pinned below.
    "literature-review-0.2.7": {
        "stem": "literature-review",
        "alias": False,
        "package_id": "org.webagents.literature-review",
        "version": "0.2.7",
        "digest": "9274a5ce46275e6817ae2706791c19a8066e523776cb9eb348a76b83396a99cb",
        "archive_sha256": "8951a14bb1f42bca1590bc7d0c9cc00cccba75b36f1488969b6b3ff47063fe61",
        "key": "examples/keys/literature-review-publisher.pub.pem",
        "fingerprint": "sha256:c5ca9763f9fc71253298ca381ec14c4d7432009c74dacc69df6344b71de05232",
        "tools": ["citation-resolver", "paper-reader", "scholarly-search"],
    },
    "literature-review-0.2.6": {
        "stem": "literature-review",
        "alias": False,
        "package_id": "org.webagents.literature-review",
        "version": "0.2.6",
        "digest": "09399b953afd487ee87dcf321a32ff1e735c8d862ac662ea2c4ee1f8ef1b6e4e",
        "archive_sha256": "685dcc97232d278eb2a5b777dcbc621573de5c48818a95d522e647c9267ee8f1",
        "key": "examples/keys/literature-review-publisher.pub.pem",
        "fingerprint": "sha256:c5ca9763f9fc71253298ca381ec14c4d7432009c74dacc69df6344b71de05232",
        "tools": ["citation-resolver", "paper-reader", "scholarly-search"],
    },
    # The fictional WebAir origin's packages (demo/webair), new in v0.2.0. The current one has no
    # unversioned alias: `webair.agent.pkg` stays 0.1.0, which the recorded evidence pins.
    # 0.6.0 is the current one (0.5.0 with the person's memory, T20); 0.5.0 (0.4.0 plus the
    # departure-airport answer, T9), which the public deployment serves until 0.6.0 is deployed,
    # stays pinned. 0.4.0, which the
    # Chrome live acceptance, the conformance reports and the demo index describe, and 0.3.0,
    # which the recorded live and Table I evidence and the contract overhead benchmark
    # describe, stay pinned.
    "webair-0.6.0": {
        "stem": "webair",
        "alias": False,
        "package_id": "org.webagents.webair",
        "version": "0.6.0",
        "digest": "e1ef5ad07f5be9148d5d7b5d6f6e88e3ba9cfdb291d8d2ba2fb9bc0f06d6022f",
        "archive_sha256": "3055dd93a9f4e5f81f3ccddac77ccc9ce2c10b1e10dec35d9864fddf6fb58862",
        "key": "examples/keys/webair-publisher.pub.pem",
        "fingerprint": "sha256:2e53accec575b37bf16c189e03cd3a6b2f2cfae2339ff05361bf585dc3d4a20b",
        "tools": [
            "get-fare-rules",
            "personal.passenger_identity",
            "prepare-booking",
            "search-flights",
            "simulate-purchase",
            "travel.profile",
            "wallet.payment_method",
        ],
    },
    "webair-0.5.0": {
        "stem": "webair",
        "alias": False,
        "package_id": "org.webagents.webair",
        "version": "0.5.0",
        "digest": "6192614e86ae4b18ba135f17120d4f616feac082c4ab09283221da7194c0bb48",
        "archive_sha256": "4b087557cbd2b0ff186391dfd00f9068739f9a727ab2fd916a6512da1fde101b",
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
    "webair-0.4.0": {
        "stem": "webair",
        "alias": False,
        "package_id": "org.webagents.webair",
        "version": "0.4.0",
        "digest": "0e8317f11e8813e7d5b4b3f352f20148d114329dca3db8c725c5b0558af24fbb",
        "archive_sha256": "c12f9db3bd7b3b4b6721c67e1d0b8143ebd94381df0e5e57c196357b7ca77f63",
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
    # T20 (D-232): the package the demo index 1.3.0 names, served at its indexed path too; 0.2.7
    # (index 1.2.0, T15, D-174) and 0.2.6 (index 1.1.0, T11, D-131) stay served.
    current = ROOT / "package-origin/packages/literature-review-0.2.8.agent.pkg"
    report["package_origin_current_copy_identical"] = (
        current.read_bytes() == (DIST / "literature-review-0.2.8.agent.pkg").read_bytes()
    )
    previous_027 = ROOT / "package-origin/packages/literature-review-0.2.7.agent.pkg"
    report["package_origin_0_2_7_copy_identical"] = (
        previous_027.read_bytes() == (DIST / "literature-review-0.2.7.agent.pkg").read_bytes()
    )
    previous = ROOT / "package-origin/packages/literature-review-0.2.6.agent.pkg"
    report["package_origin_0_2_6_copy_identical"] = (
        previous.read_bytes() == (DIST / "literature-review-0.2.6.agent.pkg").read_bytes()
    )
    # T8: the signed demo index and policy package-origin serves are the ones in examples/.
    documents = {
        "agent-index.json": "examples/agent-index.json",
        "policies/webagents-research.json": "examples/policies/webagents-research.json",
    }
    report["package_origin_documents_identical"] = all(
        (ROOT / "package-origin/documents" / name).read_bytes() == (ROOT / source).read_bytes()
        for name, source in documents.items()
    )
    # T9 (T8 review 1, nit 4): the SHA-256 pins server.py refuses to start without are the
    # documents' own, so a re-signed document fails here rather than at container start.
    pins = document_pins((ROOT / "package-origin/server.py").read_text(encoding="utf-8"))
    report["package_origin_document_pins"] = pin_mismatches(pins, documents)
    return report


def document_pins(source: str) -> dict[str, str]:
    """The `DOCUMENTS` pins of package-origin/server.py, read without importing it: path → SHA-256."""
    for node in ast.parse(source).body:
        if isinstance(node, ast.Assign) and any(isinstance(t, ast.Name) and t.id == "DOCUMENTS" for t in node.targets):
            if not isinstance(node.value, ast.Dict):
                raise ValueError("server.py DOCUMENTS must be a dict literal")
            pins = {}
            for key, value in zip(node.value.keys, node.value.values):
                if not (isinstance(key, ast.Constant) and isinstance(value, ast.Tuple) and len(value.elts) == 2):
                    raise ValueError("server.py DOCUMENTS entries must be 'path': (source, sha256)")
                digest = value.elts[1]
                if not (isinstance(digest, ast.Constant) and isinstance(digest.value, str)):
                    raise ValueError("server.py DOCUMENTS pins must be string literals")
                pins[key.value] = digest.value
            return pins
    raise ValueError("server.py defines no DOCUMENTS dict")


def pin_mismatches(pins: dict[str, str], documents: dict[str, str]) -> dict:
    """Each served path's pin against the SHA-256 of the document in examples/ it serves."""
    expected = {
        f"/{name}": hashlib.sha256((ROOT / source).read_bytes()).hexdigest()
        for name, source in documents.items()
    }
    mismatched = sorted(
        path for path in set(pins) | set(expected) if pins.get(path) != expected.get(path)
    )
    return {"pins": pins, "mismatched": mismatched, "passed": not mismatched}


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
        metadata = wheel.read(f"{WHEEL_DIST_INFO}/METADATA").decode()
        wheel_license = (
            wheel.read(f"{WHEEL_DIST_INFO}/licenses/LICENSE")
            if (f"{WHEEL_DIST_INFO}/licenses/LICENSE" in names)
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
        and packages["package_origin_current_copy_identical"]
        and packages["package_origin_0_2_6_copy_identical"]
        and packages["package_origin_documents_identical"]
        and packages["package_origin_document_pins"]["passed"]
        and all(section["passed"] for key, section in report.items() if key != "packages")
    )
    print(json.dumps(report, indent=2))
    return 0 if report["passed"] else 1


if __name__ == "__main__":
    sys.exit(main())
