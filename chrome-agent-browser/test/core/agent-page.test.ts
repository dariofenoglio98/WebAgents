import { describe, expect, it } from "vitest";

import { agentPageModel, trustWords } from "../../src/core/agent-page.js";
import { evaluateSnapshot, evaluationLayers, publisherReport, type PublisherReport } from "../../src/core/evaluation.js";
import { publicKeyFromPem } from "../../src/core/keys.js";
import { buildSummary } from "../../src/core/summary.js";
import { MemoryTrustStorage, TrustStore } from "../../src/core/trust.js";
import { readBytes, readText, SHIPPED } from "../helpers/paths.js";

async function model(archive: string, pin?: { key: string; publisherId: string; prefix?: string }) {
  const evaluation = await evaluateSnapshot(readBytes(archive));
  const pkg = evaluation.package!;
  const trust = new TrustStore(new MemoryTrustStorage());
  if (pin) await trust.add(publicKeyFromPem(readText(pin.key)), { displayName: "Pinned", publisherId: pin.publisherId, packageIdPrefix: pin.prefix ?? null });
  const publisher = await publisherReport(pkg, trust);
  const summary = await buildSummary(pkg, { evaluation: evaluationLayers(evaluation), publisher });
  return { pkg, summary, page: agentPageModel(pkg, summary, { source: { kind: "website", display: "https://webair.example/agent.pkg", advertised_on: "https://webair.example/" }, archiveSha256: "ab".repeat(32) }) };
}

const report = (overrides: Partial<PublisherReport>): PublisherReport => ({
  claimed_id: "pub",
  claimed_name: "Publisher",
  signature_status: "valid",
  signature_reason: "self_consistent_ed25519_signature",
  signer_fingerprint: `sha256:${"a".repeat(64)}`,
  signed_digest_matches: true,
  trust_status: "unknown",
  trust_reason: "signer_key_not_pinned",
  trust_entry: null,
  ...overrides,
});

describe("trust in words (D-034): a valid signature never reads as a trusted publisher", () => {
  it("phrases each signature and trust state distinctly", () => {
    expect(trustWords(report({}))).toMatchObject({ headline: "Signed, publisher unknown", tone: "warn", can_pin: true });
    expect(trustWords(report({ trust_status: "trusted", trust_reason: "operator_pinned_key", trust_entry: { display_name: "WebAir demo" } }))).toMatchObject({
      headline: "Signed by a publisher you trust",
      tone: "good",
      can_pin: false,
    });
    expect(trustWords(report({ trust_status: "trusted", trust_reason: "operator_pinned_key", trust_entry: { display_name: "WebAir demo" } })).detail).toContain("WebAir demo");
    expect(trustWords(report({ trust_status: "mismatch", trust_reason: "claimed_publisher_pinned_to_other_key" }))).toMatchObject({
      headline: "Possible impersonation",
      tone: "bad",
      can_pin: false,
    });
    expect(trustWords(report({ trust_status: "mismatch", trust_reason: "package_id_outside_pinned_prefix" })).detail).toMatch(/other package ids/u);
    expect(trustWords(report({ signature_status: "invalid", signature_reason: "x", signer_fingerprint: null, trust_reason: "no_valid_signature" }))).toMatchObject({
      headline: "Signature invalid",
      tone: "bad",
      can_pin: false,
    });
    expect(trustWords(report({ signature_status: "absent", signer_fingerprint: null, trust_reason: "no_valid_signature" }))).toMatchObject({
      headline: "Unsigned",
      tone: "bad",
      can_pin: false,
    });
  });
});

