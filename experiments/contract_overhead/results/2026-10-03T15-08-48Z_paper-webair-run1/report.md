# Contract overhead: results

Run started 2026-10-03T15:08:48.475002+00:00 (UTC), benchmark contract_overhead 1.1.0, git `9d78ca5a4be1` (working tree has changes, none in production paths).

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
- Wall time of the measurement: 1245.0 s.

## Main result (paper groups)

All values in milliseconds.

| Operation | Meeting Agenda median | p95 | Literature Review median | p95 | WebAir median | p95 |
|---|---:|---:|---:|---:|---:|---:|
| Package verification | 19.32 | 20.52 | 152.53 | 160.90 | 161.58 | 168.83 |
| Authorization and binding | 1.72 | 1.83 | 2.73 | 2.90 | 4.00 | 4.25 |
| Run Plan preparation | 2.13 | 2.30 | 3.94 | 4.25 | 6.55 | 6.99 |
| Pre-execution revalidation | 35.84 | 38.42 | 289.29 | 303.07 | 315.93 | 329.12 |
| **Total** | 59.04 | 63.08 | 449.56 | 467.54 | 488.18 | 506.63 |

## Per-operation breakdown

| Operation | Meeting Agenda median | p95 | Literature Review median | p95 | WebAir median | p95 |
|---|---:|---:|---:|---:|---:|---:|
| Package open and verification | 19.32 | 20.52 | 152.53 | 160.90 | 161.58 | 168.83 |
| Authorization receipt | 0.49 | 0.55 | 0.62 | 0.70 | 0.63 | 0.71 |
| Model and tool compatibility | 1.23 | 1.30 | 2.11 | 2.22 | 3.37 | 3.55 |
| Run Plan preparation | 2.13 | 2.30 | 3.94 | 4.25 | 6.55 | 6.99 |
| Host revalidation and lease | 1.88 | 2.20 | 7.22 | 8.10 | 10.85 | 11.77 |
| Runner re-verification | 18.60 | 19.92 | 152.01 | 160.32 | 162.32 | 170.61 |
| Workflow instantiation and start checks | 15.34 | 16.60 | 128.67 | 137.38 | 142.42 | 149.81 |
| **Total** | 59.04 | 63.08 | 449.56 | 467.54 | 488.18 | 506.63 |
| Local file read (secondary, not in total) | 0.13 | 0.17 | 0.16 | 0.21 | 0.14 | 0.19 |

Medians of the stages do not add up to the median total; each row is summarized on its own.

## Paper-ready interpretation

For Meeting Agenda 0.2.2, the automated contract processing from in-memory package bytes to the first workflow-node dispatch required a median of 59.04 ms (p95 63.08 ms; n = 1000). For Literature Review 0.2.5, the automated contract processing from in-memory package bytes to the first workflow-node dispatch required a median of 449.56 ms (p95 467.54 ms; n = 1000). For WebAir 0.3.0, the automated contract processing from in-memory package bytes to the first workflow-node dispatch required a median of 488.18 ms (p95 506.63 ms; n = 1000).

- Meeting Agenda: the largest single operation by median was *Package open and verification* (19.32 ms, 33% of the median total), followed by *Runner re-verification* (18.60 ms). Of the four paper groups, *Pre-execution revalidation* had the largest median (35.84 ms).
- Literature Review: the largest single operation by median was *Package open and verification* (152.53 ms, 34% of the median total), followed by *Runner re-verification* (152.01 ms). Of the four paper groups, *Pre-execution revalidation* had the largest median (289.29 ms).
- WebAir: the largest single operation by median was *Runner re-verification* (162.32 ms, 33% of the median total), followed by *Package open and verification* (161.58 ms). Of the four paper groups, *Pre-execution revalidation* had the largest median (315.93 ms).
- Relative to Meeting Agenda, the median totals were: Literature Review 7.6x, WebAir 8.3x. The artifacts differ in several respects at once (Meeting Agenda / Literature Review / WebAir: 21,580 / 224,302 / 167,193 archive bytes, 17 / 66 / 58 payload files, 7 / 25 / 34 graph nodes, 0 / 3 / 7 declared tools), so 3 packages do not identify which property drives the differences and do not establish a scaling relation.
- Each measured observation re-verifies the package three times, as production does: when the control plane opens the snapshot, when the runner verifies the leased artifact, and when the interpreter re-checks integrity and re-validates the payload. No verification result is cached between them.
- Audit bookkeeping (reported separately, not part of the totals above): appending and hash-linking one recorded audit event through `Runtime.record`, without an observer, took Literature Review stream: median 5.5 us (p95 8.2 us, about 180,473 events/s at the median); Meeting Agenda stream: median 5.5 us (p95 6.7 us, about 183,217 events/s at the median).

