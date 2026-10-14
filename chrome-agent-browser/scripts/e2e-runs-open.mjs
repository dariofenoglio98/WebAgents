#!/usr/bin/env node
/**
 * T14 evidence in a real Chrome: on the full page's Runs view, Open shows the chosen run (D-160).
 *
 * The installed Chrome runs headless with `dist/extension` loaded over the DevTools pipe (D-037).
 * A local HTTPS origin answers for the WebAir deployment's hostname with the signed WebAir 0.5.0
 * package and its four operations (the recorded answers in `test/fixtures/webair-origin-answers.json`),
 * and a fake Ollama on a loopback port answers the package's three model tasks, as the extension's
 * tests script them. No real model and no public service is contacted.
 *
 * Setup goes through the extension's own messages (as a page would send them): the fake Ollama as
 * the default model, WebAir opened and its key trusted, the "search" profile authorized, then
 * `--runs` runs started one after the other and waited for. Then, at 1280 x 860:
 *   list    `#runs`, the list alone;
 *   opened  Open pressed on the oldest run (the last row): its heading must be in the viewport and
 *           focused, and the run shown before the list;
 *   again   scrolled to the bottom, Open pressed on the same run (no `hashchange`): shown again;
 *   unknown `#run=<an id no run has>`: the Runs view names `run_unknown`, the list stays.
 * Writes `runs-list-1280.png`, `runs-opened-1280.png` and a JSON with "passed" under
 * `examples/verification/chrome-runs-open/` (or `--out <directory>`).
 *
 *   npm run build && node scripts/e2e-runs-open.mjs [--chrome <path>] [--out <directory>] [--runs 12]
 */
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
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
const FILES = { "/agent.pkg": { path: join(ROOT, "dist", "webair-0.5.0.agent.pkg"), type: "application/vnd.webagents.agent-package" } };
const ANSWERS = join(PROJECT, "test", "fixtures", "webair-origin-answers.json");
const WEBAIR_FINGERPRINT_SOURCE = "the package's own signer, read from package.get";
const MODEL = "qwen3:30b";
const SIZE = { width: 1280, height: 860 };

