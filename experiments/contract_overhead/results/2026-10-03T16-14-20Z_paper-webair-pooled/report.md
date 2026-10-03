# Contract overhead: pooled result

3 independent runs at commit `9d78ca5a4be1`, benchmark contract_overhead 1.1.0, pooled per package and operation. Statistics are computed from the raw samples of every run; medians of different rows do not add up and are not meant to.

## Runs

| Run | Started (UTC) | Wall (s) | Tracked changes | Load avg at start | Load avg at end |
|---|---|---:|---|---|---|
| `2026-10-03T15-08-48Z_paper-webair-run1` | 2026-10-03T15:08:48.475002+00:00 | 1245.0 | 0 | [2.54, 2.73, 2.67] | [2.1, 2.33, 2.52] |
| `2026-10-03T15-30-34Z_paper-webair-run2` | 2026-10-03T15:30:34.607739+00:00 | 1247.8 | 0 | [2.55, 2.44, 2.55] | [2.38, 2.11, 2.24] |
| `2026-10-03T15-53-23Z_paper-webair-run3` | 2026-10-03T15:53:23.941300+00:00 | 1240.4 | 0 | [2.78, 2.65, 2.45] | [2.01, 2.53, 2.6] |

## Paper table (pooled median (p95), ms)

| Operation | Meeting Agenda | Literature Review | WebAir |
|---|---:|---:|---:|
| Package verification | 19.31 (20.39) | 152.70 (160.14) | 161.65 (168.44) |
| Authorization / binding | 1.72 (1.82) | 2.73 (2.89) | 4.00 (4.20) |
| Run Plan preparation | 2.12 (2.29) | 3.94 (4.20) | 6.54 (6.92) |
| Pre-execution revalidation | 35.81 (38.13) | 289.36 (301.09) | 316.14 (327.32) |
| **Total** | **58.99 (62.48)** | **449.89 (465.03)** | **488.68 (504.67)** |

## All operations (pooled)

