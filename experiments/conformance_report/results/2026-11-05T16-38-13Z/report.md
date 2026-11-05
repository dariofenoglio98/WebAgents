# Conformance report (E8, Tab. 10)

Every number below is computed by `experiments/conformance_report/report.py` from the files it names.

- Conformance run: `conformance/results/2026-11-05T16-38-00-950Z`
- Divergence log: `docs/conformance-divergences.md`
- Commit `08e2c859697ddcb09edeae7b4ce66e0773b47678` (dirty: False); agentpkg 0.7.1 (agent.pkg 0.1, workflow.v0); chrome-agent-browser 0.5.0 (runtime 0.7.0); Python 3.13.5; Node v26.9.0; darwin-arm64.

## Cases per family

| Family | Cases | Agreed | Documented differences | Kinds |
|---|---:|---:|---:|---|
| Agent Compute | 41 | 39 | 2 | documented difference 2, fixture parity 3, refusal 36 |
| Agent Conversations | 42 | 41 | 1 | conversation parity 16, documented difference 1, refusal 25 |
| Agent Delegation | 49 | 47 | 2 | documented difference 2, execution-layer parity 2, fixture parity 6, refusal 39 |
| Agent Memory | 28 | 28 | 0 | fixture parity 4, refusal 24 |
| Authorization and execution | 9 | 6 | 3 | documented difference 3, fixture parity 1, refusal 5 |
| Control plane | 5 | 4 | 1 | control-plane parity 1, documented difference 1, refusal 3 |
| Package format and trust | 4 | 4 | 0 | refusal 4 |
| Shipped packages (fixture parity) | 46 | 46 | 0 | conversation parity 9, fixture parity 37 |
| **All** | 224 | 215 | 9 | |

The suite: 224/224 cases and 2604/2604 checks passed; a documented difference passes when each runtime matches its own documented behaviour (D-063, D-090). Disagreeing cases that are not documented differences: 0.

## The divergence log (`docs/conformance-divergences.md`)

| Class | fixed | documented | total |
|---|---:|---:|---:|
| behaviour | 21 | 9 | 30 |
| wording | 5 | 2 | 7 |
| timing | 1 | 6 | 7 |
| platform | 13 | 10 | 23 |
| **all** | 40 | 27 | 67 |

| Found by | fixed | documented | total |
|---|---:|---:|---:|
| suite | 6 | 9 | 15 |
| test | 2 | 10 | 12 |
| review | 32 | 6 | 38 |
| live | 0 | 2 | 2 |

| Runtime that differed | fixed | documented | total |
|---|---:|---:|---:|
| Cr (Chrome core) | 31 | 11 | 42 |
| Py (Python reference) | 6 | 2 | 8 |
| both / neither alone | 3 | 14 | 17 |

| Task (first named) | fixed | documented | total |
|---|---:|---:|---:|
| T1 | 12 | 2 | 14 |
| T2 | 1 | 0 | 1 |
| T3 | 3 | 3 | 6 |
| T4 | 4 | 5 | 9 |
| T5 | 0 | 1 | 1 |
| T6 | 0 | 3 | 3 |
| T7 | 5 | 4 | 9 |
| T18 | 1 | 0 | 1 |
| T19 | 1 | 0 | 1 |
| T20 | 6 | 1 | 7 |
| T21 | 1 | 7 | 8 |
| T23 | 1 | 0 | 1 |
| T24 | 4 | 0 | 4 |
| T25 | 1 | 0 | 1 |
| T26 | 0 | 1 | 1 |

## P-19's reviewable path

- `scripts/check_extension_privileges.py`: passed True (manifest sha256 `81241916a7ed890d7d4c21165cde5503818dffa2940c442e0ad507baf7282c42`); `privileges.json` here.
- `npm run check-pack`: passed True; `check-pack.json` here.

**Passed: True.**
