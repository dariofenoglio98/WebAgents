/**
 * Proposals (§7.2): the checks of M-40 in order over the two worked examples and the negative
 * cases of §10 that need no runtime (N1, N2, N8, N9, N13, N14, N15, N19, N22); acceptance (M-42)
 * reproduces the WebAir example's head, its carried links and its usage entries.
 */
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { JsonObject } from "../../../src/core/json.js";
import { checkProposals, ProposalRefusal, type ProposalsDocument, type ProposalCheckInput, sealedFreeSchema } from "../../../src/core/memory/proposals.js";
import { exampleStore, LITERATURE_EXAMPLE, readJson, testIds, WEBAIR_EXAMPLE } from "../../helpers/memory.js";

const PROFILE = "mem_7c1f0a4e9b2d4c5e8f6a1b2c3d4e5f60";
const HEAD = "mem_9b8a7c6d5e4f30211203a4b5c6d7e8f9";
const IDENTITY = "mem_0a1b2c3d4e5f60718293a4b5c6d7e8f9";
const CARD = "mem_4e5f60718293a4b5c6d7e8f90a1b2c3d";
const NOTE = "mem_8d7e6f5a4b3c2d1e0f9a8b7c6d5e4f3a";
const RUN = "7f9d1c2e-5b4a-4c3d-9e8f-0a1b2c3d4e5f";

async function webairInput(): Promise<{ input: ProposalCheckInput; document: ProposalsDocument; store: Awaited<ReturnType<typeof exampleStore>> }> {
  const store = await exampleStore(WEBAIR_EXAMPLE, { newId: testIds(4) });
  // The run that produced proposals.json was granted the old profile, the identity and the card (plan.grants.json).
  const granted = new Map<string, string>([
    [PROFILE, "travel.profile"],
    [IDENTITY, "person.identity"],
    [CARD, "payment.card"],
  ]);
  const targets = new Map([...granted.keys()].map((id) => [id, store.get(id)!] as const));
  const document = readJson<ProposalsDocument>(join(WEBAIR_EXAMPLE, "proposals.json"));
  return { input: { declared: new Set(["travel.preference", "travel.profile"]), granted, targets, types: store.types, scan: store.scanSet() }, document, store };
}

async function refusal(promise: Promise<unknown>): Promise<ProposalRefusal> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ProposalRefusal) return error;
    throw error;
  }
  throw new Error("expected a refusal");
}

function withProposal(document: ProposalsDocument, index: number, changes: Partial<ProposalsDocument["proposals"][number]>): JsonObject {
  const copy = JSON.parse(JSON.stringify(document)) as ProposalsDocument;
  copy.proposals[index] = { ...copy.proposals[index]!, ...changes } as ProposalsDocument["proposals"][number];
  return copy as unknown as JsonObject;
}

