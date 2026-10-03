# WebAgents v0.2.0 — release notes (draft)

> Draft. The tag goes on the commit that passes CI on GitHub. The SHA-256 values of the release
> assets are in [releasing.md](releasing.md#release-artifacts).

WebAgents is a **research prototype** that accompanies the paper *WebAgents: Unbundling Agent
Creation, Hosting, and Execution for an Agent-Native Web*. It separates three roles that today's
agent deployments merge: a creator publishes an agent as a signed package, an origin hosts it, and
the user's own runtime verifies and executes it with the user's models, tools, permissions and
budgets. It is not production software: the package format (`agent.pkg` 0.1), the execution
profile (`workflow.v0`) and every interface are experimental and will change.

v0.2.0 is the code the paper describes. It adds the paper's third workflow, a travel agent that a
website publishes beside its HTML pages, and the generic runtime features that workflow needed.
Everything in [v0.1.0](release-notes-v0.1.0.md) is still here and unchanged unless listed below.

## New in v0.2.0

- **WebAir, a website-native agent** ([`demo/webair/`](../demo/webair/README.md),
  [`agents/webair/`](../agents/webair/README.md)). A fictional airline origin serves HTML pages for
  people and, from the same origin, a signed package (`org.webagents.webair` 0.3.0) that reaches
  the airline only through its semantic API: flight search, fare rules, a booking quote and a
  simulated purchase. No real booking or payment ever occurs. The origin is publicly deployed at
  <https://webagents-webair-production.up.railway.app/>, and a 3–5 minute
  [presentation script](webair-live-demo.md) covers the live demo.
- **Website discovery.** The Agent Browser's address bar also takes a website address. The control
  plane reads that one page under the package URL policy and lists its same-origin
  `<link rel="agent-package">` links as unverified candidates; a person chooses which to open. The
  link relation and the media type `application/vnd.webagents.agent-package` are an experimental
  WebAgents convention, not a standard.
- **Host-owned resources.** A new permission kind, `personal.read`, lets a package request a *type*
  of resource the person's host holds (here a travel profile, a passenger identity and a demo
  payment method) through argument-free tools. The person picks one when authorizing; the
  authorization receipt and the Run Plan bind the pick by opaque id and keyed digest, never by
  value; a resource that changes or disappears makes the plan stale. The tool broker returns only
  the granted resource and refuses a sealed value (an e-mail, a payment identifier) in any tool
  call whose permissions do not include the grant. Operators configure the resources with the
  plugin's `hostResources.file`.
- **Operator-configured HTTP tool bindings.** The plugin's `tools.bindingsFile` binds declared
  tools to HTTPS endpoints (`openclaw.tool.json_http` entries only, all-or-nothing, never shadowing
  a built-in binding), so a new origin's API needs configuration, not plugin code.
- **`once` means one run.** The first execution lease under an authorization receipt that grants
  anything `once` spends it (`authorization_once_spent`); running again needs a new decision.
- **The paper's third Table I workflow and three-package overhead results.** The live WebAir runs
  behind Table I are checked in
  [`webair-030-table1-runs.json`](../examples/verification/webair-030-table1-runs.json), and the
  contract overhead benchmark (version 1.1.0) now measures WebAir as well, with its three runs and
  pooled results under `experiments/contract_overhead/results/2026-10-03T*`.
- **CI** gains a WebAir job (origin and package-contract tests, generated files up to date) and
  verifies and fixture-runs WebAir 0.3.0 with the installed wheel.
- **Fixes:** a required object field in the Agent Browser's task form now starts from its column
  defaults; the WebAir publisher tooling's `httpx` requirement is pinned.

## Versions and compatibility

| Component | Version | Note |
|---|---|---|
| `agentpkg` | 0.2.2 | **rebuilt**, SHA-256 `371fb1eb…1cd1`. The version is unchanged because the runtime reports it: the signed packages declare their minimum runtime against it, and the paper's experiments recorded it. The v0.1.0 wheel of the same version (`cc28762b…ce59`) rejects `personal.read`, so it cannot open WebAir 0.2.0 or later |
| Agent Browser plugin | 0.1.0 | rebuilt with the new features; identify the artifact by its SHA-256 |
| Meeting Agenda | 0.2.2 | unchanged, not re-signed |
| Literature Review | 0.2.5 | unchanged, not re-signed |
| WebAir | 0.3.0 | new; `dist/webair.agent.pkg` stays the search-only 0.1.0, which the recorded discovery evidence pins |
| `agent.pkg` / `workflow.v0` | 0.1 / v0 | `personal.read` was added without changing `spec_version`; an older runtime rejects it as an unknown kind, which fails closed |

## Tested platforms

