# compute.v0 machine contracts

The normative text is [`../compute-v0.md`](../compute-v0.md). This folder holds what a runtime
implements against and what `scripts/verify_compute.py` validates:

| File | What it is |
|---|---|
| `workflow.schema.patch.json` | RFC 6902: `workflow.schema.json` gains the top-level `modules` list and, on nodes and map steps, the `compute` type with `module`, `function`, `input_schema` and `limits` and their conditionals (§2). Applied to agentpkg's live schema by T21; the Chrome copy is synced from it. |
| `policy.schema.patch.json` | RFC 6902: the permission kind `compute` (§2.3). Applied by T21. |
| `audit-event.schema.patch.json` | RFC 6902: the node code `compute_error` (§6). Applied by T21. |
| `policy-bundle-v0.schema.patch.json` | RFC 6902: the policy bundle's `decisions` gain `compute` (§2.3). Applied by T22 to the spec copy and the Chrome copy together. |

The enforcement cases (§10) live with their modules under
[`examples/compute/cases/`](../../examples/compute/cases/): `cases.json` lists every case with its
stage, code and reason; `build_cases.py` emits the hand-assembled modules; `modules/*.wasm` are
the committed bytes. The example modules and the test package are under
[`examples/compute/`](../../examples/compute/).

Run the check from the repository root (it needs the `wasmtime` extra):

```sh
agentpkg/.venv/bin/python scripts/verify_compute.py
```

It prints a JSON report with `"passed"`, and exits 1 on any failure.
