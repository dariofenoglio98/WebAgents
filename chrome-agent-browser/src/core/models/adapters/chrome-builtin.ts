/**
 * The contract for Chrome's built-in model (Gemini Nano through the Prompt API, D-023) and a
 * Node stub. The real adapter is T5's: it lives in the extension, where `LanguageModel`
 * exists, and implements `BuiltinModelPort` so that the core's router and accounting stay
 * unchanged. Here the core states what it needs from that port and what a host without the
 * API answers: `unavailable`, and a completion that refuses rather than pretends.
 */
import { AdapterError } from "../../workflow/errors.js";
import type { RenderedRequest } from "../render.js";
import type { ProviderAdapter, ProviderCompletion } from "../router.js";
import type { ModelPricing } from "../usage.js";

export type BuiltinAvailability = "available" | "downloadable" | "downloading" | "unavailable";

export interface BuiltinSession {
  /** One prompt; the answer text. The signal must stop generation. */
  prompt(text: string, signal: AbortSignal): Promise<string>;
  /** The Prompt API's own count of the tokens `text` would cost: the model's tokenizer, for input and output alike (D-072). */
  measureInputUsage(text: string): Promise<number>;
  readonly inputQuota: number;
  /** Whether the port applied the response constraint to this session's prompts. */
  readonly constrained?: boolean;
  destroy(): void;
}

export interface BuiltinModelPort {
  availability(): Promise<BuiltinAvailability>;
  /** A fresh session per call: no memory between workflow steps. `responseConstraint` is the constraint schema the port applies to the prompt, when it supports one. */
  createSession(options: { systemPrompt: string; responseConstraint?: Record<string, unknown> | null; signal: AbortSignal }): Promise<BuiltinSession>;
}

export const CHROME_BUILTIN_PROVIDER = "chrome-builtin";
export const CHROME_BUILTIN_MODEL = "gemini-nano";
export const CHROME_BUILTIN_HOST_MODEL_ID = `${CHROME_BUILTIN_PROVIDER}/${CHROME_BUILTIN_MODEL}`;

/** The port a host without the Prompt API provides: never available, never answering. */
export class UnavailableBuiltinPort implements BuiltinModelPort {
  async availability(): Promise<BuiltinAvailability> {
    return "unavailable";
  }

  async createSession(): Promise<BuiltinSession> {
    throw new AdapterError("model_unavailable", "This host has no built-in model");
  }
}

function quotaExceeded(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { name?: unknown }).name === "QuotaExceededError";
}

/**
 * The adapter over a `BuiltinModelPort` (D-072). Accounting uses the Prompt API's own tokenizer
 * for both directions: input = `measureInputUsage(system + user)`, output =
 * `measureInputUsage(answer)`, never a byte count compared with a token cap (T4 review 2,
 * nit 6) and never a guess of zero. The Prompt API has no output cap of its own, so an answer
 * that measures above the node's cap is reported as a `length` stop (the router fails the node
 * as truncated) rather than as a completion the runtime would have to halt over (T4 review 1,
 * nit 9). The bundled output schema is handed to the port as `responseConstraint` (a hint,
 * D-062); the router still parses and validates every answer. A `QuotaExceededError` from the
 * API (the prompt does not fit the session's `inputQuota`) is the request's fault, not the
 * model's absence: `model_request_invalid` (D-072; T5 review 1, nit 10).
 */
export class ChromeBuiltinAdapter implements ProviderAdapter {
  readonly provider_id = CHROME_BUILTIN_PROVIDER;
  readonly model_id = CHROME_BUILTIN_MODEL;
  readonly host_model_id = CHROME_BUILTIN_HOST_MODEL_ID;
  readonly remote = false;
  readonly reasoning = false;
  readonly domains: readonly string[] = [];
  readonly pricing: ModelPricing | null = null;

  constructor(
    private readonly port: BuiltinModelPort,
    readonly context_window: number,
  ) {}

  async complete(rendered: RenderedRequest, maxOutputTokens: number, signal: AbortSignal): Promise<ProviderCompletion> {
    if ((await this.port.availability()) !== "available") {
      throw new AdapterError("model_unavailable", "The built-in model is not available on this host");
    }
    const constraint = rendered.output_schema !== null && typeof rendered.output_schema === "object" && !Array.isArray(rendered.output_schema) ? (rendered.output_schema as Record<string, unknown>) : null;
    let session: BuiltinSession;
    try {
      session = await this.port.createSession({ systemPrompt: rendered.system, responseConstraint: constraint, signal });
    } catch (error) {
      if (quotaExceeded(error)) throw new AdapterError("model_request_invalid", "The system prompt exceeds the built-in model's session quota");
      throw error;
    }
    try {
      const inputTokens = await session.measureInputUsage(`${rendered.system}\n${rendered.user}`);
      let text: string;
      try {
        text = await session.prompt(rendered.user, signal);
      } catch (error) {
        if (quotaExceeded(error)) throw new AdapterError("model_request_invalid", `The request (${inputTokens} tokens) exceeds the built-in model's session quota of ${session.inputQuota} tokens`, { detail: { input_tokens: inputTokens, input_quota: session.inputQuota } });
        throw error;
      }
      const outputTokens = await session.measureInputUsage(text);
      const constrained = session.constrained === true;
      return {
        text,
        model_id: this.host_model_id,
        response_model: this.model_id,
        stop_reason: outputTokens > maxOutputTokens ? "length" : "stop",
        usage: { input_tokens: inputTokens, output_tokens: outputTokens, cache_read_tokens: null, cache_write_tokens: null, total_tokens: null, cost_usd: null },
        constrained,
        constraint_detail: constrained
          ? "Prompt API responseConstraint (the bundled output schema); the answer is parsed and validated by the router regardless."
          : "The port applied no response constraint; the answer is parsed and validated by the router.",
      };
    } finally {
      session.destroy();
    }
  }
}
