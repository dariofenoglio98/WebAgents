/**
 * A `ModelRouter` whose intelligence is the exact model a Run Plan bound (D-023, D-062): the
 * port of `agentpkg.hostbridge.router.HostBridgeModelRouter` over a `ProviderAdapter` instead
 * of a bridge peer.
 *
 * **Exact model binding.** The router carries one host model id and asks its adapter for that
 * model and no other; after a completion it compares the model the provider reports with the
 * binding and fails closed (`selected_model_unavailable`) rather than return output from a
 * model the person did not choose. A dated snapshot of the bound id (`<id>-YYYY-MM-DD` or a
 * numeric suffix) is the same model; anything else is not.
 *
 * **Capabilities are what this adapter delivers.** `structured_output` is declared because the
 * router requests a constrained response, then parses and schema-validates before returning,
 * in one bounded attempt. `reasoning` is declared only when the binding's descriptor declares
 * it. `tool_use` and `multimodal` are never declared.
 *
 * **`countTokens` is a safe upper bound** (`tokens <= utf8_bytes`, plus a fixed framing
 * allowance), because the runtime reserves against it and treats a reported input above it as
 * a fatal contract violation. No browser-side tokenizer exists for the three providers, and an
 * estimate is not a bound.
 *
 * **Usage is actual and complete** or the call fails (`usage.ts`); cost is only ever computed
 * from catalog prices the binding carries, never estimated.
 */
import type { JsonValue } from "../json.js";
import { failuresForSchema } from "../schema.js";
import { AdapterError, CancelledError } from "../workflow/errors.js";
import type { ModelRequest, ModelResult, ModelRouter } from "./contract.js";
import { render, tokenUpperBound, type RenderedRequest } from "./render.js";
import { classifyTermination, parseStructured, type ParseMode } from "./structured.js";
import { priceUsage, projectUsage, type ModelPricing, type ProjectedUsage, type UsageReport } from "./usage.js";

export const ROUTER_ID = "chrome-agent-browser.bound-router.v0";
export const CAPABILITY_STRUCTURED_OUTPUT = "structured_output";
export const CAPABILITY_REASONING = "reasoning";
export const MAX_RECORDED_INVOCATIONS = 512;
export const DEFAULT_REQUEST_TIMEOUT_SECONDS = 300;
const MAX_SCHEMA_LOCATION_PARTS = 8;

/** What a provider adapter answers for one completion. */
export interface ProviderCompletion {
  /** The answer text, or null when the provider returned none. */
  text: string | null;
  /** The model the provider says answered, as a host model id (`provider/model`). */
  model_id: string | null;
  /** The provider's own model string, for evidence. */
  response_model: string | null;
  /** Normalized: `stop`, `length`, or the provider's word for an unfinished turn. */
  stop_reason: string | null;
  usage: UsageReport | null;
  /** Whether a provider-native output constraint was sent with the request. */
  constrained: boolean;
  constraint_detail: string;
}

/**
 * One provider for one bound model. It builds the request, sends it through the injected
 * transport and reads the answer; it decides nothing about accounting or conformance.
 */
export interface ProviderAdapter {
  readonly provider_id: string;
  readonly model_id: string;
  readonly host_model_id: string;
  readonly remote: boolean;
  readonly reasoning: boolean;
  readonly context_window: number;
  readonly domains: readonly string[];
  readonly pricing: ModelPricing | null;
  complete(rendered: RenderedRequest, maxOutputTokens: number, signal: AbortSignal): Promise<ProviderCompletion>;
}

/** The structural facts a failed completion certifies for the audit; never text the model wrote. */
function reportedCounts(usage: UsageReport | null): Record<string, JsonValue> {
  try {
    const projected = projectUsage(usage);
    return { reported_input_tokens: projected.input_tokens, reported_output_tokens: projected.output_tokens };
  } catch {
    return {};
  }
}

