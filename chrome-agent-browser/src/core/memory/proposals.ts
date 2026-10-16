/**
 * Proposals (§7.2): the document a run exports (M-39), the host checks on completion in order
 * (M-40, proposal by proposal from step 2 to 6), and acceptance (M-42) with identity replacement
 * (M-44). The checks run in the execution host over the run's facts; acceptance runs in the
 * store with the person's decisions. Nothing here writes: `store.ts` applies what `acceptance`
 * returns.
 */
import type { JsonObject, JsonValue } from "../json.js";
import { failuresForSchema, memorySchemaFailure } from "../schema.js";
import { bodyLinkIds, normalizeBodyLinks, restoreViewLinks, viewBody } from "./links.js";
import { canonicalLinks, type MemoryLink, type MemoryRecord, normalizeBody, pointerGet, type Relation, RESERVED_TYPES, SELF_ID, stamp } from "./model.js";
import { findSealed, type ScanSet } from "./scan.js";
import type { MemoryTypeView, TypeRegistry } from "./types.js";
import { identityValues, sameIdentity, sealedPointers } from "./validate.js";

export const PROPOSALS_SCHEMA = "memory.v0 proposals";
export const PROPOSALS_EXPORT_FORMAT = "memory.proposal";
export const PROPOSALS_PATH = "proposals.json";

export interface Proposal {
  action: "create" | "update";
  type: string;
  target?: string;
  title: string;
  fields: JsonObject;
  body?: string;
  tags?: string[];
  links?: Array<{ to: string; rel: Exclude<Relation, "supersedes"> }>;
  valid_until?: string;
  rationale: string;
}

export interface ProposalsDocument {
  schema: typeof PROPOSALS_SCHEMA;
  proposals: Proposal[];
}

/** A refusal with the code and reason the spec names (M-40), and the proposal index when one applies. */
export class ProposalRefusal extends Error {
  constructor(
    readonly code: "schema_validation" | "permission_denied",
    readonly reason: string | null,
    message: string,
    readonly index: number | null = null,
  ) {
    super(message);
    this.name = "ProposalRefusal";
  }
}

/** What M-40 needs of the run: the declared types, the grants by id with their types, the target records, the scan set. */
export interface ProposalCheckInput {
  /** The `memory.write` permission's resources, resolved to type ids (custom ids qualified). */
  declared: ReadonlySet<string>;
  /** Record id → type id of every record this run was granted (M-12). */
  granted: ReadonlyMap<string, string>;
  /** The granted records by id, for an update target's own `sealed` additions (step 3). */
  targets: ReadonlyMap<string, Pick<MemoryRecord, "sealed" | "type">>;
  types: TypeRegistry;
  scan: ScanSet;
  /** Custom local id → qualified id (§4.4, M-18): a package names its own custom type by its local id in `proposals.json` (the schema admits no other form); the host resolves it. */
  aliases?: ReadonlyMap<string, string>;
}

/** A proposal's `type` as the host knows it: a well-known id as written, a custom local id through the package's aliases. */
export function resolveProposalType(type: string, aliases: ReadonlyMap<string, string> | undefined): string {
  return aliases?.get(type) ?? type;
}

/** M-40 step 4: the type schema with the sealed pointers removed from `required`. */
export function sealedFreeSchema(type: Pick<MemoryTypeView, "schema" | "sealed_fields">, extra: readonly string[] = []): JsonObject {
  const schema = JSON.parse(JSON.stringify(type.schema)) as JsonObject;
  // At any depth: a nested pointer (a person's addition, M-24) is followed through `properties`, an array index through `items`.
  for (const pointer of [...type.sealed_fields, ...extra]) {
    const tokens = pointer.split("/").slice(1).map((token) => token.replace(/~1/gu, "/").replace(/~0/gu, "~"));
    let node: JsonValue | undefined = schema;
    for (const token of tokens.slice(0, -1)) {
      if (typeof node !== "object" || node === null || Array.isArray(node)) break;
      const properties: JsonValue | undefined = node.properties;
      let child: JsonValue | undefined = typeof properties === "object" && properties !== null && !Array.isArray(properties) ? properties[token] : undefined;
      if (child === undefined && /^\d+$/u.test(token)) child = node.items;
      node = child;
    }
    const last = tokens[tokens.length - 1];
    if (last !== undefined && typeof node === "object" && node !== null && !Array.isArray(node) && Array.isArray(node.required)) {
      node.required = node.required.filter((name) => name !== last);
    }
  }
  return schema;
}

