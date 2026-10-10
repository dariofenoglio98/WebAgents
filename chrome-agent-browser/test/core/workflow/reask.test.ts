/**
 * Up to two re-asks for an answer that is not accepted (D-151; amends D-115 and D-124): a schema
 * miss, an answer that is not JSON, or a refused answer check. The real bound router runs over a
 * scripted provider that replays Meeting Agenda's fixture and can be told to answer badly first.
 * A re-ask is the request plus one feedback line (byte for byte here), recounted, reserved afresh,
 * charged and audited; it is not sent when a bound, the context window or the deadline would stop
 * it; a replay router never re-asks.
 */
import { describe, expect, it } from "vitest";

import { canonicalString } from "../../../src/core/canonical.js";
import { fixtureAdapters } from "../../../src/core/fixtures.js";
import type { JsonObject, JsonValue } from "../../../src/core/json.js";
import type { RenderedRequest } from "../../../src/core/models/render.js";
import { BoundModelRouter, type ProviderAdapter, type ProviderCompletion } from "../../../src/core/models/router.js";
import type { Package } from "../../../src/core/package.js";
import { WorkflowError } from "../../../src/core/workflow/errors.js";
import { runWorkflow } from "../../../src/core/workflow/interpreter.js";
import { agendaFiles } from "../../helpers/agenda-checks.js";
import { change, loadSource } from "../../helpers/source-tree.js";
import { sessionGrants } from "../../helpers/workflow.js";

type Script = (task: string, attempt: number, answer: JsonValue) => string | null;

/** A provider that answers from the package's fixture, by task and exact input; `script` may replace an answer's text. */
class ReplayProvider implements ProviderAdapter {
  readonly provider_id = "test";
  readonly model_id = "replay";
  readonly host_model_id = "test/replay";
  readonly remote = true;
  readonly reasoning = true;
  readonly domains = ["model.test"];
  readonly pricing = null;
  readonly seen: Array<{ task: string; rendered: RenderedRequest }> = [];
  private readonly attempts = new Map<string, number>();

  constructor(
    private readonly cases: Record<string, Array<{ input: JsonValue; output: JsonValue }>>,
    private readonly script: Script,
    readonly context_window = 1_000_000,
    private readonly delayMs = 0,
  ) {}

  async complete(rendered: RenderedRequest, _max: number, signal: AbortSignal): Promise<ProviderCompletion> {
    const task = /## Task\n([^\n]+)/u.exec(rendered.system)![1]!;
    this.seen.push({ task, rendered });
    if (this.delayMs > 0) await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    if (signal.aborted) throw signal.reason;
    const data = canonicalString(JSON.parse(rendered.user) as JsonValue);
    const answer = this.cases[task]!.find((item) => canonicalString(item.input) === data)!.output;
    const key = `${task}:${data}`;
    const attempt = (this.attempts.get(key) ?? 0) + 1;
    this.attempts.set(key, attempt);
    return { text: this.script(task, attempt, answer) ?? JSON.stringify(answer), model_id: "test/replay", response_model: "replay", stop_reason: "stop", usage: { input_tokens: 100, output_tokens: 20 }, constrained: false, constraint_detail: "test" };
  }
}

async function run(pkg: Package, script: Script, options: { contextWindow?: number; delayMs?: number; deadlineAt?: number } = {}) {
  const { handlers, input } = fixtureAdapters(pkg);
  const fixture = pkg.files.get("fixtures/workflow.json")!;
  const cases = (JSON.parse(new TextDecoder().decode(fixture)) as JsonObject).models as Record<string, Array<{ input: JsonValue; output: JsonValue }>>;
  const provider = new ReplayProvider(cases, script, options.contextWindow ?? 1_000_000, options.delayMs ?? 0);
  const router = new BoundModelRouter(provider);
  try {
    const result = await runWorkflow(pkg, input, { router, handlers, grants: sessionGrants(pkg), approvedTools: [], ...(options.deadlineAt !== undefined ? { deadlineAt: options.deadlineAt } : {}) });
    return { provider, result, error: null, audit: result.audit as unknown as Array<Record<string, unknown>> };
  } catch (error) {
    return { provider, result: null, error: error as WorkflowError, audit: (error as WorkflowError).execution_report!.audit as Array<Record<string, unknown>> };
  }
}

