/**
 * Recall ranking (§6.3, M-32, D-211; the weights are T19's D-220): a pure function of the
 * store, the usage log, the plan under preparation and the recall instant, so both runtimes and
 * a test agree on the order.
 */
import { type GraphIndex, linked, linksToSelf } from "./graph.js";
import { dateOf, instant, type MemoryRecord, type UsageEntry } from "./model.js";
import type { TypeRegistry } from "./types.js";

/** D-220: the weights of D-211, kept; a retune happens in both runtimes together. */
export const RECALL_WEIGHTS = Object.freeze({ about_self: 8, same_package: 6, linked_to_selected: 4, recently_read: 2, expired: -4 });
export const SAME_PACKAGE_DAYS = 365;
export const RECENT_READ_DAYS = 30;

export interface RecallSignals {
  about_self: boolean;
  /** The last `read` or `accepted` by the requesting package within 365 days, as a date, or null. */
  same_package: string | null;
  /** The selected ids this candidate is linked to, in either direction. */
  linked_to: string[];
  /** The last `read` by any package within 30 days, or null. */
  recently_read: string | null;
  expired: boolean;
  /** The latest usage instant for the record, or null. */
  last_used: string | null;
}

export interface RecallCandidate {
  id: string;
  title: string;
  type: string;
  score: number;
  signals: RecallSignals;
  updated: string;
  demo: boolean;
}

export interface RecallInput {
  /** The store's records, `scope: user`, every sealed field readable (the caller filters unreadable ones out). */
  records: Iterable<MemoryRecord>;
  index: Pick<GraphIndex, "out" | "in" | "superseded">;
  usage: readonly UsageEntry[];
  types: TypeRegistry;
  /** The requested type: a type id or a legacy id. */
  resourceType: string;
  /** The requesting package. */
  packageId: string;
  /** The record ids already selected in this plan. */
  selected: readonly string[];
  /** The recall instant (M-32): the host's clock when it computes the candidates. */
  now: Date;
}

const DAY_MS = 24 * 60 * 60 * 1000;

export function scoreOf(signals: RecallSignals): number {
  return (signals.about_self ? RECALL_WEIGHTS.about_self : 0) + (signals.same_package !== null ? RECALL_WEIGHTS.same_package : 0) + (signals.linked_to.length > 0 ? RECALL_WEIGHTS.linked_to_selected : 0) + (signals.recently_read !== null ? RECALL_WEIGHTS.recently_read : 0) + (signals.expired ? RECALL_WEIGHTS.expired : 0);
}

/** The candidates of type T in recall order (M-32): heads only, `scope: user`. */
export function rankCandidates(input: RecallInput): RecallCandidate[] {
  const type = input.types.resolve(input.resourceType);
  if (type === undefined) return [];
  const nowMs = input.now.getTime();
  const today = dateOf(input.now);
  const lastByRecord = new Map<string, string>();
  const samePackage = new Map<string, string>();
  const recentRead = new Map<string, string>();
  for (const entry of input.usage) {
    const at = instant(entry.at);
    if (!Number.isFinite(at)) continue;
    const previous = lastByRecord.get(entry.record_id);
    if (previous === undefined || instant(previous) < at) lastByRecord.set(entry.record_id, entry.at);
    if ((entry.use === "read" || entry.use === "accepted") && entry.package_id === input.packageId && nowMs - at <= SAME_PACKAGE_DAYS * DAY_MS && nowMs - at >= 0) {
      const held = samePackage.get(entry.record_id);
      if (held === undefined || instant(held) < at) samePackage.set(entry.record_id, entry.at);
    }
    if (entry.use === "read" && nowMs - at <= RECENT_READ_DAYS * DAY_MS && nowMs - at >= 0) {
      const held = recentRead.get(entry.record_id);
      if (held === undefined || instant(held) < at) recentRead.set(entry.record_id, entry.at);
    }
  }
  const candidates: RecallCandidate[] = [];
  for (const record of input.records) {
    if (record.type !== type.id || record.scope !== "user" || input.index.superseded.has(record.id)) continue;
    const signals: RecallSignals = {
      about_self: linksToSelf(record),
      same_package: samePackage.get(record.id) ?? null,
      linked_to: input.selected.filter((id) => id !== record.id && linked(input.index, record.id, id)),
      recently_read: recentRead.get(record.id) ?? null,
      expired: record.valid_until !== undefined && record.valid_until < today,
      last_used: lastByRecord.get(record.id) ?? null,
    };
    candidates.push({ id: record.id, title: record.title, type: record.type, score: scoreOf(signals), signals, updated: record.updated, demo: record.demo === true });
  }
  return candidates.sort(compareCandidates);
}

/** Score descending, then the latest use descending (none last), then `updated` descending, then id ascending. */
export function compareCandidates(a: RecallCandidate, b: RecallCandidate): number {
  if (a.score !== b.score) return b.score - a.score;
  const lastA = a.signals.last_used === null ? null : instant(a.signals.last_used);
  const lastB = b.signals.last_used === null ? null : instant(b.signals.last_used);
  if (lastA !== lastB) {
    if (lastA === null) return 1;
    if (lastB === null) return -1;
    return lastB - lastA;
  }
  const updated = instant(b.updated) - instant(a.updated);
  if (updated !== 0) return updated;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}
