# Contract-enforcement experiment

Preset `paper`, seed `20261002`, experiment 1.0.0, threat model 1.0. Catalog `bfa910cda663bef8`, calibration `a86caad12924daac`.

* 61 templates in 8 families, 716 distinct violations, 295 matched benign controls, 9 enforcement profiles.
* Executions: 9099 recorded of 9099 expected (0 missing, 0 duplicate records).

## Full system

| Metric | Value (95% Wilson CI) |
|---|---|
| Violation detection rate (explicit block) | 100.0 [99.5, 100.0]% (716/716) |
| Silent violation rate | 0.0 [0.0, 0.5]% (0/716) |
| Incidental failure rate | 0.0 [0.0, 0.5]% (0/716) |
| Benign acceptance rate | 100.0 [98.7, 100.0]% (295/295) |
| Paired contract correctness | 100.0 [99.6, 100.0]% (1011/1011) |
| Stage accuracy (explicit blocks) | 100.0 [99.5, 100.0]% |
| Harness errors | 0 violations, 0 controls |

| Family | Violations | Blocked | Incidental | Silent | VDR % [CI] | Controls | BAR % |
|---|---|---|---|---|---|---|---|
| F1 Package verification | 191 | 191 | 0 | 0 | 100.0 [98.0, 100.0] | 134 | 100.0 |
| F2 Publisher trust | 14 | 14 | 0 | 0 | 100.0 [78.5, 100.0] | 12 | 100.0 |
| F3 Authorization | 34 | 34 | 0 | 0 | 100.0 [89.8, 100.0] | 12 | 100.0 |
| F4 Requirements / compatibility | 85 | 85 | 0 | 0 | 100.0 [95.7, 100.0] | 17 | 100.0 |
| F5 Plan binding / TOCTOU | 55 | 55 | 0 | 0 | 100.0 [93.5, 100.0] | 21 | 100.0 |
| F6 Host mediation | 80 | 80 | 0 | 0 | 100.0 [95.4, 100.0] | 15 | 100.0 |
| F7 Output / state integrity | 196 | 196 | 0 | 0 | 100.0 [98.1, 100.0] | 59 | 100.0 |
| F8 Resource governance | 61 | 61 | 0 | 0 | 100.0 [94.1, 100.0] | 25 | 100.0 |

## Ablations

| Profile | VDR % [CI] | SVR % [CI] | IFR % | BAR % | False rejects |
|---|---|---|---|---|---|
| Full | 100.0 [99.5, 100.0] | 0.0 [0.0, 0.5] | 0.0 | 100.0 | 0 |
| -Verification | 86.3 [83.6, 88.6] | 13.7 [11.4, 16.4] | 0.0 | 100.0 | 0 |
| -Trust | 98.3 [97.1, 99.0] | 1.7 [1.0, 2.9] | 0.0 | 100.0 | 0 |
| -Authorization | 97.5 [96.1, 98.4] | 2.5 [1.6, 3.9] | 0.0 | 100.0 | 0 |
| -Compatibility | 97.2 [95.7, 98.2] | 2.8 [1.8, 4.3] | 0.0 | 100.0 | 0 |
| -Plan revalidation | 92.5 [90.3, 94.2] | 7.5 [5.8, 9.7] | 0.0 | 100.0 | 0 |
| -Host mediation | 92.2 [90.0, 93.9] | 7.8 [6.1, 10.0] | 0.0 | 100.0 | 0 |
| -Output validation | 77.5 [74.3, 80.4] | 22.5 [19.6, 25.7] | 0.0 | 100.0 | 0 |
| -Resource enforcement | 93.0 [90.9, 94.7] | 7.0 [5.3, 9.1] | 0.0 | 100.0 | 0 |

### Effect of each template's most relevant ablation

