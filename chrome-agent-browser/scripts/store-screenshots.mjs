#!/usr/bin/env node
/**
 * Screenshots for the Chrome Web Store listing (T16, U7): four 1280×800 PNGs of the full-page
 * agent browser in a real headless Chrome, against a local HTTPS mock of the WebAir origin
 * (the shipped WebAir 0.5.0 package, the demo index), with the site pre-granted as a person's
 * Allow would leave it (D-196). The pages: the start page, the WebAir agent page with its
 * authorization flow, Settings → Permissions and Settings → Security. Writes the PNGs and a
 * report with the hashes of what was captured into `chrome-agent-browser/store/screenshots/`.
 *
 *   node scripts/store-screenshots.mjs [--chrome <path>] [--out <dir>]
 */
import { execFileSync } from "node:child_process";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { Cdp, sleep } from "./lib/cdp.mjs";
import { grantedBuild } from "./lib/granted-build.mjs";
import { certificate, serveFiles } from "./lib/origin.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const PROJECT = resolve(here, "..");
const ROOT = resolve(PROJECT, "..");
const EXTENSION = join(PROJECT, "dist", "extension");
const HOST = "webagents-webair-production.up.railway.app";
const ORIGIN = `https://${HOST}`;
const PACKAGE_TYPE = "application/vnd.webagents.agent-package";
const SIZE = { width: 1280, height: 800 };
const FILES = {
  "/agent-index.json": { path: join(ROOT, "examples", "agent-index.json"), type: "application/json" },
  "/agent.pkg": { path: join(ROOT, "dist", "webair-0.5.0.agent.pkg"), type: PACKAGE_TYPE },
};

const args = { chrome: process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", out: join(PROJECT, "store", "screenshots") };
for (let index = 2; index < process.argv.length; index += 1) {
  const argument = process.argv[index];
  if (argument === "--chrome") args.chrome = process.argv[(index += 1)];
  else if (argument === "--out") args.out = resolve(process.argv[(index += 1)]);
  else {
    console.error(`unknown argument ${argument}`);
    process.exit(2);
  }
}
for (const [path, hint] of [[join(EXTENSION, "manifest.json"), "run `npm run build` first"], [args.chrome, "pass --chrome <path>"]]) {
  if (!existsSync(path)) {
    console.error(`${path} is missing: ${hint}`);
    process.exit(2);
  }
}
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const git = (...gitArgs) => {
  try {
    return execFileSync("git", ["-C", ROOT, ...gitArgs], { encoding: "utf8" }).trim();
  } catch {
    return null;
  }
};
const report = { profile: "chrome-store-screenshots-v0", recordedAt: new Date().toISOString(), commit: git("rev-parse", "HEAD"), chrome: null, size: SIZE, shots: {}, failures: [], passed: false };

async function main() {
  const scratch = mkdtempSync(join(realpathSync(tmpdir()), "chrome-store-shots-"));
  let chrome = null;
  let served = null;
  try {
    const tls = certificate(scratch, HOST);
    served = await serveFiles(tls, FILES);
    const granted = grantedBuild(EXTENSION, scratch, [ORIGIN]);
    chrome = spawn(args.chrome, ["--headless=new", "--remote-debugging-pipe", "--enable-unsafe-extension-debugging", `--user-data-dir=${join(scratch, "profile")}`, "--no-first-run", "--no-default-browser-check", "--hide-scrollbars", `--host-resolver-rules=MAP ${HOST} 127.0.0.1:${served.port}`, `--ignore-certificate-errors-spki-list=${tls.spkiHash}`, "about:blank"], { stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"] });
    const cdp = new Cdp(chrome);
    report.chrome = (await cdp.send("Browser.getVersion")).product;
    const { id: extensionId } = await cdp.send("Extensions.loadUnpacked", { path: granted.path });
    const base = `chrome-extension://${extensionId}`;
    await cdp.waitForTarget((target) => target.type === "service_worker" && target.url === `${base}/service-worker.js`, "the service worker");

    async function tab(hash) {
      const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
      const page = await cdp.attach(targetId);
      await cdp.send("Emulation.setDeviceMetricsOverride", { ...SIZE, deviceScaleFactor: 1, mobile: false }, page);
      await cdp.send("Page.enable", {}, page);
      await cdp.send("Page.navigate", { url: `${base}/browser.html${hash}` }, page);
      await cdp.waitFor(page, `typeof chrome !== "undefined" && !!chrome.runtime && document.getElementById("app") !== null`, "the full page");
      return { page, close: () => cdp.send("Target.closeTarget", { targetId }) };
    }
    const setup = await tab("#open");
    const send = async (request) => {
      const reply = await cdp.evaluate(setup.page, `chrome.runtime.sendMessage(${JSON.stringify(request)})`);
      if (!reply?.ok) throw new Error(`${request.type}: ${reply?.error?.code}: ${reply?.error?.message}`);
      return reply.result;
    };
    // The state a person reaches in a minute: a passphrase set, the demo index added, WebAir open and its key trusted.
    await send({ type: "secrets.setup", passphrase: "a passphrase for the screenshots" });
    await send({ type: "indexes.add", url: `${ORIGIN}/agent-index.json`, publicKeyPem: readFileSync(join(ROOT, "examples", "keys", "webagents-index.pub.pem"), "utf8") });
    const opened = await send({ type: "package.open", url: `${ORIGIN}/agent.pkg`, advertisedOn: `${ORIGIN}/`, viewId: "store-screenshots" });
    await send({ type: "trust.pin", sessionId: opened.session.id, signerFingerprint: opened.page.trust.signer_fingerprint, scope: "publisher" });
    await send({ type: "permissions.granted", origins: [ORIGIN], purpose: { kind: "site", subject: ORIGIN } });
    mkdirSync(args.out, { recursive: true });
    const shots = [
      ["1-start-page", "#open", `document.querySelector(".ab-open--start .ab-session-row") !== null`],
      ["2-agent-page", `#session=${encodeURIComponent(opened.session.id)}`, `document.querySelector(".ab-authorize .ab-profile-card") !== null`],
      ["3-settings-permissions", "#settings?section=permissions", `document.querySelector(".ab-permission-row") !== null`],
      ["4-settings-security", "#settings?section=security", `document.querySelector('select[name="idle-lock-minutes"]') !== null`],
    ];
    for (const [name, hash, readyWhen] of shots) {
      const { page, close } = await tab(hash);
      await cdp.waitFor(page, readyWhen, name);
      await sleep(400);
      const { data } = await cdp.send("Page.captureScreenshot", { format: "png" }, page);
      const bytes = Buffer.from(data, "base64");
      const file = `${name}.png`;
      writeFileSync(join(args.out, file), bytes);
      report.shots[name] = { file, bytes: bytes.length, sha256: sha256(bytes), title: await cdp.evaluate(page, "document.title") };
      await close();
    }
  } catch (error) {
    report.failures.push(`harness: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    if (chrome) chrome.kill("SIGTERM");
    if (served) served.server.close();
    await sleep(300);
    rmSync(scratch, { recursive: true, force: true });
  }
  report.passed = report.failures.length === 0 && Object.keys(report.shots).length === 4;
  mkdirSync(args.out, { recursive: true });
  writeFileSync(join(args.out, "screenshots.json"), `${JSON.stringify({ ...report, out: relative(ROOT, args.out) }, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exit(report.passed ? 0 : 1);
}

main();
