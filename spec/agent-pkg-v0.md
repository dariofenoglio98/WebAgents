# Agent Package v0 — experimental specification 0.1

Execution update (agentpkg 0.2.0): the container/signature format below remains 0.1.
New packages select `entrypoint: "workflow.v0"` and use the normative
[workflow.v0 specification](workflow-v0.md). The host-specific entrypoint/stage
execution descriptions below describe the retained **legacy profile**, not current
generic execution. Minimum runtime versions up to 0.2.0 are now supported.


Status: this repository's research prototype, **not an official OpenClaw, NANDA, or industry standard**. The professor's `agent.pkg` and the supplied PDF's `agent.package` refer to the same conceptual portable agent bundle. This implementation calls the format **Agent Package v0**, uses `spec_version: "0.1"`, and distributes `NAME.agent.pkg` files.

The primary architectural input is *Portable AI Agents and the OpenClaw Agent-Native Browser*: signed bundles and instruction layers (PDF pp. 6–10); local/server separation and inspectability (pp. 12–13); permissions, budgets, model routing, tools, memory and delegation (pp. 14–19); attestations (p. 23). Those pages propose capabilities and responsibility boundaries. They do not define a wire format, canonicalization, signature transcript, trust bootstrap, schema semantics, concurrency algorithm, or extraction safety rules. The concrete rules below are this prototype's decisions.

## 1. Authority and genericity

A package describes requested behavior and authority. A host decides whether to install a trusted implementation for its entrypoint, whether to trust the publisher key, and which capabilities to grant. Package text, schemas, skills, graph identifiers, and tool bindings never become executable code. A signature establishes possession of a pinned publisher key and integrity of the payload; it does not establish the truth of names, scientific claims, safety claims, or third-party certifications.

The core schemas have no literature-specific fields. `tests/test_format.py` validates and signs an independent offline Meeting Agenda package. The CLI's execution registry currently has one installed workflow, `literature.review`; unsupported entrypoints remain valid packages but cannot execute in this host. The generic `Runtime` accepts host-installed operations, tools and a model router. It is an authority mediator, not a Python sandbox.

## 2. Source and artifact

A source tree contains a UTF-8 JSON file named exactly `MANIFEST.agent`, referenced JSON documents and UTF-8 instruction/data files. JSON is the only authoritative serialization. HOCON, described as graph source in the PDF (pp. 9, 26), could become a compiler input, but v0 has no HOCON parser and no second competing authority.

An artifact is a standalone, single-disk ZIP_STORED archive containing payload files, generated `integrity.json`, and optionally `signatures/publisher.json`. It is an actual ZIP, not a renamed directory. Compression, directory entries, ZIP64, encryption, entry/central extra fields, archive/entry comments, data descriptors, prefixes, suffixes, inter-member gaps, symlinks, special files and executable modes are rejected. Builders use sorted ASCII paths, timestamp 1980-01-01 00:00:00, Unix regular-file mode 0644, and no ZIP comments or extra fields. Source file times and directory traversal order have no effect.

Before building, all JSON (including `MANIFEST.agent`) is parsed with duplicate keys and nonfinite numbers rejected, then serialized with **RFC 8785 JSON Canonicalization Scheme (JCS)**. This includes ECMAScript number serialization and JCS property ordering. Integers outside JCS's exact supported range are rejected. Markdown and other text bytes remain unchanged. Readers validate exact payload hashes and can read non-JCS payload JSON; their signatures bind those exact bytes. The builder always emits canonical JSON. A source digest can differ from its built artifact digest because the builder removes JSON formatting differences.

Payload types are `.json`, `.md`, `.txt`, `.bib`, `.csv`, plus `MANIFEST.agent`; all must decode as UTF-8 and contain no NUL. A JSON file must contain valid JCS-representable JSON, even when not referenced. The data-only profile intentionally excludes Python, JavaScript, shell, WASM, binaries, archives and PDF attachments. User PDFs are selected from the host at execution time. No package modules are imported.

Paths are ASCII, relative, at most 240 characters, with components matching `[A-Za-z0-9_-][A-Za-z0-9_.-]*`. Empty, dot/parent, backslash, leading-dot, absolute, Windows-reserved or trailing-dot components are rejected. Case collisions are rejected for files and directory components; file/directory prefix collisions are rejected. Dot-prefixed paths exclude `.env` and Git metadata. Virtual environments, `node_modules`, caches, known private-key filenames, and apparent PEM/API secrets are rejected. This is a conservative format gate, not a complete secret scanner or DLP guarantee; authors must review arbitrary prose and JSON data before publishing.

