# Contract overhead: results

Run started 2026-10-03T15:30:34.607739+00:00 (UTC), benchmark contract_overhead 1.1.0, git `9d78ca5a4be1` (working tree has changes, none in production paths).

## Question and metric

What local latency does the package-to-execution contract add before workflow execution? The metric is the wall-clock time (`time.perf_counter_ns`) from the moment the signed package bytes are in memory to the moment the workflow interpreter hands its first ready wave of nodes to its scheduler, through the production operations below, in one Python process. No node runs; no model, tool or network is reached.

## Packages

| | Meeting Agenda | Literature Review | WebAir |
|---|---|---|---|
| Package id | `org.webagents.meeting-agenda` | `org.webagents.literature-review` | `org.webagents.webair` |
| Version | 0.2.2 | 0.2.5 | 0.3.0 |
| Archive | `dist/meeting-agenda.agent.pkg` | `dist/literature-review.agent.pkg` | `dist/webair-0.3.0.agent.pkg` |
| Archive SHA-256 | `7b148e845c0f9e38d752a51a8d0b60a314842a3de3a2723b3bdf1a0c041921e1` | `1669f83fafac3434748fc19d38a8d3d2c3352da83cf1cbb84796ce313bd4f571` | `b537cf5cba06bce8137533eb75b491486f57caf3098af30f657343b741492887` |
| Package digest | `dbd2eb816bb8687d4a5b3448f5b82bc0716c3884f9fee8a2c578af0c5e894679` | `cef9ebd68df9db3b36c1ffeac9069d734b0e41a40d58445aaba1a60eaac155b5` | `ffe8f5b344f97c631498bb6da3e17217ae7e5730721935b0e66c5d595b335e94` |
| Signer fingerprint | `sha256:2bcc374a7fe18e50622042b7d0375fcb24eb3607879a236f9f3c3ede1922c5c4` | `sha256:c5ca9763f9fc71253298ca381ec14c4d7432009c74dacc69df6344b71de05232` | `sha256:2e53accec575b37bf16c189e03cd3a6b2f2cfae2339ff05361bf585dc3d4a20b` |
| Archive bytes | 21,580 | 224,302 | 167,193 |
| Archive entries | 19 | 68 | 60 |
| Payload files | 17 | 66 | 58 |
| Graph nodes | 7 | 25 | 34 |
| Node types | join, llm, map, output, validate | join, llm, map, output, validate | join, llm, map, output, tool, validate |
| Worker roles | 4 | 9 | 7 |
| First-wave (root) nodes | plan | planning | interpret |
| Declared tools | none | citation-resolver, paper-reader, scholarly-search | get-fare-rules, personal.passenger_identity, personal.travel_profile, prepare-booking, search-flights, simulate-purchase, wallet.payment_method |
| Model tasks | 3 | 8 | 3 |
| Required model capabilities | reasoning, structured_output | reasoning, structured_output | reasoning, structured_output |
| Required context window | 16,000 | 16,000 | 16,000 |
| Declared permissions | model.reasoning (model, required), memory.session (memory, required) | network.scholarly (network, required), network.citations (network, required), files.pdfs (files.read), model.reasoning (model), memory.session (memory, required) | network.webair (network, required), profile.travel (personal.read), identity.passenger (personal.read), wallet.payment (personal.read), booking.simulate_purchase (payment), model.reasoning (model, required), memory.session (memory, required) |
| Remote / local tools | 0 / 0 | 2 / 1 | 4 / 3 |
| Host-resource permissions | none | none | profile.travel (personal.travel_profile), identity.passenger (personal.passenger_identity), wallet.payment (wallet.payment_method) |

## Stages (production operations)

| Stage | Production operation | Interval |
|---|---|---|
| Package open and verification (`package_open_verify`) | `ControlPlane._open_bytes` | t0–t1 |
| Authorization receipt (`authorization_receipt`) | `ControlPlane.authorize (with the host resource registry and selections)` | t1–t2 |
| Model and tool compatibility (`compatibility_evaluation`) | `ControlPlane.evaluate_models + ControlPlane.evaluate_tools` | t2–t3 |
| Run Plan preparation (`run_plan_preparation`) | `ControlPlane.prepare_run_plan (with the host resource registry)` | t3–t4 |
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
- Wall time of the measurement: 1247.8 s.

