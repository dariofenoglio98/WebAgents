/**
 * Host definitions and plan bindings: the descriptor projection and the binding digest equal
 * what the frozen plugin emits and the Python control plane computes (recorded vectors), an
 * operator bindings document is validated all or nothing, and a plan binding is normalized as
 * `toolbridge/binding.py` normalizes it.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { JsonObject } from "../../../src/core/json.js";
import { describeToolBinding, normalizeToolBinding, normalizeToolBindings } from "../../../src/core/tools/bindings.js";
import { bindingDigest, describeDefinition, parseOperatorBindings, safeOrigin, safePath, type ToolBindingDescriptor, type ToolImplementationDefinition } from "../../../src/core/tools/definitions.js";
import { MemoryResourceStore } from "../../../src/core/tools/resources.js";
import { PROJECT, ROOT } from "../../helpers/paths.js";
import { definitionFor, echoPackage, planBindingFor } from "../../helpers/echo-package.js";

interface Vectors {
  vectors: Array<{ descriptor: ToolBindingDescriptor; binding_sha256: string }>;
}
const VECTORS = JSON.parse(readFileSync(join(PROJECT, "test", "fixtures", "tool-binding-vectors.json"), "utf8")) as Vectors;

/** Rebuild a definition from a plugin descriptor, so `describeDefinition` can be checked against it. */
function definitionOf(descriptor: ToolBindingDescriptor): ToolImplementationDefinition {
  const definition: ToolImplementationDefinition = {
    id: descriptor.id,
    toolId: descriptor.tool_id,
    binding: descriptor.binding,
    kind: descriptor.implementation_kind,
    implementationId: descriptor.implementation_id,
    implementationVersion: descriptor.implementation_version,
    displayName: descriptor.display_name,
    inputSchemaSha256: descriptor.contract.input_schema_sha256,
    outputSchemaSha256: descriptor.contract.output_schema_sha256,
    permissionKinds: descriptor.contract.permission_kinds,
    sideEffects: descriptor.contract.side_effects,
    timeoutSeconds: descriptor.limits.timeout_seconds,
    maxRequestBytes: descriptor.limits.max_request_bytes,
    maxResponseBytes: descriptor.limits.max_response_bytes,
    maxConcurrent: descriptor.limits.max_concurrent,
  };
  if (descriptor.description) definition.description = descriptor.description;
  if (descriptor.limits.min_interval_ms) definition.minIntervalMs = descriptor.limits.min_interval_ms;
  if (descriptor.endpoint) Object.assign(definition, { origin: descriptor.endpoint.origin, path: descriptor.endpoint.path, method: descriptor.endpoint.method });
  if (descriptor.credentials.source) definition.credential = { kind: "env", name: descriptor.credentials.source.slice(4) };
  if (descriptor.resource_type) definition.resourceType = descriptor.resource_type;
  return definition;
}

describe("binding descriptors and digests match the plugin and the control plane", () => {
  for (const vector of VECTORS.vectors) {
    it(`reproduces ${vector.descriptor.id}`, () => {
      const configured = vector.descriptor.credentials.configured;
      const descriptor = describeDefinition(definitionOf(vector.descriptor), { credentialConfigured: () => configured });
      expect(descriptor).toEqual(vector.descriptor);
      expect(bindingDigest(descriptor)).toBe(vector.binding_sha256);
    });
  }

  it("the digest ignores liveness and presentation and changes with what the binding would do", () => {
    const base = VECTORS.vectors[4]!.descriptor;
    expect(bindingDigest({ ...base, available: false, enabled: false, availability_reason: "down", display_name: "Other", description: "x" })).toBe(bindingDigest(base));
    expect(bindingDigest({ ...base, endpoint: { ...base.endpoint!, path: "/other" } })).not.toBe(bindingDigest(base));
    expect(bindingDigest({ ...base, credentials: { required: true, configured: true, source: "env:X" } })).not.toBe(bindingDigest(base));
    expect(bindingDigest({ ...base, limits: { ...base.limits, min_interval_ms: 1000 } })).not.toBe(bindingDigest(base));
  });
});

