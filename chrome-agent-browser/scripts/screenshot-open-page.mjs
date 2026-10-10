#!/usr/bin/env node
/**
 * T12 evidence in a real Chrome: the full page's Open view as a start page and as a compact page
 * (D-140, D-141), at a desktop and a narrow width, from the built extension.
 *
 * The installed Chrome runs headless with `dist/extension` loaded over the DevTools pipe (D-037).
 * A local HTTPS origin answers for the WebAir deployment's hostname with the signed demo index and
 * the packages it names, byte for byte from the repository (as `e2e-search-policy.mjs` does), so the
 * search is the real one. Before the shots: the demo index is added with its pinned key, and WebAir
 * is opened once so the start page has an "Open now" row. For each width (1280, 640, 480), a fresh tab:
 *   start   `#open`, nothing shown;
 *   compact "literature review" typed into the box and a real Enter pressed (CDP key events) → the
 *           Literature Review card.
 * Each shot records the geometry that happy-dom cannot (the wordmark, the box, the results, the
 * page's horizontal overflow, the narrow nav) and the wordmark's computed colours. T14 adds: 640 px
 * is not narrow (B-150 item 2); the compact column holds with a wider font (Verdana, item 1); one
 * focus ring when tabbing to "Open" (item 7); the compact wordmark is the home link (D-162), and a real click on
 * it at 1280 px leaves the box focused after the page settles (review 1, finding 2). A
 * missing element fails only the checks that need it (item 9). Writes six PNGs and a JSON with
 * "passed" under `examples/verification/chrome-open-page/` (or `--out <directory>`).
 *
 *   npm run build && node scripts/screenshot-open-page.mjs [--chrome <path>] [--out <directory>]
 */
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { Cdp, sleep } from "./lib/cdp.mjs";
import { certificate, serveFiles } from "./lib/origin.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const PROJECT = resolve(here, "..");
const ROOT = resolve(PROJECT, "..");
const EXTENSION = join(PROJECT, "dist", "extension");
const HOST = "webagents-webair-production.up.railway.app";
const ORIGIN = `https://${HOST}`;
const PACKAGE_TYPE = "application/vnd.webagents.agent-package";
const FILES = {
  "/agent-index.json": { path: join(ROOT, "examples", "agent-index.json"), type: "application/json" },
  "/packages/literature-review-0.2.6.agent.pkg": { path: join(ROOT, "dist", "literature-review-0.2.6.agent.pkg"), type: PACKAGE_TYPE },
  "/agent.pkg": { path: join(ROOT, "dist", "webair-0.5.0.agent.pkg"), type: PACKAGE_TYPE },
};
const WIDTHS = [
  { width: 1280, height: 860 },
  { width: 640, height: 900 },
  { width: 480, height: 1000 },
];
/** D-141: the wordmark's tokens and the contrast each must reach on `--ab-bg` (large text). */
const MARK_TOKENS = ["--ab-mark-1", "--ab-mark-2", "--ab-mark-3", "--ab-mark-4"];
const MIN_CONTRAST = 3;

