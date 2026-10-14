# memory.v0 machine contracts

The normative text is [`../memory-v0.md`](../memory-v0.md). This folder holds what a runtime
implements against and what `scripts/check_memory_spec.py` validates:

| File | What it is |
|---|---|
| `memory-record.schema.json` | A parsed record: frontmatter keys, the type's fields under `fields`, the body under `body` (§2). |
| `memory-type.schema.json` | A type definition (§4.1); its `fields_schema` refuses reserved field names (M-8). |
| `memory-proposals.schema.json` | The `memory.proposal` export document (§7.2). |
| `memory-record-view.template.json` | The construction of a type's record view schema (M-16), placeholder left in; the view carries `sealed` (M-15). |
| `memory-empty-input.schema.json`, `memory-agent-read.output.schema.json`, `memory-agent-write.input.schema.json`, `memory-agent-write.output.schema.json` | The exact schemas of the reserved agent-document tools `host.memory.agent.read` and `host.memory.agent.write` (M-48); a package ships copies and the host binds only equal canonical JSON. |
| `taxonomy.json` | The starter taxonomy (§11): twelve types with schemas, sealed fields, identity fields, default links, display rules and the three legacy aliases. |
| `policy.schema.patch.json` | RFC 6902: `policy.schema.json` gains the kinds `memory.read` and `memory.write` and the optional `memory_types` (§4.4). Applied by T20. |
| `workflow.schema.patch.json` | RFC 6902: `exports[].format` gains `memory.proposal`. Applied by T20. |
| `policy-bundle-v0.schema.patch.json` | RFC 6902: the policy bundle's `decisions` gain the two kinds and the bundle gains `memory` (§7.6). Applied by T19 to the spec copy and the Chrome copy together. |
| `examples/webair-0.6.0/`, `examples/literature-review-0.2.8/` | The worked examples (§12): policy, tools, view schemas, exports, fixture answers, a `proposals.json`, the memory folder after acceptance (sealed values in clear, as a `--memory-dir`), WebAir's `memory-export-omitted/` (the same memory with sealed values omitted, M-56) and Literature Review's agent tools and agent document. |

The check script also demonstrates the negative cases N1, N2, N8, N9, N13–N17 and N19–N22 of §10
over these examples (`negative_cases` in its report), that a record view renders the links the run
was not granted without their ids and that an `update` echoing it passes (M-15, M-42, the WebAir
example's `accepted_updates`), an export-then-import round trip over every link form, the stem
rules, the mirror, a dangling target and the hub after "Forget everything" (`round_trip`, M-55,
M-57, M-59, M-60), and the YAML subset's reader and writer (`yaml_subset`, M-7).

Run the check from the repository root:

```sh
agentpkg/.venv/bin/python scripts/check_memory_spec.py
```

It prints a JSON report with `"passed"`, and exits 1 on any failure.
