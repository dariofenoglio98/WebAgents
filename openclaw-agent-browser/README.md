# Agent Browser — an OpenClaw feature plugin

The first visible piece of "OpenClaw as an agent-native browser": a native
Control UI page where an operator opens a signed `agent.pkg`, sees exactly what
it is and what it asks for, records an authorization decision, chooses one of the
models this OpenClaw host actually has, and prepares an immutable run plan.

**The page runs nothing.** It stops at a prepared run plan; there is no Run
action anywhere in it, and a test asserts the browser half calls no `execution.*`
or `router.probe` operation.

Two operator-only surfaces the page does not render sit behind it. `router.probe`
re-verifies a ready plan and makes a single host-owned model call to prove the
`ModelRouter` contract ([the model-router
bridge](../docs/model-router-bridge.md)). `execution.start` re-verifies the same
plan and **runs the package's own `workflow.v0` graph** on the model the plan
bound, through the generic interpreter, with no tool handler installed ([package
execution](../docs/package-execution.md)). Both require the operator opt-in
`plugins.entries.agent-browser.llm.allowModelOverride: true`, because binding an
exact model is a privilege OpenClaw grants rather than one a plugin asserts.

```text
 OpenClaw Control UI  (Agent Browser page)
        │  typed feature operations over the operator's Gateway connection
        ▼
 Agent Browser plugin backend   (Gateway process — owns the bearer token)
        │  authenticated loopback HTTP
        ▼
 agentpkg browser-serve         (agentpkgd — the authority for everything below)
        │
        ▼  validation · signatures · publisher trust · permissions · receipts
        ▼  model compatibility · run plans
```

The backend is the **only** half that knows what OpenClaw is: it reads the host's
published model catalog and projects it into a provider-neutral descriptor. The
browser half never receives the control-plane token, never talks to the loopback
port, and never recomputes validation, trust, authorization, compatibility or URL
policy. Those live in `agentpkg`, which this plugin only calls.

Tested against **OpenClaw 2026.9.5 (`ec9c1a1`)**. Its plugin APIs are
experimental; pin and retest on a different host version.

## Requirements

- OpenClaw 2026.9.5 with the Gateway running.
- An `agentpkg` executable providing `agentpkg browser-serve` (this repository's
  `agentpkg/.venv/bin/agentpkg`, or an installed wheel).
- Node 20+ and npm for building the plugin.

## Build, verify and install

```sh
cd openclaw-agent-browser
npm install                 # links the pinned openclaw peer for types and tooling
npm run typecheck
npm test                    # 103 tests; the integration ones drive a real agentpkgd
npm run build               # tsc + `openclaw plugins build` (manifest + UI bundle)
npm run validate            # openclaw plugins validate --json
npm run pack                # openclaw plugins pack --json  -> agent-browser.tgz
openclaw plugins install ./agent-browser.tgz --accept-capabilities
```

Install the **packed artifact**, not the source directory: a directory install
also scans this project's `node_modules`, which contains OpenClaw's own bundled
plugins, and the registry reports conflicting child rows.

`npm run verify` runs the whole chain and installs into a throwaway
configuration, so it never touches your real OpenClaw state.

## Configure

The plugin needs to know where `agentpkg` is, and which directories may be
opened as local packages. Add to your OpenClaw config:

```json5
{
  plugins: {
    entries: {
      "agent-browser": {
        enabled: true,
        config: {
          agentpkgPath: "/absolute/path/to/agentpkg",
          localPackages: { roots: ["/absolute/path/to/WebAgents/dist"] },
        },
      },
    },
  },
}
```

| Key | Meaning |
|---|---|
| `agentpkgPath` | Absolute path to the `agentpkg` executable. Falls back to `AGENTPKG_BIN`, then `PATH`. |
| `localPackages.roots` | Absolute directories the page may open `.agent.pkg` files from. Empty means local opening is off. |
| `localPackages.includeWorkspace` | Also allow the OpenClaw workspace directory. Default `true`. |
| `sessionTtlSeconds` | Package session lifetime in the control plane. Default 900. |
| `maxSessions` | Concurrently open package sessions. Default 8. |

There is no token, key or secret in plugin configuration.

## Enable the native page

Native plugin UI is an experimental OpenClaw lab and is **off by default**:

**Settings → Labs → Custom plugin UI**, or

```json5
{ gateway: { controlUi: { experimental: { customPlugins: true } } } }
```

Restart the Gateway and reload the browser tab, then choose **Agent Browser**
in the Control UI sidebar.

## Manual demo

1. Open the Control UI and select **Agent Browser**.
2. The header shows `Control plane running` once the backend has started
   `agentpkg browser-serve` for you. If it says unavailable, the detail line
   explains why and **Retry** restarts it.
3. Open a package — paste an HTTPS URL, or expand *Open a local package* and
   enter `<repo>/dist/literature-review.agent.pkg`.
4. Read the result:
   - **Container / Integrity / Schema / Runtime** each report their own status;
   - **Signature** says *Cryptographically valid*;
   - **Publisher** says *Unknown publisher* until a key is pinned — a valid
     signature is deliberately not shown as trust.
5. Browse the tabs: Overview, Tools, Workers, Workflow, Evals & attestations,
   Technical details. Nothing here is Literature-Review-specific.
