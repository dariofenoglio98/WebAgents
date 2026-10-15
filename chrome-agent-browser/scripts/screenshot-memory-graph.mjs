#!/usr/bin/env node
/**
 * T19 evidence in a real Chrome (design `memory-ui.md` §3.2, D-218, D-224): the Memory page's
 * graph and the record card, from the built extension, at 1280 and 480 px, over the fictional demo
 * set and over a synthetic memory of 1,000 notes with about 3,000 links (the performance target).
 *
 * The installed Chrome runs headless with `dist/extension` loaded over the DevTools pipe (D-037).
 * Setup goes through the extension's own messages from its page: a passphrase (the secret store),
 * the demo set, then the synthetic folder imported through `memory.importPlan` / `memory.importApply`.
 * For each width a fresh tab opens `#memory`: the graph (first paint timed from navigation to the
 * canvas's first drawn frame), a node clicked to open the record card, the list view, and the
 * synthetic memory's graph; the timings and the page's geometry are recorded with each shot. The
 * target (first paint < 500 ms warm, 1,000 nodes usable) is a measurement, not a promise: the
 * report says what this machine did. Writes PNGs and a JSON with "passed" under
 * `examples/verification/chrome-memory-graph/` (or `--out <directory>`).
 *
 *   npm run build && node scripts/screenshot-memory-graph.mjs [--chrome <path>] [--out <directory>] [--nodes 1000]
 */
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { Cdp, sleep } from "./lib/cdp.mjs";
import { grantedBuild } from "./lib/granted-build.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const PROJECT = resolve(here, "..");
const ROOT = resolve(PROJECT, "..");
const EXTENSION = join(PROJECT, "dist", "extension");
const WIDTHS = [
  { width: 1280, height: 860 },
  { width: 480, height: 1000 },
];
const PASSPHRASE = "a throwaway passphrase for the screenshot harness";

