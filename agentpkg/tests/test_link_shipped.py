"""The shipped Agent Links archives (T65, D-695): each is its source built and signed by its own
publisher's key; the planner pins the two it links by digest and key; the acceptance walk runs
on the shipped archives and its record verifies; the demo index 1.7.0 names the four."""

import hashlib
import importlib.util
import json
from pathlib import Path

import pytest

from agentpkg.cli import main
from agentpkg.fixtures import fixture_adapters
from agentpkg.links.operator import operator_links
from agentpkg.links.resolve import LinkRefusal
from agentpkg.package import build_package, load_package
from agentpkg.signing import _read_key, fingerprint, verify_package

ROOT = Path(__file__).resolve().parents[2]
DIST, KEYS, LINK = ROOT / "dist", ROOT / "examples" / "keys", ROOT / "examples" / "link"
#: archive stem → the public half of its publisher's key.
SHIPPED = {
    "travel-planner": "travel-planner",
    "webair-flights": "webair",
    "staymere-hotels": "staymere",
    "hotel-salitubam": "hotel-salitubam",
}
LINKS = {"webair-flights": "webair-flights", "hotel-aggregator": "staymere-hotels"}


def archive(stem):
    return DIST / f"{stem}-0.1.0.agent.pkg"


def key(stem):
    return KEYS / f"{SHIPPED[stem]}-publisher.pub.pem"


@pytest.mark.parametrize("stem", sorted(SHIPPED))
def test_a_shipped_archive_is_its_source_signed_by_its_publisher(stem, tmp_path):
    shipped = load_package(archive(stem))
    rebuilt = load_package(build_package(ROOT / "agents" / stem, tmp_path / f"{stem}.agent.pkg"))
    assert shipped.digest == rebuilt.digest
    verified = verify_package(archive(stem), trusted_key=key(stem))
    assert verified["valid"] and verified["key_fingerprint"] == fingerprint(_read_key(key(stem)))
    assert shipped.manifest["runtime"]["minimum_version"] == "0.8.0"


def test_four_publishers_four_keys():
    prints = {stem: fingerprint(_read_key(key(stem))) for stem in SHIPPED}
    assert len(set(prints.values())) == 4
    # WebAir Flights is WebAir's: the key that signs WebAir itself.
    assert verify_package(DIST / "webair-0.8.0.agent.pkg", trusted_key=key("webair-flights"))


def test_the_planner_pins_the_shipped_archives():
    planner = load_package(archive("travel-planner"))
    records = {r["id"]: r for r in planner.manifest["dependencies"]}
    assert set(records) == set(LINKS)
    for dependency, stem in LINKS.items():
        linked = load_package(archive(stem))
        assert records[dependency]["digest"] == linked.digest
        assert records[dependency]["signer"] == fingerprint(_read_key(key(stem)))
        assert records[dependency]["package_id"] == linked.manifest["package_id"]


def acceptance(out, *, trust=True):
    argv = ["run", str(archive("travel-planner")), "--mode", "fixture"]
    argv += ["--grants", str(LINK / "travel-planner-grants.json")]
    for dependency, stem in LINKS.items():
        argv += ["--link", f"{dependency}={archive(stem)}"]
        argv += ["--link-grants", f"{dependency}={LINK / f'{stem}-grants.json'}"]
    argv += ["--approve-tool", "check-calendar"]
    argv += ["--approve-tool", "webair-flights:search-flights"]
    argv += ["--approve-tool", "hotel-aggregator:search-hotels"]
    if trust:
        for stem in ("travel-planner", "webair-flights", "staymere-hotels"):
            argv += ["--trust-key", str(key(stem))]
    return argv + ["--out", str(out)]


