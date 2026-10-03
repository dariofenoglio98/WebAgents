#!/usr/bin/env node
/**
 * Live acceptance driver for the WebAir demo: the real Agent Browser page, clicked like a person.
 *
 * It opens the running Gateway's Control UI in a headless Chrome (the operator's own browser
 * binary, a throwaway profile), signs in with the one-time owner link `openclaw dashboard`
 * issues — never printed or stored — and walks the page:
 *
 *   website URL ─► "Agent package advertised" ─► Inspect ─► signature valid, publisher unknown
 *   ─► authorization refused (untrusted) ─► Trust this publisher key ─► trusted
 *   ─► search:   travel profile granted ─► model ─► Prepare run ─► Run
 *   ─► booking:  passenger identity granted ─► new authorization ─► Prepare run ─► Run
 *   ─► purchase: payment method + simulated purchase (once) ─► new authorization ─► Run
 *                ─► the same plan again: refused (the once grant is spent)
 *   ─► denial:   payment method and purchase denied ─► new authorization ─► Run ─► refused
 *
 * Every decision goes through the page's own controls, so the plugin backend, control plane,
 * runner and broker answering are the installed ones, with the operator's real model route.
 * The page never learns a host resource value and neither does this script: it reads labels
 * and the run's own id from the page, and writes a JSON report of what the page showed. The
 * runs' own records (`~/.openclaw/agent-browser/runs/<id>/`) are the evidence of what ran;
 * `scripts/verify_webair_live.py` reads them.
 *
 *   node scripts/run-webair-live.mjs --site https://<webair host>/ --model ollama/qwen3:30b \
 *     --out /private/dir/webair-live-ui.json [--screens /private/dir/shots] [--phases all]
 *
 * Spends real model tokens on the chosen model. It expects the WebAir publisher key not to be
 * pinned yet (see docs/webair-live-demo.md, "Reset"); pass --already-trusted otherwise.
 */
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const DEFAULT_CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PAGE_PATH = "/plugin?plugin=agent-browser&id=agent-browser";
const RUNS_DIR = join(homedir(), ".openclaw", "agent-browser", "runs");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function parseArgs(argv) {
  const args = { phases: "all", runTimeout: 1800, chrome: DEFAULT_CHROME, alreadyTrusted: false };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--already-trusted") args.alreadyTrusted = true;
    else if (flag === "--run-timeout") args.runTimeout = Number(argv[++index]);
    else if (flag.startsWith("--")) args[flag.slice(2)] = argv[++index];
  }
  for (const required of ["site", "model", "out"]) {
    if (!args[required]) throw new Error(`--${required} is required`);
  }
  const site = new URL(args.site);
  if (site.protocol !== "https:") throw new Error("--site must be an https URL");
  args.site = site.href;
  args.origin = site.origin;
  return args;
}

// -- a minimal CDP client over Node's built-in WebSocket ---------------------------------------
class Cdp {
  constructor(url) {
    this.ws = new WebSocket(url);
    this.next = 0;
    this.pending = new Map();
    this.ws.onmessage = (event) => {
      const message = JSON.parse(event.data);
      if (message.id && this.pending.has(message.id)) {
        const { resolve, reject } = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) reject(new Error(`${message.error.message}`));
        else resolve(message.result);
      }
    };
  }
  open() {
    return new Promise((resolve, reject) => {
      this.ws.onopen = resolve;
      this.ws.onerror = reject;
    });
  }
  send(method, params = {}) {
    const id = ++this.next;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async evaluate(expression) {
    const result = await this.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(`page error: ${result.exceptionDetails.text}`);
    return result.result?.value;
  }
  close() {
    this.ws.close();
  }
}

// Page-side helpers, installed after each navigation. They read and operate the page's own
// controls by their accessible labels and section markers; nothing here reaches the backend.
const HELPERS = String.raw`
window.__ab = {
  section(name) { return document.querySelector('[data-section="' + name + '"]'); },
  text(node) { return node ? node.innerText : ""; },
  buttons(scope) { return [...(scope || document).querySelectorAll("button")]; },
  click(label, scope) {
    const button = this.buttons(scope).find((b) => b.textContent.trim() === label && !b.disabled);
    if (!button) return false;
    button.click();
    return true;
  },
  setSelect(selector, value) {
    const node = document.querySelector(selector);
    if (!node || node.disabled || ![...node.options].some((o) => o.value === value)) return false;
    node.value = value;
    node.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  },
  setInput(selector, value) {
    const node = document.querySelector(selector);
    if (!node || node.disabled) return false;
    const proto = node instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value").set.call(node, value);
    node.dispatchEvent(new Event("input", { bubbles: true }));
    return true;
  },
  setChecked(node, checked) {
    if (!node || node.disabled) return false;
    if (node.checked !== checked) node.click();
    return node.checked === checked;
  },
  runState() { const card = document.querySelector(".ab-card.ab-run"); return card ? card.dataset.state : null; },
  chips(scope) { return [...(scope || document).querySelectorAll(".ab-chip, .ab-chips span")].map((n) => n.textContent.trim()); },
};
true;
`;

