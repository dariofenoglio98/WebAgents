/**
 * What this host can run for a declared tool (`tool-registry.ts`), and how it says so.
 *
 * A definition is a host statement, never a package one: nothing in an `.agent.pkg` adds an
 * entry here, and a package naming an origin no definition names cannot run. Four categories,
 * not a service list: `json_http` (one exact HTTPS request to one configured origin, path and
 * method), `local_builtin` (ships with the host, no I/O), `selected_file` (reads one file the
 * person selected; T6) and `host_resource` (returns the one host-owned resource of its type the
 * person granted). An operator bindings file (`openclaw-host-tool-bindings-v0`, the format the
 * WebAir demo already publishes) adds `json_http` entries of the plain JSON POST adapter and
 * can add nothing else.
 *
 * `describeDefinition` projects a definition into the service-neutral descriptor the control
 * plane evaluates, and `bindingDigest` is `agentpkg.browser.hosttools.binding_digest` over
 * it: what the binding would do, excluding liveness and presentation, with `credentials.
 * configured` a boolean so a secret is never hashed. Both are checked against vectors the
 * frozen plugin and the Python control plane produced.
 */
import { canonicalJson } from "../canonical.js";
import { sha256HexSync } from "../hash.js";
import type { JsonObject, JsonValue } from "../json.js";
import { AdapterError } from "../workflow/errors.js";

export const BINDING_DIGEST_SCHEMA = "agentpkg-tool-binding-digest-v0";
export const OPERATOR_BINDINGS_SCHEMA = "openclaw-host-tool-bindings-v0";
export const MAX_OPERATOR_BINDINGS = 32;
export const MAX_DEFINITIONS = 64;
/** The one implementation an operator entry can name, and its code version. */
export const OPERATOR_IMPLEMENTATION = Object.freeze({ id: "openclaw.tool.json_http", version: "0.1.0" });
export const DEFAULT_MAX_REQUEST_BYTES = 16 * 1024;
export const DEFAULT_MAX_RESPONSE_BYTES = 512 * 1024;
export const DEFAULT_MAX_CONCURRENT = 4;

export type ToolImplementationKind = "json_http" | "local_builtin" | "selected_file" | "host_resource";

export interface CredentialSource {
  kind: "env" | "settings";
  name: string;
}

export interface ToolImplementationDefinition {
  id: string;
  toolId: string;
  /** The abstract capability name the package asks for. */
  binding: string;
  kind: ToolImplementationKind;
  implementationId: string;
  implementationVersion: string;
  displayName: string;
  description?: string;
  /** Required for `json_http`, forbidden for the local categories. */
  origin?: string;
  path?: string;
  method?: "GET" | "POST";
  inputSchemaSha256: string | null;
  outputSchemaSha256: string | null;
  permissionKinds: string[];
  sideEffects: "read" | "write";
  timeoutSeconds: number;
  maxRequestBytes?: number;
  maxResponseBytes?: number;
  maxConcurrent?: number;
  minIntervalMs?: number;
  credential?: CredentialSource;
  enabled?: boolean;
  /** Required for `host_resource`: the resource type this binding returns. */
  resourceType?: string;
}

/** The descriptor the control plane evaluates (`agentpkg-host-tool-registry-v0` binding entry). */
export interface ToolBindingDescriptor {
  id: string;
  tool_id: string;
  binding: string;
  implementation_kind: ToolImplementationKind;
  implementation_id: string;
  implementation_version: string;
  display_name: string;
  description: string | null;
  remote: boolean;
  available: boolean;
  availability_reason: string | null;
  enabled: boolean;
  endpoint: { origin: string; path: string; method: "GET" | "POST" } | null;
  contract: { input_schema_sha256: string | null; output_schema_sha256: string | null; permission_kinds: string[]; side_effects: "read" | "write" };
  limits: { timeout_seconds: number; max_request_bytes: number; max_response_bytes: number; max_concurrent: number; min_interval_ms: number | null };
  credentials: { required: boolean; configured: boolean; source: string | null };
  resource_type?: string;
}

