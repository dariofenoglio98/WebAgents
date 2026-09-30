# Meeting Agenda 0.2.2 diagnosis and acceptance

Both requested live runs passed through the installed Agent Browser gateway.
No OpenAI API key was requested or configured, no model fallback was used, and
no authentication/provider settings were changed. Nothing was committed or pushed.

## 1. Root cause and exact failed operands

The matching failed run is `run_2080d87f2ac44bd18e4801a4c3e98ffb`, package 0.2.1,
digest `d7884667cf10c47f73d66cff4381f39a914a9c24da3333b09b533ab19d2d7a99`.
Its five successful Qwen calls are followed by `validate` assertion **index 0**:

- Left: `/agenda/goal`, supplied by the writer model.
- Right: `/request/goal`, copied from input.

The exact right-hand value, with JSON escapes showing the embedded line breaks, is:

```json
"Agree on the final set of experiments and paper revisions required before\nsubmission, identify the highest-priority remaining tasks, and leave the meeting\nwith a concrete action plan."
```

The exact left-hand string is **not recoverable from these artifacts**. The failed
`result.json` contains status, audit, usage, and provenance, but no output or state.
The audit retains the writer result hash, not its text; session memory was cleared.
Thus the evidence proves unequal goal strings, but cannot distinguish paraphrasing
from whitespace changes or another text change. Claiming a particular returned
string would invent evidence. The earlier local run `run_f84c7586fe0d440f8ea06964497d5a94`
also failed goal assertion 0.

The design fault is asking the model to regenerate authoritative input that a later
assertion requires to be identical. The observed failure was **not** the duration
equality or the sum assertion; execution stopped before checking them.

[Machine-readable diagnosis and signature evidence](../examples/verification/meeting-agenda-022-evidence.json).

## 2. Why the failed invocation contained 15

The record contains numeric `duration: 15`. Recomputing its RFC 8785 input hash
matches `run.json.inputSha256`. Replacing 15 with 25 does not match. Independently,
the audit's planner worker input hash matches the request containing 15. The
85-event audit chain verifies.

The form converts numeric text with `Number`, maintains current task state, and
clones that value at submission. The invocation serializer canonicalizes and hashes
it; it has no duration substitution. The schema has no duration default. Tests
cover editing 15 to 25 or 37, rerendering, switching JSON/form views, submitting,
and canonical invocation hashing without changing the entered number.

Consequently **15 reached the host and model**; serialization did not change 25
into 15. These artifacts do not capture keystrokes or the DOM at submission, so
whether the person entered 15 intentionally, left it in the form, or encountered
some unrecorded client behavior cannot be established. No duration-conversion bug
was found, and the record was not rewritten to say 25.

A separate reproducible UI bug was found and fixed: an unchanged-input event
(such as switching editing modes) cancelled a pending validation timer before
returning early. This left Run disabled in “Checking…” indefinitely. Checking
for an unchanged value before cancelling its timer fixes that behavior. It does
not explain a numeric 25-to-15 conversion.

## 3. Fix and preserved validation

The signed graph now:

1. Asks the planner only for focus items; perspective workers iterate directly
   over the supplied participants. The model can no longer alter worker membership.
2. Asks the writer for a draft, without goal or duration fields.
3. Uses a structural `assemble` node to copy the exact input goal and duration,
   preserve content, and deterministically apportion the draft minutes.
4. Executes the **three unchanged final assertions**: goal equality, duration
   equality, and the sum of item minutes equalling the requested duration.

The existing `workflow.v0` constructors, map, join, and checked projections could
copy data but could not calculate integer allocations. A single generic `allocate`
constructor supplies that missing operation, with no package ID, task name, or
Meeting Agenda branch in the runtime. Both operands undergo the existing scope
and state-read checks. It accepts 1–256 rows with positive integer weights and a
bounded feasible integer total. It reserves one unit per row, apportions the
remainder by weight using largest remainders with stable ordering, and preserves
all other fields. Already exact allocations remain unchanged. Impossible totals,
invalid weights, booleans, and fractions fail closed. Integer-valued JSON numbers
such as `25.0` follow JSON Schema integer semantics.

The draft schema limits topics to ten, so every allowed duration (10–240) can give
each topic at least one minute. The skill asks for feasible, focused topics and
relative estimates, not exact arithmetic. Meaning and prioritization remain model
responsibilities; exact copying and total allocation are deterministic.

No validator was removed or weakened. Regression tests inject corrupt final goals,
durations, and minute totals; all are rejected. A real interpreter test bypasses
assembly's allocation to prove a mismatched final agenda still fails at `validate`.

## 4. Versioning and signatures

Meeting Agenda **0.2.1 is preserved byte for byte** as
`dist/meeting-agenda-0.2.1.agent.pkg`; its archive hash is
`e4c499f034b110ef2eca5aeecc87bc9336f6626e55b217d0fb087392ff120e35`.
The current source and `dist/meeting-agenda.agent.pkg` now represent **0.2.2**.
The new versioned archive is [meeting-agenda-0.2.2.agent.pkg](../dist/meeting-agenda-0.2.2.agent.pkg).
The generic runtime version and package minimum are 0.2.2 because `allocate` is new.
The archive format and execution profile remain unchanged.

- Package digest: `dbd2eb816bb8687d4a5b3448f5b82bc0716c3884f9fee8a2c578af0c5e894679`
- Archive SHA-256: `7b148e845c0f9e38d752a51a8d0b60a314842a3de3a2723b3bdf1a0c041921e1`
- Ed25519 signer: `sha256:2bcc374a7fe18e50622042b7d0375fcb24eb3607879a236f9f3c3ede1922c5c4`
- Signature: `Qi88x7wnlAs4UEJo8Eb0GdbXQlY+SZxB3smH4y2k1EycmQ1Ncb9guJ98fsdcSMbeLZIYsktqPEImbKqEFMF0Dg==`

