#!/usr/bin/env node
/**
 * Check the packed extension (T7): `dist/chrome-agent-browser-<version>.zip` holds exactly the
 * expected files and nothing else (no source, map, test or dependency tree), its manifest
 * version is the package version, every member matches the content listing `npm run pack`
 * wrote beside it, and its notices name every third-party package the build bundled
 * (`dist/BUILD.json`). Prints one JSON line; exits 1 on any problem.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { inflateRawSync } from "node:zlib";
import { extensionIdFromKey } from "./lib/extension-id.mjs";

const project = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const version = JSON.parse(readFileSync(join(project, "package.json"), "utf8")).version;
const zipPath = join(project, "dist", `chrome-agent-browser-${version}.zip`);
const zip = readFileSync(zipPath);
const problems = [];

const EXPECTED = [
  "LICENSE.txt",
  "THIRD_PARTY_NOTICES.txt",
  "browser.html",
  "browser.js",
  "content-script.js",
  "execution-page.js",
  "execution-worker.js",
  "execution.html",
  "icons/icon-128.png",
  "icons/icon-16.png",
  "icons/icon-32.png",
  "icons/icon-48.png",
  "manifest.json",
  "pdf-worker.js",
  "service-worker.js",
  "sidepanel.html",
  "sidepanel.js",
  "styles.css",
];

// The central directory, then each member's bytes through its local header.
const eocd = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
const count = zip.readUInt16LE(eocd + 10);
let at = zip.readUInt32LE(eocd + 16);
const members = new Map();
for (let index = 0; index < count; index += 1) {
  const method = zip.readUInt16LE(at + 10);
  const compressed = zip.readUInt32LE(at + 20);
  const nameLength = zip.readUInt16LE(at + 28);
  const extra = zip.readUInt16LE(at + 30);
  const comment = zip.readUInt16LE(at + 32);
  const local = zip.readUInt32LE(at + 42);
  const name = zip.subarray(at + 46, at + 46 + nameLength).toString("utf8");
  const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
  const raw = zip.subarray(start, start + compressed);
  members.set(name, method === 8 ? inflateRawSync(raw) : Buffer.from(raw));
  at += 46 + nameLength + extra + comment;
}

const names = [...members.keys()];
const missing = EXPECTED.filter((name) => !members.has(name));
const unexpected = names.filter((name) => !EXPECTED.includes(name));
if (missing.length) problems.push(`missing: ${missing.join(", ")}`);
if (unexpected.length) problems.push(`unexpected: ${unexpected.join(", ")}`);
if (names.some((name) => /\.(ts|map)$|node_modules|(^|\/)\./u.test(name))) problems.push("source, map, dependency or hidden file in the zip");

const manifest = JSON.parse(members.get("manifest.json")?.toString("utf8") ?? "{}");
if (manifest.version !== version) problems.push(`manifest version ${manifest.version} != package version ${version}`);
if (manifest.manifest_version !== 3) problems.push("not a Manifest V3 extension");

// Least privilege (T16, D-182, D-190, D-194): the loopback names are the only host permissions,
// every HTTPS origin is optional, no static content script, the permission list exactly as decided.
const LOOPBACK_HOSTS = ["http://127.0.0.1/*", "http://localhost/*"];
const PERMISSIONS = ["activeTab", "alarms", "contextMenus", "offscreen", "scripting", "sidePanel", "storage", "unlimitedStorage"];
const hosts = [...(manifest.host_permissions ?? [])].sort();
if (JSON.stringify(hosts) !== JSON.stringify(LOOPBACK_HOSTS)) problems.push(`host_permissions must be exactly the loopback names, found ${JSON.stringify(hosts)}`);
if (JSON.stringify(manifest.optional_host_permissions ?? []) !== JSON.stringify(["https://*/*"])) problems.push("optional_host_permissions must be exactly https://*/*");
if (manifest.content_scripts !== undefined) problems.push("a static content script is declared (D-194: the discovery script is injected or registered on grant)");
if (JSON.stringify([...(manifest.permissions ?? [])].sort()) !== JSON.stringify(PERMISSIONS)) problems.push(`permissions must be exactly ${PERMISSIONS.join(", ")}, found ${(manifest.permissions ?? []).join(", ")}`);
if (manifest.permissions?.includes("tabs") || manifest.permissions?.includes("declarativeContent")) problems.push("tabs and declarativeContent are not requested (D-190)");
// The native helper is optional (D-181, D-204): its permission is requested from Settings only.
if (JSON.stringify(manifest.optional_permissions ?? []) !== JSON.stringify(["nativeMessaging"])) problems.push("optional_permissions must be exactly nativeMessaging");
// D-200: the store zip carries no `key`; the unpacked build's key gives an id the helper's installer lists.
if (manifest.key !== undefined) problems.push("the zip's manifest carries a key (the Web Store assigns the id)");
const unpacked = JSON.parse(readFileSync(join(project, "dist", "extension", "manifest.json"), "utf8"));
const allowedIds = JSON.parse(readFileSync(join(project, "..", "installer", "macos", "extension-ids.json"), "utf8")).extension_ids ?? [];
if (typeof unpacked.key !== "string") problems.push("the unpacked build's manifest has no key (D-200)");
else if (!allowedIds.includes(extensionIdFromKey(unpacked.key))) problems.push(`the unpacked build's id ${extensionIdFromKey(unpacked.key)} is not in installer/macos/extension-ids.json`);

