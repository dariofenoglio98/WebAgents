# Contract overhead: results

Run started 2026-10-03T15:53:23.941300+00:00 (UTC), benchmark contract_overhead 1.1.0, git `9d78ca5a4be1` (working tree has changes, none in production paths).

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
- Wall time of the measurement: 1240.4 s.

## Main result (paper groups)

All values in milliseconds.

| Operation | Meeting Agenda median | p95 | Literature Review median | p95 | WebAir median | p95 |
|---|---:|---:|---:|---:|---:|---:|
| Package verification | 19.29 | 20.31 | 152.25 | 159.75 | 161.09 | 166.94 |
| Authorization and binding | 1.72 | 1.82 | 2.73 | 2.86 | 4.00 | 4.17 |
| Run Plan preparation | 2.12 | 2.30 | 3.94 | 4.13 | 6.55 | 6.87 |
| Pre-execution revalidation | 35.74 | 37.85 | 288.00 | 298.20 | 314.67 | 323.65 |
| **Total** | 58.89 | 61.92 | 448.49 | 460.95 | 486.85 | 498.98 |

## Per-operation breakdown

| Operation | Meeting Agenda median | p95 | Literature Review median | p95 | WebAir median | p95 |
|---|---:|---:|---:|---:|---:|---:|
| Package open and verification | 19.29 | 20.31 | 152.25 | 159.75 | 161.09 | 166.94 |
| Authorization receipt | 0.49 | 0.54 | 0.62 | 0.68 | 0.63 | 0.69 |
| Model and tool compatibility | 1.23 | 1.28 | 2.11 | 2.19 | 3.37 | 3.48 |
| Run Plan preparation | 2.12 | 2.30 | 3.94 | 4.13 | 6.55 | 6.87 |
| Host revalidation and lease | 1.85 | 2.22 | 7.17 | 7.89 | 10.79 | 11.57 |
| Runner re-verification | 18.55 | 19.61 | 151.63 | 158.78 | 161.82 | 167.72 |
| Workflow instantiation and start checks | 15.30 | 16.26 | 128.36 | 135.18 | 141.75 | 147.25 |
| **Total** | 58.89 | 61.92 | 448.49 | 460.95 | 486.85 | 498.98 |
| Local file read (secondary, not in total) | 0.13 | 0.17 | 0.15 | 0.21 | 0.14 | 0.18 |

Medians of the stages do not add up to the median total; each row is summarized on its own.

## Paper-ready interpretation

For Meeting Agenda 0.2.2, the automated contract processing from in-memory package bytes to the first workflow-node dispatch required a median of 58.89 ms (p95 61.92 ms; n = 1000). For Literature Review 0.2.5, the automated contract processing from in-memory package bytes to the first workflow-node dispatch required a median of 448.49 ms (p95 460.95 ms; n = 1000). For WebAir 0.3.0, the automated contract processing from in-memory package bytes to the first workflow-node dispatch required a median of 486.85 ms (p95 498.98 ms; n = 1000).

- Meeting Agenda: the largest single operation by median was *Package open and verification* (19.29 ms, 33% of the median total), followed by *Runner re-verification* (18.55 ms). Of the four paper groups, *Pre-execution revalidation* had the largest median (35.74 ms).
- Literature Review: the largest single operation by median was *Package open and verification* (152.25 ms, 34% of the median total), followed by *Runner re-verification* (151.63 ms). Of the four paper groups, *Pre-execution revalidation* had the largest median (288.00 ms).
- WebAir: the largest single operation by median was *Runner re-verification* (161.82 ms, 33% of the median total), followed by *Package open and verification* (161.09 ms). Of the four paper groups, *Pre-execution revalidation* had the largest median (314.67 ms).
- Relative to Meeting Agenda, the median totals were: Literature Review 7.6x, WebAir 8.3x. The artifacts differ in several respects at once (Meeting Agenda / Literature Review / WebAir: 21,580 / 224,302 / 167,193 archive bytes, 17 / 66 / 58 payload files, 7 / 25 / 34 graph nodes, 0 / 3 / 7 declared tools), so 3 packages do not identify which property drives the differences and do not establish a scaling relation.
- Each measured observation re-verifies the package three times, as production does: when the control plane opens the snapshot, when the runner verifies the leased artifact, and when the interpreter re-checks integrity and re-validates the payload. No verification result is cached between them.
- Audit bookkeeping (reported separately, not part of the totals above): appending and hash-linking one recorded audit event through `Runtime.record`, without an observer, took Literature Review stream: median 5.5 us (p95 7.1 us, about 180,473 events/s at the median); Meeting Agenda stream: median 5.5 us (p95 6.7 us, about 181,818 events/s at the median).

