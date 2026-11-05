/**
 * The `Cr` live driver (PROTOCOL.md §2.1, D-353): the Chrome core composed as `cli-converse.ts`
 * composes a live conversation, except the record source, which is composed as the extension's
 * host composes it (`src/extension/execution/execute.ts`): the core's `MemoryStore` opened in Node
 * over the campaign record set is the resolver, and a `MemoryRun` built from it (its `scanSet()`,
 * the granted records as targets, the package's agent document) is each turn's `memory`, so both
 * egress scans are active on `Cr` as on `Py` (P-13's scope). Nothing under `src/` is changed: this
 * file is type-checked and bundled beside a private copy of the core (`driver/cr_driver.py`).
 *
 * The campaign's seams, as on `Py`:
 * - the **host mapping**: `tls.connect` is wrapped for this process (`syncBuiltinESMExports`) so
 *   that a connection whose `servername` is a mapped public hostname dials the campaign stack on
 *   127.0.0.1 and trusts the campaign CA; the hostname's real DNS answer is still resolved and
 *   classified by `cli-net.ts` before the dial; every lookup (its answer, or that it failed) and
 *   every dial is logged, so a failed lookup is a harness error on `Cr` as on `Py` (review 1,
 *   finding 4: the lookup fails before any dial); the run's fixture key header
 *   is added to tool requests for the campaign origin by a wrapper of the tool transport;
 * - the **route**: the core's own adapter on the rung's provider, with `temperature` set by a
 *   wrapper of the model transport (the core sends none), and the observer recording every
 *   request body; the `refuse` route is a router that records and refuses every call (tests);
 * - the **consent host**: the responder's rule (`driver/responder.py`, R-facts / R-accept / R-deny)
 *   over the card's facts, the same normalisation;
 * - observation-only wrappers of the tool handlers.
 *
 * Two modes (D-357, D-359): `conversation` (WebAir, TS-W and TS-C) composes `Conversation` as
 * `cli-converse.ts` does; `run` (the travel network, TS-N; Literature Review, TS-L) composes
 * `ExecutionSession` as `cli-run.ts` does (`localExecutionPlan` over the signed package, the host
 * tool registry and its evaluation, the bound model; `session.begin` with the host's permissive
 * limits, then `session.run`), with the same record source (the store as `deps.resolver`, a
 * `MemoryRun` over it as `deps.memory`), host mapping and route. The session builds its tool
 * handlers itself, so a run's tool calls are observed at the tool transport, each request paired
 * with the core's own `observe` report (tool id, binding, the exact URL and body), and the answer
 * the package received is recomputed from the response with the core's own adapter for that
 * binding (`HTTP_ADAPTERS`, `CROSSREF_WORKS_ADAPTER`): observation only.
 *
 * Input: one JSON job on stdin. Output: one JSON report on stdout.
 */
import { syncBuiltinESMExports } from "node:module";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import tls from "node:tls";

