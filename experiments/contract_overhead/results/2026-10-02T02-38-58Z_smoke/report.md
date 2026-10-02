# Contract overhead: results

Run started 2026-10-02T02:38:58.060636+00:00 (UTC), benchmark contract_overhead 1.0.0, git `f5394750e4c2` (working tree has changes, none in production paths).

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

- Warmup: 2 iterations per package, discarded (kept in `warmup_samples.csv`).
- Measured: 1 batches x 5 iterations = 5 observations per package.
- Order: same process; within each (batch, iteration) every package runs once, in an order drawn from random.Random(seed); warmup uses the same scheme; seed 20261001.
- Garbage collector: enabled (Python default). No observation was removed.
- Wall time of the measurement: 5.6 s.

## Main result (paper groups)

All values in milliseconds.

| Operation | Meeting Agenda median | p95 | Literature Review median | p95 |
|---|---:|---:|---:|---:|
| Package verification | 19.27 | 19.58 | 151.25 | 155.55 |
| Authorization and binding | 0.91 | 0.91 | 1.93 | 1.94 |
| Run Plan preparation | 1.31 | 1.34 | 3.11 | 3.13 |
| Pre-execution revalidation | 35.81 | 36.09 | 288.51 | 293.08 |
| **Total** | 57.45 | 57.78 | 446.01 | 451.61 |

## Per-operation breakdown

| Operation | Meeting Agenda median | p95 | Literature Review median | p95 |
|---|---:|---:|---:|---:|
| Package open and verification | 19.27 | 19.58 | 151.25 | 155.55 |
| Authorization receipt | 0.27 | 0.28 | 0.40 | 0.44 |
| Model and tool compatibility | 0.63 | 0.64 | 1.50 | 1.53 |
| Run Plan preparation | 1.31 | 1.34 | 3.11 | 3.13 |
| Host revalidation and lease | 1.88 | 2.01 | 6.46 | 6.57 |
| Runner re-verification | 18.54 | 18.66 | 151.67 | 156.62 |
| Workflow instantiation and start checks | 15.30 | 15.71 | 130.26 | 131.72 |
| **Total** | 57.45 | 57.78 | 446.01 | 451.61 |
| Local file read (secondary, not in total) | 0.14 | 0.24 | 0.15 | 0.16 |

Medians of the stages do not add up to the median total; each row is summarized on its own.

## Paper-ready interpretation

For Meeting Agenda 0.2.2, the automated contract processing from in-memory package bytes to the first workflow-node dispatch required a median of 57.45 ms (p95 57.78 ms; n = 5). For Literature Review 0.2.5, the automated contract processing from in-memory package bytes to the first workflow-node dispatch required a median of 446.01 ms (p95 451.61 ms; n = 5).

- Meeting Agenda: the largest single operation by median was *Package open and verification* (19.27 ms, 34% of the median total), followed by *Runner re-verification* (18.54 ms). Of the four paper groups, *Pre-execution revalidation* had the largest median (35.81 ms).
- Literature Review: the largest single operation by median was *Runner re-verification* (151.67 ms, 34% of the median total), followed by *Package open and verification* (151.25 ms). Of the four paper groups, *Pre-execution revalidation* had the largest median (288.51 ms).
- The median total for Literature Review was 7.8x that of Meeting Agenda. The two artifacts differ in several respects at once (21,580 vs 224,302 archive bytes, 17 vs 66 payload files, 7 vs 25 graph nodes, 0 vs 3 declared tools), so two packages do not identify which property drives the difference and do not establish a scaling relation.
- Each measured observation re-verifies the package three times, as production does: when the control plane opens the snapshot, when the runner verifies the leased artifact, and when the interpreter re-checks integrity and re-validates the payload. No verification result is cached between them.
- Audit bookkeeping (reported separately, not part of the totals above): appending and hash-linking one recorded audit event through `Runtime.record`, without an observer, took Literature Review stream: median 5.5 us (p95 7.1 us, about 181,818 events/s at the median); Meeting Agenda stream: median 5.5 us (p95 6.8 us, about 181,818 events/s at the median).

