/**
 * Synthetic GGUF headers for the header reader's tests (T41): the key-value section of GGUF 3,
 * built from facts the test states (the spike's header facts, read from
 * `examples/verification/chrome-inbrowser-gguf-headers-t40.json`), with a long string array and a
 * long numeric array standing in for the tokenizer tables a real header carries, so the reader's
 * skipping is exercised. No real model file is needed.
 */
export type GgufValue = { type: "u32"; value: number } | { type: "u64"; value: number } | { type: "f32"; value: number } | { type: "string"; value: string } | { type: "bool"; value: boolean } | { type: "u32[]"; value: number[] } | { type: "string[]"; value: string[] } | { type: "i32[]"; value: number[] };

class Writer {
  private chunks: Uint8Array[] = [];
  private bytes(data: Uint8Array): void {
    this.chunks.push(data);
  }
  u8(value: number): void {
    this.bytes(new Uint8Array([value]));
  }
  u32(value: number): void {
    const view = new DataView(new ArrayBuffer(4));
    view.setUint32(0, value, true);
    this.bytes(new Uint8Array(view.buffer));
  }
  i32(value: number): void {
    const view = new DataView(new ArrayBuffer(4));
    view.setInt32(0, value, true);
    this.bytes(new Uint8Array(view.buffer));
  }
  u64(value: number): void {
    const view = new DataView(new ArrayBuffer(8));
    view.setBigUint64(0, BigInt(value), true);
    this.bytes(new Uint8Array(view.buffer));
  }
  f32(value: number): void {
    const view = new DataView(new ArrayBuffer(4));
    view.setFloat32(0, value, true);
    this.bytes(new Uint8Array(view.buffer));
  }
  string(value: string): void {
    const data = new TextEncoder().encode(value);
    this.u64(data.length);
    this.bytes(data);
  }
  raw(data: Uint8Array): void {
    this.bytes(data);
  }
  done(): Uint8Array {
    const total = this.chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    const out = new Uint8Array(total);
    let at = 0;
    for (const chunk of this.chunks) {
      out.set(chunk, at);
      at += chunk.length;
    }
    return out;
  }
}

/** A GGUF file's first bytes: magic, version, tensor count, the key-value section, then `tail` bytes of "tensor data". */
export function ggufBytes(entries: Array<[string, GgufValue]>, options: { version?: number; tensors?: number; tail?: number } = {}): Uint8Array {
  const writer = new Writer();
  writer.raw(new TextEncoder().encode("GGUF"));
  writer.u32(options.version ?? 3);
  writer.u64(options.tensors ?? 3);
  writer.u64(entries.length);
  for (const [key, value] of entries) {
    writer.string(key);
    switch (value.type) {
      case "u32":
        writer.u32(4);
        writer.u32(value.value);
        break;
      case "u64":
        writer.u32(10);
        writer.u64(value.value);
        break;
      case "f32":
        writer.u32(6);
        writer.f32(value.value);
        break;
      case "bool":
        writer.u32(7);
        writer.u8(value.value ? 1 : 0);
        break;
      case "string":
        writer.u32(8);
        writer.string(value.value);
        break;
      case "u32[]":
        writer.u32(9);
        writer.u32(4);
        writer.u64(value.value.length);
        for (const item of value.value) writer.u32(item);
        break;
      case "i32[]":
        writer.u32(9);
        writer.u32(5);
        writer.u64(value.value.length);
        for (const item of value.value) writer.i32(item);
        break;
      case "string[]":
        writer.u32(9);
        writer.u32(8);
        writer.u64(value.value.length);
        for (const item of value.value) writer.string(item);
        break;
    }
  }
  writer.raw(new Uint8Array(options.tail ?? 64));
  return writer.done();
}

/** The header of a Qwen3-like file with the stated facts and a tokenizer of `vocab` tokens. */
export function qwen3Header(facts: { n_layer: number; head_count: number; n_kv_heads: number; key_length: number | null; value_length: number | null; embedding_length: number; context_length: number; name?: string }, vocab = 20_000): Uint8Array {
  const entries: Array<[string, GgufValue]> = [
    ["general.architecture", { type: "string", value: "qwen3" }],
    ["general.name", { type: "string", value: facts.name ?? "Qwen3 test" }],
    ["qwen3.block_count", { type: "u32", value: facts.n_layer }],
    ["qwen3.context_length", { type: "u32", value: facts.context_length }],
    ["qwen3.embedding_length", { type: "u32", value: facts.embedding_length }],
    ["qwen3.attention.head_count", { type: "u32", value: facts.head_count }],
    ["qwen3.attention.head_count_kv", { type: "u32", value: facts.n_kv_heads }],
    ["qwen3.rope.freq_base", { type: "f32", value: 1_000_000 }],
    ["tokenizer.ggml.tokens", { type: "string[]", value: Array.from({ length: vocab }, (_, index) => `tok${index}`) }],
    ["tokenizer.ggml.token_type", { type: "i32[]", value: Array.from({ length: vocab }, () => 1) }],
    ["tokenizer.ggml.add_bos_token", { type: "bool", value: false }],
  ];
  if (facts.key_length !== null) entries.push(["qwen3.attention.key_length", { type: "u32", value: facts.key_length }]);
  if (facts.value_length !== null) entries.push(["qwen3.attention.value_length", { type: "u32", value: facts.value_length }]);
  return ggufBytes(entries);
}
