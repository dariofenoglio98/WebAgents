# workflow.v0 milestone report

The acceptance criterion is met: **the same `agentpkg.workflow.Workflow` interpreter executes the Literature Review and Meeting Agenda artifacts with no application-specific imports or package-name branches**. This is an incremental change to the existing container/security/runtime implementation.

## Architecture and deliverables

The package/container version remains **agent.pkg 0.1**. Runtime/package implementations are **0.2.0**, with an explicit **workflow.v0** execution profile. Each package has one canonical `graph.json`; its skills, schemas, policies, task contracts and mappings define application behavior.

The interpreter implements `llm`, `tool`, bounded ordered `map`, `join`, `validate`, and `output`. Conditions use bounded equality tests with explicit fallback values. Data construction is limited to literals, JSON Pointers, objects, arrays and first-non-null selection. Three validation assertions—equality, sum and record relationship—supply cross-record checks without an application language or callbacks.

Execution uses an acyclic dependency graph, isolated role state views, explicit authorized writes and atomic ready-wave commits. Unordered state conflicts fail validation. Existing global/worker budgets, permission checks, remote/tool-call accounting and semaphores remain in the authority mediator. New lifecycle code adds deadlines covering queues/preflight, sibling cancellation/draining, stable failure reports and structured audit. Local PDF cancellation now drains its existing bounded parser/reaper before returning.

The host model contract is two-phase counting/completion with structured requirements, instructions, schema, budget and audit context. Its protocol and request/result schemas are explicit. Fixtures are domain-independent exact-input replay with package-owned cases and synthetic accounting. Existing provider adapters remain host-installed tool integrations. No new real model provider, browser UI or downstream integration was added.

## Files changed or created

| Area | Files |
|---|---|
| Generic interpreter | `agentpkg/src/agentpkg/workflow.py`, `workflow_validation.py`, `workflow_values.py`, `workflow_assertions.py` |
| Host interfaces and fixtures | `interfaces.py`, `fixtures.py`, updated `models.py` |
| Machine contracts | `schemas/workflow.schema.json`, `workflow-fixture.schema.json`, `audit-event.schema.json`, `model-request.schema.json`, `model-result.schema.json` |
| Existing core integration | Updated `runtime.py`, `validation.py`, `package.py`, `cli.py`, `tools.py`, version and console-script metadata |
| Literature Review | Migrated `agents/literature-review/graph.json`, manifest, state/operation schemas, skill task contracts, fixtures, provenance and README; 54 payload files |
| Independent reference | New `agents/meeting-agenda/` graph, manifest, three skills, schemas, policy and fixture; 16 payload files |
| Compatibility | `agentpkg/dev/{literature,literature_evals,legacy_cli}.py`, `agents/literature-review-legacy/`, original signed legacy artifact |
| Tests | New `test_workflow.py`, `test_workflow_validation.py`, `test_workflow_cli.py`; retained legacy tests with explicit snapshot imports; parser cancellation regression |
| Reproduction | `scripts/verify_workflow.py`, sample inputs/grants, signed artifacts, new public demo key, saved runs and verification reports |
| Documentation | `spec/workflow-v0.md`, `docs/workflow-migration.md`, this report, model interface documentation, package/root READMEs and historical-document notices |

Signing and archive-integrity algorithms were preserved. `openclaw.py` was not changed. The Citation Resolver service's pre-existing working-tree change was left untouched.

## Old application orchestration

The main CLI no longer dispatches to `literature.review`, and the generic interpreter does not import `literature.py`, its `STAGES`/`ROLES` tables, orchestration closures, specialized merge logic or evaluation harness. Both new packages use the canonical graph instead.

