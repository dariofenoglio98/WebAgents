# network.v0: bounded, model-chosen delegation inside workflow.v0

Status: experimental, normative for agentpkg **0.7.0** (D-187, D-280…D-284; the Chrome port, the
agent page's "at most" and the shipped travel package are T26, D-290…D-299). The enclosing
agent.pkg format stays 0.1 and `workflow.v0` stays the execution profile: this document adds one
top-level graph object, one node type, one value source and six audit events. Machine contracts
live beside it in [`spec/network-v0/`](network-v0/): the RFC 6902 patch for `workflow.schema.json`
and [`cases.json`](../examples/network/cases/cases.json), the enforcement cases both runtimes must
refuse identically. `scripts/verify_network.py` checks the live schema against the patch, the
test package, the travel network's walks and every case on the reference. Rules are numbered
**R-n** so that a test can cite one; negative cases **N-n** in §7 map to `cases.json` ids. The
analysis behind §3 is the T25 note (the model, the proof sketch, tightness, the evaluation).

Vocabulary. A **delegation package** is a workflow.v0 package whose graph carries a `network`
object and runs it in one **network node**. A **role** is a declared worker with a **program**
(steps, a patch, a route). An **activation** is one run of a role's program as one worker
instance, handed a **message**. A **handoff** (a **transition**) is the step from one activation
to the next along a declared **edge**; the model chooses it at a **route** when the route is
*chosen*, the package when it is *fixed*. A **walk** is the sequence of activations of one run.
The **shared state** is the network's own state; a role sees its **view** of it. The **bound**
(the **worst case**, the **envelope**) is the vector computed from the declaration in §3; "at
most" on the agent page is that vector. Nothing a package carries is ever authority (D-005): the
plan's grants cover the run, the model chooses within the declared edges, and both runtimes
enforce the intersection (D-180).

## 1. Purpose and what v0 refuses

workflow.v0 fixes the graph before signing: the model fills in answers and never decides who runs
next. Neuro-SAN's AAOSA, handoffs in agent frameworks and most multi-agent systems let a model
choose the next agent at run time, which is what makes them useful for open-ended tasks and what
makes their cost and reach unbounded. network.v0 keeps the choice and bounds it: a package
declares the roles, the edges a role may hand off along with their use caps, how many handoffs a
run may make and each role's budget; every run is then a walk in a finite set, the cost of every
walk is bounded by a number computed from the declaration in one pass, the runtime refuses each
transition that would leave the set before the target runs, and the person is told "at most"
before they agree. What is not verified is which walk the model takes, what it says, and whether
the result is good: the choices are the model's; only the envelope is verified.

R-1. **Refused in v0:** a remote role (B-186; A2A later under the same bounds); a role created
at run time; a transition along an edge the role does not declare; a role that could never end
(no edge and `may_end` false); a `network` node inside a map, on a worker, or more than one per
graph; a consent step inside a role (the step vocabulary admits none); a `once` grant on a
permission the network consumes more than once (the host rule, unchanged); a network whose worst
case the package's own budget could not hold; a role's program that reads outside its view. A
runtime that implements this specification refuses each of these before the boundary it
protects, with the codes of §6.

## 2. Declarations

### 2.1 The network object and its node

R-2. A delegation package is a workflow.v0 package: `entrypoint` stays `workflow.v0`, the graph's
`profile` stays `workflow.v0`, and the graph carries the top-level object:

```json
"network": {
  "entry": "FrontMan",
  "max_hops": 6,
  "state_schema": "schemas/network-state.schema.json",
  "initial": {"literal": {"trip": null, "flights": [], "hotels": [], "calendar": []}},
  "message_schema": "schemas/message.schema.json",
  "result": {"object": {"plan": {"from": "message", "path": "/text"},
                        "flights": {"from": "state", "path": "/flights"}}},
  "roles": {"FrontMan": {…}, "Flights": {…}, "Hotel": {…}, "Calendar": {…}}
}
```

Exactly one node of `type: "network"` runs it (`network_node_required` when none,
`network_node_once` when more), on the coordinator (`network_node_role`), at the top level (the
step vocabulary admits none). Its `input` is the first message (validated against
`message_schema` when the node starts), its `output_schema` validates the network's result, its
`timeout_seconds` bounds the whole network, and its `writes` commit the result as any node's.
A `network` node in a graph that declares no network is `network_without_declaration`. This is
the pattern of compute.v0 and conversation.v0: one profile, one more object, and an older
runtime refuses the package by its version (R-12) before it meets a node type it does not know.

### 2.2 Roles, the entry and the edges

R-3. **A role is a worker.** `roles` maps 1…16 role ids to programs; each id names a declared
non-coordinator worker (`network_role_unknown`, `network_role_coordinator`), which lends the
role its skills, tools, `budget` (tokens and remote calls **per activation**, enforced per worker
instance) and its view (`state_read`, `state_write`, over the network's state, R-6). A role's
worker runs only inside the network: a top-level node on it is `network_worker_shared`. The id
`done` is the end, not a role (`network_role_reserved`). Each role carries a `description`
(1…500 characters), the words a route shows the model about that target (R-13).

R-4. **The entry.** `entry` names the role activated first, with the node's input as its
message (`network_entry_unknown`).

R-5. **Edges.** `roles[r].edges` lists at most 16 `{to, max_uses}`: the roles r may hand off to
(`network_edge_unknown`), at most one edge per target (`network_edge_duplicate`), each usable at
most `max_uses` (1…16) times in a run; a self-edge is allowed. `may_end` says whether r may
choose `done`. A role with no edge and `may_end` false could never finish an activation:
`network_role_dead_end`. `max_hops` (1…64) bounds the transitions of a run; optional
`max_activations` (1…65) bounds a role's activations.

### 2.3 The shared state and the views

R-6. `state_schema` names a declared package schema that is a closed object (`type: object`,
`additionalProperties: false`) of at most 64 properties (`network_state_schema_undeclared`,
`network_state_schema_open`); `initial` is a literal (`network_initial_literal`) that validates
against it (`network_initial_invalid`). A role's `state_read` and `state_write` name keys of this
schema (`network_state_key_undeclared`), never of the graph's state: the shared state is the
network's own, and the network node's result is the only thing that reaches the graph's state.
An activation sees a **view**: a copy of the keys in its `state_read`; its patch may write only
the keys in its `state_write` (R-9); the patch is validated against `state_schema` before the
role routes (R-9) and committed before the transition, so the next activation sees it. A patch
sets keys and never removes one, so a key `initial` sets is present in every later state and a
key it does not set may be absent when a role reads it, the order of the roles' writes being
chosen at run time: every key of a role's `state_read`, and every state key `result` reads, is
set by `initial` (`network_state_read_uninitialized`); a key no view reads may be left to its
writer.

### 2.4 Messages

R-7. `message_schema` names a declared package schema (`network_message_schema_undeclared`): the
node's input, every handoff's message and the final message are instances of it. The message is
the one channel beside the shared state; nothing else crosses an activation boundary.

### 2.5 Programs

R-8. **Steps and scope.** `roles[r].steps` is a sequence of 0…128 steps of the map vocabulary
(`llm`, `tool`, `compute`, `join`, `validate`), unique by id (`network_step_duplicate`), checked
by the rules of workflow.v0 §3–§5 for a map step, over three sources and no other
(`network_source_scope`): `state` (the role's view, `network_state_read_outside_view` beyond
it), `message` (the message handed to the activation) and `steps` (its earlier steps). An `llm`
step's answer `checks` (workflow.v0 §5) read the answer as `result` beside the three, there and
nowhere else; a refused check is a non-conforming answer at `<node>/<role>/<step>` (N-45). A
`tool` step names a tool of the role's worker; an `llm` step a declared task, with the worker's
skills as its instructions; a `compute` step a declared module. Steps run in order, each at most
once, under the role's `timeout_seconds` (the whole activation) and the worker's budgets.

R-9. **The patch.** `writes` maps top-level pointers of the shared state, each a key of the
role's `state_write` (`network_state_write_outside_view`), to constructors over the same three
sources, evaluated after the last step and validated over the shared state **before the route**:
a patch that leaves the shared state outside `state_schema` fails the activation
`schema_validation` at once, so that no route is asked, paid for or recorded for it, and nothing
is committed (N-38, N-44).

R-10. **The route.** Either **fixed**, `{"next": "<role>" | "done", "message": <constructor>}`:
the target is one of the role's edges or `done` where `may_end` (`network_edge_undeclared`,
`network_end_not_allowed`), the message a constructor over the three sources; or **chosen**,
`{"task", "max_output_tokens", "input": <constructor>}`: one model call under a declared task
(`network_route_task_unknown`), whose answer the runtime shapes and checks (R-13, R-14). A fixed
return costs no model call.

R-11. **The result.** `result` is a constructor over `state` (the final shared state) and
`message` (the final message, the one handed with `done`), validated against the node's
`output_schema`.

### 2.6 Versions

R-12. A graph with a `network` object declares `runtime.minimum_version` **0.7.0** or later
(`network_minimum_version`), so that agentpkg ≤ 0.6.1 and the Chrome core 0.4.0 refuse the
package by version, with a reason a person can act on, before they meet the object (D-188).

## 3. The worst case

R-19. **Per-activation costs.** One activation of a role r costs at most, per component:
`model_calls` = its `llm` steps plus one if its route is chosen; `tool_calls[τ]` = its `tool`
steps naming τ; `compute_calls` = its `compute` steps; `remote_calls` = the worker's
`budget.remote_calls`; `tokens` = the worker's `budget.tokens`; `seconds` = its
`timeout_seconds`. A conditional step counts as taken; the first three are exact because a
program is straight-line, the last three are enforced per worker instance by the mediator and
the activation's timeout.

R-20. **The activation bound.** A(r) = min( `max_activations`(r) where declared,
Σ_{edges e into r} `max_uses`(e) + [r = entry], `max_hops` + [r = entry] ): every activation but
the entry's first follows an edge into r, each edge is taken at most `max_uses` times, and there
are at most `max_hops` transitions. Every walk activates r at most A(r) times, and makes at most
`max_hops` + 1 activations in all.

R-21. **The bound.** For each component c, B_c is the maximum of Σ_r n_r · cost_c(r) over
integer counts with 1 ≤ n_entry ≤ A(entry), 0 ≤ n_r ≤ A(r) and Σ_r n_r ≤ `max_hops` + 1. It is
computed exactly by the greedy allocation: one activation of the entry, then activations in
descending order of cost_c (declaration order breaks ties) up to each role's A(r), until
`max_hops` + 1 are placed (a bounded knapsack with unit weights). B_c dominates every walk
(the counts of any walk satisfy the constraints). It is a relaxation: exact when some walk
realizes the allocation (every star, every chain), loose where the graph's shape forbids it;
the exact maximum over walks is NP-hard in general and is not a plan figure (R-23). The
normative **"at most"** of a run is min(B_c, cap_c) where cap_c is the run's own cap for that
component when one exists: `hard_tokens`, `max_remote_calls`, `max_calls_per_tool[τ]`, the
node's `timeout_seconds` and the graph's deadline, each as the host lowered it. The reference
computes it in `agentpkg.delegation.analysis.worst_case`, with the uncapped figures kept as
`relaxation`; `agentpkg inspect` and the control plane's summary report it from the package's
own budgets, the execution host's record and the run's `network.started` from the effective
ones (the host's budget and the deadline it enforces, so that the two records agree on every
figure, seconds included).

R-22. **Within the package's budget.** The relaxation's tokens and remote calls must not exceed
the package's own `hard_tokens` and `max_remote_calls` (`network_bound_exceeds_budget`), so that
what the page says the network can spend at most is what the package lets it spend. Per-tool
caps lower the bound without refusing the package (a cap reached mid-walk fails that call
`budget_exhausted`, as for any node).

R-23. **The enumerator.** The set of walks is finite: from the entry, along declared edges
within `max_uses`, the targets' `max_activations` and `max_hops`, ending at a role that may end.
The reference lists them depth first in declaration order with a deterministic effort cap
(`enumerate_walks`), for tests and the evaluation: on the travel network (sixteen walks) the
maximum observed count per component over every walk equals B_c, and tokens and remote calls
never pass it (`agentpkg/tests/test_network_travel.py`). A runtime never computes it for a plan.

R-24. **What the person is told.** `inspect` and the control plane's summary describe a
delegation package by its roles (description, steps, tools, route kind, edges, `may_end`,
activation bound, budget, view), its entry, `max_hops`, its schemas and its worst case
(`network`); the agent page says, in words, between how many roles the model chooses, at most
how many handoffs, how often each role at most, and at most how many model calls, tool calls per
tool, remote calls and tokens (`delegation_network`). The Run Plan records the same under
`execution.network`; the execution host's capability check records it under the host's limits.
Every figure is a theorem about the signed declaration, not an estimate: a run can stay below
it and cannot pass it.

## 4. Execution

R-13. **The route request.** A chosen route is one model call by the role's worker under its
skills, with `data` = `{"input": <the route's constructed input>, "targets": [{"role",
"description", "uses_left"}…], "hops_left", "may_end"}`: the declared targets in edge order with
how many more times each can be taken now (the edge's uses left, the target's activations left
where capped, and the hops left, whichever is least), and whether `done` is allowed. The output
schema is built by the runtime, not declared: `{"next": {"enum": [<the targets in edge order>,
"done" where may_end]}, "message": <message_schema>}`, closed. The enum is static per role, so a
fixture replays it; the availability is in the data, so a model is told what it may still take.
The call is named `<node>/<role>/route` in the audit and in the execution host's output-cap
check, and it counts as a model call of the role (R-19).

R-14. **The transition check.** The answer, once inside the enum and the message schema (a miss
is a schema refusal of the call, `schema_validation`, N-34, N-35), is checked before it is
accepted: the target is a declared edge of this role or `done` where allowed, the edge has uses
left (`edge_exhausted`), the hops are not exhausted (`hops_exhausted`), the target's activations
are below its cap (`role_exhausted`). A refused chosen route is a **non-conforming answer**, as
a refused answer check is (workflow.v0 §5): the call fails `model_output_not_conforming` with
`failed_check: {check: "route", failure, next}`, charged what the router reported, and the
activation, the network, the node and the run fail `model_error` (N-31…N-33). A refused fixed
route fails `budget_exhausted` for a cap (N-39) and `permission_denied` for an undeclared target
or an end the role may not take (unreachable past validation; checked again in depth). Every
decision is recorded (R-18) before anything else happens, with the reason when refused. The
reference never asks the model again; a host may re-ask within workflow.v0 §7 (R-28).

R-15. **An activation.** The runtime activates a role by running its program as one worker
instance of the role's worker (`run_worker`: the role must be approved, the memory permission is
consumed once per activation, the instance's budgets are the worker's), under the role's
`timeout_seconds`: the steps in order over `{state: view, message, steps}`, each step named
`<node>/<role>/<step>`; the patch, validated over the shared state (R-9); then the route. The
activation returns the patch and the decision; the network commits the patch, records it, and
takes the transition: `uses[edge] += 1`, `hop += 1`, the target's activations `+= 1`, the
decision's message becomes the next message. A step that fails fails the activation and the
network with the step's code; nothing of the activation is committed and nothing is routed. The
node's own `timeout_seconds` ends the whole network as `timeout`, named so by the node and by
`network.failed`.

