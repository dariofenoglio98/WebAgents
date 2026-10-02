# Contract overhead: results

Run started 2026-10-02T12:53:19.954072+00:00 (UTC), benchmark contract_overhead 1.0.0, git `23eac90c1f6f` (working tree has changes, none in production paths).

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
- Wall time of the measurement: 619.8 s.

## Main result (paper groups)

All values in milliseconds.

| Operation | Meeting Agenda median | p95 | Literature Review median | p95 |
|---|---:|---:|---:|---:|
| Package verification | 19.01 | 19.65 | 149.61 | 155.88 |
| Authorization and binding | 0.89 | 0.95 | 1.87 | 1.94 |
| Run Plan preparation | 1.28 | 1.34 | 3.06 | 3.13 |
| Pre-execution revalidation | 35.14 | 36.49 | 282.38 | 289.18 |
| **Total** | 56.36 | 58.22 | 438.57 | 446.60 |

## Per-operation breakdown

| Operation | Meeting Agenda median | p95 | Literature Review median | p95 |
|---|---:|---:|---:|---:|
| Package open and verification | 19.01 | 19.65 | 149.61 | 155.88 |
| Authorization receipt | 0.27 | 0.29 | 0.39 | 0.41 |
| Model and tool compatibility | 0.62 | 0.67 | 1.48 | 1.53 |
| Run Plan preparation | 1.28 | 1.34 | 3.06 | 3.13 |
| Host revalidation and lease | 1.76 | 1.92 | 6.29 | 6.63 |
| Runner re-verification | 18.23 | 18.98 | 149.15 | 155.22 |
| Workflow instantiation and start checks | 15.18 | 15.92 | 126.09 | 131.72 |
| **Total** | 56.36 | 58.22 | 438.57 | 446.60 |
| Local file read (secondary, not in total) | 0.10 | 0.13 | 0.13 | 0.16 |

Medians of the stages do not add up to the median total; each row is summarized on its own.

## Paper-ready interpretation

For Meeting Agenda 0.2.2, the automated contract processing from in-memory package bytes to the first workflow-node dispatch required a median of 56.36 ms (p95 58.22 ms; n = 1000). For Literature Review 0.2.5, the automated contract processing from in-memory package bytes to the first workflow-node dispatch required a median of 438.57 ms (p95 446.60 ms; n = 1000).

- Meeting Agenda: the largest single operation by median was *Package open and verification* (19.01 ms, 34% of the median total), followed by *Runner re-verification* (18.23 ms). Of the four paper groups, *Pre-execution revalidation* had the largest median (35.14 ms).
- Literature Review: the largest single operation by median was *Package open and verification* (149.61 ms, 34% of the median total), followed by *Runner re-verification* (149.15 ms). Of the four paper groups, *Pre-execution revalidation* had the largest median (282.38 ms).
- The median total for Literature Review was 7.8x that of Meeting Agenda. The two artifacts differ in several respects at once (21,580 vs 224,302 archive bytes, 17 vs 66 payload files, 7 vs 25 graph nodes, 0 vs 3 declared tools), so two packages do not identify which property drives the difference and do not establish a scaling relation.
- Each measured observation re-verifies the package three times, as production does: when the control plane opens the snapshot, when the runner verifies the leased artifact, and when the interpreter re-checks integrity and re-validates the payload. No verification result is cached between them.
- Audit bookkeeping (reported separately, not part of the totals above): appending and hash-linking one recorded audit event through `Runtime.record`, without an observer, took Literature Review stream: median 5.4 us (p95 6.8 us, about 186,047 events/s at the median); Meeting Agenda stream: median 5.3 us (p95 6.5 us, about 187,512 events/s at the median).

Scope sentence: these figures measure only local automated contract processing in one Python process, and exclude package acquisition, human authorization time, model inference, external tool latency, loopback HTTP transport between plugin and control plane, and runner process start-up.

## Full statistics

