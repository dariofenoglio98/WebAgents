"""Check the security and privacy model against the code, the conformance suite and the wording rule.

    agentpkg/.venv/bin/python scripts/check_security_model.py [--also PATH ...] [--quiet]

Reads `docs/security-and-privacy-model.md` and checks, offline and without importing the runtimes:

* every property section (`### P-n`) has the seven fields (statement, adversary, Python reference,
  Chrome core, conformance, experiment, residual) and the ids run P-1, P-2, … without a gap;
* every mechanism pointer (`path.py:symbol`, `path.ts:symbol`, or a bare path under the two
  runtimes, the shells, the tests or the scripts) names a file that exists and, when a symbol is
  given, a file in which that symbol occurs;
* every conformance case id (`family/case`) exists in the latest kept conformance report, in the
  probes' case lists (`examples/*/cases/cases.json`) or in `conformance/run.mjs`; every spec-numbered
  case (memory N1…N22, compute N-1…N-27, conversation N-1…N-43, network N-1…N-46) is in range;
  every rule id (M-n, C-n, V-n, R-n) occurs in its specification; every CB-n is one of CB-1…CB-11;
* every experiment id is one of E1…E10 or EA;
* the forbidden phrases ("protects against", "protect against", "prevents all", "guarantees
  security") appear in none of the public documents, and no form of "prevent" appears in the model
  itself (D-319, D-332);
* a property whose experiment field is "none" is listed in the evidence matrix's gap section when
  that private file is present (it is not in CI).

Prints a JSON report with `"passed"` and exits 1 when a check fails. No network, no execution.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MODEL = ROOT / "docs" / "security-and-privacy-model.md"
EVIDENCE_MATRIX = ROOT / "private" / "documents" / "paper2" / "evidence-matrix.md"

PUBLIC_DOCUMENTS = [
    "docs/security-and-privacy-model.md",
    "docs/threat-model.md",
    "README.md",
    "docs/README.md",
]
FORBIDDEN_PHRASES = [
    "protects against",
    "protect against",
    "prevents all",
    "guarantees security",
]
MODEL_ONLY_FORBIDDEN = re.compile(r"\bprevent", re.IGNORECASE)

FIELDS = [
    "Statement",
    "Adversary",
    "Python reference",
    "Chrome core",
    "Conformance",
    "Experiment",
    "Residual",
]

POINTER_ROOTS = (
    "agentpkg/src/agentpkg",
    "agentpkg/tests",
    "chrome-agent-browser/src",
    "chrome-agent-browser/scripts",
    "openclaw-agent-browser/src",
    "conformance",
    "experiments",
    "scripts",
)
POINTER = re.compile(
    r"`((?:"
    + "|".join(re.escape(r) for r in POINTER_ROOTS)
    + r")/[\w./@-]+\.(?:py|ts|mjs|json))"
    r"(?::([A-Za-z_][\w.]*))?`"
)
CASE_ID = re.compile(r"`([a-z][a-z0-9.-]*)/([a-z0-9][a-z0-9_.-]*)`")
SPEC_CASE = re.compile(
    r"\b(memory|compute|conversation|network)\s+(N-?\d+(?:\s*(?:,|…|and)\s*N-?\d+)*)"
)
SPEC_CASE_RANGES = {
    "memory": (1, 22),
    "compute": (1, 27),
    "conversation": (1, 43),
    "network": (1, 46),
}
RULE_ID = re.compile(r"\b([MCVR])-(\d+)\b")
RULE_SPEC = {
    "M": "spec/memory-v0.md",
    "C": "spec/compute-v0.md",
    "V": "spec/conversation-v0.md",
    "R": "spec/network-v0.md",
}
CB_ID = re.compile(r"\bCB-(\d+)\b")
EXPERIMENT = re.compile(r"\bE(\d{1,2})\b")
PROPERTY_HEADING = re.compile(r"^### (P-(\d+))\b")


def read(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def properties(text: str) -> list[dict]:
    """Split the model into property sections with their fields."""
    found = []
    lines = text.splitlines()
    current = None
    for line in lines:
        match = PROPERTY_HEADING.match(line)
        if match:
            current = {"id": match.group(1), "number": int(match.group(2)), "body": []}
            found.append(current)
            continue
        if line.startswith("## ") and current is not None:
            current = None
            continue
        if current is not None:
            current["body"].append(line)
    for prop in found:
        body = "\n".join(prop["body"])
        prop["fields"] = {}
        for field in FIELDS:
            match = re.search(
                r"\*\*" + re.escape(field) + r"\.\*\*\s*(.*?)(?:\n\s*\n|\Z)",
                body,
                re.DOTALL,
            )
            if match:
                prop["fields"][field] = " ".join(match.group(1).split())
        del prop["body"]
    return found


def known_case_ids() -> tuple[set[str], set[str]]:
    """Case ids from the latest conformance report, the probes' case lists and run.mjs."""
    ids: set[str] = set()
    results = sorted((ROOT / "conformance" / "results").glob("*/report.json"))
    if results:
        report = json.loads(read(results[-1]))
        for case in report.get("cases", []):
            if isinstance(case, dict) and isinstance(case.get("id"), str):
                ids.add(case["id"])
    for family in ("compute", "network", "conversation"):
        cases = ROOT / "examples" / family / "cases" / "cases.json"
        if cases.exists():
            document = json.loads(read(cases))
            items = (
                document.get("cases", document)
                if isinstance(document, dict)
                else document
            )
            if isinstance(items, dict):
                items = list(items.values())
            for case in items:
                if isinstance(case, dict) and isinstance(case.get("id"), str):
                    ids.add(f"{family}/{case['id']}")
    run = ROOT / "conformance" / "run.mjs"
    if run.exists():
        for literal in re.findall(
            r'"([a-z][a-z0-9.-]*/[a-z0-9][a-z0-9_.-]*)"', read(run)
        ):
            ids.add(literal)
    families = {case.split("/", 1)[0] for case in ids}
    return ids, families


