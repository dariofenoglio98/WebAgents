/**
 * The memory as the service worker holds it (T19, memory.v0 §2…§8, §11; D-221…D-223): the one
 * opened `MemoryStore` over the IndexedDB rows, locked (every unsealed part readable, nothing
 * writable, M-10) or unlocked (sealed values opened under the data key the secret store holds);
 * persistence by difference (changed rows re-sealed and written, removed rows deleted, the meta
 * document when it changed); the Memory page's view with sealed values masked; the writes the
 * page asks for, each behind the unlocked store; export and import through the folder codec; the
 * one-time vault migration with its report (M-66); the host registry facts for a package's
 * requests; and the run side: the snapshot a run is opened with, the usage log, the agent
 * document's commit and the review of a run's proposals (M-42). Nothing here knows a package.
 */
import { canonicalString } from "../../core/canonical.js";
import { CoreError } from "../../core/errors.js";
import type { JsonObject, JsonValue } from "../../core/json.js";
import { agentToolSchemas } from "../../core/memory/declarations.js";
import type { ExportFile, ImportFile, ImportReport } from "../../core/memory/export.js";
import type { DerivedNode, GraphEdge } from "../../core/memory/graph.js";
import { migrateVault, type MigrationReport } from "../../core/memory/migration.js";
import { AGENT_TYPE, MAX_RECORDS, MAX_TYPES, type MemoryLink, type MemoryRecord, type Relation, type UsageEntry, isRelation, pointerGet, pointerSet, RELATION_WORDS, SEALED_PLACEHOLDER, SELF_ID, SELF_TYPE } from "../../core/memory/model.js";
import { checkProposals, identityMatch, type Acceptance, type ProposalsDocument, type ReviewDecision, ProposalRefusal } from "../../core/memory/proposals.js";
import type { RecallCandidate } from "../../core/memory/recall.js";
import { agentDocumentId, emptyMemorySnapshot, MemoryStore, type MemoryRecordView, type MemorySnapshot, type RecordDraft, type TidyGroups } from "../../core/memory/store.js";
import type { MemoryType, MemoryTypeView } from "../../core/memory/types.js";
import { MemoryError, sealedValuesOf } from "../../core/memory/validate.js";
import { provenanceWords } from "../../core/memory/words.js";
import { sha256HexSync } from "../../core/hash.js";
import type { ResourceRegistry } from "../../core/hostresources.js";
import { generateVaultKey, type VaultDocument } from "../../core/vault.js";
import { CORE_VERSION } from "../../core/version.js";
import { unavailableStoreError, type SecretStoreState } from "../../core/secrets.js";
import type { ResourceGrant } from "../../core/types.js";
import { metaOf, openRecord, sealRecord, type MemoryStorage, type StoredMemoryRecord } from "../storage/memory.js";
import type { SettingsStorage } from "../storage/settings.js";
import demoHostResources from "../data/demo-host-resources.json" with { type: "json" };

export interface MemoryControllerDeps {
  settings: SettingsStorage;
  storage: MemoryStorage;
  secretsState: () => Promise<SecretStoreState>;
  broadcast: () => void;
  clock: () => Date;
  version: string;
  newId?: () => string;
}

/** The opened store with what persistence needs: the data key, and the rows as they were last written. */
interface Opened {
  store: MemoryStore;
  locked: boolean;
  dataKey: Uint8Array | null;
  baseline: Map<string, string>;
  meta: string;
  generation: number;
}

export interface UsageSummary {
  package_id: string;
  runs: number;
  last: string;
  uses: Record<string, number>;
}

/** A record as the Memory page sees it: the view with every sealed value masked (M-4 keeps titles clean; D-225). */
export interface MemoryRecordListing extends MemoryRecordView {
  usage: UsageSummary[];
  sealed_pointers: string[];
}

export interface AgentNoteView {
  id: string;
  package_id: string;
  title: string;
  bytes: number;
  updated: string;
  run_id: string | null;
  package_version: string | null;
}

