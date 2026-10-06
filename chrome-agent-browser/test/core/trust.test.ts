import { describe, expect, it } from "vitest";

import { CoreError } from "../../src/core/errors.js";
import { publisherReport } from "../../src/core/evaluation.js";
import { fingerprint, publicKeyFromPem, rawBase64 } from "../../src/core/keys.js";
import { loadPackageBytes } from "../../src/core/package.js";
import {
  entriesFromDocument,
  evaluateTrust,
  MemoryTrustStorage,
  pinPackagePublisher,
  TRUST_STORE_FORMAT,
  TrustStore,
} from "../../src/core/trust.js";
import { generateKeyPair, signedArchive } from "../helpers/keys.js";
import { ORIGINAL_FINGERPRINT, ORIGINAL_KEY, readBytes, readText, SHIPPED } from "../helpers/paths.js";
import { archiveBytes } from "../helpers/zip.js";

const DEV_KEY = () => publicKeyFromPem(readText(ORIGINAL_KEY));

function store(): { store: TrustStore; storage: MemoryTrustStorage } {
  const storage = new MemoryTrustStorage("test://trust");
  let tick = 0;
  return { store: new TrustStore(storage, () => `2026-10-06T12:00:${String(tick++).padStart(2, "0")}+00:00`), storage };
}

/** A build of the shipped Meeting Agenda payload signed by a key nobody pinned. */
async function signedAgenda() {
  const { files } = await loadPackageBytes(readBytes(SHIPPED.meetingAgenda.archive));
  const key = await generateKeyPair();
  const pkg = await loadPackageBytes(await signedArchive(files, key));
  return { pkg, key, files };
}

