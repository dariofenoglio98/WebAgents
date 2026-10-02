# Threat model (version 1.0)

This experiment asks how effectively WebAgents detects and contains violations of the
**package-to-execution contract**, and which enforcement component is responsible for each. It
is a controlled fault-injection evaluation of guarantees the implementation makes. It is **not**
a complete security benchmark, a penetration test, or a measure of robustness against an
arbitrary attacker.

## The contract under test

A person opens a signed agent package in the Agent Browser, sees what it asks for, grants
permissions and tool approvals, selects a model and files, and starts a run. The contract is
that the run which then executes is exactly the package that was verified, from a publisher
the operator trusts, under the authority the person granted, on a host that satisfies the
package's requirements, bound to the model and tool implementations frozen in its run plan,
reaching models, tools and files only through host mediation, using only outputs that keep
their declared contracts, and within its budgets and deadlines.

Lifecycle stages, in order: `acquire/open`, `verify`, `trust`, `authorize`, `compatibility`,
`prepare` (run plan), `revalidate` (start checks and execution lease), `execute/model`,
`execute/tool`, `validate`, `resource`, `finalize`.

## Adversary capabilities in scope

| Id | The adversary can | Families |
|---|---|---|
| A1 | modify package bytes: members, container layout, names, JSON, integrity statement, signature envelope | F1 |
| A2 | sign with a key the operator has not pinned, or pinned for another publisher or package | F2 |
| A3 | rely on missing, denied, partial, replayed or soon-expiring authorization | F3 |
| A4 | present requirements the host cannot satisfy (model capabilities and context, runtime and profile versions, host runtime), or tool contracts that differ from the host's bindings | F4 |
| A5 | change the world between plan and start: re-authorization, trust withdrawal, model availability or identity, tool binding changes, rewritten snapshot or lease, stale plan references | F5 |
| A6 | as a trusted package, a misbehaving model stack or a rebinding DNS answer: use capabilities outside the bindings (undeclared tools and tasks, role and state confinement, argument smuggling, forged file references, destination redirects, non-public addresses, host-reserved export names, a substituted model) | F6 |
| A7 | return model or tool answers that break their declared schema, are not parseable, come from an unfinished turn, or break the package's declared relations | F7 |
| A8 | drive a run past its token, remote-call, per-tool, fan-out, output-cap or deadline bounds, or misreport usage | F8 |

## Trusted computing base

The OpenClaw host process and its plugin runtime; the WebAgents runtime and control plane
(`agentpkg`); the Agent Browser plugin; the host adapters the operator approved (Crossref works
search, the JSON HTTP adapter, the selected-PDF reader); the operating system.

## Out of scope

A compromised host or operating system; stolen operator-pinned or publisher keys; attacks on
Ed25519 or SHA-256; a malicious adapter the operator approved; semantic prompt injection through
an approved capability (an approved tool returning persuasive but schema-valid content); the
correctness of LLM reasoning; rollback to an older, validly signed release that the operator
trusts; interoperability with other runtimes; side channels; availability and denial of service
beyond the declared budgets.

## What is real and what is simulated

**Real (production code, unmodified in the full profile):** the plugin backend compiled from
`openclaw-agent-browser/src` (`AgentBrowserBackend`, `ExecutionService`, `revalidate`, the
execution bridge, `completeWithBoundModel`, the `ToolBroker` and its adapters) and `agentpkg`
from `agentpkg/src` (control plane, trust store, authorization receipts, run plans, preflight,
execution leases, the execution runner, `Workflow`, `Runtime`, the model router and tool
handlers). Every case is driven through the page's own operations.

**Simulated (experiment-owned, recording stand-ins at the seams the plugin exposes for its own
tests):** OpenClaw's `api.runtime.llm.complete` (a synthetic model that answers each declared
task from the request it was sent, with OpenClaw's documented fallback to the agent default
for an unresolvable model); the Crossref and Citation Resolver services behind the broker's
HTTP transport; DNS; the PDF parser; an invented literature corpus. The control plane is called
through its own route table in process instead of over loopback HTTP, and the runner runs in
process behind the real bridge protocol instead of as a child process.

Nothing contacts a network service. Every worker refuses sockets, DNS, child processes and opens
of experiment canary files, in Python and in the Node host, and records any attempt. No
credential is required or read. Signing keys for re-signed artifacts are derived in memory from
the seed and never written.

## How a violation is judged

A case's **forbidden boundary** is an observable state, defined before the run and evaluated
over canaries and an observation-only state probe, never over error codes: for example "a model
call was answered by an unplanned model and its answer was committed", "a canary file was
opened", "the map ran more items than it declares". A violation whose boundary was reached is a
`SILENT_VIOLATION` whatever was refused afterwards. Otherwise the earliest refusal is looked up
in a vocabulary of deliberate refusal codes read from the production source; a recognized
refusal is an `EXPLICIT_BLOCK`, anything else an `INCIDENTAL_FAILURE`. Refusals produced by the
simulated host are never credited to WebAgents. `HARNESS_ERROR` marks the experiment's own
failures and never counts as detection.
