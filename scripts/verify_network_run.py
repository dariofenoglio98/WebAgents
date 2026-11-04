"""A delegation run in the Chrome Agent Browser (T26, network.v0): recompute it from its files.

    agentpkg/.venv/bin/python scripts/verify_network_run.py \\
        --report examples/verification/chrome-network-e2e-t26.json
    agentpkg/.venv/bin/python scripts/verify_network_run.py \\
        --export ~/Downloads/run_<id>.zip [--out <report.json>]

The first form reads the headless harness's report (`chrome-agent-browser/scripts/e2e-network.mjs`)
and the directories it wrote (the run export, the recorded requests, the reference's fixture run
of the same archive) and rewrites the report with a `network_verification` section. The second
reads one run the person exported from the Runs page (a live run, `User runs`) and prints the same
checks. Everything is recomputed with agentpkg's own code from the files, never taken from what
the harness or the extension concluded:

* `audit.json` is one valid hash chain, and it is the run record's (`run.json`'s final hash);
* the package is a known signed archive (`dist/`, by its archive SHA-256), and the plan's envelope
  (`run-plan.json` `execution.network.worst_case`) is the one agentpkg computes from that signed
  declaration (`agentpkg.delegation.analysis.worst_case`, R-21, R-24);
* the run's own `network.started` bound is the envelope under the run's effective limits, never
  above the plan's;
* the walk: `network.activated` in order, every `route.decided` with its reason, each allowed
  transition a declared edge, the hops and activations counted from them;
* every observed figure stays within the plan's "at most": handoffs, activations per role, logical
  model calls (a host's re-ask is another attempt of the same call, charged to the tokens and the
  remote calls, which the envelope bounds; `model.called` with `attempt` > 1 is counted
  separately), tool calls per tool, compute calls, remote calls and tokens (from `usage.json`);
  and per role, its tokens and remote calls within its budget per activation times its activations;
* the recorded requests (when `observations.json` is there) went only to the model's origin and
  the hosts the package declares;
* with a reference (the harness), the same walk, the same route decisions and the same exports as
  agentpkg's fixture run of the same archive.

The tightness (observed ÷ at most) is reported per component; a live run may stay below every
figure, and no run may pass one.
"""

from __future__ import annotations

import argparse
import hashlib
import io
import json
import sys
import zipfile
from collections import Counter
from collections.abc import Callable
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "agentpkg" / "src"))

from agentpkg.delegation.analysis import DONE, worst_case
from agentpkg.execution.report import verify_audit_chain
from agentpkg.package import load_package

REQUIRED_FILES = ("run.json", "run-plan.json", "audit.json", "usage.json")


def _checks() -> tuple[list[dict], Callable[..., None]]:
    """A fresh check list per verification, so `verify()` is re-entrant (T26 review 1, nit 4)."""
    checks: list[dict] = []

    def check(name: str, ok: bool, detail=None) -> None:
        checks.append(
            {
                "check": name,
                "passed": bool(ok),
                **({} if detail is None else {"detail": detail}),
            }
        )

    return checks, check


def failed(reason: str) -> dict:
    """A failed report for an input that cannot be verified at all (never a traceback)."""
    return {"checks": [{"check": reason, "passed": False}], "passed": False}


def read_export(path: Path) -> dict[str, bytes]:
    """The files of a run export: a directory, or the zip the Runs page saves."""
    if path.is_dir():
        return {
            str(item.relative_to(path)): item.read_bytes()
            for item in path.rglob("*")
            if item.is_file()
        }
    with zipfile.ZipFile(io.BytesIO(path.read_bytes())) as archive:
        names = [name for name in archive.namelist() if not name.endswith("/")]
        prefix = ""
        if names and all("/" in name for name in names):
            first = names[0].split("/", 1)[0] + "/"
            if all(name.startswith(first) for name in names):
                prefix = first
        return {name[len(prefix) :]: archive.read(name) for name in names}


def known_archive(archive_sha256: str) -> Path | None:
    for candidate in sorted((ROOT / "dist").glob("*.agent.pkg")):
        if hashlib.sha256(candidate.read_bytes()).hexdigest() == archive_sha256:
            return candidate
    return None


