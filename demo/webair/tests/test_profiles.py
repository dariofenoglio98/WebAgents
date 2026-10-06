"""WebAir's profiles (`org.webagents:profiles-v0`) present only what the package declares.

The manifest groups its declared permissions, tools and host resource types into three
profiles, "Search flights", "Search and quote" and "Book (simulated)", each one containing the
previous one. These tests pin that grouping, show that the publisher's validator
(`publisher/profiles.py`, run by `python -m publisher check`) catches each way a profile could
claim more or other than the package declares, and tie the estimates to the recorded runs of the
same graph (`examples/verification/webair-030-*.json`).
"""

import copy
import json

import pytest
from jsonschema import Draft202012Validator

from publisher import __main__ as publisher_cli
from publisher import profiles
from publisher.contract import REPO_ROOT
from publisher.fixture import package_from_files, source_files

EXTENSION = "org.webagents:profiles-v0"
PERSONAL = {"profile.travel", "identity.passenger", "wallet.payment"}
VERIFICATION = REPO_ROOT / "examples" / "verification"


@pytest.fixture(scope="module")
def package():
    return package_from_files(source_files())


@pytest.fixture
def declared(package):
    """The source's manifest, policy and tools, as mutable copies."""
    return (
        copy.deepcopy(package.manifest),
        copy.deepcopy(package.policy),
        copy.deepcopy(package.tools),
    )


def by_id(manifest):
    return {p["id"]: p for p in manifest["extensions"][EXTENSION]["profiles"]}


# --- the declared profiles --------------------------------------------------------------------


def test_the_schema_is_a_draft_2020_12_schema():
    Draft202012Validator.check_schema(json.loads(profiles.SCHEMA_PATH.read_text()))


def test_the_source_declares_three_valid_profiles(package):
    assert profiles.source_profile_problems() == []
    assert [p["id"] for p in package.manifest["extensions"][EXTENSION]["profiles"]] == [
        "search",
        "quote",
        "book",
    ]
    assert [p["title"] for p in package.manifest["extensions"][EXTENSION]["profiles"]] == [
        "Search flights",
        "Search and quote",
        "Book (simulated)",
    ]


def test_each_profile_contains_the_previous_one(package):
    search, quote, book = package.manifest["extensions"][EXTENSION]["profiles"]
    for smaller, larger in ((search, quote), (quote, book)):
        for field in profiles.MEMBERS:
            assert set(smaller[field]) <= set(larger[field]), (smaller["id"], field)
        assert smaller != larger


def test_search_reads_nothing_personal_and_changes_nothing(package):
    search = by_id(package.manifest)["search"]
    kinds = {p["id"]: p["kind"] for p in package.policy["permissions"]}
    assert {kinds[pid] for pid in search["permissions"]} == {"network", "model", "memory"}
    assert search["resources"] == []
    assert {package.tools[tid]["side_effects"] for tid in search["tools"]} == {"read"}
    assert not {package.tools[tid]["execution"] for tid in search["tools"]} - {"remote"}


def test_quote_adds_profile_and_identity_but_no_payment(package):
    quote = by_id(package.manifest)["quote"]
    assert PERSONAL & set(quote["permissions"]) == {"profile.travel", "identity.passenger"}
    assert "booking.simulate_purchase" not in quote["permissions"]
    assert "simulate-purchase" not in quote["tools"]
    assert "wallet.payment_method" not in quote["tools"]


def test_book_is_everything_the_package_declares(package):
    book = by_id(package.manifest)["book"]
    assert set(book["permissions"]) == {p["id"] for p in package.policy["permissions"]}
    assert set(book["tools"]) == set(package.tools)
    assert set(book["resources"]) == {
        r
        for p in package.policy["permissions"]
        if p["kind"] == "personal.read"
        for r in p["resources"]
    }


def test_a_package_without_profiles_has_nothing_to_check(declared):
    manifest, policy, tools = declared
    del manifest["extensions"][EXTENSION]
    assert profiles.profile_problems(manifest, policy, tools) == []


