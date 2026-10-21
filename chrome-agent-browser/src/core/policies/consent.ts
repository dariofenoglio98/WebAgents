/**
 * Just-in-time consent in presets and policies (conversation.v0, D-271): which consent steps a
 * host may decide for the person before the conversation starts, recorded in the Run Plan.
 *
 * Never pre-decided, by any preset or policy: a step naming a permission of kind `payment` or
 * `personal.read` (D-261's floor: the person decides on the facts; a payment is `once` under every
 * preset, so its card appears once per conversation). `privacy-first` and `balanced` ask every
 * step; `convenience` pre-accepts a step whose permissions are all of other kinds. A signed policy
 * may say `pre_decide: never` (every step asks whatever the preset) or forbid kinds, whose steps
 * resolve denied with provenance `policy` and are never asked. A policy only lowers.
 */
import { consentNodes } from "../conversation/declarations.js";
import type { JsonObject, JsonValue } from "../json.js";
import type { Package } from "../package.js";
import type { ConsentStepPlan, PresetId } from "../types.js";
import type { PolicyBundle } from "./bundle.js";

export const NEVER_PRE_DECIDED_KINDS: ReadonlySet<string> = new Set(["payment", "personal.read"]);
export const POLICY_FORBIDS = "policy_forbids";

export type ConsentPolicy = NonNullable<PolicyBundle["consent"]>;

/** The consent steps of a package with the decision a preset or a policy takes for each, or none (the card). */
export function consentPlan(pkg: Package, preset: PresetId, policy: ConsentPolicy | null | undefined): ConsentStepPlan[] {
  const kinds = new Map((pkg.policy.permissions as JsonObject[]).map((permission) => [String(permission.id), String(permission.kind)]));
  const forbidden = new Set(policy?.forbid_kinds ?? []);
  return consentNodes(pkg.graph).map((node) => {
    const permissions = (node.permissions as JsonValue[]).map(String);
    const stepKinds = [...new Set(permissions.map((id) => kinds.get(id) ?? "unknown"))].sort();
    let preDecided: ConsentStepPlan["pre_decided"] = null;
    if (stepKinds.some((kind) => forbidden.has(kind))) preDecided = { accepted: false, decided_by: "policy", reason: POLICY_FORBIDS };
    else if (preset === "convenience" && policy?.pre_decide !== "never" && !stepKinds.some((kind) => NEVER_PRE_DECIDED_KINDS.has(kind))) preDecided = { accepted: true, decided_by: "preset", reason: null };
    return { id: String(node.id), permissions, kinds: stepKinds, pre_decided: preDecided };
  });
}
