#!/usr/bin/env node
/**
 * The T40 spike (D-440, D-441): in-browser inference where runs execute. Headless Chrome loads a
 * scratch copy of the built extension to which this script adds one Worker bundle
 * (`scripts/spike/inbrowser-spike-worker.ts` over wllama 3.8.1) and wllama's wasm; the shipped build
 * is untouched. The service worker is asked, over CDP, to create the real offscreen document
 * (`execution.html`); the harness then attaches to that document and starts the Worker there, so
 * every fact below is measured in the context a run's Worker lives in:
 *
 *   1. WebGPU inside the offscreen document's Worker: `navigator.gpu`, the adapter's features and
 *      limits, a device (`feasibility/inference.md` marks this "[U]");
 *   2. a small GGUF model (default: Qwen3-0.6B Q4_0 from `ggml-org/Qwen3-0.6B-GGUF`, served by a
 *      local HTTPS origin from a file this script downloaded once and verified against the SHA-256
 *      Hugging Face publishes for it) loads over WebGPU, with the load time;
 *   3. one WebAir-shaped completion: the `interpret` node's output schema
 *      (`agents/webair/schemas/plan.schema.json`) as the engine's `response_format.json_schema`
 *      (a grammar derived from the schema inside llama.cpp), the Interpreter's two skills as the
 *      system prompt; the answer is validated against the package schema with the reference's
 *      validator (jsonschema 2020-12 in agentpkg's venv), and tokens, prefill and decode tok/s recorded;
 *   4. the same request with no grammar, for comparison;
 *   5. a long unconstrained completion aborted after 300 ms: the engine stops at once (cancellation).
 *
 *   npm run build && node scripts/spike-inbrowser.mjs [--chrome path] [--model repo/file.gguf] [--ctx 8192] [--out report.json] [--keep] [--thinking] [--cpu]
 *
 * `--cpu` loads with `n_gpu_layers: 0`: the CPU-only control. Every check passes on the CPU too, so
 * the GPU run is told apart by its speed against this control (T40 review 1, nit 9).
 */
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, createReadStream, createWriteStream, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

import { Cdp } from "./lib/cdp.mjs";
import { grantedBuild } from "./lib/granted-build.mjs";
import { certificate, serveFiles } from "./lib/origin.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const PROJECT = resolve(here, "..");
const ROOT = resolve(PROJECT, "..");
const EXTENSION = join(PROJECT, "dist", "extension");
const PYTHON = process.env.AGENTPKG_PYTHON || join(ROOT, "agentpkg", ".venv", "bin", "python");
const WLLAMA_WASM = join(PROJECT, "node_modules", "@wllama", "wllama", "esm", "wasm", "wllama.wasm");
const WLLAMA_VERSION = JSON.parse(readFileSync(join(PROJECT, "node_modules", "@wllama", "wllama", "package.json"), "utf8")).version;
const SCHEMA = join(ROOT, "agents", "webair", "schemas", "plan.schema.json");
const SKILLS = ["travel-request", "webair-domain"].map((name) => join(ROOT, "agents", "webair", "skills", name, "SKILL.md"));
const MODELS_HOST = "models.example";
const CACHE = join(ROOT, "examples", "my-inbrowser-spike-cache");

