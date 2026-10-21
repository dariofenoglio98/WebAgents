/**
 * conversation.v0 on the Chrome core (T24): the runner, the chain, the consent host and the gate,
 * as `test_conversation_runtime.py` asserts them on the reference.
 */
import { describe, expect, it } from "vitest";

import { AuditChain } from "../../../src/core/conversation/chain.js";
import { conversationRecords, validateTranscriptDocument } from "../../../src/core/conversation/declarations.js";
import { checkDecision, TranscriptConsent, type ConsentHost, type ConsentRequest } from "../../../src/core/conversation/host.js";
import { Conversation, type ConversationReport } from "../../../src/core/conversation/runner.js";
import { readInputTranscript, type TranscriptInput } from "../../../src/core/conversation/transcript.js";
import { ValidationError } from "../../../src/core/errors.js";
import { verifyAuditChain } from "../../../src/core/execution/report.js";
import { evaluateSnapshot, evaluationLayers, publisherReport } from "../../../src/core/evaluation.js";
import { fixtureAdapters } from "../../../src/core/fixtures.js";
import type { JsonObject } from "../../../src/core/json.js";
import { inspectPackage, loadPackageBytes, type Package } from "../../../src/core/package.js";
import { buildSummary } from "../../../src/core/summary.js";
import { MemoryTrustStorage, TrustStore } from "../../../src/core/trust.js";
import { PolicyError } from "../../../src/core/workflow/errors.js";
import { Workflow } from "../../../src/core/workflow/interpreter.js";
import { Runtime, type TurnContext } from "../../../src/core/workflow/runtime.js";
import { PackageSchemas } from "../../../src/core/schema.js";
import { grants, message, probeBytes, probePackage, transcript, VARIANTS } from "../../helpers/conversation-package.js";

const CONVERSATION_ID = "00000000-0000-4000-8000-000000000000";

async function probe(mutate: ((m: Parameters<(typeof VARIANTS)[string]>[0]) => void) | null = null): Promise<Package> {
  return (await probePackage({ mutate })).pkg;
}

async function run(pkg: Package, document: TranscriptInput, options: { decisions?: Record<string, "once" | "session" | "always" | "deny">; limits?: Record<string, number> } = {}): Promise<ConversationReport> {
  const { router, handlers } = fixtureAdapters(pkg);
  const conversation = new Conversation(pkg, { grants: options.decisions ?? grants(), approvedTools: ["place"], adapters: () => ({ router, handlers }), limits: (options.limits as never) ?? null });
  return conversation.run(document);
}

const actions = (report: ConversationReport, predicate: (event: JsonObject) => boolean = () => true) => (report.audit as unknown as JsonObject[]).filter(predicate);

