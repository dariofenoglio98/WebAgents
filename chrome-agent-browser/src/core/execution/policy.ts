/**
 * The person's decisions and the package's declarations, re-derived in the runner
 * (`execution/policy.py`, the policy half). Every comparison below reads the verified package
 * first and the plan second, so a plan that described the package incorrectly is refused rather
 * than believed. Nothing here knows what a package is for: no package id, name, task or skill is
 * special-cased, and a test asserts that.
 */
import { canonicalJson } from "../canonical.js";
import { computeOperations, moduleFacts } from "../compute/declarations.js";
import { limitsJson, loweredBy } from "../compute/limits.js";
import { moduleFactsJson } from "../compute/module.js";
import { sha256HexSync } from "../hash.js";
import type { JsonObject, JsonValue } from "../json.js";
import { packageJson, type Package } from "../package.js";
import type { ModelRouter } from "../models/contract.js";
import type { ToolBindingRecord } from "../tools/bindings.js";
import { RESOURCE_PERMISSION_KINDS } from "../tools/resources.js";
import { DENY, SUPPORTED_DECISIONS, type ResourceGrant } from "../types.js";
import type { GrantDecision, Grants } from "../workflow/runtime.js";
import { HOST_RESULT_NAMES, RUN_RECORD_NAME } from "./artifacts.js";
import {
  COMPUTE_LIMIT_EXCEEDED,
  COMPUTE_NOT_SUPPORTED,
  CONVERSATION_NOT_SUPPORTED,
  EXPORT_PATH_RESERVED,
  ExecutionError,
  GRANT_UNSUPPORTED,
  invalid,
  MODEL_INCOMPATIBLE,
  OUTPUT_CAP_TOO_LARGE,
  PERMISSION_DENIED,
  TOOL_CONTRACT_MISMATCH,
  TOOL_NOT_APPROVED,
  TOOL_NOT_BOUND,
  TOOL_NOT_DECLARED,
  TOOL_PERMISSION_DENIED,
  TOOLS_NOT_SUPPORTED,
} from "./errors.js";
import { activationBound, activationCosts, networkNodes, networkOf, roleSteps, routeCalls, worstCase } from "../network/analysis.js";
import { computeLimitsOf, effectiveBudget, effectiveDeadlineSeconds, type HostExecutionLimits } from "./limits.js";

const ONCE = "once";
const ALWAYS = "always";
const DECISIONS: readonly string[] = SUPPORTED_DECISIONS;
export const MAX_RESOURCE_GRANTS = 32;
const GRANT_FIELDS = ["permission_id", "resource_type", "resource_id", "resource_digest"] as const;

const pyList = (items: readonly string[]): string => `[${items.map((item) => `'${item}'`).join(", ")}]`;
const sorted = (items: Iterable<string>): string[] => [...items].sort();

/**
 * Every top-level node, every map step and, for a network (network.v0), every role step and every
 * chosen route (as the one model call it is), with a qualified identity.
 */
function* operations(graph: JsonObject): Generator<[string, JsonObject]> {
  for (const node of graph.nodes as JsonObject[]) {
    yield [String(node.id), node];
    if (node.type === "map") for (const step of node.steps as JsonObject[]) yield [`${node.id}/${step.id}`, step];
  }
  yield* roleSteps(graph);
  for (const [name, route] of routeCalls(graph)) yield [name, { type: "llm", task: route.task!, max_output_tokens: route.max_output_tokens! }];
}

function permissionsOf(pkg: Package): Record<string, JsonObject> {
  const declared: Record<string, JsonObject> = {};
  for (const permission of pkg.policy.permissions as JsonObject[]) declared[String(permission.id)] = permission;
  return declared;
}

export interface CapabilityOptions {
  toolBindings?: readonly ToolBindingRecord[];
  /**
   * Declared tools the receipt did not approve (D-022): they have no binding by design and the
   * runtime refuses any call to them, so their absence from the plan is not a host limit.
   */
  deniedTools?: readonly string[];
  /** The package's own fixture supplies every declared tool (fixture mode). */
  fixture?: boolean;
  /** compute.v0: whether this host has an engine for the package's modules (`compute_not_supported` otherwise). */
  computeAvailable?: boolean;
  /** conversation.v0: the session runs one turn of a conversation, with the persisted state, a consent host and the chain (V-28 does not apply). */
  turn?: boolean;
}

/**
 * Refuse a package this execution host cannot run, before anything starts. These are limits of
 * the host, not of the package format: a package that declares a tool the host has no binding
 * for is a valid package that cannot run *here*.
 */
