/**
 * The shipped travel network (`agents/travel-network`) in the Chrome core: the worst case computed
 * from the declaration equals the maximum observed over every allowed walk, each run through the
 * interpreter with the fixture's tool answers and a remote scripted router following the walk
 * (`test_network_travel.py`, T25's acceptance check, here in the second runtime); and the fixture
 * walk is the full tour.
 */
import { describe, expect, it } from "vitest";

import { fixtureAdapters } from "../../../src/core/fixtures.js";
import type { JsonObject } from "../../../src/core/json.js";
import type { ModelRequest, ModelResult } from "../../../src/core/models/contract.js";
import { FixtureRouter, syntheticTokens } from "../../../src/core/models/fixture.js";
import { enumerateWalks, worstCase } from "../../../src/core/network/analysis.js";
import { packageJson } from "../../../src/core/package.js";
import type { AuditEvent } from "../../../src/core/types.js";
import { runWorkflow, type ExecutionReport } from "../../../src/core/workflow/interpreter.js";
import { TRAVEL_SOURCE, treeFiles } from "../../helpers/network-package.js";
import { loadSource } from "../../helpers/source-tree.js";

const GRANTS = { "model.reasoning": "session", "memory.session": "session", "network.webair": "session" } as const;
const TOOLS = ["search-flights", "search-hotels", "check-calendar"];

/** A remote router that answers `understand` from the fixture and follows one scripted walk at every `route`. */
class WalkRouter extends FixtureRouter {
  override readonly remote = true as unknown as false;
  private readonly walk: string[];
  private readonly understanding: unknown;

  constructor(cases: JsonObject, walk: readonly string[]) {
    super(cases);
    this.walk = walk.flatMap((role, index) => (role === "FrontMan" && index + 1 < walk.length ? [walk[index + 1]!] : []));
    this.walk.push("done");
    this.understanding = (cases.understand as Array<{ output: unknown }>)[0]!.output;
  }

  override async complete(request: ModelRequest): Promise<ModelResult> {
    await Promise.resolve();
    const output = (request.task === "understand" ? this.understanding : { next: this.walk.shift()!, message: { text: "Next." } }) as ModelResult["output"];
    this.calls.push(request.task);
    return { output, input_tokens: await this.countTokens(request), output_tokens: syntheticTokens(output) };
  }
}

const events = (audit: readonly AuditEvent[], action: string): JsonObject[] => audit.filter((event) => event.action === action) as unknown as JsonObject[];

function observed(report: ExecutionReport) {
  const activations: Record<string, number> = {};
  for (const event of events(report.audit, "network.activated")) activations[String(event.role)] = (activations[String(event.role)] ?? 0) + 1;
  const tools: Record<string, number> = {};
  for (const event of events(report.audit, "tool.called")) tools[String(event.tool)] = (tools[String(event.tool)] ?? 0) + 1;
  return {
    walk: events(report.audit, "network.activated").map((event) => String(event.role)),
    activations,
    hops: events(report.audit, "network.completed")[0]!.hops as number,
    model_calls: events(report.audit, "model.completed").length,
    tool_calls: tools,
    remote_calls: report.usage.remote_calls as number,
    tokens: report.usage.tokens as number,
  };
}

describe("the travel network's envelope is attained and never passed", () => {
  it("runs every one of its sixteen walks; the maximum observed per component equals the bound", async () => {
    const pkg = await loadSource(treeFiles(TRAVEL_SOURCE));
    const network = pkg.graph.network as JsonObject;
    const walks = enumerateWalks(network);
    expect(walks).toHaveLength(16);
    const bound = worstCase(pkg.graph, pkg.policy);
    const fixture = packageJson(pkg, String(pkg.graph.fixture)) as JsonObject;
    const { handlers, input } = fixtureAdapters(pkg);
    const runs = [];
    for (const walk of walks) {
      const report = await runWorkflow(pkg, input, { grants: { ...GRANTS }, handlers, router: new WalkRouter(fixture.models as JsonObject, walk), approvedTools: TOOLS });
      expect(report.status).toBe("completed");
      const usage = observed(report);
      expect(usage.walk).toEqual(walk);
      runs.push(usage);
    }
    expect(Math.max(...runs.map((run) => run.hops))).toBe(bound.max_hops);
    expect(bound.max_hops).toBe(6);
    for (const [role, cap] of Object.entries(bound.activations)) expect(Math.max(...runs.map((run) => run.activations[role] ?? 0)), role).toBe(cap);
    expect(Math.max(...runs.map((run) => run.model_calls))).toBe(bound.model_calls);
    for (const [tool, cap] of Object.entries(bound.tool_calls)) expect(Math.max(...runs.map((run) => run.tool_calls[tool] ?? 0)), tool).toBe(cap);
    // Two remote calls per model call (a remote router's count preflight and completion) and one per remote tool call.
    expect(Math.max(...runs.map((run) => run.remote_calls))).toBe(bound.remote_calls);
    expect(bound.remote_calls).toBe(19);
    expect(runs.every((run) => run.tokens <= bound.tokens)).toBe(true);
    expect(bound.tokens).toBe(48000);
  });

  it("its fixture walk is the full tour", async () => {
    const pkg = await loadSource(treeFiles(TRAVEL_SOURCE));
    const { router, handlers, input } = fixtureAdapters(pkg);
    const report = await runWorkflow(pkg, input, { grants: { ...GRANTS }, handlers, router, approvedTools: TOOLS });
    expect(observed(report).activations).toEqual({ FrontMan: 4, Flights: 1, Hotel: 1, Calendar: 1 });
    const output = report.output as JsonObject;
    expect((output.flights as JsonObject[]).map((flight) => flight.id)).toEqual(["WA101-20270309", "WA213-WA741-20270309", "WA205-WA731-20270309"]);
    expect(String(output.plan).startsWith("Boston to Zurich")).toBe(true);
  });
});
