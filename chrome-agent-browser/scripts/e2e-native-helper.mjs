#!/usr/bin/env node
/**
 * The native helper through real Chrome (T17, D-204): headless Google Chrome loads a copy of the
 * built extension with `nativeMessaging` pre-granted (the person's Turn on, as D-196 pre-grants
 * origins), finds the built helper through a native-messaging host manifest in the profile
 * (`<user-data-dir>/NativeMessagingHosts/`), and the extension's own worker asks it:
 *   1. the extension's id is the one `installer/macos/extension-ids.json` lists (D-200);
 *   2. `keychain.status` from an extension page → helper `available` with Ollama's report: Chrome
 *      started the helper and its parent check accepted Chrome's signature;
 *   3. an operation outside the closed list, sent on the real port, is refused `unknown_operation`;
 *   4. Chrome's own refusals read as the core expects: the host manifest removed → "not found" →
 *      `not_installed`; a manifest that does not list the extension → "forbidden" → `not_installed`.
 * With `--keychain` (writes an item into your login keychain, deleted at the end): set a
 * passphrase, Turn on, Lock, Unlock with the keychain, and check the store is unlocked.
 * Usage: node scripts/e2e-native-helper.mjs [--helper PATH] [--chrome PATH] [--keychain] [--out FILE]
 */
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { Cdp, sleep } from "./lib/cdp.mjs";

