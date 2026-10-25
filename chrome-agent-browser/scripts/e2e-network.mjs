#!/usr/bin/env node
/**
 * network.v0 in a real Chrome (T26, D-290, D-291): the built extension, headless, runs the shipped
 * travel network (`dist/travel-network-0.1.0.agent.pkg`, signed) opened from its origin, in fixture
 * mode: every model answer and every tool answer is the package's own fixture, replayed by exact
 * request data, so the run follows the fixture walk and nothing reaches the network:
 *
 *   - the WebAir origin is a Node HTTPS server behind `--host-resolver-rules` serving the package at
 *     the path index 1.6.0 names and the three travel services (`/api/v1/travel/…`) from the
 *     fixture's tool cases (`demo/webair/tests/test_travel.py` checks the real origin answers the same);
 *   - Ollama is a Node server on 127.0.0.1 answering `understand` and `route` from the fixture's
 *     model cases, matched by the exact request data the runtime built (the route cases carry the
 *     availability, R-13, R-27), so a route the runtime did not build would find no answer;
 *   - the agent page says the envelope before the run ("at most"), the plan freezes it, the run
 *     completes the full tour, and the run record holds the envelope the execution host recorded,
 *     the network's progress (every route decision with its reason) and each role's spend;
 *   - the run export and the recorded requests (the privacy observer, recording on) are written
 *     under `examples/my-chrome-network-<stamp>/`, the reference's fixture run of the same archive
 *     beside them, and `scripts/verify_chrome_network.py` recomputes the checks from those files:
 *     the chain, the walk, the decisions, every observed count within the plan's "at most", the
 *     reference's identical walk, plan and decisions, and every request to the two fakes only.
 *
 *   npm run build && node scripts/e2e-network.mjs [--chrome path] [--out report.json] [--keep]
 */
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
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
const ARCHIVE = join(ROOT, "dist", "travel-network-0.1.0.agent.pkg");
const KEY = join(ROOT, "examples", "keys", "travel-network-publisher.pub.pem");
const GRANTS = join(ROOT, "examples", "network", "travel-network-grants.json");
const HOST = "webagents-webair-production.up.railway.app";
const PACKAGE_PATH = "/packages/travel-network-0.1.0.agent.pkg";
const MODEL_NAME = "travel-fixture";
const TOOLS = ["search-flights", "search-hotels", "check-calendar"];
const SERVICES = { "/api/v1/travel/flights": "search-flights", "/api/v1/travel/hotels": "search-hotels", "/api/v1/travel/calendar": "check-calendar" };

