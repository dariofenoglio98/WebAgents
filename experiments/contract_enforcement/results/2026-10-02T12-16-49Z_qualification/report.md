# Contract-enforcement experiment

Preset `qualification`, seed `20261002`, experiment 1.0.0, threat model 1.0. Catalog `5487fd5c40b26934`, calibration `a86caad12924daac`.

* 61 templates in 8 families, 276 distinct violations, 163 matched benign controls, 9 enforcement profiles.
* Executions: 3951 recorded of 3951 expected (0 missing, 0 duplicate records).

## Full system

| Metric | Value (95% Wilson CI) |
|---|---|
| Violation detection rate (explicit block) | 100.0 [98.6, 100.0]% (276/276) |
| Silent violation rate | 0.0 [0.0, 1.4]% (0/276) |
| Incidental failure rate | 0.0 [0.0, 1.4]% (0/276) |
| Benign acceptance rate | 100.0 [97.7, 100.0]% (163/163) |
| Paired contract correctness | 100.0 [99.1, 100.0]% (439/439) |
| Stage accuracy (explicit blocks) | 100.0 [98.6, 100.0]% |
| Harness errors | 0 violations, 0 controls |

| Family | Violations | Blocked | Incidental | Silent | VDR % [CI] | Controls | BAR % |
|---|---|---|---|---|---|---|---|
| F1 Package verification | 54 | 54 | 0 | 0 | 100.0 [93.4, 100.0] | 42 | 100.0 |
| F2 Publisher trust | 12 | 12 | 0 | 0 | 100.0 [75.8, 100.0] | 10 | 100.0 |
| F3 Authorization | 28 | 28 | 0 | 0 | 100.0 [87.9, 100.0] | 12 | 100.0 |
| F4 Requirements / compatibility | 35 | 35 | 0 | 0 | 100.0 [90.1, 100.0] | 17 | 100.0 |
| F5 Plan binding / TOCTOU | 38 | 38 | 0 | 0 | 100.0 [90.8, 100.0] | 19 | 100.0 |
| F6 Host mediation | 31 | 31 | 0 | 0 | 100.0 [89.0, 100.0] | 13 | 100.0 |
| F7 Output / state integrity | 36 | 36 | 0 | 0 | 100.0 [90.4, 100.0] | 28 | 100.0 |
| F8 Resource governance | 42 | 42 | 0 | 0 | 100.0 [91.6, 100.0] | 22 | 100.0 |

## Ablations

| Profile | VDR % [CI] | SVR % [CI] | IFR % | BAR % | False rejects |
|---|---|---|---|---|---|
| Full | 100.0 [98.6, 100.0] | 0.0 [0.0, 1.4] | 0.0 | 100.0 | 0 |
| -Verification | 90.9 [87.0, 93.8] | 9.1 [6.2, 13.0] | 0.0 | 100.0 | 0 |
| -Trust | 96.4 [93.5, 98.0] | 3.6 [2.0, 6.5] | 0.0 | 100.0 | 0 |
| -Authorization | 94.2 [90.8, 96.4] | 5.8 [3.6, 9.2] | 0.0 | 100.0 | 0 |
| -Compatibility | 93.1 [89.5, 95.5] | 6.9 [4.5, 10.5] | 0.0 | 100.0 | 0 |
| -Plan revalidation | 86.2 [81.7, 89.8] | 13.8 [10.2, 18.3] | 0.0 | 100.0 | 0 |
| -Host mediation | 93.5 [89.9, 95.8] | 6.5 [4.2, 10.1] | 0.0 | 100.0 | 0 |
| -Output validation | 90.2 [86.1, 93.2] | 9.8 [6.8, 13.9] | 0.0 | 100.0 | 0 |
| -Resource enforcement | 86.2 [81.7, 89.8] | 13.8 [10.2, 18.3] | 0.0 | 100.0 | 0 |

### Effect of each template's most relevant ablation