R-16. **The end and the result.** `done` ends the network after the last patch is committed;
`result` is evaluated over the final state and the final message and validated against the
node's `output_schema`; the node completes and its `writes` reach the graph's state at the
wave's commit, as for any node. A network that cannot take any transition and cannot end fails
at that route (a `done` outside the enum, or every target refused): the caps are the package's
own, and the runtime enforces, it does not steer.

R-17. **The reservation.** When the network node starts, after the input is validated and
before the first activation, the runtime checks that the run's remaining token and remote-call
budgets admit the network's worst case under the effective limits (B_tokens ∧ `hard_tokens`,
B_remote ∧ `max_remote_calls`, R-21), else refuses the node before anything is spent
(`network.refused` with `reason: tokens | remote_calls`, the node `budget_exhausted`, N-37), as
a conversation reserves a whole turn (conversation.v0 V-10). Nothing is held: the activations
are bounded by their own caps and the run's caps stay enforced; a graph whose network node
shares a wave with other effectful nodes shares the budget with them (a publisher who wants the
whole budget for the network puts nothing beside it).

R-25. **Conversations and the gate.** A turn graph may hold the network node: the turn is
reserved whole (V-10), the network's worst case must fit the turn's budgets (R-22), and the
conversation's "at most" is `max_turns` times the turn's. The consent gate (V-9) reaches a role's
tool step: a role's tool that links a gated permission runs only in a turn in which the step was
accepted, and statically the network node must depend on the consent step
(`consent_missing_before_tool`, naming `<node>/<role>/<step>`). Consent steps live on the
coordinator outside the network; a role cannot ask.