/** M-40 in order; throws `ProposalRefusal` on the first hit. Returns the parsed document. */
export async function checkProposals(document: JsonValue, input: ProposalCheckInput): Promise<ProposalsDocument> {
  const schemaProblem = await memorySchemaFailure(document, "memory-proposals.schema");
  if (schemaProblem !== null) throw new ProposalRefusal("schema_validation", null, `proposals.json does not match memory-proposals.schema.json: ${schemaProblem}`);
  const parsed = document as unknown as ProposalsDocument;
  for (const [index, proposal] of parsed.proposals.entries()) {
    const where = `proposal ${index}`;
    const typeId = resolveProposalType(proposal.type, input.aliases);
    if (!input.declared.has(typeId) || RESERVED_TYPES.has(typeId)) {
      throw new ProposalRefusal("permission_denied", "memory_proposal_type_undeclared", `${where}: type ${proposal.type} is not one the package may propose`, index);
    }
    const type = input.types.get(typeId);
    if (type === undefined) throw new ProposalRefusal("permission_denied", "memory_proposal_type_undeclared", `${where}: type ${proposal.type} is unknown to this host`, index);
    const targetId = proposal.target ?? "";
    const target = input.targets.get(targetId);
    const targetGranted = input.granted.get(targetId) === typeId;
    const extra = target !== undefined && targetGranted ? [...(target.sealed ?? [])] : [];
    for (const pointer of [...type.sealed_fields, ...extra]) {
      if (pointerGet(proposal.fields, pointer) !== undefined) throw new ProposalRefusal("schema_validation", "memory_proposal_sealed_field", `${where}: carries the sealed field ${pointer}`, index);
    }
    const failures = await failuresForSchema(sealedFreeSchema(type, extra), proposal.fields, `${where} fields`);
    if (failures.length > 0) {
      const first = failures[0]!;
      throw new ProposalRefusal("schema_validation", null, `${where}: the fields do not match the ${type.display_name} schema at ${first.instancePath.join("/") || "<root>"} (rule: ${first.keyword})`, index);
    }
    if (proposal.action === "update" && input.granted.get(proposal.target!) !== typeId) {
      throw new ProposalRefusal("permission_denied", "memory_proposal_target_not_granted", `${where}: target ${proposal.target} is not a granted record of type ${proposal.type}`, index);
    }
    const bodyLinks = bodyLinkIds(proposal.body ?? "").map((to) => ({ to, rel: "related" as const }));
    for (const link of [...(proposal.links ?? []), ...bodyLinks]) {
      const to = link.to;
      if (to.startsWith("#")) {
        const sibling = Number(to.slice(1));
        if (sibling === index || sibling >= parsed.proposals.length) throw new ProposalRefusal("schema_validation", null, `${where}: link ${to} names no other proposal`, index);
      } else if (to !== SELF_ID && !input.granted.has(to)) {
        throw new ProposalRefusal("permission_denied", "memory_proposal_link_not_granted", `${where}: links to ${to}, which this run was not granted`, index);
      }
    }
  }
  const hit = findSealed(document, input.scan);
  if (hit === "incomplete") throw new ProposalRefusal("permission_denied", "sealed_value_in_proposal", "proposals.json holds more strings than the scan reads, so it is refused unread");
  if (hit !== null) throw new ProposalRefusal("permission_denied", "sealed_value_in_proposal", `proposals.json carries a sealed value of ${hit.record_id} at ${hit.pointer}`);
  return parsed;
}

// -- acceptance (M-42, M-44) -------------------------------------------------------------------
export interface ReviewDecision {
  index: number;
  decision: "accept" | "reject";
  /** Edits before acceptance: the title, the unsealed fields, the body, the tags, the links; a sealed value typed here (M-42). */
  edits?: { title?: string; fields?: JsonObject; body?: string; tags?: string[]; links?: MemoryLink[]; sealed_values?: Record<string, string> };
  /** For an `update` whose target was replaced since: replace the chain's head, or keep as a new record. */
  replaced_since?: "head" | "keep_new";
  /** M-44: replace the identity match (default), or keep both. */
  identity?: "replace" | "keep_both";
}

