/**
 * Reading a WebAssembly core module without running it (compute.v0 §3, C-10…C-19): the port of
 * `agentpkg/compute/module.py`, byte for byte in what it accepts and refuses.
 *
 * Two things are decided here, and both runtimes decide them from the same bytes with no engine:
 * the **structural requirements** of a tier-1 module (no imports, one memory with a declared
 * maximum, the ABI exports with their exact signatures; a start function is allowed, C-17) and
 * the **feature gate** (every function body and constant expression is decoded, and only the
 * deterministic instruction set the specification lists is admitted). An engine validates types
 * and control flow when it compiles the module; this reader does not repeat that work, and it
 * never executes anything.
 *
 * Every look at a byte is bounded by the section or body it belongs to (`peek`, `byte`, `take`):
 * a damaged module is `module_malformed`, never an exception of the reader's own (T21 review 1).
 */
import { sha256HexSync } from "../hash.js";

export const PAGE_BYTES = 65536;
/** The format's own bound on a 32-bit memory, in pages (4 GiB). */
export const MAX_PAGES = 65536;
/** C-10: a module member is at most 4 MiB. */
export const MAX_MODULE_BYTES = 4 * 1024 * 1024;
/** C-19: the instruction set a tier-1 module may use. Everything else is refused by name. */
export const ALLOWED_FEATURES: readonly string[] = Object.freeze(["mvp", "sign-extension", "nontrapping-float-to-int", "bulk-memory", "multi-value", "reference-types", "mutable-globals"]);
/** Locals an engine would refuse anyway (wasmtime's own bound); refused here so a reader never spends time on an absurd declaration. */
export const MAX_LOCALS = 50_000;

const HEADER = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00];
const I32 = 0x7f;
const I64 = 0x7e;
const F32 = 0x7d;
const F64 = 0x7c;
const V128 = 0x7b;
const FUNCREF = 0x70;
const EXTERNREF = 0x6f;
const VALUE_TYPES = new Map<number, string>([
  [I32, "i32"],
  [I64, "i64"],
  [F32, "f32"],
  [F64, "f64"],
]);
const REF_TYPES = new Map<number, string>([
  [FUNCREF, "funcref"],
  [EXTERNREF, "externref"],
]);
const GC_TYPES = new Set([0x63, 0x64, 0x65, 0x66, 0x67, 0x68, 0x69, 0x6a, 0x6b, 0x6c, 0x6d, 0x6e, 0x71, 0x72, 0x73]);
// The order sections must appear in (custom sections may appear anywhere; 13 is the tag section).
const SECTION_ORDER = new Map<number, number>([
  [1, 1],
  [2, 2],
  [3, 3],
  [4, 4],
  [5, 5],
  [13, 6],
  [6, 7],
  [7, 8],
  [8, 9],
  [9, 10],
  [12, 11],
  [10, 12],
  [11, 13],
]);
const EXPORT_KINDS = new Map<number, string>([
  [0, "function"],
  [1, "table"],
  [2, "memory"],
  [3, "global"],
]);
const MEMARG_OPCODES = new Set<number>();
for (let op = 0x28; op < 0x3f; op += 1) MEMARG_OPCODES.add(op);
const PLAIN_OPCODES = new Set<number>([0x00, 0x01, 0x05, 0x0f, 0x1a, 0x1b, 0xd1]);
for (let op = 0x45; op < 0xc5; op += 1) PLAIN_OPCODES.add(op);
const U32_OPCODES = new Set([0x0c, 0x0d, 0x10, 0x20, 0x21, 0x22, 0x23, 0x24, 0x25, 0x26, 0xd2]);
const FEATURE_OPCODES = new Map<number, string>([
  ...[0x06, 0x07, 0x08, 0x09, 0x0a, 0x18, 0x19, 0x1f].map((op) => [op, "exception-handling"] as const),
  [0x12, "tail-call"],
  [0x13, "tail-call"],
  [0x14, "function-references"],
  [0x15, "function-references"],
  [0xd3, "gc"],
  [0xd4, "function-references"],
  [0xd5, "function-references"],
  [0xd6, "function-references"],
  [0xfb, "gc"],
  [0xfd, "simd"],
  [0xfe, "threads"],
]);
const EXTENDED_CONST = new Set([0x6a, 0x6b, 0x6c, 0x7c, 0x7d, 0x7e]);

