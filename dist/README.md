# Release artifacts

Everything a user needs to run the current packages is in the first table. The unversioned
`.agent.pkg` names are byte-identical copies of a versioned file: the newest one for Meeting Agenda,
Literature Review 0.2.5 for `literature-review.agent.pkg` (see [Literature Review](#literature-review)),
and WebAir 0.1.0 for `webair.agent.pkg` (see [WebAir](#webair)). Earlier
signed archives and wheels stay here unchanged so that every milestone report can be re-checked
against the exact bytes it describes.

## Current

| Artifact | What it is | Requires | Verify with |
|---|---|---|---|
| `agentpkg-0.7.0-py3-none-any.whl` | agentpkg 0.7.0, the development line's runtime (D-019, D-280): 0.6.1 plus network.v0 ([`spec/network-v0.md`](../spec/network-v0.md), T25): a `network` object over a workflow.v0 graph (roles that are declared workers with a program, edges with use caps, a hop cap, a shared state with per-role views, one message schema) run by one `network` node, the next role chosen by the model at a `route` under an enum the runtime builds with the availability in the request, every handoff checked before the target runs and recorded (`route.decided`), the worst case over every allowed walk computed from the declaration and reserved before the first activation (`network.started`), `inspect` and the control plane describing the envelope ("at most"), the once rule counting activations. It runs every package in this directory | Python ≥ 3.11 (+ `wasmtime` for compute packages) | SHA-256 below |
| `agentpkg-0.6.1-py3-none-any.whl` | agentpkg 0.6.1, the development line's runtime before network.v0 (D-019, D-260): 0.6.0 with T23 review 2's fixes (T24): a host limit `max_parallel_workers` below one and the memory inputs of `converse` are refused before anything is written, a consent host may not claim the plan's provenance and its reason must be a code by the transcript's pattern, the gate's documentation says a step resolved by the plan, `converse` reports a refused agent-document commit from the real commit path. Nothing a package sees changed: it runs every package in this directory | Python ≥ 3.11 (+ `wasmtime` for compute packages) | SHA-256 below |
| `agentpkg-0.6.0-py3-none-any.whl` | agentpkg 0.6.0, the development line's runtime before 0.6.1 (kept as the record of T23's build, the user's decision): 0.5.0 plus conversation.v0 ([`spec/conversation-v0.md`](../spec/conversation-v0.md), T23): a `conversation` object over a workflow.v0 graph (a persistent state the publisher declares, one turn per message under one Run Plan, per-turn and per-conversation budgets reserved whole before each turn, `once` spent once per conversation, one audit chain across turns), the `consent` node that pauses a turn before a consequential action for the person's yes or no and the gate that refuses a tool linking a consented permission without an accepted step, `agentpkg converse` (a transcript in, a transcript, the state and the chain out), `inspect` describing a package's conversation; the one-shot execution host refuses conversational packages. It runs every package in this directory | Python ≥ 3.11 (+ `wasmtime` for compute packages) | SHA-256 below |
| `agentpkg-0.5.0-py3-none-any.whl` | agentpkg 0.5.0, the development line's runtime before conversation.v0 (D-019, D-240): 0.4.0 plus compute.v0 ([`spec/compute-v0.md`](../spec/compute-v0.md), T21): WebAssembly core modules as `compute` nodes and map steps (a module imports nothing; JSON in, JSON out; a fresh instance per call under memory, wall-time and fuel bounds), binary `.wasm` members declared in the graph with their SHA-256, the `compute` permission kind, the node code `compute_error` and the audit events `compute.called/completed/failed`, `inspect` listing a package's modules. Running a module needs the `wasmtime` extra (`pip install 'agentpkg[compute]'`); without it such a package validates and is refused before it runs. It runs every package in this directory | Python ≥ 3.11 (+ `wasmtime` for compute packages) | SHA-256 below |
| `agentpkg-0.4.0-py3-none-any.whl` | agentpkg 0.4.0, the development line's runtime before compute.v0 (D-019, D-210): 0.3.0 plus memory.v0 ([`spec/memory-v0.md`](../spec/memory-v0.md), T20): the `memory.read` and `memory.write` permission kinds, `agent-scoped` memory with the two reserved agent-document tools, the `memory.proposal` export checked before a run completes (M-40), the sealed-value scans of tool arguments and model requests (M-36, M-37), and `agentpkg run --memory-dir` / `--memory-grant` over a memory folder. It runs every package in this directory | Python ≥ 3.11 | SHA-256 below |
| `agentpkg-0.3.0-py3-none-any.whl` | agentpkg 0.3.0, the development line's runtime before memory.v0 (D-019): 0.2.2 plus answer checks on model answers (`checks` on `llm` nodes and map `llm` steps, workflow.v0), an optional `feedback` line in the model-request contract, and the profile-scoped approvals of the control plane (T7, D-090), which the 0.2.2 wheel below predates. It runs every package here except those that declare runtime minimum 0.4.0 (WebAir 0.6.0, Literature Review 0.2.8) or 0.5.0 (WebAir 0.7.0, Literature Review 0.2.9) | Python ≥ 3.11 | SHA-256 below |
| `agentpkg-0.2.2-py3-none-any.whl` | agentpkg 0.2.2, the v0.2.0 release's wheel (the paper line, `paper-cic2026`): the CLI, the browser control plane and the workflow.v0 runtime. It cannot load a package that uses answer checks (they declare runtime minimum 0.3.0) | Python ≥ 3.11 | SHA-256 below |
| `literature-review-0.2.9.agent.pkg` | Literature Review 0.2.9: 0.2.8 with its candidate deduplication as code that can only compute (compute.v0, T22, D-252). The Rust bookkeeping module `modules/bookkeeping.wasm` (SHA-256 `5b9db688…735e`, declared in the graph) keys every found record by its normalized DOI, arXiv id, URL or title and keeps the first per key, where 0.2.8's join compared DOIs exactly; one required `compute` permission. No model call, tool, budget or memory switch changed; the fixture's exports are 0.2.8's | agentpkg ≥ 0.5.0 with the `compute` extra; the Chrome Agent Browser's core ≥ 0.3.0 | [`examples/keys/literature-review-publisher.pub.pem`](../examples/keys/literature-review-publisher.pub.pem) (`sha256:c5ca9763…5232`) |
| `literature-review-0.2.8.agent.pkg` | Literature Review 0.2.8: 0.2.7 with the person's memory (memory.v0, T20, D-233). Three task switches, off by default: `use_profile` reads the research profile the person chooses into planning (`memory.read`), `keep_notes` reads and keeps the agent's own notes (`agent-scoped`, two reserved tools), and `reviewed_on`, the person's date, makes the run propose one `research.review` (`memory.write`) derived from the profile, written to `proposals.json`. Off, it runs as 0.2.7 and proposes nothing | agentpkg ≥ 0.4.0 (memory.v0) | [`examples/keys/literature-review-publisher.pub.pem`](../examples/keys/literature-review-publisher.pub.pem) (`sha256:c5ca9763…5232`) |
| `literature-review-0.2.7.agent.pkg` | Literature Review 0.2.7: the same workflow, with the bookkeeping in the graph (T15). Every found paper is named by its DOI (else arXiv id, URL, title) and de-duplicated before a model sees it. `normalize` is asked only when documents were selected, and must name every found paper once. Screening answers a verdict and select answers ids, while the graph keeps the records. Answer checks sit on every judgement step and a host may re-ask on them. `papers-found.json` lists every found paper with its verdict. A selected document is read as its first pages. The citation resolver may fall back to Crossref's DOI lookup. Budgets fit two re-asks | agentpkg ≥ 0.3.0 (answer checks) | [`examples/keys/literature-review-publisher.pub.pem`](../examples/keys/literature-review-publisher.pub.pem) (`sha256:c5ca9763…5232`) |
| `literature-review-0.2.6.agent.pkg` | Literature Review 0.2.6: 0.2.5 with screening jobs built by the graph from the candidates (the model writes one `{paper_id, file_id}` reference per candidate, checked both ways) and an explicit empty source hash for abstract evidence, asserted by `check-abstract` (T10: on hosted models 0.2.5 silently thinned or emptied the review) | agentpkg ≥ 0.2.1 | [`examples/keys/literature-review-publisher.pub.pem`](../examples/keys/literature-review-publisher.pub.pem) (`sha256:c5ca9763…5232`) |
| `literature-review.agent.pkg` | Literature Review 0.2.5, identical to `literature-review-0.2.5.agent.pkg` | agentpkg ≥ 0.2.1 | [`examples/keys/literature-review-publisher.pub.pem`](../examples/keys/literature-review-publisher.pub.pem) (`sha256:c5ca9763…5232`) |
| `meeting-agenda.agent.pkg` | Meeting Agenda 0.2.2, identical to `meeting-agenda-0.2.2.agent.pkg` | agentpkg ≥ 0.2.2 | [`examples/keys/meeting-agenda-publisher.pub.pem`](../examples/keys/meeting-agenda-publisher.pub.pem) (`sha256:2bcc374a…c5c4`) |
| `webair-0.8.0.agent.pkg` | WebAir Travel Agent 0.8.0, the package of the fictional WebAir origin: 0.7.0 as a conversation (conversation.v0, T24, D-274). The input is one message per turn; the interpreter reads it with the conversation's persistent state (the history, the fares already found, the open quote, the last confirmation's summary, the profile used: ids, totals and labels, never a sealed value) and answers an intent (search, quote, purchase, question, done). A purchase waits on the consent step `confirm-purchase`, which shows the person the quote's facts (fare, route, date, cabin, total, the passenger's name, the card's display label) before `booking.simulate_purchase` is called; one purchase per conversation (`max_calls_per_tool`), at most 8 turns, 240,000 tokens and 60 remote calls; "that's all" ends the conversation without a model call. Its conversation fixture is three turns of searches, so the signed bytes carry no personal data. It declares the public deployment `webagents-webair-production.up.railway.app`. No real booking or payment | agentpkg ≥ 0.6.0 with the `compute` extra; the Chrome Agent Browser's core ≥ 0.4.0 | [`examples/keys/webair-publisher.pub.pem`](../examples/keys/webair-publisher.pub.pem) (`sha256:2e53acce…a20b`) |
| `webair-0.7.0.agent.pkg` | WebAir Travel Agent 0.7.0, the package of the fictional WebAir origin: 0.6.0 with WebAir's fare totals verified by code that can only compute (compute.v0, T22, D-252). The AssemblyScript fares module `modules/fares.wasm` (SHA-256 `ef7e813b…23c0`, declared in the graph) recomputes each selected fare's total in the fare-rules map and the quote's total, and the graph's checks refuse a total WebAir misstates; one required `compute` permission, in every profile. Its `remember` step has room for a thinking model (10,000 output tokens, B-220). Nothing a model sees changed; its fixture is 0.6.0's. It declares the public deployment `webagents-webair-production.up.railway.app`. No real booking or payment | agentpkg ≥ 0.5.0 with the `compute` extra; the Chrome Agent Browser's core ≥ 0.3.0 | [`examples/keys/webair-publisher.pub.pem`](../examples/keys/webair-publisher.pub.pem) (`sha256:2e53acce…a20b`) |
| `webair-0.6.0.agent.pkg` | WebAir Travel Agent 0.6.0, the package of the fictional WebAir origin: 0.5.0 with the person's memory (memory.v0, T20, D-233). The travel profile is read through `memory.read` of `travel.profile` as a record view; after a quote a `remember` step may propose one `travel.preference` (`memory.write`), written to `proposals.json` and never applied by the run. The passenger identity and payment method stay `personal.read`, the simulated purchase a separate once-grantable authority; the profiles gain `memory.remember`. It declares the public deployment `webagents-webair-production.up.railway.app`. No real booking or payment | agentpkg ≥ 0.4.0 (memory.v0) | [`examples/keys/webair-publisher.pub.pem`](../examples/keys/webair-publisher.pub.pem) (`sha256:2e53acce…a20b`) |

From the repository root:

```sh
python3 -m venv .venv && .venv/bin/python -m pip install dist/agentpkg-0.7.0-py3-none-any.whl
# fingerprints in the table above, and in each command's own output
.venv/bin/agentpkg verify dist/literature-review-0.2.9.agent.pkg \
  --trust-key examples/keys/literature-review-publisher.pub.pem
.venv/bin/agentpkg verify dist/literature-review-0.2.8.agent.pkg \
  --trust-key examples/keys/literature-review-publisher.pub.pem
.venv/bin/agentpkg verify dist/literature-review-0.2.7.agent.pkg \
  --trust-key examples/keys/literature-review-publisher.pub.pem
.venv/bin/agentpkg verify dist/literature-review-0.2.6.agent.pkg \
  --trust-key examples/keys/literature-review-publisher.pub.pem
.venv/bin/agentpkg verify dist/literature-review.agent.pkg \
  --trust-key examples/keys/literature-review-publisher.pub.pem
.venv/bin/agentpkg verify dist/meeting-agenda.agent.pkg \
  --trust-key examples/keys/meeting-agenda-publisher.pub.pem
.venv/bin/agentpkg verify dist/webair-0.8.0.agent.pkg \
  --trust-key examples/keys/webair-publisher.pub.pem
.venv/bin/agentpkg verify dist/webair-0.7.0.agent.pkg \
  --trust-key examples/keys/webair-publisher.pub.pem
.venv/bin/agentpkg verify dist/webair-0.6.0.agent.pkg \
  --trust-key examples/keys/webair-publisher.pub.pem
.venv/bin/agentpkg verify dist/webair-0.5.0.agent.pkg \
  --trust-key examples/keys/webair-publisher.pub.pem
```

The keys are development keys: they establish which key signed an artifact, not an independent
certification of its publisher.

**The 0.5.0 wheel** (SHA-256 `c5d4496f…9ecb`, T22) was built from a clean export of `agentpkg/` at `d0b53a0`
(the last change to the runtime: T22's first review, a preflight refusal that names its code once; before it,
T22 built `60d7cb1a…6947` from `8615205`, T21's second review's nits, and T21 built `0da3ac97…28d5` from `e67ffeb`)
with the command below (setuptools 84.0.0, `SOURCE_DATE_EPOCH=1790965957`);
three such builds produced identical bytes, and CI rebuilds it from source and checks that every file matches.
It carries `agentpkg/compute/` (the module reader, the wasmtime engine, the limits) and the patched schemas.
The version moved to 0.5.0 because packages that run modules must be refused by an older runtime by their
declared minimum (D-240, C-10); the `wasmtime` dependency is an extra, so the wheel's requirements are
unchanged for packages without modules.

**The 0.4.0 wheel** (SHA-256 `9559e4f3…037c`, T20) was built from a clean export of `agentpkg/`
at the commit that added it with the command below (setuptools 84.0.0, `SOURCE_DATE_EPOCH=1790965957`); two
such builds produced identical bytes, and CI rebuilds it from source and checks that every file matches. It
carries the memory.v0 contracts under `agentpkg/schemas/memory/`. The version moved to 0.4.0 because packages
that use memory.v0 must be refused by an older runtime by their declared minimum (D-210, M-67).

**The 0.3.0 wheel** (SHA-256 `096897b0…31df`, T13) was built from a clean export of `agentpkg/` at
the commit that added it, with the command below; two such builds produced identical bytes, and CI
rebuilds it from source and checks that every file matches. The version moved to 0.3.0 because
graphs that use answer checks must be refused by an older runtime by their declared minimum, not by
an unknown field. On `main` the contract enforcement experiment's runtime-version cases for 0.2.3
and 0.3.0 are therefore no longer newer than the runtime; the paper's results are the v0.2.0
line's (D-019), and a new series on this line needs its own catalog version.

**The 0.2.2 wheel has been rebuilt twice since its first build,** each time from the then current
`agentpkg/` source and without a version change. It predates the control plane's profile-scoped
approvals (T7, D-090), so it is no longer the source's wheel; it stays for the v0.2.0 release.

- **For v0.1.0** (SHA-256 `cc28762b…ce59`). It differs from the first 0.2.2 build (SHA-256
  `c0ea47ef…eabd`, recorded in `examples/verification/agentpkg-022-wheel-smoke.json`) in exactly
  three ways. It adds the Apache-2.0 license metadata and `LICENSE` file. It contains the
  host-usage accounting correction in `agentpkg/hostbridge/router.py`, made after that build. And
  `agentpkg/browser/server.py` no longer resolves the control plane's loopback address back to a
  host name when it binds: that reverse DNS lookup took about 35 s on hosts whose own name does
  not resolve (GitHub's macOS runners among them), longer than the plugin waits for the control
  plane.
- **For v0.2.0** (SHA-256 `371fb1eb…1cd1`, the file in this directory). It adds the WebAir
  milestones' generic runtime changes: website package discovery (`agentpkg/browser/discovery.py`,
  `fetch.py`, `control.py`, `server.py`) and host-owned capabilities (`agentpkg/browser/hostresources.py`;
  `authorization.py`, `runplan.py`, `hosttools.py` and `summary.py` in `agentpkg/browser/`;
  `agentpkg/execution/policy.py` and `session.py`; `agentpkg/toolbridge/binding.py` and
  `handler.py`; and the `personal.read` permission kind in `agentpkg/schemas/policy.schema.json`).
  Its metadata and every other file are unchanged.

The version stays 0.2.2 because the runtime reports that version: the signed packages declare
their minimum runtime against it, the paper's experiments recorded it, and the contract
enforcement experiment's runtime-version cases treat 0.2.3, 0.3.0 and 1.0.0 as newer than the
runtime. The signed `.agent.pkg` files are unaffected. It was built as below with setuptools
84.0.0; two such builds from a clean export produced identical bytes, and CI rebuilds it from
source and checks that every file matches:

```sh
python3 -m venv /tmp/build-env && /tmp/build-env/bin/pip install 'build>=1.2,<2' 'setuptools==84.0.0'
SOURCE_DATE_EPOCH=1790965957 /tmp/build-env/bin/python -m build --no-isolation --outdir /tmp/agentpkg-dist agentpkg
```

Build from a clean checkout: a stale `agentpkg/build/` directory from an earlier build can leak
into the wheel.

## Literature Review

The current package is `literature-review-0.2.9.agent.pkg` (above; digest `87732ea9…cdfc`, archive
`00f33aea…1f3f`, 373,835 bytes), built and signed with the same generic commands; two clean builds of the
source are identical, and re-signing reproduces its bytes (Ed25519 signatures are deterministic). 0.2.9
differs from 0.2.8 in the graph (`identity-rows` and the compute node `dedup-candidates`; `join-search`
loses its `unique_by`; `identify` reads the module's records), the module member and its declaration,
the `compute.bookkeeping` permission, six new schemas and the state schema, the runtime minimum (0.5.0),
the manifest and the package README; the fixture is unchanged. The demo index 1.4.0 names it; 0.2.8,
which index 1.3.0 named, stays served and pinned.

0.2.8 (`literature-review-0.2.8.agent.pkg`, T20; digest `fb107c18…52b6`, archive `0d03d1c8…8330`, 258,681
bytes) was built and signed with the same generic commands. 0.2.8 differs from 0.2.7 in the input (three switches), the policy
(`memory.research_profile`, `memory.remember`, `memory.agent`; scope `agent-scoped`), three reserved memory
tools and five host schemas, the graph (nine nodes: `profile`, `notes-read`, `gate-review`, `gate-notes`,
`review-links`, `review-papers`, `remember`, `notes-write`, `review-proposal`; the `proposals.json` export),
eight new schemas, the new `review-memory` skill and literature-search 0.1.4, the runtime minimum (0.4.0),
the replay fixture (memory-on cases recorded for `examples/literature-review-0.2.8-memory-input.json`) and the
package README. The demo index 1.3.0 named it; 0.2.7, which index 1.2.0 named, stays served and pinned.

0.2.7 (`literature-review-0.2.7.agent.pkg`, T15; digest `9274a5ce…99cb`, archive
`8951a14b…fe61`, 226,726 bytes) was built and signed with the same generic commands (`agentpkg build
agents/literature-review -o …`, then `agentpkg sign` with the Literature Review key); rebuilding and
re-signing reproduces its bytes. 0.2.7 differs from 0.2.6 in the graph (37 nodes: `join-batches`,
`identify`, `join-found`, `join-found-refs`, `normalize-gate`, `join-included`, `papers-found`,
`join-selection`, `selection-slots`, `assign-handles`, `citation-jobs` and `join-citation-jobs` added;
after selection the chosen papers are named P1–P3; `check-screening-refs` and `screening-jobs` removed; answer checks on
normalize, screen, select, extract, synthesize, write and verify; worker budgets and four timeouts),
nineteen new schemas and five removed, four skills, the policy's and the resolver tool's
`api.crossref.org`, the runtime minimum (0.3.0), the replay fixture (re-recorded by
`scripts/make_literature_fixture_027.py`) and the package README. The demo index 1.2.0 named it;
0.2.6, which index 1.1.0 named, stays served and pinned.

0.2.6 (`literature-review-0.2.6.agent.pkg`, T10) differs from 0.2.5 in
the graph (`normalize` writes `screening_refs`; new `check-screening-refs` and `screening-jobs` nodes;
one more `check-abstract` comparison), three new schemas, `normalize.schema.json`,
`research-state.schema.json`, the literature-search (0.1.2) and evidence-extraction (0.1.3) skills,
the replay fixture, the manifest and the package README. **The unversioned
`literature-review.agent.pkg` stays 0.2.5**, as `webair.agent.pkg` stays 0.1.0: the paper's contract
enforcement and contract overhead experiments read that file and record version 0.2.5, and the
Chrome conformance reports, the signed demo agent index and the search harness describe 0.2.5's bytes.

## WebAir

The demo origin in [`demo/webair/`](../demo/webair/README.md) and its packages are new in v0.2.0.
The current package is `webair-0.8.0.agent.pkg` (above; digest `b346a474…72c2`, archive `9c81a936…eae0`,
270,099 bytes); 0.7.0 (digest `abab1e37…409b`, archive `c0265a28…d808`, 199,210 bytes), which the public
origin serves until 0.8.0 is deployed, and the earlier versions stay for the milestone evidence that
describes them. 0.8.0 differs from 0.7.0 in the graph (the `conversation` object, the intent-driven
`when` conditions, `check-quote-fare`, `check-open-quote`, `purchase-facts`, the `confirm-purchase`
consent step, the state carried between turns), the input (`{message}`), the policy, the workflow fixture and
the new conversation fixture, six new schemas and five changed ones, three skills, the runtime minimum
(0.6.0), the manifest and the package README. 0.7.0 differs from 0.6.0 in the graph (a `total` compute step in the fare-rules map, `quote-total-input`
and `quote-total` before `check-quote`, two more assertions, the `remember` step's cap, timeout and the
Rememberer's budget), the module member and its declaration, the `compute.fares` permission (in every
profile), four new schemas and the state schema, the runtime minimum (0.5.0), the manifest and the
package README; the fixture is unchanged.

| Artifact | What it is | Requires | Verify with |
|---|---|---|---|
| `webair-0.5.0.agent.pkg` | WebAir Travel Agent 0.5.0, the package of the fictional WebAir origin: 0.4.0 (three publisher-declared profiles, "Search flights", "Search and quote" and "Book (simulated)", in the noncritical extension [`org.webagents:profiles-v0`](../spec/extensions/profiles-v0.md)) with a request that names no departure airport answered instead of failing (a `search-origin` node; nothing is searched without one) and a one-sentence request description with the example "Find me a flight from Boston to Zurich on 9 October under $900". It declares the public deployment `webagents-webair-production.up.railway.app`, which serves it (deployed 2026-10-09) until 0.6.0 is deployed there. 0.6.0 differs from it in the travel profile read (memory), the remember step and its schemas and skill, the policy, the manifest and the package README; its fixture is unchanged. It requests a travel profile, a passenger identity and a payment method from the person's host (`personal.read` permissions) and a separate, once-grantable simulated-purchase authority. No real booking or payment | the agentpkg 0.2.2 wheel in this directory (`371fb1eb…`), which ignores the profiles; the v0.1.0 release's 0.2.2 wheel rejects `personal.read` | [`examples/keys/webair-publisher.pub.pem`](../examples/keys/webair-publisher.pub.pem) (`sha256:2e53acce…a20b`) |
| `webair-0.4.0.agent.pkg` | WebAir Travel Agent 0.4.0: 0.3.0 with the three publisher-declared profiles. The public deployment has served exactly these bytes since 2026-10-06 (until 0.5.0 is deployed there); the Chrome Agent Browser's live acceptance runs, the conformance reports and the demo agent index (`examples/agent-index.json`, which names this version, digest and archive) describe these bytes. 0.5.0 differs from it in the graph (`search-origin`), the state and input schemas, one new schema, the answer-writing skill, the fixture, the manifest and the package README | the agentpkg 0.2.2 wheel in this directory | [`examples/keys/webair-publisher.pub.pem`](../examples/keys/webair-publisher.pub.pem) (`sha256:2e53acce…a20b`) |
| `webair-0.3.0.agent.pkg` | WebAir Travel Agent 0.3.0, the first version that declares the public deployment, which served exactly these bytes at <https://webagents-webair-production.up.railway.app/agent.pkg> until 0.4.0 was deployed there on 2026-10-06. The [live demo](../docs/webair-live-demo.md) walk-through, the paper's Table I WebAir runs and the contract overhead benchmark describe these bytes. 0.4.0 differs from it only in the manifest (version, date and the profiles extension) and the package README | the agentpkg 0.2.2 wheel in this directory | [`examples/keys/webair-publisher.pub.pem`](../examples/keys/webair-publisher.pub.pem) (`sha256:2e53acce…a20b`) |
| `webair-0.2.0.agent.pkg` | WebAir Travel Agent 0.2.0: the first version with host-owned capabilities (`personal.read` permissions with argument-free host-resource tools) and the simulated-purchase authority. It declares the reserved host `webair.example`, so it runs only against a local origin started with `--agent-package`. 0.3.0 differs from it only in the declared host (tool endpoints, the network permission's scope and policy), the manifest's version, date and origin, and the package README | the agentpkg 0.2.2 wheel in this directory | [`examples/keys/webair-publisher.pub.pem`](../examples/keys/webair-publisher.pub.pem) (`sha256:2e53acce…a20b`) |
| `webair.agent.pkg` | WebAir Travel Agent 0.1.0, identical to `webair-0.1.0.agent.pkg`: the same four WebAir tools, without host-owned personal resources; it also declares `webair.example`. The website discovery milestone's evidence uses it | agentpkg ≥ 0.2.1 | [`examples/keys/webair-publisher.pub.pem`](../examples/keys/webair-publisher.pub.pem) (`sha256:2e53acce…a20b`) |

Built and signed with the same generic commands as every package (`agentpkg build agents/webair
-o dist/webair-0.8.0.agent.pkg`, then `agentpkg sign`); rebuilding and re-signing with the same
key reproduces the bytes (0.2.0 to 0.7.0 were built the same way from the source as it was then). The
unversioned `webair.agent.pkg` stays 0.1.0, unlike the other two aliases: the recorded discovery,
serving and live-demo evidence pins it to 0.1.0's bytes, and the contract overhead benchmark,
whose results record its source hash, documents it as 0.1.0. Use the versioned
`webair-0.8.0.agent.pkg` for the current package.

## Historical

Preserved for provenance. Each is described by the report of the milestone that produced it;
none is needed to run the current packages.

| Artifact | Version | Signed by | Note |
|---|---|---|---|
| `literature-review-0.2.0.agent.pkg` | 0.2.0 | `workflow-publisher.pub.pem` (`sha256:c7549e61…5a70`) | agentpkg ≥ 0.2.0 |
| `literature-review-0.2.1.agent.pkg` | 0.2.1 | `literature-review-publisher.pub.pem` (`sha256:c5ca9763…5232`) | agentpkg ≥ 0.2.0 |
| `literature-review-0.2.2.agent.pkg` | 0.2.2 | `literature-review-publisher.pub.pem` (`sha256:c5ca9763…5232`) | agentpkg ≥ 0.2.0 |
| `literature-review-0.2.3.agent.pkg` | 0.2.3 | `literature-review-publisher.pub.pem` (`sha256:c5ca9763…5232`) | agentpkg ≥ 0.2.1 |
| `literature-review-0.2.4.agent.pkg` | 0.2.4 | `literature-review-publisher.pub.pem` (`sha256:c5ca9763…5232`) | agentpkg ≥ 0.2.1 |
| `meeting-agenda-0.2.0.agent.pkg` | 0.2.0 | `workflow-publisher.pub.pem` (`sha256:c7549e61…5a70`) | agentpkg ≥ 0.2.0 |
| `meeting-agenda-0.2.1.agent.pkg` | 0.2.1 | `meeting-agenda-publisher.pub.pem` (`sha256:2bcc374a…c5c4`) | agentpkg ≥ 0.2.0 |
| `literature-review-legacy.agent.pkg` | 0.1.0 | `publisher.pub.pem` (`sha256:646a5b31…d723`) | pre-workflow.v0 profile; runs only under `agentpkg-legacy` |
| `agentpkg-0.1.0-py3-none-any.whl` | 0.1.0 | — | cannot load the current packages: both declare a newer `runtime.minimum_version` |
| `agentpkg-0.2.0-py3-none-any.whl` | 0.2.0 | — | cannot load the current packages: both declare a newer `runtime.minimum_version` |

## SHA-256

```
c1b1c4b260dbca874dc9e343397e6fad1311f498c3a6df27c1a1deeeb0b18f71  agentpkg-0.1.0-py3-none-any.whl
5859ca592d7ced2261e07bd3451ba2a67fcca926627534faf092a93dcfd70adb  agentpkg-0.2.0-py3-none-any.whl
371fb1eb8c70abc3511a09e7208742ab313bc47dfda6999675ce716d14731cd1  agentpkg-0.2.2-py3-none-any.whl
096897b02d3e4bc212395eb35bf6522c67fedb5f80309e9e42744cbe777d31df  agentpkg-0.3.0-py3-none-any.whl
9559e4f319a7cb48fa1729b07ec1dbb81ffdc3953d680dff61f1cc078552037c  agentpkg-0.4.0-py3-none-any.whl
c5d4496f867c725a6fb7c4a1793999dab1edfb55ce8490718df4baa5ac009ecb  agentpkg-0.5.0-py3-none-any.whl
e9d450b1176b13d6ec48b00cca5a3410023f235ce48e59b39f53248d96db5b72  agentpkg-0.6.0-py3-none-any.whl
9079f53a2995d6135b6ced50415a24dde7b0242238d2758eaa4723342a7271b4  agentpkg-0.6.1-py3-none-any.whl
6345ea1aa439b804cb6a8eb7131fb298b08d352501ddcc623130ef3e0aeb0075  agentpkg-0.7.0-py3-none-any.whl
5fdde862352598fc68e4fe5a2f5c2dee19bf952112446b3fc13bc77763533b0b  literature-review-0.2.0.agent.pkg
0fb8b65bbff4578d4815ee70b29a0cb789b2cc95ce181d011d467b4be22c8e42  literature-review-0.2.1.agent.pkg
4804ea8f4c2ad40439641f8348c2d65b798f4d52802f6ad751b71114e4f27c04  literature-review-0.2.2.agent.pkg
32304cad852d162084a3bdd9a444e04e31423f1e660f7cefdaeee442c1520dff  literature-review-0.2.3.agent.pkg
f513e68ea23e045ed3665d8d71e46531147f017f0da80f999fb343afc3e1fe24  literature-review-0.2.4.agent.pkg
1669f83fafac3434748fc19d38a8d3d2c3352da83cf1cbb84796ce313bd4f571  literature-review-0.2.5.agent.pkg
685dcc97232d278eb2a5b777dcbc621573de5c48818a95d522e647c9267ee8f1  literature-review-0.2.6.agent.pkg
8951a14bb1f42bca1590bc7d0c9cc00cccba75b36f1488969b6b3ff47063fe61  literature-review-0.2.7.agent.pkg
0d03d1c8b366aabd6343b15958185c10cdab6639828f9c73bafbb26538db8330  literature-review-0.2.8.agent.pkg
00f33aea8504669080031b22c4a2903fb01812ba9f93f6deaf68fcde13891f3f  literature-review-0.2.9.agent.pkg
fb7357ebdf2e8415a32033971ba448dd21a9b20eb35a32a6ec71e1a5240cc03b  literature-review-legacy.agent.pkg
1669f83fafac3434748fc19d38a8d3d2c3352da83cf1cbb84796ce313bd4f571  literature-review.agent.pkg
664b39b12ed26ee2b7524cc5b0afb8a91ebc64b76948696e65f34cbd768c32cb  meeting-agenda-0.2.0.agent.pkg
e4c499f034b110ef2eca5aeecc87bc9336f6626e55b217d0fb087392ff120e35  meeting-agenda-0.2.1.agent.pkg
7b148e845c0f9e38d752a51a8d0b60a314842a3de3a2723b3bdf1a0c041921e1  meeting-agenda-0.2.2.agent.pkg
7b148e845c0f9e38d752a51a8d0b60a314842a3de3a2723b3bdf1a0c041921e1  meeting-agenda.agent.pkg
73872c3177a9ec281a8875ae154023a72ff10f9fe96c5a82ed1639a34ecb470c  webair-0.1.0.agent.pkg
3f135be80c2ac43b93f42acbcb648a3460b1ab39a831c251122331c99107a616  webair-0.2.0.agent.pkg
b537cf5cba06bce8137533eb75b491486f57caf3098af30f657343b741492887  webair-0.3.0.agent.pkg
c12f9db3bd7b3b4b6721c67e1d0b8143ebd94381df0e5e57c196357b7ca77f63  webair-0.4.0.agent.pkg
4b087557cbd2b0ff186391dfd00f9068739f9a727ab2fd916a6512da1fde101b  webair-0.5.0.agent.pkg
3055dd93a9f4e5f81f3ccddac77ccc9ce2c10b1e10dec35d9864fddf6fb58862  webair-0.6.0.agent.pkg
c0265a283d0b2edd5c919e1bb7cb3a95e6ccfc449d76590d62b1a47ff3fbd808  webair-0.7.0.agent.pkg
9c81a9362754fc3c48c923b4968e75daa9e0260ae422be7e77b30f1df1a7eae0  webair-0.8.0.agent.pkg
73872c3177a9ec281a8875ae154023a72ff10f9fe96c5a82ed1639a34ecb470c  webair.agent.pkg
```
