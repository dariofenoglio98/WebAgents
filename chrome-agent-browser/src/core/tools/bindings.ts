/**
 * The bounded binding facts a runner may hold about one tool (`toolbridge/binding.py`): the
 * closed field set a Run Plan froze, with identity, a digest, a category, a display origin and
 * the contract it was matched against, and nothing that could be used to reach somewhere
 * else: no credential, no header, no request template, no way to name another destination.
 */
import type { JsonObject, JsonValue } from "../json.js";
import { AdapterError } from "../workflow/errors.js";

export const MAX_TOOL_BINDING_TEXT = 512;
export const MAX_BINDING_IDS = 64;
export const MAX_BINDINGS = 64;

export interface ToolBindingRecord {
  tool_id: string;
  binding_name: string;
  binding_id: string;
  binding_sha256: string;
  implementation_kind: string;
  implementation_id: string | null;
  implementation_version: string | null;
  display_name: string | null;
  remote: boolean;
  endpoint_origin: string | null;
  endpoint_path: string | null;
  method: string | null;
  contract_sha256: string;
  input_schema_sha256: string;
  output_schema_sha256: string;
  required_permission_ids: string[];
  /** Whether every permission this tool links is currently granted; a bound tool whose optional permission was denied stays in the plan. */
  usable: boolean;
  timeout_seconds: number | null;
  max_calls: number | null;
  credentials_required: boolean;
  credentials_configured: boolean;
  approved: true;
  approval_source: string | null;
  compatibility_status: string | null;
  /** The type of host-owned resource a `host_resource` binding returns; null for every other category. */
  resource_type: string | null;
}

export function toolInvalid(message: string, detail: Record<string, JsonValue> | null = null): AdapterError {
  return new AdapterError("tool_request_invalid", message, { detail: detail ?? undefined, audit_facts: { stage: "input_schema" } });
}

function fields(value: unknown, field: string, allowed: readonly string[], required: readonly string[]): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw toolInvalid(`${field} must be an object`);
  const record = value as Record<string, unknown>;
  const unknown = Object.keys(record).filter((key) => !allowed.includes(key)).sort();
  if (unknown.length > 0) throw toolInvalid(`Unknown fields in ${field}: [${unknown.map((key) => `'${key}'`).join(", ")}]`);
  const missing = required.filter((key) => !Object.hasOwn(record, key)).sort();
  if (missing.length > 0) throw toolInvalid(`Missing fields in ${field}: [${missing.map((key) => `'${key}'`).join(", ")}]`);
  return record;
}

function text(value: unknown, field: string, options: { limit?: number; allowNull?: boolean } = {}): string | null {
  if ((value === null || value === undefined) && options.allowNull) return null;
  const limit = options.limit ?? MAX_TOOL_BINDING_TEXT;
  if (typeof value !== "string" || value.length === 0 || value.length > limit) throw toolInvalid(`${field} must be a string of 1 to ${limit} characters`);
  return value;
}

function hex64(value: unknown, field: string): string {
  const string = text(value, field, { limit: 64 })!;
  if (string.length !== 64 || !/^[0-9a-f]{64}$/u.test(string)) throw toolInvalid(`${field} must be 64 lowercase hex characters`);
  return string;
}

function positive(value: unknown, field: string, maximum: number): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) throw toolInvalid(`${field} must be a positive number`);
  if (value > maximum) throw toolInvalid(`${field} exceeds ${maximum}`);
  return value;
}

const FIELDS = [
  "tool_id", "binding_name", "binding_id", "binding_sha256", "implementation_kind", "implementation_id", "implementation_version", "display_name", "remote",
  "endpoint_origin", "endpoint_path", "method", "contract_sha256", "input_schema_sha256", "output_schema_sha256", "required_permission_ids", "usable",
  "timeout_seconds", "max_calls", "credentials_required", "credentials_configured", "approved", "approval_source", "compatibility_status", "resource_type",
];
const REQUIRED = ["tool_id", "binding_name", "binding_id", "binding_sha256", "implementation_kind", "remote", "contract_sha256", "input_schema_sha256", "output_schema_sha256", "approved"];