| Package | Kind | Stage | n | median | p95 | mean | std | run medians | run SD | run CV % | batch spread % |
|---|---|---|---:|---:|---:|---:|---:|---|---:|---:|---:|
| Meeting Agenda | stage | `package_open_verify` | 3,000 | 19.309 | 20.389 | 19.439 | 0.566 | 19.32, 19.33, 19.29 | 0.023 | 0.12 | 1.1 |
| Meeting Agenda | stage | `authorization_receipt` | 3,000 | 0.491 | 0.542 | 0.498 | 0.042 | 0.49, 0.49, 0.49 | 0.002 | 0.36 | 2.0 |
| Meeting Agenda | stage | `compatibility_evaluation` | 3,000 | 1.225 | 1.294 | 1.234 | 0.035 | 1.23, 1.22, 1.23 | 0.002 | 0.18 | 0.8 |
| Meeting Agenda | stage | `run_plan_preparation` | 3,000 | 2.121 | 2.293 | 2.147 | 0.131 | 2.13, 2.12, 2.12 | 0.007 | 0.33 | 1.3 |
| Meeting Agenda | stage | `host_revalidation_lease` | 3,000 | 1.859 | 2.193 | 1.888 | 0.233 | 1.88, 1.85, 1.85 | 0.018 | 0.94 | 4.0 |
| Meeting Agenda | stage | `runner_verification` | 3,000 | 18.579 | 19.793 | 18.751 | 0.756 | 18.60, 18.59, 18.55 | 0.028 | 0.15 | 1.1 |
| Meeting Agenda | stage | `workflow_start` | 3,000 | 15.332 | 16.341 | 15.475 | 0.584 | 15.34, 15.35, 15.30 | 0.025 | 0.17 | 1.3 |
| Meeting Agenda | group | `verification` | 3,000 | 19.309 | 20.389 | 19.439 | 0.566 | 19.32, 19.33, 19.29 | 0.023 | 0.12 | 1.1 |
| Meeting Agenda | group | `authorization_and_binding` | 3,000 | 1.718 | 1.820 | 1.732 | 0.061 | 1.72, 1.72, 1.72 | 0.004 | 0.21 | 0.9 |
| Meeting Agenda | group | `run_plan` | 3,000 | 2.121 | 2.293 | 2.147 | 0.131 | 2.13, 2.12, 2.12 | 0.007 | 0.33 | 1.3 |
| Meeting Agenda | group | `revalidation` | 3,000 | 35.811 | 38.126 | 36.114 | 1.175 | 35.84, 35.83, 35.74 | 0.055 | 0.15 | 1.2 |
| Meeting Agenda | total | `total_pre_execution` | 3,000 | 58.985 | 62.483 | 59.432 | 1.645 | 59.04, 59.03, 58.89 | 0.082 | 0.14 | 1.1 |
| Literature Review | stage | `package_open_verify` | 3,000 | 152.704 | 160.139 | 153.803 | 3.529 | 152.53, 153.22, 152.25 | 0.496 | 0.32 | 1.4 |
| Literature Review | stage | `authorization_receipt` | 3,000 | 0.622 | 0.687 | 0.634 | 0.115 | 0.62, 0.62, 0.62 | 0.001 | 0.22 | 2.2 |
| Literature Review | stage | `compatibility_evaluation` | 3,000 | 2.107 | 2.212 | 2.119 | 0.051 | 2.11, 2.10, 2.11 | 0.002 | 0.11 | 0.6 |
| Literature Review | stage | `run_plan_preparation` | 3,000 | 3.938 | 4.198 | 3.980 | 0.298 | 3.94, 3.93, 3.94 | 0.008 | 0.20 | 0.9 |
| Literature Review | stage | `host_revalidation_lease` | 3,000 | 7.193 | 7.977 | 7.407 | 3.592 | 7.22, 7.19, 7.17 | 0.025 | 0.34 | 2.0 |
| Literature Review | stage | `runner_verification` | 3,000 | 152.107 | 159.754 | 153.303 | 3.771 | 152.01, 152.60, 151.63 | 0.485 | 0.32 | 1.2 |
| Literature Review | stage | `workflow_start` | 3,000 | 128.881 | 136.485 | 130.070 | 3.554 | 128.67, 129.37, 128.36 | 0.521 | 0.40 | 1.6 |
| Literature Review | group | `verification` | 3,000 | 152.704 | 160.139 | 153.803 | 3.529 | 152.53, 153.22, 152.25 | 0.496 | 0.32 | 1.4 |
| Literature Review | group | `authorization_and_binding` | 3,000 | 2.730 | 2.889 | 2.753 | 0.133 | 2.73, 2.73, 2.73 | 0.003 | 0.11 | 0.7 |
| Literature Review | group | `run_plan` | 3,000 | 3.938 | 4.198 | 3.980 | 0.298 | 3.94, 3.93, 3.94 | 0.008 | 0.20 | 0.9 |
| Literature Review | group | `revalidation` | 3,000 | 289.357 | 301.093 | 290.780 | 7.296 | 289.29, 290.08, 288.00 | 1.051 | 0.36 | 1.6 |
| Literature Review | total | `total_pre_execution` | 3,000 | 449.893 | 465.031 | 451.316 | 8.903 | 449.56, 451.26, 448.49 | 1.398 | 0.31 | 1.3 |
| WebAir | stage | `package_open_verify` | 3,000 | 161.655 | 168.440 | 162.503 | 3.561 | 161.58, 162.34, 161.09 | 0.632 | 0.39 | 1.2 |
| WebAir | stage | `authorization_receipt` | 3,000 | 0.629 | 0.700 | 0.639 | 0.055 | 0.63, 0.63, 0.63 | 0.003 | 0.50 | 2.2 |
| WebAir | stage | `compatibility_evaluation` | 3,000 | 3.368 | 3.514 | 3.384 | 0.072 | 3.37, 3.36, 3.37 | 0.005 | 0.15 | 0.6 |
| WebAir | stage | `run_plan_preparation` | 3,000 | 6.544 | 6.922 | 6.593 | 0.185 | 6.55, 6.53, 6.55 | 0.011 | 0.16 | 0.9 |
| WebAir | stage | `host_revalidation_lease` | 3,000 | 10.808 | 11.656 | 10.922 | 0.831 | 10.85, 10.77, 10.79 | 0.039 | 0.36 | 2.0 |
| WebAir | stage | `runner_verification` | 3,000 | 162.448 | 169.161 | 163.225 | 3.012 | 162.32, 163.13, 161.82 | 0.658 | 0.41 | 1.3 |
| WebAir | stage | `workflow_start` | 3,000 | 142.576 | 149.326 | 143.318 | 2.979 | 142.42, 143.29, 141.75 | 0.771 | 0.54 | 1.7 |
| WebAir | group | `verification` | 3,000 | 161.655 | 168.440 | 162.503 | 3.561 | 161.58, 162.34, 161.09 | 0.632 | 0.39 | 1.2 |
| WebAir | group | `authorization_and_binding` | 3,000 | 3.998 | 4.204 | 4.023 | 0.102 | 4.00, 3.99, 4.00 | 0.007 | 0.17 | 0.8 |
| WebAir | group | `run_plan` | 3,000 | 6.544 | 6.922 | 6.593 | 0.185 | 6.55, 6.53, 6.55 | 0.011 | 0.16 | 0.9 |
| WebAir | group | `revalidation` | 3,000 | 316.137 | 327.324 | 317.464 | 5.358 | 315.93, 317.57, 314.67 | 1.458 | 0.46 | 1.6 |
| WebAir | total | `total_pre_execution` | 3,000 | 488.684 | 504.670 | 490.583 | 7.607 | 488.18, 490.75, 486.85 | 1.984 | 0.41 | 1.4 |