# --- each rule, broken once -------------------------------------------------------------------


def _edit(manifest, change):
    change(by_id(manifest), manifest["extensions"][EXTENSION]["profiles"])


BROKEN = {
    "undeclared permission": (
        lambda p, _: p["quote"]["permissions"].append("network.elsewhere"),
        "permission 'network.elsewhere' is not declared",
    ),
    "undeclared tool": (
        lambda p, _: p["book"]["tools"].append("get-flight"),
        "tool 'get-flight' is not declared",
    ),
    "undeclared resource type": (
        lambda p, _: p["book"]["resources"].append("personal.loyalty_card"),
        "resource 'personal.loyalty_card' is not a resource type",
    ),
    "required permission left out": (
        lambda p, _: p["search"]["permissions"].remove("memory.session"),
        "required permission 'memory.session' is missing",
    ),
    "tool without its permission": (
        lambda p, _: (
            p["quote"]["permissions"].remove("identity.passenger"),
            p["quote"]["resources"].remove("personal.passenger_identity"),
        ),
        "tool 'prepare-booking' needs permission 'identity.passenger'",
    ),
    "resource without its permission": (
        lambda p, _: p["quote"]["resources"].append("wallet.payment_method"),
        "resource 'wallet.payment_method' has no member permission requesting it",
    ),
    "permission without its resource": (
        lambda p, _: p["quote"]["resources"].remove("personal.travel_profile"),
        "resource 'personal.travel_profile' is requested by a member permission",
    ),
    "most authority first": (
        lambda _, ordered: ordered.reverse(),
        "profile 'book' is first but has permissions",
    ),
    "tokens above the hard budget": (
        lambda p, _: p["search"]["estimate"].update(tokens=120001),
        "estimate.tokens 120001 exceeds budget.hard_tokens 120000",
    ),
    "tool calls above the tools' budgets": (
        lambda p, _: p["search"]["estimate"].update(tool_calls=8),
        "estimate.tool_calls 8 exceeds the tools' call budgets (7)",
    ),
    "duplicate id": (
        lambda p, _: p["book"].update(id="quote"),
        "profile 'quote': duplicate id",
    ),
}


@pytest.mark.parametrize("case", sorted(BROKEN))
def test_every_rule_catches_its_violation(case, declared):
    manifest, policy, tools = declared
    change, message = BROKEN[case]
    _edit(manifest, change)
    problems = profiles.profile_problems(manifest, policy, tools)
    assert any(message in problem for problem in problems), problems


SCHEMA_BROKEN = {
    "unknown field": lambda p, _: p["search"].update(default=True),
    "a title on two lines": lambda p, _: p["search"].update(title="Search\nflights"),
    # Python's `$` matches before a final newline: an anchored pattern would let these through.
    "a title ending in a newline": lambda p, _: p["search"].update(title="Search flights\n"),
    "a description ending in a newline": lambda p, _: p["search"].update(
        description=p["search"]["description"] + "\n"
    ),
    "an id ending in a newline": lambda p, _: p["search"].update(id="search\n"),
    "a member ending in a newline": lambda p, _: p["search"]["tools"].append("search-flights\n"),
    "a line separator in a description": lambda p, _: p["search"].update(
        description="Search flights\u2028and compare fares"
    ),
    "a C1 control in the notes": lambda p, _: p["search"]["estimate"].update(notes="Two\u0085runs"),
    "a tab in a title": lambda p, _: p["search"].update(title="Search\tflights"),
    "an empty estimate": lambda p, _: p["search"].update(estimate={}),
    "a negative estimate": lambda p, _: p["search"]["estimate"].update(tokens=-1),
    "a repeated member": lambda p, _: p["search"]["tools"].append("search-flights"),
    "no profile": lambda _, ordered: ordered.clear(),
    "too long a description": lambda p, _: p["search"].update(description="x" * 241),
}