def check_pointers(text: str, report: dict) -> None:
    seen = {}
    for path, symbol in POINTER.findall(text):
        seen.setdefault((path, symbol), 0)
        seen[(path, symbol)] += 1
    missing_files, missing_symbols = [], []
    for path, symbol in sorted(seen):
        target = ROOT / path
        if not target.is_file():
            missing_files.append(path)
            continue
        if symbol:
            name = symbol.rsplit(".", 1)[-1]
            if not re.search(r"\b" + re.escape(name) + r"\b", read(target)):
                missing_symbols.append(f"{path}:{symbol}")
    report["pointers"] = {
        "count": len(seen),
        "missing_files": missing_files,
        "missing_symbols": missing_symbols,
        "passed": not missing_files and not missing_symbols,
    }


def check_case_ids(text: str, report: dict) -> None:
    ids, families = known_case_ids()
    unknown = []
    count = 0
    for family, case in CASE_ID.findall(text):
        if family not in families:
            continue
        count += 1
        if f"{family}/{case}" not in ids:
            unknown.append(f"{family}/{case}")
    out_of_range = []
    spec_count = 0
    for family, group in SPEC_CASE.findall(text):
        low, high = SPEC_CASE_RANGES[family]
        for number in re.findall(r"N-?(\d+)", group):
            spec_count += 1
            if not low <= int(number) <= high:
                out_of_range.append(f"{family} N-{number}")
    rule_missing = []
    rule_count = 0
    for letter, number in RULE_ID.findall(text):
        rule_count += 1
        spec = read(ROOT / RULE_SPEC[letter])
        if not re.search(r"\b" + re.escape(f"{letter}-{number}") + r"\b", spec):
            rule_missing.append(f"{letter}-{number}")
    bad_cb = [f"CB-{n}" for n in CB_ID.findall(text) if not 1 <= int(n) <= 11]
    report["case_ids"] = {
        "known": len(ids),
        "cited": count,
        "unknown": sorted(set(unknown)),
        "spec_numbered_cited": spec_count,
        "spec_numbered_out_of_range": sorted(set(out_of_range)),
        "rule_ids_cited": rule_count,
        "rule_ids_missing": sorted(set(rule_missing)),
        "consent_bypass_out_of_range": sorted(set(bad_cb)),
        "passed": not unknown and not out_of_range and not rule_missing and not bad_cb,
    }


