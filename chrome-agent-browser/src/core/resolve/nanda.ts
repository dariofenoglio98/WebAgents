/**
 * The NANDA resolver: a stub with the mapping written down (paper §VI-a, deck §15–16).
 *
 * NANDA ("Beyond DNS: Unlocking the Internet of AI Agents via the NANDA Index and Verified
 * AgentFacts", arXiv 2507.14263, v0.3 draft) resolves an agent name through a lean index to a
 * signed **AgentAddr** (`agent_id`, `agent_name`, `primary_facts_url`, `private_facts_url`,
 * `adaptive_resolver_url`, `ttl`, `signature`), and the AgentAddr to an **AgentFacts** document
 * (`id`, `agent_name`, `label`, `description`, `version`, `documentationUrl`, `jurisdiction`,
 * `provider`, `endpoints`, `capabilities`, `skills`, `evaluations`, `telemetry`,
 * `certification`). AgentFacts describes an agent; it has no member that names an agent
 * *program*. The mapping below therefore reads one extension member,
 *
 *   "org.webagents:agent-package-v0": {package_url, package_id, version,
 *                                      digest?, archive_sha256?, signer_fingerprint?, publisher_id?}
 *
 * and maps the rest as follows:
 *
 *   AgentName --(lean index)--> AgentAddr --(facts URL)--> AgentFacts --> candidate
 *     candidate.package_url, package_id, version,      <- the extension member
 *       digest, archive_sha256, signer_fingerprint
 *     candidate.name                                     <- AgentFacts.label (AgentCard.name)
 *     candidate.description                              <- AgentFacts.description
 *     candidate.publisher.name / .id                     <- AgentFacts.provider.name / the member's publisher_id
 *     candidate.locators                                 <- AgentAddr.agent_name
 *     candidate.homepage                                 <- AgentFacts.documentationUrl
 *     candidate.claims                                   <- certification, evaluations, jurisdiction: shown, never checked
 *     candidate.source.resolver_id                       <- the registry asked; verified_by stays null
 *
 * **Results are metadata, never authority.** A certification level or an evaluation score in
 * AgentFacts is displayed as the registry's claim; trust still comes only from the person's
 * trust store (or a policy they subscribed to), and the package is verified when opened. This
 * build has no NANDA endpoint configured and verifies neither the AgentAddr signature nor the
 * AgentFacts credentials, so `NandaResolver` answers with a note unless a test injects the two
 * ports; a real adapter must verify both before mapping anything.
 */
import { isJsonObject, type JsonObject } from "../json.js";
import type { AgentCandidate, CandidateClaim, ResolveQuery, ResolveResult, Resolver } from "./types.js";

export const AGENT_PACKAGE_MEMBER = "org.webagents:agent-package-v0";

/** What this build says about NANDA (D-104): the note `NandaResolver` returns without ports, and Settings → Search shows. */
export const NANDA_NOT_CONFIGURED = "NANDA resolution is not available in this build: the mapping is defined (core/resolve/nanda.ts), no registry endpoint is configured, and AgentAddr signatures are not verified yet.";

/** The lean index's answer for one agent name (the paper's Table 3). */
export interface AgentAddr {
  agent_id: string;
  agent_name: string;
  primary_facts_url: string | null;
  private_facts_url: string | null;
  adaptive_resolver_url: string | null;
  ttl: number | null;
  signature: string | null;
}

/** The two network steps a real adapter performs; absent in this build. */
export interface NandaPorts {
  /** AgentName → AgentAddr (the lean index), or null when the index knows no such agent. */
  lookup(agentName: string, signal?: AbortSignal): Promise<AgentAddr | null>;
  /** Facts URL → AgentFacts document (unverified JSON). */
  facts(url: string, signal?: AbortSignal): Promise<unknown>;
}

const text = (value: unknown): string | null => (typeof value === "string" && value.length > 0 ? value : null);

