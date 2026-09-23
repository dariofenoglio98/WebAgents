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


## Browser control-plane boundary

The [agent browser control plane](browser-control-plane.md) adds a trusted local
service in front of the runtime. It opens, validates, verifies, inspects and
authorizes packages, and executes nothing. Its additions to this model are:

| Threat | Control and remaining limit |
|---|---|
| A package URL used as an SSRF primitive | HTTPS/443 only, no credentials or redirects, every resolved address classified against `agentpkg.netaddr` (loopback, private, link-local, multicast, reserved, unspecified, cloud metadata, IPv4-mapped, 6to4, Teredo, NAT64), connection pinned to the validated address with TLS still bound to the hostname, byte cap and one deadline, all inside a killable child. Local files are a separate operator operation. No proxy, revocation or registry allowlist exists. |
| Verify-then-reload substitution | Bytes are captured once, hashed, written to a private `0600` snapshot, rehashed, and every later answer comes from that snapshot. Source paths/URLs become metadata. |
| A valid signature presented as identity | `signature_status` and `trust_status` are separate fields. An embedded key is never a trust anchor; only an operator pin in the local trust store yields `trusted`, and a claimed publisher pinned to other keys reports `mismatch`. No PKI, revocation, transparency log or NANDA authority exists in v0. |
| A package granting itself authority | Decisions default to `deny`, are supplied only through the authenticated API, and are bound into a receipt with the package digest, archive hash, signer fingerprint and trust-store state. No package operation can write the trust store. |
| A stale UI authorizing different bytes | `authorize` requires the caller to echo the digest it displayed; a mismatch is refused. Receipts cannot be replayed across packages sharing an ID and version. |
| A local web page reaching the service | Loopback-only binding with no public mode, a random per-process bearer token, refusal of any request carrying browser origin headers or a non-loopback `Host`, and no CORS headers. A process already running as the same user can read the token file; that is out of scope here, as elsewhere in this prototype. |
| Unbounded local state | Session TTLs, session counts, cache byte caps, explicit close, startup sweep of the service's own stale snapshots, and purge on termination. |
| Control-plane scope creep into execution | No browser module imports the interpreter, mediator, tool, model, fixture or transport modules, at module level or lazily; an AST scan and a fresh-interpreter `sys.modules` check enforce it. Authorization produces a receipt, never a run. |

A misleading `always` grant is deliberately refused rather than displayed: the
runtime's `always` is not persistent, and no host authorization store exists yet.


## Agent Browser plugin boundary

The [Agent Browser feature plugin](openclaw-agent-browser.md) puts a native
OpenClaw Control UI page in front of the control plane. It adds a browser-facing
surface, so it adds these concerns:

| Threat | Control and remaining limit |
|---|---|
| A secret reaching browser code | The control-plane bearer token is read once from a 0600 file written by the child, deleted immediately, and kept only in the Gateway process. No feature operation can return it, and a test asserts the exact token string appears in no operation output. `agentpkg browser-serve --quiet` keeps it out of the child's stdout so it cannot reach host logs. |
| A page reaching the control plane directly | The browser never learns the loopback port, and the control plane refuses any request carrying browser fetch-metadata headers. Node's own `fetch` is refused for the same reason, so the backend uses `node:http` with an explicit minimal header set rather than relaxing the rule. |
| Package text becoming markup | Every package-provided string reaches the DOM through `textContent`; the plugin's browser code contains no `innerHTML`, and a hostile-string fixture is tested. |
| A valid signature reading as a trusted publisher | Validation layers, signature status and trust status are rendered as separate, differently styled facts. Trust states are copied from the control plane, never recomputed in TypeScript. |
| Silent or accidental publisher trust | Pinning is offered only for a valid signature from an unknown key, defaults to the narrowest scope, and requires two deliberate presses. The key is taken from that session's own verified envelope: the browser never handles key material, and the control plane refuses a fingerprint that differs from the one displayed. No trust-on-first-use exists. |
| A package authorizing itself | Every permission renders as denied regardless of publisher trust, only `deny`/`once`/`session` are offered, and authorization echoes the displayed digest, which the control plane verifies. |
| Unbounded browser payloads | Every contract field carries an explicit length or item bound, and the backend projects and truncates before returning. Unknown request fields are refused by SDK schema validation on both sides. |
| Filesystem reach from a web page | Local opening is limited to operator-configured absolute roots, `.agent.pkg` only, with symlink escapes resolved and refused. There is no browser-side file access. |
| Orphaned or duplicated host processes | Single-flight start, one child per plugin instance, an identity-checked reap that verifies a live pid's own argv before signalling, and SIGTERM→SIGKILL on stop. Reaping uses `ps`, so it is POSIX-only. |
| Privilege confusion in the UI | Queries require `operator.read` and actions `operator.write`, enforced by the SDK. A read-only operator sees the page with disabled controls and no Authorize action. |

Native Control UI runs trusted JavaScript with the signed-in operator's Gateway
authority, and it is an experimental OpenClaw lab that is off by default. The
plugin is therefore kept narrow: one page, no agent-callable tool, no HTTP
route, and no package execution path of any kind.


## Model-router bridge boundary

[The bridge](model-router-bridge.md) is the first component in this project that
can spend money, so it is the first one that needs its own entries here. It runs
in `agentpkg.hostbridge`, a namespace the control plane cannot import.

