/**
 * Throwaway Ed25519 keys and package signing for tests, the way the Python suite uses
 * `keygen` and `sign_package`. Private keys exist only in memory, inside WebCrypto.
 */
import { webcrypto } from "node:crypto";

import { canonicalJson } from "../../src/core/canonical.js";
import { integrityStatement } from "../../src/core/archive.js";
import { concatBytes, sha256Hex } from "../../src/core/hash.js";
import type { JsonObject } from "../../src/core/json.js";
import { base64Encode, fingerprint } from "../../src/core/keys.js";
import { DOMAIN } from "../../src/core/signature.js";
import { archiveBytes } from "./zip.js";

export interface TestKeyPair {
  readonly privateKey: CryptoKey;
  readonly publicKey: Uint8Array;
  readonly fingerprint: string;
}

export async function generateKeyPair(): Promise<TestKeyPair> {
  const pair = (await webcrypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as unknown as CryptoKeyPair;
  const publicKey = new Uint8Array(await webcrypto.subtle.exportKey("raw", pair.publicKey));
  return { privateKey: pair.privateKey, publicKey, fingerprint: await fingerprint(publicKey) };
}

export async function sign(key: TestKeyPair, message: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await webcrypto.subtle.sign({ name: "Ed25519" }, key.privateKey, message));
}

/** The `signatures/publisher.json` document `sign_package` writes for these files. */
export async function signatureDocument(files: ReadonlyMap<string, Uint8Array>, key: TestKeyPair): Promise<JsonObject> {
  const integrity = await integrityStatement(files);
  const canonical = canonicalJson(integrity);
  return {
    format: "agent.pkg-signature-v0.1",
    algorithm: "Ed25519",
    key_fingerprint: key.fingerprint,
    public_key: base64Encode(key.publicKey),
    signature: base64Encode(await sign(key, concatBytes(DOMAIN, canonical))),
    digest: await sha256Hex(canonical),
  };
}

/** Build and sign: the archive `sign_package` would produce for these payload files. */
export async function signedArchive(files: ReadonlyMap<string, Uint8Array>, key: TestKeyPair): Promise<Uint8Array> {
  return archiveBytes(files, await signatureDocument(files, key));
}
