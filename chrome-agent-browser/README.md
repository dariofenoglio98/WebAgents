# Chrome Agent Browser

The second runtime of WebAgents: a Chrome extension that discovers, verifies, inspects and
**authorizes** signed `agent.pkg` packages that websites advertise, built on a portable
TypeScript core that runs in Node as well. The core **executes** `workflow.v0` packages (T4):
the interpreter, the model and tool adapters, the runner and the Run Record live under
`src/core/`, and the Node CLI runs any signed package in fixture or live mode. The extension
**runs them too** (T5): an authorized agent runs in an offscreen document's Worker with your own
model, your permissions and your records, and the run survives the side panel being closed.

What it shows today, on the WebAir demo site:

1. You visit a website. Its page carries `<link rel="agent-package" …>`. Click the WebAgents
   button (or use the page's context-menu item, or `Ctrl/⌘+Shift+Y`): the side panel opens and the
   extension reads that page's link elements, once, and nothing else (T16: it holds no website
   access until you grant some). **Always detect agents on this site** on the website card lets it
   read that site's pages from then on and show the badge there; Settings → Permissions → **Detect
   agents on every site** restores the passive badge everywhere, off by default.
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
   address bar and does the same without a tab. Its Open page starts like a search engine's start
   page: the "WebAgents" wordmark, one search box (words, `name@host`, a website or a package URL)
   and the agents open now; once results, a website, an agent or an error are shown it turns
   compact, a small wordmark beside the same box (T12; `scripts/screenshot-open-page.mjs` records
   both layouts at 1280 and 480 px in `examples/verification/chrome-open-page/`).
6. **Authorize in two clicks** (T3). Below the agent page, "Ways to use it" shows the publisher's
   profiles (WebAir declares *Search flights*, *Search and quote*, *Book (simulated)*) as cards
   with the title, the description, what each one *gets*, in plain words derived from the
   decisions it would yield, never from the publisher's text alone, and one estimate line. The
   agent page itself lists each profile's members only under Technical details (D-111). One summary card states what the agent will and will not be able
   to do, which of your records it may read (you choose which), the model and the preset; **Use
   this agent** records the decisions as an authorization receipt and prepares a Run Plan on your
   default model. **Customize your settings** expands the full per-item view: every permission
   with Deny / Allow once / Allow for session, every tool approval, the record chooser per type,
   the model picker with its compatibility verdicts (authorizing there binds the model you
   picked), the declared limits. Every decision records
   who made it (you, the profile, or the preset). **Ready to run** shows the plan with its id and
   hash under Technical details.
7. **Run** (T5). Above the agent page, the run surface shows a checklist (package verified,
   publisher trusted, permissions authorized, tools bound, model, your data selected, run plan
   ready and not stale, authorization outlasting the run deadline, task valid) and the task form
   built from the package's own input schema; Run is enabled only when every item holds, and it
   names the first that does not. A run executes in an **offscreen document's Worker** (D-070):
   closing the panel or the page does not touch it. A reopened side panel, or a full page opened
   without a session, asks the service worker for the run in flight (the one opened from the
   active tab's page first, else the most recent) and shows it again with Cancel; **Inspect**
   pressed again on the same page while that run is in flight returns the same session (D-076).
   Progress by
   stage and worker, model and tool calls, tokens; **Cancel** stops within one wave, is never
   lost (a cancel accepted before the Worker exists is stored and read when it starts), and a
   cancel no host can take interrupts the run (D-075). The result is
   the package's primary export as sanitized markdown, the artifacts (a count, **Inspect** for the
   per-file list, and **Download** for one `<run_id>.zip` of every file, each checked against the
   hash the run recorded, D-112), and Technical details (plan and input hashes, every model call on the planned model,
   tool bindings, permissions and who decided them, usage, cost, the audit chain, what was
   re-verified before the start). **Runs** lists every run this browser made, opens a past run
   read-only, exports a run directory as a zip and clears finished runs. A run whose host was
   unloaded (the browser restarted) is marked interrupted and never resumed (D-071).