def check_experiments(text: str, report: dict) -> None:
    bad = sorted({f"E{n}" for n in EXPERIMENT.findall(text) if not 1 <= int(n) <= 10})
    report["experiments"] = {
        "cited": len(EXPERIMENT.findall(text)) + text.count(" EA"),
        "unknown": bad,
        "passed": not bad,
    }


def check_properties(props: list[dict], report: dict) -> list[str]:
    numbers = [p["number"] for p in props]
    gaps = [
        f"P-{n}"
        for n in range(1, (max(numbers) if numbers else 0) + 1)
        if n not in numbers
    ]
    duplicates = sorted({f"P-{n}" for n in numbers if numbers.count(n) > 1})
    incomplete = {
        p["id"]: [f for f in FIELDS if f not in p["fields"]]
        for p in props
        if len(p["fields"]) < len(FIELDS)
    }
    none_experiment = [
        p["id"]
        for p in props
        if p["fields"].get("Experiment", "").lower().startswith("none")
    ]
    report["properties"] = {
        "count": len(props),
        "gaps": gaps,
        "duplicates": duplicates,
        "incomplete": incomplete,
        "experiment_none": none_experiment,
        "passed": bool(props) and not gaps and not duplicates and not incomplete,
    }
    return none_experiment


def check_wording(extra: list[str], report: dict) -> None:
    hits = []
    for relative in (
        PUBLIC_DOCUMENTS
        + sorted(str(p.relative_to(ROOT)) for p in (ROOT / "spec").rglob("*.md"))
        + extra
    ):
        path = ROOT / relative if not Path(relative).is_absolute() else Path(relative)
        if not path.is_file():
            hits.append({"file": relative, "line": 0, "phrase": "(file missing)"})
            continue
        for number, line in enumerate(read(path).splitlines(), 1):
            lowered = line.lower()
            for phrase in FORBIDDEN_PHRASES:
                if phrase in lowered:
                    hits.append({"file": relative, "line": number, "phrase": phrase})
    model_hits = [
        {"file": "docs/security-and-privacy-model.md", "line": n, "phrase": m.group(0)}
        for n, line in enumerate(read(MODEL).splitlines(), 1)
        for m in [MODEL_ONLY_FORBIDDEN.search(line)]
        if m
    ]
    report["wording"] = {
        "forbidden": hits,
        "prevent_in_model": model_hits,
        "passed": not hits and not model_hits,
    }


def check_gap_list(none_experiment: list[str], report: dict) -> None:
    if not EVIDENCE_MATRIX.is_file():
        report["evidence_matrix"] = {
            "status": "absent (private file; not checked)",
            "passed": True,
        }
        return
    text = read(EVIDENCE_MATRIX)
    match = re.search(
        r"^## .*\bgaps?\b.*$(.*?)(?=^## |\Z)",
        text,
        re.MULTILINE | re.DOTALL | re.IGNORECASE,
    )
    gaps_section = match.group(1) if match else ""
    missing = [
        p
        for p in none_experiment
        if not re.search(r"\b" + re.escape(p) + r"\b", gaps_section)
    ]
    report["evidence_matrix"] = {
        "status": "checked",
        "missing_from_gap_list": missing,
        "passed": not missing,
    }


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument(
        "--also",
        action="append",
        default=[],
        help="another document to check for the forbidden phrases",
    )
    parser.add_argument(
        "--quiet", action="store_true", help="print only the passed flag"
    )
    args = parser.parse_args(argv)

    report: dict = {"model": str(MODEL.relative_to(ROOT))}
    if not MODEL.is_file():
        report["passed"] = False
        report["error"] = "model document missing"
        print(json.dumps(report, indent=2))
        return 1
    text = read(MODEL)
    props = properties(text)
    none_experiment = check_properties(props, report)
    check_pointers(text, report)
    check_case_ids(text, report)
    check_experiments(text, report)
    check_wording(args.also, report)
    check_gap_list(none_experiment, report)
    report["passed"] = all(
        section.get("passed", False)
        for key, section in report.items()
        if isinstance(section, dict)
    )
    print(
        json.dumps(
            {"passed": report["passed"]} if args.quiet else report,
            indent=2,
            sort_keys=True,
        )
    )
    return 0 if report["passed"] else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
