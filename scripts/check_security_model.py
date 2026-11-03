"""Check the security and privacy model against the code, the conformance suite and the wording rule.

    agentpkg/.venv/bin/python scripts/check_security_model.py [--also PATH ...] [--quiet]

Reads `docs/security-and-privacy-model.md` and checks, offline and without importing the runtimes:

* every property section (`### P-n`) has the seven fields (statement, adversary, Python reference,
  Chrome core, conformance, experiment, residual) and the ids run P-1, P-2, … without a gap;
* every mechanism pointer (`path.py:symbol`, `path.ts:symbol`, or a bare path under the two
  runtimes, the shells, their tests or the scripts) names a file that exists and, when a symbol is
  given, a file in which that symbol occurs;
* every conformance case id exists in the kept conformance report the model cites
  (`conformance/results/<stamp>/report.json`), in the probes' case lists
  (`examples/*/cases/cases.json`) or in `conformance/run.mjs`: every backticked token of every
  property's Conformance field must be a known case id (bare ids included), an existing path or one
  of the few named non-case tokens, so a misspelt family or case fails; every `family/case` token
  elsewhere in the model with a known family must be known too; every spec-numbered case (memory
  N1…, compute, conversation and network N-1…, in any list the model writes with commas, semicolons,
  ranges or "and") is an id its specification's text holds; every rule id (M-n, C-n, V-n, R-n)
  occurs in its specification; every CB-n is one of CB-1…CB-11 (the consent-bypass list is in a
  private survey, so the bound is a constant here, as is E1…E10);
* every experiment id is one of E1…E10 or EA;
* every `P-n`, `DF-n` and `UC-n` cited from the specifications, `docs/threat-model.md`,
  `docs/README.md`, `README.md` and the model itself is in the set of ids the model defines (a
  removed id in the middle of a range is not citable);
* the front map of `docs/threat-model.md` ("The properties these notes implement") agrees with the
  `*Properties: …*` line under each of its sections, both ways, has no duplicate row, and names
  every property the model defines;
* the forbidden phrases ("protects against" in every inflection, "prevents all", "guarantees
  security") appear in none of the public documents, matched over text with whitespace collapsed
  and Markdown emphasis and code markers (`*`, `_`, `` ` ``) removed, so neither a line wrap nor
  `**protects** against` hides one, and no form of "prevent" appears in the model itself (D-319,
  D-332);
* a property whose experiment field is "none" is listed in the evidence matrix's gap section when
  that private file is present (it is not in CI).

Prints a JSON report with `"passed"` and exits 1 when a check fails. No network, no execution.
`agentpkg/tests/test_security_model_check.py` feeds mutated copies of the model to each check.
"""

from __future__ import annotations

import argparse
import bisect
import json
import re
import sys
from functools import cache
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MODEL = ROOT / "docs" / "security-and-privacy-model.md"
THREAT_MODEL = ROOT / "docs" / "threat-model.md"
EVIDENCE_MATRIX = ROOT / "private" / "documents" / "paper2" / "evidence-matrix.md"

