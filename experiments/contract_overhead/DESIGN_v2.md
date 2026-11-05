# Contract overhead v2 (E7): both runtimes, four packages, the extensions' run-time costs

The second overhead series, for the mechanism paper (`experiments/PROTOCOL.md` §3 E7, Tab. 9; T38,
D-305). It is a new benchmark, `benchmark_v2.py` with its Node side `node/bench.ts`, over the
development line. v1 (`benchmark.py`, `analyze.py`, `aggregate.py` and every directory under
`results/` before 2026-11-04) is untouched. v2 imports v1's offline guard, first-wave stop, runner
projection and machine facts and v1's estimators (`analyze.percentile`, `analyze.describe`)
without editing them. v1's RQ2 series is a different implementation, host and package set, so the
paper cites it beside v2 and never pools the two (D-019).

```sh
agentpkg/.venv/bin/python -m pytest experiments/contract_overhead/tests
agentpkg/.venv/bin/python experiments/contract_overhead/benchmark_v2.py --label v2-run1     # about 2 h, machine idle
agentpkg/.venv/bin/python experiments/contract_overhead/aggregate_v2.py pool \
    --out experiments/contract_overhead/results/<UTC>_v2-pooled RUN1 RUN2 RUN3
agentpkg/.venv/bin/python experiments/contract_overhead/benchmark_v2.py --check-fixtures
```

The Node side needs `npm ci` in `chrome-agent-browser/`: the benchmark is type-checked with the
core's TypeScript and bundled with the core's esbuild into `.cache/node-<key>/`, which is
git-ignored and keyed by the hash of its inputs.

## Packages and decisions

| Package | Artifact | Decisions (`fixtures_v2/authorization.json`) |
|---|---|---|
| Meeting Agenda 0.2.2 (the unchanged baseline) | `dist/meeting-agenda-0.2.2.agent.pkg` | everything it declares |
| Literature Review 0.2.9 | `dist/literature-review-0.2.9.agent.pkg` | every tool approved (it declares no profile); the optional `files.pdfs`, `memory.research_profile`, `memory.remember` and `memory.agent` denied |
| WebAir 0.8.0 (a conversation) | `dist/webair-0.8.0.agent.pkg` | its publisher's profile `search`, applied by id (D-090) |
| Travel Network 0.1.0 (a delegation network) | `dist/travel-network-0.1.0.agent.pkg` | everything it declares |

Every package's publisher key is pinned at package scope before timing starts. The host's memory store is unlocked and holds
no record, so no resource is selected. The task inputs are each package's own live-shaped
input: the v1 Meeting Agenda input, the v1 Literature Review question with 0.2.9's new fields,
WebAir's fixture message and the Travel Network's fixture message.

## The seven operations, per runtime

