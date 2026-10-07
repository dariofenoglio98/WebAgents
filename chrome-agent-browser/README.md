# Chrome Agent Browser

The second runtime of WebAgents: a Chrome extension that discovers, verifies, inspects and
**authorizes** signed `agent.pkg` packages that websites advertise, built on a portable
TypeScript core that runs in Node as well. **This version executes nothing.** It is the
foundation (T1) and the authorization path (T3) of Phase 2 that the execution core (T4) and
runs from the browser (T5) build on.

What it shows today, on the WebAir demo site:

1. You visit a website. Its page carries `<link rel="agent-package" …>`. The content script
   reports that one link element and nothing else; the badge shows how many packages the page
   advertises.
2. The side panel lists them as *locations*: nobody has verified anything yet. **Inspect**
   downloads the package once, hashes it, stores the bytes, and evaluates it layer by layer
   (container, integrity, schema, runtime), then the signature, then publisher trust.
3. The agent page tells a person what matters first: the name, who signed it and whether you
   trust that key, in words ("Signed, publisher unknown", "Signed by a publisher you trust",
   "Possible impersonation", "Signature invalid", "Unsigned"), what it does, what it will be
   able to access grouped by kind, where it came from, the declared cost. The technical details
   (digest, archive SHA-256, signer fingerprint, validation layers, tools, raw manifest) sit
   behind a disclosure.
4. **Trust this publisher key** pins the key the package was signed with, scoped to this
   package id by default or to the publisher. The Trust page lists and removes pins. Trusting a
   key grants no permission: permissions are decided per run, later.
5. The full-page agent browser (`browser.html`) takes a website address or a package URL in its
   address bar and does the same without a tab.
6. **Authorize in two clicks** (T3). Below the agent page, the publisher's profiles (WebAir
   0.4.0 declares *Search flights*, *Search and quote*, *Book (simulated)*) appear as cards that
   say what each one *gets*, in plain words derived from the decisions it would yield, never from
   the publisher's text alone. One summary card states what the agent will and will not be able
   to do, which of your records it may read (you choose which), the model and the preset; **Use
   this agent** records the decisions as an authorization receipt and prepares a Run Plan on your
   default model. **Customize your settings** expands the full per-item view: every permission
   with Deny / Allow once / Allow for session, every tool approval, the record chooser per type,
   the model picker with its compatibility verdicts (authorizing there binds the model you
   picked), the declared limits. Every decision records
   who made it (you, the profile, or the preset). **Ready to run** shows the plan with its id and
   hash under Technical details. Running arrives with T5; nothing runs yet.
