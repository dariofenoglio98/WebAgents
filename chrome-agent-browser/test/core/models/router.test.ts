/**
 * The bound router against the reference's own vectors (`hostbridge/router.py`): rendering,
 * the UTF-8 token bound, closed-root property lists, bounded parsing, termination
 * classification and usage projection; then the router's conduct over a scripted adapter.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { JsonObject, JsonValue } from "../../../src/core/json.js";
import { contextWindowFor, normalizeModelBinding, reasoningFor } from "../../../src/core/models/binding.js";
import type { ModelRequest } from "../../../src/core/models/contract.js";
import { closedRootProperties, render, tokenUpperBound, FRAMING_TOKEN_ALLOWANCE } from "../../../src/core/models/render.js";
import { BoundModelRouter, sameModel, type ProviderAdapter, type ProviderCompletion } from "../../../src/core/models/router.js";
import { classifyTermination, parseStructured } from "../../../src/core/models/structured.js";
import { priceUsage, projectUsage } from "../../../src/core/models/usage.js";
import { AdapterError, CancelledError } from "../../../src/core/workflow/errors.js";
import { PROJECT } from "../../helpers/paths.js";

interface Vectors {
  framing_allowance: number;
  render: Array<{ node: string; request: ModelRequest; system: string; user: string; schema_text: string; bound: number; closed_root: string[] | null }>;
  closed_root: Array<{ schema: JsonValue; names: string[] | null }>;
  parse: Array<{ text: string; output?: JsonValue; mode?: string; error?: string }>;
  termination: Array<{ stop_reason: string | null; result: { code: string } | null }>;
  usage: Array<{ usage: unknown; result?: { input_tokens: number; output_tokens: number; cost_usd: number | null }; error?: string }>;
}

const VECTORS = JSON.parse(readFileSync(join(PROJECT, "test", "fixtures", "router-vectors.json"), "utf8")) as Vectors;

describe("the reference's router vectors", () => {
  it("renders the identical system and user text and the identical bound", () => {
    expect(FRAMING_TOKEN_ALLOWANCE).toBe(VECTORS.framing_allowance);
    for (const vector of VECTORS.render) {
      const rendered = render(vector.request);
      expect(rendered.system, vector.node).toBe(vector.system);
      expect(rendered.user, vector.node).toBe(vector.user);
      expect(rendered.schema_text, vector.node).toBe(vector.schema_text);
      expect(tokenUpperBound(rendered), vector.node).toBe(vector.bound);
      expect(closedRootProperties(vector.request.output_schema), vector.node).toEqual(vector.closed_root);
    }
  });

  it("lists closed-root properties exactly as the reference does", () => {
    for (const vector of VECTORS.closed_root) expect(closedRootProperties(vector.schema)).toEqual(vector.names);
  });

  it("parses model text in the same three readings and refuses the same inputs", () => {
    for (const vector of VECTORS.parse) {
      if (vector.error) {
        expect(() => parseStructured(vector.text), JSON.stringify(vector.text)).toThrow(AdapterError);
        try {
          parseStructured(vector.text);
        } catch (error) {
          expect((error as AdapterError).code).toBe(vector.error);
        }
      } else {
        const [output, mode] = parseStructured(vector.text);
        expect(output, JSON.stringify(vector.text)).toEqual(vector.output);
        expect(mode).toBe(vector.mode);
      }
    }
  });

  it("classifies stop reasons as the reference does", () => {
    for (const vector of VECTORS.termination) {
      const result = classifyTermination(vector.stop_reason);
      expect(result === null ? null : { code: result[0] }).toEqual(vector.result);
    }
  });

  it("projects usage as the reference does, refusing what cannot be accounted for", () => {
    for (const vector of VECTORS.usage) {
      if (vector.error) {
        try {
          projectUsage(vector.usage);
          expect.unreachable(JSON.stringify(vector.usage));
        } catch (error) {
          expect((error as AdapterError).code, JSON.stringify(vector.usage)).toBe(vector.error);
        }
      } else {
        const projected = projectUsage(vector.usage);
        expect(projected.input_tokens).toBe(vector.result!.input_tokens);
        expect(projected.output_tokens).toBe(vector.result!.output_tokens);
        expect(projected.cost_usd).toBe(vector.result!.cost_usd);
      }
    }
  });

  it("prices usage from catalog figures only", () => {
    const usage = projectUsage({ input_tokens: 1_000_000, output_tokens: 500_000 });
    expect(priceUsage(usage, null)).toBeNull();
    expect(priceUsage(usage, { input_usd_per_million: 2, output_usd_per_million: 10 })).toBe(7);
  });
});

const REQUEST: ModelRequest = {
  task: "plan",
  instructions: ["Be brief."],
  data: { goal: "x" },
  output_schema: { $ref: "#/$defs/s0", $defs: { s0: { type: "object", additionalProperties: false, required: ["focus"], properties: { focus: { type: "string" } } } } },
  requirements: { id: "plan", capabilities: ["structured_output"], context_window: 16000, preferred_tier: "reasoning" },
  budget_context: { max_output_tokens: 100 },
  audit_context: { worker: "Planner:1", node_id: "plan" },
};

class ScriptedAdapter implements ProviderAdapter {
  readonly provider_id = "acme";
  readonly model_id = "big";
  readonly host_model_id = "acme/big";
  readonly remote = true;
  readonly reasoning: boolean = true;
  readonly context_window: number = 100000;
  readonly domains = ["api.acme.example"];
  readonly pricing = { input_usd_per_million: 1, output_usd_per_million: 10 };
  calls = 0;
  signals: AbortSignal[] = [];

  constructor(private readonly answer: Partial<ProviderCompletion> | (() => Promise<ProviderCompletion>)) {}

  async complete(_rendered: unknown, _max: number, signal: AbortSignal): Promise<ProviderCompletion> {
    this.calls += 1;
    this.signals.push(signal);
    if (typeof this.answer === "function") return this.answer();
    return {
      text: '{"focus":"ok"}',
      model_id: "acme/big",
      response_model: "big-2026-01-01",
      stop_reason: "stop",
      usage: { input_tokens: 20, output_tokens: 5 },
      constrained: true,
      constraint_detail: "scripted",
      ...this.answer,
    };
  }
}

describe("BoundModelRouter", () => {
  it("declares what the adapter delivers and binds one model", () => {
    const router = new BoundModelRouter(new ScriptedAdapter({}));
    expect(router.model_id).toBe("acme/big");
    expect([...router.capabilities].sort()).toEqual(["reasoning", "structured_output"]);
    expect(router.remote).toBe(true);
    expect(router.describe().not_declared).toEqual(["multimodal", "tool_use"]);
    const local = new BoundModelRouter(new (class extends ScriptedAdapter {
      override readonly reasoning = false;
    })({}));
    expect([...local.capabilities]).toEqual(["structured_output"]);
  });

  it("counts a provable bound and completes with projected usage and catalog cost", async () => {
    const adapter = new ScriptedAdapter({});
    const router = new BoundModelRouter(adapter);
    const bound = await router.countTokens(REQUEST, new AbortController().signal);
    expect(bound).toBe(tokenUpperBound(render(REQUEST)));
    expect(router.lastCount!.basis).toBe("utf8_upper_bound");
    const result = await router.complete(REQUEST, 100, new AbortController().signal);
    expect(result).toEqual({ output: { focus: "ok" }, input_tokens: 20, output_tokens: 5, cost_usd: 0.00007 });
    expect(router.invocations).toHaveLength(1);
    expect(router.invocations[0]!.response_model).toBe("big-2026-01-01");
    expect(router.lastCompletion!.parse).toBe("direct");
  });

  it("refuses an answer from another model, and accepts a dated snapshot of the bound one", async () => {
    expect(sameModel("acme/big", "acme/big-2026-01-01")).toBe(true);
    expect(sameModel("acme/big", "acme/big-2")).toBe(true);
    expect(sameModel("acme/big", "acme/bigger")).toBe(false);
    expect(sameModel("acme/big", "acme/big-latest")).toBe(false);
    expect(sameModel("acme/big", null)).toBe(false);
    const router = new BoundModelRouter(new ScriptedAdapter({ model_id: "acme/small" }));
    await expect(router.complete(REQUEST, 100, new AbortController().signal)).rejects.toMatchObject({ code: "selected_model_unavailable" });
  });

  const failures: Array<[string, Partial<ProviderCompletion>, string, Record<string, unknown>]> = [
    ["a truncated turn", { stop_reason: "length" }, "model_output_truncated", { stop_reason: "length", reported_input_tokens: 20, reported_output_tokens: 5 }],
    ["an unfinished turn", { stop_reason: "refusal" }, "model_turn_failed", { stop_reason: "refusal" }],
    ["no text", { text: null }, "model_output_not_conforming", { output_failure: "no_text" }],
    ["text that is not JSON", { text: "sorry, no" }, "model_output_not_conforming", { output_failure: "not_json" }],
    ["JSON that fails the schema", { text: '{"focus": 3, "extra": 1}' }, "model_output_not_conforming", { output_failure: "schema", schema_violations: 2 }],
    ["an unreported usage", { usage: { input_tokens: 20 } }, "model_usage_unavailable", {}],
  ];
  for (const [label, answer, code, facts] of failures) {
    it(`fails closed on ${label} with structural facts only`, async () => {
      const router = new BoundModelRouter(new ScriptedAdapter(answer));
      let caught: AdapterError | null = null;
      try {
        await router.complete(REQUEST, 100, new AbortController().signal);
      } catch (error) {
        caught = error as AdapterError;
      }
      expect(caught).toBeInstanceOf(AdapterError);
      expect(caught!.code).toBe(code);
      expect(caught!.audit_facts).toMatchObject(facts);
      for (const value of Object.values(caught!.audit_facts)) expect(typeof value === "number" || typeof value === "boolean" || !/\s/u.test(String(value))).toBe(true);
      expect(router.invocations).toHaveLength(0);
    });
  }

  it("names the schema keyword and location of a non-conforming answer, never the data", async () => {
    const router = new BoundModelRouter(new ScriptedAdapter({ text: '{"focus": "fine", "secret_extra": "leaked value"}' }));
    try {
      await router.complete(REQUEST, 100, new AbortController().signal);
      expect.unreachable();
    } catch (error) {
      const facts = (error as AdapterError).audit_facts;
      expect(facts.schema_keyword).toBe("additionalProperties");
      expect(String(facts.schema_location)).toContain("additionalProperties");
      expect(JSON.stringify(facts)).not.toContain("leaked");
      expect(JSON.stringify(facts)).not.toContain("secret_extra");
    }
  });

  it("applies the host's per-call deadline and aborts the provider request", async () => {
    const adapter = new ScriptedAdapter(
      () =>
        new Promise<ProviderCompletion>((_, reject) => {
          adapter.signals[adapter.signals.length - 1]!.addEventListener("abort", () => reject(new Error("aborted by transport")));
        }),
    );
    const router = new BoundModelRouter(adapter, { requestTimeoutSeconds: 0.02 });
    await expect(router.complete(REQUEST, 100, new AbortController().signal)).rejects.toMatchObject({ code: "model_call_timeout" });
    expect(adapter.signals[0]!.aborted).toBe(true);
  });

  it("propagates the runtime's cancellation into the provider request", async () => {
    const adapter = new ScriptedAdapter(
      () =>
        new Promise<ProviderCompletion>((_, reject) => {
          adapter.signals[adapter.signals.length - 1]!.addEventListener("abort", () => reject(new Error("aborted by transport")));
        }),
    );
    const router = new BoundModelRouter(adapter);
    const controller = new AbortController();
    const pending = router.complete(REQUEST, 100, controller.signal);
    controller.abort(new CancelledError());
    await expect(pending).rejects.toBeInstanceOf(CancelledError);
    expect(adapter.signals[0]!.aborted).toBe(true);
  });

  it("refuses a model with no context window and a non-positive cap", async () => {
    expect(() => new BoundModelRouter(new (class extends ScriptedAdapter {
      override readonly context_window = 0;
    })({}))).toThrow(/context window/u);
    const router = new BoundModelRouter(new ScriptedAdapter({}));
    await expect(router.complete(REQUEST, 0, new AbortController().signal)).rejects.toMatchObject({ code: "model_request_invalid" });
  });
});

describe("normalizeModelBinding", () => {
  const raw: JsonObject = {
    host_model_id: "ollama/qwen3:30b",
    provider_id: "ollama",
    model_id: "qwen3:30b",
    display_name: "Qwen3 30B",
    capabilities: { reasoning: { value: true, basis: "declared" }, structured_output: { value: true, basis: "derived" } },
    limits: { context_tokens: 65536, native_context_window: 262144 },
    properties: { local: true },
  };

  it("accepts the bounded shape and derives window and reasoning", () => {
    const binding = normalizeModelBinding(raw);
    expect(binding.host_model_id).toBe("ollama/qwen3:30b");
    expect(contextWindowFor(binding)).toBe(65536);
    expect(reasoningFor(binding)).toBe(true);
    expect(binding.pricing).toBeNull();
    const priced = normalizeModelBinding({ ...raw, pricing: { input_usd_per_million: 2, output_usd_per_million: 10 } });
    expect(priced.pricing).toEqual({ input_usd_per_million: 2, output_usd_per_million: 10 });
  });

  it("refuses unknown fields, bad counts, and a binding with no window", () => {
    expect(() => normalizeModelBinding({ ...raw, base_url: "https://x" })).toThrow(/Unknown fields/u);
    expect(() => normalizeModelBinding({ ...raw, limits: { context_tokens: -1 } })).toThrow(/nonnegative/u);
    expect(() => contextWindowFor(normalizeModelBinding({ ...raw, limits: {} }))).toThrow(/context window/u);
    expect(() => normalizeModelBinding({ provider_id: "x", model_id: "y" })).toThrow(/Missing fields/u);
  });
});