Scope sentence: these figures measure only local automated contract processing in one Python process, and exclude package acquisition, human authorization time, model inference, external tool latency, loopback HTTP transport between plugin and control plane, and runner process start-up.

## Full statistics

Milliseconds; `std` is the sample standard deviation (n - 1); percentiles use linear interpolation (Hyndman–Fan type 7).

| Package | Kind | Stage | n | median | p95 | mean | std | min | max | p99 |
|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|
| Meeting Agenda | stage | `package_open_verify` | 1000 | 19.287 | 20.315 | 19.396 | 0.510 | 18.496 | 24.448 | 21.445 |
| Meeting Agenda | stage | `authorization_receipt` | 1000 | 0.489 | 0.542 | 0.497 | 0.042 | 0.451 | 1.139 | 0.670 |
| Meeting Agenda | stage | `compatibility_evaluation` | 1000 | 1.225 | 1.284 | 1.232 | 0.029 | 1.131 | 1.441 | 1.351 |
| Meeting Agenda | stage | `run_plan_preparation` | 1000 | 2.118 | 2.296 | 2.150 | 0.183 | 2.017 | 6.531 | 2.703 |
| Meeting Agenda | stage | `host_revalidation_lease` | 1000 | 1.853 | 2.223 | 1.890 | 0.203 | 1.351 | 3.208 | 2.652 |
| Meeting Agenda | stage | `runner_verification` | 1000 | 18.549 | 19.611 | 18.698 | 0.647 | 17.828 | 27.044 | 21.011 |
| Meeting Agenda | stage | `workflow_start` | 1000 | 15.303 | 16.261 | 15.443 | 0.634 | 14.967 | 25.426 | 17.178 |
| Meeting Agenda | group | `verification` | 1000 | 19.287 | 20.315 | 19.396 | 0.510 | 18.496 | 24.448 | 21.445 |
| Meeting Agenda | group | `authorization_and_binding` | 1000 | 1.717 | 1.816 | 1.729 | 0.055 | 1.599 | 2.370 | 1.957 |
| Meeting Agenda | group | `run_plan` | 1000 | 2.118 | 2.296 | 2.150 | 0.183 | 2.017 | 6.531 | 2.703 |
| Meeting Agenda | group | `revalidation` | 1000 | 35.739 | 37.852 | 36.031 | 1.098 | 34.646 | 47.372 | 40.530 |
| Meeting Agenda | total | `total_pre_execution` | 1000 | 58.890 | 61.924 | 59.305 | 1.515 | 56.874 | 73.382 | 65.247 |
| Meeting Agenda | secondary | `local_file_read` | 1000 | 0.127 | 0.166 | 0.130 | 0.027 | 0.077 | 0.366 | 0.243 |
| Literature Review | stage | `package_open_verify` | 1000 | 152.253 | 159.747 | 153.369 | 3.546 | 149.312 | 199.828 | 164.146 |
| Literature Review | stage | `authorization_receipt` | 1000 | 0.621 | 0.676 | 0.633 | 0.159 | 0.563 | 5.443 | 0.767 |
| Literature Review | stage | `compatibility_evaluation` | 1000 | 2.107 | 2.194 | 2.117 | 0.046 | 1.978 | 2.594 | 2.284 |
| Literature Review | stage | `run_plan_preparation` | 1000 | 3.943 | 4.128 | 3.970 | 0.126 | 3.833 | 5.843 | 4.493 |
| Literature Review | stage | `host_revalidation_lease` | 1000 | 7.172 | 7.891 | 7.291 | 0.638 | 6.522 | 13.344 | 10.813 |
| Literature Review | stage | `runner_verification` | 1000 | 151.634 | 158.776 | 152.691 | 3.070 | 149.177 | 170.836 | 162.857 |
| Literature Review | stage | `workflow_start` | 1000 | 128.358 | 135.177 | 129.479 | 3.165 | 125.937 | 155.034 | 140.722 |
| Literature Review | group | `verification` | 1000 | 152.253 | 159.747 | 153.369 | 3.546 | 149.312 | 199.828 | 164.146 |
| Literature Review | group | `authorization_and_binding` | 1000 | 2.730 | 2.858 | 2.751 | 0.165 | 2.594 | 7.430 | 3.065 |
| Literature Review | group | `run_plan` | 1000 | 3.943 | 4.128 | 3.970 | 0.126 | 3.833 | 5.843 | 4.493 |
| Literature Review | group | `revalidation` | 1000 | 288.001 | 298.198 | 289.461 | 4.925 | 283.076 | 323.656 | 306.603 |
| Literature Review | total | `total_pre_execution` | 1000 | 448.485 | 460.951 | 449.551 | 6.566 | 440.041 | 493.410 | 474.114 |
| Literature Review | secondary | `local_file_read` | 1000 | 0.153 | 0.209 | 0.161 | 0.065 | 0.110 | 1.880 | 0.285 |
| WebAir | stage | `package_open_verify` | 1000 | 161.088 | 166.940 | 161.928 | 4.413 | 158.687 | 264.443 | 171.589 |
| WebAir | stage | `authorization_receipt` | 1000 | 0.626 | 0.690 | 0.637 | 0.066 | 0.562 | 2.095 | 0.848 |
| WebAir | stage | `compatibility_evaluation` | 1000 | 3.368 | 3.484 | 3.381 | 0.059 | 3.216 | 3.846 | 3.624 |
| WebAir | stage | `run_plan_preparation` | 1000 | 6.548 | 6.874 | 6.591 | 0.184 | 6.405 | 9.151 | 7.219 |
| WebAir | stage | `host_revalidation_lease` | 1000 | 10.794 | 11.568 | 10.910 | 1.214 | 10.022 | 47.287 | 12.177 |
| WebAir | stage | `runner_verification` | 1000 | 161.821 | 167.723 | 162.465 | 2.494 | 159.537 | 188.418 | 171.855 |
| WebAir | stage | `workflow_start` | 1000 | 141.747 | 147.247 | 142.440 | 2.581 | 139.483 | 161.392 | 152.965 |
| WebAir | group | `verification` | 1000 | 161.088 | 166.940 | 161.928 | 4.413 | 158.687 | 264.443 | 171.589 |
| WebAir | group | `authorization_and_binding` | 1000 | 3.996 | 4.170 | 4.018 | 0.097 | 3.889 | 5.435 | 4.371 |
| WebAir | group | `run_plan` | 1000 | 6.548 | 6.874 | 6.591 | 0.184 | 6.405 | 9.151 | 7.219 |
| WebAir | group | `revalidation` | 1000 | 314.666 | 323.651 | 315.815 | 4.633 | 310.530 | 362.601 | 332.512 |
| WebAir | total | `total_pre_execution` | 1000 | 486.848 | 498.982 | 488.352 | 7.367 | 480.496 | 591.437 | 512.845 |
| WebAir | secondary | `local_file_read` | 1000 | 0.136 | 0.182 | 0.143 | 0.039 | 0.093 | 0.734 | 0.250 |