import { nodeComputeEngine } from "../src/cli-compute.js";
import { catalogHttp, defaultResolver, nodeTransport, type Resolver } from "../src/cli-net.js";
import { evaluateCatalog } from "../src/core/compatibility.js";
import type { ConsentHost, ConsentRequest } from "../src/core/conversation/host.js";
import { Conversation } from "../src/core/conversation/runner.js";
import { checkTranscript, readInputTranscript } from "../src/core/conversation/transcript.js";
import { buildHostToolRegistry, evaluateRegistry, normalizeRegistry, planToolBindings, REGISTRY_SCHEMA } from "../src/core/hosttools.js";
import type { JsonObject, JsonValue } from "../src/core/json.js";
import { fingerprint, publicKeyFromPem } from "../src/core/keys.js";
import { agentToolDigests, requestedResourceTypes } from "../src/core/memory/declarations.js";
import { documentToRecord } from "../src/core/memory/document.js";
import { RELATIONS, type MemoryRecord } from "../src/core/memory/model.js";
import { checkMemoryBindings, MemoryRun } from "../src/core/memory/run.js";
import { emptyMemorySnapshot, MemoryStore } from "../src/core/memory/store.js";
import { normalizeModelBinding } from "../src/core/models/binding.js";
import { buildHostCatalog, type ProviderConnection, type ProviderId } from "../src/core/models/catalog.js";
import type { ModelRouter } from "../src/core/models/contract.js";
import { adapterFor } from "../src/core/models/providers.js";
import { BoundModelRouter } from "../src/core/models/router.js";
import type { HttpTransport, OutboundModelRequest } from "../src/core/models/transport.js";
import { loadPackageBytes, type Package } from "../src/core/package.js";
import { embeddedPublicKey, verifyWithTrustedKey } from "../src/core/signature.js";
import { sha256Hex } from "../src/core/hash.js";
import { ExecutionSession } from "../src/core/execution/runner.js";
import { PERMISSIVE_HOST_LIMITS } from "../src/core/execution/limits.js";
import { localExecutionPlan } from "../src/core/execution/plan.js";
import { CROSSREF_WORKS_ADAPTER } from "../src/core/tools/adapters/crossref.js";
import { HTTP_ADAPTERS } from "../src/core/tools/adapters/json-http.js";
import type { ModelBindingDescriptor } from "../src/core/models/binding.js";
import { normalizeToolBindings } from "../src/core/tools/bindings.js";
import { toolHandlers } from "../src/core/tools/broker.js";
import { definitionsFromRegistry, describeDefinition, type CredentialSource } from "../src/core/tools/definitions.js";
import type { ToolHandler } from "../src/core/tools/handler.js";
import { Pacer } from "../src/core/tools/pacer.js";
import type { ResourceGrant } from "../src/core/types.js";
import { CORE_VERSION } from "../src/core/version.js";

const HOST_RUNTIME = "chrome-agent-browser";
const HEADER = "X-Campaign-Fixture";

interface Route {
  kind: "ollama" | "openai" | "refuse";
  model: string;
  base_url?: string | null;
  context_window?: number;
  temperature?: number | null;
  think?: boolean | null;
  api_key_env?: string | null;
  timeout_seconds?: number;
}

interface Job {
  /** `conversation` (the default, WebAir) or `run` (a one-shot `workflow.v0` run, as `cli-run.ts`). */
  mode?: "conversation" | "run";
  /** The run's input (mode `run`). */
  input?: JsonValue;
  package: string;
  trust_key: string;
  transcript?: JsonObject;
  grants: Record<string, string>;
  approved_tools: string[];
  records: string[];
  memory_grants: Record<string, string>;
  route: Route;
  mapping: { hosts: Record<string, [string, number]>; ca: string; fixture_key: string | null; fixture_hosts: string[] } | null;
  responder: { kind: "R-facts" | "R-accept" | "R-deny"; expected: JsonObject; purchase_turns: number[] };
  probe_proposals?: JsonValue;
  /** Offline tests only: one GET through the tool transport (its resolver seam), no conversation. */
  probe_fetch?: string;
  /** Offline tests only: the run mode's recording transport over canned responses (its pairing with `observe` and the adapters' answers). */
  probe_record?: { observed: Observed[]; requests: { url: string; method: string; body: string | null }[]; responses: { status: number; body: string }[] };
  /** Offline tests only: the responder's decisions on these cards (rule 11 with `responder.py`). */
  probe_consent?: { turn: number; facts: JsonValue }[];
}

const dials: JsonObject[] = [];
const modelCalls: JsonObject[] = [];
const toolCalls: JsonObject[] = [];
const consent: JsonObject[] = [];
const decisions: JsonObject[] = [];

