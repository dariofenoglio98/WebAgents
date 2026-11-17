// @vitest-environment happy-dom
/**
 * Agent Links on the extension's pages (T66; D-702…D-704): the review's "Linked agents" card
 * (before and after loading, a publisher's words quoted and attributed, the pin and the denial per
 * key, the composed "at most", a slot stated before the run), the join card and the budget-raise
 * card (the core's facts in their order, declining the default), the delegation view in the run
 * panel (the rendered tree is the audit's link events), and Settings → Policies.
 */
import { afterEach, describe, expect, it } from "vitest";

import type { JsonObject } from "../../src/core/json.js";
import { delegationTree } from "../../src/core/links/delegation.js";
import type { PolicyBundle } from "../../src/core/policies/bundle.js";
import type { AuthorizationView, AuthorizeResult, LinksView, PolicyView, Request, RunView, SessionView, SettingsView } from "../../src/extension/messages.js";
import type { RunCardPending } from "../../src/extension/storage/runs.js";
import { newAuthorizeState, originsFor, renderAuthorizeView, type AuthorizeActions } from "../../src/extension/ui/authorize.js";
import { delegationView, figuresText, raiseCard } from "../../src/extension/ui/links.js";
import { RunPanel } from "../../src/extension/ui/run.js";
import { newSettingsPageState, renderSettingsPage } from "../../src/extension/ui/settings-page.js";
import { fixtureOf, grantsOf, linkRoutes, PLANNER_URL, plannerVariant, recordedHotel, SALITUBAM, scriptedWorld, STAYMERE, TRIPWRIGHT, WEBAIR, type ScriptedWorld } from "../helpers/link-world.js";
import { makeHarness, PACKAGE_MEDIA_TYPE, PAGE, type Harness } from "../helpers/shell.js";

afterEach(() => {
  document.body.replaceChildren();
});

interface World {
  h: Harness;
  session: SessionView;
  scripted: ScriptedWorld;
  digest: string;
}

async function world(planner: "planner010" | "planner020" = "planner010", options: { findHotelTokens?: number } = {}): Promise<World> {
  const scripted = await scriptedWorld([planner, "flights", "staymere", ...(planner === "planner020" ? (["salitubam"] as const) : [])], planner === "planner020" ? recordedHotel() : {});
  const variant = options.findHotelTokens === undefined ? null : (await plannerVariant(options.findHotelTokens)).bytes;
  const h = makeHarness({ routes: linkRoutes(planner, variant === null ? {} : { [PLANNER_URL]: { headers: { "content-type": PACKAGE_MEDIA_TYPE, "content-length": String(variant.length) }, body: variant } }), transports: { model: scripted.model, tool: scripted.tool } });
  const opened = (await h.controller.handle({ type: "package.open", url: PLANNER_URL, advertisedOn: null, viewId: "links-ui" }, PAGE)) as SessionView;
  const settings = ((await h.controller.handle({ type: "settings.get" }, PAGE)) as SettingsView).settings;
  settings.models.default_model = "ollama/qwen3:30b";
  await h.controller.handle({ type: "settings.set", settings }, PAGE);
  return { h, session: opened, scripted, digest: opened.summary.package.digest as string };
}

const authorizationOf = (w: World) => w.h.controller.handle({ type: "authorization.get", sessionId: w.session.session.id }, PAGE) as Promise<AuthorizationView>;
const sessionOf = (w: World) => w.h.controller.handle({ type: "package.get", sessionId: w.session.session.id }, PAGE) as Promise<SessionView>;

async function resolved(w: World): Promise<LinksView> {
  const links = (await w.h.controller.handle({ type: "links.resolve", sessionId: w.session.session.id, packageDigest: w.digest }, PAGE)) as LinksView;
  await w.h.controller.handle({ type: "trust.pin", sessionId: w.session.session.id, signerFingerprint: (w.session.summary.publisher as { signer_fingerprint: string }).signer_fingerprint, scope: "publisher" }, PAGE);
  return links;
}

