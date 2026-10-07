/**
 * Ollama's native `/api/chat` (D-023, D-062): the recommended local route.
 *
 * The request carries the rendered system and user text, `format` set to the constraint
 * schema (Ollama constrains decoding against any root), `options.num_ctx` = the bound context
 * window, `options.num_predict` = the node's output cap, `stream: false`, and `think: false`
 * unless the host enables thinking: with `format` plus thinking Ollama 0.34 runs two passes and
 * the output can exceed `num_predict`, which the runtime then (rightly) treats as an overrun
 * and halts. Usage is `prompt_eval_count` / `eval_count`; `done_reason` `stop` is a finished
 * turn, `length` a truncated one. A base URL must be loopback over http or any https origin.
 */
import type { JsonValue } from "../../json.js";
import { AdapterError } from "../../workflow/errors.js";
import type { RenderedRequest } from "../render.js";
import type { ProviderAdapter, ProviderCompletion } from "../router.js";
import { constraintSchema, OLLAMA_RULES } from "../schema-format.js";
import type { ModelPricing } from "../usage.js";
import { isRecord, postJson, providerBaseUrl, providerError, type ProviderHttpOptions } from "./shared.js";

export const DEFAULT_OLLAMA_URL = "http://127.0.0.1:11434";

export interface OllamaAdapterOptions extends ProviderHttpOptions {
  model: string;
  baseUrl?: string;
  contextWindow: number;
  reasoning?: boolean;
  /** Send `think: true`; off by default so the output cap stays enforceable. */
  think?: boolean;
  pricing?: ModelPricing | null;
}

export class OllamaAdapter implements ProviderAdapter {
  readonly provider_id = "ollama";
  readonly model_id: string;
  readonly host_model_id: string;
  readonly remote: boolean;
  readonly reasoning: boolean;
  readonly context_window: number;
  readonly domains: readonly string[];
  readonly pricing: ModelPricing | null;
  readonly baseUrl: string;
  private readonly think: boolean;

  constructor(private readonly options: OllamaAdapterOptions) {
    this.model_id = options.model;
    this.host_model_id = `ollama/${options.model}`;
    this.baseUrl = providerBaseUrl(options.baseUrl ?? DEFAULT_OLLAMA_URL, { allowLoopbackHttp: true });
    const host = new URL(this.baseUrl).hostname;
    // A local server is local; an Ollama reached over https elsewhere is a remote route.
    this.remote = !(host === "127.0.0.1" || host === "localhost" || host === "[::1]");
    this.reasoning = options.reasoning ?? false;
    this.context_window = options.contextWindow;
    this.domains = this.remote ? [host] : [];
    this.pricing = options.pricing ?? null;
    this.think = options.think ?? false;
  }

  async complete(rendered: RenderedRequest, maxOutputTokens: number, signal: AbortSignal): Promise<ProviderCompletion> {
    const format = constraintSchema(rendered.output_schema, OLLAMA_RULES);
    const body: Record<string, JsonValue> = {
      model: this.model_id,
      messages: [
        { role: "system", content: rendered.system },
        { role: "user", content: rendered.user },
      ],
      stream: false,
      think: this.think,
      options: { num_ctx: this.context_window, num_predict: maxOutputTokens },
    };
    if (format !== null) body.format = format;
    const { status, json } = await postJson(this.options, { provider_id: this.provider_id, model_id: this.model_id, url: `${this.baseUrl}/api/chat`, headers: {}, body, signal });
    if (status !== 200) throw providerError(status, json);
    if (!isRecord(json)) throw new AdapterError("model_response_invalid", "Ollama answered with no message object");
    const message = isRecord(json.message) ? json.message : null;
    const doneReason = typeof json.done_reason === "string" ? json.done_reason : json.done === true ? "stop" : null;
    const model = typeof json.model === "string" ? json.model : null;
    return {
      text: message && typeof message.content === "string" ? message.content : null,
      model_id: model === null ? null : `ollama/${model}`,
      response_model: model,
      stop_reason: doneReason,
      usage: {
        input_tokens: typeof json.prompt_eval_count === "number" ? json.prompt_eval_count : null,
        output_tokens: typeof json.eval_count === "number" ? json.eval_count : null,
        cache_read_tokens: null,
        cache_write_tokens: null,
        total_tokens: null,
        cost_usd: null,
      },
      constrained: format !== null,
      constraint_detail:
        format !== null
          ? "Requested as Ollama's `format` field, which constrains decoding against the schema. Conformance is still enforced by parse-and-validate."
          : "This output schema cannot carry a provider-native constraint; the adapter parses and validates the response instead.",
    };
  }
}
