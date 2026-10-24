#!/usr/bin/env node
/**
 * conversation.v0 in a real Chrome (T24, D-270, D-271, D-272): the built extension, headless, holds a
 * two-turn conversation with the ticket-desk probe (`agentpkg/tests/conversation_probe.py`, the
 * conformance suite's conversational package, with its order tool remote), opened from a local HTTPS
 * origin and talked to through the extension's own messages, as the chat panel talks to it:
 *
 *   - turn 1, "order A": the interpreter (a scripted Ollama on a loopback port, answering the probe's
 *     table) reads an order; the turn reaches the consent step `confirm` and waits; the card's text
 *     and facts are in the stored run and the conversation view; the desk has not been called; the
 *     harness answers Yes (`conversation.decide`); the order is placed at the desk origin; the turn
 *     completes with the decision `decided_by: person` in the transcript;
 *   - turn 2, "done": the package's end rule closes the conversation (`ended.reason: package`);
 *   - the export (D-272) is written under `examples/my-chrome-conversation-<stamp>/`, each turn's
 *     recorded requests (the privacy observer, recording on) beside it, and
 *     `scripts/verify_chrome_conversation.py` recomputes the checks: the transcript against the
 *     contract, one valid chain across the turns, every decision hashed in the audit, the card before
 *     the decision, every request to the two fake origins and nowhere else, and the reference's
 *     fixture replay of the same transcript giving the same replies and state.
 *
 * Nothing here reaches the network: Ollama is a Node server on 127.0.0.1 (the extension's Ollama
 * connection is pointed at it), the desk is a Node HTTPS server behind `--host-resolver-rules`.
 *
 *   npm run build && node scripts/e2e-conversation.mjs [--chrome path] [--out report.json] [--keep]
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
const PYTHON = process.env.AGENTPKG_PYTHON || join(ROOT, "agentpkg", ".venv", "bin", "python");
const DESK_HOST = "desk.example.org";
const MODEL_NAME = "desk-script";
/** The probe's table (`conversation_probe.py` MESSAGES / ORDERS): what the clerk reads and what the desk answers. */
const MESSAGES = {
  "order A": { intent: "order", show: "Show A", quantity: 1, reply: "Order one ticket to Show A?" },
  "order B": { intent: "order", show: "Show B", quantity: 2, reply: "Order two tickets to Show B?" },
  hello: { intent: "chat", show: null, quantity: null, reply: "Hello! Which show?" },
  done: { intent: "done", show: null, quantity: null, reply: "Goodbye." },
};
const ORDERS = [
  ["Show A", 1, { order_id: "TD-0001", show: "Show A", quantity: 1, total_usd: 40 }],
  ["Show B", 2, { order_id: "TD-0002", show: "Show B", quantity: 2, total_usd: 90 }],
];

