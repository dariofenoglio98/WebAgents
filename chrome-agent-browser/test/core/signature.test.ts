import { describe, expect, it } from "vitest";

import { readArchiveBytes } from "../../src/core/archive.js";
import { canonicalJson } from "../../src/core/canonical.js";
import { CoreError, SignatureError } from "../../src/core/errors.js";
import { concatBytes, sha256Hex } from "../../src/core/hash.js";
import type { JsonObject } from "../../src/core/json.js";
import {
  base64Decode,
  base64Encode,
  fingerprint,
  publicKeyFromPem,
  publicKeyFromRawBase64,
  publicKeyToPem,
  rawBase64,
} from "../../src/core/keys.js";
import {
  checkSignature,
  DOMAIN,
  embeddedPublicKey,
  signatureReport,
  verifyEd25519,
  verifyWithTrustedKey,
  type Ed25519Subtle,
} from "../../src/core/signature.js";
import { generateKeyPair, sign, signatureDocument, signedArchive } from "../helpers/keys.js";
import { ORIGINAL_FINGERPRINT, ORIGINAL_KEY, readBytes, readText, SHIPPED } from "../helpers/paths.js";
import { archiveBytes } from "../helpers/zip.js";

const text = (value: string) => new TextEncoder().encode(value);

async function loadSigned(path: string) {
  const contents = await readArchiveBytes(readBytes(path));
  const digest = await sha256Hex(canonicalJson(contents.integrity));
  return { ...contents, digest };
}

describe("public keys (signing.py, browser/trust.py)", () => {
  it("reads the shipped development keys and derives their recorded fingerprints", async () => {
    for (const [pem, expected] of [
      [SHIPPED.webair.key, SHIPPED.webair.fingerprint],
      [SHIPPED.literatureReview.key, SHIPPED.literatureReview.fingerprint],
      [SHIPPED.meetingAgenda.key, SHIPPED.meetingAgenda.fingerprint],
      [ORIGINAL_KEY, ORIGINAL_FINGERPRINT],
    ] as const) {
      const raw = publicKeyFromPem(readText(pem));
      expect(raw.length).toBe(32);
      expect(await fingerprint(raw)).toBe(expected);
      // Round trip through PEM and raw base64.
      expect(publicKeyFromPem(publicKeyToPem(raw))).toEqual(raw);
      expect(publicKeyFromRawBase64(rawBase64(raw))).toEqual(raw);
    }
  });

  it("refuses private keys by name, non-Ed25519 keys and malformed PEM", () => {
    const refused = (() => {
      try {
        publicKeyFromPem("-----BEGIN PRIVATE KEY-----\nMC4CAQAwBQYDK2VwBCIEIA==\n-----END PRIVATE KEY-----\n");
      } catch (error) {
        return error as CoreError;
      }
      return null;
    })();
    expect(refused).toBeInstanceOf(CoreError);
    expect(refused?.code).toBe("trust_private_key_refused");
    expect(() => publicKeyFromPem("-----BEGIN PUBLIC KEY-----\nnot a key\n-----END PUBLIC KEY-----\n")).toThrow(CoreError);
    // A valid SubjectPublicKeyInfo of a different algorithm (RSA prefix) is refused.
    const rsa = `-----BEGIN PUBLIC KEY-----\n${base64Encode(new Uint8Array([0x30, 0x82, 0x01, 0x22, 0x30, 0x0d, 0x06, 0x09]))}\n-----END PUBLIC KEY-----\n`;
    expect(() => publicKeyFromPem(rsa)).toThrow(/Only Ed25519/u);
    expect(() => publicKeyFromPem("x".repeat(17 * 1024))).toThrow(/exceeds/u);
    expect(() => publicKeyFromRawBase64("AAAA")).toThrow(SignatureError);
    expect(() => publicKeyFromRawBase64("not base64!")).toThrow(SignatureError);
  });

  it("base64 is strict, as b64decode(validate=True)", () => {
    expect(base64Decode("")).toEqual(new Uint8Array());
    expect(base64Decode(base64Encode(new Uint8Array([0, 255, 7])))).toEqual(new Uint8Array([0, 255, 7]));
    for (const bad of ["abc", "ab=c", "a b c d", "abcd\n", "ab==cd", "!!!!", "===="]) {
      expect(() => base64Decode(bad), bad).toThrow(TypeError);
    }
  });
});