6. Every permission starts at **Deny**. Set the required ones to
   *Allow for session*.
7. Press **Authorize**.
   - Untrusted publisher → `Cannot run with these decisions` and
     `publisher_not_trusted`.
   - Expand *Review publisher key*, choose the narrow scope, then press
     *Trust this publisher key* twice (the second press confirms). The page
     re-reads the session and the publisher becomes *Trusted by this OpenClaw
     host*.
   - Press **Authorize** again → **✓ Authorized for this session**, with
     *The package has NOT executed.*
8. Set one required permission back to **Deny** and authorize again → not
   runnable, naming the exact permission.
9. Scroll to **Model**. It lists what this host reports, each with
   *Compatible* / *Unverified* / *Incompatible*, its context window, and a
   *Compatibility details* disclosure giving every requirement, the host's own
   answer and where that answer came from.
   - With `model.reasoning` denied, the models still render but **Prepare run**
     stays disabled and the page names the permission to change.
   - Set `model.reasoning` to *Allow for session*, authorize again, choose one
     model, and press **Prepare run**.
10. **Ready to run** appears with the package, publisher, authorization, model,
    execution profile, run-plan id and run-plan hash — and *Execution is not
    enabled in this build.* There is still no Run button.
11. Repeat with `dist/meeting-agenda.agent.pkg`. No plugin code changes.

### The developer router probe

Not part of the page. It spends a few hundred real tokens on the selected model,
once, and proves the `ModelRouter` contract end to end:

```sh
openclaw config patch --stdin <<'JSON'
{ "plugins": { "entries": { "agent-browser": { "llm": { "allowModelOverride": true } } } } }
JSON

node scripts/router-probe.mjs \
  --package ../dist/meeting-agenda.agent.pkg \
  --model openai/gpt-5.6-luna \
  --out /tmp/router-probe.json
```

It walks the same sequence as the page through the live Gateway and then invokes
`router.probe`. The result names the model that actually answered, whether
structured output was constrained by the host, the token bound and the real
bill — and `workflowExecuted: false`.

### Executing a package

Also not part of the page, and the first thing here that runs one. It spends
real tokens on the selected model.

```sh
node scripts/run-meeting-agenda.mjs \
  --package ../dist/meeting-agenda.agent.pkg \
  --input   ../examples/meeting-agenda-acceptance-input.json \
  --model openai/gpt-5.6-luna \
  --out /tmp/meeting-agenda-run.json
```

It walks the page's sequence, starts the execution, waits, and reads the
package's declared `agenda.json` export back through the bounded artifact
operation. It exits non-zero unless the run completed, every model call used the
selected model, bounded parallel workers actually ran, no tool was called, the
audit chain verifies, the agenda preserves the goal and duration with minutes
summing exactly to the requested duration, and the run plan is byte-identical
afterwards with `performed` still false.

Host bounds are operator configuration and can only lower what a package already
declares:

```json
{ "plugins": { "entries": { "agent-browser": { "config": { "execution": {
  "totalTokens": 120000, "maxRemoteCalls": 32, "maxParallelWorkers": 3,
  "maxOutputTokensPerCall": 16000, "runTimeoutSeconds": 600
} } } } } }
```

## Iterating

| Change | Command |
|---|---|
| Backend source | `npm run build && npm run pack && openclaw plugins install ./agent-browser.tgz --force && openclaw plugins reload agent-browser` |
| Browser source | same, then **Plugins → Customize UI → Reload plugin UI** as an administrator |
| Contract | rebuild both halves: they share `src/contract.ts` |

## Layout

| Path | Role |
|---|---|
| `src/contract.ts` | Typed feature contract shared by both halves; bounded TypeBox schemas |
| `src/index.ts` | Plugin entry: `defineFeaturePlugin` + `api.registerService` |
| `src/backend.ts` | Feature handlers, local-path policy, result envelopes |
| `src/service.ts` | `agentpkg browser-serve` supervisor: spawn, token, health, stop, reap |
| `src/control-plane.ts` | Backend-only loopback HTTP client (holds the token) |
| `src/project.ts` | Control-plane JSON → bounded browser DTOs |
| `src/host-models.ts` | Host model discovery and its safe projection |
| `src/host-llm.ts` | The only module that invokes a model: exact binding, constrained output, usage |
| `src/bridge-core.ts` | The shared JSONL child-bridge transport: framing, correlation, cancellation, lifetime |
| `src/router-bridge.ts` | The probe child's protocol version, methods and one call sequence |
| `src/execution-bridge.ts` | The runner child: its protocol version, methods and inherited descriptors |
| `src/preflight.ts` | One run-plan revalidation, shared by the probe and by execution |
| `src/router-probe.ts` | The probe report projection |
| `src/execution.ts` | Preflight, lease, descriptors, bridge, run record, artifacts |
| `src/run-manager.ts` | Ephemeral run records and lifecycle rules |
| `src/control-ui.ts` | `defineControlUiPlugin`: the page and sidebar entry |
| `src/ui/page.ts` | The page itself, mountable with a fake client in tests |

Full architecture, trust semantics and limitations:
[`docs/openclaw-agent-browser.md`](../docs/openclaw-agent-browser.md). Model
discovery, compatibility semantics and the run-plan schema:
[`docs/model-selection-and-run-plan.md`](../docs/model-selection-and-run-plan.md).