Limits: 256 payload files, at most two generated envelope files, 8 MiB per member, 32 MiB total expanded bytes including envelope, and archive size at most 32 MiB plus 256 KiB. The builder validates the source and the resulting archive resource envelope. Hosts may impose tighter limits.

Source trees cannot contain either reserved generated envelope member. `unpack` emits payload only into a new directory; the original artifact retains its signature. Rebuilding the unchanged unpacked canonical source reproduces the unsigned artifact. New output files use exclusive creation and no symlink-following parent traversal. Existing outputs are never overwritten except the explicit in-place `sign` operation, which replaces the selected artifact atomically.

## 3. Mandatory manifest and versioning

The machine-readable schemas in `agentpkg/src/agentpkg/schemas/` use JSON Schema draft 2020-12. Every field listed below is required; use an empty list/object or the explicitly allowed `null` when appropriate. Unknown fields in closed objects fail validation.

| Field | Meaning |
| --- | --- |
| `spec_version` | Exactly `0.1`; `0.2` is rejected, never interpreted as `0.1`. |
| `package_id`, `name`, `version`, `description` | Stable asserted package identity, display name, package SemVer, capability description. |
| `publisher: {id,name}` | Publisher's asserted identity; binding to a real identity is a host trust-bootstrap responsibility. |
| `created_at` | RFC 3339 date-time selected by the source author; builds do not insert current timestamps. |
| `runtime: {api,minimum_version}` | API exactly `agentpkg-runtime-v0`; minimum version cannot exceed implementation `0.1.0`. |
| `capabilities` | Unique capability identifiers used for discovery/inspection, not grants. |
| `entrypoint` | Host handler identifier; never a file path or code import. |
| `graph`, `policy` | Package-relative JSON document paths. |
| `skills` | `{id,version,path}` records; paths must be Markdown files. |
| `tools` | `{id,path}` records pointing to tool contracts. |
| `schemas` | `{id,path}` records declaring all application JSON schemas. |
| `model_requirements` | Provider-neutral tasks and routing requirements described below. |
| `evals` | `{id,kind,path}` records; execution requires a matching trusted host harness. |
| `attestations` | Paths to JSON object metadata; no external attestation trust is inferred. |
| `dependencies` | Pinned `{package_id,version,digest,locator}` records; runtime refuses nonempty dependencies until a resolver is installed. |
| `update: {channel,locator}` | Channel `local`, `preview`, or `stable`; locator null, HTTPS URI, or future `nanda:` URI. Never automatically fetched. |
| `extensions` | Namespaced, noncritical metadata only. |

Identifiers use `[A-Za-z][A-Za-z0-9_.:-]{0,127}`. Package/skill/tool/runtime versions follow a three-component semantic-version form with optional prerelease suffix; build metadata is not included in this profile. Referenced documents have unique IDs and distinct declared paths. Missing members and mismatched document IDs fail validation.

`extensions` keys must be namespaced, for example `org.example:display`. Their values are opaque JSON. Unknown extensions convey no authority and cannot relax policy, change bindings, or require unsupported security semantics. A future critical feature needs a recognized schema/API version. The schema reserves execution kind `agent` and future locators, but the v0 runtime rejects remote-agent execution; a representable declaration is not a runnable capability.

## 4. Graph, skills, and delegation

A graph has `spec_version`, `coordinator`, `workers`, `stages`, and `extensions`. The coordinator must be a declared worker with `max_instances: 1`. Worker records contain:

- `id`, `kind` (`packaged`, `remote`, `nanda`), and lists of skill/tool IDs; remote/NANDA roles require a locator and are representable but cannot execute in this runtime;
- positive `max_instances` bounded by the package worker cap;
- `budget: {tokens,remote_calls}`, no larger than global budgets;
- explicit `state_read` and `state_write` lists of top-level declared state keys.

A skill describes how to perform a capability. A worker is an execution role that may use multiple skills and tools. A skill is not automatically an agent. Host implementations bind operations to declared stages and worker roles; arbitrary worker code is not downloaded.

Stages contain `id`, `worker`, `depends_on`, `parallel`, `merge` (`append`, `replace`, `deduplicate`), and `extensions`. References must exist and the dependency graph must be acyclic. The generic validator checks structure; each installed workflow must implement or reject the exact stage and merge semantics it supports. The literature implementation interprets its bounded nine-stage graph and merges worker results deterministically.

