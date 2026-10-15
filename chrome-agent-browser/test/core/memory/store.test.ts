/**
 * The memory store: the hub (M-22), writes under M-24 and the caps, identity replacement (M-44),
 * the digest (M-11), the resolver's view and legacy projection (M-15, M-17), the scan set (M-36),
 * recall (M-32), the registry (M-16), Tidy up (D-219), search (M-31), and the export → forget →
 * import round trip that reproduces every digest (M-60).
 */
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { canonicalJson } from "../../../src/core/canonical.js";
import { sha256Hex } from "../../../src/core/hash.js";
import { digestInput } from "../../../src/core/memory/digest.js";
import { documentToRecord } from "../../../src/core/memory/document.js";
import { type MemoryRecord, SELF_ID } from "../../../src/core/memory/model.js";
import { agentDocumentId, emptyMemorySnapshot, MemoryStore } from "../../../src/core/memory/store.js";
import { emptyStore, exampleStore, folderFiles, MEMORY_KEY, NOW, readJson, testIds, WEBAIR_EXAMPLE } from "../../helpers/memory.js";

const PROFILE = "mem_7c1f0a4e9b2d4c5e8f6a1b2c3d4e5f60";
const HEAD = "mem_9b8a7c6d5e4f30211203a4b5c6d7e8f9";
const IDENTITY = "mem_0a1b2c3d4e5f60718293a4b5c6d7e8f9";
const CARD = "mem_4e5f60718293a4b5c6d7e8f90a1b2c3d";
const SEAT = "mem_5f60718293a4b5c6d7e8f90a1b2c3d4e";
const NOTE = "mem_8d7e6f5a4b3c2d1e0f9a8b7c6d5e4f3a";

describe("opening a store", () => {
  it("creates exactly one hub on first open and repairs a store with two person.self records (M-22)", async () => {
    const fresh = await emptyStore();
    expect(fresh.get(SELF_ID)).toMatchObject({ id: "self", type: "person.self", title: "Me", source: { kind: "person" } });
    expect(fresh.size).toBe(1);
    const hub = fresh.get(SELF_ID)!;
    const twin: MemoryRecord = { ...hub, id: `mem_${"e".repeat(32)}`, title: "Other me", created: "2026-10-15T00:00:00Z", updated: "2026-10-15T00:00:00Z", fields: { display_name: "Other" } };
    const repaired = await MemoryStore.open({ key: MEMORY_KEY, snapshot: { ...emptyMemorySnapshot(), records: [twin, hub] }, now: () => NOW });
    expect(repaired.get(SELF_ID)!.title).toBe("Me");
    expect(repaired.get(twin.id)).toMatchObject({ type: "document.note", tags: ["type/person.self"] });
  });

  it("imports the WebAir example and digests every record under the key (M-11); another key gives other digests", async () => {
    const store = await exampleStore(WEBAIR_EXAMPLE);
    expect(store.size).toBe(7);
    const head = store.get(HEAD)!;
    expect(head.links).toEqual([
      { to: "self", rel: "about" },
      { to: SEAT, rel: "prefers" },
      { to: CARD, rel: "pays_with" },
      { to: PROFILE, rel: "supersedes" },
    ]);
    expect(head.body).toBe(`Used for most trips. Business only when someone else pays. Pack as in [[${NOTE}|Packing list]].`);
    const plain = await sha256Hex(canonicalJson(digestInput(head, store.types.get("travel.profile")!.schema_sha256)));
    expect(store.digestOf(HEAD)).toMatch(/^[0-9a-f]{64}$/u);
    expect(store.digestOf(HEAD)).not.toBe(plain);
    const other = await MemoryStore.open({ key: new Uint8Array(32).fill(9), snapshot: store.snapshot(), now: () => NOW });
    expect(other.digestOf(HEAD)).not.toBe(store.digestOf(HEAD));
    expect(store.graph.superseded.has(PROFILE)).toBe(true);
    expect(store.view(PROFILE)!.superseded_by).toBe(HEAD);
  });
});