/** Validate one run-plan tool binding into the exact shape the runner uses. */
export function normalizeToolBinding(raw: unknown, index = 0): ToolBindingRecord {
  const field = `tool_bindings[${index}]`;
  const record = fields(raw, field, FIELDS, REQUIRED);
  const permissions = (record.required_permission_ids as unknown[] | null | undefined) ?? [];
  if (!Array.isArray(permissions) || permissions.length > MAX_BINDING_IDS) throw toolInvalid(`${field}.required_permission_ids must be a bounded list`);
  if (record.approved !== true) {
    // A plan should never carry an unapproved binding; refusing it here means a runner cannot
    // be handed one by a caller that skipped the control plane either.
    throw new AdapterError("tool_not_approved", `${field} is not approved, so it must not appear in an execution plan`, { detail: { tool_id: record.tool_id as JsonValue } });
  }
  if (typeof record.remote !== "boolean") throw toolInvalid(`${field}.remote must be true or false`);
  return {
    tool_id: text(record.tool_id, `${field}.tool_id`, { limit: 200 })!,
    binding_name: text(record.binding_name, `${field}.binding_name`, { limit: 200 })!,
    binding_id: text(record.binding_id, `${field}.binding_id`, { limit: 200 })!,
    binding_sha256: hex64(record.binding_sha256, `${field}.binding_sha256`),
    implementation_kind: text(record.implementation_kind, `${field}.implementation_kind`, { limit: 64 })!,
    implementation_id: text(record.implementation_id, `${field}.implementation_id`, { limit: 200, allowNull: true }),
    implementation_version: text(record.implementation_version, `${field}.implementation_version`, { limit: 64, allowNull: true }),
    display_name: text(record.display_name, `${field}.display_name`, { allowNull: true }),
    remote: record.remote,
    endpoint_origin: text(record.endpoint_origin, `${field}.endpoint_origin`, { limit: 256, allowNull: true }),
    endpoint_path: text(record.endpoint_path, `${field}.endpoint_path`, { limit: 256, allowNull: true }),
    method: text(record.method, `${field}.method`, { limit: 8, allowNull: true }),
    contract_sha256: hex64(record.contract_sha256, `${field}.contract_sha256`),
    input_schema_sha256: hex64(record.input_schema_sha256, `${field}.input_schema_sha256`),
    output_schema_sha256: hex64(record.output_schema_sha256, `${field}.output_schema_sha256`),
    required_permission_ids: permissions.map((item) => text(item, `${field}.required_permission_ids[]`, { limit: 200 })!),
    usable: record.usable !== false,
    timeout_seconds: positive(record.timeout_seconds, `${field}.timeout_seconds`, 120),
    max_calls: typeof record.max_calls === "number" && Number.isInteger(record.max_calls) ? record.max_calls : null,
    credentials_required: record.credentials_required === true,
    credentials_configured: record.credentials_configured === true,
    approved: true,
    approval_source: text(record.approval_source, `${field}.approval_source`, { limit: 64, allowNull: true }),
    compatibility_status: text(record.compatibility_status, `${field}.compatibility_status`, { limit: 64, allowNull: true }),
    resource_type: text(record.resource_type, `${field}.resource_type`, { limit: 128, allowNull: true }),
  };
}

/** Validate a whole bounded list, refusing duplicate tools or bindings. */
export function normalizeToolBindings(raw: unknown): ToolBindingRecord[] {
  if (raw === null || raw === undefined) return [];
  if (!Array.isArray(raw) || raw.length > MAX_BINDINGS) throw toolInvalid("tool_bindings must be a bounded list");
  const bindings = raw.map((item, index) => normalizeToolBinding(item, index));
  const tools = bindings.map((binding) => binding.tool_id);
  if (new Set(tools).size !== tools.length) {
    throw new AdapterError("tool_binding_ambiguous", "Each declared tool must be satisfied by exactly one binding", { detail: { tool_ids: [...new Set(tools)].sort() } });
  }
  const identifiers = bindings.map((binding) => binding.binding_id);
  if (new Set(identifiers).size !== identifiers.length) throw new AdapterError("tool_binding_ambiguous", "Two tools may not share one binding id");
  return bindings;
}

/** A safe, operator-readable summary. Never a credential, never a template. */
export function describeToolBinding(binding: ToolBindingRecord): JsonObject {
  return {
    tool_id: binding.tool_id,
    binding_name: binding.binding_name,
    binding_id: binding.binding_id,
    binding_sha256: binding.binding_sha256,
    implementation_kind: binding.implementation_kind,
    implementation_version: binding.implementation_version,
    display_name: binding.display_name,
    remote: binding.remote,
    endpoint_origin: binding.endpoint_origin,
    endpoint_path: binding.endpoint_path,
    method: binding.method,
    timeout_seconds: binding.timeout_seconds,
    credentials_required: binding.credentials_required,
    credentials_configured: binding.credentials_configured,
    note: "Credential values never cross this boundary. `credentials_configured` says only whether the trusted host has one attached to this binding.",
  };
}
