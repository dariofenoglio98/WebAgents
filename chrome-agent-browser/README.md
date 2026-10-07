# Chrome Agent Browser

The second runtime of WebAgents: a Chrome extension that discovers, verifies, inspects and
**authorizes** signed `agent.pkg` packages that websites advertise, built on a portable
TypeScript core that runs in Node as well. The core now **executes** `workflow.v0` packages
(T4): the interpreter, the model and tool adapters, the runner and the Run Record live under
`src/core/`, and the Node CLI runs any signed package in fixture or live mode. **The extension
itself still runs nothing**: running from the browser is T5.

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
   pick the default model (Ollama must run on this machine, started with `OLLAMA_ORIGINS`
   including `chrome-extension://*`; a remote Ollama endpoint is refused, since its models would
   not be local). Keys are typed once, stored in `chrome.storage.local`, never shown
   again and never synced. **Settings → Policies** selects the host preset (privacy first,
   balanced, convenience). **Your data** holds your records per type, with a one-click fictional
   demo set that is clearly labelled and never pre-filled.

Verification is the same as the Python reference runtime's (`agentpkg`): the core reports the
same digest, archive SHA-256, signer fingerprint and validity, and the browser summary equals
the Python control plane's output canonically for every shipped package. Authorization is
too: the receipt, the Run Plan, the host-resource, tool and model evaluations and the
preflight are compared field by field, and by hash, with records the Python control plane
produced for WebAir 0.4.0 (`test/fixtures/authorization/`). The documented differences are
the decision provenance, the denied-tool list, the model-availability check and the
local-only check of the privacy-first preset (D-053).

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
the signature report, the trust verdict, the browser summary).

`run` executes a signed `workflow.v0` package through the core's own execution layer, with
`agentpkg run`'s flags and report (D-064):

```sh
# Fixture mode: the package's own recorded answers, no network, no model; agentpkg's file set.
node dist/cli.js run ../dist/webair-0.4.0.agent.pkg --mode fixture \
  --grants ../examples/webair-0.2.0-grants.json \
  --approve-tool search-flights --approve-tool get-fare-rules \
  --out ../examples/my-run

# Live mode: a local Ollama model, the remote tools bound exactly as the Chrome host binds them.
node dist/cli.js run ../dist/webair-0.4.0.agent.pkg --mode live \
  --grants ../examples/webair-0.2.0-grants.json \
  --approve-tool search-flights --approve-tool get-fare-rules \
  --trust-key ../examples/keys/webair-publisher.pub.pem \
  --input ../examples/webair-input.json --model ollama/qwen3:30b \
  --out ../examples/my-live-run
node scripts/summarize-run.mjs ../examples/my-live-run
```

The operator is the host: the grants file is the receipt and each `--approve-tool` is one tool
approval (every other declared tool is denied and the runtime refuses to call it). `--limits F`
lowers the host execution limits (`total_tokens`, `max_remote_calls`, `max_parallel_workers`,
`max_output_tokens_per_call`, `run_timeout_seconds`, `max_calls_per_tool`,
`model_call_timeout_seconds`); without it the package's own budget and deadline apply. Live
mode binds `--model provider/model` (`ollama`, `openai`, `anthropic`) through the host's own
catalog probe, takes `--ollama-url` (loopback only), `--context-tokens`, `--think`,
`--tool-bindings F` (an operator bindings document for the remote tools), `--host-resources F`
with `--resource-grant PERMISSION=RESOURCE_ID`, reads keys from `OPENAI_API_KEY` /
`ANTHROPIC_API_KEY` only, and also writes `run.json`, the Run Record. A classified workflow
failure writes the artifacts and exits 2 with `agent-browser: workflow.v0 <code> at node <id>`.
The Chrome runner executes signed packages only.

`test/conformance/fixture-parity.test.ts` runs both CLIs on every shipped fixture and compares
the results under the rules of D-063; it needs `agentpkg/.venv/bin/agentpkg` (or `AGENTPKG_CLI`).

## Layout

