/**
 * Unlock from the macOS keychain through the optional native helper (T17, D-181, D-204).
 *
 * The helper does three things and nothing else: it wraps the store's master key under a key it
 * keeps in the login keychain (`keychain.wrap`), unwraps it again (`keychain.unwrap`), and reports
 * Ollama's state (`ollama.status`). This module is the extension's half of that protocol, with no
 * Chrome API: the client validates every reply strictly (closed fields, exact sizes), maps every
 * failure to a code the views explain, and defines the record the shell stores beside the
 * envelope (`secretKeychain`): the helper's blob and a check box sealed under the master key, so
 * a key the helper returns is accepted only when it opens the check for *this* envelope.
 * The helper never receives a provider key, a record, an entry or a package; the passphrase stays
 * the way in whenever the helper is missing, refused or unsure.
 */
import { CoreError } from "./errors.js";
import { isRecord } from "./fields.js";
import { base64Decode, base64Encode } from "./keys.js";
import type { SealedBox } from "./secrets.js";

/** The native-messaging host name the installer registers (D-203). */
export const NATIVE_HOST = "org.webagents.helper";
export const KEYCHAIN_RECORD_SCHEMA = "chrome-agent-browser-keychain-unlock-v1";
/** The helper's blob: version ‖ 12-byte nonce ‖ 32-byte ciphertext ‖ 16-byte tag (D-204). */
export const HELPER_BLOB_BYTES = 61;
const KEY_BYTES = 32;
/** A native call never waits longer than this; an unwrap may show the keychain's own prompt first. */
export const HELPER_TIMEOUT_MS = 60_000;

/** How a native call failed below the protocol: Chrome's own refusals, as the shell reads them. */
export type NativeFailure = "not_installed" | "forbidden" | "exited" | "timeout" | "no_permission" | "other";

export class NativePortError extends Error {
  constructor(
    readonly failure: NativeFailure,
    message: string,
  ) {
    super(message);
  }
}

/** One request, one reply (`chrome.runtime.sendNativeMessage`); in tests, a fake. */
export interface NativePort {
  send(message: Record<string, unknown>): Promise<unknown>;
}

export interface OllamaReport {
  installed: boolean;
  version: string | null;
  running: boolean;
  server_version: string | null;
  origins: string | null;
  extension_allowed: boolean;
}

export interface KeychainRecord {
  schema: typeof KEYCHAIN_RECORD_SCHEMA;
  enabled_at: string;
  /** The envelope this record belongs to (`created_at`): a re-created store never accepts it. */
  envelope_created_at: string;
  blob: string;
  check: SealedBox;
}

function helperError(code: string, message: string, details: Record<string, unknown> | null = null): CoreError {
  return new CoreError(code, message, { status: 503, details });
}

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/u;

function base64Length(text: string): number | null {
  if (text.length % 4 !== 0 || !BASE64.test(text)) return null;
  const padding = text.endsWith("==") ? 2 : text.endsWith("=") ? 1 : 0;
  return (text.length / 4) * 3 - padding;
}

function text(value: unknown, limit: number): string | null {
  return typeof value === "string" && value.length <= limit ? value : null;
}

/** Translate a port failure into the code a view explains. */
function portError(error: unknown): CoreError {
  if (error instanceof NativePortError) {
    switch (error.failure) {
      case "no_permission":
        return helperError("native_permission_missing", "Keychain unlock needs Chrome's permission to talk to the WebAgents helper; turn it on again in Settings → Security.");
      case "not_installed":
        return helperError("helper_not_installed", "The WebAgents helper is not installed on this Mac (or not for this extension). Use your passphrase; the macOS installer adds the helper.");
      case "forbidden":
        return helperError("helper_not_installed", "The installed WebAgents helper does not list this extension; reinstall it with the current installer.");
      case "timeout":
        return helperError("helper_timeout", "The WebAgents helper did not answer in time. Use your passphrase.");
      default:
        return helperError("helper_failed", `The WebAgents helper stopped without answering (${error.message}). Use your passphrase.`);
    }
  }
  return helperError("helper_failed", `The WebAgents helper could not be reached (${error instanceof Error ? error.message : "unknown error"}).`);
}

