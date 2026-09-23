# Milestone report: the host tool broker

A signed, downloaded package has now called a real remote service through a
host-controlled implementation it could not name, under a permission and an
approval the person gave separately, inside a budget the runtime enforced, and
the answer was validated twice before anything downstream saw it.

This report is what was actually run. The design is in
[the tool broker](tool-broker.md); the boundary's threat entry is in
[the threat model](threat-model.md).

## 1. What the milestone added

| Layer | Namespace / file | What it is |
|---|---|---|
| host tool registry | `openclaw-agent-browser/src/tool-registry.ts` | what this host implements, as closed descriptors |
| host tool broker | `openclaw-agent-browser/src/tool-broker.ts` | resolve a bound triple, then dispatch; SSRF and transport policy |
| host fixtures | `openclaw-agent-browser/src/tool-fixtures.ts` | every byte a probe may send |
| compatibility | `agentpkg/browser/hosttools.py` | declaration × binding, per-check, tri-state |
| plan binding | `agentpkg/browser/runplan.py` | `tool_bindings`, blockers, staleness, `tool_probe` mode |
| generic handler | `agentpkg/toolbridge/` | one `ToolHandler` with no I/O and no service vocabulary |
| runner | `agentpkg/execution/` | independent re-derivation, handler installation, the probe |

`Runtime.call_tool` was strengthened rather than bypassed: it now refuses **any**
declared tool that is not explicitly approved, and refuses an approval for a
tool the package does not declare.

## 2. Live acceptance

OpenClaw 2026.9.5 (ec9c1a1), plugin `agent-browser` 0.1.0 (artifact
`sha256:8c79bd40…`), `agentpkg` 0.2.0, against the deployed Citation Resolver.
Full record: [`tool-broker-citation-resolver-live.json`](../examples/verification/tool-broker-citation-resolver-live.json).

### The package

`org.webagents.literature-review` 0.2.0, opened from `dist/`, digest
`b7bd37ca…`, signature `valid`, publisher `trusted` after an explicit pin.
It declares three tools.

### What this host implements

Registry `sha256:f50f5f40…`, two bindings.

| Declared tool | Verdict | Implementation |
|---|---|---|
| `citation-resolver` | **bound** | `openclaw:citation-resolver:1`, `json_http` 0.1.0, `POST https://webagents-citation-resolver-production.up.railway.app/resolve` |
| `paper-reader` | **unbound** | — |
| `scholarly-search` | **unbound** | — |

All ten contract checks for `citation-resolver` were `satisfied`, including
both schema digests and that the configured origin, path and method are ones
the package itself declares.

### Consent

Receipt `e36d8636-…` (`sha256:5e70beb5…`), `runnable: true`. Five permissions
granted for the session; **three tool approvals** recorded separately, one per
declared tool.

### A run was refused; a probe was not

A `model` plan was attempted with a real compatible model
(`ollama/qwen3.5:9b`) and **refused**:

> `run_plan_refused` — This host registers no implementation for tool
> `paper-reader`. The package declares what it needs; a host that cannot supply
> it cannot run the package.

A `tool_probe` plan was then prepared: `rp_de746a11…`
(`sha256:0c75c0ad…`), `ready: true`, `model_binding: null`,
`probe_tool_id: citation-resolver`, exactly one tool binding
(`binding_sha256:31253afe…`, `contract_sha256:b8492f7a…`,
`max_calls: 20`, `credentials_required: false`).

### The call

| Fact | Value |
|---|---|
| Fixture | `doi` (host-owned), `{"query":"10.1038/nphys1170","query_type":"doi","format":"bibtex"}` |
| Arguments | 66 canonical bytes, `sha256:4f427f2d…`, validated against `schemas/resolver-input.schema.json` **before** dispatch |
| Authority | role `CitationWorker`, `network.citations = session`, approved; 3 permission checks |
| Transport | `POST /resolve`, HTTP **200**, 432 ms |
| Result | `sha256:da1af6d6…`, 1 128 bytes, validated against `schemas/resolver-output.schema.json` |
| Tool calls | **1** |
| Remote calls | **1** |
| Tokens | **0** |
| Model calls | **0** — no router was constructed |
| Workflow workers | **0**; runtime worker contexts **1** |
| Audit | **15** events, chain **valid**, final hash `7ced4897…` |
| Revalidated | **17** named checks before the call |