async function authorize(w: World, planner: "planner010" | "planner020" = "planner010"): Promise<AuthorizeResult> {
  const tools: Record<string, boolean> = planner === "planner010" ? { "check-calendar": true } : { "check-calendar": true, "web.search": true };
  const result = (await w.h.controller.handle({ type: "authorization.authorize", sessionId: w.session.session.id, packageDigest: w.digest, decisions: grantsOf(planner === "planner010" ? "examples/link/travel-planner-grants.json" : "examples/link/travel-planner-0.2.0-grants.json"), toolApprovals: tools, resourceSelections: {}, provenance: null, prepare: true }, PAGE)) as AuthorizeResult;
  expect(result.run_plan?.preflight.ready, JSON.stringify(result.plan_refused)).toBe(true);
  return result;
}

/** The authorize view with recording actions. */
async function rendered(w: World, calls: Array<[string, ...unknown[]]>, asked: string[][] = []): Promise<HTMLElement> {
  const actions = {
    onResolveLinks: () => calls.push(["resolve"]),
    onDecideLink: (dependency: string, decision: string) => calls.push(["decide", dependency, decision]),
    onTrustLink: (sessionId: string, signer: string, scope: string) => calls.push(["trust", sessionId, signer, scope]),
    requestOrigins: async (origins: string[]) => {
      asked.push(origins);
      return true;
    },
    rerender: () => undefined,
  } as unknown as AuthorizeActions;
  const root = renderAuthorizeView({ session: await sessionOf(w), view: await authorizationOf(w), models: null, busy: null }, newAuthorizeState(), actions);
  document.body.replaceChildren(root);
  return root;
}

