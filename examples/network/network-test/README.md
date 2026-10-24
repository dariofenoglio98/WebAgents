# Network Test

`org.webagents.network-test`: a fictional help desk that exists to exercise [network.v0](../../../spec/network-v0.md) in both runtimes. `Desk` (the entry) reads each message, keeps a note and chooses, at a model-chosen route, between `Lookup` (one local tool call over a fictional index, a fixed return) and `Writer` (one model step, a fixed return), or ends with its answer; the shared state holds the notes, the answers and the draft, each role seeing only its declared part. The fixture walk is Desk, Lookup, Desk, Writer, Desk, done. The data is fictional.

It is signed with a development key (`examples/keys/network-test-publisher.pub.pem`) for the test suites and the conformance suite, and is not shipped in `dist/`. Regenerate the sources with `python3 examples/network/make_network_examples.py`; a changed source is a new version of this package and a new signature.
