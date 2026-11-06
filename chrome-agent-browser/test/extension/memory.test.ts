/**
 * The memory in the shell (T19, memory.v0): rows sealed at rest and reopened under the same keys,
 * the one-time vault migration with its report (M-66), a locked store that reads and never
 * writes (M-10), edits that keep a sealed value the page never held, export → forget → import
 * reproducing every digest (§8), the review of a run's proposals applied together (M-42), a
 * settled run's agent document committed at host.finished or kept pending while locked (M-50),
 * the recall card's modes per preset (M-52), and the presets and the policy's memory rules (M-54).
 */
import { describe, expect, it } from "vitest";

import { defaultDecisions, profileDecisions } from "../../src/core/authorization.js";
import { CoreError } from "../../src/core/errors.js";
import type { JsonObject } from "../../src/core/json.js";
import { applyPolicy, type ActivePolicy } from "../../src/core/policies/apply.js";
import { readPolicyBundle } from "../../src/core/policies/bundle.js";
import type { AuthorizationView, MemoryView, RunReviewView, SessionView } from "../../src/extension/messages.js";
import { openRecord, sealRecord } from "../../src/extension/storage/memory.js";
import type { StoredRun } from "../../src/extension/storage/runs.js";
import { customType, type MemoryType } from "../../src/core/memory/types.js";
import { MAX_AGENT_BODY_CHARS } from "../../src/core/memory/model.js";
import { vi } from "vitest";
import { memoryPackage, VALID_PROPOSALS } from "../helpers/memory-package.js";
import { SHIPPED } from "../helpers/paths.js";
import { DEMO, makeHarness, OFFSCREEN, PAGE, SEED_PASSPHRASE, SITE_ORIGIN, WEBAIR_040_URL, type Harness } from "../helpers/shell.js";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ROOT } from "../helpers/paths.js";

async function refused(promise: Promise<unknown>): Promise<CoreError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof CoreError) return error;
    throw error;
  }
  throw new Error("expected a CoreError");
}

const view = (h: Harness) => h.controller.handle({ type: "memory.get" }, PAGE) as Promise<MemoryView>;

describe("rows at rest (D-221)", () => {
  it("seals every sealed value under the data key with the record and the pointer as associated data, and a tampered box marks the record unreadable", async () => {
    const key = new Uint8Array(32).fill(5);
    const record = { id: "mem_" + "a".repeat(32), type: "person.identity", title: "A", scope: "user" as const, created: "2026-10-14T00:00:00Z", updated: "2026-10-14T00:00:00Z", source: { kind: "person" as const }, fields: { given_name: "Alex", email: "alex@example.com" }, sealed: ["/email"], body: "" };
    const row = await sealRecord(record, key);
    expect(row.record.fields.email).toBe("sealed:omitted");
    expect(JSON.stringify(row)).not.toContain("alex@example.com");
    expect(Object.keys(row.sealed_values)).toEqual(["/email"]);
    const opened = await openRecord(row, key);
    expect(opened).toEqual({ record, unreadable: false });
    const locked = await openRecord(row, null);
    expect(locked.record.fields.email).toBe("sealed:omitted");
    expect(locked.unreadable).toBe(false);
    const otherKey = await openRecord(row, new Uint8Array(32).fill(6));
    expect(otherKey.unreadable).toBe(true);
    expect(otherKey.record.fields.email).toBe("sealed:omitted");
    // The same box under another record id does not open: the associated data names the record.
    const moved = await openRecord({ ...row, id: "mem_" + "b".repeat(32), record: { ...row.record, id: "mem_" + "b".repeat(32) } }, key);
    expect(moved.unreadable).toBe(true);
  });

  it("another worker over the same rows and envelope reads the same records; a changed data key leaves the sealed values unreadable and Tidy up lists them", async () => {
    const h = makeHarness();
    await h.controller.handle({ type: "memory.installDemo" }, PAGE);
    const again = makeHarness({ stores: { snapshots: h.snapshots, trustStorage: h.trustStorage, tabs: h.tabs, settingsArea: h.settingsArea, secrets: { envelope: h.envelope, unlocked: h.unlocked } }, memoryStorage: h.memoryStorage });
    const second = await view(again);
    expect(second.records.filter((record) => record.demo)).toHaveLength(6);
    expect(((await again.controller.handle({ type: "memory.reveal", recordId: DEMO.alex, pointer: "/email" }, PAGE)) as { value: string }).value).toBe("alex.traveler@example.com");
    // The secret store forgotten and set up again: new keys, old rows.
    await h.controller.handle({ type: "secrets.forget", confirmation: "forget" }, PAGE);
    await h.controller.handle({ type: "secrets.setup", passphrase: "a new passphrase of mine" }, PAGE);
    const after = await view(h);
    expect(after.records.find((record) => record.id === DEMO.alex)?.unreadable).toBe(true);
    expect(after.tidy.unreadable).toContain(DEMO.alex);
    expect(after.records.find((record) => record.id === DEMO.traveler)?.unreadable).toBe(false); // no sealed field
    expect((await refused(h.controller.handle({ type: "memory.reveal", recordId: DEMO.alex, pointer: "/email" }, PAGE))).code).toBe("sealed_value_unreadable");
  });
});

