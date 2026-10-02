# Contract overhead: results

Run started 2026-10-02T13:03:41.763840+00:00 (UTC), benchmark contract_overhead 1.0.0, git `23eac90c1f6f` (working tree has changes, none in production paths).

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
- Wall time of the measurement: 617.3 s.

## Main result (paper groups)

All values in milliseconds.

| Operation | Meeting Agenda median | p95 | Literature Review median | p95 |
|---|---:|---:|---:|---:|
| Package verification | 18.88 | 19.33 | 148.77 | 154.52 |
| Authorization and binding | 0.88 | 0.93 | 1.87 | 1.93 |
| Run Plan preparation | 1.28 | 1.32 | 3.05 | 3.11 |
| Pre-execution revalidation | 34.94 | 35.82 | 280.91 | 287.28 |
| **Total** | 56.01 | 57.15 | 436.18 | 442.70 |

## Per-operation breakdown

| Operation | Meeting Agenda median | p95 | Literature Review median | p95 |
|---|---:|---:|---:|---:|
| Package open and verification | 18.88 | 19.33 | 148.77 | 154.52 |
| Authorization receipt | 0.27 | 0.29 | 0.39 | 0.41 |
| Model and tool compatibility | 0.62 | 0.66 | 1.48 | 1.52 |
| Run Plan preparation | 1.28 | 1.32 | 3.05 | 3.11 |
| Host revalidation and lease | 1.77 | 1.92 | 6.26 | 6.55 |
| Runner re-verification | 18.12 | 18.57 | 148.41 | 153.91 |
| Workflow instantiation and start checks | 15.06 | 15.50 | 125.59 | 131.12 |
| **Total** | 56.01 | 57.15 | 436.18 | 442.70 |
| Local file read (secondary, not in total) | 0.10 | 0.13 | 0.13 | 0.16 |

Medians of the stages do not add up to the median total; each row is summarized on its own.

## Paper-ready interpretation

For Meeting Agenda 0.2.2, the automated contract processing from in-memory package bytes to the first workflow-node dispatch required a median of 56.01 ms (p95 57.15 ms; n = 1000). For Literature Review 0.2.5, the automated contract processing from in-memory package bytes to the first workflow-node dispatch required a median of 436.18 ms (p95 442.70 ms; n = 1000).

- Meeting Agenda: the largest single operation by median was *Package open and verification* (18.88 ms, 34% of the median total), followed by *Runner re-verification* (18.12 ms). Of the four paper groups, *Pre-execution revalidation* had the largest median (34.94 ms).
- Literature Review: the largest single operation by median was *Package open and verification* (148.77 ms, 34% of the median total), followed by *Runner re-verification* (148.41 ms). Of the four paper groups, *Pre-execution revalidation* had the largest median (280.91 ms).
- The median total for Literature Review was 7.8x that of Meeting Agenda. The two artifacts differ in several respects at once (21,580 vs 224,302 archive bytes, 17 vs 66 payload files, 7 vs 25 graph nodes, 0 vs 3 declared tools), so two packages do not identify which property drives the difference and do not establish a scaling relation.
- Each measured observation re-verifies the package three times, as production does: when the control plane opens the snapshot, when the runner verifies the leased artifact, and when the interpreter re-checks integrity and re-validates the payload. No verification result is cached between them.
- Audit bookkeeping (reported separately, not part of the totals above): appending and hash-linking one recorded audit event through `Runtime.record`, without an observer, took Literature Review stream: median 5.5 us (p95 6.9 us, about 183,217 events/s at the median); Meeting Agenda stream: median 5.4 us (p95 6.7 us, about 184,638 events/s at the median).

Scope sentence: these figures measure only local automated contract processing in one Python process, and exclude package acquisition, human authorization time, model inference, external tool latency, loopback HTTP transport between plugin and control plane, and runner process start-up.

## Full statistics

