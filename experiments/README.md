# Experiments

Controlled experiments for the WebAgents paper. Each experiment lives in its own directory with
its own README, scripts, tests and timestamped result directories. Paper RQ numbers can change, so
directory names describe what an experiment measures, not which RQ it answers.

| Directory | Question | Paper (current draft) | Results the paper reports |
|---|---|---|---|
| [`contract_enforcement/`](contract_enforcement/) | How effectively does WebAgents detect and contain violations of the package-to-execution contract, and which enforcement components are responsible? | RQ1, Section V-B, Table II | `results/2026-10-02T12-38-15Z_paper_paper` (commit `23eac90`) |
| [`contract_enforcement/catalog_v2/`](contract_enforcement/catalog_v2/) | Catalog v2 (E1): does the agent VM stop a violation of each of its four freedoms (memory confinement, compute isolation, consent integrity, delegation bounds) on both runtimes, and which mechanism does (the full system and nine single-mechanism removals)? | the mechanism paper (USENIX Security '27 draft), E1 | `catalog_v2/results/2026-11-02T04-55-19Z_v2-paper` (commit `4d7126b`) |
| [`campaigns/`](campaigns/) | Shared infrastructure of the live campaigns (T31, `PROTOCOL.md` §2): task sets with ground truth, the campaign record set and its canaries, the injection-capable WebAir origin and payload catalog, the live drivers of our two runtimes (`Py`, `Cr`) and of the framework baseline (`FW`: the OpenAI Agents SDK with Progent's released code), the one oracle, the campaign driver | the mechanism paper, E2 and E3 onwards | none (infrastructure) |
| [`injection_campaign/`](injection_campaign/) | E2 (the framework baseline on the benign task sets) and E3 (the injection campaign): `results/<UTC>_<preset>/` written by `campaigns/driver/campaign.py` | the mechanism paper, E2, E3 | none yet: the smoke directory checks the infrastructure and is not a measurement |
| [`contract_overhead/`](contract_overhead/) | What local latency does the package-to-execution contract add before workflow execution? | RQ2, Section V-C, Tables III and IV | `results/2026-10-03T16-14-20Z_paper-webair-pooled`, pooled from `results/2026-10-03T*_paper-webair-run{1,2,3}` (commit `9d78ca5`) |
| [`contract_overhead/`](contract_overhead/DESIGN_v2.md) (v2) | Overhead v2 (E7): what does the contract cost before execution on both runtimes (Meeting Agenda 0.2.2, Literature Review 0.2.9, WebAir 0.8.0, the Travel Network 0.1.0), and per operation at run time (the egress scans, a compute call, the delegation analysis and transition check, the consent gate)? | the mechanism paper, E7, Tab. 9 | `results/2026-11-05T12-40-00Z_v2-pooled`, pooled from `results/2026-11-05T*_v2-run{1,2,3}` (commit `8334b4c`; never pooled with v1, D-019) |
| [`conformance_report/`](conformance_report/) | The conformance report and the divergence log (E8): how many cases do the two runtimes agree on at the final commit, which differences are documented, and what did the suite and the reviews find and fix? | the mechanism paper, E8, Tab. 10 | `conformance_report/results/2026-11-05T16-38-13Z` over `conformance/results/2026-11-05T16-38-00-950Z` (224/224 at commit `08e2c85`; families by case head, D-307). Superseded and kept: `2026-11-04T06-16-52Z` over `2026-11-04T06-16-31-904Z` (at `3451306`, its last family a catch-all) |

The experiments import the production code. They do not modify it. Catalog v2 likewise builds private, patched copies of agentpkg and of the Chrome core per removed mechanism under `contract_enforcement/catalog_v2/.cache/`. `contract_enforcement`
additionally compiles private, patched copies of the plugin and of agentpkg — one per removed
enforcement component — under its own `.cache/`, for its ablations only; nothing in the
production code paths, the CLI or the plugin configuration can select them.

Run commands from the repository root with the agentpkg virtualenv:

```sh
agentpkg/.venv/bin/python -m pytest experiments/contract_enforcement/tests
agentpkg/.venv/bin/python experiments/contract_enforcement/run.py --preset paper --jobs 6 --label paper

agentpkg/.venv/bin/python -m pytest experiments/contract_enforcement/catalog_v2/tests
agentpkg/.venv/bin/python experiments/contract_enforcement/catalog_v2/run_v2.py --preset paper --jobs 6

agentpkg/.venv/bin/python -m pytest experiments/contract_overhead/tests
agentpkg/.venv/bin/python -m pytest experiments/campaigns/tests
agentpkg/.venv/bin/python experiments/contract_overhead/benchmark.py --label paper
agentpkg/.venv/bin/python experiments/contract_overhead/aggregate.py --out <dir> RUN1 RUN2 RUN3
agentpkg/.venv/bin/python experiments/contract_overhead/benchmark_v2.py --label v2-run1
agentpkg/.venv/bin/python experiments/contract_overhead/aggregate_v2.py pool --out <dir> RUN1 RUN2 RUN3

agentpkg/.venv/bin/python -m pytest experiments/conformance_report/tests
```

The contract experiments are offline and credential-free: every model, tool and network answer is
a recorded synthetic stand-in or a pre-generated fixture. The campaigns (`campaigns/`,
`injection_campaign/`) are **live**: real models on the rungs of `PROTOCOL.md` §2.2 against the
campaign origin on `127.0.0.1`; their test suite is offline and credential-free (`campaigns/README.md`).