describe("the review's Linked agents card (D-702)", () => {
  it("before loading: says which packages are linked and from where, fetches nothing, and asks Chrome for those origins in the click", async () => {
    const w = await world();
    const calls: Array<[string, ...unknown[]]> = [];
    const asked: string[][] = [];
    const root = await rendered(w, calls, asked);
    const card = root.querySelector<HTMLElement>('[data-links="unresolved"]')!;
    expect(card.textContent).toContain("Linked agents");
    expect(card.textContent).toContain("This agent asks 2 other agents for help");
    expect([...card.querySelectorAll<HTMLElement>("[data-locator]")].map((node) => node.textContent)).toEqual([`org.webagents.webair-flights 0.1.0 from ${WEBAIR}`, `org.webagents.staymere-hotels 0.1.0 from ${STAYMERE}`]);
    expect(card.textContent).toContain("with no cookie and no referrer. Nothing runs, and nothing is granted.");
    expect(w.h.fetchLog.map((entry) => entry.url)).toEqual([PLANNER_URL]);
    card.querySelector<HTMLButtonElement>('button[data-links="resolve"]')!.click();
    await Promise.resolve();
    await Promise.resolve();
    expect(asked).toEqual([[STAYMERE, WEBAIR]]);
    expect(calls).toEqual([["resolve"]]);
  });

  it("after loading: one group per publisher key, each publisher's words quoted and attributed, the trust state as the person's own store sees it, and the composed at most", async () => {
    const w = await world();
    const links = await resolved(w);
    const calls: Array<[string, ...unknown[]]> = [];
    const root = await rendered(w, calls);
    const card = root.querySelector<HTMLElement>('[data-links="resolved"]')!;
    const groups = [...card.querySelectorAll<HTMLElement>("[data-publisher]")];
    expect(groups).toHaveLength(2);
    // With the caller's own publisher, the review shows three publishers: the caller's trust is on its own card.
    expect(new Set([(w.session.summary.publisher as { signer_fingerprint: string }).signer_fingerprint, ...groups.map((group) => group.dataset.publisher)]).size).toBe(3);
    const flights = card.querySelector<HTMLElement>('[data-dependency="webair-flights"]')!;
    expect(flights.dataset.trust).toBe("unknown");
    expect(flights.closest("[data-publisher]")!.textContent).toContain("Signature valid · publisher unknown");
    // A name and a description are the publisher's words: quoted, with whose they are.
    const item = links.links.find((entry) => entry.dependency === "webair-flights")!;
    const words = [...flights.querySelectorAll<HTMLElement>("[data-words]")].map((node) => [node.dataset.words, node.querySelector("q")!.textContent]);
    expect(words).toEqual([["the publisher's name for it", item.package.name], ["the publisher's words", item.package.description]]);
    expect(flights.closest("[data-publisher]")!.querySelector<HTMLElement>('[data-words="the publisher\'s name for itself"] q')!.textContent).toBe("WebAir (fictional demo airline)");
    // What it would be granted, its tool with its endpoint, its records, its worst case: the worker's facts.
    expect(flights.textContent).toContain("model.reasoning (model), allowed for this session");
    expect(flights.querySelector<HTMLElement>('[data-tool="search-flights"]')!.textContent).toContain(`POST ${WEBAIR}/api/v1/travel/flights`);
    expect(flights.querySelector<HTMLElement>('[data-tool="search-flights"]')!.textContent).toContain("approved");
    const rows = (node: HTMLElement) => Object.fromEntries([...node.querySelectorAll<HTMLElement>(".ab-row")].map((row) => [row.querySelector(".ab-row-label")!.textContent, row.querySelector(".ab-row-value")!.textContent]));
    expect(rows(flights)["Your records it asks for"]).toBe("none");
    expect(rows(flights)["At most, each time it is asked"]).toBe("1 model call · tool calls: search-flights ×1 · 3 remote calls · 6,000 tokens · 280 seconds");
    expect(flights.textContent).toContain("publisher_not_trusted");
    expect(card.querySelector<HTMLElement>('[data-at-most="composed"]')!.textContent).toContain("10 model calls · tool calls: check-calendar ×1, hotel-aggregator:search-hotels ×1, webair-flights:search-flights ×1 · 23 remote calls · 92,000 tokens");
    // Trusting a linked publisher's key takes two presses and names that package's own session.
    const trust = flights.querySelector<HTMLButtonElement>('button[data-link-trust="webair-flights"]')!;
    trust.click();
    expect(calls).toEqual([]);
    expect(trust.textContent).toBe("Press again to trust this key");
    trust.click();
    expect(calls).toEqual([["trust", item.session_id, item.publisher.signer_fingerprint, "package"]]);
    card.querySelector<HTMLButtonElement>('button[data-link-decide="hotel-aggregator"]')!.click();
    expect(calls.at(-1)).toEqual(["decide", "hotel-aggregator", "denied"]);
  });

  it("a denied publisher is shown as denied with what follows, and Chrome is asked only for what the accepted agents reach", async () => {
    const w = await world();
    const links = await resolved(w);
    for (const item of links.links) await w.h.controller.handle({ type: "trust.pin", sessionId: item.session_id, signerFingerprint: item.publisher.signer_fingerprint!, scope: "publisher" }, PAGE);
    const before = await authorizationOf(w);
    expect(originsFor(before, { "check-calendar": true }, "ollama/qwen3:30b")).toEqual([STAYMERE, TRIPWRIGHT, WEBAIR].sort());
    await w.h.controller.handle({ type: "links.decide", sessionId: w.session.session.id, packageDigest: w.digest, dependency: "hotel-aggregator", decision: "denied" }, PAGE);
    const calls: Array<[string, ...unknown[]]> = [];
    const root = await rendered(w, calls);
    const denied = root.querySelector<HTMLElement>('[data-dependency="hotel-aggregator"]')!;
    expect(denied.dataset.decision).toBe("denied");
    expect(denied.textContent).toContain("Denied by you");
    expect(denied.textContent).toContain("This run will not ask it. The steps that would are unbound");
    expect(denied.querySelector("[data-tool]")).toBeNull();
    expect(root.querySelector<HTMLElement>('[data-at-most="composed"]')!.textContent).not.toContain("hotel-aggregator");
    expect(originsFor(await authorizationOf(w), { "check-calendar": true }, "ollama/qwen3:30b")).toEqual([TRIPWRIGHT, WEBAIR].sort());
    root.querySelector<HTMLButtonElement>('button[data-link-decide="hotel-aggregator"]')!.click();
    expect(calls).toEqual([["decide", "hotel-aggregator", "undecided"]]);
    // The plan card names what the plan left out.
    const result = await authorize(w);
    expect(result.run_plan!.run_plan.links!["hotel-aggregator"]!.decision).toBe("denied");
  });

  it("a slot is stated before the run: what it may look at, what it may send, the ceiling it must fit, and that the at most already holds it", async () => {
    const w = await world("planner020");
    await resolved(w);
    const root = await rendered(w, []);
    const slot = root.querySelector<HTMLElement>('[data-slot="named-hotel"]')!;
    expect(slot.dataset.join).toBe("allow");
    expect(slot.textContent).toContain("may look at up to three pages");
    expect(slot.textContent).toContain("You are asked on a card before anything of that package reaches the model or runs; no answer is a no. At most 1 card for this step and 2 in a run.");
    expect(slot.textContent).toContain("check_in, check_out, travellers");
    expect(slot.textContent).toContain("At most, for this step2 model calls · tool calls: named-hotel:* ×1 · 3 remote calls · 6,000 tokens · 300 seconds");
    expect(slot.textContent).toContain("One of those model calls is this agent's own, to write its request");
    expect(root.querySelector<HTMLElement>('[data-at-most="composed"]')!.textContent).toContain("14 model calls");
  });
});