describe("publisher trust is operator state, never package state (test_browser_trust.py)", () => {
  it("add, list and remove use the key fingerprint as identity", async () => {
    const { store: trust, storage } = store();
    expect(await trust.entries()).toEqual([]);
    const entry = await trust.add(DEV_KEY(), {
      displayName: "WebAgents development key",
      publisherId: "webagents-research",
      packageIdPrefix: "org.webagents.",
      notes: "milestone demo pin",
    });
    expect(entry.fingerprint).toBe(ORIGINAL_FINGERPRINT);
    expect(storage.document?.format).toBe(TRUST_STORE_FORMAT);
    expect(JSON.stringify(storage.document)).not.toContain("PRIVATE");
    expect(Object.keys(storage.document!.publishers[0]!).sort()).toEqual(
      ["added_at", "display_name", "fingerprint", "notes", "package_id_prefix", "public_key", "publisher_id"],
    );
    expect((await trust.entries()).map((item) => item.fingerprint)).toEqual([ORIGINAL_FINGERPRINT]);
    const duplicate = await trust.add(DEV_KEY(), { displayName: "again" }).catch((error: unknown) => error as CoreError);
    expect((duplicate as CoreError).code).toBe("trust_entry_exists");
    expect((duplicate as CoreError).status).toBe(409);
    await expect(trust.add(DEV_KEY(), { displayName: "again", replace: true })).resolves.toBeDefined();
    expect(await trust.entries()).toHaveLength(1);
    expect((await trust.remove(ORIGINAL_FINGERPRINT)).fingerprint).toBe(ORIGINAL_FINGERPRINT);
    expect(await trust.entries()).toEqual([]);
    const missing = await trust.remove(ORIGINAL_FINGERPRINT).catch((error: unknown) => error as CoreError);
    expect((missing as CoreError).code).toBe("trust_entry_unknown");
    expect((missing as CoreError).status).toBe(404);
  });

  it("validates display names and identifiers", async () => {
    const { store: trust } = store();
    await expect(trust.add(DEV_KEY(), { displayName: "" })).rejects.toThrow(/display_name is required/u);
    await expect(trust.add(DEV_KEY(), { displayName: "x".repeat(201) })).rejects.toThrow(/at most 200/u);
    await expect(trust.add(DEV_KEY(), { displayName: "a\u0001b" })).rejects.toThrow(/control characters/u);
    await expect(trust.add(DEV_KEY(), { displayName: "ok", publisherId: "has space" })).rejects.toThrow(/letters, digits/u);
    await expect(trust.add(DEV_KEY(), { displayName: "ok", packageIdPrefix: "org.x/y" })).rejects.toThrow(/letters, digits/u);
  });

  it("a valid signature from an unknown key is not trusted", async () => {
    const { store: trust } = store();
    const { pkg } = await signedAgenda();
    const report = await publisherReport(pkg, trust);
    expect(report.signature_status).toBe("valid");
    expect(report.trust_status).toBe("unknown");
    expect(report.trust_reason).toBe("signer_key_not_pinned");
    expect(report.claimed_id).toBe("webagents-research");
  });

  it("a claimed publisher pinned to another key is a mismatch", async () => {
    const { store: trust } = store();
    const { pkg } = await signedAgenda();
    const other = await generateKeyPair();
    await trust.add(other.publicKey, { displayName: "Pinned key for this publisher", publisherId: "webagents-research" });
    const report = await publisherReport(pkg, trust);
    expect(report.signature_status).toBe("valid");
    expect(report.trust_status).toBe("mismatch");
    expect(report.trust_reason).toBe("claimed_publisher_pinned_to_other_key");
    expect(report.pinned_fingerprints_for_claimed_publisher).toEqual([other.fingerprint]);
  });

  it("a pinned key bound to a different publisher is a mismatch", async () => {
    const { store: trust } = store();
    const { pkg, key } = await signedAgenda();
    await trust.add(key.publicKey, { displayName: "Pinned for someone else", publisherId: "another-organisation" });
    const report = await publisherReport(pkg, trust);
    expect(report.trust_status).toBe("mismatch");
    expect(report.trust_reason).toBe("pinned_key_bound_to_other_publisher");
  });

  it("a pinned prefix scopes which packages a key may sign", async () => {
    const { store: trust } = store();
    const { pkg, key } = await signedAgenda();
    await trust.add(key.publicKey, { displayName: "Narrow pin", publisherId: "webagents-research", packageIdPrefix: "com.other." });
    expect((await publisherReport(pkg, trust)).trust_reason).toBe("package_id_outside_pinned_prefix");
    await trust.remove(key.fingerprint);
    await trust.add(key.publicKey, { displayName: "Exact pin", publisherId: "webagents-research", packageIdPrefix: "org.webagents.meeting-agenda" });
    expect((await publisherReport(pkg, trust)).trust_status).toBe("trusted");
    expect((await publisherReport(pkg, trust)).trust_reason).toBe("operator_pinned_key");
  });

  it("unsigned and invalid signatures can never become trusted", async () => {
    const { store: trust } = store();
    const { files } = await signedAgenda();
    await trust.add(DEV_KEY(), { displayName: "WebAgents development key", publisherId: "webagents-research" });
    const unsigned = await loadPackageBytes(await archiveBytes(files));
    const report = await publisherReport(unsigned, trust);
    expect(report.signature_status).toBe("absent");
    expect(report.trust_status).toBe("unknown");
    expect(report.trust_reason).toBe("no_valid_signature");
    // Even when the pinned key is the signer, a broken envelope reports no trust.
    expect(evaluateTrust(await trust.entries(), { signerFingerprint: null, claimedPublisherId: "webagents-research", packageId: "x" }).trust_reason).toBe(
      "no_valid_signature",
    );
  });

  it("the shipped packages are trusted only under their own recorded keys", async () => {
    const { store: trust } = store();
    const webair = await loadPackageBytes(readBytes(SHIPPED.webair.archive));
    const review = await loadPackageBytes(readBytes(SHIPPED.literatureReview.archive));
    await trust.add(publicKeyFromPem(readText(SHIPPED.webair.key)), {
      displayName: "WebAir demo publisher key",
      publisherId: SHIPPED.webair.publisherId,
      packageIdPrefix: SHIPPED.webair.packageId,
    });
    expect((await publisherReport(webair, trust)).trust_status).toBe("trusted");
    expect((await publisherReport(review, trust)).trust_status).toBe("unknown");
    await trust.add(publicKeyFromPem(readText(SHIPPED.literatureReview.key)), {
      displayName: "Literature Review key",
      publisherId: SHIPPED.literatureReview.publisherId,
      packageIdPrefix: SHIPPED.literatureReview.packageId,
    });
    expect((await publisherReport(review, trust)).trust_status).toBe("trusted");
    // The original key pinned for the same publisher id makes the current signer a mismatch
    // until pinned itself: a rotation and an impersonation look the same (threat model).
    const { store: rotated } = store();
    await rotated.add(DEV_KEY(), { displayName: "Original key", publisherId: "webagents-research" });
    const mismatch = await publisherReport(review, rotated);
    expect(mismatch.trust_status).toBe("mismatch");
    expect(mismatch.pinned_fingerprints_for_claimed_publisher).toEqual([ORIGINAL_FINGERPRINT]);
  });

  it("opening a package never touches the trust store", async () => {
    const { store: trust, storage } = store();
    await trust.add(DEV_KEY(), { displayName: "WebAgents development key" });
    const before = JSON.stringify(storage.document);
    const beforeState = await trust.state();
    const writes = storage.writes;
    const review = await loadPackageBytes(readBytes(SHIPPED.literatureReview.archive));
    await publisherReport(review, trust);
    expect(JSON.stringify(storage.document)).toBe(before);
    expect(await trust.state()).toEqual(beforeState);
    expect(storage.writes).toBe(writes);
  });

  it("the trust state changes with its entries and is hashed canonically", async () => {
    const { store: trust } = store();
    const empty = await trust.state();
    expect(empty).toEqual({ path: "test://trust", entry_count: 0, state_sha256: expect.stringMatching(/^[0-9a-f]{64}$/u) });
    await trust.add(DEV_KEY(), { displayName: "k", publisherId: "webagents-research" });
    const one = await trust.state();
    expect(one.entry_count).toBe(1);
    expect(one.state_sha256).not.toBe(empty.state_sha256);
    // The state covers fingerprint and scope, not labels.
    await trust.add(DEV_KEY(), { displayName: "renamed", publisherId: "webagents-research", replace: true });
    expect((await trust.state()).state_sha256).toBe(one.state_sha256);
  });

  it("a corrupted trust store fails closed", async () => {
    const { store: trust, storage } = store();
    await trust.add(DEV_KEY(), { displayName: "WebAgents development key" });
    const good = JSON.parse(JSON.stringify(storage.document)) as { publishers: Array<Record<string, unknown>> };
    const corrupt = (mutate: (doc: typeof good) => void) => {
      const doc = JSON.parse(JSON.stringify(good)) as typeof good;
      mutate(doc);
      return entriesFromDocument(doc);
    };
    await expect(corrupt((doc) => (doc.publishers[0]!.fingerprint = `sha256:${"0".repeat(64)}`))).rejects.toThrow(/does not match its key/u);
    await expect(entriesFromDocument({ format: "other", publishers: [] })).rejects.toThrow(/format/u);
    await expect(entriesFromDocument({ format: TRUST_STORE_FORMAT, publishers: {} })).rejects.toThrow(/must be a list/u);
    await expect(corrupt((doc) => (doc.publishers[0]!.extra = 1))).rejects.toThrow(/Unknown trust store fields/u);
    await expect(corrupt((doc) => doc.publishers.push({ ...doc.publishers[0]! }))).rejects.toThrow(/duplicate fingerprints/u);
    await expect(corrupt((doc) => (doc.publishers[0]!.public_key = "AAAA"))).rejects.toThrow(/not a raw Ed25519 key/u);
    await expect(corrupt((doc) => (doc.publishers[0]!.publisher_id = "no spaces allowed"))).rejects.toThrow(/letters, digits/u);
    await expect(entriesFromDocument(null)).resolves.toEqual([]);
    const error = await corrupt((doc) => (doc.publishers[0]!.fingerprint = "x")).catch((caught: unknown) => caught as CoreError);
    expect((error as CoreError).status).toBe(500);
  });

  it("generated and pinned fingerprints agree", async () => {
    const key = await generateKeyPair();
    const { store: trust } = store();
    const entry = await trust.add(key.publicKey, { displayName: "local" });
    expect(entry.fingerprint).toBe(key.fingerprint);
    expect(entry.public_key).toBe(rawBase64(key.publicKey));
    expect(await fingerprint(key.publicKey)).toBe(key.fingerprint);
  });
});

