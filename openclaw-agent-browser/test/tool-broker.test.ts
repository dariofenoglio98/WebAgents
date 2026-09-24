/**
 * The host tool broker: what it will dispatch, and everything it will not.
 *
 * These tests never reach a network. The transport is a seam, so what is under
 * test is the *policy* in front of it: which binding a `tool.call` can resolve
 * to, which destinations are refused by class, which headers are sent, what a
 * response has to be before it is believed, and what happens when a run is
 * cancelled or a host is slow.
 */
import { describe, expect, it, vi } from "vitest";
import {
  addressRejection,
  credentialsReady,
  readToolCallParams,
  safeHostname,
  ToolBroker,
  type BoundTool,
  type HttpTransport,
} from "../src/tool-broker.js";
import {
  BUILT_IN_BINDINGS,
  buildToolRegistry,
  describeBinding,
  resolveBindings,
  safeOrigin,
  type ToolBindingDefinition,
} from "../src/tool-registry.js";
import { fixturesFor, pickFixture, TOOL_PROBE_FIXTURES } from "../src/tool-fixtures.js";
import { Pacer } from "../src/tool-pacer.js";

const log = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
const DIGEST = "a".repeat(64);

const ECHO = BUILT_IN_BINDINGS.find((item) => item.toolId === "test.echo")!;
const RESOLVER = BUILT_IN_BINDINGS.find((item) => item.toolId === "citation-resolver")!;

function bound(definition: ToolBindingDefinition, overrides: Partial<BoundTool> = {}): BoundTool {
  return {
    toolId: definition.toolId,
    bindingId: definition.id,
    bindingSha256: DIGEST,
    remote: definition.kind === "json_http",
    timeoutSeconds: definition.timeoutSeconds,
    ...overrides,
  };
}

function broker(options: {
  bound: BoundTool[];
  definitions?: ToolBindingDefinition[];
  transport?: HttpTransport;
  resolver?: (hostname: string) => Promise<string[]>;
  env?: NodeJS.ProcessEnv;
}) {
  return new ToolBroker({
    bound: options.bound,
    definitions: options.definitions ?? [...BUILT_IN_BINDINGS],
    logger: log,
    ...(options.transport ? { transport: options.transport } : {}),
    ...(options.resolver ? { resolver: options.resolver } : {}),
    ...(options.env ? { env: options.env } : {}),
  });
}

const publicResolver = async () => ["93.184.216.34"];

function jsonTransport(
  body: unknown,
  init: { status?: number; contentType?: string } = {},
): { transport: HttpTransport; seen: Parameters<HttpTransport>[0][] } {
  const seen: Parameters<HttpTransport>[0][] = [];
  const transport: HttpTransport = async (options) => {
    seen.push(options);
    return {
      status: init.status ?? 200,
      contentType: init.contentType ?? "application/json; charset=utf-8",
      body: typeof body === "string" ? body : JSON.stringify(body),
    };
  };
  return { transport, seen };
}

const signal = () => new AbortController().signal;

describe("the tool.call parameter set", () => {
  it("accepts a declared tool, a binding identity and arguments, and nothing else", () => {
    const parsed = readToolCallParams({
      tool_id: "test.echo",
      binding_id: ECHO.id,
      binding_sha256: DIGEST,
      args: { value: "x" },
    });
    expect(parsed.tool_id).toBe("test.echo");
    expect(parsed.args).toEqual({ value: "x" });
  });

  it.each([
    ["url", { url: "https://elsewhere.test" }],
    ["method", { method: "DELETE" }],
    ["headers", { headers: { authorization: "Bearer x" } }],
    ["endpoint", { endpoint: "/somewhere" }],
    ["origin", { origin: "https://elsewhere.test" }],
  ])("refuses a frame carrying %s", (_name, extra) => {
    expect(() =>
      readToolCallParams({
        tool_id: "test.echo",
        binding_id: ECHO.id,
        binding_sha256: DIGEST,
        args: {},
        ...extra,
      }),
    ).toThrow(/tool_request_invalid/u);
  });

  it("refuses a malformed identity", () => {
    for (const params of [
      { tool_id: "", binding_id: ECHO.id, binding_sha256: DIGEST, args: {} },
      { tool_id: "x", binding_id: "", binding_sha256: DIGEST, args: {} },
      { tool_id: "x", binding_id: ECHO.id, binding_sha256: "short", args: {} },
      { tool_id: "x", binding_id: ECHO.id, binding_sha256: DIGEST },
    ]) {
      expect(() => readToolCallParams(params as never)).toThrow(/tool_request_invalid/u);
    }
  });
});

