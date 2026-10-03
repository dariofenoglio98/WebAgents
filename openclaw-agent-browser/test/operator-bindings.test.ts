/**
 * Operator entries of the service-neutral JSON adapter, without a package.
 *
 * Nothing here is any demo's: the service is a made-up tide-table API, so what
 * is under test is the generic mechanism — what an operator's bindings file may
 * add (one exact HTTPS POST endpoint of `openclaw.tool.json_http`, with the
 * contract the operator states), what it may never add or replace, how it is
 * read, and that the broker serves such an entry under exactly the policy it
 * applies to every other `json_http` binding.
 */
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentBrowserBackend } from "../src/backend.js";
import { AgentBrowserError } from "../src/errors.js";
import { HostResourceStore } from "../src/host-resources.js";
import { ToolBroker, type BoundTool, type HttpTransport } from "../src/tool-broker.js";
import {
  BUILT_IN_BINDINGS,
  MAX_OPERATOR_BINDINGS,
  MAX_OPERATOR_BINDINGS_BYTES,
  OPERATOR_BINDINGS_SCHEMA,
  buildToolRegistry,
  describeBinding,
  parseOperatorBindings,
  readOperatorBindingsFile,
  resolveBindings,
  type ToolBindingDefinition,
  type ToolRegistry,
} from "../src/tool-registry.js";
import { AGENTPKG_BIN } from "./fixtures.js";

const log = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
const IN = "1".repeat(64);
const OUT = "2".repeat(64);

function entry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "ops:tides.lookup:1",
    tool_id: "tide-lookup",
    binding: "tides.lookup",
    implementation_id: "openclaw.tool.json_http",
    display_name: "Tide tables (operator binding)",
    description: "One JSON POST to the tide-table service this operator chose.",
    endpoint: { origin: "https://tides.example", path: "/api/v1/lookup", method: "POST" },
    input_schema_sha256: IN,
    output_schema_sha256: OUT,
    permission_kinds: ["network"],
    side_effects: "read",
    timeout_seconds: 15,
    ...overrides,
  };
}

function document(...entries: Record<string, unknown>[]): Record<string, unknown> {
  return { schema: OPERATOR_BINDINGS_SCHEMA, bindings: entries.length > 0 ? entries : [entry()] };
}

function refusal(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(AgentBrowserError);
    return (error as AgentBrowserError).detail ?? "";
  }
  throw new Error("expected a refusal");
}

const dirs: string[] = [];
async function scratch(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "agent-browser-bindings-"));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