8. **Settings → Models** connects the routes (D-023): Ollama on this machine (with the one-time
   `OLLAMA_ORIGINS` commands to copy, and a diagnosis that tells "not running" apart from
   "rejecting this extension's origin"), OpenAI and Anthropic with your own keys (typed once,
   encrypted at rest under your passphrase, never shown again, never sent anywhere but the
   provider), and Chrome's
   built-in model with its download state and, once Chrome reports it available, a model row
   with **Make default** (its context is the measured session quota; every row can state whether
   the model reasons, which a package requiring reasoning needs for the built-in model, D-113; the
   run honours the statement too, D-130).
   Each connection chip says when it was checked
   ("reachable · 4 models · checked 14:02:31"); opening the Models section clears the old answers
   and tests every enabled connection again. A provider that stops answering makes its models
   **not available**, with its address ("Ollama stopped answering at http://127.0.0.1:11434"),
   never "unverified"; preparing a plan re-reads the providers first, and the plan and Run
   messages point to Test connection (D-077). OpenAI's o-series, GPT-5 and GPT-6 families
   reason by default (`openai/gpt-5.6-luna`, `openai/gpt-6-astra`); a statement in Settings →
   Models overrides that either way (D-078). The OpenAI card has **Reasoning effort** (low,
   medium, high; default medium, recorded on every run, D-123): on low, models skipped work in
   Literature Review's copy-heavy steps. A hosted model the catalog has no context figure for
   (`openai/gpt-5.6-sol`) needs its context stated on its row before a plan can bind it. About holds the run limits and a **test mode**
   switch that records every outbound request body of a run for the privacy checks (D-028).
9. **Model limits, policies and your data.** Settings → Models lists the routes (local Ollama,
   OpenAI and Anthropic with your own keys, Chrome's built-in model), tests each connection, lets
   you state a model's limits and pick the default model (Ollama must run on this machine, started with `OLLAMA_ORIGINS`
   including `chrome-extension://*`; a remote Ollama endpoint is refused, since its models would
   not be local). Keys are typed once, stored in `chrome.storage.local`, never shown
   again and never synced. **Settings → Policies** selects the host preset (privacy first,
   balanced, convenience). **Memory** (T19) holds your records as a graph and a list: each record
   has a type, fields, a Markdown body, links and provenance; sealed values stay masked until you
   reveal one; the page exports and imports a folder of Markdown files (Obsidian opens it), and a
   one-click fictional demo set is clearly labelled and never pre-filled. After a run that proposed
   records, the run page asks you to accept, edit or reject each proposal.
   "Stop Ollama" in a walk-through means quitting the Ollama menu-bar app (or `pkill -x Ollama`):
   on macOS the app runs its own `ollama serve` and keeps answering on 11434 whatever a terminal
   does, so a chip that still says reachable after `ollama serve` was stopped in a terminal is
   right (Demo 3 rehearsal, F-05).
10. **Literature Review** (T6). The second package runs end to end: the host binds its three
   tools to its own implementations, never to anything the package ships: `scholarly-search` to
   a **Crossref** adapter (one `GET /works` with four host-named parameters, the reference's
   field selection and work-type filter, markup rendered exactly as the Citation Resolver renders
   it; at most one call at a time, one second after the previous call's start and its answer;
   D-081), `citation-resolver` to the generic JSON POST at the origin the package declares (a
   transient failure of either read is retried up to twice within the run's budgets, D-152; a
   package whose citation tool also declares `api.crossref.org` has a DOI looked up at Crossref
   when the resolver stays unavailable, D-153), and `paper-reader` to the **selected-PDF reader** (pdf.js in its own Worker per
   document, terminated when it answers or is stopped, under the reference parser's limits:
   20 MiB, 100 pages, 64 KiB of text per page, 256 KiB in all; D-082). Literature Review declares
   no profiles: **Use this agent** applies your preset; "metadata only" is one change under
   Customize your settings (`files.pdfs` → deny; D-080).
