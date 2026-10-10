# workflow.v0 execution profile

Status: experimental, normative for agentpkg 0.3.0 (0.2.1 adds `lookup`; 0.2.2 adds `allocate`, §4; 0.3.0 adds answer checks, §5, and the model request's `feedback` line, §7; older graphs retain their semantics). The enclosing **agent.pkg format remains 0.1**, including its archive, integrity statement and Ed25519 signature transcript. This document adds execution semantics; it does not redefine the container. Machine contracts are `agentpkg/schemas/workflow.schema.json`, `workflow-fixture.schema.json`, `audit-event.schema.json`, `model-request.schema.json`, and `model-result.schema.json`. Examples are `agents/literature-review` and `agents/meeting-agenda`.

## 1. Authority and canonical representation

A manifest selects this profile with `entrypoint: "workflow.v0"` and `runtime.minimum_version: "0.2.0"`. Its `graph` member names **one authoritative JSON document**, conventionally `graph.json`. The graph declares `profile: "workflow.v0"`. There is no second stage table, HOCON file, generated Python implementation, or executable entrypoint inside these packages. Markdown skills contain instructions, not scheduling semantics. No source compiler is required in this version.

The host loads, validates, optionally authenticates against an external publisher-key pin, supplies grants and trusted adapters, and invokes `Workflow.run(input)`. It MUST NOT select orchestration by package ID, display name, task name, skill name, or application domain. Unknown execution profiles remain inspectable if their container/graph format is supported, but are not executed as workflow.v0. Unknown tool bindings require a host-installed capability, never a downloaded implementation.

A package is data, including its JSON schemas and fixtures. No Python, shell, JavaScript, expression evaluator, dynamic import, generated code, or arbitrary callback is accepted from a package. A trusted Python host integration is not sandboxed merely because the downloaded package is data-only.

## 2. Graph and node identities

The graph has the following required fields:

| Field | Meaning |
|---|---|
| `spec_version`, `profile` | Exactly `0.1` and `workflow.v0`. |
| `coordinator`, `workers` | Existing agent.pkg role declarations and authority bounds. |
| `input_schema`, `output_schema` | Paths to manifest-declared application schemas. |
| `initial_state` | A data constructor evaluated against the validated external input. |
| `deadline_seconds` | Positive whole-workflow deadline, at most 86,400 seconds. |
| `nodes` | Nonempty array of at most 512 top-level nodes. |
| `extensions` | Noncritical metadata only. |

Optional `fixture` identifies a machine-validated fixture document. Optional `exports` declares at most 32 output files. The graph is a DAG: cycles and missing dependencies fail before execution. There must be exactly one `output` node, transitively dependent on every other node; its output schema must equal the graph output schema.

A top-level node requires `id`, `type`, `worker`, `depends_on`, `input`, `output_schema`, `timeout_seconds`, and `writes`. Unknown properties and options belonging to another node type fail validation. IDs are unique within their graph. Step IDs are unique within their map body. A step's globally qualified identity is `map-id/step-id`; each invocation additionally has a unique worker ID. Neither nodes nor steps can dynamically create new definitions.

Dependencies are explicit. The document array determines stable ordering within a ready wave; it does not override dependencies. Reordering an otherwise sequential DAG does not change its execution. `output` does not terminate unrelated pending work early.

## 3. Small execution vocabulary

| Type | Semantics and required configuration |
|---|---|
| `llm` | Invoke the host router for declared `task` with `input`, role skills, bundled output schema, and positive `max_output_tokens`. Optional `checks` (agentpkg 0.3.0) are bounded assertions on the schema-valid answer (§5). |
| `tool` | Invoke declared `tool` with `input` through host permission/budget/schema mediation. |
| `map` | `input` must be an array. Validate all items with `item_schema`, enforce `max_items`, instantiate a worker per item with at most `max_parallel` concurrent consumers, execute `steps` sequentially, evaluate `yield`, and return an array in input order. |
| `join` | `input` must be an array whose members are arrays, or select arrays from its members using optional JSON Pointer `select`. Concatenate in order. Optional `unique_by` and `limit` apply after concatenation. |
| `validate` | Evaluate `input`, enforce its `output_schema` and optional bounded `assertions`, then return that same value. |
| `output` | Project and schema-validate the final workflow result. Must not write state. |

`map.steps` are 1–128 `llm`, `tool`, `join`, or `validate` operations, all executing inside the same item worker. Each step requires its own ID, input, output schema and timeout. Steps have neither role declarations nor state writes. `yield` constructs the item result from that worker's view/item/step results. The map node's output schema validates the complete ordered collection. An empty map produces `[]` and spawns no workers.

Only non-coordinator roles may execute `llm`, `tool`, or `map` nodes. The coordinator can execute structural nodes. A non-coordinator structural node also runs through worker authorization and accounting.

`join.unique_by` is an ordered list of field pointers. For each record, the first non-null/nonempty-string field is its identity, namespaced by its pointer. If none is usable (or the list is empty), identity is the hash of the complete JSON value. The first record wins. This is exact data deduplication, not fuzzy matching or domain normalization. A missing pointer is an error. `limit` keeps an explicit prefix and emits `node.truncated` when it removes records. Authors must choose a sound identity policy; the runtime does not infer one.

There is no standalone branch node or general reducer language. Optional `when: {left, op, right}` on non-map operations compares two constructed values with `eq` or `ne`. `otherwise` is required with `when` and forbidden without it. Input construction always occurs; when false, the adapter/operation is skipped and the `otherwise` value is validated as the operation's output. A skipped node still completes and participates in dependencies/state writes. `node.skipped` explains this path. Conditional maps use an explicitly empty input array; `when` on a map is rejected.

## 4. Data constructors and state paths

Every value expression is exactly one of:

```json
{"literal": "arbitrary finite JSON data"}
{"from": "state", "path": "/request/goal"}
{"object": {"request": {"from": "state", "path": "/request"}}}
{"array": [{"literal": 1}, {"literal": 2}]}
{"coalesce": [{"from": "item", "path": "/id"}, {"from": "item", "path": "/name"}]}
{"lookup": {"in": {"from": "state", "path": "/records"}, "key": "/id",
            "equals": {"from": "item", "path": "/id"}, "path": "/metadata"}}
```

Objects containing special-looking fields are still inert inside `literal`. `coalesce` evaluates in order and returns the first non-null value; it does not catch missing-path errors. An empty string is non-null. At most eight alternatives are allowed. `lookup` (agentpkg 0.2.1) is keyed selection over data already in scope: it constructs array `in` and value `equals`, finds the members whose JSON Pointer `key` equals `equals`, and returns `path` of that member (empty `path` returns the whole member). Key equality is the exact canonical JSON equality a `relation` assertion uses (§5), with no coercion. Exactly one member must match: no match, several matches, a non-array `in` or a missing pointer fail as `schema_validation`, attributed as `{"check": "lookup", "failure": "no_match" | "duplicate_key" | "not_array", "key", "path"}` — the package's own pointers, never data. It is the constructive counterpart of a relation's keyed match: where a relation can only prove that a row equals its trusted target, `lookup` lets the graph copy the target, so a model is never asked to reproduce trusted data that a later check requires to be identical. Its `in` and `equals` operands are ordinary projections, checked statically against the role's `state_read` and step order. There is no general arithmetic, string interpolation, variable assignment, external lookup, iteration, filtering, or code evaluation.

`allocate` (agentpkg 0.2.2) constructs exact positive integer allocations:

```json
{"allocate": {"rows": {"from": "state", "path": "/draft/records"},
              "total": {"from": "state", "path": "/request/capacity"},
              "field": "units"}}
```

`rows` must contain 1–256 objects, each with a positive integer weight in the
named top-level `field`; weights and `total` are bounded by 2,147,483,647.
Booleans, fractions, missing weights, and totals smaller than the row count fail
as `schema_validation`. Exact allocations are copied unchanged. Otherwise,
reserve one unit per row, distribute the remaining units in proportion to the
original weights using integer division, and assign leftover units by descending
fractional remainder, breaking ties in original row order. This uses integer
arithmetic only. Every other field, all rows, and their order are preserved;
input data is never mutated. Both operands undergo the usual scope and authority
checks. This is one finite constructor, not an expression evaluator or a new
capability. Authors must declare runtime minimum 0.2.2 when using it. Final
assertions remain independent checks of the constructed result.

Paths are JSON Pointers: empty selects a whole permitted source, `/` separates components, `~0` means tilde, and `~1` means slash. Array indices are nonnegative canonical decimal strings. No wildcard, negative index, parent traversal, automatic creation, or missing-value default exists.

| Scope | Available sources |
|---|---|
| `initial_state` | `input` only. |
| Top-level node input/condition/assertions | `state` only, limited to the role's `state_read` keys. |
| Map step | The same copied `state` view, copied `item`, and `steps` from earlier steps in that item only. |
| Map `yield` | The same item-local sources, after all steps. |
| Node `writes` | `result` only. |
| Exports | Final workflow `result` only. |

Whole-state reads are forbidden. The first state path component must name a permitted field; deeper paths must be compatible with the declared schema. Package-relative schema references are resolved offline. Optional properties and unconstrained schema branches may require runtime checking: schema validity does not guarantee that optional data exists. Forward or unknown step references are rejected. Known reads before top-level initialization are rejected during validation.

`writes` maps **top-level state pointers** to result constructors, for example `{"/plan":{"from":"result","path":""}}`. The destination must appear in the node role's `state_write`. Nested writes, root replacement, undeclared keys and writes sourced from arbitrary state are rejected. Copying a prior value requires an explicit operation input/result. This keeps mutation authority auditable.

Each ready wave receives a deep-copied common state snapshot. Each worker receives a further isolated permitted view; its local mutations do not mutate shared state or other workers. Every returned value is finite JSON. Each patch is checked against the full state schema before node completion; the combined next state is checked again. All patches from a wave commit together, in graph order, only after every node succeeds. Unordered write/write or write/read conflicts are rejected statically, so order cannot resolve an ambiguous data race. Declared dependencies must order conflicting accesses.

## 5. Bounded validation assertions

JSON Schema checks structure. Three optional assertion kinds check cross-field invariants without application-specific host functions:

- `equal`: construct `left` and `right`; require JSON value equality.
- `sum`: construct array `rows`, select a numeric `path` from each member, and require its sum to equal constructed `equals`. Booleans are not numbers for this operation.
- `relation`: construct `rows` and `targets`; index targets by `target_key` and require every selected `row_key` to match exactly one target. Duplicate target keys fail. With `many: true`, each row key must be a nonempty array and every member must match. Optional `where: {path, equals}` selects rows to check. Optional `target_values` requires exact values at target pointers. Optional `compare` pairs row/target pointers using `eq` or `contained_in`; the latter requires a nonblank row string to occur verbatim in the target string.

Assertions only validate data. They do not transform it, grant authority, route execution, call adapters, repair records, or evaluate arbitrary predicates. Failure stops the workflow as `schema_validation`. Missing selectors also fail.

**Answer checks** (agentpkg 0.3.0). An `llm` node or a map `llm` step may declare `checks`: up to 64 assertions of the same three kinds, evaluated in order on its answer after the answer has passed its output schema. The answer is the source `{"from": "result", "path": …}`; the operation's own sources stay available beside it (the role's `state_read` view, and in a map step `item` and earlier `steps`). Static validation checks each check's constructors exactly as an assertion's, with `result` typed by the node's `output_schema`; `checks` on any other node or step type is refused, and a graph that declares `checks` (even an empty list) must declare `runtime.minimum_version` 0.3.0 or later, so an older runtime refuses the package by its version. A refused check is a **non-conforming answer**, not a package error: the model call fails with `model.failed` reason `model_output_not_conforming`, `failure_facts.output_failure: "check"` and `failed_check: {check: "answer_check", index, kind, failure, …}` naming the package's own pointers, charged what the router reported; the node fails `model_error` and its `node.failed` carries the same `failed_check`. A check that cannot be evaluated on this answer (a selector finds no data, a lookup no member) fails as `not_evaluable`. Nothing is repaired. A host may ask once or twice more within every bound (§7); a replay router never does, so fixture runs refuse the first non-conforming answer in every runtime. Equality is structural; Unicode normalization, scientific entailment, approximate arithmetic and domain identifier equivalence are not inferred. Package schemas should bound collection sizes and use integers when exact totals matter.