/**
 * The extension's client of the three operations. Every reply is read strictly; anything else
 * than the expected shape is `helper_failed`, a refusal the helper names is `helper_refused`
 * with its code in the details.
 */
export class HelperClient {
  constructor(private readonly port: NativePort) {}

  private async call(op: string, fields: Record<string, string>, expected: string[]): Promise<Record<string, unknown>> {
    let reply: unknown;
    try {
      reply = await this.port.send({ op, ...fields });
    } catch (error) {
      throw portError(error);
    }
    if (!isRecord(reply) || typeof reply.ok !== "boolean") throw helperError("helper_failed", "The WebAgents helper answered something this extension does not read.");
    if (reply.ok === false) {
      const error = isRecord(reply.error) ? reply.error : {};
      const code = text(error.code, 64) ?? "unknown";
      const message = text(error.message, 512) ?? "The helper refused.";
      throw helperError("helper_refused", message, { helper_code: code });
    }
    const allowed = new Set(["ok", "op", "helper", ...expected]);
    if (reply.op !== op || Object.keys(reply).some((key) => !allowed.has(key))) throw helperError("helper_failed", "The WebAgents helper answered a different request.");
    return reply;
  }

  /** The helper's version and Ollama's state: also the cheapest "is the helper there" question. */
  async status(): Promise<{ helper: string | null; ollama: OllamaReport }> {
    const reply = await this.call("ollama.status", {}, ["ollama"]);
    const raw = reply.ollama;
    if (!isRecord(raw) || typeof raw.installed !== "boolean" || typeof raw.running !== "boolean" || typeof raw.extension_allowed !== "boolean") throw helperError("helper_failed", "The WebAgents helper's Ollama report is malformed.");
    const optional = (value: unknown, limit: number) => (value === null || value === undefined ? null : text(value, limit));
    return {
      helper: text(reply.helper, 32),
      ollama: { installed: raw.installed, version: optional(raw.version, 64), running: raw.running, server_version: optional(raw.server_version, 64), origins: optional(raw.origins, 1024), extension_allowed: raw.extension_allowed },
    };
  }

  async wrap(masterKey: Uint8Array): Promise<string> {
    if (masterKey.length !== KEY_BYTES) throw new CoreError("invalid_request", "The store key is not 32 bytes.", { status: 400 });
    const reply = await this.call("keychain.wrap", { key: base64Encode(masterKey) }, ["blob"]);
    const blob = text(reply.blob, 128);
    if (blob === null || base64Length(blob) !== HELPER_BLOB_BYTES) throw helperError("helper_failed", "The WebAgents helper returned a blob of the wrong size.");
    return blob;
  }

  async unwrap(blob: string): Promise<Uint8Array> {
    const reply = await this.call("keychain.unwrap", { blob }, ["key"]);
    const key = text(reply.key, 64);
    if (key === null || base64Length(key) !== KEY_BYTES) throw helperError("helper_failed", "The WebAgents helper returned a key of the wrong size.");
    return base64Decode(key);
  }
}

/** The helper refusals after which a stored record can never unlock again (the item is gone or replaced). */
export const PERMANENT_HELPER_CODES: readonly string[] = ["keychain_item_missing", "unwrap_failed"];

/** Read the stored record strictly; anything else is treated as no record. */
export function readKeychainRecord(raw: unknown): KeychainRecord | null {
  if (!isRecord(raw) || raw.schema !== KEYCHAIN_RECORD_SCHEMA) return null;
  const keys = Object.keys(raw).sort().join(",");
  if (keys !== "blob,check,enabled_at,envelope_created_at,schema") return null;
  const enabledAt = text(raw.enabled_at, 64);
  const createdAt = text(raw.envelope_created_at, 64);
  const blob = text(raw.blob, 128);
  const check = raw.check;
  if (enabledAt === null || createdAt === null || blob === null || base64Length(blob) !== HELPER_BLOB_BYTES) return null;
  if (!isRecord(check) || typeof check.iv !== "string" || typeof check.ciphertext !== "string" || base64Length(check.iv) !== 12 || base64Length(check.ciphertext) !== 16) return null;
  return { schema: KEYCHAIN_RECORD_SCHEMA, enabled_at: enabledAt, envelope_created_at: createdAt, blob, check: { iv: check.iv, ciphertext: check.ciphertext } };
}
