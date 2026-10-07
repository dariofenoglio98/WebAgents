/**
 * The execution session end to end (`test_execution_session.py`): a real package through the
 * generic interpreter from bound plan to artifacts; every refusal before an instruction is
 * rendered; budget, deadline and cancellation stop a run and say so; the audit chain verifies
 * and detects tampering; the run record reads from the result and nothing else.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { fixtureAdapters } from "../../../src/core/fixtures.js";
import type { ExecutionError } from "../../../src/core/execution/errors.js";
import { localExecutionPlan, type ExecutionAuthorization, type ExecutionPlan } from "../../../src/core/execution/plan.js";
import { completeRunRecord, failRunRecord, initialRunRecord } from "../../../src/core/execution/record.js";
import { verifyAuditChain } from "../../../src/core/execution/report.js";
import { ExecutionSession, type BeginRequest, type ExecutionOutcome, type SessionDeps } from "../../../src/core/execution/runner.js";
import type { JsonObject, JsonValue } from "../../../src/core/json.js";
import type { ModelBindingDescriptor } from "../../../src/core/models/binding.js";
import type { ModelRequest, ModelResult, ModelRouter } from "../../../src/core/models/contract.js";
import { ECHO_IMPLEMENTATION } from "../../../src/core/tools/broker.js";
import { Pacer } from "../../../src/core/tools/pacer.js";
import { MemoryResourceStore } from "../../../src/core/tools/resources.js";
import { definitionFor, ECHO_INPUT, ECHO_TOOL, echoPackage, planBindingFor } from "../../helpers/echo-package.js";
import { inputs, webair040 } from "../../helpers/fixtures.js";
import { readBytes, ROOT, SHIPPED } from "../../helpers/paths.js";

const ARCHIVE = readBytes(SHIPPED.webair040.archive);
const GRANTS = inputs().decisions;
const DOCUMENT = JSON.parse(readFileSync(join(ROOT, "demo", "webair", "host-resources.json"), "utf8")) as JsonObject;

async function webairPlan(options: { approved?: string[]; grants?: Record<string, string> } = {}): Promise<{ plan: ExecutionPlan; authorization: ExecutionAuthorization }> {
  const pkg = await webair040();
  return localExecutionPlan({ pkg, archiveSha256: SHIPPED.webair040.archiveSha256, signerFingerprint: SHIPPED.webair040.fingerprint, decisions: options.grants ?? GRANTS, approvedTools: options.approved ?? Object.keys(pkg.tools), fixture: true });
}

async function webairSession(overrides: Partial<BeginRequest> = {}, deps: Partial<SessionDeps> = {}, planOptions: Parameters<typeof webairPlan>[0] = {}): Promise<{ session: ExecutionSession; request: BeginRequest; deps: SessionDeps }> {
  const pkg = await webair040();
  const { plan, authorization } = await webairPlan(planOptions);
  const fixture = fixtureAdapters(pkg);
  const request: BeginRequest = { run_id: "run_test", run_plan: plan, authorization, input: fixture.input, ...overrides };
  return { session: new ExecutionSession(), request, deps: { archive: ARCHIVE, fixture: { router: fixture.router, handlers: fixture.handlers }, ...deps } };
}

async function refusal(promise: Promise<unknown>): Promise<ExecutionError> {
  try {
    await promise;
  } catch (error) {
    return error as ExecutionError;
  }
  throw new Error("expected a refusal");
}

const decode = (outcome: ExecutionOutcome, name: string): JsonValue => JSON.parse(new TextDecoder().decode(outcome.files.find(([file]) => file === name)![1])) as JsonValue;

/** A router over a named test model that answers nothing: the echo graph has no llm node. */
class TestRouter implements ModelRouter {
  readonly remote = false;
  readonly router_id = "test";
  readonly model_id = "test/model";
  readonly capabilities: ReadonlySet<string> = new Set(["structured_output", "reasoning"]);
  readonly context_window = 1_000_000;
  readonly invocations: never[] = [];
  async countTokens(_request: ModelRequest): Promise<number> {
    return 1;
  }
  async complete(): Promise<ModelResult> {
    throw new Error("no model call expected");
  }
}

const TEST_BINDING: ModelBindingDescriptor = { host_model_id: "test/model", provider_id: "test", model_id: "model", display_name: null, compatibility_status: null, evidence_strength: null, capabilities: {}, limits: { context_tokens: 1_000_000, native_context_window: null, max_output_tokens: null }, properties: { local: true }, pricing: null };

