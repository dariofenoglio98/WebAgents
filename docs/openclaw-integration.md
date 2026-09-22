# OpenClaw integration: a verified workspace adapter

> **Scope note.** This adapter is the **legacy/current compatibility bridge**:
> it verifies an artifact and stages a workspace of supported `SKILL.md`
> wrappers. The native Agent Browser experience is now the separate
> [browser control plane](browser-control-plane.md) plus the
> [Agent Browser feature plugin](openclaw-agent-browser.md). Both paths remain
> supported; wrapper-SKILL staging is not being extended into the browser
> architecture.


The adapter verifies a signed `.agent.pkg` with an **operator-selected Ed25519 public key**, then stages a new workspace that OpenClaw can discover through its supported skills interface. It does not change OpenClaw core, enable plugins, alter personal configuration, select a model, or grant runtime permissions.

The environment inspected for this implementation reports **OpenClaw 2026.9.5 (`ec9c1a1`)**. Its installed public documentation was read at `/opt/homebrew/lib/node_modules/openclaw/docs`: `tools/skills.md`, `cli/skills.md`, `cli/agent.md`, `help/environment.md`, `plugins/sdk-runtime/models.md`, `plugins/sdk-runtime/background-work.md`, and `gateway/openresponses-http-api.md`. Paths identify the inspected development installation; they are not embedded in packages.

## What is supported today