| Stage | Python reference (`runtime=py`) | Chrome core (`runtime=ts`) |
|---|---|---|
| `package_open_verify` | `ControlPlane._open_bytes` | `controller.ts::openBytes`: hash, `evaluateSnapshot`, `publisherReport`, `buildSummary` |
| `authorization_receipt` | `ControlPlane.authorize` (with the profile id where one is applied) | `authorize` → `issue`: normalized decisions and approvals, resource selections, provenance, `buildReceipt` |
| `compatibility_evaluation` | `evaluate_models`, `evaluate_tools` | `evaluateCatalog`, the host registry (`buildHostToolRegistry`) and `evaluateRegistry` |
| `run_plan_preparation` | `prepare_run_plan` | `prepareRunPlan`: catalog, the receipt's tool evaluation, `preparationBlockers`, `buildRunPlan`, then `runPlanState`'s `preflight` |
| `host_revalidation_lease` | the plugin's run start: `validate_input`, `run_plan`, `summary`, `authorization`, `evaluate_tools`, `issue_execution_lease` | `runs.ts::start`/`launch`: `validateTaskInput`, readiness's `preflight`, for a conversation `conversations.ts`'s start and first turn (chain, limits, `reserveTurn`, `TurnStart`), the registry, the store, `LeaseRegistry.issue` and `consume` |
| `runner_verification` | `ExecutionSession` `execution.begin`; **for WebAir 0.8.0** `agentpkg converse`'s composition: the leased bytes read and verified against the plan's identity (`verify_execution_artifact`), the transcript checked, the turn's adapters, `Conversation(...)` | `execute.ts`: the package, the store, the registry, `adapterFor` and `BoundModelRouter` over the planned model, `MemoryRun`, `ExecutionSession.begin` (with the `TurnStart` for a conversation) |
| `workflow_start` | `execution.run` (or the conversation's first turn) up to the first wave | `session.run()` up to the first wave |

The clock stops at the first wave in both runtimes, as in v1. Python replaces `Workflow._gather`
(v1's `FirstWaveStop`). Node replaces the `Workflow.prototype.gather` its interpreter hands the
first wave's starters to, for this process only. Neither stop calls a starter, so no node has
started. Every observation checks its own preconditions outside the timers. On both sides those
are: valid layers and signature, a trusted publisher, a runnable receipt, a compatible model,
every approved tool bound, ready plans and preflights, the runner's archive hash and handlers,
one stop, the first wave equal to the graph's roots, and no `node.started`, model or tool event.
The Python side also checks that no non-progress frame was written. The Node side checks that the
offline guard counted nothing. The transports the Node host is given refuse every request and
count it.

**WebAir 0.8.0 on Python.** The one-shot execution host refuses a conversation by design (V-28),
and the reference has no conversational execution host other than its CLI. Its two runner stages
are therefore `agentpkg converse`'s composition over the leased bytes, with the fixture adapters
the CLI would build. No adapter is called before the stop. The Chrome core runs a turn through the
same `ExecutionSession` as a one-shot run, as the extension does. The two Python runner stages
therefore include fixture-replay construction the Node side does not pay (its host is given a
refusing transport and an empty store): `fixture_adapters(package)` inside `runner_verification`
and `cli_memory(mode="fixture")` inside `workflow_start`. T38's review measured them at a few
milliseconds per observation, against stages of hundreds of milliseconds (review 1, finding 9), so
the stages' numbers stand; a later series can build the adapters before the stage's first timestamp.

**Literature Review 0.2.9 on Python: no plan exists.** The reference shell's control plane
(`agentpkg/browser/hosttools.py`) binds four implementation kinds and not `memory_agent`, the
kind of Agent Memory's agent-document tools, which only the extension binds. Literature Review
0.2.9 declares two of those tools and no profile that leaves them out, so `prepare_run_plan`
refuses with `tool_not_bound` (`agent-notes.read`, `agent-notes.write`). Each run records that
refusal under `metadata.json` → `py_unrunnable` and times the package on Node only (B-275). The
Python host fixtures hold the bindings this shell knows. They are the extension's registry minus
the `memory_agent` bindings and the extension-only `fallback` field.

## Host fixtures (`fixtures_v2/`, `--check-fixtures` regenerates and compares)

- `host-model-catalog.json` and `host-resource-registry.json`: the conformance world's
  (`chrome-agent-browser/test/fixtures/authorization/inputs.json`). Both control planes normalize
  them (`conformance/drivers/`). The catalog holds one model, `ollama/qwen3:30b`.
- `host-tool-registry.<package>.json`: the registry the extension's own `buildHostToolRegistry`
  builds for the package on this host (`node bench.js fixtures`), in the wire form a host hands
  a control plane. The Python side reads it. The Node side builds its registry itself on every
  call, as the controller does, and that cost is inside the timed stages.
- `authorization.json` and the four `*-input.json` files: written by hand, described above.

## The per-operation arms (both runtimes, one production call per observation)

The run generates every input once and writes it to a file. Both runtimes read the same files.
Their SHA-256 are recorded in `metadata.json` → `micro_inputs`.

| Arm | Cells | The call |
|---|---|---|
| `scan_model_request`, `scan_tool_arguments` | document 1, 16, 256, 1,024 KiB × scan set 10, 100, 1,000 sealed values | `find_sealed` / `findSealed` (M-37) and `find_all_sealed` / `findAllSealed` (M-36), on a model-request-shaped document with no sealed value, so every string is read and every value tested: the cost of an allowed request or call. In both runtimes the model scan is the tool scan's first hit, so on a clean document the two run one scanner; both are timed, as the protocol names both |
| `compute_cold`, `compute_warm` | WebAir 0.8.0's `fares` module, `run`, a two-line quote | on the host's one engine (wasmtime-py; the Node engine's nested Worker per call, D-251): cold compiles the module under a cache key the engine has not seen, then calls; warm calls a compiled module |
| `network_worst_case`, `network_enumerate`, `network_route_data` | star and mesh networks of 3 … 8 roles, shaped as the Travel Network (the 4-role star is its own graph, a test checks) | `worst_case` (the reservation's bound, R-21), `enumerate_walks` under `DEFAULT_EFFORT` (R-23; a cap reached is recorded and the call times to the cap: mesh networks of 6 or more roles reach it), `route_data` (R-13) |
| `transition_check` | the Travel Network's runtime, an allowed hand-off at hop 0 | `_check_transition` / `checkTransition` (R-14), which records `route.decided` |
| `consent_gate` | WebAir 0.8.0's runtime in a turn: `simulate-purchase` after its step was accepted; `search-flights` (not gated) | `_check_consent` / `checkConsent` (V-9) |

**What the Node compute cells mean.** On Node, cold and warm are close by construction (runtime
`ts`, arms `compute_cold` and `compute_warm` in
`results/2026-11-05T12-40-00Z_v2-pooled/pooled_micro_summary.csv`): the engine spawns a nested Worker for every call (D-251), so
each call pays a Worker's start, and V8 compiles the `fares` module lazily in well under 0.1 ms (measured in T38's review with identical and with nonce-distinct bytes, so no module cache
hides a compile). The Node "cold" cell is therefore not a compile cost; the Python cold cell is
(wasmtime compiles eagerly). Both cold arms keep each observation's compiled copy under its own
key for the rest of the process (one per observation, warmup included); the comment in `node/bench.ts` that says "a fresh
engine compiles the module" predates D-305 and means the host's one engine. The measured code is
left as it ran (its SHA-256 is in each run's metadata); a later series can drop the key after the
call.

**One addition to the Node bundle.** The transition check is module-private in the Chrome core.
An esbuild `onLoad` hook therefore appends one line, `export { checkTransition };`, to
`core/network/runner.ts` in the bundle. No statement of the file changes, the production file is
untouched (a test checks both), and `build.json` records the addition. TypeScript-private methods
such as `checkConsent` are ordinary methods at run time and need nothing.

**Cross-runtime facts.** For each network the runtimes must agree on the bound and the walk
count, and they must agree on the compute output and the gated permissions. A difference fails
the run (`micro_facts_agree`).

## Protocol and output

The protocol is v1's: 50 warmup observations, then 5 batches × 200, in one process per runtime
and arm, with the garbage collector on and every observation kept. Per (batch, iteration) every
package runs once, in an order drawn from `random.Random(20261104)`, and both runtimes follow the
same drawn schedule. The Python side runs under v1's offline guard and the Node side under its
own guard, which also counts any `fetch`. A result directory `results/<UTC>_v2-<label>/` holds
these files:

- `manifest.json`, written before the first observation: the commit and the dirty-tree hash, the
  protocol's SHA-256, the configuration, the fixtures' hashes, the Node build.
- `samples.csv` and `warmup_samples.csv`: runtime, package, batch, iteration, position, stage,
  ns.
- `micro_samples.csv` and `micro_warmup_samples.csv`: runtime, arm, cell, batch, iteration, ns.
- `metadata.json`: the manifest, the identities, the evidence, `py_unrunnable`, the facts, the
  guards, the timing.
- `summary.json`, `summary.csv`, `micro_summary.csv` and `report.md`, written by
  `aggregate_v2.py`.

`aggregate_v2.py pool` refuses runs that differ in commit, configuration, scripts, protocol,
fixtures, machine or artifacts, or that come from a dirty tree, so a pooled directory cannot mix
commits (E7's defect). It writes `pooled_summary.{json,csv}`, `pooled_micro_summary.csv`,
`report.md` and `sources.json`. Each record carries the per-run medians.

## What a v2 number does not include

The excluded items are v1's: the download, human decision time, model inference, tools, and the
transport between a page and its control plane. On the extension that transport is Chrome's
message passing between the side panel, the service worker, the offscreen document and its
Worker; on the plugin it is HTTP over loopback. Also excluded: IndexedDB writes (`persist`,
`putRun`), origin-permission queries, the probe of the model providers (the catalog is a fixture),
and the secret store's unlock. Those are Chrome APIs, and the core does not run them in Node.
Each is named in the controller code the stages follow.