describe("the checks of M-40 over the worked examples", () => {
  it("the WebAir document passes: the update echoes the view body with the Packing list link hidden (M-15)", async () => {
    const { input, document } = await webairInput();
    const checked = await checkProposals(document as unknown as JsonObject, input);
    expect(checked.proposals.length).toBe(2);
    expect(checked.proposals[1]!.body).toContain("[[Packing list]]");
    expect(readJson<{ output: { body: string } }>(join(WEBAIR_EXAMPLE, "fixture", "travel.profile.json")).output.body).toBe(checked.proposals[1]!.body);
  });

  it("the Literature Review document passes with the profile granted", async () => {
    const store = await exampleStore(LITERATURE_EXAMPLE);
    const profile = "mem_60718293a4b5c6d7e8f90a1b2c3d4e5f";
    const document = readJson<JsonObject>(join(LITERATURE_EXAMPLE, "proposals.json"));
    const checked = await checkProposals(document, { declared: new Set(["research.review"]), granted: new Map([[profile, "research.profile"]]), targets: new Map([[profile, store.get(profile)!]]), types: store.types, scan: store.scanSet() });
    expect(checked.proposals[0]!.links).toEqual([{ to: profile, rel: "derived_from" }]);
  });

  it("refuses the negative cases with the spec's codes, proposal by proposal (N1, N2, N8, N9, N13, N14, N15, N19, N22)", async () => {
    const { input, document } = await webairInput();
    const expect_ = async (label: string, doc: JsonObject, code: string, reason: string | null, index: number | null) => {
      const refused = await refusal(checkProposals(doc, input));
      expect([refused.code, refused.reason, refused.index], label).toEqual([code, reason, index]);
    };
    await expect_("N1 undeclared type", withProposal(document, 0, { type: "person.preference" }), "permission_denied", "memory_proposal_type_undeclared", 0);
    await expect_("N1 reserved type", withProposal(document, 0, { type: "person.self" }), "permission_denied", "memory_proposal_type_undeclared", 0);
    await expect_("N2 sealed field", withProposal(document, 0, { type: "travel.profile", fields: { home_airport: "BOS", preferred_cabin: "economy", prefer_nonstop: true, preferred_currency: "USD", email: "x" } }), "schema_validation", null, 0);
    const identityInput: ProposalCheckInput = { ...input, declared: new Set([...input.declared, "person.identity"]) };
    const sealedField = await refusal(checkProposals(withProposal(document, 0, { type: "person.identity", fields: { given_name: "A", family_name: "B", email: "someone@example.org" } }), identityInput));
    expect([sealedField.code, sealedField.reason]).toEqual(["schema_validation", "memory_proposal_sealed_field"]);
    await expect_("N8 ungranted target", withProposal(document, 1, { target: HEAD }), "permission_denied", "memory_proposal_target_not_granted", 1);
    await expect_("N9 bad sibling", withProposal(document, 1, { links: [{ to: "#9", rel: "prefers" }] }), "schema_validation", null, null);
    await expect_("N9 self-link", withProposal(document, 1, { links: [{ to: "#1", rel: "prefers" }] }), "schema_validation", null, 1);
    await expect_("N13 sealed value in a field", withProposal(document, 0, { fields: { kind: "seat", value: "alex.traveler@example.com" } }), "permission_denied", "sealed_value_in_proposal", null);
    await expect_("N13 sealed value in the rationale", withProposal(document, 0, { rationale: "card demo-visa-4242" }), "permission_denied", "sealed_value_in_proposal", null);
    await expect_("N14 ungranted link", withProposal(document, 0, { links: [{ to: NOTE, rel: "related" }] }), "permission_denied", "memory_proposal_link_not_granted", 0);
    await expect_("N14 ungranted id in the body", withProposal(document, 0, { body: `See [[${NOTE}|Packing list]].` }), "permission_denied", "memory_proposal_link_not_granted", 0);
    await expect_("N15 supersedes link", withProposal(document, 1, { links: [{ to: PROFILE, rel: "supersedes" as never }] }), "schema_validation", null, null);
    // N19: index 0 links to an ungranted id and index 1 is of an undeclared type: index 0's step 6 is reported.
    const two = withProposal(withProposal(document, 0, { links: [{ to: NOTE, rel: "related" }] }), 1, { type: "person.preference" });
    await expect_("N19", two, "permission_denied", "memory_proposal_link_not_granted", 0);
    await expect_("N22 marker line", withProposal(document, 0, { body: "text\n<!-- memory.v0 links -->\nmore" }), "schema_validation", null, null);
    await expect_("N22 CRLF marker line", withProposal(document, 0, { body: "text\r\n<!-- memory.v0 links -->\r\nmore" }), "schema_validation", null, null);
    const inline = await checkProposals(withProposal(document, 0, { body: "the <!-- memory.v0 links --> string inside a line" }), input);
    expect(inline.proposals.length).toBe(2);
    expect(sealedFreeSchema(input.types.get("person.identity")!).required).toEqual(["given_name", "family_name"]);
  });
});