OpenClaw discovers `<workspace>/skills/<name>/SKILL.md` with YAML `name` and `description` frontmatter. `{baseDir}` resolves references relative to the skill folder. Workspace skills have high precedence, and skill availability is separate from authorization to use tools. See the [official skills interface](https://docs.openclaw.ai/tools/skills) and [skills CLI](https://docs.openclaw.ai/cli/skills).

The adapter uses that interface directly. It creates host-generated, digest-prefixed skill names, so a package cannot replace another workspace's existing skills or smuggle `command-dispatch` frontmatter into a wrapper. Original signed instructions remain exact bytes under `payload/`; wrappers link to them. Each capability wrapper points back to the coordinator, preserving the distinction between a skill and an execution role.

```sh
agentpkg install-openclaw dist/literature-review.agent.pkg \
  --workspace examples/openclaw-workspace \
  --trust-key examples/keys/publisher.pub.pem
```

The workspace must be **new**, and its parent directory must exist. Existing paths and symlink ancestors are rejected. On macOS, use `/private/tmp/...` instead of the `/tmp` symlink when staging temporary workspaces. The command prints a receipt including package identity, version, digest, trust verification, skill mappings, and requested permission metadata. Staging is not permission approval.

The resulting layout is:

```text
openclaw-workspace/
  agentpkg-installation.json
  agent-packages/<content-digest>/
    package.agent.pkg
    publisher.pem
    permissions.json
    adapter.json
    payload/MANIFEST.agent
    payload/graph.json
    payload/...all verified source members...
  skills/agentpkg-<digest-prefix>-run/SKILL.md
  skills/agentpkg-<digest-prefix>-<index>-<capability>/SKILL.md
```

The archive, payload, wrappers, and receipts use read-only file modes. These prevent accidental edits; they are **not OS-level immutability against the account owner**. Reverify the signed artifact against the operator's trusted key before execution. The install receipt also hashes every materialized file, allowing inspection of wrapper/snapshot changes. It is an adapter receipt, not a publisher signature or independent attestation.

The adapter snapshots archive and trust-key bytes once before verification. Validation, verification, and loading use those captured bytes, so replacing the input artifact between operations cannot substitute an unverified payload. Writes use exclusive creation and directory descriptors with no-follow semantics. It never extracts an archive directly over a host directory. A failed write can leave an incomplete new workspace; absence of a completed `agentpkg-installation.json` receipt means staging did not finish.

## Discovery and execution are separate

The automated integration test runs the installed `openclaw skills list --json` against a temporary configuration and state directory, disables plugins, and directs the optional local gateway probe to port 1 so it falls back to local inventory. It supplies no provider credentials and does not perform inference. It asserts discovery of the coordinator and every capability wrapper.

An operator can point a separately configured OpenClaw agent at the staged workspace. The supported `openclaw agent exec --cwd <workspace> --config <operator-config> --json` interface is another possible entry point; it may incur model charges and uses the specified host tool policy. Running discovery does not prove that a model has selected or executed the skill. See [agent CLI](https://docs.openclaw.ai/cli/agent).

The coordinator wrapper directs execution through the separately installed Python `agentpkg` runtime. The operator must provide its host tool/model bindings and explicit grants. `agentpkg run --help` describes the executable reference workflow. A trusted host launcher can invoke that command from OpenClaw; otherwise the skill presents the invocation to the operator. The adapter itself does not install an unrestricted shell tool or a package-provided executable.

Native OpenClaw execution is **not** used to enforce the package graph. Spawning ordinary OpenClaw subagents in response to instructions would not prove that the package's own worker limits, budgets, or state visibility were applied. The reference runtime remains the enforcement boundary for its mediated operations.

## Model/router interface findings

The installed plugin SDK offers `api.runtime.llm.complete` for host-owned completions and model/auth routing. `execution.mode: "isolated-agent-runtime"` can select a fresh context with zero model-callable tools. The response can provide model/provider attribution and usage. However, the installed documentation explicitly describes `maxTokens` as advisory and allows token usage to be absent for some CLI transports. The Python runtime cannot truthfully infer a hard billing/token ceiling from that interface alone. See [runtime model helpers](https://docs.openclaw.ai/plugins/sdk-runtime/models).

`api.runtime.subagent.complete` also supports fresh tool-free completion and host-selected credentials, but currently returns text without a token ledger. Ordinary `subagent.run` can expose the configured agent's tools and should not be substituted for bounded package workers. See [background-work interfaces](https://docs.openclaw.ai/plugins/sdk-runtime/background-work).

The optional Gateway `POST /v1/responses` endpoint is disabled by default and represents operator access. Its documented `max_output_tokens` is best-effort; `max_tool_calls` is accepted but ignored. It is therefore not a sufficient hard-budget or zero-tool boundary for this prototype. The adapter does not enable or connect to it. See [OpenResponses endpoint](https://docs.openclaw.ai/gateway/openresponses-http-api).

A future host plugin should expose only package-authorized tools and bounded, tool-free model completions, reserve usage before dispatch, reliably report actual usage, and refuse providers whose budget guarantees cannot satisfy the selected runtime policy. It should retain the user's configured model selection rather than putting vendor model names or credentials into package metadata. That plugin is future integration work, not a capability demonstrated by staging.

## Enforcement accounting

| Property | Adapter | OpenClaw skills alone |
|---|---|---|
| Formal package validation and integrity | Enforced before staging | No native `.agent.pkg` reader assumed |
| Signature and external trusted-key match | Enforced before staging | No package trust claim inferred |
| No overwrite, traversal, or symlink staging | Enforced by exclusive relative writes | Not delegated to skill instructions |
| Identity/version/digest receipt | Recorded | Visible as ordinary workspace content |
| Permission display | Rendered from verified metadata | Instructions can display it |
| Permission grants | None granted during staging | Skills cannot grant authority |
| Worker/tool/model budgets, graph, state views | Python runtime's mediated operations | Not enforced by wrappers |
| Host shell, filesystem, credentials outside Python runtime | Operator/OS responsibility | Governed separately by actual host configuration |
| Persistent memory deletion/encryption | Not provisioned by adapter | No guarantee inferred from memory metadata |

This realizes the PDF's browser-seed path—downloaded package, verification, permission inspection, supported instruction loading—while keeping the stronger future browser claims separate (PDF sections 2, 9, 14, 16, 17, and 21).

## Where this went next

The staged workspace gives OpenClaw *discovery* of a verified package. It does
not give a user a package browser: there is no place to see layered validation,
distinguish a self-consistent signature from a trusted publisher, review
requested permissions, or record an authorization decision.

Those operations live in the [browser control plane](browser-control-plane.md),
behind an authenticated loopback API returning bounded JSON, and the
[Agent Browser feature plugin](openclaw-agent-browser.md) now renders them as a
native Control UI page. It is pinned to **OpenClaw 2026.9.5 (`ec9c1a1`)** and
uses `openclaw/plugin-sdk/feature-contract`, `feature-plugin` and `control-ui`.
It reimplements no verification, trust or permission semantics, and it executes
nothing.
