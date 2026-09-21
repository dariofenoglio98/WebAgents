# Literature Review Agent — workflow.v0

Version 0.2.0 is a data-only package executed by the same generic interpreter as Meeting Agenda. `MANIFEST.agent` selects `workflow.v0`; **graph.json is the only authoritative execution graph**. The seven skills describe domain behavior; schemas and declared validation assertions enforce the structured contracts.

The graph performs planning, seed resolution, parallel search, join/normalization/deduplication, parallel screening, citation resolution, evidence preparation and parallel extraction, synthesis, writing, verification and declared exports. Citation Resolver remains a remote tool consumed through its existing contract. Conditional selected-PDF reads remain worker-local. Exact quote/page checks, record links and resolver metadata checks use generic validation nodes.

`fixtures/workflow.json` owns the exact-input model/tool replay scenario. It is synthetic: three searches, eight candidates, six citation resolutions, three bibliography entries and ten evidence items. It includes resolved, ambiguous, not-found and provider-error responses. Replay does not infer answers to new questions or establish model quality. The original fixture dataset and application schemas remain available; old specialized eval definitions are historical data and are not claimed as the new generic eval harness.

```sh
# Run from repository root, with a new output directory.
agentpkg/.venv/bin/agentpkg run dist/literature-review.agent.pkg \
  --mode fixture --input examples/literature-review-input.json \
  --grants examples/literature-review-grants.json --out examples/my-workflow-review
```

`result.json`, `audit.json`, `usage.json` and `provenance.json` identify `agentpkg.workflow.Workflow`. Graph-declared exports include Related Work Markdown, bibliography, evidence table, unresolved records and verification results.

The package retains session memory, depth-one local workers, three concurrent workers, 180,000 synthetic/model token units, 45 remote dispatches and the existing per-tool limits. Actual authority comes from host grants. Fixtures use the same enforcement path and consume declared remote dispatch capacity despite making no network requests.

The earlier extractive/real-provider runner is separately preserved with `agents/literature-review-legacy`, `dist/literature-review-legacy.agent.pkg`, and `agentpkg.dev`. It is not used by this graph. See [migration details](../../docs/workflow-migration.md) and the [execution specification](../../spec/workflow-v0.md).
