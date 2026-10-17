/**
 * What a package may declare about compute, checked at validation (compute.v0 §2, C-1…C-9,
 * C-11…C-18, C-20), before any host compiles anything: `agentpkg/compute/declarations.py`.
 *
 * Refusals are `ValidationError`s whose text starts with the specification's code, so that both
 * runtimes refuse a package with the same message (the conformance suite compares refusals).
 */
import { ValidationError } from "../errors.js";
import { sha256HexSync } from "../hash.js";
import type { JsonObject, JsonValue } from "../json.js";
import { pyRepr } from "../repr.js";
import { compareRelease } from "../version.js";
import { checkModule, MAX_MODULE_BYTES, ModuleError, moduleFactsJson, type ModuleFacts } from "./module.js";

export const COMPUTE_MINIMUM_VERSION = "0.5.0";
export const MAX_MODULES = 16;
export const MODULE_SUFFIX = ".wasm";
export const PERMISSION_KIND = "compute";
/** Decoded modules by SHA-256 and the functions asked for: validation, the preflight, the execution host and the agent page each need the facts, and decoding is the same work each time. */
const FACTS = new Map<string, ModuleFacts>();
const FACTS_KEPT = 64;

function refuse(code: string, message: string): ValidationError {
  return new ValidationError(`${code}: ${message}`);
}

/** `checkModule`, decoding each module once per process; a refusal is never kept. */
export function checkedModule(data: Uint8Array, functions: readonly string[]): ModuleFacts {
  const key = `${sha256HexSync(data)}:${functions.join(",")}`;
  const cached = FACTS.get(key);
  if (cached !== undefined) return cached;
  const facts = checkModule(data, functions);
  if (FACTS.size >= FACTS_KEPT) FACTS.delete(FACTS.keys().next().value!);
  FACTS.set(key, facts);
  return facts;
}

export function moduleMembers(files: ReadonlyMap<string, Uint8Array>): string[] {
  return [...files.keys()].filter((name) => name.toLowerCase().endsWith(MODULE_SUFFIX)).sort();
}

/** Every compute node and every compute map step, with its qualified identity. */
export function computeOperations(graph: JsonObject): Array<[string, JsonObject]> {
  const found: Array<[string, JsonObject]> = [];
  for (const node of (graph.nodes as JsonObject[] | undefined) ?? []) {
    if (node.type === "compute") found.push([String(node.id), node]);
    for (const step of (node.steps as JsonObject[] | undefined) ?? []) {
      if (step.type === "compute") found.push([`${node.id}/${step.id}`, step]);
    }
  }
  return found;
}

const pyList = (items: readonly string[]): string => `[${items.map((item) => pyRepr(item)).join(", ")}]`;

/**
 * The graph's modules against the members, the nodes and the permission; returns the facts of
 * each accepted module by id. A package that declares none of it returns an empty record.
 */