export interface MemoryView {
  state: SecretStoreState;
  locked: boolean;
  records: MemoryRecordListing[];
  types: MemoryTypeView[];
  edges: GraphEdge[];
  dangling: GraphEdge[];
  layers: { types: DerivedNode[]; packages: DerivedNode[] };
  tidy: TidyGroups;
  counts: { records: number; types: number; superseded: number; bytes: number; agents: number; demo: number };
  caps: { records: number; types: number };
  demo_available: boolean;
  migration: MigrationReport | null;
  agents: AgentNoteView[];
  /** The idle lock's facts for the status line ("locks in n min"). */
  lock: { idle_minutes: number | null; last_used_at: string | null };
}

export interface RecallFacts {
  candidates: Array<RecallCandidate & { last_use: { package_id: string; at: string; runs: number } | null; provenance: string }>;
  sealed: boolean;
  display_name: string | null;
  sealed_fields: string[];
}

export interface ExportRequest {
  includeSealed: boolean;
  includeAgents: boolean;
  recordIds?: readonly string[] | null;
}

/** An import item as the sheet shows it: never a sealed value, never the whole record. */
export interface ImportItemView {
  path: string;
  kind: ImportReportKind;
  title: string | null;
  type: string | null;
  reason: string | null;
  missing: Array<{ pointer: string; field: string }>;
  restored: number;
  resolved_links: number;
  dangling_links: number;
  unresolved_text: string[];
  mirror_not_imported: string[];
  dropped_keys: string[];
  became_note: string | null;
  newer_is_import: boolean | null;
}
type ImportReportKind = "add" | "same" | "update" | "hub" | "incomplete" | "refused";

export interface ImportPlanView {
  items: ImportItemView[];
  counts: ImportReport["counts"];
  usage_entries: number;
}

/** What the review sheet needs for one run's proposals (D-223): the document, and per proposal the facts acceptance would use. */
export interface ReviewView {
  document: ProposalsDocument;
  facts: Array<{
    index: number;
    type_display_name: string;
    type_description: string | null;
    new_type: boolean;
    sealed_required: Array<{ pointer: string; field: string }>;
    target_title: string | null;
    target_replaced_since: { head_id: string; head_title: string } | null;
    identity_match: { id: string; title: string; fields: string[] } | null;
    kept: { sealed: string[]; links: Array<{ to: string; rel: Relation; title: string }>; related: string[] };
    link_titles: Record<string, string>;
  }>;
  memory_full: boolean;
  records: number;
  cap: number;
}

export interface ReviewOutcome {
  accepted: Array<{ index: number; id: string; title: string; supersedes: string | null; dropped_links: string[] }>;
  rejected: number[];
}

function reject(code: string, message: string, status = 400, details: Record<string, unknown> | null = null): CoreError {
  return new CoreError(code, message, { status, details });
}

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/** The demo set's record ids are stable (`mem_` + SHA-256 of the demo resource id), so the fictional set is the same in every browser and in the tests. */
export function demoRecordId(resourceId: string): string {
  return `mem_${sha256HexSync(new TextEncoder().encode(`demo:${resourceId}`)).slice(0, 32)}`;
}

/** What `persist` compares: the row as written (placeholders in place) and the sealed values in clear; never a box, whose IV differs every time. */
function rowIdentity(row: StoredMemoryRecord, record: MemoryRecord): string {
  return canonicalString({ record: row.record, sealed: Object.keys(row.sealed_values ?? {}).sort(), values: sealedValuesOf(record) });
}

function fieldName(pointer: string): string {
  return pointer.split("/").slice(1).join(" › ").replace(/_/gu, " ");
}

/** The record's view with every sealed value replaced by the placeholder (D-225: the page never holds a sealed value until Reveal). */
export function maskRecord<T extends Pick<MemoryRecord, "fields" | "sealed">>(record: T): T {
  const masked = clone(record);
  for (const [pointer] of sealedValuesOf(record)) pointerSet(masked.fields, pointer, SEALED_PLACEHOLDER);
  return masked;
}