## Stability

Batch medians of the total, per package (ms):

| Package | batch 0 | batch 1 | batch 2 | batch 3 | batch 4 | spread (% of median) |
|---|---:|---:|---:|---:|---:|---:|
| Literature Review | 447.090 | 448.686 | 447.263 | 449.713 | 449.395 | 0.6 |
| Meeting Agenda | 58.662 | 58.834 | 58.856 | 59.013 | 59.187 | 0.9 |
| WebAir | 485.452 | 487.026 | 486.651 | 487.617 | 487.941 | 0.5 |

Largest batch-median spread among single operations: `host_revalidation_lease` for Meeting Agenda, 2.9% of its median.

Order position (0 = ran first within its iteration) and tail of the total:

| Package | median at position 0 | median at position 1 | median at position 2 | p99 / median | max / median | > 2x median | > 5x median |
|---|---:|---:|---:|---:|---:|---:|---:|
| WebAir | 487.044 | 487.001 | 486.346 | 1.05 | 1.21 | 0 | 0 |
| Literature Review | 448.054 | 448.485 | 448.673 | 1.06 | 1.10 | 0 | 0 |
| Meeting Agenda | 58.925 | 58.773 | 58.968 | 1.11 | 1.25 | 0 | 0 |

Negative values: 0. Exact zeros: 0.