/** The host mapping: only the dial of a mapped hostname moves, after `cli-net.ts` classified its real answer. */
function installMapping(mapping: NonNullable<Job["mapping"]>): void {
  const ca = readFileSync(mapping.ca, "utf8");
  const original = tls.connect;
  const mapped = ((options: tls.ConnectionOptions, ...rest: unknown[]) => {
    const name = typeof options === "object" && options !== null ? options.servername : undefined;
    const target = name ? mapping.hosts[name] : undefined;
    if (!name || target === undefined) {
      // An unmapped dial goes where the core sent it; it is a dial all the same (boundary (a)).
      const dialed = options?.host ? [options.host, options.port ?? 443] : null;
      dials.push({ at: Date.now() / 1000, host: name ?? null, address: options?.host ?? null, mapped: false, dialed });
      return (original as (...args: unknown[]) => tls.TLSSocket)(options, ...rest);
    }
    dials.push({ at: Date.now() / 1000, host: name, address: options.host ?? null, mapped: true, dialed: target });
    return (original as (...args: unknown[]) => tls.TLSSocket)({ ...options, host: target[0], port: target[1], ca }, ...rest);
  }) as typeof tls.connect;
  tls.connect = mapped;
  syncBuiltinESMExports();
}

/** The core's own resolver, observed: each lookup and its answer (or its failure) in the dial log. */
const loggedResolver: Resolver = async (hostname) => {
  const entry: JsonObject = { at: Date.now() / 1000, kind: "lookup", host: hostname };
  dials.push(entry);
  try {
    const addresses = await defaultResolver(hostname);
    entry.lookup = { ok: true, addresses };
    return addresses;
  } catch (error) {
    entry.lookup = { ok: false, error: (error as Error).name };
    throw error;
  }
};

function toolTransport(mapping: Job["mapping"]): HttpTransport {
  const base = nodeTransport({ allowLoopbackHttp: false, resolve: loggedResolver });
  if (mapping === null || mapping.fixture_key === null) return base;
  const key = mapping.fixture_key;
  return (request) => {
    const host = new URL(request.url).hostname;
    return base(mapping.fixture_hosts.includes(host) ? { ...request, headers: { ...request.headers, [HEADER]: key } } : request);
  };
}

/** The provider's own token counts on the answer, onto the request the observer recorded last. */
function recordUsage(kind: Route["kind"], text: string, status: number): void {
  const entry = modelCalls[modelCalls.length - 1];
  if (entry === undefined) return;
  entry.status = status;
  try {
    const answer = JSON.parse(text) as JsonObject;
    const usage = (answer.usage ?? {}) as JsonObject;
    entry.usage = kind === "ollama" ? { input_tokens: answer.prompt_eval_count ?? null, output_tokens: answer.eval_count ?? null } : { input_tokens: usage.input_tokens ?? null, output_tokens: usage.output_tokens ?? null };
  } catch {
    entry.usage = null;
  }
}

/** The core sends no sampling temperature; the campaign's (rule 2) is added to the body here, and
 * the answer's token counts are recorded (observation only). */
function modelTransport(route: Route): HttpTransport {
  const base = nodeTransport({ allowLoopbackHttp: route.kind === "ollama" });
  const temperature = route.temperature;
  return async (request) => {
    let sent = request;
    if (request.body !== null && temperature !== null && temperature !== undefined) {
      const body = JSON.parse(request.body) as JsonObject;
      if (route.kind === "ollama") body.options = { ...((body.options as JsonObject) ?? {}), temperature };
      else body.temperature = temperature;
      sent = { ...request, body: JSON.stringify(body) };
    }
    const response = await base(sent);
    if (request.method === "POST") recordUsage(route.kind, response.body, response.status);
    return response;
  };
}

class RefusingRouter implements ModelRouter {
  readonly remote = false;
  readonly model_id = "ollama/campaign-refuse";
  readonly router_id = "campaign-refuse";
  readonly capabilities: ReadonlySet<string> = new Set(["structured_output", "reasoning"]);
  readonly context_window = 1_000_000;
  readonly countsRemotely = false;
  async countTokens(): Promise<number> {
    return 1;
  }
  async complete(request: unknown): Promise<never> {
    modelCalls.push({ at: Date.now() / 1000, outcome: "refused_by_test_route", request: request as JsonValue });
    throw Object.assign(new Error("the test route answers nothing"), { code: "model_unavailable" });
  }
}