| Template | Ablation | Full outcomes | Ablated outcomes |
|---|---|---|---|
| F1.payload_edit_integrity | -Verification | explicit 6 | silent 6 |
| F1.payload_edit_restated | -Verification | explicit 6 | silent 6 |
| F1.payload_edit_redigested | -Verification | explicit 6 | silent 6 |
| F1.member_added | -Verification | explicit 6 | silent 6 |
| F1.member_removed | -Verification | explicit 6 | explicit 5, silent 1 |
| F1.duplicate_member | -Verification | explicit 6 | explicit 6 |
| F1.container_layout | -Verification | explicit 6 | explicit 6 |
| F1.member_name | -Verification | explicit 6 | explicit 6 |
| F1.strict_json | -Verification | explicit 6 | explicit 6 |
| F2.signer_not_pinned | -Trust | explicit 6 | silent 6 |
| F2.pin_scope_mismatch | -Trust | explicit 4 | silent 4 |
| F2.unsigned | -Verification | explicit 2 | explicit 2 |
| F3.required_permission_denied | -Authorization | explicit 5 | silent 5 |
| F3.run_mode_permission_denied | -Authorization | explicit 1 | silent 1 |
| F3.tool_approval_withheld | -Authorization | explicit 3 | silent 3 |
| F3.once_grant_exceeded | -Authorization | explicit 5 | silent 5 |
| F3.selected_file_without_permission | -Authorization | explicit 1 | silent 1 |
| F3.named_document_without_permission | -Authorization | explicit 1 | silent 1 |
| F3.receipt_binding | -Plan revalidation | explicit 6 | silent 6 |
| F3.consent_lifetime | -Plan revalidation | explicit 6 | silent 6 |
| F4.model_context_insufficient | -Compatibility | explicit 6 | explicit 4, silent 2 |
| F4.model_capability_missing | -Compatibility | explicit 4 | silent 4 |
| F4.model_not_offered | -Compatibility | explicit 6 | explicit 6 |
| F4.tool_unbound | -Compatibility | explicit 3 | explicit 3 |
| F4.tool_contract_mismatch | -Compatibility | explicit 3 | explicit 3 |
| F4.host_runtime_unverified | -Compatibility | explicit 6 | silent 6 |
| F4.runtime_too_old | -Compatibility | explicit 6 | silent 6 |
| F4.execution_profile_unsupported | -Compatibility | explicit 1 | silent 1 |
| F5.reauthorized_after_plan | -Plan revalidation | explicit 5 | explicit 3, silent 2 |
| F5.trust_withdrawn_after_plan | -Plan revalidation | explicit 6 | silent 6 |
| F5.model_changed_after_plan | -Plan revalidation | explicit 6 | silent 6 |
| F5.tool_binding_changed_after_plan | -Plan revalidation | explicit 3 | explicit 1, silent 2 |
| F5.snapshot_rewritten | -Plan revalidation | explicit 6 | explicit 4, silent 2 |
| F5.lease_rewritten | -Plan revalidation | explicit 6 | explicit 4, silent 2 |
| F5.stale_plan_reference | -Plan revalidation | explicit 6 | silent 6 |
| F6.provider_substitutes_model | -Host mediation | explicit 6 | silent 6 |
| F6.tool_argument_smuggling | -Host mediation | explicit 3 | silent 3 |
| F6.file_capability_forgery | -Host mediation | explicit 3 | explicit 3 |
| F6.file_path_from_model | -Output validation | explicit 2 | explicit 2 |
| F6.undeclared_capability | -Host mediation | explicit 6 | explicit 6 |
| F6.reserved_export_name | -Host mediation | explicit 6 | silent 6 |
| F6.destination_redirect | -Compatibility | explicit 2 | explicit 2 |
| F6.nonpublic_destination | -Host mediation | explicit 3 | silent 3 |
| F7.model_output_schema | -Output validation | explicit 6 | silent 6 |
| F7.model_output_unparseable | -Output validation | explicit 6 | explicit 6 |
| F7.model_turn_unfinished | -Output validation | explicit 6 | silent 6 |
| F7.evidence_relation | -Output validation | explicit 3 | silent 3 |
| F7.review_relation | -Output validation | explicit 3 | explicit 1, silent 2 |
| F7.resolver_response | -Output validation | explicit 3 | silent 3 |
| F7.resolver_identity | -Output validation | explicit 3 | silent 3 |
| F7.search_response | -Output validation | explicit 3 | explicit 2, silent 1 |
| F7.reader_response | -Output validation | explicit 3 | silent 3 |
| F8.token_budget | -Resource enforcement | explicit 6 | silent 6 |
| F8.worker_token_budget | -Resource enforcement | explicit 4 | silent 4 |
| F8.remote_call_budget | -Resource enforcement | explicit 3 | silent 3 |
| F8.tool_call_budget | -Resource enforcement | explicit 2 | silent 2 |
| F8.fanout_bound | -Resource enforcement | explicit 3 | silent 3 |
| F8.output_cap_ceiling | -Resource enforcement | explicit 6 | silent 6 |
| F8.usage_accounting | -Resource enforcement | explicit 6 | explicit 4, silent 2 |
| F8.deadline | -Resource enforcement | explicit 6 | silent 6 |
| F8.input_size | -Resource enforcement | explicit 6 | silent 6 |

