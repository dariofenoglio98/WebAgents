/**
 * The memory store (T19, D-183): the person's records with their sealed values in clear (the
 * storage layer seals them at rest under the master key, D-191), the type registry, the usage
 * log, and the derived graph and text indexes rebuilt after every write (M-28). It is the only
 * way a record reaches a run (`resolve`, M-35), the source of the host resource registry the
 * authorization flow reads (M-16, M-17), and the writer of every change (M-24): create, edit,
 * delete, accept, import, migrate, agent commit. No Chrome API: the shell persists `snapshot()`.
 */
import { canonicalJson } from "../canonical.js";
import { CoreError } from "../errors.js";
import { sha256HexSync } from "../hash.js";
import { REGISTRY_SCHEMA, normalizeResourceRegistry, type ResourceRegistry } from "../hostresources.js";
import type { JsonObject, JsonValue } from "../json.js";
import type { SealedValues } from "../tools/egress.js";
import type { HostResourceView, ResourceResolver } from "../tools/resources.js";
import type { ResourceGrant } from "../types.js";
import { AdapterError } from "../workflow/errors.js";
import { MemoryDigester } from "./digest.js";
import { recordToDocument } from "./document.js";
import { exportFolder, type ExportFile, type ExportOptions, type ImportFile, type ImportReport, planImport } from "./export.js";
import { buildGraphIndex, derivedLayers, type DerivedNode, type GraphIndex, headOf } from "./graph.js";
import { normalizeBodyLinks, viewBody } from "./links.js";
import {
  AGENT_TYPE,
  dateOf,
  instant,
  isRecordId,
  MAX_RECORDS,
  MAX_TYPES,
  type MemoryRecord,
  NOTE_TYPE,
  SELF_ID,
  SELF_TYPE,
  stamp,
  type UsageEntry,
} from "./model.js";
import { type Acceptance, acceptance, type AcceptanceContext, identityMatch } from "./proposals.js";
import { rankCandidates, type RecallCandidate } from "./recall.js";
import { scanSetOf, type ScanEntry, toSealedValues } from "./scan.js";
import { TextIndex } from "./textindex.js";
import { legacySealedPointers, type MemoryType, type MemoryTypeView, projectLegacy, schemaSha256, TypeRegistry } from "./types.js";
import { canonicalUsage } from "./usage.js";
import { checkRecord, memoryError, sealedPointers } from "./validate.js";

export const MEMORY_STORE_SCHEMA = "chrome-agent-browser-memory-v0";
export const MEMORY_SOURCE = "chrome-agent-browser memory (memory.v0 records in IndexedDB, sealed values under the master key, HMAC-SHA256 digests under the memory key)";
export const MEMORY_READ_IMPLEMENTATION = "chrome.tool.memory_read";
export const MEMORY_READ_IMPLEMENTATION_VERSION = "0.1.0";
/** Inactivity after which Tidy up lists a record (D-219). */
export const UNUSED_DAYS = 180;
/** The registry lists at most this many candidates per request (`hostresources.MAX_RESOURCES`). */
export const MAX_LISTED = 256;

/** What the shell persists: records in clear, the person's and packages' types, the usage log, the approvals. */
export interface MemorySnapshot {
  schema: typeof MEMORY_STORE_SCHEMA;
  records: MemoryRecord[];
  /** Types beyond the starter taxonomy (`declared_by` person or package). */
  types: MemoryType[];
  usage: UsageEntry[];
  /** Approved custom types: `<package id>:<type id>` → schema sha256 (M-18). */
  approvals: Record<string, string>;
}

export function emptyMemorySnapshot(): MemorySnapshot {
  return { schema: MEMORY_STORE_SCHEMA, records: [], types: [], usage: [], approvals: {} };
}

export interface MemoryRecordView extends MemoryRecord {
  digest: string;
  /** A sealed value the store could not read (M-10): never granted, listed in Tidy up. */
  unreadable: boolean;
  superseded_by: string | null;
  expired: boolean;
}

export interface TidyGroups {
  superseded: string[];
  expired: string[];
  unreadable: string[];
  dangling: string[];
  unused: string[];
  demo: string[];
  agents: string[];
}

export interface RecordDraft {
  id?: string;
  type: string;
  title: string;
  fields: JsonObject;
  body?: string;
  tags?: string[];
  links?: MemoryRecord["links"];
  sealed?: string[];
  demo?: boolean;
  valid_until?: string | null;
  /** M-44 for a new record: replace the identity match (default) or keep both. */
  identity?: "replace" | "keep_both";
}

