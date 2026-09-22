# Milestone report: model discovery, compatibility and the run plan

What was built, what was tested, and what the operator's real OpenClaw host
actually reported. The architecture and schemas live in [model selection and the
run plan](model-selection-and-run-plan.md); this document is the evidence.

Host: **OpenClaw 2026.9.5 (`ec9c1a1`)**, agentpkg **0.2.0**, plugin **0.1.0**.

**The boundary is unchanged: nothing executes.** Model *discovery* was added.
Model *inference* was not.

## 1. What changed

| Layer | Added |
|---|---|
| `agentpkg/browser/hostmodels.py` | Host catalog validation, normalized package requirement sets, tri-state compatibility evaluation |
| `agentpkg/browser/runplan.py` | Execution modes, run-mode permission rules, run-plan construction and hashing, preflight recomputation |
| `agentpkg/browser/control.py` | `model_requirements`, `evaluate_models`, `prepare_run_plan`, `run_plan`, `clear_run_plan`; plans discarded on re-authorization |
| `agentpkg/browser/server.py` | Five control-plane routes; request bound raised to 256 KiB |
| `agentpkg/browser/authorization.py` | `BrowserPolicy.require_confirmed_model_compatibility` |
| `agentpkg/cli.py` | `browser-serve --allow-unverified-model` |
| `openclaw-agent-browser/src/host-models.ts` | The one OpenClaw-aware module: discovery and its safe projection |
| `src/contract.ts`, `project.ts`, `backend.ts`, `index.ts`, `errors.ts` | Four typed operations, bounded DTOs, four new error codes |
| `src/ui/page.ts`, `control-ui.css` | Model section and run-plan card |

No package was modified. Neither reference manifest changed a single byte, and
their digests are the same ones the previous milestone authorized.

## 2. Test results

| Suite | Result |
|---|---|
| `agentpkg` pytest | **410 passed, 1 skipped, 0 failed** ([junit](../examples/verification/model-agentpkg-tests.xml), [log](../examples/verification/model-agentpkg-tests.txt)) |
| plugin vitest | **103 passed, 0 failed** |
| `npm run verify` (build → validate → pack → isolated install → tests) | **passed** ([report](../examples/verification/agent-browser-plugin.json)) |
| Real-host acceptance, both packages | **passed** ([record](../examples/verification/model-selection-run-plan.json)) |

New test files: `agentpkg/tests/test_browser_models.py` (30 cases),
`agentpkg/tests/test_browser_runplan.py` (23 cases),
`openclaw-agent-browser/test/host-models.test.ts` (15 cases),
`openclaw-agent-browser/test/run-plan.test.ts` (13 cases), plus additions to
`test_browser_service.py`, `test_browser_boundary.py`, `contract.test.ts` and
`ui.test.ts`.

What they cover, by the brief's own checklist:

* **Discovery** — models read from a stubbed host runtime; a provider with no
  credential excluded; no hardcoded provider list anywhere; no credential in any
  output; an empty catalog handled as an explained state; a failing host reported
  as `model_catalog_unavailable`; a model that disappears between listing and
  preparing refused with `model_unknown`.
* **Compatibility** — satisfied and insufficient context; a capability confirmed
  true, confirmed false, and unknown; an unmet preference leaving a model
  compatible; multiple requirements; both packages through one evaluator.
* **Authorization** — model permission denied → no plan; granted → plan; a
  superseded receipt id refused; an expired receipt making a plan stale; a
  changed digest refused; publisher trust removed → stale.
* **Run plan** — deterministic canonical hashing and tamper detection; exact
  package, receipt, model and catalog binding; no secrets; closing the package
  removing the plan; re-authorization discarding it.
* **UI** — three statuses rendered; incompatible disabled; unverified labelled
  and explained; nothing preselected; the permission message; *Prepare run*;
  *Ready to run*; a stale plan; a read-only operator; **no Run button**.
* **Genericity** — every compatibility and run-plan test is parameterized over,
  or repeated for, both shipped packages.

## 3. What the real host reported

Recorded live through the installed plugin, driven with
`openclaw gateway call plugins.sessionAction`:

```text
host    openclaw 2026.9.5 · source openclaw/plugin-sdk/models-provider-runtime
counts  total 5 · available 5 · selectable 5 · compatible 5 · unverified 0 · incompatible 0

openai/gpt-5.5          compatible  ctx 272,000  evidence derived
openai/gpt-5.6-luna     compatible  ctx 272,000  evidence derived   [host-default]
openai/gpt-5.6-sol      compatible  ctx 272,000  evidence derived
openai/gpt-5.6-terra    compatible  ctx 272,000  evidence derived
openai/gpt-6-astra      compatible  ctx 272,000  evidence derived
```

