// @vitest-environment happy-dom
/**
 * Keychain unlock as the person sees it (T17), on the full page over a fake `chrome.runtime`
 * routed to the controller and a fake helper behind the native port: Settings → Security says
 * "keychain available" and turns it on (asking Chrome for `nativeMessaging` in the click); the
 * Unlock sheet then offers the macOS keychain first; with the helper removed it says so and the
 * passphrase form unlocks as before. The sheet for an unreadable store has no passphrase field.
 */
import { describe, expect, it, vi } from "vitest";

import type { Event, SecretsView } from "../../src/extension/messages.js";
import { failure, success } from "../../src/extension/messages.js";
import { ollamaWords } from "../../src/extension/ui/settings-page.js";
import { newUnlockState, renderUnlockSheet } from "../../src/extension/ui/unlock.js";
import { FakeHelper } from "../helpers/fake-helper.js";
import { makeHarness, PAGE_IN_TAB, SEED_PASSPHRASE } from "../helpers/shell.js";

type Listener = (message: unknown) => void;
const listeners: Listener[] = [];
const helper = new FakeHelper();
const h = makeHarness({
  native: helper,
  onEvent: (event: Event) => {
    for (const listener of listeners) listener(event);
  },
});
const permissionRequests: unknown[] = [];

document.body.innerHTML = `<nav class="ab-nav"><a href="#open" data-view="open">Open</a></nav><div id="lock"></div><main id="app"></main>`;
vi.stubGlobal("chrome", {
  runtime: {
    sendMessage: async (message: unknown) => {
      try {
        return success(await h.controller.handle(message as Parameters<typeof h.controller.handle>[0], PAGE_IN_TAB));
      } catch (error) {
        return failure(error);
      }
    },
    onMessage: {
      addListener: (listener: Listener) => {
        listeners.push(listener);
      },
      removeListener: (listener: Listener) => {
        listeners.splice(listeners.indexOf(listener), 1);
      },
    },
  },
  // Chrome's optional permission: the page asks in the click; the person says yes.
  permissions: {
    contains: async () => h.native.permission,
    request: async (request: unknown) => {
      permissionRequests.push(request);
      h.native.permission = true;
      return true;
    },
  },
});
await import("../../src/extension/browser/browser.js");

const app = () => document.getElementById("app")!;
const settle = (ms = 150) => new Promise((resolve) => setTimeout(resolve, ms));
async function go(hash: string): Promise<void> {
  location.hash = hash;
  window.dispatchEvent(new Event("hashchange"));
  await settle();
  await settle();
}
const buttonNamed = (name: string) => [...document.querySelectorAll<HTMLButtonElement>("button")].find((node) => node.textContent === name);

