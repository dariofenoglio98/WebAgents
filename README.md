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
  and runs a package with the host's own models and tools; the **Chrome Agent Browser** is a
  second, independent runtime that does the same inside Chrome.
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

1. Open a package from an HTTPS URL, from a website that advertises one, or from an approved
   local directory.
2. Verify its integrity and signature, and evaluate publisher trust as a separate decision.
3. Show what the package asks for.
4. Record the user's per-permission and per-tool decisions.
5. Let the user choose one of the models the host actually has.
6. Freeze all of this into an immutable, hash-bound **Run Plan**.
7. Re-verify the plan, then run the package's own graph through host-mediated model and tool
   bridges, with live progress, cancellation, result artifacts and a hash-linked audit trail.

**What works today?** Three unrelated packages run through the same interpreter, unchanged, under
both a local Ollama model and a hosted OpenAI model, started from the browser page: a model-only
meeting planner, a literature review that calls live scholarly services, and a travel agent that a
(fictional) airline website publishes beside its HTML pages. The travel agent uses the site's
semantic API and personal resources that only the user's host holds. See
[Status](#status-verified-experimental-future) for exactly what is verified.

**Is there a second runtime?** Yes, since the paper: the [Chrome Agent
Browser](docs/chrome-agent-browser.md), a Chrome extension built on a TypeScript port of the
runtime that also runs in Node. It discovers packages on websites, authorizes them through
publisher-declared profiles or per item, and runs WebAir and Literature Review with your own
Ollama model or your own OpenAI or Anthropic key. A [conformance suite](conformance/README.md)
runs both runtimes on the same packages and compares what they produce and what they refuse.
See [Running in Chrome](#running-in-chrome).

**Tested host:** OpenClaw **2026.9.5** (`ec9c1a1`), Python 3.13, Node 26, Ollama 0.34, macOS on
Apple Silicon. Execution refuses other OpenClaw releases by default. Every recorded live run was made
on macOS. The automated test suites, the offline package verification and the plugin build are also
run by [continuous integration](.github/workflows/ci.yml) on Ubuntu Linux and macOS. No live
Agent Browser run has been accepted on Linux.

### The three example packages

| | [Meeting Agenda](agents/meeting-agenda/) | [Literature Review](agents/literature-review/) | [WebAir](agents/webair/) |
|---|---|---|---|
| Purpose | Sanity check and tutorial | The full demonstration | The website-native case |
| What it does | plans a meeting, runs three parallel role-based perspectives, writes an agenda whose minutes sum exactly to the requested duration | search → screening → citation resolution → evidence extraction → synthesis → writing → verification, producing a related-work draft with bibliography, evidence table and verification report | a fictional airline's travel agent, published by [its website](demo/webair/README.md): interprets a travel request, searches flights, reads fare rules and answers; optionally a booking quote or, in a separate run, a simulated purchase |
| Tools | none (model only) | three host tools: Crossref scholarly search, a remote Citation Resolver, and a reader for operator-selected PDFs | WebAir's four semantic API operations (search, fare rules, booking quote, simulated purchase), bound by the host, and three host-owned resources the user selects: a travel profile, a passenger identity, a demo payment method |
| Workers | 3 parallel perspectives | bounded parallel map workers (peak 3) | bounded fare-rule workers (peak 3) |
| Validation | goal and duration copied from input; minutes must sum exactly | paper-scoped evidence ids, exact quotes and bibliography copied from trusted data, whole-row checks, explicit no-results outcome | the model only chooses among flights and fares WebAir returned; quotes and purchases are checked against the authorized fare; no model sees the identity or payment method; personal state is cleared before output |
| Typical live run (search) | ~30 s hosted, ~2.5 min local | ~7 min hosted, ~25 min local | ~20 s hosted, ~1.5 min local |
| Current version | 0.2.2 ([dist](dist/meeting-agenda.agent.pkg)) | 0.2.5 ([dist](dist/literature-review.agent.pkg)) | 0.4.0 ([dist](dist/webair-0.4.0.agent.pkg)) |

## Quickstart: offline, about five minutes

This needs only Python (3.11 ≥ 3.11.10, 3.12 ≥ 3.12.4, or 3.13; see
[getting-started](docs/getting-started.md#requirements)) and this repository. It verifies the three
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
agentpkg/.venv/bin/agentpkg verify dist/webair-0.4.0.agent.pkg \
  --trust-key examples/keys/webair-publisher.pub.pem

# 2. Run Meeting Agenda (model only)
agentpkg/.venv/bin/agentpkg run dist/meeting-agenda.agent.pkg \
  --mode fixture --grants examples/meeting-agenda-grants.json \
  --out examples/my-agenda

# 3. Run Literature Review (each tool needs its own approval as well as a permission grant)
agentpkg/.venv/bin/agentpkg run dist/literature-review.agent.pkg \
  --mode fixture --grants examples/literature-review-grants.json \
  --approve-tool scholarly-search --approve-tool citation-resolver --approve-tool paper-reader \
  --out examples/my-review

# 4. Run a WebAir flight search (every personal resource denied: a search needs none)
agentpkg/.venv/bin/agentpkg run dist/webair-0.4.0.agent.pkg \
  --mode fixture --grants examples/webair-0.2.0-grants.json \
  --approve-tool search-flights --approve-tool get-fare-rules \
  --out examples/my-webair
```

Each run prints a JSON report ending in `"passed": true`, and writes `result.json`,
`audit.json`, `usage.json`, `provenance.json` and the package's declared exports to the new
`--out` directory (`examples/my-*` is git-ignored). You can also install the prebuilt wheel
instead of the editable checkout: `pip install dist/agentpkg-0.4.0-py3-none-any.whl` (the
development line, with memory.v0; the v0.2.0 release's `agentpkg-0.2.2` wheel stays beside it, and the v0.1.0
release's wheel of that version cannot read WebAir 0.2.0 or later; [dist/README.md](dist/README.md)).

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

## Running in Chrome

The Chrome Agent Browser needs Chrome 137 or newer and Node 24 (≥ 24.16) or ≥ 26.1 to build it;
no OpenClaw, no Python. Its user guide is
[`chrome-agent-browser/README.md`](chrome-agent-browser/README.md), its design
[docs/chrome-agent-browser.md](docs/chrome-agent-browser.md), and the full setup level 4 of
[getting-started](docs/getting-started.md#6-chrome-agent-browser-level-4).

```sh
cd chrome-agent-browser && npm ci && npm run build      # dist/extension/ and dist/cli.js
```

In Chrome, open `chrome://extensions`, enable **Developer mode**, **Load unpacked** →
`chrome-agent-browser/dist/extension`, and pin the action. Then:

1. **Connect a model.** Settings → Models: Ollama on this machine (start it with
   `OLLAMA_ORIGINS="chrome-extension://*"`; the page gives the commands), or your own OpenAI or
   Anthropic key, typed into the extension and kept encrypted in this browser profile under a
   passphrase you set in Settings → Security.
2. **Visit a site that publishes an agent**, for example the fictional
   <https://webagents-webair-production.up.railway.app/>, and click the WebAgents button: the
   extension reads that page's advertised packages (it holds no website access until you grant
   some); the side panel lists them; **Inspect** verifies one and shows who signed it and what
   it asks for. Chrome asks you to allow each origin an agent needs, and Settings → Permissions
   lists and revokes every grant.
3. **Trust the publisher key**, choose a profile such as *Search flights* and press **Use this
   agent**, or open **Customize your settings** to decide permission by permission.
4. **Run.** The run happens in the extension's own background host with the model, permissions
   and records you chose; closing the panel does not stop it. **Runs** keeps every run with its
   audit chain and artifacts.
5. **Find agents and follow a policy.** Settings → Search adds a signed agent index (the WebAgents
   demo index is one click to fill in); the full page's address bar then searches it by words or
   by an agent name, and **Open and verify** checks the package itself. Settings → Policies →
   Policy subscription follows one signed policy that trusts publishers, pre-decides permissions
   and caps runs for you, and names itself on every decision it makes.

The same core runs from a terminal with `agentpkg`'s flags, for example
`node chrome-agent-browser/dist/cli.js run dist/webair-0.4.0.agent.pkg --mode fixture --grants
examples/webair-0.2.0-grants.json --approve-tool search-flights --approve-tool get-fare-rules
--out examples/my-chrome-webair`, and the conformance suite compares it with `agentpkg`:

```sh
node conformance/run.mjs      # needs agentpkg/.venv and the built core; no network, model or key
```

The recorded live runs in Chrome (WebAir on a local and a hosted model, Literature Review on both)
and the checks recomputed over them are in [examples/verification/](examples/verification/)
(`chrome-*.json`).

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

## Demo: WebAir, a website that publishes its agent

WebAir is a made-up airline whose small origin, [`demo/webair/`](demo/webair/README.md), is
deployed at <https://webagents-webair-production.up.railway.app/>. It serves ordinary HTML pages
for people and, from the same origin, the signed WebAir package together with an experimental
`<link rel="agent-package">` in each page's head. **No real booking or payment ever occurs:**
every flight, price, passenger and card is invented.

Typing the site's address (not the package URL) into the Agent Browser lists the advertised
package as an unverified candidate. **Inspect** opens it through the same verification, trust and
authorization steps as any package. The package then reaches WebAir only through its semantic API,
never through the HTML. It asks the host for a travel profile, a passenger identity and a demo
payment method by *type*. The person picks which of the host's resources to share, and the pick is
frozen into the Run Plan. A simulated purchase needs a separate, `once` authorization.

The host side needs two operator files in the plugin configuration: `hostResources.file`, the
fictional resources this host holds ([`demo/webair/host-resources.json`](demo/webair/host-resources.json)),
and `tools.bindingsFile`, which binds the package's four API tools to WebAir's endpoints
([`demo/webair/host-bindings.json`](demo/webair/host-bindings.json)). The complete setup, a 3–5
minute presentation script and the reset steps are in
**[docs/webair-live-demo.md](docs/webair-live-demo.md)**. The accepted end-to-end walk-through
(search, quote, simulated purchase, refused replay, denied purchase; 133 checks, including that no
model request contained a passenger name, e-mail or payment identifier) is
[`webair-030-live-demo.json`](examples/verification/webair-030-live-demo.json).

## Recorded results

These are the acceptance runs reported in the paper's Table I. Within each workflow, the local
and hosted runs used identical package bytes, task input, permissions and runtime limits. They
show **portability across model bindings within one runtime**. They do not show equal answer
quality across models or interoperability across independent runtimes.

| | Meeting Agenda 0.2.2, local | Meeting Agenda 0.2.2, hosted | Literature Review 0.2.4, local | Literature Review 0.2.4, hosted | WebAir 0.3.0, local | WebAir 0.3.0, hosted |
|---|---|---|---|---|---|---|
| Model | `ollama/qwen3:30b` | `openai/gpt-5.6-luna` | `ollama/qwen3:30b` | `openai/gpt-5.6-luna` | `ollama/qwen3:30b` | `openai/gpt-5.6-luna` |
| Model calls / external tool calls | 5 / 0 | 5 / 0 | 18 / 6 | 18 / 6 | 3 / 4 | 3 / 4 |
| Personal-resource reads | 0 | 0 | 0 | 0 | 1 | 1 |
| Peak parallel workers | 3 | 3 | 3 | 3 | 3 | 3 |
| Reported tokens | 11,346 | 5,198 | 100,352 | 68,398 | 11,577 | 7,716 |
| Workflow duration | 154.3 s | 29.4 s | 1,489.8 s | 417.6 s | 81.7 s | 18.6 s |
| Audit events (chain valid) | 92 | 102 | 572 | 678 | 241 | 247 |
| Model cost | n/a | $0.0147 | n/a | $0.2005 | n/a | $0.0094 |
| Run id | `run_34fdabde…` | `run_1c2ca974…` | `run_322dca77…` | `run_a71e5b0f…` | `run_8dcfcde4…` | `run_a3a1337c…` |

Each run made every model call on the model its Run Plan selected. The WebAir runs are a
profile-assisted search: one flight search and three fare-rule requests to the public WebAir
origin, and one read of the travel profile the user selected. The figures come from the Agent
Browser run records on the recording host. **Those six run records are not included in this
repository.** What the repository does include:

- [literature-review-025-recorded-runs.json](examples/verification/literature-review-025-recorded-runs.json):
  independent checks recomputed over both Literature Review runs (run ids, model, model calls,
  audit events and chain validity, cost, and every grounding check). Their token counts and
  durations are not in it.
- Two **other** recorded runs of the same Meeting Agenda 0.2.2 package, with their own figures
  (`ollama/qwen3:30b`: 9,415 tokens, 133.2 s; `openai/gpt-5.6-luna`: 5,120 tokens, 32.4 s), in
  [examples/meeting-agenda-022-qwen/](examples/meeting-agenda-022-qwen/) and
  [examples/meeting-agenda-022-luna/](examples/meeting-agenda-022-luna/), with complete run
  records and audit chains ([report](docs/meeting-agenda-022-report.md)).
- [webair-030-table1-runs.json](examples/verification/webair-030-table1-runs.json): every WebAir
  figure above recomputed from both run records, with the audit chains re-verified, the hashes of
  the source files, and a comparison showing that the two runs had identical package bytes, task,
  permissions, resource selection, tool bindings and tool-call sequence, and differed only in the
  model and therefore the Run Plan hash ([script](scripts/verify_webair_table1.py)).

The current Literature Review 0.2.5 changes only a step after the last model call. It passes
offline acceptance but has not yet been run live ([report](docs/literature-review-025-report.md)).

### Controlled experiments

The paper's two offline experiments live in [`experiments/`](experiments/README.md), with their
code, tests, frozen inputs and every result directory they report:

- **Contract enforcement** ([`contract_enforcement/`](experiments/contract_enforcement/)): 716
  injected contract violations from 61 templates and 295 matched benign controls (Meeting Agenda
  and Literature Review), each run under the full system and under eight ablations that each
  remove one enforcement component. The full system explicitly refused every violation before its
  forbidden boundary and accepted every control. Results:
  `results/2026-10-02T12-38-15Z_paper_paper`, at commit `23eac90`.
- **Contract overhead** ([`contract_overhead/`](experiments/contract_overhead/)): automated
  processing from signed package bytes in memory to the first node dispatch, excluding download,
  human decisions, inference and tools. Pooled median (95th percentile) over three runs of 1,000
  observations per package on an Apple M3 Max: Meeting Agenda 59.0 (62.5) ms, Literature Review
  449.9 (465.0) ms, WebAir 488.7 (504.7) ms. Results: `results/2026-10-03T16-14-20Z_paper-webair-pooled`
  and its three runs, at commit `9d78ca5`.

Both are offline and credential-free, and CI runs both test suites. The production code of this
release is the code the overhead was measured on. The enforcement results predate four documented
production changes, and rerunning the full enforcement experiment on this release's code gave the
same outcome for every one of the 9,099 cases ([docs/releasing.md](docs/releasing.md)).

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
| Chrome runtime | [`chrome-agent-browser/`](chrome-agent-browser/) | a portable TypeScript core (format, verification, trust, authorization, interpreter, adapters, execution, audit) with a Node CLI, and a Manifest V3 extension around it ([design](docs/chrome-agent-browser.md)) |
| Conformance | [`conformance/`](conformance/README.md) | both runtimes on the same packages: fixture parity, a negative suite and the control-plane scenarios, with the recorded differences |
| Example packages | [`agents/`](agents/) → [`dist/`](dist/README.md) | Meeting Agenda, Literature Review, WebAir (and the archived pre-`workflow.v0` legacy package) |
| Services | [`citation-resolver/`](citation-resolver/), [`demo/webair/`](demo/webair/README.md), [`package-origin/`](package-origin/) | the remote Citation Resolver used by Literature Review; the fictional WebAir origin (HTML site, semantic API, signed package, discovery link) and its publisher tooling; a minimal static package origin |

Design rationale: [docs/architecture.md](docs/architecture.md). Threat model:
[docs/threat-model.md](docs/threat-model.md). Every document: [docs/README.md](docs/README.md).

## Status: verified, experimental, future

**Verified in this repository** (automated tests, offline acceptance scripts, or recorded live runs):

- The `agent.pkg` container: deterministic build, SHA-256 integrity, Ed25519 signatures, and
  bounded parsing that rejects duplicate names, path traversal, duplicate JSON keys and remote
  schemas.
- The generic `workflow.v0` interpreter running all three packages with no package-specific
  code; fixture-mode replay of each.
- Control-plane opening, from local paths and SSRF-hardened HTTPS (no redirects, no private
  networks, size-bounded), with signature validity and publisher trust kept separate.
- Website discovery: one page read under the same policy, its same-origin
  `rel="agent-package"` links listed as unverified candidates, each opened only by the person.
- Permission decisions, separate per-tool approvals, model compatibility evaluation, and
  immutable hash-bound Run Plans that are re-verified before execution; stale plans are refused.
- Host-owned resources (`personal.read`): a package requests a resource *type*; the person picks
  one of the host's resources, which the Run Plan binds by opaque id and keyed digest. The tool
  broker returns only that resource, and refuses a sealed value (an e-mail, a payment
  identifier) in any tool call whose permissions do not include the grant. A `once` grant is
  spent by the first run.
- Operator-configured HTTP tool bindings (`tools.bindingsFile`), with no package-specific code in
  the plugin.
- Execution from the Agent Browser page on OpenClaw 2026.9.5, with every model call on the
  planned model, host tool bindings, budgets, deadlines, cancellation and valid audit chains. See
  [Recorded results](#recorded-results).
- A second runtime, the Chrome Agent Browser: its core gives the same results as `agentpkg` on
  every shipped package in fixture mode and the same refusals on the cases of the
  [conformance suite](conformance/README.md), whose differences are each recorded with their
  reason; live WebAir and Literature Review runs in Chrome on a local and a hosted model are
  recorded and recomputed under [examples/verification/](examples/verification/).
- Publisher-declared profiles (`org.webagents:profiles-v0`): a profile groups declared
  authority and grants none; tools outside the chosen profile may stay unapproved and are
  refused if called, in the Chrome runtime and in `agentpkg`'s control plane.
- In Chrome, search over signed agent indexes and one signed policy subscription
  ([`spec/extensions/`](spec/extensions/)): results are metadata and every package is verified when
  opened; a policy trusts the publishers it anchors after the person's own pins, pre-decides within
  the chosen profile and the person's preset, and labels every decision it made (recorded in a real
  Chrome: [`chrome-search-policy-e2e.json`](examples/verification/chrome-search-policy-e2e.json);
  over demo index 1.1.0, which lists Literature Review 0.2.6 and WebAir 0.5.0:
  [`chrome-search-policy-e2e-index-110.json`](examples/verification/chrome-search-policy-e2e-index-110.json);
  over demo index 1.2.0, which lists Literature Review 0.2.7:
  [`chrome-search-policy-e2e-index-120.json`](examples/verification/chrome-search-policy-e2e-index-120.json);
  demo index 1.3.0 listed Literature Review 0.2.8 and WebAir 0.6.0, the first packages that use the
  person's memory, [`spec/memory-v0.md`](spec/memory-v0.md); demo index 1.4.0 lists Literature Review
  0.2.9 and WebAir 0.7.0, the first that ship WebAssembly modules, [`spec/compute-v0.md`](spec/compute-v0.md)).
  NANDA resolution is a stub with the mapping defined.

**Experimental** (works on the development host, but limited or lightly exercised):
- **Code in packages** ([`spec/compute-v0.md`](spec/compute-v0.md), agentpkg 0.5.0): a package may ship
  WebAssembly core modules that import nothing and run them from `compute` nodes under memory, time
  and fuel bounds, the person's `compute` grant and the audit; the Python reference runs them with
  `wasmtime` (`pip install -e './agentpkg[compute]'`), the Chrome Agent Browser (core 0.3.0) in V8, one
  nested Worker per call with the wall bound as its CPU bound
  ([`chrome-compute-e2e.json`](examples/verification/chrome-compute-e2e.json)); two example modules
  (AssemblyScript, Rust) and the enforcement cases are under [`examples/compute/`](examples/compute/);
  Literature Review 0.2.9 and WebAir 0.7.0 ship them. Both runtimes agree on the 41 compute
  conformance cases.
- **Conversations with just-in-time consent** ([`spec/conversation-v0.md`](spec/conversation-v0.md),
  agentpkg 0.6.0): a package may declare a conversation over its graph: a persistent state the
  publisher declares, one turn per message under one Run Plan with per-turn and per-conversation
  budgets, and `consent` steps that pause a turn before a consequential action for the person's
  yes or no, with a `once` grant spent once per conversation and one audit chain across turns. The
  Python reference runs conversations from a transcript (`agentpkg converse`); the test package
  and the 43 enforcement cases are under [`examples/conversation/`](examples/conversation/). The
  chat surface in the Chrome Agent Browser and a conversational WebAir are the next task (T24).

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
- Live WebAir runs depend on the public demo origin at
  `webagents-webair-production.up.railway.app`, a research/demo deployment with no availability
  guarantee, whose fictional schedule ends on 31 December 2027. The signed package names that
  host, so a new host is a new package version. Fixture-mode runs and CI never contact it.
- `rel="agent-package"` and `application/vnd.webagents.agent-package` are an experimental
  WebAgents convention, not a registered link relation or media type.
- `agent.pkg` 0.1 has no optional tools. A publisher-declared profile lets a host leave the tools
  outside it unapproved (the Chrome runtime and `agentpkg`'s control plane do), but the OpenClaw
  Agent Browser page does not offer profiles, so there every WebAir tool must still be bound and
  approved, and a host that holds none of the three resource types cannot run WebAir 0.2.0 or
  later even for a search.
- The Chrome extension cannot classify the address a DNS name resolves to: the private-address
  checks and connection pinning of `agentpkg` and of the Chrome CLI are Chrome's network stack's
  job in the extension ([threat model](docs/threat-model.md#chrome-agent-browser-t7)). Its
  built-in model route (Gemini Nano) has not been run live, and it is not published in the Chrome
  Web Store.
- Local-model runs are slow and sensitive to the host's resource limits. The packages' timing
  and budget policy was set from measurements on one machine.
- Opening a package by HTTPS URL is covered by tests against a mock origin. The minimal origin in
  `package-origin/` has not been part of a recorded acceptance run.
- The audit trail is a locally hash-linked record, not a third-party attestation.

**Future work** (not implemented): NANDA-based discovery and AgentFacts mapping; issuer
credentials or certification for publishers; MCP and A2A integration through host adapters;
conversational and persistent-service execution profiles; executable modules under an isolation
boundary; data-flow policies; persistent ("always") authorization; federated scholarly search
(arXiv, OpenAlex); conformance beyond fixture mode (live runs compared across runtimes).

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
- **Two runtimes, one comparison.** The conformance suite shows identical fixture behaviour and
  identical refusals on its listed cases. It does not prove the runtimes equivalent, and two
  implementations can agree and both be wrong.

## Repository layout

| Path | Contents |
|---|---|
| `agentpkg/` | Python package: format, CLI, interpreter, control plane, execution, tests |
| `openclaw-agent-browser/` | OpenClaw plugin (TypeScript): backend, Control UI page, tests, operator scripts |
| `chrome-agent-browser/` | the Chrome Agent Browser (TypeScript): portable core, Node CLI, Manifest V3 extension, tests, headless-Chrome harnesses ([README](chrome-agent-browser/README.md)) |
| `conformance/` | the cross-runtime conformance suite and its kept reports ([README](conformance/README.md)) |
| `agents/` | package sources: `meeting-agenda`, `literature-review`, `webair`, `literature-review-legacy` |
| `dist/` | signed packages and wheels, current and historical, with SHA-256 ([dist/README.md](dist/README.md)) |
| `spec/` | the `agent.pkg`, `workflow.v0`, `memory.v0` and `compute.v0` specifications (`spec/memory-v0/` and `spec/compute-v0/` hold their machine contracts); `spec/extensions/` for noncritical manifest extensions (publisher-declared profiles) |
| `docs/` | guides and dated milestone reports ([index](docs/README.md)) |
| `examples/` | grants, inputs, public development keys, recorded runs, verification evidence ([examples/README.md](examples/README.md)) |
| `scripts/` | offline acceptance and verification scripts |
| `citation-resolver/` | the Citation Resolver service (FastAPI) |
| `demo/webair/` | the fictional WebAir origin (FastAPI), its deployment bundle and the package publisher tooling ([README](demo/webair/README.md)) |
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
agentpkg/.venv/bin/python scripts/verify_webair.py
agentpkg/.venv/bin/python scripts/check_release.py     # package identities, dist/ SHA-256 list, licenses
(cd openclaw-agent-browser && npm ci && npm run typecheck && npm test && npm run verify)
(cd citation-resolver && python3 -m venv .venv && .venv/bin/pip install -r requirements-dev.txt && .venv/bin/python -m pytest)
python3 -m venv demo/webair/.venv && demo/webair/.venv/bin/pip install -r demo/webair/requirements-dev.txt
(cd demo/webair && .venv/bin/python -m pytest && .venv/bin/python -m publisher check)
(cd chrome-agent-browser && npm ci && npm run typecheck && npm test && npm run build && npm run pack && npm run check-pack)
node conformance/run.mjs
```

Package sources must not contain stray files: the builder refuses names such as `.DS_Store`
(macOS Finder metadata) as non-portable, so delete them from `agents/` if a build or test reports
`unsafe/nonportable package path`.

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
CPython's `html` module and the dependencies bundled into the plugin artifact and the Chrome
extension, is listed with its terms in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md); the
extension's zip carries its own notices. Release procedure and checklist:
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
