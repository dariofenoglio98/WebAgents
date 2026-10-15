/**
 * The export folder (§8, M-55…M-60): `index.md`, `memory-usage.json` and one file per record
 * grouped by type; and the import { canonicalString } from "../canonical.js";
import of such a folder: a report before anything is written, then
 * the plan the store applies. The reader and writer are `document.ts`; this module owns the
 * folder: the stems, the index, the resolver (stems first, then the store's unambiguous titles),
 * the placeholders, the hub merge and the conflict rules.
 */
import { canonicalString } from "../canonical.js";
import type { JsonObject } from "../json.js";
import { documentToRecord, type ImportResolution, type ParsedDocument, recordToDocument, sourceOf } from "./document.js";
import { FrontmatterError } from "./yaml.js";
import {
  canonicalLinks,
  compareCodePoints,
  instant,
  isRecordId,
  type MemoryRecord,
  NOTE_TYPE,
  pointerDelete,
  pointerGet,
  pointerSet,
  SEALED_PLACEHOLDER,
  SELF_ID,
  SELF_TYPE,
  stamp,
  stemKey,
  stemsFor,
  titleIndex,
  type UsageEntry,
} from "./model.js";
import type { TypeRegistry } from "./types.js";
import { canonicalUsage, isUsageEntry, usageJson } from "./usage.js";
import { sealedPointers } from "./validate.js";

export interface ExportFile {
  path: string;
  text: string;
}

export interface ExportOptions {
  /** `chrome-agent-browser core <CORE_VERSION>` (M-58). */
  runtimeLabel: string;
  now: Date;
  /** M-56: write the sealed values in clear (an unlocked store, after a confirmation). */
  includeSealed: boolean;
  includeAgents: boolean;
  /** Export these ids only (the card's "Export this", the list's selection); every record by default. */
  only?: ReadonlySet<string>;
  usage?: readonly UsageEntry[];
}

export function typeFolder(typeId: string): string {
  return typeId.replace(/:/gu, "-");
}

/** M-55, M-57, M-58: the files of an export, in a stable order. */
export function exportFolder(records: Iterable<MemoryRecord>, types: TypeRegistry, options: ExportOptions): ExportFile[] {
  const all = [...records].filter((record) => (options.includeAgents || record.scope !== "agent") && (options.only === undefined || options.only.has(record.id)));
  const stems = stemsFor(all);
  const titles = new Map(all.map((record) => [record.id, record.title] as const));
  const files: ExportFile[] = [];
  const byType = new Map<string, MemoryRecord[]>();
  for (const record of all) byType.set(record.type, [...(byType.get(record.type) ?? []), record]);
  const ordered = types.ordered().map((type) => type.id).filter((id) => byType.has(id));
  for (const typeId of [...byType.keys()].sort(compareCodePoints)) if (!ordered.includes(typeId)) ordered.push(typeId);
  const index: string[] = ["# Memory index", "", `Exported ${stamp(options.now)} by ${options.runtimeLabel} · ${all.length} record${all.length === 1 ? "" : "s"} · memory.v0`];
  const known = new Set(all.map((record) => record.id));
  const missing = new Map<string, string | null>();
  for (const typeId of ordered) {
    const type = types.get(typeId);
    const members = [...byType.get(typeId)!].sort((a, b) => compareCodePoints(a.title, b.title) || compareCodePoints(a.id, b.id));
    index.push("", `## ${type?.display_name ?? typeId} (${typeId})`, "", "| Title | Id | Updated | Tags |", "|---|---|---|---|");
    for (const record of members) {
      const stem = stems.get(record.id)!;
      index.push(`| [[${stem}]] | \`${record.id}\` | ${record.updated} | ${(record.tags ?? []).join(", ")} |`);
      const schema = type?.schema ?? { type: "object", properties: {} };
      files.push({ path: `${typeFolder(typeId)}/${stem}.md`, text: recordToDocument(record, schema as JsonObject, { export: true, stems, titles, omitSealed: !options.includeSealed }) });
      for (const link of record.links ?? []) if (!known.has(link.to)) missing.set(link.to, missing.get(link.to) ?? null);
      if (record.scope !== "agent") {
        for (const match of record.body.matchAll(/(\\*)\[\[([^[\]|]+)(?:\|([^[\]]+))?\]\]/gu)) {
          if (match[1] || !isRecordId(match[2]!) || known.has(match[2]!)) continue;
          missing.set(match[2]!, match[3] ?? missing.get(match[2]!) ?? null);
        }
      }
    }
  }
  index.push("", "## Missing", "");
  if (missing.size === 0) index.push("None.");
  else for (const [id, alias] of [...missing.entries()].sort(([a], [b]) => compareCodePoints(a, b))) index.push(`- \`${id}\`${alias ? ` (last known title: ${alias})` : ""}`);
  files.unshift({ path: "index.md", text: `${index.join("\n")}\n` });
  if (options.usage !== undefined) {
    const ids = new Set(all.map((record) => record.id));
    files.splice(1, 0, { path: "memory-usage.json", text: usageJson(options.usage.filter((entry) => ids.has(entry.record_id))) });
  }
  return files;
}

