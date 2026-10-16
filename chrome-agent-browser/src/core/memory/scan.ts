/**
 * The scan set (M-36, M-37, M-40): the sealed values, by record id and pointer, of every record
 * of the store when a run is opened with the store, and empty otherwise; in fixture mode without
 * a store, the values at the sealed pointers of the replayed answers (M-62). `findSealed` is the
 * one scanner the tool egress guard, the model-request scan and the proposals check share.
 */
import type { JsonValue } from "../json.js";
import { MAX_SCANNED_STRINGS, scanStrings, type SealedValues } from "../tools/egress.js";
import { type MemoryRecord, SEALED_PLACEHOLDER, pointerGet } from "./model.js";
import { sealedValuesOf } from "./validate.js";

export interface ScanEntry {
  record_id: string;
  pointer: string;
  value: string;
}

export type ScanSet = readonly ScanEntry[];

export function scanSetOf(records: Iterable<Pick<MemoryRecord, "id" | "fields" | "sealed">>): ScanEntry[] {
  const out: ScanEntry[] = [];
  for (const record of records) for (const [pointer, value] of sealedValuesOf(record)) out.push({ record_id: record.id, pointer, value });
  return out.sort((a, b) => (a.record_id < b.record_id ? -1 : a.record_id > b.record_id ? 1 : a.pointer < b.pointer ? -1 : a.pointer > b.pointer ? 1 : 0));
}

/** The scan set as the egress guard reads it (`Map<record id, values>`). */
export function toSealedValues(scan: ScanSet): SealedValues {
  const map = new Map<string, string[]>();
  for (const entry of scan) map.set(entry.record_id, [...(map.get(entry.record_id) ?? []), entry.value]);
  return map;
}

export interface ScanHit {
  record_id: string;
  pointer: string;
}

/**
 * The first sealed value found anywhere in `value` (keys included, case-insensitive, no depth
 * cut-off), or null; `incomplete` when the document holds more strings than the scanner reads,
 * which a caller refuses unread.
 */
export function findSealed(value: JsonValue, scan: ScanSet): ScanHit | null | "incomplete" {
  const hits = findAllSealed(value, scan);
  if (hits === "incomplete") return "incomplete";
  return hits[0] ?? null;
}

/**
 * Every sealed value found anywhere in `value`, in scan-set order; `incomplete` as `findSealed`.
 * The tool scan needs them all: a value granted to the tool must not hide another (M-36, D-234).
 */
export function findAllSealed(value: JsonValue, scan: ScanSet): ScanHit[] | "incomplete" {
  if (scan.length === 0) return [];
  const strings = scanStrings(value, MAX_SCANNED_STRINGS);
  if (strings === null) return "incomplete";
  const hits: ScanHit[] = [];
  for (const entry of scan) {
    const needle = entry.value.toLowerCase();
    if (strings.some((text) => text.includes(needle))) hits.push({ record_id: entry.record_id, pointer: entry.pointer });
  }
  return hits;
}

/**
 * M-62: the scan set of a fixture run without a store: the values at the `sealed` pointers of
 * every replayed memory-read answer (the view carries them), and at the legacy type's sealed
 * pointers of every replayed host-resource answer.
 */
export function fixtureScanSet(answers: ReadonlyArray<{ binding: string; output: JsonValue; legacySealed?: readonly string[] }>): ScanEntry[] {
  const out: ScanEntry[] = [];
  for (const answer of answers) {
    const output = answer.output;
    if (typeof output !== "object" || output === null || Array.isArray(output)) continue;
    if (answer.binding.startsWith("host.memory.") && !answer.binding.startsWith("host.memory.agent.")) {
      const sealed = Array.isArray(output.sealed) ? output.sealed.filter((item): item is string => typeof item === "string") : [];
      const id = typeof output.id === "string" ? output.id : "fixture";
      for (const pointer of sealed) {
        const value = pointerGet(output.fields ?? null, pointer);
        if (typeof value === "string" && value !== SEALED_PLACEHOLDER) out.push({ record_id: id, pointer, value });
      }
    } else if (answer.binding.startsWith("host.resource.")) {
      for (const pointer of answer.legacySealed ?? []) {
        const value = pointerGet(output, pointer);
        if (typeof value === "string") out.push({ record_id: `fixture:${answer.binding}`, pointer, value });
      }
    }
  }
  return out;
}
