/**
 * Adversarial tests of authority and concurrent accounting with no live network: the port of
 * `test_runtime.py` and `test_runtime_security.py` over the current Literature Review package
 * (roles SearchWorker and ScreeningWorker, task `screen`).
 */
import { describe, expect, it } from "vitest";

import { AgentPkgError } from "../../../src/core/errors.js";
import type { JsonObject, JsonValue } from "../../../src/core/json.js";
import type { ModelRequest, ModelResult, ModelRouter } from "../../../src/core/models/contract.js";
import { loadPackageBytes, type Package } from "../../../src/core/package.js";
import { CancelToken, sleep } from "../../../src/core/workflow/cancel.js";
import { AdapterError, BudgetError, PolicyError, TimeoutError } from "../../../src/core/workflow/errors.js";
import { digest, Runtime, type Context, type RuntimeOptions } from "../../../src/core/workflow/runtime.js";
import { readBytes, SHIPPED } from "../../helpers/paths.js";
import { openRuntime, sessionGrants } from "../../helpers/workflow.js";

const SEARCH = "scholarly-search";
const query = { query: "query", limit: 1 };

async function load(): Promise<Package> {
  return loadPackageBytes(readBytes(SHIPPED.literatureReview.archive));
}

async function runtime(pkg: Package, options: RuntimeOptions = {}): Promise<{ rt: Runtime; close: () => void }> {
  // Every declared tool needs an explicit approval as well as its permission; most tests here
  // are about the other mechanisms, so they approve all of them.
  const { runtime: rt, close } = await openRuntime(pkg, { grants: sessionGrants(pkg), approvedTools: Object.keys(pkg.tools).sort(), ...options });
  return { rt, close };
}

const token = () => new CancelToken();

class Router implements ModelRouter {
  readonly capabilities: ReadonlySet<string> = new Set(["reasoning", "structured_output"]);
  readonly context_window: number = 128000;
  readonly model_id = "test-model";
  readonly router_id = "test-router";
  readonly remote: boolean = false;
  calls = 0;
  request: ModelRequest | null = null;

  async countTokens(request: ModelRequest): Promise<number> {
    this.request = request;
    return 20;
  }

  async complete(): Promise<ModelResult> {
    this.calls += 1;
    await sleep(0.01);
    return { output: { ok: true }, input_tokens: 20, output_tokens: 10 };
  }
}

