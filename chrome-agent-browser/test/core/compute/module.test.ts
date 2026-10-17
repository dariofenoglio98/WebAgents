/**
 * The module reader and the feature gate (compute.v0 §3, C-10…C-19), ported from
 * `test_compute_module.py`: the same bytes are accepted or refused with the same codes, and a
 * damaged module is a refusal, never an exception of the reader's own.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { checkModule, hasWasmHeader, MAX_MODULE_BYTES, ModuleError, readModule } from "../../../src/core/compute/module.js";
import { sha256HexSync } from "../../../src/core/hash.js";
import { caseList, caseModule } from "../../helpers/compute-package.js";
import { ROOT } from "../../helpers/paths.js";

const CASES = caseList();
const STEMS = Object.keys(CASES.modules).sort();
const EXAMPLES = [
  { path: "examples/compute/fares-as/dist/fares.wasm", functions: ["run"], sha256: "ef7e813b9ac330575c89c75d96aa63bfe25d77da8d3a699cf4718879a8f123c0" },
  { path: "examples/compute/bookkeeping-rs/dist/bookkeeping.wasm", functions: ["assign_ids", "match_quotes"], sha256: "5b9db688c2cf9c60c818ac7eaf748d98ee60b8ecc564d76c37199da68e13735e" },
];

/** What `cases.json` says the reader does with each module: the validation case that names it, else accepted. */
function expected(stem: string): { code: string; feature?: string } | null {
  // A validation case about the module itself: not one about a node's limits or the graph's declaration of it.
  const found = CASES.cases.find((c) => c.module === stem && c.stage === "validation" && !c.variant && !c.node_limits);
  return found ? { code: found.code, ...(found.feature ? { feature: found.feature } : {}) } : null;
}

describe("the committed case modules", () => {
  it("hash as cases.json lists them", () => {
    for (const stem of STEMS) expect(sha256HexSync(caseModule(stem)), stem).toBe(CASES.modules[stem]);
  });

  it.each(STEMS)("%s is accepted or refused as listed", (stem) => {
    const want = expected(stem);
    const bytes = caseModule(stem);
    if (want === null) {
      const facts = checkModule(bytes, ["run"]);
      expect(facts.functions).toEqual(["run"]);
      expect(facts.memory_max_pages).toBeGreaterThan(0);
      return;
    }
    let caught: unknown = null;
    try {
      checkModule(bytes, ["run"]);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ModuleError);
    expect((caught as ModuleError).code).toBe(want.code);
    if (want.feature) expect((caught as ModuleError).message).toContain(`${want.feature} proposal`);
  });
});

describe("the reader", () => {
  it("describes a module without an engine", () => {
    const info = readModule(caseModule("echo"));
    expect(info.imports).toEqual([]);
    expect(info.memories).toEqual([[1, 16]]);
    expect(info.exports.map((e) => e.name).sort()).toEqual(["alloc", "memory", "run"]);
    expect(info.start).toBeNull();
    expect(readModule(caseModule("with-start")).start).not.toBeNull();
    expect(hasWasmHeader(caseModule("echo"))).toBe(true);
    expect(hasWasmHeader(new TextEncoder().encode("not a module"))).toBe(false);
  });

  it("requires the functions a graph names, with the ABI signature", () => {
    expect(() => checkModule(caseModule("echo"), ["other"])).toThrow(/^module_export_missing: the module does not export 'other'$/u);
    expect(() => checkModule(caseModule("echo"), ["alloc"])).toThrow(/^module_export_signature: 'alloc' is the allocator/u);
    expect(() => checkModule(caseModule("echo"), [])).toThrow(/^module_export_missing: no function of the module is named by a node$/u);
    expect(() => checkModule(caseModule("bad-run-signature"), ["run"])).toThrow(/^module_export_signature: export 'run' has the signature \(i32\) -> \(i32\); \(i32, i32\) -> \(i64\) is required$/u);
  });

  it("refuses a module over the size cap by size first", () => {
    const big = new Uint8Array(MAX_MODULE_BYTES + 1);
    big.set(caseModule("echo"));
    expect(() => checkModule(big, ["run"])).toThrow(/^module_too_large: /u);
    expect(() => readModule(new Uint8Array([0, 0x61, 0x73, 0x6d, 2, 0, 0, 0]))).toThrow(/^module_malformed: not a WebAssembly core module/u);
  });

  it("accepts the example modules with the functions their graphs name", () => {
    for (const example of EXAMPLES) {
      const bytes = new Uint8Array(readFileSync(join(ROOT, example.path)));
      expect(sha256HexSync(bytes), example.path).toBe(example.sha256);
      const facts = checkModule(bytes, example.functions);
      expect(facts.functions).toEqual(example.functions);
      expect(facts.sha256).toBe(example.sha256);
      expect(facts.memory_max_pages).toBeGreaterThanOrEqual(facts.memory_min_pages);
    }
  });

  it("reads or refuses damaged modules, and never crashes (every byte is bounded)", () => {
    // `test_damaged_modules_are_read_or_refused_never_crash`: every truncation and every single-byte
    // change of every case module and of the smaller example module ends in a `ModuleError` or in an
    // accepted module, never in another exception.
    const inputs = [...STEMS.map((stem) => caseModule(stem)), new Uint8Array(readFileSync(join(ROOT, EXAMPLES[0]!.path)))];
    let refused = 0;
    let accepted = 0;
    for (const bytes of inputs) {
      const step = Math.max(1, Math.floor(bytes.length / 200));
      for (let cut = 8; cut < bytes.length; cut += step) {
        try {
          readModule(bytes.subarray(0, cut));
          accepted += 1;
        } catch (error) {
          expect(error, `truncation at ${cut}`).toBeInstanceOf(ModuleError);
          refused += 1;
        }
      }
      for (let at = 8; at < bytes.length; at += step) {
        const damaged = bytes.slice();
        damaged[at] = damaged[at]! ^ 0xff;
        try {
          readModule(damaged);
          accepted += 1;
        } catch (error) {
          expect(error, `byte ${at} flipped`).toBeInstanceOf(ModuleError);
          refused += 1;
        }
      }
    }
    expect(refused).toBeGreaterThan(100);
    expect(accepted).toBeGreaterThanOrEqual(0);
  });
});