async function echoSession(options: { builtin?: (args: JsonValue) => Promise<JsonValue> | JsonValue; limits?: unknown; input?: JsonValue; resolver?: MemoryResourceStore; freeText?: boolean } = {}) {
  const echo = await echoPackage({ freeText: options.freeText });
  const definition = definitionFor(echo.pkg, ECHO_TOOL);
  const binding = planBindingFor(echo.pkg, definition);
  const decisions = Object.fromEntries((echo.pkg.policy.permissions as JsonObject[]).map((permission) => [String(permission.id), "session"]));
  const { plan, authorization } = localExecutionPlan({ pkg: echo.pkg, archiveSha256: echo.archiveSha256, signerFingerprint: echo.key.fingerprint, decisions, approvedTools: [ECHO_TOOL], fixture: false, modelBinding: TEST_BINDING, toolBindings: [binding] });
  const session = new ExecutionSession();
  const begin = await session.begin(
    { run_id: "echo_run", run_plan: plan, authorization, input: options.input ?? ECHO_INPUT, limits: options.limits },
    { archive: echo.bytes, router: new TestRouter(), tools: { definitions: [definition], builtins: { [ECHO_IMPLEMENTATION]: options.builtin ?? ((args) => args) }, pacer: new Pacer() }, resolver: options.resolver ?? null },
  );
  return { echo, plan, session, begin };
}

describe("a real package runs through the generic interpreter", () => {
  it("binds, runs the WebAir fixture to completion and returns agentpkg's file set with matching hashes", async () => {
    const { session, request, deps } = await webairSession();
    const begin = await session.begin(request, deps);
    expect(begin.package.verified).toContain("publisher_signature");
    expect(begin.capabilities.tools_declared).toBe(7);
    expect(begin.model?.required_capabilities).toEqual(["reasoning", "structured_output"]);
    expect(begin.execution.fixture).toBe(true);
    expect(begin.tools.source).toBe("package_fixture");
    const snapshots: number[] = [];
    deps.onProgress = (snapshot) => snapshots.push(snapshot.events);
    const outcome = await session.run();
    expect(outcome.result.status).toBe("completed");
    expect(outcome.result.error_code).toBeNull();
    expect(outcome.files.map(([name]) => name)).toEqual(["result.json", "audit.json", "usage.json", "provenance.json", "answer.md", "search.json", "fare-rules.json", "booking.json"]);
    const artifacts = outcome.result.artifacts as JsonObject[];
    expect(artifacts.map((item) => item.name)).toEqual(outcome.files.map(([name]) => name));
    for (const [name, data] of outcome.files) expect(artifacts.find((item) => item.name === name)!.bytes).toBe(data.length);
    const result = decode(outcome, "result.json") as JsonObject;
    expect(result.status).toBe("completed");
    expect((result.provenance as JsonObject).synthetic).toBe(true);
    expect((outcome.result.usage as JsonObject).tokens).toBe((decode(outcome, "usage.json") as JsonObject).tokens);
    const summary = outcome.result.audit as JsonObject;
    expect((summary.chain as JsonObject).valid).toBe(true);
    expect(summary.model_calls).toBeGreaterThan(0);
    expect((outcome.result.output as JsonObject).present).toBe(true);
    expect(outcome.result.cost).toMatchObject({ status: "unknown", total_usd: null });
    expect((outcome.result.package_execution as JsonObject).tool_calls).toBe(summary.tool_calls);
    expect(snapshots.length).toBeGreaterThan(0);
    expect(snapshots[snapshots.length - 1]).toBe((outcome.result.progress as JsonObject).events);
    expect((outcome.result.progress as JsonObject).events).toBe((summary.chain as JsonObject).events);
  });

  it("the audit chain re-verifies from the written file, and any edit or deletion is detected", async () => {
    const { session, request, deps } = await webairSession();
    await session.begin(request, deps);
    const outcome = await session.run();
    const audit = decode(outcome, "audit.json") as JsonObject[];
    expect(verifyAuditChain(audit)).toMatchObject({ valid: true, events: audit.length, final_hash: audit[audit.length - 1]!.event_hash });
    const edited = JSON.parse(JSON.stringify(audit)) as JsonObject[];
    edited[5]!.action = "model.completed";
    expect(verifyAuditChain(edited).broken[0]).toEqual({ sequence: 6, reason: "event_hash" });
    const removed = [...audit.slice(0, 3), ...audit.slice(4)];
    expect(["previous_hash", "sequence"]).toContain(verifyAuditChain(removed).broken[0]!.reason);
    const reordered = [audit[1]!, audit[0]!, ...audit.slice(2)];
    expect(verifyAuditChain(reordered).valid).toBe(false);
  });

  it("one session binds once and runs once; running unbound is refused; cancelling before the run leaves nothing running", async () => {
    const { session, request, deps } = await webairSession();
    expect((await refusal(session.run())).code).toBe("execution_not_bound");
    await session.begin(request, deps);
    expect((await refusal(session.begin(request, deps))).code).toBe("execution_already_started");
    expect(session.cancel()).toEqual({ cancel_requested: true, running: false });
    const outcome = await session.run();
    expect(outcome.result.status).toBe("cancelled");
    expect(outcome.result.cancel_requested).toBe(true);
    expect((outcome.result.audit as JsonObject).model_calls).toBe(0);
    expect((await refusal(session.run())).code).toBe("execution_already_started");
  });
});

