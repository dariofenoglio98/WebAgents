/**
 * The tool boundary end to end with a deterministic host: a signed one-tool package through
 * the real runtime, the broker's refusals before anything runs, the HTTP adapter's policy over
 * a scripted transport, the host-resource adapter's attribution rules, and the sealed-value
 * egress guard inside a real run.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { JsonObject, JsonValue } from "../../../src/core/json.js";
import type { HttpRequest, HttpTransport } from "../../../src/core/models/transport.js";
import { jsonHttpCall, toolError as toolErrorFor } from "../../../src/core/tools/adapters/json-http.js";
import { BoundToolHandler, ECHO_IMPLEMENTATION, toolHandlers, type BrokerDeps } from "../../../src/core/tools/broker.js";
import { bindingDigest, describeDefinition, parseOperatorBindings, type ToolImplementationDefinition } from "../../../src/core/tools/definitions.js";
import type { ToolContext } from "../../../src/core/tools/handler.js";
import { Pacer } from "../../../src/core/tools/pacer.js";
import { MemoryResourceStore } from "../../../src/core/tools/resources.js";
import { CancelToken } from "../../../src/core/workflow/cancel.js";
import { AdapterError, CancelledError } from "../../../src/core/workflow/errors.js";
import { runWorkflow } from "../../../src/core/workflow/interpreter.js";
import { ROOT } from "../../helpers/paths.js";
import { definitionFor, ECHO_INPUT, ECHO_TOOL, echoPackage, planBindingFor } from "../../helpers/echo-package.js";
import { Workflow, type WorkflowOptions } from "../../../src/core/workflow/interpreter.js";
import type { Package } from "../../../src/core/package.js";
import { openRuntime, sessionGrants } from "../../helpers/workflow.js";

const ECHO_BUILTINS = { [ECHO_IMPLEMENTATION]: (args: JsonValue) => args };

/** Run the echo package (which has no fixture) and return the classified failure. */
async function echoFailing(pkg: Package, options: WorkflowOptions): Promise<{ code?: string; execution_report?: Record<string, unknown> }> {
  try {
    await runWorkflow(pkg, ECHO_INPUT, { grants: sessionGrants(pkg), ...options });
  } catch (error) {
    return error as { code?: string; execution_report?: Record<string, unknown> };
  }
  throw new Error("expected the run to fail");
}

function scripted(answer: (request: HttpRequest) => { status: number; headers?: Record<string, string>; body: string }): { transport: HttpTransport; requests: HttpRequest[] } {
  const requests: HttpRequest[] = [];
  const transport: HttpTransport = async (request) => {
    requests.push(request);
    if (request.signal.aborted) throw request.signal.reason;
    const { status, headers, body } = answer(request);
    return { status, headers: { "content-type": "application/json", ...(headers ?? {}) }, body };
  };
  return { transport, requests };
}

const context = { role: "EchoWorker", worker_id: "EchoWorker:1", event: () => undefined };

