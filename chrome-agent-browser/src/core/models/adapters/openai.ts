/**
 * OpenAI through the Responses API with the person's own key (D-023, D-062).
 *
 * `instructions` carries the rendered system text and `input` the user text;
 * `text.format` is the json_schema constraint (`openAiConstraint`): **strict** when the package
 * schema can be one without changing its meaning (D-115: constrained decoding, a guarantee), with
 * optional properties encoded as required and nullable (D-121) and an array root wrapped as
 * `{"items": …}` (D-122); else non-strict (D-062). When OpenAI refuses a strict schema (HTTP 400
 * naming the format or schema), the same request is sent once more non-strict: no answer was
 * produced, so nothing is retried but the request's shape, and the refusal is remembered for that
 * schema so later calls go non-strict directly. The completion says how the answer is read back
 * (`decoding`); the router validates every answer against the full schema either way.
 * `reasoning.effort` is the connection's setting (D-123, default `medium`); `max_output_tokens`
 * is the node's cap; `store: false`. Usage: `input_tokens` (cached tokens are already inside it,
 * so they are not added again) and `output_tokens` (reasoning tokens included). A `completed`
 * response is a finished turn; `incomplete` with `max_output_tokens` is truncated, any other
 * unfinished status or a `refusal` block is a turn the provider did not complete.
 */
import type { JsonValue } from "../../json.js";
import { AdapterError } from "../../workflow/errors.js";
import type { RenderedRequest } from "../render.js";
import type { ProviderAdapter, ProviderCompletion } from "../router.js";
import { openAiConstraint, RESPONSE_FORMAT_NAME, type ConstraintDecoding, type OpenAiConstraint } from "../schema-format.js";
import type { ModelPricing } from "../usage.js";
import { checkCredential, isRecord, postJson, providerBaseUrl, providerError, type ProviderHttpOptions } from "./shared.js";

export const DEFAULT_OPENAI_URL = "https://api.openai.com";
export const OPENAI_REASONING_EFFORTS = ["low", "medium", "high"] as const;
export type OpenAIReasoningEffort = (typeof OPENAI_REASONING_EFFORTS)[number];
/** D-123: `medium` gave Literature Review's copy-heavy steps their full coverage where `low` shortcut them (T10). */
export const DEFAULT_OPENAI_REASONING_EFFORT: OpenAIReasoningEffort = "medium";
/** How many node schemas one adapter keeps the constraint of; a package declares a few dozen at most. */
const MAX_HELD_CONSTRAINTS = 64;

export interface OpenAIAdapterOptions extends ProviderHttpOptions {
  model: string;
  apiKey: string | null | undefined;
  baseUrl?: string;
  contextWindow: number;
  reasoning?: boolean;
  /** `reasoning.effort` sent when the model reasons (D-123); the connection's setting, default `medium`. */
  reasoningEffort?: OpenAIReasoningEffort;
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
  /** The effort sent when the model reasons, recorded on the run (D-123); absent for a model that does not reason. */
  readonly reasoning_effort?: OpenAIReasoningEffort;
  private readonly key: string;
  /** Strict copies OpenAI refused, by their exact text, with OpenAI's message: sent non-strict from then on. */
  private readonly refusedStrict = new Map<string, string | null>();
  /** The constraint per package schema text, computed once per adapter (a run asks the same node schemas again and again). */
  private readonly constraints = new Map<string, { constraint: OpenAiConstraint; strictKey: string | null }>();

  constructor(private readonly options: OpenAIAdapterOptions) {
    this.model_id = options.model;
    this.host_model_id = `openai/${options.model}`;
    this.baseUrl = providerBaseUrl(options.baseUrl ?? DEFAULT_OPENAI_URL, { allowLoopbackHttp: false });
    this.key = checkCredential(options.apiKey, "OpenAI API key");
    this.reasoning = options.reasoning ?? false;
    this.context_window = options.contextWindow;
    this.domains = [new URL(this.baseUrl).hostname];
    this.pricing = options.pricing ?? null;
    if (this.reasoning) this.reasoning_effort = options.reasoningEffort ?? DEFAULT_OPENAI_REASONING_EFFORT;
  }

  private constraintFor(schema: JsonValue): { constraint: OpenAiConstraint; strictKey: string | null } {
    const text = JSON.stringify(schema);
    let held = this.constraints.get(text);
    if (held === undefined) {
      const constraint = openAiConstraint(schema);
      held = { constraint, strictKey: constraint.strict !== null ? JSON.stringify(constraint.strict) : null };
      if (this.constraints.size >= MAX_HELD_CONSTRAINTS) this.constraints.delete(this.constraints.keys().next().value!);
      this.constraints.set(text, held);
    }
    return held;
  }

