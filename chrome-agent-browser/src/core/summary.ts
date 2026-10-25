/**
 * Generic, bounded browser rendering of one verified package, mirroring
 * `agentpkg/browser/summary.py` (`agentpkg-browser-summary-v0`).
 *
 * Everything here is derived from declared package structure. There are no package-id,
 * publisher, capability-name or application-domain branches: the reference packages differ
 * in this output only because their declarations differ. Raw instruction text, schema
 * bodies and attestation contents are summarized by path, size and hash and never inlined,
 * with one deliberate exception: the task input schema, which a browser renders a form from.
 */
import type { EvaluationLayers, PublisherReport } from "./evaluation.js";
import { sha256Hex } from "./hash.js";
import { isJsonObject, type JsonObject, type JsonValue } from "./json.js";
import { packageJson, permissionsSummary, type Package } from "./package.js";
import { conversationRecords } from "./conversation/declarations.js";
import { networkRecords, type NetworkRecords } from "./network/declarations.js";
import { EXTENSION_KEY, inputForm, presentationHints, type InputForm, type PresentationHints } from "./presentation.js";
import { urlsplit } from "./urls.js";

export const SUMMARY_SCHEMA = "agentpkg-browser-summary-v0";
const MAX_LISTED_KEYS = 32;

export interface FileFacts {
  path: string;
  bytes: number;
  sha256: string;
}

export interface Warning {
  code: string;
  severity: "info" | "warning" | "critical";
  message: string;
}

/** The workflow section: generic graph facts plus the task input form and presentation hints. */
export type WorkflowSummary = { [key: string]: unknown; input?: InputForm; presentation?: PresentationHints | null };

export interface BrowserSummary {
  schema: typeof SUMMARY_SCHEMA;
  package: JsonObject;
  validation: EvaluationLayers;
  publisher: PublisherReport;
  capabilities: string[];
  skills: Array<JsonObject & FileFacts>;
  tools: JsonObject[];
  workers: JsonObject[];
  workflow: WorkflowSummary;
  model_requirements: JsonObject;
  evals: JsonObject[];
  attestations: JsonObject[];
  policy: JsonObject;
  payload: { file_count: number; total_bytes: number; files: FileFacts[] };
  warnings: Warning[];
}

async function fileFacts(pkg: Package, path: string): Promise<FileFacts> {
  const data = pkg.files.get(path) ?? new Uint8Array();
  return { path, bytes: data.length, sha256: await sha256Hex(data) };
}

async function skills(pkg: Package): Promise<Array<JsonObject & FileFacts>> {
  const out: Array<JsonObject & FileFacts> = [];
  for (const skill of pkg.manifest.skills as JsonObject[]) {
    out.push({ id: skill.id!, version: skill.version!, ...(await fileFacts(pkg, String(skill.path))) });
  }
  return out;
}

function tools(pkg: Package): JsonObject[] {
  return Object.keys(pkg.tools)
    .sort()
    .map((toolId) => {
      const tool = pkg.tools[toolId]!; // own keys only: `Object.keys` above
      const endpoint = tool.endpoint;
      let endpointOrigin: string | null = null;
      if (typeof endpoint === "string" && endpoint) {
        const parts = urlsplit(endpoint);
        endpointOrigin = `${parts.scheme}://${parts.hostname}`;
      }
      return {
        id: tool.id!,
        version: tool.version!,
        description: tool.description!,
        execution: tool.execution!,
        binding: tool.binding!,
        endpoint: endpoint ?? null,
        endpoint_origin: endpointOrigin,
        method: tool.method ?? null,
        domains: [...(tool.domains as JsonValue[])],
        permissions: [...(tool.permissions as JsonValue[])],
        side_effects: tool.side_effects!,
        approval_required: tool.approval_required!,
        timeout_seconds: tool.timeout_seconds!,
        retries: tool.retries!,
        input_schema: tool.input_schema!,
        output_schema: tool.output_schema!,
      };
    });
}

function workers(pkg: Package): JsonObject[] {
  const coordinator = pkg.graph.coordinator;
  return (pkg.graph.workers as JsonObject[]).map((worker) => ({
    id: worker.id!,
    kind: worker.kind!,
    is_coordinator: worker.id === coordinator,
    skills: [...(worker.skills as JsonValue[])],
    tools: [...(worker.tools as JsonValue[])],
    max_instances: worker.max_instances!,
    state_read: [...(worker.state_read as JsonValue[])],
    state_write: [...(worker.state_write as JsonValue[])],
    budget: { ...(worker.budget as JsonObject) },
  }));
}