## Main result (paper groups)

All values in milliseconds.

| Operation | Meeting Agenda median | p95 | Literature Review median | p95 | WebAir median | p95 |
|---|---:|---:|---:|---:|---:|---:|
| Package verification | 19.33 | 20.30 | 153.22 | 160.22 | 162.34 | 169.21 |
| Authorization and binding | 1.72 | 1.82 | 2.73 | 2.90 | 3.99 | 4.17 |
| Run Plan preparation | 2.12 | 2.27 | 3.93 | 4.21 | 6.53 | 6.88 |
| Pre-execution revalidation | 35.83 | 38.03 | 290.08 | 301.31 | 317.57 | 329.10 |
| **Total** | 59.03 | 62.24 | 451.26 | 465.20 | 490.75 | 505.98 |

## Per-operation breakdown

| Operation | Meeting Agenda median | p95 | Literature Review median | p95 | WebAir median | p95 |
|---|---:|---:|---:|---:|---:|---:|
| Package open and verification | 19.33 | 20.30 | 153.22 | 160.22 | 162.34 | 169.21 |
| Authorization receipt | 0.49 | 0.53 | 0.62 | 0.69 | 0.63 | 0.69 |
| Model and tool compatibility | 1.22 | 1.30 | 2.10 | 2.21 | 3.36 | 3.50 |
| Run Plan preparation | 2.12 | 2.27 | 3.93 | 4.21 | 6.53 | 6.88 |
| Host revalidation and lease | 1.85 | 2.15 | 7.19 | 7.94 | 10.77 | 11.58 |
| Runner re-verification | 18.59 | 19.79 | 152.60 | 160.25 | 163.13 | 169.71 |
| Workflow instantiation and start checks | 15.35 | 16.23 | 129.37 | 137.16 | 143.29 | 150.52 |
| **Total** | 59.03 | 62.24 | 451.26 | 465.20 | 490.75 | 505.98 |
| Local file read (secondary, not in total) | 0.13 | 0.17 | 0.15 | 0.21 | 0.14 | 0.18 |

Medians of the stages do not add up to the median total; each row is summarized on its own.

## Paper-ready interpretation

For Meeting Agenda 0.2.2, the automated contract processing from in-memory package bytes to the first workflow-node dispatch required a median of 59.03 ms (p95 62.24 ms; n = 1000). For Literature Review 0.2.5, the automated contract processing from in-memory package bytes to the first workflow-node dispatch required a median of 451.26 ms (p95 465.20 ms; n = 1000). For WebAir 0.3.0, the automated contract processing from in-memory package bytes to the first workflow-node dispatch required a median of 490.75 ms (p95 505.98 ms; n = 1000).

- Meeting Agenda: the largest single operation by median was *Package open and verification* (19.33 ms, 33% of the median total), followed by *Runner re-verification* (18.59 ms). Of the four paper groups, *Pre-execution revalidation* had the largest median (35.83 ms).
- Literature Review: the largest single operation by median was *Package open and verification* (153.22 ms, 34% of the median total), followed by *Runner re-verification* (152.60 ms). Of the four paper groups, *Pre-execution revalidation* had the largest median (290.08 ms).
- WebAir: the largest single operation by median was *Runner re-verification* (163.13 ms, 33% of the median total), followed by *Package open and verification* (162.34 ms). Of the four paper groups, *Pre-execution revalidation* had the largest median (317.57 ms).
- Relative to Meeting Agenda, the median totals were: Literature Review 7.6x, WebAir 8.3x. The artifacts differ in several respects at once (Meeting Agenda / Literature Review / WebAir: 21,580 / 224,302 / 167,193 archive bytes, 17 / 66 / 58 payload files, 7 / 25 / 34 graph nodes, 0 / 3 / 7 declared tools), so 3 packages do not identify which property drives the differences and do not establish a scaling relation.
- Each measured observation re-verifies the package three times, as production does: when the control plane opens the snapshot, when the runner verifies the leased artifact, and when the interpreter re-checks integrity and re-validates the payload. No verification result is cached between them.
- Audit bookkeeping (reported separately, not part of the totals above): appending and hash-linking one recorded audit event through `Runtime.record`, without an observer, took Literature Review stream: median 5.5 us (p95 7.0 us, about 183,217 events/s at the median); Meeting Agenda stream: median 5.4 us (p95 6.6 us, about 184,638 events/s at the median).

