/**
 * The host's own implementations of two abstract capabilities (T6, D-081, D-082): Literature
 * Review 0.2.5's three tools all bind on the Chrome host (the Citation Resolver on the generic
 * JSON POST binding at the origin the package declares, `scholarly.search` on the Crossref
 * adapter, `paper.read` on the selected-PDF reader); the pinned contract digests are the package's
 * own schema digests; a different contract is `incompatible`; a GET with no service adapter stays
 * unbound; the contact address is part of the binding digest; and the Crossref binding's pacing
 * holds through the broker.
 */
import { describe, expect, it } from "vitest";

import { canonicalJson } from "../../../src/core/canonical.js";
import { sha256HexSync } from "../../../src/core/hash.js";
import { BOUND, buildHostToolRegistry, CROSSREF_CONTACT_SOURCE, evaluateRegistry, INCOMPATIBLE, LOCAL_IMPLEMENTATIONS, planToolBindings, SERVICE_IMPLEMENTATIONS, UNBOUND } from "../../../src/core/hosttools.js";
import type { JsonObject, JsonValue } from "../../../src/core/json.js";
import type { HttpTransport } from "../../../src/core/models/transport.js";
import { normalizeToolBindings } from "../../../src/core/tools/bindings.js";
import { toolHandlers } from "../../../src/core/tools/broker.js";
import { bindingDigest, definitionsFromRegistry, describeDefinition } from "../../../src/core/tools/definitions.js";
import { Pacer } from "../../../src/core/tools/pacer.js";
import { literatureReview } from "../../helpers/fixtures.js";

const NOW = new Date("2026-10-08T12:00:00.000Z");
const schemaDigest = (pkg: Awaited<ReturnType<typeof literatureReview>>, path: string) => sha256HexSync(canonicalJson(JSON.parse(new TextDecoder().decode(pkg.files.get(path)!))));
const ALL_SESSION = { "network.scholarly": "session", "network.citations": "session", "files.pdfs": "session", "model.reasoning": "session", "memory.session": "session" } as const;
const APPROVED = { "scholarly-search": true, "citation-resolver": true, "paper-reader": true };

