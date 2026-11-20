#!/usr/bin/env node
/**
 * Agent Links in a real Chrome (T66, D-708; link.v0): the built extension, headless, with T65's
 * signed packages served from their own origins (four Node HTTPS servers behind
 * `--host-resolver-rules`, each with its own throwaway certificate) and a scripted Ollama on a
 * loopback port that answers every task from the packages' own fixtures by the exact request data
 * the runtime built, so a request built otherwise finds no answer.
 *
 * Scenario A, the planner 0.1.0 (planned links):
 *   - opened from Tripwright's origin: nothing else is fetched; the review says which agents are
 *     linked and from where; the click on "Load linked agents" fetches both from their locators
 *     (one GET each, no cookie, no referrer);
 *   - the review shows three publishers (the planner's and two linked ones), each "signature valid,
 *     publisher unknown" until its key is pinned from its own card (two presses);
 *   - Staymere is denied in the review: the plan states it, the envelope leaves it out, and the run
 *     of that plan asks WebAir Flights only and never reaches Staymere's origin (the route requests
 *     of that walk differ from the recorded tour, so the scripted model improvises them; flagged);
 *   - the denial is withdrawn, a new plan is prepared, and the run of the recorded tour goes
 *     through both links with every model request matched exactly; the delegation view's tree in
 *     the page equals the audit's link events; the export carries the inner plans and records.
 *
 * Scenario B, the planner 0.2.0 (the slot):
 *   - the signed 0.2.0 runs to its slot; the hotel's page and package are read with a plain GET
 *     each; the join card shows in the run panel with the facts the core computed, before any model
 *     request holds anything of the candidate; it is accepted in the page. The request-building
 *     call is then refused by FindHotel's own budget (4,000 tokens; this host bounds the input by
 *     its UTF-8 bytes, D-115): recorded as found, a property of the signed package on this host;
 *   - the same package with FindHotel's budget at 6,000, built by `agentpkg` in the scratch
 *     directory and signed with a throwaway key (never in the repository, D-003), completes the
 *     join: the request-building call, the hotel's own service once, the join answered in the view.
 *
 * The exports, the reference's fixture run of the planner 0.1.0 and the request logs are written
 * under `examples/my-chrome-link-<stamp>/`; `scripts/verify_chrome_link_e2e.py` recomputes the
 * checks from those files.
 *
 *   npm run build && node scripts/e2e-link.mjs [--chrome path] [--out report.json] [--keep]
 */
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { Cdp } from "./lib/cdp.mjs";
import { grantedBuild } from "./lib/granted-build.mjs";
import { certificate, serveFiles } from "./lib/origin.mjs";
import { same } from "./lib/same.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const PROJECT = resolve(here, "..");
const ROOT = resolve(PROJECT, "..");
const EXTENSION = join(PROJECT, "dist", "extension");
const AGENTPKG = process.env.AGENTPKG_CLI || join(ROOT, "agentpkg", ".venv", "bin", "agentpkg");
const DIST = (name) => join(ROOT, "dist", name);
const EXAMPLES = (name) => join(ROOT, "examples", name);
const HOSTS = { tripwright: "webagents-tripwright-production.up.railway.app", webair: "webagents-webair-production.up.railway.app", staymere: "webagents-staymere-production.up.railway.app", salitubam: "webagents-hotel-salitubam-production.up.railway.app" };
const ARCHIVES = { planner010: DIST("travel-planner-0.1.0.agent.pkg"), planner020: DIST("travel-planner-0.2.0.agent.pkg"), flights: DIST("webair-flights-0.1.0.agent.pkg"), staymere: DIST("staymere-hotels-0.1.0.agent.pkg"), salitubam: DIST("hotel-salitubam-0.1.0.agent.pkg") };
const KEYS = { planner: EXAMPLES("keys/travel-planner-publisher.pub.pem"), webair: EXAMPLES("keys/webair-publisher.pub.pem"), staymere: EXAMPLES("keys/staymere-publisher.pub.pem"), salitubam: EXAMPLES("keys/hotel-salitubam-publisher.pub.pem") };
const PLANNER_PATHS = { planner010: "/packages/travel-planner-0.1.0.agent.pkg", planner020: "/packages/travel-planner-0.2.0.agent.pkg", variant: "/packages/travel-planner-0.2.0-findhotel-6000.agent.pkg" };
const MODEL_NAME = "link-fixture";
const VARIANT_TOKENS = 6000;
const PACKAGE_TYPE = "application/vnd.webagents.agent-package";

