#!/usr/bin/env node
/**
 * WebAir live acceptance in Chrome (T5, Demo 3; D-028): the built extension in a real headless
 * Chrome against the **public** WebAir origin, driving the full page over the DevTools pipe the
 * way a person drives it:
 *
 *   discovery on the public origin → Inspect → Trust (two presses) →
 *   "Search flights" → Use this agent → Run (reload the page meanwhile: the run surface adopts
 *   the running run) → a second search cancelled within a wave →
 *   "Search and quote" + the demo passenger → Run (the quote) →
 *   "Book (simulated)" + the demo payment method, purchase `once` → Run →
 *   the same authorization again: Run is disabled by the page and refused by the worker →
 *   "Search and quote" again with the purchase input: denied (permission_denied), nothing sent.
 *
 * Setup that is not a person's gesture goes through the extension's own messages from its page
 * (the default model, a hosted key from the environment, the fictional demo records, test mode).
 * Every run is exported as the run directory (run.json, run-plan.json, input.json, the artifacts)
 * plus observations.json (the request bodies recorded in test mode) under `--out-dir`, and the
 * report JSON names them by repository-relative path. `scripts/verify_chrome_webair_live.py`
 * recomputes the checks over those files. Nothing here decides a check; it records.
 *
 *   node scripts/e2e-webair-live.mjs --model ollama/qwen3:30b [--site URL] [--out report.json]
 *        [--version 0.5.0]   (the WebAir version the origin must serve; the default report is
 *                             examples/verification/chrome-webair-<050>-live.json, T9. From 0.8.0
 *                             (T24, conversation.v0) the phases are conversations in the chat
 *                             surface: see `conversationPhases` below)
 *        [--package PATH]    (with --local-origin: the archive the local origin publishes instead of
 *                             dist/webair-<version>.agent.pkg, for a rehearsal of a build not yet signed)
 *        [--out-dir examples/my-chrome-live-<ts>] [--chrome path] [--keep] [--phases all|search,cancel,quote,purchase,denial]
 *        [--local-origin]    (T22: before a version is deployed, run this repository's WebAir origin on
 *                             127.0.0.1 over TLS, publishing dist/webair-<version>.agent.pkg, and map the
 *                             public hostname to it: a throwaway certificate whose key alone Chrome trusts,
 *                             as the search harness does. WebAir's API calls reach the same local origin, so
 *                             only the model is outside; the report is chrome-webair-<v>-local-live.json)
 *   A hosted model needs OPENAI_API_KEY or ANTHROPIC_API_KEY in the environment; the key is typed
 *   into the extension's storage for this throwaway profile and never written anywhere by this script.
 */
import { spawn } from "node:child_process";
import { request as httpsRequest } from "node:https";
import { createServer as createNetServer } from "node:net";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { Cdp, sleep } from "./lib/cdp.mjs";
import { grantedBuild } from "./lib/granted-build.mjs";
import { certificate } from "./lib/origin.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const PROJECT = resolve(here, "..");
const ROOT = resolve(PROJECT, "..");
const EXTENSION = join(PROJECT, "dist", "extension");
const DEFAULT_CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const DEFAULT_SITE = "https://webagents-webair-production.up.railway.app/";
const RUN_TIMEOUT_MS = 20 * 60 * 1000;

const args = { chrome: process.env.CHROME_PATH || DEFAULT_CHROME, site: DEFAULT_SITE, model: null, version: "0.5.0", out: null, outDir: null, keep: false, localOrigin: false, package: null, phases: ["search", "cancel", "quote", "purchase", "denial"] };
/** WebAir 0.8.0 (T24, conversation.v0) is talked to: one message per turn, the card before the purchase. */
const conversational = (version) => Number(version.split(".")[1] ?? "0") >= 8;
/** The memory phase (T19, Demo 6) needs WebAir 0.6.0 (memory.v0): it is on by default from that version. */
const memoryCapable = (version) => Number(version.split(".")[1] ?? "0") >= 6;
for (let index = 2; index < process.argv.length; index += 1) {
  const argument = process.argv[index];
  if (argument === "--chrome") args.chrome = process.argv[(index += 1)];
  else if (argument === "--site") args.site = process.argv[(index += 1)];
  else if (argument === "--model") args.model = process.argv[(index += 1)];
  else if (argument === "--version") args.version = process.argv[(index += 1)];
  else if (argument === "--out") args.out = resolve(process.argv[(index += 1)]);
  else if (argument === "--out-dir") args.outDir = resolve(process.argv[(index += 1)]);
  else if (argument === "--keep") args.keep = true;
  else if (argument === "--local-origin") args.localOrigin = true;
  else if (argument === "--package") args.package = resolve(process.argv[(index += 1)]);
  else if (argument === "--phases") args.phases = process.argv[(index += 1)] === "all" ? [...args.phases, "memory"] : process.argv[index].split(",");
  else {
    console.error(`unknown argument ${argument}`);
    process.exit(2);
  }
}
// Each version's evidence has its own report; the committed 0.4.0 one is never overwritten by a 0.5.0 run.
if (args.out === null) args.out = join(ROOT, "examples", "verification", `chrome-webair-${args.version.replaceAll(".", "")}${args.localOrigin ? "-local" : ""}-live.json`);
if (memoryCapable(args.version) && !args.phases.includes("memory") && process.argv.every((argument) => argument !== "--phases")) args.phases.push("memory");
if (!args.model || !args.model.includes("/")) {
  console.error("--model provider/model is required (ollama/qwen3:30b, openai/<id>, anthropic/<id>)");
  process.exit(2);
}
if (!existsSync(join(EXTENSION, "manifest.json"))) {
  console.error("dist/extension/manifest.json is missing; run `npm run build` first");
  process.exit(2);
}
if (!new URL(args.site).protocol.startsWith("https")) {
  console.error("--site must be https");
  process.exit(2);
}
const provider = args.model.split("/")[0];
const keyEnv = provider === "openai" ? "OPENAI_API_KEY" : provider === "anthropic" ? "ANTHROPIC_API_KEY" : null;
if (keyEnv && !process.env[keyEnv]) {
  console.error(`${keyEnv} must be set for ${args.model}`);
  process.exit(2);
}
const startedAt = new Date();
const stamp = startedAt.toISOString().replace(/[:.]/gu, "-");
const outDir = args.outDir ?? join(ROOT, "examples", `my-chrome-live-${stamp}`);
mkdirSync(outDir, { recursive: true });

const SEARCH_REQUEST = "Find me a nonstop flight from Boston to Zurich on 9 October under $900.";
const BOOKING_REQUEST = "Search nonstop flights from Boston to Zurich on 9 October and prepare a booking quote for the WA101 Economy Standard fare for me.";
/** The memory phase asks for something the demo profile (BOS, economy, nonstop) lacks, so the package has a preference to propose (B-216). */
const MEMORY_REQUEST = "Book me a business class flight from Boston to Zurich on 9 October. I always fly business on this route; prepare a booking quote for the WA101 business fare.";
const PASSPHRASE = "a throwaway passphrase for the live harness";
/** The demo set's stable memory ids (T19, `demoRecordId`): `mem_` + the first 32 hex characters of SHA-256("demo:<0.1.0 resource id>"). */
const demoRecordId = (resourceId) => `mem_${createHash("sha256").update(`demo:${resourceId}`).digest("hex").slice(0, 32)}`;
/** WebAir 0.6.0 reads the travel profile through `memory.travel_profile` (memory.read); 0.5.0 through the legacy `profile.travel` (B-217). */
const PROFILE_PERMISSION = memoryCapable(args.version) ? "memory.travel_profile" : "profile.travel";
const PROFILE_ID = demoRecordId("profile_demo_traveler");
const PICKS = { [PROFILE_PERMISSION]: PROFILE_ID, "identity.passenger": demoRecordId("passenger_demo_alex"), "wallet.payment": demoRecordId("payment_demo_visa") };