Normalized output (abridged):

```json
{"status": "resolved", "query": "10.1038/nphys1170", "detected_type": "doi",
 "best_match": {"title": "Measured measurement",
                "authors": [{"name": "Markus Aspelmeyer", …}],
                "year": 2009, "venue": "Nature Physics",
                "publisher": "Springer Science and Business Media LLC",
                "doi": "10.1038/nphys1170", "volume": "5", "issue": "1",
                "pages": "11-12", "source": "crossref",
                "bibtex": "@article{aspelmeyer2009measuredmeasurement97629b50, …}"},
 "match_score": 1, "alternatives": [], "sources": [{"provider": "crossref", "status": "ok"}],
 "warnings": [], "message": "Exact identifier verified against the provider record."}
```

The BibTeX field is present and structurally a `@article{…}` entry, which is
what the package's declared `resolver-output` schema expects of it. Crossref
was the provider that answered; the package's schema permits `crossref`,
`openalex` or `arxiv`, and nothing here requires a particular one.

A second host fixture was run through the same binding to show the call is not
fitted to one input: `arxiv` →
[`tool-broker-citation-resolver-arxiv.json`](../examples/verification/tool-broker-citation-resolver-arxiv.json),
HTTP 200, `status: resolved`, `detected_type: arxiv`, *Attention Is All You
Need*, `source: arxiv`, `arxiv_id: 1706.03762v7`, again 1 tool call, 1 remote
call, 0 tokens and a valid 15-event chain. Both identifiers are ones this
repository already publishes as examples of the service's own contract.

### Afterwards

The run plan was byte-identical (`sha256:0c75c0ad…`), `execution.performed`
still `false`, `toolBindingsCurrent: true`, and the page's
`executionSupported` still `false`.

## 3. Audit of the probe

```
runtime.started 1 · delegation.checked 1 · permission.checked 3
worker.spawned 1 · worker.started 1
tool.dispatched 1 · tool.called 1 · tool.completed 1 · tool.settled 1
budget.updated 2 · worker.completed 1 · memory.cleared 1
```

No `model.*` action of any kind, no `node.*`, no `workflow.*`, no
`state.committed`. `tool.dispatched` carries the binding id, binding digest,
implementation kind and version, locality, origin and method;
`tool.settled` carries the duration, outcome and HTTP status. Neither carries
an argument, a response body or a credential.

## 4. Tests

| Suite | Result |
|---|---|
| `agentpkg` (`pytest`) | **650 passed**, 1 skipped, 0 failed, 651 collected ([txt](../examples/verification/tool-broker-agentpkg-tests.txt), [junit](../examples/verification/tool-broker-agentpkg-tests.xml)) |
| plugin (`vitest`) | **253 passed**, 0 failed, 51 files ([json](../examples/verification/tool-broker-plugin-tests.json)) |
| `npm run verify` | plugin built, validated, packed, installed into a throwaway OpenClaw, `loaded`/`activated`, **0 agent tools**, 0 HTTP routes ([json](../examples/verification/tool-broker-plugin-verify.json)) |
| `scripts/verify_browser.py` | passed ([json](../examples/verification/tool-broker-browser-verification.json)) |
| `scripts/verify_workflow.py` | both packages passed ([json](../examples/verification/tool-broker-workflow-verification.json)) |
| `ruff check` / `ruff format --check` | clean on everything this milestone touched |

New Python modules: `test_hosttools.py` (26 cases), `test_tool_execution.py`
(34 cases). New plugin modules: `tool-broker.test.ts` (57 cases),
`tool-execution.test.ts` (10 cases). Existing boundary, contract, run-plan,
runtime and UI suites gained cases for the new refusals.

### What the new tests hold

* **package** — a declared tool is recognized; an undeclared one is refused; a
  changed schema digest is `incompatible` rather than `unverified`; a duplicate
  binding is `ambiguous`;
* **binding** — an exact binding is accepted; a missing one is `unbound`; a
  changed digest makes a prepared plan stale; a wrong tool id does not satisfy;
  a disabled or credential-less binding is `unavailable`; a local binding
  cannot satisfy a remote declaration; a remote binding outside the declared
  domains, path or method is `incompatible`;
