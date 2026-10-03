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
 * ## Four categories, not a service list
 *
 * * `json_http` — one exact HTTPS request to one exact configured origin, path
 *   and method, under the transport policy in `tool-broker.ts`. What the
 *   request carries and how the answer is read is an *adapter* chosen by the
 *   implementation id (`tool-adapters.ts`), never by the package;
 * * `local_builtin` — an implementation that ships with this plugin and does
 *   no I/O at all;
 * * `selected_file` — a local implementation that reads **only** files the
 *   person explicitly selected for this run, through opaque host-held
 *   capabilities (`file-capabilities.ts`). It can name no path, reach no
 *   network and write nothing;
 * * `host_resource` — a local implementation that returns **only** the one
 *   host-owned resource of its type (a profile, an identity, a payment
 *   instrument) the person granted for this run (`host-resources.ts`). It
 *   takes no argument that could name another resource, reaches no network
 *   and writes nothing. Its entries come from the host's own resource store,
 *   one per resource type, never from a package.
 *
 * Adding a service adds an *entry*. Adding a way of reaching resources adds a
 * category: reading a person's own selected file is a different kind of reach
 * from calling a service or computing in memory, so it is the third, and
 * reading what the host holds for the person is the fourth.
 *
 * ## Operator entries
 *
 * Most entries are code (`BUILT_IN_BINDINGS`). One kind can also be an
 * operator's statement: an entry of the plain `openclaw.tool.json_http`
 * adapter — one JSON POST to one exact HTTPS origin and path — whose code is
 * already here and knows nothing about the service it reaches. An operator's
 * bindings file (`tools.bindingsFile`, `openclaw-host-tool-bindings-v0`) adds
 * such entries, each with the endpoint, contract digests, permission kinds,
 * side effects and bounds the operator states for it
 * (`parseOperatorBindings`). It cannot add a category, an adapter, a local
 * implementation or a request shape, cannot replace or shadow an entry this
 * host already has, and goes through the same control-plane evaluation and
 * broker policy as every other entry: a package still has to declare that
 * exact origin, path and contract before anything binds.
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
import { lstat, readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { AgentBrowserError } from "./errors.js";
import type { ExecutionPolicy } from "./execution.js";

export const TOOL_REGISTRY_SCHEMA = "agentpkg-host-tool-registry-v0";
export const MAX_REGISTRY_BINDINGS = 64;

export type ToolImplementationKind = "json_http" | "local_builtin" | "selected_file" | "host_resource";

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
    /** Minimum spacing between the starts of two calls, when a service states one. */
    min_interval_ms: number | null;
  };
  credentials: { required: boolean; configured: boolean; source: string | null };
  /** Only on a `host_resource` binding: the type of resource it returns. */
  resource_type?: string;
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
  /** Required for `json_http`, forbidden for the two local categories. */
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
  /** The service's own rate limit, honoured by the host: spacing between call starts. */
  minIntervalMs?: number;
  credential?: CredentialSource;
  enabled?: boolean;
  /** Required for `host_resource`: the resource type this binding returns. */
  resourceType?: string;
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
 *
 * `scholarly-search` is one fixed Crossref query (`tool-adapters.ts`): the
 * package supplies a query string and a row count, and this host decides the
 * origin, path, method, parameter names, selected fields and how the answer is
 * rendered. `paper-reader` extracts page text from one PDF the person selected
 * for this run, by opaque id, through the trusted `agentpkg host-pdf-read`
 * parser; it never sees or accepts a path. Their digests are pinned the same
 * way, by the same test.
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
  {
    id: "openclaw:scholarly-search:1",
    toolId: "scholarly-search",
    binding: "scholarly.search",
    kind: "json_http",
    implementationId: "openclaw.tool.crossref_works_search",
    implementationVersion: "0.2.0",
    displayName: "Crossref works search",
    description:
      "One GET to https://api.crossref.org/works with exactly four parameters — " +
      "query.bibliographic, rows, a fixed field selection and a fixed filter to scholarly " +
      "work types — whose names and fixed values are host code. " +
      "The answer is reduced to the declared search result, with markup rendered to text " +
      "as the Citation Resolver renders the same Crossref fields.",
    origin: "https://api.crossref.org",
    path: "/works",
    method: "GET",
    inputSchemaSha256: "f8a6f920b23bf1731a85d5275c10eee77a9d055fb14917be114c1b9e8249baf2",
    outputSchemaSha256: "eb83100404221fd9a489046d6741a046aae07c31c672ab6dc2daabffeda3c9ee",
    permissionKinds: ["network"],
    sideEffects: "read",
    timeoutSeconds: 25,
    // A GET carries its arguments in the URL; this bounds that URL.
    maxRequestBytes: 4 * 1024,
    maxResponseBytes: 512 * 1024,
    // Crossref's public pool states `x-concurrency-limit: 1` and one request per
    // second on every answer, and answers 429 to clients that ignore it. This
    // host honours both; calls beyond them wait their turn inside their deadline.
    maxConcurrent: 1,
    minIntervalMs: 1000,
  },
  {
    id: "openclaw:paper-reader:1",
    toolId: "paper-reader",
    binding: "paper.read",
    kind: "selected_file",
    implementationId: "openclaw.tool.selected_pdf_text",
    implementationVersion: "0.1.0",
    displayName: "Selected PDF text",
    description:
      "Extracts page text from one PDF the person selected for this run, named by an opaque " +
      "id. No path is accepted, no other file is readable, and nothing is fetched, rendered, " +
      "executed or OCRed.",
    inputSchemaSha256: "5b1df5dc0d13ca9a8b76cce86d93639f2b13baf3eb66ec895a725fc9169686ca",
    outputSchemaSha256: "4feee1362ccba94d82ffbd56e106525c1fab7643e664172d63469ec241ab3167",
    permissionKinds: ["files.read"],
    sideEffects: "read",
    timeoutSeconds: 20,
    maxRequestBytes: 1024,
    maxResponseBytes: 512 * 1024,
    maxConcurrent: 2,
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
  /** Absolute path to an operator bindings file (`openclaw-host-tool-bindings-v0`). */
  bindingsFile?: string;
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

// -- operator entries ---------------------------------------------------------
export const OPERATOR_BINDINGS_SCHEMA = "openclaw-host-tool-bindings-v0";
export const MAX_OPERATOR_BINDINGS = 32;
export const MAX_OPERATOR_BINDINGS_BYTES = 256 * 1024;
/** The one implementation an operator entry can name, and its code version. */
export const OPERATOR_IMPLEMENTATION = Object.freeze({
  id: "openclaw.tool.json_http",
  version: "0.1.0",
});

const OPERATOR_FIELDS = [
  "id",
  "tool_id",
  "binding",
  "implementation_id",
  "display_name",
  "description",
  "endpoint",
  "input_schema_sha256",
  "output_schema_sha256",
  "permission_kinds",
  "side_effects",
  "timeout_seconds",
  "max_request_bytes",
  "max_response_bytes",
  "max_concurrent",
  "min_interval_ms",
] as const;
const OPERATOR_REQUIRED = OPERATOR_FIELDS.filter(
  (field) =>
    !["description", "max_request_bytes", "max_response_bytes", "max_concurrent", "min_interval_ms"].includes(
      field,
    ),
);
const BINDING_ID = /^[a-z][a-z0-9-]{0,31}:[A-Za-z0-9._-]{1,128}:[0-9]{1,6}$/u;
const NAME = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u;
const KIND = /^[a-z][a-z0-9_.]{0,63}$/u;
const HEX64 = /^[0-9a-f]{64}$/u;
const CONTROL = /[\u0000-\u001f\u007f]/u;

function refuseBindings(detail: string): never {
  throw new AgentBrowserError("invalid_request", "Tool bindings rejected", detail);
}

function closedRecord(value: unknown, field: string, allowed: readonly string[], required: readonly string[]) {
  if (!isRecord(value)) refuseBindings(`${field} must be an object`);
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) refuseBindings(`${field} has an unknown field ${key.slice(0, 64)}`);
  }
  for (const key of required) {
    if (!(key in value)) refuseBindings(`${field} is missing ${key}`);
  }
  return value;
}

