"""`lookup`: the one keyed-selection constructor, independent of any package.

A `relation` assertion can prove that a row matches exactly one keyed target;
`lookup` lets a graph *copy* from that one target instead of asking a model to
reproduce it. Same key equality, same exactly-one rule, and failure attribution
that names the package's pointers, never the data.
"""

import json

import pytest

from agentpkg.errors import ValidationError
from agentpkg.workflow_values import LookupFailure, evaluate, references

RECORDS = [
    {"id": "a", "record": {"title": "A", "optional": None, "authors": [{"name": "X"}]}},
    {"id": "b", "record": {"title": "B"}},
    {"id": 1, "record": {"title": "integer one"}},
]


def lookup(key_value, *, members=RECORDS, key="/id", path="/record"):
    return evaluate(
        {
            "lookup": {
                "in": {"from": "state", "path": "/records"},
                "key": key,
                "equals": {"literal": key_value},
                "path": path,
            }
        },
        {"state": {"records": members}},
    )


def test_selects_the_one_matching_member_exactly():
    assert lookup("a") == RECORDS[0]["record"]
    assert lookup("b", path="/record/title") == "B"
    assert lookup("a", path="") == RECORDS[0]


def test_returns_a_copy_not_an_alias():
    value = lookup("a")
    value["authors"].append({"name": "Y"})
    assert RECORDS[0]["record"]["authors"] == [{"name": "X"}]


def test_key_equality_is_exact_json_equality():
    # The same canonical equality a relation assertion uses: no coercion.
    assert lookup(1) == {"title": "integer one"}
    with pytest.raises(LookupFailure):
        lookup(True)
    with pytest.raises(LookupFailure):
        lookup("1")


@pytest.mark.parametrize(
    ("value", "members", "failure"),
    [
        ("missing", RECORDS, "no_match"),
        ("a", RECORDS + [{"id": "a", "record": {}}], "duplicate_key"),
        ("a", {"not": "an array"}, "not_array"),
    ],
)
def test_anything_but_exactly_one_match_fails_with_attribution(value, members, failure):
    with pytest.raises(LookupFailure) as caught:
        lookup(value, members=members)
    assert caught.value.failed_check == {
        "check": "lookup",
        "failure": failure,
        "key": "/id",
        "path": "/record",
    }
    assert "missing" not in str(caught.value)
    assert "missing" not in json.dumps(caught.value.failed_check)


def test_missing_pointers_fail_rather_than_default():
    with pytest.raises(ValidationError):
        lookup("a", key="/absent")
    with pytest.raises(ValidationError):
        lookup("a", path="/record/absent")


def test_references_cover_both_operands():
    expression = {
        "lookup": {
            "in": {"from": "state", "path": "/records"},
            "key": "/id",
            "equals": {"from": "item", "path": "/id"},
            "path": "",
        }
    }
    assert list(references(expression)) == [("state", "/records"), ("item", "/id")]
