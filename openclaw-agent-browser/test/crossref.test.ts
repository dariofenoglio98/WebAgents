/**
 * The Crossref scholarly-search implementation: request shape, text rendering,
 * normalization and the transport policy it inherits.
 *
 * Three different things are proved here and kept apart:
 *
 * * **the package controls values, the host controls the request shape** —
 *   exact origin, path and method, three fixed parameter names, encoded
 *   values, and a refusal for any argument name the host did not write;
 * * **text is rendered exactly as the Citation Resolver renders it** — the
 *   TypeScript port is checked against vectors produced by the resolver's real
 *   `clean_text` on CPython 3.13, because a later package step requires quotes
 *   to match the resolver's copy of an abstract character for character;
 * * **nothing about Crossref weakens the broker** — the same SSRF, redirect,
 *   size, deadline and cancellation rules apply as to every other binding.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { AgentBrowserError } from "../src/errors.js";
import { pythonHtmlText, pyUnescape } from "../src/html-text.js";
import {
  CROSSREF_FILTER,
  CROSSREF_SELECT,
  CROSSREF_WORKS_ADAPTER,
  HTTP_ADAPTERS,
  JSON_HTTP_ADAPTER,
} from "../src/tool-adapters.js";
import { ToolBroker, type HttpTransport } from "../src/tool-broker.js";
import { Pacer } from "../src/tool-pacer.js";
import { BUILT_IN_BINDINGS, describeBinding } from "../src/tool-registry.js";

const here = dirname(fileURLToPath(import.meta.url));
const log = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
const SHIPPED = BUILT_IN_BINDINGS.find((item) => item.toolId === "scholarly-search")!;
// Most tests below are about shape, not pacing, so they use an unpaced copy;
// the pacing test uses the shipped definition itself.
const SEARCH = { ...SHIPPED, minIntervalMs: 0 };
const FIXTURE = JSON.parse(
  readFileSync(join(here, "fixtures", "crossref-works-select.json"), "utf8"),
) as Record<string, unknown>;
const VECTORS = JSON.parse(
  readFileSync(join(here, "fixtures", "crossref-text-vectors.json"), "utf8"),
) as { reference: string; python: string; vectors: Array<{ input: string; expected: string | null }> };

function bound() {
  const descriptor = describeBinding(SEARCH, { env: {} });
  return {
    toolId: "scholarly-search",
    bindingId: SEARCH.id,
    bindingSha256: "a".repeat(64),
    remote: true,
    timeoutSeconds: 25,
    descriptor,
  };
}

function broker(transport: HttpTransport, resolver = async () => ["104.18.0.1"]) {
  const item = bound();
  return {
    item,
    broker: new ToolBroker({
      bound: [item],
      definitions: [SEARCH],
      logger: log,
      resolver,
      transport,
      now: () => Date.parse("2026-09-23T12:00:00.000Z"),
      pacer: new Pacer(),
    }),
  };
}

function call(item: ReturnType<typeof bound>, args: unknown) {
  return {
    tool_id: item.toolId,
    binding_id: item.bindingId,
    binding_sha256: item.bindingSha256,
    args,
  };
}

function ok(body: unknown, status = 200): HttpTransport {
  return async () => ({ status, contentType: "application/json;charset=utf-8", body: JSON.stringify(body) });
}

async function failure(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    return (error as AgentBrowserError).detail;
  }
  throw new Error("expected the call to fail");
}

describe("text rendering parity with the Citation Resolver", () => {
  it("reproduces every vector the resolver's own clean_text produced", () => {
    expect(VECTORS.reference).toContain("clean_text");
    expect(VECTORS.python.startsWith("3.13")).toBe(true);
    expect(VECTORS.vectors.length).toBeGreaterThan(100);
    const mismatches = VECTORS.vectors
      .map((vector) => ({ ...vector, actual: pythonHtmlText(vector.input) }))
      .filter((vector) => vector.actual !== vector.expected);
    expect(mismatches).toEqual([]);
  });

  it("keeps CPython's quirks rather than 'fixing' them", () => {
    // A trailing reference-shaped `&` is withheld because clean_text never
    // calls close(); the resolver therefore renders these as nothing, and so
    // must this host, or the two copies of one record would disagree.
    expect(pythonHtmlText("Q&A")).toBeNull();
    expect(pythonHtmlText("a<b")).toBe("a");
    expect(pythonHtmlText("<jats:p>One.</jats:p><jats:p>Two.</jats:p>")).toBe("One.Two.");
    expect(pythonHtmlText(42)).toBeNull();
    expect(pyUnescape("&amp;amp;")).toBe("&amp;");
  });

  it("renders markup as text without executing, fetching or keeping it", () => {
    const text = pythonHtmlText(
      '<jats:p>See <jats:ext-link xlink:href="https://evil.example/x">this</jats:ext-link>' +
        "<script>fetch('https://evil.example')</script> and <img src=x onerror=alert(1)>.</jats:p>",
    );
    expect(text).toBe("See thisfetch('https://evil.example') and .");
    expect(text).not.toContain("<");
  });

  it("pins the generated entity table to the CPython module it was copied from", () => {
    const source = readFileSync(join(here, "..", "src", "html-entities.ts"));
    expect(createHash("sha256").update(source).digest("hex")).toBe(
      "50c078b83358e3ea49c8f8dccd8ad01d9850100fd706da85901d4d4d3979372a",
    );
  });
});

describe("the Crossref request shape is host code", () => {
  it("sends exactly one GET to the binding's origin and path, with four host-named parameters", async () => {
    const seen: Array<Parameters<HttpTransport>[0]> = [];
    const { item, broker: tools } = broker(async (options) => {
      seen.push(options);
      return { status: 200, contentType: "application/json", body: JSON.stringify(FIXTURE) };
    });
    await tools.call(call(item, { query: "communication topology multi-agent LLM", limit: 10 }), new AbortController().signal);
    expect(seen).toHaveLength(1);
    const sent = seen[0]!;
    expect(sent.hostname).toBe("api.crossref.org");
    expect(sent.method).toBe("GET");
    expect(sent.body).toBeNull();
    const url = new URL(`https://api.crossref.org${sent.path}`);
    expect(url.pathname).toBe("/works");
    expect([...url.searchParams.keys()]).toEqual(["query.bibliographic", "rows", "select", "filter"]);
    expect(url.searchParams.get("query.bibliographic")).toBe("communication topology multi-agent LLM");
    expect(url.searchParams.get("rows")).toBe("10");
    expect(url.searchParams.get("select")).toBe(CROSSREF_SELECT);
    // Only scholarly works: no supplementary files, peer reviews or datasets.
    expect(url.searchParams.get("filter")).toBe(CROSSREF_FILTER);
    expect(CROSSREF_FILTER).not.toMatch(/component|peer-review|dataset/u);
    // A fixed header set: nothing from the arguments, no credential.
    expect(Object.keys(sent.headers).sort()).toEqual(["accept", "connection", "user-agent"]);
  });

  it("encodes unicode and punctuation as values, never as structure", async () => {
    const seen: Array<Parameters<HttpTransport>[0]> = [];
    const { item, broker: tools } = broker(async (options) => {
      seen.push(options);
      return { status: 200, contentType: "application/json", body: JSON.stringify(FIXTURE) };
    });
    const query = "Graph-of-Agents: “adaptive” topology & selection? #LLM+routing é/../x=1&rows=99";
    await tools.call(call(item, { query, limit: 3 }), new AbortController().signal);
    const url = new URL(`https://api.crossref.org${seen[0]!.path}`);
    expect(url.pathname).toBe("/works");
    expect([...url.searchParams.keys()]).toEqual(["query.bibliographic", "rows", "select", "filter"]);
    expect(url.searchParams.get("query.bibliographic")).toBe(query);
    expect(url.searchParams.get("rows")).toBe("3");
  });

  it("refuses argument names it was not written for, and values outside its bounds", async () => {
    let calls = 0;
    const { item, broker: tools } = broker(async () => {
      calls += 1;
      return { status: 200, contentType: "application/json", body: JSON.stringify(FIXTURE) };
    });
    const signal = new AbortController().signal;
    for (const args of [
      { query: "x", limit: 3, select: "reference" },
      { query: "x", limit: 3, "query.author": "someone" },
      { query: "x", limit: 3, path: "/members" },
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
    ]) {
      expect(await failure(tools.call(call(item, args), signal))).toMatch(/^tool_request_invalid/u);
    }
    expect(calls).toBe(0);
  });

  it("describes itself by implementation id and version, never by a template", () => {
    const descriptor = describeBinding(SEARCH, { env: {} });
    expect(descriptor.implementation_id).toBe(CROSSREF_WORKS_ADAPTER.id);
    expect(descriptor.implementation_version).toBe("0.2.0");
    expect(JSON.stringify(descriptor)).not.toMatch(/rows=|select=|filter=|query\.bibliographic=/u);
    expect(HTTP_ADAPTERS.get("openclaw.tool.json_http")).toBe(JSON_HTTP_ADAPTER);
  });

  it("fingerprints the mapping, so it cannot change without a version bump", () => {
    // If this fails, the request shape or normalization moved: bump the
    // binding's implementationVersion (which moves its digest and stales every
    // plan that approved the old behaviour), then update the fingerprint.
    const fingerprint = createHash("sha256")
      .update(
        JSON.stringify({
          version: SEARCH.implementationVersion,
          select: CROSSREF_SELECT,
          filter: CROSSREF_FILTER,
          request: CROSSREF_WORKS_ADAPTER.request({ query: "q", limit: 1 }, "GET"),
          normalized: CROSSREF_WORKS_ADAPTER.response(
            { status: 200, json: FIXTURE },
            { query: "q", limit: 20 },
            "2026-09-23T12:00:00.000Z",
          ),
        }),
      )
      .digest("hex");
    expect(fingerprint).toMatchSnapshot();
  });
});

describe("normalizing a Crossref answer into the declared search result", () => {
  const retrieved = "2026-09-23T12:00:00.000Z";

  it("returns only the declared fields, with provenance, from a real captured response", () => {
    const result = CROSSREF_WORKS_ADAPTER.response(
      { status: 200, json: FIXTURE },
      { query: "communication topology multi-agent LLM", limit: 10 },
      retrieved,
    ) as { papers: Array<Record<string, unknown>>; query: string; source: string; skipped_records: number };
    expect(result.source).toBe("crossref");
    expect(result.query).toBe("communication topology multi-agent LLM");
    expect(result.papers.length + result.skipped_records).toBe(10);
    for (const paper of result.papers) {
      expect(Object.keys(paper).sort()).toEqual([
        "abstract",
        "arxiv_id",
        "authors",
        "doi",
        "provenance",
        "source",
        "title",
        "url",
        "venue",
        "year",
      ]);
      expect(typeof paper.title).toBe("string");
      expect(paper.arxiv_id).toBeNull();
      expect(paper.source).toBe("crossref");
      expect(paper.provenance).toEqual([
        {
          source: "crossref",
          query: "communication topology multi-agent LLM",
          locator: paper.doi,
          synthetic: false,
          retrieved_at: retrieved,
        },
      ]);
      if (paper.doi !== null) expect(paper.doi).toBe(String(paper.doi).toLowerCase());
      if (paper.abstract !== null) expect(String(paper.abstract)).not.toMatch(/<\/?jats:/u);
    }
  });

  it("renders every field with the resolver's rules and dates it in the resolver's order", () => {
    const json = {
      status: "ok",
      message: {
        items: [
          {
            DOI: "10.1234/ABC.Def",
            title: ["A <i>marked</i> title &amp; more"],
            author: [
              { given: "Ada", family: "Lovelace" },
              { name: "The <b>Consortium</b>" },
              { family: "" },
              "not an author",
            ],
            "published-online": { "date-parts": [[2024, 5]] },
            issued: { "date-parts": [[2023]] },
            "container-title": ["Proceedings of &quot;X&quot;"],
            abstract: "<jats:title>Abstract</jats:title><jats:p>We   study x.</jats:p>",
            URL: "https://doi.org/10.1234/abc.def",
          },
        ],
      },
    };
    const result = CROSSREF_WORKS_ADAPTER.response({ status: 200, json }, { query: "q", limit: 5 }, retrieved) as {
      papers: Array<Record<string, unknown>>;
    };
    expect(result.papers[0]).toMatchObject({
      title: "A marked title & more",
      doi: "10.1234/abc.def",
      authors: [{ name: "Ada Lovelace" }, { name: "The Consortium" }],
      year: 2024,
      venue: 'Proceedings of "X"',
      abstract: "AbstractWe study x.",
      url: "https://doi.org/10.1234/abc.def",
    });
  });

  it("represents what is missing as missing, and counts records it cannot use", () => {
    const json = {
      status: "ok",
      message: {
        items: [
          { DOI: "10.1/a", title: [] },
          { DOI: "10.1/b" },
          { DOI: "10.1/c", title: ["Only a title"] },
          { title: ["No DOI at all"], URL: "javascript:alert(1)", author: "nobody" },
          { title: ["Bad dates"], issued: { "date-parts": [[null]] }, published: { "date-parts": [["2020"]] } },
          7,
        ],
      },
    };
    const result = CROSSREF_WORKS_ADAPTER.response({ status: 200, json }, { query: "q", limit: 20 }, retrieved) as {
      papers: Array<Record<string, unknown>>;
      skipped_records: number;
    };
    expect(result.skipped_records).toBe(3);
    expect(result.papers.map((paper) => paper.title)).toEqual(["Only a title", "No DOI at all", "Bad dates"]);
    expect(result.papers[0]).toMatchObject({ authors: [], year: null, venue: null, abstract: null, url: null });
    expect(result.papers[1]).toMatchObject({ doi: null, url: null, authors: [] });
    expect(result.papers[2]!.year).toBeNull();
  });

  it("never returns more papers than the limit asked for", () => {
    const items = Array.from({ length: 30 }, (_, index) => ({ DOI: `10.1/${index}`, title: [`T${index}`] }));
    const result = CROSSREF_WORKS_ADAPTER.response(
      { status: 200, json: { status: "ok", message: { items } } },
      { query: "q", limit: 4 },
      retrieved,
    ) as { papers: unknown[] };
    expect(result.papers).toHaveLength(4);
  });

  it("refuses a malformed answer rather than inventing an empty one", () => {
    for (const json of [
      null,
      [],
      { status: "failed", message: { items: [] } },
      { status: "ok" },
      { status: "ok", message: { items: "nope" } },
    ]) {
      expect(() =>
        CROSSREF_WORKS_ADAPTER.response({ status: 200, json }, { query: "q", limit: 3 }, retrieved),
      ).toThrow(/work list/u);
    }
  });
});

describe("a Crossref call obeys the broker's transport policy", () => {
  it("maps rate limiting, server errors and other statuses to failures, never data", async () => {
    const signal = new AbortController().signal;
    for (const [status, code] of [
      [429, "tool_unavailable"],
      [500, "tool_unavailable"],
      [503, "tool_unavailable"],
      [403, "tool_unavailable"],
      [400, "tool_transport_error"],
      [404, "tool_transport_error"],
    ] as const) {
      const { item, broker: tools } = broker(ok({ status: "failed", message: [] }, status));
      expect(await failure(tools.call(call(item, { query: "x", limit: 1 }), signal))).toMatch(
        new RegExp(`^${code}`, "u"),
      );
    }
  });

  it("refuses a non-JSON answer and invalid JSON", async () => {
    const signal = new AbortController().signal;
    const html = broker(async () => ({ status: 200, contentType: "text/html", body: "<html></html>" }));
    expect(await failure(html.broker.call(call(html.item, { query: "x", limit: 1 }), signal))).toMatch(
      /^tool_response_invalid/u,
    );
    const broken = broker(async () => ({ status: 200, contentType: "application/json", body: "{" }));
    expect(await failure(broken.broker.call(call(broken.item, { query: "x", limit: 1 }), signal))).toMatch(
      /^tool_response_invalid/u,
    );
  });

  it("refuses a host that resolves to a private destination, before connecting", async () => {
    let connected = false;
    for (const address of ["127.0.0.1", "10.0.0.8", "169.254.169.254", "::1", "fd00::1"]) {
      const { item, broker: tools } = broker(
        async () => {
          connected = true;
          return { status: 200, contentType: "application/json", body: JSON.stringify(FIXTURE) };
        },
        async () => [address],
      );
      expect(await failure(tools.call(call(item, { query: "x", limit: 1 }), new AbortController().signal))).toMatch(
        /non-public destination/u,
      );
    }
    expect(connected).toBe(false);
  });

  it("stops when the run is cancelled, and when the binding's deadline passes", async () => {
    const hang: HttpTransport = (options) =>
      new Promise((_, reject) => {
        options.signal.addEventListener("abort", () => reject(new Error("aborted")));
      });
    const cancelled = broker(hang);
    const controller = new AbortController();
    const pending = cancelled.broker.call(call(cancelled.item, { query: "x", limit: 1 }), controller.signal);
    controller.abort();
    expect(await failure(pending)).toMatch(/^tool_cancelled/u);

    const slow = broker(hang);
    const item = { ...slow.item, timeoutSeconds: 1 };
    const quick = new ToolBroker({
      bound: [item],
      definitions: [{ ...SEARCH, timeoutSeconds: 1 }],
      logger: log,
      resolver: async () => ["104.18.0.1"],
      transport: hang,
      pacer: new Pacer(),
    });
    expect(await failure(quick.call(call(item, { query: "x", limit: 1 }), new AbortController().signal))).toMatch(
      /^tool_timeout/u,
    );
  }, 10_000);

  it("honours Crossref's stated limits: one call at a time, one start per second", async () => {
    // Crossref's public pool answers with x-concurrency-limit: 1 and one
    // request per second; the shipped binding waits rather than being refused.
    expect(SHIPPED.maxConcurrent).toBe(1);
    expect(SHIPPED.minIntervalMs).toBe(1000);
    expect(describeBinding(SHIPPED, { env: {} }).limits).toMatchObject({
      max_concurrent: 1,
      min_interval_ms: 1000,
    });
    const starts: number[] = [];
    let inFlight = 0;
    let peak = 0;
    const transport: HttpTransport = async () => {
      starts.push(Date.now());
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 20));
      inFlight -= 1;
      return { status: 200, contentType: "application/json", body: JSON.stringify(FIXTURE) };
    };
    const item = { ...bound(), timeoutSeconds: 25 };
    const paced = new ToolBroker({
      bound: [item],
      definitions: [SHIPPED],
      logger: log,
      resolver: async () => ["104.18.0.1"],
      transport,
      pacer: new Pacer(),
    });
    const signal = new AbortController().signal;
    await Promise.all(
      ["one", "two", "three"].map((query) => paced.call(call(item, { query, limit: 2 }), signal)),
    );
    expect(peak).toBe(1);
    expect(starts[1]! - starts[0]!).toBeGreaterThanOrEqual(950);
    expect(starts[2]! - starts[1]!).toBeGreaterThanOrEqual(950);
  }, 10_000);

  it("refuses an oversized answer through the transport's byte cap", async () => {
    const { item, broker: tools } = broker(async (options) => {
      expect(options.maxResponseBytes).toBe(512 * 1024);
      throw new AgentBrowserError("tool_call_failed", "The tool call failed", "tool_response_invalid: the tool response is too large");
    });
    expect(await failure(tools.call(call(item, { query: "x", limit: 1 }), new AbortController().signal))).toMatch(
      /too large/u,
    );
  });
});
