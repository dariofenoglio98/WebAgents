/**
 * memory.v0 (T19, `spec/memory-v0.md`, D-183, D-210…D-219): the record model and the small
 * helpers every memory module shares. Nothing here knows a package, a Chrome API or a store:
 * these are the constants and pure functions of §2 (the record), §5.1 (the relations) and §8.1
 * (file stems), ported rule for rule from `scripts/check_memory_spec.py`, the reference reader
 * and writer of the format, so that the two runtimes write identical bytes.
 */
import type { JsonObject, JsonValue } from "../json.js";

export const MEMORY_VERSION = "memory.v0";
/** §5.1, in vocabulary order: the order links are stored in (M-9). */
export const RELATIONS = ["about", "prefers", "pays_with", "belongs_to", "supersedes", "derived_from", "related"] as const;
export type Relation = (typeof RELATIONS)[number];
export const RELATION_WORDS: Readonly<Record<Relation, { forward: string; inverse: string }>> = Object.freeze({
  about: { forward: "about", inverse: "described by" },
  prefers: { forward: "prefers", inverse: "preferred by" },
  pays_with: { forward: "pays with", inverse: "used by" },
  belongs_to: { forward: "belongs to", inverse: "contains" },
  supersedes: { forward: "replaces", inverse: "replaced by" },
  derived_from: { forward: "derived from", inverse: "source of" },
  related: { forward: "related", inverse: "related" },
});
/** §2.4 (M-8): never a field name. */
export const RESERVED_KEYS: ReadonlySet<string> = new Set(["id", "type", "title", "scope", "created", "updated", "valid_until", "source", "sealed", "links", "tags", "demo", "body", "memory", "aliases", "cssclasses", ...RELATIONS]);
export const RESERVED_FAMILIES: readonly string[] = Object.freeze(["person.", "payment.", "agent.", "memory."]);
export const RESERVED_TYPES: ReadonlySet<string> = new Set(["person.self", "agent.memory"]);
export const SELF_ID = "self";
export const SELF_TYPE = "person.self";
export const AGENT_TYPE = "agent.memory";
export const NOTE_TYPE = "document.note";
export const SEALED_PLACEHOLDER = "sealed:omitted";
export const MIRROR_MARK = "<!-- memory.v0 links -->";
export const MISSING_RECORD_TEXT = "[[missing record]]";
/** M-4, D-051: a sealed value shorter than this would match ordinary text by accident. */
export const MIN_SEALED_LENGTH = 6;
// D-212 (every cap counts code points).
export const MAX_TITLE_CHARS = 200;
export const MAX_BODY_CHARS = 16_384;
export const MAX_AGENT_BODY_CHARS = 32_768;
export const MAX_FIELDS_CHARS = 16_384;
export const MAX_TAGS = 32;
export const MAX_LINKS = 64;
export const MAX_SEALED_POINTERS = 16;
export const MAX_IDENTITY_POINTERS = 8;
export const MAX_RECORDS = 8192;
export const MAX_TYPES = 128;
export const MAX_PROPOSALS = 8;
export const MAX_RATIONALE_CHARS = 500;
export const MAX_USAGE_ENTRIES = 65_536;
export const MAX_CUSTOM_TYPES_PER_PACKAGE = 8;
export const MAX_STEM_CHARS = 100;
/** M-55: stem, suffix and `.md` fit a 255-byte file name. */
export const MAX_STEM_BYTES = 200;

export const RECORD_ID = /^(self|mem_[0-9a-f]{32}|agent_[0-9a-f]{16})$/u;
export const WELL_KNOWN_TYPE_ID = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$/u;
export const TYPE_ID = /^([a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*|[A-Za-z][A-Za-z0-9_.:-]{0,127}:[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*)$/u;
export const TAG = /^[a-z0-9][a-z0-9_/-]{0,47}$/u;
export const POINTER = /^(\/[^/]+)+$/u;
export const TIMESTAMP = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,3})?Z$/u;
export const DATE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/u;
/** A wikilink: `[[target]]` or `[[target|alias]]`, neither part holding brackets. */
export const WIKILINK = /\[\[([^[\]|]+)(?:\|([^[\]]+))?\]\]/u;
/** A body wikilink with the backslashes right before it (M-3, M-57, M-59). */
export const BODY_LINK = /(\\*)\[\[([^[\]|]+)(?:\|([^[\]]+))?\]\]/gu;
/** The mirror marker as a whole line, with trailing whitespace ignored (T18 review 6, nit 5). */
export const MARKER_LINE = /(^|\n)<!-- memory\.v0 links -->[ \t]*(\r?\n|$)/u;