Milliseconds; `std` is the sample standard deviation (n - 1); percentiles use linear interpolation (Hyndman–Fan type 7).

| Package | Kind | Stage | n | median | p95 | mean | std | min | max | p99 |
|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|
| Meeting Agenda | stage | `package_open_verify` | 1000 | 18.881 | 19.327 | 18.946 | 0.562 | 17.974 | 27.009 | 20.422 |
| Meeting Agenda | stage | `authorization_receipt` | 1000 | 0.265 | 0.286 | 0.268 | 0.032 | 0.220 | 1.034 | 0.337 |
| Meeting Agenda | stage | `compatibility_evaluation` | 1000 | 0.617 | 0.655 | 0.621 | 0.016 | 0.576 | 0.799 | 0.684 |
| Meeting Agenda | stage | `run_plan_preparation` | 1000 | 1.276 | 1.322 | 1.279 | 0.040 | 1.186 | 1.925 | 1.404 |
| Meeting Agenda | stage | `host_revalidation_lease` | 1000 | 1.769 | 1.923 | 1.763 | 0.156 | 1.288 | 3.558 | 2.119 |
| Meeting Agenda | stage | `runner_verification` | 1000 | 18.119 | 18.566 | 18.141 | 0.477 | 17.574 | 24.087 | 19.197 |
| Meeting Agenda | stage | `workflow_start` | 1000 | 15.061 | 15.501 | 15.122 | 0.313 | 14.785 | 20.276 | 16.030 |
| Meeting Agenda | group | `verification` | 1000 | 18.881 | 19.327 | 18.946 | 0.562 | 17.974 | 27.009 | 20.422 |
| Meeting Agenda | group | `authorization_and_binding` | 1000 | 0.885 | 0.934 | 0.890 | 0.037 | 0.831 | 1.655 | 0.999 |
| Meeting Agenda | group | `run_plan` | 1000 | 1.276 | 1.322 | 1.279 | 0.040 | 1.186 | 1.925 | 1.404 |
| Meeting Agenda | group | `revalidation` | 1000 | 34.936 | 35.823 | 35.026 | 0.615 | 33.994 | 41.039 | 36.799 |
| Meeting Agenda | total | `total_pre_execution` | 1000 | 56.010 | 57.153 | 56.142 | 0.896 | 54.114 | 64.433 | 61.422 |
| Meeting Agenda | secondary | `local_file_read` | 1000 | 0.101 | 0.130 | 0.104 | 0.035 | 0.064 | 0.853 | 0.147 |
| Literature Review | stage | `package_open_verify` | 1000 | 148.766 | 154.523 | 149.667 | 2.489 | 146.492 | 174.749 | 158.209 |
| Literature Review | stage | `authorization_receipt` | 1000 | 0.389 | 0.411 | 0.409 | 0.434 | 0.344 | 10.152 | 0.451 |
| Literature Review | stage | `compatibility_evaluation` | 1000 | 1.477 | 1.523 | 1.483 | 0.029 | 1.379 | 1.972 | 1.575 |
| Literature Review | stage | `run_plan_preparation` | 1000 | 3.048 | 3.106 | 3.061 | 0.157 | 2.942 | 6.804 | 3.264 |
| Literature Review | stage | `host_revalidation_lease` | 1000 | 6.261 | 6.555 | 6.320 | 0.779 | 5.623 | 26.807 | 7.288 |
| Literature Review | stage | `runner_verification` | 1000 | 148.409 | 153.910 | 149.333 | 2.308 | 146.674 | 173.818 | 156.259 |
| Literature Review | stage | `workflow_start` | 1000 | 125.589 | 131.119 | 126.492 | 2.126 | 124.118 | 139.563 | 132.640 |
| Literature Review | group | `verification` | 1000 | 148.766 | 154.523 | 149.667 | 2.489 | 146.492 | 174.749 | 158.209 |
| Literature Review | group | `authorization_and_binding` | 1000 | 1.866 | 1.927 | 1.892 | 0.435 | 1.751 | 11.648 | 2.030 |
| Literature Review | group | `run_plan` | 1000 | 3.048 | 3.106 | 3.061 | 0.157 | 2.942 | 6.804 | 3.264 |
| Literature Review | group | `revalidation` | 1000 | 280.905 | 287.278 | 282.145 | 3.118 | 277.315 | 305.438 | 290.211 |
| Literature Review | total | `total_pre_execution` | 1000 | 436.177 | 442.703 | 436.764 | 4.275 | 429.887 | 480.733 | 451.009 |
| Literature Review | secondary | `local_file_read` | 1000 | 0.127 | 0.157 | 0.129 | 0.017 | 0.090 | 0.382 | 0.178 |