const args = { chrome: process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", model: "ggml-org/Qwen3-0.6B-GGUF/Qwen3-0.6B-Q4_0.gguf", ctx: 8192, out: join(ROOT, "examples", "verification", "chrome-inbrowser-spike-t40.json"), keep: false, thinking: false, cpu: false };
for (let index = 2; index < process.argv.length; index += 1) {
  const argument = process.argv[index];
  if (argument === "--chrome") args.chrome = process.argv[(index += 1)];
  else if (argument === "--model") args.model = process.argv[(index += 1)];
  else if (argument === "--ctx") args.ctx = Number(process.argv[(index += 1)]);
  else if (argument === "--out") args.out = resolve(process.argv[(index += 1)]);
  else if (argument === "--keep") args.keep = true;
  else if (argument === "--thinking") args.thinking = true;
  else if (argument === "--cpu") args.cpu = true;
  else {
    console.error(`unknown argument ${argument}`);
    process.exit(2);
  }
}
for (const [path, hint] of [[join(EXTENSION, "manifest.json"), "run `npm run build` first"], [WLLAMA_WASM, "run `npm ci` (wllama is a dev dependency for this spike)"], [args.chrome, "pass --chrome <path>"], [PYTHON, "create agentpkg/.venv (CLAUDE.md, Conventions)"]]) {
  if (!existsSync(path)) {
    console.error(`${path} is missing: ${hint}`);
    process.exit(2);
  }
}

const startedAt = new Date();
const log = (text) => process.stderr.write(`[${Math.round((Date.now() - startedAt.getTime()) / 1000)}s] ${text}\n`);
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
/** The digest of a file of any size, streamed (a 2.5 GB file is above Node's one-Buffer limit). */
const sha256File = (path) => new Promise((resolveHash, rejectHash) => { const hash = createHash("sha256"); createReadStream(path).on("data", (chunk) => hash.update(chunk)).on("end", () => resolveHash(hash.digest("hex"))).on("error", rejectHash); });
const report = { profile: "chrome-inbrowser-spike-t40-v0", recordedAt: startedAt.toISOString(), chrome: null, v8: null, headless: true, engine: { name: "wllama", version: WLLAMA_VERSION, wasm_sha256: sha256(readFileSync(WLLAMA_WASM)), wasm_bytes: statSync(WLLAMA_WASM).size }, model: null, offscreen: null, probe: null, load: null, completions: {}, checks: {}, failures: [], passed: false };
const check = (name, condition, detail) => {
  report.checks[name] = condition ? "ok" : { failed: detail ?? null };
  if (!condition) report.failures.push(`${name}${detail === undefined ? "" : ` (${JSON.stringify(detail).slice(0, 400)})`}`);
};

/** The model file: downloaded once into the git-ignored cache, verified against Hugging Face's own SHA-256 for the file. */
async function modelFile(spec) {
  const [owner, repo, ...rest] = spec.split("/");
  const file = rest.join("/");
  const api = `https://huggingface.co/api/models/${owner}/${repo}?blobs=true`;
  const meta = await (await fetch(api, { headers: { accept: "application/json" } })).json();
  const sibling = (meta.siblings ?? []).find((item) => item.rfilename === file);
  if (!sibling?.lfs?.sha256) throw new Error(`${spec}: Hugging Face lists no LFS SHA-256 for ${file}`);
  const expected = sibling.lfs.sha256;
  const url = `https://huggingface.co/${owner}/${repo}/resolve/main/${file}`;
  mkdirSync(CACHE, { recursive: true });
  const local = join(CACHE, `${owner}__${repo}__${basename(file)}`);
  // A finished download whose hash was never checked (an earlier run that died after the download) is verified, not fetched again.
  if (!existsSync(local) && existsSync(`${local}.part`) && (await sha256File(`${local}.part`)) === expected) renameSync(`${local}.part`, local);
  if (!existsSync(local) || (await sha256File(local)) !== expected) {
    log(`downloading ${url} (${(sibling.size / 1e6).toFixed(0)} MB)`);
    const response = await fetch(url);
    if (!response.ok) throw new Error(`download failed: HTTP ${response.status}`);
    await new Promise((resolveWrite, rejectWrite) => {
      const out = createWriteStream(`${local}.part`);
      response.body.pipeTo(new WritableStream({ write: (chunk) => new Promise((ok) => out.write(chunk, ok)), close: () => new Promise((ok) => out.end(ok)) })).then(resolveWrite, rejectWrite);
    });
    const digest = await sha256File(`${local}.part`);
    if (digest !== expected) throw new Error(`downloaded ${file} has SHA-256 ${digest}, Hugging Face states ${expected}`);
    renameSync(`${local}.part`, local);
  }
  return { owner, repo, file, url, local, bytes: statSync(local).size, sha256: expected, license: meta.cardData?.license ?? null, served: `https://${MODELS_HOST}/${basename(file)}` };
}

function validate(schemaPath, value) {
  const script = "import json, sys\nfrom jsonschema import Draft202012Validator\nschema = json.load(open(sys.argv[1]))\nvalue = json.loads(sys.stdin.read())\nerrors = sorted(Draft202012Validator(schema).iter_errors(value), key=lambda e: list(e.path))\nprint(json.dumps([{'path': '/' + '/'.join(str(p) for p in e.path), 'message': e.message[:200]} for e in errors]))\n";
  return JSON.parse(execFileSync(PYTHON, ["-I", "-c", script, schemaPath], { input: JSON.stringify(value), encoding: "utf8" }));
}

async function main() {
  const scratch = mkdtempSync(join(realpathSync(tmpdir()), "chrome-inbrowser-spike-"));
  const profile = join(scratch, "profile");
  let chrome = null;
  let served = null;
  try {
    const model = await modelFile(args.model);
    report.model = { repository: `${model.owner}/${model.repo}`, file: model.file, source_url: model.url, bytes: model.bytes, sha256: model.sha256, license: model.license, served_as: model.served, local_copy: relative(ROOT, model.local) };
    log(`model ${model.file}: ${model.bytes} bytes, sha256 ${model.sha256.slice(0, 16)}…, verified`);

    // The scratch copy of the build: the granted origin (the model host, so a fetch there is what a person's
    // grant would allow), the spike Worker bundle and wllama's wasm. The shipped dist/ is not changed.
    const granted = grantedBuild(EXTENSION, scratch, [`https://${MODELS_HOST}`]);
    const bundled = await build({ absWorkingDir: PROJECT, bundle: true, minify: false, sourcemap: false, logLevel: "warning", target: ["chrome137"], format: "esm", platform: "browser", entryPoints: [join(here, "spike", "inbrowser-spike-worker.ts")], outfile: join(granted.path, "spike-inbrowser-worker.js"), metafile: true });
    copyFileSync(WLLAMA_WASM, join(granted.path, "wllama.wasm"));
    const workerText = readFileSync(join(granted.path, "spike-inbrowser-worker.js"), "utf8");
    report.engine.bundle_bytes = workerText.length;
    report.engine.bundle_inputs = Object.keys(bundled.metafile.inputs).length;
    report.engine.bundle_has_eval = /new Function\(|[^A-Za-z_.]eval\(/u.test(workerText);
    report.engine.bundle_remote_urls = [...new Set((workerText.match(/https?:\/\/[A-Za-z0-9./_@-]+/gu) ?? []).filter((url) => !/apache\.org|github\.com\/(?:emscripten-core|ngxson|godotengine)|w3\.org|huggingface\.co$/u.test(url)))];

    const tls = certificate(scratch, MODELS_HOST);
    served = await serveFiles(tls, { [`/${basename(model.file)}`]: { path: model.local, type: "application/octet-stream" } });
    chrome = spawn(args.chrome, ["--headless=new", "--remote-debugging-pipe", "--enable-unsafe-extension-debugging", `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check", `--host-resolver-rules=MAP ${MODELS_HOST} 127.0.0.1:${served.port}`, `--ignore-certificate-errors-spki-list=${tls.spkiHash}`, "about:blank"], { stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"] });
    const cdp = new Cdp(chrome);
    const version = await cdp.send("Browser.getVersion");
    report.chrome = version.product;
    report.v8 = version.jsVersion;
    const { id: extensionId } = await cdp.send("Extensions.loadUnpacked", { path: granted.path });
    const base = `chrome-extension://${extensionId}`;
    await cdp.waitForTarget((target) => target.type === "service_worker" && target.url === `${base}/service-worker.js`, "the service worker");
    // The real offscreen document (`execution.html`, reason WORKERS), created with the call `offscreen-host.ts`
    // makes, here from an extension page because a CDP session on the service worker sees no `chrome`.
    const { targetId: pageTarget } = await cdp.send("Target.createTarget", { url: `${base}/browser.html` });
    const extensionPage = await cdp.attach(pageTarget);
    await cdp.waitFor(extensionPage, `typeof chrome !== "undefined" && !!chrome.runtime && !!chrome.offscreen`, "the extension page");
    report.offscreen = { created_by: await cdp.evaluate(extensionPage, `chrome.offscreen.hasDocument().then((has) => has ? "already existed" : chrome.offscreen.createDocument({ url: "execution.html", reasons: ["WORKERS"], justification: "T40 spike: WebGPU inside the execution host's Worker" }).then(() => "chrome.offscreen.createDocument from an extension page"))`) };
    const offscreen = await cdp.waitForTarget((target) => target.url === `${base}/execution.html`, "the offscreen document");
    Object.assign(report.offscreen, { target_type: offscreen.type, url: offscreen.url });
    const page = await cdp.attach(offscreen.targetId);
    await cdp.evaluate(page, `(() => {
      const worker = new Worker("spike-inbrowser-worker.js", { type: "module" });
      const pending = new Map();
      const progress = [];
      let next = 0;
      worker.onmessage = (event) => {
        const data = event.data;
        if (data.kind === "progress") { progress.push([Date.now(), data.loaded, data.total]); return; }
        if (data.kind === "answer") { const p = pending.get(data.id); if (p) { pending.delete(data.id); p(data); } }
      };
      worker.onerror = (event) => { for (const p of pending.values()) p({ ok: false, error: "worker error: " + (event.message || "unknown") }); pending.clear(); };
      globalThis.__spike = { worker, progress, ask: (command) => new Promise((resolveAnswer) => { const id = (next += 1); pending.set(id, resolveAnswer); worker.postMessage({ ...command, id }); }) };
      return "ready";
    })()`);
    const ask = async (command, timeoutMs) => {
      const answer = await cdp.evaluate(page, `(async () => { const a = await Promise.race([__spike.ask(${JSON.stringify(command)}), new Promise((r) => setTimeout(() => r({ ok: false, error: "timeout after ${timeoutMs} ms" }), ${timeoutMs}))]); return a; })()`);
      if (!answer.ok) throw new Error(`${command.kind}: ${answer.error}`);
      return answer.result;
    };

    // 1. WebGPU as the offscreen document's Worker sees it.
    report.probe = await ask({ kind: "probe" }, 20_000);
    const adapter = report.probe.adapter ?? null;
    check("the offscreen document's Worker has navigator.gpu and gets a non-fallback adapter with a device", report.probe.has_webgpu === true && adapter !== null && adapter.is_fallback !== true && report.probe.device === true, { has_webgpu: report.probe.has_webgpu, adapter, device: report.probe.device });
    check("the adapter offers shader-f16 and subgroups and 1 GiB buffers or more", !!adapter && adapter.features.includes("shader-f16") && adapter.features.includes("subgroups") && adapter.limits.maxBufferSize >= 1 << 30, adapter?.limits);
    log(`WebGPU in the offscreen Worker: ${report.probe.has_webgpu} (${adapter?.architecture ?? "no adapter"}; f16 ${adapter?.features.includes("shader-f16")}, subgroups ${adapter?.features.includes("subgroups")})`);

    // 2. The model loads over WebGPU.
    report.n_gpu_layers = args.cpu ? 0 : "engine default (all layers offloaded)";
    report.load = await ask({ kind: "load", url: model.served, nCtx: args.ctx, reasoning: args.thinking, ...(args.cpu ? { nGpuLayers: 0 } : {}) }, 600_000);
    report.load.progress_samples = await cdp.evaluate(page, `__spike.progress.length`);
    report.load.served_hits = served.hits.length;
    check("the model loads in the Worker over the served file", typeof report.load.load_ms === "number" && report.load.n_ctx === args.ctx && report.load.n_vocab > 0, report.load);
    log(`loaded ${report.load.general_name ?? model.file} in ${report.load.load_ms} ms (n_ctx ${report.load.n_ctx}, ${report.load.n_layer} layers, multithread ${report.load.multithread})`);

    // 3. The interpret node's shape: skills as the system prompt, the output schema as the grammar.
    const schema = JSON.parse(readFileSync(SCHEMA, "utf8"));
    const system = `${SKILLS.map((path) => readFileSync(path, "utf8")).join("\n\n")}\n\n## Output\nAnswer with one JSON document that conforms to this JSON Schema and nothing else:\n${JSON.stringify(schema)}`;
    const input = { message: "Find me a flight from Boston to Zurich on 9 December 2026 for two people, nonstop if possible, under 900 dollars.", history: [], known_fares: [], open_quote: null, purchase: null, profile_used: null };
    const messages = [{ role: "system", content: system }, { role: "user", content: JSON.stringify(input) }];
    const run = async (name, extra, timeoutMs = 300_000) => {
      const result = await ask({ kind: "complete", messages, maxTokens: 600, ...extra }, timeoutMs);
      let parsed = null;
      let parseError = null;
      try {
        parsed = JSON.parse(result.text);
      } catch (error) {
        parseError = String(error.message).slice(0, 120);
      }
      const errors = parsed === null ? null : validate(SCHEMA, parsed);
      const t = result.timings ?? {};
      report.completions[name] = { ...result, text: result.text.slice(0, 4000), parsed_json: parsed !== null, parse_error: parseError, schema_errors: errors, schema_valid: errors !== null && errors.length === 0, prompt_tokens: result.usage?.prompt_tokens ?? t.prompt_n ?? null, completion_tokens: result.usage?.completion_tokens ?? t.predicted_n ?? null, prefill_tok_per_s: t.prompt_per_second ?? null, decode_tok_per_s: t.predicted_per_second ?? null };
      log(`${name}: ${result.completion_tokens ?? t.predicted_n ?? "?"} tokens, prefill ${t.prompt_per_second?.toFixed?.(1) ?? "?"} tok/s, decode ${t.predicted_per_second?.toFixed?.(1) ?? "?"} tok/s, schema ${report.completions[name].schema_valid}`);
      return report.completions[name];
    };
    const constrained = await run("interpret_with_schema_grammar", { schema });
    check("under the schema grammar the answer is one JSON document valid against plan.schema.json", constrained.parsed_json && constrained.schema_valid, { parse_error: constrained.parse_error, schema_errors: constrained.schema_errors, text: constrained.text.slice(0, 600) });
    check("the constrained answer reads the request: intent search, ZRH, 2026-12-09, 2 passengers", constrained.parsed_json && constrained.schema_valid && (() => { const p = JSON.parse(constrained.text); return p.intent === "search" && p.search?.destination === "ZRH" && p.search?.date === "2026-12-09" && p.search?.passengers === 2; })(), constrained.text.slice(0, 600));
    check("the engine reports prompt and completion tokens and its timings", Number.isInteger(constrained.prompt_tokens) && constrained.prompt_tokens > 0 && Number.isInteger(constrained.completion_tokens) && constrained.completion_tokens > 0 && typeof constrained.decode_tok_per_s === "number", { prompt_tokens: constrained.prompt_tokens, completion_tokens: constrained.completion_tokens, timings: constrained.timings });
    const unconstrained = await run("interpret_without_grammar", { schema: null });
    // Non-streamed, prompt cache off: the engine's own `usage` for the accounting the adapter needs (D-445).
    const counted = await run("interpret_with_schema_grammar_unstreamed_uncached", { schema, stream: false, cachePrompt: false });
    check("non-streamed, the engine reports usage.prompt_tokens and completion_tokens, and prompt_tokens equals the streamed run's prompt_n + cache_n", Number.isInteger(counted.usage?.prompt_tokens) && counted.usage.prompt_tokens > 0 && Number.isInteger(counted.usage?.completion_tokens) && counted.usage.prompt_tokens === (constrained.timings?.prompt_n ?? 0) + (constrained.timings?.cache_n ?? 0), { usage: counted.usage, streamed_timings: constrained.timings });
    check("the non-streamed constrained answer is valid too", counted.parsed_json && counted.schema_valid, { schema_errors: counted.schema_errors, text: counted.text.slice(0, 400) });
    report.completions.interpret_without_grammar.note = "for comparison only; the product always validates and may re-ask (D-151)";
    report.thinking = args.thinking;

    // 4. Cancellation: a long free-text answer aborted 300 ms in.
    const long = await ask({ kind: "complete", messages: [{ role: "system", content: "You are a writer." }, { role: "user", content: "Write a 2,000-word essay on the history of aviation." }], maxTokens: 2000, schema: null, abortAfterMs: 300 }, 60_000);
    report.completions.abort_after_300ms = { ...long, text: long.text.slice(0, 200) };
    check("an abort stops generation at once (under 2 s, far from the 2,000-token budget)", long.aborted === true && long.total_ms < 2000, { aborted: long.aborted, total_ms: long.total_ms, chars: long.chars });

    // 5. Unload frees the slot; a second load works (one model at a time, D-441).
    await ask({ kind: "unload" }, 30_000);
    const reload = await ask({ kind: "load", url: model.served, nCtx: 2048, reasoning: false, ...(args.cpu ? { nGpuLayers: 0 } : {}) }, 600_000);
    check("after unload the Worker loads a model again", typeof reload.load_ms === "number" && reload.n_ctx === 2048, reload);
    report.load.reload_ms = reload.load_ms;
    await ask({ kind: "unload" }, 30_000);
  } catch (error) {
    report.failures.push(`fatal: ${String(error.message ?? error).slice(0, 400)}`);
    throw error;
  } finally {
    report.passed = report.failures.length === 0;
    report.completedAt = new Date().toISOString();
    mkdirSync(dirname(args.out), { recursive: true });
    writeFileSync(args.out, `${JSON.stringify(report, null, 2)}\n`);
    log(`report: ${args.out} (${report.passed ? "passed" : `failed: ${report.failures.join("; ")}`})`);
    if (chrome) {
      chrome.kill();
      await new Promise((resolveExit) => chrome.once("exit", resolveExit));
    }
    served?.server.close();
    if (!args.keep) rmSync(scratch, { recursive: true, force: true });
  }
  console.log(JSON.stringify({ passed: report.passed, failures: report.failures, chrome: report.chrome, engine: report.engine.version, model: report.model?.file ?? null, load_ms: report.load?.load_ms ?? null, constrained: report.completions.interpret_with_schema_grammar ? { schema_valid: report.completions.interpret_with_schema_grammar.schema_valid, completion_tokens: report.completions.interpret_with_schema_grammar.completion_tokens, decode_tok_per_s: report.completions.interpret_with_schema_grammar.decode_tok_per_s, prefill_tok_per_s: report.completions.interpret_with_schema_grammar.prefill_tok_per_s } : null }));
  process.exit(report.passed ? 0 : 1);
}

main().catch((error) => {
  log(`fatal: ${error.stack ?? error}`);
  process.exit(1);
});