The reference packages demonstrate why these checks are needed: exact time totals cannot be expressed by their simple output schemas, and source quotations/foreign keys require relating different records. Such rules reside in graph data, not interpreter branches.

## 6. Scheduling, workers and delegation

A workflow instance is single-use. Top-level ready nodes run concurrently, then join at a wave barrier. This deliberately simple scheduler may leave capacity idle while another ready node finishes; there is no speculative execution. Maps allocate at most `min(max_parallel, item_count)` consumer tasks, rather than one task for each item. Results retain input order even when completion order differs.

All worker operations share the existing global semaphore and per-role semaphore. `max_instances` bounds **simultaneously active instances**, not cumulative instances; `max_items` bounds total children per map. A host can lower global parallelism, tokens or remote calls. It cannot raise package authority. Declared map concurrency must not exceed either the role or package limit; a smaller host limit further throttles execution.

The profile supports only packaged local worker roles, depth **one**, with the coordinator as parent. Approved roles must exactly match declared non-coordinator roles. No nested maps, recursive worker creation, remote workers, agent tools, dependency loading or remote delegation execute in this profile. A map body uses its existing worker, not another delegation level. Worker token/remote-call budgets apply per instantiated worker; workflow budgets cover all instances.

## 7. Model-router contract

The host supplies the `ModelRouter` protocol in `interfaces.py`. No vendor integration is part of this profile. Host adapters are separate: the existing optional generic HTTP router, and `agentpkg.hostbridge.HostBridgeModelRouter`, which binds the exact model an Agent Browser run plan recorded and reaches it through OpenClaw over a private stdio protocol (see [the model-router bridge](../docs/model-router-bridge.md)). `agentpkg.execution` composes that router with this interpreter to run a package under a re-verified run plan (see [package execution](../docs/package-execution.md)); it installs no orchestration of its own. The interpreter still selects no provider and knows no vendor.

