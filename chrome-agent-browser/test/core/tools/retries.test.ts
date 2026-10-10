/**
 * Read-only tool calls that fail transiently are tried again, up to twice (D-152), and a
 * `citation.resolve` call whose resolver stays unavailable for a DOI is answered by the host's
 * built-in Crossref lookup when the package declares Crossref's domain (D-153). Every case runs the
 * host's real tool path (registry, decisions, frozen plan records, broker) over a scripted network,
 * through the runtime, so budgets, deadlines, schemas and the audit are the real ones.
 */
import { describe, expect, it } from "vitest";

import { canonicalJson } from "../../../src/core/canonical.js";
import { sha256HexSync } from "../../../src/core/hash.js";
import { buildHostToolRegistry, evaluateRegistry, normalizeBinding, planToolBindings } from "../../../src/core/hosttools.js";
import type { JsonObject, JsonValue } from "../../../src/core/json.js";
import { TransportError, type HttpRequest } from "../../../src/core/models/transport.js";
import { BIBTEX_WARNING, crossrefDoiLookup, doiQuery, FALLBACK_WARNING, paperFromWork, parseDoi, pyQuote } from "../../../src/core/tools/adapters/crossref-doi.js";
import { jsonHttpCall, retryAfterMs, toolError } from "../../../src/core/tools/adapters/json-http.js";
import { MAX_TOOL_RETRIES, RETRY_BACKOFF_MS, toolHandlers, transientFailure } from "../../../src/core/tools/broker.js";
import { normalizeToolBindings } from "../../../src/core/tools/bindings.js";
import { bindingDigest, definitionsFromRegistry, describeDefinition, type ToolImplementationDefinition } from "../../../src/core/tools/definitions.js";
import { Pacer } from "../../../src/core/tools/pacer.js";
import type { ToolCallBounds, ToolContext } from "../../../src/core/tools/handler.js";
import { runWorkflow } from "../../../src/core/workflow/interpreter.js";
import { AdapterError, CancelledError } from "../../../src/core/workflow/errors.js";
import { citationFiles, citationPackage, json, RESOLVED, RESOLVER_HOST, runCitations, scriptedNetwork, SEARCH_ANSWER, text, work, type Script } from "../../helpers/citation-package.js";
import { change } from "../../helpers/source-tree.js";

const DOI = "10.1145/3442188.3445922";
const input = (identifiers: string[]) => ({ query: "prompt injection defenses", identifiers });
const okSearch = () => json(200, SEARCH_ANSWER);
const events = (audit: Array<Record<string, unknown>>, action: string) => audit.filter((event) => event.action === action);
const down = () => new TransportError("the connection to the destination failed", { stage: "transport" });

/** A sleep that records each wait and returns at once (the backoff is asserted, not waited for). */
function fakeSleep(): { sleep: (ms: number, signal: AbortSignal) => Promise<void>; waits: number[] } {
  const waits: number[] = [];
  return { waits, sleep: async (ms) => void waits.push(ms) };
}

describe("which failures are transient (D-152)", () => {
  const cases: Array<[string, AdapterError | Error, JsonValue]> = [
    ["429, its body refused for its type", toolError("tool_response_invalid", "x", { http_status: 429, stage: "content_type" }), { reason: "http_status", http_status: 429 }],
    ["500 refused by status", toolError("tool_unavailable", "x", { http_status: 500, stage: "status" }), { reason: "http_status", http_status: 500 }],
    ["502 the adapter did not take as data", toolError("tool_unavailable", "x", { http_status: 502, stage: "status" }), { reason: "http_status", http_status: 502 }],
    ["503 with a Retry-After", toolError("tool_unavailable", "x", { http_status: 503, stage: "status" }, { retry_after_ms: 2000 }), { reason: "http_status", http_status: 503, retry_after_ms: 2000 }],
    ["504, invalid JSON", toolError("tool_response_invalid", "x", { http_status: 504, stage: "json_parse" }), { reason: "http_status", http_status: 504 }],
    ["a connection or read failure", toolError("tool_transport_error", "x", { stage: "transport" }), { reason: "transport" }],
    ["the binding's own deadline while the request was out", toolError("tool_timeout", "x"), { reason: "timeout" }],
    ["a deadline while waiting for its pacing turn", toolError("tool_timeout", "x", {}, { pacer_wait: true }), null],
    ["a TLS failure", toolError("tool_transport_error", "x", { stage: "tls" }), null],
    ["an address-policy refusal", toolError("tool_transport_error", "x", { stage: "address_policy" }), null],
    ["401", toolError("tool_unavailable", "x", { http_status: 401, stage: "status" }), null],
    ["404 refused for its type", toolError("tool_response_invalid", "x", { http_status: 404, stage: "content_type" }), null],
    ["a redirect", toolError("tool_transport_error", "x", { http_status: 302, stage: "status" }), null],
    ["a 200 that is not JSON", toolError("tool_response_invalid", "x", { http_status: 200, stage: "json_parse" }), null],
    ["a 200 too large", toolError("tool_response_invalid", "x", { http_status: 200, stage: "body_size" }), null],
    ["a request refused locally", toolError("tool_request_invalid", "x"), null],
    ["a stale binding", new AdapterError("tool_binding_stale", "x"), null],
    ["a cancellation", toolError("tool_cancelled", "x"), null],
    ["the runtime's cancellation", new CancelledError(), null],
    ["anything else", new Error("x"), null],
  ];
  for (const [title, error, expected] of cases) {
    it(title, () => {
      expect(transientFailure(error)).toEqual(expected);
    });
  }
});