// -- import (M-59) ------------------------------------------------------------------------------
export interface ImportFile {
  path: string;
  text: string;
}

export type ImportOutcome =
  | { kind: "add"; record: MemoryRecord; restored: string[] }
  | { kind: "same"; record: MemoryRecord }
  /** Differs from the stored record with the same id: the newer is written, the older kept under a fresh id and superseded. */
  | { kind: "update"; record: MemoryRecord; restored: string[]; older: MemoryRecord; newer_is_import: boolean }
  | { kind: "hub"; record: MemoryRecord }
  | { kind: "incomplete"; record: MemoryRecord; missing: string[] }
  | { kind: "refused"; path: string; reason: string };

export interface ImportItem {
  path: string;
  outcome: ImportOutcome;
  /** The id the file carried before a fresh one was assigned, when one was. */
  reassigned_from: string | null;
  /** Links that resolved by stem or title. */
  resolved_links: number;
  dangling_links: number;
  unresolved_text: string[];
  mirror_not_imported: string[];
  dropped_keys: string[];
  /** A file of unknown type became a note with its fields rendered into the body. */
  became_note: string | null;
}

export interface ImportReport {
  items: ImportItem[];
  usage: UsageEntry[];
  counts: { added: number; updated: number; same: number; hub: number; incomplete: number; refused: number; became_notes: number; links_resolved: number; links_dangling: number; links_as_text: number; sealed_restored: number };
}

export interface ImportContext {
  types: TypeRegistry;
  /** The store's records by id, sealed values in clear. */
  records: ReadonlyMap<string, MemoryRecord>;
  newId: () => string;
  now: Date;
}

const RECORD_FILE = /\.md$/u;

function noteFromFile(path: string, text: string, now: string): MemoryRecord {
  const name = path.split("/").pop()!.replace(RECORD_FILE, "");
  return { id: "", type: NOTE_TYPE, title: name || "untitled", scope: "user", created: now, updated: now, source: { kind: "import", from: path.split("/").pop()!, imported: now }, fields: {}, body: text.replace(/\r\n/gu, "\n").trim() };
}

/** Fields of an unknown type rendered into the body as a table, so nothing is lost (M-59). */
function fieldsTable(fields: JsonObject): string {
  const rows = Object.entries(fields).map(([key, value]) => `| ${key} | ${typeof value === "string" ? value.replace(/\|/gu, "\\|") : JSON.stringify(value)} |`);
  return rows.length === 0 ? "" : ["## Fields", "", "| Field | Value |", "|---|---|", ...rows].join("\n");
}

/**
 * M-59: read a folder (or a zip's files) and produce the report the person confirms. Nothing is
 * written here; `applyImport` in the store applies an `ImportReport` after the confirmation.
 */