describe("Literature Review binds on the Chrome host", () => {
  it("serves every declared tool, each with exactly one implementation, and freezes plan records for them", async () => {
    const pkg = await literatureReview();
    const registry = await buildHostToolRegistry(pkg, { resourceTypes: [], runtimeVersion: "0.1.0", now: NOW });
    expect(registry.notes).toEqual([]);
    expect(registry.bindings.map((binding) => [binding.tool_id, binding.id, binding.implementation_kind, binding.implementation_id])).toEqual([
      ["citation-resolver", "chrome:json_http:citation-resolver:1", "json_http", "chrome.tool.json_http"],
      ["paper-reader", "chrome:selected_pdf_text:paper-reader:1", "selected_file", "chrome.tool.selected_pdf_text"],
      ["scholarly-search", "chrome:crossref_works_search:scholarly-search:1", "json_http", "chrome.tool.crossref_works_search"],
    ]);
    // The Citation Resolver: the origin and path the signed declaration names, nothing else.
    expect(registry.bindings[0]!.endpoint).toEqual({ origin: "https://webagents-citation-resolver-production.up.railway.app", path: "/resolve", method: "POST" });
    expect(registry.bindings[2]!.limits).toEqual({ timeout_seconds: 25, max_request_bytes: 4096, max_response_bytes: 524288, max_concurrent: 1, min_interval_ms: 1000 });
    expect(registry.bindings[1]!.limits).toEqual({ timeout_seconds: 20, max_request_bytes: 1024, max_response_bytes: 524288, max_concurrent: 2, min_interval_ms: null });
    const evaluation = await evaluateRegistry(pkg, registry, { decisions: { ...ALL_SESSION }, toolApprovals: APPROVED, now: NOW });
    expect(Object.fromEntries(evaluation.tools.map((tool) => [tool.tool_id, tool.status]))).toEqual({ "citation-resolver": BOUND, "paper-reader": BOUND, "scholarly-search": BOUND });
    expect(evaluation.all_tools_usable).toBe(true);
    const records = normalizeToolBindings(planToolBindings(evaluation));
    // Each frozen binding names a definition this host holds, with the digest it computes now.
    const { handlers } = toolHandlers(records, { definitions: definitionsFromRegistry(registry) });
    expect(Object.keys(handlers).sort()).toEqual(["citation.resolve", "paper.read", "scholarly.search"]);
  });

  it("pins contract digests equal to the package's own declared schemas", async () => {
    const pkg = await literatureReview();
    for (const item of [...SERVICE_IMPLEMENTATIONS, ...LOCAL_IMPLEMENTATIONS]) {
      const tool = Object.values(pkg.tools).find((candidate) => candidate.binding === item.binding)!;
      expect([item.input_schema_sha256, item.output_schema_sha256], item.binding).toEqual([schemaDigest(pkg, String(tool.input_schema)), schemaDigest(pkg, String(tool.output_schema))]);
    }
  });

  it("a package whose scholarly.search schema differs is incompatible, not served a shape it did not declare", async () => {
    const pkg = await literatureReview();
    const changed = new Map(pkg.files);
    const path = String(pkg.tools["scholarly-search"]!.output_schema);
    const schema = JSON.parse(new TextDecoder().decode(changed.get(path)!)) as JsonObject;
    changed.set(path, new TextEncoder().encode(JSON.stringify({ ...schema, title: "changed" })));
    const altered = { ...pkg, files: changed };
    const registry = await buildHostToolRegistry(altered, { resourceTypes: [], runtimeVersion: null, now: NOW });
    const evaluation = await evaluateRegistry(altered, registry, { now: NOW });
    const search = evaluation.tools.find((tool) => tool.tool_id === "scholarly-search")!;
    expect(search.status).toBe(INCOMPATIBLE);
    expect(search.binding?.violated).toEqual(["output_schema"]);
  });

  it("a GET to an endpoint no service adapter serves stays unbound: the generic adapter would drop its arguments", async () => {
    const pkg = await literatureReview();
    const moved = { ...pkg, tools: { ...pkg.tools, "scholarly-search": { ...pkg.tools["scholarly-search"]!, endpoint: "https://api.crossref.org/members" } } };
    const registry = await buildHostToolRegistry(moved, { resourceTypes: [], runtimeVersion: null, now: NOW });
    expect(registry.bindings.map((binding) => binding.tool_id)).toEqual(["citation-resolver", "paper-reader"]);
    expect(registry.notes).toEqual([{ code: "tool_method_unsupported", detail: expect.stringContaining("scholarly-search: the generic HTTPS JSON adapter sends one POST body") }]);
    const evaluation = await evaluateRegistry(moved, registry, { now: NOW });
    expect(evaluation.tools.find((tool) => tool.tool_id === "scholarly-search")!.status).toBe(UNBOUND);
  });

  it("whether a contact address is set is part of the binding digest; its value never is", async () => {
    const pkg = await literatureReview();
    const without = await buildHostToolRegistry(pkg, { resourceTypes: [], runtimeVersion: null, now: NOW });
    const withContact = await buildHostToolRegistry(pkg, { resourceTypes: [], runtimeVersion: null, now: NOW, contactConfigured: true });
    const search = (registry: typeof without) => registry.bindings.find((binding) => binding.tool_id === "scholarly-search")!;
    expect(search(without).credentials).toEqual({ required: false, configured: false, source: CROSSREF_CONTACT_SOURCE });
    expect(search(withContact).credentials).toEqual({ required: false, configured: true, source: CROSSREF_CONTACT_SOURCE });
    expect(search(withContact).binding_sha256).not.toBe(search(without).binding_sha256);
    expect(search(withContact).available).toBe(true);
    // The definitions describe back to the same digests when the host reports the same setting.
    for (const [registry, configured] of [[without, false], [withContact, true]] as const) {
      const definition = definitionsFromRegistry(registry).find((item) => item.toolId === "scholarly-search")!;
      expect(definition.optionalCredential).toEqual({ kind: "settings", name: "crossref.contact" });
      expect(definition.credential).toBeUndefined();
      expect(bindingDigest(describeDefinition(definition, { credentialConfigured: () => configured }))).toBe(search(registry).binding_sha256);
    }
    expect(JSON.stringify(withContact)).not.toContain("@");
  });
});

describe("the Crossref binding's pacing holds through the broker", () => {
  it("one call at a time, starts at least one second apart, whatever the graph's parallelism", async () => {
    const pkg = await literatureReview();
    const registry = await buildHostToolRegistry(pkg, { resourceTypes: [], runtimeVersion: null, now: NOW });
    const evaluation = await evaluateRegistry(pkg, registry, { decisions: { ...ALL_SESSION }, toolApprovals: APPROVED, now: NOW });
    const starts: number[] = [];
    let active = 0;
    let peak = 0;
    const body = JSON.stringify({ status: "ok", message: { items: [{ DOI: "10.1/a", title: ["A"] }] } });
    const transport: HttpTransport = async () => {
      starts.push(Date.now());
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 50));
      active -= 1;
      return { status: 200, headers: { "content-type": "application/json" }, body };
    };
    const { handlers } = toolHandlers(normalizeToolBindings(planToolBindings(evaluation)), { definitions: definitionsFromRegistry(registry), transport, pacer: new Pacer() });
    const context = { role: "SearchWorker", worker_id: "SearchWorker:1", event: () => undefined };
    const signal = new AbortController().signal;
    const results = await Promise.all([0, 1, 2].map((index) => handlers["scholarly.search"]!(context, { query: `topic ${index}`, limit: 1 } as JsonValue, signal)));
    expect(results).toHaveLength(3);
    expect(peak).toBe(1);
    expect(starts[1]! - starts[0]!).toBeGreaterThanOrEqual(990);
    expect(starts[2]! - starts[1]!).toBeGreaterThanOrEqual(990);
  });
});