describe("writes (M-24, M-44, D-212)", () => {
  it("create adds the type's default links, resolves body wikilinks, replaces an identity match, and refuses sealed values in text", async () => {
    const store = await exampleStore(WEBAIR_EXAMPLE, { newId: testIds(1) });
    const first = await store.create({ type: "person.preference", title: "Coffee", fields: { domain: "food", key: "coffee", value: "espresso" }, body: "As on the [[Packing list]]." });
    expect(first.replaced).toBeNull();
    expect(first.record.links).toEqual([{ to: "self", rel: "about" }]);
    expect(first.record.body).toBe(`As on the [[${NOTE}|Packing list]].`);
    expect(first.record.source).toEqual({ kind: "person" });
    const second = await store.create({ type: "person.preference", title: "Coffee again", fields: { domain: "Food", key: "COFFEE", value: "lungo" } });
    expect(second.replaced).toBe(first.record.id);
    expect(second.record.links).toContainEqual({ to: first.record.id, rel: "supersedes" });
    expect(store.graph.superseded.has(first.record.id)).toBe(true);
    const kept = await store.create({ type: "person.preference", title: "Coffee kept", fields: { domain: "food", key: "coffee", value: "ristretto" }, identity: "keep_both" });
    expect(kept.replaced).toBeNull();
    await expect(store.create({ type: "person.identity", title: "Alex alex.traveler@example.com", fields: { given_name: "A", family_name: "B", email: "alex.traveler@example.com" } })).rejects.toMatchObject({ code: "sealed_value_in_text" });
    await expect(store.create({ type: "person.identity", title: "Short", fields: { given_name: "A", family_name: "B", email: "a@b" } })).rejects.toMatchObject({ code: "schema_validation" });
    await expect(store.create({ type: "person.identity", title: "Undeclared", fields: { given_name: "A", family_name: "B", email: "ab@example.com" }, sealed: ["/nope"] })).rejects.toMatchObject({ code: "sealed_field_invalid" });
    await expect(store.create({ type: "document.note", title: "Marker", fields: {}, body: "text\n<!-- memory.v0 links -->\nmore" })).rejects.toMatchObject({ code: "body_reserved_marker" });
    await expect(store.create({ type: "document.note", title: "Marker in a sentence", fields: {}, body: "the <!-- memory.v0 links --> string is text" })).resolves.toBeDefined();
    await expect(store.create({ type: "document.note", title: "Big", fields: {}, body: "x".repeat(16_385) })).rejects.toMatchObject({ code: "memory_record_too_large" });
    await expect(store.create({ type: "person.self", title: "Another me", fields: { display_name: "x" } })).rejects.toMatchObject({ code: "memory_type_reserved" });
  });

  it("edit keeps the source and moves updated; supersedes is acyclic and single; self cannot be deleted; deletion leaves links dangling", async () => {
    const store = await exampleStore(WEBAIR_EXAMPLE, { now: new Date("2026-10-16T10:00:00Z") });
    const edited = await store.edit(SEAT, { body: "Changed." });
    expect(edited.updated).toBe("2026-10-16T10:00:00Z");
    expect(edited.source.kind).toBe("package");
    await expect(store.edit(PROFILE, { links: [{ to: HEAD, rel: "supersedes" }] })).rejects.toMatchObject({ code: "supersedes_cycle" });
    await expect(store.edit(SEAT, { links: [{ to: PROFILE, rel: "supersedes" }] })).rejects.toMatchObject({ code: "superseded_twice" });
    expect(() => store.delete(SELF_ID)).toThrow("Me record");
    expect(store.delete(NOTE)).toBe(true);
    expect(store.graph.dangling.map((edge) => [edge.from, edge.to, edge.source])).toEqual([
      [PROFILE, NOTE, "body"],
      [HEAD, NOTE, "body"],
    ]);
    expect(store.tidy().dangling.sort()).toEqual([PROFILE, HEAD].sort());
  });

  it("the caps refuse and never evict (memory_full)", async () => {
    const store = await emptyStore();
    const records: MemoryRecord[] = [];
    for (let index = 0; index < 8191; index += 1) records.push({ id: `mem_${index.toString(16).padStart(32, "0")}`, type: "document.note", title: `n${index}`, scope: "user", created: "2026-10-14T00:00:00Z", updated: "2026-10-14T00:00:00Z", source: { kind: "person" }, fields: {}, body: "" });
    const full = await MemoryStore.open({ key: MEMORY_KEY, snapshot: { ...emptyMemorySnapshot(), records }, now: () => NOW, newId: testIds(99) });
    expect(full.size).toBe(8192);
    await expect(full.create({ type: "document.note", title: "one more", fields: {} })).rejects.toMatchObject({ code: "memory_full" });
    expect(full.size).toBe(8192);
    void store;
  });
});

