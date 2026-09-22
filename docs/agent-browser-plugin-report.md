# Agent Browser plugin milestone report

The acceptance criterion is met: **a native OpenClaw Control UI page opens a
signed `agent.pkg`, shows its validation layers, signature and publisher trust
as separate facts, renders its capabilities, skills, tools, workers, workflow,
permissions, budgets and model requirements generically, and turns explicit
permission decisions into an authorization receipt — with no Run action and no
execution of any kind.**

Reference documentation: [the Agent Browser plugin](openclaw-agent-browser.md)
and the plugin's own [README](../openclaw-agent-browser/README.md).

## Architecture

```text
 OpenClaw Control UI  ──┐  typed feature operations (operator.read / operator.write)
   Agent Browser page   │  no token · no port · no filesystem · no crypto
                        ▼
 Agent Browser backend  ──┐  authenticated loopback HTTP, node:http
   Gateway process        │  owns the bearer token and the child process
                          ▼
 agentpkg browser-serve  ── validation · signatures · trust · authorization
```

Four properties define it:

1. the browser half calls only typed feature operations and renders what it is
   told;
2. the backend owns the control-plane process and its bearer token;
3. no validation, signature, trust, permission or URL logic is reimplemented in
   TypeScript;
4. the furthest reachable state is *Authorized — ready to run*.

## Files created

`openclaw-agent-browser/`: `package.json`, `openclaw.plugin.json`,
`tsconfig.json`, `vitest.config.ts`, `.gitignore`, `README.md`,
`src/{contract,index,backend,service,control-plane,project,errors,control-ui}.ts`,
`src/control-ui.css`, `src/ui/{page,dom}.ts`,
`test/{contract,plugin,service,backend,ui,fixtures}.ts`, `scripts/verify.mjs`.

`docs/openclaw-agent-browser.md`, this report, and
`examples/verification/agent-browser-plugin.json`.

## Files changed

| File | Change | Why |
|---|---|---|
| `agentpkg/src/agentpkg/cli.py` | `browser-serve --quiet` | Omits the bearer token from stdout so it cannot reach host logs, suppresses per-request logging, and prints the startup line as compact single-line JSON for readiness detection. Requires `--token-file` or `--token`. |
| `agentpkg/src/agentpkg/browser/control.py` | `trust_session_publisher`, `_publisher_report`, `_compose_summary`, `_refresh_trust` | Lets a UI pin the key that signed an open session without ever handling key material, and re-evaluates open sessions after any trust change. |
| `agentpkg/src/agentpkg/browser/server.py` | `POST /v0/packages/{id}/trust-publisher` | The route for the above, with the same strict body validation as every other route. |
| `agentpkg/tests/test_browser_trust.py`, `test_browser_service.py` | 9 new tests | Session pinning, scope narrowness, fingerprint echo, unsigned refusal, session refresh, receipt immutability, the HTTP route, and the `--quiet` contract. |
| `docs/browser-control-plane.md`, `docs/threat-model.md`, `docs/openclaw-integration.md`, `README.md` | Documentation | The new endpoint and flag, the plugin's boundary, and the staging-adapter relationship. |

No existing control-plane behavior changed. The Python suite went from 342 to
351 passing tests.

## OpenClaw SDK surfaces used

| Surface | Use |
|---|---|
| `plugin-sdk/feature-contract` · `defineFeatureContract` | One contract shared by both halves |
| `plugin-sdk/feature-contract` · `createFeatureClient` | The page's only channel to the backend |
| `plugin-sdk/feature-plugin` · `defineFeaturePlugin` | Session actions with scopes; validates input and output against the contract on both sides |
| `plugin-sdk/plugin-entry` · `buildJsonPluginConfigSchema` | Operator configuration |
| `plugin-sdk/tool-plugin` · `toolPluginMetadataSymbol` | Reattaches manifest metadata carrying that schema |
| `plugin-sdk/control-ui` · `defineControlUiPlugin`, `host.ui.registerPage`, `host.ui.registerNavigation`, `host.connection.canWrite`, `context.signal` | The page and sidebar destination |
| `api.registerService({ id, start, stop })`, `ctx.stateDir`, `ctx.workspaceDir`, `ctx.serviceHealth` | The control-plane child's lifecycle and health |

