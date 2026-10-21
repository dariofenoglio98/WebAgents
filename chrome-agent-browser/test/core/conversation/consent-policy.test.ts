/**
 * Just-in-time consent in presets and policies (D-271): which steps a preset or a policy may decide
 * before the conversation, the floor no one crosses, and the plan's bounded record of it (D-270).
 */
import { describe, expect, it } from "vitest";

import { normalizeConversationPlan } from "../../../src/core/execution/plan.js";
import type { JsonObject } from "../../../src/core/json.js";
import { consentPlan, NEVER_PRE_DECIDED_KINDS, POLICY_FORBIDS } from "../../../src/core/policies/consent.js";
import { readPolicyBundle } from "../../../src/core/policies/bundle.js";
import { conversationPlan } from "../../../src/core/runplan.js";
import { extensionSchemaFailure } from "../../../src/core/schema.js";
import { node, probePackage, type Members } from "../../helpers/conversation-package.js";

const onNetwork = (m: Members) => {
  node(m, "confirm").permissions = ["network.desk"];
};

describe("consent steps in presets and policies (D-271)", () => {
  it("never pre-decides a payment or a personal read; convenience pre-accepts the rest; the other presets ask", async () => {
    expect([...NEVER_PRE_DECIDED_KINDS].sort()).toEqual(["payment", "personal.read"]);
    const payment = (await probePackage({ remoteTool: true })).pkg;
    for (const preset of ["privacy-first", "balanced", "convenience"] as const) {
      expect(consentPlan(payment, preset, null)).toEqual([{ id: "confirm", permissions: ["orders.place"], kinds: ["payment"], pre_decided: null }]);
    }
    const network = (await probePackage({ remoteTool: true, mutate: onNetwork })).pkg;
    expect(consentPlan(network, "balanced", null)[0]!.pre_decided).toBeNull();
    expect(consentPlan(network, "privacy-first", null)[0]!.pre_decided).toBeNull();
    expect(consentPlan(network, "convenience", null)[0]!).toEqual({ id: "confirm", permissions: ["network.desk"], kinds: ["network"], pre_decided: { accepted: true, decided_by: "preset", reason: null } });
  });

  it("a policy only lowers: `never` makes every step ask, a forbidden kind resolves denied by the policy", async () => {
    const network = (await probePackage({ remoteTool: true, mutate: onNetwork })).pkg;
    expect(consentPlan(network, "convenience", { pre_decide: "never", forbid_kinds: [] })[0]!.pre_decided).toBeNull();
    expect(consentPlan(network, "convenience", { pre_decide: "allow", forbid_kinds: ["network"] })[0]!.pre_decided).toEqual({ accepted: false, decided_by: "policy", reason: POLICY_FORBIDS });
    expect(consentPlan(network, "balanced", { pre_decide: "allow", forbid_kinds: ["payment"] })[0]!.pre_decided).toBeNull();
    const payment = (await probePackage({ remoteTool: true })).pkg;
    expect(consentPlan(payment, "convenience", { pre_decide: "allow", forbid_kinds: ["payment"] })[0]!.pre_decided).toEqual({ accepted: false, decided_by: "policy", reason: POLICY_FORBIDS });
  });

  it("the policy bundle admits an optional consent section and the reader keeps it", async () => {
    const bundle: JsonObject = {
      policy_id: "org.example.policy",
      version: "1.0.0",
      title: "Example",
      issuer: { name: "Example" },
      issued_at: "2026-10-01T00:00:00Z",
      expires_at: "2027-10-01T00:00:00Z",
      trust_anchors: [],
      decisions: {},
      consent: { pre_decide: "never", forbid_kinds: ["payment"] },
    };
    expect(await extensionSchemaFailure(bundle, "policy-bundle-v0")).toBeNull();
    expect(await extensionSchemaFailure({ ...bundle, consent: { forbid_kinds: ["shell", "nope"] } }, "policy-bundle-v0")).not.toBeNull();
    expect(await extensionSchemaFailure({ ...bundle, consent: { pre_decide: "always" } }, "policy-bundle-v0")).not.toBeNull();
    const read = await readPolicyBundle(bundle);
    expect(read.consent).toEqual({ pre_decide: "never", forbid_kinds: ["payment"] });
    const { consent: _c, ...without } = bundle;
    expect((await readPolicyBundle(without)).consent).toBeNull();
  });

  it("the plan's conversation section is built from the package and bounded when read back (D-270)", async () => {
    const pkg = (await probePackage({ remoteTool: true })).pkg;
    const section = conversationPlan(pkg, "balanced", null)!;
    expect(section).toEqual({ max_turns: 4, hard_tokens: 16000, max_remote_calls: 4, max_calls_per_tool: { place: 2 }, persistent_keys: ["history", "orders"], consent_steps: [{ id: "confirm", permissions: ["orders.place"], kinds: ["payment"], pre_decided: null }], gated_permissions: { "orders.place": ["confirm"] } });
    expect(normalizeConversationPlan(section)).toEqual(section);
    expect(normalizeConversationPlan(null)).toBeNull();
    expect(() => normalizeConversationPlan({ ...section, max_turns: -1 })).toThrow(/nonnegative/u);
    expect(() => normalizeConversationPlan({ ...section, extra: 1 })).toThrow(/Unknown fields/u);
    expect(() => normalizeConversationPlan({ ...section, consent_steps: [{ ...section.consent_steps[0]!, pre_decided: { accepted: true, decided_by: "person" } }] })).toThrow(/preset or policy/u);
    const plain = (await probePackage({ remoteTool: true, mutate: (m) => { delete (m["graph.json"] as JsonObject).conversation; const graph = m["graph.json"] as JsonObject; graph.nodes = (graph.nodes as JsonObject[]).filter((item) => item.id !== "confirm"); node(m, "place").depends_on = ["interpret"]; (m["tools/place.tool.json"] as JsonObject).side_effects = "read"; const initial = (graph.initial_state as JsonObject).object as JsonObject; initial.history = { literal: [] }; initial.orders = { literal: [] }; } })).pkg;
    expect(conversationPlan(plain, "convenience", null)).toBeNull();
  });
});