describe("an operator's JSON-adapter entries", () => {
  it("become ordinary json_http entries whose code version is this plugin's", () => {
    const [definition] = parseOperatorBindings(document(entry({ max_concurrent: 2, min_interval_ms: 250 })));
    expect(definition).toEqual({
      id: "ops:tides.lookup:1",
      toolId: "tide-lookup",
      binding: "tides.lookup",
      kind: "json_http",
      implementationId: "openclaw.tool.json_http",
      implementationVersion: "0.1.0",
      displayName: "Tide tables (operator binding)",
      description: "One JSON POST to the tide-table service this operator chose.",
      origin: "https://tides.example",
      path: "/api/v1/lookup",
      method: "POST",
      inputSchemaSha256: IN,
      outputSchemaSha256: OUT,
      permissionKinds: ["network"],
      sideEffects: "read",
      timeoutSeconds: 15,
      maxConcurrent: 2,
      minIntervalMs: 250,
    });
    // The implementation version is the adapter's own, exactly as the code-defined
    // entry that uses the same adapter states it.
    const resolver = BUILT_IN_BINDINGS.find((item) => item.implementationId === "openclaw.tool.json_http")!;
    expect(definition!.implementationVersion).toBe(resolver.implementationVersion);
    const descriptor = describeBinding(definition!, { env: {} });
    expect(descriptor).toMatchObject({
      implementation_kind: "json_http",
      remote: true,
      available: true,
      endpoint: { origin: "https://tides.example", path: "/api/v1/lookup", method: "POST" },
      contract: { input_schema_sha256: IN, output_schema_sha256: OUT, permission_kinds: ["network"], side_effects: "read" },
      credentials: { required: false, configured: false, source: null },
    });
    expect(descriptor.limits).toEqual({
      timeout_seconds: 15,
      max_request_bytes: 16 * 1024,
      max_response_bytes: 512 * 1024,
      max_concurrent: 2,
      min_interval_ms: 250,
    });
  });

  it("join the registry beside the built-ins, with nothing secret in it", () => {
    const definitions = [...BUILT_IN_BINDINGS, ...parseOperatorBindings(document())];
    const registry = buildToolRegistry({ env: {}, definitions });
    expect(registry.bindings.map((item) => item.tool_id).sort()).toEqual([
      "citation-resolver",
      "paper-reader",
      "scholarly-search",
      "test.echo",
      "tide-lookup",
    ]);
    const text = JSON.stringify(registry).toLowerCase();
    for (const forbidden of ["bearer", "authorization", "api_key", "secret", "password"]) {
      expect(text).not.toContain(forbidden);
    }
  });

  it("can name only the plain JSON adapter: no other adapter, no local implementation", () => {
    for (const implementation of [
      "openclaw.tool.crossref_works_search",
      "openclaw.tool.echo",
      "openclaw.tool.selected_pdf_text",
      "openclaw.tool.host_resource",
      "openclaw.tool.shell",
      undefined,
    ]) {
      const detail = refusal(() => parseOperatorBindings(document(entry({ implementation_id: implementation }))));
      expect(detail).toMatch(/implementation_id/u);
    }
    // There is no field through which a category, a request template, a header,
    // a query or a credential value could be stated.
    for (const field of ["kind", "implementation_kind", "headers", "query", "template", "credential", "token"]) {
      expect(refusal(() => parseOperatorBindings(document(entry({ [field]: "x" }))))).toContain(
        `unknown field ${field}`,
      );
    }
  });

  it("holds every endpoint to one https origin on 443, one path, and POST", () => {
    for (const origin of [
      "http://tides.example",
      "https://tides.example:8443",
      "https://tides.example/api",
      "https://user:pw@tides.example",
      "https://tides.example?x=1",
      "tides.example",
      "",
    ]) {
      expect(
        refusal(() => parseOperatorBindings(document(entry({ endpoint: { origin, path: "/a", method: "POST" } })))),
      ).toContain("endpoint.origin");
    }
    for (const path of ["relative", "/a/../b", "/a?b=1", "/a#b", ""]) {
      expect(
        refusal(() =>
          parseOperatorBindings(document(entry({ endpoint: { origin: "https://tides.example", path, method: "POST" } }))),
        ),
      ).toContain("endpoint.path");
    }
    for (const method of ["GET", "PUT", "post", undefined]) {
      expect(
        refusal(() =>
          parseOperatorBindings(
            document(entry({ endpoint: { origin: "https://tides.example", path: "/a", method } })),
          ),
        ),
      ).toMatch(/endpoint\.method|missing method/u);
    }
    expect(
      refusal(() =>
        parseOperatorBindings(
          document(entry({ endpoint: { origin: "https://tides.example", path: "/a", method: "POST", port: 8443 } })),
        ),
      ),
    ).toContain("unknown field port");
    // A hostname is normalized, never kept as written.
    const [definition] = parseOperatorBindings(
      document(entry({ endpoint: { origin: "https://Tides.Example/", path: "/a", method: "POST" } })),
    );
    expect(definition!.origin).toBe("https://tides.example");
  });

  it("must state its contract: digests, permission kinds, side effects and a deadline", () => {
    for (const [field, value] of [
      ["input_schema_sha256", "A".repeat(64)],
      ["input_schema_sha256", "1".repeat(63)],
      ["output_schema_sha256", null],
      ["permission_kinds", []],
      ["permission_kinds", ["network", "network"]],
      ["permission_kinds", ["Network!"]],
      ["permission_kinds", "network"],
      ["side_effects", "delete"],
      ["timeout_seconds", 0],
      ["timeout_seconds", 121],
      ["timeout_seconds", 1.5],
      ["max_request_bytes", 64 * 1024 + 1],
      ["max_response_bytes", 512],
      ["max_concurrent", 17],
      ["min_interval_ms", 0],
    ] as const) {
      expect(refusal(() => parseOperatorBindings(document(entry({ [field]: value }))))).toContain(field);
    }
    for (const required of ["input_schema_sha256", "output_schema_sha256", "permission_kinds", "side_effects", "timeout_seconds", "endpoint"]) {
      const partial = entry();
      delete partial[required];
      expect(refusal(() => parseOperatorBindings(document(partial)))).toContain(`missing ${required}`);
    }
  });

  it("adds; it never replaces, shadows or makes a declaration ambiguous", () => {
    // Another binding for a tool this host already serves would make that tool
    // ambiguous; replacing one is what tools.bindings overrides are for.
    expect(refusal(() => parseOperatorBindings(document(entry({ tool_id: "citation-resolver" }))))).toContain(
      "tool_id is already served",
    );
    expect(refusal(() => parseOperatorBindings(document(entry({ binding: "citation.resolve" }))))).toContain(
      "binding is already served",
    );
    expect(refusal(() => parseOperatorBindings(document(entry({ id: "openclaw:tide-lookup:1" }))))).toContain(
      "openclaw: namespace",
    );
    expect(
      refusal(() => parseOperatorBindings(document(entry(), entry({ tool_id: "tide-lookup-2", binding: "tides.two" })))),
    ).toContain("id is already registered");
    expect(refusal(() => parseOperatorBindings(document(entry(), entry({ id: "ops:tides.two:1", binding: "tides.two" }))))).toContain(
      "tool_id is already served",
    );
    // The names of host-held resources stay the host resource store's.
    expect(refusal(() => parseOperatorBindings(document(entry({ binding: "host.resource.personal.calendar" }))))).toContain(
      "host.resource.",
    );
    const store = new HostResourceStore(
      {
        schema: "openclaw-host-resources-v0",
        types: [
          {
            id: "personal.tide_alerts",
            display_name: "Tide alerts",
            permission_kind: "personal.read",
            schema: { type: "object", properties: {}, additionalProperties: false },
          },
        ],
        resources: [],
      },
      { key: Buffer.alloc(32, 3) },
    );
    expect(
      refusal(() =>
        parseOperatorBindings(document(entry({ tool_id: "personal.tide_alerts" })), [
          ...BUILT_IN_BINDINGS,
          ...store.bindings(),
        ]),
      ),
    ).toContain("tool_id is already served");
  });

  it("is refused whole: one bad entry adds nothing", () => {
    const good = entry();
    const bad = entry({ id: "ops:tides.two:1", tool_id: "tide-two", binding: "tides.two", side_effects: "maybe" });
    expect(refusal(() => parseOperatorBindings(document(good, bad)))).toContain("bindings[1].side_effects");
    expect(refusal(() => parseOperatorBindings({ schema: "something-else", bindings: [] }))).toContain("schema");
    expect(refusal(() => parseOperatorBindings({ schema: OPERATOR_BINDINGS_SCHEMA, bindings: [], extra: 1 }))).toContain(
      "unknown field extra",
    );
    expect(refusal(() => parseOperatorBindings([]))).toContain("must be an object");
    const many = Array.from({ length: MAX_OPERATOR_BINDINGS + 1 }, (_, index) =>
      entry({ id: `ops:t${index}:1`, tool_id: `t-${index}`, binding: `t.${index}` }),
    );
    expect(refusal(() => parseOperatorBindings(document(...many)))).toContain(`at most ${MAX_OPERATOR_BINDINGS}`);
    expect(refusal(() => parseOperatorBindings(document(entry({ display_name: "Tides\u0007" }))))).toContain(
      "display_name",
    );
    expect(refusal(() => parseOperatorBindings(document(entry({ id: "no namespace" }))))).toContain("bindings[0].id");
  });

  it("stays subject to the operator's own overrides and to a disabled broker", () => {
    const supplied = [...BUILT_IN_BINDINGS, ...parseOperatorBindings(document())];
    const disabled = resolveBindings({ bindings: [{ toolId: "tide-lookup", enabled: false }] }, supplied);
    expect(disabled.definitions.find((item) => item.toolId === "tide-lookup")!.enabled).toBe(false);
    const credentialed = resolveBindings({ bindings: [{ toolId: "tide-lookup", credentialEnv: "TIDES_TOKEN" }] }, supplied);
    const descriptor = describeBinding(credentialed.definitions.find((item) => item.toolId === "tide-lookup")!, { env: {} });
    expect(descriptor.credentials).toEqual({ required: true, configured: false, source: "env:TIDES_TOKEN" });
    expect(descriptor.available).toBe(false);
    expect(resolveBindings({ enabled: false }, supplied).definitions).toEqual([]);
  });
});