```python
await router.count_tokens(request) -> nonnegative_integer
await router.complete(request, max_output_tokens=N) -> {
    "output": JSON,
    "input_tokens": integer,
    "output_tokens": integer,
    # optional cost_usd
}
```

The two-phase design permits atomic reservation before generation. `request` includes `task`, the role's signed skill `instructions`, copied untrusted `data`, a self-contained bundled `output_schema`, task `requirements`, `budget_context.max_output_tokens`, and `audit_context` identifying the worker/node. Routers declare `remote`, `model_id`, `router_id`, compatible `capabilities`, and `context_window`. Package capabilities and context requirements are checked before dispatch; `local-only` rejects a remote router. Tier/fallback/cost preferences do not weaken mandatory requirements. A compatible host router may choose a provider; the interpreter does not.

A remote tokenizer and a remote completion count as two remote calls. A model permission is consumed before token preflight can disclose input. Global and per-worker reservations include the complete input bound plus maximum output. Concurrent reservations count toward caps and approval thresholds. Unknown usage on failure/cancellation consumes the reservation; successful reported usage releases unused capacity. Known overruns are recorded honestly and halt later dispatch. A compatible adapter MUST enforce the output cap, report all billable/reasoning tokens, bound its I/O and cooperate with cancellation. A dishonest external provider cannot be retroactively stopped from overspending.