`policy.delegation` has `max_depth: 1`, `allow_remote: false`, and `approved_roles` exactly equal to workers excluding the coordinator. Only the coordinator's trusted host context may spawn workers; workers cannot delegate recursively. Global simultaneous-worker slots and per-role instance limits are enforced by the runtime. Per-worker budgets apply to each invocation; global budgets apply across all workers. Future remote/NANDA delegation requires a new supported profile, not an arbitrary new role.

## 5. Tools and permissions

Tool contracts contain `spec_version`, `id`, `version`, `description`, `execution` (`local`, `remote`, `agent`), `binding`, nullable `endpoint` and `method`, `input_schema`, `output_schema`, `permissions`, `domains`, `timeout_seconds`, `retries: 0`, `side_effects` (`read`, `write`), `approval_required`, and `extensions`.

A binding names a trusted host-installed implementation. The runtime does not download its implementation. Local tools have no network endpoint/method/domains. Remote tools require credential-free HTTPS URLs on port 443, explicit GET/POST, exact DNS domain allowlists, and linked network permissions covering every tool domain. Wildcards, IP literals, `.local` and `.localhost` domains are rejected. Runtime transport additionally rejects private/non-global resolved addresses, redirects, and undeclared endpoints. The host resolver URL override cannot extend declared domains. Tool inputs and outputs are schema-checked; write operations must declare `approval_required: true` and require host approval before dispatch.

Permission declarations contain `id`, `kind`, `description`, `required`, `resources`. Kinds are `network`, `files.read`, `files.write`, `model`, `memory`, `shell`, `payment`. Representation of shell/payment is useful for future packages; the current runtime does not supply those powers. Resources are symbolic scopes or exact domains, never authority by themselves. The host passes grants keyed by permission ID: `once`, `session`, `always`, or `deny`. Missing grants deny. `always` means a grant supplied by a trusted host store; this prototype does not persist consent, so the browser control plane refuses to offer `always` and exposes only `deny`, `once` and `session`. Worker tool allowlists and linked permission scopes are checked together, including after host-handler binding. Package capability declarations never create permissions.

`required` communicates the package's requested operating profile; it does not preauthorize anything. The runtime checks permissions when used, so a denied optional capability can remain unused. A user-selected file ID is mapped to a path in separate host configuration; a package/model cannot grant itself arbitrary paths.

## 6. Schemas and memory

Application schemas are draft 2020-12 schemas referenced through the manifest. Local `#` JSON Pointer fragments and relative references to other declared schema documents are supported entirely offline. Remote references, parent traversal, `$id`, `$dynamicRef`, `$recursiveRef`, custom vocabularies, unknown target schemas and missing pointers are rejected. Validators use a registry that cannot retrieve external resources. Package schemas describe data and never execute code, but this in-process prototype is not a CPU-isolated validator for adversarially expensive regular expressions or combinatorial schemas.

Memory policy contains `scope` (`ephemeral`, `session`, `agent-scoped`, `publisher-scoped`, `user-global`, `enterprise-governed`), `retention` (`session` or represented future `user-managed`), `raw_documents: false`, `state_schema`, and `sharing: "explicit_views"`. State schema must describe an object with top-level properties. Worker read/write keys must exist there. The current runtime supports ephemeral/session lifetime and rejects the other scopes, copied task-local state views, validated state patches and permission-checked memory access. Persistent/encrypted/portable memory capsules from PDF p. 18 are future work. No cross-package memory store is provided.

The host workflow retains structured evidence/provenance, not full raw PDF bodies, in its research state. Worker input data can include the text needed for extraction; the audit records hashes and identifiers rather than full private content. Session output directories are deliberately written host artifacts; users control their retention. This is not automatic deletion of exported results.

## 7. Budgets, model routing, and audit

Budget fields are `estimated_tokens`, positive `hard_tokens`, `max_remote_calls`, `max_calls_per_tool` (exactly all declared tool IDs), `max_parallel_workers`, nullable `estimated_cost_usd`, and nullable `approval_threshold_tokens`. Estimated tokens and approval thresholds cannot exceed the hard cap. Estimates are not spending authority. Host limits only lower declared limits.

The runtime reserves token/call capacity atomically before dispatch, applies worker/global/tool limits, and audits success, errors and denial. Model routing is host-selected. Requirements can additionally express `privacy` (`host-policy` or enforced `local-only`), `latency_preference`, and `cost_sensitivity` (preferences, not performance guarantees). Requirements contain `tasks: [{id,capabilities,context_window,preferred_tier}]`, `routing: "host"`, `fallback_policy: "deny" | "compatible"`, `extensions`. Package tasks do not name a provider or contain credentials. The installed router must expose compatible capabilities, a tokenizer/count operation, an output cap and complete token usage (including billed reasoning tokens). Unsupported routing/fallback policy is rejected or remains unavailable rather than silently reducing guarantees. Cost estimates are metadata; there is no monetary escrow or enforced dollar cap.

