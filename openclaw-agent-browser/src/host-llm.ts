/**
 * The one place that invokes a model, and the only file that knows how.
 *
 * ## The surface
 *
 * `api.runtime.llm.complete` (`PluginRuntimeCore["llm"]` in OpenClaw 2026.9.5)
 * is the supported way for a plugin to run a host-owned completion without
 * importing provider internals. The alternatives were checked and rejected:
 * `execution: { mode: "isolated-agent-runtime" }` refuses `responseFormat`
 * outright, and the `simple-completion-runtime` SDK subpath bypasses the very
 * plugin LLM policy that makes an exact-model request auditable.
 *
 * ## Exact model binding
 *
 * `params.model` is the run plan's `host_model_id`, always sent explicitly, so
 * the agent's configured default is never what answers. OpenClaw requires an
 * operator opt-in for that — `plugins.entries.agent-browser.llm.allowModelOverride`
 * — and refuses with `LLM_COMPLETION_NOT_AUTHORIZED` otherwise.
 *
 * There is one path where the host would substitute a model silently:
 * `resolveSimpleCompletionSelectionRequest` falls back to the agent's default
 * when it cannot resolve the requested ref. That is why the result's own
 * `provider`/`model` are compared with the binding afterwards and a mismatch
 * becomes `selected_model_unavailable`. Availability is also re-read from the
 * host catalog before dispatch, so the post-check is a backstop rather than the
 * first line of defence.
 *
 * ## Structured output
 *
 * OpenClaw forwards `responseFormat` to the provider transport, and each
 * transport decides what becomes of it. What 2026.9.5 actually does, read from
 * the installed transports and confirmed with `OPENCLAW_DEBUG_MODEL_PAYLOAD`:
 *
 * * the **native Ollama transport** maps a `{type: "json_schema", json_schema}`
 *   value onto Ollama's `format` field (`resolveOllamaResponseFormat`), where
 *   any root type is constrained;
 * * the Chat Completions transport passes it through to `response_format`, and
 *   the managed OpenAI Responses request builder (`buildOpenAIResponsesParams`)
 *   maps it onto `text.format`, with no `strict` flag. The plain
 *   `openai-responses` provider stream in `@openclaw/ai` does not read it at
 *   all; which of the two an OpenAI Platform route takes was not observable on
 *   this host, which has no such route;
 * * on the **native Codex Responses backend** — the ChatGPT sign-in route
 *   (`api: "openai-chatgpt-responses"`, `chatgpt.com/backend-api/codex`), which
 *   is how this host serves `openai/*` models — `sanitizeOpenAICodexResponsesParams`
 *   deletes `text.format` *and* `max_output_tokens` before the request leaves
 *   the host. The model then sees the schema only as prompt text, and no output
 *   cap is sent.
 *
 * A plugin is told none of this, and the route is chosen after auth resolution,
 * where this file cannot see it. So the constraint is requested whenever the
 * schema can carry it, and `constrained` reports that it was *requested* —
 * never that it reached a provider. Conformance is guaranteed on the agentpkg
 * side, which parses and schema-validates every answer, and the output cap by
 * the runtime, which charges and halts on any overrun the host reports.
 *
 * Asking is not a formality. Every node schema arrives bundled with a `$ref`
 * root, which this file used to reject outright, so no package node was ever
 * constrained; measured across four local models, none conformed reliably
 * unaided and all of them conformed once the constraint was carried.
 *
 * ## Usage and caps
 *
 * `maxTokens` is documented as advisory. The OpenAI Platform transports apply it
 * (`max_output_tokens`/`max_tokens`); the native Codex Responses backend drops
 * it (above). The runtime rejects an overrun the host reports either way, so a
 * route that cannot cap output fails closed rather than overspending silently. Usage comes back normalized by OpenClaw
 * (`input`/`output`/`cacheRead`/`cacheWrite`/`total`/`costUsd`); it is passed on
 * unchanged for the router to interpret, because deciding what counts as a
 * billable input token is the router's contract, not this file's.
 */
import { AgentBrowserError } from "./errors.js";

export type LlmUsage = {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  totalTokens?: number;
  costUsd?: number;
};

export type LlmCompleteResult = {
  text: string;
  provider: string;
  model: string;
  responseModel?: string;
  stopReason?: string;
  agentId?: string;
  usage: LlmUsage;
  execution?: { mode: string; owner?: { kind: string; id: string } };
};

