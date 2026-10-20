/**
 * The call body and the Worker engine (compute.v0 §4, §5; D-250, D-251): the ABI on the echo module,
 * V8's traps mapped onto C-42's words, the deadline as `terminate()`, cancellation, and the host's
 * own faults kept apart from the module's.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { compileModule, EngineFault, type ComputeEngine } from "../../../src/core/compute/engine.js";
import { DEFAULT_COMPUTE_LIMITS } from "../../../src/core/compute/limits.js";
import { classifyTrap, runComputeCall } from "../../../src/core/compute/worker-body.js";
import { sha256HexSync } from "../../../src/core/hash.js";
import { CancelledError } from "../../../src/core/workflow/errors.js";
import { buildTestEngine, type TestEngine } from "../../helpers/compute.js";
import { caseModule } from "../../helpers/compute-package.js";

const INPUT = new TextEncoder().encode('{"a":1,"b":"two"}');
const text = (buffer: ArrayBuffer) => new TextDecoder().decode(new Uint8Array(buffer));

describe("the call body", () => {
  it("runs the echo module through the ABI and reads the output range", async () => {
    const answer = runComputeCall(await compileModule(caseModule("echo")), "run", INPUT);
    expect(answer.ok).toBe(true);
    if (!answer.ok) return;
    expect(text(answer.output)).toBe('{"a":1,"b":"two"}');
    expect(answer.memory_pages).toBe(1);
    expect(answer.elapsed_ms).toBeGreaterThanOrEqual(0);
  });

  it("maps the module's own failures onto the specification's words, never V8's text", async () => {
    const expectFailure = async (stem: string, reason: string, extra: Record<string, unknown> = {}) => {
      const answer = runComputeCall(await compileModule(caseModule(stem)), "run", INPUT);
      expect(answer.ok, stem).toBe(false);
      if (answer.ok) return;
      expect(answer.reason).toBe(reason);
      for (const [key, value] of Object.entries(extra)) expect((answer as unknown as Record<string, unknown>)[key], `${stem}.${key}`).toBe(value);
      expect(JSON.stringify(answer)).not.toMatch(/RuntimeError|RangeError|Maximum call stack/u);
    };
    await expectFailure("trap-unreachable", "trap", { trap_code: "unreachable" });
    await expectFailure("stack-overflow", "trap", { trap_code: "stack_overflow" });
    await expectFailure("grow-until-refused", "trap", { trap_code: "unreachable", memory_pages: 64 });
    // The reference tells these two apart (`indirect_call_to_null`, `bad_signature`), and so does the V8
    // in Chrome 155 (`scripts/e2e-compute.mjs`); the V8 in Node 26.9, which runs this suite, does not.
    await expectFailure("indirect-call-null", "trap", { trap_code: "bad_signature" });
    await expectFailure("indirect-call-bad-signature", "trap", { trap_code: "bad_signature" });
    await expectFailure("alloc-returns-zero", "abi_violation", { detail: "alloc" });
    await expectFailure("alloc-out-of-range", "abi_violation", { detail: "alloc" });
    await expectFailure("zero-length-output", "abi_violation", { detail: "output_range" });
    await expectFailure("out-of-range-output", "abi_violation", { detail: "output_range" });
  });

  it("hands back the bytes a module wrote without judging them (the runtime parses them)", async () => {
    for (const stem of ["bad-json-output", "bad-utf8-output", "schema-miss-output"]) {
      const answer = runComputeCall(await compileModule(caseModule(stem)), "run", INPUT);
      expect(answer.ok, stem).toBe(true);
    }
  });

  it("classifies V8's messages onto C-42 and leaves other errors to the host", () => {
    const trap = (message: string) => classifyTrap(new WebAssembly.RuntimeError(message));
    expect(trap("unreachable")).toEqual({ reason: "trap", trap_code: "unreachable" });
    expect(trap("memory access out of bounds")).toEqual({ reason: "trap", trap_code: "memory_out_of_bounds" });
    expect(trap("divide by zero")).toEqual({ reason: "trap", trap_code: "integer_division_by_zero" });
    expect(trap("divide result unrepresentable")).toEqual({ reason: "trap", trap_code: "integer_overflow" });
    expect(trap("float unrepresentable in integer range")).toEqual({ reason: "trap", trap_code: "bad_conversion_to_integer" });
    // The V8 in Node 26.9 names a null slot and a wrong type alike, "function signature mismatch", and
    // older ones "null function or function signature mismatch": `bad_signature`. The V8 in Chrome 155
    // names a null slot "null function" (D-254).
    expect(trap("null function or function signature mismatch")).toEqual({ reason: "trap", trap_code: "bad_signature" });
    expect(trap("function signature mismatch")).toEqual({ reason: "trap", trap_code: "bad_signature" });
    expect(trap("null function")).toEqual({ reason: "trap", trap_code: "indirect_call_to_null" });
    expect(trap("table index is out of bounds")).toEqual({ reason: "trap", trap_code: "table_out_of_bounds" });
    expect(trap("dereferencing a null pointer")).toEqual({ reason: "trap", trap_code: "null_reference" });
    expect(trap("something new")).toEqual({ reason: "trap", trap_code: "other" });
    expect(classifyTrap(new RangeError("Maximum call stack size exceeded"))).toEqual({ reason: "trap", trap_code: "stack_overflow" });
    expect(classifyTrap(new TypeError("Cannot convert 1024 to a BigInt"))).toBeNull();
  });

  it("refuses a module V8 cannot compile as module_invalid, without the engine's words", async () => {
    await expect(compileModule(new Uint8Array([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0, 1, 1]))).rejects.toThrow(/^module_invalid: the engine refused the module$/u);
  });
});

describe("the Worker engine", () => {
  let built: TestEngine;
  let engine: ComputeEngine;
  const sha = (stem: string) => sha256HexSync(caseModule(stem));

  beforeAll(async () => {
    built = await buildTestEngine();
    engine = built.engine;
    for (const stem of ["echo", "loop-forever", "trap-unreachable"]) await engine.compile(sha(stem), caseModule(stem));
  });
  afterAll(() => built.dispose());

  it("names itself after Node and meters no fuel", () => {
    expect(engine.id).toMatch(/^node\/v\d+/u);
    expect(engine.metersFuel).toBe(false);
  });

  it("runs a call in a Worker and brings the output back", async () => {
    const outcome = await engine.call(sha("echo"), "run", INPUT, DEFAULT_COMPUTE_LIMITS, new AbortController().signal);
    expect(outcome.reason).toBeNull();
    expect(new TextDecoder().decode(outcome.output!)).toBe('{"a":1,"b":"two"}');
    expect(outcome.memory_pages).toBe(1);
    expect(outcome.fuel_consumed).toBeNull();
  });

  it("reports a trap as the module's own failure", async () => {
    const outcome = await engine.call(sha("trap-unreachable"), "run", INPUT, DEFAULT_COMPUTE_LIMITS, new AbortController().signal);
    expect(outcome.reason).toBe("trap");
    expect(outcome.trap_code).toBe("unreachable");
  });

  it("terminates a module that never returns at the wall bound: the deadline is the CPU bound (D-250)", async () => {
    const started = Date.now();
    const outcome = await engine.call(sha("loop-forever"), "run", INPUT, { ...DEFAULT_COMPUTE_LIMITS, wall_seconds: 0.5 }, new AbortController().signal);
    const elapsed = Date.now() - started;
    expect(outcome.reason).toBe("deadline");
    expect(outcome.memory_pages).toBeNull();
    expect(outcome.fuel_consumed).toBeNull();
    expect(elapsed).toBeGreaterThanOrEqual(450);
    expect(elapsed).toBeLessThan(5_000);
  });

  it("terminates the Worker at once when the call is cancelled", async () => {
    const controller = new AbortController();
    const started = Date.now();
    const call = engine.call(sha("loop-forever"), "run", INPUT, DEFAULT_COMPUTE_LIMITS, controller.signal);
    setTimeout(() => controller.abort(new CancelledError()), 100);
    await expect(call).rejects.toBeInstanceOf(CancelledError);
    expect(Date.now() - started).toBeLessThan(3_000);
  });

  it("treats a module it did not compile as the host's fault", async () => {
    await expect(engine.call("0".repeat(64), "run", INPUT, DEFAULT_COMPUTE_LIMITS, new AbortController().signal)).rejects.toBeInstanceOf(EngineFault);
  });

  it("runs calls of one wave in parallel, each in its own Worker", async () => {
    const started = Date.now();
    const calls = await Promise.all([1, 2, 3].map(() => engine.call(sha("loop-forever"), "run", INPUT, { ...DEFAULT_COMPUTE_LIMITS, wall_seconds: 0.4 }, new AbortController().signal)));
    expect(calls.map((c) => c.reason)).toEqual(["deadline", "deadline", "deadline"]);
    // Three sequential 0.4 s deadlines would take 1.2 s; in parallel they take about one.
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});
