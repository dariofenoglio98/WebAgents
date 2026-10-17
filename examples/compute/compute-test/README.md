# Compute Test

`org.webagents.compute-test`: a model-free `workflow.v0` package that exists to exercise
[compute.v0](../../../spec/compute-v0.md) in both runtimes. It ships the two example modules of
`examples/compute/` and runs them in one wave (`totals` on the AssemblyScript fare module,
`ids` and `quotes` on the Rust bookkeeping module) and in a map step (`groups`, one call per fare
group), then checks the results with the ordinary `validate` assertions. The data is fictional.

It is signed with a development key (`examples/keys/compute-test-publisher.pub.pem`) for the
test suites and the conformance suite, and is not shipped in `dist/`. Rebuild it with
`python3 examples/compute/make_compute_test.py` after a module changes; a changed module is a new
version of this package and a new signature.
