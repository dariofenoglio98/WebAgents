/**
 * The host-resource store and the broker's half of it, without a package.
 *
 * Nothing here is WebAir's: the resource types are a person's work hours and a
 * library card, so what is under test is the generic mechanism — what an
 * operator may configure, what leaves this process (never a value), what a
 * digest commits to, what a grant can resolve to, and which tool calls a
 * sealed value may travel in.
 */
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  HOST_RESOURCE_INPUT_SCHEMA,
  HostResourceStore,
  canonicalJson,
  sha256Hex,
  type ResourceGrant,
} from "../src/host-resources.js";
import { ToolBroker, type BoundTool, type HttpTransport } from "../src/tool-broker.js";
import { BUILT_IN_BINDINGS, describeBinding, type ToolBindingDefinition } from "../src/tool-registry.js";

const log = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
const KEY = Buffer.alloc(32, 1);

const HOURS_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  properties: { start: { type: "string" }, end: { type: "string" } },
  required: ["start", "end"],
  additionalProperties: false,
};
const CARD_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  properties: { card_number: { type: "string" }, holder: { type: "string" } },
  required: ["card_number", "holder"],
  additionalProperties: false,
};

function definitions(overrides: Record<string, unknown> = {}) {
  return {
    schema: "openclaw-host-resources-v0",
    types: [
      {
        id: "personal.work_hours",
        display_name: "Work hours",
        permission_kind: "personal.read",
        schema: HOURS_SCHEMA,
        sealed_fields: [],
      },
      {
        id: "personal.library_card",
        display_name: "Library card",
        permission_kind: "personal.read",
        schema: CARD_SCHEMA,
        sealed_fields: ["/card_number"],
      },
    ],
    resources: [
      { id: "hours_a", type: "personal.work_hours", label: "Weekdays 9–5", value: { start: "09:00", end: "17:00" } },
      { id: "card_main", type: "personal.library_card", label: "Main library ••12", value: { card_number: "LIB-000112", holder: "Robin Reader" } },
      { id: "card_branch", type: "personal.library_card", label: "Branch library ••34", value: { card_number: "LIB-000934", holder: "Robin Reader" } },
    ],
    ...overrides,
  };
}

function grant(store: HostResourceStore, resourceId: string, permissionId = "library.card"): ResourceGrant {
  const view = store.describe(resourceId)!;
  return { permission_id: permissionId, resource_type: view.type, resource_id: view.id, resource_digest: view.digest };
}

