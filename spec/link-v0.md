# link.v0: Agent Links, one publisher's package asking another's for help

Status: experimental, normative for agentpkg **0.8.0** (D-680…D-689, D-690…D-699; the Chrome
core's port is T66). The enclosing agent.pkg format stays 0.1 and `workflow.v0` stays the execution
profile: this document gives the manifest's `dependencies` their meaning and adds one step and node
type, `link`, in two forms, and nine audit events. Machine contracts live beside it in
[`spec/link-v0/`](link-v0/): the RFC 6902 patches for `workflow.schema.json` and
`manifest.schema.json`, and [`cases.json`](../examples/link/cases/cases.json), the enforcement
cases both runtimes must refuse identically. Rules are numbered **L-n** so that a test can cite
one; negative cases **N-n** in §10 map to `cases.json` ids.

Vocabulary. The **caller** is the package the person opened. A **linked package** is another
package the caller's signed program names: a **planned link** names it as a **dependency**, pinned
by digest before signing; a **slot** leaves the provider open and binds it during the run, by a
**join**. An **inner run** is one run of a linked package's own program, started by a `link` step
of the caller. The **card** is what the person is shown about one linked publisher; its decision
is that package's authorization. The **composed bound** is the caller's worst case with every
link's worst case inside it; "at most" is that vector. Nothing a package carries is ever authority
(D-005): a link names a package, the person's runtime verifies it, and the person decides.

## 1. Purpose and what v0 refuses

A page links to a page; an agent package could not ask another publisher's package for help. The
frameworks that link agents link a **service**: the request goes to the other operator's server,
that operator's model runs it, and what it costs and where the data went are outside the caller's
accounting. link.v0 links a **program**: the caller names another publisher's signed package, the
person's runtime fetches and verifies it, the person decides on that publisher as if they had
opened its package, and the linked program runs in the person's runtime on the person's model,
inside a worst case computed across the links before consent. A linked package holds what the
person granted it and nothing of its caller's. What is not verified is whether the linked
package's answer is good, and what the recipients its own plan names do with what they receive.

L-1. **Refused in v0**, each before the boundary it bounds, with the codes of §9: a linked
package that is conversational (B-284); a linked package, a dependency's or a join candidate's,
that declares dependencies of its own or whose graph holds a `link` step of either form, and a
dependency that names the caller's own package (depth one, B-285); a dependency without a digest
or with a locator that is not HTTPS; a slot outside a role's program; a slot whose `locate` reads
anything but the run's input or a tool step's result; a slot whose `input` is not an object of
named fields; more than the caps of L-2, L-6, L-7
and L-39; a remote linked agent (a link is a program run here, never a service).

## 2. Declarations

### 2.1 The dependency record

L-2. `MANIFEST.agent`'s `dependencies` lists at most **8** records
`{id, package_id, version, digest, locator, signer?}`: `id` is the name the caller's graph uses
(unique, `link_dependency_duplicate`); `package_id` and `version` are the linked package's own;
`digest` is its package digest (64 hex); `locator` is an `https://` URL (`link_locator_scheme`; a
`nanda:` locator names no bytes a runtime can fetch today); the optional `signer` is the
publisher key's fingerprint (`sha256:<64 hex>`) the caller expects. A record without an `id`, or
one no `link` step names, is refused (`link_dependency_unused`): a dependency that is declared is
fetched, verified and shown to the person, so it must be used. A record whose `package_id` is the
caller's own is a cycle (`link_nested`).

### 2.2 The planned link

L-3. A `link` step or node names a dependency:

```json
{"id": "search", "type": "link", "dependency": "webair-flights",
 "input": {"object": {"origin": {"from": "state", "path": "/trip/origin"}, "…": "…"}},
 "output_schema": "schemas/flights-result.schema.json", "timeout_seconds": 300}
```

It is admitted where an effectful operation is: as a top-level node on a non-coordinator worker
(with `worker`, `depends_on`, `writes`), as a map step, and as a step of a network.v0 role. It
may carry `when` and `otherwise` as any operation. `dependency` names a declared record
(`link_dependency_unknown`).

L-4. **The input.** `input` is a constructor over the step's ordinary scope and nothing else: for
a node, the worker's `state_read`; for a map step, `state`, `item` and its earlier `steps`; for a
role step, the role's view, the `message` and its earlier `steps`. The scope rules are
workflow.v0's and network.v0's, unchanged: a link's input that reads outside the role's view is
`network_state_read_outside_view`. The value is the linked package's whole input; nothing else of
the caller reaches the inner run (L-25).

L-5. **The result.** The inner run validates its result against the linked package's own
`output_schema`, as every run does; the step then validates it against its own `output_schema`,
a declared schema of the caller, which is what the caller's program is typed against. A result
the linked package accepts and the caller's schema does not fails the step (L-27).

### 2.3 The slot

L-6. A `link` step may name a **slot** instead of a dependency:

```json
{"id": "ask", "type": "link", "slot": "named-hotel",
 "locate": {"coalesce": [{"from": "input", "path": "/hotel_url"},
                         {"from": "steps", "path": "/find/results/0/url"}]},
 "input": {"object": {"city": {"from": "state", "path": "/trip/destination"}, "…": "…"}},
 "request": {"task": "request", "max_output_tokens": 1500},
 "reason": {"literal": "The hotel you named is not among the aggregator's."},
 "max_joins": 1,
 "budget": {"model_calls": 2, "tool_calls": 2, "compute_calls": 0, "remote_calls": 6, "tokens": 12000},
 "output_schema": "schemas/join-outcome.schema.json", "timeout_seconds": 300}
```

A slot is a step of a role's program and nowhere else (`link_slot_scope`: not a top-level node,
not a map step, never on the coordinator); a graph holds at most **2** slot steps, with distinct
slot ids, none of them a dependency's id (`link_caps`, `link_slot_duplicate`: a slot and a
dependency share the names of the usage record and the audit). `input` is the **view**: what the request to a
joined package may draw from. It is an `object` constructor and no other form
(`link_slot_input`): its field names are what the card states (L-34) and its value is all the
request-building call is handed (L-37), so the card names everything that may be sent; each
field's own constructor is under L-4's scope. `request` names a declared model task and the
output cap of the request-building call (L-37; `link_request_task_unknown`). `reason`, optional,
is a constructor of at most 500 characters shown on the card as the agent's words. `max_joins`
(1…2) caps the cards this slot may show in a run. `budget` is the **ceiling**: every figure the
"at most" names, for one join; a figure left out is zero; `tool_calls` is the total over the
joined package's own tools, whose names are unknown before the join; `timeout_seconds` is its
seconds.