export class MemoryController {
  private cache: Promise<Opened> | null = null;
  private generation = 0;
  /** Every write runs alone: an opening, a diff and its rows never interleave (the vault's `saveVault` guard, generalized). */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly deps: MemoryControllerDeps) {}

  /** The secret store changed (lock, unlock, setup, forget, passphrase): the opened store is stale. */
  invalidate(): void {
    this.generation += 1;
    this.cache = null;
  }

  private run<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(work, work);
    this.queue = next.catch(() => undefined);
    return next;
  }

  /** The opened store, locked or unlocked; a failed opening is retried by the next call. */
  opened(): Promise<Opened> {
    if (this.cache === null) {
      const generation = this.generation;
      this.cache = this.open(generation).catch((error: unknown) => {
        if (this.generation === generation) this.cache = null;
        throw error;
      });
    }
    return this.cache;
  }

  /** The unlocked store, or the store's own refusal (`store_locked`, `store_no_passphrase`, `store_invalid`). */
  async unlocked(): Promise<Opened> {
    const state = await this.deps.secretsState();
    if (state !== "unlocked") {
      this.invalidate();
      throw unavailableStoreError(state);
    }
    const opened = await this.opened();
    if (opened.locked) {
      // Opened while locked, unlocked since (the event raced the open): open again with the keys.
      this.invalidate();
      return this.opened();
    }
    return opened;
  }

  private async open(generation: number): Promise<Opened> {
    const state = await this.deps.secretsState();
    const locked = state !== "unlocked";
    let key: Uint8Array;
    let dataKey: Uint8Array | null = null;
    if (locked) key = generateVaultKey();
    else ({ key, dataKey } = await this.deps.settings.memoryKeys());
    const rows = await this.deps.storage.loadRecords();
    const meta = await this.deps.storage.loadMeta();
    const records: MemoryRecord[] = [];
    const unreadable: string[] = [];
    const baseline = new Map<string, string>();
    for (const row of rows) {
      const opened = await openRecord(row, dataKey);
      records.push(opened.record);
      if (opened.unreadable) unreadable.push(row.id);
      baseline.set(row.id, rowIdentity(row, opened.record));
    }
    const snapshot: MemorySnapshot = meta === null ? { ...emptyMemorySnapshot(), records } : { schema: emptyMemorySnapshot().schema, records, types: meta.types, usage: meta.usage, approvals: meta.approvals };
    let store: MemoryStore;
    try {
      store = await MemoryStore.open({ key, snapshot, unreadable, now: this.deps.clock, newId: this.deps.newId });
    } catch (error) {
      throw reject("memory_unreadable", `The stored memory could not be opened: ${error instanceof Error ? error.message : "invalid"}`, 500);
    }
    const opened: Opened = { store, locked, dataKey, baseline, meta: meta === null ? "" : canonicalString(metaOf(snapshot)), generation };
    if (!locked) {
      // M-66: the vault moves into memory once, on the first unlocked open; its document stays until Done.
      await this.migrateIfNeeded(opened);
      // A fresh memory (no row ever written) is persisted once so the hub exists at rest.
      if (rows.length === 0 && meta === null) await this.persist(opened);
    }
    return opened;
  }

  private async migrateIfNeeded(opened: Opened): Promise<void> {
    if ((await this.deps.settings.migrationReport()) !== null) return;
    const vault = await this.deps.settings.vaultDocumentIfAny();
    if (vault === null) return;
    const report = await migrateVault(opened.store, vault, { now: this.deps.clock(), newId: this.deps.newId });
    await this.persist(opened);
    await this.deps.settings.saveMigrationReport(report);
  }

  /** Write what changed: re-sealed rows for changed records, deletions, the meta when it changed. Refuses when the store changed meanwhile. */
  private async persist(opened: Opened): Promise<void> {
    if (opened.generation !== this.generation) throw reject("store_changed", "Your keys and records were locked, forgotten or set up again while this change was being made; nothing was saved. Try again.", 409);
    if (opened.locked || opened.dataKey === null) throw unavailableStoreError("locked");
    const snapshot = opened.store.snapshot();
    const changed: StoredMemoryRecord[] = [];
    const seen = new Set<string>();
    for (const record of snapshot.records) {
      const row = await sealRecord(record, opened.dataKey);
      // A sealed row's ciphertext differs every time; compare the record and its values, not the boxes.
      const identity = rowIdentity(row, record);
      seen.add(record.id);
      if (opened.baseline.get(record.id) !== identity) {
        changed.push(row);
        opened.baseline.set(record.id, identity);
      }
    }
    const removed = [...opened.baseline.keys()].filter((id) => !seen.has(id));
    for (const id of removed) opened.baseline.delete(id);
    const meta = metaOf(snapshot);
    const metaText = canonicalString(meta);
    if (changed.length > 0) await this.deps.storage.putRecords(changed);
    if (removed.length > 0) await this.deps.storage.deleteRecords(removed);
    if (metaText !== opened.meta) {
      await this.deps.storage.saveMeta(meta);
      opened.meta = metaText;
    }
  }

  /** One queued write: open unlocked, mutate, persist, broadcast. */
  private write<T>(work: (opened: Opened) => Promise<T>): Promise<T> {
    return this.run(async () => {
      const opened = await this.unlocked();
      const result = await work(opened);
      await this.persist(opened);
      this.deps.broadcast();
      return result;
    });
  }

  // -- the Memory page -------------------------------------------------------------------------
  async view(): Promise<MemoryView> {
    const state = await this.deps.secretsState();
    const opened = await this.opened();
    const store = opened.store;
    const byRecord = new Map<string, Map<string, UsageSummary>>();
    for (const entry of store.usage) {
      const packages = byRecord.get(entry.record_id) ?? new Map<string, UsageSummary>();
      const summary = packages.get(entry.package_id) ?? { package_id: entry.package_id, runs: 0, last: entry.at, uses: {} };
      summary.uses[entry.use] = (summary.uses[entry.use] ?? 0) + 1;
      if (entry.at > summary.last) summary.last = entry.at;
      packages.set(entry.package_id, summary);
      byRecord.set(entry.record_id, packages);
    }
    const runsOf = new Map<string, Set<string>>();
    for (const entry of store.usage) {
      const key = `${entry.record_id}|${entry.package_id}`;
      runsOf.set(key, (runsOf.get(key) ?? new Set()).add(entry.run_id));
    }
    const records: MemoryRecordListing[] = store
      .views()
      .filter((view) => view.scope === "user")
      .map((view) => ({
        ...maskRecord(view),
        sealed_pointers: [...(view.sealed ?? [])],
        usage: [...(byRecord.get(view.id)?.values() ?? [])].map((summary) => ({ ...summary, runs: runsOf.get(`${view.id}|${summary.package_id}`)?.size ?? 0 })).sort((a, b) => (a.last < b.last ? 1 : -1)),
      }));
    const agents: AgentNoteView[] = store
      .all()
      .filter((record) => record.scope === "agent")
      .map((record) => ({ id: record.id, package_id: String(record.fields.package_id ?? ""), title: record.title, bytes: new TextEncoder().encode(record.body).length, updated: record.updated, run_id: record.source.kind === "agent" ? record.source.run_id : null, package_version: record.source.kind === "agent" ? record.source.package_version : null }));
    const tidy = store.tidy();
    const status = await this.deps.settings.store.status();
    const bytes = new TextEncoder().encode(canonicalString(store.snapshot())).length;
    return {
      state,
      locked: opened.locked,
      records,
      types: store.types.all(),
      edges: store.graph.edges,
      dangling: store.graph.dangling,
      layers: store.layers(),
      tidy,
      counts: { records: store.size, types: store.types.size, superseded: tidy.superseded.length, bytes, agents: agents.length, demo: tidy.demo.length },
      caps: { records: MAX_RECORDS, types: MAX_TYPES },
      demo_available: true,
      migration: ((await this.deps.settings.migrationReport()) as MigrationReport | null) ?? null,
      agents,
      lock: { idle_minutes: status.idle_minutes, last_used_at: status.last_used_at },
    };
  }

  /** One sealed value, in clear, for the card's Reveal: the unlocked store only; never logged. */
  async reveal(recordId: string, pointer: string): Promise<{ value: string }> {
    const opened = await this.unlocked();
    const record = opened.store.get(recordId);
    if (!record) throw reject("memory_record_unknown", `No record ${recordId}`, 404);
    if (opened.store.isUnreadable(recordId)) throw reject("sealed_value_unreadable", "A sealed value of this record cannot be read: the store key changed. Tidy up lists it.", 409);
    if (!(record.sealed ?? []).includes(pointer)) throw reject("invalid_request", "That field is not sealed", 400);
    const value = pointerGet(record.fields, pointer);
    return { value: typeof value === "string" ? value : "" };
  }

  search(query: string): Promise<Array<{ id: string; score: number }>> {
    return this.opened().then((opened) => opened.store.search(query));
  }

  create(draft: RecordDraft): Promise<{ id: string; replaced: string | null }> {
    return this.write(async ({ store }) => {
      const result = await store.create(draft);
      return { id: result.record.id, replaced: result.replaced };
    });
  }

  /**
   * An edit from the card. A sealed field submitted as the placeholder keeps its stored value
   * (the page never held it); any other submitted value replaces it (M-42's "retyped only if the
   * person wants").
   */
  edit(recordId: string, changes: Partial<Pick<MemoryRecord, "title" | "fields" | "body" | "tags" | "links" | "sealed" | "valid_until" | "demo">>): Promise<{ id: string }> {
    return this.write(async ({ store }) => {
      const current = store.get(recordId);
      if (!current) throw reject("memory_record_unknown", `No record ${recordId}`, 404);
      const next = clone(changes);
      if (next.fields !== undefined) {
        for (const pointer of next.sealed ?? current.sealed ?? []) {
          if (pointerGet(next.fields, pointer) === SEALED_PLACEHOLDER) {
            const stored = pointerGet(current.fields, pointer);
            if (stored !== undefined) pointerSet(next.fields, pointer, stored);
          }
        }
      }
      const written = await store.edit(recordId, next);
      return { id: written.id };
    });
  }

  delete(recordIds: readonly string[]): Promise<{ deleted: string[] }> {
    return this.write(async ({ store }) => {
      const deleted: string[] = [];
      for (const id of recordIds) if (store.delete(id)) deleted.push(id);
      return { deleted };
    });
  }

  /** The graph's drag-to-link and the card's [+ Link…]: one typed link added, refused with the store's own reasons (a cycle, a second superseder). */
  link(from: string, to: string, rel: string): Promise<{ id: string; existed: boolean }> {
    return this.write(async ({ store }) => {
      if (!isRelation(rel)) throw reject("invalid_request", "Unknown relation", 400);
      const record = store.get(from);
      if (!record) throw reject("memory_record_unknown", `No record ${from}`, 404);
      if (!store.has(to)) throw reject("memory_record_unknown", `No record ${to}`, 404);
      const links = record.links ?? [];
      if (links.some((link) => link.to === to && link.rel === rel)) return { id: from, existed: true };
      await store.edit(from, { links: [...links, { to, rel }] });
      return { id: from, existed: false };
    });
  }

  unlink(from: string, to: string, rel: string): Promise<{ id: string }> {
    return this.write(async ({ store }) => {
      const record = store.get(from);
      if (!record) throw reject("memory_record_unknown", `No record ${from}`, 404);
      const links = (record.links ?? []).filter((link) => !(link.to === to && link.rel === rel));
      await store.edit(from, { links });
      return { id: from };
    });
  }

  /** The clearly labelled fictional demo set, migrated like a vault (the legacy types through their aliases); records already present by title and type are not added twice. */
  installDemo(): Promise<{ added: number }> {
    return this.write(async ({ store }) => {
      const present = new Set(store.all().map((record) => `${record.type}|${record.title}`));
      const document: VaultDocument = {
        schema: "chrome-agent-browser-vault-v0",
        types: demoHostResources.types.map((type) => ({ id: type.id, display_name: type.display_name, description: type.description ?? null, permission_kind: type.permission_kind, schema: type.schema as unknown as JsonObject, sealed_fields: type.sealed_fields ?? [] })),
        records: demoHostResources.resources
          .filter((resource) => !present.has(`${store.types.resolve(resource.type)?.id ?? resource.type}|${resource.label}`))
          .map((resource) => ({ id: `demo_${resource.id}`, type: resource.type, label: resource.label, value: resource.value as unknown as JsonObject, demo: true, created_at: this.deps.clock().toISOString(), updated_at: this.deps.clock().toISOString() })),
      };
      const report = await migrateVault(store, document, { now: this.deps.clock(), newId: this.deps.newId, idFor: (vaultId) => demoRecordId(vaultId.replace(/^demo_/u, "")) });
      return { added: report.total - report.failed };
    });
  }

  removeDemo(): Promise<{ deleted: string[] }> {
    return this.write(async ({ store }) => {
      const deleted: string[] = [];
      for (const id of store.tidy().demo) if (store.delete(id)) deleted.push(id);
      return { deleted };
    });
  }

  clearAgent(packageId: string): Promise<{ deleted: boolean }> {
    return this.write(async ({ store }) => ({ deleted: store.delete(agentDocumentId(packageId)) }));
  }

  /** Forget memory (D-215): every record, note and usage entry; the hub is recreated. The page forgets its positions itself. */
  forget(): Promise<{ forgotten: true }> {
    return this.run(async () => {
      const opened = await this.unlocked();
      await opened.store.forget();
      await this.deps.storage.clear();
      opened.baseline.clear();
      opened.meta = "";
      await this.persist(opened);
      this.deps.broadcast();
      return { forgotten: true as const };
    });
  }

  async migrationDone(): Promise<{ done: true }> {
    await this.deps.settings.removeVault();
    await this.deps.settings.saveMigrationReport(null);
    this.deps.broadcast();
    return { done: true };
  }

  // -- export and import (§8, D-215) --------------------------------------------------------------
  async export(input: ExportRequest): Promise<{ files: ExportFile[]; sealed_included: boolean }> {
    const opened = input.includeSealed ? await this.unlocked() : await this.opened();
    const only = input.recordIds ? new Set(input.recordIds) : undefined;
    const files = opened.store.export({ runtimeLabel: `chrome-agent-browser core ${CORE_VERSION}`, now: this.deps.clock(), includeSealed: input.includeSealed && !opened.locked, includeAgents: input.includeAgents, ...(only ? { only } : {}) });
    return { files, sealed_included: input.includeSealed && !opened.locked };
  }

  /** The counts and the sheet's list of §3.8, with sealed values never listed (M-59). */
  async importPlan(files: readonly ImportFile[]): Promise<ImportPlanView> {
    const opened = await this.unlocked();
    const report = opened.store.planImport(files);
    const items: ImportItemView[] = report.items.map((item) => {
      const outcome = item.outcome;
      const record = outcome.kind === "refused" ? null : outcome.record;
      const type = record ? opened.store.types.get(record.type) : undefined;
      return {
        path: item.path,
        kind: outcome.kind,
        title: record?.title ?? null,
        type: type?.display_name ?? record?.type ?? null,
        reason: outcome.kind === "refused" ? outcome.reason : null,
        missing: outcome.kind === "incomplete" ? outcome.missing.map((pointer) => ({ pointer, field: fieldName(pointer) })) : [],
        restored: outcome.kind === "add" || outcome.kind === "update" ? outcome.restored.length : 0,
        resolved_links: item.resolved_links,
        dangling_links: item.dangling_links,
        unresolved_text: item.unresolved_text,
        mirror_not_imported: item.mirror_not_imported,
        dropped_keys: item.dropped_keys,
        became_note: item.became_note,
        newer_is_import: outcome.kind === "update" ? outcome.newer_is_import : null,
      };
    });
    return { items, counts: report.counts, usage_entries: report.usage.length };
  }

  importApply(files: readonly ImportFile[], completions: Record<string, Record<string, string>> = {}): Promise<{ written: number; skipped: string[] }> {
    return this.write(async ({ store }) => {
      const report = store.planImport(files);
      const result = await store.applyImport(report, { completions });
      return { written: result.written.length, skipped: result.skipped };
    });
  }

  // -- authorization and the registries (M-16, M-17, M-32, M-34) ------------------------------
  /** The host resource registry for one package's requests; empty while the store is locked (no record can be chosen until it is unlocked). */
  async registry(input: { requested: readonly string[]; packageId: string; selected?: readonly string[] }): Promise<ResourceRegistry> {
    const state = await this.deps.secretsState();
    const opened = state === "unlocked" ? await this.unlocked() : null;
    const store = opened?.store ?? (await MemoryStore.open({ key: generateVaultKey(), snapshot: emptyMemorySnapshot(), now: this.deps.clock }));
    return store.registry({ runtimeVersion: this.deps.version, now: this.deps.clock(), requested: input.requested, packageId: input.packageId, selected: input.selected ?? [] });
  }

  /** The recall candidates per requested type with their signals (M-32), their last use and their provenance, for the recall card; empty while locked. */
  async recall(input: { requested: readonly string[]; packageId: string; selected?: readonly string[] }): Promise<Record<string, RecallFacts>> {
    const state = await this.deps.secretsState();
    const out: Record<string, RecallFacts> = {};
    if (state !== "unlocked") return out;
    const { store } = await this.unlocked();
    for (const requested of new Set(input.requested)) {
      const type = store.types.resolve(requested);
      const candidates = store.recall(requested, input.packageId, input.selected ?? []).map((candidate) => {
        const entries = store.usage.filter((entry) => entry.record_id === candidate.id && entry.use === "read");
        const last = entries.length === 0 ? null : entries.reduce((best, entry) => (entry.at > best.at ? entry : best));
        const record = store.get(candidate.id);
        return { ...candidate, last_use: last === null ? null : { package_id: last.package_id, at: last.at, runs: new Set(entries.map((entry) => entry.run_id)).size }, provenance: record ? provenanceWords(record.source) : "" };
      });
      out[requested] = { candidates, sealed: store.sealedType(requested), display_name: type?.display_name ?? null, sealed_fields: [...(type?.sealed_fields ?? [])] };
    }
    return out;
  }

  /** The type facts the host tool registry binds, or none while locked (D-195: a plan without records needs none). */
  async resourceTypeFacts(requested: readonly string[]): Promise<Array<{ id: string; display_name: string; permission_kind: string; schema_sha256: string; binding: string }>> {
    if ((await this.deps.secretsState()) !== "unlocked") return [];
    return (await this.unlocked()).store.resourceTypeFacts(requested);
  }

  /** The agent tools' schema digests (M-48): the contract files', the same bytes in both runtimes. */
  agentToolDigests(): { read_output_sha256: string; write_input_sha256: string; write_output_sha256: string } {
    const schemas = agentToolSchemas();
    const digest = (text: string) => sha256HexSync(new TextEncoder().encode(text));
    return { read_output_sha256: digest(schemas["host.memory.agent.read"]!.output), write_input_sha256: digest(schemas["host.memory.agent.write"]!.input), write_output_sha256: digest(schemas["host.memory.agent.write"]!.output) };
  }

  // -- the run side (§7, §9) -------------------------------------------------------------------------
  /** The snapshot a run opened with the store is handed (M-36): every record with its sealed values, under the digest key. Needs the unlocked store. */
  async runSnapshot(): Promise<{ key: Uint8Array; snapshot: MemorySnapshot }> {
    const { key } = await this.deps.settings.memoryKeys();
    const { store } = await this.unlocked();
    return { key, snapshot: store.snapshot() };
  }

  /** Whether the record cap is reached (M-47): proposals are then listed but not offered. */
  async full(): Promise<boolean> {
    return (await this.opened()).store.size >= MAX_RECORDS;
  }

  /** The usage entries of a finished run (M-29): memory reads, agent reads and writes, from its audit. Never fails a run; a locked store keeps the entries for the next unlock. */
  addUsage(entries: readonly UsageEntry[]): Promise<void> {
    if (entries.length === 0) return Promise.resolve();
    return this.write(async ({ store }) => {
      store.addUsage(entries.filter((entry) => store.has(entry.record_id)));
    });
  }

  /** M-50: the staged agent body a completed run left, committed under the package's id. */
  commitAgent(input: { package_id: string; package_version: string; run_id: string; name: string; body: string; at: string }): Promise<{ id: string }> {
    return this.write(async ({ store }) => ({ id: (await store.commitAgent(input)).id }));
  }

  /** The review sheet's facts for a run's proposals document (M-41, M-42, M-44; D-223). */
  async review(document: JsonValue, input: { granted: readonly ResourceGrant[]; packageId: string }): Promise<ReviewView> {
    const opened = await this.opened();
    const store = opened.store;
    const grantedIds = new Map(input.granted.map((grant) => [grant.resource_id, store.types.resolve(grant.resource_type)?.id ?? grant.resource_type] as const));
    const targets = new Map<string, Pick<MemoryRecord, "sealed" | "type">>();
    for (const id of grantedIds.keys()) {
      const record = store.get(id);
      if (record) targets.set(id, { sealed: record.sealed, type: record.type });
    }
    let parsed: ProposalsDocument;
    try {
      parsed = await checkProposals(document, { declared: new Set([...grantedIds.values(), ...(Array.isArray((document as JsonObject | null)?.proposals) ? ((document as JsonObject).proposals as JsonObject[]).map((item) => String(item.type)) : [])]), granted: grantedIds, targets, types: store.types, scan: [] });
    } catch (error) {
      if (error instanceof ProposalRefusal) throw reject("memory_proposals_invalid", error.message, 422, { reason: error.reason, index: error.index });
      throw error;
    }
    const titles = store.titles();
    const facts: ReviewView["facts"] = parsed.proposals.map((proposal, index) => {
      const type = store.types.get(proposal.type)!;
      const target = proposal.action === "update" && proposal.target ? store.get(proposal.target) : undefined;
      const head = target ? store.graph.supersededBy.get(target.id) ?? null : null;
      const headRecord = head ? store.get(head) : undefined;
      const sealedRequired = proposal.action === "create" ? type.sealed_fields.filter((pointer) => ((type.schema.required as string[] | undefined) ?? []).includes(pointer.split("/")[1] ?? "")).map((pointer) => ({ pointer, field: fieldName(pointer) })) : [];
      const match = type.identity.length > 0 && !target ? identityMatchOf(store, proposal.fields, type) : null;
      const keptLinks = target ? (target.links ?? []).filter((link) => !(proposal.links ?? []).some((own) => own.to === link.to && own.rel === link.rel)) : [];
      const linkTitles: Record<string, string> = {};
      for (const link of [...(proposal.links ?? []), ...keptLinks]) if (!link.to.startsWith("#")) linkTitles[link.to] = titles.get(link.to) ?? link.to;
      return {
        index,
        type_display_name: type.display_name,
        type_description: type.description,
        new_type: type.declared_by.kind === "package" && !store.customTypeApproved(input.packageId, type.id, sha256HexSync(new TextEncoder().encode(canonicalString(type.schema)))),
        sealed_required: sealedRequired,
        target_title: target?.title ?? null,
        target_replaced_since: head && headRecord ? { head_id: head, head_title: headRecord.title } : null,
        identity_match: match ? { id: match.id, title: match.title, fields: type.identity.map(fieldName) } : null,
        kept: { sealed: [...(target?.sealed ?? [])].map(fieldName), links: keptLinks.map((link) => ({ to: link.to, rel: link.rel, title: titles.get(link.to) ?? link.to })), related: [] },
        link_titles: linkTitles,
      };
    });
    return { document: parsed, facts, memory_full: store.size >= MAX_RECORDS, records: store.size, cap: MAX_RECORDS };
  }

  /** M-42: the decisions of one review applied together; what was written, by index. */
  decide(document: JsonValue, input: { decisions: readonly ReviewDecision[]; granted: readonly ResourceGrant[]; package: { package_id: string; package_version: string; run_id: string }; proposedAt: string }): Promise<ReviewOutcome> {
    return this.write(async ({ store }) => {
      const grantedIds = new Set(input.granted.map((grant) => grant.resource_id));
      const outcome: Acceptance = await store.accept({ proposals: document as unknown as ProposalsDocument, decisions: input.decisions, package: input.package, granted: grantedIds, proposedAt: input.proposedAt });
      return { accepted: outcome.accepted.map((item) => ({ index: item.index, id: item.record.id, title: item.record.title, supersedes: item.supersedes, dropped_links: item.dropped_links })), rejected: outcome.rejected };
    });
  }

  /** A link's words, for the UI's relation chooser. */
  static relationWords(): Record<Relation, { forward: string; inverse: string }> {
    return clone(RELATION_WORDS) as Record<Relation, { forward: string; inverse: string }>;
  }
}

function identityMatchOf(store: MemoryStore, fields: JsonObject, type: MemoryTypeView): MemoryRecord | null {
  return identityMatch({ fields, type: type.id, id: "" }, type, store.all(), store.graph.superseded);
}

export type { MemoryLink, MemoryType, MemoryTypeView, MemoryRecordView, RecallCandidate, ReviewDecision, ExportFile, ImportFile, UsageEntry, MigrationReport, TidyGroups, DerivedNode, GraphEdge, MemoryError };
export { AGENT_TYPE, SELF_ID, SELF_TYPE, MAX_RECORDS };