## Run-to-run variability

Coefficient of variation of the run medians (sample SD over mean): at most 0.94% over every stage, group and total (`host_revalidation_lease`, Meeting Agenda). Totals: Meeting Agenda 0.14% (run medians 59.04, 59.03, 58.89 ms); Literature Review 0.31% (run medians 449.56, 451.26, 448.49 ms); WebAir 0.41% (run medians 488.18, 490.75, 486.85 ms).

## Comparison with the reference runs

Reference: `2026-10-02T12-53-19Z_paper-run1`, `2026-10-02T13-03-41Z_paper-run2`, `2026-10-02T13-14-02Z_paper-run3` (commit `23eac90c1f6f`).

| Package | Stage | Reference median (p95) | New median (p95) | Difference | % | Reference run medians | New run medians | Ranges overlap |
|---|---|---:|---:|---:|---:|---|---|---|
| Meeting Agenda | `verification` | 18.91 (19.49) | 19.31 (20.39) | +0.40 | +2.1 | 19.01, 18.88, 18.85 | 19.32, 19.33, 19.29 | no |
| Meeting Agenda | `authorization_and_binding` | 0.89 (0.94) | 1.72 (1.82) | +0.83 | +94.0 | 0.89, 0.88, 0.88 | 1.72, 1.72, 1.72 | no |
| Meeting Agenda | `run_plan` | 1.28 (1.33) | 2.12 (2.29) | +0.84 | +66.0 | 1.28, 1.28, 1.27 | 2.13, 2.12, 2.12 | no |
| Meeting Agenda | `revalidation` | 34.96 (36.01) | 35.81 (38.13) | +0.85 | +2.4 | 35.14, 34.94, 34.82 | 35.84, 35.83, 35.74 | no |
| Meeting Agenda | `total_pre_execution` | 56.05 (57.71) | 58.99 (62.48) | +2.93 | +5.2 | 56.36, 56.01, 55.83 | 59.04, 59.03, 58.89 | no |
| Literature Review | `verification` | 148.85 (154.81) | 152.70 (160.14) | +3.86 | +2.6 | 149.61, 148.77, 147.91 | 152.53, 153.22, 152.25 | no |
| Literature Review | `authorization_and_binding` | 1.87 (1.93) | 2.73 (2.89) | +0.86 | +46.3 | 1.87, 1.87, 1.86 | 2.73, 2.73, 2.73 | no |
| Literature Review | `run_plan` | 3.05 (3.12) | 3.94 (4.20) | +0.89 | +29.2 | 3.06, 3.05, 3.04 | 3.94, 3.93, 3.94 | no |
| Literature Review | `revalidation` | 281.20 (287.81) | 289.36 (301.09) | +8.16 | +2.9 | 282.38, 280.91, 279.73 | 289.29, 290.08, 288.00 | no |
| Literature Review | `total_pre_execution` | 436.08 (444.38) | 449.89 (465.03) | +13.81 | +3.2 | 438.57, 436.18, 434.23 | 449.56, 451.26, 448.49 | no |

## Sources

See `sources.json` for every input directory's commit, script hashes and the SHA-256 of the files read.
