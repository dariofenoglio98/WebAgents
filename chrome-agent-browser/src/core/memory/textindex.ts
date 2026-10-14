/**
 * The text index (§6.2, M-31, D-211): BM25 (k1 1.2, b 0.75) over four weighted fields, NFKC
 * lower-cased letter/digit tokens, no stemming, no stop list, no dependency; sealed values
 * removed before tokenization, so a query that equals a sealed value matches nothing. Derived
 * state (M-28): rebuilt from the records, never exported.
 */
import type { JsonValue } from "../json.js";
import { type MemoryRecord } from "./model.js";
import { sealedValuesOf } from "./validate.js";

export const BM25_K1 = 1.2;
export const BM25_B = 0.75;
export const FIELD_WEIGHTS = { title: 3, tags: 2, fields: 1.5, body: 1 } as const;
type Field = keyof typeof FIELD_WEIGHTS;
const FIELDS: readonly Field[] = ["title", "tags", "fields", "body"];

/** The maximal runs of Unicode letters and digits of the NFKC-lowercased text. */
export function tokenize(text: string): string[] {
  return text.normalize("NFKC").toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}

/** The string values of a JSON value, nested ones included; numbers as their canonical JSON text. */
function strings(value: JsonValue): string[] {
  if (typeof value === "string") return [value];
  if (typeof value === "number") return [JSON.stringify(value)];
  if (Array.isArray(value)) return value.flatMap(strings);
  if (typeof value === "object" && value !== null) return Object.values(value).flatMap(strings);
  return [];
}

function withoutSealed(text: string, sealed: readonly string[]): string {
  let out = text;
  for (const value of sealed) out = out.split(value).join(" ");
  return out;
}

interface Document {
  id: string;
  terms: Record<Field, Map<string, number>>;
  lengths: Record<Field, number>;
  /** The record's sealed values, folded: a query equal to one matches nothing (M-31). */
  sealed: string[];
}

export class TextIndex {
  private readonly documents = new Map<string, Document>();
  private readonly frequency: Record<Field, Map<string, number>> = { title: new Map(), tags: new Map(), fields: new Map(), body: new Map() };
  private readonly totalLength: Record<Field, number> = { title: 0, tags: 0, fields: 0, body: 0 };

  static build(records: Iterable<MemoryRecord>): TextIndex {
    const index = new TextIndex();
    for (const record of records) index.add(record);
    return index;
  }

  get size(): number {
    return this.documents.size;
  }

  add(record: MemoryRecord): void {
    if (record.scope === "agent") return; // never indexed (M-49)
    this.remove(record.id);
    const sealed = sealedValuesOf(record).map(([, value]) => value);
    const texts: Record<Field, string> = {
      title: withoutSealed(record.title, sealed),
      tags: (record.tags ?? []).join(" "),
      fields: strings(record.fields)
        .map((text) => withoutSealed(text, sealed))
        .join(" "),
      body: withoutSealed(record.body, sealed),
    };
    const document: Document = { id: record.id, terms: { title: new Map(), tags: new Map(), fields: new Map(), body: new Map() }, lengths: { title: 0, tags: 0, fields: 0, body: 0 }, sealed: sealed.map((value) => value.normalize("NFKC").toLowerCase().trim()) };
    for (const field of FIELDS) {
      const tokens = tokenize(texts[field]);
      document.lengths[field] = tokens.length;
      this.totalLength[field] += tokens.length;
      for (const token of tokens) document.terms[field].set(token, (document.terms[field].get(token) ?? 0) + 1);
      for (const token of document.terms[field].keys()) this.frequency[field].set(token, (this.frequency[field].get(token) ?? 0) + 1);
    }
    this.documents.set(record.id, document);
  }

  remove(id: string): void {
    const document = this.documents.get(id);
    if (!document) return;
    for (const field of FIELDS) {
      this.totalLength[field] -= document.lengths[field];
      for (const token of document.terms[field].keys()) {
        const count = (this.frequency[field].get(token) ?? 1) - 1;
        if (count <= 0) this.frequency[field].delete(token);
        else this.frequency[field].set(token, count);
      }
    }
    this.documents.delete(id);
  }

  /** The record ids matching `query`, by score descending then id, with their scores; empty for an empty query. */
  search(query: string, limit = 100): Array<{ id: string; score: number }> {
    const tokens = [...new Set(tokenize(query))];
    if (tokens.length === 0 || this.documents.size === 0) return [];
    const folded = query.normalize("NFKC").toLowerCase().trim();
    for (const document of this.documents.values()) if (document.sealed.includes(folded)) return [];
    const n = this.documents.size;
    const scores: Array<{ id: string; score: number }> = [];
    for (const document of this.documents.values()) {
      let score = 0;
      for (const field of FIELDS) {
        const average = this.totalLength[field] / n || 1;
        for (const token of tokens) {
          const tf = document.terms[field].get(token) ?? 0;
          if (tf === 0) continue;
          const df = this.frequency[field].get(token) ?? 0;
          const idf = Math.log(1 + (n - df + 0.5) / (df + 0.5));
          const norm = tf + BM25_K1 * (1 - BM25_B + (BM25_B * document.lengths[field]) / average);
          score += FIELD_WEIGHTS[field] * idf * ((tf * (BM25_K1 + 1)) / norm);
        }
      }
      if (score > 0) scores.push({ id: document.id, score });
    }
    return scores.sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)).slice(0, limit);
  }
}