describe("reading an operator's bindings file", () => {
  it("reads one bounded regular file at an absolute path", async () => {
    const dir = await scratch();
    const file = join(dir, "bindings.json");
    await writeFile(file, JSON.stringify(document()));
    expect(await readOperatorBindingsFile(file)).toEqual(document());
    const refuse = async (path: string) => {
      try {
        await readOperatorBindingsFile(path);
      } catch (error) {
        return (error as AgentBrowserError).detail;
      }
      throw new Error("expected a refusal");
    };
    expect(await refuse("bindings.json")).toContain("absolute path");
    expect(await refuse(join(dir, "missing.json"))).toContain("does not exist");
    const link = join(dir, "link.json");
    await symlink(file, link);
    expect(await refuse(link)).toContain("regular file");
    await mkdir(join(dir, "folder"));
    expect(await refuse(join(dir, "folder"))).toContain("regular file");
    const large = join(dir, "large.json");
    await writeFile(large, " ".repeat(MAX_OPERATOR_BINDINGS_BYTES + 1));
    expect(await refuse(large)).toContain("exceeds");
    const broken = join(dir, "broken.json");
    await writeFile(broken, "{");
    expect(await refuse(broken)).toContain("not valid JSON");
  });
});

describe("the backend with an operator's bindings file", () => {
  type ToolHost = { toolHost(): { registry: ToolRegistry; definitions: readonly ToolBindingDefinition[] } };

  async function backendWith(file: string, logged: unknown[][] = []) {
    const stateDir = await scratch();
    const instance = new AgentBrowserBackend({
      config: { agentpkgPath: AGENTPKG_BIN, tools: { bindingsFile: file } },
      logger: { ...log, error: (...args: unknown[]) => logged.push(args) },
      stateDir,
    });
    await instance.initialize();
    return instance as unknown as ToolHost & AgentBrowserBackend;
  }

  it("offers the file's entries in the registry and to the broker", async () => {
    const dir = await scratch();
    const file = join(dir, "bindings.json");
    await writeFile(file, JSON.stringify(document()));
    const instance = await backendWith(file);
    try {
      const { registry, definitions } = instance.toolHost();
      expect(registry.bindings.find((item) => item.tool_id === "tide-lookup")).toMatchObject({
        id: "ops:tides.lookup:1",
        implementation_id: "openclaw.tool.json_http",
        endpoint: { origin: "https://tides.example", path: "/api/v1/lookup", method: "POST" },
      });
      expect(definitions.find((item) => item.id === "ops:tides.lookup:1")).toBeDefined();
      expect(registry.notes).toEqual([]);
    } finally {
      await instance.stop();
    }
  });

  it("adds nothing from a rejected file, logs why and tells the control plane", async () => {
    const dir = await scratch();
    const file = join(dir, "bindings.json");
    await writeFile(file, JSON.stringify(document(entry({ implementation_id: "openclaw.tool.echo" }))));
    const logged: unknown[][] = [];
    const instance = await backendWith(file, logged);
    try {
      const { registry, definitions } = instance.toolHost();
      expect(definitions.map((item) => item.toolId).sort()).toEqual(
        BUILT_IN_BINDINGS.map((item) => item.toolId).sort(),
      );
      expect(registry.notes).toEqual([
        { code: "operator_bindings_rejected", detail: expect.stringContaining("implementation_id") },
      ]);
      expect(logged).toEqual([
        ["agent-browser: operator tool bindings were not loaded", { detail: expect.stringContaining("implementation_id") }],
      ]);
    } finally {
      await instance.stop();
    }
  });
});