const args = { chrome: process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", out: join(ROOT, "examples", "verification", "chrome-conversation-e2e-t24.json"), keep: false };
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
for (const [path, hint] of [[join(EXTENSION, "manifest.json"), "run `npm run build` first"], [AGENTPKG, "create agentpkg/.venv (CLAUDE.md, Conventions)"], [args.chrome, "pass --chrome <path>"]]) {
  if (!existsSync(path)) {
    console.error(`${path} is missing: ${hint}`);
    process.exit(2);
  }
}

const startedAt = new Date();
const stamp = startedAt.toISOString().replace(/[:.]/gu, "-");
const outDir = join(ROOT, "examples", `my-chrome-conversation-${stamp}`);
mkdirSync(outDir, { recursive: true });
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const report = { profile: "chrome-conversation-e2e-v0", recordedAt: startedAt.toISOString(), chrome: null, model: null, outputDirectory: relative(ROOT, outDir), exportDirectory: null, package: null, fakes: { ollama: null, desk: null }, plan: null, conversation: null, card: null, decision: null, turns: [], requests: { model: [], desk: [] }, observations: {}, checks: {}, failures: [], passed: false };
const check = (name, condition, detail) => {
  report.checks[name] = condition ? "ok" : { failed: detail ?? null };
  if (!condition) report.failures.push(`${name}${detail === undefined ? "" : ` (${JSON.stringify(detail).slice(0, 400)})`}`);
};
const log = (text) => process.stderr.write(`[${Math.round((Date.now() - startedAt.getTime()) / 1000)}s] ${text}\n`);
const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
/** Structural equality with object keys sorted: the extension stores canonical JSON. */
const canonical = (value) => (Array.isArray(value) ? `[${value.map(canonical).join(",")}]` : value && typeof value === "object" ? `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}` : JSON.stringify(value));
const same = (a, b) => canonical(a) === canonical(b);

/** The probe with its order tool remote, built and signed under a throwaway key. */
function probe(scratch) {
  const source = join(scratch, "probe");
  execFileSync(PYTHON, ["-c", `import sys; sys.path.insert(0, ${JSON.stringify(join(ROOT, "agentpkg", "tests"))}); from pathlib import Path; import conversation_probe as probe; probe.write_probe(Path(${JSON.stringify(source)}), remote_tool=True)`], { stdio: ["ignore", "ignore", "pipe"] });
  const built = join(scratch, "probe.unsigned.agent.pkg");
  const signed = join(scratch, "probe.agent.pkg");
  const quiet = { stdio: ["ignore", "ignore", "pipe"] };
  try {
    execFileSync(AGENTPKG, ["keygen", "--private-key", join(scratch, "probe.private.pem"), "--public-key", join(scratch, "probe.pub.pem")], quiet);
    execFileSync(AGENTPKG, ["build", source, "-o", built], quiet);
    execFileSync(AGENTPKG, ["sign", "--private-key", join(scratch, "probe.private.pem"), "-o", signed, built], quiet);
  } catch (error) {
    throw new Error(`probe: ${String(error.stderr ?? error.message).trim().split("\n").pop()}`);
  }
  const verified = JSON.parse(execFileSync(AGENTPKG, ["verify", signed, "--trust-key", join(scratch, "probe.pub.pem")], { encoding: "utf8" }));
  const manifest = JSON.parse(readFileSync(join(source, "MANIFEST.agent"), "utf8"));
  return { source, signed, key: join(scratch, "probe.pub.pem"), bytes: readFileSync(signed), digest: verified.digest, fingerprint: verified.key_fingerprint, packageId: manifest.package_id, version: manifest.version, fixtureTranscript: JSON.parse(readFileSync(join(source, "fixtures", "transcript.json"), "utf8")) };
}

/** A scripted Ollama on a loopback port: `/api/tags`, `/api/show`, `/api/chat` answering the probe's table. */
function fakeOllama(seen) {
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
      if (request.method === "POST" && request.url === "/api/show") return answer(200, { model_info: { "desk.context_length": 8192 }, capabilities: ["completion"] });
      if (request.method === "POST" && request.url === "/api/chat") {
        const parsed = JSON.parse(body || "{}");
        const system = parsed.messages?.find((message) => message.role === "system")?.content ?? "";
        const user = parsed.messages?.find((message) => message.role === "user")?.content ?? "null";
        const task = /^## Task\n(.+)$/mu.exec(system)?.[1] ?? "";
        const text = JSON.parse(user)?.text;
        seen.push({ at: new Date().toISOString(), task, text: text ?? null, bytes: Buffer.byteLength(body), format: parsed.format ? "schema" : null, think: parsed.think ?? null });
        const scripted = task === "interpret" ? MESSAGES[String(text)] : null;
        if (!scripted) return answer(400, { error: `no scripted answer for task ${task} and text ${JSON.stringify(text)}` });
        const content = JSON.stringify(scripted);
        return answer(200, { model: parsed.model ?? MODEL_NAME, message: { role: "assistant", content }, done: true, done_reason: "stop", prompt_eval_count: Math.ceil(system.length / 4), eval_count: Math.ceil(content.length / 4) });
      }
      return answer(404, { error: "not found" });
    });
  });
  return new Promise((resolveServer) => server.listen(0, "127.0.0.1", () => resolveServer({ server, port: server.address().port })));
}

