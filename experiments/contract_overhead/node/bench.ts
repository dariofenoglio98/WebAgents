/**
 * Contract-overhead benchmark v2, the Node side (T38, E7, D-305): the Chrome core's
 * package-to-execution contract, timed over the same seven production operations as the Python
 * side, in the order the extension's service worker and execution host call them
 * (`extension/background/controller.ts` open → authorize → evaluate → prepare; `runs.ts`
 * readiness → lease; `extension/execution/execute.ts` → `ExecutionSession.begin` → `run`), plus
 * the per-operation run-time costs of the extensions (the egress scanner, a compute call cold and
 * warm, the delegation analysis and the transition check, the consent gate).
 *
 * Bundled with the core's own esbuild (`benchmark_v2.py`), from the production sources as they
 * are, with one exception the build states: `core/network/runner.ts` gets one appended line,
 * `export { checkTransition };`, because the transition check is module-private and the
 * protocol times it in both runtimes; no statement of the file changes (a test checks the
 * bundle's function text equals the production text).
 *
 * `node bench.js <op> <config.json>`: `hello`, `fixtures` (the host tool registries the
 * extension builds for each package), `pre` (the pre-execution protocol), `micro` (the
 * per-operation arms). Samples go to the JSONL file the config names; the last stdout line is a
 * JSON summary.
 */
import { createRequire } from "node:module";
import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync, openSync, writeSync, closeSync } from "node:fs";

import { buildReceipt, normalizeDecisions, normalizeProvenance, normalizeToolApprovals } from "../../../chrome-agent-browser/src/core/authorization.js";
import { nodeComputeEngine } from "../../../chrome-agent-browser/src/cli-compute.js";
import type { ComputeEngine } from "../../../chrome-agent-browser/src/core/compute/engine.js";
import { DEFAULT_COMPUTE_LIMITS } from "../../../chrome-agent-browser/src/core/compute/limits.js";
import { evaluateCatalog, normalizeCatalog, stillAvailable } from "../../../chrome-agent-browser/src/core/compatibility.js";
import { AuditChain } from "../../../chrome-agent-browser/src/core/conversation/chain.js";
import { TranscriptConsent } from "../../../chrome-agent-browser/src/core/conversation/host.js";
import { limitsJson, remainingToolCaps, reserveTurn, type ConversationLimits } from "../../../chrome-agent-browser/src/core/conversation/runner.js";
import { evaluateSnapshot, evaluationLayers, publisherReport, structurallyValid } from "../../../chrome-agent-browser/src/core/evaluation.js";
import { LeaseRegistry } from "../../../chrome-agent-browser/src/core/execution/lease.js";
import { lowerLimits, normalizeHostLimits, runtimeLimits } from "../../../chrome-agent-browser/src/core/execution/limits.js";
import { authorizationFromRunPlan, executionPlanFromRunPlan } from "../../../chrome-agent-browser/src/core/execution/plan.js";
import { ExecutionSession, type TurnStart } from "../../../chrome-agent-browser/src/core/execution/runner.js";
import { sha256Hex } from "../../../chrome-agent-browser/src/core/hash.js";
import { normalizeResourceRegistry, normalizeResourceSelections } from "../../../chrome-agent-browser/src/core/hostresources.js";
import { bindsHostResource, buildHostToolRegistry, evaluateRegistry } from "../../../chrome-agent-browser/src/core/hosttools.js";
import type { JsonObject, JsonValue } from "../../../chrome-agent-browser/src/core/json.js";
import { publicKeyFromPem } from "../../../chrome-agent-browser/src/core/keys.js";
import { agentToolDigests, requestedResourceTypes } from "../../../chrome-agent-browser/src/core/memory/declarations.js";
import { MemoryRun } from "../../../chrome-agent-browser/src/core/memory/run.js";
import { findAllSealed, findSealed, type ScanEntry } from "../../../chrome-agent-browser/src/core/memory/scan.js";
import { emptyMemorySnapshot, MemoryStore } from "../../../chrome-agent-browser/src/core/memory/store.js";
import { adapterFor } from "../../../chrome-agent-browser/src/core/models/providers.js";
import { BoundModelRouter } from "../../../chrome-agent-browser/src/core/models/router.js";
import type { HttpTransport } from "../../../chrome-agent-browser/src/core/models/transport.js";
import { enumerateWalks, EffortExceeded, routeData, worstCase, DEFAULT_EFFORT } from "../../../chrome-agent-browser/src/core/network/analysis.js";
import * as networkRunner from "../../../chrome-agent-browser/src/core/network/runner.js";
import { loadPackageBytes, type Package } from "../../../chrome-agent-browser/src/core/package.js";
import { validateTaskInput } from "../../../chrome-agent-browser/src/core/presentation.js";
import { deepCopy } from "../../../chrome-agent-browser/src/core/references.js";
import { buildRunPlan, MODE_MODEL, preflight, preparationBlockers } from "../../../chrome-agent-browser/src/core/runplan.js";
import { buildSummary } from "../../../chrome-agent-browser/src/core/summary.js";
import { definitionsFromRegistry } from "../../../chrome-agent-browser/src/core/tools/definitions.js";
import { Pacer } from "../../../chrome-agent-browser/src/core/tools/pacer.js";
import { MemoryTrustStorage, TrustStore } from "../../../chrome-agent-browser/src/core/trust.js";
import { DEFAULT_BROWSER_POLICY, type Decision } from "../../../chrome-agent-browser/src/core/types.js";
import { CORE_VERSION } from "../../../chrome-agent-browser/src/core/version.js";
import { Workflow } from "../../../chrome-agent-browser/src/core/workflow/interpreter.js";
import { evaluate } from "../../../chrome-agent-browser/src/core/workflow/values.js";