export interface StoreOptions {
  key: Uint8Array;
  snapshot: MemorySnapshot;
  /** Records whose sealed values could not be read (M-10). */
  unreadable?: Iterable<string>;
  now?: () => Date;
  newId?: () => string;
}

export function newRecordId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let hex = "";
  for (const byte of bytes) hex += byte.toString(16).padStart(2, "0");
  return `mem_${hex}`;
}

/** M-49: `agent_` + the first 16 hex characters of SHA-256(package id). */
export function agentDocumentId(packageId: string): string {
  return `agent_${sha256HexSync(new TextEncoder().encode(packageId)).slice(0, 16)}`;
}

export class MemoryStore implements ResourceResolver {
  readonly types: TypeRegistry;
  private readonly records = new Map<string, MemoryRecord>();
  private readonly digests = new Map<string, string>();
  private usageLog: UsageEntry[] = [];
  private readonly approvals: Record<string, string>;
  private readonly unreadable: Set<string>;
  private readonly digester: MemoryDigester;
  private readonly clock: () => Date;
  private readonly newId: () => string;
  private graphIndex: GraphIndex;
  private text: TextIndex;
  /** The ids a run was granted (M-15): set by the execution host for the run's views; empty elsewhere. */
  grantedIds: ReadonlySet<string> = new Set();

  private constructor(options: StoreOptions) {
    this.digester = new MemoryDigester(options.key);
    this.clock = options.now ?? (() => new Date());
    this.newId = options.newId ?? newRecordId;
    this.types = new TypeRegistry();
    for (const type of options.snapshot.types) this.types.put(type);
    this.approvals = { ...options.snapshot.approvals };
    this.unreadable = new Set(options.unreadable ?? []);
    this.usageLog = canonicalUsage(options.snapshot.usage);
    for (const record of options.snapshot.records) this.records.set(record.id, record);
    this.graphIndex = buildGraphIndex(this.records.values());
    this.text = TextIndex.build(this.records.values());
  }

  /** Open a store over a snapshot: the hub is created or repaired (M-22) and every digest computed. */
  static async open(options: StoreOptions): Promise<MemoryStore> {
    const store = new MemoryStore(options);
    await store.ensureSelf();
    for (const record of store.records.values()) await store.redigest(record);
    store.rebuild();
    return store;
  }

  private async redigest(record: MemoryRecord): Promise<void> {
    const type = this.types.get(record.type);
    this.digests.set(record.id, await this.digester.digest(record, type ? type.schema_sha256 : schemaSha256({})));
  }

  private rebuild(): void {
    this.graphIndex = buildGraphIndex(this.records.values());
    this.text = TextIndex.build(this.records.values());
  }

  /** M-22: exactly one `self`; the first `person.self` by `created` keeps the id, others become notes. */
  private async ensureSelf(): Promise<void> {
    const selves = [...this.records.values()].filter((record) => record.type === SELF_TYPE).sort((a, b) => instant(a.created) - instant(b.created) || (a.id === SELF_ID ? -1 : b.id === SELF_ID ? 1 : 0));
    if (selves.length === 0) {
      const now = stamp(this.clock());
      this.records.set(SELF_ID, { id: SELF_ID, type: SELF_TYPE, title: "Me", scope: "user", created: now, updated: now, source: { kind: "person" }, fields: { display_name: "Me" }, body: "" });
      return;
    }
    const [keep, ...others] = selves;
    if (keep!.id !== SELF_ID) {
      this.records.delete(keep!.id);
      this.records.set(SELF_ID, { ...keep!, id: SELF_ID });
    }
    for (const other of others) {
      const name = typeof other.fields.display_name === "string" ? other.fields.display_name : other.title;
      this.records.set(other.id, { ...other, type: NOTE_TYPE, fields: {}, body: [other.body, `Display name: ${name}`].filter(Boolean).join("\n\n"), tags: [...new Set([...(other.tags ?? []), "type/person.self"])] });
    }
  }

  // -- reads ----------------------------------------------------------------------------------
  get size(): number {
    return this.records.size;
  }

  get graph(): GraphIndex {
    return this.graphIndex;
  }

  get usage(): readonly UsageEntry[] {
    return this.usageLog;
  }