Signature verification passed against the existing public-key pin. A second build
and signing produced identical bytes. The existing legitimate private signer was
used in its external key directory; no private key was copied into the repository.

## 5. Live acceptance

Both used [the same intended 25-minute task](../examples/meeting-agenda-022-input.json).
Participant role labels were used as names because the intended task specified
roles without personal names. The gateway driver uses Agent Browser's open,
authorize, model selection, run-plan, execution, and artifact operations; it does
not call a provider directly.

| Check | Qwen | Luna |
|---|---|---|
| Exact model on all 5 calls | `ollama/qwen3:30b` | `openai/gpt-5.6-luna` |
| Calls | planner 1, perspectives 3, writer 1 | planner 1, perspectives 3, writer 1 |
| Perspective workers | 3 | 3 |
| Final minutes | 8 + 10 + 7 = **25** | 4 + 6 + 5 + 5 + 5 = **25** |
| Goal copied exactly | yes | yes |
| Final validation | passed | passed |
| Audit chain | valid | valid |
| Fallback | none | none |
| Tool calls | 0 | 0 |
| Run duration | 133.230 seconds | 32.355 seconds |
| Accounted tokens | 9,415 | 5,120 |

Luna's host evidence reports provider `openai` and response model `gpt-5.6-luna`.
It succeeded through existing OpenClaw authentication; no key or route was added.
Both models happened to propose exact totals in these live runs; deterministic
regressions separately exercise normalization from an incorrect 45-minute draft
to 25 and 37, and from a deliberately perturbed draft through the execution bridge.

Artifacts are saved in [Qwen's run directory](../examples/meeting-agenda-022-qwen/)
and [Luna's run directory](../examples/meeting-agenda-022-luna/), each including
`run.json`, `result.json`, `audit.json`, `usage.json`, `provenance.json`, and
`agenda.json`. Every reported artifact hash was independently checked.
[Consolidated acceptance](../examples/verification/meeting-agenda-022-acceptance.json)
records both run IDs, hashes, model calls, worker counts, validation, and authority
revalidation. The package still grants no authority; the host pins the signer,
binds the model, checks permission receipts, and runs a package-neutral interpreter.

## 6. Tests and local installation

- Focused graph, arithmetic, package, and authority regressions: **123 passed**.
- Browser/plugin suite: **409 passed**, including DOM submission tests and
  package/browser authority checks.
- TypeScript typecheck and production plugin build passed.
- Python full suite: **901 passed, 2 skipped** (one expected duplicate-archive warning from an attack-rejection test). See the final [test log](../examples/verification/meeting-agenda-022-python-tests.txt)
  and [JUnit report](../examples/verification/meeting-agenda-022-python.xml).
- Ruff checks and `git diff --check` passed.

The built browser plugin was packed and installed locally as Gateway generation 5.
All five packed files match the installation. The installed control plane reports
agentpkg 0.2.2 and remains execution-disabled; execution stays in the runner.
The existing provider/auth/agent configuration sections match the pre-install
configuration backup. [Installation evidence](../examples/verification/meeting-agenda-022-installed-browser.json).
Reload an already open Agent Browser tab to load the updated UI asset.

## 7. Remaining limits

The original writer goal string and original UI keystrokes were not retained, so
those two historical questions cannot be resolved more precisely from the supplied
artifact shape. A new run cannot reconstruct either fact. Final output quality
still depends on model judgment; normalization guarantees exact positive time
allocation and preserves generated content, not the substantive quality of every
proposed experiment or decision.

## 8. Files changed

Source, tests, package declarations, and documentation:

- `agentpkg/pyproject.toml`
- `agentpkg/src/agentpkg/__init__.py`
- `agentpkg/src/agentpkg/schemas/workflow.schema.json`
- `agentpkg/src/agentpkg/workflow_values.py`
- `agentpkg/tests/execution_fakes.py`
- `agentpkg/tests/test_browser_control.py`
- `agentpkg/tests/test_execution_progress.py`
- `agentpkg/tests/test_execution_session.py`
- `agentpkg/tests/test_meeting_agenda_022.py`
- `agentpkg/tests/test_shipped_artifacts.py`
- `agentpkg/tests/test_workflow.py`
- `agentpkg/tests/test_workflow_allocate.py`
- `agents/meeting-agenda/MANIFEST.agent`
- `agents/meeting-agenda/README.md`
- `agents/meeting-agenda/fixtures/workflow.json`
- `agents/meeting-agenda/graph.json`
- `agents/meeting-agenda/schemas/draft.schema.json`
- `agents/meeting-agenda/schemas/plan.schema.json`
- `agents/meeting-agenda/schemas/state.schema.json`
- `agents/meeting-agenda/skills/planning/SKILL.md`
- `agents/meeting-agenda/skills/writing/SKILL.md`
- `docs/meeting-agenda-022-report.md`
- `openclaw-agent-browser/openclaw.plugin.json`
- `openclaw-agent-browser/scripts/run-meeting-agenda.mjs`
- `openclaw-agent-browser/src/ui/run.ts`
- `openclaw-agent-browser/test/backend.test.ts`
- `openclaw-agent-browser/test/execution.test.ts`
- `openclaw-agent-browser/test/run-surface.test.ts`
- `openclaw-agent-browser/test/ui-run.test.ts`
- `spec/workflow-v0.md`

Release archives: `dist/meeting-agenda-0.2.1.agent.pkg` (preserved), `dist/meeting-agenda-0.2.2.agent.pkg` (new), and `dist/meeting-agenda.agent.pkg` (current alias). Acceptance input, both complete run directories, and `examples/verification/meeting-agenda-022-*` contain the supporting evidence.
