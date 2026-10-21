# conversation.v0 machine contracts

The normative text is [`../conversation-v0.md`](../conversation-v0.md). This folder holds what a
runtime implements against and what `scripts/verify_conversation.py` validates:

| File | What it is |
|---|---|
| `workflow.schema.patch.json` | RFC 6902: `workflow.schema.json` gains the top-level `conversation` object (§2.1), the value source `conversation` (§2.1, V-4), and on nodes the `consent` type with `permissions` and `text` and their conditionals (§2.2). Applied to agentpkg's live schema by T23; the Chrome copy is synced from it. |
| `consent-decision.schema.json` | The result of a consent step, `{"accepted": boolean}`, closed. A package ships a copy as the step's `output_schema`; a runtime binds only an equal canonical document (V-18). |
| `transcript-input.schema.json` | What a host replays into a conversation: messages in order and, per turn, the consent decisions (§7, V-14). The package's conversation fixture is this document. |
| `transcript.schema.json` | What a conversation leaves behind: every turn with its decisions as taken, the persisted state, the budget and how it ended (§7, V-16). |
| `policy-bundle-v0.schema.patch.json` | RFC 6902: the Chrome line's policy bundle (`spec/extensions/policy-bundle-v0.schema.json`) gains the optional `consent` section of D-271 (`pre_decide`, `forbid_kinds`): what a signed policy says about consent steps. Applied by the Chrome core only (T24); agentpkg does not read policy bundles. |

agentpkg keeps byte-equal copies of the three schemas under `agentpkg/src/agentpkg/schemas/
conversation/` (a test asserts it). The enforcement cases (§10) are listed in
[`examples/conversation/cases/cases.json`](../../examples/conversation/cases/cases.json) and
built by the probe `agentpkg/tests/conversation_probe.py`; the test package is under
[`examples/conversation/`](../../examples/conversation/).

Run the check from the repository root:

```sh
agentpkg/.venv/bin/python scripts/verify_conversation.py
```

It prints a JSON report with `"passed"`, and exits 1 on any failure.
