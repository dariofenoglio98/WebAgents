# The Agent-Native Web: security and privacy model, version 2

**Status.** Version 2, approved at gate 2 (2026-11-02) and corrected after review 1 (2026-11-02;
§8). Normative for the Python reference (`agentpkg` 0.7.1) and the Chrome core (0.5.0) at `main`
`117afd8`, the commit every pointer below was checked against (T28 changes no code); the OpenClaw
plugin 0.1.0 is the frozen reference shell, and where its path differs from the core's the property
says so (P-8, P-13). §5.4 and §6 are **planned** and bind the tasks named there; they claim
nothing about today's code. The per-boundary implementation notes that this model replaces as the
primary statement are kept in [threat-model.md](threat-model.md); every claim there now cites a
property of §3.

## 0. How to read this document

This is the one written statement of what the runtime guarantees, for four readers: the person who
runs an agent, the publisher who writes one, the implementer of another runtime, and the reviewer
of the mechanism paper. It follows the shape of the WebAssembly security document: what is isolated,
what is independent of the host, what the host's policy adds on top, and an honest list of what is
*not* protected.

**A property** (§3) has seven fields: the statement; the adversary it holds against; the mechanism
in the Python reference and in the Chrome core, as `path:symbol` pointers; the conformance cases
that exercise it on both runtimes; the experiment that measures it; and the residual, what the
property leaves open. The ids `P-1`… are stable and are cited from the specifications, the
conformance cases, the enforcement catalog and the papers. `scripts/check_security_model.py` checks
that every pointer names an existing file and symbol, that every case id exists, that every
experiment id is one of the paper's, and that no public document uses a forbidden phrase.

**Wording.** The runtime *bounds*, *contains* or *refuses*. No sentence here claims that an
adversary is stopped outright: every property has a residual, and a claim without one is what the
next reviewer or attacker will falsify (the phrases `scripts/check_security_model.py` forbids are
D-319's). The design **bounds the effect of a compromise; it does not detect one**, and never
depends on detecting one.

**Vocabulary.** Package digest (the canonical integrity statement) ≠ archive SHA-256 (transport
bytes). Signature valid ≠ publisher trusted (a manual key pin, scoped to a package-id prefix).
Permission grant (a class of authority) ≠ tool approval (one host implementation). Requirement
(what the package needs) ≠ permission. Snapshot → receipt → Run Plan (immutable, hash-bound) →
Run Invocation (plan + input) → Run Record (status, usage, artifacts, hash-linked audit).
`personal.read` and `memory.read` request a host-owned resource by *type*; `once` is spent by the
first run. Fixture mode replays the package's own exact-input answers with no network and no model.

**Experiments.** The ids E1…E10 and EA name the mechanism paper's evaluation (E1 the enforcement
catalog with ablations on both runtimes; E2 a framework agent as the baseline; E3 the injection
campaign; E4 the memory leakage channel table; E5 the delegation bound; E6 the consent-bypass
catalog; E7 overhead; E8 the conformance report; E9 agent-native against the human web; E10 the
compromised model; EA an external attack suite ported as packages). Their protocol is published
with the paper; this model names which experiment measures which property.

## 1. Setting and trusted computing base

### 1.1 The parties

| Party | What it provides | What it controls | Trusted? |
|---|---|---|---|
| **The person** | the machine, the model binding, the keys, the grants, the records, the money | every decision the runtime asks for | the party the runtime serves; not a component |
| **The publisher** (creator) | the signed, data-only package: manifest, graph, skills, schemas, policy, fixtures, modules | every byte of the package and the key that signs it | no |
| **The origin** (host of the package) | the bytes over HTTPS; the HTML page that advertises them; the services the package declares on that origin | what it serves, when, to whom | no |
| **The model provider** | the model that fills the graph's answers: a local engine (Ollama today; in-browser inference planned) or a hosted API | the weights and the answers; a hosted provider also receives what it is sent | no (as a model); no (as a recipient of data) |
| **The tool provider** | a service behind a declared endpoint; or a host adapter the runtime ships (Crossref search, a JSON-HTTP binding, a PDF reader, host resources) | what it answers | a remote service: no; a host adapter: yes (it is runtime code) |
| **Peer agents** | the roles of a delegation network (one package today); other publishers' packages and remote agents later | what a role says to the next | no |
| **Memory records** | the person's records a package may read by type; proposals and notes written by earlier runs | their content and provenance | no (content is data) |
| **Index and policy issuers** | signed agent indexes (where packages are); signed policy bundles (delegated trust and defaults) | what they list and anchor | an index: no; a policy: within its anchors' scope, by the person's subscription (§1.5) |
| **The operator** | the host's configuration: binding files, limits, presets, pinned keys | the host | yes (the same person for the extension; the Gateway's operator for the OpenClaw shell) |

### 1.2 The one trusted component: the person's runtime

Everything else may be compromised. The runtime is trusted *for* specific things, listed here so
that the trusted base is measured rather than assumed. Pointers name the Python reference
(`agentpkg`) and the Chrome core (`chrome-agent-browser/src/core`).