function nodeFacts(node: JsonObject): JsonObject {
  const facts: JsonObject = {
    id: node.id!,
    type: node.type!,
    worker: node.worker!,
    depends_on: [...(node.depends_on as JsonValue[])],
    timeout_seconds: node.timeout_seconds!,
    writes: Object.keys(isJsonObject(node.writes) ? node.writes : {}).sort(),
    conditional: "when" in node,
  };
  // compute.v0: which module and function a node runs, and what it lowers; conversation.v0: the
  // permissions a consent step decides.
  for (const optional of ["task", "tool", "max_output_tokens", "max_items", "max_parallel", "limit", "module", "function", "input_schema", "limits", "permissions"]) {
    if (optional in node) facts[optional] = node[optional]!;
  }
  if (node.type === "map") {
    facts.item_schema = node.item_schema!;
    facts.steps = (node.steps as JsonObject[]).map((step) => {
      const entry: JsonObject = { id: step.id!, type: step.type! };
      for (const key of ["task", "tool", "module", "function"]) if (key in step) entry[key] = step[key]!;
      return entry;
    });
    facts.step_count = (node.steps as JsonValue[]).length;
  }
  return facts;
}

async function workflow(pkg: Package): Promise<WorkflowSummary> {
  const graph = pkg.graph;
  if (!("nodes" in graph)) {
    // An archival profile is still described generically, never executed.
    const stages = (Array.isArray(graph.stages) ? graph.stages : []) as JsonObject[];
    return {
      profile: graph.profile ?? "legacy-host-entrypoint",
      coordinator: graph.coordinator!,
      stage_count: stages.length,
      stages: stages.map((stage) => ({
        id: stage.id!,
        worker: stage.worker!,
        depends_on: [...(stage.depends_on as JsonValue[])],
        parallel: stage.parallel!,
        merge: stage.merge!,
      })),
      edges: stages.flatMap((stage) => (stage.depends_on as JsonValue[]).map((dependency) => ({ from: dependency, to: stage.id! }))),
    };
  }
  const nodes = graph.nodes as JsonObject[];
  const types: Record<string, number> = {};
  for (const node of nodes) types[String(node.type)] = (types[String(node.type)] ?? 0) + 1;
  const sortedTypes: JsonObject = {};
  for (const key of Object.keys(types).sort()) sortedTypes[key] = types[key]!;
  const mapNodes = nodes.filter((node) => node.type === "map");
  const caps: JsonObject = {};
  for (const node of mapNodes) caps[String(node.id)] = node.max_items!;
  const [hints] = presentationHints(pkg);
  return {
    profile: graph.profile!,
    coordinator: graph.coordinator!,
    deadline_seconds: graph.deadline_seconds!,
    input_schema: graph.input_schema!,
    output_schema: graph.output_schema!,
    node_count: nodes.length,
    node_types: sortedTypes,
    entry_nodes: nodes.filter((node) => (node.depends_on as JsonValue[]).length === 0).map((node) => node.id!),
    output_nodes: nodes.filter((node) => node.type === "output").map((node) => node.id!),
    max_declared_parallel: mapNodes.length > 0 ? Math.max(...mapNodes.map((node) => node.max_parallel as number)) : 1,
    map_item_caps: caps,
    edges: nodes.flatMap((node) => (node.depends_on as JsonValue[]).map((dependency) => ({ from: dependency, to: node.id! }))),
    nodes: nodes.map(nodeFacts),
    exports: ((Array.isArray(graph.exports) ? graph.exports : []) as JsonObject[]).map((entry) => ({ path: entry.path!, format: entry.format! })),
    fixture_declared: "fixture" in graph,
    // conversation.v0 (V-20): the turns, the persistent keys, the consent steps and the
    // permissions they decide, for the agent page; null for a one-shot package.
    conversation: conversationRecords(pkg),
    // network.v0 (R-24): the roles, the edges, the caps and the worst case computed from the
    // declaration, for the agent page's "at most"; null for a package without a network.
    network: networkRecords(pkg),
    // The task a person fills in, and the package's cosmetic hints for it.
    input: await inputForm(pkg),
    presentation: hints,
  };
}

