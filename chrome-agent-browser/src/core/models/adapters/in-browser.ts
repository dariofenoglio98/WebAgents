/**
 * The in-browser route (D-440, D-445): a model the extension itself runs on the machine's GPU,
 * inside the browser, with no application beside it (D-310, D-311). The core states the contract
 * and never touches an engine: the shell implements `InBrowserEnginePort` over the engine Worker
 * that lives in the offscreen document (D-441), exactly as `builtin-port.ts` implements
 * `BuiltinModelPort` over the Prompt API, and `src/core` stays free of WebGPU and the DOM.
 *
 * What the adapter delivers is what every route delivers (`router.ts`): the bundled output schema
 * goes to the engine as a grammar constraint (`GGUF_GRAMMAR_RULES`: the schema as given), the
 * router still parses and validates every answer, usage is the engine's own count (thinking tokens
 * included in the output count) or the call fails `model_usage_unavailable`, a `length` finish is
 * reported as a `length` stop so the router fails the node as truncated, and an abort stops the
 * engine (the spike measured about 0.3 s). There is no transport: no URL gate, no address policy,
 * nothing to refuse, and the observer (D-028) still sees the request under `in-browser:<entry>`.
 * Design: `docs/design/in-browser-inference.md` §4.
 */
import type { JsonObject } from "../../json.js";
import { AdapterError, CancelledError } from "../../workflow/errors.js";
import type { RenderedRequest } from "../render.js";
import type { ProviderAdapter, ProviderCompletion } from "../router.js";
import { constraintSchema, GGUF_GRAMMAR_RULES } from "../schema-format.js";
import type { ModelRequestObserver } from "../transport.js";
import type { ModelPricing } from "../usage.js";

export const IN_BROWSER_PROVIDER = "in-browser";
/** The scheme the observer sees for a request that never leaves the browser. */
export const IN_BROWSER_URL_SCHEME = "in-browser:";

export interface InBrowserCompletionRequest {
  /** The catalog entry id the plan bound (`in-browser/<entry>` without the prefix). */
  entry: string;
  /** The rendered request (`render.ts`), as every adapter sends it. */
  system: string;
  user: string;
  /** The constraint copy of the bundled output schema, or null when none can be derived. */
  schema: JsonObject | null;
  /** The node's output cap; the engine stops there. */
  max_tokens: number;
  /** Whether the engine was loaded with thinking on (D-085); recorded, never changed per call. */
  think: boolean;
}

export interface InBrowserCompletion {
  /** The answer's content; reasoning stays in the engine. Null when the engine returned none. */
  text: string | null;
  /** `stop`, `length`, `abort`, or the engine's own word for an unfinished turn. */
  finish_reason: string | null;
  /** The engine's own counts; null for a count it did not report (never zero for "unknown"). */
  usage: { prompt_tokens: number | null; completion_tokens: number | null; total_tokens: number | null };
  /** The engine's timings, for the evidence; absent when it reports none. */
  timings?: { prompt_per_second: number | null; predicted_per_second: number | null } | null;
  /** Whether the engine applied the grammar to this answer. */
  constrained: boolean;
}

export interface InBrowserEngineStatus {
  /** The entry loaded now, or null. */
  loaded: string | null;
  /** Whether a completion is in flight (calls are serial, D-441). */
  busy: boolean;
}

/**
 * The port the shell implements over the engine Worker (D-441): it never loads a model (loading is
 * the offscreen host's decision before the run), it completes on the loaded entry only, and it
 * stops when the signal aborts, rejecting with the signal's reason.
 */
export interface InBrowserEnginePort {
  status(): Promise<InBrowserEngineStatus>;
  complete(request: InBrowserCompletionRequest, signal: AbortSignal): Promise<InBrowserCompletion>;
}

export interface InBrowserAdapterOptions {
  /** The catalog entry id the binding names (`model_id`). */
  entry: string;
  contextWindow: number;
  reasoning: boolean;
  /** Whether the engine thinks (D-085), as the host loaded it. */
  think: boolean;
  observer?: ModelRequestObserver | null;
}

/** `in-browser/<entry>`, the host model id of an entry. */
export function inBrowserHostModelId(entry: string): string {
  return `${IN_BROWSER_PROVIDER}/${entry}`;
}

export class InBrowserAdapter implements ProviderAdapter {
  readonly provider_id = IN_BROWSER_PROVIDER;
  readonly model_id: string;
  readonly host_model_id: string;
  readonly remote = false;
  readonly reasoning: boolean;
  readonly context_window: number;
  readonly domains: readonly string[] = [];
  readonly pricing: ModelPricing | null = null;
  readonly thinking: boolean;
  private readonly observer: ModelRequestObserver | null;

