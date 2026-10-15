# agentpkg changes

Versions of the reference runtime. A package declares the runtime it needs in
`runtime.minimum_version`; a runtime refuses a package that asks for a newer one. Release
assets and identities are in [dist/README.md](../dist/README.md).

## 0.4.0 (development line, 2026-10-14)

memory.v0 ([`spec/memory-v0.md`](../spec/memory-v0.md), T20, D-210): a user-owned memory of
Markdown records that packages touch only through three permission uses.

- **Permission kinds** `memory.read` (one type; `personal.read` stays its alias for the three legacy
  ids) and `memory.write`, `memory_types` for custom types, `memory.scope: "agent-scoped"` with the
  two reserved agent-document tools, and the export format `memory.proposal` (the RFC 6902 patches
  of `spec/memory-v0/` applied to `policy.schema.json` and `workflow.schema.json`).
- **Validation** of what a package may declare about memory (M-18, M-19, M-33, M-38, M-48, M-67),
  each refusal starting with the spec's code; packages that use memory.v0 declare runtime minimum
  0.4.0, and 0.3.x runtimes refuse them by that minimum.
- **Runtime:** the sealed-value scans of tool arguments (M-36) and of every model request (M-37); the
  proposals check on completion (M-40) with `memory.proposed`, and `proposals.json` written only
  when it passes; the agent document committed only after `workflow.completed`; the report's
  `memory` section (D-231). A package that uses none of it runs and reports exactly as before.
- **`agentpkg run --memory-dir DIR --memory-grant PERMISSION=RECORD`** (D-230): a memory folder (an
  export folder with its `memory.key`) as the store, a record per permission; fixture mode derives
  the grants and the scan set from the replayed answers (M-62).
- `agentpkg.memory`: the record format (the YAML subset, the canonical document, the HMAC digest,
  views and links), the starter taxonomy and custom types, and the folder reader, held to the
  specification's contracts and reference script by tests.
- The 0.4.0 wheel is `dist/agentpkg-0.4.0-py3-none-any.whl` (it carries the memory.v0 contracts
  under `agentpkg/schemas/memory/`); CI rebuilds it from this directory and compares every file.

## 0.3.0 (development line, 2026-10-10)

The first version of the development line (`main`, D-019); the paper's code stays 0.2.2 on the
`paper-cic2026` line.

- **Answer checks** (workflow.v0, [spec §5](../spec/workflow-v0.md)): an `llm` node or map `llm`
  step may declare `checks`, the existing `equal`, `sum` and `relation` assertions evaluated on its
  schema-valid answer, named `{"from": "result"}`. A refused check fails the model call as a
  non-conforming answer: `model.failed` with reason `model_output_not_conforming`,
  `failure_facts.output_failure: "check"` and `failed_check` (the check's index, kind, failure and
  the package's own pointers, never data), charged what the router reported; the node fails
  `model_error`, and its `node.failed` names the check too. A graph that declares `checks` must
  declare `runtime.minimum_version` 0.3.0 or later; earlier runtimes refuse it by that minimum.
- **The model request's `feedback` line** ([spec §7](../spec/workflow-v0.md)): an optional string of
  up to 1,000 characters in `model-request.schema.json`, which the host-bridge renderer appends as
  the last system section (`## Correction`) and counts. A host that re-asks a model sends it; this
  runtime asks no model twice (its live re-ask is staged, BACKLOG).
- **Profile-scoped approvals** in the control plane (T7, D-090), already on `main` since 2026-10-08
  but not in any shipped wheel until this one.
- The 0.3.0 wheel is `dist/agentpkg-0.3.0-py3-none-any.whl`; CI rebuilds it from this directory and
  compares every file.

## 0.2.2 (the v0.2.0 release)

`allocate` (exact integer allocations, spec §4). The wheel was rebuilt twice under this version,
for v0.1.0 and v0.2.0; the second rebuild added website package discovery and host-owned resources
(`personal.read`). [dist/README.md](../dist/README.md) lists what each rebuild changed.

## 0.2.1

`lookup` (keyed selection, spec §4).