| Threat | Mitigation |
|---|---|
| The control plane gaining the ability to spend tokens | `hostbridge` is in the browser package's forbidden-import set, checked by AST scan at module level and inside functions. Authorization still produces a receipt, never a run. |
| A downloaded package steering which model is called | The child never names a model on the wire; `model.complete` carries content, a schema and a cap only. The binding is held by the Gateway-side parent, taken from the run plan, and compared again against the provider's own answer. |
| A downloaded package steering *what* is sent | The probe request is a host-owned constant in trusted Python. Package skills, graph nodes and inputs take no part, and tests assert their vocabulary is absent from both the request and the live provider call. |
| The bridge becoming a general remote-procedure surface | Two disjoint, closed method allowlists; no name resolution, file path, OpenClaw method name or dynamic dispatch anywhere in the package; `probe.run` takes no parameters at all. |
| A desynchronized or hostile peer | Any malformed frame, wrong version, unknown or duplicate id, oversized frame or non-frame stdout byte terminates the session and kills the child. Nothing is skipped or resynchronized. |
| Credentials or endpoints reaching Python | No provider credential exists in Python. The binding that crosses into the child is a closed field set of identity, capabilities and limits; unknown fields are refused. |
| Logs being read as protocol | The child writes frames to stdout and everything else to stderr; a test writes a deliberate stdout log line and asserts the session fails closed. |
| Spending against a decision that has since changed | Fifteen preflight checks re-verify the plan hash, package digest, archive hash, signature, trust, signer, receipt identity and expiry, run-mode permissions, and model availability and identity, before the first token. |
| An unbounded or orphaned completion | Per-request and whole-session deadlines, `$/cancel` in both directions, an `AbortSignal` that reaches the provider request, and SIGKILL on the child. |
| Silent under-accounting | The input bound is provable rather than estimated; cache reads and writes are charged as input; an aggregate total above the breakdown is charged to output; absent usage fails instead of being guessed. |
| A host that answers with a different model | Refused after the fact by both the Gateway side and the router, rather than returned as a degraded result. |

Two things remain out of scope, as elsewhere in this prototype. A provider that
misreports usage cannot be retroactively prevented from overspending — the
violation is recorded and halts further dispatch. And binding an exact model
requires the operator to set
`plugins.entries.agent-browser.llm.allowModelOverride`, which is a
plugin-wide grant at the OpenClaw layer; the per-run-plan discipline is entirely
this project's preflight.


## Package execution boundary

[Execution](package-execution.md) is the first thing in this project that runs a
downloaded package's own instructions. It lives in `agentpkg.execution`, a third
trusted namespace that neither the control plane nor the model bridge can
import.

| Threat | Control and remaining limit |
|---|---|
| The control plane gaining the ability to run a package | `execution` is in the browser package's forbidden-import set, checked by AST scan at module level and inside functions. The control plane's only new power is copying its own snapshot into a private file; it still imports no interpreter and reports `execution: "disabled"`. |
| The model bridge gaining an interpreter | `hostbridge` must not import `execution`, `workflow`, `runtime` or `tools`, checked the same way, and a real child's `sys.modules` is inspected after a complete probe. |
| A runner that knows which package it is running | No application word and neither reference package's id, name or tool id occurs anywhere in the execution namespace. The graph supplies all behaviour; the same code refuses a tool-declaring package generically. |
| Verify-then-reload substitution of package bytes | The runner receives the control plane's immutable snapshot as an inherited read-only descriptor, never a path, and re-verifies archive hash, digest, identity, signature and signer against the run plan before anything runs. The original URL and source path are never reopened. A path substitution after the descriptor is open cannot change the run; an in-place rewrite is caught by the hash. |
| A package or a page choosing what gets executed | The execution protocol contains no path, no filename, no model id and no OpenClaw method name. The lease directory name is control-plane generated; the lease record stops in the Gateway process; the run record carries no path, no lease and no package output. |
| A run outliving the consent it was given | Preflight refuses to start unless the receipt outlasts the whole run deadline plus a margin. A run legitimately started continues under the consent it began with and records which receipt that was; it grants nothing to the next run. |
| Consent quietly widened to make a run possible | Decisions pass through unchanged. `deny` on a required permission refuses, `always` refuses for want of a store, and `once` refuses when the graph would consume that permission kind more than once rather than being treated as a session. |
| A host limit used to change what a package does | Token, remote-call and worker limits are `min(package, host)` inside `Runtime`. A per-call output cap above the host ceiling is **refused**, not lowered, because lowering a declared cap would alter package behaviour while reporting success. |
| An unbounded or orphaned run | Effective deadline is the tighter of the graph's and the host's; a host-deadline stop is reported as a timeout rather than a cancellation. One child per run, one active run per plan and per session, cooperative cancel escalating to SIGKILL, every run in flight cancelled when the plugin stops, and no resumption after a Gateway restart. |
| A package writing outside its run | The runner writes only through an inherited directory descriptor, with exclusive creation, no symlink following and owner-only modes. Export filenames are already constrained to one safe portable name; the execution host additionally reserves `run.json`. |
| A flattering report | The run summary is derived from the audit rather than kept beside it, and the chain is re-verified event by event. Cost is only the sum of costs the host reported; a missing value is `unknown` or `partial`, never estimated. Which model answered is recorded per call by the adapter. This is a local hash chain, not an externally anchored log. |
| An unverified host's accounting assumed still valid | The live OpenClaw version is recorded in every run record and provenance, and a release other than the verified one is refused by default. The self-verifying half — that the token bound is `utf8_bytes + framing` because the host answers "no tokenizer" — is re-derived and recorded on every call. |
| Package tools running unmediated | There is no tool broker. `Workflow` is constructed with no handlers, and a package declaring a tool or containing a `tool` node is refused before any token. This is a limit of this execution host, not of the package format. |

The plugin backend remains trusted host code: it holds the control-plane bearer
token, opens the lease descriptor and owns the runner process. Binding an exact
model still requires the plugin-wide `llm.allowModelOverride` opt-in at the
OpenClaw layer; the per-run-plan discipline is this project's own.


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
