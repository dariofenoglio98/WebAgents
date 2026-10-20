/**
 * The execution host's compute bounds (compute.v0 C-31, C-36, C-52), ported from
 * `test_compute_runtime.py::test_the_execution_host_carries_the_compute_bounds`: the three host
 * ceilings in the limits document, `checkCompute` refusing a module above the page bound and a host
 * without an engine, the permission counted per call for `once`.
 */
import { describe, expect, it } from "vitest";

import { COMPUTE_LIMIT_EXCEEDED, COMPUTE_NOT_SUPPORTED, GRANT_UNSUPPORTED, ExecutionError } from "../../../src/core/execution/errors.js";
import { DEFAULT_HOST_LIMITS, effectiveBudget, normalizeHostLimits, PERMISSIVE_HOST_LIMITS, runtimeLimits } from "../../../src/core/execution/limits.js";
import { checkCapabilities, checkCompute, consumptionCounts, normalizeGrants } from "../../../src/core/execution/policy.js";
import type { JsonObject } from "../../../src/core/json.js";
import { caseModule, computeNode, probePackage } from "../../helpers/compute-package.js";

describe("the execution host's compute bounds", () => {
  it("carries the three ceilings in the limits document, with defaults and maxima", () => {
    expect(DEFAULT_HOST_LIMITS.compute_memory_pages).toBe(1024);
    expect(DEFAULT_HOST_LIMITS.compute_wall_seconds).toBe(10);
    expect(DEFAULT_HOST_LIMITS.compute_fuel).toBe(50_000_000_000);
    expect(PERMISSIVE_HOST_LIMITS.compute_memory_pages).toBe(1024);
    const limits = normalizeHostLimits({ compute_memory_pages: 2048, compute_wall_seconds: 20 });
    expect(limits.compute_memory_pages).toBe(2048);
    expect(limits.compute_wall_seconds).toBe(20);
    expect(limits.compute_fuel).toBe(DEFAULT_HOST_LIMITS.compute_fuel);
    expect(() => normalizeHostLimits({ compute_memory_pages: 65_537 })).toThrow(/compute_memory_pages exceeds the supported maximum of 65536/u);
    expect(() => normalizeHostLimits({ compute_wall_seconds: 301 })).toThrow(/compute_wall_seconds exceeds the supported maximum of 300/u);
    const runtime = runtimeLimits(limits) as Record<string, number>;
    expect(runtime.compute_memory_pages).toBe(2048);
    expect(runtime.compute_wall_seconds).toBe(20);
  });

  it("shows the ceilings under the budget's host figures and never under effective (no package budget for compute)", async () => {
    const { pkg } = await probePackage();
    const budget = effectiveBudget(pkg, normalizeHostLimits(null));
    expect((budget.host as JsonObject).compute_memory_pages).toBe(1024);
    expect("compute_memory_pages" in (budget.effective as JsonObject)).toBe(false);
  });

  it("refuses a module above the page bound and a host without an engine before the run", async () => {
    const { pkg } = await probePackage({ modules: { echo: caseModule("memory-over-host-cap") } });
    const limits = normalizeHostLimits(null);
    expect(() => checkCompute(pkg, limits, true)).toThrow(ExecutionError);
    try {
      checkCompute(pkg, limits, true);
    } catch (error) {
      expect((error as ExecutionError).code).toBe(COMPUTE_LIMIT_EXCEEDED);
      expect((error as Error).message).toMatch(/^Node compute runs module 'echo', whose declared memory maximum of 2048 pages is above this host's ceiling of 1024\./u);
    }
    const admitted = checkCompute(pkg, normalizeHostLimits({ compute_memory_pages: 4096 }), true)!;
    expect((admitted.operations as JsonObject[])[0]).toEqual({ node: "compute", module: "echo", memory_pages: 4096, wall_seconds: 10, fuel: 50_000_000_000 });
    expect(((admitted.modules as JsonObject[])[0] as JsonObject).memory_max_pages).toBe(2048);
    try {
      checkCompute(pkg, normalizeHostLimits({ compute_memory_pages: 4096 }), false);
    } catch (error) {
      expect((error as ExecutionError).code).toBe(COMPUTE_NOT_SUPPORTED);
    }
    const { pkg: echo } = await probePackage();
    const capabilities = checkCapabilities(echo, limits, { fixture: true, computeAvailable: true });
    expect((capabilities.compute as JsonObject).host).toEqual({ memory_pages: 1024, wall_seconds: 10, fuel: 50_000_000_000 });
    expect(() => checkCapabilities(echo, limits, { fixture: true })).toThrow(/no engine/u);
    const { pkg: plain } = await probePackage({ modules: {}, permission: false, nodes: [{ id: "compute", type: "validate", worker: "Coordinator", depends_on: [], input: { from: "state", path: "/request" }, output_schema: "schemas/compute-output.schema.json", timeout_seconds: 10, writes: { "/result": { from: "result", path: "" } } }] });
    expect(checkCompute(plain, limits, false)).toBeNull();
    expect("compute" in checkCapabilities(plain, limits, { fixture: true })).toBe(false);
  });

  it("counts every call against the compute permission, so once is refused for two calls", async () => {
    const two = await probePackage({ nodes: [computeNode("first", { writes: { "/first": { from: "result", path: "" } } }), computeNode("second", { dependsOn: ["first"] })], stateKeys: ["request", "first", "result"] });
    expect(consumptionCounts(two.pkg).compute).toBe(2);
    try {
      normalizeGrants(two.pkg, { "memory.session": "session", "compute.modules": "once" });
      throw new Error("expected a refusal");
    } catch (error) {
      expect((error as ExecutionError).code).toBe(GRANT_UNSUPPORTED);
      expect((error as Error).message).toMatch(/'compute\.modules' was granted 'once', but this workflow would use it up to 2 times/u);
    }
    const one = await probePackage();
    expect(normalizeGrants(one.pkg, { "memory.session": "session", "compute.modules": "once" })["compute.modules"]).toBe("once");
    const mapped = await probePackage({ nodes: [{ id: "each", type: "map", worker: "Worker", depends_on: [], input: { from: "state", path: "/request/items" }, item_schema: "schemas/compute-input.schema.json", max_items: 4, max_parallel: 2, steps: [{ id: "step", type: "compute", module: "echo", function: "run", input: { from: "item", path: "" }, input_schema: "schemas/compute-input.schema.json", output_schema: "schemas/compute-output.schema.json", timeout_seconds: 30 }], yield: { from: "steps", path: "/step" }, output_schema: "schemas/output.schema.json", timeout_seconds: 60, writes: { "/result": { from: "result", path: "" } } }] });
    expect(consumptionCounts(mapped.pkg).compute).toBe(4);
  });
});