class Page {
  constructor(cdp, report) {
    this.cdp = cdp;
    this.report = report;
  }
  q(expression) {
    return this.cdp.evaluate(expression);
  }
  async helpers() {
    await this.q(HELPERS);
  }
  async waitFor(expression, what, timeoutMs = 60_000, intervalMs = 400) {
    const deadline = Date.now() + timeoutMs;
    let last;
    while (Date.now() < deadline) {
      try {
        last = await this.q(`(() => { if (!window.__ab) return null; return (${expression}); })()`);
        if (last) return last;
        if (last === null) await this.helpers();
      } catch {
        // The page may be re-rendering; ask again.
      }
      await sleep(intervalMs);
    }
    throw new Error(`timed out waiting for ${what}`);
  }
  async act(expression, what) {
    const done = await this.waitFor(expression, what, 30_000, 300);
    if (done !== true) throw new Error(`could not ${what}`);
  }
  async screenshot(dir, name, section) {
    if (!dir) return null;
    // The plugin's content area only: never the sidebar, sessions or other host pages.
    const rect = await this.q(`(() => {
      const target = ${section ? `__ab.section(${JSON.stringify(section)})` : "null"};
      if (target) target.scrollIntoView({ block: "start" });
      const main = document.querySelector("main#control-ui-main") || document.body;
      const r = main.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: Math.min(r.height, window.innerHeight - r.y) };
    })()`);
    await sleep(400);
    const shot = await this.cdp.send("Page.captureScreenshot", { format: "png", clip: { ...rect, scale: 1 } });
    const path = join(dir, `${name}.png`);
    writeFileSync(path, Buffer.from(shot.data, "base64"));
    return `${name}.png`;
  }
}

function runDirectories() {
  try {
    return new Set(readdirSync(RUNS_DIR));
  } catch {
    return new Set();
  }
}

// -- the page's controls, by what a person sees -----------------------------------------------
async function setDecisions(page, decisions, selections) {
  await page.waitFor(`__ab.section("permissions")`, "the permissions card");
  for (const [permission, decision] of Object.entries(decisions)) {
    await page.act(
      `__ab.setSelect('select[aria-label="Decision for ${permission}"]', ${JSON.stringify(decision)})`,
      `set ${permission} to ${decision}`,
    );
  }
  for (const [permission, resourceId] of Object.entries(selections)) {
    await page.act(
      `(() => {
        const select = [...document.querySelectorAll('[data-section="permissions"] select')]
          .find((s) => (s.getAttribute("aria-label") || "").endsWith(" for ${permission}")
            && !(s.getAttribute("aria-label") || "").startsWith("Decision for"));
        if (!select || ![...select.options].some((o) => o.value === ${JSON.stringify(resourceId)})) return false;
        select.value = ${JSON.stringify(resourceId)};
        select.dispatchEvent(new Event("change", { bubbles: true }));
        return true;
      })()`,
      `choose ${resourceId} for ${permission}`,
    );
  }
  // Every declared tool needs its own approval (agent.pkg 0.1 has no optional tools).
  await page.act(
    `(() => {
      const boxes = [...document.querySelectorAll('[data-section="permissions"] label.ab-approval input[type=checkbox]')];
      return boxes.length > 0 && boxes.every((box) => __ab.setChecked(box, true));
    })()`,
    "approve every declared tool",
  );
}

const RECEIPT_ID = `(() => { const card = __ab.section("authorization"); const d = card && [...card.querySelectorAll("dt")].find((dt) => dt.textContent.trim() === "Receipt"); return d && d.nextElementSibling ? d.nextElementSibling.textContent.trim() : null; })()`;