R-26. **`once`.** A network activates roles more than once and may make more than one model
call, so the execution host's rule refuses a `once` grant on a permission the network would
consume more than once (`execution_grant_unsupported`, N-28, N-29), counting each role's
activation bound times its per-activation uses; a `once` tool permission used by one role once
is still refused as consumed at its second call, as everywhere.

R-27. **Fixture mode.** The graph's fixture supplies every role's model and tool cases by exact
input match, the route's included: a route case's input is the request data of R-13, so a
fixture is built from the same `route_data` the runtime builds (the examples' generator does).
Nothing in a fixture grants or routes: a fixture that leads the model past a cap meets the
transition check like a live model.

R-28. **Host re-asks.** A host that re-asks non-conforming answers (workflow.v0 §7, the Chrome
runtime) may re-ask a refused chosen route up to twice with the feedback line naming the check
(`route`) and the failure; each re-ask is reserved, charged and audited afresh, and a third
refusal fails as above. The reference's routers declare no re-asks.

## 5. Audit

R-18. Beside workflow.v0's events: `network.started {node_id, entry, bound, tokens_left,
remote_calls_left}` after the reservation, or `network.refused {reason, …}` instead;
`network.activated {node_id, role, hop, activation, message_hash}` before each activation (its
worker events follow, `worker.spawned` naming the node); `route.decided {node_id, role, hop,
activation, chosen_by: model | package, next, allowed, reason, hops_left, uses, max_uses}` for
every decision (`next` is the declared target or `done`, null when the answer named neither);
`network.state.committed {node_id, role, hop, state_keys, state_hash}` after each patch;
`network.completed {node_id, hops, activations, result_hash}` or `network.failed {node_id,
error_code, hop, role}`. A role's steps carry `node_id` `<node>/<role>/<step>` and its route
`<node>/<role>/route`. Messages, patches and model answers are hashed, never recorded.

## 6. Refusal codes

| Where | Codes |
|---|---|
| validation | `network_without_declaration`, `network_minimum_version`, `network_node_required`, `network_node_once`, `network_node_role`, `network_roles`, `network_role_reserved`, `network_role_unknown`, `network_role_coordinator`, `network_worker_shared`, `network_entry_unknown`, `network_edge_unknown`, `network_edge_duplicate`, `network_role_dead_end`, `network_state_schema_undeclared`, `network_state_schema_open`, `network_state_key_undeclared`, `network_initial_literal`, `network_initial_invalid`, `network_message_schema_undeclared`, `network_source_scope`, `network_state_read_outside_view`, `network_step_duplicate`, `network_state_write_outside_view`, `network_route_task_unknown`, `network_edge_undeclared`, `network_end_not_allowed`, `network_bound_exceeds_budget`, `network_state_read_uninitialized`; with a conversation, `consent_missing_before_tool` at `<node>/<role>/<step>` |
| the execution host | `execution_grant_unsupported` (a `once` grant the network would consume more than once), `execution_output_cap_too_large` naming `<node>/<role>/route` or `<node>/<role>/<step>` |
| the node refused | `network.refused` with `tokens` or `remote_calls`; the node `budget_exhausted` |
| inside the network | workflow.v0's codes at a step; a chosen route: `schema_validation` (the enum or the message), `model_error` with `failed_check.check = "route"` and `failure` ∈ `edge_exhausted`, `hops_exhausted`, `role_exhausted`, `edge_undeclared`, `end_not_allowed`; a fixed route: `budget_exhausted` (a cap), `permission_denied` (undeclared); a step's answer check: `model_error` with `failed_check.check = "answer_check"` at `<node>/<role>/<step>`; the patch: `schema_validation` with `failed_check.check = "network_state"`, before the route; the input: `schema_validation` with `failed_check.check = "message_schema"`; an activation past its time, or the node past its own: `timeout` |

## 7. Negative cases

Each row is a case of [`cases.json`](../examples/network/cases/cases.json) (`id`), built by the
probe `agentpkg/tests/network_probe.py` (a help desk: `Desk` chooses between `Lookup` and
`Writer` or ends; the fixture is generated from the mutated network and a scripted walk) and
asserted by `agentpkg/tests/test_network_cases.py`. Stages: `validation` (refused when the
package is validated, the message starting with the code); `grants` (the execution host's grant
check); `host` (its capability check); `run` (the run fails with the code at the node named, or
the control completes).

| N | `cases.json` id | Stage | Code (reason) |
|---|---|---|---|
| N-1 | `no-node` | validation | `network_node_required` |
| N-2 | `two-nodes` | validation | `network_node_once` |
| N-3 | `node-on-worker` | validation | `network_node_role` |
| N-4 | `worker-shared` | validation | `network_worker_shared` |
| N-5 | `without-declaration` | validation | `network_without_declaration` |
| N-6 | `minimum-version` | validation | `network_minimum_version` |
| N-7 | `entry-unknown` | validation | `network_entry_unknown` |
| N-8 | `role-unknown` | validation | `network_role_unknown` |
| N-9 | `role-coordinator` | validation | `network_role_coordinator` |
| N-10 | `role-reserved` | validation | `network_role_reserved` |
| N-11 | `edge-unknown` | validation | `network_edge_unknown` |
| N-12 | `edge-duplicate` | validation | `network_edge_duplicate` |
| N-13 | `dead-end` | validation | `network_role_dead_end` |
| N-14 | `state-schema-undeclared` | validation | `network_state_schema_undeclared` |
| N-15 | `state-schema-open` | validation | `network_state_schema_open` |
| N-16 | `state-key-undeclared` | validation | `network_state_key_undeclared` |
| N-17 | `initial-not-literal` | validation | `network_initial_literal` |
| N-18 | `initial-invalid` | validation | `network_initial_invalid` |
| N-19 | `message-schema-undeclared` | validation | `network_message_schema_undeclared` |
| N-20 | `read-outside-view` | validation | `network_state_read_outside_view` |
| N-21 | `source-outside` | validation | `network_source_scope` |
| N-22 | `write-outside-view` | validation | `network_state_write_outside_view` |
| N-23 | `step-duplicate` | validation | `network_step_duplicate` |
| N-24 | `route-task-unknown` | validation | `network_route_task_unknown` |
| N-25 | `edge-undeclared` | validation | `network_edge_undeclared` |
| N-26 | `end-not-allowed` | validation | `network_end_not_allowed` |
| N-27 | `bound-exceeds-budget` | validation | `network_bound_exceeds_budget` |
| N-28 | `once-memory` | grants | `execution_grant_unsupported` |
| N-29 | `once-model` | grants | `execution_grant_unsupported` |
| N-30 | `route-cap-too-large` | host | `execution_output_cap_too_large` at `delegate/Desk/route` |
| N-31 | `hops-exhausted` | run | `model_error` (`hops_exhausted`, chosen by the model at the hop cap) |
| N-32 | `edge-exhausted` | run | `model_error` (`edge_exhausted`) |
| N-33 | `role-exhausted` | run | `model_error` (`role_exhausted`) |
| N-34 | `target-not-in-enum` | run | `schema_validation` at the route; no decision recorded |
| N-35 | `message-invalid` | run | `schema_validation` at the route; no decision recorded |
| N-36 | `budget-overrun-in-role` | run | `budget_exhausted` at `delegate/Writer/draft` (`worker_token_budget`) |
| N-37 | `reservation-refused` | run | `budget_exhausted`: `network.refused` (`tokens`), no activation |
| N-38 | `patch-outside-schema` | run | `schema_validation` at the network state, after three commits; the Writer's fixed route is never decided (three `route.decided`) |
| N-39 | `fixed-route-exhausted` | run | `budget_exhausted` (`edge_exhausted`, chosen by the package) |
| N-40 | `fixture-walk` | run | control: completed; Desk 3, Lookup 1, Writer 1; 4 hops; 7 model calls |
| N-41 | `two-lookups` | run | control: completed; two lookups within the caps |
| N-42 | `end-only` | run | control: completed; the entry ends at once, no handoff |
| N-43 | `read-uninitialized` | validation | `network_state_read_uninitialized` (a view key `initial` does not set) |
| N-44 | `patch-outside-schema-chosen` | run | `schema_validation` at the network state in the entry's first activation, before its chosen route: no `route.decided`, one model call (the step), nothing committed |
| N-45 | `answer-check-refused-in-role` | run | `model_error` at `delegate/Writer/draft` (`failed_check.check = "answer_check"`), after three commits; the Writer's route is never decided |
| N-46 | `answer-check-in-role` | run | control: completed; the Writer's answer check passes; Desk 3, Lookup 1, Writer 1; 4 hops; 7 model calls |

The reference asserts every row (`test_network_cases.py`) and, in `test_network_runtime.py`,
the activation timeout, the per-tool cap across activations, the input against the message
schema, the transition check in depth, the route request and its schema, the records of
`inspect`, the control plane and the plan, the CLI, the `once` counts, and a conversation turn
running a network with the gate reaching a role's tool step. The catalog v2's delegation family
starts from this table (D-189).

## 8. The test package and the travel example

`org.webagents.network-test` 0.1.0 ([`examples/network/network-test/`](../examples/network/network-test/README.md)),
a fictional help desk: `Desk` (the entry; one model step, a chosen route) hands off to `Lookup`
(one local tool over a fictional index, a fixed return) at most twice or `Writer` (one model
step, a fixed return) once, within six handoffs, and ends with its answer; the shared state holds
the notes, the answers and the draft. Its fixture walk is Desk, Lookup, Desk, Writer, Desk, done.
Its bound: Desk at most 4 times, Lookup 2, Writer 1; 9 model calls, 2 lookups, 18 remote calls
and 20,000 tokens of a 24,000 budget, within six handoffs. It is signed with a development key (`examples/keys/network-test-publisher.pub.pem`)
for the test suites and the conformance suite and is not shipped in `dist/`;
`agentpkg run examples/network/network-test.agent.pkg --mode fixture --grants examples/network/network-test-grants.json --approve-tool lookup --trust-key examples/keys/network-test-publisher.pub.pem --out <new dir>`
runs it.

`org.webagents.travel-network` 0.1.0 ([`examples/network/travel-network/`](../examples/network/travel-network/README.md)),
an unsigned source in T25 (T26 ships it signed from `agents/`): `FrontMan` restates the trip and,
at a chosen route, consults `Flights`, `Hotel` and `Calendar` (each a local fictional tool and a
fixed return), each at most once within six handoffs, then ends with the plan. A star: the bound
is exact (FrontMan at most 4 times, the specialists once each; 8 model calls, one call of each
tool, 16 remote calls, 32,000 tokens), attained by the full tour, which is the fixture walk.
Sixteen walks; `test_network_travel.py` runs every one. All data is fictional; nothing is booked.

Both sources are generated by `examples/network/make_network_examples.py` (so the route cases
carry the runtime's exact request data, R-27) and a test asserts the committed files are its
output.

## 9. Versions, deliberate limits, prior art

**Versions.** agentpkg 0.7.0 implements this document; packages that use it declare
`runtime.minimum_version: "0.7.0"`. The Chrome core stays 0.4.0 with `SUPPORTED_RUNTIME_VERSION`
0.6.0 until T26 ports the runner and the bound, wires the cases into the conformance suite and
puts "at most" on the agent page; its `version.test.ts` accepts the pair (0.7.0, 0.6.0) until
then. The OpenClaw plugin stays frozen (D-029) and its execution host refuses 0.7.0 packages by
version. The paper line is untouched.

**Deliberate limits of v0.** No remote roles; no roles created at run time; no nesting (a
call-and-return is two edges, and the hop cap bounds it); no loop inside a role (a program is
straight-line; the only loop is the network's, bounded); no consent step inside a role; no
re-ask in the reference; one network per graph; the exact maximum over walks is a test figure,
the normative bound is the relaxation; the worst case counts activations and calls, not the
semantic quality of a handoff; the availability in the request data is advice to the model, the
check is the runtime's.

**Prior art.** Neuro-SAN (HOCON agent networks, AAOSA: a front-man asks down-chain agents and
composes their answers; `sly_data`) is the declared-network precedent, run on the publisher's
server with no per-role budget and no bound stated to the user; handoffs in agent frameworks
(a model picks the next agent among a list) are the chain model without caps; the deck's §14
(max delegation depth, approved sub-agent lists, budget per sub-agent, a full audit trail) is
what this profile makes checkable before the run; conversation.v0's whole-turn reservation
(V-10) is the pattern of R-17; workflow.v0's answer checks (§5) are the pattern of R-14.