  constructor(
    private readonly port: InBrowserEnginePort,
    options: InBrowserAdapterOptions,
  ) {
    this.model_id = options.entry;
    this.host_model_id = inBrowserHostModelId(options.entry);
    this.context_window = options.contextWindow;
    this.reasoning = options.reasoning;
    this.thinking = options.think;
    this.observer = options.observer ?? null;
  }

  async complete(rendered: RenderedRequest, maxOutputTokens: number, signal: AbortSignal): Promise<ProviderCompletion> {
    const status = await this.port.status();
    if (status.loaded !== this.model_id) {
      throw new AdapterError("model_unavailable", status.loaded === null ? "No in-browser model is loaded" : `The in-browser engine holds ${JSON.stringify(status.loaded)}, not the model this run bound`, {
        detail: { entry: this.model_id, loaded: status.loaded },
      });
    }
    const schema = constraintSchema(rendered.output_schema, GGUF_GRAMMAR_RULES);
    const request: InBrowserCompletionRequest = { entry: this.model_id, system: rendered.system, user: rendered.user, schema, max_tokens: maxOutputTokens, think: this.thinking };
    // The request never leaves the browser; the observer sees it anyway, so "no sealed value in any
    // model request" is asserted for this route as for the others (D-028).
    this.observer?.({ provider_id: this.provider_id, model_id: this.model_id, url: `${IN_BROWSER_URL_SCHEME}${this.model_id}`, body: JSON.stringify({ system: request.system, user: request.user, schema: request.schema, max_tokens: request.max_tokens }) });
    if (signal.aborted) throw (signal.reason as Error | undefined) ?? new CancelledError();
    let answer: InBrowserCompletion;
    try {
      answer = await this.port.complete(request, signal);
    } catch (error) {
      if (signal.aborted) throw (signal.reason as Error | undefined) ?? new CancelledError();
      if (error instanceof AdapterError) throw error;
      // The engine Worker died or the engine refused: the model is not available to this run, and
      // the run is never retried on another model (principle 6).
      throw new AdapterError("model_unavailable", `The in-browser engine failed (${error instanceof Error ? error.name : "error"})`, { audit_facts: { stage: "engine" } });
    }
    if (answer.finish_reason === "abort") throw (signal.reason as Error | undefined) ?? new CancelledError();
    return {
      text: answer.text,
      model_id: this.host_model_id,
      response_model: this.model_id,
      stop_reason: answer.finish_reason === "length" ? "length" : answer.finish_reason === "stop" ? "stop" : answer.finish_reason,
      usage: { input_tokens: answer.usage.prompt_tokens, output_tokens: answer.usage.completion_tokens, cache_read_tokens: null, cache_write_tokens: null, total_tokens: answer.usage.total_tokens, cost_usd: null },
      constrained: answer.constrained && schema !== null,
      constraint_detail:
        answer.constrained && schema !== null
          ? "llama.cpp grammar from the bundled output schema (response_format.json_schema); the answer is parsed and validated by the router regardless."
          : "The engine applied no grammar; the answer is parsed and validated by the router.",
    };
  }
}

/**
 * A port for tests and the Node CLI without an engine: holds one entry (or none) and answers from
 * a function the test scripts. It records every request it was given.
 */
export class FixtureInBrowserPort implements InBrowserEnginePort {
  readonly requests: InBrowserCompletionRequest[] = [];
  busy = false;

  constructor(
    public loaded: string | null,
    private readonly answer: (request: InBrowserCompletionRequest, signal: AbortSignal) => InBrowserCompletion | Promise<InBrowserCompletion>,
  ) {}

  async status(): Promise<InBrowserEngineStatus> {
    return { loaded: this.loaded, busy: this.busy };
  }

  async complete(request: InBrowserCompletionRequest, signal: AbortSignal): Promise<InBrowserCompletion> {
    if (this.loaded !== request.entry) throw new AdapterError("model_unavailable", "The fixture engine holds no such model");
    this.requests.push(request);
    this.busy = true;
    try {
      return await this.answer(request, signal);
    } finally {
      this.busy = false;
    }
  }
}

/** The port a host without an engine provides: nothing loaded, every completion refused. */
export class UnavailableInBrowserPort implements InBrowserEnginePort {
  async status(): Promise<InBrowserEngineStatus> {
    return { loaded: null, busy: false };
  }

  async complete(): Promise<InBrowserCompletion> {
    throw new AdapterError("model_unavailable", "This host runs no in-browser engine");
  }
}
