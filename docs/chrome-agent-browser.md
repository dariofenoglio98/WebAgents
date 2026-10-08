# The Chrome Agent Browser

The Chrome Agent Browser is WebAgents' second runtime: a Manifest V3 extension that discovers
signed `agent.pkg` packages on websites, verifies them, obtains the person's authorization and
runs them with the person's own models, tools, data and budgets. It is built on a portable
TypeScript core that also runs in Node, where a command-line interface gives it `agentpkg`'s
shape. The code is in [`chrome-agent-browser/`](../chrome-agent-browser/); its
[README](../chrome-agent-browser/README.md) is the user guide (what each screen shows, how to load
the extension, the Node CLI, the test harnesses). This document describes how it is built and
what it guarantees.

The Python runtime ([`agentpkg`](../agentpkg/)) is the reference. The OpenClaw plugin
([`openclaw-agent-browser/`](../openclaw-agent-browser/)) stays the reference *browser* and
receives fixes only; new features go to the Chrome line. The Chrome core ports the reference
module by module, and the [conformance suite](../conformance/README.md) runs both runtimes on the
same packages and reports where they agree and where they differ.

## 1. Architecture

```text
 website ── <link rel="agent-package"> ──▶ content script ─ content.links ─▶ service worker
                                                                             (the only state owner:
 side panel ─┐                                                                sessions, trust store,
 full page  ─┼── typed messages (messages.ts) ───────────────────────────────▶ receipts, Run Plans,
 settings   ─┘◀── event.* broadcasts ─────────────────────────────────────────  settings, vault, runs)
                                                                                    │ host.start
                                                                                    ▼
                                                     offscreen document (execution.html, one)
                                                                                    │ one Worker per run
                                                                                    ▼
                                                     execution-worker.js: the core's ExecutionSession
                                                     ── fetch ──▶ model providers, tool endpoints
                                                     ── IndexedDB ──▶ checkpoints, artifacts
```

- **The core** (`src/core/`) is everything that decides: the strict ZIP reader, canonical JSON,
  SHA-256 and Ed25519, schema and semantic validation over `agentpkg`'s own JSON Schemas, publisher
  trust, discovery, profiles, authorization receipts, host tool and resource registries, model
  compatibility, Run Plans and their preflight, the personal vault, the `workflow.v0` interpreter,
  the model router and provider adapters, the tool broker and its adapters, and the execution
  layer (lease, runner, Run Record). It has no Chrome, DOM or Node dependency (§3).
- **The service worker** owns all state and makes every decision a view asks for. Views (the side
  panel, the full-page browser, settings) render what it returns and hold sessions by view id; a
  closed view releases nothing another view still holds (D-056).
- **The execution host** is an offscreen document, chosen by measurement (D-027, D-070): it kept
  full-rate timers for 30 minutes and outlived a stopped service worker, where a hidden tab froze.
  The service worker decides that a run starts (readiness, lease, `once` spent) and asks the host
  to run it; the host starts one ES-module Worker per run, which runs the core's
  `ExecutionSession` unchanged and checkpoints after every wave (D-071). Closing the panel or the
  page never touches a run; a browser restart marks a run in flight `interrupted`, and nothing
  resumes.
- **The content script** reports `link[rel="agent-package"]` elements of the visited tab and
  nothing else. Pages cannot message the extension.

## 2. The two shells

| | Manifest V3 extension | Node CLI (`dist/cli.js`) |
|---|---|---|
| For | people: discover, inspect, authorize, run, review runs | operators and tests: the same core from a terminal |
| Entry points | service worker, content script, side panel, full page, offscreen document, run Worker, PDF Worker | `verify`, `inspect`, `evaluate`, `run`, `pdf-text`, `document sign\|verify` |
| Authorization | profiles, presets, the per-item view, the vault, the model catalog, receipts and Run Plans | the grants file is the receipt, each `--approve-tool` one approval, every other tool denied (D-064) |
| Network | Chrome's `fetch`, after the core's URL gate (D-026, D-039) | `src/cli-net.ts`: resolves, classifies every address as the Python runtime does, pins the connection (D-067) |
| Output | IndexedDB records, the run surface, a zip export per run (D-073) | `agentpkg run`'s file set and report; refusals as one stderr line with status 2 (D-038) |

Both shells execute through the same `ExecutionSession`, so a run in the extension and a run from
the CLI are held to the same checks. The CLI keeps `agentpkg`'s flag names so that the conformance
suite can drive both runtimes the same way.

## 3. The core boundary

Nothing under `src/core` may use Chrome, the DOM or Node (D-024, D-031). `tsconfig.core.json`
compiles the core with no DOM, Node or Chrome type library and only the WHATWG globals
`src/core/globals.d.ts` allows (TextEncoder, URL, `crypto.subtle`, timers), so a `chrome` or
`document` reference is a compile error, and `test/core/boundary.test.ts` scans the source for
forbidden globals and imports. The network reaches the core only through an injected
`HttpTransport`; storage, clocks and the built-in model through injected ports.