async function evals(pkg: Package): Promise<JsonObject[]> {
  const out: JsonObject[] = [];
  for (const declaration of pkg.manifest.evals as JsonObject[]) {
    const document = packageJson(pkg, String(declaration.path));
    const record = isJsonObject(document) ? document : {};
    out.push({
      id: declaration.id!,
      kind: declaration.kind!,
      case_count: Array.isArray(record.cases) ? record.cases.length : 0,
      description: record.description ?? null,
      ...(await fileFacts(pkg, String(declaration.path))),
      verified_by_host: false,
    });
  }
  return out;
}

async function attestations(pkg: Package): Promise<JsonObject[]> {
  const out: JsonObject[] = [];
  for (const path of (pkg.manifest.attestations as JsonValue[]).map(String)) {
    const document = packageJson(pkg, path);
    const keys = isJsonObject(document) ? Object.keys(document).sort().slice(0, MAX_LISTED_KEYS) : [];
    out.push({ ...(await fileFacts(pkg, path)), keys, verified_by_host: false });
  }
  return out;
}

function modelRequirements(pkg: Package): JsonObject {
  const requirements = pkg.manifest.model_requirements as JsonObject;
  return {
    routing: requirements.routing!,
    fallback_policy: requirements.fallback_policy!,
    privacy: requirements.privacy ?? null,
    latency_preference: requirements.latency_preference ?? null,
    cost_sensitivity: requirements.cost_sensitivity ?? null,
    tasks: (requirements.tasks as JsonObject[]).map((task) => ({
      id: task.id!,
      capabilities: [...(task.capabilities as JsonValue[])],
      context_window: task.context_window!,
      preferred_tier: task.preferred_tier ?? null,
    })),
  };
}

async function payload(pkg: Package): Promise<BrowserSummary["payload"]> {
  const files: FileFacts[] = [];
  for (const path of [...pkg.files.keys()].sort()) files.push(await fileFacts(pkg, path));
  return { file_count: files.length, total_bytes: files.reduce((sum, item) => sum + item.bytes, 0), files };
}

