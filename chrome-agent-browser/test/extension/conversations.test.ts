/**
 * Conversations from the browser (T24, conversation.v0, D-270, D-271): the ticket-desk probe as a
 * conversational package opened from a test origin, authorized, and talked to through the service
 * worker: a turn reaches its consent card, the person answers (by message, or through the record
 * when the message is lost), the order is placed, a second turn ends the conversation by the
 * package's rule; one chain across the turns; the export; a card that times out; `once` spent by
 * the conversation and refused to a second conversation; a turn interrupted by a restart; the
 * Convenience preset answering a step the floor does not protect; `run.start` refusing a
 * conversation.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { verifyAuditChain } from "../../src/core/execution/report.js";
import type { JsonObject } from "../../src/core/json.js";
import { publicKeyToPem } from "../../src/core/keys.js";
import { TransportError, type HttpRequest, type HttpTransport } from "../../src/core/models/transport.js";
import { POLICY_BUNDLE_TYPE } from "../../src/core/signed-document.js";
import type { AuthorizeResult, ConversationExportBundle, ConversationListView, ConversationView, RunListView, RunView, SessionView, SettingsView } from "../../src/extension/messages.js";
import { MemoryConversationStore } from "../../src/extension/storage/conversations.js";
import { MemoryRunStore } from "../../src/extension/storage/runs.js";
import { MESSAGES, node, ORDERS, probeBytes, type Members } from "../helpers/conversation-package.js";
import { scriptedOllama, type SeenRequest } from "../helpers/host.js";
import { ROOT } from "../helpers/paths.js";
import { makeHarness, PACKAGE_MEDIA_TYPE, PAGE, webairRoutes, type Harness, type Route } from "../helpers/shell.js";
import { newSigner, signedBytes } from "../helpers/signing.js";

const DESK_URL = "https://desk.example.org/agent.pkg";
const QWEN = "ollama/qwen3:30b";
const POLICY_CONTENT = JSON.parse(readFileSync(resolve(ROOT, "examples/policies/webagents-research.content.json"), "utf8")) as JsonObject;
const GRANTS = { "model.reasoning": "session", "memory.session": "session", "orders.place": "session", "network.desk": "session" };

/** The desk's origin: one POST answers an order from the probe's table. */
function scriptedDesk(seen: SeenRequest[] = [], gate: Promise<void> | null = null): HttpTransport {
  return async (request: HttpRequest) => {
    seen.push({ url: request.url, method: request.method, body: request.body, headers: { ...request.headers } });
    // A desk that has taken the order and not answered yet (the turn is cut off mid-call).
    if (gate !== null) await gate;
    const url = new URL(request.url);
    if (url.pathname !== "/api/orders") return { status: 404, headers: { "content-type": "application/json" }, body: JSON.stringify({ error: { code: "not_found", message: "no", details: [] } }) };
    const args = JSON.parse(request.body ?? "{}") as { show: string; quantity: number };
    const order = ORDERS.find(([show, quantity]) => show === args.show && quantity === args.quantity);
    if (!order) throw new TransportError("no such order", { stage: "transport" });
    return { status: 200, headers: { "content-type": "application/json" }, body: JSON.stringify(order[2]) };
  };
}

interface World {
  h: Harness;
  session: SessionView;
  modelSeen: SeenRequest[];
  deskSeen: SeenRequest[];
}

async function world(options: { mutate?: ((m: Members) => void) | null; runs?: MemoryRunStore; conversations?: MemoryConversationStore; preset?: "privacy-first" | "balanced" | "convenience"; decideLost?: boolean; limits?: Record<string, number>; deskGate?: Promise<void>; modelGate?: Promise<void>; routes?: Record<string, Route> } = {}): Promise<World> {
  const { bytes, key } = await probeBytes({ remoteTool: true, mutate: options.mutate ?? null });
  const scripted = scriptedOllama({ interpret: (user) => MESSAGES[String((user as { text: string }).text)]! });
  // A model that has the request and has not answered yet (the turn is in flight).
  const gate = options.modelGate ?? null;
  const asked: SeenRequest[] = [];
  const model =
    gate === null
      ? scripted
      : {
          seen: asked,
          transport: (async (request: HttpRequest) => {
            asked.push({ url: request.url, method: request.method, body: request.body, headers: { ...request.headers } });
            await gate;
            return scripted.transport(request);
          }) as HttpTransport,
        };
  const deskSeen: SeenRequest[] = [];
  const routes = { ...webairRoutes(), ...(options.routes ?? {}), [DESK_URL]: { headers: { "content-type": PACKAGE_MEDIA_TYPE, "content-length": String(bytes.length) }, body: bytes } };
  const h = makeHarness({ routes, transports: { model: model.transport, tool: scriptedDesk(deskSeen, options.deskGate ?? null) }, runs: options.runs, conversations: options.conversations });
  h.host.decideLost = options.decideLost === true;
  const view = (await h.controller.handle({ type: "package.open", url: DESK_URL, advertisedOn: "https://desk.example.org/", viewId: "test" }, PAGE)) as SessionView;
  await h.controller.handle({ type: "trust.pinKey", publicKeyPem: publicKeyToPem(key.publicKey), displayName: "Example desk", publisherId: "example" }, PAGE);
  const current = (await h.controller.handle({ type: "settings.get" }, PAGE)) as SettingsView;
  const settings = current.settings;
  settings.models.default_model = QWEN;
  if (options.preset) settings.preset = options.preset;
  // Settings → Run limits: the browser's per-run bounds.
  if (options.limits) settings.limits = { ...(settings.limits ?? {}), ...options.limits } as typeof settings.limits;
  await h.controller.handle({ type: "settings.set", settings }, PAGE);
  const session = (await h.controller.handle({ type: "package.get", sessionId: view.session.id }, PAGE)) as SessionView;
  return { h, session, modelSeen: model.seen, deskSeen };
}

