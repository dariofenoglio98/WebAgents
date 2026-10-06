/**
 * Ed25519 public keys: raw bytes, base64 and SubjectPublicKeyInfo PEM.
 *
 * A key is 32 raw bytes everywhere in the format; its fingerprint is `sha256:` plus the
 * lowercase hex SHA-256 of those bytes (`signing.py::fingerprint`). PEM is accepted only as
 * the fixed Ed25519 SubjectPublicKeyInfo encoding (a 12-byte DER prefix and the key), and a
 * PEM that mentions a private key is refused before anything is decoded
 * (`browser/trust.py::public_key_from_pem`). Base64 is strict, as `b64decode(validate=True)`
 * is: alphabet only, correct padding.
 */
import { CoreError, SignatureError } from "./errors.js";
import { bytesEqual, sha256Hex } from "./hash.js";

export const MAX_KEY_BYTES = 16 * 1024;
export const ED25519_RAW_LENGTH = 32;
/** DER: SEQUENCE { SEQUENCE { OID 1.3.101.112 } BIT STRING (0 unused bits) ... } */
const SPKI_PREFIX = new Uint8Array([0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00]);
const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const LOOKUP = (() => {
  const table = new Int16Array(128).fill(-1);
  for (let index = 0; index < ALPHABET.length; index += 1) table[ALPHABET.charCodeAt(index)] = index;
  return table;
})();

export function base64Encode(bytes: Uint8Array): string {
  let out = "";
  for (let index = 0; index < bytes.length; index += 3) {
    const a = bytes[index]!;
    const b = bytes[index + 1];
    const c = bytes[index + 2];
    const triple = (a << 16) | ((b ?? 0) << 8) | (c ?? 0);
    out += ALPHABET[(triple >> 18) & 63]! + ALPHABET[(triple >> 12) & 63]!;
    out += b === undefined ? "=" : ALPHABET[(triple >> 6) & 63]!;
    out += c === undefined ? "=" : ALPHABET[triple & 63]!;
  }
  return out;
}

/** Strict base64: standard alphabet, no whitespace, exact padding. Throws `TypeError`. */
export function base64Decode(text: string): Uint8Array {
  if (typeof text !== "string" || text.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/u.test(text)) {
    throw new TypeError("invalid base64");
  }
  const padding = text.endsWith("==") ? 2 : text.endsWith("=") ? 1 : 0;
  const out = new Uint8Array((text.length / 4) * 3 - padding);
  let position = 0;
  for (let index = 0; index < text.length; index += 4) {
    const values = [0, 1, 2, 3].map((offset) => {
      const char = text.charCodeAt(index + offset);
      return char === 61 ? 0 : LOOKUP[char]!;
    });
    const triple = (values[0]! << 18) | (values[1]! << 12) | (values[2]! << 6) | values[3]!;
    if (position < out.length) out[position++] = (triple >> 16) & 255;
    if (position < out.length) out[position++] = (triple >> 8) & 255;
    if (position < out.length) out[position++] = triple & 255;
  }
  return out;
}

/** `signing.py::fingerprint`. */
export async function fingerprint(rawPublicKey: Uint8Array): Promise<string> {
  return `sha256:${await sha256Hex(rawPublicKey)}`;
}

/** `browser/trust.py::raw_base64`. */
export function rawBase64(rawPublicKey: Uint8Array): string {
  return base64Encode(rawPublicKey);
}

/** The 32 raw bytes a trust entry or signature envelope carries, or a `SignatureError`. */
export function publicKeyFromRawBase64(text: unknown): Uint8Array {
  let raw: Uint8Array;
  try {
    raw = base64Decode(String(text));
  } catch {
    throw new SignatureError("not a raw Ed25519 public key");
  }
  if (raw.length !== ED25519_RAW_LENGTH) throw new SignatureError("not a raw Ed25519 public key");
  return raw;
}

function trustInvalid(message: string, code = "trust_invalid"): CoreError {
  return new CoreError(code, message);
}

/**
 * `browser/trust.py::public_key_from_pem`: an Ed25519 SubjectPublicKeyInfo PEM and nothing
 * else. Private keys are refused by name before any decoding.
 */
export function publicKeyFromPem(pem: string | Uint8Array): Uint8Array {
  const text = typeof pem === "string" ? pem : new TextDecoder("utf-8", { fatal: false }).decode(pem);
  const byteLength = typeof pem === "string" ? new TextEncoder().encode(pem).length : pem.length;
  if (byteLength > MAX_KEY_BYTES) throw trustInvalid(`Public key PEM exceeds ${MAX_KEY_BYTES} bytes`);
  if (text.includes("PRIVATE KEY")) {
    throw trustInvalid(
      "Refusing a private key: the trust store holds public verification keys only",
      "trust_private_key_refused",
    );
  }
  const match = /-----BEGIN PUBLIC KEY-----([A-Za-z0-9+/=\s]*)-----END PUBLIC KEY-----/u.exec(text);
  if (!match) throw trustInvalid("Cannot read Ed25519 public key PEM: ValueError");
  let der: Uint8Array;
  try {
    der = base64Decode(match[1]!.replace(/\s+/gu, ""));
  } catch {
    throw trustInvalid("Cannot read Ed25519 public key PEM: ValueError");
  }
  if (der.length !== SPKI_PREFIX.length + ED25519_RAW_LENGTH || !bytesEqual(der.subarray(0, SPKI_PREFIX.length), SPKI_PREFIX)) {
    throw trustInvalid("Only Ed25519 publisher keys are supported");
  }
  return der.slice(SPKI_PREFIX.length);
}

/** The PEM `keygen` writes for a public key (SubjectPublicKeyInfo, 64-column lines). */
export function publicKeyToPem(rawPublicKey: Uint8Array): string {
  if (rawPublicKey.length !== ED25519_RAW_LENGTH) throw new TypeError("not a raw Ed25519 public key");
  const der = new Uint8Array(SPKI_PREFIX.length + ED25519_RAW_LENGTH);
  der.set(SPKI_PREFIX, 0);
  der.set(rawPublicKey, SPKI_PREFIX.length);
  const body = base64Encode(der).replace(/(.{64})/gu, "$1\n").replace(/\n$/u, "");
  return `-----BEGIN PUBLIC KEY-----\n${body}\n-----END PUBLIC KEY-----\n`;
}
