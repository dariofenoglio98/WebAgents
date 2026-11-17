/**
 * The join's host-neutral pieces (link.v0 §6, §7; `agentpkg/tests/test_link_join.py`'s unit part):
 * where a slot looks (L-7), the slot's ceiling and the order of figures (L-33), the agent's reason
 * as the card shows it, a host's answer against the decision contract (L-35, L-44), the recorded
 * person, and the recorded web replayed through the discovery and package-URL code (L-29).
 */
import { describe, expect, it } from "vitest";

import { checkRunDecision } from "../../../src/core/conversation/host.js";
import type { JsonObject } from "../../../src/core/json.js";
import { locateReferences } from "../../../src/core/links/declarations.js";
import { ceiling, FixtureConsent, locateUrls, overCeiling, RecordedWeb, slotReason } from "../../../src/core/links/join.js";
import { linkCost } from "../../../src/core/network/analysis.js";

const step: JsonObject = {
  id: "ask",
  type: "link",
  slot: "named-hotel",
  locate: { coalesce: [{ from: "input", path: "/hotel_url" }, { from: "steps", path: "/find/results/0/url" }] },
  input: { object: { check_in: { from: "state", path: "/trip/check_in" } } },
  request: { task: "request", max_output_tokens: 1500 },
  max_joins: 1,
  budget: { model_calls: 1, tool_calls: 1, remote_calls: 3, tokens: 6000 },
  output_schema: "schemas/join-outcome.schema.json",
  timeout_seconds: 300,
};

describe("where a slot looks (L-7)", () => {
  it("a coalesce yields its first member that yields a URL; an array yields each once, at most three", () => {
    const steps = { find: { results: [{ url: "https://hotel.example/" }] } };
    expect(locateUrls(step.locate!, { input: { hotel_url: "https://named.example/" }, steps })).toEqual(["https://named.example/"]);
    expect(locateUrls(step.locate!, { input: { hotel_url: null }, steps })).toEqual(["https://hotel.example/"]);
    expect(locateUrls(step.locate!, { input: {}, steps: {} })).toEqual([]);
    const array = { array: [{ from: "input", path: "/a" }, { from: "input", path: "/b" }, { from: "input", path: "/a" }, { from: "input", path: "/c" }, { from: "input", path: "/d" }] };
    expect(locateUrls(array, { input: { a: "https://a.example/", b: "https://b.example/", c: "https://c.example/", d: "https://d.example/" } })).toEqual(["https://a.example/", "https://b.example/", "https://c.example/"]);
  });

  it("names only references, arrays and coalesces of them", () => {
    expect(locateReferences(step.locate!)).toHaveLength(2);
    expect(locateReferences({ literal: "https://a.example/" })).toBeNull();
    expect(locateReferences({ coalesce: [{ from: "input", path: "/a" }], extra: 1 } as unknown as JsonObject)).toBeNull();
  });
});

describe("the slot's ceiling (L-6, L-21, L-33)", () => {
  it("is every figure of the at most, a figure left out being zero, and costs one request-building call more", () => {
    expect(ceiling(step)).toEqual({ model_calls: 1, tool_calls: 1, compute_calls: 0, remote_calls: 3, tokens: 6000, seconds: 300 });
    expect(linkCost(step)).toEqual({ model_calls: 2, tool_calls: { "named-hotel:*": 1 }, compute_calls: 0, remote_calls: 3, tokens: 6000 });
  });

  it("refuses a candidate by the first figure it passes, in the order model, tool, compute, remote calls, tokens, seconds", () => {
    const fits = { model_calls: 1, tool_calls: { a: 1 }, compute_calls: 0, remote_calls: 3, tokens: 6000, seconds: 300 };
    expect(overCeiling(fits, step)).toBeNull();
    expect(overCeiling({ ...fits, tool_calls: { a: 1, b: 1 }, tokens: 9000 }, step)).toBe("tool_calls");
    expect(overCeiling({ ...fits, compute_calls: 1, seconds: 301 }, step)).toBe("compute_calls");
    expect(overCeiling({ ...fits, seconds: 301 }, step)).toBe("seconds");
  });

  it("shows the agent's reason as at most 500 characters, and nothing for an empty one", () => {
    expect(slotReason("  ")).toBeNull();
    expect(slotReason(42)).toBeNull();
    expect([...slotReason("é".repeat(600))!]).toHaveLength(500);
  });
});