  has(id: string): boolean {
    return this.records.has(id);
  }

  get(id: string): MemoryRecord | undefined {
    const record = this.records.get(id);
    return record ? (JSON.parse(JSON.stringify(record)) as MemoryRecord) : undefined;
  }

  /** The stored record, uncopied: for the store's own reads. */
  private held(id: string): MemoryRecord | undefined {
    return this.records.get(id);
  }

  all(): MemoryRecord[] {
    return [...this.records.values()].map((record) => JSON.parse(JSON.stringify(record)) as MemoryRecord);
  }

  digestOf(id: string): string | undefined {
    return this.digests.get(id);
  }

  isUnreadable(id: string): boolean {
    return this.unreadable.has(id);
  }

  private today(): string {
    return dateOf(this.clock());
  }

  view(id: string): MemoryRecordView | undefined {
    const record = this.get(id);
    if (!record) return undefined;
    return { ...record, digest: this.digests.get(id) ?? "", unreadable: this.unreadable.has(id), superseded_by: this.graphIndex.supersededBy.get(id) ?? null, expired: record.valid_until !== undefined && record.valid_until < this.today() };
  }

  views(): MemoryRecordView[] {
    return [...this.records.keys()].map((id) => this.view(id)!);
  }

  titles(): Map<string, string> {
    return new Map([...this.records.values()].map((record) => [record.id, record.title] as const));
  }

  search(query: string, limit = 100): Array<{ id: string; score: number }> {
    return this.text.search(query, limit);
  }

  layers(): { types: DerivedNode[]; packages: DerivedNode[] } {
    return derivedLayers(this.records.values(), this.usageLog, (typeId) => this.types.get(typeId)?.display_name ?? typeId);
  }

  /** D-219: what Tidy up lists; nothing is deleted here. */
  tidy(): TidyGroups {
    const today = this.today();
    const cutoff = this.clock().getTime() - UNUSED_DAYS * 24 * 60 * 60 * 1000;
    const lastUse = new Map<string, number>();
    for (const entry of this.usageLog) lastUse.set(entry.record_id, Math.max(lastUse.get(entry.record_id) ?? 0, instant(entry.at)));
    const groups: TidyGroups = { superseded: [], expired: [], unreadable: [], dangling: [], unused: [], demo: [], agents: [] };
    const dangling = new Set(this.graphIndex.dangling.map((edge) => edge.from));
    for (const record of this.records.values()) {
      if (record.scope === "agent") {
        groups.agents.push(record.id);
        continue;
      }
      if (this.graphIndex.superseded.has(record.id)) groups.superseded.push(record.id);
      if (record.valid_until !== undefined && record.valid_until < today) groups.expired.push(record.id);
      if (this.unreadable.has(record.id)) groups.unreadable.push(record.id);
      if (dangling.has(record.id)) groups.dangling.push(record.id);
      if (record.id !== SELF_ID && (lastUse.get(record.id) ?? 0) < cutoff && instant(record.created) < cutoff) groups.unused.push(record.id);
      if (record.demo) groups.demo.push(record.id);
    }
    return groups;
  }

  // -- recall and the registry (M-16, M-17, M-32, M-34) ------------------------------------------
  /** The candidates for one requested type (a type id or a legacy id), in recall order. */
  recall(resourceType: string, packageId: string, selected: readonly string[] = [], now: Date = this.clock()): RecallCandidate[] {
    const readable = [...this.records.values()].filter((record) => !this.unreadable.has(record.id));
    return rankCandidates({ records: readable, index: this.graphIndex, usage: this.usageLog, types: this.types, resourceType, packageId, selected, now });
  }

  /** Whether a requested type seals any field: the recall card then pre-selects nothing (M-52). */
  sealedType(resourceType: string): boolean {
    const type = this.types.resolve(resourceType);
    return type !== undefined && type.sealed_fields.length > 0;
  }