async function authorize(w: World, decisions: Record<string, string> = GRANTS): Promise<AuthorizeResult> {
  const result = (await w.h.controller.handle({ type: "authorization.authorize", sessionId: w.session.session.id, packageDigest: w.session.summary.package.digest as string, decisions, toolApprovals: { place: true }, resourceSelections: {}, provenance: null, prepare: true }, PAGE)) as AuthorizeResult;
  expect(result.run_plan?.preflight.ready, JSON.stringify(result.plan_refused)).toBe(true);
  return result;
}

async function start(w: World, result: AuthorizeResult): Promise<ConversationView> {
  const plan = result.run_plan!.run_plan;
  return (await w.h.controller.handle({ type: "conversation.start", sessionId: w.session.session.id, runPlanId: plan.run_plan_id, runPlanSha256: plan.run_plan_sha256 }, PAGE)) as ConversationView;
}

const get = (w: World, conversationId: string) => w.h.controller.handle({ type: "conversation.get", conversationId }, PAGE) as Promise<ConversationView>;
const send = (w: World, conversationId: string, text: string) => w.h.controller.handle({ type: "conversation.send", conversationId, message: { text } }, PAGE) as Promise<ConversationView>;

/** Poll the worker until the view satisfies the predicate (the host runs in this process, so the record changes between awaits). */
async function waitFor(w: World, conversationId: string, predicate: (view: ConversationView) => boolean, label: string, timeoutMs = 10_000): Promise<ConversationView> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const view = await get(w, conversationId);
    if (view !== null && predicate(view)) return view;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** The card the turn waits on, once the host wrote it. */
const card = (w: World, conversationId: string) => waitFor(w, conversationId, (view) => view.pendingConsent !== null, "the consent card");

async function settled(w: World, conversationId: string): Promise<ConversationView> {
  await w.h.host.drain();
  return waitFor(w, conversationId, (view) => view.activeRunId === null, "the turn settled");
}