describe("tool authority", () => {
  it("a declared tool still needs an explicit approval; an undeclared approval is refused", async () => {
    const pkg = await load();
    const { runtime: rt, close } = await openRuntime(pkg, {
      grants: sessionGrants(pkg),
      handlers: {
        "scholarly.search": async () => {
          throw new Error("an unapproved tool must not reach a handler");
        },
      },
      approvedTools: [],
    });
    try {
      await expect(
        rt.runWorker("SearchWorker", { search_queries: [] }, async (ctx, _data, t) => {
          await ctx.tool(SEARCH, query, t);
          return { candidate_papers: [] };
        }),
      ).rejects.toThrow(/not explicitly approved/u);
      expect(rt.audit[rt.audit.length - 1]!.action).toBe("worker.failed");
      expect(rt.audit.some((event) => event.action === "tool.called")).toBe(false);
    } finally {
      close();
    }
    await expect(openRuntime(pkg, { grants: sessionGrants(pkg), approvedTools: ["not-a-tool"] })).rejects.toThrow(/does not declare/u);
  });

  it("denies state and tools by default", async () => {
    const pkg = await load();
    const { runtime: rt, close } = await openRuntime(pkg);
    try {
      await expect(
        rt.runWorker("SearchWorker", { search_queries: [] }, async () => {
          throw new Error("Denied worker must not start");
        }),
      ).rejects.toThrow(/Permission denied/u);
      expect(rt.audit[rt.audit.length - 1]!.action).toBe("worker.denied");
    } finally {
      close();
    }
  });

  it("isolates inputs, scopes outputs and returns no mutable alias", async () => {
    const pkg = await load();
    const { rt, close } = await runtime(pkg);
    try {
      const inputs: JsonObject = { candidate_papers: [{ title: "original" }] };
      const returned: JsonObject = { screened_papers: [] };
      const result = (await rt.runWorker("ScreeningWorker", inputs, async (_ctx, data) => {
        ((data.candidate_papers as JsonObject[])[0]!).title = "modified";
        return returned;
      })) as JsonObject;
      (result.screened_papers as JsonValue[]).push("new");
      expect((inputs.candidate_papers as JsonObject[])[0]!.title).toBe("original");
      expect(returned).toEqual({ screened_papers: [] });
      await expect(rt.runWorker("ScreeningWorker", inputs, async () => ({ secret: "forbidden" }))).rejects.toThrow(/state_write/u);
      await expect(rt.runWorker("ScreeningWorker", { secret: "forbidden" }, async () => ({}))).rejects.toThrow(/state_read/u);
    } finally {
      close();
    }
  });

  it("checks delegation roles and depth, and refuses an expired context", async () => {
    const pkg = await load();
    const { rt, close } = await runtime(pkg);
    try {
      const noOp = async (): Promise<JsonValue> => ({ candidate_papers: [] });
      for (const [role, depth] of [
        ["Unknown", 1],
        ["SearchWorker", 2],
        [rt.coordinator, 1],
      ] as const) {
        await expect(rt.runWorker(role, {}, noOp, { depth })).rejects.toBeInstanceOf(PolicyError);
      }
      const saved: Context[] = [];
      await rt.runWorker("SearchWorker", {}, async (ctx) => {
        saved.push(ctx);
        await expect(rt.runWorker("SearchWorker", {}, noOp, { parent: ctx, depth: 2 })).rejects.toThrow(/Delegation/u);
        return { candidate_papers: [] };
      });
      await expect(saved[0]!.tool(SEARCH, query, token())).rejects.toThrow(/expired/u);
    } finally {
      close();
    }
  });

  it("role tool authority and once grants", async () => {
    const pkg = await load();
    const calls: JsonValue[] = [];
    const { runtime: rt, close } = await openRuntime(pkg, {
      grants: { ...sessionGrants(pkg), "network.scholarly": "once" },
      handlers: {
        "scholarly.search": async (_ctx, payload) => {
          calls.push(payload);
          return { papers: [], source: "mock", query: (payload as JsonObject).query! };
        },
      },
      approvedTools: Object.keys(pkg.tools).sort(),
    });
    try {
      const search = async (ctx: Context, _data: JsonObject, t: CancelToken): Promise<JsonValue> => {
        await ctx.tool(SEARCH, query, t);
        return { candidate_papers: [] };
      };
      await rt.runWorker("SearchWorker", {}, search);
      await expect(rt.runWorker("SearchWorker", {}, search)).rejects.toThrow(/consumed/u);
      await expect(rt.runWorker("ScreeningWorker", {}, search)).rejects.toThrow(/may not call/u);
      expect(calls.length).toBe(1);
    } finally {
      close();
    }
  });

  it("enforces the tool output schema", async () => {
    const pkg = await load();
    const { rt, close } = await runtime(pkg, { handlers: { "scholarly.search": async () => ({ wrong: true }) } });
    try {
      await expect(
        rt.runWorker("SearchWorker", {}, async (ctx, _data, t) => {
          await ctx.tool(SEARCH, query, t);
          return { candidate_papers: [] };
        }),
      ).rejects.toThrow(/tool output/u);
      expect(rt.usage.remote_calls).toBe(1);
      const failed = rt.audit.find((event) => event.action === "tool.failed")!;
      expect(failed.reason).toBe("tool_response_invalid");
      expect((failed.failure_facts as JsonObject).stage).toBe("output_schema");
      expect((failed.failure_facts as JsonObject).schema_keyword).toBe("required");
    } finally {
      close();
    }
  });
});

