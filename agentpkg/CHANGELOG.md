# agentpkg changes

Versions of the reference runtime. A package declares the runtime it needs in
`runtime.minimum_version`; a runtime refuses a package that asks for a newer one. Release
assets and identities are in [dist/README.md](../dist/README.md).

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
