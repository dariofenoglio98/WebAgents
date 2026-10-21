// @vitest-environment happy-dom
/**
 * The chat surface (T24, D-270) over the controller and the in-process host, as the pages mount it:
 * Start is held until the plan is ready, a message becomes a turn, the consent card appears on the
 * surface with the sentence, the facts and who asked, Yes places the order, the decision keeps its
 * provenance line, the package ends the conversation, Download writes one zip (D-272); a panel
 * mounted later reconnects to the open conversation; the Runs page's conversation list.
 */
import { describe, expect, it } from "vitest";

import type { JsonObject } from "../../src/core/json.js";
import { publicKeyToPem } from "../../src/core/keys.js";
import { TransportError, type HttpRequest, type HttpTransport } from "../../src/core/models/transport.js";
import type { AuthorizationView, AuthorizeResult, ConversationListView, Request, SessionView, SettingsView } from "../../src/extension/messages.js";
import { cardTitle, ConversationPanel, decisionWords, renderConversationList, spokenText } from "../../src/extension/ui/conversation.js";
import { MESSAGES, ORDERS, probeBytes } from "../helpers/conversation-package.js";
import { scriptedOllama, type SeenRequest } from "../helpers/host.js";
import { until } from "../helpers/page.js";
import { makeHarness, PACKAGE_MEDIA_TYPE, PAGE, webairRoutes, type Harness } from "../helpers/shell.js";
import { listMembers } from "../helpers/zip.js";

const DESK_URL = "https://desk.example.org/agent.pkg";
const QWEN = "ollama/qwen3:30b";
const GRANTS = { "model.reasoning": "session", "memory.session": "session", "orders.place": "session", "network.desk": "session" };

function scriptedDesk(seen: SeenRequest[] = []): HttpTransport {
  return async (request: HttpRequest) => {
    seen.push({ url: request.url, method: request.method, body: request.body, headers: { ...request.headers } });
    const args = JSON.parse(request.body ?? "{}") as { show: string; quantity: number };
    const order = ORDERS.find(([show, quantity]) => show === args.show && quantity === args.quantity);
    if (!order) throw new TransportError("no such order", { stage: "transport" });
    return { status: 200, headers: { "content-type": "application/json" }, body: JSON.stringify(order[2]) };
  };
}

async function world(): Promise<{ h: Harness; session: SessionView; deskSeen: SeenRequest[] }> {
  const { bytes, key } = await probeBytes({ remoteTool: true });
  const model = scriptedOllama({ interpret: (user) => MESSAGES[String((user as { text: string }).text)]! });
  const deskSeen: SeenRequest[] = [];
  const routes = { ...webairRoutes(), [DESK_URL]: { headers: { "content-type": PACKAGE_MEDIA_TYPE, "content-length": String(bytes.length) }, body: bytes } };
  const h = makeHarness({ routes, transports: { model: model.transport, tool: scriptedDesk(deskSeen) } });
  const view = (await h.controller.handle({ type: "package.open", url: DESK_URL, advertisedOn: "https://desk.example.org/", viewId: "ui" }, PAGE)) as SessionView;
  await h.controller.handle({ type: "trust.pinKey", publicKeyPem: publicKeyToPem(key.publicKey), displayName: "Example desk", publisherId: "example" }, PAGE);
  const settings = ((await h.controller.handle({ type: "settings.get" }, PAGE)) as SettingsView).settings;
  settings.models.default_model = QWEN;
  await h.controller.handle({ type: "settings.set", settings }, PAGE);
  const session = (await h.controller.handle({ type: "package.get", sessionId: view.session.id }, PAGE)) as SessionView;
  return { h, session, deskSeen };
}

