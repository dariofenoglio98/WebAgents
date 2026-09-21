# Agent Package v0 threat model

This prototype treats a downloaded package as untrusted data. Its publisher can request capabilities and provide instructions; the operator's runtime decides which requests receive authority. This is the central boundary in the supplied PDF, especially sections 2, 8–10, 13–14, and 18. The concrete mechanisms below are this project's experimental design, not an established OpenClaw or NANDA standard.

## Assets, actors, and boundaries

Protect the operator's selected files, private document contents, model credentials, host filesystem, model/remote-call budget, and integrity of scientific outputs. Relevant adversaries include a malicious publisher with a valid signing key, an archive distributor who tampers with an artifact, an upstream provider carrying prompt injection, a compromised document, and an agent response that invents claims or requests undeclared capabilities.

The operating-system account and host-installed `agentpkg` implementation, handler registry, grants, and router configuration are trusted. A privileged host process can edit local files or bypass this runtime; read-only file modes do not isolate against it. The reference Python runtime is a capability mediator for cooperative host-installed handlers, **not a general process sandbox for hostile Python plugins**. No package Python, JavaScript, binaries, shell scripts, or WASM modules are imported or executed merely because they occur in an archive.

Boundaries are: source tree → validated archive; archive → cryptographically verified snapshot; package requests → operator grants; worker request → runtime tool/model boundary; source data → extracted evidence; extracted evidence → scientific claim; verified package → OpenClaw instruction discovery.

## Threats and controls

| Threat | Control and remaining limit |
|---|---|
| Tampered payload or forged package | Canonical content hashes and Ed25519 verification cover the signed integrity statement. Trusted-key pinning is external to the artifact. A signature does not prove safety, expertise, ownership of a real-world identity, or independent review. |
| Publisher substitutes its own trust root | A self-included public key establishes only a signature/key relationship. Trusted execution and staging require an operator-selected key. There is no automatic Internet PKI, transparency log, key revocation, or NANDA authority in v0. |
| Archive traversal, symlink, duplicate, or decompression attack | Generic archive validation rejects unsafe entries and applies resource limits before use. ZIP_STORED avoids compressed expansion. Staging writes verified members with no-follow directory descriptors and exclusive creation into a new workspace. |
| Verify/load race | The OpenClaw adapter captures archive/key bytes once, then verifies, loads, and stages that snapshot. Untrusted source paths are not reread after verification. Runtime callers should likewise use one verified `Package` snapshot. |
| Competing manifest/graph truth | Strict, versioned canonical JSON; references and graph constraints are checked. HOCON is not an additional executable representation. Unknown security fields fail closed; noncritical namespaced extensions cannot grant authority. |
| Permissions hidden in natural-language skills | Tool bindings, endpoints, network domains, worker role permissions, state access, and budgets are machine-readable. Skill text cannot grant permissions. Host-handler code must stay behind runtime checks. |
| SSRF or endpoint redirection | The bundled HTTP handler requires explicit HTTPS/443 endpoints, rejects any non-global DNS result, pins the connection to a validated address, verifies TLS for the original host, and disables redirects/proxies. Its killable child bounds DNS/connect/read duration and response size. Runtime configuration overrides cannot expand declared tool domains. Other trusted host handlers must implement equivalent controls. |
| Secret theft from package installation | Packages contain no credentials. The adapter writes no personal OpenClaw configuration and never reads provider auth stores. Public keys are safe to distribute. Host credentials are never injected into downloaded instructions. |
| Recursive or excessive delegation | Package-declared worker roles, coordinator ownership, bounded depth, instance caps, and parallelism checks. Remote/NANDA worker execution is not enabled merely because future metadata can describe it. |
| Concurrent budget overspend | Runtime reservations and counters must be atomic across workers and count failed attempts. A provider with only advisory token limits cannot establish a hard external spending cap. Missing usage is unknown, not zero. |
| Cross-worker data leakage | Workers receive declared state views and return checked patches. Local documents require explicit selection/grants. Session-state declarations are not encryption, physical memory zeroization, or OS-level process isolation. |
| Prompt injection in papers or upstream metadata | Treat abstracts, PDFs, titles, tool responses, and search snippets as evidence data. They cannot change tool grants or worker authority. Semantic model compliance remains imperfect; capability enforcement must not rely on model obedience. |
| Fabricated citation or scientifically unsupported claim | Preserve resolver statuses/provenance; accept only resolved citation records. Track evidence IDs, document scope, locations, claims, and verification results. Mechanical link checks do not prove entailment; semantic judgments require separate evaluation. |
| False full-text confidence | Distinguish metadata, abstract, and selected full-text evidence. A verified DOI does not verify a scientific result. A quoted passage alone does not establish the quality or correctness of the underlying study. |
| OpenClaw skill overrides or executable dispatch | Digest-prefixed host-generated frontmatter, new workspace only, no copied command-dispatch metadata. Original package instructions remain referenced data. No claim that workspace skills enforce package policy. |
| Audit leaks or false attestation | Audit records identifiers, status, hashes, and available usage rather than raw private documents. Eval results record runner/provenance and remain distinct from third-party certification. Logs and receipts are local evidence, not externally anchored tamper-proof records. |