describe("the resolver (M-15, M-17, M-35, M-36)", () => {
  it("returns the view for a memory grant with ungranted links hidden, the legacy projection for a personal.read grant, and refuses a moved digest", async () => {
    const store = await exampleStore(WEBAIR_EXAMPLE);
    store.grantedIds = new Set([PROFILE, IDENTITY, CARD]);
    const view = store.resolve({ permission_id: "memory.travel_profile", resource_type: "travel.profile", resource_id: PROFILE, resource_digest: store.digestOf(PROFILE)! });
    expect(view).toEqual(readJson<{ output: unknown }>(join(WEBAIR_EXAMPLE, "fixture", "travel.profile.json")).output);
    const identity = store.resolve({ permission_id: "identity.passenger", resource_type: "personal.passenger_identity", resource_id: IDENTITY, resource_digest: store.digestOf(IDENTITY)! });
    expect(identity).toEqual({ given_name: "Alex", family_name: "Traveler", contact_email: "alex.traveler@example.com" });
    const card = store.resolve({ permission_id: "wallet.payment", resource_type: "wallet.payment_method", resource_id: CARD, resource_digest: store.digestOf(CARD)! });
    expect(card).toEqual({ payment_method_id: "demo-visa-4242", display: "Demo Visa •••• 4242" });
    expect(() => store.resolve({ permission_id: "x", resource_type: "travel.profile", resource_id: PROFILE, resource_digest: "0".repeat(64) })).toThrow("no longer the one");
    expect(() => store.resolve({ permission_id: "x", resource_type: "person.identity", resource_id: CARD, resource_digest: store.digestOf(CARD)! })).toThrow("no longer the one");
    expect(store.scanSet()).toEqual([
      { record_id: IDENTITY, pointer: "/email", value: "alex.traveler@example.com" },
      { record_id: CARD, pointer: "/payment_method_id", value: "demo-visa-4242" },
    ]);
    expect([...store.sealedValues().keys()]).toEqual([IDENTITY, CARD]);
    expect(store.legacySealed("personal.passenger_identity")).toEqual(["/contact_email"]);
  });
});

describe("recall and the registry (M-16, M-32, M-34)", () => {
  it("ranks heads only, about-self first, the same package's reads next, and lists candidates in that order with view digests", async () => {
    const store = await exampleStore(WEBAIR_EXAMPLE, { now: new Date("2026-10-20T12:00:00Z") });
    const candidates = store.recall("travel.profile", "org.webagents.webair");
    expect(candidates.map((candidate) => candidate.id)).toEqual([HEAD]);
    expect(candidates[0]!.signals).toMatchObject({ about_self: true, same_package: "2026-10-14T11:03:00Z", expired: false });
    expect(candidates[0]!.score).toBe(14);
    const work = await store.create({ type: "travel.profile", title: "Work travel profile", fields: { home_airport: "ZRH", preferred_cabin: "business", prefer_nonstop: false, preferred_currency: "CHF" }, links: [] });
    await store.edit(work.record.id, { links: [] });
    const again = store.recall("travel.profile", "org.webagents.webair");
    expect(again.map((candidate) => [candidate.id, candidate.score])).toEqual([
      [HEAD, 14],
      [work.record.id, 0],
    ]);
    const stranger = store.recall("travel.profile", "org.example.other", [SEAT]);
    expect(stranger[0]!.signals.linked_to).toEqual([SEAT]);
    expect(stranger[0]!.score).toBe(12);
    const registry = await store.registry({ runtimeVersion: "0.2.0", now: new Date("2026-10-20T12:00:00Z"), requested: ["travel.profile", "personal.passenger_identity", "wallet.payment_method", "nothing.here"], packageId: "org.webagents.webair" });
    expect(registry.types.map((type) => [type.id, type.permission_kind, type.schema_sha256 === store.types.get("travel.profile")!.view_sha256])).toEqual([
      ["travel.profile", "memory.read", true],
      ["personal.passenger_identity", "personal.read", false],
      ["wallet.payment_method", "personal.read", false],
    ]);
    expect(registry.resources.map((resource) => [resource.id, resource.type])).toEqual([
      [HEAD, "travel.profile"],
      [work.record.id, "travel.profile"],
      [IDENTITY, "personal.passenger_identity"],
      [CARD, "wallet.payment_method"],
    ]);
    expect(registry.resources[0]!.digest).toBe(store.digestOf(HEAD));
    expect(store.sealedType("personal.passenger_identity")).toBe(true);
    expect(store.sealedType("travel.profile")).toBe(false);
  });

  it("an expired record is demoted, and the text index finds titles, fields and bodies but never a sealed value", async () => {
    const store = await exampleStore(WEBAIR_EXAMPLE, { now: new Date("2026-10-20T12:00:00Z") });
    await store.edit(CARD, { valid_until: "2020-01-01" });
    expect(store.recall("payment.card", "org.webagents.webair")[0]!.signals.expired).toBe(true);
    expect(store.tidy().expired).toEqual([CARD]);
    expect(store.search("packing")[0]!.id).toBe(NOTE); // the title outweighs the two bodies that link to it
    expect(store.search("BOS").map((hit) => hit.id).sort()).toEqual([PROFILE, HEAD].sort());
    expect(store.search("alex.traveler@example.com")).toEqual([]);
    expect(store.search("demo-visa-4242")).toEqual([]);
    expect(store.search("Traveler")[0]!.id).toBe(IDENTITY);
  });
});