describe("the vault migration (M-66, D-221)", () => {
  it("moves every vault record on the first unlocked open, reports it, keeps the vault until Done, and never runs twice", async () => {
    const h = makeHarness();
    const demo = JSON.parse(readFileSync(resolve(ROOT, "chrome-agent-browser/src/extension/data/demo-host-resources.json"), "utf8")) as { types: JsonObject[]; resources: JsonObject[] };
    const vault = {
      schema: "chrome-agent-browser-vault-v0",
      types: demo.types.map((type) => ({ id: type.id, display_name: type.display_name, description: type.description ?? null, permission_kind: type.permission_kind, schema: type.schema, sealed_fields: type.sealed_fields ?? [] })),
      records: [
        { id: "my_profile", type: "personal.travel_profile", label: "Me — ZRH", value: { home_airport: "ZRH", preferred_cabin: "economy", prefer_nonstop: false, preferred_currency: "CHF" }, demo: false, created_at: "2026-09-01T00:00:00Z", updated_at: "2026-09-02T00:00:00Z" },
        { id: "passenger_demo_alex", type: "personal.passenger_identity", label: "Alex Traveler", value: { given_name: "Alex", family_name: "Traveler", contact_email: "alex.traveler@example.com" }, demo: true, created_at: "2026-09-01T00:00:00Z", updated_at: "2026-09-01T00:00:00Z" },
      ],
    };
    await h.settings.saveVaultDocument(vault as never);
    const first = await view(h);
    expect(first.migration).not.toBeNull();
    expect(first.migration!.total).toBe(2);
    expect(first.migration!.failed).toBe(0);
    expect(first.migration!.mappings.map((mapping) => [mapping.from_type, mapping.to_type, mapping.kind])).toEqual([
      ["personal.travel_profile", "travel.profile", "legacy"],
      ["personal.passenger_identity", "person.identity", "legacy"],
      ["wallet.payment_method", "payment.card", "legacy"],
    ]);
    const mine = first.records.find((record) => record.title === "Me — ZRH")!;
    expect(mine).toMatchObject({ type: "travel.profile", source: { kind: "migration", from_type: "personal.travel_profile" }, created: "2026-09-01T00:00:00Z", updated: "2026-09-02T00:00:00Z", fields: { home_airport: "ZRH" } });
    expect(mine.demo).toBeUndefined();
    const alex = first.records.find((record) => record.title === "Alex Traveler")!;
    expect(alex).toMatchObject({ type: "person.identity", demo: true, fields: { email: "sealed:omitted" } });
    expect(((await h.controller.handle({ type: "memory.reveal", recordId: alex.id, pointer: "/email" }, PAGE)) as { value: string }).value).toBe("alex.traveler@example.com");
    // The vault stays until Done; a second open migrates nothing again.
    expect(await h.settings.hasVault()).toBe(true);
    h.controller.memory.invalidate();
    expect((await view(h)).records.filter((record) => record.source.kind === "migration")).toHaveLength(2);
    await h.controller.handle({ type: "memory.migrationDone" }, PAGE);
    expect(await h.settings.hasVault()).toBe(false);
    expect((await h.secrets.names()).includes("vault_key")).toBe(false);
    expect((await view(h)).migration).toBeNull();
    // The legacy alias still answers a package's old request: the registry lists the migrated profile under the legacy id.
    const registry = await h.controller.memory.registry({ requested: ["personal.travel_profile"], packageId: "org.example" });
    expect(registry.types.map((type) => [type.id, type.permission_kind])).toEqual([["personal.travel_profile", "personal.read"]]);
    expect(registry.resources.map((resource) => resource.label)).toEqual(["Me — ZRH"]);
  });
});

describe("the page's writes", () => {
  it("an edit that submits the placeholder keeps the sealed value; a typed value replaces it; links are added and removed; a supersedes loop is refused", async () => {
    const h = makeHarness();
    await h.controller.handle({ type: "memory.installDemo" }, PAGE);
    const before = (await h.controller.handle({ type: "memory.reveal", recordId: DEMO.alex, pointer: "/email" }, PAGE)) as { value: string };
    await h.controller.handle({ type: "memory.edit", recordId: DEMO.alex, changes: { title: "Alex T.", fields: { given_name: "Alex", family_name: "Traveler", email: "sealed:omitted" } } }, PAGE);
    expect(((await h.controller.handle({ type: "memory.reveal", recordId: DEMO.alex, pointer: "/email" }, PAGE)) as { value: string }).value).toBe(before.value);
    expect((await view(h)).records.find((record) => record.id === DEMO.alex)?.title).toBe("Alex T.");
    await h.controller.handle({ type: "memory.edit", recordId: DEMO.alex, changes: { fields: { given_name: "Alex", family_name: "Traveler", email: "alex.t@example.com" } } }, PAGE);
    expect(((await h.controller.handle({ type: "memory.reveal", recordId: DEMO.alex, pointer: "/email" }, PAGE)) as { value: string }).value).toBe("alex.t@example.com");
    expect(JSON.stringify(await h.memoryStorage.loadRecords())).not.toContain("alex.t@example.com");
    // Links.
    expect(await h.controller.handle({ type: "memory.link", from: DEMO.traveler, to: DEMO.visa, rel: "pays_with" }, PAGE)).toEqual({ id: DEMO.traveler, existed: false });
    expect(await h.controller.handle({ type: "memory.link", from: DEMO.traveler, to: DEMO.visa, rel: "pays_with" }, PAGE)).toEqual({ id: DEMO.traveler, existed: true });
    expect((await view(h)).edges.some((edge) => edge.from === DEMO.traveler && edge.to === DEMO.visa && edge.rel === "pays_with")).toBe(true);
    await h.controller.handle({ type: "memory.link", from: DEMO.traveler, to: DEMO.explorer, rel: "supersedes" }, PAGE);
    expect((await refused(h.controller.handle({ type: "memory.link", from: DEMO.explorer, to: DEMO.traveler, rel: "supersedes" }, PAGE))).code).toBe("supersedes_cycle");
    await h.controller.handle({ type: "memory.unlink", from: DEMO.traveler, to: DEMO.visa, rel: "pays_with" }, PAGE);
    expect((await view(h)).edges.some((edge) => edge.from === DEMO.traveler && edge.to === DEMO.visa)).toBe(false);
    expect((await refused(h.controller.handle({ type: "memory.link", from: DEMO.traveler, to: DEMO.visa, rel: "owns" }, PAGE))).code).toBe("invalid_request");
    // Forget needs the typed word and recreates Me.
    expect((await refused(h.controller.handle({ type: "memory.forget", confirmation: "yes" }, PAGE))).code).toBe("confirmation_required");
    await h.controller.handle({ type: "memory.forget", confirmation: "forget" }, PAGE);
    expect((await view(h)).records.map((record) => record.id)).toEqual(["self"]);
    expect(await h.memoryStorage.loadRecords()).toHaveLength(1);
  });

  it("export omits sealed values unless asked while unlocked; export → forget → import reproduces every record digest (§8)", async () => {
    const h = makeHarness();
    await h.controller.handle({ type: "memory.installDemo" }, PAGE);
    await h.controller.handle({ type: "memory.create", draft: { type: "document.note", title: "Packing list", body: "Charger, adapter. See [[Demo Traveler — BOS / Economy / Nonstop]]." } }, PAGE);
    const before = await view(h);
    const omitted = (await h.controller.handle({ type: "memory.export", includeSealed: false, includeAgents: false, recordIds: null }, PAGE)) as { files: Array<{ path: string; text: string }>; sealed_included: boolean };
    expect(omitted.sealed_included).toBe(false);
    expect(omitted.files.map((file) => file.path)).toContain("index.md");
    expect(JSON.stringify(omitted.files)).not.toContain("alex.traveler@example.com");
    expect(JSON.stringify(omitted.files)).toContain("sealed:omitted");
    const full = (await h.controller.handle({ type: "memory.export", includeSealed: true, includeAgents: false, recordIds: null }, PAGE)) as { files: Array<{ path: string; text: string }>; sealed_included: boolean };
    expect(full.sealed_included).toBe(true);
    expect(JSON.stringify(full.files)).toContain("alex.traveler@example.com");
    await h.controller.handle({ type: "memory.forget", confirmation: "forget" }, PAGE);
    const plan = (await h.controller.handle({ type: "memory.importPlan", files: full.files }, PAGE)) as { counts: { added: number; hub: number; refused: number; incomplete: number } };
    // The harness clock is frozen, so the fresh Me after Forget equals the exported one: "already here", not a hub merge.
    expect(plan.counts).toMatchObject({ added: 7, hub: 0, same: 1, refused: 0, incomplete: 0 });
    const applied = (await h.controller.handle({ type: "memory.importApply", files: full.files, completions: {} }, PAGE)) as { written: number; skipped: string[] };
    expect(applied.written).toBe(7);
    const after = await view(h);
    const digests = (records: MemoryView["records"]) => Object.fromEntries(records.map((record) => [record.id, record.digest]));
    expect(digests(after.records)).toEqual(digests(before.records));
    expect(after.records.find((record) => record.title === "Packing list")?.source).toEqual({ kind: "person" }); // an import keeps the record's own provenance (M-59)
    expect(after.edges.filter((edge) => edge.source === "body")).toHaveLength(before.edges.filter((edge) => edge.source === "body").length);
    // Importing the sealed-omitted export over the same memory restores the sealed values by id (M-59) and changes nothing.
    const again = (await h.controller.handle({ type: "memory.importPlan", files: omitted.files }, PAGE)) as { counts: { same: number; hub: number; added: number; updated: number; sealed_restored: number; incomplete: number } };
    expect(again.counts).toMatchObject({ incomplete: 0, added: 0, updated: 0, hub: 0, same: 8 }); // the Me record included: an identical merge is "already here", nothing to import
    // Locked: export without sealed values still works; with them it is refused.
    await h.controller.handle({ type: "secrets.lock" }, PAGE);
    expect(((await h.controller.handle({ type: "memory.export", includeSealed: true, includeAgents: false, recordIds: null }, PAGE)) as { sealed_included: boolean }).sealed_included).toBe(false);
    expect((await refused(h.controller.handle({ type: "memory.importApply", files: full.files, completions: {} }, PAGE))).code).toBe("store_locked");
  });
});

