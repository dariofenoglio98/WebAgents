# Literature Review 0.2.4 acceptance report

LITERATURE REVIEW 0.2.4 CROSS-PROVIDER ACCEPTANCE: PARTIAL

Machine-readable evidence: [acceptance.json](../examples/verification/literature-review-024-acceptance.json).
Qwen completed the real package run and all package validators, but the independent
acceptance driver retained one failed check: one evidence-table category differed
from its extraction record. All nine direct quotes and their provenance matched.
The hosted API-key route has not been tested. This is a missing-credential limitation,
not proof that OpenClaw's direct API route cannot support structured output.

1. **Initial state.** HEAD was `f237aa9d3417cef1579cefbc37e1e60ec5e8b002`.
   The actual worktree was clean; the earlier 0.2.3 and Luna fixes were already
   committed. Before edits, status, HEAD, staged/worktree diffs, package hashes,
   and signer facts were saved outside the repository at
   `/private/tmp/webagents-pre-024-20260927-230021`.
   The original archive SHA-256 matched the supplied expected value:
   `32304cad852d162084a3bdd9a444e04e31423f1e660f7cefdaeee442c1520dff`.

2. **Root causes addressed.** Model-generated preparation could drop resolved
   evidence jobs; model transcription could alter direct quotes. Both operations
   now use deterministic graph expressions. Tool failures lacked structural
   diagnostics. Model descriptors incorrectly inferred schema delivery from
   tool support; descriptors now distinguish the bridge's validation guarantee
   from unverified provider transport behavior.

3. **Files changed.** Package manifest, graph, schemas, skills, fixture and
   attestations; tool broker/bridge/runtime diagnostics; model capability
   descriptors; regression tests; probe and verification scripts; signed
   archives; documentation and the safe acceptance record. The complete path
   list appears below. Agent Browser remains version `0.1.0`.

4. **Generic runtime changes.** No workflow primitive, interpreter branch, or
   package-specific runtime condition was added. Existing map, ordered join,
   lookup, validate, object/array expressions and assertions are sufficient.
   Generic runtime changes attach sanitized diagnostic facts to tool input/output
   validation, timeout and cancellation failures. Failure validation remains strict.

5. **Package-only changes.** Version `0.2.4` removes the `prepare` model task,
   introduces a direct-quote draft contract, deterministically prepares evidence
   jobs and materializes final claim text, and retains the existing final
   assertions. Permissions, tool contracts, runtime minimum `0.2.1`, and budgets
   are unchanged, including `max_remote_calls = 45` and `hard_tokens = 180000`.

6. **Architecture.** The graph now has 24 nodes, presented within the existing
   eight UI stages. Resolution flows through deterministic preparation and three
   ordered joins, then the existing extraction/synthesis/writing/verification
   stages. Deterministic claim materialization and bibliography construction
   feed final assembly and strict validation. The signed package remains portable;
   OpenClaw retains model, tool, credential, file and network authority.

7. **Evidence jobs.** Each resolver result produces one trusted citation record.
   A resolved record produces exactly one evidence job with the exact source
   paper, resolver record and previously selected opaque file capability.
   Non-resolved records produce no extraction job and retain an unresolved row.
   Ordered joins preserve source ordering. Bidirectional assertions enforce
   coverage, uniqueness and exact source relationships; missing fields or lookups
   fail closed. Regression cases cover N = 0, 1, 3, mixed resolver outcomes,
   dropped/duplicate jobs, missing sources, and a model stub that fails if
   preparation is ever requested.

8. **Direct quotes.** Model drafts select exactly one evidence ID and one paper ID
   and must set direct-quote `text` to null. After verification, graph lookup
   verifies the selected evidence's paper and copies its quote exactly into the
   final claim. Paraphrase text is unchanged. Tests reject wrong/missing/empty IDs,
   attempted model transcription, and tampered materialization. The original
   final exact-quote assertion remains intact. Evidence extraction still selects
   source spans and remains subject to the existing source-containment checks.

