/**
 * The GGUF header facts the GPU-memory estimate needs (D-441), read from a model file's first
 * bytes: the key-value section of GGUF version 2 or 3, walked exactly as T40's reference
 * (`scripts/gguf-header-facts.mjs`) walks it, over a reader the caller supplies (a cached OPFS
 * file's `slice` in the extension, a `Range` request in `make-model-catalog.mjs`, bytes in a
 * test). Nothing here touches a file, the network or the GPU, and nothing past the header is
 * read: the tensors are data the engine reads, never this module.
 *
 * The facts (design §3): `<arch>.block_count`, `<arch>.attention.head_count_kv` (a per-layer array
 * counts at its largest; absent means `head_count`, no grouped-query attention),
 * `<arch>.attention.key_length` and `value_length` (the per-head K and V widths), and
 * `<arch>.context_length`. Only when a header lacks the two lengths does the width fall back to
 * `embedding_length / head_count`, which is wrong for Qwen3 (64 or 80 against a real 128,
 * `examples/verification/chrome-inbrowser-gguf-headers-t40.json`), so the fallback is marked.
 */

/** Read `length` bytes at `offset`; may return fewer only at the end of the file. */
export type GgufRead = (offset: number, length: number) => Promise<Uint8Array>;

export interface GgufHeaderFacts {
  architecture: string;
  gguf_version: number;
  tensors: number;
  kv_count: number;
  /** Where the key-value section ends (the tensor infos follow). */
  header_bytes: number;
  general_name: string | null;
  n_layer: number;
  head_count: number | null;
  n_kv_heads: number;
  key_length: number;
  value_length: number;
  /** `attention.key_length` when the header states both widths, else the marked fallback. */
  key_length_basis: "attention.key_length" | "embedding_length / head_count";
  embedding_length: number | null;
  context_length: number | null;
  sliding_window: number | null;
}

export class GgufHeaderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GgufHeaderError";
  }
}

/** The largest header this reader walks (a tokenizer of 256k tokens is about 6 MB; T40 measured 5.9 MB). */
export const MAX_HEADER_BYTES = 64 * 1024 * 1024;
const WINDOW = 1024 * 1024;
const MAX_STRING = 1 << 24;
const MAX_KV = 1 << 16;
/** Arrays at most this long are kept (per-layer head counts); longer ones (tokenizer tables) are walked and dropped. */
const KEEP_ARRAY = 512;

class Reader {
  private buffer: Uint8Array = new Uint8Array(0);
  private base = 0;
  offset = 0;

  constructor(
    private readonly read: GgufRead,
    private readonly size: number | null,
  ) {}

  private async need(bytes: number): Promise<DataView> {
    const end = this.offset + bytes;
    if (end > MAX_HEADER_BYTES) throw new GgufHeaderError(`the GGUF header runs past ${MAX_HEADER_BYTES} bytes`);
    if (this.size !== null && end > this.size) throw new GgufHeaderError(`the GGUF header runs past the end of the file at ${this.offset}`);
    if (!(this.offset >= this.base && end <= this.base + this.buffer.length)) {
      const length = Math.max(bytes, WINDOW);
      const chunk = await this.read(this.offset, length);
      if (chunk.length < bytes) throw new GgufHeaderError(`the GGUF header runs past the end of the file at ${this.offset}`);
      this.buffer = chunk;
      this.base = this.offset;
    }
    return new DataView(this.buffer.buffer, this.buffer.byteOffset + (this.offset - this.base), bytes);
  }

  async take<T>(bytes: number, decode: (view: DataView) => T): Promise<T> {
    const view = await this.need(bytes);
    this.offset += bytes;
    return decode(view);
  }

  u32(): Promise<number> {
    return this.take(4, (view) => view.getUint32(0, true));
  }

  async u64(): Promise<number> {
    const value = await this.take(8, (view) => view.getBigUint64(0, true));
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new GgufHeaderError("a GGUF count exceeds 2^53");
    return Number(value);
  }

  async string(): Promise<string> {
    const length = await this.u64();
    if (length > MAX_STRING) throw new GgufHeaderError(`a GGUF string of ${length} bytes`);
    return this.take(length, (view) => new TextDecoder("utf-8").decode(new Uint8Array(view.buffer, view.byteOffset, length)));
  }

  /** Skip `bytes` without decoding them (fixed-size array items); reads only when the window runs out. */
  async skip(bytes: number): Promise<void> {
    let left = bytes;
    while (left > 0) {
      const inWindow = Math.max(0, this.base + this.buffer.length - this.offset);
      if (inWindow === 0) {
        await this.need(Math.min(left, WINDOW));
        continue;
      }
      const step = Math.min(left, inWindow);
      if (this.offset + step > MAX_HEADER_BYTES) throw new GgufHeaderError(`the GGUF header runs past ${MAX_HEADER_BYTES} bytes`);
      this.offset += step;
      left -= step;
    }
  }
}

type Scalar = number | boolean | string;
type Value = Scalar | Scalar[] | { array_of: number };

const SIZES: Readonly<Record<number, number>> = { 0: 1, 1: 1, 2: 2, 3: 2, 4: 4, 5: 4, 6: 4, 7: 1, 10: 8, 11: 8, 12: 8 };

