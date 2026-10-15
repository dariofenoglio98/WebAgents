/**
 * What a package may declare about memory, checked at validation (§7, M-33, M-38, M-48, M-18,
 * M-19, M-67), before any host binds anything: the one-type `memory.read` permission and its
 * tool, `memory.write` with its one `proposals.json` export, the agent document's scope and its
 * two reserved tools with the exact schemas, the custom types, and the minimum runtime version.
 * Refusals are `ValidationError`s whose text starts with the spec's code.
 */
import { canonicalString } from "../canonical.js";
import { ValidationError } from "../errors.js";
import { isJsonObject, parseJson, type JsonObject, type JsonValue } from "../json.js";
import { MEMORY_CONTRACTS } from "../schemas/memory/index.js";
import { compareRelease } from "../version.js";
import { AGENT_TYPE, MAX_PROPOSALS, RESERVED_TYPES, SELF_TYPE, WELL_KNOWN_TYPE_ID } from "./model.js";
import { PROPOSALS_EXPORT_FORMAT, PROPOSALS_PATH } from "./proposals.js";
import { customTypesOf, MemoryTypeError, starterTypes } from "./types.js";
import { sha256HexSync } from "../hash.js";
import { RESOURCE_PERMISSION_KINDS } from "../tools/resources.js";

export const MEMORY_MINIMUM_VERSION = "0.4.0";
export const MEMORY_READ_BINDING_PREFIX = "host.memory.";
export const LEGACY_READ_BINDING_PREFIX = "host.resource.";
export const AGENT_READ_BINDING = "host.memory.agent.read";
export const AGENT_WRITE_BINDING = "host.memory.agent.write";
export const AGENT_SCOPE = "agent-scoped";
export const AGENT_RESOURCE = "agent";

/** The exact schemas of the two reserved agent tools (M-48), as canonical JSON. */
/**
 * The memory types a package requests (M-33 and the `personal.read` alias): the resources of its
 * `memory.read` and `personal.read` permissions, in declaration order, each once. One derivation
 * for the plan-time registry (the service worker) and the run-time one (the execution host), so
 * both hash the same facts (review 1, nit 10).
 */
export function requestedResourceTypes(policy: JsonObject): string[] {
  const kinds: readonly string[] = RESOURCE_PERMISSION_KINDS;
  return [...new Set((policy.permissions as JsonObject[]).filter((permission) => kinds.includes(String(permission.kind))).flatMap((permission) => (permission.resources as JsonValue[]).map(String)))];
}

/** The agent tools' schema digests (M-48): the contract files', the same bytes in both runtimes and at plan and run time. */
export function agentToolDigests(): { read_output_sha256: string; write_input_sha256: string; write_output_sha256: string } {
  const schemas = agentToolSchemas();
  const digest = (text: string) => sha256HexSync(new TextEncoder().encode(text));
  return { read_output_sha256: digest(schemas[AGENT_READ_BINDING]!.output), write_input_sha256: digest(schemas[AGENT_WRITE_BINDING]!.input), write_output_sha256: digest(schemas[AGENT_WRITE_BINDING]!.output) };
}

export function agentToolSchemas(): Record<string, { input: string; output: string }> {
  const canonical = (name: string) => canonicalString(MEMORY_CONTRACTS[name]);
  return {
    [AGENT_READ_BINDING]: { input: canonical("memory-empty-input.schema"), output: canonical("memory-agent-read.output.schema") },
    [AGENT_WRITE_BINDING]: { input: canonical("memory-agent-write.input.schema"), output: canonical("memory-agent-write.output.schema") },
  };
}

const str = (value: JsonValue | undefined): string => String(value);

function refuse(code: string, message: string): ValidationError {
  return new ValidationError(`${code}: ${message}`);
}

/** The facts the rest of the host needs from the declarations, once validated. */
export interface MemoryDeclarations {
  /** `memory.read` permission id → the one resource type it names (a type id or a legacy id). */
  reads: Map<string, string>;
  /** The `memory.write` permission id and the type ids it may propose (local custom ids qualified), or null. */
  write: { permission_id: string; types: string[] } | null;
  /** The agent document's permission id and the bindings declared, when the scope is agent-scoped. */
  agent: { permission_id: string; read_tool: string | null; write_tool: string | null } | null;
  /** The package's custom types (M-18), qualified by its id. */
  custom_types: ReturnType<typeof customTypesOf>;
  /** Whether anything beyond the `personal.read` alias is used (M-67). */
  uses_memory_v0: boolean;
}