export function checkCapabilities(pkg: Package, limits: HostExecutionLimits, options: CapabilityOptions = {}): JsonObject {
  const graph = pkg.graph;
  if (graph.conversation !== undefined && graph.conversation !== null && options.turn !== true) {
    // conversation.v0 (V-28): a turn needs the persisted state, a consent host and the chain of the
    // turns before it; this one-shot session runs one invocation and holds none of them.
    throw new ExecutionError(
      CONVERSATION_NOT_SUPPORTED,
      "This package is a conversation (conversation.v0) and this execution host runs a package once per invocation, with no consent host and no state between turns. This is a limit of the host, not of the package format.",
      { detail: { consent_steps: (graph.nodes as JsonObject[]).filter((node) => node.type === "consent").map((node) => String(node.id)).slice(0, 32) } },
    );
  }
  const declaredTools = (pkg.manifest.tools as JsonObject[]).map((tool) => String(tool.id));
  const toolNodes = [...operations(graph)].filter(([, op]) => op.type === "tool").map(([name]) => name);
  const bound = new Set(options.fixture ? declaredTools : (options.toolBindings ?? []).map((binding) => binding.tool_id));
  const denied = new Set(options.deniedTools ?? []);
  const missing = sorted(declaredTools.filter((toolId) => !bound.has(toolId) && !denied.has(toolId)));
  if (missing.length > 0 && bound.size === 0) {
    throw new ExecutionError(
      TOOLS_NOT_SUPPORTED,
      "This package declares tools and this run plan binds no host implementation for any of them, so nothing could mediate a call. This is a limit of the host, not of the package format.",
      { detail: { declared_tools: declaredTools.slice(0, 32), tool_nodes: toolNodes.slice(0, 32) } },
    );
  }
  if (missing.length > 0) {
    throw new ExecutionError(
      TOOL_NOT_BOUND,
      "Every tool a package declares needs a host implementation before any of its graph may run; a run that discovered an unbound tool halfway through would already have spent whatever came before it.",
      { detail: { unbound_tools: missing.slice(0, 32) } },
    );
  }
  const used = sorted(new Set([...operations(graph)].filter(([, op]) => op.type === "tool").map(([, op]) => String(op.tool))));
  const undeclared = used.filter((toolId) => !declaredTools.includes(toolId));
  if (undeclared.length > 0) throw new ExecutionError(TOOL_NOT_DECLARED, "The graph calls a tool this package never declared.", { detail: { tools: undeclared.slice(0, 32) } });
  const caps: JsonObject[] = [];
  for (const [name, op] of operations(graph)) {
    if (op.type !== "llm") continue;
    const requested = op.max_output_tokens as number;
    if (requested > limits.max_output_tokens_per_call) {
      // Silently lowering it would change what the package does: refuse, and let the operator raise the ceiling.
      throw new ExecutionError(
        OUTPUT_CAP_TOO_LARGE,
        `Node ${name} requests an output cap of ${requested} tokens, above this host's per-call ceiling of ${limits.max_output_tokens_per_call}. The host refuses rather than lowering a declared cap.`,
        { detail: { node: name, requested } },
      );
    }
    caps.push({ node: name, max_output_tokens: requested });
  }
  const reserved = new Set([...HOST_RESULT_NAMES.map((name) => name.toLowerCase()), RUN_RECORD_NAME]);
  for (const entry of (graph.exports as JsonObject[] | undefined) ?? []) {
    if (reserved.has(String(entry.path).toLowerCase())) {
      throw new ExecutionError(EXPORT_PATH_RESERVED, `Export '${entry.path}' collides with a file this execution host writes`, { detail: { reserved: sorted(reserved) } });
    }
  }
  const compute = checkCompute(pkg, limits, options.computeAvailable === true);
  const network = checkNetwork(pkg, limits);
  return {
    tools_declared: declaredTools.length,
    tool_nodes: toolNodes.length,
    tool_bindings: options.fixture ? 0 : bound.size,
    denied_tools: sorted(denied),
    llm_operations: caps,
    max_requested_output_tokens: caps.reduce((max, cap) => Math.max(max, cap.max_output_tokens as number), 0),
    host_max_output_tokens_per_call: limits.max_output_tokens_per_call,
    ...(compute !== null ? { compute } : {}),
    ...(network !== null ? { network } : {}),
  };
}

