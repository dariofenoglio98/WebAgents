// Generate the deterministic host fixtures for the contract-overhead benchmark.
//
// Both fixtures are produced by the Agent Browser plugin's own host code (the
// built `openclaw-agent-browser/dist`), not written by hand:
//
//   host-model-catalog.json  discoverHostModels() over one OpenClaw catalog row,
//                            the documented `ollama/qwen3:30b` configuration used
//                            for the recorded local runs (docs/getting-started.md)
//   host-tool-registry.json  buildToolRegistry() with the plugin's built-in
//                            bindings and the recorded execution policy
//
// The only substitution is OpenClaw's model-provider lookup, replaced through
// the `browse` seam `ModelHost` exposes for exactly this purpose, so that no
// OpenClaw configuration, gateway or credential is read. `captured_at` is then
// pinned so the fixture bytes are reproducible.
//
// Usage, from the repository root:
//   node experiments/contract_overhead/fixtures/generate_fixtures.mjs
//   node experiments/contract_overhead/fixtures/generate_fixtures.mjs --check

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "../../..");
const DIST = join(ROOT, "openclaw-agent-browser/dist");
const CAPTURED_AT = "2026-10-01T00:00:00.000Z";
const OPENCLAW_VERSION = "2026.9.5";
const PLUGIN_ID = "agent-browser";

const { discoverHostModels } = await import(pathToFileURL(join(DIST, "host-models.js")).href);
const { buildToolRegistry } = await import(pathToFileURL(join(DIST, "tool-registry.js")).href);
const { resolvePolicy } = await import(pathToFileURL(join(DIST, "execution.js")).href);

// The explicit Ollama model entry the recorded local runs used.
const QWEN_ROW = {
  id: "qwen3:30b",
  name: "qwen3:30b",
  provider: "ollama",
  reasoning: true,
  input: ["text"],
  contextWindow: 262144,
  contextTokens: 65536,
  baseUrl: "http://127.0.0.1:11434",
  compat: {
    supportsUsageInStreaming: true,
    supportsTools: true,
    supportsJsonSchemaResponseFormat: true,
  },
};

// The plugin configuration a model override needs (getting-started §3).
const CONFIG = { plugins: { entries: { [PLUGIN_ID]: { llm: { allowModelOverride: true } } } } };

// The execution bounds of the recorded runs (getting-started §3).
const EXECUTION = {
  totalTokens: 180000,
  maxRemoteCalls: 45,
  maxParallelWorkers: 3,
  maxOutputTokensPerCall: 16000,
  runTimeoutSeconds: 4500,
  modelCallTimeoutSeconds: 1200,
};

const browse = async () => ({
  byProvider: new Map([["ollama", new Set(["qwen3:30b"])]]),
  providers: ["ollama"],
  modelNames: new Map([["ollama/qwen3:30b", "qwen3:30b"]]),
  modelCatalog: [QWEN_ROW],
  resolvedDefault: { provider: "ollama", model: "qwen3:30b" },
});

const catalog = await discoverHostModels({
  config: CONFIG,
  agentId: undefined,
  runtimeVersion: OPENCLAW_VERSION,
  pluginId: PLUGIN_ID,
  browse,
});
catalog.host.captured_at = CAPTURED_AT;

const policy = resolvePolicy(EXECUTION);
const registry = buildToolRegistry({
  host: { runtimeVersion: OPENCLAW_VERSION, agentId: null },
  env: {},
  policy,
});
registry.host.captured_at = CAPTURED_AT;

const outputs = {
  "host-model-catalog.json": catalog,
  "host-tool-registry.json": registry,
  "host-execution-policy.json": policy,
};

const check = process.argv.includes("--check");
let stale = 0;
for (const [name, value] of Object.entries(outputs)) {
  const text = JSON.stringify(value, null, 2) + "\n";
  const path = join(HERE, name);
  if (check) {
    let current = "";
    try {
      current = readFileSync(path, "utf8");
    } catch {
      current = "";
    }
    if (current !== text) {
      stale += 1;
      console.error(`stale fixture: ${name}`);
    }
  } else {
    writeFileSync(path, text);
    console.log(`wrote ${name}`);
  }
}
process.exit(stale ? 1 : 0);
