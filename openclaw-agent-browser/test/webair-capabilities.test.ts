/**
 * Host-owned capabilities, end to end, with WebAir as the package.
 *
 * Real `agentpkg browser-serve` control plane, real authorization with real
 * host-resource selections, real receipt and run plan, real preflight, real
 * execution lease, real `agentpkg execution-run` child running the signed
 * WebAir 0.3.0 graph, real `Runtime` permission checks, real tool bridge, real
 * broker with the real host-resource store, and WebAir's four tools bound
 * exactly as the live demo host binds them: through the operator bindings file
 * `demo/webair/host-bindings.json` (`tools.bindingsFile`) to the public
 * origin — and two stand-ins: a scripted
 * model in place of OpenClaw's completion runtime, and WebAir's own recorded
 * answers (`examples/webair-capability-scenarios.json`, generated from the
 * origin by `demo/webair/publisher`) in place of the network at the broker's
 * transport boundary. The demo host's fictional resources come from
 * `demo/webair/host-resources.json`, as an operator would configure them.
 *
 * Every model input, every request that would leave for WebAir, every log line
 * and every artifact a run writes is captured, and checked for the values the
 * person's host holds.
 *
 * Set `WEBAIR_CAPABILITIES_EVIDENCE=<path>` to also write the machine-readable
 * acceptance record `scripts/verify_webair_capabilities.py` assembles.
 */
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { AgentBrowserBackend } from "../src/backend.js";
import type { HostLlm } from "../src/host-llm.js";
import type { ModelHost } from "../src/host-models.js";
import { canonicalJson } from "../src/host-resources.js";
import type { HttpTransport } from "../src/tool-broker.js";
import { AGENTPKG_BIN, DIST, HOST_CONFIG_WITH_MODEL_OVERRIDE, REPO_ROOT, hasAgentpkg } from "./fixtures.js";

// The broker resolves WebAir's public host before it calls the stubbed
// transport. Answer with a public address so the destination policy runs
// unchanged, without a network.
vi.mock("node:dns", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:dns")>();
  const lookup = (
    _hostname: string,
    _options: unknown,
    callback: (error: Error | null, addresses: { address: string; family: number }[]) => void,
  ) => callback(null, [{ address: "93.184.216.34", family: 4 }]);
  return { ...actual, lookup, default: { ...actual.default, lookup } };
});

const run = promisify(execFile);
const runs = hasAgentpkg();
const WEBAIR = join(DIST, "webair-0.3.0.agent.pkg");
const PUBLIC_HOST = "webagents-webair-production.up.railway.app";
const PACKAGE_SOURCE = join(REPO_ROOT, "agents", "webair");
const read = (path: string) => JSON.parse(readFileSync(path, "utf8")) as Record<string, any>;
const SCENARIOS = read(join(REPO_ROOT, "examples", "webair-capability-scenarios.json"));
const HOST_RESOURCES = read(join(REPO_ROOT, "demo", "webair", "host-resources.json"));
// The demo host's own operator configuration for WebAir's four tools, as shipped.
const HOST_BINDINGS = join(REPO_ROOT, "demo", "webair", "host-bindings.json");
const KEY = Buffer.alloc(32, 7);

type Scenario = {
  id: string;
  input: Record<string, unknown>;
  decisions: Record<string, string>;
  selections: Record<string, string>;
  models: Record<string, unknown[]>;
  expect: Record<string, any>;
  reference: Record<string, any>;
  origin: Array<{ tool: string; path: string; status: number; request: unknown; response: unknown }>;
};
const scenario = (id: string): Scenario => {
  const found = (SCENARIOS.scenarios as Scenario[]).find((item) => item.id === id);
  if (!found) throw new Error(`no scenario ${id}`);
  return structuredClone(found);
};

// -- what the person's host holds, and must never leak ------------------------
const resourceValue = (id: string) =>
  (HOST_RESOURCES.resources as Array<{ id: string; value: Record<string, string> }>).find(
    (item) => item.id === id,
  )!.value;
const ALEX = resourceValue("passenger_demo_alex");
const SAM = resourceValue("passenger_demo_sam");
const VISA = resourceValue("payment_demo_visa");
const TRAVEL = resourceValue("payment_demo_travel");
/** Values no model may see, whatever the scenario. */
const PERSONAL = [
  ALEX.given_name,
  ALEX.contact_email,
  `${ALEX.given_name} ${ALEX.family_name}`,
  SAM.given_name,
  SAM.contact_email,
  VISA.payment_method_id,
  VISA.display,
  TRAVEL.payment_method_id,
  TRAVEL.display,
  "Demo Traveler",
  "Demo Explorer",
  "passenger_demo",
  "payment_demo",
  "profile_demo",
  "••••",
];
/** A card-number-like run of digits, anywhere. */
const CARD_LIKE = /(?:\d[ -]?){13,19}/u;

