/**
 * The lock surface (T16, D-191, D-192), shared by the side panel and the full page: a chip that
 * says whether the keys and records are unlocked (with Lock now), and the Unlock sheet, a modal
 * card with one passphrase field, opened when a request fails `store_locked` and closed by a
 * successful unlock, which then retries what the person was doing. Before any passphrase exists
 * the sheet explains and links to Settings → Security instead. The passphrase leaves this page
 * once, to the service worker, and is never kept. With keychain unlock on (T17, D-204) the sheet
 * offers "Unlock with the macOS keychain" first; any failure leaves the passphrase form in place.
 */
import type { SecretStoreState } from "../../core/secrets.js";
import type { SecretsView } from "../messages.js";
import { describeError, send } from "./client.js";
import { button, chip, el } from "./dom.js";

export interface UnlockState {
  /** The sheet is open; `retry` runs after a successful unlock. */
  open: { reason: string | null; retry: (() => void) | null } | null;
  busy: boolean;
  error: string | null;
}

export function newUnlockState(): UnlockState {
  return { open: null, busy: false, error: null };
}

/** Whether a failed request is the store asking to be unlocked (or set up). */
export function needsUnlock(error: { code: string }): boolean {
  return error.code === "store_locked" || error.code === "store_no_passphrase";
}

export function idleWords(minutes: number | null): string {
  return minutes === null ? "until the browser closes" : `locks after ${minutes} min idle`;
}

/** The chip for the nav and the panel head: the state in two words, and Lock now while unlocked. */
export function renderLockChip(secrets: SecretsView | null, actions: { onLock: () => void; onOpen: () => void; openSettings: () => void }): HTMLElement {
  const state: SecretStoreState | null = secrets?.state ?? null;
  const node = el("div", { className: "ab-lock", attrs: { "data-lock": state ?? "unknown" } });
  if (state === null) return node;
  if (state === "no_passphrase") {
    node.append(chip("No passphrase", "warn"), button("Set one", actions.openSettings, { variant: "ghost" }));
    node.title = "Set a passphrase to protect your keys and records at rest (Settings → Security).";
    return node;
  }
  if (state === "invalid") {
    node.append(chip("Store unreadable", "bad"), button("See why", actions.openSettings, { variant: "ghost" }));
    node.title = "The protected store cannot be read by this build (Settings → Security says why and offers to forget it).";
    return node;
  }
  if (state === "locked") {
    node.append(chip("Locked", "neutral"), button("Unlock", actions.onOpen, { variant: "ghost" }));
    node.title = "Your keys and records are locked. Unlock them to run agents that need them.";
    return node;
  }
  node.append(chip("Unlocked", "good"), el("span", { className: "ab-hint ab-lock-idle", text: idleWords(secrets?.idle_minutes ?? null) }), button("Lock now", actions.onLock, { variant: "ghost" }));
  return node;
}

