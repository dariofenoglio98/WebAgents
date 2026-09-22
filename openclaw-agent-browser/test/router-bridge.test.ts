/**
 * The host side of the bridge, driven by a scripted child.
 *
 * The child here is a fake process: it emits the frames a real `agentpkg
 * host-bridge` would, plus the frames a compromised or broken one might. What
 * is being tested is what this process accepts, what it refuses, and what it
 * does with a model call it is asked to make.
 */
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import type { HostLlm } from "../src/host-llm.js";
import {
  CHILD_METHODS,
  HOST_METHODS,
  PROTOCOL_VERSION,
  RouterBridge,
  readCompleteParams,
  DEFAULT_LIMITS,
} from "../src/router-bridge.js";

const log = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

const PLAN = {
  run_plan_id: "rp_test",
  run_plan_sha256: "a".repeat(64),
  execution: { mode: "model", required_permission_ids: ["model.reasoning"] },
  model_binding: { host_model_id: "acme/big", provider_id: "acme", model_id: "big" },
};

type Script = (frame: Record<string, unknown>, child: FakeChild) => void | Promise<void>;

class FakeChild extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  exitCode: number | null = null;
  signalCode: string | null = null;
  killed = false;
  readonly received: Array<Record<string, unknown>> = [];

  constructor(private readonly script: Script) {
    super();
    let buffer = "";
    this.stdin.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      for (;;) {
        const index = buffer.indexOf("\n");
        if (index < 0) break;
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        const frame = JSON.parse(line) as Record<string, unknown>;
        this.received.push(frame);
        void this.script(frame, this);
      }
    });
  }

  reply(id: unknown, result: unknown): void {
    this.send({ v: PROTOCOL_VERSION, id, ok: true, result });
  }

  ask(id: string, method: string, params: unknown): void {
    this.send({ v: PROTOCOL_VERSION, id, method, params });
  }

  send(frame: unknown): void {
    this.stdout.write(`${JSON.stringify(frame)}\n`);
  }

  raw(line: string): void {
    this.stdout.write(line);
  }

  kill(): boolean {
    this.killed = true;
    this.exitCode = 137;
    queueMicrotask(() => this.emit("exit", 137, "SIGKILL"));
    return true;
  }
}

function bridge(script: Script, options: { llm?: HostLlm; modelId?: string } = {}) {
  let child: FakeChild | null = null;
  const llm: HostLlm = options.llm ?? {
    complete: async () => ({
      text: '{"status":"ok","echo":"router probe"}',
      provider: "acme",
      model: "big",
      responseModel: "big-2026",
      stopReason: "stop",
      usage: { inputTokens: 300, outputTokens: 12 },
    }),
  };
  const instance = new RouterBridge({
    agentpkgPath: "/nonexistent/agentpkg",
    modelId: options.modelId ?? "acme/big",
    llm,
    logger: log,
    limits: { sessionTimeoutMs: 4_000, completionTimeoutMs: 2_000 },
    spawnImpl: (() => {
      child = new FakeChild(script);
      return child as never;
    }) as never,
  });
  return { instance, child: () => child! };
}

