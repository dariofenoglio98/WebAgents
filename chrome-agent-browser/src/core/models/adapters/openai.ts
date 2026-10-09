/**
 * OpenAI through the Responses API with the person's own key (D-023, D-062).
 *
 * `instructions` carries the rendered system text and `input` the user text;
 * `text.format` is the json_schema constraint: **strict** when the package schema can be one
 * without changing its meaning (`openAiStrictSchema`, D-115: constrained decoding, a guarantee),
 * else non-strict (any package schema is accepted and the model is guided rather than guaranteed,
 * D-062). When OpenAI refuses a strict schema (HTTP 400 naming the format or schema), the same
 * request is sent once more non-strict: no answer was produced, so nothing is retried but the
 * request's shape. The router validates every answer against the full schema either way;
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
import { constraintSchema, OPENAI_RULES, openAiStrictSchema, RESPONSE_FORMAT_NAME } from "../schema-format.js";
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
    const strict = openAiStrictSchema(rendered.output_schema);
    const bodyWith = (format: JsonValue | null): Record<string, JsonValue> => {
      const body: Record<string, JsonValue> = {
        model: this.model_id,
        instructions: rendered.system,
        input: rendered.user,
        max_output_tokens: maxOutputTokens,
        store: false,
      };
      if (format !== null) body.text = { format };
      if (this.reasoning) body.reasoning = { effort: this.options.reasoningEffort ?? "low" };
      return body;
    };
    const send = (body: Record<string, JsonValue>) =>
      postJson(this.options, { provider_id: this.provider_id, model_id: this.model_id, url: `${this.baseUrl}/v1/responses`, headers: { authorization: `Bearer ${this.key}` }, body, signal });
    const nonStrict = schema !== null ? { type: "json_schema", name: RESPONSE_FORMAT_NAME, schema, strict: false } : null;
    let mode: "strict" | "non_strict" | "non_strict_after_refusal" | "none" = strict !== null ? "strict" : nonStrict !== null ? "non_strict" : "none";
    let refusedBecause: string | null = null;
    let { status, json } = await send(bodyWith(strict !== null ? { type: "json_schema", name: RESPONSE_FORMAT_NAME, schema: strict, strict: true } : nonStrict));
    if (mode === "strict" && strictSchemaRefused(status, json)) {
      refusedBecause = errorMessage(json);
      mode = "non_strict_after_refusal";
      ({ status, json } = await send(bodyWith(nonStrict)));
    }
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
      constrained: mode !== "none",
      constraint_detail:
        mode === "strict"
          ? "Requested as a strict json_schema text format on the Responses API (constrained decoding, D-115). Conformance is still enforced by parse-and-validate against the full schema."
          : mode === "non_strict_after_refusal"
            ? `OpenAI refused the strict json_schema (${refusedBecause ?? "HTTP 400"}); requested again as a non-strict json_schema text format. Conformance is still enforced by parse-and-validate.`
            : mode === "non_strict"
              ? "Requested as a non-strict json_schema text format on the Responses API (the schema cannot be strict without changing its meaning). Conformance is still enforced by parse-and-validate."
              : "This output schema cannot carry a provider-native constraint; the adapter parses and validates the response instead.",
    };
  }
}

/** OpenAI's answer to a strict schema it cannot use: HTTP 400 naming the response format or the schema. */
export function strictSchemaRefused(status: number, json: unknown): boolean {
  if (status !== 400 || !isRecord(json) || !isRecord(json.error)) return false;
  const param = typeof json.error.param === "string" ? json.error.param : "";
  const message = typeof json.error.message === "string" ? json.error.message : "";
  return /^text(\.format)?/u.test(param) || /schema|strict|response[_ ]format|text\.format/iu.test(message);
}

/** The provider's own error message, bounded, for the constraint detail (never a credential: OpenAI's messages name parameters). */
function errorMessage(json: unknown): string | null {
  if (!isRecord(json) || !isRecord(json.error) || typeof json.error.message !== "string") return null;
  return json.error.message.replace(/\s+/gu, " ").slice(0, 200);
}