describe("a host's answer to a card (L-35, L-44)", () => {
  it("is accepted with its provenance and, for a join, the joined package's own grants and tools, sorted", () => {
    expect(checkRunDecision("link.join", { accepted: true, provenance: "fixture", grants: { "model.reasoning": "session" }, approved_tools: ["b", "a", "a"] })).toEqual({ accepted: true, provenance: "fixture", grants: { "model.reasoning": "session" }, approved_tools: ["a", "b"] });
    expect(checkRunDecision("budget.raise", { accepted: false, provenance: "timeout" })).toEqual({ accepted: false, provenance: "timeout" });
  });

  it("outside the contract is the host's failure, never a yes", () => {
    for (const answer of [null, { accepted: "yes", provenance: "fixture" }, { accepted: true }, { accepted: true, provenance: "Not A Code" }, { accepted: true, provenance: "fixture", extra: 1 }, { accepted: true, provenance: "fixture", grants: [] }]) {
      expect(() => checkRunDecision("link.join", answer), JSON.stringify(answer)).toThrow(/decision contract|grants are a map/u);
    }
    expect(() => checkRunDecision("budget.raise", { accepted: true, provenance: "fixture", grants: {} })).toThrow(/decision contract/u);
  });

  it("from a recording answers each slot's cards in order, and a card it does not decide is a no", async () => {
    const consent = new FixtureConsent({ "named-hotel": [{ accepted: true, grants: { g: "session" } }] }, { accepted: true });
    const ask = (slot: string) => consent.ask({ kind: "link.join", run_id: "r", node_id: "n", facts: { slot }, timeout_seconds: 1 });
    expect(await ask("named-hotel")).toEqual({ accepted: true, provenance: "fixture", grants: { g: "session" }, approved_tools: [] });
    expect(await ask("named-hotel")).toEqual({ accepted: false, provenance: "fixture" });
    expect(await ask("other")).toEqual({ accepted: false, provenance: "fixture" });
    expect(await consent.ask({ kind: "budget.raise", run_id: "r", node_id: "n", facts: {}, timeout_seconds: 1 })).toEqual({ accepted: true, provenance: "fixture" });
  });
});

describe("the recorded web (L-29, §10)", () => {
  const page = new TextEncoder().encode('<html><head><link rel="agent-package" type="application/vnd.webagents.agent-package" href="/agent.pkg"></head><body></body></html>');
  const web = new RecordedWeb(new Map([["https://hotel.example/", { body: page }]]), new Map([["https://hotel.example/agent.pkg", new Uint8Array([1, 2, 3])]]));

  it("replays a recorded page through discovery and a recorded archive through the package-URL policy", async () => {
    const found = await web.look("https://hotel.example/#rooms");
    expect(found.candidates.filter((candidate) => candidate.accepted).map((candidate) => candidate.resolved_url)).toEqual(["https://hotel.example/agent.pkg"]);
    expect(await web.download("https://hotel.example/agent.pkg")).toEqual(new Uint8Array([1, 2, 3]));
  });

  it("answers what it did not record as the network would refuse it, and refuses what the policies refuse, before any look", async () => {
    await expect(web.look("https://other.example/")).rejects.toMatchObject({ code: "discovery_http_status" });
    await expect(web.download("https://hotel.example/other.pkg")).rejects.toMatchObject({ code: "download_failed" });
    await expect(web.look("http://hotel.example/")).rejects.toMatchObject({ code: "url_rejected" });
    await expect(web.download("https://127.0.0.1/agent.pkg")).rejects.toMatchObject({ code: "url_rejected" });
    expect(web.requests.map((request) => request.kind)).toEqual(["discovery", "package", "discovery", "package", "discovery", "package"]);
  });
});