describe("resolving a call against this run's bindings", () => {
  it("runs the local implementation and reaches nothing", async () => {
    const instance = broker({ bound: [bound(ECHO)] });
    const result = await instance.call(
      { tool_id: "test.echo", binding_id: ECHO.id, binding_sha256: DIGEST, args: { value: "x" } },
      signal(),
    );
    expect(result.status).toBe("ok");
    expect(result.output).toEqual({ value: "x" });
    expect(result.remote).toBe(false);
    expect(result.transport_status).toBeNull();
    expect(instance.calls).toHaveLength(1);
    expect(instance.calls[0]!.outcome).toBe("ok");
  });

  it("refuses a tool this run did not bind", async () => {
    const instance = broker({ bound: [bound(ECHO)] });
    await expect(
      instance.call(
        {
          tool_id: "secret-admin-tool",
          binding_id: ECHO.id,
          binding_sha256: DIGEST,
          args: {},
        },
        signal(),
      ),
    ).rejects.toThrow(/tool_not_bound/u);
  });

  it("refuses a binding identity that is not the one the plan froze", async () => {
    const instance = broker({ bound: [bound(ECHO)] });
    for (const identity of [
      { binding_id: "openclaw:something-else:1", binding_sha256: DIGEST },
      { binding_id: ECHO.id, binding_sha256: "b".repeat(64) },
    ]) {
      await expect(
        instance.call(
          { tool_id: "test.echo", args: {}, ...identity } as never,
          signal(),
        ),
      ).rejects.toThrow(/tool_binding_stale/u);
    }
  });

  it("refuses a binding the host no longer registers", async () => {
    const instance = broker({ bound: [bound(ECHO)], definitions: [] });
    await expect(
      instance.call(
        { tool_id: "test.echo", binding_id: ECHO.id, binding_sha256: DIGEST, args: {} },
        signal(),
      ),
    ).rejects.toThrow(/tool_unavailable/u);
  });

  it("bounds how many calls one implementation serves at once, by waiting rather than refusing", async () => {
    let release: (value: { ok: true }) => void = () => {};
    const held = new Promise<{ ok: true }>((resolve) => {
      release = resolve;
    });
    const definition: ToolBindingDefinition = { ...RESOLVER, maxConcurrent: 1 };
    let inFlight = 0;
    let peak = 0;
    const transport: HttpTransport = async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await held;
      inFlight -= 1;
      return { status: 200, contentType: "application/json", body: "{}" };
    };
    const instance = new ToolBroker({
      bound: [bound(definition)],
      definitions: [definition],
      logger: log,
      transport,
      resolver: publicResolver,
      pacer: new Pacer(),
    });
    const params = {
      tool_id: "citation-resolver",
      binding_id: definition.id,
      binding_sha256: DIGEST,
      args: {},
    };
    const first = instance.call(params, signal());
    // Let the first call reach the transport before the second arrives.
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = instance.call(params, signal());
    await new Promise((resolve) => setTimeout(resolve, 20));
    // The second waits its turn: the transport has seen only the first.
    expect(inFlight).toBe(1);
    release({ ok: true });
    await expect(first).resolves.toMatchObject({ status: "ok" });
    await expect(second).resolves.toMatchObject({ status: "ok" });
    expect(peak).toBe(1);
  });

  it("gives up waiting for a turn at the binding's own deadline, holding no slot", async () => {
    const definition: ToolBindingDefinition = { ...RESOLVER, maxConcurrent: 1, timeoutSeconds: 1 };
    const pacer = new Pacer();
    const hang: HttpTransport = (options) =>
      new Promise((_, reject) => options.signal.addEventListener("abort", () => reject(new Error("x"))));
    const instance = new ToolBroker({
      bound: [bound(definition, { timeoutSeconds: 1 })],
      definitions: [definition],
      logger: log,
      transport: hang,
      resolver: publicResolver,
      pacer,
    });
    const params = {
      tool_id: "citation-resolver",
      binding_id: definition.id,
      binding_sha256: DIGEST,
      args: {},
    };
    const first = instance.call(params, signal());
    const firstOutcome = first.then(
      () => "resolved",
      (error: Error) => error.message,
    );
    await new Promise((resolve) => setTimeout(resolve, 5));
    const waiting = instance.call(params, signal());
    await expect(waiting).rejects.toThrow(/tool_timeout/u);
    expect(await firstOutcome).toMatch(/tool_timeout/u);
    expect(pacer.load(definition.id)).toEqual({ active: 0, waiting: 0 });
  }, 10_000);
});