describe("a run's cards and the delegation view (D-703, D-704)", () => {
  it("the join card in the run panel: the facts in order, words attributed, declining the default; accepted, the tree shows the join answered and equals the audit's link events", async () => {
    const w = await world("planner020", { findHotelTokens: 6000 });
    const links = await resolved(w);
    for (const item of links.links) await w.h.controller.handle({ type: "trust.pin", sessionId: item.session_id, signerFingerprint: item.publisher.signer_fingerprint!, scope: "publisher" }, PAGE);
    const plan = (await authorize(w, "planner020")).run_plan!.run_plan;
    const session = await sessionOf(w);
    const asked: string[][] = [];
    const panel = new RunPanel({
      send: <T>(request: Request) => w.h.controller.handle(request, PAGE) as Promise<T>,
      loaded: () => ({ session, authorization: null }),
      requestOrigins: async (origins) => {
        asked.push(origins);
        return true;
      },
    });
    document.body.append(panel.root);
    const started = (await w.h.controller.handle({ type: "run.start", sessionId: session.session.id, runPlanId: plan.run_plan_id, runPlanSha256: plan.run_plan_sha256, input: fixtureOf(w.scripted.packages[0]!).input }, PAGE)) as RunView;
    await panel.attachSession(session.session.id);
    const waitFor = async (predicate: () => boolean, label: string) => {
      for (let attempt = 0; attempt < 600 && !predicate(); attempt += 1) {
        panel.onRunEvent({ runId: started.runId, sessionId: session.session.id, status: "running" });
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      if (!predicate()) throw new Error(`timed out waiting for ${label} (${panel.root.dataset.state})`);
    };
    await waitFor(() => panel.root.querySelector(".ab-join-card") !== null, "the join card");
    const card = panel.root.querySelector<HTMLElement>(".ab-join-card")!;
    expect(card.dataset.slot).toBe("named-hotel");
    expect(card.textContent).toContain("This run found another agent. Use it?");
    expect(card.textContent).toContain("Nothing of it has reached the model or run.");
    const terms = [...card.querySelectorAll("dl.ab-defs > dt")].map((node) => node.textContent);
    expect(terms).toEqual(["Publisher key", "Agent", "Named", "Described as", "Found on", "Its tools", "Its permissions", "Your records it asks for", "Model", "The agent may send it", "Why the agent asks", "At most, if you accept", "Within the step's ceiling", "The “at most” you accepted", "This run has left", "Cards"]);
    const value = (term: string) => [...card.querySelectorAll("dl.ab-defs > dt")].find((node) => node.textContent === term)!.nextElementSibling as HTMLElement;
    expect(value("Publisher key").textContent).toContain("Signature valid · publisher unknown");
    expect(value("Named").querySelector<HTMLElement>("[data-words]")!.dataset.words).toBe("the publisher's name for it");
    expect(value("Described as").querySelector<HTMLElement>("[data-words]")!.dataset.words).toBe("the publisher's words");
    expect(value("Why the agent asks").querySelector<HTMLElement>("[data-words]")!.dataset.words).toBe("the agent's words");
    expect(value("Why the agent asks").querySelector("q")!.textContent).toBe("The hotel you named is not among the aggregator's; the page found for it offers its own agent.");
    expect(value("Found on").textContent).toContain(`${SALITUBAM}/`);
    expect(value("The agent may send it").textContent).toBe("check_in, check_out, travellers");
    expect(value("The “at most” you accepted").textContent).toBe("unchanged: it already held this join at the ceiling");
    expect(value("Cards").textContent).toBe("1 of 1 for this step · 1 of 2 in this run");
    expect(card.querySelector<HTMLElement>('[data-tool="check-availability"]')!.textContent).toContain(`POST ${SALITUBAM}/api/v1/hotel/availability`);
    // Declining is the default: it is the primary button, and required permissions only start allowed.
    expect(card.querySelector<HTMLButtonElement>('button[data-card-decide="decline"]')!.className).toContain("ab-button-primary");
    expect(card.querySelector<HTMLButtonElement>('button[data-card-decide="accept"]')!.className).not.toContain("ab-button-primary");
    expect([...card.querySelectorAll<HTMLSelectElement>("[data-permission] select")].map((select) => select.value)).toEqual(["session", "session", "session"]);
    expect(card.textContent).toContain("No answer is a no, and a no lasts for this run");
    // A poll that re-renders the run keeps the card the person is reading.
    panel.onRunEvent({ runId: started.runId, sessionId: session.session.id, status: "running" });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(panel.root.querySelector(".ab-join-card")).toBe(card);
    // Before the decision the view already shows the two planned links answered and the join found.
    const looking = panel.root.querySelector<HTMLElement>('.ab-delegation-view [data-link="named-hotel"]')!;
    expect(looking.dataset.state).toBe("looking");
    card.querySelector<HTMLButtonElement>('button[data-card-decide="accept"]')!.click();
    await waitFor(() => panel.root.dataset.state === "completed", "the run completed");
    // The click asked Chrome for the origin of the tool the card approved, and nothing else.
    expect(asked).toEqual([[SALITUBAM]]);
    expect(panel.root.querySelector(".ab-join-card")).toBeNull();
    const view = panel.root.querySelector<HTMLElement>(".ab-delegation-view")!;
    const shown = [...view.querySelectorAll<HTMLElement>("[data-link]")].map((node) => [node.closest<HTMLElement>("[data-activation]")!.dataset.activation, node.dataset.kind, node.dataset.link, node.dataset.state, node.dataset.package]);
    expect(shown).toEqual([
      ["Flights", "link", "webair-flights", "answered", "org.webagents.webair-flights"],
      ["Hotels", "link", "hotel-aggregator", "answered", "org.webagents.staymere-hotels"],
      ["FindHotel", "join", "named-hotel", "answered", "org.webagents.hotel-salitubam"],
    ]);
    // The rendered tree is the fold of the stored audit: nothing on it that the audit does not hold.
    const stored = (await w.h.runs.getRun(started.runId))!;
    const tree = delegationTree(stored.audit);
    expect(shown).toEqual(tree.activations.flatMap((activation) => activation.links.map((link) => [activation.role, link.kind, link.name, link.state, link.package_id])));
    expect([...view.querySelectorAll<HTMLElement>("[data-activation]")].map((node) => node.dataset.activation)).toEqual(tree.activations.map((activation) => activation.role));
    const events = stored.audit as unknown as JsonObject[];
    const completed = events.filter((event) => event.action === "link.completed");
    for (const event of completed) {
      const name = String(event.dependency ?? event.slot);
      const node = view.querySelector<HTMLElement>(`[data-link="${name}"]`)!;
      const usage = event.usage as { tokens: number; model_calls: number };
      expect(node.textContent).toContain(`${usage.tokens.toLocaleString("en-US")} tokens`);
      expect(node.textContent).toContain("6,000 tokens · 3 remote calls");
    }
    // A message and an input are hashes: the trip's words are nowhere in the view.
    expect(view.textContent).not.toContain("Reykjavik");
    expect(view.textContent).toContain("What was sent");
    expect(view.textContent).toContain("Drawn by this browser from the run's own record.");
    panel.dispose();
  });

  it("the budget-raise card: the person's own limit, what was needed, what it would become; keeping the limit is the default", () => {
    const pending: RunCardPending = { card_id: "card_1", kind: "budget.raise", node_id: "delegate/Writer/draft", timeout_seconds: 119, requested_at: "2026-11-17T10:00:00.000000+00:00", facts: { limit: "tokens", from: 9000, to: 10500, needed: 1500, used: 9000, package_cap: 20000, node_id: "delegate/Writer/draft", reason: null } };
    const calls: unknown[] = [];
    const card = raiseCard(pending, { onDecide: (cardId, answer, origins) => calls.push([cardId, answer, origins]) }, false);
    document.body.append(card);
    expect(card.textContent).toContain("This run reached your limit of 9,000 tokens");
    expect(card.textContent).toContain("The limit is yours (Settings → Run limits), not the agent's: the agent's own cap is never raised. This is asked once in a run.");
    const terms = Object.fromEntries([...card.querySelectorAll("dt")].map((node) => [node.textContent, node.nextElementSibling!.textContent]));
    expect(terms).toEqual({ "Used and held so far": "9,000 tokens", "The next step needs": "1,500 tokens", "Your limit would become": "10,500 tokens (from 9,000)", "The agent's own cap": "20,000 tokens: what you accepted before the run still holds", "Asked at": "delegate/Writer/draft", "Why the agent asks": "it states no reason" });
    const keep = card.querySelector<HTMLButtonElement>('button[data-card-decide="decline"]')!;
    expect(keep.className).toContain("ab-button-primary");
    expect(keep.textContent).toBe("No, keep my limit");
    const raise = card.querySelector<HTMLButtonElement>('button[data-card-decide="accept"]')!;
    expect(raise.textContent).toBe("Raise my limit to 10,500 tokens for this run");
    raise.click();
    keep.click();
    expect(calls).toEqual([["card_1", { accepted: true }, []], ["card_1", { accepted: false }, []]]);
  });

  it("the delegation view draws a raise, a refusal and a denied publisher from the audit and the plan alone", () => {
    const event = (action: string, fields: JsonObject) => ({ action, ...fields }) as never;
    const tree = delegationTree([
      event("network.activated", { role: "Desk", hop: 0, activation: 1, message_hash: "a".repeat(64) }),
      event("link.refused", { node_id: "delegate/Desk/read", dependency: "index", reason: "tokens" }),
      event("budget.requested", { node_id: "delegate/Desk/read", limit: "tokens", from: 9000, to: 10500 }),
      event("budget.raised", { node_id: "delegate/Desk/read", limit: "tokens", from: 9000, to: 10500 }),
      event("link.started", { node_id: "delegate/Desk/read", dependency: "index", package_id: "org.example.index", digest: "b".repeat(64), inner_run_id: "inner", reserved: { tokens: 1500, remote_calls: 1 }, input_hash: "c".repeat(64) }),
      event("link.failed", { node_id: "delegate/Desk/read", dependency: "index", inner_run_id: "inner", error_code: "tool_error", usage: { tokens: 12, remote_calls: 1, model_calls: 0, tool_calls: { lookup: 1 }, compute_calls: 0 } }),
    ]);
    const view = delegationView(tree, [{ dependency: "scribe", package_id: "org.example.scribe", name: "Scribe", version: "1.0.0", signer: "sha256:1", trust: "unknown", decision: "denied" }]);
    document.body.append(view);
    expect([...view.querySelectorAll<HTMLElement>("[data-link]")].map((node) => [node.dataset.link, node.dataset.state])).toEqual([["index", "refused"], ["index", "failed"]]);
    expect(view.querySelector<HTMLElement>("[data-raise]")!.textContent).toBe("Your limit of 9,000 tokens was reached at delegate/Desk/read: you raised it to 10,500.");
    expect(view.querySelector<HTMLElement>("[data-denied]")!.textContent).toBe("Not asked, because you denied the publisher: org.example.scribe (scribe).");
    expect(view.textContent).toContain("tool_error");
    expect(figuresText({ model_calls: 2, tool_calls: {}, compute_calls: 1, remote_calls: 1, tokens: 1000 })).toBe("2 model calls · 1 compute call · 1 remote call · 1,000 tokens");
  });
});

describe("Settings → Policies: what a run may ask (T66)", () => {
  const settings = async () => (await world()).h.controller.handle({ type: "settings.get" }, PAGE) as Promise<SettingsView>;
  const actions = { onSave: () => undefined, onSetKey: () => undefined, onProbe: () => undefined, rerender: () => undefined };

  it("states the join cap and the raise rule; a policy that forbids them is named", async () => {
    const view = await settings();
    const plain = renderSettingsPage(view, null, newSettingsPageState("policies"), actions);
    document.body.append(plain);
    const card = plain.querySelector<HTMLElement>('[data-run-cards="settings"]')!;
    expect([card.dataset.join, card.dataset.raise]).toEqual(["allow", "allow"]);
    expect(card.textContent).toContain("at most 2 cards in a run");
    expect(card.textContent).toContain("by at most half of that limit, and never above the agent's own cap");
    const bundle = { policy_id: "org.example.no-joins", version: "1.0.0", title: "No joins", description: null, issuer: { name: "Example", url: null }, issued_at: "2026-10-01T00:00:00Z", expires_at: "2027-10-01T00:00:00Z", trust_anchors: [], decisions: {}, budget_caps: {}, models: { local_only: false, max_cost_usd_per_run: null }, bindings: null, memory: null, consent: null, links: { join: "forbid", raise: "forbid" } } as PolicyBundle;
    const policy = { subscribed: true, url: "https://policy.example.org/policy.json", key_fingerprint: "sha256:0", state: "current", fetched_at: "2026-10-06T12:00:00Z", last_error: null, bundle, reference: { policy_id: bundle.policy_id, version: bundle.version, title: bundle.title, content_sha256: "0".repeat(64), signer_fingerprint: "sha256:0" } } as unknown as PolicyView;
    const forbidden = renderSettingsPage(view, null, newSettingsPageState("policies"), actions, null, { indexes: null, policy });
    document.body.replaceChildren(forbidden);
    const strict = forbidden.querySelector<HTMLElement>('[data-run-cards="settings"]')!;
    expect([strict.dataset.join, strict.dataset.raise]).toEqual(["forbid", "forbid"]);
    expect(strict.textContent).toContain("Forbidden by your policy org.example.no-joins@1.0.0: such a step answers “policy”, nothing is looked at and no card is shown.");
    expect(strict.textContent).toContain("Forbidden by your policy org.example.no-joins@1.0.0: a run that reaches your limit stops there, without asking.");
    const rows = Object.fromEntries([...forbidden.querySelectorAll("dt")].map((node) => [node.textContent, node.nextElementSibling!.textContent]));
    expect(rows["During a run"]).toBe("joining an agent found during the run: forbidden · raising your run limit: forbidden");
  });
});