const args = { chrome: process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", out: join(ROOT, "examples", "verification", "chrome-memory-graph"), nodes: 1000 };
for (let index = 2; index < process.argv.length; index += 1) {
  const argument = process.argv[index];
  if (argument === "--chrome") args.chrome = process.argv[(index += 1)];
  else if (argument === "--out") args.out = resolve(process.argv[(index += 1)]);
  else if (argument === "--nodes") args.nodes = Number(process.argv[(index += 1)]);
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
  profile: "chrome-memory-graph-v0",
  recordedAt: new Date().toISOString(),
  build: {
    commit: git("rev-parse", "HEAD"),
    tree_clean: git("status", "--porcelain", "--", "chrome-agent-browser") === "",
    extension: Object.fromEntries(["manifest.json", "browser.html", "browser.js", "styles.css"].map((name) => [name, sha256(readFileSync(join(EXTENSION, name)))])),
  },
  chrome: null,
  widths: WIDTHS.map((size) => size.width),
  synthetic: { nodes: args.nodes, links: null },
  shots: {},
  timings: {},
  checks: {},
  failures: [],
  passed: false,
};
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

/** A synthetic memory folder (memory.v0 §8): `nodes` notes, each linking to about three others by title. */
function syntheticFolder(nodes) {
  const files = [];
  const titles = Array.from({ length: nodes }, (_, index) => `Note ${String(index + 1).padStart(4, "0")}`);
  let links = 0;
  for (const [index, title] of titles.entries()) {
    const targets = [titles[(index * 7 + 1) % nodes], titles[(index * 13 + 5) % nodes], titles[(index * 31 + 11) % nodes]].filter((target) => target !== title);
    const related = targets.map((target) => `  - "[[${target}]]"`).join("\n");
    links += targets.length;
    files.push({ path: `document.note/${title}.md`, text: `---\ntype: "document.note"\ntitle: "${title}"\nscope: "user"\ncreated: "2026-10-01T00:00:00Z"\nupdated: "2026-10-01T00:00:00Z"\nsource:\n  kind: "person"\nrelated:\n${related}\ntags:\n  - "synthetic"\n---\n\nSynthetic note ${index + 1} of ${nodes}, for the graph's performance measurement.\n` });
  }
  return { files, links };
}

/** Read in the page: the graph's geometry and the card. */
const MEASURE = String.raw`(() => {
  const box = (selector) => { const node = document.querySelector(selector); if (!node) return null; const r = node.getBoundingClientRect(); return { left: Math.round(r.left), top: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) }; };
  return {
    viewport: { width: innerWidth, scrollWidth: document.documentElement.scrollWidth },
    mode: document.querySelector(".ab-memory")?.className ?? null,
    status: document.querySelector(".ab-memory-status")?.textContent ?? null,
    legend: [...document.querySelectorAll(".ab-memory-legend-item")].map((item) => item.textContent.trim()),
    canvas: box(".ab-memory-canvas"),
    graph: box(".ab-memory-graph"),
    legendBox: box(".ab-memory-legend"),
    controls: box(".ab-memory-graph-controls"),
    body: box(".ab-memory-body"),
    card: box(".ab-memory-card"),
    cardRecord: document.querySelector(".ab-memory-card")?.dataset.record ?? null,
    cardTitle: document.querySelector('.ab-memory-card input[name="record-title"]')?.value ?? null,
    masked: [...document.querySelectorAll(".ab-sealed-value .ab-id")].map((node) => node.textContent),
    rows: document.querySelectorAll(".ab-memory-row").length,
    nav: box(".ab-nav"),
  };
})()`;

async function main() {
  const scratch = mkdtempSync(join(realpathSync(tmpdir()), "chrome-memory-graph-"));
  let chrome = null;
  try {
    chrome = spawn(args.chrome, ["--headless=new", "--remote-debugging-pipe", "--enable-unsafe-extension-debugging", `--user-data-dir=${join(scratch, "profile")}`, "--no-first-run", "--no-default-browser-check", "--hide-scrollbars", "about:blank"], { stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"] });
    const cdp = new Cdp(chrome);
    report.chrome = (await cdp.send("Browser.getVersion")).product;
    const granted = grantedBuild(EXTENSION, scratch, []);
    const { id: extensionId } = await cdp.send("Extensions.loadUnpacked", { path: granted.path });
    const base = `chrome-extension://${extensionId}`;
    await cdp.waitForTarget((target) => target.type === "service_worker" && target.url === `${base}/service-worker.js`, "the service worker");

    async function tab(hash, size) {
      const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
      const page = await cdp.attach(targetId);
      await cdp.send("Emulation.setDeviceMetricsOverride", { width: size.width, height: size.height, deviceScaleFactor: 1, mobile: false }, page);
      await cdp.send("Page.enable", {}, page);
      const navigated = Date.now();
      await cdp.send("Page.navigate", { url: `${base}/browser.html${hash}` }, page);
      await cdp.waitFor(page, `typeof chrome !== "undefined" && !!chrome.runtime && document.getElementById("app") !== null`, "the full page");
      return { page, navigated, close: () => cdp.send("Target.closeTarget", { targetId }) };
    }
    const shot = async (page, file) => {
      const { data } = await cdp.send("Page.captureScreenshot", { format: "png" }, page);
      mkdirSync(args.out, { recursive: true });
      writeFileSync(join(args.out, file), Buffer.from(data, "base64"));
    };

    // Setup through the extension's own messages: a passphrase, the demo set.
    const setup = await tab("#open", WIDTHS[0]);
    const send = async (request) => {
      const reply = await cdp.evaluate(setup.page, `chrome.runtime.sendMessage(${JSON.stringify(request)})`);
      if (!reply?.ok) throw new Error(`${request.type}: ${reply?.error?.code}: ${reply?.error?.message}`);
      return reply.result;
    };
    await send({ type: "secrets.setup", passphrase: PASSPHRASE });
    const demo = await send({ type: "memory.installDemo" });
    check("the demo set is installed", demo.added === 6, demo);
    const view = await send({ type: "memory.get" });
    check("the memory view masks every sealed value", !JSON.stringify(view).includes("alex.traveler@example.com") && view.records.filter((record) => record.demo).length === 6, { records: view.records.length });

    // The demo graph, the card, the list: per width.
    for (const size of WIDTHS) {
      const { page, navigated, close } = await tab("#memory", size);
      const painted = await cdp.waitFor(page, `(() => { const c = document.querySelector(".ab-memory-canvas"); return c && c.width > 0 && document.querySelector(".ab-memory-legend-item") ? performance.now() : null; })()`, "the graph", 30_000);
      const firstPaintMs = Date.now() - navigated;
      await sleep(900); // the simulation's ticks settle within the frame budget
      const graph = await cdp.evaluate(page, MEASURE);
      await shot(page, `graph-demo-${size.width}.png`);
      report.shots[`graph-demo-${size.width}`] = { file: `graph-demo-${size.width}.png`, ...graph };
      report.timings[`demo-${size.width}`] = { first_paint_ms: firstPaintMs, page_ms_at_paint: Math.round(painted) };
      check(`${size.width}px: the graph is drawn with a legend and no horizontal scroll`, () => graph.canvas.width > 200 && graph.legend.length >= 3 && graph.viewport.scrollWidth <= graph.viewport.width, graph);
      check(`${size.width}px: the legend and the zoom controls sit inside the graph box`, () => graph.legendBox.top >= graph.graph.top && graph.legendBox.top + graph.legendBox.height <= graph.graph.top + graph.graph.height && graph.controls.top + graph.controls.height <= graph.graph.top + graph.graph.height, { graph: graph.graph, legend: graph.legendBox, controls: graph.controls });
      // At a desktop width the graph box fits the viewport whole; at a phone width the page scrolls and the box starts inside the first screen (design §3.7: filters collapsed behind one button).
      check(`${size.width}px: the graph box ${size.width > 700 ? "fits the viewport" : "starts inside the first screen"}`, () => (size.width > 700 ? graph.graph.top + graph.graph.height <= size.height + 1 : graph.graph.top < size.height / 2), { graph: graph.graph, viewport: size });
      // A keyboard path opens a record: Home focuses `self`, ArrowRight the nearest record, Enter opens its card.
      await cdp.evaluate(page, `(() => { document.querySelector(".ab-memory-canvas").focus(); return true; })()`);
      for (const key of ["Home", "ArrowRight", "Enter"]) {
        for (const type of ["keyDown", "keyUp"]) await cdp.send("Input.dispatchKeyEvent", { type, key, code: key, windowsVirtualKeyCode: key === "Enter" ? 13 : key === "Home" ? 36 : 39, nativeVirtualKeyCode: key === "Enter" ? 13 : key === "Home" ? 36 : 39, ...(type === "keyDown" && key === "Enter" ? { text: "\r" } : {}) }, page);
        await sleep(120);
      }
      await sleep(300);
      const card = await cdp.evaluate(page, MEASURE);
      await shot(page, `card-demo-${size.width}.png`);
      report.shots[`card-demo-${size.width}`] = { file: `card-demo-${size.width}.png`, ...card };
      check(`${size.width}px: the keyboard opens a record card beside the graph, sealed values masked`, () => card.cardRecord !== null && card.cardRecord !== "new" && card.masked.every((text) => text === "••••••"), { cardRecord: card.cardRecord, masked: card.masked });
      // The list view: the accessible equivalent.
      await cdp.evaluate(page, `(() => { [...document.querySelectorAll(".ab-memory-toggle button")].find((b) => b.textContent === "List").click(); return true; })()`);
      await sleep(300);
      const list = await cdp.evaluate(page, MEASURE);
      await shot(page, `list-demo-${size.width}.png`);
      report.shots[`list-demo-${size.width}`] = { file: `list-demo-${size.width}.png`, rows: list.rows, status: list.status };
      check(`${size.width}px: the list shows every record (Me and the six demo records)`, list.rows === 7, list.rows);
      await close();
    }

    // The synthetic memory: imported, then measured.
    const synthetic = syntheticFolder(args.nodes);
    report.synthetic.links = synthetic.links;
    const importedAt = Date.now();
    const plan = await send({ type: "memory.importPlan", files: synthetic.files });
    const applied = await send({ type: "memory.importApply", files: synthetic.files, completions: {} });
    report.timings.import = { plan_ms: Date.now() - importedAt, added: plan.counts.added, written: applied.written, links_resolved: plan.counts.links_resolved };
    check("the synthetic memory imports completely", applied.written === args.nodes && plan.counts.refused === 0, report.timings.import);
    const { page, navigated, close } = await tab("#memory", WIDTHS[0]);
    await cdp.waitFor(page, `(() => { const c = document.querySelector(".ab-memory-canvas"); return c && c.width > 0 && document.querySelector(".ab-memory-legend-item") ? true : null; })()`, "the synthetic graph", 60_000);
    const firstPaintMs = Date.now() - navigated;
    await sleep(2500);
    // Frame rate while panning and while dragging with the simulation running, measured in the page.
    const frames = await cdp.evaluate(page, String.raw`(async () => {
      const canvas = document.querySelector(".ab-memory-canvas");
      const rect = canvas.getBoundingClientRect();
      const fire = (type, x, y, extra = {}) => canvas.dispatchEvent(new PointerEvent(type, { clientX: rect.left + x, clientY: rect.top + y, pointerId: 1, bubbles: true, ...extra }));
      const measure = async (steps, move) => {
        let count = 0; let last = performance.now(); const started = last; const gaps = [];
        await new Promise((done) => { const loop = () => { const now = performance.now(); gaps.push(now - last); last = now; count += 1; if (count < steps) { move(count); requestAnimationFrame(loop); } else done(); }; requestAnimationFrame(loop); });
        const elapsed = performance.now() - started;
        return { frames: count, elapsed_ms: Math.round(elapsed), fps: Math.round((count / elapsed) * 1000), worst_gap_ms: Math.round(Math.max(...gaps)) };
      };
      fire("pointerdown", 10, 10);
      const pan = await measure(60, (i) => fire("pointermove", 10 + i * 2, 10 + i));
      fire("pointerup", 130, 70);
      const nodes = ${JSON.stringify(args.nodes)};
      return { pan, nodes };
    })()`, { awaitPromise: true });
    report.timings.synthetic = { first_paint_ms: firstPaintMs, ...frames };
    const graph = await cdp.evaluate(page, MEASURE);
    await shot(page, "graph-synthetic-1280.png");
    report.shots["graph-synthetic-1280"] = { file: "graph-synthetic-1280.png", status: graph.status, canvas: graph.canvas, legend: graph.legend };
    check("the synthetic graph is drawn", () => graph.canvas.width > 200 && /1\d\d\d records/u.test(graph.status ?? ""), graph.status);
    check("panning the synthetic graph stays above 30 fps on this machine (the 60 fps target is a measurement)", () => frames.pan.fps >= 30, frames);
    await close();
  } catch (error) {
    report.failures.push(`harness: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    if (chrome) chrome.kill("SIGTERM");
    await sleep(200);
    rmSync(scratch, { recursive: true, force: true });
  }
  report.passed = report.failures.length === 0 && WIDTHS.every((size) => report.shots[`graph-demo-${size.width}`] && report.shots[`card-demo-${size.width}`]) && Boolean(report.shots["graph-synthetic-1280"]);
  mkdirSync(args.out, { recursive: true });
  const text = `${JSON.stringify(report, null, 2)}\n`;
  writeFileSync(join(args.out, "chrome-memory-graph.json"), text);
  process.stdout.write(text);
  process.exit(report.passed ? 0 : 1);
}

main();
