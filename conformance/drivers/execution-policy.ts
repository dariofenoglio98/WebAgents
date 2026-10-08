/**
 * The conformance suite's driver for the Chrome core's execution-layer grant check
 * (`core/execution/policy.ts::normalizeGrants`), the question `execution_policy.py` asks
 * agentpkg's. Prints one JSON document: `node <bundle> <package> <grants.json>`.
 */
import { readFileSync } from "node:fs";

import { ExecutionError } from "../../chrome-agent-browser/src/core/execution/errors.js";
import { normalizeGrants } from "../../chrome-agent-browser/src/core/execution/policy.js";
import { loadPackageBytes } from "../../chrome-agent-browser/src/core/package.js";

async function main(): Promise<void> {
  const pkg = await loadPackageBytes(new Uint8Array(readFileSync(process.argv[2]!)));
  const grants = JSON.parse(readFileSync(process.argv[3]!, "utf8"));
  let outcome: Record<string, unknown>;
  try {
    outcome = { outcome: "accepted", grants: normalizeGrants(pkg, grants) };
  } catch (error) {
    if (!(error instanceof ExecutionError)) throw error;
    outcome = { outcome: "refused", code: error.code, message: error.message };
  }
  process.stdout.write(`${JSON.stringify(outcome, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exit(1);
});
