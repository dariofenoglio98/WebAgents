#!/usr/bin/env node
/**
 * Execution-host measurement (D-027, D-070): how an offscreen document, a hidden extension tab
 * and the service worker behave while idle for a long time in a real, headed Chrome.
 *
 * Loads `scripts/measure-host-extension/` through the DevTools pipe (`Extensions.loadUnpacked`,
 * as the e2e harness does), which creates an offscreen document and a hidden tab. Each host
 * runs what a workflow run would: a chained 1 s timer, a short fetch every 5 s, an IndexedDB
 * write per tick and one long fetch the local server holds open; every 10 ticks it reports to
 * the local server. The service worker ticks too, so the server sees when Chrome stops it. At
 * minutes 3 and 20 the harness stops the service worker itself (`ServiceWorker.stopAllWorkers`)
 * to see whether the hosts outlive it. Prints JSON with the numbers; it decides nothing.
 *
 *   node scripts/measure-execution-host.mjs [--minutes 30] [--hold 1500] [--chrome <path>] [--out <json>]
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const PROJECT = resolve(here, "..");
const EXTENSION = join(here, "measure-host-extension");
const DEFAULT_CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

const args = { chrome: process.env.CHROME_PATH || DEFAULT_CHROME, minutes: 30, hold: 1500, out: null, keep: false };
for (let index = 2; index < process.argv.length; index += 1) {
  const argument = process.argv[index];
  if (argument === "--chrome") args.chrome = process.argv[(index += 1)];
  else if (argument === "--minutes") args.minutes = Number(process.argv[(index += 1)]);
  else if (argument === "--hold") args.hold = Number(process.argv[(index += 1)]);
  else if (argument === "--out") args.out = process.argv[(index += 1)];
  else if (argument === "--keep") args.keep = true;
  else { console.error(`unknown argument ${argument}`); process.exit(2); }
}
if (!existsSync(args.chrome)) { console.error(`Chrome not found at ${args.chrome}`); process.exit(2); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// -- the local server: pings, reports and the held request ----------------------------------
const pings = { offscreen: [], tab: [], sw: [] };
const reports = {};
const holds = [];
const server = createServer((request, response) => {
  const url = new URL(request.url, "http://127.0.0.1");
  const mode = url.searchParams.get("mode") || "unknown";
  if (url.pathname === "/ping") {
    (pings[mode] ??= []).push(Date.now());
    response.writeHead(200, { "content-type": "text/plain", "cache-control": "no-store" });
    return response.end("pong");
  }
  if (url.pathname === "/report" && request.method === "POST") {
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      try { reports[JSON.parse(body).mode] = { ...JSON.parse(body), receivedAt: Date.now() }; } catch { /* ignore */ }
      response.writeHead(204);
      response.end();
    });
    return undefined;
  }
  if (url.pathname === "/hold") {
    const seconds = Number(url.searchParams.get("seconds") || "60");
    const entry = { mode, startedAt: Date.now(), seconds, answeredAt: null, clientClosedAt: null };
    holds.push(entry);
    request.on("close", () => { if (entry.answeredAt === null) entry.clientClosedAt = Date.now(); });
    const timer = setTimeout(() => {
      entry.answeredAt = Date.now();
      response.writeHead(200, { "content-type": "text/plain" });
      response.end(`held ${seconds}s`);
    }, seconds * 1000);
    response.on("close", () => clearTimeout(timer));
    return undefined;
  }
  response.writeHead(404);
  response.end();
});
const port = await new Promise((r) => server.listen(0, "127.0.0.1", () => r(server.address().port)));
const SERVER = `http://127.0.0.1:${port}`;

// -- CDP over the pipe (the e2e harness's client) ------------------------------------------------
class Cdp {
  constructor(child) {
    this.out = child.stdio[3]; this.in = child.stdio[4]; this.next = 0; this.pending = new Map();
    let buffer = "";
    this.in.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      let end;
      while ((end = buffer.indexOf("\0")) >= 0) {
        const message = JSON.parse(buffer.slice(0, end));
        buffer = buffer.slice(end + 1);
        if (message.id && this.pending.has(message.id)) {
          const { resolve, reject } = this.pending.get(message.id);
          this.pending.delete(message.id);
          if (message.error) reject(new Error(`${message.error.message} (${message.error.code})`)); else resolve(message.result);
        }
      }
    });
  }
  send(method, params = {}, sessionId = undefined) {
    const id = (this.next += 1);
    return new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject }); this.out.write(`${JSON.stringify({ id, method, params, sessionId })}\0`); });
  }
  async attach(targetId) { return (await this.send("Target.attachToTarget", { targetId, flatten: true })).sessionId; }
  async evaluate(sessionId, expression) {
    const result = await this.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, sessionId);
    if (result.exceptionDetails) throw new Error(`page error: ${result.exceptionDetails.text}`);
    return result.result?.value;
  }
  async targets() { return (await this.send("Target.getTargets")).targetInfos; }
  async waitForTarget(predicate, label, timeoutMs = 20_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) { const found = (await this.targets()).find(predicate); if (found) return found; await sleep(150); }
    throw new Error(`timed out waiting for target ${label}`);
  }
}

