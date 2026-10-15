/**
 * Body wikilinks (M-3), the record view's rendering of links the run was not granted (M-15)
 * and its positional reversal at acceptance (M-42). Pure functions over text; the regular
 * expression is the one the reference uses, so the two runtimes find the same occurrences.
 */
import { aliasOf, BODY_LINK, MISSING_RECORD_TEXT, RECORD_ID, stemKey, titleIndex } from "./model.js";

/** Every match of a body wikilink, with its backslashes, target and alias. */
export interface BodyLinkMatch {
  whole: string;
  escapes: string;
  target: string;
  alias: string | null;
  index: number;
}

export function bodyLinks(body: string): BodyLinkMatch[] {
  const out: BodyLinkMatch[] = [];
  for (const match of body.matchAll(BODY_LINK)) out.push({ whole: match[0], escapes: match[1]!, target: match[2]!, alias: match[3] ?? null, index: match.index! });
  return out;
}

function rewriteLinks(body: string, rewrite: (match: BodyLinkMatch) => string): string {
  return body.replace(BODY_LINK, (whole, escapes: string, target: string, alias: string | undefined, index: number) => rewrite({ whole, escapes, target, alias: alias ?? null, index }));
}

/**
 * M-3 when a body is written from an edit or an accepted proposal: a bare `[[<id>]]` whose record
 * exists gains the title as its alias; a plain link whose text is the title of exactly one record
 * of `titles` becomes `[[<id>|<text>]]` (the alias kept when given); anything else (an escaped
 * link, a dangling id, text that names no record or several) is left as it is.
 */
export function normalizeBodyLinks(body: string, titles: ReadonlyMap<string, string>): string {
  const byTitle = titleIndex(titles);
  return rewriteLinks(body, ({ whole, escapes, target, alias }) => {
    if (escapes) return whole;
    if (RECORD_ID.test(target)) {
      if (alias === null && titles.has(target)) return `[[${target}|${aliasOf(titles.get(target)!)}]]`;
      return whole;
    }
    const recordId = byTitle.get(stemKey(target));
    if (recordId === undefined) return whole;
    return `[[${recordId}|${alias ?? target}]]`;
  });
}

/** The record ids a body links to (M-3): its unescaped wikilinks in id form, in order. */
export function bodyLinkIds(body: string): string[] {
  return bodyLinks(body)
    .filter((match) => !match.escapes && RECORD_ID.test(match.target))
    .map((match) => match.target);
}

/** The titles and ids a body's plain wikilinks name without resolving to a record (dangling text, M-27). */
export function danglingBodyText(body: string, known: ReadonlySet<string>, titles: ReadonlyMap<string, string>): string[] {
  const byTitle = titleIndex(titles);
  const out: string[] = [];
  for (const match of bodyLinks(body)) {
    if (match.escapes) continue;
    if (RECORD_ID.test(match.target)) {
      if (!known.has(match.target)) out.push(match.target);
    } else if (!byTitle.has(stemKey(match.target))) out.push(match.target);
  }
  return out;
}

/** One link occurrence of a view body (M-15): the text the run sees, the stored text it stands for, the hidden target or null. */
export interface Occurrence {
  rendered: string;
  stored: string;
  hidden: string | null;
}

/**
 * M-15: the body a `memory.read` tool hands the run, and its link occurrences. An unescaped id
 * wikilink whose target is not granted is hidden: `[[<id>|<alias>]]` → `[[<alias>]]`, or escaped
 * when the alias is itself a well-formed record id; a bare dangling `[[<id>]]` →
 * `[[missing record]]`. Every other wikilink is as stored.
 */
export function viewBody(body: string, granted: ReadonlySet<string>): { body: string; occurrences: Occurrence[] } {
  const occurrences: Occurrence[] = [];
  const rendered = rewriteLinks(body, ({ whole, escapes, target, alias }) => {
    if (escapes || !RECORD_ID.test(target) || granted.has(target)) {
      occurrences.push({ rendered: whole, stored: whole, hidden: null });
      return whole;
    }
    let shown: string;
    if (alias === null) shown = MISSING_RECORD_TEXT;
    else if (RECORD_ID.test(alias)) shown = `\\[[${alias}]]`;
    else shown = `[[${alias}]]`;
    occurrences.push({ rendered: shown, stored: whole, hidden: target });
    return shown;
  });
  return { body: rendered, occurrences };
}

/**
 * M-42 (`update`): the inverse of M-15 by position. The n-th wikilink of the proposal's body with
 * a given text (backslashes included) is the n-th link occurrence of the view with that text and
 * becomes what that occurrence was in the stored body; a wikilink beyond the view's occurrences
 * of its text is left as it is. Returns the body and the hidden targets the reversal placed
 * nowhere, which acceptance keeps as `related` links.
 */
export function restoreViewLinks(body: string, occurrences: readonly Occurrence[]): { body: string; carried: string[] } {
  const positions = new Map<string, number[]>();
  occurrences.forEach((occurrence, position) => positions.set(occurrence.rendered, [...(positions.get(occurrence.rendered) ?? []), position]));
  const seen = new Map<string, number>();
  const restored = new Set<number>();
  const restoredBody = rewriteLinks(body, ({ whole }) => {
    const count = seen.get(whole) ?? 0;
    seen.set(whole, count + 1);
    const candidates = positions.get(whole) ?? [];
    if (count >= candidates.length) return whole;
    restored.add(candidates[count]!);
    return occurrences[candidates[count]!]!.stored;
  });
  const placed = new Set([...restored].map((position) => occurrences[position]!.hidden));
  const carried = new Set<string>();
  for (const occurrence of occurrences) if (occurrence.hidden !== null && !placed.has(occurrence.hidden)) carried.add(occurrence.hidden);
  return { body: restoredBody, carried: [...carried].sort() };
}