const require = createRequire(import.meta.url);
const HOST_RUNTIME = "chrome-agent-browser";
const now = (): bigint => process.hrtime.bigint();

// ---------------------------------------------------------------------------------------------
// Guards: a refused socket, name lookup, child process or fetch is counted even if a caller
// swallows the exception, and fails the run (v1's rule; the catalog v2 driver's guard).
const violations: string[] = [];
function refuse(kind: string): never {
  violations.push(kind);
  throw new Error(`contract_overhead v2 refused ${kind}`);
}
function installGuard(): void {
  const net = require("node:net");
  net.Socket.prototype.connect = function connect() {
    return refuse("socket");
  };
  net.connect = net.createConnection = () => refuse("socket");
  const dns = require("node:dns");
  dns.lookup = () => refuse("dns");
  dns.promises.lookup = async () => refuse("dns");
  const child = require("node:child_process");
  for (const name of ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"]) child[name] = () => refuse("process");
  (globalThis as { fetch?: unknown }).fetch = async () => refuse("fetch");
}
/** The transport the model adapter and the tool broker are given: every request is refused and counted (v1's `RunnerWire`). */
const refusingTransport: HttpTransport = async () => refuse("transport");

// ---------------------------------------------------------------------------------------------
// The first-wave stop (v1's `FirstWaveStop`, for this process only): `Workflow.run` hands each
// wave of node starters to its private `gather`; the replacement reads the clock, counts the
// starters without calling any (no `node.started` exists yet), and throws.
class FirstWaveReached extends Error {}
const stop = { at: null as bigint | null, hits: 0, starters: 0, actions: [] as string[] };
const proto = Workflow.prototype as unknown as { gather: unknown; runtime?: unknown };
const originalGather = proto.gather;
function installStop(): void {
  proto.gather = async function firstWave(this: Workflow, starts: readonly unknown[]): Promise<never> {
    const at = now();
    stop.hits += 1;
    if (stop.at === null) {
      stop.at = at;
      stop.starters = starts.length;
      stop.actions = (this.runtime.audit as JsonObject[]).map((event) => String(event.action));
    }
    throw new FirstWaveReached("first wave reached");
  };
}
function removeStop(): void {
  proto.gather = originalGather;
}

// ---------------------------------------------------------------------------------------------
interface PackageInput {
  key: string;
  archive: string;
  publisher_key: string;
  input: string;
  registry: string;
}
interface Config {
  root: string;
  out: string;
  packages: PackageInput[];
  catalog: string;
  resource_registry: string;
  authorization: string;
  model_id: string;
  session_ttl_seconds: number;
  warmup: number;
  batches: number;
  iterations: number;
  /** Per iteration index (warmup first), the package order (v1's seeded schedule, drawn in Python). */
  schedule: string[][];
  micro?: MicroConfig;
}

const readJson = (path: string): JsonValue => JSON.parse(readFileSync(path, "utf8")) as JsonValue;

class Host {
  readonly trust = new TrustStore(new MemoryTrustStorage("trust.json"));
  readonly leases = new LeaseRegistry();
  catalog!: Awaited<ReturnType<typeof normalizeCatalog>>;
  resources!: Awaited<ReturnType<typeof normalizeResourceRegistry>>;
  engine: ComputeEngine | null = null;
  /** The host's memory store: unlocked, holding no record (the same in both runtimes, D-305). */
  store!: MemoryStore;
  readonly identity: Record<string, JsonObject> = {};
  readonly evidence: Record<string, JsonObject> = {};
  readonly bytes: Record<string, Uint8Array> = {};
  readonly inputs: Record<string, JsonValue> = {};
  readonly decided: Record<string, JsonObject> = {};
  readonly instanceId = "contract-overhead-v2";
  constructor(readonly config: Config) {}

  async setUp(): Promise<void> {
    this.catalog = await normalizeCatalog(readJson(this.config.catalog));
    this.resources = await normalizeResourceRegistry(readJson(this.config.resource_registry));
    this.store = await MemoryStore.open({ key: randomBytes(32), snapshot: emptyMemorySnapshot() });
    const authorization = readJson(this.config.authorization) as JsonObject;
    // The host's compute engine: one per host, as the extension's execution page holds one.
    this.engine = nodeComputeEngine(new URL("./compute-worker.js", import.meta.url));
    const prefixes = new Map<string, string[]>();
    for (const item of this.config.packages) {
      const bytes = new Uint8Array(readFileSync(item.archive));
      this.bytes[item.key] = bytes;
      this.inputs[item.key] = readJson(item.input);
      const pkg = await loadPackageBytes(bytes);
      prefixes.set(item.publisher_key, [...(prefixes.get(item.publisher_key) ?? []), String(pkg.manifest.package_id)]);
      this.decided[item.key] = (authorization.packages as JsonObject)[String(pkg.manifest.package_id)] as JsonObject;
      this.identity[item.key] = { package_id: String(pkg.manifest.package_id), package_version: String(pkg.manifest.version), package_digest: pkg.digest, archive_sha256: await sha256Hex(bytes), root_nodes: (pkg.graph.nodes as JsonObject[]).filter((node) => (node.depends_on as JsonValue[]).length === 0).map((node) => String(node.id)).sort(), conversational: pkg.graph.conversation !== undefined && pkg.graph.conversation !== null };
    }
    // The operator's one-time "Trust this publisher key" before timing, scoped to the package (a
    // key two packages share, WebAir's, to their common package-id prefix).
    for (const [path, ids] of prefixes) {
      let prefix = ids[0]!;
      for (const id of ids.slice(1)) while (!id.startsWith(prefix)) prefix = prefix.slice(0, prefix.lastIndexOf(".", prefix.length - 2) + 1);
      await this.trust.add(publicKeyFromPem(readFileSync(path, "utf8")), { displayName: path, packageIdPrefix: prefix.replace(/\.$/u, "") });
    }
  }

  /** `controller.ts::toolRegistry`: the host registry for this package, rebuilt on each call as the controller does, with the unlocked store's types and the agent tools. */
  registry(pkg: Package, at: Date) {
    return hostRegistry(pkg, this.store, at);
  }

  async once(key: string): Promise<{ stamps: bigint[]; checks: JsonObject }> {
    const bytes = this.bytes[key]!;
    const decided = this.decided[key]!;
    const at = new Date();
    const expiresAt = new Date(at.getTime() + this.config.session_ttl_seconds * 1000).toISOString();
    const sessionId = `session_${randomBytes(8).toString("hex")}`;
    const source = { kind: "file", display: this.config.packages.find((item) => item.key === key)!.archive };
    stop.at = null;
    stop.hits = 0;
    stop.starters = 0;
    stop.actions = [];
    installStop();
    let leaseId: string | null = null;
    try {
      const t0 = now();
      // 1. `controller.ts::openBytes` + `evaluate`: hash, layered evaluation, publisher, summary.
      const archiveSha256 = await sha256Hex(bytes);
      const evaluated = await evaluateSnapshot(bytes);
      const layers = evaluationLayers(evaluated);
      if (!structurallyValid(layers) || evaluated.package === null) throw new Error(`${key}: package rejected`);
      const pkg = evaluated.package;
      const publisher = await publisherReport(pkg, this.trust);
      const summary = await buildSummary(pkg, { evaluation: layers, publisher });
      const t1 = now();
      // 2. `controller.ts::authorize` → `issue`: normalized decisions, the resource registry, the receipt.
      const decisions = normalizeDecisions(pkg, decided.decisions);
      const approvals = normalizeToolApprovals(pkg, decided.tool_approvals);
      const grants = normalizeResourceSelections(pkg, this.resources, decisions, decided.resource_selections as Record<string, string>);
      // A publisher profile is applied as `useProfile` records it (D-090): the provenance names it.
      const provenance = decided.profile_id ? normalizeProvenance(pkg, { preset: "balanced", profile_id: decided.profile_id }, decisions, approvals, grants) : null;
      const receipt = await buildReceipt(pkg, { sessionId, source, archiveSha256, evaluation: layers, publisher, trustState: await this.trust.state(), decisions, toolApprovals: approvals, policy: DEFAULT_BROWSER_POLICY, instanceId: this.instanceId, expiresAt, resourceGrants: grants, resourceRegistry: this.resources, provenance, now: at });
      const t2 = now();
      // 3. What the page shows: `evaluateModels` and the tool evaluation.
      const models = evaluateCatalog(pkg, this.catalog, at);
      const shownRegistry = await this.registry(pkg, at);
      const shownTools = await evaluateRegistry(pkg, shownRegistry, { decisions, toolApprovals: approvals, now: at });
      const t3 = now();
      // 4. `controller.ts::prepareRunPlan`: catalog, the receipt's tool evaluation, blockers, the plan; then `runPlanState`'s preflight.
      const descriptor = this.catalog.models.find((model) => model.id === this.config.model_id) ?? null;
      if (descriptor === null) throw new Error(`${key}: model not in catalog`);
      const evaluation = evaluateCatalog(pkg, this.catalog, at);
      const compatibility = evaluation.models.find((item) => item.model_id === this.config.model_id) ?? null;
      const toolRegistry = await this.registry(pkg, at);
      const toolEvaluation = await evaluateRegistry(pkg, toolRegistry, { decisions: receipt.decisions, toolApprovals: receipt.tool_approvals, now: at });
      const blockers = preparationBlockers(pkg, { mode: MODE_MODEL, evaluation, receipt, publisher, compatibility, policy: DEFAULT_BROWSER_POLICY, toolEvaluation, resourceRegistry: this.resources });
      if (blockers.length > 0) throw new Error(`${key}: plan refused: ${blockers.map((item) => item.code).join(",")}`);
      const plan = await buildRunPlan(pkg, { sessionId, source, archiveSha256, evaluation, catalog: this.catalog, descriptor, compatibility, receipt, publisher, trustState: await this.trust.state(), evaluationLayers: layers, policy: DEFAULT_BROWSER_POLICY, instanceId: this.instanceId, mode: MODE_MODEL, bindingStrategy: "single_model", expiresAt, blockingReasons: blockers, toolEvaluation, toolRegistry, resourceRegistry: this.resources, consentPolicy: null, consentPreset: "balanced", now: at });
      const prepared = preflight(plan, { pkg, publisher, receipt, trustState: await this.trust.state(), policy: DEFAULT_BROWSER_POLICY, toolEvaluation: (await evaluateRegistry(pkg, await this.registry(pkg, at), { decisions: receipt.decisions, toolApprovals: receipt.tool_approvals, now: at })), resourceRegistry: this.resources, catalog: this.catalog, onceSpent: false, localModelsOnly: false, subscription: null, now: at });
      const t4 = now();
      // 5. Run start (`runs.ts::start`/`launch`, or for a conversation `conversations.ts::start`
      //    and `send`): the task (or message) validated, readiness's preflight, the conversation's
      //    start and its first turn's reservation, the registry, the empty store, the lease.
      const task = this.inputs[key]!;
      const validation = await validateTaskInput(pkg, task);
      if (!validation.valid) throw new Error(`${key}: task invalid: ${JSON.stringify(validation.errors)}`);
      const limits = normalizeHostLimits(null);
      let turn: TurnStart | null = null;
      if (this.identity[key]!.conversational === true) {
        const section = plan.execution.conversation!;
        const conversationLimits: ConversationLimits = { max_turns: section.max_turns, hard_tokens: section.hard_tokens, max_remote_calls: section.max_remote_calls, max_calls_per_tool: { ...section.max_calls_per_tool } };
        const conversationId = randomBytes(16).toString("hex");
        const chain = new AuditChain(conversationId, {});
        const state = deepCopy(evaluate((pkg.graph.conversation as JsonObject).initial as JsonObject, {})) as JsonObject;
        chain.record("conversation.started", { package_id: String(pkg.manifest.package_id), package_version: String(pkg.manifest.version), package_digest: pkg.digest, limits: limitsJson(conversationLimits), grant_scopes: { ...plan.authorization.decisions }, turns_supplied: 0 });
        chain.turn = 1;
        const turnLimits = lowerLimits(limits, normalizeHostLimits(null));
        const refusal = reserveTurn(pkg, conversationLimits, runtimeLimits(turnLimits), { tokens: 0, remote_calls: 0 }, 0);
        if (refusal !== null) throw new Error(`${key}: turn refused ${refusal}`);
        chain.record("turn.started", { consents_supplied: [], spent_tokens: 0, spent_remote_calls: 0 });
        const preDecided: TurnStart["pre_decided"] = {};
        for (const step of section.consent_steps) if (step.pre_decided !== null) preDecided[step.id] = { ...step.pre_decided };
        turn = { conversation_id: conversationId, turn: 1, state, chain_tail: chain.tail(), spent_permissions: [], tool_caps: remainingToolCaps(conversationLimits, {}), pre_decided: preDecided };
      }
      const readiness = preflight(plan, { pkg, publisher, receipt, trustState: await this.trust.state(), policy: DEFAULT_BROWSER_POLICY, toolEvaluation: await evaluateRegistry(pkg, await this.registry(pkg, at), { decisions: receipt.decisions, toolApprovals: receipt.tool_approvals, now: at }), resourceRegistry: this.resources, catalog: this.catalog, onceSpent: this.leases.onceSpent(plan), localModelsOnly: false, subscription: null, now: at });
      if (!readiness.ready || readiness.stale) throw new Error(`${key}: readiness not ready`);
      const launchRegistry = await this.registry(pkg, at);
      const needsMemory = plan.resource_grants.length > 0 || bindsHostResource(plan.tool_bindings);
      const resolver = needsMemory ? this.store : await MemoryStore.open({ key: randomBytes(32), snapshot: emptyMemorySnapshot() });
      const lease = await this.leases.issue({ plan, preflight: readiness, archive: bytes, definitions: definitionsFromRegistry(launchRegistry), resolver, modelAvailable: (hostModelId) => stillAvailable(this.catalog, hostModelId), minimumReceiptRemainingSeconds: null, sessionExpiresAt: expiresAt, spentByConversation: false, now: at });
      leaseId = lease.lease_id;
      const executionPlan = executionPlanFromRunPlan(plan);
      const authorization = authorizationFromRunPlan(plan);
      this.leases.consume(lease.lease_id, plan, at);
      const t5 = now();
      // 6. The execution host (`execute.ts`): the package, the empty store, the registry, the
      //    router over the planned model, the memory context, then `ExecutionSession.begin`.
      const runPkg = await loadPackageBytes(bytes);
      // `execute.ts`: the whole store when the plan needs memory, an empty one under a throwaway key otherwise.
      const memoryStore = needsMemory ? await MemoryStore.open({ key: randomBytes(32), snapshot: this.store.snapshot() }) : await MemoryStore.open({ key: randomBytes(32), snapshot: emptyMemorySnapshot() });
      memoryStore.grantedIds = new Set(executionPlan.resource_grants.map((grant) => grant.resource_id));
      const runRegistry = await buildHostToolRegistry(runPkg, { resourceTypes: needsMemory ? memoryStore.resourceTypeFacts(requestedResourceTypes(runPkg.policy)) : [], agentTools: needsMemory ? agentToolDigests() : null, runtimeVersion: CORE_VERSION, now: new Date(), contactConfigured: false });
      const definitions = definitionsFromRegistry(runRegistry);
      const adapter = adapterFor(executionPlan.model_binding!, { transport: refusingTransport, observer: null, ollama: {}, openai: { apiKey: null }, anthropic: { apiKey: null } });
      const router = new BoundModelRouter(adapter, { requestTimeoutSeconds: limits.model_call_timeout_seconds });
      const agentDocument = needsMemory ? memoryStore.agentDocument(String(runPkg.manifest.package_id)) : undefined;
      const memoryRun = new MemoryRun(runPkg, executionPlan.resource_grants, { ...authorization.decisions } as Record<string, string>, { scan: needsMemory ? memoryStore.scanSet() : [], targets: new Map(), agentDocument: agentDocument ? { body: agentDocument.body, updated: agentDocument.updated } : null, agentDiscard: null, policyRefusesProposals: false, memoryFull: false });
      const session = new ExecutionSession();
      const begun = await session.begin(
        { run_id: `run_${randomBytes(16).toString("hex")}`, run_plan: executionPlan, authorization, input: task, attachments: [], limits, host: { runtime: HOST_RUNTIME, runtime_version: CORE_VERSION, verified_version: CORE_VERSION }, turn },
        { archive: bytes, consent: turn ? new TranscriptConsent({}) : null, router, tools: { definitions, transport: refusingTransport, credentials: () => null, describe: { credentialConfigured: () => false }, files: { attached: new Map(), source: null, reader: null }, pacer: new Pacer() }, resolver: memoryStore, memory: memoryRun, compute: this.engine, onProgress: null, onAudit: null },
      );
      const t6 = now();
      // 7. `session.run()` up to the first wave the interpreter dispatches.
      const outcome = await session.run();
      const t7 = stop.at;
      if (t7 === null) throw new Error(`${key}: the workflow never reached its first wave`);
      const checks = this.check(key, { summary, receipt, models, shownTools, plan, prepared, readiness, begun, outcome });
      return { stamps: [t0, t1, t2, t3, t4, t5, t6, t7], checks };
    } finally {
      removeStop();
      if (leaseId !== null) this.leases.release(leaseId);
    }
  }

  check(key: string, facts: Record<string, unknown>): JsonObject {
    const failures: string[] = [];
    const expect = (condition: boolean, message: string): void => {
      if (!condition) failures.push(message);
    };
    const identity = this.identity[key]!;
    const decided = this.decided[key]!;
    const summary = facts.summary as JsonObject;
    const validation = summary.validation as JsonObject;
    for (const layer of ["container_status", "integrity_status", "schema_status"]) expect(validation[layer] === "valid", `${layer} ${String(validation[layer])}`);
    const publisher = summary.publisher as JsonObject;
    expect(publisher.signature_status === "valid", "signature not valid");
    expect(publisher.trust_status === "trusted", "publisher not trusted");
    const receipt = facts.receipt as JsonObject;
    expect(receipt.runnable === true, "receipt not runnable");
    const models = (facts.models as JsonObject).models as JsonObject[];
    expect(models.some((model) => model.model_id === this.config.model_id && model.status === "compatible"), "model not compatible");
    const approved = Object.entries(decided.tool_approvals as Record<string, boolean>).filter(([, value]) => value).map(([toolId]) => toolId).sort();
    const shown = ((facts.shownTools as JsonObject).tools as JsonObject[]).filter((item) => item.status === "bound").map((item) => String(item.tool_id)).sort();
    for (const toolId of approved) expect(shown.includes(toolId), `approved tool ${toolId} not bound`);
    const plan = facts.plan as JsonObject;
    expect(((plan.readiness as JsonObject).ready as boolean) === true, "plan not ready");
    expect(((facts.prepared as JsonObject).ready as boolean) === true, "prepared preflight not ready");
    expect(((facts.readiness as JsonObject).ready as boolean) === true, "readiness not ready");
    const bound = (plan.tool_bindings as JsonObject[]).map((binding) => String(binding.tool_id)).sort();
    expect(JSON.stringify(bound) === JSON.stringify(approved), `plan binds ${bound.join(",")}`);
    const begun = facts.begun as JsonObject;
    const evidence = begun.package as JsonObject;
    expect(evidence.archive_sha256 === identity.archive_sha256, "runner archive hash");
    expect(evidence.signature_status === "valid", `runner signature ${String(evidence.signature_status)}`);
    expect(((begun.execution as JsonObject).tool_handlers as number) === approved.length, "tool handlers");
    expect(stop.hits === 1, `first-wave stop hit ${stop.hits} times`);
    expect(stop.starters === (identity.root_nodes as string[]).length, `first wave of ${stop.starters}`);
    expect(!stop.actions.includes("node.started"), "a node started before the stop");
    expect(!stop.actions.some((action) => action.startsWith("model.") || action.startsWith("tool.")), "model/tool audit event");
    const result = (facts.outcome as { result: JsonObject }).result;
    expect(result.status === "failed", `run outcome ${String(result.status)}`);
    expect(violations.length === 0, `guard violations ${violations.join(",")}`);
    if (failures.length > 0) throw new Error(`${key}: observation invalid: ${failures.join("; ")}`);
    if (!(key in this.evidence)) {
      this.evidence[key] = {
        run_plan_schema: plan.schema as JsonValue,
        tool_bindings: bound,
        receipt_runnable: receipt.runnable as JsonValue,
        runner_verified: (evidence.verified as JsonValue) ?? null,
        runner_signature: evidence.signature_status as JsonValue,
        tool_handlers: (begun.execution as JsonObject).tool_handlers as JsonValue,
        first_wave_starters: stop.starters,
        root_nodes: identity.root_nodes as JsonValue,
        audit_actions_at_stop: stop.actions,
        outcome_after_stop: { status: result.status as JsonValue, error_code: (result.error_code as JsonValue) ?? null },
        conversational: identity.conversational as JsonValue,
      };
    }
    return { first_wave: stop.starters };
  }
}

/** The extension's host tool registry on a host whose store is unlocked (`controller.ts::toolRegistry`). */
function hostRegistry(pkg: Package, store: MemoryStore, at: Date) {
  return buildHostToolRegistry(pkg, { resourceTypes: store.resourceTypeFacts(requestedResourceTypes(pkg.policy)), agentTools: agentToolDigests(), runtimeVersion: CORE_VERSION, now: at, contactConfigured: false });
}

const STAGES = ["package_open_verify", "authorization_receipt", "compatibility_evaluation", "run_plan_preparation", "host_revalidation_lease", "runner_verification", "workflow_start"] as const;

async function pre(config: Config): Promise<JsonObject> {
  const host = new Host(config);
  await host.setUp();
  const out = openSync(config.out, "w");
  let rows = 0;
  try {
    let index = 0;
    const write = (kind: "warmup" | "measured", batch: number, iteration: number, position: number, key: string, stamps: bigint[]): void => {
      for (let stage = 0; stage < STAGES.length; stage += 1) {
        writeSync(out, `${JSON.stringify({ kind, batch, iteration, position, package_key: key, stage: STAGES[stage], elapsed_ns: Number(stamps[stage + 1]! - stamps[stage]!) })}\n`);
      }
      writeSync(out, `${JSON.stringify({ kind, batch, iteration, position, package_key: key, stage: "total_pre_execution", elapsed_ns: Number(stamps[7]! - stamps[0]!) })}\n`);
      rows += 1;
    };
    for (let iteration = 0; iteration < config.warmup; iteration += 1) {
      const order = config.schedule[index++]!;
      for (const [position, key] of order.entries()) write("warmup", -1, iteration, position, key, (await host.once(key)).stamps);
    }
    for (let batch = 0; batch < config.batches; batch += 1) {
      for (let iteration = 0; iteration < config.iterations; iteration += 1) {
        const order = config.schedule[index++]!;
        for (const [position, key] of order.entries()) write("measured", batch, iteration, position, key, (await host.once(key)).stamps);
      }
    }
  } finally {
    closeSync(out);
  }
  return { op: "pre", observations: rows, identity: host.identity, evidence: host.evidence, guards: { violations: [...violations] } };
}

// ---------------------------------------------------------------------------------------------
// The per-operation arms. Every arm runs `warmup` discarded observations, then `batches` ×
// `iterations` kept ones, of one production call each, on inputs the Python side generated so
// that both runtimes time the same documents.
interface MicroConfig {
  scans: Array<{ cell: string; document: string; scan_set: string }>;
  compute: { archive: string; module: string; function: string; input: string };
  networks: Array<{ cell: string; graph: string; policy: string; roles: number; topology: string }>;
  transition: { archive: string };
  consent: { archive: string; gated_tool: string; gated_tool_permissions: string[]; plain_tool: string; plain_tool_permissions: string[] };
}

type Sink = (arm: string, cell: string, kind: "warmup" | "measured", batch: number, iteration: number, elapsed: bigint, extra?: JsonObject) => void;

async function repeat(config: Config, arm: string, cell: string, sink: Sink, call: () => unknown | Promise<unknown>, isAsync: boolean): Promise<void> {
  for (let iteration = 0; iteration < config.warmup; iteration += 1) {
    const t0 = now();
    if (isAsync) await call();
    else call();
    sink(arm, cell, "warmup", -1, iteration, now() - t0);
  }
  for (let batch = 0; batch < config.batches; batch += 1) {
    for (let iteration = 0; iteration < config.iterations; iteration += 1) {
      const t0 = now();
      if (isAsync) await call();
      else call();
      sink(arm, cell, "measured", batch, iteration, now() - t0);
    }
  }
}

async function micro(config: Config): Promise<JsonObject> {
  const spec = config.micro!;
  const out = openSync(config.out, "w");
  const facts: JsonObject = {};
  const sink: Sink = (arm, cell, kind, batch, iteration, elapsed, extra) => {
    writeSync(out, `${JSON.stringify({ arm, cell, kind, batch, iteration, elapsed_ns: Number(elapsed), ...(extra ?? {}) })}\n`);
  };
  try {
    // 1. The egress scanner (memory.v0 M-36, M-37): both scans on a document with no hit, so
    //    every string is read and every sealed value tested (the cost of an allowed request).
    for (const cell of spec.scans) {
      const document = readJson(cell.document);
      const scan = readJson(cell.scan_set) as unknown as ScanEntry[];
      if (findAllSealed(document, scan) !== null && (findAllSealed(document, scan) as unknown[]).length !== 0) throw new Error(`scan cell ${cell.cell}: the document holds a sealed value`);
      await repeat(config, "scan_model_request", cell.cell, sink, () => findSealed(document, scan), false);
      await repeat(config, "scan_tool_arguments", cell.cell, sink, () => findAllSealed(document, scan), false);
    }
    // 2. A compute call (compute.v0): cold (a fresh engine compiles the module, then the first
    //    call) and warm (a call on an engine that holds the compiled module).
    {
      const pkg = await loadPackageBytes(new Uint8Array(readFileSync(spec.compute.archive)));
      const module = (pkg.graph.modules as JsonObject[]).find((item) => item.id === spec.compute.module)!;
      const wasm = pkg.files.get(String(module.path))!;
      const sha = String(module.sha256);
      const input = new TextEncoder().encode(readFileSync(spec.compute.input, "utf8").trim());
      const limits = DEFAULT_COMPUTE_LIMITS;
      const signal = new AbortController().signal;
      let last: JsonObject | null = null;
      // The host's engine, one per process. Cold: the module compiled by it for the first time
      // (under a cache key it has not seen), then the call; warm: a call on the compiled module.
      const warm = nodeComputeEngine(new URL("./compute-worker.js", import.meta.url));
      let counter = 0;
      await repeat(config, "compute_cold", spec.compute.module, sink, async () => {
        const key = `${sha}#cold-${counter++}`;
        await warm.compile(key, wasm);
        const outcome = await warm.call(key, spec.compute.function, input, limits, signal);
        if (outcome.reason !== null) throw new Error(`compute cold: ${outcome.reason}`);
      }, true);
      await warm.compile(sha, wasm);
      await repeat(config, "compute_warm", spec.compute.module, sink, async () => {
        const outcome = await warm.call(sha, spec.compute.function, input, limits, signal);
        if (outcome.reason !== null) throw new Error(`compute warm: ${outcome.reason}`);
        last = { output: new TextDecoder().decode(outcome.output!), engine: warm.id };
      }, true);
      facts.compute = last;
    }
    // 3. Delegation (network.v0): the worst case the reservation computes (R-21), the exact
    //    enumerator under its effort cap (R-23), the availability a route request carries
    //    (R-13), against graph size.
    const networkFacts: JsonObject = {};
    for (const cell of spec.networks) {
      const graph = readJson(cell.graph) as JsonObject;
      const policy = readJson(cell.policy) as JsonObject;
      const network = graph.network as JsonObject;
      const bound = worstCase(graph, policy);
      let walks: number | null = null;
      let capped = false;
      try {
        walks = enumerateWalks(network, { effort: DEFAULT_EFFORT }).length;
      } catch (error) {
        if (!(error instanceof EffortExceeded)) throw error;
        capped = true;
      }
      networkFacts[cell.cell] = { roles: cell.roles, topology: cell.topology, walks, effort_exceeded: capped, max_activations: bound.max_activations, tokens: bound.tokens, model_calls: bound.model_calls };
      await repeat(config, "network_worst_case", cell.cell, sink, () => worstCase(graph, policy), false);
      await repeat(config, "network_enumerate", cell.cell, sink, () => {
        try {
          enumerateWalks(network, { effort: DEFAULT_EFFORT });
        } catch (error) {
          if (!(error instanceof EffortExceeded)) throw error;
        }
      }, false);
      const entry = String(network.entry);
      const uses = new Map<string, number>();
      const activations = new Map<string, number>([[entry, 1]]);
      await repeat(config, "network_route_data", cell.cell, sink, () => routeData(network, entry, { text: "x" }, uses, activations, 0), false);
    }
    facts.networks = networkFacts;
    // 4. The transition check (R-14) on the Travel Network's runtime: an allowed hand-off from
    //    the entry to a specialist at hop 0, as the loop asks it (it records `route.decided`).
    {
      const pkg = await loadPackageBytes(new Uint8Array(readFileSync(spec.transition.archive)));
      const workflow = await Workflow.create(pkg, { grants: Object.fromEntries((pkg.policy.permissions as JsonObject[]).map((item) => [String(item.id), "session"])) as never });
      const network = pkg.graph.network as JsonObject;
      const roles = network.roles as Record<string, JsonObject>;
      const entry = String(network.entry);
      const target = String(((roles[entry]!.edges as JsonObject[])[0]!).to);
      const check = (networkRunner as unknown as { checkTransition: (...args: unknown[]) => void }).checkTransition;
      if (typeof check !== "function") throw new Error("the bundle exposes no checkTransition");
      const ctx = workflow.runtime.coordinatorContext();
      await repeat(config, "transition_check", "travel-network", sink, () => {
        const walk = new networkRunner.Walk();
        walk.activations.set(entry, 1);
        check(workflow, ctx, "plan-trip", network, entry, roles[entry], walk, target, "model");
      }, false);
      facts.transition = { audit_events: workflow.runtime.audit.length };
    }
    // 5. The consent gate (conversation.v0 V-9) on WebAir 0.8.0's runtime: a tool linking a
    //    gated permission after its step was accepted in this turn, and a tool linking none.
    {
      const pkg = await loadPackageBytes(new Uint8Array(readFileSync(spec.consent.archive)));
      const conversationId = randomBytes(16).toString("hex");
      const turn = { conversation_id: conversationId, turn: 1, state: deepCopy(evaluate((pkg.graph.conversation as JsonObject).initial as JsonObject, {})) as JsonObject, chain: new AuditChain(conversationId, {}), consent: new TranscriptConsent({}) };
      const workflow = await Workflow.create(pkg, { grants: Object.fromEntries((pkg.policy.permissions as JsonObject[]).map((item) => [String(item.id), "session"])) as never, turn, compute: nodeComputeEngine(new URL("./compute-worker.js", import.meta.url)) });
      const runtime = workflow.runtime as unknown as { checkConsent: (ctx: unknown, toolId: string, permissions: readonly string[]) => void; consents: Record<string, boolean>; gated: Record<string, string[]>; coordinatorContext: () => unknown };
      if (typeof runtime.checkConsent !== "function") throw new Error("the runtime has no consent gate");
      const gated = spec.consent.gated_tool_permissions.filter((permission) => (runtime.gated[permission]?.length ?? 0) > 0);
      if (gated.length === 0) throw new Error("the gated tool links no gated permission");
      for (const permission of gated) runtime.consents[permission] = true; // what an accepted consent step leaves (`callConsent`)
      const ctx = runtime.coordinatorContext();
      await repeat(config, "consent_gate", "gated_accepted", sink, () => runtime.checkConsent(ctx, spec.consent.gated_tool, spec.consent.gated_tool_permissions), false);
      await repeat(config, "consent_gate", "not_gated", sink, () => runtime.checkConsent(ctx, spec.consent.plain_tool, spec.consent.plain_tool_permissions), false);
      facts.consent = { gated_permissions: gated };
    }
  } finally {
    closeSync(out);
  }
  return { op: "micro", facts, guards: { violations: [...violations] } };
}

async function fixtures(config: { out_dir: string; packages: Array<{ key: string; archive: string }>; captured_at: string }): Promise<JsonObject> {
  const written: JsonObject = {};
  for (const item of config.packages) {
    const pkg = await loadPackageBytes(new Uint8Array(readFileSync(item.archive)));
    const store = await MemoryStore.open({ key: randomBytes(32), snapshot: emptyMemorySnapshot() });
    const registry = await hostRegistry(pkg, store, new Date(config.captured_at));
    const path = `${config.out_dir}/host-tool-registry.${item.key}.json`;
    // The wire form a host hands a control plane (the fields `normalizeRegistry` and
    // `hosttools.py::normalize_registry` accept); the derived counts and hashes are recomputed
    // by whichever control plane normalizes it.
    const raw = registry as unknown as JsonObject;
    const wire = {
      schema: raw.schema,
      host: raw.host,
      bindings: (raw.bindings as JsonObject[]).map((binding) => Object.fromEntries(Object.entries(binding).filter(([field]) => field !== "schema" && field !== "binding_sha256"))),
      notes: raw.notes,
    };
    writeFileSync(path, `${JSON.stringify(wire, null, 2)}\n`);
    written[item.key] = path;
  }
  return { op: "fixtures", written, core_version: CORE_VERSION };
}

async function main(): Promise<void> {
  const [op, configPath] = process.argv.slice(2);
  if (op === "hello") {
    process.stdout.write(`${JSON.stringify({ op: "hello", core_version: CORE_VERSION, node: process.version, check_transition_exposed: typeof (networkRunner as unknown as { checkTransition?: unknown }).checkTransition === "function" })}\n`);
    return;
  }
  const config = JSON.parse(readFileSync(configPath!, "utf8"));
  installGuard();
  let answer: JsonObject;
  if (op === "fixtures") answer = await fixtures(config);
  else if (op === "pre") answer = await pre(config as Config);
  else if (op === "micro") answer = await micro(config as Config);
  else throw new Error(`unknown op ${String(op)}`);
  process.stdout.write(`${JSON.stringify(answer)}\n`);
  // The compute engine's Workers would keep the process alive.
  process.exit(0);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exit(1);
});

export type { Decision };