const args = { chrome: process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", out: join(ROOT, "examples", "verification", "chrome-link-e2e.json"), keep: false };
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
for (const [path, hint] of [[join(EXTENSION, "manifest.json"), "run `npm run build` first"], [AGENTPKG, "create agentpkg/.venv (CLAUDE.md, Conventions)"], ...Object.values(ARCHIVES).map((path) => [path, "T65's signed packages"]), [args.chrome, "pass --chrome <path>"]]) {
  if (!existsSync(path)) {
    console.error(`${path} is missing: ${hint}`);
    process.exit(2);
  }
}

const startedAt = new Date();
const stamp = startedAt.toISOString().replace(/[:.]/gu, "-");
const outDir = join(ROOT, "examples", `my-chrome-link-${stamp}`);
mkdirSync(outDir, { recursive: true });
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const report = { profile: "chrome-link-e2e-v0", recordedAt: startedAt.toISOString(), chrome: null, model: null, outputDirectory: relative(ROOT, outDir), packages: {}, variant: null, fakes: { ollama: null, origins: {} }, referenceDirectory: null, scenarios: {}, requests: { model: [], origins: [] }, checks: {}, failures: [], passed: false };
const check = (name, condition, detail) => {
  report.checks[name] = condition ? "ok" : { failed: detail ?? null };
  if (!condition) report.failures.push(`${name}${detail === undefined ? "" : ` (${JSON.stringify(detail).slice(0, 500)})`}`);
};
const log = (text) => process.stderr.write(`[${Math.round((Date.now() - startedAt.getTime()) / 1000)}s] ${text}\n`);
const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
const agentpkg = (argv) => execFileSync(AGENTPKG, argv, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

/** A signed archive unpacked: its fixture, its declared remote tools by endpoint, and what `agentpkg verify` says of it. */
function describe(scratch, name, archive, key) {
  const unpacked = join(scratch, `unpacked-${name}`);
  agentpkg(["unpack", archive, "-o", unpacked]);
  const verified = JSON.parse(agentpkg(["verify", archive, "--trust-key", key]));
  const bytes = readFileSync(archive);
  const fixture = JSON.parse(readFileSync(join(unpacked, "fixtures", "workflow.json"), "utf8"));
  const tools = readdirSync(join(unpacked, "tools")).map((file) => JSON.parse(readFileSync(join(unpacked, "tools", file), "utf8")));
  return { name, unpacked, bytes, fixture, tools, facts: { package_id: verified.package_id, version: verified.version, digest: verified.digest, archiveSha256: sha256(bytes), bytes: bytes.length, signer: verified.key_fingerprint } };
}

/** The planner's two model tasks answered without a recording, for a walk the fixture does not hold: the trip as the state holds it; each role still offered, once; then the end. */
function improvise(task, data) {
  if (task === "understand") return { summary: "As the shared state stands.", trip: data.trip ?? null, ...(Object.hasOwn(data, "hotel_name") ? { hotel_name: data.hotel_name ?? null } : {}) };
  if (task === "route") {
    const next = data.hops_left >= 2 ? (data.targets ?? []).find((target) => target.uses_left > 0) : undefined;
    return next ? { message: { notes: "", text: `Ask ${next.role}.` }, next: next.role } : { message: { notes: "", text: "Answered with what was allowed." }, next: "done" };
  }
  return undefined;
}

/** A scripted Ollama on a loopback port: each task answered from the packages' fixtures by exact request data; `state.improvise` admits the two planner tasks of an unrecorded walk. */
function fakeOllama(fixtures, seen, state) {
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
      if (request.method === "POST" && request.url === "/api/show") return answer(200, { model_info: { "link.context_length": 32768 }, capabilities: ["completion"] });
      if (request.method === "POST" && request.url === "/api/chat") {
        const parsed = JSON.parse(body || "{}");
        const system = parsed.messages?.find((message) => message.role === "system")?.content ?? "";
        const user = parsed.messages?.find((message) => message.role === "user")?.content ?? "null";
        const task = /^## Task\n(.+)$/mu.exec(system)?.[1] ?? "";
        const data = JSON.parse(user);
        const match = fixtures.flatMap((fixture) => fixture.models[task] ?? []).find((item) => same(item.input, data));
        const improvised = match === undefined && state.improvise ? improvise(task, data) : undefined;
        seen.push({ at: new Date().toISOString(), scenario: state.scenario, task, bytes: Buffer.byteLength(body), body_sha256: sha256(Buffer.from(body)), matched: match !== undefined, improvised: improvised !== undefined, mentions: state.mentions.filter((text) => body.includes(text)), offered: task === "route" ? (data.targets ?? []).map((target) => target.role) : null, next: task === "route" ? ((match?.output ?? improvised)?.next ?? null) : null });
        if (match === undefined && improvised === undefined) return answer(400, { error: `no fixture case for task ${task} and these request data` });
        const content = JSON.stringify(match !== undefined ? match.output : improvised);
        return answer(200, { model: parsed.model ?? MODEL_NAME, message: { role: "assistant", content }, done: true, done_reason: "stop", prompt_eval_count: Math.ceil(system.length / 4), eval_count: Math.ceil(content.length / 4) });
      }
      return answer(404, { error: "not found" });
    });
  });
  return new Promise((resolveServer) => server.listen(0, "127.0.0.1", () => resolveServer({ server, port: server.address().port })));
}

