# The model-router bridge

The [previous milestone](model-selection-and-run-plan.md) ended with a person
having chosen a model and a hashed run plan recording that choice — and nothing
able to use it. This one builds the thing that can, and then deliberately uses
it exactly once.

```text
 prepared run plan
        │
        ▼  re-verify every fact the plan asserts, against the live world
 preflight
        │
        ▼  bind the exact selected model to a ModelRouter
 agentpkg.hostbridge
        │
        ▼  one host-owned, schema-constrained completion
 OpenClaw api.runtime.llm.complete
        │
        ▼  parsed, schema-validated, usage accounted
 router probe result
        │
        ✕  STOP. No workflow node ran. There is still no Run button.
```

Five stages are kept apart throughout, and the vocabulary below keeps them apart
on purpose:

| Stage | Question it answers | Owner |
|---|---|---|
| **Model discovery** | which models does this host have? | OpenClaw |
| **Model selection** | which one did the person choose? | the person |
| **ModelRouter capability** | what can the adapter actually deliver with it? | the bridge |
| **Router probe** | does the adapter really deliver that? | this milestone |
| **Agent execution** | does the package's workflow run? | not yet |

## 1. Why a separate namespace

`agentpkg.browser` opens, inspects and authorizes packages, and a structural
test proves it cannot import an execution module. That property is the reason a
person can open an unknown package without risk, so it is not relaxed here.

The bridge lives in `agentpkg.hostbridge`, a **separate trusted namespace** that
may spend model tokens. The boundary runs both ways and is tested in both
directions:

* `agentpkg/browser/**` must not import `hostbridge`
  (`test_browser_boundary.py`);
* `agentpkg/hostbridge/**` must not import `workflow`, `runtime`, `tools`,
  `models`, `fixtures`, `network`, `openclaw`, `dev`, `cli` or `browser`
  (`test_hostbridge_boundary.py`).

The control plane still decides *whether* a run may happen. It remains unable to
be the thing that makes one happen.

## 2. The OpenClaw surface, verified against the installed host

Pinned host: **OpenClaw 2026.9.5 (ec9c1a1)**.

### What is used

`api.runtime.llm.complete` — `PluginRuntimeCore["llm"]["complete"]`, reached
through the per-plugin `api.runtime` proxy. Documented in the installed
`docs/plugins/sdk-runtime/models.md` as the way to "run a host-owned text
completion without importing provider internals".

```ts
await api.runtime.llm.complete({
  model: "openai/gpt-5.6-luna",        // the run plan's host_model_id
  systemPrompt,                         // rendered by agentpkg
  messages: [{ role: "user", content }],
  maxTokens: 256,                       // the router's max_output_tokens
  reasoning: "low",
  responseFormat: { type: "json_schema", json_schema: { name, schema } },
  signal,                               // real cancellation
  purpose: "agent-browser.router",
});
```

The result is `{ text, provider, model, responseModel?, stopReason?, agentId,
usage, execution, audit }`, with `usage` normalized by OpenClaw into
`inputTokens`, `outputTokens`, `cacheReadTokens`, `cacheWriteTokens`,
`totalTokens` and `costUsd`.

### What was rejected, and why

| Considered | Rejected because |
|---|---|
| `execution: { mode: "isolated-agent-runtime" }` | `assertSupportedExecutionMode` refuses `responseFormat` in that mode, so structured output would be prompt-only |
| `openclaw/plugin-sdk/simple-completion-runtime` | bypasses the plugin LLM policy (`allowModelOverride`, `allowedModels`) that makes an exact-model call auditable |
| calling a provider SDK directly | would put provider credentials in this project and duplicate OpenClaw's auth, routing and usage accounting |

### The operator opt-in this requires

OpenClaw refuses a plugin that names its own model unless an operator allows it:

```json
{ "plugins": { "entries": { "agent-browser": {
  "llm": { "allowModelOverride": true }
} } } }
```

Without it, `assertAllowedModelOverride` throws `LLM_COMPLETION_NOT_AUTHORIZED`,
which this plugin surfaces as `model_call_not_authorized` with that config path
in the message. Operators can narrow it further with `llm.allowedModels` (which
overrides may target) or `llm.allowedCompletionModels` (every completion). The
plugin never asks for `allowAgentIdOverride` or `allowAuthProfileOverride`.

This is the correct shape: **exact-model binding is a privilege the host grants,
not something a plugin asserts.**

## 3. Exact model binding, and the one fallback path that exists

The adapter always sends `model` explicitly. It is never omitted, so the agent's
configured default is never what answers.

