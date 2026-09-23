# The OpenClaw Agent Browser plugin

This is the first visible version of the PDF's central idea: a browser-like
place inside OpenClaw where a person opens an agent package, sees what it is and
what it wants, and decides. It is a native Control UI page backed by a trusted
plugin backend that owns the agentpkg control plane.

**Milestone boundary: no package executes.** The furthest state the *page* can
reach is a prepared, hashed **run plan**: the package, its authorization, its
publisher and one explicitly chosen host model, frozen together and marked
*Ready to run*. There is no Run action and no workflow instantiation anywhere in
it. Model discovery and selection are documented separately in [model selection
and the run plan](model-selection-and-run-plan.md).

Two operator-only surfaces sit behind the page and are not rendered by it.
`execution.tool-probe` re-verifies a ready plan and makes one mediated call to
one tool the package declares, through the implementation the plan bound; see
[the tool broker](tool-broker.md).
`router.probe` re-verifies a ready plan and makes a single host-owned model call
to prove the `ModelRouter` contract; no package skill, node, worker or tool takes
part in it ([the model-router bridge](model-router-bridge.md)). The `execution.*`
operations re-verify the same plan and **run the package's own graph** through
the generic interpreter, on the model the plan bound, with no tool handler
installed ([package execution](package-execution.md)). A test asserts the
browser half of this plugin calls neither.

Tested against **OpenClaw 2026.9.5 (`ec9c1a1`)**. Every plugin API used here is
documented as experimental; this milestone is pinned to that host version.

## 1. Architecture and trust boundary

```text
 ┌──────────────────────────────────────────────────────────────┐
 │ OpenClaw Control UI  (browser, operator's Gateway authority)  │
 │   Agent Browser page — src/ui/page.ts                         │
 │   • renders what it is told                                   │
 │   • holds no credentials, opens no sockets                    │
 └───────────────┬──────────────────────────────────────────────┘
                 │ createFeatureClient → plugins.sessionAction
                 │ typed operations, operator.read / operator.write
 ┌───────────────▼──────────────────────────────────────────────┐
 │ Agent Browser backend  (Gateway process)                      │
 │   • supervises `agentpkg browser-serve`                       │
 │   • holds the bearer token in memory only                     │
 │   • resolves operator-configured local roots                  │
 │   • projects control-plane JSON into bounded DTOs             │
 └───────────────┬──────────────────────────────────────────────┘
                 │ authenticated loopback HTTP (node:http)
 ┌───────────────▼──────────────────────────────────────────────┐
 │ agentpkgd — `agentpkg browser-serve`                          │
 │   the authority for container/integrity/schema/runtime        │
 │   validation, Ed25519 signatures, publisher trust, permission │
 │   semantics, authorization receipts and URL/SSRF policy       │
 └──────────────────────────────────────────────────────────────┘
```

The browser half **never** receives the control-plane token, the loopback port,
trust-store material, or filesystem access. It cannot reach the control plane
directly even if it learned the port: that service refuses any request carrying
browser fetch-metadata headers.

No validation, signature check, trust evaluation, permission semantic or URL
policy is reimplemented in TypeScript. The plugin renames fields and bounds
lists; every security decision is copied verbatim from
[the control plane](browser-control-plane.md).

## 2. OpenClaw SDK surfaces used

| Surface | Use |
|---|---|
| `openclaw/plugin-sdk/feature-contract` · `defineFeatureContract` | One typed contract shared by both halves |
| `openclaw/plugin-sdk/feature-contract` · `createFeatureClient` | The page's only way to reach the backend |
| `openclaw/plugin-sdk/feature-plugin` · `defineFeaturePlugin` | Registers each operation as a session action with a scope, validating input and output against the contract |
| `openclaw/plugin-sdk/plugin-entry` · `buildJsonPluginConfigSchema` | Declares operator configuration |
| `openclaw/plugin-sdk/tool-plugin` · `toolPluginMetadataSymbol` | Reattaches manifest metadata with that config schema (see below) |
| `openclaw/plugin-sdk/control-ui` · `defineControlUiPlugin` | `registerNavigation` + `registerPage` |
| `openclaw/plugin-sdk/models-provider-runtime` · `buildModelsProviderData` | Host model discovery: the same published catalog `/models` reads |
| `api.registerService({ id, start, stop })` | Owns the long-lived control-plane child, with `ctx.serviceHealth` for late failures |

