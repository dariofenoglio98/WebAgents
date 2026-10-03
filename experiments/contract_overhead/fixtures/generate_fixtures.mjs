// Generate the deterministic host fixtures for the contract-overhead benchmark.
//
// Every fixture is produced by the Agent Browser plugin's own host code (the
// built `openclaw-agent-browser/dist`), not written by hand:
//
//   host-model-catalog.json     discoverHostModels() over one OpenClaw catalog row,
//                               the documented `ollama/qwen3:30b` configuration used
//                               for the recorded local runs (docs/getting-started.md)
//   host-tool-registry.json     buildToolRegistry() over the definitions the plugin's
//                               backend assembles for a host configured like the
//                               WebAir live demo (benchmark_host.mjs): the built-in
//                               bindings, one host-resource binding per resource
//                               type, and the operator bindings file's WebAir
//                               entries; with the recorded execution policy
//   host-resource-registry.json HostResourceStore.registry() for that host's
//                               resources file: ids, labels and keyed digests,
//                               never a value
//   host-execution-policy.json  resolvePolicy() over the recorded runs' settings
//
// The substitutions are OpenClaw's model-provider lookup, replaced through the
// `browse` seam `ModelHost` exposes for exactly this purpose, so that no OpenClaw
// configuration, gateway or credential is read; the host-resource digest key
// (benchmark_host.mjs); and `captured_at`, pinned. Together they make the
// fixture bytes reproducible.
//
// Usage, from the repository root:
//   node experiments/contract_overhead/fixtures/generate_fixtures.mjs
//   node experiments/contract_overhead/fixtures/generate_fixtures.mjs --check

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DIST, benchmarkHost } from "./benchmark_host.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
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

const host = await benchmarkHost();
const policy = resolvePolicy(EXECUTION);
const registry = buildToolRegistry({
  host: { runtimeVersion: OPENCLAW_VERSION, agentId: null },
  env: {},
  policy,
  definitions: host.toolDefinitions(),
});
registry.host.captured_at = CAPTURED_AT;

const resources = host.store.registry({ runtimeVersion: OPENCLAW_VERSION });
resources.host.captured_at = CAPTURED_AT;

const outputs = {
  "host-model-catalog.json": catalog,
  "host-tool-registry.json": registry,
  "host-resource-registry.json": resources,
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