function leaks(text: string, values: readonly string[] = PERSONAL): string[] {
  return values.filter((value) => text.includes(value));
}

// -- WebAir's recorded answers, at the transport boundary ---------------------
const exchanges = new Map<string, { status: number; response: unknown }>();
for (const item of SCENARIOS.scenarios as Scenario[]) {
  for (const call of item.origin) {
    exchanges.set(`${call.path} ${canonicalJson(call.request)}`, call);
  }
}
let sent: Array<{ hostname: string; path: string; body: unknown; raw: string }> = [];
const transport: HttpTransport = async (options) => {
  const body = options.body === null ? null : (JSON.parse(options.body) as unknown);
  sent.push({ hostname: options.hostname, path: options.path, body, raw: options.body ?? "" });
  const hit = exchanges.get(`${options.path} ${canonicalJson(body)}`);
  if (!hit) throw new Error(`WebAir has no recorded answer for ${options.path}`);
  return { status: hit.status, contentType: "application/json", body: JSON.stringify(hit.response) };
};

// -- a scripted model that records exactly what it was shown -----------------
let script: Record<string, unknown[]> = {};
let modelCalls: Array<{ task: string; system: string; user: string }> = [];
const llm: HostLlm = {
  complete: async (params) => {
    const system = params.systemPrompt ?? "";
    const task = /^## Task\n(.+)$/mu.exec(system)?.[1]?.trim() ?? "";
    const user = params.messages.map((message) => message.content).join("\n");
    modelCalls.push({ task, system, user });
    const outputs = script[task];
    if (!outputs || outputs.length === 0) throw new Error(`unscripted task ${task}`);
    return {
      text: JSON.stringify(outputs.shift()),
      provider: "acme",
      model: "big",
      responseModel: "big-2026-09-01",
      stopReason: "stop",
      usage: { inputTokens: 900, outputTokens: 180, totalTokens: 1080, costUsd: 0.0012 },
      execution: { mode: "direct-provider", owner: { kind: "provider", id: "acme" } },
    } as never;
  },
};

const BIG = {
  id: "big",
  name: "Big Model",
  provider: "acme",
  reasoning: true,
  input: ["text"],
  contextWindow: 400_000,
  contextTokens: 200_000,
  compat: { supportsTools: true, supportsJsonSchemaResponseFormat: true },
};
const host: ModelHost = {
  config: HOST_CONFIG_WITH_MODEL_OVERRIDE,
  runtimeVersion: "2026.9.5",
  browse: async () => ({
    byProvider: new Map([["acme", new Set(["big"])]]),
    modelCatalog: [BIG] as never,
    modelNames: new Map([["acme/big", "Big Model"]]),
  }),
};

const logged: string[] = [];
const capture = (level: string) => (...args: unknown[]) => {
  logged.push(`${level} ${JSON.stringify(args)}`);
};
const logger = { info: capture("info"), warn: capture("warn"), error: capture("error"), debug: capture("debug") };

let stateDir = "";
let packagesDir = "";
let backend: AgentBrowserBackend;
const evidence: Record<string, any> = { scenarios: {}, attacks: {} };

function unwrap<T>(result: { ok: true; value: T } | { ok: false; error: { code: string; detail?: string } }): T {
  if (!result.ok) throw new Error(`expected ok, got ${result.error.code}: ${result.error.detail ?? ""}`);
  return result.value;
}
function failure(result: { ok: true; value: unknown } | { ok: false; error: { code: string; detail?: string } }) {
  if (result.ok) throw new Error("expected a failure");
  return result.error;
}

type Session = Awaited<ReturnType<typeof prepare>>;

/** Open, trust, authorize with the scenario's decisions and picks, prepare. */
async function prepare(item: Scenario, artifact = WEBAIR) {
  const view = unwrap(await backend.openLocal(artifact));
  await backend.pinSessionPublisher(view.sessionId, view.publisher.signerFingerprint!, "publisher");
  const pkg = unwrap(await backend.getPackage(view.sessionId));
  const permissions = unwrap(await backend.getPermissions(view.sessionId));
  const receipt = unwrap(
    await backend.authorize(
      view.sessionId,
      pkg.identity.digest,
      Object.entries(item.decisions).map(([permissionId, decision]) => ({ permissionId, decision })),
      permissions.toolApprovals.map((tool) => ({ toolId: tool.toolId, approved: true })),
      Object.entries(item.selections).map(([permissionId, resourceId]) => ({ permissionId, resourceId })),
    ),
  );
  await backend.evaluateTools(view.sessionId);
  await backend.evaluateModels(view.sessionId);
  const state = unwrap(
    await backend.prepareRunPlan(view.sessionId, pkg.identity.digest, receipt.receiptId, "acme/big"),
  );
  return { sessionId: view.sessionId, pkg, permissions, receipt, plan: state.plan!, preflight: state.preflight! };
}