def observed_walk(audit: list[dict]) -> dict:
    activated = [e for e in audit if e["action"] == "network.activated"]
    decided = [e for e in audit if e["action"] == "route.decided"]
    called = [e for e in audit if e["action"] == "model.called"]
    return {
        "walk": [e["role"] for e in activated],
        "activations": dict(Counter(e["role"] for e in activated)),
        "decisions": [
            {
                k: e.get(k)
                for k in (
                    "hop",
                    "role",
                    "activation",
                    "chosen_by",
                    "next",
                    "allowed",
                    "reason",
                )
            }
            for e in decided
        ],
        "hops": sum(
            1 for e in decided if e["allowed"] and e.get("next") not in (None, DONE)
        ),
        "model_calls": sum(1 for e in called if not (e.get("attempt") or 1) > 1),
        "model_reasks": sum(1 for e in called if (e.get("attempt") or 1) > 1),
        "tool_calls": dict(
            Counter(e["tool"] for e in audit if e["action"] == "tool.called")
        ),
        "compute_calls": sum(1 for e in audit if e["action"] == "compute.called"),
        "started": next((e for e in audit if e["action"] == "network.started"), None),
        "completed": next(
            (e for e in audit if e["action"] == "network.completed"), None
        ),
        "failed": next((e for e in audit if e["action"] == "network.failed"), None),
        "workers": {
            e["worker"]: e["role"]
            for e in audit
            if e["action"] == "worker.spawned" and e.get("role")
        },
    }


