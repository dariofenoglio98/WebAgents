# network.v0 examples

The test package, the travel example and the enforcement cases of
[network.v0](../../spec/network-v0.md) (agentpkg 0.7.0, T25). Nothing here is shipped in
`dist/`; the data is fictional.

| Path | What it is |
|---|---|
| [`network-test/`](network-test/README.md) | `org.webagents.network-test` 0.1.0, a fictional help desk: `Desk` (the entry; one model step, a model-chosen route) hands off to `Lookup` (one local tool, a fixed return) at most twice or `Writer` (one model step, a fixed return) once, within six handoffs, and ends with its answer. Its fixture walk is Desk, Lookup, Desk, Writer, Desk, done |
| `network-test.agent.pkg` | the archive of that source (signed with `examples/keys/network-test-publisher.pub.pem` once the key exists); the test suites and the conformance suite run it |
| `network-test-grants.json` | the grants of the fixture run: every permission `session` (a network activates roles more than once, so `once` is refused by the host's rule) |
| [`travel-network/`](travel-network/README.md) | `org.webagents.travel-network` 0.1.0, an unsigned source: `FrontMan` consults `Flights`, `Hotel` and `Calendar`, each at most once within six handoffs, then ends with the plan; the star whose bound is exact and attained by the full tour (sixteen walks, every one run by `agentpkg/tests/test_network_travel.py`) |
| `travel-network-grants.json` | the grants of its fixture run |
| [`cases/cases.json`](cases/cases.json) | the enforcement cases (§7 of the spec): what both runtimes must refuse, at which stage, with which code; built by `agentpkg/tests/network_probe.py` and asserted by `test_network_cases.py` |
| `make_network_examples.py` | writes both sources (the route cases of each fixture carry exactly the request data the runtime builds) and the unsigned test archive; a test asserts the committed sources are its output |

Run the fixture walks from the repository root:

```sh
agentpkg/.venv/bin/agentpkg run examples/network/network-test.agent.pkg \
  --mode fixture --grants examples/network/network-test-grants.json \
  --approve-tool lookup --trust-key examples/keys/network-test-publisher.pub.pem \
  --out examples/my-network-test

agentpkg/.venv/bin/agentpkg run examples/network/travel-network \
  --mode fixture --grants examples/network/travel-network-grants.json \
  --approve-tool search-flights --approve-tool search-hotels --approve-tool check-calendar \
  --out examples/my-travel-network
```

`audit.json` then holds `network.started` with the bound and the reservation, one
`network.activated` per activation, a `route.decided` for every handoff with the reason it was
allowed, a `network.state.committed` per patch and `network.completed`; `agentpkg inspect` on
either package prints the envelope (`network`). `scripts/verify_network.py` checks all of it
offline.
