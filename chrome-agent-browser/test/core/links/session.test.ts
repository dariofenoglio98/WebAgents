/**
 * The execution session's links from Run Plans (link.v0 L-14, L-15; `test_link_execution.py`'s
 * cases in the Chrome core): a caller's plan that records each link's decision and inner plan
 * hash, the inner plans handed over beside it with their archives, verified here; the planner's
 * walk through both links; an inner plan that is not the one the caller's plan names, or names
 * another caller (N-34), and an inner plan handed over as a run's own plan (N-54), both refused
 * `link_plan_parent_mismatch` before anything runs.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { sha256Hex } from "../../../src/core/hash.js";
import { fixtureAdapters } from "../../../src/core/fixtures.js";
import type { JsonObject } from "../../../src/core/json.js";
import { localExecutionPlan, type ExecutionPlan, type ExecutionAuthorization } from "../../../src/core/execution/plan.js";
import { ExecutionSession } from "../../../src/core/execution/runner.js";
import { packageWorstCase } from "../../../src/core/links/analysis.js";
import { embeddedPublicKey } from "../../../src/core/signature.js";
import { fingerprint } from "../../../src/core/keys.js";
import { loadPackageBytes, type Package } from "../../../src/core/package.js";
import type { LinkPlanEntry } from "../../../src/core/types.js";
import { ROOT } from "../../helpers/paths.js";

const read = (path: string): Uint8Array => new Uint8Array(readFileSync(resolve(ROOT, path)));
const json = (path: string): Record<string, string> => JSON.parse(readFileSync(resolve(ROOT, path), "utf8")) as Record<string, string>;

const LINKS = {
  "webair-flights": { archive: "dist/webair-flights-0.1.0.agent.pkg", grants: "examples/link/webair-flights-grants.json", tools: ["search-flights"] },
  "hotel-aggregator": { archive: "dist/staymere-hotels-0.1.0.agent.pkg", grants: "examples/link/staymere-hotels-grants.json", tools: ["search-hotels"] },
} as const;

interface Composition {
  caller: Package;
  callerBytes: Uint8Array;
  plan: ExecutionPlan;
  authorization: ExecutionAuthorization;
  inner: Record<string, { run_plan: ExecutionPlan; authorization: ExecutionAuthorization }>;
  archives: Record<string, Uint8Array>;
}

async function signerOf(pkg: Package): Promise<string> {
  return fingerprint(await embeddedPublicKey(pkg.signature!));
}

/** The planner 0.1.0 planned with both links accepted, each inner plan prepared for this caller. */
async function compose(): Promise<Composition> {
  const callerBytes = read("dist/travel-planner-0.1.0.agent.pkg");
  const caller = await loadPackageBytes(callerBytes);
  const inner: Composition["inner"] = {};
  const archives: Record<string, Uint8Array> = {};
  const entries: Record<string, LinkPlanEntry> = {};
  const costs: Record<string, ReturnType<typeof packageWorstCase>> = {};
  for (const [name, link] of Object.entries(LINKS)) {
    const bytes = read(link.archive);
    const pkg = await loadPackageBytes(bytes);
    const archiveSha256 = await sha256Hex(bytes);
    const signer = await signerOf(pkg);
    const prepared = localExecutionPlan({ pkg, archiveSha256, signerFingerprint: signer, decisions: json(link.grants), approvedTools: [...link.tools], fixture: true, parent: { package_digest: caller.digest, dependency: name } });
    inner[name] = { run_plan: prepared.plan, authorization: prepared.authorization };
    archives[name] = bytes;
    entries[name] = { package_id: String(pkg.manifest.package_id), version: String(pkg.manifest.version), digest: pkg.digest, archive_sha256: archiveSha256, signer, trust: "trusted", decision: "accepted", plan_hash: inner[name]!.run_plan.run_plan_sha256 };
    costs[name] = packageWorstCase(pkg.graph, pkg.policy);
  }
  const { plan, authorization } = localExecutionPlan({ pkg: caller, archiveSha256: await sha256Hex(callerBytes), signerFingerprint: await signerOf(caller), decisions: json("examples/link/travel-planner-grants.json"), approvedTools: ["check-calendar"], fixture: true, links: costs, linkEntries: entries });
  return { caller, callerBytes, plan, authorization, inner, archives };
}

