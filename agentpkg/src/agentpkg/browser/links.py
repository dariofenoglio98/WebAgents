"""Agent Links in the control plane (link.v0 §3): each dependency of an opened package is
fetched, snapshotted and evaluated as a package session of its own, so that the person decides
on each linked publisher through the ordinary authorization, with its own receipt and its own
inner Run Plan; the caller's plan then records the links and is hash-bound over them.

Everything here is preparation. No package runs: the control plane fetches, verifies, records
decisions and prepares plans; a linked package's inner run is the execution host's.
"""

from __future__ import annotations

from ..errors import ValidationError
from ..links.analysis import WORST_CASE_FIGURES as FIGURES
from ..links.analysis import package_worst_case
from ..links.records import link_records
from ..links.resolve import LinkRefusal, ResolvedLink, check_composition, check_record
from ..package import read_regular_bytes
from .errors import ControlPlaneError


def _refusal(refusal: LinkRefusal, *, status=409, subject=None) -> ControlPlaneError:
    message = str(refusal).split(": ", 1)[-1]
    return ControlPlaneError(
        refusal.code, message, status=status, details={"dependency": subject} if subject else None
    )


def resolved_link(session, child) -> ResolvedLink:
    """A child session as the link analysis reads it."""
    record = next(
        r for r in session.package.manifest["dependencies"] if r["id"] == child.dependency
    )
    return ResolvedLink(
        dependency=child.dependency,
        record=dict(record),
        package=child.package,
        archive_sha256=child.archive_sha256,
        signer=child.publisher["signer_fingerprint"],
        trust=child.publisher["trust_status"],
        worst_case=package_worst_case(child.package.graph, child.package.policy),
    )


def children(plane, session) -> dict:
    """The open child sessions of a caller, by dependency id."""
    found = {}
    for dependency, child_id in session.links.items():
        child = plane._sessions.get(child_id)
        if child is not None:
            found[dependency] = child
    return found


def denied(plane, session) -> set:
    """The dependencies the person denied: by name, and every one signed by a denied key."""
    linked = children(plane, session)
    keys = {
        linked[name].publisher["signer_fingerprint"]
        for name in session.link_denials
        if name in linked
    }
    return set(session.link_denials) | {
        name for name, child in linked.items() if child.publisher["signer_fingerprint"] in keys
    }


def decision(plane, session, dependency, child) -> str:
    if dependency in denied(plane, session):
        return "denied"
    if child.receipt is not None and child.receipt["runnable"]:
        return "accepted"
    return "undecided"


def resolve(plane, session, archives) -> dict:
    """L-10…L-12: every dependency fetched from its locator under the package-URL policy, or
    read from an archive the person supplied, opened as a session of its own, then checked
    against its record. A refusal leaves no child session behind."""
    records = session.package.manifest["dependencies"]
    archives = dict(archives or {})
    if not records:
        raise ControlPlaneError("invalid_request", "This package declares no dependencies")
    stray = sorted(set(archives) - {record.get("id") for record in records})
    if stray:
        raise ControlPlaneError(
            "link_dependency_unknown", f"{stray[0]!r} is not a dependency this package declares"
        )
    with plane._lock:
        for child in children(plane, session).values():
            plane._drop(child)
        session.links.clear()
        session.link_denials.clear()
        plane._release_all(session)
        session.run_plan = None
    made = {}
    try:
        for record in records:
            name = record["id"]
            label = f"dependency {name!r}"
            try:
                if name in archives:
                    data = read_regular_bytes(archives[name], plane.config.max_package_bytes + 1)
                else:
                    data = plane._download(record["locator"])
            except (ControlPlaneError, ValidationError) as exc:
                raise ControlPlaneError(
                    "link_fetch_failed",
                    f"{label}: {exc}",
                    status=getattr(exc, "status", 400),
                    details={"dependency": name, "cause": getattr(exc, "code", "source_rejected")},
                ) from exc
            source = {
                "kind": "link",
                "display": record["locator"],
                "dependency": name,
                "parent": session.session_id,
            }
            try:
                child = plane._open_session(data, source)
            except ControlPlaneError as exc:
                if exc.code != "package_rejected":
                    raise
                raise ControlPlaneError(
                    "link_package_invalid",
                    f"{label}: {exc}",
                    status=422,
                    details={"dependency": name, **exc.details},
                ) from exc
            made[name] = child
            child.parent, child.dependency = session.session_id, name
            if child.publisher["signature_status"] != "valid":
                raise ControlPlaneError(
                    "link_signature_invalid",
                    f"{label}: a linked package carries a valid publisher signature "
                    f"({child.publisher['signature_status']})",
                    status=409,
                    details={"dependency": name},
                )
            try:
                check_record(record, child.package, child.publisher["signer_fingerprint"])
            except LinkRefusal as refusal:
                raise _refusal(refusal, subject=name) from refusal
    except BaseException:
        with plane._lock:
            for child in made.values():
                plane._drop(child)
        raise
    with plane._lock:
        session.links = {name: child.session_id for name, child in made.items()}
        listing = review(plane, session)
        session.summary["links"] = listing["composed"]
    return listing