describe("a declared, approved, bound tool runs through the generic runtime", () => {
  it("completes the echo package with one local builtin call and records which implementation answered", async () => {
    const { pkg } = await echoPackage();
    const definition = definitionFor(pkg, ECHO_TOOL);
    const { handlers, bound } = toolHandlers([planBindingFor(pkg, definition)], { definitions: [definition], builtins: ECHO_BUILTINS, pacer: new Pacer() });
    const result = await runWorkflow(pkg, ECHO_INPUT, { handlers, grants: sessionGrants(pkg), approvedTools: [ECHO_TOOL] });
    expect(result.status).toBe("completed");
    expect(result.output).toEqual(ECHO_INPUT);
    expect(result.usage.tool_calls).toEqual({ [ECHO_TOOL]: 1 });
    expect(result.usage.remote_calls).toBe(0); // A local binding must not consume the remote-call budget.
    const actions = result.audit.map((event) => event.action);
    expect(actions.filter((action) => action === "tool.dispatched")).toHaveLength(1);
    expect(actions.filter((action) => action === "tool.settled")).toHaveLength(1);
    expect(actions.filter((action) => action === "tool.called")).toHaveLength(1);
    const dispatched = result.audit.find((event) => event.action === "tool.dispatched")!;
    expect(dispatched.binding_sha256).toHaveLength(64);
    expect(dispatched.remote).toBe(false);
    expect(bound[0]!.calls).toEqual([expect.objectContaining({ tool_id: ECHO_TOOL, outcome: "ok", transport_status: null })]);
  });

  it("refuses the run when the tool is not approved, and nothing reaches the implementation", async () => {
    const { pkg } = await echoPackage();
    let reached = 0;
    const definition = definitionFor(pkg, ECHO_TOOL);
    const { handlers } = toolHandlers([planBindingFor(pkg, definition)], {
      definitions: [definition],
      builtins: {
        [ECHO_IMPLEMENTATION]: () => {
          reached += 1;
          return {};
        },
      },
    });
    const failure = await echoFailing(pkg, { handlers, approvedTools: [] });
    expect(failure.code).toBe("permission_denied");
    expect(reached).toBe(0);
  });

  it("refuses bindings that name a missing or changed implementation before anything runs", async () => {
    const { pkg } = await echoPackage();
    const definition = definitionFor(pkg, ECHO_TOOL);
    const binding = planBindingFor(pkg, definition);
    expect(() => toolHandlers([binding], { definitions: [] })).toThrow(/tool_not_bound|no implementation/u);
    const changed: ToolImplementationDefinition = { ...definition, timeoutSeconds: definition.timeoutSeconds + 1 };
    try {
      toolHandlers([binding], { definitions: [changed] });
      expect.unreachable();
    } catch (error) {
      expect((error as AdapterError).code).toBe("tool_binding_stale");
    }
    const retargeted: ToolImplementationDefinition = { ...definition, toolId: "another" };
    expect(() => toolHandlers([{ ...binding, binding_sha256: bindingDigest(describeDefinition(retargeted)) }], { definitions: [retargeted] })).toThrow(/no longer serves/u);
  });

  it("an output that fails the package schema fails the run; a host refusal keeps its code as tool_error", async () => {
    const { pkg } = await echoPackage();
    const definition = definitionFor(pkg, ECHO_TOOL);
    const bad = toolHandlers([planBindingFor(pkg, definition)], { definitions: [definition], builtins: { [ECHO_IMPLEMENTATION]: () => ({ value: 42 }) } });
    const invalid = await echoFailing(pkg, { handlers: bad.handlers, approvedTools: [ECHO_TOOL] });
    expect(invalid.code).toBe("schema_validation");
    const down = toolHandlers([planBindingFor(pkg, definition)], {
      definitions: [definition],
      builtins: {
        [ECHO_IMPLEMENTATION]: () => {
          throw new AdapterError("tool_unavailable", "the implementation is down");
        },
      },
    });
    const failed = await echoFailing(pkg, { handlers: down.handlers, approvedTools: [ECHO_TOOL] });
    expect(failed.code).toBe("tool_error");
    const event = (failed.execution_report!.audit as JsonObject[]).find((item) => item.action === "tool.failed")!;
    expect(event.reason).toBe("tool_unavailable");
  });

  it("cancellation reaches the in-flight implementation and the run reports cancelled", async () => {
    const { pkg } = await echoPackage();
    const definition = definitionFor(pkg, ECHO_TOOL);
    let aborted = false;
    const { handlers } = toolHandlers([planBindingFor(pkg, definition)], { definitions: [definition], builtins: { [ECHO_IMPLEMENTATION]: () => new Promise(() => undefined) } });
    // Wrap the handler to observe the signal the runtime hands down.
    const observed = { ...handlers, [definition.binding]: async (ctx: ToolContext, payload: JsonValue, signal: AbortSignal) => {
      signal.addEventListener("abort", () => (aborted = true));
      return handlers[definition.binding]!(ctx, payload, signal);
    } };
    const workflow = await Workflow.create(pkg, { handlers: observed, grants: sessionGrants(pkg), approvedTools: [ECHO_TOOL] });
    const running = workflow.run(ECHO_INPUT);
    await new Promise((resolve) => setTimeout(resolve, 20));
    workflow.cancel();
    await expect(running).rejects.toBeInstanceOf(CancelledError);
    expect(aborted).toBe(true);
  });
});

