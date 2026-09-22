# Model-router bridge — milestone report

Pinned host: **OpenClaw 2026.9.5 (ec9c1a1)**, macOS 15.6 (arm64), agentpkg
0.2.0, agent.pkg 0.1, workflow.v0.

The architecture and its reasoning are in
[the model-router bridge](model-router-bridge.md). This report records what was
built, what was measured, and what the live run actually did.

## 1. Outcome

A prepared run plan can now reach the exact model a person selected, through a
`ModelRouter` that satisfies the existing runtime contract, and the contract was
proven against a real model and a real bill.

```text
prepared Run Plan  →  preflight  →  HostBridgeModelRouter  →  api.runtime.llm.complete
                                                           →  openai/gpt-5.6-luna
                                          ↓
                            {"status":"ok","echo":"router probe"}   validated
                            225 in / 14 out / $0.000309            accounted
                                          ✕
                            no workflow, no worker, no tool, no Run button
```

## 2. Files

### Created

| File | Purpose |
|---|---|
| `agentpkg/src/agentpkg/hostbridge/__init__.py` | the trusted execution namespace, separate from `browser/` |
| `agentpkg/src/agentpkg/hostbridge/errors.py` | `BridgeError` / `ProtocolError` with stable codes |
| `agentpkg/src/agentpkg/hostbridge/protocol.py` | the JSONL wire contract: version, bounds, allowlists, classification |
| `agentpkg/src/agentpkg/hostbridge/peer.py` | correlation, bounded concurrency, cancellation, fail-closed termination |
| `agentpkg/src/agentpkg/hostbridge/router.py` | `HostBridgeModelRouter`: binding, capabilities, token bound, structured output, usage |
| `agentpkg/src/agentpkg/hostbridge/session.py` | the child session: bind one plan, run one probe, end |
| `agentpkg/src/agentpkg/hostbridge/probe.py` | the host-owned probe request and report |
| `openclaw-agent-browser/src/host-llm.ts` | the only file that invokes a model; exact binding, response format, usage |
| `openclaw-agent-browser/src/router-bridge.ts` | the host side of the protocol and the child's lifetime |
| `openclaw-agent-browser/src/router-probe.ts` | preflight revalidation and the bounded result projection |
| `openclaw-agent-browser/scripts/router-probe.mjs` | the live acceptance driver, through the running Gateway |
| `agentpkg/tests/hostbridge_fakes.py` | a deterministic stand-in for the OpenClaw side |
| `agentpkg/tests/test_hostbridge_protocol.py` (21) | the wire contract |
| `agentpkg/tests/test_hostbridge_router.py` (42) | the `ModelRouter` contract, adversarially |
| `agentpkg/tests/test_hostbridge_session.py` (19) | binding, the probe, and refusals |
| `agentpkg/tests/test_hostbridge_boundary.py` (6) | non-execution, statically and in a real child |
| `openclaw-agent-browser/test/host-llm.test.ts` (12) | what is asked of OpenClaw, and what is refused back |
| `openclaw-agent-browser/test/router-bridge.test.ts` (18) | the host side against a scripted child |
| `openclaw-agent-browser/test/router-probe.test.ts` (12) | the whole stack except the provider |
| `docs/model-router-bridge.md` | the architecture |
| `docs/model-router-bridge-report.md` | this report |

### Changed

| File | Change |
|---|---|
| `agentpkg/src/agentpkg/cli.py` | `agentpkg host-bridge`, and an exit-status path for a command that owns stdout |
| `openclaw-agent-browser/src/contract.ts` | `router.probe`, `RouterProbeView`, ten new error codes |
| `openclaw-agent-browser/src/backend.ts` | `probeRouter`, the `llm` and bridge options |
| `openclaw-agent-browser/src/index.ts` | wires `router.probe` and passes the live `api.runtime.llm` |
| `agentpkg/tests/test_browser_boundary.py` | `hostbridge` added to the control plane's forbidden imports |
| `agentpkg/tests/test_browser_service.py` | a pre-existing flake fixed; see §4 |
| `openclaw-agent-browser/test/contract.test.ts` | the non-execution claim now says *package* execution, plus probe-shape tests |

