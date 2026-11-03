#!/usr/bin/env python3
"""Check the pre-registered evaluation protocol (`experiments/PROTOCOL.md`, T29).

    agentpkg/.venv/bin/python scripts/check_protocol.py [--protocol PATH] [--model PATH]

Prints JSON with `"passed"` and exits 1 on failure. Nothing here changes a file. The checks:

* every experiment section (`### E1` … `### E10`, `### EA`) exists exactly once and carries every
  required field (`**Question.**` … `**Defects.**`, the list in `REQUIRED_FIELDS`), in that order; a planned
  experiment (`### EL`) needs only `**Question.**` and `**Status.**` until an amendment registers it;
* every `P-n`, `DF-n` and `UC-n` cited is defined by the security and privacy model
  (`docs/security-and-privacy-model.md`, its `### P-n` / `#### DF-n` / `UC-n` headings); every `CB-n`
  is in 1…11; every numbered experiment id cited anywhere is one of E1…E10; a lettered id (EA, EL) is
  checked where experiments are named (the scope table's first column, the build map's cells and the
  section headings), so prose such as "EU" is never read as an experiment;
* the build map (§7) names, in its rows' first cells, every task T30…T39 and T64, and names every
  experiment, and every experiment's `**Built by.**` field names at least one task;
* the registration section (§9.1) and the amendments table (§9.2) exist;
* the protocol contains no forbidden phrase (D-332): the patterns and the whitespace- and
  markup-collapsing reader are imported from `check_security_model.py`, so the two checks cannot drift;
* the file's SHA-256 over its bytes is printed (the hash every campaign manifest records, D-348; the
  registration commit is tagged `protocol-v1` and recorded outside the file).

The tests in `agentpkg/tests/test_check_protocol.py` feed mutated copies to each check.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from check_security_model import FORBIDDEN, collapsed

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_PROTOCOL = ROOT / "experiments" / "PROTOCOL.md"
DEFAULT_MODEL = ROOT / "docs" / "security-and-privacy-model.md"

EXPERIMENTS = [f"E{n}" for n in range(1, 11)] + ["EA"]
# Planned experiments: a section may exist with `Question` and `Status` only; registered by amendment.
PLANNED_EXPERIMENTS = ["EL"]
PLANNED_FIELDS = ["Question", "Status"]
TASKS = [f"T{n}" for n in range(30, 40)] + ["T64"]
REQUIRED_FIELDS = [
    "Question",
    "Properties",
    "Claim",
    "Task set",
    "Arms",
    "Baselines",
    "Attack families",
    "Ladder",
    "Metrics",
    "Oracle",
    "Sample size and stopping",
    "Budget",
    "Built by",
    "Reported as",
    "Defects",
]
CB_RANGE = range(1, 12)

SECTION_RE = re.compile(r"^### (E\d+|E[A-Z]) · ", re.MULTILINE)
HEADING_RE = re.compile(r"^#{1,4} ", re.MULTILINE)
PROPERTY_DEF_RE = re.compile(r"^### (P-\d+) · ", re.MULTILINE)
DF_DEF_RE = re.compile(r"^#### (DF-\d+) · ", re.MULTILINE)
UC_DEF_RE = re.compile(r"\*\*(UC-\d+) ", re.MULTILINE)
CITATION_RE = re.compile(r"\b(P|DF|UC|CB)-(\d+)\b")
NUMBERED_EXPERIMENT_RE = re.compile(r"\bE(\d+)\b")
LETTERED_EXPERIMENT_RE = re.compile(r"\bE([A-Z])\b")
TASK_RE = re.compile(r"\bT(\d+)\b")


def read(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def defined_ids(model_text: str) -> dict[str, set[str]]:
    return {
        "P": set(PROPERTY_DEF_RE.findall(model_text)),
        "DF": set(DF_DEF_RE.findall(model_text)),
        "UC": set(UC_DEF_RE.findall(model_text)),
        "CB": {f"CB-{n}" for n in CB_RANGE},
    }


def experiment_sections(text: str) -> dict[str, str]:
    """Each `### E… ·` section's text up to the next heading of level ≤ 3."""
    sections: dict[str, str] = {}
    matches = list(SECTION_RE.finditer(text))
    for index, match in enumerate(matches):
        start = match.end()
        end = len(text)
        for later in HEADING_RE.finditer(text, start):
            level = len(later.group(0)) - 1
            if level <= 3:
                end = later.start()
                break
        key = match.group(1)
        if key in sections:
            sections[key] = None  # type: ignore[assignment]  # a duplicate: reported below
            continue
        sections[key] = text[start:end]
    return sections


