# Contract overhead: results

Run started 2026-10-02T02:39:10.402703+00:00 (UTC), benchmark contract_overhead 1.0.0, git `f5394750e4c2` (working tree has changes, none in production paths).

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
- Wall time of the measurement: 630.2 s.

## Main result (paper groups)

All values in milliseconds.

| Operation | Meeting Agenda median | p95 | Literature Review median | p95 |
|---|---:|---:|---:|---:|
| Package verification | 19.27 | 20.07 | 151.91 | 157.94 |
| Authorization and binding | 0.90 | 0.96 | 1.91 | 1.99 |
| Run Plan preparation | 1.30 | 1.36 | 3.11 | 3.22 |
| Pre-execution revalidation | 35.60 | 36.76 | 287.07 | 295.03 |
| **Total** | 57.10 | 59.09 | 445.58 | 455.48 |

## Per-operation breakdown

| Operation | Meeting Agenda median | p95 | Literature Review median | p95 |
|---|---:|---:|---:|---:|
| Package open and verification | 19.27 | 20.07 | 151.91 | 157.94 |
| Authorization receipt | 0.27 | 0.30 | 0.40 | 0.44 |
| Model and tool compatibility | 0.63 | 0.67 | 1.51 | 1.57 |
| Run Plan preparation | 1.30 | 1.36 | 3.11 | 3.22 |
| Host revalidation and lease | 1.79 | 2.03 | 6.53 | 6.98 |
| Runner re-verification | 18.45 | 19.06 | 151.29 | 157.51 |
| Workflow instantiation and start checks | 15.36 | 15.87 | 128.34 | 134.61 |
| **Total** | 57.10 | 59.09 | 445.58 | 455.48 |
| Local file read (secondary, not in total) | 0.12 | 0.16 | 0.14 | 0.18 |

Medians of the stages do not add up to the median total; each row is summarized on its own.

## Paper-ready interpretation

For Meeting Agenda 0.2.2, the automated contract processing from in-memory package bytes to the first workflow-node dispatch required a median of 57.10 ms (p95 59.09 ms; n = 1000). For Literature Review 0.2.5, the automated contract processing from in-memory package bytes to the first workflow-node dispatch required a median of 445.58 ms (p95 455.48 ms; n = 1000).

- Meeting Agenda: the largest single operation by median was *Package open and verification* (19.27 ms, 34% of the median total), followed by *Runner re-verification* (18.45 ms). Of the four paper groups, *Pre-execution revalidation* had the largest median (35.60 ms).
- Literature Review: the largest single operation by median was *Package open and verification* (151.91 ms, 34% of the median total), followed by *Runner re-verification* (151.29 ms). Of the four paper groups, *Pre-execution revalidation* had the largest median (287.07 ms).
- The median total for Literature Review was 7.8x that of Meeting Agenda. The two artifacts differ in several respects at once (21,580 vs 224,302 archive bytes, 17 vs 66 payload files, 7 vs 25 graph nodes, 0 vs 3 declared tools), so two packages do not identify which property drives the difference and do not establish a scaling relation.
- Each measured observation re-verifies the package three times, as production does: when the control plane opens the snapshot, when the runner verifies the leased artifact, and when the interpreter re-checks integrity and re-validates the payload. No verification result is cached between them.
- Audit bookkeeping (reported separately, not part of the totals above): appending and hash-linking one recorded audit event through `Runtime.record`, without an observer, took Literature Review stream: median 5.8 us (p95 8.5 us, about 173,913 events/s at the median); Meeting Agenda stream: median 5.5 us (p95 6.8 us, about 181,818 events/s at the median).

Scope sentence: these figures measure only local automated contract processing in one Python process, and exclude package acquisition, human authorization time, model inference, external tool latency, loopback HTTP transport between plugin and control plane, and runner process start-up.

## Full statistics

Milliseconds; `std` is the sample standard deviation (n - 1); percentiles use linear interpolation (Hyndman–Fan type 7).

