#!/usr/bin/env python3
"""Verify one run of a package with links from its record alone (link.v0, spec/link-v0.md; T65,
D-697). The record is an `agentpkg run --out` directory: the caller's `result.json`,
`audit.json`, `usage.json`, `provenance.json`, the run's `links.json`, and each inner run's
`link-<inner run id>.{result,audit,usage,provenance}.json`.

    python scripts/verify_link_run.py <run directory> \
        [--package <caller archive or source>] [--link <id>=<archive>]... \
        [--observations <file> --canary <value>...]

The caller and the linked archives are found in `dist/` by their digests when they are not
named. Nothing is taken from the record that the declarations can state: the composed bound is
recomputed from the caller's and the linked packages' own declarations and the record's
decisions (a denied link left out, a slot at its ceiling), and every observed figure is counted
from the audits.

Checks: the record holds its files; each audit is one valid hash chain under its own run id;
the packages are the pinned ones (digest, signature, signer); the composed bound; the caller's
figures inside it; the inner runs' usage summed into the caller's; a decision for every inner
run (an accepted link's plan, hash-bound to this caller; for a join, an accepted
`link.decided`); no inner run and no card for a publisher denied in the run; each inner run
inside its reservation and its own worst case, its dispatches its own package's approved tools
on its own declared hosts; an accepted join's worst case inside the slot's ceiling; a
`budget.raised` naming this run and its plan.

The canary hook (EL's metric iii, T67): `--observations` is a driver's record of what each
inner run sent, `{<inner run id>: {"model_requests": [...], "tool_arguments": [...]}}`; every
recorded value must be one the inner audit hashed, and none may hold a `--canary` value, exact
or in the encodings of the protocol's §2.6.5.

Prints one JSON document with `"passed"`; exit status 1 on a failed check.
"""

from __future__ import annotations

import argparse
import base64
import json
import sys
from collections import Counter
from pathlib import Path
from urllib.parse import quote

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "agentpkg" / "src"))

from agentpkg.browser.evaluation import signature_report
from agentpkg.delegation.analysis import worst_case
from agentpkg.execution.report import verify_audit_chain
from agentpkg.links.analysis import link_operations, package_worst_case
from agentpkg.links.host import plan_hash
from agentpkg.links.join import MAX_RUN_CARDS, over_ceiling
from agentpkg.package import load_package
from agentpkg.runtime import digest

SCHEMA = "webagents-verify-link-run-v0"
REQUIRED = ("result.json", "audit.json", "usage.json", "provenance.json", "links.json")
FIGURES = ("model_calls", "compute_calls", "remote_calls", "tokens")


class Checks:
    def __init__(self):
        self.items: list[dict] = []

    def add(self, name: str, passed: bool, detail=None) -> bool:
        self.items.append(
            {
                "check": name,
                "passed": bool(passed),
                **({"detail": detail} if detail else {}),
            }
        )
        return bool(passed)

    @property
    def passed(self) -> bool:
        return all(item["passed"] for item in self.items)


def _json(path: Path):
    return json.loads(path.read_text(encoding="utf-8"))


def _events(audit, action):
    return [event for event in audit if event.get("action") == action]


def _find(digest_value: str):
    """A package of `dist/` by its package digest, when the caller named none."""
    from agentpkg.errors import AgentPkgError

    for path in sorted((ROOT / "dist").glob("*.agent.pkg")):
        try:
            found = load_package(path).digest
        except (AgentPkgError, OSError):
            found = None  # an archive this runtime cannot read is not the one
        if found == digest_value:
            return path
    return None


def encodings(value: str) -> list[str]:
    """A canary as it may travel (the protocol's §2.6.5): exact, base64, hex, URL-encoded,
    reversed."""
    raw = value.encode("utf-8")
    return [
        value,
        base64.b64encode(raw).decode("ascii"),
        base64.urlsafe_b64encode(raw).decode("ascii").rstrip("="),
        raw.hex(),
        quote(value, safe=""),
        value[::-1],
    ]


