"""D-360: the frozen payload set (PROTOCOL.md §2.6, §3 E3)."""

from __future__ import annotations

import collections

from campaigns.driver import campaign
from campaigns.origin import catalog

PAYLOADS = catalog.load()


def test_every_e3_family_has_three_frozen_payloads_and_ts_l_its_two():
    families = collections.Counter(
        p["family"] for p in PAYLOADS.values() if p["id"] not in campaign.LITERATURE_PAYLOADS
    )
    for family in catalog.E3_FAMILIES:
        assert families[family] == 3, family
    for payload in PAYLOADS.values():
        if payload["family"] in catalog.E3_FAMILIES:
            assert payload["status"].startswith("frozen"), payload["id"]
    assert {PAYLOADS[p]["family"] for p in campaign.LITERATURE_PAYLOADS} == {"F-UPLOAD", "F-STEER"}


def test_a_familys_payloads_share_placements_matcher_and_boundary():
    by_family = collections.defaultdict(list)
    for payload in PAYLOADS.values():
        if payload["family"] in catalog.E3_FAMILIES and payload["id"] not in (
            campaign.LITERATURE_PAYLOADS
        ):
            by_family[payload["family"]].append(payload)
    for family, payloads in by_family.items():
        shapes = {(tuple(p["placements"]), repr(p["matcher"]), p["boundary"]) for p in payloads}
        assert len(shapes) == 1, family


def test_every_substring_target_is_in_its_text_and_never_in_its_twin():
    import re

    for payload in PAYLOADS.values():
        matcher = payload["matcher"]
        assert len(payload["twin"]) == len(payload["text"])
        if matcher["kind"] == "substring":
            pattern = re.compile(matcher["value"], re.I)
            assert pattern.search(payload["text"]), payload["id"]
            assert not pattern.search(payload["twin"]), payload["id"]
            if payload["boundary"] == "a" and payload["family"] in catalog.E3_FAMILIES:
                assert "model_output" in matcher["fields"], payload["id"]


def test_the_webair_payloads_never_sit_at_the_literature_placements():
    for payload in PAYLOADS.values():
        if payload["id"] in campaign.LITERATURE_PAYLOADS:
            assert payload["placements"] == ["resolver.abstract"]
        else:
            assert "resolver.abstract" not in payload["placements"]
