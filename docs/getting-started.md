# Getting started

This guide installs WebAgents from a fresh checkout. It has four levels, and each one works on
its own:

1. **Offline CLI** — install `agentpkg`, verify the signed example packages, and run them in
   deterministic fixture mode. No OpenClaw, no model, no network. About five minutes.
2. **Agent Browser** — build and install the OpenClaw plugin, then open, inspect and authorize a
   package from the OpenClaw Control UI.
3. **Live runs** — bind a real model (local Ollama or a hosted OpenAI model) and run a package from
   the browser. The Literature Review package also calls live scholarly services.
4. **Chrome Agent Browser** — build the Chrome extension, the second runtime, and discover,
   authorize and run packages in Chrome with your own model; no OpenClaw or Python needed
   ([§6](#6-chrome-agent-browser-level-4)).

All commands run from the repository root unless a `cd` is shown. `$PWD`-based commands make
absolute paths for your own checkout.

## Requirements

| Component | Needed for | Tested with | Notes |
|---|---|---|---|
| Python 3.11 ≥ 3.11.10, 3.12 ≥ 3.12.4, or 3.13 | everything | 3.13.5; CI also 3.11 (Linux) and 3.12 (macOS) | `agentpkg` dependencies: `jsonschema`, `cryptography`, `pypdf`, `rfc8785`. The URL policy relies on the standard library's `ipaddress` classification. Older patch releases lack CPython's CVE-2024-4032 fix and treat most of `192.0.0.0/24` as public. python.org ships no macOS installer after 3.11.9, so on macOS use 3.12 or 3.13, or a 3.11 from Homebrew or uv. The test suite expects the classification of current patch releases (3.11.14, 3.12.10, 3.13) |
| Node 24 (≥ 24.16) or ≥ 26.1, and npm | building the plugin | Node 26.9.0 | the range the pinned `openclaw` devDependency declares; only needed to build, test and pack `openclaw-agent-browser` |
| OpenClaw **2026.9.5** | Agent Browser, live runs | 2026.9.5 (`ec9c1a1`) | the plugin APIs are experimental; execution refuses another OpenClaw release unless you opt out (see below) |
| Ollama | optional, local models | 0.34.0, `qwen3:30b` | the recorded local runs used Apple M3 Max, 36 GB |
| Google Chrome 137 or newer | the Chrome Agent Browser (level 4) | Chrome 154 | Ed25519 in WebCrypto arrived in Chrome 137; building the extension needs the same Node as the plugin |
| OpenAI account in OpenClaw | optional, hosted models | `openai/gpt-5.6-luna` | configured as an OpenClaw provider; WebAgents never sees the credential |

The prototype was developed on macOS (Apple Silicon), and every recorded live run was made there.
[Continuous integration](../.github/workflows/ci.yml) also runs the Python and plugin test suites,
the offline package verification, the plugin build/validate/pack and the Citation Resolver tests on
Ubuntu Linux. Linux is therefore covered by tests, but no live Agent Browser run on a Linux
OpenClaw host has been accepted. Windows is not supported.

## 1. Offline CLI

```sh
python3 -m venv agentpkg/.venv
agentpkg/.venv/bin/python -m pip install -e './agentpkg[dev]'   # or: pip install dist/agentpkg-0.2.2-py3-none-any.whl
agentpkg/.venv/bin/agentpkg --version                            # agentpkg 0.2.2 (agent.pkg 0.1, workflow.v0)
```

Verify both shipped packages against their publisher keys. A valid result reports the package
digest and the signer fingerprint (`sha256:2bcc374a…c5c4` for Meeting Agenda,
`sha256:c5ca9763…5232` for Literature Review):

```sh
agentpkg/.venv/bin/agentpkg verify dist/meeting-agenda.agent.pkg \
  --trust-key examples/keys/meeting-agenda-publisher.pub.pem
agentpkg/.venv/bin/agentpkg verify dist/literature-review.agent.pkg \
  --trust-key examples/keys/literature-review-publisher.pub.pem
agentpkg/.venv/bin/agentpkg inspect dist/meeting-agenda.agent.pkg   # metadata, permissions, tools, budgets
```

Run each package in fixture mode. Fixture mode replays package-owned, exact-input model and tool
responses: it performs no network access and no inference, and reports synthetic usage. It
exercises the real interpreter, permissions, budgets, validation and audit.

```sh
agentpkg/.venv/bin/agentpkg run dist/meeting-agenda.agent.pkg \
  --mode fixture --grants examples/meeting-agenda-grants.json \
  --out examples/my-agenda

agentpkg/.venv/bin/agentpkg run dist/literature-review.agent.pkg \
  --mode fixture --grants examples/literature-review-grants.json \
  --approve-tool scholarly-search --approve-tool citation-resolver --approve-tool paper-reader \
  --out examples/my-review
```

`--out` must name a new directory (`examples/my-*` is git-ignored). Each declared tool needs an
`--approve-tool` in addition to its permission grant: a grant describes a class of authority, an
approval names one tool. The outputs are `result.json`, `audit.json`, `usage.json`,
`provenance.json` and the package's declared exports (`agenda.json`; or `related-work.md`,
`bibliography.json`, `evidence-table.json`, `unresolved.json`, `verification.json`).

Test suites and offline acceptance checks:

```sh
agentpkg/.venv/bin/python -m pytest agentpkg/tests
agentpkg/.venv/bin/python -m ruff check agentpkg
agentpkg/.venv/bin/python -m ruff format --check agentpkg
agentpkg/.venv/bin/python scripts/verify_workflow.py         # both packages, fixture mode
agentpkg/.venv/bin/python scripts/verify_browser.py          # control plane, no execution
agentpkg/.venv/bin/python scripts/verify_literature_025.py   # current Literature Review
agentpkg/.venv/bin/python scripts/check_release.py           # package identities and dist/ hashes
```

None of these needs a model, a credential, OpenClaw or network access.

## 2. Agent Browser (OpenClaw plugin)

Install OpenClaw 2026.9.5 and start its Gateway (`openclaw gateway status` should report
*running*). Then build, test and install the plugin:

```sh
cd openclaw-agent-browser
npm ci                             # exact versions from package-lock.json
npm run typecheck
npm test
npm run build
npm run validate
npm run pack                       # -> agent-browser.tgz (never overwrites: delete an old one first)
openclaw plugins install ./agent-browser.tgz --accept-capabilities
cd ..
```

Install the packed `.tgz`, not the directory: a directory install also scans this project's
`node_modules`, which contains OpenClaw's own bundled plugins. `npm test` drives a real control
plane and runner through `agentpkg/.venv/bin/agentpkg` from section 1. `npm run verify` runs the
whole chain with the pinned OpenClaw devDependency and installs into a throwaway OpenClaw
configuration and state directory, not yours; it needs no global OpenClaw.

Configure the plugin. The heredoc below expands `$PWD`, so run it from the repository root:

```sh
openclaw config patch --stdin <<JSON
{
  "plugins": { "entries": { "agent-browser": {
    "enabled": true,
    "llm": { "allowModelOverride": true },
    "config": {
      "agentpkgPath": "$PWD/agentpkg/.venv/bin/agentpkg",
      "localPackages": { "roots": ["$PWD/dist"] },
      "localFiles": { "roots": ["$PWD/examples/probe-files"] },
      "sessionTtlSeconds": 7200,
      "execution": {
        "totalTokens": 180000, "maxRemoteCalls": 45, "maxParallelWorkers": 3,
        "maxOutputTokensPerCall": 16000, "runTimeoutSeconds": 4500,
        "modelCallTimeoutSeconds": 1200
      }
    }
  } } },
  "gateway": { "controlUi": { "experimental": { "customPlugins": true } } }
}
JSON
openclaw gateway restart
```

| Setting | Why |
|---|---|
| `agentpkgPath` | the plugin supervises `agentpkg browser-serve`; it keeps the control-plane token in the Gateway process |
| `localPackages.roots` | directories the page may open `.agent.pkg` files from |
| `localFiles.roots` | directories an operator may select PDFs from (the Literature Review `paper-reader` tool); omit to disable |
| `llm.allowModelOverride` | binding an exact model is an OpenClaw privilege; without it model-bound operations are refused |
| `sessionTtlSeconds`, `execution.*` | the bounds used for the recorded local Literature Review runs; host bounds can only lower what a package declares, and a run starts only if the authorization outlasts `runTimeoutSeconds` + 60 s. The defaults (900 s session) suffice for Meeting Agenda |
| `customPlugins` | native plugin UI is an experimental OpenClaw lab, off by default (also **Settings → Labs → Custom plugin UI**) |

Execution checks that OpenClaw reports exactly the verified release (2026.9.5). On another release,
re-test and then set `plugins.entries.agent-browser.config.execution.requireVerifiedHostRuntime` to
`false` to opt out. Every other plugin setting is documented in the
[plugin README](../openclaw-agent-browser/README.md#configure).

Open the page with `openclaw dashboard` and choose **Agent Browser** in the sidebar. The header
should read *Control plane running*. Open `<repo>/dist/meeting-agenda.agent.pkg` from *Open a local
package*, where `<repo>` is the absolute path of this checkout.

**Publisher trust.** A valid signature is not trust. The first time, the page shows *Unknown
publisher*: use *Review publisher key* → *Trust this publisher key* (press twice to confirm). The
fingerprint must match the one printed by `agentpkg verify` above. Each package has its own key,
pinned for its own package-id prefix.

## 3. Models

The page lists only models the OpenClaw host itself reports, with a compatibility verdict against
the package's declared requirements. Nothing is preselected. Configure models in OpenClaw; no
credential is ever given to WebAgents or stored in a package.

### Local: Ollama

```sh
ollama pull qwen3:30b
```

Meeting Agenda runs on OpenClaw's discovered Ollama models. The Literature Review runs reserve up
to 65,536 tokens of context for their heaviest calls, but OpenClaw caps *discovered* local models at
32,768. The recorded runs therefore used an explicit `models.providers.ollama.models` list in which
`qwen3:30b` has `contextTokens: 65536` and `maxTokens: 16384`:

```json5
{ models: { providers: { ollama: {
  baseUrl: "http://127.0.0.1:11434", api: "ollama",
  models: [{
    id: "qwen3:30b", name: "qwen3:30b", reasoning: true, input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 262144, contextTokens: 65536, maxTokens: 16384,
    compat: { supportsUsageInStreaming: true, supportsTools: true, supportsJsonSchemaResponseFormat: true },
    api: "ollama"
  }]
} } } }
```

An explicit list **replaces** discovery for that provider, so list every Ollama model you want
OpenClaw to keep using. Keep the provider id `ollama`: a custom provider id with `api: "ollama"`
is listed by OpenClaw 2026.9.5 but cannot be called. To return to discovery:
`openclaw config unset models.providers.ollama.models`.

Local runs are slow. With one Ollama slot (`OLLAMA_NUM_PARALLEL=1`), parallel workers' model calls
decode one after another. The recorded runs took about 2.5 minutes for Meeting Agenda and about
25 minutes for Literature Review.

### Hosted: OpenAI through OpenClaw

Configure an OpenAI provider in OpenClaw as you normally would. The recorded hosted runs used
`openai/gpt-5.6-luna` signed in with `openclaw models auth login --provider openai`. Other providers
that OpenClaw reports should work, subject to the package's compatibility checks, but only these two
routes were tested. On the tested OpenAI route, OpenClaw did not visibly constrain structured output.
That does not affect correctness, because WebAgents validates every structured model output against
the package schema before accepting it.

## 4. External services used by Literature Review (live mode)

| Service | Used by | Notes |
|---|---|---|
| Crossref REST API (`api.crossref.org`) | `scholarly-search` host adapter | public API; the adapter sends at most one request at a time, ≥ 1 s apart; coverage of recent AI topics is thin, so a run may include only a few papers |
| Citation Resolver (`webagents-citation-resolver-production.up.railway.app`) | `citation-resolver` | a small FastAPI service in [`citation-resolver/`](../citation-resolver/README.md), hosted by the authors as an external research/demo dependency with **no availability guarantee** |
| Selected PDFs | `paper-reader` | only files the operator selects under `localFiles.roots`; the package sees opaque ids, never paths |

Both services are outside this repository's control. Their availability, rate limits and
coverage decide whether a **live** Literature Review run completes and how much it finds. They do
not affect fixture-mode runs, the offline verification scripts, the test suites or CI, which
replay recorded or synthetic answers and never contact them.

The resolver origin is declared in the **signed** package manifest. A host can tighten or relabel
the binding, but it cannot point it at a domain the package did not declare. If the hosted resolver
is unavailable, run [`citation-resolver/`](../citation-resolver/README.md) yourself over HTTPS. Then
rebuild the package from [`agents/literature-review/`](../agents/literature-review/) with your origin
in `tools/citation-resolver.tool.json`, and sign it with your own key (`agentpkg keygen`,
`agentpkg build`, `agentpkg sign`). The result is a different package with a different publisher,
pinned separately.

Meeting Agenda uses no tools and no network apart from the model.

## 5. Opening a package by URL (optional)

The Agent Browser also opens packages from HTTPS URLs. It accepts only HTTPS, no redirects and
no private-network destinations, and bounds the download size. [`package-origin/`](../package-origin/)
is a minimal static origin that serves `literature-review-0.2.5.agent.pkg` (and, at
`/packages/literature-review-0.2.6.agent.pkg`, the 0.2.6 that the demo index lists) and checks each
SHA-256 at startup:

```sh
PORT=8080 python3 package-origin/server.py      # plain HTTP; deploy behind TLS (see its Dockerfile)
```

It serves plain HTTP on `$PORT`. To open it from the page, deploy it behind an HTTPS front end, for
example a container platform that terminates TLS. A localhost origin is refused by design.

The address bar also takes a website's address. The control plane then reads that one page, under
the same policy, for an experimental `<link rel="agent-package" href="…">` in its head, and the page
lists what it found as unverified addresses; **Inspect** opens one exactly as if you had typed it.
Only packages on the page's own origin are offered
([details](browser-control-plane.md#3a-website-discovery)).

## 6. Chrome Agent Browser (level 4)

The Chrome Agent Browser is a Manifest V3 extension over a TypeScript port of the runtime
([design](chrome-agent-browser.md), [user guide](../chrome-agent-browser/README.md)). It needs Node
to build and Chrome to run; it does not use OpenClaw, Python or the control plane.

```sh
cd chrome-agent-browser
npm ci
npm run typecheck && npm test      # optional; the fixture-parity test also needs agentpkg/.venv (level 1)
npm run build                      # dist/extension/ (the extension) and dist/cli.js (the Node CLI)
npm run pack && npm run check-pack # optional: the zip a store upload would use, and its checks
```

**Load it.** In Chrome open `chrome://extensions`, enable **Developer mode**, choose **Load
unpacked** and select `chrome-agent-browser/dist/extension`. Pin the WebAgents action.

**Connect a model.** Open the extension's full page (the action's side panel links to it) →
Settings → Models.

- *Ollama on this machine.* Chrome extensions are a different origin from the ones Ollama allows by
  default, so start Ollama with `OLLAMA_ORIGINS="chrome-extension://*"`. For the macOS app:
  `launchctl setenv OLLAMA_ORIGINS "chrome-extension://*"`, then quit and reopen Ollama. Settings
  shows the exact commands and tells *not running* apart from *rejecting this extension*. Only
  `127.0.0.1` and `localhost` are accepted. The context note of §3 applies: Settings → Models lets
  you state a larger context for a model whose window Ollama reports.
- *OpenAI or Anthropic.* Type your own API key. It is stored in this Chrome profile
  (`chrome.storage.local`), never shown again, never synced, and sent only to that provider.

**Use it.** Visit `https://webagents-webair-production.up.railway.app/`: the badge shows the number
of advertised packages; the side panel lists them; **Inspect** verifies one; **Trust this publisher
key**; choose *Search flights* and **Use this agent**; type a request and **Run**. The extension
opens packages only over HTTPS, so Literature Review needs an origin that serves it, such as
[`package-origin/`](../package-origin/) behind TLS (§5); type its package URL into the full page's
address bar. (The Chrome harness `scripts/e2e-literature-live.mjs` serves it from a local HTTPS
origin under a throwaway certificate instead.) For a long run choose Settings → Policies → Run
limits → **Use the long-run limits**, and pick the PDFs a run may read under Settings → Files.

**From a terminal.** `node dist/cli.js verify | inspect | evaluate | run` takes `agentpkg`'s
flags; `run --mode fixture` needs nothing else, `run --mode live --model ollama/qwen3:30b` a local
model ([CLI reference](../chrome-agent-browser/README.md#the-node-cli)).

**Compare the two runtimes.** With level 1 installed and the core built:

```sh
node conformance/run.mjs      # from the repository root; no network, model or key
```

It prints one line per case and writes `conformance/results/<timestamp>/report.md`
([what it compares](../conformance/README.md)).

| Symptom (Chrome) | Likely cause |
|---|---|
| Settings → Models: Ollama *rejecting this extension* | `OLLAMA_ORIGINS` does not include `chrome-extension://*`, or Ollama was not restarted after setting it |
| a model shows *not available* | its provider stopped answering; Test connection names the address that failed |
| **Run** stays disabled | the checklist above it names the first item that does not hold |
| a run shows *interrupted* | the browser was closed or restarted while it ran; runs never resume, start it again |

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| *Control plane unavailable* | `agentpkgPath` is wrong or not absolute; press **Retry** after fixing it |
| page behaves like old code after changing `agentpkg` | the running control plane keeps the code it started with: `openclaw gateway restart` |
| a model shows *Incompatible* | the host reports a smaller context or output limit than the package requires (see the Ollama note) |
| Run stays disabled | the checklist names the reason, e.g. a denied permission, an expired authorization, or a missing tool approval |
| run refused on start: host runtime | OpenClaw is not 2026.9.5; see `requireVerifiedHostRuntime` above |