function claimsOf(facts: JsonObject): CandidateClaim[] {
  const claims: CandidateClaim[] = [];
  const certification = isJsonObject(facts.certification) ? facts.certification : null;
  if (certification) {
    const level = text(certification.level);
    const issuer = text(certification.issuer);
    if (level || issuer) claims.push({ label: "Certification", value: [level, issuer ? `by ${issuer}` : null, text(certification.expirationDate) ? `until ${certification.expirationDate as string}` : null].filter(Boolean).join(" ") });
  }
  const evaluations = isJsonObject(facts.evaluations) ? facts.evaluations : null;
  if (evaluations && (typeof evaluations.performanceScore === "number" || text(evaluations.auditorID))) {
    claims.push({ label: "Evaluation", value: [typeof evaluations.performanceScore === "number" ? `score ${evaluations.performanceScore}` : null, text(evaluations.auditorID) ? `by ${evaluations.auditorID as string}` : null].filter(Boolean).join(" ") });
  }
  const jurisdiction = text(facts.jurisdiction);
  if (jurisdiction) claims.push({ label: "Jurisdiction", value: jurisdiction });
  return claims;
}

/**
 * Map one AgentAddr and its AgentFacts to a candidate, or null when the facts name no agent
 * package (most NANDA agents are services, not programs to run). Shapes are checked, values are
 * not believed: every field becomes display metadata.
 */
export function agentFactsCandidate(addr: AgentAddr, facts: unknown, registry: { id: string; label: string }, position = 0): AgentCandidate | null {
  if (!isJsonObject(facts)) return null;
  const member = facts[AGENT_PACKAGE_MEMBER];
  if (!isJsonObject(member)) return null;
  const packageUrl = text(member.package_url);
  const packageId = text(member.package_id);
  const version = text(member.version);
  if (packageUrl === null || packageId === null || version === null) return null;
  const hex = (value: unknown): string | null => (typeof value === "string" && /^[0-9a-f]{64}$/u.test(value) ? value : null);
  const provider = isJsonObject(facts.provider) ? facts.provider : {};
  return {
    package_id: packageId,
    name: text(facts.label) ?? packageId,
    version,
    description: text(facts.description) ?? "",
    publisher: { id: text(member.publisher_id), name: text(provider.name) },
    package_url: packageUrl,
    digest: hex(member.digest),
    archive_sha256: hex(member.archive_sha256),
    signer_fingerprint: typeof member.signer_fingerprint === "string" && /^sha256:[0-9a-f]{64}$/u.test(member.signer_fingerprint) ? member.signer_fingerprint : null,
    locators: [addr.agent_name.toLowerCase()],
    tags: [],
    homepage: text(facts.documentationUrl),
    claims: claimsOf(facts),
    source: { resolver: "nanda", resolver_id: registry.id, label: registry.label, version: null, verified_by: null, content_sha256: null, position },
  };
}

/** The NANDA resolver. Without ports (this build) it answers every query with a note and no candidate. */
export class NandaResolver implements Resolver {
  readonly id: string;
  readonly label: string;

  constructor(
    registry: { id: string; label: string } = { id: "nanda", label: "NANDA index" },
    private readonly ports: NandaPorts | null = null,
  ) {
    this.id = registry.id;
    this.label = registry.label;
  }

  async query(query: ResolveQuery, signal?: AbortSignal): Promise<ResolveResult> {
    if (this.ports === null) {
      return { candidates: [], notes: [{ code: "nanda_not_configured", detail: NANDA_NOT_CONFIGURED }] };
    }
    // A lean index resolves names, not free text: only a locator is looked up.
    if (query.kind !== "locator") return { candidates: [], notes: [{ code: "nanda_needs_locator", detail: "The NANDA index resolves agent names such as name@host; free text is not searched." }] };
    const addr = await this.ports.lookup(query.text, signal);
    if (addr === null) return { candidates: [], notes: [] };
    const factsUrl = addr.primary_facts_url ?? addr.private_facts_url;
    if (factsUrl === null) return { candidates: [], notes: [{ code: "nanda_no_facts", detail: `${addr.agent_name} has no AgentFacts URL.` }] };
    const candidate = agentFactsCandidate(addr, await this.ports.facts(factsUrl, signal), { id: this.id, label: this.label });
    if (candidate === null) return { candidates: [], notes: [{ code: "nanda_no_package", detail: `${addr.agent_name}'s AgentFacts names no agent package (${AGENT_PACKAGE_MEMBER}).` }] };
    // The index answered for this name, so the candidate is its answer, whatever its own spelling of the name.
    return { candidates: [candidate], notes: [] };
  }
}
