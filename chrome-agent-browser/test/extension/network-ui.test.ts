// @vitest-environment happy-dom
/**
 * network.v0 in the browser's own surfaces (T26, D-291): the travel network opened from its origin,
 * the agent page's "How it delegates" card with the envelope ("at most"), the plan card's delegation
 * row, a run end to end through the controller and the execution host (a scripted Ollama choosing the
 * front man's routes from the availability in the request, the WebAir origin's travel services
 * answering from the package's fixture), and the run surface: the walk under the stages, the
 * handoffs against the envelope, every route decision and each role's spend in Technical details.
 */
import { MAX_REASKS } from "../../src/core/workflow/runtime.js";
import { afterEach, describe, expect, it } from "vitest";

import type { JsonObject } from "../../src/core/json.js";
import { TransportError, type HttpRequest, type HttpTransport } from "../../src/core/models/transport.js";
import type { AuthorizationView, AuthorizeResult, Request, RunView, SessionView, SettingsView } from "../../src/extension/messages.js";
import { renderAgentPage } from "../../src/extension/ui/agent-page.js";
import { newAuthorizeState, renderAuthorizeView, type AuthorizeActions } from "../../src/extension/ui/authorize.js";
import { decisionText, roleUsage, RunPanel } from "../../src/extension/ui/run.js";
import { scriptedOllama } from "../helpers/host.js";
import { generateKeyPair, signedArchive } from "../helpers/keys.js";
import { TRAVEL_SOURCE, treeFiles } from "../helpers/network-package.js";
import { makeHarness, PACKAGE_MEDIA_TYPE, PAGE, webairRoutes, type Harness } from "../helpers/shell.js";

const HOST = "webagents-webair-production.up.railway.app";
const PACKAGE_URL = `https://${HOST}/packages/travel-network-0.1.0.agent.pkg`;
const GRANTS = { "model.reasoning": "session", "memory.session": "session", "network.webair": "session" };
const TOOLS = { "search-flights": true, "search-hotels": true, "check-calendar": true };

afterEach(() => {
  document.body.replaceChildren();
});

function fixture(): JsonObject {
  return JSON.parse(new TextDecoder().decode(treeFiles(TRAVEL_SOURCE).get("fixtures/workflow.json")!)) as JsonObject;
}

/** The WebAir origin's travel services, answering from the package's fixture by exact input (`test_travel.py` checks the real origin answers the same). */
function travelOrigin(seen: string[]): HttpTransport {
  const cases = fixture().tools as Record<string, Array<{ input: unknown; output: unknown }>>;
  const byPath: Record<string, string> = { "/api/v1/travel/flights": "search-flights", "/api/v1/travel/hotels": "search-hotels", "/api/v1/travel/calendar": "check-calendar" };
  return async (request: HttpRequest) => {
    const url = new URL(request.url);
    seen.push(`${request.method} ${url.host}${url.pathname}`);
    const tool = byPath[url.pathname];
    const match = tool ? cases[tool]!.find((item) => JSON.stringify(item.input) === JSON.stringify(JSON.parse(request.body ?? "null"))) : undefined;
    if (!match) throw new TransportError("no such travel request", { stage: "transport" });
    return { status: 200, headers: { "content-type": "application/json" }, body: JSON.stringify(match.output) };
  };
}

/** A front man that takes the first target it may still take, then ends: the full tour. */
function frontMan() {
  const understandings = (fixture().models as Record<string, Array<{ output: JsonObject }>>).understand!.map((item) => item.output);
  let visit = 0;
  return scriptedOllama({
    understand: () => understandings[Math.min(visit, understandings.length - 1)]!,
    route: (data) => {
      visit += 1;
      const targets = (data as { targets: Array<{ role: string; uses_left: number }> }).targets;
      const next = targets.find((target) => target.uses_left > 0);
      return next ? { next: next.role, message: { text: `Ask ${next.role}.` } } : { next: "done", message: { text: "Boston to Zurich, 9 to 14 March 2027: the plan. Nothing is booked." } };
    },
  });
}