| Template | Ablation | Full outcomes | Ablated outcomes |
|---|---|---|---|
| F1.payload_edit_integrity | -Verification | explicit 24 | silent 24 |
| F1.payload_edit_restated | -Verification | explicit 24 | silent 24 |
| F1.payload_edit_redigested | -Verification | explicit 24 | silent 24 |
| F1.member_added | -Verification | explicit 24 | silent 24 |
| F1.member_removed | -Verification | explicit 19 | explicit 17, silent 2 |
| F1.duplicate_member | -Verification | explicit 24 | explicit 24 |
| F1.container_layout | -Verification | explicit 20 | explicit 20 |
| F1.member_name | -Verification | explicit 20 | explicit 20 |
| F1.strict_json | -Verification | explicit 12 | explicit 12 |
| F2.signer_not_pinned | -Trust | explicit 8 | silent 8 |
| F2.pin_scope_mismatch | -Trust | explicit 4 | silent 4 |
| F2.unsigned | -Verification | explicit 2 | explicit 2 |
| F3.required_permission_denied | -Authorization | explicit 5 | silent 5 |
| F3.run_mode_permission_denied | -Authorization | explicit 1 | silent 1 |
| F3.tool_approval_withheld | -Authorization | explicit 3 | silent 3 |
| F3.once_grant_exceeded | -Authorization | explicit 7 | silent 7 |
| F3.selected_file_without_permission | -Authorization | explicit 1 | silent 1 |
| F3.named_document_without_permission | -Authorization | explicit 1 | silent 1 |
| F3.receipt_binding | -Plan revalidation | explicit 6 | silent 6 |
| F3.consent_lifetime | -Plan revalidation | explicit 10 | silent 10 |
| F4.model_context_insufficient | -Compatibility | explicit 24 | explicit 21, silent 3 |
| F4.model_capability_missing | -Compatibility | explicit 4 | silent 4 |
| F4.model_not_offered | -Compatibility | explicit 10 | explicit 10 |
| F4.tool_unbound | -Compatibility | explicit 7 | explicit 7 |
| F4.tool_contract_mismatch | -Compatibility | explicit 27 | explicit 27 |
| F4.host_runtime_unverified | -Compatibility | explicit 6 | silent 6 |
| F4.runtime_too_old | -Compatibility | explicit 6 | silent 6 |
| F4.execution_profile_unsupported | -Compatibility | explicit 1 | silent 1 |
| F5.reauthorized_after_plan | -Plan revalidation | explicit 5 | explicit 3, silent 2 |
| F5.trust_withdrawn_after_plan | -Plan revalidation | explicit 6 | silent 6 |
| F5.model_changed_after_plan | -Plan revalidation | explicit 10 | silent 10 |
| F5.tool_binding_changed_after_plan | -Plan revalidation | explicit 16 | explicit 6, silent 10 |
| F5.snapshot_rewritten | -Plan revalidation | explicit 6 | explicit 4, silent 2 |
| F5.lease_rewritten | -Plan revalidation | explicit 6 | explicit 4, silent 2 |
| F5.stale_plan_reference | -Plan revalidation | explicit 6 | silent 6 |
| F6.provider_substitutes_model | -Host mediation | explicit 24 | silent 24 |
| F6.tool_argument_smuggling | -Host mediation | explicit 12 | silent 12 |
| F6.file_capability_forgery | -Host mediation | explicit 6 | explicit 6 |
| F6.file_path_from_model | -Output validation | explicit 2 | explicit 2 |
| F6.undeclared_capability | -Host mediation | explicit 14 | explicit 14 |
| F6.reserved_export_name | -Host mediation | explicit 8 | silent 8 |
| F6.destination_redirect | -Compatibility | explicit 2 | explicit 2 |
| F6.nonpublic_destination | -Host mediation | explicit 12 | silent 12 |
| F7.model_output_schema | -Output validation | explicit 122 | explicit 4, silent 118 |
| F7.model_output_unparseable | -Output validation | explicit 24 | explicit 24 |
| F7.model_turn_unfinished | -Output validation | explicit 16 | silent 16 |
| F7.evidence_relation | -Output validation | explicit 10 | silent 10 |
| F7.review_relation | -Output validation | explicit 6 | explicit 3, silent 3 |
| F7.resolver_response | -Output validation | explicit 6 | explicit 1, silent 5 |
| F7.resolver_identity | -Output validation | explicit 3 | silent 3 |
| F7.search_response | -Output validation | explicit 5 | explicit 3, silent 2 |
| F7.reader_response | -Output validation | explicit 4 | silent 4 |
| F8.token_budget | -Resource enforcement | explicit 8 | silent 8 |
| F8.worker_token_budget | -Resource enforcement | explicit 4 | silent 4 |
| F8.remote_call_budget | -Resource enforcement | explicit 5 | silent 5 |
| F8.tool_call_budget | -Resource enforcement | explicit 2 | silent 2 |
| F8.fanout_bound | -Resource enforcement | explicit 5 | silent 5 |
| F8.output_cap_ceiling | -Resource enforcement | explicit 6 | silent 6 |
| F8.usage_accounting | -Resource enforcement | explicit 16 | explicit 10, silent 6 |
| F8.deadline | -Resource enforcement | explicit 9 | explicit 1, silent 8 |
| F8.input_size | -Resource enforcement | explicit 6 | silent 6 |

