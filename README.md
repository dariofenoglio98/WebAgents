# WebAgents

**Unbundling agent creation, hosting and execution for an agent-native web.**

WebAgents is a research prototype. A creator publishes an agent as a signed, inspectable
package, an origin hosts it, and the *user's own runtime* verifies it and executes it with the
user's models, tools, permissions and budgets. Publishing an agent does not mean paying for or
controlling every run of it. Running an agent does not mean handing a publisher your credentials.

It accompanies the paper *WebAgents: Unbundling Agent Creation, Hosting, and Execution for an
Agent-Native Web* (citation below).

> **Status:** research prototype, not production software. The interfaces, the package format
> (`agent.pkg` 0.1) and the execution profile (`workflow.v0`) are experimental and will change.

In four lines:

- **WebAgents** is a research prototype, not a product.
- **`agent.pkg`** is a signed, portable, declarative agent artifact: data only, no executable code.
- The **OpenClaw Agent Browser** is the host-controlled runtime that opens, verifies, authorizes
  and runs a package with the host's own models and tools.
- **A package declares what it needs; the host and its user grant the authority.**

## At a glance

**What problem does it solve?** A shared agent workflow is today either a hosted service, where
the publisher runs, pays for and controls every invocation, or a script, where each recipient
reconstructs models, credentials and tools by hand. Neither gives a clear boundary between *the
published behaviour* and *the authority to run it*. WebAgents makes that boundary explicit: the
package describes behaviour and requirements, and only the host grants authority.

**What is `agent.pkg`?** A deterministic, data-only archive. It holds a manifest, a workflow
graph, Markdown skills, JSON schemas, tool declarations and policies, protected by SHA-256 content
hashes and an Ed25519 publisher signature. It never contains executable code: no Python, no shell,
no native modules. Its requirements, such as "structured output", "a scholarly-search tool" or
"this much context", are **not permissions**: the runtime has to bind each one to a concrete
resource, and the user has to approve it. Specification: [spec/agent-pkg-v0.md](spec/agent-pkg-v0.md).