| Package | Kind | Stage | n | median | p95 | mean | std | min | max | p99 |
|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|
| Meeting Agenda | stage | `package_open_verify` | 1000 | 19.271 | 20.073 | 19.429 | 1.642 | 18.576 | 67.847 | 21.370 |
| Meeting Agenda | stage | `authorization_receipt` | 1000 | 0.271 | 0.299 | 0.280 | 0.077 | 0.237 | 1.849 | 0.420 |
| Meeting Agenda | stage | `compatibility_evaluation` | 1000 | 0.629 | 0.670 | 0.634 | 0.017 | 0.599 | 0.775 | 0.695 |
| Meeting Agenda | stage | `run_plan_preparation` | 1000 | 1.297 | 1.360 | 1.308 | 0.103 | 1.213 | 3.587 | 1.471 |
| Meeting Agenda | stage | `host_revalidation_lease` | 1000 | 1.795 | 2.034 | 1.813 | 0.148 | 1.362 | 3.480 | 2.293 |
| Meeting Agenda | stage | `runner_verification` | 1000 | 18.450 | 19.061 | 18.522 | 0.613 | 17.858 | 29.281 | 20.455 |
| Meeting Agenda | stage | `workflow_start` | 1000 | 15.364 | 15.872 | 15.441 | 0.455 | 14.935 | 23.069 | 16.846 |
| Meeting Agenda | group | `verification` | 1000 | 19.271 | 20.073 | 19.429 | 1.642 | 18.576 | 67.847 | 21.370 |
| Meeting Agenda | group | `authorization_and_binding` | 1000 | 0.902 | 0.964 | 0.914 | 0.081 | 0.847 | 2.449 | 1.085 |
| Meeting Agenda | group | `run_plan` | 1000 | 1.297 | 1.360 | 1.308 | 0.103 | 1.213 | 3.587 | 1.471 |
| Meeting Agenda | group | `revalidation` | 1000 | 35.598 | 36.762 | 35.775 | 0.939 | 34.753 | 53.857 | 39.972 |
| Meeting Agenda | total | `total_pre_execution` | 1000 | 57.100 | 59.085 | 57.426 | 2.099 | 55.477 | 108.370 | 62.595 |
| Meeting Agenda | secondary | `local_file_read` | 1000 | 0.120 | 0.162 | 0.131 | 0.140 | 0.073 | 4.160 | 0.241 |
| Literature Review | stage | `package_open_verify` | 1000 | 151.906 | 157.942 | 152.872 | 2.788 | 148.940 | 178.007 | 162.395 |
| Literature Review | stage | `authorization_receipt` | 1000 | 0.402 | 0.435 | 0.408 | 0.062 | 0.349 | 2.106 | 0.547 |
| Literature Review | stage | `compatibility_evaluation` | 1000 | 1.505 | 1.566 | 1.513 | 0.032 | 1.429 | 1.807 | 1.654 |
| Literature Review | stage | `run_plan_preparation` | 1000 | 3.114 | 3.224 | 3.130 | 0.086 | 3.003 | 4.028 | 3.551 |
| Literature Review | stage | `host_revalidation_lease` | 1000 | 6.534 | 6.977 | 6.603 | 0.505 | 5.854 | 12.209 | 8.351 |
| Literature Review | stage | `runner_verification` | 1000 | 151.289 | 157.509 | 152.412 | 2.913 | 149.230 | 173.295 | 164.277 |
| Literature Review | stage | `workflow_start` | 1000 | 128.341 | 134.605 | 129.471 | 3.405 | 126.258 | 193.805 | 138.746 |
| Literature Review | group | `verification` | 1000 | 151.906 | 157.942 | 152.872 | 2.788 | 148.940 | 178.007 | 162.395 |
| Literature Review | group | `authorization_and_binding` | 1000 | 1.907 | 1.994 | 1.921 | 0.076 | 1.844 | 3.606 | 2.186 |
| Literature Review | group | `run_plan` | 1000 | 3.114 | 3.224 | 3.130 | 0.086 | 3.003 | 4.028 | 3.551 |
| Literature Review | group | `revalidation` | 1000 | 287.074 | 295.035 | 288.485 | 5.019 | 283.204 | 367.138 | 304.998 |
| Literature Review | total | `total_pre_execution` | 1000 | 445.576 | 455.481 | 446.408 | 6.364 | 438.311 | 524.608 | 469.690 |
| Literature Review | secondary | `local_file_read` | 1000 | 0.143 | 0.184 | 0.150 | 0.044 | 0.108 | 1.008 | 0.246 |