/** A completed run of the memory test package as the run store holds it, with its proposals artifact. */
async function storedProposalRun(h: Harness, runId: string, proposals: JsonObject = VALID_PROPOSALS, options: { grants?: Array<{ permission_id: string; resource_type: string; resource_id: string; resource_digest: string }>; status?: "completed" | "failed"; offered?: number; reason?: string | null; memory_types?: MemoryType[] } = {}): Promise<void> {
  const { pkg } = await memoryPackage();
  const count = (proposals.proposals as unknown[]).length;
  const run = {
    run_id: runId,
    session_id: "session-x",
    created_at: "2026-10-14T11:00:00Z",
    updated_at: "2026-10-14T11:02:00Z",
    task_text: "hello",
    checkpoints: 1,
    progress: null,
    audit: [],
    usage: null,
    result: null,
    memory_proposed_at: "2026-10-14T11:02:00Z",
    memory_types: options.memory_types ?? null,
    record: {
      status: options.status ?? "completed",
      runId,
      sessionId: "session-x",
      endedAt: "2026-10-14T11:02:00Z",
      package: { packageId: String(pkg.manifest.package_id), name: String(pkg.manifest.name), version: String(pkg.manifest.version), digest: pkg.digest, archiveSha256: "0".repeat(64), executionProfile: "workflow.v0" },
      memory: { proposals: { count, types: ["travel.preference"], proposals_sha256: "0".repeat(64), offered: options.offered ?? count, reason: options.reason ?? null }, refused: null, agent: null },
      artifacts: [{ name: "proposals.json", bytes: 1, sha256: "0".repeat(64) }],
      resources: [],
    },
    invocation: { run_id: runId, plan: { session_id: "session-x", package: { package_id: String(pkg.manifest.package_id), version: String(pkg.manifest.version), name: String(pkg.manifest.name), digest: pkg.digest }, resource_grants: options.grants ?? [], tool_bindings: [], model_binding: null } },
  } as unknown as StoredRun;
  await h.runs.putRun(run);
  const bytes = new TextEncoder().encode(JSON.stringify(proposals));
  await h.runs.putArtifact({ key: `${runId}/proposals.json`, run_id: runId, name: "proposals.json", bytes, sha256: "0".repeat(64) });
}

