# Model selection and the run plan

This milestone answers the question the [Agent Browser](openclaw-agent-browser.md)
deliberately left open: an authorized package is allowed to run, but *with whose
intelligence?*

It adds four things and stops:

```text
 authorized package
        │
        ▼  OpenClaw reports the models this host actually has
 model discovery
        │
        ▼  agentpkg compares them with what the package declared
 compatibility evaluation        compatible · unverified · incompatible
        │
        ▼  the person picks one; nothing is chosen for them
 explicit model selection
        │
        ▼  package + authorization + signer + model + catalog, frozen and hashed
 run plan
        │
        ✕  STOP. There is no Run action in this build.
```

Four things stay carefully apart throughout, and the vocabulary below keeps them
apart on purpose:

| | Owner | Example |
|---|---|---|
| **Package model requirements** | the package author | "structured output, reasoning, context ≥ 16,000" |
| **Host model catalog** | OpenClaw | "these five models exist here and are usable" |
| **The selected model** | the person | "use `openai/gpt-5.6-luna`" |
| **Execution routing** | a future `ModelRouter` | not in this build |

## 1. Who knows what

```text
 OpenClaw Control UI  ── typed feature operations ──▶  Agent Browser backend
                                                          │
                                        OpenClaw-native model discovery
                                                          │
                                        authenticated loopback ──▶ agentpkgd
                                                                      │
                                                     package requirement semantics
                                                     compatibility evaluation
                                                     authorization binding
                                                     run-plan creation and hashing
```

**OpenClaw owns** which providers are installed, which models are configured,
whether credentials exist, host model IDs, availability, and host-specific model
metadata.

**agentpkg owns** what a package declared, what those declarations *mean*, the
authorization receipt, the package identity and digest, and the run-plan schema
and its validity.

The control plane discovers nothing. `GET /v0/status` says so:

```json
"host_model_catalog": {"source": "supplied_by_host", "note": "…"}
```

No provider name, model family or vendor capability vocabulary exists anywhere
in `agentpkg`. Its evaluator does exact-name lookups over a capability map the
host fills in, so a host that knows about capabilities agentpkg has never heard
of works without a format change.

## 2. Discovering models from OpenClaw

`openclaw-agent-browser/src/host-models.ts` is the only file in this project that
knows what OpenClaw is.

### The API used, and why

`buildModelsProviderData` from **`openclaw/plugin-sdk/models-provider-runtime`**
— the same published catalog OpenClaw's own `/models` picker reads. It returns:

* `modelCatalog`: the catalog rows (`ModelCatalogEntry`);
* `byProvider`: provider → the model ids the host is currently willing to offer,
  which is exactly *available on this host* rather than *exists somewhere*;
* `modelNames`, `resolvedDefault`, `pendingProviders`, `refreshWarning`.

It performs no provider discovery of its own and starts nothing.