describe("the operator bindings document", () => {
  const document = JSON.parse(readFileSync(join(ROOT, "demo", "webair", "host-bindings.json"), "utf8")) as JsonObject;

  it("parses the WebAir demo file into four json_http definitions", () => {
    const definitions = parseOperatorBindings(document);
    expect(definitions.map((definition) => definition.toolId)).toEqual(["search-flights", "get-fare-rules", "prepare-booking", "simulate-purchase"]);
    expect(definitions.every((definition) => definition.kind === "json_http" && definition.method === "POST" && definition.origin === "https://webagents-webair-production.up.railway.app")).toBe(true);
    expect(definitions[3]!.sideEffects).toBe("write");
    expect(definitions[3]!.permissionKinds).toEqual(["network", "payment", "personal.read"]);
  });

  const edits: Array<[string, (bindings: JsonObject[]) => void, RegExp]> = [
    ["another adapter", (b) => (b[0]!.implementation_id = "openclaw.tool.crossref_works_search"), /implementation_id must be/u],
    ["a GET endpoint", (b) => ((b[0]!.endpoint as JsonObject).method = "GET"), /method must be POST/u],
    ["an http origin", (b) => ((b[0]!.endpoint as JsonObject).origin = "http://webair.example"), /https origin/u],
    ["a path with a query", (b) => ((b[0]!.endpoint as JsonObject).path = "/api?x=1"), /absolute path/u],
    ["a host namespace id", (b) => (b[0]!.id = "chrome:webair.search:1"), /host's own namespace/u],
    ["a host.resource binding name", (b) => (b[0]!.binding = "host.resource.x"), /host\.resource\./u],
    ["a duplicate tool id", (b) => (b[1]!.tool_id = b[0]!.tool_id!), /already served/u],
    ["an unknown field", (b) => (b[0]!.headers = { authorization: "x" }), /unknown field/u],
    ["a short digest", (b) => (b[0]!.input_schema_sha256 = "abc"), /64 lowercase hex/u],
  ];
  for (const [label, edit, pattern] of edits) {
    it(`refuses the whole document for ${label}`, () => {
      const copy = JSON.parse(JSON.stringify(document)) as JsonObject;
      edit(copy.bindings as JsonObject[]);
      expect(() => parseOperatorBindings(copy)).toThrow(pattern);
    });
  }

  it("refuses an entry that reuses an id, tool or binding this host already serves", () => {
    const existing: ToolImplementationDefinition = { ...parseOperatorBindings(document)[0]!, id: "chrome:x:1" };
    expect(() => parseOperatorBindings(document, [existing])).toThrow(/already served/u);
  });

  it("safeOrigin and safePath hold the control plane's rules", () => {
    expect(safeOrigin("https://Example.COM/")).toBe("https://example.com");
    expect(safeOrigin("https://example.com:443")).toBe("https://example.com");
    for (const bad of ["https://example.com/path", "https://u:p@example.com", "https://example.com?x", "http://example.com", "https://example.com:8443", 3, ""]) expect(safeOrigin(bad)).toBeNull();
    expect(safePath("/api/v1/x")).toBe("/api/v1/x");
    for (const bad of ["api", "/a?b", "/a#b", "/a/../b", ""]) expect(safePath(bad)).toBeNull();
  });
});

describe("plan bindings (toolbridge/binding.py)", () => {
  it("normalizes a bound, approved binding and describes it without a credential", async () => {
    const { pkg } = await echoPackage();
    const definition = definitionFor(pkg, "test.echo");
    const binding = planBindingFor(pkg, definition);
    const normalized = normalizeToolBinding(binding);
    expect(normalized.tool_id).toBe("test.echo");
    expect(normalized.remote).toBe(false);
    expect(normalized.usable).toBe(true);
    expect(describeToolBinding(normalized).note).toMatch(/never cross/u);
    expect(normalizeToolBindings([binding])).toHaveLength(1);
    expect(normalizeToolBindings(null)).toEqual([]);
  });

  it("refuses an unapproved binding, two bindings for one tool, and unknown or malformed fields", async () => {
    const { pkg } = await echoPackage();
    const binding = planBindingFor(pkg, definitionFor(pkg, "test.echo"));
    expect(() => normalizeToolBinding({ ...binding, approved: false })).toThrow(/not approved/u);
    expect(() => normalizeToolBindings([binding, { ...binding, binding_id: "host:other:1" }])).toThrow(/exactly one binding/u);
    expect(() => normalizeToolBindings([binding, { ...binding, tool_id: "other" }])).toThrow(/share one binding id/u);
    expect(() => normalizeToolBinding({ ...binding, url: "https://evil" })).toThrow(/Unknown fields/u);
    expect(() => normalizeToolBinding({ ...binding, binding_sha256: "nope" })).toThrow(/64 lowercase hex/u);
    expect(() => normalizeToolBinding({ ...binding, timeout_seconds: 1000 })).toThrow(/exceeds 120/u);
    expect(() => normalizeToolBinding({ ...binding, remote: "yes" })).toThrow(/true or false/u);
  });
});

describe("the host resource store emits host_resource definitions with the pinned input schema", () => {
  it("one binding per type, digests equal to the plugin's for the same definition facts", async () => {
    const document = JSON.parse(readFileSync(join(ROOT, "demo", "webair", "host-resources.json"), "utf8")) as JsonObject;
    const store = await MemoryResourceStore.load(document, { key: new Uint8Array(32).fill(7) });
    const bindings = store.bindings();
    expect(bindings.map((binding) => binding.toolId)).toEqual(["personal.travel_profile", "personal.passenger_identity", "wallet.payment_method"]);
    // The plugin's host-resource descriptors differ from ours only by host namespace and
    // implementation id; with those equalized the digest is the same function of the same facts.
    const reference = VECTORS.vectors.find((vector) => vector.descriptor.id === "openclaw:host-resource:wallet.payment_method:1")!;
    const ours = describeDefinition({ ...bindings[2]!, id: reference.descriptor.id, implementationId: reference.descriptor.implementation_id, displayName: reference.descriptor.display_name, description: reference.descriptor.description! });
    expect(bindingDigest(ours)).toBe(reference.binding_sha256);
  });
});