The core's third-party code is three libraries: `@hyperjump/json-schema` (a schema interpreter,
because Manifest V3 forbids `eval`), `@hyperjump/browser` (its registry, with the remote `http`,
`https` and `file` retrieval schemes removed, so a package schema can reach nothing) and
`@noble/ed25519` (used when WebCrypto lacks Ed25519). The paper reader adds pdf.js in its own
Worker. Every JSON Schema is a byte-for-byte copy of `agentpkg/src/agentpkg/schemas/` (D-025), and
`SUPPORTED_RUNTIME_VERSION` is held equal to `agentpkg.__version__` by a test, so the two
runtimes accept the same packages and gate on the same minimum version.

## 4. What it keeps, and where

| Where | What | Notes |
|---|---|---|
| `chrome.storage.local` | `trustStore` (the `agentpkg-trust-store-v0` format), `settings` (presets, model connections and limits, run limits, services), `providerKeys`, `vault` and `vaultKey`, `instanceId`, `spentReceipts` (receipts whose `once` a run used), `indexes` (agent indexes with their pinned keys and the signed text last fetched), `policySubscription` (the one followed policy, its pinned key and signed text), `library` (pinned and recently opened agents) | never `storage.sync`; keys are typed once and never shown again; signed documents are re-verified when read |
| `chrome.storage.session` | per-tab candidates, which views hold which session | cleared when the browser closes |
| IndexedDB `agent-browser` | `snapshots` (package bytes, by archive SHA-256), `sessions` (with their receipt and Run Plan), `runs` (Run Record, progress, audit, usage, checkpoints), `artifacts` (bytes and SHA-256), `files` (picked PDFs, copied), `observations` (outbound request bodies, test mode only) | `unlimitedStorage`; caps refuse, never evict silently |