describe("pacing one implementation", () => {
  it("serves waiters first in, first out, and hands a slot straight to the next", async () => {
    const pacer = new Pacer();
    const order: number[] = [];
    const limits = { maxConcurrent: 1, minIntervalMs: 0 };
    const first = await pacer.acquire("k", limits, new AbortController().signal);
    const waiting = [1, 2, 3].map((index) =>
      pacer.acquire("k", limits, new AbortController().signal).then((release) => {
        order.push(index);
        return release;
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(pacer.load("k")).toEqual({ active: 1, waiting: 3 });
    first();
    (await waiting[0])();
    (await waiting[1])();
    (await waiting[2])();
    expect(order).toEqual([1, 2, 3]);
    expect(pacer.load("k")).toEqual({ active: 0, waiting: 0 });
  });

  it("drops a cancelled waiter without holding a slot", async () => {
    const pacer = new Pacer();
    const limits = { maxConcurrent: 1, minIntervalMs: 0 };
    const held = await pacer.acquire("k", limits, new AbortController().signal);
    const controller = new AbortController();
    const cancelled = pacer.acquire("k", limits, controller.signal);
    controller.abort();
    await expect(cancelled).rejects.toBeDefined();
    expect(pacer.load("k")).toEqual({ active: 1, waiting: 0 });
    held();
    expect(pacer.load("k")).toEqual({ active: 0, waiting: 0 });
  });

  it("spaces the starts of calls by the service's interval, even when slots allow more", async () => {
    const pacer = new Pacer();
    const limits = { maxConcurrent: 3, minIntervalMs: 150 };
    const starts: number[] = [];
    await Promise.all(
      [0, 1, 2].map(async () => {
        const release = await pacer.acquire("spaced", limits, new AbortController().signal);
        starts.push(Date.now());
        release();
      }),
    );
    starts.sort((a, b) => a - b);
    expect(starts[1]! - starts[0]!).toBeGreaterThanOrEqual(140);
    expect(starts[2]! - starts[1]!).toBeGreaterThanOrEqual(140);
  });
});

describe("the HTTP adapter's destination policy", () => {
  it.each([
    ["127.0.0.1", "loopback_address"],
    ["0.0.0.0", "unspecified_address"],
    ["10.1.2.3", "private_address"],
    ["172.16.0.1", "private_address"],
    ["192.168.1.1", "private_address"],
    ["169.254.1.1", "link_local_address"],
    ["169.254.169.254", "cloud_metadata_address"],
    ["100.100.100.200", "cloud_metadata_address"],
    ["100.64.0.1", "private_address"],
    ["224.0.0.1", "multicast_address"],
    ["240.0.0.1", "reserved_address"],
    ["::1", "loopback_address"],
    ["fe80::1", "link_local_address"],
    ["fd00::1", "private_address"],
    ["ff02::1", "multicast_address"],
    ["2002::1", "sixtofour_address"],
    ["64:ff9b::1.2.3.4", "nat64_address"],
    ["fd00:ec2::254", "cloud_metadata_address"],
    ["not-an-address", "unparsable_address"],
  ])("refuses %s as %s", (address, reason) => {
    expect(addressRejection(address)).toBe(reason);
  });

  it("permits an ordinary public address", () => {
    expect(addressRejection("93.184.216.34")).toBeNull();
    expect(addressRejection("2606:2800:220:1:248:1893:25c8:1946")).toBeNull();
  });

  it("refuses a host that resolves to a private destination, before connecting", async () => {
    const { transport, seen } = jsonTransport({ ok: true });
    const instance = broker({
      bound: [bound(RESOLVER)],
      transport,
      resolver: async () => ["127.0.0.1"],
    });
    await expect(
      instance.call(
        {
          tool_id: "citation-resolver",
          binding_id: RESOLVER.id,
          binding_sha256: DIGEST,
          args: { query: "x" },
        },
        signal(),
      ),
    ).rejects.toThrow(/tool_unavailable: .*loopback_address/u);
    expect(seen).toHaveLength(0);
  });
});

describe("what the HTTP adapter sends", () => {
  it("sends exactly the binding's origin, path, method and a fixed header set", async () => {
    const { transport, seen } = jsonTransport({ status: "resolved" });
    const instance = broker({ bound: [bound(RESOLVER)], transport, resolver: publicResolver });
    await instance.call(
      {
        tool_id: "citation-resolver",
        binding_id: RESOLVER.id,
        binding_sha256: DIGEST,
        args: { query: "10.1038/nphys1170" },
      },
      signal(),
    );
    const request = seen[0]!;
    expect(request.hostname).toBe(safeHostname(RESOLVER.origin!));
    expect(request.path).toBe(RESOLVER.path);
    expect(request.method).toBe("POST");
    expect(request.address).toBe("93.184.216.34");
    expect(Object.keys(request.headers).sort()).toEqual([
      "accept",
      "connection",
      "content-length",
      "content-type",
      "user-agent",
    ]);
    expect(request.body).toBe(JSON.stringify({ query: "10.1038/nphys1170" }));
  });

  it("refuses arguments larger than the binding allows, without connecting", async () => {
    const { transport, seen } = jsonTransport({});
    const instance = broker({ bound: [bound(RESOLVER)], transport, resolver: publicResolver });
    await expect(
      instance.call(
        {
          tool_id: "citation-resolver",
          binding_id: RESOLVER.id,
          binding_sha256: DIGEST,
          args: { query: "x".repeat(100_000) },
        },
        signal(),
      ),
    ).rejects.toThrow(/tool_request_invalid/u);
    expect(seen).toHaveLength(0);
  });

  it("attaches a configured credential as a header and never anywhere else", async () => {
    const secret = "sk-test-DO-NOT-LEAK-91a2";
    const definition: ToolBindingDefinition = {
      ...RESOLVER,
      credential: { kind: "env", name: "TEST_TOOL_TOKEN" },
    };
    const { transport, seen } = jsonTransport({ status: "resolved" });
    const instance = new ToolBroker({
      bound: [bound(definition)],
      definitions: [definition],
      logger: log,
      transport,
      resolver: publicResolver,
      env: { TEST_TOOL_TOKEN: secret },
    });
    const result = await instance.call(
      {
        tool_id: "citation-resolver",
        binding_id: definition.id,
        binding_sha256: DIGEST,
        args: { query: "x" },
      },
      signal(),
    );
    expect(seen[0]!.headers.authorization).toBe(`Bearer ${secret}`);
    // The result, the call record and the descriptor carry only the fact that
    // a credential exists — never its value, and never its name.
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(JSON.stringify(instance.calls)).not.toContain(secret);
    const descriptor = describeBinding(definition, { env: { TEST_TOOL_TOKEN: secret } });
    expect(JSON.stringify(descriptor)).not.toContain(secret);
    expect(descriptor.credentials).toEqual({
      required: true,
      configured: true,
      source: "env:TEST_TOOL_TOKEN",
    });
  });

  it("refuses to call a binding whose credential is not configured", async () => {
    const definition: ToolBindingDefinition = {
      ...RESOLVER,
      credential: { kind: "env", name: "TEST_TOOL_TOKEN" },
    };
    const { transport, seen } = jsonTransport({});
    const instance = new ToolBroker({
      bound: [bound(definition)],
      definitions: [definition],
      logger: log,
      transport,
      resolver: publicResolver,
      env: {},
    });
    await expect(
      instance.call(
        {
          tool_id: "citation-resolver",
          binding_id: definition.id,
          binding_sha256: DIGEST,
          args: {},
        },
        signal(),
      ),
    ).rejects.toThrow(/tool_unavailable/u);
    expect(seen).toHaveLength(0);
    expect(credentialsReady([definition], [bound(definition)], {})).toEqual(["citation-resolver"]);
  });
});

describe("what the HTTP adapter will believe", () => {
  async function answer(body: unknown, init: { status?: number; contentType?: string } = {}) {
    const { transport } = jsonTransport(body, init);
    const instance = broker({ bound: [bound(RESOLVER)], transport, resolver: publicResolver });
    return instance.call(
      {
        tool_id: "citation-resolver",
        binding_id: RESOLVER.id,
        binding_sha256: DIGEST,
        args: { query: "x" },
      },
      signal(),
    );
  }

  it("accepts a JSON body on a contract status", async () => {
    await expect(answer({ status: "resolved" })).resolves.toMatchObject({
      status: "ok",
      transport_status: 200,
    });
    // A not-found or an upstream failure is schema-validated data, not an
    // exception: the package's own output schema decides.
    await expect(answer({ status: "not_found" }, { status: 404 })).resolves.toMatchObject({
      transport_status: 404,
    });
    await expect(answer({ status: "provider_error" }, { status: 502 })).resolves.toMatchObject({
      transport_status: 502,
    });
  });

  it.each([
    ["text/html", "tool_response_invalid"],
    ["", "tool_response_invalid"],
  ])("refuses a %s response", async (contentType, code) => {
    await expect(answer({ status: "resolved" }, { contentType })).rejects.toThrow(
      new RegExp(code, "u"),
    );
  });

  it("refuses a body that is not JSON", async () => {
    await expect(answer("{not json", {})).rejects.toThrow(/tool_response_invalid/u);
  });

  it.each([
    [500, "tool_unavailable"],
    [503, "tool_unavailable"],
    [401, "tool_unavailable"],
    [403, "tool_unavailable"],
    [418, "tool_transport_error"],
  ])("refuses HTTP %d", async (status, code) => {
    await expect(answer({}, { status })).rejects.toThrow(new RegExp(code, "u"));
  });

  it("refuses a redirect rather than following it", async () => {
    const transport: HttpTransport = async () => {
      throw Object.assign(new Error("tool_transport_error: redirect"), {
        code: "tool_transport_error",
        detail: "tool_transport_error: the tool host returned a redirect",
      });
    };
    const instance = broker({ bound: [bound(RESOLVER)], transport, resolver: publicResolver });
    await expect(
      instance.call(
        {
          tool_id: "citation-resolver",
          binding_id: RESOLVER.id,
          binding_sha256: DIGEST,
          args: {},
        },
        signal(),
      ),
    ).rejects.toThrow();
  });
});

describe("deadlines and cancellation", () => {
  it("stops a call when the run is cancelled, and says so", async () => {
    const controller = new AbortController();
    // An already-aborted signal must fail immediately, the way a real request
    // does; a transport that only listened for the event would hang forever.
    const transport: HttpTransport = (options) =>
      new Promise((_resolve, reject) => {
        if (options.signal.aborted) {
          reject(new Error("aborted"));
          return;
        }
        options.signal.addEventListener("abort", () => reject(new Error("aborted")), {
          once: true,
        });
      });
    const instance = broker({ bound: [bound(RESOLVER)], transport, resolver: publicResolver });
    const call = instance.call(
      { tool_id: "citation-resolver", binding_id: RESOLVER.id, binding_sha256: DIGEST, args: {} },
      controller.signal,
    );
    controller.abort();
    await expect(call).rejects.toThrow(/tool_cancelled/u);
    expect(instance.calls[0]!.outcome).toBe("failed");
  });

  it("stops a call that outlives the binding's own timeout", async () => {
    vi.useFakeTimers();
    try {
      const transport: HttpTransport = (options) =>
        new Promise((_resolve, reject) => {
          options.signal.addEventListener("abort", () => reject(new Error("aborted")), {
            once: true,
          });
        });
      const definition: ToolBindingDefinition = { ...RESOLVER, timeoutSeconds: 1 };
      const instance = new ToolBroker({
        bound: [bound(definition, { timeoutSeconds: 1 })],
        definitions: [definition],
        logger: log,
        transport,
        resolver: publicResolver,
      });
      const call = instance.call(
        {
          tool_id: "citation-resolver",
          binding_id: definition.id,
          binding_sha256: DIGEST,
          args: {},
        },
        signal(),
      );
      const assertion = expect(call).rejects.toThrow(/tool_timeout/u);
      await vi.advanceTimersByTimeAsync(2000);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("the registry this host publishes", () => {
  it("describes its built-ins without a credential, a header or a request template", () => {
    const registry = buildToolRegistry({ env: {} });
    expect(registry.schema).toBe("agentpkg-host-tool-registry-v0");
    expect(registry.bindings.map((item) => item.tool_id).sort()).toEqual([
      "citation-resolver",
      "paper-reader",
      "scholarly-search",
      "test.echo",
    ]);
    const text = JSON.stringify(registry).toLowerCase();
    for (const forbidden of ["bearer", "authorization", "api_key", "secret", "password"]) {
      expect(text).not.toContain(forbidden);
    }
    const resolver = registry.bindings.find((item) => item.tool_id === "citation-resolver")!;
    expect(resolver.remote).toBe(true);
    expect(resolver.endpoint?.method).toBe("POST");
    expect(resolver.contract.input_schema_sha256).toHaveLength(64);
    expect(resolver.credentials).toEqual({ required: false, configured: false, source: null });
    const echo = registry.bindings.find((item) => item.tool_id === "test.echo")!;
    expect(echo.remote).toBe(false);
    expect(echo.endpoint).toBeNull();
    const search = registry.bindings.find((item) => item.tool_id === "scholarly-search")!;
    expect(search.remote).toBe(true);
    expect(search.implementation_kind).toBe("json_http");
    expect(search.implementation_id).toBe("openclaw.tool.crossref_works_search");
    expect(search.endpoint).toEqual({ origin: "https://api.crossref.org", path: "/works", method: "GET" });
    // The request shape is code named by the implementation id, never a
    // template in the descriptor.
    expect(JSON.stringify(search)).not.toContain("query.bibliographic=");
    const reader = registry.bindings.find((item) => item.tool_id === "paper-reader")!;
    expect(reader.remote).toBe(false);
    expect(reader.implementation_kind).toBe("selected_file");
    expect(reader.endpoint).toBeNull();
    expect(reader.contract.permission_kinds).toEqual(["files.read"]);
  });

  it("lets an operator disable the broker entirely", () => {
    const registry = buildToolRegistry({ config: { enabled: false } });
    expect(registry.bindings).toEqual([]);
    expect(registry.notes[0]!.code).toBe("tools_disabled");
  });

  it("lets an operator retarget, relabel, bound and disable one binding", () => {
    const { definitions } = resolveBindings({
      bindings: [
        {
          toolId: "citation-resolver",
          origin: "https://resolver.example",
          path: "/v2/resolve",
          method: "POST",
          timeoutSeconds: 10,
          displayName: "Our mirror",
        },
        { toolId: "test.echo", enabled: false },
      ],
    });
    const resolver = definitions.find((item) => item.toolId === "citation-resolver")!;
    expect(resolver.origin).toBe("https://resolver.example");
    expect(resolver.path).toBe("/v2/resolve");
    expect(resolver.timeoutSeconds).toBe(10);
    expect(resolver.displayName).toBe("Our mirror");
    expect(definitions.find((item) => item.toolId === "test.echo")!.enabled).toBe(false);
  });

  it("refuses an unsafe configured origin and keeps the built-in", () => {
    for (const origin of [
      "http://resolver.example",
      "https://resolver.example/v1",
      "https://user:pw@resolver.example",
      "https://resolver.example:8443",
      "not a url",
    ]) {
      expect(safeOrigin(origin)).toBeNull();
      const { definitions, notes } = resolveBindings({
        bindings: [{ toolId: "citation-resolver", origin }],
      });
      expect(definitions.find((item) => item.toolId === "citation-resolver")!.origin).toBe(
        RESOLVER.origin,
      );
      expect(notes.some((note) => note.code === "binding_config_rejected")).toBe(true);
    }
  });

  it("cannot be given an implementation configuration alone does not have", () => {
    const { definitions, notes } = resolveBindings({
      bindings: [{ toolId: "weather-lookup", origin: "https://api.example" }],
    });
    expect(definitions.some((item) => item.toolId === "weather-lookup")).toBe(false);
    expect(notes.some((note) => note.code === "binding_unknown")).toBe(true);
  });

  it("marks a binding whose credential is missing as unavailable rather than hiding it", () => {
    const definition: ToolBindingDefinition = {
      ...RESOLVER,
      credential: { kind: "env", name: "TEST_TOOL_TOKEN" },
    };
    const descriptor = describeBinding(definition, { env: {} });
    expect(descriptor.available).toBe(false);
    expect(descriptor.availability_reason).toContain("credential");
    expect(descriptor.credentials.configured).toBe(false);
  });
});

describe("the probe's fixtures", () => {
  it("are host-owned, and a tool without one cannot be probed", () => {
    expect(fixturesFor("citation-resolver").length).toBeGreaterThan(0);
    expect(fixturesFor("scholarly-search").length).toBeGreaterThan(0);
    expect(fixturesFor("weather-lookup")).toEqual([]);
    expect(() => pickFixture("weather-lookup")).toThrow(/no probe fixture/u);
    // A file-reading fixture carries no file of its own; the host binds one.
    const reader = pickFixture("paper-reader", "selected-pdf");
    expect(reader.requiresFile).toBe(true);
    expect(() => pickFixture("citation-resolver", "nope")).toThrow(/Unknown probe fixture/u);
    expect(pickFixture("citation-resolver", "doi").args).toMatchObject({
      query: "10.1038/nphys1170",
    });
  });

  it("carry no URL, method, header or endpoint of their own", () => {
    for (const fixture of TOOL_PROBE_FIXTURES) {
      const text = JSON.stringify({ args: fixture.args, input: fixture.workflowInput });
      for (const forbidden of ["http", "://", "header", "authorization", "endpoint"]) {
        expect(text.toLowerCase()).not.toContain(forbidden);
      }
    }
  });
});