/** Page-side helpers for the extension's pages: controls by label, the native value setter, run state. */
const HELPERS = String.raw`
window.__ab = {
  click(label, scope) {
    const button = [...(scope || document).querySelectorAll("button")].find((b) => b.textContent.trim() === label && !b.disabled);
    if (!button) return false;
    button.click();
    return true;
  },
  setInput(selector, value) {
    const node = document.querySelector(selector);
    if (!node) return false;
    const proto = node instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value").set.call(node, value);
    node.dispatchEvent(new Event("input", { bubbles: true }));
    return true;
  },
  setChecked(selector, checked) {
    const node = document.querySelector(selector);
    if (!node) return false;
    if (node.checked !== checked) node.click();
    return node.checked === checked;
  },
  setSelect(selector, value) {
    const node = document.querySelector(selector);
    if (!node || ![...node.options].some((o) => o.value === value)) return false;
    node.value = value;
    node.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  },
  text(selector, scope) { const node = (scope || document).querySelector(selector); return node ? node.textContent.trim() : null; },
  runState() { const node = document.querySelector(".ab-run"); return node ? node.dataset.state : null; },
  runButton() { const node = document.querySelector(".ab-run-button"); return node ? { disabled: node.disabled, label: node.textContent, reason: document.querySelector(".ab-run-reason")?.textContent ?? null } : null; },
  checklist() { return [...document.querySelectorAll(".ab-checklist li")].map((li) => ({ id: li.dataset.check, ok: li.classList.contains("ab-check-ok"), text: li.textContent.trim().slice(0, 200) })); },
  session() { return document.querySelector("article.ab-agent")?.dataset.session ?? null; },
  trust() { return document.querySelector("article.ab-agent")?.dataset.trust ?? null; },
  planBanner() { const n = document.querySelector(".ab-authorize .ab-banner strong"); return n ? n.textContent : null; },
  /** T19: pick a memory record on its recall card (a radio, the pre-selected card, or the legacy select). */
  pick(permission, recordId) {
    const radio = document.querySelector('input[name="resource-' + permission + '"][value="' + recordId + '"]');
    if (radio) { radio.click(); return "radio"; }
    const card = document.querySelector('.ab-recall-propose[data-permission="' + permission + '"]');
    if (card && card.dataset.record === recordId) return "preselected";
    if (card) { const change = [...card.querySelectorAll("button")].find((b) => b.textContent.trim() === "Change…"); if (change) { change.click(); return "opened"; } }
    const select = document.querySelector('select[name="resource-' + permission + '"]');
    if (select && [...select.options].some((o) => o.value === recordId)) { select.value = recordId; select.dispatchEvent(new Event("change", { bubbles: true })); return "select"; }
    return null;
  },
  review() { const sheet = document.querySelector(".ab-review"); return sheet ? { title: sheet.querySelector("h3")?.textContent ?? null, cards: sheet.querySelectorAll(".ab-review-card").length, done: sheet.classList.contains("ab-review-done") } : null; },
  async send(request) { const reply = await chrome.runtime.sendMessage(request); return reply; },
};
true;
`;

const report = {
  // Named after the package version, as the report file is (T9 review 1, nit 8).
  profile: `chrome-webair-${args.version.replaceAll(".", "")}-live-v0`,
  recordedAt: startedAt.toISOString(),
  packageVersion: args.version,
  site: args.site,
  model: args.model,
  extension: relative(ROOT, EXTENSION),
  chrome: null,
  outputDirectory: relative(ROOT, outDir),
  steps: {},
  runs: {},
  failures: [],
  passed: false,
};
const check = (step, name, condition, detail) => {
  report.steps[step] ??= {};
  report.steps[step][name] = condition ? "ok" : { failed: detail ?? null };
  if (!condition) report.failures.push(`${step}: ${name}${detail === undefined ? "" : ` (${JSON.stringify(detail).slice(0, 300)})`}`);
};
const log = (text) => process.stderr.write(`[${Math.round((Date.now() - startedAt.getTime()) / 1000)}s] ${text}\n`);

/** A free TCP port on 127.0.0.1 for the local origin. */
function freePort() {
  return new Promise((resolvePort, reject) => {
    const server = createNetServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolvePort(port));
    });
  });
}

/**
 * This repository's WebAir origin on 127.0.0.1 over TLS (`--local-origin`), publishing the signed
 * `dist/webair-<version>.agent.pkg`: started through uvicorn with the throwaway certificate, from the
 * origin's own `create_app`; its `/health` is waited for before Chrome starts.
 */
async function startLocalOrigin(directory) {
  const host = new URL(args.site).hostname;
  const tls = certificate(directory, host);
  const port = await freePort();
  const pkg = args.package ?? join(ROOT, "dist", `webair-${args.version}.agent.pkg`);
  if (!existsSync(pkg)) throw new Error(`${relative(ROOT, pkg)} is missing`);
  const script = "import sys, uvicorn\nfrom origin.app import create_app\nuvicorn.run(create_app(sys.argv[1], None), host='127.0.0.1', port=int(sys.argv[2]), ssl_keyfile=sys.argv[3], ssl_certfile=sys.argv[4], log_level='warning', server_header=False)";
  const child = spawn(join(ROOT, "demo", "webair", ".venv", "bin", "python"), ["-c", script, pkg, String(port), join(directory, "key.pem"), join(directory, "cert.pem")], { cwd: join(ROOT, "demo", "webair"), stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (chunk) => (stderr += chunk.toString("utf8")));
  const health = () =>
    new Promise((resolveHealth) => {
      const request = httpsRequest({ host: "127.0.0.1", port, path: "/health", servername: host, rejectUnauthorized: false, timeout: 2000 }, (response) => {
        let body = "";
        response.on("data", (chunk) => (body += chunk));
        response.on("end", () => resolveHealth(response.statusCode === 200 ? JSON.parse(body) : null));
      });
      request.on("error", () => resolveHealth(null));
      request.on("timeout", () => request.destroy());
      request.end();
    });
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`the local origin exited: ${stderr.trim().split("\n").pop()}`);
    const answer = await health();
    if (answer) return { child, host, port, spkiHash: tls.spkiHash, health: answer, package: relative(ROOT, pkg) };
    await sleep(200);
  }
  child.kill();
  throw new Error("the local origin did not answer /health");
}

