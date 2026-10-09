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
| `agentpkg-0.2.2-py3-none-any.whl` | agentpkg 0.2.2: the CLI, the browser control plane and the workflow.v0 runtime | Python ≥ 3.11 | SHA-256 below |
| `literature-review-0.2.6.agent.pkg` | Literature Review 0.2.6: 0.2.5 with screening jobs built by the graph from the candidates (the model writes one `{paper_id, file_id}` reference per candidate, checked both ways) and an explicit empty source hash for abstract evidence, asserted by `check-abstract` (T10: on hosted models 0.2.5 silently thinned or emptied the review) | agentpkg ≥ 0.2.1 | [`examples/keys/literature-review-publisher.pub.pem`](../examples/keys/literature-review-publisher.pub.pem) (`sha256:c5ca9763…5232`) |
| `literature-review.agent.pkg` | Literature Review 0.2.5, identical to `literature-review-0.2.5.agent.pkg` | agentpkg ≥ 0.2.1 | [`examples/keys/literature-review-publisher.pub.pem`](../examples/keys/literature-review-publisher.pub.pem) (`sha256:c5ca9763…5232`) |
| `meeting-agenda.agent.pkg` | Meeting Agenda 0.2.2, identical to `meeting-agenda-0.2.2.agent.pkg` | agentpkg ≥ 0.2.2 | [`examples/keys/meeting-agenda-publisher.pub.pem`](../examples/keys/meeting-agenda-publisher.pub.pem) (`sha256:2bcc374a…c5c4`) |
| `webair-0.5.0.agent.pkg` | WebAir Travel Agent 0.5.0, the package of the fictional WebAir origin: 0.4.0 (three publisher-declared profiles, "Search flights", "Search and quote" and "Book (simulated)", in the noncritical extension [`org.webagents:profiles-v0`](../spec/extensions/profiles-v0.md)) with a request that names no departure airport answered instead of failing (a `search-origin` node; nothing is searched without one) and a one-sentence request description with the example "Find me a flight from Boston to Zurich on 9 October under $900". It declares the public deployment `webagents-webair-production.up.railway.app`, which serves 0.4.0 until this file is deployed there. It requests a travel profile, a passenger identity and a payment method from the person's host (`personal.read` permissions) and a separate, once-grantable simulated-purchase authority. No real booking or payment | the agentpkg 0.2.2 wheel in this directory (`371fb1eb…`), which ignores the profiles; the v0.1.0 release's 0.2.2 wheel rejects `personal.read` | [`examples/keys/webair-publisher.pub.pem`](../examples/keys/webair-publisher.pub.pem) (`sha256:2e53acce…a20b`) |

From the repository root:

```sh
python3 -m venv .venv && .venv/bin/python -m pip install dist/agentpkg-0.2.2-py3-none-any.whl
# fingerprints in the table above, and in each command's own output
.venv/bin/agentpkg verify dist/literature-review-0.2.6.agent.pkg \
  --trust-key examples/keys/literature-review-publisher.pub.pem
.venv/bin/agentpkg verify dist/literature-review.agent.pkg \
  --trust-key examples/keys/literature-review-publisher.pub.pem
.venv/bin/agentpkg verify dist/meeting-agenda.agent.pkg \
  --trust-key examples/keys/meeting-agenda-publisher.pub.pem
.venv/bin/agentpkg verify dist/webair-0.5.0.agent.pkg \
  --trust-key examples/keys/webair-publisher.pub.pem
```

The keys are development keys: they establish which key signed an artifact, not an independent
certification of its publisher.

**The 0.2.2 wheel has been rebuilt twice since its first build,** each time from the current
`agentpkg/` source and without a version change.

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

The current package is `literature-review-0.2.6.agent.pkg` (above), built and signed with the same
generic commands (`agentpkg build agents/literature-review -o …`, then `agentpkg sign` with the
Literature Review key); rebuilding and re-signing reproduces its bytes. 0.2.6 differs from 0.2.5 in
the graph (`normalize` writes `screening_refs`; new `check-screening-refs` and `screening-jobs` nodes;
one more `check-abstract` comparison), three new schemas, `normalize.schema.json`,
`research-state.schema.json`, the literature-search (0.1.2) and evidence-extraction (0.1.3) skills,
the replay fixture, the manifest and the package README. **The unversioned
`literature-review.agent.pkg` stays 0.2.5**, as `webair.agent.pkg` stays 0.1.0: the paper's contract
enforcement and contract overhead experiments read that file and record version 0.2.5, and the
Chrome conformance reports, the signed demo agent index and the search harness describe 0.2.5's bytes.

## WebAir

