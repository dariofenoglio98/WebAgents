/**
 * The extension id Chrome derives from a manifest `key` (D-200): the first 16 bytes of the
 * SHA-256 of the DER public key, each hex digit mapped 0–f → a–p.
 */
import { createHash } from "node:crypto";

export function extensionIdFromKey(key) {
  const digest = createHash("sha256").update(Buffer.from(key, "base64")).digest("hex").slice(0, 32);
  return [...digest].map((digit) => String.fromCharCode(97 + Number.parseInt(digit, 16))).join("");
}