## Unexpected outcomes

* `full_not_explicitly_blocked`: 0
* `full_stage_mismatch`: 0
* `controls_not_accepted`: 0
* `harness_errors`: 0
* `ablation_silent_violations`: 469
* `missing_executions`: 0
* `duplicate_records`: 0

See `unexpected_cases.json` for each one, with its evidence.

## Paper-ready interpretation

1. **Templates.** 61 violation templates in 8 families.
2. **Distinct violations.** 716.
3. **Matched benign controls.** 295.
4. **Full system.** VDR 100.0 [99.5, 100.0]% (716/716), BAR 100.0 [98.7, 100.0]% (295/295), SVR 0.0 [0.0, 0.5]% (0/716); paired contract correctness 100.0 [99.6, 100.0]%.
5. **Where violations were blocked.** verify (213), execute/model (188), revalidate (86), compatibility (75), resource (55), execute/tool (46), validate (19), authorize (16), trust (12), prepare (6); 100.0% of explicit blocks happened at the stage the catalog predicted before the run.
6. **Largest reductions in protection.** -Output validation: VDR 77.5% (-22.5 pp vs full), SVR 22.5%; -Verification: VDR 86.3% (-13.7 pp vs full), SVR 13.7%; -Host mediation: VDR 92.2% (-7.8 pp vs full), SVR 7.8%.
7. **Defense in depth.** Violations still explicitly blocked under their own most relevant ablation: F1.member_removed (17/19 under -Verification), F2.unsigned (2/2 under -Verification), F4.model_context_insufficient (21/24 under -Compatibility), F4.model_not_offered (10/10 under -Compatibility), F4.tool_unbound (7/7 under -Compatibility), F4.tool_contract_mismatch (27/27 under -Compatibility), F5.reauthorized_after_plan (3/5 under -Plan revalidation), F5.tool_binding_changed_after_plan (6/16 under -Plan revalidation), F5.snapshot_rewritten (4/6 under -Plan revalidation), F5.lease_rewritten (4/6 under -Plan revalidation), F6.file_capability_forgery (6/6 under -Host mediation), F6.file_path_from_model (2/2 under -Output validation), F6.destination_redirect (2/2 under -Compatibility), F7.model_output_schema (4/122 under -Output validation), F7.review_relation (3/6 under -Output validation), F7.resolver_response (1/6 under -Output validation), F7.search_response (3/5 under -Output validation), F8.usage_accounting (10/16 under -Resource enforcement), F8.deadline (1/9 under -Resource enforcement). Guards no profile removes by design (container parsing, static workflow validation, JSON parsing): F1.duplicate_member, F1.container_layout, F1.member_name, F1.strict_json, F6.undeclared_capability, F7.model_output_unparseable.
8. **Incidental failures.** 0 full-system violations stopped without an explicit contract refusal.
9. **Full-system silent violations.** 0.

Finite claim: in this controlled suite, WebAgents explicitly blocked 716 of the 716 injected violations and accepted 295 of the 295 matched benign controls. This is not a measure of security against an arbitrary attacker, of model reasoning quality, or of behaviour on other hosts.