export interface AcceptanceContext {
  proposals: ProposalsDocument;
  decisions: readonly ReviewDecision[];
  package: { package_id: string; package_version: string; run_id: string };
  /** The ids this run was granted (M-12): the view's grants. */
  granted: ReadonlySet<string>;
  /** The store's records by id (heads and superseded alike). */
  records: ReadonlyMap<string, MemoryRecord>;
  /** The head of each superseded record, from the graph index. */
  headOf: (id: string) => string;
  types: TypeRegistry;
  /** Record id → title, for M-3's resolution. */
  titles: ReadonlyMap<string, string>;
  /** Fresh record ids, one per accepted proposal in index order. */
  newId: () => string;
  now: Date;
  /** The instant of the run's `memory.proposed` event (M-29). */
  proposedAt: string;
  /** Custom local id → qualified id, as at the check (§4.4). */
  aliases?: ReadonlyMap<string, string>;
}

export interface AcceptedRecord {
  index: number;
  record: MemoryRecord;
  /** The record it supersedes, when an update or an identity replacement. */
  supersedes: string | null;
  /** What the sheet lists under "Kept from the record it replaces". */
  kept: { sealed: string[]; links: MemoryLink[]; related: string[] };
  /** Links to proposals the person rejected, left out with that note. */
  dropped_links: string[];
}

export interface Acceptance {
  accepted: AcceptedRecord[];
  rejected: number[];
}

/** M-44: the head record of the same type whose identity values equal the candidate's, newest first; or null. */
export function identityMatch(candidate: Pick<MemoryRecord, "fields" | "type" | "id">, type: Pick<MemoryTypeView, "identity">, records: Iterable<MemoryRecord>, superseded: ReadonlySet<string>): MemoryRecord | null {
  if (type.identity.length === 0) return null;
  const values = identityValues(candidate, type.identity);
  if (values.every((value) => value === null)) return null;
  const matches = [...records].filter((record) => record.id !== candidate.id && record.type === candidate.type && record.scope === "user" && !superseded.has(record.id) && sameIdentity(identityValues(record, type.identity), values));
  matches.sort((a, b) => (a.updated < b.updated ? 1 : a.updated > b.updated ? -1 : 0));
  return matches[0] ?? null;
}

/**
 * M-42: the records one review writes, computed together after the last decision: every
 * accepted proposal receives its id first, then links are resolved (`#m` to an accepted sibling,
 * else left out with a note), an update carries over what the run never saw, and the body's plain
 * wikilinks resolve only against `self`, the granted records and the accepted siblings.
 */