Scope sentence: these figures measure only local automated contract processing in one Python process, and exclude package acquisition, human authorization time, model inference, external tool latency, loopback HTTP transport between plugin and control plane, and runner process start-up.

## Full statistics

Milliseconds; `std` is the sample standard deviation (n - 1); percentiles use linear interpolation (Hyndman–Fan type 7).

| Package | Kind | Stage | n | median | p95 | mean | std | min | max | p99 |
|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|
| Meeting Agenda | stage | `package_open_verify` | 1000 | 19.315 | 20.520 | 19.453 | 0.579 | 18.318 | 24.367 | 21.446 |
| Meeting Agenda | stage | `authorization_receipt` | 1000 | 0.493 | 0.551 | 0.501 | 0.052 | 0.441 | 1.377 | 0.691 |
| Meeting Agenda | stage | `compatibility_evaluation` | 1000 | 1.228 | 1.298 | 1.237 | 0.037 | 1.179 | 1.634 | 1.389 |
| Meeting Agenda | stage | `run_plan_preparation` | 1000 | 2.129 | 2.301 | 2.151 | 0.096 | 2.009 | 3.067 | 2.601 |
| Meeting Agenda | stage | `host_revalidation_lease` | 1000 | 1.881 | 2.197 | 1.894 | 0.204 | 1.349 | 3.352 | 2.525 |
| Meeting Agenda | stage | `runner_verification` | 1000 | 18.603 | 19.922 | 18.812 | 0.946 | 17.885 | 35.157 | 21.717 |
| Meeting Agenda | stage | `workflow_start` | 1000 | 15.338 | 16.600 | 15.506 | 0.594 | 14.905 | 21.597 | 17.528 |
| Meeting Agenda | group | `verification` | 1000 | 19.315 | 20.520 | 19.453 | 0.579 | 18.318 | 24.367 | 21.446 |
| Meeting Agenda | group | `authorization_and_binding` | 1000 | 1.722 | 1.826 | 1.739 | 0.073 | 1.648 | 2.674 | 2.046 |
| Meeting Agenda | group | `run_plan` | 1000 | 2.129 | 2.301 | 2.151 | 0.096 | 2.009 | 3.067 | 2.601 |
| Meeting Agenda | group | `revalidation` | 1000 | 35.838 | 38.423 | 36.212 | 1.376 | 34.378 | 55.070 | 41.346 |
| Meeting Agenda | total | `total_pre_execution` | 1000 | 59.039 | 63.078 | 59.555 | 1.871 | 56.486 | 79.055 | 66.099 |
| Meeting Agenda | secondary | `local_file_read` | 1000 | 0.128 | 0.170 | 0.131 | 0.030 | 0.077 | 0.568 | 0.232 |
| Literature Review | stage | `package_open_verify` | 1000 | 152.528 | 160.899 | 153.860 | 3.823 | 148.396 | 175.898 | 169.497 |
| Literature Review | stage | `authorization_receipt` | 1000 | 0.624 | 0.695 | 0.634 | 0.049 | 0.570 | 1.306 | 0.846 |
| Literature Review | stage | `compatibility_evaluation` | 1000 | 2.108 | 2.220 | 2.122 | 0.053 | 2.034 | 2.601 | 2.353 |
| Literature Review | stage | `run_plan_preparation` | 1000 | 3.942 | 4.253 | 4.003 | 0.475 | 3.795 | 17.201 | 4.701 |
| Literature Review | stage | `host_revalidation_lease` | 1000 | 7.220 | 8.096 | 7.386 | 1.134 | 6.435 | 32.820 | 12.473 |
| Literature Review | stage | `runner_verification` | 1000 | 152.011 | 160.319 | 153.437 | 4.400 | 149.029 | 218.098 | 167.800 |
| Literature Review | stage | `workflow_start` | 1000 | 128.669 | 137.384 | 130.098 | 3.826 | 126.125 | 171.798 | 143.565 |
| Literature Review | group | `verification` | 1000 | 152.528 | 160.899 | 153.860 | 3.823 | 148.396 | 175.898 | 169.497 |
| Literature Review | group | `authorization_and_binding` | 1000 | 2.733 | 2.900 | 2.756 | 0.084 | 2.649 | 3.530 | 3.102 |
| Literature Review | group | `run_plan` | 1000 | 3.942 | 4.253 | 4.003 | 0.475 | 3.795 | 17.201 | 4.701 |
| Literature Review | group | `revalidation` | 1000 | 289.293 | 303.068 | 290.921 | 7.229 | 282.555 | 385.491 | 317.633 |
| Literature Review | total | `total_pre_execution` | 1000 | 449.555 | 467.541 | 451.540 | 9.294 | 440.377 | 561.885 | 486.721 |
| Literature Review | secondary | `local_file_read` | 1000 | 0.156 | 0.206 | 0.161 | 0.036 | 0.109 | 0.573 | 0.263 |
| WebAir | stage | `package_open_verify` | 1000 | 161.583 | 168.831 | 162.493 | 3.109 | 158.206 | 184.019 | 173.640 |
| WebAir | stage | `authorization_receipt` | 1000 | 0.632 | 0.715 | 0.644 | 0.055 | 0.567 | 1.507 | 0.902 |
| WebAir | stage | `compatibility_evaluation` | 1000 | 3.372 | 3.552 | 3.394 | 0.078 | 3.295 | 3.844 | 3.735 |
| WebAir | stage | `run_plan_preparation` | 1000 | 6.554 | 6.992 | 6.609 | 0.185 | 6.329 | 7.779 | 7.447 |
| WebAir | stage | `host_revalidation_lease` | 1000 | 10.850 | 11.774 | 10.953 | 0.450 | 9.975 | 17.397 | 12.341 |
| WebAir | stage | `runner_verification` | 1000 | 162.322 | 170.605 | 163.311 | 3.325 | 158.867 | 186.381 | 176.380 |
| WebAir | stage | `workflow_start` | 1000 | 142.423 | 149.806 | 143.336 | 3.129 | 139.333 | 164.897 | 154.546 |
| WebAir | group | `verification` | 1000 | 161.583 | 168.831 | 162.493 | 3.109 | 158.206 | 184.019 | 173.640 |
| WebAir | group | `authorization_and_binding` | 1000 | 4.005 | 4.250 | 4.038 | 0.110 | 3.885 | 4.889 | 4.455 |
| WebAir | group | `run_plan` | 1000 | 6.554 | 6.992 | 6.609 | 0.185 | 6.329 | 7.779 | 7.447 |
| WebAir | group | `revalidation` | 1000 | 315.932 | 329.122 | 317.599 | 5.746 | 308.722 | 357.690 | 339.973 |
| WebAir | total | `total_pre_execution` | 1000 | 488.182 | 506.635 | 490.739 | 7.808 | 477.609 | 542.839 | 520.399 |
| WebAir | secondary | `local_file_read` | 1000 | 0.140 | 0.195 | 0.144 | 0.027 | 0.098 | 0.322 | 0.237 |