What is never stored in a record, plan, receipt, checkpoint or artifact: a provider key, a vault
value, a prompt sent to a model outside test mode. A plan binds a vault record by opaque id and an
HMAC digest under the per-profile `vaultKey` (D-051), so the plan changes when the record does and
carries no value. Provider keys and the vault travel to the execution host in the `host.start`
message, in memory, for one run. §7 of the [threat model](threat-model.md#chrome-agent-browser-t7)
says what this does and does not protect at rest.

## 5. Permissions it asks Chrome for

From [`manifest.json`](../chrome-agent-browser/src/extension/manifest.json) (D-026):

| Permission | Why |
|---|---|
| `storage`, `unlimitedStorage` | the stores above; package snapshots and artifacts can exceed the default quota |
| `sidePanel` | the side panel the action opens |
| `offscreen` | the execution host (reason `WORKERS`) |
| host `https://*/*` | download packages and website pages, call tool endpoints and hosted model APIs, and run the content script on HTTPS pages |
| host `http://127.0.0.1/*`, `http://localhost/*` | Ollama on this machine only; a remote Ollama endpoint is refused (D-055) |

The content security policy allows scripts from the extension only and connections to HTTPS and
the two loopback names. Every package string reaches the page through `textContent`; the shell
has no `innerHTML`. Per-origin optional permissions are later hardening (BACKLOG B-96).

## 6. Limits

| Limit | Value | Source |
|---|---|---|
| Package sessions | 7,200 s each, at most 8, at most 128 MiB of snapshots | D-032 |
| Package and page downloads | HTTPS on port 443, a DNS name, no redirect followed, 60 s | D-026, D-033, D-039 |
| Run limits (Settings → Policies → Run limits) | the reference plugin's defaults; "Use the long-run limits" sets the values the reference host used for Literature Review | D-084, `src/core/execution/limits.ts` |
| A package's own budget and deadline | always apply beneath the host's limits; the host never raises them | D-064 |
| Model calls | one bound model per plan, no fallback; a per-call deadline; output capped at the node's `max_output_tokens` | D-023, D-061, D-062 |
| Tool calls | one request, no redirect, no retry, bounded request and response bytes, the binding's own pacing | D-054, D-066, D-081 |
| Selected PDFs | the reference parser's limits (size, pages, text per page, text in all) | D-082 |
| One active run | per session and per plan; a receipt must outlast the run deadline by 60 s | D-071 |

## 7. How it is verified

- **Unit and integration tests** (`npm test` in `chrome-agent-browser/`, vitest, no skipped test):
  the core against the Python suite's cases and against records the Python control plane produced
  (`test/fixtures/authorization/`), the shell over a fake `chrome`, the views in happy-dom.
- **Cross-runtime conformance** ([`conformance/`](../conformance/README.md)): both CLIs on the
  shipped packages in fixture mode and on a negative suite, and both control planes on stale-plan,
  replayed-`once` and profile scenarios; reports under `conformance/results/`.
- **Headless Chrome harnesses** (`scripts/e2e-*.mjs`): discovery and inspection against a local
  HTTPS origin, the paper reader, and live runs of WebAir and Literature Review whose exported run
  directories are recomputed by `scripts/verify_chrome_*_live.py`. The recorded evidence is under
  [`examples/verification/`](../examples/verification/) (`chrome-*.json`).
- **CI** runs the tests on Ubuntu and macOS with Node 24 and 26, builds and packs the extension,
  checks the zip's structure and that a second build packs to the same bytes, and runs the
  conformance suite ([`.github/workflows/ci.yml`](../.github/workflows/ci.yml)).

## 8. Packaging

`npm run build && npm run pack` writes `dist/chrome-agent-browser-<version>.zip` (the extension,
manifest at the root, ready to load unpacked or to upload to the Chrome Web Store) and
`dist/chrome-agent-browser-<version>.contents.txt`, one `sha256 bytes path` line per member and
the zip's own hash. The build writes `LICENSE.txt` and `THIRD_PARTY_NOTICES.txt` into the
extension from the license files of exactly the packages esbuild bundled. `npm run check-pack`
verifies the file set, the manifest version, the listing and the notices. The bundles are not
minified, so the shipped code stays reviewable. The same sources and Node release give the same
zip bytes; across Node releases the members are identical but the deflate stream can differ
(each Node ships its own zlib), so the content listing, not the zip hash, identifies a build
across Node versions (D-093).

## 9. Finding agents and following a policy (T8)

**Resolvers** (`src/core/resolve/`) answer what a person types into the full page's address bar
when it is not an address: free text, or an agent name in the form `name@host`. Each answer is a
*candidate*: what a source says a package is and where it is, never authority (paper §VI-a).
`StaticIndexResolver` searches a signed agent index ([format](../spec/extensions/agent-index-v0.md))
the person added with its publisher's key; `NandaResolver` is a stub that defines the mapping from a
NANDA AgentAddr and AgentFacts to a candidate and returns nothing until a registry is configured and
its signatures can be verified. Results are ranked by the trust status of the signer each source
claims, then by the source's own order, and by nothing else. **Open and verify** is `package.open`
of the candidate's URL; the worker compares the index's claims (package id, version, digest,
archive SHA-256, signer) with the opened bytes and shows the comparison on the agent page.

**Signed documents** ([format](../spec/extensions/signed-document-v0.md)): an index and a policy
travel in one envelope signed with Ed25519 over a domain string, the content type and the canonical
content; the envelope names its key by fingerprint and the verifier uses only the key the person
pinned. Both are fetched under the package rules (HTTPS on 443 to a DNS name, no redirect, no
credentials, 1 MiB), never in the background, and a refresh never rolls a version back or reuses one
for other content.

**Policy subscriptions** ([format](../spec/extensions/policy-bundle-v0.md)) are the third way to
decide at human scale, after publisher profiles and host presets (F-02). One policy at a time; while
it is current, `PolicyTrust` consults its publisher-key anchors after the person's own trust store,
`applyPolicy` decides each permission kind it names inside the selected profile and under the
preset's duration for that kind, tool approvals follow the granted permissions and the policy's
binding allowlist, every item it decided records `policy`, and the receipt names the policy (D-102).
The person can override any decision; the worker re-checks every `policy` claim against the policy
in force. Budget caps lower the run limits; `local_only` and a cost cap refuse models the browser
cannot keep within them. Unsubscribing, a new version, or expiry makes plans authorized under the
old policy stale (`policy_withdrawn`, `policy_changed`). The **Library** keeps pinned and recently
opened agents; opening one downloads and verifies it again.

The demo index and the example "WebAgents research policy" are signed with development keys
(`examples/keys/webagents-index.pub.pem`, `webagents-policy.pub.pem`) and served beside the WebAir
origin (and by `package-origin/`). The acceptance harness `scripts/e2e-search-policy.mjs` runs the
whole path in a real Chrome against a local HTTPS mock of that origin; its evidence is
[`examples/verification/chrome-search-policy-e2e.json`](../examples/verification/chrome-search-policy-e2e.json).

## 10. What it does not do yet

See the README's [What it does not do yet](../chrome-agent-browser/README.md#what-it-does-not-do-yet):
the built-in model has not run live, local tools other than the PDF reader and GET services other
than Crossref stay unbound, pacing is per run rather than per browser, the extension cannot
classify the addresses DNS names resolve to, NANDA resolution is a stub, a policy's issuer anchors
are not applied and one policy is followed at a time, and per-origin permissions, Firefox and the
Meeting Agenda path are later work.