/** Whether `invoked` names the bound model: equal, or a dated/numbered snapshot of it. */
export function sameModel(bound: string, invoked: string | null): boolean {
  if (invoked === null) return false;
  if (invoked === bound) return true;
  return invoked.startsWith(`${bound}-`) && /^[0-9][0-9-]*$/u.test(invoked.slice(bound.length + 1));
}

export interface BoundModelRouterOptions {
  requestTimeoutSeconds?: number;
}

export interface ModelInvocation {
  model_id: string | null;
  provider_id: string;
  response_model: string | null;
  constrained_by_host: boolean;
  count_basis: string | null;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number | null;
}

/** `{thinking}` when the adapter states whether it asks the model to think (Ollama), else nothing. */
function thinkingOf(adapter: ProviderAdapter): { thinking?: boolean } {
  const thinking = (adapter as unknown as { thinking?: unknown }).thinking;
  return typeof thinking === "boolean" ? { thinking } : {};
}

export class BoundModelRouter implements ModelRouter {
  readonly router_id = ROUTER_ID;
  readonly model_id: string;
  readonly provider_id: string;
  readonly remote: boolean;
  readonly capabilities: ReadonlySet<string>;
  readonly context_window: number;
  readonly domains: readonly string[];
  readonly timeout: number;
  /** Evidence for a probe or run report; never used to decide anything. */
  lastCount: Record<string, JsonValue> | null = null;
  lastCompletion: Record<string, JsonValue> | null = null;
  readonly invocations: ModelInvocation[] = [];

  constructor(
    readonly adapter: ProviderAdapter,
    options: BoundModelRouterOptions = {},
  ) {
    this.model_id = adapter.host_model_id;
    this.provider_id = adapter.provider_id;
    this.remote = adapter.remote;
    const capabilities = new Set([CAPABILITY_STRUCTURED_OUTPUT]);
    if (adapter.reasoning) capabilities.add(CAPABILITY_REASONING);
    this.capabilities = capabilities;
    if (!Number.isInteger(adapter.context_window) || adapter.context_window < 1) {
      throw new AdapterError("model_context_window_unknown", "The host reports no context window for the selected model, so no request can be bounded against it");
    }
    this.context_window = adapter.context_window;
    this.domains = [...adapter.domains];
    this.timeout = options.requestTimeoutSeconds ?? DEFAULT_REQUEST_TIMEOUT_SECONDS;
  }

  describe(): Record<string, JsonValue> {
    return {
      router_id: this.router_id,
      model_id: this.model_id,
      provider_id: this.provider_id,
      remote: this.remote,
      capabilities: [...this.capabilities].sort(),
      context_window: this.context_window,
      // A provider option the host chose for the run, recorded so the evidence says it (T6).
      ...thinkingOf(this.adapter),
      not_declared: ["multimodal", "tool_use"],
      note:
        "Capabilities describe what this adapter delivers. tool_use is withheld because the adapter exposes no tools to the model, and multimodal because it sends text only.",
    };
  }

  async countTokens(request: ModelRequest, _signal?: AbortSignal): Promise<number> {
    const rendered = render(request);
    const bound = tokenUpperBound(rendered);
    this.lastCount = {
      bound,
      basis: "utf8_upper_bound",
      host_tokenizer: false,
      framing_allowance: tokenUpperBound({ system: "", user: "", output_schema: true, schema_text: "" }),
      counted_bytes: {
        system: new TextEncoder().encode(rendered.system).length,
        user: new TextEncoder().encode(rendered.user).length,
        output_schema: new TextEncoder().encode(rendered.schema_text).length,
      },
    };
    return bound;
  }