export type MemorySource =
  | { kind: "person" }
  | { kind: "package"; package_id: string; package_version: string; run_id: string; proposal: number; accepted: string }
  | { kind: "agent"; package_id: string; package_version: string; run_id: string }
  | { kind: "import"; from: string; imported: string }
  | { kind: "migration"; from_type: string; migrated: string };

export const SOURCE_KEYS: Readonly<Record<MemorySource["kind"], readonly string[]>> = Object.freeze({
  person: [],
  package: ["package_id", "package_version", "run_id", "proposal", "accepted"],
  agent: ["package_id", "package_version", "run_id"],
  import: ["from", "imported"],
  migration: ["from_type", "migrated"],
});

export interface MemoryLink {
  to: string;
  rel: Relation;
}

/** A record as parsed (`memory-record.schema.json`): the type's fields under `fields`, the body under `body`, sealed values in clear. */
export interface MemoryRecord {
  id: string;
  type: string;
  title: string;
  scope: "user" | "agent";
  created: string;
  updated: string;
  valid_until?: string;
  source: MemorySource;
  fields: JsonObject;
  sealed?: string[];
  links?: MemoryLink[];
  tags?: string[];
  demo?: boolean;
  body: string;
}

export type UsageUse = "read" | "proposed" | "accepted" | "agent_read" | "agent_write";
export const USAGE_USES: readonly UsageUse[] = Object.freeze(["read", "proposed", "accepted", "agent_read", "agent_write"]);

export interface UsageEntry {
  record_id: string;
  use: UsageUse;
  package_id: string;
  package_version: string;
  run_id: string;
  at: string;
}

export function isRecordId(value: unknown): value is string {
  return typeof value === "string" && RECORD_ID.test(value);
}

export function isRelation(value: unknown): value is Relation {
  return typeof value === "string" && (RELATIONS as readonly string[]).includes(value);
}

/** Python's code-point string order (`sorted` over `str`), which JavaScript's default sort is not for astral characters. */
export function compareCodePoints(a: string, b: string): number {
  const left = [...a];
  const right = [...b];
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const difference = left[index]!.codePointAt(0)! - right[index]!.codePointAt(0)!;
    if (difference !== 0) return difference;
  }
  return left.length - right.length;
}

export function sortedByCodePoint(values: Iterable<string>): string[] {
  return [...values].sort(compareCodePoints);
}

/** The number of Unicode code points, which every cap counts (D-212). */
export function codePoints(text: string): number {
  let count = 0;
  for (const _ of text) count += 1;
  return count;
}

export function utf8Bytes(text: string): number {
  return new TextEncoder().encode(text).length;
}

// -- JSON Pointers over the fields ------------------------------------------------------------
export function pointerParts(pointer: string): string[] {
  return pointer
    .split("/")
    .slice(1)
    .map((part) => part.replace(/~1/gu, "/").replace(/~0/gu, "~"));
}

export function pointerGet(value: JsonValue | undefined, pointer: string): JsonValue | undefined {
  let current: JsonValue | undefined = value;
  for (const part of pointerParts(pointer)) {
    if (typeof current !== "object" || current === null || Array.isArray(current) || !Object.hasOwn(current, part)) return undefined;
    current = current[part];
  }
  return current;
}

export function pointerSet(value: JsonObject, pointer: string, next: JsonValue): void {
  const parts = pointerParts(pointer);
  let current: JsonObject = value;
  for (const part of parts.slice(0, -1)) {
    const child = current[part];
    if (typeof child !== "object" || child === null || Array.isArray(child)) {
      const fresh: JsonObject = {};
      current[part] = fresh;
      current = fresh;
    } else current = child;
  }
  current[parts[parts.length - 1]!] = next;
}