## Stability

Batch medians of the total, per package (ms):

| Package | batch 0 | batch 1 | batch 2 | batch 3 | batch 4 | spread (% of median) |
|---|---:|---:|---:|---:|---:|---:|
| Literature Review | 436.001 | 435.318 | 435.403 | 436.558 | 437.869 | 0.6 |
| Meeting Agenda | 55.906 | 56.025 | 56.009 | 56.016 | 56.132 | 0.4 |

Largest batch-median spread among single operations: `authorization_receipt` for Meeting Agenda, 1.7% of its median.

Order position (0 = ran first within its iteration) and tail of the total:

| Package | median at position 0 | median at position 1 | p99 / median | max / median | > 2x median | > 5x median |
|---|---:|---:|---:|---:|---:|---:|
| Meeting Agenda | 56.025 | 56.000 | 1.10 | 1.15 | 0 | 0 |
| Literature Review | 436.447 | 435.981 | 1.03 | 1.10 | 0 | 0 |

Negative values: 0. Exact zeros: 0.

## Component decomposition (diagnostic, separate from the totals)

The production functions inside package open, each called on its own with its own timer on the same in-memory bytes (milliseconds). The open stage runs all five once; the runner re-runs the first three; the interpreter re-runs the first two (integrity statement and payload validation). These calls are not part of the pipeline observations above and do not add up to them exactly.

| Package | Component | Production function | n | median | p95 | mean | std |
|---|---|---|---:|---:|---:|---:|---:|
| Meeting Agenda | container_integrity | `agentpkg.package.read_archive_bytes` | 500 | 2.880 | 2.959 | 2.884 | 0.056 |
| Meeting Agenda | schema_validation | `agentpkg.validation.validate_payload` | 500 | 14.340 | 14.609 | 14.384 | 0.322 |
| Meeting Agenda | signature | `agentpkg.browser.evaluation.signature_report` | 500 | 0.245 | 0.255 | 0.247 | 0.007 |
| Meeting Agenda | publisher_trust | `agentpkg.browser.trust.TrustStore.evaluate` | 500 | 0.150 | 0.165 | 0.152 | 0.042 |
| Meeting Agenda | inspection_summary | `agentpkg.browser.summary.build_summary` | 500 | 0.203 | 0.214 | 0.205 | 0.006 |
| Literature Review | container_integrity | `agentpkg.package.read_archive_bytes` | 500 | 23.435 | 23.720 | 23.461 | 0.218 |
| Literature Review | schema_validation | `agentpkg.validation.validate_payload` | 500 | 122.581 | 128.342 | 123.412 | 2.075 |
| Literature Review | signature | `agentpkg.browser.evaluation.signature_report` | 500 | 0.350 | 0.386 | 0.356 | 0.014 |
| Literature Review | publisher_trust | `agentpkg.browser.trust.TrustStore.evaluate` | 500 | 0.172 | 0.234 | 0.179 | 0.028 |
| Literature Review | inspection_summary | `agentpkg.browser.summary.build_summary` | 500 | 0.808 | 0.845 | 0.814 | 0.028 |

## Audit-event microbenchmark (separate from the totals)

