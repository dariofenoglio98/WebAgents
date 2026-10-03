# Release artifacts

Everything a user needs to run the current packages is in the first table. The unversioned
`.agent.pkg` names are byte-identical copies of the newest versioned file; earlier signed
archives and wheels stay here unchanged so that every milestone report can be re-checked
against the exact bytes it describes.

## Current

| Artifact | What it is | Requires | Verify with |
|---|---|---|---|
| `agentpkg-0.2.2-py3-none-any.whl` | agentpkg 0.2.2: the CLI, the browser control plane and the workflow.v0 runtime | Python ≥ 3.11 | SHA-256 below |
| `literature-review.agent.pkg` | Literature Review 0.2.5, identical to `literature-review-0.2.5.agent.pkg` | agentpkg ≥ 0.2.1 | [`examples/keys/literature-review-publisher.pub.pem`](../examples/keys/literature-review-publisher.pub.pem) (`sha256:c5ca9763…5232`) |
| `meeting-agenda.agent.pkg` | Meeting Agenda 0.2.2, identical to `meeting-agenda-0.2.2.agent.pkg` | agentpkg ≥ 0.2.2 | [`examples/keys/meeting-agenda-publisher.pub.pem`](../examples/keys/meeting-agenda-publisher.pub.pem) (`sha256:2bcc374a…c5c4`) |

From the repository root:

```sh
python3 -m venv .venv && .venv/bin/python -m pip install dist/agentpkg-0.2.2-py3-none-any.whl
# fingerprints in the table above, and in each command's own output
.venv/bin/agentpkg verify dist/literature-review.agent.pkg \
  --trust-key examples/keys/literature-review-publisher.pub.pem
.venv/bin/agentpkg verify dist/meeting-agenda.agent.pkg \
  --trust-key examples/keys/meeting-agenda-publisher.pub.pem
```

The keys are development keys: they establish which key signed an artifact, not an independent
certification of its publisher.

**The 0.2.2 wheel was rebuilt for the public release** from the current `agentpkg/` source. It
differs from the earlier 0.2.2 build (SHA-256 `c0ea47ef…eabd`, recorded in
`examples/verification/agentpkg-022-wheel-smoke.json`) in exactly three ways. It adds the
Apache-2.0 license metadata and `LICENSE` file. It contains the host-usage accounting correction in
`agentpkg/hostbridge/router.py`, made after that build. And `agentpkg/browser/server.py` no longer
resolves the control plane's loopback address back to a host name when it binds: that reverse DNS
lookup took about 35 s on hosts whose own name does not resolve (GitHub's macOS runners among
them), longer than the plugin waits for the control plane. Every other file is unchanged. The
version stays 0.2.2 because the runtime reports that version, and the signed packages and the
paper experiments were run against it. The signed `.agent.pkg` files are unaffected. It was
built as below with setuptools 84.0.0; two such builds on the development machine produced
identical bytes, and CI rebuilds it from source and checks that every file matches:

```sh
python3 -m venv /tmp/build-env && /tmp/build-env/bin/pip install 'build>=1.2,<2' 'setuptools==84.0.0'
SOURCE_DATE_EPOCH=1790965957 /tmp/build-env/bin/python -m build --no-isolation --outdir /tmp/agentpkg-dist agentpkg
```

Build from a clean checkout: a stale `agentpkg/build/` directory from an earlier build can leak
into the wheel.

## Demo

| Artifact | What it is | Requires | Verify with |
|---|---|---|---|
| `webair.agent.pkg` | WebAir Travel Agent 0.1.0, identical to `webair-0.1.0.agent.pkg`: the agent package the fictional WebAir origin ([`demo/webair/`](../demo/webair/README.md)) publishes at `/agent.pkg`. No real booking or payment | agentpkg ≥ 0.2.1 | [`examples/keys/webair-publisher.pub.pem`](../examples/keys/webair-publisher.pub.pem) (`sha256:2e53acce…a20b`) |

Built and signed with the same generic commands as every package (`agentpkg build agents/webair
-o dist/webair-0.1.0.agent.pkg`, then `agentpkg sign`); rebuilding and re-signing with the same
key reproduces the bytes. It is not part of the v0.1.0 release.

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
cc28762bc58e8897b3615d43559b13021a8237e03096d6cb62c46e4732b6ce59  agentpkg-0.2.2-py3-none-any.whl
5fdde862352598fc68e4fe5a2f5c2dee19bf952112446b3fc13bc77763533b0b  literature-review-0.2.0.agent.pkg
0fb8b65bbff4578d4815ee70b29a0cb789b2cc95ce181d011d467b4be22c8e42  literature-review-0.2.1.agent.pkg
4804ea8f4c2ad40439641f8348c2d65b798f4d52802f6ad751b71114e4f27c04  literature-review-0.2.2.agent.pkg
32304cad852d162084a3bdd9a444e04e31423f1e660f7cefdaeee442c1520dff  literature-review-0.2.3.agent.pkg
f513e68ea23e045ed3665d8d71e46531147f017f0da80f999fb343afc3e1fe24  literature-review-0.2.4.agent.pkg
1669f83fafac3434748fc19d38a8d3d2c3352da83cf1cbb84796ce313bd4f571  literature-review-0.2.5.agent.pkg
fb7357ebdf2e8415a32033971ba448dd21a9b20eb35a32a6ec71e1a5240cc03b  literature-review-legacy.agent.pkg
1669f83fafac3434748fc19d38a8d3d2c3352da83cf1cbb84796ce313bd4f571  literature-review.agent.pkg
664b39b12ed26ee2b7524cc5b0afb8a91ebc64b76948696e65f34cbd768c32cb  meeting-agenda-0.2.0.agent.pkg
e4c499f034b110ef2eca5aeecc87bc9336f6626e55b217d0fb087392ff120e35  meeting-agenda-0.2.1.agent.pkg
7b148e845c0f9e38d752a51a8d0b60a314842a3de3a2723b3bdf1a0c041921e1  meeting-agenda-0.2.2.agent.pkg
7b148e845c0f9e38d752a51a8d0b60a314842a3de3a2723b3bdf1a0c041921e1  meeting-agenda.agent.pkg
73872c3177a9ec281a8875ae154023a72ff10f9fe96c5a82ed1639a34ecb470c  webair-0.1.0.agent.pkg
73872c3177a9ec281a8875ae154023a72ff10f9fe96c5a82ed1639a34ecb470c  webair.agent.pkg
```