export function acceptance(context: AcceptanceContext): Acceptance {
  const decisions = new Map(context.decisions.map((decision) => [decision.index, decision]));
  const acceptedIndexes = context.proposals.proposals.map((_, index) => index).filter((index) => decisions.get(index)?.decision === "accept");
  const rejected = context.proposals.proposals.map((_, index) => index).filter((index) => decisions.get(index)?.decision !== "accept");
  const ids = new Map<number, string>();
  for (const index of acceptedIndexes) ids.set(index, context.newId());
  const now = stamp(context.now);
  const superseded = new Set<string>();
  for (const record of context.records.values()) for (const link of record.links ?? []) if (link.rel === "supersedes") superseded.add(link.to);
  const allowedTitles = new Map<string, string>();
  for (const [id, title] of context.titles) if (id === SELF_ID || context.granted.has(id)) allowedTitles.set(id, title);
  const accepted: AcceptedRecord[] = [];
  for (const index of acceptedIndexes) {
    const proposal = context.proposals.proposals[index]!;
    const decision = decisions.get(index)!;
    const type = context.types.get(resolveProposalType(proposal.type, context.aliases))!;
    const edits = decision.edits ?? {};
    const id = ids.get(index)!;
    const title = edits.title ?? proposal.title;
    const fields = JSON.parse(JSON.stringify(edits.fields ?? proposal.fields)) as JsonObject;
    const dropped: string[] = [];
    const resolvedLinks: MemoryLink[] = [];
    for (const link of edits.links ?? proposal.links ?? []) {
      if (link.to.startsWith("#")) {
        const sibling = Number(link.to.slice(1));
        const siblingId = ids.get(sibling);
        if (siblingId === undefined) {
          dropped.push(link.to);
          continue;
        }
        resolvedLinks.push({ to: siblingId, rel: link.rel });
      } else resolvedLinks.push({ to: link.to, rel: link.rel });
    }
    const kept: AcceptedRecord["kept"] = { sealed: [], links: [], related: [] };
    let body = normalizeBody(edits.body ?? proposal.body ?? "");
    let supersedes: string | null = null;
    let sealed = [...type.sealed_fields];
    let demo = false;
    let validUntil = proposal.valid_until;
    if (proposal.action === "update") {
      let target = context.records.get(proposal.target!) ?? null;
      if (target !== null && superseded.has(target.id)) {
        // Replaced since the plan was made (M-42): the chain's head, or a new record replacing nothing.
        if (decision.replaced_since === "keep_new") target = null;
        else target = context.records.get(context.headOf(target.id)) ?? null;
      }
      if (target !== null) {
        const { occurrences } = viewBody(target.body, context.granted);
        const restored = restoreViewLinks(body, occurrences);
        body = restored.body;
        kept.related = restored.carried;
        for (const to of restored.carried) resolvedLinks.push({ to, rel: "related" });
        const own = sealedPointers(target, type);
        sealed = own;
        for (const pointer of own) {
          if (pointerGet(fields, pointer) !== undefined) continue;
          const typed = edits.sealed_values?.[pointer];
          const value = typed ?? pointerGet(target.fields, pointer);
          if (value !== undefined) {
            setPointer(fields, pointer, value as JsonValue);
            if (typed === undefined) kept.sealed.push(pointer);
          }
        }
        for (const link of target.links ?? []) {
          if (link.rel === "supersedes") continue;
          if (resolvedLinks.some((item) => item.to === link.to && item.rel === link.rel)) continue;
          resolvedLinks.push({ to: link.to, rel: link.rel });
          kept.links.push({ to: link.to, rel: link.rel });
        }
        demo = target.demo === true;
        validUntil = proposal.valid_until ?? target.valid_until;
        supersedes = target.id;
        resolvedLinks.push({ to: target.id, rel: "supersedes" });
      }
    } else {
      for (const pointer of type.sealed_fields) {
        const typed = edits.sealed_values?.[pointer];
        if (typed !== undefined) setPointer(fields, pointer, typed);
      }
    }
    // The siblings accepted in the same review are in the resolution set (M-42).
    const titlesForBody = new Map(allowedTitles);
    for (const [siblingIndex, siblingId] of ids) {
      const sibling = context.proposals.proposals[siblingIndex]!;
      titlesForBody.set(siblingId, decisions.get(siblingIndex)?.edits?.title ?? sibling.title);
    }
    body = normalizeBodyLinks(body, titlesForBody);
    const links = canonicalLinks([...(proposal.action === "create" ? type.default_links : []), ...resolvedLinks].filter((link) => link.to !== id));
    const record: MemoryRecord = {
      id,
      type: type.id,
      title,
      scope: "user",
      created: now,
      updated: now,
      source: { kind: "package", package_id: context.package.package_id, package_version: context.package.package_version, run_id: context.package.run_id, proposal: index, accepted: now },
      fields,
      body,
    };
    if (validUntil !== undefined) record.valid_until = validUntil;
    if (sealed.length > 0) record.sealed = sealed;
    if (links.length > 0) record.links = links;
    const tags = edits.tags ?? proposal.tags ?? [];
    if (tags.length > 0) record.tags = [...tags];
    if (demo) record.demo = true;
    // M-44: a create that matches a head of the same type by identity replaces it unless the person keeps both.
    if (proposal.action === "create" && decision.identity !== "keep_both") {
      const match = identityMatch(record, type, context.records.values(), superseded);
      if (match !== null) {
        supersedes = match.id;
        record.links = canonicalLinks([...(record.links ?? []), { to: match.id, rel: "supersedes" }]);
      }
    }
    accepted.push({ index, record, supersedes, kept, dropped_links: dropped });
  }
  return { accepted, rejected };
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
