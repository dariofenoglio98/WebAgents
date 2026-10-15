/**
 * Integrity (§5.4, M-24) and the caps (D-212): what every write checks with the store unlocked.
 * A refusal carries the spec's code (`sealed_value_in_text`, `sealed_field_invalid`,
 * `body_reserved_marker`, `memory_record_too_large`, `supersedes_cycle`, `superseded_twice`,
 * `frontmatter_invalid`, `schema_validation`); nothing here writes anything.
 */
import { canonicalString } from "../canonical.js";
import { CoreError } from "../errors.js";
import type { JsonObject, JsonValue } from "../json.js";
import { failuresForSchema, memorySchemaFailure } from "../schema.js";
import {
  canonicalLinks,
  codePoints,
  containsFolded,
  isRecordId,
  MARKER_LINE,
  MAX_AGENT_BODY_CHARS,
  MAX_BODY_CHARS,
  MAX_FIELDS_CHARS,
  MAX_LINKS,
  MAX_SEALED_POINTERS,
  MAX_TAGS,
  type MemoryRecord,
  MIN_SEALED_LENGTH,
  pointerGet,
  SELF_ID,
  sealedPointerSchema,
} from "./model.js";
import type { MemoryTypeView } from "./types.js";

export class MemoryError extends CoreError {
  constructor(code: string, message: string, details: Record<string, unknown> | null = null) {
    super(code, message, { status: 400, details });
  }
}

export function memoryError(code: string, message: string, details: Record<string, unknown> | null = null): MemoryError {
  return new MemoryError(code, message, details);
}

/** The sealed values a record holds in clear: pointer → value (strings only; the placeholder is not a value). */
export function sealedValuesOf(record: Pick<MemoryRecord, "fields" | "sealed">): Array<[pointer: string, value: string]> {
  const out: Array<[string, string]> = [];
  for (const pointer of record.sealed ?? []) {
    const value = pointerGet(record.fields, pointer);
    if (typeof value === "string" && value !== "sealed:omitted") out.push([pointer, value]);
  }
  return out;
}

/** The sealed pointers a record must list: the type's, plus the person's additions (M-24). */
export function sealedPointers(record: Pick<MemoryRecord, "sealed">, type: Pick<MemoryTypeView, "sealed_fields">): string[] {
  return [...new Set([...type.sealed_fields, ...(record.sealed ?? [])])];
}

export interface IntegrityContext {
  /** The records of the store by id (for `supersedes` checks); the record under check may be among them. */
  records: ReadonlyMap<string, Pick<MemoryRecord, "id" | "links">>;
}

/**
 * M-24 over one record, with the store unlocked: the frontmatter against the record schema, the
 * fields against the type schema, the sealed pointers, the sealed values out of title, tags and
 * body, the marker line, the caps, `supersedes` acyclic and single. Returns the record with its
 * links in canonical order and its sealed list complete; throws a `MemoryError` otherwise.
 */
