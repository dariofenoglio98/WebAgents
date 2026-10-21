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
| [spec/conversation-v0.md](../spec/conversation-v0.md) | `conversation.v0`: turns over a declared persistent state inside `workflow.v0`, the `consent` node and the gate before consequential tools, per-turn and per-conversation budgets with whole-turn reservation, `once` per conversation, the transcript and one audit chain across turns, the enforcement cases; machine contracts in [spec/conversation-v0/](../spec/conversation-v0/), the test package in [examples/conversation/](../examples/conversation/); normative for agentpkg 0.6.0 and Chrome core 0.4.0 (T24) |
| [spec/compute-v0.md](../spec/compute-v0.md) | `compute.v0`: WebAssembly core modules as pure functions inside `workflow.v0` (the member, the structural requirements and the instruction gate, the ABI, the limits, the failures and audit, the enforcement cases); machine contracts in [spec/compute-v0/](../spec/compute-v0/), examples in [examples/compute/](../examples/compute/); normative for agentpkg 0.5.0 and Chrome core 0.3.0 |
| [spec/memory-v0.md](../spec/memory-v0.md) | `memory.v0`: the user-owned memory of Markdown records (the record document, the graph, recall, proposals, the agent document, export and import); machine contracts and worked examples in [spec/memory-v0/](../spec/memory-v0/); normative for agentpkg 0.4.0 and Chrome core 0.2.0 |
| [spec/extensions/profiles-v0.md](../spec/extensions/profiles-v0.md) | Publisher-declared profiles (`org.webagents:profiles-v0`), a noncritical manifest extension that groups declared authority and grants none |

## Guides

| Document | Contents |
|---|---|
| [getting-started.md](getting-started.md) | Installation, OpenClaw plugin setup, model configuration (Ollama, hosted OpenAI), and the Chrome Agent Browser (level 4) |
| [architecture.md](architecture.md) | Architecture and concrete design decisions |
| [writing-a-compute-module.md](writing-a-compute-module.md) | The publisher's guide to a compute module: when to write one, the ABI in one screen, declaring it, building it with AssemblyScript or Rust, what the person sees |
| [threat-model.md](threat-model.md) | Assets, trust boundaries and what the prototype does and does not defend; the Chrome Agent Browser's network, storage, permission and review boundaries ([§ Chrome](threat-model.md#chrome-agent-browser-t7)); the optional macOS helper and installer ([§ helper](threat-model.md#native-helper-and-macos-installer-t17)); the user-owned memory ([§ memory](threat-model.md#user-memory-t18-memoryv0)); code in packages ([§ compute](threat-model.md#code-in-packages-t21-computev0)); conversations and consent ([§ conversation](threat-model.md#conversations-and-consent-t23-conversationv0)) |
| [browser-control-plane.md](browser-control-plane.md) | `agentpkg browser-serve`: opening, snapshots, validation, trust, authorization, and experimental website discovery (`rel="agent-package"`, §3a) |
| [model-selection-and-run-plan.md](model-selection-and-run-plan.md) | Model compatibility semantics and the run-plan schema |
| [model-availability.md](model-availability.md) | Which host view means "this model can be used" |
| [model-router.md](model-router.md) | The host model-router interface |
| [model-router-bridge.md](model-router-bridge.md) | How a run plan reaches the selected model through OpenClaw |
| [package-execution.md](package-execution.md) | Executing a signed package: lease, re-verification, runner, run record |
| [tool-broker.md](tool-broker.md) | Host tool bindings, approvals and the built-in tool implementations |
| [openclaw-agent-browser.md](openclaw-agent-browser.md) | The OpenClaw Agent Browser plugin: architecture, trust semantics, website discovery in the page (§5b), limitations |
| [chrome-agent-browser.md](chrome-agent-browser.md) | The Chrome Agent Browser, the second runtime: architecture, the extension and the Node CLI, the core boundary, storage, permissions, limits, packaging, the optional installer and helper (§12; [../installer/README.md](../installer/README.md)); its user guide is [../chrome-agent-browser/README.md](../chrome-agent-browser/README.md) |
| [../conformance/README.md](../conformance/README.md) | The cross-runtime conformance suite: what it compares between `agentpkg` and the Chrome core, the normalization, the recorded differences, and what it does not show |
| [openclaw-integration.md](openclaw-integration.md) | The older verified-workspace staging adapter (`install-openclaw`) |
| [workflow-migration.md](workflow-migration.md) | Migration from the legacy Literature Review runner to generic execution |
| [literature-walkthrough.md](literature-walkthrough.md) | Walkthrough of the reference package layout |
| [../demo/webair/README.md](../demo/webair/README.md) | WebAir demo: a fictional airline origin publishing its HTML site and a signed `agent.pkg` over one service, how the Agent Browser discovers it, and how the package requests host-owned capabilities (a travel profile, a passenger identity, a demo payment method) that the person's host grants |
| [webair-live-demo.md](webair-live-demo.md) | The WebAir live demo as a presentation script: the public origin, discovery, trust, a profile-assisted search, a quote, a simulated purchase in a separate `once` authorization, a denied purchase, and how to reset the demo |
| [releasing.md](releasing.md) | Release procedure, artifact SHA-256 manifest, the Chrome extension's zip, and the public-release checklist |
| [release-notes-v0.2.0.md](release-notes-v0.2.0.md) | Draft notes for v0.2.0, the release the paper describes (WebAir, website discovery, host-owned resources) |
| [release-notes-v0.1.0.md](release-notes-v0.1.0.md) | Notes for v0.1.0, superseded by v0.2.0 |
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
