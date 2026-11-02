"""Family V · Consent integrity (D-300; spec/conversation-v0.md §10, V-9, V-12, V-13; D-274).

Guarantee: a consented permission's tool runs only after an accepted step for that permission in
this turn; `once` is spent once per conversation; the turn cap and the conversation's budgets
hold; the facts on the card, not the model's sentence, are what the tool receives.

Variants: the 38 negative and 5 control cases of `examples/conversation/cases/cases.json` (the two
consent-host cases a CLI cannot express included: the drivers install a silent or an invalid
consent host), plus the T24 design-note case: the model's sentence disagrees with the graph's
facts on the card (D-274). Boundaries: a gated tool dispatched in a turn whose consent steps did
not accept each of its gated permissions (`gated_tool_unconsented`, from the consent seam's own
record of the person's answers); a second use of `once` or a tool past its conversation cap
(`tool_called`); a turn started past the cap or the budget (`turn_ran`); a card shown with a
non-string sentence; a persisted state the conversation's schema refuses; a tool that ran with
arguments other than the card's facts (`card_facts_differ`); or the admission boundary.
"""

from __future__ import annotations

from .base import Case

FAMILY = "V"
CONTROL = "V.two-turns-one-consent"
TOOL = "place"

ADMISSION = {
    "conversation-source-outside",
    "minimum-version",
    "state-schema-undeclared",
    "state-schema-open",
    "state-key-undeclared",
    "initial-not-literal",
    "initial-invalid",
    "budget-below-turn",
    "tool-cap-unknown",
    "consent-on-worker",
    "consent-permission-unknown",
    "consent-permission-kind",
    "consent-decision-schema",
    "consent-otherwise-accepts",
    "fixture-step-unknown",
    "fixture-too-many-turns",
    "fixture-message-invalid",
    "fixture-input-mismatch",
}


def _gate(permissions=("orders.place",)):
    return {
        "class": "effect",
        "predicate": "gated_tool_unconsented",
        "tool": TOOL,
        "permissions": list(permissions),
    }


def _spec(case: dict) -> dict:
    cid, stage, code = case["id"], case["stage"], case.get("code")
    if cid in ADMISSION:
        return {
            "expected": {"stage": stage, "code": code},
            "boundary": {"class": "admission", "predicate": "executed"},
            "guard": "conversation and consent declarations",
            "primary_ablation": "decl_validation",
        }
    table = {
        "consent-outside-conversation": (
            {"stage": stage, "code": code},
            _gate(),
            "consent declarations (a step outside a conversation)",
            "decl_validation",
        ),
        "tool-before-consent": (
            {"stage": stage, "code": code},
            _gate(),
            "consent declarations (the tool depends on its step)",
            "decl_validation",
        ),
        "write-tool-ungated": (
            {"stage": stage, "code": code},
            _gate(),
            "consent declarations (a write tool is gated)",
            "decl_validation",
        ),
        "transcript-step-unknown": (
            {"stage": stage, "code": code},
            {"class": "admission", "predicate": "executed"},
            "transcript against the plan",
            "consent_gate",
        ),
        "transcript-accepts-denied": (
            {"stage": stage, "code": code},
            {"class": "effect", "predicate": "tool_called", "tool": TOOL},
            "transcript against the plan (an accepted step for a denied permission)",
            "consent_gate",
        ),
        "transcript-message-invalid": (
            {"stage": stage, "code": code},
            {"class": "admission", "predicate": "executed"},
            "transcript message schema",
            None,
        ),
        "run-refused": (
            {"stage": stage, "code": code},
            {"class": "admission", "predicate": "executed"},
            "one-shot CLI refuses a conversation",
            None,
        ),
        "host-refused": (
            {"stage": stage, "code": code},
            {"class": "admission", "predicate": "executed"},
            "one-shot execution host refuses a conversation",
            None,
        ),
        "turn-beyond-cap": (
            {"stage": stage, "code": case.get("reason")},
            {"class": "effect", "predicate": "turn_ran", "turn": 2},
            "conversation turn cap",
            "conversation_bounds",
        ),
        "conversation-tokens-exhausted": (
            {"stage": stage, "code": case.get("reason")},
            {"class": "effect", "predicate": "turn_ran", "turn": 2},
            "conversation token budget",
            "conversation_bounds",
        ),
        "conversation-remote-exhausted": (
            {"stage": stage, "code": case.get("reason")},
            {"class": "effect", "predicate": "turn_ran", "turn": 2},
            "conversation remote-call budget",
            "conversation_bounds",
        ),
        "consent-text-not-string": (
            {"stage": stage, "code": code, "node": "confirm"},
            {"class": "effect", "predicate": "consent_text_not_string"},
            "consent step's sentence is a string",
            None,
        ),
        "tool-after-denied-consent": (
            {"stage": stage, "code": code, "reason": case.get("reason"), "node": TOOL},
            _gate(),
            "V-9 consent gate",
            "consent_gate",
        ),
        "tool-after-skipped-consent": (
            {"stage": stage, "code": code, "reason": case.get("reason"), "node": TOOL},
            _gate(),
            "V-9 consent gate",
            "consent_gate",
        ),
        "consent-undecided": (
            {
                "stage": stage,
                "code": code,
                "block_event": {
                    "action": "consent.decided",
                    "fields": {"accepted": False, "decided_by": "host"},
                },
            },
            _gate(),
            "V-12 host default-deny",
            None,
        ),
        "state-outside-schema": (
            {"stage": stage, "code": code},
            {
                "class": "effect",
                "predicate": "persisted_contains",
                "key": "history",
                "needle": '"extra"',
            },
            "V-5 conversation state schema",
            None,
        ),
        "once-across-turns": (
            {
                "stage": stage,
                "code": code,
                "block_event": {
                    "action": "consent.decided",
                    "fields": {"accepted": False, "decided_by": "plan"},
                },
            },
            {"class": "effect", "predicate": "tool_called", "tool": TOOL, "more_than": 1},
            "V-13 once spent per conversation",
            "consent_gate",
        ),
        "once-spent-tool-reached": (
            {"stage": stage, "code": code, "node": TOOL},
            {"class": "effect", "predicate": "tool_called", "tool": TOOL, "more_than": 1},
            "V-13 once spent per conversation",
            "consent_gate",
        ),
        "tool-cap-across-turns": (
            {"stage": stage, "code": code, "node": TOOL},
            {"class": "effect", "predicate": "tool_called", "tool": TOOL, "more_than": 1},
            "per-conversation tool cap",
            "conversation_bounds",
        ),
        "consent-timeout": (
            {"stage": stage, "code": code, "node": "confirm"},
            _gate(),
            "consent step's timeout",
            None,
        ),
        "consent-host-invalid": (
            {"stage": stage, "code": code, "reason": "consent_decision_invalid", "node": "confirm"},
            _gate(),
            "consent decision contract",
            None,
        ),
        "two-steps-one-accepted": (
            {"stage": stage, "code": code, "reason": case.get("reason"), "node": TOOL},
            _gate(("orders.place", "orders.charge")),
            "V-9 consent gate, per permission",
            "consent_gate",
        ),
    }
    expected, boundary, guard, ablation = table[cid]
    return {
        "expected": {k: v for k, v in expected.items() if v is not None},
        "boundary": boundary,
        "guard": guard,
        "primary_ablation": ablation,
    }