/**
 * network.v0 (R-24, `execution/policy.py::check_network`): the network's worst case under this
 * host's effective budget, recorded with the run so that "at most" is on the record before the
 * first activation; the runtime reserves it again when the node starts (R-17). A package without a
 * network returns null and its run record is unchanged.
 */
export function checkNetwork(pkg: Package, limits: HostExecutionLimits): JsonObject | null {
  const graph = pkg.graph;
  const network = networkOf(graph);
  if (network === null) return null;
  const node = networkNodes(graph)[0]!;
  const bound = worstCase(graph, pkg.policy, { budget: effectiveBudget(pkg, limits).effective as JsonObject, nodeTimeout: Math.min(node.timeout_seconds as number, effectiveDeadlineSeconds(pkg, limits)) });
  return { node: String(node.id), entry: String(network.entry), roles: Object.keys(network.roles as JsonObject), worst_case: bound };
}

/**
 * compute.v0 (`execution/policy.py::check_compute`): before the run, every module's declared memory
 * maximum fits under the host's page bound as the node lowers it, and the host has an engine at
 * all. A package without compute nodes returns null and its run record is unchanged.
 */
export function checkCompute(pkg: Package, limits: HostExecutionLimits, available: boolean): JsonObject | null {
  const operations = computeOperations(pkg.graph);
  if (operations.length === 0) return null;
  const modules = ((pkg.graph.modules as JsonObject[] | undefined) ?? []).map((module) => String(module.id));
  if (!available) {
    throw new ExecutionError(COMPUTE_NOT_SUPPORTED, "This package runs WebAssembly modules and this host has no engine for them. This is a limit of the host, not of the package format.", { detail: { modules: modules.slice(0, 32) } });
  }
  const facts = moduleFacts(pkg);
  const host = computeLimitsOf(limits);
  const checked: JsonObject[] = [];
  for (const [name, operation] of operations) {
    const effective = loweredBy(host, operation.limits);
    const maximum = facts[String(operation.module)]!.memory_max_pages;
    if (maximum > effective.memory_pages) {
      throw new ExecutionError(
        COMPUTE_LIMIT_EXCEEDED,
        `Node ${name} runs module '${operation.module}', whose declared memory maximum of ${maximum} pages is above this host's ceiling of ${effective.memory_pages}. The host refuses rather than lowering a module's declared bound.`,
        { detail: { node: name, module: String(operation.module), memory_pages: maximum } },
      );
    }
    checked.push({ node: name, module: String(operation.module), ...limitsJson(effective) });
  }
  return {
    modules: ((pkg.graph.modules as JsonObject[] | undefined) ?? []).map((module) => ({ id: module.id!, ...moduleFactsJson(facts[String(module.id)]!) })),
    operations: checked,
    host: limitsJson(host),
  };
}

const hostOf = (origin: string): string => (origin.includes("://") ? origin.split("://", 2)[1]! : "");

/**
 * Re-derive every tool fact from the signed package, then compare it with the plan: identity, the
 * binding name, execution locality, schema digests, the permission class, and for a remote
 * binding that its origin is one the package itself declared, its linked network permissions
 * name, and its network policy allows. Permission and approval are separate questions; both are asked.
 */
