#!/usr/bin/env node
/**
 * The curated in-browser model list's content (T41, D-442, D-453): the five entries of
 * `docs/design/in-browser-inference.md` §5, every number read from Hugging Face rather than typed.
 * For each entry the script asks the repository's API (`/api/models/<repo>?blobs=true`) for the
 * file's size and LFS SHA-256, the commit the list pins (`sha`) and the model card's licence, then
 * reads the GGUF header's key-value section with HTTP `Range` requests (the first megabytes of the
 * file, never the tensors) through the core's own reader (`src/core/models/gguf-header.ts`, bundled
 * here with esbuild) for the layer count, the KV heads, the K and V widths and the training context.
 * The result is validated with the core's `readModelCatalog` and written to
 * `examples/model-catalog.content.json`; the project's `webagents-catalog` key signs it (a user step):
 *
 *   node chrome-agent-browser/scripts/make-model-catalog.mjs [--version 1.0.0] [--out path]
 *   node chrome-agent-browser/dist/cli.js document sign --type model-catalog \
 *     --key ~/.config/agentpkg/keys/webagents-catalog.private.pem \
 *     examples/model-catalog.content.json --out examples/model-catalog.json
 *
 * The URLs pin the commit (`resolve/<sha>/<file>`), so a list names bytes that cannot move under it;
 * the digest binds them either way. Weights are never re-hosted: every URL is the publisher's own.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const here = dirname(fileURLToPath(import.meta.url));
const PROJECT = resolve(here, "..");
const ROOT = resolve(PROJECT, "..");

/** The design's five entries (§5): what is chosen, not what is measured. */
export const CURATED = [
  { id: "qwen3-0.6b-q4_0", repository: "ggml-org/Qwen3-0.6B-GGUF", file: "Qwen3-0.6B-Q4_0.gguf", display_name: "Qwen3 0.6B (Q4_0)", family: "qwen3", parameters: 600_000_000, quantization: "Q4_0", reasoning: true, notes: "The smoke and demo tier: runs everywhere, answers simple structured tasks; too small for research agents." },
  { id: "qwen3-4b-q4_k_m", repository: "Qwen/Qwen3-4B-GGUF", file: "Qwen3-4B-Q4_K_M.gguf", display_name: "Qwen3 4B (Q4_K_M)", family: "qwen3", parameters: 4_000_000_000, quantization: "Q4_K_M", reasoning: true, notes: "The default on a 16 GB machine for WebAir-sized prompts; long prompts wait on prefill." },
  { id: "qwen3-8b-q4_k_m", repository: "Qwen/Qwen3-8B-GGUF", file: "Qwen3-8B-Q4_K_M.gguf", display_name: "Qwen3 8B (Q4_K_M)", family: "qwen3", parameters: 8_000_000_000, quantization: "Q4_K_M", reasoning: true, notes: "The 7-9B class: tight on 16 GB, comfortable from 24 GB." },
  { id: "gpt-oss-20b-mxfp4", repository: "ggml-org/gpt-oss-20b-GGUF", file: "gpt-oss-20b-MXFP4.gguf", display_name: "gpt-oss 20B (MXFP4)", family: "gpt-oss", parameters: 20_000_000_000, quantization: "MXFP4", reasoning: true, notes: "The 20B mixture-of-experts class for 32 GB machines and larger." },
  { id: "qwen3-30b-a3b-q4_k_m", repository: "Qwen/Qwen3-30B-A3B-GGUF", file: "Qwen3-30B-A3B-Q4_K_M.gguf", display_name: "Qwen3 30B-A3B (Q4_K_M)", family: "qwen3", parameters: 30_000_000_000, quantization: "Q4_K_M", reasoning: true, notes: "The family of the only local model that met Literature Review's exact-copy contract (qwen3:30b); 36 GB and larger." },
];
/** WebAir 0.8.0 and Literature Review 0.2.9 declare 16,000 tokens per task: the default context covers them. */
const DEFAULT_CONTEXT = 16_384;
const MAX_CONTEXT = 65_536;
const LICENSES = { "apache-2.0": { name: "Apache License 2.0", url: "https://www.apache.org/licenses/LICENSE-2.0" } };

