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
 * OpenClaw forwards `responseFormat` to the provider transport as a
 * constrained-decoding request. On 2026.9.5 the OpenAI Responses transport maps
 * a `{type: "json_schema", json_schema: {...}}` value onto `text.format`, and
 * the Chat Completions transport passes the same shape through to
 * `response_format`; other transports ignore it. So it is requested whenever
 * the schema can carry it, and the `constrained` flag reports whether it was —
 * never assumed. Conformance itself is guaranteed on the agentpkg side, which
 * parses and schema-validates before returning.
 *
 * ## Usage and caps
 *
 * `maxTokens` is documented as advisory, but the OpenAI transports do apply it
 * (`max_output_tokens`/`max_tokens`), and the runtime rejects an overrun
 * regardless. Usage comes back normalized by OpenClaw
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

/**
 * Map a bare JSON Schema onto OpenClaw's constrained-output request shape.
 *
 * Returns `null` when the schema cannot carry a provider-native constraint, so
 * the caller reports an unconstrained request instead of pretending otherwise.
 */
export function responseFormatFor(
  schema: unknown,
): { format: Record<string, unknown>; detail: string } | null {
  if (!isRecord(schema)) {
    return null;
  }
  if (schema.type !== "object") {
    // Provider JSON-schema response formats require an object root.
    return null;
  }
  const projected: Record<string, unknown> = { ...schema };
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
      "Requested as a json_schema response format; OpenClaw maps it onto the provider's " +
      "constrained-output field where the transport supports one.",
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
