#!/usr/bin/env node
/**
 * compute.v0 in a real Chrome (T22, D-250, D-251, D-253): the built extension, headless, runs
 * WebAssembly modules where they actually run: the offscreen document's run Worker, one **nested**
 * `compute-worker.js` Worker per call, under the extension's CSP (`'wasm-unsafe-eval'`, which
 * permits compiling a module and nothing else). Packages served by a local HTTPS origin:
 *
 *   - `compute-test` 0.1.0's source (examples/compute): two modules, five calls (a wave on two
 *     workers and the coordinator, a map step); its output must equal the Python reference's
 *     (`agentpkg run --mode fixture` on the signed 0.1.0);
 *   - a runaway probe (the enforcement case `deadline`: a module that never returns, wall bound
 *     0.5 s), built by `conformance/drivers/compute_probe.py` and signed under a throwaway key: the
 *     deadline terminates the call's Worker and the run fails `compute_error` with reason
 *     `deadline`, recorded by a run Worker that is still there to record it;
 *   - the same module with the default 10 s bound, cancelled one second in: the run is `cancelled`
 *     at once, not when the bound passes;
 *   - the two indirect-call cases (N-27): a `call_indirect` through a null table slot and one whose
 *     type is not the slot function's. Chrome's V8 names these two traps apart, so the runs fail
 *     `compute_error` with the reference's codes, `indirect_call_to_null` and `bad_signature`
 *     (Node 26.9's V8 names both a signature mismatch, which is why conformance folds them: C-42,
 *     D-254). V8's own words for both are recorded from a dedicated Worker on the local origin.
 *
 * A browser run is always model-backed (`execution_mode_permission_undeclared` refuses a package
 * without a model permission), so each package is given one optional, unused model permission, as
 * the paper reader's test package declares, and is signed under a throwaway key. The plan binds a
 * local Ollama model the catalog lists (no graph here calls a model; the lease only checks it is
 * still offered), so Ollama must be running with `OLLAMA_ORIGINS` allowing the extension. No other
 * network.
 *
 *   npm run build && node scripts/e2e-compute.mjs [--chrome path] [--model ollama/<id>] [--out report.json] [--keep]
 */
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { Cdp } from "./lib/cdp.mjs";
import { grantedBuild } from "./lib/granted-build.mjs";
import { certificate, serveFiles } from "./lib/origin.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const PROJECT = resolve(here, "..");
const ROOT = resolve(PROJECT, "..");
const EXTENSION = join(PROJECT, "dist", "extension");
const AGENTPKG = process.env.AGENTPKG_CLI || join(ROOT, "agentpkg", ".venv", "bin", "agentpkg");
const PYTHON = process.env.AGENTPKG_PYTHON || join(ROOT, "agentpkg", ".venv", "bin", "python");
const COMPUTE_TEST = join(ROOT, "examples", "compute", "compute-test.agent.pkg");
const COMPUTE_TEST_SOURCE = join(ROOT, "examples", "compute", "compute-test");
const COMPUTE_TEST_KEY = join(ROOT, "examples", "keys", "compute-test-publisher.pub.pem");
const COMPUTE_TEST_GRANTS = join(ROOT, "examples", "compute", "compute-test-grants.json");
const FARES = join(ROOT, "examples", "compute", "fares-as", "dist", "fares.wasm");
const CASE_MODULES = join(ROOT, "examples", "compute", "cases", "modules");
/** The indirect-call cases (N-27) and the trap code the reference, and Chrome, report for each. */
const INDIRECT_CALL_CASES = { "indirect-call-null": "indirect_call_to_null", "indirect-call-bad-signature": "bad_signature" };
/** A dedicated Worker that runs each case module's `run` and answers V8's own error words. */
const TRAP_WORDS_WORKER = `onmessage = async (event) => {
  const answers = {};
  for (const [id, url] of Object.entries(event.data)) {
    try {
      const { instance } = await WebAssembly.instantiate(await (await fetch(url)).arrayBuffer(), {});
      instance.exports.run(1024, 0);
      answers[id] = { returned: true };
    } catch (error) {
      answers[id] = { name: error && error.name, message: String(error && error.message) };
    }
  }
  postMessage(answers);
};
`;
const SITE_HOST = "compute.example";

