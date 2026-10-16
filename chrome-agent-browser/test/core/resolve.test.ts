/**
 * Resolvers (T8): what the address bar treats as a search, the agent index's rules beyond its
 * schema, the static resolver's matching and order, and the NANDA stub's mapping from
 * AgentAddr + AgentFacts (arXiv 2507.14263, appendix example) to a candidate that is metadata only.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { CoreError } from "../../src/core/errors.js";
import type { JsonObject } from "../../src/core/json.js";
import { agentFactsCandidate, AGENT_PACKAGE_MEMBER, NandaResolver, type AgentAddr } from "../../src/core/resolve/nanda.js";
import { indexState, readAgentIndex, StaticIndexResolver, type VerifiedIndex } from "../../src/core/resolve/static-index.js";
import { addressKind, readQuery, type ResolveQuery } from "../../src/core/resolve/types.js";
import { ROOT, SHIPPED } from "../helpers/paths.js";

const CONTENT = JSON.parse(readFileSync(resolve(ROOT, "examples/agent-index.content.json"), "utf8")) as JsonObject;
const NOW = new Date("2026-10-15T12:00:00Z");

function held(content: JsonObject = CONTENT): VerifiedIndex {
  return { index: readAgentIndex(content), signer_fingerprint: `sha256:${"a".repeat(64)}`, content_sha256: "b".repeat(64), document_sha256: "c".repeat(64) };
}

function variant(change: (content: JsonObject & { entries: JsonObject[] }) => void): JsonObject {
  const copy = JSON.parse(JSON.stringify(CONTENT)) as JsonObject & { entries: JsonObject[] };
  change(copy);
  return copy;
}

const q = (text: string): ResolveQuery => readQuery(text)!;

describe("what the address bar searches", () => {
  it.each([
    ["https://webagents-webair-production.up.railway.app/", "address"],
    ["https://example.org/agent.pkg", "address"],
    ["webagents-webair-production.up.railway.app", "address"],
    ["example.org/path", "address"],
    ["literature review", "search"],
    ["flights@webair.example", "search"],
    ["papers", "search"],
    ["what is a.b", "search"],
  ])("%s → %s", (input, kind) => {
    expect(addressKind(input)).toBe(kind);
  });

  it("normalizes a query and tells a locator from free text", () => {
    expect(readQuery("  Literature   REVIEW ")).toEqual({ kind: "text", text: "literature review" });
    expect(readQuery("Flights@WebAir.example")).toEqual({ kind: "locator", text: "flights@webair.example" });
    expect(readQuery("   ")).toBeNull();
  });
});

describe("the agent index (spec §4)", () => {
  it("reads the demo index in its own order", () => {
    const index = readAgentIndex(CONTENT);
    expect(index.entries.map((entry) => entry.package_id)).toEqual([SHIPPED.literatureReview028.packageId, SHIPPED.webair060.packageId]);
    expect(index.notes).toEqual([]);
  });

  it("refuses a disordered window and a repeated package or URL as a whole", () => {
    const code = (content: JsonObject) => {
      try {
        readAgentIndex(content);
        return "accepted";
      } catch (error) {
        return (error as CoreError).code + ": " + (error as CoreError).message;
      }
    };
    expect(code(variant((c) => (c.expires_at = c.issued_at)))).toMatch(/document_content_invalid: .*expires_at/u);
    expect(code(variant((c) => c.entries.push({ ...c.entries[0]!, package_url: "https://other.example/x.agent.pkg" })))).toMatch(/lists org\.webagents\.literature-review@0\.2\.8 twice/u);
    expect(code(variant((c) => c.entries.push({ ...c.entries[0]!, version: "0.2.9" })))).toMatch(/package URL .* twice/u);
  });

  it.each([
    ["http://example.org/a.agent.pkg", /https/u],
    ["https://127.0.0.1/a.agent.pkg", /IP literal/u],
    ["https://localhost/a.agent.pkg", /local/u],
    ["https://example.org:8443/a.agent.pkg", /port 443/u],
  ])("leaves out an entry whose URL the browser's gate refuses (%s)", (url, why) => {
    const index = readAgentIndex(variant((c) => (c.entries[0]!.package_url = url)));
    expect(index.entries.map((entry) => entry.package_id)).toEqual([SHIPPED.webair060.packageId]);
    expect(index.notes).toHaveLength(1);
    expect(index.notes[0]!.code).toBe("entry_url_refused");
    expect(index.notes[0]!.detail).toMatch(why);
  });

  it("is used only inside its validity window", () => {
    const index = readAgentIndex(CONTENT);
    expect(indexState(index, NOW)).toBe("current");
    expect(indexState(index, new Date("2028-01-01T00:00:00Z"))).toBe("expired");
    expect(indexState(index, new Date("2026-10-07T00:00:00Z"))).toBe("not_yet_valid");
  });
});

describe("StaticIndexResolver", () => {
  const resolver = new StaticIndexResolver(held(), () => NOW);

  it("finds Literature Review by free text, with the index as its source", async () => {
    const result = await resolver.query(q("literature review"));
    expect(result.notes).toEqual([]);
    expect(result.candidates).toHaveLength(1);
    const candidate = result.candidates[0]!;
    expect(candidate).toMatchObject({ package_id: SHIPPED.literatureReview028.packageId, version: "0.2.8", digest: SHIPPED.literatureReview028.digest, signer_fingerprint: SHIPPED.literatureReview028.fingerprint });
    expect(candidate.source).toEqual({ resolver: "static-index", resolver_id: "org.webagents.demo-index", label: "WebAgents demo index", version: "1.3.0", verified_by: `sha256:${"a".repeat(64)}`, content_sha256: "b".repeat(64), position: 0 });
  });

  it("matches every word anywhere, a locator exactly, and keeps the index's order", async () => {
    expect((await resolver.query(q("fictional airline"))).candidates.map((c) => c.package_id)).toEqual([SHIPPED.webair060.packageId]);
    expect((await resolver.query(q("flights@webair.example"))).candidates.map((c) => c.package_id)).toEqual([SHIPPED.webair060.packageId]);
    expect((await resolver.query(q("webair.example"))).candidates).toHaveLength(1);
    expect((await resolver.query(q("flights@other.example"))).candidates).toEqual([]);
    expect((await resolver.query(q("quantum teleportation"))).candidates).toEqual([]);
    expect((await resolver.query({ kind: "text", text: "" })).candidates.map((c) => c.source.position)).toEqual([0, 1]);
    expect(resolver.entryFor(`https://webagents-webair-production.up.railway.app/agent.pkg`)?.package_id).toBe(SHIPPED.webair060.packageId);
  });

  it("answers nothing from an expired index, and says so", async () => {
    const expired = new StaticIndexResolver(held(), () => new Date("2028-01-01T00:00:00Z"));
    const result = await expired.query(q("literature"));
    expect(result.candidates).toEqual([]);
    expect(result.notes[0]?.code).toBe("index_expired");
  });
});

describe("the NANDA stub", () => {
  /** The appendix's AgentFacts example (Salesforce translation agent), plus the package member. */
  const FACTS = {
    id: "nanda:550e8400-e29b-41d4-a716-4466554400",
    agent_name: "urn:agent:salesforce:TranslationAssistant",
    label: "TranslationAssistant",
    description: "Autonomous agent for low-latency multilingual translation",
    version: "1.2.1",
    documentationUrl: "https://docs.salesforce.com/agents/translation",
    jurisdiction: "USA",
    provider: { name: "Salesforce", url: "https://salesforce.com", did: "did:web:salesforce.com" },
    endpoints: { static: ["https://api.salesforce.com/v1/translation"] },
    evaluations: { performanceScore: 4.8, availability90d: "99.93%", auditorID: "Capabilities Auditor v2.1" },
    certification: { level: "verified", issuer: "Salesforce", issuanceDate: "2025-03-15T09:30:00Z", expirationDate: "2026-03-15T09:30:00Z" },
    [AGENT_PACKAGE_MEMBER]: { package_url: "https://agents.example.org/translation-1.2.1.agent.pkg", package_id: "org.example.translation", version: "1.2.1", digest: "d".repeat(64), signer_fingerprint: `sha256:${"e".repeat(64)}`, publisher_id: "example-translation" },
  };
  const ADDR: AgentAddr = {
    agent_id: "nanda:550e8400-e29b-41d4-a716-4466554400",
    agent_name: "translation@salesforce.example",
    primary_facts_url: "https://translation.salesforce.example/.agent-facts",
    private_facts_url: null,
    adaptive_resolver_url: null,
    ttl: 3600,
    signature: null,
  };

  it("without a configured registry answers with a note and nothing else", async () => {
    const result = await new NandaResolver().query(q("translation@salesforce.example"));
    expect(result).toEqual({ candidates: [], notes: [expect.objectContaining({ code: "nanda_not_configured" })] });
  });

  it("maps AgentAddr and AgentFacts to a candidate whose claims are shown, not checked", () => {
    const candidate = agentFactsCandidate(ADDR, FACTS, { id: "nanda-test", label: "NANDA (test)" })!;
    expect(candidate).toMatchObject({
      package_id: "org.example.translation",
      name: "TranslationAssistant",
      version: "1.2.1",
      publisher: { id: "example-translation", name: "Salesforce" },
      package_url: "https://agents.example.org/translation-1.2.1.agent.pkg",
      digest: "d".repeat(64),
      archive_sha256: null,
      locators: ["translation@salesforce.example"],
      homepage: "https://docs.salesforce.com/agents/translation",
      source: { resolver: "nanda", resolver_id: "nanda-test", verified_by: null },
    });
    expect(candidate.claims).toEqual([
      { label: "Certification", value: "verified by Salesforce until 2026-03-15T09:30:00Z" },
      { label: "Evaluation", value: "score 4.8 by Capabilities Auditor v2.1" },
      { label: "Jurisdiction", value: "USA" },
    ]);
    const { [AGENT_PACKAGE_MEMBER]: _member, ...serviceOnly } = FACTS;
    expect(agentFactsCandidate(ADDR, serviceOnly, { id: "n", label: "n" })).toBeNull();
  });

  it("with ports, looks up a locator, fetches the facts and maps them; free text is not a name", async () => {
    const asked: string[] = [];
    const resolver = new NandaResolver({ id: "nanda-test", label: "NANDA (test)" }, {
      lookup: async (name) => {
        asked.push(`lookup ${name}`);
        return name === ADDR.agent_name ? ADDR : null;
      },
      facts: async (url) => {
        asked.push(`facts ${url}`);
        return FACTS;
      },
    });
    expect((await resolver.query(q("translation@salesforce.example"))).candidates.map((c) => c.package_id)).toEqual(["org.example.translation"]);
    expect(await resolver.query(q("nobody@salesforce.example"))).toEqual({ candidates: [], notes: [] });
    expect((await resolver.query(q("translation"))).notes[0]?.code).toBe("nanda_needs_locator");
    expect(asked).toEqual(["lookup translation@salesforce.example", `facts ${ADDR.primary_facts_url}`, "lookup nobody@salesforce.example"]);
  });
});