const args = { chrome: process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", out: join(ROOT, "examples", "verification", "chrome-runs-open"), runs: 12 };
for (let index = 2; index < process.argv.length; index += 1) {
  const argument = process.argv[index];
  if (argument === "--chrome") args.chrome = process.argv[(index += 1)];
  else if (argument === "--out") args.out = resolve(process.argv[(index += 1)]);
  else if (argument === "--runs") args.runs = Number(process.argv[(index += 1)]);
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
  profile: "chrome-runs-open-v0",
  recordedAt: new Date().toISOString(),
  build: {
    commit: git("rev-parse", "HEAD"),
    tree_clean: git("status", "--porcelain", "--", "chrome-agent-browser") === "",
    extension: Object.fromEntries(["manifest.json", "browser.html", "browser.js", "styles.css"].map((name) => [name, sha256(readFileSync(join(EXTENSION, name)))])),
  },
  chrome: null,
  viewport: SIZE,
  served: Object.fromEntries(Object.entries(FILES).map(([path, file]) => [path, { source: relative(ROOT, file.path), sha256: sha256(readFileSync(file.path)) }])),
  trusted: WEBAIR_FINGERPRINT_SOURCE,
  runs: [],
  shots: {},
  checks: {},
  failures: [],
  passed: false,
};
const check = (name, condition, detail) => {
  report.checks[name] = condition ? "ok" : { failed: detail ?? null };
  if (!condition) report.failures.push(`${name}${detail === undefined ? "" : ` (${JSON.stringify(detail).slice(0, 400)})`}`);
};
const log = (text) => process.stderr.write(`${text}\n`);

/** WebAir's four operations, answered from the recorded origin answers (as the tests' `scriptedOrigin`). */
function webairApi() {
  const answers = JSON.parse(readFileSync(ANSWERS, "utf8"));
  return (method, path, body) => {
    if (method !== "POST") return null;
    const input = body ? JSON.parse(body) : {};
    if (path === "/api/v1/search_flights") return { status: 200, value: answers.search.output };
    if (path === "/api/v1/get_fare_rules") {
      const rules = answers.fare_rules[String(input.fare_id)];
      return rules ? { status: 200, value: rules } : { status: 404, value: { error: { code: "fare_not_found", message: "no such fare", details: [] } } };
    }
    if (path === "/api/v1/prepare_booking") return { status: 200, value: answers.prepare_booking.output };
    if (path === "/api/v1/simulate_purchase") return { status: 200, value: answers.simulate_purchase.output };
    return null;
  };
}

/** The package's three model tasks, answered as `test/helpers/host.ts::webairModelAnswers` answers them for a search. */
const TASKS = {
  interpret: () => ({ needs_travel_profile: false, search: { origin: "BOS", destination: "ZRH", date: "2026-10-09", passengers: 1, nonstop_only: true, max_price_usd: 900, cabin: null }, unsupported_reason: null }),
  select: (user) => {
    const fares = (user.search?.flights ?? []).flatMap((flight) => flight.fares.map((fare) => fare.fare_id));
    return fares.length === 0 ? { outcome: "no_matching_flights", fare_ids: [], selected_fare_id: null } : { outcome: "options_found", fare_ids: fares.slice(0, 6), selected_fare_id: fares[0] };
  },
  answer: (user) => {
    const fares = user.selection?.fare_ids ?? [];
    return { answer: fares.length > 0 ? `WebAir offers ${fares.length} fares from Boston to Zurich on 9 October.` : "WebAir returned no matching flights.", mentioned_fare_ids: fares.slice(0, 24) };
  },
};

/** A fake Ollama on 127.0.0.1: `/api/tags`, `/api/show` and `/api/chat`, with the CORS answers an extension origin needs. */
function fakeOllama() {
  const calls = [];
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      const headers = { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "GET, POST, OPTIONS" };
      if (request.method === "OPTIONS") return response.writeHead(204, headers).end();
      const json = (status, value) => response.writeHead(status, { ...headers, "content-type": "application/json" }).end(JSON.stringify(value));
      calls.push(`${request.method} ${request.url}`);
      if (request.url === "/api/tags") return json(200, { models: [{ name: MODEL, model: MODEL }] });
      if (request.url === "/api/show") return json(200, { capabilities: ["completion", "tools", "thinking"], model_info: { "qwen3moe.context_length": 262144 } });
      if (request.url === "/api/chat") {
        const parsed = JSON.parse(body || "{}");
        const system = parsed.messages?.find((message) => message.role === "system")?.content ?? "";
        const user = JSON.parse(parsed.messages?.find((message) => message.role === "user")?.content ?? "null");
        const task = /^## Task\n(.+)$/mu.exec(system)?.[1] ?? "";
        if (!TASKS[task]) return json(500, { error: `no scripted answer for task ${task}` });
        const content = JSON.stringify(TASKS[task](user ?? {}));
        return json(200, { model: MODEL, message: { role: "assistant", content }, done: true, done_reason: "stop", prompt_eval_count: Math.ceil(system.length / 4), eval_count: Math.ceil(content.length / 4) });
      }
      return json(404, { error: "not found" });
    });
  });
  return new Promise((resolveServer) => server.listen(0, "127.0.0.1", () => resolveServer({ server, port: server.address().port, calls })));
}

/** Read in the page: where the opened run is, whether its heading is visible and focused, the order of run and list. */
const MEASURE = String.raw`(() => {
  const run = document.querySelector("#app .ab-run");
  const heading = run ? run.querySelector(".ab-run-title h2") : null;
  const list = document.querySelector("#app .ab-run-list");
  const listCard = list ? list.closest(".ab-card") : null;
  const rect = heading ? heading.getBoundingClientRect() : null;
  const error = document.querySelector("#app .ab-error");
  return {
    hash: location.hash,
    scrollY: Math.round(scrollY),
    pageHeight: document.documentElement.scrollHeight,
    innerHeight,
    rows: document.querySelectorAll("#app .ab-runs-list .ab-run-row, #app > * > .ab-run-list > li, #app .ab-card > .ab-run-list > li").length,
    runState: run ? run.dataset.state : null,
    runId: run ? run.dataset.runId ?? null : null,
    heading: rect ? { text: heading.textContent, top: Math.round(rect.top), bottom: Math.round(rect.bottom) } : null,
    headingInViewport: rect ? rect.top >= 0 && rect.bottom <= innerHeight : false,
    headingFocused: heading !== null && document.activeElement === heading,
    runBeforeList: run && listCard ? Boolean(run.compareDocumentPosition(listCard) & Node.DOCUMENT_POSITION_FOLLOWING) : null,
    error: error ? error.textContent.trim() : null,
  };
})()`;