Scope sentence: these figures measure only local automated contract processing in one Python process, and exclude package acquisition, human authorization time, model inference, external tool latency, loopback HTTP transport between plugin and control plane, and runner process start-up.

## Full statistics

Milliseconds; `std` is the sample standard deviation (n - 1); percentiles use linear interpolation (Hyndman–Fan type 7).

| Package | Kind | Stage | n | median | p95 | mean | std | min | max | p99 |
|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|
| Meeting Agenda | stage | `package_open_verify` | 5 | 19.271 | 19.583 | 19.317 | 0.246 | 19.003 | 19.596 | 19.594 |
| Meeting Agenda | stage | `authorization_receipt` | 5 | 0.271 | 0.279 | 0.272 | 0.005 | 0.266 | 0.280 | 0.280 |
| Meeting Agenda | stage | `compatibility_evaluation` | 5 | 0.626 | 0.642 | 0.630 | 0.010 | 0.617 | 0.644 | 0.644 |
| Meeting Agenda | stage | `run_plan_preparation` | 5 | 1.305 | 1.342 | 1.307 | 0.027 | 1.282 | 1.349 | 1.347 |
| Meeting Agenda | stage | `host_revalidation_lease` | 5 | 1.877 | 2.007 | 1.889 | 0.092 | 1.783 | 2.035 | 2.030 |
| Meeting Agenda | stage | `runner_verification` | 5 | 18.544 | 18.659 | 18.564 | 0.073 | 18.485 | 18.682 | 18.677 |
| Meeting Agenda | stage | `workflow_start` | 5 | 15.303 | 15.709 | 15.406 | 0.219 | 15.255 | 15.781 | 15.767 |
| Meeting Agenda | group | `verification` | 5 | 19.271 | 19.583 | 19.317 | 0.246 | 19.003 | 19.596 | 19.594 |
| Meeting Agenda | group | `authorization_and_binding` | 5 | 0.906 | 0.910 | 0.902 | 0.009 | 0.888 | 0.911 | 0.911 |
| Meeting Agenda | group | `run_plan` | 5 | 1.305 | 1.342 | 1.307 | 0.027 | 1.282 | 1.349 | 1.347 |
| Meeting Agenda | group | `revalidation` | 5 | 35.814 | 36.089 | 35.860 | 0.198 | 35.674 | 36.105 | 36.102 |
| Meeting Agenda | total | `total_pre_execution` | 5 | 57.446 | 57.779 | 57.386 | 0.327 | 57.020 | 57.855 | 57.840 |
| Meeting Agenda | secondary | `local_file_read` | 5 | 0.140 | 0.241 | 0.160 | 0.059 | 0.125 | 0.265 | 0.260 |
| Literature Review | stage | `package_open_verify` | 5 | 151.250 | 155.552 | 152.483 | 2.260 | 150.631 | 156.152 | 156.032 |
| Literature Review | stage | `authorization_receipt` | 5 | 0.401 | 0.436 | 0.409 | 0.022 | 0.386 | 0.439 | 0.439 |
| Literature Review | stage | `compatibility_evaluation` | 5 | 1.504 | 1.528 | 1.511 | 0.014 | 1.499 | 1.530 | 1.529 |
| Literature Review | stage | `run_plan_preparation` | 5 | 3.108 | 3.125 | 3.103 | 0.021 | 3.071 | 3.129 | 3.128 |
| Literature Review | stage | `host_revalidation_lease` | 5 | 6.456 | 6.571 | 6.445 | 0.137 | 6.220 | 6.587 | 6.584 |
| Literature Review | stage | `runner_verification` | 5 | 151.665 | 156.620 | 152.712 | 2.885 | 151.154 | 157.853 | 157.606 |
| Literature Review | stage | `workflow_start` | 5 | 130.258 | 131.720 | 130.388 | 1.032 | 129.244 | 132.006 | 131.948 |
| Literature Review | group | `verification` | 5 | 151.250 | 155.552 | 152.483 | 2.260 | 150.631 | 156.152 | 156.032 |
| Literature Review | group | `authorization_and_binding` | 5 | 1.931 | 1.944 | 1.920 | 0.028 | 1.886 | 1.944 | 1.944 |
| Literature Review | group | `run_plan` | 5 | 3.108 | 3.125 | 3.103 | 0.021 | 3.071 | 3.129 | 3.128 |
| Literature Review | group | `revalidation` | 5 | 288.510 | 293.084 | 289.545 | 2.588 | 287.391 | 293.928 | 293.759 |
| Literature Review | total | `total_pre_execution` | 5 | 446.013 | 451.609 | 447.050 | 3.732 | 443.635 | 452.082 | 451.987 |
| Literature Review | secondary | `local_file_read` | 5 | 0.154 | 0.164 | 0.149 | 0.015 | 0.128 | 0.166 | 0.166 |