describe("export and import (M-55…M-60)", () => {
  it("export → forget → import reproduces every record byte for byte and every digest; omitted sealed values are restored by id into the same store", async () => {
    const store = await exampleStore(WEBAIR_EXAMPLE);
    await store.create({ type: "document.note", title: "A note with [brackets]", fields: {}, body: "Links: [[Packing list]], \\[[Packing list]], [[Trip ideas]], [[self|me]]." });
    const before = store.snapshot();
    const digests = new Map([...before.records].map((record) => [record.id, store.digestOf(record.id)!]));
    const files = store.export({ runtimeLabel: "chrome-agent-browser core 0.2.0", now: NOW, includeSealed: true, includeAgents: true });
    expect(files.map((file) => file.path)).toContain("index.md");
    expect(files.find((file) => file.path === "memory-usage.json")!.text).toContain('"use": "accepted"');
    await store.forget();
    expect(store.size).toBe(1);
    const report = store.planImport(files);
    expect(report.counts).toMatchObject({ refused: 0, incomplete: 0, hub: 1, added: before.records.length - 1 });
    await store.applyImport(report);
    const after = store.snapshot();
    const byId = new Map(after.records.map((record) => [record.id, record]));
    for (const record of before.records) {
      expect(byId.get(record.id), record.id).toEqual(record);
      expect(store.digestOf(record.id), record.id).toBe(digests.get(record.id));
    }
    expect(after.usage).toEqual(before.usage);
    // Omitted: the placeholders are written only where a value exists and restored from the store by id.
    const omitted = store.export({ runtimeLabel: "chrome-agent-browser core 0.2.0", now: NOW, includeSealed: false, includeAgents: true });
    const identityFile = omitted.find((file) => file.path.startsWith("person.identity/"))!;
    expect(identityFile.text).toContain('email: "sealed:omitted"');
    expect(identityFile.text).not.toContain("alex.traveler@example.com");
    const plan = store.planImport(omitted);
    expect(plan.counts).toMatchObject({ same: before.records.length, hub: 0, sealed_restored: 2 });
    // Into an empty store the identity is incomplete (e-mail required) and the card is not (its sealed field is required too).
    const empty = await emptyStore();
    const emptyPlan = empty.planImport(omitted);
    expect(emptyPlan.items.filter((item) => item.outcome.kind === "incomplete").map((item) => item.path).sort()).toEqual([identityFile.path, omitted.find((file) => file.path.startsWith("payment.card/"))!.path].sort());
    const applied = await empty.applyImport(emptyPlan, { completions: { [identityFile.path]: { "/email": "typed@example.com" } } });
    expect(applied.skipped).toEqual([omitted.find((file) => file.path.startsWith("payment.card/"))!.path]);
    expect(empty.get(IDENTITY)!.fields.email).toBe("typed@example.com");
  });

  it("a differing record with the same id is written as the newer and the older kept under a fresh id, superseded; an unknown type becomes a note; a file without frontmatter becomes a note", async () => {
    const store = await exampleStore(WEBAIR_EXAMPLE, { now: new Date("2026-10-20T12:00:00Z"), newId: testIds(3) });
    const files = store.export({ runtimeLabel: "x", now: NOW, includeSealed: true, includeAgents: false });
    const seatFile = files.find((file) => file.path.startsWith("travel.preference/"))!;
    const edited = seatFile.text.replace('value: "aisle"', 'value: "window"').replace('updated: "2026-10-14T11:03:00Z"', 'updated: "2026-10-21T00:00:00Z"');
    const unknown = { path: "org.example-thing/Odd.md", text: `---\nid: "mem_${"f".repeat(32)}"\ntype: "org.example:thing"\ntitle: "Odd"\nscope: "user"\ncreated: "2026-10-14T00:00:00Z"\nupdated: "2026-10-14T00:00:00Z"\nsize: 3\nsource:\n  kind: "person"\n---\n\nA thing.\n` };
    const bare = { path: "notes/Loose.md", text: "Just text, no frontmatter.\n" };
    const report = store.planImport([{ path: seatFile.path, text: edited }, unknown, bare]);
    const outcomes = Object.fromEntries(report.items.map((item) => [item.path, item.outcome.kind]));
    expect(outcomes).toEqual({ [seatFile.path]: "update", [unknown.path]: "add", [bare.path]: "add" });
    expect(report.counts.became_notes).toBe(2);
    await store.applyImport(report);
    const seat = store.get(SEAT)!;
    expect(seat.fields.value).toBe("window");
    const older = seat.links!.find((link) => link.rel === "supersedes")!.to;
    expect(store.get(older)!.fields.value).toBe("aisle");
    const odd = store.get(`mem_${"f".repeat(32)}`)!;
    // The tag pattern admits neither `.` nor `:`, so the original id is folded into the tag's alphabet (a spec nit, noted for T20).
    expect(odd).toMatchObject({ type: "document.note", tags: ["type/org-example-thing"] });
    expect(odd.body).toContain("| size | 3 |");
    expect(store.all().find((record) => record.title === "Loose")!.body).toBe("Just text, no frontmatter.");
    expect(() => documentToRecord("---\nid: x\n---\n")).not.toThrow();
  });
});