Version-specific detail worth recording: `defineFeaturePlugin` in 2026.9.5 has
no config-schema option and publishes manifest metadata through
`toolPluginMetadataSymbol` as a **non-configurable** property, which
`openclaw plugins build` reads and writes back into `openclaw.plugin.json`. A
plugin that edits only the manifest loses its config schema on the next build,
and a plain object spread drops the symbol entirely. The entry is therefore
rebuilt from its own property descriptors with the schema attached.

## agentpkgd process lifecycle

```text
 service start → resolve agentpkg (config → AGENTPKG_BIN → PATH)
               → <stateDir>/agent-browser at 0700, resolved to a physical path
               → reap an orphan from a crashed Gateway (argv identity checked)
               → wipe the per-run directory; fresh snapshot cache
               → spawn browser-serve --port 0 --quiet --token-file … --trust-store …
               → parse the single-line startup JSON → loopback URL
               → read the 0600 token file, then delete it
               → write {pid, marker}; health check → running
 service stop  → SIGTERM → SIGKILL after a grace period → remove pid file and run dir
```

Starts are single-flight, so concurrent operations never spawn two children. A
failed start is recorded as a state and never retried automatically; the page
shows the reason and a **Retry** action. Startup does not block Gateway startup:
the service registers, then launches in the background and reports through
`ctx.serviceHealth`. Publisher pins live outside the per-run directory and
survive restarts; snapshot caches do not.

Resolving the runtime directory to its physical path matters on macOS, where
`/var/folders/...` is a symlink and `agentpkg` refuses to create files under a
symlinked parent.

## How bearer-token secrecy is preserved

1. `--quiet` keeps the token out of the child's stdout entirely.
2. The token file is `0600` and is deleted immediately after one read.
3. The token then exists only in the backend process's memory.
4. No feature operation can return it: the contract has no such field, outputs
   are schema-validated, and a test captures the real token through a transport
   spy and asserts it appears in no operation output.
5. The page never learns the loopback port either, so it could not use a token
   if it had one — and the control plane refuses browser-shaped requests anyway.

## Feature operations

Queries (`operator.read`): `service.status`, `packages.list`, `packages.get`,
`packages.permissions`, `packages.authorization`, `trust.list`.

Actions (`operator.write`): `packages.open-url`, `packages.open-local`,
`packages.close`, `packages.authorize`, `trust.pin-session-publisher`,
`trust.remove`, `service.restart`.

Event: `browser-changed`. No agent-callable tool is declared; `contracts.tools`
is empty in the built manifest.

Fallible operations return `{ ok, value } | { ok, error }` with a closed set of
stable codes, because the feature transport reduces a thrown error to a bare
string that a UI cannot branch on.

## UI sections

Service state chip with Retry · address bar (HTTPS, plus an operator-gated local
path) · open-package tabs · package header · **Verification and trust** ·
warnings by code and severity · contents tabs (Overview, Tools, Workers,
Workflow, Evals & attestations, Technical details) · permissions ·
declared limits · model requirements · authorization with an expandable receipt.

## Trust UX

Container, Integrity, Schema and Runtime each get their own row and status.
Signature and publisher trust are separate blocks: a valid signature reads
*Cryptographically valid*, while the publisher reads *Unknown publisher* until a
key is pinned, with the explanation "Nobody on this host has pinned this signing
key". `mismatch` gets a red, thicker treatment and names the impersonation risk.

Pinning appears only for a valid signature from an unknown key. It shows the
claimed identity, the full fingerprint, the package ID and the scope that would
be trusted; defaults to the narrowest scope (this package ID only); and needs
two deliberate presses. The key travels from the session's own verified envelope
inside the control plane — the browser never handles key material — and the
control plane refuses a fingerprint other than the one displayed. The page also
states that a pin persists as an operator decision while permissions end with
the session.