7. **Settings → Models** lists the routes (local Ollama, OpenAI and Anthropic with your own
   keys, Chrome's built-in model), tests each connection, lets you state a model's limits and
   pick the default model (Ollama must be started with `OLLAMA_ORIGINS` including
   `chrome-extension://*`). Keys are typed once, stored in `chrome.storage.local`, never shown
   again and never synced. **Settings → Policies** selects the host preset (privacy first,
   balanced, convenience). **Your data** holds your records per type, with a one-click fictional
   demo set that is clearly labelled and never pre-filled.

Verification is the same as the Python reference runtime's (`agentpkg`): the core reports the
same digest, archive SHA-256, signer fingerprint and validity, and the browser summary equals
the Python control plane's output canonically for every shipped package. Authorization is
too: the receipt, the Run Plan, the host-resource, tool and model evaluations and the
preflight are compared field by field, and by hash, with records the Python control plane
produced for WebAir 0.4.0 (`test/fixtures/authorization/`). The documented differences are
the decision provenance, the denied-tool list and the model-availability check (D-053).

## Load the unpacked extension

```sh
cd chrome-agent-browser
npm ci
npm run build            # dist/extension/ and dist/cli.js
```

Then in Chrome (137 or newer; Ed25519 verification needs its WebCrypto): open
`chrome://extensions`, enable **Developer mode**, choose **Load unpacked** and select
`chrome-agent-browser/dist/extension`. Pin the action. Visit
`https://webagents-webair-production.up.railway.app/` (WebAir, a fictional airline): the badge
shows `1`; the action click opens the side panel; **Inspect** shows the agent page.

`npm run pack` writes `dist/chrome-agent-browser-<version>.zip` for distribution (a deterministic
archive written by the script itself; no system `zip` is needed).

## The Node CLI

The same core, with agentpkg's flag names and report shapes, so the two runtimes can be
compared side by side (T7's conformance suite drives both this way):

```sh
node dist/cli.js verify   ../dist/webair-0.3.0.agent.pkg --trust-key ../examples/keys/webair-publisher.pub.pem
node dist/cli.js inspect  ../dist/webair-0.3.0.agent.pkg
node dist/cli.js evaluate ../dist/webair-0.3.0.agent.pkg [--trust-store trust.json]
```

`verify` prints what `agentpkg verify` prints and, like it, refuses on stderr with status 2.
`evaluate` prints the control plane's layered view (archive hash, the four validation layers,
the signature report, the trust verdict, the browser summary). `run` arrives with T4.

## Layout

| Path | Role |
|---|---|
| `src/core/` | The portable core: strict ZIP_STORED reader, strict JSON and RFC 8785, SHA-256 and Ed25519 through WebCrypto (pure-JS fallback), schema and semantic validation over agentpkg's own JSON Schemas, the trust store, discovery, the browser summary, profiles, the agent-page model; authorization (receipts, profile expansion, presets), host resources, host tools (the derived registry), model compatibility, Run Plans and their preflight, the personal vault, and the model catalog probes (`models/catalog.ts`). No Chrome, no DOM, no Node. |
| `src/core/schemas/` | Byte-for-byte copies of `agentpkg/src/agentpkg/schemas/*.json` and, under `extensions/`, of `spec/extensions/*.schema.json`, written by `npm run sync-schemas`; tests assert equality. |
| `src/extension/` | The Manifest V3 shell: `manifest.json`, the service worker (`background/`, the only place that holds state: sessions with their receipts and plans, the trust store, settings, keys, the vault, the model catalog), the content script (`content/`), the side panel, the full page (`browser/`), storage adapters (`storage/`), the message contract (`messages.ts`), the views (`ui/`: agent page, authorize view, settings, your data) and `data/demo-host-resources.json`, a copy of the demo host's resource definitions. |
| `src/cli.ts` | The Node CLI over the core. |
| `scripts/` | `build.mjs` (esbuild), `pack.mjs`, `sync-schemas.mjs`, `make-icons.mjs`, `e2e-discovery.mjs`, and `make-authorization-fixtures.py`, which writes the Python control plane's reference records for `test/fixtures/authorization/` (run with `agentpkg/.venv/bin/python`). |
| `test/` | vitest: `core/` mirrors the Python suite's negative cases and asserts parity with the shipped packages; `extension/` covers the message contract, the controller, storage, the service worker over a fake `chrome`, the content script and the views. |

## The boundary rule

Nothing under `src/core` may depend on Chrome, the DOM or Node. Two checks enforce it:
`tsconfig.core.json` compiles the core with no DOM, Node or Chrome type library and only the
WHATWG globals `src/core/globals.d.ts` declares, so a `chrome` or `document` reference is a
compile error; and `test/core/boundary.test.ts` scans the source text for forbidden globals and
imports, so nothing can be smuggled past the compiler. The core imports exactly two runtime
dependencies: `@hyperjump/json-schema` (an interpreter, because Manifest V3 pages forbid `eval`)
and `@noble/ed25519` (the fallback when WebCrypto lacks Ed25519).

Every package string reaches the document through `textContent`; the shell has no `innerHTML`
(a test scans for every markup sink). The README of a package goes through the Markdown
renderer copied from the reference plugin, which builds DOM nodes and never passes HTML through.

## Checks

```sh
npm run typecheck && npm test          # both TypeScript projects; the suite allows no skipped test
npm run build && npm run pack          # a loadable extension and its zip
node scripts/e2e-discovery.mjs         # headless Chrome against a local mock of the WebAir origin
```

The end-to-end harness launches the installed Google Chrome with the DevTools protocol over a
pipe and loads the built extension with `Extensions.loadUnpacked` (branded Chrome 137 and later
ignore `--load-extension`). A local HTTPS server on 127.0.0.1 serves WebAir's captured pages and
the signed package under a throwaway certificate; `--host-resolver-rules` maps `webair.example`
to it, so the extension's URL policy sees an ordinary HTTPS origin and nothing is relaxed for the
test. It asserts the badge, the worker's candidate state, discovery and inspection in the full
page, the trust round trip, the direct package URL, and the refusals of a tampered package, a
redirect and an `http://` address. The side panel cannot be opened headlessly (Chrome requires
a user gesture), so the harness checks that its page loads and leaves the panel to the manual
walk-through. It needs `openssl` on the PATH and prints JSON with `"passed"`.

## What it does not do yet

- **Execute.** No model call (beyond the catalog probes of Settings → Models, which list
  models and never prompt one), no tool call, no run. A Run Plan is a preflight artifact; the
  execution host, the model and tool adapters and the run record are T4 and T5, and `once`
  grants are spent by a run, which no build can start yet. Runs is a placeholder that shows the
  intended layout; Library lists the open sessions only.
- **Implement every local tool.** The host registry binds a generic HTTPS JSON adapter to each
  declared remote tool and a vault binding to each host-resource tool; other local tools
  (Literature Review's `paper-reader`) stay unbound until T6, and an approved unbound tool
  blocks the plan, as in the reference.
- **Classify addresses.** Package, site and tool URLs must be HTTPS on port 443 with a DNS
  name (no IP literals, `localhost` or `.local`); the private-address, DNS-pinning and
  connection-level checks of the Python runtime are Chrome's network stack's job here, and the
  threat model will say so (T7).
- **Per-origin permissions.** The content script runs on every HTTPS page and reads only the
  advertised link elements; narrowing to opted-in origins is later hardening.
- Firefox, the Meeting Agenda UI path, search over an index, and policy subscriptions are in the
  backlog.

Nothing here contacts any network at install or start, carries no telemetry, and never messages
a web page.
