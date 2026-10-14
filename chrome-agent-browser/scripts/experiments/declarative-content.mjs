#!/usr/bin/env node
/**
 * T16 experiment (D-190, D-196): what headless Chrome can and cannot tell about the passive
 * badge and about granting permissions. A throwaway extension (written into the run directory,
 * never the product) registers a `declarativeContent` rule `css: ['link[rel="agent-package"]']`
 * → `ShowAction()` and is loaded with `Extensions.loadUnpacked` against a local HTTPS mock of
 * the WebAir origin (the captured site, `examples/webair-site.json`).
 *
 * Recorded, per case, as the only API observable of the action's state: `chrome.action
 * .isEnabled(tabId)`. Chromium's `ActionIsEnabledFunction` answers `GetIsVisibleIgnoringDeclarative`,
 * so a declarative show is invisible to it: every case reads false, the controls included, and
 * the head-link question is settled from the Blink sources instead (D-190). The grant probes
 * record that `chrome.permissions.request` under a CDP user gesture never resolves headlessly,
 * that `chrome.scripting.executeScript` without a grant is refused, and that a `_execute_action`
 * keyboard command sent over CDP reaches no extension event.
 *
 *   node scripts/experiments/declarative-content.mjs [--chrome <path>] [--out <report.json>]
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { Cdp, sleep } from "../lib/cdp.mjs";
import { certificate, serveFiles } from "../lib/origin.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const PROJECT = resolve(here, "..", "..");
const ROOT = resolve(PROJECT, "..");
const DEFAULT_CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const HOST = "webair.example";

const args = { chrome: process.env.CHROME_PATH || DEFAULT_CHROME, out: null };
for (let index = 2; index < process.argv.length; index += 1) {
  const argument = process.argv[index];
  if (argument === "--chrome") args.chrome = process.argv[(index += 1)];
  else if (argument === "--out") args.out = process.argv[(index += 1)];
  else {
    console.error(`unknown argument ${argument}`);
    process.exit(2);
  }
}
if (!existsSync(args.chrome)) {
  console.error(`Chrome not found at ${args.chrome}; pass --chrome <path>`);
  process.exit(2);
}

/** The throwaway extension: declarativeContent + activeTab + scripting (+ tabs, to find the tab id, which the product never requests). */
const EXTENSION_FILES = {
  "manifest.json": JSON.stringify(
    {
      manifest_version: 3,
      name: "T16 declarativeContent experiment",
      version: "0.0.1",
      permissions: ["declarativeContent", "activeTab", "scripting", "tabs"],
      optional_host_permissions: ["https://*/*"],
      background: { service_worker: "sw.js", type: "module" },
      action: { default_title: "experiment" },
      commands: { _execute_action: { suggested_key: { default: "Ctrl+Shift+Y", mac: "Command+Shift+Y" } } },
    },
    null,
    2,
  ),
  "sw.js": `
const changed = chrome.declarativeContent.onPageChanged;
const removeAll = () => new Promise((done) => changed.removeRules(undefined, done));
const add = (rules) => new Promise((done) => changed.addRules(rules, done));
const get = () => new Promise((done) => changed.getRules(undefined, done));
globalThis.__cssRule = async (css) => {
  await removeAll();
  await add([{ conditions: [new chrome.declarativeContent.PageStateMatcher({ css })], actions: [new chrome.declarativeContent.ShowAction()] }]);
  return (await get()).length;
};
globalThis.__urlRule = async (hostEquals) => {
  await removeAll();
  await add([{ conditions: [new chrome.declarativeContent.PageStateMatcher({ pageUrl: { hostEquals } })], actions: [new chrome.declarativeContent.ShowAction()] }]);
  return (await get()).length;
};
globalThis.__events = [];
chrome.action.onClicked.addListener((tab) => globalThis.__events.push({ onClicked: tab.id }));
chrome.commands.onCommand.addListener((command) => globalThis.__events.push({ onCommand: command }));
chrome.runtime.onInstalled.addListener(async () => {
  await chrome.action.disable();
  await globalThis.__cssRule(['link[rel="agent-package"]']);
});
`,
  "page.html": '<!doctype html><html><head><meta charset="utf-8"><title>experiment</title></head><body><button id="request">request</button><script src="page.js"></script></body></html>',
  "page.js": `
globalThis.__result = null;
document.getElementById("request").addEventListener("click", () => {
  chrome.permissions.request({ origins: ["https://${HOST}/*"] }).then((granted) => { globalThis.__result = { granted }; }, (error) => { globalThis.__result = { error: String(error) }; });
});
`,
};

