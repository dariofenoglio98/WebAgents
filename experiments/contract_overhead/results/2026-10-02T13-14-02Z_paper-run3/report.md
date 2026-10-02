# Contract overhead: results

Run started 2026-10-02T13:14:02.341245+00:00 (UTC), benchmark contract_overhead 1.0.0, git `23eac90c1f6f` (working tree has changes, none in production paths).

## Question and metric

What local latency does the package-to-execution contract add before workflow execution? The metric is the wall-clock time (`time.perf_counter_ns`) from the moment the signed package bytes are in memory to the moment the workflow interpreter hands its first ready wave of nodes to its scheduler, through the production operations below, in one Python process. No node runs; no model, tool or network is reached.

## Packages

| | Meeting Agenda | Literature Review |
|---|---|---|
| Package id | `org.webagents.meeting-agenda` | `org.webagents.literature-review` |
| Version | 0.2.2 | 0.2.5 |
| Archive | `dist/meeting-agenda.agent.pkg` | `dist/literature-review.agent.pkg` |
| Archive SHA-256 | `7b148e845c0f9e38d752a51a8d0b60a314842a3de3a2723b3bdf1a0c041921e1` | `1669f83fafac3434748fc19d38a8d3d2c3352da83cf1cbb84796ce313bd4f571` |
| Package digest | `dbd2eb816bb8687d4a5b3448f5b82bc0716c3884f9fee8a2c578af0c5e894679` | `cef9ebd68df9db3b36c1ffeac9069d734b0e41a40d58445aaba1a60eaac155b5` |
| Signer fingerprint | `sha256:2bcc374a7fe18e50622042b7d0375fcb24eb3607879a236f9f3c3ede1922c5c4` | `sha256:c5ca9763f9fc71253298ca381ec14c4d7432009c74dacc69df6344b71de05232` |
| Archive bytes | 21,580 | 224,302 |
| Archive entries | 19 | 68 |
| Payload files | 17 | 66 |
| Graph nodes | 7 | 25 |
| Node types | join, llm, map, output, validate | join, llm, map, output, validate |
| Worker roles | 4 | 9 |
| First-wave (root) nodes | plan | planning |
| Declared tools | none | citation-resolver, paper-reader, scholarly-search |
| Model tasks | 3 | 8 |
| Required model capabilities | reasoning, structured_output | reasoning, structured_output |
| Required context window | 16,000 | 16,000 |
| Declared permissions | model.reasoning (model, required), memory.session (memory, required) | network.scholarly (network, required), network.citations (network, required), files.pdfs (files.read), model.reasoning (model), memory.session (memory, required) |

## Stages (production operations)

| Stage | Production operation | Interval |
|---|---|---|
| Package open and verification (`package_open_verify`) | `ControlPlane._open_bytes` | t0–t1 |
| Authorization receipt (`authorization_receipt`) | `ControlPlane.authorize` | t1–t2 |
| Model and tool compatibility (`compatibility_evaluation`) | `ControlPlane.evaluate_models + ControlPlane.evaluate_tools` | t2–t3 |
| Run Plan preparation (`run_plan_preparation`) | `ControlPlane.prepare_run_plan` | t3–t4 |
| Host revalidation and lease (`host_revalidation_lease`) | `ControlPlane.validate_input + run_plan + summary + authorization [+ evaluate_tools when tools are bound] + issue_execution_lease` | t4–t5 |
| Runner re-verification (`runner_verification`) | `ExecutionSession('execution.begin')` | t5–t6 |
| Workflow instantiation and start checks (`workflow_start`) | `ExecutionSession('execution.run') until Workflow dispatches its first wave` | t6–t7 |
| Total (`total_pre_execution`) | the whole sequence, one direct interval | t0–t7 |
| Secondary (`local_file_read`) | `agentpkg.package.read_regular_bytes (the read open_file performs)`, not in the total | before t0 |

## Protocol

