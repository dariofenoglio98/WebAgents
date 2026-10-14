# memory.v0 machine contracts

The normative text is [`../memory-v0.md`](../memory-v0.md). This folder holds what a runtime
implements against and what `scripts/check_memory_spec.py` validates:

| File | What it is |
|---|---|
| `memory-record.schema.json` | A parsed record: frontmatter keys, the type's fields under `fields`, the body under `body` (§2). |
| `memory-type.schema.json` | A type definition (§4.1); its `fields_schema` refuses reserved field names (M-8). |
| `memory-proposals.schema.json` | The `memory.proposal` export document (§7.2). |
| `memory-record-view.template.json` | The construction of a type's record view schema (M-16), placeholder left in. |
| `taxonomy.json` | The starter taxonomy (§11): twelve types with schemas, sealed fields, identity fields, default links, display rules and the three legacy aliases. |
| `policy.schema.patch.json` | RFC 6902: `policy.schema.json` gains the kinds `memory.read` and `memory.write` and the optional `memory_types` (§4.4). Applied by T20. |
| `workflow.schema.patch.json` | RFC 6902: `exports[].format` gains `memory.proposal`. Applied by T20. |
| `policy-bundle-v0.schema.patch.json` | RFC 6902: the policy bundle's `decisions` gain the two kinds and the bundle gains `memory` (§7.6). Applied by T19 to the spec copy and the Chrome copy together. |
| `examples/webair-0.6.0/`, `examples/literature-review-0.2.8/` | The worked examples (§12): policy, tools, view schemas, exports, fixture answers, a `proposals.json` and the memory folder after acceptance. |

Run the check from the repository root:

```sh
agentpkg/.venv/bin/python scripts/check_memory_spec.py
```

It prints a JSON report with `"passed"`, and exits 1 on any failure.