function refuse(detail: string): AdapterError {
  return new AdapterError("tool_bindings_invalid", `Tool bindings rejected: ${detail}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** One HTTPS origin, port 443, no credentials, no path, no query; lower-cased host. */
export function safeOrigin(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0 || value.length > 256) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || !url.hostname || url.username || url.password || (url.port && url.port !== "443") || (url.pathname !== "" && url.pathname !== "/") || url.search || url.hash) {
    return null;
  }
  return `https://${url.hostname}`;
}

export function safePath(value: unknown): string | null {
  if (typeof value !== "string" || !value.startsWith("/") || value.length > 256) return null;
  if (value.includes("?") || value.includes("#") || value.includes("..")) return null;
  return value;
}

const OPERATOR_FIELDS = ["id", "tool_id", "binding", "implementation_id", "display_name", "description", "endpoint", "input_schema_sha256", "output_schema_sha256", "permission_kinds", "side_effects", "timeout_seconds", "max_request_bytes", "max_response_bytes", "max_concurrent", "min_interval_ms"];
const OPERATOR_OPTIONAL = new Set(["description", "max_request_bytes", "max_response_bytes", "max_concurrent", "min_interval_ms"]);
const BINDING_ID = /^[a-z][a-z0-9-]{0,31}:[A-Za-z0-9._-]{1,128}:[0-9]{1,6}$/u;
const NAME = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u;
const KIND = /^[a-z][a-z0-9_.]{0,63}$/u;
const HEX64 = /^[0-9a-f]{64}$/u;
const CONTROL = /[\u0000-\u001f\u007f]/u;

function closedRecord(value: unknown, field: string, allowed: readonly string[], required: readonly string[]): Record<string, unknown> {
  if (!isRecord(value)) throw refuse(`${field} must be an object`);
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw refuse(`${field} has an unknown field ${key.slice(0, 64)}`);
  for (const key of required) if (!(key in value)) throw refuse(`${field} is missing ${key}`);
  return value;
}

function boundedText(value: unknown, field: string, max: number, pattern?: RegExp): string {
  if (typeof value !== "string" || value.length === 0 || value.length > max || CONTROL.test(value)) {
    throw refuse(`${field} must be a string of 1 to ${max} characters without control characters`);
  }
  if (pattern && !pattern.test(value)) throw refuse(`${field} is not a valid identifier`);
  return value;
}

function boundedInteger(value: unknown, field: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) throw refuse(`${field} must be an integer from ${min} to ${max}`);
  return value;
}

/**
 * Validate an operator's bindings document into definitions. All or nothing: one bad entry
 * rejects the document. Every entry is the plain JSON POST adapter, so what an operator states
 * is *where* (one exact HTTPS origin and path) and *what contract* (schema digests, permission
 * kinds, side effects, bounds), never how a request is shaped. An entry may not reuse an id, a
 * tool id or a binding name this host already serves.
 */