/** The Unlock sheet, or nothing when it is closed. `rerender` repaints the surface after a state change. */
export function renderUnlockSheet(state: UnlockState, secrets: SecretsView | null, actions: { rerender: () => void; openSettings: () => void; onUnlocked: () => void }): HTMLElement | null {
  if (!state.open) return null;
  const close = () => {
    state.open = null;
    state.error = null;
    state.busy = false;
    actions.rerender();
  };
  const sheet = el("div", { className: "ab-sheet", attrs: { role: "dialog", "aria-modal": "true", "aria-label": "Unlock your keys and records" } });
  const backdrop = el("div", { className: "ab-sheet-backdrop" });
  backdrop.addEventListener("click", close);
  if (secrets?.state === "invalid") {
    // An envelope this build cannot read (T16 review 2, nit 5): a passphrase cannot help; Settings says why.
    sheet.append(
      backdrop,
      el(
        "div",
        { className: "ab-sheet-card" },
        el("h3", { text: "Your keys and records cannot be read" }),
        el("p", { className: "ab-hint", text: secrets.problem ?? "The protected store is not one this version reads." }),
        el("p", { className: "ab-hint", text: "No passphrase opens it. Settings → Security explains what happened and how to start again." }),
        el("div", { className: "ab-actions" }, button("Open Settings → Security", () => {
          close();
          actions.openSettings();
        }, { variant: "primary" }), button("Not now", close, { variant: "ghost" })),
      ),
    );
    return sheet;
  }
  if (secrets?.state === "no_passphrase") {
    sheet.append(
      backdrop,
      el(
        "div",
        { className: "ab-sheet-card" },
        el("h3", { text: "Set a passphrase first" }),
        el("p", { className: "ab-hint", text: state.open.reason ?? "This needs your provider key or your records, which are kept only in the protected store. Set a passphrase under Settings → Security; it protects them at rest and unlocks them for this browser session." }),
        el("div", { className: "ab-actions" }, button("Open Settings → Security", () => {
          close();
          actions.openSettings();
        }, { variant: "primary" }), button("Not now", close, { variant: "ghost" })),
      ),
    );
    return sheet;
  }
  const field = el("input", { className: "ab-input", attrs: { type: "password", name: "passphrase", autocomplete: "current-password", placeholder: "Your passphrase", "aria-label": "Passphrase" } });
  const submit = async () => {
    if (state.busy) return;
    const passphrase = field.value;
    field.value = "";
    if (!passphrase) return;
    state.busy = true;
    state.error = null;
    actions.rerender();
    try {
      await send<SecretsView>({ type: "secrets.unlock", passphrase });
      const retry = state.open?.retry ?? null;
      state.open = null;
      state.busy = false;
      actions.onUnlocked();
      actions.rerender();
      retry?.();
    } catch (error) {
      const described = describeError(error);
      state.error = described.code === "passphrase_wrong" ? "That passphrase does not open the store." : `${described.code}: ${described.message}`;
      state.busy = false;
      actions.rerender();
    }
  };
  const viaKeychain = async () => {
    if (state.busy) return;
    state.busy = true;
    state.error = null;
    actions.rerender();
    try {
      await send<SecretsView>({ type: "secrets.unlockKeychain" });
      const retry = state.open?.retry ?? null;
      state.open = null;
      state.busy = false;
      actions.onUnlocked();
      actions.rerender();
      retry?.();
    } catch (error) {
      state.error = `${keychainFailureWords(describeError(error))} Use your passphrase instead.`;
      state.busy = false;
      actions.rerender();
    }
  };
  const form = el("form", { className: "ab-sheet-form" }, field);
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    void submit();
  });
  sheet.append(
    backdrop,
    el(
      "div",
      { className: "ab-sheet-card" },
      el("h3", { text: "Unlock your keys and records" }),
      el("p", { className: "ab-hint", text: state.open.reason ?? "Your provider keys and your records are encrypted at rest. Enter your passphrase to use them in this browser session; they lock again after the idle time you chose." }),
      secrets?.keychain_enabled ? el("div", { className: "ab-actions ab-keychain-unlock" }, button(state.busy ? "Unlocking…" : "Unlock with the macOS keychain", () => void viaKeychain(), { variant: "primary", disabled: state.busy })) : null,
      secrets?.keychain_enabled ? el("p", { className: "ab-hint", text: "Or enter your passphrase:" }) : null,
      form,
      state.error ? el("p", { className: "ab-banner ab-banner-bad", attrs: { role: "alert" }, text: state.error }) : null,
      el("div", { className: "ab-actions" }, button(state.busy ? "Unlocking…" : "Unlock", () => void submit(), { variant: secrets?.keychain_enabled ? "ghost" : "primary", disabled: state.busy }), button("Cancel", close, { variant: "ghost", disabled: state.busy })),
    ),
  );
  if (!secrets?.keychain_enabled) queueMicrotask(() => field.focus());
  return sheet;
}

/** A failed keychain unlock in words (T17): what happened, never a dead end. */
export function keychainFailureWords(error: { code: string; message: string; details?: Record<string, unknown> }): string {
  switch (error.code) {
    case "helper_not_installed":
      return "The WebAgents helper is not installed on this Mac.";
    case "native_permission_missing":
      return "Chrome no longer lets this extension talk to the WebAgents helper (Settings → Security turns it on again).";
    case "helper_timeout":
      return "The WebAgents helper did not answer in time.";
    case "keychain_mismatch":
    case "keychain_not_enabled":
      return "The keychain does not hold the key for this store any more; keychain unlock was turned off.";
    case "helper_refused": {
      const code = typeof error.details?.helper_code === "string" ? error.details.helper_code : "";
      if (code === "keychain_item_missing" || code === "unwrap_failed") return "The keychain does not hold the key for this store any more; keychain unlock was turned off.";
      if (code === "keychain_unavailable") return "The keychain refused (was its prompt denied?).";
      return `The WebAgents helper refused: ${error.message}`;
    }
    default:
      return `${error.code}: ${error.message}`;
  }
}
