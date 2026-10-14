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
| `chrome.storage.local` | `trustStore` (the `agentpkg-trust-store-v0` format), `settings` (presets, model connections and limits, run limits, services, the idle lock), `secretStore` (the encrypted envelope, T16: `provider_key:<provider>`, `vault`, `vault_key`), `originGrants` (why each origin was granted), `instanceId`, `spentReceipts` (receipts whose `once` a run used), `indexes` (agent indexes with their pinned keys and the signed text last fetched), `policySubscription` (the one followed policy, its pinned key and signed text), `library` (pinned and recently opened agents) | never `storage.sync`; keys are typed once and never shown again; signed documents are re-verified when read; 0.1.0's clear `providerKeys`, `vault` and `vaultKey` are read once by the migration that runs when the first passphrase is set, and removed then |
| `chrome.storage.session` | per-tab candidates, which views hold which session, `secretKey` (the unlocked store's master key with the times it was unlocked and last used) | in memory, cleared when the browser closes; access level trusted contexts |
| IndexedDB `agent-browser` | `snapshots` (package bytes, by archive SHA-256), `sessions` (with their receipt and Run Plan), `runs` (Run Record, progress, audit, usage, checkpoints), `artifacts` (bytes and SHA-256), `files` (picked PDFs, copied), `observations` (outbound request bodies, test mode only) | `unlimitedStorage`; caps refuse, never evict silently |

**The secret store (T16, D-191, D-192).** Provider keys and the vault (records, types and the HMAC
key) live in one envelope, `chrome-agent-browser-secret-store-v1`: each entry AES-256-GCM under a
random 32-byte master key with a fresh IV and the entry's name as additional data; the master key
wrapped under a key scrypt derives from the person's passphrase (N = 2^17, r = 8, p = 1, 16-byte
salt; about half a second). A wrong passphrase fails the unwrap and reads nothing; a passphrase
change re-wraps the master key under a new salt and touches no entry; "Forget everything" deletes
the envelope after a typed confirmation. Unlocking puts the master key alone into
`chrome.storage.session`; it is wiped after the idle time chosen under Settings → Security (5, 15
(default) or 60 minutes, or until the browser closes), by a sweep every minute and by every access
that finds it idle, on Lock now, and when the browser closes. Nothing secret is saved before a
passphrase exists (the strict path): Settings → Models and Your data say so until one is set, and
the clear values 0.1.0 left are migrated the moment it is. A run is handed only what its plan
needs (D-195): the bound provider's key, the vault when the plan grants a record, and the vault's
types alone (no record) when the plan binds a host-resource tool without granting one, so an
agent that needs nothing from the store (Literature Review on Ollama) runs while it is locked;
one that needs a key, a record or a record type asks to unlock before Prepare and before Run,
never during. A stored envelope this build cannot read is reported as *invalid* (the Security page
says why and offers Forget everything; a storage read that fails is an error, not *invalid*). Each
store operation runs alone, so one that began before Lock now, Forget everything or a passphrase
change cannot write the old state back; a vault opened before such a change is never saved after
it (`store_changed`), and the records' digest key is read or created in one operation. The
`src/core/secrets.ts` module has no Chrome dependency; its test vectors are committed. With the
optional macOS helper, the store can also be unlocked from the login keychain (§12).

What is never stored in a record, plan, receipt, checkpoint or artifact: a provider key, a vault
value, a prompt sent to a model outside test mode. A plan binds a vault record by opaque id and an
HMAC digest under the per-profile `vaultKey` (D-051), so the plan changes when the record does and
carries no value. The provider key and, when a record is granted, the vault travel to the execution
host in the `host.start` message, in memory, for one run. §7 of the [threat model](threat-model.md#chrome-agent-browser-t7)
says what this does and does not protect at rest.

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

The content security policy allows scripts from the extension only and connections to HTTPS and
the two loopback names. Every package string reaches the page through `textContent`; the shell
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
installer, [`installer/macos/`](../installer/README.md), adds two things:

- **The native helper** (`native-helper/`, Swift, one universal binary). Chrome starts it for one
  request and one reply; it does three things only (D-204): wrap the store's master key under a
  key it keeps in the login keychain, unwrap it, and report Ollama's state. In Settings → Security,
  **Unlock with the macOS keychain** → **Turn on** asks Chrome for `nativeMessaging` (the click is
  the gesture), has the helper wrap the master key, unwraps it once to prove the round trip, and
  stores the blob and a check box beside the envelope (`secretKeychain`). The card then says
  *keychain available*, the helper's version and Ollama's state ("running and admits this
  extension", "installed but not running", "OLLAMA_ORIGINS … does not admit this extension").
  The Unlock sheet offers **Unlock with the macOS keychain** first; if the helper is missing,
  refuses, times out or returns a key that does not open this store's check, the sheet says so and
  the passphrase form unlocks as before. A record that can never work again (the keychain item is
  gone or replaced, the key does not fit) is dropped; nothing else is, so removing the helper loses
  nothing. Turn off and Forget everything delete the record.
- **Ollama, configured** (an optional choice, on by default): an Ollama already installed is only
  configured; otherwise Homebrew's `ollama-app` cask, or the pinned release checked by SHA-256 and
  signing team (D-202). The extension's own `chrome-extension://<id>` is added to `OLLAMA_ORIGINS`
  now and at every login by a LaunchAgent, which restarts Ollama only when it rejects the origin.

The helper answers one extension id: the one the manifest's `key` gives every unpacked build
(D-200; the Web Store's id joins it at U7). `npm run pack` removes `key` from the store zip.
The boundary is in the [threat model](threat-model.md#native-helper-and-macos-installer-t17).

