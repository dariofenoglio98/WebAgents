/**
 * Package-wide schema and semantic validation, mirroring `agentpkg/validation.py`.
 *
 * `validatePayload` is the schema layer of the control plane: every manifest-declared
 * document is checked against agentpkg's own schema, every cross-reference is resolved, and
 * the package's own JSON Schemas are checked offline (draft 2020-12 meta-schema, no `$id`,
 * no dynamic references, package-relative `$ref` only). Workflow graphs then go through the
 * static checks in `workflow-static.ts`. Messages follow the reference's wording so the two
 * runtimes refuse the same packages for the same stated reasons.
 */
import { ValidationError } from "./errors.js";
import { isJsonObject, parseJson, type JsonObject, type JsonValue } from "./json.js";
import { checkMemoryGraph, memoryDeclarations } from "./memory/declarations.js";
import { schemaReference, unique } from "./references.js";
import { pyRepr } from "./repr.js";
import { checkSchema, validateDocument } from "./schema.js";
import { urlsplit } from "./urls.js";
import { compareRelease, SUPPORTED_RUNTIME_VERSION } from "./version.js";
import { validateWorkflow } from "./workflow-static.js";

export interface ValidatedPayload {
  readonly manifest: JsonObject;
  readonly graph: JsonObject;
  readonly policy: JsonObject;
  readonly tools: Record<string, JsonObject>;
}

const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;

/** `validation.py::_domain`: an exact, lowercase, public DNS name. */
export function checkDomain(value: unknown): void {
  const shown = pyRepr(value);
  if (typeof value !== "string" || value.length > 253 || value !== value.toLowerCase() || !value.includes(".")) {
    throw new ValidationError(`invalid explicit network domain ${shown}`);
  }
  const labels = value.split(".");
  if (!labels.every((label) => LABEL.test(label))) {
    throw new ValidationError(`invalid explicit network domain ${shown}; no wildcards, ports or URLs`);
  }
  if (labels.every((label) => /^[0-9]+$/u.test(label)) || value.endsWith(".localhost") || value.endsWith(".local")) {
    throw new ValidationError(`network domain must be a public DNS name: ${shown}`);
  }
}

function resolveFragment(document: JsonValue, fragment: string, path: string): JsonValue {
  let current: JsonValue = document;
  for (const raw of fragment.slice(1).split("/")) {
    const token = raw.replace(/~1/gu, "/").replace(/~0/gu, "~");
    if (Array.isArray(current)) {
      if (!/^-?[0-9]+$/u.test(token)) throw new ValidationError(`${path}: unresolved schema fragment #${fragment}`);
      const index = Number(token);
      const item = current[index < 0 ? current.length + index : index];
      if (item === undefined) throw new ValidationError(`${path}: unresolved schema fragment #${fragment}`);
      current = item;
    } else if (isJsonObject(current) && Object.prototype.hasOwnProperty.call(current, token)) {
      current = current[token]!;
    } else {
      throw new ValidationError(`${path}: unresolved schema fragment #${fragment}`);
    }
  }
  return current;
}

/** `validation.py::_walk_schema`. */
export function walkSchema(value: JsonValue, path: string, documents: Map<string, JsonValue>): void {
  if (isJsonObject(value)) {
    if ("$id" in value) throw new ValidationError(`${path}: $id is unsupported in package schemas; use relative $ref`);
    if ("$schema" in value && value.$schema !== "https://json-schema.org/draft/2020-12/schema") {
      throw new ValidationError(`${path}: schemas must use draft 2020-12`);
    }
    if ("$dynamicRef" in value || "$recursiveRef" in value || "$vocabulary" in value) {
      throw new ValidationError(`${path}: dynamic references and custom vocabularies unsupported in v0`);
    }
    if ("$ref" in value) {
      const [target, fragment] = schemaReference(path, String(value.$ref));
      if (!documents.has(target)) {
        throw new ValidationError(`${path}: missing or undeclared schema reference ${pyRepr(target)}`);
      }
      let current: JsonValue = documents.get(target)!;
      if (fragment) {
        if (!fragment.startsWith("/")) throw new ValidationError(`${path}: schema references require JSON Pointer fragments`);
        current = resolveFragment(current, fragment, path);
      }
      if (!(isJsonObject(current) || typeof current === "boolean")) {
        throw new ValidationError(`${path}: schema reference does not point to a schema`);
      }
    }
    for (const child of Object.values(value)) walkSchema(child, path, documents);
  } else if (Array.isArray(value)) {
    for (const child of value) walkSchema(child, path, documents);
  }
}