For backward compatibility, the entire former runner is explicitly retained under **`agentpkg.dev`**, with a separate legacy CLI, source snapshot and old signed artifact. It is not a hidden fallback and is not used to execute either new package. This preserves the earlier extractive/live-provider path and 22 specialized deterministic evals while exposing the migration honestly. See [the precise migration](workflow-migration.md#what-happened-to-the-old-code).

## Proof and saved demos

| Result | Literature Review | Meeting Agenda |
|---|---:|---:|
| Interpreter | `agentpkg.workflow.Workflow` | `agentpkg.workflow.Workflow` |
| Profile | `workflow.v0` | `workflow.v0` |
| Top-level nodes | 17 | 6 |
| Peak active workers | 3 | 3 |
| Synthetic token units | 56,723 | 2,359 |
| Declared remote-tool dispatches | 9 | 0 |
| Real network/model calls in fixture demo | 0 | 0 |
| Output | 3 bibliography entries, 10 evidence items | 45-minute agenda, 5/15/15/10 allocation |

Literature Review's tool accounting is three searches, six Citation Resolver calls and two selected-document reads. Distinct resolved/ambiguous/not-found/provider-error responses are preserved. Meeting Agenda produces preparation items, decisions and questions in addition to the timed agenda.

Saved output: [Literature Review](../examples/workflow-review/related-work.md), [its audit](../examples/workflow-review/audit.json), [Meeting Agenda](../examples/workflow-agenda/agenda.json), and [its audit](../examples/workflow-agenda/audit.json). Both provenance files identify the same interpreter and both audit streams contain `workflow.started` with profile `workflow.v0`.

The [acceptance report](../examples/verification/workflow-verification.json) confirms deterministic builds/signatures, unpack/rebuild equivalence, source-to-shipped artifact digest agreement, publisher verification, staging, repeatable output/accounting and preservation of the old signature. The [isolated wheel smoke report](../examples/verification/workflow-wheel-smoke.json) confirms both run from the installed 0.2.0 wheel without loading any development module.

Tests also rename package/node identities, reverse graph storage order, execute multiple ready roots, and verify identical model/map/state mechanisms. A fresh-process import test rejects `agentpkg.dev` and Literature Review imports. A source scan fails if application terms appear in the generic interpreter, mediator, validator or replay modules.

## Verification results

- Full agentpkg suite, including installed OpenClaw discovery: **232 passed**.
- Citation Resolver suite: **132 passed**.
- Preserved legacy deterministic eval harness: **22/22 passed**.
- Ruff lint and formatting: passed for `agentpkg` and `scripts`.
- Wheel build and isolated installed-wheel execution: passed for both packages.
- Both artifacts: deterministic build/sign/unpack, valid pinned signatures and staging passed.

Logs: [agentpkg](../examples/verification/workflow-agentpkg-tests.txt), [Citation Resolver](../examples/verification/workflow-citation-resolver-tests.txt), [legacy evals](../examples/verification/workflow-legacy-eval.json), [wheel build](../examples/verification/workflow-wheel-build.txt).

The initial baseline had 147 agentpkg tests passing and one installed-OpenClaw discovery timeout at 55 seconds, plus 132 Citation Resolver tests passing. Installed discovery passed on retry and in the final full run. It is now explicitly opt-in for deterministic default tests. Normal default invocation therefore reports 231 passed and one skipped; all staging tests still run. Remaining warnings are the deliberate duplicate-ZIP test fixture and existing upstream test-client deprecations.

## Local verification commands

From the repository root:

```sh
agentpkg/.venv/bin/python -m pip install --no-deps --no-build-isolation -e ./agentpkg
agentpkg/.venv/bin/python -m pytest agentpkg/tests
AGENTPKG_TEST_OPENCLAW=1 agentpkg/.venv/bin/python -m pytest agentpkg/tests
(cd citation-resolver && .venv/bin/python -m pytest)
agentpkg/.venv/bin/python -m ruff check agentpkg scripts
agentpkg/.venv/bin/python -m ruff format --check agentpkg scripts
agentpkg/.venv/bin/python scripts/verify_workflow.py
```

Run the two demos into fresh directories:

```sh
agentpkg/.venv/bin/agentpkg run dist/literature-review.agent.pkg \
  --mode fixture --input examples/literature-review-input.json \
  --grants examples/literature-review-grants.json \
  --trust-key examples/keys/workflow-publisher.pub.pem --out examples/my-workflow-review

agentpkg/.venv/bin/agentpkg run dist/meeting-agenda.agent.pkg \
  --mode fixture --input examples/meeting-agenda-input.json \
  --grants examples/meeting-agenda-grants.json \
  --trust-key examples/keys/workflow-publisher.pub.pem --out examples/my-workflow-agenda
```

To inspect/check the shipped packages independently:

```sh
agentpkg/.venv/bin/agentpkg inspect dist/literature-review.agent.pkg
agentpkg/.venv/bin/agentpkg permissions dist/literature-review.agent.pkg
agentpkg/.venv/bin/agentpkg verify dist/literature-review.agent.pkg \
  --trust-key examples/keys/workflow-publisher.pub.pem
agentpkg/.venv/bin/agentpkg verify dist/meeting-agenda.agent.pkg \
  --trust-key examples/keys/workflow-publisher.pub.pem
```

The new development public key is separate from the earlier milestone's key. Its private key was temporary, never included in sources/artifacts, and removed after signing. The verification script creates its own temporary signing keys to test the primitives; it does not need the release private key.

## Known limitations

Fixture replay proves graph execution and enforcement for authored scenarios; it does not interpret prompts or generalize to new inputs. Real model selection/integration and semantic quality evaluation remain the next milestone. Structural checks, source quotations and record links do not prove arbitrary prose entailment or complete candidate selection.

workflow.v0 deliberately supports DAGs, depth-one local workers and bounded flat maps. No loops, nested delegation, retries, dynamic graph generation, streaming or resumable checkpoints. Raised provider errors fail fast; only explicit schema-valid service outcomes continue as data. Worker budgets apply per invocation, with separate global caps.

Python host adapters must honor their cancellation/accounting contracts. Network children are killable; local PDF cancellation drains its bounded parser, which may delay cancellation completion. This is not an independently hardened OS sandbox or CPU isolation for expensive schemas. Audit hashes expose metadata and are not external tamper-proof attestation. Result/usage determinism does not imply byte-identical timestamps/run IDs in audit logs.

The archived legacy orchestration remains available only through its explicit development path. No OpenClaw browser UI, new real OpenClaw routing, Muse, Instinct, Maritime, NANDA, registry, discovery marketplace, Experiment Agent or Research Agent was implemented.
