/**
 * The conformance suite's driver for the Chrome core's execution session handed a caller's plan with
 * its links (T66; link.v0 L-15, the cases of the stage `host`), the question `link_session.py` asks
 * the reference: the probe composition of one case (its `run` command line), each accepted link
 * planned for this caller (`parent`), the caller's plan recording each link's decision and inner plan
 * hash, and the plans changed as `test_link_execution.py` changes them. Prints one JSON list of
 * outcomes: `node <bundle> <case-id> <argv.json>`.
 */
import { readFileSync } from "node:fs";

import { localExecutionPlan, type ExecutionAuthorization, type ExecutionPlan } from "../../chrome-agent-browser/src/core/execution/plan.js";
import { ExecutionSession } from "../../chrome-agent-browser/src/core/execution/runner.js";
import { fixtureAdapters } from "../../chrome-agent-browser/src/core/fixtures.js";
import { sha256Hex } from "../../chrome-agent-browser/src/core/hash.js";
import { fingerprint } from "../../chrome-agent-browser/src/core/keys.js";
import { packageWorstCase } from "../../chrome-agent-browser/src/core/links/analysis.js";
import { splitToolApprovals } from "../../chrome-agent-browser/src/core/links/operator.js";
import { loadPackageBytes, type Package } from "../../chrome-agent-browser/src/core/package.js";
import { embeddedPublicKey } from "../../chrome-agent-browser/src/core/signature.js";
import type { LinkPlanEntry } from "../../chrome-agent-browser/src/core/types.js";

type Inner = Record<string, { run_plan: ExecutionPlan; authorization: ExecutionAuthorization }>;

function options(argv: string[]): Map<string, string[]> {
  const found = new Map<string, string[]>();
  for (let index = 0; index + 1 < argv.length; index += 1) if (argv[index]!.startsWith("--")) found.set(argv[index]!, [...(found.get(argv[index]!) ?? []), argv[index + 1]!]);
  return found;
}
const pair = (value: string): [string, string] => [value.slice(0, value.indexOf("=")), value.slice(value.indexOf("=") + 1)];
const signerOf = async (pkg: Package): Promise<string> => fingerprint(await embeddedPublicKey(pkg.signature!));

async function main(): Promise<void> {
  const caseId = process.argv[2]!;
  const argv = JSON.parse(readFileSync(process.argv[3]!, "utf8")) as string[];
  const given = options(argv);
  const callerBytes = new Uint8Array(readFileSync(argv[1]!));
  const caller = await loadPackageBytes(callerBytes);
  const { own, linked } = splitToolApprovals(caller, given.get("--approve-tool") ?? []);
  const grants = Object.fromEntries((given.get("--link-grants") ?? []).map((value) => pair(value)));
  const archives: Record<string, Uint8Array> = {};
  const packages: Record<string, Package> = {};
  const inner: Inner = {};
  const entries: Record<string, LinkPlanEntry> = {};
  const costs: Record<string, ReturnType<typeof packageWorstCase>> = {};
  for (const [name, path] of (given.get("--link") ?? []).map((value) => pair(value))) {
    const bytes = new Uint8Array(readFileSync(path));
    const pkg = await loadPackageBytes(bytes);
    const archiveSha256 = await sha256Hex(bytes);
    const signer = await signerOf(pkg);
    const prepared = localExecutionPlan({ pkg, archiveSha256, signerFingerprint: signer, decisions: JSON.parse(readFileSync(grants[name]!, "utf8")), approvedTools: linked[name] ?? [], fixture: true, parent: { package_digest: caller.digest, dependency: name } });
    archives[name] = bytes;
    packages[name] = pkg;
    inner[name] = { run_plan: prepared.plan, authorization: prepared.authorization };
    entries[name] = { package_id: String(pkg.manifest.package_id), version: String(pkg.manifest.version), digest: pkg.digest, archive_sha256: archiveSha256, signer, trust: "trusted", decision: "accepted", plan_hash: prepared.plan.run_plan_sha256 };
    costs[name] = packageWorstCase(pkg.graph, pkg.policy);
  }
  const { plan, authorization } = localExecutionPlan({ pkg: caller, archiveSha256: await sha256Hex(callerBytes), signerFingerprint: await signerOf(caller), decisions: JSON.parse(readFileSync(given.get("--grants")![0]!, "utf8")), approvedTools: own, fixture: true, links: costs, linkEntries: entries });
  const begin = async (bytes: Uint8Array, runPlan: ExecutionPlan, auth: ExecutionAuthorization, handed: Inner): Promise<Record<string, unknown>> => {
    const pkg = await loadPackageBytes(bytes);
    const fixture = fixtureAdapters(pkg);
    try {
      await new ExecutionSession().begin({ run_id: "run-links", run_plan: runPlan, authorization: auth, input: fixture.input, links: handed }, { archive: bytes, fixture: { router: fixture.router, handlers: fixture.handlers }, linkArchives: archives });
      return { outcome: "accepted" };
    } catch (error) {
      return { outcome: "refused", code: (error as { code?: string }).code ?? null, message: (error as Error).message };
    }
  };
  const outcomes: Array<Record<string, unknown>> = [];
  if (caseId === "inner-plan-replay") {
    const changed = (mutate: (links: Inner) => void): Inner => {
      const copy = JSON.parse(JSON.stringify(inner)) as Inner;
      mutate(copy);
      return copy;
    };
    for (const mutate of [
      (links: Inner) => void ((links.index!.run_plan.parent as Record<string, string>).dependency = "scribe"),
      (links: Inner) => void ((links.index!.run_plan.parent as Record<string, string>).package_digest = "0".repeat(64)),
      (links: Inner) => void (links.index!.run_plan.run_plan_sha256 = "0".repeat(64)),
      (links: Inner) => void (links.index = links.scribe!),
    ]) {
      outcomes.push(await begin(callerBytes, plan, authorization, changed(mutate)));
    }
  } else if (caseId === "inner-plan-alone") {
    for (const name of ["index", "scribe"]) outcomes.push(await begin(archives[name]!, inner[name]!.run_plan, inner[name]!.authorization, {}));
  } else {
    throw new Error(`unknown host case ${caseId}`);
  }
  process.stdout.write(`${JSON.stringify(outcomes, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exit(1);
});
