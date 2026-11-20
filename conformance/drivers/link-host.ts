/**
 * The conformance suite's driver for the Chrome core's link host (T66): the links an operator binds
 * (`core/links/operator.ts::operatorLinks`) and the grant check the execution layer makes across
 * them (`core/links/host.ts::checkOnce`, link.v0 L-28), the question `link_host.py` asks the
 * reference. Prints one JSON document: `node <bundle> <argv.json>`.
 */
import { readFileSync } from "node:fs";

import { AgentPkgError } from "../../chrome-agent-browser/src/core/errors.js";
import { ExecutionError } from "../../chrome-agent-browser/src/core/execution/errors.js";
import { fixtureAdapters } from "../../chrome-agent-browser/src/core/fixtures.js";
import { fingerprint, publicKeyFromPem } from "../../chrome-agent-browser/src/core/keys.js";
import { packageWorstCase, WORST_CASE_FIGURES } from "../../chrome-agent-browser/src/core/links/analysis.js";
import { checkOnce } from "../../chrome-agent-browser/src/core/links/host.js";
import { operatorLinks, splitToolApprovals, type OperatorDecision } from "../../chrome-agent-browser/src/core/links/operator.js";
import { loadPackageBytes } from "../../chrome-agent-browser/src/core/package.js";
import { Workflow, type WorkflowOptions } from "../../chrome-agent-browser/src/core/workflow/interpreter.js";

function options(argv: string[]): Map<string, string[]> {
  const found = new Map<string, string[]>();
  for (let index = 0; index + 1 < argv.length; index += 1) if (argv[index]!.startsWith("--")) found.set(argv[index]!, [...(found.get(argv[index]!) ?? []), argv[index + 1]!]);
  return found;
}

async function main(): Promise<void> {
  const argv = JSON.parse(readFileSync(process.argv[2]!, "utf8")) as string[];
  const given = options(argv);
  const pkg = await loadPackageBytes(new Uint8Array(readFileSync(argv[1]!)));
  const router = fixtureAdapters(pkg).router;
  const { linked } = splitToolApprovals(pkg, given.get("--approve-tool") ?? []);
  const decisions: Record<string, OperatorDecision> = {};
  for (const pair of given.get("--link-grants") ?? []) {
    const [name, path] = [pair.slice(0, pair.indexOf("=")), pair.slice(pair.indexOf("=") + 1)];
    decisions[name] = { decision: "accepted", grants: JSON.parse(readFileSync(path, "utf8")), approved_tools: linked[name] ?? [] };
  }
  for (const name of given.get("--deny-link") ?? []) decisions[name] = { decision: "denied" };
  const archives = new Map((given.get("--link") ?? []).map((pair) => [pair.slice(0, pair.indexOf("=")), new Uint8Array(readFileSync(pair.slice(pair.indexOf("=") + 1)))]));
  const trusted = new Set<string>();
  for (const path of given.get("--trust-key") ?? []) trusted.add(await fingerprint(publicKeyFromPem(readFileSync(path, "utf8"))));
  let outcome: Record<string, unknown>;
  try {
    const host = (await operatorLinks(pkg, {
      archives,
      decisions,
      trusted,
      router,
      adapters: (linkedPackage) => {
        const fixture = fixtureAdapters(linkedPackage);
        return { router: fixture.router, handlers: fixture.handlers };
      },
      runner: { create: (linkedPackage, runOptions) => Workflow.create(linkedPackage, runOptions as WorkflowOptions) },
    }))!;
    const bound = packageWorstCase(pkg.graph, pkg.policy, { links: host.worstCases });
    const composed = Object.fromEntries(WORST_CASE_FIGURES.map((name) => [name, bound[name]]));
    checkOnce(pkg, host.bindings);
    outcome = { outcome: "accepted", composed };
  } catch (error) {
    if (error instanceof ExecutionError) outcome = { outcome: "refused", code: error.code, message: error.message };
    else if (error instanceof AgentPkgError) outcome = { outcome: "refused", code: (error as { code?: string }).code ?? null, message: error.message };
    else throw error;
  }
  process.stdout.write(`${JSON.stringify(outcome, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exit(1);
});