export function pointerDelete(value: JsonObject, pointer: string): void {
  const parts = pointerParts(pointer);
  const parent = parts.length > 1 ? pointerGet(value, `/${parts.slice(0, -1).join("/")}`) : value;
  if (typeof parent === "object" && parent !== null && !Array.isArray(parent)) delete parent[parts[parts.length - 1]!];
}

/** The schema member a pointer names, following `properties` at every step, or null (M-24). */
export function schemaAt(schema: JsonValue | undefined, pointer: string): JsonObject | null {
  let current: JsonValue | undefined = schema;
  for (const part of pointerParts(pointer)) {
    const properties = typeof current === "object" && current !== null && !Array.isArray(current) ? current.properties : undefined;
    if (typeof properties !== "object" || properties === null || Array.isArray(properties) || !Object.hasOwn(properties, part)) return null;
    current = properties[part];
  }
  return typeof current === "object" && current !== null && !Array.isArray(current) ? current : null;
}

/** M-24: a sealed pointer names a `string` member the schema declares at every step; the member's schema, or null. */
export function sealedPointerSchema(schema: JsonObject, pointer: string): JsonObject | null {
  const target = schemaAt(schema, pointer);
  return target !== null && target.type === "string" ? target : null;
}

// -- canonical order (M-9) -------------------------------------------------------------------
const isObject = (value: unknown): value is JsonObject => typeof value === "object" && value !== null && !Array.isArray(value);

/** Declared order first (the schema's `properties`), then the rest by code point, recursively (M-9). */
export function orderFields(fields: JsonObject, schema: JsonValue | undefined): JsonObject {
  const properties = isObject(schema) && isObject(schema.properties) ? schema.properties : {};
  const declared = Object.keys(properties);
  const rest = sortedByCodePoint(Object.keys(fields).filter((key) => !declared.includes(key)));
  const ordered: JsonObject = {};
  for (const key of [...declared, ...rest]) {
    if (!Object.hasOwn(fields, key)) continue;
    let value = fields[key]!;
    const child = isObject(properties[key]) ? properties[key] : {};
    if (isObject(value)) value = orderFields(value, child);
    else if (Array.isArray(value)) {
      const items = isObject(child) ? child.items : undefined;
      value = value.map((item) => (isObject(item) ? orderFields(item, items) : item));
    }
    ordered[key] = value;
  }
  return ordered;
}

export function orderSource(source: JsonObject): JsonObject {
  const kind = String(source.kind) as MemorySource["kind"];
  const ordered: JsonObject = { kind: source.kind! };
  for (const key of SOURCE_KEYS[kind] ?? []) if (Object.hasOwn(source, key)) ordered[key] = source[key]!;
  for (const key of sortedByCodePoint(Object.keys(source))) if (!Object.hasOwn(ordered, key)) ordered[key] = source[key]!;
  return ordered;
}

/** M-9: links sorted by relation in vocabulary order, then by target by code point; duplicates dropped. */
export function canonicalLinks(links: readonly MemoryLink[]): MemoryLink[] {
  const unique = new Map<string, MemoryLink>();
  for (const link of links) unique.set(`${link.rel}\u0000${link.to}`, { to: link.to, rel: link.rel });
  return [...unique.values()].sort((a, b) => RELATIONS.indexOf(a.rel) - RELATIONS.indexOf(b.rel) || compareCodePoints(a.to, b.to));
}

// -- titles, aliases and stems (M-3, M-55) ----------------------------------------------------
/** M-3: a title cached as a wikilink alias, with `[`, `]` and `|` replaced by `-`. */
export function aliasOf(title: string): string {
  return title.replace(/[[\]|]/gu, "-");
}

/** Python's `str.casefold()` over NFC text, as closely as JavaScript allows (`ß` → `ss`): how stems and titles are compared (M-55). */
export function stemKey(text: string): string {
  return text.normalize("NFC").toUpperCase().toLowerCase();
}