def verify(
    files: dict[str, bytes], reference: Path | None = None, model_hosts=None
) -> dict:
    checks, check = _checks()
    for name in REQUIRED_FILES:
        check(f"the export holds {name}", name in files)
    try:
        record, plan, audit, usage = (
            json.loads(files[name]) for name in REQUIRED_FILES
        )
    except (KeyError, ValueError):
        return {"checks": checks, "passed": False}
    chain = verify_audit_chain(audit)
    check(
        "audit.json is one valid hash chain, the run record's",
        chain["valid"] is True
        and (record.get("audit") or {}).get("finalHash") == chain.get("final_hash"),
        {"chain": chain, "record": (record.get("audit") or {}).get("finalHash")},
    )
    archive_sha256 = record["package"]["archiveSha256"]
    archive = known_archive(archive_sha256)
    check(
        "the package is a known signed archive in dist/",
        archive is not None,
        archive_sha256,
    )
    network = plan["execution"].get("network")
    check(
        "the plan records the network's envelope (execution.network)",
        network is not None,
    )
    if archive is None or network is None:
        return {"checks": checks, "passed": False}
    package = load_package(archive)
    declared = worst_case(package.graph, package.policy)
    check(
        "the plan's envelope is the one agentpkg computes from the signed declaration",
        network["worst_case"] == json.loads(json.dumps(declared)),
        {"plan": network["worst_case"], "agentpkg": declared},
    )
    at_most = network["worst_case"]
    seen = observed_walk(audit)
    started = seen["started"]
    check(
        "the run reserved the envelope before the first activation (network.started), "
        "never above the plan's",
        started is not None
        and all(
            started["bound"][k] <= at_most[k]
            for k in ("tokens", "remote_calls", "model_calls")
        )
        and started["bound"]["max_hops"] == at_most["max_hops"],
        started and started["bound"],
    )
    roles = package.graph["network"]["roles"]
    edges_ok = all(
        d["next"] == DONE
        or any(edge["to"] == d["next"] for edge in roles[d["role"]]["edges"])
        for d in seen["decisions"]
        if d["allowed"]
    )
    check("every allowed handoff is along a declared edge", edges_ok, seen["decisions"])
    check(
        "the walk follows the decisions: each activation after the first is the target of the "
        "previous allowed decision",
        seen["walk"][1:]
        == [d["next"] for d in seen["decisions"] if d["allowed"] and d["next"] != DONE],
        {"walk": seen["walk"], "decisions": seen["decisions"]},
    )
    observed = {
        "max_hops": seen["hops"],
        "model_calls": seen["model_calls"],
        "compute_calls": seen["compute_calls"],
        "remote_calls": usage["remote_calls"],
        "tokens": usage["tokens"],
    }
    within = {name: observed[name] <= at_most[name] for name in observed}
    for role_id, count in seen["activations"].items():
        within[f"activations.{role_id}"] = count <= at_most["activations"].get(
            role_id, 0
        )
    for tool, count in seen["tool_calls"].items():
        within[f"tool_calls.{tool}"] = count <= at_most["tool_calls"].get(tool, 0)
    check(
        "every observed figure stays within the plan's at most",
        all(within.values()),
        {
            "observed": observed,
            "activations": seen["activations"],
            "tools": seen["tool_calls"],
        },
    )
    workers = {w["id"]: w for w in package.graph["workers"]}
    per_role = {}
    for worker, role in seen["workers"].items():
        row = usage["workers"].get(worker, {"tokens": 0, "remote_calls": 0})
        entry = per_role.setdefault(
            role, {"tokens": 0, "remote_calls": 0, "activations": 0}
        )
        entry["tokens"] += row["tokens"]
        entry["remote_calls"] += row["remote_calls"]
        entry["activations"] += 1
    role_ok = all(
        entry["tokens"] <= workers[role]["budget"]["tokens"] * entry["activations"]
        and entry["remote_calls"]
        <= workers[role]["budget"]["remote_calls"] * entry["activations"]
        for role, entry in per_role.items()
    )
    check(
        "each role's tokens and remote calls stay within its budget per activation",
        role_ok,
        per_role,
    )
    if "observations.json" in files:
        observations = json.loads(files["observations.json"])
        hosts = sorted(
            {
                f"{o['kind']}:{o['url'].split('/')[2]}"
                for o in observations["observations"]
            }
        )
        declared_hosts = set(package.policy["network"]["allowed_domains"])
        allowed = all(
            (kind == "tool" and host in declared_hosts)
            or (kind == "model" and (model_hosts is None or host in model_hosts))
            for kind, host in (item.split(":", 1) for item in hosts)
        )
        check(
            "every recorded request went to the model's origin or a host the package declares",
            observations.get("recording") is True and allowed,
            hosts,
        )
    if reference is not None:
        reference_audit = json.loads((reference / "audit.json").read_text())
        mine = observed_walk(reference_audit)
        check(
            "the reference's fixture run takes the same walk with the same route decisions",
            mine["walk"] == seen["walk"] and mine["decisions"] == seen["decisions"],
            {"reference": mine["walk"], "chrome": seen["walk"]},
        )
        exported = [
            name for name in ("plan.json", "plan.txt") if (reference / name).exists()
        ]
        check(
            "the run's exports equal the reference's",
            bool(exported)
            and all(
                files.get(name) == (reference / name).read_bytes() for name in exported
            ),
            exported,
        )
    tightness = {
        name: (round(observed[name] / at_most[name], 3) if at_most[name] else None)
        for name in observed
    }
    passed = all(item["passed"] for item in checks)
    return {
        "package": {
            "archive": str(archive.relative_to(ROOT)),
            "digest": package.digest,
            "archive_sha256": archive_sha256,
        },
        "status": record["status"],
        "at_most": {
            k: at_most[k]
            for k in (
                "max_hops",
                "activations",
                "model_calls",
                "tool_calls",
                "compute_calls",
                "remote_calls",
                "tokens",
            )
        },
        "observed": {
            **observed,
            "activations": seen["activations"],
            "tool_calls": seen["tool_calls"],
            "model_reasks": seen["model_reasks"],
        },
        "tightness": tightness,
        "walk": seen["walk"],
        "decisions": seen["decisions"],
        "per_role": per_role,
        "checks": checks,
        "passed": passed,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument(
        "--report", type=Path, help="the headless harness's report (rewritten)"
    )
    source.add_argument(
        "--export", type=Path, help="a run export: the Runs page's zip, or a directory"
    )
    parser.add_argument(
        "--out", type=Path, help="write the result here (with --export)"
    )
    args = parser.parse_args()
    if args.report:
        report = json.loads(args.report.read_text())
        export = report.get("exportDirectory")
        ollama = (report.get("fakes") or {}).get("ollama")
        reference = report.get("referenceDirectory")
        if not export or not ollama or not reference:
            # A harness report written after an early failure names no export or fake.
            result = failed(
                "the harness report names an export, a reference and the fake model"
            )
        elif not (ROOT / export).exists():
            result = failed(f"the export directory exists: {export}")
        else:
            hosts = {
                ollama.split("//", 1)[-1]
            }  # a value without a scheme is the host itself
            result = verify(
                read_export(ROOT / export),
                reference=ROOT / reference,
                model_hosts=hosts,
            )
        report["network_verification"] = result
        report["passed_network"] = result["passed"]
        args.report.write_text(json.dumps(report, indent=2) + "\n")
    elif not args.export.exists():
        result = failed(f"the export exists: {args.export}")
    else:
        result = verify(read_export(args.export))
        if args.out:
            args.out.write_text(json.dumps(result, indent=2) + "\n")
    print(
        json.dumps(
            {
                k: result[k]
                for k in ("status", "at_most", "observed", "tightness", "passed")
                if k in result
            }
            | {
                "checks": [c for c in result["checks"] if not c["passed"]]
                or len(result["checks"])
            },
            indent=2,
        )
    )
    return 0 if result["passed"] else 1


if __name__ == "__main__":
    sys.exit(main())
