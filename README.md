# WebAgents — generically executable agent.pkg

A research prototype for portable, signed, inspectable agents under host-controlled authority. **agent.pkg 0.1** now has a generic execution profile, **workflow.v0**, implemented by agentpkg 0.2.2 ([current artifacts](dist/README.md)).

The same interpreter executes both [`literature-review.agent.pkg`](dist/literature-review.agent.pkg) and [`meeting-agenda.agent.pkg`](dist/meeting-agenda.agent.pkg). Graphs, skills, state mappings, schemas, tool contracts and application validation rules live in package data. The interpreter contains no application-specific orchestration or package-name dispatch.

Literature Review **0.2.5** exports each cited evidence row as its own extraction record; 0.2.4 had already made evidence jobs and final direct quotes deterministic, all with existing workflow primitives. Signed earlier archives are preserved. Current verification and live-provider status are in the [0.2.5 report](docs/literature-review-025-report.md).

```sh
# Existing development environment; for a new environment create agentpkg/.venv first.
agentpkg/.venv/bin/python -m pip install -e './agentpkg[dev]'
agentpkg/.venv/bin/agentpkg inspect dist/meeting-agenda.agent.pkg
agentpkg/.venv/bin/agentpkg verify dist/literature-review.agent.pkg \
  --trust-key examples/keys/literature-review-publisher.pub.pem
agentpkg/.venv/bin/agentpkg verify dist/meeting-agenda.agent.pkg \
  --trust-key examples/keys/meeting-agenda-publisher.pub.pem
agentpkg/.venv/bin/agentpkg run dist/literature-review.agent.pkg \
  --mode fixture --grants examples/literature-review-grants.json \
  --approve-tool scholarly-search --approve-tool citation-resolver \
  --approve-tool paper-reader \
  --out examples/my-workflow-review
agentpkg/.venv/bin/agentpkg run dist/meeting-agenda.agent.pkg \
  --mode fixture --grants examples/meeting-agenda-grants.json \
  --out examples/my-workflow-agenda
```

Every declared tool needs `--approve-tool` as well as its permission grant: a
granted permission describes a class of authority, an approval names one tool,
and the runtime refuses any tool that lacks one.

Use new output directories. Fixture mode uses package-owned exact-input replay, performs no network/model inference, and reports synthetic usage. Its purpose is deterministic execution and enforcement testing. Supply `--input FILE.json` to use explicit input; a changed input needs matching fixture cases or a host model adapter. The example public keys establish development provenance, not independent certification.

