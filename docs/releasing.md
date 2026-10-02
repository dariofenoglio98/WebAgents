# Releasing WebAgents

How a release is prepared and verified, the artifacts of the first public release (v0.1.0), and
the checklist to complete before the repository is published. Nothing here rewrites git history.

## Decisions for v0.1.0

| Topic | Decision |
|---|---|
| License | Apache License 2.0 (`Apache-2.0`): root [`LICENSE`](../LICENSE), a copy in `agentpkg/LICENSE` for the wheel (setuptools `license-files` cannot reach `../`), SPDX `license` fields in `agentpkg/pyproject.toml`, `citation-resolver/pyproject.toml` and `openclaw-agent-browser/package.json` |
| Third-party material | listed with its terms in [`THIRD_PARTY_NOTICES.md`](../THIRD_PARTY_NOTICES.md): CPython-derived tables and expressions (PSF License), and TypeBox and OpenClaw plugin-SDK code bundled into the plugin artifact (MIT) |
| Internal slide deck | `Portable AI Agents and the OpenClaw Agent-Native Browser.pdf` is not in the tree (removed in `f539475`) and is git-ignored, as is any PDF at the repository root. It remains in history (`d18b839`); no history rewrite |
| Third-party full text | the legacy runner's raw live outputs (`examples/demo-live`, `demo-live-final`, `demo-live-fulltext`) reproduced third-party abstracts and PDF text with author e-mail addresses. They are kept locally under the ignored `/private/` directory and are not in the tree; their sanitized summaries in `examples/verification/` remain. Recorded runs that the reports and the paper's experiments use stay, with the notice in `THIRD_PARTY_NOTICES.md` §4 |
| Paper Table I | the four run records stay on the recording host. The README says which evidence the repository contains: a recomputed check of both Literature Review runs, and two other recorded Meeting Agenda 0.2.2 runs |
| Citation Resolver | the hosted instance named by the signed Literature Review package stays reachable for this release. It is documented as an external research/demo dependency of live runs only |
| Version | `v0.1.0`, with the research-prototype status stated in the README and the release notes |
| Code and the paper's experiments | the paper's experiment results were produced at commit `23eac90`. The release differs from it in production code only by the loopback bind fix in `agentpkg/src/agentpkg/browser/server.py` (no reverse DNS lookup). Rerunning the RQ1 paper preset on the release tree reproduced every one of the 9,099 outcomes, and every summary and LaTeX table byte for byte. RQ2 never executes the changed method |

## Release artifacts

| Asset | Identity | Source in the repository |
|---|---|---|
| `agentpkg-0.2.2-py3-none-any.whl` | agentpkg 0.2.2, Apache-2.0 metadata | `dist/` (rebuilt for this release; see [dist/README.md](../dist/README.md)) |
| `agentpkg-0.2.2.tar.gz` | agentpkg 0.2.2 source distribution | built from `agentpkg/` |
| `agent-browser.tgz` | OpenClaw plugin `agent-browser` 0.1.0, built with OpenClaw 2026.9.5 | built from `openclaw-agent-browser/` |
| `meeting-agenda-0.2.2.agent.pkg` | `org.webagents.meeting-agenda` 0.2.2, digest `dbd2eb81…4679`, signer `sha256:2bcc374a…c5c4` | `dist/` (unchanged; not re-signed) |
| `literature-review-0.2.5.agent.pkg` | `org.webagents.literature-review` 0.2.5, digest `cef9ebd6…55b5`, signer `sha256:c5ca9763…5232` | `dist/` (unchanged; not re-signed) |
| `meeting-agenda-publisher.pub.pem`, `literature-review-publisher.pub.pem` | the development public keys of the two signers | `examples/keys/` |
| `LICENSE`, `THIRD_PARTY_NOTICES.md` | ship beside `agent-browser.tgz`, because `openclaw plugins pack` writes only `package.json`, `openclaw.plugin.json` and the bundled `dist/` files into it | repository root |
| `SHA256SUMS` | the list below | |

SHA-256 of the v0.1.0 release candidate, built from a clean export of the release tree:

```
cc28762bc58e8897b3615d43559b13021a8237e03096d6cb62c46e4732b6ce59  agentpkg-0.2.2-py3-none-any.whl
8d7f7ec7b955d8ae9e2da38c630c262d85db50a22f1ac847853d2f9df16b9ebd  agentpkg-0.2.2.tar.gz
14ffd2385924caeb6b491e0b635e1e6e0bc91123acfebb6e87630162d15ac496  agent-browser.tgz
7b148e845c0f9e38d752a51a8d0b60a314842a3de3a2723b3bdf1a0c041921e1  meeting-agenda-0.2.2.agent.pkg
1669f83fafac3434748fc19d38a8d3d2c3352da83cf1cbb84796ce313bd4f571  literature-review-0.2.5.agent.pkg
```

The wheel, the plugin artifact and the signed packages are reproducible: rebuilding them from the
release commit as below gives the same bytes. The sdist is not byte-reproducible (its tar entries
carry file times), so publish the file whose hash is recorded here, or record the hash of the one
you build.

## Building and checking the artifacts

From a clean checkout of the release commit. Stale `agentpkg/build/` or
`openclaw-agent-browser/dist/` directories from earlier builds can leak into an artifact, so do
not build in a working copy that has them.

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

Never re-sign an unchanged `.agent.pkg`: its archive SHA-256, digest and signature are part of the
recorded evidence and of the paper's experiment manifests. A changed package gets a new version,
a new signature and a new row in `dist/README.md`.

[CI](../.github/workflows/ci.yml) repeats every check on Ubuntu and macOS: the Python suite on
3.11 and 3.13 (Ubuntu) and 3.12 and 3.13 (macOS, where `setup-python` has no 3.11 newer than the
unpatched 3.11.9), the offline acceptance scripts, the wheel and sdist build, an installed-wheel
verification and fixture run of both packages, `check_release.py`, the plugin suite on Node 24 and
26 with no skipped test, build, validation, packing, artifact inspection and isolated install, the
Citation Resolver suite and the experiments' test suites. It needs no credential, model, OpenClaw
configuration, Ollama, live Crossref or hosted resolver.

## Public-release checklist

Status as of the final release-engineering pass (2026-10-02, before the release commit).