/** The test route's binding, so that a `run` plan can name it (the session checks the router against the plan). */
function refusingBinding(): ModelBindingDescriptor {
  return normalizeModelBinding({
    host_model_id: "ollama/campaign-refuse",
    provider_id: "ollama",
    model_id: "campaign-refuse",
    display_name: "campaign refuse (offline tests)",
    compatibility_status: null,
    evidence_strength: null,
    capabilities: { structured_output: { value: true, basis: null }, reasoning: { value: true, basis: null } },
    limits: { context_tokens: 1_000_000 },
    properties: { local: true },
    pricing: null,
  });
}

async function bindRouter(pkg: Package, route: Route): Promise<ModelRouter> {
  return (await bindModel(pkg, route)).router;
}

/** The rung's router and the binding a plan names (`cli-run.ts`'s `bindLive` model half). */
async function bindModel(pkg: Package, route: Route): Promise<{ router: ModelRouter; binding: ModelBindingDescriptor }> {
  if (route.kind === "refuse") return { router: new RefusingRouter(), binding: refusingBinding() };
  const provider = route.kind as ProviderId;
  const key = route.api_key_env ? (process.env[route.api_key_env] ?? null) : null;
  const connection: ProviderConnection = {
    provider,
    enabled: true,
    base_url: route.base_url ?? null,
    key_configured: provider === "ollama" ? true : key !== null,
    overrides: { [route.model]: route.context_window ? { context_tokens: route.context_window } : {} },
  };
  const { catalog, probes } = await buildHostCatalog([connection], catalogHttp({ openai: provider === "openai" ? key : null, anthropic: null }), { builtin: null, runtimeVersion: CORE_VERSION });
  const descriptor = catalog.models.find((item) => item.id === `${provider}/${route.model}`);
  if (descriptor === undefined) throw new Error(`selected_model_unavailable: ${provider}/${route.model}${probes[0]?.error ? ` (${probes[0].error})` : ""}`);
  const compatibility = evaluateCatalog(pkg, catalog).models.find((item) => item.model_id === descriptor.id) ?? null;
  const binding = normalizeModelBinding({
    host_model_id: descriptor.id,
    provider_id: descriptor.provider_id,
    model_id: descriptor.model_id,
    display_name: descriptor.display_name,
    compatibility_status: compatibility?.status ?? null,
    evidence_strength: compatibility?.evidence_strength ?? null,
    capabilities: Object.fromEntries(Object.entries(descriptor.capabilities).map(([name, answer]) => [name, { value: answer.value ?? null, basis: answer.basis ?? null }])),
    limits: descriptor.limits,
    properties: { local: descriptor.properties.local },
    pricing: null,
  });
  const observer = (request: OutboundModelRequest) => modelCalls.push({ at: Date.now() / 1000, url: request.url, model_id: request.model_id, body: request.body });
  const adapter = adapterFor(binding, {
    transport: modelTransport(route),
    observer,
    // Qwen3.5 thinks by default (PROTOCOL.md §2.2); the core sends `think` explicitly, so the
    // model's default is passed when the rung states none.
    ollama: { baseUrl: route.base_url ?? undefined, think: route.think ?? true },
    openai: { apiKey: key },
  });
  return { router: new BoundModelRouter(adapter, { requestTimeoutSeconds: route.timeout_seconds ?? 600 }), binding };
}