Scope sentence: these figures measure only local automated contract processing in one Python process, and exclude package acquisition, human authorization time, model inference, external tool latency, loopback HTTP transport between plugin and control plane, and runner process start-up.

## Full statistics

Milliseconds; `std` is the sample standard deviation (n - 1); percentiles use linear interpolation (Hyndman–Fan type 7).

| Package | Kind | Stage | n | median | p95 | mean | std | min | max | p99 |
|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|
| Meeting Agenda | stage | `package_open_verify` | 1000 | 19.334 | 20.300 | 19.470 | 0.603 | 18.380 | 27.556 | 21.578 |
| Meeting Agenda | stage | `authorization_receipt` | 1000 | 0.491 | 0.534 | 0.496 | 0.028 | 0.445 | 0.796 | 0.608 |
| Meeting Agenda | stage | `compatibility_evaluation` | 1000 | 1.224 | 1.299 | 1.232 | 0.037 | 1.136 | 1.750 | 1.390 |
| Meeting Agenda | stage | `run_plan_preparation` | 1000 | 2.116 | 2.268 | 2.139 | 0.095 | 2.015 | 3.143 | 2.554 |
| Meeting Agenda | stage | `host_revalidation_lease` | 1000 | 1.848 | 2.153 | 1.878 | 0.283 | 1.373 | 5.670 | 3.078 |
| Meeting Agenda | stage | `runner_verification` | 1000 | 18.587 | 19.789 | 18.745 | 0.630 | 17.853 | 25.433 | 20.957 |
| Meeting Agenda | stage | `workflow_start` | 1000 | 15.353 | 16.231 | 15.476 | 0.516 | 14.938 | 23.440 | 17.047 |
| Meeting Agenda | group | `verification` | 1000 | 19.334 | 20.300 | 19.470 | 0.603 | 18.380 | 27.556 | 21.578 |
| Meeting Agenda | group | `authorization_and_binding` | 1000 | 1.715 | 1.815 | 1.729 | 0.052 | 1.636 | 2.288 | 1.942 |
| Meeting Agenda | group | `run_plan` | 1000 | 2.116 | 2.268 | 2.139 | 0.095 | 2.015 | 3.143 | 2.554 |
| Meeting Agenda | group | `revalidation` | 1000 | 35.830 | 38.032 | 36.099 | 1.013 | 34.704 | 44.598 | 40.200 |
| Meeting Agenda | total | `total_pre_execution` | 1000 | 59.025 | 62.240 | 59.436 | 1.514 | 57.055 | 72.986 | 65.460 |
| Meeting Agenda | secondary | `local_file_read` | 1000 | 0.127 | 0.168 | 0.131 | 0.032 | 0.078 | 0.589 | 0.231 |
| Literature Review | stage | `package_open_verify` | 1000 | 153.215 | 160.217 | 154.180 | 3.140 | 150.187 | 174.697 | 164.102 |
| Literature Review | stage | `authorization_receipt` | 1000 | 0.622 | 0.686 | 0.635 | 0.110 | 0.570 | 3.354 | 0.794 |
| Literature Review | stage | `compatibility_evaluation` | 1000 | 2.104 | 2.214 | 2.117 | 0.055 | 2.002 | 2.735 | 2.344 |
| Literature Review | stage | `run_plan_preparation` | 1000 | 3.929 | 4.209 | 3.968 | 0.157 | 3.803 | 6.028 | 4.710 |
| Literature Review | stage | `host_revalidation_lease` | 1000 | 7.187 | 7.941 | 7.543 | 6.083 | 6.618 | 194.843 | 12.467 |
| Literature Review | stage | `runner_verification` | 1000 | 152.597 | 160.254 | 153.782 | 3.643 | 149.152 | 196.864 | 165.065 |
| Literature Review | stage | `workflow_start` | 1000 | 129.375 | 137.164 | 130.633 | 3.549 | 126.422 | 170.830 | 141.750 |
| Literature Review | group | `verification` | 1000 | 153.215 | 160.217 | 154.180 | 3.140 | 150.187 | 174.697 | 164.102 |
| Literature Review | group | `authorization_and_binding` | 1000 | 2.727 | 2.895 | 2.752 | 0.135 | 2.628 | 5.656 | 3.067 |
| Literature Review | group | `run_plan` | 1000 | 3.929 | 4.209 | 3.968 | 0.157 | 3.803 | 6.028 | 4.710 |
| Literature Review | group | `revalidation` | 1000 | 290.084 | 301.313 | 291.958 | 8.952 | 284.305 | 504.155 | 312.522 |
| Literature Review | total | `total_pre_execution` | 1000 | 451.258 | 465.196 | 452.858 | 10.143 | 442.362 | 669.143 | 483.385 |
| Literature Review | secondary | `local_file_read` | 1000 | 0.154 | 0.212 | 0.160 | 0.031 | 0.106 | 0.428 | 0.277 |
| WebAir | stage | `package_open_verify` | 1000 | 162.342 | 169.215 | 163.087 | 2.871 | 159.527 | 186.024 | 172.471 |
| WebAir | stage | `authorization_receipt` | 1000 | 0.628 | 0.693 | 0.636 | 0.039 | 0.568 | 1.342 | 0.761 |
| WebAir | stage | `compatibility_evaluation` | 1000 | 3.362 | 3.503 | 3.378 | 0.077 | 3.285 | 4.740 | 3.655 |
| WebAir | stage | `run_plan_preparation` | 1000 | 6.533 | 6.875 | 6.580 | 0.185 | 6.362 | 9.129 | 7.343 |
| WebAir | stage | `host_revalidation_lease` | 1000 | 10.775 | 11.582 | 10.903 | 0.630 | 10.236 | 22.767 | 12.519 |
| WebAir | stage | `runner_verification` | 1000 | 163.125 | 169.710 | 163.899 | 2.986 | 160.069 | 191.204 | 174.878 |
| WebAir | stage | `workflow_start` | 1000 | 143.285 | 150.519 | 144.178 | 2.946 | 140.568 | 165.260 | 155.429 |
| WebAir | group | `verification` | 1000 | 162.342 | 169.215 | 163.087 | 2.871 | 159.527 | 186.024 | 172.471 |
| WebAir | group | `authorization_and_binding` | 1000 | 3.991 | 4.169 | 4.014 | 0.098 | 3.884 | 5.501 | 4.389 |
| WebAir | group | `run_plan` | 1000 | 6.533 | 6.875 | 6.580 | 0.185 | 6.362 | 9.129 | 7.343 |
| WebAir | group | `revalidation` | 1000 | 317.575 | 329.102 | 318.979 | 5.163 | 312.461 | 357.335 | 340.209 |
| WebAir | total | `total_pre_execution` | 1000 | 490.751 | 505.980 | 492.660 | 7.012 | 482.664 | 539.001 | 519.912 |
| WebAir | secondary | `local_file_read` | 1000 | 0.138 | 0.181 | 0.146 | 0.064 | 0.096 | 1.189 | 0.242 |