export function planImport(files: readonly ImportFile[], context: ImportContext): ImportReport {
  const now = stamp(context.now);
  const records = files.filter((file) => RECORD_FILE.test(file.path) && file.path.replace(/^\.\//u, "") !== "index.md" && !file.path.endsWith("/index.md"));
  const usageFile = files.find((file) => file.path === "memory-usage.json" || file.path.endsWith("/memory-usage.json"));
  // First pass: the frontmatter of every file, for the stems and the titles of the imported set.
  const heads = new Map<string, { id: string | null; title: string | null; type: string | null }>();
  const parsedHeads = new Map<string, ParsedDocument | { error: string }>();
  for (const file of records) {
    try {
      const parsed = documentToRecord(file.text, { export: true });
      parsedHeads.set(file.path, parsed);
      const record = parsed.record as Partial<MemoryRecord>;
      heads.set(file.path, { id: typeof record.id === "string" ? record.id : null, title: typeof record.title === "string" ? record.title : null, type: typeof record.type === "string" ? record.type : null });
    } catch (error) {
      if (error instanceof FrontmatterError) {
        if (!file.text.startsWith("---")) heads.set(file.path, { id: null, title: null, type: null }); // no frontmatter: a note
        else parsedHeads.set(file.path, { error: error.message });
      } else throw error;
    }
  }
  // Ids: kept when well-formed and absent from the store or of the same type; else fresh.
  const assigned = new Map<string, string>();
  const reassigned = new Map<string, string | null>();
  const seenIds = new Set<string>();
  for (const file of records) {
    const head = heads.get(file.path);
    if (!head) continue;
    const typeId = head.type !== null && context.types.has(head.type) ? head.type : NOTE_TYPE;
    let id = head.id;
    const stored = id !== null ? context.records.get(id) : undefined;
    const keep = id !== null && isRecordId(id) && !seenIds.has(id) && (id === SELF_ID ? typeId === SELF_TYPE : id.startsWith("agent_") ? typeId === "agent.memory" : stored === undefined || stored.type === typeId);
    if (!keep) {
      reassigned.set(file.path, id);
      id = context.newId();
    }
    seenIds.add(id!);
    assigned.set(file.path, id!);
  }
  const stems = new Map<string, string>();
  const titles = new Map<string, string>();
  for (const [path, id] of assigned) {
    stems.set(id, path.split("/").pop()!.replace(RECORD_FILE, ""));
    const title = heads.get(path)?.title;
    titles.set(id, title ?? stems.get(id)!);
  }
  // The store as it will be after the import: its titles plus the imported ones (the imported win for a shared id).
  const after = new Map<string, string>();
  for (const [id, record] of context.records) after.set(id, record.title);
  for (const [id, title] of titles) after.set(id, title);
  const resolve = new Map<string, string>();
  for (const [id, stem] of stems) resolve.set(stemKey(stem), id);
  for (const [key, id] of titleIndex(after)) if (!resolve.has(key)) resolve.set(key, id);
  const resolution: ImportResolution = { resolve, titles: after };
  const items: ImportItem[] = [];
  const counts: ImportReport["counts"] = { added: 0, updated: 0, same: 0, hub: 0, incomplete: 0, refused: 0, became_notes: 0, links_resolved: 0, links_dangling: 0, links_as_text: 0, sealed_restored: 0 };
  for (const file of records) {
    const item: ImportItem = { path: file.path, outcome: { kind: "refused", path: file.path, reason: "" }, reassigned_from: reassigned.get(file.path) ?? null, resolved_links: 0, dangling_links: 0, unresolved_text: [], mirror_not_imported: [], dropped_keys: [], became_note: null };
    const head = parsedHeads.get(file.path);
    if (head !== undefined && "error" in head) {
      item.outcome = { kind: "refused", path: file.path, reason: head.error };
      counts.refused += 1;
      items.push(item);
      continue;
    }
    let parsed: ParsedDocument;
    let record: MemoryRecord;
    if (head === undefined) {
      // No frontmatter: a note with the stem as its title and the whole file as its body.
      record = noteFromFile(file.path, file.text, now);
      record.id = assigned.get(file.path)!;
      item.became_note = "no frontmatter";
      counts.became_notes += 1;
      parsed = { record, unresolved: [], mirror_not_imported: [], dropped_keys: [] };
    } else {
      try {
        parsed = documentToRecord(file.text, { export: true, resolution });
      } catch (error) {
        item.outcome = { kind: "refused", path: file.path, reason: error instanceof Error ? error.message : "unreadable" };
        counts.refused += 1;
        items.push(item);
        continue;
      }
      record = parsed.record;
      record.id = assigned.get(file.path)!;
      const originalType = typeof record.type === "string" ? record.type : null;
      if (originalType === null || typeof record.title !== "string") {
        const note = noteFromFile(file.path, "", now);
        record = { ...note, id: record.id, body: parsed.record.body ?? "", fields: {} };
        item.became_note = "no id or type";
        counts.became_notes += 1;
      } else if (!context.types.has(originalType)) {
        // An unknown type becomes a note with the original type as a tag and its fields in the body.
        const table = fieldsTable(record.fields);
        record = { ...record, type: NOTE_TYPE, fields: {}, tags: [...new Set([...(record.tags ?? []), `type/${originalType.toLowerCase().replace(/[^a-z0-9_/-]/gu, "-").slice(0, 44)}`])], body: [record.body, table].filter(Boolean).join("\n\n") };
        delete record.sealed;
        item.became_note = originalType;
        counts.became_notes += 1;
      }
    }
    record.scope = record.scope === "agent" ? "agent" : "user";
    record.created = typeof record.created === "string" ? record.created : now;
    record.updated = typeof record.updated === "string" ? record.updated : now;
    const source = sourceOf(record.source);
    record.source = source ?? { kind: "import", from: file.path.split("/").pop()!, imported: now };
    if (record.id === SELF_ID) record.source = { kind: "person" };
    item.unresolved_text = parsed.unresolved;
    item.mirror_not_imported = parsed.mirror_not_imported;
    item.dropped_keys = parsed.dropped_keys;
    counts.links_as_text += parsed.unresolved.length;
    const known = new Set([...context.records.keys(), ...assigned.values()]);
    for (const link of record.links ?? []) {
      if (known.has(link.to)) {
        item.resolved_links += 1;
        counts.links_resolved += 1;
      } else {
        item.dangling_links += 1;
        counts.links_dangling += 1;
      }
    }
    // Placeholders (M-56, M-59): restored from the store by id, else missing.
    const type = context.types.get(record.type);
    const stored = context.records.get(record.id);
    const pointers = type ? sealedPointers(record, type) : (record.sealed ?? []);
    const restored: string[] = [];
    const missing: string[] = [];
    for (const pointer of pointers) {
      if (pointerGet(record.fields, pointer) !== SEALED_PLACEHOLDER) continue;
      const value = stored ? pointerGet(stored.fields, pointer) : undefined;
      if (value === undefined) {
        pointerDelete(record.fields, pointer);
        missing.push(pointer);
      } else {
        pointerSet(record.fields, pointer, value);
        restored.push(pointer);
      }
    }
    counts.sealed_restored += restored.length;
    if (type && pointers.length > 0) record.sealed = pointers;
    const required = new Set(Array.isArray(type?.schema.required) ? (type!.schema.required as string[]) : []);
    const missingRequired = missing.filter((pointer) => pointer.split("/").length === 2 && required.has(pointer.split("/")[1]!));
    if (record.id === SELF_ID) {
      const hub = context.records.get(SELF_ID);
      const merged = hub ? mergeHub(hub, record, now) : record;
      // A hub that merges into exactly what the store holds is "already here", not a write (the user's walk-through: an export imported back offered to import one record).
      if (hub && canonicalString(merged) === canonicalString(hub)) {
        item.outcome = { kind: "same", record: hub };
        counts.same += 1;
      } else {
        item.outcome = { kind: "hub", record: merged };
        counts.hub += 1;
      }
    } else if (missingRequired.length > 0) {
      item.outcome = { kind: "incomplete", record, missing: missingRequired };
      counts.incomplete += 1;
    } else if (stored === undefined) {
      item.outcome = { kind: "add", record, restored };
      counts.added += 1;
    } else if (sameContent(stored, record)) {
      item.outcome = { kind: "same", record };
      counts.same += 1;
    } else {
      const newerIsImport = instant(record.updated) >= instant(stored.updated);
      item.outcome = { kind: "update", record, restored, older: stored, newer_is_import: newerIsImport };
      counts.updated += 1;
    }
    items.push(item);
  }
  let usage: UsageEntry[] = [];
  if (usageFile) {
    try {
      const parsed = JSON.parse(usageFile.text) as unknown;
      if (Array.isArray(parsed)) usage = canonicalUsage(parsed.filter(isUsageEntry));
    } catch {
      usage = [];
    }
  }
  return { items, usage, counts };
}

/** Whether two records have the same digest input (M-11's content): id, type, title, fields, body, links, tags. */
export function sameContent(a: MemoryRecord, b: MemoryRecord): boolean {
  const content = (record: MemoryRecord) => JSON.stringify({ id: record.id, type: record.type, title: record.title, fields: record.fields, body: record.body, links: canonicalLinks(record.links ?? []), tags: record.tags ?? [] });
  return content(a) === content(b);
}

/** M-59: the imported hub replaces the store's title, fields, body, tags, demo, valid_until and updated; links unite; the earlier `created`; `source` person. */
export function mergeHub(storeHub: MemoryRecord, imported: MemoryRecord, now: string): MemoryRecord {
  const importedLinks = canonicalLinks(imported.links ?? []);
  const links = canonicalLinks([...importedLinks, ...(storeHub.links ?? [])]);
  const merged: MemoryRecord = { ...JSON.parse(JSON.stringify(imported)), id: SELF_ID, type: SELF_TYPE, scope: "user", created: instant(storeHub.created) <= instant(imported.created) ? storeHub.created : imported.created, source: { kind: "person" } };
  if (JSON.stringify(links) !== JSON.stringify(importedLinks)) merged.updated = now;
  if (links.length > 0) merged.links = links;
  else delete merged.links;
  delete merged.sealed;
  return merged;
}
