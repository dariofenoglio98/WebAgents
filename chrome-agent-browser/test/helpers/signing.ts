/** Throwaway Ed25519 keys for signed documents (T8): node:crypto signs, the core verifies. */
import { generateKeyPairSync, sign } from "node:crypto";

import type { JsonObject } from "../../src/core/json.js";
import { buildSignedDocument, serializeSignedDocument, type DocumentContentType } from "../../src/core/signed-document.js";

export interface TestSigner {
  publicKey: Uint8Array;
  pem: string;
  sign(message: Uint8Array): Uint8Array;
}

export function newSigner(): TestSigner {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const der = publicKey.export({ format: "der", type: "spki" });
  return {
    publicKey: new Uint8Array(der.subarray(der.length - 32)),
    pem: publicKey.export({ format: "pem", type: "spki" }).toString(),
    sign: (message) => new Uint8Array(sign(null, message, privateKey)),
  };
}

/** The bytes a publisher would serve for this content. */
export async function signedBytes(type: DocumentContentType, content: JsonObject, signer: TestSigner): Promise<Uint8Array> {
  return new TextEncoder().encode(serializeSignedDocument(await buildSignedDocument(type, content, signer)));
}

export function rawKeyBase64(publicKey: Uint8Array): string {
  return Buffer.from(publicKey).toString("base64");
}