**Each shipped artifact has its own signer.** `meeting-agenda` 0.2.1 carries a rotated development key (`sha256:2bcc374a…c5c4`) and `literature-review` 0.2.1 another (`sha256:c5ca9763…5232`), because both packages' local-model policy had to change and the original key's private half exists on no machine here. The original key (`sha256:c7549e61…5a70`) still signs the preserved 0.2.0 artifacts. Each must be pinned separately, and a host that trusted one does not thereby trust another — [why, and what the trust store said about it](docs/package-execution-report.md#64-the-signing-key-rotation-and-what-the-host-made-of-it), and [the Literature Review rotation](docs/literature-review-execution-report.md). Private signing keys live outside this repository.

The runtime executes acyclic graphs with `llm`, `tool`, bounded `map`, `join`, `validate` and `output` nodes. Copied state views, declared writes, atomic wave commits, schema/relationship checks, permissions, global/worker budgets, deadlines, cancellation and structured audit all use generic machinery. Data-only packages never install executable code. Citation Resolver remains the existing standalone remote service.

Read the [formal workflow specification](spec/workflow-v0.md), [container specification](spec/agent-pkg-v0.md), [architecture and migration](docs/workflow-migration.md), [model interface](docs/model-router.md), and [milestone report](docs/workflow-report.md). The [Literature Review source](agents/literature-review) and [Meeting Agenda source](agents/meeting-agenda) are the canonical examples.

```sh
agentpkg/.venv/bin/python -m pytest agentpkg/tests
agentpkg/.venv/bin/python -m ruff check agentpkg
agentpkg/.venv/bin/python -m ruff format --check agentpkg
(cd citation-resolver && .venv/bin/python -m pytest)
agentpkg/.venv/bin/python scripts/verify_workflow.py
agentpkg/.venv/bin/python scripts/verify_browser.py
(cd openclaw-agent-browser && npm test && npm run verify)
```

The previous Literature Review runner, fixture/live providers and specialized evals remain explicitly available under `agentpkg.dev` with `agents/literature-review-legacy` and its original signed artifact. They are excluded from generic execution. See the [migration commands](docs/workflow-migration.md#commands).

## Agent browser control plane

`agentpkg browser-serve` starts the trusted local control plane that the future
OpenClaw Agent Browser will call: it opens a package from a local artifact or an
SSRF-hardened HTTPS URL, snapshots its bytes once, reports container, integrity,
schema and runtime validity separately, distinguishes a **self-consistent
signature** from a **trusted publisher**, renders a generic browser summary, and
turns explicit permission decisions into a digest-bound authorization receipt.
It then evaluates a **host-supplied** model catalog against the package's own
model requirements and freezes an explicitly chosen model into an immutable,
hashed **run plan**. It discovers no models of its own and never executes a
package — that boundary is enforced structurally and tested.

A separate trusted namespace, `agentpkg.hostbridge`, turns a ready run plan into
a `ModelRouter` bound to that exact model and reaches it through OpenClaw over a
private stdio protocol. The control plane cannot import it. One developer
[router probe](docs/model-router-bridge.md) makes a single host-owned model call
to prove the router contract.

A third namespace, [`agentpkg.execution`](docs/package-execution.md), composes
those two with the generic interpreter and **runs a signed package**. It receives
the control plane's immutable snapshot as a one-time lease over an inherited
descriptor, re-verifies its hash, digest, identity, signature and signer, carries
the person's decisions through unchanged, applies host limits that can only lower
package budgets, and calls `Workflow.run`. Since milestone 3C the Agent Browser
page starts it too, through the same operation and the same re-verification.

A fourth namespace, [`agentpkg.toolbridge`](docs/tool-broker.md), is the tool
half of the same shape: one generic `ToolHandler` with no transport, no
credential and no service vocabulary, parameterized by one **host tool binding**
a run plan froze and reaching a trusted broker in the OpenClaw plugin. A package
declares *what* capability it needs; the host decides *what implements it*; the
person approves that implementation as a decision separate from the permission
it travels under; and `Runtime.call_tool` remains the only path.

```sh
# Each current package has its own development key; pin each for its own package id.
agentpkg/.venv/bin/agentpkg trust add --public-key examples/keys/literature-review-publisher.pub.pem \
  --display-name "WebAgents Literature Review development key" --publisher-id webagents-research \
  --package-id-prefix org.webagents.literature-review
agentpkg/.venv/bin/agentpkg trust add --public-key examples/keys/meeting-agenda-publisher.pub.pem \
  --display-name "WebAgents Meeting Agenda development key" --publisher-id webagents-research \
  --package-id-prefix org.webagents.meeting-agenda
agentpkg/.venv/bin/agentpkg browser-serve --port 8765        # loopback only; prints a bearer token
curl -sS http://127.0.0.1:8765/v0/health
```

See the [control-plane documentation](docs/browser-control-plane.md) and the
[milestone report](docs/browser-report.md) for the API, trust model, SSRF
defenses and exact curl walkthrough, and [model selection and the run
plan](docs/model-selection-and-run-plan.md) for compatibility semantics and the
run-plan schema, and [the model-router
bridge](docs/model-router-bridge.md) for how a plan reaches the selected model.

## OpenClaw Agent Browser plugin

[`openclaw-agent-browser/`](openclaw-agent-browser/) is a native OpenClaw
feature plugin: a **Agent Browser** page in the Control UI where an operator
opens a signed package, reads its validation layers, signature and publisher
trust as separate facts, inspects its capabilities, tools, workers, workflow,
budgets and model requirements, sets each permission, records an authorization
receipt, then chooses one of the models **this OpenClaw host actually reports**
and prepares a run plan. Its backend supervises `agentpkg browser-serve`, keeps
the control-plane bearer token in the Gateway process, and is the only place that
knows what OpenClaw is; the browser half holds no credentials and reimplements no
verification, trust, permission or compatibility logic.

**The page runs what it authorized** (milestone 3C). A task form generated from
the package's own input schema, a Run button that opens only when every check
holds and says precisely why it does not, live progress from the run's own
record, Cancel, reconnect after a reload, the result rendered as safe Markdown,
artifacts to view and download, and the technical audit, usage and provenance.
Run sends only `{sessionId, runPlanId, runPlanSha256, input, files, detach}`;
the model, tools and files all resolve through state the session already
authorized, and everything is re-verified before anything executes. There is no
chat and no general execution API.

```sh
cd openclaw-agent-browser && npm install && npm run build && npm run validate && npm run pack
openclaw plugins install ./agent-browser.tgz --accept-capabilities
# then enable Settings -> Labs -> Custom plugin UI and open "Agent Browser"
```

See the [plugin documentation](docs/openclaw-agent-browser.md), [model selection
and the run plan](docs/model-selection-and-run-plan.md), [package
execution](docs/package-execution.md), [the tool broker](docs/tool-broker.md)
and its [README](openclaw-agent-browser/README.md). Tested against OpenClaw
2026.9.5.

A signed package has now **run for real** on this host: `meeting-agenda` 0.2.1 on a local `ollama/qwen3.5:9b`, completed, five model calls all on the bound model, three genuinely concurrent perspective workers, zero tool calls, a valid 89-event audit chain, $0, and an agenda whose minutes sum to exactly 45 — with the run plan byte-identical afterwards and `execution.performed` still false. The [milestone report](docs/package-execution-report.md) has the timeline, the measured timing policy behind 0.2.1, the signer rotation, and the structured-output defect that the timeout had been hiding.

A signed package has also now **called a real tool**: `literature-review` 0.2.0's
declared `citation-resolver`, through a host binding it could not name, at the
exact origin its own manifest declares, under a permission and an approval given
separately — one tool call, one remote call, zero tokens, zero model calls, zero
workflow workers, a valid 15-event audit chain, and real Crossref metadata with
BibTeX validated against the package's own output schema. The probe runs under a
strictly smaller `tool_probe` authority that binds one tool and no model at all.
The [tool-broker report](docs/tool-broker-report.md) has the numbers and the
refusals. (In 3B3 the other two tools had no implementation, so a model run plan
for that package was refused by name; 3B4 supplied both — see below.)

The **Literature Review agent has now run for real** (milestone 3B4): `literature-review` 0.2.1, signed by its own key, completed through the signed graph on a local `ollama/qwen3:30b` against live Crossref and the live Citation Resolver — 16 model calls all on the bound model, 3 searches, 3 resolutions, peak 3 concurrent workers, 120,242 tokens, $0, a valid 404-event audit, every package assertion and 28 of 28 independent acceptance checks passing, and the run plan byte-identical afterwards. Getting there took two new host tools (a Crossref adapter whose request shape is host code, and a reader of operator-selected PDFs by opaque capability), a measured bounded-work and timing policy, an output contract stated where the package's own validation already required it, and three refused attempts, each classified from its audit. The [milestone report](docs/literature-review-execution-report.md) has every change, the evidence behind it, the model comparison, the runs and what the agent wrote.

The existing [OpenClaw staging adapter](docs/openclaw-integration.md) still verifies and stages either package. Per-worker or per-node model routing, a run history database (a finished run is re-read from its own run directory, read-only), browser file upload, conversation or service profiles, Muse-specific connectors, Instinct, Maritime, NANDA, registries and marketplace features are not implemented — see [future work](#after-the-demo-future-work).

## Demo: the Literature Review agent from the browser

Milestone 3C. Everything below happens in the OpenClaw Control UI; no operator
script is involved. The accepted UI-started run and its evidence are in the
[milestone report](docs/demo-experience-report.md) and
[`ui-acceptance-3c.json`](examples/verification/ui-acceptance-3c.json).

**Once per host** (already true on the development host): the plugin is built,
packed and installed as in its
[README](openclaw-agent-browser/README.md#build-verify-and-install) with
`localPackages.roots` containing this repository's `dist/`,
`llm.allowModelOverride: true`, `sessionTtlSeconds: 7200` and the `execution`
bounds listed there (`runTimeoutSeconds: 4500`); **Settings → Labs → Custom
plugin UI** is on; and the Literature Review signing key
`sha256:c5ca9763…5232` is pinned for `org.webagents.literature-review` (step 5
shows how if it is not).

1. **Start the OpenClaw Gateway.** `openclaw gateway status` should say
   *running* and *Connectivity probe: ok*; otherwise `openclaw gateway start`
   (or `openclaw gateway restart` after installing the plugin).
2. **Ensure Ollama is available.** `ollama list` shows `qwen3:30b`. Nothing needs
   to be loaded by hand: the first model call loads it.
3. **Open Agent Browser.** `openclaw dashboard` opens the Control UI; choose
   **Agent Browser** in the sidebar. The header reads *Control plane running*
   and *runs available*.
4. **Open the Literature Review package.** Expand *Open a local package
   (operator directories)*, enter `<repo>/dist/literature-review.agent.pkg`,
   press **Open file**. The Run panel opens at the top with *✓ Package
   verified*; **Verification and trust** shows Container, Integrity, Schema and
   Runtime valid, the signature cryptographically valid, and signer
   `sha256:c5ca9763…5232`.
5. **Trust and permissions.** If the publisher is not yet trusted, use *Review
   publisher key* → *Trust this publisher key* (press twice). In
   **Permissions** set `network.scholarly`, `network.citations`,
   `memory.session` and `model.reasoning` to *Allow for session* and leave
   `files.pdfs` on *Deny*; tick the three **Tool approvals**; press
   **Authorize** (*The package has NOT executed*). **Package contents → Tools**
   now shows each host implementation — `openclaw:scholarly-search:1`
   (Crossref), `openclaw:citation-resolver:1`, `openclaw:paper-reader:1`.
6. **Select the model.** In **Model**, choose **qwen3:30b** from the list this
   host reports. Nothing is preselected, and the page names no model itself.
7. **Prepare the Run Plan.** Press **Prepare run** → **Ready to run**, with the
   run plan's id and hash.
8. **Enter the research question** in the Run panel: *What defenses have been
   proposed against prompt injection attacks on LLM-integrated applications?*
   Leave *Optional* (no documents, no seed papers) and *Advanced* (mode `live`)
   as they are. Every checklist line turns ✓, including *Authorization valid for
   N more min (a run may take up to 76 min)*.
9. **Run.** Press **Run Research**.
10. **Inspect progress.** Planning → Scholarly search → Screening → Citations →
    Evidence extraction → Synthesis → Writing → Verification, each fan-out's
    workers, and the model, tool and remote calls and tokens, all from the
    run's own record. **Cancel** stops a run within seconds; reloading the page
    reconnects to it.
11. **Inspect the result, artifacts and audit.** *✓ Research completed*, the
    **Related work**, the **Summary** (papers included, evidence items, claims
    verified, unresolved), **Artifacts** with View and Download (SHA-256
    verified), and **Technical details** (plan, model and every call on it,
    tools and bindings, permissions, usage, cost, audit chain, workers,
    re-verified checks). A run that finds nothing grounded completes too, with
    *No sufficiently grounded literature found* and empty tables — a correct
    outcome, not an error.

**Timing — it is not instantaneous.** On this Mac with `qwen3:30b` a run takes
tens of minutes: the accepted UI-started run took 27 min 10 s (17 model calls,
9 tool calls, 107,284 tokens, $0); earlier ones took about 40 minutes. Start
the run within about 44 minutes of opening the package, because the
authorization must outlast the whole run deadline. For a presentation,
**pre-start a live run** before the audience arrives, show a completed real run
from **Recent runs** for the results, and walk through the fresh run's first
stages live.

### After the demo: future work

Recorded as post-demo work and deliberately not implemented in 3C:

- **Scholarly search federation.** Today `scholarly-search` → Crossref. Next:
  host-federated scholarly search → Crossref + arXiv + OpenAlex, optionally
  Semantic Scholar — better recent-AI coverage, arXiv-first papers, better
  metadata and abstract availability, and source redundancy. The package still
  requests the *same* abstract capability, `scholarly-search`; only the host's
  implementation changes, so no package or runtime redesign is needed.
  Crossref-only coverage is why a run on a recent AI topic such as prompt
  injection may include only a few papers.
- **Execution profiles.** `conversation.v0` and `service.v0`. For now
  `workflow.v0` = one input → one run → one result; there is no chat.
- NANDA discovery and remote package locators; Muse / Instinct; Maritime /
  sandboxed deployment; persistent authorization (*Always*); richer evals and
  attestations; a package update UX; model-provider redundancy.
