/**
 * `run` (D-064): execute any `workflow.v0` package the way `agentpkg run` does, through the
 * Chrome core's own execution layer, with agentpkg's flag names and report shape so the two
 * runtimes can be compared side by side (T7).
 *
 *   run <package.agent.pkg> --mode fixture|live --grants F [--input F] [--approve-tool ID]...
 *       [--trust-key PEM] [--limits F] --out DIR
 *       live: --model provider/model [--ollama-url URL] [--context-tokens N] [--think]
 *             [--reasoning-effort low|medium|high]
 *             [--tool-bindings F] [--host-resources F] [--resource-grant PERM=ID]...
 *
 * The operator is the host here: the grants file is the receipt and `--approve-tool` is the
 * approval, each tool named explicitly because approving an implementation is a separate
 * decision from granting the permission it travels under. Fixture mode replays the package's
 * own recorded answers and writes exactly agentpkg's file set; live mode binds the named model
 * through the host's own catalog probe, derives the tool bindings from the signed declaration
 * exactly as the Chrome host does (or takes an operator bindings file), and also writes
 * `run.json`, the Run Record. Keys come from `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` only.
 * Every request leaves through `cli-net.ts` (D-067): resolved, classified, pinned, capped.
 */
import { randomBytes } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { ArgumentError, parseArguments, type ArgumentSpec } from "./cli-arguments.js";
import { nodeComputeEngine } from "./cli-compute.js";
import { catalogHttp, nodeTransport } from "./cli-net.js";
import { AgentPkgError, ValidationError } from "./core/errors.js";
import { evaluateCatalog, type ModelDescriptor } from "./core/compatibility.js";
import { completeRunRecord, initialRunRecord } from "./core/execution/record.js";
import { ExecutionSession, type BeginReport, type ExecutionOutcome, type SessionDeps } from "./core/execution/runner.js";
import { normalizeHostLimits, PERMISSIVE_HOST_LIMITS } from "./core/execution/limits.js";
import { localExecutionPlan, type ExecutionPlan } from "./core/execution/plan.js";
import { fixtureAdapters } from "./core/fixtures.js";
import { checkMemoryBindings } from "./core/memory/run.js";
import { sha256Hex } from "./core/hash.js";
import { buildHostToolRegistry, evaluateRegistry, normalizeRegistry, planToolBindings, REGISTRY_SCHEMA } from "./core/hosttools.js";
import type { JsonObject, JsonValue } from "./core/json.js";
import { fingerprint, publicKeyFromPem } from "./core/keys.js";
import { normalizeModelBinding, type ModelBindingDescriptor } from "./core/models/binding.js";
import { buildHostCatalog, type ProviderConnection, type ProviderId } from "./core/models/catalog.js";
import { OPENAI_REASONING_EFFORTS, type OpenAIReasoningEffort } from "./core/models/adapters/openai.js";
import { adapterFor } from "./core/models/providers.js";
import { BoundModelRouter } from "./core/models/router.js";
import { loadPackageBytes, type Package } from "./core/package.js";
import { embeddedPublicKey, verifyWithTrustedKey } from "./core/signature.js";
import { normalizeToolBindings } from "./core/tools/bindings.js";
import { definitionsFromRegistry, describeDefinition, parseOperatorBindings, type CredentialSource, type ToolImplementationDefinition } from "./core/tools/definitions.js";
import { Pacer } from "./core/tools/pacer.js";
import { MemoryResourceStore } from "./core/tools/resources.js";
import type { ResourceGrant } from "./core/types.js";
import { CORE_VERSION } from "./core/version.js";

const RUN: ArgumentSpec = {
  positional: ["package"],
  options: {
    "--input": { kind: "value" },
    "--mode": { kind: "value", choices: ["fixture", "live"], default: "fixture" },
    "--grants": { kind: "value", required: true },
    "--trust-key": { kind: "value" },
    "--approve-tool": { kind: "list" },
    "--limits": { kind: "value" },
    "--out": { kind: "value", required: true },
    "--model": { kind: "value" },
    "--ollama-url": { kind: "value" },
    "--context-tokens": { kind: "value" },
    "--think": { kind: "flag" },
    "--reasoning-effort": { kind: "value", choices: [...OPENAI_REASONING_EFFORTS] },
    "--tool-bindings": { kind: "value" },
    "--host-resources": { kind: "value" },
    "--resource-grant": { kind: "list" },
  },
};

export const HOST_RUNTIME = "chrome-agent-browser";
const PROVIDERS: readonly ProviderId[] = ["ollama", "openai", "anthropic"];