const args = { chrome: process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", out: join(ROOT, "examples", "verification", "chrome-network-e2e-t26.json"), keep: false };
for (let index = 2; index < process.argv.length; index += 1) {
  const argument = process.argv[index];
  if (argument === "--chrome") args.chrome = process.argv[(index += 1)];
  else if (argument === "--out") args.out = resolve(process.argv[(index += 1)]);
  else if (argument === "--keep") args.keep = true;
  else {
    console.error(`unknown argument ${argument}`);
    process.exit(2);
  }
}
for (const [path, hint] of [[join(EXTENSION, "manifest.json"), "run `npm run build` first"], [AGENTPKG, "create agentpkg/.venv (CLAUDE.md, Conventions)"], [ARCHIVE, "the signed travel network (T26)"], [args.chrome, "pass --chrome <path>"]]) {
  if (!existsSync(path)) {
    console.error(`${path} is missing: ${hint}`);
    process.exit(2);
  }
}

const startedAt = new Date();
const stamp = startedAt.toISOString().replace(/[:.]/gu, "-");
const outDir = join(ROOT, "examples", `my-chrome-network-${stamp}`);
mkdirSync(outDir, { recursive: true });
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const report = { profile: "chrome-network-e2e-v0", recordedAt: startedAt.toISOString(), chrome: null, model: null, outputDirectory: relative(ROOT, outDir), exportDirectory: null, referenceDirectory: null, package: null, fakes: { ollama: null, origin: null }, page: null, plan: null, run: null, requests: { model: [], origin: [] }, observations: null, checks: {}, failures: [], passed: false };
const check = (name, condition, detail) => {
  report.checks[name] = condition ? "ok" : { failed: detail ?? null };
  if (!condition) report.failures.push(`${name}${detail === undefined ? "" : ` (${JSON.stringify(detail).slice(0, 400)})`}`);
};
const log = (text) => process.stderr.write(`[${Math.round((Date.now() - startedAt.getTime()) / 1000)}s] ${text}\n`);
const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
/** Structural equality with object keys sorted: the fixture matches by canonical JSON. */
const canonical = (value) => (Array.isArray(value) ? `[${value.map(canonical).join(",")}]` : value && typeof value === "object" ? `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}` : JSON.stringify(value));
const same = (a, b) => canonical(a) === canonical(b);

/** The package's own fixture, read from the signed archive the run opens. */
function packageFixture(scratch) {
  const unpacked = join(scratch, "unpacked");
  execFileSync(AGENTPKG, ["unpack", ARCHIVE, "-o", unpacked], { stdio: ["ignore", "ignore", "pipe"] });
  return JSON.parse(readFileSync(join(unpacked, "fixtures", "workflow.json"), "utf8"));
}

/** A scripted Ollama on a loopback port answering each task from the fixture's cases by exact request data. */
function fakeOllama(models, seen) {
  const server = createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      const answer = (status, value) => {
        const text = JSON.stringify(value);
        response.writeHead(status, { "content-type": "application/json", "content-length": String(Buffer.byteLength(text)) });
        response.end(text);
      };
      if (request.method === "GET" && request.url === "/api/tags") return answer(200, { models: [{ name: MODEL_NAME, model: MODEL_NAME, size: 1, details: {} }] });
      if (request.method === "POST" && request.url === "/api/show") return answer(200, { model_info: { "travel.context_length": 32768 }, capabilities: ["completion"] });
      if (request.method === "POST" && request.url === "/api/chat") {
        const parsed = JSON.parse(body || "{}");
        const system = parsed.messages?.find((message) => message.role === "system")?.content ?? "";
        const user = parsed.messages?.find((message) => message.role === "user")?.content ?? "null";
        const task = /^## Task\n(.+)$/mu.exec(system)?.[1] ?? "";
        const data = JSON.parse(user);
        const match = (models[task] ?? []).find((item) => same(item.input, data));
        seen.push({ at: new Date().toISOString(), task, bytes: Buffer.byteLength(body), matched: match !== undefined, next: task === "route" && match ? match.output.next : null, offered: task === "route" ? (data.targets ?? []).map((target) => `${target.role}:${target.uses_left}`) : null, hops_left: task === "route" ? data.hops_left : null });
        if (!match) return answer(400, { error: `no fixture case for task ${task} and these request data` });
        const content = JSON.stringify(match.output);
        return answer(200, { model: parsed.model ?? MODEL_NAME, message: { role: "assistant", content }, done: true, done_reason: "stop", prompt_eval_count: Math.ceil(system.length / 4), eval_count: Math.ceil(content.length / 4) });
      }
      return answer(404, { error: "not found" });
    });
  });
  return new Promise((resolveServer) => server.listen(0, "127.0.0.1", () => resolveServer({ server, port: server.address().port })));
}