const startedAt = new Date();
const run = join(PROJECT, ".e2e", `measure-${startedAt.toISOString().replace(/[:.]/gu, "-")}`);
mkdirSync(join(run, "profile"), { recursive: true });
const report = { profile: "chrome-execution-host-measurement-v0", recordedAt: startedAt.toISOString(), minutes: args.minutes, holdSeconds: args.hold, chrome: null, headed: true, timeline: [], workerStops: [], hosts: {}, passed: false, note: "Headed Chrome (not headless), fresh profile, window 480x360; the host tab is hidden behind an about:blank tab in the same window." };
const chrome = spawn(args.chrome, ["--remote-debugging-pipe", "--enable-unsafe-extension-debugging", `--user-data-dir=${join(run, "profile")}`, "--no-first-run", "--no-default-browser-check", "--window-size=480,360", "--window-position=40,40", "about:blank"], { stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"] });
const cdp = new Cdp(chrome);
const timeline = (what) => { report.timeline.push({ t: Math.round((Date.now() - startedAt.getTime()) / 1000), what }); process.stderr.write(`[${report.timeline.at(-1).t}s] ${what}\n`); };
try {
  report.chrome = (await cdp.send("Browser.getVersion")).product;
  const { id } = await cdp.send("Extensions.loadUnpacked", { path: EXTENSION });
  const base = `chrome-extension://${id}`;
  const isWorker = (t) => t.type === "service_worker" && t.url === `${base}/sw.js`;
  const workerTarget = await cdp.waitForTarget(isWorker, "the service worker");
  const worker = await cdp.attach(workerTarget.targetId);
  await cdp.evaluate(worker, `chrome.storage.local.set({ server: ${JSON.stringify(SERVER)} })`);
  timeline("extension loaded; server address stored; hosts being created");
  const offscreenTarget = await cdp.waitForTarget((t) => t.url.startsWith(`${base}/host.html?mode=offscreen`), "the offscreen document");
  const tabTarget = await cdp.waitForTarget((t) => t.url.startsWith(`${base}/host.html?mode=tab`), "the hidden tab");
  report.targets = { offscreen: { type: offscreenTarget.type }, tab: { type: tabTarget.type } };
  timeline(`offscreen target type=${offscreenTarget.type}; tab target type=${tabTarget.type}`);
  const blank = await cdp.waitForTarget((t) => t.type === "page" && t.url === "about:blank", "a page session");
  const pageSession = await cdp.attach(blank.targetId);
  await cdp.send("ServiceWorker.enable", {}, pageSession);

  const stopWorker = async (label) => {
    const before = (await cdp.targets()).some(isWorker);
    await cdp.send("ServiceWorker.stopAllWorkers", {}, pageSession);
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline && (await cdp.targets()).some(isWorker)) await sleep(200);
    const after = (await cdp.targets()).some(isWorker);
    report.workerStops.push({ at: Math.round((Date.now() - startedAt.getTime()) / 1000), label, workerAliveBefore: before, workerAliveAfter: after });
    timeline(`${label}: worker alive before=${before}, after stop=${after}`);
  };

  const total = args.minutes * 60;
  let elapsed = 0;
  const alive = async () => { const targets = await cdp.targets(); return { offscreen: targets.some((t) => t.url.startsWith(`${base}/host.html?mode=offscreen`)), tab: targets.some((t) => t.url.startsWith(`${base}/host.html?mode=tab`)), worker: targets.some(isWorker) }; };
  while (elapsed < total) {
    await sleep(60_000);
    elapsed += 60;
    const state = await alive();
    const summary = Object.fromEntries(["offscreen", "tab", "sw"].map((mode) => [mode, reports[mode] ? { ticks: reports[mode].ticks, maxGapMs: reports[mode].maxGapMs, gapsOver2s: reports[mode].gapsOver2s, pings: pings[mode]?.length ?? 0, hold: reports[mode].hold?.outcome ?? null, lastReportAgoS: Math.round((Date.now() - reports[mode].receivedAt) / 1000) } : null]));
    timeline(`minute ${elapsed / 60}: alive=${JSON.stringify(state)} ${JSON.stringify(summary)}`);
    if (elapsed === 180) await stopWorker("stop at minute 3");
    if (elapsed === 1200) await stopWorker("stop at minute 20");
  }
  const finalAlive = await alive();
  const gaps = (list) => { let max = 0; for (let i = 1; i < list.length; i += 1) max = Math.max(max, list[i] - list[i - 1]); return max; };
  for (const mode of ["offscreen", "tab", "sw"]) {
    const list = pings[mode] ?? [];
    report.hosts[mode] = {
      alive_at_end: mode === "sw" ? finalAlive.worker : finalAlive[mode],
      last_report: reports[mode] ? { ...reports[mode], visibility: reports[mode].visibility } : null,
      pings: { count: list.length, first_at_s: list.length ? Math.round((list[0] - startedAt.getTime()) / 1000) : null, last_at_s: list.length ? Math.round((list.at(-1) - startedAt.getTime()) / 1000) : null, max_gap_ms: gaps(list) },
    };
  }
  report.holds = holds.map((h) => ({ ...h, startedAtS: Math.round((h.startedAt - startedAt.getTime()) / 1000), answeredAfterS: h.answeredAt ? Math.round((h.answeredAt - h.startedAt) / 1000) : null, clientClosedAfterS: h.clientClosedAt ? Math.round((h.clientClosedAt - h.startedAt) / 1000) : null }));
  report.passed = true;
} catch (error) {
  report.error = error.message;
  timeline(`harness error: ${error.message}`);
} finally {
  const exited = chrome.exitCode !== null ? Promise.resolve() : new Promise((r) => chrome.once("exit", r));
  chrome.kill();
  await Promise.race([exited, sleep(10_000)]);
  server.close();
}
const text = `${JSON.stringify(report, null, 2)}\n`;
if (args.out) writeFileSync(args.out, text);
process.stdout.write(text);
if (!args.keep) rmSync(run, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
process.exit(report.passed ? 0 : 1);
