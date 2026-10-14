/**
 * Words for memory facts (design `memory-ui.md` §1.4, §7): provenance in one line, relation
 * words, dates. Pure text; shared by the service worker's views and the pages.
 */
import { RELATION_WORDS, type MemorySource, type Relation } from "./model.js";

export function dayWords(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

/** Provenance in one line: who wrote a record and when, never a value. */
export function provenanceWords(source: MemorySource): string {
  switch (source.kind) {
    case "person":
      return "Typed by you";
    case "package":
      return `Added by ${source.package_id} ${source.package_version} on ${dayWords(source.accepted)} (run ${source.run_id.slice(0, 8)})`;
    case "agent":
      return `Written by ${source.package_id} ${source.package_version} (run ${source.run_id.slice(0, 8)})`;
    case "import":
      return `Imported from ${source.from} on ${dayWords(source.imported)}`;
    case "migration":
      return `Migrated from Your data (${source.from_type}) on ${dayWords(source.migrated)}`;
    default:
      return "";
  }
}

/** "3 days ago on WebAir", "never used by a package". */
export function lastUseWords(lastUse: { package_id: string; at: string } | null, now: Date = new Date()): string {
  if (lastUse === null) return "never used by a package";
  const days = Math.max(0, Math.floor((now.getTime() - new Date(lastUse.at).getTime()) / 86_400_000));
  const when = days === 0 ? "today" : days === 1 ? "yesterday" : `${days} days ago`;
  return `last used ${when} on ${lastUse.package_id}`;
}

export function relationWords(rel: Relation): { forward: string; inverse: string } {
  return RELATION_WORDS[rel];
}