describe("the review of a run's proposals (M-41, M-42, M-44)", () => {
  it("shows the facts, applies the decisions together once, writes the records with package provenance and the usage log, and never reopens", async () => {
    const h = makeHarness();
    await h.controller.handle({ type: "memory.installDemo" }, PAGE);
    const traveler = (await view(h)).records.find((record) => record.id === DEMO.traveler)!;
    const proposals: JsonObject = {
      schema: "memory.v0 proposals",
      proposals: [
        { action: "create", type: "travel.preference", title: "Aisle seat", fields: { kind: "seat", value: "aisle" }, body: "Chosen on the Boston booking.", tags: ["seat"], links: [{ to: "self", rel: "about" }], rationale: "You chose an aisle seat." },
        { action: "update", type: "travel.profile", target: DEMO.traveler, title: "Home travel profile", fields: { home_airport: "BOS", preferred_cabin: "economy", prefer_nonstop: true, preferred_currency: "USD" }, body: "Updated after the booking.", links: [{ to: "#0", rel: "prefers" }], rationale: "Links your profile to the seat." },
      ],
    };
    await storedProposalRun(h, "run_review", proposals, { grants: [{ permission_id: "memory.travel_profile", resource_type: "travel.profile", resource_id: DEMO.traveler, resource_digest: traveler.digest }] });
    const review = (await h.controller.handle({ type: "memory.review", runId: "run_review" }, PAGE)) as RunReviewView;
    expect(review).toMatchObject({ run_id: "run_review", offered: 2, count: 2, decided: null, package: { package_id: "org.example.memory" } });
    expect(review.review?.facts.map((facts) => [facts.index, facts.type_display_name, facts.target_title])).toEqual([[0, "Travel preference", null], [1, "Travel profile", traveler.title]]);
    expect(review.review?.facts[1]?.kept.links.map((link) => link.rel)).toEqual(["about"]); // the demo profile's default link the proposal did not carry
    expect(JSON.stringify(review)).not.toContain("alex.traveler@example.com");
    // Reject the first, accept the update: the link to the rejected sibling is dropped with a note (M-42).
    const outcome = (await h.controller.handle({ type: "memory.decide", runId: "run_review", decisions: [{ index: 0, decision: "reject" }, { index: 1, decision: "accept" }] }, PAGE)) as { accepted: Array<{ index: number; id: string; supersedes: string | null; dropped_links: string[] }>; rejected: number[] };
    expect(outcome.rejected).toEqual([0]);
    expect(outcome.accepted).toHaveLength(1);
    expect(outcome.accepted[0]).toMatchObject({ index: 1, supersedes: DEMO.traveler, dropped_links: ["#0"] });
    const after = await view(h);
    const written = after.records.find((record) => record.id === outcome.accepted[0]!.id)!;
    expect(written).toMatchObject({ type: "travel.profile", title: "Home travel profile", source: { kind: "package", package_id: "org.example.memory", run_id: "run_review", proposal: 1 } });
    expect(written.links).toEqual(expect.arrayContaining([{ to: DEMO.traveler, rel: "supersedes" }, { to: "self", rel: "about" }]));
    expect(after.records.find((record) => record.id === DEMO.traveler)?.superseded_by).toBe(written.id);
    expect(written.usage.map((usage) => [usage.package_id, usage.uses])).toEqual([["org.example.memory", { proposed: 1, accepted: 1 }]]);
    const done = (await h.controller.handle({ type: "memory.review", runId: "run_review" }, PAGE)) as RunReviewView;
    expect(done.decided).toMatchObject({ accepted: 1, rejected: 1 });
    expect(done.review).toBeNull();
    expect((await refused(h.controller.handle({ type: "memory.decide", runId: "run_review", decisions: [] }, PAGE))).code).toBe("review_decided");
    expect(h.events).toContainEqual({ type: "event.memory" });
  });

  it("offers nothing for a run whose proposals were not offered, a failed run, or an unknown run; a locked store refuses the decisions by name", async () => {
    const h = makeHarness();
    await storedProposalRun(h, "run_denied", VALID_PROPOSALS, { offered: 0, reason: "permission_denied" });
    expect((await h.controller.handle({ type: "memory.review", runId: "run_denied" }, PAGE)) as RunReviewView).toMatchObject({ offered: 0, count: 1, reason: "permission_denied", review: null });
    await storedProposalRun(h, "run_failed", VALID_PROPOSALS, { status: "failed" });
    expect(((await h.controller.handle({ type: "memory.review", runId: "run_failed" }, PAGE)) as RunReviewView).review).toBeNull();
    expect((await refused(h.controller.handle({ type: "memory.review", runId: "ghost" }, PAGE))).code).toBe("run_unknown");
    await storedProposalRun(h, "run_locked");
    await h.controller.handle({ type: "secrets.lock" }, PAGE);
    expect(((await h.controller.handle({ type: "memory.review", runId: "run_locked" }, PAGE)) as RunReviewView).review?.document.proposals).toHaveLength(1); // readable while locked
    expect((await refused(h.controller.handle({ type: "memory.decide", runId: "run_locked", decisions: [{ index: 0, decision: "accept" }] }, PAGE))).code).toBe("store_locked");
  });
});

describe("a settled run's memory facts (M-29, M-50)", () => {
  it("host.finished commits the staged agent document and the usage entries, or keeps them pending while locked and applies them at unlock", async () => {
    const h = makeHarness();
    await h.controller.handle({ type: "memory.installDemo" }, PAGE);
    const stored = (runId: string): StoredRun =>
      ({
        run_id: runId,
        session_id: "session-x",
        created_at: "2026-10-14T11:00:00Z",
        updated_at: "2026-10-14T11:02:00Z",
        task_text: null,
        checkpoints: 1,
        progress: null,
        audit: [],
        usage: null,
        result: null,
        memory_commit: { package_id: "org.example.memory", package_version: "0.1.0", name: "Memory test package", body: "# Notes\n- booked BOS", bytes: 20, body_sha256: "0".repeat(64), at: "2026-10-14T11:02:00Z" },
        memory_usage: [{ record_id: DEMO.traveler, use: "read", package_id: "org.example.memory", package_version: "0.1.0", run_id: runId, at: "2026-10-14T11:01:00Z" }],
        record: { status: "completed", runId, sessionId: "session-x", package: { packageId: "org.example.memory", name: "Memory test package", version: "0.1.0", digest: "0".repeat(64), archiveSha256: "0".repeat(64), executionProfile: "workflow.v0" }, artifacts: [], resources: [] },
        invocation: { run_id: runId, archive_sha256: "0".repeat(64), plan: { session_id: "session-x", package: { package_id: "org.example.memory", version: "0.1.0", name: "Memory test package" }, resource_grants: [], tool_bindings: [], model_binding: null } },
      }) as unknown as StoredRun;
    await h.runs.putRun(stored("run_notes"));
    await h.controller.handle({ type: "host.finished", runId: "run_notes" }, OFFSCREEN);
    const after = await view(h);
    expect(after.agents).toHaveLength(1);
    expect(after.agents[0]).toMatchObject({ package_id: "org.example.memory", title: "Memory test package", bytes: 20, run_id: "run_notes" });
    expect(after.records.find((record) => record.id === DEMO.traveler)?.usage).toEqual([{ package_id: "org.example.memory", runs: 1, last: "2026-10-14T11:01:00Z", uses: { read: 1 } }]);
    expect((await h.runs.getRun("run_notes"))?.memory_commit).toBeNull();
    // The agent document is never a recall candidate and never in the page's records; it is listed under Settings → Memory and cleared there.
    expect(after.records.some((record) => record.scope === "agent")).toBe(false);
    expect((await h.controller.memory.registry({ requested: ["agent.memory"], packageId: "x" })).types).toEqual([]);
    // Locked at finish: kept on the run; applied after the unlock.
    await h.controller.handle({ type: "secrets.lock" }, PAGE);
    await h.runs.putRun(stored("run_later"));
    await h.controller.handle({ type: "host.finished", runId: "run_later" }, OFFSCREEN);
    expect((await h.runs.getRun("run_later"))?.memory_commit).not.toBeNull();
    await h.controller.handle({ type: "secrets.unlock", passphrase: SEED_PASSPHRASE }, PAGE);
    // The unlock applies the pending commit without waiting for it: poll rather than sleep a fixed
    // 20 ms, which a busy full suite sometimes outran (seen in T41).
    await vi.waitFor(async () => expect((await h.runs.getRun("run_later"))?.memory_commit).toBeNull(), { timeout: 5000, interval: 20 });
    expect((await view(h)).agents[0]).toMatchObject({ run_id: "run_later" });
    await h.controller.handle({ type: "memory.clearAgent", packageId: "org.example.memory" }, PAGE);
    expect((await view(h)).agents).toEqual([]);
  });
});

