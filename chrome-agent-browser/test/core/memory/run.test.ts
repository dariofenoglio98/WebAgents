/**
 * memory.v0 §7 and §9 inside a run: the scan set guards tools (M-36) and models (M-37) in every
 * mode, the proposals document is checked at completion and never applied by the run (M-40), the
 * agent document is read at start, staged once and committed only after `workflow.completed`
 * (M-50), and the audit carries identifiers, counts and hashes, never a value (M-61).
 */
import { describe, expect, it } from "vitest";

import { canonicalJson } from "../../../src/core/canonical.js";
import { sha256HexSync } from "../../../src/core/hash.js";
import type { JsonObject, JsonValue } from "../../../src/core/json.js";
import { fixtureMemoryScan, MemoryRun } from "../../../src/core/memory/run.js";
import type { MemoryStore } from "../../../src/core/memory/store.js";
import { packageJson } from "../../../src/core/package.js";
import { localExecutionPlan } from "../../../src/core/execution/plan.js";
import { ExecutionSession } from "../../../src/core/execution/runner.js";
import { MEMORY_CONTRACTS } from "../../../src/core/schemas/memory/index.js";
import { ECHO_IMPLEMENTATION, toolHandlers } from "../../../src/core/tools/broker.js";
import { Pacer } from "../../../src/core/tools/pacer.js";
import { CancelToken } from "../../../src/core/workflow/cancel.js";
import { Workflow } from "../../../src/core/workflow/interpreter.js";
import type { ModelRequest, ModelResult } from "../../../src/core/models/contract.js";
import type { ResourceGrant } from "../../../src/core/types.js";
import type { ModelBindingDescriptor } from "../../../src/core/models/binding.js";
import { definitionFor, planBindingFor } from "../../helpers/echo-package.js";
import { exampleStore, WEBAIR_EXAMPLE } from "../../helpers/memory.js";
import { AGENT_PERMISSION, AGENT_READ_TOOL, AGENT_WRITE_TOOL, ECHO_BINDING, ECHO_TOOL, memoryPackage, PROFILE_TOOL, READ_PERMISSION, VALID_PROPOSALS, WALLET_PERMISSION, WALLET_TOOL, WRITE_PERMISSION } from "../../helpers/memory-package.js";
import { openRuntime, sessionGrants } from "../../helpers/workflow.js";

const TEST_BINDING: ModelBindingDescriptor = { host_model_id: "test/model", provider_id: "test", model_id: "model", display_name: null, compatibility_status: null, evidence_strength: null, capabilities: {}, limits: { context_tokens: 1_000_000, native_context_window: null, max_output_tokens: null }, properties: { local: true }, pricing: null };

class TestRouter {
  readonly router_id = "test";
  readonly remote = false;
  readonly synthetic = true;
  readonly model_id = "test/model";
  readonly capabilities: ReadonlySet<string> = new Set(["structured_output", "reasoning"]);
  readonly context_window = 1_000_000;
  readonly invocations: never[] = [];
  calls = 0;
  async countTokens(_request: ModelRequest): Promise<number> {
    this.calls += 1;
    return 1;
  }
  async complete(): Promise<ModelResult> {
    this.calls += 1;
    return { output: { value: "ok" }, input_tokens: 1, output_tokens: 1 } as unknown as ModelResult;
  }
}

/** The WebAir worked example's store, with the ids of the records the tests grant. */
async function webairStore(): Promise<{ store: MemoryStore; profile: string; card: string; identity: string; cardNumberish: string; email: string }> {
  const store = await exampleStore(WEBAIR_EXAMPLE);
  const byTitle = (title: string) => store.all().find((record) => record.title === title)!;
  const profile = byTitle("Home travel profile").id;
  const card = byTitle("Demo Visa •••• 4242");
  const identity = byTitle("Alex Traveler");
  return { store, profile, card: card.id, identity: identity.id, cardNumberish: String((card.fields as JsonObject).payment_method_id), email: String((identity.fields as JsonObject).email ?? (identity.fields as JsonObject).contact_email) };
}