One detail is worth recording because it is version-specific.
`defineFeaturePlugin` in 2026.9.5 takes no config-schema option and publishes its
manifest metadata through the exported `toolPluginMetadataSymbol` as a
**non-configurable** property. `openclaw plugins build` reads that metadata and
overwrites `openclaw.plugin.json`, so a plugin that only edits the manifest file
loses its config schema on the next build. The plugin therefore rebuilds the
entry object from its own property descriptors (a plain spread would drop the
symbol) with the schema attached. If a later host version adds a first-class
option, use it instead.

## 3. Control-plane lifecycle and token ownership

The operator never starts `agentpkg browser-serve` by hand.

```text
 plugin service start
   → resolve agentpkg: config.agentpkgPath → AGENTPKG_BIN → PATH
   → create <stateDir>/agent-browser (0700), resolve it to a physical path
   → reap an orphan from a previous Gateway, identity-checked by its own argv
   → wipe the per-run directory, create a private snapshot cache
   → spawn: agentpkg browser-serve --host 127.0.0.1 --port 0 --quiet
              --token-file <run>/token --cache-dir <run>/cache
              --trust-store <stateDir>/agent-browser/trust.json
   → read the single-line startup JSON from stdout → the loopback URL
   → read the 0600 token file, then delete it
   → write a pid file recording {pid, marker}
   → health check → running
 plugin service stop
   → SIGTERM, then SIGKILL after a grace period; remove pid file and run dir
```

Token secrecy rests on four things:

1. `--quiet` (added to `agentpkg` for this milestone) keeps the token out of the
   child's stdout, so it cannot reach Gateway logs;
2. the token file is `0600` and is **deleted immediately** after one read;
3. the token exists afterwards only in the backend process's memory, and no
   feature operation returns it — a test asserts the exact token string appears
   in no operation output;
4. the page cannot ask for it: the contract has no operation that could return
   it, and inputs and outputs are schema-validated on both sides.

`--quiet` also prints the startup line as **compact single-line JSON**, so a
supervising host can detect readiness without buffering an indented document.

**Restart safety.** Starts are single-flight, so concurrent operations never
spawn two children. The pid file lets a new plugin instance find a child left by
a crashed Gateway; before signalling, it confirms the live pid's argv contains
this plugin's own cache path, so it can never kill an unrelated process. A
restart wipes the snapshot cache but keeps the trust store, because publisher
pins are persistent operator configuration and package sessions are not.

**Failure is a state, not an exception.** `unconfigured`, `stopped`, `starting`,
`running` and `failed` are reported through `service.status`; the page shows a
bounded explanation and a **Retry** action that calls `service.restart`. A
failed start is never retried automatically, so a broken configuration cannot
produce a spawn loop. Python tracebacks never reach the page: the backend keeps
at most the last 600 characters of child stderr as a detail line.

## 4. Feature contract

Queries require `operator.read`, actions `operator.write` — enforced by the SDK,
not by this plugin.

