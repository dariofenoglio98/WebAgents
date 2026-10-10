"""Offline signed-package acceptance for Literature Review 0.2.7 (T15): every found paper is named by
its identifier before a model sees it, screened, and listed in papers-found with its verdict; the
models answer verdicts and ids while the graph keeps the records; evidence stays verbatim.

With ``--chrome-cli`` the same fixture is also replayed by the Chrome runtime's CLI and its exports
are compared with agentpkg's byte for byte (CI covers that pairing in the conformance job)."""

from __future__ import annotations

import argparse
import asyncio
import json
import subprocess
import tempfile
from pathlib import Path

from agentpkg.artifacts import artifact_records
from agentpkg.fixtures import fixture_adapters
from agentpkg.package import load_package, sha256, write_new
from agentpkg.signing import verify_package
from agentpkg.workflow import run_workflow

ROOT = Path(__file__).resolve().parents[1]
ARCHIVE = ROOT / "dist/literature-review-0.2.7.agent.pkg"
KEY = ROOT / "examples/keys/literature-review-publisher.pub.pem"
EXPORTS = [
    "related-work.md",
    "papers-found.json",
    "bibliography.json",
    "evidence-table.json",
    "unresolved.json",
    "verification.json",
]
PRESERVED = {
    "dist/literature-review.agent.pkg": "1669f83fafac3434748fc19d38a8d3d2c3352da83cf1cbb84796ce313bd4f571",
    "dist/literature-review-0.2.5.agent.pkg": "1669f83fafac3434748fc19d38a8d3d2c3352da83cf1cbb84796ce313bd4f571",
    "dist/literature-review-0.2.6.agent.pkg": "685dcc97232d278eb2a5b777dcbc621573de5c48818a95d522e647c9267ee8f1",
}


def _identity(record):
    for key in ("doi", "arxiv_id", "url", "title"):
        if record.get(key) not in (None, ""):
            return record[key]
    return None


def _chrome_replay(archive: Path, key: Path, cli: Path, python_out: Path) -> dict:
    with tempfile.TemporaryDirectory() as scratch:
        out = Path(scratch).resolve() / "chrome"
        command = ["node", str(cli), "run", str(archive), "--trust-key", str(key)]
        command += [
            "--mode",
            "fixture",
            "--grants",
            str(ROOT / "examples/literature-review-grants.json"),
        ]
        for tool in ("scholarly-search", "citation-resolver", "paper-reader"):
            command += ["--approve-tool", tool]
        command += ["--out", str(out)]
        subprocess.run(command, check=True, capture_output=True)
        return {
            name: (out / name).read_bytes() == (python_out / name).read_bytes()
            for name in EXPORTS
        }