/** Title key → record id for the titles exactly one record carries. */
export function titleIndex(titles: ReadonlyMap<string, string>): Map<string, string> {
  const groups = new Map<string, string[]>();
  for (const [id, title] of titles) {
    const key = stemKey(title);
    groups.set(key, [...(groups.get(key) ?? []), id]);
  }
  const out = new Map<string, string>();
  for (const [key, ids] of groups) if (ids.length === 1) out.set(key, ids[0]!);
  return out;
}

/** M-55: the file stem of a title. */
export function stemOf(title: string): string {
  let text = title.normalize("NFC").replace(/[\\/:*?"<>|[\]#^\u0000-\u001f\u007f]/gu, "-").replace(/\s+/gu, " ");
  text = [...text].slice(0, MAX_STEM_CHARS).join("");
  while (utf8Bytes(text) > MAX_STEM_BYTES) text = [...text].slice(0, -1).join("");
  const trimmed = text.replace(/^[ .]+/u, "").replace(/[ .]+$/u, "");
  return trimmed || "untitled";
}

/** M-55: the first 8 characters of the id after its prefix, or the whole id after the prefix (`self` for the hub). */
export function stemSuffix(recordId: string, full = false): string {
  const rest = recordId.includes("_") ? recordId.slice(recordId.indexOf("_") + 1) : recordId;
  return full ? rest : rest.slice(0, 8);
}

/** M-55: the names a record may take, in order; the bare stem never when it is a well-formed record id. */
export function* stemNames(recordId: string, stem: string): Generator<string> {
  if (!RECORD_ID.test(stem)) yield stem;
  yield `${stem} (${stemSuffix(recordId)})`;
  const full = `${stem} (${stemSuffix(recordId, true)})`;
  yield full;
  for (let counter = 2; ; counter += 1) yield `${full} (${counter})`;
}

export function supersededIds(records: ReadonlyArray<Pick<MemoryRecord, "links">>): Set<string> {
  const out = new Set<string>();
  for (const record of records) for (const link of record.links ?? []) if (link.rel === "supersedes") out.add(link.to);
  return out;
}

/** M-55: record id → file name without `.md`, by one walk, heads first then by id, case-insensitively unique. */
export function stemsFor(records: ReadonlyArray<Pick<MemoryRecord, "id" | "title" | "links">>): Map<string, string> {
  const superseded = supersededIds(records);
  const taken = new Set<string>();
  const result = new Map<string, string>();
  const ordered = [...records].sort((a, b) => Number(superseded.has(a.id)) - Number(superseded.has(b.id)) || compareCodePoints(a.id, b.id));
  for (const record of ordered) {
    for (const name of stemNames(record.id, stemOf(record.title))) {
      const key = stemKey(name);
      if (taken.has(key)) continue;
      taken.add(key);
      result.set(record.id, name);
      break;
    }
  }
  return result;
}

/** A frontmatter timestamp as an instant (milliseconds), compared as time, never as text. */
export function instant(timestamp: string): number {
  return Date.parse(timestamp);
}

/** `YYYY-MM-DDTHH:MM:SSZ`, the writer's form (no fractional seconds). */
export function stamp(date: Date): string {
  return `${date.toISOString().slice(0, 19)}Z`;
}

export function dateOf(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** M-3: NFC, LF, no trailing whitespace at the end. */
export function normalizeBody(body: string): string {
  return body.replace(/\r\n/gu, "\n").normalize("NFC").replace(/[\s﻿\xA0]+$/u, "");
}

/** The display name of a relation for a person, forward or inverse (D-218). */
export function relationWords(rel: Relation, inverse = false): string {
  return inverse ? RELATION_WORDS[rel].inverse : RELATION_WORDS[rel].forward;
}

/** Whether `text` holds `needle` case-insensitively (M-4, M-36: the sealed-value test). */
export function containsFolded(text: string, needle: string): boolean {
  return text.toLowerCase().includes(needle.toLowerCase());
}

export type { JsonObject, JsonValue };