def review(plane, session) -> dict:
    """L-13: the caller and every linked package, each with its publisher as the person's own
    store sees it, its worst case, and where its decision stands; grouped by publisher key."""
    linked = children(plane, session)
    refused = denied(plane, session)
    resolved = {name: resolved_link(session, child) for name, child in linked.items()}
    links, publishers = [], {}
    for name, child in sorted(linked.items()):
        link = resolved[name]
        links.append(
            {
                "dependency": name,
                "session_id": child.session_id,
                "package": {
                    key: link.facts()[key]
                    for key in ("package_id", "name", "version", "digest", "archive_sha256")
                },
                "publisher": dict(child.publisher),
                "worst_case": {figure: link.worst_case[figure] for figure in FIGURES},
                "decision": decision(plane, session, name, child),
                "authorization": {
                    "state": "issued" if child.receipt else "pending",
                    "receipt_id": child.receipt["receipt_id"] if child.receipt else None,
                },
                "run_plan": {
                    "state": "prepared" if child.run_plan else "absent",
                    "run_plan_sha256": child.run_plan["run_plan_sha256"]
                    if child.run_plan
                    else None,
                },
            }
        )
        group = publishers.setdefault(
            link.signer,
            {
                "signer_fingerprint": link.signer,
                "trust_status": child.publisher["trust_status"],
                "claimed_name": child.publisher["claimed_name"],
                "dependencies": [],
            },
        )
        group["dependencies"].append(name)
    return {
        "session_id": session.session_id,
        "package_digest": session.package.digest,
        "resolved": len(linked) == len(session.package.manifest["dependencies"]),
        "links": links,
        "publishers": [publishers[key] for key in sorted(publishers)],
        "composed": link_records(session.package, resolved or None, refused),
        "note": (
            "A link names a package; it grants nothing. Each linked package is authorized on "
            "its own session, with its own receipt and its own inner Run Plan, or denied."
        ),
    }


def plan_links(plane, session, model_id) -> tuple[list, dict | None, dict | None]:
    """What the caller's plan needs of its links (L-14, L-15, L-17, L-20): the blocking reasons,
    the plan's `links` section, and the worst cases the composed envelope is computed from (None
    for a denied link). A package without dependencies gets no section."""
    records = session.package.manifest["dependencies"]
    if not records:
        return [], None, None
    linked = children(plane, session)
    blockers, section, costs = [], {}, {}

    def block(code, message, subject=None):
        blockers.append({"code": code, "message": message, "subject": subject})

    if set(linked) != {record["id"] for record in records}:
        block(
            "link_unresolved",
            "This package links other packages; resolve them before preparing a run plan",
        )
        return blockers, None, None
    refused = denied(plane, session)
    for name, child in sorted(linked.items()):
        link = resolved_link(session, child)
        entry = {
            **{key: link.facts()[key] for key in ("package_id", "version", "digest")},
            "archive_sha256": link.archive_sha256,
            "signer": link.signer,
            "trust": link.trust,
            "decision": "denied" if name in refused else "accepted",
            "plan_hash": None,
        }
        section[name] = entry
        if name in refused:
            costs[name] = None
            continue
        costs[name] = link.worst_case
        plan = child.run_plan
        ready = (
            plan is not None
            and plan["readiness"]["ready"]
            and plane._preflight(child)["ready"]
            and (plan.get("model_binding") or {}).get("host_model_id") == model_id
            and plan.get("parent") == {"package_digest": session.package.digest, "dependency": name}
        )
        if not ready:
            block(
                "link_undecided",
                f"Linked package {name!r} has no ready inner plan on this model: authorize it "
                "and prepare its plan, or deny it",
                subject=name,
            )
            continue
        entry["plan_hash"] = plan["run_plan_sha256"]
    if not blockers:
        try:
            check_composition(session.package, costs)
        except LinkRefusal as refusal:
            block(refusal.code, str(refusal).split(": ", 1)[-1])
    return blockers, section, costs


def staleness(plane, session, plan) -> list[dict]:
    """L-15: what re-verification finds about the inner plans a caller's plan names."""
    reasons = []

    def stale(code, message, subject):
        reasons.append({"code": code, "message": message, "subject": subject})

    linked = children(plane, session)
    for name, entry in sorted((plan.get("links") or {}).items()):
        if entry["decision"] != "accepted":
            continue
        child = linked.get(name)
        if child is None or child.run_plan is None:
            stale("link_plan_cleared", f"Linked package {name!r} no longer has an inner plan", name)
            continue
        inner = child.run_plan
        if inner.get("parent") != {"package_digest": session.package.digest, "dependency": name}:
            stale(
                "link_plan_parent_mismatch",
                f"The inner plan of {name!r} was prepared for another caller",
                name,
            )
        elif inner["run_plan_sha256"] != entry["plan_hash"]:
            stale("link_plan_changed", f"The inner plan of {name!r} changed", name)
        else:
            state = plane._preflight(child)
            if not state["ready"] or state["stale"]:
                cause = (state["stale_reasons"] or state["blocking_reasons"] or [{}])[0]
                stale(
                    "link_plan_stale",
                    f"The inner plan of {name!r} is no longer ready"
                    + (f" ({cause.get('code')})" if cause.get("code") else ""),
                    name,
                )
    return reasons


__all__ = ["children", "denied", "plan_links", "resolve", "resolved_link", "review", "staleness"]