describe("the broker serving an operator entry", () => {
  it("sends exactly one JSON POST to the stated origin and path, under the usual policy", async () => {
    const [definition] = parseOperatorBindings(document());
    const seen: Parameters<HttpTransport>[0][] = [];
    const transport: HttpTransport = async (options) => {
      seen.push(options);
      return { status: 200, contentType: "application/json", body: JSON.stringify({ high_tide: "06:12" }) };
    };
    const bound: BoundTool = {
      toolId: definition!.toolId,
      bindingId: definition!.id,
      bindingSha256: "a".repeat(64),
      remote: true,
      timeoutSeconds: 15,
    };
    const tools = new ToolBroker({
      bound: [bound],
      definitions: [...BUILT_IN_BINDINGS, definition!],
      logger: log,
      transport,
      resolver: async () => ["93.184.216.34"],
    });
    const result = await tools.call(
      { tool_id: "tide-lookup", binding_id: bound.bindingId, binding_sha256: bound.bindingSha256, args: { port: "Den Helder" } },
      new AbortController().signal,
    );
    expect(result.output).toEqual({ high_tide: "06:12" });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      hostname: "tides.example",
      address: "93.184.216.34",
      path: "/api/v1/lookup",
      method: "POST",
      body: JSON.stringify({ port: "Den Helder" }),
    });
    // A private destination is refused by class, exactly as for a built-in.
    const privateTools = new ToolBroker({
      bound: [bound],
      definitions: [definition!],
      logger: log,
      transport,
      resolver: async () => ["10.0.0.7"],
    });
    await expect(
      privateTools.call(
        { tool_id: "tide-lookup", binding_id: bound.bindingId, binding_sha256: bound.bindingSha256, args: {} },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: "tool_call_failed" });
    expect(seen).toHaveLength(1);
  });
});