describe("refusals before an instruction is rendered", () => {
  it("an artifact that is not the planned one", async () => {
    const { session, request, deps } = await webairSession({}, { archive: readBytes(SHIPPED.webair.archive) });
    expect((await refusal(session.begin(request, deps))).code).toBe("execution_artifact_mismatch");
  });

  it("a denied required permission, an unsupported grant, invalid or oversized input", async () => {
    const denied = await webairSession({}, {}, { grants: { ...GRANTS, "model.reasoning": "deny" } });
    expect((await refusal(denied.session.begin(denied.request, denied.deps))).code).toBe("execution_permission_denied");
    const always = await webairSession({}, {}, { grants: { ...GRANTS, "memory.session": "always" } });
    expect((await refusal(always.session.begin(always.request, always.deps))).code).toBe("execution_grant_unsupported");
    const invalid = await webairSession({ input: { not: "the schema" } });
    expect((await refusal(invalid.session.begin(invalid.request, invalid.deps))).code).toBe("execution_input_invalid");
    const oversized = await webairSession({ input: { query: "x".repeat(300 * 1024) } });
    expect((await refusal(oversized.session.begin(oversized.request, oversized.deps))).code).toBe("execution_input_invalid");
  });

  it("an output cap above the host ceiling, a model that cannot satisfy the package, and a plan whose model is not the router's", async () => {
    const cap = await webairSession({ limits: { max_output_tokens_per_call: 10 } });
    expect((await refusal(cap.session.begin(cap.request, cap.deps))).code).toBe("execution_output_cap_too_large");
    const pkg = await webair040();
    const fixture = fixtureAdapters(pkg);
    const weak = Object.create(fixture.router, { capabilities: { value: new Set(["structured_output"]) } }) as typeof fixture.router;
    const incompatible = await webairSession({}, { fixture: { router: weak, handlers: fixture.handlers } });
    expect((await refusal(incompatible.session.begin(incompatible.request, incompatible.deps))).code).toBe("execution_model_incompatible");
    const { echo, plan } = await echoSession();
    const wrong = new ExecutionSession();
    const decisions = Object.fromEntries((echo.pkg.policy.permissions as JsonObject[]).map((permission) => [String(permission.id), "session"]));
    const definition = definitionFor(echo.pkg, ECHO_TOOL);
    const other = localExecutionPlan({ pkg: echo.pkg, archiveSha256: echo.archiveSha256, signerFingerprint: echo.key.fingerprint, decisions, approvedTools: [ECHO_TOOL], fixture: false, modelBinding: { ...TEST_BINDING, host_model_id: "other/model" }, toolBindings: [planBindingFor(echo.pkg, definition)] });
    expect(plan.model_binding?.host_model_id).toBe("test/model");
    expect((await refusal(wrong.begin({ run_id: "r", run_plan: other.plan, authorization: other.authorization, input: ECHO_INPUT }, { archive: echo.bytes, router: new TestRouter(), tools: { definitions: [definition], builtins: {} } }))).code).toBe("selected_model_unavailable");
  });

  it("a declared tool with no binding and no denial is a host limit; a denied tool blocks nothing and is refused at dispatch", async () => {
    const { echo } = await echoSession();
    const decisions = Object.fromEntries((echo.pkg.policy.permissions as JsonObject[]).map((permission) => [String(permission.id), "session"]));
    const unbound = localExecutionPlan({ pkg: echo.pkg, archiveSha256: echo.archiveSha256, signerFingerprint: echo.key.fingerprint, decisions, approvedTools: [ECHO_TOOL], fixture: false, modelBinding: TEST_BINDING, toolBindings: [] });
    const session = new ExecutionSession();
    expect((await refusal(session.begin({ run_id: "r", run_plan: unbound.plan, authorization: unbound.authorization, input: ECHO_INPUT }, { archive: echo.bytes, router: new TestRouter(), tools: { definitions: [] } }))).code).toBe("tools_not_supported");
    // D-022: the person did not approve the tool. The plan is runnable; the graph's call is refused by the runtime.
    const denied = localExecutionPlan({ pkg: echo.pkg, archiveSha256: echo.archiveSha256, signerFingerprint: echo.key.fingerprint, decisions, approvedTools: [], fixture: false, modelBinding: TEST_BINDING, toolBindings: [] });
    expect(denied.plan.execution.denied_tool_ids).toEqual([ECHO_TOOL]);
    const run = new ExecutionSession();
    const begin = await run.begin({ run_id: "r", run_plan: denied.plan, authorization: denied.authorization, input: ECHO_INPUT }, { archive: echo.bytes, router: new TestRouter(), tools: { definitions: [], builtins: { [ECHO_IMPLEMENTATION]: (args) => args } } });
    expect(begin.capabilities.denied_tools).toEqual([ECHO_TOOL]);
    const outcome = await run.run();
    expect(outcome.result.status).toBe("failed");
    expect(outcome.result.error_code).toBe("permission_denied");
    expect((outcome.result.failure as JsonObject).node_id).toBe("echo");
  });
});

