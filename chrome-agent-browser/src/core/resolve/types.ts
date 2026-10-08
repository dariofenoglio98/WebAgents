/**
 * Resolving what a person typed into candidate agents (T8, deck §15–16 and §19, paper §VI-a).
 *
 * A resolver answers a query with **candidates**: where a package is said to be, what it is
 * said to be, and who said so. A candidate is metadata, never authority. Opening one is the
 * ordinary open-and-verify of the package at `package_url`: the bytes are downloaded, verified,
 * evaluated against the person's trust store and authorized like any other package, and
 * whatever the resolver claimed (a digest, a signer, a certification) is only compared with what
 * the bytes say. Ranking is by the resolver's own order and the trust status of the claimed
 * signer, nothing else (no reputation, no popularity).
 */

/** What the person typed: free text, or an agent locator such as `literature-review@webagents.org`. */
export interface ResolveQuery {
  kind: "text" | "locator";
  /** The normalized query: lowercase, NFKC, single spaces. */
  text: string;
}

/** Who said a candidate exists, and how much of that was checked. */
export interface CandidateSource {
  resolver: "static-index" | "nanda";
  /** The index id, or the NANDA registry the stub would ask. */
  resolver_id: string;
  /** A person's name for it ("WebAgents demo index"). */
  label: string;
  /** The index document's version, when the source has one. */
  version: string | null;
  /** The pinned key that verified the source document, or null when nothing was verified (the NANDA stub). */
  verified_by: string | null;
  /** SHA-256 of the source document's canonical content, when there is one. */
  content_sha256: string | null;
  /** Zero-based position in the source's own order. */
  position: number;
}

/** A claim the source makes about a candidate and the browser does not check (a certification, an evaluation). */
export interface CandidateClaim {
  label: string;
  value: string;
}

export interface AgentCandidate {
  package_id: string;
  name: string;
  version: string;
  description: string;
  publisher: { id: string | null; name: string | null };
  package_url: string;
  /** The package digest the source claims, lowercase hex; compared with the bytes after opening. */
  digest: string | null;
  archive_sha256: string | null;
  /** The signer fingerprint the source claims (`sha256:…`); the bytes decide. */
  signer_fingerprint: string | null;
  locators: string[];
  tags: string[];
  homepage: string | null;
  claims: CandidateClaim[];
  source: CandidateSource;
}

export interface ResolveNote {
  code: string;
  detail: string | null;
}

export interface ResolveResult {
  candidates: AgentCandidate[];
  notes: ResolveNote[];
}

export interface Resolver {
  readonly id: string;
  readonly label: string;
  query(query: ResolveQuery, signal?: AbortSignal): Promise<ResolveResult>;
}

/** `name@host.example`: the locator form the deck uses (`travel@ramesh.com`). */
export const LOCATOR = /^[a-z0-9][a-z0-9._-]{0,63}@[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?)+$/u;
export const MAX_QUERY = 200;

/**
 * Read what the person typed as a query, or null when it is empty. An address (`https://…`, a
 * bare host name) is not a query: the address bar opens it as before.
 */
export function readQuery(input: string): ResolveQuery | null {
  const text = input.normalize("NFKC").trim().replace(/\s+/gu, " ").toLowerCase().slice(0, MAX_QUERY);
  if (text.length === 0) return null;
  return { kind: LOCATOR.test(text) ? "locator" : "text", text };
}

/**
 * What the address bar should do with an input: open an address (a package or a website), or
 * search the configured resolvers. Anything with a scheme, or a single word that looks like a
 * host name (a dot, no space, no `@`), is an address; a locator and free text are searches.
 */
export function addressKind(input: string): "address" | "search" {
  const trimmed = input.trim();
  if (/^[a-z][a-z0-9+.-]*:\/\//iu.test(trimmed)) return "address";
  if (LOCATOR.test(trimmed.toLowerCase())) return "search";
  if (!/\s/u.test(trimmed) && !trimmed.includes("@") && /^[^/.]+(\.[^/.]+)+(\/.*)?$/u.test(trimmed)) return "address";
  return "search";
}

/** The words a candidate is matched against, lowercased. */
export function haystack(candidate: AgentCandidate): string {
  return [candidate.name, candidate.description, candidate.package_id, candidate.publisher.id ?? "", candidate.publisher.name ?? "", ...candidate.tags, ...candidate.locators]
    .join("\n")
    .normalize("NFKC")
    .toLowerCase();
}

/**
 * Whether a candidate answers a query: a locator matches one of its locators exactly; free text
 * matches when every word occurs in its name, description, ids, publisher, tags or locators.
 */
export function matches(candidate: AgentCandidate, query: ResolveQuery): boolean {
  if (query.kind === "locator") return candidate.locators.includes(query.text);
  const text = haystack(candidate);
  return query.text.split(" ").every((word) => text.includes(word));
}
