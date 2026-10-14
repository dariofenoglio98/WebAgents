/**
 * Host permissions as the controller applies them (T16, D-190, D-193): a fetch to an origin
 * Chrome does not grant is refused by name before any byte moves; a plan is prepared only with
 * its origins granted and lists them; a grant revoked after the plan blocks Run by name; the
 * discovery script is registered for the sites the person chose and nowhere else; the run's
 * start message carries the plan's origins and the execution host refuses any other destination.
 */
import { describe, expect, it } from "vitest";

import { CoreError } from "../../src/core/errors.js";
import type { AuthorizeResult, PermissionsView, RunPlanState, RunReadiness, SessionView, SettingsView } from "../../src/extension/messages.js";
import { EVERY_SITE_PATTERN } from "../../src/extension/storage/permissions.js";
import { originGuard } from "../../src/extension/execution/execute.js";
import { TransportError, type HttpTransport } from "../../src/core/models/transport.js";
import { SHIPPED } from "../helpers/paths.js";
import { makeHarness, PACKAGE_URL, PAGE, SITE_ORIGIN, TAB, WEBAIR_040_URL, type Harness } from "../helpers/shell.js";
import { scriptedOllama, scriptedOrigin, webairModelAnswers } from "../helpers/host.js";

const QWEN = "ollama/qwen3:30b";
const WEBAIR_PATTERN = `${SITE_ORIGIN}/*`;
/** WebAir 0.4.0 declares its tools at the public origin, whatever site advertises the package. */
const TOOLS_ORIGIN = "https://webagents-webair-production.up.railway.app";
const TOOLS_PATTERN = `${TOOLS_ORIGIN}/*`;

async function refused(promise: Promise<unknown>): Promise<CoreError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof CoreError) return error;
    throw error;
  }
  throw new Error("expected a CoreError");
}

async function trustedSession(h: Harness): Promise<SessionView> {
  const view = (await h.controller.handle({ type: "package.open", url: WEBAIR_040_URL, advertisedOn: `${SITE_ORIGIN}/`, viewId: "test" }, PAGE)) as SessionView;
  await h.controller.handle({ type: "trust.pin", sessionId: view.session.id, signerFingerprint: SHIPPED.webair040.fingerprint, scope: "publisher" }, PAGE);
  const current = (await h.controller.handle({ type: "settings.get" }, PAGE)) as SettingsView;
  current.settings.models.default_model = QWEN;
  await h.controller.handle({ type: "settings.set", settings: current.settings }, PAGE);
  return view;
}

describe("fetching needs Chrome's grant", () => {
  it("opening a package, reading a website and adding an index are refused origin_not_granted, naming the origin, before any request", async () => {
    const h = makeHarness({ permissions: [] });
    const open = await refused(h.controller.handle({ type: "package.open", url: PACKAGE_URL, advertisedOn: null }, PAGE));
    expect(open).toMatchObject({ code: "origin_not_granted", status: 403, details: { origins: [SITE_ORIGIN] } });
    expect(open.message).toContain(SITE_ORIGIN);
    const website = await refused(h.controller.handle({ type: "website.discover", url: `${SITE_ORIGIN}/` }, PAGE));
    expect(website.code).toBe("origin_not_granted");
    const index = await refused(h.controller.handle({ type: "indexes.add", url: "https://index.example/agents.json", publicKeyPem: "-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=\n-----END PUBLIC KEY-----" }, PAGE));
    expect(index.code).toBe("origin_not_granted");
    expect(h.fetchLog).toHaveLength(0);
    // Granted (the page asked Chrome in the click): the same request succeeds.
    h.permissions.grantedPatterns.add(WEBAIR_PATTERN);
    const view = (await h.controller.handle({ type: "package.open", url: PACKAGE_URL, advertisedOn: null }, PAGE)) as SessionView;
    expect(view.summary.package.digest).toBe(SHIPPED.webair.digest);
    expect(h.fetchLog.map((entry) => entry.url)).toEqual([PACKAGE_URL]);
  });

  it("the every-site grant covers any HTTPS origin, and a malformed URL is the URL gate's business, not a permission's", async () => {
    const h = makeHarness({ permissions: [EVERY_SITE_PATTERN] });
    const view = (await h.controller.handle({ type: "package.open", url: PACKAGE_URL, advertisedOn: null }, PAGE)) as SessionView;
    expect(view.summary.package.digest).toBe(SHIPPED.webair.digest);
    const bad = await refused(h.controller.handle({ type: "package.open", url: "http://webair.example/agent.pkg", advertisedOn: null }, PAGE));
    expect(bad.code).toBe("url_rejected");
  });
});