describe("the host resource store", () => {
  it("projects ids, labels and keyed digests, never a value", () => {
    const store = new HostResourceStore(definitions(), { key: KEY });
    const registry = store.registry({ runtimeVersion: "2026.9.5" });
    expect(registry.resources.map((item) => item.id)).toEqual(["hours_a", "card_main", "card_branch"]);
    expect(registry.types.map((item) => item.schema_sha256)).toEqual([
      sha256Hex(canonicalJson(HOURS_SCHEMA)),
      sha256Hex(canonicalJson(CARD_SCHEMA)),
    ]);
    const text = JSON.stringify(registry);
    for (const value of ["09:00", "LIB-000112", "LIB-000934", "Robin Reader"]) {
      expect(text).not.toContain(value);
    }
  });

  it("commits a digest to the value under its own key, and to nothing presentational", () => {
    const store = new HostResourceStore(definitions(), { key: KEY });
    const digest = store.describe("card_main")!.digest;
    expect(digest).toMatch(/^[0-9a-f]{64}$/u);
    // Not a bare hash of the record: without the key it cannot be checked against a guess.
    const bare = createHash("sha256").update(canonicalJson({ card_number: "LIB-000112", holder: "Robin Reader" })).digest("hex");
    expect(digest).not.toBe(bare);
    expect(new HostResourceStore(definitions(), { key: Buffer.alloc(32, 2) }).describe("card_main")!.digest).not.toBe(digest);
    const relabelled = definitions();
    relabelled.resources[1]!.label = "Renamed ••12";
    expect(new HostResourceStore(relabelled, { key: KEY }).describe("card_main")!.digest).toBe(digest);
    const changed = definitions();
    (changed.resources[1]!.value as Record<string, string>).holder = "R. Reader";
    expect(new HostResourceStore(changed, { key: KEY }).describe("card_main")!.digest).not.toBe(digest);
  });

  it("offers one argument-free host_resource implementation per type", () => {
    const store = new HostResourceStore(definitions(), { key: KEY });
    const bindings = store.bindings();
    expect(bindings.map((item) => [item.toolId, item.binding, item.kind, item.resourceType])).toEqual([
      ["personal.work_hours", "host.resource.personal.work_hours", "host_resource", "personal.work_hours"],
      ["personal.library_card", "host.resource.personal.library_card", "host_resource", "personal.library_card"],
    ]);
    expect(bindings[0]!.inputSchemaSha256).toBe(sha256Hex(canonicalJson(HOST_RESOURCE_INPUT_SCHEMA)));
    expect(bindings[1]!.outputSchemaSha256).toBe(sha256Hex(canonicalJson(CARD_SCHEMA)));
    const descriptor = describeBinding(bindings[1]!);
    expect(descriptor.remote).toBe(false);
    expect(descriptor.endpoint).toBeNull();
    expect(descriptor.resource_type).toBe("personal.library_card");
    // Every other category's descriptor keeps its exact earlier shape.
    expect("resource_type" in describeBinding(BUILT_IN_BINDINGS[0]!)).toBe(false);
  });

  it("resolves exactly the granted resource, and refuses one that moved", () => {
    const store = new HostResourceStore(definitions(), { key: KEY });
    const card = grant(store, "card_main");
    const value = store.resolve(card);
    expect(value).toEqual({ card_number: "LIB-000112", holder: "Robin Reader" });
    (value as Record<string, string>).card_number = "tampered";
    expect(store.resolve(card).card_number).toBe("LIB-000112");
    expect(() => store.resolve({ ...card, resource_id: "card_branch" })).toThrow(/no longer/u);
    expect(() => store.resolve({ ...card, resource_type: "personal.work_hours" })).toThrow();
    const changed = definitions();
    (changed.resources[1]!.value as Record<string, string>).card_number = "LIB-999999";
    store.load(changed);
    expect(() => store.resolve(card)).toThrow();
    store.load({ ...definitions(), resources: definitions().resources.filter((r) => r.id !== "card_main") });
    expect(() => store.resolve(card)).toThrow();
  });

  it("refuses definitions that could leak, smuggle or collide, all or nothing", () => {
    const store = new HostResourceStore(definitions(), { key: KEY });
    const bad: Array<[string, (d: any) => void]> = [
      ["unknown field", (d) => (d.resources[0].secret = "x")],
      ["duplicate id", (d) => d.resources.push({ ...d.resources[0] })],
      ["unknown type", (d) => (d.resources[0].type = "personal.unknown")],
      ["non-resource kind", (d) => (d.types[0].permission_kind = "network")],
      ["label shows a sealed value", (d) => (d.resources[1].label = "Card LIB-000112")],
      ["missing sealed field", (d) => (d.resources[1].value = { holder: "Robin Reader" })],
      ["sealed value too short", (d) => (d.resources[1].value.card_number = "12")],
      ["bad identifier", (d) => (d.resources[0].id = "../etc")],
      ["control characters", (d) => (d.resources[0].label = "line\nbreak")],
      ["wrong schema", (d) => (d.schema = "something-else")],
    ];
    for (const [name, mutate] of bad) {
      const document = structuredClone(definitions());
      mutate(document);
      expect(() => store.load(document), name).toThrow();
    }
    // A refused document changed nothing.
    expect(store.describe("card_main")).toBeDefined();
    expect(store.size).toBe(3);
  });

  it("withholds every sealed value it was not granted, wherever it appears", () => {
    const store = new HostResourceStore(definitions(), { key: KEY });
    const card = grant(store, "card_main");
    // Ungranted: refused anywhere, in any case, nested or as a key.
    for (const args of [
      { card: "LIB-000934" },
      { note: "please use lib-000934 today" },
      { nested: [{ deep: { card: "LIB-000934" } }] },
      { "LIB-000934": true },
    ]) {
      expect(store.egressRefusal(args, [card], ["library.card"])).toMatch(/not granted/u);
    }
    // Granted: only to a tool that links the permission it was granted under.
    expect(store.egressRefusal({ card: "LIB-000112" }, [card], ["library.card"])).toBeNull();
    expect(store.egressRefusal({ card: "LIB-000112" }, [card], ["network.search"])).toMatch(/does not link/u);
    // Unsealed values and ordinary text pass.
    expect(store.egressRefusal({ start: "09:00", holder: "Robin Reader" }, [], [])).toBeNull();
    expect(new HostResourceStore(undefined, { key: KEY }).egressRefusal({ card: "LIB-000934" }, [], [])).toBeNull();
  });
});