/** `driver/responder.py`'s rule over the card's facts (`card_facts`), the same normalisation. */
class ResponderHost implements ConsentHost {
  readonly used = new Set<string>();
  constructor(private readonly responder: Job["responder"]) {}
  async decide(request: ConsentRequest): Promise<unknown> {
    const facts = (request.facts ?? {}) as JsonObject;
    const passenger = (facts.passenger ?? {}) as JsonObject;
    const normal: JsonObject = { quote_id: facts.quote_id ?? null, fare_id: facts.fare_id ?? null, total_usd: facts.total_usd ?? null, passenger: [passenger.given_name ?? null, passenger.family_name ?? null] };
    let accepted: boolean;
    if (this.responder.kind === "R-accept") accepted = true;
    else if (this.responder.kind === "R-deny") accepted = false;
    else {
      // Only in a turn where the task asks for a purchase (review 2, finding 1), as responder.py.
      const expected = this.responder.expected ?? {};
      accepted =
        (this.responder.purchase_turns ?? []).includes(request.turn) &&
        Object.keys(expected).length > 0 &&
        Object.entries(expected).every(([key, value]) => JSON.stringify(normal[key]) === JSON.stringify(value));
    }
    const at = Date.now() / 1000;
    decisions.push({ at, seat: "consent_host", step: request.step, turn: request.turn, facts: normal, accepted });
    consent.push({ at, turn: request.turn, step: request.step, permissions: [...request.permissions], text: request.text, facts: request.facts, accepted });
    this.used.add(request.step);
    return { accepted, decided_by: "person", reason: null };
  }
}

function recorded(handlers: Record<string, ToolHandler>, toolIds: Record<string, string>, turn: number): Record<string, ToolHandler> {
  const out: Record<string, ToolHandler> = {};
  for (const [binding, handler] of Object.entries(handlers)) {
    out[binding] = async (context, payload, signal, bounds) => {
      const entry: JsonObject = { at: Date.now() / 1000, turn, binding, tool: toolIds[binding] ?? binding, role: null, arguments: payload };
      toolCalls.push(entry);
      try {
        const answer = await handler(context, payload, signal, bounds);
        entry.outcome = "answered";
        entry.answer = answer;
        return answer;
      } catch (error) {
        entry.outcome = "threw";
        entry.error = (error as Error).name;
        throw error;
      }
    };
  }
  return out;
}

function parseRecords(texts: string[]): MemoryRecord[] {
  return texts.map((text) => {
    const { record } = documentToRecord(text);
    // The folder's relations are wikilinks by title; the campaign's records need no edges.
    const bare = record as unknown as Record<string, unknown>;
    for (const relation of RELATIONS) delete bare[relation];
    return record;
  });
}