describe("the recall card's modes (M-52) and the presets", () => {
  async function session(h: Harness): Promise<SessionView> {
    const opened = (await h.controller.handle({ type: "package.open", url: WEBAIR_040_URL, advertisedOn: `${SITE_ORIGIN}/`, viewId: "test" }, PAGE)) as SessionView;
    await h.controller.handle({ type: "trust.pin", sessionId: opened.session.id, signerFingerprint: SHIPPED.webair040.fingerprint, scope: "publisher" }, PAGE);
    return opened;
  }
  async function preset(h: Harness, id: "privacy-first" | "balanced" | "convenience"): Promise<void> {
    const current = (await h.controller.handle({ type: "settings.get" }, PAGE)) as { settings: { preset: string } };
    await h.controller.handle({ type: "settings.set", settings: { ...current.settings, preset: id } }, PAGE);
  }

  it("balanced proposes the top unsealed candidate and asks for a sealed type; privacy first asks for both; convenience auto-selects the unsealed one and records the pick as preset", async () => {
    const h = makeHarness();
    await h.controller.handle({ type: "memory.installDemo" }, PAGE);
    const opened = await session(h);
    const recall = async () => ((await h.controller.handle({ type: "authorization.get", sessionId: opened.session.id }, PAGE)) as AuthorizationView).recall;
    const balanced = await recall();
    expect(balanced.map((card) => [card.permission_id, card.mode, card.sealed])).toEqual([["profile.travel", "propose", false], ["identity.passenger", "ask", true], ["wallet.payment", "ask", true]]);
    expect(balanced[0]!.candidates.map((candidate) => candidate.title)).toEqual(["Demo Traveler — BOS / Economy / Nonstop", "Demo Explorer — JFK / Business / Any stops"]);
    expect(balanced[0]!.candidates[0]!.provenance).toContain("Migrated from Your data");
    expect(balanced[1]!.sealed_fields).toContain("/email");
    expect(JSON.stringify(balanced)).not.toContain("alex.traveler@example.com");
    await preset(h, "privacy-first");
    expect((await recall()).map((card) => card.mode)).toEqual(["ask", "ask", "ask"]);
    await preset(h, "convenience");
    expect((await recall()).map((card) => card.mode)).toEqual(["auto", "ask", "ask"]);
    // A convenience pick is recorded as `preset` in the receipt's provenance (M-53).
    const result = (await h.controller.handle({ type: "authorization.useProfile", sessionId: opened.session.id, packageDigest: SHIPPED.webair040.digest, profileId: "quote", resourceSelections: { "profile.travel": DEMO.traveler, "identity.passenger": DEMO.alex }, prepare: false, presetSelections: ["profile.travel"] }, PAGE)) as { receipt: { provenance: { resource_selections: Record<string, string> } } };
    expect(result.receipt.provenance.resource_selections).toEqual({ "identity.passenger": "user", "profile.travel": "preset" });
    // Locked: no candidates, so the cards are empty and the picker says unlock.
    await h.controller.handle({ type: "secrets.lock" }, PAGE);
    expect(await recall()).toEqual([]);
  });

  it("the presets treat memory.read like personal.read and memory.write like a non-personal permission; a policy's types_allowed denies a type outside it", async () => {
    const { pkg } = await memoryPackage({ agent: true });
    const balanced = defaultDecisions(pkg, "balanced");
    expect(balanced.decisions["memory.travel_profile"]).toBe("deny");
    expect(balanced.decisions["memory.remember"]).toBe("session");
    expect(balanced.decisions["memory.agent"]).toBe("session");
    const privacy = defaultDecisions(pkg, "privacy-first");
    expect(privacy.decisions["memory.remember"]).toBe("deny");
    const convenience = defaultDecisions(pkg, "convenience");
    expect(convenience.decisions["memory.travel_profile"]).toBe("session");
    // Under privacy first a profile that includes them grants them once.
    const profile = { id: "p", title: "P", description: "", permissions: ["memory.travel_profile", "memory.remember", "memory.session", "files.echo"], tools: [], resources: [], claims: [] } as never;
    const once = profileDecisions(pkg, profile, "privacy-first");
    expect(once.decisions["memory.travel_profile"]).toBe("once");
    expect(once.decisions["memory.remember"]).toBe("once");
    // The policy's memory rules (M-54).
    const content = JSON.parse(readFileSync(resolve(ROOT, "examples/policies/webagents-research.content.json"), "utf8")) as JsonObject;
    const bundle = await readPolicyBundle({ ...content, memory: { types_allowed: ["research.profile"], proposals: "refuse", agent: "refuse", recall: "ask" } });
    expect(bundle.memory).toEqual({ types_allowed: ["research.profile"], proposals: "refuse", agent: "refuse", recall: "ask" });
    const policy: ActivePolicy = { bundle, reference: { policy_id: bundle.policy_id, version: bundle.version, title: bundle.title, content_sha256: "f".repeat(64), signer_fingerprint: `sha256:${"9".repeat(64)}` } };
    const applied = applyPolicy(pkg, convenience, { policy, preset: "convenience", profile: null, bindings: {} });
    expect(applied.decisions["memory.travel_profile"]).toBe("deny");
    expect(applied.provenance.decisions["memory.travel_profile"]).toBe("policy");
    expect(applied.decisions["memory.remember"]).toBe("deny"); // travel.preference and travel.profile are outside the allowlist
    expect((await readPolicyBundle(content)).memory).toBeNull();
  });
});

describe("the shell's wiring (found in the user's walk-through, 2026-10-14)", () => {
  it("the service worker stores the memory in IndexedDB, never in the in-memory store meant for tests", () => {
    const source = readFileSync(resolve(ROOT, "chrome-agent-browser/src/extension/background/service-worker.ts"), "utf8");
    expect(source).toContain("new IndexedDbMemoryStorage(database)");
    expect(source).toMatch(/memoryStorage: new IndexedDbMemoryStorage\(database\)/u);
    expect(source).not.toContain("MemoryMemoryStorage");
  });
});