async function travelWorld(): Promise<{ h: Harness; session: SessionView; toolSeen: string[] }> {
  const key = await generateKeyPair();
  const bytes = await signedArchive(treeFiles(TRAVEL_SOURCE), key);
  const toolSeen: string[] = [];
  const routes = { ...webairRoutes(), [PACKAGE_URL]: { headers: { "content-type": PACKAGE_MEDIA_TYPE, "content-length": String(bytes.length) }, body: bytes } };
  const h = makeHarness({ routes, transports: { model: frontMan().transport, tool: travelOrigin(toolSeen) } });
  const opened = (await h.controller.handle({ type: "package.open", url: PACKAGE_URL, advertisedOn: null, viewId: "network" }, PAGE)) as SessionView;
  await h.controller.handle({ type: "trust.pin", sessionId: opened.session.id, signerFingerprint: key.fingerprint, scope: "publisher" }, PAGE);
  const settings = ((await h.controller.handle({ type: "settings.get" }, PAGE)) as SettingsView).settings;
  settings.models.default_model = "ollama/qwen3:30b";
  await h.controller.handle({ type: "settings.set", settings }, PAGE);
  const session = (await h.controller.handle({ type: "package.get", sessionId: opened.session.id }, PAGE)) as SessionView;
  return { h, session, toolSeen };
}

async function authorize(h: Harness, session: SessionView): Promise<AuthorizeResult> {
  const result = (await h.controller.handle({ type: "authorization.authorize", sessionId: session.session.id, packageDigest: session.page.technical.digest, decisions: GRANTS, toolApprovals: TOOLS, resourceSelections: {}, provenance: null, prepare: true }, PAGE)) as AuthorizeResult;
  expect(result.run_plan?.preflight.ready, JSON.stringify(result.plan_refused)).toBe(true);
  return result;
}

describe("the agent page of a delegation package", () => {
  it("says between which roles the model chooses, and at most how many handoffs, calls and tokens, before any run", async () => {
    const { session } = await travelWorld();
    const delegation = session.page.delegation!;
    expect(delegation.at_most).toEqual({ handoffs: 6, activations: 7, model_calls: 8, tool_calls: { "check-calendar": 1, "search-flights": 1, "search-hotels": 1 }, remote_calls: 19, tokens: 48000, seconds: 800 });
    expect(delegation.roles.map((role) => [role.id, role.chosen_by, role.at_most])).toEqual([
      ["FrontMan", "model", 4],
      ["Flights", "package", 1],
      ["Hotel", "package", 1],
      ["Calendar", "package", 1],
    ]);
    expect(delegation.sentence).toMatch(/^The package delegates between 4 roles \(FrontMan, Flights, Hotel, Calendar\), the next role chosen by the model after FrontMan and fixed by the package after Flights, Hotel and Calendar, within a declared envelope: at most 6 handoffs;/u);
    expect(session.summary.warnings.find((warning) => warning.code === "delegation_network")?.message).toBe(delegation.sentence);
    const page = renderAgentPage(session);
    document.body.append(page);
    expect(page.textContent).toContain("How it delegates");
    expect(page.textContent).toContain("At most, in any run");
    const front = page.querySelector<HTMLElement>('.ab-role[data-role="FrontMan"]')!;
    expect(front.textContent).toContain("at most 4 times");
    expect(front.textContent).toContain("The model chooses what follows: Flights (at most 1×), Hotel (at most 1×), Calendar (at most 1×), done");
    expect(page.querySelector<HTMLElement>('.ab-role[data-role="Hotel"]')!.textContent).toContain("Then FrontMan, fixed by the package. Each time: the tool search-hotels, 1 remote call.");
    expect(front.textContent).toContain("Each time: up to 2 model calls, 12,000 tokens, 4 remote calls.");
    // T26 review 1, should-fix 1 (B-246): the bound counts logical calls; a re-ask is an attempt the run page shows.
    expect(page.textContent).toContain("A model call counts once here even when its answer is refused and the model is asked again (up to twice more); the run page counts every attempt.");
    expect(MAX_REASKS).toBe(2); // the sentence's "twice"
  });

  it("the plan card states the envelope the plan froze", async () => {
    const { h, session } = await travelWorld();
    await authorize(h, session);
    const view = (await h.controller.handle({ type: "authorization.get", sessionId: session.session.id }, PAGE)) as AuthorizationView;
    const root = renderAuthorizeView({ session, view, models: null, busy: null }, newAuthorizeState(), {} as AuthorizeActions);
    document.body.append(root);
    const terms = [...root.querySelectorAll("dt")].map((node) => [node.textContent, node.nextElementSibling?.textContent]);
    expect(terms).toContainEqual(["Delegation", "at most 6 handoffs, 8 model calls, 3 tool calls, 19 remote calls and 48,000 tokens"]);
  });
});

