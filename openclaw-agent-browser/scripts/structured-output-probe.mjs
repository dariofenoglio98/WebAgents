#!/usr/bin/env node
/**
 * Opt-in live probe: real structured-output completions through this host.
 *
 * It drives exactly the path a run's `model.complete` takes on the host side —
 * the installed OpenClaw's `api.runtime.llm.complete` under this plugin's own
 * LLM policy, called through this plugin's `completeWithBoundModel` — with
 * requests an agentpkg router rendered. It spends real tokens on the named
 * model and is therefore never part of `npm test`; the agentpkg test
 * `tests/test_live_structured_output.py` is its only caller.
 *
 *   node scripts/structured-output-probe.mjs \
 *     --requests requests.json --case screen --model openai/gpt-5.6-luna \
 *     --count 10 --concurrency 3 --out answers.jsonl
 *
 * `requests.json` maps case names to `{system, user, output_schema,
 * max_output_tokens, reasoning?}`. Each line of `answers.jsonl` is one bridge
 * answer in the `model.complete` result shape, or `{error}` for a host
 * failure. The answers include the model's text, because the caller validates
 * it; keep that file local and temporary, like the probe input itself.
 *
 * `OPENCLAW_ROOT` selects the OpenClaw installation (default: the one the
 * `openclaw` command resolves to). Set `OPENCLAW_DEBUG_MODEL_PAYLOAD=summary`
 * to have the transport log which request fields actually left the host.
 */
import { observeTransport } from "./transport-observer.mjs";
import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

function parseArgs(argv) {
  const args = { count: "1", concurrency: "1" };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag.startsWith("--")) args[flag.slice(2)] = argv[++index];
  }
  for (const required of ["requests", "case", "model", "out"]) {
    if (!args[required]) throw new Error(`--${required} is required`);
  }
  return args;
}

function openclawRoot() {
  if (process.env.OPENCLAW_ROOT) return process.env.OPENCLAW_ROOT;
  const bin = execFileSync("/usr/bin/which", ["openclaw"], { encoding: "utf8" }).trim();
  return dirname(realpathSync(bin));
}

const args = parseArgs(process.argv.slice(2));
const root = openclawRoot();
const load = (path) => import(pathToFileURL(join(root, path)).href);
const { completeWithBoundModel, responseFormatFor } = await import(
  new URL("../dist/host-llm.js", import.meta.url).href
);

const request = JSON.parse(readFileSync(args.requests, "utf8"))[args.case];
if (!request) throw new Error(`no case ${args.case} in ${args.requests}`);

// Optional safe transport evidence: field presence and hashes only, no text or headers.
if (args["transport-facts"]) {
  const expected = responseFormatFor(request.output_schema)?.format?.json_schema?.schema;
  observeTransport(expected, (facts) => appendFileSync(args["transport-facts"], `${JSON.stringify(facts)}\n`, { mode: 0o600 }));
}

const { createRuntimeLlm } = await load("dist/runtime-llm.runtime.js");
const { getRuntimeConfig } = await load("dist/plugin-sdk/config-runtime.js");

// The authority the Gateway grants this plugin, with the caller named
// explicitly because no Gateway request scope exists in a script. The
// operator's `plugins.entries.agent-browser.llm` policy still decides whether
// the model override is allowed.
const llm = createRuntimeLlm({
  getConfig: () => getRuntimeConfig(),
  authority: {
    caller: { kind: "plugin", id: "agent-browser" },
    pluginIdForPolicy: "agent-browser",
    allowComplete: true,
  },
});

async function one() {
  try {
    const outcome = await completeWithBoundModel(llm, {
      modelId: args.model,
      system: request.system,
      user: request.user,
      outputSchema: request.output_schema,
      maxOutputTokens: request.max_output_tokens,
      ...(request.reasoning ? { reasoning: request.reasoning } : {}),
      signal: AbortSignal.timeout(600_000),
    });
    return {
      text: outcome.text,
      model_id: outcome.modelId,
      provider_id: outcome.providerId,
      response_model: outcome.responseModel,
      stop_reason: outcome.stopReason,
      execution: outcome.execution,
      constrained: outcome.constrained,
      constraint_detail: outcome.constraintDetail,
      usage: outcome.usage,
    };
  } catch (error) {
    return { error: { code: error?.code ?? "unknown", detail: String(error?.detail ?? "") } };
  }
}

const count = Number(args.count);
let next = 0;
await Promise.all(
  Array.from({ length: Math.max(1, Math.min(Number(args.concurrency), count)) }, async () => {
    while (next < count) {
      next += 1;
      appendFileSync(args.out, `${JSON.stringify(await one())}\n`);
    }
  }),
);
process.exit(0);
