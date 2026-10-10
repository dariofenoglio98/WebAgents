#!/usr/bin/env node
/**
 * The paper reader in a real Chrome (T6, D-082, D-083): the built extension, headless, runs the
 * reader test package (`test/fixtures/reader-package/`: one `paper.read` call, no model call)
 * over a PDF picked into Settings → Files, so the whole path a Literature Review document takes is
 * exercised where it actually runs: the `files` store in IndexedDB, the attachments resolved at
 * `run.start`, the execution host's Worker, the **nested** `pdf-worker.js` Worker running pdf.js
 * under the extension's CSP, the stored copy re-verified, the broker's audit, the export.
 *
 * The package is built from the fixture source and signed with agentpkg under a throwaway key in a
 * temporary directory (never in the repository); a local HTTPS origin on 127.0.0.1 serves it as
 * `https://reader.example/reader.agent.pkg` (`--host-resolver-rules`, only that certificate's key
 * trusted), so nothing in the extension is relaxed. The run plan binds a local Ollama model the
 * catalog lists (the graph never calls it; the lease only checks it is still offered), so Ollama
 * must be running with `OLLAMA_ORIGINS` allowing the extension. No other network.
 *
 * Checks, recorded in the report (`--out`, default `examples/verification/chrome-paper-reader-e2e.json`):
 *   1. the picked PDF is copied with its SHA-256 and listed without its bytes;
 *   2. a run whose task names it completes; its output pages are the probe document's text;
 *   3. the audit's `tool.settled` names the file by opaque id and SHA-256, the binding is the
 *      selected-PDF reader, the chain is valid, no model request was made;
 *   4. the file's name appears in no exported file and no observation;
 *   5. a task naming a file this browser does not hold is refused (`file_unknown`), and with
 *      `files.pdfs` denied a task naming the picked file is refused (`execution_refused`).
 *
 *   npm run build && node scripts/e2e-paper-reader.mjs [--chrome path] [--model ollama/<id>] [--out report.json] [--keep]
 */
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { Cdp } from "./lib/cdp.mjs";
import { certificate, serveFiles } from "./lib/origin.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const PROJECT = resolve(here, "..");
const ROOT = resolve(PROJECT, "..");
const EXTENSION = join(PROJECT, "dist", "extension");
const AGENTPKG = process.env.AGENTPKG_CLI || join(ROOT, "agentpkg", ".venv", "bin", "agentpkg");
const SOURCE = join(PROJECT, "test", "fixtures", "reader-package");
const PROBE = join(ROOT, "examples", "probe-files", "paper-reader-probe.pdf");
const PICKED_NAME = "paper-reader-probe-picked.pdf";
const SITE_HOST = "reader.example";
const PACKAGE_URL = `https://${SITE_HOST}/reader.agent.pkg`;

