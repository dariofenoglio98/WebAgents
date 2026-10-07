/**
 * Reading a run's own audit (`test_execution_report.py`), live progress as a pure count of
 * audit events (`test_execution_progress.py`), and the artifact renderer's rules.
 */
import { describe, expect, it } from "vitest";

import { artifactRecords, checkArtifactName, encodeJson, HOST_RESULT_NAMES } from "../../../src/core/execution/artifacts.js";
import { ProgressTracker } from "../../../src/core/execution/progress.js";
import { auditSummary, costSummary, failureSummary, modelEvidence, verifyAuditChain } from "../../../src/core/execution/report.js";
import type { JsonObject } from "../../../src/core/json.js";
import { digest } from "../../../src/core/workflow/runtime.js";
import { webair040 } from "../../helpers/fixtures.js";
import { execute } from "../../helpers/workflow.js";

/** `test_execution_report.py::chain`: events hashed the way the runtime hashes them. */
function chain(events: JsonObject[]): JsonObject[] {
  let previous: string | null = null;
  return events.map((fields, index) => {
    const body: JsonObject = { schema_version: "audit.v0", run_id: "run", sequence: index + 1, timestamp: "t", worker: null, role: null, parent: null, depth: 0, node_id: null, ...fields, previous_hash: previous };
    const event = { ...body, event_hash: digest(body) };
    previous = event.event_hash;
    return event;
  });
}

describe("the audit chain", () => {
  it("verifies when well formed; an edited, removed or reordered event breaks it", () => {
    const audit = chain([{ action: "runtime.started" }, { action: "model.completed", tokens: 100 }, { action: "workflow.completed" }]);
    expect(verifyAuditChain(audit)).toMatchObject({ valid: true, events: 3, final_hash: audit[2]!.event_hash, broken: [] });
    const edited = JSON.parse(JSON.stringify(audit)) as JsonObject[];
    edited[1]!.tokens = 1;
    expect(verifyAuditChain(edited).broken[0]).toEqual({ sequence: 2, reason: "event_hash" });
    expect(["previous_hash", "sequence"]).toContain(verifyAuditChain([audit[0]!, audit[2]!]).broken[0]!.reason);
    expect(verifyAuditChain([audit[1]!, audit[0]!, audit[2]!]).valid).toBe(false);
    expect(verifyAuditChain([]).valid).toBe(true);
  });

  it("a summary counts only what the chain contains", () => {
    const audit = chain([
      { action: "worker.spawned", worker: "W:1" },
      { action: "model.completed", worker: "W:1", model: "m", task: "t", cost_usd: 0.5 },
      { action: "model.completed", worker: "W:1", model: "m", task: "t" },
      { action: "tool.called", worker: "W:1", tool: "x" },
      { action: "node.completed", node_id: "n" },
      { action: "state.committed" },
      { action: "permission.checked" },
    ]);
    const summary = auditSummary(audit);
    expect(summary).toMatchObject({ workers: ["W:1"], worker_count: 1, workers_spawned: 1, nodes_completed: 1, model_calls: 2, tool_calls: 1, models_used: { m: 2 }, tasks_called: { t: 2 }, state_commits: 1, permission_checks: 1 });
    expect(costSummary(audit)).toMatchObject({ calls: 2, calls_with_reported_cost: 1, complete: false, total_usd: 0.5, status: "partial" });
    expect(costSummary(audit.slice(0, 2))).toMatchObject({ complete: true, status: "complete", total_usd: 0.5 });
    expect(costSummary(chain([{ action: "model.completed" }]))).toMatchObject({ status: "unknown", total_usd: null });
    expect(costSummary([])).toMatchObject({ calls: 0, complete: false, status: "unknown" });
  });

  it("a failure summary names the node, the check and the call, never data; a step failure is attributed to its map", () => {
    const audit = chain([
      { action: "node.started", node_id: "evidence" },
      { action: "tool.failed", tool: "reader", reason: "tool_unavailable" },
      { action: "node.failed", node_id: "evidence/read", error_code: "tool_error" },
      { action: "node.failed", node_id: "check", error_code: "schema_validation", failed_check: { check: "assertion", index: 0, failure: "duplicate_target_key" } },
      { action: "workflow.failed", error_code: "schema_validation" },
    ]);
    const summary = failureSummary(audit)!;
    expect(summary).toMatchObject({ node_id: "check", step_id: null, error_code: "schema_validation" });
    expect((summary.failed_check as JsonObject).failure).toBe("duplicate_target_key");
    expect(summary.call).toEqual({ kind: "tool", action: "tool.failed", tool: "reader", task: null, reason: "tool_unavailable" });
    const step = failureSummary(chain([{ action: "node.failed", node_id: "screening/read", error_code: "x" }, { action: "node.failed", node_id: "screening", error_code: "permission_denied" }]))!;
    expect([step.node_id, step.step_id]).toEqual(["screening", "read"]);
    expect(step.failed_check).toBeNull();
    expect(failureSummary(chain([{ action: "workflow.completed" }]))).toBeNull();
  });

  it("model evidence reports what answered rather than what was planned", () => {
    const router = { invocations: [{ model_id: "m", provider_id: "p", response_model: "m-2026-01-01", constrained_by_host: true, count_basis: "utf8_upper_bound" }, { model_id: "m", provider_id: "p", response_model: "m-2026-01-01", constrained_by_host: true, count_basis: "utf8_upper_bound" }] };
    expect(modelEvidence(router, "m")).toMatchObject({ planned: "m", invoked: ["m"], calls: 2, all_calls_used_planned_model: true, providers: ["p"], response_models: ["m-2026-01-01"], constrained_by_host: true, token_bound_basis: ["utf8_upper_bound"] });
    expect(modelEvidence({ invocations: [{ model_id: "other", provider_id: "p" }] }, "m")).toMatchObject({ invoked: ["other"], all_calls_used_planned_model: false });
    expect(modelEvidence(null, "m")).toMatchObject({ calls: 0, all_calls_used_planned_model: false, constrained_by_host: null });
  });

  it("a real runtime chain verifies end to end and the summary agrees with the usage", async () => {
    const result = await execute(await webair040());
    const audit = result.audit as unknown as JsonObject[];
    expect(verifyAuditChain(audit).valid).toBe(true);
    const summary = auditSummary(audit);
    expect(summary.model_calls).toBe(audit.filter((event) => event.action === "model.completed").length);
    expect(summary.tool_calls).toBe(Object.values(result.usage.tool_calls as JsonObject).reduce<number>((total, count) => total + (count as number), 0));
  });
});

