/**
 * The native port in Chrome (T17, D-204): `chrome.runtime.sendNativeMessage` to the helper the
 * macOS installer registers, one request and one reply, under the optional `nativeMessaging`
 * permission the person grants in Settings → Security. Chrome's refusals arrive as error messages;
 * they are read here into the few failures the core explains. A call never waits longer than
 * `HELPER_TIMEOUT_MS` (an unwrap may first show the keychain's own prompt).
 */
import { HELPER_TIMEOUT_MS, NATIVE_HOST, NativePortError, type NativeFailure, type NativePort } from "../../core/keychain.js";

const NATIVE_PERMISSION: chrome.permissions.Permissions = { permissions: ["nativeMessaging"] };

/** Whether the person granted `nativeMessaging` (Settings → Security asks in the toggle's click). */
export async function nativePermissionGranted(): Promise<boolean> {
  try {
    return await chrome.permissions.contains(NATIVE_PERMISSION);
  } catch {
    return false;
  }
}

/** Chrome's error text, read into a failure (`extensions/browser/api/messaging/native_message_host` wording). */
export function nativeFailure(message: string): NativeFailure {
  if (/not found/iu.test(message)) return "not_installed";
  if (/forbidden/iu.test(message)) return "forbidden";
  if (/exited|communicating/iu.test(message)) return "exited";
  return "other";
}

export const chromeNativePort: NativePort = {
  async send(message) {
    if (!(await nativePermissionGranted()) || typeof chrome.runtime.sendNativeMessage !== "function") throw new NativePortError("no_permission", "nativeMessaging is not granted");
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new NativePortError("timeout", `no reply within ${HELPER_TIMEOUT_MS / 1000} s`)), HELPER_TIMEOUT_MS);
    });
    try {
      return await Promise.race([chrome.runtime.sendNativeMessage(NATIVE_HOST, message), timeout]);
    } catch (error) {
      if (error instanceof NativePortError) throw error;
      const text = error instanceof Error ? error.message : String(error);
      throw new NativePortError(nativeFailure(text), text.slice(0, 200));
    } finally {
      clearTimeout(timer);
    }
  },
};
