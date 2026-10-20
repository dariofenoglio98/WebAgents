/**
 * Behavioral tests for one interpreter, independent of application orchestration: the port of
 * `agentpkg/tests/test_workflow.py` over the same package sources and fixtures.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { ValidationError } from "../../../src/core/errors.js";
import { fixtureAdapters } from "../../../src/core/fixtures.js";
import type { JsonObject, JsonValue } from "../../../src/core/json.js";
import type { ModelRequest, ModelResult } from "../../../src/core/models/contract.js";
import { loadPackageBytes } from "../../../src/core/package.js";
import { CancelledError, PolicyError, WorkflowError } from "../../../src/core/workflow/errors.js";
import { INTERPRETER, runWorkflow } from "../../../src/core/workflow/interpreter.js";
import { digest } from "../../../src/core/workflow/runtime.js";
import { PROJECT, readBytes, SHIPPED } from "../../helpers/paths.js";
import { change, loadSource, sourceTree, type Files } from "../../helpers/source-tree.js";
import { createWorkflow, execute, executeFailing, sessionGrants, sleepWithSignal, WrappingRouter } from "../../helpers/workflow.js";
import { listMembers } from "../../helpers/zip.js";

const CORE_EVENTS = [
  "workflow.started",
  "workflow.completed",
  "node.started",
  "node.completed",
  "worker.spawned",
  "worker.completed",
  "model.called",
  "model.completed",
  "permission.checked",
  "delegation.checked",
  "budget.updated",
];

describe("the same interpreter runs both reference packages from their sources", () => {
  for (const name of ["literature-review", "meeting-agenda"]) {
    it(`completes ${name} with the recorded fixture counts and a valid chain`, async () => {
      const pkg = await loadSource(sourceTree(name));
      const result = await execute(pkg);
      expect(result.status).toBe("completed");
      expect(result.provenance.interpreter).toBe(INTERPRETER);
      expect(result.usage.peak_parallel_workers).toBe(3);
      const actions = new Set(result.audit.map((event) => event.action));
      for (const action of CORE_EVENTS) expect(actions.has(action), action).toBe(true);
      const topDone = result.audit.filter((event) => event.action === "node.completed" && !event.worker).map((event) => event.node_id);
      expect(new Set(topDone)).toEqual(new Set((pkg.graph.nodes as JsonObject[]).map((node) => node.id)));
      if (name === "literature-review") {
        expect(result.usage.tool_calls).toEqual({ "scholarly-search": 3, "citation-resolver": 3, "paper-reader": 2 });
        // 0.2.7 (D-170): the search's duplicate DOI is removed before any model sees it, and every
        // found paper is screened and listed; since 0.2.9 (T22, D-252) the bookkeeping module
        // removes it (normalized identity) after join-search keeps all nine.
        expect((result.state.search_batches as JsonObject[]).reduce((sum, batch) => sum + (batch.papers as JsonValue[]).length, 0)).toBe(9);
        expect((result.state.raw_candidates as JsonValue[]).length).toBe(9);
        expect((result.state.unique_candidates as JsonValue[]).length).toBe(8);
        expect(result.usage.compute_calls).toBe(1);
        expect((result.state.found_papers as JsonValue[]).length).toBe(8);
        expect(((result.output as JsonObject).papers_found as JsonValue[]).length).toBe(8);
        expect((result.state.citation_jobs as JsonValue[]).length).toBe(3);
        const output = result.output as JsonObject;
        expect((output.bibliography as JsonValue[]).length).toBe(2);
        expect((output.evidence_table as JsonValue[]).length).toBe(7);
        expect(new Set((result.state.citation_records as JsonObject[]).map((record) => record.status))).toEqual(new Set(["resolved", "ambiguous"]));
        // 0.2.7: the unresolved list is the graph's own; a paper screened "maybe" is in papers_found.
        expect((output.unresolved as JsonObject[]).map((item) => item.status)).toEqual(["ambiguous"]);
        expect((output.papers_found as JsonObject[]).some((paper) => paper.screening_status === "maybe")).toBe(true);
        expect(String(output.related_work)).toContain("SYNTHETIC DEMONSTRATION");
      } else {
        const output = result.output as JsonObject;
        expect((output.agenda as JsonObject[]).reduce((sum, item) => sum + (item.minutes as number), 0)).toBe(45);
        expect(result.usage.remote_calls).toBe(0);
      }
      let previous: string | null = null;
      for (const event of result.audit) {
        expect(event.previous_hash).toBe(previous);
        const { event_hash, ...body } = event;
        expect(digest(body)).toBe(event_hash);
        previous = event_hash;
      }
    });
  }

  it("the shipped WebAir 0.4.0 completes its fixture with the personal permissions denied", async () => {
    const pkg = await loadPackageBytes(readBytes(join(PROJECT, "..", "dist", "webair-0.4.0.agent.pkg")));
    const grants = JSON.parse(readFileSync(join(PROJECT, "..", "examples", "webair-0.2.0-grants.json"), "utf8")) as Record<string, "session" | "deny">;
    const result = await execute(pkg, { grants });
    expect(result.status).toBe("completed");
    expect((result.output as JsonObject).status).toBe("options_found");
    expect(result.usage.tool_calls).toEqual({ "search-flights": 1, "get-fare-rules": 3 });
    expect(result.audit.filter((event) => event.action === "node.skipped").length).toBeGreaterThan(0);
  });
});

describe("genericity", () => {
  it("package and node identity are not dispatch keys", async () => {
    const files = sourceTree("meeting-agenda");
    change(files, "MANIFEST.agent", (manifest) => Object.assign(manifest, { package_id: "org.example.unknown", name: "Unrelated title" }));
    change(files, "graph.json", (graph) => {
      const nodes = graph.nodes as JsonObject[];
      const ids = new Map(nodes.map((node, index) => [String(node.id), `n${index}`]));
      for (const node of nodes) {
        node.id = ids.get(String(node.id))!;
        node.depends_on = (node.depends_on as JsonValue[]).map((dependency) => ids.get(String(dependency))!);
      }
      nodes.reverse(); // File order is not execution order.
    });
    const result = await execute(await loadSource(files));
    expect(result.status).toBe("completed");
    expect(result.provenance.package_id).toBe("org.example.unknown");
  });

  it("no application imports or terms in generic execution", () => {
    const modules = [
      "src/core/workflow/interpreter.ts",
      "src/core/workflow/runtime.ts",
      "src/core/workflow/values.ts",
      "src/core/workflow/assertions.ts",
      "src/core/workflow-static.ts",
      "src/core/validation.ts",
      "src/core/fixtures.ts",
      "src/core/models/fixture.ts",
    ];
    for (const module of modules) {
      const text = readFileSync(join(PROJECT, module), "utf8").toLowerCase();
      for (const forbidden of ["literature", "citation", "evidence", "related_work", "meeting", "agenda", "webair", "airline"]) {
        expect(text.includes(forbidden), `${module} mentions ${forbidden}`).toBe(false);
      }
    }
  });
});

describe("scheduling", () => {
  for (const limit of [1, 2, 3]) {
    it(`map parallel limit ${limit} bounds concurrency and keeps input order`, async () => {
      const pkg = await loadSource(sourceTree("meeting-agenda"));
      const router = new WrappingRouter(fixtureAdapters(pkg).router);
      const result = await execute(pkg, { router, limits: { max_parallel_workers: limit } });
      expect(router.peak).toBe(limit);
      expect(result.usage.peak_parallel_workers).toBe(limit);
      expect((result.state.perspectives as JsonObject[]).map((item) => item.role)).toEqual(["Product", "Engineering", "Support"]);
      for (const request of router.calls) {
        expect(request.requirements).toBeDefined();
        expect(request.budget_context).toBeDefined();
        expect(request.audit_context).toBeDefined();
        expect(request.instructions.length).toBeGreaterThan(0);
      }
    });
  }

  it("the role instance limit bounds workers", async () => {
    const files = sourceTree("meeting-agenda");
    change(files, "graph.json", (graph) => {
      (graph.workers as JsonObject[]).find((role) => role.id === "Perspective")!.max_instances = 1;
      (graph.nodes as JsonObject[])[1]!.max_parallel = 1;
    });
    const pkg = await loadSource(files);
    const router = new WrappingRouter(fixtureAdapters(pkg).router);
    expect((await execute(pkg, { router })).usage.peak_parallel_workers).toBe(1);
  });

  it("multiple ready nodes join, waves commit in order, and an unordered write conflict is refused at load", async () => {
    const files = sourceTree("meeting-agenda");
    files.set("schemas/participants.schema.json", new TextEncoder().encode(JSON.stringify({ type: "array", items: { $ref: "participant.schema.json" } })));
    change(files, "MANIFEST.agent", (manifest) => (manifest.schemas as JsonValue[]).push({ id: "participants", path: "schemas/participants.schema.json" }));
    change(files, "schemas/state.schema.json", (schema) => {
      for (const key of ["left", "right", "merged"]) (schema.properties as JsonObject)[key] = { $ref: "participants.schema.json" };
    });
    const node = (id: string, kind: string, input: JsonValue, depends: string[], writes: JsonObject): JsonObject => ({
      id,
      type: kind,
      input,
      worker: "Coordinator",
      depends_on: depends,
      writes,
      output_schema: "schemas/participants.schema.json",
      timeout_seconds: 5,
    });
    const state = (key: string): JsonValue => ({ from: "state", path: `/${key}` });
    const result: JsonValue = { from: "result", path: "" };
    change(files, "graph.json", (graph) => {
      const coordinator = (graph.workers as JsonObject[])[0]!;
      coordinator.state_read = [...(coordinator.state_read as JsonValue[]), "left", "right", "merged"];
      coordinator.state_write = [...(coordinator.state_write as JsonValue[]), "left", "right", "merged"];
      for (const key of ["left", "right", "merged"]) ((graph.initial_state as JsonObject).object as JsonObject)[key] = { literal: [] };
      graph.nodes = [
        node("left", "validate", state("request/participants"), [], { "/left": result }),
        node("right", "validate", state("request/participants"), [], { "/right": result }),
        node("join", "join", { array: [state("left"), state("right")] }, ["left", "right"], { "/merged": result }),
        node("output", "output", state("merged"), ["join"], {}),
      ];
      graph.output_schema = "schemas/participants.schema.json";
      graph.exports = [];
    });
    const pkg = await loadSource(files);
    const run = await execute(pkg);
    expect((run.output as JsonValue[]).length).toBe(6);
    const commits = run.audit.filter((event) => event.action === "state.committed").map((event) => event.nodes);
    expect(commits).toEqual([["left", "right"], ["join"], ["output"]]);
    expect(run.usage.tokens).toBe(0);
    change(files, "graph.json", (graph) => ((graph.nodes as JsonObject[])[1]!.writes = { "/left": { from: "result", path: "" } }));
    await expect(loadSource(files)).rejects.toThrow(/unordered state conflict/u);
  });

  it("map max_items is checked before any child dispatch", async () => {
    const files = sourceTree("meeting-agenda");
    change(files, "graph.json", (graph) => ((graph.nodes as JsonObject[])[1]!.max_items = 2));
    const failure = await executeFailing(await loadSource(files));
    expect(failure.node_id).toBe("perspectives");
    const audit = failure.execution_report!.audit as JsonObject[];
    expect(audit.some((event) => event.action === "worker.spawned" && event.role === "Perspective")).toBe(false);
  });

  it("an empty map and join are well defined", async () => {
    const files = sourceTree("meeting-agenda");
    change(files, "fixtures/workflow.json", (fixture) => {
      (fixture.input as JsonObject).participants = [];
      const models = fixture.models as JsonObject;
      ((models.plan as JsonObject[])[0]!.input as JsonObject).participants = [];
      const write = (models.write as JsonObject[])[0]!.input as JsonObject;
      (write.request as JsonObject).participants = [];
      write.perspectives = [];
    });
    const result = await execute(await loadSource(files));
    expect(result.state.batches).toEqual([]);
    expect(result.state.perspectives).toEqual([]);
    expect(result.audit.some((event) => event.action === "worker.spawned" && event.role === "Perspective")).toBe(false);
  });
});

describe("authority and budgets", () => {
  for (const permission of ["memory.session", "model.reasoning"]) {
    it(`a denied ${permission} refuses before any model dispatch`, async () => {
      const pkg = await loadSource(sourceTree("meeting-agenda"));
      const { router } = fixtureAdapters(pkg);
      const grants: Record<string, "session" | "deny"> = { ...sessionGrants(pkg), [permission]: "deny" };
      const failure = await executeFailing(pkg, { router, grants });
      expect(failure.code).toBe("permission_denied");
      expect(router.calls).toEqual([]);
      expect(failure.execution_report!.status).toBe("failed");
    });
  }

  it("token budget exhaustion leaks no reservation", async () => {
    const failure = await executeFailing(await loadSource(sourceTree("meeting-agenda")), { limits: { hard_tokens: 5 } });
    const report = failure.execution_report!;
    expect(report.error_code).toBe("budget_exhausted");
    const usage = report.usage as JsonObject;
    expect(usage.tokens).toBe(0);
    expect(usage.reserved_tokens).toBe(0);
  });

  it("the remote-call budget refuses a tool before the call", async () => {
    const failure = await executeFailing(await loadSource(sourceTree("literature-review")), { limits: { max_remote_calls: 0 } });
    expect(failure.code).toBe("budget_exhausted");
    expect((failure.execution_report!.usage as JsonObject).remote_calls).toBe(0);
  });

  it("an explicit tool permission denial refuses the tool", async () => {
    const pkg = await loadSource(sourceTree("literature-review"));
    const grants: Record<string, "session" | "deny"> = { ...sessionGrants(pkg), "network.citations": "deny" };
    const failure = await executeFailing(pkg, { grants });
    expect(failure.code).toBe("permission_denied");
    expect(((failure.execution_report!.usage as JsonObject).tool_calls as JsonObject)["citation-resolver"] ?? 0).toBe(0);
  });

  it("a model failure charges the reservation conservatively", async () => {
    const pkg = await loadSource(sourceTree("meeting-agenda"));
    class Failed extends WrappingRouter {
      override async complete(): Promise<ModelResult> {
        throw new Error("unknown billable usage");
      }
    }
    const failure = await executeFailing(pkg, { router: new Failed(fixtureAdapters(pkg).router) });
    const usage = failure.execution_report!.usage as JsonObject;
    expect(usage.tokens).toBe(12010);
    expect(usage.reserved_tokens).toBe(0);
  });

  it("remote model usage is counted twice per call, and local-only refuses a remote router", async () => {
    const files = sourceTree("meeting-agenda");
    change(files, "policy/policy.json", (policy) => ((policy.budget as JsonObject).max_remote_calls = 20));
    change(files, "graph.json", (graph) => {
      for (const role of graph.workers as JsonObject[]) (role.budget as JsonObject).remote_calls = 20;
    });
    let pkg = await loadSource(files);
    class Remote extends WrappingRouter {
      override readonly remote = true;
    }
    const result = await execute(pkg, { router: new Remote(fixtureAdapters(pkg).router) });
    expect(result.usage.remote_calls).toBe(10); // Five counts and five completions.
    change(files, "MANIFEST.agent", (manifest) => ((manifest.model_requirements as JsonObject).privacy = "local-only"));
    pkg = await loadSource(files);
    const router = new Remote(fixtureAdapters(pkg).router);
    const failure = await executeFailing(pkg, { router });
    expect(failure.code).toBe("permission_denied");
    expect(router.calls).toEqual([]);
  });
});

describe("validation and failure attribution", () => {
  it("a model output that fails the node schema is schema_validation and settles known usage", async () => {
    const pkg = await loadSource(sourceTree("meeting-agenda"));
    class Invalid extends WrappingRouter {
      override async complete(): Promise<ModelResult> {
        return { output: { wrong: true }, input_tokens: 10, output_tokens: 2 };
      }
    }
    const failure = await executeFailing(pkg, { router: new Invalid(fixtureAdapters(pkg).router) });
    expect(failure.code).toBe("schema_validation");
    expect((failure.execution_report!.usage as JsonObject).tokens).toBe(12);
  });

  it("an invalid state write fails atomically", async () => {
    const files = sourceTree("meeting-agenda");
    // The result path is valid but its type cannot be assigned to this state slot.
    change(files, "graph.json", (graph) => Object.assign((graph.nodes as JsonObject[])[0]!.writes as JsonObject, { "/plan": { from: "result", path: "/focus" } }));
    const failure = await executeFailing(await loadSource(files));
    expect(failure.node_id).toBe("plan");
    expect(failure.code).toBe("schema_validation");
    expect((failure.execution_report!.audit as JsonObject[]).some((event) => event.action === "state.committed")).toBe(false);
  });

  it("the time sum is a package-declared generic constraint", async () => {
    const files = sourceTree("meeting-agenda");
    change(files, "fixtures/workflow.json", (fixture) => (((((fixture.models as JsonObject).write as JsonObject[])[0]!.output as JsonObject).agenda as JsonObject[])[0]!.minutes = 99));
    // Bypass constructive allocation to deliberately corrupt the final value.
    change(files, "graph.json", (graph) => {
      const assemble = (graph.nodes as JsonObject[]).find((node) => node.id === "assemble")!;
      ((assemble.input as JsonObject).object as JsonObject).agenda = { from: "state", path: "/draft/agenda" };
    });
    const failure = await executeFailing(await loadSource(files));
    expect(failure.node_id).toBe("validate");
    expect(failure.code).toBe("schema_validation");
  });

  it("the source-quote constraint rejects a fabricated quote and names the check, never the data", async () => {
    const files = sourceTree("literature-review");
    change(files, "fixtures/workflow.json", (fixture) => (((((fixture.models as JsonObject).extract as JsonObject[])[0]!.output as JsonObject[])[0]!).quote = "A fabricated quote not in the source."));
    const failure = await executeFailing(await loadSource(files));
    expect(failure.node_id).toBe("evidence");
    // Since 0.2.7 (D-171) the quote relation is an answer check on extract-one: a non-conforming
    // answer, which a replay router never re-asks.
    expect(failure.code).toBe("model_error");
    const audit = failure.execution_report!.audit as JsonObject[];
    const failed = audit.find((event) => event.action === "node.failed" && event.node_id === "evidence/extract-one")!;
    const check = failed.failed_check as JsonObject;
    expect(check.check).toBe("answer_check");
    expect(check.kind).toBe("relation");
    expect(check.failure).toBe("fields_do_not_match");
    expect((check.compare as JsonObject).op).toBe("contained_in");
    expect((check.compare as JsonObject).left).toBe("/quote");
    expect(JSON.stringify(audit)).not.toContain("fabricated");
  });

  it("a verifier cannot supply bibliographic metadata", async () => {
    const files = sourceTree("literature-review");
    change(files, "fixtures/workflow.json", (fixture) => {
      const resolution = ((((fixture.tools as JsonObject)["citation-resolver"] as JsonObject[])[0]!.output as JsonObject).best_match as JsonValue);
      ((((fixture.models as JsonObject).verify as JsonObject[])[0]!.output as JsonObject).bibliography as JsonObject[])[0]!.metadata = resolution;
    });
    const failure = await executeFailing(await loadSource(files));
    expect(failure.node_id).toBe("verification");
    expect(failure.code).toBe("schema_validation");
  });

  it("a final bibliography that is not the resolver record is attributed to the declared assertion", async () => {
    const files = sourceTree("literature-review");
    const fixture = JSON.parse(new TextDecoder().decode(files.get("fixtures/workflow.json")!)) as JsonObject;
    const record = { ...((((fixture.tools as JsonObject)["citation-resolver"] as JsonObject[])[0]!.output as JsonObject).best_match as JsonObject) };
    record.title = `${record.title} (edited)`;
    change(files, "graph.json", (graph) => {
      const node = (graph.nodes as JsonObject[]).find((item) => item.id === "bibliography")!;
      (((node.steps as JsonObject[])[0]!.input as JsonObject).object as JsonObject).metadata = { literal: record };
    });
    const failure = await executeFailing(await loadSource(files));
    expect(failure.node_id).toBe("validate-output");
    expect(failure.code).toBe("schema_validation");
    const audit = failure.execution_report!.audit as JsonObject[];
    const failed = audit.filter((event) => event.action === "node.failed" && event.node_id === "validate-output");
    expect(failed.length).toBe(1);
    expect(failed[0]!.failed_check).toEqual({
      check: "assertion",
      index: 0,
      kind: "relation",
      failure: "fields_do_not_match",
      compare: { left: "/metadata", right: "/response/best_match", op: "eq" },
    });
    expect(JSON.stringify(audit)).not.toContain("(edited)");
  });

  it("a join that drops records records the counts and never the data", async () => {
    const files = sourceTree("meeting-agenda");
    change(files, "graph.json", (graph) => ((graph.nodes as JsonObject[]).find((node) => node.id === "join")!.unique_by = ["/role"]));
    change(files, "fixtures/workflow.json", (fixture) => {
      const perspective = (fixture.models as JsonObject).perspective as JsonObject[];
      const second = (perspective[1]!.output as JsonObject[])[0]!;
      second.role = (perspective[0]!.output as JsonObject[])[0]!.role!;
    });
    // The writer's recorded input no longer matches, so the run then stops.
    const failure = await executeFailing(await loadSource(files));
    const events = (failure.execution_report!.audit as JsonObject[]).filter((event) => event.action === "node.deduplicated" && event.node_id === "join");
    expect(events.length).toBe(1);
    const event = events[0]!;
    expect(event.original_count).toBe(3);
    expect(event.retained_count).toBe(2);
    expect(event.conflicting_duplicates).toBe(1);
    expect(event.identical_duplicates).toBe(0);
    expect(event.unique_by).toEqual(["/role"]);
    expect(JSON.stringify(event)).not.toContain("priorities");
  });

  it("a tool output that fails its schema and a tool that fails are distinct codes", async () => {
    const pkg = await loadSource(sourceTree("literature-review"));
    const { handlers } = fixtureAdapters(pkg);
    const invalid = await executeFailing(pkg, { handlers: { ...handlers, "scholarly.search": async () => ({ invalid: true }) } });
    expect(invalid.code).toBe("schema_validation");
    const failing = await executeFailing(pkg, {
      handlers: {
        ...handlers,
        "scholarly.search": async () => {
          throw new Error("provider secret");
        },
      },
    });
    expect(failing.code).toBe("tool_error");
    expect(JSON.stringify(failing.execution_report)).not.toContain("provider secret");
  });

  it("a fixture does not silently answer a changed input", async () => {
    const pkg = await loadSource(sourceTree("meeting-agenda"));
    const { router, handlers, input } = fixtureAdapters(pkg);
    (input as JsonObject).goal = "An unrelated question";
    await expect(runWorkflow(pkg, input, { router, handlers, grants: sessionGrants(pkg) })).rejects.toBeInstanceOf(WorkflowError);
  });

  it("an invalid text export fails before workflow completion", async () => {
    const files = sourceTree("meeting-agenda");
    change(files, "graph.json", (graph) => ((graph.exports as JsonObject[])[0]!.format = "text"));
    const failure = await executeFailing(await loadSource(files));
    expect(failure.code).toBe("schema_validation");
    expect((failure.execution_report!.audit as JsonObject[]).some((event) => event.action === "workflow.completed")).toBe(false);
  });

  it("model metadata cannot leak raw content into the audit", async () => {
    const pkg = await loadSource(sourceTree("meeting-agenda"));
    class BadMetadata extends WrappingRouter {
      override async complete(request: ModelRequest, maxOutputTokens: number, signal: AbortSignal): Promise<ModelResult> {
        const result = await super.complete(request, maxOutputTokens, signal);
        return { ...result, cost_usd: { private: "raw secret metadata" } as unknown as number };
      }
    }
    const failure = await executeFailing(pkg, { router: new BadMetadata(fixtureAdapters(pkg).router) });
    expect(failure.code).toBe("schema_validation");
    expect(JSON.stringify(failure.execution_report)).not.toContain("raw secret metadata");
  });

  it("a modified payload cannot reuse a verified integrity statement", async () => {
    const pkg = await loadSource(sourceTree("meeting-agenda"));
    const files = new Map(pkg.files);
    const graph = files.get("graph.json")!;
    const changed = new Uint8Array(graph.length + 1);
    changed.set(graph);
    changed[graph.length] = 0x20;
    files.set("graph.json", changed);
    await expect(createWorkflow({ ...pkg, files })).rejects.toThrow(/changed after integrity/u);
  });

  it("duplicate fixture cases are refused at load", async () => {
    const files = sourceTree("meeting-agenda");
    change(files, "fixtures/workflow.json", (fixture) => {
      const plan = (fixture.models as JsonObject).plan as JsonObject[];
      plan.push(JSON.parse(JSON.stringify(plan[0])) as JsonObject);
    });
    await expect(loadSource(files)).rejects.toThrow(/duplicate input/u);
  });

  it("the state a model mutates is its own copy", async () => {
    const pkg = await loadSource(sourceTree("meeting-agenda"));
    class Mutating extends WrappingRouter {
      override async complete(request: ModelRequest, maxOutputTokens: number, signal: AbortSignal): Promise<ModelResult> {
        const saved = JSON.parse(JSON.stringify(request)) as ModelRequest;
        if (request.task === "perspective") ((request.data as JsonObject).request as JsonObject).goal = "malicious mutation";
        return super.complete(saved, maxOutputTokens, signal);
      }
    }
    const result = await execute(pkg, { router: new Mutating(fixtureAdapters(pkg).router) });
    expect((result.state.request as JsonObject).goal).not.toBe("malicious mutation");
    expect((result.output as JsonObject).goal).toBe((result.state.request as JsonObject).goal);
  });
});

describe("failure propagation, deadlines and cancellation", () => {
  it("a worker failure cancels the other map children and commits nothing of the wave", async () => {
    const pkg = await loadSource(sourceTree("meeting-agenda"));
    class Failing extends WrappingRouter {
      override async complete(request: ModelRequest, maxOutputTokens: number, signal: AbortSignal): Promise<ModelResult> {
        if (request.task === "perspective") {
          if (((request.data as JsonObject).participant as JsonObject).role === "Product") {
            await sleepWithSignal(0.01, signal);
            throw new Error("private-provider-detail");
          }
          try {
            await sleepWithSignal(30, signal);
          } catch (error) {
            if (error instanceof CancelledError) this.cancelled += 1;
            throw error;
          }
        }
        return super.complete(request, maxOutputTokens, signal);
      }
    }
    const router = new Failing(fixtureAdapters(pkg).router);
    const failure = await executeFailing(pkg, { router });
    const report = failure.execution_report!;
    expect(report.error_code).toBe("model_error");
    expect(router.cancelled).toBe(2);
    expect((report.usage as JsonObject).reserved_tokens).toBe(0);
    expect(JSON.stringify(report)).not.toContain("private-provider-detail");
    expect((report.audit as JsonObject[]).some((event) => event.action === "state.committed" && (event.nodes as JsonValue[]).includes("perspectives"))).toBe(false);
  });

  for (const scope of ["node", "workflow", "count"] as const) {
    it(`a ${scope} deadline is a timeout and releases every reservation`, async () => {
      const files = sourceTree("meeting-agenda");
      change(files, "graph.json", (graph) => {
        if (scope === "workflow") graph.deadline_seconds = 0.02;
        else (graph.nodes as JsonObject[])[0]!.timeout_seconds = 0.02;
      });
      const pkg = await loadSource(files);
      class Slow extends WrappingRouter {
        override async countTokens(_request: ModelRequest, signal: AbortSignal): Promise<number> {
          if (scope === "count") await sleepWithSignal(30, signal);
          return 10;
        }
        override async complete(_request: ModelRequest, _max: number, signal: AbortSignal): Promise<ModelResult> {
          await sleepWithSignal(30, signal);
          throw new Error("unreachable");
        }
      }
      const failure = await executeFailing(pkg, { router: new Slow(fixtureAdapters(pkg).router) });
      expect(failure.code).toBe("timeout");
      expect((failure.execution_report!.usage as JsonObject).reserved_tokens).toBe(0);
    });
  }

  it("a tool deadline stops every in-flight handler", async () => {
    const files = sourceTree("literature-review");
    // Tool schema uses integral seconds; the enclosing node deadline is tighter.
    change(files, "graph.json", (graph) => ((graph.nodes as JsonObject[]).find((node) => node.id === "search")!.timeout_seconds = 0.02));
    const pkg = await loadSource(files);
    const { handlers } = fixtureAdapters(pkg);
    const stopped: string[] = [];
    const slow = async (context: { worker_id: string }, _payload: JsonValue, signal: AbortSignal): Promise<JsonValue> => {
      try {
        await sleepWithSignal(30, signal);
        return null;
      } finally {
        stopped.push(context.worker_id);
      }
    };
    const failure = await executeFailing(pkg, { handlers: { ...handlers, "scholarly.search": slow } });
    expect(failure.code).toBe("timeout");
    expect(stopped.length).toBe(3);
  });

  it("cancellation drains workers, clears state and retains the audit", async () => {
    const pkg = await loadSource(sourceTree("meeting-agenda"));
    const { router: fixture, input } = fixtureAdapters(pkg);
    let entered!: () => void;
    const enteredPromise = new Promise<void>((resolve) => {
      entered = resolve;
    });
    class Slow extends WrappingRouter {
      override async complete(_request: ModelRequest, _max: number, signal: AbortSignal): Promise<ModelResult> {
        entered();
        try {
          await sleepWithSignal(30, signal);
        } catch (error) {
          if (error instanceof CancelledError) this.cancelled += 1;
          throw error;
        }
        throw new Error("unreachable");
      }
    }
    const router = new Slow(fixture);
    const workflow = await createWorkflow(pkg, { router });
    const running = workflow.run(input);
    await enteredPromise;
    workflow.cancel();
    let caught: CancelledError | null = null;
    try {
      await running;
    } catch (error) {
      caught = error as CancelledError;
    }
    expect(caught).toBeInstanceOf(CancelledError);
    const report = caught!.execution_report!;
    expect(report.status).toBe("cancelled");
    expect((report.usage as JsonObject).reserved_tokens).toBe(0);
    expect(router.cancelled).toBe(1);
    expect(workflow.runtime.state).toEqual({});
    expect((report.audit as JsonObject[]).some((event) => event.action === "workflow.cancelled")).toBe(true);
  });

  it("cancel before run yields cancelled, and an instance is single-use", async () => {
    const pkg = await loadSource(sourceTree("meeting-agenda"));
    const { router, input } = fixtureAdapters(pkg);
    const workflow = await createWorkflow(pkg, { router });
    workflow.cancel();
    await expect(workflow.run(input)).rejects.toBeInstanceOf(CancelledError);
    expect(router.calls).toEqual([]);
    await expect(workflow.run(input)).rejects.toThrow(/single-use/u);
  });
});

describe("shipped archives", () => {
  it("the shipped Meeting Agenda archive is the source tree (same digest, same fixture result)", async () => {
    const shipped = await loadPackageBytes(readBytes(SHIPPED.meetingAgenda.archive));
    const source = await loadSource(sourceTree("meeting-agenda"));
    expect(shipped.digest).toBe(source.digest);
    expect(listMembers(readBytes(SHIPPED.meetingAgenda.archive)).has("signatures/publisher.json")).toBe(true);
    const a = await execute(shipped);
    const b = await execute(source);
    expect(a.output).toEqual(b.output);
    expect(a.usage).toEqual(b.usage);
  });

  it("a Files map variant of the archive is detected by the integrity re-check", async () => {
    const shipped = await loadPackageBytes(readBytes(SHIPPED.meetingAgenda.archive));
    const files: Files = new Map(shipped.files);
    files.set("README.md", new TextEncoder().encode("# changed"));
    await expect(createWorkflow({ ...shipped, files })).rejects.toThrow(ValidationError);
  });

  it("an undeclared tool approval is refused by the runtime, not ignored", async () => {
    const shipped = await loadPackageBytes(readBytes(SHIPPED.meetingAgenda.archive));
    await expect(createWorkflow(shipped, { approvedTools: ["not-a-tool"] })).rejects.toBeInstanceOf(PolicyError);
  });
});