## Stability

Batch medians of the total, per package (ms):

| Package | batch 0 | spread (% of median) |
|---|---:|---:|
| Literature Review | 446.013 | 0.0 |
| Meeting Agenda | 57.446 | 0.0 |

Largest batch-median spread among single operations: `authorization_receipt` for Literature Review, 0.0% of its median.

Order position (0 = ran first within its iteration) and tail of the total:

| Package | median at position 0 | median at position 1 | p99 / median | max / median | > 2x median | > 5x median |
|---|---:|---:|---:|---:|---:|---:|
| Meeting Agenda | 57.438 | 57.446 | 1.01 | 1.01 | 0 | 0 |
| Literature Review | 443.805 | 450.899 | 1.01 | 1.01 | 0 | 0 |

Negative values: 0. Exact zeros: 0.

## Component decomposition (diagnostic, separate from the totals)

The production functions inside package open, each called on its own with its own timer on the same in-memory bytes (milliseconds). The open stage runs all five once; the runner re-runs the first three; the interpreter re-runs the first two (integrity statement and payload validation). These calls are not part of the pipeline observations above and do not add up to them exactly.

| Package | Component | Production function | n | median | p95 | mean | std |
|---|---|---|---:|---:|---:|---:|---:|
| Meeting Agenda | container_integrity | `agentpkg.package.read_archive_bytes` | 5 | 2.961 | 3.113 | 2.983 | 0.096 |
| Meeting Agenda | schema_validation | `agentpkg.validation.validate_payload` | 5 | 14.550 | 14.753 | 14.561 | 0.154 |
| Meeting Agenda | signature | `agentpkg.browser.evaluation.signature_report` | 5 | 0.254 | 0.259 | 0.254 | 0.005 |
| Meeting Agenda | publisher_trust | `agentpkg.browser.trust.TrustStore.evaluate` | 5 | 0.150 | 0.162 | 0.153 | 0.006 |
| Meeting Agenda | inspection_summary | `agentpkg.browser.summary.build_summary` | 5 | 0.213 | 0.215 | 0.211 | 0.004 |
| Literature Review | container_integrity | `agentpkg.package.read_archive_bytes` | 5 | 23.781 | 23.811 | 23.723 | 0.108 |
| Literature Review | schema_validation | `agentpkg.validation.validate_payload` | 5 | 125.515 | 128.624 | 126.033 | 1.928 |
| Literature Review | signature | `agentpkg.browser.evaluation.signature_report` | 5 | 0.393 | 0.402 | 0.393 | 0.008 |
| Literature Review | publisher_trust | `agentpkg.browser.trust.TrustStore.evaluate` | 5 | 0.203 | 0.266 | 0.219 | 0.042 |
| Literature Review | inspection_summary | `agentpkg.browser.summary.build_summary` | 5 | 0.840 | 0.887 | 0.846 | 0.030 |