describe("progress", () => {
  const event = (action: string, fields: JsonObject = {}): JsonObject => ({ action, ...fields });

  it("is a pure count of audit events: nodes, steps, workers, calls and budget, bounded rows", () => {
    const tracker = new ProgressTracker(null);
    tracker.observe(event("node.started", { node_id: "a" }));
    tracker.observe(event("worker.spawned", { worker: "W:1", role: "W", node_id: "a/step" }));
    tracker.observe(event("worker.started", { worker: "W:1" }));
    tracker.observe(event("model.called", { worker: "W:1" }));
    tracker.observe(event("model.completed", { worker: "W:1" }));
    tracker.observe(event("tool.called", { worker: "W:1" }));
    tracker.observe(event("tool.completed", { worker: "W:1" }));
    tracker.observe(event("budget.updated", { tokens: 42, remote_calls: 1 }));
    tracker.observe(event("node.completed", { node_id: "a/step" }));
    tracker.observe(event("worker.failed", { worker: "W:1", error: "CancelledError" }));
    tracker.observe(event("node.skipped", { node_id: "b" }));
    tracker.observe(event("node.completed", { node_id: "a" }));
    tracker.observe({ not: "an action" });
    const snapshot = tracker.snapshot();
    expect(snapshot).toMatchObject({ events: 12, last_action: "node.completed", active_nodes: [], completed_nodes: ["a"], skipped_nodes: ["b"], nodes_completed: 1, steps_completed: 1, workers_spawned: 1, workers_active: 0, peak_parallel_workers: 1, model_calls_started: 1, model_calls_completed: 1, tool_calls_started: 1, tool_calls_completed: 1, tokens: 42, remote_calls: 1 });
    expect(snapshot.workers[0]).toMatchObject({ id: "W:1", role: "W", node: "a", state: "cancelled", model_calls: 1, tool_calls: 1 });
    const many = new ProgressTracker(null);
    for (let index = 0; index < 100; index += 1) many.observe(event("worker.spawned", { worker: `W:${index}` }));
    expect(many.snapshot().workers).toHaveLength(64);
    expect(many.snapshot().workers_spawned).toBe(100);
  });

  it("sends are coalesced to one per interval plus one per node transition; a listener that throws changes nothing; close flushes", async () => {
    const sent: number[] = [];
    let clock = 0;
    const tracker = new ProgressTracker((snapshot) => sent.push(snapshot.events), { intervalSeconds: 60, clock: () => clock });
    tracker.observe(event("node.started", { node_id: "a" }));
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(sent).toEqual([1]);
    tracker.observe(event("model.called"));
    tracker.observe(event("model.completed"));
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(sent).toEqual([1]);
    clock = 120;
    tracker.observe(event("node.completed", { node_id: "a" }));
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(sent).toEqual([1, 4]);
    tracker.observe(event("budget.updated", { tokens: 1 }));
    tracker.close();
    expect(sent).toEqual([1, 4, 5]);
    tracker.observe(event("node.started", { node_id: "z" }));
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(sent).toEqual([1, 4, 5]);
    const throwing = new ProgressTracker(() => {
      throw new Error("refused");
    }, { intervalSeconds: 0 });
    throwing.observe(event("node.started", { node_id: "a" }));
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(throwing.snapshot().events).toBe(1);
    expect(throwing.sent).toBe(0);
    throwing.close();
  });
});

describe("artifacts", () => {
  it("renders result, audit, usage, provenance and the exports of a completed run only, with Python's layout", async () => {
    const pkg = await webair040();
    const result = await execute(pkg);
    const records = artifactRecords(result as unknown as JsonObject, pkg);
    expect(records.map(([name]) => name)).toEqual([...HOST_RESULT_NAMES, "answer.md", "search.json", "fare-rules.json", "booking.json"]);
    const text = new TextDecoder().decode(records[0]![1]);
    expect(text.endsWith("\n")).toBe(true);
    expect(text.startsWith('{\n  "status": "completed"')).toBe(true);
    const failed = artifactRecords({ status: "failed", audit: [], usage: {}, provenance: {} }, pkg);
    expect(failed.map(([name]) => name)).toEqual([...HOST_RESULT_NAMES]);
    expect(new TextDecoder().decode(encodeJson({ a: [] }))).toBe('{\n  "a": []\n}\n');
    const colliding = { ...pkg, graph: { ...pkg.graph, exports: [...(pkg.graph.exports as JsonObject[]), { path: "Answer.md", format: "text", value: { from: "result", path: "/answer" } }] } };
    expect(() => artifactRecords(result as unknown as JsonObject, colliding)).toThrow(/collide/u);
    for (const bad of ["", ".", "..", ".hidden", "a/b", "a\\b"]) expect(() => checkArtifactName(bad)).toThrow(/unsafe/u);
    expect(() => checkArtifactName("answer.md")).not.toThrow();
  });
});