11. **Settings → Files** (T6, D-083): pick the PDFs an agent may read (the File System Access
   picker); each is copied into this browser once with its SHA-256, so a run reads exactly what
   you picked. The task form's documents field offers them by name; a run is given only the ones
   its task names, by an opaque `file_<id>`, and the audit records the read by that id and the
   hash, never a name or a folder. **Settings → Services**: an optional Crossref contact e-mail
   (Crossref's "polite pool"); none is sent unless you enter one, and whether one is set is part
   of what you approve (changing it makes prepared plans stale). **Settings → Policies → Run
   limits** (B-118, D-084): the bounds every run is held to, the reference's defaults (600 s,
   120,000 tokens, 32 remote calls) unless you change them; **Use the long-run limits** sets what
   the reference host used for Literature Review (4,500 s, 180,000 tokens, 45 remote calls,
   1,200 s per model call). A package's own budget still applies beneath them.
12. **Search, the Library and policies** (T8). **Settings → Search** adds a signed agent index by
   URL with its publisher's key ("Fill in the WebAgents demo index" fills both); the address bar
   then searches it when you type words or an agent name (`name@host`), and shows agent cards with
   the index as their source. **Open and verify** is the ordinary download and verification; what
   the index claimed (digest, signer) is compared with the bytes and shown, never obeyed. Results
   are ordered by whether you trust the claimed publisher key, then by the index's own order. An
   index is fetched only when you add it, check it, or search it after an hour. The **Library**
   lists agents you pinned and the ones you opened recently. **Settings → Policies → Policy
   subscription** follows one signed policy ("Fill in the example WebAgents research policy"): it
   trusts the publisher keys it anchors (your own pins decide first), pre-decides permissions by
   kind within the profile you pick and never above your preset's durations, caps run limits,
   can restrict models and services, and names itself on every decision it made; change any of
   them under Customize your settings and it is recorded as yours. Unsubscribing withdraws its
   trust and makes plans made under it stale. Formats: `spec/extensions/agent-index-v0.md`,
   `policy-bundle-v0.md`, `signed-document-v0.md`; publisher tool: `node dist/cli.js document
   sign|verify`.
12. **Least privilege** (T16, D-182, D-190, D-193). The manifest holds no website access: Chrome
   grants an origin only when you allow it, with your click as the gesture. Opening a package asks
   for its origin; **Use this agent**, **Authorize** and **Prepare run plan** ask for exactly the
   origins the plan needs (the package's own, the services its approved tools declare, the model
   provider you chose) and the plan lists them under Technical details with whether each is
   granted; a refusal names the origin and offers **Allow**. A run can reach only the origins its
   plan recorded, Chrome enforcing beneath the extension's own checks. Settings → Permissions lists
   every grant with its reason and **Revoke**s it; a plan that needs a revoked origin blocks Run by
   name until you allow it again.
13. **Your keys and records, encrypted** (T16, D-191, D-192). Settings → Security sets a
   passphrase; from then on your provider keys and your records are kept only in an encrypted
   store (scrypt, AES-256-GCM), unlocked for the browser session and locked again after the idle
   time you choose (5, 15 or 60 minutes, or until the browser closes), with **Lock now** in the
   nav. Nothing secret is saved until a passphrase exists; what the previous version kept in clear
   is moved into the store the moment you set one. An agent that needs nothing from the store
   (Literature Review on Ollama) runs while it is locked; one that needs a hosted key or one of
   your records asks you to unlock before it prepares or runs, never during a run. **Forget
   everything** deletes the store when a passphrase is lost: agents, runs, trust and settings stay.
