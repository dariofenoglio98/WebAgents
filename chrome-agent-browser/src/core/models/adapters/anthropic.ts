/**
 * Anthropic through the Messages API with the person's own key (D-023, D-062), spoken over
 * the injected transport (the core carries no SDK). The request sends the rendered system text
 * as `system`, the user text as the one user message, `max_tokens` = the node's cap,
 * `output_config.format` = the json_schema constraint copy (numeric and string bounds dropped,
 * every object closed, as the API requires) and `output_config.effort` (`low` by default, so
 * adaptive thinking does not spend the node's cap; thinking itself is left at the model's
 * default). The browser-access header lets an extension page call the API directly.
 * `end_turn`/`stop_sequence` finish a turn, `max_tokens` truncates it, `refusal` and anything
 * else is a turn the provider did not complete. Input usage is `input_tokens` plus cache
 * creation and cache read tokens.
 */
import type { JsonValue } from "../../json.js";
import { AdapterError } from "../../workflow/errors.js";
import type { RenderedRequest } from "../render.js";
import type { ProviderAdapter, ProviderCompletion } from "../router.js";
import { ANTHROPIC_RULES, constraintSchema } from "../schema-format.js";
import type { ModelPricing } from "../usage.js";
import { checkCredential, isRecord, postJson, providerBaseUrl, providerError, type ProviderHttpOptions } from "./shared.js";

export const DEFAULT_ANTHROPIC_URL = "https://api.anthropic.com";
export const ANTHROPIC_VERSION = "2023-06-01";

export interface AnthropicAdapterOptions extends ProviderHttpOptions {
  model: string;
  apiKey: string | null | undefined;
  baseUrl?: string;
  contextWindow: number;
  reasoning?: boolean;
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  pricing?: ModelPricing | null;
}

export class AnthropicAdapter implements ProviderAdapter {
  readonly provider_id = "anthropic";
  readonly model_id: string;
  readonly host_model_id: string;
  readonly remote = true;
  readonly reasoning: boolean;
  readonly context_window: number;
  readonly domains: readonly string[];
  readonly pricing: ModelPricing | null;
  readonly baseUrl: string;
  private readonly key: string;

  constructor(private readonly options: AnthropicAdapterOptions) {
    this.model_id = options.model;
    this.host_model_id = `anthropic/${options.model}`;
    this.baseUrl = providerBaseUrl(options.baseUrl ?? DEFAULT_ANTHROPIC_URL, { allowLoopbackHttp: false });
    this.key = checkCredential(options.apiKey, "Anthropic API key");
    this.reasoning = options.reasoning ?? true;
    this.context_window = options.contextWindow;
    this.domains = [new URL(this.baseUrl).hostname];
    this.pricing = options.pricing ?? null;
  }

  async complete(rendered: RenderedRequest, maxOutputTokens: number, signal: AbortSignal): Promise<ProviderCompletion> {
    const schema = constraintSchema(rendered.output_schema, ANTHROPIC_RULES);
    const outputConfig: Record<string, JsonValue> = { effort: this.options.effort ?? "low" };
    if (schema !== null) outputConfig.format = { type: "json_schema", schema };
    const body: Record<string, JsonValue> = {
      model: this.model_id,
      max_tokens: maxOutputTokens,
      system: rendered.system,
      messages: [{ role: "user", content: rendered.user }],
      output_config: outputConfig,
    };
    const { status, json } = await postJson(this.options, {
      provider_id: this.provider_id,
      model_id: this.model_id,
      url: `${this.baseUrl}/v1/messages`,
      headers: { "x-api-key": this.key, "anthropic-version": ANTHROPIC_VERSION, "anthropic-dangerous-direct-browser-access": "true" },
      body,
      signal,
    });
    if (status !== 200) throw providerError(status, json);
    if (!isRecord(json)) throw new AdapterError("model_response_invalid", "Anthropic answered with no message object");
    const texts: string[] = [];
    for (const block of Array.isArray(json.content) ? json.content : []) {
      if (isRecord(block) && block.type === "text" && typeof block.text === "string") texts.push(block.text);
    }
    const raw = typeof json.stop_reason === "string" ? json.stop_reason : null;
    const stop = raw === "end_turn" || raw === "stop_sequence" ? "stop" : raw === "max_tokens" ? "length" : raw;
    const usage = isRecord(json.usage) ? json.usage : null;
    const model = typeof json.model === "string" ? json.model : null;
    return {
      text: texts.length > 0 ? texts.join("") : null,
      model_id: model === null ? null : `anthropic/${model}`,
      response_model: model,
      stop_reason: stop,
      usage: usage
        ? {
            input_tokens: typeof usage.input_tokens === "number" ? usage.input_tokens : null,
            output_tokens: typeof usage.output_tokens === "number" ? usage.output_tokens : null,
            cache_read_tokens: typeof usage.cache_read_input_tokens === "number" ? usage.cache_read_input_tokens : null,
            cache_write_tokens: typeof usage.cache_creation_input_tokens === "number" ? usage.cache_creation_input_tokens : null,
            total_tokens: null,
            cost_usd: null,
          }
        : null,
      constrained: schema !== null,
      constraint_detail:
        schema !== null
          ? "Requested as output_config.format (json_schema) on the Messages API with bounds the API refuses dropped from the constraint copy. Conformance is still enforced by parse-and-validate against the full schema."
          : "This output schema cannot carry a provider-native constraint; the adapter parses and validates the response instead.",
    };
  }
}