`Runtime.record` replaying each recorded run's audit stream event by event into a fresh production `Runtime` per batch (microseconds per event). `no_observer` is the bookkeeping alone: build the event, hash it over RFC 8785 canonical JSON, link it to the previous hash, append. `progress_observer` adds the runner's live-progress observer.

| Variant | Stream | n | median | p95 | mean | std | min | max | events/s at median |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|
| no_observer | literature-review | 10100 | 5.46 | 6.92 | 5.74 | 1.39 | 4.46 | 76.25 | 183,217 |
| no_observer | meeting-agenda | 2300 | 5.42 | 6.67 | 5.63 | 2.76 | 4.46 | 107.92 | 184,638 |
| progress_observer | literature-review | 10100 | 11.54 | 14.96 | 12.24 | 2.03 | 9.83 | 112.46 | 86,648 |
| progress_observer | meeting-agenda | 2300 | 11.54 | 14.71 | 12.62 | 22.36 | 9.83 | 1,079.21 | 86,648 |

Streams: meeting-agenda: `examples/meeting-agenda-022-qwen/audit.json` (92 events); literature-review: `examples/literature-review-live/audit.json` (404 events)

## Optional context (not a paper claim)

Recorded live runs of the same Meeting Agenda version, read from run records in this repository at analysis time. They were recorded on a host session, not in this benchmark, and are shown only to place the measured magnitude next to a workflow duration. Literature Review 0.2.5 has no recorded live run in the repository, so no ratio is computed for it.

| Run record | Run id | Model | Workflow duration | Median contract total | Ratio |
|---|---|---|---:|---:|---:|
| `examples/meeting-agenda-022-qwen/run.json` | `run_76c1e18ab3c64a1b9470c656a9178d4b` | ollama/qwen3:30b | 133.2 s | 56.01 ms | 0.042% |
| `examples/meeting-agenda-022-luna/run.json` | `run_119d25dc76af40148a44b1c45c719281` | openai/gpt-5.6-luna | 32.4 s | 56.01 ms | 0.173% |

## Environment

- Darwin 15.7.4 (arm64), CPU Apple M3 Max, 14 logical CPUs (10 performance + 4 efficiency), 36 GiB memory.
- Python 3.13.5 (CPython); timer `mach_absolute_time()`, resolution 4.166666666666666e-08 s.
- agentpkg 0.2.2 (source in repository: True); dependencies jsonschema 4.26.0, referencing 0.37.0, cryptography 46.0.7, rfc8785 0.1.4.
- Agent Browser plugin 0.1.0; OpenClaw 2026.9.5 named by the fixtures; Node v26.9.0 (fixture generation only). Neither Node nor OpenClaw runs in the measured process.
- System load average (1/5/15 min) at start [1.84, 2.38, 3.7], at end [2.02, 2.0, 2.75].
- Offline guard violations: 0.

## Exclusions and limitations

- Excluded by construction: package download, human decision time, model inference, tool calls, network access, the Agent Browser plugin's loopback HTTP calls to the control plane (JSON serialization, `node:http`), the plugin-side field comparisons in `preflight.ts`, spawning the runner process, and the bridge framing of the inbound `execution.begin` request.
- The runner's plan projection (`preflight.ts`) is mirrored in Python; a test checks it equals the real TypeScript output.
- The stop at the first wave replaces `Workflow._gather` in the benchmark process only; everything before it is unmodified production code.
- One machine, one Python process, two packages. Absolute values depend on the machine and on the trust store contents (two pinned keys here); they are not a scaling law.

## Files

`metadata.json`, `samples.csv` (every measured observation, ns), `timestamps.csv` (t0..t7 offsets per observation), `warmup_samples.csv`, `summary.csv`, `summary.json`, `batch_summary.csv`, `audit_samples.csv`, `component_samples.csv`, `report.md`, `paper_table.tex`, `paper_table_detailed.tex`, `command.txt`.