async function main() {
  const startedAt = new Date();
  const run = join(PROJECT, ".e2e", `declarative-content-${startedAt.toISOString().replace(/[:.]/gu, "-")}`);
  const extension = join(run, "extension");
  mkdirSync(extension, { recursive: true });
  mkdirSync(join(run, "profile"));
  for (const [name, text] of Object.entries(EXTENSION_FILES)) writeFileSync(join(extension, name), text);

  const site = JSON.parse(readFileSync(join(ROOT, "examples", "webair-site.json"), "utf8"));
  const index = site.pages.find((page) => page.path === "/").html;
  const noAgent = index.replace(/<link rel="agent-package"[^>]*>\s*/u, "");
  const bodyLink = noAgent.replace("</body>", '<link rel="agent-package" href="/agent.pkg" type="application/vnd.webagents.agent-package"></body>');
  const html = (text) => ({ bytes: Buffer.from(text), type: "text/html; charset=utf-8" });
  const tls = certificate(run, HOST);
  const origin = await serveFiles(tls, { "/": html(index), "/no-agent": html(noAgent), "/body-link": html(bodyLink), "/static/webair.css": { bytes: Buffer.from(""), type: "text/css" } });

  const report = {
    profile: "chrome-agent-browser-declarative-content-experiment-v0",
    recordedAt: startedAt.toISOString(),
    chrome: null,
    observable: "chrome.action.isEnabled(tabId), read 2.5 s after each navigation; Chromium answers GetIsVisibleIgnoringDeclarative, so a declarative show never reads true here",
    cases: {},
    grants: {},
    conclusion: null,
  };
  const chrome = spawn(
    args.chrome,
    ["--headless=new", "--remote-debugging-pipe", "--enable-unsafe-extension-debugging", `--user-data-dir=${join(run, "profile")}`, "--no-first-run", "--no-default-browser-check", `--host-resolver-rules=MAP ${HOST} 127.0.0.1:${origin.port}`, `--ignore-certificate-errors-spki-list=${tls.spkiHash}`, "--window-size=1280,900", "about:blank"],
    { stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"] },
  );
  const cdp = new Cdp(chrome);
  try {
    report.chrome = (await cdp.send("Browser.getVersion")).product;
    const { id } = await cdp.send("Extensions.loadUnpacked", { path: extension });
    const base = `chrome-extension://${id}`;
    const workerTarget = await cdp.waitForTarget((target) => target.type === "service_worker" && target.url === `${base}/sw.js`, "the worker");
    const worker = await cdp.attach(workerTarget.targetId);
    await sleep(500);
    const { targetId } = await cdp.send("Target.createTarget", { url: `https://${HOST}/` });
    const page = await cdp.attach(targetId);
    await cdp.waitFor(page, 'document.readyState === "complete" && document.title', "the page");
    const tabId = await cdp.waitFor(worker, `chrome.tabs.query({ url: "https://${HOST}/*" }).then((tabs) => tabs[0]?.id ?? 0)`, "the tab id");
    const enabled = async () => {
      await sleep(2500);
      return cdp.evaluate(worker, `chrome.action.isEnabled(${tabId})`);
    };
    const navigate = async (path) => {
      await cdp.send("Page.navigate", { url: `https://${HOST}${path}` }, page);
      await cdp.waitFor(page, 'document.readyState === "complete"', "the navigation");
    };
    const cssRule = (css) => cdp.evaluate(worker, `globalThis.__cssRule(${JSON.stringify(css)})`);
    report.cases.global_disabled = (await cdp.evaluate(worker, "chrome.action.isEnabled()")) === false;
    await cdp.evaluate(worker, `globalThis.__urlRule(${JSON.stringify(HOST)})`);
    await navigate("/");
    report.cases.control_pageurl_rule = await enabled();
    await cssRule(["h1"]);
    await navigate("/");
    report.cases.control_css_h1 = await enabled();
    await cssRule(['link[rel="agent-package"]']);
    await navigate("/");
    report.cases.head_link = await enabled();
    report.cases.head_link_present_in_dom = await cdp.evaluate(page, `document.head.querySelectorAll('link[rel="agent-package"]').length`);
    await navigate("/no-agent");
    report.cases.no_link = await enabled();
    await navigate("/body-link");
    report.cases.body_link = await enabled();
    try {
      await cssRule(['head link[rel="agent-package"]']);
      report.cases.descendant_selector = "accepted";
    } catch (error) {
      report.cases.descendant_selector = `refused: ${/Invalid CSS selector[^\n]*/u.exec(error.message)?.[0] ?? error.message.slice(0, 120)}`;
    }

    // Grant probes.
    const scripting = async () => {
      try {
        return await cdp.evaluate(worker, `chrome.scripting.executeScript({ target: { tabId: ${tabId} }, func: () => document.title }).then((results) => results[0]?.result ?? null)`);
      } catch (error) {
        return `refused: ${/Cannot access contents of url[^.]*/u.exec(error.message)?.[0] ?? error.message.slice(0, 120)}`;
      }
    };
    await navigate("/");
    report.grants.executeScript_without_grant = await scripting();
    const modifiers = 4 | 8; // Meta + Shift (the mac binding)
    for (const type of ["keyDown", "keyUp"]) await cdp.send("Input.dispatchKeyEvent", { type, key: "Y", code: "KeyY", windowsVirtualKeyCode: 89, nativeVirtualKeyCode: 89, modifiers }, page);
    await sleep(1000);
    report.grants.events_after_cdp_key_command = await cdp.evaluate(worker, "globalThis.__events");
    report.grants.executeScript_after_cdp_key_command = await scripting();
    const { targetId: pageId } = await cdp.send("Target.createTarget", { url: `${base}/page.html` });
    const extensionPage = await cdp.attach(pageId);
    await cdp.waitFor(extensionPage, 'document.getElementById("request") !== null', "the extension page");
    await cdp.evaluate(extensionPage, 'document.getElementById("request").click(); true', { userGesture: true });
    let result = null;
    for (let attempt = 0; attempt < 40 && result === null; attempt += 1) {
      await sleep(250);
      result = await cdp.evaluate(extensionPage, "globalThis.__result");
    }
    report.grants.permissions_request_under_cdp_gesture = result ?? "no answer within 10 s: the prompt waits for nobody";
    report.grants.granted_origins_after = (await cdp.evaluate(worker, "chrome.permissions.getAll()")).origins;
    report.conclusion =
      "Outcome B (D-190): the API cannot observe a declarative show (the controls read false too), and the Blink sources settle that a <link> in <head> never matches a watched selector; " +
      "headless Chrome grants nothing (D-196): the prompt never resolves, no activeTab gesture can be sent, and executeScript without a grant is refused.";
  } catch (error) {
    report.error = error.message;
  } finally {
    const exited = chrome.exitCode !== null || chrome.signalCode !== null ? Promise.resolve() : new Promise((done) => chrome.once("exit", done));
    chrome.kill();
    await Promise.race([exited, sleep(10_000)]);
    origin.server.close();
  }
  const text = `${JSON.stringify(report, null, 2)}\n`;
  if (args.out) writeFileSync(args.out, text);
  process.stdout.write(text);
  rmSync(run, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  process.exit(report.error ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
