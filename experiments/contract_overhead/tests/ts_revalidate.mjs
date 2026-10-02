// Run the plugin's real `revalidate` (openclaw-agent-browser/dist/preflight.js)
// over control-plane answers supplied on stdin, and print what it would hand
// the runner. Used by test_fidelity.py to check the benchmark's Python mirror
// of that projection. Reads JSON:
//   { state, summary, receipt, tool_evaluation, catalog, registry,
//     minimum_receipt_remaining_ms }
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const { revalidate } = await import(
  pathToFileURL(join(ROOT, "openclaw-agent-browser/dist/preflight.js")).href
);

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
const calls = [];
const client = {
  async getRunPlan(sessionId) {
    calls.push(["getRunPlan", sessionId]);
    return input.state;
  },
  async getPackage(sessionId) {
    calls.push(["getPackage", sessionId]);
    return input.summary;
  },
  async getAuthorization(sessionId) {
    calls.push(["getAuthorization", sessionId]);
    return input.receipt;
  },
  async evaluateTools(sessionId, digest) {
    calls.push(["evaluateTools", sessionId, digest]);
    return input.tool_evaluation;
  },
};

const plan = input.state.run_plan;
const outcome = await revalidate({
  client,
  catalog: input.catalog,
  sessionId: plan.session_id,
  runPlanId: plan.run_plan_id,
  runPlanSha256: plan.run_plan_sha256,
  minimumReceiptRemainingMs: input.minimum_receipt_remaining_ms,
  toolRegistry: input.registry,
  requireMode: "model",
});
process.stdout.write(
  JSON.stringify({
    binding: outcome.binding,
    authorization: outcome.authorization,
    revalidated: outcome.revalidated,
    calls: calls.map((call) => call[0]),
  }),
);