describe("agent documents (M-49, M-50)", () => {
  it("one per package id, never resolved, never indexed, never recalled, replaced on commit", async () => {
    const store = await emptyStore();
    const first = await store.commitAgent({ package_id: "org.webagents.literature-review", package_version: "0.2.8", run_id: "r1", name: "Literature Review Agent", body: "# Notes\n- [[self]] and [[Dario]]", at: "2026-10-14T12:39:55Z" });
    expect(first.id).toBe("agent_174749d5c5b954b6");
    expect(agentDocumentId("org.webagents.literature-review")).toBe(first.id);
    expect(first.body).toBe("# Notes\n- [[self]] and [[Dario]]");
    expect(store.graph.edges.filter((edge) => edge.from === first.id)).toEqual([]);
    expect(store.search("Notes")).toEqual([]);
    const again = await store.commitAgent({ package_id: "org.webagents.literature-review", package_version: "0.2.8", run_id: "r2", name: "Literature Review Agent", body: "later", at: "2026-10-15T12:39:55Z" });
    expect(again.created).toBe("2026-10-14T12:39:55Z");
    expect(store.all().filter((record) => record.scope === "agent").length).toBe(1);
    expect(store.tidy().agents).toEqual([first.id]);
    expect(store.usage.map((entry) => entry.use)).toEqual(["agent_write", "agent_write"]);
    await expect(store.edit(first.id, { body: "x" })).rejects.toMatchObject({ code: "memory_type_reserved" });
    expect(store.recall("agent.memory", "org.webagents.literature-review")).toEqual([]);
    const files = store.export({ runtimeLabel: "x", now: NOW, includeSealed: false, includeAgents: true });
    expect(files.map((file) => file.path)).toContain("agent.memory/Literature Review Agent.md");
    const folder = folderFiles(join(WEBAIR_EXAMPLE, "memory"));
    expect(folder.length).toBeGreaterThan(0);
  });
});