/** The core's GGUF reader and catalog validation, bundled once for this script. */
export async function coreModules() {
  const scratch = mkdtempSync(join(tmpdir(), "make-model-catalog-"));
  try {
    const entry = join(scratch, "entry.ts");
    writeFileSync(entry, `export { readGgufHeader } from ${JSON.stringify(join(PROJECT, "src/core/models/gguf-header.ts"))};\nexport { readModelCatalog, weightsDigest, normalizeInBrowserEntry } from ${JSON.stringify(join(PROJECT, "src/core/models/in-browser-catalog.ts"))};\n`);
    const out = join(scratch, "core.mjs");
    await build({ absWorkingDir: PROJECT, entryPoints: [entry], outfile: out, bundle: true, format: "esm", platform: "node", target: ["node24"], logLevel: "warning" });
    return await import(pathToFileURL(out).href);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

async function json(url) {
  const response = await fetch(url, { headers: { accept: "application/json" } });
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return response.json();
}

/** A `Range` reader over one file URL (redirects to the repository's content host are followed). */
function rangeReader(url) {
  return async (offset, length) => {
    const response = await fetch(url, { headers: { range: `bytes=${offset}-${offset + length - 1}` } });
    if (response.status !== 206) throw new Error(`${url}: a Range request answered HTTP ${response.status}, not 206`);
    return new Uint8Array(await response.arrayBuffer());
  };
}

export async function curatedEntry(core, spec) {
  const api = `https://huggingface.co/api/models/${spec.repository}?blobs=true`;
  const meta = await json(api);
  if (meta.gated && meta.gated !== false) throw new Error(`${spec.repository} is gated`);
  const sibling = (meta.siblings ?? []).find((item) => item.rfilename === spec.file);
  if (!sibling?.lfs?.sha256 || !Number.isSafeInteger(sibling.size)) throw new Error(`${spec.repository}: the API lists no size and LFS SHA-256 for ${spec.file}`);
  const revision = meta.sha;
  if (!/^[0-9a-f]{40}$/u.test(revision ?? "")) throw new Error(`${spec.repository}: the API states no commit`);
  const url = `https://huggingface.co/${spec.repository}/resolve/${revision}/${spec.file}`;
  const header = await core.readGgufHeader(rangeReader(url), sibling.size);
  const licenseId = String(meta.cardData?.license ?? "").toLowerCase();
  const license = LICENSES[licenseId];
  if (!license) throw new Error(`${spec.repository}: licence ${JSON.stringify(licenseId)} is not one the list curates`);
  const hasLicenseFile = (meta.siblings ?? []).some((item) => item.rfilename === "LICENSE");
  const train = header.context_length;
  if (!train) throw new Error(`${spec.repository}: the header states no context_length`);
  const max = Math.min(train, MAX_CONTEXT);
  const files = [{ name: spec.file, url, bytes: sibling.size, sha256: sibling.lfs.sha256 }];
  return {
    schema: "agentpkg-in-browser-model-v0",
    id: spec.id,
    display_name: spec.display_name,
    family: spec.family,
    parameters: spec.parameters,
    format: "gguf",
    engine: "wllama",
    quantization: spec.quantization,
    files,
    weights_digest: core.weightsDigest(files.map((file) => file.sha256)),
    bytes_total: sibling.size,
    context: { train, default: Math.min(DEFAULT_CONTEXT, max), max },
    capabilities: { structured_output: true, reasoning: spec.reasoning, tool_use: null },
    license: { id: licenseId, name: license.name, url: hasLicenseFile ? `https://huggingface.co/${spec.repository}/blob/${revision}/LICENSE` : license.url },
    source: { repository: spec.repository, revision, api },
    curated: true,
    header: { n_layer: header.n_layer, n_kv_heads: header.n_kv_heads, key_length: header.key_length, value_length: header.value_length, ...(header.key_length_basis === "attention.key_length" ? {} : { width_basis: "embedding" }) },
    notes: spec.notes,
  };
}

async function main() {
  const args = { version: "1.0.0", out: join(ROOT, "examples", "model-catalog.content.json") };
  for (let index = 2; index < process.argv.length; index += 1) {
    if (process.argv[index] === "--version") args.version = process.argv[(index += 1)];
    else if (process.argv[index] === "--out") args.out = resolve(process.argv[(index += 1)]);
    else throw new Error(`unknown argument ${process.argv[index]}`);
  }
  const core = await coreModules();
  const entries = [];
  for (const spec of CURATED) {
    entries.push(await curatedEntry(core, spec));
    process.stderr.write(`${spec.id}: ${entries.at(-1).bytes_total} bytes, header ${JSON.stringify(entries.at(-1).header)}, context ${JSON.stringify(entries.at(-1).context)}\n`);
  }
  const content = { catalog_id: "org.webagents.in-browser-models", version: args.version, title: "WebAgents curated in-browser models", issued_at: new Date().toISOString().replace(/\.\d+Z$/u, "Z"), expires_at: null, entries };
  core.readModelCatalog(content); // the browser's own validation, before anything is written
  writeFileSync(args.out, `${JSON.stringify(content, null, 2)}\n`);
  console.log(JSON.stringify({ written: args.out, version: args.version, entries: entries.map((entry) => ({ id: entry.id, bytes_total: entry.bytes_total, weights_digest: entry.weights_digest, header: entry.header, context: entry.context })) }));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`make-model-catalog: ${error.stack ?? error}\n`);
    process.exit(1);
  });
}