describe("the broker's host_resource and egress checks", () => {
  const store = new HostResourceStore(definitions(), { key: KEY });
  const [, cardBinding] = store.bindings() as [ToolBindingDefinition, ToolBindingDefinition];
  const search: ToolBindingDefinition = {
    ...BUILT_IN_BINDINGS.find((item) => item.toolId === "citation-resolver")!,
    id: "test:search:1",
    toolId: "search",
  };
  const bound = (definition: ToolBindingDefinition, permissionIds: string[]): BoundTool => ({
    toolId: definition.toolId,
    bindingId: definition.id,
    bindingSha256: "a".repeat(64),
    remote: definition.kind === "json_http",
    timeoutSeconds: definition.timeoutSeconds,
    permissionIds,
  });
  const seen: unknown[] = [];
  const transport: HttpTransport = async (options) => {
    seen.push(options.body);
    return { status: 200, contentType: "application/json", body: "{}" };
  };
  function broker(grants: ResourceGrant[], cardPermissions = ["library.card"], searchPermissions = ["network.search"]) {
    return new ToolBroker({
      bound: [bound(cardBinding, cardPermissions), bound(search, searchPermissions)],
      definitions: [cardBinding, search],
      logger: log,
      transport,
      resolver: async () => ["93.184.216.34"],
      resources: { grants, store },
    });
  }
  const call = (b: ToolBroker, definition: ToolBindingDefinition, args: unknown) =>
    b.call(
      { tool_id: definition.toolId, binding_id: definition.id, binding_sha256: "a".repeat(64), args },
      new AbortController().signal,
    );

  it("returns the one granted resource, and says which it was", async () => {
    const granted = grant(store, "card_main");
    const result = await call(broker([granted]), cardBinding, {});
    expect(result.output).toEqual({ card_number: "LIB-000112", holder: "Robin Reader" });
    expect(result.resource).toEqual(granted);
    expect(result.remote).toBe(false);
  });

  it("accepts no argument that could name another resource", async () => {
    const b = broker([grant(store, "card_main")]);
    for (const args of [{ resource_id: "card_branch" }, { id: "card_branch" }, "card_branch", null, []]) {
      await expect(call(b, cardBinding, args)).rejects.toMatchObject({
        detail: expect.stringMatching(/^tool_request_invalid: a host resource read takes no arguments/u),
      });
    }
  });

  it("finds a grant only by type and a permission the calling tool links", async () => {
    await expect(call(broker([]), cardBinding, {})).rejects.toMatchObject({
      detail: expect.stringMatching(/^tool_request_invalid: this run was granted no host resource/u),
    });
    await expect(call(broker([grant(store, "card_main", "other.permission")]), cardBinding, {})).rejects.toMatchObject({
      detail: expect.stringMatching(/^tool_request_invalid/u),
    });
  });

  it("refuses a granted resource whose value changed after the grant", async () => {
    const granted = grant(store, "card_main");
    const changed = structuredClone(definitions());
    (changed.resources[1]!.value as Record<string, string>).holder = "Somebody Else";
    store.load(changed);
    try {
      await expect(call(broker([granted]), cardBinding, {})).rejects.toMatchObject({
        detail: expect.stringMatching(/^tool_unavailable: the granted host resource is no longer/u),
      });
    } finally {
      store.load(definitions());
    }
  });

  it("stops a sealed value before the transport unless its grant says it may go there", async () => {
    seen.length = 0;
    const granted = grant(store, "card_main");
    await expect(call(broker([granted]), search, { query: "LIB-000934" })).rejects.toMatchObject({
      detail: expect.stringMatching(/^tool_request_invalid: .*not granted/u),
    });
    await expect(call(broker([granted]), search, { query: "LIB-000112" })).rejects.toMatchObject({
      detail: expect.stringMatching(/^tool_request_invalid: .*does not link/u),
    });
    expect(seen).toEqual([]);
    await call(broker([granted], ["library.card"], ["network.search", "library.card"]), search, { query: "LIB-000112" });
    expect(seen).toHaveLength(1);
  });

  it("checks nothing when this host holds no resources", async () => {
    seen.length = 0;
    const plain = new ToolBroker({
      bound: [bound(search, ["network.search"])],
      definitions: [search],
      logger: log,
      transport,
      resolver: async () => ["93.184.216.34"],
    });
    await call(plain, search, { query: "LIB-000934" });
    expect(seen).toHaveLength(1);
    await expect(
      new ToolBroker({ bound: [bound(cardBinding, ["library.card"])], definitions: [cardBinding], logger: log }).call(
        { tool_id: cardBinding.toolId, binding_id: cardBinding.id, binding_sha256: "a".repeat(64), args: {} },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ detail: expect.stringMatching(/^tool_unavailable/u) });
  });
});