describe("a server's Retry-After (D-152)", () => {
  it("is read as delay-seconds or an HTTP-date, never from anything else", () => {
    const now = Date.parse("2026-10-10T12:00:00Z");
    expect(retryAfterMs("2", now)).toBe(2000);
    expect(retryAfterMs(" 0 ", now)).toBe(0);
    expect(retryAfterMs("Sat, 10 Oct 2026 12:00:07 GMT", now)).toBe(7000);
    expect(retryAfterMs("Sat, 10 Oct 2026 11:00:00 GMT", now)).toBe(0);
    for (const bad of [undefined, "", "-1", "2.5", "soon", "1e3", "Saturday, 10-Oct-26 12:00:07 GMT"]) expect(retryAfterMs(bad, now)).toBeUndefined();
  });

  it("travels with a refused 429/503 as host detail, never as an audit fact", async () => {
    const definition = { id: "op:resolver:1", toolId: "t", binding: "b", kind: "json_http", implementationId: "chrome.tool.json_http", implementationVersion: "0.1.0", displayName: "t", origin: "https://service.example", path: "/x", method: "POST", inputSchemaSha256: null, outputSchemaSha256: null, permissionKinds: ["network"], sideEffects: "read", timeoutSeconds: 10 } as ToolImplementationDefinition;
    const call = (status: number, headers: Record<string, string>) => jsonHttpCall({ definition, args: {}, transport: async () => text(status, "busy", headers), signal: new AbortController().signal, now: () => Date.parse("2026-10-10T12:00:00Z") }).then(() => null, (error: unknown) => error as AdapterError);
    const refused = (await call(503, { "retry-after": "3" }))!;
    expect(refused.detail.retry_after_ms).toBe(3000);
    expect(refused.audit_facts).not.toHaveProperty("retry_after_ms");
    expect((await call(429, {}))!.detail.retry_after_ms).toBeUndefined();
  });
});