export function checkTools(pkg: Package, bindings: readonly ToolBindingRecord[], grants: Grants, approvals: Readonly<Record<string, boolean>>): JsonObject {
  const permissions = permissionsOf(pkg);
  const checked: JsonObject[] = [];
  for (const binding of bindings) {
    const toolId = binding.tool_id;
    const tool = pkg.tools[toolId];
    if (tool === undefined) throw new ExecutionError(TOOL_NOT_DECLARED, `The run plan binds '${toolId}', which this package does not declare.`, { detail: { tool_id: toolId } });
    const linked = (tool.permissions as string[]).filter((pid) => Object.hasOwn(permissions, pid));
    const facts: Record<string, [JsonValue, JsonValue]> = {
      binding_name: [tool.binding!, binding.binding_name],
      remote: [tool.execution === "remote", binding.remote],
      input_schema_sha256: [sha256HexSync(canonicalJson(packageJson(pkg, String(tool.input_schema)))), binding.input_schema_sha256],
      output_schema_sha256: [sha256HexSync(canonicalJson(packageJson(pkg, String(tool.output_schema)))), binding.output_schema_sha256],
      required_permission_ids: [sorted(linked), sorted(binding.required_permission_ids)],
    };
    for (const [name, [expected, actual]] of Object.entries(facts)) {
      if (JSON.stringify(expected) !== JSON.stringify(actual)) {
        throw new ExecutionError(TOOL_CONTRACT_MISMATCH, `The bound implementation of '${toolId}' does not match the package's own declaration of ${name}.`, { detail: { tool_id: toolId, field: name } });
      }
    }
    if (tool.execution === "remote") {
      const origin = binding.endpoint_origin ?? "";
      const network = new Set(linked.filter((pid) => permissions[pid]!.kind === "network").flatMap((pid) => permissions[pid]!.resources as string[]));
      const allowed = new Set((pkg.policy.network as JsonObject).allowed_domains as string[]);
      const permitted = sorted((tool.domains as string[]).filter((domain) => allowed.has(domain) && network.has(domain)));
      if (!origin.startsWith("https://") || !permitted.includes(hostOf(origin))) {
        throw new ExecutionError(TOOL_CONTRACT_MISMATCH, `The bound implementation of '${toolId}' would contact a destination this package does not declare.`, { detail: { tool_id: toolId, permitted } });
      }
    }
    if (approvals[toolId] !== true) {
      throw new ExecutionError(TOOL_NOT_APPROVED, `Tool '${toolId}' is bound but was not explicitly approved. A granted permission is not an approval of an implementation.`, { detail: { tool_id: toolId } });
    }
    if (linked.length === 0) {
      throw new ExecutionError(TOOL_PERMISSION_DENIED, `Tool '${toolId}' links to no declared permission, so no authority could be checked before it ran.`, { detail: { tool_id: toolId } });
    }
    const denied = sorted(linked.filter((pid) => (grants[pid] ?? DENY) === DENY));
    const requiredDenied = denied.filter((pid) => permissions[pid]!.required === true);
    if (requiredDenied.length > 0) {
      // A denied *optional* permission is an operating profile the package declared it supports;
      // its graph must not reach the tool, and the runtime refuses the call if it does.
      throw new ExecutionError(TOOL_PERMISSION_DENIED, `Tool '${toolId}' needs ${pyList(requiredDenied)}, which are denied.`, { detail: { tool_id: toolId, permissions: requiredDenied } });
    }
    const declaredTimeout = tool.timeout_seconds as number;
    checked.push({
      tool_id: toolId,
      binding_id: binding.binding_id,
      binding_sha256: binding.binding_sha256,
      implementation_kind: binding.implementation_kind,
      implementation_version: binding.implementation_version,
      remote: binding.remote,
      endpoint_origin: binding.endpoint_origin,
      method: binding.method,
      required_permission_ids: sorted(linked),
      denied_permission_ids: denied,
      usable: denied.length === 0,
      approved: true,
      timeout_seconds: Math.min(declaredTimeout, binding.timeout_seconds ?? declaredTimeout),
      max_calls: ((pkg.policy.budget as JsonObject).max_calls_per_tool as JsonObject)[toolId] ?? 0,
      credentials_required: binding.credentials_required,
      credentials_configured: binding.credentials_configured,
      verified: sorted(Object.keys(facts)),
    });
  }
  return {
    declared: sorted(Object.keys(pkg.tools)),
    bound: checked.map((record) => record.tool_id!),
    bindings: checked,
    note: "Every field was re-derived from the verified package in this process and then compared with the plan, so a plan that described the package incorrectly is refused rather than believed.",
  };
}

/** Confirm the bound router can satisfy every declared task before a package instruction is rendered. */
export function checkModel(pkg: Package, router: ModelRouter): JsonObject {
  const requirements = pkg.manifest.model_requirements as JsonObject;
  const tasks = requirements.tasks as JsonObject[];
  const capabilities = new Set(router.capabilities);
  const required = sorted(new Set(tasks.flatMap((task) => task.capabilities as string[])));
  const missing = required.filter((capability) => !capabilities.has(capability));
  if (missing.length > 0) {
    throw new ExecutionError(MODEL_INCOMPATIBLE, `The selected model's router does not deliver ${pyList(missing)}, which this package requires.`, { detail: { missing, router_capabilities: sorted(capabilities) } });
  }
  const context = tasks.reduce((max, task) => Math.max(max, task.context_window as number), 0);
  if (router.context_window < context) {
    throw new ExecutionError(MODEL_INCOMPATIBLE, `The selected model reports a ${router.context_window}-token context window; this package requires ${context}.`, { detail: { required_context_window: context, router: router.context_window } });
  }
  if (requirements.privacy === "local-only" && router.remote) {
    throw new ExecutionError(MODEL_INCOMPATIBLE, "This package requires a local-only model router, and the selected model is remote.");
  }
  return {
    required_capabilities: required,
    router_capabilities: sorted(capabilities),
    required_context_window: context,
    router_context_window: router.context_window,
    privacy: (requirements.privacy as JsonValue | undefined) ?? null,
    remote: Boolean(router.remote),
  };
}