Milliseconds; `std` is the sample standard deviation (n - 1); percentiles use linear interpolation (Hyndman–Fan type 7).

| Package | Kind | Stage | n | median | p95 | mean | std | min | max | p99 |
|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|
| Meeting Agenda | stage | `package_open_verify` | 1000 | 19.014 | 19.655 | 19.113 | 0.862 | 18.099 | 41.065 | 20.588 |
| Meeting Agenda | stage | `authorization_receipt` | 1000 | 0.267 | 0.291 | 0.270 | 0.024 | 0.225 | 0.664 | 0.332 |
| Meeting Agenda | stage | `compatibility_evaluation` | 1000 | 0.622 | 0.670 | 0.627 | 0.019 | 0.595 | 0.762 | 0.700 |
| Meeting Agenda | stage | `run_plan_preparation` | 1000 | 1.285 | 1.345 | 1.299 | 0.142 | 1.154 | 4.421 | 1.566 |
| Meeting Agenda | stage | `host_revalidation_lease` | 1000 | 1.760 | 1.916 | 1.746 | 0.517 | 1.218 | 17.108 | 2.210 |
| Meeting Agenda | stage | `runner_verification` | 1000 | 18.229 | 18.981 | 18.392 | 2.077 | 17.633 | 81.210 | 20.190 |
| Meeting Agenda | stage | `workflow_start` | 1000 | 15.175 | 15.918 | 15.289 | 0.498 | 14.763 | 23.767 | 16.839 |
| Meeting Agenda | group | `verification` | 1000 | 19.014 | 19.655 | 19.113 | 0.862 | 18.099 | 41.065 | 20.588 |
| Meeting Agenda | group | `authorization_and_binding` | 1000 | 0.891 | 0.949 | 0.897 | 0.032 | 0.843 | 1.280 | 1.005 |
| Meeting Agenda | group | `run_plan` | 1000 | 1.285 | 1.345 | 1.299 | 0.142 | 1.154 | 4.421 | 1.566 |
| Meeting Agenda | group | `revalidation` | 1000 | 35.145 | 36.492 | 35.427 | 2.704 | 34.042 | 116.636 | 40.037 |
| Meeting Agenda | total | `total_pre_execution` | 1000 | 56.358 | 58.216 | 56.736 | 3.507 | 54.196 | 161.949 | 61.524 |
| Meeting Agenda | secondary | `local_file_read` | 1000 | 0.100 | 0.131 | 0.102 | 0.017 | 0.056 | 0.200 | 0.157 |
| Literature Review | stage | `package_open_verify` | 1000 | 149.606 | 155.877 | 150.595 | 2.737 | 147.157 | 178.468 | 158.650 |
| Literature Review | stage | `authorization_receipt` | 1000 | 0.389 | 0.414 | 0.394 | 0.085 | 0.338 | 2.682 | 0.446 |
| Literature Review | stage | `compatibility_evaluation` | 1000 | 1.484 | 1.531 | 1.489 | 0.027 | 1.418 | 1.892 | 1.584 |
| Literature Review | stage | `run_plan_preparation` | 1000 | 3.060 | 3.131 | 3.093 | 0.576 | 2.942 | 19.853 | 3.332 |
| Literature Review | stage | `host_revalidation_lease` | 1000 | 6.289 | 6.626 | 6.306 | 1.018 | 5.586 | 34.627 | 7.291 |
| Literature Review | stage | `runner_verification` | 1000 | 149.149 | 155.224 | 150.150 | 2.933 | 147.120 | 187.617 | 160.064 |
| Literature Review | stage | `workflow_start` | 1000 | 126.093 | 131.718 | 127.006 | 2.401 | 124.419 | 148.037 | 134.313 |
| Literature Review | group | `verification` | 1000 | 149.606 | 155.877 | 150.595 | 2.737 | 147.157 | 178.468 | 158.650 |
| Literature Review | group | `authorization_and_binding` | 1000 | 1.873 | 1.938 | 1.882 | 0.088 | 1.812 | 4.106 | 2.031 |
| Literature Review | group | `run_plan` | 1000 | 3.060 | 3.131 | 3.093 | 0.576 | 2.942 | 19.853 | 3.332 |
| Literature Review | group | `revalidation` | 1000 | 282.375 | 289.179 | 283.462 | 4.080 | 278.349 | 327.952 | 297.175 |
| Literature Review | total | `total_pre_execution` | 1000 | 438.569 | 446.596 | 439.032 | 5.499 | 430.990 | 498.032 | 456.513 |
| Literature Review | secondary | `local_file_read` | 1000 | 0.128 | 0.160 | 0.130 | 0.024 | 0.091 | 0.674 | 0.185 |