def verify(archive: Path = ARCHIVE, key: Path = KEY, chrome_cli: Path | None = None):
    package = load_package(archive)
    signature = verify_package(archive, key)
    router, handlers, value = fixture_adapters(package)
    result = asyncio.run(
        run_workflow(
            package,
            value,
            router=router,
            handlers=handlers,
            grants={p["id"]: "session" for p in package.policy["permissions"]},
            approved_tools=sorted(package.tools),
        )
    )
    state, output = result["state"], result["output"]
    found = state["found_papers"]
    ids = [paper["paper_id"] for paper in found]
    found_by_id = {paper["paper_id"]: paper for paper in found}
    listed = {row["paper_id"]: row for row in output["papers_found"]}
    screened = {
        batch["found"][0]["paper_id"]: batch["found"][0]
        for batch in state["screening_batches"]
    }
    included = {paper["paper_id"] for paper in state["included_papers"]}
    handle_doi = {
        job["handle"]: job["paper"]["paper_id"] for job in state["handle_jobs"]
    }
    evidence = {e["evidence_id"]: e for e in state["evidence_items"]}
    abstract = [e for e in evidence.values() if e["scope"] == "abstract"]
    full_text = [e for e in evidence.values() if e["scope"] == "full_text"]
    searched = sum(len(batch["papers"]) for batch in state["search_batches"])
    audit = result["audit"]
    checks = {
        "completed": result["status"] == "completed",
        "signature_valid": signature["valid"],
        "version_0_2_7": package.manifest["version"] == "0.2.7",
        "ids_are_the_identifiers": all(p["paper_id"] == _identity(p) for p in found),
        "ids_unique": len(set(ids)) == len(ids),
        "exact_duplicates_removed_before_any_model": searched > len(found)
        and any(
            e["action"] == "node.deduplicated" and e.get("node_id") == "join-search"
            for e in audit
        ),
        "normalize_asked_with_documents_and_kept_every_paper": "normalize"
        in router.calls
        and sorted(r["paper_id"] for r in state["candidate_refs"]) == sorted(ids),
        "every_found_paper_screened_and_listed_once": sorted(listed) == sorted(ids)
        and len(listed) == len(output["papers_found"]),
        "listed_records_are_the_found_records": all(
            all(
                row[k] == found_by_id[pid][k]
                for k in ("title", "year", "venue", "doi", "url")
            )
            for pid, row in listed.items()
        ),
        "listed_verdicts_are_the_screening_verdicts": all(
            row == screened[pid] for pid, row in listed.items()
        ),
        "included_means_include": included
        == {pid for pid, row in listed.items() if row["screening_status"] == "include"},
        # After selection the review names papers by handle (P1-P3); the handle jobs map them back.
        "chosen_papers_named_p1_to_p3_in_order": [
            j["handle"] for j in state["handle_jobs"]
        ]
        == [f"P{n}" for n in range(1, len(state["handle_jobs"]) + 1)]
        and [j["paper"]["paper_id"] for j in state["handle_jobs"]]
        == [pid for pid in state["selection_slots"] if pid],
        "cited_papers_were_included": {
            handle_doi[r["paper_id"]] for r in output["bibliography"]
        }
        <= included,
        "abstract_evidence_states_no_hash": bool(abstract)
        and all(e["provenance"]["source_sha256"] == "" for e in abstract),
        "full_text_evidence_keeps_its_hash": bool(full_text)
        and all(len(e["provenance"]["source_sha256"]) == 64 for e in full_text),
        "exact_evidence_table": bool(output["evidence_table"])
        and all(
            row == evidence[row["evidence_id"]] for row in output["evidence_table"]
        ),
        "strict_final_validation_completed": any(
            e["action"] == "node.completed" and e.get("node_id") == "validate-output"
            for e in audit
        ),
        "earlier_archives_preserved": all(
            sha256((ROOT / path).read_bytes()) == digest
            for path, digest in PRESERVED.items()
        ),
    }
    chrome = None
    if chrome_cli is not None:
        with tempfile.TemporaryDirectory() as scratch:
            out = Path(scratch).resolve() / "python"
            out.mkdir()
            for name in EXPORTS:
                data = output_file(result, package, name)
                (out / name).write_bytes(data)
            chrome = _chrome_replay(archive, key, chrome_cli, out)
        checks["chrome_replay_identical_exports"] = all(chrome.values())
    assert all(checks.values()), checks
    return {
        "passed": True,
        "package_id": package.manifest["package_id"],
        "version": package.manifest["version"],
        "package_digest": package.digest,
        "archive_sha256": sha256(archive.read_bytes()),
        "signer_fingerprint": signature["key_fingerprint"],
        "checks": checks,
        "search_records": searched,
        "found_papers": len(found),
        "verdicts": {
            status: sum(
                1 for row in output["papers_found"] if row["screening_status"] == status
            )
            for status in ("include", "maybe", "exclude")
        },
        "cited": len(output["bibliography"]),
        "evidence_items": len(evidence),
        "claims": len(output["claims"]),
        "model_tasks": router.calls,
        "usage": result["usage"],
        "chrome_replay": chrome
        if chrome is not None
        else "not requested (--chrome-cli); CI compares both runtimes in the conformance job",
        "scope": "offline fixture; does not establish live cross-provider acceptance",
    }


def output_file(result, package, name):
    """The export as the shared writer (agentpkg.artifacts) renders it for the CLI."""
    return dict(artifact_records(result, package))[name]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--report")
    parser.add_argument("--archive", type=Path, default=ARCHIVE)
    parser.add_argument("--trust-key", type=Path, default=KEY)
    parser.add_argument("--chrome-cli", type=Path)
    args = parser.parse_args()
    report = verify(args.archive, args.trust_key, args.chrome_cli)
    encoded = (json.dumps(report, indent=2) + "\n").encode()
    if args.report:
        write_new(args.report, encoded)
    print(encoded.decode(), end="")


if __name__ == "__main__":
    main()
