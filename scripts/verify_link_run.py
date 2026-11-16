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
from agentpkg.delegation.analysis import link_cost, worst_case
from agentpkg.execution.report import verify_audit_chain
from agentpkg.links.analysis import link_operations, package_worst_case
from agentpkg.links.host import plan_hash
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
            "dependency": run["dependency"],
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
            checks.add(
                f"{label}: its inner plan is hash-bound to this caller",
                link["plan_hash"] == plan_hash(plan)
                and parent.get("package_digest") == caller.digest
                and plan.get("package", {}).get("digest") == archive.digest,
            )

    # -- the composed bound, recomputed from the declarations -----------------------------------
    network = caller.graph.get("network")
    if network is not None:
        bound = worst_case(caller.graph, caller.policy, links=costs)
    else:
        bound = package_worst_case(caller.graph, caller.policy, links=costs)
    at_most = {name: bound[name] for name in FIGURES} | {
        "tool_calls": dict(bound["tool_calls"])
    }
    if network is not None:
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
        package_ = linked.get(name)
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
            approved = set(((link or {}).get("plan") or {}).get("tool_approvals", []))
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
        totals = per_link.setdefault(name, {"runs": 0, "tokens": 0, "remote_calls": 0})
        totals["runs"] += 1
        totals["tokens"] += spent["tokens"]
        totals["remote_calls"] += spent["remote_calls"]
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
    observed = {
        "model_calls": own_models + inner_totals["model_calls"],
        "compute_calls": usage.get("compute_calls", 0) + inner_totals["compute_calls"],
        "remote_calls": usage["remote_calls"],
        "tokens": usage["tokens"],
        "tool_calls": dict(own_tools + inner_tools),
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
    for tool, count in sorted(observed["tool_calls"].items()):
        qualified = tool if tool in at_most["tool_calls"] else f"{tool.split(':')[0]}:*"
        checks.add(
            f"tool_calls.{tool} inside the composed bound",
            count <= at_most["tool_calls"].get(qualified, 0),
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
    for event in _events(audit, "link.decided"):
        if not event.get("accepted"):
            continue
        ceiling = (
            link_cost(slots[event["slot"]]) if event.get("slot") in slots else None
        )
        worst = event.get("worst_case") or {}
        checks.add(
            f"join {event.get('slot')}: the candidate's worst case fits the slot's ceiling",
            ceiling is not None
            and worst.get("model_calls", 0) + 1 <= ceiling["model_calls"]
            and sum(worst.get("tool_calls", {}).values())
            <= sum(ceiling["tool_calls"].values())
            and all(
                worst.get(figure, 0) <= ceiling[figure]
                for figure in ("compute_calls", "remote_calls", "tokens")
            ),
        )
    for event in _events(audit, "budget.raised"):
        asked = [
            e
            for e in _events(audit, "budget.requested")
            if e["sequence"] < event["sequence"]
        ]
        checks.add(
            "a raise names this run and the plan it was asked for",
            event["run_id"] == run_id
            and bool(asked)
            and event.get("plan_hash") is not None
            and event.get("plan_hash") == asked[-1].get("plan_hash"),
        )

    # -- the canary hook ------------------------------------------------------------------------
    dispatches = inner_dispatches(directory)
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