describe("a bound tool through the session", () => {
  it("completes the echo package with the generic handler and records the dispatch, never the payload", async () => {
    const { session, begin } = await echoSession();
    expect(begin.tools.bound).toEqual([ECHO_TOOL]);
    expect((begin.tools.bindings as JsonObject[])[0]).toMatchObject({ tool_id: ECHO_TOOL, approved: true, usable: true });
    expect(begin.execution.tool_handlers).toBe(1);
    const outcome = await session.run();
    expect(outcome.result.status).toBe("completed");
    expect((outcome.result.usage as JsonObject).tool_calls).toEqual({ [ECHO_TOOL]: 1 });
    const dispatches = outcome.result.tool_dispatches as JsonObject[];
    expect(dispatches).toHaveLength(1);
    expect(dispatches[0]).toMatchObject({ tool_id: ECHO_TOOL, outcome: "ok", remote: false });
    expect(JSON.stringify(outcome.result)).not.toContain("hello");
    expect(outcome.result.model).toMatchObject({ planned: "test/model", calls: 0, all_calls_used_planned_model: false });
  });

  it("the egress guard refuses a sealed host value inside a run, and the failure summary names the call, not the value", async () => {
    const store = await MemoryResourceStore.load(DOCUMENT, { key: new Uint8Array(32).fill(3) });
    const email = ((DOCUMENT.resources as JsonObject[]).find((resource) => resource.type === "personal.passenger_identity")!.value as JsonObject).contact_email as string;
    let reached = 0;
    const { session } = await echoSession({ resolver: store, freeText: true, input: { value: `please contact ${email} today` }, builtin: (args) => { reached += 1; return args; } });
    const outcome = await session.run();
    expect(outcome.result.status).toBe("failed");
    expect(outcome.result.error_code).toBe("tool_error");
    expect(reached).toBe(0);
    expect((outcome.result.failure as JsonObject).call).toMatchObject({ kind: "tool", action: "tool.failed", tool: ECHO_TOOL, reason: "tool_request_invalid" });
    expect(JSON.stringify(outcome.result)).not.toContain(email);
    for (const [, data] of outcome.files) expect(new TextDecoder().decode(data)).not.toContain(email);
  });
});