function mountPanel(h: Harness, session: SessionView, options: { compact?: boolean } = {}) {
  let authorization: AuthorizationView | null = null;
  const opened: string[] = [];
  const panel = new ConversationPanel({
    send: <T>(request: Request) => h.controller.handle(request, PAGE) as Promise<T>,
    loaded: () => ({ session, authorization }),
    compact: options.compact,
    openRun: (runId) => opened.push(runId),
  });
  document.body.append(panel.root);
  const sync = async () => {
    authorization = (await h.controller.handle({ type: "authorization.get", sessionId: session.session.id }, PAGE)) as AuthorizationView;
    panel.sync();
  };
  const text = () => panel.root.textContent ?? "";
  const button = (label: string) => [...panel.root.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent === label);
  const settle = (ms = 60) => new Promise((resolve) => setTimeout(resolve, ms));
  return { panel, sync, text, button, settle, opened };
}

describe("the chat surface", () => {
  it("starts a conversation once the plan is ready, sends a turn, shows the card, places the order on Yes, and ends with the package (D-270)", async () => {
    const w = await world();
    const { panel, sync, text, button, settle, opened } = mountPanel(w.h, w.session);
    await panel.attachSession(w.session.session.id);
    await sync();
    expect(panel.root.dataset.state).toBe("idle");
    const start = panel.root.querySelector<HTMLButtonElement>("[data-conversation=start]")!;
    expect(start.disabled).toBe(true);
    expect(text()).toContain("Authorize this agent to start a conversation.");
    // Authorize, as the summary card does: the plan carries the conversation section.
    const result = (await w.h.controller.handle({ type: "authorization.authorize", sessionId: w.session.session.id, packageDigest: w.session.summary.package.digest as string, decisions: GRANTS, toolApprovals: { place: true }, resourceSelections: {}, provenance: null, prepare: true }, PAGE)) as AuthorizeResult;
    expect(result.run_plan?.preflight.ready).toBe(true);
    await sync();
    await until(() => !panel.root.querySelector<HTMLButtonElement>("[data-conversation=start]")!.disabled, "Start enabled");
    expect(text()).toContain("The package may keep history, orders between turns");
    panel.root.querySelector<HTMLButtonElement>("[data-conversation=start]")!.click();
    await until(() => panel.root.dataset.state === "open", "the conversation open");
    expect(text()).toContain("Turn 0 of 4");
    expect(text()).toContain("Asks you before: Confirm");
    // The message box is the package's input schema (one string field), with Send.
    const field = panel.root.querySelector<HTMLInputElement>("#ab-field-text")!;
    expect(field).not.toBeNull();
    field.value = "order A";
    field.dispatchEvent(new Event("input"));
    await settle();
    panel.root.querySelector<HTMLButtonElement>("[data-conversation=send]")!.click();
    await until(() => panel.root.dataset.state === "running" || panel.root.dataset.state === "waiting", "the turn running");
    expect(panel.root.querySelector(".ab-chat-you")?.textContent).toContain("order A");
    // The card: the sentence, the facts, who asked, the countdown, Yes and No.
    const card = await until(() => panel.root.querySelector<HTMLElement>(".ab-consent-card"), "the consent card");
    expect(panel.root.dataset.state).toBe("waiting");
    expect(card.querySelector("h3")?.textContent).toBe("Before Conversation Probe pays");
    expect(card.querySelector(".ab-consent-text")?.textContent).toBe("Order one ticket to Show A?");
    expect(card.textContent).toContain("Show");
    expect(card.textContent).toContain("Show A");
    expect(card.textContent).toContain("Quantity");
    expect(card.textContent).toContain("Uses orders.place · asked by the package's step Confirm");
    expect(card.textContent).toContain("left to decide");
    expect(w.deskSeen).toHaveLength(0);
    card.querySelector<HTMLButtonElement>("[data-decide=accept]")!.click();
    await until(() => panel.root.dataset.state === "open", "the turn settled", 15_000);
    expect(panel.root.querySelector(".ab-consent-card")).toBeNull();
    expect(w.deskSeen).toHaveLength(1);
    // The transcript: the decision with its provenance, the reply, the turn's facts, Details.
    const decision = panel.root.querySelector<HTMLElement>(".ab-chat-decision")!;
    expect(decision.textContent).toContain("“Order one ticket to Show A?” — You accepted · decided by you");
    const reply = panel.root.querySelector<HTMLElement>(".ab-chat-agent[data-turn='1']")!;
    expect(reply.querySelector(".ab-chat-text")?.textContent).toBe("Order one ticket to Show A?");
    expect(reply.textContent).toContain("turn 1 · completed");
    [...reply.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent === "Details")!.click();
    expect(opened).toHaveLength(1);
    expect(text()).toContain("Turn 1 of 4");
    expect(panel.root.querySelector(".ab-chat-technical")?.textContent).toContain("orders: 1 item");
    // The second turn ends the conversation by the package's rule.
    const again = panel.root.querySelector<HTMLInputElement>("#ab-field-text")!;
    again.value = "done";
    again.dispatchEvent(new Event("input"));
    await settle();
    panel.root.querySelector<HTMLButtonElement>("[data-conversation=send]")!.click();
    await until(() => panel.root.dataset.state === "ended", "the conversation ended", 15_000);
    expect(text()).toContain("Ended: Conversation Probe considered it done");
    expect(panel.root.querySelector("[data-conversation=send]")).toBeNull();
    expect(button("New conversation")).not.toBeUndefined();
    // Download: one zip of the conversation's files, each turn's under turn-NNN/ (D-272).
    const saved: Blob[] = [];
    URL.createObjectURL = (blob: Blob) => {
      saved.push(blob);
      return "blob:test";
    };
    URL.revokeObjectURL = () => undefined;
    HTMLAnchorElement.prototype.click = function click() {
      return undefined;
    };
    button("Download")!.click();
    await until(() => saved.length > 0, "the zip saved");
    const members = listMembers(new Uint8Array(await saved[0]!.arrayBuffer()));
    expect([...members.keys()].slice(0, 7)).toEqual(["conversation.json", "run-plan.json", "transcript.json", "state.json", "audit.json", "usage.json", "provenance.json"]);
    expect(members.has("turn-001/result.json")).toBe(true);
    expect(members.has("turn-002/reply.json")).toBe(true);
    const transcript = JSON.parse(new TextDecoder().decode(members.get("transcript.json")!)) as JsonObject;
    expect((transcript.turns as JsonObject[]).map((turn) => turn.status)).toEqual(["completed", "completed"]);
    expect(text()).toContain("Saved conversation_");
    // New conversation returns to Start, and the ended one is listed as earlier.
    button("New conversation")!.click();
    expect(panel.root.dataset.state).toBe("idle");
    await settle();
    expect(text()).toContain("Earlier conversations with this agent (1)");
    panel.dispose();
  });

  it("a panel mounted later reconnects to the open conversation with its card, and the Runs page lists conversations", async () => {
    const w = await world();
    const first = mountPanel(w.h, w.session);
    await first.panel.attachSession(w.session.session.id);
    await w.h.controller.handle({ type: "authorization.authorize", sessionId: w.session.session.id, packageDigest: w.session.summary.package.digest as string, decisions: GRANTS, toolApprovals: { place: true }, resourceSelections: {}, provenance: null, prepare: true }, PAGE);
    await first.sync();
    await until(() => !first.panel.root.querySelector<HTMLButtonElement>("[data-conversation=start]")!.disabled, "Start enabled");
    first.panel.root.querySelector<HTMLButtonElement>("[data-conversation=start]")!.click();
    await until(() => first.panel.root.dataset.state === "open", "open");
    const field = first.panel.root.querySelector<HTMLInputElement>("#ab-field-text")!;
    field.value = "order B";
    field.dispatchEvent(new Event("input"));
    await first.settle();
    first.panel.root.querySelector<HTMLButtonElement>("[data-conversation=send]")!.click();
    await until(() => first.panel.root.querySelector(".ab-consent-card"), "the card");
    const conversationId = first.panel.current()!.conversationId;
    first.panel.dispose();
    first.panel.root.remove();
    // A new panel (the side panel reopened): it finds the open conversation and shows the card again.
    const second = mountPanel(w.h, w.session, { compact: true });
    await second.panel.attachSession(w.session.session.id);
    await second.sync();
    await until(() => second.panel.root.querySelector(".ab-consent-card"), "the card again");
    expect(second.panel.current()?.conversationId).toBe(conversationId);
    expect(second.panel.root.classList.contains("ab-chat-compact")).toBe(true);
    expect(second.panel.root.querySelector(".ab-consent-text")?.textContent).toBe("Order two tickets to Show B?");
    // Stop this turn while the card is open: the turn is cancelled, the conversation stays open.
    second.panel.root.querySelector<HTMLButtonElement>("[data-conversation=stop]")!.click();
    await until(() => second.panel.root.dataset.state === "open", "stopped", 15_000);
    expect(second.panel.root.querySelector(".ab-chat-cancelled")?.textContent).toContain("Turn stopped");
    // End between turns.
    second.panel.root.querySelector<HTMLButtonElement>("[data-conversation=end]")!.click();
    await until(() => second.panel.root.dataset.state === "ended", "ended");
    expect(second.text()).toContain("Ended: you ended it");
    const list = (await w.h.controller.handle({ type: "conversation.list", sessionId: null }, PAGE)) as ConversationListView;
    const rendered = renderConversationList(list.conversations, { open: () => undefined, export: () => undefined, clear: () => undefined });
    expect(rendered.querySelectorAll(".ab-run-row")).toHaveLength(1);
    expect(rendered.textContent).toContain("Ended");
    expect(rendered.textContent).toContain("“order B”");
    expect([...rendered.querySelectorAll("button")].map((item) => item.textContent)).toEqual(["Open", "Export", "Clear"]);
    second.panel.dispose();
  });

  it("the words: a decision's provenance line, the card's heading, the spoken text of a reply", () => {
    const base = { step: "confirm", permissions: ["orders.place"], text: "Order?", facts: {}, decided_at: "2026-10-21T10:00:00+00:00" };
    expect(decisionWords({ ...base, accepted: true, decided_by: "person", reason: null }, "balanced")).toMatch(/^You accepted · decided by you at /u);
    expect(decisionWords({ ...base, accepted: false, decided_by: "plan", reason: "permission_denied" }, null)).toBe("Not asked: the plan denies orders.place · decided by the plan");
    expect(decisionWords({ ...base, accepted: false, decided_by: "plan", reason: "permission_consumed" }, null)).toBe("Not asked: orders.place was already used once in this conversation · decided by the plan");
    expect(decisionWords({ ...base, accepted: true, decided_by: "preset", reason: null }, "convenience")).toBe("Accepted by your Convenience preset (no card shown) · decided by preset");
    expect(decisionWords({ ...base, accepted: false, decided_by: "policy", reason: "policy_forbids" }, null)).toBe("Declined by your organisation's policy (this step is forbidden) · decided by policy");
    expect(decisionWords({ ...base, accepted: false, decided_by: "host", reason: "no_decision_available" }, null)).toBe("Not decided: nobody could answer · decided by the host");
    expect(cardTitle("WebAir", ["payment"])).toBe("Before WebAir pays");
    expect(cardTitle("WebAir", ["network"])).toBe("Before WebAir continues");
    expect(spokenText({ reply: "Hello", intent: "chat" })).toBe("Hello");
    expect(spokenText({ a: "x", b: "a longer sentence" })).toBe("a longer sentence");
    expect(spokenText({ n: 1 })).toBe('{\n  "n": 1\n}');
  });
});
