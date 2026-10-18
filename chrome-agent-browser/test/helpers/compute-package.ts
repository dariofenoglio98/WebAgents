/**
 * `compute_probe.py`: a small generic workflow.v0 package with compute nodes (compute.v0), built in
 * memory so that each test can change one thing: the module bytes, the graph's declaration of them,
 * the node's limits, the permission, the schemas. Model-free by default: the fixture replays
 * nothing, the module runs for real, as it does in every mode. The modules are the hand-assembled
 * ones of `examples/compute/cases/modules/`; nothing here needs a toolchain.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { canonicalJson } from "../../src/core/canonical.js";
import { sha256HexSync } from "../../src/core/hash.js";
import type { JsonObject, JsonValue } from "../../src/core/json.js";
import { loadPackageBytes, type Package } from "../../src/core/package.js";
import { generateKeyPair, signedArchive, type TestKeyPair } from "./keys.js";
import { ROOT } from "./paths.js";

export const CASES = join(ROOT, "examples", "compute", "cases");
export const MODULES = join(CASES, "modules");
export const ANY: JsonObject = { $schema: "https://json-schema.org/draft/2020-12/schema" };
export const REQUEST: JsonObject = { a: 1, b: "two" };

export function caseModule(stem: string): Uint8Array {
  return new Uint8Array(readFileSync(join(MODULES, `${stem}.wasm`)));
}

export interface CaseList {
  modules: Record<string, string>;
  cases: Array<{ id: string; title: string; module: string | null; stage: string; code: string; reason?: string; trap_code?: string; detail?: string; feature?: string; variant?: string; generator?: string; message?: string; node_limits?: JsonObject; grants?: Record<string, string>; input_schema?: JsonObject; output_schema?: JsonObject; non_metering_reason?: string; non_distinguishing_trap_code?: string; memory_pages?: number }>;
}

export function caseList(): CaseList {
  return JSON.parse(readFileSync(join(CASES, "cases.json"), "utf8")) as CaseList;
}

export interface ComputeNodeOptions {
  module?: string;
  function?: string;
  inputPath?: string;
  limits?: JsonObject | null;
  dependsOn?: string[];
  writes?: JsonObject | null;
  inputSchema?: string;
  outputSchema?: string;
  worker?: string;
  when?: JsonObject | null;
}

export function computeNode(nodeId = "compute", options: ComputeNodeOptions = {}): JsonObject {
  const node: JsonObject = {
    id: nodeId,
    type: "compute",
    worker: options.worker ?? "Coordinator",
    depends_on: [...(options.dependsOn ?? [])],
    input: { from: "state", path: options.inputPath ?? "/request" },
    input_schema: options.inputSchema ?? "schemas/compute-input.schema.json",
    output_schema: options.outputSchema ?? "schemas/compute-output.schema.json",
    timeout_seconds: 30,
    writes: options.writes === undefined || options.writes === null ? { "/result": { from: "result", path: "" } } : options.writes,
    module: options.module ?? "echo",
    function: options.function ?? "run",
  };
  if (options.limits) node.limits = options.limits;
  if (options.when) Object.assign(node, options.when);
  return node;
}

export interface ProbeOptions {
  /** Module id → bytes (default: the echo module). */
  modules?: Record<string, Uint8Array>;
  /** Replaces the one compute node. */
  nodes?: JsonObject[];
  permission?: boolean;
  permissionResources?: string[];
  minimumVersion?: string;
  inputSchema?: JsonObject | null;
  outputSchema?: JsonObject | null;
  /** Overrides the graph's module list (to misdeclare a hash or a path). */
  declared?: JsonObject[];
  stateKeys?: string[];
  extraFiles?: Record<string, Uint8Array>;
  fixtureInput?: JsonValue;
  /** Declare an optional model permission the graph never uses, so a browser run plan can bind a model (B-228), as `scripts/e2e-compute.mjs` does. */
  modelPermission?: boolean;
}