const PROJECT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ROOT = resolve(PROJECT, "..");
const EXTENSION = join(PROJECT, "dist", "extension");
const HOST = "org.webagents.helper";
const args = { chrome: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", helper: join(ROOT, "native-helper", "dist", "webagents-helper"), keychain: false, out: null };
for (let index = 2; index < process.argv.length; index += 1) {
  const argument = process.argv[index];
  if (argument === "--chrome") args.chrome = process.argv[(index += 1)];
  else if (argument === "--helper") args.helper = resolve(process.argv[(index += 1)]);
  else if (argument === "--keychain") args.keychain = true;
  else if (argument === "--out") args.out = resolve(process.argv[(index += 1)]);
  else {
    console.error(`unknown argument ${argument}`);
    process.exit(2);
  }
}
for (const [what, path, hint] of [["the built extension", join(EXTENSION, "manifest.json"), "npm run build"], ["the helper", args.helper, "native-helper/scripts/build.sh"], ["Chrome", args.chrome, "--chrome PATH"]]) {
  if (!existsSync(path)) {
    console.error(`${what} is missing at ${path} (${hint})`);
    process.exit(2);
  }
}

const ids = JSON.parse(readFileSync(join(ROOT, "installer", "macos", "extension-ids.json"), "utf8")).extension_ids;
const run = mkdtempSync(join(tmpdir(), "webagents-native-e2e-"));
const profile = join(run, "profile");
const hosts = join(profile, "NativeMessagingHosts");
mkdirSync(hosts, { recursive: true });
const helperDir = join(run, "helper");
mkdirSync(helperDir);
copyFileSync(args.helper, join(helperDir, "webagents-helper"));
chmodSync(join(helperDir, "webagents-helper"), 0o755);
writeFileSync(join(helperDir, "extension-ids.json"), JSON.stringify({ extension_ids: ids }));
const manifestPath = join(hosts, `${HOST}.json`);
const writeHostManifest = (origins) => writeFileSync(manifestPath, JSON.stringify({ name: HOST, description: "WebAgents native helper (e2e)", path: join(helperDir, "webagents-helper"), type: "stdio", allowed_origins: origins }));
writeHostManifest(ids.map((id) => `chrome-extension://${id}/`));

// The person's "Turn on", pre-granted (D-196's approach for origins).
const granted = join(run, "extension-granted");
cpSync(EXTENSION, granted, { recursive: true });
const manifest = JSON.parse(readFileSync(join(granted, "manifest.json"), "utf8"));
manifest.permissions = [...manifest.permissions, "nativeMessaging"];
writeFileSync(join(granted, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);

const report = { started_at: new Date().toISOString(), chrome: null, helper: spawnSync(args.helper, ["--version"]).stdout.toString().trim(), extension_id: null, steps: {}, checks: [], keychain: args.keychain };
const check = (step, name, ok, detail) => report.checks.push({ step, name, ok: Boolean(ok), ...(ok ? {} : { detail }) });

const chrome = spawn(args.chrome, ["--headless=new", "--remote-debugging-pipe", "--enable-unsafe-extension-debugging", `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check", "about:blank"], { stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"] });
const cdp = new Cdp(chrome);
try {
  report.chrome = (await cdp.send("Browser.getVersion")).product;
  const { id } = await cdp.send("Extensions.loadUnpacked", { path: granted });
  report.extension_id = id;
  check("id", "the unpacked build's id is the one the installer lists (D-200)", ids.includes(id), { id, ids });
  const base = `chrome-extension://${id}`;
  await cdp.waitForTarget((target) => target.type === "service_worker" && target.url === `${base}/service-worker.js`, "the service worker");
  const { targetId } = await cdp.send("Target.createTarget", { url: `${base}/browser.html#settings?section=security` });
  const page = await cdp.attach(targetId);
  await cdp.waitFor(page, "typeof chrome !== 'undefined' && !!chrome.runtime && document.readyState === 'complete'", "the page");
  const ask = (request) => cdp.evaluate(page, `chrome.runtime.sendMessage(${JSON.stringify(request)})`);
  const direct = (message) => cdp.evaluate(page, `chrome.runtime.sendNativeMessage(${JSON.stringify(HOST)}, ${JSON.stringify(message)}).then((reply) => ({ reply }), (error) => ({ error: String(error && error.message || error) }))`);

  // 2. the worker asks the helper
  const status = await ask({ type: "keychain.status" });
  report.steps.status = status;
  check("status", "keychain.status answers", status?.ok === true, status);
  check("status", "the helper is available (Chrome started it; its parent check accepted Chrome)", status?.result?.helper === "available" && status?.result?.permission === true, status?.result);
  check("status", "the helper reports Ollama", typeof status?.result?.ollama?.installed === "boolean", status?.result?.ollama);

  // 3. the closed list, on the real port
  const unknown = await direct({ op: "keychain.read" });
  report.steps.unknown_operation = unknown;
  check("closed list", "an operation outside the three is refused", unknown.reply?.ok === false && unknown.reply?.error?.code === "unknown_operation", unknown);
  const extra = await direct({ op: "ollama.status", path: "/etc/passwd" });
  check("closed list", "an extra field is refused", extra.reply?.error?.code === "bad_request", extra);

  // 4. Chrome's refusals, as the core reads them
  writeHostManifest(["chrome-extension://bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb/"]);
  const forbidden = await direct({ op: "ollama.status" });
  const forbiddenView = await ask({ type: "keychain.status" });
  report.steps.forbidden = { chrome_says: forbidden, view: forbiddenView?.result };
  check("refusals", "a manifest that does not list the extension: Chrome says forbidden", /forbidden/iu.test(forbidden.error ?? ""), forbidden);
  check("refusals", "…and the card says not installed", forbiddenView?.result?.helper === "not_installed", forbiddenView);
  rmSync(manifestPath);
  const missing = await direct({ op: "ollama.status" });
  const missingView = await ask({ type: "keychain.status" });
  report.steps.not_installed = { chrome_says: missing, view: missingView?.result };
  check("refusals", "no host manifest: Chrome says not found", /not found/iu.test(missing.error ?? ""), missing);
  check("refusals", "…and the card says not installed", missingView?.result?.helper === "not_installed", missingView);
  writeHostManifest(ids.map((item) => `chrome-extension://${item}/`));

  // 5. optional: the keychain round trip through the extension
  if (args.keychain) {
    const setup = await ask({ type: "secrets.setup", passphrase: "e2e native helper passphrase" });
    check("keychain", "a passphrase is set", setup?.result?.state === "unlocked", setup);
    const enabled = await ask({ type: "keychain.enable" });
    check("keychain", "keychain unlock turns on", enabled?.result?.enabled === true, enabled);
    await ask({ type: "secrets.lock" });
    const unlocked = await ask({ type: "secrets.unlockKeychain" });
    report.steps.keychain_unlock = unlocked?.result ? { state: unlocked.result.state, keychain_enabled: unlocked.result.keychain_enabled } : unlocked;
    check("keychain", "the store unlocks from the keychain", unlocked?.result?.state === "unlocked", unlocked);
  }
} catch (error) {
  check("harness", "the harness ran to the end", false, error instanceof Error ? error.message : String(error));
} finally {
  chrome.kill();
  await sleep(300);
  if (args.keychain) spawnSync("/usr/bin/security", ["delete-generic-password", "-s", HOST, "-a", "store-wrapping-key"]);
  rmSync(run, { recursive: true, force: true });
}
report.passed = report.checks.length > 0 && report.checks.every((item) => item.ok);
const text = `${JSON.stringify(report, null, 2)}\n`;
if (args.out) writeFileSync(args.out, text);
process.stdout.write(text);
process.exit(report.passed ? 0 : 1);
