# Design

## 1. What a case is

A **template** (in `cases/f1_*.py` … `cases/f8_*.py`) is one way of violating one guarantee. It
declares, before anything runs: the violated assumption, the production component expected to
catch it, the lifecycle stage, the refusal codes it expects, the forbidden boundary, the matched
control, whether it is finite or parametric, the most relevant ablation, the primary guard, and
whether that ablation removes the guard (`ablation_removes_guard`). A **variant** is one
concrete, distinct instance of a template for one package, plain JSON generated deterministically
from the seed. `Template.plan(variant, kind)` turns it into an executable `CasePlan` and the
boundary predicate the oracle evaluates. Every violation has a **matched control** in the same
template: the same flow with the perturbation absent or replaced by a benign one.

Templates that corrupt a single model or tool answer are derived from a **calibration**: one
benign full-system run per package that records the router's schema and the well-behaved answer
of every model task (never a request or prompt) and the run's usage. A schema violation enters
the catalog only if the corrupted calibrated answer fails the router's own schema; a relational
violation and every control only if theirs passes. The provider checks the same again at run time,
so a case that does not inject what it claims becomes a `HARNESS_ERROR`, never a detection. Two
values the production path generates per run — the Crossref adapter's retrieval timestamps and the
random selected-file capability id — are replaced in the recorded answers by fixed placeholders of
the same form, so the calibration and the catalog depend only on the seed and the artifacts (a
test runs the calibration twice and compares hashes).

## 2. The production path

Each case is driven through the Agent Browser page's own operations against the real
`AgentBrowserBackend` (compiled from `openclaw-agent-browser/src`) and the real `agentpkg`
control plane:

```
openLocal -> [pinSessionPublisher] -> getPermissions -> authorize -> [selectFile]
  -> evaluateTools / evaluateModels -> prepareRunPlan -> (hooks: the world changes)
  -> validateInput -> startExecution
     -> plugin start checks, revalidate, execution lease (control plane)
     -> runner: execution.begin / execution.run (agentpkg.execution)
     -> Workflow / Runtime -> model router / tool handlers -> execution bridge
     -> completeWithBoundModel (host LLM) / ToolBroker (+ adapters, file capabilities)
```

The synthetic model, Crossref, Citation Resolver, DNS and PDF parser answer at the seams the
plugin exposes for its own tests (`llm`, `toolTransport`, `dns.lookup`, `pdfReader`); see
`harness/host_helper.mjs`. The runner is the production `ExecutionSession` behind a production
`BridgePeer`, composed exactly as `agentpkg.execution.session.serve` composes them, with stdio
carried over the helper's RPC (`harness/host.py`). Observation-only wrappers record which run
directory a run was given, the plugin's refusal of a start, the tool calls that reach the broker
(argument names only), every committed workflow wave (`StateProbe`), and whether a map's declared
`max_items` refused its input; each re-raises or returns unchanged, and a test checks that a run
is identical with and without them.

## 3. Enforcement map

Which production check is responsible for each guarantee, the refusal it issues, and the ablation
that removes it. The per-template fields are in `case_catalog.json` / `.csv`; the exact patch of
every ablation site is in `harness/ablations.py` and in each run's `patches/*.diff`.