  /**
   * The host resource registry for one package's requests (M-16, M-17): one type entry per
   * requested type or legacy id the host holds, the candidates of each in recall order, never a
   * value. A record is listed once even when a package names a type and its alias.
   */
  registry(options: { runtimeVersion: string | null; now: Date; requested: readonly string[]; packageId: string; selected?: readonly string[] }): Promise<ResourceRegistry> {
    const types: JsonObject[] = [];
    const resources: JsonObject[] = [];
    const notes: Array<{ code: string; detail: string | null }> = [];
    const listed = new Set<string>();
    for (const requested of [...new Set(options.requested)]) {
      const own = this.types.get(requested);
      const legacy = this.types.legacyOf(requested);
      if (own === undefined && legacy === undefined) continue;
      if (own !== undefined) {
        if (own.id === AGENT_TYPE) continue;
        types.push({ id: own.id, display_name: own.display_name, description: own.description, permission_kind: "memory.read", schema_sha256: own.view_sha256 });
      } else types.push({ id: requested, display_name: legacy!.type.display_name, description: legacy!.type.description, permission_kind: "personal.read", schema_sha256: schemaSha256(legacy!.alias.schema) });
      const candidates = this.recall(requested, options.packageId, options.selected ?? [], options.now);
      for (const candidate of candidates.slice(0, MAX_LISTED)) {
        if (listed.has(candidate.id)) continue;
        listed.add(candidate.id);
        resources.push({ id: candidate.id, type: requested, label: candidate.title, digest: this.digests.get(candidate.id)! });
      }
      if (candidates.length > MAX_LISTED) notes.push({ code: "resources_truncated", detail: `${requested}: ${candidates.length - MAX_LISTED} more records are not listed; the Memory page shows them all.` });
    }
    return normalizeResourceRegistry({
      schema: REGISTRY_SCHEMA,
      host: { runtime: "chrome-agent-browser", runtime_version: options.runtimeVersion, source: MEMORY_SOURCE, captured_at: options.now.toISOString() },
      types,
      resources,
      notes,
    });
  }

  /** The type facts the host tool registry binds (`buildHostToolRegistry`): memory types by their view, legacy ids by the legacy schema. */
  resourceTypeFacts(requestedTypes: readonly string[]): Array<{ id: string; display_name: string; permission_kind: string; schema_sha256: string; binding: string }> {
    const out: Array<{ id: string; display_name: string; permission_kind: string; schema_sha256: string; binding: string }> = [];
    for (const requested of [...new Set(requestedTypes)]) {
      const own = this.types.get(requested);
      if (own !== undefined && own.id !== AGENT_TYPE) out.push({ id: own.id, display_name: own.display_name, permission_kind: "memory.read", schema_sha256: own.view_sha256, binding: `host.memory.${own.id}` });
      const legacy = this.types.legacyOf(requested);
      if (legacy !== undefined) out.push({ id: requested, display_name: legacy.type.display_name, permission_kind: "personal.read", schema_sha256: schemaSha256(legacy.alias.schema), binding: `host.resource.${requested}` });
    }
    return out;
  }

  // -- the resolver a run reads through (M-35, M-36) -----------------------------------------------
  describe(resourceId: string): HostResourceView | undefined {
    const record = this.records.get(resourceId);
    return record ? { id: record.id, type: record.type, label: record.title, digest: this.digests.get(record.id) ?? "" } : undefined;
  }

  /** The record view (M-15) for a memory grant, or the legacy projection (M-17) for a `personal.read` grant. */
  resolve(grant: ResourceGrant): JsonObject {
    const record = this.records.get(grant.resource_id);
    const refuse = () => new AdapterError("tool_unavailable", "the granted memory record is no longer the one that was granted, so it is not returned");
    if (!record || this.unreadable.has(record.id) || this.digests.get(record.id) !== grant.resource_digest || record.scope !== "user") throw refuse();
    if (record.type === grant.resource_type) {
      const granted = new Set([...this.grantedIds, grant.resource_id]);
      return this.recordView(record, granted);
    }
    const legacy = this.types.legacyOf(grant.resource_type);
    if (legacy === undefined || legacy.type.id !== record.type) throw refuse();
    return projectLegacy(JSON.parse(JSON.stringify(record.fields)) as JsonObject, legacy.alias);
  }

  /** M-15: the view of a record for a run that was granted `granted`. */
  recordView(record: MemoryRecord, granted: ReadonlySet<string>): JsonObject {
    return { id: record.id, type: record.type, title: record.title, fields: JSON.parse(JSON.stringify(record.fields)) as JsonObject, body: viewBody(record.body, granted).body, tags: [...(record.tags ?? [])], sealed: [...(record.sealed ?? [])] };
  }

  /** The legacy pointers a `personal.read` grant seals, for a fixture scan set (M-62). */
  legacySealed(resourceType: string): string[] {
    const legacy = this.types.legacyOf(resourceType);
    if (legacy === undefined) return [];
    return legacySealedPointers(legacy.type.sealed_fields, legacy.alias);
  }