@pytest.mark.parametrize("case", sorted(SCHEMA_BROKEN))
def test_the_schema_rejects_malformed_values(case, declared):
    manifest, policy, tools = declared
    _edit(manifest, SCHEMA_BROKEN[case])
    problems = profiles.profile_problems(manifest, policy, tools)
    assert problems and all(problem.startswith("schema: ") for problem in problems), problems


def test_one_line_text_may_use_any_printable_character(declared):
    manifest, policy, tools = declared
    _edit(
        manifest,
        lambda p, _: p["search"].update(
            title="Zürich ↔ 東京", description="Fares — “économie” and 'premium', 0–2 stops."
        ),
    )
    assert profiles.profile_problems(manifest, policy, tools) == []


def test_publisher_check_fails_on_a_broken_profile(monkeypatch, capsys):
    files = source_files()
    manifest = json.loads(files["MANIFEST.agent"])
    by_id(manifest)["search"]["tools"].append("simulate-purchase")
    broken = {**files, "MANIFEST.agent": json.dumps(manifest).encode()}
    monkeypatch.setattr(publisher_cli, "drift", lambda files: [])
    monkeypatch.setattr(publisher_cli, "source_files", lambda: broken)
    assert publisher_cli.main(["check"]) == 1
    report = json.loads(capsys.readouterr().out)
    assert report["stale"] == []
    assert (
        "profile 'search': tool 'simulate-purchase' needs permission 'wallet.payment'"
        in (report["profile_problems"])
    )


# --- the estimates come from recorded runs of the same graph ----------------------------------


def recorded_runs() -> dict[str, list[dict]]:
    """Model calls, tool calls (all, and WebAir's own) and tokens of every recorded run.

    WebAir 0.3.0's live runs: the two Table I searches and the accepted walk-through (search,
    quote, simulated purchase). 0.4.0 adds only the profiles; its graph is 0.3.0's.
    """
    table = json.loads((VERIFICATION / "webair-030-table1-runs.json").read_text())
    live = json.loads((VERIFICATION / "webair-030-live-demo.json").read_text())
    runs: dict[str, list[dict]] = {"search": [], "quote": [], "purchase": []}
    for run in table["runs"].values():
        runs["search"].append(
            {
                "model_calls": run["model_calls"],
                "tool_calls": run["tool_calls_total"],
                "webair_calls": run["external_tool_calls"],
                "tokens": run["reported_tokens"],
            }
        )
    for task, kind in (("search", "search"), ("booking", "quote"), ("purchase", "purchase")):
        run = live["runs"][task]
        assert run["status"] == "completed"
        runs[kind].append(
            {
                "model_calls": run["model"]["calls"],
                "tool_calls": run["usage"]["tool_calls"],
                "webair_calls": len(run["observed_webair_requests"]),
                "tokens": run["usage"]["tokens"],
            }
        )
    return runs


def test_estimates_are_the_largest_recorded_run_each_profile_serves(package):
    """Model calls as recorded, tool calls at least as recorded, tokens rounded up to 1,000.

    "Search flights" reads no travel profile, so its tool calls are WebAir's alone; the other
    two count every tool call, host-resource reads included. "Book (simulated)" serves the
    quote and the separate purchase run; the quote run is the larger.
    """
    runs = recorded_runs()
    served = {
        "search": (runs["search"], "webair_calls"),
        "quote": (runs["search"] + runs["quote"], "tool_calls"),
        "book": (runs["search"] + runs["quote"] + runs["purchase"], "tool_calls"),
    }
    for profile_id, profile in by_id(package.manifest).items():
        records, tool_field = served[profile_id]
        estimate = profile["estimate"]
        assert estimate["model_calls"] == max(r["model_calls"] for r in records), profile_id
        assert estimate["tool_calls"] == max(r[tool_field] for r in records), profile_id
        tokens = max(r["tokens"] for r in records)
        assert tokens <= estimate["tokens"] < tokens + 1000, profile_id
        assert estimate["tokens"] % 1000 == 0
