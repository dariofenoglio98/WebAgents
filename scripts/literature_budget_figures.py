"""Literature Review budget figures (T15, D-173): per model step, the largest reservation and charge
of any recorded attempt, the "two re-asks" need (2 x charge + reservation) and three times the
slowest attempt, from the hash-chained audits of recorded runs.

    agentpkg/.venv/bin/python scripts/literature_budget_figures.py AUDIT.json [AUDIT.json ...]

D-173 used every Literature Review run recorded on the development host: examples/my-t10-accept/*/
(T10, 0.2.6), examples/my-chrome-lit-local-2026-10-08c/ (T6, qwen3:30b), the user's exports of
2026-10-09 and examples/my-t15/runs/*/ and examples/my-t15/harness-doc-2/ (T15, 0.2.7); those
directories are git-ignored run data.
"""

import json
import sys
from datetime import datetime
from pathlib import Path

ROLE = {
    "plan": "PlanningWorker",
    "normalize": "PlanningWorker",
    "screen": "ScreeningWorker",
    "select": "ScreeningWorker",
    "extract": "EvidenceWorker",
    "synthesize": "SynthesisWorker",
    "write": "WritingWorker",
    "verify": "VerificationWorker",
}


def ts(e):
    return datetime.fromisoformat(e["timestamp"].replace("Z", "+00:00"))


stats = {}
for path in sys.argv[1:]:
    audit = json.loads(Path(path).read_text())
    audit = audit if isinstance(audit, list) else audit.get("events", [])
    pending = {}
    for e in audit:
        if e["action"] == "model.called":
            pending[e.get("worker")] = e
        elif e["action"] in ("model.completed", "model.failed"):
            c = pending.pop(e.get("worker"), None)
            if not c:
                continue
            task = c.get("task")
            st = stats.setdefault(
                task,
                {"reserved": (0, ""), "charged": (0, ""), "seconds": (0, ""), "n": 0},
            )
            st["n"] += 1
            for key, value in (
                ("reserved", c.get("reserved_tokens") or 0),
                ("charged", e.get("tokens") or e.get("tokens_charged") or 0),
                ("seconds", (ts(e) - ts(c)).total_seconds()),
            ):
                if value > st[key][0]:
                    st[key] = (value, path.split("/")[-2])
out = {}
for task, st in stats.items():
    need = 2 * st["charged"][0] + st["reserved"][0]
    out[task] = {
        "role": ROLE[task],
        "attempts": st["n"],
        "max_reserved": st["reserved"],
        "max_charged": st["charged"],
        "two_reasks_need": need,
        "max_attempt_s": (round(st["seconds"][0], 1), st["seconds"][1]),
        "three_attempts_s": round(3 * st["seconds"][0]),
    }
print(json.dumps(out, indent=1))
roles = {}
for task, v in out.items():
    roles[v["role"]] = max(roles.get(v["role"], 0), v["two_reasks_need"])
print(json.dumps(roles, indent=1))
