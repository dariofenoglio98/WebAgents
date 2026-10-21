# conversation.v0: turns, persistent state and just-in-time consent inside workflow.v0

Status: experimental, normative for agentpkg **0.6.0** and the Chrome core **0.4.0** (D-186,
D-260…D-264; the Chrome port and the chat surface are T24, D-270…D-279). The enclosing agent.pkg
format stays 0.1 and `workflow.v0` stays the execution profile: this document adds one top-level
graph object, one node type, one value source, one CLI command and six audit events. Machine
contracts live beside it in [`spec/conversation-v0/`](conversation-v0/): the RFC 6902 patch for
`workflow.schema.json` (the `conversation` object, the `consent` node, the `conversation` source),
the consent decision contract, the transcript's input and output contracts, and
[`cases.json`](../examples/conversation/cases/cases.json), the enforcement cases both runtimes
must refuse identically. `scripts/verify_conversation.py` checks the live schema against the
patch, the contract copies, the test package and every case on the reference. Rules are numbered
**V-n** so that a test can cite one; negative cases **N-n** in §10 map to `cases.json` ids.

Vocabulary. A **conversational package** is a workflow.v0 package whose graph carries a
`conversation` object. Its graph is the **turn graph**: a **message** is the graph's input, a
**reply** its output, and a **turn** is one run of the graph under the conversation's Run Plan.
The **persistent state** is what outlives a turn, described by the conversation's `state_schema`.
A **consent step** is a `consent` node: it shows the person one bounded action and waits for a
yes or a no. A permission a consent step decides is **gated**: a tool that links it runs only
after the step was accepted in that turn. The **transcript** is the person's record of a
conversation: the messages, the decisions as they were taken and by whom, the replies. The
**audit chain** is the proof: one hash chain over every event of every turn. Nothing a package
carries is ever authority (D-005): the plan's grants cover the conversation, a consent step can
only confirm what the plan already holds, and both runtimes enforce the intersection (D-180).

## 1. Purpose and what v0 refuses

A one-shot run cannot be talked to: the person fills in a task, the graph runs, the result is the
end. A conversation keeps a state the publisher declares across turns, lets each message trigger
the same signed graph, and pauses before a consequential action for the person's decision at the
moment it matters, with the facts in front of them: just-in-time consent, the confirmation before
a consequential action that CaMeL-style designs ask for, placed where the authority already is.
Nothing else changes: the model never decides who runs next, a reply is data the next turn reads,
and every bound of workflow.v0 holds inside each turn.

