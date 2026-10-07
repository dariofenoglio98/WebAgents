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
  /** The Prompt API's own count of the tokens `text` would cost (an upper bound for accounting). */
  measureInputUsage(text: string): Promise<number>;
  readonly inputQuota: number;
  destroy(): void;
}

export interface BuiltinModelPort {
  availability(): Promise<BuiltinAvailability>;
  /** A fresh session per call: no memory between workflow steps. `responseConstraint` is the constraint schema, when the port supports one. */
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

/**
 * The adapter shape T5 completes over a real port. `complete` is specified here so the
 * router's handling of its answers is fixed; the accounting rule (D-072) is T5's decision and
 * the default below is the conservative one: the measured input count and a byte-bound output
 * count, never a guess of zero.
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

  async complete(rendered: RenderedRequest, _maxOutputTokens: number, signal: AbortSignal): Promise<ProviderCompletion> {
    if ((await this.port.availability()) !== "available") {
      throw new AdapterError("model_unavailable", "The built-in model is not available on this host");
    }
    const session = await this.port.createSession({ systemPrompt: rendered.system, responseConstraint: null, signal });
    try {
      const inputTokens = await session.measureInputUsage(`${rendered.system}\n${rendered.user}`);
      const text = await session.prompt(rendered.user, signal);
      return {
        text,
        model_id: this.host_model_id,
        response_model: this.model_id,
        stop_reason: "stop",
        usage: { input_tokens: inputTokens, output_tokens: new TextEncoder().encode(text).length, cache_read_tokens: null, cache_write_tokens: null, total_tokens: null, cost_usd: null },
        constrained: false,
        constraint_detail: "The Prompt API's responseConstraint is wired by the extension adapter (T5); this core adapter parses and validates the response.",
      };
    } finally {
      session.destroy();
    }
  }
}