const args = { chrome: process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", out: join(ROOT, "examples", "verification", "chrome-open-page") };
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
const report = {
  profile: "chrome-open-page-v0",
  recordedAt: new Date().toISOString(),
  build: {
    commit: git("rev-parse", "HEAD"),
    tree_clean: git("status", "--porcelain", "--", "chrome-agent-browser") === "",
    extension: Object.fromEntries(["manifest.json", "browser.html", "browser.js", "styles.css"].map((name) => [name, sha256(readFileSync(join(EXTENSION, name)))])),
  },
  chrome: null,
  widths: WIDTHS.map((size) => size.width),
  served: Object.fromEntries(Object.entries(FILES).map(([path, file]) => [path, { source: relative(ROOT, file.path), sha256: sha256(readFileSync(file.path)) }])),
  palette: null,
  shots: {},
  checks: {},
  failures: [],
  passed: false,
};
/** `condition` may be a function: an element it needs and does not find fails this check only (B-150 item 9). */
const check = (name, condition, detail) => {
  if (typeof condition === "function") {
    try {
      condition = condition();
    } catch (error) {
      condition = false;
      detail = { missing: error instanceof Error ? error.message : String(error), detail: detail ?? null };
    }
  }
  report.checks[name] = condition ? "ok" : { failed: detail ?? null };
  if (!condition) report.failures.push(`${name}${detail === undefined ? "" : ` (${JSON.stringify(detail).slice(0, 400)})`}`);
};

/** WCAG 2 contrast ratio of two `rgb(r, g, b)` strings. */
function contrast(a, b) {
  const luminance = (rgb) => {
    const [r, g, bl] = rgb.match(/\d+(\.\d+)?/gu).slice(0, 3).map((value) => {
      const channel = Number(value) / 255;
      return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return Math.round(((high + 0.05) / (low + 0.05)) * 100) / 100;
}

/** Read in the page: the boxes, the overflow and the wordmark's styles. */
const MEASURE = String.raw`(() => {
  const box = (selector) => { const node = document.querySelector(selector); if (!node) return null; const r = node.getBoundingClientRect(); return { left: Math.round(r.left), top: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) }; };
  const view = document.querySelector(".ab-open");
  const mark = document.querySelector("h1.ab-wordmark");
  const form = document.querySelector("form.ab-address");
  const style = mark ? getComputedStyle(mark) : null;
  return {
    layout: view ? [...view.classList].find((name) => name.startsWith("ab-open--")) ?? null : null,
    viewport: { width: innerWidth, scrollWidth: document.documentElement.scrollWidth },
    home: (() => { const link = document.querySelector("a.ab-wordmark-home"); return link ? { href: link.getAttribute("href"), holdsWordmark: link.querySelector("h1.ab-wordmark") !== null } : null; })(),
    counts: { wordmark: document.querySelectorAll("h1.ab-wordmark").length, form: document.querySelectorAll("form.ab-address").length, input: document.querySelectorAll('input[name="package-url"]').length, openButtons: form ? [...form.querySelectorAll("button")].filter((b) => b.textContent.trim() === "Open").length : 0 },
    wordmark: mark ? { name: mark.getAttribute("aria-label"), text: mark.textContent, fontSize: style.fontSize, fontWeight: style.fontWeight, fontFamily: style.fontFamily, colors: [...mark.children].map((span) => getComputedStyle(span).color) } : null,
    background: getComputedStyle(document.body).backgroundColor,
    radius: form ? getComputedStyle(form).borderTopLeftRadius : null,
    boxes: { wordmark: box("h1.ab-wordmark"), form: box("form.ab-address"), button: box("form.ab-address button"), results: box(".ab-open-results"), result: box('.ab-result[data-package-id="org.webagents.literature-review"]'), sessions: box(".ab-open-start .ab-session-row"), nav: box(".ab-nav"), navOpen: box('.ab-nav a[data-view="open"]') },
  };
})()`;

async function main() {
  const scratch = mkdtempSync(join(realpathSync(tmpdir()), "chrome-open-page-"));
  let chrome = null;
  let served = null;
  try {
    const tls = certificate(scratch, HOST);
    served = await serveFiles(tls, FILES);
    chrome = spawn(args.chrome, ["--headless=new", "--remote-debugging-pipe", "--enable-unsafe-extension-debugging", `--user-data-dir=${join(scratch, "profile")}`, "--no-first-run", "--no-default-browser-check", "--hide-scrollbars", `--host-resolver-rules=MAP ${HOST} 127.0.0.1:${served.port}`, `--ignore-certificate-errors-spki-list=${tls.spkiHash}`, "about:blank"], { stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"] });
    const cdp = new Cdp(chrome);
    report.chrome = (await cdp.send("Browser.getVersion")).product;
    const { id: extensionId } = await cdp.send("Extensions.loadUnpacked", { path: EXTENSION });
    const base = `chrome-extension://${extensionId}`;
    await cdp.waitForTarget((target) => target.type === "service_worker" && target.url === `${base}/service-worker.js`, "the service worker");

    async function tab(hash, size) {
      const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
      const page = await cdp.attach(targetId);
      await cdp.send("Emulation.setDeviceMetricsOverride", { width: size.width, height: size.height, deviceScaleFactor: 1, mobile: false }, page);
      await cdp.send("Page.enable", {}, page);
      await cdp.send("Page.navigate", { url: `${base}/browser.html${hash}` }, page);
      await cdp.waitFor(page, `typeof chrome !== "undefined" && !!chrome.runtime && document.getElementById("app") !== null`, "the full page");
      return { page, close: () => cdp.send("Target.closeTarget", { targetId }) };
    }

    // Setup through the extension's own messages: the demo index with its pinned key, and WebAir open.
    const setup = await tab("#open", WIDTHS[0]);
    const send = async (request) => {
      const reply = await cdp.evaluate(setup.page, `chrome.runtime.sendMessage(${JSON.stringify(request)})`);
      if (!reply?.ok) throw new Error(`${request.type}: ${reply?.error?.code}: ${reply?.error?.message}`);
      return reply.result;
    };
    const indexes = await send({ type: "indexes.add", url: `${ORIGIN}/agent-index.json`, publicKeyPem: readFileSync(join(ROOT, "examples", "keys", "webagents-index.pub.pem"), "utf8") });
    check("the demo index is added and current", indexes.indexes?.length === 1 && indexes.indexes[0].state === "current", indexes.indexes?.[0]?.state);
    const opened = await send({ type: "package.open", url: `${ORIGIN}/agent.pkg`, viewId: "screenshot-open-page" });
    check("WebAir is open, so the start page has a session row", opened.page.identity.version === "0.5.0", opened.page.identity);

    // The palette, read from the stylesheet the extension ships.
    const tokens = await cdp.evaluate(setup.page, `(() => { const style = getComputedStyle(document.documentElement); return Object.fromEntries(${JSON.stringify(MARK_TOKENS)}.map((name) => [name, style.getPropertyValue(name).trim()]).concat([["--ab-bg", style.getPropertyValue("--ab-bg").trim()]])); })()`);
    report.palette = tokens;

    for (const size of WIDTHS) {
      for (const layout of ["start", "compact"]) {
        const { page, close } = await tab("#open", size);
        await cdp.waitFor(page, `document.querySelector(".ab-open--start .ab-session-row") !== null`, "the start page with its session row");
        if (layout === "compact") {
          // Typed and submitted as a person does: text into the focused box, then a real Enter (B-150 item 3).
          await cdp.evaluate(page, `(() => { document.querySelector('input[name="package-url"]').focus(); return true; })()`);
          await cdp.send("Input.insertText", { text: "literature review" }, page);
          for (const type of ["keyDown", "keyUp"]) await cdp.send("Input.dispatchKeyEvent", { type, key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, ...(type === "keyDown" ? { text: "\r" } : {}) }, page);
          await cdp.waitFor(page, `document.querySelector('.ab-open--compact .ab-result[data-package-id="org.webagents.literature-review"]') !== null`, "the compact page with the Literature Review card");
        }
        await sleep(300);
        if (layout === "start" && size.width === 1280) {
          // One focus ring when tabbing to "Open" (B-150 item 7): the box's ring goes, the button's shows.
          await cdp.evaluate(page, `(() => { document.querySelector('input[name="package-url"]').focus(); return true; })()`);
          const ring = () => cdp.evaluate(page, `(() => { const form = document.querySelector("form.ab-address"); const button = form && form.querySelector("button"); return form && button ? { form: getComputedStyle(form).outlineStyle, button: getComputedStyle(button).outlineStyle, focused: document.activeElement === button ? "button" : document.activeElement?.tagName ?? null } : null; })()`);
          const inBox = await ring();
          for (const type of ["keyDown", "keyUp"]) await cdp.send("Input.dispatchKeyEvent", { type, key: "Tab", code: "Tab", windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9 }, page);
          await sleep(150);
          const onButton = await ring();
          report.focusRings = { inBox, onButton };
          check("1280px: the box has its ring while typing", () => inBox.form === "solid" && inBox.button === "none", inBox);
          check("1280px: tabbing to Open shows one ring, the button's", () => onButton.focused === "button" && onButton.form === "none" && onButton.button === "solid", onButton);
          await cdp.evaluate(page, `(() => { document.activeElement?.blur(); return true; })()`);
          await sleep(150);
        }
        const measured = await cdp.evaluate(page, MEASURE);
        const file = `open-${layout}-${size.width}.png`;
        const { data } = await cdp.send("Page.captureScreenshot", { format: "png" }, page);
        mkdirSync(args.out, { recursive: true });
        writeFileSync(join(args.out, file), Buffer.from(data, "base64"));
        report.shots[`${layout}-${size.width}`] = { file, ...measured };
        if (layout === "compact" && size.width === 1280) {
          // A wider font than macOS's (B-150 item 1): the wordmark's column grows and the results follow the box.
          await cdp.evaluate(page, `(() => { document.querySelector("h1.ab-wordmark").style.fontFamily = "Verdana, sans-serif"; return true; })()`);
          await sleep(150);
          const wide = await cdp.evaluate(page, MEASURE);
          report.shots["compact-1280-verdana"] = { fontFamily: wide.wordmark?.fontFamily ?? null, boxes: wide.boxes };
          check("compact at 1280px in Verdana: the wordmark still beside the box, the results still in the box's column", () => {
            const w = wide.boxes;
            return w.wordmark.width > measured.boxes.wordmark.width && w.wordmark.left + w.wordmark.width <= w.form.left && Math.abs(w.results.left - w.form.left) <= 1 && Math.abs(w.results.width - w.form.width) <= 1;
          }, wide.boxes);

          // A real click on the home link (D-162): the start page, and the box keeps the focus after
          // the re-render that follows when the sessions answer (T14 review 1, finding 2).
          const link = await cdp.evaluate(page, `(() => { const r = document.querySelector("a.ab-wordmark-home")?.getBoundingClientRect(); return r ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null; })()`);
          if (link) for (const type of ["mousePressed", "mouseReleased"]) await cdp.send("Input.dispatchMouseEvent", { type, x: link.x, y: link.y, button: "left", clickCount: 1 }, page);
          await sleep(600);
          const home = await cdp.evaluate(page, `(() => ({ hash: location.hash, layout: document.querySelector(".ab-open")?.className ?? null, rows: document.querySelectorAll(".ab-open--start .ab-session-row").length, focused: document.activeElement?.getAttribute("name") ?? document.activeElement?.tagName ?? null, value: document.querySelector('input[name="package-url"]')?.value ?? null }))()`);
          report.homeClick = home;
          check("compact at 1280px: a click on the home link leads to the start page with an empty, focused box", () => link !== null && home.hash === "#open" && home.layout.includes("ab-open--start") && home.rows === 1 && home.focused === "package-url" && home.value === "", { link, home });
        }
        await close();

        const name = `${layout} at ${size.width}px`;
        const b = measured.boxes;
        check(`${name}: the ${layout} layout`, measured.layout === `ab-open--${layout}`, measured.layout);
        check(`${name}: one wordmark, one form, one input, one Open button`, Object.values(measured.counts).every((count) => count === 1), measured.counts);
        check(`${name}: the wordmark's accessible name is WebAgents, nine letters in four colours`, () => measured.wordmark.name === "WebAgents" && measured.wordmark.text === "WebAgents" && new Set(measured.wordmark.colors).size === 4, measured.wordmark);
        check(`${name}: no horizontal scroll`, measured.viewport.scrollWidth <= measured.viewport.width, measured.viewport);
        check(`${name}: the box is a pill at least 44px high, inside the viewport`, () => parseFloat(measured.radius) >= 24 && b.form.height >= 44 && b.form.left >= 0 && b.form.left + b.form.width <= size.width, { radius: measured.radius, form: b.form });
        check(`${name}: the Open button sits inside the box`, () => b.button.left >= b.form.left && b.button.left + b.button.width <= b.form.left + b.form.width && b.button.top >= b.form.top && b.button.top + b.button.height <= b.form.top + b.form.height, { form: b.form, button: b.button });
        if (size.width <= 700) check(`${name}: the narrow nav is one short band above the page, its links not stretched`, () => b.nav.height <= 120 && b.navOpen.height <= 48, { nav: b.nav, navOpen: b.navOpen });
        const fontSize = parseFloat(measured.wordmark?.fontSize);
        if (layout === "start") {
          check(`${name}: a large wordmark centred above the box`, () => fontSize >= (size.width < 640 ? 48 : 64) && fontSize <= 72 && b.wordmark.top + b.wordmark.height <= b.form.top && Math.abs(b.wordmark.left + b.wordmark.width / 2 - (b.form.left + b.form.width / 2)) <= 2, { fontSize, wordmark: b.wordmark, form: b.form });
          check(`${name}: the box is at most about 640px wide and in the upper half`, () => b.form.width <= 642 && b.form.top < size.height / 2, b.form);
          check(`${name}: the open session is listed below the box`, () => b.sessions.top > b.form.top + b.form.height, b.sessions);
          check(`${name}: the wordmark is not a link on the start page`, measured.home === null, measured.home);
        } else {
          check(`${name}: a small wordmark`, fontSize >= 24 && fontSize <= 28, fontSize);
          // 640 px is wide (B-150 item 2): the narrow layout is below 640 px only.
          if (size.width >= 640) check(`${name}: the wordmark beside the box, in one row`, () => b.wordmark.left + b.wordmark.width <= b.form.left && b.wordmark.top < b.form.top + b.form.height && b.wordmark.top + b.wordmark.height > b.form.top, { wordmark: b.wordmark, form: b.form });
          else check(`${name}: the wordmark above the box`, () => b.wordmark.top + b.wordmark.height <= b.form.top, { wordmark: b.wordmark, form: b.form });
          check(`${name}: the results in the box's column, below it`, () => Math.abs(b.results.left - b.form.left) <= 1 && Math.abs(b.results.width - b.form.width) <= 1 && b.results.top >= b.form.top + b.form.height, { form: b.form, results: b.results });
          check(`${name}: the wordmark is the link back to the start page (D-162)`, () => measured.home.href === "#open" && measured.home.holdsWordmark, measured.home);
        }
      }
    }
    const start1280 = report.shots["start-1280"];
    report.palette.contrast = start1280?.wordmark ? Object.fromEntries(start1280.wordmark.colors.slice(0, 4).map((color, index) => [MARK_TOKENS[index], contrast(color, start1280.background)])) : null;
    check(`each wordmark colour has at least ${MIN_CONTRAST}:1 contrast on the page background (large text)`, () => Object.values(report.palette.contrast).every((ratio) => ratio >= MIN_CONTRAST), report.palette.contrast);
    report.origin = { requests: served.hits };
  } catch (error) {
    report.failures.push(`harness: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    if (chrome) chrome.kill("SIGTERM");
    if (served) served.server.close();
    await sleep(200);
    rmSync(scratch, { recursive: true, force: true });
  }
  report.passed = report.failures.length === 0 && WIDTHS.every((size) => ["start", "compact"].every((layout) => report.shots[`${layout}-${size.width}`]));
  mkdirSync(args.out, { recursive: true });
  const text = `${JSON.stringify(report, null, 2)}\n`;
  writeFileSync(join(args.out, "chrome-open-page.json"), text);
  process.stdout.write(text);
  process.exit(report.passed ? 0 : 1);
}

main();