export function checkComputeDeclarations(manifest: JsonObject, graph: JsonObject, policy: JsonObject, files: ReadonlyMap<string, Uint8Array>): Record<string, ModuleFacts> {
  const modules = (graph.modules as JsonObject[] | undefined) ?? [];
  const operations = computeOperations(graph);
  const members = moduleMembers(files);
  const permissions = ((policy.permissions as JsonObject[] | undefined) ?? []).filter((permission) => permission.kind === PERMISSION_KIND);
  if (modules.length === 0 && operations.length === 0 && members.length === 0 && permissions.length === 0) return {};
  if (compareRelease(String((manifest.runtime as JsonObject).minimum_version), COMPUTE_MINIMUM_VERSION) < 0) {
    throw refuse("compute_minimum_version", `compute nodes require runtime.minimum_version ${COMPUTE_MINIMUM_VERSION} or later`);
  }
  if (modules.length > MAX_MODULES) throw refuse("module_count", `a graph declares at most ${MAX_MODULES} modules`);
  const declared = new Map<string, JsonObject>();
  for (const module of modules) {
    const id = String(module.id);
    const path = String(module.path);
    if (declared.has(id)) throw refuse("module_duplicate", `module ${pyRepr(id)} is declared twice`);
    if ([...declared.values()].some((other) => other.path === path)) throw refuse("module_duplicate", `member ${pyRepr(path)} is declared as two modules`);
    const data = files.get(path);
    if (data === undefined) throw refuse("module_file_missing", `module ${pyRepr(id)}: no member ${pyRepr(path)}`);
    if (data.length > MAX_MODULE_BYTES) throw refuse("module_too_large", `module ${pyRepr(id)}: ${data.length} bytes; a module is at most ${MAX_MODULE_BYTES}`);
    const actual = sha256HexSync(data);
    if (actual !== module.sha256) throw refuse("module_hash_mismatch", `module ${pyRepr(id)}: ${path} has SHA-256 ${actual}, the graph declares ${String(module.sha256)}`);
    declared.set(id, module);
  }
  const declaredPaths = new Set([...declared.values()].map((module) => String(module.path)));
  const undeclared = members.filter((member) => !declaredPaths.has(member)).sort();
  if (undeclared.length > 0) throw refuse("module_undeclared", `member ${pyRepr(undeclared[0]!)} is a WebAssembly module the graph does not declare`);
  const functions = new Map<string, string[]>();
  for (const [name, operation] of operations) {
    const moduleId = String(operation.module);
    if (!declared.has(moduleId)) throw refuse("module_unknown", `node ${name}: module ${pyRepr(moduleId)} is not declared`);
    const names = functions.get(moduleId) ?? [];
    if (!names.includes(String(operation.function))) names.push(String(operation.function));
    functions.set(moduleId, names);
  }
  const unused = [...declared.keys()].filter((id) => !functions.has(id)).sort();
  if (unused.length > 0) throw refuse("module_unused", `module ${pyRepr(unused[0]!)} is declared and no node runs it`);
  const facts: Record<string, ModuleFacts> = {};
  for (const [moduleId, module] of declared) {
    try {
      facts[moduleId] = checkedModule(files.get(String(module.path))!, functions.get(moduleId)!);
    } catch (error) {
      if (error instanceof ModuleError) throw refuse(error.code, `module ${pyRepr(moduleId)}: ${error.reason}`);
      throw error;
    }
  }
  for (const [name, operation] of operations) {
    const limits = (operation.limits as JsonObject | null | undefined) ?? {};
    const maximum = facts[String(operation.module)]!.memory_max_pages;
    const pages = typeof limits.memory_pages === "number" ? limits.memory_pages : maximum;
    if (pages < maximum) throw refuse("compute_limits_below_module", `node ${name}: limits.memory_pages ${pages} is below the module's declared maximum of ${maximum} pages`);
  }
  if (permissions.length === 0) throw refuse("compute_permission_missing", "a graph with compute nodes declares one permission of kind compute naming its modules");
  if (permissions.length > 1) throw refuse("compute_permission_duplicate", "a package declares at most one compute permission");
  const permission = permissions[0]!;
  if (declared.size === 0) throw refuse("compute_permission_unused", `permission ${pyRepr(String(permission.id))} is declared and the graph runs no module`);
  const resources = ((permission.resources as JsonValue[] | undefined) ?? []).map(String);
  const declaredIds = [...declared.keys()].sort();
  if (new Set(resources).size !== declaredIds.length || !declaredIds.every((id) => resources.includes(id))) {
    throw refuse("compute_permission_resources", `permission ${pyRepr(String(permission.id))} must name exactly the declared modules ${pyList(declaredIds)}, not ${pyList([...resources].sort())}`);
  }
  return facts;
}

/** A validated package's module facts, by id (what the runtime and the agent page need; validation has accepted every module). */
export function moduleFacts(pkg: { graph: JsonObject; files: ReadonlyMap<string, Uint8Array> }): Record<string, ModuleFacts> {
  const functions = new Map<string, string[]>();
  for (const [, operation] of computeOperations(pkg.graph)) {
    const names = functions.get(String(operation.module)) ?? [];
    if (!names.includes(String(operation.function))) names.push(String(operation.function));
    functions.set(String(operation.module), names);
  }
  const facts: Record<string, ModuleFacts> = {};
  for (const module of (pkg.graph.modules as JsonObject[] | undefined) ?? []) {
    facts[String(module.id)] = checkedModule(pkg.files.get(String(module.path))!, functions.get(String(module.id)) ?? []);
  }
  return facts;
}

/** The modules as `inspect` and the agent page list them: id, path, hash, memory, functions. */
export function moduleRecords(pkg: { graph: JsonObject; files: ReadonlyMap<string, Uint8Array> }): JsonObject[] {
  const facts = moduleFacts(pkg);
  return ((pkg.graph.modules as JsonObject[] | undefined) ?? []).map((module) => ({ id: module.id!, path: module.path!, ...moduleFactsJson(facts[String(module.id)]!) }));
}