const withOwner = (owner: string) => (answer: JsonValue) => {
  const copy = JSON.parse(JSON.stringify(answer)) as JsonObject;
  ((copy.agenda as JsonObject[])[1]!).owner = owner;
  return JSON.stringify(copy);
};
const DANA_LINE = 'The previous answer was not accepted: answer check 0 (relation) failed: missing_target_key at /owner for "Dana". Return the complete JSON document again, corrected.';
const events = (audit: Array<Record<string, unknown>>, task: string) => audit.filter((event) => event.task === task && ["model.count.called", "model.called", "model.failed", "model.completed", "model.retry_skipped"].includes(String(event.action)));

describe("re-asks with a named check (D-151)", () => {
  it("re-asks a refused check with the exact feedback line; the second answer is accepted, audited and charged", async () => {
    const pkg = await loadSource(agendaFiles());
    const { provider, result, audit } = await run(pkg, (task, attempt, answer) => (task === "write" && attempt === 1 ? withOwner("Dana")(answer) : null));
    expect(result!.status).toBe("completed");
    const writes = provider.seen.filter((call) => call.task === "write");
    expect(writes).toHaveLength(2);
    // The re-ask is the same request plus one last system section: the feedback line.
    expect(writes[1]!.rendered.system).toBe(`${writes[0]!.rendered.system}\n\n## Correction\n${DANA_LINE}`);
    expect(writes[1]!.rendered.user).toBe(writes[0]!.rendered.user);
    const trail = events(audit, "write");
    expect(trail.map((event) => [event.action, event.attempt ?? 1])).toEqual([
      ["model.count.called", 1],
      ["model.called", 1],
      ["model.failed", 1],
      ["model.count.called", 2],
      ["model.called", 2],
      ["model.completed", 1],
    ]);
    const failedCheck = { check: "answer_check", index: 0, kind: "relation", failure: "missing_target_key", row_key: "/owner", target_key: "/name" };
    expect(trail[2]).toMatchObject({ reason: "model_output_not_conforming", failed_check: failedCheck, tokens_charged: 120 });
    // The re-ask names what triggered it by the package's pointers, never by the value.
    expect(trail[4]!.after).toEqual({ output_failure: "check", failed_check: failedCheck });
    expect(trail[4]!.input_hash).not.toBe(trail[1]!.input_hash);
    expect((trail[4]!.reserved_tokens as number) - (trail[1]!.reserved_tokens as number)).toBe(new TextEncoder().encode(`\n\n## Correction\n${DANA_LINE}`).length);
    expect(JSON.stringify(audit)).not.toContain("Dana");
    // Every attempt is a remote call; the count is local (D-115).
    expect(((result!.usage.workers as JsonObject)["Writer:5"] as JsonObject).remote_calls).toBe(2);
  });

  it("asks three times in all, each re-ask naming the latest refusal, then fails the node as model_error", async () => {
    const pkg = await loadSource(agendaFiles());
    const owners = ["Dana", "Eve", "Finn"];
    const { provider, error, audit } = await run(pkg, (task, attempt, answer) => (task === "write" ? withOwner(owners[attempt - 1]!)(answer) : null));
    expect(error).toBeInstanceOf(WorkflowError);
    expect([error!.code, error!.node_id]).toEqual(["model_error", "write"]);
    const feedback = provider.seen.filter((call) => call.task === "write").map((call) => call.rendered.system.split("## Correction\n")[1] ?? null);
    expect(feedback).toEqual([null, DANA_LINE, DANA_LINE.replace('"Dana"', '"Eve"')]);
    const trail = events(audit, "write");
    expect(trail.filter((event) => event.action === "model.called").map((event) => event.attempt ?? 1)).toEqual([1, 2, 3]);
    expect(trail.filter((event) => event.action === "model.failed")).toHaveLength(3);
    expect(trail.some((event) => event.action === "model.retry_skipped")).toBe(false);
  });

  it("a re-ask that would pass a token bound is not sent: model.retry_skipped, and the node fails with the refused answer (D-124)", async () => {
    // Measure one write reservation, then give Writer exactly enough for the first answer (reported
    // 120) and one re-ask (the reservation plus its feedback section), so the second re-ask cannot fit.
    const probe = await run(await loadSource(agendaFiles()), () => null);
    const reservation = probe.audit.find((event) => event.action === "model.called" && event.task === "write")!.reserved_tokens as number;
    const section = new TextEncoder().encode(`\n\n## Correction\n${DANA_LINE}`).length;
    const limit = 120 + reservation + section + 50;
    const tight = agendaFiles();
    change(tight, "graph.json", (graph) => {
      const writer = (graph.workers as JsonObject[]).find((worker) => worker.id === "Writer")!;
      (writer.budget as JsonObject).tokens = limit;
    });
    const { error, audit } = await run(await loadSource(tight), (task, _attempt, answer) => (task === "write" ? withOwner("Dana")(answer) : null));
    expect([error!.code, error!.node_id]).toEqual(["model_error", "write"]);
    const trail = events(audit, "write");
    expect(trail.filter((event) => event.action === "model.called")).toHaveLength(2);
    expect(trail.find((event) => event.action === "model.retry_skipped")).toMatchObject({ attempt: 3, reason: "budget", bound: "worker_token_budget", reserved_tokens: reservation + section, used_tokens: 240, held_tokens: 0, limit });
    expect(audit.some((event) => event.action === "model.refused")).toBe(false);
  });

  it("a re-ask that would pass the context window is not sent", async () => {
    // Meeting Agenda's tasks need 16,000 tokens of context; a larger write cap puts the write
    // reservation above that, and the window just above the reservation.
    const files = agendaFiles();
    change(files, "graph.json", (graph) => {
      ((graph.nodes as JsonObject[]).find((node) => node.id === "write")!).max_output_tokens = 16000;
    });
    const probe = await run(await loadSource(files), () => null);
    const reservation = probe.audit.find((event) => event.action === "model.called" && event.task === "write")!.reserved_tokens as number;
    const { error, audit } = await run(await loadSource(files), (task, _attempt, answer) => (task === "write" ? withOwner("Dana")(answer) : null), { contextWindow: reservation + 10 });
    expect([error!.code, error!.node_id]).toEqual(["model_error", "write"]);
    expect(events(audit, "write").find((event) => event.action === "model.retry_skipped")).toMatchObject({ attempt: 2, reason: "context_window", context_window: reservation + 10 });
  });

  it("a re-ask the deadline would likely cut is not sent: less time is left than the refused attempt took", async () => {
    const files = agendaFiles();
    change(files, "graph.json", (graph) => {
      ((graph.nodes as JsonObject[]).find((node) => node.id === "write")!).timeout_seconds = 0.75;
    });
    const { error, audit } = await run(await loadSource(files), (task, _attempt, answer) => (task === "write" ? withOwner("Dana")(answer) : null), { delayMs: 400 });
    expect([error!.code, error!.node_id]).toEqual(["model_error", "write"]);
    const skipped = events(audit, "write").find((event) => event.action === "model.retry_skipped")!;
    expect(skipped).toMatchObject({ attempt: 2, reason: "deadline" });
    expect(skipped.remaining_ms as number).toBeLessThan(skipped.last_attempt_ms as number);
  });

  it("the host's own run deadline counts too: a re-ask the run would not outlive is not sent, whatever the node allows", async () => {
    const pkg = await loadSource(agendaFiles());
    const { error, audit } = await run(pkg, (task, _attempt, answer) => (task === "plan" ? JSON.stringify({ focus: ["a", "a"] }) : JSON.stringify(answer)), { delayMs: 300, deadlineAt: Date.now() + 450 });
    expect([error!.code, error!.node_id]).toEqual(["model_error", "plan"]);
    expect(events(audit, "plan").find((event) => event.action === "model.retry_skipped")).toMatchObject({ attempt: 2, reason: "deadline" });
  });

  it("re-asks a schema miss, naming the keyword, where in the answer, and the missing property", async () => {
    const pkg = await loadSource(agendaFiles({ checks: false }));
    const { provider, result, audit } = await run(pkg, (task, attempt, answer) => {
      if (task !== "write" || attempt !== 1) return null;
      const copy = JSON.parse(JSON.stringify(answer)) as JsonObject;
      delete ((copy.agenda as JsonObject[])[1]!).owner;
      return JSON.stringify(copy);
    });
    expect(result!.status).toBe("completed");
    const re = provider.seen.filter((call) => call.task === "write")[1]!.rendered.system.split("## Correction\n")[1];
    expect(re).toBe("The previous answer was not accepted: it does not match the output schema: required at /agenda/1 (missing: owner). Return the complete JSON document again, corrected.");
    expect(events(audit, "write").find((event) => event.action === "model.called" && event.attempt === 2)!.after).toMatchObject({ output_failure: "schema", schema_keyword: "required" });
  });

  it("re-asks an answer that is not JSON", async () => {
    const { provider, result } = await run(await loadSource(agendaFiles({ checks: false })), (task, attempt) => (task === "plan" && attempt === 1 ? "Here is the plan: focus on scope." : null));
    expect(result!.status).toBe("completed");
    expect(provider.seen.filter((call) => call.task === "plan")[1]!.rendered.system.endsWith("## Correction\nThe previous answer was not accepted: it is not one JSON document. Return the complete JSON document again, corrected.")).toBe(true);
  });

  it("repeats only values the model was given or wrote: a duplicate key from the package's own literal stays unnamed", async () => {
    const literalDuplicate = { kind: "relation", rows: { from: "result", path: "/agenda" }, targets: { literal: [{ name: "Zed" }, { name: "Zed" }] }, row_key: "/owner", target_key: "/name" };
    const pkg = await loadSource(agendaFiles({ checks: false, graph: (nodes) => (nodes.write!.checks = [literalDuplicate]) }));
    const { provider, error } = await run(pkg, () => null);
    expect([error!.code, error!.node_id]).toEqual(["model_error", "write"]);
    const lines = provider.seen.filter((call) => call.task === "write").slice(1).map((call) => call.rendered.system.split("## Correction\n")[1]);
    expect(lines).toEqual(Array(2).fill("The previous answer was not accepted: answer check 0 (relation) failed: duplicate_target_key at /name. Return the complete JSON document again, corrected."));
  });

  it("a replay router never re-asks: the refused answer fails the node at once, as in the reference", async () => {
    const pkg = await loadSource(agendaFiles({ fixture: (fixture) => {
      ((((fixture.models as Record<string, Array<{ output: JsonObject }>>).write![0]!.output.agenda) as JsonObject[])[1]!).owner = "Dana";
    } }));
    const { router, handlers, input } = fixtureAdapters(pkg);
    const error = await runWorkflow(pkg, input, { router, handlers, grants: sessionGrants(pkg), approvedTools: [] }).then(() => null, (caught: unknown) => caught as WorkflowError);
    expect([error!.code, error!.node_id]).toEqual(["model_error", "write"]);
    const audit = error!.execution_report!.audit as Array<Record<string, unknown>>;
    expect(audit.filter((event) => event.action === "model.called" && event.task === "write")).toHaveLength(1);
    expect(audit.some((event) => "attempt" in event)).toBe(false);
  });
});