| Operation | Kind | Purpose |
|---|---|---|
| `service.status` | query | Service state, control-plane identity, capabilities |
| `packages.list` | query | Open package sessions |
| `packages.get` | query | The full package view for one session |
| `packages.permissions` | query | The authorization request, all decisions defaulting to deny |
| `packages.authorization` | query | The receipt issued for a session, or null |
| `models.evaluate` | query | This host's models, evaluated against the open package |
| `tools.evaluate` | query | This host's tool implementations, evaluated against the package's declarations |
| `run-plan.get` | query | The prepared run plan plus a freshly recomputed preflight |
| `execution.status` | query | *Operator only.* A session's ephemeral run records, and the active one |
| `execution.get` | query | *Operator only.* One run record |
| `execution.artifact` | query | *Operator only.* One named artifact a run wrote, bounded |
| `trust.list` | query | Publisher keys pinned by this operator |
| `packages.open-url` | action | Open an HTTPS package through the control plane |
| `packages.open-local` | action | Open a file inside an operator-configured root |
| `packages.close` | action | Close a session and delete its snapshot |
| `packages.authorize` | action | Record decisions, receive a receipt |
| `run-plan.prepare` | action | Bind package + authorization + one chosen model into a run plan |
| `run-plan.clear` | action | Discard the prepared run plan |
| `router.probe` | action | *Operator only.* Prove the router contract with one host-owned call |
| `execution.tool-probe` | action | *Operator only.* Make one mediated call to one declared tool, with a host-owned fixture and no model |
| `execution.start` | action | *Operator only.* Run the signed package on the model its plan bound |
| `execution.cancel` | action | *Operator only.* Stop a running workflow |
| `execution.clear` | action | *Operator only.* Forget finished run records |
| `trust.pin-session-publisher` | action | Pin the key that signed one open session |
| `trust.remove` | action | Remove a pin |
| `service.restart` | action | Restart the control plane |

No agent-callable tool is declared. This is an operator surface; a model has no
reason to open or authorize packages on the operator's behalf in this milestone,
and `contracts.tools` is empty in the manifest.

**Typed results, not thrown strings.** The feature transport reduces a thrown
handler error to a bare message, which a UI cannot branch on. Fallible
operations therefore return `{ ok: true, value } | { ok: false, error }` where
`error.code` is one of a closed set: `service_unavailable`, `invalid_request`,
`not_allowed`, `url_rejected`, `download_failed`, `package_rejected`,
`source_rejected`, `session_expired`, `digest_mismatch`, `trust_conflict`,
`signature_not_valid`, `limit_reached`, `control_plane_error`,
`model_catalog_unavailable`, `model_unknown`, `run_plan_refused`,
`run_plan_absent`. Control-plane codes map onto these in one table in
`src/errors.ts`.

**Projection, not pass-through.** The page receives explicitly enumerated
camelCase DTOs with every list bounded (`src/project.ts`, `src/contract.ts`).
Snapshot paths, cache locations and other host-internal fields are dropped. The
SDK validates both directions against the same schemas, so a projection bug
fails loudly instead of leaking.

## 5. Page structure

| Section | Content |
|---|---|
| Header | Service state chip, control-plane version, Retry when unavailable |
| Address bar | HTTPS URL entry; optional local-path entry when roots are configured |
| Open packages | Session tabs with trust status |
| Package header | Name, package ID, version, description, execution profile, file count, session expiry, source |
| Verification and trust | Container / Integrity / Schema / Runtime rows, then signature, then publisher — see below |
| Warnings | One row per warning, rendered from `code` and `severity` |
| Package contents | Tabs: Overview (capabilities, skills), Tools, Workers, Workflow, Evals & attestations, Technical details |
| Permissions | Required and optional groups, one select each, deny by default |
| Declared limits | Budgets and delegation, labelled as runtime-enforced |
| Authorization | Authorize button, outcome, blocking reasons, expandable receipt |
| Model | Declared requirements; after authorization, this host's models with Compatible / Unverified / Incompatible, per-requirement detail, an explicit choice, and **Prepare run** |
| Run plan | *Ready to run*, the binding it froze, its hash, and "Execution is not enabled in this build." |

Presentation is entirely generic: there is no package-ID branch, and the two
reference packages differ on screen only because they declare different things.
A sophisticated graph visualization was not added; the workflow tab lists nodes,
types, dependencies, parallelism and exports.

## 6. Trust user experience

The single most important rule in this page: **a valid signature must never look
like a trusted publisher.**

```text
 Container   ✓ Valid
 Integrity   ✓ Valid
 Schema      ✓ Valid
 Runtime     ✓ Compatible

 Signature   ✓ Cryptographically valid
 Signer key  sha256:c7549e61…

 Claimed publisher   WebAgents Research Prototype (webagents-research)
 Publisher trust     ? Unknown publisher
 "Nobody on this host has pinned this signing key, so the publisher is
  unverified."
```

Three trust states are rendered distinctly, with their own border treatment:
`trusted` (green), `unknown` (amber, with an explanation), `mismatch` (red,
thicker border, "treat this package as an impersonation risk"). All statuses
come from the control plane; nothing is recomputed client-side.