async function begin(composition: Composition, options: { plan?: ExecutionPlan; authorization?: ExecutionAuthorization; inner?: Composition["inner"]; bytes?: Uint8Array } = {}) {
  const session = new ExecutionSession();
  const pkg = options.bytes ? await loadPackageBytes(options.bytes) : composition.caller;
  const fixture = fixtureAdapters(pkg);
  const outcome = await session
    .begin(
      { run_id: "run_links", run_plan: options.plan ?? composition.plan, authorization: options.authorization ?? composition.authorization, input: fixture.input, links: options.inner ?? composition.inner },
      { archive: options.bytes ?? composition.callerBytes, fixture: { router: fixture.router, handlers: fixture.handlers }, linkArchives: composition.archives },
    )
    .then(
      () => ({ session, error: null }),
      (error: unknown) => ({ session, error: error as { code?: string; message: string } }),
    );
  return outcome;
}

describe("a caller's Run Plan with its links (L-14, L-15)", () => {
  it("runs the planner's walk from the inner plans handed over, each recorded with its own plan and hash", async () => {
    const composition = await compose();
    const { session, error } = await begin(composition);
    expect(error).toBeNull();
    const outcome = await session.run();
    expect(outcome.result.status).toBe("completed");
    const links = JSON.parse(new TextDecoder().decode(outcome.files.find(([name]) => name === "links.json")![1])) as JsonObject;
    for (const entry of links.links as JsonObject[]) {
      const name = String(entry.dependency);
      expect(entry.plan_hash).toBe(composition.inner[name]!.run_plan.run_plan_sha256);
      expect((entry.plan as JsonObject).parent).toEqual({ package_digest: composition.caller.digest, dependency: name });
    }
    expect((links.runs as JsonObject[]).map((run) => run.status)).toEqual(["completed", "completed"]);
  });

  it("refuses an inner plan that is not the one the caller's plan names, or names another caller (N-34)", async () => {
    const composition = await compose();
    const mutations: Array<(inner: Composition["inner"]) => Composition["inner"]> = [
      (inner) => ({ ...inner, "webair-flights": { ...inner["webair-flights"]!, run_plan: { ...inner["webair-flights"]!.run_plan, parent: { package_digest: composition.caller.digest, dependency: "hotel-aggregator" } } } }),
      (inner) => ({ ...inner, "webair-flights": { ...inner["webair-flights"]!, run_plan: { ...inner["webair-flights"]!.run_plan, parent: { package_digest: "0".repeat(64), dependency: "webair-flights" } } } }),
      (inner) => ({ ...inner, "webair-flights": { ...inner["webair-flights"]!, run_plan: { ...inner["webair-flights"]!.run_plan, run_plan_sha256: "0".repeat(64) } } }),
      (inner) => ({ ...inner, "webair-flights": inner["hotel-aggregator"]! }),
    ];
    for (const mutate of mutations) {
      const { error } = await begin(composition, { inner: mutate(composition.inner) });
      expect(error?.code).toBe("link_plan_parent_mismatch");
    }
  });

  it("refuses an inner plan handed over as a run's own plan (N-54)", async () => {
    const composition = await compose();
    for (const [name, link] of Object.entries(LINKS)) {
      const { error } = await begin(composition, { plan: composition.inner[name]!.run_plan, authorization: composition.inner[name]!.authorization, inner: {}, bytes: read(link.archive) });
      expect(error?.code, name).toBe("link_plan_parent_mismatch");
      expect(error?.message).toBe("This is a linked package's inner plan: it runs only inside its caller's run, handed over with the caller's plan.");
    }
  });

  it("refuses a caller's plan handed over without the inner plan or the archive of an accepted link", async () => {
    const composition = await compose();
    const { error } = await begin(composition, { inner: { "hotel-aggregator": composition.inner["hotel-aggregator"]! } });
    expect(error?.code).toBe("execution_plan_invalid");
  });
});