function print(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function jsonFile(path: string, expected: "object" | "any"): JsonValue {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    throw new AgentPkgError(`cannot read ${path}: ${(error as NodeJS.ErrnoException).code ?? "error"}`);
  }
  let value: JsonValue;
  try {
    value = JSON.parse(text) as JsonValue;
  } catch {
    throw new AgentPkgError(`${path} is not valid JSON`);
  }
  if (expected === "object" && (typeof value !== "object" || value === null || Array.isArray(value))) throw new AgentPkgError(`${path} must contain a JSON object`);
  return value;
}

/** `agentpkg run --out`: a new private directory under an existing parent, files created exclusively. */
function prepareOutput(out: string): string {
  const target = resolve(out);
  let exists = false;
  try {
    lstatSync(target);
    exists = true;
  } catch {
    exists = false;
  }
  if (exists || !existsSync(dirname(target)) || !statSync(dirname(target)).isDirectory()) {
    throw new ValidationError("--out must name a new directory under an existing parent");
  }
  return target;
}

function writeFiles(directory: string, files: ReadonlyArray<readonly [string, Uint8Array]>): void {
  mkdirSync(directory, { mode: 0o700 });
  for (const [name, data] of files) writeFileSync(join(directory, name), data, { flag: "wx", mode: 0o600 });
}

function modelBindingFromDescriptor(descriptor: ModelDescriptor, compatibility: { status: string; evidence_strength: string } | null): ModelBindingDescriptor {
  return normalizeModelBinding({
    host_model_id: descriptor.id,
    provider_id: descriptor.provider_id,
    model_id: descriptor.model_id,
    display_name: descriptor.display_name,
    compatibility_status: compatibility?.status ?? null,
    evidence_strength: compatibility?.evidence_strength ?? null,
    // The catalog's answers carry `name` and `detail` beside `value` and `basis`; the binding keeps the two the runner reads.
    capabilities: Object.fromEntries(Object.entries(descriptor.capabilities).map(([name, answer]) => [name, { value: answer.value ?? null, basis: answer.basis ?? null }])),
    limits: descriptor.limits,
    properties: { local: descriptor.properties.local },
    pricing: null,
  });
}

interface LiveBinding {
  binding: ModelBindingDescriptor;
  definitions: ToolImplementationDefinition[];
  toolBindings: ReturnType<typeof normalizeToolBindings>;
  resourceGrants: ResourceGrant[];
  store: MemoryResourceStore | null;
  deps: SessionDeps;
}