## Stability

Batch medians of the total, per package (ms):

| Package | batch 0 | batch 1 | batch 2 | batch 3 | batch 4 | spread (% of median) |
|---|---:|---:|---:|---:|---:|---:|
| Literature Review | 450.243 | 452.790 | 453.055 | 450.995 | 450.410 | 0.6 |
| Meeting Agenda | 58.803 | 59.267 | 59.188 | 58.899 | 58.929 | 0.8 |
| WebAir | 489.282 | 492.219 | 492.268 | 490.841 | 489.039 | 0.7 |

Largest batch-median spread among single operations: `host_revalidation_lease` for Meeting Agenda, 3.1% of its median.

Order position (0 = ran first within its iteration) and tail of the total:

| Package | median at position 0 | median at position 1 | median at position 2 | p99 / median | max / median | > 2x median | > 5x median |
|---|---:|---:|---:|---:|---:|---:|---:|
| WebAir | 490.713 | 490.821 | 490.679 | 1.06 | 1.10 | 0 | 0 |
| Literature Review | 451.052 | 451.520 | 451.297 | 1.07 | 1.48 | 0 | 0 |
| Meeting Agenda | 59.006 | 58.980 | 59.071 | 1.11 | 1.24 | 0 | 0 |

Negative values: 0. Exact zeros: 0.