## Component decomposition (diagnostic, separate from the totals)

The production functions inside package open, each called on its own with its own timer on the same in-memory bytes (milliseconds). The open stage runs all five once; the runner re-runs the first three; the interpreter re-runs the first two (integrity statement and payload validation). These calls are not part of the pipeline observations above and do not add up to them exactly.

| Package | Component | Production function | n | median | p95 | mean | std |
|---|---|---|---:|---:|---:|---:|---:|
| Meeting Agenda | container_integrity | `agentpkg.package.read_archive_bytes` | 500 | 2.960 | 3.211 | 3.020 | 0.604 |
| Meeting Agenda | schema_validation | `agentpkg.validation.validate_payload` | 500 | 14.552 | 15.550 | 14.737 | 0.926 |
| Meeting Agenda | signature | `agentpkg.browser.evaluation.signature_report` | 500 | 0.253 | 0.292 | 0.260 | 0.017 |
| Meeting Agenda | publisher_trust | `agentpkg.browser.trust.TrustStore.evaluate` | 500 | 0.163 | 0.207 | 0.178 | 0.212 |
| Meeting Agenda | inspection_summary | `agentpkg.browser.summary.build_summary` | 500 | 0.211 | 0.246 | 0.217 | 0.019 |
| Literature Review | container_integrity | `agentpkg.package.read_archive_bytes` | 500 | 23.897 | 25.538 | 24.093 | 0.708 |
| Literature Review | schema_validation | `agentpkg.validation.validate_payload` | 500 | 124.627 | 133.255 | 126.111 | 3.832 |
| Literature Review | signature | `agentpkg.browser.evaluation.signature_report` | 500 | 0.387 | 0.421 | 0.390 | 0.019 |
| Literature Review | publisher_trust | `agentpkg.browser.trust.TrustStore.evaluate` | 500 | 0.210 | 0.341 | 0.227 | 0.074 |
| Literature Review | inspection_summary | `agentpkg.browser.summary.build_summary` | 500 | 0.841 | 1.036 | 0.864 | 0.079 |
| WebAir | container_integrity | `agentpkg.package.read_archive_bytes` | 500 | 19.271 | 20.364 | 19.389 | 0.400 |
| WebAir | schema_validation | `agentpkg.validation.validate_payload` | 500 | 138.277 | 145.266 | 139.088 | 2.791 |
| WebAir | signature | `agentpkg.browser.evaluation.signature_report` | 500 | 0.374 | 0.415 | 0.378 | 0.020 |
| WebAir | publisher_trust | `agentpkg.browser.trust.TrustStore.evaluate` | 500 | 0.205 | 0.302 | 0.224 | 0.113 |
| WebAir | inspection_summary | `agentpkg.browser.summary.build_summary` | 500 | 0.972 | 1.166 | 1.001 | 0.138 |

## Audit-event microbenchmark (separate from the totals)

`Runtime.record` replaying each recorded run's audit stream event by event into a fresh production `Runtime` per batch (microseconds per event). `no_observer` is the bookkeeping alone: build the event, hash it over RFC 8785 canonical JSON, link it to the previous hash, append. `progress_observer` adds the runner's live-progress observer.

