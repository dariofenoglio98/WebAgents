/**
 * The Crossref scholarly-search adapter (T6, D-081), held to the reference plugin's
 * `CROSSREF_WORKS_ADAPTER`: the text renderer is the reference's file byte for byte and passes
 * the Citation Resolver's own `clean_text` vectors; the request shape and every normalized answer
 * equal what the reference adapter produced (`scripts/make-crossref-reference.mjs`); and a Crossref
 * call inherits the broker's policy: refusals before any request, status mapping, redirects,
 * content type, byte caps, the contact address only when the person set one, and Crossref's
 * stated pacing (one call at a time, one start per second).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { pythonHtmlText, pyUnescape } from "../../../src/core/html-text.js";
import type { JsonValue } from "../../../src/core/json.js";
import type { HttpRequest, HttpTransport } from "../../../src/core/models/transport.js";
import { CROSSREF_FILTER, CROSSREF_IMPLEMENTATION, CROSSREF_SELECT, CROSSREF_WORKS_ADAPTER, encodeQuery, validContact } from "../../../src/core/tools/adapters/crossref.js";
import { jsonHttpCall } from "../../../src/core/tools/adapters/json-http.js";
import type { ToolImplementationDefinition } from "../../../src/core/tools/definitions.js";
import { AdapterError } from "../../../src/core/workflow/errors.js";
import { PROJECT, ROOT } from "../../helpers/paths.js";

const DIRECTORY = join(PROJECT, "test", "fixtures", "crossref");
const VECTORS = JSON.parse(readFileSync(join(DIRECTORY, "crossref-text-vectors.json"), "utf8")) as { reference: string; python: string; vectors: Array<{ input: string; expected: string | null }> };
const CAPTURED = JSON.parse(readFileSync(join(DIRECTORY, "crossref-works-select.json"), "utf8")) as JsonValue;
const REFERENCE = JSON.parse(readFileSync(join(DIRECTORY, "reference-answers.json"), "utf8")) as {
  retrieved_at: string;
  select: string;
  filter: string;
  requests: Array<{ args: JsonValue; query: Array<[string, string]>; encoded: string }>;
  answers: Array<{ name: string; args: JsonValue; input: JsonValue | string; output: JsonValue }>;
};

export const CROSSREF_DEFINITION: ToolImplementationDefinition = {
  id: "chrome:crossref_works_search:scholarly-search:1",
  toolId: "scholarly-search",
  binding: "scholarly.search",
  kind: "json_http",
  implementationId: CROSSREF_IMPLEMENTATION.id,
  implementationVersion: CROSSREF_IMPLEMENTATION.version,
  displayName: "Crossref works search",
  origin: "https://api.crossref.org",
  path: "/works",
  method: "GET",
  inputSchemaSha256: "f8a6f920b23bf1731a85d5275c10eee77a9d055fb14917be114c1b9e8249baf2",
  outputSchemaSha256: "eb83100404221fd9a489046d6741a046aae07c31c672ab6dc2daabffeda3c9ee",
  permissionKinds: ["network"],
  sideEffects: "read",
  timeoutSeconds: 25,
  maxRequestBytes: 4096,
  maxResponseBytes: 512 * 1024,
  maxConcurrent: 1,
  minIntervalMs: 1000,
};

function scripted(answer: (request: HttpRequest) => { status: number; headers?: Record<string, string>; body: string }): { transport: HttpTransport; requests: HttpRequest[] } {
  const requests: HttpRequest[] = [];
  const transport: HttpTransport = async (request) => {
    requests.push(request);
    const { status, headers, body } = answer(request);
    return { status, headers: { "content-type": "application/json", ...(headers ?? {}) }, body };
  };
  return { transport, requests };
}

const ok = () => ({ status: 200, body: JSON.stringify(CAPTURED) });
const call = (transport: HttpTransport, args: JsonValue, contact: string | null = null) =>
  jsonHttpCall({ definition: CROSSREF_DEFINITION, args, transport, signal: new AbortController().signal, contact, now: () => Date.parse(REFERENCE.retrieved_at) });

async function code(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    return error instanceof AdapterError ? error.code : `unexpected:${String(error)}`;
  }
  return "resolved";
}

describe("text rendering is the Citation Resolver's", () => {
  it("is the reference plugin's html-text.ts from the first import on, one local variable renamed", () => {
    // The plugin names one local `window`; the core boundary test forbids that name in the core.
    const portion = (text: string) => text.slice(text.indexOf("import { HTML5_ENTITIES")).replace(/\bwindow\b/gu, "lookback");
    const core = readFileSync(join(PROJECT, "src", "core", "html-text.ts"), "utf8");
    const plugin = readFileSync(join(ROOT, "openclaw-agent-browser", "src", "html-text.ts"), "utf8");
    expect(portion(core)).toBe(portion(plugin));
  });

  it("reproduces every vector the resolver's own clean_text produced, quirks included", () => {
    expect(VECTORS.reference).toContain("clean_text");
    expect(VECTORS.vectors.length).toBeGreaterThan(100);
    expect(VECTORS.vectors.filter((vector) => pythonHtmlText(vector.input) !== vector.expected)).toEqual([]);
    expect(pythonHtmlText("Q&A")).toBeNull();
    expect(pythonHtmlText("a<b")).toBe("a");
    expect(pyUnescape("&amp;amp;")).toBe("&amp;");
  });
});

describe("the request shape is host code, and equal to the reference's", () => {
  it("builds the reference's four parameters in its order and encodes them byte for byte as it does", () => {
    expect(CROSSREF_SELECT).toBe(REFERENCE.select);
    expect(CROSSREF_FILTER).toBe(REFERENCE.filter);
    for (const item of REFERENCE.requests) {
      const shaped = CROSSREF_WORKS_ADAPTER.request(item.args, "GET", { contact: null });
      expect(shaped.body).toBeNull();
      expect(shaped.query).toEqual(item.query);
      expect(encodeQuery(shaped.query!)).toBe(item.encoded);
      expect(encodeQuery(shaped.query!)).toBe(new URLSearchParams(shaped.query!.map(([name, value]) => [name, value])).toString());
    }
  });

  it("sends one GET to https://api.crossref.org/works with no body, a fixed header set and no credential", async () => {
    const { transport, requests } = scripted(ok);
    await call(transport, { query: "communication topology multi-agent LLM", limit: 10 });
    expect(requests).toHaveLength(1);
    const url = new URL(requests[0]!.url);
    expect([url.origin, url.pathname, requests[0]!.method, requests[0]!.body]).toEqual(["https://api.crossref.org", "/works", "GET", null]);
    expect([...url.searchParams.keys()]).toEqual(["query.bibliographic", "rows", "select", "filter"]);
    expect(Object.keys(requests[0]!.headers).sort()).toEqual(["accept", "user-agent"]);
  });

  it("adds mailto only when the person entered a valid contact address, and never a package value", async () => {
    const { transport, requests } = scripted(ok);
    await call(transport, { query: "q", limit: 1 }, "someone@example.org");
    await call(transport, { query: "q", limit: 1 }, "not an address");
    await call(transport, { query: "q", limit: 1 }, null);
    expect(new URL(requests[0]!.url).searchParams.get("mailto")).toBe("someone@example.org");
    expect(new URL(requests[1]!.url).searchParams.has("mailto")).toBe(false);
    expect(new URL(requests[2]!.url).searchParams.has("mailto")).toBe(false);
    expect([validContact(" a.b+c@lab.example.edu "), validContact("a@b"), validContact("a b@c.org"), validContact("x@-bad.org"), validContact(7)]).toEqual(["a.b+c@lab.example.edu", null, null, null, null]);
  });

  it("refuses argument names it was not written for and values outside its bounds before any request", async () => {
    const { transport, requests } = scripted(ok);
    for (const args of [
      { query: "x", limit: 3, select: "reference" },
      { query: "x", limit: 3, "query.author": "someone" },
      { query: "x", limit: 3, mailto: "spoof@example.org" },
      { query: "x", limit: 0 },
      { query: "x", limit: 21 },
      { query: "x", limit: 2.5 },
      { query: "", limit: 3 },
      { query: "   ", limit: 3 },
      { query: "x".repeat(501), limit: 3 },
      { query: "bell\u0007", limit: 3 },
      { limit: 3 },
      ["x", 3],
      null,
    ] as JsonValue[]) {
      expect(await code(call(transport, args))).toBe("tool_request_invalid");
    }
    expect(requests).toHaveLength(0);
  });

  it("bounds the URL it would send by the binding's request limit", async () => {
    const { transport, requests } = scripted(ok);
    // 500 characters of four-byte UTF-8 percent-encode to 6,000 bytes: above the 4 KiB bound.
    expect(await code(call(transport, { query: "😀".repeat(500), limit: 1 }))).toBe("tool_request_invalid");
    expect(requests).toHaveLength(0);
  });
});

describe("normalizing an answer is the reference's normalization", () => {
  it("equals the reference adapter's output on the captured response and every edge case", () => {
    for (const answer of REFERENCE.answers) {
      const input = typeof answer.input === "string" ? CAPTURED : answer.input;
      expect(CROSSREF_WORKS_ADAPTER.response({ status: 200, json: input }, answer.args, REFERENCE.retrieved_at), answer.name).toEqual(answer.output);
    }
    const captured = REFERENCE.answers.find((item) => item.name === "captured")!.output as { papers: unknown[]; skipped_records: number };
    expect(captured.papers.length + captured.skipped_records).toBe(10);
  });

  it("refuses a malformed answer rather than inventing an empty one", () => {
    for (const json of [null, [], { status: "failed", message: { items: [] } }, { status: "ok" }, { status: "ok", message: { items: "nope" } }] as JsonValue[]) {
      expect(() => CROSSREF_WORKS_ADAPTER.response({ status: 200, json }, { query: "q", limit: 3 }, REFERENCE.retrieved_at)).toThrow(/work list/u);
    }
  });
});

describe("a Crossref call obeys the broker's transport policy", () => {
  it("maps rate limiting, server errors and other statuses to failures, never data", async () => {
    for (const [status, expected] of [
      [429, "tool_unavailable"],
      [500, "tool_unavailable"],
      [503, "tool_unavailable"],
      [401, "tool_unavailable"],
      [403, "tool_unavailable"],
      [404, "tool_transport_error"],
      [400, "tool_transport_error"],
      [302, "tool_transport_error"],
    ] as const) {
      const { transport } = scripted(() => ({ status, body: "{}" }));
      expect(await code(call(transport, { query: "q", limit: 1 })), String(status)).toBe(expected);
    }
  });

  it("refuses a non-JSON answer, invalid JSON and an oversized body", async () => {
    expect(await code(call(scripted(() => ({ status: 200, headers: { "content-type": "text/html" }, body: "<html>" })).transport, { query: "q", limit: 1 }))).toBe("tool_response_invalid");
    expect(await code(call(scripted(() => ({ status: 200, body: "{nope" })).transport, { query: "q", limit: 1 }))).toBe("tool_response_invalid");
    expect(await code(call(scripted(() => ({ status: 200, body: `"${"x".repeat(600 * 1024)}"` })).transport, { query: "q", limit: 1 }))).toBe("tool_response_invalid");
  });

  it("returns the reference's normalized result through the whole call", async () => {
    const { transport } = scripted(ok);
    const result = await call(transport, { query: "communication topology multi-agent LLM", limit: 10 });
    expect(result.status).toBe(200);
    expect(result.output).toEqual(REFERENCE.answers.find((item) => item.name === "captured")!.output);
  });
});