## Component decomposition (diagnostic, separate from the totals)

The production functions inside package open, each called on its own with its own timer on the same in-memory bytes (milliseconds). The open stage runs all five once; the runner re-runs the first three; the interpreter re-runs the first two (integrity statement and payload validation). These calls are not part of the pipeline observations above and do not add up to them exactly.

| Package | Component | Production function | n | median | p95 | mean | std |
|---|---|---|---:|---:|---:|---:|---:|
| Meeting Agenda | container_integrity | `agentpkg.package.read_archive_bytes` | 500 | 2.902 | 3.074 | 2.918 | 0.093 |
| Meeting Agenda | schema_validation | `agentpkg.validation.validate_payload` | 500 | 14.429 | 14.921 | 14.523 | 0.541 |
| Meeting Agenda | signature | `agentpkg.browser.evaluation.signature_report` | 500 | 0.253 | 0.279 | 0.257 | 0.012 |
| Meeting Agenda | publisher_trust | `agentpkg.browser.trust.TrustStore.evaluate` | 500 | 0.132 | 0.179 | 0.142 | 0.039 |
| Meeting Agenda | inspection_summary | `agentpkg.browser.summary.build_summary` | 500 | 0.211 | 0.234 | 0.214 | 0.009 |
| Literature Review | container_integrity | `agentpkg.package.read_archive_bytes` | 500 | 23.761 | 24.456 | 23.822 | 0.320 |
| Literature Review | schema_validation | `agentpkg.validation.validate_payload` | 500 | 124.887 | 130.999 | 125.715 | 2.421 |
| Literature Review | signature | `agentpkg.browser.evaluation.signature_report` | 500 | 0.387 | 0.418 | 0.390 | 0.015 |
| Literature Review | publisher_trust | `agentpkg.browser.trust.TrustStore.evaluate` | 500 | 0.185 | 0.250 | 0.192 | 0.039 |
| Literature Review | inspection_summary | `agentpkg.browser.summary.build_summary` | 500 | 0.835 | 0.924 | 0.852 | 0.055 |
| WebAir | container_integrity | `agentpkg.package.read_archive_bytes` | 500 | 19.172 | 19.754 | 19.248 | 0.326 |
| WebAir | schema_validation | `agentpkg.validation.validate_payload` | 500 | 138.740 | 141.358 | 139.073 | 1.696 |
| WebAir | signature | `agentpkg.browser.evaluation.signature_report` | 500 | 0.377 | 0.404 | 0.378 | 0.012 |
| WebAir | publisher_trust | `agentpkg.browser.trust.TrustStore.evaluate` | 500 | 0.183 | 0.241 | 0.280 | 1.885 |
| WebAir | inspection_summary | `agentpkg.browser.summary.build_summary` | 500 | 0.973 | 1.070 | 0.989 | 0.058 |

## Audit-event microbenchmark (separate from the totals)

`Runtime.record` replaying each recorded run's audit stream event by event into a fresh production `Runtime` per batch (microseconds per event). `no_observer` is the bookkeeping alone: build the event, hash it over RFC 8785 canonical JSON, link it to the previous hash, append. `progress_observer` adds the runner's live-progress observer.

