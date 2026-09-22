/**
 * What this plugin asks OpenClaw for, and what it refuses to accept back.
 *
 * `api.runtime.llm.complete` is stubbed with the exact shape OpenClaw 2026.9.5
 * returns, so the suite is deterministic and never spends a token. The real
 * call is exercised by `scripts/router-probe.mjs` against a live host.
 */
import { describe, expect, it, vi } from "vitest";
import { AgentBrowserError } from "../src/errors.js";
import {
  MAX_RESPONSE_FORMAT_BYTES,
  RESPONSE_FORMAT_NAME,
  asCompletionError,
  completeWithBoundModel,
  responseFormatFor,
  type HostLlm,
} from "../src/host-llm.js";

const SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  required: ["status"],
  properties: { status: { const: "ok" } },
  additionalProperties: false,
};

function llm(
  result: Partial<Parameters<HostLlm["complete"]> extends never ? never : never> | unknown = {},
  fail?: unknown,
): { host: HostLlm; calls: Array<Record<string, unknown>> } {
  const calls: Array<Record<string, unknown>> = [];
  const host: HostLlm = {
    complete: async (params) => {
      calls.push(params as unknown as Record<string, unknown>);
      if (fail) throw fail;
      return {
        text: '{"status":"ok"}',
        provider: "acme",
        model: "big",
        responseModel: "big-2026-09-01",
        stopReason: "stop",
        usage: { inputTokens: 120, outputTokens: 8, totalTokens: 128, costUsd: 0.0004 },
        execution: { mode: "direct-provider", owner: { kind: "provider", id: "acme" } },
        ...(result as object),
      };
    },
  };
  return { host, calls };
}

describe("constrained output requests", () => {
  it("maps an object schema onto OpenClaw's json_schema request shape", () => {
    const mapped = responseFormatFor(SCHEMA);
    expect(mapped?.format).toMatchObject({ type: "json_schema" });
    const json = (mapped?.format as { json_schema: Record<string, unknown> }).json_schema;
    expect(json.name).toBe(RESPONSE_FORMAT_NAME);
    // Root annotations a provider's format parser has no use for are dropped;
    // the constraint itself is preserved exactly.
    expect(json.schema).toEqual({
      type: "object",
      required: ["status"],
      properties: { status: { const: "ok" } },
      additionalProperties: false,
    });
  });

  it("declines rather than inventing a constraint it cannot express", () => {
    expect(responseFormatFor({ type: "array", items: { type: "string" } })).toBeNull();
    expect(responseFormatFor(true)).toBeNull();
    expect(responseFormatFor(undefined)).toBeNull();
    const huge = {
      type: "object",
      properties: Object.fromEntries(
        Array.from({ length: 20_000 }, (_, index) => [`field${index}`, { type: "string" }]),
      ),
    };
    expect(JSON.stringify(huge).length).toBeGreaterThan(MAX_RESPONSE_FORMAT_BYTES);
    expect(responseFormatFor(huge)).toBeNull();
  });

  it("reports honestly when a request could not be constrained", async () => {
    const { host } = llm();
    const outcome = await completeWithBoundModel(host, {
      modelId: "acme/big",
      system: "s",
      user: "u",
      outputSchema: { type: "array" },
      maxOutputTokens: 64,
    });
    expect(outcome.constrained).toBe(false);
    expect(outcome.constraintDetail).toContain("parses and");
  });
});

describe("exact model binding", () => {
  it("always names the bound model and passes the cap and schema through", async () => {
    const { host, calls } = llm();
    await completeWithBoundModel(host, {
      modelId: "acme/big",
      system: "system text",
      user: "user text",
      outputSchema: SCHEMA,
      maxOutputTokens: 256,
      reasoning: "low",
    });
    expect(calls[0]).toMatchObject({
      model: "acme/big",
      systemPrompt: "system text",
      maxTokens: 256,
      reasoning: "low",
      purpose: "agent-browser.router",
    });
    expect(calls[0].messages).toEqual([{ role: "user", content: "user text" }]);
    expect(calls[0].responseFormat).toMatchObject({ type: "json_schema" });
  });

  it("refuses a completion that came from a different model", async () => {
    const { host } = llm({ provider: "acme", model: "small" });
    await expect(
      completeWithBoundModel(host, {
        modelId: "acme/big",
        system: "s",
        user: "u",
        outputSchema: SCHEMA,
        maxOutputTokens: 64,
      }),
    ).rejects.toMatchObject({ code: "selected_model_unavailable" });
  });

  it("propagates cancellation into the host call", async () => {
    const { host, calls } = llm();
    const controller = new AbortController();
    await completeWithBoundModel(host, {
      modelId: "acme/big",
      system: "s",
      user: "u",
      outputSchema: SCHEMA,
      maxOutputTokens: 64,
      signal: controller.signal,
    });
    expect(calls[0].signal).toBe(controller.signal);
  });
});