- Warmup: 50 iterations per package, discarded (kept in `warmup_samples.csv`).
- Measured: 5 batches x 200 iterations = 1000 observations per package.
- Order: same process; within each (batch, iteration) every package runs once, in an order drawn from random.Random(seed); warmup uses the same scheme; seed 20261001.
- Garbage collector: enabled (Python default). No observation was removed.
- Wall time of the measurement: 614.3 s.

## Main result (paper groups)

All values in milliseconds.

| Operation | Meeting Agenda median | p95 | Literature Review median | p95 |
|---|---:|---:|---:|---:|
| Package verification | 18.85 | 19.34 | 147.91 | 153.73 |
| Authorization and binding | 0.88 | 0.93 | 1.86 | 1.92 |
| Run Plan preparation | 1.27 | 1.32 | 3.04 | 3.11 |
| Pre-execution revalidation | 34.82 | 35.50 | 279.73 | 286.56 |
| **Total** | 55.83 | 56.96 | 434.23 | 440.79 |

## Per-operation breakdown

| Operation | Meeting Agenda median | p95 | Literature Review median | p95 |
|---|---:|---:|---:|---:|
| Package open and verification | 18.85 | 19.34 | 147.91 | 153.73 |
| Authorization receipt | 0.27 | 0.29 | 0.39 | 0.41 |
| Model and tool compatibility | 0.61 | 0.65 | 1.47 | 1.51 |
| Run Plan preparation | 1.27 | 1.32 | 3.04 | 3.11 |
| Host revalidation and lease | 1.77 | 1.90 | 6.26 | 6.53 |
| Runner re-verification | 18.06 | 18.39 | 147.62 | 153.22 |
| Workflow instantiation and start checks | 15.01 | 15.34 | 124.96 | 130.65 |
| **Total** | 55.83 | 56.96 | 434.23 | 440.79 |
| Local file read (secondary, not in total) | 0.10 | 0.13 | 0.13 | 0.15 |

Medians of the stages do not add up to the median total; each row is summarized on its own.

## Paper-ready interpretation

For Meeting Agenda 0.2.2, the automated contract processing from in-memory package bytes to the first workflow-node dispatch required a median of 55.83 ms (p95 56.96 ms; n = 1000). For Literature Review 0.2.5, the automated contract processing from in-memory package bytes to the first workflow-node dispatch required a median of 434.23 ms (p95 440.79 ms; n = 1000).

- Meeting Agenda: the largest single operation by median was *Package open and verification* (18.85 ms, 34% of the median total), followed by *Runner re-verification* (18.06 ms). Of the four paper groups, *Pre-execution revalidation* had the largest median (34.82 ms).
- Literature Review: the largest single operation by median was *Package open and verification* (147.91 ms, 34% of the median total), followed by *Runner re-verification* (147.62 ms). Of the four paper groups, *Pre-execution revalidation* had the largest median (279.73 ms).
- The median total for Literature Review was 7.8x that of Meeting Agenda. The two artifacts differ in several respects at once (21,580 vs 224,302 archive bytes, 17 vs 66 payload files, 7 vs 25 graph nodes, 0 vs 3 declared tools), so two packages do not identify which property drives the difference and do not establish a scaling relation.
- Each measured observation re-verifies the package three times, as production does: when the control plane opens the snapshot, when the runner verifies the leased artifact, and when the interpreter re-checks integrity and re-validates the payload. No verification result is cached between them.
- Audit bookkeeping (reported separately, not part of the totals above): appending and hash-linking one recorded audit event through `Runtime.record`, without an observer, took Literature Review stream: median 5.4 us (p95 7.0 us, about 184,638 events/s at the median); Meeting Agenda stream: median 5.4 us (p95 6.6 us, about 186,047 events/s at the median).

Scope sentence: these figures measure only local automated contract processing in one Python process, and exclude package acquisition, human authorization time, model inference, external tool latency, loopback HTTP transport between plugin and control plane, and runner process start-up.

