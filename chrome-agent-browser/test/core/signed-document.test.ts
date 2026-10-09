/**
 * Signed documents (T8, `spec/extensions/signed-document-v0.md`): the envelope verifies only
 * under the pinned key, for the expected content type, over the exact content; every refusal has
 * its own code; and the shipped demo index and research policy verify under their development
 * keys and name exactly the shipped packages.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { CoreError } from "../../src/core/errors.js";
import type { JsonObject } from "../../src/core/json.js";
import { fingerprint, publicKeyFromPem } from "../../src/core/keys.js";
import { readPolicyBundle } from "../../src/core/policies/bundle.js";
import { readAgentIndex } from "../../src/core/resolve/static-index.js";
import { AGENT_INDEX_TYPE, MAX_DOCUMENT_BYTES, POLICY_BUNDLE_TYPE, signingMessage, verifySignedDocument, type DocumentContentType } from "../../src/core/signed-document.js";
import { ROOT, SHIPPED } from "../helpers/paths.js";
import { newSigner, signedBytes } from "../helpers/signing.js";

const INDEX_CONTENT = JSON.parse(readFileSync(resolve(ROOT, "examples/agent-index.content.json"), "utf8")) as JsonObject;
const POLICY_CONTENT = JSON.parse(readFileSync(resolve(ROOT, "examples/policies/webagents-research.content.json"), "utf8")) as JsonObject;

async function refusal(bytes: Uint8Array, type: DocumentContentType, keys: Uint8Array[]): Promise<string> {
  try {
    await verifySignedDocument(bytes, type, keys);
  } catch (error) {
    if (error instanceof CoreError) return error.code;
    throw error;
  }
  return "accepted";
}

function edit(bytes: Uint8Array, change: (document: Record<string, unknown>) => void): Uint8Array {
  const document = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
  change(document);
  return new TextEncoder().encode(JSON.stringify(document));
}

describe("signed documents", () => {
  it("the transcript separates the domain and the content type", () => {
    const index = new TextDecoder().decode(signingMessage(AGENT_INDEX_TYPE, { a: 1 }));
    expect(index).toBe('WebAgents signed document v0\u0000org.webagents:agent-index-v0\u0000{"a":1}');
    expect(new TextDecoder().decode(signingMessage(POLICY_BUNDLE_TYPE, { a: 1 }))).not.toBe(index);
  });

  it("verifies under the pinned key and reports who signed what", async () => {
    const signer = newSigner();
    const bytes = await signedBytes(AGENT_INDEX_TYPE, INDEX_CONTENT, signer);
    const other = newSigner();
    const verified = await verifySignedDocument(bytes, AGENT_INDEX_TYPE, [other.publicKey, signer.publicKey]);
    expect(verified.signer_fingerprint).toBe(await fingerprint(signer.publicKey));
    expect(verified.content).toEqual(INDEX_CONTENT);
    expect(verified.content_sha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(verified.document_sha256).toMatch(/^[0-9a-f]{64}$/u);
  });

  it("refuses each defect with its own code", async () => {
    const signer = newSigner();
    const index = await signedBytes(AGENT_INDEX_TYPE, INDEX_CONTENT, signer);
    const keys = [signer.publicKey];
    expect(await refusal(index, AGENT_INDEX_TYPE, [newSigner().publicKey])).toBe("document_key_unknown");
    expect(await refusal(index, POLICY_BUNDLE_TYPE, keys)).toBe("document_type_mismatch");
    // An index signature presented as a policy: the type is in the transcript, so relabelling fails the signature.
    expect(await refusal(edit(index, (d) => (d.content_type = POLICY_BUNDLE_TYPE)), POLICY_BUNDLE_TYPE, keys)).toBe("document_signature_invalid");
    expect(await refusal(edit(index, (d) => ((d.content as JsonObject).title = "Another index")), AGENT_INDEX_TYPE, keys)).toBe("document_signature_invalid");
    expect(await refusal(edit(index, (d) => (d.extra = 1)), AGENT_INDEX_TYPE, keys)).toBe("document_invalid");
    expect(await refusal(edit(index, (d) => ((d.signature as JsonObject).algorithm = "rsa")), AGENT_INDEX_TYPE, keys)).toBe("document_invalid");
    expect(await refusal(new TextEncoder().encode('{"format": 1, "format": 2}'), AGENT_INDEX_TYPE, keys)).toBe("document_invalid");
    expect(await refusal(new TextEncoder().encode("not json"), AGENT_INDEX_TYPE, keys)).toBe("document_invalid");
    expect(await refusal(new Uint8Array(MAX_DOCUMENT_BYTES + 1), AGENT_INDEX_TYPE, keys)).toBe("document_too_large");
    // Signed, but the content is not an index: the publisher's mistake is still refused.
    const bad = await signedBytes(AGENT_INDEX_TYPE, { ...INDEX_CONTENT, entries: [] }, signer);
    expect(await refusal(bad, AGENT_INDEX_TYPE, keys)).toBe("document_content_invalid");
  });

  it("the shipped demo index verifies under its development key and names the shipped packages exactly", async () => {
    const key = publicKeyFromPem(readFileSync(resolve(ROOT, "examples/keys/webagents-index.pub.pem"), "utf8"));
    const verified = await verifySignedDocument(new Uint8Array(readFileSync(resolve(ROOT, "examples/agent-index.json"))), AGENT_INDEX_TYPE, [key]);
    expect(verified.content).toEqual(INDEX_CONTENT);
    const index = readAgentIndex(verified.content);
    expect(index.notes).toEqual([]);
    const byId = Object.fromEntries(index.entries.map((entry) => [entry.package_id, entry]));
    for (const shipped of [SHIPPED.literatureReview026, SHIPPED.webair050]) {
      const entry = byId[shipped.packageId]!;
      expect(entry.version).toBe(shipped.version);
      expect(entry.digest).toBe(shipped.digest);
      expect(entry.archive_sha256).toBe(shipped.archiveSha256);
      expect(entry.signer_fingerprint).toBe(shipped.fingerprint);
      expect(entry.publisher.id).toBe(shipped.publisherId);
    }
  });

  it("the demo index 1.0.0 is kept byte for byte where recorded evidence pins it, and still names 0.2.5 and 0.4.0 (T11, D-131)", async () => {
    const key = publicKeyFromPem(readFileSync(resolve(ROOT, "examples/keys/webagents-index.pub.pem"), "utf8"));
    const bytes = new Uint8Array(readFileSync(resolve(ROOT, "examples/agent-index-1.0.0.json")));
    // The T8 harness report records these bytes as the index it served.
    const evidence = JSON.parse(readFileSync(resolve(ROOT, "examples/verification/chrome-search-policy-e2e.json"), "utf8")) as { served: Record<string, { sha256: string }> };
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(evidence.served["/agent-index.json"]!.sha256);
    const index = readAgentIndex((await verifySignedDocument(bytes, AGENT_INDEX_TYPE, [key])).content);
    expect(index.version).toBe("1.0.0");
    expect(index.entries.map((entry) => [entry.package_id, entry.version, entry.digest])).toEqual([
      [SHIPPED.literatureReview.packageId, SHIPPED.literatureReview.version, SHIPPED.literatureReview.digest],
      [SHIPPED.webair040.packageId, SHIPPED.webair040.version, SHIPPED.webair040.digest],
    ]);
  });

  it("the shipped research policy verifies under its development key and anchors exactly the two publishers, each to its own package", async () => {
    const key = publicKeyFromPem(readFileSync(resolve(ROOT, "examples/keys/webagents-policy.pub.pem"), "utf8"));
    const bytes = new Uint8Array(readFileSync(resolve(ROOT, "examples/policies/webagents-research.json")));
    expect(await refusal(bytes, POLICY_BUNDLE_TYPE, [publicKeyFromPem(readFileSync(resolve(ROOT, "examples/keys/webagents-index.pub.pem"), "utf8"))])).toBe("document_key_unknown");
    const verified = await verifySignedDocument(bytes, POLICY_BUNDLE_TYPE, [key]);
    expect(verified.content).toEqual(POLICY_CONTENT);
    const bundle = await readPolicyBundle(verified.content);
    expect(bundle.trust_anchors.map((anchor) => [anchor.kind, anchor.fingerprint, anchor.kind === "publisher_key" ? anchor.package_id_prefix : null])).toEqual([
      ["publisher_key", SHIPPED.webair040.fingerprint, SHIPPED.webair040.packageId],
      ["publisher_key", SHIPPED.literatureReview.fingerprint, SHIPPED.literatureReview.packageId],
    ]);
    expect(bundle.decisions.payment).toBe("deny");
  });
});