/** A module that is not a tier-1 compute module; `code` is the specification's. */
export class ModuleError extends Error {
  override readonly name = "ModuleError";
  readonly code: string;
  /** The message without its `<code>: ` prefix, for callers that re-prefix it. */
  readonly reason: string;

  constructor(code: string, message: string) {
    super(`${code}: ${message}`);
    this.code = code;
    this.reason = message;
  }
}

export interface FuncType {
  params: readonly string[];
  results: readonly string[];
}

export interface Import {
  module: string;
  name: string;
  kind: string;
}

export interface Export {
  name: string;
  kind: string;
  index: number;
}

/** What the reader saw: enough to decide the requirements and to describe the module. */
export interface ModuleInfo {
  size: number;
  types: readonly FuncType[];
  imports: readonly Import[];
  functions: readonly number[];
  tables: number;
  memories: ReadonlyArray<readonly [number, number | null]>;
  globals: number;
  exports: readonly Export[];
  start: number | null;
  element_segments: number;
  data_segments: number;
  custom_sections: readonly string[];
}

/** An accepted module, as validation records it and as the agent page may show it. */
export interface ModuleFacts {
  sha256: string;
  size: number;
  memory_min_pages: number;
  memory_max_pages: number;
  functions: readonly string[];
  exports: readonly string[];
}

export function moduleFactsJson(facts: ModuleFacts): { sha256: string; size: number; memory_min_pages: number; memory_max_pages: number; functions: string[]; exports: string[] } {
  return { sha256: facts.sha256, size: facts.size, memory_min_pages: facts.memory_min_pages, memory_max_pages: facts.memory_max_pages, functions: [...facts.functions], exports: [...facts.exports] };
}

const funcTypeText = (type: FuncType): string => `(${type.params.join(", ")}) -> (${type.results.join(", ")})`;
const sameType = (a: FuncType, b: FuncType): boolean => a.params.join(",") === b.params.join(",") && a.results.join(",") === b.results.join(",");
const hex = (value: number): string => value.toString(16).padStart(2, "0");

function malformed(message: string): ModuleError {
  return new ModuleError("module_malformed", message);
}

function feature(name: string, where: string): ModuleError {
  return new ModuleError("module_feature_refused", `${where} uses the ${name} proposal, which tier-1 modules may not (allowed: ${ALLOWED_FEATURES.join(", ")})`);
}

class Reader {
  pos: number;
  readonly end: number;

  constructor(
    readonly data: Uint8Array,
    pos = 0,
    end: number | null = null,
  ) {
    this.pos = pos;
    this.end = end === null ? data.length : end;
  }

  /** The next byte, not consumed; every read of the bytes is bounded by `end`. */
  peek(): number {
    if (this.pos >= this.end) throw malformed("unexpected end of module");
    return this.data[this.pos]!;
  }

  byte(): number {
    const value = this.peek();
    this.pos += 1;
    return value;
  }

  take(count: number): Uint8Array {
    if (count < 0 || this.pos + count > this.end) throw malformed("unexpected end of module");
    const value = this.data.subarray(this.pos, this.pos + count);
    this.pos += count;
    return value;
  }

  u32(): number {
    let result = 0;
    let shift = 0;
    for (let index = 0; index < 5; index += 1) {
      const byte = this.byte();
      result += (byte & 0x7f) * 2 ** shift;
      if ((byte & 0x80) === 0) {
        if (result >= 2 ** 32) throw malformed("integer too large");
        return result;
      }
      shift += 7;
    }
    throw malformed("integer representation too long");
  }

  /**
   * Signed LEB128 of at most `bits` bits: the sign bit of the last byte extends over everything
   * above what was read, and the result must fit the width (so a last byte whose unused bits are
   * not the sign's is refused as the specification requires).
   */
  private signed(bits: number): bigint {
    let result = 0n;
    let shift = 0n;
    const limit = Math.floor((bits + 6) / 7);
    for (let index = 0; index < limit; index += 1) {
      const byte = this.byte();
      result |= BigInt(byte & 0x7f) << shift;
      shift += 7n;
      if ((byte & 0x80) === 0) {
        if (byte & 0x40) result -= 1n << shift;
        const bound = 1n << BigInt(bits - 1);
        if (!(-bound <= result && result < bound)) throw malformed("integer too large");
        return result;
      }
    }
    throw malformed("integer representation too long");
  }

  s32(): bigint {
    return this.signed(32);
  }

