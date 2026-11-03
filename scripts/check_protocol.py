#!/usr/bin/env python3
"""Check the pre-registered evaluation protocol (`experiments/PROTOCOL.md`, T29).

    agentpkg/.venv/bin/python scripts/check_protocol.py [--protocol PATH] [--model PATH]

Prints JSON with `"passed"` and exits 1 on failure. Nothing here changes a file. The checks:

* every experiment section (`### E1` … `### E10`, `### EA`) exists exactly once and carries every
  required field (`**Question.**` … `**Defects.**`, the list in `REQUIRED_FIELDS`), in that order; a planned
  experiment (`### EL`) needs only `**Question.**` and `**Status.**` until an amendment registers it;
* every `P-n`, `DF-n` and `UC-n` cited is defined by the security and privacy model
  (`docs/security-and-privacy-model.md`, read by `check_security_model.py`'s own `properties` and
  `defined_ids`); a range such as `P-12…P-17` cites every id between its endpoints; every `CB-n`
  is in 1…11; every numbered experiment id cited anywhere is one of E1…E10; a lettered id (EA, EL) is
  checked where experiments are named (the scope table's first column, the build map's cells and the
  section headings), so prose such as "EU" is never read as an experiment;
* the scope table (§1) has a *Built by* column and a row naming at least one builder for every experiment;
* the build map (§7) names, in its rows' first cells, every task T30…T39 and T64 (a row whose first cell
  names no task is reported, not skipped), and names every experiment in a row of one of its builders;
  every experiment's `**Built by.**` field names only known tasks, at least one of them a builder from §1;
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
from check_security_model import FORBIDDEN, collapsed, properties, read
from check_security_model import defined_ids as model_defined_ids

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
CITATION_RE = re.compile(r"\b(P|DF|UC|CB)-(\d+)\b")
# A range such as `P-12…P-17` or `CB-1…CB-11` cites every id between its endpoints.
CITATION_RANGE_RE = re.compile(r"\b(P|DF|UC|CB)-(\d+)\s*(?:…|\.\.\.)\s*(?:\1-)?(\d+)\b")
NUMBERED_EXPERIMENT_RE = re.compile(r"\bE(\d+)\b")
LETTERED_EXPERIMENT_RE = re.compile(r"\bE([A-Z])\b")
TASK_RE = re.compile(r"\bT(\d+)\b")


def defined_ids(model_text: str) -> dict[str, set[str]]:
    """The P-n, DF-n and UC-n the model defines, by `check_security_model.py`'s own reading of its
    headings (so the two checks cannot drift), and the consent-bypass items CB-1…CB-11."""
    numbers = model_defined_ids(model_text, properties(model_text))
    known = {kind: {f"{kind}-{n}" for n in ids} for kind, ids in numbers.items()}
    known["CB"] = {f"CB-{n}" for n in CB_RANGE}
    return known


def cited_ids(text: str) -> dict[str, set[str]]:
    """Every P/DF/UC/CB id the text cites, a range counting every id between its endpoints."""
    cited: dict[str, set[str]] = {"P": set(), "DF": set(), "UC": set(), "CB": set()}
    for kind, number in CITATION_RE.findall(text):
        cited[kind].add(f"{kind}-{number}")
    for kind, first, last in CITATION_RANGE_RE.findall(text):
        for number in range(int(first), int(last) + 1):
            cited[kind].add(f"{kind}-{number}")
    return cited


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

    builders = _builders(text)
    if builders is None:
        problems.append("the scope table (§1) has no 'Built by' column")
        builders = {}
    for experiment in EXPERIMENTS + PLANNED_EXPERIMENTS:
        if not builders.get(experiment):
            problems.append(f"the scope table (§1) names no builder for {experiment}")

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
        if built_by is not None:
            named = {f"T{n}" for n in TASK_RE.findall(built_by)}
            if not named:
                problems.append(f"{experiment}: 'Built by' names no task")
            else:
                unknown_tasks = sorted(named - set(TASKS))
                if unknown_tasks:
                    problems.append(
                        f"{experiment}: 'Built by' names unknown tasks: {', '.join(unknown_tasks)}"
                    )
                own = builders.get(experiment)
                if own and not named & own:
                    problems.append(
                        f"{experiment}: 'Built by' names none of its builders in the scope table "
                        f"({', '.join(sorted(own))})"
                    )
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
    cited = cited_ids(text)
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
        rows = _build_map_rows(build_map)
        for row in rows:
            if not TASK_RE.search(_first_cell(row)):
                problems.append(
                    f"a build map row names no task in its first cell: {_first_cell(row)!r}"
                )
        named_tasks = {
            f"T{n}" for row in rows for n in TASK_RE.findall(_first_cell(row))
        }
        for task in TASKS:
            if task not in named_tasks:
                problems.append(f"the build map does not name {task}")
        for experiment in EXPERIMENTS:
            # Only a row's Task and Builds cells name an experiment; its From cell cites sections.
            naming = [
                row
                for row in rows
                if re.search(rf"\b{experiment}\b", " ".join(_cells(row)[:2]))
            ]
            if not naming:
                problems.append(f"the build map does not name {experiment}")
                continue
            named_by = {
                f"T{n}" for row in naming for n in TASK_RE.findall(_first_cell(row))
            }
            own = builders.get(experiment, set())
            if own and not own & named_by:
                problems.append(
                    f"the build map names {experiment} only outside its builders' rows "
                    f"({', '.join(sorted(own))}, from the scope table)"
                )

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


def _cells(row: str) -> list[str]:
    return [cell.strip() for cell in row.strip().strip("|").split("|")]


def _first_cell(row: str) -> str:
    cells = _cells(row)
    return cells[0] if cells else ""


def _table_rows(section: str) -> list[str]:
    """A section's table rows without the header and the separator row."""
    rows = [line for line in section.splitlines() if line.startswith("|")]
    return [row for row in rows[1:] if not re.fullmatch(r"\|[\s:|-]*", row.strip())]


def _build_map_rows(build_map: str) -> list[str]:
    return _table_rows(build_map)


def _builders(text: str) -> dict[str, set[str]] | None:
    """Experiment → the tasks its scope-table row (§1) names under *Built by*.

    None when the scope table or its *Built by* column is missing (the caller reports it).
    """
    scope = _section(text, "## 1. ") or ""
    rows = [line for line in scope.splitlines() if line.startswith("|")]
    if not rows:
        return None
    header = _cells(rows[0])
    if "Built by" not in header:
        return None
    column = header.index("Built by")
    builders: dict[str, set[str]] = {}
    for row in rows[1:]:
        cells = _cells(row)
        match = re.match(r"(E\d+|E[A-Z])\b", cells[0]) if cells else None
        if match and len(cells) > column:
            builders[match.group(1)] = {f"T{n}" for n in TASK_RE.findall(cells[column])}
    return builders


def _experiment_naming_cells(text: str) -> list[str]:
    """Where experiments are named: section headings, the scope table's and the build map's cells."""
    cells = [m.group(0) for m in SECTION_RE.finditer(text)]
    scope = _section(text, "## 1. ") or ""
    cells += [
        _first_cell(line) for line in scope.splitlines() if line.startswith("| E")
    ]
    build_map = _section(text, "## 7. ") or ""
    cells += _build_map_rows(build_map)
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
