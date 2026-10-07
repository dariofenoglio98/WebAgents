/**
 * Publisher-declared profiles (D-022, D-040, D-041): the noncritical manifest extension
 * `org.webagents:profiles-v0`, read for presentation.
 *
 * A profile groups permissions, tools and host resource types the package already declares
 * into a named choice with a one-line description and an estimate. **It presents authority
 * and never grants it.** This module checks the shape (`spec/extensions/profiles-v0.schema.json`)
 * and the seven consistency rules of `spec/extensions/profiles-v0.md` §4 against the package,
 * and, as §5 requires, ignores the whole value when anything fails: no profile is offered and
 * the notes say why. Turning a selected profile into decisions is T3's (D-022).
 */
import { isJsonObject, type JsonObject, type JsonValue } from "./json.js";

export const PROFILES_EXTENSION_KEY = "org.webagents:profiles-v0";
const IDENTIFIER = /^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/u;
const LINE = /^[^\u0000-\u001f\u007f]+$/u;
const MAX_PROFILES = 8;
const MAX_IDENTIFIERS = 512;
const MAX_TITLE = 60;
const MAX_LINE = 240;
const PROFILE_FIELDS = new Set(["id", "title", "description", "permissions", "tools", "resources", "estimate"]);
const ESTIMATE_FIELDS = new Set(["model_calls", "tool_calls", "tokens", "notes"]);

export interface ProfileEstimate {
  model_calls?: number;
  tool_calls?: number;
  tokens?: number;
  notes?: string;
}

export interface Profile {
  id: string;
  title: string;
  description: string;
  permissions: string[];
  tools: string[];
  resources: string[];
  estimate: ProfileEstimate | null;
}

export interface ProfilesReport {
  /** Whether the manifest carries the extension key at all. */
  declared: boolean;
  /** The validated profiles in declared order, or null when absent or invalid as a whole. */
  profiles: Profile[] | null;
  /** Why the value was ignored, when it was. */
  notes: string[];
}

class ProfileError extends Error {}

function fail(message: string): never {
  throw new ProfileError(message);
}

function identifiers(value: JsonValue | undefined, field: string, where: string): string[] {
  if (!Array.isArray(value) || value.length > MAX_IDENTIFIERS) fail(`${where}: ${field} must be an array of at most ${MAX_IDENTIFIERS} identifiers`);
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== "string" || !IDENTIFIER.test(item)) fail(`${where}: ${field} contains an invalid identifier`);
    if (out.includes(item)) fail(`${where}: ${field} repeats ${JSON.stringify(item)}`);
    out.push(item);
  }
  return out;
}

function line(value: JsonValue | undefined, field: string, where: string, limit: number): string {
  if (typeof value !== "string" || !LINE.test(value) || value.length > limit) {
    fail(`${where}: ${field} must be one line of at most ${limit} characters`);
  }
  return value;
}

function count(value: JsonValue | undefined, field: string, where: string, maximum: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > maximum) {
    fail(`${where}: estimate.${field} must be an integer between 0 and ${maximum}`);
  }
  return value;
}

function shape(raw: JsonValue): Profile[] {
  if (!isJsonObject(raw)) fail("the extension value must be an object");
  const unknown = Object.keys(raw).filter((key) => key !== "profiles");
  if (unknown.length > 0) fail(`unknown field ${JSON.stringify(unknown[0])}`);
  if (!Array.isArray(raw.profiles) || raw.profiles.length < 1 || raw.profiles.length > MAX_PROFILES) {
    fail(`profiles must list 1 to ${MAX_PROFILES} profiles`);
  }
  return raw.profiles.map((entry, index) => {
    const where = `profiles[${index}]`;
    if (!isJsonObject(entry)) fail(`${where}: must be an object`);
    for (const key of Object.keys(entry)) if (!PROFILE_FIELDS.has(key)) fail(`${where}: unknown field ${JSON.stringify(key)}`);
    for (const key of ["id", "title", "description", "permissions", "tools", "resources"]) {
      if (!Object.hasOwn(entry, key)) fail(`${where}: ${key} is required`);
    }
    const id = typeof entry.id === "string" && IDENTIFIER.test(entry.id) ? entry.id : fail(`${where}: id must be an identifier`);
    let estimate: ProfileEstimate | null = null;
    if (Object.hasOwn(entry, "estimate")) {
      const value = entry.estimate;
      if (!isJsonObject(value) || Object.keys(value).length === 0) fail(`${where}: estimate must be an object with at least one field`);
      for (const key of Object.keys(value)) if (!ESTIMATE_FIELDS.has(key)) fail(`${where}: estimate has unknown field ${JSON.stringify(key)}`);
      estimate = {};
      if (Object.hasOwn(value, "model_calls")) estimate.model_calls = count(value.model_calls, "model_calls", where, 100000);
      if (Object.hasOwn(value, "tool_calls")) estimate.tool_calls = count(value.tool_calls, "tool_calls", where, 100000);
      if (Object.hasOwn(value, "tokens")) estimate.tokens = count(value.tokens, "tokens", where, 1000000000);
      if (Object.hasOwn(value, "notes")) estimate.notes = line(value.notes, "estimate.notes", where, MAX_LINE);
    }
    return {
      id,
      title: line(entry.title, "title", where, MAX_TITLE),
      description: line(entry.description, "description", where, MAX_LINE),
      permissions: identifiers(entry.permissions, "permissions", where),
      tools: identifiers(entry.tools, "tools", where),
      resources: identifiers(entry.resources, "resources", where),
      estimate,
    };
  });
}