async function main() {
  const scratch = mkdtempSync(join(realpathSync(tmpdir()), "chrome-link-"));
  const profile = join(scratch, "profile");
  let chrome = null;
  let ollama = null;
  const origins = [];
  try {
    const packages = { planner010: describe(scratch, "planner010", ARCHIVES.planner010, KEYS.planner), planner020: describe(scratch, "planner020", ARCHIVES.planner020, KEYS.planner), flights: describe(scratch, "flights", ARCHIVES.flights, KEYS.webair), staymere: describe(scratch, "staymere", ARCHIVES.staymere, KEYS.staymere), salitubam: describe(scratch, "salitubam", ARCHIVES.salitubam, KEYS.salitubam) };
    for (const [name, pkg] of Object.entries(packages)) report.packages[name] = pkg.facts;

    // The planner 0.2.0 with FindHotel's budget raised, built and signed by agentpkg in the scratch directory with a throwaway key.
    const variantSource = join(scratch, "variant-source");
    agentpkg(["unpack", ARCHIVES.planner020, "-o", variantSource]);
    const graphPath = join(variantSource, "graph.json");
    const graph = JSON.parse(readFileSync(graphPath, "utf8"));
    const findHotel = graph.workers.find((worker) => worker.id === "FindHotel");
    const signedTokens = findHotel.budget.tokens;
    findHotel.budget.tokens = VARIANT_TOKENS;
    writeFileSync(graphPath, `${JSON.stringify(graph, null, 2)}\n`);
    const variantKey = join(scratch, "variant.pub.pem");
    agentpkg(["keygen", "--private-key", join(scratch, "variant.private.pem"), "--public-key", variantKey]);
    agentpkg(["build", variantSource, "-o", join(scratch, "variant.unsigned.agent.pkg")]);
    const variantArchive = join(scratch, "variant.agent.pkg");
    agentpkg(["sign", join(scratch, "variant.unsigned.agent.pkg"), "--private-key", join(scratch, "variant.private.pem"), "-o", variantArchive]);
    const variant = describe(scratch, "variant", variantArchive, variantKey);
    report.variant = { ...variant.facts, of: "org.webagents.travel-planner 0.2.0", change: { worker: "FindHotel", tokens: { signed: signedTokens, variant: VARIANT_TOKENS } }, signedWith: "a throwaway key made for this run; the archive is never written into the repository" };
    // The variant is kept beside the exports so that the verifier can recompute its record (it is not a shipped artifact).
    writeFileSync(join(outDir, "travel-planner-0.2.0-findhotel-6000.agent.pkg"), variant.bytes);

    // The reference on the same signed bytes: the planner 0.1.0's fixture walk, for the verifier to compare.
    const referenceOut = join(outDir, "reference");
    agentpkg(["run", ARCHIVES.planner010, "--mode", "fixture", "--grants", EXAMPLES("link/travel-planner-grants.json"), "--link", `webair-flights=${ARCHIVES.flights}`, "--link-grants", `webair-flights=${EXAMPLES("link/webair-flights-grants.json")}`, "--link", `hotel-aggregator=${ARCHIVES.staymere}`, "--link-grants", `hotel-aggregator=${EXAMPLES("link/staymere-hotels-grants.json")}`, "--approve-tool", "check-calendar", "--approve-tool", "webair-flights:search-flights", "--approve-tool", "hotel-aggregator:search-hotels", "--trust-key", KEYS.planner, "--trust-key", KEYS.webair, "--trust-key", KEYS.staymere, "--out", referenceOut]);
    report.referenceDirectory = relative(ROOT, referenceOut);

    // The scripted model: every fixture; what a model request may not hold before a join's decision.
    const modelState = { scenario: "setup", improvise: false, mentions: [] };
    const fixtures = Object.values(packages).map((pkg) => pkg.fixture);
    ollama = await fakeOllama(fixtures, report.requests.model, modelState);
    report.fakes.ollama = `http://127.0.0.1:${ollama.port}`;

    // The four origins: each serves its packages (and the hotel its page) and answers its declared services from the fixtures' tool cases.
    const services = {};
    for (const pkg of Object.values(packages)) {
      for (const tool of pkg.tools) {
        if (typeof tool.endpoint !== "string") continue;
        const url = new URL(tool.endpoint);
        ((services[url.host] ??= {})[url.pathname] ??= { tool: tool.id, cases: [] }).cases.push(...(pkg.fixture.tools[tool.id] ?? []));
      }
    }
    const joinFixture = JSON.parse(readFileSync(EXAMPLES("link/join-fixture.json"), "utf8"));
    const hotelPage = joinFixture.pages[`https://${HOSTS.salitubam}/`];
    const files = {
      [HOSTS.tripwright]: { [PLANNER_PATHS.planner010]: { bytes: packages.planner010.bytes, type: PACKAGE_TYPE }, [PLANNER_PATHS.planner020]: { bytes: packages.planner020.bytes, type: PACKAGE_TYPE }, [PLANNER_PATHS.variant]: { bytes: variant.bytes, type: PACKAGE_TYPE } },
      [HOSTS.webair]: { "/packages/webair-flights-0.1.0.agent.pkg": { bytes: packages.flights.bytes, type: PACKAGE_TYPE } },
      [HOSTS.staymere]: { "/agent.pkg": { bytes: packages.staymere.bytes, type: PACKAGE_TYPE } },
      [HOSTS.salitubam]: { "/": { bytes: Buffer.from(hotelPage.body, "utf8"), type: hotelPage.content_type }, "/agent.pkg": { bytes: packages.salitubam.bytes, type: PACKAGE_TYPE } },
    };
    const tls = {};
    const ports = {};
    for (const host of Object.values(HOSTS)) {
      const hostDirectory = join(scratch, `tls-${host}`);
      mkdirSync(hostDirectory, { recursive: true });
      tls[host] = certificate(hostDirectory, host);
      const origin = await serveFiles(tls[host], files[host], (method, path, body) => {
        const service = services[host]?.[path];
        report.requests.origins.push({ at: new Date().toISOString(), scenario: modelState.scenario, host, method, path, tool: service?.tool ?? null, body_bytes: Buffer.byteLength(body) });
        if (method !== "POST" || !service) return { status: 404, value: { error: { code: "not_found", message: "no", details: [] } } };
        const match = service.cases.find((item) => same(item.input, JSON.parse(body || "null")));
        return match ? { status: 200, value: match.output } : { status: 422, value: { error: { code: "invalid_request", message: "no such request", details: [] } } };
      });
      origins.push(origin);
      ports[host] = origin.port;
      report.fakes.origins[host] = `127.0.0.1:${origin.port}`;
    }
    /** Every request each origin's server saw so far, files included (`serveFiles` keeps `METHOD path`). */
    const hits = (host) => origins[Object.values(HOSTS).indexOf(host)].hits.slice();

    chrome = spawn(args.chrome, ["--headless=new", "--remote-debugging-pipe", "--enable-unsafe-extension-debugging", `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check", `--host-resolver-rules=${Object.values(HOSTS).map((host) => `MAP ${host} 127.0.0.1:${ports[host]}`).join(", ")}`, `--ignore-certificate-errors-spki-list=${Object.values(HOSTS).map((host) => tls[host].spkiHash).join(",")}`, "--window-size=1280,2400", "about:blank"], { stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"] });
    const cdp = new Cdp(chrome);
    report.chrome = (await cdp.send("Browser.getVersion")).product;
    const granted = grantedBuild(EXTENSION, scratch, Object.values(HOSTS).map((host) => `https://${host}`));
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
    const dom = (expression) => cdp.evaluate(page, expression);
    const click = (selector) => cdp.evaluate(page, `(() => { const node = document.querySelector(${JSON.stringify(selector)}); if (!node) return false; node.click(); return true; })()`, { userGesture: true });
    const waitDom = (expression, label, timeoutMs = 30_000) => cdp.waitFor(page, expression, label, timeoutMs);
    const show = async (hash) => {
      await dom(`location.hash = ${JSON.stringify(hash)}`);
      await sleep(400);
    };
    /** The delegation view as the page drew it: each link with the activation it sits under. */
    const treeInPage = () => dom(`[...document.querySelectorAll(".ab-delegation-view [data-link]")].map((node) => ({ role: node.closest("[data-activation]")?.dataset.activation ?? null, kind: node.dataset.kind, name: node.dataset.link, state: node.dataset.state, package_id: node.dataset.package || null }))`);
    const exportRun = async (runId, name) => {
      const bundle = await send({ type: "run.export", runId });
      const directory = join(outDir, name);
      for (const entry of bundle.entries) {
        const path = join(directory, entry.name);
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, Buffer.from(entry.base64, "base64"));
      }
      const observations = await send({ type: "run.observations", runId });
      writeFileSync(join(directory, "observations.json"), `${JSON.stringify(observations, null, 2)}\n`);
      return { directory: relative(ROOT, directory), entries: bundle.entries.map((entry) => ({ name: entry.name, bytes: entry.bytes, sha256: entry.sha256 })), observations: observations.observations.map((item) => ({ kind: item.kind, subject: item.subject, url: item.url, body_bytes: item.body_bytes })) };
    };
    const settle = async (runId, until = () => false) => {
      const deadline = Date.now() + 120_000;
      for (;;) {
        const record = await send({ type: "run.get", runId });
        if (["completed", "failed", "cancelled", "interrupted"].includes(record.status) || until(record)) return record;
        if (Date.now() > deadline) throw new Error(`timed out waiting for run ${runId} (${record.status})`);
        await sleep(250);
      }
    };
    const auditOf = (directory) => JSON.parse(readFileSync(join(ROOT, directory, "audit.json"), "utf8"));
    const linkEvents = (audit) => audit.filter((event) => String(event.action).startsWith("link.")).map((event) => ({ action: event.action, name: event.dependency ?? event.slot ?? null }));
    /** The same fold the page draws, from an export's audit: the links under each activation, in order. */
    const treeOf = (audit) => {
      const rows = [];
      let role = null;
      const open = new Map();
      for (const event of audit) {
        const action = String(event.action);
        const name = event.dependency ?? event.slot ?? null;
        if (action === "network.activated") role = event.role;
        else if (action === "link.requested") open.set(name, rows[rows.push({ role, kind: "join", name, state: "looking", package_id: event.candidate?.package_id ?? null }) - 1]);
        else if (action === "link.decided") {
          const row = open.get(name) ?? rows[rows.push({ role, kind: "join", name, state: "looking", package_id: event.candidate?.package_id ?? null }) - 1];
          open.set(name, row);
          row.state = event.accepted === true ? "working" : event.decided_by === "person" ? "declined" : "not_joined";
        } else if (action === "link.started") {
          const row = open.get(name) ?? rows[rows.push({ role, kind: "slot" in event ? "join" : "link", name, state: "working", package_id: null }) - 1];
          open.set(name, row);
          row.state = "working";
          row.package_id = event.package_id;
        } else if (action === "link.completed" || action === "link.failed") {
          const row = open.get(name) ?? rows[rows.push({ role, kind: "slot" in event ? "join" : "link", name, state: "working", package_id: null }) - 1];
          row.state = action === "link.completed" ? "answered" : "failed";
          open.delete(name);
        }
      }
      return rows;
    };

    // 0. Settings: the scripted Ollama, test mode (the privacy observer records every request).
    const settings = (await send({ type: "settings.get" })).settings;
    settings.developer = { record_requests: true };
    settings.models.default_model = `ollama/${MODEL_NAME}`;
    settings.models.connections = settings.models.connections.map((connection) => (connection.provider === "ollama" ? { ...connection, enabled: true, base_url: report.fakes.ollama } : connection));
    await send({ type: "settings.set", settings });
    const probed = await send({ type: "models.probe", provider: "ollama" });
    report.model = probed.models.find((model) => model.id === `ollama/${MODEL_NAME}`) ?? null;
    check("the scripted Ollama is offered as a local model", probed.ok === true && report.model !== null, { ok: probed.ok, error: probed.error });

    // ---------------------------------------------------------------------------------------------
    // Scenario A: the planner 0.1.0, planned links.
    // ---------------------------------------------------------------------------------------------
    const A = (report.scenarios.planned = {});
    modelState.scenario = "A.review";
    const opened = await send({ type: "package.open", url: `https://${HOSTS.tripwright}${PLANNER_PATHS.planner010}`, advertisedOn: null, viewId: "e2e" });
    const sessionId = opened.session.id;
    const digest = packages.planner010.facts.digest;
    await show(`#session=${sessionId}`);
    await waitDom(`!!document.querySelector('[data-links="unresolved"]')`, "the review before loading");
    check("opening the planner fetched only the planner: no linked origin was contacted", hits(HOSTS.webair).length === 0 && hits(HOSTS.staymere).length === 0 && same(hits(HOSTS.tripwright), [`GET ${PLANNER_PATHS.planner010}`]), { webair: hits(HOSTS.webair), staymere: hits(HOSTS.staymere), tripwright: hits(HOSTS.tripwright) });
    const locators = await dom(`[...document.querySelectorAll("[data-locator]")].map((node) => node.textContent)`);
    check("the review names the two linked packages and where each is published, before loading them", same(locators, [`org.webagents.webair-flights 0.1.0 from https://${HOSTS.webair}`, `org.webagents.staymere-hotels 0.1.0 from https://${HOSTS.staymere}`]), locators);
    await shot("01-review-before-loading");

    // 1. Load the linked agents with the click.
    await click('button[data-links="resolve"]');
    await waitDom(`!!document.querySelector('[data-links="resolved"]')`, "the linked agents loaded");
    check("loading fetched each linked package from its locator with one GET", same(hits(HOSTS.webair), ["GET /packages/webair-flights-0.1.0.agent.pkg"]) && same(hits(HOSTS.staymere), ["GET /agent.pkg"]), { webair: hits(HOSTS.webair), staymere: hits(HOSTS.staymere) });
    const review = (await send({ type: "authorization.get", sessionId })).links;
    A.review = { resolved: review.resolved, links: review.links.map((item) => ({ dependency: item.dependency, package_id: item.package.package_id, version: item.package.version, digest: item.package.digest, signer: item.publisher.signer_fingerprint, trust: item.publisher.trust_status, signature: item.publisher.signature_status, worst_case: item.worst_case })), composed: review.composed.worst_case };
    const groups = await dom(`[...document.querySelectorAll("[data-publisher]")].map((node) => ({ key: node.dataset.publisher, text: node.querySelector(".ab-link-publisher-head").textContent, dependencies: [...node.querySelectorAll("[data-dependency]")].map((item) => item.dataset.dependency) }))`);
    const keys = new Set([packages.planner010.facts.signer, ...groups.map((group) => group.key)]);
    check("the review shows three publishers: the planner's own and one group per linked key, each signature valid and publisher unknown", keys.size === 3 && same(groups.map((group) => group.key).sort(), [packages.flights.facts.signer, packages.staymere.facts.signer].sort()) && groups.every((group) => group.text.includes("Signature valid · publisher unknown")), groups);
    check("the linked packages are the pinned ones: their digests are the manifest's", same(Object.fromEntries(A.review.links.map((item) => [item.dependency, item.digest])), { "webair-flights": packages.flights.facts.digest, "hotel-aggregator": packages.staymere.facts.digest }), A.review.links);
    const quotedWords = await dom(`[...document.querySelectorAll('[data-dependency="webair-flights"] [data-words]')].map((node) => [node.dataset.words, node.querySelector("q").textContent])`);
    check("a linked package's name and description are shown as the publisher's words, quoted", quotedWords.length === 2 && quotedWords[0][0] === "the publisher's name for it" && quotedWords[1][0] === "the publisher's words", quotedWords);
    const atMost = await dom(`document.querySelector('[data-at-most="composed"]')?.textContent ?? null`);
    check("the review states the composed at most, naming each linked agent's tool: 10 model calls, 23 remote calls, 92,000 tokens", typeof atMost === "string" && atMost.includes("10 model calls · tool calls: check-calendar ×1, hotel-aggregator:search-hotels ×1, webair-flights:search-flights ×1 · 23 remote calls · 92,000 tokens"), atMost);
    await shot("02-review-loaded");

    // 2. Trust: the caller from its own card, each linked key from its own card (two presses each).
    await send({ type: "trust.pin", sessionId, signerFingerprint: packages.planner010.facts.signer, scope: "publisher" });
    const blocked = await send({ type: "authorization.authorize", sessionId, packageDigest: digest, decisions: JSON.parse(readFileSync(EXAMPLES("link/travel-planner-grants.json"), "utf8")), toolApprovals: { "check-calendar": true }, resourceSelections: {}, provenance: null, prepare: true });
    check("pinning the planner's key does not extend to a linked publisher: the plan is refused link_undecided for both", blocked.run_plan === null && same((blocked.plan_refused ?? []).filter((reason) => reason.code === "link_undecided").map((reason) => reason.subject), ["hotel-aggregator", "webair-flights"]), blocked.plan_refused);
    for (const dependency of ["webair-flights", "hotel-aggregator"]) {
      await waitDom(`!!document.querySelector('button[data-link-trust="${dependency}"]')`, `the pin control of ${dependency}`);
      await click(`button[data-link-trust="${dependency}"]`);
      await click(`button[data-link-trust="${dependency}"]`);
      await waitDom(`document.querySelector('[data-dependency="${dependency}"]')?.dataset.trust === "trusted"`, `${dependency}'s key trusted`);
    }
    const trust = await send({ type: "trust.list" });
    check("three keys are pinned, each by its own decision; a linked key's pin is scoped to its package", trust.entries.length === 3 && trust.entries.filter((entry) => entry.package_id_prefix !== null).map((entry) => entry.package_id_prefix).sort().join(",") === "org.webagents.staymere-hotels,org.webagents.webair-flights", trust.entries.map((entry) => [entry.fingerprint, entry.package_id_prefix]));

    // 3. Deny Staymere in the review; authorize; the plan states the denial.
    await click('button[data-link-decide="hotel-aggregator"]');
    await waitDom(`document.querySelector('[data-dependency="hotel-aggregator"]')?.dataset.decision === "denied"`, "Staymere shown as denied");
    const deniedText = await dom(`document.querySelector('[data-dependency="hotel-aggregator"]').textContent`);
    check("the review says what a denial means: not asked, its steps unbound", deniedText.includes("Denied by you") && deniedText.includes("This run will not ask it."), deniedText);
    await shot("03-review-denied");
    const grants = JSON.parse(readFileSync(EXAMPLES("link/travel-planner-grants.json"), "utf8"));
    const authorize = () => send({ type: "authorization.authorize", sessionId, packageDigest: digest, decisions: grants, toolApprovals: { "check-calendar": true }, resourceSelections: {}, provenance: null, prepare: true });
    const deniedResult = await authorize();
    const deniedPlan = deniedResult.run_plan?.run_plan ?? null;
    if (!deniedPlan) throw new Error(`no run plan with Staymere denied (${JSON.stringify(deniedResult.plan_refused ?? null).slice(0, 300)})`);
    A.deniedPlan = { run_plan_sha256: deniedPlan.run_plan_sha256, links: deniedPlan.links, network: deniedPlan.execution.network?.worst_case ?? null, origins: deniedResult.run_plan.origins.map((item) => item.origin) };
    check("the plan records the denial: Staymere denied with no inner plan, WebAir Flights accepted with its inner plan's hash", deniedPlan.links["hotel-aggregator"].decision === "denied" && deniedPlan.links["hotel-aggregator"].plan_hash === null && deniedPlan.links["webair-flights"].decision === "accepted" && /^[0-9a-f]{64}$/u.test(deniedPlan.links["webair-flights"].plan_hash), deniedPlan.links);
    check("the denied publisher's part is out of the envelope and its origin is not among the plan's", !Object.hasOwn(deniedPlan.execution.network.worst_case.tool_calls, "hotel-aggregator:search-hotels") && !A.deniedPlan.origins.includes(`https://${HOSTS.staymere}`), A.deniedPlan);

    // 4. The run of that plan: the route requests offer no Hotels, so the recorded tour does not hold them (improvised, flagged).
    modelState.scenario = "A.denied";
    modelState.improvise = true;
    const staymereBefore = hits(HOSTS.staymere).length;
    const deniedStart = await send({ type: "run.start", sessionId, runPlanId: deniedPlan.run_plan_id, runPlanSha256: deniedPlan.run_plan_sha256, input: packages.planner010.fixture.input });
    const deniedRecord = await settle(deniedStart.runId);
    modelState.improvise = false;
    await show(`#run=${deniedStart.runId}`);
    await waitDom(`!!document.querySelector(".ab-delegation-view")`, "the delegation view of the denied run");
    const deniedTree = await treeInPage();
    const deniedNote = await dom(`document.querySelector(".ab-delegation-view [data-denied]")?.dataset.denied ?? null`);
    await shot("04-run-denied");
    A.denied = { runId: deniedStart.runId, status: deniedRecord.status, errorCode: deniedRecord.errorCode, tree: deniedTree, export: await exportRun(deniedStart.runId, "export-denied") };
    const deniedRequests = report.requests.model.filter((item) => item.scenario === "A.denied");
    check("with Staymere denied the run completes", deniedRecord.status === "completed", { status: deniedRecord.status, errorCode: deniedRecord.errorCode, failure: deniedRecord.failure ?? null });
    check("no route request of that run offered the denied publisher's role", deniedRequests.filter((item) => item.task === "route").every((item) => same(item.offered, ["Flights", "Calendar"])), deniedRequests.filter((item) => item.task === "route").map((item) => item.offered));
    check("the denied run reached Staymere's origin not at all, and WebAir Flights' service once", hits(HOSTS.staymere).length === staymereBefore && report.requests.origins.filter((item) => item.scenario === "A.denied" && item.tool === "search-flights").length === 1 && report.requests.origins.filter((item) => item.scenario === "A.denied" && item.host === HOSTS.staymere).length === 0, report.requests.origins.filter((item) => item.scenario === "A.denied"));
    check("the delegation view of the denied run shows one link, WebAir Flights answered, and names the denied publisher as not asked", same(deniedTree, [{ role: "Flights", kind: "link", name: "webair-flights", state: "answered", package_id: "org.webagents.webair-flights" }]) && deniedNote === "hotel-aggregator", { deniedTree, deniedNote });
    check("the denied run's rendered tree equals its audit's link events", same(deniedTree, treeOf(auditOf(A.denied.export.directory))), { page: deniedTree, audit: treeOf(auditOf(A.denied.export.directory)) });

    // 5. Withdraw the denial in the review, authorize again, and run the recorded tour through both links.
    modelState.scenario = "A.planned";
    await show(`#session=${sessionId}`);
    await waitDom(`!!document.querySelector('button[data-link-decide="hotel-aggregator"]')`, "the review again");
    await click('button[data-link-decide="hotel-aggregator"]');
    await waitDom(`document.querySelector('[data-dependency="hotel-aggregator"]')?.dataset.decision !== "denied"`, "Staymere allowed again");
    const result = await authorize();
    const plan = result.run_plan?.run_plan ?? null;
    if (!plan) throw new Error(`no run plan (${JSON.stringify(result.plan_refused ?? null).slice(0, 300)})`);
    A.plan = { run_plan_sha256: plan.run_plan_sha256, links: plan.links, network: plan.execution.network?.worst_case ?? null, composed: plan.execution.links?.worst_case ?? null, origins: result.run_plan.origins.map((item) => item.origin) };
    check("the plan records both links accepted, each with its inner plan's hash, and the composed envelope of 92,000 tokens and 23 remote calls", same(Object.values(plan.links).map((link) => link.decision), ["accepted", "accepted"]) && Object.values(plan.links).every((link) => /^[0-9a-f]{64}$/u.test(link.plan_hash)) && plan.execution.network.worst_case.tokens === 92000 && plan.execution.network.worst_case.remote_calls === 23 && plan.execution.network.worst_case.model_calls === 10, A.plan);
    const planText = await waitDom(`[...document.querySelectorAll("dt")].find((node) => node.textContent === "Linked agents")?.nextElementSibling?.textContent ?? null`, "the plan card's linked agents row").catch(() => null);
    check("the plan card names each linked agent with the decision", typeof planText === "string" && planText.includes("org.webagents.webair-flights 0.1.0 (webair-flights): accepted") && planText.includes("org.webagents.staymere-hotels 0.1.0 (hotel-aggregator): accepted"), planText);
    const started = await send({ type: "run.start", sessionId, runPlanId: plan.run_plan_id, runPlanSha256: plan.run_plan_sha256, input: packages.planner010.fixture.input });
    const record = await settle(started.runId);
    await show(`#run=${started.runId}`);
    await waitDom(`document.querySelectorAll(".ab-delegation-view [data-link]").length >= 2`, "the delegation view of the planned run");
    const tree = await treeInPage();
    const viewText = await dom(`document.querySelector(".ab-delegation-view").textContent`);
    await shot("05-run-planned");
    A.run = { runId: started.runId, status: record.status, errorCode: record.errorCode, usage: record.usage, tree, export: await exportRun(started.runId, "export-planned") };
    const plannedRequests = report.requests.model.filter((item) => item.scenario === "A.planned");
    check("the planned run completes", record.status === "completed", { status: record.status, errorCode: record.errorCode, failure: record.failure ?? null });
    check("every model request of the planned run matched a fixture case exactly: 10 calls, none improvised", plannedRequests.length === 10 && plannedRequests.every((item) => item.matched && !item.improvised), plannedRequests.map((item) => [item.task, item.matched, item.improvised]));
    check("each linked agent's service was called once at its own origin, and the planner's calendar once", same(report.requests.origins.filter((item) => item.scenario === "A.planned" && item.tool !== null).map((item) => `${item.host}:${item.tool}`).sort(), [`${HOSTS.webair}:search-flights`, `${HOSTS.staymere}:search-hotels`, `${HOSTS.webair}:check-calendar`].sort()), report.requests.origins.filter((item) => item.scenario === "A.planned"));
    check("the delegation view shows two links, each answered, under the role that asked", same(tree, [{ role: "Flights", kind: "link", name: "webair-flights", state: "answered", package_id: "org.webagents.webair-flights" }, { role: "Hotels", kind: "link", name: "hotel-aggregator", state: "answered", package_id: "org.webagents.staymere-hotels" }]), tree);
    const plannedAudit = auditOf(A.run.export.directory);
    check("the rendered tree equals the audit's link events", same(tree, treeOf(plannedAudit)), { page: tree, audit: treeOf(plannedAudit) });
    check("the view shows what crossed as hashes and none of the trip's words", viewText.includes("What was sent") && !viewText.includes("Reykjavik") && !viewText.includes("Boston"), viewText.slice(0, 400));
    const names = A.run.export.entries.map((entry) => entry.name);
    const innerRuns = JSON.parse(readFileSync(join(ROOT, A.run.export.directory, "links.json"), "utf8")).runs;
    check("the export carries the links record, each inner Run Plan and each inner run's files", ["run.json", "run-plan.json", "result.json", "audit.json", "usage.json", "provenance.json", "links.json", "link-plan-webair-flights.json", "link-plan-hotel-aggregator.json"].every((name) => names.includes(name)) && innerRuns.length === 2 && innerRuns.every((inner) => ["audit", "result", "usage", "provenance"].every((kind) => names.includes(`link-${inner.inner_run_id}.${kind}.json`))), names);
    const referenceAudit = JSON.parse(readFileSync(join(referenceOut, "audit.json"), "utf8"));
    check("the same link events, in the same order, as the reference's fixture run of the same archive", same(linkEvents(plannedAudit), linkEvents(referenceAudit)), { chrome: linkEvents(plannedAudit), reference: linkEvents(referenceAudit) });
    const observed = [...new Set(A.run.export.observations.map((item) => `${item.kind}:${new URL(item.url).host}`))].sort();
    check("the privacy observer, recording, saw only the scripted Ollama and the three origins of the plan's tools", same(observed, [`model:127.0.0.1:${ollama.port}`, `tool:${HOSTS.staymere}`, `tool:${HOSTS.webair}`].sort()), observed);

    // ---------------------------------------------------------------------------------------------
    // Scenario B: the planner 0.2.0, the slot.
    // ---------------------------------------------------------------------------------------------
    const B = (report.scenarios.join = {});
    const joinRun = async (label, path, signer, plannerDigest, fixture) => {
      modelState.scenario = `B.${label}.review`;
      const view = await send({ type: "package.open", url: `https://${HOSTS.tripwright}${path}`, advertisedOn: null, viewId: "e2e" });
      const id = view.session.id;
      const links = await send({ type: "links.resolve", sessionId: id, packageDigest: plannerDigest });
      // The publishers of scenario A stay trusted (one browser); the variant's throwaway key is pinned here.
      if (view.summary.publisher.trust_status !== "trusted") await send({ type: "trust.pin", sessionId: id, signerFingerprint: signer, scope: "package" });
      const authorized = await send({ type: "authorization.authorize", sessionId: id, packageDigest: plannerDigest, decisions: JSON.parse(readFileSync(EXAMPLES("link/travel-planner-0.2.0-grants.json"), "utf8")), toolApprovals: { "check-calendar": true, "web.search": true }, resourceSelections: {}, provenance: null, prepare: true });
      const joinPlan = authorized.run_plan?.run_plan ?? null;
      if (!joinPlan) throw new Error(`no run plan for ${label} (${JSON.stringify(authorized.plan_refused ?? null).slice(0, 300)})`);
      await show(`#session=${id}`);
      modelState.scenario = `B.${label}`;
      // What no model request may hold before the decision: the candidate's own description and its input schema's words.
      modelState.mentions = [String(JSON.parse(readFileSync(join(packages.salitubam.unpacked, "MANIFEST.agent"), "utf8")).description)];
      const salitubamBefore = hits(HOSTS.salitubam).length;
      const begun = await send({ type: "run.start", sessionId: id, runPlanId: joinPlan.run_plan_id, runPlanSha256: joinPlan.run_plan_sha256, input: fixture.input });
      const waiting = await settle(begun.runId, (run) => (run.runCard ?? null) !== null);
      await waitDom(`!!document.querySelector(".ab-join-card")`, `the join card of ${label}`);
      const card = await dom(`(() => { const node = document.querySelector(".ab-join-card"); return { slot: node.dataset.slot, terms: [...node.querySelectorAll("dl.ab-defs > dt")].map((item) => item.textContent), words: [...node.querySelectorAll("[data-words]")].map((item) => [item.dataset.words, item.querySelector("q").textContent]), decline: node.querySelector('button[data-card-decide="decline"]').className, accept: node.querySelector('button[data-card-decide="accept"]').className, grants: [...node.querySelectorAll("[data-permission] select")].map((select) => select.value), text: node.textContent }; })()`);
      const before = { model: report.requests.model.filter((item) => item.scenario === `B.${label}`).map((item) => ({ task: item.task, matched: item.matched, mentions: item.mentions })), salitubam: hits(HOSTS.salitubam).slice(salitubamBefore), looking: await treeInPage() };
      await shot(`06-join-card-${label}`);
      await click('.ab-join-card button[data-card-decide="accept"]');
      const final = await settle(begun.runId);
      await show(`#run=${begun.runId}`);
      await waitDom(`!!document.querySelector(".ab-delegation-view")`, `the delegation view of ${label}`);
      const joinTree = await treeInPage();
      await shot(`07-run-${label}`);
      return { sessionId: id, links: links.links.length, plan: { run_plan_sha256: joinPlan.run_plan_sha256, network: joinPlan.execution.network?.worst_case ?? null }, runId: begun.runId, waiting: { status: waiting.status, card: waiting.runCard }, card, before, status: final.status, errorCode: final.errorCode, failure: final.failure ?? null, tree: joinTree, export: await exportRun(begun.runId, `export-${label}`) };
    };
    const CARD_TERMS = ["Publisher key", "Agent", "Named", "Described as", "Found on", "Its tools", "Its permissions", "Your records it asks for", "Model", "The agent may send it", "Why the agent asks", "At most, if you accept", "Within the step's ceiling", "The “at most” you accepted", "This run has left", "Cards"];
    const cardChecks = (label, run) => {
      const facts = run.waiting.card?.facts ?? {};
      check(`${label}: the run reached the join card with the core's facts: the slot, the candidate's key (unknown), its package, where it was found, its worst case inside the ceiling`, run.waiting.card?.kind === "link.join" && facts.slot === "named-hotel" && facts.publisher?.signer === packages.salitubam.facts.signer && facts.publisher?.trust === "unknown" && facts.package?.digest === packages.salitubam.facts.digest && facts.source?.page_url === `https://${HOSTS.salitubam}/` && facts.source?.package_url === `https://${HOSTS.salitubam}/agent.pkg` && facts.worst_case?.tokens === 6000 && facts.ceiling?.tokens === 6000 && facts.at_most_unchanged === true, run.waiting.card);
      check(`${label}: the card in the page states the facts in their order, the publisher's and the agent's words quoted and attributed, declining the default`, same(run.card.terms, CARD_TERMS) && run.card.words[0]?.[0] === "the publisher's name for it" && run.card.words.filter((item) => item[0] === "the agent's words").length === 1 && run.card.words.every((item) => ["the publisher's name for it", "the publisher's words", "the agent's words"].includes(item[0])) && run.card.decline.includes("ab-button-primary") && !run.card.accept.includes("ab-button-primary") && same(run.card.grants, ["session", "session", "session"]) && run.card.text.includes("No answer is a no"), run.card);
      check(`${label}: before the decision the hotel was sent two plain GETs (its page, its package) and nothing else`, same(run.before.salitubam, ["GET /", "GET /agent.pkg"]), run.before.salitubam);
      check(`${label}: before the decision no model request was a request-building call and none held the candidate's description`, run.before.model.every((item) => item.task !== "request" && item.matched && item.mentions.length === 0), run.before.model);
      check(`${label}: before the decision the delegation view already shows the two planned links answered and the join found, not yet running`, same(run.before.looking.map((item) => [item.name, item.state]), [["webair-flights", "answered"], ["hotel-aggregator", "answered"], ["named-hotel", "looking"]]), run.before.looking);
    };

    // B1. The signed 0.2.0: the card, the acceptance, then the request-building call against FindHotel's own budget.
    B.signed = await joinRun("signed", PLANNER_PATHS.planner020, packages.planner020.facts.signer, packages.planner020.facts.digest, packages.planner020.fixture);
    cardChecks("the signed planner 0.2.0", B.signed);
    check("the signed planner 0.2.0's plan states the slot at its ceiling: 14 model calls, 33 remote calls, 122,000 tokens", B.signed.plan.network?.model_calls === 14 && B.signed.plan.network.remote_calls === 33 && B.signed.plan.network.tokens === 122000, B.signed.plan);
    const signedAudit = auditOf(B.signed.export.directory);
    const refusal = signedAudit.find((event) => event.action === "model.refused") ?? null;
    B.signed.refusal = refusal ? { task: refusal.task, reason: refusal.reason, input_bound: refusal.input_bound, max_output_tokens: refusal.max_output_tokens, reserved_tokens: refusal.reserved_tokens, limit: refusal.limit } : null;
    check("the signed planner 0.2.0: the acceptance is recorded as the person's, and the request-building call is then refused by FindHotel's own token budget under this host's UTF-8 input bound (a finding, D-707)", signedAudit.some((event) => event.action === "link.decided" && event.accepted === true && event.decided_by === "person") && refusal?.task === "request" && refusal.reason === "worker_token_budget" && refusal.limit === signedTokens && refusal.reserved_tokens > refusal.limit && B.signed.status === "failed" && B.signed.errorCode === "budget_exhausted" && !signedAudit.some((event) => event.action === "budget.requested"), { refusal: B.signed.refusal, status: B.signed.status, errorCode: B.signed.errorCode });
    check("the signed planner 0.2.0: nothing was sent to the hotel beyond the look and the download", report.requests.origins.filter((item) => item.scenario === "B.signed" && item.host === HOSTS.salitubam).length === 0, report.requests.origins.filter((item) => item.scenario === "B.signed" && item.host === HOSTS.salitubam));

    // B2. The variant (FindHotel 6,000 tokens, a throwaway key): the join completes.
    B.variant = await joinRun("variant", PLANNER_PATHS.variant, variant.facts.signer, variant.facts.digest, variant.fixture);
    cardChecks("the variant", B.variant);
    const variantAudit = auditOf(B.variant.export.directory);
    const variantRequests = report.requests.model.filter((item) => item.scenario === "B.variant");
    check("the variant: the run completes after the card was accepted in the page", B.variant.status === "completed", { status: B.variant.status, errorCode: B.variant.errorCode, failure: B.variant.failure });
    check("the variant: every model request matched a fixture case exactly, and exactly one was the request-building call, after the decision", variantRequests.every((item) => item.matched && !item.improvised) && variantRequests.filter((item) => item.task === "request").length === 1 && variantRequests.length === 14, variantRequests.map((item) => [item.task, item.matched]));
    check("the variant: at the slot's step the audit holds requested, decided (accepted by the person), started, completed, in that order", same(variantAudit.filter((event) => event.slot === "named-hotel").map((event) => event.action), ["link.requested", "link.decided", "link.started", "link.completed"]), variantAudit.filter((event) => event.slot === "named-hotel").map((event) => event.action));
    check("the variant: the hotel's own service was called once, after the decision, and nothing else was sent to it", same(report.requests.origins.filter((item) => item.scenario === "B.variant" && item.host === HOSTS.salitubam).map((item) => `${item.method} ${item.path}`), ["POST /api/v1/hotel/availability"]), report.requests.origins.filter((item) => item.scenario === "B.variant" && item.host === HOSTS.salitubam));
    check("the variant: the delegation view shows three links answered, the third a join of Hotel Salitubam, and equals the audit's link events", same(B.variant.tree, [{ role: "Flights", kind: "link", name: "webair-flights", state: "answered", package_id: "org.webagents.webair-flights" }, { role: "Hotels", kind: "link", name: "hotel-aggregator", state: "answered", package_id: "org.webagents.staymere-hotels" }, { role: "FindHotel", kind: "join", name: "named-hotel", state: "answered", package_id: "org.webagents.hotel-salitubam" }]) && same(B.variant.tree, treeOf(variantAudit)), { page: B.variant.tree, audit: treeOf(variantAudit) });
    const joinRecord = JSON.parse(readFileSync(join(ROOT, B.variant.export.directory, "links.json"), "utf8"));
    check("the variant: the record's join names the caller's Run Plan, this run and the slot, and the card's grants", joinRecord.joins?.length === 1 && joinRecord.joins[0].joined === true && joinRecord.caller_plan_hash === B.variant.plan.run_plan_sha256 && joinRecord.joins[0].package?.plan?.parent?.plan_hash === B.variant.plan.run_plan_sha256 && joinRecord.joins[0].package.plan.parent.slot === "named-hotel" && same(joinRecord.joins[0].package.plan.tool_approvals, ["check-availability"]), joinRecord.joins);
  } catch (error) {
    report.failures.push(`harness: ${error.message}`);
  } finally {
    if (chrome) {
      const exited = chrome.exitCode !== null ? Promise.resolve() : new Promise((resolveExit) => chrome.once("exit", resolveExit));
      chrome.kill();
      await Promise.race([exited, sleep(10_000)]);
    }
    for (const origin of origins) origin.server.close();
    ollama?.server.close();
    if (!args.keep) rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
  report.passed = report.failures.length === 0;
  const text = `${JSON.stringify(report, null, 2)}\n`;
  writeFileSync(args.out, text);
  writeFileSync(join(outDir, "report.json"), text);
  process.stdout.write(text);
  log(`report written to ${relative(ROOT, args.out)}; exports under ${report.outputDirectory}`);
  process.exit(report.passed ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