The audit captures ordered events, timestamps, worker/parent identity, skill/tool/model references, permission/domain context, status, hashes, token/call usage, and errors where applicable. It demonstrates operations passing through the reference runtime. It is not a tamper-proof external audit service, nor proof that unrelated OpenClaw actions obey the package policy.

## 8. Integrity and publisher signatures

`integrity.json` is a JCS-encoded object:

```json
{"format":"agent.pkg-integrity-v0.1","files":{"MANIFEST.agent":"<64 lowercase SHA-256 hex characters>","graph.json":"<...>"}}
```

The `files` mapping covers **every payload member**, including skills, schemas, fixtures, eval definitions and attestation metadata. The two generated envelope paths are excluded. Each hash is SHA-256 of the exact member bytes. Missing, unexpected, or modified payload members cause a load error. `Package.digest` is SHA-256 of the JCS-encoded entire integrity statement. This deliberately avoids self-referential manifest/artifact hashes. A transport ZIP hash may be recorded separately by a host receipt.

Ed25519 signs these exact bytes:

```text
UTF8("Agent Package v0.1 publisher signature") || 0x00 || JCS(integrity_statement)
```

`signatures/publisher.json` contains closed fields `format: "agent.pkg-signature-v0.1"`, `algorithm: "Ed25519"`, `key_fingerprint`, raw 32-byte `public_key` encoded in standard base64, 64-byte base64 `signature`, and `digest`. Fingerprint is `sha256:` followed by the lowercase SHA-256 hex of the raw public key. `verify --trust-key` requires an independently supplied Ed25519 PEM public key, compares raw key bytes/fingerprint, validates the digest, and verifies the domain-separated signature. An embedded key is never its own trust anchor. `inspect`/`validate` report signature presence without claiming publisher authentication; only `verify` asserts the explicit pin matched.

Private keys are unencrypted PKCS#8 PEM in owner-only mode 0600 outside package sources/artifacts. Public keys are SubjectPublicKeyInfo PEM. `keygen` refuses overwrites and identical destinations. `sign` refuses group/world-readable private keys and symlink key files. Demo public keys are local provenance aids, not an independent certification or a production identity infrastructure. Revocation, rotation, transparency logs, certificate chains and threshold signatures are future work.

## 9. Evals, attestations, provenance, and installation

Eval documents use `{spec_version,id,description,cases:[{id,input,assertions}],extensions}`. The package declares tests; installed trusted code implements their meanings. A generic package cannot execute arbitrary test code. Runtime eval output records what ran and distinguishes deterministic fixture assertions, live external results, and optional model judgments. Merely packaging an eval does not mean it passed.

Attestations are hashed JSON object metadata, deliberately separate from the publisher signature. V0 does not implement third-party attestation verification. The reference records provenance and explicitly states that it has no independent certification. A self-authored review or synthetic run must not become a third-party safety claim.

The OpenClaw adapter verifies a pinned signature, binds the validated payload to that verified digest, and stages a new workspace with the immutable archive, supported skill frontmatter, identity receipt, permissions and execution instructions. It does not modify OpenClaw core or personal configuration. Enforcement occurs inside the reference runtime when invoked through its trusted workflow. Loading Markdown in OpenClaw alone is not policy enforcement. See `docs/openclaw-integration.md` for exact supported interfaces and limitations.

Installation is local-file based. The separate [browser control plane](../docs/browser-control-plane.md) now also **acquires** an artifact from an explicit HTTPS URL under an SSRF-hardened policy, snapshots its bytes once, evaluates container/integrity/schema/runtime/signature/trust as distinct layers, and issues a digest-bound authorization receipt. It additionally evaluates `model_requirements` against a **host-supplied** provider-neutral model catalog and freezes an explicitly chosen model into a hashed [run plan](../docs/model-selection-and-run-plan.md); it discovers no models itself, and a run plan is preflight, not authority to run. Acquisition, authorization and run-plan preparation are not installation or execution, and the control plane executes nothing. A ready run plan is handed to a separate trusted namespace, the [model-router bridge](../docs/model-router-bridge.md), which binds the exact selected model; the control plane cannot import it, and no package workflow, worker or tool runs through it. NANDA discovery, AgentRank, dependency installation, remote agents, payment/escrow, persistent memory, executable package modules and marketplace infrastructure remain explicit future work. HTTPS/NANDA locator metadata leaves a discovery extension point without pretending to implement it; an `update.locator` is never fetched automatically.
