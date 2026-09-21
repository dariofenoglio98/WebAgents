# Agent Package v0 — implementation report

Historical milestone-1 document. Current generic execution, reference packages and
verification results are documented in [workflow migration](workflow-migration.md),
[workflow.v0](../spec/workflow-v0.md), and the [new report](workflow-report.md).
The former host-specific execution path is now explicitly retained under `agentpkg.dev`.


Completed and verified on **2026-09-20** in WebAgents. The deliverable is a working generic package format, Python tooling/runtime, Literature Review reference package, and OpenClaw workspace adapter. The signed artifact is [`dist/literature-review.agent.pkg`](../dist/literature-review.agent.pkg); the installable host runtime is [`dist/agentpkg-0.1.0-py3-none-any.whl`](../dist/agentpkg-0.1.0-py3-none-any.whl).

**Validation result: 148 package/runtime tests passed, 132 existing Citation Resolver tests passed, and 22/22 deterministic package evals passed.** A real external demo completed with selected public PDFs. No live LLM inference was performed: the demo uses a labelled extractive baseline, and its scientific relevance/synthesis quality remains unvalidated. The six model reasoning stages are implemented and exercised with a scripted router.

## Architecture and repository

The supplied 31-page PDF was read completely, including its image-only stack on page 27. The original repository, Citation Resolver service/API/skill, and installed OpenClaw interfaces were inspected before implementation. [The architecture](architecture.md) maps the PDF's concepts to concrete decisions; [the specification](../spec/agent-pkg-v0.md) gives the normative details for this experimental profile.

```text
WebAgents/
  README.md
  citation-resolver/                    Existing remote service, preserved
  agentpkg/
    pyproject.toml                     Installable CLI/library
    requirements-dev.lock              Exact verification environment
    src/agentpkg/
      package.py, validation.py         Format, archive and reference validation
      signing.py                       JCS integrity + Ed25519
      runtime.py                       Grants, workers, state views, budgets, audit
      tools.py, network.py, models.py   Host tools, bounded transport, router
      literature.py                    Installed reference workflow interpreter
      literature_evals.py              Executable deterministic evaluation harness
      openclaw.py, cli.py               Workspace adapter and commands
      schemas/                         Seven generic formal schemas
    tests/                             Eight test modules
  agents/literature-review/
    MANIFEST.agent, graph.json, README.md
    policy/policy.json
    skills/                            Seven capability SKILL.md files
    tools/                             Search, resolver, selected-PDF contracts
    schemas/                           Thirteen application schemas
    fixtures/review.json                Explicitly synthetic offline dataset
    evals/                             Deterministic and semantic definitions
    attestations/                      Self-authored provenance/component inventory
  spec/agent-pkg-v0.md
  docs/                                Decisions, threat model, integration, walkthrough
  examples/
    keys/publisher.pub.pem             Public development key only
    demo-offline/                      Reproducible synthetic workflow outputs
    demo-live-fulltext/                Final real external/PDF demo outputs
    demo-live/, demo-live-final/        Earlier discovery-only observations
    eval-results/                      Executed eval results/provenance
    verification/                      Test logs, receipts, hashes, demo summaries
    openclaw-workspace/                 Local staged workspace; gitignored
  dist/
    literature-review.agent.pkg
    agentpkg-0.1.0-py3-none-any.whl
```

The core schemas contain no literature-specific fields. An unrelated Meeting Agenda package is built, validated and signed in the format tests. New package entrypoints require separately installed trusted host interpreters; this prototype does not execute downloaded Python, JavaScript, shell, binaries or WASM.

## Format, validation, packaging and signing

Agent Package v0 uses `spec_version: "0.1"` and the language-neutral runtime API `agentpkg-runtime-v0`. Author-editable JSON is the only authoritative representation. Builds canonicalize JSON with RFC 8785 JCS and preserve other UTF-8 bytes, then emit deterministic ZIP_STORED archives with sorted paths, normalized modes/timestamps, and no extra metadata. The reference artifact contains **32 payload files**, plus integrity and signature envelopes.

Validation combines seven closed JSON Schema 2020-12 schemas with semantic checks: IDs/references, graph cycles, role/skill/tool relationships, state keys, policy consistency, local application-schema references, archive layout, byte limits, hashes, path collisions and forbidden payloads. Unknown security fields/versions fail closed. Namespaced noncritical extensions cannot alter authority. Source trees and artifacts use the same validator; `validate` alone does not authenticate a publisher.