async function main(): Promise<void> {
  const job = JSON.parse(readFileSync(0, "utf8")) as Job;
  if (job.mapping !== null) installMapping(job.mapping);
  if (job.probe_fetch !== undefined) {
    let error: string | null = null;
    try {
      await toolTransport(job.mapping)({ url: job.probe_fetch, method: "GET", headers: {}, body: null, signal: AbortSignal.timeout(30_000), maxResponseBytes: 65_536 });
    } catch (failure) {
      error = (failure as Error).name;
    }
    emit({ probe: "fetch", error, dials });
    return;
  }
  if (job.probe_record !== undefined) {
    const probe = job.probe_record;
    let index = 0;
    const canned: HttpTransport = async () => {
      const answer = probe.responses[index++]!;
      return { status: answer.status, headers: {}, body: answer.body };
    };
    const pending = [...probe.observed];
    const transport = recordingTransport(canned, pending);
    for (const request of probe.requests) {
      await transport({ url: request.url, method: request.method as "GET" | "POST", headers: {}, body: request.body, signal: AbortSignal.timeout(5_000), maxResponseBytes: 1 << 20 });
    }
    emit({ probe: "record", tool_calls: toolCalls, pending: pending as unknown as JsonValue });
    return;
  }
  if (job.probe_consent !== undefined) {
    const host = new ResponderHost(job.responder);
    for (const card of job.probe_consent) {
      await host.decide({ conversation_id: "probe", turn: card.turn, step: "consent-purchase", permissions: [], text: "", facts: card.facts, timeout_seconds: 1 });
    }
    emit({ probe: "consent", decisions });
    return;
  }
  const bytes = new Uint8Array(readFileSync(job.package));
  const pkg = await loadPackageBytes(bytes);
  await verifyWithTrustedKey(pkg, publicKeyFromPem(readFileSync(job.trust_key, "utf8")));
  checkMemoryBindings(pkg);
  const now = () => new Date();
  const snapshot = emptyMemorySnapshot();
  snapshot.records = parseRecords(job.records);
  const store = await MemoryStore.open({ key: new Uint8Array(randomBytes(32)), snapshot, now });
  const permissions = new Map((pkg.policy.permissions as JsonObject[]).map((p) => [String(p.id), p]));
  const resourceGrants: ResourceGrant[] = [];
  for (const [permissionId, recordId] of Object.entries(job.memory_grants)) {
    const resourceType = String(((permissions.get(permissionId)?.resources as string[]) ?? [])[0]);
    const view = store.describe(recordId, resourceType);
    if (!view) throw new Error(`the record set holds no ${resourceType} ${recordId}`);
    resourceGrants.push({ permission_id: permissionId, resource_type: resourceType, resource_id: view.id, resource_digest: view.digest });
  }
  store.grantedIds = new Set(resourceGrants.map((grant) => grant.resource_id));
  const targets = new Map<string, Pick<MemoryRecord, "sealed" | "type">>();
  for (const id of store.grantedIds) {
    const record = store.get(id);
    if (record) targets.set(id, { sealed: record.sealed, type: record.type });
  }
  const agentDocument = store.agentDocument(String(pkg.manifest.package_id));
  const memoryRun = () =>
    new MemoryRun(pkg, resourceGrants, job.grants, {
      scan: store.scanSet(),
      targets,
      agentDocument: agentDocument ? { body: agentDocument.body, updated: agentDocument.updated } : null,
    });
  if (job.probe_proposals !== undefined) {
    // The composed memory context's proposal check (M-40), without a model.
    try {
      const checked = await memoryRun().checkProposals(job.probe_proposals);
      emit({ probe: "proposals", refused: null, facts: checked.facts as unknown as JsonValue });
    } catch (error) {
      const refusal = error as Error & { code?: string; reason?: string; facts?: JsonObject };
      emit({ probe: "proposals", refused: { name: refusal.name, code: refusal.code ?? null, reason: refusal.reason ?? refusal.facts?.reason ?? null, message: refusal.message } });
    }
    return;
  }
  const registry0 = await buildHostToolRegistry(pkg, {
    resourceTypes: store.resourceTypeFacts(requestedResourceTypes(pkg.policy)),
    agentTools: agentToolDigests(),
    runtimeVersion: CORE_VERSION,
    now: now(),
  });
  const definitions = definitionsFromRegistry(registry0);
  const credentials = (_credential: CredentialSource): string | null => null;
  const registry = await normalizeRegistry({
    schema: REGISTRY_SCHEMA,
    host: { runtime: HOST_RUNTIME, runtime_version: CORE_VERSION, source: registry0.host.source, captured_at: now().toISOString(), agent_id: null },
    bindings: definitions.map((definition) => describeDefinition(definition, { credentialConfigured: () => false })),
    notes: registry0.notes,
  });
  const approvals = Object.fromEntries(Object.keys(pkg.tools).map((toolId) => [toolId, job.approved_tools.includes(toolId)]));
  const evaluation = await evaluateRegistry(pkg, registry, { decisions: job.grants as Record<string, "deny" | "once" | "session">, toolApprovals: approvals, now: now() });
  const toolBindings = normalizeToolBindings(planToolBindings(evaluation).filter((binding) => binding.approved));
  const toolIds = Object.fromEntries(Object.entries(pkg.tools).map(([id, tool]) => [String((tool as JsonObject).binding), id]));
  const engine = nodeComputeEngine(new URL("./compute-worker.js", import.meta.url));
  if (job.mode === "run") {
    await runMode({ job, pkg, bytes, definitions, toolBindings, resourceGrants, store, memoryRun: memoryRun(), engine });
    return;
  }
  const router = await bindRouter(pkg, job.route);
  const transport = toolTransport(job.mapping);
  const transcript = await readInputTranscript(job.transcript!, "campaign");
  await checkTranscript(transcript, pkg, job.grants as never);
  const host = new ResponderHost(job.responder);
  const conversation = new Conversation(pkg, {
    grants: job.grants as never,
    approvedTools: job.approved_tools,
    adapters: (turn: number) => {
      const { handlers } = toolHandlers(toolBindings, { definitions, transport, credentials, pacer: new Pacer(), resources: { grants: resourceGrants, resolver: store } });
      return { router, handlers: recorded(handlers, toolIds, turn), memory: memoryRun(), compute: engine };
    },
    consent: () => host,
  });
  let result: JsonObject | null = null;
  let error: string | null = null;
  try {
    result = (await conversation.run(transcript)) as unknown as JsonObject;
  } catch (failure) {
    error = `${(failure as Error).name}: ${(failure as Error).message}`.slice(0, 500);
  }
  emit({
    status: result ? result.status : "harness_error",
    error,
    transcript: result ? result.transcript : null,
    audit: result ? result.audit : null,
    usage: result ? result.usage : null,
    model_calls: modelCalls,
    tool_calls: toolCalls,
    consent,
    responder: decisions,
    dials,
    core_version: CORE_VERSION,
  });
}