| Path | Role |
|---|---|
| `src/core/` | The portable core: strict ZIP_STORED reader, strict JSON and RFC 8785, SHA-256 and Ed25519 through WebCrypto (pure-JS fallback), schema and semantic validation over agentpkg's own JSON Schemas, the trust store, discovery, the browser summary, profiles, the agent-page model; authorization (receipts, profile expansion, presets), host resources, host tools (the derived registry), model compatibility, Run Plans and their preflight, the personal vault, and the model catalog probes (`models/catalog.ts`). Execution (T4): `workflow/` (the `workflow.v0` interpreter and its mediator), `models/` (the bound router, the Ollama / OpenAI / Anthropic adapters over an injected transport, the built-in model contract), `tools/` (bindings, host definitions, the broker, the JSON-over-HTTPS and host-resource adapters, the egress guard), `execution/` (limits, policy, lease, runner, progress, report, artifacts, the `run.json` record). No Chrome, no DOM, no Node. |
| `src/core/schemas/` | Byte-for-byte copies of `agentpkg/src/agentpkg/schemas/*.json` and, under `extensions/`, of `spec/extensions/*.schema.json`, written by `npm run sync-schemas`; tests assert equality. |
| `src/extension/` | The Manifest V3 shell: `manifest.json`, the service worker (`background/`, the only place that holds state: sessions with their receipts and plans, the trust store, settings, keys, the vault, the model catalog), the content script (`content/`), the side panel, the full page (`browser/`), storage adapters (`storage/`), the message contract (`messages.ts`), the views (`ui/`: agent page, authorize view, settings, your data) and `data/demo-host-resources.json`, a copy of the demo host's resource definitions. |
| `src/cli.ts`, `src/cli-run.ts` | The Node CLI over the core; `run` (D-064) with the Node HTTP transport. |
| `scripts/` | `build.mjs` (esbuild), `pack.mjs`, `sync-schemas.mjs`, `make-icons.mjs`, `e2e-discovery.mjs`, `summarize-run.mjs` (one run directory as a summary JSON), and `make-authorization-fixtures.py`, which writes the Python control plane's reference records for `test/fixtures/authorization/` (run with `agentpkg/.venv/bin/python`). |
| `test/` | vitest: `core/` mirrors the Python suite's negative cases and asserts parity with the shipped packages (`core/workflow`, `core/models`, `core/tools`, `core/execution` port `test_workflow.py`, `test_runtime*.py`, the host-bridge, tool-bridge and execution suites); `conformance/` drives both CLIs; `extension/` covers the message contract, the controller, storage, the service worker over a fake `chrome`, the content script and the views. |

## The boundary rule

Nothing under `src/core` may depend on Chrome, the DOM or Node. Two checks enforce it:
`tsconfig.core.json` compiles the core with no DOM, Node or Chrome type library and only the
WHATWG globals `src/core/globals.d.ts` declares, so a `chrome` or `document` reference is a
compile error; and `test/core/boundary.test.ts` scans the source text for forbidden globals and
imports, so nothing can be smuggled past the compiler. The core imports exactly three runtime
dependencies: `@hyperjump/json-schema` (an interpreter, because Manifest V3 pages forbid `eval`),
`@hyperjump/browser` (its registry, to remove the remote `http`, `https` and `file` retrieval
schemes so a package schema can reach nothing) and `@noble/ed25519` (the fallback when WebCrypto
lacks Ed25519). The network reaches the core only through an injected `HttpTransport`.

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

- **Run from the browser.** The core executes (T4: the CLI runs any signed package in fixture
  or live mode, and the Ollama smoke in the T4 report ran WebAir's search from Node), but the
  extension does not yet start a run: the execution host in the service worker, the run surface,
  the lease wiring (`LeaseRegistry`, with `once` spent by the first lease) and the model
  connections are T5. In the extension a Run Plan is still a preflight artifact; Runs is a
  placeholder that shows the intended layout; Library lists the open sessions only.
- **Implement every local tool.** The host registry binds a generic HTTPS JSON adapter to each
  declared remote tool and a vault binding to each host-resource tool; other local tools
  (Literature Review's `paper-reader`) stay unbound until T6, and an approved unbound tool
  blocks the plan, as in the reference.
- **Classify addresses in the extension.** Package, site and tool URLs must be HTTPS on port
  443 with a DNS name (no IP literals, `localhost` or `.local`). The Node CLI goes further
  (`src/cli-net.ts`, D-067): it resolves every tool and model host, refuses any non-public address
  with the Python runtime's class names (loopback, private, link-local, multicast, reserved,
  cloud metadata, IPv4-mapped, 6to4, Teredo, NAT64), pins the connection to the address it
  classified, streams the body and stops at the byte cap. An extension has no resolver and no
  socket, so in Chrome those checks are the network stack's job, and the threat model will say
  so (T7).
- **Per-origin permissions.** The content script runs on every HTTPS page and reads only the
  advertised link elements; narrowing to opted-in origins is later hardening.
- Firefox, the Meeting Agenda UI path, search over an index, and policy subscriptions are in the
  backlog.

Nothing here contacts any network at install or start, carries no telemetry, and never messages
a web page.