## Stability

Batch medians of the total, per package (ms):

| Package | batch 0 | batch 1 | batch 2 | batch 3 | batch 4 | spread (% of median) |
|---|---:|---:|---:|---:|---:|---:|
| Literature Review | 448.063 | 448.511 | 451.558 | 451.819 | 449.203 | 0.8 |
| Meeting Agenda | 58.827 | 58.966 | 59.163 | 59.286 | 59.044 | 0.8 |
| WebAir | 486.906 | 487.058 | 489.911 | 490.555 | 487.691 | 0.7 |

Largest batch-median spread among single operations: `host_revalidation_lease` for Meeting Agenda, 1.5% of its median.

Order position (0 = ran first within its iteration) and tail of the total:

| Package | median at position 0 | median at position 1 | median at position 2 | p99 / median | max / median | > 2x median | > 5x median |
|---|---:|---:|---:|---:|---:|---:|---:|
| WebAir | 488.112 | 488.273 | 488.119 | 1.07 | 1.11 | 0 | 0 |
| Literature Review | 449.546 | 449.173 | 449.949 | 1.08 | 1.25 | 0 | 0 |
| Meeting Agenda | 59.061 | 58.944 | 59.080 | 1.12 | 1.34 | 0 | 0 |

Negative values: 0. Exact zeros: 0.