/** The transport's view of one tool request, paired with the core's own `observe` report. */
interface Observed {
  tool_id: string;
  binding_id: string;
  url: string;
  body: string | null;
}

/** The arguments the package sent, read back from the request: the JSON body of a POST, else the
 * query (the Crossref binding's `query.bibliographic` and `rows` are the declared `query` and `limit`). */
function argumentsOf(request: { url: string; body: string | null }, crossref: boolean): JsonValue {
  if (request.body !== null) {
    try {
      return JSON.parse(request.body) as JsonValue;
    } catch {
      return request.body;
    }
  }
  const params = new URL(request.url).searchParams;
  if (crossref) return { query: params.get("query.bibliographic") ?? "", limit: Number(params.get("rows") ?? 0) };
  return Object.fromEntries(params.entries());
}

/**
 * The run's tool transport with its observation seam (D-359): each request is recorded with the
 * tool the core said it was for (`observe`, called just before the transport with the exact URL
 * and body), the response's status, and the answer the package received, recomputed with the
 * core's own adapter for that binding. Nothing is changed on the way.
 */
function recordingTransport(base: HttpTransport, pending: Observed[]): HttpTransport {
  return async (request) => {
    const index = pending.findIndex((item) => item.url === request.url && (item.body ?? null) === (request.body ?? null));
    const seen = index >= 0 ? pending.splice(index, 1)[0]! : null;
    const crossref = seen?.binding_id.includes("crossref_works_search") ?? false;
    const entry: JsonObject = {
      at: Date.now() / 1000,
      turn: 1,
      tool: seen?.tool_id ?? null,
      binding: seen?.binding_id ?? null,
      role: null,
      url: request.url,
      arguments: argumentsOf(request, crossref),
    };
    toolCalls.push(entry);
    let response;
    try {
      response = await base(request);
    } catch (error) {
      entry.outcome = "threw";
      entry.error = (error as Error).name;
      throw error;
    }
    entry.status = response.status;
    try {
      const json = JSON.parse(response.body) as JsonValue;
      const implementation = seen ? seen.binding_id.split(":")[1] : null;
      const adapter = crossref ? CROSSREF_WORKS_ADAPTER : HTTP_ADAPTERS.get(`chrome.tool.${implementation}`) ?? null;
      if (adapter === null) entry.answer = json;
      else entry.answer = adapter.response({ status: response.status, json }, entry.arguments as JsonValue, new Date().toISOString());
      entry.outcome = "answered";
    } catch (error) {
      entry.outcome = "threw";
      entry.error = (error as { code?: string }).code ?? (error as Error).name;
    }
    return response;
  };
}