Every payload member has an exact SHA-256 in `integrity.json`. The package digest hashes that canonical integrity statement. Ed25519 signs a domain-separated transcript containing the statement; the signature envelope is excluded to avoid self-reference. Verification requires an externally supplied public-key pin. An embedded key, asserted publisher name, self-authored attestation or passing eval does not establish independent trust.

The final artifact identifiers are recorded in [artifact-verification.json](../examples/verification/artifact-verification.json):

| Identifier | Value |
|---|---|
| Package | `org.webagents.literature-review` version `0.1.0` |
| Package digest | `20a35b6db17127ae52809e84e23e23994d9fbad235d91882b136f36fc4c547a5` |
| ZIP transport SHA-256 | `fb7357ebdf2e8415a32033971ba448dd21a9b20eb35a32a6ec71e1a5240cc03b` |
| Demo key fingerprint | `sha256:646a5b316da08e6ca0f6606a2f55efb968fa1a74fb248c7c09db05539d61d723` |

Repeated unsigned builds and repeated signatures with the same key were byte-identical. Unpack/rebuild reproduced the unsigned artifact. The development private key was generated outside the repository/package in temporary storage with mode 0600; only its public key is distributed. Production trust management, revocation and transparency are future work.

## Permissions, budgets, memory and orchestration

Packages request authority; host grants confer it. Each tool links permission IDs and execution domains, and each worker has an explicit tool allowlist. Missing grants deny. `once` is consumed atomically, `session` applies to the runtime, and `always` does not create a persistent consent store. Selected files use opaque IDs mapped to paths in host configuration. Side-effecting tools require explicit host approval; the reference workflow's tools are read-only.

The package requests a global hard ceiling of **180,000 model tokens**, **45 remote calls**, **three parallel workers**, and per-tool caps of **three searches**, **20 citation resolutions**, and **10 PDF reads**. Each worker invocation also has declared token/remote-call caps. Host overrides can only lower limits. Model reservations include counted input and maximum output and are atomic across workers. Failed/unknown completion usage consumes the full reservation; a known router overrun is reported and halts further dispatch. Token-count requests and completions each count as remote calls. Estimated tokens/dollars are metadata, not escrow or dollar-cap enforcement.

The coordinator owns structured research state. Workers get deep-copied views of declared top-level fields and may return only allowed state patches. The runtime supports session/ephemeral memory and rejects persistent scopes. Six memory scopes are representable for future implementations. Clearing the runtime releases its references; it is not secure physical-memory erasure. User-requested output files are durable exports.

The reference graph has **nine stages, eight execution roles plus a coordinator, and seven skills**. Planning → seed resolution → parallel search → screening → citation resolution → evidence extraction → synthesis → writing → verification. Only the coordinator can create declared workers at depth one. Role/global semaphores bound parallelism; merges are deterministic. Optional seeds resolve independently, survive candidate truncation, and are not sent as numeric keyword queries. Discovery is bounded to 20 candidates.

Model planning, screening, extraction, synthesis, writing and verification are actual structured calls through the [vendor-neutral router contract](model-router.md). The package contains capability/context/privacy requirements rather than vendor credentials or model names. The default extractive path uses lexical screening and source quotations and states its limitations prominently. A model-proposed quote must match source text and page; synthesized claims additionally require an entailment judgment. Unsupported claims are excluded from rendered prose.

## Citation Resolver, evals and OpenClaw

The workflow calls the existing remote `POST /resolve` service. Request/response schemas were generated from its real Pydantic models and checked against them. Canonical metadata and BibTeX are retained; `resolved`, `ambiguous`, `not_found`, `provider_error` and invalid-request responses remain distinct. An ambiguous best match is never silently accepted. Exact seed DOI/arXiv identity must agree with the returned work.

No matching, provider adapter, normalization or bibliographic business logic was duplicated or changed. The only original-service edit is three lines in `citation-resolver/app/main.py`: its hosted skill renderer now replaces the known public origin as well as the legacy placeholder with the configured/validated origin. This repairs two existing test failures while preserving the standalone deployed skill URL. No Railway deployment was performed.

The deterministic harness runs 22 assertions covering citation/evidence integrity, unsupported references/claims, ambiguity, source scope, deduplication, parallel provenance and authority/budget/delegation denials. Outputs identify the dataset, package digest, runner and synthetic status. Semantic eval definitions cover relevance, entailment and synthesis; the recorded semantic result is **not-run**. Scripted-model tests validate protocol behavior and rejection gates, not real-model quality. These receipts are separate from publisher signatures and third-party attestations.