| | Status |
|---|---|
| OpenClaw | **2026.9.5** (`ec9c1a1`). Execution refuses other releases unless the operator opts out. |
| macOS (Apple Silicon) | development platform; every recorded live run, including the paper's Table I runs and the WebAir live demo |
| Ubuntu Linux | continuous integration: Python, plugin, WebAir, Citation Resolver and experiment test suites; offline package verification; plugin build, validation, packing and isolated install. **No live Agent Browser run has been accepted on Linux.** |
| Windows | not supported |
| Python / Node | Python 3.11 ≥ 3.11.10, 3.12 ≥ 3.12.4, or 3.13 (CI: 3.11 and 3.13 on Linux, 3.12 and 3.13 on macOS; development used 3.13); Node 24 (≥ 24.16) or ≥ 26.1 to build the plugin (CI runs 24 and 26) |

## Verifying the release

```sh
python3 -m venv .venv && .venv/bin/pip install agentpkg-0.2.2-py3-none-any.whl
.venv/bin/agentpkg verify meeting-agenda-0.2.2.agent.pkg --trust-key meeting-agenda-publisher.pub.pem
.venv/bin/agentpkg verify literature-review-0.2.5.agent.pkg --trust-key literature-review-publisher.pub.pem
.venv/bin/agentpkg verify webair-0.3.0.agent.pkg --trust-key webair-publisher.pub.pem
shasum -a 256 -c SHA256SUMS
```

| Package | Version | Package digest | Signer fingerprint |
|---|---|---|---|
| `org.webagents.meeting-agenda` | 0.2.2 | `dbd2eb816bb8687d4a5b3448f5b82bc0716c3884f9fee8a2c578af0c5e894679` | `sha256:2bcc374a7fe18e50622042b7d0375fcb24eb3607879a236f9f3c3ede1922c5c4` |
| `org.webagents.literature-review` | 0.2.5 | `cef9ebd68df9db3b36c1ffeac9069d734b0e41a40d58445aaba1a60eaac155b5` | `sha256:c5ca9763f9fc71253298ca381ec14c4d7432009c74dacc69df6344b71de05232` |
| `org.webagents.webair` | 0.3.0 | `ffe8f5b344f97c631498bb6da3e17217ae7e5730721935b0e66c5d595b335e94` | `sha256:2e53accec575b37bf16c189e03cd3a6b2f2cfae2339ff05361bf585dc3d4a20b` |

The publisher keys are development keys. A valid signature shows which key signed a package. It
does not certify the publisher or the workflow.

## External dependencies of live runs

Two services hosted by the authors are named by signed packages. Both are research/demo
deployments with no availability guarantee. Fixture-mode runs, the offline verification scripts,
the test suites and CI never contact either.

- **The Citation Resolver** at `webagents-citation-resolver-production.up.railway.app`, used by
  live Literature Review runs together with public Crossref. To use another deployment, run
  `citation-resolver/` yourself and rebuild and sign the package with your own key.
- **The WebAir origin** at `webagents-webair-production.up.railway.app`, used by live WebAir runs.
  Its fictional schedule ends on 31 December 2027. To run WebAir elsewhere, deploy `demo/webair/`
  (see its README) and publish a package version that declares the new host.

## Known limitations

Everything listed for [v0.1.0](release-notes-v0.1.0.md#known-limitations) still applies, except
that the run records behind the paper's Table I now include a checked summary for the WebAir rows
(the six run records themselves stay on the recording host). In addition:

- `agent.pkg` 0.1 has no optional tools. The Agent Browser must bind and approve all seven WebAir
  tools before any run, so a host that holds none of the three resource types cannot run WebAir
  0.2.0 or later, even for a search that reads none of them.
- The sealed-value check is an exact-value check over values the host holds, not a general
  data-loss filter: unsealed fields (preferences) are ordinary data.
- A WebAir booking quote is for one passenger, and a simulated purchase buys exactly one quote
  that an earlier run returned.
- The WebAir end-to-end walk-through (quote, simulated purchase, refused replay, denied purchase)
  was accepted with one hosted model, `openai/gpt-6-astra`; the Table I search runs used
  `ollama/qwen3:30b` and `openai/gpt-5.6-luna`. With `ollama/qwen3:30b`, one of four live booking
  attempts failed closed with `model_output_truncated` because the selection step spent its
  output budget on reasoning.

## License

Apache License 2.0 (`Apache-2.0`). Third-party material, including tables and expressions derived
from CPython and the TypeBox and OpenClaw plugin-SDK code bundled into the plugin artifact, is
listed in `THIRD_PARTY_NOTICES.md`, which ships beside the plugin artifact because the OpenClaw
plugin packer does not carry license files. v0.2.0 adds no bundled third-party code.