| Component | Trusted for | Where |
|---|---|---|
| **Control plane** | opening and snapshotting bytes once; verifying integrity and signature; evaluating trust; showing what it verified; recording the person's decisions into a receipt bound to the digest; freezing the Run Plan; **never executing** (in the reference, a static scan and a fresh-interpreter check keep every interpreter, mediator and transport module out of it; in the extension, the service worker authorizes and the offscreen document's Worker runs: a separation by execution context, P-5) | `agentpkg/src/agentpkg/browser/control.py:ControlPlane`, `agentpkg/tests/test_browser_boundary.py`; `chrome-agent-browser/src/core/evaluation.ts`, `chrome-agent-browser/src/core/authorization.ts`, `chrome-agent-browser/src/core/runplan.ts` |
| **Execution host** | issuing one lease over the snapshot; re-verifying every fact the plan froze before anything runs; running the runner; writing the Run Record and the audit | `agentpkg/src/agentpkg/browser/lease.py`, `agentpkg/src/agentpkg/execution/session.py`; `chrome-agent-browser/src/core/execution/lease.ts`, `chrome-agent-browser/src/core/execution/runner.ts` |
| **Interpreter** (Agent Workflow, with the Memory, Compute, Conversations and Delegation runners) | enforcing the graph, the views, the schemas, the budgets and the deadlines; calling out only through the mediation layer; committing a wave atomically | `agentpkg/src/agentpkg/workflow.py`, `agentpkg/src/agentpkg/runtime.py`; `chrome-agent-browser/src/core/workflow/interpreter.ts`, `chrome-agent-browser/src/core/workflow/runtime.ts` |
| **Mediation layer** | the model router (exactly the bound model, the output schema, usage projection); the tool broker (exactly the frozen bindings, the address policy, the output contract); the memory resolver and the egress scans | `agentpkg/src/agentpkg/hostbridge/router.py`, `agentpkg/src/agentpkg/toolbridge/handler.py`, `agentpkg/src/agentpkg/memory/scan.py`; `chrome-agent-browser/src/core/models/router.ts`, `chrome-agent-browser/src/core/tools/broker.ts`, `chrome-agent-browser/src/core/memory/scan.ts` |
| **Host adapters** | performing exactly their bound contract and nothing beside it (the Crossref adapter reads two arguments; the JSON-HTTP adapter posts to one origin and path; the PDF reader parses in a bounded child; host resources answer the plan's grant) | `agentpkg/src/agentpkg/tools.py`, `agentpkg/src/agentpkg/hostfiles/pdf.py`; `chrome-agent-browser/src/core/tools/adapters/json-http.ts`, `chrome-agent-browser/src/core/tools/adapters/crossref.ts`, `chrome-agent-browser/src/core/tools/adapters/host-resource.ts`, the extension's PDF reader `chrome-agent-browser/src/extension/execution/pdf-reader.ts` (a nested Worker, `chrome-agent-browser/src/extension/execution/pdf-worker.ts`); the reference shell's `openclaw-agent-browser/src/tool-broker.ts` |
| **Stores at rest** | the integrity of trust pins, receipts, plans, run records and memory records; the secrecy of the secret store's entries (provider keys, the memory keys) | `agentpkg/src/agentpkg/browser/trust.py`, `agentpkg/src/agentpkg/browser/control.py` (the session's snapshots, receipts and plans), `agentpkg/src/agentpkg/memory/folder.py`; `chrome-agent-browser/src/core/trust.ts`, `chrome-agent-browser/src/core/secrets.ts`, `chrome-agent-browser/src/core/memory/store.ts` |
| **The platform beneath** | the operating-system account; the language runtime and its TLS and cryptography (Python 3.13 with `cryptography` for Ed25519; Chrome's WebCrypto, or `@noble/ed25519` where it is absent); the JSON parser and the JSON Schema validator; Chrome's `fetch`, certificate checks, CSP and extension isolation; for the OpenClaw shell, the Gateway process, its plugin runtime and the operator's configuration | not this project's code |

### 1.3 What each extension adds to the trusted base

Each freedom widens the trusted base by exactly one component, stated here because a reviewer
who finds an unstated widening will doubt the rest.

| Extension | Adds to the trusted base | Why it must be trusted |
|---|---|---|
| **Agent Memory** (`memory.v0`) | the memory store, the digest key and the data key, the scan set of sealed values | the scans (P-13) can only refuse values the store told them about; a store that lies about which values are sealed defeats the scan |
| **Agent Compute** (`compute.v0`) | the WebAssembly engine (wasmtime on the reference; V8 in Chrome and Node) | a module is bounded through the format and the engine's own limits, not an OS sandbox: **a bug in the engine is a bug in the host** |
| **Agent Conversations** (`conversation.v0`) | the consent host: the surface that shows a card and returns the person's answer (an extension page; in tests, a transcript) | the decision is the host's record of the person's answer; a host that answers for the person is the person |
| **Agent Delegation** (`network.v0`) | the worst-case analysis and the transition check | the "at most" shown before a run is a theorem about the declaration computed by this code; the runner recomputes it from the verified bytes, so the plan cannot understate it, but both computations are trusted code |

### 1.4 The shells

The core is one thing; three shells host it, and each adds a trusted surface of its own.

- **The OpenClaw plugin** (the frozen reference shell): the Gateway process and the plugin backend
  are trusted host code; they hold the control plane's bearer token, open the lease descriptor and
  own the runner process. The operator's Gateway authority is the trust root: a compromised Control
  UI session can start any authorized plan, as the operator could. Two of its paths fall short of
  the core's and are stated where they matter: its broker classifies a tool connection's address but
  does not yet pin the connection (B-116; P-8), and it opens a run without a memory store, so its
  model requests are not scanned for sealed values and its host resources are scanned on tool
  arguments only, to a bounded depth (B-114, B-265; P-13).
- **The Chrome extension**: Chrome is trusted for the network stack, TLS, storage, CSP and the
  isolation of extension contexts; the extension's own pages are trusted as the person's surface;
  the service worker authorizes and never executes; the offscreen document runs each run in a
  dedicated Worker and each compute call in a nested Worker (a thread boundary, not a process).
  What the extension cannot do, stated once: it has no resolver and no socket, so it cannot
  classify where a DNS name resolves (P-8).
- **The Node CLI**: the same core with a transport that does classify and pin addresses
  (`chrome-agent-browser/src/cli-net.ts`); it is the conformance suite's Chrome half.

### 1.5 Delegated trust: acts of the person that widen what is trusted

Some things are trusted only because the person chose to trust them, and the model says what each
choice delegates. **A trust pin** makes one key trusted for one package-id scope (P-2). **A policy
subscription** (Chrome core) makes the issuer's anchors trusted within their scopes and adopts its
defaults within the declaration and the preset's ceiling; it can lower a limit and never raise one,
and it is one explicit, revocable choice (P-4, P-18). **An operator binding file** is trusted like
every other host setting: it can only add entries of the service-neutral JSON-HTTP adapter, which
still have to land inside the package's declared domain and be approved by the person. **A host
adapter** the operator approved is inside the trusted base (§1.2). **A preset** (Chrome core)
pre-accepts, within the declaration, the steps the person chose it for, never a payment and
never a personal record (P-4, P-16).

### 1.6 Outside the trusted base

The package and its publisher; the origin and its pages; the model, local or hosted, and its
provider; every remote tool service and its answers; every peer role and message; the content of
every memory record, proposal and note; index issuers; the content of policy bundles beyond what
§1.5 delegates; the network between the runtime and every service (TLS is trusted; DNS answers
are classified, not trusted). Also outside the claim, and said so in §4: a compromised operating
system, browser or language runtime; another process running as the person; a stolen key.

## 2. Adversaries

### 2.1 The table

Each row names what the party controls, what it can read, what it can emit, what it wants, and
what it cannot do by construction (the properties of §3 that bound it). A party may be
compromised, careless or merely faulty; the cause is never assumed and nothing depends on it.

| Adversary | Controls | Can read | Can emit | Goals | Cannot do by construction |
|---|---|---|---|---|---|
| **A-PKG** the package or publisher, and any distributor between them and the person | every byte of the package and the key that signs it; a distributor controls the bytes in transit | nothing of the person's before authorization; after it, what the person granted, through the graph | any declaration, skill text, schema, fixture, module; any later version | run code; reach undeclared destinations; obtain more than the person grants; keep or leak the person's data; spend more than declared; make an action look consented | change bytes after verification (P-1); be trusted by signing (P-2); execute anything but a bounded module (P-3, P-15); widen a grant (P-4); change the plan (P-5); reach an undeclared destination (P-8); overspend (P-9); move a sealed value to a model or an unlinked tool where the run holds the store (P-13); write memory without review (P-14); skip a consent step (P-16) |
| **A-ORIG** the origin, or a page on it | what it serves: the package bytes, the HTML, the services' answers, redirects | the requests the runtime sends it (arguments of approved tool calls, nothing else) | any bytes, any `<link>`, any response | substitute a package; vouch for one; reach the person's machine; inject instructions through responses | make a substituted package verify (P-1); make discovery grant anything (P-18); be followed through a redirect or to a private address (P-8); make a response an instruction (P-6, P-18) |
| **A-MODEL** the model, local or hosted (§2.2) | every answer it gives, on every call | the request: the task, the skill, the data the graph routed to its role; never a sealed value where the run holds the store (P-13); never another role's view (P-17) | any JSON within the schema; any choice among allowed values; any text in free-text fields | exfiltrate granted data; misuse an approved capability; persuade the person; loop or fan out; spend | execute or command (P-6); call a tool the graph did not place (P-6, P-8); route outside the enum or the caps (P-7); widen a grant (P-4); see or emit a sealed value (P-13); decide a consent step (P-16); spend past a reported overrun (P-9); hide an attempt (P-11) |
| **A-PROV** the model provider as a recipient | what it receives and keeps | the model requests it is sent | its answers | retain or correlate what it is sent | receive a sealed value where the run holds the store (P-13); receive what the plan does not route to the model role (P-17); the tiers of §5 (planned) |
| **A-TOOL** a remote tool service, or its compromised response | what it answers to approved calls | the arguments of calls bound to it | any JSON, markup, text, status, headers | inject instructions; return out-of-contract data; redirect; stall | be reached without a declaration, binding and approval (P-8); redirect the runtime (P-8); be used outside its output schema (P-6, P-10); stall past the deadline (P-9); turn text into authority (P-18) |
| **A-PEER** a peer role of a network (later: another publisher's package or a remote agent) | its message to the next role; its patch to the shared state within its view | its own view of the state and the message it received | a message under the declared schema; a route choice among the enum | steer the next role; read or write beyond its view; loop | read or write outside its view (P-17); route outside the edges and caps (P-7); call tools its worker was not given (P-4) |
| **A-MEM** a memory record: poisoned, imported, or proposed by another publisher | its own content | — | text, fields, links that a later run reads as data | plant an instruction the next run follows; leak through a proposal; persist | be read as an instruction (P-14); name a tool, permission or destination (P-14); be recalled without a declared type and the person's choice (P-12); be written without review (P-14) |
| **A-ISS** an index or policy issuer | what it lists; what its anchors trust; which defaults it sets | — | signed documents the person subscribed to | put a look-alike agent in front of the person; make an untrusted key trusted; loosen defaults | grant anything by listing (P-18); raise a limit, pick a record, pre-accept a payment or exceed what a package declares (P-18, P-16); override the person's own pins (P-2) |
| **A-NET** an on-path or DNS adversary | DNS answers; the path (TLS assumed sound) | ciphertext | a rebinding answer; a private address for a public name | reach the person's network through the runtime | be followed to a non-public address or through a redirect where addresses are classified (P-8; the extension's limit and the reference shell's unpinned connection are stated there) |

### 2.2 The compromised model

The model is the one adversary that sits inside the computation, so it is stated on its own.
**Capabilities assumed.** On any call, triggered by any content it reads (a tool output, a page, a
memory record, a peer's message, the task) or untriggered and persistent, the model may return any
JSON document its schema admits: any string in a free-text field, any value among an enum's allowed
values, any number; in a network, any target among the enum the runtime built. It may do so while
its visible reasoning denies it. The cause (poisoning at training time, a planted backdoor, a fault,
a harness defect) is never assumed; three strengths are to be evaluated in E10: a triggered
backdoor, an untriggered poisoned model, and a wrapper that rewrites any model's output on trigger
(the worst case, model-independent).

**What it cannot do by construction.** Emit a call the graph did not place; name a destination;
change the plan or a grant; read outside its role's view; see a sealed value where the run holds the
store; decide a consent step; spend past a reported overrun; leave no trace: every attempt it can
express is a schema-conforming answer, and every call and refusal is in the audit (P-4…P-9, P-11,
P-13, P-16, P-17).

**What counts as a boundary reached** (the oracle's definition for the catalog and the
compromised-model experiment): (a) bytes leave toward a destination the plan does not name;
(b) granted data that the plan does not route to a recipient appears in an approved tool's
arguments bound for that recipient (today: a sealed value in a tool that does not link its
permission; with Agent Data Flow, any labelled field outside its recipient set); (c) a proposal
or an agent note carries granted sealed data (today) or labelled data (later); (d) a consequential
tool is dispatched without the person's decision; (e) usage above the envelope. A covert choice
among allowed values (which flight, which word) is **a measured residual, not a boundary**, unless
the plan's recipient set excludes it.

**What a compromised model can still do**, stated in every paper and pitch: give wrong or slanted
answers; misuse a tool the person approved, within its approval and the graph's arguments; leak
through covert channels (timing; which of the allowed values it picks; the length or existence of
an answer); try to persuade the person through the text it writes; burn the run's own budget or
stall to a deadline, a denial the person sees (§4). The runtime bounds the effect of a compromise;
it does not detect one.

### 2.3 Combined adversaries

The common attack is a combination: injected content (A-ORIG, A-TOOL, A-MEM, A-PEER) that a model
(A-MODEL) follows. The contract confines **authority, not belief**: a steered model can misuse
what the run already holds, within the graph and the grants, and nothing more. Everything a
combination can reach is the union of what its parts can reach, because no part can widen another's
authority (P-4). A colluding publisher and model (a package built for a backdoored model) can
reach exactly what the package declares and the person grants; the design makes that visible at
authorization rather than assuming good faith.

## 3. Properties

Properties are grouped by what they bound: what runs (P-1…P-3), what authority a run holds (P-4,
P-5), what a model and the graph may do (P-6, P-7), how a run reaches the world (P-8…P-11), the
person's data (P-12…P-14), the extensions (P-15…P-17), the web's inputs (P-18) and the Chrome shell
(P-19). The conformance case ids are those of [`conformance/`](../conformance/README.md) (224 cases
agreed by both runtimes at `d5631ed`, `conformance/results/2026-10-25T02-53-07-223Z/`); the
spec-numbered cases (memory N1…N22, compute N-1…N-27, conversation N-1…N-43, network N-1…N-46) are
the same cases by their specification numbers.

### P-1 · Integrity and provenance of what runs

**Statement.** The bytes a run executes are the bytes that were verified. Every payload member is
named in the integrity statement with its SHA-256; the publisher's Ed25519 signature covers the
statement under a domain separator; a package is parsed under closed limits (no duplicate or
unsafe names, no duplicate JSON keys, no remote schema, bounded sizes); the control plane captures
the bytes once into a private snapshot and every later answer, and the run itself, come from that
snapshot; the Run Record names the package digest and the archive hash, and the signer directly
(the reference's report) or through the plan's hash it records (the Chrome core and the reference
shell).

**Adversary.** A-PKG as a distributor or a publisher who changes a member after signing; A-ORIG
substituting bytes; a race between verification and loading.

**Python reference.** `agentpkg/src/agentpkg/package.py:_archive_payload`,
`agentpkg/src/agentpkg/package.py:integrity_statement`,
`agentpkg/src/agentpkg/signing.py:check_signature`,
`agentpkg/src/agentpkg/browser/control.py:ControlPlane.open_url`,
`agentpkg/src/agentpkg/execution/artifact.py:verify_execution_artifact`.

**Chrome core.** `chrome-agent-browser/src/core/archive.ts`,
`chrome-agent-browser/src/core/signature.ts:checkSignature`,
`chrome-agent-browser/src/core/evaluation.ts:evaluateSnapshot`,
`chrome-agent-browser/src/core/execution/artifact.ts:verifyExecutionArtifact`.

**Conformance.** `tampered-bytes/crc`, `tampered-bytes/content`, `compute/tampered-archive`,
`compute/module-hash-mismatch`, `compute/module-too-large`, `compute/module-bad-magic` (compute
N-8, N-15, N-16).

**Experiment.** E1 (the verification family of the first catalog is cited; the second catalog adds
the module cases), E7 (the cost of hashing and verification), E8.

**Residual.** The signature says which key signed, not that the content is safe or reviewed. A
stolen publisher key signs a valid package; there is no revocation, transparency log or publisher
credential yet (planned: the supply chain, W6). The runtime itself is trusted as obtained.

### P-2 · A valid signature is not a trusted publisher

**Statement.** Verification reports which key signed. Trust is a separate state: a pin the person
made (or, in the Chrome core, a policy they subscribed to) for a key within a package-id scope.
Signature status and trust status are reported and rendered as separate facts; an embedded key is
never a trust anchor; a claimed publisher pinned to another key reports `mismatch`. A key rotation
and an impersonation are indistinguishable in the bytes, by design; only the person's out-of-band
decision on that fingerprint resolves them. A scope is a package-id prefix: the narrowest pin names
one package id in full, and a shorter prefix covers every id that begins with it.

**Adversary.** A-PKG signing under another publisher's name; A-ISS or A-ORIG vouching for a
package.

**Python reference.** `agentpkg/src/agentpkg/browser/trust.py:TrustStore.evaluate`,
`agentpkg/src/agentpkg/signing.py:verify_package`,
`agentpkg/src/agentpkg/browser/evaluation.py:signature_report`.

**Chrome core.** `chrome-agent-browser/src/core/trust.ts:evaluateTrust`,
`chrome-agent-browser/src/core/signature.ts:verifyWithTrustedKey`,
`chrome-agent-browser/src/core/evaluation.ts:publisherReport`,
`chrome-agent-browser/src/core/policies/apply.ts:anchorVerdict`.

**Conformance.** `unpinned-key`, `wrong-key` (a pin withdrawn after the plan froze is P-5's
`control-plane/stale_trust_revoked`).

**Experiment.** E1 (the trust family of the first catalog is cited), E8.

**Residual.** No PKI, revocation feed or transparency log (W6). A policy issuer's anchor is trusted
within its scope exactly as the person's own pin would be (§1.5). A person who pins the wrong key
has pinned it.

### P-3 · Data only

**Statement.** No member of a package is executed as code by the runtime. Skills are text handed to
a model as instructions; schemas are validated as data under a closed vocabulary with no remote
reference; the graph is interpreted by a fixed vocabulary of node types and data constructors; a
noncritical manifest extension can describe, never grant. The only executable members are
WebAssembly modules, under P-15. The runtime and the shells contain no package-specific code: new
behaviour enters as package data or as a host adapter behind an abstract capability.

**Adversary.** A-PKG shipping a script, an alternative executable representation, or a schema
or extension shaped to be obeyed.

**Python reference.** `agentpkg/src/agentpkg/package.py:_check_payload`,
`agentpkg/src/agentpkg/validation.py:validate_payload`,
`agentpkg/src/agentpkg/validation.py:schema_validator`,
`agentpkg/src/agentpkg/workflow_validation.py:validate_workflow`.

**Chrome core.** `chrome-agent-browser/src/core/validation.ts:validatePayload`,
`chrome-agent-browser/src/core/schema.ts`,
`chrome-agent-browser/src/core/workflow-static.ts:validateWorkflow`.

**Conformance.** Every fixture-parity case (`meeting-agenda-0.2.2/fixture`, `webair-0.4.0/fixture`,
`literature-review-0.2.5/fixture` and the later versions); `compute/module-undeclared-member`,
`compute/module-unknown-in-node` (compute N-9, N-10).

**Experiment.** E1, E7, E8.

**Residual.** The JSON Schema validator runs in process: a pathological schema costs CPU. A skill
can persuade a model (belief, not authority; §4).

### P-4 · Declared at most, granted no more

**Statement.** A package declares what it needs: permissions by kind and resources, tools with
their endpoints and schemas, model requirements, resource types, modules, consent steps, roles
and caps. The person's runtime grants; the run holds the intersection, frozen in the receipt and
the Run Plan. Every tool needs its permission granted **and** its own approval; a declared
endpoint is an upper bound, never a grant; a required permission denied refuses the plan at
preparation (the `agentpkg run` CLI, which prepares no plan, refuses at the node:
`denied-permission/required` documents the difference), an optional one denied refuses the node
that needs it. Nothing a skill says, a model emits, a tool returns or a record contains can widen
a grant. The Chrome core's presets, profiles and policies pre-decide or select within the
declaration and the preset's ceiling (a policy can lift an optional permission the preset left
denied up to that ceiling, and approve a tool by default), never beyond the declaration, and the
provenance of every decision is recorded; the reference has none of the three.

**Adversary.** A-PKG; A-MODEL; injected content (A-ORIG, A-TOOL, A-MEM, A-PEER); A-ISS.

**Python reference.** `agentpkg/src/agentpkg/browser/authorization.py:build_receipt`,
`agentpkg/src/agentpkg/browser/authorization.py:blocking_reasons`,
`agentpkg/src/agentpkg/browser/runplan.py:preparation_blockers`,
`agentpkg/src/agentpkg/runtime.py:Runtime._authorize`,
`agentpkg/src/agentpkg/runtime.py:Runtime.call_tool` (every tool needs its own approval),
`agentpkg/src/agentpkg/runtime.py:check_approved_tools` (an approval for an undeclared tool is
refused),
`agentpkg/src/agentpkg/execution/policy.py:normalize_grants`,
`agentpkg/src/agentpkg/execution/policy.py:check_tools`.

**Chrome core.** `chrome-agent-browser/src/core/authorization.ts:buildReceipt`,
`chrome-agent-browser/src/core/authorization.ts:blockingReasons`,
`chrome-agent-browser/src/core/runplan.ts:preparationBlockers`,
`chrome-agent-browser/src/core/workflow/runtime.ts:checkGrants`,
`chrome-agent-browser/src/core/workflow/runtime.ts:checkApprovedTools`,
`chrome-agent-browser/src/core/execution/policy.ts:checkTools`,
`chrome-agent-browser/src/core/policies/apply.ts:applyPolicy`.

**Conformance.** `missing-approval`, `denied-permission/required`, `denied-permission/optional`,
`denied-permission/optional-in-a-map`, `control-plane/profile_search`,
`control-plane/partial_approvals_without_profile`, `compute/permission-denied`,
`compute/permission-missing`, `memory/n3-read-denied`, and `once` consumed at its first use
within a run: `once-overused`, `network/once-memory`, `network/once-model` (compute N-12, N-19;
memory N3).

**Experiment.** E1 (the authorization family of the first catalog is cited; the second catalog's
four families), E3 (an injection cannot widen a grant), E6 (CB-2, CB-6), E10 (a compromised model
cannot widen one).

**Residual.** A person who grants broadly has granted broadly: a `session` grant covers every run
under its receipt, and a grant is of a kind, not of a purpose. `always` is in the grant
vocabulary both interpreters accept, but no shell offers it; a remembered, revocable decision is
planned (§5.4).

### P-5 · Prepare, re-verify, then run; what authorizes never runs

**Statement.** The Run Plan is immutable and hash-bound: it freezes the package digest and archive
hash, the signer and the trust state, the receipt, the resource grants by opaque id and keyed
digest, the tool bindings by digest, the model binding, the limits and, for a network, the
envelope. Execution begins only under a one-time lease over the snapshot, after the host
re-verified every one of those facts and the runner re-derived the package's identity (archive
hash, digest, signer) and its declarations from the verified bytes: in the reference in its own
process, in the Chrome core in the host's process, which the extension places in a dedicated
Worker. Trust is the host's decision, which the runner cannot re-evaluate: it refuses a signer
other than the plan's. Anything that changed (bytes, trust, bindings, resources, model
availability or identity, receipt expiry) refuses as stale and is replaced, never repaired. A
`once` grant is spent by the first lease. Authorization produces a receipt, never a run; in the
reference, the component that shows and authorizes cannot import the interpreter (a static scan
and a fresh-interpreter check enforce it), and in the extension the separation is by execution
context (the service worker authorizes, the offscreen document's Worker runs), not by an import
rule: the service worker imports a digest helper from the interpreter module.

**Adversary.** A-PKG, A-ORIG or A-ISS changing the world between consent and start: a re-signed
package, a withdrawn pin, a swapped binding or record, a replayed plan; a stale page authorizing
other bytes.

**Python reference.** `agentpkg/src/agentpkg/browser/runplan.py:build_run_plan`,
`agentpkg/src/agentpkg/browser/runplan.py:preflight`,
`agentpkg/src/agentpkg/browser/runplan.py:tool_staleness`,
`agentpkg/src/agentpkg/browser/control.py:ControlPlane.issue_execution_lease` (the `once`
receipt spent at the first lease),
`agentpkg/src/agentpkg/browser/lease.py:issue`,
`agentpkg/src/agentpkg/execution/session.py:normalize_execution_plan`,
`agentpkg/src/agentpkg/execution/session.py:ExecutionSession`,
`agentpkg/tests/test_browser_boundary.py`; the reference shell's start check
`openclaw-agent-browser/src/preflight.ts:revalidate`.

**Chrome core.** `chrome-agent-browser/src/core/runplan.ts:buildRunPlan`,
`chrome-agent-browser/src/core/runplan.ts:preflight`,
`chrome-agent-browser/src/core/execution/lease.ts:LeaseRegistry`,
`chrome-agent-browser/src/core/execution/plan.ts:executionPlanFromRunPlan`,
`chrome-agent-browser/src/core/execution/runner.ts:ExecutionSession`.

**Conformance.** `control-plane/stale_trust_revoked`, `control-plane/stale_tool_changed`,
`control-plane/once_replayed` (the receipt spent by the first lease; `once` within a run is P-4's),
`network/execution-layer-envelope` (network N-28, N-29).

**Experiment.** E1 (the plan-binding family of the first catalog is cited; the envelope-reservation
profile of the second), E6 (CB-4, CB-5), E7 (preparation and re-verification cost).

**Residual.** The plan records the person's decision at one moment; a receipt that outlasts the
run keeps its authority until the run ends. The shell that starts a run is trusted (the operator's
Gateway; an extension page).

### P-6 · A model's output is data

**Statement.** No model output is executed or read as a command. A model answers a declared task
with one JSON document, validated against the node's bundled schema and the package's answer
checks; the document becomes state that later nodes read through declared constructors. There is
no shell, no free tool call and no text the runtime obeys: a tool call exists only as a node the
publisher placed in the signed graph, with arguments the graph constructs; a model's only choices
are the values its schema admits and, in a network, a target among the enum the runtime built. A
non-conforming answer is refused, never repaired: the reference asks no model twice, and the
Chrome core may ask again at most twice (`MAX_REASKS`) with a host-written line, within the same
bounds. Both routers take the answer as one JSON document, found as a fenced document or as the
first balanced object in prose, and edit nothing inside it.

**Adversary.** A-MODEL (§2.2); A-ORIG, A-TOOL, A-MEM and A-PEER as sources of text a model follows.

**Python reference.** `agentpkg/src/agentpkg/runtime.py:Runtime`,
`agentpkg/src/agentpkg/hostbridge/router.py:parse_structured`,
`agentpkg/src/agentpkg/workflow_assertions.py:check_answer`,
`agentpkg/src/agentpkg/workflow_values.py`.

**Chrome core.** `chrome-agent-browser/src/core/models/router.ts:BoundModelRouter`,
`chrome-agent-browser/src/core/models/structured.ts`,
`chrome-agent-browser/src/core/workflow/runtime.ts:MAX_REASKS`,
`chrome-agent-browser/src/core/workflow/assertions.ts:checkAnswer`,
`chrome-agent-browser/src/core/workflow/values.ts:evaluate`.

**Conformance.** `schema-invalid-output`, `answer-check-refused`, `answer-checks/fixture`,
`network/target-not-in-enum`, `network/message-invalid`, `conversation/consent-text-not-string`
(network N-34, N-35; conversation N-36).

**Experiment.** E10 (attempts, attempts reaching a boundary, data leaked, utility, cards shown,
against a shell-tool harness, the same with network off, and a framework agent with a policy
layer), E3, E1 (the output-integrity family of the first catalog is cited).

**Residual.** The answer's quality and slant; persuasion of the person through text; misuse of an
approved tool within its approval; a covert choice among allowed values (§2.2, §4).

### P-7 · Control flow is the publisher's signed graph

**Statement.** The graph is acyclic and fixed before signing; a wave's state commits atomically or
not at all (a tool dispatched in a wave that then fails is not undone). The only loop is Agent
Delegation: the model chooses the next role among the targets the runtime admits (declared edges
with uses left, under the hop cap and the target's activation cap); the worst case over every
admissible walk (model calls, compute calls, remote calls, tokens, seconds) is computed from the
declaration, shown before the run as "at most", checked at validation against the package's budget
(tokens and remote calls) and admitted before the first activation against what the run has left,
with nothing held (P-9). A refused route is a visible failure, after the Chrome core's bounded
re-asks (R-28), never a silent extra call.

**Adversary.** A-MODEL or A-PEER looping, fanning out or routing outside the edges (termination
poisoning, inter-role injection); A-PKG declaring a bound its own budget cannot hold.

**Python reference.** `agentpkg/src/agentpkg/workflow_validation.py:validate_workflow`,
`agentpkg/src/agentpkg/workflow.py:Workflow`,
`agentpkg/src/agentpkg/delegation/analysis.py:worst_case`,
`agentpkg/src/agentpkg/delegation/analysis.py:enumerate_walks`,
`agentpkg/src/agentpkg/delegation/runner.py:_check_transition`,
`agentpkg/src/agentpkg/runtime.py:Runtime.reserve_network` (an admission check: nothing is held).

**Chrome core.** `chrome-agent-browser/src/core/workflow-static.ts:validateWorkflow`,
`chrome-agent-browser/src/core/workflow/interpreter.ts:Workflow`,
`chrome-agent-browser/src/core/network/analysis.ts:worstCase`,
`chrome-agent-browser/src/core/network/runner.ts:runNetwork`.

**Conformance.** `network/hops-exhausted`, `network/edge-exhausted`, `network/role-exhausted`,
`network/edge-undeclared`, `network/end-not-allowed`, `network/bound-exceeds-budget`,
`network/reservation-refused`, `network/fixed-route-exhausted`,
`network/execution-layer-envelope`, `travel-network/fixture` (network N-25…N-27, N-31…N-33, N-37,
N-39).

**Experiment.** E5 (the bound holds on every run; tightness as envelope over observed and greedy
over exact; LoopTrap and AiTM variants; a framework's handoffs as the baseline), E1 (family N),
E7 (the envelope's cost).

**Residual.** The bound is a relaxation, loose on some shapes; the sense of the walk and the
composed answer are the model's; a provider that reports usage above its reservation is P-9's
residual.

### P-8 · Tools only through declared, bound, approved bindings under the address policy

**Statement.** A tool call carries a tool id, a binding id and a binding digest, never a URL,
method, header, path or command; the host resolves the triple against the bindings the plan froze.
A remote binding must land on a host inside the package's declared domains, the linked network
permission's resources and the policy's allowed domains, at the declared path and method, or it is
incompatible; the binding digest covers what the binding would do, so a changed implementation
makes the plan stale. Transport: HTTPS on port 443 only, no redirect followed, bounded request and
response, a deadline, no cookie and no ambient credential; in the Python reference's own
transport, in the Node CLI and in the reference shell's broker every resolved address is
classified against the public-address policy (loopback, private, link-local, multicast, reserved,
cloud metadata, mapped and tunnelled forms); the Python transport and the Node CLI then pin the
connection to the classified address with TLS bound to the name, while the reference shell's
broker classifies the first resolution but does not yet pin the connection (B-116: Node resolves
the name again when it dials). A binding's credential is read at
call time and appears in no frame, plan, audit, report or error.

**Adversary.** A-PKG naming a destination; A-MODEL or injected content shaping arguments; A-NET
with a rebinding answer; A-TOOL redirecting.

**Python reference.** `agentpkg/src/agentpkg/toolbridge/handler.py:HostBridgeToolHandler`,
`agentpkg/src/agentpkg/toolbridge/binding.py:normalize_tool_binding`,
`agentpkg/src/agentpkg/browser/hosttools.py:evaluate_binding`,
`agentpkg/src/agentpkg/browser/hosttools.py:binding_digest`,
`agentpkg/src/agentpkg/netaddr.py:public_address_reason`,
`agentpkg/src/agentpkg/tools.py:validate_https_url`,
`agentpkg/src/agentpkg/browser/fetch.py:resolve_public_addresses`; the reference shell's broker
`openclaw-agent-browser/src/tool-broker.ts:ToolBroker`,
`openclaw-agent-browser/src/tool-broker.ts:addressRejection`.

**Chrome core.** `chrome-agent-browser/src/core/tools/broker.ts:BoundToolHandler`,
`chrome-agent-browser/src/core/tools/bindings.ts:normalizeToolBinding`,
`chrome-agent-browser/src/core/hosttools.ts:evaluateBinding`,
`chrome-agent-browser/src/core/policy.ts:validatePackageUrl`,
`chrome-agent-browser/src/core/origins.ts:urlInOrigins`, `chrome-agent-browser/src/cli-net.ts`
(classification and pinning in the CLI); the extension's
`chrome-agent-browser/src/extension/execution/execute.ts:originGuard`.

**Conformance.** `missing-approval`, `control-plane/stale_tool_changed`,
`memory/n6-view-mismatch`, `webair-0.4.0/search-tools-only` (memory N6).

**Experiment.** E1 (the host-mediation family of the first catalog is cited), E3 (redirects,
rebinding and injected destinations through the origin the experiment controls), E10 (an
undeclared destination is refused and recorded, against the same model in a shell-tool harness).

**Residual.** The extension has no resolver and no socket, so it cannot classify where a name
resolves: a public name that resolves to a private address would be fetched by Chrome, bounded by
what a request can carry (a declared endpoint, schema-checked arguments, no cookie or credential)
and reach (the person's own network). The reference shell's unpinned connection (B-116) leaves a
name that changes its answer between the classification and the dial. An approved tool receives
whatever the package's signed declarations route to it (Agent Data Flow, §5.4). Adapters and
operator bindings are trusted host code.

### P-9 · Budgets hold and accounting is conservative

**Statement.** Tokens (global, per worker, per call), remote calls (global, per worker, per tool),
fan-out, parallelism and deadlines (node, graph, run) are declared by the package; the run totals,
the parallelism, the per-tool call caps and the graph deadline are the minimum of the package's and
the host's figures, and the per-worker, per-call, per-node and fan-out bounds are the package's own,
nested inside; a per-call output cap above the host's ceiling is refused at plan preparation, not
lowered. Every model call is reserved before dispatch as the full input bound plus the maximum
output; unknown usage consumes the reservation; a reported overrun is recorded and halts further
dispatch; absent or invalid usage fails rather than counting as zero. A conversation reserves a
whole turn against the conversation's budget; a network is admitted before its first activation only
if what the run has left covers its worst case, with nothing held; a compute call is bounded in
memory, wall time and, on the reference, instructions.

**Adversary.** A-PKG or A-MODEL driving a run past its bounds; A-PROV misreporting usage; a
module that never returns.

**Python reference.** `agentpkg/src/agentpkg/runtime.py:Runtime`,
`agentpkg/src/agentpkg/runtime.py:check_host_limits`,
`agentpkg/src/agentpkg/execution/policy.py:effective_budget`,
`agentpkg/src/agentpkg/execution/policy.py:effective_deadline_seconds`,
`agentpkg/src/agentpkg/execution/policy.py:check_capabilities` (the output-cap refusal),
`agentpkg/src/agentpkg/hostbridge/router.py:project_usage`,
`agentpkg/src/agentpkg/hostbridge/router.py:token_upper_bound`,
`agentpkg/src/agentpkg/conversation/runner.py:effective_limits`,
`agentpkg/src/agentpkg/compute/limits.py:ComputeLimits`.

**Chrome core.** `chrome-agent-browser/src/core/workflow/runtime.ts:checkHostLimits`,
`chrome-agent-browser/src/core/execution/limits.ts`,
`chrome-agent-browser/src/core/models/usage.ts`,
`chrome-agent-browser/src/core/execution/policy.ts:checkCapabilities`,
`chrome-agent-browser/src/core/conversation/runner.ts:effectiveLimits`,
`chrome-agent-browser/src/core/compute/limits.ts:loweredBy`.

**Conformance.** `budget-overrun`, `conversation/turn-beyond-cap`,
`conversation/conversation-tokens-exhausted`, `conversation/conversation-remote-exhausted`,
`conversation/tool-cap-across-turns`, `network/budget-overrun-in-role`,
`network/reservation-refused`, `network/route-cap-too-large`, `memory/n7-two-agent-writes`,
`compute/memory-over-host-cap`, `compute/fuel-exhausted`, `compute/deadline` (conversation
N-27…N-29, N-35; network N-30, N-36, N-37; memory N7; compute N-17, N-20, N-21).

**Experiment.** E1 (the resource family of the first catalog is cited; the parametric templates
of the second), E5 (observed over bound), E7.

**Residual.** A dishonest provider overspends once before the halt; a token cap needs the provider
to honour it; wall time is a property of the machine; a run that exhausts its own declared budget
is a denial the person sees, not a breach.

### P-10 · Fail closed

**Statement.** Unknown fields, unknown codes, malformed frames and unparseable answers are
refused; a failed wave commits nothing; a failed turn persists nothing; a denied required
permission refuses the plan; a host that cannot ask answers no; a lease that cannot be verified is
not issued; an absent engine refuses the compute node before the run; a disagreement between the
two runtimes fails the conformance suite rather than being normalized away, except the
differences the suite itself names as documented (its `documented difference` cases).

**Adversary.** Any party that profits from an ambiguous state: a desynchronized peer, a malformed
tool response, a reload during a card, an absent person.

**Python reference.** `agentpkg/src/agentpkg/workflow.py:Workflow`,
`agentpkg/src/agentpkg/conversation/host.py:TranscriptConsent.decide` (no decision is a no),
`agentpkg/src/agentpkg/hostbridge/peer.py:BridgePeer`,
`agentpkg/src/agentpkg/execution/session.py:normalize_execution_plan`.

**Chrome core.** `chrome-agent-browser/src/core/workflow/interpreter.ts:Workflow`,
`chrome-agent-browser/src/core/conversation/host.ts:NO_DECISION`,
`chrome-agent-browser/src/core/execution/plan.ts:normalizeExecutionPlan`,
`chrome-agent-browser/src/core/compute/engine.ts:ENGINE_UNAVAILABLE`.

**Conformance.** `conversation/consent-undecided`, `conversation/state-outside-schema`,
`schema-invalid-output`, `compute/output-not-json`, `compute/output-schema-miss`,
`network/patch-outside-schema` (conversation N-32, N-33; compute N-23, N-25; network N-38).

**Experiment.** E1 (every refusal is classified as an explicit block, an incidental failure or a
silent violation; the controls must pass), E6 (CB-9).

**Residual.** Refusing is a denial: a run that cannot complete returns nothing and the person
repeats it; a package can be written to fail.

### P-11 · A hash-linked audit, refused attempts included

**Statement.** Every run writes an audit chain: each model call (requested, completed, refused),
tool call (requested, settled, refused), permission check with its decision, route decision with its
reason, consent request and decision with its provenance, compute call with its bounds and trap,
memory proposal and agent write, and state commit; events link by hash; a conversation keeps one
chain across turns. The run summary and the cost are derived from the chain; the usage is the
runtime's own counters, written into the record beside the chain. Events carry identifiers, codes,
hashes, counts and pointers, never a prompt, a record value, a credential or a provider's error
text.

**Adversary.** A run that hides what it attempted (A-MODEL's denied tool use; A-PKG's undeclared
attempt); a transcript that claims a consent the chain does not hold; a flattering report.

**Python reference.** `agentpkg/src/agentpkg/runtime.py:Runtime.record`,
`agentpkg/src/agentpkg/runtime.py:_safe_facts`,
`agentpkg/src/agentpkg/execution/report.py:verify_audit_chain`,
`agentpkg/src/agentpkg/execution/report.py:audit_summary`,
`agentpkg/src/agentpkg/conversation/chain.py:AuditChain`.

**Chrome core.** `chrome-agent-browser/src/core/execution/report.ts:verifyAuditChain`,
`chrome-agent-browser/src/core/execution/report.ts:auditSummary`,
`chrome-agent-browser/src/core/conversation/chain.ts:AuditChain`,
`chrome-agent-browser/src/core/execution/record.ts:completeRunRecord`.

**Conformance.** Every case compares the ordered audit backbone and the per-wave multisets of both
runtimes and verifies each chain's linkage; `conversation-test/fixture`, `network-test/fixture`,
`conversation/transcript-accepts-denied` (conversation N-23; N-40 is a unit test of a cut chain).

**Experiment.** E3, E5 and E10 (the oracle reads boundaries from the chain and the recorded
seams), E6 (CB-10: edit, delete, reorder, fork), E8.

**Residual.** Tamper-evident to the person who holds it, not an attestation to a third party; node
and worker ids reveal the graph's shape; an egress view that shows every destination without
reading the chain is planned (W4).

### P-12 · The person's data is requested by type and chosen by the person

**Statement.** A package names a resource type (`personal.read`, `memory.read`), never a record;
the host lists what it holds and the person picks one record or none; the grant is frozen into the
receipt and the plan by opaque id and keyed digest. Host-resource tools take no arguments, so
nothing a package or a model sends can name another record; the broker resolves only the plan's
grant for that type and a permission the calling tool links. A changed or removed record makes
the plan stale before execution and is refused at call time.

**Adversary.** A-PKG or A-MODEL asking for more than declared, or for a specific record.

**Python reference.** `agentpkg/src/agentpkg/browser/hostresources.py:resource_requests`,
`agentpkg/src/agentpkg/browser/hostresources.py:evaluate_resources`,
`agentpkg/src/agentpkg/browser/hostresources.py:grant_staleness`,
`agentpkg/src/agentpkg/execution/policy.py:check_resource_grants`,
`agentpkg/src/agentpkg/memory/host.py:memory_handlers`.

**Chrome core.** `chrome-agent-browser/src/core/hostresources.ts:normalizeResourceRegistry`,
`chrome-agent-browser/src/core/tools/adapters/host-resource.ts:hostResourceCall`,
`chrome-agent-browser/src/core/tools/resources.ts:MemoryResourceStore`,
`chrome-agent-browser/src/core/memory/recall.ts:rankCandidates`.

**Conformance.** `webair-0.5.0/fixture`, `webair-0.6.0/fixture`, `denied-permission/optional`,
`memory/n3-read-denied`, `memory/n6-view-mismatch`, `memory-probe/custom-type-read` (memory N3,
N6). These run in fixture mode and exercise the plan-level checks; the call-time handlers (no
arguments; a changed record refused) are unit tests:
`openclaw-agent-browser/test/host-resources.test.ts`,
`chrome-agent-browser/test/core/memory/run.test.ts`,
`chrome-agent-browser/test/core/vault.test.ts`.

**Experiment.** E4 (the allowed-set ratio: what a package could obtain against what it needed,
with the person's choice as the minimizer), E1.

**Residual.** A grant is a whole record view today (field-level requests are planned, §5.4); the
unsealed fields of a granted record are ordinary data that go wherever the signed graph routes
them (recipients computed from the graph are planned, §5.4).

### P-13 · Sealed values never reach a model, and reach only tools that link their permission

**Statement.** Where a run is opened with the store (the Python reference's CLI with
`--memory-dir`; the Chrome core whenever the plan grants a record or binds a memory tool), two
egress scans search every model request body and every tool call's arguments for the run's scan
set: the sealed values of every record of the store, or, in fixture mode without a store, the
values at the sealed pointers of the replayed answers (M-62). A sealed value in a model request
refuses the call; a sealed value in a tool's arguments is refused unless the run was granted it
and the tool links its permission; a proposal or an agent note that carries one refuses the run
before anything is written. A run opened without the store holds no sealed value of it and runs
while the store is locked. **The reference shell is the stated exception:** the OpenClaw plugin
opens every run without a store, so its model requests are not scanned, and the sealed fields of
its host resources are scanned on tool arguments only, by the plugin's own scan, to a bounded
depth (B-114, B-265); a granted value that the signed graph routes to a model step is honoured
there, visibly in the graph.

**Adversary.** A-PKG whose graph routes a sealed field toward a model or an unlinked tool; A-MODEL
copying one; a proposal that launders one into memory.

**Python reference.** `agentpkg/src/agentpkg/memory/scan.py:find_sealed`,
`agentpkg/src/agentpkg/memory/scan.py:find_all_sealed`,
`agentpkg/src/agentpkg/memory/scan.py:scan_set_of`,
`agentpkg/src/agentpkg/runtime.py:Runtime._scan_model_request`,
`agentpkg/src/agentpkg/runtime.py:Runtime._scan_tool_arguments`.

**Chrome core.** `chrome-agent-browser/src/core/memory/scan.ts:findSealed`,
`chrome-agent-browser/src/core/memory/scan.ts:findAllSealed`,
`chrome-agent-browser/src/core/tools/egress.ts:egressRefusal`,
`chrome-agent-browser/src/core/workflow/runtime.ts` (the model-request scan).

**Conformance.** `memory/n11-sealed-value-to-a-model`, `memory/m36-sealed-value-to-a-tool`,
`memory/m36-two-sealed-values`, `memory/n13-sealed-value-in-a-proposal`,
`memory-probe/granted-sealed-value` (memory N11, N13, M-36), all in fixture mode over the
replayed answers' sealed values (M-62); the store path is unit-tested in
`chrome-agent-browser/test/core/memory/run.test.ts` and the reference shell's tool-argument scan
in `openclaw-agent-browser/test/host-resources.test.ts`.

**Experiment.** E4 (the channel table: model request, unapproved tool, encoding, proposal, notes,
delegation hop, error text, audit; on both runtimes; against a record-in-context baseline), E10
(the exfiltration channels), E1 (family M; the egress-scan profile).

**Residual.** Exact-value matching: a paraphrased, encoded, split or inferred value is not caught;
a value that enters from outside the store (the task, a tool's answer) is not sealed; a tool
approved to receive a value can still exfiltrate it; on the reference shell a model request is not
scanned at all and the tool-argument scan stops at a depth (above). Labels at every egress are
planned (§5.4).

### P-14 · Memory is written only through reviewed proposals, and records are data

**Statement.** A run writes nothing to the person's memory. Proposals are bounded, of declared
types, link only granted records and carry no sealed field or value; they are reviewed one by one
with the package's rationale, and an accepted record carries package, version and run as provenance.
Recalled bodies, agent notes and proposals enter a model request as data, inside the input document
under a generic preamble, never as instructions (the instructions are the package's skills); the
label M-35 asks for ("the person's stored content") is applied by neither renderer yet (B-263). No
field of a record is read as a tool, a permission or a destination. A package's notes reach only
that package; a custom type is qualified by the declaring package, closed, and free of sealed field
names; the person sees which packages touched which records.

**Adversary.** A-MEM and A-PKG: a run that wants data to leave through memory or an instruction to
stay for the next run; a record imported from elsewhere; another publisher's proposal.

**Python reference.** `agentpkg/src/agentpkg/memory/proposals.py:check_proposals`,
`agentpkg/src/agentpkg/memory/run.py:MemoryRun`,
`agentpkg/src/agentpkg/memory/registry.py:custom_type`,
`agentpkg/src/agentpkg/memory/registry.py:open_schema_reason`,
`agentpkg/src/agentpkg/memory/declarations.py:check_memory_graph`.

**Chrome core.** `chrome-agent-browser/src/core/memory/proposals.ts:checkProposals`,
`chrome-agent-browser/src/core/memory/run.ts:MemoryRun`,
`chrome-agent-browser/src/core/memory/run.ts:checkMemoryBindings`,
`chrome-agent-browser/src/core/memory/declarations.ts`,
`chrome-agent-browser/src/core/memory/types.ts`.

**Conformance.** `memory/n1-type-undeclared`, `memory/n2-sealed-field`,
`memory/n8-update-not-granted`, `memory/n14-link-not-granted`,
`memory/n14-body-link-not-granted`, `memory/n16-custom-type-shadows-sealed`,
`memory/n17-custom-type-reserved`, `memory/n21-custom-type-open`, `memory/n22-marker-line`,
`memory/agent-family-read`, `memory-probe/custom-type-proposal`,
`literature-review-0.2.8/memory` (memory N1, N2, N8, N14, N16, N17, N20…N22).

**Experiment.** E4 (write-proposal poisoning; expiry at recall), E3 (memory records as an injection
vector), E1 (family M; the proposal-check profile).

**Residual.** Review is the control, not inspection of meaning: a person who accepts an opaque
proposal has accepted it; a model that follows text inside a record misuses the authority the run
already holds; a well-known type is shared by design; provenance is local.

### P-15 · Compute is isolated: a module imports nothing and every call is bounded

**Statement.** A tier-1 module's import section is empty: it has no clock, entropy, file, network
or host function; it receives one byte string and returns one; it is named in the graph by its
SHA-256, which the signature covers; only the gate's instruction set passes validation (threads,
SIMD, tail calls and other proposals are refused before compilation), and what it admits is
deterministic across engines except the bit pattern of a NaN a floating-point operation produces,
which the reference canonicalizes and V8 leaves open, and the behaviour after a refused memory
grow (C-19, C-47); every call runs in
a fresh instance under the module's declared memory maximum (which must fit the host's ceiling), a
wall bound and, on the reference, a fuel bound; the output is used only through the node's schema.
In Chrome each call runs in its own nested Worker, terminated at the bound.

**Adversary.** A-PKG shipping code to read the person's data, reach a network, exhaust the machine
or exploit the engine.

**Python reference.** `agentpkg/src/agentpkg/compute/module.py:check_module`,
`agentpkg/src/agentpkg/compute/module.py:read_module`,
`agentpkg/src/agentpkg/compute/declarations.py:check_compute_declarations`,
`agentpkg/src/agentpkg/compute/engine.py:WasmtimeEngine`,
`agentpkg/src/agentpkg/compute/limits.py:host_limits`.

**Chrome core.** `chrome-agent-browser/src/core/compute/module.ts:checkModule`,
`chrome-agent-browser/src/core/compute/module.ts:readModule`,
`chrome-agent-browser/src/core/compute/declarations.ts:checkComputeDeclarations`,
`chrome-agent-browser/src/core/compute/engine.ts:workerComputeEngine`,
`chrome-agent-browser/src/core/compute/limits.ts:loweredBy`.

**Conformance.** `compute/module-import`, `compute/module-shared-memory`, `compute/module-simd`,
`compute/module-threads`, `compute/module-tail-call`, `compute/module-no-memory-maximum`,
`compute/limits-below-module`, `compute/memory-over-host-cap`, `compute/fuel-exhausted`,
`compute/deadline`, `compute/stack-overflow`, `compute/memory-growth-refused`,
`compute/output-schema-miss`, `compute/input-schema-miss`, `compute/echo`, `compute/with-start`
(compute N-1, N-2, N-7, N-14, N-17, N-20…N-22, N-25, N-26 and the two controls).

**Experiment.** E1 (family C; the module-gate and compute-limits profiles), E7 (per-call cost), E8
(trap codes across engines).

**Residual.** Not an OS sandbox: the engine is trusted, and a bug in wasmtime or V8 is a bug in the
host; Chrome meters wall time, not instructions; cross-engine determinism holds up to C-47's two
exceptions; a module can transform data it was given into a
form a later tool call carries (P-13's exact scan does not see an encoded value); a run's total
compute is bounded by the graph's number of calls, not by a run-wide meter.

### P-16 · Consent is a declared step bound to constructed facts, and `once` is spent

**Statement.** A conversational package declares consent steps. A tool linking a gated permission
is dispatched in a turn only after a step naming that permission was accepted in that turn, checked
statically (the tool depends on the step) and at run time (the mediator reads the turn's decisions
before the call); every tool with write side effects must be gated, the host's own memory tools
(`host.memory.`) excepted. The card shows facts the graph
constructed, with their provenance, beside the model's sentence; the decision is the host's record
of the person's answer. A step whose permission the plan denies, or whose `once` the conversation
already spent, is not asked, and a transcript's yes for it is refused: a step narrows the plan and
never widens it. In the Chrome core, a preset may pre-accept a step only for kinds that are
neither `payment` nor `personal.read` (`NEVER_PRE_DECIDED_KINDS`), and a policy can only lower: it
refuses pre-acceptance or denies the steps of a kind, `payment` included, with provenance `policy`;
the reference has no presets or policies and records whatever provenance its host reports.
A decision lives for its turn; the absence of a yes is a no.

**Adversary.** A-MODEL skipping the ask or arguing for a yes; injected self-approval (A-ORIG,
A-TOOL); card poisoning; a change between consent and execution; replay of a `once`; a preset or
policy that pays (A-ISS); a host that answers for the person.

**Python reference.** `agentpkg/src/agentpkg/conversation/runner.py:Conversation`,
`agentpkg/src/agentpkg/conversation/host.py:check_decision`,
`agentpkg/src/agentpkg/conversation/declarations.py:check_conversation_declarations`,
`agentpkg/src/agentpkg/conversation/declarations.py:gated_permissions`,
`agentpkg/src/agentpkg/runtime.py:Runtime._check_consent` (the run-time gate before a call).

**Chrome core.** `chrome-agent-browser/src/core/conversation/runner.ts`,
`chrome-agent-browser/src/core/conversation/host.ts:checkDecision`,
`chrome-agent-browser/src/core/conversation/declarations.ts`,
`chrome-agent-browser/src/core/policies/consent.ts:consentPlan`,
`chrome-agent-browser/src/core/policies/consent.ts:NEVER_PRE_DECIDED_KINDS`.

**Conformance.** `conversation/tool-after-denied-consent`,
`conversation/tool-after-skipped-consent`, `conversation/consent-undecided`,
`conversation/once-across-turns`, `conversation/once-spent-tool-reached`,
`conversation/two-steps-one-accepted`, `conversation/two-steps-two-permissions`,
`conversation/transcript-accepts-denied`, `conversation/write-tool-ungated`,
`conversation/tool-before-consent`, `conversation/consent-otherwise-accepts`, `webair-0.8.0/fixture`
(conversation N-15…N-17, N-23, N-30…N-32, N-34, N-41…N-43).

**Experiment.** E6 (the consent-bypass catalog CB-1…CB-11; the precedence test that the host may
add a step and the publisher cannot remove a host-mandated one; cards per task with and without
presets; a simulated-responder fatigue probe), E1 (family V; the consent-gate and
conversation-bounds profiles).

**Residual.** The sentence shown is the model's; what counts as consequential is the tool's own
`side_effects` declaration and the publisher's choice to gate a read; `always` does not exist; a
reload during a card is a failed turn the person repeats; the person's choice is informed only as
far as the facts shown.

### P-17 · Confinement across roles and workers

**Statement.** Each worker and each network role sees a declared view of the state (`state_read`)
and may write declared keys (`state_write`). Views are checked statically (no cross-role
projection; no read of a key that `initial` does not set) and at run time (an activation receives
a copy of its view; a patch outside `state_write` or outside the state schema is refused before
the role routes). A role's tools and permissions are its worker's; messages between roles are data
under a declared schema.

**Adversary.** A-PEER, or A-MODEL steered by a peer's message or injected content, reading another
role's data, writing another's keys or calling a tool it was not given.

**Python reference.** `agentpkg/src/agentpkg/workflow_validation.py:validate_workflow`,
`agentpkg/src/agentpkg/runtime.py:Runtime.run_worker` (the view and the patch checked at run time),
`agentpkg/src/agentpkg/workflow.py:Workflow._node` (the view built per node),
`agentpkg/src/agentpkg/delegation/declarations.py:check_network_declarations`,
`agentpkg/src/agentpkg/delegation/runner.py:Walk.patched`.

**Chrome core.** `chrome-agent-browser/src/core/workflow-static.ts:validateWorkflow`,
`chrome-agent-browser/src/core/workflow/runtime.ts:runWorker`,
`chrome-agent-browser/src/core/network/declarations.ts:checkNetworkDeclarations`,
`chrome-agent-browser/src/core/network/runner.ts:Walk`.

**Conformance.** `network/read-outside-view`, `network/write-outside-view`,
`network/read-uninitialized`, `network/patch-outside-schema`,
`network/patch-outside-schema-chosen`, `network/source-outside` (network N-20…N-22, N-38, N-43,
N-44). No case yet makes a role call a tool its worker was not given (B-264).

**Experiment.** E5 (inter-role injection and message tampering), E4 (the delegation-hop channel),
E1 (family N; the transition-check profile).

**Residual.** The message is a free channel within its schema: what a role believes from a message
is not bounded; a sealed value copied into a message is caught only by P-13's exact scan; the
tool side of the confinement (a role's tools are its worker's) rests on P-4's checks and has no
conformance case of its own yet (B-264).

### P-18 · Inputs from the web grant nothing

**Statement.** A page's `rel="agent-package"` link, an index entry, a tool response, a PDF and a
memory record are data or metadata. Discovery reads one page's head under a byte cap, runs no
script, follows redirects only within one origin (the reference) or not at all (the Chrome core),
reports a location on the page's own origin and creates no session, fetches no package and touches
no trust. An index's digest and signer claims are compared with the bytes and a difference is shown;
ranking uses only the person's own pins. A tool response is validated against the package's own
output schema, and the Crossref adapters render text with markup to plain text; a PDF is parsed with
no script, link or attachment handling, in a bounded child process (the reference) or a nested
Worker (the extension). Indexes and policies are Chrome-core features with no Python counterpart. A
signed policy is delegated trust and delegated defaults, pinned by the person at subscription: it
may make a key trusted within its anchors' scope and lower limits; it can never raise a limit, pick
a record, pre-accept a payment or exceed what a package declares, and unsubscribing withdraws
everything it did.

**Adversary.** A-ORIG (a compromised page or a visitor-injected `<link>`); A-ISS (a stale or
dishonest index; a compromised policy issuer); A-TOOL (a response carrying markup or
instructions); a hostile PDF.

**Python reference.** `agentpkg/src/agentpkg/browser/discovery.py:fetch_page`,
`agentpkg/src/agentpkg/browser/control.py:ControlPlane.discover_website`,
`agentpkg/src/agentpkg/hostfiles/pdf.py:extract_text`,
`agentpkg/src/agentpkg/tools.py:request_json`.

**Chrome core.** `chrome-agent-browser/src/core/discovery.ts`,
`chrome-agent-browser/src/core/signed-document.ts:verifySignedDocument`,
`chrome-agent-browser/src/core/policies/apply.ts:applyPolicy`,
`chrome-agent-browser/src/core/policies/apply.ts:cappedLimits`,
`chrome-agent-browser/src/core/resolve/static-index.ts`,
`chrome-agent-browser/src/core/html-text.ts` (the Crossref adapters only),
`chrome-agent-browser/src/extension/execution/pdf-reader.ts`.

**Conformance.** None in the cross-runtime suite (discovery, indexes and policies are host
features): the Python discovery tests, and the real-Chrome harnesses
`chrome-agent-browser/scripts/e2e-discovery.mjs` and
`chrome-agent-browser/scripts/e2e-search-policy.mjs`, exercise them.

**Experiment.** E3 (payloads in fare rules, search results, PDFs, memory records and messages
through the origin the experiment controls), E9 (the human web's exposure to the same payloads).

**Residual.** An index steers attention: a look-alike agent in front of the person is judged by
its own key. A policy key compromise is a trust-store compromise for every subscriber until they
unsubscribe, and there is no revocation feed. A site that lets visitors inject a `<link>` can
advertise a package, which is then judged like any other.

### P-19 · Least privilege and secrets at rest in the Chrome extension (a product property)

**Statement.** The extension holds no standing host permission beyond the two loopback names;
`activeTab` with `scripting` gives a temporary grant on the page the person acted on, to read its
head; every HTTPS origin is optional and granted one at a time by the person's click (a package's
origin, its declared services and the chosen provider, computed per plan and checked again before
Prepare and before Run); `tabs` is never requested; pages cannot message the extension. Provider
keys and the memory's two keys live in one envelope: AES-256-GCM per entry under a random master
key, wrapped under a key derived from the person's passphrase with scrypt (N = 2^17, r = 8, p = 1);
the master key is unlocked into session memory and wiped by an idle lock, on Lock now and when the
browser closes. A run is handed the bound provider's key and, when the plan grants a record or binds
a memory tool, the whole store's snapshot with its data key (the resolver answers only the plan's
grants; the scan set is every sealed value). Every run executes in a dedicated Worker of the
offscreen document and every compute call in a nested Worker; the extension's content security
policy admits its own scripts and WebAssembly compilation only; the execution host's transports
refuse any destination outside the plan's origins, the model transport admitting loopback for a
local engine. On the Python side, the control plane binds loopback only under a per-process bearer
token that no page can obtain, and the snapshot is an owner-only file.

**Adversary.** Another account, a backup or a stolen disk reading the profile directory; a web
page or another extension reaching the extension or its stores; a package reaching an origin the
person did not allow.

**Python reference.** `agentpkg/src/agentpkg/browser/server.py:_require_loopback`,
`agentpkg/src/agentpkg/browser/control.py:Session`.

**Chrome core.** `chrome-agent-browser/src/core/secrets.ts`,
`chrome-agent-browser/src/core/keychain.ts:HelperClient`; the extension's
`chrome-agent-browser/src/extension/background/controller.ts:lockIfIdle`,
`chrome-agent-browser/src/extension/execution/execute.ts:originGuard`,
`chrome-agent-browser/src/extension/manifest.json`.

**Conformance.** None: a shell property. The unit tests, the committed secret-store vectors,
`npm run check-pack` (the packed zip's members, the manifest's permission list and CSP tokens),
`scripts/check_extension_privileges.py` (the reviewable path: the permissions and host permissions,
the CSP tokens with no sandbox policy, no static reach into pages, the Worker placement; CI's offline
loop, its JSON kept in E8's report directory) and the real-Chrome harnesses cover it.

**Experiment.** None (a product property; its evidence is the test suites and the review of the
build; listed as a gap in the evidence matrix).

**Residual.** A process running as the person while the store is unlocked reads Chrome's memory; a
keylogger at the passphrase; a compromised extension build or checkout; a host permission is not
an egress boundary for origins that answer with permissive CORS headers (the extension's own three
checks are, P-8); Ollama is a native process the browser cannot confine; the extension is
reviewable, not reviewed (not on the Web Store).

## 4. What is not protected

Each item says what is outside the claim, why, and what bounds it anyway or what is planned.

- **Semantic injection within approved authority.** A model that follows an attacker's text can
  misuse any capability the run already holds, within the graph's arguments and the person's
  grants: search for the wrong flight, quote the wrong paper, write a slanted summary. The contract
  confines authority, not belief. Bounded by P-4, P-6, P-8, P-13 (what the misuse can reach);
  planned: labels at every egress (§5.4), so that granted data cannot be routed to a recipient the
  plan does not name.
- **Answer quality and slant.** Nothing here makes an answer true, complete or fair; a compromised
  model can give wrong answers within every bound. Answer checks and validation nodes refuse what
  the publisher declared refusable; a cross-check by a second model is a research question (W7).
- **Covert and side channels.** Which allowed value a model picks, the length or existence of an
  answer, timing, the shape of the audit (node and worker ids), error codes. A recipient the plan
  names can receive a few bits this way on every run. Measured in E10 as a residual, not counted
  as a boundary.
- **Bugs inside the sandbox and in the engine.** A WebAssembly module is bounded by the format and
  the engine; a bug in wasmtime or V8, in the JSON parser or in the schema validator is a bug in
  the host. The feature gate keeps the engine's surface small; it does not make it correct.
- **Trusted host adapters and operator bindings.** An adapter the operator approved and an entry
  in the operator's binding file are inside the trusted base; an operator who points an entry at a
  hostile service the package also declares is trusted by construction.
- **Storage at rest is a product property.** The secret store, the idle lock and the memory's
  sealing are the Chrome extension's (P-19), not the contract's; the Python reference's memory
  folder holds sealed values in clear by the operator's choice. A process running as the person
  while the store is unlocked, a keylogger, a compromised build and a forgotten passphrase are
  outside the claim.
- **The audit is tamper-evident to the person, not an attestation.** A hash chain held by the
  person's runtime binds its events to each other; it proves nothing to a third party, and nothing
  anchors it externally.
- **A person who decides badly.** A broad grant, a careless pin, a policy subscription, an opaque
  proposal accepted, a card answered without reading: each is the person's decision and the
  runtime honours it. The design limits how often it asks (§5.4) and shows facts the runtime
  computed; it does not make the decision.
- **Models run outside the browser's protection.** Ollama is a native process with full network
  access that the browser cannot confine; a hosted provider sees everything it is sent and keeps
  what it keeps. Today the runtime bounds what reaches a model (P-13 where the run holds the store,
  P-17) and records every call (P-11); in-browser inference (W5's route card says when a model runs
  outside the browser) and the tiers of §5.4 are planned.
- **Denial within declared budgets.** A package or a model can burn the run's own budget, stall
  until a deadline or fail every wave; the person sees a failed run and pays what the envelope
  allowed. Fail-closed is a denial, not a breach.
- **The platform.** A compromised operating system, browser or language runtime; another process
  running as the person; a stolen publisher or operator key; a break of Ed25519 or SHA-256; the
  runtime's own distribution (an unpacked build trusts the checkout it was built from; the Web
  Store would add a reviewer and an updater the person then also trusts).
- **The extension's missing resolver.** It cannot classify where a DNS name resolves (P-8's
  residual); the reference and the CLI can.
- **The reference shell's two gaps.** The OpenClaw plugin classifies a tool connection's address
  but does not yet pin the connection (B-116), and it scans tool arguments only, to a bounded
  depth, never a model request (B-114, B-265): P-8 and P-13 state both as the shell's exceptions,
  and the fixes are bug fixes to the frozen reference.
- **Exact-value sealing's limits.** A paraphrased, encoded, split or inferred sealed value; the
  unsealed fields of a granted record; a value that enters from outside the store; a secret the
  person typed into a note (P-13, P-14; labels planned in §5.4).
- **Shared well-known types.** A travel profile granted to two airlines is known to both, by
  design; cross-publisher provenance shown at recall is planned (§5.4).
- **No revocation.** Of a pin, a policy, a publisher key or a model version: a withdrawn policy
  keeps applying until refreshed or unsubscribed; a flagged model keeps running until the person
  changes the binding (advisories planned, W5; the supply chain, W6).

## 5. Privacy model

Privacy here is a property of flows, in Nissenbaum's sense: the question is not who may *read* a
record but **where it goes, to whom, and under which rule**. A package runs on the person's
machine; a record read into a local computation tells nobody anything. A record reaches someone
else only through an egress, and every egress in this runtime is mediated, so the model can state,
for each recipient class, what reaches it today and what will be shown and enforced once Agent
Data Flow exists (§5.4).

### 5.1 Data categories and tiers

| Category | Examples | Source | Tier (D-317) | Today |
|---|---|---|---|---|
| The task | what the person types at run start | the person | the person's own text, untiered | reaches the roles whose view includes it; a sealed value of the store typed into it is still caught by P-13's scan |
| Preferences | cabin, diet, interests, writing style | unsealed fields of memory records | **P** | ordinary data: goes wherever the signed graph routes it; no P/I distinction yet |
| Identifying, unsealed | name, home city, affiliation, a research profile | unsealed fields of memory records | **I** | the same as P today |
| Sealed | e-mail, phone, date of birth, payment method, identity numbers | the `sealed_fields` of the well-known types | **S** | never in a model request and only to a tool linking the permission where the run holds the store (P-13; the reference shell's exception is stated there) |
| Selected files | the PDFs the person picked | file capabilities of the session | the person's choice per file | their text reaches the roles the graph gives it to, through the reader only |
| Derived | proposals, agent notes, exports, the transcript, the audit | written by the run | inherits the inputs' | proposals reviewed (P-14); notes per package (P-14); the audit carries identifiers only (P-11) |
| Metadata | that a fetch or a call happened, when, from which address; the run's shape | the origin and the services see requests arrive; the provider sees the request | — | TLS; no cookie, no credential, no identifier of the person in the format (§5.5) |

The tier is set by the type's author; the person may raise it and never lower it below the
taxonomy's; a signed policy may tighten it and never loosen it (D-317, planned in §5.4). Today the
runtime distinguishes only sealed from unsealed.

### 5.2 Every egress is mediated

| Channel | Mediated by | What can leave today | What the person sees |
|---|---|---|---|
| A tool call to a declared service | P-8 (binding, address policy), P-13 (the argument scan), the tool's input schema | the arguments the graph constructs; a sealed value only through a tool that links its permission | the agent page's tools and services; each call in the audit; the egress view by destination is planned (W4) |
| A model request | P-6, P-17 (the role's view), P-13 (the request scan) | the role's view: task, skill, the data routed to the role, tool outputs and recalled bodies as data; never a sealed value where the run holds the store (P-13) | the plan's model and provider; the route card |
| A proposal to memory | P-14 | nothing without review; no sealed field or value | the review sheet, one proposal at a time |
| An agent note | P-14 | the package's own note, no sealed value, read back only by that package | Settings → Memory |
| A message or patch between roles | P-17 | the message under its schema; a patch within the view | the agent page's "at most"; the run page's route decisions |
| Exports and artifacts | the runner writes only into the run's directory | what the package declared as exports | the run page |
| The audit and progress | P-11 | identifiers, codes, counts, hashes, pointers | the technical audit |
| The package fetch and discovery | P-1, P-18 | the origin learns a fetch from the person's address and time; no cookie, no credential | the address bar, the agent page |
| The conversation transcript | P-16 | the person's own record | the chat surface |

Reading is not an egress: a record granted to a run and read by a model-less role, as WebAir's
host-resource role does, reaches nobody. When the local model is Ollama, the engine is a separate
process on the person's machine outside the browser's protection (§4): what it logs and where it
connects are its own; in-browser inference (planned) runs the engine with no network at all.

### 5.3 What each recipient class sees today

| Recipient | Sees | Does not see | Bounded by | Shown to the person |
|---|---|---|---|---|
| The local model | the role's view: task, skills, the unsealed fields the graph routed, tool outputs, recalled bodies as data | sealed values where the run holds the store (P-13); other roles' views | P-13, P-17 | the model route in the plan |
| A hosted provider | what a local model would see, over TLS; what it retains is its own terms, outside the runtime | sealed values where the run holds the store | P-13; the person's choice of route | the plan names provider and model id. **Current exposure, stated:** an unsealed identifying field reaches a hosted model if the signed graph routes it to a model role; the tiers of §5.4 are the planned bound |
| A tool origin (an airline, a resolver) | the arguments of approved calls under the tool's input schema, within the declared domain; a sealed value only through a tool that links its permission (the demo purchase's payment method); Crossref also receives the contact address the person set for its polite pool, if any | anything the graph does not route to it; the person's other records | P-8, P-12, P-13 | the agent page names the tools and their services; the signed graph is inspectable; per-field recipients are planned (§5.4) |
| A peer role | its view and the message it received | the rest of the state | P-17 | the agent page's roles and edges |
| The person's memory | what the package proposed, after review; its own notes | — | P-14 | the review sheet; Settings → Memory |
| Index and policy issuers | the fetch's address and time when the person adds a document or asks for a refresh, as an origin does (§5.2); nothing else | the person's records, grants and runs | P-18 | the search and policy pages |
| The shell's operator | everything, as trusted host code | — | §1.2, §1.4 | — |

### 5.4 Agent Data Flow (planned; binds T45; D-337)

The properties below are commitments of the design (D-317), stated now so that the specification
and the two runtimes are built against them and tested by a conformance family. They claim
nothing about today's code; the mechanism paper reports today's exact-value scans (P-13) and the
Data Flow arm waits for the implementation (D-321). The privacy paper's metrics are named here.

#### DF-1 · Field-level requests
A `memory.read` may name the fields it needs; the record view holds only those, and the card
names them ("your home airport and cabin"). Absent `fields`, the whole view as today, and the card
says so. *Bounds:* A-PKG asking for a record when it needs a field. *Residual:* the publisher
chooses the fields; a type's author chooses the granularity.

#### DF-2 · Recipients computed from the signed graph before consent
Before the run, the runtime labels each granted field at the memory read and propagates the labels
through the graph: precisely through `validate`, `map` and `join` constructors, conservatively
through `llm` steps and compute modules (an answer computed from a labelled input carries the
label). The result, per field, is the set of recipients it can reach: tool bindings and therefore
origins, the model route (local, or which provider), proposals, the agent's notes, the roles of a
network. The plan freezes it as `disclosures`; the card states it before consent. *Bounds:*
A-PKG's undeclared routing; a person's misreading of what a package does with a field. *Residual:*
conservative labels over-approximate through models (label creep); the card's completeness is the
analysis's.

#### DF-3 · Labels enforced at every egress
The same labels travel with the values at run time. At every tool call, model request, proposal
and note write, the labels of the outgoing data are checked against the plan's recipient set, and a
labelled value bound for a recipient the plan does not name is refused before it leaves, in both
runtimes. Exact-value matching (P-13) stays as the second line for values that enter from outside
the store. *Bounds:* A-MODEL laundering a granted field by encoding or paraphrase into an approved
tool's arguments bound for the wrong recipient (the exfiltration channels of E10); A-PKG's graph
routing a field somewhere the card did not say. *Residual:* a recipient the plan **does** name
receives the field; inference from unlabelled data; covert channels; the false-refusal cost of
conservative labels, to be measured.

#### DF-4 · Declassification only through a declared consent step that shows the value
A labelled value may reach a recipient outside its set only when a consent step the publisher
declared shows the value and the recipient and the person accepts, in that turn; the decision is
recorded with the labels. *Bounds:* a silent widening of the recipient set. *Residual:* the
person's reading of the card (P-16's residual).

#### DF-5 · Sensitivity tiers with defaults
Every type carries a tier (P, I, S); the person may raise it, never lower it below the taxonomy's;
a signed policy may tighten and allow-list recipients, never loosen. Hosted models may see tier I
only if the person allowed it once in Settings; tier S never (as today). *Bounds:* A-PROV as a
recipient of identifying data under a default the person did not choose. *Residual:* a person who
allows hosted models for tier I has allowed it for every package; what the provider retains is
outside the runtime (W8).

#### DF-6 · Remembered decisions ("connections") with expiry
A decision such as "this publisher may use my Home travel profile (home airport, cabin) and send it
to its origin" is remembered per publisher key, package-id scope, type, fields and recipients; it
is revocable, shown under Memory → Connections, revoked automatically after 90 days of non-use,
and invalidated when any element changes: a new version that adds a recipient, a field or a tier
asks again; one that discloses nothing new inherits the connection. This is the revocable store
whose absence is why `always` is refused today, narrower than `always`. *Bounds:* consent fatigue
as a channel (a person who clicks yes because they are asked too often). *Residual:* a remembered
decision is a decision; revocation is the person's act.

#### DF-7 · The disclosure ledger
Per record, every recipient it went to, from the audit chains, with time, package and version: the
person's right to know, kept locally. *Bounds:* A-PKG's claim about what it did with a record.
*Residual:* local, not attested (P-11).

#### DF-8 · The request budget
A tier-P field that goes only to the publishing origin and the person's local model is used
without a card under the default preset, named in the run summary with one-click undo and recorded
in the ledger; everything a publisher's package needs is one first-use card, remembered as one
connection; later runs are silent until something new is disclosed; global settings answer the
hosted-model question once; a disclosure that a consent step already shows (a sealed e-mail on the
purchase card) is not asked twice; payments stay confirmed in the moment. Prompts per 100 runs,
over a simulated week with many packages, is a design target and a reported metric: at most one
card per new publisher, zero on repeat use with nothing new. *Bounds:* fatigue. *Residual:* the
default preset decides tier-P first-party use; a person who wants to be asked raises the tier.

#### DF-9 · Provenance across publishers at recall
A record proposed by publisher A carries A in its provenance; when publisher B asks for it, the
card says so; a policy option withholds records proposed by one publisher from another unless the
person agrees. *Bounds:* cross-agent memory poisoning at recall time (A-MEM), not only at write
time. *Residual:* a well-known type the person filled in themselves is shared by design.

#### DF-10 · Agent notes carry labels
A package's notes carry the labels of what was written into them, so a granted field cannot be
laundered into notes in one run and disclosed to an unapproved recipient in a later run; notes
stay per package, widening to per publisher only when the person trusts the key at publisher
scope. *Bounds:* persistence as a laundering path (Zombie Agents). *Residual:* the person's own
text in a note is unlabelled.

**Evidence planned.** A conformance family (a field routed to an unapproved tool; through a
constructor; through a model; into notes; across a network role; after a version that adds a
recipient); the enforcement catalog's memory family gains the recipients dimension; the false
refusals of conservative labels and prompts per 100 runs are measured (the privacy paper's metrics);
E10's "with Data Flow" arm reports leakage after the implementation. **What Data Flow does not
bound:** what a model believes; a recipient the plan names; covert channels; the quality of the
answer (W7).

### 5.5 Against the privacy threats of RFC 6973

| Threat | Today | Planned |
|---|---|---|
| Surveillance | TLS to every service; the provider of a hosted model sees the requests it is sent (the person's choice of route) | in-browser inference removes the provider from the local route |
| Stored data compromise | the Chrome extension's secret store and sealed values at rest (P-19); the Python reference's memory folder is in clear by the operator's choice | — |
| Intrusion | the address policy and the loopback-only control plane (P-8, P-19); bounded parsing (P-1) | — |
| Misattribution | a package is attributed to a key, never to a name (P-1, P-2); nothing attributes a run to a person: the format carries no user identity | publisher credentials (W6) |
| Correlation | an origin can correlate fetches by address and time; no identifier of the person travels; run ids are random; no cookie or credential is sent | — |
| Identification | only what the signed graph routes reaches a recipient; sealed values do not reach a model where the run holds the store (P-13) | tiers (DF-5); recipients before consent (DF-2) |
| Secondary use | a provider's retention is outside the runtime; a tool origin's use of what it received is its own | tiers and the hosted-model setting (DF-5); attested hosting (W8) |
| Disclosure | every egress mediated (§5.2) | labels at egress (DF-3); the ledger (DF-7) |
| Exclusion | the person sees the agent page, the review sheet, the run record and the audit | the egress view (W4); connections and the ledger (DF-6, DF-7) |

## 6. Unplanned calls and imports (planned; binds T47)

The rule of D-319, as a design commitment with the user's gate. An agent may reach a service, a
server or a module its package did not declare, but only through the runtime and only as a
**request**.

- **UC-1 Declared and approved.** A destination the package declared and the person approved at
  authorization runs without a question; the person already decided (P-4, P-8).
- **UC-2 Not declared.** The agent can only request it. The runtime shows a card with facts it
  computed itself: the destination and, where known from a bundled list or the advisory feed, who
  operates it; that the package did not declare it; which of the person's labelled data would leave
  (DF-2, DF-3) and how much. The model's or the package's stated reason may be shown, marked as the
  agent's words, never as a fact. The default answer is no. Choices: allow once, deny; remembering
  applies only to destinations a package declares as open-ended, through connections (DF-6).
- **UC-3 No person present.** On the agent host or in a background run, an unplanned request is
  refused and recorded (P-10, P-11).
- **UC-4 Amendments, never rewrites.** An approval is an appended, hash-linked amendment to the Run
  Plan: the original plan stays the contract, every amendment names the person's decision, and
  re-verification covers it (P-5). The plan is never rewritten.
- **UC-5 Imports.** An import is a signed artifact (another package, a WebAssembly module) verified
  by the same pipeline, whose requirements become the amendment (P-1, P-2, P-15), or code passed as
  data to a signed interpreter inside WebAssembly with no imports; never script in the extension.
- **UC-6 The cap.** Unplanned requests count against the request budget (DF-8); after a per-run
  cap the rest are refused without a card and summarized at the end ("this agent tried 12 more
  destinations"); a signed policy may forbid them altogether.
- **UC-7 Where requests arise.** Tier-2 capability imports with run-time destinations, model-chosen
  tool use, and open-ended declared capabilities such as following links. Nothing else can produce
  a request: a tier-0 graph has no run-time destination.

*Bounds:* A-MODEL's and A-PKG's reach beyond the declaration becomes a decision the person takes on
facts the runtime computed; the Cohere case becomes a card the person refuses and the egress view
keeps. *Residual:* social engineering through the agent's stated reason (shown as its words);
fatigue, bounded by the cap; the card's facts must be computed without leaking (no lookup of the
destination from the person's machine beyond a bundled list). *Evidence planned:* a conformance
family (an undeclared destination; an import; the cap; an unattended run; an amendment replay) and
enforcement cases for the catalog.

## 7. Mapping to Privacy by Design and Trustworthy AI; the vocabulary

### 7.1 Langheinrich's principles for privacy-aware ubiquitous systems (UbiComp 2001)

| Principle | Where it lives | Properties |
|---|---|---|
| Notice | the agent page (permissions, tools, services, "at most"); the recipients card (planned) | P-4, P-7, P-12, DF-2 |
| Choice and consent | grants and approvals; the person's choice of record; consent steps; requests (planned) | P-4, P-12, P-16, UC-2 |
| Anonymity and pseudonymity | no user identity in the format; a package is attributed to a key; random run ids | P-1, P-2, §5.5 |
| Proximity and locality | the person's own runtime and memory; local models; in-browser inference (planned) | P-12, P-13, §5.3 |
| Adequate security | the contract: integrity, the envelope, mediation, fail closed | P-1…P-11, P-15, P-17 |
| Access and recourse | the run record and the audit; the review sheet; the ledger and the egress view (planned) | P-11, P-14, DF-7 |

### 7.2 The requirements of Trustworthy AI (the EU guidelines, 2019)

| Requirement | Properties |
|---|---|
| Human agency and oversight | P-4, P-12, P-16; UC-2 and DF-6 (planned) |
| Technical robustness and safety | P-1, P-3, P-5…P-10, P-15, P-17 |
| Privacy and data governance | P-12, P-13, P-14; §5.4 (planned) |
| Transparency | P-11; the agent page; the route card and the egress view (planned) |
| Accountability | P-1, P-2, P-11 (signed packages, hash-linked records) |
| Diversity, non-discrimination and fairness; societal and environmental well-being | outside a runtime's reach: the model's and the publisher's; stated so |

### 7.3 Contextual integrity

Nissenbaum's parameters map onto the recipients card: the **subject** is the person; the **sender**
is the runtime acting for the person; the **recipient** is the origin, the provider or the peer
role (§5.3); the **information type** is the record type and its tier (§5.1); the **transmission
principle** is the grant, the connection or the consent step (P-4, P-16, DF-4, DF-6). A flow is
appropriate when the plan's recipient set, shown before consent, is the one the person accepted;
the enforcement at egress (DF-3) is what makes the shown set the real one.

### 7.4 Vocabulary

**Trustworthy** (of the system): collaboration among parties that do not trust each other, made safe
by one trusted component, the person's runtime. **By construction**: a bound that holds because of
what the runtime can express and admit, not because a party behaves. **Least privilege**: a run
holds the intersection of what the package declared and what the person granted, and nothing widens
it (P-4). **Data minimization**: requests by type and, planned, by field; the person as the
minimizer (P-12, DF-1). **Contextual integrity**: §7.3. **Containment**: the effect of a compromised
part is bounded to what that part was granted (§2.3). **Provenance**: which key signed what runs
(P-1, P-2); which run proposed a record (P-14); which model answered a call (P-11).
**Transparency**: the agent page before, the audit after (P-11). **Accountability**: signed packages
and hash-linked records (P-1, P-11). **User agency**: the person decides every grant, record,
consent and (planned) request, and can revoke what was remembered (P-4, P-12, P-16, DF-6).

## 8. Change log and the per-boundary notes

- **Version 2 (2026-11-01, T28).** This document created: the trusted computing base per component
  and per extension, the adversary table with the compromised model, properties P-1…P-19 with
  seven fields each, the "not protected" list, the privacy model with the planned Agent Data Flow
  (DF-1…DF-10) and the planned rule for unplanned calls (UC-1…UC-7), the mappings. It replaces
  the per-boundary threat model as the primary statement.
- **Version 2, corrected after review 1 (2026-11-02, T28).** No property was added or removed and
  no id changed. Statements were narrowed to what the code does: P-13 and P-8 state the reference
  shell's exceptions (no model-request scan and a bounded tool-argument scan, B-114 and B-265; a
  classified but unpinned tool connection, B-116); P-2 (a scope is a prefix; policies are the
  Chrome core's), P-4 (presets, profiles and policies within the declaration and the preset's
  ceiling; `always` accepted but never offered), P-5 (the runner re-derives identity, not trust;
  the import scan is the reference's, the extension separates by execution context), P-6 (re-asks
  are the Chrome core's), P-7 and P-9 (an admission check, nothing held; the minimum of package
  and host for the run totals only), P-10 (documented differences), P-11 (usage is the runtime's
  counters), P-14 (records enter as data; M-35's label unapplied, B-263), P-15 (NaN and a refused
  grow as C-47's exceptions), P-16 (the pre-decide floor is the Chrome core's), P-17 (pointers;
  no tool-side case yet, B-264), P-18 (the Crossref adapters, the PDF reader per shell, indexes
  and policies Chrome-core), P-19 (`activeTab` and `scripting`, the whole snapshot, loopback for
  the model transport); §2.2 reads "spend past a reported overrun" and names denial; conformance
  cases moved to the property they test; §4 lists the reference shell's gaps; §5 states P-13's
  scope at every mention.
- **Version 2, corrected after review 2 (2026-11-02, T28).** Wording only. P-16 and §1.5 say a preset
  *pre-accepts* (a policy's `forbid_kinds` pre-decides a denial of any kind, `payment` included, so
  the floor is on acceptance); the threat model's poisoning row carries P-14's sentences (the M-35
  label unapplied, B-263), its nondeterminism row P-15's (the gate's instruction set and C-47's two
  exceptions), and its consent-floor row the same pre-accept wording. The checking script reads a
  phrase through Markdown emphasis and code markers, takes the spec-numbered case ids from the
  specifications' text, checks a cited DF-n or UC-n against the set of defined ids, every component
  of a dotted pointer, and the threat model's map for duplicate rows and for every property.
- **Version 1** is [threat-model.md](threat-model.md): the per-boundary notes written with each
  milestone from the format to Agent Delegation. They are kept as the implementation notes of this
  model: each section states the properties it implements, and nothing a specification cites was
  removed.

**How this document changes.** A property's statement changes only with a new version of this
document, a conformance case that exercises the change, and an entry here; an id is never reused;
a planned section becomes normative when its task merges and its conformance family runs on both
runtimes. `scripts/check_security_model.py` runs in CI and on the paper's text.
