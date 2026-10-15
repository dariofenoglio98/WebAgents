/**
 * A minimal signed `workflow.v0` package that declares everything memory.v0 lets a package
 * declare (§7): a `memory.read` of `travel.profile` through `host.memory.travel.profile`, the
 * `personal.read` alias of `wallet.payment_method` through `host.resource.*`, a `memory.write`
 * with the `proposals.json` export, optionally the agent document with its two reserved tools,
 * and one free-text local echo tool to carry values out. Not a shipped artifact: it exists so
 * the memory boundary can be proved without a service, a network or a model.
 */
import { canonicalJson } from "../../src/core/canonical.js";
import { sha256HexSync } from "../../src/core/hash.js";
import type { JsonObject, JsonValue } from "../../src/core/json.js";
import { recordViewSchema, TypeRegistry } from "../../src/core/memory/types.js";
import { loadPackageBytes, type Package } from "../../src/core/package.js";
import { MEMORY_CONTRACTS } from "../../src/core/schemas/memory/index.js";
import { generateKeyPair, signedArchive, type TestKeyPair } from "./keys.js";

export const MEMORY_PACKAGE_ID = "org.example.memory";
export const PROFILE_TOOL = "travel.profile";
export const WALLET_TOOL = "wallet.payment_method";
export const ECHO_TOOL = "test.echo";
export const ECHO_BINDING = "test.echo.builtin";
export const AGENT_READ_TOOL = "agent-notes.read";
export const AGENT_WRITE_TOOL = "agent-notes.write";
export const READ_PERMISSION = "memory.travel_profile";
export const WALLET_PERMISSION = "wallet.payment";
export const WRITE_PERMISSION = "memory.remember";
export const AGENT_PERMISSION = "memory.agent";

export interface MemoryPackageOptions {
  /** Declare `memory.scope: agent-scoped` with the two reserved tools. */
  agent?: boolean;
  /** Declare `memory.write` (default true) and, unless `proposalsExport` is false, its export. */
  write?: boolean;
  proposalsExport?: boolean;
  proposalsPath?: string;
  writeTypes?: string[];
  readType?: string;
  minimumVersion?: string;
  agentWriteCap?: number;
  /** Replace the agent write tool's input schema (a mismatch test). */
  agentWriteInputSchema?: JsonObject;
  /** Put the agent bindings in a package whose scope is `session`. */
  agentToolsWithoutScope?: boolean;
  /** Drop the agent permission while keeping the scope. */
  agentWithoutPermission?: boolean;
  /** An extra echo of the first kind: declared as a model task node for M-37 tests. */
  modelNode?: boolean;
  /** Fixture answers for the memory read (default: the spec's home travel profile). */
  profileAnswer?: JsonObject;
  walletAnswer?: JsonObject;
  proposalsInput?: JsonValue;
  notesInput?: string;
  /** Extra permissions the free-text echo tool links (a tool that may carry a granted value out). */
  echoLinks?: string[];
  /** Custom types the policy declares under `memory_types` (M-18), each with its closed schema written as a package file. */
  customTypes?: Array<{ id: string; display_name: string; description: string | null; schema: JsonObject; identity?: string[] }>;
}

const EMPTY_INPUT = MEMORY_CONTRACTS["memory-empty-input.schema"] as JsonObject;
const FREE_TEXT: JsonObject = { $schema: "https://json-schema.org/draft/2020-12/schema", type: "object", additionalProperties: false, required: ["value"], properties: { value: { type: "string", maxLength: 4000 } } };

export const PROFILE_ANSWER: JsonObject = {
  id: "mem_7c1f0a4e9b2d4c5e8f6a1b2c3d4e5f60",
  type: "travel.profile",
  title: "Home travel profile",
  fields: { home_airport: "BOS", preferred_cabin: "economy", prefer_nonstop: true, preferred_currency: "USD" },
  body: "Used for most trips. Business only when someone else pays.",
  tags: ["home"],
  sealed: [],
};
export const WALLET_ANSWER: JsonObject = { payment_method_id: "demo-visa-4242", display: "Demo Visa •••• 4242" };
export const VALID_PROPOSALS: JsonObject = {
  schema: "memory.v0 proposals",
  proposals: [
    { action: "create", type: "travel.preference", title: "Aisle seat", fields: { kind: "seat", value: "aisle" }, body: "Chosen on the Boston booking.", tags: ["seat"], links: [{ to: "self", rel: "about" }], rationale: "You chose an aisle seat." },
  ],
};

