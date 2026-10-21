# conversation.v0 examples

The test package and the enforcement cases of [conversation.v0](../../spec/conversation-v0.md)
(agentpkg 0.6.0, T23). Nothing here is shipped in `dist/`; the data is fictional.

| Path | What it is |
|---|---|
| [`conversation-test/`](conversation-test/README.md) | `org.webagents.conversation-test` 0.1.0, a fictional ticket desk: a `Clerk` model step per message, the conversation's `history` and `orders` as persistent state, a consent step before the `place-order` write tool, an end rule. Its fixture transcript is two turns: an order confirmed, then goodbye |
| `conversation-test.agent.pkg` | the signed archive of that source (key `examples/keys/conversation-test-publisher.pub.pem`); the test suites and the conformance suite run it |
| `conversation-test-grants.json` | the grants of the fixture conversation: every permission `session` (the simulated order permission is `payment`, confirmed by the consent step at run time) |
| [`cases/cases.json`](cases/cases.json) | the enforcement cases (§10 of the spec): what both runtimes must refuse, at which stage, with which code; built by `agentpkg/tests/conversation_probe.py` and asserted by `test_conversation_cases.py` |

Run the fixture conversation from the repository root:

```sh
agentpkg/.venv/bin/agentpkg converse examples/conversation/conversation-test.agent.pkg \
  --mode fixture --grants examples/conversation/conversation-test-grants.json \
  --approve-tool place-order --trust-key examples/keys/conversation-test-publisher.pub.pem \
  --out examples/my-conversation-test
```

`examples/my-conversation-test/` then holds `transcript.json` (the person's record: both turns,
the consent decision with the text and the facts, the reply, the persisted state, the budget),
`audit.json` (one hash chain across both turns), `state.json`, `usage.json`, `provenance.json`,
and `turn-001/`, `turn-002/` with each turn's artifacts. `scripts/verify_conversation.py` checks
all of it offline.
