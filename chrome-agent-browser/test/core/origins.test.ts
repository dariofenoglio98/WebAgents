/**
 * The origins a plan needs (T16, D-193): computed from the shipped packages' declarations and
 * this host's registry, never from a name in the code: WebAir reaches its own origin, Literature
 * Review reaches Crossref and the citation resolver, a denied tool contributes nothing, Ollama
 * and the built-in model contribute nothing, a hosted provider contributes its endpoint.
 */
import { describe, expect, it } from "vitest";

import { defaultDecisions } from "../../src/core/authorization.js";
import { canonicalJson } from "../../src/core/canonical.js";
import { sha256Hex } from "../../src/core/hash.js";
import { buildHostToolRegistry, evaluateRegistry, planToolBindings } from "../../src/core/hosttools.js";
import { httpsOrigin, originPattern, patternOrigin, planOrigins, toolBindingsForOrigins, urlInOrigins } from "../../src/core/origins.js";
import { loadPackageBytes } from "../../src/core/package.js";
import { demoHostResources } from "../helpers/fixtures.js";
import { readBytes, SHIPPED } from "../helpers/paths.js";

const NOW = new Date("2026-10-13T12:00:00.000Z");
const WEBAIR_ORIGIN = "https://webagents-webair-production.up.railway.app";
const RESOLVER_ORIGIN = "https://webagents-citation-resolver-production.up.railway.app";
const CROSSREF_ORIGIN = "https://api.crossref.org";

async function bindingsOf(archive: string, overrides: { deny?: string[] } = {}) {
  const pkg = await loadPackageBytes(readBytes(archive));
  const resourceTypes = await Promise.all(demoHostResources().types.map(async (type) => ({ id: type.id, display_name: type.display_name, permission_kind: type.permission_kind, schema_sha256: await sha256Hex(canonicalJson(type.schema)) })));
  const registry = await buildHostToolRegistry(pkg, { resourceTypes, runtimeVersion: "0.3.0", now: NOW, contactConfigured: false });
  const decided = defaultDecisions(pkg, "convenience");
  const approvals = { ...decided.tool_approvals };
  for (const toolId of overrides.deny ?? []) approvals[toolId] = false;
  const evaluation = await evaluateRegistry(pkg, registry, { decisions: decided.decisions, toolApprovals: approvals, now: NOW });
  const bindings = planToolBindings(evaluation).filter((binding) => approvals[binding.tool_id] === true);
  return { pkg, registry, bindings };
}

describe("planOrigins over the shipped packages", () => {
  it("WebAir 0.5.0 needs its own origin for the package and its remote tools, and nothing for its local resource tools", async () => {
    const { bindings, registry } = await bindingsOf(SHIPPED.webair050.archive);
    const origins = planOrigins({ packageUrl: `${WEBAIR_ORIGIN}/agent.pkg`, toolBindings: toolBindingsForOrigins(bindings, registry), model: { provider_id: "ollama", base_url: "http://127.0.0.1:11434" } });
    expect(origins.map((item) => item.origin)).toEqual([WEBAIR_ORIGIN]);
    expect(origins[0]!.roles).toEqual(["package", "tool"]);
    expect(origins[0]!.subjects).toContain("package");
    expect(origins[0]!.subjects.filter((subject) => subject !== "package").length).toBeGreaterThanOrEqual(3);
    // The local resource bindings (host.resource.*) name no origin.
    expect(bindings.filter((binding) => binding.remote === false).length).toBeGreaterThanOrEqual(1);
  });

  it("Literature Review 0.2.7 needs Crossref (search and the DOI fallback), the citation resolver and the package's origin; the paper reader needs nothing", async () => {
    const { bindings, registry } = await bindingsOf(SHIPPED.literatureReview027.archive);
    const packageUrl = "https://research.example/literature-review-0.2.7.agent.pkg";
    const origins = planOrigins({ packageUrl, toolBindings: toolBindingsForOrigins(bindings, registry), model: { provider_id: "openai", base_url: null } });
    expect(origins.map((item) => item.origin)).toEqual([CROSSREF_ORIGIN, "https://research.example", RESOLVER_ORIGIN]);
    const crossref = origins.find((item) => item.origin === CROSSREF_ORIGIN)!;
    // Both the search adapter and the citation tool's fallback need Crossref (D-153).
    expect(crossref.subjects.length).toBe(2);
    const withFallback = toolBindingsForOrigins(bindings, registry).find((binding) => binding.fallback_origin !== null);
    expect(withFallback?.fallback_origin).toBe(CROSSREF_ORIGIN);
    // Without the registry the fallback is unknown and only the endpoints count.
    const bare = planOrigins({ packageUrl, toolBindings: toolBindingsForOrigins(bindings, null), model: null });
    expect(bare.find((item) => item.origin === CROSSREF_ORIGIN)!.subjects.length).toBe(1);
  });

  it("a denied tool contributes nothing", async () => {
    const { bindings, registry } = await bindingsOf(SHIPPED.literatureReview027.archive, { deny: ["citation-resolver"] });
    const origins = planOrigins({ packageUrl: null, toolBindings: toolBindingsForOrigins(bindings, registry), model: null });
    expect(origins.map((item) => item.origin)).toEqual([CROSSREF_ORIGIN]);
    expect(origins[0]!.subjects).toEqual(["scholarly-search"]);
  });
});