async function main() {
  const scratch = mkdtempSync(join(realpathSync(tmpdir()), "chrome-conversation-"));
  const profile = join(scratch, "profile");
  let chrome = null;
  let desk = null;
  let ollama = null;
  try {
    const pkg = probe(scratch);
    report.package = { package_id: pkg.packageId, version: pkg.version, digest: pkg.digest, archiveSha256: sha256(pkg.bytes), bytes: pkg.bytes.length, signer: pkg.fingerprint, fixtureTranscript: pkg.fixtureTranscript };
    // The reference on the same signed bytes: the probe's own fixture transcript replayed, for the verifier to compare.
    const referenceOut = join(outDir, "reference");
    const grants = join(scratch, "grants.json");
    writeFileSync(grants, JSON.stringify({ "model.reasoning": "session", "memory.session": "session", "orders.place": "once", "network.desk": "session" }));
    execFileSync(AGENTPKG, ["converse", pkg.signed, "--mode", "fixture", "--grants", grants, "--approve-tool", "place", "--trust-key", pkg.key, "--out", referenceOut], { stdio: ["ignore", "ignore", "pipe"] });
    report.reference = { directory: relative(ROOT, referenceOut), transcript: JSON.parse(readFileSync(join(referenceOut, "transcript.json"), "utf8")).turns.map((turn) => ({ turn: turn.turn, status: turn.status, reply: turn.reply })) };

    ollama = await fakeOllama(report.requests.model);
    report.fakes.ollama = `http://127.0.0.1:${ollama.port}`;
    const tls = certificate(scratch, DESK_HOST);
    const deskSeen = report.requests.desk;
    desk = await serveFiles(tls, { "/agent.pkg": { bytes: pkg.bytes, type: "application/vnd.webagents.agent-package" } }, (method, path, body) => {
      deskSeen.push({ at: new Date().toISOString(), method, path, body: body.slice(0, 400) });
      if (method !== "POST" || path !== "/api/orders") return { status: 404, value: { error: { code: "not_found", message: "no", details: [] } } };
      const wanted = JSON.parse(body || "{}");
      const order = ORDERS.find(([show, quantity]) => show === wanted.show && quantity === wanted.quantity);
      return order ? { status: 200, value: order[2] } : { status: 422, value: { error: { code: "unknown_show", message: "no such show", details: [] } } };
    });
    report.fakes.desk = `https://${DESK_HOST} -> 127.0.0.1:${desk.port}`;

    chrome = spawn(args.chrome, ["--headless=new", "--remote-debugging-pipe", "--enable-unsafe-extension-debugging", `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check", `--host-resolver-rules=MAP ${DESK_HOST} 127.0.0.1:${desk.port}`, `--ignore-certificate-errors-spki-list=${tls.spkiHash}`, "about:blank"], { stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"] });
    const cdp = new Cdp(chrome);
    const version = await cdp.send("Browser.getVersion");
    report.chrome = version.product;
    const granted = grantedBuild(EXTENSION, scratch, [`https://${DESK_HOST}`]);
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

    // 0. Settings: the scripted Ollama, test mode (the privacy observer records every request).
    const settings = (await send({ type: "settings.get" })).settings;
    settings.developer = { record_requests: true };
    settings.models.default_model = `ollama/${MODEL_NAME}`;
    settings.models.connections = settings.models.connections.map((connection) => (connection.provider === "ollama" ? { ...connection, enabled: true, base_url: report.fakes.ollama } : connection));
    await send({ type: "settings.set", settings });
    const probed = await send({ type: "models.probe", provider: "ollama" });
    report.model = probed.models.find((model) => model.id === `ollama/${MODEL_NAME}`) ?? null;
    check("the scripted Ollama is offered as a local model", probed.ok === true && report.model !== null, { ok: probed.ok, error: probed.error, offered: probed.models.map((model) => model.id) });

    // 1. Open, pin, authorize: the plan carries the conversation section (D-270).
    const view = await send({ type: "package.open", url: `https://${DESK_HOST}/agent.pkg`, advertisedOn: `https://${DESK_HOST}/`, viewId: "e2e" });
    const sessionId = view.session.id;
    await send({ type: "trust.pin", sessionId, signerFingerprint: pkg.fingerprint, scope: "publisher" });
    const authorized = await send({ type: "authorization.authorize", sessionId, packageDigest: pkg.digest, decisions: { "model.reasoning": "session", "memory.session": "session", "orders.place": "once", "network.desk": "session" }, toolApprovals: { place: true }, resourceSelections: {}, provenance: null, prepare: true });
    const plan = authorized.run_plan?.run_plan ?? null;
    if (!plan) throw new Error(`no run plan (${JSON.stringify(authorized.plan_refused ?? null).slice(0, 300)})`);
    report.plan = { run_plan_id: plan.run_plan_id, conversation: plan.execution.conversation, grants: Object.fromEntries((plan.grants?.decisions ?? []).map((item) => [item.permission_id ?? item.permissionId, item.decision])), warnings: view.summary.warnings.map((warning) => warning.code) };
    check("the plan declares the conversation: 4 turns, the persistent keys, the consent step on orders.place (payment), not pre-decided", plan.execution.conversation?.max_turns === 4 && same(plan.execution.conversation.persistent_keys, ["history", "orders"]) && plan.execution.conversation.consent_steps?.[0]?.id === "confirm" && plan.execution.conversation.consent_steps[0].kinds?.includes("payment") && plan.execution.conversation.consent_steps[0].pre_decided === null, plan.execution.conversation);
    check("the agent page says the package converses", report.plan.warnings.includes("conversational_package"), report.plan.warnings);
    // A conversation is not a task: the one-shot path refuses the plan (V-28).
    let refused = null;
    try {
      await send({ type: "run.start", sessionId, runPlanId: plan.run_plan_id, runPlanSha256: plan.run_plan_sha256, input: { text: "order A" } });
    } catch (error) {
      refused = error.code;
    }
    check("run.start refuses the conversational plan (conversation_profile)", refused === "conversation_profile", refused);

    // 2. Start, say "order A", reach the card.
    const started = await send({ type: "conversation.start", sessionId, runPlanId: plan.run_plan_id, runPlanSha256: plan.run_plan_sha256 });
    const conversationId = started.conversationId;
    report.conversation = { conversationId, status: started.status, limits: started.limits, state: started.state };
    check("the conversation starts open, with the initial state", started.status === "open" && started.turns === 0 && same(started.state, { history: [], orders: [] }), started);
    const get = () => send({ type: "conversation.get", conversationId });
    const waitFor = async (predicate, label, timeoutMs = 60_000) => {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const current = await get();
        if (predicate(current)) return current;
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
        await sleep(200);
      }
    };
    const sent = await send({ type: "conversation.send", conversationId, message: { text: "order A" } });
    check("the first turn starts as a run of the conversation", sent.activeRunId !== null && sent.activeRun?.conversation?.turn === 1, { activeRunId: sent.activeRunId, activeRun: sent.activeRun?.conversation ?? null });
    const waiting = await waitFor((current) => current.pendingConsent !== null, "the consent card");
    const cardSeenAt = new Date().toISOString();
    report.card = { ...waiting.pendingConsent, seen_at: cardSeenAt, desk_requests_before: deskSeen.length, model_requests_before: report.requests.model.length };
    check("the turn waits on the card: confirm / orders.place / payment, the clerk's sentence and the order's facts", waiting.pendingConsent.step === "confirm" && same(waiting.pendingConsent.permissions, ["orders.place"]) && waiting.pendingConsent.kinds?.includes("payment") && waiting.pendingConsent.text === "Order one ticket to Show A?" && same(waiting.pendingConsent.facts, { show: "Show A", quantity: 1 }), waiting.pendingConsent);
    check("before the answer the desk was not called and the model was called once", deskSeen.length === 0 && report.requests.model.length === 1, { desk: deskSeen.length, model: report.requests.model.length });
    await cdp.evaluate(page, `location.hash = ${JSON.stringify(`#conversation=${conversationId}`)}`);
    await sleep(800);
    await shot("01-card");

    // 3. Yes: the order is placed, the turn completes with the person's decision.
    await send({ type: "conversation.decide", conversationId, step: "confirm", accepted: true });
    report.decision = { step: "confirm", accepted: true, decided_at: new Date().toISOString() };
    const first = await waitFor((current) => current.activeRunId === null && current.transcript.length === 1, "the first turn settled");
    const turn1 = first.transcript[0];
    report.turns.push({ turn: 1, status: turn1.status, error_code: turn1.error_code, decisions: turn1.decisions, reply: turn1.reply, usage: turn1.usage, run_id: turn1.run_id });
    check("turn 1 completes: the decision by the person, the order in the reply, the state carries it", turn1.status === "completed" && turn1.decisions?.length === 1 && turn1.decisions[0].decided_by === "person" && turn1.decisions[0].accepted === true && same(turn1.reply?.order, ORDERS[0][2]) && same(first.state, { history: [{ text: "order A", intent: "order" }], orders: [ORDERS[0][2]] }), { turn1, state: first.state });
    check("the desk was called exactly once, after the decision", deskSeen.length === 1 && deskSeen[0].at > report.decision.decided_at, deskSeen);
    check("the once grant was spent by the order", same(first.spent.permissions, ["orders.place"]) && first.spent.tool_calls?.place === 1, first.spent);
    await sleep(500);
    await shot("02-turn-1");

    // 4. "done": the package ends the conversation.
    await send({ type: "conversation.send", conversationId, message: { text: "done" } });
    const ended = await waitFor((current) => current.status === "ended", "the conversation to end");
    const turn2 = ended.transcript[1];
    report.turns.push({ turn: 2, status: turn2.status, error_code: turn2.error_code, decisions: turn2.decisions, reply: turn2.reply, usage: turn2.usage, run_id: turn2.run_id });
    report.conversation = { ...report.conversation, status: ended.status, ended: ended.ended, outcome: ended.outcome, spent: ended.spent, state: ended.state, turns: ended.turns };
    check("turn 2 completes and the package ends the conversation", turn2.status === "completed" && turn2.reply?.intent === "done" && ended.ended?.reason === "package" && ended.outcome === "completed" && ended.turns === 2, { turn2, ended: ended.ended, outcome: ended.outcome });
    check("the second turn asked no card and placed no order", (turn2.decisions ?? []).length === 0 && deskSeen.length === 1 && report.requests.model.length === 2, { decisions: turn2.decisions, desk: deskSeen.length, model: report.requests.model.length });
    await sleep(500);
    await shot("03-ended");

    // 5. The export (D-272) and the recorded requests of each turn.
    const bundle = await send({ type: "conversation.export", conversationId });
    const exportDir = join(outDir, "export");
    for (const entry of bundle.entries) {
      const path = join(exportDir, entry.name);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, Buffer.from(entry.base64, "base64"));
    }
    report.exportDirectory = relative(ROOT, exportDir);
    report.export = { entries: bundle.entries.map((entry) => ({ name: entry.name, bytes: entry.bytes, sha256: entry.sha256 })) };
    const names = bundle.entries.map((entry) => entry.name);
    check("the export carries the conversation's records and each turn's files", ["conversation.json", "run-plan.json", "transcript.json", "state.json", "audit.json", "usage.json", "provenance.json", "turn-001/run.json", "turn-001/result.json", "turn-001/audit.json", "turn-002/result.json"].every((name) => names.includes(name)), names);
    for (const turn of ended.transcript) {
      if (!turn.run_id) continue;
      const observations = await send({ type: "run.observations", runId: turn.run_id });
      const prefix = `turn-${String(turn.turn).padStart(3, "0")}`;
      writeFileSync(join(exportDir, prefix, "observations.json"), `${JSON.stringify(observations, null, 2)}\n`);
      report.observations[prefix] = { recording: observations.recording, count: observations.observations.length, kinds: observations.observations.map((item) => `${item.kind}:${new URL(item.url).host}`) };
    }
    check("the privacy observer, recording, saw turn 1's model and desk requests and turn 2's model request, nowhere else", report.observations["turn-001"]?.recording === true && same(report.observations["turn-001"].kinds, [`model:127.0.0.1:${ollama.port}`, `tool:${DESK_HOST}`]) && same(report.observations["turn-002"]?.kinds, [`model:127.0.0.1:${ollama.port}`]), report.observations);
    // The Runs page lists the conversation with its turns.
    const listed = await send({ type: "conversation.list", sessionId });
    check("the conversation is listed for the session with two turns", listed.conversations.some((item) => item.conversationId === conversationId && item.turns === 2 && item.status === "ended"), listed.conversations);
    const runs = await send({ type: "run.list" });
    check("the turns are runs of the conversation", runs.runs.filter((run) => run.conversation?.conversationId === conversationId).length === 2, runs.runs.map((run) => run.conversation ?? null));
  } catch (error) {
    report.failures.push(`harness: ${error.message}`);
  } finally {
    if (chrome) {
      const exited = chrome.exitCode !== null ? Promise.resolve() : new Promise((resolveExit) => chrome.once("exit", resolveExit));
      chrome.kill();
      await Promise.race([exited, sleep(10_000)]);
    }
    desk?.server.close();
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
