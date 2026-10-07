"""Vectors for the Chrome core's port of CPython's `sum()` over JSON numbers.

`agentpkg.workflow_assertions` checks a `sum` assertion with the builtin `sum()`, which on
CPython >= 3.12 adds floats with Neumaier's compensated summation and ints exactly; the
Chrome core reproduces that (`src/core/workflow/assertions.ts::pySum`, T4 review 1, finding 3).
JavaScript cannot tell a JSON `1.0` from a `1`, so the port reads every integral number within
the safe-integer range (|n| <= 2^53) as a Python int; a larger integral value is a float to it,
because a JavaScript double cannot add it exactly either. For each case this script records Python's result for the values as JavaScript
sees them (`expected`) and, when the case spells an integral value as a float, Python's result
for that spelling too (`expected_float_spelling`), so the one class of divergence is written
down beside its size instead of hidden. Written by the T4 session on 2026-10-07; run from the
repository root:

    agentpkg/.venv/bin/python chrome-agent-browser/scripts/make-py-sum-vectors.py
"""

from __future__ import annotations

import json
import math
import sys
from pathlib import Path

OUT = Path(__file__).resolve().parents[1] / "test" / "fixtures" / "py-sum-vectors.json"

if sys.version_info < (3, 12):
    sys.exit("CPython >= 3.12 is the reference (compensated float summation)")

CASES: list[tuple[str, list[int | float]]] = [
    ("empty", []),
    ("ints", [1, 2, 3]),
    ("negative ints", [5, -7, 2]),
    ("large ints", [2**53 - 10, 5, 5]),
    ("tenths", [0.1, 0.2, 0.3]),
    ("ten tenths", [0.1] * 10),
    ("cancellation", [1e16, 1.0, -1e16]),
    ("cancellation reversed", [1.0, 1e16, -1e16]),
    ("tiny after huge", [1e100, 1.0, -1e100, 1.0]),
    ("int then floats", [1, 0.1, 0.2]),
    ("float int float", [0.1, 1, 0.2]),
    ("floats then int", [0.1, 0.2, 1]),
    ("prices", [199.99, 349.5, 0.01, 1200.25]),
    ("many prices", [19.99] * 100 + [0.01] * 100),
    ("negative zero", [-0.0, -0.0]),
    ("negative result", [-0.3, 0.1, 0.1]),
    ("halves", [1.5, 2.5]),
    ("overflow to inf", [1e308, 1e308, -1e308]),
    ("mixed signs small", [0.3, -0.1, -0.1, -0.1]),
    ("integral floats", [100.0, 0.1, 0.1, 0.1]),
    ("integral floats cancel", [1e16, 1.0, -1e16, 0.1]),
    ("one value", [0.7]),
    ("alternating", [1e-16, 1.0, -1e-16, 1.0, 1e-16]),
]


SAFE = 2**53


def js_view(values: list[int | float]) -> list[int | float]:
    """What the port sees after JSON.parse: a safe integral number is an int, anything else a float."""
    out: list[int | float] = []
    for value in values:
        if isinstance(value, float) and value.is_integer() and abs(value) <= SAFE:
            out.append(int(value))
        elif isinstance(value, int) and abs(value) > SAFE:
            out.append(float(value))
        else:
            out.append(value)
    return out


def number(value: int | float) -> int | float | str:
    if isinstance(value, float) and not math.isfinite(value):
        return "inf" if value > 0 else "-inf" if value < 0 else "nan"
    return value


vectors = []
for name, values in CASES:
    as_js = js_view(values)
    expected = sum(as_js)
    entry: dict[str, object] = {"name": name, "values": [number(v) for v in values], "expected": number(expected)}
    if as_js != values or any(isinstance(a, float) != isinstance(b, float) for a, b in zip(as_js, values)):
        float_spelling = sum(values)
        entry["expected_float_spelling"] = number(float_spelling)
        entry["spellings_agree"] = float_spelling == expected and math.copysign(1, float_spelling) == math.copysign(1, expected)
    vectors.append(entry)

OUT.write_text(json.dumps({"python": sys.version.split()[0], "vectors": vectors}, indent=2) + "\n")
print(f"wrote {OUT.relative_to(Path.cwd()) if OUT.is_relative_to(Path.cwd()) else OUT} ({len(vectors)} vectors, CPython {sys.version.split()[0]})")
for entry in vectors:
    if "spellings_agree" in entry:
        print(f"  {entry['name']}: int spelling {entry['expected']!r}, float spelling {entry['expected_float_spelling']!r}, agree={entry['spellings_agree']}")