describe("planOrigins over the host's model settings", () => {
  const binding = { tool_id: "t", approved: true, remote: true, endpoint_origin: "https://tools.example", fallback_origin: null };
  it("a hosted provider adds its endpoint origin (the default or the connection's); Ollama and the built-in model add none", () => {
    expect(planOrigins({ packageUrl: null, toolBindings: [binding], model: { provider_id: "openai", base_url: "https://api.openai.com" } }).map((item) => [item.origin, item.roles, item.subjects])).toEqual([
      ["https://api.openai.com", ["provider"], ["openai"]],
      ["https://tools.example", ["tool"], ["t"]],
    ]);
    expect(planOrigins({ packageUrl: null, toolBindings: [], model: { provider_id: "anthropic", base_url: "https://proxy.example/v1" } }).map((item) => item.origin)).toEqual(["https://proxy.example"]);
    expect(planOrigins({ packageUrl: null, toolBindings: [], model: { provider_id: "ollama", base_url: "http://127.0.0.1:11434" } })).toEqual([]);
    expect(planOrigins({ packageUrl: null, toolBindings: [], model: { provider_id: "ollama", base_url: "http://localhost:11434" } })).toEqual([]);
    expect(planOrigins({ packageUrl: null, toolBindings: [], model: { provider_id: "chrome-builtin", base_url: null } })).toEqual([]);
    expect(planOrigins({ packageUrl: null, toolBindings: [], model: null })).toEqual([]);
  });

  it("merges one origin's roles and subjects, drops non-HTTPS and malformed URLs, and sorts", () => {
    const origins = planOrigins({
      packageUrl: "https://tools.example/agent.pkg",
      toolBindings: [binding, { ...binding, tool_id: "u", endpoint_origin: "https://tools.example:443", fallback_origin: "https://fallback.example" }, { ...binding, tool_id: "v", endpoint_origin: "http://insecure.example" }, { ...binding, tool_id: "w", endpoint_origin: "not a url" }, { ...binding, tool_id: "x", approved: false, endpoint_origin: "https://denied.example" }, { ...binding, tool_id: "y", remote: false, endpoint_origin: "https://local.example" }],
      model: { provider_id: "openai", base_url: "https://tools.example" },
    });
    expect(origins).toEqual([
      { origin: "https://fallback.example", roles: ["tool"], subjects: ["u"] },
      { origin: "https://tools.example", roles: ["package", "provider", "tool"], subjects: ["openai", "package", "t", "u"] },
    ]);
  });

  it("patterns and membership", () => {
    expect(originPattern("https://tools.example")).toBe("https://tools.example/*");
    expect(patternOrigin("https://tools.example/*")).toBe("https://tools.example");
    expect(patternOrigin("https://*/*")).toBeNull();
    expect(patternOrigin("https://tools.example/path")).toBeNull();
    expect(httpsOrigin("https://Tools.Example/x?y")).toBe("https://tools.example");
    expect(httpsOrigin("https://tools.example:8443/x")).toBe("https://tools.example:8443");
    expect(httpsOrigin("http://tools.example/")).toBeNull();
    expect(urlInOrigins("https://tools.example/api/v1/search", ["https://tools.example"])).toBe(true);
    expect(urlInOrigins("https://tools.example.evil/api", ["https://tools.example"])).toBe(false);
    expect(urlInOrigins("https://tools.example:8443/api", ["https://tools.example"])).toBe(false);
  });
});
