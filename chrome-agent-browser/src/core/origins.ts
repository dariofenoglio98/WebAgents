/**
 * The origins a run plan needs (T16, D-193): what the extension asks Chrome to grant before a
 * plan is prepared, lists under the plan's Technical details, hands the execution host as its
 * allowlist, and revokes per package from Settings → Permissions. A pure function of the plan's
 * facts and the host's provider settings; no Chrome API, nothing package-specific.
 *
 * The set is: the package's own origin (its download URL: a session that expires is re-opened
 * from there), every approved tool binding's endpoint origin and, where the host registered one,
 * its declared fallback origin (D-153), and the bound hosted provider's endpoint origin. Ollama
 * is reached on the loopback names the manifest holds, and the built-in model has no origin, so
 * neither contributes. Only `https` origins on port 443 ever appear: the core URL gate admits
 * nothing else for packages and tools (D-026), and a hosted provider endpoint must be HTTPS
 * (`settings.ts::endpointProblem`).
 */
import { findBinding, type PlanToolBinding, type ToolRegistry } from "./hosttools.js";
import { origin as originOf, originText } from "./policy.js";

/** An origin as this module states it: `https://host` (the default port dropped). */
export type OriginString = string;

export interface OriginToolBinding {
  tool_id?: string;
  approved?: boolean;
  remote?: boolean;
  endpoint_origin?: string | null;
  /** The host's declared fallback endpoint origin for this binding, when it registered one (not in the plan record; the registry says). */
  fallback_origin?: string | null;
}

export interface PlanOriginInputs {
  /** The package's download URL (the session source's display), or null when it was opened from bytes. */
  packageUrl: string | null;
  toolBindings: readonly OriginToolBinding[];
  /** The bound model's provider and the host's endpoint for it (the connection's base URL, or the provider's default); null when no model is bound. */
  model: { provider_id: string; base_url: string | null } | null;
}

export type OriginRole = "package" | "tool" | "provider";

export interface PlanOrigin {
  origin: OriginString;
  roles: OriginRole[];
  /** What needs it: the tool ids, the provider id, or "package". */
  subjects: string[];
}

/** `https://host` for an HTTPS URL on its default port; null for anything the gate would not admit. */
export function httpsOrigin(url: string | null | undefined): OriginString | null {
  if (typeof url !== "string" || url.length === 0) return null;
  const where = originOf(url);
  if (where === null || where[0] !== "https") return null;
  return originText(where);
}

/** Whether a base URL names this machine (Ollama): never an origin to request. */
function loopback(url: string): boolean {
  const where = originOf(url);
  return where !== null && (where[1] === "127.0.0.1" || where[1] === "localhost" || where[1] === "::1");
}

/** The origins a plan needs, each with why, sorted by origin. */
export function planOrigins(input: PlanOriginInputs): PlanOrigin[] {
  const found = new Map<OriginString, PlanOrigin>();
  const add = (origin: OriginString | null, role: OriginRole, subject: string): void => {
    if (origin === null) return;
    const entry = found.get(origin) ?? { origin, roles: [], subjects: [] };
    if (!entry.roles.includes(role)) entry.roles.push(role);
    if (!entry.subjects.includes(subject)) entry.subjects.push(subject);
    found.set(origin, entry);
  };
  add(httpsOrigin(input.packageUrl), "package", "package");
  for (const binding of input.toolBindings) {
    if (binding.approved === false || binding.remote === false) continue;
    const subject = binding.tool_id ?? "tool";
    add(httpsOrigin(binding.endpoint_origin ?? null), "tool", subject);
    add(httpsOrigin(binding.fallback_origin ?? null), "tool", subject);
  }
  if (input.model !== null && input.model.base_url !== null && !loopback(input.model.base_url)) add(httpsOrigin(input.model.base_url), "provider", input.model.provider_id);
  return [...found.values()]
    .map((entry) => ({ origin: entry.origin, roles: [...entry.roles].sort(), subjects: [...entry.subjects].sort() }))
    .sort((a, b) => (a.origin < b.origin ? -1 : a.origin > b.origin ? 1 : 0));
}

/**
 * A plan's tool bindings as `planOrigins` reads them: the plan record carries no fallback, so the
 * host's registry (the same derivation the plan was frozen from, D-054) supplies it by binding id.
 */
export function toolBindingsForOrigins(bindings: readonly PlanToolBinding[], registry: ToolRegistry | null): OriginToolBinding[] {
  return bindings.map((binding) => ({
    tool_id: binding.tool_id,
    approved: binding.approved,
    remote: binding.remote,
    endpoint_origin: binding.endpoint_origin,
    fallback_origin: registry === null ? null : (findBinding(registry, binding.binding_id)?.fallback?.endpoint.origin ?? null),
  }));
}

/** The Chrome match pattern for an origin: every path on that host over HTTPS. */
export function originPattern(origin: OriginString): string {
  return `${origin}/*`;
}

/** The origin a match pattern names, for patterns this extension writes (`https://host/*`); null otherwise. */
export function patternOrigin(pattern: string): OriginString | null {
  if (!pattern.endsWith("/*") || pattern.includes("*", 0) !== pattern.endsWith("/*") || pattern.indexOf("*") !== pattern.length - 1) return null;
  return httpsOrigin(pattern.slice(0, -2));
}

/** Whether `url` lies inside one of `origins` (same scheme, host and effective port). */
export function urlInOrigins(url: string, origins: readonly OriginString[]): boolean {
  const where = httpsOrigin(url);
  return where !== null && origins.includes(where);
}