The Agent Browser page (`src/ui/page.ts`) is **unchanged**.

## 3. The OpenClaw API used

`api.runtime.llm.complete` — `PluginRuntimeCore["llm"]["complete"]`, reached
through the per-plugin `api.runtime` proxy (`loader-runtime-load`, which wraps
every property access in `withPluginRuntimePluginScope({pluginId, …})`; that is
what makes the plugin's own LLM policy apply).

Request fields used: `model`, `systemPrompt`, `messages`, `maxTokens`,
`reasoning`, `responseFormat`, `signal`, `purpose`. Result fields used: `text`,
`provider`, `model`, `responseModel`, `stopReason`, `usage`, `execution`.

Rejected after inspection: `execution: {mode: "isolated-agent-runtime"}` (refuses
`responseFormat`), `openclaw/plugin-sdk/simple-completion-runtime` (bypasses the
plugin LLM policy), and any direct provider SDK.

**Operator opt-in required and applied:**

```json
{"plugins":{"entries":{"agent-browser":{"llm":{"allowModelOverride":true}}}}}
```

Without it OpenClaw refuses a plugin-named model with
`LLM_COMPLETION_NOT_AUTHORIZED`. Revert with
`openclaw config unset plugins.entries.agent-browser.llm`.

## 4. Verification

| Suite | Result |
|---|---|
| `agentpkg` pytest (whole suite) | **497 passed, 1 skipped, 0 failed** of 498 — `examples/verification/router-bridge-agentpkg-tests.{txt,xml}` |
| plugin vitest (whole suite) | **147 passed, 0 failed** across 10 files — `examples/verification/router-bridge-plugin-tests.{txt,json}` |
| `ruff check` + `ruff format --check` | clean |
| `tsc --noEmit` | clean |
| `openclaw plugins validate --json` | `{"valid": true, "pluginId": "agent-browser"}` |
| `openclaw plugins pack` | `sha256 315783e3a2660aa4491332c993bf8694b2bcdf8f715499a8cda076dc5d3aab9e`, 99,920 bytes |
| `scripts/verify.mjs` (build → validate → pack → install into a throwaway config) | `passed: true`, plugin `loaded` and `activated`, `toolNames: []`, `httpRoutes: 0` — `examples/verification/router-bridge-plugin-verify.json` |

Consolidated record: [`examples/verification/router-bridge.json`](../examples/verification/router-bridge.json).

### One pre-existing flake, diagnosed and fixed

`test_browser_service.py::test_request_bodies_are_bounded_and_strict` failed
intermittently in the full suite. It was confirmed pre-existing by removing
every file this milestone adds and reproducing it twice in three runs.

The cause is in the test, not the service. The control plane rejects an
over-limit body from its `Content-Length` **without reading it** — which is the
correct behaviour — so a client still writing 256 KiB can lose the connection
before it reads the 413. The test now accepts either outcome, since both prove
the bound was enforced without the bytes being accepted. Three consecutive full
runs are clean. No service code changed.

### What the tests cover

**Router contract** — exact model binding; no fallback; the declared
`router_id`; context window derivation and refusal when unknown; locality;
capability declaration including the three cases for `reasoning` and the
never-declared `tool_use`/`multimodal`; rendering purity; the bound over ASCII,
accented Latin, CJK, emoji and long inputs; an exact host tokenizer preferred
when one exists; invalid host counts refused; structured output in all three
parse modes; schema mismatch; cap forwarding and validation; usage with cache
tokens; aggregate-total absorption; missing and invalid usage; an honest
overrun.

**IPC** — correlation under concurrency; ten malformed-frame shapes; oversize
frames in both directions; duplicate ids; unknown method; response to an unknown
id; timeout with `$/cancel` and slot release; caller cancellation reaching the
host task; stream close failing every pending call; the pending bound; two
concurrent completions answered out of order keeping their own results; a real
child process; a child whose parent disappears exiting cleanly on EOF; stdout
purity with deliberate stderr noise.

**Authority** — no plan, wrong plan id, wrong plan hash, superseded
authorization, withdrawn publisher trust, model gone from the catalog, a
different model answering, an over-bound input bill, non-conforming output, and
absent usage.

**Non-execution** — an AST scan of every bridge module; a ban on
`__import__`/`importlib`/`eval`/`exec`/`subprocess` in the bridge; the control
plane proven unable to import the bridge; a real child's `sys.modules` after a
full probe; the probe request proven free of package vocabulary; and the live
run's own `stub.calls` proven free of it too.

## 5. The live run

`node openclaw-agent-browser/scripts/router-probe.mjs --package dist/meeting-agenda.agent.pkg --model openai/gpt-5.6-luna`

Full record: [`examples/verification/router-probe-live.json`](../examples/verification/router-probe-live.json).

| | |
|---|---|
| Package | `org.webagents.meeting-agenda` 0.2.0, digest `5aa0ec94…aab80` |
| Archive | `664b39b1…c32cb` |
| Signature / trust | `valid` / `trusted`, signer `sha256:c7549e61…85a70` |
| Authorization | receipt `f068f307-…`, granted `memory.session`, `model.reasoning` |
| Host catalog | 5 models, all available, all compatible, `catalog_sha256 7905c35a…1f4d7` |
| Model chosen | **`openai/gpt-5.6-luna`**, explicitly |
| Run plan | `rp_94bffd9d8f214083897b65504760db10`, sha256 `c27f49bd…33512`, ready |

Probe result:

```json
{
  "status": "ok",
  "router": { "routerId": "openclaw.host-bridge.v0",
              "modelId": "openai/gpt-5.6-luna", "remote": true,
              "contextWindow": 272000,
              "capabilities": ["reasoning", "structured_output"],
              "notDeclared": ["multimodal", "tool_use"] },
  "model":  { "planned": "openai/gpt-5.6-luna",
              "invoked": "openai/gpt-5.6-luna",
              "providerId": "openai", "responseModel": "gpt-5.6-luna",
              "stopReason": "stop", "executionMode": "direct-provider" },
  "probe":  { "status": "ok", "echo": "router probe" },
  "structuredOutput": { "validated": true, "constrainedByHost": true,
                        "parse": "direct" },
  "tokens": { "countTokensBound": 1692, "basis": "utf8_upper_bound",
              "hostTokenizer": false, "framingAllowance": 512 },
  "usage":  { "inputTokens": 225, "outputTokens": 14, "costUsd": 0.000309 },
  "accounting": { "maxOutputTokens": 256,
                  "inputWithinBound": true, "outputWithinCap": true },
  "durationMs": 11082.1,
  "workflowExecuted": false
}
```

All fifteen preflight checks passed and are listed in the artifact. The run plan
after the probe: `runPlanSha256` unchanged, `execution.performed: false`,
`preflight.ready: true`, `executionSupported: false`.

### Two more live checks

**A non-default model, to prove the binding is real.** The host's configured
default is `openai/gpt-5.6-luna`. A second run selected `openai/gpt-5.6-sol`
(run plan `rp_961f39a3…`, sha256 `cede50ff…`) and got
`invoked: "openai/gpt-5.6-sol"`, `responseModel: "gpt-5.6-sol"`, the same 225/14
tokens — and a different bill, **$0.001545** against the first run's
**$0.000309**. Identical token counts at five times the cost is the provider's
own pricing confirming that a different model answered, not the default.

**The operator opt-in is load-bearing.** With
`plugins.entries.agent-browser.llm.allowModelOverride` set to `false`, the same
probe was refused before any provider call:

```
router.probe refused: bridge_failed — model_call_not_authorized:
Plugin LLM completion cannot override the target model. Exact-model binding
requires `plugins.entries.agent-browser.llm.allowModelOverride: true` …
```

The opt-in was restored immediately afterwards.

### What the numbers say

* **The model is the one that was chosen.** `planned == invoked`, and the
  provider's own `responseModel` confirms it.
* **Structured output worked on the first attempt.** `parse: "direct"` means the
  raw text was valid JSON, and `constrainedByHost: true` means the json_schema
  response format was sent. The `const` constraints on both fields were
  satisfied.
* **The token bound held with room to spare.** 225 billed against a 1,692 bound
  — a 7.5× margin, which is the cost of a provable bound rather than a fitted
  one (see the architecture doc §5). No `chars/4` estimate was used anywhere.
* **The bill is real and small.** $0.000309 for one probe.
* **Nothing from the package reached the model.** The request is the host-owned
  probe; the package contributed only its identity to the plan.

## 6. Proof that no package execution occurred

| Claim | Evidence |
|---|---|
| `Workflow` never imported | `test_hostbridge_boundary.py` AST scan, plus a real child's `sys.modules` after a full bind → probe → end |
| no worker started | no `Runtime` is constructed anywhere in `hostbridge`; `worker.*` audit actions require one |
| no `ToolHandler` invoked | `tools` is in the bridge's forbidden import set |
| Citation Resolver / Crossref never contacted | `network` and `tools` are both forbidden; no HTTP client exists in the bridge |
| no package instruction in the model request | `test_the_probe_request_is_host_owned_and_names_no_package`, and `sends no package content to the model` over the whole stack |
| no exports written | the bridge writes no files; the CLI's export path is in `cli.py`, which the bridge cannot import |
| control plane still cannot execute | `test_browser_boundary.py`, now including `hostbridge` |
| the contract has no run operation | `test/contract.test.ts` |
| the page has no Run button | `test/ui.test.ts`, unchanged and still passing |

## 7. Known limitations

1. **Over-reservation.** ~4–8× the real token count. Deliberate; the alternative
   is an estimate that can undercount and corrupt the runtime's accounting.
2. **`constrainedByHost` reports a request, not a guarantee.** Only the OpenAI
   transports honour `responseFormat` on 2026.9.5; Anthropic, Google and Mistral
   ignore it. The capability is declared on the strength of parse-and-validate,
   which is unconditional.
3. **`model.count_tokens` always costs a round trip** on this host, to keep a
   future exact tokenizer a configuration change rather than a code change.
4. **One probe per bridge session**, and no streaming, partial results or tool
   calls.
5. **`max_output_tokens` is advisory at the OpenClaw API level.** The OpenAI
   transports do apply it (`max_output_tokens`, with a floor of 16), and the
   runtime rejects an overrun regardless, but a transport that ignored it would
   show up as an honest overrun rather than as enforcement.
6. **`LlmCompleteUsage` has no reasoning-token field.** Reasoning charges are
   recovered only through the aggregate `totalTokens`; a provider that reports
   neither would under-report, and nothing at this layer could detect it.
7. **The operator opt-in is global to the plugin.** `allowModelOverride` permits
   any model the plugin names, narrowed only by `allowedModels`. There is no
   per-run-plan grant at the OpenClaw layer; the per-run-plan discipline is
   entirely this project's preflight.
8. **One pre-existing test flake** (§4), unrelated and not fixed here.

## 8. Before executing `meeting-agenda.agent.pkg`

1. A separate runner namespace (`agentpkg.execution`) that may import both the
   interpreter and this router; `hostbridge` stays free of the interpreter.
2. The package bytes must reach the runner, ideally by the child re-opening the
   snapshot itself under the digest the plan names.
3. Grants, tool approvals and host budget limits must cross the boundary; today
   only permission ids do.
4. `ToolHandler` wiring for packages that declare tools. `meeting-agenda`
   declares none, which is why it is the right first package.
5. A run surface for audit events, usage, exports and cancellation — only then
   does a Run button have somewhere to put its output.
6. A per-node output cap policy, replacing the bridge's fixed 4,096 ceiling.

See [the architecture](model-router-bridge.md) for the full reasoning on each.
