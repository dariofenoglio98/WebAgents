# Experiments

Controlled experiments for the WebAgents paper. Each experiment lives in its own directory with
its own README, scripts, tests and timestamped result directories. Paper RQ numbers can change, so
directory names describe what an experiment measures, not which RQ it answers.

| Directory | Question | Paper section (current draft) |
|---|---|---|
| [`contract_enforcement/`](contract_enforcement/) | How effectively does WebAgents detect and contain violations of the package-to-execution contract, and which enforcement components are responsible? | RQ1 (section not yet fixed) |
| [`contract_overhead/`](contract_overhead/) | What local latency does the package-to-execution contract add before workflow execution? | IV-B (RQ2) |

The experiments import the production code. They do not modify it. `contract_enforcement`
additionally compiles private, patched copies of the plugin and of agentpkg — one per removed
enforcement component — under its own `.cache/`, for its ablations only; nothing in the
production code paths, the CLI or the plugin configuration can select them.

Run commands from the repository root with the agentpkg virtualenv:

```sh
agentpkg/.venv/bin/python -m pytest experiments/contract_enforcement/tests
agentpkg/.venv/bin/python experiments/contract_enforcement/run.py --preset paper --jobs 6 --label paper

agentpkg/.venv/bin/python -m pytest experiments/contract_overhead/tests
agentpkg/.venv/bin/python experiments/contract_overhead/benchmark.py --label paper
agentpkg/.venv/bin/python experiments/contract_overhead/aggregate.py --out <dir> RUN1 RUN2 RUN3
```

Both experiments are offline and credential-free: every model, tool and network answer is a
recorded synthetic stand-in or a pre-generated fixture.