describe("the JSON HTTP adapter's policy", () => {
  const definition: ToolImplementationDefinition = {
    id: "demo:service:1",
    toolId: "service",
    binding: "service.call",
    kind: "json_http",
    implementationId: "openclaw.tool.json_http",
    implementationVersion: "0.1.0",
    displayName: "Service",
    origin: "https://service.example",
    path: "/v1/call",
    method: "POST",
    inputSchemaSha256: null,
    outputSchemaSha256: null,
    permissionKinds: ["network"],
    sideEffects: "read",
    timeoutSeconds: 10,
    maxRequestBytes: 256,
    maxResponseBytes: 1024,
  };

  it("sends one POST with a fixed header set and the arguments as the body, and returns data statuses", async () => {
    const net = scripted(() => ({ status: 404, body: '{"status":"not_found"}' }));
    const observed: unknown[] = [];
    const { output, status } = await jsonHttpCall({ definition, args: { q: "x" }, transport: net.transport, signal: new AbortController().signal, observe: (request) => observed.push(request) });
    expect(status).toBe(404);
    expect(output).toEqual({ status: "not_found" });
    const request = net.requests[0]!;
    expect(request.url).toBe("https://service.example/v1/call");
    expect(request.method).toBe("POST");
    expect(request.body).toBe('{"q":"x"}');
    expect(Object.keys(request.headers).sort()).toEqual(["accept", "content-type", "user-agent"]);
    expect(request.maxResponseBytes).toBe(1024);
    expect(observed).toEqual([{ tool_id: "service", binding_id: "demo:service:1", url: "https://service.example/v1/call", body: '{"q":"x"}' }]);
  });

  const statuses: Array<[number, string, string]> = [
    [500, "tool_unavailable", "status"],
    [401, "tool_unavailable", "status"],
    [403, "tool_unavailable", "status"],
    [418, "tool_transport_error", "status"],
    [302, "tool_transport_error", "status"],
  ];
  for (const [status, code, stage] of statuses) {
    it(`HTTP ${status} is ${code}`, async () => {
      const net = scripted(() => ({ status, body: "{}" }));
      try {
        await jsonHttpCall({ definition, args: {}, transport: net.transport, signal: new AbortController().signal });
        expect.unreachable();
      } catch (error) {
        expect((error as AdapterError).code).toBe(code);
        expect((error as AdapterError).audit_facts).toMatchObject({ stage, http_status: status });
      }
    });
  }

  it("refuses a non-JSON content type, invalid JSON, an oversized body and oversized arguments", async () => {
    const html = scripted(() => ({ status: 200, headers: { "content-type": "text/html" }, body: "<html>" }));
    await expect(jsonHttpCall({ definition, args: {}, transport: html.transport, signal: new AbortController().signal })).rejects.toMatchObject({ code: "tool_response_invalid", audit_facts: { stage: "content_type", content_type: "html" } });
    const broken = scripted(() => ({ status: 200, body: "{nope" }));
    await expect(jsonHttpCall({ definition, args: {}, transport: broken.transport, signal: new AbortController().signal })).rejects.toMatchObject({ code: "tool_response_invalid", audit_facts: { stage: "json_parse", json_parsed: false } });
    const big = scripted(() => ({ status: 200, body: JSON.stringify({ pad: "x".repeat(2000) }) }));
    await expect(jsonHttpCall({ definition, args: {}, transport: big.transport, signal: new AbortController().signal })).rejects.toMatchObject({ code: "tool_response_invalid", audit_facts: { stage: "body_size", body_exceeded: true } });
    const net = scripted(() => ({ status: 200, body: "{}" }));
    await expect(jsonHttpCall({ definition, args: { pad: "x".repeat(300) }, transport: net.transport, signal: new AbortController().signal })).rejects.toMatchObject({ code: "tool_request_invalid" });
    expect(net.requests).toHaveLength(0);
  });

  it("attaches a credential as a header the arguments never see, and refuses to run without one", async () => {
    const net = scripted(() => ({ status: 200, body: "{}" }));
    const secured: ToolImplementationDefinition = { ...definition, credential: { kind: "env", name: "TOKEN" } };
    await jsonHttpCall({ definition: secured, args: {}, transport: net.transport, signal: new AbortController().signal, credential: "s3cret" });
    expect(net.requests[0]!.headers.authorization).toBe("Bearer s3cret");
    expect(net.requests[0]!.body).not.toContain("s3cret");
    try {
      await jsonHttpCall({ definition: secured, args: {}, transport: net.transport, signal: new AbortController().signal, credential: null });
      expect.unreachable();
    } catch (error) {
      expect((error as AdapterError).code).toBe("tool_unavailable");
      expect((error as AdapterError).message).not.toContain("s3cret");
    }
  });

  it("refuses an unusable endpoint and a cancelled call before any request", async () => {
    const net = scripted(() => ({ status: 200, body: "{}" }));
    await expect(jsonHttpCall({ definition: { ...definition, origin: "http://service.example" }, args: {}, transport: net.transport, signal: new AbortController().signal })).rejects.toMatchObject({ code: "tool_unavailable" });
    const controller = new AbortController();
    controller.abort(new CancelledError());
    await expect(jsonHttpCall({ definition, args: {}, transport: net.transport, signal: controller.signal })).rejects.toBeInstanceOf(CancelledError);
    const plain = new AbortController();
    plain.abort();
    await expect(jsonHttpCall({ definition, args: {}, transport: net.transport, signal: plain.signal })).rejects.toMatchObject({ code: "tool_cancelled" });
    expect(net.requests).toHaveLength(0);
  });
});

