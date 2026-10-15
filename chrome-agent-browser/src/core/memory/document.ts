/**
 * The canonical record document (M-9) and the export file (M-57, M-59): what the store writes,
 * what a folder holds, and how one becomes the other. A port of `record_to_document`,
 * `document_to_record` and `strip_mirror` in `scripts/check_memory_spec.py`.
 */
import type { JsonObject, JsonValue } from "../json.js";
import { bodyLinks, normalizeBodyLinks } from "./links.js";
import {
  aliasOf,
  BODY_LINK,
  canonicalLinks,
  isRecordId,
  isRelation,
  type MemoryLink,
  type MemoryRecord,
  type MemorySource,
  MIRROR_MARK,
  normalizeBody,
  orderFields,
  orderSource,
  pointerGet,
  pointerSet,
  RECORD_ID,
  RELATIONS,
  RESERVED_KEYS,
  SEALED_PLACEHOLDER,
  stemKey,
  WIKILINK,
} from "./model.js";
import { FrontmatterError, parseFrontmatter, splitDocument, writeFrontmatter } from "./yaml.js";

export interface DocumentOptions {
  /** The export file form (M-57): relations as properties, wikilinks by stem, the mirror after the body. */
  export?: boolean;
  /** Record id → file stem (M-55), for an export. */
  stems?: ReadonlyMap<string, string>;
  /** Record id → title, for aliases and for M-3's resolution of an edited body. */
  titles?: ReadonlyMap<string, string>;
  /** M-56: write every sealed value that exists as the placeholder. */
  omitSealed?: boolean;
  /** The body was already resolved (an import, M-59) or must never be (an agent body): skip M-3's rewrite. */
  resolved?: boolean;
}

const MIRROR_LINE = new RegExp(`^- (${RELATIONS.join("|")}): \\[\\[[^\\n]+\\]\\][ \\t]*$`, "u");
const isMarkerLine = (line: string): boolean => line.replace(/[ \t]+$/u, "") === MIRROR_MARK;

function linkTarget(to: string, stems: ReadonlyMap<string, string>): string {
  return stems.get(to) ?? to;
}

/** M-57: an edge by stem; a dangling id unchanged; plain or escaped text gains one backslash. */
function exportWikilink(whole: string, escapes: string, target: string, alias: string | null, stems: ReadonlyMap<string, string>, titles: ReadonlyMap<string, string>): string {
  if (escapes || !RECORD_ID.test(target)) return `\\${whole}`;
  const stem = stems.get(target);
  if (stem === undefined) return whole;
  if (alias === null || alias === aliasOf(titles.get(target) ?? "")) return `[[${stem}]]`;
  return `[[${stem}|${alias}]]`;
}

/** The canonical document of a record (M-9), or its export file (M-57). */
export function recordToDocument(record: MemoryRecord, typeSchema: JsonObject, options: DocumentOptions = {}): string {
  const stems = options.stems ?? new Map<string, string>();
  const titles = options.titles ?? new Map<string, string>();
  const fields = orderFields(JSON.parse(JSON.stringify(record.fields)) as JsonObject, typeSchema);
  if (options.export && options.omitSealed) {
    for (const pointer of record.sealed ?? []) if (pointerGet(fields, pointer) !== undefined) pointerSet(fields, pointer, SEALED_PLACEHOLDER);
  }
  const head: JsonObject = { id: record.id, type: record.type, title: record.title, scope: record.scope, created: record.created, updated: record.updated };
  if (record.valid_until) head.valid_until = record.valid_until;
  if (record.demo) head.demo = true;
  if (record.tags && record.tags.length > 0) head.tags = [...record.tags];
  for (const [key, value] of Object.entries(fields)) head[key] = value;
  if (record.sealed && record.sealed.length > 0) head.sealed = [...record.sealed];
  const links = canonicalLinks(record.links ?? []);
  if (links.length > 0) {
    if (options.export) {
      for (const relation of RELATIONS) {
        const targets = links.filter((link) => link.rel === relation).map((link) => link.to);
        if (targets.length > 0) head[relation] = targets.map((to) => `[[${linkTarget(to, stems)}]]`);
      }
    } else head.links = links.map((link) => ({ to: link.to, rel: link.rel }));
  }
  head.source = orderSource(record.source as unknown as JsonObject);
  let body = normalizeBody(record.body ?? "");
  const agent = record.scope === "agent";
  if (!options.export && !agent && !options.resolved) body = normalizeBodyLinks(body, titles);
  if (options.export && !agent) {
    body = body.replace(BODY_LINK, (whole, escapes: string, target: string, alias: string | undefined) => exportWikilink(whole, escapes, target, alias ?? null, stems, titles));
    if (links.length > 0) {
      const mirror = [MIRROR_MARK, "## Links", ...links.map((link) => `- ${link.rel}: [[${linkTarget(link.to, stems)}]]`)];
      body = (body ? `${body}\n\n` : "") + mirror.join("\n");
    }
  }
  let text = `---\n${writeFrontmatter(head)}\n---\n`;
  if (body) text += `\n${body}\n`;
  return text;
}