**Pinning is deliberate and narrow.** For a valid signature from an unknown key
the page offers *Review publisher key*, which shows the claimed identity, the
full signer fingerprint, the package ID, and the scope that would be trusted.
The scope defaults to the narrowest option — this package ID only — with "any
package from this publisher" as an explicit alternative. The confirm button
arms on the first press and pins on the second. There is no trust-on-first-use,
and no automatic pinning anywhere.

The key itself never travels through the browser. `trust.pin-session-publisher`
sends only the session id, the fingerprint the page displayed, and the scope;
the control plane pins the key from **that session's own verified signature
envelope** and refuses if the echoed fingerprint does not match or the signature
is not valid. A package can therefore never introduce key material, and a stale
page cannot pin a key it did not show the operator.

The page also states the lifetime difference plainly: a publisher pin is a
persistent operator decision, while package permissions last only for the
session.

## 7. Authorization user experience

* Every permission starts at **Deny**, required or optional, regardless of
  publisher trust. Trust and permission are separate decisions and the page says
  so.
* Only the decisions the control plane actually supports are offered: **Deny**,
  **Allow once**, **Allow for session**. *Always* is absent, and the page
  explains why it is not offered.
* Required permissions are labelled and grouped separately from optional ones.
* Tool approvals appear as their own checkboxes when a package declares a tool
  needing explicit approval.
* **Authorize** sends the session id, the exact digest the page displayed, and
  the explicit decisions. A mismatched digest is refused by the control plane.
* Success renders `✓ Authorized for this session` together with *The package has
  NOT executed. Authorization only records permission to proceed.*
* Failure lists blocking reasons by stable `code` and `subject`, for example
  `required_permission_denied · network.citations`.
* The receipt is available under *Authorization receipt (technical details)*:
  receipt id, times, package identity, digest, archive hash, signer, trust
  status, trust-store state, decisions, tool approvals, granted permissions,
  runnable, blocking reasons and the receipt hash.

Session expiry is honest: when the control plane reports a session is gone, the
page clears the package view and says so rather than leaving a stale receipt
visible.

## 8. Security properties

| Property | How |
|---|---|
| No secret in the browser bundle | The token is read and held in the Gateway process; no operation can return it (tested) |
| No browser access to the control plane | The page has no port, and the control plane refuses browser fetch-metadata headers |
| No HTML injection from packages | Every package string reaches the DOM through `textContent`; the plugin contains no `innerHTML` (tested with a hostile fixture) |
| Bounded payloads | TypeBox `maxItems`/`maxLength` on every field, plus truncation in the projection |
| Bounded filesystem reach | Local opening is limited to operator-configured roots, absolute paths, `.agent.pkg` only, with symlink escapes resolved and refused |
| Strict inputs | Unknown fields are rejected by the SDK's schema validation on both sides |
| Lifecycle safety | Single-flight start, identity-checked orphan reap, SIGTERM→SIGKILL stop, per-run cache wipe |
| Least privilege in the UI | Read-only operators see the page but get no Authorize button and disabled selects |
| Aborted views stop working | The page checks its `AbortSignal` after every await and removes itself on dispose |

One implementation note worth keeping: the backend talks to the control plane
with `node:http`, not global `fetch`. Node's fetch sends `sec-fetch-mode: cors`,
which the control plane's DNS-rebinding defense refuses. Rather than relax that
rule for a trusted caller, the backend sends an explicit minimal header set. It
also disables Node's keep-alive agent, because the control plane answers
`Connection: close` and a pooled socket would be reused after the server closed
it.

## 9. What this milestone does not do

* **No package execution from the page.** The page has no Run action, calls no
  `execution.*` or `router.probe` operation, and a run plan still reports
  `executionPerformed: false` after a run, because a plan never performs
  anything. Execution itself now exists, operator-only: see [package
  execution](package-execution.md).
* **No package tool runs from the page.** The page reads what this host
  implements for each declared tool and renders it beside the declaration and
  the approval; it calls none. Tool execution exists, operator-only, behind
  [the tool broker](tool-broker.md), and a tool this host has no implementation
  for is refused by name — `scholarly-search` and `paper-reader` still are, so
  Literature Review cannot be run here.