One silent-substitution path exists inside the host and is worth naming, because
it is the reason there is a post-check.
`resolveSimpleCompletionSelectionRequest` computes

```js
const provider = resolved?.ref.provider ?? fallbackRef.provider;
const modelId  = resolved?.ref.model    ?? fallbackRef.model;
```

so a model ref the host cannot resolve falls back to the agent default rather
than failing. Three independent checks close that:

1. **before dispatch**, the backend re-reads the host catalog and refuses with
   `selected_model_unavailable` unless the plan's model is still offered and
   selectable — the same `stillAvailable` check run-plan preparation uses;
2. **at the boundary**, `completeWithBoundModel` compares
   `` `${result.provider}/${result.model}` `` with the binding and throws
   `selected_model_unavailable` on any difference;
3. **in the router**, `HostBridgeModelRouter.complete` compares the model id the
   bridge reports with `RunPlan.model_binding.host_model_id` and refuses the
   result rather than returning output from a model the person did not choose.

There is no fallback, no downgrade and no "closest available" behaviour anywhere
in this path.

## 4. The IPC protocol

`agentpkg-host-bridge/0.1`: one JSON object per line, in both directions, over
the stdio of a child the plugin backend spawns.

```text
  OpenClaw plugin backend (parent)          agentpkg host bridge (child)
  ────────────────────────────────          ────────────────────────────
  session.begin / probe.run / session.end  ──▶  stdin
  model.count_tokens / model.complete       ◀──  stdout
  logs, diagnostics, tracebacks             ◀──  stderr
```

A pipe to a child this process spawned has no address, no listener and no
credential, which is why it is the transport rather than a second loopback HTTP
port. The control plane's own loopback API exists because a *supervised
long-lived service* needs one; a per-run child does not.

| Rule | How |
|---|---|
| not network-exposed | anonymous pipes to a spawned child; no socket, no port, no token |
| bounded frames | 1 MiB per line, both directions, checked on encode and decode |
| bounded concurrency | 16 outstanding requests per direction, per peer |
| correlation ids | `[A-Za-z0-9_.:-]{1,64}`, unique per direction; a reused id is fatal |
| strict method allowlist | two disjoint sets; a method outside its direction is refused, never dispatched |
| no arbitrary dispatch | no name resolution, no file path, no OpenClaw method name, no `eval`/`import`/`subprocess` anywhere in the bridge package |
| no package-controlled methods | the method set is fixed in code; a package cannot add, name or reach one |
| cancellation | `$/cancel` notification in either direction; the peer cancels the serving task, and the host aborts the provider call |
| fail closed | any malformed frame, unknown id, duplicate id, wrong version or non-frame byte ends the session and kills the child |
| clean EOF | EOF between frames is a normal end; EOF mid-frame is a violation |
| stdout is protocol only | the child logs to stderr; a stray stdout byte is a protocol violation, and a test writes one deliberately to prove it |

### The method set

**Child → host** (this is the `ModelRouter`):

| Method | Params | Answer |
|---|---|---|
| `model.count_tokens` | `system`, `user`, `output_schema` | `{supported: false, detail}` on this host |
| `model.complete` | `system`, `user`, `output_schema`, `max_output_tokens`, `reasoning?` | `{text, model_id, provider_id, response_model, stop_reason, execution, constrained, usage}` |

**Host → child:**

| Method | Params | Answer |
|---|---|---|
| `session.begin` | `run_plan` (bounded binding facts), `limits` | the bound router's description |
| `probe.run` | *(none)* | the probe report |
| `session.end` | *(none)* | `{ended, probes}` |

Note what is **not** in `model.complete`: a model id. The binding lives in the
parent, so the child cannot name a model even if it wanted to. Notice also that
`probe.run` takes no parameters — no prompt, no schema, no budget — so the probe
cannot be turned into a hidden general-purpose model API.

### What crosses into the child

Only bounded run-plan *identity*: the plan id and hash, package identity and
digests, the execution mode and required permission ids, and the model
descriptor's id/capabilities/limits/locality. Base URLs, credentials, bearer
tokens, the catalog, the receipt body and package payload never travel. The
child validates the payload against a closed field set and refuses unknown
fields, so a future parent cannot smuggle an endpoint through it.

## 5. The ModelRouter implementation

`agentpkg.hostbridge.router.HostBridgeModelRouter` satisfies
`agentpkg.interfaces.ModelRouter`:

```python
router_id      = "openclaw.host-bridge.v0"
model_id       = RunPlan.model_binding.host_model_id     # e.g. openai/gpt-5.6-luna
remote         = descriptor.properties.local is not True # unknown ⇒ remote
capabilities   = {"structured_output"} | ({"reasoning"} if host declared it)
context_window = descriptor.limits.context_tokens or native_context_window
```

### Capabilities describe the adapter, not the catalog

This is the step that turns the previous milestone's `derived` compatibility
evidence into a concrete router capability, and it is done by *implementing*
the capability rather than by relabelling it.

| Capability | Declared? | Why |
|---|---|---|
| `structured_output` | **yes** | the adapter requests a constrained response *and* parses and schema-validates before returning, so a non-conforming answer is a failure rather than a result. That guarantee is the adapter's, not the model's |
| `reasoning` | only when the bound model's own host descriptor says `reasoning: true` | the adapter cannot manufacture reasoning; it passes a reasoning effort through and reports what the host declared |
| `tool_use` | **never** | the adapter exposes no tools to the model. OpenClaw supporting tools is not the same claim as this router supporting the agentpkg tool execution contract, and package tools are not wired |
| `multimodal` | **never** | the adapter sends text only |

A model with an unknown context window refuses to build a router at all
(`model_context_window_unknown`) rather than guessing one, and an unknown
locality counts as remote so a `local-only` package cannot be satisfied by
silence.

### Structured output

Two layers, both always applied:

1. **request-side.** The schema is sent as OpenClaw's canonical json_schema
   response format. On 2026.9.5 the OpenAI Responses transport maps it onto
   `text.format` and Chat Completions passes it through to `response_format`;
   Anthropic, Google and Mistral transports ignore `responseFormat` entirely.
   The result records `constrained_by_host` honestly rather than assuming it.
   A schema without an object root, or above 64 KiB, cannot carry a
   provider-native constraint and is reported as unconstrained.
2. **response-side, unconditional.** A strict `json.loads`; then, in one bounded
   attempt, a fenced-block or first-balanced-value extraction; then
   `Draft202012Validator` against the exact `output_schema`. A failure is
   `model_output_not_conforming`.

There is deliberately **no repair loop**. A second call to fix the first would
spend tokens the runtime already reserved against one completion, and would make
`max_output_tokens` meaningless.

`Runtime.call_model` validates the output against the schema again. That
duplication is intentional: the router's guarantee should hold even for a caller
that is not the runtime.

### Token counting: why the bound is what it is

`Runtime.call_model` reserves `count_tokens(request) + max_output_tokens` and
treats `actual_input > bound` as a **fatal router contract violation** that halts
execution. So `count_tokens` must be a genuine upper bound, not an estimate.

**The host has no tokenizer.** OpenClaw 2026.9.5 publishes none to a plugin. Its
own internal estimate is `chars / 4` (`estimateTokensFromChars`), explicitly
documented as "a provider-independent budget heuristic, not an exact tokenizer",
and its compaction planner multiplies it by a 1.2 "buffer for estimateTokens()
inaccuracy". Returning that would silently weaken the runtime's invariant, so
the bridge answers `model.count_tokens` with `supported: false` and says why.

**The bound used instead is provable:**

> Every production subword tokenizer — byte-level BPE and SentencePiece alike —
> has a vocabulary whose every entry decodes to at least one byte. N tokens
> therefore decode to at least N bytes, so a text of B UTF-8 bytes cannot
> tokenize to more than B tokens.

```
bound = utf8(system) + utf8(user) + utf8(output_schema) + FRAMING_TOKEN_ALLOWANCE
```

* `system` and `user` are the exact strings the adapter will send. Rendering is a
  pure function of the request, so `count_tokens` and `complete` render
  identically by construction and **no prompt content escapes the count**.
* `output_schema` is counted **twice**: once inside the system text where it is
  embedded, and once for the provider's own copy of it in the constrained-output
  request. The provider-shaped wrapper is a strict subset of what is counted.
* `FRAMING_TOKEN_ALLOWANCE = 512` covers everything the provider adds around two
  messages — role markers, turn delimiters, BOS/EOS, and the response-format
  envelope. Real chat templates spend single-digit tokens per message; this is
  orders of magnitude above that, on purpose.

The cost of this honesty is over-reservation: on the live probe the bound was
1,692 and the host billed 225, a factor of 7.5. That is the documented trade —
**over-reserving rejects a request; under-reserving corrupts the accounting.**
If a later OpenClaw exposes a real tokenizer, `model.count_tokens` already has
the answer shape for it (`{supported: true, input_tokens}`), and the router
prefers it with no other change.

### Actual usage