describe("budgets and concurrency", () => {
  it("parallelism limits active tasks and preserves order", async () => {
    const pkg = await load();
    const { rt, close } = await runtime(pkg, { limits: { max_parallel_workers: 2 } });
    try {
      let active = 0;
      let peak = 0;
      const results = await rt.mapWorkers(
        "SearchWorker",
        Array.from({ length: 7 }, (_, index) => ({ search_queries: [index] })),
        async (_ctx, data) => {
          active += 1;
          peak = Math.max(peak, active);
          await sleep(0.005);
          active -= 1;
          return { candidate_papers: data.search_queries! };
        },
      );
      expect(peak).toBe(2);
      expect(rt.usage.peak_parallel_workers).toBe(2);
      expect((results as JsonObject[]).map((result) => result.candidate_papers)).toEqual([[0], [1], [2], [3], [4], [5], [6]]);
    } finally {
      close();
    }
  });

  it("remote reservations are atomic across failures, and tool caps hold", async () => {
    const pkg = await load();
    let calls = 0;
    const { rt, close } = await runtime(pkg, {
      handlers: {
        "scholarly.search": async () => {
          calls += 1;
          await sleep(0.01);
          throw new Error("provider unavailable");
        },
      },
      limits: { max_remote_calls: 1 },
    });
    try {
      await rt.mapWorkers("SearchWorker", [{}, {}, {}], async (ctx, _data, t) => {
        try {
          await ctx.tool(SEARCH, query, t);
        } catch (error) {
          if (!(error instanceof BudgetError) && !(error instanceof Error && error.message === "provider unavailable")) throw error;
        }
        return { candidate_papers: [] };
      });
      expect(calls).toBe(1);
      expect(rt.usage.remote_calls).toBe(1);
      expect(rt.usage.tool_calls).toEqual({ [SEARCH]: 1 });
    } finally {
      close();
    }
  });

  it("the worker remote cap is enforced before the handler", async () => {
    const pkg = await load();
    const workers = pkg.graph.workers as JsonObject[];
    const edited: Package = { ...pkg, graph: { ...pkg.graph, workers: workers.map((worker) => (worker.id === "SearchWorker" ? { ...worker, budget: { ...(worker.budget as JsonObject), remote_calls: 0 } } : worker)) } };
    const calls: JsonValue[] = [];
    const { rt, close } = await runtime(edited, {
      handlers: {
        "scholarly.search": async (_ctx, payload) => {
          calls.push(payload);
          return null;
        },
      },
    });
    try {
      await expect(rt.runWorker("SearchWorker", {}, (ctx, _data, t) => ctx.tool(SEARCH, query, t))).rejects.toThrow(/Remote-call budget/u);
      expect(calls).toEqual([]);
      expect(rt.usage.remote_calls).toBe(0);
    } finally {
      close();
    }
  });

  it("token reservation under parallel workers admits only what fits", async () => {
    const pkg = await load();
    const router = new Router();
    const { rt, close } = await runtime(pkg, { router, limits: { hard_tokens: 100 } });
    try {
      const outcomes: string[] = [];
      await rt.mapWorkers("ScreeningWorker", [{}, {}, {}], async (ctx, _data, t) => {
        try {
          await ctx.model("screen", { private: "value" }, { type: "object" }, 60, t);
          outcomes.push("ok");
        } catch (error) {
          if (!(error instanceof BudgetError)) throw error;
          outcomes.push("denied");
        }
        return { screened_papers: [] };
      });
      expect(outcomes.sort()).toEqual(["denied", "denied", "ok"]);
      expect(router.calls).toBe(1);
      expect(rt.usage.tokens).toBe(30);
      expect(rt.usage.reserved_tokens).toBe(0);
      expect(router.request!.instructions.length).toBeGreaterThan(0); // Real role skills are bound to the model call.
      expect(JSON.stringify(rt.audit)).not.toContain("private");
    } finally {
      close();
    }
  });

  it("per-worker reservation refuses, and a failed model call is charged its reservation", async () => {
    const pkg = await load();
    const workers = pkg.graph.workers as JsonObject[];
    const edited: Package = { ...pkg, graph: { ...pkg.graph, workers: workers.map((worker) => (worker.id === "ScreeningWorker" ? { ...worker, budget: { ...(worker.budget as JsonObject), tokens: 50 } } : worker)) } };
    const first = await runtime(edited, { router: new Router() });
    try {
      await expect(first.rt.runWorker("ScreeningWorker", {}, (ctx, _data, t) => ctx.model("screen", {}, { type: "object" }, 60, t))).rejects.toThrow(/Token budget exhausted/u);
      expect((first.rt.router as Router).calls).toBe(0);
    } finally {
      first.close();
    }
    class FailedRouter extends Router {
      override async complete(): Promise<ModelResult> {
        throw new TimeoutError("unknown provider usage");
      }
    }
    const second = await runtime(edited, { router: new FailedRouter() });
    try {
      await expect(second.rt.runWorker("ScreeningWorker", {}, (ctx, _data, t) => ctx.model("screen", {}, { type: "object" }, 20, t))).rejects.toBeInstanceOf(TimeoutError);
      expect(second.rt.usage.tokens).toBe(40);
      expect(second.rt.usage.reserved_tokens).toBe(0);
    } finally {
      second.close();
    }
  });

  it("a refused model call records which bound refused it", async () => {
    const pkg = await load();
    const workers = pkg.graph.workers as JsonObject[];
    const edited: Package = { ...pkg, graph: { ...pkg.graph, workers: workers.map((worker) => (worker.id === "ScreeningWorker" ? { ...worker, budget: { ...(worker.budget as JsonObject), tokens: 50 } } : worker)) } };
    const work = (ctx: Context, _data: JsonObject, t: CancelToken) => ctx.model("screen", {}, { type: "object" }, 60, t);
    const refusal = async (rt: Runtime, bound = 20): Promise<JsonObject> => {
      await expect(rt.runWorker("ScreeningWorker", {}, work)).rejects.toBeInstanceOf(BudgetError);
      expect((rt.router as Router).calls).toBe(0);
      expect(rt.audit.some((event) => event.action === "model.called")).toBe(false);
      const events = rt.audit.filter((event) => event.action === "model.refused");
      expect(events.length).toBe(1);
      const event = events[0]! as unknown as JsonObject;
      expect(event.input_bound).toBe(bound);
      expect(event.max_output_tokens).toBe(60);
      expect(event.reserved_tokens).toBe(bound + 60);
      return event;
    };
    let handle = await runtime(edited, { router: new Router() });
    let event = await refusal(handle.rt);
    expect(event.reason).toBe("worker_token_budget");
    expect(event.limit).toBe(50);
    expect(event.used_tokens).toBe(0);
    handle.close();
    handle = await runtime(edited, { router: new Router(), limits: { hard_tokens: 70 } });
    event = await refusal(handle.rt);
    expect(event.reason).toBe("global_token_budget");
    expect(event.limit).toBe(70);
    handle.close();
    class Full extends Router {
      override readonly context_window = 16000; // Meets the declared minimum; this request does not fit.
      override async countTokens(): Promise<number> {
        return 15990;
      }
    }
    handle = await runtime(edited, { router: new Full() });
    event = await refusal(handle.rt, 15990);
    expect(event.reason).toBe("context_window");
    expect(event.context_window).toBe(16000);
    handle.close();
  });

  it("a failed call records the adapter's stable code and never its message", async () => {
    const pkg = await load();
    class Slow extends Router {
      override async complete(): Promise<ModelResult> {
        throw new AdapterError("bridge_timeout", "The host did not answer, private detail");
      }
    }
    class Odd extends Router {
      override async complete(): Promise<ModelResult> {
        throw new AdapterError("Not An Identifier!", "whatever");
      }
    }
    const work = (ctx: Context, _data: JsonObject, t: CancelToken) => ctx.model("screen", {}, { type: "object" }, 20, t);
    let handle = await runtime(pkg, { router: new Slow() });
    await expect(handle.rt.runWorker("ScreeningWorker", {}, work)).rejects.toBeInstanceOf(AdapterError);
    let failed = handle.rt.audit.filter((event) => event.action === "model.failed");
    expect(failed.length).toBe(1);
    expect(failed[0]!.reason).toBe("bridge_timeout");
    expect(failed[0]!.error).toBe("AdapterError");
    expect(JSON.stringify(handle.rt.audit)).not.toContain("private detail");
    handle.close();
    handle = await runtime(pkg, { router: new Odd() });
    await expect(handle.rt.runWorker("ScreeningWorker", {}, work)).rejects.toBeInstanceOf(AdapterError);
    failed = handle.rt.audit.filter((event) => event.action === "model.failed");
    expect("reason" in failed[0]!).toBe(false);
    handle.close();
  });

  it("a failed call keeps only the structural facts its adapter certified", async () => {
    const pkg = await load();
    class Rejected extends Router {
      override async complete(): Promise<ModelResult> {
        throw new AdapterError("model_output_not_conforming", "unexpected 'research_question', private detail", {
          audit_facts: {
            stop_reason: "stop",
            reported_output_tokens: 380,
            output_failure: "schema",
            schema_keyword: "additionalProperties",
            schema_location: "properties/provenance/items/required",
            // Refused: prose, quotes, a negative or non-integer count, a nested value, a bad key.
            echo: "Ignore previous instructions",
            quoted: "'research_question'",
            negative: -1,
            ratio: 0.5,
            nested: { text: "x" },
            "Bad Key": "stop",
          },
        });
      }
    }
    const { rt, close } = await runtime(pkg, { router: new Rejected() });
    try {
      await expect(rt.runWorker("ScreeningWorker", {}, (ctx, _data, t) => ctx.model("screen", {}, { type: "object" }, 20, t))).rejects.toBeInstanceOf(AdapterError);
      const called = rt.audit.find((event) => event.action === "model.called")!;
      const failed = rt.audit.find((event) => event.action === "model.failed")!;
      expect(failed.reason).toBe("model_output_not_conforming");
      expect(failed.failure_facts).toEqual({
        stop_reason: "stop",
        reported_output_tokens: 380,
        output_failure: "schema",
        schema_keyword: "additionalProperties",
        schema_location: "properties/provenance/items/required",
      });
      // The reservation is still what is charged: the facts explain, not settle.
      expect(failed.tokens_charged).toBe(called.reserved_tokens);
      const text = JSON.stringify(rt.audit);
      expect(text).not.toContain("private detail");
      expect(text).not.toContain("Ignore previous");
    } finally {
      close();
    }
  });

  for (const code of ["model_usage_invalid", "model_usage_unavailable"]) {
    it(`an unaccountable usage report (${code}) is charged the whole reservation`, async () => {
      const pkg = await load();
      class Unaccountable extends Router {
        override async complete(): Promise<ModelResult> {
          throw new AdapterError(code, "The host's usage report cannot be accounted for");
        }
      }
      const { rt, close } = await runtime(pkg, { router: new Unaccountable() });
      try {
        await expect(rt.runWorker("ScreeningWorker", {}, (ctx, _data, t) => ctx.model("screen", {}, { type: "object" }, 20, t))).rejects.toBeInstanceOf(AdapterError);
        const called = rt.audit.find((event) => event.action === "model.called")!;
        const failed = rt.audit.find((event) => event.action === "model.failed")!;
        expect(failed.reason).toBe(code);
        expect(failed.tokens_charged).toBe(called.reserved_tokens);
        expect(rt.usage.tokens).toBe(called.reserved_tokens);
        expect(rt.usage.reserved_tokens).toBe(0);
      } finally {
        close();
      }
    });
  }

  it("a model contract violation halts the runtime and charges the full observed usage", async () => {
    const pkg = await load();
    class Dishonest extends Router {
      override async complete(): Promise<ModelResult> {
        return { output: {}, input_tokens: 21, output_tokens: 1000 };
      }
    }
    const { rt, close } = await runtime(pkg, { router: new Dishonest() });
    try {
      await expect(rt.runWorker("ScreeningWorker", {}, (ctx, _data, t) => ctx.model("screen", {}, { type: "object" }, 60, t))).rejects.toThrow(/violated token/u);
      expect(rt.usage.tokens).toBe(1021); // A dishonest router's observed overrun is visible.
    } finally {
      close();
    }
  });

  it("host limits only narrow, and unsupported policies fail closed", async () => {
    const pkg = await load();
    const { rt, close } = await runtime(pkg, { limits: { hard_tokens: 9999999 } });
    try {
      expect(rt.budget.hard_tokens).toBe((pkg.policy.budget as JsonObject).hard_tokens);
    } finally {
      close();
    }
    for (const [key, value] of [
      ["scope", "user-global"],
      ["raw_documents", true],
    ] as const) {
      const changed: Package = { ...pkg, policy: { ...pkg.policy, memory: { ...(pkg.policy.memory as JsonObject), [key]: value } } };
      await expect(runtime(changed)).rejects.toBeInstanceOf(PolicyError);
    }
    const remote: Package = { ...pkg, policy: { ...pkg.policy, delegation: { ...(pkg.policy.delegation as JsonObject), allow_remote: true } } };
    await expect(runtime(remote)).rejects.toBeInstanceOf(PolicyError);
    await expect(runtime(pkg, { limits: { hard_tokens: -1 } })).rejects.toThrow(/nonnegative/u);
    await expect(runtime(pkg, { limits: { unknown: 1 } as never })).rejects.toThrow(/Unsupported host limit/u);
  });

  it("the audit is a hash chain and clear() empties the session state", async () => {
    const pkg = await load();
    const { rt, close } = await runtime(pkg);
    try {
      rt.state.secret = "session contents";
      rt.clear();
      expect(rt.state).toEqual({});
      expect(JSON.stringify(rt.audit)).not.toContain("session contents");
      let previous: string | null = null;
      for (const event of rt.audit) {
        const { event_hash, ...unsigned } = event;
        expect(unsigned.previous_hash).toBe(previous);
        expect(digest(unsigned)).toBe(event_hash);
        previous = event_hash;
      }
    } finally {
      close();
    }
  });
});