**Re-asking a non-conforming answer** (host behaviour; the Chrome runtime, D-151). A router may declare how many more times it is asked when an answer is not accepted: a schema miss, an answer that is not one JSON document, or a refused answer check (§5). At most two re-asks (three attempts) are made. A re-ask is the original request plus one optional `feedback` string (1–1,000 characters in `model-request.schema.json`), which a renderer appends as the last system section, `## Correction` followed by the line, so the count covers it. The line is fixed by the host, never written by a model: `The previous answer was not accepted: <reason> Return the complete JSON document again, corrected.`, where the reason is `answer check <index> (<kind>) failed: <failure>[ at <pointer>][ for <values>].` for a check, `it does not match the output schema: <keyword> at <JSON Pointer into the answer>[ (missing: <names>)].` for a schema miss, `it is not one JSON document.` or `it contained no text.` Values are repeated only when they already occur in the request's `data` or in the refused answer, as strings of at most 80 characters, numbers or booleans, at most three and a count of the rest. Each re-ask is recounted, reserved afresh against every token and remote-call bound, charged and audited (`model.count.called` and `model.called` with `attempt: 2 | 3`, `model.called.after` naming the refusal by pointers only), under the one logical model authorization. It is not sent (`model.retry_skipped`: `budget`, `context_window` or `deadline`) when its reservation would pass the context window or a bound, or when less time is left before the earliest deadline than the refused attempt took; the node then fails with the answer that was not accepted. agentpkg 0.3.0 renders `feedback` but its routers declare no re-asks.

