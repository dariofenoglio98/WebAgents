/**
 * What a subscribed policy does (`spec/extensions/policy-bundle-v0.md` §5), and the bounds on it.
 *
 * - **Trust.** A publisher-key anchor makes a signer trusted for its scope, as an operator pin
 *   of the same scope would, but only where the person's own trust store has no opinion: a key
 *   the person pinned, or a publisher the person pinned to another key, is decided by the store
 *   first. Issuer anchors confer nothing in v0 (D-100).
 * - **Decisions.** For each declared permission of a kind the policy names, the policy's decision,
 *   lowered to the person's ceiling (the preset's duration for that kind; `always` is never
 *   possible). Inside a selected profile only the profile's members are decided; everything
 *   outside it stays denied by the profile. Tool approvals follow: a tool is approved by default
 *   when its permissions are granted and the policy's binding allowlist admits its host
 *   implementation. Resource picks are never made by a policy. Every such decision records
 *   `policy`, and the person may override any of them in the detailed view (recorded `user`).
 * - **Caps and models.** Budget caps lower the run limits (never raise them); `local_only` and a
 *   cost cap refuse models the policy does not admit while the person is subscribed.
 *
 * A policy can therefore never grant more than the package declares, than the selected profile
 * contains, or than the person's preset allows; `test/core/policies.test.ts` checks this over
 * random bundles.
 */
import { presetDuration, type Decided } from "../authorization.js";
import type { TrustEvaluator, TrustVerdict } from "../evaluation.js";
import type { HostExecutionLimits } from "../execution/limits.js";
import type { JsonObject, JsonValue } from "../json.js";
import type { Package } from "../package.js";
import type { Profile } from "../profiles.js";
import { evaluateTrust, type TrustEntry } from "../trust.js";
import { DENY, type DecidedBy, type Decision, type PresetId, type Reason } from "../types.js";
import { CAP_FIELDS, policyLabel, type PolicyBundle, type PolicyReference } from "./bundle.js";

/** A subscribed bundle inside its validity window: the only kind that applies. */
export interface ActivePolicy {
  bundle: PolicyBundle;
  reference: PolicyReference;
}

const RANK: Readonly<Record<Decision, number>> = Object.freeze({ deny: 0, once: 1, session: 2 });

/** The more restrictive of two decisions (`deny` < `once` < `session`). */
export function minDecision(a: Decision, b: Decision): Decision {
  return RANK[a] <= RANK[b] ? a : b;
}

export function decisionRank(decision: Decision): number {
  return RANK[decision];
}

// -- trust ------------------------------------------------------------------------------------
/**
 * The verdict of a policy's publisher-key anchors for one signer, or null when they say nothing
 * about it. The two-sided rule of the trust store applies unchanged: an anchored key outside its
 * scope, or a publisher the policy anchors to other keys, is `mismatch`.
 */
export function anchorVerdict(policy: ActivePolicy, input: { signerFingerprint: string | null; claimedPublisherId: string; packageId: string }): TrustVerdict | null {
  const anchors = policy.bundle.trust_anchors.filter((anchor) => anchor.kind === "publisher_key");
  if (anchors.length === 0 || input.signerFingerprint === null) return null;
  const entries: TrustEntry[] = anchors.map((anchor) => ({
    fingerprint: anchor.fingerprint,
    public_key: anchor.public_key,
    display_name: anchor.display_name,
    publisher_id: anchor.publisher_id,
    package_id_prefix: anchor.package_id_prefix,
    notes: null,
    added_at: policy.bundle.issued_at,
  }));
  const verdict = evaluateTrust(entries, input);
  if (verdict.trust_status === "unknown") return null;
  const entry = verdict.trust_entry as Record<string, unknown> | null;
  return {
    trust_status: verdict.trust_status,
    trust_reason: verdict.trust_status === "trusted" ? "policy_anchor" : `policy_${verdict.trust_reason}`,
    trust_entry: entry
      ? { fingerprint: entry.fingerprint, display_name: entry.display_name, publisher_id: entry.publisher_id, package_id_prefix: entry.package_id_prefix, policy: policyLabel(policy.reference), policy_title: policy.reference.title }
      : null,
    ...(verdict.pinned_fingerprints_for_claimed_publisher ? { pinned_fingerprints_for_claimed_publisher: verdict.pinned_fingerprints_for_claimed_publisher } : {}),
  };
}

/**
 * The person's trust store, then the subscribed policy's anchors. The store decides whenever it
 * has an opinion (`trusted`, `mismatch`, or no valid signature); the policy only answers for a
 * signer the store has never heard of.
 */
export class PolicyTrust implements TrustEvaluator {
  constructor(
    private readonly store: TrustEvaluator,
    private readonly active: () => Promise<ActivePolicy | null>,
  ) {}

