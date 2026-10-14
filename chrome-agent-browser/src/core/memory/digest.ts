/**
 * The record digest (§3, M-11): HMAC-SHA256 under the host's 32-byte memory key of the canonical
 * JSON of the content fields; timestamps, provenance, scope and demo never move it. A digest is an
 * equality-comparable reference that says nothing to a reader (D-051).
 */
import { canonicalJson } from "../canonical.js";
import { bufferSource, toHex } from "../hash.js";
import type { JsonObject } from "../json.js";
import { canonicalLinks, type MemoryRecord } from "./model.js";

export const DIGEST_SCHEMA = "memory-v0-record-digest";
export const KEY_BYTES = 32;

export function digestInput(record: MemoryRecord, typeSchemaSha256: string): JsonObject {
  return {
    schema: DIGEST_SCHEMA,
    id: record.id,
    type: record.type,
    type_schema_sha256: typeSchemaSha256,
    title: record.title,
    fields: record.fields,
    body: record.body,
    links: canonicalLinks(record.links ?? []).map((link) => ({ to: link.to, rel: link.rel })),
    tags: [...(record.tags ?? [])],
  };
}

/** The imported HMAC key, typed from the subtle API so the module compiles under both tsconfigs. */
type HmacKey = Awaited<ReturnType<typeof crypto.subtle.importKey>>;

export class MemoryDigester {
  private imported: Promise<HmacKey> | null = null;

  constructor(private readonly key: Uint8Array) {
    if (key.length !== KEY_BYTES) throw new TypeError(`the memory key must be ${KEY_BYTES} bytes`);
  }

  private hmacKey(): Promise<HmacKey> {
    this.imported ??= crypto.subtle.importKey("raw", bufferSource(this.key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    return this.imported;
  }

  async digest(record: MemoryRecord, typeSchemaSha256: string): Promise<string> {
    const signed = await crypto.subtle.sign({ name: "HMAC" }, await this.hmacKey(), bufferSource(canonicalJson(digestInput(record, typeSchemaSha256))));
    return toHex(new Uint8Array(signed));
  }
}

export function generateMemoryKey(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(KEY_BYTES));
}