14. **Unlock with the macOS keychain** (T17, optional). With the helper from the macOS installer
   ([`installer/README.md`](../installer/README.md)), Settings → Security → **Turn on** keeps the
   store's key wrapped by your login keychain, and the Unlock sheet then unlocks with one click.
   The passphrase keeps working; without the helper nothing changes. Every unpacked build has the
   id `kjegegjdnpdcjhgamhjdphgemegefapb` (the manifest's `key`, D-200), the one the helper answers.

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
archive written by the script itself; no system `zip` is needed) and beside it
`chrome-agent-browser-<version>.contents.txt`, the SHA-256 and size of every member and of the zip.
The build puts `LICENSE.txt` and `THIRD_PARTY_NOTICES.txt` (the license of every bundled package,
read from esbuild's metafile) into the extension; `npm run check-pack` verifies the file set, the
manifest version, the listing and the notices. Design, storage, permissions and limits:
[docs/chrome-agent-browser.md](../docs/chrome-agent-browser.md).

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

`node dist/cli.js pdf-text <document.pdf>` runs the paper reader's parser over one PDF and prints
`{pages, sha256, source}` (status 0) or `{"error": reason}` (status 3), the counterpart of
`agentpkg host-pdf-read`.

`test/conformance/fixture-parity.test.ts` runs both CLIs on every shipped fixture and compares
the results under the rules of D-063; it needs `agentpkg/.venv/bin/agentpkg` (or `AGENTPKG_CLI`).
The full cross-runtime suite, with the negative cases and the control-plane scenarios, is
[`../conformance/`](../conformance/README.md) (`node conformance/run.mjs` from the repository root).

## Layout

| Path | Role |
|---|---|
| `src/core/` | The portable core: strict ZIP_STORED reader, strict JSON and RFC 8785, SHA-256 and Ed25519 through WebCrypto (pure-JS fallback), schema and semantic validation over agentpkg's own JSON Schemas, the trust store, discovery, the browser summary, profiles, the agent-page model; authorization (receipts, profile expansion, presets), host resources, host tools (the derived registry), model compatibility, Run Plans and their preflight, the personal vault, and the model catalog probes (`models/catalog.ts`). Execution (T4): `workflow/` (the `workflow.v0` interpreter and its mediator), `models/` (the bound router, the Ollama / OpenAI / Anthropic adapters over an injected transport, the built-in model contract), `tools/` (bindings, host definitions, the broker, the JSON-over-HTTPS and host-resource adapters, the egress guard), `execution/` (limits, policy, lease, runner, progress, report, artifacts, the `run.json` record). No Chrome, no DOM, no Node. |
| `src/core/schemas/` | Byte-for-byte copies of `agentpkg/src/agentpkg/schemas/*.json` and, under `extensions/`, of `spec/extensions/*.schema.json`, written by `npm run sync-schemas`; tests assert equality. |
| `src/extension/` | The Manifest V3 shell: `manifest.json`, the service worker (`background/`, the only place that holds state: sessions with their receipts and plans, the trust store, settings, keys, the vault, the model catalog), the content script (`content/`), the side panel, the full page (`browser/`), storage adapters (`storage/`), the message contract (`messages.ts`), the views (`ui/`: agent page, authorize view, settings, your data) and `data/demo-host-resources.json`, a copy of the demo host's resource definitions. |
| `src/cli.ts`, `src/cli-run.ts` | The Node CLI over the core; `run` (D-064) with the Node HTTP transport. |
| `scripts/` | `build.mjs` (esbuild), `pack.mjs`, `sync-schemas.mjs`, `make-icons.mjs`, `e2e-discovery.mjs`, `e2e-webair-live.mjs`, `e2e-paper-reader.mjs`, `e2e-literature-live.mjs`, `e2e-compute.mjs`, `e2e-conversation.mjs` (T24: a two-turn conversation with the ticket-desk probe in headless Chrome, the card answered through the extension's messages, a scripted Ollama on a loopback port), `summarize-run.mjs` (one run directory as a summary JSON), `make-crossref-reference.mjs` and `make-pdf-text-vectors.py` (the reference answers the Crossref adapter and the PDF reader are held to), and `make-authorization-fixtures.py`, which writes the Python control plane's reference records for `test/fixtures/authorization/` (run with `agentpkg/.venv/bin/python`). |
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
node scripts/e2e-webair-live.mjs --model ollama/qwen3:30b   # the live acceptance: real Chrome, the public origin, real runs
agentpkg/.venv/bin/python ../scripts/verify_chrome_webair_live.py   # recompute its checks over the exported runs
node scripts/e2e-paper-reader.mjs      # a picked PDF read by a run in headless Chrome (no model call)
node scripts/e2e-conversation.mjs      # a two-turn conversation with a consent card in headless Chrome (no network: a scripted Ollama, a local desk origin)
node scripts/e2e-network.mjs           # the signed travel network (network.v0) in headless Chrome, fixture mode (a fake WebAir origin, a scripted Ollama)
agentpkg/.venv/bin/python ../scripts/verify_chrome_conversation.py   # recompute its checks over the exported conversation
node scripts/e2e-literature-live.mjs --model openai/gpt-5.6-luna   # Literature Review live: real Chrome, Crossref, the resolver
agentpkg/.venv/bin/python ../scripts/verify_chrome_literature_live.py  # recompute its checks, grounding included
node scripts/measure-execution-host.mjs --minutes 30        # the D-027 host measurement (headed Chrome)
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

The live harness (`scripts/e2e-webair-live.mjs`, T5) drives the full page in the same way
against the **public** WebAir origin with a model you name (`ollama/…` is free; `openai/…` and
`anthropic/…` read the key from `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` and type it into the
throwaway profile's storage): discovery, trust, "Search flights" and a run (the page is reloaded
mid-run and must adopt it), a cancelled search, "Search and quote" with the fictional demo
passenger, "Book (simulated)" with a purchase granted once, the replay the page and the worker
refuse, and a purchase denied without the grant. Every run is exported (run.json, run-plan.json,
input.json, the artifacts, observations.json from test mode) under `examples/my-chrome-live-*/`,
and `scripts/verify_chrome_webair_live.py` recomputes the checks: audit chains, the planned model,
privacy (no sealed value in any model request; the identity only in `prepare_booking`, the payment
identifier only in `simulate_purchase`), once spent, denial. The recorded evidence is
`examples/verification/chrome-webair-040-live.json`. A failed harness attempt never replaces a report that passed (it is written beside its run directories), and the verifier refuses to write when the exported run directories are missing, so the committed evidence is never overwritten by a run that did not happen here.

The conversation check (`scripts/e2e-conversation.mjs`, T24) builds the ticket-desk probe with its
order tool remote (`agentpkg/tests/conversation_probe.py`), signs it under a throwaway key, serves
it from a local HTTPS origin that also answers the desk's `POST /api/orders`, points the extension's
Ollama connection at a scripted server on a loopback port, and holds a conversation through the
extension's own messages, as the chat panel does: `conversation.start`, "order A", the turn waits
on the consent card (`confirm`, a `payment` kind, never pre-decided), the harness answers Yes with
`conversation.decide`, the order is placed, "done" ends the conversation by the package's rule, and
the export (D-272) is written with each turn's recorded requests. `scripts/verify_chrome_conversation.py`
recomputes 28 checks over the export: the transcript against the contract, one chain across the
turns and each turn's slice, every decision hashed in the audit as the person saw it, the card
before the decision, the observer's requests to the two fakes only, the spent `once` grant, and the
reference's fixture replay equal turn for turn. The evidence is
`examples/verification/chrome-conversation-e2e-t24.json`.

The paper-reader check (`scripts/e2e-paper-reader.mjs`, T6) builds the reader test package
(`test/fixtures/reader-package/`, one `paper.read` call and no model call) with agentpkg, signs
it under a throwaway key, serves it from the same kind of local HTTPS origin, picks the probe PDF
into Settings → Files and runs it: the parser Worker loads under the extension's CSP, the run's
Worker reads the stored copy through a nested parser Worker, the audit names the file by opaque id
and hash, and a task naming an unknown file or a denied `files.pdfs` is refused. It needs a local
Ollama model for the plan to bind (never called); the evidence is
`examples/verification/chrome-paper-reader-e2e.json`.

The Literature Review harness (`scripts/e2e-literature-live.mjs`, T6) serves the signed 0.2.5
from a local HTTPS origin and runs it with the model you name against the real Crossref API and
the hosted Citation Resolver: settings (test mode, the long-run limits, `--crossref-contact` only
if you pass one), open, trust, **Use this agent**, the question from
`examples/literature-review-live-input.json` (and `--document DOI=/path.pdf` for a picked paper),
Run, the page reloaded mid-run, the run followed to its end. It exports the run with
`observations.json` and `documents.json` (each picked PDF's text from `dist/cli.js pdf-text`) under
`examples/my-chrome-lit-*/`; `scripts/verify_chrome_literature_live.py` recomputes the record and
the chain, the bindings, Crossref's request shape and pacing, the documents read by opaque id, the
limits, and the reference driver's grounding checks. The evidence is
`examples/verification/chrome-literature-review-live.json` (hosted model) and
`examples/verification/chrome-literature-review-live-local.json` (`ollama/qwen3:30b` with
`--think`; its duration, usage, claims and checks are in that file).

## What it does not do yet

- **The built-in model live.** Gemini Nano is wired, can be made the default and is unit-tested
  over a stubbed Prompt API (a whole WebAir run included), but has not completed a live run:
  headless Chrome reports it `downloadable` on a fresh profile (B-119). The first live attempt
  (2026-10-09) stopped at start with `execution_model_incompatible` although "Reasons: yes" was
  stated; fixed in T11 (D-130), and the person's walk-through is T11's User run.
- **Implement every local tool, or any GET service.** The host binds a generic HTTPS JSON POST to
  each declared remote POST tool, its Crossref adapter to `scholarly.search` at Crossref's works
  endpoint, its PDF reader to `paper.read` and a vault binding to each host-resource tool; any
  other local tool, and a remote GET no service adapter serves, stays unbound, and an approved
  unbound tool blocks the plan, as in the reference. Scholarly search is Crossref only (B-53).
- **Pace a service across concurrent runs.** Each run's Worker paces its own calls; two runs of
  different packages at once could each call Crossref once a second (BACKLOG).
- **Classify addresses in the extension.** Package, site and tool URLs must be HTTPS on port
  443 with a DNS name (no IP literals, `localhost` or `.local`). The Node CLI goes further
  (`src/cli-net.ts`, D-067): it resolves every tool and model host, refuses any non-public address
  with the Python runtime's class names (loopback, private, link-local, multicast, reserved,
  cloud metadata, IPv4-mapped, 6to4, Teredo, NAT64), pins the connection to the address it
  classified, streams the body and stops at the byte cap. An extension has no resolver and no
  socket, so in Chrome those checks are the network stack's job
  ([threat model](../docs/threat-model.md#chrome-agent-browser-t7)).
- **Per-origin permissions.** The content script runs on every HTTPS page and reads only the
  advertised link elements; narrowing to opted-in origins is later hardening.
- Firefox and the Meeting Agenda UI path are in the backlog. NANDA resolution is a stub: the
  mapping from AgentAddr and AgentFacts to a package is defined (`src/core/resolve/nanda.ts`), but
  no registry is configured and AgentAddr signatures are not verified. A policy's issuer anchors are
  shown and not applied (no credential format yet), and one policy can be followed at a time.

Nothing here contacts any network at install or start, carries no telemetry, and never messages
a web page.