function grantFor(store: MemoryStore, permissionId: string, resourceType: string, id: string): ResourceGrant {
  return { permission_id: permissionId, resource_type: resourceType, resource_id: id, resource_digest: store.describe(id)!.digest };
}

describe("M-36: sealed values never leave through a tool they were not granted to reach", () => {
  it("an ungranted record's sealed value is refused before the handler, a granted one only to a tool linking its permission, and a memory read is never scanned", async () => {
    const { store, profile, cardNumberish } = await webairStore();
    const { pkg } = await memoryPackage();
    const grants = [grantFor(store, READ_PERMISSION, "travel.profile", profile)];
    const memory = new MemoryRun(pkg, grants, sessionGrants(pkg), { scan: store.scanSet() });
    expect(memory.scan.length).toBeGreaterThan(0);
    let reached = 0;
    const handlers = {
      [ECHO_BINDING]: async (_ctx: unknown, payload: JsonValue) => {
        reached += 1;
        return payload;
      },
      "host.memory.travel.profile": async () => store.resolve(grants[0]!),
    };
    const { runtime: rt, close } = await openRuntime(pkg, { grants: sessionGrants(pkg), approvedTools: Object.keys(pkg.tools).sort(), handlers, memory });
    try {
      const token = new CancelToken(null, Date.now() + 10_000);
      await rt.runWorker("Worker", {}, async (worker) => {
        await expect(rt.callTool(worker, ECHO_TOOL, { value: `pay with ${cardNumberish} now` }, token)).rejects.toThrow(/sealed value of a record this run was not granted/u);
        expect(reached).toBe(0);
        const refused = rt.audit.filter((event) => event.action === "permission.checked" && event.allowed === false);
        expect(refused).toHaveLength(1);
        expect(refused[0]).toMatchObject({ reason: "sealed_value_not_granted", tool: ECHO_TOOL, pointer: "/payment_method_id" });
        expect(JSON.stringify(rt.audit)).not.toContain(cardNumberish);
        // The memory read itself carries nothing to scan and is never scanned.
        const view = await rt.callTool(worker, PROFILE_TOOL, {}, token);
        expect((view as JsonObject).title).toBe("Home travel profile");
        return {};
      });
      // A value the run was granted, bound for a tool that does not link its permission: refused as egress.
      const identityGrant = grantFor(store, WALLET_PERMISSION, "wallet.payment_method", store.all().find((record) => record.title === "Demo Visa •••• 4242")!.id);
      const granted = new MemoryRun(pkg, [...grants, identityGrant], sessionGrants(pkg), { scan: store.scanSet() });
      const second = await openRuntime(pkg, { grants: sessionGrants(pkg), approvedTools: Object.keys(pkg.tools).sort(), handlers, memory: granted });
      try {
        await second.runtime.runWorker("Worker", {}, async (w2) => {
          await expect(second.runtime.callTool(w2, ECHO_TOOL, { value: cardNumberish }, token)).rejects.toThrow(/does not link wallet.payment/u);
          expect(second.runtime.audit.find((event) => event.action === "permission.checked" && event.allowed === false)).toMatchObject({ reason: "sealed_value_egress", permission: WALLET_PERMISSION });
          // Case-insensitive, keys included.
          await expect(second.runtime.callTool(w2, ECHO_TOOL, { value: cardNumberish.toUpperCase() }, token)).rejects.toThrow(/does not link/u);
          expect(reached).toBe(0);
          // An unsealed field (the home airport) is ordinary data.
          expect(await second.runtime.callTool(w2, ECHO_TOOL, { value: "BOS economy" }, token)).toEqual({ value: "BOS economy" });
          expect(reached).toBe(1);
          return {};
        });
      } finally {
        second.close();
      }
    } finally {
      close();
    }
  });
});