export function memorySource(options: MemoryPackageOptions = {}): Map<string, Uint8Array> {
  const write = options.write ?? true;
  const proposalsExport = options.proposalsExport ?? write;
  const agent = options.agent ?? false;
  const readType = options.readType ?? "travel.profile";
  const encoder = new TextEncoder();
  const files = new Map<string, Uint8Array>();
  const put = (path: string, value: JsonValue | string) => files.set(path, encoder.encode(typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`));
  const registry = new TypeRegistry();
  const profileType = registry.get(readType) ?? registry.get("travel.profile")!;
  const wallet = registry.legacyOf("wallet.payment_method")!;
  put("skills/memory.SKILL.md", "# Memory\n\nRead the profile, echo the value, propose what the input says.\n");
  put("schemas/host/empty-input.schema.json", EMPTY_INPUT);
  put("schemas/host/travel.profile.view.schema.json", recordViewSchema(profileType));
  put("schemas/host/wallet.payment_method.schema.json", wallet.alias.schema);
  put("schemas/echo.schema.json", FREE_TEXT);
  put("schemas/input.schema.json", { $schema: "https://json-schema.org/draft/2020-12/schema", type: "object", additionalProperties: false, required: ["value"], properties: { value: { type: "string", maxLength: 4000 }, proposals: { type: "object" }, notes: { type: "string", maxLength: 40000 } } });
  put("schemas/output.schema.json", { $schema: "https://json-schema.org/draft/2020-12/schema", type: "object", additionalProperties: false, required: ["value"], properties: { value: { type: "string" }, memory_proposals: { type: "object" }, profile: { type: ["object", "null"] }, notes: { type: ["object", "null"] } } });
  put("schemas/state.schema.json", { $schema: "https://json-schema.org/draft/2020-12/schema", type: "object", additionalProperties: false, required: ["request"], properties: { request: { type: "object" }, profile: { type: ["object", "null"] }, wallet: { type: ["object", "null"] }, answer: { type: ["object", "null"] }, notes: { type: ["object", "null"] }, staged: { type: ["object", "null"] }, summary: { type: ["object", "null"] } } });
  if (agent || options.agentToolsWithoutScope) {
    put("schemas/host/agent-notes.read.output.schema.json", MEMORY_CONTRACTS["memory-agent-read.output.schema"] as JsonObject);
    put("schemas/host/agent-notes.write.input.schema.json", options.agentWriteInputSchema ?? (MEMORY_CONTRACTS["memory-agent-write.input.schema"] as JsonObject));
    put("schemas/host/agent-notes.write.output.schema.json", MEMORY_CONTRACTS["memory-agent-write.output.schema"] as JsonObject);
  }
  const permissions: JsonObject[] = [
    { id: "files.echo", kind: "files.read", description: "Use the host echo implementation.", required: true, resources: ["host-echo"] },
    { id: "memory.session", kind: "memory", description: "Session state only.", required: true, resources: ["session"] },
    { id: "model.any", kind: "model", description: "The host router.", required: false, resources: ["host-router"] },
    { id: READ_PERMISSION, kind: "memory.read", description: "Read the travel profile you choose.", required: false, resources: [readType] },
    { id: WALLET_PERMISSION, kind: "personal.read", description: "Read the payment method you choose.", required: false, resources: ["wallet.payment_method"] },
  ];
  if (write) permissions.push({ id: WRITE_PERMISSION, kind: "memory.write", description: "Propose things to remember.", required: false, resources: options.writeTypes ?? ["travel.preference", "travel.profile"] });
  const customTypes = options.customTypes ?? [];
  for (const custom of customTypes) put(`schemas/types/${custom.id}.schema.json`, custom.schema);
  if ((agent && !options.agentWithoutPermission) || (options.agentToolsWithoutScope && !options.agentWithoutPermission)) permissions.push({ id: AGENT_PERMISSION, kind: "memory", description: "Keep its own notes between runs.", required: false, resources: ["agent"] });
  const tool = (id: string, binding: string, input: string, output: string, linked: string[], sideEffects: "read" | "write" = "read"): JsonObject => ({
    spec_version: "0.1",
    id,
    version: "0.1.0",
    description: `Test tool ${id}.`,
    execution: "local",
    binding,
    endpoint: null,
    method: null,
    input_schema: input,
    output_schema: output,
    permissions: linked,
    domains: [],
    timeout_seconds: 10,
    retries: 0,
    side_effects: sideEffects,
    approval_required: true,
    extensions: {},
  });
  const tools: Array<[string, JsonObject]> = [
    [PROFILE_TOOL, tool(PROFILE_TOOL, `host.memory.${readType}`, "schemas/host/empty-input.schema.json", "schemas/host/travel.profile.view.schema.json", [READ_PERMISSION])],
    [WALLET_TOOL, tool(WALLET_TOOL, "host.resource.wallet.payment_method", "schemas/host/empty-input.schema.json", "schemas/host/wallet.payment_method.schema.json", [WALLET_PERMISSION])],
    [ECHO_TOOL, { ...tool(ECHO_TOOL, ECHO_BINDING, "schemas/echo.schema.json", "schemas/echo.schema.json", ["files.echo", ...(options.echoLinks ?? [])]), approval_required: false }],
  ];
  if (agent || options.agentToolsWithoutScope) {
    const linked = options.agentWithoutPermission ? ["memory.session"] : [AGENT_PERMISSION];
    tools.push([AGENT_READ_TOOL, tool(AGENT_READ_TOOL, "host.memory.agent.read", "schemas/host/empty-input.schema.json", "schemas/host/agent-notes.read.output.schema.json", linked)]);
    tools.push([AGENT_WRITE_TOOL, tool(AGENT_WRITE_TOOL, "host.memory.agent.write", "schemas/host/agent-notes.write.input.schema.json", "schemas/host/agent-notes.write.output.schema.json", linked, "write")]);
  }
  for (const [id, declaration] of tools) put(`tools/${id}.tool.json`, declaration);
  const caps: JsonObject = { [PROFILE_TOOL]: 1, [WALLET_TOOL]: 1, [ECHO_TOOL]: 4 };
  if (agent || options.agentToolsWithoutScope) {
    caps[AGENT_READ_TOOL] = 1;
    caps[AGENT_WRITE_TOOL] = options.agentWriteCap ?? 1;
  }
  put("policy/policy.json", {
    spec_version: "0.1",
    permissions,
    network: { allowed_domains: [], https_only: true, allow_redirects: false },
    memory: agent ? { scope: "agent-scoped", retention: "user-managed", raw_documents: false, state_schema: "schemas/state.schema.json", sharing: "explicit_views" } : { scope: "session", retention: "session", raw_documents: false, state_schema: "schemas/state.schema.json", sharing: "explicit_views" },
    budget: { estimated_tokens: 10, hard_tokens: 1000, max_remote_calls: 4, max_calls_per_tool: caps, max_parallel_workers: 2, estimated_cost_usd: null, approval_threshold_tokens: null },
    delegation: { max_depth: 1, approved_roles: ["Worker"], allow_remote: false },
    extensions: {},
    ...(customTypes.length > 0 ? { memory_types: customTypes.map((custom) => ({ id: custom.id, display_name: custom.display_name, description: custom.description, schema: `schemas/types/${custom.id}.schema.json`, ...(custom.identity ? { identity: custom.identity } : {}) })) } : {}),
  });
  const toolIds = tools.map(([id]) => id);
  const nodes: JsonObject[] = [
    { id: "read_profile", type: "tool", worker: "Worker", tool: PROFILE_TOOL, depends_on: [], input: { literal: {} }, output_schema: "schemas/host/travel.profile.view.schema.json", timeout_seconds: 30, writes: { "/profile": { from: "result", path: "" } } },
    { id: "echo", type: "tool", worker: "Worker", tool: ECHO_TOOL, depends_on: ["read_profile"], input: { object: { value: { from: "state", path: "/request/value" } } }, output_schema: "schemas/echo.schema.json", timeout_seconds: 30, writes: { "/answer": { from: "result", path: "" } } },
  ];
  const outputFields: JsonObject = { value: { from: "state", path: "/answer/value" }, profile: { from: "state", path: "/profile" } };
  if (write) outputFields.memory_proposals = { from: "state", path: "/request/proposals" };
  const last = ["echo"];
  if (agent) {
    nodes.push({ id: "notes_read", type: "tool", worker: "Worker", tool: AGENT_READ_TOOL, depends_on: [], input: { literal: {} }, output_schema: "schemas/host/agent-notes.read.output.schema.json", timeout_seconds: 30, writes: { "/notes": { from: "result", path: "" } } });
    nodes.push({ id: "notes_write", type: "tool", worker: "Worker", tool: AGENT_WRITE_TOOL, depends_on: ["notes_read", "echo"], input: { object: { body: { from: "state", path: "/request/notes" } } }, output_schema: "schemas/host/agent-notes.write.output.schema.json", timeout_seconds: 30, writes: { "/staged": { from: "result", path: "" } } });
    outputFields.notes = { from: "state", path: "/notes" };
    last.push("notes_write");
  }
  nodes.push({ id: "result", type: "output", worker: "Coordinator", depends_on: last, input: { object: outputFields }, output_schema: "schemas/output.schema.json", timeout_seconds: 10, writes: {} });
  const exports: JsonObject[] = [];
  if (proposalsExport) exports.push({ path: options.proposalsPath ?? "proposals.json", format: "memory.proposal", value: { from: "result", path: "/memory_proposals" } });
  const fixtureTools: JsonObject = {
    [PROFILE_TOOL]: [{ input: {}, output: options.profileAnswer ?? PROFILE_ANSWER }],
    [WALLET_TOOL]: [{ input: {}, output: options.walletAnswer ?? WALLET_ANSWER }],
    [ECHO_TOOL]: [{ input: { value: "hello" }, output: { value: "hello" } }],
  };
  const notes = options.notesInput ?? "# Notes\n- first run";
  if (agent) {
    fixtureTools[AGENT_READ_TOOL] = [{ input: {}, output: { body: "", updated: null } }];
    fixtureTools[AGENT_WRITE_TOOL] = [{ input: { body: notes }, output: { staged: true, bytes: new TextEncoder().encode(notes).length } }];
  }
  const fixtureInput: JsonObject = { value: "hello", ...(write ? { proposals: options.proposalsInput ?? VALID_PROPOSALS } : {}), ...(agent ? { notes } : {}) };
  put("fixtures/fixture.json", { profile: "workflow.fixture.v0", input: fixtureInput, models: {}, tools: fixtureTools });
  put("graph.json", {
    spec_version: "0.1",
    profile: "workflow.v0",
    coordinator: "Coordinator",
    workers: [
      { id: "Coordinator", kind: "packaged", skills: [], tools: [], max_instances: 1, budget: { tokens: 1000, remote_calls: 4 }, state_read: ["request", "profile", "answer", "notes", "staged", "summary"], state_write: ["summary"] },
      { id: "Worker", kind: "packaged", skills: ["memory"], tools: toolIds, max_instances: 2, budget: { tokens: 1000, remote_calls: 4 }, state_read: ["request", "profile", "notes"], state_write: ["profile", "wallet", "answer", "notes", "staged"] },
    ],
    input_schema: "schemas/input.schema.json",
    output_schema: "schemas/output.schema.json",
    initial_state: { object: { request: { from: "input", path: "" }, profile: { literal: null }, wallet: { literal: null }, answer: { literal: null }, notes: { literal: null }, staged: { literal: null }, summary: { literal: null } } },
    deadline_seconds: 60,
    nodes,
    exports,
    fixture: "fixtures/fixture.json",
    extensions: {},
  });
  const schemas = [...files.keys()].filter((path) => path.startsWith("schemas/")).map((path) => ({ id: path.slice("schemas/".length).replace(/\.schema\.json$/u, "").replace(/\//gu, "-"), path }));
  put("MANIFEST.agent", {
    spec_version: "0.1",
    package_id: MEMORY_PACKAGE_ID,
    name: "Memory test package",
    version: "0.1.0",
    description: "A package used only to test the memory boundary of the host.",
    publisher: { id: "example", name: "Example" },
    created_at: "2026-10-14T00:00:00Z",
    runtime: { api: "agentpkg-runtime-v0", minimum_version: options.minimumVersion ?? "0.4.0" },
    capabilities: ["memory-test"],
    entrypoint: "workflow.v0",
    graph: "graph.json",
    policy: "policy/policy.json",
    skills: [{ id: "memory", version: "0.1.0", path: "skills/memory.SKILL.md" }],
    tools: toolIds.map((id) => ({ id, path: `tools/${id}.tool.json` })),
    schemas,
    model_requirements: { tasks: [{ id: "summarize", capabilities: ["structured_output"], context_window: 1000, preferred_tier: "any" }], routing: "host", fallback_policy: "deny", extensions: {} },
    evals: [],
    attestations: [],
    dependencies: [],
    update: { channel: "local", locator: null },
    extensions: {},
  });
  return files;
}

export interface MemoryPackage {
  pkg: Package;
  bytes: Uint8Array;
  key: TestKeyPair;
  archiveSha256: string;
}

/** Build and sign the package in memory; `mutate` edits the source files before signing. */
export async function memoryPackage(options: MemoryPackageOptions = {}, mutate?: (files: Map<string, Uint8Array>) => void): Promise<MemoryPackage> {
  const key = await generateKeyPair();
  const files = memorySource(options);
  mutate?.(files);
  const built = new Map<string, Uint8Array>();
  for (const [name, data] of files) built.set(name, name.endsWith(".json") || name === "MANIFEST.agent" ? canonicalJson(JSON.parse(new TextDecoder().decode(data))) : data);
  const bytes = await signedArchive(built, key);
  return { pkg: await loadPackageBytes(bytes), bytes, key, archiveSha256: sha256HexSync(bytes) };
}

/** Edit one JSON file of a source map in place. */
export function editJson(files: Map<string, Uint8Array>, path: string, edit: (value: JsonObject) => void): void {
  const value = JSON.parse(new TextDecoder().decode(files.get(path)!)) as JsonObject;
  edit(value);
  files.set(path, new TextEncoder().encode(JSON.stringify(value)));
}