async function authorize(page, expectRunnable) {
  // A new decision issues a new receipt; its id (in the collapsed technical details) is the
  // change to wait for, since two runnable receipts read the same on screen.
  const before = await page.q(RECEIPT_ID);
  await page.act(`__ab.click("Authorize", __ab.section("authorization"))`, "press Authorize");
  const banner = await page.waitFor(
    `(() => {
      const card = __ab.section("authorization");
      const node = card && card.querySelector(".ab-receipt-banner");
      const receipt = ${RECEIPT_ID};
      return node && receipt && receipt !== ${JSON.stringify(before)} ? { ok: node.classList.contains("ab-receipt-ok"), text: node.innerText,
        blocking: [...card.querySelectorAll(".ab-blocking code")].map((c) => c.textContent),
        receipt: (() => { const d = [...card.querySelectorAll("dt")].find((dt) => dt.textContent.trim() === "Receipt"); return d && d.nextElementSibling ? d.nextElementSibling.textContent.trim() : null; })(),
        grants: (() => { const d = [...card.querySelectorAll("dt")].find((dt) => dt.textContent.trim() === "Host resources"); return d && d.nextElementSibling ? d.nextElementSibling.textContent.trim() : null; })(),
        decisions: (() => { const d = [...card.querySelectorAll("dt")].find((dt) => dt.textContent.trim() === "Decisions"); return d && d.nextElementSibling ? d.nextElementSibling.textContent.trim() : null; })() } : null;
    })()`,
    "the authorization result",
  );
  if (banner.ok !== expectRunnable) {
    throw new Error(`authorization runnable=${banner.ok}, expected ${expectRunnable}: ${banner.blocking.join(", ")}`);
  }
  return banner;
}

async function prepare(page, model) {
  await page.waitFor(
    `document.querySelector('input[type=radio][name="agent-browser-model"][value=${JSON.stringify(model)}]:not([disabled])')`,
    `model ${model} to be selectable`,
    120_000,
  );
  await page.act(
    `(() => { const r = document.querySelector('input[type=radio][name="agent-browser-model"][value=${JSON.stringify(model)}]'); r.click(); return r.checked; })()`,
    `select ${model}`,
  );
  const compatibility = await page.q(
    `(() => { const r = document.querySelector('input[type=radio][name="agent-browser-model"][value=${JSON.stringify(model)}]').closest(".ab-model-row"); return { classes: r.className, text: r.querySelector(".ab-model-head").innerText }; })()`,
  );
  await page.act(`__ab.click("Prepare run")`, "press Prepare run");
  const plan = await page.waitFor(
    `(() => { const t = document.body.innerText; return t.includes("Ready to run") ? true : null; })()`,
    "the run plan to be ready",
    120_000,
  );
  return { compatibility, ready: plan === true };
}

async function fillTask(page, task) {
  // A finished run shows its result; "New run" brings the task form back.
  await page.q(`__ab.click("New run")`);
  await page.waitFor(`document.querySelector("#ab-field-request")`, "the task form");
  await page.act(`__ab.setInput("#ab-field-request", ${JSON.stringify(task.request)})`, "type the request");
  await page.act(`__ab.setChecked(document.querySelector("#ab-field-booking"), ${task.booking})`, "set booking");
  const quote = task.purchase.quote_id;
  const fare = task.purchase.fare_id;
  await page.act(
    `(() => {
      const find = (word) => [...document.querySelectorAll("input")].find((i) => (i.getAttribute("aria-label") || "").toLowerCase().includes(word));
      const q = find("quote id"), f = find("fare id");
      if (!q || !f) return false;
      return __ab.setInput('input[aria-label="' + q.getAttribute("aria-label") + '"]', ${JSON.stringify(quote)})
        && __ab.setInput('input[aria-label="' + f.getAttribute("aria-label") + '"]', ${JSON.stringify(fare)});
    })()`,
    "fill the purchase fields",
  );
}