9. **Tool diagnostics.** The broker, IPC boundary and Python bridge filter a closed
   structure: stage enum, HTTP status, content-type category, byte count, size/
   parse flags, timeout/cancellation flags, and schema keyword/depth counts.
   Schema property names and instance values are excluded. Existing dispatched
   audit entries identify the approved binding/hash/version/origin. Facts reach
   the hash-chained `tool.failed` audit and execution failure summary. Tests cover
   leakage, error classes and successful responses. No response body, credential,
   header or arbitrary exception text is added to these facts; no retry was added.

10. **Crossref.** The old failure could not be reproduced. Three queries recovered
    from earlier planning evidence passed through the actual broker with real
    DNS/TLS transport: HTTP 200, three papers each, package output schema valid.
    These are prior planning queries, not a demonstrated recovery of the exact
    queries from every failed run. Binding `openclaw:scholarly-search:1`,
    implementation `0.2.0`, approved origin `https://api.crossref.org`, binding hash
    `4800eb9bb1be9ddbec38e262ce0ae6e22c17dcb5659c122fd99959110923d65c`.
    No speculative service fix was made; future failures now retain diagnostic facts.

11. **Model/transport findings.** Installed OpenClaw is `2026.9.5`. Its safe public
    catalog does not attest to the transport selected after authentication.
    `structured_output` explicitly describes the existing bridge contract:
    schema-validated JSON or a failed call. New `structured_output_transport`
    evidence is null/absent and explicitly unverified. Catalog declarations are
    described without treating them as observed delivery. There is no Luna/model
    family special case. The installed Codex sanitizer removes `text.format` and
    `max_output_tokens`; the direct Responses builder has parameter support, but
    source inspection alone does not prove a real request retained them. Existing
    allowed-key prompting, stop/truncation checks, safe model facts and fail-closed
    validation remain in place.

12. **Exact OpenAI route used.** None in this milestone. Host inspection found two
    OpenAI OAuth profiles, zero API-key profiles and no `OPENAI_API_KEY` environment
    credential. OpenClaw stores auth in its managed state database. The supported
    masked-input command was verified from installed CLI help and implementation:

    ```sh
    openclaw models auth paste-api-key --provider openai --profile-id openai:literature-api
    ```

    Enter the key in that terminal prompt, not in chat or the repository. Existing
    OAuth profiles were preserved. After setup, authentication selection and the
    actual outgoing route must still be verified before hosted acceptance.

13. **JSON Schema reaching Luna.** Not observed: no direct-API Luna request was
    made. A probe-only observer records route class and schema presence/hash when
    visible, without headers or request content. Its transport event arrays were
    empty on this installed Qwen host path; those arrays are not positive transport
    evidence. Worker/transport visibility must be established for the Luna probe.

14. **Max-output reaching Luna.** Not observed, for the same reason. Requested caps
    and actual outgoing caps must be distinguished. Static Codex stripping behavior
    does not establish the behavior of the untested API-key route.

15. **Focused Qwen results.** `ollama/qwen3:30b`: 7/7 conforming, each actual model
    exact and stop reason `stop`: trivial, screen, normalize, extract, synthesize,
    write, verify. Caps requested: 1024 for trivial; 16000 for normalize/verify;
    12000 otherwise. Aggregate reported usage: 13,508 input + 300 cache-read +
    29,961 output = 43,769 total tokens; local cost $0. The probe archive preceded
    the final build by presentation annotations only: all schemas, prompts,
    fixtures and executable graph content were verified identical. This establishes
    conformance, not independently observed constrained decoding.

16. **Focused Luna results.** Not run because the required API credential is absent.
    Earlier OAuth results are context only and do not count toward API acceptance.