| Family | Guarantee | Primary checks (production) | Refusal | Stage | Ablation sites |
|---|---|---|---|---|---|
| F1 Verification | the executed bytes are the signed bytes | `package._archive_payload` (canonical ZIP, `_safe_name`, strict JSON); integrity statement (`package`, `workflow.Workflow`, `execution.artifact`); `signing.check_signature` (digest binding, embedded key); runner signature presence | `package_rejected` (container / integrity / schema), `signature_not_valid` | verify | `V.integrity.*`, `V.signature.*`, `require_valid_signature`; container and parse rules are kept by design |
| F2 Trust | a valid signature is not a trusted publisher | `browser.trust.TrustStore` (trusted / unknown / mismatch); `authorization.blocking_reasons`; page pin action | `publisher_not_trusted` | trust | `require_trusted_publisher` |
| F3 Authorization | nothing runs on authority the person did not grant | receipt blocking reasons; `runplan.preparation_blockers`; plugin `revalidate` and start file-permission check; runner `normalize_grants` / `check_tools`; `Runtime._authorize` per call | `required_permission_denied`, `execution_mode_permission_denied`, `tool_not_approved`, `execution_grant_unsupported`, `permission_denied` | authorize, revalidate, execute/tool | `A.receipt.*`, `A.prepare.*`, `A.runner.*`, `A.runtime.*`, `A.revalidate.*`, `A.start.file_permission` |
| F4 Compatibility | the host satisfies the package's requirements and binds matching contracts | model evaluation (capabilities, context, selectability); tool evaluation (bound, contract digest); plugin host-runtime check; runner model/tool/contract checks; runtime version | `model_incompatible`, `model_not_selectable`, `tool_not_bound`, `tool_contract_mismatch`, runtime / profile refusals | compatibility, revalidate | `C.prepare.*`, `C.runner.*`, `C.runtime.*`, `C.revalidate.*`, `C.start.host_runtime`, browser-policy requirement flags |
| F5 Plan binding | what runs is what was planned, re-checked at start | control-plane `preflight` (stale reasons); plugin `revalidate` (plan identity, digest, archive hash, publisher, receipt, bindings, model availability and identity, receipt lifetime); execution lease (snapshot and read-back hashes); runner echo checks | `run_plan_stale` (+ reason), `execution_lease_unstable`, `execution_artifact_mismatch`, `tool_binding_stale`, `selected_model_unavailable` | revalidate | `R.preflight.*`, `R.lease.*`, `R.runner.*`, `R.revalidate.*` (34 sites) |
| F6 Host mediation | models, tools and files are reached only through approved bindings | static `workflow_validation` (declared tools, tasks, roles, views, reserved exports); `Runtime` confinement (role tools, state views, tasks, network contract, tool input schema); runner graph tools and export names; `ToolBroker` (bound resolution, binding echo, file capability, address policy, request shape); adapters; router and host-LLM model echo | `package_rejected`, `tool_request_invalid`, `tool_unavailable`, `execution_export_path_reserved`, `selected_model_unavailable`, `tool_contract_mismatch` | verify, revalidate, execute/model, execute/tool | `M.runtime.*`, `M.workflow.node_write`, `M.runner.*`, `M.handler.*`, `M.router.model_echo`, `M.broker.*`, `M.adapter.*`, `M.host_llm.*`, `M.start.*`, `M.files.*`; static validation is kept by design |
| F7 Output integrity | an answer is used only if it keeps its declared contract | router parse, termination and schema; `Runtime` model and tool output schemas; `Workflow` node, map, state and output validation and declared assertions; broker content type and size; adapters | `model_output_not_conforming`, `model_output_truncated`, `model_turn_failed`, `tool_response_invalid`, `schema_validation` | execute/model, execute/tool, validate | `O.router.*`, `O.runtime.*`, `O.workflow.*`, `O.broker.*`; JSON parsing and `lookup` constructors are kept by design |
| F8 Resources | budgets, caps, fan-out bounds and deadlines hold | `Runtime` reservations (global, worker, context window), remote and per-tool budgets, accounting halt; `Workflow` `max_items`, node and graph deadlines; runner output cap, watchdog and input bound; router and handler timeouts; broker timeouts; plugin, control-plane and server task-size bounds | `global_token_budget`, `worker_token_budget`, budget refusals, `schema_validation` (map bound), `execution_output_cap_too_large`, `token_accounting_halt`, `model_usage_*`, `timeout`, `bridge_timeout`, `tool_timeout`, `input_size`, `request_too_large` | resource, revalidate | `B.runtime.*`, `B.workflow.*`, `B.runner.*`, `B.router.*`, `B.handler.*`, `B.broker.*`, `B.server.*`, `B.control.*`, `B.start.*`, `B.bridge.*` |

## 4. The oracle

`harness/oracle.py` answers two questions separately. First: was the forbidden boundary reached?
The template's own predicate (`cases/boundaries.py`) over canaries and the state probe — a taint
marker in committed state, a node commit, an unplanned model's completion, an unauthorized or
non-public transport, a canary open, a broker call carrying an undeclared argument, a dispatch
above a cap, a charge below honest usage. Second: what stopped the run? The earliest refusal,
looked up in `harness/codes.py`, whose every code and fixed message a test finds in the production
source. Outcomes:

* violation: `SILENT_VIOLATION` if the boundary was reached; else `HARNESS_ERROR` if the
  experiment failed or the fault never fired; else `EXPLICIT_BLOCK` for a recognized refusal;
  `HARNESS_ERROR` (`violation_not_observed`) if the run completed with neither; otherwise
  `INCIDENTAL_FAILURE`;
* control: `BENIGN_ACCEPT` if the run completed with no refusal; else `HARNESS_ERROR` or
  `FALSE_REJECT`.

