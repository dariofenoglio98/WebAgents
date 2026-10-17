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
| Package claims or substitutes a person's resource | A package requests a *type* (`personal.read`); the host lists what it holds and the person picks one, frozen into the receipt and plan by opaque id and keyed digest. Host-resource tools take no arguments, so nothing a package or model sends can name another resource; the broker resolves only the plan's grant for that type and a permission the calling tool links. A sealed value of a resource not granted is refused in every tool call, and a granted one in calls whose tool does not link its permission. A changed or removed resource makes the plan stale before execution and is refused at call time. Limits: sealing is exact-value matching over host-held values, not general DLP; unsealed fields (preferences) are ordinary data; a granted value may still go wherever the package's signed tool declarations say it may. |
| Personal data reaching a model or a disk | A package's graph decides which state each model role reads, and the interpreter checks those read sets statically; WebAir keeps host resources in a model-less role and clears them from state before the run ends. The host does not inspect model inputs: a package that routed a granted value into a model step would be honoured, visibly, in its signed graph. Digests are HMAC-SHA256 under a process-local key, so a receipt, plan or audit cannot be checked against a guessed record. |
| Operator bindings file adds a hostile endpoint | `tools.bindingsFile` is operator configuration, trusted like every other plugin setting. It can only add entries of the service-neutral JSON POST adapter (one HTTPS origin on 443, one path), never a category, adapter, local implementation, header, query or credential value, and cannot shadow an entry the host already serves. Each entry still has to land inside the package's declared domain, path, method and schema digests, be approved by the person, and pass the broker's fixed destination policy (public addresses only, pinned socket, no redirects). Limit: an operator who points an entry at a hostile service that the package also declares is trusted by construction, as with `tools.bindings` retargeting. |
| Replayed one-time authority | `once` is consumed at first use within a run, and the first execution lease spends the receipt across runs; a second run needs a new decision. |
| Audit leaks or false attestation | Audit records identifiers, status, hashes, and available usage rather than raw private documents. Eval results record runner/provenance and remain distinct from third-party certification. Logs and receipts are local evidence, not externally anchored tamper-proof records. |

## What signatures and identity mean

`package_id` and `publisher.id` are signed declarations. The external public-key pin determines which key the operator accepts for this package. Acceptance of a key is not a claim that its publisher string has been independently verified. A public key generated for the reference demo is a development trust root, not a university, OpenClaw, or third-party certification.

The package digest identifies the canonical integrity statement; the archive SHA-256 identifies transport bytes. Those are different values and must retain distinct names. Signing and verification rules, including envelope exclusions and canonicalization, are specified in [Agent Package v0](../spec/agent-pkg-v0.md). No private signing key belongs in a distributable archive or committed examples.

**A key rotation and an impersonation attempt look identical from the bytes.** When `meeting-agenda` 0.2.1 was re-signed with a new development key, the trust store reported `mismatch` / `claimed_publisher_pinned_to_other_key` and named the key already pinned for `webagents-research` — the same answer it would give an attacker signing a package under someone else's publisher string. That is correct and deliberate: v0 has no PKI, no revocation and no transparency log, so nothing in the artifact can distinguish a publisher rotating their own key from a third party claiming their name. Only an out-of-band decision by the operator on that exact fingerprint resolves it, and the narrowest useful scope is `package`, which binds the new key to one `package_id` rather than to the publisher's whole namespace. Two keys pinned for one publisher is a supported end state, not an anomaly, and neither key inherits the other's trust.

## File and memory handling

The package can describe memory scopes from ephemeral to enterprise, but the reference workflow uses session-scoped state. It does not silently establish a cross-session personal memory store; the user-owned memory of `memory.v0` (§ User memory) is written only through proposals the person accepts. An explicitly requested output directory can contain research state, evidence excerpts, and audit artifacts; this is a durable export and must not be described as automatic ephemeral deletion. Raw private PDF text should not be included in generic traces, error strings, package artifacts, or attestations.

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
| A website used to reach the host, or to vouch for a package | Website discovery (`rel="agent-package"`, experimental WebAgents metadata) applies the same syntax, address classification and pinned connection inside a killable child, follows redirects only within one origin with every hop resolved and classified again, reads at most 1 MiB of one `200` HTML response (decompressed under the same cap) and only its head, runs no script and fetches nothing the page references. A candidate is accepted only on the page's own origin and is reported as a location: discovery creates no session, touches no trust, fetches no package, and its result cannot represent verification, trust, permission or execution. Inspecting a candidate is the ordinary `open-url`. A site that lets visitors inject a `<link>` into its head, or a compromised origin, can still advertise a package; it is then judged like any other, and trust stays the key's. Cross-origin delegation is not supported. |
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
route, and — since milestone 3C — exactly one way to execute: the Run surface
below.

## Run surface boundary (3C)

The page's Run button starts the open package's prepared run plan. A page is
the least trusted caller that can reach `execution.start`, so the start's input
is the whole attack surface and it is closed:

| Threat | Control and remaining limit |
|---|---|
| The page choosing what runs | `execution.start` takes exactly `{sessionId, runPlanId, runPlanSha256, input, files, detach}`; a model, binding, tool, path, archive, executable, command or URL is refused by the Gateway's schema check before the plugin sees it. Everything else resolves through the session's own authorized state: the plan froze the model and tool implementations, the receipt holds the decisions. A structural test pins the six fields; 47 live probes tried the rest. |
| A stale or substituted plan | The preflight re-verifies plan id and hash, package bytes, signature, signer, publisher trust, receipt and that it outlasts the whole run deadline, bindings, approvals and model identity at every start; the runner re-verifies the snapshot itself. A wrong hash, an unknown plan or an arbitrary model id is refused. |
| Concurrent or repeated runs | One run per plan and session (`execution_active`); the button is single-flight. |
| A task smuggling authority | The task is data validated against the package's own input schema by the control plane before a lease exists; it cannot name a model, tool or path. Files are `file_<32 hex>` capabilities the session holds, copied from operator roots; a path, a forged id, another run's id or an id the run was not given is refused, and reading still needs `files.read`. |
| A package steering the UI | `agentpkg:presentation` is noncritical and validated against a closed vocabulary (labels, stages, field hints, exports); it can relabel, never add a control, and a Run label must contain "run". No package markup, style or script reaches the page. |
| Model output as an attack | Results are rendered as Markdown built from DOM calls only — no markup, scripts, images or iframes from text, only http(s) links with `noopener noreferrer nofollow` — and bounded; tested with hostile text. |
| Artifact paths | An artifact is one plain filename the run wrote, opened with `O_NOFOLLOW`; traversal, absolute, nested and encoded names are refused. Downloads are verified against the file's SHA-256. |
| Denial through large outputs | Every output is fitted to the host's plugin JSON limits first (run summaries, 48 KiB views and slices, budgeted echoes, a fitted model catalog), so growth fails closed in one field instead of breaking the page. |
| A reload granting anything | Reconnect only re-reads records; a finished run whose session is gone is read-only evidence with no Run or New run. |

Remaining limits: the operator's Gateway authority is the trust root — a
compromised Control UI session can start any authorized plan, as the operator
could; the page polls rather than streams; and run records are files in the
plugin's state directory with no retention policy beyond the 32 newest.


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
| Package tools running unmediated | A [host tool broker](tool-broker.md) now exists, and its own boundary is the table below. A package declaring a tool the host has no binding for is still refused before any token. |

The plugin backend remains trusted host code: it holds the control-plane bearer
token, opens the lease descriptor and owns the runner process. Binding an exact
model still requires the plugin-wide `llm.allowModelOverride` opt-in at the
OpenClaw layer; the per-run-plan discipline is this project's own.


## Tool broker boundary

[The broker](tool-broker.md) is the first thing that lets a downloaded
package's data leave this host. Its Python half lives in
`agentpkg.toolbridge`, a fourth trusted namespace that the control plane cannot
import; its implementations live in the OpenClaw plugin.

| Threat | Control and remaining limit |
|---|---|
| A package choosing where its data goes | A `tool.call` frame carries a declared tool id, a binding id and a binding digest. There is no URL, method, header, host method name, command or path in it, and the closed parameter set refuses one. The host resolves that triple against the bindings *this run* was constructed with — not the registry, and never anything the child said. |
| A package's declared endpoint read as authority | It is an upper bound, never a grant. A remote binding must land on a host in the package's `domains` **and** the linked network permission's `resources` **and** `policy.network.allowed_domains`, at the declared path and method, or it is `incompatible`. A package naming a destination cannot reach it, and a host cannot reach elsewhere behind that package's name. |
| A permission standing in for an approval | `Runtime.call_tool` refuses **every** declared tool that is not explicitly approved, not only side-effecting ones. The receipt records one decision per tool, separately from the permission grant, and a plan is refused when either is missing. An approval for a tool the package does not declare is refused rather than ignored. |
| Configuration inventing an implementation | A registry entry is a claim that code in the plugin can serve the tool. Operator configuration can disable, relabel, retarget, bound or credential a built-in; naming an unimplemented tool produces a `binding_unknown` note and no binding. |
| A host binding that speaks a different contract | Eight per-check comparisons against the signed declaration, including both schema digests. A host that declares no digest is `unverified`, which browser policy blocks by default rather than treating as pass. The runner then re-derives every one of those facts from the verified package **in its own process** and compares again, so a plan that described the package incorrectly is refused rather than believed. |
| An implementation swapped under an approval | A binding digest covers what the binding would *do* — tool, kind, version, origin, path, method, contract, bounds, and whether a credential is attached — and excludes liveness and labels. A moved digest makes the plan stale; the host refuses a `tool.call` whose digest is not the one the plan froze; a stale plan is never repaired, only replaced. |
| SSRF through a configured origin | HTTPS/443 only, exact origin/path/method, every resolved address classified against the same classes as `agentpkg.netaddr` (loopback, private, CGNAT, link-local, multicast, reserved, unspecified, cloud metadata, IPv4-mapped, 6to4, Teredo, NAT64), the socket pinned to a validated address with TLS still bound to the hostname, **no redirects**, bounded request and response, a deadline, and an `AbortSignal` that reaches the socket. No proxy, no cookie jar, no ambient credential. |
| A credential reaching the package | A credential belongs to the binding, is read at call time from this process's environment, and is attached as a header. It appears in no frame, plan, receipt, audit event, report, artifact, log or error — only `credentials: {required, configured}` does. `configured` is a boolean, so it can make a plan stale without the secret being hashed. Tests place a fake secret and assert its absence everywhere a caller can see. |
| A partially runnable package looking runnable | A `model` plan needs **every** declared tool bound, approved and required-permissions granted, or it is refused by name. The strictly smaller `tool_probe` authority exists for one call to one tool, binds no model at all, and is refused by `execution.run`. |
| A probe becoming a general client | It accepts a declared tool id and one of the host's own fixture ids. Every byte it sends is host code; a tool with no fixture cannot be probed. It constructs no model router, so a model call is impossible rather than absent. |
| An unbounded or orphaned call | Per-binding concurrency caps, `MAX_PENDING` on the wire, package and host per-tool call caps applied as `min()`, remote-call budgets charged for a remote binding even though the broker is local, per-call deadlines inside the node and run deadlines, and cancellation that propagates workflow → runtime → handler → `$/cancel` → `AbortSignal` → socket. |
| A result believed because it was configured | The host checks content type, size, status and JSON validity; the handler checks a closed envelope whose binding identity must echo the plan's; and `Runtime` then validates the payload against the **package's own** declared output schema. A service that is wrong, changed or lying fails the run. |