describe("usage", () => {
  it("passes every token bucket the host reported to the router", async () => {
    const { host } = llm({
      usage: {
        inputTokens: 100,
        outputTokens: 10,
        cacheReadTokens: 40,
        cacheWriteTokens: 5,
        totalTokens: 160,
        costUsd: 0.002,
      },
    });
    const outcome = await completeWithBoundModel(host, {
      modelId: "acme/big",
      system: "s",
      user: "u",
      outputSchema: SCHEMA,
      maxOutputTokens: 64,
    });
    expect(outcome.usage).toEqual({
      input_tokens: 100,
      output_tokens: 10,
      cache_read_tokens: 40,
      cache_write_tokens: 5,
      total_tokens: 160,
      cost_usd: 0.002,
    });
    expect(outcome.responseModel).toBe("big-2026-09-01");
    expect(outcome.stopReason).toBe("stop");
    expect(outcome.execution).toEqual({ mode: "direct-provider", owner: "acme" });
  });

  it("reports an absent bucket as null rather than zero", async () => {
    const { host } = llm({ usage: { inputTokens: 9 } });
    const outcome = await completeWithBoundModel(host, {
      modelId: "acme/big",
      system: "s",
      user: "u",
      outputSchema: SCHEMA,
      maxOutputTokens: 64,
    });
    expect(outcome.usage.output_tokens).toBeNull();
    expect(outcome.usage.cost_usd).toBeNull();
  });
});

describe("failures", () => {
  it("names the operator opt-in an unauthorized model override needs", () => {
    const error = asCompletionError(
      Object.assign(new Error("cannot override the target model"), {
        code: "LLM_COMPLETION_NOT_AUTHORIZED",
      }),
    );
    expect(error).toBeInstanceOf(AgentBrowserError);
    expect(error.code).toBe("model_call_not_authorized");
    expect(error.detail).toContain("allowModelOverride");
  });

  it("maps the host's stable completion codes onto stable browser codes", () => {
    const cases: Array<[string, string]> = [
      ["LLM_COMPLETION_ABORTED", "model_call_cancelled"],
      ["LLM_COMPLETION_TIMEOUT", "model_call_failed"],
      ["LLM_RUNTIME_UNAVAILABLE", "model_call_failed"],
      ["LLM_COMPLETION_FAILED", "model_call_failed"],
      ["something-new", "model_call_failed"],
    ];
    for (const [code, expected] of cases) {
      expect(asCompletionError(Object.assign(new Error("x"), { code })).code).toBe(expected);
    }
  });

  it("never lets a raw provider error escape", async () => {
    const { host } = llm({}, new Error("api.openai.example returned 401 for key sk-live-…"));
    const failure = await completeWithBoundModel(host, {
      modelId: "acme/big",
      system: "s",
      user: "u",
      outputSchema: SCHEMA,
      maxOutputTokens: 64,
    }).catch((error) => error as AgentBrowserError);
    expect(failure).toBeInstanceOf(AgentBrowserError);
    expect(failure.code).toBe("model_call_failed");
    // The view the page receives is bounded and typed; it carries no stack.
    expect(failure.view().retryable).toBe(true);
  });
});

describe("no other surface is used", () => {
  it("calls exactly one host method per completion", async () => {
    const complete = vi.fn(async () => ({
      text: "{}",
      provider: "acme",
      model: "big",
      usage: { inputTokens: 1, outputTokens: 1 },
    }));
    await completeWithBoundModel({ complete } as unknown as HostLlm, {
      modelId: "acme/big",
      system: "s",
      user: "u",
      outputSchema: SCHEMA,
      maxOutputTokens: 8,
    });
    expect(complete).toHaveBeenCalledTimes(1);
  });
});
