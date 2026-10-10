#!/usr/bin/env node
/**
 * Literature Review live acceptance in Chrome (T6, Demo 4; D-028): the built extension in a real
 * headless Chrome runs the signed Literature Review (0.2.6 by default, `--version 0.2.5` for T6's) with the person's model against the real
 * services the package names (Crossref through the host's Crossref adapter, the hosted Citation
 * Resolver), driving the full page the way a person does:
 *
 *   Settings (test mode, the model, the long-run limits, an optional Crossref contact) →
 *   open the package URL → Trust (two presses) → Use this agent (the Balanced preset; Literature
 *   Review declares no profiles, D-080) → the question (and, with --document, a picked PDF keyed by
 *   its DOI) → Run → the page reloaded mid-run adopts the run → the run settles.
 *
 * The package is served from a local HTTPS origin as `https://research.example/literature-review.agent.pkg`
 * (`--host-resolver-rules`, only that certificate's key trusted); everything else is the real
 * network. The run is exported (run.json, run-plan.json, input.json, the artifacts) with
 * observations.json (every outbound model and tool request body, test mode) and documents.json
 * (each picked PDF's text as the Chrome parser extracts it, `node dist/cli.js pdf-text`, for the
 * quote checks) under `--out-dir`; the report names them. `scripts/verify_chrome_literature_live.py`
 * recomputes the checks; nothing here decides one beyond what the harness itself observed.
 *
 *   npm run build && node scripts/e2e-literature-live.mjs --model openai/gpt-5.6-luna
 *        [--input examples/literature-review-live-input.json] [--document DOI=/abs/paper.pdf]...
 *        [--crossref-contact you@example.org] [--out report.json] [--out-dir examples/my-chrome-lit-<ts>]
 *        [--chrome path] [--no-reload] [--think] [--keep] [--version 0.2.6]
 *        [--context-tokens N] [--reasoning-effort low|medium|high] [--manual] [--package dev.agent.pkg --out x.json]
 *   `--manual` (a person's walk-through, T10): a visible Chrome with the same setup, the package
 *   served, opened and its key trusted; the harness then stops driving and waits until you close
 *   the window. Nothing is run for you and no report is written.
 *   `--context-tokens` states the model's context in Settings → Models (a hosted model the catalog
 *   has no figure for, such as gpt-5.6-sol); `--reasoning-effort` sets the OpenAI connection's
 *   effort (D-123; default medium).
 *   A hosted model needs OPENAI_API_KEY or ANTHROPIC_API_KEY in the environment; the key is typed
 *   into this throwaway profile's storage and written nowhere by this script. A local Ollama model
 *   gets the explicit 65,536 / 16,384 limits the reference host used (STATE.md §5); `--think` turns
 *   on Settings → Models → "Let local models think", as the reference's accepted local runs had it.
 */
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:https";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { Cdp, sleep } from "./lib/cdp.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const PROJECT = resolve(here, "..");
const ROOT = resolve(PROJECT, "..");
const EXTENSION = join(PROJECT, "dist", "extension");
const CLI = join(PROJECT, "dist", "cli.js");
const SITE_HOST = "research.example";
const PACKAGE_URL = `https://${SITE_HOST}/literature-review.agent.pkg`;
/** The reference host's configuration for Literature Review (STATE.md §4), the "long-run limits" of Settings (D-084). */
const LONG_RUN_LIMITS = { total_tokens: 180_000, max_remote_calls: 45, max_parallel_workers: 3, max_output_tokens_per_call: 16_000, run_timeout_seconds: 4_500, max_calls_per_tool: 32, model_call_timeout_seconds: 1_200 };
const TERMINAL = ["completed", "failed", "cancelled", "interrupted"];