describe("a delegation run from the browser", () => {
  it("runs the full tour, records every route decision, and the run surface shows the walk and each role's spend", async () => {
    const { h, session, toolSeen } = await travelWorld();
    const plan = (await authorize(h, session)).run_plan!.run_plan;
    expect((plan.execution.network as JsonObject).roles).toEqual(["FrontMan", "Flights", "Hotel", "Calendar"]);
    const started = (await h.controller.handle({ type: "run.start", sessionId: session.session.id, runPlanId: plan.run_plan_id, runPlanSha256: plan.run_plan_sha256, input: fixture().input }, PAGE)) as RunView;
    await h.h_drain();
    const record = (await h.controller.handle({ type: "run.get", runId: started.runId }, PAGE)) as RunView;
    expect(record.status, JSON.stringify(record.failure ?? null)).toBe("completed");
    expect(toolSeen).toEqual([`POST ${HOST}/api/v1/travel/flights`, `POST ${HOST}/api/v1/travel/hotels`, `POST ${HOST}/api/v1/travel/calendar`]);
    // The envelope the execution host recorded before the run, with each role's budget.
    expect(record.network).toMatchObject({ node: "plan-trip", entry: "FrontMan", atMost: { maxHops: 6, modelCalls: 8, remoteCalls: 19, tokens: 48000, activations: { FrontMan: 4, Flights: 1, Hotel: 1, Calendar: 1 } } });
    expect(record.network!.roles).toEqual([
      { role: "FrontMan", activationBound: 4, tokensPerActivation: 12000, remoteCallsPerActivation: 4 },
      { role: "Flights", activationBound: 1, tokensPerActivation: 0, remoteCallsPerActivation: 1 },
      { role: "Hotel", activationBound: 1, tokensPerActivation: 0, remoteCallsPerActivation: 1 },
      { role: "Calendar", activationBound: 1, tokensPerActivation: 0, remoteCallsPerActivation: 1 },
    ]);
    const network = record.progress!.network!;
    expect(network).toMatchObject({ node: "plan-trip", state: "completed", hops: 6, activations: { FrontMan: 4, Flights: 1, Hotel: 1, Calendar: 1 } });
    expect(network.decisions.map(decisionText)).toEqual([
      "FrontMan → Flights (the model)",
      "Flights → FrontMan (the package)",
      "FrontMan → Hotel (the model)",
      "Hotel → FrontMan (the package)",
      "FrontMan → Calendar (the model)",
      "Calendar → FrontMan (the package)",
      "FrontMan → done (the model)",
    ]);
    // The observed usage never passes the envelope, role by role.
    const usage = roleUsage(record.network!, record.usage, network);
    for (const row of usage) {
      expect(row.activations).toBeLessThanOrEqual(row.atMost);
      expect(row.tokens).toBeLessThanOrEqual(row.tokensPerActivation * row.activations);
      expect(row.remoteCalls).toBeLessThanOrEqual(row.remoteCallsPerActivation * row.activations);
    }
    expect(usage.map((row) => [row.role, row.activations, row.remoteCalls])).toEqual([
      ["FrontMan", 4, 0],
      ["Flights", 1, 1],
      ["Hotel", 1, 1],
      ["Calendar", 1, 1],
    ]);
    // The run surface.
    const panel = new RunPanel({ send: <T>(request: Request) => h.controller.handle(request, PAGE) as Promise<T>, loaded: () => ({ session, authorization: null }) });
    document.body.append(panel.root);
    await panel.attachSession(session.session.id);
    for (let attempt = 0; attempt < 100 && panel.root.dataset.state !== "completed"; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 10));
    expect(panel.root.dataset.state).toBe("completed");
    const walk = panel.root.querySelector<HTMLElement>('.ab-route[data-network="plan-trip"]')!;
    expect(walk.dataset.state).toBe("completed");
    expect(walk.textContent).toContain("Handoffs 6 of at most 6");
    expect(walk.textContent).toContain("FrontMan → Hotel (the model)");
    const terms = [...panel.root.querySelectorAll("dt")].map((node) => [node.textContent, node.nextElementSibling?.textContent]);
    expect(terms).toContainEqual(["Handoffs", "6 of at most 6"]);
    expect(terms.find(([term]) => term === "Delegation")?.[1]).toMatch(/^at most 6 handoffs, 8 model calls, 3 tool calls, 19 remote calls and 48,000 tokens \(the envelope recorded before the run; 6 handoffs taken, completed\)$/u);
    expect(panel.root.querySelectorAll(".ab-route-decisions tr[data-allowed]")).toHaveLength(7);
    const front = panel.root.querySelector<HTMLElement>('.ab-role-usage tr[data-role="FrontMan"]')!;
    expect(front.textContent).toContain("4 of at most 4");
    expect(front.textContent).toContain("at most 12,000 each time");
    panel.dispose();
  });
});