  s33(): bigint {
    return this.signed(33);
  }

  s64(): bigint {
    return this.signed(64);
  }

  name(): string {
    const raw = this.take(this.u32());
    try {
      return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(raw);
    } catch {
      throw malformed("a name is not UTF-8");
    }
  }

  valueType(where: string): string {
    const code = this.byte();
    const value = VALUE_TYPES.get(code);
    if (value !== undefined) return value;
    const ref = REF_TYPES.get(code);
    if (ref !== undefined) return ref;
    if (code === V128) throw feature("simd", where);
    if (GC_TYPES.has(code)) throw feature("gc", where);
    throw malformed(`${where}: unknown value type 0x${hex(code)}`);
  }

  refType(where: string): string {
    const code = this.byte();
    const ref = REF_TYPES.get(code);
    if (ref !== undefined) return ref;
    if (GC_TYPES.has(code)) throw feature("gc", where);
    throw malformed(`${where}: unknown reference type 0x${hex(code)}`);
  }

  limits(where: string): readonly [number, number | null] {
    const flag = this.byte();
    if (flag === 0x00 || flag === 0x01) {
      const minimum = this.u32();
      const maximum = flag === 0x01 ? this.u32() : null;
      if (maximum !== null && maximum < minimum) throw malformed(`${where}: limits maximum below minimum`);
      return [minimum, maximum];
    }
    if (flag === 0x02 || flag === 0x03) throw feature("threads", where);
    if (flag === 0x04 || flag === 0x05 || flag === 0x06 || flag === 0x07) throw feature("memory64", where);
    if (flag & 0x08) throw feature("custom-page-sizes", where);
    throw malformed(`${where}: unknown limits flag 0x${hex(flag)}`);
  }

  blockType(types: number): void {
    const first = this.peek();
    if (first < 0x80) {
      this.pos += 1;
      if (first === 0x40 || VALUE_TYPES.has(first) || REF_TYPES.has(first)) return;
      if (first < 0x40) {
        if (first >= types) throw malformed("block type names an undefined type");
        return;
      }
      if (first === V128) throw feature("simd", "a block type");
      if (GC_TYPES.has(first)) throw feature("gc", "a block type");
      throw malformed(`unknown block type 0x${hex(first)}`);
    }
    const index = this.s33();
    if (index < 0n || index >= BigInt(types)) throw malformed("block type names an undefined type");
  }

  /** A constant expression: the constants and references the core format allows. */
  constExpr(where: string): void {
    for (;;) {
      const op = this.byte();
      if (op === 0x0b) return;
      if (op === 0x41) this.s32();
      else if (op === 0x42) this.s64();
      else if (op === 0x43) this.take(4);
      else if (op === 0x44) this.take(8);
      else if (op === 0x23 || op === 0xd2) this.u32();
      else if (op === 0xd0) this.refType(where);
      else if (EXTENDED_CONST.has(op)) throw feature("extended-const", where);
      else if (FEATURE_OPCODES.has(op)) throw feature(FEATURE_OPCODES.get(op)!, where);
      else throw malformed(`${where}: opcode 0x${hex(op)} is not constant`);
    }
  }

  /** Decode one function body: immediates skipped, structure tracked, features gated. */
  instructions(types: number, where: string): void {
    let depth = 0;
    while (this.pos < this.end) {
      const op = this.byte();
      if (PLAIN_OPCODES.has(op)) continue;
      if (op === 0x02 || op === 0x03 || op === 0x04) {
        this.blockType(types);
        depth += 1;
      } else if (op === 0x0b) {
        if (depth === 0) return;
        depth -= 1;
      } else if (U32_OPCODES.has(op)) {
        this.u32();
      } else if (op === 0x0e) {
        const count = this.u32();
        for (let index = 0; index < count; index += 1) this.u32();
        this.u32();
      } else if (op === 0x11) {
        this.u32();
        this.u32();
      } else if (op === 0x1c) {
        const count = this.u32();
        for (let index = 0; index < count; index += 1) this.valueType(where);
      } else if (MEMARG_OPCODES.has(op)) {
        const align = this.u32();
        if (align & 0x40) throw feature("multi-memory", where);
        this.u32();
      } else if (op === 0x3f || op === 0x40) {
        if (this.byte() !== 0x00) throw feature("multi-memory", where);
      } else if (op === 0x41) {
        this.s32();
      } else if (op === 0x42) {
        this.s64();
      } else if (op === 0x43) {
        this.take(4);
      } else if (op === 0x44) {
        this.take(8);
      } else if (op === 0xd0) {
        this.refType(where);
      } else if (op === 0xfc) {
        this.prefixedFc(where);
      } else if (FEATURE_OPCODES.has(op)) {
        throw feature(FEATURE_OPCODES.get(op)!, where);
      } else {
        throw malformed(`${where}: unknown opcode 0x${hex(op)}`);
      }
    }
    throw malformed(`${where}: function body is not terminated`);
  }