// The Web Store's remote-code rule: every script is in the zip; nothing is loaded from the network or evaluated from text.
for (const name of names.filter((member) => member.endsWith(".js") || member.endsWith(".html"))) {
  const text = members.get(name).toString("utf8");
  const remote = /(?:<script[^>]+src\s*=\s*["']|importScripts\s*\(\s*["']|import\s*\(\s*["']|from\s+["'])https?:\/\//iu.exec(text);
  if (remote) problems.push(`${name} references a remote script: ${remote[0].slice(0, 60)}`);
  // pdf.js's bundled global-object shim ends in `Function("return this")()`, reached only where
  // neither globalThis nor self exists (never in Chrome) and refused by the CSP anyway; nothing
  // else may evaluate text as code.
  const scanned = text.replace(/\bnew Function[A-Za-z]/gu, "").replace(/Function\("return this"\)\(\)/gu, "");
  const evaluated = /(?:^|[^\w$.])(?:eval|Function)\s*\(/u.exec(scanned);
  if (evaluated) problems.push(`${name} evaluates code from text: ${evaluated[0].trim()}`);
}
const csp = String(manifest.content_security_policy?.extension_pages ?? "");
if (!/script-src 'self'/u.test(csp) || /unsafe-eval|unsafe-inline/u.test(csp)) problems.push(`the extension pages' CSP must allow the extension's own scripts only, found ${JSON.stringify(csp)}`);

const sha256 = (data) => createHash("sha256").update(data).digest("hex");
const listing = readFileSync(zipPath.replace(/\.zip$/u, ".contents.txt"), "utf8").trim().split("\n").map((line) => line.split(/\s+/u));
const archiveLine = listing.pop();
if (archiveLine?.[0] !== sha256(zip)) problems.push("the zip's SHA-256 is not the listing's");
for (const [hash, bytes, name] of listing) {
  const data = members.get(name);
  if (!data || sha256(data) !== hash || data.length !== Number(bytes)) problems.push(`listing mismatch: ${name}`);
}
if (listing.length !== members.size) problems.push(`listing has ${listing.length} members, the zip ${members.size}`);

const notices = members.get("THIRD_PARTY_NOTICES.txt")?.toString("utf8") ?? "";
const bundled = JSON.parse(readFileSync(join(project, "dist", "BUILD.json"), "utf8")).bundled_packages ?? [];
if (bundled.length === 0) problems.push("BUILD.json names no bundled package");
for (const item of bundled) if (!notices.includes(`${item.name} ${item.version} (${item.license})`)) problems.push(`notices omit ${item.name} ${item.version}`);
if (!notices.includes("PYTHON SOFTWARE FOUNDATION LICENSE VERSION 2")) problems.push("notices omit the PSF license");
if (!members.get("LICENSE.txt")?.toString("utf8").includes("Apache License")) problems.push("LICENSE.txt is not the Apache License");

console.log(JSON.stringify({ zip: zipPath, version, files: members.size, zip_sha256: sha256(zip), bundled_packages: bundled.length, passed: problems.length === 0, problems }));
process.exit(problems.length === 0 ? 0 : 1);