  sealedValues(): SealedValues {
    return toSealedValues(this.scanSet());
  }

  /** M-36: the scan set of a run opened with this store: every sealed value of every record. */
  scanSet(): ScanEntry[] {
    return scanSetOf([...this.records.values()].filter((record) => !this.unreadable.has(record.id)));
  }

  // -- writes (M-24; the caller holds the unlocked store) ------------------------------------------
  private capCheck(adding: number): void {
    if (this.records.size + adding > MAX_RECORDS) throw memoryError("memory_full", `Memory is full (${MAX_RECORDS} records). Tidy up to make room.`, { cap: MAX_RECORDS });
  }

  private async write(record: MemoryRecord, options: { resolved?: boolean } = {}): Promise<MemoryRecord> {
    const type = this.types.get(record.type);
    if (!type) throw memoryError("memory_type_unknown", `This host holds no type ${record.type}`);
    const draft: MemoryRecord = { ...record };
    if (draft.scope === "user" && !options.resolved) draft.body = normalizeBodyLinks(draft.body, this.titles());
    const checked = await checkRecord(draft, type, { records: this.records });
    if (!this.records.has(checked.id)) this.capCheck(1);
    this.records.set(checked.id, checked);
    await this.redigest(checked);
    this.unreadable.delete(checked.id);
    this.rebuild();
    return checked;
  }

  /** A complete record written as given (a migrated or an imported one, with its own facts), checked by M-24. */
  put(record: MemoryRecord, options: { resolved?: boolean } = { resolved: true }): Promise<MemoryRecord> {
    return this.write(record, options);
  }

  /** A new record typed by the person (M-24, M-44). Returns the record and the record it replaced, if any. */
  async create(draft: RecordDraft): Promise<{ record: MemoryRecord; replaced: string | null }> {
    const type = this.types.get(draft.type);
    if (!type) throw memoryError("memory_type_unknown", `This host holds no type ${draft.type}`);
    if (type.id === SELF_TYPE || type.id === AGENT_TYPE) throw memoryError("memory_type_reserved", `${type.display_name} records are not created this way`);
    const now = stamp(this.clock());
    const id = draft.id ?? this.newId();
    if (this.records.has(id)) throw memoryError("memory_record_exists", `A record ${id} already exists`);
    const record: MemoryRecord = { id, type: type.id, title: draft.title.trim(), scope: "user", created: now, updated: now, source: { kind: "person" }, fields: JSON.parse(JSON.stringify(draft.fields)) as JsonObject, body: draft.body ?? "" };
    const links = [...type.default_links, ...(draft.links ?? [])].filter((link) => link.to !== id);
    let replaced: string | null = null;
    if (draft.identity !== "keep_both") {
      const match = identityMatch(record, type, this.records.values(), this.graphIndex.superseded);
      if (match !== null) {
        replaced = match.id;
        links.push({ to: match.id, rel: "supersedes" });
      }
    }
    if (links.length > 0) record.links = links;
    if (draft.tags && draft.tags.length > 0) record.tags = [...draft.tags];
    if (draft.sealed && draft.sealed.length > 0) record.sealed = [...draft.sealed];
    if (draft.demo) record.demo = true;
    if (draft.valid_until) record.valid_until = draft.valid_until;
    return { record: await this.write(record), replaced };
  }

  /** An edit (M-6: the source stays; `updated` moves). */
  async edit(id: string, changes: Partial<Pick<MemoryRecord, "title" | "fields" | "body" | "tags" | "links" | "sealed" | "valid_until" | "demo">>): Promise<MemoryRecord> {
    const current = this.held(id);
    if (!current) throw memoryError("memory_record_unknown", `No record ${id}`);
    if (current.scope === "agent") throw memoryError("memory_type_reserved", "An agent document is never edited by hand; clear it instead");
    const next: MemoryRecord = { ...current, ...JSON.parse(JSON.stringify(changes)), id, updated: stamp(this.clock()) };
    if (changes.valid_until === null) delete next.valid_until;
    if (id === SELF_ID) {
      next.type = SELF_TYPE;
      delete next.sealed;
    }
    return this.write(next);
  }

