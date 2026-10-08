/**
 * Signed documents of the WebAgents extensions (`spec/extensions/signed-document-v0.md`): an
 * agent index (T8) and a policy bundle (T8) travel as one envelope,
 *
 *   {format: "org.webagents:signed-document-v0", content_type, content, signature}
 *
 * where Ed25519 signs `UTF8("WebAgents signed document v0") || 0x00 || UTF8(content_type) ||
 * 0x00 || JCS(content)`. The content type is part of the transcript, so an index signature can
 * never be replayed as a policy, and the domain differs from the package signature's, so neither
 * can pass for a package signature. The envelope carries no key: the verifier holds the key the
 * person pinned when they added the index or subscribed to the policy, and selects it by
 * `key_fingerprint`. A document is metadata about where agents are or what a person chose to
 * follow; verifying it says who signed it, nothing more.
 */
import { canonicalJson } from "./canonical.js";
import { CoreError, ValidationError } from "./errors.js";
import { concatBytes, sha256Hex } from "./hash.js";
import { isJsonObject, parseJson, type JsonObject, type JsonValue } from "./json.js";
import { base64Decode, base64Encode, fingerprint } from "./keys.js";
import { extensionSchemaFailure } from "./schema.js";
import { verifyEd25519 } from "./signature.js";

export const SIGNED_DOCUMENT_FORMAT = "org.webagents:signed-document-v0";
export const AGENT_INDEX_TYPE = "org.webagents:agent-index-v0";
export const POLICY_BUNDLE_TYPE = "org.webagents:policy-bundle-v0";
export type DocumentContentType = typeof AGENT_INDEX_TYPE | typeof POLICY_BUNDLE_TYPE;
export const DOCUMENT_DOMAIN = "WebAgents signed document v0";
/** A document is read whole: at most this many bytes. */
export const MAX_DOCUMENT_BYTES = 1024 * 1024;

const CONTENT_SCHEMAS: Readonly<Record<DocumentContentType, string>> = Object.freeze({
  [AGENT_INDEX_TYPE]: "agent-index-v0",
  [POLICY_BUNDLE_TYPE]: "policy-bundle-v0",
});

const DESCRIPTIONS: Readonly<Record<DocumentContentType, string>> = Object.freeze({
  [AGENT_INDEX_TYPE]: "agent index",
  [POLICY_BUNDLE_TYPE]: "policy bundle",
});

export interface SignedDocument {
  format: typeof SIGNED_DOCUMENT_FORMAT;
  content_type: DocumentContentType;
  content: JsonObject;
  signature: { algorithm: "ed25519"; key_fingerprint: string; value: string };
}

/** What a verified document is, and who signed it. */
export interface VerifiedDocument {
  content_type: DocumentContentType;
  content: JsonObject;
  /** The pinned key that verified it. */
  signer_fingerprint: string;
  /** SHA-256 of the bytes as received (the transport identity). */
  document_sha256: string;
  /** SHA-256 of `JCS(content)` (the identity a receipt or a cache names). */
  content_sha256: string;
}

/** The signed transcript (§2 of the spec). */
export function signingMessage(contentType: DocumentContentType, content: JsonValue): Uint8Array {
  const encoder = new TextEncoder();
  return concatBytes(encoder.encode(DOCUMENT_DOMAIN), new Uint8Array([0]), encoder.encode(contentType), new Uint8Array([0]), canonicalJson(content));
}

function refuse(code: string, message: string, details: Record<string, unknown> | null = null): CoreError {
  return new CoreError(code, message, { status: 422, details });
}

/**
 * Verify one envelope against the keys pinned for this kind of document, then validate its
 * content against the content type's schema. Every refusal has a stable code:
 * `document_too_large`, `document_invalid` (not JSON, or not an envelope),
 * `document_type_mismatch`, `document_key_unknown` (signed by a key not pinned here),
 * `document_signature_invalid`, `document_content_invalid`.
 */
export async function verifySignedDocument(bytes: Uint8Array, expected: DocumentContentType, pinnedKeys: readonly Uint8Array[]): Promise<VerifiedDocument> {
  const what = DESCRIPTIONS[expected];
  if (bytes.length > MAX_DOCUMENT_BYTES) throw refuse("document_too_large", `The ${what} exceeds ${MAX_DOCUMENT_BYTES} bytes.`);
  let value: JsonValue;
  try {
    value = parseJson(bytes, what);
  } catch (error) {
    if (error instanceof ValidationError) throw refuse("document_invalid", `The ${what} is not strict JSON: ${error.message}`);
    throw error;
  }
  const envelopeFailure = await extensionSchemaFailure(value, "signed-document-v0");
  if (envelopeFailure !== null) throw refuse("document_invalid", `The ${what} is not a signed document: ${envelopeFailure}`);
  const envelope = value as unknown as SignedDocument;
  if (envelope.content_type !== expected) {
    throw refuse("document_type_mismatch", `Expected a signed ${what} (${expected}); this document is ${envelope.content_type}.`, { content_type: envelope.content_type });
  }
  let key: Uint8Array | null = null;
  for (const candidate of pinnedKeys) {
    if ((await fingerprint(candidate)) === envelope.signature.key_fingerprint) key = candidate;
  }
  if (key === null) {
    throw refuse("document_key_unknown", `The ${what} is signed by ${envelope.signature.key_fingerprint}, which is not the key pinned for it here.`, { key_fingerprint: envelope.signature.key_fingerprint });
  }
  if (!(await verifyEd25519(base64Decode(envelope.signature.value), signingMessage(expected, envelope.content), key))) {
    throw refuse("document_signature_invalid", `The ${what}'s signature does not verify under the pinned key ${envelope.signature.key_fingerprint}.`);
  }
  const contentFailure = await extensionSchemaFailure(envelope.content, CONTENT_SCHEMAS[expected]);
  if (contentFailure !== null) throw refuse("document_content_invalid", `The ${what} is signed, but its content is not a valid ${expected}: ${contentFailure}`);
  return {
    content_type: expected,
    content: envelope.content,
    signer_fingerprint: envelope.signature.key_fingerprint,
    document_sha256: await sha256Hex(bytes),
    content_sha256: await sha256Hex(canonicalJson(envelope.content)),
  };
}

/**
 * Build an envelope with a signing function the caller supplies (the CLI's Node key, a test's
 * key): the core holds no private key and signs nothing itself.
 */
export async function buildSignedDocument(
  contentType: DocumentContentType,
  content: JsonObject,
  signer: { publicKey: Uint8Array; sign: (message: Uint8Array) => Promise<Uint8Array> | Uint8Array },
): Promise<SignedDocument> {
  if (!isJsonObject(content)) throw new TypeError("content must be a JSON object");
  const signature = await signer.sign(signingMessage(contentType, content));
  if (signature.length !== 64) throw new TypeError("an Ed25519 signature is 64 bytes");
  return {
    format: SIGNED_DOCUMENT_FORMAT,
    content_type: contentType,
    content,
    signature: { algorithm: "ed25519", key_fingerprint: await fingerprint(signer.publicKey), value: base64Encode(signature) },
  };
}

/** The serialized form written to disk and served: two-space JSON with a final newline. */
export function serializeSignedDocument(document: SignedDocument): string {
  return `${JSON.stringify(document, null, 2)}\n`;
}