async function run(page, task, timeoutSeconds) {
  await fillTask(page, task);
  const before = runDirectories();
  await page.waitFor(`document.querySelector('button[data-run="start"]:not([disabled])')`, "the Run button to be enabled", 60_000);
  const started = Date.now();
  await page.act(`(() => { const b = document.querySelector('button[data-run="start"]:not([disabled])'); if (!b) return false; b.click(); return true; })()`, "press Run");
  const outcome = await page.waitFor(
    `(() => {
      const state = __ab.runState();
      const error = document.querySelector(".ab-run .ab-banner-error");
      if (["completed", "failed", "cancelled"].includes(state)) return { state, banner: error ? error.innerText : null };
      const startError = document.querySelector(".ab-run .ab-run-actions .ab-banner-error, .ab-run [role=alert]");
      return null;
    })()`,
    "the run to finish",
    timeoutSeconds * 1000,
    1500,
  );
  const added = [...runDirectories()].filter((name) => !before.has(name));
  const shownRunId = await page.q(
    `(() => { const d = [...document.querySelectorAll(".ab-run dt")].find((dt) => dt.textContent.trim() === "Run"); return d && d.nextElementSibling ? d.nextElementSibling.textContent.trim() : null; })()`,
  );
  return {
    state: outcome.state,
    banner: outcome.banner,
    runId: shownRunId ?? (added.length === 1 ? added[0] : null),
    newRunDirectories: added,
    elapsedMs: Date.now() - started,
    resultText: (await page.q(`__ab.text(document.querySelector(".ab-card.ab-run"))`)).slice(0, 4000),
  };
}

/** The same plan again, after its once grant was spent: the start must be refused. */
async function rerunRefused(page, task) {
  await fillTask(page, task);
  const before = runDirectories();
  await page.waitFor(`document.querySelector('button[data-run="start"]')`, "the Run button");
  const enabled = await page.q(`Boolean(document.querySelector('button[data-run="start"]:not([disabled])'))`);
  let refusal = null;
  if (enabled) {
    await page.q(`document.querySelector('button[data-run="start"]').click()`);
    refusal = await page.waitFor(
      `(() => { const b = document.querySelector(".ab-run .ab-banner-error"); const s = __ab.runState(); return b ? { banner: b.innerText, state: s } : (["running","completed"].includes(s) ? { banner: null, state: s } : null); })()`,
      "the start to be refused",
      120_000,
    );
  } else {
    refusal = { banner: await page.q(`(document.querySelector(".ab-run-reason") || {}).textContent || null`), state: "not_startable" };
  }
  return { enabledBeforePress: enabled, refusal, newRunDirectories: [...runDirectories()].filter((name) => !before.has(name)) };
}

/**
 * The same spent plan, started through the Gateway directly rather than the (disabled) button:
 * the backend's own refusal, not just the page's. Reads the plan identity from the finished
 * run's record; sends the operation the page would send.
 */
function serverReplay(runId, task) {
  const record = JSON.parse(readFileSync(join(RUNS_DIR, runId, "run.json"), "utf8"));
  const before = runDirectories();
  const payload = {
    sessionId: record.sessionId,
    runPlanId: record.runPlanId,
    runPlanSha256: record.runPlanSha256,
    input: task,
  };
  let result = null;
  try {
    const stdout = execFileSync(
      "openclaw",
      ["gateway", "call", "plugins.sessionAction", "--json", "--timeout", "300000", "--params",
        JSON.stringify({ pluginId: "agent-browser", actionId: "execution.start", payload })],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 16 * 1024 * 1024 },
    );
    result = JSON.parse(stdout).result ?? null;
  } catch (error) {
    return { runPlanId: record.runPlanId, refused: null, error: String(error?.message ?? error).slice(0, 300) };
  }
  const refused = Boolean(result && result.ok === false);
  return {
    runPlanId: record.runPlanId,
    refused,
    code: refused ? result.error.code : null,
    detail: refused ? String(result.error.detail ?? result.error.title ?? "").slice(0, 600) : null,
    newRunDirectories: [...runDirectories()].filter((name) => !before.has(name)),
  };
}