PUBLIC_DOCUMENTS = [
    "docs/security-and-privacy-model.md",
    "docs/threat-model.md",
    "README.md",
    "docs/README.md",
]
# Matched over whitespace-collapsed text with emphasis and code markers removed: "protects
# against", "protect against", "protected against", "protecting against", "prevents all",
# "prevent all", "guarantees security".
MARKUP = re.compile(r"[*_`]")
FORBIDDEN = [
    re.compile(r"\bprotect(?:s|ed|ing)?\s+against\b", re.IGNORECASE),
    re.compile(r"\bprevents?\s+all\b", re.IGNORECASE),
    re.compile(r"\bguarantees?\s+security\b", re.IGNORECASE),
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
    "chrome-agent-browser/test",
    "openclaw-agent-browser/src",
    "openclaw-agent-browser/test",
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
BACKTICKED = re.compile(r"`([^`]+)`")
CASE_ID = re.compile(r"`([a-z][a-z0-9.-]*)/([a-z0-9][a-z0-9_.-]*)`")
# Tokens a Conformance field may name that are neither a case id nor a path.
NON_CASE_TOKENS = {"npm run check-pack", "once"}
SPEC_CASE = re.compile(
    r"\b(memory|compute|conversation|network)\s+(N-?\d+(?:\s*(?:,|;|…|and)\s*N-?\d+)*)"
)
SPEC_CASE_SPEC = {
    "memory": "spec/memory-v0.md",
    "compute": "spec/compute-v0.md",
    "conversation": "spec/conversation-v0.md",
    "network": "spec/network-v0.md",
}
SPEC_CASE_NUMBER = re.compile(r"\bN-?(\d+)\b")
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
DF_HEADING = re.compile(r"^#### DF-(\d+)\b", re.MULTILINE)
UC_HEADING = re.compile(r"^- \*\*UC-(\d+)\b", re.MULTILINE)
CITATION = re.compile(r"\b(P|DF|UC)-(\d+)\b")
REPORT_DIR = re.compile(r"conformance/results/([0-9A-Za-z-]+)/")
SECTION_HEADING = re.compile(r"^#{2,3} (.+?)\s*$")
PROPERTIES_LINE = re.compile(r"^\*Properties:(.*)\*\s*$")
MAP_ROW = re.compile(r"^\| (P-\d+)\b[^|]*\| ([^|]*)\|\s*$")


def read(path: Path) -> str:
    return path.read_text(encoding="utf-8")


@cache
def read_cached(path: str) -> str:
    return read(Path(path))


@cache
def spec_case_numbers(family: str) -> frozenset[int]:
    """The numbered negative cases (N1…, N-1…) the family's specification text holds."""
    text = read_cached(str(ROOT / SPEC_CASE_SPEC[family]))
    return frozenset(int(n) for n in SPEC_CASE_NUMBER.findall(text))


def properties(text: str) -> list[dict]:
    """Split the model into property sections with their fields."""
    found = []
    current = None
    for line in text.splitlines():
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


def known_case_ids(report_path: Path | None) -> tuple[set[str], set[str]]:
    """Case ids from the cited conformance report, the probes' case lists and run.mjs."""
    ids: set[str] = set()
    if report_path is not None and report_path.is_file():
        report = json.loads(read(report_path))
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
    families = {case.split("/", 1)[0] for case in ids if "/" in case}
    run = ROOT / "conformance" / "run.mjs"
    if run.exists():
        for literal in re.findall(
            r'"([a-z][a-z0-9.-]*/[a-z0-9][a-z0-9_.-]*)"', read(run)
        ):
            # A path literal in run.mjs ("conformance/results") is not a case id: only a literal
            # whose family the report or a case list knows is added.
            if literal.split("/", 1)[0] in families:
                ids.add(literal)
    return ids, families


def cited_report(text: str) -> tuple[Path | None, str | None]:
    """The report the model cites, or an error when it cites none or a missing one."""
    match = REPORT_DIR.search(text)
    if match is None:
        return None, "the model cites no conformance/results/<stamp>/ directory"
    path = ROOT / "conformance" / "results" / match.group(1) / "report.json"
    if not path.is_file():
        return None, f"the cited report {path.relative_to(ROOT)} does not exist"
    return path, None


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
            # `Class.method`: every component must occur in the file, so a renamed class fails.
            body = read(target)
            if any(
                not re.search(r"\b" + re.escape(name) + r"\b", body)
                for name in symbol.split(".")
            ):
                missing_symbols.append(f"{path}:{symbol}")
    report["pointers"] = {
        "count": len(seen),
        "missing_files": missing_files,
        "missing_symbols": missing_symbols,
        "passed": not missing_files and not missing_symbols,
    }


def check_case_ids(text: str, props: list[dict], report: dict) -> None:
    report_path, report_error = cited_report(text)
    ids, families = known_case_ids(report_path)
    unknown = []
    count = 0
    for family, case in CASE_ID.findall(text):
        if family not in families:
            continue
        count += 1
        if f"{family}/{case}" not in ids:
            unknown.append(f"{family}/{case}")
    # Every backticked token of a Conformance field, bare ids included.
    unknown_tokens = []
    token_count = 0
    for prop in props:
        for token in BACKTICKED.findall(prop["fields"].get("Conformance", "")):
            token_count += 1
            if token in ids or token in NON_CASE_TOKENS:
                continue
            if (ROOT / token).exists():
                continue
            unknown_tokens.append(f"{prop['id']}: {token}")
    out_of_range = []
    spec_count = 0
    for family, group in SPEC_CASE.findall(text):
        known_numbers = spec_case_numbers(family)
        for number in SPEC_CASE_NUMBER.findall(group):
            spec_count += 1
            if int(number) not in known_numbers:
                out_of_range.append(f"{family} N-{number}")
    rule_missing = []
    rule_count = 0
    for letter, number in RULE_ID.findall(text):
        rule_count += 1
        spec = read_cached(str(ROOT / RULE_SPEC[letter]))
        if not re.search(r"\b" + re.escape(f"{letter}-{number}") + r"\b", spec):
            rule_missing.append(f"{letter}-{number}")
    bad_cb = [f"CB-{n}" for n in CB_ID.findall(text) if not 1 <= int(n) <= 11]
    report["case_ids"] = {
        "report": str(report_path.relative_to(ROOT)) if report_path else report_error,
        "known": len(ids),
        "cited": count,
        "unknown": sorted(set(unknown)),
        "conformance_tokens": token_count,
        "unknown_tokens": unknown_tokens,
        "spec_numbered_cited": spec_count,
        "spec_numbered_out_of_range": sorted(set(out_of_range)),
        "rule_ids_cited": rule_count,
        "rule_ids_missing": sorted(set(rule_missing)),
        "consent_bypass_out_of_range": sorted(set(bad_cb)),
        "passed": report_error is None
        and not unknown
        and not unknown_tokens
        and not out_of_range
        and not rule_missing
        and not bad_cb,
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


def defined_ids(text: str, props: list[dict]) -> dict[str, set[int]]:
    """The sets of P-n, DF-n and UC-n the model defines."""
    return {
        "P": {p["number"] for p in props},
        "DF": {int(n) for n in DF_HEADING.findall(text)},
        "UC": {int(n) for n in UC_HEADING.findall(text)},
    }


def check_citations(
    model: Path, text: str, props: list[dict], documents: list[Path], report: dict
) -> None:
    """Every P-n, DF-n, UC-n cited from the model, the specs, the threat model and the READMEs."""
    defined = defined_ids(text, props)
    unknown = []
    cited = 0
    missing = []
    for path in [model] + documents:
        if not path.is_file():
            missing.append(str(path))
            continue
        body = read(path) if path != model else text
        label = str(path.relative_to(ROOT)) if path.is_relative_to(ROOT) else str(path)
        for kind, number in CITATION.findall(body):
            cited += 1
            if int(number) not in defined[kind]:
                unknown.append(f"{label}: {kind}-{number}")
    report["citations"] = {
        "defined": {kind: len(ids) for kind, ids in defined.items()},
        "documents": len(documents),
        "cited": cited,
        "missing_documents": missing,
        "unknown": sorted(set(unknown)),
        "passed": not unknown and not missing,
    }


def normalize_section(name: str) -> str:
    return re.sub(r"\s*\([^)]*\)\s*$", "", name).strip().lower()


def check_threat_model_map(path: Path, defined: set[str], report: dict) -> None:
    """The front map of the threat model against the per-section Properties lines, with no
    duplicate row and a row for every property the model defines."""
    if not path.is_file():
        report["threat_model_map"] = {"status": "missing", "passed": False}
        return
    lines = read(path).splitlines()
    mapped: dict[str, set[str]] = {}
    declared: dict[str, set[str]] = {}
    duplicates: list[str] = []
    heading = None
    for line in lines:
        row = MAP_ROW.match(line)
        if row:
            if row.group(1) in mapped:
                duplicates.append(row.group(1))
            mapped.setdefault(row.group(1), set()).update(
                normalize_section(s) for s in row.group(2).split(";") if s.strip()
            )
            continue
        head = SECTION_HEADING.match(line)
        if head:
            heading = normalize_section(head.group(1))
            continue
        props_line = PROPERTIES_LINE.match(line)
        if props_line and heading:
            for number in re.findall(r"\bP-(\d+)\b", props_line.group(1)):
                declared.setdefault(f"P-{number}", set()).add(heading)
    mismatches = []
    for prop in sorted(set(mapped) | set(declared), key=lambda p: int(p[2:])):
        only_map = sorted(mapped.get(prop, set()) - declared.get(prop, set()))
        only_sections = sorted(declared.get(prop, set()) - mapped.get(prop, set()))
        if only_map or only_sections:
            mismatches.append(
                {
                    "property": prop,
                    "only_in_map": only_map,
                    "only_in_sections": only_sections,
                }
            )
    unmapped = sorted(defined - set(mapped), key=lambda p: int(p[2:]))
    report["threat_model_map"] = {
        "status": "checked",
        "mapped": len(mapped),
        "sections_declaring": len({s for v in declared.values() for s in v}),
        "mismatches": mismatches,
        "duplicate_rows": sorted(set(duplicates), key=lambda p: int(p[2:])),
        "unmapped": unmapped,
        "passed": bool(mapped)
        and bool(declared)
        and not mismatches
        and not duplicates
        and not unmapped,
    }


def collapsed(text: str):
    """The text with every run of whitespace as one space and the Markdown emphasis and code
    markers removed from every word, and a function from an index in that text to the line of the
    original: one entry per word, not per character. A word that was only markers is dropped, so
    `**protects** against`, `protects *against*` and `` `protects` against `` all read "protects
    against"; a word only shrinks, so an index inside it stays on its line."""
    parts: list[str] = []
    starts: list[int] = []
    originals: list[int] = []
    position = 0
    for match in re.finditer(r"\S+", text):
        word = MARKUP.sub("", match.group(0))
        if not word:
            continue
        if parts:
            position += 1
        starts.append(position)
        originals.append(match.start())
        parts.append(word)
        position += len(word)
    newlines = [m.start() for m in re.finditer("\n", text)]

    def line_at(index: int) -> int:
        k = bisect.bisect_right(starts, index) - 1
        original = originals[k] + (index - starts[k]) if k >= 0 else 0
        return bisect.bisect_right(newlines, original) + 1

    return " ".join(parts), line_at


def check_wording(
    model: Path, model_text: str, documents: list[str], report: dict
) -> None:
    """The forbidden phrases in the model and the public documents; "prevent" in the model."""
    hits = []
    label = str(model.relative_to(ROOT)) if model.is_relative_to(ROOT) else str(model)
    sources = [(label, model_text)]
    for relative in documents:
        path = ROOT / relative if not Path(relative).is_absolute() else Path(relative)
        if not path.is_file():
            hits.append({"file": relative, "line": 0, "phrase": "(file missing)"})
            continue
        sources.append((relative, read(path)))
    for name, text in sources:
        flat, line_at = collapsed(text)
        for pattern in FORBIDDEN:
            for match in pattern.finditer(flat):
                hits.append(
                    {
                        "file": name,
                        "line": line_at(match.start()),
                        "phrase": match.group(0),
                    }
                )
    flat, line_at = collapsed(model_text)
    model_hits = [
        {"file": label, "line": line_at(m.start()), "phrase": m.group(0)}
        for m in MODEL_ONLY_FORBIDDEN.finditer(flat)
    ]
    report["wording"] = {
        "documents": len(sources),
        "forbidden": hits,
        "prevent_in_model": model_hits,
        "passed": not hits and not model_hits,
    }


def check_gap_list(none_experiment: list[str], matrix: Path, report: dict) -> None:
    if not matrix.is_file():
        report["evidence_matrix"] = {
            "status": "absent (private file; not checked)",
            "passed": True,
        }
        return
    text = read(matrix)
    match = re.search(
        r"^## [^\n]*\bgaps?\b[^\n]*$(.*?)(?=^## |\Z)",
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


def cited_documents() -> list[Path]:
    """The documents whose P-n, DF-n and UC-n citations and wording are checked."""
    return [
        ROOT / d for d in PUBLIC_DOCUMENTS if d != "docs/security-and-privacy-model.md"
    ] + sorted((ROOT / "spec").rglob("*.md"))


def run_checks(
    model: Path = MODEL,
    *,
    also: list[str] | None = None,
    documents: list[Path] | None = None,
    threat_model: Path = THREAT_MODEL,
    evidence_matrix: Path = EVIDENCE_MATRIX,
) -> dict:
    """Every check over one model document; the tests call this with mutated copies."""
    report: dict = {"model": str(model)}
    if not model.is_file():
        report["passed"] = False
        report["error"] = "model document missing"
        return report
    text = read(model)
    props = properties(text)
    none_experiment = check_properties(props, report)
    check_pointers(text, report)
    check_case_ids(text, props, report)
    check_experiments(text, report)
    docs = cited_documents() if documents is None else documents
    check_citations(model, text, props, docs, report)
    check_threat_model_map(threat_model, {p["id"] for p in props}, report)
    wording_documents = [
        str(d.relative_to(ROOT)) if d.is_relative_to(ROOT) else str(d) for d in docs
    ]
    check_wording(model, text, wording_documents + list(also or []), report)
    check_gap_list(none_experiment, evidence_matrix, report)
    report["passed"] = all(
        section.get("passed", False)
        for key, section in report.items()
        if isinstance(section, dict)
    )
    return report


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
    report = run_checks(also=args.also)
    report["model"] = str(MODEL.relative_to(ROOT))
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