describe("the binding's own deadline (review 1, finding 5)", () => {
  const hanging = { [ECHO_IMPLEMENTATION]: () => new Promise<JsonValue>(() => undefined) };

  it("bounds the dispatch: a one-second binding ends a never-settling call as tool_timeout, long before the package's 10 s", async () => {
    const { pkg } = await echoPackage();
    const definition = { ...definitionFor(pkg, ECHO_TOOL), timeoutSeconds: 1 };
    const { handlers } = toolHandlers([planBindingFor(pkg, definition)], { definitions: [definition], builtins: hanging, pacer: new Pacer() });
    const started = Date.now();
    const failure = await echoFailing(pkg, { handlers, approvedTools: [ECHO_TOOL] });
    expect(Date.now() - started).toBeLessThan(5000);
    expect(failure.code).toBe("tool_error");
    const failed = (failure.execution_report!.audit as JsonObject[]).find((event) => event.action === "tool.failed")!;
    expect(failed.reason).toBe("tool_timeout");
    expect(failed.failure_facts).toMatchObject({ stage: "timeout", timeout: true });
  });

  it("bounds the wait for a slot too, and cancellation still wins over the deadline", async () => {
    const { pkg } = await echoPackage();
    // One slot for the implementation: a five-second binding holds it, a one-second binding waits for it.
    const slow = { ...definitionFor(pkg, ECHO_TOOL), timeoutSeconds: 5, maxConcurrent: 1 };
    const quick = { ...slow, timeoutSeconds: 1 };
    const pacer = new Pacer();
    const holder = new BoundToolHandler(planBindingFor(pkg, slow), slow, { definitions: [slow], builtins: hanging, pacer });
    const waiter = new BoundToolHandler(planBindingFor(pkg, quick), quick, { definitions: [quick], builtins: hanging, pacer });
    const holding = new AbortController();
    const held = holder.call(context, { value: "a" }, holding.signal);
    const started = Date.now();
    await expect(waiter.call(context, { value: "b" }, new AbortController().signal)).rejects.toMatchObject({ code: "tool_timeout", message: "the call waited for its turn longer than the binding allows", audit_facts: { stage: "timeout", timeout: true } });
    expect(Date.now() - started).toBeLessThan(4000);
    holding.abort(new CancelledError());
    await expect(held).rejects.toBeInstanceOf(CancelledError);
    expect(waiter.calls.map((call) => call.outcome)).toEqual(["failed"]);
    expect(holder.calls.map((call) => call.outcome)).toEqual(["failed"]);
  });

  it("relabels only the deadline's own rejection as tool_timeout; another error settling after the deadline keeps its name (T4 review 2, nit 7)", async () => {
    const { pkg } = await echoPackage();
    const definition = { ...definitionFor(pkg, ECHO_TOOL), timeoutSeconds: 1 };
    // A pacer that answers the deadline with its own refusal: the deadline has fired, the error is not its reason.
    const pacer = { acquire: (_key: string, _limits: unknown, signal: AbortSignal) => new Promise<() => void>((_resolve, reject) => signal.addEventListener("abort", () => reject(toolErrorFor("tool_unavailable", "the lane closed")), { once: true })) } as unknown as Pacer;
    const handler = new BoundToolHandler(planBindingFor(pkg, definition), definition, { definitions: [definition], builtins: ECHO_BUILTINS, pacer });
    await expect(handler.call(context, { value: "a" }, new AbortController().signal)).rejects.toMatchObject({ code: "tool_unavailable", message: "the lane closed" });
    // The deadline's own rejection is the timeout.
    const waiting = { acquire: (_key: string, _limits: unknown, signal: AbortSignal) => new Promise<() => void>((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true })) } as unknown as Pacer;
    const timed = new BoundToolHandler(planBindingFor(pkg, definition), definition, { definitions: [definition], builtins: ECHO_BUILTINS, pacer: waiting });
    await expect(timed.call(context, { value: "a" }, new AbortController().signal)).rejects.toMatchObject({ code: "tool_timeout" });
  });

  it("reads the described limits once: a later change to the host's describe options does not move the enforced cap (T4 review 2, nit 8)", async () => {
    const { pkg } = await echoPackage({ remoteOrigin: "https://service.example" });
    const definition = definitionFor(pkg, ECHO_TOOL);
    const net = scripted(() => ({ status: 200, body: JSON.stringify({ value: "y".repeat(150) }) }));
    const describe = { maxResponseBytes: 4096 };
    const handler = new BoundToolHandler(planBindingFor(pkg, definition, { binding_sha256: bindingDigest(describeDefinition(definition, describe)) }), definition, { definitions: [definition], transport: net.transport, pacer: new Pacer(), describe });
    describe.maxResponseBytes = 128; // mutated after construction: the handler keeps the limits the plan approved
    expect(await handler.call(context, { value: "a" }, new AbortController().signal)).toEqual({ value: "y".repeat(150) });
    expect(net.requests.map((request) => request.maxResponseBytes)).toEqual([4096]);
  });

  it("enforces the response cap the plan approved: the host ceiling when it is the smaller (review 1, nit 10)", async () => {
    const { pkg } = await echoPackage({ remoteOrigin: "https://service.example" });
    const definition = definitionFor(pkg, ECHO_TOOL);
    expect(definition.kind).toBe("json_http");
    const net = scripted(() => ({ status: 200, body: JSON.stringify({ value: "y".repeat(150) }) }));
    const run = async (ceiling: number) => {
      const describe = { maxResponseBytes: ceiling };
      const binding = planBindingFor(pkg, definition, { binding_sha256: bindingDigest(describeDefinition(definition, describe)) });
      const { handlers } = toolHandlers([binding], { definitions: [definition], transport: net.transport, pacer: new Pacer(), describe });
      try {
        return await runWorkflow(pkg, ECHO_INPUT, { handlers, grants: sessionGrants(pkg), approvedTools: [ECHO_TOOL] });
      } catch (error) {
        return error as { code?: string; execution_report?: Record<string, unknown> };
      }
    };
    expect((await run(4096)) as { status?: string }).toMatchObject({ status: "completed" });
    const refused = (await run(128)) as { code?: string; execution_report?: Record<string, unknown> };
    expect(refused.code).toBe("tool_error");
    const failed = (refused.execution_report!.audit as JsonObject[]).find((event) => event.action === "tool.failed")!;
    expect(failed.reason).toBe("tool_response_invalid");
    expect(failed.failure_facts).toMatchObject({ stage: "body_size", body_exceeded: true });
    // The transport was asked for the approved cap, not the definition's default.
    expect(net.requests.map((request) => request.maxResponseBytes)).toEqual([4096, 128]);
  });
});