describe("M-37: a sealed value never reaches a model, the token count included", () => {
  it("refuses before the router is called, names the record and the pointer, and fails the node permission_denied", async () => {
    const { store, profile, cardNumberish } = await webairStore();
    const { pkg } = await memoryPackage();
    const grants = [grantFor(store, READ_PERMISSION, "travel.profile", profile)];
    const memory = new MemoryRun(pkg, grants, sessionGrants(pkg), { scan: store.scanSet() });
    const router = new TestRouter();
    const { runtime: rt, close } = await openRuntime(pkg, { grants: sessionGrants(pkg), approvedTools: Object.keys(pkg.tools).sort(), router, memory });
    try {
      const token = new CancelToken(null, Date.now() + 10_000);
      const schema = { type: "object", properties: { value: { type: "string" } }, required: ["value"], additionalProperties: false };
      await rt.runWorker("Worker", {}, async (worker) => {
        await expect(rt.callModel(worker, "summarize", { note: `card ${cardNumberish}` }, schema, 50, token)).rejects.toThrow(/may not reach a model/u);
        expect(router.calls).toBe(0);
        const refused = rt.audit.find((event) => event.action === "model.refused");
        expect(refused).toMatchObject({ reason: "sealed_value_in_model_request", pointer: "/payment_method_id" });
        expect(typeof refused!.record_id).toBe("string");
        expect(JSON.stringify(rt.audit)).not.toContain(cardNumberish);
        // A request without a sealed value goes through: the scan is exact-value, not data-loss prevention.
        expect(await rt.callModel(worker, "summarize", { note: "BOS, economy" }, schema, 50, token)).toEqual({ value: "ok" });
        expect(router.calls).toBe(2);
        return {};
      });
    } finally {
      close();
    }
  });

  it("M-62: in fixture mode without a store, the scan set is the fixture's own sealed values", async () => {
    const { pkg } = await memoryPackage();
    const fixture = packageJson(pkg, "fixtures/fixture.json") as JsonObject;
    const scan = fixtureMemoryScan(pkg, fixture);
    // The legacy wallet answer seals its identifier through the alias (payment.card seals /payment_method_id → the legacy pointer).
    expect(scan.map((entry) => entry.pointer)).toContain("/payment_method_id");
    expect(scan.every((entry) => entry.record_id === "fixture:host.resource.wallet.payment_method")).toBe(true);
    const memory = new MemoryRun(pkg, [], sessionGrants(pkg), { scan });
    const router = new TestRouter();
    const { runtime: rt, close } = await openRuntime(pkg, { grants: sessionGrants(pkg), approvedTools: Object.keys(pkg.tools).sort(), router, memory });
    try {
      await rt.runWorker("Worker", {}, async (worker) => {
        await expect(rt.callModel(worker, "summarize", { note: scan[0]!.value }, { type: "object" }, 50, new CancelToken(null, Date.now() + 10_000))).rejects.toThrow(/may not reach a model/u);
        expect(router.calls).toBe(0);
        return {};
      });
    } finally {
      close();
    }
  });
});

