#!/usr/bin/env node
/**
 * Summarize one run directory written by `node dist/cli.js run` (T4): identities, status, the
 * model evidence, usage, the audit chain's own verdict, tool dispatches and artifacts, as one
 * JSON document for the verification record (never a prompt, an output or a host value).
 *
 *   node scripts/summarize-run.mjs <run-directory>
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";

const directory = process.argv[2];
if (!directory) {
  process.stderr.write("usage: summarize-run.mjs <run-directory>\n");
  process.exit(2);
}
const read = (name) => {
  try {
    return JSON.parse(readFileSync(join(directory, name), "utf8"));
  } catch {
    return null;
  }
};
const record = read("run.json");
const result = read("result.json");
const usage = read("usage.json") ?? result?.usage ?? null;
const audit = read("audit.json") ?? result?.audit ?? [];
const files = readdirSync(directory)
  .sort()
  .map((name) => {
    const data = readFileSync(join(directory, name));
    return { name, bytes: statSync(join(directory, name)).size, sha256: createHash("sha256").update(data).digest("hex") };
  });
const actions = {};
for (const event of audit) actions[event.action] = (actions[event.action] ?? 0) + 1;
const summary = {
  directory,
  run_id: record?.runId ?? null,
  status: record?.status ?? result?.status ?? null,
  error_code: record?.errorCode ?? result?.error_code ?? null,
  package: record?.package ?? (result?.provenance ? { packageId: result.provenance.package_id, digest: result.provenance.package_digest } : null),
  model: record?.model ?? null,
  selected_model: record?.selectedModel ?? null,
  usage: usage ? { tokens: usage.tokens, remote_calls: usage.remote_calls, tool_calls: usage.tool_calls, peak_parallel_workers: usage.peak_parallel_workers } : null,
  cost: record?.cost ?? null,
  audit: { events: audit.length, chain_valid: record?.audit?.chainValid ?? null, final_hash: record?.audit?.finalHash ?? audit[audit.length - 1]?.event_hash ?? null, actions },
  tools: record?.tools ?? null,
  failure: record?.failure ?? null,
  duration_ms: record?.durationMs ?? null,
  files,
};
process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