// -- the walk ---------------------------------------------------------------------------------
const SEARCH = {
  request: "Find me a flight to Zurich on 9 October under $900.",
  booking: false,
  purchase: { quote_id: "", fare_id: "" },
};
const BOOKING = { request: "Prepare WA101 Standard for 9 October for me.", booking: true, purchase: { quote_id: "", fare_id: "" } };
const BASE = { "network.webair": "session", "model.reasoning": "session", "memory.session": "session" };

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const report = {
    profile: "webair-live-ui-v0",
    recordedAt: new Date().toISOString(),
    site: args.site,
    model: args.model,
    openclaw: execFileSync("openclaw", ["--version"], { encoding: "utf8" }).trim(),
    steps: {},
  };
  if (args.screens) mkdirSync(args.screens, { recursive: true });
  const profile = mkdtempSync(join(tmpdir(), "agent-browser-ui-driver-"));
  const chrome = spawn(args.chrome, [
    "--headless=new",
    "--remote-debugging-port=0",
    `--user-data-dir=${profile}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--window-size=1440,2200",
    "about:blank",
  ], { stdio: "ignore" });
  let cdp;
  try {
    let port;
    for (let i = 0; i < 150 && !port; i += 1) {
      await sleep(100);
      const file = join(profile, "DevToolsActivePort");
      if (existsSync(file)) port = readFileSync(file, "utf8").split("\n")[0];
    }
    if (!port) throw new Error("Chrome did not start");
    const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    cdp = new Cdp(targets.find((target) => target.type === "page").webSocketDebuggerUrl);
    await cdp.open();
    await cdp.send("Page.enable");
    // The one-time owner link; it is used once and never printed.
    const dashboard = JSON.parse(
      execFileSync("openclaw", ["dashboard", "--no-open", "--json"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }),
    );
    await cdp.send("Page.navigate", { url: dashboard.browserUrl });
    const page = new Page(cdp, report);
    await sleep(4000);
    const http = new URL(dashboard.httpUrl);
    await cdp.send("Page.navigate", { url: new URL(PAGE_PATH, http).href });
    await sleep(2500);
    await page.helpers();
    await page.waitFor(`document.querySelector('input[name="package-url"]:not([disabled])')`, "the Agent Browser page", 90_000);

    // 1. the website, by its ordinary address
    await page.act(`__ab.setInput('input[name="package-url"]', ${JSON.stringify(args.site)})`, "type the website");
    await page.act(`__ab.click("Open", document.querySelector("form.ab-address"))`, "press Open");
    const website = await page.waitFor(
      `(() => { const s = __ab.section("website"); if (!s || !s.innerText.includes("advertised")) return null;
        const cand = s.querySelector(".ab-candidate");
        return { text: s.innerText.slice(0, 2000), status: (s.querySelector(".ab-chips") || {}).innerText || null,
          candidate: cand ? cand.querySelector("code").textContent : null,
          candidateChip: cand ? [...cand.querySelectorAll(".ab-item-head span, .ab-item-head .ab-chip")].map((n) => n.textContent.trim()).filter(Boolean) : [],
          inspect: Boolean(cand && [...cand.querySelectorAll("button")].some((b) => b.textContent.trim() === "Inspect agent package")) }; })()`,
      "the website discovery result",
      90_000,
    );
    report.steps.discovery = { ...website, screenshot: await page.screenshot(args.screens, "1-website-discovery", "website") };

    // 2. inspect: download and verify through the control plane
    await page.act(`__ab.click("Inspect agent package")`, "press Inspect agent package");
    const inspected = await page.waitFor(
      `(() => { const s = __ab.section("trust"); if (!s) return null; const t = s.innerText;
        return t.includes("Cryptographically valid") || t.includes("Signature") ? { text: t.slice(0, 2500),
          signatureValid: t.includes("Cryptographically valid"), unknownPublisher: t.includes("Unknown publisher"),
          trusted: t.includes("Trusted by this OpenClaw host"),
          advertised: (document.querySelector(".ab-advertised") || {}).textContent || null } : null; })()`,
      "the package verification",
      120_000,
    );
    report.steps.inspection = { ...inspected, screenshot: await page.screenshot(args.screens, "2-package-verified", "trust") };

    if (!args.alreadyTrusted) {
      if (!inspected.unknownPublisher) throw new Error("the publisher is not 'unknown' before the trust decision");
      // 3. a valid signature from an unknown publisher authorizes nothing
      await setDecisions(page, { ...BASE }, {});
      const refused = await authorize(page, false);
      report.steps.untrustedAuthorization = { ...refused, screenshot: await page.screenshot(args.screens, "3-untrusted-not-runnable", "authorization") };
      if (!refused.blocking.includes("publisher_not_trusted")) throw new Error("expected publisher_not_trusted");

      // 4. the person's explicit trust decision, narrowest scope, confirmed twice
      await page.act(
        `(() => { const d = document.querySelector("details.ab-trust-review"); if (!d) return false; d.open = true;
          return __ab.setSelect('select[aria-label="Trust scope"]', "package"); })()`,
        "open the publisher key review",
      );
      await page.act(`__ab.click("Trust this publisher key", __ab.section("trust"))`, "press Trust this publisher key");
      await page.act(`__ab.click("Confirm: pin this key permanently", __ab.section("trust"))`, "confirm the pin");
      const trusted = await page.waitFor(
        `(() => { const t = __ab.text(__ab.section("trust")); return t.includes("Trusted by this OpenClaw host") ? { text: t.slice(0, 2500) } : null; })()`,
        "the publisher to be trusted",
      );
      report.steps.trust = { ...trusted, scope: "package", screenshot: await page.screenshot(args.screens, "4-publisher-trusted", "trust") };
    }

    const phases = args.phases === "all" ? ["search", "booking", "purchase", "denial"] : args.phases.split(",");

    if (phases.includes("search")) {
      const decisions = { ...BASE, "profile.travel": "session", "identity.passenger": "deny", "wallet.payment": "deny", "booking.simulate_purchase": "deny" };
      await setDecisions(page, decisions, { "profile.travel": "profile_demo_traveler" });
      const authorization = await authorize(page, true);
      const plan = await prepare(page, args.model);
      const outcome = await run(page, SEARCH, args.runTimeout);
      report.steps.search = { decisions, selections: { "profile.travel": "profile_demo_traveler" }, task: SEARCH, authorization, plan, outcome,
        screenshot: await page.screenshot(args.screens, "5-search-result") };
    }

    let quote = null;
    if (phases.includes("booking")) {
      const decisions = { ...BASE, "profile.travel": "deny", "identity.passenger": "session", "wallet.payment": "deny", "booking.simulate_purchase": "deny" };
      await setDecisions(page, decisions, { "identity.passenger": "passenger_demo_alex" });
      const authorization = await authorize(page, true);
      const plan = await prepare(page, args.model);
      const outcome = await run(page, BOOKING, args.runTimeout);
      report.steps.booking = { decisions, selections: { "identity.passenger": "passenger_demo_alex" }, task: BOOKING, authorization, plan, outcome,
        screenshot: await page.screenshot(args.screens, "6-booking-result") };
      if (outcome.runId) {
        const result = JSON.parse(readFileSync(join(RUNS_DIR, outcome.runId, "result.json"), "utf8"));
        const booking = result.output?.booking;
        if (booking) quote = { quote_id: booking.quote_id, fare_id: booking.fare_id };
      }
      report.steps.booking.quote = quote;
    }
    if (!quote && (phases.includes("purchase") || phases.includes("denial"))) {
      if (!args.quote || !args.fare) throw new Error("no quote from a booking run: pass --quote and --fare");
      quote = { quote_id: args.quote, fare_id: args.fare };
    }
    const purchaseTask = quote && { request: `Simulate purchase of quote ${quote.quote_id}.`, booking: false, purchase: quote };

    if (phases.includes("purchase")) {
      const decisions = { ...BASE, "profile.travel": "deny", "identity.passenger": "session", "wallet.payment": "session", "booking.simulate_purchase": "once" };
      const selections = { "identity.passenger": "passenger_demo_alex", "wallet.payment": "payment_demo_visa" };
      await setDecisions(page, decisions, selections);
      const authorization = await authorize(page, true);
      const plan = await prepare(page, args.model);
      const outcome = await run(page, purchaseTask, args.runTimeout);
      const screenshot = await page.screenshot(args.screens, "7-purchase-result");
      const replay = await rerunRefused(page, purchaseTask);
      const replayScreenshot = await page.screenshot(args.screens, "8-once-spent");
      const server = outcome.runId ? serverReplay(outcome.runId, purchaseTask) : null;
      report.steps.purchase = { decisions, selections, task: purchaseTask, authorization, plan, outcome, screenshot,
        sameAuthorizationAgain: { page: replay, server }, replayScreenshot };
    }

    if (phases.includes("denial")) {
      const decisions = { ...BASE, "profile.travel": "deny", "identity.passenger": "session", "wallet.payment": "deny", "booking.simulate_purchase": "deny" };
      const selections = { "identity.passenger": "passenger_demo_alex" };
      await setDecisions(page, decisions, selections);
      const authorization = await authorize(page, true);
      const plan = await prepare(page, args.model);
      const outcome = await run(page, purchaseTask, args.runTimeout);
      report.steps.denial = { decisions, selections, task: purchaseTask, authorization, plan, outcome,
        screenshot: await page.screenshot(args.screens, "9-purchase-denied") };
    }
    report.passed = true;
  } catch (error) {
    report.passed = false;
    report.error = String(error?.message ?? error);
    throw error;
  } finally {
    writeFileSync(args.out, `${JSON.stringify(report, null, 2)}\n`);
    try {
      cdp?.close();
    } catch {
      // closing anyway
    }
    chrome.kill("SIGTERM");
    await sleep(500);
    rmSync(profile, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(`run-webair-live: ${error.message}`);
  process.exit(1);
});
