"""The conformance suite's driver for the reference's execution session handed a caller's plan with
its links (T66; link.v0 L-15, the cases of the stage `host`): the probe composition planned through
the control plane, its inner plans leased and handed to a runner as `agentpkg/tests/test_link_execution.py`
does, and each case's plans changed as that test changes them. Prints one JSON list of outcomes,
`{outcome, code, message}`, which `drivers/link-session.ts` prints for the Chrome core's session:

    agentpkg/.venv/bin/python conformance/drivers/link_session.py <case-id> <work-dir>

`inner-plan-replay` (N-34): the inner plan of `index` under another dependency, under another
caller's digest, with another hash, and `scribe`'s plan handed over as `index`'s.
`inner-plan-alone` (N-54): each linked package's inner plan handed over as a run's own plan.
`linked-compute` (a control on N-52's composition, T66 review 1): the plans unchanged, a linked
package with a compute node, run from the Run Plans on a host with a compute engine; accepted and
completed, with the status and the compute calls (the caller's and each link's).
"""

from __future__ import annotations

import asyncio
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "agentpkg" / "tests"))
sys.path.insert(0, str(ROOT / "agentpkg" / "src"))

from agentpkg.signing import keygen  # noqa: E402
from test_link_execution import Composition  # noqa: E402


def outcome(begin) -> dict:
    if isinstance(begin, BaseException):
        return {"outcome": "refused", "code": getattr(begin, "code", None), "message": str(begin)}
    return {"outcome": "accepted"}


def main() -> None:
    case_id, work = sys.argv[1], Path(sys.argv[2])
    work.mkdir(parents=True, exist_ok=True)
    keys = {}
    for name in ("default", "index", "scribe", "helper"):
        keys[name] = (work / "keys" / f"{name}.private.pem", work / "keys" / f"{name}.pub.pem")
        keys[name][0].parent.mkdir(exist_ok=True)
        keygen(*keys[name])
    variant = "linked-compute" if case_id == "linked-compute" else None
    composition = Composition(work / "composition", keys, variant)
    outcomes = []
    if case_id == "linked-compute":
        begin, result, *_ = asyncio.run(composition.run())
        answer = outcome(begin)
        if result is not None:
            usage = result.get("usage", {})
            answer |= {
                "status": result.get("status"),
                "compute_calls": usage.get("compute_calls"),
                "link_compute_calls": {
                    name: entry.get("compute_calls")
                    for name, entry in sorted(usage.get("links", {}).items())
                },
            }
        outcomes.append(answer)
    elif case_id == "inner-plan-replay":

        def changed(mutate):
            links = composition.links_params()
            mutate(links)
            return links

        for mutate in (
            lambda links: links["index"]["run_plan"]["parent"].update(dependency="scribe"),
            lambda links: links["index"]["run_plan"]["parent"].update(package_digest="0" * 64),
            lambda links: links["index"]["run_plan"].update(run_plan_sha256="0" * 64),
            lambda links: links.update(index=links["scribe"]),
        ):
            begin, *_ = asyncio.run(composition.run(links=changed(mutate)))
            outcomes.append(outcome(begin))
    elif case_id == "inner-plan-alone":
        for name in ("index", "scribe"):
            begin, *_ = asyncio.run(composition.run_alone(name))
            outcomes.append(outcome(begin))
    else:
        raise SystemExit(f"unknown host case {case_id}")
    print(json.dumps(outcomes, indent=2))


if __name__ == "__main__":
    main()
