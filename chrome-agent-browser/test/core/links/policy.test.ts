/**
 * What a signed policy says about a run's cards (link.v0, D-681, D-682; T66): the bundle's optional
 * `links` section (`join`, `raise`), copied from `spec/link-v0`, and the surface that takes no
 * budget-raise card, so that the request is never made and nothing is recorded as asked (L-41).
 * A slot under `join: forbid` is the `link/join-policy` case of the conformance family.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import type { RunConsentHost, RunRequest } from "../../../src/core/conversation/host.js";
import { fixtureAdapters } from "../../../src/core/fixtures.js";
import type { JsonObject } from "../../../src/core/json.js";
import { FixtureConsent } from "../../../src/core/links/join.js";
import { loadPackageBytes } from "../../../src/core/package.js";
import { readPolicyBundle } from "../../../src/core/policies/bundle.js";
import { extensionSchemaFailure } from "../../../src/core/schema.js";
import { LINK_CONTRACT_FILES, LINK_CONTRACTS } from "../../../src/core/schemas/link/index.js";
import type { AuditEvent } from "../../../src/core/types.js";
import { runWorkflow, type ExecutionReport } from "../../../src/core/workflow/interpreter.js";
import type { Grants } from "../../../src/core/workflow/runtime.js";
import { ROOT } from "../../helpers/paths.js";

const BUNDLE: JsonObject = {
  policy_id: "org.example.policy",
  version: "1.0.0",
  title: "Example",
  issuer: { name: "Example" },
  issued_at: "2026-10-01T00:00:00Z",
  expires_at: "2027-10-01T00:00:00Z",
  trust_anchors: [],
  decisions: {},
};

/** WebAir Flights alone under a host limit its one model call's reservation (3,326 tokens) does not fit, and fits after a raise of less than half. */
async function underLimit(consent: RunConsentHost | null): Promise<{ report: ExecutionReport; actions: string[] }> {
  const pkg = await loadPackageBytes(new Uint8Array(readFileSync(resolve(ROOT, "dist/webair-flights-0.1.0.agent.pkg"))));
  const fixture = fixtureAdapters(pkg);
  const grants = JSON.parse(readFileSync(resolve(ROOT, "examples/link/webair-flights-grants.json"), "utf8")) as Grants;
  let report: ExecutionReport;
  try {
    report = await runWorkflow(pkg, fixture.input, { grants, handlers: fixture.handlers, router: fixture.router, approvedTools: Object.keys(pkg.tools), limits: { hard_tokens: 2500 }, consent, planHash: "0".repeat(64) });
  } catch (error) {
    report = (error as { execution_report: ExecutionReport }).execution_report;
  }
  return { report, actions: ((report.audit ?? []) as AuditEvent[]).map((event) => String(event.action)).filter((action) => action.startsWith("budget.r")) };
}

describe("the policy bundle's links section (D-681, D-682)", () => {
  it("is the spec's patch, byte for byte", () => {
    expect([...LINK_CONTRACT_FILES]).toEqual(["policy-bundle-v0.schema.patch.json"]);
    for (const name of LINK_CONTRACT_FILES) {
      expect(JSON.stringify(LINK_CONTRACTS[name.replace(/\.json$/u, "")]), name).toBe(JSON.stringify(JSON.parse(readFileSync(resolve(ROOT, "spec", "link-v0", name), "utf8"))));
    }
  });

  it("is optional, closed, and kept by the reader; a bundle that says nothing forbids nothing", async () => {
    expect(await extensionSchemaFailure({ ...BUNDLE, links: { join: "forbid", raise: "forbid" } }, "policy-bundle-v0")).toBeNull();
    expect(await extensionSchemaFailure({ ...BUNDLE, links: { join: "forbid" } }, "policy-bundle-v0")).toBeNull();
    expect(await extensionSchemaFailure({ ...BUNDLE, links: { join: "never" } }, "policy-bundle-v0")).not.toBeNull();
    expect(await extensionSchemaFailure({ ...BUNDLE, links: { planned: "forbid" } }, "policy-bundle-v0")).not.toBeNull();
    expect((await readPolicyBundle({ ...BUNDLE, links: { join: "forbid" } })).links).toEqual({ join: "forbid", raise: "allow" });
    expect((await readPolicyBundle({ ...BUNDLE, links: { raise: "forbid" } })).links).toEqual({ join: "allow", raise: "forbid" });
    expect((await readPolicyBundle(BUNDLE)).links).toBeNull();
  });
});

describe("a surface that takes no budget-raise card (D-682, L-41)", () => {
  it("with a person who accepts, the one raise is asked, recorded and the run completes", async () => {
    const consent = new FixtureConsent(null, { accepted: true });
    const { report, actions } = await underLimit(consent);
    expect(report.status).toBe("completed");
    expect(actions).toEqual(["budget.requested", "budget.raised"]);
    expect(consent.asked.map((request) => request.kind)).toEqual(["budget.raise"]);
  });

  it("with the raise forbidden nobody is asked, nothing is recorded as asked, and the refusal of before stands", async () => {
    const asked: RunRequest[] = [];
    const consent: RunConsentHost = {
      kinds: ["link.join"],
      ask: async (request) => {
        asked.push(request);
        return { accepted: true, provenance: "fixture" };
      },
    };
    const { report, actions } = await underLimit(consent);
    expect(report.status).toBe("failed");
    expect(report.error_code).toBe("budget_exhausted");
    expect(actions).toEqual([]);
    expect(asked).toEqual([]);
    // The same run with nobody there at all ends the same way.
    const alone = await underLimit(null);
    expect([alone.report.status, alone.report.error_code, alone.actions]).toEqual(["failed", "budget_exhausted", []]);
  });
});
