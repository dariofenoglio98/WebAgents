"""Proposals (§7.2): the checks a runtime runs on the `memory.proposal` export on completion
(M-40), in order, before the run is reported complete and before the file is written.

Steps 1 and 7 run once over the whole document; steps 2 to 6 run proposal by proposal in index
order, so two runtimes report the same refusal for a document with two refusable proposals (N19).
Acceptance (M-42) is the host's review after the run; the Python CLI writes `proposals.json` and
never applies it.
"""

from __future__ import annotations

import copy

from jsonschema import Draft202012Validator

from ..package import canonical_json
from .model import RESERVED_TYPES, SELF_ID, body_link_ids, pointer_get
from .registry import contract
from .scan import INCOMPLETE, find_sealed

PROPOSALS_SCHEMA = "memory.v0 proposals"
PROPOSALS_EXPORT_FORMAT = "memory.proposal"
PROPOSALS_PATH = "proposals.json"


class ProposalRefusal(Exception):
    """A refusal with the code and reason M-40 names, and the proposal index when one applies."""

    def __init__(self, code: str, reason: str | None, message: str, index: int | None = None):
        self.code = code
        self.reason = reason
        self.index = index
        super().__init__(message)


def sealed_free_schema(type_def: dict, extra=()) -> dict:
    """M-40 step 4: the type schema with the sealed pointers removed from `required`."""
    schema = copy.deepcopy(type_def["schema"])
    top = {
        pointer.split("/")[1]
        for pointer in (*type_def["sealed_fields"], *extra)
        if len(pointer.split("/")) == 2
    }
    if isinstance(schema.get("required"), list):
        schema["required"] = [name for name in schema["required"] if name not in top]
    return schema


def _first_failure(schema: dict, instance):
    errors = sorted(
        Draft202012Validator(schema).iter_errors(instance),
        key=lambda error: tuple(str(part) for part in error.absolute_path),
    )
    return errors[0] if errors else None


def check_proposals(document, *, declared, granted: dict, targets: dict, types, scan) -> dict:
    """M-40 in order; raises `ProposalRefusal` on the first hit; returns the document.

    `declared`: the `memory.write` permission's resources resolved to type ids; `granted`: record
    id -> type id of every record this run was granted (M-12); `targets`: the granted records by
    id (`{sealed, type}`), for an update's own `sealed` additions (step 3); `types`: a
    `TypeRegistry`; `scan`: the run's scan set (M-36).
    """
    failure = _first_failure(contract("memory-proposals.schema.json"), document)
    if failure is not None:
        where = "/".join(str(part) for part in failure.absolute_path) or "<root>"
        raise ProposalRefusal(
            "schema_validation",
            None,
            f"proposals.json does not match memory-proposals.schema.json: {where}: "
            f"{failure.validator}",
        )
    proposals = document["proposals"]
    for index, proposal in enumerate(proposals):
        where = f"proposal {index}"
        if proposal["type"] not in declared or proposal["type"] in RESERVED_TYPES:
            raise ProposalRefusal(
                "permission_denied",
                "memory_proposal_type_undeclared",
                f"{where}: type {proposal['type']} is not one the package may propose",
                index,
            )
        type_def = types.get(proposal["type"])
        if type_def is None:
            raise ProposalRefusal(
                "permission_denied",
                "memory_proposal_type_undeclared",
                f"{where}: type {proposal['type']} is unknown to this host",
                index,
            )
        target_id = proposal.get("target", "")
        target = targets.get(target_id)
        target_granted = granted.get(target_id) == proposal["type"]
        extra = tuple(target.get("sealed") or []) if target is not None and target_granted else ()
        for pointer in (*type_def["sealed_fields"], *extra):
            if pointer_get(proposal["fields"], pointer) is not None:
                raise ProposalRefusal(
                    "schema_validation",
                    "memory_proposal_sealed_field",
                    f"{where}: carries the sealed field {pointer}",
                    index,
                )
        failure = _first_failure(sealed_free_schema(type_def, extra), proposal["fields"])
        if failure is not None:
            at = "/".join(str(part) for part in failure.absolute_path) or "<root>"
            raise ProposalRefusal(
                "schema_validation",
                None,
                f"{where}: the fields do not match the {type_def['display_name']} schema at {at} "
                f"(rule: {failure.validator})",
                index,
            )
        if proposal["action"] == "update" and granted.get(proposal["target"]) != proposal["type"]:
            raise ProposalRefusal(
                "permission_denied",
                "memory_proposal_target_not_granted",
                f"{where}: target {proposal['target']} is not a granted record of type "
                f"{proposal['type']}",
                index,
            )
        body_links = [
            {"to": to, "rel": "related"} for to in body_link_ids(proposal.get("body", ""))
        ]
        for link in [*proposal.get("links", []), *body_links]:
            to = link["to"]
            if to.startswith("#"):
                sibling = int(to[1:])
                if sibling == index or sibling >= len(proposals):
                    raise ProposalRefusal(
                        "schema_validation",
                        None,
                        f"{where}: link {to} names no other proposal",
                        index,
                    )
            elif to != SELF_ID and to not in granted:
                raise ProposalRefusal(
                    "permission_denied",
                    "memory_proposal_link_not_granted",
                    f"{where}: links to {to}, which this run was not granted",
                    index,
                )
    hit = find_sealed(document, scan)
    if hit == INCOMPLETE:
        raise ProposalRefusal(
            "permission_denied",
            "sealed_value_in_proposal",
            "proposals.json holds more strings than the scan reads, so it is refused unread",
        )
    if hit is not None:
        raise ProposalRefusal(
            "permission_denied",
            "sealed_value_in_proposal",
            f"proposals.json carries a sealed value of {hit['record_id']} at {hit['pointer']}",
        )
    return document


def proposed_facts(document: dict, *, write_denied: bool, policy_refuses: bool = False) -> dict:
    """`memory.proposed` (M-61) and the report's `memory.proposals` summary."""
    import hashlib

    count = len(document["proposals"])
    types = sorted({proposal["type"] for proposal in document["proposals"]})
    reason = "permission_denied" if write_denied else ("policy" if policy_refuses else None)
    return {
        "count": count,
        "types": types,
        "proposals_sha256": hashlib.sha256(canonical_json(document)).hexdigest(),
        "offered": count if reason is None else 0,
        "reason": reason,
    }