describe("signatures (signing.py, browser/evaluation.py)", () => {
  it("the shipped packages are self-consistent and verify only under their own key", async () => {
    const webair = await loadSigned(SHIPPED.webair.archive);
    const report = await signatureReport(webair);
    expect(report).toEqual({
      signature_status: "valid",
      signature_reason: "self_consistent_ed25519_signature",
      signer_fingerprint: SHIPPED.webair.fingerprint,
      signed_digest_matches: true,
    });
    const manifest = { package_id: "org.webagents.webair", version: "0.3.0", publisher: { id: "webair-demo", name: "WebAir" } } as JsonObject;
    const verified = await verifyWithTrustedKey({ ...webair, manifest }, publicKeyFromPem(readText(SHIPPED.webair.key)));
    expect(verified.valid).toBe(true);
    expect(verified.digest).toBe(SHIPPED.webair.digest);
    expect(verified.key_fingerprint).toBe(SHIPPED.webair.fingerprint);
    // The wrong pinned key is refused before any cryptography.
    await expect(
      verifyWithTrustedKey({ ...webair, manifest }, publicKeyFromPem(readText(SHIPPED.literatureReview.key))),
    ).rejects.toThrow(/not the host-pinned trusted key/u);
  });

  it("a freshly signed archive verifies, and tampering is detected (test_real_signatures_trust_pin_tampering_and_key_permissions)", async () => {
    const { files } = await readArchiveBytes(readBytes(SHIPPED.meetingAgenda.archive));
    const key = await generateKeyPair();
    const other = await generateKeyPair();
    const unsigned = await archiveBytes(files);
    const unsignedContents = await readArchiveBytes(unsigned);
    const unsignedDigest = await sha256Hex(canonicalJson(unsignedContents.integrity));
    await expect(checkSignature({ ...unsignedContents, digest: unsignedDigest }, key.publicKey)).rejects.toThrow(/signature missing/u);
    expect((await signatureReport({ ...unsignedContents, digest: unsignedDigest })).signature_status).toBe("absent");

    const signed = await signedArchive(files, key);
    const contents = await readArchiveBytes(signed);
    const digest = await sha256Hex(canonicalJson(contents.integrity));
    const report = await signatureReport({ ...contents, digest });
    expect(report.signature_status).toBe("valid");
    expect(report.signer_fingerprint).toBe(key.fingerprint);
    await expect(checkSignature({ ...contents, digest }, other.publicKey)).rejects.toThrow(/invalid Ed25519 publisher signature/u);

    // Tampered but rehashed: the integrity statement is consistent, the signed digest is not.
    const tampered = new Map(files);
    const skill = [...files.keys()].find((name) => name.startsWith("skills/"))!;
    tampered.set(skill, text("Tampered but rehashed instructions"));
    const rehashed = await readArchiveBytes(await archiveBytes(tampered, contents.signature));
    const rehashedDigest = await sha256Hex(canonicalJson(rehashed.integrity));
    const tamperedReport = await signatureReport({ ...rehashed, digest: rehashedDigest });
    expect(tamperedReport.signature_status).toBe("invalid");
    expect(tamperedReport.signature_reason).toMatch(/signed digest differs/u);
    expect(tamperedReport.signer_fingerprint).toBe(key.fingerprint);
    expect(tamperedReport.signed_digest_matches).toBe(false);
  });

  it("an envelope whose embedded key and fingerprint disagree is invalid, never trusted", async () => {
    const { files } = await readArchiveBytes(readBytes(SHIPPED.meetingAgenda.archive));
    const key = await generateKeyPair();
    const other = await generateKeyPair();
    const document = await signatureDocument(files, key);
    const swapped = { ...document, public_key: base64Encode(other.publicKey) };
    await expect(embeddedPublicKey(swapped)).rejects.toThrow(/fingerprint does not match/u);
    const contents = await readArchiveBytes(await archiveBytes(files, swapped));
    const report = await signatureReport({ ...contents, digest: String(document.digest) });
    expect(report.signature_status).toBe("invalid");
    expect(report.signer_fingerprint).toBeNull();
    // A corrupted signature value with a consistent key reports the signer but stays invalid.
    const flipped = base64Decode(String(document.signature));
    flipped[0] = flipped[0]! ^ 1;
    const corrupted = await readArchiveBytes(await archiveBytes(files, { ...document, signature: base64Encode(flipped) }));
    const corruptedReport = await signatureReport({ ...corrupted, digest: String(document.digest) });
    expect(corruptedReport.signature_status).toBe("invalid");
    expect(corruptedReport.signer_fingerprint).toBe(key.fingerprint);
  });

  it("the domain separation is exact and the pure-JS fallback agrees with WebCrypto", async () => {
    expect(new TextDecoder().decode(DOMAIN.subarray(0, DOMAIN.length - 1))).toBe("Agent Package v0.1 publisher signature");
    expect(DOMAIN[DOMAIN.length - 1]).toBe(0);
    const key = await generateKeyPair();
    const message = concatBytes(DOMAIN, text("payload"));
    const signature = await sign(key, message);
    expect(await verifyEd25519(signature, message, key.publicKey)).toBe(true);
    expect(await verifyEd25519(signature, text("other"), key.publicKey)).toBe(false);
    const unsupported: Ed25519Subtle = {
      importKey: async () => {
        throw new DOMException("Unrecognized name.", "NotSupportedError");
      },
      verify: async () => {
        throw new Error("never reached");
      },
    };
    expect(await verifyEd25519(signature, message, key.publicKey, unsupported)).toBe(true);
    expect(await verifyEd25519(signature, text("other"), key.publicKey, unsupported)).toBe(false);
    expect(await verifyEd25519(signature.slice(1), message, key.publicKey, unsupported)).toBe(false);
    expect(await verifyEd25519(signature, message, key.publicKey.slice(1))).toBe(false);
  });
});
