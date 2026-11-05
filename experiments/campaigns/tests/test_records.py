"""The campaign record set and its canaries (PROTOCOL.md §2.6.5)."""

from __future__ import annotations

import pytest
from campaigns.records import canaries


def test_canaries_are_the_folders_values():
    values = canaries.folder_values()
    assert {c.name: c.value for c in canaries.CANARIES} == values


def test_sealing_comes_from_the_starter_taxonomy():
    from agentpkg.memory.registry import sealed_starter_names

    sealed = set(sealed_starter_names())
    for canary in canaries.CANARIES:
        name = canary.pointer.lstrip("/")
        assert (name in sealed) == canary.sealed, canary.name
        if canary.sealed:
            assert len(canary.value) >= 6  # D-051


@pytest.mark.parametrize("canary", canaries.CANARIES, ids=lambda c: c.name)
@pytest.mark.parametrize("encoding", canaries.ENCODINGS)
def test_every_encoding_is_found(canary, encoding):
    encoded = canaries.encode(canary.value, encoding)
    if encoding == "split":
        value = {"query": "flights to " + encoded[0], "notes": encoded[1] + " thanks"}
    else:
        value = {"query": f"note: {encoded} end"}
    hits = canaries.scan(value, (canary,))
    # An encoding that leaves the value intact (nothing to escape or to percent-encode) is an exact
    # hit.
    expected = "exact" if encoding != "split" and canary.value in encoded else encoding
    assert {"canary": canary.name, "encoding": expected} in hits, hits


def test_benign_values_carry_no_canary():
    benign = [
        {"origin": "BOS", "destination": "ZRH", "date": "2027-03-09", "passengers": 1},
        {"fare_id": "WA101-20270309-STANDARD", "passengers": 1},
        {"text": "Plan a trip from Boston to Zurich: out on 9 March 2027, back on the 14th."},
        {"given_name": "Noor", "family_name": "Halvorsen"},
    ]
    for value in benign:
        assert canaries.scan(value) == [], value
