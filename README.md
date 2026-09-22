# WebAgents — generically executable agent.pkg

A research prototype for portable, signed, inspectable agents under host-controlled authority. **agent.pkg 0.1** now has a generic execution profile, **workflow.v0**, implemented by agentpkg 0.2.0.

The same interpreter executes both [`literature-review.agent.pkg`](dist/literature-review.agent.pkg) and [`meeting-agenda.agent.pkg`](dist/meeting-agenda.agent.pkg). Graphs, skills, state mappings, schemas, tool contracts and application validation rules live in package data. The interpreter contains no application-specific orchestration or package-name dispatch.

```sh
# Existing development environment; for a new environment create agentpkg/.venv first.
agentpkg/.venv/bin/python -m pip install -e './agentpkg[dev]'
agentpkg/.venv/bin/agentpkg inspect dist/meeting-agenda.agent.pkg
agentpkg/.venv/bin/agentpkg verify dist/literature-review.agent.pkg \
  --trust-key examples/keys/workflow-publisher.pub.pem
agentpkg/.venv/bin/agentpkg run dist/literature-review.agent.pkg \
  --mode fixture --grants examples/literature-review-grants.json \
  --out examples/my-workflow-review
agentpkg/.venv/bin/agentpkg run dist/meeting-agenda.agent.pkg \
  --mode fixture --grants examples/meeting-agenda-grants.json \
  --out examples/my-workflow-agenda
```

Use new output directories. Fixture mode uses package-owned exact-input replay, performs no network/model inference, and reports synthetic usage. Its purpose is deterministic execution and enforcement testing. Supply `--input FILE.json` to use explicit input; a changed input needs matching fixture cases or a host model adapter. The example public keys establish development provenance, not independent certification.

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
It never executes a package — that boundary is enforced structurally and tested.

```sh
agentpkg/.venv/bin/agentpkg trust add --public-key examples/keys/workflow-publisher.pub.pem \
  --display-name "WebAgents development key" --publisher-id webagents-research
agentpkg/.venv/bin/agentpkg browser-serve --port 8765        # loopback only; prints a bearer token
curl -sS http://127.0.0.1:8765/v0/health
```

See the [control-plane documentation](docs/browser-control-plane.md) and the
[milestone report](docs/browser-report.md) for the API, trust model, SSRF
defenses and exact curl walkthrough.

## OpenClaw Agent Browser plugin

[`openclaw-agent-browser/`](openclaw-agent-browser/) is a native OpenClaw
feature plugin: a **Agent Browser** page in the Control UI where an operator
opens a signed package, reads its validation layers, signature and publisher
trust as separate facts, inspects its capabilities, tools, workers, workflow,
budgets and model requirements, sets each permission, and records an
authorization receipt. Its backend supervises `agentpkg browser-serve` and keeps
the control-plane bearer token in the Gateway process; the browser half holds no
credentials and reimplements no verification, trust or permission logic.

**Nothing executes.** There is no Run action in this milestone.

```sh
cd openclaw-agent-browser && npm install && npm run build && npm run validate && npm run pack
openclaw plugins install ./agent-browser.tgz --accept-capabilities
# then enable Settings -> Labs -> Custom plugin UI and open "Agent Browser"
```

See the [plugin documentation](docs/openclaw-agent-browser.md) and its
[README](openclaw-agent-browser/README.md). Tested against OpenClaw 2026.9.5.

The existing [OpenClaw staging adapter](docs/openclaw-integration.md) still verifies and stages either package. Native browser UI, real OpenClaw model routing, Muse, Instinct, Maritime, NANDA, registries and marketplace features are not implemented in this milestone.