  /** M-25: the record and its sealed values go; links to it stay dangling; `self` stays. */
  delete(id: string): boolean {
    if (id === SELF_ID) throw memoryError("memory_self_undeletable", "The Me record cannot be deleted");
    const existed = this.records.delete(id);
    this.digests.delete(id);
    this.unreadable.delete(id);
    if (existed) this.rebuild();
    return existed;
  }

  /** The person's or a package's type (M-13, M-18); a changed schema re-digests the type's records (M-14). */
  async putType(type: MemoryType): Promise<MemoryTypeView> {
    if (this.types.size >= MAX_TYPES && !this.types.has(type.id)) throw memoryError("memory_full", `Memory holds at most ${MAX_TYPES} types`);
    const view = this.types.put(type);
    for (const record of this.records.values()) if (record.type === type.id) await this.redigest(record);
    return view;
  }

  deleteType(id: string): void {
    if ([...this.records.values()].some((record) => record.type === id)) throw memoryError("type_in_use", `Type ${id} still has records`);
    const type = this.types.get(id);
    if (type?.declared_by.kind === "spec") throw memoryError("memory_type_reserved", "A well-known type is never deleted");
    this.types.delete(id);
  }

  approveCustomType(packageId: string, type: MemoryType): void {
    this.approvals[`${packageId}:${type.id}`] = schemaSha256(type.schema);
  }

  customTypeApproved(packageId: string, typeId: string, schemaDigest: string): boolean {
    return this.approvals[`${packageId}:${typeId}`] === schemaDigest;
  }

  addUsage(entries: readonly UsageEntry[]): void {
    this.usageLog = canonicalUsage([...this.usageLog, ...entries]);
  }

  /** M-42: apply a review's decisions together; returns what was written. */
  async accept(context: Omit<AcceptanceContext, "records" | "headOf" | "types" | "titles" | "newId" | "now">): Promise<Acceptance> {
    const outcome = acceptance({ ...context, records: this.records, headOf: (id) => headOf(this.graphIndex, id), types: this.types, titles: this.titles(), newId: this.newId, now: this.clock() });
    this.capCheck(outcome.accepted.length);
    const written: MemoryRecord[] = [];
    try {
      for (const item of outcome.accepted) written.push(await this.write(item.record, { resolved: true }));
    } catch (error) {
      for (const record of written) {
        this.records.delete(record.id);
        this.digests.delete(record.id);
      }
      this.rebuild();
      throw error;
    }
    const now = stamp(this.clock());
    const entries: UsageEntry[] = [];
    for (const item of outcome.accepted) {
      entries.push({ record_id: item.record.id, use: "proposed", package_id: context.package.package_id, package_version: context.package.package_version, run_id: context.package.run_id, at: context.proposedAt });
      entries.push({ record_id: item.record.id, use: "accepted", package_id: context.package.package_id, package_version: context.package.package_version, run_id: context.package.run_id, at: now });
    }
    this.addUsage(entries);
    return outcome;
  }

  /** M-50: the agent document of a package, committed on completion; one per package id. */
  async commitAgent(input: { package_id: string; package_version: string; run_id: string; name: string; body: string; at: string }): Promise<MemoryRecord> {
    const id = agentDocumentId(input.package_id);
    const current = this.held(id);
    const now = input.at;
    const record: MemoryRecord = { id, type: AGENT_TYPE, title: input.name, scope: "agent", created: current?.created ?? now, updated: now, source: { kind: "agent", package_id: input.package_id, package_version: input.package_version, run_id: input.run_id }, fields: { package_id: input.package_id }, body: input.body };
    const written = await this.write(record, { resolved: true });
    this.addUsage([{ record_id: id, use: "agent_write", package_id: input.package_id, package_version: input.package_version, run_id: input.run_id, at: now }]);
    return written;
  }

  agentDocument(packageId: string): MemoryRecord | undefined {
    return this.get(agentDocumentId(packageId));
  }

  // -- export and import (M-55…M-60) ------------------------------------------------------------
  export(options: Omit<ExportOptions, "usage"> & { includeUsage?: boolean }): ExportFile[] {
    const { includeUsage, ...rest } = options;
    return exportFolder(this.records.values(), this.types, { ...rest, usage: includeUsage === false ? undefined : this.usageLog });
  }

  planImport(files: readonly ImportFile[]): ImportReport {
    return planImport(files, { types: this.types, records: this.records, newId: this.newId, now: this.clock() });
  }

