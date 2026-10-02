# Getting started

This guide installs WebAgents from a fresh checkout. It has three levels, and each one works on
its own:

1. **Offline CLI** — install `agentpkg`, verify the signed example packages, and run them in
   deterministic fixture mode. No OpenClaw, no model, no network. About five minutes.
2. **Agent Browser** — build and install the OpenClaw plugin, then open, inspect and authorize a
   package from the OpenClaw Control UI.
3. **Live runs** — bind a real model (local Ollama or a hosted OpenAI model) and run a package from
   the browser. The Literature Review package also calls live scholarly services.

All commands run from the repository root unless a `cd` is shown. `$PWD`-based commands make
absolute paths for your own checkout.

## Requirements

| Component | Needed for | Tested with | Notes |
|---|---|---|---|
| Python ≥ 3.11 | everything | 3.13.5 | `agentpkg` dependencies: `jsonschema`, `cryptography`, `pypdf`, `rfc8785` |
| Node ≥ 20 and npm | building the plugin | Node 26.9.0 | only needed to build, test and pack `openclaw-agent-browser` |
| OpenClaw **2026.9.5** | Agent Browser, live runs | 2026.9.5 (`ec9c1a1`) | the plugin APIs are experimental; execution refuses another OpenClaw release unless you opt out (see below) |
| Ollama | optional, local models | 0.34.0, `qwen3:30b` | the recorded local runs used Apple M3 Max, 36 GB |
| OpenAI account in OpenClaw | optional, hosted models | `openai/gpt-5.6-luna` | configured as an OpenClaw provider; WebAgents never sees the credential |

The prototype was developed and tested on macOS (Apple Silicon). The Python package and tests are
platform-neutral; the browser plugin has only been exercised on macOS.

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

Test suites:

```sh
agentpkg/.venv/bin/python -m pytest agentpkg/tests
agentpkg/.venv/bin/python -m ruff check agentpkg
agentpkg/.venv/bin/python scripts/verify_workflow.py
agentpkg/.venv/bin/python scripts/verify_browser.py
```

## 2. Agent Browser (OpenClaw plugin)

Install OpenClaw 2026.9.5 and start its Gateway (`openclaw gateway status` should report
*running*). Then build, test and install the plugin:

```sh
cd openclaw-agent-browser
npm install
npm run typecheck
npm test
npm run build
npm run validate
npm run pack                       # -> agent-browser.tgz (never overwrites: delete an old one first)
openclaw plugins install ./agent-browser.tgz --accept-capabilities
cd ..
```

Install the packed `.tgz`, not the directory: a directory install also scans this project's
`node_modules`, which contains OpenClaw's own bundled plugins. `npm run verify` runs the whole
chain against a throwaway OpenClaw configuration without touching yours.

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
| Citation Resolver (`webagents-citation-resolver-production.up.railway.app`) | `citation-resolver` | a small FastAPI service in [`citation-resolver/`](../citation-resolver/README.md), hosted by the authors with **no availability guarantee** |
| Selected PDFs | `paper-reader` | only files the operator selects under `localFiles.roots`; the package sees opaque ids, never paths |

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
is a minimal static origin that serves `literature-review-0.2.5.agent.pkg` and checks its SHA-256 at
startup:

```sh
PORT=8080 python3 package-origin/server.py      # plain HTTP; deploy behind TLS (see its Dockerfile)
```

It serves plain HTTP on `$PORT`. To open it from the page, deploy it behind an HTTPS front end, for
example a container platform that terminates TLS. A localhost origin is refused by design.

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| *Control plane unavailable* | `agentpkgPath` is wrong or not absolute; press **Retry** after fixing it |
| page behaves like old code after changing `agentpkg` | the running control plane keeps the code it started with: `openclaw gateway restart` |
| a model shows *Incompatible* | the host reports a smaller context or output limit than the package requires (see the Ollama note) |
| Run stays disabled | the checklist names the reason, e.g. a denied permission, an expired authorization, or a missing tool approval |
| run refused on start: host runtime | OpenClaw is not 2026.9.5; see `requireVerifiedHostRuntime` above |