describe("M-40: proposals are checked at completion and never applied by the run", () => {
  async function runWith(proposals: JsonValue, decisions: Record<string, "session" | "deny"> = {}): Promise<{ report: Record<string, unknown>; error: (Error & { code?: string }) | null }> {
    const { store, profile } = await webairStore();
    const { pkg } = await memoryPackage({ proposalsInput: proposals });
    const grants = [grantFor(store, READ_PERMISSION, "travel.profile", profile)];
    const decided = { ...sessionGrants(pkg), ...decisions };
    const target = store.get(profile)!;
    const memory = new MemoryRun(pkg, grants, decided, { scan: store.scanSet(), targets: new Map([[profile, { sealed: target.sealed, type: target.type }]]) });
    const handlers = { [ECHO_BINDING]: async (_ctx: unknown, payload: JsonValue) => payload, "host.memory.travel.profile": async () => store.resolve(grants[0]!) };
    const workflow = await Workflow.create(pkg, { grants: decided, approvedTools: Object.keys(pkg.tools).sort(), handlers, memory });
    const input = { value: "hello", proposals };
    try {
      const result = await workflow.run(input);
      return { report: result as unknown as Record<string, unknown>, error: null };
    } catch (error) {
      return { report: (error as { execution_report?: Record<string, unknown> }).execution_report ?? {}, error: error as Error & { code?: string } };
    }
  }

  it("a valid document is recorded as memory.proposed before workflow.completed, with counts and a hash, and offered to the person", async () => {
    const { report, error } = await runWith(VALID_PROPOSALS);
    expect(error).toBeNull();
    const audit = report.audit as JsonObject[];
    const actions = audit.map((event) => event.action);
    expect(actions.indexOf("memory.proposed")).toBeLessThan(actions.indexOf("workflow.completed"));
    const proposed = audit.find((event) => event.action === "memory.proposed")!;
    expect(proposed).toMatchObject({ count: 1, types: ["travel.preference"], offered: 1, reason: null, proposals_sha256: sha256HexSync(canonicalJson(VALID_PROPOSALS)) });
    expect(report.memory).toEqual({ proposals: { count: 1, types: ["travel.preference"], offered: 1, reason: null, proposals_sha256: proposed.proposals_sha256 }, refused: null, agent: null });
    expect(JSON.stringify(audit)).not.toContain("Aisle seat");
  });

  it("a denied memory.write still checks the document and offers nothing (reason permission_denied)", async () => {
    const { report, error } = await runWith(VALID_PROPOSALS, { [WRITE_PERMISSION]: "deny" });
    expect(error).toBeNull();
    expect((report.audit as JsonObject[]).find((event) => event.action === "memory.proposed")).toMatchObject({ count: 1, offered: 0, reason: "permission_denied" });
  });

  it("N1: a type outside memory.write's resources fails the run permission_denied (memory_proposal_type_undeclared), after the output and before workflow.completed", async () => {
    const bad = { schema: "memory.v0 proposals", proposals: [{ action: "create", type: "research.review", title: "x", fields: { question: "q", date: "2026-10-14" }, rationale: "r" }] };
    const { report, error } = await runWith(bad);
    expect(error?.code).toBe("permission_denied");
    const actions = (report.audit as JsonObject[]).map((event) => event.action);
    expect(actions).not.toContain("workflow.completed");
    expect(actions).not.toContain("memory.proposed");
    expect((report.audit as JsonObject[]).find((event) => event.action === "workflow.failed")).toMatchObject({ error_code: "permission_denied", reason: "memory_proposal_type_undeclared", proposal_index: 0 });
    expect(report.memory).toEqual({ proposals: null, refused: { code: "permission_denied", reason: "memory_proposal_type_undeclared", index: 0 }, agent: null });
  });

  it("a sealed value inside the document is sealed_value_in_proposal; a sealed field is schema_validation", async () => {
    const { store, cardNumberish } = await webairStore();
    void store;
    const leaking = { ...VALID_PROPOSALS, proposals: [{ ...(VALID_PROPOSALS.proposals as JsonObject[])[0]!, body: `pay with ${cardNumberish}` }] };
    const first = await runWith(leaking);
    expect(first.error?.code).toBe("permission_denied");
    expect((first.report.audit as JsonObject[]).find((event) => event.action === "workflow.failed")).toMatchObject({ reason: "sealed_value_in_proposal" });
    expect(JSON.stringify(first.report)).not.toContain(cardNumberish);
    const sealedField = { schema: "memory.v0 proposals", proposals: [{ action: "create", type: "travel.profile", title: "x", fields: { home_airport: "BOS", preferred_cabin: "economy", prefer_nonstop: true, preferred_currency: "USD", loyalty_number: "AB123456" }, rationale: "r" }] };
    const second = await runWith(sealedField);
    expect(second.error?.code).toBe("schema_validation");
    expect(second.report.memory).toMatchObject({ refused: { code: "schema_validation" } });
  });
});