describe("a conversation from the browser", () => {
  it("talks across two turns: the card asked and accepted by the person, the order placed, the conversation ended by the package; one chain; the export (D-270, D-272)", async () => {
    const w = await world();
    const result = await authorize(w);
    expect(result.run_plan!.run_plan.execution.conversation).toMatchObject({ max_turns: 4, persistent_keys: ["history", "orders"], consent_steps: [{ id: "confirm", permissions: ["orders.place"], kinds: ["payment"], pre_decided: null }], gated_permissions: { "orders.place": ["confirm"] } });
    const started = await start(w, result);
    expect(started).toMatchObject({ status: "open", turns: 0, activeRunId: null, pendingConsent: null, limits: { max_turns: 4 }, persistentKeys: ["history", "orders"] });
    expect(started.state).toEqual({ history: [], orders: [] });
    // A conversation is not a task: `run.start` refuses the conversational plan (V-28).
    await expect(w.h.controller.handle({ type: "run.start", sessionId: w.session.session.id, runPlanId: result.run_plan!.run_plan.run_plan_id, runPlanSha256: result.run_plan!.run_plan.run_plan_sha256, input: { text: "order A" } }, PAGE)).rejects.toMatchObject({ code: "conversation_profile" });
    const sent = await send(w, started.conversationId, "order A");
    expect(sent.activeRunId).not.toBeNull();
    expect(sent.title).toBe("order A");
    const waiting = await card(w, started.conversationId);
    expect(waiting.pendingConsent).toMatchObject({ step: "confirm", permissions: ["orders.place"], kinds: ["payment"], text: "Order one ticket to Show A?", facts: { show: "Show A", quantity: 1 }, timeout_seconds: 30 });
    expect(waiting.activeRun).toMatchObject({ status: "running", conversation: { conversationId: started.conversationId, turn: 1 } });
    // Not answered yet: the desk was not called.
    expect(w.deskSeen).toHaveLength(0);
    await w.h.controller.handle({ type: "conversation.decide", conversationId: started.conversationId, step: "confirm", accepted: true }, PAGE);
    const first = await settled(w, started.conversationId);
    expect(first.status).toBe("open");
    expect(first.transcript).toHaveLength(1);
    const turn = first.transcript[0]!;
    expect(turn).toMatchObject({ turn: 1, status: "completed", error_code: null, message: { text: "order A" }, consents: { confirm: true }, unused_consents: [] });
    expect(turn.decisions).toEqual([expect.objectContaining({ step: "confirm", permissions: ["orders.place"], accepted: true, decided_by: "person", reason: null, text: "Order one ticket to Show A?", facts: { show: "Show A", quantity: 1 } })]);
    expect((turn.reply as JsonObject).order).toEqual({ order_id: "TD-0001", show: "Show A", quantity: 1, total_usd: 40 });
    expect(first.state).toEqual({ history: [{ text: "order A", intent: "order" }], orders: [{ order_id: "TD-0001", show: "Show A", quantity: 1, total_usd: 40 }] });
    expect(first.spent.tool_calls).toEqual({ place: 1 });
    expect(first.spent.tokens).toBeGreaterThan(0);
    // The turn's own record verifies its audit as a slice of the conversation's chain (V-17).
    const turnRun = (await w.h.controller.handle({ type: "run.get", runId: turn.run_id! }, PAGE)) as RunView;
    expect(turnRun.audit?.chainValid).toBe(true);
    expect(w.deskSeen).toHaveLength(1);
    // The second turn: the package ends the conversation (V-8).
    await send(w, started.conversationId, "done");
    const ended = await settled(w, started.conversationId);
    expect(ended).toMatchObject({ status: "ended", outcome: "completed", turns: 2, ended: { reason: "package", turns_not_run: 0 } });
    expect(ended.transcript[1]).toMatchObject({ turn: 2, status: "completed", decisions: [], reply: { intent: "done" } });
    expect(ended.state.history).toEqual([
      { text: "order A", intent: "order" },
      { text: "done", intent: "done" },
    ]);
    // The views learned of every change; the Runs page lists the turns under their conversation.
    const list = (await w.h.controller.handle({ type: "conversation.list", sessionId: w.session.session.id }, PAGE)) as ConversationListView;
    expect(list.conversations).toEqual([expect.objectContaining({ conversationId: started.conversationId, status: "ended", turns: 2, title: "order A" })]);
    const runs = (await w.h.controller.handle({ type: "run.list", sessionId: w.session.session.id }, PAGE)) as RunListView;
    expect(runs.runs.map((run) => run.conversation).sort((a, b) => a!.turn - b!.turn)).toEqual([
      { conversationId: started.conversationId, turn: 1 },
      { conversationId: started.conversationId, turn: 2 },
    ]);
    // The export (D-272): the conversation's files and each turn's; one chain the verifier reads whole.
    const bundle = (await w.h.controller.handle({ type: "conversation.export", conversationId: started.conversationId }, PAGE)) as ConversationExportBundle;
    const names = bundle.entries.map((entry) => entry.name);
    expect(names.slice(0, 7)).toEqual(["conversation.json", "run-plan.json", "transcript.json", "state.json", "audit.json", "usage.json", "provenance.json"]);
    expect(names).toContain("turn-001/run.json");
    expect(names).toContain("turn-001/result.json");
    expect(names).toContain("turn-002/reply.json");
    const decode = (name: string) => JSON.parse(Buffer.from(bundle.entries.find((entry) => entry.name === name)!.base64, "base64").toString("utf8")) as JsonObject;
    const audit = decode("audit.json") as unknown as JsonObject[];
    expect(verifyAuditChain(audit)).toMatchObject({ valid: true, events: audit.length });
    expect(audit.map((event) => event.sequence)).toEqual(audit.map((_, index) => index + 1));
    const level = audit.filter((event) => event.run_id === started.conversationId).map((event) => [event.turn, event.action]);
    expect(level).toEqual([
      [0, "conversation.started"],
      [1, "turn.started"],
      [1, "turn.completed"],
      [2, "turn.started"],
      [2, "turn.completed"],
      [2, "conversation.ended"],
    ]);
    expect(audit.filter((event) => String(event.action).startsWith("consent.")).map((event) => [event.action, event.decided_by ?? null])).toEqual([
      ["consent.requested", null],
      ["consent.decided", "person"],
    ]);
    const transcript = decode("transcript.json");
    expect(transcript).toMatchObject({ schema: "conversation.transcript.v0", conversation_id: started.conversationId, spent_permissions: [], ended: { reason: "package" } });
    expect((decode("turn-001/result.json") as JsonObject).provenance).toMatchObject({ conversation: { conversation_id: started.conversationId, turn: 1 } });
    // Nothing the person said reached the chain as text: the card's sentence is in the transcript only.
    expect(JSON.stringify(audit)).not.toContain("Order one ticket");
    // A second conversation under the same (session) receipt starts; the ended one is kept.
    const again = await start(w, result);
    expect(again.conversationId).not.toBe(started.conversationId);
    expect(await w.h.controller.handle({ type: "conversation.clear", conversationId: started.conversationId }, PAGE)).toEqual({ cleared: true, conversation_id: started.conversationId });
    expect(await get(w, started.conversationId)).toBeNull();
    expect(await w.h.controller.handle({ type: "run.get", runId: turn.run_id! }, PAGE)).toBeNull();
  });

  it("the answer reaches the turn through the record when the host message is lost (D-270); End between turns; the person's end", async () => {
    const w = await world({ decideLost: true });
    const started = await start(w, await authorize(w));
    await send(w, started.conversationId, "order A");
    await card(w, started.conversationId);
    await w.h.controller.handle({ type: "conversation.decide", conversationId: started.conversationId, step: "confirm", accepted: false }, PAGE);
    const first = await settled(w, started.conversationId);
    expect(first.transcript[0]).toMatchObject({ status: "completed", decisions: [expect.objectContaining({ accepted: false, decided_by: "person" })] });
    expect((first.transcript[0]!.reply as JsonObject).order).toBeNull();
    expect(w.deskSeen).toHaveLength(0);
    // Deciding again, or a step that is not pending, is refused.
    await expect(w.h.controller.handle({ type: "conversation.decide", conversationId: started.conversationId, step: "confirm", accepted: true }, PAGE)).rejects.toMatchObject({ code: "no_turn_active" });
    const ended = (await w.h.controller.handle({ type: "conversation.end", conversationId: started.conversationId }, PAGE)) as ConversationView;
    expect(ended).toMatchObject({ status: "ended", outcome: "completed", ended: { reason: "person" } });
    await expect(send(w, started.conversationId, "hello")).rejects.toMatchObject({ code: "conversation_ended" });
  });

  it("a card nobody answers ends the turn at the node's timeout (V-29); the conversation stays open; Stop cancels a turn", async () => {
    const w = await world({
      mutate: (m) => {
        node(m, "confirm").timeout_seconds = 1;
      },
    });
    const started = await start(w, await authorize(w));
    await send(w, started.conversationId, "order A");
    await card(w, started.conversationId);
    const first = await settled(w, started.conversationId);
    expect(first.status).toBe("open");
    expect(first.transcript[0]).toMatchObject({ status: "failed", error_code: "timeout", decisions: [] });
    expect(first.state).toEqual({ history: [], orders: [] });
    expect(first.activeRun).toBeNull();
    // The next turn goes on; stopping it cancels the run and the turn is `cancelled`.
    const second = await send(w, started.conversationId, "order B");
    await card(w, started.conversationId);
    await w.h.controller.handle({ type: "conversation.cancelTurn", conversationId: started.conversationId }, PAGE);
    const stopped = await settled(w, started.conversationId);
    expect(stopped.transcript[1]).toMatchObject({ turn: 2, status: "cancelled", error_code: "cancelled" });
    expect(second.conversationId).toBe(started.conversationId);
    const ended = (await w.h.controller.handle({ type: "conversation.end", conversationId: started.conversationId }, PAGE)) as ConversationView;
    // V-30: a turn that did not complete makes the conversation `failed`, whatever ended it.
    expect(ended).toMatchObject({ status: "ended", outcome: "failed", ended: { reason: "person" } });
  });

  it("once is spent by the conversation: the second turn's step is not asked, the receipt leases its later turns, a second conversation is refused (V-13, D-270)", async () => {
    const w = await world();
    const result = await authorize(w, { ...GRANTS, "orders.place": "once" });
    const started = await start(w, result);
    await send(w, started.conversationId, "order A");
    await card(w, started.conversationId);
    await w.h.controller.handle({ type: "conversation.decide", conversationId: started.conversationId, step: "confirm", accepted: true }, PAGE);
    const first = await settled(w, started.conversationId);
    expect(first.spent.permissions).toEqual(["orders.place"]);
    // The second turn under the receipt the first spent: leased, and the step decided by the plan.
    await send(w, started.conversationId, "order B");
    const second = await settled(w, started.conversationId);
    expect(second.transcript[1]).toMatchObject({ status: "completed", decisions: [expect.objectContaining({ step: "confirm", accepted: false, decided_by: "plan", reason: "permission_consumed" })] });
    expect((second.transcript[1]!.reply as JsonObject).order).toBeNull();
    expect(w.deskSeen).toHaveLength(1);
    expect(second.state.orders).toHaveLength(1);
    await w.h.controller.handle({ type: "conversation.end", conversationId: started.conversationId }, PAGE);
    // A second conversation under a receipt that granted something once: refused before it starts (the plan is stale: the receipt is spent).
    await expect(start(w, result)).rejects.toMatchObject({ code: "run_plan_stale", message: expect.stringMatching(/once/u) });
  });

  it("a turn in flight when the extension restarts is interrupted and charged as a failed turn; the conversation stays open (D-071, V-25)", async () => {
    const runs = new MemoryRunStore();
    const conversations = new MemoryConversationStore();
    const w = await world({ runs, conversations });
    const started = await start(w, await authorize(w));
    await send(w, started.conversationId, "order A");
    await card(w, started.conversationId);
    // The worker restarts while the card is open: the host is gone, the run is interrupted on the next read.
    const stored = (await runs.listRuns())[0]!;
    expect(stored.record.status).toBe("running");
    const model = scriptedOllama({ interpret: (user) => MESSAGES[String((user as { text: string }).text)]! });
    const second = makeHarness({ runs, conversations, transports: { model: model.transport, tool: scriptedDesk() }, stores: { snapshots: w.h.snapshots, trustStorage: w.h.trustStorage, tabs: w.h.tabs, settingsArea: w.h.settingsArea } });
    const view = (await second.controller.handle({ type: "conversation.get", conversationId: started.conversationId }, PAGE)) as ConversationView;
    expect(view.status).toBe("open");
    expect(view.activeRunId).toBeNull();
    expect(view.transcript[0]).toMatchObject({ turn: 1, status: "failed", error_code: "host_unloaded", decisions: [] });
    expect(view.state).toEqual({ history: [], orders: [] });
    expect(((await second.controller.handle({ type: "run.get", runId: stored.run_id }, PAGE)) as RunView).status).toBe("interrupted");
    // The chain stayed linked across the interruption: the turn's checkpointed slice, then `turn.failed`.
    const bundle = (await second.controller.handle({ type: "conversation.export", conversationId: started.conversationId }, PAGE)) as ConversationExportBundle;
    const audit = JSON.parse(Buffer.from(bundle.entries.find((entry) => entry.name === "audit.json")!.base64, "base64").toString("utf8")) as JsonObject[];
    expect(verifyAuditChain(audit).valid).toBe(true);
    expect(audit.at(-1)).toMatchObject({ action: "turn.failed", error_code: "host_unloaded" });
    // The session survives the restart (it is persisted), so the conversation goes on: a new turn under the same plan.
    const w2: World = { ...w, h: second };
    const resumed = await send(w2, started.conversationId, "hello");
    expect(resumed.activeRun).toMatchObject({ conversation: { conversationId: started.conversationId, turn: 2 } });
    const after = await settled(w2, started.conversationId);
    expect(after.transcript.map((turn) => [turn.turn, turn.status])).toEqual([
      [1, "failed"],
      [2, "completed"],
    ]);
    expect(after.state.history).toEqual([{ text: "hello", intent: "chat" }]);
    // The first harness's host still holds the dangling turn: stop it so no timer outlives the test.
    await w.h.host.cancel(stored.run_id);
    await w.h.host.drain();
  });

  it("the Convenience preset answers a step the floor does not protect; a payment step is always asked (D-271)", async () => {
    // A step gating the network permission instead of the payment: not on D-271's floor.
    const onNetwork = (m: Members) => {
      node(m, "confirm").permissions = ["network.desk"];
    };
    const convenient = await world({ mutate: onNetwork, preset: "convenience" });
    const result = await authorize(convenient);
    expect(result.run_plan!.run_plan.execution.conversation!.consent_steps[0]).toMatchObject({ id: "confirm", kinds: ["network"], pre_decided: { accepted: true, decided_by: "preset", reason: null } });
    const started = await start(convenient, result);
    await send(convenient, started.conversationId, "order A");
    const first = await settled(convenient, started.conversationId);
    expect(first.transcript[0]).toMatchObject({ status: "completed", decisions: [expect.objectContaining({ step: "confirm", accepted: true, decided_by: "preset", reason: null })] });
    expect(convenient.deskSeen).toHaveLength(1);
    expect(convenient.h.events.filter((event) => event.type === "event.conversation").length).toBeGreaterThan(0);
    // The same preset over the payment step: the card is shown (D-261's floor).
    const payment = await world({ preset: "convenience" });
    const plan = await authorize(payment);
    expect(plan.run_plan!.run_plan.execution.conversation!.consent_steps[0]!.pre_decided).toBeNull();
    const conversation = await start(payment, plan);
    await send(payment, conversation.conversationId, "order A");
    const waiting = await card(payment, conversation.conversationId);
    expect(waiting.pendingConsent!.step).toBe("confirm");
    await payment.h.controller.handle({ type: "conversation.cancelTurn", conversationId: conversation.conversationId }, PAGE);
    await settled(payment, conversation.conversationId);
  });

  it("an interrupted turn that was past an accepted card spends its `once`: the next turn is not asked again (T24 review 1 finding 2, V-13)", async () => {
    const runs = new MemoryRunStore();
    const conversations = new MemoryConversationStore();
    // The desk takes the order and never answers: the turn is cut off after the gated call left.
    const w = await world({ runs, conversations, deskGate: new Promise<void>(() => undefined) });
    const started = await start(w, await authorize(w, { ...GRANTS, "orders.place": "once" }));
    await send(w, started.conversationId, "order A");
    await card(w, started.conversationId);
    await w.h.controller.handle({ type: "conversation.decide", conversationId: started.conversationId, step: "confirm", accepted: true }, PAGE);
    const deadline = Date.now() + 10_000;
    while (w.deskSeen.length === 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
    expect(w.deskSeen).toHaveLength(1);
    const stored = (await runs.listRuns())[0]!;
    expect(stored.record.status).toBe("running");
    // The extension restarts: the turn is interrupted with no outcome, and its `once` is read from what it left.
    const model = scriptedOllama({ interpret: (user) => MESSAGES[String((user as { text: string }).text)]! });
    const second = makeHarness({ runs, conversations, transports: { model: model.transport, tool: scriptedDesk() }, stores: { snapshots: w.h.snapshots, trustStorage: w.h.trustStorage, tabs: w.h.tabs, settingsArea: w.h.settingsArea } });
    const w2: World = { ...w, h: second };
    const view = await get(w2, started.conversationId);
    expect(view.transcript[0]).toMatchObject({ turn: 1, status: "failed", error_code: "host_unloaded" });
    expect(view.spent.permissions).toEqual(["orders.place"]);
    // The next order is decided by the plan as consumed: no card, no second call to the desk.
    await send(w2, started.conversationId, "order B");
    const after = await settled(w2, started.conversationId);
    expect(after.transcript[1]).toMatchObject({ status: "completed", decisions: [expect.objectContaining({ step: "confirm", accepted: false, decided_by: "plan", reason: "permission_consumed" })] });
    expect(w.deskSeen).toHaveLength(1);
    await w.h.host.cancel(stored.run_id);
  });

  it("a turn reserves the host's per-run token cap, not the package's whole turn budget (T24 review 1 finding 3, V-10)", async () => {
    // A conversation budget just above one package turn: reserving the package's 4,000 tokens per turn, only one
    // turn fits; reserving the browser's 3,500-token run limit, which the runtime applies to each turn, two do.
    const tight = (m: Members) => {
      ((m["graph.json"] as JsonObject).conversation as { budget: JsonObject }).budget.hard_tokens = 4100;
    };
    const w = await world({ mutate: tight, limits: { total_tokens: 3500 } });
    const started = await start(w, await authorize(w));
    await send(w, started.conversationId, "hello");
    await settled(w, started.conversationId);
    await send(w, started.conversationId, "hello");
    const after = await settled(w, started.conversationId);
    expect(after.transcript.map((turn) => turn.status)).toEqual(["completed", "completed"]);
    expect(after.status).toBe("open");
  });

  it("two sends that read the same record start one turn; the other is refused and the chain stays one (T24 review 1 finding 4, V-17)", async () => {
    const w = await world();
    const started = await start(w, await authorize(w));
    const results = await Promise.allSettled([send(w, started.conversationId, "hello"), send(w, started.conversationId, "hello")]);
    expect(results.map((result) => result.status).sort()).toEqual(["fulfilled", "rejected"]);
    expect((results.find((result) => result.status === "rejected") as PromiseRejectedResult).reason).toMatchObject({ code: "turn_active" });
    const after = await settled(w, started.conversationId);
    expect(after.transcript.map((turn) => [turn.turn, turn.status])).toEqual([[1, "completed"]]);
    // An end racing a send: one of them wins, and the chain still verifies.
    const raced = await Promise.allSettled([send(w, started.conversationId, "hello"), w.h.controller.handle({ type: "conversation.end", conversationId: started.conversationId }, PAGE)]);
    expect(raced.filter((result) => result.status === "fulfilled").length).toBeGreaterThanOrEqual(1);
    await w.h.host.drain();
    const final = await waitFor(w, started.conversationId, (view) => view.activeRunId === null, "the turn settled");
    if (final.status === "open") await w.h.controller.handle({ type: "conversation.end", conversationId: started.conversationId }, PAGE);
    const bundle = (await w.h.controller.handle({ type: "conversation.export", conversationId: started.conversationId }, PAGE)) as ConversationExportBundle;
    const audit = JSON.parse(Buffer.from(bundle.entries.find((entry) => entry.name === "audit.json")!.base64, "base64").toString("utf8")) as JsonObject[];
    expect(verifyAuditChain(audit).valid).toBe(true);
    expect(audit.filter((event) => event.action === "conversation.ended")).toHaveLength(1);
  });

  it("a first turn whose host did not start still counts the receipt it spent: the next turn is leased under it (T24 review 1 nit 7)", async () => {
    const w = await world();
    const started = await start(w, await authorize(w, { ...GRANTS, "orders.place": "once" }));
    const options = (w.h.host as unknown as { options: { failStart?: boolean } }).options;
    options.failStart = true;
    await expect(send(w, started.conversationId, "hello")).rejects.toMatchObject({ code: "execution_unavailable" });
    options.failStart = false;
    const failed = await get(w, started.conversationId);
    expect(failed.transcript.map((turn) => [turn.turn, turn.status])).toEqual([[1, "failed"]]);
    await send(w, started.conversationId, "hello");
    const after = await settled(w, started.conversationId);
    expect(after.transcript.map((turn) => [turn.turn, turn.status])).toEqual([
      [1, "failed"],
      [2, "completed"],
    ]);
    await w.h.controller.handle({ type: "conversation.end", conversationId: started.conversationId }, PAGE);
    const bundle = (await w.h.controller.handle({ type: "conversation.export", conversationId: started.conversationId }, PAGE)) as ConversationExportBundle;
    const audit = JSON.parse(Buffer.from(bundle.entries.find((entry) => entry.name === "audit.json")!.base64, "base64").toString("utf8")) as JsonObject[];
    expect(verifyAuditChain(audit).valid).toBe(true);
  });

  it("a turn runs under the run limits the conversation froze at its start, which its reservation counted (T24 review 2 finding 1, V-10)", async () => {
    const tight = (m: Members) => {
      ((m["graph.json"] as JsonObject).conversation as { budget: JsonObject }).budget.hard_tokens = 4100;
    };
    const runs = new MemoryRunStore();
    const w = await world({ mutate: tight, limits: { total_tokens: 3500 }, runs });
    const started = await start(w, await authorize(w));
    // The person raises Settings → Run limits after the conversation started.
    const current = (await w.h.controller.handle({ type: "settings.get" }, PAGE)) as SettingsView;
    await w.h.controller.handle({ type: "settings.set", settings: { ...current.settings, limits: { ...(current.settings.limits ?? {}), total_tokens: 100_000 } as typeof current.settings.limits } }, PAGE);
    for (const _turn of [1, 2]) {
      await send(w, started.conversationId, "hello");
      await settled(w, started.conversationId);
    }
    const stored = await runs.listRuns();
    expect(stored).toHaveLength(2);
    for (const run of stored) {
      expect(run.invocation.limits.total_tokens).toBe(3500);
      expect(((run.result as JsonObject).limits as { budget: { effective: JsonObject } }).budget.effective.hard_tokens).toBe(3500);
    }
  });

  it("a run limit lowered after the conversation started binds its later turns; one raised never does (T24 review 3 finding 1, D-102, V-10)", async () => {
    const runs = new MemoryRunStore();
    const w = await world({ limits: { total_tokens: 100_000, max_remote_calls: 30 }, runs });
    const started = await start(w, await authorize(w));
    const setLimits = async (limits: Record<string, number>) => {
      const current = (await w.h.controller.handle({ type: "settings.get" }, PAGE)) as SettingsView;
      await w.h.controller.handle({ type: "settings.set", settings: { ...current.settings, limits: { ...(current.settings.limits ?? {}), ...limits } as typeof current.settings.limits } }, PAGE);
    };
    await send(w, started.conversationId, "hello");
    await settled(w, started.conversationId);
    // The person lowers the tokens and raises the remote calls between turns.
    await setLimits({ total_tokens: 50_000, max_remote_calls: 60 });
    await send(w, started.conversationId, "hello");
    await settled(w, started.conversationId);
    const limits = (await runs.listRuns()).sort((a, b) => a.invocation.turn!.turn - b.invocation.turn!.turn).map((run) => [run.invocation.limits.total_tokens, run.invocation.limits.max_remote_calls]);
    expect(limits).toEqual([
      [100_000, 30],
      [50_000, 30],
    ]);
  });

  it("a run limit lowered so that one more turn fits lets that turn run: the reservation counts the limits the turn runs under (T24 review 4 nit 1, V-10, D-102)", async () => {
    // The conversation's budget leaves 4,100 − 267 = 3,833 tokens after a first turn: not enough for
    // a turn reserved at the frozen 3,900-token cap, enough for one at the lowered 3,000.
    const tight = (m: Members) => {
      ((m["graph.json"] as JsonObject).conversation as { budget: JsonObject }).budget.hard_tokens = 4100;
    };
    const runs = new MemoryRunStore();
    const w = await world({ mutate: tight, limits: { total_tokens: 3900 }, runs });
    const started = await start(w, await authorize(w));
    await send(w, started.conversationId, "hello");
    const first = await settled(w, started.conversationId);
    expect(first.transcript[0]!.usage.tokens).toBe(267);
    const current = (await w.h.controller.handle({ type: "settings.get" }, PAGE)) as SettingsView;
    await w.h.controller.handle({ type: "settings.set", settings: { ...current.settings, limits: { ...(current.settings.limits ?? {}), total_tokens: 3000 } as typeof current.settings.limits } }, PAGE);
    await send(w, started.conversationId, "hello");
    const second = await settled(w, started.conversationId);
    expect(second.status).toBe("open");
    expect(second.transcript.map((turn) => [turn.turn, turn.status])).toEqual([
      [1, "completed"],
      [2, "completed"],
    ]);
    const limits = (await runs.listRuns()).sort((a, b) => a.invocation.turn!.turn - b.invocation.turn!.turn).map((run) => run.invocation.limits.total_tokens);
    expect(limits).toEqual([3900, 3000]);
  });

  it("a turn cleared without a stored run, and a charge whose run write fails, both release the snapshot (T24 review 4 nit 3)", async () => {
    const runs = new MemoryRunStore();
    const w = await world({ runs });
    const started = await start(w, await authorize(w));
    const hooks = (w.h.controller.conversations as unknown as { deps: { hooks: { turnCharged?: (sha: string) => Promise<void> } } }).deps.hooks;
    const charged: string[] = [];
    const original = hooks.turnCharged!;
    hooks.turnCharged = async (sha) => {
      charged.push(sha);
      await original(sha);
    };
    // (a) The host refuses the turn before any run is stored.
    const manager = w.h.controller.runs as unknown as { startTurn: (...args: unknown[]) => Promise<unknown> };
    const startTurn = manager.startTurn;
    manager.startTurn = async () => {
      throw new Error("the host could not start the turn");
    };
    await expect(send(w, started.conversationId, "hello")).rejects.toMatchObject({ code: "execution_unavailable" });
    manager.startTurn = startTurn;
    expect(await runs.listRuns()).toEqual([]);
    expect(charged).toHaveLength(1);
    // (b) The turn is charged, and clearing its leftovers from the stored run fails.
    const update = runs.updateRun.bind(runs);
    runs.updateRun = async (runId, mutate) =>
      update(runId, (current) => {
        const next = mutate(current);
        if (next !== null && current.turn_outcome != null && next.turn_outcome === null) throw new Error("the run store refused the write");
        return next;
      });
    await send(w, started.conversationId, "hello");
    await w.h.host.drain();
    await waitFor(w, started.conversationId, (view) => view.transcript.some((turn) => turn.status === "completed"), "the charged turn");
    const deadline = Date.now() + 5_000;
    while (charged.length < 2 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
    expect(charged).toHaveLength(2);
    expect(new Set(charged).size).toBe(1);
  });

  it("a policy cap subscribed after the conversation started reaches its later turns (T24 review 3 finding 1, D-102)", async () => {
    const signer = newSigner();
    const url = "https://policy.example/tight.json";
    const content = { ...POLICY_CONTENT, issued_at: "2026-10-01T00:00:00Z", budget_caps: { total_tokens: 40_000 }, bindings: { allow: [{ kind: "json_http", origins: ["https://desk.example.org"] }] } };
    const runs = new MemoryRunStore();
    const w = await world({ runs, routes: { [url]: { headers: { "content-type": "application/json" }, body: await signedBytes(POLICY_BUNDLE_TYPE, content, signer) } } });
    const started = await start(w, await authorize(w));
    await send(w, started.conversationId, "hello");
    await settled(w, started.conversationId);
    await w.h.controller.handle({ type: "policy.subscribe", url, publicKeyPem: signer.pem, replace: false }, PAGE);
    await send(w, started.conversationId, "hello");
    const after = await settled(w, started.conversationId);
    expect(after.transcript.map((turn) => turn.status)).toEqual(["completed", "completed"]);
    const totals = (await runs.listRuns()).sort((a, b) => a.invocation.turn!.turn - b.invocation.turn!.turn).map((run) => run.invocation.limits.total_tokens);
    expect(totals[0]).toBeGreaterThan(40_000);
    expect(totals[1]).toBe(40_000);
  });

  it("a turn that settles after its package session closed still ends the conversation by the package's rule (T24 review 2 nit 2, V-8)", async () => {
    let release!: () => void;
    const w = await world({ modelGate: new Promise<void>((resolve) => (release = resolve)) });
    const started = await start(w, await authorize(w));
    await send(w, started.conversationId, "done");
    // The turn is in flight: the model has its request and holds the answer.
    const asked = () => w.modelSeen.some((request) => (request.body ?? "").includes('\\"done\\"'));
    const deadline = Date.now() + 10_000;
    while (!asked() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
    expect(asked()).toBe(true);
    await w.h.controller.handle({ type: "package.close", sessionId: w.session.session.id }, PAGE);
    release();
    const after = await waitFor(w, started.conversationId, (view) => view.status === "ended", "the conversation ended");
    expect(after).toMatchObject({ status: "ended", ended: { reason: "package" } });
    // The snapshot goes once the conversation has read its rule: nothing else refers to it.
    expect(await w.h.snapshots.listSnapshots()).toEqual([]);
  });

  it("an open conversation's uncharged turn keeps its snapshot: a turn charged later by reconcile still ends by the package's rule (T24 review 3 nit 2, V-8)", async () => {
    let release!: () => void;
    const runs = new MemoryRunStore();
    const w = await world({ runs, modelGate: new Promise<void>((resolve) => (release = resolve)) });
    const started = await start(w, await authorize(w));
    await send(w, started.conversationId, "done");
    const asked = () => w.modelSeen.some((request) => (request.body ?? "").includes('\\"done\\"'));
    const deadline = Date.now() + 10_000;
    while (!asked() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
    expect(asked()).toBe(true);
    // The worker misses the turn's `host.finished` (it restarted): the run settles, its snapshot hook runs, nothing charges.
    const onTurnSettled = w.h.controller.runs.onTurnSettled;
    w.h.controller.runs.onTurnSettled = null;
    await w.h.controller.handle({ type: "package.close", sessionId: w.session.session.id }, PAGE);
    release();
    await w.h.host.drain();
    const until = Date.now() + 10_000;
    while (!(await runs.listRuns()).every((run) => run.record.status === "completed") && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 20));
    expect((await runs.listRuns()).map((run) => run.record.status)).toEqual(["completed"]);
    expect(await w.h.snapshots.listSnapshots()).toHaveLength(1);
    // The next reconcile charges the turn, reads the rule from the snapshot, and only then lets it go.
    w.h.controller.runs.onTurnSettled = onTurnSettled;
    await (w.h.controller.conversations as unknown as { reconcile(force: boolean): Promise<void> }).reconcile(true);
    expect(await get(w, started.conversationId)).toMatchObject({ status: "ended", ended: { reason: "package" } });
    expect(await w.h.snapshots.listSnapshots()).toEqual([]);
  });

  it("a reconcile that failed is throttled for reads: they return the stored record instead of retrying it at every poll (T24 review 3 nit 4)", async () => {
    const conversations = new MemoryConversationStore();
    const w = await world({ conversations });
    const started = await start(w, await authorize(w));
    let listed = 0;
    conversations.listConversations = async () => {
      listed += 1;
      throw new Error("IndexedDB read failed");
    };
    const manager = w.h.controller.conversations as unknown as { reconcile(force: boolean): Promise<void> };
    await expect(manager.reconcile(true)).rejects.toThrow("IndexedDB read failed");
    expect(listed).toBe(1);
    for (const _poll of [1, 2, 3]) expect(await get(w, started.conversationId)).toMatchObject({ conversationId: started.conversationId, status: "open" });
    expect(listed).toBe(1);
    // A write still forces one, and reports the failure.
    await expect(manager.reconcile(true)).rejects.toThrow("IndexedDB read failed");
    expect(listed).toBe(2);
  });

  it("a turn whose end rule cannot be read is still charged, and the conversation stays open (T24 review 2 nit 3)", async () => {
    let release!: () => void;
    const w = await world({ modelGate: new Promise<void>((resolve) => (release = resolve)) });
    const started = await start(w, await authorize(w));
    await send(w, started.conversationId, "hello");
    const asked = () => w.modelSeen.some((request) => (request.body ?? "").includes('\\"hello\\"'));
    const deadline = Date.now() + 10_000;
    while (!asked() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
    expect(asked()).toBe(true);
    await w.h.controller.handle({ type: "package.close", sessionId: w.session.session.id }, PAGE);
    // The stored package cannot be read when the turn settles.
    w.h.snapshots.getSnapshot = async () => {
      throw new Error("IndexedDB read failed");
    };
    release();
    const after = await waitFor(w, started.conversationId, (view) => view.activeRunId === null, "the turn charged");
    expect(after.status).toBe("open");
    expect(after.transcript.map((turn) => turn.status)).toEqual(["completed"]);
    expect(after.spent.tokens).toBeGreaterThan(0);
  });
});