## Stability

Batch medians of the total, per package (ms):

| Package | batch 0 | batch 1 | batch 2 | batch 3 | batch 4 | spread (% of median) |
|---|---:|---:|---:|---:|---:|---:|
| Literature Review | 446.342 | 445.238 | 444.363 | 446.266 | 445.042 | 0.4 |
| Meeting Agenda | 57.273 | 57.015 | 57.079 | 57.158 | 57.036 | 0.5 |

Largest batch-median spread among single operations: `host_revalidation_lease` for Meeting Agenda, 1.4% of its median.

Order position (0 = ran first within its iteration) and tail of the total:

| Package | median at position 0 | median at position 1 | p99 / median | max / median | > 2x median | > 5x median |
|---|---:|---:|---:|---:|---:|---:|
| Meeting Agenda | 57.095 | 57.103 | 1.10 | 1.90 | 0 | 0 |
| Literature Review | 445.572 | 445.580 | 1.05 | 1.18 | 0 | 0 |

Negative values: 0. Exact zeros: 0.

## Component decomposition (diagnostic, separate from the totals)

The production functions inside package open, each called on its own with its own timer on the same in-memory bytes (milliseconds). The open stage runs all five once; the runner re-runs the first three; the interpreter re-runs the first two (integrity statement and payload validation). These calls are not part of the pipeline observations above and do not add up to them exactly.

| Package | Component | Production function | n | median | p95 | mean | std |
|---|---|---|---:|---:|---:|---:|---:|
| Meeting Agenda | container_integrity | `agentpkg.package.read_archive_bytes` | 500 | 2.937 | 3.051 | 2.950 | 0.097 |
| Meeting Agenda | schema_validation | `agentpkg.validation.validate_payload` | 500 | 14.544 | 14.835 | 14.587 | 0.325 |
| Meeting Agenda | signature | `agentpkg.browser.evaluation.signature_report` | 500 | 0.250 | 0.265 | 0.253 | 0.008 |
| Meeting Agenda | publisher_trust | `agentpkg.browser.trust.TrustStore.evaluate` | 500 | 0.156 | 0.176 | 0.157 | 0.034 |
| Meeting Agenda | inspection_summary | `agentpkg.browser.summary.build_summary` | 500 | 0.208 | 0.222 | 0.210 | 0.007 |
| Literature Review | container_integrity | `agentpkg.package.read_archive_bytes` | 500 | 23.729 | 24.220 | 23.772 | 0.243 |
| Literature Review | schema_validation | `agentpkg.validation.validate_payload` | 500 | 124.418 | 130.081 | 125.208 | 2.220 |
| Literature Review | signature | `agentpkg.browser.evaluation.signature_report` | 500 | 0.366 | 0.406 | 0.371 | 0.018 |
| Literature Review | publisher_trust | `agentpkg.browser.trust.TrustStore.evaluate` | 500 | 0.185 | 0.253 | 0.201 | 0.132 |
| Literature Review | inspection_summary | `agentpkg.browser.summary.build_summary` | 500 | 0.835 | 0.898 | 0.845 | 0.038 |

## Audit-event microbenchmark (separate from the totals)

