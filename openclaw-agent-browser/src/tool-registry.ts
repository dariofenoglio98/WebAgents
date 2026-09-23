/**
 * Tool discovery: which implementations this host actually has.
 *
 * The control plane deliberately implements nothing. This module states what
 * *this* host can run for a declared tool, projects it into the
 * service-neutral binding descriptor the control plane accepts, and sends it
 * there. What comes back is a verdict about compatibility; what stays here is
 * every fact that could reach a network.
 *
 * ## A binding is a host statement, not a package one
 *
 * A package declares `citation-resolver` and says where it expects that to
 * live. That declaration constrains this host *downwards* — the control plane
 * refuses a binding that would land outside the domains the package declared —
 * and grants nothing: nothing in an `.agent.pkg` adds an entry below, and a
 * package naming an origin no binding here names simply cannot run.
 *
 * ## Two categories, not a service list
 *
 * * `json_http` — one exact JSON request to one exact configured origin, path
 *   and method, under the transport policy in `tool-broker.ts`;
 * * `local_builtin` — an implementation that ships with this plugin and does
 *   no I/O at all.
 *
 * Adding a service adds an *entry*. Adding a way of reaching services would
 * add a category, and there are two.
 *
 * ## What never leaves this process
 *
 * A descriptor carries identity, locality, the contract it implements, its
 * bounds, and whether a credential is attached. It never carries a credential
 * value, a header, a query parameter, a request template or a second endpoint,
 * and the control plane refuses unknown fields, so a mistake here fails loudly
 * instead of leaking.
 *
 * ## Contract digests
 *
 * Each built-in states the SHA-256 of the canonical JSON of the request and
 * response schema documents it implements. They are *this host's* statement
 * about the service contract it speaks, pinned here rather than read from a
 * package — a binding that derived its contract from the package it is about
 * to serve would confirm nothing. A package whose schemas differ is reported
 * `incompatible`, and a binding that states no digest is `unverified`.
 */
import type { ExecutionPolicy } from "./execution.js";

export const TOOL_REGISTRY_SCHEMA = "agentpkg-host-tool-registry-v0";
export const MAX_REGISTRY_BINDINGS = 64;

export type ToolImplementationKind = "json_http" | "local_builtin";

export type ToolBindingDescriptor = {
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
  contract: {
    input_schema_sha256: string | null;
    output_schema_sha256: string | null;
    permission_kinds: string[];
    side_effects: "read" | "write";
  };
  limits: {
    timeout_seconds: number;
    max_request_bytes: number;
    max_response_bytes: number;
    max_concurrent: number;
  };
  credentials: { required: boolean; configured: boolean; source: string | null };
};

export type ToolRegistry = {
  schema: typeof TOOL_REGISTRY_SCHEMA;
  host: {
    runtime: "openclaw";
    runtime_version: string | null;
    source: string;
    captured_at: string;
    agent_id: string | null;
  };
  bindings: ToolBindingDescriptor[];
  notes: Array<{ code: string; detail: string | null }>;
};

/**
 * The secret this binding needs, and where the host would find it.
 *
 * `env` is the only source in this milestone, and nothing shipped uses it. It
 * exists so an authenticated tool is a configuration change rather than a
 * redesign, and so the "no credential reaches the package" claim is tested
 * against a binding that actually has one.
 */
export type CredentialSource = { kind: "env"; name: string };

/** One host implementation, as this plugin defines it internally. */
export type ToolBindingDefinition = {
  id: string;
  toolId: string;
  /** The abstract capability name the package asks for. */
  binding: string;
  kind: ToolImplementationKind;
  implementationId: string;
  implementationVersion: string;
  displayName: string;
  description?: string;
  /** Required for `json_http`, forbidden for `local_builtin`. */
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
  credential?: CredentialSource;
  enabled?: boolean;
};

const SOURCE = "openclaw plugin tool registry";

/**
 * The implementations this plugin ships.
 *
 * `test.echo` is a conformance implementation: it performs no I/O, returns its
 * input, and exists so the whole path — declaration, binding, approval, plan,
 * `Runtime.call_tool`, bridge, broker, validated result — can be exercised
 * without a service, a network or a model.
 *
 * `citation-resolver` is the first real one. Its schema digests are the
 * canonical-JSON SHA-256 of the service's own request and response contract;
 * a Python test asserts they equal the digests of the schemas the shipped
 * Literature Review package declares, which is how "the host and the package
 * agree" is established rather than assumed.
 */