`FixtureRouter` is an explicit local test adapter. It selects a package-owned response by exact task/input match; zero or multiple matches fail. It does not interpret skills or answer new questions. Synthetic accounting uses `ceil(UTF-8 JSON bytes / 4)` per request/output; this is a deterministic test unit, not vendor tokenization or a bill. Fixtures never grant model or tool permissions.

## 8. Tool contract and host boundary

Existing tool documents declare binding, local/remote execution, input/output schemas, permissions, domains, endpoint/method, timeout, retry count, side effects and approval requirements. The generic mediator checks the worker allowlist, explicit host grants, policy/network contract, tool-call cap, global/worker remote-call caps, and schemas before dispatch. It enforces the tool timeout inside the enclosing node/workflow deadlines, validates the result, counts attempted dispatches conservatively and emits audit events.

`ToolHandler` is an async host callable `(context, copied_payload) -> JSON`. Binding names identify installed host capabilities; no package name selects a handler. The mediator refuses **any** declared tool that the host has not explicitly approved, so a permission grant alone never authorizes a tool. Host adapters must perform only their bound contract, respect selected-file IDs and allowed endpoints, and close/reap I/O on cancellation. The existing Crossref, PDF and Citation Resolver handlers are provider integrations in `tools.py`, outside the interpreter. Citation Resolver remains the existing remote service; no bibliographic resolver logic is copied into workflow execution.

The Agent Browser execution host installs one generic handler per bound tool: `agentpkg.toolbridge.HostBridgeToolHandler`, parameterized by one host binding a run plan froze, reaching a trusted [host tool broker](../docs/tool-broker.md) over the private execution protocol. It contains no transport, no service vocabulary and no credential. A package declaring a tool that host has no binding for is still refused before anything runs; that remains a host capability limit, not a format limit.

**Host retries of idempotent reads, and the citation fallback** (host behaviour, not package semantics; the Chrome runtime, D-152, D-153). A tool's `retries` stays 0: a package declares no retry. A host may send a call again when it failed transiently, only for a remote tool whose declaration and bound contract both say `side_effects: "read"`: HTTP 429, 500, 503 or 504, a 502 the adapter did not take as data, a connection or read failure, or the binding's own deadline while the request was out. At most two retries, after 1 s and then 3 s, or after the server's `Retry-After` when it is at most 10 s (a longer one is not retried). Each retry is a remote call checked against the run's and the worker's remote-call budgets before it is sent; it is not another tool call; it waits for its pacing turn like any request; and it is not sent when the wait plus the failed attempt would pass the call's earliest deadline. Audit: `tool.retried` (attempt, failure class, status, delay) or `tool.retry_skipped` (budget, deadline, retry_after), and `tool.settled.attempts`. A non-transient failure, a TLS or address-policy refusal, a schema-invalid answer, a cancellation and any tool with side effects are never retried. For the abstract capability `citation.resolve`, when the package's tool also declares `api.crossref.org` (so the person's grant of its network permission covers it), a DOI query whose resolver failed transiently after its retries, or answered 502, may be answered by the host's built-in Crossref DOI lookup in the resolver's own output contract, with a warning that says so; the binding's descriptor names that fallback, so the run plan's binding digest covers it (`tool.fallback`, `tool.settled.answered_by`). When the lookup cannot answer, the call ends exactly as it would have without it.

Fixture handlers are the same generic exact-input replay mechanism for every tool. A declared remote fixture tool counts against its remote-call budget even though it performs no network I/O. This exercises enforcement without spending real calls. Production networking retains the existing HTTPS allowlist, public DNS pinning, no-redirect transport and killable network child.

## 9. Failures, deadlines and cancellation

The profile declares no automatic retries, repairs, exception-swallowing branches or partial-success maps. Tool `retries` must remain zero. The bounded re-asks of §7 and host retries of idempotent reads of §8 are host behaviour within every package bound; the package's semantics are unchanged by them, and a fixture run sees neither. A service response such as an unresolved lookup is ordinary schema-validated data; a raised provider exception is a failure.

| Code | Meaning |
|---|---|
| `tool_error` | Host tool/provider raised an operational error. |
| `model_error` | Host model adapter failed. |
| `schema_validation` | Input, output, state, projection, collection bound or assertion failed. |
| `timeout` | Workflow, node, step or mediated tool deadline elapsed. |
| `budget_exhausted` | A hard limit prevented dispatch/reservation. |
| `permission_denied` | Host permission, role, privacy, capability or other authority policy denied use. |
| `worker_error` | Other unexpected worker/interpreter error. |
| `cancelled` | Host cancellation; remains `asyncio.CancelledError` in Python. |

