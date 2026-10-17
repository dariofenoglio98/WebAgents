# Releasing WebAgents

How a release is prepared and verified, the artifacts of the current release (v0.2.0, the code the
paper describes) and of v0.1.0, and the checklist to complete before the repository is published.
Nothing here rewrites git history.

## Decisions for v0.2.0

| Topic | Decision |
|---|---|
| License | Apache License 2.0 (`Apache-2.0`): root [`LICENSE`](../LICENSE), a copy in `agentpkg/LICENSE` for the wheel (setuptools `license-files` cannot reach `../`), SPDX `license` fields in `agentpkg/pyproject.toml`, `citation-resolver/pyproject.toml`, `demo/webair/pyproject.toml` and `openclaw-agent-browser/package.json` |
| Third-party material | listed with its terms in [`THIRD_PARTY_NOTICES.md`](../THIRD_PARTY_NOTICES.md): CPython-derived tables and expressions (PSF License), and TypeBox and OpenClaw plugin-SDK code bundled into the plugin artifact (MIT). v0.2.0 adds no bundled dependency and no third-party asset (the WebAir site uses only its own CSS and templates) |
| Internal slide deck | `Portable AI Agents and the OpenClaw Agent-Native Browser.pdf` is not in the tree (removed in `f539475`) and is git-ignored, as is any PDF at the repository root. It remains in history (`d18b839`) |
| Third-party full text | the legacy runner's raw live outputs (`examples/demo-live`, `demo-live-final`, `demo-live-fulltext`) reproduced third-party abstracts and PDF text with author e-mail addresses. They are kept locally under the ignored `/private/` directory and are not in the tree; their sanitized summaries in `examples/verification/` remain. They remain in history (`d18b839` to `f9f6dd2`). Recorded runs that the reports and the paper's experiments use stay, with the notice in `THIRD_PARTY_NOTICES.md` §4 |
| History | no rewrite. The paper cites commits `23eac90` (contract enforcement) and `9d78ca5` (contract overhead), and the experiments' result directories record them, so both must stay reachable from `main`: integrate branches by fast-forward or merge commit, never by squash or rebase |
| Paper Table I | the six run records stay on the recording host. The README says which evidence the repository contains: a recomputed check of both Literature Review runs, two other recorded Meeting Agenda 0.2.2 runs, and a recomputed check of both WebAir runs with their audit chains re-verified |
| Hosted services | the Citation Resolver named by the signed Literature Review package and the WebAir origin named by the signed WebAir 0.3.0 package stay reachable for this release. Both are documented as external research/demo dependencies of live runs only. The WebAir origin is deployed from the allowlisted bundle that `demo/webair/deploy/bundle.py` writes, never from `demo/webair/` itself, which holds the demo host's resources file |
| Version | repository `v0.2.0`, with the research-prototype status stated in the README and the release notes. Component versions stay `agentpkg` 0.2.2 and Agent Browser plugin 0.1.0. The runtime reports the agentpkg version: the signed packages declare their minimum runtime against it, the paper's experiments recorded it, and the contract enforcement experiment's runtime-version cases treat 0.2.3, 0.3.0 and 1.0.0 as newer than the runtime. The plugin's tool implementations carry their version inside the Run Plans. Each artifact is identified by its SHA-256 |
| WebAir alias | `dist/webair.agent.pkg` stays 0.1.0: the recorded discovery, serving and live-demo evidence pins it to 0.1.0's bytes. The current WebAir is the versioned `dist/webair-0.3.0.agent.pkg` |
| Code and the paper's experiments | the contract enforcement results were produced at `23eac90`; the contract overhead results at `9d78ca5`, whose production code (`agentpkg/src`, the plugin's `src/`) is this release's. Between the two, the production code changed four times: the loopback bind fix in `agentpkg/src/agentpkg/browser/server.py` (no reverse DNS lookup), website discovery, host-owned capabilities, and the operator bindings file with a task-form fix (plugin only). After each of the first three, rerunning the contract enforcement paper preset reproduced every one of the 9,099 outcomes and every summary and LaTeX table byte for byte. On the v0.2.0 source, a final rerun did the same (see the checklist) |

## Release artifacts