/** What `documentToRecord` learned beyond the record itself (M-59's report). */
export interface ParsedDocument {
  record: MemoryRecord;
  /** Property items that named no record: kept in the body as plain wikilinks, reported. */
  unresolved: string[];
  /** Mirror lines that were not among the properties (T18 review 6, nit 6): "not imported: edit the property instead". */
  mirror_not_imported: string[];
  /** Reserved keys an editor added (`aliases`, `cssclasses`) and dropped. */
  dropped_keys: string[];
}

export interface ImportResolution {
  /** Stem key or title key → record id (M-59: the imported set's stems first, then the store's unambiguous titles). */
  resolve: ReadonlyMap<string, string>;
  /** Record id → title, for aliases. */
  titles: ReadonlyMap<string, string>;
}

/** M-59: an escaped link loses one backslash; `[[<stem>]]` → `[[<id>|<alias>]]`; an id form and unknown text stay. */
function importWikilink(whole: string, escapes: string, target: string, alias: string | null, resolution: ImportResolution): string {
  if (escapes) return whole.slice(1);
  if (RECORD_ID.test(target)) return whole;
  const recordId = resolution.resolve.get(stemKey(target));
  if (recordId === undefined) return whole;
  return `[[${recordId}|${alias ?? aliasOf(resolution.titles.get(recordId) ?? target)}]]`;
}

/**
 * M-59: the mirror block starts at the body's last marker line and holds `## Links` when it
 * directly follows, then every directly following `- <rel>: [[…]]` line; the text before and
 * after stays, joined by one empty line. Returns the body and the mirror lines removed.
 */
export function stripMirror(body: string): { body: string; lines: string[] } {
  const lines = body.split("\n");
  let marker = -1;
  lines.forEach((line, index) => {
    if (isMarkerLine(line)) marker = index;
  });
  if (marker < 0) return { body, lines: [] };
  let end = marker + 1;
  if (end < lines.length && lines[end]!.replace(/[ \t]+$/u, "") === "## Links") end += 1;
  const removed: string[] = [];
  while (end < lines.length && MIRROR_LINE.test(lines[end]!)) {
    removed.push(lines[end]!);
    end += 1;
  }
  const before = lines.slice(0, marker);
  const after = lines.slice(end);
  while (before.length > 0 && before[before.length - 1]!.trim() === "") before.pop();
  while (after.length > 0 && after[0]!.trim() === "") after.shift();
  if (before.length > 0 && after.length > 0) return { body: [...before, "", ...after].join("\n"), lines: removed };
  return { body: (before.length > 0 ? before : after).join("\n"), lines: removed };
}

/**
 * Parse a stored document, or an export file (relations as properties, wikilinks by stem). The
 * reserved keys are read as the record's; every other top-level key is a field in document order.
 * Nothing is validated here beyond the subset: `validate.ts` judges the record.
 */
