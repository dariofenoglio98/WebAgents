/**
 * The provider adapters over a scripted transport: the exact request each one sends (URL,
 * method, headers, body), how it reads success, truncation, refusal and errors, that a key
 * never reaches a fact or a message, and that the URL policy holds.
 */
import { describe, expect, it } from "vitest";

import type { JsonObject } from "../../../src/core/json.js";
import { AnthropicAdapter } from "../../../src/core/models/adapters/anthropic.js";
import { ChromeBuiltinAdapter, UnavailableBuiltinPort } from "../../../src/core/models/adapters/chrome-builtin.js";
import { OllamaAdapter } from "../../../src/core/models/adapters/ollama.js";
import { OpenAIAdapter } from "../../../src/core/models/adapters/openai.js";
import { providerBaseUrl } from "../../../src/core/models/adapters/shared.js";
import { adapterFor } from "../../../src/core/models/providers.js";
import { normalizeModelBinding } from "../../../src/core/models/binding.js";
import { render } from "../../../src/core/models/render.js";
import { ANTHROPIC_RULES, constraintSchema, inlineRootRef, OLLAMA_RULES, OPENAI_RULES } from "../../../src/core/models/schema-format.js";
import type { HttpRequest, HttpTransport, OutboundModelRequest } from "../../../src/core/models/transport.js";
import { AdapterError, CancelledError } from "../../../src/core/workflow/errors.js";

const SCHEMA: JsonObject = {
  $ref: "#/$defs/s0",
  $defs: {
    s0: {
      type: "object",
      additionalProperties: false,
      required: ["focus", "count"],
      properties: { focus: { type: "string", minLength: 1, maxLength: 40 }, count: { type: "integer", minimum: 0 }, tags: { type: "array", items: { $ref: "#/$defs/s1" } } },
    },
    s1: { type: "object", properties: { name: { type: "string" } } },
  },
};

const RENDERED = render({
  task: "plan",
  instructions: ["Be brief."],
  data: { goal: "x" },
  output_schema: SCHEMA,
  requirements: { id: "plan", capabilities: ["structured_output"], context_window: 16000, preferred_tier: "reasoning" },
  budget_context: { max_output_tokens: 100 },
  audit_context: { worker: "W:1", node_id: "plan" },
});

