/**
 * A fake of the native helper behind the native port (T17, D-204): the same three operations, the
 * same refusals and the same blob format as `native-helper/` (the shared vector in
 * `test/core/keychain.test.ts` and `HelperCoreTests.wrapVector`), with knobs for every way the
 * real one can fail: not installed, refusing, exiting, timing out, the keychain item gone.
 */
import { NativePortError, type NativeFailure, type NativePort } from "../../src/core/keychain.js";
import { bufferSource } from "../../src/core/hash.js";
import { base64Decode, base64Encode } from "../../src/core/keys.js";

const AAD = new TextEncoder().encode("org.webagents.helper|keychain.wrap|v1");

export async function helperWrap(key: Uint8Array, kek: Uint8Array, nonce: Uint8Array): Promise<Uint8Array> {
  const aes = await crypto.subtle.importKey("raw", bufferSource(kek), { name: "AES-GCM" }, false, ["encrypt"]);
  const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: bufferSource(nonce), additionalData: AAD }, aes, bufferSource(key)));
  return new Uint8Array([1, ...nonce, ...sealed]);
}

async function helperUnwrap(blob: Uint8Array, kek: Uint8Array): Promise<Uint8Array | null> {
  if (blob.length !== 61 || blob[0] !== 1) return null;
  try {
    const aes = await crypto.subtle.importKey("raw", bufferSource(kek), { name: "AES-GCM" }, false, ["decrypt"]);
    return new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: bufferSource(blob.slice(1, 13)), additionalData: AAD }, aes, bufferSource(blob.slice(13))));
  } catch {
    return null;
  }
}

export class FakeHelper implements NativePort {
  /** The key-encryption key in the "keychain"; null until the first wrap (or after the item is deleted). */
  kek: Uint8Array | null = null;
  /** Fail below the protocol, as Chrome reports it. */
  portFailure: NativeFailure | null = null;
  /** Refuse every request with this helper code. */
  refuse: string | null = null;
  /** Answer `keychain.unwrap` with this key instead (a helper gone wrong). */
  unwrapOverride: Uint8Array | null = null;
  ollama = { installed: true, version: "0.40.3", running: true, server_version: "0.40.3", origins: "chrome-extension://abcdefghijklmnopabcdefghijklmnop", extension_allowed: true };
  readonly sent: Array<Record<string, unknown>> = [];

  async send(message: Record<string, unknown>): Promise<unknown> {
    this.sent.push(message);
    if (this.portFailure) throw new NativePortError(this.portFailure, this.portFailure);
    if (this.refuse) return { ok: false, helper: "0.1.0", error: { code: this.refuse, message: `refused: ${this.refuse}` } };
    switch (message.op) {
      case "ollama.status":
        return { ok: true, op: "ollama.status", helper: "0.1.0", ollama: this.ollama };
      case "keychain.wrap": {
        if (this.kek === null) this.kek = crypto.getRandomValues(new Uint8Array(32));
        const blob = await helperWrap(base64Decode(String(message.key)), this.kek, crypto.getRandomValues(new Uint8Array(12)));
        return { ok: true, op: "keychain.wrap", helper: "0.1.0", blob: base64Encode(blob) };
      }
      case "keychain.unwrap": {
        if (this.kek === null) return { ok: false, helper: "0.1.0", error: { code: "keychain_item_missing", message: "no item" } };
        if (this.unwrapOverride) return { ok: true, op: "keychain.unwrap", helper: "0.1.0", key: base64Encode(this.unwrapOverride) };
        const key = await helperUnwrap(base64Decode(String(message.blob)), this.kek);
        if (key === null) return { ok: false, helper: "0.1.0", error: { code: "unwrap_failed", message: "does not open" } };
        return { ok: true, op: "keychain.unwrap", helper: "0.1.0", key: base64Encode(key) };
      }
      default:
        return { ok: false, helper: "0.1.0", error: { code: "unknown_operation", message: "three operations only" } };
    }
  }
}