describe("pacing follows what reached the service", () => {
  it("a request the adapter refuses locally gives its slot back as unsent; one that was sent, as answered (T6 review, nit 4)", async () => {
    const { pkg } = await echoPackage({ remoteOrigin: "https://service.example" });
    // A binding whose request bound a long value exceeds: refused before any request leaves.
    const definition = { ...definitionFor(pkg, ECHO_TOOL), maxRequestBytes: 32 };
    const net = scripted(() => ({ status: 200, body: JSON.stringify({ value: "ok" }) }));
    const released: Array<boolean | undefined> = [];
    const recording = { acquire: async () => (answered?: boolean) => void released.push(answered) } as unknown as Pacer;
    const handler = new BoundToolHandler(planBindingFor(pkg, definition), definition, { definitions: [definition], transport: net.transport, pacer: recording });
    await expect(handler.call(context, { value: "x".repeat(100) }, new AbortController().signal)).rejects.toMatchObject({ code: "tool_request_invalid" });
    expect(net.requests).toHaveLength(0);
    expect(await handler.call(context, { value: "a" }, new AbortController().signal)).toEqual({ value: "ok" });
    expect(net.requests).toHaveLength(1);
    // `false` starts no interval (the pacer's own tests cover what each value does).
    expect(released).toEqual([false, true]);
  });
});