async function bindLive(pkg: Package, parsed: ReturnType<typeof parseArguments>, bytes: Uint8Array, grants: Record<string, string>, approved: string[], modelCallTimeout: number): Promise<LiveBinding> {
  const model = parsed.value("--model");
  if (!model || !model.includes("/")) throw new AgentPkgError("Live workflow execution requires --input and --model provider/model");
  const slash = model.indexOf("/");
  const provider = model.slice(0, slash) as ProviderId;
  const modelId = model.slice(slash + 1);
  if (!PROVIDERS.includes(provider)) throw new AgentPkgError(`--model names an unknown provider '${provider}'; choose from ${PROVIDERS.join(", ")}`);
  const keys = { openai: process.env.OPENAI_API_KEY ?? null, anthropic: process.env.ANTHROPIC_API_KEY ?? null };
  const contextTokens = parsed.value("--context-tokens");
  let override: { context_tokens?: number } = {};
  if (contextTokens !== null) {
    const parsedTokens = Number(contextTokens);
    if (!Number.isInteger(parsedTokens) || parsedTokens < 1) throw new AgentPkgError("--context-tokens must be a positive integer");
    override = { context_tokens: parsedTokens };
  }
  const ollamaUrl = parsed.value("--ollama-url");
  const connection: ProviderConnection = {
    provider,
    enabled: true,
    base_url: provider === "ollama" ? ollamaUrl : null,
    key_configured: provider === "openai" ? keys.openai !== null : provider === "anthropic" ? keys.anthropic !== null : true,
    overrides: { [modelId]: override },
  };
  const { catalog, probes } = await buildHostCatalog([connection], catalogHttp(keys), { builtin: null, runtimeVersion: CORE_VERSION });
  const descriptor = catalog.models.find((item) => item.id === model);
  if (descriptor === undefined) {
    const probe = probes[0];
    const offered = catalog.models.map((item) => item.id).sort();
    throw new AgentPkgError(`selected_model_unavailable: this host does not offer ${model}${probe?.error ? ` (${probe.error})` : offered.length > 0 ? `; it offers ${offered.join(", ")}` : ""}`);
  }
  const compatibility = evaluateCatalog(pkg, catalog).models.find((item) => item.model_id === model) ?? null;
  const binding = modelBindingFromDescriptor(descriptor, compatibility);
  const adapter = adapterFor(binding, {
    transport: nodeTransport({ allowLoopbackHttp: provider === "ollama" }),
    ollama: { baseUrl: ollamaUrl ?? undefined, think: parsed.flag("--think") },
    openai: { apiKey: keys.openai, ...(parsed.value("--reasoning-effort") !== null ? { reasoningEffort: parsed.value("--reasoning-effort") as OpenAIReasoningEffort } : {}) },
    anthropic: { apiKey: keys.anthropic },
  });
  const router = new BoundModelRouter(adapter, { requestTimeoutSeconds: modelCallTimeout });

  // Host resources: the demo host's format, under a fresh key for this process.
  const resourcesPath = parsed.value("--host-resources");
  const store = resourcesPath ? await MemoryResourceStore.load(jsonFile(resourcesPath, "object"), { key: new Uint8Array(randomBytes(32)) }) : null;
  const resourceGrants: ResourceGrant[] = [];
  for (const entry of parsed.list("--resource-grant")) {
    const equals = entry.indexOf("=");
    if (equals <= 0) throw new AgentPkgError("--resource-grant takes PERMISSION_ID=RESOURCE_ID");
    const permissionId = entry.slice(0, equals);
    const resourceId = entry.slice(equals + 1);
    const view = store?.describe(resourceId);
    if (!view) throw new AgentPkgError(`--resource-grant names a resource this host does not hold: ${resourceId}`);
    resourceGrants.push({ permission_id: permissionId, resource_type: view.type, resource_id: view.id, resource_digest: view.digest });
  }

  // Tool bindings: the Chrome host's own registry (one generic HTTPS JSON binding per declared
  // remote tool, one host-resource binding per held type), or an operator bindings file for
  // the remote tools.
  const now = new Date();
  const chromeRegistry = await buildHostToolRegistry(pkg, {
    resourceTypes: (store?.typeViews() ?? []).map((type) => ({ id: type.id, display_name: type.displayName, permission_kind: type.permissionKind, schema_sha256: type.schemaSha256 })),
    runtimeVersion: CORE_VERSION,
    now,
  });
  let definitions = definitionsFromRegistry(chromeRegistry);
  const bindingsPath = parsed.value("--tool-bindings");
  if (bindingsPath) {
    const local = definitions.filter((definition) => definition.kind !== "json_http");
    definitions = [...local, ...parseOperatorBindings(jsonFile(bindingsPath, "object"), local)];
  }
  const credentials = (credential: CredentialSource): string | null => (credential.kind === "env" ? (process.env[credential.name] ?? null) : null);
  const registry = await normalizeRegistry({
    schema: REGISTRY_SCHEMA,
    host: { runtime: HOST_RUNTIME, runtime_version: CORE_VERSION, source: bindingsPath ? `${chromeRegistry.host.source}; remote tools from the operator bindings file` : chromeRegistry.host.source, captured_at: now.toISOString(), agent_id: null },
    bindings: definitions.map((definition) => describeDefinition(definition, { credentialConfigured: (credential) => credentials(credential) !== null })),
    notes: chromeRegistry.notes,
  });
  const approvals = Object.fromEntries(Object.keys(pkg.tools).map((toolId) => [toolId, approved.includes(toolId)]));
  const evaluation = await evaluateRegistry(pkg, registry, { decisions: grants as Record<string, "deny" | "once" | "session">, toolApprovals: approvals, now });
  // As `buildRunPlan` (D-022): a plan binds the approved tools; a denied tool has no binding and the runtime refuses calls to it.
  const toolBindings = normalizeToolBindings(planToolBindings(evaluation).filter((binding) => binding.approved));
  const observe = (request: { url: string }) => process.stderr.write(`agent-browser: tool request to ${request.url}\n`);
  const deps: SessionDeps = {
    archive: bytes,
    router,
    tools: { definitions, transport: nodeTransport({ allowLoopbackHttp: false }), credentials, pacer: new Pacer(), observe },
    resolver: store,
    compute: nodeComputeEngine(),
  };
  return { binding, definitions, toolBindings, resourceGrants, store, deps };
}

