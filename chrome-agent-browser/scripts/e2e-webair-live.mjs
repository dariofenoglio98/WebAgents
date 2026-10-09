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
 *                             examples/verification/chrome-webair-<050>-live.json, T9)
 *        [--out-dir examples/my-chrome-live-<ts>] [--chrome path] [--keep] [--phases all|search,cancel,quote,purchase,denial]
 *   A hosted model needs OPENAI_API_KEY or ANTHROPIC_API_KEY in the environment; the key is typed
 *   into the extension's storage for this throwaway profile and never written anywhere by this script.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { Cdp, sleep } from "./lib/cdp.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const PROJECT = resolve(here, "..");
const ROOT = resolve(PROJECT, "..");
const EXTENSION = join(PROJECT, "dist", "extension");
const DEFAULT_CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const DEFAULT_SITE = "https://webagents-webair-production.up.railway.app/";
const RUN_TIMEOUT_MS = 20 * 60 * 1000;

const args = { chrome: process.env.CHROME_PATH || DEFAULT_CHROME, site: DEFAULT_SITE, model: null, version: "0.5.0", out: null, outDir: null, keep: false, phases: ["search", "cancel", "quote", "purchase", "denial"] };
for (let index = 2; index < process.argv.length; index += 1) {
  const argument = process.argv[index];
  if (argument === "--chrome") args.chrome = process.argv[(index += 1)];
  else if (argument === "--site") args.site = process.argv[(index += 1)];
  else if (argument === "--model") args.model = process.argv[(index += 1)];
  else if (argument === "--version") args.version = process.argv[(index += 1)];
  else if (argument === "--out") args.out = resolve(process.argv[(index += 1)]);
  else if (argument === "--out-dir") args.outDir = resolve(process.argv[(index += 1)]);
  else if (argument === "--keep") args.keep = true;
  else if (argument === "--phases") args.phases = process.argv[(index += 1)] === "all" ? args.phases : process.argv[index].split(",");
  else {
    console.error(`unknown argument ${argument}`);
    process.exit(2);
  }
}
// Each version's evidence has its own report; the committed 0.4.0 one is never overwritten by a 0.5.0 run.
if (args.out === null) args.out = join(ROOT, "examples", "verification", `chrome-webair-${args.version.replaceAll(".", "")}-live.json`);
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
const PICKS = { "profile.travel": "profile_demo_traveler", "identity.passenger": "passenger_demo_alex", "wallet.payment": "payment_demo_visa" };

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
  async send(request) { const reply = await chrome.runtime.sendMessage(request); return reply; },
};
true;
`;

const report = {
  profile: "chrome-webair-040-live-v0",
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

async function main() {
  const profile = mkdtempSync(join(tmpdir(), "chrome-agent-browser-live-"));
  const chrome = spawn(args.chrome, ["--headless=new", "--remote-debugging-pipe", "--enable-unsafe-extension-debugging", `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check", "--window-size=1280,2200", "about:blank"], { stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"] });
  const cdp = new Cdp(chrome);
  try {
    report.chrome = (await cdp.send("Browser.getVersion")).product;
    const { id: extensionId } = await cdp.send("Extensions.loadUnpacked", { path: EXTENSION });
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
    if (keyEnv) await send({ type: "settings.setKey", provider, key: process.env[keyEnv] });
    const probe = await send({ type: "models.probe", provider });
    report.steps.setup = { probe: { ok: probe.ok, models: probe.models.length, error: probe.error, diagnosis: probe.diagnosis ?? null }, testMode: true, keyFromEnvironment: keyEnv };
    check("setup", `the ${provider} connection answers`, probe.ok === true, probe.error);
    check("setup", "the model is offered", probe.models.some((model) => model.id === args.model), probe.models.map((model) => model.id));
    await send({ type: "vault.installDemo", records: true });
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
        const ok = await cdp.evaluate(page, `__ab.setSelect('select[name="resource-${permission}"]', ${JSON.stringify(resourceId)})`);
        if (!ok) throw new Error(`no picker for ${permission}`);
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

    // 2. Search flights: a run, with the page reloaded in the middle (reconnect).
    if (args.phases.includes("search")) {
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
    if (args.phases.includes("cancel")) {
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
    let quoteId = null;
    if (args.phases.includes("quote")) {
      const auth = await authorize("quote", { "profile.travel": PICKS["profile.travel"], "identity.passenger": PICKS["identity.passenger"] });
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
    if (args.phases.includes("purchase") && quoteId) {
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

    // 6. Denial: the quote profile cannot purchase.
    if (args.phases.includes("denial") && quoteId) {
      const auth = await authorize("quote", { "profile.travel": PICKS["profile.travel"], "identity.passenger": PICKS["identity.passenger"] });
      check("denial", "the quote plan is ready again", auth.ready === true, auth.banner);
      const denial = await runTask("denial", { request: `Simulate purchase of quote ${quoteId}.`, booking: false, purchase: { quote_id: quoteId, fare_id: report.steps.quote.fareId } });
      check("denial", "failed with permission_denied", denial.record.status === "failed" && denial.record.errorCode === "permission_denied", denial.record);
      check("denial", "no model call and no WebAir call", (denial.record.model?.calls ?? 0) === 0 && denial.observations === 0, { model: denial.record.model, observations: denial.observations });
    }
  } catch (error) {
    report.failures.push(`harness: ${error.message}`);
  } finally {
    const exited = chrome.exitCode !== null || chrome.signalCode !== null ? Promise.resolve() : new Promise((resolveExit) => chrome.once("exit", resolveExit));
    chrome.kill();
    await Promise.race([exited, sleep(10_000)]);
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