The demo origin in [`demo/webair/`](../demo/webair/README.md) and its packages are new in v0.2.0.
The current package is `webair-0.5.0.agent.pkg` (above); the earlier versions stay for the
milestone evidence that describes them.

| Artifact | What it is | Requires | Verify with |
|---|---|---|---|
| `webair-0.4.0.agent.pkg` | WebAir Travel Agent 0.4.0: 0.3.0 with the three publisher-declared profiles. The public deployment has served exactly these bytes since 2026-10-06 (until 0.5.0 is deployed there); the Chrome Agent Browser's live acceptance runs, the conformance reports and the demo agent index (`examples/agent-index.json`, which names this version, digest and archive) describe these bytes. 0.5.0 differs from it in the graph (`search-origin`), the state and input schemas, one new schema, the answer-writing skill, the fixture, the manifest and the package README | the agentpkg 0.2.2 wheel in this directory | [`examples/keys/webair-publisher.pub.pem`](../examples/keys/webair-publisher.pub.pem) (`sha256:2e53acce…a20b`) |
| `webair-0.3.0.agent.pkg` | WebAir Travel Agent 0.3.0, the first version that declares the public deployment, which served exactly these bytes at <https://webagents-webair-production.up.railway.app/agent.pkg> until 0.4.0 was deployed there on 2026-10-06. The [live demo](../docs/webair-live-demo.md) walk-through, the paper's Table I WebAir runs and the contract overhead benchmark describe these bytes. 0.4.0 differs from it only in the manifest (version, date and the profiles extension) and the package README | the agentpkg 0.2.2 wheel in this directory | [`examples/keys/webair-publisher.pub.pem`](../examples/keys/webair-publisher.pub.pem) (`sha256:2e53acce…a20b`) |
| `webair-0.2.0.agent.pkg` | WebAir Travel Agent 0.2.0: the first version with host-owned capabilities (`personal.read` permissions with argument-free host-resource tools) and the simulated-purchase authority. It declares the reserved host `webair.example`, so it runs only against a local origin started with `--agent-package`. 0.3.0 differs from it only in the declared host (tool endpoints, the network permission's scope and policy), the manifest's version, date and origin, and the package README | the agentpkg 0.2.2 wheel in this directory | [`examples/keys/webair-publisher.pub.pem`](../examples/keys/webair-publisher.pub.pem) (`sha256:2e53acce…a20b`) |
| `webair.agent.pkg` | WebAir Travel Agent 0.1.0, identical to `webair-0.1.0.agent.pkg`: the same four WebAir tools, without host-owned personal resources; it also declares `webair.example`. The website discovery milestone's evidence uses it | agentpkg ≥ 0.2.1 | [`examples/keys/webair-publisher.pub.pem`](../examples/keys/webair-publisher.pub.pem) (`sha256:2e53acce…a20b`) |

Built and signed with the same generic commands as every package (`agentpkg build agents/webair
-o dist/webair-0.5.0.agent.pkg`, then `agentpkg sign`); rebuilding and re-signing with the same
key reproduces the bytes (0.2.0, 0.3.0 and 0.4.0 were built the same way from the source as it was then). The
unversioned `webair.agent.pkg` stays 0.1.0, unlike the other two aliases: the recorded discovery,
serving and live-demo evidence pins it to 0.1.0's bytes, and the contract overhead benchmark,
whose results record its source hash, documents it as 0.1.0. Use the versioned
`webair-0.5.0.agent.pkg` for the current package.

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
5fdde862352598fc68e4fe5a2f5c2dee19bf952112446b3fc13bc77763533b0b  literature-review-0.2.0.agent.pkg
0fb8b65bbff4578d4815ee70b29a0cb789b2cc95ce181d011d467b4be22c8e42  literature-review-0.2.1.agent.pkg
4804ea8f4c2ad40439641f8348c2d65b798f4d52802f6ad751b71114e4f27c04  literature-review-0.2.2.agent.pkg
32304cad852d162084a3bdd9a444e04e31423f1e660f7cefdaeee442c1520dff  literature-review-0.2.3.agent.pkg
f513e68ea23e045ed3665d8d71e46531147f017f0da80f999fb343afc3e1fe24  literature-review-0.2.4.agent.pkg
1669f83fafac3434748fc19d38a8d3d2c3352da83cf1cbb84796ce313bd4f571  literature-review-0.2.5.agent.pkg
685dcc97232d278eb2a5b777dcbc621573de5c48818a95d522e647c9267ee8f1  literature-review-0.2.6.agent.pkg
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
73872c3177a9ec281a8875ae154023a72ff10f9fe96c5a82ed1639a34ecb470c  webair.agent.pkg
```