function boundedText(value: unknown, field: string, max: number, pattern?: RegExp): string {
  if (typeof value !== "string" || value.length === 0 || value.length > max || CONTROL.test(value)) {
    refuseBindings(`${field} must be a string of 1 to ${max} characters without control characters`);
  }
  if (pattern && !pattern.test(value)) refuseBindings(`${field} is not a valid identifier`);
  return value;
}

function boundedInteger(value: unknown, field: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    refuseBindings(`${field} must be an integer from ${min} to ${max}`);
  }
  return value;
}

/**
 * Validate an operator's bindings document into registry entries.
 *
 * All or nothing, like the host resource store: one bad entry rejects the
 * document. Every entry is the plain JSON POST adapter, so what an operator
 * states is *where* (one exact HTTPS origin and path) and *what contract*
 * (schema digests, permission kinds, side effects, bounds) — never how a
 * request is shaped. An entry may not reuse an id, a tool id or a binding name
 * this host already serves (`existing`): it adds, it never replaces or makes a
 * declaration ambiguous. Credentials are not part of the document; an operator
 * attaches one by name through `tools.bindings`, as for any other entry.
 */
export function parseOperatorBindings(
  document: unknown,
  existing: readonly ToolBindingDefinition[] = BUILT_IN_BINDINGS,
): ToolBindingDefinition[] {
  const root = closedRecord(document, "tool bindings", ["schema", "bindings"], ["schema", "bindings"]);
  if (root.schema !== OPERATOR_BINDINGS_SCHEMA) {
    refuseBindings(`tool bindings schema must be ${OPERATOR_BINDINGS_SCHEMA}`);
  }
  if (!Array.isArray(root.bindings) || root.bindings.length > MAX_OPERATOR_BINDINGS) {
    refuseBindings(`bindings must be a list of at most ${MAX_OPERATOR_BINDINGS}`);
  }
  const ids = new Set(existing.map((item) => item.id));
  const toolIds = new Set(existing.map((item) => item.toolId));
  const names = new Set(existing.map((item) => item.binding));
  return root.bindings.map((raw, index) => {
    const field = `bindings[${index}]`;
    const entry = closedRecord(raw, field, OPERATOR_FIELDS, OPERATOR_REQUIRED);
    const id = boundedText(entry.id, `${field}.id`, 176, BINDING_ID);
    if (id.startsWith("openclaw:")) refuseBindings(`${field}.id must not use this plugin's own openclaw: namespace`);
    const toolId = boundedText(entry.tool_id, `${field}.tool_id`, 128, NAME);
    const binding = boundedText(entry.binding, `${field}.binding`, 128, NAME);
    if (binding.startsWith("host.resource.")) {
      refuseBindings(`${field}.binding must not use the host.resource. names of host-held resources`);
    }
    if (ids.has(id)) refuseBindings(`${field}.id is already registered on this host`);
    if (toolIds.has(toolId)) refuseBindings(`${field}.tool_id is already served by another binding on this host`);
    if (names.has(binding)) refuseBindings(`${field}.binding is already served by another binding on this host`);
    ids.add(id);
    toolIds.add(toolId);
    names.add(binding);
    if (entry.implementation_id !== OPERATOR_IMPLEMENTATION.id) {
      refuseBindings(
        `${field}.implementation_id must be ${OPERATOR_IMPLEMENTATION.id}: an operator entry cannot ` +
          "name another adapter or a local implementation",
      );
    }
    const endpoint = closedRecord(entry.endpoint, `${field}.endpoint`, ["origin", "path", "method"], [
      "origin",
      "path",
      "method",
    ]);
    const origin = safeOrigin(endpoint.origin);
    if (!origin) refuseBindings(`${field}.endpoint.origin must be an https origin on port 443 with no path or credentials`);
    const path = safePath(endpoint.path);
    if (!path) refuseBindings(`${field}.endpoint.path must be an absolute path with no query, fragment or '..'`);
    // The JSON adapter's contract is one JSON request body; a GET would drop
    // every argument, so it is refused rather than half-honoured.
    if (endpoint.method !== "POST") refuseBindings(`${field}.endpoint.method must be POST`);
    const digest = (value: unknown, name: string) => {
      if (typeof value !== "string" || !HEX64.test(value)) {
        refuseBindings(`${field}.${name} must be 64 lowercase hex characters`);
      }
      return value;
    };
    if (!Array.isArray(entry.permission_kinds) || entry.permission_kinds.length === 0 || entry.permission_kinds.length > 16) {
      refuseBindings(`${field}.permission_kinds must list 1 to 16 permission kinds`);
    }
    const kinds = entry.permission_kinds.map((kind, at) =>
      boundedText(kind, `${field}.permission_kinds[${at}]`, 64, KIND),
    );
    if (new Set(kinds).size !== kinds.length) refuseBindings(`${field}.permission_kinds has a duplicate`);
    if (entry.side_effects !== "read" && entry.side_effects !== "write") {
      refuseBindings(`${field}.side_effects must be read or write`);
    }
    const definition: ToolBindingDefinition = {
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
    if (entry.description !== undefined) {
      definition.description = boundedText(entry.description, `${field}.description`, 1000);
    }
    if (entry.max_request_bytes !== undefined) {
      definition.maxRequestBytes = boundedInteger(entry.max_request_bytes, `${field}.max_request_bytes`, 1, 64 * 1024);
    }
    if (entry.max_response_bytes !== undefined) {
      definition.maxResponseBytes = boundedInteger(
        entry.max_response_bytes,
        `${field}.max_response_bytes`,
        1024,
        4 * 1024 * 1024,
      );
    }
    if (entry.max_concurrent !== undefined) {
      definition.maxConcurrent = boundedInteger(entry.max_concurrent, `${field}.max_concurrent`, 1, 16);
    }
    if (entry.min_interval_ms !== undefined) {
      definition.minIntervalMs = boundedInteger(entry.min_interval_ms, `${field}.min_interval_ms`, 1, 60_000);
    }
    return definition;
  });
}

/**
 * Read an operator's bindings file: an absolute path to a regular file, not a
 * link, bounded, parsed as JSON. Its contents are validated by
 * `parseOperatorBindings`.
 */
export async function readOperatorBindingsFile(path: string): Promise<unknown> {
  if (typeof path !== "string" || !isAbsolute(path) || path.includes("\u0000")) {
    refuseBindings("tools.bindingsFile must be an absolute path");
  }
  let info;
  try {
    info = await lstat(path);
  } catch {
    refuseBindings("tools.bindingsFile does not exist");
  }
  if (info.isSymbolicLink() || !info.isFile()) refuseBindings("tools.bindingsFile must be a regular file");
  if (info.size > MAX_OPERATOR_BINDINGS_BYTES) {
    refuseBindings(`tools.bindingsFile exceeds ${MAX_OPERATOR_BINDINGS_BYTES} bytes`);
  }
  try {
    return JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch {
    refuseBindings("tools.bindingsFile is not valid JSON");
  }
}

/**
 * Apply operator configuration onto the built-ins.
 *
 * Configuration can disable a binding, relabel it, retarget an origin or path,
 * tighten a timeout, or attach a credential. It cannot invent an
 * implementation category, and it cannot add a binding for a tool this plugin
 * has no implementation for — a registry entry is a claim that code here can
 * serve it, and configuration is not code. (An operator bindings file adds
 * entries of the one implementation whose code is service-neutral, before
 * this runs; see `parseOperatorBindings`.)
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
      min_interval_ms: definition.minIntervalMs && definition.minIntervalMs > 0 ? definition.minIntervalMs : null,
    },
    // A name, never a value: `configured` is the only thing about a secret
    // that crosses this boundary, and it is enough to make a run plan stale
    // when one is attached or removed.
    credentials: {
      required,
      configured,
      source: definition.credential ? `env:${definition.credential.name}` : null,
    },
    ...(definition.kind === "host_resource" && definition.resourceType
      ? { resource_type: definition.resourceType }
      : {}),
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
  /** Host facts about how the entries were assembled, e.g. a rejected bindings file. */
  notes?: ToolRegistry["notes"];
}): ToolRegistry {
  const { definitions, notes: resolved } = resolveBindings(options.config, options.definitions);
  const notes = [...(options.notes ?? []), ...resolved];
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