export function parseOperatorBindings(document: unknown, existing: readonly ToolImplementationDefinition[] = []): ToolImplementationDefinition[] {
  const root = closedRecord(document, "tool bindings", ["schema", "bindings"], ["schema", "bindings"]);
  if (root.schema !== OPERATOR_BINDINGS_SCHEMA) throw refuse(`tool bindings schema must be ${OPERATOR_BINDINGS_SCHEMA}`);
  if (!Array.isArray(root.bindings) || root.bindings.length > MAX_OPERATOR_BINDINGS) throw refuse(`bindings must be a list of at most ${MAX_OPERATOR_BINDINGS}`);
  const ids = new Set(existing.map((item) => item.id));
  const toolIds = new Set(existing.map((item) => item.toolId));
  const names = new Set(existing.map((item) => item.binding));
  return root.bindings.map((raw, index) => {
    const field = `bindings[${index}]`;
    const entry = closedRecord(raw, field, OPERATOR_FIELDS, OPERATOR_FIELDS.filter((name) => !OPERATOR_OPTIONAL.has(name)));
    const id = boundedText(entry.id, `${field}.id`, 176, BINDING_ID);
    if (id.startsWith("openclaw:") || id.startsWith("chrome:")) throw refuse(`${field}.id must not use a host's own namespace`);
    const toolId = boundedText(entry.tool_id, `${field}.tool_id`, 128, NAME);
    const binding = boundedText(entry.binding, `${field}.binding`, 128, NAME);
    if (binding.startsWith("host.resource.")) throw refuse(`${field}.binding must not use the host.resource. names of host-held resources`);
    if (ids.has(id)) throw refuse(`${field}.id is already registered on this host`);
    if (toolIds.has(toolId)) throw refuse(`${field}.tool_id is already served by another binding on this host`);
    if (names.has(binding)) throw refuse(`${field}.binding is already served by another binding on this host`);
    ids.add(id);
    toolIds.add(toolId);
    names.add(binding);
    if (entry.implementation_id !== OPERATOR_IMPLEMENTATION.id) {
      throw refuse(`${field}.implementation_id must be ${OPERATOR_IMPLEMENTATION.id}: an operator entry cannot name another adapter or a local implementation`);
    }
    const endpoint = closedRecord(entry.endpoint, `${field}.endpoint`, ["origin", "path", "method"], ["origin", "path", "method"]);
    const origin = safeOrigin(endpoint.origin);
    if (!origin) throw refuse(`${field}.endpoint.origin must be an https origin on port 443 with no path or credentials`);
    const path = safePath(endpoint.path);
    if (!path) throw refuse(`${field}.endpoint.path must be an absolute path with no query, fragment or '..'`);
    // The JSON adapter's contract is one JSON request body; a GET would drop every argument.
    if (endpoint.method !== "POST") throw refuse(`${field}.endpoint.method must be POST`);
    const digest = (value: unknown, name: string): string => {
      if (typeof value !== "string" || !HEX64.test(value)) throw refuse(`${field}.${name} must be 64 lowercase hex characters`);
      return value;
    };
    if (!Array.isArray(entry.permission_kinds) || entry.permission_kinds.length === 0 || entry.permission_kinds.length > 16) {
      throw refuse(`${field}.permission_kinds must list 1 to 16 permission kinds`);
    }
    const kinds = entry.permission_kinds.map((kind, at) => boundedText(kind, `${field}.permission_kinds[${at}]`, 64, KIND));
    if (new Set(kinds).size !== kinds.length) throw refuse(`${field}.permission_kinds has a duplicate`);
    if (entry.side_effects !== "read" && entry.side_effects !== "write") throw refuse(`${field}.side_effects must be read or write`);
    const definition: ToolImplementationDefinition = {
      id,
      toolId,
      binding,
      kind: "json_http",
      implementationId: OPERATOR_IMPLEMENTATION.id,
      implementationVersion: OPERATOR_IMPLEMENTATION.version,
      displayName: boundedText(entry.display_name, `${field}.display_name`, 200),
      origin,
      path,
      method: "POST",
      inputSchemaSha256: digest(entry.input_schema_sha256, "input_schema_sha256"),
      outputSchemaSha256: digest(entry.output_schema_sha256, "output_schema_sha256"),
      permissionKinds: kinds,
      sideEffects: entry.side_effects,
      timeoutSeconds: boundedInteger(entry.timeout_seconds, `${field}.timeout_seconds`, 1, 120),
    };
    if (entry.description !== undefined) definition.description = boundedText(entry.description, `${field}.description`, 1000);
    if (entry.max_request_bytes !== undefined) definition.maxRequestBytes = boundedInteger(entry.max_request_bytes, `${field}.max_request_bytes`, 1, 64 * 1024);
    if (entry.max_response_bytes !== undefined) definition.maxResponseBytes = boundedInteger(entry.max_response_bytes, `${field}.max_response_bytes`, 1024, 4 * 1024 * 1024);
    if (entry.max_concurrent !== undefined) definition.maxConcurrent = boundedInteger(entry.max_concurrent, `${field}.max_concurrent`, 1, 16);
    if (entry.min_interval_ms !== undefined) definition.minIntervalMs = boundedInteger(entry.min_interval_ms, `${field}.min_interval_ms`, 1, 60_000);
    return definition;
  });
}

