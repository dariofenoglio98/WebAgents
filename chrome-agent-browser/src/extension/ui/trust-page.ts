/**
 * The Trust page: the keys this device trusts, their scope, and pin/unpin. Unpinning arms on
 * the first press and acts on the second. Pinning a pasted PEM is for keys obtained out of
 * band; the usual path is the agent page's "Trust this publisher key", which uses the key the
 * package under review was signed with.
 */
import type { TrustEntry, TrustState } from "../../core/trust.js";
import { button, card, chip, definition, el, list, shortHash, whenText } from "./dom.js";

export interface TrustPageActions {
  onUnpin: (fingerprint: string) => void;
  onPinKey: (input: { publicKeyPem: string; displayName: string; publisherId: string | null; packageIdPrefix: string | null }) => void;
}

function entryRow(entry: TrustEntry, actions: TrustPageActions): HTMLElement {
  let armed = false;
  const unpin = button("Remove", () => {
    if (!armed) {
      armed = true;
      unpin.textContent = "Press again to remove";
      unpin.className = "ab-button ab-button-danger";
      return;
    }
    actions.onUnpin(entry.fingerprint);
  });
  return el(
    "div",
    { className: "ab-trust-entry", attrs: { "data-fingerprint": entry.fingerprint } },
    el("div", { className: "ab-trust-entry-head" }, el("strong", { text: entry.display_name || "(unnamed)" }), chip(entry.package_id_prefix ? "one package id" : entry.publisher_id ? "whole publisher" : "any package", entry.package_id_prefix ? "good" : "warn")),
    definition([
      ["Fingerprint", el("code", { text: shortHash(entry.fingerprint, 24) })],
      ["Publisher id", entry.publisher_id ?? "any"],
      ["Package id prefix", entry.package_id_prefix ?? "any"],
      ["Added", whenText(entry.added_at)],
      ["Notes", entry.notes ?? ""],
    ]),
    unpin,
  );
}

export function renderTrustPage(entries: TrustEntry[], state: TrustState, actions: TrustPageActions): HTMLElement {
  const pem = el("textarea", { className: "ab-textarea", attrs: { name: "public-key-pem", rows: "4", placeholder: "-----BEGIN PUBLIC KEY-----" } });
  const name = el("input", { className: "ab-input", attrs: { name: "display-name", placeholder: "Display name" } });
  const publisher = el("input", { className: "ab-input", attrs: { name: "publisher-id", placeholder: "Publisher id (optional)" } });
  const prefix = el("input", { className: "ab-input", attrs: { name: "package-id-prefix", placeholder: "Package id prefix (optional, narrows the pin)" } });
  const pin = button(
    "Pin this key",
    () =>
      actions.onPinKey({
        publicKeyPem: pem.value,
        displayName: name.value,
        publisherId: publisher.value.trim() || null,
        packageIdPrefix: prefix.value.trim() || null,
      }),
    { variant: "primary" },
  );
  return el(
    "div",
    { className: "ab-trust-page" },
    card(
      "Publisher keys you trust",
      el("p", { className: "ab-hint", text: "A signature proves which key signed a package. Trust is your decision about that key, on this device, and it grants no permission by itself." }),
      entries.length === 0 ? el("p", { className: "ab-empty", text: "No key is trusted yet. Open an agent and choose “Trust this publisher key” to pin the key that signed it." }) : list(entries.map((entry) => entryRow(entry, actions)), "ab-trust-list"),
      el("p", { className: "ab-hint", text: `${state.entry_count} key${state.entry_count === 1 ? "" : "s"} · state ${shortHash(state.state_sha256)}` }),
    ),
    card(
      "Pin a key you obtained out of band",
      el("p", { className: "ab-hint", text: "Paste an Ed25519 public key in PEM form. Private keys are refused." }),
      el("label", { className: "ab-field" }, pem),
      el("label", { className: "ab-field" }, name),
      el("label", { className: "ab-field" }, publisher),
      el("label", { className: "ab-field" }, prefix),
      pin,
    ),
  );
}