/** Exactly the slice of `api.runtime.llm` this plugin uses. */
export type HostLlm = {
  complete: (params: {
    model?: string;
    maxTokens?: number;
    temperature?: number;
    reasoning?: string;
    systemPrompt?: string;
    signal?: AbortSignal;
    purpose?: string;
    messages: Array<{ role: "system" | "user" | "assistant"; content: string }>;
    responseFormat?: Record<string, unknown>;
  }) => Promise<LlmCompleteResult>;
};

export type CompletionRequest = {
  /** The run plan's host model id, `provider/model`. Never optional. */
  modelId: string;
  system: string;
  user: string;
  outputSchema: unknown;
  maxOutputTokens: number;
  reasoning?: string;
  signal?: AbortSignal;
};

export type CompletionOutcome = {
  text: string;
  modelId: string;
  providerId: string;
  responseModel: string | null;
  stopReason: string | null;
  execution: { mode: string; owner: string | null } | null;
  constrained: boolean;
  constraintDetail: string;
  usage: {
    input_tokens: number | null;
    output_tokens: number | null;
    cache_read_tokens: number | null;
    cache_write_tokens: number | null;
    total_tokens: number | null;
    cost_usd: number | null;
  };
};

/** Above this, the schema is not worth sending twice; the prompt copy remains. */
export const MAX_RESPONSE_FORMAT_BYTES = 64 * 1024;
export const RESPONSE_FORMAT_NAME = "agentpkg_node_output";