describe("pinning the signer of an open package", () => {
  it("uses the key already under review; no key material travels", async () => {
    const { store: trust } = store();
    const { pkg, key } = await signedAgenda();
    const before = await publisherReport(pkg, trust);
    expect(before.trust_status).toBe("unknown");
    const result = await pinPackagePublisher(trust, pkg, before, { signerFingerprint: before.signer_fingerprint!, scope: "package" });
    expect(result.added.fingerprint).toBe(key.fingerprint);
    expect(result.added.public_key).toBe(rawBase64(key.publicKey));
    expect(result.added.publisher_id).toBe("webagents-research");
    expect(result.added.display_name).toBe("WebAgents Research Prototype");
    // The narrow default scopes the pin to this exact package id.
    expect(result.added.package_id_prefix).toBe("org.webagents.meeting-agenda");
    expect(result.trust_store.entry_count).toBe(1);
    const after = await publisherReport(pkg, trust);
    expect(after.trust_status).toBe("trusted");
  });

  it("the publisher scope is broader and explicit", async () => {
    const { store: trust } = store();
    const { pkg } = await signedAgenda();
    const report = await publisherReport(pkg, trust);
    const result = await pinPackagePublisher(trust, pkg, report, { signerFingerprint: report.signer_fingerprint!, scope: "publisher" });
    expect(result.added.package_id_prefix).toBeNull();
    expect(result.added.publisher_id).toBe("webagents-research");
    await expect(
      pinPackagePublisher(trust, pkg, report, { signerFingerprint: report.signer_fingerprint!, scope: "everything" as never }),
    ).rejects.toThrow(/scope/u);
  });

  it("requires the displayed fingerprint and a valid signature", async () => {
    const { store: trust } = store();
    const { pkg, files } = await signedAgenda();
    const report = await publisherReport(pkg, trust);
    const mismatch = await pinPackagePublisher(trust, pkg, report, { signerFingerprint: `sha256:${"0".repeat(64)}` }).catch(
      (error: unknown) => error as CoreError,
    );
    expect((mismatch as CoreError).code).toBe("fingerprint_mismatch");
    expect((mismatch as CoreError).details.session_signer_fingerprint).toBe(report.signer_fingerprint);
    expect(await trust.entries()).toEqual([]);
    const unsigned = await loadPackageBytes(await archiveBytes(files));
    const unsignedReport = await publisherReport(unsigned, trust);
    const refused = await pinPackagePublisher(trust, unsigned, unsignedReport, { signerFingerprint: `sha256:${"0".repeat(64)}` }).catch(
      (error: unknown) => error as CoreError,
    );
    expect((refused as CoreError).code).toBe("signature_not_valid");
    expect(await trust.entries()).toEqual([]);
  });

  it("removing a pin downgrades the package again", async () => {
    const { store: trust } = store();
    const { pkg } = await signedAgenda();
    const report = await publisherReport(pkg, trust);
    await pinPackagePublisher(trust, pkg, report, { signerFingerprint: report.signer_fingerprint! });
    expect((await publisherReport(pkg, trust)).trust_status).toBe("trusted");
    await trust.remove(report.signer_fingerprint!);
    expect((await publisherReport(pkg, trust)).trust_status).toBe("unknown");
  });
});