describe("WebAir through operator bindings and a scripted origin", () => {
  it("binds the four demo tools and completes a search by replaying the fixture's answers over HTTP", async () => {
    const { loadPackageBytes } = await import("../../../src/core/package.js");
    const pkg = await loadPackageBytes(new Uint8Array(readFileSync(join(ROOT, "dist", "webair-0.4.0.agent.pkg"))));
    const fixture = JSON.parse(new TextDecoder().decode(pkg.files.get("fixtures/workflow.json")!)) as JsonObject;
    const definitions = parseOperatorBindings(JSON.parse(readFileSync(join(ROOT, "demo", "webair", "host-bindings.json"), "utf8")));
    const bindings = definitions.map((definition) => planBindingFor(pkg, definition));
    const byPath: Record<string, JsonObject[]> = { "/api/v1/search_flights": (fixture.tools as JsonObject)["search-flights"] as JsonObject[], "/api/v1/get_fare_rules": (fixture.tools as JsonObject)["get-fare-rules"] as JsonObject[] };
    const net = scripted((request) => {
      const cases = byPath[new URL(request.url).pathname] ?? [];
      const sent = JSON.parse(request.body!) as JsonValue;
      const match = cases.find((item) => JSON.stringify(item.input) === JSON.stringify(sent));
      return match ? { status: 200, body: JSON.stringify(match.output) } : { status: 404, body: '{"error":"no fixture"}' };
    });
    const { handlers } = toolHandlers(bindings, { definitions, transport: net.transport, pacer: new Pacer() });
    const { fixtureAdapters } = await import("../../../src/core/fixtures.js");
    const { router, input } = fixtureAdapters(pkg);
    const grants = JSON.parse(readFileSync(join(ROOT, "examples", "webair-0.2.0-grants.json"), "utf8")) as Record<string, "session" | "deny">;
    const result = await runWorkflow(pkg, input, { router, handlers, grants, approvedTools: ["search-flights", "get-fare-rules"] });
    expect(result.status).toBe("completed");
    expect(result.usage.tool_calls).toEqual({ "search-flights": 1, "get-fare-rules": 3 });
    expect(result.usage.remote_calls).toBe(4);
    expect(net.requests.every((request) => request.url.startsWith("https://webagents-webair-production.up.railway.app/api/v1/"))).toBe(true);
    expect(net.requests.every((request) => !("authorization" in request.headers) && !("cookie" in request.headers))).toBe(true);
    const settled = result.audit.filter((event) => event.action === "tool.settled");
    expect(settled).toHaveLength(4);
    expect(settled.every((event) => event.transport_status === 200 && event.remote === true)).toBe(true);
  });
});