/** Root-level annotations a provider's response-format parser has no use for. */
const STRIPPED_ROOT_KEYS = ["$schema", "$id", "$anchor", "title", "description"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A local `#/$defs/<name>` pointer, which is the only reference shape agentpkg emits. */
const LOCAL_DEFS_REF = /^#\/\$defs\/([^/]+)$/;

/**
 * Rewrite a `$ref`-rooted document so its root carries the referenced schema.
 *
 * `agentpkg.workflow.Workflow._model_schema` bundles every package-relative
 * reference into one closed document and leaves the root as
 * `{"$ref": "#/$defs/sN", "$defs": {...}}`. That is a correct JSON Schema, but
 * a root `$ref` is not something a provider's response-format parser accepts,
 * and — more importantly — a root with no `type` is indistinguishable from an
 * unusable schema. Inlining the root keeps the `$defs` namespace intact, so
 * every inner `$ref` still resolves, while the root states what it describes.
 *
 * Anything other than a single local root reference is returned unchanged.
 */
export function inlineRootRef(schema: Record<string, unknown>): Record<string, unknown> {
  const ref = schema.$ref;
  if (typeof ref !== "string") return schema;
  const name = LOCAL_DEFS_REF.exec(ref)?.[1];
  const defs = schema.$defs;
  if (!name || !isRecord(defs)) return schema;
  const target = defs[name];
  if (!isRecord(target)) return schema;
  // A root that is itself only another reference is left alone rather than
  // followed: one hop is what the bundler produces, and chasing further would
  // be guessing at a shape this project does not emit.
  if (typeof target.$ref === "string") return schema;
  const { $ref: _dropped, ...rest } = schema;
  return { ...target, ...rest };
}

/**
 * Map a bare JSON Schema onto OpenClaw's constrained-output request shape.
 *
 * Returns `null` when the schema cannot carry a provider-native constraint, so
 * the caller reports an unconstrained request instead of pretending otherwise.
 *
 * ## Why an array root is carried too
 *
 * Every node output schema in a package reaches this function bundled, so the
 * root is inlined first. What comes out is an object root for most nodes and an
 * **array** root for a node whose declared output is a list — which a package is
 * entitled to declare, and which `agentpkg` will hold the model to either way.
 *
 * OpenClaw 2026.9.5's native Ollama transport takes `json_schema.schema`
 * verbatim as Ollama's `format`, and Ollama constrains decoding against any
 * root type (`resolveOllamaResponseFormat`, `stream.runtime`). A provider whose
 * response format requires an object root will instead refuse the request. That
 * refusal is the better outcome: an unconstrained call against a schema the
 * model cannot be held to does not degrade gracefully, it returns output that
 * fails validation after the tokens are already spent. Measured on this host,
 * every local model conformed on every node with the constraint applied and
 * none of them conformed reliably without it.
 */
export function responseFormatFor(
  schema: unknown,
): { format: Record<string, unknown>; detail: string } | null {
  if (!isRecord(schema)) {
    return null;
  }
  const rooted = inlineRootRef(schema);
  if (rooted.type !== "object" && rooted.type !== "array") {
    // Without a stated root type there is nothing a provider can constrain.
    return null;
  }
  const projected: Record<string, unknown> = { ...rooted };
  for (const key of STRIPPED_ROOT_KEYS) delete projected[key];
  const serialized = JSON.stringify(projected);
  if (Buffer.byteLength(serialized) > MAX_RESPONSE_FORMAT_BYTES) {
    return null;
  }
  return {
    format: {
      type: "json_schema",
      json_schema: { name: RESPONSE_FORMAT_NAME, schema: projected },
    },
    detail:
      "Requested as a json_schema response format. The host route decides whether it reaches " +
      "the provider and does not report it; some routes drop it. Conformance is enforced by " +
      "parse-and-validate, not assumed.",
  };
}

function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

/** Translate OpenClaw's completion failure codes into stable browser codes. */
export function asCompletionError(error: unknown): AgentBrowserError {
  const code = (error as { code?: unknown })?.code;
  const message = (error as Error)?.message ?? "The host model call failed.";
  if (code === "LLM_COMPLETION_NOT_AUTHORIZED") {
    return new AgentBrowserError(
      "model_call_not_authorized",
      "This host does not authorize the selected model",
      `${message} Exact-model binding requires ` +
        "`plugins.entries.agent-browser.llm.allowModelOverride: true` in the OpenClaw config, " +
        "and the selected model must be inside any configured allowedModels list.",
    );
  }
  if (code === "LLM_COMPLETION_ABORTED") {
    return new AgentBrowserError("model_call_cancelled", "The model call was cancelled", message);
  }
  if (code === "LLM_COMPLETION_TIMEOUT") {
    return new AgentBrowserError(
      "model_call_failed",
      "The model call timed out",
      message,
      true,
    );
  }
  if (code === "LLM_RUNTIME_UNAVAILABLE" || code === "LLM_ISOLATED_UNSUPPORTED") {
    return new AgentBrowserError(
      "model_call_failed",
      "The host model runtime is unavailable",
      message,
      true,
    );
  }
  return new AgentBrowserError("model_call_failed", "The model call failed", message, true);
}

/**
 * Run one completion against exactly the bound model, or fail closed.
 *
 * `purpose` is a fixed string: it reaches OpenClaw's own audit log, so it says
 * what this is rather than anything about the package.
 */
export async function completeWithBoundModel(
  llm: HostLlm,
  request: CompletionRequest,
): Promise<CompletionOutcome> {
  const constrained = responseFormatFor(request.outputSchema);
  let result: LlmCompleteResult;
  try {
    result = await llm.complete({
      model: request.modelId,
      systemPrompt: request.system,
      messages: [{ role: "user", content: request.user }],
      maxTokens: request.maxOutputTokens,
      ...(request.reasoning ? { reasoning: request.reasoning } : {}),
      ...(constrained ? { responseFormat: constrained.format } : {}),
      ...(request.signal ? { signal: request.signal } : {}),
      purpose: "agent-browser.router",
    });
  } catch (error) {
    throw asCompletionError(error);
  }

  const invoked = `${result.provider ?? ""}/${result.model ?? ""}`;
  if (invoked !== request.modelId) {
    throw new AgentBrowserError(
      "selected_model_unavailable",
      "A different model answered",
      `The run plan bound ${request.modelId}, but this host completed with ${invoked}. ` +
        "Nothing is returned from a model the person did not choose.",
    );
  }
  const usage = result.usage ?? {};
  return {
    text: typeof result.text === "string" ? result.text : "",
    modelId: invoked,
    providerId: result.provider,
    responseModel: typeof result.responseModel === "string" ? result.responseModel : null,
    stopReason: typeof result.stopReason === "string" ? result.stopReason : null,
    execution: result.execution
      ? { mode: result.execution.mode, owner: result.execution.owner?.id ?? null }
      : null,
    constrained: constrained !== null,
    constraintDetail: constrained
      ? constrained.detail
      : "This output schema cannot carry a provider-native constraint; the adapter parses and " +
        "validates the response instead.",
    usage: {
      input_tokens: finite(usage.inputTokens),
      output_tokens: finite(usage.outputTokens),
      cache_read_tokens: finite(usage.cacheReadTokens),
      cache_write_tokens: finite(usage.cacheWriteTokens),
      total_tokens: finite(usage.totalTokens),
      cost_usd: finite(usage.costUsd),
    },
  };
}