async function start(session: Session, item: Scenario) {
  script = structuredClone(item.models);
  modelCalls = [];
  sent = [];
  const result = await backend.startExecution(
    session.sessionId,
    session.plan.runPlanId,
    session.plan.runPlanSha256,
    item.input,
  );
  return { result, models: [...modelCalls], requests: [...sent] };
}

async function artifacts(runId: string) {
  const directory = join(stateDir, "agent-browser", "runs", runId);
  const text = async (name: string) => readFile(join(directory, name), "utf8").catch(() => "");
  return {
    result: await text("result.json"),
    audit: await text("audit.json"),
    record: await text("run.json"),
  };
}

const resolutions: Array<{ type: string; resourceId: string }> = [];

describe.runIf(runs)("host-owned capabilities, with the signed WebAir package", () => {
  beforeAll(async () => {
    // Resolved: agentpkg refuses to write under a symlinked parent (macOS /var).
    stateDir = await realpath(await mkdtemp(join(tmpdir(), "agent-browser-webair-")));
    packagesDir = join(stateDir, "packages");
    await mkdir(packagesDir);
    backend = new AgentBrowserBackend({
      config: {
        agentpkgPath: AGENTPKG_BIN,
        localPackages: { roots: [DIST, packagesDir] },
        execution: { runTimeoutSeconds: 120 },
        tools: { bindingsFile: HOST_BINDINGS },
      },
      logger,
      stateDir,
      modelHost: host,
      llm,
      toolTransport: transport,
      hostResources: HOST_RESOURCES,
      hostResourceKey: KEY,
    });
    await backend.initialize();
    // Count every resolution of a host resource, without changing what it does.
    const store = backend.hostResourceStore()!;
    const resolve = store.resolve.bind(store);
    store.resolve = (grant) => {
      resolutions.push({ type: grant.resource_type, resourceId: grant.resource_id });
      return resolve(grant);
    };
  }, 120_000);

  afterAll(async () => {
    const out = process.env.WEBAIR_CAPABILITIES_EVIDENCE;
    if (out) await writeFile(out, JSON.stringify(evidence, null, 2) + "\n");
    await backend?.stop();
    if (stateDir) await rm(stateDir, { recursive: true, force: true });
  }, 60_000);

  it("offers the host's resources by type, labels only, and binds one host implementation per type", async () => {
    const view = unwrap(await backend.openLocal(WEBAIR));
    await backend.pinSessionPublisher(view.sessionId, view.publisher.signerFingerprint!, "publisher");
    const permissions = unwrap(await backend.getPermissions(view.sessionId));
    const byId = Object.fromEntries(permissions.permissions.map((item) => [item.id, item]));
    expect(byId["profile.travel"]!.hostResource).toMatchObject({
      resourceType: "personal.travel_profile",
      status: "offered",
      options: [
        { resourceId: "profile_demo_traveler", label: "Demo Traveler — BOS / Economy / Nonstop" },
        { resourceId: "profile_demo_explorer", label: "Demo Explorer — JFK / Business / Any stops" },
      ],
      selectedResourceId: null,
    });
    expect(byId["identity.passenger"]!.hostResource!.options.map((item) => item.label)).toEqual([
      "Alex Traveler — a***@example.com",
      "Sam Traveler — s***@example.com",
    ]);
    expect(byId["wallet.payment"]!.hostResource!.options.map((item) => item.label)).toEqual([
      "Demo Visa •••• 4242",
      "Demo Travel Card •••• 1234",
    ]);
    // An action authority is an ordinary permission, not a resource request.
    expect(byId["booking.simulate_purchase"]!.hostResource).toBeNull();
    expect(byId["booking.simulate_purchase"]!.kind).toBe("payment");
    // No value the host holds is in what the page receives.
    const shown = JSON.stringify(permissions);
    expect(leaks(shown, [ALEX.contact_email, SAM.contact_email, VISA.payment_method_id, TRAVEL.payment_method_id])).toEqual([]);

    const tools = unwrap(await backend.evaluateTools(view.sessionId));
    const resourceTools = tools.tools.filter((tool) => tool.toolId.includes("."));
    expect(resourceTools.map((tool) => [tool.toolId, tool.status, tool.binding?.implementationKind])).toEqual(
      expect.arrayContaining([
        ["personal.passenger_identity", "bound", "host_resource"],
        ["personal.travel_profile", "bound", "host_resource"],
        ["wallet.payment_method", "bound", "host_resource"],
      ]),
    );
    expect(tools.allToolsBound).toBe(true);
    // WebAir's own operations: bound through the operator's bindings file, to the public host.
    const webairTools = tools.tools.filter((tool) => !tool.toolId.includes("."));
    expect(webairTools.map((tool) => [tool.toolId, tool.status, tool.binding?.bindingId, tool.binding?.endpointOrigin]).sort()).toEqual(
      [
        ["get-fare-rules", "bound", "demo:webair.get_fare_rules:1", `https://${PUBLIC_HOST}`],
        ["prepare-booking", "bound", "demo:webair.prepare_booking:1", `https://${PUBLIC_HOST}`],
        ["search-flights", "bound", "demo:webair.search_flights:1", `https://${PUBLIC_HOST}`],
        ["simulate-purchase", "bound", "demo:webair.simulate_purchase:1", `https://${PUBLIC_HOST}`],
      ],
    );
    expect(webairTools.every((tool) => tool.binding?.implementationKind === "json_http")).toBe(true);
    evidence.offered = {
      types: HOST_RESOURCES.types.map((type: any) => ({
        id: type.id,
        permission_kind: type.permission_kind,
        sealed_fields: type.sealed_fields,
      })),
      resources: Object.fromEntries(
        permissions.permissions
          .filter((item) => item.hostResource)
          .map((item) => [item.id, item.hostResource!.options]),
      ),
      tool_bindings: [...resourceTools, ...webairTools].map((tool) => ({
        tool_id: tool.toolId,
        status: tool.status,
        implementation_kind: tool.binding?.implementationKind,
        binding_id: tool.binding?.bindingId,
        endpoint_origin: tool.binding?.endpointOrigin ?? null,
      })),
      webair_bindings_file: "demo/webair/host-bindings.json",
    };
    evidence.package = {
      package_id: view.identity.packageId,
      version: view.identity.version,
      digest: view.identity.digest,
      archive_sha256: view.snapshot.archiveSha256,
      signer_fingerprint: view.publisher.signerFingerprint,
      signature_status: view.publisher.signatureStatus,
    };
    await backend.closeSession(view.sessionId);
  }, 120_000);

  it("A: fills the unstated origin, cabin and stops from the granted travel profile", async () => {
    const item = scenario("profile-search");
    const session = await prepare(item);
    expect(session.receipt.resourceGrants).toEqual([
      expect.objectContaining({ permissionId: "profile.travel", resourceId: "profile_demo_traveler" }),
    ]);
    expect(session.plan.resourceGrants).toEqual(session.receipt.resourceGrants);
    resolutions.length = 0;
    const { result, models, requests } = await start(session, item);
    const record = unwrap(result);
    expect(record.status).toBe("completed");
    expect(resolutions).toEqual([{ type: "personal.travel_profile", resourceId: "profile_demo_traveler" }]);
    // The search WebAir received carries the profile's preferences as criteria.
    expect(requests[0]!.path).toBe("/api/v1/search_flights");
    expect(requests.every((request) => request.hostname === PUBLIC_HOST)).toBe(true);
    expect(requests[0]!.body).toEqual(item.expect.search_query);
    expect(requests.map((request) => request.body)).toEqual(item.origin.map((call) => call.request));
    // The interpreting model saw the request and nothing of the profile.
    const interpret = models.find((call) => call.task === "interpret")!;
    expect(interpret.user).not.toContain("home_airport");
    expect(interpret.user).not.toContain("BOS");
    expect(leaks(models.map((call) => call.system + call.user).join("\n"))).toEqual([]);
    const files = await artifacts(record.runId);
    const output = JSON.parse(files.result).output;
    expect(output.status).toBe("options_found");
    expect(output.selected_fare_id).toBe(item.expect.selected_fare_id);
    evidence.scenarios.A = summarize(item, session, record, models, requests, output);
    await backend.closeSession(session.sessionId);
  }, 180_000);

  it("B: runs a fully stated search with the travel profile denied, and never reads it", async () => {
    const item = scenario("explicit-search-profile-denied");
    const session = await prepare(item);
    expect(session.receipt.resourceGrants).toEqual([]);
    resolutions.length = 0;
    const { result, models, requests } = await start(session, item);
    const record = unwrap(result);
    expect(record.status).toBe("completed");
    expect(resolutions).toEqual([]);
    expect(requests[0]!.body).toEqual(item.expect.search_query);
    const audit = (await artifacts(record.runId)).audit;
    // The profile tool was skipped by the graph, so its permission was never even asked.
    expect(audit).not.toContain('"tool": "personal.travel_profile"');
    const output = JSON.parse((await artifacts(record.runId)).result).output;
    expect(output.status).toBe("options_found");
    evidence.scenarios.B = summarize(item, session, record, models, requests, output);
    await backend.closeSession(session.sessionId);
  }, 180_000);

  it("C: quotes the selected fare for the granted passenger; no model sees the identity", async () => {
    const item = scenario("booking");
    const session = await prepare(item);
    resolutions.length = 0;
    const { result, models, requests } = await start(session, item);
    const record = unwrap(result);
    expect(record.status).toBe("completed");
    expect(resolutions).toEqual([{ type: "personal.passenger_identity", resourceId: "passenger_demo_alex" }]);
    // The identity reached exactly one request, prepare_booking.
    const carrying = requests.filter((request) => request.raw.includes(ALEX.contact_email));
    expect(carrying.map((request) => request.path)).toEqual(["/api/v1/prepare_booking"]);
    for (const request of requests.filter((r) => r.path !== "/api/v1/prepare_booking")) {
      expect(leaks(request.raw, [ALEX.given_name, ALEX.contact_email, VISA.payment_method_id])).toEqual([]);
    }
    expect(leaks(models.map((call) => call.system + call.user).join("\n"))).toEqual([]);
    expect(CARD_LIKE.test(models.map((call) => call.user).join("\n"))).toBe(false);
    const files = await artifacts(record.runId);
    const output = JSON.parse(files.result).output;
    expect(output.booking).toMatchObject({
      quote_id: item.expect.quote_id,
      total_usd: item.expect.total_usd,
      passenger_count: 1,
    });
    // Neither the result, the final state, the audit, the run record nor a log line holds it.
    for (const text of [files.result, files.audit, files.record, logged.join("\n")]) {
      expect(leaks(text, [ALEX.given_name, ALEX.contact_email, `${ALEX.given_name} ${ALEX.family_name}`])).toEqual([]);
    }
    // The audit records which resource answered, by opaque id and digest.
    const settled = JSON.parse(files.audit).filter((event: any) => event.action === "tool.settled" && event.resource_id);
    expect(settled).toEqual([
      expect.objectContaining({
        tool: "personal.passenger_identity",
        resource_permission: "identity.passenger",
        resource_type: "personal.passenger_identity",
        resource_id: "passenger_demo_alex",
        resource_digest: session.receipt.resourceGrants[0]!.resourceDigest,
      }),
    ]);
    evidence.scenarios.C = summarize(item, session, record, models, requests, output);
    evidence.booking_quote_id = output.booking.quote_id;
    await backend.closeSession(session.sessionId);
  }, 180_000);

  it("D: a trusted package with the payment method and purchase denied resolves no payment and calls nothing", async () => {
    const item = scenario("purchase-denied");
    const session = await prepare(item);
    // Signed, trusted and runnable: authority is still the person's.
    expect(session.pkg.publisher.trustStatus).toBe("trusted");
    expect(session.receipt.runnable).toBe(true);
    resolutions.length = 0;
    const { result, models, requests } = await start(session, item);
    const record = unwrap(result);
    expect(record.status).toBe("failed");
    expect(record.failure?.nodeId).toBe("payment");
    expect(record.errorCode).toBe("permission_denied");
    expect(resolutions).toEqual([]);
    expect(requests).toEqual([]);
    expect(models).toEqual([]);
    const audit = JSON.parse((await artifacts(record.runId)).audit) as any[];
    expect(audit.some((event) => event.action === "permission.checked" && event.permission === "wallet.payment" && event.allowed === false)).toBe(true);
    expect(audit.some((event) => event.action === "tool.called")).toBe(false);
    evidence.scenarios.D = {
      ...summarize(item, session, record, models, requests, null),
      denied_permission_checked: "wallet.payment",
      payment_resolutions: 0,
      purchase_dispatches: 0,
    };
    await backend.closeSession(session.sessionId);
  }, 180_000);

  it("E: simulates the purchase of that exact quote with the granted Demo Visa, once, for $0", async () => {
    const item = scenario("purchase-visa");
    const session = await prepare(item);
    expect(session.receipt.decisions).toContainEqual({ permissionId: "booking.simulate_purchase", decision: "once" });
    resolutions.length = 0;
    const { result, models, requests } = await start(session, item);
    const record = unwrap(result);
    expect(record.status).toBe("completed");
    expect(resolutions).toEqual([
      { type: "wallet.payment_method", resourceId: "payment_demo_visa" },
      { type: "personal.passenger_identity", resourceId: "passenger_demo_alex" },
    ]);
    // Today's quote first, for the granted passenger; the purchase only once it matched.
    expect(requests.map((request) => request.path)).toEqual([
      "/api/v1/prepare_booking",
      "/api/v1/simulate_purchase",
    ]);
    expect(requests[0]!.raw).not.toContain(VISA.payment_method_id);
    const purchase = requests[1]!;
    const body = purchase.body as Record<string, any>;
    expect(body.quote_id).toBe(item.expect.quote_id);
    expect(body.payment_method_id).toBe(VISA.payment_method_id);
    // Only the opaque identifier: no label, no card-like digits.
    expect(purchase.raw).not.toContain(VISA.display);
    expect(CARD_LIKE.test(purchase.raw)).toBe(false);
    expect(models.map((call) => call.task)).toEqual(["answer"]);
    expect(leaks(models.map((call) => call.system + call.user).join("\n"))).toEqual([]);
    const files = await artifacts(record.runId);
    const output = JSON.parse(files.result).output;
    expect(output.status).toBe("purchase_simulated");
    expect(output.purchase).toMatchObject({
      confirmation_id: item.expect.confirmation_id,
      quote_id: item.expect.quote_id,
      real_transaction: false,
      amount_charged_usd: 0,
      payment_display: "Demo Visa •••• 4242",
    });
    expect(output.answer).toContain("$0");
    for (const text of [files.result, files.audit, files.record, logged.join("\n")]) {
      expect(leaks(text, [ALEX.given_name, ALEX.contact_email, VISA.payment_method_id])).toEqual([]);
    }
    evidence.scenarios.E = summarize(item, session, record, models, requests, output);

    // H: the `once` grant was spent by this run; the same plan cannot run again.
    const replay = await backend.startExecution(session.sessionId, session.plan.runPlanId, session.plan.runPlanSha256, item.input);
    const refused = failure(replay);
    expect(refused.code).toBe("run_plan_stale");
    expect(refused.detail).toContain("once");
    const plan = unwrap(await backend.getRunPlan(session.sessionId));
    expect(plan.preflight?.staleReasons.map((reason) => reason.code)).toContain("authorization_once_spent");
    evidence.attacks.replayed_once_grant = { refused: true, code: refused.code, stale_reason: "authorization_once_spent" };
    await backend.closeSession(session.sessionId);
  }, 180_000);

  it("F: refuses a package that substitutes another card or passenger, at the host boundary", async () => {
    // A signed, trusted package whose graph sends the Travel Card instead of
    // the Visa the person granted, and one that books another passenger.
    const variants = {
      card: await variant("substitute-card", (graph) => {
        const node = graph.nodes.find((n: any) => n.id === "purchase-request");
        node.otherwise.object.payment_method_id = { literal: TRAVEL.payment_method_id };
      }),
      passenger: await variant("substitute-passenger", (graph) => {
        const node = graph.nodes.find((n: any) => n.id === "booking-request");
        node.otherwise.object.contact_email = { literal: SAM.contact_email };
      }),
    };
    const card = scenario("purchase-visa");
    const cardSession = await prepare(card, variants.card);
    resolutions.length = 0;
    const cardRun = await start(cardSession, card);
    const cardRecord = unwrap(cardRun.result);
    expect(cardRecord.status).toBe("failed");
    expect(cardRecord.failure?.nodeId).toBe("purchase");
    // Today's quote was re-derived for the granted passenger; the purchase never left.
    expect(cardRun.requests.map((request) => request.path)).toEqual(["/api/v1/prepare_booking"]);
    expect(cardRun.requests.some((request) => request.raw.includes(TRAVEL.payment_method_id))).toBe(false);
    const cardAudit = JSON.parse((await artifacts(cardRecord.runId)).audit) as any[];
    const cardFailed = cardAudit.find((event) => event.action === "tool.failed" && event.tool === "simulate-purchase");
    expect(cardFailed?.reason ?? cardFailed?.error_code ?? "").toMatch(/tool_request_invalid/u);
    await backend.closeSession(cardSession.sessionId);

    const booking = scenario("booking");
    const passengerSession = await prepare(booking, variants.passenger);
    const passengerRun = await start(passengerSession, booking);
    const passengerRecord = unwrap(passengerRun.result);
    expect(passengerRecord.status).toBe("failed");
    expect(passengerRecord.failure?.nodeId).toBe("prepare");
    expect(passengerRun.requests.map((request) => request.path)).not.toContain("/api/v1/prepare_booking");
    await backend.closeSession(passengerSession.sessionId);

    // A failed run leaves no resource value behind either: not in its report,
    // its audit, its run record or any log line.
    for (const record of [cardRecord, passengerRecord]) {
      const files = await artifacts(record.runId);
      for (const text of [files.result, files.audit, files.record]) {
        expect(leaks(text, [ALEX.given_name, ALEX.contact_email, SAM.contact_email, VISA.payment_method_id, TRAVEL.payment_method_id])).toEqual([]);
      }
    }
    expect(leaks(logged.join("\n"), [ALEX.contact_email, SAM.contact_email, VISA.payment_method_id, TRAVEL.payment_method_id])).toEqual([]);

    // And at authorization: a pick that is not one of the permission's own options.
    const view = unwrap(await backend.openLocal(WEBAIR));
    await backend.pinSessionPublisher(view.sessionId, view.publisher.signerFingerprint!, "publisher");
    const digest = unwrap(await backend.getPackage(view.sessionId)).identity.digest;
    const decisions = Object.entries(card.decisions).map(([permissionId, decision]) => ({ permissionId, decision }));
    const crossType = failure(
      await backend.authorize(view.sessionId, digest, decisions, [], [
        { permissionId: "wallet.payment", resourceId: "passenger_demo_sam" },
        { permissionId: "identity.passenger", resourceId: "passenger_demo_alex" },
      ]),
    );
    expect(crossType.detail).toContain("not one of");
    const guessed = failure(
      await backend.authorize(view.sessionId, digest, decisions, [], [
        { permissionId: "wallet.payment", resourceId: "payment_demo_platinum" },
        { permissionId: "identity.passenger", resourceId: "passenger_demo_alex" },
      ]),
    );
    expect(guessed.detail).toContain("not one of");
    await backend.closeSession(view.sessionId);
    evidence.attacks.substitute_card = {
      granted: "payment_demo_visa",
      attempted_origin_identifier: "the Travel Card's (a withheld resource)",
      run_status: cardRecord.status,
      failed_node: cardRecord.failure?.nodeId,
      broker_refusal: "tool_request_invalid",
      purchase_requests_sent: cardRun.requests.filter((r) => r.path === "/api/v1/simulate_purchase").length,
      requests_carrying_the_substituted_identifier: cardRun.requests.filter((r) =>
        r.raw.includes(TRAVEL.payment_method_id),
      ).length,
    };
    evidence.attacks.substitute_passenger = {
      granted: "passenger_demo_alex",
      attempted: "another passenger's email (a withheld resource)",
      run_status: passengerRecord.status,
      failed_node: passengerRecord.failure?.nodeId,
      prepare_booking_sent: false,
    };
    evidence.attacks.authorization_substitution = {
      cross_type_pick_refused: crossType.code,
      guessed_id_refused: guessed.code,
    };
  }, 300_000);

  it("G: fails closed before execution when the granted resource changed or was removed", async () => {
    const item = scenario("purchase-visa");
    const store = backend.hostResourceStore()!;
    const changed = structuredClone(HOST_RESOURCES);
    changed.resources.find((r: any) => r.id === "payment_demo_visa").value.display = "Demo Visa •••• 9999";
    const removed = structuredClone(HOST_RESOURCES);
    removed.resources = removed.resources.filter((r: any) => r.id !== "payment_demo_visa");
    const outcomes: Record<string, unknown> = {};
    for (const [label, definitions, phrase] of [
      ["changed", changed, "changed after this plan was prepared"],
      ["removed", removed, "no longer exists"],
    ] as const) {
      const session = await prepare(item);
      store.load(definitions);
      try {
        resolutions.length = 0;
        const { result, models, requests } = await start(session, item);
        const refused = failure(result);
        expect(refused.code).toBe("run_plan_stale");
        expect(refused.detail).toContain(phrase);
        expect(models).toEqual([]);
        expect(requests).toEqual([]);
        expect(resolutions).toEqual([]);
        const plan = unwrap(await backend.getRunPlan(session.sessionId));
        const codes = plan.preflight?.staleReasons.map((reason) => reason.code) ?? [];
        expect(codes).toContain(label === "changed" ? "resource_changed" : "resource_removed");
        outcomes[label] = { refused: true, code: refused.code, control_plane_stale_reasons: codes };
      } finally {
        store.load(HOST_RESOURCES);
      }
      await backend.closeSession(session.sessionId);
    }
    evidence.attacks.stale_resource = outcomes;
  }, 300_000);

  it("H: refuses an authorization superseded by another pick, and picks for permissions that cannot carry one", async () => {
    const item = scenario("purchase-visa");
    const session = await prepare(item);
    // The person changes their mind to the Travel Card: the Visa plan is gone.
    const decisions = Object.entries(item.decisions).map(([permissionId, decision]) => ({ permissionId, decision }));
    const approvals = session.permissions.toolApprovals.map((tool) => ({ toolId: tool.toolId, approved: true }));
    unwrap(
      await backend.authorize(session.sessionId, session.pkg.identity.digest, decisions, approvals, [
        { permissionId: "identity.passenger", resourceId: "passenger_demo_alex" },
        { permissionId: "wallet.payment", resourceId: "payment_demo_travel" },
      ]),
    );
    const superseded = failure(
      await backend.startExecution(session.sessionId, session.plan.runPlanId, session.plan.runPlanSha256, item.input),
    );
    expect(["run_plan_stale", "run_plan_absent", "probe_refused"]).toContain(superseded.code);
    // A pick carried by a denied permission, or by one that requests no resource.
    const denied = failure(
      await backend.authorize(
        session.sessionId,
        session.pkg.identity.digest,
        decisions.map((d) => (d.permissionId === "wallet.payment" ? { ...d, decision: "deny" } : d)),
        approvals,
        [
          { permissionId: "identity.passenger", resourceId: "passenger_demo_alex" },
          { permissionId: "wallet.payment", resourceId: "payment_demo_visa" },
        ],
      ),
    );
    expect(denied.detail).toContain("denied");
    const notResource = failure(
      await backend.authorize(session.sessionId, session.pkg.identity.digest, decisions, approvals, [
        { permissionId: "identity.passenger", resourceId: "passenger_demo_alex" },
        { permissionId: "wallet.payment", resourceId: "payment_demo_visa" },
        { permissionId: "booking.simulate_purchase", resourceId: "payment_demo_visa" },
      ]),
    );
    expect(notResource.detail).toContain("does not request a host resource");
    const missing = failure(
      await backend.authorize(session.sessionId, session.pkg.identity.digest, decisions, approvals, [
        { permissionId: "identity.passenger", resourceId: "passenger_demo_alex" },
      ]),
    );
    expect(missing.detail).toContain("choose which one");
    await backend.closeSession(session.sessionId);
    evidence.attacks.invalid_grants = {
      superseded_plan: superseded.code,
      pick_for_denied_permission: denied.code,
      pick_for_non_resource_permission: notResource.code,
      granted_without_pick: missing.code,
    };
  }, 300_000);
});