## Full statistics

Milliseconds; `std` is the sample standard deviation (n - 1); percentiles use linear interpolation (Hyndman–Fan type 7).

| Package | Kind | Stage | n | median | p95 | mean | std | min | max | p99 |
|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|
| Meeting Agenda | stage | `package_open_verify` | 1000 | 18.846 | 19.341 | 18.903 | 0.481 | 18.210 | 24.417 | 20.524 |
| Meeting Agenda | stage | `authorization_receipt` | 1000 | 0.266 | 0.285 | 0.269 | 0.032 | 0.224 | 1.034 | 0.303 |
| Meeting Agenda | stage | `compatibility_evaluation` | 1000 | 0.614 | 0.649 | 0.617 | 0.014 | 0.569 | 0.684 | 0.674 |
| Meeting Agenda | stage | `run_plan_preparation` | 1000 | 1.273 | 1.320 | 1.286 | 0.154 | 1.197 | 5.687 | 1.507 |
| Meeting Agenda | stage | `host_revalidation_lease` | 1000 | 1.766 | 1.904 | 1.767 | 0.170 | 1.305 | 4.220 | 2.131 |
| Meeting Agenda | stage | `runner_verification` | 1000 | 18.060 | 18.389 | 18.073 | 0.444 | 17.547 | 23.878 | 18.962 |
| Meeting Agenda | stage | `workflow_start` | 1000 | 15.011 | 15.338 | 15.068 | 0.346 | 14.697 | 20.754 | 15.868 |
| Meeting Agenda | group | `verification` | 1000 | 18.846 | 19.341 | 18.903 | 0.481 | 18.210 | 24.417 | 20.524 |
| Meeting Agenda | group | `authorization_and_binding` | 1000 | 0.881 | 0.929 | 0.886 | 0.035 | 0.805 | 1.615 | 0.972 |
| Meeting Agenda | group | `run_plan` | 1000 | 1.273 | 1.320 | 1.286 | 0.154 | 1.197 | 5.687 | 1.507 |
| Meeting Agenda | group | `revalidation` | 1000 | 34.816 | 35.502 | 34.908 | 0.594 | 33.910 | 40.732 | 37.517 |
| Meeting Agenda | total | `total_pre_execution` | 1000 | 55.832 | 56.961 | 55.982 | 0.826 | 54.342 | 62.025 | 60.905 |
| Meeting Agenda | secondary | `local_file_read` | 1000 | 0.101 | 0.128 | 0.103 | 0.017 | 0.064 | 0.306 | 0.149 |
| Literature Review | stage | `package_open_verify` | 1000 | 147.906 | 153.731 | 148.815 | 2.900 | 146.178 | 204.161 | 156.003 |
| Literature Review | stage | `authorization_receipt` | 1000 | 0.388 | 0.414 | 0.397 | 0.096 | 0.341 | 2.947 | 0.604 |
| Literature Review | stage | `compatibility_evaluation` | 1000 | 1.470 | 1.506 | 1.474 | 0.020 | 1.406 | 1.766 | 1.546 |
| Literature Review | stage | `run_plan_preparation` | 1000 | 3.037 | 3.105 | 3.067 | 0.514 | 2.927 | 18.845 | 3.523 |
| Literature Review | stage | `host_revalidation_lease` | 1000 | 6.264 | 6.532 | 6.324 | 0.581 | 5.657 | 15.635 | 7.615 |
| Literature Review | stage | `runner_verification` | 1000 | 147.617 | 153.221 | 148.589 | 2.379 | 145.996 | 171.473 | 155.636 |
| Literature Review | stage | `workflow_start` | 1000 | 124.962 | 130.650 | 125.911 | 2.272 | 123.567 | 138.342 | 133.466 |
| Literature Review | group | `verification` | 1000 | 147.906 | 153.731 | 148.815 | 2.900 | 146.178 | 204.161 | 156.003 |
| Literature Review | group | `authorization_and_binding` | 1000 | 1.858 | 1.917 | 1.870 | 0.099 | 1.798 | 4.385 | 2.133 |
| Literature Review | group | `run_plan` | 1000 | 3.037 | 3.105 | 3.067 | 0.514 | 2.927 | 18.845 | 3.523 |
| Literature Review | group | `revalidation` | 1000 | 279.725 | 286.562 | 280.823 | 3.382 | 276.637 | 310.923 | 290.326 |
| Literature Review | total | `total_pre_execution` | 1000 | 434.226 | 440.789 | 434.576 | 4.473 | 428.352 | 491.318 | 447.335 |
| Literature Review | secondary | `local_file_read` | 1000 | 0.127 | 0.155 | 0.130 | 0.028 | 0.090 | 0.855 | 0.173 |