describe("Settings → Security and the Unlock sheet with the helper (T17)", () => {
  it("turns keychain unlock on from Settings, then unlocks with one click; a removed helper falls back to the passphrase", async () => {
    await h.controller.handle({ type: "settings.setKey", provider: "openai", key: "sk-ui-key" }, PAGE_IN_TAB);
    await go("#settings?section=security");
    await settle();
    expect(app().textContent).toContain("Unlock with the macOS keychain");
    expect(app().textContent).toContain("Off"); // no permission yet: the helper was not asked
    expect(helper.sent).toHaveLength(0);

    buttonNamed("Turn on")!.click();
    await settle();
    await settle();
    expect(permissionRequests).toEqual([{ permissions: ["nativeMessaging"] }]);
    expect(app().querySelector(".ab-card")?.parentElement?.textContent).toContain("keychain available");
    expect(app().textContent).toContain("Ollama 0.40.3 is running and admits this extension.");
    expect(app().textContent).toContain("Keychain unlock is on");

    // Locked: the sheet offers the keychain first.
    await h.controller.handle({ type: "secrets.lock" }, PAGE_IN_TAB);
    await settle();
    buttonNamed("Unlock")!.click();
    await settle();
    expect(document.querySelector(".ab-sheet")).not.toBeNull();
    expect(document.activeElement?.textContent).toBe("Unlock with the macOS keychain"); // the sheet takes the focus (T17 review 2, nit 3)
    buttonNamed("Unlock with the macOS keychain")!.click();
    await settle();
    await settle();
    expect(document.querySelector(".ab-sheet")).toBeNull();
    expect(((await h.controller.handle({ type: "secrets.status" }, PAGE_IN_TAB)) as SecretsView).state).toBe("unlocked");

    // The helper is removed: the sheet says so and the passphrase still opens the store.
    helper.portFailure = "not_installed";
    await h.controller.handle({ type: "secrets.lock" }, PAGE_IN_TAB);
    await settle();
    buttonNamed("Unlock")!.click();
    await settle();
    buttonNamed("Unlock with the macOS keychain")!.click();
    await settle();
    expect(document.querySelector(".ab-sheet [role=alert]")?.textContent).toBe("The WebAgents helper is not installed on this Mac. Use your passphrase instead.");
    const field = document.querySelector<HTMLInputElement>(".ab-sheet input[type=password]")!;
    expect(document.activeElement).toBe(field); // after a keychain failure the focus is on the passphrase the words point to (T19 review 2, nit 4)
    field.value = SEED_PASSPHRASE;
    field.form!.dispatchEvent(new Event("submit", { cancelable: true }));
    await settle();
    await settle();
    expect(document.querySelector(".ab-sheet")).toBeNull();
    expect(await h.settings.key("openai")).toBe("sk-ui-key");

    // Settings now names the missing helper.
    buttonNamed("Check again")!.click();
    await settle();
    expect(app().textContent).toContain("Helper not installed");

    // A helper installed for another extension id: its own words, with what to do (T17 review 2, nit 1).
    helper.portFailure = "forbidden";
    buttonNamed("Check again")!.click();
    await settle();
    expect(app().textContent).toContain("Helper not for this extension");
    expect(app().textContent).toContain("reinstall it with the current installer");
    expect(app().textContent).not.toContain("Helper not installed");
    helper.portFailure = "not_installed";
  });

  it("a status request the worker rejects leaves a failed card with Check again, not \"Asking the helper…\" (T17 review 1, nit 5)", async () => {
    helper.portFailure = null;
    const spy = vi.spyOn(h.controller, "keychainView").mockRejectedValueOnce(new Error("the worker went away"));
    buttonNamed("Check again")!.click();
    await settle();
    await settle();
    expect(app().textContent).not.toContain("Asking the helper…");
    expect(app().textContent).toContain("Helper failed");
    expect(app().textContent).toContain("internal_error: The operation failed");
    expect(buttonNamed("Turn off")).toBeDefined(); // what was known before stays: keychain unlock is on
    spy.mockRestore();
    buttonNamed("Check again")!.click();
    await settle();
    await settle();
    expect(app().textContent).toContain("keychain available");
  });

  it("the Ollama line follows the server's answer, not the login value (T17 review 1, nit 6)", () => {
    const admitted = { ...helper.ollama, origins: "chrome-extension://abcdefghijklmnopabcdefghijklmnop" };
    expect(ollamaWords(admitted)).toEqual({ text: "Ollama 0.40.3 is running and admits this extension.", tone: "good" });
    const stale = ollamaWords({ ...admitted, extension_allowed: false });
    expect(stale.tone).toBe("bad");
    expect(stale.text).toContain("is running but does not admit this extension (OLLAMA_ORIGINS at login: chrome-extension://abcdefghijklmnopabcdefghijklmnop); restart Ollama");
  });

  it("the sheet for an unreadable store explains instead of asking for a passphrase (T16 review 2, nit 5)", () => {
    const state = newUnlockState();
    state.open = { reason: null, retry: null };
    const secrets = { state: "invalid", problem: "secret_store.kdf.salt must be 16 bytes in base64", unlocked_at: null, last_used_at: null, idle_minutes: 15, entries: [], created_at: null, migration_pending: false, legacy: null, keychain_enabled: false } as SecretsView;
    const sheet = renderUnlockSheet(state, secrets, { rerender: () => undefined, openSettings: () => undefined, onUnlocked: () => undefined })!;
    expect(sheet.querySelector("input")).toBeNull();
    expect(sheet.textContent).toContain("secret_store.kdf.salt must be 16 bytes in base64");
    expect(sheet.textContent).toContain("Open Settings → Security");
  });
});
