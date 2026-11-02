# Contract enforcement, catalog v2 (E1)

Catalog v2 asks of the agent VM what v1 asked of the paper's prototype: when a package, a model or a
host input tries to cross a forbidden boundary, does the runtime stop it, and which mechanism does?
It covers the four freedoms the CIC 2026 prototype did not have (memory confinement, compute
isolation, consent integrity, delegation bounds) on **both runtimes** (the Python reference,
`agentpkg`, and the Chrome core, `chrome-agent-browser/src/core`), under the full system and nine
single-mechanism removals. It is a test oracle for the enforcement claims, not an attack benchmark.

The design, the family table, the profiles, the seams and the qualification corrections are in
[`DESIGN_v2.md`](DESIGN_v2.md). Nothing under v1 (`../cases/`, `../harness/`, `../run.py`,
`../analyze.py`, `../tests/`, `../results/`) is changed; v2 imports v1's exact-match patch machinery
and its offline guard.

## Running

```sh
python3.13 -m venv agentpkg/.venv && agentpkg/.venv/bin/python -m pip install -e './agentpkg[dev,compute]'
(cd chrome-agent-browser && npm ci)

# A few cases per family, the full system and each family's primary ablation (~1 min with builds)
agentpkg/.venv/bin/python experiments/contract_enforcement/catalog_v2/run_v2.py --preset smoke
# Every case, ten profiles, both runtimes
agentpkg/.venv/bin/python experiments/contract_enforcement/catalog_v2/run_v2.py --preset qualification --jobs 6
# The paper's run: as qualification, six values per parametric template (machine idle)
agentpkg/.venv/bin/python experiments/contract_enforcement/catalog_v2/run_v2.py --preset paper --jobs 6

# The table of any results directory
agentpkg/.venv/bin/python experiments/contract_enforcement/catalog_v2/analyze_v2.py \
    experiments/contract_enforcement/catalog_v2/results/<UTC>_v2-paper

# Tests (own pytest process, as the other experiment suites)
agentpkg/.venv/bin/python -m pytest experiments/contract_enforcement/catalog_v2/tests
```

Everything is local, offline and credential-free: every case replays its probe's own fixture; the
workers refuse sockets, name lookups and child processes. The first run builds the private copies
of both runtimes under `catalog_v2/.cache/` (git-ignored, content-addressed, reused).

## What a results directory holds

| File | Contents |
|---|---|
| `manifest.json` | written before the first case: commit and dirty fingerprint, seed, preset, profiles with their sites, the build key, private-copy hash and patch-diff hash of every (runtime, profile), the production trees' hashes, the catalog hash, the expected executions |
| `catalog.json` | every case as declared (expectation, boundary, guard, primary ablation, matched control), with its archive's SHA-256 |
| `patches/<profile>/{py,ts}.diff` | the exact diff of each private copy |
| `raw/<runtime>-<profile>.jsonl` | one line per execution: the oracle's verdict and the driver's record (seams, refusal, result, audit, exports) |
| `run.json` | wall time, executions, the production trees' hashes after the run (`production_untouched`) |
| `summary.json`, `table.md`, `table.csv` | `analyze_v2.py`'s output: family × profile × runtime, VDR, SVR, IFR, BAR with 95 % Wilson intervals, the effect-only rates, the exposure of each ablated profile |
| `unexpected.json` | full-profile silent violations, false rejects, incidental failures, unexpected codes; harness errors anywhere |
| `findings.md` | written by hand when anything is unexpected (D-304) |

The paper reads these files by path; no number is copied by hand (CLAUDE.md rule 8).
