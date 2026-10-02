# Contract enforcement

How effectively does WebAgents detect and contain violations of the package-to-execution
contract, and which enforcement components are responsible?

This experiment injects controlled, distinct violations of the guarantees the implementation
makes — derived from the production code, not from a generic attack list — into otherwise
benign runs of the two reference packages (Meeting Agenda 0.2.2 and Literature Review 0.2.5),
pairs every violation with a matched benign control, and runs both through the real production
path: the Agent Browser plugin compiled from its own sources and `agentpkg` from `agentpkg/src`.
It then repeats the whole catalog with one enforcement component removed at a time.

* [`THREAT_MODEL.md`](THREAT_MODEL.md) — scope, adversary capabilities, trusted computing base,
  what is real and what is simulated, what is out of scope.
* [`DESIGN.md`](DESIGN.md) — the enforcement map (guarantee → production check → refusal →
  stage → forbidden state → template → ablation), the oracle, the metrics, the ablations, and
  the documented deviations.

Everything runs offline and needs no credential. No live model, Ollama, OpenAI, Crossref,
Citation Resolver or PDF service is contacted; each worker refuses sockets, DNS, child processes
and canary-file opens, in Python and in the Node host, and records any attempt.

## Run

From the repository root, with the agentpkg virtualenv (Node is needed to compile and host the
plugin; the first run compiles nine plugin builds into `.cache/`, about a minute):

```sh
agentpkg/.venv/bin/python -m pytest experiments/contract_enforcement/tests
agentpkg/.venv/bin/python experiments/contract_enforcement/run.py --preset smoke
agentpkg/.venv/bin/python experiments/contract_enforcement/run.py --preset qualification --jobs 6
agentpkg/.venv/bin/python experiments/contract_enforcement/run.py --preset paper --jobs 6 --label paper
```

An interrupted run is completed, never restarted:

```sh
agentpkg/.venv/bin/python experiments/contract_enforcement/run.py --resume experiments/contract_enforcement/results/<dir> --jobs 6
```

`--resume` re-derives the builds, the calibration and the catalog and refuses to continue if
any of them (or the experiment version, seed, preset or profiles) changed; it then executes only
the (profile, case) pairs without a record. `analyze.py <dir>` re-derives every summary from the
raw records at any time.

| Preset | Variants | Profiles | Size (default seed) | Wall time, `--jobs 6` |
|---|---|---|---|---|
| `smoke` | 1 per template and package | full | 100 violations, 100 controls: 200 runs | ~1 min |
| `qualification` | up to 3 per template and package | all 9 | 276 violations, 163 controls: 3,951 runs | ~7 min |
| `paper` | every finite variant; 12 per parametric template and package (schema mutations: 12 per model task) | all 9 | 716 violations, 295 controls: 9,099 runs | ~15 min (estimated) |

All 61 templates in all 8 families run in every preset. The exact counts of a run are printed
before execution and recorded in `config.json` (`counts`, `expected_executions`) and in the
frozen `paper_manifest.json`. Times were measured on a 14-core laptop.

## Outputs

Each run writes a new timestamped directory under `results/` (never overwriting one):

| File | Contents |
|---|---|
| `command.txt`, `config.json`, `metadata.json` | the command; seed, preset, profiles, build keys, calibration and catalog hashes; git state, dirty-tree fingerprint, package identities (id, version, archive SHA-256, digest, signer fingerprint, workflow metadata), tool versions |
| `calibration.json` | the benign run's answers and usage, from which answer-level cases are derived |
| `case_catalog.json`, `case_catalog.csv` | every violation and control, with its expected component, stage, codes and forbidden boundary — written before any case runs |
| `patches/*.diff` | the exact source changes of each ablation |
| `raw/<profile>-<shard>.jsonl` | the append-only records, one fsync'd line per case |
| `raw_results.jsonl`, `raw_results.csv` | the merged records |
| `summary.json`, `summary.csv`, `family_summary.csv`, `template_summary.csv` | VDR, SVR, IFR, BAR and paired contract correctness with 95% Wilson intervals; stage, component and code accuracy |
| `ablation_matrix.csv`, `template_ablation_matrix.csv`, `stage_summary.csv` | VDR / SVR / IFR per family and profile (the central ablation result); outcome counts per template and profile; expected versus observed stage |
| `unexpected_cases.json` | every outcome that is not the expected one, with its evidence |
| `report.md` | the summary, ablation effects, unexpected outcomes and a "Paper-ready interpretation" |
| `paper_main_table.tex`, `paper_ablation_table.tex`, `paper_case_table.tex`, `ablation_heatmap.svg` | family × VDR/BAR/SVR; family × profile VDR matrix and component summary; family / perturbation / primary guard; a dependency-free SVG heatmap (the CSVs remain the plotting source) |
| `paper_manifest.json` | the frozen experiment definition, written before the first case runs; its SHA-256 is in `config.json` and is verified by `--resume` and by the analysis |

## Reading the outcomes

| Outcome | Meaning |
|---|---|
| `EXPLICIT_BLOCK` | the forbidden state was not reached and a deliberate contract refusal stopped the run |
| `INCIDENTAL_FAILURE` | the forbidden state was not reached, but no contract layer said why the run stopped |
| `SILENT_VIOLATION` | the forbidden state was reached |
| `BENIGN_ACCEPT` / `FALSE_REJECT` | a matched control completed / was refused |
| `HARNESS_ERROR` | the experiment itself failed, or the violation was not injected or not observable; never counted as detection, and a paper run must have none |

A full-system `SILENT_VIOLATION` within the threat model is a product defect. It is reproduced,
kept with its evidence and reported; production code is not changed to make the experiment pass.
