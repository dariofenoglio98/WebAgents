/**
 * The one-time migration of the vault (`chrome-agent-browser-vault-v0`) into memory (§11.3,
 * M-66; D-217, D-221): the three vault types map to `travel.profile`, `person.identity` and
 * `payment.card` through the taxonomy's legacy projections; every other vault type becomes a
 * person-declared custom type with the same schema and sealed fields. The report lists every
 * record with its outcome; nothing is deleted here (the shell keeps the vault document until the
 * person confirms the report).
 */
import type { JsonObject, JsonValue } from "../json.js";
import type { VaultDocument } from "../vault.js";
import { type MemoryRecord, pointerSet, stamp, WELL_KNOWN_TYPE_ID } from "./model.js";
import type { MemoryType } from "./types.js";
import { type MemoryStore, newRecordId } from "./store.js";

export const MIGRATION_SCHEMA = "chrome-agent-browser-memory-migration-v0";

export interface MigrationItem {
  vault_id: string;
  vault_type: string;
  label: string;
  outcome: { kind: "migrated"; id: string; type: string; title: string } | { kind: "failed"; reason: string };
}

export interface MigrationReport {
  schema: typeof MIGRATION_SCHEMA;
  migrated_at: string;
  counts: Record<string, number>;
  mappings: Array<{ from_type: string; to_type: string; kind: "legacy" | "custom" }>;
  items: MigrationItem[];
  failed: number;
  total: number;
}

const DEMO_PREFIX = /^demo_/u;

/** M-66: migrate every vault record once; returns the report. The store is written in place (the caller persists it). */
export async function migrateVault(store: MemoryStore, vault: VaultDocument, options: { now: Date; newId?: () => string }): Promise<MigrationReport> {
  const migrated = stamp(options.now);
  const mappings: MigrationReport["mappings"] = [];
  const items: MigrationItem[] = [];
  const counts: Record<string, number> = {};
  for (const vaultType of vault.types) {
    const legacy = store.types.legacyOf(vaultType.id);
    if (legacy !== undefined) {
      mappings.push({ from_type: vaultType.id, to_type: legacy.type.id, kind: "legacy" });
      continue;
    }
    if (store.types.has(vaultType.id)) {
      mappings.push({ from_type: vaultType.id, to_type: vaultType.id, kind: "custom" });
      continue;
    }
    const localId = WELL_KNOWN_TYPE_ID.test(vaultType.id) ? vaultType.id : vaultType.id.toLowerCase().replace(/[^a-z0-9_.]/gu, "_").replace(/^[^a-z]+/u, "t_");
    const custom: MemoryType = {
      id: localId,
      display_name: vaultType.display_name,
      description: vaultType.description,
      schema: JSON.parse(JSON.stringify(vaultType.schema)) as JsonObject,
      sealed_fields: [...vaultType.sealed_fields],
      identity: [],
      default_links: [],
      display: { title_from: null, summary: Object.keys((vaultType.schema.properties as JsonObject | undefined) ?? {}).slice(0, 4).map((name) => `/${name}`) },
      declared_by: { kind: "person" },
    };
    await store.putType(custom);
    mappings.push({ from_type: vaultType.id, to_type: localId, kind: "custom" });
  }
  for (const record of vault.records) {
    const mapping = mappings.find((item) => item.from_type === record.type);
    const item: MigrationItem = { vault_id: record.id, vault_type: record.type, label: record.label, outcome: { kind: "failed", reason: "the vault type is unknown" } };
    items.push(item);
    if (!mapping) continue;
    try {
      const legacy = store.types.legacyOf(record.type);
      const type = store.types.get(mapping.to_type)!;
      let fields: JsonObject;
      if (legacy !== undefined) {
        fields = {};
        for (const [legacyPointer, recordPointer] of Object.entries(legacy.alias.projection)) {
          const value = pointerGetLocal(record.value, legacyPointer);
          if (value !== undefined) pointerSet(fields, recordPointer, value);
        }
      } else fields = JSON.parse(JSON.stringify(record.value)) as JsonObject;
      const draft: MemoryRecord = {
        id: (options.newId ?? newRecordId)(),
        type: type.id,
        title: record.label,
        scope: "user",
        created: record.created_at,
        updated: record.updated_at,
        source: { kind: "migration", from_type: record.type, migrated },
        fields,
        body: "",
      };
      if (type.sealed_fields.length > 0) draft.sealed = [...type.sealed_fields];
      if (type.default_links.length > 0) draft.links = [...type.default_links];
      if (record.demo || DEMO_PREFIX.test(record.id)) draft.demo = true;
      // A complete record with the vault's own facts (`created`, `updated`, the migration provenance; M-66).
      const kept = await store.put(draft);
      item.outcome = { kind: "migrated", id: kept.id, type: kept.type, title: kept.title };
      counts[type.id] = (counts[type.id] ?? 0) + 1;
    } catch (error) {
      item.outcome = { kind: "failed", reason: error instanceof Error ? error.message : "could not be migrated" };
    }
  }
  return { schema: MIGRATION_SCHEMA, migrated_at: migrated, counts, mappings, items, failed: items.filter((item) => item.outcome.kind === "failed").length, total: items.length };
}

function pointerGetLocal(value: JsonValue, pointer: string): JsonValue | undefined {
  let current: JsonValue | undefined = value;
  for (const part of pointer.split("/").slice(1)) {
    if (typeof current !== "object" || current === null || Array.isArray(current) || !Object.hasOwn(current, part)) return undefined;
    current = current[part];
  }
  return current;
}