Two things remain out of scope. The broker is trusted host code in the Gateway
process, so an implementation added to this plugin is inside the trust
boundary, not outside it; and nothing here evaluates the quality of what a
service returns — a resolved identifier is a retrieval, not a verification of
the work behind it.


## Scholarly search, selected files and pacing (3B4)

The broker gained its first adapter that shapes a request from package
values, its first capability over a person's own files, and a pacer. Each one
is a new way for package data to reach something, so each gets an entry.

| Threat | Control and remaining limit |
|---|---|
| Package arguments shaping a request | The Crossref adapter reads exactly `query` and `limit` and refuses any other argument name; origin, path, method, parameter names, the selected field list and the headers are host constants. Values are percent-encoded as values. The mapping is identified by `implementation_id`/`implementation_version` (in the binding digest) and fingerprinted by a test, so it cannot drift without a version bump. |
| Upstream metadata carrying markup or instructions | Titles and abstracts are rendered to plain text with the Citation Resolver's own rules (a tested port of CPython's `HTMLParser` data path + `html.unescape`): markup is dropped, nothing is executed or fetched, and scripts' text is data. The package treats all of it as untrusted data; its evidence checks require verbatim quotes. A model can still be misled by text it reads — capability enforcement never relies on model obedience. |
| A service's rate limit turning into a failed run, or the host abusing a service | Per-binding `max_concurrent` and `min_interval_ms`, enforced process-wide; calls wait their turn inside their deadline instead of being refused, and nothing is retried. Crossref's advertised public-pool limits (concurrency 1, 1 request/s) are honoured. A sporadic 429 still fails the call as `tool_unavailable`. |
| A package naming a file to read | A package can only pass a string. Only ids of capabilities the operator selected for this session *and* attached to this run resolve; paths, traversal, `~`, `file://`, other sessions' ids and unknown ids get one indistinguishable refusal before any open. No path reaches a package, plan, audit, report, model or result. |
| Selection-time substitution (symlink, swap, growth, TOCTOU) | Selection requires a regular non-symlink file inside a configured root (realpath), opens it `O_NOFOLLOW`, checks the opened inode is the one checked, bounds bytes while reading, requires `%PDF-`, and copies it once into a `0400` file in a `0700` directory; every read re-verifies size and SHA-256. A copy that changed is refused, not parsed. |
| A hostile PDF | Parsed in a separate short-lived process given bytes on stdin and a minimal environment; it caps CPU, file size (zero) and address space (where the kernel allows), refuses encrypted documents and page/text excess, and does no OCR, rendering, script execution, link following or attachment extraction. The parent adds a deadline, SIGKILL on cancel, an output cap and a hash check of the answer. This is resource isolation for a trusted parser, not an OS sandbox; a parser vulnerability could still execute in that process with the operator's privileges. |
| Selected files lingering | Capabilities are in-memory, bounded (16 files, 64 MiB per session), expire with the session TTL, are released when the session closes, and the private directory is emptied at start and stop. |
| Progress as a side channel | `execution.progress` carries identifiers and counts derived from the audit — node ids, worker ids, call counts, tokens — never content, and the parent only records it. Node and worker ids can still reveal a graph's shape, as the audit already does. |
| Result selection steered by the package | The Crossref filter to scholarly work types is a host constant beside the selected fields; a package cannot widen it to supplementary files, reviews of other works or datasets, nor narrow it. It is part of implementation 0.2.0 and the fingerprinted mapping. |
| A slow or queued model call held open indefinitely | One completion is bounded by the operator's `modelCallTimeoutSeconds` (queueing at the model server included); the runner then cancels it, the cancellation aborts the provider request, and a host timer 30 s later is the backstop. The package's node timeouts and the run deadline still apply, and a call that outruns its declared output cap halts the run rather than being accepted. |
| Provider or service text reaching the audit through failures | A failed call records only the failing adapter's identifier-shaped code (`bridge_timeout`, `tool_unavailable`, …) as `reason`, never an error message; a refused call records which bound refused it (`context_window`, `worker_token_budget`, `global_token_budget`) and the numbers, never the request; a failed validation records the package-declared check (assertion index, kind, compared JSON pointers), never the values it compared. |

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