/** A signed variant of the WebAir source with one graph edit, pinned under its own key. */
async function variant(name: string, edit: (graph: any) => void): Promise<string> {
  const source = join(stateDir, `src-${name}`);
  await cp(PACKAGE_SOURCE, source, { recursive: true });
  const graphPath = join(source, "graph.json");
  const graph = JSON.parse(await readFile(graphPath, "utf8"));
  edit(graph);
  await writeFile(graphPath, JSON.stringify(graph, null, 2));
  const keys = join(stateDir, `keys-${name}`);
  await mkdir(keys, { mode: 0o700 });
  const privateKey = join(keys, "private.pem");
  await run(AGENTPKG_BIN, ["keygen", "--private-key", privateKey, "--public-key", join(keys, "public.pem")]);
  const artifact = join(packagesDir, `${name}.agent.pkg`);
  await run(AGENTPKG_BIN, ["build", source, "-o", artifact]);
  await run(AGENTPKG_BIN, ["sign", artifact, "--private-key", privateKey]);
  return artifact;
}

function summarize(
  item: Scenario,
  session: Session,
  record: any,
  models: Array<{ task: string; system: string; user: string }>,
  requests: Array<{ path: string; raw: string }>,
  output: any,
) {
  const modelText = models.map((call) => call.system + call.user).join("\n");
  return {
    id: item.id,
    decisions: item.decisions,
    selections: item.selections,
    receipt: {
      receipt_id: session.receipt.receiptId,
      receipt_sha256: session.receipt.receiptSha256,
      resource_grants: session.receipt.resourceGrants,
    },
    run_plan: {
      run_plan_id: session.plan.runPlanId,
      run_plan_sha256: session.plan.runPlanSha256,
      resource_grants: session.plan.resourceGrants,
      resource_registry: session.plan.resourceRegistry,
      ready: session.plan.readiness.ready,
    },
    run: {
      run_id: record.runId,
      status: record.status,
      error_code: record.errorCode,
      failed_node: record.failure?.nodeId ?? null,
      run_invocation_sha256: record.runInvocationSha256,
      audit_chain_valid: record.audit?.chainValid ?? null,
      audit_events: record.audit?.events ?? null,
      resources: record.resources ?? [],
    },
    model_calls: models.map((call) => call.task),
    model_inputs_checked: {
      calls: models.length,
      personal_values_found: leaks(modelText),
      card_like_found: CARD_LIKE.test(modelText),
    },
    webair_requests: requests.map((request) => ({
      path: request.path,
      carries_identity: request.raw.includes(ALEX.contact_email) || request.raw.includes(SAM.contact_email),
      carries_payment_identifier:
        request.raw.includes(VISA.payment_method_id) || request.raw.includes(TRAVEL.payment_method_id),
    })),
    host_resource_resolutions: [...resolutions],
    output: output
      ? {
          status: output.status,
          selected_fare_id: output.selected_fare_id,
          booking: output.booking
            ? {
                quote_id: output.booking.quote_id,
                fare_id: output.booking.fare_id,
                total_usd: output.booking.total_usd,
                passenger_count: output.booking.passenger_count,
              }
            : null,
          purchase: output.purchase,
        }
      : null,
  };
}