export interface DescribeOptions {
  /** Whether the credential a definition names is present on this host right now. */
  credentialConfigured?: (credential: CredentialSource) => boolean;
  /** The host's own response ceiling, applied as a minimum over the definition's. */
  maxResponseBytes?: number;
}

/** `describeBinding`: the descriptor the control plane evaluates; a name for a credential, never a value. */
export function describeDefinition(definition: ToolImplementationDefinition, options: DescribeOptions = {}): ToolBindingDescriptor {
  const remote = definition.kind === "json_http";
  const required = definition.credential !== undefined;
  const configured = required && (options.credentialConfigured?.(definition.credential!) ?? false);
  const enabled = definition.enabled !== false;
  const missing = required && !configured;
  return {
    id: definition.id,
    tool_id: definition.toolId,
    binding: definition.binding,
    implementation_kind: definition.kind,
    implementation_id: definition.implementationId,
    implementation_version: definition.implementationVersion,
    display_name: definition.displayName,
    description: definition.description ?? null,
    remote,
    available: enabled && !missing,
    availability_reason: !enabled ? "This binding is disabled in host configuration." : missing ? "This binding needs a credential that is not configured on this host." : null,
    enabled,
    endpoint: remote && definition.origin && definition.path && definition.method ? { origin: definition.origin, path: definition.path, method: definition.method } : null,
    contract: {
      input_schema_sha256: definition.inputSchemaSha256,
      output_schema_sha256: definition.outputSchemaSha256,
      permission_kinds: [...definition.permissionKinds].sort(),
      side_effects: definition.sideEffects,
    },
    limits: {
      timeout_seconds: definition.timeoutSeconds,
      max_request_bytes: definition.maxRequestBytes ?? DEFAULT_MAX_REQUEST_BYTES,
      max_response_bytes: Math.min(definition.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES, options.maxResponseBytes ?? 4 * 1024 * 1024),
      max_concurrent: definition.maxConcurrent ?? DEFAULT_MAX_CONCURRENT,
      min_interval_ms: definition.minIntervalMs && definition.minIntervalMs > 0 ? definition.minIntervalMs : null,
    },
    credentials: { required, configured, source: definition.credential ? `${definition.credential.kind}:${definition.credential.name}` : null },
    ...(definition.kind === "host_resource" && definition.resourceType ? { resource_type: definition.resourceType } : {}),
  };
}

/** `hosttools.binding_digest`: the security-relevant identity of one binding, as a stable hash. */
export function bindingDigest(descriptor: ToolBindingDescriptor): string {
  const subject: JsonObject = {
    schema: BINDING_DIGEST_SCHEMA,
    binding_id: descriptor.id,
    tool_id: descriptor.tool_id,
    binding: descriptor.binding,
    implementation_kind: descriptor.implementation_kind,
    implementation_id: descriptor.implementation_id,
    implementation_version: descriptor.implementation_version,
    remote: descriptor.remote,
    endpoint: descriptor.endpoint as JsonValue,
    contract: { ...descriptor.contract, permission_kinds: [...new Set(descriptor.contract.permission_kinds)].sort() } as unknown as JsonValue,
    limits: descriptor.limits as unknown as JsonValue,
    credentials: { required: descriptor.credentials.required, configured: descriptor.credentials.configured, source: descriptor.credentials.source },
  };
  if (descriptor.resource_type !== undefined && descriptor.resource_type !== null) subject.resource_type = descriptor.resource_type;
  return sha256HexSync(canonicalJson(subject));
}

/** The definition behind one binding id, or nothing. */
export function findDefinition(definitions: readonly ToolImplementationDefinition[], bindingId: string): ToolImplementationDefinition | undefined {
  return definitions.find((definition) => definition.id === bindingId);
}
