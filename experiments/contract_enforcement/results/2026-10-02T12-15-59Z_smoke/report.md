# Contract-enforcement experiment

Preset `smoke`, seed `20261002`, experiment 1.0.0, threat model 1.0. Catalog `2a93d0e768ba011a`, calibration `a86caad12924daac`.

* 61 templates in 8 families, 100 distinct violations, 100 matched benign controls, 1 enforcement profiles.
* Executions: 200 recorded of 200 expected (0 missing, 0 duplicate records).

## Full system

| Metric | Value (95% Wilson CI) |
|---|---|
| Violation detection rate (explicit block) | 100.0 [96.3, 100.0]% (100/100) |
| Silent violation rate | 0.0 [0.0, 3.7]% (0/100) |
| Incidental failure rate | 0.0 [0.0, 3.7]% (0/100) |
| Benign acceptance rate | 100.0 [96.3, 100.0]% (100/100) |
| Paired contract correctness | 100.0 [98.1, 100.0]% (200/200) |
| Stage accuracy (explicit blocks) | 100.0 [96.3, 100.0]% |
| Harness errors | 0 violations, 0 controls |

| Family | Violations | Blocked | Incidental | Silent | VDR % [CI] | Controls | BAR % |
|---|---|---|---|---|---|---|---|
| F1 Package verification | 18 | 18 | 0 | 0 | 100.0 [82.4, 100.0] | 18 | 100.0 |
| F2 Publisher trust | 6 | 6 | 0 | 0 | 100.0 [61.0, 100.0] | 6 | 100.0 |
| F3 Authorization | 12 | 12 | 0 | 0 | 100.0 [75.8, 100.0] | 12 | 100.0 |
| F4 Requirements / compatibility | 13 | 13 | 0 | 0 | 100.0 [77.2, 100.0] | 13 | 100.0 |
| F5 Plan binding / TOCTOU | 13 | 13 | 0 | 0 | 100.0 [77.2, 100.0] | 13 | 100.0 |
| F6 Host mediation | 11 | 11 | 0 | 0 | 100.0 [74.1, 100.0] | 11 | 100.0 |
| F7 Output / state integrity | 12 | 12 | 0 | 0 | 100.0 [75.8, 100.0] | 12 | 100.0 |
| F8 Resource governance | 15 | 15 | 0 | 0 | 100.0 [79.6, 100.0] | 15 | 100.0 |

## Ablations

| Profile | VDR % [CI] | SVR % [CI] | IFR % | BAR % | False rejects |
|---|---|---|---|---|---|
| Full | 100.0 [96.3, 100.0] | 0.0 [0.0, 3.7] | 0.0 | 100.0 | 0 |

### Effect of each template's most relevant ablation

| Template | Ablation | Full outcomes | Ablated outcomes |
|---|---|---|---|

## Unexpected outcomes

* `full_not_explicitly_blocked`: 0
* `full_stage_mismatch`: 0
* `controls_not_accepted`: 0
* `harness_errors`: 0
* `ablation_silent_violations`: 0
* `missing_executions`: 0
* `duplicate_records`: 0

See `unexpected_cases.json` for each one, with its evidence.

## Paper-ready interpretation

1. **Templates.** 61 violation templates in 8 families.
2. **Distinct violations.** 100.
3. **Matched benign controls.** 100.
4. **Full system.** VDR 100.0 [96.3, 100.0]% (100/100), BAR 100.0 [96.3, 100.0]% (100/100), SVR 0.0 [0.0, 3.7]% (0/100); paired contract correctness 100.0 [98.1, 100.0]%.
5. **Where violations were blocked.** verify (24), revalidate (22), resource (13), compatibility (10), execute/model (9), execute/tool (7), authorize (6), trust (4), validate (3), prepare (2); 100.0% of explicit blocks happened at the stage the catalog predicted before the run.
6. **Largest reductions in protection.** no ablation profile was run.
7. **Defense in depth.** No template stayed blocked under its own most relevant ablation through another layer.
8. **Incidental failures.** 0 full-system violations stopped without an explicit contract refusal.
9. **Full-system silent violations.** 0.

Finite claim: in this controlled suite, WebAgents explicitly blocked 100 of the 100 injected violations and accepted 100 of the 100 matched benign controls. This is not a measure of security against an arbitrary attacker, of model reasoning quality, or of behaviour on other hosts.