## Stability

Batch medians of the total, per package (ms):

| Package | batch 0 | batch 1 | batch 2 | batch 3 | batch 4 | spread (% of median) |
|---|---:|---:|---:|---:|---:|---:|
| Literature Review | 433.188 | 433.551 | 433.924 | 433.712 | 436.313 | 0.7 |
| Meeting Agenda | 55.706 | 55.727 | 55.807 | 55.847 | 56.051 | 0.6 |

Largest batch-median spread among single operations: `workflow_start` for Literature Review, 0.8% of its median.

Order position (0 = ran first within its iteration) and tail of the total:

| Package | median at position 0 | median at position 1 | p99 / median | max / median | > 2x median | > 5x median |
|---|---:|---:|---:|---:|---:|---:|
| Meeting Agenda | 55.849 | 55.807 | 1.09 | 1.11 | 0 | 0 |
| Literature Review | 434.314 | 434.041 | 1.03 | 1.13 | 0 | 0 |

Negative values: 0. Exact zeros: 0.

## Component decomposition (diagnostic, separate from the totals)

The production functions inside package open, each called on its own with its own timer on the same in-memory bytes (milliseconds). The open stage runs all five once; the runner re-runs the first three; the interpreter re-runs the first two (integrity statement and payload validation). These calls are not part of the pipeline observations above and do not add up to them exactly.

| Package | Component | Production function | n | median | p95 | mean | std |
|---|---|---|---:|---:|---:|---:|---:|
| Meeting Agenda | container_integrity | `agentpkg.package.read_archive_bytes` | 500 | 2.874 | 2.981 | 2.884 | 0.062 |
| Meeting Agenda | schema_validation | `agentpkg.validation.validate_payload` | 500 | 14.326 | 14.654 | 14.377 | 0.299 |
| Meeting Agenda | signature | `agentpkg.browser.evaluation.signature_report` | 500 | 0.245 | 0.256 | 0.247 | 0.010 |
| Meeting Agenda | publisher_trust | `agentpkg.browser.trust.TrustStore.evaluate` | 500 | 0.152 | 0.168 | 0.150 | 0.014 |
| Meeting Agenda | inspection_summary | `agentpkg.browser.summary.build_summary` | 500 | 0.204 | 0.217 | 0.206 | 0.015 |
| Literature Review | container_integrity | `agentpkg.package.read_archive_bytes` | 500 | 23.361 | 23.756 | 23.396 | 0.266 |
| Literature Review | schema_validation | `agentpkg.validation.validate_payload` | 500 | 122.237 | 127.873 | 123.097 | 2.163 |
| Literature Review | signature | `agentpkg.browser.evaluation.signature_report` | 500 | 0.350 | 0.395 | 0.357 | 0.016 |
| Literature Review | publisher_trust | `agentpkg.browser.trust.TrustStore.evaluate` | 500 | 0.172 | 0.235 | 0.186 | 0.119 |
| Literature Review | inspection_summary | `agentpkg.browser.summary.build_summary` | 500 | 0.817 | 0.865 | 0.825 | 0.034 |

## Audit-event microbenchmark (separate from the totals)

