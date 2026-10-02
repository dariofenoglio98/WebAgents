# WebAgents v0.1.0 — release notes (draft)

> Draft for the first public release. Not tagged. The SHA-256 values of the release assets are in
> [releasing.md](releasing.md#release-artifacts).

WebAgents is a **research prototype** that accompanies the paper *WebAgents: Unbundling Agent
Creation, Hosting, and Execution for an Agent-Native Web*. It separates three roles that today's
agent deployments merge: a creator publishes an agent as a signed package, an origin hosts it, and
the user's own runtime verifies and executes it with the user's models, tools, permissions and
budgets. It is not production software: the package format (`agent.pkg` 0.1), the execution
profile (`workflow.v0`) and every interface are experimental and will change.

## What is in this release

- **`agent.pkg`**: a portable, declarative agent artifact. It is a deterministic, data-only
  archive holding a manifest, a workflow graph, Markdown skills, JSON schemas, tool declarations
  and policies, protected by SHA-256 content hashes and an Ed25519 publisher signature. It contains
  no executable code. Its requirements, such as structured output, a context size or a scholarly
  search tool, are declarations, **not permissions**.
- **`agentpkg` 0.2.2** (Python ≥ 3.11): the reference tooling and runtime. It builds, validates,
  signs, verifies, inspects and runs packages in fixture mode; provides the generic `workflow.v0`
  interpreter (`llm`, `tool`, `map`, `join`, `validate` and `output` nodes, with budgets, deadlines,
  cancellation and a hash-linked audit trail); and runs the loopback control plane
  (`agentpkg browser-serve`) behind the Agent Browser.
- **OpenClaw Agent Browser plugin** 0.1.0: an OpenClaw Control UI page that opens a package from
  an approved local directory or an HTTPS URL, verifies it, keeps signature validity and publisher
  trust separate, records per-permission and per-tool decisions, lists only the models the host
  actually has, freezes everything into a hash-bound Run Plan, re-verifies it, and runs the
  package's own graph with live progress, cancellation, result artifacts and the audit chain.
- **Two example packages**, both run by the same generic interpreter with no package-specific code:
  - **Meeting Agenda 0.2.2**: the short, model-only example. It plans a meeting, runs three parallel
    perspectives and writes an agenda whose minutes sum exactly to the requested duration.
  - **Literature Review 0.2.5**: the full demonstration. Search, screening, citation resolution,
    evidence extraction, synthesis, writing and verification through three host tools (Crossref
    search, the Citation Resolver, operator-selected PDFs). Evidence rows, direct quotes and
    bibliography records are copied deterministically from trusted tool data, not re-typed by the
    model, and strict validators refuse a run whose output does not match them.
- **Citation Resolver** (FastAPI) source and **a minimal package origin**.
- **The paper's offline experiments** (`experiments/`): contract enforcement (controlled violations
  with ablations) and contract overhead (latency), with their recorded results.

## Host-controlled models and tools

The package names what it needs; the host and its user grant authority. Models are whatever the
OpenClaw host reports. Each run is bound to exactly the model in its Run Plan, with no fallback,
and WebAgents never receives a provider credential. Tools are host implementations, bound per
declared tool, each needing its own approval in addition to a permission grant. Tested bindings:
local **Ollama** (`ollama/qwen3:30b`) and hosted **OpenAI** through OpenClaw (`openai/gpt-5.6-luna`).

## Tested platforms

| | Status |
|---|---|
| OpenClaw | **2026.9.5** (`ec9c1a1`). Execution refuses other releases unless the operator opts out. |
| macOS (Apple Silicon) | development platform; every recorded live run, including the paper's Table I runs |
| Ubuntu Linux | continuous integration: Python, plugin, Citation Resolver and experiment test suites; offline package verification; plugin build, validation, packing and isolated install. **No live Agent Browser run has been accepted on Linux.** |
| Windows | not supported |
| Python / Node | Python ≥ 3.11 (CI runs 3.11 and 3.13; development used 3.13); Node 24 (≥ 24.16) or ≥ 26.1 to build the plugin (CI runs 24 and 26) |