async function main() {
  const profile = mkdtempSync(join(tmpdir(), "chrome-agent-browser-live-"));
  const origin = args.localOrigin ? await startLocalOrigin(mkdtempSync(join(tmpdir(), "chrome-agent-browser-origin-"))) : null;
  if (origin) {
    report.localOrigin = { package: origin.package, health: origin.health, note: "this repository's origin on 127.0.0.1 over TLS, the public hostname mapped to it (--local-origin)" };
    log(`local origin on 127.0.0.1:${origin.port} publishing ${origin.package} (${origin.health.agent_package_sha256 ?? "?"})`);
  }
  const mapping = origin ? [`--host-resolver-rules=MAP ${origin.host} 127.0.0.1:${origin.port}`, `--ignore-certificate-errors-spki-list=${origin.spkiHash}`] : [];
  const chrome = spawn(args.chrome, ["--headless=new", "--remote-debugging-pipe", "--enable-unsafe-extension-debugging", `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check", "--window-size=1280,2200", ...mapping, "about:blank"], { stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"] });
  const cdp = new Cdp(chrome);
  /** The conversation a chat phase is on, and its export, reachable from the abort path below. */
  let current = null;
  let exportCurrent = async () => undefined;
  try {
    report.chrome = (await cdp.send("Browser.getVersion")).product;
    // A pre-granted copy of the build (D-196): the origins this harness drives, as the person would have allowed them.
    const granted = grantedBuild(EXTENSION, profile, [new URL(DEFAULT_SITE).origin, "https://api.openai.com", "https://api.anthropic.com"]);
    report.granted_origins = granted.granted;
    const { id: extensionId } = await cdp.send("Extensions.loadUnpacked", { path: granted.path });
    report.extensionId = extensionId;
    const base = `chrome-extension://${extensionId}`;
    await cdp.waitForTarget((target) => target.type === "service_worker" && target.url === `${base}/service-worker.js`, "the service worker");
    const { targetId } = await cdp.send("Target.createTarget", { url: `${base}/browser.html` });
    const page = await cdp.attach(targetId);
    const ready = async () => {
      await cdp.waitFor(page, `document.querySelector('input[name="package-url"]') !== null || document.querySelector("article.ab-agent") !== null`, "the full page");
      await cdp.evaluate(page, HELPERS);
    };
    await ready();
    const send = async (request) => {
      const reply = await cdp.evaluate(page, `__ab.send(${JSON.stringify(request)})`);
      if (!reply) throw new Error(`no reply to ${request.type}`);
      if (!reply.ok) throw new Error(`${request.type}: ${reply.error.code}: ${reply.error.message}`);
      return reply.result;
    };

    /** A screenshot of the page under `<out-dir>/screens/`, for the demo record; never part of the report's checks. */
    const shot = async (name) => {
      try {
        const { data } = await cdp.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true }, page);
        mkdirSync(join(outDir, "screens"), { recursive: true });
        writeFileSync(join(outDir, "screens", `${name}.png`), Buffer.from(data, "base64"));
      } catch {
        // cosmetic
      }
    };
    // 0. Setup through the extension's own messages: test mode, the model, the fictional demo records.
    const settingsView = await send({ type: "settings.get" });
    const settings = settingsView.settings;
    settings.developer = { record_requests: true };
    settings.models.default_model = args.model;
    settings.models.connections = settings.models.connections.map((connection) => (connection.provider === provider ? { ...connection, enabled: true } : connection));
    await send({ type: "settings.set", settings });
    // The secret store needs a passphrase before a key or the memory is accepted (T16/T19, B-217): a throwaway one for this profile.
    await send({ type: "secrets.setup", passphrase: PASSPHRASE });
    if (keyEnv) await send({ type: "settings.setKey", provider, key: process.env[keyEnv] });
    const probe = await send({ type: "models.probe", provider });
    report.steps.setup = { probe: { ok: probe.ok, models: probe.models.length, error: probe.error, diagnosis: probe.diagnosis ?? null }, testMode: true, keyFromEnvironment: keyEnv };
    check("setup", `the ${provider} connection answers`, probe.ok === true, probe.error);
    check("setup", "the model is offered", probe.models.some((model) => model.id === args.model), probe.models.map((model) => model.id));
    await send({ type: "memory.installDemo" });
    const status = await send({ type: "status.get" });
    check("setup", "execution is enabled", status.execution === "enabled", status.execution);
    report.steps.setup.executionLimits = status.execution_limits;

    // 1. Discovery on the public origin → Inspect → trust.
    await cdp.evaluate(page, `__ab.setInput('input[name="package-url"]', ${JSON.stringify(args.site)}) && __ab.click("Open", document.querySelector("form.ab-address"))`);
    const candidate = await cdp.waitFor(page, `__ab.text(".ab-candidate code")`, "the website card", 60_000);
    report.steps.discovery = { candidate };
    check("discovery", "the public origin advertises the package", typeof candidate === "string" && candidate.startsWith(new URL(args.site).origin), candidate);
    await cdp.evaluate(page, `__ab.click("Inspect agent package")`);
    const sessionId = await cdp.waitFor(page, `__ab.session()`, "the agent page", 60_000);
    const inspected = await send({ type: "package.get", sessionId });
    report.steps.inspect = { sessionId, name: inspected.page.identity.name, version: inspected.page.identity.version, digest: inspected.page.technical.digest, archiveSha256: inspected.page.technical.archive_sha256, trust: inspected.page.trust.trust_status, signature: inspected.page.trust.signature_status };
    check("inspect", `WebAir ${args.version}, signed`, inspected.page.identity.version === args.version && inspected.page.trust.signature_status === "valid", report.steps.inspect);
    check("inspect", "publisher unknown before trust", inspected.page.trust.trust_status === "unknown", inspected.page.trust.trust_status);
    await cdp.waitFor(page, `__ab.click("Trust this publisher key", document.querySelector(".ab-pin"))`, "the trust control");
    await cdp.evaluate(page, `__ab.click("Press again to trust this key", document.querySelector(".ab-pin"))`);
    await cdp.waitFor(page, `__ab.trust() === "trusted"`, "the trusted agent page");
    report.steps.trust = { trust: await cdp.evaluate(page, `__ab.trust()`) };
    check("trust", "two presses trust the key", report.steps.trust.trust === "trusted");
    await shot("1-trusted");

    // -- helpers over the UI ----------------------------------------------------------------
    const authorize = async (profileId, picks) => {
      await cdp.waitFor(page, `document.querySelector('button[data-profile="${profileId}"]') !== null`, `the ${profileId} card`, 30_000);
      await cdp.evaluate(page, `document.querySelector('button[data-profile="${profileId}"]').click(); true`);
      await sleep(200);
      for (const [permission, resourceId] of Object.entries(picks)) {
        // The recall card (T19, M-52): a radio under privacy first or for a sealed type, the pre-selected card under balanced, the legacy select otherwise.
        let how = await cdp.evaluate(page, `__ab.pick(${JSON.stringify(permission)}, ${JSON.stringify(resourceId)})`);
        if (how === "opened") {
          await sleep(150);
          how = await cdp.evaluate(page, `__ab.pick(${JSON.stringify(permission)}, ${JSON.stringify(resourceId)})`);
        }
        if (how === null) throw new Error(`no picker for ${permission}`);
        report.steps.picks ??= {};
        report.steps.picks[`${profileId}:${permission}`] = how;
      }
      const previous = (await send({ type: "authorization.get", sessionId })).receipt?.receipt_id ?? null;
      await cdp.evaluate(page, `__ab.click("Use this agent")`);
      // A new receipt supersedes the old plan: wait for the receipt to change and its plan to exist, not for a banner the previous plan may still show.
      let authorization;
      try {
        authorization = await cdp.waitFor(page, `__ab.send({ type: "authorization.get", sessionId: ${JSON.stringify(sessionId)} }).then((r) => r.ok && r.result.receipt && r.result.receipt.receipt_id !== ${JSON.stringify(previous)} && r.result.run_plan ? r.result : null)`, `a new receipt and plan after ${profileId}`, 120_000, 500);
      } catch (error) {
        // Say why no plan came (T5a): the receipt, the readiness blocker and the page's own notice, not a bare `null`.
        throw new Error(`${error.message}; ${await whyNoPlan(previous)}`);
      }
      const banner = await cdp.waitFor(page, `__ab.planBanner()`, "the plan banner", 30_000);
      return { banner, receiptId: authorization.receipt?.receipt_id ?? null, runPlanId: authorization.run_plan?.run_plan.run_plan_id ?? null, runPlanSha256: authorization.run_plan?.run_plan.run_plan_sha256 ?? null, ready: authorization.run_plan?.preflight.ready ?? false, decisions: authorization.receipt?.decisions ?? null, grants: (authorization.receipt?.resource_grants ?? []).map((grant) => grant.resource_id) };
    };
    /** The last authorization and readiness facts, for a failure that would otherwise say only that nothing came. */
    const whyNoPlan = async (previousReceiptId) => {
      const parts = [];
      try {
        const view = await send({ type: "authorization.get", sessionId });
        const receiptId = view.receipt?.receipt_id ?? null;
        parts.push(receiptId === null ? "no receipt" : receiptId === previousReceiptId ? `receipt unchanged (${receiptId})` : `receipt ${receiptId}`);
        parts.push(view.run_plan ? `plan ${view.run_plan.run_plan.run_plan_id}` : "no run plan");
        const blocking = view.request?.blocking_reasons?.[0];
        if (blocking) parts.push(`authorization blocker ${blocking.code}: ${blocking.message}`);
      } catch (error) {
        parts.push(`authorization.get failed: ${error.message}`);
      }
      try {
        const readiness = await send({ type: "run.readiness", sessionId });
        if (readiness.blocker) parts.push(`readiness blocker ${readiness.blocker.code}: ${readiness.blocker.message}`);
      } catch (error) {
        parts.push(`run.readiness failed: ${error.message}`);
      }
      try {
        const notice = await cdp.evaluate(page, `(() => { const n = document.querySelector(".ab-authorize .ab-banner[role=status] span"); return n ? n.textContent : null; })()`);
        if (notice) parts.push(`page notice: ${notice}`);
      } catch {
        // The page itself may be the problem; the facts above stand.
      }
      return parts.join("; ");
    };
    const fillTask = async (task) => {
      await cdp.waitFor(page, `document.querySelector("textarea#ab-field-request") !== null`, "the task form", 30_000);
      await cdp.evaluate(page, `__ab.setInput("textarea#ab-field-request", ${JSON.stringify(task.request)})`);
      await cdp.evaluate(page, `__ab.setChecked("input#ab-field-booking", ${task.booking ? "true" : "false"})`);
      await cdp.evaluate(page, `__ab.setInput('input[aria-label="Simulate purchase of a quote Quote id"]', ${JSON.stringify(task.purchase.quote_id)})`);
      await cdp.evaluate(page, `__ab.setInput('input[aria-label="Simulate purchase of a quote Fare id"]', ${JSON.stringify(task.purchase.fare_id)})`);
    };
    const newestRun = async () => (await send({ type: "run.list", sessionId })).runs[0] ?? null;
    const exportRun = async (phase, runId) => {
      const directory = join(outDir, phase);
      mkdirSync(directory, { recursive: true });
      const bundle = await send({ type: "run.export", runId });
      for (const entry of bundle.entries) writeFileSync(join(directory, entry.name), Buffer.from(entry.base64, "base64"));
      const observations = await send({ type: "run.observations", runId });
      writeFileSync(join(directory, "observations.json"), `${JSON.stringify(observations, null, 2)}\n`);
      const record = await send({ type: "run.get", runId });
      return { directory: relative(ROOT, directory), files: bundle.entries.map((entry) => ({ name: entry.name, bytes: entry.bytes, sha256: entry.sha256 })), observations: observations.observations.length, record: { runId: record.runId, status: record.status, errorCode: record.errorCode, model: record.model, selectedModel: record.selectedModel?.hostModelId ?? null, usage: record.usage ? { tokens: record.usage.tokens, remoteCalls: record.usage.remoteCalls, toolCalls: record.usage.toolCalls } : null, cost: record.cost, audit: record.audit ? { events: record.audit.events, chainValid: record.audit.chainValid } : null, durationMs: record.durationMs, resources: record.resources.map((grant) => grant.resourceId), decisions: Object.fromEntries(record.grants.decisions.map((item) => [item.permissionId, item.decision])), revalidated: record.revalidated.length, failure: record.failure } };
    };
    const runTask = async (phase, task, options = {}) => {
      await fillTask(task);
      const button = await cdp.waitFor(page, `(() => { const b = __ab.runButton(); return b && !b.disabled ? b : null; })()`, `Run enabled for ${phase}`, 60_000);
      const before = await newestRun();
      await cdp.evaluate(page, `document.querySelector(".ab-run-button").click(); true`);
      const started = await cdp.waitFor(page, `(() => { const s = __ab.runState(); return s && s !== "idle" ? s : null; })()`, `the run to start (${phase})`, 60_000);
      const summary = await cdp.waitFor(page, `__ab.send({ type: "run.list", sessionId: ${JSON.stringify(sessionId)} }).then((r) => r.ok && r.result.runs[0] && r.result.runs[0].runId !== ${JSON.stringify(before?.runId ?? null)} ? r.result.runs[0] : null)`, `the new run record (${phase})`, 30_000);
      const runId = summary.runId;
      if (options.during) await options.during(runId);
      const final = await cdp.waitFor(page, `__ab.send({ type: "run.get", runId: ${JSON.stringify(runId)} }).then((r) => r.ok && r.result && ["completed", "failed", "cancelled", "interrupted"].includes(r.result.status) ? r.result.status : null)`, `the run to settle (${phase})`, RUN_TIMEOUT_MS, 1000);
      const pageState = await cdp.waitFor(page, `(() => { const s = __ab.runState(); return s && ["completed", "failed", "cancelled", "interrupted"].includes(s) ? s : null; })()`, `the page to show the settled run (${phase})`, 30_000);
      await shot(`${phase}-result`);
      const exported = await exportRun(phase, runId);
      report.runs[phase] = { ...exported, runLabel: button.label, startedState: started, pageState, finalStatus: final };
      return report.runs[phase];
    };
    const newRun = async () => {
      if (await cdp.evaluate(page, `__ab.click("New run")`)) await sleep(200);
    };

    // -- WebAir 0.8.0 and later: the chat surface (T24, conversation.v0) ---------------------------
    // The phases are conversations: the page's chat panel is driven as a person drives it ("Start a
    // conversation", the message box, "Send", the card's Yes / No), the record is read through the
    // extension's messages, and each conversation is exported (D-272) with every turn's recorded
    // requests beside its files, under <out-dir>/<phase>/.
    const chat = conversational(args.version);
    let quoteId = null;
    const conversationOf = async (conversationId) => send({ type: "conversation.get", conversationId });
    const newestConversation = async () => (await send({ type: "conversation.list", sessionId })).conversations[0] ?? null;
    const waitConversation = async (conversationId, predicate, label, timeoutMs = RUN_TIMEOUT_MS) => {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const view = await conversationOf(conversationId);
        if (predicate(view)) return view;
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
        await sleep(500);
      }
    };
    const startConversation = async (phase) => {
      const before = await newestConversation();
      // The surface keeps the current conversation: an open one is ended by the person, an ended
      // one stays until "New conversation" clears it; then the composer offers a start.
      if (before && before.status === "open") {
        if (await cdp.evaluate(page, `__ab.click("End conversation")`)) await waitConversation(before.conversationId, (view) => view.status === "ended", `the previous conversation to end (${phase})`, 60_000);
      }
      if (await cdp.evaluate(page, `__ab.click("New conversation")`)) await sleep(300);
      await cdp.waitFor(page, `__ab.click("Start a conversation")`, `Start a conversation (${phase})`, 60_000);
      const summary = await cdp.waitFor(page, `__ab.send({ type: "conversation.list", sessionId: ${JSON.stringify(sessionId)} }).then((r) => r.ok && r.result.conversations[0] && r.result.conversations[0].conversationId !== ${JSON.stringify(before?.conversationId ?? null)} ? r.result.conversations[0] : null)`, `the new conversation (${phase})`, 30_000);
      return summary.conversationId;
    };
    const say = async (conversationId, text, label) => {
      await cdp.waitFor(page, `document.querySelector("textarea#ab-field-message") !== null`, `the message box (${label})`, 30_000);
      await cdp.evaluate(page, `__ab.setInput("textarea#ab-field-message", ${JSON.stringify(text)})`);
      const turnsBefore = (await conversationOf(conversationId)).transcript.length;
      await cdp.waitFor(page, `__ab.click("Send")`, `Send (${label})`, 30_000);
      return waitConversation(conversationId, (view) => view.activeRunId !== null || view.transcript.length > turnsBefore, `the turn to start (${label})`, 60_000);
    };
    const settledTurn = async (conversationId, label) => {
      const view = await waitConversation(conversationId, (current) => current.activeRunId === null, `the turn to settle (${label})`);
      return { view, turn: view.transcript[view.transcript.length - 1] ?? null };
    };
    const exportConversation = async (phase, conversationId) => {
      const directory = join(outDir, phase);
      mkdirSync(directory, { recursive: true });
      const bundle = await send({ type: "conversation.export", conversationId });
      for (const entry of bundle.entries) {
        const path = join(directory, entry.name);
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, Buffer.from(entry.base64, "base64"));
      }
      const view = await conversationOf(conversationId);
      const turns = [];
      for (const turn of view.transcript) {
        if (!turn.run_id) continue;
        const prefix = `turn-${String(turn.turn).padStart(3, "0")}`;
        const observations = await send({ type: "run.observations", runId: turn.run_id });
        writeFileSync(join(directory, prefix, "observations.json"), `${JSON.stringify(observations, null, 2)}\n`);
        const record = await send({ type: "run.get", runId: turn.run_id });
        turns.push({ turn: turn.turn, status: turn.status, error_code: turn.error_code, run_id: turn.run_id, decisions: turn.decisions, reply_status: turn.reply?.status ?? null, intent: turn.reply?.intent ?? null, observations: observations.observations.length, model: record.model, usage: record.usage ? { tokens: record.usage.tokens, remoteCalls: record.usage.remoteCalls, toolCalls: record.usage.toolCalls } : null, audit: record.audit ? { events: record.audit.events, chainValid: record.audit.chainValid } : null, durationMs: record.durationMs, failure: record.failure });
      }
      return { directory: relative(ROOT, directory), files: bundle.entries.map((entry) => ({ name: entry.name, bytes: entry.bytes, sha256: entry.sha256 })), conversation: { conversationId, status: view.status, ended: view.ended, outcome: view.outcome, spent: view.spent, state: view.state, limits: view.limits }, turns };
    };
    if (chat) report.conversations = {};
    // A phase that aborts leaves its conversation exported (its files are the diagnosis).
    exportCurrent = async () => {
      if (!chat || !current || report.conversations[current.phase]) return;
      try {
        report.conversations[current.phase] = await exportConversation(current.phase, current.conversationId);
      } catch (error) {
        report.conversations[current.phase] = { error: error.message };
      }
    };
    const CHAT_SEARCH = "Find me a nonstop flight from Boston to Zurich on 9 October under $900.";
    const CHAT_REFINE = "Only the cheapest one, and tell me whether it includes a checked bag.";
    const CHAT_QUOTE = "Prepare WA101 Standard for 9 October for me.";
    const CHAT_BUY = "Buy it.";
    const CHAT_BYE = "That's all, thanks.";

    // S. Search flights as a conversation: a search, a refinement over the history (the page reloaded
    //    while the second turn runs: the chat surface adopts the turn in flight), then goodbye.
    if (chat && args.phases.includes("search")) {
      const auth = await authorize("search", {});
      report.steps.searchAuthorization = auth;
      check("search", "the search plan is ready and declares the conversation", auth.ready === true, auth.banner);
      const conversationId = await startConversation("search");
      current = { phase: "search", conversationId };
      await say(conversationId, CHAT_SEARCH, "search turn 1");
      const first = await settledTurn(conversationId, "search turn 1");
      check("search", "turn 1 completed with the hero fares found", first.turn?.status === "completed" && first.turn.reply?.status === "options_found", { status: first.turn?.status, error: first.turn?.error_code, reply: first.turn?.reply?.status });
      await shot("2-chat-search");
      await say(conversationId, CHAT_REFINE, "search turn 2");
      // Close and reopen: the page is reloaded while the turn is in flight; the chat surface must adopt it.
      await cdp.send("Page.reload", {}, page);
      await ready();
      const adopted = await cdp.waitFor(page, `(() => { const n = document.querySelector(".ab-chat"); return n ? n.dataset.state : null; })()`, "the reloaded chat surface", 60_000);
      report.steps.reconnect = { stateAfterReload: adopted, conversationId };
      check("reconnect", "the reloaded page shows the conversation", typeof adopted === "string", adopted);
      const second = await settledTurn(conversationId, "search turn 2");
      check("search", "turn 2 refined the search over the history (the same route and date, the cheapest fare)", second.turn?.status === "completed" && second.turn.reply?.intent === "search" && second.turn.reply?.status === "options_found", { status: second.turn?.status, error: second.turn?.error_code, reply: second.turn?.reply?.status });
      await say(conversationId, CHAT_BYE, "search goodbye");
      const ended = await waitConversation(conversationId, (view) => view.status === "ended", "the search conversation to end");
      check("search", "goodbye ended the conversation by the package's rule", ended.ended?.reason === "package", ended.ended);
      report.conversations.search = await exportConversation("search", conversationId);
      await shot("2-chat-search-ended");
    }

    // C. Cancel: a turn stopped from the chat surface; the conversation stays open and is ended by the person.
    if (chat && args.phases.includes("cancel")) {
      const auth = await authorize("search", {});
      check("cancel", "a new search plan is ready", auth.ready === true, auth.banner);
      const conversationId = await startConversation("cancel");
      current = { phase: "cancel", conversationId };
      await say(conversationId, CHAT_SEARCH, "cancel turn");
      await cdp.waitFor(page, `__ab.click("Stop this turn")`, "the Stop button", 30_000);
      report.steps.cancel = { pressedAtS: Math.round((Date.now() - startedAt.getTime()) / 1000) };
      const stopped = await settledTurn(conversationId, "the cancelled turn");
      check("cancel", "the turn settled as cancelled and the conversation stayed open", stopped.turn?.status === "cancelled" && stopped.view.status === "open", { status: stopped.turn?.status, conversation: stopped.view.status });
      await cdp.waitFor(page, `__ab.click("End conversation")`, "the End button", 30_000);
      const ended = await waitConversation(conversationId, (view) => view.status === "ended", "the cancelled conversation to end");
      check("cancel", "the person ended it", ended.ended?.reason === "person", ended.ended);
      report.conversations.cancel = await exportConversation("cancel", conversationId);
    }

    // Q. Search and quote: the quote in one turn; the identity reaches WebAir only in prepare_booking;
    //    the quote stays open in the conversation's state.
    if (chat && args.phases.includes("quote")) {
      const auth = await authorize("quote", { [PROFILE_PERMISSION]: PICKS[PROFILE_PERMISSION], "identity.passenger": PICKS["identity.passenger"] });
      report.steps.quoteAuthorization = auth;
      check("quote", "the quote plan is ready with two records", auth.ready === true && auth.grants.length === 2, auth);
      const conversationId = await startConversation("quote");
      current = { phase: "quote", conversationId };
      await say(conversationId, CHAT_QUOTE, "quote turn");
      const { view, turn } = await settledTurn(conversationId, "quote turn");
      quoteId = turn?.reply?.booking?.quote_id ?? null;
      report.steps.quote = { quoteId, fareId: turn?.reply?.booking?.fare_id ?? null, totalUsd: turn?.reply?.booking?.total_usd ?? null, conversationId };
      check("quote", "the turn quoted the fare", turn?.status === "completed" && turn.reply?.status === "quoted" && typeof quoteId === "string" && /^WAQ-[0-9A-F]{16}$/u.test(quoteId), { status: turn?.status, error: turn?.error_code, reply: turn?.reply?.status, quoteId });
      check("quote", "the open quote outlives the turn", view.state?.quote_ref?.quote_id === quoteId, view.state?.quote_ref ?? null);
      await shot("3-chat-quote");
      report.conversations.quote = await exportConversation("quote", conversationId);
      // The memory phase (Demo 6) is this conversation's review sheet: the quote proposes a preference.
      if (args.phases.includes("memory")) {
        const runRecord = await send({ type: "run.get", runId: turn.run_id });
        report.steps.memoryRun = { runId: turn.run_id, memory: runRecord.memory ?? null };
        check("memory", "the quote turn proposed something to remember (memory.proposed)", (runRecord.memory?.proposals?.offered ?? 0) > 0, runRecord.memory);
        if ((runRecord.memory?.proposals?.offered ?? 0) > 0) {
          const sheet = await cdp.waitFor(page, `__ab.review()`, "the review sheet", 30_000);
          check("memory", "the review sheet lists every offered proposal", sheet.cards === runRecord.memory.proposals.offered, sheet);
          await shot("6-review");
          await cdp.evaluate(page, `__ab.click("Accept all", document.querySelector(".ab-review"))`);
          await sleep(200);
          await cdp.evaluate(page, `__ab.click("Save decisions", document.querySelector(".ab-review"))`);
          const done = await cdp.waitFor(page, `(() => { const r = __ab.review(); return r && r.done ? r : null; })()`, "the decisions applied", 30_000);
          report.steps.memoryReview = { done, review: await send({ type: "memory.review", runId: turn.run_id }) };
          check("memory", "the decisions were applied once and the sheet collapsed", done.done === true && report.steps.memoryReview.review.decided !== null, report.steps.memoryReview);
        }
      }
    }

    // P. Book (simulated): a quote, then "Buy it." reaches the card with the quote's facts; Yes places the
    //    simulated purchase under once; a second "Buy it." is not asked (the once grant spent); goodbye.
    if (chat && args.phases.includes("purchase")) {
      const auth = await authorize("book", PICKS);
      report.steps.purchaseAuthorization = auth;
      await shot("4-book-authorized");
      check("purchase", "the book plan is ready with the purchase granted once", auth.ready === true && auth.decisions?.["booking.simulate_purchase"] === "once", auth);
      const conversationId = await startConversation("purchase");
      current = { phase: "purchase", conversationId };
      await say(conversationId, CHAT_QUOTE, "purchase: the quote turn");
      const quoted = await settledTurn(conversationId, "purchase: the quote turn");
      check("purchase", "the quote turn completed", quoted.turn?.status === "completed" && quoted.turn.reply?.status === "quoted", { status: quoted.turn?.status, error: quoted.turn?.error_code });
      await say(conversationId, CHAT_BUY, "purchase: buy it");
      const waiting = await waitConversation(conversationId, (view) => view.pendingConsent !== null || view.activeRunId === null, "the card");
      const card = waiting.pendingConsent;
      report.steps.card = card ? { step: card.step, permissions: card.permissions, kinds: card.kinds, text: card.text, facts: card.facts, requested_at: card.requested_at, seen_at: new Date().toISOString() } : null;
      check("purchase", "the turn waits on the card: confirm-purchase, the purchase authority, the quote's facts with the passenger's name and the card's label, no e-mail or payment id", card?.step === "confirm-purchase" && card.kinds?.includes("payment") && card.facts?.quote_id === quoted.turn.reply.booking.quote_id && typeof card.facts?.passenger?.given_name === "string" && typeof card.facts?.payment_method === "string" && !JSON.stringify(card.facts).includes("@") && !("payment_method_id" in (card.facts ?? {})), card);
      await shot("5-chat-card");
      await cdp.waitFor(page, `(() => { const b = document.querySelector('[data-decide="accept"]'); if (!b || b.disabled) return false; b.click(); return true; })()`, "the card's Yes", 30_000);
      report.steps.decision = { accepted: true, decided_at: new Date().toISOString() };
      const bought = await settledTurn(conversationId, "purchase: the card accepted");
      check("purchase", "the simulated purchase completed with the person's decision", bought.turn?.status === "completed" && bought.turn.reply?.status === "purchase_simulated" && bought.turn.decisions?.[0]?.decided_by === "person" && bought.turn.decisions[0].accepted === true, { status: bought.turn?.status, error: bought.turn?.error_code, reply: bought.turn?.reply?.status, decisions: bought.turn?.decisions });
      check("purchase", "it is simulated with no charge, and once was spent", bought.turn?.reply?.purchase?.real_transaction === false && bought.turn.reply.purchase.amount_charged_usd === 0 && bought.view.spent.permissions.includes("booking.simulate_purchase"), { purchase: bought.turn?.reply?.purchase, spent: bought.view.spent });
      await shot("5-chat-bought");
      // The replay: a second "buy it" buys nothing. Either the interpreter reads it as a purchase and
      // the card is not asked (V-13: the step resolves denied by the plan as consumed), or it sees the
      // confirmation in the state and answers the question (the skill's rule); in both no card, no call.
      await say(conversationId, CHAT_BUY, "purchase: buy it again");
      const again = await settledTurn(conversationId, "purchase: the second buy");
      const replay = { turn: again.turn?.status, intent: again.turn?.reply?.intent, reply: again.turn?.reply?.status, decisions: again.turn?.decisions };
      report.steps.replay = { ...replay };
      const consumed = replay.reply === "purchase_declined" && replay.decisions?.[0]?.decided_by === "plan" && replay.decisions[0].reason === "permission_consumed";
      const answered = replay.intent === "question" && replay.reply === "answered" && (replay.decisions ?? []).length === 0;
      check("replay", "the second purchase bought nothing: not asked (declined by the plan as consumed) or answered from the state", replay.turn === "completed" && (consumed || answered) && again.view.spent.tool_calls?.["simulate-purchase"] === 1, replay);
      await say(conversationId, CHAT_BYE, "purchase goodbye");
      const ended = await waitConversation(conversationId, (view) => view.status === "ended", "the purchase conversation to end");
      check("purchase", "goodbye ended the conversation", ended.ended?.reason === "package", ended.ended);
      report.conversations.purchase = await exportConversation("purchase", conversationId);
      await shot("5-chat-ended");
    }

    // D. Denial: under the quote profile, "Buy it." stops at the payment read; no card, nothing sent; the conversation stays open.
    if (chat && args.phases.includes("denial")) {
      const auth = await authorize("quote", { [PROFILE_PERMISSION]: PICKS[PROFILE_PERMISSION], "identity.passenger": PICKS["identity.passenger"] });
      check("denial", "the quote plan is ready again", auth.ready === true, auth.banner);
      const conversationId = await startConversation("denial");
      current = { phase: "denial", conversationId };
      await say(conversationId, CHAT_QUOTE, "denial: the quote turn");
      const quoted = await settledTurn(conversationId, "denial: the quote turn");
      check("denial", "the quote turn completed", quoted.turn?.status === "completed", { status: quoted.turn?.status, error: quoted.turn?.error_code });
      await say(conversationId, CHAT_BUY, "denial: buy it");
      const denied = await settledTurn(conversationId, "denial: buy it");
      check("denial", "the purchase turn failed with permission_denied, no card shown, the conversation open", denied.turn?.status === "failed" && denied.turn.error_code === "permission_denied" && (denied.turn.decisions ?? []).length === 0 && denied.view.status === "open", { status: denied.turn?.status, error: denied.turn?.error_code, decisions: denied.turn?.decisions });
      await cdp.waitFor(page, `__ab.click("End conversation")`, "the End button (denial)", 30_000);
      await waitConversation(conversationId, (view) => view.status === "ended", "the denial conversation to end");
      report.conversations.denial = await exportConversation("denial", conversationId);
    }

    // 2. Search flights: a run, with the page reloaded in the middle (reconnect).
    if (!chat && args.phases.includes("search")) {
      const auth = await authorize("search", {});
      report.steps.searchAuthorization = auth;
      check("search", "the search plan is ready", auth.ready === true, auth.banner);
      const search = await runTask("search", { request: SEARCH_REQUEST, booking: false, purchase: { quote_id: "", fare_id: "" } }, {
        during: async (runId) => {
          // Close and reopen: the page is reloaded while the run is in flight; the run surface must adopt the running run.
          await cdp.send("Page.reload", {}, page);
          await ready();
          const adopted = await cdp.waitFor(page, `(() => { const s = __ab.runState(); return s && s !== "idle" ? s : null; })()`, "the reloaded page to adopt the run", 60_000);
          const shown = await cdp.waitFor(page, `__ab.send({ type: "run.list", sessionId: ${JSON.stringify(sessionId)} }).then((r) => r.ok ? (r.result.active ? r.result.active.runId : r.result.runs[0]?.runId) : null)`, "the adopted run id", 30_000);
          report.steps.reconnect = { stateAfterReload: adopted, adoptedRunId: shown, runId };
          check("reconnect", "the reloaded page shows the run that was in flight", shown === runId, { shown, runId });
        },
      });
      check("search", "completed", search.record.status === "completed", search.record);
      check("search", "every model call used the planned model", search.record.model?.allCallsUsedPlannedModel === true && search.record.model?.planned === args.model, search.record.model);
      check("search", "the audit chain is valid", search.record.audit?.chainValid === true, search.record.audit);
      await newRun();
    }

    // 3. Cancel: a second search stopped as soon as it runs.
    if (!chat && args.phases.includes("cancel")) {
      const auth = await authorize("search", {});
      check("cancel", "a new search plan is ready", auth.ready === true, auth.banner);
      const cancelled = await runTask("cancel", { request: SEARCH_REQUEST, booking: false, purchase: { quote_id: "", fare_id: "" } }, {
        during: async () => {
          await cdp.waitFor(page, `__ab.click("Cancel")`, "the Cancel button", 30_000);
          report.steps.cancel = { pressedAtS: Math.round((Date.now() - startedAt.getTime()) / 1000) };
        },
      });
      check("cancel", "the run settled as cancelled", cancelled.record.status === "cancelled", cancelled.record.status);
      check("cancel", "the audit chain of the cancelled run is valid", cancelled.record.audit?.chainValid === true, cancelled.record.audit);
      await newRun();
    }

    // 4. Search and quote: the passenger identity reaches WebAir only in prepare_booking.
    if (!chat && args.phases.includes("quote")) {
      const auth = await authorize("quote", { [PROFILE_PERMISSION]: PICKS[PROFILE_PERMISSION], "identity.passenger": PICKS["identity.passenger"] });
      report.steps.quoteAuthorization = auth;
      check("quote", "the quote plan is ready with two records", auth.ready === true && auth.grants.length === 2, auth);
      const quote = await runTask("quote", { request: BOOKING_REQUEST, booking: true, purchase: { quote_id: "", fare_id: "" } });
      check("quote", "completed", quote.record.status === "completed", quote.record);
      const booking = await send({ type: "run.artifact", runId: quote.record.runId, name: "booking.json" });
      quoteId = booking.json?.booking?.quote_id ?? null;
      report.steps.quote = { quoteId, fareId: booking.json?.booking?.fare_id ?? null, totalUsd: booking.json?.booking?.total_usd ?? null };
      check("quote", "a quote id came back", typeof quoteId === "string" && /^WAQ-[0-9A-F]{16}$/u.test(quoteId), quoteId);
      await newRun();
    }

    // 5. Book (simulated): purchase under once; then the same authorization is refused.
    if (!chat && args.phases.includes("purchase") && quoteId) {
      const auth = await authorize("book", PICKS);
      report.steps.purchaseAuthorization = auth;
      await shot("4-book-authorized");
      check("purchase", "the book plan is ready with the purchase granted once", auth.ready === true && auth.decisions?.["booking.simulate_purchase"] === "once", auth);
      const purchaseTask = { request: `Simulate purchase of quote ${quoteId}.`, booking: false, purchase: { quote_id: quoteId, fare_id: report.steps.quote.fareId } };
      const purchase = await runTask("purchase", purchaseTask);
      check("purchase", "completed", purchase.record.status === "completed", purchase.record);
      check("purchase", "the purchase permission was once", purchase.record.decisions["booking.simulate_purchase"] === "once", purchase.record.decisions);
      await newRun();
      // Replay: the page disables Run with the reason, and the worker refuses the start.
      await fillTask(purchaseTask);
      await sleep(1500);
      const button = await cdp.waitFor(page, `__ab.runButton()`, "the Run button after the purchase", 30_000);
      const reasonMentionsOnce = typeof button.reason === "string" && /once/iu.test(button.reason);
      let refusal = null;
      try {
        await send({ type: "run.start", sessionId, runPlanId: auth.runPlanId, runPlanSha256: auth.runPlanSha256, input: purchaseTask });
      } catch (error) {
        refusal = error.message;
      }
      const after = await newestRun();
      report.steps.replay = { runButton: button, workerRefusal: refusal, newestRun: after?.runId ?? null };
      await shot("5-once-spent");
      check("replay", "the page disables Run because the once grant is spent", button.disabled === true && reasonMentionsOnce, button);
      check("replay", "the worker refuses the start as a stale plan (once spent)", typeof refusal === "string" && /run_plan_stale/u.test(refusal) && /once/iu.test(refusal), refusal);
      check("replay", "no new run was created", after?.runId === purchase.record.runId, after?.runId);
    }

    // 7. Memory (T19, Demo 6; WebAir 0.6.0): a booking proposes things to remember; the person accepts them;
    //    the memory folder is exported; a second authorization recalls the accepted record.
    if (!chat && args.phases.includes("memory")) {
      const bookPicks = Object.fromEntries(Object.entries(PICKS).filter(([permission]) => permission !== PROFILE_PERMISSION));
      const auth = await authorize("book", bookPicks);
      report.steps.memoryAuthorization = auth;
      check("memory", "the book plan is ready with the recalled profile", auth.ready === true && auth.grants.includes(PROFILE_ID), auth);
      const memoryTask = { request: MEMORY_REQUEST, booking: true, purchase: { quote_id: "", fare_id: "" } };
      const run = await runTask("memory", memoryTask);
      check("memory", "completed", run.record.status === "completed", run.record);
      const record = await send({ type: "run.get", runId: run.record.runId });
      report.steps.memoryRun = { runId: run.record.runId, memory: record.memory ?? null };
      check("memory", "the run proposed something to remember (memory.proposed)", (record.memory?.proposals?.offered ?? 0) > 0, record.memory);
      const sheet = await cdp.waitFor(page, `__ab.review()`, "the review sheet", 30_000);
      check("memory", "the review sheet lists every offered proposal", sheet.cards === (record.memory?.proposals?.offered ?? -1), sheet);
      await shot("6-review");
      await cdp.evaluate(page, `__ab.click("Accept all", document.querySelector(".ab-review"))`);
      await sleep(200);
      await cdp.evaluate(page, `__ab.click("Save decisions", document.querySelector(".ab-review"))`);
      const done = await cdp.waitFor(page, `(() => { const r = __ab.review(); return r && r.done ? r : null; })()`, "the decisions applied", 30_000);
      report.steps.memoryReview = { done, review: await send({ type: "memory.review", runId: run.record.runId }) };
      check("memory", "the decisions were applied once and the sheet collapsed", done.done === true && report.steps.memoryReview.review.decided !== null, report.steps.memoryReview);
      const memoryView = await send({ type: "memory.get" });
      const accepted = memoryView.records.filter((item) => item.source?.kind === "package" && item.source.run_id === run.record.runId);
      report.steps.memoryRecords = accepted.map((item) => ({ id: item.id, type: item.type, title: item.title, links: item.links ?? [] }));
      check("memory", "the accepted records carry the run's provenance", accepted.length === report.steps.memoryReview.review.decided.accepted, report.steps.memoryRecords);
      // The export: the memory folder as a zip beside the run directories (sealed values omitted).
      const exported = await send({ type: "memory.export", includeSealed: false, includeAgents: true, recordIds: null });
      const folder = join(outDir, "memory-export");
      mkdirSync(folder, { recursive: true });
      for (const file of exported.files) {
        mkdirSync(join(folder, dirname(file.path)), { recursive: true });
        writeFileSync(join(folder, file.path), file.text);
      }
      report.steps.memoryExport = { directory: relative(ROOT, folder), files: exported.files.length, sealedIncluded: exported.sealed_included };
      check("memory", "the export omits sealed values", exported.sealed_included === false && exported.files.some((file) => file.path === "index.md"), report.steps.memoryExport);
      await newRun();
      // A second authorization: the accepted record is a recall candidate for the same package.
      await cdp.evaluate(page, `document.querySelector('button[data-profile="book"]').click(); true`);
      await sleep(300);
      const recall = (await send({ type: "authorization.get", sessionId })).recall;
      report.steps.memoryRecall = recall.map((card) => ({ permission_id: card.permission_id, resource_type: card.resource_type, mode: card.mode, candidates: card.candidates.map((candidate) => ({ id: candidate.id, title: candidate.title, signals: candidate.signals })) }));
      // A recall card offers records of the type its `memory.read` requests, so an accepted record can be
      // recalled only when the package reads its type (B-222). WebAir 0.6.0 and 0.7.0 propose
      // `travel.preference` and read only `travel.profile` (B-221): the check is skipped with a note.
      // The types read are the cards'; with no card, or a card that names none, they are the memory
      // run's plan's host-resource bindings, and with none of those every accepted record counts.
      // Nothing accepted is no reason to skip: the check fails. All as `verify_chrome_memory_live.py`.
      let readTypes = new Set(recall.map((card) => card.resource_type ?? null));
      if (recall.length === 0 || readTypes.has(null)) {
        const planPath = join(ROOT, run.directory, "run-plan.json");
        const plan = existsSync(planPath) ? JSON.parse(readFileSync(planPath, "utf8")) : {};
        const bound = (plan.tool_bindings ?? []).filter((binding) => binding && typeof binding === "object" && binding.resource_type).map((binding) => binding.resource_type);
        readTypes = new Set(bound.length > 0 ? bound : [null]);
      }
      const readable = readTypes.has(null) ? accepted : accepted.filter((item) => readTypes.has(item.type));
      if (readable.length === 0 && accepted.length > 0) {
        report.steps.memory["the accepted record is recalled for the next run"] = { skipped: `the package reads ${[...readTypes].sort().join(", ") || "no memory type"}; the accepted records are ${[...new Set(accepted.map((item) => item.type))].sort().join(", ") || "none"} (B-221)` };
      } else {
        const recalled = recall.some((card) => card.candidates.some((candidate) => readable.some((item) => item.id === candidate.id)));
        check("memory", "the accepted record is recalled for the next run", recalled, report.steps.memoryRecall);
      }
      await shot("7-recalled");
    }

    // 6. Denial: the quote profile cannot purchase.
    if (!chat && args.phases.includes("denial") && quoteId) {
      const auth = await authorize("quote", { [PROFILE_PERMISSION]: PICKS[PROFILE_PERMISSION], "identity.passenger": PICKS["identity.passenger"] });
      check("denial", "the quote plan is ready again", auth.ready === true, auth.banner);
      const denial = await runTask("denial", { request: `Simulate purchase of quote ${quoteId}.`, booking: false, purchase: { quote_id: quoteId, fare_id: report.steps.quote.fareId } });
      check("denial", "failed with permission_denied", denial.record.status === "failed" && denial.record.errorCode === "permission_denied", denial.record);
      check("denial", "no model call and no WebAir call", (denial.record.model?.calls ?? 0) === 0 && denial.observations === 0, { model: denial.record.model, observations: denial.observations });
    }
  } catch (error) {
    report.failures.push(`harness: ${error.message}`);
    await exportCurrent().catch(() => undefined);
  } finally {
    const exited = chrome.exitCode !== null || chrome.signalCode !== null ? Promise.resolve() : new Promise((resolveExit) => chrome.once("exit", resolveExit));
    chrome.kill();
    await Promise.race([exited, sleep(10_000)]);
    origin?.child.kill();
    if (!args.keep) rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
  report.passed = report.failures.length === 0;
  const text = `${JSON.stringify(report, null, 2)}\n`;
  // A failed attempt never replaces a report that passed (the committed evidence is the default
  // `--out`): it goes beside its run directories instead (T5 review 1, after nit 8).
  let out = args.out;
  if (!report.passed && existsSync(args.out)) {
    try {
      if (JSON.parse(readFileSync(args.out, "utf8")).passed === true) out = join(outDir, "report.json");
    } catch {
      // unreadable: overwrite as asked
    }
  }
  writeFileSync(out, text);
  process.stdout.write(text);
  log(`report written to ${relative(ROOT, out)}${out !== args.out ? ` (the passing report at ${relative(ROOT, args.out)} was kept)` : ""}; run directories under ${relative(ROOT, outDir)}`);
  process.exit(report.passed ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