```
input_tokens  = inputTokens + cacheReadTokens + cacheWriteTokens
output_tokens = max(outputTokens, totalTokens - input_tokens)
cost_usd      = costUsd, when the host reports one
```

* **cache tokens are billable input.** OpenClaw's `normalizeUsage` subtracts
  cache reads and writes out of `input`; the router adds them back, because the
  runtime's reservation covers what a call costs rather than what a provider
  discounts.
* **the aggregate total wins.** When the host's `totalTokens` exceeds its own
  breakdown, the difference is charged to output. That is where an unreported
  reasoning charge would otherwise disappear. `LlmCompleteUsage` has no
  `reasoningTokens` field, so this is the only way to keep the count honest.
* **no usage means failure.** A host that reports nothing raises
  `model_usage_unavailable` rather than estimating; `Runtime.call_model` then
  charges the full reservation, which is the conservative outcome.
* **an overrun is reported, not hidden.** If the provider bills more output than
  the cap, the router returns the real number and the runtime halts.

### Cancellation and deadlines

| Trigger | Effect |
|---|---|
| the Python caller cancels `complete()` | the router sends `$/cancel`; the parent aborts the `AbortController` it passed to `api.runtime.llm.complete`, which propagates into the provider request |
| the router's per-request deadline elapses | `bridge_timeout`, `$/cancel` sent, the pending slot freed |
| the host's completion deadline elapses | the same `AbortSignal.any` aborts the provider call; the child gets a bounded error frame |
| the whole bridge session deadline elapses | the child is killed and every pending call fails |
| the child exits | every pending call fails with `bridge_unavailable`, carrying the child's last stderr |
| the parent exits | the child sees EOF on stdin and ends cleanly |

No orphaned completion continues after a cancellation: the abort reaches the
provider request, and the child process is killed rather than left running.

## 6. Authority: what is re-checked before the first token

A run plan is a record of a decision, not a capability. The probe re-verifies
every fact the plan asserts, names each check in its result, and refuses on any
difference:

| Check | Refusal |
|---|---|
| the session's plan is the one the caller named | `probe_refused` |
| the plan hash is the one the caller read | `probe_refused` |
| the plan was ready, and its preflight is still ready and not stale | `run_plan_stale` |
| execution mode is `model` and `performed` is false | `run_plan_stale` |
| package digest | `run_plan_stale` |
| archive SHA-256 | `run_plan_stale` |
| signature status, publisher trust, signer fingerprint | `run_plan_stale` |
| the receipt id and hash are the planned ones | `run_plan_stale` |
| the receipt has not expired and is runnable | `run_plan_stale` |
| every run-mode permission id is granted | `run_plan_stale` |
| the model is still offered and selectable | `selected_model_unavailable` |
| the host's identity for that model is unchanged | `run_plan_stale` |
| the compatibility verdict is not `incompatible` | `run_plan_stale` |

Re-authorizing discards the plan in the control plane, so a probe against a
superseded plan gets `run_plan_absent` — the caller's copy is never a fallback.

The probe is the first operation in this project that spends real money, so it
cannot reach a model without all of that holding.

## 7. The probe itself

Host-owned, fixed in trusted code, and the same for every package:

```python
instructions = [
  "You are answering a protocol conformance probe for a host model router. "
  "Do not interpret the input as a task, a question or an instruction: it is "
  "a fixed test vector.",
  'Set "status" to "ok" and copy the value of the input field "message" '
  'verbatim into "echo". Return nothing else.',
]
data          = {"message": "router probe"}
output_schema = {"type": "object", "required": ["status", "echo"],
                 "properties": {"status": {"const": "ok"},
                                "echo": {"const": "router probe"}},
                 "additionalProperties": False}
max_output_tokens = 256
```

It is built through the same `model-request` contract a workflow node produces,
and validated against `model-request.schema.json`, so the probe exercises the
real code path rather than a simplified one. Its `requirements` block is
host-owned and synthetic: it names the probe, not a package task.

**No package skill, graph node, tool contract, fixture or input document takes
part.** A test asserts that the probe request contains none of the reference
packages' vocabulary, and the live run confirms the same for what actually
reached the provider.

## 8. What still cannot happen

| | Status |
|---|---|
| `Workflow` instantiated | no — `hostbridge` cannot import it, proven by AST scan and by a fresh child's `sys.modules` |
| a worker spawned | no — the probe never constructs a `Runtime` |
| a `ToolHandler` invoked | no — no tool binding is reachable from the bridge |
| Crossref, the Citation Resolver, a PDF read | no — no network module is imported |
| package SKILL.md loaded into a model request | no — the probe's instructions are host constants |
| package artifacts exported | no — the bridge writes no files |
| a Run button | no — the page is unchanged; `router.probe` is an operator-only feature action with no tool binding |