## Stability

Batch medians of the total, per package (ms):

| Package | batch 0 | batch 1 | batch 2 | batch 3 | batch 4 | spread (% of median) |
|---|---:|---:|---:|---:|---:|---:|
| Literature Review | 437.897 | 437.563 | 438.620 | 441.500 | 437.528 | 0.9 |
| Meeting Agenda | 56.212 | 56.191 | 56.307 | 57.221 | 56.305 | 1.8 |

Largest batch-median spread among single operations: `host_revalidation_lease` for Meeting Agenda, 11.0% of its median.

Order position (0 = ran first within its iteration) and tail of the total:

| Package | median at position 0 | median at position 1 | p99 / median | max / median | > 2x median | > 5x median |
|---|---:|---:|---:|---:|---:|---:|
| Meeting Agenda | 56.379 | 56.345 | 1.09 | 2.87 | 1 | 0 |
| Literature Review | 438.570 | 438.544 | 1.04 | 1.14 | 0 | 0 |

Negative values: 0. Exact zeros: 0.

## Component decomposition (diagnostic, separate from the totals)

The production functions inside package open, each called on its own with its own timer on the same in-memory bytes (milliseconds). The open stage runs all five once; the runner re-runs the first three; the interpreter re-runs the first two (integrity statement and payload validation). These calls are not part of the pipeline observations above and do not add up to them exactly.

| Package | Component | Production function | n | median | p95 | mean | std |
|---|---|---|---:|---:|---:|---:|---:|
| Meeting Agenda | container_integrity | `agentpkg.package.read_archive_bytes` | 500 | 2.890 | 3.012 | 2.920 | 0.478 |
| Meeting Agenda | schema_validation | `agentpkg.validation.validate_payload` | 500 | 14.355 | 14.658 | 14.410 | 0.429 |
| Meeting Agenda | signature | `agentpkg.browser.evaluation.signature_report` | 500 | 0.245 | 0.256 | 0.247 | 0.007 |
| Meeting Agenda | publisher_trust | `agentpkg.browser.trust.TrustStore.evaluate` | 500 | 0.151 | 0.169 | 0.152 | 0.027 |
| Meeting Agenda | inspection_summary | `agentpkg.browser.summary.build_summary` | 500 | 0.205 | 0.213 | 0.206 | 0.009 |
| Literature Review | container_integrity | `agentpkg.package.read_archive_bytes` | 500 | 23.461 | 23.839 | 23.492 | 0.216 |
| Literature Review | schema_validation | `agentpkg.validation.validate_payload` | 500 | 122.287 | 127.736 | 123.231 | 3.035 |
| Literature Review | signature | `agentpkg.browser.evaluation.signature_report` | 500 | 0.350 | 0.393 | 0.357 | 0.017 |
| Literature Review | publisher_trust | `agentpkg.browser.trust.TrustStore.evaluate` | 500 | 0.171 | 0.229 | 0.182 | 0.068 |
| Literature Review | inspection_summary | `agentpkg.browser.summary.build_summary` | 500 | 0.812 | 0.871 | 0.823 | 0.046 |

## Audit-event microbenchmark (separate from the totals)