const subset = (a: readonly string[], b: readonly string[]) => a.every((item) => b.includes(item));

/** The seven rules of `spec/extensions/profiles-v0.md` §4 against the package's declarations. */
function consistency(profiles: Profile[], pkg: { manifest: JsonObject; policy: JsonObject; tools: Readonly<Record<string, JsonObject>> }): void {
  const permissions = new Map((pkg.policy.permissions as JsonObject[]).map((permission) => [String(permission.id), permission]));
  const resourceTypes = new Map<string, string>();
  for (const permission of permissions.values()) {
    if (permission.kind === "personal.read") {
      for (const type of (permission.resources as JsonValue[]).map(String)) resourceTypes.set(type, String(permission.id));
    }
  }
  const required = [...permissions.values()].filter((permission) => permission.required === true).map((permission) => String(permission.id));
  const budget = pkg.policy.budget as JsonObject;
  const perTool = budget.max_calls_per_tool as JsonObject;
  const seen = new Set<string>();
  for (const profile of profiles) {
    const where = `profile ${JSON.stringify(profile.id)}`;
    // 7. Unique ids.
    if (seen.has(profile.id)) fail(`${where}: duplicate id`);
    seen.add(profile.id);
    // 1. Declared only.
    for (const id of profile.permissions) if (!permissions.has(id)) fail(`${where}: undeclared permission ${JSON.stringify(id)}`);
    // Own properties only: a profile naming `toString` or `constructor` is an undeclared tool.
    for (const id of profile.tools) if (!Object.hasOwn(pkg.tools, id)) fail(`${where}: undeclared tool ${JSON.stringify(id)}`);
    for (const type of profile.resources) if (!resourceTypes.has(type)) fail(`${where}: undeclared resource type ${JSON.stringify(type)}`);
    // 2. Required permissions included.
    for (const id of required) if (!profile.permissions.includes(id)) fail(`${where}: required permission ${JSON.stringify(id)} is missing`);
    // 3. Tools bring their permissions.
    for (const id of profile.tools) {
      for (const permissionId of (pkg.tools[id]!.permissions as JsonValue[]).map(String)) {
        if (!profile.permissions.includes(permissionId)) fail(`${where}: tool ${JSON.stringify(id)} needs permission ${JSON.stringify(permissionId)}`);
      }
    }
    // 4. Resources match their permissions.
    const expected = [...resourceTypes].filter(([, permissionId]) => profile.permissions.includes(permissionId)).map(([type]) => type);
    if (!subset(expected, profile.resources) || !subset(profile.resources, expected)) {
      fail(`${where}: resources must be exactly those of its personal.read permissions`);
    }
    // 6. Estimates within the policy.
    if (profile.estimate) {
      if (profile.estimate.tokens !== undefined && profile.estimate.tokens > (budget.hard_tokens as number)) {
        fail(`${where}: estimate.tokens exceeds hard_tokens`);
      }
      if (profile.estimate.tool_calls !== undefined) {
        const allowed = profile.tools.reduce((sum, id) => sum + (Object.hasOwn(perTool, id) ? (perTool[id] as number) : 0), 0);
        if (profile.estimate.tool_calls > allowed) fail(`${where}: estimate.tool_calls exceeds the tools' call budgets`);
      }
    }
  }
  // 5. Least authority first.
  const first = profiles[0]!;
  for (const other of profiles.slice(1)) {
    if (!subset(first.permissions, other.permissions) || !subset(first.tools, other.tools) || !subset(first.resources, other.resources)) {
      fail(`profile ${JSON.stringify(first.id)} must be a subset of ${JSON.stringify(other.id)} (least authority first)`);
    }
  }
}

/** Validate and return the package's profiles, or null with notes when the value is unusable. */
export function readProfiles(pkg: { manifest: JsonObject; policy: JsonObject; tools: Readonly<Record<string, JsonObject>> }): ProfilesReport {
  const extensions = isJsonObject(pkg.manifest.extensions) ? pkg.manifest.extensions : {};
  if (!Object.hasOwn(extensions, PROFILES_EXTENSION_KEY)) return { declared: false, profiles: null, notes: [] };
  try {
    const profiles = shape(extensions[PROFILES_EXTENSION_KEY]!);
    consistency(profiles, pkg);
    return { declared: true, profiles, notes: [] };
  } catch (error) {
    if (!(error instanceof ProfileError)) throw error;
    return { declared: true, profiles: null, notes: [`${PROFILES_EXTENSION_KEY} ignored as a whole: ${error.message}`] };
  }
}