## Authorization UX

Every permission starts at **Deny**, regardless of publisher trust, with
required and optional grouped separately and each showing kind, description,
resource scope, linked tools and linked domains. Only `Deny`, `Allow once` and
`Allow for session` are offered; *Always* is absent and the page explains why.
Authorize sends the session, the displayed digest and the explicit decisions.
Success shows `✓ Authorized for this session` with *The package has NOT
executed*; failure lists blocking reasons by stable code and subject. The
receipt is available under *Authorization receipt (technical details)*.

## Tests and results

| Suite | Result |
|---|---|
| Plugin suite (`npm test`) | **61 passed** in 5 files |
| Python `agentpkg` suite | **351 passed, 1 skipped** (was 342/1 before this milestone) |
| Citation Resolver suite | **132 passed** (untouched) |
| `ruff check` / `format --check` on `agentpkg` and `scripts` | passed |
| `scripts/verify_workflow.py` | passed |
| `scripts/verify_browser.py` | passed |
| `npm run verify` (build → validate → pack → isolated install → inspect → tests) | passed |
| `openclaw plugins validate --json` | `{"valid": true, "pluginId": "agent-browser"}` |
| Isolated real-OpenClaw load | `status: "loaded"`, `activated: true`, `toolNames: []`, `httpRoutes: 0`, config properties as declared |

Plugin test files:

| File | Tests | Covers |
|---|---:|---|
| `test/contract.test.ts` | 8 | Host-valid ids; query/action split; no agent tool; no run operation; bounded schemas; only supported decisions; projected views validate; a view claiming execution is rejected |
| `test/service.test.ts` | 10 | Executable resolution; unconfigured state; one child under concurrent starts; token consumed and deleted; unauthenticated and browser-shaped requests refused; stop reaps; restart leaves no orphan; orphan reaped by argv identity; a live foreign pid is never signalled; trust store survives restart; failed start recorded without a traceback |
| `test/backend.test.ts` | 16 | Both shipped packages through one path; no token in any output (transport spy); deny-by-default; `always` refused; authorize → pin → runnable; denied required permission → not runnable with subject; fingerprint-echo refusal; digest mismatch; closed session typed; session listing; URL policy delegated; malformed package with layered validation; local-root and symlink-escape policy; unconfigured service; control-plane error mapping |
| `test/ui.test.ts` | 22 | Initial view; unavailable service with Retry; local entry hidden without roots; one honest progress state; layers separate from signature and trust; mismatch treatment; two-step pinning; rejected package; non-retryable error; tools/workers/workflow/evidence/technical tabs; declared-limits labelling; model panel; warnings by code; hostile strings escaped; deny defaults and offered decisions; decisions sent with the displayed digest; authorized receipt; blocked authorization; expired session; read-only operator; **no run action**; abort disposes the view |
| `test/plugin.test.ts` | 5 | Manifest metadata and config schema; every operation registered with the right scope and no tool; exactly one control-plane service; operations answer only while the service runs; input validated before the handler |

Two real defects were found by these tests and fixed:

* Node's global `fetch` sends `sec-fetch-mode: cors`, so the control plane's
  DNS-rebinding defense refused the backend. Rather than weaken a tested
  defense, the backend now uses `node:http` with an explicit minimal header set.
* Node's keep-alive agent reused a socket the control plane had already closed
  (`Connection: close`), producing an `ECONNRESET` on every second request. The
  backend now uses an unpooled connection per request.

A third was found by the service tests: `agentpkg` refuses to create files under
a symlinked parent, which is the normal shape of a macOS state directory, so the
supervisor resolves its runtime root to a physical path.

## Commands