describe("retries of a read-only call through the runtime (D-152)", () => {
  it("a resolver that answers 503 twice then 200: three requests, waits of 1 s then 3 s, two remote calls more, one tool call", async () => {
    const pkg = await citationPackage();
    const { sleep, waits } = fakeSleep();
    const net = scriptedNetwork({ search: okSearch, resolver: (_request, index) => (index < 2 ? text(503, "Service Unavailable") : json(200, RESOLVED(DOI))) });
    const run = await runCitations(pkg, input([DOI]), net.transport, { sleep });
    expect(run.error).toBeNull();
    expect(run.result!.status).toBe("completed");
    expect((run.result!.output as JsonObject).resolved).toEqual([RESOLVED(DOI)]);
    expect(net.seen.filter((call) => call.kind === "resolver")).toHaveLength(3);
    expect(waits).toEqual([...RETRY_BACKOFF_MS]);
    const retried = events(run.audit, "tool.retried");
    expect(retried.map((event) => [event.attempt, event.reason, event.http_status, event.delay_ms])).toEqual([[2, "http_status", 503, 1000], [3, "http_status", 503, 3000]]);
    expect(events(run.audit, "tool.settled").find((event) => event.tool === "citation-resolver")).toMatchObject({ attempts: 3, answered_by: "chrome.tool.json_http" });
    const usage = run.result!.usage as JsonObject;
    expect((usage.tool_calls as JsonObject)["citation-resolver"]).toBe(1);
    expect(events(run.audit, "tool.called").filter((event) => event.tool === "citation-resolver")).toHaveLength(1);
    // The worker that made the call was charged one remote call per request.
    const worker = String(events(run.audit, "tool.called").find((event) => event.tool === "citation-resolver")!.worker);
    expect(((usage.workers as JsonObject)[worker] as JsonObject).remote_calls).toBe(3);
    expect(run.bound.find((handler) => handler.tool_id === "citation-resolver")!.calls[0]).toMatchObject({ attempts: 3, fallback_attempts: 0, answered_by_fallback: false });
  });

  it("three transient failures of a call the fallback does not serve: the last failure stands", async () => {
    const { sleep } = fakeSleep();
    const net = scriptedNetwork({ search: okSearch, resolver: () => text(503, "Service Unavailable") });
    const run = await runCitations(await citationPackage(), input(["On synthetic records"]), net.transport, { sleep });
    expect([run.error!.code, run.error!.node_id]).toEqual(["tool_error", "resolve"]);
    expect(net.seen.filter((call) => call.kind === "resolver")).toHaveLength(1 + MAX_TOOL_RETRIES);
    expect(events(run.audit, "tool.failed").at(-1)).toMatchObject({ tool: "citation-resolver", reason: "tool_response_invalid", failure_facts: { http_status: 503, stage: "content_type" } });
    expect(net.seen.some((call) => call.kind === "lookup")).toBe(false);
  });

  it("honours a Retry-After up to 10 s, and does not retry when the server asks for longer", async () => {
    const short = fakeSleep();
    const ok = await runCitations(await citationPackage(), input([DOI]), scriptedNetwork({ search: okSearch, resolver: (_r, index) => (index === 0 ? json(503, { error: "busy" }, { "retry-after": "2" }) : json(200, RESOLVED(DOI))) }).transport, { sleep: short.sleep });
    expect(ok.result!.status).toBe("completed");
    expect(short.waits).toEqual([2000]);
    const long = fakeSleep();
    const net = scriptedNetwork({ search: okSearch, resolver: () => json(503, { error: "busy" }, { "retry-after": "30" }) });
    const refused = await runCitations(await citationPackage(), input(["On synthetic records"]), net.transport, { sleep: long.sleep });
    expect(refused.error!.code).toBe("tool_error");
    expect(long.waits).toEqual([]);
    expect(events(refused.audit, "tool.retry_skipped")).toEqual([expect.objectContaining({ attempt: 2, reason: "retry_after", retry_after_ms: 30_000, failure: "http_status", http_status: 503 })]);
  });

  it("never retries a non-transient failure", async () => {
    const { sleep, waits } = fakeSleep();
    const net = scriptedNetwork({ search: okSearch, resolver: () => json(418, { status: "teapot" }) });
    const run = await runCitations(await citationPackage(), input([DOI]), net.transport, { sleep });
    expect(run.error!.code).toBe("tool_error");
    expect(net.seen.filter((call) => call.kind === "resolver")).toHaveLength(1);
    expect(waits).toEqual([]);
    expect(events(run.audit, "tool.retried")).toEqual([]);
  });

  it("Crossref's 429 then 200: retried, and the retry still waits for its pacing turn, a second after the 429's answer", async () => {
    const net = scriptedNetwork({ search: (_r, index) => (index === 0 ? text(429, "") : okSearch()), resolver: () => json(200, RESOLVED(DOI)) });
    // A zero backoff: only the pacer can space the two searches.
    const run = await runCitations(await citationPackage(), input([DOI]), net.transport, { sleep: async () => undefined });
    expect(run.result!.status).toBe("completed");
    const searches = net.seen.filter((call) => call.kind === "search");
    expect(searches).toHaveLength(2);
    expect(searches[1]!.at - searches[0]!.at).toBeGreaterThanOrEqual(1000);
    expect(events(run.audit, "tool.retried")).toEqual([expect.objectContaining({ tool: "scholarly-search", attempt: 2, reason: "http_status", http_status: 429 })]);
  }, 10_000);
});