export async function checkRecord(record: MemoryRecord, type: MemoryTypeView, context: IntegrityContext): Promise<MemoryRecord> {
  const checked: MemoryRecord = { ...record, fields: JSON.parse(JSON.stringify(record.fields)) as JsonObject };
  checked.links = canonicalLinks(record.links ?? []);
  if (checked.links.length === 0) delete checked.links;
  const pointers = sealedPointers(record, type);
  if (pointers.length > 0) checked.sealed = pointers;
  else delete checked.sealed;
  if (checked.tags && checked.tags.length === 0) delete checked.tags;
  if (!checked.demo) delete checked.demo;
  if (checked.valid_until === undefined) delete checked.valid_until;
  // The caps first, so an oversize record is named as such rather than as a schema failure (D-212).
  const bodyCap = checked.scope === "agent" ? MAX_AGENT_BODY_CHARS : MAX_BODY_CHARS;
  if (codePoints(checked.body) > bodyCap) throw memoryError("memory_record_too_large", `The body exceeds ${bodyCap} characters`);
  if (codePoints(canonicalString(checked.fields)) > MAX_FIELDS_CHARS) throw memoryError("memory_record_too_large", `The fields exceed ${MAX_FIELDS_CHARS} characters of canonical JSON`);
  if ((checked.tags ?? []).length > MAX_TAGS) throw memoryError("memory_record_too_large", `A record holds at most ${MAX_TAGS} tags`);
  if ((checked.links ?? []).length > MAX_LINKS) throw memoryError("memory_record_too_large", `A record holds at most ${MAX_LINKS} links`);
  const frontmatter = await memorySchemaFailure(checked, "memory-record.schema");
  if (frontmatter !== null) throw memoryError("frontmatter_invalid", `The record does not match memory-record.schema.json: ${frontmatter}`);
  if (checked.type !== type.id) throw memoryError("schema_validation", `The record's type ${checked.type} is not ${type.id}`);
  const failures = await failuresForSchema(type.schema, checked.fields, `${type.display_name} fields`);
  if (failures.length > 0) {
    const first = failures[0]!;
    throw memoryError("schema_validation", `The fields do not match the ${type.display_name} schema at ${first.instancePath.join("/") || "<root>"} (rule: ${first.keyword})`, { pointer: `/${first.instancePath.join("/")}`, keyword: first.keyword });
  }
  if (pointers.length > MAX_SEALED_POINTERS) throw memoryError("sealed_field_invalid", `A record seals at most ${MAX_SEALED_POINTERS} pointers`);
  const sealedValues: string[] = [];
  for (const pointer of pointers) {
    if (sealedPointerSchema(type.schema, pointer) === null) throw memoryError("sealed_field_invalid", `The sealed pointer ${pointer} does not name a string member the ${type.display_name} schema declares at every step`, { pointer });
    const value = pointerGet(checked.fields, pointer);
    if (value === undefined) continue;
    if (typeof value !== "string" || codePoints(value) < MIN_SEALED_LENGTH) throw memoryError("sealed_field_invalid", `The sealed field ${pointer} must hold a string of at least ${MIN_SEALED_LENGTH} characters`, { pointer });
    sealedValues.push(value);
  }
  for (const value of sealedValues) {
    if (containsFolded(checked.title, value)) throw memoryError("sealed_value_in_text", "The title contains a sealed value of the record");
    if ((checked.tags ?? []).some((tag) => containsFolded(tag, value))) throw memoryError("sealed_value_in_text", "A tag contains a sealed value of the record");
    if (containsFolded(checked.body, value)) throw memoryError("sealed_value_in_text", "The body contains a sealed value of the record");
  }
  if (checked.scope === "user" && MARKER_LINE.test(checked.body)) throw memoryError("body_reserved_marker", "The body holds the mirror marker line, which is reserved for exports");
  for (const link of checked.links ?? []) {
    if (!isRecordId(link.to)) throw memoryError("frontmatter_invalid", `The link target ${link.to} is not a record id`);
    if (link.to === checked.id) throw memoryError("frontmatter_invalid", "A record never links to itself");
  }
  checkSupersedes(checked, context.records);
  return checked;
}

/** M-24: `supersedes` acyclic over the whole store and at most one superseder per record. */
export function checkSupersedes(record: Pick<MemoryRecord, "id" | "links">, records: ReadonlyMap<string, Pick<MemoryRecord, "id" | "links">>): void {
  const mine = (record.links ?? []).filter((link) => link.rel === "supersedes").map((link) => link.to);
  if (mine.length === 0) return;
  if (mine.includes(SELF_ID)) throw memoryError("frontmatter_invalid", "The hub cannot be superseded");
  for (const target of mine) {
    for (const other of records.values()) {
      if (other.id === record.id) continue;
      if ((other.links ?? []).some((link) => link.rel === "supersedes" && link.to === target)) throw memoryError("superseded_twice", `${target} is already replaced by ${other.id}`, { target, by: other.id });
    }
  }
  // Follow the chain from each target: reaching this record again is a cycle.
  const superseders = new Map<string, string[]>();
  for (const other of records.values()) {
    if (other.id === record.id) continue;
    for (const link of other.links ?? []) if (link.rel === "supersedes") superseders.set(link.to, [...(superseders.get(link.to) ?? []), other.id]);
  }
  for (const target of mine) {
    const seen = new Set<string>([record.id]);
    const stack = [target];
    while (stack.length > 0) {
      const current = stack.pop()!;
      if (current === record.id) throw memoryError("supersedes_cycle", `Replacing ${target} would make a loop through ${record.id}`, { target });
      if (seen.has(current)) continue;
      seen.add(current);
      const next = records.get(current);
      for (const link of next?.links ?? []) if (link.rel === "supersedes") stack.push(link.to);
    }
  }
}

/** The JSON value at a pointer of the fields, for identity comparisons (M-44). */
export function identityValues(record: Pick<MemoryRecord, "fields">, pointers: readonly string[]): JsonValue[] {
  return pointers.map((pointer) => {
    const value = pointerGet(record.fields, pointer);
    return value === undefined ? null : value;
  });
}

/** M-44: strings compared NFKC case-insensitively, other JSON values exactly; absent equals absent and never a present value. */
export function sameIdentity(a: readonly JsonValue[], b: readonly JsonValue[]): boolean {
  if (a.length !== b.length || a.length === 0) return false;
  return a.every((left, index) => {
    const right = b[index]!;
    if (typeof left === "string" && typeof right === "string") return left.normalize("NFKC").toLowerCase() === right.normalize("NFKC").toLowerCase();
    return canonicalString(left) === canonicalString(right);
  });
}