export async function runCommand(args: string[]): Promise<number> {
  const parsed = parseArguments("run", args, RUN);
  const mode = parsed.value("--mode") as "fixture" | "live";
  const out = prepareOutput(parsed.value("--out")!);
  const bytes = new Uint8Array(readFileSync(parsed.positional.package!));
  const pkg = await loadPackageBytes(bytes);
  if (pkg.manifest.entrypoint !== "workflow.v0") throw new AgentPkgError("Generic execution requires workflow.v0; use agentpkg-legacy for the archived development profile");
  const trustKey = parsed.value("--trust-key");
  if (mode === "live" && !trustKey) throw new AgentPkgError("Live run requires a signed artifact and --trust-key PUBLIC_KEY");
  if (trustKey) await verifyWithTrustedKey(pkg, publicKeyFromPem(readFileSync(trustKey, "utf8")));
  if (pkg.signature === null) throw new AgentPkgError("This runner executes signed packages only; sign the artifact first (agentpkg sign)");
  const signer = await fingerprint(await embeddedPublicKey(pkg.signature));
  const grants = jsonFile(parsed.value("--grants")!, "object") as Record<string, string>;
  const approved = [...new Set(parsed.list("--approve-tool"))].sort();
  // As `agentpkg run`: without `--limits` the host lowers nothing, and the package's own budget
  // and deadline apply; `--limits` is the host execution limits document (D-064).
  const limitsRaw: JsonValue = parsed.value("--limits") ? jsonFile(parsed.value("--limits")!, "object") : { ...PERMISSIVE_HOST_LIMITS };
  const limits = normalizeHostLimits(limitsRaw);
  const inputPath = parsed.value("--input");
  const archiveSha256 = await sha256Hex(bytes);
  // memory.v0 M-16, M-64 N6: a memory read whose output is not the type's view is not bound, so
  // the run is refused before it starts, in both modes, as `agentpkg run` refuses it (D-230).
  checkMemoryBindings(pkg);

  let plan: ExecutionPlan;
  let authorization;
  let input: JsonValue;
  let deps: SessionDeps;
  let live: LiveBinding | null = null;
  if (mode === "fixture") {
    for (const flag of ["--model", "--ollama-url", "--context-tokens", "--reasoning-effort", "--tool-bindings", "--host-resources"]) {
      if (parsed.value(flag) !== null) throw new AgentPkgError(`${flag} applies to --mode live only`);
    }
    if (parsed.flag("--think") || parsed.list("--resource-grant").length > 0) throw new AgentPkgError("--think and --resource-grant apply to --mode live only");
    const fixture = fixtureAdapters(pkg);
    input = inputPath ? jsonFile(inputPath, "any") : fixture.input;
    ({ plan, authorization } = localExecutionPlan({ pkg, archiveSha256, signerFingerprint: signer, decisions: grants, approvedTools: approved, fixture: true }));
    // compute.v0 (C-50): a module runs for real in fixture mode, in a Worker per call (D-251).
    deps = { archive: bytes, fixture: { router: fixture.router, handlers: fixture.handlers }, compute: nodeComputeEngine() };
  } else {
    if (!inputPath) throw new AgentPkgError("Live workflow execution requires --input and --model provider/model");
    input = jsonFile(inputPath, "any");
    live = await bindLive(pkg, parsed, bytes, grants, approved, limits.model_call_timeout_seconds);
    ({ plan, authorization } = localExecutionPlan({ pkg, archiveSha256, signerFingerprint: signer, decisions: grants, approvedTools: approved, fixture: false, modelBinding: live.binding, toolBindings: live.toolBindings, resourceGrants: live.resourceGrants }));
    deps = live.deps;
  }

  const session = new ExecutionSession();
  const runId = `run_${randomBytes(16).toString("hex")}`;
  const created = new Date();
  const begin: BeginReport = await session.begin({ run_id: runId, run_plan: plan, authorization, input, limits: limitsRaw, host: { runtime: HOST_RUNTIME, runtime_version: CORE_VERSION, verified_version: CORE_VERSION } }, deps);
  const onSignal = () => {
    process.stderr.write("agent-browser: cancelling the run\n");
    session.cancel();
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  const started = new Date();
  let outcome: ExecutionOutcome;
  try {
    outcome = await session.run();
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  }
  const ended = new Date();
  const files: Array<readonly [string, Uint8Array]> = [...outcome.files];
  if (mode === "live") {
    const record = completeRunRecord(
      initialRunRecord({ begin, plan, createdAt: created, startedAt: started, host: { runtimeVersion: CORE_VERSION, verifiedVersion: CORE_VERSION }, revalidated: ["cli:trust_key"], origin: "live" }),
      outcome.result,
      ended,
    );
    files.push(["run.json", new TextEncoder().encode(`${JSON.stringify(record, null, 2)}\n`)]);
  }
  writeFiles(out, files);
  const result = outcome.result;
  if (result.status !== "completed") {
    const failure = result.failure as JsonObject | null;
    // agentpkg's line (D-064): the node only. The step stays in result.json's audit; naming it
    // here made the two runtimes' refusals differ (found by the conformance suite, T7).
    const node = failure && typeof failure.node_id === "string" ? failure.node_id : null;
    process.stderr.write(`agent-browser: workflow.v0 ${result.error_code ?? "worker_error"}${node ? ` at node ${node}` : ""}\n`);
    return 2;
  }
  const report: JsonObject = {
    status: result.status,
    profile: "workflow.v0",
    output_directory: out,
    usage: result.usage!,
    approved_tools: approved,
    fixture_replay: mode === "fixture",
    passed: true,
  };
  if (mode === "live") {
    report.model = result.model!;
    report.run_record = join(out, "run.json");
  }
  print(report);
  return 0;
}

export { ArgumentError };