The [OpenClaw adapter](openclaw-integration.md) snapshots and verifies archive/key bytes, displays requested permissions, and stages a new workspace with identity receipt, immutable-by-mode payload and digest-prefixed skill wrappers. Installed **OpenClaw 2026.9.5 (`ec9c1a1`)** discovered all eight wrappers in an isolated config/state test. No personal OpenClaw configuration or credentials were modified. The Python runtime enforces mediated execution; normal OpenClaw skill loading alone does not enforce package policy. The installed model SDK's advisory token caps/optional usage were not presented as hard spending guarantees.

## What is enforced and what is represented

| Area | Current implementation |
|---|---|
| Artifact structure, hashes, pinned signature | Enforced; live execution and staging require verification |
| Tool grants, role permissions, selected files | Enforced through the reference host handlers/runtime |
| Network | Explicit HTTPS/443 domains, public DNS/IP pinning, TLS hostname validation, no redirects/proxies, bounded response and killable deadline |
| Delegation/concurrency | Coordinator-only, depth one, declared roles, per-role/global caps |
| Budgets | Atomic token reservations and call caps; external token guarantees depend on a truthful compatible host router |
| Memory | Session/ephemeral copied views and checked patches; no persistent store/encryption |
| Scientific claims | Exact quote/location and citation/evidence linkage enforced; semantic entailment is a model judgment, and relevance remains fallible |
| Audit | Ordered, hash-chained, privacy-conscious local events; no external tamper-proof anchor |
| Persistent scopes, dependencies, remote/NANDA workers | Representable; execution/loading explicitly refused |
| Shell/payment categories, cost/latency preferences | Declarations only; no supplied shell/payment handlers or monetary cap |
| Publisher identity/attestations | Signed assertions/self-authored metadata; no independent identity or certification infrastructure |
| OpenClaw | Verified workspace staging and tested skill discovery; no native package loader or native hard-budget enforcement |

Archive traversal, executable payloads, symlinks, duplicates/case collisions, ZIP expansion tricks, private-key material, endpoint substitution and binding confusion have explicit checks/tests. PDF processing uses byte/page/text limits and a killable parser child; it is not an OS security sandbox. Trusted host code can bypass the mediator, and adversarial JSON-schema CPU cost is not isolated. These residual boundaries are detailed in the [threat model](threat-model.md).

## Exact verification results

Executed on macOS/Python 3.13.5; exact Python environment is recorded in `agentpkg/requirements-dev.lock`.

| Check | Recorded result |
|---|---|
| `python -m pytest agentpkg/tests` | **148 passed, 1 warning in 10.11s**, no skipped tests; [log](../examples/verification/agentpkg-tests.txt), [JUnit](../examples/verification/agentpkg-tests.xml) |
| Existing resolver `python -m pytest` | **132 passed, 2 warnings in 0.22s**; [log](../examples/verification/citation-resolver-tests.txt), [JUnit](../examples/verification/citation-resolver-tests.xml) |
| Ruff lint/format, both projects | Passed |
| Seven skill frontmatter validations | Passed |
| Deterministic package eval | **22/22 passed**; [result](../examples/eval-results/result.json) |
| Reproducibility, signatures, unpack/rebuild | All passed; [receipt](../examples/verification/artifact-verification.json) |
| Wheel installation outside repository | Verified packaged schemas, pinned signature and complete offline demo; [receipt](../examples/verification/wheel-smoke.json) |
| OpenClaw discovery | Passed against installed executable with isolated state/config, included in the 148 tests |
| Final live/PDF demo | **10/10 structural checks passed**; [summary](../examples/verification/live-fulltext-summary.json) |

The package test warning comes from deliberately constructing a duplicate-entry attack fixture. The two resolver warnings are dependency deprecations from Starlette/httpx/anyio. Main tests use mocked scholarly services and no live inference. Live results are separate, dated observations.

## End-to-end results

The [offline demo](../examples/demo-offline/related-work.md) uses invented papers, identifiers and page records, explicitly labelled synthetic. It produces eight candidates, three bibliography entries, ten evidence items, four unresolved items, 24 worker invocations and peak parallelism three. It counts nine simulated remote calls, two simulated PDF reads, and zero model tokens.

The [final live demo](../examples/demo-live-fulltext/related-work.md) uses the requested example topic, two arXiv seeds, and DOI seeds for MasRouter and AgentDropout. Public PDFs were downloaded separately from ACL Anthology, explicitly selected through host file maps, and parsed by the real reader. URLs, byte counts and hashes are recorded in [live-pdf-sources.json](../examples/verification/live-pdf-sources.json); the source PDFs remain in temporary host storage and are not embedded in the package.

