/**
 * A signed static agent index (`spec/extensions/agent-index-v0.md`) and the resolver over it.
 *
 * The index is a document a publisher signs and serves; the person adds it by URL and pins its
 * key, and only then is it fetched (never in the background otherwise). `readAgentIndex` applies
 * the rules beyond the schema (§4) to the verified content; `StaticIndexResolver` answers queries
 * from it in the index's own order. Nothing an index says is authority: its entries say where a
 * package is said to be and what the publisher of the index says about it, and the package's
 * own bytes are verified when a person opens one.
 */
import { CoreError } from "../errors.js";
import type { JsonObject } from "../json.js";
import { validatePackageUrl } from "../policy.js";
import { type VerifiedDocument } from "../signed-document.js";
import { matches, type AgentCandidate, type ResolveNote, type ResolveQuery, type ResolveResult, type Resolver } from "./types.js";

export interface AgentIndexEntry {
  package_id: string;
  name: string;
  version: string;
  description: string;
  publisher: { id: string; name: string };
  package_url: string;
  digest: string | null;
  archive_sha256: string | null;
  signer_fingerprint: string | null;
  locators: string[];
  tags: string[];
  homepage: string | null;
}

export interface AgentIndex {
  index_id: string;
  version: string;
  title: string;
  description: string | null;
  publisher: { name: string; url: string | null };
  issued_at: string;
  expires_at: string;
  entries: AgentIndexEntry[];
  /** Entries left out by the rules of §4, by position, with why. */
  notes: ResolveNote[];
}

/** An index as this browser holds it: the verified content and the facts of its verification. */
export interface VerifiedIndex {
  index: AgentIndex;
  signer_fingerprint: string;
  content_sha256: string;
  document_sha256: string;
}

const str = (value: unknown): string => String(value);
const optional = (value: unknown): string | null => (typeof value === "string" ? value : null);
const strings = (value: unknown): string[] => (Array.isArray(value) ? value.map(str) : []);

function invalid(message: string): CoreError {
  return new CoreError("document_content_invalid", `The agent index is signed, but ${message}`, { status: 422 });
}

/**
 * The rules of §4 on content the schema already accepted: the validity window is ordered, no
 * two entries name the same package version or the same URL, and an entry whose package URL
 * this browser's URL gate refuses is left out (with a note naming its position and why) rather
 * than shown as something a person could open.
 */
export function readAgentIndex(content: JsonObject): AgentIndex {
  const issued = Date.parse(str(content.issued_at));
  const expires = Date.parse(str(content.expires_at));
  if (!Number.isFinite(issued) || !Number.isFinite(expires) || expires <= issued) throw invalid("its expires_at is not after its issued_at.");
  const notes: ResolveNote[] = [];
  const entries: AgentIndexEntry[] = [];
  const versions = new Set<string>();
  const urls = new Set<string>();
  (content.entries as JsonObject[]).forEach((raw, position) => {
    const publisher = raw.publisher as JsonObject;
    const entry: AgentIndexEntry = {
      package_id: str(raw.package_id),
      name: str(raw.name),
      version: str(raw.version),
      description: str(raw.description),
      publisher: { id: str(publisher.id), name: str(publisher.name) },
      package_url: str(raw.package_url),
      digest: optional(raw.digest),
      archive_sha256: optional(raw.archive_sha256),
      signer_fingerprint: optional(raw.signer_fingerprint),
      locators: strings(raw.locators),
      tags: strings(raw.tags),
      homepage: optional(raw.homepage),
    };
    const key = `${entry.package_id}@${entry.version}`;
    if (versions.has(key)) throw invalid(`it lists ${key} twice.`);
    if (urls.has(entry.package_url)) throw invalid(`it lists the package URL ${entry.package_url} twice.`);
    versions.add(key);
    urls.add(entry.package_url);
    try {
      validatePackageUrl(entry.package_url, "Package");
      if (entry.homepage !== null) validatePackageUrl(entry.homepage, "Homepage");
    } catch (error) {
      notes.push({ code: "entry_url_refused", detail: `entries[${position}] (${key}): ${error instanceof Error ? error.message : "refused"}` });
      return;
    }
    entries.push(entry);
  });
  const indexPublisher = content.publisher as JsonObject;
  return {
    index_id: str(content.index_id),
    version: str(content.version),
    title: str(content.title),
    description: optional(content.description),
    publisher: { name: str(indexPublisher.name), url: optional(indexPublisher.url) },
    issued_at: str(content.issued_at),
    expires_at: str(content.expires_at),
    entries,
    notes,
  };
}

/** A verified agent-index document as this browser holds it. */
export function verifiedIndex(document: VerifiedDocument): VerifiedIndex {
  return { index: readAgentIndex(document.content), signer_fingerprint: document.signer_fingerprint, content_sha256: document.content_sha256, document_sha256: document.document_sha256 };
}

/** Whether an index may be used at `now`: inside its validity window (a few minutes of clock skew allowed at the start). */
export function indexState(index: AgentIndex, now: Date): "current" | "expired" | "not_yet_valid" {
  const at = now.getTime();
  if (Date.parse(index.expires_at) <= at) return "expired";
  if (Date.parse(index.issued_at) > at + 5 * 60_000) return "not_yet_valid";
  return "current";
}

export function candidateFromEntry(held: VerifiedIndex, entry: AgentIndexEntry, position: number): AgentCandidate {
  return {
    package_id: entry.package_id,
    name: entry.name,
    version: entry.version,
    description: entry.description,
    publisher: { id: entry.publisher.id, name: entry.publisher.name },
    package_url: entry.package_url,
    digest: entry.digest,
    archive_sha256: entry.archive_sha256,
    signer_fingerprint: entry.signer_fingerprint,
    locators: [...entry.locators],
    tags: [...entry.tags],
    homepage: entry.homepage,
    claims: [],
    source: {
      resolver: "static-index",
      resolver_id: held.index.index_id,
      label: held.index.title,
      version: held.index.version,
      verified_by: held.signer_fingerprint,
      content_sha256: held.content_sha256,
      position,
    },
  };
}

/** Queries over one verified index, answered in the index's own order. */
export class StaticIndexResolver implements Resolver {
  readonly id: string;
  readonly label: string;

  constructor(
    private readonly held: VerifiedIndex,
    private readonly clock: () => Date = () => new Date(),
  ) {
    this.id = held.index.index_id;
    this.label = held.index.title;
  }

  async query(query: ResolveQuery): Promise<ResolveResult> {
    const state = indexState(this.held.index, this.clock());
    if (state !== "current") {
      return { candidates: [], notes: [{ code: state === "expired" ? "index_expired" : "index_not_yet_valid", detail: `${this.label} ${this.held.index.version} is valid from ${this.held.index.issued_at} to ${this.held.index.expires_at}; it was not searched.` }] };
    }
    const candidates: AgentCandidate[] = [];
    this.held.index.entries.forEach((entry, position) => {
      const candidate = candidateFromEntry(this.held, entry, position);
      if (matches(candidate, query)) candidates.push(candidate);
    });
    return { candidates, notes: [] };
  }

  /** The entry at this package URL, for comparing an opened package with what the index said. */
  entryFor(packageUrl: string): AgentCandidate | null {
    const position = this.held.index.entries.findIndex((entry) => entry.package_url === packageUrl);
    return position < 0 ? null : candidateFromEntry(this.held, this.held.index.entries[position]!, position);
  }
}