describe("the conversation runner", () => {
  it("two turns persist state and continue one chain (V-4, V-5, V-17, V-23)", async () => {
    const pkg = await probe();
    const result = await run(pkg, transcript([["order A", { confirm: true }], "done"]));
    expect(result.status).toBe("completed");
    expect(result.state).toEqual({ history: [{ text: "order A", intent: "order" }, { text: "done", intent: "done" }], orders: [{ order_id: "TD-0001", show: "Show A", quantity: 1, total_usd: 40 }] });
    const audit = result.audit as unknown as JsonObject[];
    const chain = verifyAuditChain(audit);
    expect(chain.valid).toBe(true);
    expect(chain.events).toBe(audit.length);
    expect(audit.map((event) => event.sequence)).toEqual(audit.map((_, index) => index + 1));
    const conversationId = String(result.provenance.conversation_id);
    expect(new Set(audit.map((event) => event.conversation_id))).toEqual(new Set([conversationId]));
    const level = audit.filter((event) => event.run_id === conversationId).map((event) => [event.turn, event.action]);
    expect(level).toEqual([
      [0, "conversation.started"],
      [1, "turn.started"],
      [1, "turn.completed"],
      [2, "turn.started"],
      [2, "turn.completed"],
      [2, "conversation.ended"],
    ]);
    const turnRuns = new Map(audit.filter((event) => event.action === "runtime.started").map((event) => [event.turn, event.run_id]));
    expect(new Set(turnRuns.values()).size).toBe(2);
    expect([...turnRuns.keys()].sort()).toEqual([1, 2]);
    const first = audit.filter((event) => event.turn === 1).map((event) => String(event.action));
    expect(first.indexOf("consent.requested")).toBeLessThan(first.indexOf("consent.decided"));
    expect(first.indexOf("consent.decided")).toBeLessThan(first.indexOf("tool.called"));
    const requested = audit.find((event) => event.action === "consent.requested")!;
    for (const key of ["step", "permissions", "text_sha256", "facts_hash", "timeout_seconds"]) expect(requested).toHaveProperty(key);
    expect(JSON.stringify(audit)).not.toContain("Order one ticket");
    const decided = audit.find((event) => event.action === "consent.decided")!;
    expect(decided.accepted).toBe(true);
    expect(decided.decided_by).toBe("transcript");
    await validateTranscriptDocument(result.transcript, "output", "transcript");
    const turns = result.transcript.turns as JsonObject[];
    const decision = (turns[0]!.decisions as JsonObject[])[0]!;
    expect(decision.text).toBe("Order one ticket to Show A?");
    expect(decision.facts).toEqual({ show: "Show A", quantity: 1 });
    expect(turns[1]!.decisions).toEqual([]);
    expect(turns[1]!.unused_consents).toEqual([]);
    expect((result.transcript.ended as JsonObject).reason).toBe("package");
    expect(((result.transcript.budget as JsonObject).spent as JsonObject).turns).toBe(2);
    expect(result.ended.turns_not_run).toBe(0);
  });

  it("a failed turn persists nothing and the conversation goes on (V-5, V-25, V-30)", async () => {
    const pkg = await probe(VARIANTS["consent-text-not-string"]!);
    const result = await run(pkg, transcript([["order A", { confirm: true }], "hello"]));
    const turns = result.transcript.turns as JsonObject[];
    expect(turns.map((turn) => turn.status)).toEqual(["failed", "completed"]);
    expect(turns[0]!.error_code).toBe("schema_validation");
    expect(result.state.history).toEqual([{ text: "hello", intent: "chat" }]);
    const failed = actions(result, (event) => event.action === "turn.failed");
    expect(failed.length).toBe(1);
    expect(failed[0]!.error_code).toBe("schema_validation");
    expect(result.status).toBe("failed");
  });

  it("the end reasons (V-25, V-30)", async () => {
    const pkg = await probe();
    expect((await run(pkg, transcript(["hello"], true))).ended.reason).toBe("person");
    expect((await run(pkg, transcript(["hello"]))).ended.reason).toBe("host");
    const byPackage = await run(pkg, transcript(["done", "hello"]));
    expect(byPackage.ended.reason).toBe("package");
    expect(byPackage.ended.turns_not_run).toBe(1);
    expect((byPackage.transcript.turns as unknown[]).length).toBe(1);
    const cap = await run(pkg, transcript(["hello", "hello", "hello", "hello"]));
    expect(cap.ended.reason).toBe("max_turns");
    expect(cap.ended.turns_not_run).toBe(0);
    const beyond = await run(pkg, transcript(["hello", "hello", "hello", "hello", "hello"]));
    expect((beyond.transcript.turns as JsonObject[]).at(-1)!.status).toBe("refused");
    expect(beyond.ended.reason).toBe("max_turns");
    expect(beyond.ended.turns_not_run).toBe(1);
    expect(cap.status).toBe("completed");
    expect(beyond.status).toBe("completed");
    const nothing = await run(pkg, transcript(["hello"]), { limits: { conversation_max_turns: 0 } });
    expect((nothing.transcript.turns as JsonObject[]).map((turn) => turn.status)).toEqual(["refused"]);
    expect(nothing.status).toBe("failed");
    expect(nothing.ended.reason).toBe("max_turns");
  });

  it("host inputs are checked before the chain starts (D-265)", async () => {
    const pkg = await probe();
    const { router, handlers } = fixtureAdapters(pkg);
    const build = (options: Partial<ConstructorParameters<typeof Conversation>[1]> = {}) => new Conversation(pkg, { grants: grants(), approvedTools: ["place"], adapters: () => ({ router, handlers }), ...options });
    for (const [bad, expected] of [
      [{ grants: grants({ "orders.place": "forever" }) }, /Grant must be/u],
      [{ grants: { ...grants(), "orders.other": "session" } }, /undeclared permission/u],
      [{ approvedTools: ["place", "nope"] }, /does not declare/u],
      [{ limits: { conversation_max_turn: 1 } }, /Unsupported host limit/u],
      [{ limits: { hard_tokens: -1 } }, /nonnegative/u],
      [{ limits: { conversation_total_tokens: "many" } }, /nonnegative/u],
    ] as const) {
      expect(() => build(bad as never)).toThrow(expected);
      try {
        build(bad as never);
      } catch (error) {
        expect(error).toBeInstanceOf(PolicyError);
      }
    }
    expect(build().chain.events).toEqual([]);
  });

  it("host limits only lower the conversation budget (V-11)", async () => {
    const pkg = await probe();
    const result = await run(pkg, transcript(["hello", "hello"]), { limits: { conversation_max_turns: 9, conversation_total_tokens: 7000, hard_tokens: 3000 } });
    const limits = (result.transcript.budget as JsonObject).limits as JsonObject;
    expect(limits.max_turns).toBe(4);
    expect(limits.hard_tokens).toBe(7000);
    expect((result.transcript.turns as JsonObject[]).map((turn) => turn.status)).toEqual(["completed", "completed"]);
    await expect(run(pkg, transcript(["hello"]), { limits: { conversation_max_turns: -1 } })).rejects.toThrow(/conversation_max_turns/u);
  });

  it("once is spent once per conversation and the plan is never widened (V-12, V-13)", async () => {
    const pkg = await probe();
    const result = await run(pkg, transcript([["order A", { confirm: true }], ["order B", { confirm: true }]]), { decisions: grants({ "orders.place": "once" }) });
    const turns = result.transcript.turns as JsonObject[];
    expect(turns.map((turn) => turn.status)).toEqual(["completed", "completed"]);
    expect(result.status).toBe("completed");
    expect(result.transcript.spent_permissions).toEqual(["orders.place"]);
    const started = actions(result, (event) => event.action === "runtime.started");
    expect(started[1]!.spent_permissions).toEqual(["orders.place"]);
    const decided = actions(result, (event) => event.action === "consent.decided").map((event) => [event.turn, event.accepted, event.decided_by, event.reason]);
    expect(decided).toEqual([
      [1, true, "transcript", null],
      [2, false, "plan", "permission_consumed"],
    ]);
    expect(turns[1]!.unused_consents).toEqual(["confirm"]);
    expect((turns[1]!.reply as JsonObject).order).toBeNull();
    expect(actions(result, (event) => event.action === "tool.called").length).toBe(1);
    expect((result.state.orders as unknown[]).length).toBe(1);
    const denied = await run(pkg, transcript([["order A", { confirm: false }], "done"]), { decisions: grants({ "orders.place": "deny" }) });
    const first = actions(denied, (event) => event.action === "consent.decided")[0]!;
    expect(first.decided_by).toBe("plan");
    expect(first.reason).toBe("permission_denied");
    expect(actions(denied, (event) => event.action === "tool.called")).toEqual([]);
    expect((denied.transcript.turns as JsonObject[])[0]!.unused_consents).toEqual(["confirm"]);
  });

  it("a denied step is never asked, a spent once step is never asked, and a host answer is checked (V-12, V-13, N-38)", async () => {
    const pkg = await probe();
    const asked: string[] = [];
    class Eager implements ConsentHost {
      readonly used = new Set<string>();
      async decide(request: ConsentRequest): Promise<unknown> {
        asked.push(request.step);
        return { accepted: true, decided_by: "person", reason: null };
      }
    }
    const paths = (pkg.manifest.schemas as JsonObject[]).map((entry) => String(entry.path));
    const node = (pkg.graph.nodes as JsonObject[]).find((item) => item.type === "consent")!;
    const context = (turn: number, spent: string[] = []): TurnContext => ({ conversation_id: CONVERSATION_ID, turn, state: { history: [], orders: [] }, chain: new AuditChain(CONVERSATION_ID), consent: new Eager(), spent: new Set(spent) });
    const token = { signal: new AbortController().signal } as never;
    const withRuntime = async (decisions: Record<string, "once" | "session" | "always" | "deny">, turn: TurnContext, work: (runtime: Runtime) => Promise<void>) => {
      const schemas = await PackageSchemas.open(pkg.files, paths);
      try {
        await work(new Runtime(pkg, schemas, { grants: decisions, turn }));
      } finally {
        schemas.close();
      }
    };
    await withRuntime(grants({ "orders.place": "deny" }), context(1), async (runtime) => {
      const decision = await runtime.callConsent(runtime.coordinatorContext(), node, { show: "A" }, "Order?", token);
      expect(decision).toEqual({ accepted: false });
      expect(asked).toEqual([]);
      const decided = (runtime.audit as unknown as JsonObject[]).find((event) => event.action === "consent.decided")!;
      expect(decided.decided_by).toBe("plan");
      expect(decided.reason).toBe("permission_denied");
    });
    await withRuntime(grants({ "orders.place": "once" }), context(2, ["orders.place"]), async (runtime) => {
      const decision = await runtime.callConsent(runtime.coordinatorContext(), node, { show: "A" }, "Order?", token);
      expect(decision).toEqual({ accepted: false });
      expect(asked).toEqual([]);
      const decided = (runtime.audit as unknown as JsonObject[]).find((event) => event.action === "consent.decided")!;
      expect(decided.decided_by).toBe("plan");
      expect(decided.reason).toBe("permission_consumed");
    });
    await withRuntime(grants({ "orders.place": "once" }), context(2), async (runtime) => {
      await runtime.callConsent(runtime.coordinatorContext(), node, { show: "A" }, "Order?", token);
      expect(asked).toEqual(["confirm"]);
    });
    expect(checkDecision({ accepted: true, decided_by: "person" })).toEqual({ accepted: true, decided_by: "person", reason: null });
    for (const bad of [
      { accepted: "yes", decided_by: "person" },
      { accepted: true, decided_by: "nobody" },
      { accepted: true, decided_by: "person", reason: "not a code" },
      { accepted: true, decided_by: "person", reason: "Upper" },
      { accepted: true, decided_by: "person", extra: 1 },
      // A host never answers as the plan: that provenance is the runtime's own (T23 review 2, nit 4).
      { accepted: false, decided_by: "plan", reason: "permission_denied" },
    ]) {
      expect(() => checkDecision(bad)).toThrow(/consent_decision_invalid/u);
    }
  });

  it("a plain run refuses a conversational package and a turn needs one (V-28)", async () => {
    const pkg = await probe();
    await expect(Workflow.create(pkg, { grants: grants() })).rejects.toThrow(/^conversation_turn_required/u);
    const plain = await probe(VARIANTS.plain!);
    const chain = new AuditChain(CONVERSATION_ID);
    await expect(Workflow.create(plain, { grants: grants(), turn: { conversation_id: CONVERSATION_ID, turn: 1, state: {}, chain, consent: new TranscriptConsent({}) } })).rejects.toThrow(/^conversation_turn_unexpected/u);
  });

  it("inspect and the control-plane summary describe the conversation (V-20)", async () => {
    const { bytes } = await probeBytes();
    const pkg = await loadPackageBytes(bytes);
    const records = conversationRecords(pkg)!;
    expect(records.persistent_keys).toEqual(["history", "orders"]);
    expect(records.consent_steps).toEqual([{ id: "confirm", permissions: ["orders.place"], timeout_seconds: 30, conditional: true, depends_on: ["interpret"] }]);
    expect(records.gated_permissions).toEqual({ "orders.place": ["confirm"] });
    expect((inspectPackage(pkg) as JsonObject).conversation ?? null).toEqual(records);
    const evaluation = await evaluateSnapshot(bytes);
    const publisher = await publisherReport(pkg, new TrustStore(new MemoryTrustStorage()));
    const summary = await buildSummary(pkg, { evaluation: evaluationLayers(evaluation), publisher });
    expect(summary.workflow.conversation).toEqual(records);
    const words = summary.warnings.find((warning) => warning.code === "conversational_package")!;
    expect(words.message).toContain("at most 4 turns");
    expect(words.message).toContain("confirm (before orders.place)");
    const consentNode = (summary.workflow.nodes as JsonObject[]).find((item) => item.type === "consent")!;
    expect(consentNode.permissions).toEqual(["orders.place"]);
  });

  it("a tampered chain is found (N-40)", async () => {
    const pkg = await probe();
    const result = await run(pkg, transcript([["order A", { confirm: true }], "done"]));
    const audit = JSON.parse(JSON.stringify(result.audit)) as JsonObject[];
    const decided = audit.find((event) => event.action === "consent.decided")!;
    decided.accepted = false;
    const report = verifyAuditChain(audit);
    expect(report.valid).toBe(false);
    expect(report.broken[0]!.reason).toBe("event_hash");
    const cut = (result.audit as unknown as JsonObject[]).filter((event) => !String(event.action).startsWith("consent."));
    expect(verifyAuditChain(cut).valid).toBe(false);
  });

  it("the input transcript reader refuses an output transcript (V-14)", async () => {
    const pkg = await probe();
    const result = await run(pkg, transcript(["hello"]));
    await expect(readInputTranscript(result.transcript, "out.json")).rejects.toBeInstanceOf(ValidationError);
    expect((await readInputTranscript(transcript(["hello"], true), "in.json")).end).toBe(true);
    expect(message("x")).toEqual({ text: "x" });
  });
});