## Verifying the release

```sh
python3 -m venv .venv && .venv/bin/pip install agentpkg-0.2.2-py3-none-any.whl
.venv/bin/agentpkg verify meeting-agenda.agent.pkg --trust-key meeting-agenda-publisher.pub.pem
.venv/bin/agentpkg verify literature-review.agent.pkg --trust-key literature-review-publisher.pub.pem
shasum -a 256 -c SHA256SUMS
```

| Package | Version | Package digest | Signer fingerprint |
|---|---|---|---|
| `org.webagents.meeting-agenda` | 0.2.2 | `dbd2eb816bb8687d4a5b3448f5b82bc0716c3884f9fee8a2c578af0c5e894679` | `sha256:2bcc374a7fe18e50622042b7d0375fcb24eb3607879a236f9f3c3ede1922c5c4` |
| `org.webagents.literature-review` | 0.2.5 | `cef9ebd68df9db3b36c1ffeac9069d734b0e41a40d58445aaba1a60eaac155b5` | `sha256:c5ca9763f9fc71253298ca381ec14c4d7432009c74dacc69df6344b71de05232` |

The publisher keys are development keys. A valid signature shows which key signed a package. It
does not certify the publisher or the workflow.

## Security and trust model, in brief

- A package carries no code and no authority. Verification (integrity, signature) and trust (is
  this key pinned for this package-id prefix?) are separate decisions, and both are the host's.
- Authorization is per permission and per tool, and is bound into an immutable Run Plan that is
  re-verified before execution; a stale plan is refused.
- Every model and tool call goes through host bridges, under package-declared and host-lowered
  budgets, deadlines and limits. The audit trail is locally hash-linked.
- The boundary assumes a trusted OpenClaw host and trusted adapters. Prompt injection can still
  misuse a capability the user approved, and sending context to a hosted model is not keeping it
  local. See [threat-model.md](threat-model.md).

## External dependency: the hosted Citation Resolver

The signed Literature Review package declares the Citation Resolver hosted by the authors at
`webagents-citation-resolver-production.up.railway.app`. It is an external research/demo service
with no availability guarantee. Together with public Crossref, its availability decides whether a
**live** Literature Review run completes and how much it finds. Fixture-mode runs, the offline
verification scripts, the test suites and CI never contact it. To use another deployment, run
`citation-resolver/` yourself and rebuild and sign the package with your own key.

## Known limitations

- Portability is not equivalence: different models give different answers, and a completed run
  with a valid audit chain does not show that an answer is correct or a review complete.
- One runtime implementation and one host (OpenClaw 2026.9.5) exist, so cross-runtime
  interoperability is untested. The plugin relies on OpenClaw's experimental plugin and Control UI
  APIs.
- Literature Review 0.2.5 passes offline acceptance but has not been run live; the paper's live
  Literature Review runs used 0.2.4, which differs only in a step after the last model call.
- Public Crossref covers recent AI topics thinly, so live reviews may include only a few papers.
- Local-model runs are slow (about 25 minutes for Literature Review with `qwen3:30b` on an M3 Max)
  and sensitive to host resource limits. The packages' timing and budget policies were set from
  measurements on one machine.
- Cancellation is not rollback. The Agent Browser offers no persistent ("always") authorization:
  decisions last for one package session.
- The run records behind the paper's Table I are not included in the repository; the README says
  exactly which evidence is.
- On Linux, `agentpkg browser-serve` started without `--cache-dir` keeps its cache under the shared
  `/tmp`, where another local user can block it from starting. Pass a private `--cache-dir` on
  multi-user hosts; the Agent Browser plugin always does.
- The URL policy relies on Python's `ipaddress` classification, which older patch releases got
  wrong for some special-purpose addresses. Use a current patch release of Python.

## License

Apache License 2.0 (`Apache-2.0`). Third-party material, including tables and expressions derived
from CPython and the TypeBox and OpenClaw plugin-SDK code bundled into the plugin artifact, is
listed in `THIRD_PARTY_NOTICES.md`, which ships beside the plugin artifact because the OpenClaw
plugin packer does not carry license files.