  async complete(rendered: RenderedRequest, maxOutputTokens: number, signal: AbortSignal): Promise<ProviderCompletion> {
    const { constraint, strictKey } = this.constraintFor(rendered.output_schema);
    const bodyWith = (format: JsonValue | null): Record<string, JsonValue> => {
      const body: Record<string, JsonValue> = {
        model: this.model_id,
        instructions: rendered.system,
        input: rendered.user,
        max_output_tokens: maxOutputTokens,
        store: false,
      };
      if (format !== null) body.text = { format };
      if (this.reasoning_effort !== undefined) body.reasoning = { effort: this.reasoning_effort };
      return body;
    };
    const send = (body: Record<string, JsonValue>) =>
      postJson(this.options, { provider_id: this.provider_id, model_id: this.model_id, url: `${this.baseUrl}/v1/responses`, headers: { authorization: `Bearer ${this.key}` }, body, signal });
    const strictFormat = constraint.strict !== null ? { type: "json_schema", name: RESPONSE_FORMAT_NAME, schema: constraint.strict, strict: true } : null;
    const nonStrictFormat = constraint.nonStrict !== null ? { type: "json_schema", name: RESPONSE_FORMAT_NAME, schema: constraint.nonStrict, strict: false } : null;
    type Mode = "strict" | "non_strict" | "non_strict_after_refusal" | "none_after_refusal" | "none";
    const afterRefusal = (): Mode => (nonStrictFormat !== null ? "non_strict_after_refusal" : "none_after_refusal");
    let mode: Mode = strictFormat !== null ? "strict" : nonStrictFormat !== null ? "non_strict" : "none";
    let refusedBecause: string | null = null;
    let remembered = false;
    if (mode === "strict" && strictKey !== null && this.refusedStrict.has(strictKey)) {
      refusedBecause = this.refusedStrict.get(strictKey)!;
      remembered = true;
      mode = afterRefusal();
    }
    let { status, json } = await send(bodyWith(mode === "strict" ? strictFormat : nonStrictFormat));
    if (mode === "strict" && strictSchemaRefused(status, json)) {
      refusedBecause = errorMessage(json);
      if (strictKey !== null) this.refusedStrict.set(strictKey, refusedBecause);
      mode = afterRefusal();
      ({ status, json } = await send(bodyWith(nonStrictFormat)));
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
      constrained: mode === "strict" || mode === "non_strict" || mode === "non_strict_after_refusal",
      constraint_detail: constraintDetail(mode, constraint.envelope, constraint.encodedOptional, refusedBecause, remembered),
      decoding: decodingFor(mode, constraint.envelope, constraint.encodedOptional),
    };
  }
}

/** How the answer is read back: the envelope whenever a wrapped format was sent, the null encoding only for the strict copy. */
function decodingFor(mode: string, envelope: boolean, encodedOptional: boolean): ConstraintDecoding | undefined {
  const sent = mode === "strict" || mode === "non_strict" || mode === "non_strict_after_refusal";
  if (!sent || (!envelope && !(mode === "strict" && encodedOptional))) return undefined;
  return { envelope: envelope, optional_nulls: mode === "strict" && encodedOptional };
}

function constraintDetail(mode: string, envelope: boolean, encodedOptional: boolean, refusedBecause: string | null, remembered: boolean): string {
  const shape = [envelope ? 'the array root wrapped as {"items": …} and unwrapped from the answer (D-122)' : null, mode === "strict" && encodedOptional ? "optional properties sent as required and nullable, a null for one read as absent (D-121)" : null].filter((part) => part !== null);
  const how = shape.length > 0 ? `, with ${shape.join("; ")}` : "";
  const refusal = `OpenAI refused the strict json_schema (${refusedBecause ?? "HTTP 400"})${remembered ? ", remembered from an earlier call of this run" : ""}`;
  switch (mode) {
    case "strict":
      return `Requested as a strict json_schema text format on the Responses API (constrained decoding, D-115)${how}. Conformance is still enforced by parse-and-validate against the full schema.`;
    case "non_strict_after_refusal":
      return `${refusal}; requested again as a non-strict json_schema text format${how}. Conformance is still enforced by parse-and-validate.`;
    case "none_after_refusal":
      return `${refusal}; requested again with no text format (no non-strict copy fits the request). The adapter parses and validates the response instead.`;
    case "non_strict":
      return `Requested as a non-strict json_schema text format on the Responses API (the schema cannot be strict without changing its meaning)${how}. Conformance is still enforced by parse-and-validate.`;
    default:
      return "This output schema cannot carry a provider-native constraint; the adapter parses and validates the response instead.";
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