```sh
# build, test and install
cd openclaw-agent-browser
npm install
npm test
npm run build
npm run validate
npm run pack
openclaw plugins install ./agent-browser.tgz --accept-capabilities

# reproducible evidence, in a throwaway OpenClaw configuration
npm run verify

# iterate on backend source
npm run build && npm run pack && openclaw plugins install ./agent-browser.tgz --force \
  && openclaw plugins reload agent-browser
# iterate on browser source: same, then Plugins -> Customize UI -> Reload plugin UI
```

Configuration for the demo:

```json5
{
  plugins: {
    entries: {
      "agent-browser": {
        enabled: true,
        config: {
          agentpkgPath: "<repo>/agentpkg/.venv/bin/agentpkg",
          localPackages: { roots: ["<repo>/dist"] },
        },
      },
    },
  },
  gateway: { controlUi: { experimental: { customPlugins: true } } },
}
```

## Manual demo

1. Start OpenClaw and open the Control UI.
2. Select **Agent Browser** in the sidebar.
3. Expand *Open a local package* and enter `<repo>/dist/literature-review.agent.pkg`
   (or paste an HTTPS URL when one is hosted).
4. Observe: `Literature Review Agent`, `workflow.v0`, Container / Integrity /
   Schema / Runtime valid, Signature *Cryptographically valid*, Publisher
   *Unknown publisher*.
5. Inspect the Tools, Workers, Workflow and Evals tabs, the declared limits, and
   the model requirements panel.
6. All permissions show **Deny**.
7. Set the required permissions to **Allow for session**.
8. Press **Authorize** → not runnable, `publisher_not_trusted`.
9. Expand *Review publisher key*, keep the narrow scope, press *Trust this
   publisher key* twice → publisher becomes **Trusted by this OpenClaw host**.
10. Press **Authorize** again → **✓ Authorized for this session**, *Runnable:
    yes*, and *The package has NOT executed.*
11. Set one required permission back to **Deny**, authorize again → not
    runnable, naming that permission.
12. Repeat with `dist/meeting-agenda.agent.pkg`: different capabilities, skills,
    workers, workflow and permissions, identical code path.

The backend and control-plane halves of this sequence are covered by automated
tests; steps 1–2 and the rendering itself require a browser and the Labs
setting, so they are performed by hand.

## Known limitations

* Native plugin UI is an experimental OpenClaw lab, off by default; these plugin
  APIs may change between host versions. This milestone is pinned to 2026.9.5.
* Install the packed artifact. A directory install also scans this project's
  `node_modules`, which contains OpenClaw's bundled plugins, and the registry
  reports conflicting child rows.
* Local package opening needs operator-configured roots because OpenClaw
  2026.9.5 exposes no native file picker to Control UI plugins.
* One control-plane child per plugin instance per state directory. Orphan
  reaping uses `ps` and is POSIX-only; Windows is untested.
* The page refreshes on load, on actions and on the plugin's `browser-changed`
  event. It is not a live stream, and open-package tabs show package IDs rather
  than display names.
* The live Control UI rendering is verified by hand; automated UI tests drive
  the page in a DOM with a fake feature client.
* Receipts remain session-scoped, so *Always* is still not offered.

## Before the next milestone (model selection and RUN)

1. **A receipt is consent, not a capability.** The runner must re-open the
   snapshot, re-check the digest and archive hash, re-evaluate trust and map
   decisions onto runtime grants before executing anything.
2. **Run output needs a new surface.** Audit stream, usage, budgets consumed and
   exports have no place in this page; that is a new view, not a variation.
3. **Model selection needs its own trust story.** OpenClaw's catalog and router
   are the natural source, but the earlier finding still holds: the documented
   `maxTokens` is advisory and usage can be absent, so a hard budget cannot be
   inferred from that interface alone.
4. **Persistent authorization** requires a real host authorization store with
   revocation and review before *Always* can be offered honestly.
5. **Long operations** need cancellation and progress. The single honest
   "Opening and verifying package…" state is right for an open, and would not be
   enough for a run.
