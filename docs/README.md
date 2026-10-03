# Documentation index

Start with the root [README](../README.md) for what WebAgents is and the shortest demo, and
[getting-started.md](getting-started.md) for full installation. The documents below fall into
three groups: **specifications** (normative for the prototype), **guides** (how a component
works and how to operate it), and **reports** (dated milestone records with the evidence behind
each claim). Reports are historical: a later report or the current artifacts in
[dist/README.md](../dist/README.md) supersede earlier numbers.

## Specifications

| Document | Contents |
|---|---|
| [spec/agent-pkg-v0.md](../spec/agent-pkg-v0.md) | The `agent.pkg` container: manifest, integrity statement, signature, parsing limits |
| [spec/workflow-v0.md](../spec/workflow-v0.md) | The `workflow.v0` execution profile: node types, state, waves, validation |

## Guides

| Document | Contents |
|---|---|
| [getting-started.md](getting-started.md) | Installation, OpenClaw plugin setup, model configuration (Ollama, hosted OpenAI) |
| [architecture.md](architecture.md) | Architecture and concrete design decisions |
| [threat-model.md](threat-model.md) | Assets, trust boundaries and what the prototype does and does not defend |
| [browser-control-plane.md](browser-control-plane.md) | `agentpkg browser-serve`: opening, snapshots, validation, trust, authorization |
| [model-selection-and-run-plan.md](model-selection-and-run-plan.md) | Model compatibility semantics and the run-plan schema |
| [model-availability.md](model-availability.md) | Which host view means "this model can be used" |
| [model-router.md](model-router.md) | The host model-router interface |
| [model-router-bridge.md](model-router-bridge.md) | How a run plan reaches the selected model through OpenClaw |
| [package-execution.md](package-execution.md) | Executing a signed package: lease, re-verification, runner, run record |
| [tool-broker.md](tool-broker.md) | Host tool bindings, approvals and the built-in tool implementations |
| [openclaw-agent-browser.md](openclaw-agent-browser.md) | The OpenClaw Agent Browser plugin: architecture, trust semantics, limitations |
| [openclaw-integration.md](openclaw-integration.md) | The older verified-workspace staging adapter (`install-openclaw`) |
| [workflow-migration.md](workflow-migration.md) | Migration from the legacy Literature Review runner to generic execution |
| [literature-walkthrough.md](literature-walkthrough.md) | Walkthrough of the reference package layout |
| [../demo/webair/README.md](../demo/webair/README.md) | WebAir demo: a fictional airline origin publishing its HTML site and a signed `agent.pkg` over one service |
| [releasing.md](releasing.md) | Release procedure, artifact SHA-256 manifest, and the public-release checklist |
| [release-notes-v0.1.0.md](release-notes-v0.1.0.md) | Draft notes for the first public release |
| [../THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md) | Third-party material in the repository and the plugin artifact, and its terms |

## Reports (chronological)

| Document | Milestone |
|---|---|
| [implementation-plan.md](implementation-plan.md), [implementation-report.md](implementation-report.md) | agent.pkg v0 and the original Literature Review runner |
| [workflow-report.md](workflow-report.md) | `workflow.v0` generic interpreter |
| [browser-report.md](browser-report.md) | Browser control plane |
| [agent-browser-plugin-report.md](agent-browser-plugin-report.md) | OpenClaw Agent Browser plugin |
| [model-selection-report.md](model-selection-report.md) | Model discovery, compatibility and run plans (3B1) |
| [model-router-bridge-report.md](model-router-bridge-report.md) | Model-router bridge |
| [package-execution-report.md](package-execution-report.md) | First real package execution, Meeting Agenda 0.2.1 (3B2) |
| [tool-broker-report.md](tool-broker-report.md) | Host tool broker (3B3) |
| [literature-review-execution-report.md](literature-review-execution-report.md) | Literature Review executed for real on a local model (3B4) |
| [demo-experience-report.md](demo-experience-report.md) | Browser-started demo (3C) |
| [meeting-agenda-022-report.md](meeting-agenda-022-report.md) | Meeting Agenda 0.2.2 diagnosis and acceptance |
| [literature-review-024-report.md](literature-review-024-report.md) | Literature Review 0.2.4 acceptance |
| [literature-review-025-report.md](literature-review-025-report.md) | Literature Review 0.2.5 (current) |
| [development-history.md](development-history.md) | The milestone narrative formerly in the root README |

Evidence files referenced by the reports live in
[examples/verification/](../examples/verification/) and recorded run directories under
[examples/](../examples/README.md). Absolute paths in those files were replaced by `<repo>`
(this checkout), `~` (the recording user's home directory) and `$TMPDIR`; nothing else in them
was changed.
