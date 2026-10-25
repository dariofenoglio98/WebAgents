#!/usr/bin/env python3
"""Regenerate `test/fixtures/summary-*.json`: the Python control plane's `build_summary` of three
shipped packages, with an empty trust store, as `test/core/summary.test.ts` compares the
TypeScript summary against them. Run from the repository root with the agentpkg venv:

    agentpkg/.venv/bin/python chrome-agent-browser/scripts/make-summary-fixtures.py

Re-run after a change to the summary in agentpkg (a new section, a new warning), then re-run the
Chrome suite: a summary field the Python side gained must be ported, not filtered out.
"""

from __future__ import annotations

import json
import tempfile
from pathlib import Path

from agentpkg.browser.evaluation import evaluate_snapshot, signature_report
from agentpkg.browser.summary import build_summary
from agentpkg.browser.trust import TrustStore

ROOT = Path(__file__).resolve().parents[2]
FIXTURES = ROOT / "chrome-agent-browser" / "test" / "fixtures"
PACKAGES = {
    "summary-webair-0.3.0.json": "dist/webair-0.3.0.agent.pkg",
    "summary-literature-review-0.2.5.json": "dist/literature-review-0.2.5.agent.pkg",
    "summary-meeting-agenda-0.2.2.json": "dist/meeting-agenda-0.2.2.agent.pkg",
    # network.v0 (T26): `workflow.network` and the `delegation_network` sentence.
    "summary-network-test-0.1.0.json": "examples/network/network-test.agent.pkg",
}


def main() -> None:
    with tempfile.TemporaryDirectory() as scratch:
        trust = TrustStore(Path(scratch) / "trust.json")
        for name, archive in PACKAGES.items():
            evaluation = evaluate_snapshot(ROOT / archive)
            package = evaluation.package
            signature = signature_report(package)
            verdict = trust.evaluate(
                signer_fingerprint=(
                    signature["signer_fingerprint"] if signature["signature_status"] == "valid" else None
                ),
                claimed_publisher_id=package.manifest["publisher"]["id"],
                package_id=package.manifest["package_id"],
            )
            publisher = {
                "claimed_id": package.manifest["publisher"]["id"],
                "claimed_name": package.manifest["publisher"]["name"],
                **signature,
                **verdict,
            }
            summary = build_summary(package, evaluation=evaluation.as_json(), publisher=publisher)
            (FIXTURES / name).write_text(json.dumps(summary, indent=2, ensure_ascii=False) + "\n")
            print(name, "written")


if __name__ == "__main__":
    main()