describe("regressions for authority confusion and concurrent admission (test_runtime_security.py)", () => {
  it("the model approval threshold includes concurrent reservations", async () => {
    const pkg = await load();
    const edited: Package = { ...pkg, policy: { ...pkg.policy, budget: { ...(pkg.policy.budget as JsonObject), approval_threshold_tokens: 100 } } };
    let called = 0;
    class Slow extends Router {
      override readonly context_window = 1_000_000;
      override async countTokens(): Promise<number> {
        return 40;
      }
      override async complete(): Promise<ModelResult> {
        called += 1;
        await sleep(0.03);
        return { input_tokens: 40, output_tokens: 20, output: {} };
      }
    }
    const { runtime: rt, close } = await openRuntime(edited, { grants: { "memory.session": "session", "model.reasoning": "session" }, router: new Slow() });
    try {
      await expect(rt.mapWorkers("SearchWorker", [{}, {}], async (ctx, _data, t) => {
        await ctx.model("plan", {}, { type: "object" }, 20, t);
        return {};
      })).rejects.toThrow(/threshold/u);
      expect(called).toBe(1);
    } finally {
      close();
    }
  });

  it("a once model grant covers preflight without concurrent disclosure", async () => {
    const pkg = await load();
    let counted = 0;
    class Remote extends Router {
      override readonly remote = true;
      override readonly context_window = 1_000_000;
      readonly domains = ["router.example.org"];
      override async countTokens(): Promise<number> {
        counted += 1;
        await sleep(0.03);
        return 40;
      }
      override async complete(): Promise<ModelResult> {
        return { input_tokens: 40, output_tokens: 10, output: {} };
      }
    }
    const { runtime: rt, close } = await openRuntime(pkg, { grants: { "memory.session": "session", "model.reasoning": "once" }, router: new Remote() });
    try {
      await expect(rt.mapWorkers("SearchWorker", [{}, {}], async (ctx, _data, t) => {
        await ctx.model("plan", {}, { type: "object" }, 20, t);
        return {};
      })).rejects.toBeInstanceOf(AgentPkgError);
      expect(counted, "a once grant must not disclose two prompts during token preflight").toBe(1);
      const preflight = rt.audit.find((event) => event.action === "model.count.called")!;
      expect(preflight.domains).toEqual(["router.example.org"]);
    } finally {
      close();
    }
  });

  it("a token contract violation halts further dispatch and preserves known usage", async () => {
    const pkg = await load();
    let called = 0;
    class Violating extends Router {
      override readonly context_window = 1_000_000;
      override async countTokens(): Promise<number> {
        return 40;
      }
      override async complete(): Promise<ModelResult> {
        called += 1;
        // A syntactically valid usage report violates the promised output bound.
        return { input_tokens: 40, output_tokens: called === 1 ? 21 : 10, output: {} };
      }
    }
    const { runtime: rt, close } = await openRuntime(pkg, { grants: { "memory.session": "session", "model.reasoning": "session" }, router: new Violating() });
    try {
      await rt.runWorker("SearchWorker", {}, async (ctx, _data, t) => {
        await expect(ctx.model("plan", {}, { type: "object" }, 20, t)).rejects.toBeInstanceOf(AgentPkgError);
        await expect(ctx.model("plan", {}, { type: "object" }, 20, t)).rejects.toBeInstanceOf(AgentPkgError);
        return {};
      });
      expect(called).toBe(1);
      expect(rt.usage.tokens).toBe(61);
    } finally {
      close();
    }
  });
});