/** `validation.py::validate_payload`. */
export async function validatePayload(files: ReadonlyMap<string, Uint8Array>): Promise<ValidatedPayload> {
  const document = async (path: string, kind?: string): Promise<JsonValue> => {
    const data = files.get(path);
    if (data === undefined) throw new ValidationError(`missing referenced package member: ${path}`);
    const value = parseJson(data, path);
    if (kind) await validateDocument(value, kind, path);
    return value;
  };
  const object = async (path: string, kind?: string): Promise<JsonObject> => (await document(path, kind)) as JsonObject;

  const manifest = await object("MANIFEST.agent", "manifest");
  const runtime = manifest.runtime as JsonObject;
  if (compareRelease(String(runtime.minimum_version), SUPPORTED_RUNTIME_VERSION) > 0) {
    throw new ValidationError(`manifest runtime.minimum_version exceeds reference runtime ${SUPPORTED_RUNTIME_VERSION}`);
  }
  const workflow = manifest.entrypoint === "workflow.v0";
  const graph = await object(String(manifest.graph), workflow ? "workflow" : "graph");
  const policy = await object(String(manifest.policy), "policy");
  const skills = unique(manifest.skills as JsonValue[], "skills");
  const schemas = unique(manifest.schemas as JsonValue[], "schemas");
  const declarations = unique(manifest.tools as JsonValue[], "tools");
  const evaluations = unique(manifest.evals as JsonValue[], "evals");
  unique((manifest.model_requirements as JsonObject).tasks as JsonValue[], "model tasks");

  const declaredPaths: string[] = [
    String(manifest.graph),
    String(manifest.policy),
    ...[skills, schemas, declarations, evaluations].flatMap((entries) => [...entries.values()].map((entry) => String(entry.path))),
    ...(manifest.attestations as JsonValue[]).map(String),
  ];
  if (new Set(declaredPaths).size !== declaredPaths.length) {
    throw new ValidationError("each manifest document path must have exactly one declared role");
  }
  for (const path of declaredPaths) {
    if (!files.has(path)) throw new ValidationError(`missing referenced package member: ${path}`);
  }
  for (const skill of skills.values()) {
    if (!String(skill.path).endsWith(".md")) {
      throw new ValidationError(`skill ${skill.id}: path must be a Markdown instruction file`);
    }
  }
  const schemaPaths = new Set([...schemas.values()].map((entry) => String(entry.path)));
  const documents = new Map<string, JsonValue>();
  for (const path of schemaPaths) documents.set(path, await document(path));
  for (const [path, schema] of documents) {
    await checkSchema(schema, path);
    walkSchema(schema, path, documents);
  }

  const permissions = unique(policy.permissions as JsonValue[], "permissions");
  const network = policy.network as JsonObject;
  const domains = new Set((network.allowed_domains as JsonValue[]).map(String));
  for (const domain of domains) checkDomain(domain);
  const memory = policy.memory as JsonObject;
  if (!schemaPaths.has(String(memory.state_schema))) {
    throw new ValidationError("memory.state_schema must reference a declared schema");
  }
  const stateSchema = documents.get(String(memory.state_schema));
  if (!isJsonObject(stateSchema) || stateSchema.type !== "object") {
    throw new ValidationError("state schema must declare type object and top-level properties");
  }
  const stateKeys = new Set(Object.keys(isJsonObject(stateSchema.properties) ? stateSchema.properties : {}));

  const tools: Record<string, JsonObject> = {};
  for (const [toolId, declaration] of declarations) {
    const tool = await object(String(declaration.path), "tool");
    if (tool.id !== toolId) {
      throw new ValidationError(`tool id mismatch: manifest ${pyRepr(toolId)} vs document ${pyRepr(tool.id)}`);
    }
    for (const field of ["input_schema", "output_schema"] as const) {
      if (!schemaPaths.has(String(tool[field]))) {
        throw new ValidationError(`tool ${toolId}: ${field} must reference a declared schema`);
      }
    }
    for (const permissionId of tool.permissions as JsonValue[]) {
      if (!permissions.has(String(permissionId))) {
        throw new ValidationError(`tool ${toolId}: unknown permission ${pyRepr(permissionId)}`);
      }
    }
    const toolDomains = (tool.domains as JsonValue[]).map(String);
    for (const domain of toolDomains) {
      checkDomain(domain);
      if (!domains.has(domain)) throw new ValidationError(`tool ${toolId}: domain ${domain} absent from policy allowlist`);
    }
    if (tool.execution === "remote") {
      let endpoint;
      try {
        endpoint = urlsplit(String(tool.endpoint ?? ""));
      } catch {
        endpoint = null;
      }
      if (
        endpoint === null ||
        endpoint.scheme !== "https" ||
        endpoint.hostname === null ||
        endpoint.username ||
        endpoint.password ||
        endpoint.portError ||
        (endpoint.port !== null && endpoint.port !== 443) ||
        endpoint.fragment
      ) {
        throw new ValidationError(`tool ${toolId}: remote endpoint must be credential-free HTTPS on port 443`);
      }
      if (!toolDomains.includes(endpoint.hostname) || tool.method === null) {
        throw new ValidationError(`tool ${toolId}: endpoint domain/method not declared`);
      }
      const grants = (tool.permissions as JsonValue[])
        .map((permissionId) => permissions.get(String(permissionId))!)
        .filter((grant) => grant.kind === "network");
      const covered = (domain: string) => grants.some((grant) => (grant.resources as JsonValue[]).includes(domain));
      if (toolDomains.some((domain) => !covered(domain))) {
        throw new ValidationError(`tool ${toolId}: domains must have linked network permissions`);
      }
    } else if (tool.execution === "local" && (tool.endpoint !== null || tool.method !== null || toolDomains.length > 0)) {
      throw new ValidationError(`tool ${toolId}: local tools cannot declare endpoints or domains`);
    }
    if (tool.side_effects === "write" && tool.approval_required !== true) {
      throw new ValidationError(`tool ${toolId}: write side effects require approval_required=true`);
    }
    tools[toolId] = tool;
  }
  for (const permission of permissions.values()) {
    if (permission.kind === "network") {
      for (const domain of (permission.resources as JsonValue[]).map(String)) {
        checkDomain(domain);
        if (!domains.has(domain)) {
          throw new ValidationError(`network permission ${permission.id}: domain absent from allowlist`);
        }
      }
    }
  }
  // The memory declarations (memory.v0 §7, M-33, M-38, M-48, M-18, M-67): checked here so that
  // both runtimes refuse the same packages before any host binds anything.
  const memoryDeclared = memoryDeclarations(manifest, policy, tools, files);
  const budget = policy.budget as JsonObject;
  if ((budget.estimated_tokens as number) > (budget.hard_tokens as number)) {
    throw new ValidationError("estimated_tokens cannot exceed hard_tokens");
  }
  if (budget.approval_threshold_tokens !== null && (budget.approval_threshold_tokens as number) > (budget.hard_tokens as number)) {
    throw new ValidationError("approval_threshold_tokens cannot exceed hard_tokens");
  }
  const perTool = new Set(Object.keys(budget.max_calls_per_tool as JsonObject));
  const toolIds = new Set(Object.keys(tools));
  if (perTool.size !== toolIds.size || [...perTool].some((id) => !toolIds.has(id))) {
    throw new ValidationError("max_calls_per_tool must declare exactly every tool id");
  }
  const workers = unique(graph.workers as JsonValue[], "workers");
  const coordinator = String(graph.coordinator);
  if (!workers.has(coordinator)) throw new ValidationError("graph coordinator must be a declared worker");
  if (workers.get(coordinator)!.max_instances !== 1) throw new ValidationError("coordinator max_instances must be 1");
  const delegation = policy.delegation as JsonObject;
  const approved = new Set((delegation.approved_roles as JsonValue[]).map(String));
  const nonCoordinator = new Set([...workers.keys()].filter((role) => role !== coordinator));
  if (approved.size !== nonCoordinator.size || [...approved].some((role) => !nonCoordinator.has(role))) {
    throw new ValidationError("delegation approved_roles must exactly match non-coordinator graph workers");
  }
  for (const [role, worker] of workers) {
    for (const [field, declared] of [
      ["skills", new Set(skills.keys())],
      ["tools", toolIds],
    ] as const) {
      const unknown = (worker[field] as JsonValue[]).map(String).filter((id) => !declared.has(id)).sort();
      if (unknown.length > 0) {
        throw new ValidationError(`worker ${role}: unknown ${field}: ${pyRepr(unknown)}`);
      }
    }
    const workerBudget = worker.budget as JsonObject;
    if (
      (workerBudget.tokens as number) > (budget.hard_tokens as number) ||
      (workerBudget.remote_calls as number) > (budget.max_remote_calls as number)
    ) {
      throw new ValidationError(`worker ${role}: worker budgets cannot exceed package budgets`);
    }
    if ((worker.max_instances as number) > (budget.max_parallel_workers as number)) {
      throw new ValidationError(`worker ${role}: max_instances exceeds max_parallel_workers`);
    }
    const view = [...(worker.state_read as JsonValue[]), ...(worker.state_write as JsonValue[])].map(String);
    if (view.some((key) => !stateKeys.has(key))) {
      throw new ValidationError(`worker ${role}: state view refers to keys absent from state schema`);
    }
  }
  checkMemoryGraph(manifest, graph, memoryDeclared);
  if (workflow) {
    await validateWorkflow(manifest, graph, policy, tools, files);
  } else {
    const stages = unique(graph.stages as JsonValue[], "stages");
    for (const stage of stages.values()) {
      if (!workers.has(String(stage.worker))) throw new ValidationError(`stage ${stage.id}: unknown worker`);
      if ((stage.depends_on as JsonValue[]).some((dependency) => !stages.has(String(dependency)))) {
        throw new ValidationError(`stage ${stage.id}: unknown dependency`);
      }
    }
    const visited = new Set<string>();
    const visiting = new Set<string>();
    const visit = (stage: string): void => {
      if (visiting.has(stage)) throw new ValidationError(`cyclic stage dependency involving ${stage}`);
      if (visited.has(stage)) return;
      visiting.add(stage);
      for (const dependency of stages.get(stage)!.depends_on as JsonValue[]) visit(String(dependency));
      visiting.delete(stage);
      visited.add(stage);
    };
    for (const stage of stages.keys()) visit(stage);
  }
  for (const [evalId, declaration] of evaluations) {
    const evaluation = await object(String(declaration.path), "eval");
    if (evaluation.id !== evalId) throw new ValidationError(`eval id mismatch: ${evalId}`);
    unique(evaluation.cases as JsonValue[], `eval ${evalId} cases`);
  }
  for (const path of (manifest.attestations as JsonValue[]).map(String)) {
    if (!isJsonObject(await document(path))) throw new ValidationError(`${path}: attestation must be a JSON object`);
  }
  return { manifest, graph, policy, tools };
}