const args = { chrome: process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", model: null, input: join(ROOT, "examples", "literature-review-live-input.json"), documents: [], contact: null, out: null, outDir: null, reload: true, think: false, keep: false, version: "0.2.6", contextTokens: null, effort: null, manual: false, package: null };
for (let index = 2; index < process.argv.length; index += 1) {
  const argument = process.argv[index];
  if (argument === "--chrome") args.chrome = process.argv[(index += 1)];
  else if (argument === "--model") args.model = process.argv[(index += 1)];
  else if (argument === "--input") args.input = resolve(process.argv[(index += 1)]);
  else if (argument === "--document") {
    const value = process.argv[(index += 1)] ?? "";
    const equals = value.indexOf("=");
    if (equals <= 0) {
      console.error("--document takes DOI=/path/to/paper.pdf");
      process.exit(2);
    }
    args.documents.push({ doi: value.slice(0, equals), path: resolve(value.slice(equals + 1)) });
  } else if (argument === "--crossref-contact") args.contact = process.argv[(index += 1)];
  else if (argument === "--out") args.out = resolve(process.argv[(index += 1)]);
  else if (argument === "--out-dir") args.outDir = resolve(process.argv[(index += 1)]);
  else if (argument === "--no-reload") args.reload = false;
  else if (argument === "--think") args.think = true;
  else if (argument === "--keep") args.keep = true;
  else if (argument === "--version") args.version = process.argv[(index += 1)];
  else if (argument === "--context-tokens") args.contextTokens = Number(process.argv[(index += 1)]);
  else if (argument === "--reasoning-effort") args.effort = process.argv[(index += 1)];
  else if (argument === "--manual") args.manual = true;
  else if (argument === "--package") args.package = resolve(process.argv[(index += 1)]);
  else {
    console.error(`unknown argument ${argument}`);
    process.exit(2);
  }
}
if (!/^0\.2\.[5-9]$/u.test(args.version)) {
  console.error("--version names a signed Literature Review in dist/ (0.2.5 or later)");
  process.exit(2);
}
if (args.contextTokens !== null && !(Number.isInteger(args.contextTokens) && args.contextTokens > 0)) {
  console.error("--context-tokens must be a positive integer");
  process.exit(2);
}
if (args.effort !== null && !["low", "medium", "high"].includes(args.effort)) {
  console.error("--reasoning-effort is low, medium or high");
  process.exit(2);
}
// `--package` (T15): a development build of `--version`, signed by any key (the page pins it like a
// publisher's); its report must be written outside examples/verification (`--out`), never as evidence.
const PACKAGE = args.package ?? join(ROOT, "dist", `literature-review-${args.version}.agent.pkg`);
if (args.package !== null && (args.out === null || args.out.startsWith(join(ROOT, "examples", "verification")))) {
  console.error("--package needs --out outside examples/verification: a development build is not evidence");
  process.exit(2);
}
// T6's report keeps its name; a later version's report is named after it and never overwrites it.
if (args.out === null) args.out = join(ROOT, "examples", "verification", args.version === "0.2.5" ? "chrome-literature-review-live.json" : `chrome-literature-review-${args.version.replaceAll(".", "")}-live.json`);
if (!args.model || !args.model.includes("/")) {
  console.error("--model provider/model is required (ollama/qwen3:30b, openai/<id>, anthropic/<id>)");
  process.exit(2);
}
for (const [path, hint] of [[join(EXTENSION, "manifest.json"), "run `npm run build` first"], [CLI, "run `npm run build` first"], [PACKAGE, `the signed Literature Review ${args.version} (dist/README.md)`], [args.input, "--input"], [args.chrome, "--chrome"], ...args.documents.map((item) => [item.path, `--document ${item.doi}`])]) {
  if (!existsSync(path)) {
    console.error(`${path} is missing: ${hint}`);
    process.exit(2);
  }
}
const provider = args.model.split("/")[0];
const keyEnv = provider === "openai" ? "OPENAI_API_KEY" : provider === "anthropic" ? "ANTHROPIC_API_KEY" : null;
if (keyEnv && !process.env[keyEnv]) {
  console.error(`${keyEnv} must be set for ${args.model}`);
  process.exit(2);
}

const startedAt = new Date();
const stamp = startedAt.toISOString().replace(/[:.]/gu, "-");
const outDir = args.outDir ?? join(ROOT, "examples", `my-chrome-lit-${stamp}`);
// A manual walk-through writes no run files (T10 review 1, nit 3).
if (!args.manual) mkdirSync(outDir, { recursive: true });
// The effort a run gets when none is chosen, read from the adapter's own constant (T10 review 1, nit 8).
const DEFAULT_EFFORT = /export const DEFAULT_OPENAI_REASONING_EFFORT: OpenAIReasoningEffort = "(\w+)";/u.exec(readFileSync(join(PROJECT, "src", "core", "models", "adapters", "openai.ts"), "utf8"))?.[1];
if (!DEFAULT_EFFORT) {
  console.error("DEFAULT_OPENAI_REASONING_EFFORT not found in src/core/models/adapters/openai.ts");
  process.exit(2);
}
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const log = (text) => process.stderr.write(`[${Math.round((Date.now() - startedAt.getTime()) / 1000)}s] ${text}\n`);

const report = {
  profile: "chrome-literature-review-live-v0",
  recordedAt: startedAt.toISOString(),
  model: args.model,
  think: args.think,
  contextTokens: args.contextTokens,
  reasoningEffort: provider === "openai" ? (args.effort ?? `${DEFAULT_EFFORT} (default)`) : null,
  package: { path: relative(ROOT, PACKAGE), archiveSha256: sha256(readFileSync(PACKAGE)), servedAs: PACKAGE_URL },
  input: relative(ROOT, args.input),
  documents: args.documents.map((item) => ({ doi: item.doi, file: basename(item.path), sha256: sha256(readFileSync(item.path)) })),
  crossrefContact: args.contact ? "set (not recorded)" : null,
  extension: relative(ROOT, EXTENSION),
  chrome: null,
  outputDirectory: relative(ROOT, outDir),
  steps: {},
  run: null,
  failures: [],
  passed: false,
};
const check = (step, name, condition, detail) => {
  report.steps[step] ??= {};
  report.steps[step][name] = condition ? "ok" : { failed: detail ?? null };
  if (!condition) report.failures.push(`${step}: ${name}${detail === undefined ? "" : ` (${JSON.stringify(detail).slice(0, 300)})`}`);
};

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
  setSelect(selector, value) {
    const node = document.querySelector(selector);
    if (!node || ![...node.options].some((o) => o.value === value)) return false;
    node.value = value;
    node.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  },
  field(name) { return document.querySelector('label[for="ab-field-' + name + '"]')?.closest(".ab-field") ?? null; },
  setLastEntry(name, value) {
    const inputs = [...(this.field(name)?.querySelectorAll("input.ab-input") ?? [])];
    const node = inputs[inputs.length - 1];
    if (!node || node.value !== "") return false;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(node, value);
    node.dispatchEvent(new Event("input", { bubbles: true }));
    return true;
  },
  runState() { const node = document.querySelector(".ab-run"); return node ? node.dataset.state : null; },
  runButton() { const node = document.querySelector(".ab-run-button"); return node ? { disabled: node.disabled, label: node.textContent, reason: document.querySelector(".ab-run-reason")?.textContent ?? null } : null; },
  session() { return document.querySelector("article.ab-agent")?.dataset.session ?? null; },
  trust() { return document.querySelector("article.ab-agent")?.dataset.trust ?? null; },
  progress() { const node = document.querySelector(".ab-progress"); return node ? node.textContent.replace(/\s+/g, " ").slice(0, 300) : null; },
  async send(request) { return chrome.runtime.sendMessage(request); },
};
true;
`;

function certificate(directory) {
  const key = join(directory, "key.pem");
  const cert = join(directory, "cert.pem");
  execFileSync("openssl", ["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-nodes", "-keyout", key, "-out", cert, "-days", "2", "-subj", `/CN=${SITE_HOST}`, "-addext", `subjectAltName=DNS:${SITE_HOST}`], { stdio: ["ignore", "ignore", "ignore"] });
  const spki = execFileSync("openssl", ["pkey", "-pubin", "-outform", "der"], { input: execFileSync("openssl", ["x509", "-in", cert, "-pubkey", "-noout"]) });
  return { key: readFileSync(key), cert: readFileSync(cert), spkiHash: createHash("sha256").update(spki).digest("base64") };
}

function origin(tls, bytes) {
  const server = createServer({ key: tls.key, cert: tls.cert }, (request, response) => {
    if (request.url === "/literature-review.agent.pkg") {
      response.writeHead(200, { "content-type": "application/vnd.webagents.agent-package", "content-length": String(bytes.length), "cache-control": "no-cache" });
      return response.end(bytes);
    }
    response.writeHead(404, { "content-type": "text/plain" });
    response.end("not found");
  });
  return new Promise((resolveServer) => server.listen(0, "127.0.0.1", () => resolveServer({ server, port: server.address().port })));
}

async function main() {
  const scratch = mkdtempSync(join(realpathSync(tmpdir()), "chrome-literature-live-"));
  const profile = join(scratch, "profile");
  let chrome = null;
  let served = null;
  try {
    const tls = certificate(scratch);
    served = await origin(tls, readFileSync(PACKAGE));
    chrome = spawn(args.chrome, [...(args.manual ? [] : ["--headless=new"]), "--remote-debugging-pipe", "--enable-unsafe-extension-debugging", `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check", `--host-resolver-rules=MAP ${SITE_HOST} 127.0.0.1:${served.port}`, `--ignore-certificate-errors-spki-list=${tls.spkiHash}`, args.manual ? "--window-size=1400,1000" : "--window-size=1280,2200", "about:blank"], { stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"] });
    const cdp = new Cdp(chrome);
    report.chrome = (await cdp.send("Browser.getVersion")).product;
    const { id: extensionId } = await cdp.send("Extensions.loadUnpacked", { path: EXTENSION });
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

    // 0. Settings, through the extension's own messages: test mode, the model (and its limits for a
    // local model), the long-run limits, the optional Crossref contact, a hosted key from the environment.
    const settings = (await send({ type: "settings.get" })).settings;
    settings.developer = { record_requests: true };
    settings.models.default_model = args.model;
    settings.limits = { ...LONG_RUN_LIMITS };
    settings.services = { crossref_contact: args.contact };
    settings.models.connections = settings.models.connections.map((connection) => {
      if (connection.provider !== provider) return connection;
      const modelId = args.model.slice(provider.length + 1);
      const overrides = provider === "ollama" ? { ...connection.overrides, [modelId]: { context_tokens: args.contextTokens ?? 65_536, max_output_tokens: 16_384 } } : args.contextTokens !== null ? { ...connection.overrides, [modelId]: { ...connection.overrides[modelId], context_tokens: args.contextTokens } } : connection.overrides;
      return { ...connection, enabled: true, ...(provider === "ollama" ? { think: args.think } : {}), ...(provider === "openai" && args.effort !== null ? { reasoning_effort: args.effort } : {}), overrides };
    });
    await send({ type: "settings.set", settings });
    if (keyEnv) await send({ type: "settings.setKey", provider, key: process.env[keyEnv] });
    const probe = await send({ type: "models.probe", provider });
    report.steps.setup = { probe: { ok: probe.ok, models: probe.models.length, error: probe.error }, testMode: true, keyFromEnvironment: keyEnv, limits: LONG_RUN_LIMITS };
    check("setup", `the ${provider} connection answers`, probe.ok === true, probe.error);
    check("setup", "the model is offered", probe.models.some((model) => model.id === args.model), probe.models.map((model) => model.id));
    const status = await send({ type: "status.get" });
    check("setup", "execution is enabled under the long-run limits", status.execution === "enabled" && status.execution_limits?.run_timeout_seconds === LONG_RUN_LIMITS.run_timeout_seconds, status.execution_limits);

    // 1. Picked documents (Settings → Files), copied into this browser.
    const picked = [];
    for (const item of args.documents) {
      const bytes = readFileSync(item.path);
      const view = await send({ type: "files.add", name: basename(item.path), base64: bytes.toString("base64") });
      const file = view.files.at(-1);
      picked.push({ doi: item.doi, file_id: file.file_id, sha256: file.sha256, bytes: file.bytes, path: item.path });
    }
    report.steps.files = picked.map((item) => ({ doi: item.doi, file_id: item.file_id, sha256: item.sha256, bytes: item.bytes }));

    // 2. Open the package by URL → Trust (two presses) → Use this agent.
    await cdp.evaluate(page, `__ab.setInput('input[name="package-url"]', ${JSON.stringify(PACKAGE_URL)}) && __ab.click("Open", document.querySelector("form.ab-address"))`);
    const sessionId = await cdp.waitFor(page, `__ab.session()`, "the agent page", 60_000);
    const inspected = await send({ type: "package.get", sessionId });
    report.steps.inspect = { sessionId, name: inspected.page.identity.name, version: inspected.page.identity.version, digest: inspected.page.technical.digest, signature: inspected.page.trust.signature_status };
    check("inspect", `Literature Review ${args.version}, signed`, inspected.page.identity.version === args.version && inspected.page.trust.signature_status === "valid", report.steps.inspect);
    if (inspected.page.trust.trust_status !== "trusted") {
      await cdp.waitFor(page, `__ab.click("Trust this publisher key", document.querySelector(".ab-pin"))`, "the trust control");
      await cdp.evaluate(page, `__ab.click("Press again to trust this key", document.querySelector(".ab-pin"))`);
    }
    await cdp.waitFor(page, `__ab.trust() === "trusted"`, "the trusted agent page");
    if (args.manual) {
      log(`manual mode: Chrome shows Literature Review ${args.version} (${PACKAGE_URL}), its key trusted, ${args.model} the default model. Press "Use this agent", type your question, Run. Settings → Models and Runs are in the same window. Close the window when you are done.`);
      await new Promise((resolveExit) => (chrome.exitCode !== null ? resolveExit() : chrome.once("exit", resolveExit)));
      return;
    }
    await cdp.waitFor(page, `__ab.click("Use this agent")`, "the Use this agent button", 60_000);
    const authorization = await cdp.waitFor(page, `__ab.send({ type: "authorization.get", sessionId: ${JSON.stringify(sessionId)} }).then((r) => r.ok && r.result.receipt && r.result.run_plan ? r.result : null)`, "a receipt and a run plan", 180_000, 500);
    const plan = authorization.run_plan.run_plan;
    report.steps.authorization = { decisions: authorization.receipt.decisions, ready: authorization.run_plan.preflight.ready, runPlanId: plan.run_plan_id, bindings: plan.tool_bindings.map((binding) => ({ tool: binding.tool_id, implementation: binding.implementation_id, binding_id: binding.binding_id, usable: binding.usable, contact: binding.credentials_configured })) };
    check("authorization", "the plan is ready", authorization.run_plan.preflight.ready === true, authorization.run_plan.preflight.blocking_reasons ?? null);
    check("authorization", "the three tools bind to the host's Crossref search, the declared resolver and the PDF reader", JSON.stringify(plan.tool_bindings.map((binding) => [binding.tool_id, binding.implementation_id]).sort()) === JSON.stringify([["citation-resolver", "chrome.tool.json_http"], ["paper-reader", "chrome.tool.selected_pdf_text"], ["scholarly-search", "chrome.tool.crossref_works_search"]]), report.steps.authorization.bindings);

    // 3. The task: the question from --input, the picked documents through the form's picker.
    const task = JSON.parse(readFileSync(args.input, "utf8"));
    await cdp.waitFor(page, `document.querySelector("textarea#ab-field-question") !== null`, "the task form", 60_000);
    await cdp.evaluate(page, `__ab.setInput("textarea#ab-field-question", ${JSON.stringify(task.question)})`);
    for (const seed of task.seeds ?? []) {
      // Seed papers (T15): one "Add" per entry in the optional Seed papers list, then type it.
      await cdp.waitFor(page, `__ab.click("Add", __ab.field("seeds"))`, "the seeds Add button", 30_000);
      await cdp.waitFor(page, `__ab.setLastEntry("seeds", ${JSON.stringify(seed)})`, "the new seed field", 10_000);
    }
    for (const [index, item] of picked.entries()) {
      // The picker lists the picked files once the run surface has read them (event.files); add a row per document.
      await cdp.waitFor(page, `__ab.click("Add a document")`, "the Add a document button", 30_000);
      await cdp.waitFor(page, `__ab.setInput('input[aria-label="Documents ${index + 1} Paper DOI"]', ${JSON.stringify(item.doi)})`, "the DOI field", 10_000);
      await cdp.waitFor(page, `__ab.setSelect('select[aria-label="Documents ${index + 1} document"]', ${JSON.stringify(item.file_id)})`, "the document picker", 10_000);
    }
    const button = await cdp.waitFor(page, `(() => { const b = __ab.runButton(); return b && !b.disabled ? b : null; })()`, "Run enabled", 60_000);
    await cdp.evaluate(page, `document.querySelector(".ab-run-button").click(); true`);
    const summary = await cdp.waitFor(page, `__ab.send({ type: "run.list", sessionId: ${JSON.stringify(sessionId)} }).then((r) => r.ok && r.result.runs[0] ? r.result.runs[0] : null)`, "the run record", 60_000);
    const runId = summary.runId;
    log(`run ${runId} started (${button.label})`);

    // 4. Reconnect: the page reloaded mid-run adopts the run in flight.
    if (args.reload) {
      await cdp.waitFor(page, `__ab.send({ type: "run.get", runId: ${JSON.stringify(runId)} }).then((r) => r.ok && r.result && (r.result.status === "running" || ${JSON.stringify(TERMINAL)}.includes(r.result.status)) ? r.result.status : null)`, "the run to be running", 300_000, 1000);
      await cdp.send("Page.reload", {}, page);
      await ready();
      const shown = await cdp.waitFor(page, `__ab.send({ type: "run.list", sessionId: ${JSON.stringify(sessionId)} }).then((r) => r.ok ? (r.result.active ? r.result.active.runId : r.result.runs[0]?.runId) : null)`, "the adopted run id", 60_000);
      const state = await cdp.waitFor(page, `(() => { const s = __ab.runState(); return s && s !== "idle" ? s : null; })()`, "the reloaded page to show the run", 60_000);
      report.steps.reconnect = { shown, state };
      check("reconnect", "the reloaded page shows the run in flight", shown === runId, report.steps.reconnect);
    }

    // 5. Follow the run to its end (the long-run limit is 4,500 s), logging the progress line.
    let record = null;
    let last = "";
    const deadline = Date.now() + (LONG_RUN_LIMITS.run_timeout_seconds + 600) * 1000;
    while (Date.now() < deadline) {
      record = await send({ type: "run.get", runId });
      if (record && TERMINAL.includes(record.status)) break;
      const progress = record?.progress ? `${record.status} · nodes ${record.progress.nodes_completed} · workers ${record.progress.workers_active}/${record.progress.workers_spawned} · model ${record.progress.model_calls_completed}/${record.progress.model_calls_started} · tools ${record.progress.tool_calls_completed}/${record.progress.tool_calls_started} · tokens ${record.progress.tokens}` : (record?.status ?? "unknown");
      if (progress !== last) {
        log(progress);
        last = progress;
      }
      await sleep(5000);
    }
    if (!record || !TERMINAL.includes(record.status)) throw new Error(`the run did not settle (${record?.status ?? "unknown"})`);
    const pageState = await cdp.waitFor(page, `(() => { const s = __ab.runState(); return s && ${JSON.stringify(TERMINAL)}.includes(s) ? s : null; })()`, "the page to show the settled run", 60_000).catch(() => null);

    // 6. Export: the run directory, the observations and the picked documents' text.
    const bundle = await send({ type: "run.export", runId });
    for (const entry of bundle.entries) writeFileSync(join(outDir, entry.name), Buffer.from(entry.base64, "base64"));
    const observations = await send({ type: "run.observations", runId });
    writeFileSync(join(outDir, "observations.json"), `${JSON.stringify(observations, null, 2)}\n`);
    const documents = picked.map((item) => ({ doi: item.doi, file_id: item.file_id, sha256: item.sha256, extraction: JSON.parse(execFileSync(process.execPath, [CLI, "pdf-text", item.path], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })) }));
    writeFileSync(join(outDir, "documents.json"), `${JSON.stringify({ parser: "node chrome-agent-browser/dist/cli.js pdf-text (the run's own parser, pdf.js)", documents }, null, 2)}\n`);
    report.run = {
      runId,
      status: record.status,
      errorCode: record.errorCode,
      pageState,
      durationMs: record.durationMs,
      selectedModel: record.selectedModel?.hostModelId ?? null,
      model: record.model,
      usage: record.usage ? { tokens: record.usage.tokens, remoteCalls: record.usage.remoteCalls, toolCalls: record.usage.toolCalls, peakParallelWorkers: record.usage.peakParallelWorkers } : null,
      cost: record.cost,
      audit: record.audit ? { events: record.audit.events, chainValid: record.audit.chainValid } : null,
      attachments: record.task?.attachments ?? [],
      failure: record.failure,
      files: bundle.entries.map((entry) => ({ name: entry.name, bytes: entry.bytes, sha256: entry.sha256 })),
      observations: observations.observations.length,
    };
    check("run", "settled as completed (the honest-empty outcome is a completed run)", record.status === "completed", { status: record.status, errorCode: record.errorCode, failure: record.failure });
    check("run", "the audit chain is valid", record.audit?.chainValid === true, record.audit);
  } catch (error) {
    report.failures.push(`harness: ${error.message}`);
  } finally {
    if (chrome) {
      const exited = chrome.exitCode !== null || chrome.signalCode !== null ? Promise.resolve() : new Promise((resolveExit) => chrome.once("exit", resolveExit));
      chrome.kill();
      await Promise.race([exited, sleep(10_000)]);
    }
    served?.server.close();
    if (!args.keep) rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    // A manual walk-through ends here on every path, its window closed or a setup check failed (T10 review 1, nit 3).
    if (args.manual) {
      if (report.failures.length > 0) console.error(report.failures.join("\n"));
      process.exit(report.failures.length > 0 ? 1 : 0);
    }
  }
  report.passed = report.failures.length === 0;
  const text = `${JSON.stringify(report, null, 2)}\n`;
  // A failed attempt never replaces a report that passed (the committed evidence is the default `--out`).
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
  log(`report written to ${relative(ROOT, out)}; run files under ${relative(ROOT, outDir)}; next: agentpkg/.venv/bin/python scripts/verify_chrome_literature_live.py${out === args.out ? "" : ` --report ${relative(ROOT, out)}`}`);
  process.exit(report.passed ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