/** Read and check a package's memory declarations; throws a `ValidationError` with the spec's code on the first problem. */
export function memoryDeclarations(manifest: JsonObject, policy: JsonObject, tools: Readonly<Record<string, JsonObject>>, files: ReadonlyMap<string, Uint8Array>): MemoryDeclarations {
  const permissions = policy.permissions as JsonObject[];
  const packageId = str(manifest.package_id);
  const wellKnown = starterTypes();
  let custom: ReturnType<typeof customTypesOf>;
  try {
    custom = customTypesOf(packageId, policy, files, wellKnown);
  } catch (error) {
    if (error instanceof MemoryTypeError) throw refuse(error.code, error.message);
    throw error;
  }
  const customByLocal = new Map(custom.map((type) => [type.id.slice(packageId.length + 1), type.id] as const));
  const knownIds = new Set(wellKnown.map((type) => type.id));
  const legacyIds = new Set(wellKnown.flatMap((type) => (type.legacy ?? []).map((alias) => alias.id)));
  const resolveType = (resource: string): string | null => (knownIds.has(resource) ? resource : (customByLocal.get(resource) ?? null));
  const reads = new Map<string, string>();
  let write: MemoryDeclarations["write"] = null;
  let agentPermission: string | null = null;
  let usesMemory = custom.length > 0;
  for (const permission of permissions) {
    const id = str(permission.id);
    const kind = str(permission.kind);
    const resources = (permission.resources as JsonValue[]).map(str);
    if (kind === "memory.read") {
      usesMemory = true;
      if (resources.length !== 1) throw refuse("ambiguous", `memory.read permission ${id} must name exactly one type in resources`);
      const resource = resources[0]!;
      if (resource === AGENT_TYPE || resource === SELF_TYPE) throw refuse("memory_type_reserved", `memory.read permission ${id} names the reserved type ${resource}`);
      if (resolveType(resource) === null && !legacyIds.has(resource)) {
        // A type this host does not know: refused later at binding (`memory_type_unknown`), not at validation; the form must be well-known.
        if (!WELL_KNOWN_TYPE_ID.test(resource)) throw refuse("memory_type_unknown", `memory.read permission ${id} names ${resource}, which is not a type id`);
      }
      reads.set(id, resource);
    } else if (kind === "memory.write") {
      usesMemory = true;
      if (write !== null) throw refuse("memory_proposal_undeclared", "a package declares at most one memory.write permission");
      if (resources.length === 0 || resources.length > MAX_PROPOSALS) throw refuse("memory_type_reserved", `memory.write permission ${id} must name 1 to ${MAX_PROPOSALS} types`);
      const types: string[] = [];
      for (const resource of resources) {
        if (RESERVED_TYPES.has(resource)) throw refuse("memory_type_reserved", `memory.write permission ${id} names the reserved type ${resource}`);
        if (!WELL_KNOWN_TYPE_ID.test(resource)) throw refuse("memory_type_unknown", `memory.write permission ${id} names ${resource}, which is not a type id`);
        types.push(resolveType(resource) ?? resource);
      }
      write = { permission_id: id, types };
    } else if (kind === "memory" && resources.includes(AGENT_RESOURCE)) {
      usesMemory = true;
      if (resources.length !== 1) throw refuse("agent_memory_scope", `memory permission ${id} names the agent document beside other resources`);
      if (agentPermission !== null) throw refuse("agent_memory_scope", "a package declares at most one agent-document permission");
      agentPermission = id;
    }
  }
  const memory = policy.memory as JsonObject;
  const scope = str(memory.scope);
  if (scope === AGENT_SCOPE) {
    usesMemory = true;
    if (agentPermission === null) throw refuse("agent_memory_scope", "memory.scope agent-scoped needs one memory permission whose resources are [\"agent\"]");
    if (memory.retention !== "user-managed" || memory.raw_documents !== false || memory.sharing !== "explicit_views") {
      throw refuse("agent_memory_scope", "memory.scope agent-scoped requires retention user-managed, raw_documents false and sharing explicit_views");
    }
  } else if (agentPermission !== null) throw refuse("agent_memory_scope", `a memory permission names the agent document, but memory.scope is ${scope}`);
  // Tools: the memory reads (M-33) and the two reserved agent tools (M-48).
  const schemas = agentToolSchemas();
  let readTool: string | null = null;
  let writeTool: string | null = null;
  const budget = ((policy.budget as JsonObject).max_calls_per_tool ?? {}) as JsonObject;
  for (const [toolId, tool] of Object.entries(tools)) {
    const binding = str(tool.binding);
    const linked = (tool.permissions as JsonValue[]).map(str);
    const schemaText = (path: string): string => canonicalString(parseJson(files.get(path)!, path));
    if (binding === AGENT_READ_BINDING || binding === AGENT_WRITE_BINDING) {
      usesMemory = true;
      if (scope !== AGENT_SCOPE || agentPermission === null) throw refuse("agent_memory_scope", `tool ${toolId} binds ${binding}, which only an agent-scoped package may declare`);
      if (tool.execution !== "local" || tool.approval_required !== true || (tool.domains as JsonValue[]).length !== 0) throw refuse("agent_memory_scope", `tool ${toolId} must be local, approval_required and without domains`);
      if (linked.length !== 1 || linked[0] !== agentPermission) throw refuse("agent_memory_scope", `tool ${toolId} must link the agent-document permission ${agentPermission} and nothing else`);
      const expected = schemas[binding]!;
      if (schemaText(str(tool.input_schema)) !== expected.input || schemaText(str(tool.output_schema)) !== expected.output) {
        throw refuse("binding_schema_mismatch", `tool ${toolId}: the schemas of ${binding} must be exactly the memory.v0 agent tool schemas`);
      }
      if (binding === AGENT_WRITE_BINDING) {
        if (tool.side_effects !== "write") throw refuse("agent_memory_scope", `tool ${toolId} must declare side_effects write`);
        if (budget[toolId] !== 1) throw refuse("agent_memory_write_cap", `tool ${toolId}: max_calls_per_tool must be exactly 1 for ${binding}`);
        if (writeTool !== null) throw refuse("agent_memory_scope", `two tools bind ${binding}`);
        writeTool = toolId;
      } else {
        if (tool.side_effects !== "read") throw refuse("agent_memory_scope", `tool ${toolId} must declare side_effects read`);
        if (readTool !== null) throw refuse("agent_memory_scope", `two tools bind ${binding}`);
        readTool = toolId;
      }
      continue;
    }
    if (binding.startsWith(MEMORY_READ_BINDING_PREFIX)) {
      usesMemory = true;
      const typeId = binding.slice(MEMORY_READ_BINDING_PREFIX.length);
      const permissionId = linked.find((id) => reads.get(id) === typeId);
      if (permissionId === undefined || linked.length !== 1) throw refuse("memory_type_unknown", `tool ${toolId} binds ${binding} but links no memory.read permission for ${typeId}`);
      if (tool.execution !== "local" || tool.approval_required !== true || tool.side_effects !== "read" || (tool.domains as JsonValue[]).length !== 0) {
        throw refuse("memory_type_unknown", `tool ${toolId} must be a local, read-only, approval-required tool without domains`);
      }
      if (schemaText(str(tool.input_schema)) !== canonicalString(MEMORY_CONTRACTS["memory-empty-input.schema"])) throw refuse("binding_schema_mismatch", `tool ${toolId}: a memory read takes the empty object`);
    }
  }
  const exportsDeclared = ((manifest.entrypoint === "workflow.v0" ? ((policy as { exports?: unknown }).exports ?? null) : null) ?? null) as JsonValue | null;
  void exportsDeclared;
  return { reads, write, agent: agentPermission === null ? null : { permission_id: agentPermission, read_tool: readTool, write_tool: writeTool }, custom_types: custom, uses_memory_v0: usesMemory };
}