Observed result: **20 candidates; seven resolved bibliography records; 42 retained quotation claims/evidence items (12 full-text, 30 abstract); 16 unresolved items; 43 worker invocations; peak concurrency three; 12 remote calls (three searches, nine resolutions); four PDF reads; zero model tokens.** Both arXiv resolutions returned provider errors and remain unresolved. Thirteen candidates remained `maybe`; one notice records candidate truncation. The output includes bibliography/BibTeX, evidence table, full state, provenance, audit, usage and verification results.

This establishes a working bounded pipeline, real resolver reuse and real PDF provenance. It does **not** establish a scientifically satisfactory review: lexical screening admitted off-topic topology/materials and pre-LLM work, distinct DOI versions remain separate absent stronger identity evidence, and extraction may retain introductory boilerplate. No method-comparison, research-gap or complete-coverage claim follows from the structural passes. These observed shortcomings motivate the next semantic evaluation milestone rather than being hidden by a success score.

## Inspect, verify and run

From the repository root, using the prepared environment:

```sh
agentpkg/.venv/bin/agentpkg inspect dist/literature-review.agent.pkg
agentpkg/.venv/bin/agentpkg permissions dist/literature-review.agent.pkg
agentpkg/.venv/bin/agentpkg verify dist/literature-review.agent.pkg \
  --trust-key examples/keys/publisher.pub.pem
agentpkg/.venv/bin/agentpkg run dist/literature-review.agent.pkg \
  --question 'Dynamic agent selection and topology adaptation in multi-agent LLM systems' \
  --mode fixture --grants examples/fixture-grants.json --out examples/my-review
agentpkg/.venv/bin/agentpkg eval dist/literature-review.agent.pkg \
  --out examples/my-evals
```

Use new output directories. For a fresh environment, install `./agentpkg` or the wheel with Python 3.11+; tests use the development extras. See [tooling instructions](../agentpkg/README.md) for building/signing your own artifact, live calls, selected PDFs and model-router configuration. The [live reproduction instructions](../examples/README.md) list the exact final-demo inputs.

## Resolution of the 25 design questions

| Question | Decision |
|---|---|
| 1–4. Artifact, canonical serialization, source/build, mandatory/optional | Standalone ZIP_STORED; JCS JSON; editable payload versus generated integrity/signature envelopes; closed manifest with explicit empty/null optional collections; unsigned inspection/build allowed |
| 5–8. Package/publisher identity, signature, hashes | Signed asserted IDs plus external key pin; domain-separated Ed25519 over canonical complete SHA-256 payload map; package and transport digests distinguished |
| 9–12. Skills/tools/permissions/local–remote | ID/path references; host binding IDs; tool permission/domain links plus role allowlists; explicit execution kind/endpoints |
| 13–16. Graph, parallelism, delegation, budgets | Validated DAG, explicit stage merge semantics, bounded role/global semaphores, coordinator depth one; per-invocation/global tokens and remote calls plus global per-tool caps |
| 17–18. Memory/model requirements | Six scope declarations with two implemented; copied explicit views; provider-neutral tasks/capabilities/context/privacy and host router |
| 19–20. Evals versus attestations | Declarative eval cases executed by trusted harness; results identify runner/dataset/digest; independent certification never inferred |
| 21–22. Extensions/unknown critical fields | Namespaced noncritical metadata only; unknown critical fields and unsupported versions rejected |
| 23–24. OpenClaw loading/enforcement | Verified supported skill-workspace adapter; reference Python mediator enforces policy, OpenClaw Markdown alone does not |
| 25. Future NANDA | Package identity plus HTTPS/NANDA locator and pinned dependency metadata; no registry/resolver/remote execution implemented |

The PDF deliberately leaves serialization, signature transcript, trust bootstrap, enforcement boundaries and concurrency semantics conceptual. The concrete choices above make those concepts testable without claiming a new official standard. HOCON compilation, arbitrary workflow interpretation, OS isolation, persistent memory capsules, NANDA/AgentRank, remote agents, payments and enterprise governance remain outside this version.

The recommended next milestone is a **supported OpenClaw host router plugin with reliable usage accounting, followed by a small human-labelled scientific evaluation set**. Evaluate real-model screening, evidence entailment and comparative synthesis separately from metadata and structural correctness. Require budget/privacy adversarial tests and independent review of the host boundary before enabling broader delegation or production deployment.