  async complete(request: ModelRequest, maxOutputTokens: number, signal: AbortSignal): Promise<ModelResult> {
    if (!Number.isInteger(maxOutputTokens)) throw new AdapterError("model_request_invalid", "max_output_tokens must be an integer");
    if (maxOutputTokens <= 0) throw new AdapterError("model_request_invalid", "max_output_tokens must be positive");
    const rendered = render(request);
    const answer = await this.bounded(rendered, maxOutputTokens, signal);
    if (!sameModel(this.model_id, answer.model_id)) {
      // The plan bound one model. Anything else is not a degraded result, it is a different
      // decision, refused after the fact just as it would have been before.
      throw new AdapterError("selected_model_unavailable", "The host completed with a model other than the one the run plan bound", {
        detail: { expected: this.model_id, invoked: answer.model_id },
      });
    }
    const facts: Record<string, JsonValue> = {
      stop_reason: answer.stop_reason ?? "unreported",
      ...reportedCounts(answer.usage),
    };
    const termination = classifyTermination(answer.stop_reason);
    if (termination !== null) throw new AdapterError(termination[0], termination[1], { audit_facts: facts });
    if (typeof answer.text !== "string") {
      throw new AdapterError("model_output_not_conforming", "The host returned no text", { audit_facts: { ...facts, output_failure: "no_text" } });
    }
    const usage = projectUsage(answer.usage);
    let output: JsonValue;
    let parseMode: ParseMode;
    try {
      [output, parseMode] = parseStructured(answer.text);
    } catch (error) {
      if (error instanceof AdapterError) error.audit_facts = { ...facts, output_failure: "not_json" };
      throw error;
    }
    const failures = await failuresForSchema(rendered.output_schema, output, "model output");
    if (failures.length > 0) {
      const first = failures[0]!;
      throw new AdapterError("model_output_not_conforming", "The model output does not satisfy the requested schema", {
        audit_facts: {
          ...facts,
          output_failure: "schema",
          schema_keyword: first.keyword,
          schema_location: schemaLocation(first.keywordLocation),
          schema_violations: failures.length,
        },
      });
    }
    const cost = usage.cost_usd ?? priceUsage(usage, this.adapter.pricing);
    this.lastCompletion = {
      model_id: answer.model_id,
      provider_id: this.provider_id,
      response_model: answer.response_model,
      stop_reason: answer.stop_reason,
      constrained_by_host: answer.constrained,
      constraint_detail: answer.constraint_detail,
      parse: parseMode,
      max_output_tokens: maxOutputTokens,
      usage: { input_tokens: usage.input_tokens, output_tokens: usage.output_tokens, cost_usd: cost, reported: usage.reported },
    };
    if (this.invocations.length < MAX_RECORDED_INVOCATIONS) {
      this.invocations.push({
        model_id: answer.model_id,
        provider_id: this.provider_id,
        response_model: answer.response_model,
        constrained_by_host: answer.constrained,
        count_basis: (this.lastCount?.basis as string | undefined) ?? null,
        input_tokens: usage.input_tokens,
        output_tokens: usage.output_tokens,
        cost_usd: cost,
      });
    }
    const result: ModelResult = { output, input_tokens: usage.input_tokens, output_tokens: usage.output_tokens };
    if (cost !== null) result.cost_usd = cost;
    return result;
  }

  /** One completion under the host's per-call deadline; the deadline aborts the provider request. */
  private async bounded(rendered: RenderedRequest, maxOutputTokens: number, signal: AbortSignal): Promise<ProviderCompletion> {
    if (signal.aborted) throw (signal.reason as Error | undefined) ?? new CancelledError();
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort(new AdapterError("model_call_timeout", "The model did not answer within the host's per-call deadline", { audit_facts: { stage: "timeout", timeout: true } }));
    }, this.timeout * 1000);
    const onAbort = () => controller.abort(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      return await this.adapter.complete(rendered, maxOutputTokens, controller.signal);
    } catch (error) {
      if (timedOut) throw controller.signal.reason as Error;
      if (signal.aborted) throw (signal.reason as Error | undefined) ?? new CancelledError();
      throw error;
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
    }
  }
}

/** Where in the *schema* validation failed, never where in the output. */
function schemaLocation(keywordLocation: string): string {
  const hash = keywordLocation.indexOf("#");
  const fragment = hash >= 0 ? keywordLocation.slice(hash + 1) : keywordLocation;
  const parts = fragment.split("/").filter(Boolean).slice(-MAX_SCHEMA_LOCATION_PARTS);
  return parts.join("/") || "#";
}

export type { ProjectedUsage };