  private prefixedFc(where: string): void {
    const sub = this.u32();
    if (sub <= 7) return; // saturating float-to-int conversions
    if (sub === 8) {
      this.u32();
      if (this.byte() !== 0x00) throw feature("multi-memory", where);
    } else if (sub === 9 || sub === 13) {
      this.u32();
    } else if (sub === 10) {
      if (this.byte() !== 0x00 || this.byte() !== 0x00) throw feature("multi-memory", where);
    } else if (sub === 11) {
      if (this.byte() !== 0x00) throw feature("multi-memory", where);
    } else if (sub === 12 || sub === 14) {
      this.u32();
      this.u32();
    } else if (sub === 15 || sub === 16 || sub === 17) {
      this.u32();
    } else if (sub === 18) {
      throw feature("memory-control", where);
    } else {
      throw malformed(`${where}: unknown 0xfc sub-opcode ${sub}`);
    }
  }
}

/** `data` begins with the WebAssembly header (magic and version 1): the container's member test (C-11). */
export function hasWasmHeader(data: Uint8Array): boolean {
  return data.length >= HEADER.length && HEADER.every((byte, index) => data[index] === byte);
}

/**
 * Read every section of a core module; throw `ModuleError` for anything outside tier 1's format
 * or feature set. Nothing is executed and no engine is involved.
 */
