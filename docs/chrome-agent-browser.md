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
 settings   ─┘◀── event.* broadcasts ─────────────────────────────────────────  settings, memory, runs)
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
  compatibility, Run Plans and their preflight, the memory (`memory.v0`: records, types, graph,
  recall, proposals, the export folder), the `workflow.v0` interpreter,
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
- **A conversation** (T24, `conversation.v0`) is a record the service worker keeps between turns;
  each turn is one run on the execution host, and a consent card waits in that run's record (§13).

## 2. The two shells

| | Manifest V3 extension | Node CLI (`dist/cli.js`) |
|---|---|---|
| For | people: discover, inspect, authorize, run, review runs | operators and tests: the same core from a terminal |
| Entry points | service worker, content script, side panel, full page, offscreen document, run Worker, PDF Worker | `verify`, `inspect`, `evaluate`, `run`, `pdf-text`, `document sign\|verify` |
| Authorization | profiles, presets, the per-item view, the recall card over the memory, the model catalog, receipts and Run Plans | the grants file is the receipt, each `--approve-tool` one approval, every other tool denied (D-064) |
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
| `chrome.storage.local` | `trustStore` (the `agentpkg-trust-store-v0` format), `settings` (presets, model connections and limits, run limits, services, the idle lock), `secretStore` (the encrypted envelope, T16: `provider_key:<provider>`; T19: `memory_key`, the HMAC digest key, and `memory_data_key`, the key the sealed values are sealed under; `vault` and `vault_key` only until the migration report is dismissed), `memoryMigration` (the vault migration report until Done, D-221), `memoryUiState` (the graph's node positions and the chosen view, UI state only), `originGrants` (why each origin was granted), `instanceId`, `spentReceipts` (receipts whose `once` a run used), `indexes` (agent indexes with their pinned keys and the signed text last fetched), `policySubscription` (the one followed policy, its pinned key and signed text), `library` (pinned and recently opened agents) | never `storage.sync`; keys are typed once and never shown again; signed documents are re-verified when read; 0.1.0's clear `providerKeys`, `vault` and `vaultKey` are read once by the migration that runs when the first passphrase is set, and removed then |
| `chrome.storage.session` | per-tab candidates, which views hold which session, `secretKey` (the unlocked store's master key with the times it was unlocked and last used) | in memory, cleared when the browser closes; access level trusted contexts |
| IndexedDB `agent-browser` | `snapshots` (package bytes, by archive SHA-256), `sessions` (with their receipt and Run Plan), `runs` (Run Record, progress, audit, usage, checkpoints, and what a settled run left for the memory: its usage entries and staged agent document until applied, its proposals review outcome, the custom types its package declared), `artifacts` (bytes and SHA-256; `proposals.json` among them), `files` (picked PDFs, copied), `observations` (outbound request bodies, test mode only); **since schema version 5 (T19, D-221)** `memory_records` (one row per `memory.v0` record with every sealed value replaced by `sealed:omitted` and sealed beside it under the memory data key, associated data `chrome-agent-browser-memory-row-v0|<record id>|<pointer>`) and `memory_meta` (the types, the usage log, the custom-type approvals); **since schema version 6 (T24, D-270)** `conversations` (one row per conversation: the frozen Run Plan, the effective limits, the persisted state, the audit chain's tail and the conversation-level events, the spent budget and `once` permissions, the transcript, the active turn's run id, `open` or `ended` with the reason), and on a turn's row in `runs` its `turn` context, the pending card (`consent_pending`), the person's answers (`consent_decisions`) and, until the conversation charges it, the turn's outcome | `unlimitedStorage`; caps refuse, never evict silently; with the store locked the Memory page still reads every title, field and body (M-10), and no sealed value is readable |

**The secret store (T16, D-191, D-192; T19, D-221).** Provider keys and the memory's two keys (the
HMAC digest key and the data key the sealed values are sealed under) live in one envelope, `chrome-agent-browser-secret-store-v1`: each entry AES-256-GCM under a
random 32-byte master key with a fresh IV and the entry's name as additional data; the master key
wrapped under a key scrypt derives from the person's passphrase (N = 2^17, r = 8, p = 1, 16-byte
salt; about half a second). A wrong passphrase fails the unwrap and reads nothing; a passphrase
change re-wraps the master key under a new salt and touches no entry; "Forget everything" deletes
the envelope after a typed confirmation. Unlocking puts the master key alone into
`chrome.storage.session`; it is wiped after the idle time chosen under Settings → Security (5, 15
(default) or 60 minutes, or until the browser closes), by a sweep every minute and by every access
that finds it idle, on Lock now, and when the browser closes. Nothing secret is saved before a
passphrase exists (the strict path): Settings → Models and Memory say so until one is set, and
the clear values 0.1.0 left are migrated the moment it is. A run is handed only what its plan
needs (D-195, D-226): the bound provider's key, and the whole memory snapshot under its digest key
when the plan grants a record or binds a memory tool (the sealed-value scan set is every sealed
value of the store, M-36; the resolver answers only the plan's grants), so an agent that needs
nothing from the memory (Literature Review on Ollama) runs while it is locked; one that needs a
key or a record asks to unlock before Prepare and before Run, never during. A stored envelope this build cannot read is reported as *invalid* (the Security page
says why and offers Forget everything; a storage read that fails is an error, not *invalid*). Each
store operation runs alone, so one that began before Lock now, Forget everything or a passphrase
change cannot write the old state back; a memory opened before such a change is never saved after
it (`store_changed`); the memory controller reads the store's state on every open, so an idle lock
the sweep or a lazy check applied without an event drops the opened memory too, and an export never
carries a sealed value in clear from a store that is locked at the call (T19 review 1). The
`src/core/secrets.ts` module has no Chrome dependency; its test vectors are committed. With the
optional macOS helper, the store can also be unlocked from the login keychain (§12).

What is never stored in a record, plan, receipt, checkpoint or artifact: a provider key, a sealed
value, a prompt sent to a model outside test mode. A plan binds a memory record by opaque id and an
HMAC digest under the memory key (D-051, D-221), so the plan changes when the record does and
carries no value. The provider key and, when the plan needs the memory, the snapshot travel to the
execution host in the `host.start` message, in memory, for one run; the host never writes the
memory: a completed run's usage entries and its staged agent document come back through the stored
run and are applied by the service worker, in one write, once (D-226). §7 of the
[threat model](threat-model.md#chrome-agent-browser-t7) says what this does and does not protect at rest.

**The Memory page (T19, memory.v0).** Replaces "Your data": **Graph | List** over the person's
records, with the record card (form, Markdown body, provenance, links, where used; sealed values
masked, Reveal per field from the unlocked store), New, Delete, Tidy up, Export (a zip of the
Markdown folder, sealed values omitted unless asked while unlocked) and Import (the report of §3.8
of the design before anything is written), the one-time vault migration report until Done, and the
clearly labelled demo set. Settings → Memory lists the packages' own notes (agent documents) with
Open and Clear, and Forget memory. After a run that proposed records, the run page shows the review
sheet: accept, edit or reject per proposal, decided together once; a proposal of a type the package
declared itself is shown as a new type and approved for that package and schema when accepted
(M-18). The recall card at authorization offers the best candidate per requested type with the
signals that ranked it (D-220, D-229).

## 5. Permissions it asks Chrome for

From [`manifest.json`](../chrome-agent-browser/src/extension/manifest.json) (D-182, D-190, D-194; `npm run check-pack` refuses a zip whose list differs):

| Permission | Why |
|---|---|
| `storage`, `unlimitedStorage` | the stores above; package snapshots and artifacts can exceed the default quota |
| `sidePanel` | the side panel the action opens |
| `offscreen` | the execution host (reason `WORKERS`) |
| `activeTab` | the action click, the context-menu item "Look for agents on this page" and the `Ctrl/⌘+Shift+Y` shortcut (which opens the panel exactly as a click does; Chrome dispatches no `commands.onCommand` for `_execute_action`) grant that tab for the one read of its agent-package links |
| `scripting` | inject the discovery script into the clicked tab, and register it for the sites the person chose |
| `alarms` | the idle lock's sweep: one alarm, created once, fires every minute whatever the state and wipes an idle session key |
| `contextMenus` | the one page context-menu item |
| host `http://127.0.0.1/*`, `http://localhost/*` | Ollama on this machine only; a remote Ollama endpoint is refused (D-055) |
| optional `nativeMessaging` | requested only when the person turns on "Unlock with the macOS keychain" in Settings → Security (T17): talk to the WebAgents helper the macOS installer registers (§12) |
| optional host `https://*/*` | granted one origin at a time, with the person's click: a package's origin, its declared tool services and the model provider when a plan is prepared (listed under the plan's Technical details), a site to detect agents on ("Always detect agents on this site"), a signed index or policy; or as a whole under Settings → Permissions → "Detect agents on every site", off by default |

Three tiers of discovery (D-190): by default a page is read only when the person clicks the
button on it; a site they allowed gets the badge from then on; the every-site opt-in restores
0.1.0's passive badge everywhere. A `declarativeContent` rule cannot match a `<link>` in `<head>`
(Blink reports watched selectors only for elements whose style is resolved), which is why there is
no permissionless badge; the experiment is recorded in
[`examples/verification/chrome-declarative-content-experiment.json`](../examples/verification/chrome-declarative-content-experiment.json).
`tabs` is never requested. Settings → Permissions lists every granted origin with its reason and
revokes it; a plan that needs a revoked origin blocks Run by name until it is allowed again. Three
checks apply to every request a run makes: the plan's origin allowlist in the execution host
(`origin_not_in_plan`), the core URL gate (D-026) and Chrome's own grant.

The content security policy allows scripts from the extension only, WebAssembly compilation
(`'wasm-unsafe-eval'`, for a package's compute modules; it never permits `eval` or `new Function`,
D-253) and connections to HTTPS and the two loopback names. Every package string reaches the page through `textContent`; the shell
has no `innerHTML`.

## 6. Limits

| Limit | Value | Source |
|---|---|---|
| Package sessions | 7,200 s each, at most 8, at most 128 MiB of snapshots | D-032 |
| Package and page downloads | HTTPS on port 443, a DNS name, no redirect followed, 60 s | D-026, D-033, D-039 |
| Run limits (Settings → Policies → Run limits) | the reference plugin's defaults; "Use the long-run limits" sets the values the reference host used for Literature Review | D-084, `src/core/execution/limits.ts` |
| A package's own budget and deadline | always apply beneath the host's limits; the host never raises them | D-064 |
| Model calls | one bound model per plan, no fallback; a per-call deadline; output capped at the node's `max_output_tokens`. OpenAI is sent a strict json_schema (constrained decoding) when the package schema can be one without changing its meaning: optional properties are sent as required and nullable and a null for one is read back as absent, an array root is wrapped as `{"items": …}` and unwrapped; otherwise non-strict. The full package schema always decides. OpenAI's reasoning effort is a setting (Settings → Models, default medium) recorded on the run. An answer that is not accepted (it breaks the schema, is not JSON, or fails one of the package's answer checks) is asked for again, up to twice, each time with one line naming what was wrong, when the re-ask fits (see "A re-ask and a retry in a run record" below); never repaired | D-023, D-061, D-062, D-115, D-121…D-124, D-150, D-151 |
| A model call's size | before each call the runtime reserves the request counted as one token per UTF-8 byte (a safe upper bound; no tokenizer runs in the browser, and the Python runtime counts the same way) plus the node's `max_output_tokens`, and refuses the call when that exceeds the model's context. The run surface then says "The request was larger than the model's context window" with the reserved tokens and the context (T9). Local Ollama models are capped at 32,768 tokens until the person raises the context in Settings → Models; Literature Review's larger steps need 65,536 | D-055, `src/core/workflow/runtime.ts` |
| Tool calls | one request at a time, no redirect, bounded request and response bytes, the binding's own pacing. A read-only remote call that fails transiently (429, 500, 503, 504, a 502 that is not data, a connection failure, the binding's timeout) is sent again up to twice, after 1 s and 3 s or the server's `Retry-After` up to 10 s, each retry a remote call within the run's budgets; a tool with side effects is never sent twice. A `citation.resolve` call for a DOI whose resolver stays unavailable is answered by the built-in Crossref lookup when the package declares `api.crossref.org` (Literature Review 0.2.7 does). Only fast failures are recovered: a generic JSON binding's per-request deadline is the package's tool timeout, so a service that hangs for that whole time (45 s for Literature Review's resolver) leaves no time for a retry or the lookup, and the call fails as `tool_timeout` | D-054, D-066, D-081, D-152, D-153 |
| Selected PDFs | the reference parser's limits (size, pages, text per page, text in all) | D-082 |
| One active run | per session and per plan; a receipt must outlast the run deadline by 60 s | D-071 |
| In-browser models (T41) | one model loaded, one completion at a time (a map step's workers wait); the context the plan froze, at most the entry's (and 65,536); refused before the run when the weights are not cached and verified, the GPU-memory estimate at that context exceeds the machine's budget, a load at that context died before, or another model is in use; unloaded after 10 idle minutes (a setting); downloads only from `huggingface.co`, each file hashed while it arrives and kept only if it matches | D-441, D-444, D-450…D-452, §15 |
| Compute calls (compute.v0, T22) | each call in its own nested Worker, terminated when it answers, at its wall bound (`min(wall_seconds, timeout_seconds + 1)`, the CPU bound: Chrome meters no fuel) and on cancel; memory bounded by the module's declared maximum, refused before the run when that is above the host's page bound; the memory and time per compute call in Settings → Policies → Run limits | D-250, D-251, `src/core/compute/engine.ts` |

## 7. How it is verified

- **Unit and integration tests** (`npm test` in `chrome-agent-browser/`, vitest, no skipped test):
  the core against the Python suite's cases and against records the Python control plane produced
  (`test/fixtures/authorization/`), the shell over a fake `chrome`, the views in happy-dom.
- **Cross-runtime conformance** ([`conformance/`](../conformance/README.md)): both CLIs on the
  shipped packages in fixture mode and on a negative suite, and both control planes on stale-plan,
  replayed-`once` and profile scenarios; reports under `conformance/results/`.
- **Headless Chrome harnesses** (`scripts/e2e-*.mjs`): discovery and inspection against a local
  HTTPS origin, the paper reader, compute modules (`e2e-compute.mjs`: compute-test through the
  offscreen run Worker and its nested compute Workers, a runaway module stopped at its deadline, a
  cancel, the two indirect-call traps with the reference's codes;
  [`chrome-compute-e2e.json`](../examples/verification/chrome-compute-e2e.json)), and live runs of WebAir and Literature Review whose exported run
  directories are recomputed by `scripts/verify_chrome_*_live.py`. The recorded evidence is under
  [`examples/verification/`](../examples/verification/) (`chrome-*.json`). Headless Chrome cannot
  grant an optional origin (the prompt waits for nobody) nor `activeTab` (no click reaches an
  extension over CDP), so each harness loads a copy of the build whose manifest holds the origins it
  drives (`scripts/lib/granted-build.mjs`, D-196), the state a person's Allow leaves the extension
  in; `e2e-discovery.mjs` first loads the unmodified build to assert the manifest and the
  `origin_not_granted` refusal, and records the site grant with the worker as the website card's
  button does. The real prompts are walked through by hand.
- **The native helper** (T17): `swift test` in `native-helper/` (framing, the closed list, the
  wrap, the caller check), `native-helper/scripts/smoke.mjs` against the built binary,
  `installer/macos/test-installer.sh` against the built `.pkg`, and `scripts/e2e-native-helper.mjs`,
  where headless Chrome starts the real helper for the extension's worker
  ([`examples/verification/chrome-native-helper-e2e-t17.json`](../examples/verification/chrome-native-helper-e2e-t17.json)).
- **CI** runs the tests on Ubuntu and macOS with Node 24 and 26, builds and packs the extension,
  checks the zip's structure and that a second build packs to the same bytes, and runs the
  conformance suite ([`.github/workflows/ci.yml`](../.github/workflows/ci.yml)).

## 8. Packaging

`npm run build && npm run pack` writes `dist/chrome-agent-browser-<version>.zip` (the extension,
manifest at the root, ready to load unpacked or to upload to the Chrome Web Store) and
`dist/chrome-agent-browser-<version>.contents.txt`, one `sha256 bytes path` line per member and
the zip's own hash. The build writes `LICENSE.txt` and `THIRD_PARTY_NOTICES.txt` into the
extension from the license files of exactly the packages esbuild bundled. `npm run check-pack`
verifies the file set, the manifest version, the listing, the notices, the least-privilege manifest
(the loopback names as the only host permissions, every HTTPS origin optional, no static content
script, the permission list exactly as decided) and the Web Store's remote-code rule (no script
loaded from the network, nothing evaluated from text, `script-src 'self'`). The submission kit for
the Web Store is [`chrome-agent-browser/store/`](../chrome-agent-browser/store/README.md). The bundles are not
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
whole path in a real Chrome against a local HTTPS mock of that origin. Index **1.2.0** (T15, D-174)
lists Literature Review 0.2.7 and WebAir 0.5.0; both origins also keep serving Literature Review 0.2.6
and 0.2.5, which indexes 1.1.0 (T11, D-131) and 1.0.0 listed (kept as `examples/agent-index-1.1.0.json`
and `examples/agent-index-1.0.0.json`). Evidence: index 1.2.0,
[`chrome-search-policy-e2e-index-120.json`](../examples/verification/chrome-search-policy-e2e-index-120.json); index 1.1.0,
[`chrome-search-policy-e2e-index-110.json`](../examples/verification/chrome-search-policy-e2e-index-110.json)
(also finds WebAir by its locator and its claims match); index 1.0.0 (T8),
[`chrome-search-policy-e2e.json`](../examples/verification/chrome-search-policy-e2e.json).

## 10. Using it: what the pages show (T9)

- **The Open page** is a start page while nothing is shown: the "WebAgents" wordmark (text in four
  colours of the extension's palette, no image or web font), one rounded search box that takes
  words, an agent name (`name@host`), a website or a package URL, a short hint, "Manage indexes"
  and the agents open now. Results, a website, an open agent, a busy state or an error switch it to
  a compact page: a small wordmark beside the same box (above it on a narrow window), the content
  below. Only the layout changes; the box, its messages and the results are the same (T12, D-140,
  D-141). On the compact page the small wordmark leads back to the start page; an open agent is
  set aside there, under "Open now", not closed (T14, D-162).
- **The Runs page.** Open shows the chosen run at the top, under "← All runs", with the list below
  it, and moves the page and the focus to the run's heading; a run that cannot be shown (for
  example `run_unknown`) says so on the Runs page and the list stays (T14, D-160, D-161).
- **The task form** shows a field's description only when it adds something to the placeholder
  (the publisher's example) and the label (D-110).
- **One way to choose a profile.** The agent page no longer lists the profiles; the authorize
  view's "Ways to use it" does, each card with its title, its description, what it grants ("Gets:
  …") and one estimate line. Every profile's members, estimate and notes stay under the agent
  page's Technical details → "Profiles (declared by the publisher)" (D-111).
- **A finished run's files** are a count and two buttons: Inspect opens the list of package
  exports and run evidence (View and Download per file), and Download saves `<run_id>.zip` with
  `run.json`, `exports/` and `evidence/`, every file checked against the hash the run recorded
  (D-112). The Runs page's Export stays the verifier bundle (plan and input included, D-073).
- **Chrome's built-in model** (Gemini Nano) has a row in Settings → Models like any model; "Make
  default" appears once Chrome reports it available. Its context is the Prompt API's measured
  session quota. The Prompt API states no reasoning, so a package that requires reasoning (WebAir)
  gets a plan on it only after the person states "Reasons: yes" on its row, recorded as declared
  by them; any model's row offers the same statement (D-113). The run then uses that statement as
  well: what a model delivers at execution is read from the plan's model descriptor for every
  provider, so a plan that was prepared is not refused at start for reasoning (T11, D-130; before,
  the built-in route stated no reasoning at execution and such a run failed
  `execution_model_incompatible`). A plan keeps the model it was
  prepared with; after the default changes, the plan card says so and "Use this agent" prepares a
  plan on the new default.

### A re-ask and a retry in a run record (T13)

Both are in the run's audit (`evidence/audit.json` in the Download, `audit.json` in the CLI's
output directory) and summarized in its record:

- **A re-ask.** The refused attempt is a `model.failed` with `reason: model_output_not_conforming`
  and `failure_facts.output_failure` (`schema`, `not_json`, `no_text` or `check`); for a refused
  answer check it also carries `failed_check`, e.g. `{check: "answer_check", index: 0, kind:
  "relation", failure: "missing_target_key", row_key: "/owner", target_key: "/name"}`. The re-ask
  follows as `model.count.called` and `model.called` with `attempt: 2` (then 3) and `after`, the
  same structure without any value. The model alone is shown the reason, as the last section of the
  request: `## Correction` and `The previous answer was not accepted: answer check 0 (relation)
  failed: missing_target_key at /owner for "Dana". Return the complete JSON document again,
  corrected.` A re-ask that would not fit is `model.retry_skipped` with `reason` `budget` (and the
  `bound`), `context_window` or `deadline`. The run surface says it in words, for example "It
  failed the package's answer check 0 (relation: missing_target_key at /owner). The runtime asked
  twice more, each time naming what was wrong, and no answer was accepted."
- **A retry.** One `tool.called` for the call; each retry is `tool.retried` (`attempt`, `reason`
  `http_status`, `transport` or `timeout`, `http_status`, `delay_ms`) and one more remote call in
  `usage`; `tool.settled` says `attempts` and `answered_by`. A retry that would not fit is
  `tool.retry_skipped` (`budget`, `deadline`, or `retry_after` when the server asked for more than
  10 s). The citation fallback adds `tool.fallback` (`from`, `to`, `reason`), and
  `tool.fallback_failed` or `tool.fallback_skipped` when it could not answer; its answer carries
  the warning "The Citation Resolver was unavailable, so this browser looked the DOI up at Crossref
  only (built-in fallback)." The record's Technical details list per tool how many calls were
  retried and how many the built-in lookup answered.

Fixture runs show neither: a replay router asks no model twice and fixture tools are never retried,
so the two runtimes still replay every package identically (`conformance/`).

## 11. What it does not do yet

See the README's [What it does not do yet](../chrome-agent-browser/README.md#what-it-does-not-do-yet):
the built-in model has not run live, local tools other than the PDF reader and GET services other
than Crossref stay unbound, pacing is per run rather than per browser, the extension cannot
classify the addresses DNS names resolve to, NANDA resolution is a stub, a policy's issuer anchors
are not applied and one policy is followed at a time, and per-origin permissions, Firefox and the
Meeting Agenda path are later work.

## 12. Installer and helper (T17)

Optional, macOS only, and never needed (D-181): the extension is complete on its own. One
installer, [`installer/macos/`](../installer/README.md), adds the helper (0.1.0 also configured
Ollama):

- **The native helper** (`native-helper/`, Swift, one universal binary). Chrome starts it for one
  request and one reply; it does three things only (D-204): wrap the store's master key under a
  key it keeps in the login keychain, unwrap it, and report Ollama's state. In Settings → Security,
  **Unlock with the macOS keychain** → **Turn on** asks Chrome for `nativeMessaging` (the click is
  the gesture), has the helper wrap the master key, unwraps it once to prove the round trip, and
  stores the blob and a check box beside the envelope (`secretKeychain`). The card then says
  *keychain available*, the helper's version and Ollama's state, as the running server answers
  the extension's origin ("running and admits this extension", "installed but not running",
  "running but does not admit this extension").
  The Unlock sheet offers **Unlock with the macOS keychain** first; if the helper is missing,
  refuses, times out or returns a key that does not open this store's check, the sheet says so and
  the passphrase form unlocks as before. A record that can never work again (the keychain item is
  gone or replaced, the key does not fit) is dropped; nothing else is, so removing the helper loses
  nothing. Turn off and Forget everything delete the record.
- **Ollama, configured** (0.1.0 only; removed in 0.2.0, T41, D-446, D-457): the extension runs
  models itself in the browser (§15), so the installer no longer installs Ollama or sets
  `OLLAMA_ORIGINS`. Its uninstaller still removes what a 0.1.0 install's Ollama choice left (the
  LaunchAgent, the receipt, the extension's entries in `OLLAMA_ORIGINS`). The helper's read-only
  report of Ollama's state stays, for people who run Ollama.

The helper answers one extension id: the one the manifest's `key` gives every unpacked build
(D-200; the Web Store's id joins it at U7). `npm run pack` removes `key` from the store zip.
The boundary is in the [threat model](threat-model.md#native-helper-and-macos-installer-t17).

## 13. Conversations and consent cards (T24)

A package that declares a conversation ([`conversation.v0`](../spec/conversation-v0.md)) is talked
to rather than run: the agent page shows the chat surface in place of the run form, in the side
panel and in the full page (D-270). `run.start` refuses such a plan (`conversation_profile`, V-28).

**How a conversation runs.** `conversation.start` checks the session's current Run Plan (one
conversation per plan, spec §12) and the readiness a run needs, then stores the conversation
(`conversations`, §4) and records `conversation.started` on its audit chain. Each
`conversation.send` validates the message against the package's `input_schema` and reserves the
whole turn against what the conversation has left (V-10): the turn's own token and remote-call
budgets, each lowered to the browser's run limits as they stood when the conversation started
(Settings → Run limits, and the policy's caps), must fit, else the turn
is `turn.refused` and the conversation ends (`max_turns` or `budget`) in the same write. A reserved
turn records `turn.started` and the turn's run id on the conversation in one conditional write, so
two sends from two views, or a send racing End, start at most one turn and the chain never forks
(V-17). A turn runs under the lower of those frozen limits and the current ones, field by field:
raising a limit mid-conversation never lets a turn spend more than it reserved, and a limit the
person or the policy lowered since still binds every later turn (D-102). The run manager then leases
and starts the turn as a run: the start message carries the
state, the chain's tail, the `once` permissions already spent, the per-tool calls left and the
steps the plan pre-decided; the Worker's runtime continues the chain from that tail. When the run
settles, the service worker charges its usage, takes its new state (a completed turn only), records
`turn.completed` or `turn.failed`, and evaluates the package's end rule (V-8) and the turn bound,
writing `conversation.ended` in the same step when either holds. A turn interrupted by a restart
(D-071) keeps its checkpointed slice and is a failed turn; the conversation stays open (V-25), and
the `once` permissions it may have used are counted spent (an allowed `once` check in its slice, or
a step accepted in it), so the next turn is not asked again. `once` is spent once per conversation:
the first turn's lease spends the receipt, the later turns of the same conversation are leased under
it, and a second conversation under that receipt needs a new authorization.

**The consent card.** A turn that reaches a `consent` node writes the pending card into its stored
run (`consent_pending`: the step, the permissions, the sentence, the facts, the timeout, the
instant) and notifies the views, so a panel closed and reopened shows the card again.
`conversation.decide` stores the person's answer on the run (`consent_decisions`) and posts
`host.decide` to the Worker; the Worker's consent host resolves on that message and also re-reads
the record every second, so a lost message never hangs the step, and the node's `timeout_seconds`
ends the wait (V-29). The card shows the sentence (the model's, D-274), the facts beside it (the
graph's constructed input, unsealed fields only), the permissions it uses and the step that asked,
and Yes / No. After each decision the transcript keeps one provenance line: decided by the person,
not asked because the plan denies the permission or it was spent (V-12), answered by the
Convenience preset, or forbidden by the policy. Only extension pages can send `conversation.*`
messages, so a web page cannot answer a card.

**Pre-decided steps (D-271).** A consent step naming a permission of kind `payment` or
`personal.read` is never pre-decided. `privacy-first` and `balanced` ask every step; `convenience`
pre-accepts a step whose permissions are all of other kinds. A followed policy may add a `consent`
section ([`policy-bundle-v0`](../spec/conversation-v0/policy-bundle-v0.schema.patch.json)):
`pre_decide: "never"` makes every step ask whatever the preset, and `forbid_kinds` makes a step
naming such a kind resolve denied (`decided_by: policy`, `reason: policy_forbids`) without a card.
The pre-decisions are recorded in the Run Plan (`execution.conversation.consent_steps`) and shown on
the authorization summary; nothing at run time adds one.

**What the views offer.** Send (the message box is the package's input rendered by the task form),
Stop this turn while a turn runs (the turn is `cancelled`, V-30), End conversation between turns
(reason `person`), Details (the turn's run record), Download. The Runs page lists each
conversation once, with its turns inside, and Download saves the zip of D-272:
`conversation.json`, `run-plan.json`, `transcript.json`, `state.json`, `audit.json` (the whole
chain), `usage.json`, `provenance.json` and `turn-NNN/` per turn. A turn's own record verifies its
audit as a slice that continues the conversation's chain. Messages: `conversation.start`, `send`,
`decide`, `end`, `cancelTurn`, `get`, `list`, `export`, `clear`; the event `event.conversation`;
the host command `host.decide`.

**An input switch that needs a memory read (D-273).** On a task's run form, an input switch that
turns on a step reading a memory record (Literature Review's `use_profile`) shows the recall card
under the switch when the plan does not grant that read; choosing a record authorizes again with
it, so the plan is frozen again before Run.

Evidence: `scripts/e2e-conversation.mjs` drives a two-turn conversation with a card through the
extension's messages in headless Chrome, and `scripts/verify_chrome_conversation.py` recomputes
its export ([`chrome-conversation-e2e-t24.json`](../examples/verification/chrome-conversation-e2e-t24.json)).
The boundary is in the [threat model](threat-model.md#conversations-in-chrome-t24).

## 14. Delegation networks (T26)

A package that declares a network ([`network.v0`](../spec/network-v0.md)) runs as any task does;
what changes is what the person is told before the run and what the run page shows (D-291).

**Before the run.** The agent page has a card **How it delegates**: the sentence the summary's
`delegation_network` warning carries (the reference's words, which say which roles the model routes
and which the package does), the envelope's figures under **At most, in any run** (handoffs, model
calls, tool calls per tool, remote calls, tokens) and each role, the entry first: who picks what
follows it (the model among its edges, each with its use cap and `done` where it may end, or the
package's fixed next), at most how many times it runs, and what one activation may spend (model
calls, tools, tokens, remote calls). Every figure is the bound computed from the signed
declaration (R-21): a run can stay below it and cannot pass it. The Run Plan freezes the envelope
(`execution.network`, shown as **Delegation** on the plan card), and the execution runner computes
it again from the verified package before the run and refuses a plan that states another
(`execution_plan_invalid`). The execution host records the envelope under its own limits, with each
role's budget per activation (`role_budgets`), in the run record's `network` section.

**During and after the run.** The network node reserves the envelope before its first activation
(`network.started`, or `network.refused` with nothing spent, R-17). The progress snapshot carries
the network's state (`progress.network`: the role running now, the handoffs, every `route.decided`
with its reason, how it ended), and the run page shows it under the stages: one chip per decision
("FrontMan → Hotel (the model)", a refused one in red with its reason) and **Handoffs 3 of at most
6**. Technical details list every route decision (hop, role, which time it ran, chosen by, next,
allowed or refused) and **Usage by role** (times run of at most, tokens and remote calls against
the budget per activation). A refused chosen route is a non-conforming answer: this host asks again
up to twice with a line naming the route check and the failure (R-28); each attempt's decision is
recorded, and the attempts are charged to the role's tokens and remote calls, which the envelope
bounds.

**The travel network.** `org.webagents.travel-network` 0.1.0, listed in the demo index 1.6.0 and
served at `https://webagents-webair-production.up.railway.app/packages/travel-network-0.1.0.agent.pkg`,
consults the WebAir origin's fictional travel services; its envelope is 6 handoffs, 8 model calls,
one call of each tool, 19 remote calls and 48,000 tokens.

Evidence: `test/core/network/` (the 46 cases, the bound against the reference over random networks
and against every reachable prefix, the travel network's sixteen walks, the re-ask, the timeout
naming), `test/extension/network-ui.test.ts`, the conformance suite's network family (both runtimes,
identical refusals and audits), and `scripts/e2e-network.mjs`, which runs the signed travel network
in headless Chrome from a fake WebAir origin in fixture mode, with `scripts/verify_network_run.py`
recomputing its export ([`chrome-network-e2e-t26.json`](../examples/verification/chrome-network-e2e-t26.json));
the same script checks a live run's Runs-page export.

## 15. In-browser inference (T41)

The default local route: the extension runs an open-weight GGUF model itself, inside the browser,
on the machine's GPU, with no application beside it (D-310, D-311, D-440…D-459). The design and its
measurements are [`design/in-browser-inference.md`](design/in-browser-inference.md); this section
says where each part lives.

**Placement.** The engine is wllama 3.8.1 (llama.cpp on WebGPU): `engine-worker.js` and its
`wllama.wasm` (SHA-256 `551f1343…e70c`, asserted by `check-pack`), a dedicated Worker the offscreen
document (`execution.html`) creates and owns through `EngineHost` (`src/extension/execution/engine-host.ts`),
so a loaded model outlives the runs that use it. A run reaches it through a `MessagePort` the page
transfers inside `host.start` when the plan binds `in-browser/<entry>`; the run's Worker wraps it as
the core's `InBrowserEnginePort` (`in-browser-port.ts`) and never loads or spawns anything. Before
the run starts, the page loads the entry at the plan's context or refuses with the reason (not
downloaded, unverified, over the budget with both numbers, a context that died before, another model
in use by run …); never another model (principle 6). The core sees the port only: `src/core` holds
the adapter, the catalog format, the recommendation, the GGUF header reader and the weights digest,
and the boundary test keeps WebGPU and the DOM out of it.

**Lifetime.** One model, one completion at a time (a queue). It stays loaded until Unload, an idle
time with no run (10 minutes by default, Settings → Models), a run that needs another entry while
none uses this one, or the extension unloading. A Worker that dies (out of memory) fails the calls it
held as `model_unavailable` (`engine_worker_died`), records "failed to run at <context>" on the
entry, and is not restarted by itself. The first completion after a load records the measured
prefill and decode speed for the recommendation; a CPU-only control load never does.

**The cache.** IndexedDB `models` (database version 7) holds one row per listed entry (the entry,
its files' state, `downloaded_at`, `last_used`, `verified_at`, the header facts read from the cached
bytes, the measured speed); the weights are OPFS files `models/<sha256>`, written in place by the
models Worker (`models-worker.js`) through sync access handles, so a partial file survives a crash
and an HTTP `Range` resume never copies it. Every file is hashed while it arrives (`@noble/hashes`)
and kept only if its SHA-256 is the entry's; a mismatch keeps no byte, a cancel leaves no file. The
extension's OPFS is removed with the extension. Downloads run in the offscreen page, so they continue
when the side panel or the full page closes.

**The list.** The curated list is a signed document (`org.webagents:model-catalog-v0`, the
`webagents-catalog` key, `examples/model-catalog.json`), shipped in the extension and refreshed only
when the person asks (Check for a newer list), refused when older, reused for other content, expired
or signed by another key. A pasted Hugging Face repository's file is an uncurated entry pinned to the
repository's commit. Entry URLs must be `https://huggingface.co/…` and pass the package URL gate
before any fetch; the digest binds the bytes wherever the redirect goes.

**Recommendations.** The engine Worker's probe (the WebGPU adapter), the memory hint, the storage
estimate, a 512×512 matmul benchmark's class, the measured speed per entry and the person's statement
of GPU memory give each entry a bin: recommended, possible, not suitable (with a package open) or too
large, every reason shown with the budget's basis. The picker shows the routes as *In this browser*,
*Chrome's built-in model*, *Ollama on this computer* ("it runs outside the browser's protection")
and *Hosted by …*, and suggests the smallest recommended curated entry, cached or with its download
card.

**Evidence.** The adapter, the catalog, the bins, the header reader, the downloader, the engine
host's rules and the views are unit-tested (`test/core/models/in-browser*.test.ts`,
`test/extension/{model-cache,engine-host,in-browser-service,in-browser-ui}.test.ts`). In real Chrome,
`scripts/e2e-inbrowser.mjs` downloads the curated Qwen3 4B through the product's downloader from a
local origin answering for `huggingface.co`, refuses a digest mismatch and an over-budget load,
compares the GPU's decode speed with a CPU-only control, sees the idle unload, then runs WebAir
0.8.0's search conversation on the model; `scripts/verify_chrome_inbrowser_e2e.py` recomputes the
report ([`chrome-inbrowser-e2e.json`](../examples/verification/chrome-inbrowser-e2e.json)).
