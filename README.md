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
```

The previous Literature Review runner, fixture/live providers and specialized evals remain explicitly available under `agentpkg.dev` with `agents/literature-review-legacy` and its original signed artifact. They are excluded from generic execution. See the [migration commands](docs/workflow-migration.md#commands).

The existing [OpenClaw staging adapter](docs/openclaw-integration.md) still verifies and stages either package. Native browser UI, real OpenClaw model routing, Muse, Instinct, Maritime, NANDA, registries and marketplace features are not implemented in this milestone.