export function readModule(data: Uint8Array): ModuleInfo {
  if (!(data instanceof Uint8Array)) throw malformed("module bytes expected");
  if (!hasWasmHeader(data)) throw malformed("not a WebAssembly core module (magic number and version 1)");
  const reader = new Reader(data, HEADER.length);
  const types: FuncType[] = [];
  const imports: Import[] = [];
  const functions: number[] = [];
  let tables = 0;
  const memories: Array<readonly [number, number | null]> = [];
  let globalsCount = 0;
  const exports: Export[] = [];
  let start: number | null = null;
  let elements = 0;
  let dataCount: number | null = null;
  let dataSegments = 0;
  let codeEntries: number | null = null;
  const custom: string[] = [];
  let lastOrder = 0;
  while (reader.pos < reader.end) {
    const sectionId = reader.byte();
    const size = reader.u32();
    if (reader.pos + size > reader.end) throw malformed(`section ${sectionId} exceeds the module`);
    const section = new Reader(data, reader.pos, reader.pos + size);
    reader.pos += size;
    if (sectionId === 0) {
      custom.push(section.name());
      continue;
    }
    if (sectionId === 13) throw feature("exception-handling", "the tag section");
    const order = SECTION_ORDER.get(sectionId);
    if (order === undefined) throw malformed(`unknown section id ${sectionId}`);
    if (order <= lastOrder) throw malformed(`section ${sectionId} is out of order or repeated`);
    lastOrder = order;
    if (sectionId === 1) {
      const count = section.u32();
      for (let index = 0; index < count; index += 1) {
        const form = section.byte();
        if (form !== 0x60) {
          if (form === 0x4e || form === 0x4f || form === 0x50 || form === 0x5e || form === 0x5f) throw feature("gc", `type ${index}`);
          throw malformed(`type ${index}: unknown form 0x${hex(form)}`);
        }
        const params: string[] = [];
        const paramCount = section.u32();
        for (let p = 0; p < paramCount; p += 1) params.push(section.valueType(`type ${index}`));
        const results: string[] = [];
        const resultCount = section.u32();
        for (let r = 0; r < resultCount; r += 1) results.push(section.valueType(`type ${index}`));
        types.push({ params, results });
      }
    } else if (sectionId === 2) {
      const count = section.u32();
      for (let index = 0; index < count; index += 1) {
        const module = section.name();
        const name = section.name();
        const kind = section.byte();
        const where = `import ${index}`;
        if (kind === 0) {
          section.u32();
          imports.push({ module, name, kind: "function" });
        } else if (kind === 1) {
          section.refType(where);
          section.limits(where);
          imports.push({ module, name, kind: "table" });
        } else if (kind === 2) {
          section.limits(where);
          imports.push({ module, name, kind: "memory" });
        } else if (kind === 3) {
          section.valueType(where);
          section.byte();
          imports.push({ module, name, kind: "global" });
        } else if (kind === 4) {
          throw feature("exception-handling", where);
        } else {
          throw malformed(`${where}: unknown import kind ${kind}`);
        }
      }
    } else if (sectionId === 3) {
      const count = section.u32();
      for (let index = 0; index < count; index += 1) {
        const typeIndex = section.u32();
        if (typeIndex >= types.length) throw malformed(`function ${index} names an undefined type`);
        functions.push(typeIndex);
      }
    } else if (sectionId === 4) {
      const count = section.u32();
      for (let index = 0; index < count; index += 1) {
        const where = `table ${index}`;
        if (section.peek() === 0x40) throw feature("function-references", where);
        section.refType(where);
        section.limits(where);
        tables += 1;
      }
    } else if (sectionId === 5) {
      const count = section.u32();
      for (let index = 0; index < count; index += 1) {
        const [minimum, maximum] = section.limits(`memory ${index}`);
        if (minimum > MAX_PAGES || (maximum !== null && maximum > MAX_PAGES)) throw malformed(`memory ${index} exceeds ${MAX_PAGES} pages`);
        memories.push([minimum, maximum]);
      }
    } else if (sectionId === 6) {
      const count = section.u32();
      for (let index = 0; index < count; index += 1) {
        const where = `global ${index}`;
        section.valueType(where);
        const mutability = section.byte();
        if (mutability !== 0 && mutability !== 1) throw malformed(`${where}: unknown mutability`);
        section.constExpr(where);
        globalsCount += 1;
      }
    } else if (sectionId === 7) {
      const seen = new Set<string>();
      const count = section.u32();
      for (let index = 0; index < count; index += 1) {
        const name = section.name();
        const kind = section.byte();
        if (kind === 4) throw feature("exception-handling", `export ${pyQuote(name)}`);
        const kindName = EXPORT_KINDS.get(kind);
        if (kindName === undefined) throw malformed(`export ${pyQuote(name)}: unknown kind ${kind}`);
        if (seen.has(name)) throw malformed(`export ${pyQuote(name)} is declared twice`);
        seen.add(name);
        exports.push({ name, kind: kindName, index: section.u32() });
      }
    } else if (sectionId === 8) {
      start = section.u32();
    } else if (sectionId === 9) {
      const count = section.u32();
      for (let index = 0; index < count; index += 1) {
        const where = `element segment ${index}`;
        const flags = section.u32();
        if (flags > 7) throw malformed(`${where}: unknown flags ${flags}`);
        if (flags === 2 || flags === 6) section.u32();
        if (flags === 0 || flags === 2 || flags === 4 || flags === 6) section.constExpr(where);
        if (flags === 1 || flags === 2 || flags === 3) {
          if (section.byte() !== 0x00) throw malformed(`${where}: unknown element kind`);
        }
        if (flags === 5 || flags === 6 || flags === 7) section.refType(where);
        const items = section.u32();
        for (let item = 0; item < items; item += 1) {
          if (flags < 4) section.u32();
          else section.constExpr(where);
        }
        elements += 1;
      }
    } else if (sectionId === 12) {
      dataCount = section.u32();
    } else if (sectionId === 10) {
      codeEntries = section.u32();
      if (codeEntries !== functions.length) throw malformed("code and function sections disagree");
      for (let index = 0; index < codeEntries; index += 1) {
        const where = `function ${index}`;
        const bodySize = section.u32();
        const body = new Reader(data, section.pos, section.pos + bodySize);
        if (body.end > section.end) throw malformed(`${where}: body exceeds the code section`);
        section.pos = body.end;
        let localsCount = 0;
        const groups = body.u32();
        for (let group = 0; group < groups; group += 1) {
          localsCount += body.u32();
          body.valueType(where);
          if (localsCount > MAX_LOCALS) throw malformed(`${where}: more than ${MAX_LOCALS} locals`);
        }
        body.instructions(types.length, where);
        if (body.pos !== body.end) throw malformed(`${where}: bytes after the function body`);
      }
    } else if (sectionId === 11) {
      const count = section.u32();
      for (let index = 0; index < count; index += 1) {
        const where = `data segment ${index}`;
        const flags = section.u32();
        if (flags === 2) {
          if (section.u32() !== 0) throw feature("multi-memory", where);
        }
        if (flags === 0 || flags === 2) section.constExpr(where);
        else if (flags !== 1) throw malformed(`${where}: unknown flags ${flags}`);
        section.take(section.u32());
        dataSegments += 1;
      }
    }
    if (section.pos !== section.end) throw malformed(`section ${sectionId} has trailing bytes`);
  }
  if (functions.length > 0 && codeEntries === null) throw malformed("function section without a code section");
  if (dataCount !== null && dataCount !== dataSegments) throw malformed("data count and data sections disagree");
  return { size: data.length, types, imports, functions, tables, memories, globals: globalsCount, exports, start, element_segments: elements, data_segments: dataSegments, custom_sections: custom };
}