def test_the_acceptance_walk_runs_on_the_shipped_archives_and_verifies(tmp_path, capsys):
    out = tmp_path / "planner"
    assert main(acceptance(out)) == 0, capsys.readouterr().err
    assert json.loads(capsys.readouterr().out)["passed"] is True
    audit = json.loads((out / "audit.json").read_text())
    links = json.loads((out / "links.json").read_text())
    started = [e for e in audit if e["action"] == "link.started"]
    completed = [e for e in audit if e["action"] == "link.completed"]
    assert [e["dependency"] for e in started] == ["webair-flights", "hotel-aggregator"]
    assert [e["inner_run_id"] for e in completed] == [e["inner_run_id"] for e in started]
    # The inner records exist beside the caller's, and each publisher was trusted by its key.
    for event in started:
        assert (out / f"link-{event['inner_run_id']}.audit.json").is_file()
    assert {link["dependency"]: link["trust"] for link in links["links"]} == {
        "hotel-aggregator": "trusted",
        "webair-flights": "trusted",
    }
    spec = importlib.util.spec_from_file_location(
        "verify_link_run", ROOT / "scripts" / "verify_link_run.py"
    )
    verifier = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(verifier)
    # No package is named: the verifier finds the pinned archives in dist/ by their digests.
    result = verifier.verify(out)
    assert result["passed"], result["checks"]
    assert result["observed"]["model_calls"] == result["at_most"]["model_calls"] == 10
    assert result["observed"]["tool_calls"] == result["at_most"]["tool_calls"]
    assert (result["at_most"]["remote_calls"], result["at_most"]["tokens"]) == (23, 92000)


def test_inspect_names_both_linked_packages_in_the_composed_envelope(capsys):
    argv = ["inspect", str(archive("travel-planner"))]
    for dependency, stem in LINKS.items():
        argv += ["--link", f"{dependency}={archive(stem)}"]
    assert main(argv) == 0
    listing = json.loads(capsys.readouterr().out)
    resolved = {d["id"]: d["resolved"] for d in listing["links"]["dependencies"]}
    assert resolved["webair-flights"]["name"] == "WebAir Flights"
    assert resolved["hotel-aggregator"]["name"] == "Staymere"
    assert listing["links"]["worst_case"]["model_calls"] == 10
    assert listing["network"]["worst_case"]["tool_calls"] == {
        "check-calendar": 1,
        "hotel-aggregator:search-hotels": 1,
        "webair-flights:search-flights": 1,
    }


def test_a_host_that_requires_trust_refuses_an_unpinned_linked_publisher():
    planner = load_package(archive("travel-planner"))
    router = fixture_adapters(planner)[0]
    arguments = dict(
        archives={dependency: archive(stem) for dependency, stem in LINKS.items()},
        decisions={dependency: {"decision": "accepted"} for dependency in LINKS},
        router=router,
        adapters=lambda linked: fixture_adapters(linked)[:2],
        require_trusted=True,
    )
    with pytest.raises(LinkRefusal, match="^link_publisher_untrusted: "):
        operator_links(planner, trusted=set(), **arguments)
    links = operator_links(
        planner,
        trusted={fingerprint(_read_key(key(stem))) for stem in LINKS.values()},
        **arguments,
    )
    assert {b.link.trust for b in links.bindings.values()} == {"trusted"}


def test_another_archive_under_a_dependencys_name_is_refused(tmp_path, capsys):
    swapped = [
        value.replace(str(archive("staymere-hotels")), str(archive("hotel-salitubam")))
        for value in acceptance(tmp_path / "out")
    ]
    assert main(swapped) == 2
    assert capsys.readouterr().err.startswith("agentpkg: link_identity_mismatch: ")


def test_the_signed_index_1_7_0_names_the_four_archives():
    """Index 1.7.0 is signed and kept beside the current one: the Chrome tree pins the current
    index and its tests' clock, so T66 makes 1.7.0 current when it moves those (D-699)."""
    examples = ROOT / "examples"
    index = json.loads((examples / "agent-index-1.7.0.json").read_text(encoding="utf-8"))
    assert index["content"] == json.loads((examples / "agent-index-1.7.0.content.json").read_text())
    content = index["content"]
    assert content["version"] == "1.7.0"
    entries = {entry["package_id"]: entry for entry in content["entries"]}
    for stem in SHIPPED:
        package = load_package(archive(stem))
        entry = entries[package.manifest["package_id"]]
        assert entry["digest"] == package.digest
        assert entry["archive_sha256"] == hashlib.sha256(archive(stem).read_bytes()).hexdigest()
        assert entry["signer_fingerprint"] == fingerprint(_read_key(key(stem)))
        assert entry["package_url"].startswith("https://")
    current = json.loads((examples / "agent-index.json").read_text(encoding="utf-8"))
    assert current["content"]["version"] == "1.6.0"