export const BUILT_IN_BINDINGS: readonly ToolBindingDefinition[] = Object.freeze([
  {
    id: "openclaw:test.echo:1",
    toolId: "test.echo",
    binding: "test.echo.builtin",
    kind: "local_builtin",
    implementationId: "openclaw.tool.echo",
    implementationVersion: "0.1.0",
    displayName: "Echo (host conformance implementation)",
    description: "Returns its input unchanged. Performs no I/O and reaches nothing.",
    inputSchemaSha256: null,
    outputSchemaSha256: null,
    permissionKinds: ["files.read"],
    sideEffects: "read",
    timeoutSeconds: 10,
    maxConcurrent: 8,
  },
  {
    id: "openclaw:citation-resolver:1",
    toolId: "citation-resolver",
    binding: "citation.resolve",
    kind: "json_http",
    implementationId: "openclaw.tool.json_http",
    implementationVersion: "0.1.0",
    displayName: "Citation Resolver",
    description:
      "One JSON POST to the configured Citation Resolver origin. No other request shape, " +
      "path, method or destination is reachable through this binding.",
    origin: "https://webagents-citation-resolver-production.up.railway.app",
    path: "/resolve",
    method: "POST",
    inputSchemaSha256: "6ebcf0d39ab472236ac42275a84e9299c64d22273847898c95e46096363d9b83",
    outputSchemaSha256: "0122dc2ac551935269f43020a1b97dcfabb2f180fe07fbdf02734dcb7c1a14f9",
    permissionKinds: ["network"],
    sideEffects: "read",
    timeoutSeconds: 45,
    maxRequestBytes: 16 * 1024,
    maxResponseBytes: 512 * 1024,
    maxConcurrent: 4,
  },
]);

export type ToolConfigEntry = {
  toolId?: string;
  enabled?: boolean;
  origin?: string;
  path?: string;
  method?: string;
  timeoutSeconds?: number;
  displayName?: string;
  credentialEnv?: string;
};

export type ToolsConfig = {
  enabled?: boolean;
  bindings?: ToolConfigEntry[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function positive(value: unknown, fallback: number, max: number): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0
    ? Math.min(value, max)
    : fallback;
}

/** Validate an operator-supplied origin the same way the control plane will. */
export function safeOrigin(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0 || value.length > 256) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (
    url.protocol !== "https:" ||
    !url.hostname ||
    url.username ||
    url.password ||
    (url.port && url.port !== "443") ||
    (url.pathname !== "" && url.pathname !== "/") ||
    url.search ||
    url.hash
  ) {
    return null;
  }
  return `https://${url.hostname}`;
}

function safePath(value: unknown): string | null {
  if (typeof value !== "string" || !value.startsWith("/") || value.length > 256) return null;
  if (value.includes("?") || value.includes("#") || value.includes("..")) return null;
  return value;
}

/**
 * Apply operator configuration onto the built-ins.
 *
 * Configuration can disable a binding, relabel it, retarget an origin or path,
 * tighten a timeout, or attach a credential. It cannot invent an
 * implementation category, and it cannot add a binding for a tool this plugin
 * has no implementation for — a registry entry is a claim that code here can
 * serve it, and configuration is not code.
 */
export function resolveBindings(
  config: ToolsConfig | undefined,
  definitions: readonly ToolBindingDefinition[] = BUILT_IN_BINDINGS,
): { definitions: ToolBindingDefinition[]; notes: ToolRegistry["notes"] } {
  const notes: ToolRegistry["notes"] = [];
  if (config?.enabled === false) {
    return {
      definitions: [],
      notes: [
        {
          code: "tools_disabled",
          detail:
            "This host's tool broker is disabled in plugin configuration, so no package tool " +
            "can be bound here.",
        },
      ],
    };
  }
  const overrides = new Map<string, ToolConfigEntry>();
  for (const entry of config?.bindings ?? []) {
    if (!isRecord(entry) || typeof entry.toolId !== "string") continue;
    overrides.set(entry.toolId, entry);
  }
  const resolved: ToolBindingDefinition[] = [];
  for (const base of definitions) {
    const override = overrides.get(base.toolId);
    overrides.delete(base.toolId);
    if (!override) {
      resolved.push(base);
      continue;
    }
    if (override.enabled === false) {
      resolved.push({ ...base, enabled: false });
      continue;
    }
    const next: ToolBindingDefinition = { ...base };
    if (override.displayName && override.displayName.length <= 200) {
      next.displayName = override.displayName;
    }
    if (typeof override.timeoutSeconds === "number") {
      next.timeoutSeconds = positive(override.timeoutSeconds, base.timeoutSeconds, 120);
    }
    if (typeof override.credentialEnv === "string" && /^[A-Z][A-Z0-9_]{0,63}$/u.test(override.credentialEnv)) {
      next.credential = { kind: "env", name: override.credentialEnv };
    }
    if (base.kind === "json_http") {
      const origin = override.origin === undefined ? base.origin : safeOrigin(override.origin);
      const path = override.path === undefined ? base.path : safePath(override.path);
      const method =
        override.method === undefined
          ? base.method
          : override.method === "GET" || override.method === "POST"
            ? override.method
            : undefined;
      if (!origin || !path || !method) {
        notes.push({
          code: "binding_config_rejected",
          detail:
            `The configured endpoint for ${base.toolId} is not an https origin on port 443 ` +
            "with an absolute path and GET or POST, so the built-in endpoint is used.",
        });
      } else {
        next.origin = origin;
        next.path = path;
        next.method = method;
      }
    } else if (override.origin !== undefined || override.path !== undefined) {
      notes.push({
        code: "binding_config_ignored",
        detail: `${base.toolId} is a local implementation and has no endpoint to configure.`,
      });
    }
    resolved.push(next);
  }
  for (const toolId of overrides.keys()) {
    notes.push({
      code: "binding_unknown",
      detail:
        `Configuration names a binding for ${toolId}, which this host has no implementation ` +
        "for. A registry entry is a claim that code here can serve it; configuration alone " +
        "cannot make one.",
    });
  }
  return { definitions: resolved.slice(0, MAX_REGISTRY_BINDINGS), notes };
}

