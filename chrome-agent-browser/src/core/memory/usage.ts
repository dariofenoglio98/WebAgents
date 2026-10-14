/**
 * The usage log (§5.5, M-29): a bounded list the host keeps beside the records, in canonical
 * order (`at` as an instant, then `record_id` by code point, then `use` in the list's order), so
 * both runtimes write the same `memory-usage.json`. At most 65,536 entries; the oldest are dropped.
 */
import { compareCodePoints, instant, isRecordId, MAX_USAGE_ENTRIES, type UsageEntry, USAGE_USES } from "./model.js";

export function compareUsage(a: UsageEntry, b: UsageEntry): number {
  const time = instant(a.at) - instant(b.at);
  if (time !== 0) return time;
  const id = compareCodePoints(a.record_id, b.record_id);
  if (id !== 0) return id;
  return USAGE_USES.indexOf(a.use) - USAGE_USES.indexOf(b.use);
}

/** The log in canonical order, capped at the newest `MAX_USAGE_ENTRIES`. */
export function canonicalUsage(entries: Iterable<UsageEntry>): UsageEntry[] {
  const sorted = [...entries].sort(compareUsage);
  return sorted.length > MAX_USAGE_ENTRIES ? sorted.slice(sorted.length - MAX_USAGE_ENTRIES) : sorted;
}

export function isUsageEntry(value: unknown): value is UsageEntry {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const entry = value as Record<string, unknown>;
  return isRecordId(entry.record_id) && (USAGE_USES as readonly unknown[]).includes(entry.use) && typeof entry.package_id === "string" && typeof entry.package_version === "string" && typeof entry.run_id === "string" && typeof entry.at === "string" && Number.isFinite(instant(entry.at)) && Object.keys(entry).length === 6;
}

/** `memory-usage.json`'s text: the canonical list, indented by two spaces, with a final newline. */
export function usageJson(entries: Iterable<UsageEntry>): string {
  return `${JSON.stringify(canonicalUsage(entries).map((entry) => ({ record_id: entry.record_id, use: entry.use, package_id: entry.package_id, package_version: entry.package_version, run_id: entry.run_id, at: entry.at })), null, 2)}\n`;
}

/** "Where used" on the record card: per package, the runs, the count and the last use. */
export function usageByPackage(entries: readonly UsageEntry[], recordId: string): Array<{ package_id: string; package_version: string; runs: number; last: string; last_run_id: string }> {
  const groups = new Map<string, { package_version: string; runs: Set<string>; last: string; last_run_id: string }>();
  for (const entry of entries) {
    if (entry.record_id !== recordId) continue;
    const group = groups.get(entry.package_id) ?? { package_version: entry.package_version, runs: new Set<string>(), last: entry.at, last_run_id: entry.run_id };
    group.runs.add(entry.run_id);
    if (instant(entry.at) >= instant(group.last)) {
      group.last = entry.at;
      group.last_run_id = entry.run_id;
      group.package_version = entry.package_version;
    }
    groups.set(entry.package_id, group);
  }
  return [...groups.entries()].map(([package_id, group]) => ({ package_id, package_version: group.package_version, runs: group.runs.size, last: group.last, last_run_id: group.last_run_id })).sort((a, b) => instant(b.last) - instant(a.last));
}