L-7. **`locate`** yields the URLs to look at: a reference, an `array` of references, or a
`coalesce` of those, at most **3** references in all (`link_caps`). A reference reads one of two
sources and no other (`link_locate_source`): (a) `input`, the run's own input instance as the
person supplied it, a source `locate` alone may name inside a role; or (b) `steps`, the result of
an earlier `tool` step of the same role. Either way the schema at the pointer is a string of
`format: uri` (nullable allowed). The role's view of the shared state, the message and the result
of an `llm`, `compute`, `join`, `validate` or `link` step are refused: a model can write each of
them. A reference that selects nothing, or null, yields no URL; a `coalesce` yields its first
member that yields a URL (so an address the person gave is looked at instead of a search
result's, not beside it); an `array` yields its members' URLs in order, each once; a value that
is not an `https://` URL the discovery policy admits is listed as refused and not looked at. The address a runtime looks at before the
person decides is therefore the person's or an approved tool's, never a model's (L-40).

L-8. **The outcome.** A slot step never fails on account of the candidate: its result is
`{"joined": boolean, "reason": string | null, "result": <the joined package's result> | null}`,
built by the runtime, with `reason` one of L-33's when `joined` is false, and validated against
the step's `output_schema`, which the package declares as a closed object over those three
members (`link_slot_outcome_schema`). A refused or failed join is data to the caller's program,
which may fall back.

### 2.4 Versions

L-9. A manifest with a dependency, or a graph with a `link` step, declares
`runtime.minimum_version` **0.8.0** or later (`link_minimum_version`), so that an older runtime
refuses the package by its version before it meets the type (D-188).

## 3. Preparation and consent

L-10. **Resolution.** Before the caller is authorized, the host resolves every dependency: it
obtains the bytes from the record's `locator` under the package-URL policy, unchanged (HTTPS, a
public address, a pinned connection, no redirect, a byte cap; `browser/fetch.py`), or takes an
archive the person supplied for that id, accepted only by its digest; it snapshots the bytes and
verifies them as it verifies any package: container, integrity, schemas and a runtime version
it supports (`link_package_invalid`, with the validator's reason), and a **valid signature**,
which a link always requires (`link_signature_invalid`), since a link crosses publishers. A fetch the policy refuses or that fails is `link_fetch_failed`. Resolution is
preparation: nothing of a linked package runs.

L-11. **The checks**, in this order, each refusing the caller's plan: the package's `package_id`
and `version` are the record's (`link_identity_mismatch`); its digest is the pinned one
(`link_digest_mismatch`); its signer is the declared `signer` where one is declared
(`link_signer_mismatch`); it is a one-shot workflow.v0 package, not a conversation
(`link_target_conversational`); it declares no dependency and its graph holds no `link` step of
either form (`link_nested`).

L-12. **Trust is the person's.** The linked package's signer is evaluated against the person's
own trust store exactly as if the package had been opened directly, and reported as a separate
fact per publisher ("signature valid, publisher unknown"). The caller's trust state never extends
to a linked publisher, and the caller's declared `signer` is a check, not a pin.

A host whose policy requires a trusted publisher (the control plane's default; the CLI in live
mode) accepts a link only once its key is pinned (`link_publisher_untrusted`; in the control
plane, the linked package's own authorization is not runnable).

L-13. **One review, one card per publisher.** The review before the run lists the caller and
every linked package, grouped by publisher key, each with its trust state, its requirements (its
permissions, tools with their endpoints, records by type, model needs) and its worst case
(L-18). The person decides per dependency: **accepted**, with that package's grants and tool
approvals, or **denied**. A denial is of the publisher's key for the run: every dependency that
key signed is denied, and a join candidate it signed is refused without a card (L-33).

L-14. **The inner plan.** An accepted dependency gets its own receipt and its own inner Run
Plan, prepared as any package's: its grants are the person's decisions on its card within its
own declaration; its tool bindings, approvals and resources are its own; its model route is the
caller's (a linked package whose model requirements the route does not meet is
`link_model_incompatible`). The inner plan carries `parent: {package_digest, dependency}`, the
caller's digest and the dependency's id, and is hash-bound over it.

L-15. **The caller's plan** records `links: {<id>: {package_id, version, digest,
archive_sha256, signer, trust, decision, plan_hash}}` (`plan_hash` null for a denied link) and is
hash-bound over it. Re-verification before a run covers every inner plan (its package, receipt,
publisher and bindings, as the caller's): a caller's plan is stale when an inner plan it names
was cleared, changed or is itself stale. An inner plan whose `parent` is not this caller, or for
a join not this run, is refused (`link_plan_parent_mismatch`) by re-verification and again by
the execution host, which is handed each accepted link's inner plan and archive, verifies the
archive itself, and takes from the caller's plan only which inner plan the person agreed to.
It applies to each inner plan and its authorization the checks it applies to the caller's
(required permissions, tool bindings and approvals, resources), and refuses an inner plan that
is not a model-backed plan on the caller's model route (`execution_plan_invalid`).

**An inner plan is authority only inside its caller's run.** A plan that carries `parent` is
never a run's own plan: an execution host handed one as the caller's plan refuses it
(`link_plan_parent_mismatch`), so a linked package cannot run outside the caller's composition,
reservation and audit on the grants the person gave on a link's card. A host that hands out
package bytes on a lease hands a linked package's only beside its caller's: while the caller
holds a live lease on a plan that names this inner plan as accepted
(`link_lease_without_caller` otherwise), and a caller's released lease releases its linked
packages' leases with it. A tool probe is of one package: an inner plan always carries
`parent`, so this version has no tool probe of a linked package, and a caller's own probe is
handed its links as its run is.

L-16. **A denied link** is unbound, as a denied optional capability is: the plan states it; the
composed bound leaves it out (L-22); a role whose program holds a denied `link` step cannot
complete, so it leaves every route's enum and target list, and a fixed route to it is refused at
the transition check (`permission_denied`, the decision recorded with `reason: "link_denied"`); a network whose entry holds one, and a run that
reaches a denied top-level node or map step, fails there `permission_denied`, recorded
`link.denied`. No inner run of a denied publisher ever starts. A key the person declines on a
join card during the run (L-35) is denied from that decision on: a step that then reaches a
planned link that key signed fails the same way, `permission_denied` with `link.denied`. The
routes' enums and the bound are the plan's and are not recomputed during the run.

L-17. **No person, no question.** A run without a person starts only when every dependency is
already decided; an undecided one refuses the plan (`link_undecided`).

## 4. The composed worst case

L-18. **The worst case of a package**, W(p), is computed from its declaration alone. For a
workflow.v0 graph: `model_calls` = its top-level `llm` nodes, plus for each map its `llm` steps
times `max_items`, plus its network's bound (network.v0 R-21); `tool_calls[τ]` = the same count
over the `tool` nodes and steps naming τ, capped by the package's `max_calls_per_tool[τ]`;
`compute_calls` = the same count over `compute`; `remote_calls` = its `max_remote_calls`;
`tokens` = its `hard_tokens` (where the network node is the graph's only spending node, the
network's own bound for each, which is never higher); `seconds` = its `deadline_seconds`. A
conditional operation counts as taken. The first three are exact for the program; the last three are the caps its own run
enforces. With links, W(p) adds each link's cost (L-19): the rule is recursive, and v0 admits
depth one.

L-19. **A link's cost** is W(linked), entered where the step is: a top-level node once; a map
step times `max_items`; a role step once per activation, added to network.v0's per-activation
cost (R-19) in `model_calls`, `tool_calls` (qualified `<dependency>:<tool>`, so that a linked
tool is never confused with the caller's), `compute_calls`, `remote_calls` and `tokens`. The
link's tokens and remote calls stand **beside** the role worker's budget, which keeps meaning the
role's own calls; its seconds are inside the role's `timeout_seconds` (L-25), so `seconds` is
unchanged. R-20's activation bound and R-21's greedy relaxation then run over the composed
costs.

L-20. **Within the caller's budget.** The composed relaxation's tokens and remote calls must not
exceed the caller's own `hard_tokens` and `max_remote_calls` (`link_bound_exceeds_budget`), as
R-22 requires of a network: what the page says the composition can spend at most is what the
caller's package lets it spend. The check needs the linked declarations, so it is made at
preparation, once every dependency is resolved.

L-21. **A slot's cost** is its ceiling plus one model call, the request-building call (L-37),
which is a call of the role's worker inside that worker's budget. It enters L-19 as a planned
link's cost does, with `tool_calls` qualified `<slot>:*`, and L-20's check, which for a slot is
made when the caller is validated, since the ceiling is the caller's own declaration. The "at
most" shown before consent therefore holds every join, and a join never changes it. The slot's
own reads (at most three pages looked at and one package fetched per join) are the runtime's,
stated in words, and counted as neither tool nor remote calls.

L-22. **What the person is told.** `inspect`, the control plane's summary and the Run Plan state
the composed envelope and name every linked package with its own worst case; for a slot, in
words, "and, for a package joined during the run, at most …". A denied link is left out of the
envelope: a role that holds it has an activation bound of zero, and its own edges, never
taken, count for no other role's bound. Every figure is a theorem
about the signed declarations, the caller's and the pinned ones: a run can stay below it and
cannot pass it.

## 5. Execution

L-23. **The input instance.** When a `link` step runs, its constructed input is validated
against the linked package's `input_schema` before anything else: an instance outside it fails
the step `schema_validation` (`failed_check: {check: "link_input"}`); nothing is reserved and no
inner run starts.

L-24. **The reservation.** The linked package's worst case under the effective limits (its own
caps as the host lowered them) must fit what the run has left in tokens and remote calls;
otherwise the step is refused before anything is spent (`link.refused` with `reason: tokens |
remote_calls`, the step `budget_exhausted`), unless the person raises their own limit (§7). A
caller that declares `approval_threshold_tokens` meets it here as at a model call: where the
tokens spent and held plus the reservation would pass the threshold, the step is refused the
same way (`reason: approval_threshold`); §7's raise does not apply to it. The checks run in
that order (tokens, remote calls, the threshold), and the first that fails names the reason.
The reservation is **held** until settlement, so that parallel work cannot spend it.

L-25. **The inner run** is a run of the linked package's own program from its inner plan: its
own run id, audit chain, grants, tool bindings, approvals, resources and counters; the caller's
model route; token and remote-call limits that are the minimum of its declared caps, the host's
limits and the reservation; a deadline that is the minimum of its own and the step's
`timeout_seconds`. It receives the validated input instance and returns its validated result.
Nothing else crosses: no grant, tool, resource, record, state key or message of the caller, and
nothing of the inner run's state or audit reaches the caller's program.

The model route is the caller's and the accounting is the inner run's: an inner run's model
requests go to the route the caller's plan binds, each is reserved, counted and recorded
(`model.called`, `model.completed`, with the request's hash) by the inner run's own mediator in
its own chain, and none appears in the caller's chain. What the caller's chain holds of an
inner run is `link.started` and `link.completed` or `link.failed`. A reader that looks for what
a linked package sent to the model reads the inner chain.

L-26. **Settlement.** `link.started` is recorded before the inner run and `link.completed` or
`link.failed` after it. Every counter a run's usage keeps then takes the inner run's reported
figure: **tokens**, **remote calls**, **compute calls** and **tool calls** (qualified
`<dependency>:<tool>`, L-19). A run's usage keeps no model-call total (a model call is its
`model.called` event, in the chain of the run that made it), so an inner run's **model calls**
are stated per link only. The usage record therefore reads:

- `tokens`, `remote_calls`, `tool_calls`: the caller's own and every inner run's;
- `compute_calls`: likewise; present exactly when the caller's graph declares modules **or the
  run holds links** (a package without either keeps the record it had before);
- `links: {<dependency>: {runs, tokens, remote_calls, model_calls, tool_calls, compute_calls}}`,
  present exactly when the run holds links: each link's inner runs summed, its tool calls under
  the linked package's own tool ids. `runs` counts the inner runs that started. These figures
  are inside the totals above, except `model_calls`, which has no total.

An inner run whose usage is unknown consumes the reservation; where no inner run could be built
(L-27), nothing is charged. The run's totals and the composed bound are therefore enforced
across publishers, and one usage record holds every call.

L-27. **Failures.** An inner run that fails fails the step `link_error`; `link.failed` names
the inner run's own code, and the inner record keeps its audit. An inner run that could not be
built (the host could not start it) fails the step the same way: `link.failed` with
`inner_run_id: null` and the cause's code, no `link.started`, the reservation released and
nothing charged. A step that passes its `timeout_seconds` fails `timeout` at the step; the
inner run was cancelled by it, so `link.failed` says `cancelled`, and the inner record ends
there. A result outside the step's `output_schema` fails the step `schema_validation`
(`failed_check: {check: "link_result"}`) after `link.completed`. A step that reaches a denied
link is L-16's.

L-28. **`once`.** A `once` grant on a linked package's card is refused before the run where the
composition could consume that permission more than once: a link reached more than once (a map,
a role whose activation bound is above one), or an inner program that consumes it more than once
(`execution_grant_unsupported`, network.v0 R-26's rule across a link).

L-29. **Fixture mode.** An inner run replays the linked package's own fixture: its model and
tool cases, by exact input, as a direct fixture run of that package does. Nothing in a fixture
grants, routes or links. Fixture mode touches no network, a slot's look included: a slot looks
at a recorded web (§10's join fixture) and at nothing else, and a fixture that records no web
is a web with nothing in it, so every look ends `not_found`. A joined package that carries no
fixture cannot be replayed: its join is `failed` (L-38).

L-30. **The record.** A run that holds links writes, beside its own `result.json`,
`audit.json`, `usage.json` and `provenance.json`:

- **`links.json`**, the run's links:

  ```
  {"schema": "agentpkg-run-links-v0",
   "links": [{"dependency", "package_id", "name", "version", "digest", "archive_sha256",
              "signer", "trust", "decision": "accepted" | "denied",
              "worst_case": {model_calls, tool_calls, compute_calls, remote_calls, tokens,
                             seconds} | null,
              "plan": <the inner plan> | null, "plan_hash": <its hash> | null}, …],
   "runs":  [{"inner_run_id", "dependency" | "slot", "node_id",
              "status": "completed" | "failed", "error_code": <the inner run's code> | null}, …],
   "joins": [{"node_id", "slot", "joined", "accepted", "decided_by", "reason", "provenance",
              "candidate", "worst_case", "inner_plan_hash", "figure"?,
              "package": {the joined package's facts, "worst_case", "plan", "plan_hash"} | null},
             …],
   "caller_plan": <the plan the run was decided under>, "caller_plan_hash": <its hash>}
  ```

  `joins` is present exactly when the caller's graph holds a slot: one entry per slot step that
  ran, in order, with `link.decided`'s members (L-45), `joined` (true only when the inner run
  completed; `reason` is `failed` when it did not) and, for an accepted join, the joined
  package as a link's entry states it, with the inner plan of L-36. `caller_plan` and
  `caller_plan_hash` are present where the host states the plan a decision made during the run
  names (L-36): a host without a control plane states its operator plan there when a person can
  be asked during the run, and a record without either is what a planned-link run writes.

  `links` is ordered by dependency id, one entry per declared dependency; `runs` is in the
  order the inner runs ended, one entry per inner run that started. `plan` is the inner plan
  the person's decision produced: the link plan of a host without a control plane (D-691:
  `{schema: "agentpkg-link-plan-v0", parent, package, publisher, decisions, tool_approvals,
  worst_case}`, whose canonical SHA-256 is `plan_hash`), or the inner Run Plan's bounded facts
  with its own `run_plan_sha256`. A denied link has `plan` and `plan_hash` null; where the host
  holds no archive for it (an execution host is handed none), `name` and `worst_case` are
  absent or null too.
- **each inner run's own record**, under flat names (a run's artifact directory holds no
  subdirectory): `link-<inner_run_id>.result.json`, `.audit.json`, `.usage.json` and
  `.provenance.json`, each what a direct run of the linked package writes under those names.

The caller's `result.json` carries the same `links` record and does not repeat the inner runs'
reports. A package with links exports nothing named `links.json` or beginning `link-`.
Messages, inputs and results are hashed in the caller's audit, never recorded.

## 6. The join

L-31. **The sequence.** A slot step proceeds in this order and stops at the first refusal: a
person is present (L-33 `unattended`); joins are not forbidden by the host's policy (`policy`);
the slot's and the run's caps are not spent (`join_cap`, L-39); `locate` is evaluated; each URL
is looked at in order by discovery, under its rules unchanged (one page, a byte cap, no script, a
package location on the page's own origin, nothing fetched beyond the page; `browser/discovery.py`);
the candidate's package is fetched under the package-URL policy and verified (L-10); the
refusals before any card (L-33), the last of which is the reservation of the candidate's worst
case (L-24), **held from there to settlement**, so that what the card says the run has left is
there when the inner run starts; the card (L-34); the person's decision (L-35); the inner plan
(L-36); the request-building call (L-37), made beside the held reservation; the inner run
(L-25, L-26). The discovery and package fetches carry no body, cookie or referrer, and each is
recorded with `link.requested`, read or refused, before anything is decided.

L-32. **One candidate per step.** The first page that advertises a package gives the candidate;
a page that advertises none, or cannot be read, moves to the next URL. A candidate that fails
verification, does not fit or is declined ends the step: the runtime does not shop.

L-33. **Refused without a card**, as data (`joined: false` with the reason, recorded
`link.decided` with `decided_by: "runtime"`): `unattended` (no person; no page is looked at),
`policy`, `join_cap`, `not_found` (no URL, or no page advertised a package), `verification` (the
candidate's fetch or verification failed, a valid signature included), `conversational`,
`nested` (L-11's two profile checks; a candidate that is the caller's own package),
`publisher_denied` (the candidate's key was denied in this run, at the review or on an earlier
card), `model_incompatible`, `over_ceiling` (the candidate's own worst case exceeds the slot's
ceiling in some figure; `link.decided` names the first as `figure`, in the order model calls,
tool calls in total, compute calls, remote calls, tokens, seconds), `budget` (its reservation
does not fit what the run has left or would cross the caller's approval threshold; `figure`
names which; §7's raise is not asked for a join). The checks run in the order of this list, and
the first that fails names the reason. A worst case is computed only for a candidate that
passes the two profile checks: W(p) is defined for a one-shot workflow.v0 package one level
deep (L-18), so a `conversational` or `nested` candidate has none, and `link.decided` states
`worst_case: null` for it. Whatever a candidate's verified bytes hold, the outcome is one of
these reasons and never a failure of the caller's step (L-8).

L-34. **The card** shows facts the runtime computed: the publisher's key and its trust state in
the person's store; the package's id and version; its name and description, marked as the
publisher's words; its declared tools with their endpoints and permissions, the records it
requests by type, its model needs; the slot's view in words (the fields of `input`, which is
an object of named fields, L-6, so the names are all of it); the
candidate's own worst case, inside the ceiling; that the "at most" already accepted does not
change; what the run has left; and the slot's `reason`, marked as the agent's words. The facts
are one document (`schemas/link-join-card.schema.json`: `slot`, `publisher`, `package`,
`source`, `requirements`, `view`, `worst_case`, `ceiling`, `at_most_unchanged`, `left`,
`reason`, `cards`), validated before it is shown; two of its members carry words, the package's
`name` and `description` (the publisher's) and `reason` (the agent's). Nothing of the candidate
reaches the caller's model before the decision.

L-35. **The decision.** The default is no. The person accepts, with that package's grants and
approvals, or declines (`declined`); a card that is not answered within the step's time is
declined (`provenance: "timeout"`): the card's wait ends one second before the step's time
does, so that an unanswered card is a no and not the step's `timeout`. Every card shown counts
toward the caps, accepted or not, and a declined card denies the candidate's key for the rest
of the run (L-13): a later candidate that key signed is `publisher_denied`, and a planned link
it signed, accepted at the review, starts no further inner run (L-16); inner runs that ended
before the decision stand. The decision is
recorded with who made it and where it came from (`decided_by: "person"` for every card;
`provenance`: the host's surface, a fixture, `timeout`). Accepting the card of a publisher the
person's store does not know accepts that package for this run and pins nothing. A host
answers `{accepted, provenance}` and, when it accepts, the joined package's own `grants` and
`approved_tools`; an answer outside that contract, or one that names a permission or a tool the
package does not declare, is the host's failure (the step fails `worker_error`), never a yes.

L-36. **The inner plan of a join** is prepared with the card's grants, as L-14's, with `parent:
{plan_hash, run_id, slot}`: the caller's plan, this run, this slot. `plan_hash` is the hash of
the plan the run was decided under: the caller's Run Plan's, or, on a host without a control
plane, the canonical SHA-256 of its **operator plan** `{schema: "agentpkg-operator-plan-v0",
package: {package_id, version, digest}, decisions, tool_approvals, limits, links: {<id>:
{decision, decisions, tool_approvals}}}`, which the run record states (L-30). The caller's plan
is never rewritten: the join is the inner plan plus the caller's audit.

L-37. **The request-building call.** After an accepted decision, one model call by the role's
worker under the slot's `request` task builds the joined package's input: its data is exactly
`{"view": <the slot's input value>, "package": {"name", "description", "input_schema"}}`, no
message and no state beyond the view; `input_schema` is the joined package's input schema
bundled into one document as a route request's schema is, and the same document is the call's
output schema. The answer is then checked by the joined package's own validator. The call is
the caller's own, recorded at the slot step's id: a non-conforming answer fails the step as any
model call's does (`schema_validation`), a refused reservation is `budget_exhausted`.

L-38. **After the decision.** The inner run is started under the held reservation, settled
and recorded as a planned link's, named by its slot: `usage.links[<slot>]`, its tools
`<slot>:<tool>` in the caller's `tool_calls` (the bound holds them in total as `<slot>:*`). An
inner run that fails is `joined: false`, reason `failed`, with `link.failed` naming its code:
the candidate's failure is data. So is everything else a joined package's bytes cause after the
decision, since they are a third party's, found during the run: where the host cannot build
what the inner run is handed (its tool handlers; in fixture mode its replay) or the inner run
itself, the accepted `link.decided` stands, `link.failed` follows it with `inner_run_id: null`
and the cause's code (`worker_error` for what the runtime cannot classify), nothing is charged,
and the outcome is `failed`; the host's part comes before the request-building call, so no
model call is made for a package that cannot run. An error the inner run raises instead of
reporting is `link.failed` with its run id and the outcome `failed`. A planned link differs
(L-27): its package was pinned and checked at preparation, so only a classified failure is a
`link_error` there.

**The step's time.** The look, the card and the request-building call are the caller's own
and run inside the step's `timeout_seconds`. The inner run of a join has what is left of that
time less one second: one that is still running then is ended by the runtime, `link.failed`
says `cancelled` (as L-27's), and the outcome is `failed`. After an accepted decision, a slot
step's own `timeout` can therefore come only from the request-building call.

L-39. **The caps.** A slot shows at most `max_joins` cards in a run; a run shows at most **2**
in all. Past a cap no card is shown, and the run's end summary counts the refused joins.

L-40. **The residual, named.** `locate` may read the URL fields of a tool's validated result. A
tool whose result carries a URL may echo its own arguments into it (a search service that
returns its query in a result's address), so text a model wrote into that tool's arguments can
reach the host the slot looks at. That exposure is no wider than the approved tool call: the
tool's host already received the arguments. A search service that ranks a hostile page first
chooses which page is looked at; the fetch grants nothing, and the candidate is judged by its own
key on the card.

## 7. The budget-raise request

L-41. **When.** A reservation, a model call's or a link's, that fails on the **person's** run
limit (the host's token or remote-call limit, where the package's own cap is higher) may be
answered by a request to raise that limit, when a person is present and no raise was asked in
this run. The reservations are the token reservation of a model call and a planned link's
reservation in tokens or remote calls. A reservation that fails on the package's own cap (its
`hard_tokens` or `max_remote_calls`, a role's own budget) is refused as before: the
publisher's ceiling is not the person's to raise, and the "at most" was computed from it. No
raise is asked for the approval threshold, for a slot's `budget` refusal (data, L-33), or by an
inner run, whose limits are its reservation.

L-42. **The amount** is what the failed reservation needs beyond the limit: the new limit `to`
is what the run has spent and holds plus the reservation, exactly. A card is shown only when
`to − from` is at most half of the plan's host limit (rounded down), `to` is at most the
package's own cap, and every other bound would then admit the reservation (the role's own
budget, the approval threshold, the other figure of a link's reservation). Otherwise no card is
shown and the refusal stands.

L-43. **The card** shows the limit, the usage so far, the reservation that failed and the step
it is for, the new limit asked, the package's own cap, and the step's `reason` where it has
one, marked as the agent's words (`schemas/budget-raise-card.schema.json`: `limit`, `from`,
`to`, `needed`, `used`, `package_cap`, `node_id`, `reason`). The default is no. Denied,
unanswered within the card's time or unattended, the step fails `budget_exhausted` as it would
have. The card's time is 120 seconds in the reference and never past the operation that asks:
it ends one second before the enclosing step's, node's or role activation's own time does, so
an unanswered card is the refusal of before and not that operation's `timeout`.

L-44. **The decision** is recorded `budget.requested {limit: "tokens" | "remote_calls", from,
to, needed, plan_hash}` when the card is shown and, when accepted, `budget.raised {limit, from,
to, decided_by, provenance, plan_hash}`, naming the plan it was decided for (L-36's hash) in an
event that is this run's (`run_id`); a denied request stands alone in the audit. The effective
limit becomes `to`, the usage record states it, and the plan is not rewritten. One request per
run, whatever its answer.

**Properties.** This specification implements LK-1…LK-8 and extends P-1, P-2, P-4, P-5, P-7, P-9, P-17 and P-18 of [the security and privacy model](../docs/security-and-privacy-model.md#3-properties); a change to one of them is a new version of both documents (D-336).

## 8. Audit

L-45. Beside workflow.v0's and network.v0's events, in the caller's chain:
`link.started {node_id, dependency | slot, package_id, digest, inner_plan_hash, inner_run_id,
reserved: {tokens, remote_calls}, input_hash}` before an inner run; `link.completed {node_id,
inner_run_id, usage, result_hash}` or `link.failed {node_id, inner_run_id, error_code, usage}`
after it (`inner_run_id` null and no `link.started` where no inner run could be built, L-27);
`link.refused {node_id, dependency | slot, reason: "tokens" | "remote_calls" |
"approval_threshold", needed, tokens_left, remote_calls_left}` for a refused reservation
(L-24); `link.denied {node_id, dependency}` when a step
reaches a denied link, denied at the review or by a card declined earlier in the run (L-35); `link.requested {node_id, slot, fetches: [{url, kind: "discovery" |
"package", status}], candidate: {package_id, version, digest, signer} | null}` when a slot has
looked (not for `unattended`, `policy`, `join_cap` or a `locate` that yielded no URL: nothing
was looked at); `link.decided {node_id, slot, accepted, decided_by: "person" | "runtime",
reason, provenance, candidate, worst_case, inner_plan_hash, figure?}` for every outcome of a
slot step, refused without a card or decided on one (`candidate` and `worst_case` null where
no candidate verified; `worst_case` null too for a `conversational` or `nested` candidate,
L-33; `inner_plan_hash` null unless accepted); a join's `link.started`,
`link.completed`, `link.failed` name the `slot` where a planned link's name the `dependency`
(`link.failed` with `inner_run_id: null` after an accepted `link.decided` where the joined
package's inner run could not be built, L-38);
`budget.requested` and `budget.raised` (L-44). A `link` step's
`node_id` is its qualified id (`<node>/<role>/<step>` in a network). The inner run's own events
are in its own chain, under its own run id.

## 9. Refusal codes

| Where | Codes |
|---|---|
| validation (the caller's package) | `link_minimum_version`, `link_dependency_unknown`, `link_dependency_duplicate`, `link_dependency_unused`, `link_locator_scheme`, `link_nested` (a dependency naming the caller), `link_caps`, `link_slot_scope`, `link_slot_duplicate`, `link_slot_input`, `link_locate_source`, `link_request_task_unknown`, `link_slot_outcome_schema`, `link_bound_exceeds_budget` (a slot's ceiling); a link's input beyond a role's view: `network_state_read_outside_view` |
| preparation (resolution, the composed check) | `link_fetch_failed`, `link_package_invalid`, `link_signature_invalid`, `link_identity_mismatch`, `link_digest_mismatch`, `link_signer_mismatch`, `link_target_conversational`, `link_nested`, `link_model_incompatible`, `link_publisher_untrusted` (a host that requires a trusted publisher), `link_bound_exceeds_budget`, `link_unresolved`, `link_undecided` |
| re-verification of a caller's plan (stale reasons) | `link_plan_cleared`, `link_plan_changed`, `link_plan_stale`, `link_plan_parent_mismatch` |
| a lease on a linked package's bytes | `link_lease_without_caller` (no live lease of its caller on a plan that names this inner plan) |
| the execution host | `link_plan_parent_mismatch` (the inner plan handed over is not the one the caller's plan names, or names another caller; an inner plan handed over as a caller's plan), `execution_plan_invalid` (a plan without its links, an accepted link without its inner plan or archive, an inner plan that is not a model-backed plan on the caller's route), the artifact codes for a linked archive, L-11's codes again on the verified bytes, the authorization codes on an inner plan as on the caller's (`execution_permission_denied`, the tool-binding codes) |
| grants | `execution_grant_unsupported` (a `once` grant the composition would consume more than once) |
| at a `link` step | `schema_validation` (`link_input`, `link_result`), `budget_exhausted` (`link.refused`: `tokens`, `remote_calls`, `approval_threshold`), `permission_denied` (`link.denied`: denied at the review, or its key declined on a join card since), `link_error` (the inner run failed or could not be built; `link.failed` names its code), `timeout` (the step's time passed; `link.failed` says `cancelled`) |
| at a slot step | `schema_validation` or `model_error` (the request-building call's answer), `budget_exhausted` (that call's reservation), `worker_error` (the host answered a card outside the decision contract), `timeout` (the look or the request-building call passed the step's time; never the card or the joined package's inner run, L-35, L-38) |
| a slot's outcome (data, not a failure) | `unattended`, `policy`, `join_cap`, `not_found`, `verification`, `conversational`, `nested`, `publisher_denied`, `model_incompatible`, `over_ceiling`, `budget`, `declined`, `failed` |
| a raise (no code of its own) | a reservation that no raise admits fails `budget_exhausted` as before (`model.refused`, `link.refused`) |

A validation or preparation refusal's message starts with its code.

## 10. Negative cases

Each row is a case of [`cases.json`](../examples/link/cases/cases.json) (`id`), built by the
probe `agentpkg/tests/link_probe.py` and asserted by `agentpkg/tests/test_link_cases.py`. Stages:
`validation` (refused when the caller's package is validated); `prepare` (refused when its links
are resolved or its composed bound is checked, before the run starts); `grants` (the grant
check); `host` (the execution host refuses the plan it was handed); `run` (the run fails with
the code at the node named, or the control completes).

| N | `cases.json` id | Stage | Code (reason) |
|---|---|---|---|
| N-1 | `minimum-version` | validation | `link_minimum_version` |
| N-2 | `dependency-unknown` | validation | `link_dependency_unknown` |
| N-3 | `dependency-duplicate` | validation | `link_dependency_duplicate` |
| N-4 | `dependency-unused` | validation | `link_dependency_unused` |
| N-5 | `locator-scheme` | validation | `link_locator_scheme` |
| N-6 | `cycle` | validation | `link_nested` (a dependency naming the caller's own id) |
| N-7 | `input-outside-view` | validation | `network_state_read_outside_view` (a link's `input` beyond the role's view) |
| N-8 | `slot-in-map` | validation | `link_slot_scope` |
| N-9 | `slot-at-top-level` | validation | `link_slot_scope` |
| N-10 | `locate-source` | validation | `link_locate_source` (reads an `llm` step's output) |
| N-11 | `locate-message` | validation | `link_locate_source` (reads the message; the shared state likewise) |
| N-12 | `slot-caps` | validation | `link_caps` (four references) |
| N-13 | `slot-bound-exceeds-budget` | validation | `link_bound_exceeds_budget` (the ceiling) |
| N-14 | `digest-mismatch` | prepare | `link_digest_mismatch` |
| N-15 | `signer-mismatch` | prepare | `link_signer_mismatch` |
| N-16 | `identity-mismatch` | prepare | `link_identity_mismatch` |
| N-17 | `signature-absent` | prepare | `link_signature_invalid` |
| N-18 | `target-conversational` | prepare | `link_target_conversational` |
| N-19 | `nested` | prepare | `link_nested` (the dependency declares a dependency) |
| N-20 | `nested-slot` | prepare | `link_nested` (the dependency's graph holds a slot) |
| N-21 | `bound-exceeds-budget` | prepare | `link_bound_exceeds_budget` |
| N-22 | `model-incompatible` | prepare | `link_model_incompatible` |
| N-23 | `undecided` | prepare | `link_undecided` |
| N-24 | `once-across-link` | grants | `execution_grant_unsupported` |
| N-25 | `input-schema` | run | `schema_validation` (`link_input`); no `link.started` |
| N-26 | `result-schema` | run | `schema_validation` (`link_result`), after `link.completed` |
| N-27 | `grant-not-inherited` | run | `link_error`; the inner node `permission_denied`, on a permission kind the caller holds |
| N-28 | `reservation-refused` | run | `budget_exhausted`; `link.refused`, no `link.started` |
| N-29 | `inner-over-budget` | run | `link_error`; the inner run `budget_exhausted`; the caller's counters hold what it spent |
| N-30 | `denied-link-node` | run | `permission_denied`; `link.denied`, no inner run |
| N-31 | `denied-link-excluded` | run | control: completed; the denied role absent from the enum; no inner run of that key |
| N-32 | `planned-walk` | run | control: completed; both links; the composed model and tool calls attained |
| N-33 | `link-in-map` | run | control: completed; one inner run per item within `max_items` |
| N-34 | `inner-plan-replay` | host | `link_plan_parent_mismatch` (an inner plan under another parent, with another hash, or of another package) |
| N-35 | `unattended-join` | run | control: completed; `joined: false`, `unattended`; no fetch |
| N-36 | `join-declined` | run | control: completed; `declined`; no inner run and no request-building call |
| N-37 | `join-cap` | run | control: completed; the request past the cap is `join_cap`, no card |
| N-38 | `join-not-found` | run | control: completed; `not_found` |
| N-39 | `join-verification` | run | control: completed; `verification` (a tampered candidate) |
| N-40 | `join-nested` | run | control: completed; `nested`, no card |
| N-41 | `join-denied-publisher` | run | control: completed; `publisher_denied`, no card |
| N-42 | `join-over-ceiling-model-calls`, `-tool-calls`, `-compute-calls`, `-remote-calls`, `-tokens`, `-seconds` | run | control: completed; `over_ceiling` with that `figure`, six cases |
| N-43 | `join-budget` | run | control: completed; `budget` (`figure: tokens`) |
| N-44 | `join-request-nonconforming` | run | `schema_validation` at the request-building call, after the decision |
| N-45 | `join-inner-failed` | run | control: completed; `joined: false`, `failed`; `link.failed` |
| N-46 | `join-accepted` | run | control: completed; requested, decided, the request call, started, completed, in that order |
| N-47 | `raise-accepted` | run | control: completed; `budget.raised` names the run and the plan |
| N-48 | `raise-denied` | run | `budget_exhausted` |
| N-49 | `raise-unattended` | run | `budget_exhausted`; no card |
| N-50 | `package-cap-never-raised` | run | `budget_exhausted`; no card (the limit that failed is the package's: a role's own budget) |
| N-51 | `second-raise-refused` | run | `budget_exhausted`; one `budget.requested` in the run |
| N-52 | `linked-compute` | run | control: completed; a linked package's compute calls are in the caller's `usage.compute_calls`, its model calls under `usage.links` only (L-26) |
| N-53 | `approval-threshold` | run | `budget_exhausted`; `link.refused` with `approval_threshold`, no `link.started` for that link (L-24) |
| N-54 | `inner-plan-alone` | host | `link_plan_parent_mismatch` (an inner plan handed over as a caller's plan, L-15) |
| N-55 | `slot-input` | validation | `link_slot_input` (a slot whose `input` is a reference, not an object of named fields, L-6) |
| N-56 | `join-conversational` | run | control: completed; `conversational`, no card, `worst_case: null` (L-33) |
| N-57 | `declined-key-planned-link` | run | `permission_denied`; a card declined, then `link.denied` at the planned link that key signed, no inner run of it (L-35) |

N-1…N-34 and N-52…N-54 are the planned link's rows (N-52…N-54 were added after the first
review of the reference and keep the later numbers so that no cited number moves); N-35…N-51
are the join's and the raise's, and so are N-55…N-57, added after the review of the run-time
half. The list holds 62 cases: N-42 is six.

The cases of the run-time half carry a **join fixture** (`agentpkg-join-fixture-v0`, the
argument of `run --join-fixture`), which a conformance runner passes to either CLI: `pages`
(by URL: `body` or `body_base64`, optional `status` and `content_type`) and `packages` (by URL:
an archive's path beside the fixture) are a recorded web, replayed through the discovery and
package-URL code unchanged; `decisions.joins` (by slot, the cards' answers in order:
`{accepted, grants, approved_tools}`) and `decisions.raise` (`{accepted}`) are the person's
recorded answers (`provenance: "fixture"`). A card the recording does not answer is declined;
without `decisions` nobody is there to ask. Without `pages` and `packages` a fixture run looks
at an empty recorded web (L-29: nothing is found, nothing is dialled); only a live run handed
such a fixture looks at the real web, under the same policies.

The reference asserts every row of N-1…N-33, N-35…N-53, N-55…N-57 (`test_link_cases.py`), N-34 and
N-54 on the execution session (`test_link_execution.py`) and, in
`test_link_runtime.py`, the authority boundary (an inner run built from its binding alone; a
caller's grant and approval for the same permission and tool refused to the linked package), the
reservation held and released, a link past its step's time, the composed bound under several
walks, a denial of a publisher's key, the run record, `inspect` and the CLI; in
`test_link_join.py`, where a slot looks, the card's facts, the request-building call's data
(the view and the joined package's name, description and input schema, nothing else), the
caps, the denial that lasts for the run (a later candidate and a planned link of the declined
key), an unanswered card, a candidate whose bytes no worst case can be computed from, a joined
package the host cannot run or whose inner run raises or outlasts the step, a fixture run that
dials nothing, and the raise's rules (the bound of half, the package's cap, one per run, a
model call's reservation, the card's time inside its node's).

## 11. The example packages

Four fictional publishers, each with its own key and its own origin
([`examples/link/make_link_examples.py`](../examples/link/make_link_examples.py) generates the
sources under `agents/`, and a test asserts the committed trees are its output):

| Package | Publisher | What it does |
|---|---|---|
| `org.webagents.travel-planner` (Tripwright) | a travel planner | a network.v0 package: `FrontMan` (the entry, a chosen route) consults `Flights`, `Hotels` and `Calendar`, each at most once within six handoffs. `Flights` holds one `link` step to `webair-flights`, `Hotels` one to `hotel-aggregator`; `Calendar` calls the planner's own tool |
| `org.webagents.webair-flights` (WebAir Flights) | WebAir, with WebAir's key | searches WebAir's fictional flights, then proposes one among them |
| `org.webagents.staymere-hotels` (Staymere) | a hotel aggregator | searches the hotels it lists in a city, then proposes one |
| `org.webagents.hotel-salitubam` (Hotel Salitubam) | one small hotel in Reykjavik | asks the hotel's own availability service, then proposes one room offer; the package a slot can join |

Each linked package is one tool on its publisher's own service and one model step, with the
same worst case: 1 model call, 1 call of its tool, 3 remote calls, 6,000 tokens. The planner's
composed envelope, stated before consent: at most 6 handoffs; FrontMan at most 4 times and each
specialist once; 10 model calls (8 of the planner, 1 of each linked package); one call each of
`check-calendar`, `webair-flights:search-flights` and `hotel-aggregator:search-hotels`; 23 remote
calls and 92,000 tokens. The planner is a star, so the bound is exact in model and tool calls,
and its fixture walk, the full tour through both links, attains them
(`agentpkg/tests/test_link_packages.py`).

Every link's input is built from the trip's closed fields (airport codes bound by a pattern, ISO
dates, an integer number of travellers); the request's free-text `notes` reach FrontMan's model
and no link, and a test walks every link constructor against the schemas and fails on a source
that admits free text. That is a property of this planner's declaration, not of the format
(L-4): a package whose link input admits free text sends what its program puts there.

The tool answers in the four fixtures are the demo origin's own
(`demo/webair/tests/test_hotel.py`). All data is fictional; nothing is booked.

**The planner 0.2.0** (D-683; its source is `examples/link/travel-planner-0.2.0/`, generated
by the same script and unsigned until its go/no-go, when it replaces 0.1.0's tree under
`agents/` as a new signed version) is 0.1.0 plus one role, `FindHotel`, for a hotel the
traveller names that the aggregator does not list: a `web.search` tool step (the planner's own
tool, a query in and at most five results out), then a slot, `named-hotel`. Its `locate` reads
the address the person gave in the request's `hotel_url`, else the first search result's `url`;
its view is the stay's closed fields (check-in, check-out, travellers); its ceiling is one
model call, one tool call, three remote calls and 6,000 tokens within 300 seconds. The run's
input gains `hotel_url`; the network's messages keep to `text` and `notes`, so no model writes
an address a slot reads. The composed envelope before consent: at most 8 handoffs, FrontMan at
most 5 times, 14 model calls (10 of the planner, one of each linked package, the
request-building call and the joined package's one), 33 remote calls and 122,000 tokens, with
the join inside it at its ceiling. `examples/link/join-fixture.json` records Hotel Salitubam's
page, its signed archive and the person's acceptance: the fixture walk joins the hotel's
package and attains the 14 model calls; the same walk without a person yields `unattended` and
ends with the aggregator's hotel (`agentpkg/tests/test_link_packages.py`).

## 12. Versions, deliberate limits, prior art

**Versions.** agentpkg 0.8.0 implements §1…§7: planned links, the join and the budget-raise
request; packages that use links declare `runtime.minimum_version: "0.8.0"`.
The Chrome core's port is T66. The OpenClaw plugin stays frozen (D-029) and its execution host
refuses 0.8.0 packages by version. The paper line is untouched.

**The reference's two hosts.** The developer CLI and a driver that plays the person bind
decisions directly (`links/operator.py`) and write a link plan per accepted link. On the CLI
the operator's pinned keys are the `--trust-key` arguments: **the first pins the caller's
publisher and only that one verifies the caller**; every key given is in the set a linked
publisher is trusted by (L-12). A key given for a linked publisher therefore never stands in
for the caller's, and a caller signed by a linked publisher's key is refused unless that key is
the first. The control
plane opens each dependency as a package session of its own (`resolve_links`), so a linked
package is authorized and planned through the ordinary path, and the execution session builds
the same link host from the caller's plan and the inner plans. There a linked package whose
model needs the route does not meet is refused by its own plan's preparation, and a linked
package must declare a model permission to be planned at all, used or not (the control plane
plans model-backed runs only).

**The cards of a run in the reference.** A run asks the person through the consent surface
its host hands it (`conversation.host.RunConsentHost`: one `ask` per card), and looks through
the host's `links.join.JoinHost` (discovery, the package fetch, the person's trust store, what
a joined package's inner run is handed). The developer CLI binds both from `--join-fixture`
(§10): recorded answers, and a recorded web or, where the fixture records none, the real one
under the same policies. A driver that plays the person supplies its own surface. **The
execution session hands a run no surface**: the frozen OpenClaw plugin, the only shell over
it, cannot show a card and refuses 0.8.0 packages by version, so a slot there yields
`unattended` and a failed reservation is refused as before; the session's host protocol gains
no mid-run request in this version. The Chrome core's port (T66) is where a prepared Run Plan
and a person at a card meet.

**Deliberate limits of v0.** Depth one (a linked package links nothing; the composition rule is
stated for any depth); no conversational target; no remote linked agent (a link is a program
run here); a slot only in a role's program, one candidate per step, at most two cards per run;
`locate` reads the run's input or a tool's result and nothing a model can write; the linked
package runs on the caller's model route; a link's seconds are inside its step's time; the bound
counts calls and tokens, not the quality of a linked package's answer; what a linked package's
own approved tools send to their hosts is that package's declaration, shown on its card.

**Prior art.** The systems that link agents link a service: the A2A protocol and the framework
features built on it (a remote agent behind an agent card, answered by its operator's server and
model), remote graphs, external agents of a declared network, and agents wrapped as tools. What
the caller sends is set by caller code, and what the remote side spends is outside the caller's
accounting. The systems that share a program share instructions or code that the person's agent
then runs with the person's own authority: skill folders, hub agents fetched with a
trust-the-code flag, network files fetched by URL. On the pages read for this specification
(November 2026), none of them fetches another publisher's agent program and runs it under the
person's own model with the publisher verified, the program pinned by digest, its requirements
declared and granted on its own card, and its worst case composed into the caller's before
consent. network.v0's reservation (R-17) is the pattern of L-24, its bound (R-19…R-22) the
frame of §4, conversation.v0's consent host the pattern of §6's card, and the package-URL and
discovery policies (`docs/threat-model.md`) are reused unchanged.