  /**
   * Apply a confirmed import report (M-59): adds, updates (the newer written, the older kept under a
   * fresh id and superseded), the hub merge, the completed records; refused and incomplete items are
   * skipped unless `completions` supplies the typed values. All or nothing.
   */
  async applyImport(report: ImportReport, options: { completions?: Record<string, Record<string, string>> } = {}): Promise<{ written: string[]; skipped: string[] }> {
    const before = new Map(this.records);
    const digestsBefore = new Map(this.digests);
    const usageBefore = [...this.usageLog];
    const written: string[] = [];
    const skipped: string[] = [];
    try {
      for (const item of report.items) {
        const outcome = item.outcome;
        if (outcome.kind === "refused" || outcome.kind === "same") {
          if (outcome.kind === "refused") skipped.push(item.path);
          continue;
        }
        if (outcome.kind === "incomplete") {
          const typed = options.completions?.[item.path];
          if (!typed || outcome.missing.some((pointer) => typed[pointer] === undefined)) {
            skipped.push(item.path);
            continue;
          }
          const completed: MemoryRecord = { ...outcome.record, fields: JSON.parse(JSON.stringify(outcome.record.fields)) as JsonObject };
          for (const [pointer, value] of Object.entries(typed)) setPointer(completed.fields, pointer, value);
          this.capCheck(1);
          written.push((await this.write(completed, { resolved: true })).id);
          continue;
        }
        if (outcome.kind === "hub") {
          written.push((await this.write(outcome.record, { resolved: true })).id);
          continue;
        }
        if (outcome.kind === "add") {
          this.capCheck(1);
          written.push((await this.write(outcome.record, { resolved: true })).id);
          continue;
        }
        // update: the newer under the id, the older under a fresh id, superseded by the newer.
        this.capCheck(1);
        const olderId = this.newId();
        const older: MemoryRecord = { ...(outcome.newer_is_import ? outcome.older : outcome.record), id: olderId };
        const newer: MemoryRecord = { ...(outcome.newer_is_import ? outcome.record : outcome.older), id: outcome.record.id };
        const retarget = (record: MemoryRecord): MemoryRecord => ({ ...record, links: (record.links ?? []).map((link) => (link.to === newer.id ? { ...link, to: olderId } : link)) });
        const olderWritten = await this.write(retarget(older), { resolved: true });
        const links = [...(newer.links ?? []).filter((link) => !(link.rel === "supersedes" && link.to === olderId)), { to: olderId, rel: "supersedes" as const }];
        written.push((await this.write({ ...newer, links }, { resolved: true })).id, olderWritten.id);
      }
      if (report.usage.length > 0) this.addUsage(report.usage.filter((entry) => this.records.has(entry.record_id)));
    } catch (error) {
      this.records.clear();
      for (const [id, record] of before) this.records.set(id, record);
      this.digests.clear();
      for (const [id, digest] of digestsBefore) this.digests.set(id, digest);
      this.usageLog = usageBefore;
      this.rebuild();
      throw error;
    }
    return { written, skipped };
  }

  /** The canonical document of a record (M-9), for "Export this" and the tests. */
  document(id: string): string {
    const record = this.held(id);
    if (!record) throw memoryError("memory_record_unknown", `No record ${id}`);
    const type = this.types.get(record.type);
    return recordToDocument(record, type?.schema ?? { type: "object", properties: {} }, { titles: this.titles(), resolved: true });
  }

  /** Forget every record, note and usage entry; the hub is recreated (M-22). */
  async forget(): Promise<void> {
    this.records.clear();
    this.digests.clear();
    this.usageLog = [];
    this.unreadable.clear();
    await this.ensureSelf();
    await this.redigest(this.held(SELF_ID)!);
    this.rebuild();
  }

  snapshot(): MemorySnapshot {
    return {
      schema: MEMORY_STORE_SCHEMA,
      records: this.all(),
      types: this.types.toJSON().filter((type) => type.declared_by.kind !== "spec"),
      usage: [...this.usageLog],
      approvals: { ...this.approvals },
    };
  }

  /** The content digest of the whole snapshot, for change detection. */
  fingerprint(): string {
    return sha256HexSync(canonicalJson(this.snapshot() as unknown as JsonValue));
  }
}

function setPointer(value: JsonObject, pointer: string, next: JsonValue): void {
  const parts = pointer.split("/").slice(1);
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

export { isRecordId, sealedPointers };
export type { MemoryRecord, MemoryType, ResourceGrant, CoreError };
