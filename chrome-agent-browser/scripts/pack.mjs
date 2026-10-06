#!/usr/bin/env node
/**
 * Zip the built extension for distribution or Chrome Web Store upload:
 * dist/chrome-agent-browser-<version>.zip, with the manifest at the archive root.
 * Requires `npm run build` first and the system `zip` command.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const project = resolve(here, "..");
const extension = join(project, "dist", "extension");
if (!existsSync(join(extension, "manifest.json"))) {
  console.error("dist/extension/manifest.json is missing; run `npm run build` first");
  process.exit(1);
}
const manifest = JSON.parse(readFileSync(join(extension, "manifest.json"), "utf8"));
const target = join(project, "dist", `chrome-agent-browser-${manifest.version}.zip`);
rmSync(target, { force: true });
execFileSync("zip", ["-q", "-r", "-X", target, "."], { cwd: extension, stdio: "inherit" });
console.log(JSON.stringify({ zip: target, version: manifest.version }));