describe("the agent-page model", () => {
  it("WebAir: identity, access grouped by kind in a person's order, tools, cost, source, technical details", async () => {
    const { pkg, summary, page } = await model(SHIPPED.webair.archive);
    expect(page.identity).toMatchObject({
      name: "WebAir Travel Agent",
      version: "0.3.0",
      package_id: "org.webagents.webair",
      publisher_name: "WebAir (fictional demo airline)",
      publisher_id: "webair-demo",
      execution_profile: "workflow.v0",
      runtime_status: "compatible",
    });
    expect(page.trust.headline).toBe("Signed, publisher unknown");
    expect(page.trust.can_pin).toBe(true);
    expect(page.about.description).toBe(pkg.manifest.description);
    expect(page.about.readme_path).toBe("README.md");
    expect(page.about.readme).toMatch(/^# WebAir Travel Agent/u);
    // Personal data and payment come first; every declared permission appears exactly once.
    expect(page.access.map((group) => group.kind)).toEqual(["personal.read", "payment", "network", "model", "memory"]);
    const personal = page.access.find((group) => group.kind === "personal.read")!;
    expect(personal.title).toBe("Your personal data it can ask for");
    expect(personal.items.map((item) => item.id)).toEqual(["profile.travel", "identity.passenger", "wallet.payment"]);
    expect(personal.items.every((item) => !item.required)).toBe(true);
    expect(personal.items[0]?.resources).toEqual(["personal.travel_profile"]);
    expect(personal.items[0]?.linked_tools).toEqual(["personal.travel_profile"]);
    const network = page.access.find((group) => group.kind === "network")!;
    expect(network.items[0]).toMatchObject({ id: "network.webair", required: true, resources: ["webagents-webair-production.up.railway.app"] });
    expect(network.items[0]?.linked_tools).toEqual(["get-fare-rules", "prepare-booking", "search-flights", "simulate-purchase"]);
    const declared = (pkg.policy.permissions as Array<{ id: string }>).map((permission) => permission.id).sort();
    expect(page.access.flatMap((group) => group.items.map((item) => item.id)).sort()).toEqual(declared);
    expect(page.tools.remote.map((tool) => tool.id)).toEqual(["get-fare-rules", "prepare-booking", "search-flights", "simulate-purchase"]);
    expect(page.tools.local.map((tool) => tool.id)).toEqual(["personal.passenger_identity", "personal.travel_profile", "wallet.payment_method"]);
    expect(page.tools.remote.find((tool) => tool.id === "simulate-purchase")).toMatchObject({ side_effects: "write", approval_required: true });
    expect(page.profiles).toBeNull();
    expect(page.profile_notes).toEqual([]);
    expect(page.source).toEqual({ kind: "website", display: "https://webair.example/agent.pkg", advertised_on: "https://webair.example/" });
    expect(page.cost.estimated_cost_usd).toBeNull();
    expect(page.cost.text).toMatch(/not stated/u);
    expect(page.cost.hard_tokens).toBe(120000);
    expect(page.technical.digest).toBe(SHIPPED.webair.digest);
    expect(page.technical.archive_sha256).toBe("ab".repeat(32));
    expect(page.technical.signer_fingerprint).toBe(SHIPPED.webair.fingerprint);
    expect(page.technical.extension_keys).toEqual(["org.webagents.webair:origin"]);
    expect(page.technical.warnings).toEqual(summary.warnings);
    expect(page.technical.manifest).toBe(pkg.manifest);
    expect(page.technical.validation.container_status).toBe("valid");
  });

  it("Literature Review: a trusted publisher reads as such; attestations are shown as declarations", async () => {
    const { page } = await model(SHIPPED.literatureReview.archive, {
      key: SHIPPED.literatureReview.key,
      publisherId: "webagents-research",
      prefix: "org.webagents.literature-review",
    });
    expect(page.trust.headline).toBe("Signed by a publisher you trust");
    expect(page.trust.can_pin).toBe(false);
    expect(page.access.map((group) => group.kind)).toEqual(["network", "files.read", "model", "memory"]);
    expect(page.technical.attestations).toHaveLength(2);
    expect(page.technical.attestations.every((item) => item.verified_by_host === false)).toBe(true);
    expect(page.technical.warnings.map((warning) => warning.code)).not.toContain("publisher_unknown");
  });

  it("a pin for another key makes the page say impersonation", async () => {
    const { page } = await model(SHIPPED.webair.archive, { key: SHIPPED.literatureReview.key, publisherId: "webair-demo" });
    expect(page.trust.headline).toBe("Possible impersonation");
    expect(page.trust.detail).toContain("WebAir (fictional demo airline)");
    expect(page.trust.can_pin).toBe(false);
  });
});