* **No model inference from the page.** Model *discovery* is allowed and
  *selection* is offered; the page calls no model. The operations that do —
  operator-only `router.probe` and `execution.start` — send host-owned or
  signed-package content respectively, and neither accepts a caller-supplied
  prompt, schema or model id.
* **No automatic or best-model selection**, no per-worker or per-node routing,
  no fallback chains, no cost optimization and no quality ranking.
* **No NANDA, Muse, Instinct or Maritime.** The address bar takes raw HTTPS URLs.
* **No persistent authorization.** Receipts live and die with their control-plane
  session, which is why *Always* is not offered.
* **No file picker.** OpenClaw 2026.9.5 exposes no native file-picker component
  to Control UI plugins, so local opening is an operator-configured directory
  list rather than browser-side filesystem access.
* **No package-provided UI.** A package cannot contribute markup, styles or
  scripts to this page.

## 10. Known limitations

* Native plugin UI is an experimental OpenClaw lab, off by default, and the
  plugin APIs used here may change between host versions.
* Install the packed artifact: a directory install also scans this project's
  `node_modules`, which contains OpenClaw's bundled plugins, and the registry
  reports conflicting child rows.
* One control-plane child per plugin instance per state directory. Two Gateways
  sharing a state directory would fight over the same runtime directory.
* Orphan reaping uses `ps`, so it is POSIX-only. The plugin has not been tested
  on Windows.
* The page polls `service.status` on load and after actions, and refreshes on the
  plugin's `browser-changed` event; it is not a live stream.
* Session tabs show the package ID rather than a display name, because the
  control plane's session list is intentionally minimal.
* The live Control UI rendering itself is verified by hand. Automated tests
  drive the page in a DOM with a fake feature client, and the plugin's load is
  verified in a real OpenClaw with an isolated configuration.

## 11. Verification

`openclaw-agent-browser/scripts/verify.mjs` (`npm run verify`) builds, validates,
packs, installs into a throwaway OpenClaw configuration, inspects what the host
loaded, and runs the test suite. Saved output:
[`agent-browser-plugin.json`](../examples/verification/agent-browser-plugin.json).

103 tests cover the contract, the supervisor against a real `agentpkg
browser-serve` child, the backend against a real control plane with both shipped
packages, host model discovery against a stubbed OpenClaw catalog, run-plan
preparation and staleness end to end, the page in a DOM, and the plugin
registration contract.

A separate record of the same flow driven against the operator's real OpenClaw
2026.9.5 host — including the models it actually reported — is
[`model-selection-run-plan.json`](../examples/verification/model-selection-run-plan.json).

## 12. Before the next milestone (execution)

1. **A receipt is consent, not a capability, and neither is a run plan.** The
   runner must re-open the snapshot, re-check the digest and archive hash,
   re-evaluate trust, re-confirm the model, re-run the run plan's preflight, and
   map decisions onto runtime grants before executing anything.
2. **Where run output goes.** The page currently has no place for an audit
   stream, usage counters or exports; that is a new UI surface, not a variation
   of this one.
3. **The router adapter is the missing piece.** `workflow.v0` checks capabilities
   against the *router*, not the raw model. An OpenClaw `ModelRouter` adapter must
   declare what it can actually deliver for a bound model, and the control plane's
   budget guarantees still depend on a router that reports usage honestly — the
   earlier integration notes on advisory token caps apply.
4. **Persistent authorization.** Offering *Always* requires a real host
   authorization store with its own revocation and review surface.
5. **Long operations.** Execution needs cancellation and progress; the current
   single "Opening and verifying package…" state deliberately invents no
   progress and would not be enough for a run.

See also: [the control plane](browser-control-plane.md), [model selection and the
run plan](model-selection-and-run-plan.md) with its [milestone
report](model-selection-report.md), [the control plane's milestone
report](browser-report.md), [the legacy staging
adapter](openclaw-integration.md), and the plugin's own
[README](../openclaw-agent-browser/README.md).