/**
 * An upper bound on how often each permission kind would be consumed: a worker spawn consumes
 * the memory permission, a model call the model permission, a tool call every permission it
 * links, with a map counted at its declared `max_items`. What matters is whether it can exceed one.
 */
export function consumptionCounts(pkg: Package): Record<string, number> {
  const graph = pkg.graph;
  const coordinator = String(graph.coordinator);
  const permissions = permissionsOf(pkg);
  const budget = (pkg.policy.budget as JsonObject).max_calls_per_tool as JsonObject;
  const counts: Record<string, number> = { model: 0, memory: 0 };
  const toolUse = (toolId: string, times: number): void => {
    const tool = pkg.tools[toolId];
    if (tool === undefined) return;
    const allowed = (budget[toolId] as number | undefined) ?? 0;
    for (const pid of tool.permissions as string[]) {
      const kind = permissions[pid]?.kind;
      if (typeof kind === "string" && kind.length > 0) counts[kind] = (counts[kind] ?? 0) + Math.min(times, allowed);
    }
  };
  for (const node of graph.nodes as JsonObject[]) {
    if (node.type === "llm") counts.model! += 1;
    if (node.type === "tool") toolUse(String(node.tool), 1);
    // compute.v0: every call consumes the compute permission, as a tool call does.
    if (node.type === "compute") counts.compute = (counts.compute ?? 0) + 1;
    if (node.type === "map") {
      const children = Math.max(1, node.max_items as number);
      counts.memory! += children;
      for (const step of node.steps as JsonObject[]) {
        if (step.type === "llm") counts.model! += children;
        if (step.type === "tool") toolUse(String(step.tool), children);
        if (step.type === "compute") counts.compute = (counts.compute ?? 0) + children;
      }
    } else if (node.worker !== coordinator) counts.memory! += 1;
  }
  const network = networkOf(graph);
  if (network !== null) {
    // network.v0: each activation of a role is a worker instance (the memory permission once per
    // activation) that may make its program's calls; the bound on activations is the declaration's
    // (R-20), so the count stays a bound.
    for (const roleId of Object.keys(network.roles as JsonObject)) {
      const activations = activationBound(network, roleId);
      const costs = activationCosts(graph, roleId);
      counts.memory! += activations;
      counts.model! += activations * costs.model_calls;
      for (const [toolId, perActivation] of Object.entries(costs.tool_calls)) toolUse(toolId, activations * perActivation);
      if (costs.compute_calls > 0) counts.compute = (counts.compute ?? 0) + activations * costs.compute_calls;
    }
  }
  return counts;
}

/**
 * Carry the person's decisions through unchanged, or refuse the run. `deny` stays `deny` and fails
 * a required permission; `once` is refused outright when the graph would consume it more than
 * once, because honouring it would mean denying halfway through and widening it would be consent
 * this host was never given.
 */
export function normalizeGrants(pkg: Package, submitted: unknown): Grants {
  if (typeof submitted !== "object" || submitted === null || Array.isArray(submitted)) throw invalid("grants must be an object of permission id to decision");
  const declared = permissionsOf(pkg);
  const record = submitted as Record<string, unknown>;
  const unknown = sorted(Object.keys(record).filter((pid) => !Object.hasOwn(declared, pid)));
  if (unknown.length > 0) throw invalid(`grants refer to undeclared permissions: ${pyList(unknown)}`);
  const missing = sorted(Object.keys(declared).filter((pid) => !Object.hasOwn(record, pid)));
  if (missing.length > 0) throw invalid(`grants omit declared permissions: ${pyList(missing)}`);
  const counts = consumptionCounts(pkg);
  const grants: Grants = {};
  for (const permissionId of sorted(Object.keys(record))) {
    const decision = record[permissionId];
    const permission = declared[permissionId]!;
    const kind = String(permission.kind);
    if (decision === ALWAYS) {
      throw new ExecutionError(GRANT_UNSUPPORTED, `Permission '${permissionId}' was granted 'always', which this host has no store for. A grant that lasts only one run must not be recorded as durable.`, { detail: { permission: permissionId } });
    }
    if (typeof decision !== "string" || !DECISIONS.includes(decision)) throw invalid(`Decision for '${permissionId}' must be one of ${pyList(DECISIONS)}`);
    if (decision === DENY && permission.required === true) {
      throw new ExecutionError(PERMISSION_DENIED, `Required permission '${permissionId}' is denied, so this package cannot run.`, { detail: { permission: permissionId, kind } });
    }
    if (decision === ONCE && (counts[kind] ?? 0) > 1) {
      throw new ExecutionError(
        GRANT_UNSUPPORTED,
        `Permission '${permissionId}' was granted 'once', but this workflow would use it up to ${counts[kind]} times. The run is refused rather than silently widening the decision to a whole session.`,
        { detail: { permission: permissionId, kind, maximum_uses: counts[kind]! } },
      );
    }
    grants[permissionId] = decision as GrantDecision;
  }
  return grants;
}

