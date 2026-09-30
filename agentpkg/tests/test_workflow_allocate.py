"""Bounded apportionment has no application or authority-specific behavior."""

import copy

import pytest

from agentpkg.errors import ValidationError
from agentpkg.workflow_values import evaluate, references


def expression():
    return {
        "allocate": {
            "rows": {"from": "state", "path": "/records"},
            "total": {"from": "state", "path": "/capacity"},
            "field": "units",
        }
    }


def allocate(rows, total):
    return evaluate(expression(), {"state": {"records": rows, "capacity": total}})


def test_proportions_stable_ties_and_no_mutation():
    rows = [{"units": 2, "payload": {"a": 1}}, {"units": 2}, {"units": 2}]
    original = copy.deepcopy(rows)
    result = allocate(rows, 10)
    assert [r["units"] for r in result] == [4, 3, 3]
    result[0]["payload"]["a"] = 2
    assert rows == original
    assert allocate(rows, 6) == rows
    assert [r["units"] for r in allocate(rows, 3)] == [1, 1, 1]
    assert [r["units"] for r in allocate([{"units": 1}, {"units": 3}], 10)] == [3, 7]


@pytest.mark.parametrize(
    "rows,total",
    [
        ([], 10),
        ([{"units": 1}] * 257, 300),
        ([{"units": 1}] * 3, 2),
        ([{"units": 1}], True),
        ([{"units": 1}], 1.5),
        ([{"units": 1}], 2147483648),
        ([{"units": 0}], 10),
        ([{"units": -1}], 10),
        ([{"units": True}], 10),
        ([{"units": 1.5}], 10),
        ([{}], 10),
        ({}, 10),
    ],
)
def test_impossible_or_invalid_allocation_fails(rows, total):
    with pytest.raises(ValidationError):
        allocate(rows, total)


def test_exact_totals_positive_units_and_idempotence():
    for weights in ([1], [1, 1, 1], [1, 100, 3, 7], [2147483647, 1]):
        rows = [{"units": w} for w in weights]
        for total in range(len(rows), 241):
            result = allocate(rows, total)
            assert sum(r["units"] for r in result) == total
            assert all(r["units"] >= 1 for r in result)
            assert allocate(result, total) == result


def test_both_operands_participate_in_authority_checks():
    assert list(references(expression())) == [("state", "/records"), ("state", "/capacity")]


@pytest.mark.parametrize("operand", ["rows", "total"])
def test_nested_operands_cannot_read_unauthorized_state(tmp_path, operand):
    import json
    import shutil
    from pathlib import Path

    from agentpkg.package import load_package

    source = tmp_path / "renamed"
    shutil.copytree(Path(__file__).resolve().parents[2] / "agents/meeting-agenda", source)
    path = source / "graph.json"
    graph = json.loads(path.read_text())
    value = {
        "allocate": {
            "rows": {"literal": [{"units": 1}]},
            "total": {"literal": 25},
            "field": "units",
        }
    }
    value["allocate"][operand] = {"from": "state", "path": "/agenda"}
    graph["nodes"][0]["input"] = value
    path.write_text(json.dumps(graph))
    with pytest.raises(ValidationError, match="state_read"):
        load_package(source)


def test_integer_valued_json_numbers_match_schema_integer_semantics():
    assert allocate([{"units": 2.0}, {"units": 6.0}], 10.0) == [{"units": 3}, {"units": 7}]
    for value in [float("nan"), float("inf"), float("-inf")]:
        with pytest.raises(ValidationError):
            allocate([{"units": 1}], value)
        with pytest.raises(ValidationError):
            allocate([{"units": value}], 10)