/** `summary.py::warnings`: generic, declaration-derived cautions. No application-domain judgments. */
export function warnings(pkg: Package, evaluation: EvaluationLayers, publisher: PublisherReport): Warning[] {
  const found: Warning[] = [];
  const warn = (code: string, severity: Warning["severity"], message: string) => found.push({ code, severity, message });
  const status = publisher.signature_status;
  if (status === "absent") warn("signature_absent", "critical", "This package carries no publisher signature.");
  else if (status === "invalid") {
    warn("signature_invalid", "critical", "The publisher signature does not verify against the key inside the package.");
  }
  const trust = publisher.trust_status;
  if (trust === "unknown") {
    warn(
      "publisher_unknown",
      "warning",
      "The signing key is not pinned in this host's trust store, so the publisher is unverified even when the signature is self-consistent.",
    );
  } else if (trust === "mismatch") {
    warn(
      "publisher_mismatch",
      "critical",
      "The claimed publisher is pinned to a different key, or the pinned key does not cover this package identity.",
    );
  }
  if (evaluation.runtime_status !== "compatible") {
    warn("execution_profile_unsupported", "warning", "No installed execution profile can run this package; inspection only.");
  }
  const policy = pkg.policy;
  const toolList = Object.values(pkg.tools);
  for (const permission of policy.permissions as JsonObject[]) {
    const resources = (permission.resources as JsonValue[]).map(String);
    if (permission.kind === "files.write") {
      warn("requests_file_write_permission", "warning", `The package requests write access to: ${resources.join(", ") || "unspecified resources"}.`);
    }
    const linked = toolList
      .filter((tool) => (tool.permissions as JsonValue[]).includes(permission.id!))
      .map((tool) => String(tool.id))
      .sort();
    if (permission.kind === "payment" && linked.length > 0) {
      // A payment permission that gates declared tools is enforced like any other grant;
      // what this host does not have is payment infrastructure of its own.
      warn(
        "requests_payment_permission",
        "warning",
        `The package requests payment authority (${permission.id}) for ${linked.join(", ")}. This host charges nothing itself: the permission only decides whether those tools may be called.`,
      );
    } else if (permission.kind === "shell" || permission.kind === "payment") {
      warn(`requests_${permission.kind}_permission`, "critical", `The package requests a ${permission.kind} permission, which this host does not implement.`);
    }
    if (permission.kind === "personal.read") {
      // Word for word the reference's (`summary.py`): the parity fixtures compare the text.
      warn(
        "requests_personal_data",
        "warning",
        `The package requests host-owned personal data (${permission.id}: ${resources.join(", ") || "unspecified"}). You choose whether to grant it and which of your resources is shared.`,
      );
    }
    if (permission.kind === "memory.read") {
      warn("requests_memory_read", "warning", `The package requests a record from your memory (${permission.id}: ${resources.join(", ") || "unspecified"}). You choose whether to grant it and which one record is shared.`);
    }
    if (permission.kind === "memory.write") {
      warn("requests_memory_write", "info", `The package may propose things to remember (${permission.id}: ${resources.join(", ") || "unspecified"}). Nothing is written until you accept each proposal after the run.`);
    }
    if (permission.kind === "memory" && resources.length === 1 && resources[0] === "agent") {
      warn("requests_agent_notes", "info", `The package keeps its own notes between runs (${permission.id}, at most 32,768 characters), which you can read and clear in Settings → Memory.`);
    }
    if (permission.kind === "compute") {
      // compute.v0 (C-9): the words the agent page uses, with the hashes a person can compare
      // against the graph; the modules import nothing, so the sentence is exact. The reference's
      // words (`summary.py`) less fuel, which this host does not meter (D-250).
      const hashes = new Map(((pkg.graph.modules as JsonObject[] | undefined) ?? []).map((module) => [String(module.id), String(module.sha256)]));
      const named = resources.map((moduleId) => `${moduleId} (${(hashes.get(moduleId) ?? "undeclared").slice(0, 16)}…)`).join(", ");
      warn("runs_code_that_can_only_compute", "info", `The package runs code that can only compute (${permission.id}): WebAssembly module(s) ${named || "none"}, with no imports, run under this host's memory and time bounds on the data the graph gives them.`);
    }
  }
  const conversation = conversationRecords(pkg);
  if (conversation !== null) {
    // conversation.v0 (V-20): what a person agrees to when they start a conversation, in words:
    // how many turns at most, what is kept between turns, and which steps will ask.
    const steps = conversation.consent_steps.map((step) => `${step.id} (before ${step.permissions.join(", ")})`).join(", ");
    warn("conversational_package", "info", `The package is a conversation of at most ${conversation.budget.max_turns} turns, within ${conversation.budget.hard_tokens} tokens and ${conversation.budget.max_remote_calls} remote calls in all; it keeps ${conversation.persistent_keys.join(", ") || "nothing"} between turns, and asks you before: ${steps || "nothing"}.`);
  }
  const network = networkRecords(pkg);
  if (network !== null) warn("delegation_network", "info", networkSentence(network));
  const remote = toolList.filter((tool) => tool.execution === "remote");
  if (remote.length > 0) {
    const domains = [...new Set(remote.flatMap((tool) => (tool.domains as JsonValue[]).map(String)))].sort();
    warn("remote_tools_declared", "info", `${remote.length} remote tool(s) may contact: ${domains.join(", ")}.`);
  }
  const writers = toolList
    .filter((tool) => tool.side_effects !== "read" || tool.approval_required === true)
    .map((tool) => String(tool.id))
    .sort();
  if (writers.length > 0) {
    warn("side_effecting_tools_declared", "warning", `Tools requiring explicit approval before dispatch: ${writers.join(", ")}.`);
  }
  const memory = policy.memory as JsonObject;
  if (memory.scope !== "session" && memory.scope !== "ephemeral") {
    warn("memory_scope_unsupported", "warning", `Declared memory scope ${JSON.stringify(memory.scope)} is not implemented here.`);
  }
  if ((policy.delegation as JsonObject).allow_remote) warn("remote_delegation_requested", "critical", "Remote delegation is not implemented.");
  if ((pkg.manifest.dependencies as JsonValue[]).length > 0) {
    warn("dependencies_declared", "warning", "Pinned dependencies are declared; no dependency resolver is installed.");
  }
  if ((pkg.manifest.update as JsonObject).locator) {
    warn("update_locator_declared", "info", "An update locator is declared. Updates are never fetched automatically.");
  }
  const [hints, notes] = presentationHints(pkg);
  const extensions = isJsonObject(pkg.graph.extensions) ? pkg.graph.extensions : {};
  if (extensions[EXTENSION_KEY] !== undefined && extensions[EXTENSION_KEY] !== null && notes.length > 0) {
    warn(hints === null ? "presentation_ignored" : "presentation_hints_adjusted", "info", `Some presentation hints were not used: ${notes.join("; ").slice(0, 900)}`);
  }
  if ((pkg.manifest.evals as JsonValue[]).length === 0) warn("no_evals_declared", "info", "The package declares no evaluations.");
  if ((pkg.manifest.attestations as JsonValue[]).length === 0) warn("no_attestations_declared", "info", "The package declares no attestations.");
  return found;
}

