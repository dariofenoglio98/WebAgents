"""The payload catalog (PROTOCOL.md §2.6, D-351): one JSON file per payload under
`payloads/<family>/`.

Each file states the payload's source with its item id, the adaptation, the placements it may take,
the text and a benign twin of exactly the same length (§2.6.1), the attempt matcher (§2.4.3) and the
boundary it targets. T31 commits drafts; T32 freezes the texts and hashes them in its manifest
before its first run (D-360). `catalog_digest` is the hash a manifest records.
"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path

from origin.injection import PLACEMENTS

PAYLOADS = Path(__file__).resolve().parent / "payloads"
FAMILIES = (
    "F-UPLOAD",
    "F-FIELD",
    "F-ACTION",
    "F-STEER",
    "F-REDIRECT",
    "F-WIDEN",
    "F-TERMINATE",
    "F-PEER",
    "F-MEMORY",
    "F-CONSENT",
)
E3_FAMILIES = tuple(f for f in FAMILIES if f not in ("F-TERMINATE", "F-PEER"))
# Placements the driver applies to the run's record set instead of an origin answer.
RECORD_PLACEMENTS = {"record.profile_body"}
MATCHER_KINDS = {"substring", "canary", "tool_call", "selected_family", "route_repeat"}
BOUNDARIES = {"a", "b", "c", "d", "e", None}
REQUIRED = (
    "id",
    "family",
    "boundary",
    "goal_class",
    "source",
    "adaptation",
    "placements",
    "text",
    "twin",
    "matcher",
    "status",
)


class CatalogError(ValueError):
    pass


def check_payload(payload: dict, path: Path) -> None:
    missing = [key for key in REQUIRED if key not in payload]
    if missing:
        raise CatalogError(f"{path}: missing {missing}")
    if payload["family"] not in FAMILIES or path.parent.name != payload["family"]:
        raise CatalogError(f"{path}: family {payload['family']!r} is not its directory's")
    if path.stem != payload["id"]:
        raise CatalogError(f"{path}: id {payload['id']!r} is not the file's name")
    if payload["boundary"] not in BOUNDARIES:
        raise CatalogError(f"{path}: unknown boundary {payload['boundary']!r}")
    if len(payload["twin"]) != len(payload["text"]):
        raise CatalogError(f"{path}: the twin is not the text's length")
    if not payload["source"] or not all(
        isinstance(s, dict) and s.get("ref") for s in payload["source"]
    ):
        raise CatalogError(f"{path}: every source names its reference")
    unknown = [
        p for p in payload["placements"] if p not in PLACEMENTS and p not in RECORD_PLACEMENTS
    ]
    if not payload["placements"] or unknown:
        raise CatalogError(f"{path}: unknown placements {unknown}")
    if payload["matcher"].get("kind") not in MATCHER_KINDS:
        raise CatalogError(f"{path}: unknown matcher {payload['matcher']!r}")


def load(directory: Path = PAYLOADS) -> dict[str, dict]:
    payloads: dict[str, dict] = {}
    for path in sorted(directory.glob("*/*.json")):
        payload = json.loads(path.read_text())
        check_payload(payload, path)
        if payload["id"] in payloads:
            raise CatalogError(f"{path}: duplicate id {payload['id']}")
        payloads[payload["id"]] = payload
    return payloads


def catalog_digest(directory: Path = PAYLOADS) -> dict:
    files = {
        path.relative_to(directory).as_posix(): hashlib.sha256(path.read_bytes()).hexdigest()
        for path in sorted(directory.glob("*/*.json"))
    }
    whole = hashlib.sha256(json.dumps(files, sort_keys=True).encode()).hexdigest()
    return {"sha256": whole, "files": files}


def fixture_key(payload_id: str, placement: str, arm: str) -> str:
    """The `X-Campaign-Fixture` value the drivers send (origin/injection.py's format)."""
    return f"{payload_id}@{placement}#{arm}"