**What is the Agent Browser?** An [OpenClaw](https://docs.openclaw.ai) plugin that adds an
*Agent Browser* page to the OpenClaw Control UI. It works through a local control plane
(`agentpkg browser-serve`) and a generic `workflow.v0` interpreter, in this order:

1. Open a package from an HTTPS URL or an approved local directory.
2. Verify its integrity and signature, and evaluate publisher trust as a separate decision.
3. Show what the package asks for.
4. Record the user's per-permission and per-tool decisions.
5. Let the user choose one of the models the host actually has.
6. Freeze all of this into an immutable, hash-bound **Run Plan**.
7. Re-verify the plan, then run the package's own graph through host-mediated model and tool
   bridges, with live progress, cancellation, result artifacts and a hash-linked audit trail.

**What works today?** Two unrelated packages run through the same interpreter, unchanged, under
both a local Ollama model and a hosted OpenAI model, started from the browser page. See
[Status](#status-verified-experimental-future) for exactly what is verified.

**Tested host:** OpenClaw **2026.9.5** (`ec9c1a1`), Python 3.13, Node 26, Ollama 0.34, macOS on
Apple Silicon. Execution refuses other OpenClaw releases by default. Every recorded live run was made
on macOS. The automated test suites, the offline package verification and the plugin build are also
run by [continuous integration](.github/workflows/ci.yml) on Ubuntu Linux and macOS. No live
Agent Browser run has been accepted on Linux.

### The two example packages

| | [Meeting Agenda](agents/meeting-agenda/) | [Literature Review](agents/literature-review/) |
|---|---|---|
| Purpose | Sanity check and tutorial | The full demonstration |
| What it does | plans a meeting, runs three parallel role-based perspectives, writes an agenda whose minutes sum exactly to the requested duration | search → screening → citation resolution → evidence extraction → synthesis → writing → verification, producing a related-work draft with bibliography, evidence table and verification report |
| Tools | none (model only) | three host tools: Crossref scholarly search, a remote Citation Resolver, and a reader for operator-selected PDFs |
| Workers | 3 parallel perspectives | bounded parallel map workers (peak 3) |
| Validation | goal and duration copied from input; minutes must sum exactly | paper-scoped evidence ids, exact quotes and bibliography copied from trusted data, whole-row checks, explicit no-results outcome |
| Typical live run | ~30 s hosted, ~2.5 min local | ~7 min hosted, ~25 min local |
| Current version | 0.2.2 ([dist](dist/meeting-agenda.agent.pkg)) | 0.2.5 ([dist](dist/literature-review.agent.pkg)) |

## Quickstart: offline, about five minutes

This needs only Python ≥ 3.11 (a current patch release) and this repository. It verifies both
signed packages and runs them in **fixture mode**: package-owned, exact-input replay of model and
tool responses, with no network and no inference. It still exercises the real interpreter,
permission checks, budgets, validation and audit.

```sh
git clone <this-repository-url> WebAgents && cd WebAgents
python3 -m venv agentpkg/.venv
agentpkg/.venv/bin/python -m pip install -e './agentpkg[dev]'

# 1. Verify signatures against the publisher keys shipped in examples/keys/
agentpkg/.venv/bin/agentpkg verify dist/meeting-agenda.agent.pkg \
  --trust-key examples/keys/meeting-agenda-publisher.pub.pem
agentpkg/.venv/bin/agentpkg verify dist/literature-review.agent.pkg \
  --trust-key examples/keys/literature-review-publisher.pub.pem

# 2. Run Meeting Agenda (model only)
agentpkg/.venv/bin/agentpkg run dist/meeting-agenda.agent.pkg \
  --mode fixture --grants examples/meeting-agenda-grants.json \
  --out examples/my-agenda

# 3. Run Literature Review (each tool needs its own approval as well as a permission grant)
agentpkg/.venv/bin/agentpkg run dist/literature-review.agent.pkg \
  --mode fixture --grants examples/literature-review-grants.json \
  --approve-tool scholarly-search --approve-tool citation-resolver --approve-tool paper-reader \
  --out examples/my-review
```

Each run prints a JSON report ending in `"passed": true`, and writes `result.json`,
`audit.json`, `usage.json`, `provenance.json` and the package's declared exports to the new
`--out` directory (`examples/my-*` is git-ignored). You can also install the prebuilt wheel
instead of the editable checkout: `pip install dist/agentpkg-0.2.2-py3-none-any.whl`.

The example keys are development keys. They show which key signed an artifact; they do not
certify the publisher.

## Running from the Agent Browser

Live runs need OpenClaw 2026.9.5, the plugin, and at least one model configured in OpenClaw.
Building the plugin needs Node 24 (≥ 24.16) or Node ≥ 26.1, the range the pinned OpenClaw
devDependency supports. The complete, copy-pasteable setup is in
**[docs/getting-started.md](docs/getting-started.md)**. In short:

```sh
cd openclaw-agent-browser && npm ci && npm test && npm run build && npm run validate && npm run pack
openclaw plugins install ./agent-browser.tgz --accept-capabilities && cd ..
# configure agentpkgPath, localPackages.roots and llm.allowModelOverride (see getting-started), then:
openclaw gateway restart && openclaw dashboard        # choose "Agent Browser" in the sidebar
```

Models are whatever your OpenClaw host reports. The recorded runs used `ollama/qwen3:30b` locally
and `openai/gpt-5.6-luna` hosted. WebAgents never sees a provider credential: the plugin calls
the model through OpenClaw, bound to exactly the model in the Run Plan, with no fallback.

## Demo: the Literature Review agent from the browser

Once the plugin is installed and configured as in [getting-started](docs/getting-started.md),
everything below happens in the Control UI. `<repo>` is the absolute path of your checkout.

1. **Start the Gateway.** `openclaw gateway status` reports *running*; otherwise run
   `openclaw gateway start`.
2. **Have a model.** For example, `ollama list` shows `qwen3:30b` (see the context note in
   getting-started), or a hosted OpenAI model is configured in OpenClaw.
3. **Open Agent Browser.** `openclaw dashboard` → **Agent Browser**. The header reads *Control
   plane running*.
4. **Open the package.** *Open a local package* → `<repo>/dist/literature-review.agent.pkg` →
   **Open file**. **Verification and trust** shows Container, Integrity, Schema and Runtime valid,
   the signature cryptographically valid, and signer `sha256:c5ca9763…5232`.
5. **Trust and permissions.** If the publisher is unknown: *Review publisher key* → *Trust this
   publisher key* (press twice). Set `network.scholarly`, `network.citations`, `memory.session`
   and `model.reasoning` to *Allow for session*. Leave `files.pdfs` on *Deny* unless you will
   select PDFs. Tick the three **Tool approvals**, then press **Authorize** (*The package has NOT
   executed*).
6. **Select the model** from the list this host reports. Nothing is preselected.
7. **Prepare run** → **Ready to run**, showing the Run Plan id and hash.
8. **Enter a research question**, for example *What defenses have been proposed against prompt
   injection attacks on LLM-integrated applications?* Every checklist line turns ✓.
9. **Run Research.** Progress shows each stage (planning, search, screening, citations, evidence,
   synthesis, writing, verification), the workers, and the model, tool and remote calls and
   tokens. **Cancel** stops a run within seconds, and reloading the page reconnects to it.
10. **Inspect the result:** the related-work draft, the summary, the artifacts (View and Download,
    SHA-256 verified) and **Technical details** (plan, model and every call on it, tool bindings,
    permissions, usage, cost, audit chain, and the checks re-verified before start). If a run
    finds nothing grounded, it completes with *No sufficiently grounded literature found*. That
    is a correct outcome, not an error.

A local run takes tens of minutes. The authorization has to outlast the run deadline, so start
the run within the time the Run panel shows. Repeat with `dist/meeting-agenda.agent.pkg` for a
fast run; no plugin change is needed. The accepted browser-started run and its evidence are in
[docs/demo-experience-report.md](docs/demo-experience-report.md).

## Recorded results

These are the acceptance runs reported in the paper's Table I. Within each workflow, the local
and hosted runs used identical package bytes, task input, permissions and runtime limits. They
show **portability across model bindings within one runtime**. They do not show equal answer
quality across models or interoperability across independent runtimes.

| | Meeting Agenda 0.2.2, local | Meeting Agenda 0.2.2, hosted | Literature Review 0.2.4, local | Literature Review 0.2.4, hosted |
|---|---|---|---|---|
| Model | `ollama/qwen3:30b` | `openai/gpt-5.6-luna` | `ollama/qwen3:30b` | `openai/gpt-5.6-luna` |
| Model calls / external tool calls | 5 / 0 | 5 / 0 | 18 / 6 | 18 / 6 |
| Peak parallel workers | 3 | 3 | 3 | 3 |
| Reported tokens | 11,346 | 5,198 | 100,352 | 68,398 |
| Workflow duration | 154.3 s | 29.4 s | 1,489.8 s | 417.6 s |
| Audit events (chain valid) | 92 | 102 | 572 | 678 |
| Model cost | n/a | $0.0147 | n/a | $0.2005 |
| Run id | `run_34fdabde…` | `run_1c2ca974…` | `run_322dca77…` | `run_a71e5b0f…` |

Each run made every model call on the model its Run Plan selected. The figures come from the
Agent Browser run records on the recording host. **Those four run records are not included in
this repository.** What the repository does include:

- [literature-review-025-recorded-runs.json](examples/verification/literature-review-025-recorded-runs.json):
  independent checks recomputed over both Literature Review runs (run ids, model, model calls,
  audit events and chain validity, cost, and every grounding check). Their token counts and
  durations are not in it.
- Two **other** recorded runs of the same Meeting Agenda 0.2.2 package, with their own figures
  (`ollama/qwen3:30b`: 9,415 tokens, 133.2 s; `openai/gpt-5.6-luna`: 5,120 tokens, 32.4 s), in
  [examples/meeting-agenda-022-qwen/](examples/meeting-agenda-022-qwen/) and
  [examples/meeting-agenda-022-luna/](examples/meeting-agenda-022-luna/), with complete run
  records and audit chains ([report](docs/meeting-agenda-022-report.md)).

The current Literature Review 0.2.5 changes only a step after the last model call. It passes
offline acceptance but has not yet been run live ([report](docs/literature-review-025-report.md)).

## How it works

```text
 creator ──build+sign──▶ agent.pkg ──served by──▶ HTTPS origin ──open──▶ OpenClaw + Agent Browser
 (workflow, skills,       (data only,                                   verify → trust → authorize
  schemas, policy)         signed)                                      → Run Plan → re-verify → run
                                                                          │ model bridge   │ tool broker
                                                                          ▼                ▼
                                                              user's models,      approved host tools
                                                              files, budgets      and origin services
```

| Layer | Code | Role |
|---|---|---|
| Package format and CLI | [`agentpkg/`](agentpkg/) (`agentpkg.package`, `validation`, `signing`, `cli`) | build, validate, sign, verify, inspect, run in fixture mode |
| Interpreter | `agentpkg.workflow` | `workflow.v0`: acyclic graphs of `llm`, `tool`, `map`, `join`, `validate` and `output` nodes; copied worker state, atomic wave commits, budgets, deadlines, cancellation, audit |
| Control plane | `agentpkg.browser` (`agentpkg browser-serve`) | loopback, token-protected: snapshots, layered validation, publisher trust, authorization receipts, model compatibility, Run Plans. It never executes. |
| Execution | `agentpkg.execution`, `agentpkg.hostbridge`, `agentpkg.toolbridge` | leases the verified snapshot, re-verifies, runs the graph, and reaches models and tools only through host bridges |
| Browser plugin | [`openclaw-agent-browser/`](openclaw-agent-browser/) | the Control UI page and the Gateway-side backend; the only part that knows OpenClaw |
| Example packages | [`agents/`](agents/) → [`dist/`](dist/README.md) | Meeting Agenda, Literature Review (and the archived pre-`workflow.v0` legacy package) |
| Services | [`citation-resolver/`](citation-resolver/), [`package-origin/`](package-origin/) | the remote Citation Resolver used by Literature Review; a minimal static package origin |

Design rationale: [docs/architecture.md](docs/architecture.md). Threat model:
[docs/threat-model.md](docs/threat-model.md). Every document: [docs/README.md](docs/README.md).

## Status: verified, experimental, future

**Verified in this repository** (automated tests, offline acceptance scripts, or recorded live runs):

- The `agent.pkg` container: deterministic build, SHA-256 integrity, Ed25519 signatures, and
  bounded parsing that rejects duplicate names, path traversal, duplicate JSON keys and remote
  schemas.
- The generic `workflow.v0` interpreter running both packages with no package-specific code;
  fixture-mode replay of both.
- Control-plane opening, from local paths and SSRF-hardened HTTPS (no redirects, no private
  networks, size-bounded), with signature validity and publisher trust kept separate.
- Permission decisions, separate per-tool approvals, model compatibility evaluation, and
  immutable hash-bound Run Plans that are re-verified before execution; stale plans are refused.
- Execution from the Agent Browser page on OpenClaw 2026.9.5, with every model call on the
  planned model, host tool bindings, budgets, deadlines, cancellation and valid audit chains. See
  [Recorded results](#recorded-results).

**Experimental** (works on the development host, but limited or lightly exercised):

- The plugin depends on OpenClaw's experimental plugin and Control UI APIs. It has been run live
  only on macOS, with one OpenClaw release. On Linux, CI builds, validates and packs it and runs its
  test suite, including the integration tests that drive a real control plane and runner; that is
  not a live acceptance run.
- Live Literature Review runs depend on two external services: public Crossref, which covers
  recent AI topics thinly, and the Citation Resolver hosted by the authors at
  `webagents-citation-resolver-production.up.railway.app`. The resolver is a research/demo service
  with no availability guarantee, and the signed package names its origin. If either service is
  unavailable or rate-limited, a live run fails or finds less. Fixture-mode runs, the offline
  verification scripts and CI never contact either service.
- Local-model runs are slow and sensitive to the host's resource limits. The packages' timing
  and budget policy was set from measurements on one machine.
- Opening a package by HTTPS URL is covered by tests against a mock origin. The minimal origin in
  `package-origin/` has not been part of a recorded acceptance run.
- The audit trail is a locally hash-linked record, not a third-party attestation.

**Future work** (not implemented): NANDA-based discovery and AgentFacts mapping; issuer
credentials or certification for publishers; MCP and A2A integration through host adapters;
conversational and persistent-service execution profiles; executable modules under an isolation
boundary; data-flow policies; persistent ("always") authorization; federated scholarly search
(arXiv, OpenAlex); conformance tests across independent runtimes.

## Limitations

- **Portability is not equivalence.** A package can be bound to any compatible, authorized
  environment. Different models will still produce different answers, and a successful run with a
  valid audit chain does not prove an answer correct or a review complete.
- **Trust is the host's decision.** A valid signature shows which key signed the content. It
  does not show that the signer is trustworthy or that the workflow is safe. The prototype uses
  manually pinned development keys.
- **The security boundary assumes a trusted OpenClaw host and trusted adapters.** Prompt
  injection can still misuse a capability the user approved. Sending context to a hosted model is
  not the same as keeping it local.
- **Cancellation is not rollback.** Failed waves do not commit workflow state, but side effects
  that external services have already completed are not undone.
- **Single runtime.** Only one runtime implementation exists, so cross-runtime interoperability is
  untested.

## Repository layout

| Path | Contents |
|---|---|
| `agentpkg/` | Python package: format, CLI, interpreter, control plane, execution, tests |
| `openclaw-agent-browser/` | OpenClaw plugin (TypeScript): backend, Control UI page, tests, operator scripts |
| `agents/` | package sources: `meeting-agenda`, `literature-review`, `literature-review-legacy` |
| `dist/` | signed packages and wheels, current and historical, with SHA-256 ([dist/README.md](dist/README.md)) |
| `spec/` | the `agent.pkg` and `workflow.v0` specifications |
| `docs/` | guides and dated milestone reports ([index](docs/README.md)) |
| `examples/` | grants, inputs, public development keys, recorded runs, verification evidence ([examples/README.md](examples/README.md)) |
| `scripts/` | offline acceptance and verification scripts |
| `citation-resolver/` | the Citation Resolver service (FastAPI) |
| `package-origin/` | a minimal static package origin |
| `experiments/` | the paper's offline experiments: contract enforcement and contract overhead ([index](experiments/README.md)) |
| `.github/workflows/` | continuous integration on Ubuntu and macOS |

## Development

```sh
agentpkg/.venv/bin/python -m pytest agentpkg/tests
agentpkg/.venv/bin/python -m ruff check agentpkg && agentpkg/.venv/bin/python -m ruff format --check agentpkg
agentpkg/.venv/bin/python scripts/verify_workflow.py
agentpkg/.venv/bin/python scripts/verify_browser.py
agentpkg/.venv/bin/python scripts/verify_literature_025.py
agentpkg/.venv/bin/python scripts/check_release.py     # package identities, dist/ SHA-256 list, licenses
(cd openclaw-agent-browser && npm ci && npm run typecheck && npm test && npm run verify)
(cd citation-resolver && python3 -m venv .venv && .venv/bin/pip install -r requirements-dev.txt && .venv/bin/python -m pytest)
```

The plugin's integration tests use `agentpkg/.venv/bin/agentpkg`, so create that environment
first. `npm run verify` builds, validates and packs the plugin with the pinned OpenClaw
devDependency, installs the artifact into a throwaway OpenClaw configuration and state directory
(not yours), and reruns the tests. It needs no global OpenClaw installation.
[`.github/workflows/ci.yml`](.github/workflows/ci.yml) runs all of the above, and the paper
experiments' test suites, on Ubuntu and macOS.

The pre-`workflow.v0` Literature Review runner is still available as `agentpkg-legacy`, together
with `dist/literature-review-legacy.agent.pkg` ([migration notes](docs/workflow-migration.md)).
How the prototype got here, milestone by milestone: [docs/development-history.md](docs/development-history.md).

## License

WebAgents is licensed under the [Apache License, Version 2.0](LICENSE) (SPDX: `Apache-2.0`).
Third-party material it contains or bundles, including tables and expressions derived from
CPython's `html` module and the dependencies bundled into the plugin artifact, is listed with its
terms in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). Release procedure and checklist:
[docs/releasing.md](docs/releasing.md).

## Citation

```bibtex
@misc{webagents2026,
  title  = {WebAgents: Unbundling Agent Creation, Hosting, and Execution for an Agent-Native Web},
  author = {{Author information to be added}},
  year   = {2026},
  note   = {Research prototype}
}
```