/** "A, B and C" (`summary.py::_and`). */
function listed(names: readonly string[]): string {
  return names.length <= 1 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/**
 * The envelope in words (network.v0 R-24, `summary.py::network_sentence`): every figure is the bound
 * computed from the signed declaration, not an estimate. Who picks the next role is the
 * declaration's: the model at a chosen route, the package at a fixed one, and a mixed network says
 * which roles are which.
 */
export function networkSentence(network: NetworkRecords): string {
  const bound = network.worst_case;
  const names = network.roles.map((role) => role.id);
  const activations = network.roles.map((role) => `${role.id} at most ${role.activation_bound} ${role.activation_bound === 1 ? "time" : "times"}`).join(", ");
  const tools = Object.keys(bound.tool_calls)
    .sort()
    .map((tool) => `${tool} ${bound.tool_calls[tool]}`)
    .join(", ");
  const chosen = network.roles.filter((role) => role.route.kind === "chosen").map((role) => role.id);
  const fixed = network.roles.filter((role) => role.route.kind !== "chosen").map((role) => role.id);
  const lead =
    chosen.length > 0 && fixed.length > 0
      ? `The package delegates between ${names.length} roles (${names.join(", ")}), the next role chosen by the model after ${listed(chosen)} and fixed by the package after ${listed(fixed)}`
      : `The package delegates between ${names.length} roles ${chosen.length > 0 ? "chosen by the model while it runs" : "along handoffs the package fixed"} (${names.join(", ")})`;
  const toolTotal = Object.values(bound.tool_calls).reduce((sum, count) => sum + count, 0);
  return (
    `${lead}, within a declared envelope: at most ${bound.max_hops} handoffs; ${activations}; at most ${bound.model_calls} model calls, ${toolTotal} tool calls` +
    (tools ? ` (${tools})` : "") +
    `, ${bound.remote_calls} remote calls and ${bound.tokens} tokens in all; each role sees only its declared part of the shared state, and every handoff is recorded with the reason it was allowed.`
  );
}

/** `build_summary`: the stable JSON a shell renders without domain knowledge. */
export async function buildSummary(pkg: Package, options: { evaluation: EvaluationLayers; publisher: PublisherReport }): Promise<BrowserSummary> {
  const manifest = pkg.manifest;
  const policy = permissionsSummary(pkg);
  const copy = <T extends JsonValue>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
  return {
    schema: SUMMARY_SCHEMA,
    package: {
      spec_version: manifest.spec_version!,
      package_id: manifest.package_id!,
      name: manifest.name!,
      version: manifest.version!,
      description: manifest.description!,
      created_at: manifest.created_at!,
      digest: pkg.digest,
      entrypoint: manifest.entrypoint!,
      execution_profile: pkg.graph.profile ?? manifest.entrypoint!,
      runtime: { ...(manifest.runtime as JsonObject) },
      update: { ...(manifest.update as JsonObject) },
      dependencies: [...(manifest.dependencies as JsonValue[])],
      extension_keys: Object.keys(isJsonObject(manifest.extensions) ? manifest.extensions : {})
        .sort()
        .slice(0, MAX_LISTED_KEYS),
    },
    validation: options.evaluation,
    publisher: options.publisher,
    capabilities: (manifest.capabilities as JsonValue[]).map(String),
    skills: await skills(pkg),
    tools: tools(pkg),
    workers: workers(pkg),
    workflow: await workflow(pkg),
    model_requirements: modelRequirements(pkg),
    evals: await evals(pkg),
    attestations: await attestations(pkg),
    // Copied: a caller must not be able to mutate the loaded package policy.
    policy: copy({
      permissions: policy.permissions!,
      network: policy.network!,
      memory: policy.memory!,
      budget: policy.budget!,
      delegation: policy.delegation!,
    }),
    payload: await payload(pkg),
    warnings: warnings(pkg, options.evaluation, options.publisher),
  };
}