describe("a plan's origins", () => {
  it("are computed per part for the page, verified at Prepare, listed with the plan, and recorded as the package's grant", async () => {
    const h = makeHarness({ permissions: [WEBAIR_PATTERN, TOOLS_PATTERN] });
    const session = await trustedSession(h);
    const view = (await h.controller.handle({ type: "authorization.get", sessionId: session.session.id }, PAGE)) as { origins: { package: string | null; tools: Record<string, string[]>; providers: Record<string, string | null> }; secrets: string };
    expect(view.secrets).toBe("unlocked");
    expect(view.origins.package).toBe(SITE_ORIGIN);
    expect(view.origins.tools).toEqual({ "get-fare-rules": [TOOLS_ORIGIN], "prepare-booking": [TOOLS_ORIGIN], "search-flights": [TOOLS_ORIGIN], "simulate-purchase": [TOOLS_ORIGIN] });
    expect(view.origins.providers).toEqual({ ollama: null, openai: "https://api.openai.com", anthropic: "https://api.anthropic.com", "chrome-builtin": null });
    const result = (await h.controller.handle({ type: "authorization.useProfile", sessionId: session.session.id, packageDigest: SHIPPED.webair040.digest, profileId: "search", resourceSelections: {}, prepare: true }, PAGE)) as AuthorizeResult;
    expect(result.run_plan?.preflight.ready).toBe(true);
    expect(result.run_plan?.origins).toEqual([
      { origin: TOOLS_ORIGIN, roles: ["tool"], subjects: ["get-fare-rules", "search-flights"], granted: true },
      { origin: SITE_ORIGIN, roles: ["package"], subjects: ["package"], granted: true },
    ]);
    const permissions = (await h.controller.handle({ type: "permissions.get" }, PAGE)) as PermissionsView;
    const purpose = { kind: "package", subject: SHIPPED.webair040.packageId, label: "WebAir Travel Agent" };
    expect(permissions.origins).toEqual([
      { origin: TOOLS_ORIGIN, pattern: TOOLS_PATTERN, purposes: [purpose], recorded_at: expect.any(String), granted: true },
      { origin: SITE_ORIGIN, pattern: WEBAIR_PATTERN, purposes: [purpose], recorded_at: expect.any(String), granted: true },
    ]);
    expect(permissions.detect_everywhere).toBe(false);
    expect(h.events).toContainEqual({ type: "event.permissions" });
  });

  it("a plan whose origin is not granted is refused by name with the missing origins; granting it makes the same request succeed", async () => {
    const h = makeHarness({ permissions: [WEBAIR_PATTERN] });
    // The package was opened from its site; the tools' origin was never granted.
    const session = await trustedSession(h);
    const result = (await h.controller.handle({ type: "authorization.useProfile", sessionId: session.session.id, packageDigest: SHIPPED.webair040.digest, profileId: "search", resourceSelections: {}, prepare: true }, PAGE)) as AuthorizeResult;
    expect(result.receipt.runnable).toBe(true);
    expect(result.run_plan).toBeNull();
    expect(result.plan_refused).toEqual([{ code: "origins_not_granted", message: expect.stringContaining(TOOLS_ORIGIN), subject: TOOLS_ORIGIN }]);
    const direct = await refused(h.controller.handle({ type: "runplan.prepare", sessionId: session.session.id, packageDigest: SHIPPED.webair040.digest, receiptId: result.receipt.receipt_id, modelId: QWEN }, PAGE));
    expect(direct).toMatchObject({ code: "run_plan_refused", details: { missing_origins: [TOOLS_ORIGIN] } });
    h.permissions.grantedPatterns.add(TOOLS_PATTERN);
    const plan = (await h.controller.handle({ type: "runplan.prepare", sessionId: session.session.id, packageDigest: SHIPPED.webair040.digest, receiptId: result.receipt.receipt_id, modelId: QWEN }, PAGE)) as RunPlanState;
    expect(plan.preflight.ready).toBe(true);
    expect(plan.origins.map((item) => [item.origin, item.granted])).toEqual([[TOOLS_ORIGIN, true], [SITE_ORIGIN, true]]);
  });

  it("a grant revoked after the plan blocks Run by name, and Revoke in Settings makes Chrome forget the origin", async () => {
    const h = makeHarness({ permissions: [WEBAIR_PATTERN, TOOLS_PATTERN] });
    const session = await trustedSession(h);
    await h.controller.handle({ type: "authorization.useProfile", sessionId: session.session.id, packageDigest: SHIPPED.webair040.digest, profileId: "search", resourceSelections: {}, prepare: true }, PAGE);
    const ready = (await h.controller.handle({ type: "run.readiness", sessionId: session.session.id }, PAGE)) as RunReadiness;
    expect(ready.ready).toBe(true);
    expect(ready.checks).toContain("origins_granted");
    const revoked = (await h.controller.handle({ type: "permissions.revoke", origins: [TOOLS_ORIGIN] }, PAGE)) as PermissionsView;
    expect(revoked.origins.map((item) => item.origin)).toEqual([SITE_ORIGIN]);
    expect(h.permissions.grantedPatterns.has(TOOLS_PATTERN)).toBe(false);
    const blocked = (await h.controller.handle({ type: "run.readiness", sessionId: session.session.id }, PAGE)) as RunReadiness;
    expect(blocked).toMatchObject({ ready: false, blocker: { code: "origins_not_granted" }, missing_origins: [TOOLS_ORIGIN] });
    expect(blocked.blocker?.message).toContain(TOOLS_ORIGIN);
    const plan = (await h.controller.handle({ type: "runplan.get", sessionId: session.session.id }, PAGE)) as RunPlanState;
    expect(plan.origins.map((item) => [item.origin, item.granted])).toEqual([[TOOLS_ORIGIN, false], [SITE_ORIGIN, true]]);
    expect(plan.preflight.ready).toBe(true); // the plan itself is not stale: Chrome's grant is the host's, named at Run
  });

  it("the run's start message carries the plan's origins, no hosted key for an Ollama plan and no vault without a record", async () => {
    const model = scriptedOllama(webairModelAnswers());
    const tool = scriptedOrigin();
    const h = makeHarness({ permissions: [WEBAIR_PATTERN, TOOLS_PATTERN], transports: { model: model.transport, tool: tool.transport } });
    const session = await trustedSession(h);
    const result = (await h.controller.handle({ type: "authorization.useProfile", sessionId: session.session.id, packageDigest: SHIPPED.webair040.digest, profileId: "search", resourceSelections: {}, prepare: true }, PAGE)) as AuthorizeResult;
    const plan = result.run_plan!.run_plan;
    await h.controller.handle({ type: "run.start", sessionId: session.session.id, runPlanId: plan.run_plan_id, runPlanSha256: plan.run_plan_sha256, input: { request: "Find me a nonstop flight from Boston to Zurich on 9 October under $900.", booking: false, purchase: { quote_id: "", fare_id: "" } } }, PAGE);
    await h.h_drain();
    const started = h.host.started[0]!;
    expect(started.allowedOrigins).toEqual([TOOLS_ORIGIN, SITE_ORIGIN]);
    expect(tool.seen.every((request) => request.url.startsWith(`${TOOLS_ORIGIN}/`))).toBe(true);
    expect(tool.seen.length).toBeGreaterThan(0);
    // D-195: no hosted key for an Ollama plan, no vault for a plan without a record.
    expect(started.credentials).toEqual({ openai: null, anthropic: null });
    expect(started.vault).toBeNull();
  });
});

