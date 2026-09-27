# The OpenClaw Agent Browser plugin

This is the first visible version of the PDF's central idea: a browser-like
place inside OpenClaw where a person opens an agent package, sees what it is and
what it wants, and decides. It is a native Control UI page backed by a trusted
plugin backend that owns the agentpkg control plane.

**Since milestone 3C the page runs what it authorized** ([§5a](#5a-the-run-surface)).
Up to a prepared, hashed **run plan** — the package, its authorization, its
publisher and one explicitly chosen host model, frozen together and marked
*Ready to run* — nothing changes. From there the Run panel offers a task form
generated from the package's own input schema, a Run button that opens only
when every check holds, live progress, Cancel, reconnect after a reload, the
result, the artifacts and the technical audit. Run calls `execution.start` with
exactly `{sessionId, runPlanId, runPlanSha256, input, files, detach}`: the
package's own graph then runs through the generic interpreter on the model the
plan bound, with one generic tool handler per tool the plan bound
([package execution](package-execution.md), [the tool broker](tool-broker.md)).
Model discovery and selection are documented in [model selection and the run
plan](model-selection-and-run-plan.md).

Two operator-only surfaces remain behind the page and are not rendered by it.
`execution.tool-probe` re-verifies a ready plan and makes one mediated call to
one tool the package declares, through the implementation the plan bound.
`router.probe` re-verifies a ready plan and makes a single host-owned model call
to prove the `ModelRouter` contract ([the model-router
bridge](model-router-bridge.md)). A structural test asserts the browser half
never calls either.

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
| `execution.status` | query | Summaries of the runs this backend holds (one session's, or all), and the active run in full |
| `execution.get` | query | One run record |
| `execution.readiness` | query | Whether Run could start now, by the same checks `execution.start` makes; nothing is prepared |
| `execution.validate-input` | query | The package's own input schema's verdict on a task, by JSON pointer, via the control plane |
| `execution.artifact` | query | One named artifact a run wrote: at most 48 KiB, parsed when small JSON |
| `execution.artifact-chunk` | query | One 48 KiB slice of an artifact with the whole file's size and SHA-256, for downloads |
| `files.list` | query | The PDF capabilities this session holds |
| `trust.list` | query | Publisher keys pinned by this operator |
| `packages.open-url` | action | Open an HTTPS package through the control plane |
| `packages.open-local` | action | Open a file inside an operator-configured root |
| `packages.close` | action | Close a session and delete its snapshot |
| `packages.authorize` | action | Record decisions, receive a receipt |
| `run-plan.prepare` | action | Bind package + authorization + one chosen model into a run plan |
| `run-plan.clear` | action | Discard the prepared run plan |
| `router.probe` | action | *Operator only.* Prove the router contract with one host-owned call |
| `execution.tool-probe` | action | *Operator only.* Make one mediated call to one declared tool, with a host-owned fixture and no model |
| `execution.start` | action | Run the signed package on the model its plan bound (the page's Run button) |
| `execution.cancel` | action | Stop a running workflow |
| `execution.clear` | action | *Operator only.* Forget finished run records |
| `files.select-local` | action | Copy one operator-selected PDF from a configured root into private storage; returns an opaque `file_<32 hex>` id |
| `files.release` | action | Forget one selected file |
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
`run_plan_absent`, `run_plan_stale`, `probe_refused`, the model-call, bridge
and tool codes, `authorization_expiring`, `execution_refused`,
`execution_active`, `execution_unknown` and `input_invalid`. Control-plane codes
map onto these in one table in `src/errors.ts`.

**Projection, not pass-through.** The page receives explicitly enumerated
camelCase DTOs with every list bounded (`src/project.ts`, `src/contract.ts`).
Snapshot paths, cache locations and other host-internal fields are dropped. The
SDK validates both directions against the same schemas, so a projection bug
fails loudly instead of leaking.

**The host's own output limits.** Before any schema, `defineFeaturePlugin`
refuses an input or output over OpenClaw's plugin JSON limits — 32 levels,
4,096 nodes, 512 keys per object, 65,536 characters per string, 256 KiB
serialized — as `INVALID_OUTPUT`. `HOST_JSON_LIMITS` mirrors them (a test reads
the host's own constant), and every projection of unbounded data fits itself
first (`src/json-limits.ts`): run lists are summaries, artifact views and
download slices are 48 KiB, a task input is echoed only when small in shape as
well as size, an input schema too intricate to carry is left out (the task is
then edited as JSON), and a model catalog too large for one answer lists the
models a plan could use first and says how many it left out. The live UI
acceptance found the first three by exceeding them.

## 5. Page structure

| Section | Content |
|---|---|
| Header | Service state chip, control-plane version, whether runs are available, Retry when unavailable |
| Address bar | HTTPS URL entry; optional local-path entry when roots are configured |
| Open packages | Session tabs with trust status |
| Package header | Name, package ID, version, description, execution profile, file count, session expiry, source |
| **Run panel** | Checklist, task form, Run button, live progress, Cancel, result, artifacts, technical details — see §5a |
| Verification and trust | Container / Integrity / Schema / Runtime rows, then signature, then publisher — see below |
| Warnings | One row per warning, rendered from `code` and `severity` |
| Package contents | Tabs: Overview (capabilities, skills), Tools, Workers, Workflow, Evals & attestations, Technical details |
| Permissions | Required and optional groups, one select each, deny by default |
| Declared limits | Budgets and delegation, labelled as runtime-enforced |
| Authorization | Authorize button, outcome, blocking reasons, expandable receipt |
| Model | Declared requirements; after authorization, this host's models with Compatible / Unverified / Incompatible, per-requirement detail, an explicit choice, and **Prepare run** |
| Run plan | *Ready to run*, the binding it froze, its hash, and "Run this plan from the Run panel above." |
| Recent runs | Every run this backend holds, newest first, each openable — including finished runs recovered after a Gateway restart |

Presentation is entirely generic: there is no package-ID branch, and the two
reference packages differ on screen only because they declare different things.
A sophisticated graph visualization was not added; the workflow tab lists nodes,
types, dependencies, parallelism and exports.

## 5a. The Run surface

The Run panel sits directly under the package header and is the page's only
way to start anything.

**Checklist and gate.** Package verified · Publisher trusted · Permissions
authorized · Tools bound (n of n) · Model · Run plan ready · Task valid ·
Authorization valid for *N* more minutes (a run may take up to *M*). Each
unmet line says precisely why and offers **Go** to the section that fixes it.
The Run button is enabled only when all hold *and* the backend's
`execution.readiness` — the same preflight `execution.start` runs — agrees,
and it says why when it is not. Start re-checks everything regardless.

**Task form.** Generated from the package's own bundled input schema
(`workflow.input.document`): strings, numbers, booleans, enums, string lists,
object lists, string maps, and a *selected files* widget for maps whose values
are file capabilities. Validated presentation hints may relabel a field, make
it multiline, or group it as *Optional* / *Advanced*; they cannot add a field
or an action. **Edit as JSON** covers any shape the form does not render. The
backend validates the task against the package's schema as the person types
(`execution.validate-input`), naming each field by its title; a field's own
error appears beside it once it has been touched.

**Files.** A PDF is chosen by path inside an operator-configured root and
copied once into private storage; the package only ever sees an opaque
`file_<32 hex>` capability, and reading one still needs its `files.read`
permission granted.

**Progress.** From the run's own progress snapshot, polled every two seconds:
the package's stages (validated `agentpkg:presentation` hints, or its node
list), each stage's fan-out workers with their state, and model, tool and
remote calls, tokens and workers. Nothing is estimated or invented.

**Cancel** goes through `execution.cancel` → the runner's AbortSignal; the run
ends *cancelled* within seconds and says which node it stopped at. **Reload**
reconnects to a run in flight for an open session; a finished run whose
session has closed opens read-only (*From a previous Gateway session*).

**Result.** The package's primary export rendered as Markdown built from DOM
calls only (no HTML from text, only http(s) links, `noopener noreferrer
nofollow`), its declared summary exports as counts with expandable rows, every
artifact with **View** (48 KiB, truncation stated) and **Download** (48 KiB
slices, reassembled and checked against the file's SHA-256), and **Technical
details**: package, digest, archive hash, run plan and its hash, run
invocation, task input hash, model and whether every call used it, tools and
bindings, permissions, usage against limits, cost, audit chain, workers, and
every check re-verified before start. A run that finds nothing grounded
completes with the package's own *No sufficiently grounded literature found*
text and empty tables — shown as a completed run, not an error. A failed run
names its error code, the node and the package check that stopped it.

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
| Run starts only what was authorized | `execution.start` takes exactly six fields; a model, binding, tool, path, archive, executable, command or URL in a start is refused by the Gateway's schema check before the plugin runs (live probes) |
| Everything is re-verified at Run | Preflight re-checks plan identity and hash, package bytes, signature, signer, publisher trust, receipt and its remaining time, bindings, approvals, model availability and identity; the runner re-verifies the snapshot itself |
| One run per plan and session | A second start while one runs is refused with `execution_active` |
| Files are capabilities, not paths | A task names `file_<32 hex>` ids the session holds; a path, a forged id, an id the run was not given, or a file outside the roots is refused |
| Package labels are hints, not authority | `agentpkg:presentation` is noncritical, validated by the control plane against a closed vocabulary; it can relabel, never add a control |
| Model-produced text is inert | Markdown is rendered with DOM calls only: no markup, scripts or images from text, only http(s) links opened with `noopener noreferrer nofollow` (tested with hostile text) |
| Artifacts by name, not path | One plain filename matching `^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,127}$`, listed in that run's own directory, opened with `O_NOFOLLOW`; traversal, absolute and encoded names are refused (live probes) |
| Downloads are verified | Assembled from 48 KiB slices and checked against the whole file's SHA-256 before saving |
| No new network or process from the browser | A structural test: the browser half imports only the contract, its own modules and the Control UI SDK, and has no `fetch`, socket or subprocess |

One implementation note worth keeping: the backend talks to the control plane
with `node:http`, not global `fetch`. Node's fetch sends `sec-fetch-mode: cors`,
which the control plane's DNS-rebinding defense refuses. Rather than relax that
rule for a trusted caller, the backend sends an explicit minimal header set. It
also disables Node's keep-alive agent, because the control plane answers
`Connection: close` and a pooled socket would be reused after the server closed
it.

## 9. What this milestone does not do

* **No chat and no general execution API.** The page starts one thing — the
  prepared run plan of the open package — and a run plan still reports
  `executionPerformed: false` after a run, because a plan never performs
  anything; each run is its own record.
* **No tool call and no model call of the page's own.** Tools and the model are
  reached only by the package's graph during a run, through the bindings its
  plan froze. `router.probe` and `execution.tool-probe` stay operator-only, and
  no operation accepts a caller-supplied prompt, schema, model id, endpoint or
  tool implementation.
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
* Automated tests drive the page in a DOM with a fake feature client, the
  backend against a real control plane and runner, and the plugin's load in a
  real OpenClaw with an isolated configuration. The live Control UI was driven
  end to end in a real browser for the 3C acceptance
  ([`ui-acceptance-3c.json`](../examples/verification/ui-acceptance-3c.json));
  that is a recorded acceptance, not a test that runs on every change.
* Progress is polled every two seconds, not streamed.
* A run takes as long as its model: tens of minutes for Literature Review on a
  local 30B model. The authorization must outlast the run deadline, so with a
  2-hour session and a 75-minute deadline a run must start within about 44
  minutes of opening the package.
* A finished run's record and artifacts survive a Gateway restart (the newest
  16 are re-read from their run directories) but its package session does not:
  such a run is shown read-only, with generic labels, because the package's
  presentation hints belonged to the closed session.
* Run records live in the plugin's state directory; there is no run history
  database, search or retention policy beyond the 32 newest.
* A package whose view approaches all of its per-list bounds at once (128
  nodes, 512 edges, 64 tools…) could exceed the host's 4,096-node output limit;
  `packages.get` would then fail closed rather than show a partial package. No
  shipped package is near it (Literature Review's view is 1,114 nodes).

## 11. Verification

`openclaw-agent-browser/scripts/verify.mjs` (`npm run verify`) builds, validates,
packs, installs into a throwaway OpenClaw configuration, inspects what the host
loaded, and runs the test suite. Saved output:
[`agent-browser-plugin.json`](../examples/verification/agent-browser-plugin.json).

391 tests cover the contract, the supervisor against a real `agentpkg
browser-serve` child, the backend against a real control plane with both shipped
packages, host model discovery against a stubbed OpenClaw catalog, run-plan
preparation and staleness end to end, the Run surface (gate, start, progress,
cancel, reload, artifacts, file input) against a real control plane and runner,
the page and the Run panel in a DOM, safe Markdown, the host's output limits
(`test/host-bounds.test.ts`, using the host's own check as the oracle),
structural properties of the source, and the plugin registration contract.

The 3C acceptance drove the real Control UI in a real browser: open, trust,
permissions, approvals, model, plan, task, Run, live progress, Cancel, reload,
result, artifacts, download — plus 47 hostile probes through the same Gateway
method the page uses. Record:
[`ui-acceptance-3c.json`](../examples/verification/ui-acceptance-3c.json),
narrative: [the milestone report](demo-experience-report.md).

A separate record of the same flow driven against the operator's real OpenClaw
2026.9.5 host — including the models it actually reported — is
[`model-selection-run-plan.json`](../examples/verification/model-selection-run-plan.json).

## 12. Future work

The pre-execution notes this section used to hold — re-verify at run time, a
place for run output, a router adapter that reports what it delivers,
cancellation and progress — were delivered by milestones 3B and 3C. What
remains, deliberately not built:

1. **Persistent authorization.** Offering *Always* requires a real host
   authorization store with its own revocation and review surface.
2. **Scholarly-search federation** behind the same abstract `scholarly-search`
   capability (Crossref + arXiv + OpenAlex, optionally Semantic Scholar) —
   host implementations, no package change.
3. **Other execution profiles** (`conversation.v0`, `service.v0`); there is no
   chat.
4. **Discovery and locators** (NANDA, registries), Muse / Instinct, Maritime /
   sandboxed execution, a package update flow, richer evals and attestations,
   and model-provider redundancy.

See also: [the control plane](browser-control-plane.md), [model selection and the
run plan](model-selection-and-run-plan.md) with its [milestone
report](model-selection-report.md), [the control plane's milestone
report](browser-report.md), [the legacy staging
adapter](openclaw-integration.md), and the plugin's own
[README](../openclaw-agent-browser/README.md).