## What signatures and identity mean

`package_id` and `publisher.id` are signed declarations. The external public-key pin determines which key the operator accepts for this package. Acceptance of a key is not a claim that its publisher string has been independently verified. A public key generated for the reference demo is a development trust root, not a university, OpenClaw, or third-party certification.

The package digest identifies the canonical integrity statement; the archive SHA-256 identifies transport bytes. Those are different values and must retain distinct names. Signing and verification rules, including envelope exclusions and canonicalization, are specified in [Agent Package v0](../spec/agent-pkg-v0.md). No private signing key belongs in a distributable archive or committed examples.

## File and memory handling

The package can describe memory scopes from ephemeral to enterprise, but the reference workflow uses session-scoped state. It does not silently establish a cross-session personal memory store. An explicitly requested output directory can contain research state, evidence excerpts, and audit artifacts; this is a durable export and must not be described as automatic ephemeral deletion. Raw private PDF text should not be included in generic traces, error strings, package artifacts, or attestations.

User-selected PDF paths authorize reading only those files through the host reader. A path found inside a paper is data, not a new file grant. Outputs must be new and have no symlink ancestors. The PDF reader enforces byte/page/text limits and runs parsing in a killable child with CPU/time limits; address-space limits are attempted but may be unavailable on macOS. These controls do not constitute an OS security sandbox. Package JSON-schema validation is in-process and is not CPU-isolated against expensive regular expressions or combinatorial schemas.

## Deployment and research limits

The prototype does not provide network namespace isolation, OS sandboxing, remote publisher reputation, key revocation, independent certification, enterprise memory encryption, payment enforcement, or Internet-scale dependency resolution. Host handlers must not call undeclared network services, arbitrary subprocesses, or persistent storage behind the runtime's back. Models can still make poor screening, synthesis, or evidence judgments within their authorized surface.

The primary tests exercise deterministic archive/signature failures, invalid references, authority denials, budgets/delegation, ambiguity/evidence linkage, and safe staging. Passing those tests is evidence about specified invariants, not a general security certification. Installed OpenClaw discovery is evidence that the supported instruction interface recognizes the staged package; it is not evidence that a model executed the workflow or that native OpenClaw budgets were enforced.

Before production use, the next security milestone is an independently reviewed host boundary with strongly isolated file/network handlers, provider-specific usage reservations, malicious-document/skill evaluations, and externally managed publisher-key trust. See [OpenClaw integration](openclaw-integration.md) for inspected SDK capabilities and their limits.


## workflow.v0 boundary

The generic interpreter accepts only the closed graph/data-constructor vocabulary.
It rejects cycles, unapproved roles/tools, cross-role state projections, undeclared
writes and unordered state conflicts before dispatch where statically possible.
Ready-wave state commits are atomic; failed/cancelled children are drained before
failure reports. Per-node/whole-run deadlines complement existing tool deadlines.
Package-declared data assertions can enforce source quotations and referential
integrity without domain code in the interpreter. They do not establish semantic
truth of arbitrary prose or completeness of model-selected data. Trusted adapters
and pathological schema CPU use remain outside an OS-enforced sandbox.
See [the execution profile](../spec/workflow-v0.md) for precise limits.