def inner_dispatches(directory: Path) -> dict:
    """What each inner run dispatched, by hash, from its own audit: the hook a campaign's
    canary scan binds its recorded requests to."""
    found = {}
    for run in _json(directory / "links.json")["runs"]:
        path = directory / f"link-{run['inner_run_id']}.audit.json"
        audit = _json(path) if path.is_file() else []
        found[run["inner_run_id"]] = {
            "dependency": run.get("dependency") or run.get("slot"),
            "model_requests": [e["input_hash"] for e in _events(audit, "model.called")],
            "tool_arguments": [
                {
                    "tool": e["tool"],
                    "input_hash": e["input_hash"],
                    "domains": e["domains"],
                }
                for e in _events(audit, "tool.called")
            ],
        }
    return found


def verify(
    directory: Path, *, package=None, links=None, observations=None, canaries=()
) -> dict:
    checks = Checks()
    report: dict = {"schema": SCHEMA, "run": str(directory)}
    missing = [name for name in REQUIRED if not (directory / name).is_file()]
    for name in REQUIRED:
        checks.add(f"the record holds {name}", name not in missing)
    if missing:
        return report | {"checks": checks.items, "passed": False}
    audit = _json(directory / "audit.json")
    usage = _json(directory / "usage.json")
    record = _json(directory / "links.json")
    provenance = _json(directory / "provenance.json")
    run_id = audit[0]["run_id"] if audit else None
    chain = verify_audit_chain(audit)
    checks.add(
        "the caller's audit is one valid hash chain", chain["valid"], chain["broken"]
    )
    checks.add(
        "every caller event is this run's",
        all(event["run_id"] == run_id for event in audit),
    )

    # -- the packages ---------------------------------------------------------------------------
    path = Path(package) if package else _find(provenance["package_digest"])
    if not checks.add("the caller's package is at hand", path is not None):
        return report | {"checks": checks.items, "passed": False}
    caller = load_package(path)
    checks.add(
        "the caller's package is the one that ran",
        caller.digest == provenance["package_digest"],
    )
    pinned = {r["id"]: r for r in caller.manifest["dependencies"]}
    listed = {link["dependency"]: link for link in record["links"]}
    checks.add(
        "the record lists every declared dependency",
        set(pinned) <= set(listed),
        sorted(pinned),
    )
    linked, costs, denied_keys = {}, {}, set()
    for name, link in sorted(listed.items()):
        if link["decision"] != "accepted":
            denied_keys.add(link["signer"])
    for name, link in sorted(listed.items()):
        label = f"link {name}"
        source = (links or {}).get(name) or _find(link["digest"])
        if not checks.add(
            f"{label}: the linked package is at hand", source is not None
        ):
            continue
        archive = load_package(source)
        linked[name] = archive
        signature = signature_report(archive)
        checks.add(
            f"{label}: the archive is the pinned one",
            archive.digest == link["digest"]
            and (name not in pinned or pinned[name]["digest"] == archive.digest),
        )
        checks.add(
            f"{label}: a valid signature by the recorded key",
            signature["signature_status"] == "valid"
            and signature["signer_fingerprint"] == link["signer"]
            and pinned.get(name, {}).get("signer", link["signer"]) == link["signer"],
        )
        accepted = link["decision"] == "accepted" and link["signer"] not in denied_keys
        costs[name] = (
            package_worst_case(archive.graph, archive.policy) if accepted else None
        )
        if accepted:
            plan = link["plan"] or {}
            parent = plan.get("parent", {})
            # A host without a control plane writes a link plan, whose hash is recomputed here.
            # The execution session records the inner Run Plan's bounded facts, which carry
            # the control plane's hash of the whole plan: that hash cannot be recomputed from
            # the record, so the check says what it does check there.
            recomputed = plan.get("schema") == "agentpkg-link-plan-v0"
            own_hash = plan_hash(plan) if recomputed else plan.get("run_plan_sha256")
            checks.add(
                f"{label}: its inner plan is hash-bound to this caller"
                if recomputed
                else f"{label}: its inner plan names this caller, the pinned package and the "
                "recorded plan hash (a Run Plan's hash is its control plane's, not recomputed)",
                link["plan_hash"] == own_hash
                and parent.get("package_digest") == caller.digest
                and parent.get("dependency") == name
                and plan.get("package", {}).get("digest") == archive.digest,
            )

    # -- the packages joined during the run (section 6) -----------------------------------------
    joins = record.get("joins", [])
    stated_plan = record.get("caller_plan")
    caller_plan_hash = record.get("caller_plan_hash")
    if stated_plan is not None:
        checks.add(
            "the caller's plan is the one its hash names",
            plan_hash(stated_plan) == caller_plan_hash
            and stated_plan.get("package", {}).get("digest") == caller.digest,
        )
    # A slot may join more than once in a run (`max_joins`), so a joined package is known by the
    # inner plan its card produced, never by its slot alone.
    joined_plans, joined_archives = {}, {}
    for entry in joins:
        if not entry.get("accepted"):
            continue
        slot, kept = entry["slot"], entry.get("package") or {}
        label = f"join {slot}"
        # The archive handed over for the slot, unless another of `dist/` is the one this card
        # was decided on (a slot's second join may be of another package).
        source = (links or {}).get(slot)
        if source is None or load_package(source).digest != kept.get("digest"):
            source = _find(kept.get("digest", "")) or source
        if not checks.add(f"{label}: the joined package is at hand", source is not None):
            continue
        archive = load_package(source)
        joined_archives[entry["inner_plan_hash"]] = archive
        joined_plans[entry["inner_plan_hash"]] = kept.get("plan") or {}
        signature = signature_report(archive)
        candidate = entry.get("candidate") or {}
        checks.add(
            f"{label}: the archive is the one the card was decided on",
            archive.digest == kept.get("digest") == candidate.get("digest")
            and signature["signature_status"] == "valid"
            and signature["signer_fingerprint"] == kept.get("signer") == candidate.get("signer"),
        )
        plan = kept.get("plan") or {}
        checks.add(
            f"{label}: its inner plan is hash-bound to this plan, this run and this slot",
            plan_hash(plan) == entry["inner_plan_hash"] == kept.get("plan_hash")
            and plan.get("parent")
            == {"plan_hash": caller_plan_hash, "run_id": run_id, "slot": slot}
            and caller_plan_hash is not None
            and plan.get("package", {}).get("digest") == archive.digest,
        )

    # -- the composed bound, recomputed from the declarations -----------------------------------
    # W(caller) (L-18, L-19): the package-level worst case, which holds the network's bound and
    # every node beside the network, so that a figure observed at any node has its "at most".
    network = caller.graph.get("network")
    composed = package_worst_case(caller.graph, caller.policy, links=costs)
    at_most = {name: composed[name] for name in FIGURES} | {
        "tool_calls": dict(composed["tool_calls"])
    }
    if network is not None:
        bound = worst_case(caller.graph, caller.policy, links=costs)
        at_most |= {"max_hops": bound["max_hops"], "activations": bound["activations"]}
        started = _events(audit, "network.started")
        if started:
            stated = started[0]["bound"]
            checks.add(
                "the run's own stated bound is inside the recomputed one",
                all(stated[name] <= bound[name] for name in FIGURES)
                and stated["max_hops"] == bound["max_hops"],
                {name: stated[name] for name in FIGURES},
            )

    # -- the inner runs -------------------------------------------------------------------------
    inner_totals = {name: 0 for name in FIGURES}
    inner_tools: Counter = Counter()
    per_link: dict = {}
    starts = {event["inner_run_id"]: event for event in _events(audit, "link.started")}
    decided = {
        event.get("inner_plan_hash"): event
        for event in _events(audit, "link.decided")
        if event.get("accepted") and event.get("decided_by") == "person"
    }
    recorded = {run["inner_run_id"]: run for run in record["runs"]}
    checks.add(
        "every inner run started is recorded, and no other",
        set(starts) == set(recorded),
    )
    for inner_id, event in sorted(starts.items()):
        name = event.get("dependency") or event.get("slot")
        label = f"inner run {inner_id[:8]} ({name})"
        link = listed.get(name)
        joined = decided.get(event["inner_plan_hash"]) if "slot" in event else None
        checks.add(
            f"{label}: started on an accepted decision",
            (
                link is not None
                and link["decision"] == "accepted"
                and event["inner_plan_hash"] == link["plan_hash"]
            )
            or joined is not None,
        )
        signer = (link or {}).get("signer") or (joined or {}).get("candidate", {}).get(
            "signer"
        )
        checks.add(
            f"{label}: its publisher was not denied in this run",
            signer not in denied_keys,
        )
        files = {
            kind: directory / f"link-{inner_id}.{kind}.json"
            for kind in ("audit", "usage", "result")
        }
        if not checks.add(
            f"{label}: its record is beside the caller's",
            all(p.is_file() for p in files.values()),
        ):
            continue
        inner_audit, inner_usage = _json(files["audit"]), _json(files["usage"])
        inner_chain = verify_audit_chain(inner_audit)
        checks.add(
            f"{label}: its audit is one valid chain under its own run id",
            inner_chain["valid"]
            and all(e["run_id"] == inner_id for e in inner_audit)
            and inner_id != run_id,
        )
        package_ = (
            joined_archives.get(event["inner_plan_hash"])
            if "slot" in event
            else linked.get(name)
        )
        opened = _events(inner_audit, "runtime.started")
        checks.add(
            f"{label}: it ran the pinned package",
            bool(opened)
            and package_ is not None
            and opened[0]["package_digest"] == package_.digest,
        )
        spent = {
            "tokens": inner_usage["tokens"],
            "remote_calls": inner_usage["remote_calls"],
            "model_calls": len(_events(inner_audit, "model.called")),
            "compute_calls": inner_usage.get("compute_calls", 0),
        }
        tools = Counter(e["tool"] for e in _events(inner_audit, "tool.called"))
        checks.add(
            f"{label}: inside its reservation",
            spent["tokens"] <= event["reserved"]["tokens"]
            and spent["remote_calls"] <= event["reserved"]["remote_calls"],
            spent,
        )
        if package_ is not None:
            own = package_worst_case(package_.graph, package_.policy)
            checks.add(
                f"{label}: inside its own worst case",
                all(spent[figure] <= own[figure] for figure in FIGURES)
                and all(
                    count <= own["tool_calls"].get(tool, 0)
                    for tool, count in tools.items()
                ),
            )
            inner_plan = (link or {}).get("plan") or joined_plans.get(
                event["inner_plan_hash"], {}
            )
            approved = set(inner_plan.get("tool_approvals", [])) | {
                binding["tool_id"] for binding in inner_plan.get("tool_bindings") or []
            }
            allowed = set(package_.policy["network"]["allowed_domains"])
            checks.add(
                f"{label}: its dispatches are its own plan's approved tools on its declared hosts",
                all(
                    e["tool"] in package_.tools
                    and e["tool"] in approved
                    and set(e["domains"]) <= allowed
                    for e in _events(inner_audit, "tool.called")
                ),
            )
        for figure in FIGURES:
            inner_totals[figure] += spent[figure]
        for tool, count in tools.items():
            inner_tools[f"{name}:{tool}"] += count
        totals = per_link.setdefault(name, {"runs": 0} | {figure: 0 for figure in FIGURES})
        totals["runs"] += 1
        for figure in FIGURES:
            totals[figure] += spent[figure]
    checks.add(
        "no inner run of a denied link",
        not any(
            listed.get(e.get("dependency"), {}).get("decision", "accepted")
            != "accepted"
            for e in starts.values()
        ),
    )
    checks.add(
        "no card for a publisher denied in the run",
        not any(
            event.get("decided_by") == "person"
            and (event.get("candidate") or {}).get("signer") in denied_keys
            for event in _events(audit, "link.decided")
        ),
    )

    # -- the caller's figures: its own calls plus every inner run's -----------------------------
    own_models = len(_events(audit, "model.called"))
    own_tokens = sum(
        e.get("tokens", 0) for e in _events(audit, "model.completed")
    ) + sum(e.get("tokens_charged", 0) for e in _events(audit, "model.failed"))
    own_tools = Counter(e["tool"] for e in _events(audit, "tool.called"))
    own_compute = len(_events(audit, "compute.called"))
    # L-26: the caller's usage holds every inner call in tokens, remote calls, compute calls
    # and tool calls; a run's usage has no model-call total, so model calls are counted from
    # the chains: the caller's own events and each inner run's.
    observed = {
        "model_calls": own_models + inner_totals["model_calls"],
        "compute_calls": usage.get("compute_calls", 0),
        "remote_calls": usage["remote_calls"],
        "tokens": usage["tokens"],
        # Sorted, so that two verifications of one walk print the same JSON whatever the
        # inner runs' ids were.
        "tool_calls": dict(sorted((own_tools + inner_tools).items())),
    }
    checks.add(
        "the caller's tokens are its own calls plus every inner run's",
        usage["tokens"] == own_tokens + inner_totals["tokens"],
        {"usage": usage["tokens"], "own": own_tokens, "inner": inner_totals["tokens"]},
    )
    checks.add(
        "the caller's tool calls are its own plus every inner run's, qualified",
        dict(usage["tool_calls"]) == observed["tool_calls"],
    )
    checks.add(
        "the caller's remote calls hold every inner run's",
        usage["remote_calls"] >= inner_totals["remote_calls"],
    )
    checks.add(
        "the caller's compute calls are its own plus every inner run's",
        usage.get("compute_calls", 0) == own_compute + inner_totals["compute_calls"],
        {
            "usage": usage.get("compute_calls"),
            "own": own_compute,
            "inner": inner_totals["compute_calls"],
        },
    )
    stated = usage.get("links", {})
    checks.add(
        "the usage record's links are the inner records summed",
        all(
            stated.get(name, {}).get(key, 0) == value
            for name, totals in per_link.items()
            for key, value in totals.items()
        ),
    )
    for figure in FIGURES:
        checks.add(
            f"{figure} inside the composed bound",
            observed[figure] <= at_most[figure],
            {"observed": observed[figure], "at_most": at_most[figure]},
        )
    # A slot's ceiling is a total over the joined package's own tools (`<slot>:*`).
    slot_tools: Counter = Counter()
    for tool, count in sorted(observed["tool_calls"].items()):
        if tool in at_most["tool_calls"]:
            checks.add(
                f"tool_calls.{tool} inside the composed bound",
                count <= at_most["tool_calls"][tool],
            )
        else:
            slot_tools[f"{tool.split(':')[0]}:*"] += count
    for tool, count in sorted(slot_tools.items()):
        checks.add(
            f"tool_calls.{tool} inside the composed bound",
            count <= at_most["tool_calls"].get(tool, 0),
        )
    if network is not None:
        activations = Counter(e["role"] for e in _events(audit, "network.activated"))
        observed["activations"] = dict(activations)
        for role, count in sorted(activations.items()):
            checks.add(
                f"activations.{role} inside the composed bound",
                count <= at_most["activations"][role],
            )
        completed = _events(audit, "network.completed")
        if completed:
            observed["hops"] = completed[0]["hops"]
            checks.add(
                "hops inside the bound", completed[0]["hops"] <= at_most["max_hops"]
            )

    # -- joins and raises (the stretch half's records, when a run holds them) -------------------
    slots = {
        step["slot"]: step
        for _, step, _, _ in link_operations(caller.graph)
        if "slot" in step
    }
    decisions = _events(audit, "link.decided")
    if slots or decisions:
        checks.add(
            "the record's joins are the audit's decisions, in order",
            [(j["slot"], j["accepted"], j["decided_by"], j.get("inner_plan_hash")) for j in joins]
            == [
                (e["slot"], e["accepted"], e["decided_by"], e.get("inner_plan_hash"))
                for e in decisions
            ],
        )
    cards = [event for event in decisions if event.get("decided_by") == "person"]
    if slots:
        checks.add(
            "the cards shown are inside the caps",
            len(cards) <= MAX_RUN_CARDS
            and all(
                sum(1 for card in cards if card["slot"] == name) <= step["max_joins"]
                for name, step in slots.items()
            ),
        )
    # A key the person declined on a card is denied from then on (L-13, L-35): no later card of
    # it, and no inner run of it started after the decline, a planned link's or a join's.
    declined: dict = {}
    for event in decisions:
        signer = (event.get("candidate") or {}).get("signer")
        if event.get("decided_by") == "person":
            checks.add(
                f"join {event['slot']}: no card for a key declined earlier in the run",
                signer not in declined,
            )
            if not event.get("accepted"):
                declined.setdefault(signer, event["sequence"])

    def signer_of(start):
        if "slot" in start:
            card = decided.get(start["inner_plan_hash"], {})
            return (card.get("candidate") or {}).get("signer")
        return listed.get(start.get("dependency"), {}).get("signer")

    if decisions:
        checks.add(
            "no inner run of a key declined on a card",
            not any(
                signer_of(start) in declined and start["sequence"] > declined[signer_of(start)]
                for start in starts.values()
            ),
        )

    def at(node_id, action, after, before):
        return [
            e
            for e in _events(audit, action)
            if e.get("node_id") == node_id and after < e["sequence"] < before
        ]

    for event in decisions:
        if not event.get("accepted"):
            continue
        slot = event.get("slot")
        package_ = joined_archives.get(event["inner_plan_hash"])
        own = (
            package_worst_case(package_.graph, package_.policy)
            if package_ is not None
            else None
        )
        checks.add(
            f"join {slot}: the candidate's worst case, recomputed from its own declaration, "
            "fits the slot's ceiling in every figure and is the one the card stated",
            slot in slots
            and own is not None
            and over_ceiling(own, slots[slot]) is None
            and all(own[figure] == (event.get("worst_case") or {}).get(figure) for figure in FIGURES)
            and dict(own["tool_calls"]) == (event.get("worst_case") or {}).get("tool_calls"),
        )
        # A slot step may run once per activation of its role, and a slot may join more than
        # once, so each decision has its window at the step: from the decision before it to
        # the one after it. Before this decision, the look; after it, at most one
        # request-building call, then at most one inner run, this decision's.
        node_id, here = event["node_id"], event["sequence"]
        others = [e["sequence"] for e in decisions if e["node_id"] == node_id]
        opened = max((s for s in others if s < here), default=-1)
        closed = min((s for s in others if s > here), default=float("inf"))
        calls = at(node_id, "model.called", here, closed)
        began = at(node_id, "link.started", here, closed)
        checks.add(
            f"join {slot}: looked, then decided, then the request built, then the inner run",
            bool(at(node_id, "link.requested", opened, here))
            and len(calls) <= 1
            and len(began) <= 1
            and all(
                e.get("inner_plan_hash") == event["inner_plan_hash"]
                and all(call["sequence"] < e["sequence"] for call in calls)
                for e in began
            ),
        )
    if decisions:
        # And nothing at a slot step outside such a window: a model call or an inner run there
        # has an accepted decision of that step as the last one before it.
        def last_decision(later):
            prior = [
                e
                for e in decisions
                if e["node_id"] == later["node_id"] and e["sequence"] < later["sequence"]
            ]
            return prior[-1] if prior else {}

        steps = {e["node_id"] for e in decisions}
        checks.add(
            "at a slot step, a model call and an inner run follow an accepted decision of it",
            all(
                last_decision(e).get("accepted")
                for action in ("model.called", "link.started")
                for e in _events(audit, action)
                if e.get("node_id") in steps
            ),
        )
    raises = _events(audit, "budget.raised")
    asks = _events(audit, "budget.requested")
    if raises or asks:
        checks.add("at most one raise is asked in a run", len(asks) <= 1 and len(raises) <= 1)
    for event in raises:
        asked = [e for e in asks if e["sequence"] < event["sequence"]]
        cap = caller.policy["budget"][
            "hard_tokens" if event["limit"] == "tokens" else "max_remote_calls"
        ]
        checks.add(
            "a raise names this run and its plan, and was asked for these figures",
            event["run_id"] == run_id
            and bool(asked)
            and event.get("plan_hash") is not None
            and event.get("plan_hash") == caller_plan_hash == asked[-1].get("plan_hash")
            and (event["limit"], event["from"], event["to"])
            == (asked[-1]["limit"], asked[-1]["from"], asked[-1]["to"]),
        )
        checks.add(
            "a raise lifts the person's limit by at most half and never above the package's cap",
            event["to"] - event["from"] <= event["from"] // 2 and event["to"] <= cap,
            {"from": event["from"], "to": event["to"], "package_cap": cap},
        )

    # -- the canary hook ------------------------------------------------------------------------
    dispatches = inner_dispatches(directory)
    if canaries:
        # What a slot looked at before the person decided (the addresses of its fetches).
        needles = [needle for canary in canaries for needle in encodings(canary)]
        fetched = json.dumps(
            [f["url"] for e in _events(audit, "link.requested") for f in e["fetches"]]
        )
        checks.add(
            "no canary in what a slot fetched before the decision",
            not any(needle in fetched for needle in needles),
        )
    if observations is not None:
        needles = [needle for canary in canaries for needle in encodings(canary)]
        for inner_id, seen in sorted(observations.items()):
            known = dispatches.get(
                inner_id, {"model_requests": [], "tool_arguments": []}
            )
            hashes = set(known["model_requests"]) | {
                t["input_hash"] for t in known["tool_arguments"]
            }
            values = list(seen.get("model_requests", [])) + list(
                seen.get("tool_arguments", [])
            )
            checks.add(
                f"inner run {inner_id[:8]}: every observed value is one its audit hashed",
                all(digest(value) in hashes for value in values),
            )
            text = json.dumps(values, ensure_ascii=False)
            checks.add(
                f"inner run {inner_id[:8]}: no canary in what it sent",
                not any(needle in text for needle in needles),
            )

    failed = [item for item in checks.items if not item["passed"]]
    return report | {
        "status": _json(directory / "result.json").get("status"),
        "package": {
            "package_id": caller.manifest["package_id"],
            "digest": caller.digest,
        },
        "links": [
            {
                "dependency": name,
                "package_id": link["package_id"],
                "signer": link["signer"],
                "trust": link["trust"],
                "decision": link["decision"],
                "runs": per_link.get(name, {}).get("runs", 0),
            }
            for name, link in sorted(listed.items())
        ],
        # Present where the run holds them: every slot step's outcome, and the one raise.
        **(
            {
                "joins": [
                    {
                        "slot": entry["slot"],
                        "joined": entry.get("joined", False),
                        "reason": entry.get("reason"),
                        "decided_by": entry["decided_by"],
                        "package_id": (entry.get("candidate") or {}).get("package_id"),
                    }
                    for entry in joins
                ]
            }
            if joins
            else {}
        ),
        **(
            {"raises": [{key: e[key] for key in ("limit", "from", "to")} for e in raises]}
            if raises
            else {}
        ),
        "at_most": at_most,
        "observed": observed,
        "tightness": {
            figure: round(at_most[figure] / observed[figure], 3)
            for figure in FIGURES
            if observed[figure]
        },
        "inner_dispatches": {
            inner_id: {
                "dependency": found["dependency"],
                "model_requests": len(found["model_requests"]),
                "tool_arguments": len(found["tool_arguments"]),
            }
            for inner_id, found in dispatches.items()
        },
        "checks": failed if failed else len(checks.items),
        "passed": checks.passed,
    }


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("run", help="An `agentpkg run --out` directory")
    parser.add_argument("--package", help="The caller's archive or source")
    parser.add_argument("--link", action="append", default=[], metavar="ID=ARCHIVE")
    parser.add_argument(
        "--observations", help="A driver's record of what each inner run sent"
    )
    parser.add_argument("--canary", action="append", default=[])
    args = parser.parse_args(argv)
    try:
        links = dict(value.split("=", 1) for value in args.link)
        observations = _json(Path(args.observations)) if args.observations else None
        result = verify(
            Path(args.run),
            package=args.package,
            links=links,
            observations=observations,
            canaries=args.canary,
        )
    except Exception as exc:  # noqa: BLE001 - a record that cannot be read is a failed report
        result = {
            "schema": SCHEMA,
            "run": args.run,
            "checks": [
                {"check": "the record can be read", "passed": False, "detail": str(exc)}
            ],
            "passed": False,
        }
    print(json.dumps(result, indent=2, ensure_ascii=False))
    return 0 if result["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