describe("what the runtime tells a handler (D-152)", () => {
  it("the call's earliest deadline (the tool's here, inside its step's and node's) and the package's declared side effects", async () => {
    const pkg = await citationPackage();
    const seen: Array<{ tool: string; bounds: ToolCallBounds; at: number }> = [];
    const record = (tool: string, bounds: ToolCallBounds | undefined) => seen.push({ tool, bounds: bounds!, at: Date.now() });
    const handlers = {
      "scholarly.search": async (_context: ToolContext, _payload: JsonValue, _signal: AbortSignal, bounds?: ToolCallBounds) => (record("search", bounds), { papers: [], query: "q", source: "crossref", skipped_records: 0 }),
      "citation.resolve": async (_context: ToolContext, payload: JsonValue, _signal: AbortSignal, bounds?: ToolCallBounds) => (record("resolve", bounds), RESOLVED(String((payload as JsonObject).query))),
    };
    const result = await runWorkflow(pkg, input([DOI]), { handlers, grants: { "network.scholarly": "session", "network.citations": "session", "memory.session": "session" }, approvedTools: ["citation-resolver", "scholarly-search"] });
    expect(result.status).toBe("completed");
    // scholarly-search declares 25 s inside a 60 s node; citation-resolver 45 s inside a 120 s step and a 300 s node.
    for (const [tool, seconds] of [["search", 25], ["resolve", 45]] as const) {
      const call = seen.find((item) => item.tool === tool)!;
      expect(call.bounds.side_effects, tool).toBe("read");
      expect(call.bounds.deadline! - call.at, tool).toBeGreaterThan(seconds * 1000 - 2000);
      expect(call.bounds.deadline! - call.at, tool).toBeLessThanOrEqual(seconds * 1000);
    }
  });
});

/** A context like the runtime's, with a remote-call budget of `room` more requests. */
function context(room: number): ToolContext & { recorded: Array<[string, Record<string, unknown>]>; charged: number } {
  const recorded: Array<[string, Record<string, unknown>]> = [];
  const state = {
    role: "CitationWorker",
    worker_id: "CitationWorker:2",
    recorded,
    charged: 0,
    event: (action: string, metadata: Record<string, unknown> = {}) => void recorded.push([action, metadata]),
    remoteCall: (charge: boolean) => {
      if (state.charged >= room) return { bound: "worker_remote_calls" as const, remote_calls: 1 + state.charged, limit: 1 + room };
      if (charge) state.charged += 1;
      return null;
    },
  };
  return state;
}

/** The citation tool's own handler, bound as this host binds it, over a scripted resolver. */
async function resolverHandler(resolver: Script, deps: { sleep?: (ms: number, signal: AbortSignal) => Promise<void> } = {}) {
  const pkg = await citationPackage();
  const now = new Date("2026-10-10T12:00:00Z");
  const registry = await buildHostToolRegistry(pkg, { resourceTypes: [], runtimeVersion: "0.1.0", now });
  const evaluation = await evaluateRegistry(pkg, registry, { decisions: { "network.scholarly": "session", "network.citations": "session", "model.reasoning": "deny", "memory.session": "session" }, toolApprovals: { "citation-resolver": true, "scholarly-search": true }, now });
  const net = scriptedNetwork({ resolver, lookup: () => text(503, "") });
  const { handlers } = toolHandlers(normalizeToolBindings(planToolBindings(evaluation)), { definitions: definitionsFromRegistry(registry), transport: net.transport, pacer: new Pacer(), sleep: deps.sleep ?? (async () => undefined) });
  return { handler: handlers["citation.resolve"]!, net };
}

describe("the limits on a retry, at the handler (D-152)", () => {
  const title = { query: "On synthetic records", query_type: "auto", format: "json" };

  it("not sent when the time left before the call's deadline is shorter than the wait plus the failed attempt", async () => {
    const { handler, net } = await resolverHandler(() => text(503, ""));
    const ctx = context(4);
    const error = await handler(ctx, title, new AbortController().signal, { deadline: Date.now() + 500, side_effects: "read" }).then(() => null, (caught: unknown) => caught);
    expect(error).toBeInstanceOf(AdapterError);
    expect(net.seen).toHaveLength(1);
    expect(ctx.recorded.find(([action]) => action === "tool.retry_skipped")![1]).toMatchObject({ attempt: 2, reason: "deadline" });
    expect(ctx.charged).toBe(0);
  });

  it("not sent when the run's or the worker's remote-call budget has no room; a context that cannot charge allows none", async () => {
    const { handler, net } = await resolverHandler(() => text(503, ""));
    const ctx = context(1);
    await expect(handler(ctx, title, new AbortController().signal, { side_effects: "read" })).rejects.toBeInstanceOf(AdapterError);
    expect(net.seen).toHaveLength(2);
    expect(ctx.charged).toBe(1);
    expect(ctx.recorded.find(([action]) => action === "tool.retry_skipped")![1]).toMatchObject({ attempt: 3, reason: "budget", bound: "worker_remote_calls" });
    const plain = { role: "R", worker_id: "R:1", event: () => undefined };
    const again = await resolverHandler(() => text(503, ""));
    await expect(again.handler(plain, title, new AbortController().signal, { side_effects: "read" })).rejects.toBeInstanceOf(AdapterError);
    expect(again.net.seen).toHaveLength(1);
  });

  it("never sent for a call whose package declares side effects, whatever the failure", async () => {
    const { handler, net } = await resolverHandler(() => text(503, ""));
    const ctx = context(4);
    await expect(handler(ctx, title, new AbortController().signal, { side_effects: "write" })).rejects.toBeInstanceOf(AdapterError);
    await expect(handler(ctx, title, new AbortController().signal)).rejects.toBeInstanceOf(AdapterError);
    expect(net.seen).toHaveLength(2);
    expect(ctx.charged).toBe(0);
  });

  it("a cancellation during the wait ends the call at once: nothing more is sent", async () => {
    const controller = new AbortController();
    const { handler, net } = await resolverHandler(() => text(503, ""), {
      sleep: (_ms, signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
          controller.abort(new CancelledError());
        }),
    });
    const ctx = context(4);
    await expect(handler(ctx, title, controller.signal, { side_effects: "read" })).rejects.toBeInstanceOf(CancelledError);
    expect(net.seen).toHaveLength(1);
    expect(ctx.charged).toBe(0);
  });
});