`Runtime.record` replaying each recorded run's audit stream event by event into a fresh production `Runtime` per batch (microseconds per event). `no_observer` is the bookkeeping alone: build the event, hash it over RFC 8785 canonical JSON, link it to the previous hash, append. `progress_observer` adds the runner's live-progress observer.

| Variant | Stream | n | median | p95 | mean | std | min | max | events/s at median |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|
| no_observer | literature-review | 10100 | 5.42 | 6.96 | 5.74 | 1.25 | 4.54 | 39.62 | 184,638 |
| no_observer | meeting-agenda | 2300 | 5.38 | 6.62 | 5.62 | 2.76 | 4.42 | 107.67 | 186,047 |
| progress_observer | literature-review | 10100 | 11.54 | 15.00 | 12.28 | 2.03 | 9.83 | 102.92 | 86,640 |
| progress_observer | meeting-agenda | 2300 | 11.62 | 14.79 | 12.71 | 22.61 | 9.88 | 1,090.71 | 86,022 |

Streams: meeting-agenda: `examples/meeting-agenda-022-qwen/audit.json` (92 events); literature-review: `examples/literature-review-live/audit.json` (404 events)

## Optional context (not a paper claim)

Recorded live runs of the same Meeting Agenda version, read from run records in this repository at analysis time. They were recorded on a host session, not in this benchmark, and are shown only to place the measured magnitude next to a workflow duration. Literature Review 0.2.5 has no recorded live run in the repository, so no ratio is computed for it.

| Run record | Run id | Model | Workflow duration | Median contract total | Ratio |
|---|---|---|---:|---:|---:|
| `examples/meeting-agenda-022-qwen/run.json` | `run_76c1e18ab3c64a1b9470c656a9178d4b` | ollama/qwen3:30b | 133.2 s | 55.83 ms | 0.042% |
| `examples/meeting-agenda-022-luna/run.json` | `run_119d25dc76af40148a44b1c45c719281` | openai/gpt-5.6-luna | 32.4 s | 55.83 ms | 0.173% |

## Environment

- Darwin 15.7.4 (arm64), CPU Apple M3 Max, 14 logical CPUs (10 performance + 4 efficiency), 36 GiB memory.
- Python 3.13.5 (CPython); timer `mach_absolute_time()`, resolution 4.166666666666666e-08 s.
- agentpkg 0.2.2 (source in repository: True); dependencies jsonschema 4.26.0, referencing 0.37.0, cryptography 46.0.7, rfc8785 0.1.4.
- Agent Browser plugin 0.1.0; OpenClaw 2026.9.5 named by the fixtures; Node v26.9.0 (fixture generation only). Neither Node nor OpenClaw runs in the measured process.
- System load average (1/5/15 min) at start [2.01, 2.0, 2.74], at end [1.6, 1.58, 2.11].
- Offline guard violations: 0.

## Exclusions and limitations

- Excluded by construction: package download, human decision time, model inference, tool calls, network access, the Agent Browser plugin's loopback HTTP calls to the control plane (JSON serialization, `node:http`), the plugin-side field comparisons in `preflight.ts`, spawning the runner process, and the bridge framing of the inbound `execution.begin` request.
- The runner's plan projection (`preflight.ts`) is mirrored in Python; a test checks it equals the real TypeScript output.
- The stop at the first wave replaces `Workflow._gather` in the benchmark process only; everything before it is unmodified production code.
- One machine, one Python process, two packages. Absolute values depend on the machine and on the trust store contents (two pinned keys here); they are not a scaling law.

## Files

`metadata.json`, `samples.csv` (every measured observation, ns), `timestamps.csv` (t0..t7 offsets per observation), `warmup_samples.csv`, `summary.csv`, `summary.json`, `batch_summary.csv`, `audit_samples.csv`, `component_samples.csv`, `report.md`, `paper_table.tex`, `paper_table_detailed.tex`, `command.txt`.
