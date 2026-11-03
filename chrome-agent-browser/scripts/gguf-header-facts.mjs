#!/usr/bin/env node
/**
 * The GGUF header facts the GPU-memory estimate needs (D-441, T40 review 1 finding 1), read from
 * model files on disk: `<arch>.block_count`, `.attention.head_count`, `.attention.head_count_kv`,
 * `.attention.key_length`, `.attention.value_length`, `.embedding_length`, `.context_length`. It
 * also records `embedding_length / head_count`, the fallback head width, to show where it is wrong.
 * A reference for T41's header reader in the shell (the same key-value walk over the file's first
 * bytes); no dependency, nothing but the header is read.
 *
 *   node chrome-agent-browser/scripts/gguf-header-facts.mjs [--out report.json] file.gguf ...
 *
 * Default files: the spike's cache (`examples/my-inbrowser-spike-cache/`, git-ignored).
 */
import { closeSync, openSync, readdirSync, readSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CACHE = join(ROOT, "examples", "my-inbrowser-spike-cache");

/** A reader over a file that pulls 1 MiB windows as the walk needs them. */
class Reader {
  constructor(path) {
    this.fd = openSync(path, "r");
    this.size = statSync(path).size;
    this.offset = 0;
    this.buffer = Buffer.alloc(0);
    this.base = 0;
  }
  need(bytes) {
    const end = this.offset + bytes;
    if (end > this.size) throw new Error(`GGUF header runs past the end of the file at ${this.offset}`);
    if (this.offset >= this.base && end <= this.base + this.buffer.length) return;
    const length = Math.max(bytes, 1 << 20);
    this.buffer = Buffer.alloc(Math.min(length, this.size - this.offset));
    readSync(this.fd, this.buffer, 0, this.buffer.length, this.offset);
    this.base = this.offset;
  }
  take(bytes, read) {
    this.need(bytes);
    const value = read(this.buffer, this.offset - this.base);
    this.offset += bytes;
    return value;
  }
  u32() { return this.take(4, (b, at) => b.readUInt32LE(at)); }
  u64() { return Number(this.take(8, (b, at) => b.readBigUInt64LE(at))); }
  string() {
    const length = this.u64();
    if (length > 1 << 24) throw new Error(`GGUF string of ${length} bytes`);
    return this.take(length, (b, at) => b.toString("utf8", at, at + length));
  }
  close() { closeSync(this.fd); }
}

const SCALAR = {
  0: [1, (b, at) => b.readUInt8(at)],
  1: [1, (b, at) => b.readInt8(at)],
  2: [2, (b, at) => b.readUInt16LE(at)],
  3: [2, (b, at) => b.readInt16LE(at)],
  4: [4, (b, at) => b.readUInt32LE(at)],
  5: [4, (b, at) => b.readInt32LE(at)],
  6: [4, (b, at) => b.readFloatLE(at)],
  7: [1, (b, at) => b.readUInt8(at) !== 0],
  10: [8, (b, at) => Number(b.readBigUInt64LE(at))],
  11: [8, (b, at) => Number(b.readBigInt64LE(at))],
  12: [8, (b, at) => b.readDoubleLE(at)],
};

function value(reader, type) {
  if (type === 8) return reader.string();
  if (type === 9) {
    const itemType = reader.u32();
    const count = reader.u64();
    // Arrays are walked, kept only when short (per-layer head counts); tokenizer tables are skipped.
    const items = [];
    for (let index = 0; index < count; index += 1) {
      const item = value(reader, itemType);
      if (count <= 512) items.push(item);
    }
    return count <= 512 ? items : { array_of: count };
  }
  const scalar = SCALAR[type];
  if (!scalar) throw new Error(`GGUF value type ${type} is unknown`);
  return reader.take(scalar[0], scalar[1]);
}

export function ggufMetadata(path) {
  const reader = new Reader(path);
  try {
    const magic = reader.take(4, (b, at) => b.toString("latin1", at, at + 4));
    if (magic !== "GGUF") throw new Error(`${basename(path)} is not a GGUF file`);
    const version = reader.u32();
    const tensors = reader.u64();
    const count = reader.u64();
    const metadata = {};
    for (let index = 0; index < count; index += 1) {
      const key = reader.string();
      metadata[key] = value(reader, reader.u32());
    }
    return { version, tensors, kv_count: count, header_bytes: reader.offset, metadata };
  } finally {
    reader.close();
  }
}

/** The estimate's inputs; a per-layer array counts at its largest (the safe side). */
export function headerFacts(metadata) {
  const arch = metadata["general.architecture"];
  const key = (name) => metadata[`${arch}.${name}`];
  const widest = (raw) => (Array.isArray(raw) ? Math.max(...raw) : raw ?? null);
  const headCount = widest(key("attention.head_count"));
  const embedding = key("embedding_length") ?? null;
  const fallback = embedding !== null && headCount ? embedding / headCount : null;
  const keyLength = key("attention.key_length") ?? null;
  const valueLength = key("attention.value_length") ?? null;
  return {
    architecture: arch,
    n_layer: key("block_count") ?? null,
    head_count: headCount,
    n_kv_heads: widest(key("attention.head_count_kv")) ?? headCount,
    key_length: keyLength ?? fallback,
    value_length: valueLength ?? fallback,
    key_length_basis: keyLength !== null ? "attention.key_length" : "embedding_length / head_count",
    embedding_length: embedding,
    embedding_over_head_count: fallback,
    context_length: key("context_length") ?? null,
    sliding_window: key("attention.sliding_window") ?? null,
  };
}

function main() {
  let out = join(ROOT, "examples", "verification", "chrome-inbrowser-gguf-headers-t40.json");
  const files = [];
  for (let index = 2; index < process.argv.length; index += 1) {
    if (process.argv[index] === "--out") out = resolve(process.argv[(index += 1)]);
    else files.push(resolve(process.argv[index]));
  }
  if (files.length === 0) for (const name of readdirSync(CACHE).sort()) if (name.endsWith(".gguf")) files.push(join(CACHE, name));
  const report = { profile: "chrome-inbrowser-gguf-headers-v0", recordedAt: new Date().toISOString(), script: "chrome-agent-browser/scripts/gguf-header-facts.mjs", files: [], passed: false };
  for (const path of files) {
    const parsed = ggufMetadata(path);
    const name = basename(path).split("__").pop();
    report.files.push({ file: name, bytes: statSync(path).size, gguf_version: parsed.version, tensors: parsed.tensors, kv_count: parsed.kv_count, header_bytes: parsed.header_bytes, general_name: parsed.metadata["general.name"] ?? null, facts: headerFacts(parsed.metadata) });
  }
  report.passed = report.files.length > 0 && report.files.every((item) => [item.facts.n_layer, item.facts.n_kv_heads, item.facts.key_length, item.facts.value_length].every((n) => Number.isInteger(n) && n > 0));
  writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ passed: report.passed, out, files: report.files.map((item) => ({ file: item.file, ...item.facts })) }));
  process.exit(report.passed ? 0 : 1);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