describe("acceptance (M-42, M-44)", () => {
  it("accepting both WebAir proposals writes the seat preference and the profile head exactly as the example folder holds them", async () => {
    const { input, document, store } = await webairInput();
    // Start from the state before acceptance: the head is not there yet.
    store.delete(HEAD);
    store.delete("mem_5f60718293a4b5c6d7e8f90a1b2c3d4e");
    void input;
    const outcome = await store.accept({
      proposals: document,
      decisions: [
        { index: 1, decision: "accept" },
        { index: 0, decision: "accept" },
      ],
      package: { package_id: "org.webagents.webair", package_version: "0.6.0", run_id: RUN },
      granted: new Set([PROFILE, IDENTITY, CARD]),
      proposedAt: "2026-10-14T11:02:10Z",
    });
    expect(outcome.rejected).toEqual([]);
    const [seat, head] = outcome.accepted;
    expect(seat!.record).toMatchObject({ type: "travel.preference", title: "Aisle seat", links: [{ to: "self", rel: "about" }], source: { kind: "package", package_id: "org.webagents.webair", run_id: RUN, proposal: 0 } });
    expect(head!.supersedes).toBe(PROFILE);
    expect(head!.record.links).toEqual([
      { to: "self", rel: "about" },
      { to: seat!.record.id, rel: "prefers" },
      { to: CARD, rel: "pays_with" },
      { to: PROFILE, rel: "supersedes" },
    ]);
    // The hidden Packing list link is restored at its position (M-42); the old profile is superseded.
    expect(head!.record.body).toBe(`Used for most trips. Business only when someone else pays. Pack as in [[${NOTE}|Packing list]].`);
    // Carried over from the target (D-213): its out-links the proposal did not carry, `supersedes` excepted.
    expect(head!.kept).toEqual({ sealed: [], links: [{ to: "self", rel: "about" }, { to: CARD, rel: "pays_with" }], related: [] });
    expect(store.graph.superseded.has(PROFILE)).toBe(true);
    const written = new Set([seat!.record.id, head!.record.id]);
    expect(store.usage.filter((entry) => entry.run_id === RUN && written.has(entry.record_id)).map((entry) => [entry.use, entry.at])).toEqual([
      ["proposed", "2026-10-14T11:02:10Z"],
      ["proposed", "2026-10-14T11:02:10Z"],
      ["accepted", "2026-10-14T14:00:00Z"],
      ["accepted", "2026-10-14T14:00:00Z"],
    ]);
  });

  it("a rejected sibling drops the link with a note; an edit's typed sealed value fills a create; a dropped hidden occurrence is kept as related; a replaced target offers the head", async () => {
    const { document, store } = await webairInput();
    const only = await store.accept({ proposals: document, decisions: [{ index: 1, decision: "accept", edits: { body: "No packing list here." } }, { index: 0, decision: "reject" }], package: { package_id: "org.webagents.webair", package_version: "0.6.0", run_id: "run-2" }, granted: new Set([PROFILE, IDENTITY, CARD]), proposedAt: "2026-10-15T00:00:00Z" });
    expect(only.rejected).toEqual([0]);
    const head = only.accepted[0]!;
    expect(head.dropped_links).toEqual(["#0"]);
    // The target PROFILE is already superseded by HEAD in the example: the head is replaced instead.
    expect(head.supersedes).toBe(HEAD);
    expect(head.kept.related).toEqual([NOTE]);
    expect(head.record.links).toContainEqual({ to: NOTE, rel: "related" });
    expect(head.record.body).toBe("No packing list here.");
    const identityDocument: ProposalsDocument = { schema: "memory.v0 proposals", proposals: [{ action: "create", type: "person.identity", title: "Sam", fields: { given_name: "Sam", family_name: "Traveler" }, rationale: "x" }] };
    const typed = await store.accept({ proposals: identityDocument, decisions: [{ index: 0, decision: "accept", edits: { sealed_values: { "/email": "sam@example.org" } } }], package: { package_id: "org.webagents.webair", package_version: "0.6.0", run_id: "run-3" }, granted: new Set(), proposedAt: "2026-10-15T00:00:00Z" });
    expect(typed.accepted[0]!.record.fields.email).toBe("sam@example.org");
    expect(typed.accepted[0]!.record.sealed).toEqual(["/email", "/phone", "/date_of_birth"]);
    // M-44: another identity with the same e-mail replaces it unless kept.
    const again = await store.accept({ proposals: identityDocument, decisions: [{ index: 0, decision: "accept", edits: { sealed_values: { "/email": "SAM@example.org" } } }], package: { package_id: "org.webagents.webair", package_version: "0.6.0", run_id: "run-4" }, granted: new Set(), proposedAt: "2026-10-15T00:00:00Z" });
    expect(again.accepted[0]!.supersedes).toBe(typed.accepted[0]!.record.id);
    await expect(store.accept({ proposals: identityDocument, decisions: [{ index: 0, decision: "accept" }], package: { package_id: "org.webagents.webair", package_version: "0.6.0", run_id: "run-5" }, granted: new Set(), proposedAt: "2026-10-15T00:00:00Z" })).rejects.toMatchObject({ code: "schema_validation" });
  });
});