| | Item | How it was checked |
|---|---|---|
| ✅ | Apache-2.0 `LICENSE` present | root `LICENSE` is the apache.org text, SHA-256 `cfc7749b…3d30`; `agentpkg/LICENSE` is identical (`check_release.py`) |
| ✅ | Package metadata licenses consistent | `Apache-2.0` in `agentpkg/pyproject.toml` (+ `license-files`), `citation-resolver/pyproject.toml`, `openclaw-agent-browser/package.json` and `package-lock.json` |
| ✅ | License in the Python distributions | the wheel carries `License-Expression: Apache-2.0` and `licenses/LICENSE`; the sdist carries `LICENSE` |
| ✅ | Third-party attribution | `THIRD_PARTY_NOTICES.md`; regenerating `html-entities.ts` from CPython 3.13.5 reproduces it byte for byte |
| ✅ | Internal deck not tracked in the tree | not in `git ls-files`; ignored by `/Portable AI Agents …pdf` and `/*.pdf` |
| ✅ | Local/private files ignored | `/private/`, `.claude/`, virtualenvs, `node_modules/`, build output, `examples/my-*`, `*.tgz`, keys and `.env` files; a fresh clone stays clean after every documented command |
| ✅ | README complete and consistent with the code | versions, commands, artifact names, Linux scope, external services, license, evidence |
| ✅ | Getting-started tested | three fresh-clone rehearsals: empty `HOME`, fresh pip/npm caches, no global OpenClaw, case-sensitive file system |
| ⏳ | macOS CI | the first GitHub run (`f9f6dd2`) failed on macOS twice over: `setup-python`'s macOS 3.11 is the unpatched 3.11.9, and the runners' ~35 s reverse DNS lookup stalled every control-plane start past the plugin's 30 s limit. Both are fixed (macOS now tests 3.12 and 3.13; the bind no longer does a reverse lookup), and the stall was reproduced and cleared locally. **Re-run on GitHub after the next push** |
| ⏳ | Linux CI | same workflow; **confirm the Ubuntu jobs on the next GitHub run** |
| ✅ | Full Python tests | `pytest agentpkg/tests`: 936 passed, 2 skipped (opt-in live tests), on 3.13.5, 3.12.10 and 3.11.14 |
| ✅ | Plugin typecheck, tests, build | 443 tests, none skipped, also with a simulated 35 s reverse DNS lookup; build, validate, pack, isolated install (`npm run verify`) |
| ✅ | Citation Resolver tests | 132 passed |
| ✅ | UI scroll regression | `test/ui-stability.test.ts` in the plugin suite, and the headless-Chrome layout harness from the scroll fix rerun on the current UI: all 30 measured interactions (Authorize, model selection, Prepare run, content tabs, task form, result viewer) identical to the post-fix measurements |
| ✅ | Experiments' test suites | contract overhead 26, contract enforcement 101 (separate processes) |
| ✅ | Current Python distribution | wheel rebuilt from current source; files equal `agentpkg/src`; `check_release.py --built-wheel` |
| ✅ | Current plugin distribution | built from a clean clone; contents are exactly the manifest, `package.json` and the bundles |
| ✅ | Meeting Agenda signed artifact verified | 0.2.2, digest, archive SHA-256 and signer as above; fixture run passes; `workflow.v0`, no tools |
| ✅ | Literature Review signed artifact verified | 0.2.5, digest, archive SHA-256 and signer as above; `verify_literature_022`–`025` pass |
| ✅ | Acceptance evidence accurate | README Table I matches the run records on the recording host; shipped Meeting Agenda runs and their consolidated acceptance record recomputed (artifact hashes, audit chains) |
| ✅ | Secret scan of the tree | gitleaks and trufflehog over the release tree: only documented test fixtures |
| ✅ | Secret scan of the artifacts | wheel, sdist, plugin artifact and signed packages, extracted: only documented test fixtures |
| ✅ | No private signing key | none in the tree or the artifacts; the only private keys are test fixtures generated or embedded for attack tests |
| ✅ | No API credentials | none |
| ✅ | OpenClaw tested version documented | 2026.9.5 (`ec9c1a1`), enforced by `requireVerifiedHostRuntime` |
| ✅ | Linux claim accurately scoped | "covered by CI tests; no live Agent Browser run accepted on Linux" |
| ✅ | Release SHA-256 manifest | above |
| ✅ | Draft release notes | [release-notes-v0.1.0.md](release-notes-v0.1.0.md) |
| ✅ | `git status` understood | the release pass changes are uncommitted; see below |

### Human-only steps

1. ~~Confirm that every co-author and the institution authorize release under Apache-2.0.~~ Confirmed by the maintainer on 2026-10-02.
2. If the paper is under anonymous review, confirm that publishing the repository now does not
   violate the venue's policy. The git history (author names and e-mail addresses) and the
   repository URL identify the authors. The README's clone URL (`<this-repository-url>`) and the
   citation's author field are placeholders to fill in when that is allowed.
3. Review and commit the release-pass changes, including the regenerated `dist/agentpkg-0.2.2-py3-none-any.whl`,
   the regenerated `openclaw-agent-browser/openclaw.plugin.json`, and the removal of
   `examples/demo-live*` from the tree (the local copies are in `/private/examples/`).
4. Push, then watch the first GitHub Actions run on both operating systems and fix anything that
   only shows there.
5. Create and push the `v0.1.0` tag on the commit CI passed.
6. Create the GitHub Release from [release-notes-v0.1.0.md](release-notes-v0.1.0.md), attaching
   the assets above and `SHA256SUMS`.
7. Change the repository's visibility as intended.

### Known technical items, not blocking

- `agentpkg browser-serve` without `--cache-dir` uses Python's temporary directory, which is the
  shared `/tmp` on most Linux systems ([browser-control-plane.md](browser-control-plane.md)). The
  plugin always passes a private one. A per-user default is a change for a later version.
- On Linux the PDF reader's `RLIMIT_AS` cap is enforced for the first time: macOS refuses to set
  it, so it was never active during development. CI exercises the reader on Linux.
- No live Agent Browser run on a Linux OpenClaw host has been accepted.