17. **Package tests.** 21 new 0.2.4 regression cases passed, alongside 14 new Python
    tool-diagnostic cases. Signed fixture verification passed: two resolved records,
    exactly two jobs, seven evidence items, no prepare completion, exact final
    quotes and bibliography, strict final validation, preserved 0.2.3 bytes.
    Historical 0.2.2/0.2.3 checks now explicitly use the preserved 0.2.3 archive;
    new checks cover the current source and signed 0.2.4. The broader workflow
    verification script also passed.

18. **Full Python suite.** 865 passed, 2 skipped. One expected warning is from the
    duplicate-ZIP attack fixture. Log: `full-python-final.log` in the safety snapshot.

19. **Full plugin suite.** 407 passed across 22 files. Typecheck, build, changed-file
    Ruff checks and `git diff --check` passed. Log: `full-plugin-final.log` in the
    safety snapshot. Existing security, binding, isolation and hostbridge regressions
    were included in the full suites.

20. **Qwen live acceptance.** Run
    `run_41b9200000d14aa2b7970c1a819213e7` completed in approximately 25 minutes,
    with all 24 graph nodes complete and strict final validation passed.
    Three resolved records produced exactly three ordered jobs; ten evidence
    items supported nine claims, all nine direct quotes materialized exactly;
    three bibliography entries matched resolver metadata. All 18 calls used
    `ollama/qwen3:30b`, with no fallback or prepare completion. Five package
    exports and five host files were written; the 632-event audit chain is valid,
    and the Run Plan hash was unchanged. The independent driver passed 27/28
    checks: full-row evidence-table equality failed because the verifier changed
    one row's category. Evidence ID, paper ID, quote, scope, location and provenance
    remained exact. The existing final validator compares those provenance fields,
    not category. The stronger driver check remains failed; this is not a claim
    of full local acceptance. No validator or acceptance criterion was weakened.
    It used the final signed archive and the
    canonical prompt, empty seeds/documents and live mode. The acceptance driver
    uses the running Gateway's `plugins.sessionAction` operations, including the
    same `execution.start` used by the UI; model/tool requests are made by the
    installed plugin and signed graph. This is execution-path acceptance, not a
    visual browser interaction test.

21. **Luna live acceptance.** Not run. No OAuth/Codex substitution was made. The
    milestone cannot receive PASSED until both intended model paths complete a
    real package run.

22. **Token/remote-call usage.** Qwen full run: 114,022 accounted tokens, 18 model
    completions, six remote tool calls (three search, three citation resolver),
    peak three workers, no PDF reads for empty documents. All 18 calls reported
    cost; total local cost $0. Limits remained 180,000 tokens and 45 remote calls.
    Focused Qwen usage is recorded in item 15. Offline fixture usage was 35,732 accounted tokens
    and six remote tool calls; fixture figures are not live model measurements.
    Removing prepare saves one model completion, corresponding to two accounting
    events on the previously observed hosted count/preflight-plus-completion path.
    Luna live tokens/remote calls are unmeasured; no hosted budget-margin claim is made.

23. **Hosted cost.** No Luna request was issued in this milestone. There is no
    measured hosted execution cost; the acceptance record uses null rather than
    fabricating a successful $0 hosted run.

24. **Artifact identity.** Package `org.webagents.literature-review`, version `0.2.4`.
    Package digest:
    `4a32fc32533fc60e012febc165e557750e271dff930730ec602fed66fd8712b1`.
    Archive SHA-256:
    `f513e68ea23e045ed3665d8d71e46531147f017f0da80f999fb343afc3e1fe24`.
    `dist/literature-review-0.2.4.agent.pkg` and the default archive are identical.
    The byte-identical old artifact is `dist/literature-review-0.2.3.agent.pkg`.

25. **Signing.** Used the existing private key outside the repository; no rotation.
    Fingerprint:
    `sha256:c5ca9763f9fc71253298ca381ec14c4d7432009c74dacc69df6344b71de05232`.
    Signature verification passed. Private signing material was not added to the repo.