The first observed child error aborts the containing map/wave and workflow. Siblings are cancelled and drained before reporting failure. No failed wave patches commit. Already dispatched remote side effects or charges are not rolled back. Other completed waves are not retried. Simultaneous failures may have scheduling-dependent first-error identity, but all observed events remain in the audit.

Timeouts use monotonic `asyncio.timeout`; queued worker-slot time and model token preflight are included. A step and tool have narrower nested deadlines. Positive graph/node deadlines are schema required. `Workflow.cancel()` can cancel a pending or active run; direct task cancellation is also supported. Cleanup precedes terminal reporting and clears session state. Exceptions carry `execution_report` with stable error code, audit and settled usage, without raw source/model/provider content.

These are cooperative deadlines for trusted in-process adapters. They are not an OS sandbox for arbitrary host Python or a CPU limit on pathological JSON Schemas. The existing network subprocess can be terminated; third-party adapters must supply equally suitable cleanup. Persistent memory and secure physical-memory erasure are outside this profile.

## 10. Audit contract

Events conform to `audit-event.schema.json`: `schema_version: "audit.v0"`, UUID `run_id`, increasing `sequence`, UTC `timestamp`, `action`, nullable worker/role/parent/node IDs, `depth`, `previous_hash`, and `event_hash`. Node/workflow events include `profile: "workflow.v0"`. Flat metadata fields are extensible; runtime payloads are finite JSON. The previous-hash chain binds every event in sequence; it is not an external tamper-proof log.

Stable actions are `runtime.started`, `workflow.started/completed/failed/cancelled`, `node.started/completed/failed/skipped/truncated`, `worker.spawned/started/completed/failed/denied`, `tool.called/completed/failed`, `model.count.called/failed`, `model.called/completed/failed`, `permission.checked`, `budget.updated`, `delegation.checked`, `state.committed`, and `memory.cleared`. Provider adapters may add namespaced operational actions such as `network.requested` or `file.read`.

Metadata identifies package/digest at startup, node type and qualified identity, worker ancestry, tool binding/domains/permission IDs, model/router/task, reservations and charges, state key names, input/output hashes, truncation counts and stable error codes. A failed model or tool call may also carry `failure_facts`: structural facts its adapter certified about how the call failed — for a model call the host's stop reason, the usage the host reported, and which JSON Schema keyword failed at which schema location. Each value is a count, a flag or a spaceless token of at most 200 characters, and at most twelve are kept, so they describe a failure without carrying anything the model, a provider or a document wrote; they explain a charge but never settle one (§7). Worker spawn identifies its map parent; step model/tool events identify the qualified step. `node.completed` means the node result/patch validated; `state.committed` marks the wave's atomic commit. The terminal workflow event precedes `memory.cleared`.

Raw prompts, source pages, input values, model outputs, credentials and provider exception messages are excluded. Identifiers, field names, counts and hashes may still reveal metadata and are not a confidentiality mechanism. Audit timestamps/run IDs reflect real executions; fixture result content and accounting are deterministic, audit bytes are not.

## 11. Exports and compatibility

Exports have `path`, `format` (`text` or `json`), and a result `value` constructor. Filenames must be safe single portable filenames, unique case-insensitively, and cannot collide with host `result.json`, `audit.json`, `usage.json` or `provenance.json`. Text selections must be strings. The interpreter validates exports before successful completion. One shared writer renders them; the CLI writes to a new private output directory and the execution runner writes through an inherited directory descriptor, which additionally reserves `run.json`. Neither interprets a package filename as code or writes outside its one destination.

Container build/inspect/permissions/validate/unpack/sign/verify and existing OpenClaw staging remain generic and backward compatible. The old host-entrypoint graph schema is retained for archival packages. The old Literature Review source/artifact and development runner are explicitly separated; see `docs/workflow-migration.md`. They are not a fallback of the workflow interpreter.

## 12. Deliberate limits

No loops, recursion, nested delegation, package-declared retries, streaming, checkpoint/resume, dynamic graphs, registry/discovery, browser UI, remote agents, model-provider integration, or persistent memory. Model-generated scientific or business judgments still require quality evaluation; structural checks and deterministic replay are not scientific validation. These limits keep the first portable execution contract small enough to inspect, test and implement in another host.