describe("the citation fallback to Crossref (D-153)", () => {
  it("a resolver that is down: the DOI is looked up at Crossref, mapped to the resolver's answer, audited and charged", async () => {
    const { sleep } = fakeSleep();
    const net = scriptedNetwork({ search: okSearch, resolver: () => down(), lookup: () => json(200, work("10.1145/3442188.3445922")) });
    const run = await runCitations(await citationPackage(), input([`https://doi.org/${DOI.toUpperCase()}`]), net.transport, { sleep });
    expect(run.error).toBeNull();
    const answer = ((run.result!.output as JsonObject).resolved as JsonObject[])[0]!;
    expect(answer).toEqual({
      status: "resolved",
      query: `https://doi.org/${DOI.toUpperCase()}`,
      detected_type: "doi",
      best_match: {
        title: "On synthetic records",
        authors: [{ name: "Grace Hopper", given: "Grace", family: "Hopper", orcid: null }, { name: "The Example Consortium", given: null, family: null, orcid: null }],
        year: 2021,
        venue: "Proceedings of Examples",
        publisher: "Example & Sons",
        doi: DOI,
        arxiv_id: null,
        url: `https://doi.org/${DOI}`,
        publication_type: "proceedings-article",
        abstract: "We describe a synthetic record.",
        volume: null,
        issue: null,
        pages: "610-623",
        journal_reference: null,
        provider_ids: { crossref: DOI },
        source: "crossref",
        bibtex: null,
      },
      match_score: 1,
      alternatives: [],
      sources: [{ provider: "crossref", status: "ok", error_code: null }],
      warnings: [FALLBACK_WARNING],
      message: "Exact identifier verified against the provider record.",
    });
    expect(net.seen.filter((call) => call.kind === "resolver")).toHaveLength(3);
    const lookups = net.seen.filter((call) => call.kind === "lookup");
    expect(lookups.map((call) => call.url)).toEqual(["https://api.crossref.org/works/10.1145%2F3442188.3445922"]);
    expect(events(run.audit, "tool.fallback")).toEqual([expect.objectContaining({ tool: "citation-resolver", from: "chrome.tool.json_http", to: "chrome.tool.crossref_doi_lookup", reason: "transient_failure" })]);
    expect(events(run.audit, "tool.settled").find((event) => event.tool === "citation-resolver")).toMatchObject({ attempts: 3, fallback_attempts: 1, answered_by: "chrome.tool.crossref_doi_lookup" });
    const worker = String(events(run.audit, "tool.called").find((event) => event.tool === "citation-resolver")!.worker);
    expect((((run.result!.usage as JsonObject).workers as JsonObject)[worker] as JsonObject).remote_calls).toBe(4);
    expect(run.bound.find((handler) => handler.tool_id === "citation-resolver")!.calls[0]).toMatchObject({ outcome: "ok", answered_by_fallback: true });
  });

  it("the resolver's own 502 provider_error for a DOI: no retry, the lookup answers; for a title the 502 answer stands", async () => {
    const providerError = { status: "provider_error", query: DOI, detected_type: "doi", best_match: null, match_score: null, alternatives: [], sources: [{ provider: "crossref", status: "error", error_code: "rate_limited" }], warnings: ["Some provider requests failed; coverage may be incomplete."], message: "Resolution could not complete because a provider failed. Retry later." };
    const net = scriptedNetwork({ search: okSearch, resolver: () => json(502, providerError), lookup: () => json(200, work(DOI)) });
    const run = await runCitations(await citationPackage(), input([DOI]), net.transport, { sleep: async () => undefined });
    expect(((run.result!.output as JsonObject).resolved as JsonObject[])[0]!.status).toBe("resolved");
    expect(net.seen.filter((call) => call.kind === "resolver")).toHaveLength(1);
    expect(events(run.audit, "tool.fallback")[0]).toMatchObject({ reason: "resolver_unavailable", http_status: 502 });
    const titled = { ...providerError, query: "On synthetic records", detected_type: "title" };
    const plain = scriptedNetwork({ search: okSearch, resolver: () => json(502, titled) });
    const kept = await runCitations(await citationPackage(), input(["On synthetic records"]), plain.transport);
    expect((kept.result!.output as JsonObject).resolved).toEqual([titled]);
    expect(plain.seen.some((call) => call.kind === "lookup")).toBe(false);
  });

  it("a DOI Crossref does not know: not_found, said to be the built-in lookup's answer", async () => {
    const net = scriptedNetwork({ search: okSearch, resolver: () => down(), lookup: () => text(404, "Resource not found.") });
    const run = await runCitations(await citationPackage(), input(["doi:10.1234/does-not-exist"]), net.transport, { sleep: async () => undefined });
    expect(((run.result!.output as JsonObject).resolved as JsonObject[])[0]).toEqual({ status: "not_found", query: "doi:10.1234/does-not-exist", detected_type: "doi", best_match: null, match_score: null, alternatives: [], sources: [{ provider: "crossref", status: "not_found", error_code: null }], warnings: [FALLBACK_WARNING], message: "No credible work found in the queried providers." });
  });

  it("a lookup that cannot answer either: the call ends exactly as it would have without it", async () => {
    const net = scriptedNetwork({ search: okSearch, resolver: () => down(), lookup: () => text(503, "") });
    const run = await runCitations(await citationPackage(), input([DOI]), net.transport, { sleep: async () => undefined });
    expect([run.error!.code, run.error!.node_id]).toEqual(["tool_error", "resolve"]);
    expect(events(run.audit, "tool.failed").at(-1)).toMatchObject({ tool: "citation-resolver", reason: "tool_transport_error", failure_facts: { stage: "transport" } });
    expect(net.seen.filter((call) => call.kind === "lookup")).toHaveLength(3);
    expect(events(run.audit, "tool.fallback_failed")).toEqual([expect.objectContaining({ to: "chrome.tool.crossref_doi_lookup", code: "tool_unavailable", http_status: 503 })]);
  });

  it("the address policy still applies to the lookup: a refused destination is not retried and does not answer", async () => {
    const net = scriptedNetwork({ search: okSearch, resolver: () => down(), lookup: () => new TransportError("the destination host resolves to a non-public address (private)", { stage: "address_policy", reason: "private" }) });
    const run = await runCitations(await citationPackage(), input([DOI]), net.transport, { sleep: async () => undefined });
    expect(run.error!.code).toBe("tool_error");
    expect(net.seen.filter((call) => call.kind === "lookup")).toHaveLength(1);
    expect(events(run.audit, "tool.fallback_failed")[0]).toMatchObject({ code: "tool_transport_error", stage: "address_policy" });
  });

  it("a non-DOI query, or a package whose citation tool does not declare Crossref, gets the original failure", async () => {
    const title = await runCitations(await citationPackage(), input(["On synthetic records"]), scriptedNetwork({ search: okSearch, resolver: () => down() }).transport, { sleep: async () => undefined });
    expect(title.error!.code).toBe("tool_error");
    expect(events(title.audit, "tool.fallback")).toEqual([]);
    const files = citationFiles();
    change(files, "tools/citation-resolver.tool.json", (tool) => (tool.domains = [RESOLVER_HOST]));
    change(files, "policy/policy.json", (policy) => (((policy.permissions as JsonObject[]).find((item) => item.id === "network.citations")!).resources = [RESOLVER_HOST]));
    const undeclared = await citationPackage(files);
    const net = scriptedNetwork({ search: okSearch, resolver: () => down() });
    const run = await runCitations(undeclared, input([DOI]), net.transport, { sleep: async () => undefined });
    expect(run.error!.code).toBe("tool_error");
    expect(net.seen.some((call) => call.kind === "lookup")).toBe(false);
  });

  it("the binding names its fallback, so the plan's digest covers it; a binding without one keeps the reference's digest", async () => {
    const registry = await buildHostToolRegistry(await citationPackage(), { resourceTypes: [], runtimeVersion: "0.1.0", now: new Date("2026-10-10T12:00:00Z") });
    const binding = registry.bindings.find((item) => item.tool_id === "citation-resolver")!;
    expect(binding.fallback).toEqual({ implementation_id: "chrome.tool.crossref_doi_lookup", implementation_version: "0.1.0", endpoint: { origin: "https://api.crossref.org", path: "/works/{doi}", method: "GET" } });
    expect(binding.description).toContain("looks that DOI up at https://api.crossref.org/works/");
    const definition = definitionsFromRegistry(registry).find((item) => item.toolId === "citation-resolver")!;
    expect(bindingDigest(describeDefinition(definition))).toBe(binding.binding_sha256);
    const { fallback: _fallback, ...withoutFallback } = definition;
    expect(bindingDigest(describeDefinition(withoutFallback))).not.toBe(binding.binding_sha256);
    // The search binding, which has no fallback, digests exactly as before (its subject has no new key).
    const search = definitionsFromRegistry(registry).find((item) => item.toolId === "scholarly-search")!;
    const described = describeDefinition(search);
    expect(described).not.toHaveProperty("fallback");
    const subject = { schema: "agentpkg-tool-binding-digest-v0", binding_id: described.id, tool_id: described.tool_id, binding: described.binding, implementation_kind: described.implementation_kind, implementation_id: described.implementation_id, implementation_version: described.implementation_version, remote: described.remote, endpoint: described.endpoint, contract: described.contract, limits: described.limits, credentials: described.credentials };
    expect(bindingDigest(described)).toBe(sha256HexSync(canonicalJson(subject)));
  });

  it("whether the person's Crossref contact is set is part of the citation binding's digest, as for the search; only Crossref requests carry it", async () => {
    const pkg = await citationPackage();
    const now = new Date("2026-10-10T12:00:00Z");
    const citation = async (contactConfigured: boolean) => (await buildHostToolRegistry(pkg, { resourceTypes: [], runtimeVersion: "0.1.0", now, contactConfigured })).bindings.find((item) => item.tool_id === "citation-resolver")!;
    const unset = await citation(false);
    const set = await citation(true);
    expect(unset.credentials).toEqual({ required: false, configured: false, source: "settings:crossref.contact" });
    expect(set.credentials.configured).toBe(true);
    expect(set.binding_sha256).not.toBe(unset.binding_sha256);
    const net = scriptedNetwork({ search: okSearch, resolver: () => down(), lookup: () => json(200, work(DOI)) });
    const run = await runCitations(pkg, input([DOI]), net.transport, { sleep: async () => undefined, credentials: (source) => (source.name === "crossref.contact" ? "reader@example.org" : null) });
    expect(run.error).toBeNull();
    expect(net.seen.find((call) => call.kind === "lookup")!.url).toBe("https://api.crossref.org/works/10.1145%2F3442188.3445922?mailto=reader%40example.org");
    for (const call of net.seen.filter((item) => item.kind === "resolver")) expect(`${call.url} ${call.body}`).not.toContain("reader");
  });

  it("a registry binding may name only this host's own lookup, and only for citation.resolve", async () => {
    const registry = await buildHostToolRegistry(await citationPackage(), { resourceTypes: [], runtimeVersion: "0.1.0", now: new Date("2026-10-10T12:00:00Z") });
    const { binding_sha256: _sha, schema: _schema, ...raw } = registry.bindings.find((item) => item.tool_id === "citation-resolver")! as unknown as Record<string, unknown>;
    await expect(normalizeBinding({ ...raw, fallback: { ...(raw.fallback as object), endpoint: { origin: "https://evil.example", path: "/works/{doi}", method: "GET" } } }, 0)).rejects.toThrow(/fallback must be this host's chrome\.tool\.crossref_doi_lookup/u);
    await expect(normalizeBinding({ ...raw, binding: "scholarly.search" }, 0)).rejects.toThrow(/fallback belongs to a json_http citation\.resolve binding only/u);
  });
});

describe("the Crossref DOI lookup's mapping (D-153)", () => {
  it("reads DOIs as the resolver's parse_doi does, and the queries it serves", () => {
    expect(parseDoi(" 10.1145/3442188.3445922 ")).toBe(DOI);
    expect(parseDoi("doi:10.1145/ABC")).toBe("10.1145/abc");
    expect(parseDoi("https://doi.org/10.1145/A%2FB")).toBe("10.1145/a/b");
    expect(parseDoi("http://dx.doi.org:80/10.1000/x")).toBe("10.1000/x");
    for (const bad of ["10.1/x", "11.1145/x", "https://example.org/10.1145/x", "10.1145/a b", "10.1145/\u0007", "https://user@doi.org/10.1145/x", "https://doi.org:8443/10.1145/x", "On synthetic records"]) expect(parseDoi(bad), bad).toBeNull();
    expect(doiQuery({ query: DOI })).toBe(DOI);
    expect(doiQuery({ query: DOI, query_type: "doi" })).toBe(DOI);
    expect(doiQuery({ query: DOI, query_type: "title" })).toBeNull();
    expect(doiQuery({ query: DOI, query_type: "arxiv" })).toBeNull();
    expect(doiQuery({ query: 7 })).toBeNull();
  });

  it("encodes the DOI as the resolver does (quote with no safe characters)", () => {
    expect(pyQuote("10.1002/(SICI)1097-4571(199806)49:8<693::AID-ASI3>3.0.CO;2-0")).toBe("10.1002%2F%28SICI%291097-4571%28199806%2949%3A8%3C693%3A%3AAID-ASI3%3E3.0.CO%3B2-0");
    expect(pyQuote("10.1/ä~_.-", "/")).toBe("10.1/%C3%A4~_.-");
  });

  it("maps a work like the resolver's normalize, and refuses a record that is not the work asked for", () => {
    const message = (overrides: JsonObject = {}) => (work(DOI, overrides).message as JsonObject) as Record<string, JsonValue>;
    expect(paperFromWork(message(), DOI)).toMatchObject({ doi: DOI, title: "On synthetic records", abstract: "We describe a synthetic record.", publisher: "Example & Sons" });
    expect(paperFromWork(message({ DOI: "10.1145/OTHER" }), DOI)).toBeNull();
    expect(paperFromWork(message({ title: [] }), DOI)).toBeNull();
    expect(paperFromWork(message({ title: ["<i></i>"] }), DOI)).toBeNull();
    // The resolver's order of dates, integers only; strings only for volume, issue and pages.
    expect(paperFromWork(message({ published: { "date-parts": [[0]] }, "published-online": { "date-parts": [[2020]] }, volume: 12, issue: "3" }), DOI)).toMatchObject({ year: 2020, volume: null, issue: "3" });
  });

  it("answers BibTeX requests with metadata and says it did not generate BibTeX; refuses a non-JSON 200 and a redirect", async () => {
    const call = (reply: ReturnType<typeof json>, args: JsonObject = { query: DOI, format: "bibtex" }) => crossrefDoiLookup({ transport: async () => reply, args, doi: DOI, signal: new AbortController().signal, toolId: "citation-resolver" }).then((value) => value, (error: unknown) => error as AdapterError);
    const answered = (await call(json(200, work(DOI)))) as { output: JsonObject };
    expect(answered.output.warnings).toEqual([FALLBACK_WARNING, BIBTEX_WARNING]);
    expect(((answered.output.best_match as JsonObject).bibtex)).toBeNull();
    expect(((await call(text(200, "{}"))) as AdapterError).code).toBe("tool_response_invalid");
    expect(((await call({ status: 301, headers: { location: "https://elsewhere.example" }, body: "" })) as AdapterError).code).toBe("tool_transport_error");
    const limited = (await call(text(429, "", { "retry-after": "1" }))) as AdapterError;
    expect([limited.code, limited.detail.retry_after_ms]).toEqual(["tool_unavailable", 1000]);
  });

  it("sends the person's contact only when one is set, as the search binding does", async () => {
    const urls: string[] = [];
    const lookup = (contact: string | null) => crossrefDoiLookup({ transport: async (request) => (urls.push(request.url), json(200, work(DOI))), args: { query: DOI }, doi: DOI, signal: new AbortController().signal, contact, toolId: "t" });
    await lookup(null);
    await lookup("reader@example.org");
    await lookup("not an address");
    expect(urls).toEqual(["https://api.crossref.org/works/10.1145%2F3442188.3445922", "https://api.crossref.org/works/10.1145%2F3442188.3445922?mailto=reader%40example.org", "https://api.crossref.org/works/10.1145%2F3442188.3445922"]);
  });
});