`Runtime.record` replaying each recorded run's audit stream event by event into a fresh production `Runtime` per batch (microseconds per event). `no_observer` is the bookkeeping alone: build the event, hash it over RFC 8785 canonical JSON, link it to the previous hash, append. `progress_observer` adds the runner's live-progress observer.

| Variant | Stream | n | median | p95 | mean | std | min | max | events/s at median |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|
| no_observer | literature-review | 10100 | 5.75 | 8.50 | 6.22 | 2.35 | 4.38 | 100.62 | 173,913 |
| no_observer | meeting-agenda | 2300 | 5.50 | 6.75 | 5.72 | 2.91 | 4.50 | 113.58 | 181,818 |
| progress_observer | literature-review | 10100 | 11.75 | 15.54 | 12.58 | 2.42 | 9.38 | 99.08 | 85,106 |
| progress_observer | meeting-agenda | 2300 | 12.27 | 16.63 | 13.55 | 33.79 | 9.92 | 1,627.88 | 81,496 |

Streams: meeting-agenda: `examples/meeting-agenda-022-qwen/audit.json` (92 events); literature-review: `examples/literature-review-live/audit.json` (404 events)

## Optional context (not a paper claim)

Recorded live runs of the same Meeting Agenda version, read from run records in this repository at analysis time. They were recorded on a host session, not in this benchmark, and are shown only to place the measured magnitude next to a workflow duration. Literature Review 0.2.5 has no recorded live run in the repository, so no ratio is computed for it.

| Run record | Run id | Model | Workflow duration | Median contract total | Ratio |
|---|---|---|---:|---:|---:|
| `examples/meeting-agenda-022-qwen/run.json` | `run_76c1e18ab3c64a1b9470c656a9178d4b` | ollama/qwen3:30b | 133.2 s | 57.10 ms | 0.043% |
| `examples/meeting-agenda-022-luna/run.json` | `run_119d25dc76af40148a44b1c45c719281` | openai/gpt-5.6-luna | 32.4 s | 57.10 ms | 0.176% |

## Environment

- Darwin 15.7.4 (arm64), CPU Apple M3 Max, 14 logical CPUs (10 performance + 4 efficiency), 36 GiB memory.
- Python 3.13.5 (CPython); timer `mach_absolute_time()`, resolution 4.166666666666666e-08 s.
- agentpkg 0.2.2 (source in repository: True); dependencies jsonschema 4.26.0, referencing 0.37.0, cryptography 46.0.7, rfc8785 0.1.4.
- Agent Browser plugin 0.1.0; OpenClaw 2026.9.5 named by the fixtures; Node v26.9.0 (fixture generation only). Neither Node nor OpenClaw runs in the measured process.
- System load average (1/5/15 min) at start [2.7, 3.24, 3.23], at end [2.49, 2.55, 2.78].
- Offline guard violations: 0.

## Exclusions and limitations

- Excluded by construction: package download, human decision time, model inference, tool calls, network access, the Agent Browser plugin's loopback HTTP calls to the control plane (JSON serialization, `node:http`), the plugin-side field comparisons in `preflight.ts`, spawning the runner process, and the bridge framing of the inbound `execution.begin` request.
- The runner's plan projection (`preflight.ts`) is mirrored in Python; a test checks it equals the real TypeScript output.
- The stop at the first wave replaces `Workflow._gather` in the benchmark process only; everything before it is unmodified production code.
- One machine, one Python process, two packages. Absolute values depend on the machine and on the trust store contents (two pinned keys here); they are not a scaling law.

## Files

`metadata.json`, `samples.csv` (every measured observation, ns), `timestamps.csv` (t0..t7 offsets per observation), `warmup_samples.csv`, `summary.csv`, `summary.json`, `batch_summary.csv`, `audit_samples.csv`, `component_samples.csv`, `report.md`, `paper_table.tex`, `paper_table_detailed.tex`, `command.txt`.