/** The probe's payload files (`compute_probe.py::write_probe`). */
export function probeSource(options: ProbeOptions = {}): Map<string, Uint8Array> {
  const encoder = new TextEncoder();
  const files = new Map<string, Uint8Array>();
  const write = (path: string, value: JsonValue) => files.set(path, encoder.encode(`${JSON.stringify(value, null, 2)}\n`));
  const modules = options.modules ?? { echo: caseModule("echo") };
  for (const [moduleId, data] of Object.entries(modules)) files.set(`modules/${moduleId}.wasm`, data);
  const declared = options.declared ?? Object.entries(modules).map(([moduleId, data]) => ({ id: moduleId, path: `modules/${moduleId}.wasm`, sha256: sha256HexSync(data) }));
  const nodes = (options.nodes ?? [computeNode()]).map((node) => JSON.parse(JSON.stringify(node)) as JsonObject);
  const last = nodes.map((node) => String(node.id));
  nodes.push({ id: "output", type: "output", worker: "Coordinator", depends_on: last, input: { from: "state", path: "/result" }, output_schema: "schemas/output.schema.json", timeout_seconds: 10, writes: {} });
  const stateKeys = options.stateKeys ?? ["request", "result"];
  write("MANIFEST.agent", {
    spec_version: "0.1",
    package_id: "org.example.compute-probe",
    name: "Compute Probe",
    version: "0.1.0",
    description: "A test package that runs WebAssembly modules under compute.v0.",
    publisher: { id: "example", name: "Example" },
    created_at: "2026-10-16T00:00:00Z",
    runtime: { api: "agentpkg-runtime-v0", minimum_version: options.minimumVersion ?? "0.5.0" },
    capabilities: [],
    entrypoint: "workflow.v0",
    graph: "graph.json",
    policy: "policy/policy.json",
    skills: [],
    tools: [],
    schemas: ["input", "state", "compute-input", "compute-output", "output"].map((name) => ({ id: name, path: `schemas/${name}.schema.json` })),
    model_requirements: { tasks: [], routing: "host", fallback_policy: "deny", extensions: {} },
    evals: [],
    attestations: [],
    dependencies: [],
    update: { channel: "local", locator: null },
    extensions: {},
  });
  const permissions: JsonObject[] = [{ id: "memory.session", kind: "memory", description: "Use isolated session state", required: true, resources: ["session"] }];
  if (options.permission !== false) {
    permissions.push({ id: "compute.modules", kind: "compute", description: "Run the package's WebAssembly modules, which can only compute.", required: true, resources: options.permissionResources ?? Object.keys(modules).sort() });
  }
  if (options.modelPermission) {
    permissions.push({ id: "model.unused", kind: "model", description: "Not used by this graph; declared so a browser run plan can bind a model.", required: false, resources: ["host-router"] });
  }
  write("policy/policy.json", {
    spec_version: "0.1",
    permissions,
    network: { allowed_domains: [], https_only: true, allow_redirects: false },
    memory: { scope: "session", retention: "session", raw_documents: false, state_schema: "schemas/state.schema.json", sharing: "explicit_views" },
    budget: { estimated_tokens: 0, hard_tokens: 1000, max_remote_calls: 0, max_calls_per_tool: {}, max_parallel_workers: 2, estimated_cost_usd: null, approval_threshold_tokens: null },
    delegation: { max_depth: 1, approved_roles: ["Worker"], allow_remote: false },
    extensions: {},
  });
  const worker = (id: string, maxInstances: number): JsonObject => ({ id, kind: "packaged", skills: [], tools: [], max_instances: maxInstances, budget: { tokens: 1000, remote_calls: 0 }, state_read: [...stateKeys], state_write: stateKeys.filter((key) => key !== "request") });
  const initial: JsonObject = { request: { from: "input", path: "" } };
  for (const key of stateKeys) if (key !== "request") initial[key] = { literal: null };
  const graph: JsonObject = {
    spec_version: "0.1",
    profile: "workflow.v0",
    coordinator: "Coordinator",
    workers: [worker("Coordinator", 1), worker("Worker", 2)],
    input_schema: "schemas/input.schema.json",
    output_schema: "schemas/output.schema.json",
    initial_state: { object: initial },
    deadline_seconds: 120,
    nodes,
    fixture: "fixtures/workflow.json",
    extensions: {},
  };
  if (declared.length > 0) graph.modules = declared;
  write("graph.json", graph);
  write("schemas/input.schema.json", { ...ANY, type: "object" });
  const stateProperties: JsonObject = {};
  for (const key of stateKeys) stateProperties[key] = {};
  write("schemas/state.schema.json", { ...ANY, type: "object", properties: stateProperties, required: [...stateKeys], additionalProperties: false });
  write("schemas/compute-input.schema.json", options.inputSchema ?? { ...ANY, type: "object" });
  write("schemas/compute-output.schema.json", options.outputSchema ?? { ...ANY, type: "object" });
  write("schemas/output.schema.json", { ...ANY });
  write("fixtures/workflow.json", { profile: "workflow.fixture.v0", input: options.fixtureInput === undefined ? REQUEST : options.fixtureInput, models: {}, tools: {} });
  for (const [name, data] of Object.entries(options.extraFiles ?? {})) files.set(name, data);
  return files;
}

export interface Probe {
  pkg: Package;
  bytes: Uint8Array;
  key: TestKeyPair;
}

/** Canonical JSON members, signed with a throwaway key, loaded. Throws what `loadPackageBytes` throws. */
export async function probeBytes(options: ProbeOptions = {}): Promise<{ bytes: Uint8Array; key: TestKeyPair }> {
  const key = await generateKeyPair();
  const built = new Map<string, Uint8Array>();
  for (const [name, data] of probeSource(options)) built.set(name, name.endsWith(".json") || name === "MANIFEST.agent" ? canonicalJson(JSON.parse(new TextDecoder().decode(data))) : data);
  return { bytes: await signedArchive(built, key), key };
}

export async function probePackage(options: ProbeOptions = {}): Promise<Probe> {
  const { bytes, key } = await probeBytes(options);
  return { pkg: await loadPackageBytes(bytes), bytes, key };
}

/** Every permission granted for the session, except the decisions given. */
export function probeGrants(pkg: Package, decisions: Record<string, string> = {}): Record<string, "once" | "session" | "always" | "deny"> {
  return Object.fromEntries((pkg.policy.permissions as JsonObject[]).map((permission) => [String(permission.id), (decisions[String(permission.id)] ?? "session") as "once" | "session" | "always" | "deny"]));
}
