# Meeting Agenda Agent — workflow.v0

A small, independent, data-only example proving that package execution is generic. Its canonical `graph.json` contains planning → bounded perspective map → join → writing → validation → output. The planner, perspective and writing skills contain all domain instructions. There are no tools, downloaded modules or host-side Meeting Agenda functions.

Input contains `goal`, `participants` (name/role records), `context`, and integer `duration` in minutes. Output contains an agenda with owners and time allocations, preparation items, decisions and questions. Generic `equal` and `sum` assertions preserve the requested goal/duration and enforce the total time.

The fixture uses three participant perspectives for a 45-minute documentation pilot meeting, allocated 5/15/15/10 minutes. It is exact-input replay, not a real model; changing the request requires another fixture or a compatible host model router. An empty perspective map is supported by the execution model.

```sh
# From repository root, choose a new output directory.
agentpkg/.venv/bin/agentpkg run dist/meeting-agenda.agent.pkg \
  --mode fixture --input examples/meeting-agenda-input.json \
  --grants examples/meeting-agenda-grants.json --out examples/my-workflow-agenda
```

The package requests model and session-memory permissions, bounded token/remote-call budgets, depth-one delegation and at most three concurrent workers. Fixture execution makes no remote calls. The `agenda.json` export and generic run/audit/usage/provenance files expose the result.

See [workflow.v0](../../spec/workflow-v0.md) and the [migration/genericity explanation](../../docs/workflow-migration.md).

## 0.2.2: exact input and allocation preservation

The planner returns focus items; perspective workers map directly over the input
participants. The writer returns a draft with at most ten topics and positive
integer time estimates. A structural `assemble` node copies the input goal and
duration and uses workflow.v0 `allocate` to apportion minutes to that exact total.
It preserves all topics, order, owners, and other content; already exact estimates
stay unchanged. The ten-topic bound fits every allowed input duration (10–240).
The three original final assertions are unchanged. Five model calls still occur
for three participants. Runtime 0.2.2 is required for the generic constructor.