function scripted(answer: (request: HttpRequest) => { status: number; body: unknown }): { transport: HttpTransport; requests: HttpRequest[]; observed: OutboundModelRequest[] } {
  const requests: HttpRequest[] = [];
  const observed: OutboundModelRequest[] = [];
  const transport: HttpTransport = async (request) => {
    requests.push(request);
    if (request.signal.aborted) throw request.signal.reason;
    const { status, body } = answer(request);
    return { status, headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
  };
  return { transport, requests, observed };
}

describe("constraint schemas", () => {
  it("inlines a one-hop root reference and keeps the $defs namespace", () => {
    const rooted = inlineRootRef(SCHEMA);
    expect(rooted.type).toBe("object");
    expect(rooted.$ref).toBeUndefined();
    expect(Object.keys(rooted.$defs as JsonObject)).toEqual(["s0", "s1"]);
  });

  it("drops the bounds Anthropic refuses and closes every object; leaves Ollama's copy as declared", () => {
    const anthropic = constraintSchema(SCHEMA, ANTHROPIC_RULES)!;
    const focus = (anthropic.properties as JsonObject).focus as JsonObject;
    expect(focus.minLength).toBeUndefined();
    expect(((anthropic.properties as JsonObject).count as JsonObject).minimum).toBeUndefined();
    expect(((anthropic.$defs as JsonObject).s1 as JsonObject).additionalProperties).toBe(false);
    const ollama = constraintSchema(SCHEMA, OLLAMA_RULES)!;
    expect(((ollama.properties as JsonObject).focus as JsonObject).minLength).toBe(1);
    expect(((ollama.$defs as JsonObject).s1 as JsonObject).additionalProperties).toBeUndefined();
    // A property literally named like a keyword is a name, not a keyword.
    const named = constraintSchema({ type: "object", properties: { minimum: { type: "string" } } }, ANTHROPIC_RULES)!;
    expect(Object.keys(named.properties as JsonObject)).toEqual(["minimum"]);
  });

  it("returns null for roots a provider cannot constrain", () => {
    expect(constraintSchema({ type: "string" }, OLLAMA_RULES)).toBeNull();
    expect(constraintSchema({ type: "array", items: { type: "string" } }, OPENAI_RULES)).toBeNull();
    expect(constraintSchema({ type: "array", items: { type: "string" } }, OLLAMA_RULES)).not.toBeNull();
    expect(constraintSchema(true, OLLAMA_RULES)).toBeNull();
  });
});

describe("provider base URLs", () => {
  it("accepts https origins, loopback http only where allowed, and refuses the rest", () => {
    expect(providerBaseUrl("https://api.openai.com/", { allowLoopbackHttp: false })).toBe("https://api.openai.com");
    expect(providerBaseUrl("http://127.0.0.1:11434", { allowLoopbackHttp: true })).toBe("http://127.0.0.1:11434");
    expect(providerBaseUrl("http://localhost:11434/", { allowLoopbackHttp: true })).toBe("http://localhost:11434");
    for (const [url, loopback] of [
      ["http://api.openai.com", false],
      ["http://10.0.0.5:11434", true],
      ["https://user:pw@api.example", false],
      ["https://api.example/?q=1", false],
      ["ftp://api.example", false],
      ["not a url", false],
    ] as const) {
      expect(() => providerBaseUrl(url, { allowLoopbackHttp: loopback }), url).toThrow(AdapterError);
    }
  });
});

describe("OllamaAdapter", () => {
  it("sends the native chat request with format, num_ctx, num_predict and think off, and reads the answer", async () => {
    const net = scripted(() => ({ status: 200, body: { model: "qwen3:30b", message: { role: "assistant", content: '{"focus":"ok","count":1}' }, done: true, done_reason: "stop", prompt_eval_count: 120, eval_count: 9 } }));
    const adapter = new OllamaAdapter({ transport: net.transport, observer: (request) => net.observed.push(request), model: "qwen3:30b", contextWindow: 65536 });
    expect(adapter.remote).toBe(false);
    expect(adapter.host_model_id).toBe("ollama/qwen3:30b");
    const answer = await adapter.complete(RENDERED, 100, new AbortController().signal);
    const request = net.requests[0]!;
    expect(request.url).toBe("http://127.0.0.1:11434/api/chat");
    expect(request.method).toBe("POST");
    const body = JSON.parse(request.body!) as JsonObject;
    expect(body.model).toBe("qwen3:30b");
    expect(body.stream).toBe(false);
    expect(body.think).toBe(false);
    expect(body.options).toEqual({ num_ctx: 65536, num_predict: 100 });
    expect((body.messages as JsonObject[]).map((message) => message.role)).toEqual(["system", "user"]);
    expect((body.messages as JsonObject[])[0]!.content).toBe(RENDERED.system);
    expect((body.format as JsonObject).type).toBe("object");
    expect(answer).toMatchObject({ text: '{"focus":"ok","count":1}', model_id: "ollama/qwen3:30b", stop_reason: "stop", constrained: true });
    expect(answer.usage).toMatchObject({ input_tokens: 120, output_tokens: 9 });
    expect(net.observed[0]!.provider_id).toBe("ollama");
    expect(net.observed[0]!.body).toBe(request.body);
  });

  it("maps length, treats a non-200 as a provider error with the status as a fact, and honours think", async () => {
    const net = scripted((request) => (request.body!.includes('"think":true') ? { status: 200, body: { model: "m", message: { content: "x" }, done: true, done_reason: "length", prompt_eval_count: 1, eval_count: 100 } } : { status: 500, body: { error: "boom" } }));
    const thinking = new OllamaAdapter({ transport: net.transport, model: "m", contextWindow: 4096, think: true });
    expect((await thinking.complete(RENDERED, 10, new AbortController().signal)).stop_reason).toBe("length");
    const plain = new OllamaAdapter({ transport: net.transport, model: "m", contextWindow: 4096 });
    await expect(plain.complete(RENDERED, 10, new AbortController().signal)).rejects.toMatchObject({ code: "model_provider_error", audit_facts: { stage: "status", http_status: 500 } });
  });

  it("stops when the signal aborts and reports a remote https Ollama as remote", async () => {
    const net = scripted(() => ({ status: 200, body: {} }));
    const adapter = new OllamaAdapter({ transport: net.transport, model: "m", contextWindow: 4096 });
    const controller = new AbortController();
    controller.abort(new CancelledError());
    await expect(adapter.complete(RENDERED, 10, controller.signal)).rejects.toBeInstanceOf(CancelledError);
    expect(net.requests).toHaveLength(0);
    const remote = new OllamaAdapter({ transport: net.transport, model: "m", contextWindow: 4096, baseUrl: "https://ollama.example.org" });
    expect(remote.remote).toBe(true);
    expect(remote.domains).toEqual(["ollama.example.org"]);
  });
});

describe("OpenAIAdapter", () => {
  it("sends a Responses API request with the key only in the header, and reads output_text and usage", async () => {
    const net = scripted(() => ({
      status: 200,
      body: {
        id: "resp_1",
        status: "completed",
        model: "gpt-5.6-luna-2026-05-01",
        output: [
          { type: "reasoning", summary: [] },
          { type: "message", role: "assistant", content: [{ type: "output_text", text: '{"focus":"ok","count":2}' }] },
        ],
        usage: { input_tokens: 300, input_tokens_details: { cached_tokens: 100 }, output_tokens: 40, output_tokens_details: { reasoning_tokens: 30 }, total_tokens: 340 },
      },
    }));
    const adapter = new OpenAIAdapter({ transport: net.transport, model: "gpt-5.6-luna", apiKey: "sk-test-secret", contextWindow: 272000, reasoning: true });
    const answer = await adapter.complete(RENDERED, 100, new AbortController().signal);
    const request = net.requests[0]!;
    expect(request.url).toBe("https://api.openai.com/v1/responses");
    expect(request.headers.authorization).toBe("Bearer sk-test-secret");
    const body = JSON.parse(request.body!) as JsonObject;
    expect(body.model).toBe("gpt-5.6-luna");
    expect(body.instructions).toBe(RENDERED.system);
    expect(body.input).toBe(RENDERED.user);
    expect(body.max_output_tokens).toBe(100);
    expect(body.store).toBe(false);
    expect(((body.text as JsonObject).format as JsonObject)).toMatchObject({ type: "json_schema", name: "agentpkg_node_output", strict: false });
    expect(body.reasoning).toEqual({ effort: "low" });
    expect(request.body).not.toContain("sk-test-secret");
    expect(answer).toMatchObject({ text: '{"focus":"ok","count":2}', model_id: "openai/gpt-5.6-luna-2026-05-01", response_model: "gpt-5.6-luna-2026-05-01", stop_reason: "stop" });
    expect(answer.usage).toMatchObject({ input_tokens: 300, output_tokens: 40, total_tokens: 340, cache_read_tokens: null });
  });

  it("maps incomplete and refusal answers, and never puts the key in a refusal", async () => {
    const answers: Record<string, unknown> = {
      incomplete: { status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, model: "m", output: [{ type: "message", content: [{ type: "output_text", text: "{" }] }], usage: { input_tokens: 1, output_tokens: 2 } },
      refusal: { status: "completed", model: "m", output: [{ type: "message", content: [{ type: "refusal", refusal: "no" }] }], usage: { input_tokens: 1, output_tokens: 2 } },
      failed: { status: "failed", model: "m", error: { code: "server_error", message: "x" }, output: [] },
    };
    let which = "incomplete";
    const net = scripted(() => ({ status: 200, body: answers[which] }));
    const adapter = new OpenAIAdapter({ transport: net.transport, model: "m", apiKey: "sk-secret", contextWindow: 10000 });
    expect((await adapter.complete(RENDERED, 10, new AbortController().signal)).stop_reason).toBe("length");
    which = "refusal";
    const refused = await adapter.complete(RENDERED, 10, new AbortController().signal);
    expect(refused.stop_reason).toBe("refusal");
    expect(refused.text).toBeNull();
    which = "failed";
    expect((await adapter.complete(RENDERED, 10, new AbortController().signal)).stop_reason).toBe("failed");
    const denied = scripted(() => ({ status: 401, body: { error: { type: "invalid_request_error", message: "Incorrect API key provided: sk-secret" } } }));
    const unauthorized = new OpenAIAdapter({ transport: denied.transport, model: "m", apiKey: "sk-secret", contextWindow: 10000 });
    try {
      await unauthorized.complete(RENDERED, 10, new AbortController().signal);
      expect.unreachable();
    } catch (error) {
      const failure = error as AdapterError;
      expect(failure.code).toBe("model_provider_error");
      expect(failure.audit_facts).toEqual({ stage: "status", http_status: 401, provider_error_type: "invalid_request_error" });
      expect(JSON.stringify({ message: failure.message, facts: failure.audit_facts })).not.toContain("sk-secret");
    }
  });

  it("refuses to exist without a usable key and rate limits carry their own code", async () => {
    expect(() => new OpenAIAdapter({ transport: async () => ({ status: 200, headers: {}, body: "{}" }), model: "m", apiKey: "", contextWindow: 10 })).toThrow(/OpenAI API key/u);
    const limited = scripted(() => ({ status: 429, body: {} }));
    const adapter = new OpenAIAdapter({ transport: limited.transport, model: "m", apiKey: "k", contextWindow: 10000 });
    await expect(adapter.complete(RENDERED, 10, new AbortController().signal)).rejects.toMatchObject({ code: "model_rate_limited" });
  });
});

describe("AnthropicAdapter", () => {
  it("sends a Messages API request with version, key and browser-access headers, output_config and effort", async () => {
    const net = scripted(() => ({
      status: 200,
      body: { id: "msg_1", model: "claude-opus-5-5", stop_reason: "end_turn", content: [{ type: "thinking", thinking: "" }, { type: "text", text: '{"focus":"ok","count":3}' }], usage: { input_tokens: 200, output_tokens: 50, cache_creation_input_tokens: 10, cache_read_input_tokens: 20 } },
    }));
    const adapter = new AnthropicAdapter({ transport: net.transport, model: "claude-opus-5-5", apiKey: "sk-ant-secret", contextWindow: 1_000_000 });
    const answer = await adapter.complete(RENDERED, 100, new AbortController().signal);
    const request = net.requests[0]!;
    expect(request.url).toBe("https://api.anthropic.com/v1/messages");
    expect(request.headers).toMatchObject({ "x-api-key": "sk-ant-secret", "anthropic-version": "2023-06-01", "anthropic-dangerous-direct-browser-access": "true" });
    const body = JSON.parse(request.body!) as JsonObject;
    expect(body.model).toBe("claude-opus-5-5");
    expect(body.max_tokens).toBe(100);
    expect(body.system).toBe(RENDERED.system);
    expect(body.messages).toEqual([{ role: "user", content: RENDERED.user }]);
    expect((body.output_config as JsonObject).effort).toBe("low");
    expect(((body.output_config as JsonObject).format as JsonObject).type).toBe("json_schema");
    expect(body.thinking).toBeUndefined();
    expect(request.body).not.toContain("sk-ant-secret");
    expect(answer).toMatchObject({ text: '{"focus":"ok","count":3}', model_id: "anthropic/claude-opus-5-5", stop_reason: "stop" });
    expect(answer.usage).toMatchObject({ input_tokens: 200, output_tokens: 50, cache_read_tokens: 20, cache_write_tokens: 10 });
  });

  it("maps max_tokens to length and refusal to an unfinished turn", async () => {
    let stop = "max_tokens";
    const net = scripted(() => ({ status: 200, body: { model: "m", stop_reason: stop, content: [{ type: "text", text: "{" }], usage: { input_tokens: 1, output_tokens: 2 } } }));
    const adapter = new AnthropicAdapter({ transport: net.transport, model: "m", apiKey: "k", contextWindow: 10000 });
    expect((await adapter.complete(RENDERED, 10, new AbortController().signal)).stop_reason).toBe("length");
    stop = "refusal";
    expect((await adapter.complete(RENDERED, 10, new AbortController().signal)).stop_reason).toBe("refusal");
    stop = "stop_sequence";
    expect((await adapter.complete(RENDERED, 10, new AbortController().signal)).stop_reason).toBe("stop");
  });
});

describe("the built-in model contract and the provider factory", () => {
  it("the Node stub is unavailable and refuses to complete", async () => {
    const port = new UnavailableBuiltinPort();
    expect(await port.availability()).toBe("unavailable");
    const adapter = new ChromeBuiltinAdapter(port, 4096);
    await expect(adapter.complete(RENDERED, 10, new AbortController().signal)).rejects.toMatchObject({ code: "model_unavailable" });
  });

  it("builds the adapter the binding names, from host settings the binding does not carry", () => {
    const transport: HttpTransport = async () => ({ status: 200, headers: {}, body: "{}" });
    const binding = (provider: string, model: string) =>
      normalizeModelBinding({ host_model_id: `${provider}/${model}`, provider_id: provider, model_id: model, limits: { context_tokens: 32768 }, properties: { local: provider === "ollama" }, capabilities: { reasoning: { value: true, basis: "declared" } } });
    const ollama = adapterFor(binding("ollama", "qwen3:30b"), { transport, ollama: { baseUrl: "http://localhost:11434" } });
    expect(ollama).toBeInstanceOf(OllamaAdapter);
    expect(ollama.reasoning).toBe(true);
    expect(adapterFor(binding("openai", "gpt-5.6-luna"), { transport, openai: { apiKey: "k" } })).toBeInstanceOf(OpenAIAdapter);
    expect(adapterFor(binding("anthropic", "claude-opus-5-5"), { transport, anthropic: { apiKey: "k" } })).toBeInstanceOf(AnthropicAdapter);
    expect(() => adapterFor(binding("openai", "m"), { transport })).toThrow(/OpenAI API key/u);
    expect(() => adapterFor(binding("chrome-builtin", "gemini-nano"), { transport })).toThrow(/built-in model port/u);
    expect(adapterFor(binding("chrome-builtin", "gemini-nano"), { transport, builtin: new UnavailableBuiltinPort() })).toBeInstanceOf(ChromeBuiltinAdapter);
    expect(() => adapterFor(binding("mystery", "m"), { transport })).toThrow(/No adapter/u);
  });
});
