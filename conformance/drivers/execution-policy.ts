/**
 * The conformance suite's driver for the Chrome core's execution-layer grant check
 * (`core/execution/policy.ts::normalizeGrants`), the question `execution_policy.py` asks
 * agentpkg's. Prints one JSON document: `node <bundle> <package> <grants.json>`.
 */
import { readFileSync } from "node:fs";

import { ExecutionError } from "../../chrome-agent-browser/src/core/execution/errors.js";
import { normalizeHostLimits } from "../../chrome-agent-browser/src/core/execution/limits.js";
import { checkCapabilities, checkCompute, normalizeGrants } from "../../chrome-agent-browser/src/core/execution/policy.js";
import { loadPackageBytes } from "../../chrome-agent-browser/src/core/package.js";

async function main(): Promise<void> {
  const pkg = await loadPackageBytes(new Uint8Array(readFileSync(process.argv[2]!)));
  const grants = JSON.parse(readFileSync(process.argv[3]!, "utf8"));
  let outcome: Record<string, unknown>;
  try {
    const accepted = normalizeGrants(pkg, grants);
    // conversation.v0 (T24, V-28): the one-shot layer refuses a conversational package before anything else about it is checked.
    if (pkg.graph.conversation !== undefined && pkg.graph.conversation !== null) checkCapabilities(pkg, normalizeHostLimits(null), { fixture: true });
    // compute.v0 (T22): the layer's compute preflight under the default host ceilings, as the Python driver asks it.
    const compute = checkCompute(pkg, normalizeHostLimits(null), true);
    // network.v0 (T26): the capability check of a delegation package, its tools bound by the fixture, under the default host limits, as the Python driver asks it.
    const network = pkg.graph.network !== undefined && pkg.graph.network !== null ? checkCapabilities(pkg, normalizeHostLimits(null), { fixture: true }).network : null;
    outcome = { outcome: "accepted", grants: accepted, ...(compute !== null ? { compute } : {}), ...(network ? { network } : {}) };
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