async function main() {
  const scratch = mkdtempSync(join(realpathSync(tmpdir()), "chrome-network-"));
  const profile = join(scratch, "profile");
  let chrome = null;
  let origin = null;
  let ollama = null;
  try {
    const bytes = readFileSync(ARCHIVE);
    const verified = JSON.parse(execFileSync(AGENTPKG, ["verify", ARCHIVE, "--trust-key", KEY], { encoding: "utf8" }));
    report.package = { package_id: verified.package_id, version: verified.version, digest: verified.digest, archiveSha256: sha256(bytes), bytes: bytes.length, signer: verified.key_fingerprint };
    const fixture = packageFixture(scratch);
    // The reference on the same signed bytes: its fixture walk, for the verifier to compare.
    const referenceOut = join(outDir, "reference");
    execFileSync(AGENTPKG, ["run", ARCHIVE, "--mode", "fixture", "--grants", GRANTS, ...TOOLS.flatMap((tool) => ["--approve-tool", tool]), "--trust-key", KEY, "--out", referenceOut], { stdio: ["ignore", "ignore", "pipe"] });
    report.referenceDirectory = relative(ROOT, referenceOut);

    ollama = await fakeOllama(fixture.models, report.requests.model);
    report.fakes.ollama = `http://127.0.0.1:${ollama.port}`;
    const tls = certificate(scratch, HOST);
    const originSeen = report.requests.origin;
    origin = await serveFiles(tls, { [PACKAGE_PATH]: { bytes, type: "application/vnd.webagents.agent-package" } }, (method, path, body) => {
      const tool = SERVICES[path];
      originSeen.push({ at: new Date().toISOString(), method, path, tool: tool ?? null });
      if (method !== "POST" || !tool) return { status: 404, value: { error: { code: "not_found", message: "no", details: [] } } };
      const match = (fixture.tools[tool] ?? []).find((item) => same(item.input, JSON.parse(body || "null")));
      return match ? { status: 200, value: match.output } : { status: 422, value: { error: { code: "invalid_request", message: "no such request", details: [] } } };
    });
    report.fakes.origin = `https://${HOST} -> 127.0.0.1:${origin.port}`;

    chrome = spawn(args.chrome, ["--headless=new", "--remote-debugging-pipe", "--enable-unsafe-extension-debugging", `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check", `--host-resolver-rules=MAP ${HOST} 127.0.0.1:${origin.port}`, `--ignore-certificate-errors-spki-list=${tls.spkiHash}`, "--window-size=1280,1600", "about:blank"], { stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"] });
    const cdp = new Cdp(chrome);
    const version = await cdp.send("Browser.getVersion");
    report.chrome = version.product;
    const granted = grantedBuild(EXTENSION, scratch, [`https://${HOST}`]);
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
    const shot = async (name) => {
      try {
        const { data } = await cdp.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true }, page);
        mkdirSync(join(outDir, "screens"), { recursive: true });
        writeFileSync(join(outDir, "screens", `${name}.png`), Buffer.from(data, "base64"));
      } catch {
        // cosmetic
      }
    };
    const text = (selector) => cdp.evaluate(page, `(document.querySelector(${JSON.stringify(selector)})?.textContent ?? null)`);

    // 0. Settings: the scripted Ollama, test mode (the privacy observer records every request).
    const settings = (await send({ type: "settings.get" })).settings;
    settings.developer = { record_requests: true };
    settings.models.default_model = `ollama/${MODEL_NAME}`;
    settings.models.connections = settings.models.connections.map((connection) => (connection.provider === "ollama" ? { ...connection, enabled: true, base_url: report.fakes.ollama } : connection));
    await send({ type: "settings.set", settings });
    const probed = await send({ type: "models.probe", provider: "ollama" });
    report.model = probed.models.find((model) => model.id === `ollama/${MODEL_NAME}`) ?? null;
    check("the scripted Ollama is offered as a local model", probed.ok === true && report.model !== null, { ok: probed.ok, error: probed.error, offered: probed.models.map((model) => model.id) });

    // 1. Open from its origin, pin, read the agent page: the envelope before any run (R-24). The
    //    signed archive's JSON is canonical (JCS), so the roles map is in lexicographic order in both
    //    runtimes: that is its declaration order once built (the page lists the entry first).
    const view = await send({ type: "package.open", url: `https://${HOST}${PACKAGE_PATH}`, advertisedOn: null, viewId: "e2e" });
    const sessionId = view.session.id;
    await send({ type: "trust.pin", sessionId, signerFingerprint: report.package.signer, scope: "publisher" });
    const delegation = view.page.delegation;
    report.page = { delegation, warning: view.summary.warnings.find((warning) => warning.code === "delegation_network")?.message ?? null };
    check("the agent page states the envelope: at most 6 handoffs, FrontMan 4 times and each specialist once, 8 model calls, one call of each tool, 19 remote calls, 48,000 tokens", same(delegation?.at_most, { handoffs: 6, activations: 7, model_calls: 8, tool_calls: { "check-calendar": 1, "search-flights": 1, "search-hotels": 1 }, remote_calls: 19, tokens: 48000, seconds: 800 }) && same(delegation?.roles.map((role) => [role.id, role.chosen_by, role.at_most]), [["FrontMan", "model", 4], ["Calendar", "package", 1], ["Flights", "package", 1], ["Hotel", "package", 1]]), delegation);
    check("the agent page's sentence is the summary's delegation_network warning", typeof delegation?.sentence === "string" && delegation.sentence === report.page.warning, report.page.warning);
    await cdp.evaluate(page, `location.hash = ${JSON.stringify(`#session=${sessionId}`)}`);
    await sleep(1200);
    const card = await text(".ab-delegation");
    check("the agent page renders 'How it delegates' with the roles", typeof card === "string" && card.includes("At most, in any run") && card.includes("FrontMan") && card.includes("at most 4 times"), card);
    await shot("01-agent-page");

    // 2. Authorize: the plan freezes the envelope.
    const authorized = await send({ type: "authorization.authorize", sessionId, packageDigest: report.package.digest, decisions: JSON.parse(readFileSync(GRANTS, "utf8")), toolApprovals: Object.fromEntries(TOOLS.map((tool) => [tool, true])), resourceSelections: {}, provenance: null, prepare: true });
    const plan = authorized.run_plan?.run_plan ?? null;
    if (!plan) throw new Error(`no run plan (${JSON.stringify(authorized.plan_refused ?? null).slice(0, 300)})`);
    report.plan = { run_plan_id: plan.run_plan_id, run_plan_sha256: plan.run_plan_sha256, network: plan.execution.network ?? null };
    check("the plan records the network: node plan-trip, entry FrontMan, the four roles, the envelope", plan.execution.network?.node === "plan-trip" && plan.execution.network.entry === "FrontMan" && same(plan.execution.network.roles, ["Calendar", "Flights", "FrontMan", "Hotel"]) && plan.execution.network.worst_case.tokens === 48000 && plan.execution.network.worst_case.remote_calls === 19, plan.execution.network);

    // 3. Run the fixture walk.
    const started = await send({ type: "run.start", sessionId, runPlanId: plan.run_plan_id, runPlanSha256: plan.run_plan_sha256, input: fixture.input });
    const runId = started.runId;
    let record = started;
    const deadline = Date.now() + 120_000;
    while (!["completed", "failed", "cancelled", "interrupted"].includes(record.status)) {
      if (Date.now() > deadline) throw new Error("timed out waiting for the run");
      await sleep(300);
      record = await send({ type: "run.get", runId });
    }
    report.run = { runId, status: record.status, errorCode: record.errorCode, network: record.network ?? null, progress: record.progress?.network ?? null, usage: record.usage, audit: record.audit ? { events: record.audit.events, chainValid: record.audit.chainValid, modelCalls: record.audit.modelCalls, toolCalls: record.audit.toolCalls } : null };
    check("the run completes", record.status === "completed", { status: record.status, errorCode: record.errorCode, failure: record.failure ?? null });
    const network = record.progress?.network ?? null;
    check("the walk is the full tour: FrontMan 4 times, each specialist once, 6 handoffs, 7 decisions all allowed", network?.state === "completed" && network.hops === 6 && same(network.activations, { FrontMan: 4, Flights: 1, Hotel: 1, Calendar: 1 }) && network.decisions.length === 7 && network.decisions.every((decision) => decision.allowed), network);
    check("the model chose every route of FrontMan, the package every return", same(network?.decisions.map((decision) => [decision.role, decision.chosen_by, decision.next]), [["FrontMan", "model", "Flights"], ["Flights", "package", "FrontMan"], ["FrontMan", "model", "Hotel"], ["Hotel", "package", "FrontMan"], ["FrontMan", "model", "Calendar"], ["Calendar", "package", "FrontMan"], ["FrontMan", "model", "done"]]), network?.decisions);
    check("the run record holds the envelope the execution host recorded, with each role's budget", record.network?.atMost?.maxHops === 6 && record.network.atMost.tokens === 48000 && record.network.roles.length === 4 && record.network.roles.find((role) => role.role === "FrontMan")?.tokensPerActivation === 12000, record.network);
    check("every model request matched a fixture case: the runtime built exactly the route data the reference builds", report.requests.model.length === 8 && report.requests.model.every((item) => item.matched), report.requests.model);
    check("the three travel services were called once each, in the walk's order", same(originSeen.filter((item) => item.tool !== null).map((item) => item.tool), TOOLS), originSeen);
    await cdp.evaluate(page, `location.hash = ${JSON.stringify(`#run=${runId}`)}`);
    await sleep(1500);
    const walk = await text(".ab-route");
    check("the run page shows the walk with the handoffs against the envelope", typeof walk === "string" && walk.includes("Handoffs 6 of at most 6") && walk.includes("FrontMan → Calendar (the model)"), walk);
    await cdp.evaluate(page, `document.querySelectorAll("details").forEach((node) => { node.open = true; })`);
    await sleep(400);
    const decisions = await cdp.evaluate(page, `document.querySelectorAll(".ab-route-decisions tr[data-allowed]").length`);
    const roles = await text(".ab-role-usage");
    check("Technical details list the 7 route decisions and the usage by role", decisions === 7 && typeof roles === "string" && roles.includes("4 of at most 4"), { decisions, roles });
    await shot("02-run-page");

    // 4. The export and the recorded requests.
    const bundle = await send({ type: "run.export", runId });
    const exportDir = join(outDir, "export");
    for (const entry of bundle.entries) {
      const path = join(exportDir, entry.name);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, Buffer.from(entry.base64, "base64"));
    }
    report.exportDirectory = relative(ROOT, exportDir);
    report.export = { entries: bundle.entries.map((entry) => ({ name: entry.name, bytes: entry.bytes, sha256: entry.sha256 })) };
    const names = bundle.entries.map((entry) => entry.name);
    check("the export carries the run record, the result, the audit and the plan's exports", ["run.json", "result.json", "audit.json", "usage.json", "plan.json", "plan.txt"].every((name) => names.includes(name)), names);
    const observations = await send({ type: "run.observations", runId });
    writeFileSync(join(exportDir, "observations.json"), `${JSON.stringify(observations, null, 2)}\n`);
    report.observations = { recording: observations.recording, count: observations.observations.length, kinds: [...new Set(observations.observations.map((item) => `${item.kind}:${new URL(item.url).host}`))].sort() };
    check("the privacy observer, recording, saw only the scripted Ollama and the WebAir origin", observations.recording === true && same(report.observations.kinds, [`model:127.0.0.1:${ollama.port}`, `tool:${HOST}`].sort()) && observations.observations.length === 11, report.observations);
  } catch (error) {
    report.failures.push(`harness: ${error.message}`);
  } finally {
    if (chrome) {
      const exited = chrome.exitCode !== null ? Promise.resolve() : new Promise((resolveExit) => chrome.once("exit", resolveExit));
      chrome.kill();
      await Promise.race([exited, sleep(10_000)]);
    }
    origin?.server.close();
    ollama?.server.close();
    if (!args.keep) rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
  report.passed = report.failures.length === 0;
  const text = `${JSON.stringify(report, null, 2)}\n`;
  writeFileSync(args.out, text);
  process.stdout.write(text);
  log(`report written to ${relative(ROOT, args.out)}; export under ${report.exportDirectory ?? "(none)"}`);
  process.exit(report.passed ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
