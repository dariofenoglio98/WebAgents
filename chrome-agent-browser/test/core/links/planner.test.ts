/**
 * Agent Links (link.v0) in the Chrome core with T65's shipped packages: the composed envelope the
 * spec states for the planner 0.1.0 and 0.2.0 (§11), each linked package's own worst case, the
 * planned walk through both links (inner runs on their own fixtures, L-25, L-26, L-30), the join
 * walk from the recorded web (§6: the order at the slot step, the request-building call's data,
 * L-37), and the same walk with nobody there to ask (`unattended`, nothing looked at). The full
 * case list runs on both runtimes in `conformance/run.mjs` (the `link/*` family).
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { fixtureAdapters } from "../../../src/core/fixtures.js";
import type { JsonObject } from "../../../src/core/json.js";
import { fingerprint, publicKeyFromPem } from "../../../src/core/keys.js";
import { packageWorstCase, WORST_CASE_FIGURES } from "../../../src/core/links/analysis.js";
import type { LinkHost } from "../../../src/core/links/host.js";
import { loadJoinFixture } from "../../../src/core/links/join.js";
import { operatorLinks, operatorPlan, type OperatorDecision } from "../../../src/core/links/operator.js";
import { planHash } from "../../../src/core/links/host.js";
import { loadPackageBytes, type Package } from "../../../src/core/package.js";
import type { AuditEvent } from "../../../src/core/types.js";
import type { Grants } from "../../../src/core/workflow/runtime.js";
import { runWorkflow, Workflow, type ExecutionReport, type WorkflowOptions } from "../../../src/core/workflow/interpreter.js";
import { ROOT } from "../../helpers/paths.js";

const read = (path: string): Uint8Array => new Uint8Array(readFileSync(resolve(ROOT, path)));
const json = (path: string): JsonObject => JSON.parse(readFileSync(resolve(ROOT, path), "utf8")) as JsonObject;
const pick = (worst: Record<string, unknown>) => Object.fromEntries(WORST_CASE_FIGURES.map((name) => [name, worst[name]]));
const events = (audit: readonly AuditEvent[], action: string): JsonObject[] => audit.filter((event) => event.action === action) as unknown as JsonObject[];
const runner = { create: (pkg: Package, options: Record<string, unknown>) => Workflow.create(pkg, options as WorkflowOptions) };

const ARCHIVES = new Map([
  ["webair-flights", read("dist/webair-flights-0.1.0.agent.pkg")],
  ["hotel-aggregator", read("dist/staymere-hotels-0.1.0.agent.pkg")],
]);
const DECISIONS: Record<string, OperatorDecision> = {
  "webair-flights": { decision: "accepted", grants: json("examples/link/webair-flights-grants.json") as Record<string, string>, approved_tools: ["search-flights"] },
  "hotel-aggregator": { decision: "accepted", grants: json("examples/link/staymere-hotels-grants.json") as Record<string, string>, approved_tools: ["search-hotels"] },
};
const fixtureLinks = (pkg: Package) => {
  const fixture = fixtureAdapters(pkg);
  return { router: fixture.router, handlers: fixture.handlers };
};

async function trusted(): Promise<Set<string>> {
  const keys = ["travel-planner", "webair", "staymere"].map((name) => publicKeyFromPem(readFileSync(resolve(ROOT, `examples/keys/${name}-publisher.pub.pem`), "utf8")));
  return new Set(await Promise.all(keys.map((key) => fingerprint(key))));
}

async function walk(version: "0.1.0" | "0.2.0", options: { joinFixture?: boolean; deny?: string } = {}): Promise<{ pkg: Package; links: LinkHost; report: ExecutionReport; looked: JsonObject[] }> {
  const pkg = await loadPackageBytes(read(`dist/travel-planner-${version}.agent.pkg`));
  const fixture = fixtureAdapters(pkg);
  const grants = json(version === "0.1.0" ? "examples/link/travel-planner-grants.json" : "examples/link/travel-planner-0.2.0-grants.json") as Record<string, string>;
  const approved = version === "0.1.0" ? ["check-calendar"] : ["check-calendar", "web.search"];
  const decisions = { ...DECISIONS, ...(options.deny ? { [options.deny]: { decision: "denied" as const } } : {}) };
  let consent = null;
  let web = null;
  let callerPlan = null;
  if (options.joinFixture) {
    ({ web, consent } = await loadJoinFixture(json("examples/link/join-fixture.json"), async (path) => read(`examples/link/${path}`)));
    callerPlan = operatorPlan(pkg, { grants, approvedTools: approved, limits: null, decisions });
  }
  const keys = await trusted();
  const links = (await operatorLinks(pkg, {
    archives: ARCHIVES,
    decisions,
    trusted: keys,
    router: fixture.router,
    adapters: fixtureLinks,
    runner,
    joins: web !== null ? { look: (url) => web!.look(url), download: (url) => web!.download(url), trust: (signer) => (keys.has(signer) ? "trusted" : "unknown"), adapters: fixtureLinks } : null,
    callerPlan,
  }))!;
  let report: ExecutionReport;
  try {
    report = await runWorkflow(pkg, fixture.input, { grants: grants as Grants, handlers: fixture.handlers, router: fixture.router, approvedTools: approved, links, consent, planHash: callerPlan !== null ? planHash(callerPlan) : null });
  } catch (error) {
    report = (error as { execution_report: ExecutionReport }).execution_report;
  }
  return { pkg, links, report, looked: web?.requests ?? [] };
}

describe("the composed envelope (link.v0 §4, §11)", () => {
  it("each linked package's own worst case is 1 model call, 1 call of its tool, 3 remote calls, 6,000 tokens", async () => {
    for (const name of ["webair-flights", "staymere-hotels", "hotel-salitubam"]) {
      const pkg = await loadPackageBytes(read(`dist/${name}-0.1.0.agent.pkg`));
      const worst = packageWorstCase(pkg.graph, pkg.policy);
      expect(worst.model_calls, name).toBe(1);
      expect(Object.values(worst.tool_calls), name).toEqual([1]);
      expect([worst.compute_calls, worst.remote_calls, worst.tokens], name).toEqual([0, 3, 6000]);
    }
  });

  it("the planner 0.1.0: 10 model calls, its calendar and the two linked tools once each, 23 remote calls, 92,000 tokens", async () => {
    const { pkg, links } = await walk("0.1.0");
    const composed = packageWorstCase(pkg.graph, pkg.policy, { links: links.worstCases });
    expect(pick(composed)).toMatchObject({ model_calls: 10, tool_calls: { "check-calendar": 1, "hotel-aggregator:search-hotels": 1, "webair-flights:search-flights": 1 }, remote_calls: 23, tokens: 92000 });
  });

  it("the planner 0.2.0 with the slot at its ceiling: 14 model calls, 33 remote calls, 122,000 tokens", async () => {
    const { pkg, links } = await walk("0.2.0");
    const composed = packageWorstCase(pkg.graph, pkg.policy, { links: links.worstCases });
    expect(pick(composed)).toMatchObject({ model_calls: 14, remote_calls: 33, tokens: 122000 });
    expect(composed.tool_calls["named-hotel:*"]).toBe(1);
  });

  it("a denied link leaves its role and its cost out of the envelope (L-16, L-22)", async () => {
    const { pkg, links, report } = await walk("0.1.0", { deny: "hotel-aggregator" });
    const composed = packageWorstCase(pkg.graph, pkg.policy, { links: links.worstCases });
    expect(composed.tool_calls).not.toHaveProperty("hotel-aggregator:search-hotels");
    // The planner's fixture records the full tour, whose route requests offer Hotels; with Hotels
    // out of every enum the replay has no recorded answer for the changed request, and the run ends
    // there. What matters here: no inner run of the denied publisher, no route to its role.
    expect(events(report.audit, "link.started").map((event) => event.dependency)).not.toContain("hotel-aggregator");
    for (const event of events(report.audit, "route.decided")) expect(event.next).not.toBe("Hotels");
  });
});

describe("the planned walk (link.v0 §5)", () => {
  it("runs both linked packages as inner runs, settles their usage into the caller's and records each inner run beside it", async () => {
    const { report, links } = await walk("0.1.0");
    expect(report.status).toBe("completed");
    const started = events(report.audit, "link.started");
    expect(started.map((event) => event.dependency).sort()).toEqual(["hotel-aggregator", "webair-flights"]);
    for (const event of started) expect(event.inner_plan_hash).toBe(links.binding(String(event.dependency)).planHash);
    const usage = report.usage as JsonObject;
    expect(usage.tool_calls).toEqual({ "check-calendar": 1, "hotel-aggregator:search-hotels": 1, "webair-flights:search-flights": 1 });
    expect(usage.compute_calls).toBe(0);
    const perLink = usage.links as Record<string, JsonObject>;
    expect(Object.keys(perLink).sort()).toEqual(["hotel-aggregator", "webair-flights"]);
    for (const figures of Object.values(perLink)) expect(figures).toMatchObject({ runs: 1, model_calls: 1, remote_calls: 1 });
    // The inner runs' tokens are inside the caller's (L-26).
    expect(usage.tokens as number).toBeGreaterThan((perLink["webair-flights"]!.tokens as number) + (perLink["hotel-aggregator"]!.tokens as number));
    const record = report.links!;
    expect(record.schema).toBe("agentpkg-run-links-v0");
    expect((record.runs as JsonObject[]).map((run) => run.status)).toEqual(["completed", "completed"]);
    expect(Object.keys(report.inner_runs!).sort()).toEqual(started.map((event) => String(event.inner_run_id)).sort());
    // Nothing of an inner run's chain is in the caller's: its model calls are its own (L-25).
    expect(events(report.audit, "model.called").every((event) => !String(event.node_id).includes(":"))).toBe(true);
    for (const inner of Object.values(report.inner_runs!)) expect(events(inner.audit, "model.called")).toHaveLength(1);
  });
});

describe("the join (link.v0 §6)", () => {
  it("looks at the recorded page, asks the recorded person, then builds the request and runs the joined package, in that order", async () => {
    const { report, looked } = await walk("0.2.0", { joinFixture: true });
    expect(report.status).toBe("completed");
    const slotStep = "plan-trip/FindHotel/ask";
    const order = report.audit.filter((event) => event.node_id === slotStep && ["link.requested", "link.decided", "model.called", "link.started", "link.completed"].includes(event.action)).map((event) => event.action);
    expect(order).toEqual(["link.requested", "link.decided", "model.called", "link.started", "link.completed"]);
    const [decided] = events(report.audit, "link.decided");
    expect(decided).toMatchObject({ slot: "named-hotel", accepted: true, decided_by: "person", provenance: "fixture" });
    expect(looked.map((item) => item.kind)).toEqual(["discovery", "package"]);
    const joins = report.links!.joins as JsonObject[];
    expect(joins).toHaveLength(1);
    expect(joins[0]).toMatchObject({ joined: true, accepted: true });
    expect(((joins[0]!.package as JsonObject).plan as JsonObject).parent).toMatchObject({ slot: "named-hotel", run_id: report.audit[0]!.run_id });
    expect(Object.keys(report.usage.links as JsonObject).sort()).toEqual(["hotel-aggregator", "named-hotel", "webair-flights"]);
  });

  it("hands the request-building call the slot's view and the joined package's own words and input schema, nothing else (L-37)", async () => {
    const pkg = await loadPackageBytes(read("dist/travel-planner-0.2.0.agent.pkg"));
    const fixture = json(String(pkg.graph.fixture) === "fixture.json" ? "agents/travel-planner/fixture.json" : `agents/travel-planner/${String(pkg.graph.fixture)}`);
    const request = ((fixture.models as JsonObject).request as JsonObject[])[0]!.input as JsonObject;
    expect(Object.keys(request).sort()).toEqual(["package", "view"]);
    expect(Object.keys(request.package as JsonObject).sort()).toEqual(["description", "input_schema", "name"]);
    // The replayed walk asks exactly this input (fixture routers match by exact input).
    const { report } = await walk("0.2.0", { joinFixture: true });
    expect(events(report.audit, "model.called").filter((event) => event.task === "request")).toHaveLength(1);
  });

  it("with nobody there to ask, the slot yields `unattended` and looks at nothing", async () => {
    const { report, looked } = await walk("0.2.0");
    expect(report.status).toBe("completed");
    expect(events(report.audit, "link.decided")).toMatchObject([{ reason: "unattended", decided_by: "runtime", accepted: false }]);
    expect(events(report.audit, "link.requested")).toHaveLength(0);
    expect(looked).toEqual([]);
  });
});

describe("the delegation view's model (D-704)", () => {
  it("draws the planned walk from the audit: each activation, the link its role asked, what it held and spent", async () => {
    const { delegationTree } = await import("../../../src/core/links/delegation.js");
    const { report } = await walk("0.1.0");
    const tree = delegationTree(report.audit);
    expect(tree.linked).toBe(true);
    expect(tree.activations.map((activation) => activation.role)).toEqual(events(report.audit, "network.activated").map((event) => event.role));
    const asked = tree.activations.flatMap((activation) => activation.links.map((link) => [activation.role, link.name, link.state]));
    expect(asked.sort()).toEqual([["Flights", "webair-flights", "answered"], ["Hotels", "hotel-aggregator", "answered"]]);
    for (const link of tree.activations.flatMap((activation) => activation.links)) {
      const started = events(report.audit, "link.started").find((event) => event.inner_run_id === link.inner_run_id)!;
      expect(link.reserved).toEqual(started.reserved);
      expect(link.usage).toEqual(events(report.audit, "link.completed").find((event) => event.inner_run_id === link.inner_run_id)!.usage);
    }
    expect(tree.activations.every((activation) => activation.state === "done")).toBe(true);
  });

  it("draws a join with its look and the person's decision, and a slot nobody could be asked about", async () => {
    const { delegationTree } = await import("../../../src/core/links/delegation.js");
    const joined = delegationTree((await walk("0.2.0", { joinFixture: true })).report.audit);
    const join = joined.activations.flatMap((activation) => activation.links).find((link) => link.kind === "join")!;
    expect(join).toMatchObject({ name: "named-hotel", state: "answered", decision: { accepted: true, decided_by: "person", provenance: "fixture" } });
    expect(join.fetches).toHaveLength(2);
    const unattended = delegationTree((await walk("0.2.0")).report.audit);
    expect(unattended.activations.flatMap((activation) => activation.links).find((link) => link.kind === "join")).toMatchObject({ state: "not_joined", code: "unattended", fetches: null });
  });

  // T66 review 1, finding 4: the events a map step's concurrent items record (`link/link-in-map`'s, interleaved).
  const at = (action: string, fields: Record<string, unknown>) => ({ action, ...fields }) as unknown as AuditEvent;
  const started = (id: string, hash: string) => at("link.started", { node_id: "collect/ask", dependency: "index", package_id: "org.example.index", digest: "d".repeat(64), inner_run_id: id, reserved: { tokens: 100, remote_calls: 1 }, input_hash: hash });
  const completed = (id: string, tokens: number, hash: string) => at("link.completed", { node_id: "collect/ask", dependency: "index", inner_run_id: id, usage: { tokens }, result_hash: hash });

  it("draws concurrent inner runs of one step as one node each, keyed by the inner run id", async () => {
    const { delegationTree } = await import("../../../src/core/links/delegation.js");
    const tree = delegationTree([started("run_A", "in_A"), started("run_B", "in_B"), completed("run_A", 11, "out_A"), at("link.failed", { node_id: "collect/ask", dependency: "index", inner_run_id: "run_B", usage: { tokens: 22 }, error_code: "timeout" })]);
    expect(tree.links.map((link) => [link.inner_run_id, link.state, link.input_hash, link.usage, link.result_hash, link.code])).toEqual([
      ["run_A", "answered", "in_A", { tokens: 11 }, "out_A", null],
      ["run_B", "failed", "in_B", { tokens: 22 }, null, "timeout"],
    ]);
    // In the order they end, too.
    const reversed = delegationTree([started("run_A", "in_A"), started("run_B", "in_B"), completed("run_B", 22, "out_B"), completed("run_A", 11, "out_A")]);
    expect(reversed.links.map((link) => [link.inner_run_id, link.state, link.usage, link.result_hash])).toEqual([
      ["run_A", "answered", { tokens: 11 }, "out_A"],
      ["run_B", "answered", { tokens: 22 }, "out_B"],
    ]);
  });

  it("a join that failed before its inner run, a declined raise, and the network's own denial (review 1, finding 4)", async () => {
    const { delegationTree } = await import("../../../src/core/links/delegation.js");
    const slot = { node_id: "find/hotel", slot: "named-hotel" };
    const tree = delegationTree([
      at("link.requested", { ...slot, fetches: [], candidate: { package_id: "org.example.hotel", digest: "e".repeat(64) } }),
      at("link.decided", { ...slot, accepted: true, decided_by: "person", reason: null, provenance: "person" }),
      at("link.failed", { ...slot, inner_run_id: null, error_code: "link_error" }),
      at("budget.requested", { node_id: "write/draft", limit: "tokens", from: 2000, to: 2187 }),
      at("model.refused", { node_id: "write/draft", reason: "hard_tokens" }),
      at("link.denied", { node_id: "trip", role: "Hotels" }),
    ]);
    expect(tree.links.map((link) => [link.kind, link.name, link.state, link.code, link.denied_role])).toEqual([
      ["join", "named-hotel", "failed", "link_error", null],
      ["link", "Hotels", "denied", "denied", "Hotels"],
    ]);
    expect(tree.raise).toMatchObject({ state: "kept", node_id: "write/draft" });
    // A refusal at another operation leaves the raise asked; its own `budget.raised` raises it.
    expect(delegationTree([at("budget.requested", { node_id: "a", limit: "tokens", from: 1, to: 2 }), at("model.refused", { node_id: "b" })]).raise!.state).toBe("asked");
    expect(delegationTree([at("budget.requested", { node_id: "a", limit: "tokens", from: 1, to: 2 }), at("budget.raised", { node_id: "a" })]).raise!.state).toBe("raised");
  });
});
