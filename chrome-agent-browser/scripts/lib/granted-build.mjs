/**
 * A pre-granted copy of the built extension for the headless harnesses (T16, D-196).
 *
 * Headless Chrome can grant nothing: `chrome.permissions.request` shows a prompt nobody answers,
 * and no action click or keyboard command reaches an extension over CDP (the recorded experiment,
 * `examples/verification/chrome-declarative-content-experiment.json`). A person's grant of an
 * origin is, in Chrome, exactly a host permission for that origin; so a harness copies
 * `dist/extension` into its run directory and adds the origins it will drive to
 * `host_permissions`, which is the state the extension is in after the person pressed Allow.
 * Nothing else in the copy differs from the build: the bytes of every script are the shipped ones,
 * and `e2e-discovery.mjs` loads the unmodified build first to assert the refusal and the manifest.
 */
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** The site grants a harness stands in for (`https://host/*`), recorded in the copy's manifest. */
export function grantedBuild(extensionDirectory, runDirectory, origins) {
  const target = join(runDirectory, "extension-granted");
  mkdirSync(target, { recursive: true });
  cpSync(extensionDirectory, target, { recursive: true });
  const manifestPath = join(target, "manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const patterns = [...new Set(origins.map((origin) => (origin.endsWith("/*") ? origin : `${origin.replace(/\/+$/u, "")}/*`)))];
  manifest.host_permissions = [...(manifest.host_permissions ?? []), ...patterns];
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return { path: target, granted: patterns };
}