const args = { chrome: process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", model: null, out: join(ROOT, "examples", "verification", "chrome-paper-reader-e2e.json"), keep: false };
for (let index = 2; index < process.argv.length; index += 1) {
  const argument = process.argv[index];
  if (argument === "--chrome") args.chrome = process.argv[(index += 1)];
  else if (argument === "--model") args.model = process.argv[(index += 1)];
  else if (argument === "--out") args.out = resolve(process.argv[(index += 1)]);
  else if (argument === "--keep") args.keep = true;
  else {
    console.error(`unknown argument ${argument}`);
    process.exit(2);
  }
}
for (const [path, hint] of [[join(EXTENSION, "manifest.json"), "run `npm run build` first"], [AGENTPKG, "create agentpkg/.venv (CLAUDE.md, Conventions)"], [args.chrome, "pass --chrome <path>"]]) {
  if (!existsSync(path)) {
    console.error(`${path} is missing: ${hint}`);
    process.exit(2);
  }
}

const startedAt = new Date();
const stamp = startedAt.toISOString().replace(/[:.]/gu, "-");
const outDir = join(ROOT, "examples", `my-chrome-reader-${stamp}`);
mkdirSync(outDir, { recursive: true });
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const report = { profile: "chrome-paper-reader-e2e-v0", recordedAt: startedAt.toISOString(), chrome: null, model: null, outputDirectory: relative(ROOT, outDir), package: null, file: null, run: null, refusals: {}, checks: {}, failures: [], passed: false };
const check = (name, condition, detail) => {
  report.checks[name] = condition ? "ok" : { failed: detail ?? null };
  if (!condition) report.failures.push(`${name}${detail === undefined ? "" : ` (${JSON.stringify(detail).slice(0, 300)})`}`);
};
const log = (text) => process.stderr.write(`[${Math.round((Date.now() - startedAt.getTime()) / 1000)}s] ${text}\n`);

/** Build and sign the reader package under a throwaway key, outside the repository. */
function buildPackage(scratch) {
  const built = join(scratch, "reader.unsigned.agent.pkg");
  const signed = join(scratch, "reader.agent.pkg");
  execFileSync(AGENTPKG, ["keygen", "--private-key", join(scratch, "throwaway.private.pem"), "--public-key", join(scratch, "throwaway.pub.pem")], { stdio: "ignore" });
  execFileSync(AGENTPKG, ["build", SOURCE, "-o", built], { stdio: "ignore" });
  execFileSync(AGENTPKG, ["sign", "--private-key", join(scratch, "throwaway.private.pem"), "-o", signed, built], { stdio: "ignore" });
  const verified = JSON.parse(execFileSync(AGENTPKG, ["verify", signed, "--trust-key", join(scratch, "throwaway.pub.pem")], { encoding: "utf8" }));
  return { bytes: readFileSync(signed), digest: verified.digest, fingerprint: verified.key_fingerprint };
}

/** The package at `/reader.agent.pkg`, from the shared harness origin (B-150 item 9). */
function origin(tls, bytes) {
  return serveFiles(tls, { "/reader.agent.pkg": { bytes, type: "application/vnd.webagents.agent-package" } });
}

async function main() {
  // agentpkg refuses an output path with a symlink component, and macOS's temp directory is one (STATE.md §10).
  const scratch = mkdtempSync(join(realpathSync(tmpdir()), "chrome-paper-reader-"));
  const profile = join(scratch, "profile");
  let chrome = null;
  let served = null;
  try {
    const pkg = buildPackage(scratch);
    report.package = { digest: pkg.digest, archiveSha256: sha256(pkg.bytes), bytes: pkg.bytes.length, signer: pkg.fingerprint, note: "built from test/fixtures/reader-package and signed under a throwaway key for this run only" };
    const tls = certificate(scratch, SITE_HOST);
    served = await origin(tls, pkg.bytes);
    chrome = spawn(args.chrome, ["--headless=new", "--remote-debugging-pipe", "--enable-unsafe-extension-debugging", `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check", `--host-resolver-rules=MAP ${SITE_HOST} 127.0.0.1:${served.port}`, `--ignore-certificate-errors-spki-list=${tls.spkiHash}`, "about:blank"], { stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"] });
    const cdp = new Cdp(chrome);
    report.chrome = (await cdp.send("Browser.getVersion")).product;
    const { id: extensionId } = await cdp.send("Extensions.loadUnpacked", { path: EXTENSION });
    const base = `chrome-extension://${extensionId}`;
    await cdp.waitForTarget((target) => target.type === "service_worker" && target.url === `${base}/service-worker.js`, "the service worker");
    const { targetId } = await cdp.send("Target.createTarget", { url: `${base}/browser.html` });
    const page = await cdp.attach(targetId);
    await cdp.waitFor(page, `typeof chrome !== "undefined" && !!chrome.runtime`, "the full page");
    const send = async (request) => {
      const reply = await cdp.evaluate(page, `chrome.runtime.sendMessage(${JSON.stringify(request)})`);
      if (!reply) throw new Error(`no reply to ${request.type}`);
      if (!reply.ok) {
        const error = new Error(`${request.type}: ${reply.error.code}: ${reply.error.message}`);
        error.code = reply.error.code;
        throw error;
      }
      return reply.result;
    };
    const refusal = async (request) => {
      try {
        await send(request);
        return null;
      } catch (error) {
        return error.code ?? error.message;
      }
    };

    // Setup: a local model the plan can bind (never called), test mode on.
    const probe = await send({ type: "models.probe", provider: "ollama" });
    const offered = probe.models.map((model) => model.id);
    const model = args.model ?? (offered.includes("ollama/qwen3:30b") ? "ollama/qwen3:30b" : offered[0]);
    report.model = model ?? null;
    check("Ollama answers and offers a model the plan can bind", probe.ok === true && typeof model === "string" && offered.includes(model), { ok: probe.ok, error: probe.error, offered });
    const settings = (await send({ type: "settings.get" })).settings;
    settings.models.default_model = model;
    settings.developer = { record_requests: true };
    await send({ type: "settings.set", settings });

    // 0. The parser Worker itself, from an extension page: it loads under the extension's CSP and
    // answers for the probe bytes (a direct check that tells a parser failure from a run failure).
    const probeBytes = readFileSync(PROBE);
    report.parserWorker = await cdp.evaluate(page, `new Promise((resolveAnswer) => {
      const bytes = Uint8Array.from(atob(${JSON.stringify(probeBytes.toString("base64"))}), (c) => c.charCodeAt(0));
      const worker = new Worker(chrome.runtime.getURL("pdf-worker.js"), { type: "module" });
      const timer = setTimeout(() => resolveAnswer({ ok: false, reason: "no answer in 30 s" }), 30000);
      worker.onmessage = (event) => { const a = event.data; if (!a || a.kind !== "chrome-agent-browser.pdf-text") return; clearTimeout(timer); worker.terminate(); resolveAnswer(a.ok ? { ok: true, pages: a.result.pages.length, sha256: a.result.sha256, first: String(a.result.pages[0].text).slice(0, 60) } : a); };
      worker.onerror = (event) => { clearTimeout(timer); resolveAnswer({ ok: false, reason: "worker error: " + (event.message || "unknown") }); };
      worker.postMessage({ data: bytes.buffer }, [bytes.buffer]);
    })`);
    check("the parser Worker loads in Chrome and reads the probe PDF", report.parserWorker?.ok === true && report.parserWorker.sha256 === sha256(probeBytes) && report.parserWorker.pages === 2, report.parserWorker);

    // 1. Pick: the probe PDF, under a name that must never leave the extension's views.
    const files = await send({ type: "files.add", name: PICKED_NAME, base64: probeBytes.toString("base64") });
    const file = files.files.find((item) => item.display_name === PICKED_NAME);
    report.file = file ? { file_id: file.file_id, sha256: file.sha256, bytes: file.bytes } : null;
    check("the picked PDF is copied with its SHA-256 and size", file !== undefined && file.sha256 === sha256(probeBytes) && file.bytes === probeBytes.length && /^file_[0-9a-f]{32}$/u.test(file.file_id), files);
    check("the list carries no bytes", file !== undefined && !("data" in file), Object.keys(file ?? {}));

    // 2. Open, trust, authorize, run.
    const view = await send({ type: "package.open", url: PACKAGE_URL, advertisedOn: null, viewId: "e2e" });
    const sessionId = view.session.id;
    await send({ type: "trust.pin", sessionId, signerFingerprint: pkg.fingerprint, scope: "publisher" });
    const decisions = { "files.pdfs": "session", "model.reasoning": "session", "memory.session": "session" };
    const authorized = await send({ type: "authorization.authorize", sessionId, packageDigest: pkg.digest, decisions, toolApprovals: { "paper-reader": true }, resourceSelections: {}, provenance: null, prepare: true });
    const plan = authorized.run_plan?.run_plan ?? null;
    check("the plan is ready and binds the selected-PDF reader", authorized.run_plan?.preflight.ready === true && plan?.tool_bindings.some((binding) => binding.implementation_id === "chrome.tool.selected_pdf_text"), authorized.plan_refused ?? null);
    if (!plan) throw new Error("no run plan");
    const started = await send({ type: "run.start", sessionId, runPlanId: plan.run_plan_id, runPlanSha256: plan.run_plan_sha256, input: { file_id: file.file_id } });
    log(`run ${started.runId} started`);
    const deadline = Date.now() + 120_000;
    let record = started;
    while (!["completed", "failed", "cancelled", "interrupted"].includes(record.status) && Date.now() < deadline) {
      await new Promise((resolveWait) => setTimeout(resolveWait, 500));
      record = await send({ type: "run.get", runId: started.runId });
    }
    const bundle = await send({ type: "run.export", runId: started.runId });
    const exported = {};
    for (const entry of bundle.entries) {
      const bytes = Buffer.from(entry.base64, "base64");
      writeFileSync(join(outDir, entry.name), bytes);
      exported[entry.name] = bytes.toString("utf8");
    }
    const observations = await send({ type: "run.observations", runId: started.runId });
    writeFileSync(join(outDir, "observations.json"), `${JSON.stringify(observations, null, 2)}\n`);
    const result = JSON.parse(exported["result.json"] ?? "{}");
    const audit = JSON.parse(exported["audit.json"] ?? "[]");
    const events = Array.isArray(audit) ? audit : (audit.events ?? []);
    const settled = events.filter((event) => event.action === "tool.settled");
    const dispatched = events.filter((event) => event.action === "tool.dispatched");
    report.run = { runId: started.runId, status: record.status, errorCode: record.errorCode, durationMs: record.durationMs, attachments: record.task?.attachments ?? null, auditEvents: events.length, chainValid: record.audit?.chainValid ?? null, toolSettled: settled.map((event) => ({ tool: event.tool, file_id: event.file_id ?? null, file_sha256: event.file_sha256 ?? null, binding_id: event.binding_id })), exported: bundle.entries.map((entry) => ({ name: entry.name, bytes: entry.bytes, sha256: entry.sha256 })), observations: observations.observations.length };
    check("the run completed", record.status === "completed", { status: record.status, errorCode: record.errorCode, failure: record.failure });
    const pages = result.output?.pages ?? [];
    check("the output is the probe document's pages, read by pdf.js in the nested Worker", pages.length === 2 && String(pages[0]?.text).includes("SYNTHETIC PROBE DOCUMENT") && result.output?.sha256 === sha256(probeBytes), pages.map((item) => String(item.text).slice(0, 80)));
    check("the record's attachments name the file by id and hash", JSON.stringify(record.task?.attachments) === JSON.stringify([{ fileId: file.file_id, sha256: sha256(probeBytes), bytes: probeBytes.length, mediaType: "application/pdf" }]), record.task?.attachments);
    check("the audit names the read by opaque id and SHA-256", settled.length === 1 && settled[0].file_id === file.file_id && settled[0].file_sha256 === sha256(probeBytes), report.run.toolSettled);
    check("the selected-PDF binding answered", dispatched.length === 1 && dispatched[0].binding_id === "chrome:selected_pdf_text:paper-reader:1" && dispatched[0].remote === false, dispatched.map((event) => event.binding_id));
    check("the audit chain is valid", record.audit?.chainValid === true, record.audit);
    check("no model request was made", observations.observations.filter((item) => item.kind === "model").length === 0, observations.observations.length);
    const everything = [...Object.values(exported), JSON.stringify(observations), JSON.stringify(record)].join("\n");
    check("the picked file's name appears in no exported file, record or observation", !everything.includes(PICKED_NAME) && !everything.includes("paper-reader-probe"), null);

    // 5. Refusals before any lease.
    report.refusals.unknownFile = await refusal({ type: "run.start", sessionId, runPlanId: plan.run_plan_id, runPlanSha256: plan.run_plan_sha256, input: { file_id: `file_${"0".repeat(32)}` } });
    check("a task naming a file this browser does not hold is refused", report.refusals.unknownFile === "file_unknown", report.refusals.unknownFile);
    const denied = await send({ type: "authorization.authorize", sessionId, packageDigest: pkg.digest, decisions: { ...decisions, "files.pdfs": "deny" }, toolApprovals: { "paper-reader": true }, resourceSelections: {}, provenance: null, prepare: true });
    const deniedPlan = denied.run_plan?.run_plan;
    report.refusals.filesDenied = deniedPlan ? await refusal({ type: "run.start", sessionId, runPlanId: deniedPlan.run_plan_id, runPlanSha256: deniedPlan.run_plan_sha256, input: { file_id: file.file_id } }) : "no plan";
    check("with files.pdfs denied, a task naming the picked file is refused", report.refusals.filesDenied === "execution_refused", report.refusals.filesDenied);
  } catch (error) {
    report.failures.push(`harness: ${error.message}`);
  } finally {
    if (chrome) {
      const exited = chrome.exitCode !== null ? Promise.resolve() : new Promise((resolveExit) => chrome.once("exit", resolveExit));
      chrome.kill();
      await Promise.race([exited, new Promise((resolveWait) => setTimeout(resolveWait, 10_000))]);
    }
    served?.server.close();
    if (!args.keep) rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
  report.passed = report.failures.length === 0;
  const text = `${JSON.stringify(report, null, 2)}\n`;
  writeFileSync(args.out, text);
  process.stdout.write(text);
  log(`report written to ${relative(ROOT, args.out)}; run files under ${relative(ROOT, outDir)}`);
  process.exit(report.passed ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