V-1. **Refused in v0:** a conversation without `max_turns`; a consent step that decides a
permission the package does not declare, or one of kind `model` or `memory`; a consent step on a
worker role or inside a map; a tool that links a gated permission and does not depend on a step
that gates it; a tool with write side effects that no consent step gates (the host's memory
bindings excepted); a conditional consent step whose `otherwise` accepts; a decision contract
other than `{accepted: boolean}`; a persistent key the turn's state does not declare; a transcript
that accepts a step whose permission the plan denies; a consent step in a graph that declares no
conversation; a turn suspended across a host restart (the wait is a node within the turn's
deadline); a message that names a file or a record outside the plan's grants (nothing lets it
name one); in-conversation acceptance of memory proposals (B-199, a host consent of T24's);
a model-chosen next step (network.v0, T25). A runtime that implements this specification refuses
each of these before the boundary it protects, with the codes of §9.

## 2. Declarations

### 2.1 The conversation object

V-2. A conversational package is a workflow.v0 package: `entrypoint` stays `workflow.v0`, the
graph's `profile` stays `workflow.v0`, and the graph carries the top-level object:

```json
"conversation": {
  "state_schema": "schemas/conversation-state.schema.json",
  "initial": {"literal": {"history": [], "orders": []}},
  "budget": {"max_turns": 4, "hard_tokens": 20000, "max_remote_calls": 0,
             "max_calls_per_tool": {"place-order": 1}},
  "end": {"when": {"left": {"from": "result", "path": "/intent"}, "op": "eq",
                   "right": {"literal": "done"}}},
  "fixture": "fixtures/transcript.json"
}
```

The graph is the turn graph: `input_schema` describes a message, `output_schema` a reply, and
every rule of workflow.v0 applies to a turn as to a run. This is the pattern of
[compute.v0](compute-v0.md): one profile, one more object, and an older runtime refuses the
package by its version (V-21) before it meets a node type it does not know.

V-3. **The persistent state.** `state_schema` names a declared package schema that is a closed
object (`type: object`, `additionalProperties: false`) of at most 64 properties
(`conversation_state_schema_open`; an undeclared path is `conversation_state_schema_undeclared`).
Its property names are the **persistent keys**, and each must also be a top-level property of the
turn's state schema (`policy.memory.state_schema`): `conversation_state_key_undeclared` otherwise.
A persistent key is a turn state key that outlives the turn; the two schemas may describe it
differently, and both are enforced (V-5).

V-4. **A turn starts** by evaluating the graph's `initial_state` over two sources: `input`, the
message, and `conversation`, the persisted state, typed by `state_schema` for the static checks
of workflow.v0 §4. The `conversation` source is legal in a conversational graph's `initial_state`
and nowhere else: a graph without a conversation that reads it is `conversation_source_scope`;
a node of a conversational graph that reads it fails the ordinary scope check ("source
unavailable in this scope"). Everything the graph needs from the past it copies into the turn's
state here, under the turn state schema's own rules.

V-5. **A turn ends.** When the graph completes, the persistent keys of the final turn state
(those present) form the next persisted state, validated against `state_schema` before the turn
may complete: a value the schema refuses fails the turn `schema_validation` and persists nothing
(N-33). A turn that fails or is cancelled persists nothing: the conversation's state is the last
completed turn's, and the conversation stays open. The turn's report carries the persisted state
as `conversation_state`.

V-6. **The first state.** `initial` is a literal constructor (`conversation_initial_literal`)
whose value validates against `state_schema` (`conversation_initial_invalid`); it is the state
before the first turn.

V-7. **The budget.** `budget` carries `max_turns` (1…256, required: unbounded turns are refused),
`hard_tokens` and `max_remote_calls` over the whole conversation, each at least the turn's own
(`policy.budget.hard_tokens`, `max_remote_calls`) so that one turn fits
(`conversation_budget_below_turn`), and optional `max_calls_per_tool`, per declared tool over the
whole conversation (`conversation_tool_unknown` otherwise). Their semantics are §5.

V-8. **The end rule.** Optional `end.when` is a workflow.v0 condition (`{left, op, right}`) over
`result` (the reply, typed by `output_schema`) and `state` (the persisted state after the turn);
when it holds after a completed turn, the conversation ends with reason `package`. The other ends
are §3.4.

### 2.2 The consent node

V-18. A node of `type: "consent"` carries, beside the fields every node has:

| Field | Meaning |
|---|---|
| `permissions` | 1…8 declared permission ids the step decides; an undeclared one is `consent_permission_unknown`; a kind `model` or `memory` is `consent_permission_kind` (those are granted at authorization, not confirmed per action) |
| `text` | a value constructor yielding the sentence shown, under the node's scope rules; at run time a value that is not a non-empty string of at most 2,000 characters fails the step `schema_validation` |
| `input` | the facts shown as a card: constructed as every node's input |
| `output_schema` | a declared schema that canonicalizes to exactly the decision contract [`consent-decision.schema.json`](conversation-v0/consent-decision.schema.json), `{"accepted": boolean}` closed (`consent_decision_schema`) |
| `timeout_seconds` | how long the turn waits for the decision (V-29) |
| `when`, `otherwise` | allowed as on any node; `otherwise` must be the literal `{"accepted": false}` (`consent_otherwise_accepts`): a consent step that is not asked is never accepted |

A consent step runs on the coordinator only (`consent_role`) and is never a map step (the step
schema admits no `consent` type). It writes its decision into state like any node; the fields
`task`, `tool`, `module`, `checks`, `assertions` and the map fields are refused on it, and
`permissions` and `text` on every other type (the workflow schema's conditionals). A graph that
declares no conversation may hold no consent step (`consent_outside_conversation`).

V-9. **The gate, per permission.** The union of every consent step's `permissions` is the
graph's set of gated permissions. A tool that links gated permissions is dispatched in a turn
only when, **for each gated permission it links**, a consent step naming that permission
completed **accepted in that same turn**; two permissions may be decided by two steps, or by one
step that names both. Statically, for each gated permission a tool node links, the node (or the
map node holding such a step) must transitively depend on a consent step that names that
permission (`consent_missing_before_tool`), so that the race cannot be written; at run time the
mediator checks the turn's decisions, permission by permission, before the call and refuses with
a denied permission check naming the reason: `consent_required` (no step decided it in this turn,
or the step was not asked) or `consent_denied` (the person said no, or the step resolved denied);
the node fails `permission_denied` (N-30, N-31, N-43). A graph should not reach the tool after a
denial: the decision is in state, and `when` on the tool takes the other path (the controls of
§10). A publisher who wants one card for a combined action (place and charge) names every
permission of that action on one step; two steps each deciding one permission are two cards, and
the tool that links both runs only once both were accepted (N-42).

V-19. **Consequential tools are gated.** Every tool with `side_effects: "write"` must link at
least one gated permission (`consent_required_for_write`), except the host's own memory bindings
(`host.memory.*`, memory.v0): they are host-owned, their permission is consented at authorization
and the memory's review is their consent. A `read` tool may be gated too, when the publisher wants
a card before it (a quote, a search that costs).

V-24. **A decision lives for its turn.** The next turn asks again. When two steps gate one
permission, the later decision in the turn is the one the gate reads. The step itself consumes no
grant; the tool call does (V-13).

### 2.3 Versions

V-21. A graph with a `conversation` object declares `runtime.minimum_version` **0.6.0** or later
(`conversation_minimum_version`), so that agentpkg ≤ 0.5.0 and the Chrome core 0.3.0 refuse the
package by version, with a reason a person can act on, before they meet the object or the node
type (D-188).

## 3. A turn

V-22. **The message** is an instance of `input_schema`, nothing more. Selected files travel as the
host's file capabilities (`--selected-files` in the reference) and memory records as the plan's
grants (`--memory-dir`, `--memory-grant`), both for the whole conversation; a turn may use any of
them, and a message cannot name a file or a record outside them because the format gives it no
way to. Per-message selection on a chat surface is the host's, over the same grants (T24).

V-27. **The run.** A turn is one `Workflow` run of the turn graph: the same waves, state commits,
schema checks, budgets, egress scans (memory.v0 M-36, M-37), proposals check (M-40), exports and
audit, under the conversation's grants. Its `result.json` carries `conversation_state` (V-5),
`consents` (the decisions of the turn, §4.4) and, in `provenance`, `conversation: {conversation_id,
turn}`. A host writes each turn's artifacts as the turn ends (`turn-NNN/` in the reference, V-16).

V-26. **Memory per turn.** A turn holds a memory run of its own over the same store and grants:
proposals are checked before the turn completes and written as the turn's `proposals.json` (M-40,
M-41); the agent document is read at the turn's start and committed at the turn's completion
(M-50). Nothing is written to a memory by a turn itself; the review after each turn is the host's
(T24 may fold it into a consent of kind `memory.proposal`, B-199; v0 does not).

V-29. **The wait.** A consent step awaits the host's answer inside the node's own
`timeout_seconds` and the turn's `deadline_seconds`; a decision that does not arrive in time ends
the step `timeout` and the turn with it (N-37); a cancelled turn ends it `cancelled`. v0 does not
suspend a turn across a host restart: the wait is a node (workflow.v0 §12 has no checkpoint).

### 3.4 The end of a conversation

V-25. A conversation ends when the person ends it (`end: true` in the transcript, or the host's
end action: reason `person`), when `end.when` holds after a completed turn (`package`), when the
turns run reach `max_turns` or a further turn is refused by it (`max_turns`), when a further turn
cannot be reserved (`budget`, §5), or when the host sends nothing more (`host`: the reference's
transcript is exhausted). `conversation.ended` names the reason; turns the transcript supplied
after the end are counted, never run (`turns_not_run`). A failed turn never ends a conversation by
itself.

V-30. **The conversation's status.** A conversation's record (the reference's report and the
`passed` of `agentpkg converse`) is `completed` when at least one turn completed and no turn
failed or was cancelled, whatever ended it: an end at `max_turns` or at the budget, a further
turn refused there included, is the conversation's own bound at work, not a failure, and
`ended.reason` says which. It is `failed` when a turn failed or was cancelled (the conversation
may have gone on after it, V-25: the record still says that a turn did not complete), or when
no turn ran at all.

## 4. Consent

### 4.1 The decision

The result of a consent step is `{"accepted": true | false}` and nothing else: a choice between
options is the reply's job; a consent says yes or no to one bounded action. The host records who
decided: `person` (the chat surface), `transcript` (a replayed decision), `plan` (the step was
not asked: the plan denies, or has consumed, a permission it names, V-12), `host` (a host that
cannot ask a person), `preset` or `policy` (a decision a
preset or a signed policy pre-took; T24's D-271 says which steps may be pre-decided, and never
one of kind `payment` or `personal.read`).

V-12. **A step never widens the plan, and the absence of a yes is a no.** If the plan denies any
permission the step names, the step is not asked: it resolves `{"accepted": false}` with
provenance `plan` and `consent.decided` carries `reason: permission_denied`. The same holds when
a permission the step names is a `once` grant that an earlier turn of the conversation spent
(V-13): the step is not asked and resolves denied by the plan with `reason:
permission_consumed`, so a card never asks for an action the plan could no longer allow, and the
person's record never shows a yes for one (N-34). Such a step is never put to a host, so no host
answer can accept it; a transcript that carries an `accepted` for a step whose permission the
plan denies is refused before the conversation starts (`consent_not_authorized`, V-15, N-23),
and one for a step the turn does not ask is listed as unused. A host that cannot ask the person
answers `denied` with provenance `host` and `reason: no_decision_available`, never `accepted`
(N-32: the reference's transcript host, for a step the transcript does not decide).
A host answer outside the decision contract (`{accepted: boolean, decided_by, reason?}`) is the
host's failure: the step fails `worker_error` (N-38).

### 4.2 Audit

V-23. `consent.requested {step, permissions, text_sha256, facts_hash, timeout_seconds}` precedes
the wait; `consent.decided {step, permissions, accepted, decided_by, reason, elapsed_ms}` follows
it, then `node.completed`; a wait that ends otherwise records `consent.failed {step, error}` and
the node fails. The audit carries hashes: the text and the facts are the person's, shown on the
surface and kept in the transcript (§7), never in the chain. The gate's refusal is a
`permission.checked` with `allowed: false`, `reason: consent_required | consent_denied`, the
tool and the steps that gate the permission.

### 4.3 What a consent step is not

It is not a grant: the plan's decisions are taken at authorization for the whole conversation
(a `session` grant covers every turn of every conversation under one receipt; `once` is for what
the person wants to confirm each time, V-13), and a consent step can only confirm an action under
authority the plan already holds. It is not a model's decision: the host asks the person, a model
answer is data the step shows. It is not a second approval of a tool: the tool's approval is the
plan's; the step confirms this use of it, with these facts. And it does not make a turn
interactive beyond itself: the person's message is the only other input of a turn.

## 5. Budgets

V-10. **Per turn, the package's budgets; per conversation, the object's; the turn is reserved
whole.** Each turn runs under `policy.budget` and the workers' budgets exactly as a run does,
lowered by the host's turn limits as always. Before a turn starts, the runner reserves the turn
against the conversation: the turns run so far must be below `max_turns`, the tokens spent so
far plus the turn's effective `hard_tokens` at most the conversation's `hard_tokens`, the same
for remote calls; else the turn is refused before any node runs, with `turn.refused` naming the
reason (`conversation_turn_limit`, `conversation_budget_exhausted`) and a transcript entry of
status `refused` (N-27…N-29). After the turn, its actual usage is charged and the rest of the
reservation released. A per-tool conversation cap lowers the turn's `max_calls_per_tool` to what
the conversation has left, so a second order in a later turn meets `budget_exhausted` at the tool
(N-35).

V-11. **Host limits only lower.** `--limits` (and a host's equivalent) take
`conversation_max_turns`, `conversation_total_tokens` and `conversation_max_remote_calls`
beside the turn's keys; each is `min` with the package's. The effective limits are recorded in
`conversation.started` and in the transcript's `budget.limits`.

V-13. **`once` is one use per conversation.** A `once` grant is spent by its first use in the
conversation; the next turn starts with it spent (`runtime.started` lists `spent_permissions`),
a consent step naming it is not asked in a later turn (V-12, N-34), and a tool call that reaches
it anyway is refused as a consumed permission (N-41). The host's rule that `once`
is refused when the turn graph itself would consume it more than once is unchanged, per turn
(`execution_grant_unsupported`). The control plane's "a receipt that grants anything `once` is
spent at its first execution lease" applies to the conversation, not to each turn (T24).

## 6. Audit continuity

V-17. **One chain.** A conversation's audit is one hash chain: `sequence` counts on across turns,
each turn's first event links to the hash before it, and `verify_audit_chain` reads the whole
`audit.json` as one record. Every event of a conversation carries `conversation_id` and `turn`
(0 before the first turn). The conversation-level events, `conversation.started`, `turn.started`,
`turn.refused`, `turn.completed`, `turn.failed` and `conversation.ended`, carry the conversation
id (a UUID) as `run_id`; a turn's own events carry the turn's `run_id`. A turn's `audit.json` is
its slice of the chain (its first `previous_hash` is the `turn.started` hash). A tampered or cut
chain is found by the verifier (N-40).

## 7. The transcript

V-14. **The input form** ([`transcript-input.schema.json`](conversation-v0/transcript-input.schema.json)):
`{"schema": "conversation.transcript.v0", "turns": [{"message", "consents"?}, …], "end"?}`, at
most 256 turns; `consents` maps consent step ids to booleans, the decisions for the steps the turn
may reach; `end: true` says the person closes the conversation after the last turn. The package's
conversation fixture is this document.

V-15. **Checked before the start** against the package and the plan's grants: a message outside
`input_schema` (`conversation_message_invalid`), a decision for a step the graph does not declare
(`consent_step_unknown`), and an `accepted` for a step whose permission the plan denies
(`consent_not_authorized`, V-12). A decision for a step the turn never reaches is listed in the
turn's `unused_consents`, never an error.

V-16. **The output form** ([`transcript.schema.json`](conversation-v0/transcript.schema.json)) adds
`conversation_id`, `package {package_id, version, digest}`, `started_at`; per turn `turn`,
`run_id`, `status` (`completed | failed | cancelled | refused`), `error_code`, `refusal`, the
`message`, the `consents` supplied, the `decisions` as taken (`step`, `permissions`, `accepted`,
`decided_by`, `reason`, `decided_at`, `text`, `facts`), `unused_consents`, the `reply`, `usage`
(tokens, remote calls, tool calls), `started_at`, `ended_at`; then `state` (after the last
completed turn), `budget {limits, spent}`, `spent_permissions` and `ended {reason, at,
turns_not_run}`. The reference's `agentpkg converse … --out DIR` writes `transcript.json`,
`state.json`, `audit.json` (the chain), `usage.json`, `provenance.json`, and `turn-NNN/` with each
turn's `result.json`, `audit.json`, `usage.json`, `provenance.json` and exports. The transcript
is the person's record and carries what they saw; the chain is the proof and carries hashes.

## 8. Fixture mode and conformance

V-27 (fixture). `conversation.fixture` names a transcript in the input form inside the package;
`agentpkg converse --mode fixture` without `--transcript` replays it, and the graph's own
`fixture` supplies the models' and tools' replay cases, shared by every turn (exact-input match,
so a scenario's history is in the replayed inputs only where the graph puts it there). Validation
checks the transcript's shape (`conversation_fixture_invalid`), that the graph declares a fixture
too (`conversation_fixture_requires_graph_fixture`), the turn count against `max_turns`
(`conversation_fixture_turns`), every message against `input_schema`
(`conversation_fixture_message`), every consent name (`consent_step_unknown`), and that the graph
fixture's `input` is the transcript's first message (`conversation_fixture_input`).

V-28. **One-shot hosts refuse.** `agentpkg run` and `agentpkg eval` refuse a conversational
package (`conversation_profile: … use agentpkg converse`); the one-shot execution host refuses it
in its capability check (`conversation_not_supported`), before anything runs, as a limit of that
host (N-25, N-26). A `Workflow` constructed without a turn for such a package is
`conversation_turn_required`; one constructed with a turn for a plain package
`conversation_turn_unexpected`.

Conformance (T24): the conformance suite runs the test package's fixture transcript and the cases
of §10 on both CLIs over a `converse` driver and compares transcripts (without timestamps and
ids), states, replies, turn artifacts and audits under D-063; until the Chrome core reaches 0.6.0,
such cases are pending by the runner's `requires` rule.

## 9. Refusal codes

| Where | Codes |
|---|---|
| validation | `consent_outside_conversation`, `conversation_source_scope`, `conversation_minimum_version`, `conversation_state_schema_undeclared`, `conversation_state_schema_open`, `conversation_state_key_undeclared`, `conversation_initial_literal`, `conversation_initial_invalid`, `conversation_budget_below_turn`, `conversation_tool_unknown`, `consent_role`, `consent_permission_unknown`, `consent_permission_kind`, `consent_decision_schema`, `consent_otherwise_accepts`, `consent_missing_before_tool`, `consent_required_for_write`, `conversation_fixture_missing`, `conversation_fixture_invalid`, `conversation_fixture_requires_graph_fixture`, `conversation_fixture_turns`, `conversation_fixture_message`, `consent_step_unknown`, `conversation_fixture_input` |
| before the conversation | `conversation_profile_required`, `conversation_message_invalid`, `consent_step_unknown`, `consent_not_authorized`; one-shot paths: `conversation_profile`, `conversation_not_supported`, `conversation_turn_required`, `conversation_turn_unexpected` |
| a turn refused | `turn.refused` with `conversation_turn_limit` or `conversation_budget_exhausted` (the transcript entry's `error_code` is `budget_exhausted`) |
| inside a turn | workflow.v0's codes; the gate's `permission_denied` with `consent_required` or `consent_denied`; a step the plan decided: `consent.decided` with `reason: permission_denied` or `permission_consumed`; the step's `schema_validation` (the text), `timeout`, `cancelled`, `worker_error` (`consent_decision_invalid`) |

## 10. Negative cases

Each row is a case of [`cases.json`](../examples/conversation/cases/cases.json) (`id`), built by
the probe `agentpkg/tests/conversation_probe.py` and asserted by
`agentpkg/tests/test_conversation_cases.py`. Stages: `validation` (refused when the package is
validated, the message starting with the code); `start` (refused before the conversation starts);
`host` (the one-shot execution host); `turn` (the turn refused before any node runs); `run` (the
turn fails with the code, or the control completes).

| N | `cases.json` id | Stage | Code (reason) |
|---|---|---|---|
| N-1 | `consent-outside-conversation` | validation | `consent_outside_conversation` |
| N-2 | `conversation-source-outside` | validation | `conversation_source_scope` |
| N-3 | `minimum-version` | validation | `conversation_minimum_version` |
| N-4 | `state-schema-undeclared` | validation | `conversation_state_schema_undeclared` |
| N-5 | `state-schema-open` | validation | `conversation_state_schema_open` |
| N-6 | `state-key-undeclared` | validation | `conversation_state_key_undeclared` |
| N-7 | `initial-not-literal` | validation | `conversation_initial_literal` |
| N-8 | `initial-invalid` | validation | `conversation_initial_invalid` |
| N-9 | `budget-below-turn` | validation | `conversation_budget_below_turn` |
| N-10 | `tool-cap-unknown` | validation | `conversation_tool_unknown` |
| N-11 | `consent-on-worker` | validation | `consent_role` |
| N-12 | `consent-permission-unknown` | validation | `consent_permission_unknown` |
| N-13 | `consent-permission-kind` | validation | `consent_permission_kind` |
| N-14 | `consent-decision-schema` | validation | `consent_decision_schema` |
| N-15 | `consent-otherwise-accepts` | validation | `consent_otherwise_accepts` |
| N-16 | `tool-before-consent` | validation | `consent_missing_before_tool` |
| N-17 | `write-tool-ungated` | validation | `consent_required_for_write` |
| N-18 | `fixture-step-unknown` | validation | `consent_step_unknown` |
| N-19 | `fixture-too-many-turns` | validation | `conversation_fixture_turns` |
| N-20 | `fixture-message-invalid` | validation | `conversation_fixture_message` |
| N-21 | `fixture-input-mismatch` | validation | `conversation_fixture_input` |
| N-22 | `transcript-step-unknown` | start | `consent_step_unknown` |
| N-23 | `transcript-accepts-denied` | start | `consent_not_authorized` (a tampered transcript) |
| N-24 | `transcript-message-invalid` | start | `conversation_message_invalid` |
| N-25 | `run-refused` | start | `conversation_profile` (`agentpkg run`) |
| N-26 | `host-refused` | host | `conversation_not_supported` |
| N-27 | `turn-beyond-cap` | turn | `conversation_turn_limit` |
| N-28 | `conversation-tokens-exhausted` | turn | `conversation_budget_exhausted` |
| N-29 | `conversation-remote-exhausted` | turn | `conversation_budget_exhausted` |
| N-30 | `tool-after-denied-consent` | run | `permission_denied` (`consent_denied`) |
| N-31 | `tool-after-skipped-consent` | run | `permission_denied` (`consent_required`) |
| N-32 | `consent-undecided` | run | completed: denied by the `host`, the tool never runs |
| N-33 | `state-outside-schema` | run | `schema_validation`; nothing persisted |
| N-34 | `once-across-turns` | run | completed: `once` spent in turn 1, turn 2's step not asked (`plan`, `permission_consumed`), the tool never runs again |
| N-35 | `tool-cap-across-turns` | run | `budget_exhausted` in the second turn |
| N-36 | `consent-text-not-string` | run | `schema_validation` at the step |
| N-37 | `consent-timeout` | run | `timeout` |
| N-38 | `consent-host-invalid` | run | `worker_error` (`consent_decision_invalid`) |
| N-39 | `two-turns-one-consent`, `consent-denied-path` | run | controls: completed, ended by the package |
| N-40 | (test: a changed or cut chain) | record | `verify_audit_chain` invalid |
| N-41 | `once-spent-tool-reached` | run | `permission_denied` in the second turn: the step not asked, the tool reached anyway and refused as consumed |
| N-42 | `two-steps-two-permissions` | run | control: a tool linking two gated permissions, each accepted on its own step, runs once |
| N-43 | `two-steps-one-accepted` | run | `permission_denied` (`consent_denied`): one of the two permissions undecided |

The reference asserts every row (`agentpkg/tests/test_conversation_cases.py`,
`test_conversation_runtime.py`); the catalog v2's consent family starts from this table (D-189).

## 11. The test package

`org.webagents.conversation-test` 0.1.0 ([`examples/conversation/conversation-test/`](../examples/conversation/conversation-test/)),
a fictional ticket desk: a `Clerk` model step reads each message with the conversation's
`history` and `orders` (the persistent state, carried by two `join` nodes), a consent step
`confirm-order` asks before an order is placed, the `place-order` tool (write side effects, one
per conversation) places it, and the conversation ends when the reply's intent is `done`. Its
fixture transcript is two turns: an order confirmed, then goodbye. It is signed with a development
key (`examples/keys/conversation-test-publisher.pub.pem`) for the test suites and the conformance
suite and is not shipped in `dist/`; `agentpkg converse examples/conversation/conversation-test.agent.pkg --mode fixture --grants examples/conversation/conversation-test-grants.json --approve-tool place-order --trust-key examples/keys/conversation-test-publisher.pub.pem --out <new dir>`
runs it.

V-20. **What a person is told.** `inspect` and the control plane's summary describe a
conversational package by its persistent keys, its budget, its end rule and each consent step with
the permissions it decides (`conversation`); the agent page says, in words, how many turns at
most, within what, what is kept between turns, and which steps will ask before what
(`conversational_package`).

## 12. Versions, deliberate limits, prior art

**Versions.** agentpkg 0.6.0 implements this document; packages that use it declare
`runtime.minimum_version: "0.6.0"`. The Chrome core implements it at 0.4.0 (T24) with
`SUPPORTED_RUNTIME_VERSION` 0.6.0; until then its gate stays 0.5.0 and the runtimes' version test
accepts the pair. The OpenClaw plugin stays frozen (D-029) and its execution host refuses
conversational packages (V-28). The paper line is untouched.

**Deliberate limits of v0.** No suspend and resume of a turn; no decision schema beyond yes or
no; no consent step inside a map or on a worker; no model-chosen next step; no in-conversation
acceptance of memory proposals; one conversation per Run Plan; a transcript of at most 256
turns; the message is the input schema's instance and nothing else. A conversation is not a
persistent service: it ends, and its state is the transcript's.

**Prior art.** CaMeL (Debenedetti et al., 2025): confirmations before consequential actions as a
control separate from the model; the deck's §7 "message box vs endpoints" (messages scanned in
order, no bidirectional endpoint: a turn is a message the signed graph reads, never a channel the
model drives); NLIP as a possible message format (B-181); workflow.v0's own `once` and the
control plane's spent receipt (D-003 area).