## Unexpected outcomes

* `full_not_explicitly_blocked`: 0
* `full_stage_mismatch`: 0
* `controls_not_accepted`: 0
* `harness_errors`: 0
* `ablation_silent_violations`: 191
* `missing_executions`: 0
* `duplicate_records`: 0

See `unexpected_cases.json` for each one, with its evidence.

## Paper-ready interpretation

1. **Templates.** 61 violation templates in 8 families.
2. **Distinct violations.** 276.
3. **Matched benign controls.** 163.
4. **Full system.** VDR 100.0 [98.6, 100.0]% (276/276), BAR 100.0 [97.7, 100.0]% (163/163), SVR 0.0 [0.0, 1.4]% (0/276); paired contract correctness 100.0 [99.1, 100.0]%.
5. **Where violations were blocked.** verify (68), revalidate (63), resource (36), execute/model (26), compatibility (25), execute/tool (19), authorize (14), trust (10), validate (9), prepare (6); 100.0% of explicit blocks happened at the stage the catalog predicted before the run.
6. **Largest reductions in protection.** -Resource enforcement: VDR 86.2% (-13.8 pp vs full), SVR 13.8%; -Plan revalidation: VDR 86.2% (-13.8 pp vs full), SVR 13.8%; -Output validation: VDR 90.2% (-9.8 pp vs full), SVR 9.8%.
7. **Defense in depth.** Violations still explicitly blocked under their own most relevant ablation: F1.member_removed (5/6 under -Verification), F2.unsigned (2/2 under -Verification), F4.model_context_insufficient (4/6 under -Compatibility), F4.model_not_offered (6/6 under -Compatibility), F4.tool_unbound (3/3 under -Compatibility), F4.tool_contract_mismatch (3/3 under -Compatibility), F5.reauthorized_after_plan (3/5 under -Plan revalidation), F5.tool_binding_changed_after_plan (1/3 under -Plan revalidation), F5.snapshot_rewritten (4/6 under -Plan revalidation), F5.lease_rewritten (4/6 under -Plan revalidation), F6.file_capability_forgery (3/3 under -Host mediation), F6.file_path_from_model (2/2 under -Output validation), F6.destination_redirect (2/2 under -Compatibility), F7.review_relation (1/3 under -Output validation), F7.search_response (2/3 under -Output validation), F8.usage_accounting (4/6 under -Resource enforcement). Guards no profile removes by design (container parsing, static workflow validation, JSON parsing): F1.duplicate_member, F1.container_layout, F1.member_name, F1.strict_json, F6.undeclared_capability, F7.model_output_unparseable.
8. **Incidental failures.** 0 full-system violations stopped without an explicit contract refusal.
9. **Full-system silent violations.** 0.

Finite claim: in this controlled suite, WebAgents explicitly blocked 276 of the 276 injected violations and accepted 163 of the 163 matched benign controls. This is not a measure of security against an arbitrary attacker, of model reasoning quality, or of behaviour on other hosts.