describe("the agent document (M-48…M-51, M-61) through the broker and the session", () => {
  function agentDefinitions(pkg: Parameters<typeof definitionFor>[0]) {
    const contract = (name: string) => sha256HexSync(canonicalJson(MEMORY_CONTRACTS[name]));
    const read = definitionFor(pkg, AGENT_READ_TOOL, { kind: "memory_agent", implementationId: "chrome.tool.memory_agent", inputSchemaSha256: contract("memory-empty-input.schema"), outputSchemaSha256: contract("memory-agent-read.output.schema") });
    const write = definitionFor(pkg, AGENT_WRITE_TOOL, { kind: "memory_agent", implementationId: "chrome.tool.memory_agent", inputSchemaSha256: contract("memory-agent-write.input.schema"), outputSchemaSha256: contract("memory-agent-write.output.schema") });
    return { read, write };
  }

  it("the read returns the stored document or the empty one; the write stages once and reports its size; the package id is never an argument", async () => {
    const { pkg } = await memoryPackage({ agent: true });
    const { read, write } = agentDefinitions(pkg);
    const memory = new MemoryRun(pkg, [], sessionGrants(pkg), { agentDocument: { body: "# Notes\n- earlier", updated: "2026-10-13T10:00:00Z" } });
    const events: Array<[string, JsonObject]> = [];
    const context = { role: "Worker", worker_id: "Worker-1", event: (action: string, facts?: Record<string, JsonValue | undefined>) => { if (action.startsWith("memory.")) events.push([action, (facts ?? {}) as JsonObject]); } };
    const { handlers } = toolHandlers([planBindingFor(pkg, read), planBindingFor(pkg, write)], { definitions: [read, write], memory: { agent: memory.agent }, pacer: new Pacer() });
    const signal = new AbortController().signal;
    const bounds = { deadline: Date.now() + 5000, side_effects: "read" as const };
    expect(await handlers["host.memory.agent.read"]!(context, {}, signal, bounds)).toEqual({ body: "# Notes\n- earlier", updated: "2026-10-13T10:00:00Z" });
    await expect(handlers["host.memory.agent.read"]!(context, { package_id: "org.other" }, signal, bounds)).rejects.toThrow(/takes no arguments/u);
    expect(await handlers["host.memory.agent.write"]!(context, { body: "# Notes\n- new" }, signal, { ...bounds, side_effects: "write" })).toEqual({ staged: true, bytes: 13 });
    await expect(handlers["host.memory.agent.write"]!(context, { body: "x", package_id: "org.other" }, signal, { ...bounds, side_effects: "write" })).rejects.toThrow(/exactly one body/u);
    expect(memory.stagedBody()).toBe("# Notes\n- new");
    expect(events.map(([action]) => action)).toEqual(["memory.agent.read", "memory.agent.write"]);
    expect(events[0]![1]).toMatchObject({ package_id: "org.example.memory", bytes: 17, present: true, body_sha256: sha256HexSync(new TextEncoder().encode("# Notes\n- earlier")) });
    expect(events[1]![1]).toMatchObject({ package_id: "org.example.memory", bytes: 13, body_sha256: sha256HexSync(new TextEncoder().encode("# Notes\n- new")) });
    expect(JSON.stringify(events)).not.toContain("earlier");
    // No document under the privacy-first preset: the read is empty, the write is staged and discarded with that reason.
    const preset = new MemoryRun(pkg, [], sessionGrants(pkg), { agentDocument: { body: "kept", updated: "2026-10-13T10:00:00Z" }, agentDiscard: "preset" });
    const second = toolHandlers([planBindingFor(pkg, read), planBindingFor(pkg, write)], { definitions: [read, write], memory: { agent: preset.agent }, pacer: new Pacer() }).handlers;
    expect(await second["host.memory.agent.read"]!(context, {}, signal, bounds)).toEqual({ body: "", updated: null });
    await second["host.memory.agent.write"]!(context, { body: "later" }, signal, { ...bounds, side_effects: "write" });
    expect(preset.agentOutcome("completed")).toEqual({ committed: null, discarded: "preset" });
    expect(memory.agentOutcome("completed")).toEqual({ committed: { package_id: "org.example.memory", bytes: 13, body_sha256: sha256HexSync(new TextEncoder().encode("# Notes\n- new")) }, discarded: null });
    expect(memory.agentOutcome("failed")).toEqual({ committed: null, discarded: "run_failed" });
    expect(memory.agentOutcome("cancelled")).toEqual({ committed: null, discarded: "cancelled" });
    // A denied agent permission: no document at all, and the state permission is untouched.
    const denied = new MemoryRun(pkg, [], { ...sessionGrants(pkg), [AGENT_PERMISSION]: "deny" }, {});
    expect(denied.agent).toBeNull();
  });

  it("a full session over the store: the read, the proposals and the commit are in the audit in order, the Run Record carries the memory section, and no value leaks", async () => {
    const { store, profile, cardNumberish } = await webairStore();
    const { pkg, bytes, key, archiveSha256 } = await memoryPackage({ agent: true });
    const grants = [grantFor(store, READ_PERMISSION, "travel.profile", profile)];
    const decisions = sessionGrants(pkg);
    const echo = definitionFor(pkg, ECHO_TOOL);
    const profileDefinition = definitionFor(pkg, PROFILE_TOOL, { kind: "host_resource", implementationId: "chrome.tool.host_resource", resourceType: "travel.profile" });
    const walletDefinition = definitionFor(pkg, WALLET_TOOL, { kind: "host_resource", implementationId: "chrome.tool.host_resource", resourceType: "wallet.payment_method" });
    const { read, write } = agentDefinitions(pkg);
    const definitions = [echo, profileDefinition, walletDefinition, read, write];
    const toolBindings = definitions.map((definition) => planBindingFor(pkg, definition));
    const { plan, authorization } = localExecutionPlan({ pkg, archiveSha256, signerFingerprint: key.fingerprint, decisions, approvedTools: [ECHO_TOOL, PROFILE_TOOL, AGENT_READ_TOOL, AGENT_WRITE_TOOL, WALLET_TOOL], fixture: false, modelBinding: TEST_BINDING, toolBindings, resourceGrants: grants });
    const target = store.get(profile)!;
    const memory = new MemoryRun(pkg, grants, decisions, { scan: store.scanSet(), targets: new Map([[profile, { sealed: target.sealed, type: target.type }]]), agentDocument: null });
    const session = new ExecutionSession();
    const notes = "# Notes\n- booked BOS";
    await session.begin(
      { run_id: "memory_run", run_plan: plan, authorization, input: { value: "hello", proposals: VALID_PROPOSALS, notes } },
      { archive: bytes, router: new TestRouter(), tools: { definitions, builtins: { [ECHO_IMPLEMENTATION]: (args) => args }, pacer: new Pacer() }, resolver: store, memory },
    );
    const outcome = await session.run();
    expect(outcome.result.status).toBe("completed");
    const actions = (outcome.report.audit as unknown as JsonObject[]).map((event) => event.action as string);
    const index = (action: string) => actions.indexOf(action);
    expect(index("memory.read")).toBeGreaterThan(-1);
    expect(index("memory.agent.read")).toBeLessThan(index("memory.agent.write"));
    expect(index("memory.proposed")).toBeLessThan(index("workflow.completed"));
    expect(index("workflow.completed")).toBeLessThan(index("memory.agent.committed"));
    expect(index("memory.agent.committed")).toBeLessThan(index("memory.cleared"));
    const audit = outcome.report.audit as unknown as JsonObject[];
    expect(audit.find((event) => event.action === "memory.read")).toMatchObject({ permission_id: READ_PERMISSION, resource_type: "travel.profile", record_id: profile, record_digest: grants[0]!.resource_digest });
    expect(audit.find((event) => event.action === "memory.agent.committed")).toMatchObject({ package_id: "org.example.memory", bytes: new TextEncoder().encode(notes).length, body_sha256: sha256HexSync(new TextEncoder().encode(notes)) });
    expect(outcome.result.memory).toMatchObject({ proposals: { count: 1, offered: 1 }, agent: { committed: { package_id: "org.example.memory" }, discarded: null } });
    expect(memory.stagedBody()).toBe(notes);
    expect(outcome.files.map(([name]) => name)).toEqual(["result.json", "audit.json", "usage.json", "provenance.json", "proposals.json"]);
    expect(JSON.parse(new TextDecoder().decode(outcome.files.find(([name]) => name === "proposals.json")![1]))).toEqual(VALID_PROPOSALS);
    const everything = outcome.files.map(([, data]) => new TextDecoder().decode(data)).join("\n");
    // The run's own input and state (the package's graph routes the view there) are the package's business; a sealed value is not.
    expect(everything).not.toContain(cardNumberish);
  });

  it("a failed run discards the staged body (memory.agent.discarded run_failed) and offers no proposal", async () => {
    const { pkg } = await memoryPackage({ agent: true, proposalsInput: { schema: "memory.v0 proposals", proposals: [{ action: "create", type: "person.self", title: "x", fields: {}, rationale: "r" }] } });
    const memory = new MemoryRun(pkg, [], sessionGrants(pkg), {});
    const handlers = {
      [ECHO_BINDING]: async (_ctx: unknown, payload: JsonValue) => payload,
      "host.memory.travel.profile": async () => ({ id: "mem_7c1f0a4e9b2d4c5e8f6a1b2c3d4e5f60", type: "travel.profile", title: "Home travel profile", fields: { home_airport: "BOS", preferred_cabin: "economy", prefer_nonstop: true, preferred_currency: "USD" }, body: "", tags: [], sealed: [] }),
      "host.memory.agent.read": async () => ({ body: "", updated: null }),
      "host.memory.agent.write": async (_ctx: unknown, payload: JsonValue) => {
        memory.agent!.staged = { body: (payload as JsonObject).body as string, bytes: 5 };
        return { staged: true, bytes: 5 };
      },
    };
    const workflow = await Workflow.create(pkg, { grants: sessionGrants(pkg), approvedTools: Object.keys(pkg.tools).sort(), handlers, memory });
    const notes = "# Notes\n- first run";
    let failure = null as (Error & { code?: string; execution_report?: Record<string, unknown> }) | null;
    try {
      await workflow.run({ value: "hello", proposals: { schema: "memory.v0 proposals", proposals: [{ action: "create", type: "person.self", title: "x", fields: {}, rationale: "r" }] }, notes });
    } catch (error) {
      failure = error as Error & { code?: string; execution_report?: Record<string, unknown> };
    }
    expect(failure?.code).toBe("permission_denied");
    const audit = failure!.execution_report!.audit as JsonObject[];
    const actions = audit.map((event) => event.action);
    expect(actions).not.toContain("memory.agent.committed");
    expect(actions.indexOf("workflow.failed")).toBeLessThan(actions.indexOf("memory.agent.discarded"));
    expect(actions.indexOf("memory.agent.discarded")).toBeLessThan(actions.indexOf("memory.cleared"));
    expect(audit.find((event) => event.action === "memory.agent.discarded")).toMatchObject({ package_id: "org.example.memory", reason: "run_failed" });
    expect(failure!.execution_report!.memory).toMatchObject({ refused: { reason: "memory_proposal_type_undeclared" }, agent: { committed: null, discarded: "run_failed" } });
  });
});