26. **Git/host state.** Changes remain uncommitted and unpushed. No reset, checkout,
    clean or overwrite from HEAD was used. The existing installed plugin and host
    config were backed up before installing the rebuilt plugin through the supported
    CLI; the Gateway hot-applied it. OpenClaw's installer repaired managed peer links.
    The host configuration had no semantic changes, and auth profiles were retained.

27. **Remaining limits.** The independent live acceptance found one evidence-table
    category altered during verification. Exact quote/provenance checks passed,
    but full-row equality did not; a future correction should deterministically
    source the exported evidence row and be validated in a new real run.
    Complete the direct-API credential setup, prove actual
    Luna route/schema/cap delivery, then run its focused probes and full acceptance.
    Crossref's previous intermittent root cause remains unknown.
    Native decoding is not proven by schema-conforming
    samples. Final quote claims are deterministic; freeform related-work prose
    and verification evidence-table selection remain model work subject to the
    existing validators. No new provider, retry, fallback or budget increase was added.

## Changed files

```text
README.md
agentpkg/src/agentpkg/execution/report.py
agentpkg/src/agentpkg/runtime.py
agentpkg/src/agentpkg/toolbridge/errors.py
agentpkg/src/agentpkg/toolbridge/facts.py
agentpkg/src/agentpkg/toolbridge/handler.py
agentpkg/tests/literature_scenarios.py
agentpkg/tests/test_browser_control.py
agentpkg/tests/test_literature_022.py
agentpkg/tests/test_literature_023.py
agentpkg/tests/test_literature_024.py
agentpkg/tests/test_shipped_artifacts.py
agentpkg/tests/test_tool_failure_facts.py
agents/literature-review/MANIFEST.agent
agents/literature-review/README.md
agents/literature-review/attestations/runtime-components.json
agents/literature-review/fixtures/workflow.json
agents/literature-review/graph.json
agents/literature-review/schemas/citation-record.schema.json
agents/literature-review/schemas/claim-draft.schema.json
agents/literature-review/schemas/claim.schema.json
agents/literature-review/schemas/claims.schema.json
agents/literature-review/schemas/evidence-jobs.schema.json
agents/literature-review/schemas/preparation-batches.schema.json
agents/literature-review/schemas/research-state.schema.json
agents/literature-review/schemas/review-draft.schema.json
agents/literature-review/schemas/synthesis.schema.json
agents/literature-review/schemas/synthetic-flag.schema.json
agents/literature-review/schemas/unresolved.schema.json
agents/literature-review/schemas/written.schema.json
agents/literature-review/skills/citation-resolution/SKILL.md
agents/literature-review/skills/claim-and-citation-verification/SKILL.md
agents/literature-review/skills/evidence-synthesis/SKILL.md
agents/literature-review/skills/related-work-writing/SKILL.md
dist/literature-review-0.2.3.agent.pkg
dist/literature-review-0.2.4.agent.pkg
dist/literature-review.agent.pkg
docs/literature-review-024-report.md
docs/model-availability.md
docs/tool-broker.md
examples/verification/literature-review-024-acceptance.json
openclaw-agent-browser/scripts/run-literature-review.mjs
openclaw-agent-browser/scripts/structured-output-probe.mjs
openclaw-agent-browser/scripts/transport-observer.mjs
openclaw-agent-browser/src/bridge-core.ts
openclaw-agent-browser/src/errors.ts
openclaw-agent-browser/src/host-models.ts
openclaw-agent-browser/src/tool-broker.ts
openclaw-agent-browser/src/tool-facts.ts
openclaw-agent-browser/test/backend.test.ts
openclaw-agent-browser/test/host-models.test.ts
openclaw-agent-browser/test/run-plan.test.ts
openclaw-agent-browser/test/tool-broker.test.ts
openclaw-agent-browser/test/tool-facts.test.ts
openclaw-agent-browser/test/transport-observer.test.ts
scripts/probe_literature_024.py
scripts/verify_literature_023.py
scripts/verify_literature_024.py
```