**The Gateway RPC `models.list` was inspected first and cannot be used.**
`api.runtime.gateway.request` routes through
`dispatchTrustedPluginGatewayMethod`, which throws unless
`canTrustedOfficialPluginRequestScopes` holds — that is, unless the plugin's
origin is `bundled` or it is a trusted-official install. The Agent Browser is a
workspace plugin (`origin: global`, `trust.reason: provenance-invalid`), so the
RPC is refused. The SDK subpath is the supported route for a plugin like this
one. See [§9](#9-known-limitations) for what that costs on a real host.

### The safe descriptor

The descriptor mirrors OpenClaw's own public model projection
(`buildPublicModelProjection`, *"keeps concrete route, auth, cost, and provider
parameters out of public model rows"*). Base URLs, request parameters, transport
compatibility flags, auth profiles and credentials never leave the Gateway
process.

```json
{
  "id": "openai/gpt-5.6-luna",
  "provider_id": "openai",
  "model_id": "gpt-5.6-luna",
  "display_name": "GPT-5.6-Luna",
  "available": true,
  "availability_reason": null,
  "selectable": true,
  "capabilities": {
    "reasoning":         {"value": true, "basis": "declared",     "detail": "…"},
    "structured_output": {"value": true, "basis": "derived",      "detail": "…"},
    "tool_use":          {"value": true, "basis": "host_default", "detail": "…"},
    "multimodal":        {"value": true, "basis": "declared",     "detail": "…"}
  },
  "limits": {"context_tokens": 272000, "native_context_window": 372000,
             "max_output_tokens": null},
  "properties": {"local": false, "privacy_class": null, "cost_class": null,
                 "status": null, "tags": ["host-default"]}
}
```

The field set is **closed**: `agentpkgd` refuses a descriptor carrying anything
else with `unknown_field`, so a future host cannot smuggle an endpoint or a key
through this boundary even by accident. Every string is length-bounded, every
capability is tri-state, and a catalog carries at most 128 models.

`local` is derived from the catalog row's `baseUrl` with the same rule as
OpenClaw's internal `isLocalBaseUrl` (loopback, wildcard and `.local` hosts).
The URL itself never leaves the function; only the boolean does, which is what
OpenClaw's own `includeDetails` projection exposes too.

Cost is **absent**: `ModelCatalogEntry` carries no cost field on this SDK
surface, so `cost_class` is `null` rather than guessed.

### Capability provenance

Three kinds of host answer are not equally strong, and collapsing them would be
dishonest. Every capability answer carries its `basis`:

| `basis` | Meaning | Source on OpenClaw 2026.9.5 |
|---|---|---|
| `declared` | the catalog row states this fact about this model | `reasoning`, `input`, `compat.supportsTools`, `compat.supportsJsonSchemaResponseFormat` |
| `host_default` | the row is silent and OpenClaw applies its own documented default | `supportsModelTools(model)` is `compat?.supportsTools !== false` — tools are offered unless a provider opts out |
| `derived` | OpenClaw's mechanism for one capability *is* another capability | structured output is the synthetic `structured_output` tool (`docs/tools/swarm.md`), and `sessions_spawn` refuses an `outputSchema` for a model declaring `compat.supportsTools=false` |
| `absent` | the host has no answer | value is `null`, never `false` |

Only the last is "unknown". The other three are host statements, not agentpkg
guesses, and each one's origin travels all the way into the run plan so a person
can see *why* a requirement was considered satisfied.

This matters on the shipped host: OpenAI catalog rows on 2026.9.5 do not set
`compat.supportsTools`, so `tool_use` is `host_default` and `structured_output`
is `derived` from it. Those models are genuinely compatible — OpenClaw *will*
offer them tools — but the page says the evidence is derived rather than
declared, and the run plan records `evidence_strength: "derived"`.

## 3. Package model requirements, normalized

`agentpkg.browser.hostmodels.requirement_set` reads the manifest's existing
`model_requirements` and produces a generic requirement set. Nothing is flattened
away: per-task detail is retained so a future per-task or per-node binding can use
the same structure.

Because this profile binds **one** model to every task, the effective hard
requirement is the union of task capabilities and the largest declared context
window:

```json
{
  "hard_requirements": [
    {"id": "capability:reasoning", "kind": "capability", "subject": "reasoning",
     "operator": "is_true", "value": true, "tasks": ["plan", "screen", …]},
    {"id": "capability:structured_output", …},
    {"id": "context_tokens:minimum", "kind": "context_tokens",
     "operator": "at_least", "value": 16000, "tasks": […]}
  ],
  "preferences": [{"id": "preferred_tier:reasoning", …}],
  "binding_strategy": "single_model"
}
```

`privacy: "local-only"` becomes the hard requirement `property:local`, matching
what `Runtime.call_model` already enforces (`PolicyError("Package requires a
local-only model router")`). `preferred_tier`, `latency_preference` and
`cost_sensitivity` become **preferences**, which are reported and never enforce
anything.

The evaluator lives in generic `agentpkg` code. Neither reference package has any
selection logic of its own, and the Literature Review and Meeting Agenda packages
differ on screen only because they declare different tasks.

## 4. Tri-state compatibility

| Status | Meaning |
|---|---|
| `compatible` | every hard requirement is confirmed satisfied |
| `incompatible` | at least one hard requirement is confirmed violated |
| `unverified` | nothing is violated, but at least one hard requirement's host value is unknown |

**Unknown is never silently either boolean.** A host that does not report a
capability produces `host_value: null`, `status: "unknown"`, and the model lands
in `unverified` — not in `compatible` (which would claim something nobody
established) and not in `incompatible` (which would refuse a model that may be
perfectly fine).

Each requirement carries its own verdict:

```json
{"id": "context_tokens:minimum", "kind": "context_tokens", "operator": "at_least",
 "value": 16000, "host_value": 272000, "status": "satisfied",
 "basis": "declared", "source": "limits.context_tokens",
 "tasks": ["plan", "screen", "extract", …]}
```

Availability is a **separate axis** from compatibility. An unavailable model is
still evaluated and displayed with its reason; it simply cannot back a run plan.
So is `selectable`: a model the host will not offer as a manual choice is shown
and refused.

Preferences never change a status. An unmet `preferred_tier` leaves a model
compatible, and says `status: "unknown"` about the preference itself.

### Ordering

Available before unavailable, then compatible → unverified → incompatible, then
by identifier. This is presentation order, **not** a quality ranking: nothing in
this milestone says one compatible model is better than another.

## 5. Execution modes and run-specific permissions

This is the subtle one.

Literature Review declares `model.reasoning` as **optional**, because it can also
run from fixtures. A person choosing a *model-backed* run is choosing a run mode
that needs model access regardless of what the package marked required.

The package manifest is never rewritten to express this. Instead the requirement
belongs to the **execution mode**:

```python
MODE_REQUIRED_PERMISSION_KINDS = {"model": ("model",)}
```

Expressed as permission *kinds*, not identifiers, so no package name is ever
special-cased. This mirrors what the runtime already does: `Runtime.call_model`
resolves `self._permission_kind("model")`, refuses when the list is empty
(`"Model use requires an explicit model permission"`), and authorizes **every**
such permission before dispatch.

So with `model.reasoning` denied:

* the page still lists and explains the host's models — inspection is allowed;
* **no run plan is created.** The refusal is
  `run_plan_refused` / `execution_mode_permission_denied`, and the message names
  the permission and says to authorize again.

The person changes the decision to *Allow once* or *Allow for session*,
re-authorizes, and only then can a plan be prepared. Nothing is granted on their
behalf.

`model` is the only execution mode a run plan can request. Fixture and extractive
runs remain development modes of the CLI; the browser does not offer them and
they get no plan.

## 6. The run plan

A run plan binds five things that must not drift apart between the moment a
person decides and the moment anything runs:

> these bytes · this signer and trust state · this authorization receipt ·
> this host model · this catalog state

```json
{
  "schema": "agentpkg-run-plan-v0",
  "run_plan_version": "0.1",
  "run_plan_id": "rp_fb52c156ab4741b2aed7cd0baaee57e5",
  "created_at": "…", "expires_at": "…", "session_id": "…",
  "control_plane": {"service": "…", "api_version": "v0", "instance_id": "…"},
  "source": {"kind": "file", "display": "…", "opened_at": "…"},
  "package": {"package_id": "…", "name": "…", "version": "…",
              "digest": "…", "archive_sha256": "…",
              "entrypoint": "workflow.v0", "execution_profile": "workflow.v0"},
  "publisher": {"claimed_id": "…", "claimed_name": "…", "signer_fingerprint": "…",
                "signature_status": "valid", "trust_status": "trusted",
                "trust_reason": "operator_pinned_key"},
  "trust_store": {"path": "…", "entry_count": 1, "state_sha256": "…"},
  "validation": {…four layers…},
  "authorization": {"receipt_id": "…", "receipt_sha256": "…",
                    "issued_at": "…", "expires_at": "…", "runnable": true,
                    "decisions": {…}, "tool_approvals": {…},
                    "granted_permission_ids": [...]},
  "execution": {"profile": "workflow.v0", "mode": "model",
                "binding_strategy": "single_model",
                "required_permission_ids": ["model.reasoning"],
                "required_tool_ids": [...], "probe_tool_id": null,
                "tool_binding_count": 0,
                "performed": false, "note": "…"},
  "model_binding": {"strategy": "single_model", "selected_at": "…",
                    "host_model_id": "openai/gpt-5.6-luna",
                    "provider_id": "openai", "model_id": "gpt-5.6-luna",
                    "display_name": "GPT-5.6-Luna",
                    "descriptor": {…the exact safe descriptor…},
                    "compatibility": {…per-requirement verdicts…},
                    "catalog": {"catalog_sha256": "…", "model_count": 5,
                                "available_model_count": 5, "host": {…}}},
  "model_requirements": {…normalized requirement set…},
  "tool_bindings": [ …one exact host implementation per declared tool… ],
  "tool_registry": {"registry_sha256": "…", "binding_count": 2, "host": {…}},
  "browser_policy": {…},
  "readiness": {"state": "ready", "ready": true,
                "compatibility_status": "compatible", "blocking_reasons": []},
  "run_plan_sha256": "da5aeefaba415d0c…"
}
```

`mode` is `model` — authority to run the package's own graph, which needs a
model *and* every declared tool bound, approved and permitted — or `tool_probe`,
a strictly smaller authority for one mediated call to one declared tool, which
binds `model_binding: null` and names its tool in `probe_tool_id`. The two are
separate modes so neither artifact can be mistaken for the other; see
[the tool broker](tool-broker.md) for what a `tool_bindings` entry contains and
what makes one stale.

`run_plan_sha256` is the SHA-256 of the canonical (RFC 8785) plan **without that
field** — the same construction the authorization receipt uses. Its purpose is
integrity and binding, not publisher identity; no second asymmetric signing
system was invented.

The descriptor is stored in full, so a later runner can compare *what the host
said then* with *what the host says now* rather than trusting a summary.

### A plan exists only when it is ready

Preparation is refused outright if anything blocks it — a missing or superseded
receipt, a denied run-mode permission, an untrusted publisher, an invalid
signature, an unavailable or incompatible model. Writing down a plan that could
not be run would create an artifact asserting a binding the host refuses, and
"prepared" would stop meaning anything. The refusal carries every reason with a
stable `code` and `subject` so a UI can send the person to the exact control that
fixes it.

### Catalog snapshot binding (TOCTOU)

Two independent checks keep a stale selection out of a plan:

1. the plugin backend **re-reads the host catalog immediately before preparing**
   and refuses with `model_unknown` if the model is no longer offered;
2. the plan records `catalog_sha256` over the canonical catalog that produced the
   verdict, so the state it was evaluated against is identifiable afterwards.

A read of a prepared plan re-checks availability again and reports
`model_still_available: true | false | null` (`null` when the host catalog is
temporarily unreachable — unknown availability is not unavailability).

## 7. Staleness: the plan is frozen, readiness is not

The plan is immutable. The world around it is not. Readiness is therefore
**recomputed on every read** rather than stored as a verdict:

```json
{"state": "stale", "ready": false, "stale": true,
 "stale_reasons": [{"code": "publisher_trust_changed", "message": "…"}],
 "trust_store_changed": true, "model_still_available": false}
```

| Event | Effect | Code |
|---|---|---|
| Re-authorization | the plan is **discarded** immediately | — |
| Explicit discard | the plan is removed | — |
| Session closed or expired | the plan goes with it | — |
| Receipt expired | stale | `authorization_expired` |
| Publisher trust withdrawn or changed | stale | `publisher_trust_changed` |
| Signature status changed | stale | `signature_status_changed` |
| Signer changed | stale | `signer_changed` |
| Plan expired | stale | `run_plan_expired` |
| Selected model no longer offered | stale | `model_no_longer_available` |

Re-authorization **discards** rather than marks stale, deliberately: a changed
consent decision must not leave an older ready plan sitting there. Everything
else becomes stale so the person can see the plan and the reason it stopped being
usable side by side.

Run plans are session-scoped. They are never persisted, and closing the package
takes its plan with it — the same rule that already applies to receipts.

## 8. Unverified models and the browser policy

`BrowserPolicy.require_confirmed_model_compatibility` defaults to **true**: an
`unverified` model cannot back a ready run plan, and preparation is refused with
`model_compatibility_unverified` naming the exact requirements that could not be
confirmed.

`agentpkg browser-serve --allow-unverified-model` lowers that requirement for
research use, exactly as `--allow-unsigned` and `--allow-untrusted-publisher`
already do. The plan still records the real `compatibility_status: "unverified"`
and the relaxed `browser_policy`, so a lowered bar is visible rather than hidden.

This is **not** a per-model "trust me, it works" override: it is one host policy
flag, off by default, recorded in the artifact. No such override was needed for
OpenClaw 2026.9.5's own models, which reach `compatible` through the host's own
declarations and documented defaults (§2).

## 9. Known limitations

**The two catalog surfaces disagree on this host.** OpenClaw's Gateway RPC
`models.list` (`view: "default"`, `includeDetails: true`) reports **seven** usable
models; the plugin-SDK path this plugin is allowed to use reports **five**. The
two extra rows (`openai/gpt-5.4-pro`, `openai/gpt-5.5-pro`) are account-discovered
entries carrying **no** reasoning, context or modality metadata at all, so they
would evaluate to `unverified` if they appeared. Recorded in
[`model-selection-run-plan.json`](../examples/verification/model-selection-run-plan.json).
Closing this gap needs either a plugin-SDK surface that exposes the same rows, or
a trusted-official install that may call the Gateway RPC. Neither is invented
here.

**No cost metadata.** `ModelCatalogEntry` on this surface has no cost field, so
`cost_class` is `null`. Costs exist in provider manifests but are not projected
to this catalog.

**`max_output_tokens` is always `null`.** The host does not report a per-model
output cap on this surface; the package's own budget still bounds output at run
time.

**Structured output has no first-class per-model flag.** OpenClaw 2026.9.5
publishes no `supports_structured_output` per model. The `derived` basis (§2) is
the host's own mechanism, and it is labelled as derived everywhere rather than
presented as a declaration. If a later host version adds a direct flag, use it
and the basis becomes `declared` with no other change.

**The evaluated capability vocabulary is what the host chooses to speak.**
`tool_use`, `structured_output`, `reasoning` and `multimodal` are the names this
integration fills in. A package requiring a capability outside that set gets
`unknown` for it, and lands in `unverified` — which is the honest answer.

**Single-model binding only.** One model serves the whole workflow. Per-worker,
per-node and per-requirement bindings, fallback chains, automatic selection and
cost optimization are all out of scope; the schema keeps
`model_binding.strategy` so they can be added without breaking the format.

## 10. The non-execution boundary still holds

Model **discovery** is allowed. Model **inference** is not.

Nothing in this milestone calls `runtime.llm.complete`, a `ModelRouter`, a
provider API, `Workflow.execute`, a `ToolHandler`, Citation Resolver or any
scholarly provider. The next milestone adds exactly one model call, in a
[separate trusted namespace](model-router-bridge.md) that the control plane
still cannot import; everything below remains true after it. Structurally:

* `agentpkg/browser/` still imports no execution module — the AST scan in
  `test_browser_boundary.py` covers `hostmodels.py` and `runplan.py` like every
  other browser module, and a second test asserts that neither mentions
  `complete(`, `count_tokens`, `ModelRouter`, `router.`, `http` or `socket`;
* a fresh interpreter runs the **complete** open → authorize → evaluate → prepare
  cycle for both packages and then proves no execution module is in
  `sys.modules`;
* the control plane exposes no execution route, `capabilities.execute` is
  `false`, `health.execution` is `"disabled"`, and both the plan and the summary
  carry `execution.performed: false`;
* the feature contract contains no operation matching `execute|invoke|dispatch|
  complete`, and `run-plan.*` is the only name containing "run";
* the page has no Run action, and a test asserts no button label starts with
  run/start/execute.

## 11. Feature contract additions

| Operation | Kind | Scope | Purpose |
|---|---|---|---|
| `models.evaluate` | query | `operator.read` | Discover this host's models and evaluate them against one package |
| `run-plan.get` | query | `operator.read` | Read the prepared plan plus a fresh preflight check |
| `run-plan.prepare` | action | `operator.write` | Bind package + authorization + one chosen model into a plan |
| `run-plan.clear` | action | `operator.write` | Discard the prepared plan |

New typed error codes: `model_catalog_unavailable`, `model_unknown`,
`run_plan_refused`, `run_plan_absent`.

## 12. Control-plane additions

| Method | Route | Purpose |
|---|---|---|
| GET | `/v0/packages/{id}/models` | Normalized package requirements, execution modes, run-mode permission ids |
| POST | `/v0/packages/{id}/models/evaluate` | `{package_digest, catalog}` → compatibility evaluation |
| POST | `/v0/packages/{id}/run-plan` | `{package_digest, receipt_id, model_id, catalog, execution_mode?, binding_strategy?}` → plan + preflight |
| GET | `/v0/packages/{id}/run-plan` | The plan plus a recomputed preflight |
| DELETE | `/v0/packages/{id}/run-plan` | Discard it |

All are pure control-plane operations. No execution endpoint exists.

The request-body bound rose from 64 KiB to 256 KiB because a host catalog *is* a
request body; every field inside a descriptor remains separately length-limited
and the catalog is capped at 256 models.

## 13. The manual demo

Prerequisites: OpenClaw 2026.9.5 with **Settings → Labs → Custom plugin UI**
enabled, and the plugin installed (see the
[plugin README](../openclaw-agent-browser/README.md)).

1. Open **Agent Browser** in the OpenClaw Control UI.
2. Open a package — the address bar for an HTTPS URL, or the local-path field for
   an operator-configured directory.
3. Review **Verification and trust**. If the publisher is unknown, expand *Review
   publisher key* and pin it. The demo key covers both reference packages at
   publisher scope.
4. In **Permissions**, set the required permissions **and `model.reasoning`** to
   *Allow for session*. Press **Authorize**.
5. Scroll to **Model**. The page lists what this host reports, each with
   Compatible / Unverified / Incompatible, its context window, and a
   *Compatibility details* disclosure showing every requirement, the host's own
   answer, and where that answer came from.
6. Choose one model explicitly. Nothing is preselected.
7. Press **Prepare run**.
8. **Ready to run** appears with the package, publisher, authorization, model,
   execution profile, run-plan id and run-plan hash — and the line *Execution is
   not enabled in this build.* There is no Run button.

To see the permission rule: authorize with `model.reasoning` on **Deny**. The
models still render, *Prepare run* stays disabled, and the page explains which
permission the run mode needs and where to change it.

## 14. Before the next milestone (execution)

> **Delivered since.** Points 1–3 and 5 are answered by [the model-router
> bridge](model-router-bridge.md): a preflight that re-verifies every fact in
> this list, a `ModelRouter` that declares what it can actually deliver for the
> bound model, honest token accounting with a provable input bound, and real
> `cost_usd` from the host. Point 4 — a run surface — is still open, which is
> why there is still no Run button.


1. **A run plan is preflight, not a capability.** The runner must re-open the
   snapshot, re-check the digest and archive hash, re-verify the signature and
   trust, re-check the receipt, re-confirm the model, and re-run the preflight
   before dispatching anything. The plan tells it exactly what to compare
   against.
2. **The router adapter is the missing piece.** `workflow.v0` checks capabilities
   against the *router*, not the raw model (`spec/workflow-v0.md` §7). An OpenClaw
   `ModelRouter` adapter will declare which capabilities it can actually deliver
   for a bound model — including how it obtains structured output — and its
   declaration should feed the same evaluator so `derived` can become `declared`.
3. **Honest token accounting.** The control plane's budget guarantees depend on a
   router that reports all billable tokens, enforces the output cap, and
   cooperates with cancellation.
4. **Run output needs its own surface.** An audit stream, usage counters and
   exports are a new UI, not a variation of this one.
5. **`max_output_tokens` and cost.** Both are `null` today; a router adapter that
   knows them should supply them rather than the catalog guessing.

See also: [the milestone report and real-host results](model-selection-report.md),
[the control plane](browser-control-plane.md), [the Agent Browser
plugin](openclaw-agent-browser.md), [the execution
profile](../spec/workflow-v0.md), [threat model](threat-model.md).
