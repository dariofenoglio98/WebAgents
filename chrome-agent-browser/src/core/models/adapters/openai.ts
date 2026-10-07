/**
 * OpenAI through the Responses API with the person's own key (D-023, D-062).
 *
 * `instructions` carries the rendered system text and `input` the user text;
 * `text.format` is the json_schema constraint (non-strict, so any package schema is accepted
 * and the model is guided rather than guaranteed; the router validates every answer anyway);
 * `max_output_tokens` is the node's cap; `store: false`. Usage: `input_tokens` (cached tokens
 * are already inside it, so they are not added again) and `output_tokens` (reasoning tokens
 * included). A `completed` response is a finished turn; `incomplete` with
 * `max_output_tokens` is truncated, any other unfinished status or a `refusal` block is a
 * turn the provider did not complete.
 */
import type { JsonValue } from "../../json.js";
import { AdapterError } from "../../workflow/errors.js";
import type { RenderedRequest } from "../render.js";
import type { ProviderAdapter, ProviderCompletion } from "../router.js";
import { constraintSchema, OPENAI_RULES, RESPONSE_FORMAT_NAME } from "../schema-format.js";
import type { ModelPricing } from "../usage.js";
import { checkCredential, isRecord, postJson, providerBaseUrl, providerError, type ProviderHttpOptions } from "./shared.js";

export const DEFAULT_OPENAI_URL = "https://api.openai.com";

export interface OpenAIAdapterOptions extends ProviderHttpOptions {
  model: string;
  apiKey: string | null | undefined;
  baseUrl?: string;
  contextWindow: number;
  reasoning?: boolean;
  /** `reasoning.effort` sent when the model reasons; `low` keeps the output cap meaningful. */
  reasoningEffort?: "low" | "medium" | "high";
  pricing?: ModelPricing | null;
}

export class OpenAIAdapter implements ProviderAdapter {
  readonly provider_id = "openai";
  readonly model_id: string;
  readonly host_model_id: string;
  readonly remote = true;
  readonly reasoning: boolean;
  readonly context_window: number;
  readonly domains: readonly string[];
  readonly pricing: ModelPricing | null;
  readonly baseUrl: string;
  private readonly key: string;

  constructor(private readonly options: OpenAIAdapterOptions) {
    this.model_id = options.model;
    this.host_model_id = `openai/${options.model}`;
    this.baseUrl = providerBaseUrl(options.baseUrl ?? DEFAULT_OPENAI_URL, { allowLoopbackHttp: false });
    this.key = checkCredential(options.apiKey, "OpenAI API key");
    this.reasoning = options.reasoning ?? false;
    this.context_window = options.contextWindow;
    this.domains = [new URL(this.baseUrl).hostname];
    this.pricing = options.pricing ?? null;
  }

  async complete(rendered: RenderedRequest, maxOutputTokens: number, signal: AbortSignal): Promise<ProviderCompletion> {
    const schema = constraintSchema(rendered.output_schema, OPENAI_RULES);
    const body: Record<string, JsonValue> = {
      model: this.model_id,
      instructions: rendered.system,
      input: rendered.user,
      max_output_tokens: maxOutputTokens,
      store: false,
    };
    if (schema !== null) body.text = { format: { type: "json_schema", name: RESPONSE_FORMAT_NAME, schema, strict: false } };
    if (this.reasoning) body.reasoning = { effort: this.options.reasoningEffort ?? "low" };
    const { status, json } = await postJson(this.options, {
      provider_id: this.provider_id,
      model_id: this.model_id,
      url: `${this.baseUrl}/v1/responses`,
      headers: { authorization: `Bearer ${this.key}` },
      body,
      signal,
    });
    if (status !== 200) throw providerError(status, json);
    if (!isRecord(json)) throw new AdapterError("model_response_invalid", "OpenAI answered with no response object");
    const texts: string[] = [];
    let refusal = false;
    for (const item of Array.isArray(json.output) ? json.output : []) {
      if (!isRecord(item) || item.type !== "message" || !Array.isArray(item.content)) continue;
      for (const part of item.content) {
        if (!isRecord(part)) continue;
        if (part.type === "output_text" && typeof part.text === "string") texts.push(part.text);
        if (part.type === "refusal") refusal = true;
      }
    }
    const incomplete = isRecord(json.incomplete_details) ? json.incomplete_details.reason : null;
    const statusWord = typeof json.status === "string" ? json.status : null;
    let stop: string | null;
    if (refusal) stop = "refusal";
    else if (statusWord === "completed") stop = "stop";
    else if (statusWord === "incomplete") stop = incomplete === "max_output_tokens" ? "length" : typeof incomplete === "string" ? incomplete : "incomplete";
    else stop = statusWord ?? "unreported";
    const usage = isRecord(json.usage) ? json.usage : null;
    const model = typeof json.model === "string" ? json.model : null;
    return {
      text: texts.length > 0 ? texts.join("") : null,
      model_id: model === null ? null : `openai/${model}`,
      response_model: model,
      stop_reason: stop,
      usage: usage
        ? {
            input_tokens: typeof usage.input_tokens === "number" ? usage.input_tokens : null,
            output_tokens: typeof usage.output_tokens === "number" ? usage.output_tokens : null,
            // Cached prompt tokens are part of `input_tokens` already; recorded, not added.
            cache_read_tokens: null,
            cache_write_tokens: null,
            total_tokens: typeof usage.total_tokens === "number" ? usage.total_tokens : null,
            cost_usd: null,
          }
        : null,
      constrained: schema !== null,
      constraint_detail:
        schema !== null
          ? "Requested as a non-strict json_schema text format on the Responses API. Conformance is still enforced by parse-and-validate."
          : "This output schema cannot carry a provider-native constraint; the adapter parses and validates the response instead.",
    };
  }
}