export function documentToRecord(text: string, options: { export?: boolean; resolution?: ImportResolution } = {}): ParsedDocument {
  const [headText, rawBody] = splitDocument(text);
  const head = parseFrontmatter(headText);
  const resolution = options.resolution ?? { resolve: new Map(), titles: new Map() };
  const record: Record<string, JsonValue> = {};
  const fields: JsonObject = {};
  const links: MemoryLink[] = [];
  const unresolved: string[] = [];
  const dropped: string[] = [];
  for (const [key, value] of Object.entries(head)) {
    if (isRelation(key) && options.export) {
      if (!Array.isArray(value)) throw new FrontmatterError(`${key} must be a list of wikilinks`);
      for (const item of value) {
        const match = typeof item === "string" ? WIKILINK.exec(item) : null;
        if (!match || match[0] !== item) throw new FrontmatterError(`${key}: ${JSON.stringify(item)} is not a whole-value wikilink`);
        const target = match[1]!;
        if (isRecordId(target)) {
          links.push({ to: target, rel: key });
          continue;
        }
        const recordId = resolution.resolve.get(stemKey(target));
        if (recordId === undefined) {
          unresolved.push(target);
          continue;
        }
        links.push({ to: recordId, rel: key });
      }
    } else if (key === "aliases" || key === "cssclasses") dropped.push(key);
    else if (RESERVED_KEYS.has(key)) record[key] = value;
    else fields[key] = value;
  }
  let body = normalizeBody(rawBody);
  let mirrorLines: string[] = [];
  if (options.export && record.scope !== "agent") {
    const stripped = stripMirror(body);
    body = stripped.body;
    mirrorLines = stripped.lines;
    body = body.replace(BODY_LINK, (whole, escapes: string, target: string, alias: string | undefined) => importWikilink(whole, escapes, target, alias ?? null, resolution));
    if (unresolved.length > 0) body = (body ? `${body}\n\n` : "") + unresolved.map((item) => `[[${item}]]`).join("\n");
    if (links.length > 0) record.links = canonicalLinks(links) as unknown as JsonValue;
  }
  record.fields = fields;
  record.body = body;
  // Mirror lines whose edge is not among the properties (an editor added one to the list): reported, never read.
  const propertyEdges = new Set(links.map((link) => `${link.rel}:${link.to}`));
  const mirrorNotImported = mirrorLines.filter((line) => {
    const match = /^- ([a-z_]+): \[\[([^\]]+)\]\]/u.exec(line);
    if (!match) return false;
    const to = isRecordId(match[2]!) ? match[2]! : (resolution.resolve.get(stemKey(match[2]!)) ?? null);
    return to === null || !propertyEdges.has(`${match[1]}:${to}`);
  });
  return { record: record as unknown as MemoryRecord, unresolved, mirror_not_imported: mirrorNotImported, dropped_keys: dropped };
}

/** The targets a body links to by id (M-3), for the graph: unescaped id wikilinks, `related`. */
export function bodyEdges(body: string): string[] {
  return bodyLinks(body)
    .filter((match) => !match.escapes && RECORD_ID.test(match.target))
    .map((match) => match.target);
}

export function sourceOf(raw: unknown): MemorySource | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const source = raw as Record<string, unknown>;
  const kind = source.kind;
  if (kind === "person") return Object.keys(source).length === 1 ? { kind: "person" } : null;
  if (kind === "package") {
    const { package_id, package_version, run_id, proposal, accepted } = source;
    if (typeof package_id === "string" && typeof package_version === "string" && typeof run_id === "string" && typeof proposal === "number" && typeof accepted === "string") return { kind, package_id, package_version, run_id, proposal, accepted };
    return null;
  }
  if (kind === "agent") {
    const { package_id, package_version, run_id } = source;
    if (typeof package_id === "string" && typeof package_version === "string" && typeof run_id === "string") return { kind, package_id, package_version, run_id };
    return null;
  }
  if (kind === "import") {
    const { from, imported } = source;
    return typeof from === "string" && typeof imported === "string" ? { kind, from, imported } : null;
  }
  if (kind === "migration") {
    const { from_type, migrated } = source;
    return typeof from_type === "string" && typeof migrated === "string" ? { kind, from_type, migrated } : null;
  }
  return null;
}
