# Model availability: which host view means "this model can be used"

Pinned host: **OpenClaw 2026.9.5 (ec9c1a1)**.

The Agent Browser used to call a discovered-but-unlisted model
`not_offered_by_host` and refuse a run plan for it, while
`openclaw models list --provider ollama --refresh` showed the same model
perfectly happily. Both were reading OpenClaw — through two different views.
This document records which view answers which question, and which one
availability must follow.

## 1. The two views

`buildModelsProviderData(cfg, agentId, { view })`
(`openclaw/plugin-sdk/models-provider-runtime`) takes a `view`, and the two
values are not two levels of detail. They answer different questions.

| | `view: "default"` | `view: "all"` |
|---|---|---|
| question | what should the **picker** list? | what does this host **have**? |
| `byProvider` | configured/default models, plus models whose auth readiness was positively confirmed | every model of a browsable provider that OpenClaw considers route-compatible |
| used by | `/models`, Settings → Models | `openclaw models list --all`, and `--provider <id>` |

In `commands-models`, the default view keeps a row only when it is
`authBacked`, which is `evaluation.availability === true`:

```js
authBacked: options.view === "all" || evaluation.availability === true
…
const defaultVisibleCatalog = wildcard
  ? sort(dedupe([...configuredCatalog, ...params.catalog.filter((e) => getEntryState(e).authBacked)]))
  : [];
```

And the CLI silently switches view as soon as a provider is named:

```js
view: opts.all || provider ? "all" : "default",   // list.list-command
```

which is the whole of the reported discrepancy: `openclaw models list
--provider ollama` was never the picker's view.

## 2. Why a local provider disappears from the picker

A provider whose credential lives in `models.providers.<id>.apiKey` rather than
the auth store has no auth profile, so OpenClaw cannot *confirm* readiness. It
says so plainly:

```text
Model route issues
- ollama/qwen3:30b [indeterminate] Auth readiness could not be confirmed.
```

`indeterminate` is not a refusal, and the picker's filter needs `true`. So none
of that provider's models are auth-backed, and the default view lists only the
ones named in configuration — which is exactly why one model appeared and its
siblings did not.

The decisive evidence that `indeterminate` is not a refusal: that same
`[indeterminate]` model completed four real `api.runtime.llm.complete` calls in
an earlier recorded run.

## 3. What actually gates a plugin's model call

Nothing in `runtime-llm.runtime` consults the picker view. For
`api.runtime.llm.complete({ model })` the host checks, in order:

```js
assertModelAllowed({ kind: "completion", policy: authorityPolicy })   // llm.allowedCompletionModels
assertModelAllowed({ kind: "completion", policy: pluginPolicy })
if (requestedModel) assertAllowedModelOverride({ … })                // llm.allowModelOverride
                                                                     // + llm.allowedModels
```

with allowlists compiled by `compileModelAllowlist`: an absent key permits
everything, a `"*"` entry permits everything, anything else is an exact
`provider/model` set.

So the honest predicate for "the Agent Browser may offer this model" is:

> the host can address it (`view: "all"`), it is not retired, and this plugin's
> own LLM policy permits naming it.

That is what `src/model-policy.ts` mirrors — those rules and nothing else. It
reads this plugin's own configuration entry and no provider credential, base URL
or auth profile.

## 4. What the Agent Browser reports now

| Field | Meaning |
|---|---|
| `available` | the host can route it **and** this plugin is permitted to name it |
| `availability_reason` | `not_routable_by_host`, `model_deprecated`, `model_disabled`, `model_override_not_authorized`, `not_allowlisted_for_override`, `not_allowlisted_for_completion` |
| `selectable` | the host allows manual selection |
| tag `host-picker` | the host's default picker view also lists it — provenance, never a veto |
| tag `host-default` | the host's resolved default model |

The distinctions the previous milestone asked for are all still separate:
*discovered* (a catalog row), *routable* (`byProvider` of the host catalog),
*permitted* (plugin LLM policy), *compatible* (agentpkg's own tri-state
evaluation against the package's declared requirements), and *selectable*.

Availability and compatibility remain independent axes: a model can be
`compatible` but unavailable, or available but `incompatible`.

Two consequences worth stating plainly:

* **without `plugins.entries.agent-browser.llm.allowModelOverride: true` the
  Agent Browser now offers no models at all.** That is correct — every call this
  plugin makes names a model explicitly, so without that opt-in every call would
  be refused, and offering a model would be a promise it cannot keep;
* **auth health is not part of availability**, and never was. The picker view
  did not encode it either: hosted models sat in `byProvider` throughout a
  four-day credential cooldown. A model that is available can still fail at call
  time, which is what the run plan's preflight, the router probe and the run
  record's error codes are for.

## 5. The router probe's output cap

The probe asks for two short strings, but a reasoning model spends its thinking
tokens against the same cap before emitting any of them. Measured locally, one
trivial echo costs 1,000–2,400 thinking tokens; the previous cap of 256 truncated
that to empty text, and the adapter correctly reported
`model_output_not_conforming` for models that work fine. The cap is now 4,096 —
still tiny, and enough to leave room for a reasoning model to think.

## 6. Reasoning effort is not reachable from a plugin completion

`HostBridgeModelRouter` passes `reasoning: "low"` when the bound model declares
reasoning. On this host that parameter does **not** reach Ollama's `think` flag:
requesting `reasoning: "off"` (a canonical OpenClaw thinking level) changed
neither the output nor the latency. Measured directly against the provider,
`think: false` is 24× faster than `think: true` (5.0 s vs 121.6 s for one
perspective-shaped request), so this is a large lever that is simply not exposed
through `api.runtime.llm.complete` in 2026.9.5.

That matters for timeouts rather than for availability, and it is recorded in
[the milestone report](package-execution-report.md#the-live-acceptance-attempt).

See also: [model selection and run plans](model-selection-and-run-plan.md), [the
model-router bridge](model-router-bridge.md), [package
execution](package-execution.md), [threat model](threat-model.md).
