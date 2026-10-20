/**
 * One compute call, as it runs inside the call's Worker (compute.v0 §4, C-20…C-26): a fresh
 * instance of a compiled module, `alloc`, the input bytes written, the function called, the output
 * range read. Pure code over the `WebAssembly` API: no Worker scope, no timer, no host object, so
 * the same body serves the extension's Worker, the Node CLI's `worker_threads` Worker and the unit
 * tests. The deadline is not here: the parent terminates the Worker (D-250, D-251).
 *
 * The engine never reports a module's own failure as an exception: a trap, an ABI violation or an
 * instantiation the engine refused is an answer with a reason; only what is not the module's (an
 * export the validated module cannot lack, an error that is not a trap) is `engine_error`, the
 * host's `worker_error` (C-40). An answer carries only the specification's words, never V8's text
 * (C-41).
 */
import { MAX_OUTPUT_BYTES, PAGE_BYTES } from "./limits.js";

/** The failure reasons a call can end with, shared by both runtimes (C-41). */
export const REASONS: readonly string[] = Object.freeze(["trap", "fuel_exhausted", "deadline", "abi_violation", "instantiation_failed"]);
/** The trap vocabulary (C-42); an engine maps its own names onto these, `other` for the rest. */
export const TRAP_CODES: readonly string[] = Object.freeze(["unreachable", "memory_out_of_bounds", "stack_overflow", "integer_division_by_zero", "integer_overflow", "bad_conversion_to_integer", "indirect_call_to_null", "bad_signature", "table_out_of_bounds", "null_reference", "other"]);
export const ENGINE_ERROR = "engine_error";

export type CallAnswer =
  | { ok: true; output: ArrayBuffer; memory_pages: number; elapsed_ms: number }
  | { ok: false; reason: string; trap_code?: string; detail?: string; memory_pages: number | null; elapsed_ms: number };

/**
 * V8's trap messages onto C-42's vocabulary. A stack overflow is a `RangeError`, not a
 * `WebAssembly.RuntimeError`, in V8; everything else the engine raises for a module's own fault is
 * a `RuntimeError` whose message names the trap. The message is read here and never recorded.
 * The V8 in Chrome 155 names a `call_indirect` through a null slot "null function" and one with
 * the wrong type "function signature mismatch", as wasmtime tells them apart; the V8 in Node 26.9
 * names both "function signature mismatch" (and older ones "null function or function signature
 * mismatch"), so under Node both are `bad_signature` and the comparison of two runtimes treats the
 * two codes as one (C-42, D-254).
 */
export function classifyTrap(error: unknown): { reason: "trap"; trap_code: string } | null {
  const message = error instanceof Error ? error.message : "";
  if (error instanceof RangeError && /call stack/iu.test(message)) return { reason: "trap", trap_code: "stack_overflow" };
  if (!(error instanceof WebAssembly.RuntimeError)) return null;
  const text = message.toLowerCase();
  const code = text.includes("unreachable")
    ? "unreachable"
    : text.includes("memory access out of bounds") || text.includes("data segment")
      ? "memory_out_of_bounds"
      : text.includes("call stack")
        ? "stack_overflow"
        : text.includes("divide by zero") || text.includes("remainder by zero")
          ? "integer_division_by_zero"
          : text.includes("unrepresentable") && text.includes("divide")
            ? "integer_overflow"
            : text.includes("float unrepresentable") || text.includes("unrepresentable in integer")
              ? "bad_conversion_to_integer"
              : text.includes("signature mismatch")
                ? "bad_signature"
                : text.includes("null function")
                  ? "indirect_call_to_null"
                  : text.includes("table") && text.includes("out of bounds")
                    ? "table_out_of_bounds"
                    : text.includes("element segment")
                      ? "table_out_of_bounds"
                      : text.includes("null")
                        ? "null_reference"
                        : "other";
  return { reason: "trap", trap_code: code };
}

/** The pages of a memory whose buffer may have been replaced by growth: always read afresh. */
const pagesOf = (memory: WebAssembly.Memory): number => memory.buffer.byteLength / PAGE_BYTES;

export function runComputeCall(module: WebAssembly.Module, fn: string, input: Uint8Array): CallAnswer {
  const started = Date.now();
  const elapsed = (): number => Date.now() - started;
  let instance: WebAssembly.Instance;
  try {
    // The start function, when the module has one, runs here under the same bounds (C-29).
    instance = new WebAssembly.Instance(module, {});
  } catch (error) {
    const trap = classifyTrap(error);
    if (trap !== null) return { ok: false, ...trap, memory_pages: null, elapsed_ms: elapsed() };
    // The engine's own words differ between engines and versions: C-41 records the reason alone.
    return { ok: false, reason: "instantiation_failed", memory_pages: null, elapsed_ms: elapsed() };
  }
  const exports = instance.exports;
  const memory = exports.memory;
  const alloc = exports.alloc;
  const run = exports[fn];
  if (!(memory instanceof WebAssembly.Memory) || typeof alloc !== "function" || typeof run !== "function") {
    // The validated module exports all three; a module that does not is not the one validated.
    return { ok: false, reason: ENGINE_ERROR, memory_pages: null, elapsed_ms: elapsed() };
  }
  try {
    const raw = (alloc as (length: number) => unknown)(input.length);
    if (typeof raw !== "number") return { ok: false, reason: "abi_violation", detail: "alloc", memory_pages: pagesOf(memory), elapsed_ms: elapsed() };
    // An i32 comes back signed; the ABI's pointers are unsigned (C-22: a memory above 32,768
    // pages has valid addresses at and above 2 GiB).
    const pointer = raw >>> 0;
    if (pointer === 0 || pointer + input.length > memory.buffer.byteLength) return { ok: false, reason: "abi_violation", detail: "alloc", memory_pages: pagesOf(memory), elapsed_ms: elapsed() };
    new Uint8Array(memory.buffer).set(input, pointer);
    const result = (run as (pointer: number, length: number) => unknown)(pointer, input.length);
    if (typeof result !== "bigint") return { ok: false, reason: "abi_violation", detail: "result", memory_pages: pagesOf(memory), elapsed_ms: elapsed() };
    const value = BigInt.asUintN(64, result);
    const outPtr = Number(value >> 32n);
    const outLen = Number(value & 0xffffffffn);
    const size = memory.buffer.byteLength;
    if (outLen === 0 || outPtr + outLen > size) return { ok: false, reason: "abi_violation", detail: "output_range", memory_pages: pagesOf(memory), elapsed_ms: elapsed() };
    if (outLen > MAX_OUTPUT_BYTES) return { ok: false, reason: "abi_violation", detail: "output_too_large", memory_pages: pagesOf(memory), elapsed_ms: elapsed() };
    const output = memory.buffer.slice(outPtr, outPtr + outLen);
    return { ok: true, output, memory_pages: pagesOf(memory), elapsed_ms: elapsed() };
  } catch (error) {
    const trap = classifyTrap(error);
    if (trap !== null) return { ok: false, ...trap, memory_pages: pagesOf(memory), elapsed_ms: elapsed() };
    return { ok: false, reason: ENGINE_ERROR, memory_pages: pagesOf(memory), elapsed_ms: elapsed() };
  }
}
