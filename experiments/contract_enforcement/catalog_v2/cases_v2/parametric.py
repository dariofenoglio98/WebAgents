"""Parametric templates (D-300; T27 §1): a bound drawn around what the probe's run needs.

Six templates, each drawing its values from the run's seed (`random.Random(f"{seed}:{template}")`),
the same values for both runtimes and every profile. A value below the need is a violation of the
template's bound; a value at or above it is a control that must complete. With two or more draws a
template always has one value on each side of its threshold.

- `compute-pages`: the host's `compute_memory_pages` around the 16 pages echo declares; below,
  the run is refused before it starts (never lowered); at or above, it runs.
- `compute-time`: a node's `limits.wall_seconds` (0.2-1.0 s); a module that never returns is
  stopped at its bound (violation); `echo` under the same bound completes (control).
- `conversation-tokens`: the host's `conversation_total_tokens` around 4,218, what two `hello`
  turns need; below, turn 2 is refused.
- `conversation-turns`: the host's `conversation_max_turns` around 3 (`hello`, `hello`, `done`);
  below, turn `cap + 1` is refused (the domain 1-4 has four values).
- `network-cap`: the network's `max_hops` (the walk needs 4), Desk -> Lookup `max_uses` (a walk
  with two lookups needs 2) or Desk's `max_activations` (3); below, the walk is refused at the cap.
- `agent-write`: an agent document body around 32,768 characters; above, the write is refused.

The thresholds are the probes' own figures; `tests/test_parametric.py` checks them on the
reference runtime (one value at the need completes, one below is refused).
"""

from __future__ import annotations

import random

from .base import Case

COMPUTE_GRANTS = {"memory.session": "session", "compute.modules": "session"}
TOKENS_NEED = 4218
TURNS_NEED = 3
PAGES_NEED = 16
AGENT_CAP = 32768


def _draw(seed: int, template: str, n: int, low, high, need, *, integer=True, step=None):
    """`n` distinct values in [low, high], at least one below `need` and one at or above it."""
    rng = random.Random(f"{seed}:{template}")
    if integer:
        pool_below = list(range(low, need))
        pool_above = list(range(need, high + 1))
    else:
        values = [round(low + i * step, 3) for i in range(int(round((high - low) / step)) + 1)]
        pool_below = [v for v in values if v < need]
        pool_above = [v for v in values if v >= need]
    chosen: list = []
    if n >= 1:
        chosen.append(rng.choice(pool_below))
    if n >= 2:
        chosen.append(need if need in pool_above else rng.choice(pool_above))
    rest = [v for v in pool_below + pool_above if v not in chosen]
    rng.shuffle(rest)
    chosen.extend(rest[: max(0, n - len(chosen))])
    return chosen


def _compute_pages(seed, n):
    from harness_v2.packages import driver

    base = next(c for c in driver("compute").CASES if c["id"] == "echo")
    out = []
    for value in _draw(seed, "compute-pages", n, 4, 40, PAGES_NEED):
        violation = value < PAGES_NEED
        out.append(
            Case(
                id=f"C.param.compute-pages-{value}",
                family="C",
                kind="violation" if violation else "control",
                title=f"Host page ceiling {value} for a module that declares {PAGES_NEED} pages",
                origin="parametric template compute-pages",
                source={"probe": "compute", "case": base},
                mode="run",
                grants=dict(COMPUTE_GRANTS),
                approve=(),
                limits={"compute_memory_pages": value},
                expected={"stage": "admission", "code": "execution_compute_limit_exceeded"}
                if violation
                else {"stage": "run", "code": "completed"},
                boundary={"class": "effect", "predicate": "module_ran"} if violation else {},
                guard="host page ceiling (refused, never lowered)" if violation else "none",
                primary_ablation="compute_limits" if violation else None,
                matched_control=None if not violation else "C.echo",
                parametric={"template": "compute-pages", "value": value, "need": PAGES_NEED},
            )
        )
    return out


