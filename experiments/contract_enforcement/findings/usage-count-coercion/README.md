# CE-1 — An invalid output-token count is charged as zero instead of refused

**Status:** confirmed product defect, **fixed** in production (see "Fix" below). `evidence.json`
is the pre-fix record; `evidence-after-fix.json` is the same reproduction on the fixed code.
**Found by:** `F8.usage_accounting` (variants `negative_count`, `negative_count_without_total`,
`string_count_without_total`), full system, qualification runs; reproduced in isolation by
[`reproduce.py`](reproduce.py), output in [`evidence.json`](evidence.json).
**Class:** resource governance — token accounting fails open on a malformed usage report.
**Threat-model scope:** in scope (A8, "providers misreport usage"; model responses that violate
their contract). The router itself treats the host's usage report as untrusted input and refuses
malformed counts; the defect is that one malformed form never reaches that check.

## What happens

When the model stack reports a completion's output-token count as a negative number or as a
non-number (and reports no total that would absorb the difference), the call's answer is used and
the run is charged only the call's input tokens:

| Call | Host report | Honest usage | Charged | Result |
|---|---|---|---|---|
| Meeting Agenda `plan` | `outputTokens: -5` | 477 | 435 | accepted |
| Meeting Agenda `plan` | `outputTokens: "42"`, no total | 477 | 435 | accepted |
| Literature Review `plan` | `outputTokens: -5` | 666 | 532 | accepted |
| Literature Review `plan` | `outputTokens: -5`, no total | 666 | 532 | accepted |
| Literature Review `plan` | `outputTokens: "134"`, no total | 666 | 532 | accepted |
| either | `outputTokens: 134.5` | — | — | refused, `model_usage_invalid` |
| either | no usage | — | — | refused, `model_usage_unavailable` |

(Honest usage is what the synthetic provider actually produced; see `evidence.json`.)

## Why

1. The plugin normalizes every usage field with `finite()`
   (`openclaw-agent-browser/src/host-llm.ts`), which maps a negative or non-numeric value to
   `null`, i.e. "not reported".
2. The router's `project_usage` (`agentpkg/src/agentpkg/hostbridge/router.py`) reads a missing
   count as `0` (`usage.get("output_tokens", 0) or 0`). Its own `_count` would refuse a negative or
   non-integer count as `model_usage_invalid`, but it never sees one; only a reported total larger
   than the breakdown restores the missing output tokens.
3. `Runtime.call_model` then charges `input + 0`, which is a valid, non-overrunning count, so the
   call completes and the run continues.

The runtime's stated policy for usage it cannot know is the opposite ("Unknown usage/errors
consume reservation conservatively"), and an over-report is halted; only this under-report path
is accepted.

## Impact

Bounded but real: a model stack that misreports output usage in this form makes those output
tokens free against the run's token budgets (global, per worker), so later reservations are
checked against an undercount. Authorization, mediation and integrity are unaffected; the
per-call reservation (input bound plus the declared output cap) is still enforced before
dispatch.

## Root cause, independently confirmed

Two gaps, not one. OpenClaw 2026.9.5's own `normalizeUsage` (trusted host) hands the plugin every
bucket either absent or as a non-negative integer. Inside WebAgents:

1. the plugin's `finite()` folded a *present but malformed* bucket into `null`, i.e. into
   "not reported", so the router's `_count` never saw the malformed value; and
2. the router's `project_usage` read an *absent* count as `0`, so even a legitimately absent
   output count with no aggregate total under-charged the call.

## Fix

* `openclaw-agent-browser/src/host-llm.ts`: each bucket is read three ways. Absent (`undefined`
  or `null`) stays `null`; a non-negative safe integer (cost: a non-negative finite number) passes
  unchanged; anything else is refused as `model_usage_invalid`, naming only the field.
  `model_usage_invalid` was added to the plugin's error codes (`contract.ts`).
* `agentpkg/src/agentpkg/hostbridge/router.py`: a reported count is validated (as before); an
  unreported one is not zero. The charge must be established by an aggregate total or by both
  input and output counts, or the call is refused as `model_usage_unavailable`.
* Either refusal makes `Runtime.call_model` charge the call's whole reservation (unchanged).
* Contract documented in `docs/model-router-bridge.md` ("Actual usage").

Regression tests: `openclaw-agent-browser/test/host-llm.test.ts` (16), and in agentpkg
`tests/test_hostbridge_router.py` (17) and `tests/test_runtime.py` (2).

## Consequence for the experiment

Before the fix this was a full-system `SILENT_VIOLATION` within the stated threat model and
blocked the paper run. After the fix, with the case catalog unchanged (same catalog and
calibration hashes), every `F8.usage_accounting` violation is explicitly blocked
(`model_usage_invalid`) and every control accepted.