const args = { chrome: process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", model: null, out: join(ROOT, "examples", "verification", "chrome-compute-e2e.json"), keep: false };
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
for (const [path, hint] of [[join(EXTENSION, "manifest.json"), "run `npm run build` first"], [AGENTPKG, "create agentpkg/.venv with the compute extra (CLAUDE.md, Conventions)"], [args.chrome, "pass --chrome <path>"]]) {
  if (!existsSync(path)) {
    console.error(`${path} is missing: ${hint}`);
    process.exit(2);
  }
}

const startedAt = new Date();
const stamp = startedAt.toISOString().replace(/[:.]/gu, "-");
const outDir = join(ROOT, "examples", `my-chrome-compute-${stamp}`);
mkdirSync(outDir, { recursive: true });
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const report = { profile: "chrome-compute-e2e-v0", recordedAt: startedAt.toISOString(), chrome: null, v8: null, model: null, outputDirectory: relative(ROOT, outDir), csp: null, packages: {}, computeWorker: null, trapWords: null, runs: {}, checks: {}, failures: [], passed: false };
const check = (name, condition, detail) => {
  report.checks[name] = condition ? "ok" : { failed: detail ?? null };
  if (!condition) report.failures.push(`${name}${detail === undefined ? "" : ` (${JSON.stringify(detail).slice(0, 400)})`}`);
};
const log = (text) => process.stderr.write(`[${Math.round((Date.now() - startedAt.getTime()) / 1000)}s] ${text}\n`);
const verify = (archive, key) => JSON.parse(execFileSync(AGENTPKG, ["verify", archive, "--trust-key", key], { encoding: "utf8" }));

/** An optional model permission the graph never uses, so that a browser run plan can bind a model. */
function withModelPermission(source) {
  const path = join(source, "policy", "policy.json");
  const policy = JSON.parse(readFileSync(path, "utf8"));
  policy.permissions.push({ id: "model.unused", kind: "model", description: "Not used by this graph; declared so a browser run plan can bind a model.", required: false, resources: ["host-router"] });
  writeFileSync(path, `${JSON.stringify(policy, null, 2)}\n`);
}

/** A change for `probe`: the package under its own id. */
const renamed = (packageId) => (source) => {
  const manifestPath = join(source, "MANIFEST.agent");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  manifest.package_id = packageId;
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
};

/**
 * A package for this run, built and signed under the throwaway key: an enforcement-case probe
 * written by the conformance driver, or a copy of a source tree.
 */
function probe(scratch, caseId, name, change = null, copyFrom = null) {
  const source = join(scratch, `probe-${name}`);
  if (copyFrom) cpSync(copyFrom, source, { recursive: true, filter: (path) => !path.endsWith(".DS_Store") });
  else execFileSync(PYTHON, [join(ROOT, "conformance", "drivers", "compute_probe.py"), source, caseId], { stdio: "ignore" });
  withModelPermission(source);
  if (change) change(source);
  const built = join(scratch, `${name}.unsigned.agent.pkg`);
  const signed = join(scratch, `${name}.agent.pkg`);
  const quiet = { stdio: ["ignore", "ignore", "pipe"] };
  try {
    // One throwaway key per package: a pin is scoped to the publisher the package claims.
    execFileSync(AGENTPKG, ["keygen", "--private-key", join(scratch, `${name}.private.pem`), "--public-key", join(scratch, `${name}.pub.pem`)], quiet);
    execFileSync(AGENTPKG, ["build", source, "-o", built], quiet);
    execFileSync(AGENTPKG, ["sign", "--private-key", join(scratch, `${name}.private.pem`), "-o", signed, built], quiet);
  } catch (error) {
    throw new Error(`${caseId}: ${String(error.stderr ?? error.message).trim().split("\n").pop()}`);
  }
  const verified = verify(signed, join(scratch, `${name}.pub.pem`));
  return { bytes: readFileSync(signed), digest: verified.digest, fingerprint: verified.key_fingerprint };
}

async function main() {
  const scratch = mkdtempSync(join(realpathSync(tmpdir()), "chrome-compute-"));
  const profile = join(scratch, "profile");
  let chrome = null;
  let served = null;
  try {
    const computeTest = probe(scratch, null, "compute-test", null, COMPUTE_TEST_SOURCE);
    const runaway = probe(scratch, "deadline", "runaway");
    // The same module under the default wall bound (10 s), for the cancellation.
    const long = probe(scratch, "deadline", "long", (source) => {
      const path = join(source, "graph.json");
      const graph = JSON.parse(readFileSync(path, "utf8"));
      delete graph.nodes[0].limits;
      graph.nodes[0].timeout_seconds = 60;
      writeFileSync(path, `${JSON.stringify(graph, null, 2)}\n`);
      renamed("org.webagents.conformance.compute-long")(source);
    });
    const indirect = Object.fromEntries(Object.keys(INDIRECT_CALL_CASES).map((caseId) => [caseId, probe(scratch, caseId, caseId, renamed(`org.webagents.conformance.compute-${caseId}`))]));
    for (const [name, pkg] of Object.entries({ computeTest, runaway, long, ...indirect })) report.packages[name] = { digest: pkg.digest, archiveSha256: sha256(pkg.bytes), bytes: pkg.bytes.length, signer: pkg.fingerprint };
    // The reference's output for compute-test, to compare with Chrome's.
    const referenceOut = join(scratch, "reference");
    execFileSync(AGENTPKG, ["run", COMPUTE_TEST, "--mode", "fixture", "--grants", COMPUTE_TEST_GRANTS, "--trust-key", COMPUTE_TEST_KEY, "--out", referenceOut], { stdio: "ignore" });
    const reference = JSON.parse(readFileSync(join(referenceOut, "result.json"), "utf8"));
    const fixtureInput = JSON.parse(readFileSync(join(ROOT, "examples", "compute", "compute-test", "fixtures", "workflow.json"), "utf8")).input;

    const tls = certificate(scratch, SITE_HOST);
    const type = "application/vnd.webagents.agent-package";
    const caseFiles = Object.fromEntries(Object.entries(indirect).flatMap(([caseId, pkg]) => [
      [`/${caseId}.agent.pkg`, { bytes: pkg.bytes, type }],
      [`/modules/${caseId}.wasm`, { bytes: readFileSync(join(CASE_MODULES, `${caseId}.wasm`)), type: "application/wasm" }],
    ]));
    const trapWordsPage = { "/trap-words.html": { bytes: Buffer.from("<!doctype html><title>trap words</title>\n"), type: "text/html; charset=utf-8" }, "/trap-words.js": { bytes: Buffer.from(TRAP_WORDS_WORKER), type: "text/javascript" } };
    served = await serveFiles(tls, { "/compute-test.agent.pkg": { bytes: computeTest.bytes, type }, "/runaway.agent.pkg": { bytes: runaway.bytes, type }, "/long.agent.pkg": { bytes: long.bytes, type }, ...caseFiles, ...trapWordsPage });
    chrome = spawn(args.chrome, ["--headless=new", "--remote-debugging-pipe", "--enable-unsafe-extension-debugging", `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check", `--host-resolver-rules=MAP ${SITE_HOST} 127.0.0.1:${served.port}`, `--ignore-certificate-errors-spki-list=${tls.spkiHash}`, "about:blank"], { stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"] });
    const cdp = new Cdp(chrome);
    const version = await cdp.send("Browser.getVersion");
    report.chrome = version.product;
    report.v8 = version.jsVersion;
    const granted = grantedBuild(EXTENSION, scratch, [`https://${SITE_HOST}`]);
    report.csp = JSON.parse(readFileSync(join(granted.path, "manifest.json"), "utf8")).content_security_policy.extension_pages;
    const { id: extensionId } = await cdp.send("Extensions.loadUnpacked", { path: granted.path });
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

    const probeModels = await send({ type: "models.probe", provider: "ollama" });
    const offered = probeModels.models.map((model) => model.id);
    const model = args.model ?? offered[0];
    report.model = model ?? null;
    check("Ollama answers and offers a model the plan can bind (never called)", probeModels.ok === true && typeof model === "string" && offered.includes(model), { ok: probeModels.ok, error: probeModels.error, offered });
    const settings = (await send({ type: "settings.get" })).settings;
    settings.models.default_model = model;
    settings.developer = { record_requests: true };
    await send({ type: "settings.set", settings });

    // 0. A compute Worker from an extension page: the module compiles under the extension's CSP, the
    // Worker loads, runs the fares module on one line and answers once.
    const fares = readFileSync(FARES);
    report.computeWorker = await cdp.evaluate(page, `(async () => {
      const bytes = Uint8Array.from(atob(${JSON.stringify(fares.toString("base64"))}), (c) => c.charCodeAt(0));
      let module;
      try { module = await WebAssembly.compile(bytes); } catch (error) { return { ok: false, stage: "compile", reason: String(error && error.name) }; }
      return await new Promise((resolveAnswer) => {
        const worker = new Worker(chrome.runtime.getURL("compute-worker.js"), { type: "module" });
        const timer = setTimeout(() => resolveAnswer({ ok: false, stage: "answer", reason: "no answer in 20 s" }), 20000);
        worker.onmessage = (event) => {
          const a = event.data;
          if (!a || a.kind !== "chrome-agent-browser.compute-answer") return;
          clearTimeout(timer); worker.terminate();
          resolveAnswer(a.ok ? { ok: true, output: new TextDecoder().decode(new Uint8Array(a.output)), memory_pages: a.memory_pages } : { ok: false, stage: "call", reason: a.reason });
        };
        worker.onerror = (event) => { clearTimeout(timer); resolveAnswer({ ok: false, stage: "worker", reason: event.message || "worker error" }); };
        const input = new TextEncoder().encode(JSON.stringify({ currency: "USD", items: [{ amount_cents: 42900, label: "WA101 Economy Standard", quantity: 2 }], tax_rate_bps: 850 }));
        worker.postMessage({ kind: "chrome-agent-browser.compute-call", module, function: "run", input: input.buffer }, [input.buffer]);
      });
    })()`);
    const workerOutput = report.computeWorker?.ok ? JSON.parse(report.computeWorker.output) : null;
    check("a module compiles under the extension's CSP and a compute Worker runs it", workerOutput?.total_cents === 93093 && workerOutput?.subtotal_cents === 85800, report.computeWorker);

    // 0b. V8's own words for the two indirect-call traps, from a dedicated Worker on a page of the local
    // origin (an extension page's CSP admits no Worker script but the extension's own). Recorded here,
    // never in a run's audit (C-41); the runs below check the codes the product derives from them.
    const { targetId: wordsTarget } = await cdp.send("Target.createTarget", { url: `https://${SITE_HOST}/trap-words.html` });
    const wordsPage = await cdp.attach(wordsTarget);
    await cdp.waitFor(wordsPage, `document.readyState === "complete"`, "the trap-words page");
    report.trapWords = await cdp.evaluate(wordsPage, `new Promise((resolveWords) => {
      const worker = new Worker("/trap-words.js");
      const timer = setTimeout(() => resolveWords({ error: "no answer in 20 s" }), 20000);
      worker.onmessage = (event) => { clearTimeout(timer); worker.terminate(); resolveWords(event.data); };
      worker.onerror = (event) => { clearTimeout(timer); resolveWords({ error: event.message || "worker error" }); };
      worker.postMessage(${JSON.stringify(Object.fromEntries(Object.keys(INDIRECT_CALL_CASES).map((caseId) => [caseId, `/modules/${caseId}.wasm`])))});
    })`);
    await cdp.send("Target.closeTarget", { targetId: wordsTarget });
    const words = Object.keys(INDIRECT_CALL_CASES).map((caseId) => report.trapWords?.[caseId]);
    check("in a dedicated Worker, Chrome's V8 traps on the two indirect calls with two different messages", words.every((word) => word?.name === "RuntimeError") && words[0].message !== words[1].message, report.trapWords);

    const runPackage = async (name, url, fingerprint, digest, input, { cancelAfterMs = null, timeoutMs = 120_000 } = {}) => {
      const view = await send({ type: "package.open", url, advertisedOn: null, viewId: `e2e-${name}` });
      const sessionId = view.session.id;
      // compute-test runs twice; its key is pinned by the first run.
      try {
        await send({ type: "trust.pin", sessionId, signerFingerprint: fingerprint, scope: "publisher" });
      } catch (error) {
        if (error.code !== "trust_entry_exists") throw error;
      }
      const authorized = await send({ type: "authorization.authorize", sessionId, packageDigest: digest, decisions: { "memory.session": "session", "compute.modules": "session", "model.unused": "session" }, toolApprovals: {}, resourceSelections: {}, provenance: null, prepare: true });
      const plan = authorized.run_plan?.run_plan ?? null;
      if (!plan) throw new Error(`${name}: no run plan (${JSON.stringify(authorized.plan_refused ?? null).slice(0, 300)})`);
      const started = await send({ type: "run.start", sessionId, runPlanId: plan.run_plan_id, runPlanSha256: plan.run_plan_sha256, input });
      const began = Date.now();
      log(`${name}: run ${started.runId} started`);
      if (cancelAfterMs !== null) setTimeout(() => void send({ type: "run.cancel", runId: started.runId }).catch(() => undefined), cancelAfterMs);
      let record = started;
      while (!["completed", "failed", "cancelled", "interrupted"].includes(record.status) && Date.now() - began < timeoutMs) {
        await new Promise((resolveWait) => setTimeout(resolveWait, 250));
        record = await send({ type: "run.get", runId: started.runId });
      }
      const settledMs = Date.now() - began;
      const bundle = await send({ type: "run.export", runId: started.runId });
      const exported = {};
      const directory = join(outDir, name);
      mkdirSync(directory, { recursive: true });
      for (const entry of bundle.entries) {
        const bytes = Buffer.from(entry.base64, "base64");
        writeFileSync(join(directory, entry.name), bytes);
        exported[entry.name] = bytes.toString("utf8");
      }
      const observations = await send({ type: "run.observations", runId: started.runId });
      const audit = JSON.parse(exported["audit.json"] ?? "[]");
      const events = Array.isArray(audit) ? audit : (audit.events ?? []);
      const compute = events.filter((event) => String(event.action).startsWith("compute."));
      report.runs[name] = { runId: started.runId, status: record.status, errorCode: record.errorCode, settledMs, chainValid: record.audit?.chainValid ?? null, compute: compute.map((event) => ({ action: event.action, node_id: event.node_id, module: event.module, function: event.function, reason: event.reason ?? null, trap_code: event.trap_code ?? null, engine: event.engine ?? null, memory_pages: event.memory_pages ?? null })), modelRequests: observations.observations.filter((item) => item.kind === "model").length, requests: { recording: observations.recording, count: observations.observations.length }, warnings: view.summary.warnings.map((warning) => warning.code) };
      return { record, exported, events, compute, view };
    };

    // 1. compute-test through the product's run path.
    const ok = await runPackage("compute-test", `https://${SITE_HOST}/compute-test.agent.pkg`, computeTest.fingerprint, computeTest.digest, fixtureInput);
    const result = JSON.parse(ok.exported["result.json"] ?? "{}");
    const completed = ok.compute.filter((event) => event.action === "compute.completed");
    check("compute-test completes in Chrome", ok.record.status === "completed", { status: ok.record.status, errorCode: ok.record.errorCode, failure: ok.record.failure });
    check("five calls, each completed by Chrome's engine in a nested Worker", completed.length === 5 && completed.every((event) => /^chrome\/\d/u.test(event.engine?.id ?? "") && event.engine.fuel_consumed === null), report.runs["compute-test"].compute);
    check("the calls name their nodes: two workers, the coordinator and the map step", JSON.stringify([...new Set(completed.map((event) => event.node_id))].sort()) === JSON.stringify(["groups/total", "ids", "quotes", "totals"]), completed.map((event) => event.node_id));
    check("Chrome's output equals the Python reference's", JSON.stringify(result.output) === JSON.stringify(reference.output) && result.output !== undefined, { chrome: result.output ?? null });
    check("usage counts the calls", result.usage?.compute_calls === 5, result.usage);
    check("no model request was made", report.runs["compute-test"].modelRequests === 0, report.runs["compute-test"].modelRequests);
    // The privacy observer (D-028) records every model and tool request of a run in test mode. A module
    // imports nothing, so it has no path to the network; the observer confirms the run made no request.
    check("the privacy observer, recording, saw no request of any kind", report.runs["compute-test"].requests.recording === true && report.runs["compute-test"].requests.count === 0, report.runs["compute-test"].requests);
    check("the audit chain is valid", ok.record.audit?.chainValid === true, ok.record.audit);
    check("the agent page states the code that can only compute", report.runs["compute-test"].warnings.includes("runs_code_that_can_only_compute") && ok.view.page.technical.modules.length === 2, report.runs["compute-test"].warnings);

    // 2. A module that never returns: the deadline terminates its Worker; the run Worker records the failure.
    const stopped = await runPackage("runaway", `https://${SITE_HOST}/runaway.agent.pkg`, runaway.fingerprint, runaway.digest, { a: 1, b: "two" });
    const failed = stopped.compute.find((event) => event.action === "compute.failed");
    check("the runaway call ends compute_error / deadline, recorded by the run Worker", stopped.record.status === "failed" && stopped.record.errorCode === "compute_error" && failed?.reason === "deadline" && failed?.engine?.fuel_consumed === null, { status: stopped.record.status, errorCode: stopped.record.errorCode, failed });
    check("the deadline fired near its 0.5 s bound, not at the run's timeout", report.runs.runaway.settledMs < 15_000, report.runs.runaway.settledMs);

    // 3. Cancelled one second into a call bounded at 10 s: cancelled at once.
    const cancelled = await runPackage("cancelled", `https://${SITE_HOST}/long.agent.pkg`, long.fingerprint, long.digest, { a: 1, b: "two" }, { cancelAfterMs: 1000 });
    check("a cancel stops the running call at once", cancelled.record.status === "cancelled" && report.runs.cancelled.settledMs < 8_000, { status: cancelled.record.status, settledMs: report.runs.cancelled.settledMs, compute: report.runs.cancelled.compute });

    // 3b. The two indirect-call traps through the product's run path: Chrome tells them apart, so a run
    // fails with the reference's trap code for each (the fold of C-42 is for an engine that does not).
    for (const [caseId, trapCode] of Object.entries(INDIRECT_CALL_CASES)) {
      const trapped = await runPackage(caseId, `https://${SITE_HOST}/${caseId}.agent.pkg`, indirect[caseId].fingerprint, indirect[caseId].digest, { a: 1, b: "two" });
      const failure = trapped.compute.find((event) => event.action === "compute.failed");
      check(`${caseId}: the run fails compute_error / trap / ${trapCode}, the reference's code`, trapped.record.status === "failed" && trapped.record.errorCode === "compute_error" && failure?.reason === "trap" && failure?.trap_code === trapCode, { status: trapped.record.status, errorCode: trapped.record.errorCode, failure });
    }

    // 4. The host is still healthy: compute-test runs again after all of them.
    const again = await runPackage("compute-test-again", `https://${SITE_HOST}/compute-test.agent.pkg`, computeTest.fingerprint, computeTest.digest, fixtureInput);
    check("a later run completes: no Worker was left behind", again.record.status === "completed", { status: again.record.status, errorCode: again.record.errorCode });
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