def _compute_time(seed, n):
    from harness_v2.packages import driver

    by_id = {c["id"]: c for c in driver("compute").CASES}
    rng = random.Random(f"{seed}:compute-time:kind")
    values = _draw(seed, "compute-time", n, 0.2, 1.0, 0.6, integer=False, step=0.1)
    out = []
    for index, value in enumerate(values):
        # One runaway and one conforming module per pair of draws, then the seed decides.
        violation = index == 0 or (index > 1 and rng.random() < 0.5)
        base = dict(by_id["deadline" if violation else "echo"])
        base["node_limits"] = {"wall_seconds": value, "fuel": 1_000_000_000_000}
        base["id"] = f"param-time-{'loop' if violation else 'echo'}-{value}"
        out.append(
            Case(
                id=f"C.param.compute-time-{'loop' if violation else 'echo'}-{value}",
                family="C",
                kind="violation" if violation else "control",
                title=f"A wall bound of {value} s on a "
                + ("module that never returns" if violation else "conforming module"),
                origin="parametric template compute-time",
                source={"probe": "compute", "case": base},
                mode="run",
                grants=dict(COMPUTE_GRANTS),
                approve=(),
                expected={
                    "stage": "run",
                    "code": "compute_error",
                    "reason": "deadline",
                    "node": "compute",
                }
                if violation
                else {"stage": "run", "code": "completed"},
                boundary={
                    "class": "effect",
                    "predicate": "compute_overran",
                    "ms": int(value * 1000) + 4000,
                }
                if violation
                else {},
                guard="wall bound of a call" if violation else "none",
                primary_ablation="compute_limits" if violation else None,
                matched_control="C.echo" if violation else None,
                parametric={"template": "compute-time", "value": value, "need": None},
            )
        )
    return out


def _conversation(seed, n, template):
    from harness_v2.packages import driver, probe

    conversation, module = driver("conversation"), probe("conversation")
    base = next(c for c in conversation.CASES if c["id"] == "two-turns-one-consent")
    if template == "conversation-tokens":
        values = _draw(seed, template, n, 2400, 6000, TOKENS_NEED)
        turns, need, key, reason = (
            ["hello", "hello"],
            TOKENS_NEED,
            "conversation_total_tokens",
            ("conversation_budget_exhausted"),
        )
    else:
        values = _draw(seed, template, n, 1, 4, TURNS_NEED)
        turns, need, key, reason = (
            ["hello", "hello", "done"],
            TURNS_NEED,
            ("conversation_max_turns"),
            "conversation_turn_limit",
        )
    out = []
    for value in values:
        violation = value < need
        refused_turn = 2 if template == "conversation-tokens" else value + 1
        out.append(
            Case(
                id=f"V.param.{template}-{value}",
                family="V",
                kind="violation" if violation else "control",
                title=f"Host {key} = {value} for a conversation that needs {need}",
                origin=f"parametric template {template}",
                source={"probe": "conversation", "case": base},
                mode="converse",
                grants=module.grants(),
                approve=("place",),
                limits={key: value},
                transcript=module.transcript(*turns),
                expected={"stage": "turn", "code": reason}
                if violation
                else {
                    "stage": "run",
                    "code": "completed",
                },
                boundary={"class": "effect", "predicate": "turn_ran", "turn": refused_turn}
                if violation
                else {},
                guard="conversation " + ("token budget" if "tokens" in template else "turn cap")
                if violation
                else "none",
                primary_ablation="conversation_bounds" if violation else None,
                matched_control="V.two-turns-one-consent" if violation else None,
                parametric={"template": template, "value": value, "need": need},
            )
        )
    return out