| Variant | Stream | n | median | p95 | mean | std | min | max | events/s at median |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|
| no_observer | literature-review | 10100 | 5.54 | 7.08 | 5.88 | 1.48 | 4.62 | 63.25 | 180,473 |
| no_observer | meeting-agenda | 2300 | 5.50 | 6.71 | 5.71 | 2.69 | 4.58 | 101.92 | 181,818 |
| progress_observer | literature-review | 10100 | 11.75 | 15.29 | 12.50 | 2.23 | 9.96 | 101.50 | 85,106 |
| progress_observer | meeting-agenda | 2300 | 11.79 | 14.88 | 12.95 | 26.94 | 10.00 | 1,299.17 | 84,803 |

Streams: meeting-agenda: `examples/meeting-agenda-022-qwen/audit.json` (92 events); literature-review: `examples/literature-review-live/audit.json` (404 events)

## Optional context (not a paper claim)

Recorded live runs of the same package versions, read from run records and evidence files in this repository at analysis time. They were recorded on a host session, not in this benchmark, and are shown only to place the measured magnitude next to a workflow duration. A package with no recorded live run of the benchmarked version in the repository (Literature Review 0.2.5) gets no ratio.

| Run record | Run id | Model | Workflow duration | Median contract total | Ratio |
|---|---|---|---:|---:|---:|
| `examples/meeting-agenda-022-qwen/run.json` | `run_76c1e18ab3c64a1b9470c656a9178d4b` | ollama/qwen3:30b | 133.2 s | 58.89 ms | 0.044% |
| `examples/meeting-agenda-022-luna/run.json` | `run_119d25dc76af40148a44b1c45c719281` | openai/gpt-5.6-luna | 32.4 s | 58.89 ms | 0.182% |
| `examples/verification/webair-030-table1-runs.json#runs/local` | `run_8dcfcde45f3344edb7f52d950083a680` | ollama/qwen3:30b | 81.7 s | 486.85 ms | 0.596% |
| `examples/verification/webair-030-table1-runs.json#runs/api` | `run_a3a1337cd6454cc3989ca19ad72b0950` | openai/gpt-5.6-luna | 18.6 s | 486.85 ms | 2.618% |

## Environment

- Darwin 15.7.4 (arm64), CPU Apple M3 Max, 14 logical CPUs (10 performance + 4 efficiency), 36 GiB memory.
- Python 3.13.5 (CPython); timer `mach_absolute_time()`, resolution 4.166666666666666e-08 s.
- agentpkg 0.2.2 (source in repository: True); dependencies jsonschema 4.26.0, referencing 0.37.0, cryptography 46.0.7, rfc8785 0.1.4.
- Agent Browser plugin 0.1.0; OpenClaw 2026.9.5 named by the fixtures; Node v26.9.0 (fixture generation only). Neither Node nor OpenClaw runs in the measured process.
- System load average (1/5/15 min) at start [2.78, 2.65, 2.45], at end [2.01, 2.53, 2.6].
- Offline guard violations: 0.

## Exclusions and limitations

- Excluded by construction: package download, human decision time, model inference, tool calls, network access, the Agent Browser plugin's loopback HTTP calls to the control plane (JSON serialization, `node:http`), the plugin-side field comparisons in `preflight.ts`, spawning the runner process, and the bridge framing of the inbound `execution.begin` request.
- The runner's plan projection (`preflight.ts`) is mirrored in Python; a test checks it equals the real TypeScript output.
- The stop at the first wave replaces `Workflow._gather` in the benchmark process only; everything before it is unmodified production code.
- One machine, one Python process, 3 packages. Absolute values depend on the machine, on the trust store contents (3 pinned keys here) and on the host's tool and resource registries; they are not a scaling law.

## Files

`metadata.json`, `samples.csv` (every measured observation, ns), `timestamps.csv` (t0..t7 offsets per observation), `warmup_samples.csv`, `summary.csv`, `summary.json`, `batch_summary.csv`, `audit_samples.csv`, `component_samples.csv`, `report.md`, `paper_table.tex`, `paper_table_detailed.tex`, `command.txt`.
