/**
 * `tool_fakes.py::echo_source`: a minimal signed `workflow.v0` package whose whole point is one
 * declared tool, `test.echo`. It is not a shipped artifact and never will be: it exists so the
 * tool boundary can be proved without a service, a network or a model. `secondRole` adds a
 * second approved worker that also declares the tool, so "which authority is a call attributed
 * to" becomes a real question.
 */
import { canonicalJson } from "../../src/core/canonical.js";
import { sha256HexSync } from "../../src/core/hash.js";
import type { JsonObject, JsonValue } from "../../src/core/json.js";
import { loadPackageBytes, type Package } from "../../src/core/package.js";
import type { ToolBindingRecord } from "../../src/core/tools/bindings.js";
import { bindingDigest, describeDefinition, type ToolImplementationDefinition } from "../../src/core/tools/definitions.js";
import { generateKeyPair, signedArchive, type TestKeyPair } from "./keys.js";

export const ECHO_TOOL = "test.echo";
export const ECHO_BINDING = "test.echo.builtin";
export const ECHO_INPUT: JsonObject = { value: "hello" };

const ECHO_SCHEMA: JsonObject = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  additionalProperties: false,
  required: ["value"],
  properties: { value: { type: "string", maxLength: 200 } },
};

export interface EchoOptions {
  toolId?: string;
  secondRole?: boolean;
  toolTimeout?: number;
  /** Make the tool remote (one JSON POST to this origin) instead of local. */
  remoteOrigin?: string | null;
  /** A free-text argument field, for egress tests that need room for a sealed value. */
  freeText?: boolean;
}