describe("the execution host's origin guard (D-193)", () => {
  const record: string[] = [];
  const inner: HttpTransport = async (request) => {
    record.push(request.url);
    return { status: 200, headers: {}, body: "" };
  };
  const request = (url: string) => ({ url, method: "GET" as const, headers: {}, body: null, signal: new AbortController().signal, maxResponseBytes: 1024 });
  it("lets a plan origin through, Ollama on this machine for the model transport only, and refuses everything else before connecting", async () => {
    const tool = originGuard(inner, ["https://webair.example"], { allowLoopbackHttp: false });
    const model = originGuard(inner, ["https://api.openai.com"], { allowLoopbackHttp: true });
    await tool(request("https://webair.example/api/v1/search_flights"));
    await model(request("https://api.openai.com/v1/responses"));
    await model(request("http://127.0.0.1:11434/api/chat"));
    await model(request("http://localhost:11434/api/chat"));
    expect(record).toHaveLength(4);
    for (const [transport, url] of [
      [tool, "https://webair.example.evil/api"],
      [tool, "https://api.openai.com/v1/responses"],
      [tool, "http://127.0.0.1:11434/api/chat"],
      [model, "https://webair.example/api"],
      [model, "http://10.0.0.1:11434/api/chat"],
      [model, "https://127.0.0.1/api"],
    ] as const) {
      await expect(transport(request(url))).rejects.toMatchObject({ facts: { stage: "address_policy", reason: "origin_not_in_plan" } });
    }
    await expect(tool(request("not a url"))).rejects.toBeInstanceOf(TransportError);
    expect(record).toHaveLength(4);
  });
});