def _timeout_one_second(files):
    """The consent step's own timeout bounds the silent host's wait (1 s, as the unit suites)."""
    for node in files["graph.json"]["nodes"]:
        if node["type"] == "consent":
            node["timeout_seconds"] = 1


def _sentence_disagrees(files):
    """T24 design note (D-274): the model's sentence for `order A` names another show, another
    quantity and a price, while the graph's facts (show, quantity) stay Show A × 1."""
    for case in files["fixtures/workflow.json"]["models"]["interpret"]:
        if case["input"].get("text") == "order A":
            case["output"]["reply"] = "Order two tickets to Show B for $100?"


def cases() -> list[Case]:
    from harness_v2.packages import driver, probe

    conversation = driver("conversation")
    module = probe("conversation")
    out: list[Case] = []
    for case in conversation.CASES:
        control = case["id"] in {
            "two-turns-one-consent",
            "consent-denied-path",
            "two-steps-two-permissions",
        }
        spec = {} if control else _spec(case)
        mode = "converse"
        if case.get("path") == "run":
            mode = "run"
        elif case["stage"] == "host":
            mode = "execution_layer"
        extra, extra_name = None, None
        if case.get("host") == "silent":
            extra, extra_name = _timeout_one_second, "consent step timeout 1 s"
        matched = None
        if not control:
            matched = (
                "V.two-steps-two-permissions" if case.get("variant") == "two-steps" else CONTROL
            )
        out.append(
            Case(
                id=f"V.{case['id']}",
                family=FAMILY,
                kind="control" if control else "violation",
                title=case["title"],
                origin=f"examples/conversation/cases/cases.json#{case['id']}",
                source={"probe": "conversation", "case": case},
                mode=mode,
                grants=module.grants(**case.get("grants", {})),
                approve=(TOOL,),
                expected=spec.get("expected", {"stage": "run", "code": "completed"}),
                boundary=spec.get("boundary", {}),
                guard=spec.get("guard", "none (control)"),
                primary_ablation=spec.get("primary_ablation"),
                matched_control=matched,
                limits=case.get("limits"),
                transcript=conversation.transcript_of(case),
                consent_host=case.get("host"),
                extra=extra,
                extra_name=extra_name,
            )
        )
    base = next(c for c in conversation.CASES if c["id"] == "two-turns-one-consent")
    out.append(
        Case(
            id="V.card-sentence-disagrees",
            family=FAMILY,
            kind="violation",
            title=(
                "T24 design note: the model's sentence on the card disagrees with the graph's "
                "facts; the tool receives the facts and the record holds both"
            ),
            origin="T24 review 1 carry-over (D-274): catalog v2 row",
            source={"probe": "conversation", "case": base},
            mode="converse",
            grants=module.grants(),
            approve=(TOOL,),
            expected={
                "stage": "run",
                "code": "completed",
                "block_event": {"action": "consent.decided", "fields": {"accepted": True}},
            },
            boundary={"class": "effect", "predicate": "card_facts_differ", "tool": TOOL},
            guard="the card's facts are the graph's constructed input (D-274)",
            primary_ablation=None,
            matched_control=CONTROL,
            transcript=conversation.transcript_of(base),
            extra=_sentence_disagrees,
            extra_name="model sentence disagrees with the facts",
        )
    )
    return out