## Audit-event microbenchmark (separate from the totals)

`Runtime.record` replaying each recorded run's audit stream event by event into a fresh production `Runtime` per batch (microseconds per event). `no_observer` is the bookkeeping alone: build the event, hash it over RFC 8785 canonical JSON, link it to the previous hash, append. `progress_observer` adds the runner's live-progress observer.

| Variant | Stream | n | median | p95 | mean | std | min | max | events/s at median |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|
| no_observer | literature-review | 10100 | 5.50 | 7.12 | 5.86 | 2.62 | 4.62 | 237.29 | 181,818 |
| no_observer | meeting-agenda | 2300 | 5.50 | 6.75 | 5.75 | 2.73 | 4.58 | 105.75 | 181,818 |
| progress_observer | literature-review | 10100 | 11.67 | 15.29 | 12.57 | 12.10 | 9.88 | 1,210.71 | 85,712 |
| progress_observer | meeting-agenda | 2300 | 11.83 | 15.08 | 12.52 | 2.89 | 9.96 | 99.71 | 84,509 |

Streams: meeting-agenda: `examples/meeting-agenda-022-qwen/audit.json` (92 events); literature-review: `examples/literature-review-live/audit.json` (404 events)

## Optional context (not a paper claim)

Recorded live runs of the same Meeting Agenda version, read from run records in this repository at analysis time. They were recorded on a host session, not in this benchmark, and are shown only to place the measured magnitude next to a workflow duration. Literature Review 0.2.5 has no recorded live run in the repository, so no ratio is computed for it.

| Run record | Run id | Model | Workflow duration | Median contract total | Ratio |
|---|---|---|---:|---:|---:|
| `examples/meeting-agenda-022-qwen/run.json` | `run_76c1e18ab3c64a1b9470c656a9178d4b` | ollama/qwen3:30b | 133.2 s | 57.45 ms | 0.043% |
| `examples/meeting-agenda-022-luna/run.json` | `run_119d25dc76af40148a44b1c45c719281` | openai/gpt-5.6-luna | 32.4 s | 57.45 ms | 0.178% |

## Environment

- Darwin 15.7.4 (arm64), CPU Apple M3 Max, 14 logical CPUs (10 performance + 4 efficiency), 36 GiB memory.
- Python 3.13.5 (CPython); timer `mach_absolute_time()`, resolution 4.166666666666666e-08 s.
- agentpkg 0.2.2 (source in repository: True); dependencies jsonschema 4.26.0, referencing 0.37.0, cryptography 46.0.7, rfc8785 0.1.4.
- Agent Browser plugin 0.1.0; OpenClaw 2026.9.5 named by the fixtures; Node v26.9.0 (fixture generation only). Neither Node nor OpenClaw runs in the measured process.
- System load average (1/5/15 min) at start [2.91, 3.3, 3.25], at end [2.76, 3.26, 3.24].
- Offline guard violations: 0.

## Exclusions and limitations

- Excluded by construction: package download, human decision time, model inference, tool calls, network access, the Agent Browser plugin's loopback HTTP calls to the control plane (JSON serialization, `node:http`), the plugin-side field comparisons in `preflight.ts`, spawning the runner process, and the bridge framing of the inbound `execution.begin` request.
- The runner's plan projection (`preflight.ts`) is mirrored in Python; a test checks it equals the real TypeScript output.
- The stop at the first wave replaces `Workflow._gather` in the benchmark process only; everything before it is unmodified production code.
- One machine, one Python process, two packages. Absolute values depend on the machine and on the trust store contents (two pinned keys here); they are not a scaling law.

## Files

`metadata.json`, `samples.csv` (every measured observation, ns), `timestamps.csv` (t0..t7 offsets per observation), `warmup_samples.csv`, `summary.csv`, `summary.json`, `batch_summary.csv`, `audit_samples.csv`, `component_samples.csv`, `report.md`, `paper_table.tex`, `paper_table_detailed.tex`, `command.txt`.