Built from a clean clone of the release commit's tree; staged locally, outside git, in the ignored
`private/release-v0.2.0/`.

| Asset | Identity | Source in the repository |
|---|---|---|
| `agentpkg-0.2.2-py3-none-any.whl` | agentpkg 0.2.2 with website discovery and host-owned resources, Apache-2.0 metadata | `dist/` (rebuilt for v0.2.0; see [dist/README.md](../dist/README.md)) |
| `agentpkg-0.2.2.tar.gz` | agentpkg 0.2.2 source distribution | built from `agentpkg/` |
| `agent-browser.tgz` | OpenClaw plugin `agent-browser` 0.1.0 as of v0.2.0, built with OpenClaw 2026.9.5 | built from `openclaw-agent-browser/` |
| `meeting-agenda-0.2.2.agent.pkg` | `org.webagents.meeting-agenda` 0.2.2, digest `dbd2eb81…4679`, signer `sha256:2bcc374a…c5c4` | `dist/` (unchanged; not re-signed) |
| `literature-review-0.2.5.agent.pkg` | `org.webagents.literature-review` 0.2.5, digest `cef9ebd6…55b5`, signer `sha256:c5ca9763…5232` | `dist/` (unchanged; not re-signed) |
| `webair-0.3.0.agent.pkg` | `org.webagents.webair` 0.3.0, digest `ffe8f5b3…5e94`, signer `sha256:2e53acce…a20b` | `dist/` (unchanged; not re-signed) |
| `meeting-agenda-publisher.pub.pem`, `literature-review-publisher.pub.pem`, `webair-publisher.pub.pem` | the development public keys of the three signers | `examples/keys/` |
| `LICENSE`, `THIRD_PARTY_NOTICES.md` | ship beside `agent-browser.tgz`, because `openclaw plugins pack` writes only `package.json`, `openclaw.plugin.json` and the bundled `dist/` files into it | repository root |
| `SHA256SUMS` | the list below | |

SHA-256 of the v0.2.0 release candidate:

```
371fb1eb8c70abc3511a09e7208742ab313bc47dfda6999675ce716d14731cd1  agentpkg-0.2.2-py3-none-any.whl
7097585b8eff10336a6e9076d5ec0c5a5ae48f3e0abf1656084e7cc70dd92e74  agentpkg-0.2.2.tar.gz
3885ba1d106e45c02921dbfbe0dcd2e31f922b75f8459e7d420fda1d5b86333d  agent-browser.tgz
7b148e845c0f9e38d752a51a8d0b60a314842a3de3a2723b3bdf1a0c041921e1  meeting-agenda-0.2.2.agent.pkg
1669f83fafac3434748fc19d38a8d3d2c3352da83cf1cbb84796ce313bd4f571  literature-review-0.2.5.agent.pkg
b537cf5cba06bce8137533eb75b491486f57caf3098af30f657343b741492887  webair-0.3.0.agent.pkg
50c067910a5bd907f0a670a9d451076ba820f912e2dca9b8bfe557548fadc757  meeting-agenda-publisher.pub.pem
e7ca900ea381f1dbdb1f91e65eb7ab1d3edc152f33df442fbce2099dfd47119d  literature-review-publisher.pub.pem
17215bed2758e06b274d38df569f6ef947e7298e5a1fe35f8201d11ea7553212  webair-publisher.pub.pem
cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30  LICENSE
5877239656ee07fd9c215c919d3b86adda3c905c781a7798050d885517d4c5c7  THIRD_PARTY_NOTICES.md
```

The wheel, the plugin artifact and the signed packages are reproducible: rebuilding them from the
release commit as below gives the same bytes (for v0.2.0, two independent clean builds of the
wheel and of the plugin artifact matched; the signed packages were not rebuilt). The sdist is not
byte-reproducible (its tar entries carry file times), so publish the file whose hash
is recorded here, or record the hash of the one you build.

### v0.1.0

Tagged `v0.1.0` at `319cc3e` while the repository was private ([notes](release-notes-v0.1.0.md)).
Its candidate assets were:

```
cc28762bc58e8897b3615d43559b13021a8237e03096d6cb62c46e4732b6ce59  agentpkg-0.2.2-py3-none-any.whl
8d7f7ec7b955d8ae9e2da38c630c262d85db50a22f1ac847853d2f9df16b9ebd  agentpkg-0.2.2.tar.gz
14ffd2385924caeb6b491e0b635e1e6e0bc91123acfebb6e87630162d15ac496  agent-browser.tgz
7b148e845c0f9e38d752a51a8d0b60a314842a3de3a2723b3bdf1a0c041921e1  meeting-agenda-0.2.2.agent.pkg
1669f83fafac3434748fc19d38a8d3d2c3352da83cf1cbb84796ce313bd4f571  literature-review-0.2.5.agent.pkg
```

## The development line's versions

`main` is the development line (D-019); the v0.2.0 release stays on `paper-cic2026`. Each format
change opens a runtime version, and a package that uses it declares that version as its minimum, so
an older runtime refuses it by version before anything runs (D-188, D-210). The current versions on
`main`; identities and hashes are in [dist/README.md](../dist/README.md):

| Component | Version | Since | What it brought |
|---|---|---|---|
| agentpkg (Python reference) | 0.5.0, `dist/agentpkg-0.5.0-py3-none-any.whl` | T21 | compute.v0 ([`spec/compute-v0.md`](../spec/compute-v0.md)): WebAssembly modules as `compute` nodes, the `compute` permission kind, binary `.wasm` members; the `wasmtime` extra (`agentpkg[compute]`) runs them |
| agentpkg | 0.4.0, `dist/agentpkg-0.4.0-py3-none-any.whl` | T20 | memory.v0 ([`spec/memory-v0.md`](../spec/memory-v0.md)) |
| agentpkg | 0.3.0, `dist/agentpkg-0.3.0-py3-none-any.whl` | T13 | answer checks, the `feedback` request line |
| Chrome core (`SUPPORTED_RUNTIME_VERSION`) | 0.4.0 with core 0.2.0 (T19); 0.5.0 with core 0.3.0 once T22 lands | T19 | memory.v0 in the Chrome Agent Browser; compute.v0 follows in T22 |
| WebAir | 0.6.0, `dist/webair-0.6.0.agent.pkg` (runtime minimum 0.4.0) | T20 | the travel profile from memory, one preference proposed after a booking |
| Literature Review | 0.2.8, `dist/literature-review-0.2.8.agent.pkg` (runtime minimum 0.4.0) | T20 | the research profile, the agent's notes and a review proposal, all opt-in |
| Meeting Agenda | 0.2.2, `dist/meeting-agenda.agent.pkg` | v0.2.0 | — |
| Demo agent index | 1.3.0, `examples/agent-index.json` (1.2.0 kept as `agent-index-1.2.0.json`) | T20 | names WebAir 0.6.0 and Literature Review 0.2.8 |
| OpenClaw plugin | 0.1.0, frozen (D-029) | v0.2.0 | runs packages up to WebAir 0.5.0 and Literature Review 0.2.7 |

A changed package is a new version, a new signature and a new row in `dist/README.md`; an unchanged
package is never re-signed. A version signed but never pushed, deployed or used may be replaced by
the user's decision (T15's 0.2.7, T20's 0.6.0); once it has left the machine it is fixed.

## Building and checking the artifacts

From a clean checkout of the release commit. Stale `agentpkg/build/` or
`openclaw-agent-browser/dist/` directories from earlier builds can leak into an artifact, and the
package builder refuses stray files such as `.DS_Store` in `agents/`, so do not build in a working
copy that has them.

```sh
# agentpkg wheel and sdist (setuptools pinned, fixed timestamp)
python3 -m venv /tmp/build-env && /tmp/build-env/bin/pip install 'build>=1.2,<2' 'setuptools==84.0.0'
SOURCE_DATE_EPOCH=1790965957 /tmp/build-env/bin/python -m build --no-isolation --outdir /tmp/agentpkg-dist agentpkg

# the plugin artifact (Node 24 >= 24.16 or >= 26.1)
(cd openclaw-agent-browser && npm ci && npm run build && npm run validate && npm run pack)
git status --porcelain     # must be empty: `npm run build` regenerates openclaw.plugin.json

# consistency of the release tree: package identities, dist/ SHA-256 list, licenses, wheel = source
python3 -m venv agentpkg/.venv && agentpkg/.venv/bin/pip install -e './agentpkg[dev]'
agentpkg/.venv/bin/python scripts/check_release.py --built-wheel /tmp/agentpkg-dist/agentpkg-0.2.2-py3-none-any.whl
```

