/**
 * Signed policy bundles (`spec/extensions/policy-bundle-v0.md`): what an institution (a lab, a
 * university, an employer) publishes so that a person who subscribes to it gets their trust and
 * their defaults decided for them, with the provenance visible on every decision (F-02's
 * "concierge mode").
 *
 * This module reads a verified bundle's content and applies the rules beyond the schema (§4).
 * What a bundle may do is in `apply.ts`, and it is narrow by construction: it pre-decides within
 * what a package declares and what the person's own ceiling allows, never beyond either.
 */
import { canonicalJson } from "../canonical.js";
import { CoreError } from "../errors.js";
import type { HostExecutionLimits } from "../execution/limits.js";
import { sha256Hex } from "../hash.js";
import type { ImplementationKind } from "../hosttools.js";
import type { JsonObject } from "../json.js";
import { fingerprint, publicKeyFromRawBase64 } from "../keys.js";
import type { VerifiedDocument } from "../signed-document.js";
import type { Decision, PolicyReference } from "../types.js";

export type { PolicyReference };

/** The permission kinds of `policy.schema.json`, the keys a bundle's `decisions` may use. */
export const PERMISSION_KINDS: readonly string[] = Object.freeze(["network", "files.read", "files.write", "model", "memory", "shell", "payment", "personal.read", "memory.read", "memory.write", "compute"]);
export const CAP_FIELDS: ReadonlyArray<keyof HostExecutionLimits> = Object.freeze([
  "total_tokens",
  "max_remote_calls",
  "max_parallel_workers",
  "max_output_tokens_per_call",
  "run_timeout_seconds",
  "max_calls_per_tool",
  "model_call_timeout_seconds",
]);

/** A publisher key the policy vouches for, scoped like an operator pin of scope `package` or narrower. */
export interface PublisherKeyAnchor {
  kind: "publisher_key";
  public_key: string;
  fingerprint: string;
  display_name: string;
  publisher_id: string;
  package_id_prefix: string;
}

/**
 * An issuer the policy would accept publisher credentials from. Declared and shown, never
 * applied in v0: no credential format exists yet (BACKLOG B-20), so an issuer anchor confers no
 * trust here (D-101).
 */
export interface IssuerAnchor {
  kind: "issuer";
  public_key: string;
  fingerprint: string;
  display_name: string;
  scope: { package_id_prefix: string; publisher_id: string | null };
}

export type TrustAnchor = PublisherKeyAnchor | IssuerAnchor;

export interface AllowedBinding {
  kind: ImplementationKind;
  /** The HTTPS origins a `json_http` binding may reach; null: any origin of that kind. */
  origins: string[] | null;
}

export interface PolicyBundle {
  policy_id: string;
  version: string;
  title: string;
  description: string | null;
  issuer: { name: string; url: string | null };
  issued_at: string;
  expires_at: string;
  trust_anchors: TrustAnchor[];
  /** Default decision per permission kind; a kind it does not name is left to the profile or preset. */
  decisions: Partial<Record<string, Decision>>;
  /** Ceilings on the run limits; a run is held to the lower of these and the person's own. */
  budget_caps: Partial<HostExecutionLimits>;
  models: { local_only: boolean; max_cost_usd_per_run: number | null };
  /** Which host implementations a tool may be bound to by default; null: no restriction. */
  bindings: { allow: AllowedBinding[] } | null;
  /** memory.v0 M-54: what a policy may restrict about memory; null when the bundle says nothing. A policy only lowers. */
  memory: { types_allowed: string[] | null; proposals: "ask" | "refuse"; agent: "allow" | "refuse"; recall: "ask" | "propose" | "auto" } | null;
  /** conversation.v0 (D-271): whether a preset may pre-decide consent steps, and the kinds whose steps are never asked; null when the bundle says nothing. */
  consent: { pre_decide: "allow" | "never"; forbid_kinds: string[] } | null;
}

/** A subscribed bundle as this browser holds it. */
export interface HeldPolicy {
  bundle: PolicyBundle;
  reference: PolicyReference;
  document_sha256: string;
}

const str = (value: unknown): string => String(value);
const optional = (value: unknown): string | null => (typeof value === "string" ? value : null);

function invalid(message: string): CoreError {
  return new CoreError("document_content_invalid", `The policy bundle is signed, but ${message}`, { status: 422 });
}

/**
 * The rules of §4 on content the schema already accepted: an ordered validity window; every
 * anchor's fingerprint is its key's; no key is anchored twice. An invalid bundle is refused as a
 * whole: a policy is never applied in part.
 */