function scalar(type: number, view: DataView): Scalar {
  switch (type) {
    case 0:
      return view.getUint8(0);
    case 1:
      return view.getInt8(0);
    case 2:
      return view.getUint16(0, true);
    case 3:
      return view.getInt16(0, true);
    case 4:
      return view.getUint32(0, true);
    case 5:
      return view.getInt32(0, true);
    case 6:
      return view.getFloat32(0, true);
    case 7:
      return view.getUint8(0) !== 0;
    case 10:
      return Number(view.getBigUint64(0, true));
    case 11:
      return Number(view.getBigInt64(0, true));
    default:
      return view.getFloat64(0, true);
  }
}

async function value(reader: Reader, type: number, depth = 0): Promise<Value> {
  if (type === 8) return reader.string();
  if (type === 9) {
    if (depth > 0) throw new GgufHeaderError("a nested GGUF array");
    const itemType = await reader.u32();
    const count = await reader.u64();
    const keep = count <= KEEP_ARRAY;
    if (!keep && itemType !== 8) {
      const size = SIZES[itemType];
      if (size === undefined) throw new GgufHeaderError(`GGUF value type ${itemType} is unknown`);
      await reader.skip(size * count);
      return { array_of: count };
    }
    const items: Scalar[] = [];
    for (let index = 0; index < count; index += 1) {
      const item = await value(reader, itemType, depth + 1);
      if (keep) items.push(item as Scalar);
    }
    return keep ? items : { array_of: count };
  }
  const size = SIZES[type];
  if (size === undefined) throw new GgufHeaderError(`GGUF value type ${type} is unknown`);
  return reader.take(size, (view) => scalar(type, view));
}

function count(raw: Value | undefined): number | null {
  const widest = Array.isArray(raw) ? (raw.every((item) => typeof item === "number") && raw.length > 0 ? Math.max(...(raw as number[])) : null) : raw;
  return typeof widest === "number" && Number.isSafeInteger(widest) && widest > 0 ? widest : null;
}

/**
 * Walk the header and return the facts; refuses (`GgufHeaderError`) a file that is not GGUF,
 * names no architecture, or lacks the layer count, the head counts or every way to the head width.
 * `size` is the file's length when known (a walk never reads past it).
 */
export async function readGgufHeader(read: GgufRead, size: number | null = null): Promise<GgufHeaderFacts> {
  const reader = new Reader(read, size);
  const magic = await reader.take(4, (view) => String.fromCharCode(view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3)));
  if (magic !== "GGUF") throw new GgufHeaderError("not a GGUF file");
  const version = await reader.u32();
  if (version !== 2 && version !== 3) throw new GgufHeaderError(`GGUF version ${version} is not read here (2 and 3 are)`);
  const tensors = await reader.u64();
  const kvCount = await reader.u64();
  if (kvCount > MAX_KV) throw new GgufHeaderError(`a GGUF header with ${kvCount} keys`);
  const metadata = new Map<string, Value>();
  for (let index = 0; index < kvCount; index += 1) {
    const key = await reader.string();
    metadata.set(key, await value(reader, await reader.u32()));
  }
  const architecture = metadata.get("general.architecture");
  if (typeof architecture !== "string" || architecture.length === 0) throw new GgufHeaderError("the GGUF header names no general.architecture");
  const key = (name: string): Value | undefined => metadata.get(`${architecture}.${name}`);
  const nLayer = count(key("block_count"));
  const headCount = count(key("attention.head_count"));
  const kvHeads = count(key("attention.head_count_kv")) ?? headCount;
  const embedding = count(key("embedding_length"));
  const keyLength = count(key("attention.key_length"));
  const valueLength = count(key("attention.value_length"));
  const fallback = embedding !== null && headCount !== null && embedding % headCount === 0 ? embedding / headCount : null;
  const stated = keyLength !== null && valueLength !== null;
  const widthK = stated ? keyLength : (keyLength ?? fallback);
  const widthV = stated ? valueLength : (valueLength ?? fallback);
  if (nLayer === null) throw new GgufHeaderError(`the GGUF header states no ${architecture}.block_count`);
  if (kvHeads === null) throw new GgufHeaderError(`the GGUF header states no ${architecture}.attention.head_count_kv or head_count`);
  if (widthK === null || widthV === null) throw new GgufHeaderError(`the GGUF header states neither ${architecture}.attention.key_length and value_length nor embedding_length and head_count`);
  const name = metadata.get("general.name");
  return {
    architecture,
    gguf_version: version,
    tensors,
    kv_count: kvCount,
    header_bytes: reader.offset,
    general_name: typeof name === "string" ? name : null,
    n_layer: nLayer,
    head_count: headCount,
    n_kv_heads: kvHeads,
    key_length: widthK,
    value_length: widthV,
    key_length_basis: stated ? "attention.key_length" : "embedding_length / head_count",
    embedding_length: embedding,
    context_length: count(key("context_length")),
    sliding_window: count(key("attention.sliding_window")),
  };
}

/** A reader over bytes in memory (tests, a prefix already fetched). */
export function bytesReader(bytes: Uint8Array): GgufRead {
  return async (offset, length) => bytes.subarray(offset, Math.min(bytes.length, offset + length));
}
