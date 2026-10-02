# Public-release checklist

Items that need an author decision before this repository is made public. None of them is
automated; nothing here rewrites history.

## 1. License (decision required)

No license has been chosen. There is no `LICENSE` file and no license field in any package
metadata. Until one is added, the default is "all rights reserved", and others may not reuse the
code.

Once a license is chosen, adding it touches exactly these places:

| File | MIT | Apache-2.0 |
|---|---|---|
| `LICENSE` (new, repository root) | MIT text with the year and copyright holder | Apache-2.0 text, unmodified |
| `NOTICE` (new, root) | not required | recommended: project name, copyright line, and the third-party notes from §3 |
| `agentpkg/pyproject.toml`, `[project]` | copy `LICENSE` to `agentpkg/LICENSE`; `license = "MIT"`, `license-files = ["LICENSE"]` | same copy; `license = "Apache-2.0"`, `license-files = ["LICENSE"]` |
| `citation-resolver/pyproject.toml`, `[project]` | `license = "MIT"` | `license = "Apache-2.0"` |
| `openclaw-agent-browser/package.json` | `"license": "MIT"` | `"license": "Apache-2.0"` |
| `README.md`, *License* section | replace the placeholder | replace the placeholder |

`agentpkg` builds with setuptools ≥ 77, which supports the SPDX `license` / `license-files` fields
(PEP 639). `license-files` paths are relative to `agentpkg/` and may not use `..`, hence the copy. Rebuilding the wheel changes its hash in `dist/README.md`; the
signed `.agent.pkg` files are unaffected.

## 2. Material kept locally, not published

| Item | Status |
|---|---|
| `Portable AI Agents and the OpenClaw Agent-Native Browser.pdf` (project slide deck) | untracked and git-ignored; the file stays in the working tree. **It is still present in git history** (commit `d18b839`). Making the existing history public also publishes it. Removing it requires a history rewrite (for example `git filter-repo --path '<file>' --invert-paths`) and a force-push, or publishing from a fresh repository. |
| `/private/` | git-ignored; a place for local-only notes and material |

## 3. Third-party material to review

| Item | What it is | Suggested action |
|---|---|---|
| `openclaw-agent-browser/src/html-entities.ts` | Generated data tables taken from CPython 3.13's `html` module (`html.entities.html5`, `_invalid_charrefs`, `_invalid_codepoints`), which encode the WHATWG named character references | attribution review (Python Software Foundation License; WHATWG HTML Standard) |
| `openclaw-agent-browser/src/html-text.ts` | Regular expressions transcribed from CPython 3.13 `html/parser.py` and `_markupbase.py` | attribution review (PSF License) |
| `examples/demo-live-fulltext/` | Recorded run with excerpts from two ACL Anthology papers (MasRouter, AgentDropout), including author e-mail addresses from the papers' first pages | confirm redistribution terms (ACL Anthology material is generally CC BY 4.0) or drop the directory |
| `examples/demo-live*/`, `examples/literature-review-live*/`, `examples/workflow-review/`, `examples/verification/*literature*` | Recorded runs containing Crossref metadata, abstracts and short quotations from scholarly works | confirm that redistributing these excerpts as research evidence is acceptable |

Runtime dependencies (`jsonschema`, `cryptography`, `pypdf`, `rfc8785`, `typebox`, FastAPI, httpx
and others) are installed from package registries, not vendored.

## 4. Before flipping visibility

- Re-run the secret scan over the full history (`gitleaks git .`, `trufflehog git file://.`).
  The last scan found only test fixtures.
- Re-run the suites listed in [getting-started.md](getting-started.md#1-offline-cli) and the plugin
  suite (`cd openclaw-agent-browser && npm test`).
- Confirm that the hosted Citation Resolver should remain publicly reachable, since the signed
  Literature Review package names its origin.
