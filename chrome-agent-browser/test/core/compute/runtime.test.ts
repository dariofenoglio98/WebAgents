/**
 * compute.v0 in the Chrome runtime, ported from `test_compute_runtime.py`: the call path and its
 * audit, the limits, determinism, the permission, the preflight, cancellation and the node timeout.
 * The modules are the hand-assembled ones of `examples/compute/cases`.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { DEFAULT_FUEL, DEFAULT_MEMORY_PAGES, DEFAULT_WALL_SECONDS } from "../../../src/core/compute/limits.js";
import type { JsonObject } from "../../../src/core/json.js";
import type { Package } from "../../../src/core/package.js";
import { fixtureAdapters } from "../../../src/core/fixtures.js";
import { CancelledError, PolicyError, WorkflowError } from "../../../src/core/workflow/errors.js";
import { runWorkflow, Workflow, type WorkflowOptions, type WorkflowResult } from "../../../src/core/workflow/interpreter.js";
import { digest } from "../../../src/core/workflow/runtime.js";
import { buildTestEngine, type TestEngine } from "../../helpers/compute.js";
import { caseModule, computeNode, probeGrants, probePackage, REQUEST } from "../../helpers/compute-package.js";

let built: TestEngine;
beforeAll(async () => {
  built = await buildTestEngine();
});
afterAll(() => built.dispose());

function run(pkg: Package, options: WorkflowOptions & { decisions?: Record<string, string> } = {}): Promise<WorkflowResult> {
  const { decisions, ...rest } = options;
  const { router, handlers, input } = fixtureAdapters(pkg);
  return runWorkflow(pkg, input, { router, handlers, grants: probeGrants(pkg, decisions), approvedTools: [], compute: built.engine, ...rest });
}

async function failing(pkg: Package, options: WorkflowOptions & { decisions?: Record<string, string> } = {}): Promise<Error & { code?: string; node_id?: string | null; execution_report?: Record<string, unknown> }> {
  try {
    await run(pkg, options);
  } catch (error) {
    return error as Error & { code?: string; node_id?: string | null; execution_report?: Record<string, unknown> };
  }
  throw new Error("expected the run to fail");
}

const events = (result: { audit: unknown[] }, action: string): JsonObject[] => (result.audit as JsonObject[]).filter((event) => event.action === action);

describe("a compute node", () => {
  it("runs the echo module for real in fixture mode, with the three events and the usage count", async () => {
    const { pkg } = await probePackage();
    const result = await run(pkg);
    expect(result.status).toBe("completed");
    expect(result.output).toEqual(REQUEST);
    expect(result.usage.compute_calls).toBe(1);
    const [called] = events(result, "compute.called");
    const [completed] = events(result, "compute.completed");
    expect(events(result, "compute.failed")).toEqual([]);
    expect(called!.node_id).toBe("compute");
    expect(completed!.node_id).toBe("compute");
    expect(called!.module).toBe("echo");
    expect(called!.function).toBe("run");
    expect(called!.module_sha256).toBe((pkg.graph.modules as JsonObject[])[0]!.sha256);
    expect(called!.input_bytes).toBe(17);
    expect(called!.input_hash).toBe(digest(REQUEST));
    expect(called!.limits).toEqual({ memory_pages: DEFAULT_MEMORY_PAGES, wall_seconds: DEFAULT_WALL_SECONDS, fuel: DEFAULT_FUEL });
    expect(called!.permissions).toEqual(["compute.modules"]);
    expect(completed!.output_hash).toBe(digest(REQUEST));
    expect(completed!.output_bytes).toBe(17);
    expect(completed!.memory_pages).toBe(1);
    expect((completed!.engine as JsonObject).id).toMatch(/^node\//u);
    expect((completed!.engine as JsonObject).fuel_consumed).toBeNull();
    expect(typeof (completed!.engine as JsonObject).elapsed_ms).toBe("number");
    // The permission was checked and consumed before the engine saw a byte, naming the node (C-44).
    const checks = events(result, "permission.checked").filter((event) => event.permission === "compute.modules");
    expect(checks.length).toBe(2);
    expect(checks.every((event) => event.node_id === "compute" && event.allowed === true)).toBe(true);
    const sequence = (result.audit as JsonObject[]).map((event) => event.action);
    expect(sequence.indexOf("compute.called")).toBeGreaterThan(sequence.lastIndexOf("permission.checked") - 3);
  });

  it("gives identical output across runs (C-47) and a package without modules no compute usage", async () => {
    const { pkg } = await probePackage();
    const first = await run(pkg);
    const second = await run(pkg);
    expect(events(first, "compute.completed")[0]!.output_hash).toBe(events(second, "compute.completed")[0]!.output_hash);
    const plain = await probePackage({ modules: {}, nodes: [{ id: "compute", type: "validate", worker: "Coordinator", depends_on: [], input: { from: "state", path: "/request" }, output_schema: "schemas/compute-output.schema.json", timeout_seconds: 10, writes: { "/result": { from: "result", path: "" } } }], permission: false });
    const result = await run(plain.pkg);
    expect("compute_calls" in result.usage).toBe(false);
  });

  it("runs two compute nodes in one wave and a compute step per map item", async () => {
    const nodes = [
      computeNode("first", { worker: "Worker", writes: { "/first": { from: "result", path: "" } } }),
      computeNode("second", { worker: "Coordinator", writes: { "/second": { from: "result", path: "" } } }),
      {
        id: "each",
        type: "map",
        worker: "Worker",
        depends_on: [],
        input: { from: "state", path: "/request/items" },
        item_schema: "schemas/compute-input.schema.json",
        max_items: 4,
        max_parallel: 2,
        steps: [{ id: "step", type: "compute", module: "echo", function: "run", input: { from: "item", path: "" }, input_schema: "schemas/compute-input.schema.json", output_schema: "schemas/compute-output.schema.json", timeout_seconds: 30 }],
        yield: { from: "steps", path: "/step" },
        output_schema: "schemas/output.schema.json",
        timeout_seconds: 60,
        writes: { "/result": { from: "result", path: "" } },
      },
    ];
    const { pkg } = await probePackage({ nodes, stateKeys: ["request", "first", "second", "result"], fixtureInput: { items: [{ n: 1 }, { n: 2 }, { n: 3 }] } });
    const result = await run(pkg);
    expect(result.output).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }]);
    expect(result.usage.compute_calls).toBe(5);
    const called = events(result, "compute.called").map((event) => event.node_id).sort();
    expect(called).toEqual(["each/step", "each/step", "each/step", "first", "second"]);
  });

  it("names each coordinator compute node of one wave from the operation (C-44, D-245)", async () => {
    const nodes = ["a", "b", "c"].map((id) => computeNode(id, { worker: "Coordinator", writes: { [`/${id}`]: { from: "result", path: "" } } }));
    const { pkg } = await probePackage({ nodes: [...nodes, { id: "join", type: "validate", worker: "Coordinator", depends_on: ["a", "b", "c"], input: { from: "state", path: "/a" }, output_schema: "schemas/output.schema.json", timeout_seconds: 10, writes: { "/result": { from: "result", path: "" } } }], stateKeys: ["request", "a", "b", "c", "result"] });
    const result = await run(pkg);
    expect(result.status).toBe("completed");
    for (const action of ["compute.called", "compute.completed"]) expect(events(result, action).map((event) => event.node_id).sort()).toEqual(["a", "b", "c"]);
    const checks = events(result, "permission.checked").filter((event) => event.permission === "compute.modules").map((event) => event.node_id);
    expect([...new Set(checks)].sort()).toEqual(["a", "b", "c"]);
  });

  it("lets a node lower the limits and never raise them", async () => {
    // The echo module declares 16 pages; a node may not promise fewer (C-8), so 16 is the floor here.
    const lowered = await probePackage({ nodes: [computeNode("compute", { limits: { memory_pages: 16, wall_seconds: 3, fuel: 1000 } })] });
    const result = await run(lowered.pkg);
    expect(events(result, "compute.called")[0]!.limits).toEqual({ memory_pages: 16, wall_seconds: 3, fuel: 1000 });
    const raised = await probePackage({ nodes: [computeNode("compute", { limits: { memory_pages: 4096, wall_seconds: 300, fuel: 10 ** 12 } })] });
    const again = await run(raised.pkg);
    expect(events(again, "compute.called")[0]!.limits).toEqual({ memory_pages: DEFAULT_MEMORY_PAGES, wall_seconds: DEFAULT_WALL_SECONDS, fuel: DEFAULT_FUEL });
    const host = await run(raised.pkg, { limits: { compute_memory_pages: 32, compute_wall_seconds: 2 } });
    expect(events(host, "compute.called")[0]!.limits).toEqual({ memory_pages: 32, wall_seconds: 2, fuel: DEFAULT_FUEL });
  });

  it.each([
    [{ compute_memory_pages: 0 }, /compute_memory_pages must be a positive integer/u],
    [{ compute_memory_pages: 70_000 }, /compute_memory_pages exceeds the supported maximum of 65536/u],
    [{ compute_wall_seconds: -1 }, /compute_wall_seconds must be a positive number/u],
    [{ compute_wall_seconds: 301 }, /compute_wall_seconds exceeds the supported maximum of 300/u],
    [{ compute_fuel: 1.5 }, /compute_fuel must be a positive integer/u],
  ])("validates the host compute limits %j", async (limits, match) => {
    const { pkg } = await probePackage();
    const error = await failing(pkg, { limits: limits as never });
    expect(error).toBeInstanceOf(PolicyError);
    expect(error.message).toMatch(match);
  });

  it("spends a once grant with the first call", async () => {
    const nodes = [computeNode("first", { writes: { "/first": { from: "result", path: "" } } }), computeNode("second", { dependsOn: ["first"] })];
    const { pkg } = await probePackage({ nodes, stateKeys: ["request", "first", "result"] });
    const error = await failing(pkg, { decisions: { "compute.modules": "once" } });
    expect(error).toBeInstanceOf(WorkflowError);
    expect(error.code).toBe("permission_denied");
    expect(error.node_id).toBe("second");
    const audit = (error.execution_report as { audit: JsonObject[] }).audit;
    expect(audit.filter((event) => event.action === "compute.completed").length).toBe(1);
    const failed = audit.find((event) => event.action === "compute.failed")!;
    expect(failed.node_id).toBe("second");
    expect(failed.error).toBe("PolicyError");
  });

  it("refuses a module above the host memory ceiling before the run, never lowering it", async () => {
    const { pkg } = await probePackage({ modules: { echo: caseModule("memory-over-host-cap") } });
    const error = await failing(pkg);
    expect(error).toBeInstanceOf(PolicyError);
    expect(error.code).toBe("compute_limit_exceeded");
    expect(error.message).toMatch(/^compute_limit_exceeded: node compute runs module 'echo', whose declared memory maximum of 2048 pages is above this host's ceiling of 1024$/u);
    // Raising the ceiling admits it.
    const result = await run(pkg, { limits: { compute_memory_pages: 4096 } });
    expect(result.status).toBe("completed");
  });

  it("requires the engine at construction, before runtime.started", async () => {
    const { pkg } = await probePackage();
    const error = await failing(pkg, { compute: null });
    expect(error).toBeInstanceOf(PolicyError);
    expect(error.code).toBe("compute_engine_unavailable");
    expect(error.execution_report).toBeUndefined();
  });

  it("runs nothing for a skipped compute node", async () => {
    const node = computeNode("compute", { when: { when: { left: { from: "state", path: "/request/a" }, op: "eq", right: { literal: 2 } }, otherwise: { literal: { skipped: true } } } });
    const { pkg } = await probePackage({ nodes: [node] });
    const result = await run(pkg);
    expect(result.output).toEqual({ skipped: true });
    expect(events(result, "compute.called")).toEqual([]);
    expect(result.usage.compute_calls).toBe(0);
  });

  it("interrupts a running call when the run is cancelled", async () => {
    const { pkg } = await probePackage({ modules: { echo: caseModule("loop-forever") } });
    const { router, handlers, input } = fixtureAdapters(pkg);
    const workflow = await Workflow.create(pkg, { router, handlers, grants: probeGrants(pkg), approvedTools: [], compute: built.engine });
    const started = Date.now();
    const running = workflow.run(input);
    setTimeout(() => workflow.cancel(), 200);
    await expect(running).rejects.toBeInstanceOf(CancelledError);
    expect(Date.now() - started).toBeLessThan(5_000);
    const audit = workflow.runtime.audit as unknown as JsonObject[];
    const failed = audit.find((event) => event.action === "compute.failed")!;
    expect(failed.error).toBe("CancelledError");
    expect(audit.at(-2)!.action).toBe("workflow.cancelled");
  });

  it("ends the engine call shortly after the node's own timeout (C-32)", async () => {
    const node = { ...computeNode("compute"), timeout_seconds: 1 };
    const { pkg } = await probePackage({ modules: { echo: caseModule("loop-forever") }, nodes: [node] });
    const started = Date.now();
    const error = await failing(pkg);
    expect(error.code).toBe("timeout");
    expect(Date.now() - started).toBeLessThan(4_000);
    const audit = (error.execution_report as { audit: JsonObject[] }).audit;
    const failed = audit.find((event) => event.action === "compute.failed")!;
    expect(["CancelledError", "TimeoutError"]).toContain(failed.error);
    // The effective limits stay the host's; the engine deadline is the node's own business.
    expect(audit.find((event) => event.action === "compute.called")!.limits).toEqual({ memory_pages: DEFAULT_MEMORY_PAGES, wall_seconds: DEFAULT_WALL_SECONDS, fuel: DEFAULT_FUEL });
  });

  it("reads alloc's pointer unsigned (C-22) and reports an engine fault as the host's worker_error (C-40)", async () => {
    // A pointer at or above 2 GiB is valid only with more than 32,768 pages; the out-of-range
    // module answers 0xFFFFFF00, which signed would be -256 and unsigned is outside its one page:
    // `alloc`, not a crash of the reader.
    const { pkg } = await probePackage({ modules: { echo: caseModule("alloc-out-of-range") } });
    const error = await failing(pkg);
    expect(error.code).toBe("compute_error");
    const failed = (error.execution_report as { audit: JsonObject[] }).audit.find((event) => event.action === "compute.failed")!;
    expect(failed.reason).toBe("abi_violation");
    expect(failed.detail).toBe("alloc");
    // A Worker that dies without answering is the host's fault.
    const broken = { ...built.fresh(), call: () => Promise.reject(Object.assign(new Error("boom"), { name: "EngineFault", code: "engine_error" })) };
    const { pkg: plain } = await probePackage();
    const fault = await failing(plain, { compute: broken });
    expect(fault.code).toBe("worker_error");
    const recorded = (fault.execution_report as { audit: JsonObject[] }).audit.find((event) => event.action === "compute.failed")!;
    expect(recorded.reason).toBe("engine_error");
    expect(recorded.error).toBe("EngineFault");
  });
});
