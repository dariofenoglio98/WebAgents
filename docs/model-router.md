# Host model-router interface

`workflow.v0` calls a host-selected `ModelRouter` protocol from `agentpkg/interfaces.py`. It does not import OpenClaw, OpenAI, Muse, or another model provider. A future browser adapter implements the same interface for its user-selected models.

There are two operations: `count_tokens(request)` returns a nonnegative complete input bound, and `complete(request, max_output_tokens=N)` returns structured `output`, `input_tokens`, and `output_tokens` (optionally `cost_usd`). Separating counting and generation allows atomic global/per-worker reservation before generation starts.

A request includes task `requirements`, signed role skill `instructions`, untrusted input `data`, a bundled offline `output_schema`, a `budget_context` containing the maximum output allowance, and an `audit_context` identifying worker and node. The host validates capabilities, context capacity and local-only privacy before any dispatch. The model cannot choose tools, write state, spawn workers, raise limits or authorize itself: the canonical graph and host mediator own those actions.

A remote counting operation and completion each count toward remote-call budgets. A single model grant covers both, consumed before preflight discloses context. The runtime reserves counted input plus maximum output. Concurrent reservations count toward hard caps and approval thresholds. Unknown failure/cancellation usage consumes the full reservation; known usage settles it. Invalid/over-limit usage halts subsequent dispatch and preserves known charges.

Adapters must count every billable/reasoning token, enforce the output cap, bound their own I/O, and cooperate with cancellation. These are trusted-host contracts; an external provider that lies cannot be retroactively prevented from overspending. Schema/relationship checks do not establish semantic answer quality.

`FixtureRouter` is a local, domain-independent exact-input replay adapter. The package contains task/input/output cases. It uses a clearly synthetic accounting unit (`ceil(JSON UTF-8 bytes / 4)`) to exercise budget admission and settlement without inference. Unmatched requests fail. There are no task-name branches or domain algorithms inside the adapter.

The previous optional `HTTPRouter` in `models.py` remains available. It uses the existing host-configured `/count` and `/complete` protocol, approved HTTPS transport and environment-held credentials. This milestone does not connect a new real provider. The legacy extractive development workflow is separate under `agentpkg.dev` and does not implement reasoning inside the generic interpreter.

See the [formal contract and failure rules](../spec/workflow-v0.md#7-model-router-contract) and [migration](workflow-migration.md).