async function main() {
  const scratch = mkdtempSync(join(realpathSync(tmpdir()), "chrome-runs-open-"));
  let chrome = null;
  let served = null;
  let ollama = null;
  try {
    const tls = certificate(scratch, HOST);
    served = await serveFiles(tls, FILES, webairApi());
    ollama = await fakeOllama();
    chrome = spawn(args.chrome, ["--headless=new", "--remote-debugging-pipe", "--enable-unsafe-extension-debugging", `--user-data-dir=${join(scratch, "profile")}`, "--no-first-run", "--no-default-browser-check", "--hide-scrollbars", `--host-resolver-rules=MAP ${HOST} 127.0.0.1:${served.port}`, `--ignore-certificate-errors-spki-list=${tls.spkiHash}`, "about:blank"], { stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"] });
    const cdp = new Cdp(chrome);
    report.chrome = (await cdp.send("Browser.getVersion")).product;
    // A pre-granted copy of the build (D-196): the origins this harness drives, as the person would have allowed them.
    const granted = grantedBuild(EXTENSION, scratch, [ORIGIN]);
    report.granted_origins = granted.granted;
    const { id: extensionId } = await cdp.send("Extensions.loadUnpacked", { path: granted.path });
    const base = `chrome-extension://${extensionId}`;
    await cdp.waitForTarget((target) => target.type === "service_worker" && target.url === `${base}/service-worker.js`, "the service worker");

    const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
    const page = await cdp.attach(targetId);
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: SIZE.width, height: SIZE.height, deviceScaleFactor: 1, mobile: false }, page);
    await cdp.send("Page.enable", {}, page);
    await cdp.send("Page.navigate", { url: `${base}/browser.html#open` }, page);
    await cdp.waitFor(page, `typeof chrome !== "undefined" && !!chrome.runtime && document.getElementById("app") !== null`, "the full page");
    const send = async (request) => {
      const reply = await cdp.evaluate(page, `chrome.runtime.sendMessage(${JSON.stringify(request)})`);
      if (!reply?.ok) throw new Error(`${request.type}: ${reply?.error?.code}: ${reply?.error?.message}`);
      return reply.result;
    };

    // Setup through the extension's own messages: the fake Ollama as the default model, WebAir trusted and authorized.
    const settings = (await send({ type: "settings.get" })).settings;
    settings.models.default_model = `ollama/${MODEL}`;
    settings.models.connections = settings.models.connections.map((connection) => (connection.provider === "ollama" ? { ...connection, enabled: true, base_url: `http://127.0.0.1:${ollama.port}` } : connection));
    await send({ type: "settings.set", settings });
    const probe = await send({ type: "models.probe", provider: "ollama" });
    check("the fake Ollama answers the catalog probe", probe.ok === true && probe.models.some((model) => model.id === `ollama/${MODEL}`), probe.error);
    const opened = await send({ type: "package.open", url: `${ORIGIN}/agent.pkg`, viewId: "e2e-runs-open" });
    const sessionId = opened.session.id;
    check("WebAir 0.5.0 opened, signature valid", opened.page.identity.version === "0.5.0" && opened.page.trust.signature_status === "valid", opened.page.identity);
    await send({ type: "trust.pin", sessionId, signerFingerprint: opened.page.trust.signer_fingerprint ?? opened.page.technical.signer_fingerprint, scope: "publisher" });
    const authorized = await send({ type: "authorization.useProfile", sessionId, packageDigest: opened.page.technical.digest, profileId: "search", resourceSelections: {}, prepare: true });
    const plan = authorized.run_plan?.run_plan;
    check("the search profile gives a run plan", Boolean(plan), authorized.plan_refused ?? null);

    for (let index = 1; index <= args.runs; index += 1) {
      const started = await send({ type: "run.start", sessionId, runPlanId: plan.run_plan_id, runPlanSha256: plan.run_plan_sha256, input: { request: `Find me a nonstop flight from Boston to Zurich on 9 October under $900 (run ${index} of ${args.runs}).`, booking: false, purchase: { quote_id: "", fare_id: "" } } });
      const status = await cdp.waitFor(page, `chrome.runtime.sendMessage({ type: "run.get", runId: ${JSON.stringify(started.runId)} }).then((r) => r.ok && r.result && ["completed", "failed", "cancelled", "interrupted"].includes(r.result.status) ? r.result.status : null)`, `run ${index} to settle`, 60_000, 250);
      report.runs.push({ runId: started.runId, status });
      log(`run ${index}: ${started.runId} ${status}`);
    }
    check(`${args.runs} runs, all completed`, report.runs.length === args.runs && report.runs.every((run) => run.status === "completed"), report.runs);
    const oldest = report.runs[0].runId;

    // A fresh page on the Runs view, as a person opens it.
    await cdp.send("Page.navigate", { url: `${base}/browser.html#runs` }, page);
    await cdp.waitFor(page, `document.querySelectorAll("#app .ab-run-list li[data-run]").length >= ${args.runs}`, "the run list");
    await sleep(300);
    const list = await cdp.evaluate(page, MEASURE);
    const rows = await cdp.evaluate(page, `document.querySelectorAll("#app .ab-run-list li[data-run]").length`);
    report.shots.list = { file: "runs-list-1280.png", rows, ...list };
    mkdirSync(args.out, { recursive: true });
    writeFileSync(join(args.out, "runs-list-1280.png"), Buffer.from((await cdp.send("Page.captureScreenshot", { format: "png" }, page)).data, "base64"));
    check(`the Runs view lists at least 10 runs (${rows})`, rows >= 10 && rows >= args.runs, rows);
    check("the list alone: no run shown before Open", list.runState === null, list);

    // Open on the oldest run: the last row, below the fold.
    const pressOpen = `(() => { const row = document.querySelector('#app .ab-card .ab-run-list li[data-run=${JSON.stringify(oldest)}]'); const button = row && [...row.querySelectorAll("button")].find((b) => b.textContent.trim() === "Open"); if (!button) return false; button.scrollIntoView({ block: "center" }); button.click(); return true; })()`;
    check("the oldest run's row has an Open button", await cdp.evaluate(page, pressOpen));
    await cdp.waitFor(page, `(() => { const run = document.querySelector("#app .ab-run"); return run && run.dataset.state === "completed"; })()`, "the opened run");
    await sleep(600);
    const shown = await cdp.evaluate(page, MEASURE);
    report.shots.opened = { file: "runs-opened-1280.png", ...shown };
    writeFileSync(join(args.out, "runs-opened-1280.png"), Buffer.from((await cdp.send("Page.captureScreenshot", { format: "png" }, page)).data, "base64"));
    check("Open: the address names the run", shown.hash === `#run=${encodeURIComponent(oldest)}`, shown.hash);
    check("Open: the run's heading is inside the viewport", shown.headingInViewport, shown.heading);
    check("Open: the run's heading has the focus", shown.headingFocused, shown);
    check("Open: the run is shown before the list", shown.runBeforeList === true, shown.runBeforeList);

    // Open again on the same run from the bottom of the page: no hashchange, and it is shown again.
    await cdp.evaluate(page, `(() => { document.activeElement?.blur(); scrollTo(0, document.documentElement.scrollHeight); return true; })()`);
    await sleep(300);
    const away = await cdp.evaluate(page, MEASURE);
    check("before the second Open the heading is out of view", !away.headingInViewport, away.heading);
    await cdp.evaluate(page, pressOpen);
    await sleep(600);
    const again = await cdp.evaluate(page, MEASURE);
    report.shots.again = again;
    check("Open on the run already shown: the heading is back in view", again.headingInViewport, again.heading);
    check("Open on the run already shown: the heading has the focus", again.headingFocused, again);

    // An id no run has: the error is on the Runs view, the list stays.
    await cdp.evaluate(page, `(() => { location.hash = "run=run_does_not_exist"; return true; })()`);
    await cdp.waitFor(page, `(() => { const box = document.querySelector("#app .ab-error"); return box ? box.textContent : null; })()`, "the open error on the Runs view", 10_000).catch(() => null);
    const unknown = await cdp.evaluate(page, MEASURE);
    const listed = await cdp.evaluate(page, `document.querySelectorAll("#app .ab-run-list li[data-run]").length`);
    report.shots.unknown = { ...unknown, rows: listed };
    check("an unknown run id: the Runs view shows run_unknown", typeof unknown.error === "string" && unknown.error.includes("run_unknown"), unknown.error);
    check("an unknown run id: the list stays", listed >= args.runs, listed);
    report.origin = { requests: served.hits.length, ollama: ollama.calls.length };
  } catch (error) {
    report.failures.push(`harness: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    if (chrome) chrome.kill("SIGTERM");
    if (served) served.server.close();
    if (ollama) ollama.server.close();
    await sleep(200);
    rmSync(scratch, { recursive: true, force: true });
  }
  report.passed = report.failures.length === 0 && report.runs.length >= 10;
  mkdirSync(args.out, { recursive: true });
  const text = `${JSON.stringify(report, null, 2)}\n`;
  writeFileSync(join(args.out, "chrome-runs-open.json"), text);
  process.stdout.write(text);
  process.exit(report.passed ? 0 : 1);
}

main();