  async evaluate(input: { signerFingerprint: string | null; claimedPublisherId: string; packageId: string }): Promise<TrustVerdict> {
    const verdict = await this.store.evaluate(input);
    if (verdict.trust_status !== "unknown" || verdict.trust_reason !== "signer_key_not_pinned") return verdict;
    const policy = await this.active();
    return (policy && anchorVerdict(policy, input)) ?? verdict;
  }
}

// -- decisions --------------------------------------------------------------------------------
/** The host implementation a tool would be bound to, as the binding allowlist judges it. */
export interface ToolBindingFacts {
  kind: string;
  /** The HTTPS origin a `json_http` binding reaches; null for other kinds. */
  origin: string | null;
}

/** Whether the policy's allowlist admits this binding; a tool this host cannot bind is never admitted by an allowlist. */
export function bindingAllowed(bundle: PolicyBundle, facts: ToolBindingFacts | null): boolean {
  if (bundle.bindings === null) return true;
  if (facts === null) return false;
  return bundle.bindings.allow.some((item) => item.kind === facts.kind && (item.origins === null || (facts.origin !== null && item.origins.includes(facts.origin))));
}

/**
 * Apply the policy to the decisions a profile (or, without one, the preset) yields. `base` is
 * `profileDecisions` or `defaultDecisions`; the result has exactly the same keys.
 */
export function applyPolicy(
  pkg: Package,
  base: Decided,
  input: { policy: ActivePolicy; preset: PresetId; profile: Profile | null; bindings: Readonly<Record<string, ToolBindingFacts | null>> },
): Decided {
  const bundle = input.policy.bundle;
  const decisions = { ...base.decisions };
  const decidedBy: Record<string, DecidedBy> = { ...base.provenance.decisions };
  for (const permission of pkg.policy.permissions as JsonObject[]) {
    const id = String(permission.id);
    const kind = String(permission.kind);
    if (input.profile && !input.profile.permissions.includes(id)) continue; // the profile keeps it denied
    const rule = Object.hasOwn(bundle.decisions, kind) ? bundle.decisions[kind] : undefined;
    if (rule === undefined) continue;
    decisions[id] = minDecision(rule, presetDuration(input.preset, kind));
    decidedBy[id] = "policy";
  }
  const approvals = { ...base.tool_approvals };
  const approvedBy: Record<string, DecidedBy> = { ...base.provenance.tool_approvals };
  for (const toolId of Object.keys(base.tool_approvals)) {
    if (input.profile && !input.profile.tools.includes(toolId)) continue; // outside the profile: denied by it
    const linked = ((pkg.tools[toolId]!.permissions as JsonValue[]) ?? []).map(String);
    const allowed = bindingAllowed(bundle, input.bindings[toolId] ?? null);
    // A tool that needs no permission is the profile's or preset's call alone, unless the allowlist excludes it.
    const approved = !allowed ? false : linked.length === 0 ? base.tool_approvals[toolId]! : linked.every((id) => (decisions[id] ?? DENY) !== DENY);
    if (approved !== base.tool_approvals[toolId]) {
      approvals[toolId] = approved;
      approvedBy[toolId] = "policy";
    }
  }
  return {
    decisions,
    tool_approvals: approvals,
    provenance: { ...base.provenance, decisions: decidedBy, tool_approvals: approvedBy, policy: { ...input.policy.reference } },
  };
}

// -- caps and models ----------------------------------------------------------------------------
/** The run limits under the policy's caps: each the lower of the person's and the policy's. */
export function cappedLimits(limits: HostExecutionLimits, caps: Partial<HostExecutionLimits> | null | undefined): HostExecutionLimits {
  const out = { ...limits };
  if (!caps) return out;
  for (const field of CAP_FIELDS) {
    const cap = caps[field];
    if (typeof cap === "number" && cap < out[field]) out[field] = cap;
  }
  return out;
}

/**
 * Why the subscribed policy does not admit a model for a plan, or nothing. `local_only` admits
 * only models reported local; a cost cap admits only models whose cost this browser can bound,
 * which today means a free (local) model: no catalog states prices (D-061), and an unknown price
 * is not zero.
 */
export function modelPolicyReasons(policy: ActivePolicy | null, model: { id: string; properties: { local?: unknown; cost_class?: unknown } }): Reason[] {
  if (policy === null) return [];
  const reasons: Reason[] = [];
  const label = `${policy.reference.title} (${policyLabel(policy.reference)})`;
  const local = model.properties.local === true;
  if (policy.bundle.models.local_only && !local) {
    reasons.push({ code: "model_not_local", message: `The policy ${label} allows local models only; ${model.id} is not reported as local. Choose a local model, or unsubscribe in Settings → Policies.`, subject: model.id });
  }
  const cap = policy.bundle.models.max_cost_usd_per_run;
  if (cap !== null && !(local || model.properties.cost_class === "free")) {
    reasons.push({ code: "model_cost_unbounded", message: `The policy ${label} caps a run's model cost at $${cap}; this browser knows no price for ${model.id}, so it cannot keep a run under the cap. Choose a local model, or unsubscribe in Settings → Policies.`, subject: model.id });
  }
  return reasons;
}