The Chrome Agent Browser's zip (not part of v0.2.0; a store upload is U5):

```sh
(cd chrome-agent-browser && npm ci && npm run build && npm run pack && npm run check-pack)
# dist/chrome-agent-browser-<version>.zip and .contents.txt (sha256, bytes, path per member;
# the zip's own hash last). The zip carries LICENSE.txt and THIRD_PARTY_NOTICES.txt.
```

The same sources and Node release pack to the same bytes. Across Node releases the members stay
identical while the deflate stream may not (each Node ships its own zlib), so publish the
`.contents.txt` beside the zip and record the Node version that packed it (D-093). The version is
`package.json`'s and the manifest's, which `check-pack` holds equal.

Use Python 3.11 ≥ 3.11.10, 3.12 ≥ 3.12.4 or 3.13 for every environment here: earlier patch releases
lack CPython's `ipaddress` fix (CVE-2024-4032), and the URL-policy tests fail on them.

Never re-sign an unchanged `.agent.pkg`: its archive SHA-256, digest and signature are part of the
recorded evidence and of the paper's experiment manifests. A changed package gets a new version,
a new signature and a new row in `dist/README.md`.

[CI](../.github/workflows/ci.yml) repeats every check on Ubuntu and macOS: the Python suite on
3.11 and 3.13 (Ubuntu) and 3.12 and 3.13 (macOS, where `setup-python` has no 3.11 newer than the
unpatched 3.11.9), the offline acceptance scripts, the wheel and sdist build, an installed-wheel
verification and fixture run of the packages (including WebAir 0.3.0 and 0.4.0), `check_release.py`, the
plugin suite on Node 24 and 26 with no skipped test, build, validation, packing, artifact
inspection and isolated install, the WebAir origin and package-contract suite, the Citation
Resolver suite and the experiments' test suites; and, since T7, the Chrome Agent Browser on Node 24
and 26 (typecheck, tests with no skip, build, pack, the zip's structure check, a second build that
must pack to the same bytes) and the cross-runtime conformance suite. It needs no credential, model, OpenClaw
configuration, Ollama, live Crossref, hosted resolver or WebAir deployment. It runs on pushes to
`main` and on pull requests.

## Public-release checklist

Status of the v0.2.0 release-engineering pass (2026-10-03).