/** Whether a credential this binding needs is actually present right now. */
export function credentialConfigured(
  definition: ToolBindingDefinition,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (!definition.credential) return false;
  const value = env[definition.credential.name];
  return typeof value === "string" && value.length > 0;
}

export function describeBinding(
  definition: ToolBindingDefinition,
  options: { env?: NodeJS.ProcessEnv; maxResponseBytes?: number } = {},
): ToolBindingDescriptor {
  const remote = definition.kind === "json_http";
  const required = Boolean(definition.credential);
  const configured = credentialConfigured(definition, options.env ?? process.env);
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
    availability_reason: !enabled
      ? "This binding is disabled in plugin configuration."
      : missing
        ? "This binding needs a credential that is not configured on this host."
        : null,
    enabled,
    endpoint:
      remote && definition.origin && definition.path && definition.method
        ? { origin: definition.origin, path: definition.path, method: definition.method }
        : null,
    contract: {
      input_schema_sha256: definition.inputSchemaSha256,
      output_schema_sha256: definition.outputSchemaSha256,
      permission_kinds: [...definition.permissionKinds].sort(),
      side_effects: definition.sideEffects,
    },
    limits: {
      timeout_seconds: definition.timeoutSeconds,
      max_request_bytes: definition.maxRequestBytes ?? 16 * 1024,
      max_response_bytes: Math.min(
        definition.maxResponseBytes ?? 512 * 1024,
        options.maxResponseBytes ?? 4 * 1024 * 1024,
      ),
      max_concurrent: definition.maxConcurrent ?? 4,
    },
    // A name, never a value: `configured` is the only thing about a secret
    // that crosses this boundary, and it is enough to make a run plan stale
    // when one is attached or removed.
    credentials: {
      required,
      configured,
      source: definition.credential ? `env:${definition.credential.name}` : null,
    },
  };
}

export type RegistryHost = {
  runtimeVersion?: string | null;
  agentId?: string | null;
};

/** Build the whole registry this host will send to the control plane. */
export function buildToolRegistry(options: {
  config?: ToolsConfig;
  host?: RegistryHost;
  env?: NodeJS.ProcessEnv;
  policy?: Pick<ExecutionPolicy, "maxToolResponseBytes"> | undefined;
  definitions?: readonly ToolBindingDefinition[];
}): ToolRegistry {
  const { definitions, notes } = resolveBindings(options.config, options.definitions);
  const bindings = definitions.map((definition) =>
    describeBinding(definition, {
      ...(options.env ? { env: options.env } : {}),
      ...(options.policy?.maxToolResponseBytes
        ? { maxResponseBytes: options.policy.maxToolResponseBytes }
        : {}),
    }),
  );
  if (bindings.length === 0 && notes.length === 0) {
    notes.push({
      code: "no_tool_bindings",
      detail: "This host registers no tool implementation, so no package tool can run here.",
    });
  }
  return {
    schema: TOOL_REGISTRY_SCHEMA,
    host: {
      runtime: "openclaw",
      runtime_version: options.host?.runtimeVersion ?? null,
      source: SOURCE,
      captured_at: new Date().toISOString(),
      agent_id: options.host?.agentId ?? null,
    },
    bindings: bindings.sort((a, b) => a.id.localeCompare(b.id)),
    notes: notes.slice(0, 16),
  };
}

/** The definition behind one registered binding id, or nothing. */
export function findDefinition(
  definitions: readonly ToolBindingDefinition[],
  bindingId: string,
): ToolBindingDefinition | undefined {
  return definitions.find((definition) => definition.id === bindingId);
}
