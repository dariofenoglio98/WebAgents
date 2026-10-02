# Experiments

Controlled experiments for the WebAgents paper. Each experiment lives in its own directory with
its own README, scripts, tests and timestamped result directories. Paper RQ numbers can change, so
directory names describe what an experiment measures, not which RQ it answers.

| Directory | Question | Paper section (current draft) |
|---|---|---|
| [`contract_overhead/`](contract_overhead/) | What local latency does the package-to-execution contract add before workflow execution? | IV-B (RQ2) |

The experiments import the production code. They do not modify it.

Run commands from the repository root with the agentpkg virtualenv:

```sh
agentpkg/.venv/bin/python -m pytest experiments/contract_overhead/tests
agentpkg/.venv/bin/python experiments/contract_overhead/benchmark.py --label paper
```