## Component decomposition (diagnostic, separate from the totals)

The production functions inside package open, each called on its own with its own timer on the same in-memory bytes (milliseconds). The open stage runs all five once; the runner re-runs the first three; the interpreter re-runs the first two (integrity statement and payload validation). These calls are not part of the pipeline observations above and do not add up to them exactly.

| Package | Component | Production function | n | median | p95 | mean | std |
|---|---|---|---:|---:|---:|---:|---:|
| Meeting Agenda | container_integrity | `agentpkg.package.read_archive_bytes` | 500 | 2.974 | 3.217 | 3.008 | 0.129 |
| Meeting Agenda | schema_validation | `agentpkg.validation.validate_payload` | 500 | 14.583 | 15.500 | 14.732 | 0.632 |
| Meeting Agenda | signature | `agentpkg.browser.evaluation.signature_report` | 500 | 0.255 | 0.303 | 0.262 | 0.018 |
| Meeting Agenda | publisher_trust | `agentpkg.browser.trust.TrustStore.evaluate` | 500 | 0.169 | 0.212 | 0.174 | 0.029 |
| Meeting Agenda | inspection_summary | `agentpkg.browser.summary.build_summary` | 500 | 0.213 | 0.250 | 0.217 | 0.016 |
| Literature Review | container_integrity | `agentpkg.package.read_archive_bytes` | 500 | 23.856 | 24.969 | 24.012 | 0.585 |
| Literature Review | schema_validation | `agentpkg.validation.validate_payload` | 500 | 124.991 | 132.496 | 126.351 | 3.866 |
| Literature Review | signature | `agentpkg.browser.evaluation.signature_report` | 500 | 0.391 | 0.426 | 0.395 | 0.034 |
| Literature Review | publisher_trust | `agentpkg.browser.trust.TrustStore.evaluate` | 500 | 0.220 | 0.322 | 0.232 | 0.046 |
| Literature Review | inspection_summary | `agentpkg.browser.summary.build_summary` | 500 | 0.845 | 1.007 | 0.875 | 0.207 |
| WebAir | container_integrity | `agentpkg.package.read_archive_bytes` | 500 | 19.278 | 20.255 | 19.384 | 0.386 |
| WebAir | schema_validation | `agentpkg.validation.validate_payload` | 500 | 138.709 | 145.249 | 139.472 | 2.595 |
| WebAir | signature | `agentpkg.browser.evaluation.signature_report` | 500 | 0.379 | 0.418 | 0.383 | 0.021 |
| WebAir | publisher_trust | `agentpkg.browser.trust.TrustStore.evaluate` | 500 | 0.219 | 0.342 | 0.250 | 0.240 |
| WebAir | inspection_summary | `agentpkg.browser.summary.build_summary` | 500 | 0.982 | 1.158 | 1.009 | 0.079 |

## Audit-event microbenchmark (separate from the totals)

`Runtime.record` replaying each recorded run's audit stream event by event into a fresh production `Runtime` per batch (microseconds per event). `no_observer` is the bookkeeping alone: build the event, hash it over RFC 8785 canonical JSON, link it to the previous hash, append. `progress_observer` adds the runner's live-progress observer.