| Variant | Stream | n | median | p95 | mean | std | min | max | events/s at median |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|
| no_observer | literature-review | 10100 | 5.46 | 6.96 | 5.76 | 1.29 | 4.54 | 45.71 | 183,217 |
| no_observer | meeting-agenda | 2300 | 5.42 | 6.62 | 5.63 | 2.74 | 4.46 | 103.46 | 184,638 |
| progress_observer | literature-review | 10100 | 11.67 | 15.50 | 12.54 | 3.12 | 9.46 | 228.88 | 85,712 |
| progress_observer | meeting-agenda | 2300 | 11.71 | 14.75 | 13.00 | 35.18 | 9.79 | 1,695.92 | 85,412 |

Streams: meeting-agenda: `examples/meeting-agenda-022-qwen/audit.json` (92 events); literature-review: `examples/literature-review-live/audit.json` (404 events)

## Optional context (not a paper claim)

Recorded live runs of the same package versions, read from run records and evidence files in this repository at analysis time. They were recorded on a host session, not in this benchmark, and are shown only to place the measured magnitude next to a workflow duration. A package with no recorded live run of the benchmarked version in the repository (Literature Review 0.2.5) gets no ratio.

| Run record | Run id | Model | Workflow duration | Median contract total | Ratio |
|---|---|---|---:|---:|---:|
| `examples/meeting-agenda-022-qwen/run.json` | `run_76c1e18ab3c64a1b9470c656a9178d4b` | ollama/qwen3:30b | 133.2 s | 59.03 ms | 0.044% |
| `examples/meeting-agenda-022-luna/run.json` | `run_119d25dc76af40148a44b1c45c719281` | openai/gpt-5.6-luna | 32.4 s | 59.03 ms | 0.182% |
| `examples/verification/webair-030-table1-runs.json#runs/local` | `run_8dcfcde45f3344edb7f52d950083a680` | ollama/qwen3:30b | 81.7 s | 490.75 ms | 0.600% |
| `examples/verification/webair-030-table1-runs.json#runs/api` | `run_a3a1337cd6454cc3989ca19ad72b0950` | openai/gpt-5.6-luna | 18.6 s | 490.75 ms | 2.639% |

## Environment

- Darwin 15.7.4 (arm64), CPU Apple M3 Max, 14 logical CPUs (10 performance + 4 efficiency), 36 GiB memory.
- Python 3.13.5 (CPython); timer `mach_absolute_time()`, resolution 4.166666666666666e-08 s.
- agentpkg 0.2.2 (source in repository: True); dependencies jsonschema 4.26.0, referencing 0.37.0, cryptography 46.0.7, rfc8785 0.1.4.
- Agent Browser plugin 0.1.0; OpenClaw 2026.9.5 named by the fixtures; Node v26.9.0 (fixture generation only). Neither Node nor OpenClaw runs in the measured process.
- System load average (1/5/15 min) at start [2.55, 2.44, 2.55], at end [2.38, 2.11, 2.24].
- Offline guard violations: 0.

## Exclusions and limitations

- Excluded by construction: package download, human decision time, model inference, tool calls, network access, the Agent Browser plugin's loopback HTTP calls to the control plane (JSON serialization, `node:http`), the plugin-side field comparisons in `preflight.ts`, spawning the runner process, and the bridge framing of the inbound `execution.begin` request.
- The runner's plan projection (`preflight.ts`) is mirrored in Python; a test checks it equals the real TypeScript output.
- The stop at the first wave replaces `Workflow._gather` in the benchmark process only; everything before it is unmodified production code.
- One machine, one Python process, 3 packages. Absolute values depend on the machine, on the trust store contents (3 pinned keys here) and on the host's tool and resource registries; they are not a scaling law.

## Files

`metadata.json`, `samples.csv` (every measured observation, ns), `timestamps.csv` (t0..t7 offsets per observation), `warmup_samples.csv`, `summary.csv`, `summary.json`, `batch_summary.csv`, `audit_samples.csv`, `component_samples.csv`, `report.md`, `paper_table.tex`, `paper_table_detailed.tex`, `command.txt`.