Refusals produced by the simulated host (OpenClaw's own `model_call_not_authorized`) are not in
the vocabulary, so the experiment never credits WebAgents with a refusal its simulation made.

## 5. Metrics

Per profile, family, template and package, with 95% Wilson score intervals: VDR (explicit blocks /
violations), SVR, IFR, BAR (accepted controls / controls), and paired contract correctness,
(explicitly blocked violations + accepted matched controls) / (violations + matched controls), each
matched control counted once. Denominators include harness errors, so a harness error can only
lower a rate. Stage, component and code accuracy are measured over explicit blocks against the
catalog's a-priori expectation. A refused attempt by production code to open a socket, resolve a
name or start a process — a path the experiment's seams do not cover — makes its case a
`HARNESS_ERROR`, so such an attempt fails the experiment instead of disappearing into a log.

`paper_manifest.json` (experiment version and code fingerprint, git commit and dirty-tree
fingerprint, package identities, seed, preset, profiles, build keys, calibration and catalog
hashes, expected executions) is written before the first case runs; its hash is recorded in
`config.json`, `--resume` refuses a directory whose manifest, code, builds, calibration or catalog
changed, and the analysis verifies the manifest rather than rewriting it.

## 6. Ablations

One profile per component; each removes that component everywhere it is enforced, in Python and
in TypeScript, and nothing else. A site is an exact source patch that must match once
(`harness/build.py`); most turn a refusing `if CONDITION:` into `if False:` (`ablatedNever() &&
(CONDITION)` in TypeScript, which keeps type narrowing), a few replace a validation call, a
timeout or a constant. Patched copies are built under `.cache/builds/`, content-addressed by the
production sources and the patches; each worker process imports its own profile's copy through
`PYTHONPATH` and refuses to start if it imported anything else. No production module, CLI flag,
configuration key or environment variable can select a patched build; tests check each property,
that every patch matches exactly once, that building leaves the production sources untouched, and
that one case cannot leak into the next.

The verification ablation keeps container parsing and schema validation, the mediation ablation
keeps static workflow validation, and the output-validation ablation keeps JSON parsing and
`lookup` constructors: without them a payload or answer has no value to run. Templates whose
primary guard is one of these are marked `ablation_removes_guard: false`, so an explicit block
under their ablation is expected and reported as a retained guard.

## 7. Deviations from a production deployment

* The model, Crossref, the Citation Resolver, DNS and the PDF parser are synthetic and recording.
  The synthetic provider resolves models as OpenClaw documents (exact ref, or the agent default
  when a ref cannot be resolved), so substitution is exercised as the host would perform it.
* Crossref's binding spaces requests by one second (`minIntervalMs`); the experiment's host omits
  that spacing (`harness/world.py`) because there is no shared pool to protect. It is part of the
  binding digest, so every plan binds the experiment host's definition consistently.
* The control plane is called through its own route table in process; the HTTP front end's request
  and response bounds are applied by the harness from the production server's constants.
* The runner runs in process behind the real bridge protocol instead of as a child process; the
  lease file and run directory are opened exactly as the parent hands them over.

## 8. Qualification corrections

Qualification exists to find cases whose a-priori expectation was wrong. Each correction below
changed the catalog, never the outcome rules:

* Literal and oracle fixes: the plugin puts its fixed refusal sentence in the error title, which
  the oracle now reads with the detail; a refused map input is attributed to the resource bound
  only when the probe saw `max_items` exceeded; simulated-host refusals were removed from the
  vocabulary; usage-report refusals are stage `resource`.
* Worker budgets bind each worker instance, not a role (runtime keys usage by worker id; the
  broker documentation says "per worker"), so the per-worker remote-call violation is an instance
  allowed 0 calls, not a role allowed fewer calls than all its instances make.
* The packages declare a 16,000-token context requirement, but their calls reserve more (the input
  bound plus the declared output cap: up to 16,643 for Meeting Agenda, 40,929 for Literature
  Review). A model at exactly 16,000 is refused at dispatch (`context_window`), fail-closed. The
  boundary control is therefore the smallest context the calibrated calls need. This is a
  packaging observation, not an enforcement defect.
* Three templates mixed variants that different real checks refuse at different stages and were
  split: a document named by the task without the file permission is refused at the read
  (`F3.named_document_without_permission`), not at start; a model answer naming a file path is
  refused by its output schema (`F6.file_path_from_model`) before the broker sees it; a resolver
  answer resolving the wrong paper is refused by the package's identity relation
  (`F7.resolver_identity`), not by the tool schema.
* The resource ablation first missed three of the four places the 256 KiB task bound is enforced
  (the control plane's request bound and task validation, and the runner's input); they were added.
* Schema mutations are sampled per model task across operators (the parametric budget per task),
  so one family no longer dominates the pooled numbers.
* A crash-and-resume check (SIGKILL of the whole run, then `--resume`) showed the calibration
  carried two run-specific generated values (timestamps, a random capability id); they are now
  normalized (section 1), after which the resumed run's summary is identical to an uninterrupted
  run's.

Every correction was made before any paper-preset run; none changed an oracle rule to turn an
observed outcome into another, and no production file was modified.

## 9. Findings

* **CE-1** (product defect, fixed): an invalid output-token count was charged as zero instead of
  refused — see [`findings/usage-count-coercion/`](findings/usage-count-coercion/). It was the only
  full-system silent violation in qualification. It was fixed in the plugin and the router (not in
  the experiment); with the catalog unchanged, the qualification rerun blocks every usage case.
  The usage-report validation is not part of the `-Resource enforcement` ablation (the router's
  `_count` never was), so those cases stay blocked under it.
