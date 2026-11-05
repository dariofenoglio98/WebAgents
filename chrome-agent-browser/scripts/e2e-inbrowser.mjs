#!/usr/bin/env node
/**
 * In-browser inference end to end (T41, D-440…D-459): the built extension in a real headless Chrome,
 * the product path from the curated list to a WebAir 0.8.0 search answered by a model the extension
 * runs itself on the GPU. Nothing in the extension is relaxed; Chrome is told only that
 * `huggingface.co` and the WebAir hostname are local origins (a throwaway certificate whose key
 * alone it trusts), so the download is the product's own downloader over the product's own URL
 * checks, from a server that answers with the very file Hugging Face publishes (the cached copy,
 * its SHA-256 the signed list's).
 *
 *   Phase A (this script's Chrome):
 *     1. the machine: the engine Worker's probe and the kernel benchmark (`inbrowser.measure`);
 *     2. the recommendation for the entry (`inbrowser.get`);
 *     3. the download: `inbrowser.download` for the entry, followed until the file is verified by
 *        digest; the GGUF header read from the cached bytes equals T40's reference facts;
 *     4. a digest mismatch: a pasted repository (served locally) whose file does not match the
 *        SHA-256 its API states is refused and leaves no file;
 *     5. too large: with "This machine's GPU memory" stated as 1 GB the entry is not available, with
 *        both numbers, and a load is refused before anything runs;
 *     6. the load at the entry's context (Settings → Load);
 *     7. the GPU did the work: one fixed completion on the loaded model, then the same on a CPU-only
 *        control load (`n_gpu_layers: 0`) of the same entry; the decode speeds side by side, and
 *        llama.cpp's own offload lines as wllama's logger passed them;
 *     8. the idle unload: the engine releases the model after its idle time (shortened to 6 s here).
 *   Phase B (`e2e-webair-live.mjs --profile`, the same profile): WebAir 0.8.0 from the local origin,
 *     the search conversation bound to `in-browser/<entry>` in test mode; the evidence is the
 *     conversation's export, copied with phase B's report beside `--out` (`<out>/search/`,
 *     `<out>/webair-live.json`, JSON only): the first turn completed with fares, every
 *     `model.called` with no domain, every recorded model request under `in-browser:<entry>`.
 *
 *   npm run build && node scripts/e2e-inbrowser.mjs [--entry qwen3-4b-q4_k_m] [--cache examples/my-inbrowser-spike-cache]
 *        [--out examples/verification/chrome-inbrowser-e2e.json] [--out-dir examples/my-inbrowser-e2e-<ts>] [--chrome path] [--keep] [--skip-webair]
 *
 * The cache directory holds `<owner>__<repo>__<file>` copies (the T40 spike's); a missing file is
 * downloaded once from Hugging Face by this script (2.5 GB for the 4B) and checked against the list.
 * `scripts/verify_chrome_inbrowser_e2e.py` recomputes the checks over the report and the exports.
 */
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { cpSync, createReadStream, createWriteStream, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { Cdp, sleep } from "./lib/cdp.mjs";
import { grantedBuild } from "./lib/granted-build.mjs";
import { certificate, serveFiles } from "./lib/origin.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const PROJECT = resolve(here, "..");
const ROOT = resolve(PROJECT, "..");
const EXTENSION = join(PROJECT, "dist", "extension");
const WEBAIR_SITE = "https://webagents-webair-production.up.railway.app/";
const HF_HOST = "huggingface.co";
const MISMATCH_REPO = "webagents-test/mismatch-GGUF";

const args = { chrome: process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", entry: "qwen3-4b-q4_k_m", cache: join(ROOT, "examples", "my-inbrowser-spike-cache"), out: join(ROOT, "examples", "verification", "chrome-inbrowser-e2e.json"), outDir: null, keep: false, skipWebair: false };
for (let index = 2; index < process.argv.length; index += 1) {
  const argument = process.argv[index];
  if (argument === "--chrome") args.chrome = process.argv[(index += 1)];
  else if (argument === "--entry") args.entry = process.argv[(index += 1)];
  else if (argument === "--cache") args.cache = resolve(process.argv[(index += 1)]);
  else if (argument === "--out") args.out = resolve(process.argv[(index += 1)]);
  else if (argument === "--out-dir") args.outDir = resolve(process.argv[(index += 1)]);
  else if (argument === "--keep") args.keep = true;
  else if (argument === "--skip-webair") args.skipWebair = true;
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

const startedAt = new Date();
const stamp = startedAt.toISOString().replace(/[:.]/gu, "-");
const outDir = args.outDir ?? join(ROOT, "examples", `my-inbrowser-e2e-${stamp}`);
mkdirSync(outDir, { recursive: true });
const log = (text) => process.stderr.write(`[${Math.round((Date.now() - startedAt.getTime()) / 1000)}s] ${text}\n`);
const report = { profile: "chrome-inbrowser-e2e-v0", recordedAt: startedAt.toISOString(), chrome: null, extension_version: JSON.parse(readFileSync(join(EXTENSION, "manifest.json"), "utf8")).version, entry: null, machine: null, recommendation: null, download: null, header: null, mismatch: null, too_large: null, load: null, gpu_vs_cpu: null, idle_unload: null, webair: null, out_dir: relative(ROOT, outDir), checks: {}, failures: [], passed: false };
const check = (name, condition, detail) => {
  report.checks[name] = condition ? "ok" : { failed: detail ?? null };
  if (!condition) report.failures.push(`${name}${detail === undefined ? "" : ` (${JSON.stringify(detail).slice(0, 500)})`}`);
  log(`${condition ? "ok  " : "FAIL"} ${name}`);
};
const sha256File = (path) => new Promise((resolveHash, rejectHash) => { const hash = createHash("sha256"); createReadStream(path).on("data", (chunk) => hash.update(chunk)).on("end", () => resolveHash(hash.digest("hex"))).on("error", rejectHash); });

/** The curated entry from the signed list's content (the bytes the extension ships verify to it; the unit tests hold the two equal). */
function curatedEntry(id) {
  const content = JSON.parse(readFileSync(join(ROOT, "examples", "model-catalog.content.json"), "utf8"));
  const entry = content.entries.find((item) => item.id === id);
  if (!entry) throw new Error(`the curated list has no entry ${id}`);
  if (entry.files.length !== 1) throw new Error(`${id}: this harness serves single-file entries`);
  return { entry, version: content.version };
}

/** The cached copy of the entry's file, verified against the list's digest (downloaded once if missing). */
async function cachedFile(entry) {
  const file = entry.files[0];
  const local = join(args.cache, `${entry.source.repository.replace("/", "__")}__${file.name}`);
  if (!existsSync(local)) {
    mkdirSync(args.cache, { recursive: true });
    log(`downloading ${file.url} once into ${relative(ROOT, local)} (${(file.bytes / 1e9).toFixed(1)} GB)`);
    const response = await fetch(file.url);
    if (!response.ok) throw new Error(`download failed: HTTP ${response.status}`);
    await new Promise((resolveWrite, rejectWrite) => {
      const out = createWriteStream(`${local}.part`);
      response.body.pipeTo(new WritableStream({ write: (chunk) => new Promise((ok) => out.write(chunk, ok)), close: () => new Promise((ok) => out.end(ok)) })).then(resolveWrite, rejectWrite);
    });
    renameSync(`${local}.part`, local);
  }
  const digest = await sha256File(local);
  if (digest !== file.sha256 || statSync(local).size !== file.bytes) throw new Error(`${relative(ROOT, local)} is not the file the list names (SHA-256 ${digest})`);
  return local;
}

const PAGE_HELPERS = String.raw`
window.__ib = {
  send(request) { return chrome.runtime.sendMessage(request); },
};
true`;

async function main() {
  const { entry, version: catalogVersion } = curatedEntry(args.entry);
  report.entry = { id: entry.id, display_name: entry.display_name, bytes_total: entry.bytes_total, weights_digest: entry.weights_digest, file: entry.files[0].name, sha256: entry.files[0].sha256, url: entry.files[0].url, catalog_version: catalogVersion };
  const local = await cachedFile(entry);
  log(`${entry.id}: ${relative(ROOT, local)} verified (${entry.files[0].sha256.slice(0, 16)}…)`);
  const t40 = JSON.parse(readFileSync(join(ROOT, "examples", "verification", "chrome-inbrowser-gguf-headers-t40.json"), "utf8")).files.find((item) => item.file === entry.files[0].name)?.facts ?? null;

  // The local Hugging Face: the entry's file at the URL the list names, and a repository whose API states a digest its file does not have.
  const scratch = mkdtempSync(join(realpathSync(tmpdir()), "chrome-inbrowser-e2e-"));
  const profile = join(scratch, "profile");
  mkdirSync(profile);
  const tls = certificate(scratch, HF_HOST);
  const fakeRevision = "0".repeat(39) + "1";
  const wrongBytes = randomBytes(64 * 1024);
  const statedDigest = createHash("sha256").update(randomBytes(64 * 1024)).digest("hex");
  const fileUrl = new URL(entry.files[0].url);
  const served = await serveFiles(tls, {
    [fileUrl.pathname]: { path: local, type: "application/octet-stream" },
    [`/api/models/${MISMATCH_REPO}?blobs=true`]: { bytes: Buffer.from(JSON.stringify({ id: MISMATCH_REPO, sha: fakeRevision, gated: false, cardData: { license: "apache-2.0" }, siblings: [{ rfilename: "tiny-Q4_0.gguf", size: wrongBytes.length, lfs: { sha256: statedDigest, size: wrongBytes.length } }, { rfilename: "README.md", size: 10 }] })), type: "application/json" },
    [`/${MISMATCH_REPO}/resolve/${fakeRevision}/tiny-Q4_0.gguf`]: { bytes: wrongBytes, type: "application/octet-stream" },
  });
  log(`local ${HF_HOST} on 127.0.0.1:${served.port}`);
  let chrome = null;
  try {
    chrome = spawn(args.chrome, ["--headless=new", "--remote-debugging-pipe", "--enable-unsafe-extension-debugging", `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check", `--host-resolver-rules=MAP ${HF_HOST} 127.0.0.1:${served.port}`, `--ignore-certificate-errors-spki-list=${tls.spkiHash}`, "about:blank"], { stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"] });
    const cdp = new Cdp(chrome);
    report.chrome = (await cdp.send("Browser.getVersion")).product;
    // The person's grants (D-196): huggingface.co (the first download asks for it) and the WebAir origin.
    const granted = grantedBuild(EXTENSION, profile, [`https://${HF_HOST}`, new URL(WEBAIR_SITE).origin]);
    const { id: extensionId } = await cdp.send("Extensions.loadUnpacked", { path: granted.path });
    const base = `chrome-extension://${extensionId}`;
    await cdp.waitForTarget((target) => target.type === "service_worker" && target.url === `${base}/service-worker.js`, "the service worker");
    const { targetId } = await cdp.send("Target.createTarget", { url: `${base}/browser.html` });
    const page = await cdp.attach(targetId);
    await cdp.waitFor(page, `typeof chrome !== "undefined" && !!chrome.runtime`, "the extension page");
    await cdp.evaluate(page, PAGE_HELPERS);
    const send = async (request) => {
      const reply = await cdp.evaluate(page, `__ib.send(${JSON.stringify(request)})`);
      if (!reply) throw new Error(`no reply to ${request.type}`);
      if (!reply.ok) throw Object.assign(new Error(`${request.type}: ${reply.error.code}: ${reply.error.message}`), { code: reply.error.code, reply: reply.error });
      return reply.result;
    };
    const refusal = async (request) => {
      try {
        await send(request);
        return null;
      } catch (error) {
        return { code: error.code ?? null, message: error.reply?.message ?? error.message };
      }
    };
    const viewEntry = async (id) => (await send({ type: "inbrowser.get", sessionId: null })).entries.find((item) => item.entry.id === id) ?? null;

    // 1. The machine.
    const machine = await send({ type: "inbrowser.measure" });
    report.machine = machine;
    const adapter = machine.probe?.adapter ?? null;
    check("the engine Worker sees WebGPU with a real adapter (not a fallback) and a device", machine.probe?.has_webgpu === true && adapter !== null && adapter.is_fallback !== true && machine.probe.device === true, machine.probe);
    check("the kernel benchmark ran and gives a class", machine.benchmark !== null && ["fast", "medium", "slow"].includes(machine.benchmark.kernel_class), machine.benchmark);
    log(`GPU ${adapter?.vendor}/${adapter?.architecture}, benchmark ${machine.benchmark?.gflops} GFLOP/s (${machine.benchmark?.kernel_class})`);

    // 2. The recommendation (no package open: the machine only).
    const before = await viewEntry(entry.id);
    report.recommendation = { budget: (await send({ type: "inbrowser.get", sessionId: null })).machine.budget, bin: before?.recommendation.bin ?? null, context: before?.recommendation.context ?? null, reasons: before?.recommendation.reasons ?? null, descriptor_reason: before?.descriptor.availability_reason ?? null };
    check("the entry is listed, not downloaded, and recommended or possible on this machine", before !== null && !before.cached && ["recommended", "possible"].includes(before.recommendation.bin) && /^not downloaded/u.test(before.descriptor.availability_reason ?? ""), report.recommendation);

    // 3. The download through the product's downloader, verified by digest.
    const downloadStarted = Date.now();
    const started = await send({ type: "inbrowser.download", entryId: entry.id });
    check("the download starts from the person's request", started.state === "downloading", started);
    let downloaded = null;
    for (;;) {
      downloaded = await viewEntry(entry.id);
      const state = downloaded?.download?.state;
      if (state === "done" || state === "failed" || state === "cancelled") break;
      if (Date.now() - downloadStarted > 30 * 60_000) throw new Error("the download did not finish in 30 minutes");
      await sleep(1000);
    }
    report.download = { ms: Date.now() - downloadStarted, state: downloaded.download.state, error: downloaded.download.error, bytes: downloaded.download.bytes_total, cached: downloaded.cached, verified: downloaded.verified, row: downloaded.row, served_hits: served.hits.filter((hit) => hit.includes(fileUrl.pathname)).length };
    check("the download completed and the cached file is verified by its SHA-256", downloaded.download.state === "done" && downloaded.cached && downloaded.verified && downloaded.row?.verified_at !== null, report.download);
    const header = downloaded.row?.header ?? null;
    report.header = { read: header, t40: t40 === null ? null : { n_layer: t40.n_layer, n_kv_heads: t40.n_kv_heads, key_length: t40.key_length, value_length: t40.value_length, context_length: t40.context_length } };
    check("the header read from the cached bytes equals T40's reference walk", header !== null && t40 !== null && header.n_layer === t40.n_layer && header.n_kv_heads === t40.n_kv_heads && header.key_length === t40.key_length && header.value_length === t40.value_length && header.context_length === t40.context_length && header.width_basis === undefined, report.header);
    log(`downloaded ${(entry.bytes_total / 1e9).toFixed(1)} GB in ${Math.round(report.download.ms / 1000)} s`);

    // The offscreen page (the engine's owner), for the cache's file list and the controls below.
    const offscreenTarget = await cdp.waitForTarget((target) => target.url === `${base}/execution.html`, "the offscreen document");
    const host = await cdp.attach(offscreenTarget.targetId);
    const cacheFiles = async () => (await cdp.evaluate(host, `__engine.manager.files().then((answer) => answer.files)`)).map((file) => file.name);

    // 4. A digest mismatch is refused and leaves no file.
    const pasted = await send({ type: "inbrowser.paste", repository: MISMATCH_REPO });
    const added = await send({ type: "inbrowser.addPasted", repository: MISMATCH_REPO, file: "tiny-Q4_0.gguf" });
    await send({ type: "inbrowser.download", entryId: added.id });
    let mismatch = null;
    for (let attempt = 0; attempt < 120; attempt += 1) {
      mismatch = await viewEntry(added.id);
      if (mismatch?.download && mismatch.download.state !== "downloading") break;
      await sleep(500);
    }
    const leftover = (await cacheFiles()).filter((name) => name.startsWith(statedDigest));
    report.mismatch = { repository: MISMATCH_REPO, candidates: pasted.candidates.map((item) => item.file), entry: added.id, curated: added.curated, state: mismatch?.download?.state ?? null, error: mismatch?.download?.error ?? null, row_error: mismatch?.row?.last_error ?? null, cached: mismatch?.cached ?? null, files_left: leftover };
    check("a pasted file whose bytes do not match its stated SHA-256 is refused with the design's words and leaves no file", mismatch?.download?.state === "failed" && mismatch.download.error?.code === "model_digest_mismatch" && mismatch.download.error.message === "the bytes did not match the digest the catalog states" && mismatch.cached === false && leftover.length === 0, report.mismatch);
    await send({ type: "inbrowser.delete", entryId: added.id });

    // 5. Too large: the person states 1 GB of GPU memory; the entry is not available and a load is refused before anything runs.
    const settings = (await send({ type: "settings.get" })).settings;
    await send({ type: "settings.set", settings: { ...settings, models: { ...settings.models, in_browser: { ...settings.models.in_browser, gpu_memory_gb: 1 } } } });
    const small = await viewEntry(entry.id);
    const refusedLoad = await refusal({ type: "inbrowser.load", entryId: entry.id });
    const engineAfterRefusal = await cdp.evaluate(host, `__engine.host.status()`);
    report.too_large = { stated_gb: 1, available: small.descriptor.available, reason: small.descriptor.availability_reason, bin: small.recommendation.bin, load_refusal: refusedLoad, loaded_after: engineAfterRefusal.loaded };
    check("with 1 GB stated, the entry is not available and says both numbers", small.descriptor.available === false && /^needs about [0-9.]+ GB of GPU memory at a [0-9,]+-token context; this machine's budget is 1\.0 GB \(declared\)$/u.test(small.descriptor.availability_reason ?? "") && small.recommendation.bin === "too_large", report.too_large);
    check("a load over the budget is refused before the engine loads anything", refusedLoad !== null && refusedLoad.code === "model_unavailable" && /needs about .* budget is 1\.0 GB/u.test(refusedLoad.message) && engineAfterRefusal.loaded === null, report.too_large);
    await send({ type: "settings.set", settings });

    // 6. The load (Settings → Load), at the context the recommendation chose.
    const loadStarted = Date.now();
    const loaded = await send({ type: "inbrowser.load", entryId: entry.id });
    report.load = { ...loaded, wall_ms: Date.now() - loadStarted };
    check("Load puts the entry in the engine at its context", loaded.entry === entry.id && loaded.n_ctx === before.recommendation.context && loaded.n_gpu_layers === null, report.load);
    log(`loaded at ${loaded.n_ctx} tokens in ${loaded.load_ms} ms`);

    // 7. The GPU did the work: the same completion on the loaded model and on a CPU-only control load.
    const PROBE = { system: "You count.", user: "Write the numbers from one to forty in words, separated by commas.", schema: null, max_tokens: 96, think: false };
    const timed = (runId) => cdp.evaluate(host, `(async () => {
      const channel = new MessageChannel();
      __engine.host.attach(${JSON.stringify(runId)}, channel.port1);
      const port = channel.port2;
      const answer = await new Promise((resolveAnswer) => { port.onmessage = (event) => resolveAnswer(event.data); port.postMessage({ id: 1, kind: "complete", request: ${JSON.stringify({ entry: entry.id, ...PROBE })} }); });
      __engine.host.release(${JSON.stringify(runId)});
      return answer;
    })()`, { timeoutMs: 600_000 });
    const gpu = await timed("e2e-gpu");
    const budget = (await send({ type: "inbrowser.get", sessionId: null })).machine.budget;
    const cpuLoad = await cdp.evaluate(host, `__engine.host.ensure({ entry: ${JSON.stringify(entry.id)}, n_ctx: 4096, think: false, budget: ${JSON.stringify(budget)}, n_gpu_layers: 0 }, null)`, { timeoutMs: 600_000 });
    const cpu = await timed("e2e-cpu");
    const decode = (answer) => answer?.ok ? answer.result.timings?.predicted_per_second ?? null : null;
    const prefill = (answer) => answer?.ok ? answer.result.timings?.prompt_per_second ?? null : null;
    report.gpu_vs_cpu = {
      prompt: PROBE,
      gpu: { n_gpu_layers: "engine default (all layers offloaded)", decode_tok_per_s: decode(gpu), prefill_tok_per_s: prefill(gpu), completion_tokens: gpu?.result?.usage?.completion_tokens ?? null, offload_log: loaded.offload_log },
      cpu: { n_gpu_layers: 0, decode_tok_per_s: decode(cpu), prefill_tok_per_s: prefill(cpu), completion_tokens: cpu?.result?.usage?.completion_tokens ?? null, load_ms: cpuLoad.load_ms, offload_log: cpuLoad.offload_log },
      ratio: decode(gpu) && decode(cpu) ? Math.round((decode(gpu) / decode(cpu)) * 10) / 10 : null,
    };
    check("the GPU run decodes at least three times faster than the CPU-only control on the same entry and prompt", decode(gpu) !== null && decode(cpu) !== null && decode(gpu) >= 3 * decode(cpu), report.gpu_vs_cpu);
    log(`decode GPU ${decode(gpu)?.toFixed?.(1)} tok/s vs CPU ${decode(cpu)?.toFixed?.(1)} tok/s`);
    const measuredRow = (await viewEntry(entry.id)).row?.measured ?? null;
    check("the machine's measured speed is the GPU run's, never the CPU control's", measuredRow !== null && Math.abs(measuredRow.decode_tok_per_s - Math.round(decode(gpu) * 10) / 10) < 0.11, { measuredRow, gpu: decode(gpu) });

    // 8. The idle unload: back on the GPU, then no run uses it for the idle time (6 s here instead of 10 minutes).
    await send({ type: "inbrowser.load", entryId: entry.id });
    const idleStarted = Date.now();
    await cdp.evaluate(host, `(() => { __engine.host.setIdleMinutes(0.1); __engine.host.attach("e2e-idle", new MessageChannel().port1); __engine.host.release("e2e-idle"); return __engine.host.status().idle_unload_at; })()`);
    const unloaded = await cdp.waitFor(host, `__engine.host.status().loaded === null ? __engine.host.status() : null`, "the idle unload", 60_000, 500);
    report.idle_unload = { idle_seconds: 6, unloaded_after_ms: Date.now() - idleStarted, status: unloaded };
    check("the engine unloads the model once no run used it for the idle time", unloaded.loaded === null && report.idle_unload.unloaded_after_ms >= 5_000, report.idle_unload);
  } catch (error) {
    report.failures.push(`fatal (phase A): ${String(error.message ?? error).slice(0, 500)}`);
    log(`fatal: ${error.stack ?? error}`);
  } finally {
    if (chrome) {
      chrome.kill();
      await new Promise((resolveExit) => chrome.once("exit", resolveExit));
    }
    served.server.close();
  }

  // Phase B: WebAir 0.8.0's search conversation on the in-browser model, in the same profile.
  if (!args.skipWebair && report.failures.length === 0) {
    const webairOut = join(outDir, "webair-live.json");
    const webairDir = join(outDir, "webair");
    log("phase B: e2e-webair-live.mjs --local-origin --version 0.8.0 --phases search on the same profile");
    const code = await new Promise((resolveExit) => {
      const child = spawn(process.execPath, [join(here, "e2e-webair-live.mjs"), "--model", `in-browser/${entry.id}`, "--version", "0.8.0", "--local-origin", "--phases", "search", "--profile", profile, "--out", webairOut, "--out-dir", webairDir, "--chrome", args.chrome], { stdio: ["ignore", "ignore", "inherit"] });
      child.on("exit", (status) => resolveExit(status));
    });
    const live = existsSync(webairOut) ? JSON.parse(readFileSync(webairOut, "utf8")) : null;
    const exported = live?.conversations?.search ?? null;
    // The evidence kept with the report: the conversation's export (JSON only, no screenshots) and
    // phase B's own report, copied beside `--out` so the verifier reads committed files.
    const evidence = join(dirname(args.out), basename(args.out, ".json"));
    let search = exported;
    if (exported?.directory && existsSync(join(ROOT, exported.directory))) {
      rmSync(evidence, { recursive: true, force: true });
      mkdirSync(evidence, { recursive: true });
      cpSync(join(ROOT, exported.directory), join(evidence, "search"), { recursive: true });
      cpSync(webairOut, join(evidence, "webair-live.json"));
      search = { ...exported, directory: relative(ROOT, join(evidence, "search")) };
    }
    const turns = search?.turns ?? [];
    const first = turns[0] ?? null;
    // Every model call and every recorded model request, read from the export.
    const audit = search?.directory && existsSync(join(ROOT, search.directory, "audit.json")) ? JSON.parse(readFileSync(join(ROOT, search.directory, "audit.json"), "utf8")) : null;
    const events = Array.isArray(audit) ? audit : Array.isArray(audit?.events) ? audit.events : [];
    const calls = events.filter((event) => event.action === "model.called");
    const observations = [];
    for (const turn of turns) {
      const path = join(ROOT, search.directory, `turn-${String(turn.turn).padStart(3, "0")}`, "observations.json");
      if (existsSync(path)) observations.push(...JSON.parse(readFileSync(path, "utf8")).observations.filter((item) => item.kind === "model"));
    }
    report.webair = {
      exit_code: code,
      report: search && search !== exported ? relative(ROOT, join(evidence, "webair-live.json")) : relative(ROOT, webairOut),
      export: search?.directory ?? null,
      live_failures: live?.failures ?? null,
      turns: turns.map((turn) => ({ turn: turn.turn, status: turn.status, reply_status: turn.reply_status, intent: turn.intent, error_code: turn.error_code, tokens: turn.usage?.tokens ?? null, duration_ms: turn.durationMs, model: turn.model })),
      model_calls: calls.length,
      model_call_domains: [...new Set(calls.map((event) => JSON.stringify(event.domains ?? null)))],
      model_call_models: [...new Set(calls.map((event) => event.model))],
      model_observations: observations.length,
      observed_urls: [...new Set(observations.map((item) => item.url))],
      observed_subjects: [...new Set(observations.map((item) => item.subject))],
    };
    check("phase B: the first search turn on the in-browser model completed with fares found", first !== null && first.status === "completed" && first.reply_status === "options_found", report.webair.turns);
    check("phase B: every model.called names the in-browser model and no destination (domains empty)", calls.length > 0 && calls.every((event) => Array.isArray(event.domains) && event.domains.length === 0) && calls.every((event) => event.model === `in-browser/${entry.id}` || event.model === entry.id), { calls: calls.length, domains: report.webair.model_call_domains, models: report.webair.model_call_models });
    check("phase B: the observer recorded every model request under in-browser:<entry> and none to a network URL", observations.length > 0 && observations.every((item) => item.url === `in-browser:${entry.id}` && item.subject === "in-browser"), { urls: report.webair.observed_urls, subjects: report.webair.observed_subjects });
    // The decode and prefill speeds of the run's turns, from the engine's own count of the entry (the row's measurement).
  } else if (!args.skipWebair) {
    report.webair = { skipped: "phase A failed" };
  }

  if (!args.keep) rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  report.completedAt = new Date().toISOString();
  report.passed = report.failures.length === 0 && !args.skipWebair;
  mkdirSync(dirname(args.out), { recursive: true });
  writeFileSync(args.out, `${JSON.stringify(report, null, 2)}\n`);
  log(`report: ${relative(ROOT, args.out)} (${report.passed ? "passed" : `failed: ${report.failures.join("; ")}`})`);
  console.log(JSON.stringify({ passed: report.passed, failures: report.failures, chrome: report.chrome, entry: report.entry?.id, download_ms: report.download?.ms ?? null, gpu_decode: report.gpu_vs_cpu?.gpu.decode_tok_per_s ?? null, cpu_decode: report.gpu_vs_cpu?.cpu.decode_tok_per_s ?? null }));
  process.exit(report.passed ? 0 : 1);
}

main().catch((error) => {
  log(`fatal: ${error.stack ?? error}`);
  process.exit(1);
});