/**
 * The graph-side checks (M-38): a `memory.write` permission and exactly one `memory.proposal`
 * export go together; the export is `proposals.json`. And M-67: the minimum version.
 */
export function checkMemoryGraph(manifest: JsonObject, graph: JsonObject, declarations: MemoryDeclarations): void {
  const exports = ((graph.exports as JsonValue[] | undefined) ?? []) as JsonObject[];
  const proposalExports = exports.filter((entry) => entry.format === PROPOSALS_EXPORT_FORMAT);
  if (declarations.write !== null && proposalExports.length !== 1) throw refuse("memory_proposal_undeclared", `a package declaring memory.write declares exactly one export of format ${PROPOSALS_EXPORT_FORMAT}`);
  if (declarations.write === null && proposalExports.length > 0) throw refuse("memory_proposal_undeclared", `the export format ${PROPOSALS_EXPORT_FORMAT} belongs to a package declaring memory.write`);
  for (const entry of proposalExports) if (entry.path !== PROPOSALS_PATH) throw refuse("memory_proposal_undeclared", `the ${PROPOSALS_EXPORT_FORMAT} export must be ${PROPOSALS_PATH}`);
  const uses = declarations.uses_memory_v0 || proposalExports.length > 0;
  const minimum = str((manifest.runtime as JsonObject).minimum_version);
  if (uses && compareRelease(minimum, MEMORY_MINIMUM_VERSION) < 0) throw refuse("memory_minimum_version", `memory.v0 declarations require runtime.minimum_version ${MEMORY_MINIMUM_VERSION} or later`);
}

export function isMemoryBinding(binding: string): boolean {
  return binding.startsWith(MEMORY_READ_BINDING_PREFIX) || binding.startsWith(LEGACY_READ_BINDING_PREFIX);
}

export { isJsonObject };
