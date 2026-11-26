"""The framework sides of E2 and E3 (PROTOCOL.md §2.5 rule 7 widened, D-366, D-420).

Every side runs the same Agents SDK port (`agent.py`, `tools.py`): the package's tools as function
tools from the declared schemas, the skills and the host paragraph (rule 3), the answer step and
the tuning T-1…T-8 (TUNING.md), the schema check before the budget (T-5), our plan's budgets
(rule 9), the executor, the recorder and the record. They differ only in the defense around the
model and the tools:

- `FW` (`FW-declared` in prose): Progent's released checker with the policy written from the
  package's declaration, and rule 8's ask step before a write tool (T31, D-350). Unchanged, so that
  T32's local series pairs with the sides below.
- `FW-none`: no defense and no ask step: the attacks' strength.
- `FW-progent`: Progent's autonomous mode as its authors run it (`progent_auto.py`): the policy
  generated and updated by the rung's model, no ask step.
- `FW-filter`, `FW-detector`, `FW-spotlight`, `FW-repeat`: AgentDojo's four built-in defenses
  (`agentdojo.py`), each on `FW-none`, as AgentDojo applies them to its undefended pipeline.

None of the original configurations has a consent step, so only `FW` asks (D-421); the oracle is
the same for every side (rule 11).
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class Side:
    id: str
    progent: str | None  # "declared" (the committed policy), "auto" (generated), None
    ask: bool  # rule 8's ask step before a consequential tool
    defense: str | None = None  # one of AgentDojo's: filter, detector, spotlight, repeat
    source: str = ""  # where the configuration comes from, recorded in every manifest


SIDES: dict[str, Side] = {
    "FW": Side(
        "FW",
        progent="declared",
        ask=True,
        source="PROTOCOL.md §2.5 rules 7 and 8; D-350 (Progent b02783b, the declaration's policy)",
    ),
    "FW-none": Side("FW-none", progent=None, ask=False, source="D-366 (1), D-420: no defense"),
    "FW-progent": Side(
        "FW-progent",
        progent="auto",
        ask=False,
        source="Progent b02783b autonomous mode as agentdojo/run.sh runs it (D-420)",
    ),
    "FW-filter": Side(
        "FW-filter",
        progent=None,
        ask=False,
        defense="filter",
        source="AgentDojo v0.1.35 (a75aba7) tool_filter (D-420)",
    ),
    "FW-detector": Side(
        "FW-detector",
        progent=None,
        ask=False,
        defense="detector",
        source="AgentDojo v0.1.35 (a75aba7) transformers_pi_detector (D-420)",
    ),
    "FW-spotlight": Side(
        "FW-spotlight",
        progent=None,
        ask=False,
        defense="spotlight",
        source="AgentDojo v0.1.35 (a75aba7) spotlighting_with_delimiting (D-420)",
    ),
    "FW-repeat": Side(
        "FW-repeat",
        progent=None,
        ask=False,
        defense="repeat",
        source="AgentDojo v0.1.35 (a75aba7) repeat_user_prompt (D-420)",
    ),
}

FRAMEWORK_SIDES = tuple(SIDES)
# The sides T32b adds (D-423): they run WebAir's task sets only (TS-W, TS-C), never TS-N or TS-L.
NEW_SIDES = tuple(s for s in SIDES if s != "FW")


def is_framework(side: str) -> bool:
    return side in SIDES


def side(side_id: str) -> Side:
    try:
        return SIDES[side_id]
    except KeyError:
        raise ValueError(f"unknown framework side {side_id!r}") from None


def describe(side_id: str) -> dict:
    s = side(side_id)
    return {
        "id": s.id,
        "progent": s.progent,
        "ask": s.ask,
        "defense": s.defense,
        "source": s.source,
    }