describe("discovery on grant (D-190)", () => {
  it("a site grant registers the discovery script for that site alone; every-site registers it everywhere; revoking unregisters", async () => {
    const h = makeHarness({ permissions: [] });
    const ungranted = await refused(h.controller.handle({ type: "permissions.granted", origins: [SITE_ORIGIN], purpose: { kind: "site", subject: SITE_ORIGIN } }, PAGE));
    expect(ungranted.code).toBe("origin_not_granted");
    h.permissions.grantedPatterns.add(WEBAIR_PATTERN);
    const site = (await h.controller.handle({ type: "permissions.granted", origins: [SITE_ORIGIN], purpose: { kind: "site", subject: SITE_ORIGIN } }, PAGE)) as PermissionsView;
    expect(site.origins[0]).toMatchObject({ origin: SITE_ORIGIN, purposes: [{ kind: "site", subject: SITE_ORIGIN }], granted: true });
    expect(h.permissions.registered).toEqual([WEBAIR_PATTERN]);
    // A package grant alone registers nothing: detection is where the person asked for it.
    h.permissions.grantedPatterns.add("https://other.example/*");
    await h.controller.handle({ type: "permissions.granted", origins: ["https://other.example"], purpose: { kind: "package", subject: "org.example.agent", label: "Other" } }, PAGE);
    expect(h.permissions.registered).toEqual([WEBAIR_PATTERN]);
    h.permissions.grantedPatterns.add(EVERY_SITE_PATTERN);
    const everywhere = (await h.controller.handle({ type: "permissions.granted", origins: ["*"], purpose: { kind: "everywhere", subject: "everywhere" } }, PAGE)) as PermissionsView;
    expect(everywhere.detect_everywhere).toBe(true);
    expect(everywhere.origins[0]).toMatchObject({ origin: "*", pattern: EVERY_SITE_PATTERN });
    expect(h.permissions.registered).toEqual([EVERY_SITE_PATTERN, WEBAIR_PATTERN]);
    const revoked = (await h.controller.handle({ type: "permissions.revoke", origins: ["*", SITE_ORIGIN] }, PAGE)) as PermissionsView;
    expect(revoked.detect_everywhere).toBe(false);
    expect(revoked.origins.map((item) => item.origin)).toEqual(["https://other.example"]);
    expect(h.permissions.registered).toEqual([]);
    // Chrome forgot a grant outside this extension: the record goes on reconcile.
    h.permissions.grantedPatterns.delete("https://other.example/*");
    await h.controller.reconcilePermissions();
    expect(((await h.controller.handle({ type: "permissions.get" }, PAGE)) as PermissionsView).origins).toEqual([]);
  });

  it("reading the clicked tab injects the content script, whose report becomes the badge; a tab Chrome refuses is said so", async () => {
    const h = makeHarness({ permissions: [] });
    h.permissions.onInject = async (tabId) => {
      // What the injected script does: report the head links from the tab Chrome vouches for.
      await h.controller.contentLinks({ type: "content.links", links: [{ href: "/agent.pkg", type: "application/vnd.webagents.agent-package", title: null }] }, { ...TAB, tabId });
    };
    await h.controller.handle({ type: "discovery.readTab", tabId: 7 }, PAGE);
    expect(h.permissions.injected).toEqual([7]);
    expect(h.badges.at(-1)).toEqual([7, 1]);
    h.permissions.unreadableTabs.add(8);
    const unreadable = await refused(h.controller.handle({ type: "discovery.readTab", tabId: 8 }, PAGE));
    expect(unreadable.code).toBe("tab_not_readable");
    expect(unreadable.message).toContain("click the WebAgents button");
  });
});