describe("host resources through the broker", () => {
  const DOCUMENT = JSON.parse(readFileSync(join(ROOT, "demo", "webair", "host-resources.json"), "utf8")) as JsonObject;

  async function setup() {
    const store = await MemoryResourceStore.load(DOCUMENT, { key: new Uint8Array(32).fill(9) });
    const definitions = store.bindings();
    const passenger = definitions.find((definition) => definition.resourceType === "personal.passenger_identity")!;
    const view = store.describe((DOCUMENT.resources as JsonObject[]).find((resource) => resource.type === "personal.passenger_identity")!.id as string)!;
    const grant = { permission_id: "identity.passenger", resource_type: view.type, resource_id: view.id, resource_digest: view.digest };
    const { loadPackageBytes } = await import("../../../src/core/package.js");
    const pkg = await loadPackageBytes(new Uint8Array(readFileSync(join(ROOT, "dist", "webair-0.4.0.agent.pkg"))));
    const binding = planBindingFor(pkg, passenger);
    return { store, passenger, grant, binding, pkg };
  }

  it("returns the one granted resource with no arguments, attributes it, and records the grant, not the value", async () => {
    const { store, passenger, grant, binding } = await setup();
    const events: Array<[string, Record<string, unknown>]> = [];
    const handler = new BoundToolHandler(binding, passenger, { definitions: [passenger], resources: { grants: [grant], resolver: store }, pacer: new Pacer() });
    const output = (await handler.call({ ...context, event: (action, metadata) => events.push([action, metadata ?? {}]) }, {}, new AbortController().signal)) as JsonObject;
    expect(typeof output.contact_email).toBe("string");
    const settled = events.find(([action]) => action === "tool.settled")![1];
    expect(settled.resource_id).toBe(grant.resource_id);
    expect(settled.resource_digest).toBe(grant.resource_digest);
    expect(JSON.stringify(events)).not.toContain(output.contact_email as string);
    await expect(handler.call(context, { id: "other" }, new AbortController().signal)).rejects.toMatchObject({ code: "tool_request_invalid" });
  });

  it("refuses when the run holds no grant for that type, when the grant's permission is not linked, and when the digest changed", async () => {
    const { store, passenger, grant, binding } = await setup();
    const none = new BoundToolHandler(binding, passenger, { definitions: [passenger], resources: { grants: [], resolver: store }, pacer: new Pacer() });
    await expect(none.call(context, {}, new AbortController().signal)).rejects.toMatchObject({ code: "tool_request_invalid" });
    const unlinked = new BoundToolHandler({ ...binding, required_permission_ids: ["network.webair"] }, passenger, { definitions: [passenger], resources: { grants: [grant], resolver: store }, pacer: new Pacer() });
    await expect(unlinked.call(context, {}, new AbortController().signal)).rejects.toMatchObject({ code: "tool_request_invalid" });
    const stale = new BoundToolHandler(binding, passenger, { definitions: [passenger], resources: { grants: [{ ...grant, resource_digest: "0".repeat(64) }], resolver: store }, pacer: new Pacer() });
    await expect(stale.call(context, {}, new AbortController().signal)).rejects.toMatchObject({ code: "tool_unavailable" });
  });

  it("the egress guard refuses a sealed value inside a real run before the tool is reached", async () => {
    const { store } = await setup();
    const email = ((DOCUMENT.resources as JsonObject[]).find((resource) => resource.type === "personal.passenger_identity")!.value as JsonObject).contact_email as string;
    const { pkg } = await echoPackage({ freeText: true });
    const definition = definitionFor(pkg, ECHO_TOOL);
    let reached = 0;
    const deps: BrokerDeps = {
      definitions: [definition],
      builtins: {
        [ECHO_IMPLEMENTATION]: (args) => {
          reached += 1;
          return args;
        },
      },
      resources: { grants: [], resolver: store },
      pacer: new Pacer(),
    };
    const { handlers } = toolHandlers([planBindingFor(pkg, definition)], deps);
    const failure = await (async () => {
      try {
        await runWorkflow(pkg, { value: `please contact ${email} today` }, { handlers, grants: sessionGrants(pkg), approvedTools: [ECHO_TOOL] });
      } catch (error) {
        return error as { code?: string; execution_report?: Record<string, unknown> };
      }
      throw new Error("expected a refusal");
    })();
    expect(failure.code).toBe("tool_error");
    expect(reached).toBe(0);
    const audit = failure.execution_report!.audit as JsonObject[];
    expect(audit.find((event) => event.action === "tool.failed")!.reason).toBe("tool_request_invalid");
    expect(JSON.stringify(audit)).not.toContain(email);
    // The same value with the resource granted under a permission the tool links passes the guard.
    const ok = await runWorkflow(pkg, { value: "hello" }, { handlers, grants: sessionGrants(pkg), approvedTools: [ECHO_TOOL] });
    expect(ok.status).toBe("completed");
  });

  it("the runtime's own tool path also refuses a sealed value through Runtime.callTool", async () => {
    const { store } = await setup();
    const { pkg } = await echoPackage({ freeText: true });
    const definition = definitionFor(pkg, ECHO_TOOL);
    const { handlers } = toolHandlers([planBindingFor(pkg, definition)], { definitions: [definition], builtins: ECHO_BUILTINS, resources: { grants: [], resolver: store }, pacer: new Pacer() });
    const paymentId = ((DOCUMENT.resources as JsonObject[]).find((resource) => resource.type === "wallet.payment_method")!.value as JsonObject).payment_method_id as string;
    const { runtime, close } = await openRuntime(pkg, { grants: sessionGrants(pkg), handlers, approvedTools: [ECHO_TOOL] });
    try {
      await expect(runtime.runWorker("EchoWorker", { request: { value: "x" } }, (ctx, _data, t) => ctx.tool(ECHO_TOOL, { value: `card ${paymentId}` }, t ?? new CancelToken()))).rejects.toMatchObject({ code: "tool_request_invalid" });
    } finally {
      close();
    }
  });
});