export async function readPolicyBundle(content: JsonObject): Promise<PolicyBundle> {
  const issued = Date.parse(str(content.issued_at));
  const expires = Date.parse(str(content.expires_at));
  if (!Number.isFinite(issued) || !Number.isFinite(expires) || expires <= issued) throw invalid("its expires_at is not after its issued_at.");
  const anchors: TrustAnchor[] = [];
  const seen = new Set<string>();
  for (const [position, raw] of (content.trust_anchors as JsonObject[]).entries()) {
    let key: Uint8Array;
    try {
      key = publicKeyFromRawBase64(raw.public_key);
    } catch {
      throw invalid(`trust_anchors[${position}] is not a raw Ed25519 key.`);
    }
    if ((await fingerprint(key)) !== raw.fingerprint) throw invalid(`trust_anchors[${position}]'s fingerprint is not its key's.`);
    if (seen.has(str(raw.fingerprint))) throw invalid(`trust_anchors[${position}] anchors a key already anchored.`);
    seen.add(str(raw.fingerprint));
    if (raw.kind === "publisher_key") {
      anchors.push({ kind: "publisher_key", public_key: str(raw.public_key), fingerprint: str(raw.fingerprint), display_name: str(raw.display_name), publisher_id: str(raw.publisher_id), package_id_prefix: str(raw.package_id_prefix) });
    } else {
      const scope = raw.scope as JsonObject;
      anchors.push({ kind: "issuer", public_key: str(raw.public_key), fingerprint: str(raw.fingerprint), display_name: str(raw.display_name), scope: { package_id_prefix: str(scope.package_id_prefix), publisher_id: optional(scope.publisher_id) } });
    }
  }
  const decisions: Partial<Record<string, Decision>> = {};
  for (const [kind, decision] of Object.entries(content.decisions as JsonObject)) decisions[kind] = decision as Decision;
  const caps: Partial<HostExecutionLimits> = {};
  const rawCaps = (content.budget_caps ?? {}) as JsonObject;
  for (const field of CAP_FIELDS) if (typeof rawCaps[field] === "number") caps[field] = rawCaps[field] as number;
  const models = (content.models ?? {}) as JsonObject;
  const bindings = content.bindings === undefined ? null : (content.bindings as JsonObject);
  const memoryRaw = content.memory === undefined || content.memory === null ? null : (content.memory as JsonObject);
  const memory: PolicyBundle["memory"] = memoryRaw === null ? null : {
    types_allowed: Array.isArray(memoryRaw.types_allowed) ? memoryRaw.types_allowed.map(str) : null,
    proposals: memoryRaw.proposals === "refuse" ? "refuse" : "ask",
    agent: memoryRaw.agent === "refuse" ? "refuse" : "allow",
    recall: memoryRaw.recall === "ask" || memoryRaw.recall === "propose" ? memoryRaw.recall : "auto",
  };
  const consentRaw = content.consent === undefined || content.consent === null ? null : (content.consent as JsonObject);
  const consent: PolicyBundle["consent"] = consentRaw === null ? null : { pre_decide: consentRaw.pre_decide === "never" ? "never" : "allow", forbid_kinds: Array.isArray(consentRaw.forbid_kinds) ? consentRaw.forbid_kinds.map(str) : [] };
  const issuer = content.issuer as JsonObject;
  return {
    policy_id: str(content.policy_id),
    version: str(content.version),
    title: str(content.title),
    description: optional(content.description),
    issuer: { name: str(issuer.name), url: optional(issuer.url) },
    issued_at: str(content.issued_at),
    expires_at: str(content.expires_at),
    trust_anchors: anchors,
    decisions,
    budget_caps: caps,
    models: { local_only: models.local_only === true, max_cost_usd_per_run: typeof models.max_cost_usd_per_run === "number" ? models.max_cost_usd_per_run : null },
    bindings: bindings === null ? null : { allow: (bindings.allow as JsonObject[]).map((item) => ({ kind: str(item.kind) as ImplementationKind, origins: Array.isArray(item.origins) ? item.origins.map(str) : null })) },
    memory,
    consent,
  };
}

/** A verified policy-bundle document as this browser holds it. */
export async function heldPolicy(verified: VerifiedDocument): Promise<HeldPolicy> {
  const bundle = await readPolicyBundle(verified.content);
  return {
    bundle,
    reference: { policy_id: bundle.policy_id, version: bundle.version, title: bundle.title, content_sha256: verified.content_sha256, signer_fingerprint: verified.signer_fingerprint },
    document_sha256: verified.document_sha256,
  };
}

/** Whether a bundle applies at `now`: inside its validity window (a few minutes of clock skew allowed at the start). */
export function policyState(bundle: PolicyBundle, now: Date): "current" | "expired" | "not_yet_valid" {
  const at = now.getTime();
  if (Date.parse(bundle.expires_at) <= at) return "expired";
  if (Date.parse(bundle.issued_at) > at + 5 * 60_000) return "not_yet_valid";
  return "current";
}

/** `org.webagents.research@1.0.0`: how a decision names the policy that made it. */
export function policyLabel(reference: Pick<PolicyReference, "policy_id" | "version">): string {
  return `${reference.policy_id}@${reference.version}`;
}

export function samePolicy(a: PolicyReference | null | undefined, b: PolicyReference | null | undefined): boolean {
  if (!a || !b) return !a && !b;
  return a.policy_id === b.policy_id && a.version === b.version && a.content_sha256 === b.content_sha256 && a.signer_fingerprint === b.signer_fingerprint;
}

/** The content hash a test or a tool computes for a bundle it builds. */
export async function contentSha256(content: JsonObject): Promise<string> {
  return sha256Hex(canonicalJson(content));
}