## Chrome Agent Browser (T7)

The Chrome Agent Browser ([guide](chrome-agent-browser.md)) applies the boundaries above with the
reference runtime's semantics, ported to a portable TypeScript core, inside a Manifest V3
extension. The same package checks, authorization, Run Plan, mediation and audit rules hold; the
conformance suite ([`conformance/`](../conformance/README.md)) shows the two runtimes give the same
fixture results and the same refusals on its listed cases. What changes is the host, and with it
four things this section states plainly.

**Chrome's network stack.** In the extension every request leaves through Chrome's `fetch`. Before
that, the core's URL gate (D-026, D-039) requires HTTPS on port 443 and a DNS name, refuses IP
literals in any spelling either URL parser accepts, `localhost` and `.local` names, userinfo and
backslashes, and refuses a URL its two parsers read differently; package and website downloads
follow no redirect; tool calls make one request at a time and follow no redirect, and only a call
whose package and binding both declare it a read is ever sent again (a transient failure, at most
twice, each a remote call within the run's budgets, D-152); a provider is
reached only at its own API origin, Ollama only on `127.0.0.1` or `localhost`. What an extension
cannot do is see where a DNS name resolves: it has no resolver and no socket, so the private-
address classification and connection pinning the Python runtime and the Chrome **CLI** perform
(`src/cli-net.ts`, D-067) are not performed in the extension. A public name that resolves to a
private or loopback address would be fetched by Chrome. The residual exposure is bounded by what a
request can carry (only a package-declared HTTPS endpoint, with the package's own schema-checked
arguments, no cookie or credential of the person's browsing, `credentials: "omit"`) and by what it
can reach (the person's own network). TLS and certificate checks are Chrome's.

**Storage at rest (T16, D-181, D-191; T19, D-221).** `chrome.storage.local` and IndexedDB live in the Chrome
profile directory, protected by the operating-system account and by whatever disk encryption the
machine uses. Since 0.2.0 the things that must not be readable there are not: provider API keys
and the memory's two keys (the HMAC key that digests records and the data key that seals their
sealed values) are kept only inside one encrypted envelope (`secretStore`): AES-256-GCM per entry
under a random master key, that master key wrapped under a key derived from the person's
passphrase with scrypt (N = 2^17, r = 8, p = 1, a random 16-byte salt). Since memory.v0 (T19) the
records themselves are IndexedDB rows (`memory_records`): every sealed value is replaced by
`sealed:omitted` in the row and sealed beside it under the data key, with the record id and the
pointer as associated data, so a box opens only for its record and field; titles, unsealed
fields, bodies and links are in clear in the profile directory by design (M-10: a locked store
still shows the graph, read-only). A wrong passphrase fails the wrap's
authentication and no entry is read; a tampered entry, IV or name fails its own. What this
defends: the profile directory read by another account, a backup, a synced or stolen disk, and
any extension or process that reads files but not Chrome's memory. What it does not defend, and
the design does not claim to: a process running as the user while the store is unlocked, which
can read Chrome's memory (the master key sits in `chrome.storage.session`, in the browser
process, for the extension's trusted contexts only; the execution host holds a run's key and
records for the run's duration); a keylogger at the passphrase; a compromised extension build.
The exposure is bounded in time by the idle lock (default 15 minutes, a sweep every minute, lock
on browser close, Lock now) and in scope by what a run is handed: the bound provider's key only,
and the memory snapshot only when the plan grants a record or binds a memory tool (D-195, D-226). A passphrase has no recovery: a
forgotten one means forgetting the keys and records. Package snapshots, run records, artifacts,
picked PDFs, settings, trust pins and the permission records stay in clear, as before, until the
person removes them. Test mode records outbound request bodies (prompts included) in
`observations` for the privacy checks; it is off by default. Nothing is written to `storage.sync`,
and nothing is sent anywhere at install or start.

**Host permissions (T16, D-182, D-190, D-193).** The extension's manifest holds the two loopback
names (Ollama on this machine) and nothing else; every HTTPS origin is optional. Chrome grants an
origin only when the person allows it, with their click as the gesture: the origin of a package
they open, the services that package declares and the model provider they chose (computed per
plan, listed under the plan's Technical details, verified again before Prepare and before Run), a
site they chose to detect agents on, a signed index or policy they add. The worker checks every
grant before any fetch and refuses `origin_not_granted` by name; the execution host's transports
refuse any destination outside the plan's origins (`origin_not_in_plan`); the core URL gate runs
beneath both, unchanged (D-010). What Chrome's grant adds must be stated precisely (review 1 of
T16): a host permission lets the extension read the response of *any* request to that origin and
read its pages; without one, a `fetch` from an extension page is still *sent*, as an ordinary
cross-origin request under the extension's CSP (`connect-src https:`, which no static policy can
narrow to origins chosen at run time), and its response is readable whenever the server answers
with permissive CORS headers, as the OpenAI and Anthropic APIs do. So for **egress** the
per-package boundary is the extension's own three checks, and Chrome's grant is a fourth check
only for origins that do not opt into cross-origin reads; for **page access** (the discovery
script, `activeTab`) Chrome's grant is the boundary. A grant is still what the person sees and
revokes, and the extension never fetches an origin it was not granted. Revoking a grant
(Settings → Permissions, or chrome://extensions) makes a plan that needs it block Run by name;
while "Detect agents on every site" is on, single origins cannot be revoked, since Chrome would
still grant them (the page says so).
Discovery reads a page only when the person asks: the action click, the context-menu item or the
keyboard shortcut grant `activeTab` for that tab, and the discovery script is injected there once;
"Always detect agents on this site" registers it for that site; "Detect agents on every site"
(off by default) registers it for `https://*/*`. The script still reads only
`link[rel="agent-package"]` elements and sends at most sixteen bounded link records; pages cannot
message the extension, and every message is validated structurally by its receiver (D-033). The
`tabs` permission is never requested: a tab's URL is known to the extension only through
`activeTab` or a granted origin. What remains broad is what the person made broad: the every-site
opt-in gives the discovery script every HTTPS page, as 0.1.0 had by default. The offscreen
execution host obeys only the extension's own service worker (D-070); the run messages that carry
a key travel over `chrome.runtime.sendMessage`, which every extension context receives, all of
which already hold the same storage authority (a point-to-point port is B-122).

**Extension review.** The extension is unminified, built reproducibly (the same sources and Node
release give the same zip bytes, and a content listing identifies a build across Node releases,
D-093), and carries the notices of exactly the libraries it bundles. That makes it reviewable; it
does not make it reviewed. A Chrome Web Store listing would add Google's review and automatic
updates, so a person would then also trust whoever controls the store listing to publish only
reviewed builds; the extension is not published (U5). Loading it unpacked trusts the checkout it
was built from. As everywhere in this prototype, a package's signature says which key signed it,
not that its workflow is safe, and the extension's own integrity rests on how it was obtained.

## Search and policy subscriptions (T8)

The Chrome Agent Browser can search signed agent indexes and follow one signed policy bundle
([guide](chrome-agent-browser.md#9-finding-agents-and-following-a-policy-t8);
formats in [`spec/extensions/`](../spec/extensions/)). Both are new inputs from the web; this is
what they can and cannot do.

**An index is metadata.** A compromised, stale or dishonest index can list a package that is not
what it says, at a URL the index publisher chose, or claim a digest or signer that does not match.
None of that grants anything: opening a result downloads the package under the same URL rules,
verifies it, evaluates its signer against the person's trust store and starts authorization from
nothing; the index's claims are compared with the bytes and a difference is shown. What an index can
do is steer attention: put a look-alike agent in front of the person. The defences are the agent
page (the trust words come from the person's own pins, not from the index), ranking only by the
person's trust in the claimed signer and the index's own order, and the person's choice of which
indexes to add. An index is fetched only from a URL the person added, under a key they pinned, never
in the background; a refresh that rolls the version back or reuses it for other content is refused.

**A policy is delegated trust and delegated defaults.** Whoever holds the policy's signing key can,
for everyone subscribed, make a publisher key trusted within the scope its anchor states and change
the defaults offered within each profile. That is the point of a policy (F-02), and it is why the
key is pinned by the person at subscription and the subscription is one explicit choice that names
its issuer. The bounds, which hold whatever a compromised policy says: the person's own trust pins
decide before any anchor (a publisher they pinned to another key stays an impersonation signal); an
anchor needs both a publisher id and a package-id prefix; issuer anchors confer nothing in v0; no
decision exceeds what the package declares, what the selected profile contains or the person's preset
duration for its kind (a payment is never more than `once`, `always` does not exist); a policy never
picks a personal record; caps only lower limits; every decision it made is labelled and can be
overridden; and unsubscribing withdraws everything at once, making the plans made under it stale. A
policy cannot make the runtime do anything a receipt does not record. What remains: a malicious
policy can make an untrusted publisher look trusted within its anchors' scope, so a person who
subscribes to a policy trusts its issuer as they would trust a key they pin themselves; a policy key
compromise is a trust-store compromise for everyone subscribed, until they unsubscribe. There is no
revocation feed (B-22): a withdrawn policy keeps applying until the person refreshes it (a newer
version) or unsubscribes, or until it expires.

**The NANDA resolver is a stub.** It defines how AgentAddr and AgentFacts map to a package
candidate and returns nothing in this build. Certification and evaluation fields from AgentFacts
would be shown as the registry's claims, never as trust.

## Native helper and macOS installer (T17)

The helper is optional (D-181): the extension is complete without it, and every path below falls
back to the passphrase. It is a Swift binary (`native-helper/`) that Chrome starts through native
messaging for one request and one reply, registered by the macOS installer for the extension's
own id only (`allowed_origins`, D-200, D-203).

**What it may do (D-204, a closed list).** Three operations, each with a closed set of fields;
anything else is refused with a code before anything is done: `keychain.wrap` seals the store's
32-byte master key with AES-256-GCM under a 256-bit key-encryption key that the helper creates and
keeps in a login-keychain item it owns (service `org.webagents.helper`), and returns the blob;
`keychain.unwrap` returns the master key from such a blob; `ollama.status` reports whether Ollama
is installed and running and whether the running server admits the extension's origin. Requests above
16 KiB are refused unread. The helper never receives a provider key, a record, an entry, the
passphrase or a package, and it holds no network boundary (B-191 stays in the extension).

**What it sees.** The master key, while wrapping and unwrapping it: keychain unlock cannot work
otherwise. What the extension stores beside the envelope (`secretKeychain` in
`chrome.storage.local`) is the blob and a check box sealed under the master key for this envelope
(its `created_at` in the associated data): neither opens anything alone, and a key the helper
returns is accepted only if it opens the check, so a stale blob, another envelope's blob or a
helper gone wrong leaves the store locked (`keychain_mismatch`) instead of installing a wrong key.

**Who may ask it.** Chrome passes the caller's origin as the first argument; the helper refuses
(`caller_refused`) unless it is an id in the installed `extension-ids.json` **and** its parent
process is code-signed by Google (team `EQHXZ8M8AV`, a Google Chrome bundle identifier). A script
that runs the binary directly gets nothing (`native-helper/scripts/smoke.mjs`). This raises the
bar; it is not a boundary against a process running as the user. The cheapest path needs no
Chrome copy at all: Chrome reads the per-user host manifest
(`~/Library/Application Support/Google/Chrome/NativeMessagingHosts/org.webagents.helper.json`)
before the system-wide one the installer writes, so such a process can point the name at its own
binary, which then receives the master key at the next **Turn on** (and, on an unlock, can return
a wrong key, which the check box refuses and which drops the record). **Turn on** is the moment
the key crosses the native port; only the passphrase-only setting (keychain unlock off) avoids it.
A second path is to start Chrome with an unpacked copy carrying the same public `key` (the key is
public by design) and ask for an unwrap. That attacker is already outside D-181's claim (D-204):
it can read Chrome's memory while the store is unlocked.

**What keychain unlock changes at rest.** With it off, the envelope opens with the passphrase
only. With it on, the envelope also opens with the keychain item, which macOS protects with the
login password: the profile directory and a backup of it remain useless without the passphrase or
the login keychain, but someone holding the disk (or a backup that includes the keychain) **and**
the login password can now open the store. A person who wants the passphrase to be the only key
leaves keychain unlock off; turning it off deletes the blob, and the uninstaller deletes the item.
The keychain item's default access list trusts the binary that created it (ad-hoc signed until
U8): another program reading it gets the keychain's own prompt, and so does a rebuilt helper.
Touch ID or a user-presence check on every unwrap needs the data-protection keychain and a signed
binary (U8; B-194). Unlocking stays a click: nothing unlocks the store without the person asking,
and the idle lock applies as before.

**The installer.** An unsigned, un-notarized `.pkg` until U8 (Gatekeeper warns; the README says
how to open it). Its scripts run as root and do only what `installer/macos/dry-run.sh` lists. When
Ollama is missing it is obtained through Homebrew (run as the person, never as root) or from the
pinned GitHub release, whose SHA-256 and signing team are checked before the app is moved into
`/Applications`; a mismatch installs nothing. `OLLAMA_ORIGINS` gets the extension's own
`chrome-extension://<id>` entries, so other extensions do not gain access to the local models; a
wildcard the person had set is kept as found. The login LaunchAgent runs one script as the person
that sets the variable and restarts Ollama only when Ollama rejects the extension's origin. The
uninstaller removes all of it and never Ollama or its models.

## User memory (T18, `memory.v0`)

[`spec/memory-v0.md`](../spec/memory-v0.md) replaces the personal vault with a user-owned graph of
Markdown records that packages may read by type, propose additions to, and keep private notes in.
The assets are the records themselves (a person's identities, instruments, profiles and
preferences, in a form a model can read), the sealed values among them, and the person's trust that
nothing is remembered or recalled without them knowing. The adversaries are the ones above with two
new reaches: a package whose run wants data to *leave* through memory, and one whose run wants an
instruction to *stay* in memory for the next run. The table states each threat, the control, and the
limit the design accepts; the spec's rule numbers (M-n) are the normative text.

| Threat | Control and remaining limit |
|---|---|
| Memory as an exfiltration channel: a run proposes a record whose fields or body encode data the person did not mean to keep, or a package declares a type whose schema invites a secret ("backup code", "card number") | A run writes nothing: proposals are reviewed one by one with the package's own rationale, the fields and the body in full, and provenance (package, version, run) on every accepted record (M-41, M-42). A proposal may name only the types the package declared, is bounded (8 per run, 16,384 characters of body each; M-39, M-40), and can carry no sealed value in any place: a sealed *field* is refused by name, and the whole document is scanned for the sealed *values* the run holds before the file is written, so an e-mail copied into a preference's value or a card token into a body fails the run and never reaches the Run Record (M-40 steps 3 and 7). A custom type cannot declare sealed fields (the policy schema admits no `sealed_fields`), cannot carry a property named like a sealed one (`email`, `phone`, `date_of_birth`, `payment_method_id`) at any depth of its schema whatever its other fields, and must have a closed schema (every object lists its properties with `additionalProperties: false`, no combinator or pattern that could hide a name), so the name check sees every name an instance can hold, cannot take a well-known id, and is shown and approved at first use (M-18, M-19). Limit: a person who accepts an opaque proposal has accepted it; review is the control, not inspection of meaning; a value the package paraphrases or encodes is not caught by an exact-value scan; the name rule guards against a careless schema, not a hostile one (a field renamed `e_mail` passes it), and review is the control for what such a field holds. |
| Poisoning: a proposal or an agent document plants an instruction that the next run's model reads as if it came from the person; a record the person imported from elsewhere does the same | Recalled bodies, agent documents and proposals are **data** in the model request (`data`, never `instructions`), framed by the host as untrusted content the person stored, and nothing in a record can name a tool, a permission or a destination (workflow.v0 §7, §8). The agent document is one package's own and reaches only that package (M-49, M-51); the person sees and clears it. Recall needs a declared type: no package reads a note it did not ask for by type (M-33, M-35). Limit: semantic compliance is the model's; a model that follows text inside a record can still misuse the authority the run already has, exactly as with a poisoned document today. |
| Cross-package leakage: one package reads what another proposed or wrote | Recall is per type, and only the person moves a record from "proposed by A" to "granted to B": a grant is one record, by id and digest, chosen at authorization (M-12, M-34). Custom types are qualified by the declaring package id, so no package can read another's custom records by naming the local id (M-18). Agent documents are never recall candidates (M-49), and their bodies are stored exactly as written, never resolved against the store, so a package cannot probe titles or ids through its own notes (M-3, N20); the view of a granted record carries a record id only for records the run was granted, a link to any other record being rendered as the text the person wrote without its id, escaped when that text is id-shaped, and a dangling link as `[[missing record]]`, which says only that the granted record links to nothing (M-15); acceptance restores those links by position when an update echoes the body (M-42); a proposal's body links are held to the run's grants like its `links` (M-40 step 6, M-42). The package layer of the graph shows the person which packages touched which records (M-23, M-29). Limit: a well-known type is shared by design; a travel profile granted to two airlines is known to both. |
| A sealed value reaches a model or a service that was not granted it | Two egress scans in both runtimes: every tool call's arguments and every model request body are searched for the run's **scan set**, the sealed values of every record of the store when the run was opened with the store (its plan grants a memory record or binds a memory tool, which needs the store unlocked under D-195) and nothing otherwise; a value not granted to the run may go nowhere, a granted one only to a tool linking its permission, and never into a model request (M-36, M-37). A run opened without the store holds no sealed value, so the empty set is sufficient and such a run runs while the store is locked. Limit: exact-value matching over host-held values, not data-loss prevention; a paraphrase or a derived value is not caught; a value that enters the run from outside the store (the task, a tool's answer) is not the guard's; unsealed fields are ordinary data. |
| The export file: a folder in clear on disk, synced or shared | Sealed values are omitted by default and written as `sealed:omitted`; including them needs the unlocked store and a confirmation that names what will be in clear (M-56). The folder carries ids, provenance and links, so a leaked export says what the person kept and from which runs. There is no encrypted export: the format's purpose is to be read by an editor. Limit: once exported in clear, the file is the person's to protect. |
| The unlocked store: a process running as the user while the memory is unlocked | As for the secret store (§ Chrome, storage at rest): sealed values are ciphertext at rest under the master key (M-10); everything else (titles, unsealed fields, bodies, links) is in clear in the profile directory, by design, so that a locked store still shows the graph, read-only: every write needs the unlocked store (M-10). The idle lock bounds the time the master key is resident; a run is opened with the store only when its plan needs it (D-195), and its tools answer only with the records the plan granted (M-35). Limit: a compromised account reads Chrome's memory; the design defends data at rest. |
| Silent accumulation: a memory that grows until it is a liability | Caps refuse new records and never evict (M-47); superseded, expired, unused and dangling records are listed for the person to delete (M-46); replacement by identity is offered, never applied (M-44). Limit: the person must act; the host proposes tidying and does not tidy. |
| The Python reference's memory folder (`agentpkg run --memory-dir`, T20) | The folder is an export with sealed values in clear, the operator's own choice for a command-line host, and `memory.key` (the HMAC key of the digests) beside it, created owner-only with `O_EXCL` and refused when others can read it (D-230). A run reads only the records its `--memory-grant` flags name, rechecks each digest at the read, and writes into the folder only the package's own agent document, after the run completed; its egress scans cover every sealed value of the folder. The folder is never rewritten otherwise and its `index.md` never regenerated. Limit: anyone who can read the folder reads its sealed values; it is a developer and test store, not the product's, which keeps them encrypted (M-10). |
| An old package meets a migrated host | The vault's three types stay answerable under their legacy ids through `personal.read`, with the same output contract and the same sealed fields (M-17); a package signed before memory.v0 runs with the grants it had. Limit: a legacy id is a projection; a field the new type added is not visible to the old package. |

What the memory does not claim: provenance is local (a record says which run proposed it; nothing
attests the run to a third party); acceptance is consent to keep, not verification of truth; the
text index and the graph index are derived and may lag a write until rebuilt; and none of this
prevents a person from typing a secret into a note, which the host will then hold in clear like any
body. The memory family of the enforcement catalog v2 (D-189) starts from the negative cases of the
spec's §10.

## Code in packages (T21, `compute.v0`)

[`spec/compute-v0.md`](../spec/compute-v0.md) lets a package ship WebAssembly core modules and run
them from `compute` nodes. Until now no package code ran anywhere (the paper's claim: a
capability-mediated runtime, not a code sandbox, because there was nothing to sandbox). With
modules there is, and the boundary is stated here as it is: what a module can and cannot do, what
bounds it, and what is trusted.

**What the boundary is.** A tier-1 module **imports nothing**: its import section must be empty
(C-14), so the module has no instruction that reaches outside its own linear memory. It has no
clock, no entropy, no file, no network, no host function, no knowledge of the host, the run or the
mode. The host gives it one byte string (the node's constructed input, after the node's own
`input_schema`) and reads one back (one JSON text, before the node's `output_schema`); nothing
else crosses (C-26). Every module is named in the graph by its SHA-256, which the integrity
statement and the signature cover, so the bytes that run are the bytes the publisher signed and
the person can see the hash before granting. Every call is bounded in memory (the module's own
declared maximum, which must fit the host's ceiling or the run is refused), wall time and, on the
reference, instructions, and is recorded in the audit with the bytes in and out. The person grants
code as a permission of kind `compute`, shown in words with the module hashes, and a policy may
deny the kind. Validation also decodes every function body and admits only a deterministic
instruction set, so a module that passes it computes the same thing on every conforming engine.

| Threat | Control and remaining limit |
|---|---|
| Code as an exfiltration or ingress channel: a module reads the person's data or reaches a network | No imports means no channel: the module's world is its memory and the input bytes (C-14, C-26). The data it sees is what the graph constructs for it under the role's `state_read`, which the memory.v0 scans do not cover: a sealed value routed into a compute node's input by the graph reaches the module, exactly as it would reach a `validate` node, and leaves only through the node's result into state. Limit: a module can transform data it was given into a form a later tool call carries out; the egress scans of memory.v0 still apply to that tool call (M-36), and the exact-value scan does not see an encoded value (as stated there). |
| Denial of service: a module that never returns, allocates without end, or recurses forever | Fuel and an epoch deadline in the reference; in Chrome each call runs in its own nested Worker, terminated at the call's wall bound, when its node times out and when the run is cancelled, so a runaway module costs one Worker and never the run's (C-30…C-33, D-250, D-251); memory bounded by the module's own declared maximum under the host's ceiling (C-31); a stack overflow is a trap. The call is abandoned at the bound; the node fails `compute_error`; the run reports it. Limit: wall time is a property of the machine; the same module may pass on one machine and reach the bound on another (fuel is the same everywhere, but only the reference meters it). |
| A hostile module that exploits the engine | The engine is **trusted**, like the JSON parser and the schema validator: this profile bounds what a module can do through the format (no imports, one memory with a maximum, the instruction gate) and the engine's own limits, not through an OS sandbox. A bug in wasmtime or V8 is a bug in the host. Limit: a person who grants code trusts the engine; the threat model says so rather than claiming a sandbox the format does not provide. The feature gate also keeps the engine's surface small: proposals with their own histories of engine bugs (threads, SIMD, GC, exceptions) are refused before compilation. |
| Nondeterminism as a covert signal or a correctness hazard: a module whose output differs between engines or runs | The instruction gate admits only deterministic instructions (C-18); each call is a fresh instance (C-20); the input is canonical JSON (C-21). Two sources remain the publisher's (C-47): NaN bit patterns (the reference canonicalizes them) and behaviour after a refused `memory.grow`. The conformance suite compares both runtimes' outputs byte for byte. Limit: a module that depends on either is caught by the comparison, not by validation. |
| Substitution: a different module than the one reviewed | The graph names the hash; the member is in the integrity statement; the signature covers both (C-12). A changed byte is `content integrity mismatch`; a changed declaration is `module_hash_mismatch`; an undeclared member is `module_undeclared`. Limit: review is of the bytes the person cannot read; what they can read is the publisher, the hash and the agent page's words. |
| Admitting WebAssembly in the extension: the extension pages' CSP gains `'wasm-unsafe-eval'` (T22, D-253) | The token permits compiling and instantiating WebAssembly and nothing else: `eval`, `new Function` and inline scripts stay refused (a unit test and `npm run check-pack` pin the exact `script-src` tokens). Modules are compiled only in the run's Worker, only from members the graph declares by hash, the signature covers and validation has read (C-11…C-19). Limit: any script of the extension could now compile WebAssembly; the extension ships no other module and loads no remote script (check-pack). |
| A module that writes text to look like data or an instruction | A module's output is data to the next node, never an instruction the runtime obeys, like a model answer (workflow.v0 §7); a malformed output fails the node and nothing the module wrote is ever recorded (C-43). Limit: the same as for a model answer that a later model reads. |

What the compute boundary does not claim: it is not an OS sandbox; it does not meter CPU in
Chrome (wall time only); it does not bound the total compute of a run (each call is bounded, and
the graph bounds the number of calls); it does not make a module's logic correct. The compute
family of the enforcement catalog v2 (D-189) starts from the negative cases of the spec's §10,
listed in `examples/compute/cases/cases.json`.