Per-model provenance for `openai/gpt-5.6-luna`:

| Capability | Value | Basis | Source |
|---|---|---|---|
| `reasoning` | true | declared | catalog row `reasoning: true` |
| `multimodal` | true | declared | `input: ["text","image"]` |
| `tool_use` | true | **host_default** | row sets no `compat.supportsTools`; OpenClaw's `supportsModelTools` offers tools unless a provider opts out |
| `structured_output` | true | **derived** | OpenClaw's structured output is its synthetic `structured_output` tool, gated on tool capability |

Both reference packages reached *Ready to run*:

| Package | Model | Run plan | Readiness |
|---|---|---|---|
| `org.webagents.literature-review` 0.2.0 | `openai/gpt-5.6-luna` | `rp_e673d5e9…` | ready |
| `org.webagents.meeting-agenda` 0.2.0 | `openai/gpt-6-astra` | `rp_0a4e3eb7…` | ready |

Both refused preparation first, with `model.reasoning` denied:

```text
run_plan_refused — A model-backed run requires permission 'model.reasoning'.
                   Update the permission and authorize again.
```

and both plans were discarded by the following re-authorization.

### Muse did not appear, and why

The `meta` provider plugin is installed, enabled and loaded, and registers
provider id `meta`. `openclaw models auth list --provider meta` returns
`profiles: []` and `openclaw models list --provider meta` returns `count: 0`:
**no credential is configured**, so OpenClaw offers no Meta/Muse model, and the
Agent Browser shows exactly what OpenClaw shows. Nothing about Muse is hardcoded
in either direction — configuring credentials for that provider should make its
models appear with no code change.

### OpenAI models appeared because the host has an OpenAI account

Two OAuth profiles exist for `openai`, the `codex` provider plugin is a
trusted-official install, and the catalog rows carry `reasoning`, `input`,
`contextWindow` and `contextTokens`. That is the whole reason those five models
are `compatible` rather than `unverified`.

## 4. The one honest gap

OpenClaw's Gateway RPC `models.list` reports **seven** usable models on this
host; the plugin-SDK surface this plugin is permitted to use reports **five**.
The two extra rows — `openai/gpt-5.4-pro`, `openai/gpt-5.5-pro` — are
account-discovered entries with **no** reasoning, context or modality metadata,
so they would evaluate to `unverified` if they appeared.

The RPC is not an option: `dispatchTrustedPluginGatewayMethod` throws unless
`canTrustedOfficialPluginRequestScopes` holds, and the Agent Browser is a
workspace plugin (`origin: global`, `trust.reason: provenance-invalid`). Closing
the gap needs either a plugin-SDK surface exposing the same rows or a
trusted-official install. Neither was invented here. Both catalogs are recorded
side by side in
[`model-selection-run-plan.json`](../examples/verification/model-selection-run-plan.json).

## 5. Reproducing this

```sh
# agentpkg
cd agentpkg && .venv/bin/python -m pytest tests -q

# plugin: typecheck, tests, build, validate, pack, isolated install
cd openclaw-agent-browser && npm run verify

# install into the real host and reload
openclaw plugins install "$PWD/agent-browser.tgz" --force --accept-capabilities
openclaw plugins reload agent-browser

# then: Settings -> Labs -> Custom plugin UI, reload the tab, open "Agent Browser"
```

The manual walkthrough is in
[model-selection-and-run-plan.md §13](model-selection-and-run-plan.md#13-the-manual-demo)
and the plugin [README](../openclaw-agent-browser/README.md#manual-demo).

## 6. What should change before execution

1. **The `ModelRouter` adapter is the missing piece.** `workflow.v0` checks
   capabilities against the *router*, not the raw model. An OpenClaw router
   adapter will declare what it can actually deliver for a bound model —
   including how it obtains structured output — and feeding that declaration into
   the same evaluator turns today's `derived` basis into `declared`.
2. **A run plan is preflight, not authority.** The runner must re-open the
   snapshot, re-check digest and archive hash, re-verify signature and trust,
   re-check the receipt, re-confirm the model, and re-run the preflight before
   dispatching anything.
3. **`max_output_tokens` and cost are `null`.** A router adapter that knows them
   should supply them instead of the catalog guessing.
4. **Run output needs a new surface.** An audit stream, usage counters, exports
   and cancellation are a new UI, not a variation of this one.
5. **Persistent authorization** is still absent, which is why *Always* is still
   not offered.

See also: [the control plane](browser-control-plane.md), [the Agent Browser
plugin](openclaw-agent-browser.md), [workflow.v0](../spec/workflow-v0.md).
