/**
 * Publisher signatures, mirroring `agentpkg/signing.py` and `browser/evaluation.py`.
 *
 * Ed25519 signs `UTF8("Agent Package v0.1 publisher signature") || 0x00 || JCS(integrity)`.
 * Checking a signature with the key embedded in the artifact answers only "is this envelope
 * internally consistent?"; `signatureReport` says so in its own field. Trust is a separate
 * fact decided by the trust store (D-006). WebCrypto verifies when it knows Ed25519
 * (Chrome ≥ 137, Node ≥ 20); `@noble/ed25519` is the fallback for a `subtle` that does not.
 */
import { verifyAsync } from "@noble/ed25519";

import { canonicalJson } from "./canonical.js";
import { SignatureError } from "./errors.js";
import { bufferSource, bytesEqual, concatBytes } from "./hash.js";
import type { JsonObject } from "./json.js";
import { base64Decode, fingerprint, publicKeyFromRawBase64 } from "./keys.js";

export const DOMAIN = concatBytes(new TextEncoder().encode("Agent Package v0.1 publisher signature"), new Uint8Array([0]));

/** What `checkSignature` needs from a loaded package. */
export interface SignedContent {
  readonly integrity: JsonObject;
  readonly digest: string;
  readonly signature: JsonObject | null;
}

/**
 * The slice of WebCrypto `verifyEd25519` needs, typed structurally so the same code
 * compiles against the core's global allowlist and against the DOM library.
 */
export interface Ed25519Subtle {
  importKey(
    format: "raw",
    keyData: Uint8Array<ArrayBuffer>,
    algorithm: { name: string },
    extractable: boolean,
    keyUsages: readonly "verify"[],
  ): Promise<unknown>;
  verify(
    algorithm: { name: string },
    key: unknown,
    signature: Uint8Array<ArrayBuffer>,
    data: Uint8Array<ArrayBuffer>,
  ): Promise<boolean>;
}

export interface SignatureReport {
  signature_status: "valid" | "invalid" | "absent";
  signature_reason: string;
  signer_fingerprint: string | null;
  signed_digest_matches: boolean;
}

/**
 * Verify one Ed25519 signature. WebCrypto first; the pure-JS implementation only when the
 * platform's `subtle` lacks the algorithm. A malformed key or signature is `false`, never
 * an exception, so callers report one stable verdict.
 */
export async function verifyEd25519(
  signature: Uint8Array,
  message: Uint8Array,
  publicKey: Uint8Array,
  subtle: Ed25519Subtle = crypto.subtle as unknown as Ed25519Subtle,
): Promise<boolean> {
  if (publicKey.length !== 32 || signature.length !== 64) return false;
  let key: unknown = null;
  try {
    key = await subtle.importKey("raw", bufferSource(publicKey), { name: "Ed25519" }, false, ["verify"]);
  } catch {
    key = null;
  }
  if (key !== null) {
    try {
      return await subtle.verify({ name: "Ed25519" }, key, bufferSource(signature), bufferSource(message));
    } catch {
      return false;
    }
  }
  try {
    // RFC 8032 strictness, as OpenSSL (the reference's backend) verifies: the library's
    // default ZIP215 branch is cofactored and accepts non-canonical encodings.
    return await verifyAsync(signature, message, publicKey, { zip215: false });
  } catch {
    return false;
  }
}

/**
 * `signing.py::embedded_public_key`: the key carried inside an artifact. NEVER a trust
 * anchor; it only answers whether the envelope is internally consistent.
 */
export async function embeddedPublicKey(signature: JsonObject): Promise<Uint8Array> {
  let raw: Uint8Array;
  try {
    raw = publicKeyFromRawBase64(signature.public_key);
  } catch {
    throw new SignatureError("embedded publisher key is not a raw Ed25519 public key");
  }
  if (signature.key_fingerprint !== (await fingerprint(raw))) {
    throw new SignatureError("embedded key fingerprint does not match the embedded key");
  }
  return raw;
}

/** `signing.py::check_signature`: digest binding and the domain-separated transcript. */
export async function checkSignature(content: SignedContent, publicKey: Uint8Array): Promise<void> {
  const signature = content.signature;
  if (signature === null) throw new SignatureError("publisher signature missing; build and sign the artifact first");
  if (signature.digest !== content.digest) {
    throw new SignatureError("signed digest differs from package integrity statement");
  }
  let bytes: Uint8Array;
  try {
    bytes = base64Decode(String(signature.signature));
  } catch {
    throw new SignatureError("invalid Ed25519 publisher signature");
  }
  const message = concatBytes(DOMAIN, canonicalJson(content.integrity));
  if (!(await verifyEd25519(bytes, message, publicKey))) {
    throw new SignatureError("invalid Ed25519 publisher signature");
  }
}

/** `browser/evaluation.py::signature_report`: self-consistency only. */
export async function signatureReport(content: SignedContent): Promise<SignatureReport> {
  const signature = content.signature;
  if (signature === null) {
    return {
      signature_status: "absent",
      signature_reason: "no_signature_member",
      signer_fingerprint: null,
      signed_digest_matches: false,
    };
  }
  let key: Uint8Array;
  try {
    key = await embeddedPublicKey(signature);
  } catch (error) {
    return {
      signature_status: "invalid",
      signature_reason: (error as Error).message,
      signer_fingerprint: null,
      signed_digest_matches: false,
    };
  }
  const signer = await fingerprint(key);
  try {
    await checkSignature(content, key);
  } catch (error) {
    return {
      signature_status: "invalid",
      signature_reason: (error as Error).message,
      // Reported so an operator can see which key failed, never as trust.
      signer_fingerprint: signer,
      signed_digest_matches: signature.digest === content.digest,
    };
  }
  return {
    signature_status: "valid",
    signature_reason: "self_consistent_ed25519_signature",
    signer_fingerprint: signer,
    signed_digest_matches: true,
  };
}

export interface VerifyReport {
  valid: true;
  digest: string;
  package_id: string;
  version: string;
  publisher: JsonObject;
  key_fingerprint: string;
  trust_scope: "exact externally supplied publisher key";
}

/**
 * `signing.py::verify_package`: the signature must have been made by exactly this
 * externally supplied key, compared by raw bytes and fingerprint, and must verify.
 */
export async function verifyWithTrustedKey(
  content: SignedContent & { manifest: JsonObject },
  trustedKey: Uint8Array,
): Promise<VerifyReport> {
  const signature = content.signature;
  if (signature === null) throw new SignatureError("publisher signature missing; build and sign the artifact first");
  const expected = await fingerprint(trustedKey);
  let embedded: Uint8Array;
  try {
    embedded = base64Decode(String(signature.public_key));
  } catch {
    throw new SignatureError("publisher key is not the host-pinned trusted key");
  }
  if (signature.key_fingerprint !== expected || !bytesEqual(embedded, trustedKey)) {
    throw new SignatureError("publisher key is not the host-pinned trusted key");
  }
  await checkSignature(content, trustedKey);
  return {
    valid: true,
    digest: content.digest,
    package_id: String(content.manifest.package_id),
    version: String(content.manifest.version),
    publisher: content.manifest.publisher as JsonObject,
    key_fingerprint: expected,
    trust_scope: "exact externally supplied publisher key",
  };
}