def _network_cap(seed, n):
    from harness_v2.packages import driver, probe

    module = probe("network")
    base = next(c for c in driver("network").CASES if c["id"] == "fixture-walk")
    two = next(c for c in driver("network").CASES if c["id"] == "two-lookups")
    kinds = {
        "hops": (2, 7, 4),
        "edge": (1, 3, 2),
        "role": (1, 5, 3),
    }
    rng = random.Random(f"{seed}:network-cap:kind")
    out = []
    order = ["hops", "edge", "role"]
    drawn = []
    for index in range(n):
        kind = order[index % 3] if index < 3 else rng.choice(order)
        drawn.append(kind)
    counts = {kind: drawn.count(kind) for kind in order}
    for kind in order:
        if not counts[kind]:
            continue
        low, high, need = kinds[kind]
        for value in _draw(seed, f"network-cap-{kind}", counts[kind], low, high, need):
            violation = value < need

            def pre(members, kind=kind, value=value):
                network = members["graph.json"]["network"]
                if kind == "hops":
                    network["max_hops"] = value
                elif kind == "edge":
                    network["roles"]["Desk"]["edges"][0]["max_uses"] = value
                else:
                    network["roles"]["Desk"]["max_activations"] = value

            source_case = two if kind == "edge" else base
            out.append(
                Case(
                    id=f"N.param.network-{kind}-{value}",
                    family="N",
                    kind="violation" if violation else "control",
                    title=f"The network's {kind} cap at {value} for a walk that needs {need}",
                    origin="parametric template network-cap",
                    source={"probe": "network", "case": source_case},
                    mode="run",
                    grants=module.grants(),
                    approve=("lookup",),
                    # The hop and the Desk → Lookup edge are routes the model chooses
                    # (`model_error`); Desk's third activation comes by a fixed return route,
                    # refused as a fixed route past its cap is (`budget_exhausted`).
                    expected={
                        "stage": "run",
                        "code": "budget_exhausted" if kind == "role" else "model_error",
                        "reason": {
                            "hops": "hops_exhausted",
                            "edge": "edge_exhausted",
                            "role": "role_exhausted",
                        }[kind],
                        "node": "delegate",
                    }
                    if violation
                    else {"stage": "run", "code": "completed"},
                    boundary={"class": "effect", "predicate": "beyond_envelope"}
                    if violation
                    else {},
                    guard=f"network {kind} cap" if violation else "none",
                    primary_ablation="transition_check" if violation else None,
                    matched_control="N.fixture-walk" if violation else None,
                    pre=pre,
                    pre_name=f"network {kind} cap = {value}",
                    parametric={
                        "template": "network-cap",
                        "kind": kind,
                        "value": value,
                        "need": need,
                    },
                )
            )
    return out


def _agent_write(seed, n):
    from harness_v2.packages import probe

    module = probe("memory")
    out = []
    for value in _draw(seed, "agent-write", n, 24000, 40000, AGENT_CAP + 1):
        violation = value > AGENT_CAP

        def extra(files, value=value, violation=violation):
            notes = "x" * value
            fixture = files["fixtures/workflow.json"]
            fixture["models"]["remember"][0]["output"]["notes"] = notes
            if not violation:
                # The replayed answer of the write; an over-cap body has none (the loader checks
                # a fixture's tool inputs against the tool's schema, as N4 leaves it).
                fixture["tools"]["notes-write"] = [
                    {"input": {"body": notes}, "output": {"staged": True, "bytes": value}}
                ]
            files["graph.json"]["nodes"][3]["max_output_tokens"] = 16000
            files["graph.json"]["workers"][2]["budget"]["tokens"] = 60000
            files["policy/policy.json"]["budget"]["hard_tokens"] = 120000

        out.append(
            Case(
                id=f"M.param.agent-write-{value}",
                family="M",
                kind="violation" if violation else "control",
                title=f"An agent document body of {value} characters (cap {AGENT_CAP})",
                origin="parametric template agent-write",
                source={"probe": "memory", "variant": "fixture"},
                mode="run",
                grants=module.grants(),
                approve=tuple(sorted(module.TOOLS)),
                expected={"stage": "run", "code": "schema_validation", "node": "notes-write"}
                if violation
                else {"stage": "run", "code": "completed"},
                boundary={
                    "class": "effect",
                    "predicate": "tool_payload_longer",
                    "tool": "notes-write",
                    "field": "body",
                    "length": AGENT_CAP,
                }
                if violation
                else {},
                guard="agent write input bound (tool input schema)" if violation else "none",
                primary_ablation=None,
                matched_control="M.fixture" if violation else None,
                extra=extra,
                extra_name=f"agent document body of {value} characters",
                parametric={"template": "agent-write", "value": value, "need": AGENT_CAP},
            )
        )
    return out


TEMPLATES = (
    "compute-pages",
    "compute-time",
    "conversation-tokens",
    "conversation-turns",
    "network-cap",
    "agent-write",
)


def cases(seed: int, per_template: int) -> list[Case]:
    if per_template <= 0:
        return []
    return [
        *_compute_pages(seed, per_template),
        *_compute_time(seed, per_template),
        *_conversation(seed, per_template, "conversation-tokens"),
        *_conversation(seed, per_template, "conversation-turns"),
        *_network_cap(seed, per_template),
        *_agent_write(seed, per_template),
    ]