| Variant | Stream | n | median | p95 | mean | std | min | max | events/s at median |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|
| no_observer | literature-review | 10100 | 5.54 | 8.21 | 5.97 | 1.75 | 4.25 | 52.54 | 180,473 |
| no_observer | meeting-agenda | 2300 | 5.46 | 6.71 | 5.71 | 2.83 | 4.50 | 112.62 | 183,217 |
| progress_observer | literature-review | 10100 | 11.96 | 15.75 | 12.73 | 2.38 | 9.83 | 109.62 | 83,626 |
| progress_observer | meeting-agenda | 2300 | 12.00 | 15.17 | 13.31 | 36.65 | 9.83 | 1,765.67 | 83,333 |

Streams: meeting-agenda: `examples/meeting-agenda-022-qwen/audit.json` (92 events); literature-review: `examples/literature-review-live/audit.json` (404 events)

## Optional context (not a paper claim)

Recorded live runs of the same package versions, read from run records and evidence files in this repository at analysis time. They were recorded on a host session, not in this benchmark, and are shown only to place the measured magnitude next to a workflow duration. A package with no recorded live run of the benchmarked version in the repository (Literature Review 0.2.5) gets no ratio.

| Run record | Run id | Model | Workflow duration | Median contract total | Ratio |
|---|---|---|---:|---:|---:|
| `examples/meeting-agenda-022-qwen/run.json` | `run_76c1e18ab3c64a1b9470c656a9178d4b` | ollama/qwen3:30b | 133.2 s | 59.04 ms | 0.044% |
| `examples/meeting-agenda-022-luna/run.json` | `run_119d25dc76af40148a44b1c45c719281` | openai/gpt-5.6-luna | 32.4 s | 59.04 ms | 0.182% |
| `examples/verification/webair-030-table1-runs.json#runs/local` | `run_8dcfcde45f3344edb7f52d950083a680` | ollama/qwen3:30b | 81.7 s | 488.18 ms | 0.597% |
| `examples/verification/webair-030-table1-runs.json#runs/api` | `run_a3a1337cd6454cc3989ca19ad72b0950` | openai/gpt-5.6-luna | 18.6 s | 488.18 ms | 2.625% |

## Environment

- Darwin 15.7.4 (arm64), CPU Apple M3 Max, 14 logical CPUs (10 performance + 4 efficiency), 36 GiB memory.
- Python 3.13.5 (CPython); timer `mach_absolute_time()`, resolution 4.166666666666666e-08 s.
- agentpkg 0.2.2 (source in repository: True); dependencies jsonschema 4.26.0, referencing 0.37.0, cryptography 46.0.7, rfc8785 0.1.4.
- Agent Browser plugin 0.1.0; OpenClaw 2026.9.5 named by the fixtures; Node v26.9.0 (fixture generation only). Neither Node nor OpenClaw runs in the measured process.
- System load average (1/5/15 min) at start [2.54, 2.73, 2.67], at end [2.1, 2.33, 2.52].
- Offline guard violations: 0.

## Exclusions and limitations

- Excluded by construction: package download, human decision time, model inference, tool calls, network access, the Agent Browser plugin's loopback HTTP calls to the control plane (JSON serialization, `node:http`), the plugin-side field comparisons in `preflight.ts`, spawning the runner process, and the bridge framing of the inbound `execution.begin` request.
- The runner's plan projection (`preflight.ts`) is mirrored in Python; a test checks it equals the real TypeScript output.
- The stop at the first wave replaces `Workflow._gather` in the benchmark process only; everything before it is unmodified production code.
- One machine, one Python process, 3 packages. Absolute values depend on the machine, on the trust store contents (3 pinned keys here) and on the host's tool and resource registries; they are not a scaling law.

## Files

`metadata.json`, `samples.csv` (every measured observation, ns), `timestamps.csv` (t0..t7 offsets per observation), `warmup_samples.csv`, `summary.csv`, `summary.json`, `batch_summary.csv`, `audit_samples.csv`, `component_samples.csv`, `report.md`, `paper_table.tex`, `paper_table_detailed.tex`, `command.txt`.