`Runtime.record` replaying each recorded run's audit stream event by event into a fresh production `Runtime` per batch (microseconds per event). `no_observer` is the bookkeeping alone: build the event, hash it over RFC 8785 canonical JSON, link it to the previous hash, append. `progress_observer` adds the runner's live-progress observer.

| Variant | Stream | n | median | p95 | mean | std | min | max | events/s at median |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|
| no_observer | literature-review | 10100 | 5.38 | 6.79 | 5.65 | 1.13 | 4.42 | 39.92 | 186,047 |
| no_observer | meeting-agenda | 2300 | 5.33 | 6.54 | 5.56 | 2.70 | 4.42 | 104.54 | 187,512 |
| progress_observer | literature-review | 10100 | 11.50 | 15.04 | 12.24 | 1.93 | 9.92 | 99.42 | 86,957 |
| progress_observer | meeting-agenda | 2300 | 11.50 | 14.79 | 12.63 | 21.39 | 9.88 | 1,032.33 | 86,957 |

Streams: meeting-agenda: `examples/meeting-agenda-022-qwen/audit.json` (92 events); literature-review: `examples/literature-review-live/audit.json` (404 events)

## Optional context (not a paper claim)

Recorded live runs of the same Meeting Agenda version, read from run records in this repository at analysis time. They were recorded on a host session, not in this benchmark, and are shown only to place the measured magnitude next to a workflow duration. Literature Review 0.2.5 has no recorded live run in the repository, so no ratio is computed for it.

| Run record | Run id | Model | Workflow duration | Median contract total | Ratio |
|---|---|---|---:|---:|---:|
| `examples/meeting-agenda-022-qwen/run.json` | `run_76c1e18ab3c64a1b9470c656a9178d4b` | ollama/qwen3:30b | 133.2 s | 56.36 ms | 0.042% |
| `examples/meeting-agenda-022-luna/run.json` | `run_119d25dc76af40148a44b1c45c719281` | openai/gpt-5.6-luna | 32.4 s | 56.36 ms | 0.174% |

## Environment

- Darwin 15.7.4 (arm64), CPU Apple M3 Max, 14 logical CPUs (10 performance + 4 efficiency), 36 GiB memory.
- Python 3.13.5 (CPython); timer `mach_absolute_time()`, resolution 4.166666666666666e-08 s.
- agentpkg 0.2.2 (source in repository: True); dependencies jsonschema 4.26.0, referencing 0.37.0, cryptography 46.0.7, rfc8785 0.1.4.
- Agent Browser plugin 0.1.0; OpenClaw 2026.9.5 named by the fixtures; Node v26.9.0 (fixture generation only). Neither Node nor OpenClaw runs in the measured process.
- System load average (1/5/15 min) at start [3.31, 5.61, 5.65], at end [1.84, 2.38, 3.7].
- Offline guard violations: 0.

## Exclusions and limitations

- Excluded by construction: package download, human decision time, model inference, tool calls, network access, the Agent Browser plugin's loopback HTTP calls to the control plane (JSON serialization, `node:http`), the plugin-side field comparisons in `preflight.ts`, spawning the runner process, and the bridge framing of the inbound `execution.begin` request.
- The runner's plan projection (`preflight.ts`) is mirrored in Python; a test checks it equals the real TypeScript output.
- The stop at the first wave replaces `Workflow._gather` in the benchmark process only; everything before it is unmodified production code.
- One machine, one Python process, two packages. Absolute values depend on the machine and on the trust store contents (two pinned keys here); they are not a scaling law.

## Files

`metadata.json`, `samples.csv` (every measured observation, ns), `timestamps.csv` (t0..t7 offsets per observation), `warmup_samples.csv`, `summary.csv`, `summary.json`, `batch_summary.csv`, `audit_samples.csv`, `component_samples.csv`, `report.md`, `paper_table.tex`, `paper_table_detailed.tex`, `command.txt`.