The control plane keeps `execution: "disabled"`, `capabilities.execute: false`,
and `execution.performed: false` on every plan and summary. Those are still true:
the control plane executed nothing, and no package executed at all.

## 9. Feature contract additions

| Operation | Kind | Scope | Purpose |
|---|---|---|---|
| `router.probe` | action | `operator.write` | Re-verify a ready run plan and make one host-owned model call to prove the router contract |

Its input is `{sessionId, runPlanId, runPlanSha256}` and nothing else — no
prompt, no schema, no model id, no budget. It has no tool binding, so the
model-facing tool surface is unchanged, and it is not rendered by the page.

New error codes: `run_plan_stale`, `probe_refused`, `selected_model_unavailable`,
`model_call_not_authorized`, `model_call_failed`, `model_call_cancelled`,
`bridge_unavailable`, `bridge_protocol_error`, `bridge_timeout`, `bridge_failed`.

## 10. Running it

```bash
node openclaw-agent-browser/scripts/router-probe.mjs \
  --package /path/to/meeting-agenda.agent.pkg \
  --model openai/gpt-5.6-luna \
  --out report.json
```

The script walks the page's own sequence through the live Gateway
(`plugins.sessionAction`) — open, trust, authorize, evaluate models, choose,
prepare — and then invokes the probe. It spends a few hundred real tokens, once.
Omitting `--model` picks the first compatible model the host offers and names it
in the report.

## 11. Known limitations

**Over-reservation.** The provable bound is roughly 4× the real token count for
English text, so a request close to the context window may be refused that a
real tokenizer would admit. Accepted deliberately; see §5.

**`constrained_by_host` is a request, not a proof.** It reports that a
constrained-output format was sent, not that the provider honoured it. The
guarantee comes from parse-and-validate, which is why the capability is declared
on that basis.

**`model.count_tokens` costs a round trip.** It asks the host every time, even
though 2026.9.5 always answers "unsupported". That keeps the protocol honest
about who owns tokenization and makes a future exact tokenizer a config change
rather than a code change.

**One probe per bridge session.** A second `probe.run` is refused. Probing again
means preparing a session again, which is the same discipline a run will have.

**No streaming, no partial results, no tool calls.** `complete` is one request
and one answer. Streaming would change the accounting contract and is not needed
before workflow execution.

**Muse and other providers are untouched.** The bridge is provider-neutral: it
names no vendor, and the same code should work for any model OpenClaw's LLM
runtime can route to. Whether a given provider honours `responseFormat` is
reported, not assumed.

## 12. Before the next milestone (executing `meeting-agenda.agent.pkg`)

1. **A runner namespace.** `agentpkg.hostbridge` must stay free of the
   interpreter. Workflow execution belongs in a sibling — `agentpkg.execution` —
   that imports `workflow`, `runtime` and `hostbridge.router`, and the boundary
   tests should then assert *that* module's shape.
2. **The bridge session must carry a workflow, not a probe.** `session.begin`
   already binds the router; a `workflow.run` method would need the package
   bytes, which today do not cross the boundary. Either the child re-opens the
   snapshot itself under the same digest the plan names, or the parent streams
   it — the first is preferable, because the child can then verify what it runs.
3. **Grants, budgets and tool approvals must travel.** The runtime needs the
   receipt's decisions and the host limits; today only the permission *ids*
   cross.
4. **Tool handlers are unbuilt.** `meeting-agenda` declares no tools, which is
   why it is the right first package — but `literature-review` will need
   `ToolHandler` implementations reachable from the runner, and the bridge's
   method set will have to grow a tool direction with the same discipline.
5. **A run surface.** Audit events, usage counters, exports and a cancel control
   are a new UI, not a variation of the current page. Until it exists, a Run
   button would be a button with nowhere to put its output.
6. **Output cap policy per node.** The probe uses a fixed 256. A workflow node's
   `max_output_tokens` comes from the graph, and the bridge's
   `limits.maxOutputTokens` ceiling (4,096 by default) will need to be an
   operator setting rather than a constant.

See also: [the milestone report and live results](model-router-bridge-report.md),
[model selection and run plans](model-selection-and-run-plan.md), [the control
plane](browser-control-plane.md), [the Agent Browser
plugin](openclaw-agent-browser.md), [the execution
profile](../spec/workflow-v0.md), [threat model](threat-model.md).