/** The host resources a plan granted, as a closed, bounded list of references: never a value. */
export function normalizeResourceGrants(raw: unknown): ResourceGrant[] {
  if (raw === null || raw === undefined) return [];
  if (!Array.isArray(raw) || raw.length > MAX_RESOURCE_GRANTS) throw invalid(`resource_grants must be a list of at most ${MAX_RESOURCE_GRANTS}`);
  const grants: ResourceGrant[] = [];
  raw.forEach((item, index) => {
    if (typeof item !== "object" || item === null || Array.isArray(item) || Object.keys(item).sort().join(",") !== [...GRANT_FIELDS].sort().join(",")) {
      throw invalid(`resource_grants[${index}] must carry exactly ${pyList(GRANT_FIELDS)}`);
    }
    const record = item as Record<string, unknown>;
    for (const name of GRANT_FIELDS) {
      const value = record[name];
      if (typeof value !== "string" || value.length === 0 || value.length > 128) throw invalid(`resource_grants[${index}].${name} must be a short string`);
    }
    grants.push({ permission_id: record.permission_id as string, resource_type: record.resource_type as string, resource_id: record.resource_id as string, resource_digest: record.resource_digest as string });
  });
  const permissions = grants.map((grant) => grant.permission_id);
  if (new Set(permissions).size !== permissions.length) throw invalid("resource_grants names one permission twice");
  return grants.sort((a, b) => (a.permission_id < b.permission_id ? -1 : a.permission_id > b.permission_id ? 1 : 0));
}

/** Re-derive from the signed package that every frozen resource grant is one it could hold. */
export function checkResourceGrants(pkg: Package, resourceGrants: readonly ResourceGrant[], grants: Grants): JsonObject {
  const declared = permissionsOf(pkg);
  const checked: JsonObject[] = [];
  for (const grant of resourceGrants) {
    const permission = declared[grant.permission_id];
    if (permission === undefined || !(RESOURCE_PERMISSION_KINDS as readonly string[]).includes(String(permission.kind)) || !(permission.resources as string[]).includes(grant.resource_type)) {
      throw invalid("The run plan grants a host resource under a permission this package does not declare for that resource type", { permission: grant.permission_id });
    }
    if ((grants[grant.permission_id] ?? DENY) === DENY) {
      throw new ExecutionError(PERMISSION_DENIED, `The run plan grants a host resource under '${grant.permission_id}', which is denied.`, { detail: { permission: grant.permission_id } });
    }
    checked.push({ ...grant, decision: grants[grant.permission_id]! });
  }
  return {
    grants: checked,
    note: "Each grant names one host resource by opaque id and digest. The host resolves it only for the tool calls that link its permission; the runner never sees a value until a tool returns one, and checks that the host attributes the answer to exactly this grant.",
  };
}

export function grantReport(pkg: Package, grants: Grants): JsonObject {
  const declared = permissionsOf(pkg);
  const kinds = sorted(new Set(Object.values(declared).map((permission) => String(permission.kind))));
  const decisions: JsonObject = {};
  for (const pid of sorted(Object.keys(grants))) decisions[pid] = grants[pid]!;
  const byKind: JsonObject = {};
  for (const kind of kinds) byKind[kind] = sorted(Object.keys(grants).filter((pid) => declared[pid]!.kind === kind));
  return {
    decisions,
    granted_permission_ids: sorted(Object.keys(grants).filter((pid) => grants[pid] !== DENY)),
    denied_permission_ids: sorted(Object.keys(grants).filter((pid) => grants[pid] === DENY)),
    by_kind: byKind,
    source: "authorization_receipt",
    note: "Decisions are passed through unchanged; no decision is widened by this host.",
  };
}