/** The ordinary, well-behaved child: answers begin/end, probes through the host. */
const wellBehaved: Script = async (frame, child) => {
  if (frame.method === "session.begin") child.reply(frame.id, { router: { model_id: "acme/big" } });
  if (frame.method === "session.end") child.reply(frame.id, { ended: true });
  if (frame.method === "probe.run") {
    child.ask("c1", "model.count_tokens", { system: "s", user: "u", output_schema: {} });
    await new Promise((resolve) => setTimeout(resolve, 10));
    child.ask("c2", "model.complete", {
      system: "s",
      user: "u",
      output_schema: { type: "object" },
      max_output_tokens: 256,
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    child.reply(frame.id, { status: "ok", model: { invoked: "acme/big" } });
  }
};

describe("the wire contract", () => {
  it("keeps the two method sets closed and disjoint", () => {
    for (const method of HOST_METHODS) expect(CHILD_METHODS.has(method)).toBe(false);
    expect([...HOST_METHODS].sort()).toEqual(["model.complete", "model.count_tokens"]);
    expect([...CHILD_METHODS].sort()).toEqual(["probe.run", "session.begin", "session.end"]);
  });

  it("answers the child's model calls and returns its report", async () => {
    const { instance, child } = bridge(wellBehaved);
    const outcome = await instance.probe(PLAN);
    expect((outcome.report as Record<string, unknown>).status).toBe("ok");
    const methods = child()
      .received.map((frame) => frame.method)
      .filter((method) => typeof method === "string");
    expect(methods).toEqual(["session.begin", "probe.run", "session.end"]);
    expect(instance.completions).toEqual([{ modelId: "acme/big", responseModel: "big-2026" }]);
  });

  it("tells the child this host has no tokenizer instead of guessing one", async () => {
    let answer: Record<string, unknown> | undefined;
    const { instance } = bridge(async (frame, child) => {
      if (frame.method === "session.begin") child.reply(frame.id, {});
      if (frame.method === "session.end") child.reply(frame.id, {});
      if (frame.method === "probe.run") {
        child.ask("c1", "model.count_tokens", { system: "s", user: "u" });
        await new Promise((resolve) => setTimeout(resolve, 20));
        child.reply(frame.id, { status: "ok", model: { invoked: "acme/big" } });
      }
      if (frame.ok === true && frame.id === "c1") answer = frame.result as Record<string, unknown>;
    });
    await instance.probe(PLAN);
    expect(answer).toMatchObject({ supported: false });
    expect(String(answer?.detail)).toContain("chars/4");
  });
});

describe("what the child may not do", () => {
  const refusals: Array<[string, (child: FakeChild) => void]> = [
    ["a log line on the protocol stream", (child) => child.raw("starting up…\n")],
    ["an unknown method", (child) => child.ask("c9", "os.exec", { cmd: "rm -rf /" })],
    [
      "a control-plane method it does not own",
      (child) => child.ask("c9", "session.begin", { run_plan: {} }),
    ],
    ["a duplicate request id", (child) => {
      child.ask("c1", "model.count_tokens", { system: "s", user: "u" });
      child.ask("c1", "model.count_tokens", { system: "s", user: "u" });
    }],
    ["a response to a request nobody sent", (child) => child.reply("h99", { ok: true })],
    ["a frame from another protocol version", (child) => child.send({ v: "other/1", id: "c1" })],
    ["a malformed cancellation", (child) => child.send({ v: PROTOCOL_VERSION, method: "$/cancel", params: {} })],
  ];

  for (const [name, misbehave] of refusals) {
    it(`refuses ${name} and ends the session`, async () => {
      const { instance, child } = bridge((frame, fake) => {
        if (frame.method === "session.begin") {
          fake.reply(frame.id, {});
          misbehave(fake);
        }
      });
      await expect(instance.probe(PLAN)).rejects.toMatchObject({
        code: expect.stringMatching(/bridge_protocol_error|bridge_unavailable/u),
      });
      expect(child().killed).toBe(true);
    });
  }

  it("refuses a model.complete that tries to name its own model", () => {
    for (const params of [
      { system: "s", user: "u", max_output_tokens: 8, model: "acme/other" },
      { system: "s", user: "u", max_output_tokens: 8, model_id: "acme/other" },
      { system: "s", user: "u", max_output_tokens: 8, provider: "acme" },
    ]) {
      expect(() => readCompleteParams(params, DEFAULT_LIMITS)).toThrowError(
        /does not accept/u,
      );
    }
  });

  it("bounds the output cap it will forward", () => {
    for (const value of [0, -1, 1.5, 10_000_000, "256", null]) {
      expect(() =>
        readCompleteParams(
          { system: "s", user: "u", max_output_tokens: value },
          DEFAULT_LIMITS,
        ),
      ).toThrowError(/max_output_tokens/u);
    }
    expect(
      readCompleteParams({ system: "s", user: "u", max_output_tokens: 256 }, DEFAULT_LIMITS),
    ).toMatchObject({ maxOutputTokens: 256 });
  });

  it("bounds the content it will forward", () => {
    const huge = "x".repeat(1_000_000);
    expect(() =>
      readCompleteParams({ system: huge, user: "u", max_output_tokens: 8 }, DEFAULT_LIMITS),
    ).toThrowError(/exceeds/u);
  });
});

describe("failures and lifetimes", () => {
  it("reports a failed model call to the child as a bounded error frame", async () => {
    const frames: Array<Record<string, unknown>> = [];
    const { instance } = bridge(
      async (frame, child) => {
        if (frame.method === "session.begin") child.reply(frame.id, {});
        if (frame.method === "session.end") child.reply(frame.id, {});
        if (frame.method === "probe.run") {
          child.ask("c1", "model.complete", {
            system: "s",
            user: "u",
            output_schema: {},
            max_output_tokens: 8,
          });
          await new Promise((resolve) => setTimeout(resolve, 30));
          child.reply(frame.id, { status: "ok", model: { invoked: "acme/big" } });
        }
        if (frame.ok === false) frames.push(frame);
      },
      {
        llm: {
          complete: async () => {
            throw Object.assign(new Error("nope"), { code: "LLM_COMPLETION_NOT_AUTHORIZED" });
          },
        },
      },
    );
    await instance.probe(PLAN);
    expect(frames).toHaveLength(1);
    const error = frames[0].error as Record<string, unknown>;
    expect(error.code).toBe("model_call_not_authorized");
    expect(String(error.message)).toContain("allowModelOverride");
  });

  it("refuses a completion from a model other than the bound one", async () => {
    const frames: Array<Record<string, unknown>> = [];
    const { instance } = bridge(
      async (frame, child) => {
        if (frame.method === "session.begin") child.reply(frame.id, {});
        if (frame.method === "session.end") child.reply(frame.id, {});
        if (frame.method === "probe.run") {
          child.ask("c1", "model.complete", {
            system: "s",
            user: "u",
            output_schema: {},
            max_output_tokens: 8,
          });
          await new Promise((resolve) => setTimeout(resolve, 30));
          child.reply(frame.id, { status: "ok", model: { invoked: "acme/big" } });
        }
        if (frame.ok === false) frames.push(frame);
      },
      {
        llm: {
          complete: async () => ({
            text: "{}",
            provider: "acme",
            model: "small",
            usage: { inputTokens: 1, outputTokens: 1 },
          }),
        },
      },
    );
    await instance.probe(PLAN);
    expect((frames[0].error as Record<string, unknown>).code).toBe("selected_model_unavailable");
  });

  it("cancels the host call when the child abandons its request", async () => {
    let aborted = false;
    const { instance } = bridge(
      async (frame, child) => {
        if (frame.method === "session.begin") child.reply(frame.id, {});
        if (frame.method === "session.end") child.reply(frame.id, {});
        if (frame.method === "probe.run") {
          child.ask("c1", "model.complete", {
            system: "s",
            user: "u",
            output_schema: {},
            max_output_tokens: 8,
          });
          await new Promise((resolve) => setTimeout(resolve, 20));
          child.send({ v: PROTOCOL_VERSION, method: "$/cancel", params: { id: "c1" } });
          await new Promise((resolve) => setTimeout(resolve, 40));
          child.reply(frame.id, { status: "ok", model: { invoked: "acme/big" } });
        }
      },
      {
        llm: {
          complete: async (params) =>
            new Promise((_resolve, reject) => {
              params.signal?.addEventListener("abort", () => {
                aborted = true;
                reject(Object.assign(new Error("aborted"), { code: "LLM_COMPLETION_ABORTED" }));
              });
            }),
        },
      },
    );
    await instance.probe(PLAN);
    expect(aborted).toBe(true);
  });

  it("gives up on a child that never answers", async () => {
    const { instance, child } = bridge(() => {});
    await expect(instance.probe(PLAN)).rejects.toMatchObject({ code: "bridge_timeout" });
    expect(child().killed).toBe(true);
  });

  it("reports a child that exits mid-session", async () => {
    const { instance } = bridge((frame, child) => {
      if (frame.method === "session.begin") {
        child.stderr.write("host-bridge: fatal\n");
        setTimeout(() => child.emit("exit", 3, null), 10);
      }
    });
    await expect(instance.probe(PLAN)).rejects.toMatchObject({ code: "bridge_unavailable" });
  });
});