export function echoSource(options: EchoOptions = {}): Map<string, Uint8Array> {
  const toolId = options.toolId ?? ECHO_TOOL;
  const remote = options.remoteOrigin ?? null;
  const input: JsonObject = options.freeText ? { ...ECHO_SCHEMA, properties: { value: { type: "string", maxLength: 2000 } } } : ECHO_SCHEMA;
  const encoder = new TextEncoder();
  const files = new Map<string, Uint8Array>();
  const write = (path: string, value: JsonValue | string) => files.set(path, encoder.encode(typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`));
  write("skills/echo.SKILL.md", "# Echo\n\nReturn the value unchanged.\n");
  write("schemas/echo-input.schema.json", input);
  write("schemas/echo-output.schema.json", ECHO_SCHEMA);
  write("schemas/state.schema.json", { $schema: "https://json-schema.org/draft/2020-12/schema", type: "object", additionalProperties: false, required: ["request", "answer"], properties: { request: input, answer: { type: ["object", "null"] } } });
  const permissions: JsonObject[] = [
    { id: "files.echo", kind: "files.read", description: "Use the host echo implementation.", required: true, resources: ["host-echo"] },
    { id: "memory.session", kind: "memory", description: "Session state only.", required: true, resources: ["session"] },
    { id: "model.any", kind: "model", description: "Not used by this graph; declared so a run plan can bind.", required: false, resources: ["host-router"] },
  ];
  const toolPermissions = ["files.echo"];
  let domains: string[] = [];
  if (remote) {
    const host = new URL(remote).hostname;
    domains = [host];
    permissions.push({ id: "network.echo", kind: "network", description: "The echo service.", required: true, resources: [host] });
    toolPermissions.push("network.echo");
  }
  write(`tools/${toolId}.tool.json`, {
    spec_version: "0.1",
    id: toolId,
    version: "0.1.0",
    description: "A deterministic host-implemented echo, for boundary tests only.",
    execution: remote ? "remote" : "local",
    binding: ECHO_BINDING,
    endpoint: remote ? `${remote}/echo` : null,
    method: remote ? "POST" : null,
    input_schema: "schemas/echo-input.schema.json",
    output_schema: "schemas/echo-output.schema.json",
    permissions: toolPermissions,
    domains,
    timeout_seconds: options.toolTimeout ?? 10,
    retries: 0,
    side_effects: "read",
    approval_required: false,
    extensions: {},
  });
  write("policy/policy.json", {
    spec_version: "0.1",
    permissions,
    network: { allowed_domains: domains, https_only: true, allow_redirects: false },
    memory: { scope: "session", retention: "session", raw_documents: false, state_schema: "schemas/state.schema.json", sharing: "explicit_views" },
    budget: { estimated_tokens: 10, hard_tokens: 1000, max_remote_calls: 4, max_calls_per_tool: { [toolId]: 4 }, max_parallel_workers: 2, estimated_cost_usd: null, approval_threshold_tokens: null },
    delegation: { max_depth: 1, approved_roles: ["EchoWorker", ...(options.secondRole ? ["EchoReviewer"] : [])], allow_remote: false },
    extensions: {},
  });
  const worker = (id: string, write: string[]): JsonObject => ({ id, kind: "packaged", skills: ["echo"], tools: [toolId], max_instances: id === "EchoWorker" ? 2 : 1, budget: { tokens: 1000, remote_calls: 4 }, state_read: ["request"], state_write: write });
  write("graph.json", {
    spec_version: "0.1",
    profile: "workflow.v0",
    coordinator: "EchoCoordinator",
    workers: [
      { id: "EchoCoordinator", kind: "packaged", skills: [], tools: [], max_instances: 1, budget: { tokens: 1000, remote_calls: 4 }, state_read: ["request", "answer"], state_write: ["answer"] },
      worker("EchoWorker", ["answer"]),
      ...(options.secondRole ? [worker("EchoReviewer", [])] : []),
    ],
    input_schema: "schemas/echo-input.schema.json",
    output_schema: "schemas/echo-output.schema.json",
    initial_state: { object: { request: { from: "input", path: "" }, answer: { literal: null } } },
    deadline_seconds: 60,
    nodes: [
      { id: "echo", type: "tool", worker: "EchoWorker", tool: toolId, depends_on: [], input: { from: "state", path: "/request" }, output_schema: "schemas/echo-output.schema.json", timeout_seconds: 30, writes: { "/answer": { from: "result", path: "" } } },
      { id: "result", type: "output", worker: "EchoCoordinator", depends_on: ["echo"], input: { from: "state", path: "/answer" }, output_schema: "schemas/echo-output.schema.json", timeout_seconds: 10, writes: {} },
    ],
    extensions: {},
  });
  write("MANIFEST.agent", {
    spec_version: "0.1",
    package_id: "org.example.echo",
    name: "Echo",
    version: "0.1.0",
    description: "A one-tool package used only to test the host tool broker.",
    publisher: { id: "example", name: "Example" },
    created_at: "2026-09-22T00:00:00Z",
    runtime: { api: "agentpkg-runtime-v0", minimum_version: "0.2.0" },
    capabilities: ["echo"],
    entrypoint: "workflow.v0",
    graph: "graph.json",
    policy: "policy/policy.json",
    skills: [{ id: "echo", version: "0.1.0", path: "skills/echo.SKILL.md" }],
    tools: [{ id: toolId, path: `tools/${toolId}.tool.json` }],
    schemas: [
      { id: "echo-input", path: "schemas/echo-input.schema.json" },
      { id: "echo-output", path: "schemas/echo-output.schema.json" },
      { id: "state", path: "schemas/state.schema.json" },
    ],
    model_requirements: { tasks: [{ id: "echo", capabilities: ["structured_output"], context_window: 1000, preferred_tier: "any" }], routing: "host", fallback_policy: "deny", extensions: {} },
    evals: [],
    attestations: [],
    dependencies: [],
    update: { channel: "local", locator: null },
    extensions: {},
  });
  return files;
}

export interface EchoPackage {
  pkg: Package;
  bytes: Uint8Array;
  key: TestKeyPair;
  archiveSha256: string;
}

/** Build and sign the echo package in memory. */
export async function echoPackage(options: EchoOptions = {}): Promise<EchoPackage> {
  const key = await generateKeyPair();
  const files = echoSource(options);
  const built = new Map<string, Uint8Array>();
  for (const [name, data] of files) built.set(name, name.endsWith(".json") || name === "MANIFEST.agent" ? canonicalJson(JSON.parse(new TextDecoder().decode(data))) : data);
  const bytes = await signedArchive(built, key);
  return { pkg: await loadPackageBytes(bytes), bytes, key, archiveSha256: sha256HexSync(bytes) };
}

/** A host definition that exactly satisfies one declared tool of a package (`tool_fakes.py::binding_for`). */
export function definitionFor(pkg: Package, toolId: string, overrides: Partial<ToolImplementationDefinition> = {}): ToolImplementationDefinition {
  const tool = pkg.tools[toolId]!;
  const permissions = new Map((pkg.policy.permissions as JsonObject[]).map((item) => [String(item.id), item]));
  const kinds = [...new Set((tool.permissions as string[]).map((pid) => String(permissions.get(pid)!.kind)))].sort();
  const remote = tool.execution === "remote";
  const digest = (path: string) => sha256HexSync(canonicalJson(JSON.parse(new TextDecoder().decode(pkg.files.get(path)!))));
  const definition: ToolImplementationDefinition = {
    id: `host:${toolId}:1`,
    toolId,
    binding: String(tool.binding),
    kind: remote ? "json_http" : "local_builtin",
    implementationId: remote ? "openclaw.tool.json_http" : "chrome.tool.echo",
    implementationVersion: "0.1.0",
    displayName: `Test implementation of ${toolId}`,
    inputSchemaSha256: digest(String(tool.input_schema)),
    outputSchemaSha256: digest(String(tool.output_schema)),
    permissionKinds: kinds,
    sideEffects: tool.side_effects as "read" | "write",
    timeoutSeconds: Number(tool.timeout_seconds),
    maxConcurrent: 4,
  };
  if (remote) {
    const url = new URL(String(tool.endpoint));
    definition.origin = `https://${url.hostname}`;
    definition.path = url.pathname || "/";
    definition.method = tool.method as "GET" | "POST";
  }
  return { ...definition, ...overrides };
}

/** The plan binding record a control plane would freeze for one definition that satisfies `toolId` (`plan_tool_bindings`). */
export function planBindingFor(pkg: Package, definition: ToolImplementationDefinition, overrides: Partial<ToolBindingRecord> = {}): ToolBindingRecord {
  const tool = pkg.tools[definition.toolId]!;
  const descriptor = describeDefinition(definition);
  const digest = (path: string) => sha256HexSync(canonicalJson(JSON.parse(new TextDecoder().decode(pkg.files.get(path)!))));
  const linked = [...(tool.permissions as string[])].sort();
  return {
    tool_id: definition.toolId,
    binding_name: definition.binding,
    binding_id: definition.id,
    binding_sha256: bindingDigest(descriptor),
    implementation_kind: definition.kind,
    implementation_id: definition.implementationId,
    implementation_version: definition.implementationVersion,
    display_name: definition.displayName,
    remote: descriptor.remote,
    endpoint_origin: descriptor.endpoint?.origin ?? null,
    endpoint_path: descriptor.endpoint?.path ?? null,
    method: descriptor.endpoint?.method ?? null,
    contract_sha256: sha256HexSync(canonicalJson({ tool_id: definition.toolId, input: digest(String(tool.input_schema)), output: digest(String(tool.output_schema)) })),
    input_schema_sha256: digest(String(tool.input_schema)),
    output_schema_sha256: digest(String(tool.output_schema)),
    required_permission_ids: linked,
    usable: true,
    timeout_seconds: descriptor.limits.timeout_seconds,
    max_calls: ((pkg.policy.budget as JsonObject).max_calls_per_tool as JsonObject)[definition.toolId] as number,
    credentials_required: descriptor.credentials.required,
    credentials_configured: descriptor.credentials.configured,
    approved: true,
    approval_source: "authorization_receipt",
    compatibility_status: "bound",
    resource_type: definition.resourceType ?? null,
    ...overrides,
  };
}