describe("review 1 (2026-10-14): the idle lock, the review's guards, custom types, failed writes, the run's facts applied once", () => {
  const SIX_HOURS = 6 * 60 * 60 * 1000;
  const exported = async (h: Harness) => (await h.controller.handle({ type: "memory.export", includeSealed: true, includeAgents: false, recordIds: null }, PAGE)) as { files: Array<{ path: string; text: string }>; sealed_included: boolean };

  it("finding 1: an idle lock the store applies lazily, or the alarm's sweep applies, locks the memory too: no sealed value leaves in an export, and the view says locked", async () => {
    const h = makeHarness();
    await h.controller.handle({ type: "memory.installDemo" }, PAGE);
    expect((await view(h)).locked).toBe(false); // the opened store is cached unlocked
    // The lazy path: the idle time passes with no alarm; the next status read wipes the session key.
    h.clock.now = new Date(h.clock.now.getTime() + SIX_HOURS);
    expect((await h.secrets.status()).state).toBe("locked");
    const lazy = await exported(h);
    expect(lazy.sealed_included).toBe(false);
    expect(JSON.stringify(lazy.files)).not.toContain("alex.traveler@example.com");
    expect((await view(h)).locked).toBe(true);
    expect((await refused(h.controller.handle({ type: "memory.reveal", recordId: DEMO.alex, pointer: "/email" }, PAGE))).code).toBe("store_locked");
    // The alarm path: unlocked and cached again, then the minute sweep locks through the controller.
    await h.controller.handle({ type: "secrets.unlock", passphrase: SEED_PASSPHRASE }, PAGE);
    expect((await view(h)).locked).toBe(false);
    expect((await exported(h)).sealed_included).toBe(true);
    h.clock.now = new Date(h.clock.now.getTime() + SIX_HOURS);
    h.events.length = 0;
    expect(await h.controller.lockIfIdle()).toBe(true);
    expect(h.events).toContainEqual({ type: "event.secrets" });
    expect(h.events).toContainEqual({ type: "event.memory" });
    const swept = await exported(h);
    expect(swept.sealed_included).toBe(false);
    expect(JSON.stringify(swept.files)).not.toContain("alex.traveler@example.com");
    expect((await view(h)).locked).toBe(true);
    expect(await h.controller.lockIfIdle()).toBe(false); // already locked: nothing to sweep
  });

  it("finding 2: decisions are refused for a run whose proposals were not offered or that did not complete, and a second Decide racing the first finds it recorded", async () => {
    const h = makeHarness();
    await h.controller.handle({ type: "memory.installDemo" }, PAGE);
    const count = async () => (await view(h)).counts.records;
    const before = await count();
    await storedProposalRun(h, "run_denied", VALID_PROPOSALS, { offered: 0, reason: "permission_denied" });
    expect((await refused(h.controller.handle({ type: "memory.decide", runId: "run_denied", decisions: [{ index: 0, decision: "accept" }] }, PAGE))).code).toBe("review_not_offered");
    await storedProposalRun(h, "run_policy", VALID_PROPOSALS, { offered: 0, reason: "policy" });
    expect((await refused(h.controller.handle({ type: "memory.decide", runId: "run_policy", decisions: [{ index: 0, decision: "accept" }] }, PAGE))).code).toBe("review_not_offered");
    await storedProposalRun(h, "run_failed", VALID_PROPOSALS, { status: "failed" });
    expect((await refused(h.controller.handle({ type: "memory.decide", runId: "run_failed", decisions: [{ index: 0, decision: "accept" }] }, PAGE))).code).toBe("review_not_offered");
    expect(await count()).toBe(before);
    await storedProposalRun(h, "run_twice");
    const decide = () => h.controller.handle({ type: "memory.decide", runId: "run_twice", decisions: [{ index: 0, decision: "accept" }] }, PAGE);
    const outcomes = await Promise.allSettled([decide(), decide()]);
    expect(outcomes.map((outcome) => outcome.status).sort()).toEqual(["fulfilled", "rejected"]);
    const rejected = outcomes.find((outcome) => outcome.status === "rejected") as PromiseRejectedResult;
    expect((rejected.reason as CoreError).code).toBe("review_decided");
    expect(await count()).toBe(before + 1);
    expect((await h.runs.getRun("run_twice"))?.memory_review).toMatchObject({ accepted: 1, rejected: 0 });
  });

  it("finding 3: a proposal of a type the package declared itself (M-18) is reviewed as a new type, and accepting it approves and stores the type with the record", async () => {
    const h = makeHarness();
    await h.controller.handle({ type: "memory.installDemo" }, PAGE);
    const loyalty = customType("org.example.memory", { id: "loyalty.card", display_name: "Loyalty card", description: "A frequent-flyer programme card", schema: "schemas/types/loyalty.card.schema.json", identity: ["/number"] }, { $schema: "https://json-schema.org/draft/2020-12/schema", type: "object", additionalProperties: false, required: ["number"], properties: { number: { type: "string", minLength: 4 }, airline: { type: "string" } } });
    expect(loyalty.id).toBe("org.example.memory:loyalty.card");
    const proposals: JsonObject = {
      schema: "memory.v0 proposals",
      proposals: [{ action: "create", type: "loyalty.card", title: "Star miles", fields: { number: "SM-123456", airline: "WebAir" }, body: "Earned on the Boston booking.", tags: ["loyalty"], links: [{ to: "self", rel: "about" }], rationale: "You gave your loyalty number." }],
    };
    await storedProposalRun(h, "run_custom", proposals, { memory_types: [loyalty] });
    const review = (await h.controller.handle({ type: "memory.review", runId: "run_custom" }, PAGE)) as RunReviewView;
    expect(review.review?.facts[0]).toMatchObject({ type_display_name: "Loyalty card", type_description: "A frequent-flyer programme card", new_type: true, link_titles: { self: "Me" } });
    expect((await view(h)).types.some((type) => type.id === loyalty.id)).toBe(false); // nothing stored before the decision
    const outcome = (await h.controller.handle({ type: "memory.decide", runId: "run_custom", decisions: [{ index: 0, decision: "accept" }] }, PAGE)) as { accepted: Array<{ id: string }> };
    const after = await view(h);
    expect(after.records.find((record) => record.id === outcome.accepted[0]!.id)).toMatchObject({ type: loyalty.id, title: "Star miles", fields: { number: "SM-123456" } });
    expect(after.types.find((type) => type.id === loyalty.id)).toMatchObject({ declared_by: { kind: "package", package_id: "org.example.memory" }, sealed_fields: [] });
    // Stored with the rows: another worker over the same storage reads the type and the record.
    const again = makeHarness({ stores: { snapshots: h.snapshots, trustStorage: h.trustStorage, tabs: h.tabs, settingsArea: h.settingsArea, secrets: { envelope: h.envelope, unlocked: h.unlocked } }, memoryStorage: h.memoryStorage });
    expect((await view(again)).types.some((type) => type.id === loyalty.id)).toBe(true);
    // Approved for (package, type, schema): the next run's proposal of the type is no longer "new".
    await storedProposalRun(h, "run_custom_2", proposals, { memory_types: [loyalty] });
    expect(((await h.controller.handle({ type: "memory.review", runId: "run_custom_2" }, PAGE)) as RunReviewView).review?.facts[0]?.new_type).toBe(false);
    // A rejected proposal approves nothing: a fresh memory, the same run, reject.
    const fresh = makeHarness();
    await storedProposalRun(fresh, "run_custom_rejected", proposals, { memory_types: [loyalty] });
    await fresh.controller.handle({ type: "memory.decide", runId: "run_custom_rejected", decisions: [{ index: 0, decision: "reject" }] }, PAGE);
    expect((await view(fresh)).types.some((type) => type.id === loyalty.id)).toBe(false);
    // Without the run's declared types, the review refuses the unknown type by name instead of throwing.
    await storedProposalRun(h, "run_custom_unknown", proposals);
    expect((await refused(h.controller.handle({ type: "memory.review", runId: "run_custom_unknown" }, PAGE))).code).toBe("memory_proposals_invalid");
  });

  it("review 2, finding 1: a newer package version that changed its custom type's schema is reviewed against that schema, shown as a new type again, and approved only by an accept", async () => {
    const h = makeHarness();
    await h.controller.handle({ type: "memory.installDemo" }, PAGE);
    const declaration = { id: "loyalty.card", display_name: "Loyalty card", description: "A frequent-flyer programme card", schema: "schemas/types/loyalty.card.schema.json", identity: ["/number"] };
    const v1 = customType("org.example.memory", declaration, { $schema: "https://json-schema.org/draft/2020-12/schema", type: "object", additionalProperties: false, required: ["number"], properties: { number: { type: "string", minLength: 4 } } });
    const v2 = customType("org.example.memory", declaration, { $schema: "https://json-schema.org/draft/2020-12/schema", type: "object", additionalProperties: false, required: ["number", "tier"], properties: { number: { type: "string", minLength: 4 }, tier: { type: "string" } } });
    const proposal = (title: string, fields: JsonObject): JsonObject => ({ schema: "memory.v0 proposals", proposals: [{ action: "create", type: "loyalty.card", title, fields, body: "", tags: [], links: [], rationale: "You gave your loyalty number." }] });
    await storedProposalRun(h, "run_v1", proposal("Star miles", { number: "SM-123456" }), { memory_types: [v1] });
    await h.controller.handle({ type: "memory.decide", runId: "run_v1", decisions: [{ index: 0, decision: "accept" }] }, PAGE);
    const schemaOf = async () => (await view(h)).types.find((type) => type.id === v1.id)?.schema as JsonObject | undefined;
    expect((await schemaOf())?.required).toEqual(["number"]);
    // v2's proposal fits v2 only: the sheet checks it against v2 (the run did) and says "new type".
    await storedProposalRun(h, "run_v2_rejected", proposal("Gold miles", { number: "GM-123456", tier: "gold" }), { memory_types: [v2] });
    const review = (await h.controller.handle({ type: "memory.review", runId: "run_v2_rejected" }, PAGE)) as RunReviewView;
    expect(review.review?.facts[0]).toMatchObject({ type_display_name: "Loyalty card", new_type: true });
    await h.controller.handle({ type: "memory.decide", runId: "run_v2_rejected", decisions: [{ index: 0, decision: "reject" }] }, PAGE);
    expect((await schemaOf())?.required).toEqual(["number"]); // a reject approves nothing: v1 stays
    await storedProposalRun(h, "run_v2", proposal("Gold miles", { number: "GM-123456", tier: "gold" }), { memory_types: [v2] });
    expect(((await h.controller.handle({ type: "memory.review", runId: "run_v2" }, PAGE)) as RunReviewView).review?.facts[0]?.new_type).toBe(true);
    await h.controller.handle({ type: "memory.decide", runId: "run_v2", decisions: [{ index: 0, decision: "accept" }] }, PAGE);
    expect((await schemaOf())?.required).toEqual(["number", "tier"]);
    expect((await view(h)).records.filter((record) => record.type === v1.id).map((record) => record.title).sort()).toEqual(["Gold miles", "Star miles"]);
    // Approved for v2 now: the next v2 run is no longer new, and a v1 run is new again.
    await storedProposalRun(h, "run_v2_again", proposal("Silver miles", { number: "SV-123456", tier: "silver" }), { memory_types: [v2] });
    expect(((await h.controller.handle({ type: "memory.review", runId: "run_v2_again" }, PAGE)) as RunReviewView).review?.facts[0]?.new_type).toBe(false);
    // Another package's declaration never replaces this package's type in the review.
    const v3 = customType("org.example.memory", declaration, { $schema: "https://json-schema.org/draft/2020-12/schema", type: "object", additionalProperties: false, required: ["number", "level"], properties: { number: { type: "string", minLength: 4 }, level: { type: "string" } } });
    const foreign = { ...v3, declared_by: { kind: "package" as const, package_id: "org.example.other" } };
    await storedProposalRun(h, "run_foreign", proposal("Bronze miles", { number: "BR-123456", level: "bronze" }), { memory_types: [foreign] });
    expect((await refused(h.controller.handle({ type: "memory.review", runId: "run_foreign" }, PAGE))).code).toBe("memory_proposals_invalid");
  });

  it("review 2, nit 2: a decision list that names a proposal twice, or one the document does not have, is refused and writes nothing", async () => {
    const h = makeHarness();
    await h.controller.handle({ type: "memory.installDemo" }, PAGE);
    const loyalty = customType("org.example.memory", { id: "loyalty.card", display_name: "Loyalty card", description: "A frequent-flyer programme card", schema: "schemas/types/loyalty.card.schema.json" }, { $schema: "https://json-schema.org/draft/2020-12/schema", type: "object", additionalProperties: false, required: ["number"], properties: { number: { type: "string" } } });
    const proposals: JsonObject = { schema: "memory.v0 proposals", proposals: [{ action: "create", type: "loyalty.card", title: "Star miles", fields: { number: "SM-1" }, body: "", tags: [], links: [], rationale: "r" }] };
    await storedProposalRun(h, "run_twice", proposals, { memory_types: [loyalty] });
    const before = (await view(h)).counts.records;
    for (const decisions of [[{ index: 0, decision: "accept" }, { index: 0, decision: "reject" }], [{ index: 1, decision: "accept" }]]) {
      expect((await refused(h.controller.handle({ type: "memory.decide", runId: "run_twice", decisions } as never, PAGE))).code).toBe("review_decisions_invalid");
    }
    const after = await view(h);
    expect(after.counts.records).toBe(before);
    expect(after.types.some((type) => type.id === loyalty.id)).toBe(false); // no type approved for a proposal that was not accepted
    expect((await h.runs.getRun("run_twice"))?.memory_review ?? null).toBeNull(); // the review is still open
  });

  it("finding 4: a write that fails in the middle leaves nothing behind: the record it deleted first is still there, in the view and on disk, after later writes", async () => {
    const h = makeHarness();
    await h.controller.handle({ type: "memory.installDemo" }, PAGE);
    const before = (await view(h)).counts.records;
    expect((await refused(h.controller.handle({ type: "memory.delete", recordIds: [DEMO.explorer, "self"] }, PAGE))).code).toBe("memory_self_undeletable");
    expect((await view(h)).records.some((record) => record.id === DEMO.explorer)).toBe(true);
    expect((await view(h)).counts.records).toBe(before);
    await h.controller.handle({ type: "memory.create", draft: { type: "document.note", title: "After the refusal", body: "still here" } }, PAGE);
    expect((await h.memoryStorage.loadRecords()).some((row) => row.id === DEMO.explorer)).toBe(true);
    const again = makeHarness({ stores: { snapshots: h.snapshots, trustStorage: h.trustStorage, tabs: h.tabs, settingsArea: h.settingsArea, secrets: { envelope: h.envelope, unlocked: h.unlocked } }, memoryStorage: h.memoryStorage });
    expect((await view(again)).records.some((record) => record.id === DEMO.explorer)).toBe(true);
    expect((await view(again)).counts.records).toBe(before + 1);
  });

  it("finding 5: a run's usage and agent commit are applied in one write, once; a commit the store refuses keeps both on the run without blocking the next run's", async () => {
    const h = makeHarness();
    await h.controller.handle({ type: "memory.installDemo" }, PAGE);
    const stored = (runId: string, body: string): StoredRun =>
      ({
        run_id: runId,
        session_id: "session-x",
        created_at: "2026-10-14T11:00:00Z",
        updated_at: "2026-10-14T11:02:00Z",
        task_text: null,
        checkpoints: 1,
        progress: null,
        audit: [],
        usage: null,
        result: null,
        memory_commit: { package_id: "org.example.memory", package_version: "0.1.0", name: "Memory test package", body, bytes: body.length, body_sha256: "0".repeat(64), at: "2026-10-14T11:02:00Z" },
        memory_usage: [{ record_id: DEMO.traveler, use: "read", package_id: "org.example.memory", package_version: "0.1.0", run_id: runId, at: "2026-10-14T11:01:00Z" }],
        record: { status: "completed", runId, sessionId: "session-x", package: { packageId: "org.example.memory", name: "Memory test package", version: "0.1.0", digest: "0".repeat(64), archiveSha256: "0".repeat(64), executionProfile: "workflow.v0" }, artifacts: [], resources: [] },
        invocation: { run_id: runId, archive_sha256: "0".repeat(64), plan: { session_id: "session-x", package: { package_id: "org.example.memory", version: "0.1.0", name: "Memory test package" }, resource_grants: [], tool_bindings: [], model_binding: null } },
      }) as unknown as StoredRun;
    // Two runs settle while locked: one with a body the store refuses (over the agent cap), one sound.
    await h.controller.handle({ type: "secrets.lock" }, PAGE);
    await h.runs.putRun(stored("run_too_long", "x".repeat(MAX_AGENT_BODY_CHARS + 1)));
    await h.runs.putRun(stored("run_sound", "# Notes\n- booked BOS"));
    await h.controller.handle({ type: "host.finished", runId: "run_too_long" }, OFFSCREEN);
    await h.controller.handle({ type: "host.finished", runId: "run_sound" }, OFFSCREEN);
    expect(await h.controller.runs.applyPendingMemory()).toBe(0); // locked: nothing applied, nothing lost
    await h.controller.handle({ type: "secrets.unlock", passphrase: SEED_PASSPHRASE }, PAGE);
    await h.controller.runs.applyPendingMemory(); // the unlock's own sweep runs in the same queue; waiting on a second one waits on it
    const tooLong = await h.runs.getRun("run_too_long");
    expect(tooLong?.memory_commit).not.toBeNull();
    expect(tooLong?.memory_usage).toHaveLength(1); // the usage was not written without its commit, and not written twice later
    expect((await h.runs.getRun("run_sound"))?.memory_commit).toBeNull();
    const after = await view(h);
    expect(after.agents.map((agent) => agent.run_id)).toEqual(["run_sound"]);
    expect(after.records.find((record) => record.id === DEMO.traveler)?.usage).toEqual([{ package_id: "org.example.memory", runs: 1, last: "2026-10-14T11:01:00Z", uses: { read: 1 } }]);
    // Another pass retries the refused run and fails it again, quietly, and nothing is applied twice.
    expect(await h.controller.runs.applyPendingMemory()).toBe(0);
    expect((await view(h)).records.find((record) => record.id === DEMO.traveler)?.usage?.[0]?.uses).toEqual({ read: 1 });
    // host.finished and the unlock sweep at once: one application.
    const applied = vi.spyOn(h.controller.memory, "applyRun");
    await h.runs.putRun(stored("run_race", "# Notes\n- race"));
    await Promise.all([h.controller.handle({ type: "host.finished", runId: "run_race" }, OFFSCREEN), h.controller.runs.applyPendingMemory(), h.controller.runs.applyPendingMemory()]);
    expect(applied.mock.calls.filter(([input]) => input.commit?.run_id === "run_race")).toHaveLength(1);
    expect((await h.runs.getRun("run_race"))?.memory_commit).toBeNull();
    expect((await view(h)).records.find((record) => record.id === DEMO.traveler)?.usage?.[0]?.runs).toBe(2);
    applied.mockRestore();
  });

  it("finding 6: a link to the Me record is shown under the Me record's own title, never a fixed name", async () => {
    const h = makeHarness();
    await h.controller.handle({ type: "memory.installDemo" }, PAGE);
    await h.controller.handle({ type: "memory.edit", recordId: "self", changes: { title: "A. Person" } }, PAGE);
    await storedProposalRun(h, "run_self");
    const review = (await h.controller.handle({ type: "memory.review", runId: "run_self" }, PAGE)) as RunReviewView;
    expect(review.review?.facts[0]?.link_titles).toEqual({ self: "A. Person" });
    expect(JSON.stringify(review)).not.toContain("Dario");
  });
});