| | Item | How it was checked |
|---|---|---|
| ✅ | Apache-2.0 `LICENSE` present | root `LICENSE` is the apache.org text, SHA-256 `cfc7749b…3d30`; `agentpkg/LICENSE` is identical (`check_release.py`) |
| ✅ | Package metadata licenses consistent | `Apache-2.0` in `agentpkg/pyproject.toml` (+ `license-files`), `citation-resolver/pyproject.toml`, `demo/webair/pyproject.toml`, `openclaw-agent-browser/package.json` and `package-lock.json` |
| ✅ | License in the Python distributions | the wheel carries `License-Expression: Apache-2.0` and `licenses/LICENSE`; the sdist carries `LICENSE` |
| ✅ | Third-party attribution | `THIRD_PARTY_NOTICES.md`, unchanged: v0.2.0 adds no bundled dependency or third-party asset |
| ✅ | Internal deck not tracked in the tree | not in `git ls-files`; ignored by `/Portable AI Agents …pdf` and `/*.pdf` |
| ✅ | Local/private files ignored | `/private/` (including the staged release assets), `.claude/`, virtualenvs, `node_modules/`, build output, `examples/my-*`, `*.tgz`, keys and `.env` files (`check_release.py`); the demo host's resources file is fictional and is never deployed |
| ✅ | README consistent with the code and the paper | three packages, quickstart (rerun from a fresh clone), Table I (all six columns against the recorded evidence), the experiments' headline numbers against their result directories, external services, status and limitations |
| ✅ | Paper's commits reachable | `23eac90` and `9d78ca5` are ancestors of `main`, which carries every commit of the former WebAir branch |
| ✅ | Paper's experiment results committed | contract enforcement `results/2026-10-02T12-38-15Z_paper_paper`; contract overhead `results/2026-10-03T*_paper-webair-run{1,2,3}` and `…T16-14-20Z_paper-webair-pooled`, whose tables match the paper's |
| ✅ | Contract enforcement results reproduce on this source | a full paper-preset rerun on the v0.2.0 production code (into a scratch directory) gave the paper run's outcome for each of the 9,099 cases, with byte-identical LaTeX tables |
| ✅ | Full Python tests | `pytest agentpkg/tests` from a fresh clone on 3.13.5: 1,223 passed, 2 skipped (the opt-in live tests) |
| ✅ | Plugin typecheck, tests, build | 527 tests, none skipped; build, validate, pack, isolated install (`npm run verify`) from a fresh clone |
| ✅ | WebAir origin and package contract | 294 tests, none skipped, and `python -m publisher check` (generated files current), from a fresh install of `requirements-dev.txt` |
| ✅ | Citation Resolver tests | 132 passed, from a fresh clone |
| ✅ | Experiments' test suites | contract overhead 35, contract enforcement 101 (separate processes) |
| ✅ | Offline acceptance scripts | the eight CI runs, including `verify_webair` and `verify_webair_discovery` |
| ✅ | Current Python distribution | wheel rebuilt from current source, reproducibly; `check_release.py --built-wheel` |
| ✅ | Current plugin distribution | built twice from clean clones with identical bytes; contents are exactly the manifest, `package.json` and the bundles |
| ✅ | Signed artifacts verified | Meeting Agenda 0.2.2, Literature Review 0.2.5 and WebAir 0.3.0 with the installed wheel; fixture runs pass; the public WebAir origin serves exactly `dist/webair-0.3.0.agent.pkg` |
| ✅ | Secret scan | gitleaks over the full history and trufflehog/gitleaks over the extracted artifacts: only documented test fixtures and hash-like build keys; no personal path, credential or private signing key |
| ✅ | CI rehearsal | every `run:` step of every job in `ci.yml`, each job in its own fresh clone, on macOS with Python 3.13 and Node 26: all six jobs pass |
| ⏳ | CI on GitHub | the WebAir commits had never run in CI (it runs on `main` and pull requests only). **Check the first run on `main` on both operating systems**, including the Linux and the other Python/Node matrix legs the rehearsal did not cover |
| ⏳ | Tag and GitHub Release | after CI passes |
| ⏳ | Visibility | the maintainer keeps the repository private for now (anonymous review) |

### Human-only steps

1. If the paper is under anonymous review, confirm that publishing the repository does not
   violate the venue's policy. The git history (author names and e-mail addresses) and the
   repository URL identify the authors. When publishing is allowed, fill in the README's clone URL
   (`<this-repository-url>`) and the citation's author field.
2. Watch the GitHub Actions run on `main` on both operating systems and fix anything that only
   shows there.
3. Create and push the `v0.2.0` tag on the commit CI passed:
   `git tag -a v0.2.0 -m "WebAgents v0.2.0" <commit> && git push origin v0.2.0`.
4. Create the GitHub Release from [release-notes-v0.2.0.md](release-notes-v0.2.0.md), attaching the
   assets above and `SHA256SUMS` (staged in `private/release-v0.2.0/`; rebuild them as above if
   that copy is gone, and record the new sdist hash).
5. Change the repository's visibility when intended.

### Known technical items, not blocking

- `agentpkg browser-serve` without `--cache-dir` uses Python's temporary directory, which is the
  shared `/tmp` on most Linux systems ([browser-control-plane.md](browser-control-plane.md)). The
  plugin always passes a private one. A per-user default is a change for a later version.
- On Linux the PDF reader's `RLIMIT_AS` cap is enforced for the first time: macOS refuses to set
  it, so it was never active during development. CI exercises the reader on Linux.
- No live Agent Browser run on a Linux OpenClaw host has been accepted.
- `agent.pkg` 0.1 has no optional tools, so a host without the three resource types cannot run
  WebAir 0.2.0 or later. Optional tools need a format change.
- The hosted Citation Resolver and WebAir origin run on a free hosting plan with no availability
  guarantee; WebAir's fictional schedule ends on 31 December 2027.