/** Python's `repr` of an export name (ASCII names, which is what the ABI uses). */
function pyQuote(name: string): string {
  return name.includes("'") && !name.includes('"') ? `"${name}"` : `'${name.replace(/\\/gu, "\\\\").replace(/'/gu, "\\'")}'`;
}

const ALLOC: FuncType = { params: ["i32"], results: ["i32"] };
const RUN: FuncType = { params: ["i32", "i32"], results: ["i64"] };

/**
 * The tier-1 requirements over one module's bytes (C-11…C-18): a core module at most 4 MiB, no
 * imports, one memory with a declared maximum exported as `memory`, `alloc: (i32) -> (i32)`, and
 * each named function `(i32, i32) -> (i64)`. Other exports are allowed and never called; a start
 * function is allowed and runs at instantiation, inside the call's limits (toolchains emit one to
 * initialize their runtime). Returns the facts validation records.
 */
export function checkModule(data: Uint8Array, functions: readonly string[] = ["run"]): ModuleFacts {
  if (!(data instanceof Uint8Array)) throw malformed("module bytes expected");
  if (data.length > MAX_MODULE_BYTES) throw new ModuleError("module_too_large", `${data.length} bytes; a module is at most ${MAX_MODULE_BYTES}`);
  const info = readModule(data);
  if (info.imports.length > 0) {
    const first = info.imports[0]!;
    throw new ModuleError("module_import", `the module imports ${first.module}.${first.name} (${first.kind}); tier-1 modules import nothing`);
  }
  if (info.memories.length !== 1) throw new ModuleError("module_memory_count", `the module defines ${info.memories.length} memories; exactly one is required`);
  const [minimum, maximum] = info.memories[0]!;
  if (maximum === null) throw new ModuleError("module_memory_undeclared_maximum", "the module's memory declares no maximum; the maximum is its memory bound");
  const exports = new Map(info.exports.map((entry) => [entry.name, entry]));
  const required = (name: string, kind: string): Export => {
    const entry = exports.get(name);
    if (entry === undefined) throw new ModuleError("module_export_missing", `the module does not export ${pyQuote(name)}`);
    if (entry.kind !== kind) throw new ModuleError("module_export_kind", `export ${pyQuote(name)} is a ${entry.kind}, not a ${kind}`);
    return entry;
  };
  const signature = (name: string, expected: FuncType): void => {
    const entry = required(name, "function");
    if (entry.index >= info.functions.length) throw malformed(`export ${pyQuote(name)} names an undefined function`);
    const actual = info.types[info.functions[entry.index]!]!;
    if (!sameType(actual, expected)) throw new ModuleError("module_export_signature", `export ${pyQuote(name)} has the signature ${funcTypeText(actual)}; ${funcTypeText(expected)} is required`);
  };
  const memory = required("memory", "memory");
  if (memory.index !== 0) throw malformed("export 'memory' names an undefined memory");
  signature("alloc", ALLOC);
  const names = [...new Set(functions)];
  if (names.length === 0) throw new ModuleError("module_export_missing", "no function of the module is named by a node");
  for (const name of names) {
    if (name === "alloc") throw new ModuleError("module_export_signature", "'alloc' is the allocator, not a function a node calls");
    signature(name, RUN);
  }
  return { sha256: sha256HexSync(data), size: data.length, memory_min_pages: minimum, memory_max_pages: maximum, functions: names, exports: info.exports.map((entry) => entry.name) };
}