describe("budgets, deadlines and cancellation", () => {
  it("a tight token budget stops the run with budget_exhausted and still writes the artifacts", async () => {
    const { session, request, deps } = await webairSession({ limits: { total_tokens: 100 } });
    await session.begin(request, deps);
    const outcome = await session.run();
    expect(outcome.result.status).toBe("failed");
    expect(outcome.result.error_code).toBe("budget_exhausted");
    expect(outcome.files.map(([name]) => name)).toEqual(["result.json", "audit.json", "usage.json", "provenance.json"]);
    expect((outcome.result.audit as JsonObject).chain).toMatchObject({ valid: true });
    expect(((outcome.result.limits as JsonObject).budget as JsonObject).effective).toMatchObject({ hard_tokens: 100 });
  });

  it("a tight remote-call budget stops the run", async () => {
    const { session, request, deps } = await webairSession({ limits: { max_remote_calls: 1 } });
    await session.begin(request, deps);
    const outcome = await session.run();
    expect(outcome.result.status).toBe("failed");
    expect(outcome.result.error_code).toBe("budget_exhausted");
  });

  it("the host run timeout stops a slow run and says so", async () => {
    const { session } = await echoSession({ builtin: () => new Promise<JsonValue>(() => undefined), limits: { run_timeout_seconds: 1 } });
    const outcome = await session.run();
    expect(outcome.result.status).toBe("failed");
    expect(outcome.result.error_code).toBe("timeout");
    expect(outcome.result.deadline_exceeded).toBe(true);
    expect((outcome.result.limits as JsonObject).effective_deadline_seconds).toBe(1);
    expect((outcome.result.audit as JsonObject).chain).toMatchObject({ valid: true });
  }, 10_000);

  it("cancellation within a wave stops the in-flight call and reports cancelled with a valid chain", async () => {
    let aborted = false;
    const { session } = await echoSession({ builtin: () => new Promise<JsonValue>(() => undefined) });
    const running = session.run();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(session.snapshot?.active_nodes).toEqual(["echo"]);
    const stop = session.cancel();
    expect(stop).toEqual({ cancel_requested: true, running: true });
    const outcome = await running;
    aborted = true;
    expect(aborted).toBe(true);
    expect(outcome.result.status).toBe("cancelled");
    expect(outcome.result.error_code).toBe("cancelled");
    expect(outcome.result.cancel_requested).toBe(true);
    expect(outcome.result.deadline_exceeded).toBe(false);
    expect((outcome.result.audit as JsonObject).chain).toMatchObject({ valid: true });
    expect(outcome.files.map(([name]) => name)).toContain("result.json");
    const audit = decode(outcome, "audit.json") as JsonObject[];
    expect(audit.some((event) => event.action === "workflow.cancelled" || event.action === "node.failed")).toBe(true);
  });
});

describe("the run record", () => {
  it("is read from the begin report and the result, in the plugin's field names, with no payload", async () => {
    const { session, request, deps } = await webairSession();
    const begin = await session.begin(request, deps);
    const created = new Date("2026-10-07T10:00:00Z");
    const plan = request.run_plan as ExecutionPlan;
    const initial = initialRunRecord({ begin, plan, createdAt: created, startedAt: created, host: { runtimeVersion: "0.1.0", verifiedVersion: "0.1.0" }, revalidated: ["preflight_ready"], origin: "fixture" });
    expect(initial.status).toBe("running");
    expect(initial.package).toMatchObject({ packageId: "org.webagents.webair", version: "0.4.0", executionProfile: "workflow.v0" });
    expect(initial.grants.decisions.find((item) => item.permissionId === "booking.simulate_purchase")?.decision).toBe("once");
    expect(initial.revalidated).toEqual(expect.arrayContaining(["preflight_ready", "runner:publisher_signature", "runner:tool_handlers:2"]));
    expect(initial.host.versionVerified).toBe(true);
    expect(initial.selectedModel).toBeNull();
    const outcome = await session.run();
    const record = completeRunRecord(initial, outcome.result, new Date("2026-10-07T10:00:05Z"));
    expect(record.status).toBe("completed");
    expect(record.durationMs).toBe(5000);
    expect(record.usage?.tokens).toBe((outcome.result.usage as JsonObject).tokens);
    expect(record.audit?.chainValid).toBe(true);
    expect(record.audit?.actions.find((item) => item.action === "model.completed")?.count).toBe(record.audit?.modelCalls);
    expect(record.artifacts.map((item) => item.name)).toEqual(outcome.files.map(([name]) => name));
    expect(record.outputSha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(record.failure).toBeNull();
    expect(record.cost).toMatchObject({ status: "unknown", totalUsd: null });
    const text = JSON.stringify(record);
    for (const word of ["Boston", "BOS", "instructions", "contact_email"]) expect(text).not.toContain(word);
    const failed = failRunRecord(initial, { code: "execution_artifact_mismatch", message: "x" }, new Date("2026-10-07T10:00:01Z"));
    expect(failed).toMatchObject({ status: "failed", errorCode: "execution_artifact_mismatch", durationMs: 1000 });
  });
});