def check(protocol_path: Path, model_path: Path) -> dict:
    problems: list[str] = []
    text = read(protocol_path)
    model_text = read(model_path)
    known = defined_ids(model_text)

    # 1. Sections and fields.
    sections = experiment_sections(text)
    for experiment in EXPERIMENTS:
        body = sections.get(experiment)
        if body is None and experiment in sections:
            problems.append(f"experiment section {experiment} appears more than once")
            continue
        if body is None:
            problems.append(f"experiment section {experiment} is missing")
            continue
        positions = []
        for field in REQUIRED_FIELDS:
            marker = f"**{field}.**"
            position = body.find(marker)
            if position < 0:
                problems.append(f"{experiment}: field {field!r} is missing")
            else:
                positions.append((position, field))
        ordered = [field for _, field in sorted(positions)]
        present = [field for field in REQUIRED_FIELDS if field in ordered]
        if ordered != present:
            problems.append(
                f"{experiment}: fields are out of order ({', '.join(ordered)})"
            )
        built_by = _field_text(body, "Built by")
        if built_by is not None and not TASK_RE.search(built_by):
            problems.append(f"{experiment}: 'Built by' names no task")
    for extra in sections:
        if extra in PLANNED_EXPERIMENTS:
            body = sections[extra]
            if body is None:
                problems.append(f"experiment section {extra} appears more than once")
                continue
            for field in PLANNED_FIELDS:
                if f"**{field}.**" not in body:
                    problems.append(f"{extra} (planned): field {field!r} is missing")
        elif extra not in EXPERIMENTS:
            problems.append(f"unknown experiment section {extra}")

    # 2. Citations.
    cited: dict[str, set[str]] = {"P": set(), "DF": set(), "UC": set(), "CB": set()}
    for kind, number in CITATION_RE.findall(text):
        cited[kind].add(f"{kind}-{number}")
    for kind, ids in cited.items():
        unknown = sorted(ids - known[kind], key=lambda s: int(s.split("-")[1]))
        if unknown:
            problems.append(f"undefined {kind} ids cited: {', '.join(unknown)}")
    cited_experiments = {f"E{n}" for n in NUMBERED_EXPERIMENT_RE.findall(text)}
    for cell in _experiment_naming_cells(text):
        cited_experiments |= {f"E{x}" for x in LETTERED_EXPERIMENT_RE.findall(cell)}
    for experiment in sorted(cited_experiments):
        if experiment not in EXPERIMENTS and experiment not in PLANNED_EXPERIMENTS:
            problems.append(f"unknown experiment id cited: {experiment}")

    # 3. The build map.
    build_map = _section(text, "## 7. ")
    if build_map is None:
        problems.append("the build map (§7) is missing")
    else:
        rows = [line for line in build_map.splitlines() if line.startswith("| T")]
        named_tasks = {
            f"T{n}" for row in rows for n in TASK_RE.findall(_first_cell(row))
        }
        for task in TASKS:
            if task not in named_tasks:
                problems.append(f"the build map does not name {task}")
        map_text = "\n".join(rows)
        for experiment in EXPERIMENTS:
            if not re.search(rf"\b{experiment}\b", map_text):
                problems.append(f"the build map does not name {experiment}")

    # 4. Registration and amendments.
    if _section(text, "### 9.1 Registration") is None:
        problems.append("the registration section (§9.1) is missing")
    amendments = _section(text, "### 9.2 Amendments")
    if amendments is None or "| Date |" not in amendments:
        problems.append("the amendments table (§9.2) is missing")

    # 5. Wording.
    flat, line_at = collapsed(text)
    for pattern in FORBIDDEN:
        for match in pattern.finditer(flat):
            problems.append(
                f"forbidden phrase present: {match.group(0).lower()!r}"
                f" (line {line_at(match.start())})"
            )

    return {
        "passed": not problems,
        "protocol": str(protocol_path.relative_to(ROOT))
        if protocol_path.is_relative_to(ROOT)
        else str(protocol_path),
        "sha256": hashlib.sha256(protocol_path.read_bytes()).hexdigest(),
        "experiments": len([e for e in EXPERIMENTS if sections.get(e)]),
        "fields_per_experiment": len(REQUIRED_FIELDS),
        "citations": {kind: len(ids) for kind, ids in cited.items()},
        "problems": problems,
    }


def _field_text(body: str, field: str) -> str | None:
    marker = f"**{field}.**"
    start = body.find(marker)
    if start < 0:
        return None
    rest = body[start + len(marker) :]
    match = re.search(r"\n\*\*[A-Z]", rest)
    return rest[: match.start()] if match else rest


def _first_cell(row: str) -> str:
    cells = row.split("|")
    return cells[1] if len(cells) > 1 else ""


def _experiment_naming_cells(text: str) -> list[str]:
    """Where experiments are named: section headings, the scope table's and the build map's cells."""
    cells = [m.group(0) for m in SECTION_RE.finditer(text)]
    scope = _section(text, "## 1. ") or ""
    cells += [
        _first_cell(line) for line in scope.splitlines() if line.startswith("| E")
    ]
    build_map = _section(text, "## 7. ") or ""
    cells += [line for line in build_map.splitlines() if line.startswith("| T")]
    return cells


def _section(text: str, heading_prefix: str) -> str | None:
    start = text.find(f"\n{heading_prefix}")
    if start < 0:
        return None
    level = len(heading_prefix) - len(heading_prefix.lstrip("#"))
    body_start = text.find("\n", start + 1)
    end = len(text)
    for later in HEADING_RE.finditer(text, body_start + 1):
        if len(later.group(0)) - 1 <= level:
            end = later.start()
            break
    return text[body_start:end]


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--protocol", type=Path, default=DEFAULT_PROTOCOL)
    parser.add_argument("--model", type=Path, default=DEFAULT_MODEL)
    args = parser.parse_args(argv)
    report = check(args.protocol.resolve(), args.model.resolve())
    print(json.dumps(report, indent=2))
    return 0 if report["passed"] else 1


if __name__ == "__main__":
    sys.exit(main())