* **authorization** — permission denied → no call; tool unapproved → no call;
  permission granted + tool unapproved → refused; tool approved + required
  permission denied → refused; both → allowed; a superseded receipt discards
  the plan;
* **run plan** — the exact binding is embedded; no secret is; the hash is
  deterministic; re-authorizing invalidates it; a binding change invalidates
  it; an approval withdrawal invalidates it;
* **execution** — `Runtime.call_tool` is the path; arguments are validated
  before any side effect; the result is validated after; tool and remote counts
  update; audit events are created; worker identity is preserved;
* **host broker** — strict method allowlist; a frame carrying a URL, method,
  header, endpoint or origin is refused; malformed identity refused; unknown
  tool, unknown binding and stale digest refused; nineteen address classes
  refused by name; timeout; cancellation; oversized request and response;
  invalid content type; invalid JSON; 4xx/5xx handling; bounded concurrency;
  a credential attached as a header and present nowhere else;
* **secret leakage** — a fake secret is placed in the environment and asserted
  absent from the run plan, the tool result, the audit, the probe report, the
  IPC frames and the binding descriptor; the frames additionally carry no
  `ECHO_TOKEN`-shaped name;
* **structural** — `browser` imports neither `execution` nor `toolbridge`;
  `hostbridge` imports neither; `toolbridge`'s **entire** import set is
  `{json, time, typing}` plus its own errors, checked by enumeration rather
  than by banning known-bad names, and it contains no domain word; the
  execution namespace still mentions no package identifier; the page's own
  source contains no `execution.*` or `router.probe` operation.

### The deterministic fake tool

`test.echo` is a `local_builtin` that returns its input and performs no I/O. A
minimal one-tool package (`org.example.echo`) is built and signed inside the
test run, bound to it, approved, planned and executed through the real
`ExecutionSession` over the real private protocol. It proves the whole chain —
declaration → binding → approval → plan → `Runtime.call_tool` → bridge → host
adapter → validated response — without a service, a network or a model, and it
is the vehicle for every refusal test above. It ships in no artifact.

## 5. Counts, as asked

| | |
|---|---|
| Tool calls (live probe) | 1 |
| Remote calls (live probe) | 1 |
| Model calls (live probe) | 0 |
| Workflow workers (live probe) | 0 |
| Runtime worker contexts (live probe) | 1 |
| Audit events (live probe) | 15, chain valid |
| Tokens spent | 0 |
| Cost | $0 |

## 6. Two things worth naming

**A probe needs one worker.** `Runtime.call_tool` takes the role allowlist, the
per-worker remote-call budget and the audit identity from the calling context,
and only a worker role may hold a tool. Spawning none would have meant forging
a context — bypassing exactly the mechanism the probe exists to test. The
report states `workflow_workers_started: 0` and `runtime_worker_contexts: 1`
separately rather than reporting one number that reads as the other. Where a
package's coordinator declares the tool itself, no worker is spawned at all.

**A probe plan is not a run plan.** Because two of the review package's tools
have no implementation here, a `model` plan is refused — correctly, and by
name. Rather than weaken that, the milestone added a second, strictly smaller
authority: `tool_probe` binds one tool, binds **no model at all**, and is
refused by `execution.run`. "No model was called" is therefore a property of
the artifact rather than a claim about a run.

## 7. Limits

* `scholarly-search` and `paper-reader` are unimplemented. The reference review
  package cannot run on this host and says so;
* the shipped Citation Resolver binding needs no credential, so the credential
  path is exercised only against a fake secret in tests;
* the response-status contract (`200/400/404/422/502` as data, others as
  failures) is this host's reading of one service's documented behaviour, held
  in the adapter rather than derived from the package;
* the broker runs in the Gateway process as trusted host code. It is not an OS
  sandbox;
* nothing here evaluates the *quality* of what a service returns. A resolved
  DOI is a retrieval, not a verification of the work behind it.

## 8. Next

Milestone 3B4 is binding or implementing the remaining Literature Review tools
and running that package's workflow for real. Nothing in this milestone
executed it.