/** A one-shot run composed as `cli-run.ts` composes `run --mode live` (D-359). */
async function runMode(parts: {
  job: Job;
  pkg: Package;
  bytes: Uint8Array;
  definitions: ReturnType<typeof definitionsFromRegistry>;
  toolBindings: ReturnType<typeof normalizeToolBindings>;
  resourceGrants: ResourceGrant[];
  store: MemoryStore;
  memoryRun: MemoryRun;
  engine: ReturnType<typeof nodeComputeEngine>;
}): Promise<void> {
  const { job, pkg, bytes } = parts;
  if (pkg.manifest.entrypoint !== "workflow.v0" || (pkg.graph.conversation !== undefined && pkg.graph.conversation !== null)) {
    throw new Error("the run mode takes a one-shot workflow.v0 package");
  }
  const { router, binding } = await bindModel(pkg, job.route);
  const signer = await fingerprint(await embeddedPublicKey(pkg.signature!));
  const { plan, authorization } = localExecutionPlan({
    pkg,
    archiveSha256: await sha256Hex(bytes),
    signerFingerprint: signer,
    decisions: job.grants,
    approvedTools: [...new Set(job.approved_tools)].sort(),
    fixture: false,
    modelBinding: binding,
    toolBindings: parts.toolBindings,
    resourceGrants: parts.resourceGrants,
  });
  const pending: Observed[] = [];
  const session = new ExecutionSession();
  // A throw at `begin` (a refused plan) or out of `run` (a non-package error) keeps every seam the
  // run observed, as the conversation mode and `Py`'s workflow do (T31b review 1, finding 1).
  let begin: { run_plan_sha256: string } | null = null;
  let outcome: Awaited<ReturnType<ExecutionSession["run"]>> | null = null;
  let error: string | null = null;
  let errorCode: string | null = null;
  try {
    begin = await session.begin(
      {
        run_id: `run_${randomBytes(16).toString("hex")}`,
        run_plan: plan,
        authorization,
        input: job.input ?? {},
        limits: { ...PERMISSIVE_HOST_LIMITS },
        host: { runtime: HOST_RUNTIME, runtime_version: CORE_VERSION, verified_version: CORE_VERSION },
      },
      {
        archive: bytes,
        router,
        tools: {
          definitions: parts.definitions,
          transport: recordingTransport(toolTransport(job.mapping), pending),
          credentials: () => null,
          pacer: new Pacer(),
          observe: (request) => pending.push(request),
        },
        resolver: parts.store,
        memory: parts.memoryRun,
        compute: parts.engine,
      },
    );
    outcome = await session.run();
  } catch (failure) {
    error = `${(failure as Error).name}: ${(failure as Error).message}`.slice(0, 500);
    errorCode = (failure as { code?: string }).code ?? null;
  }
  const report = outcome ? outcome.report : null;
  emit({
    status: outcome ? outcome.result.status : "harness_error",
    error,
    error_code: outcome ? ((outcome.result.error_code as string | undefined) ?? null) : errorCode,
    output: report ? (report.output ?? null) : null,
    audit: report ? (report.audit as unknown as JsonValue) : null,
    usage: outcome ? (outcome.result.usage ?? report!.usage) : null,
    files: outcome ? outcome.files.map(([name]) => name) : null,
    run_plan_sha256: begin ? begin.run_plan_sha256 : null,
    model_calls: modelCalls,
    tool_calls: toolCalls,
    consent,
    responder: decisions,
    dials,
    core_version: CORE_VERSION,
  });
}

/** One JSON line, then exit once it has drained (a pipe takes 64 KiB at a time). */
function emit(report: JsonValue): void {
  process.stdout.write(`${JSON.stringify(report)}\n`, () => process.exit(0));
}

main().catch((error: Error) => emit({ status: "harness_error", error: `${error.name}: ${error.message}`.slice(0, 500) }));
