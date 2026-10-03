/**
 * Website discovery through the plugin backend, against a real control plane.
 *
 * `fixtures/discovery_control_plane.py` starts agentpkg's own BrowserService
 * and ControlPlane with one difference: their network is a fixture web of
 * synthetic public origins, WebAir's real pages and signed package among them.
 * Every URL policy, parser, verifier and trust decision on the way is
 * production code; only DNS and sockets are stand-ins. The five demo scenarios
 * run here end to end: discovery finds a location, the ordinary package path
 * decides what it is, and trust stays an operator's pin.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AgentBrowserBackend } from "../src/backend.js";
import type { ControlPlaneEndpoint } from "../src/control-plane.js";
import { projectDiscovery } from "../src/project.js";
import type { ControlPlaneSupervisor } from "../src/service.js";
import { hasAgentpkg, PACKAGE_MEDIA_TYPE, REPO_ROOT } from "./fixtures.js";

const here = dirname(fileURLToPath(import.meta.url));
const PYTHON = join(REPO_ROOT, "agentpkg", ".venv", "bin", "python");
const CONTROL_PLANE = join(here, "fixtures", "discovery_control_plane.py");
const WEBAIR_FINGERPRINT =
  "sha256:2e53accec575b37bf16c189e03cd3a6b2f2cfae2339ff05361bf585dc3d4a20b";
const WEBAIR_DIGEST = "3b7c61a7bd9584e0217dda802065248c86dd135d210b8a06ab25239835cc2fb6";

type Logged = { message: string; meta: Record<string, unknown> };

function unwrap<T>(
  result: { ok: true; value: T } | { ok: false; error: { code: string; detail?: string } },
): T {
  if (!result.ok) throw new Error(`expected ok, got ${result.error.code}: ${result.error.detail ?? ""}`);
  return result.value;
}

function refused<T>(
  result: { ok: true; value: T } | { ok: false; error: { code: string; title: string; detail: string } },
) {
  if (result.ok) throw new Error("expected a refusal");
  return result.error;
}

async function startControlPlane(): Promise<{ endpoint: ControlPlaneEndpoint; child: ChildProcess }> {
  const child = spawn(PYTHON, [CONTROL_PLANE], { stdio: ["pipe", "pipe", "pipe"] });
  let stderr = "";
  child.stderr!.on("data", (chunk: Buffer) => {
    stderr = (stderr + chunk.toString()).slice(-4000);
  });
  const line = await new Promise<string>((resolve, reject) => {
    let buffer = "";
    const timer = setTimeout(() => reject(new Error(`fixture control plane did not start: ${stderr}`)), 60_000);
    child.stdout!.on("data", (chunk: Buffer) => {
      buffer += chunk.toString();
      const end = buffer.indexOf("\n");
      if (end >= 0) {
        clearTimeout(timer);
        resolve(buffer.slice(0, end));
      }
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`fixture control plane exited (${code}): ${stderr}`));
    });
  });
  const { url, token } = JSON.parse(line) as { url: string; token: string };
  return { endpoint: { url, token }, child };
}

/** The backend's supervisor seam, pointed at the fixture control plane. */
function supervisorFor(endpoint: ControlPlaneEndpoint): ControlPlaneSupervisor {
  const snapshot = { state: "running" as const, detail: "fixture control plane", since: null, starts: 1 };
  return {
    snapshot: () => snapshot,
    ensureRunning: async () => endpoint,
    restart: async () => snapshot,
    stop: async () => undefined,
  } as unknown as ControlPlaneSupervisor;
}

describe.runIf(hasAgentpkg())("website discovery end to end", () => {
  let child: ChildProcess;
  let endpoint: ControlPlaneEndpoint;
  let stateDir = "";
  let backend: AgentBrowserBackend;
  const logged: Logged[] = [];

  beforeAll(async () => {
    ({ endpoint, child } = await startControlPlane());
    stateDir = await mkdtemp(join(tmpdir(), "agent-browser-discovery-"));
    const record = (message: string, meta?: unknown) =>
      logged.push({ message, meta: (meta ?? {}) as Record<string, unknown> });
    backend = new AgentBrowserBackend({
      config: {},
      logger: { info: record, warn: record, error: record, debug: () => {} },
      stateDir,
      supervisor: supervisorFor(endpoint),
    });
    await backend.initialize();
  }, 90_000);

  afterAll(async () => {
    await backend?.stop();
    child?.stdin?.end();
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        child?.kill("SIGKILL");
        resolve(null);
      }, 5_000);
      child?.once("exit", () => {
        clearTimeout(timer);
        resolve(null);
      });
    });
    if (stateDir) await rm(stateDir, { recursive: true, force: true });
  });

  it("A: WebAir's page advertises its package, and inspecting it reaches the ordinary trust and authorization flow", async () => {
    const view = unwrap(await backend.discoverWebsite("https://webair.example/"));
    expect(view.status).toBe("candidate");
    expect(view.pageOrigin).toBe("https://webair.example");
    expect(view.candidates).toEqual([
      {
        index: 0,
        href: "/agent.pkg",
        typeHint: PACKAGE_MEDIA_TYPE,
        resolvedUrl: "https://webair.example/agent.pkg",
        sameOrigin: true,
        accepted: true,
        rejectionReason: null,
        rejectionMessage: null,
      },
    ]);
    expect(view.packageVerified).toBe(false);
    expect(view.publisherTrusted).toBe(false);
    expect(view.permissionsGranted).toBe(false);
    expect(view.packageFetched).toBe(false);
    expect(view.executionPerformed).toBe(false);
    // Discovery opened nothing.
    expect(unwrap(await backend.listSessions()).sessions).toHaveLength(0);

    const pkg = unwrap(await backend.openUrl(view.candidates[0]!.resolvedUrl!));
    expect(pkg.identity.packageId).toBe("org.webagents.webair");
    expect(pkg.identity.digest).toBe(WEBAIR_DIGEST);
    expect(pkg.source).toEqual({ kind: "url", display: "https://webair.example/agent.pkg" });
    expect(pkg.validation).toMatchObject({
      container: "valid",
      integrity: "valid",
      schema: "valid",
      runtime: "compatible",
    });
    expect(pkg.publisher.signatureStatus).toBe("valid");
    expect(pkg.publisher.signerFingerprint).toBe(WEBAIR_FINGERPRINT);
    // Served by its own origin over HTTPS and validly signed: still nobody's pin.
    expect(pkg.publisher.trustStatus).toBe("unknown");
    expect(pkg.executionPerformed).toBe(false);

    const permissions = unwrap(await backend.getPermissions(pkg.sessionId));
    expect(new Set(permissions.permissions.map((item) => item.decision))).toEqual(new Set(["deny"]));
    expect(permissions.toolApprovals.every((item) => item.decision === false)).toBe(true);
    const grants = permissions.permissions.map((item) => ({ permissionId: item.id, decision: "session" as const }));
    const approvals = permissions.toolApprovals.map((item) => ({ toolId: item.toolId, approved: true }));
    const untrusted = unwrap(await backend.authorize(pkg.sessionId, pkg.identity.digest, grants, approvals));
    expect(untrusted.runnable).toBe(false);
    expect(untrusted.blockingReasons.map((item) => item.code)).toContain("publisher_not_trusted");

    const pinned = unwrap(await backend.pinSessionPublisher(pkg.sessionId, WEBAIR_FINGERPRINT, "package"));
    expect(pinned.publisher.trustStatus).toBe("trusted");
    const receipt = unwrap(await backend.authorize(pkg.sessionId, pkg.identity.digest, grants, approvals));
    expect(receipt.runnable).toBe(true);
    expect(receipt.executionPerformed).toBe(false);
    unwrap(await backend.removeTrust(WEBAIR_FINGERPRINT));
    unwrap(await backend.closeSession(pkg.sessionId));
  }, 60_000);

  it("B: an ordinary website advertises nothing", async () => {
    const view = unwrap(await backend.discoverWebsite("https://news.example/"));
    expect(view.status).toBe("no_candidate");
    expect(view.candidates).toEqual([]);
  });

  it("C: a cross-origin advertisement is rejected and never fetched", async () => {
    const view = unwrap(await backend.discoverWebsite("https://victim.example/"));
    expect(view.status).toBe("candidates_rejected");
    const [candidate] = view.candidates;
    expect(candidate).toMatchObject({
      accepted: false,
      sameOrigin: false,
      resolvedUrl: "https://other.example/evil.agent.pkg",
      rejectionReason: "cross_origin",
    });
    expect(candidate!.rejectionMessage).toContain("https://other.example");
    expect(unwrap(await backend.listSessions()).sessions).toHaveLength(0);
  });

  it("D: a valid advertisement of an invalid package fails inspection normally", async () => {
    const broken = unwrap(await backend.discoverWebsite("https://broken.example/"));
    expect(broken.status).toBe("candidate");
    const error = refused(await backend.openUrl(broken.candidates[0]!.resolvedUrl!));
    expect(error.code).toBe("package_rejected");

    const tampered = unwrap(await backend.discoverWebsite("https://tampered.example/"));
    const pkg = unwrap(await backend.openUrl(tampered.candidates[0]!.resolvedUrl!));
    expect(pkg.validation.integrity).toBe("valid");
    expect(pkg.publisher.signatureStatus).toBe("invalid");
    expect(pkg.publisher.trustStatus).toBe("unknown");
    unwrap(await backend.closeSession(pkg.sessionId));
  }, 60_000);

  it("E: a valid signature by an unknown key stays untrusted, and impersonates once the real key is pinned", async () => {
    const view = unwrap(await backend.discoverWebsite("https://stranger.example/"));
    const stranger = unwrap(await backend.openUrl(view.candidates[0]!.resolvedUrl!));
    expect(stranger.publisher.signatureStatus).toBe("valid");
    expect(stranger.publisher.signerFingerprint).not.toBe(WEBAIR_FINGERPRINT);
    expect(stranger.publisher.trustStatus).toBe("unknown");

    // Pin WebAir's real key, from a session that WebAir's key signed.
    const real = unwrap(await backend.openUrl("https://webair.example/agent.pkg"));
    unwrap(await backend.pinSessionPublisher(real.sessionId, WEBAIR_FINGERPRINT, "publisher"));
    const after = unwrap(await backend.getPackage(stranger.sessionId));
    expect(after.publisher.trustStatus).toBe("mismatch");
    expect(after.publisher.trustReason).toBe("claimed_publisher_pinned_to_other_key");
    unwrap(await backend.removeTrust(WEBAIR_FINGERPRINT));
    unwrap(await backend.closeSession(real.sessionId));
    unwrap(await backend.closeSession(stranger.sessionId));
  }, 60_000);

  it("treats a second, unrelated origin exactly the same way", async () => {
    const view = unwrap(await backend.discoverWebsite("https://meetings.example/team/"));
    expect(view.candidates.map((item) => item.resolvedUrl)).toEqual([
      "https://meetings.example/team/tools/agenda.agent.pkg",
    ]);
    const pkg = unwrap(await backend.openUrl(view.candidates[0]!.resolvedUrl!));
    expect(pkg.identity.packageId).toBe("org.webagents.meeting-agenda");
    expect(pkg.publisher.trustStatus).toBe("unknown");
    unwrap(await backend.closeSession(pkg.sessionId));
  }, 60_000);

  it("lists several candidates and opens none of them", async () => {
    const view = unwrap(await backend.discoverWebsite("https://multi.example/"));
    expect(view.status).toBe("multiple_candidates");
    expect(view.candidates.filter((item) => item.accepted)).toHaveLength(2);
    expect(unwrap(await backend.listSessions()).sessions).toHaveLength(0);
  });

  it("applies the control plane's URL policy and says when an address is not a page", async () => {
    expect(refused(await backend.discoverWebsite("http://webair.example/")).code).toBe("url_rejected");
    const loopback = refused(await backend.discoverWebsite("https://127.0.0.1/"));
    expect(loopback.code).toBe("url_rejected");
    expect(loopback.title).toBe("This destination is not allowed");
    expect(loopback.detail).toMatch(/loopback/u);
    const notPage = refused(await backend.discoverWebsite("https://webair.example/agent.pkg"));
    expect(notPage.code).toBe("discovery_not_html");
    expect(notPage.title).toBe("Not a web page");
  });

  it("records discovery in the Gateway log, never as an execution event", async () => {
    logged.splice(0);
    unwrap(await backend.discoverWebsite("https://victim.example/"));
    refused(await backend.discoverWebsite("https://127.0.0.1/"));
    expect(logged.map((item) => item.message)).toEqual([
      "agent-browser: website discovery started",
      "agent-browser: website discovery finished",
      "agent-browser: website discovery started",
      "agent-browser: website discovery refused",
    ]);
    expect(logged[1]!.meta).toMatchObject({
      origin: "https://victim.example",
      status: "candidates_rejected",
      candidates: 1,
      accepted: [],
      rejected: [{ url: "https://other.example/evil.agent.pkg", reason: "cross_origin" }],
    });
    expect(logged[3]!.meta).toMatchObject({ origin: "https://127.0.0.1", code: "url_rejected" });
    expect(JSON.stringify(logged)).not.toContain(endpoint.token);
  });

  it("never returns the control-plane token", async () => {
    const outputs = JSON.stringify([
      await backend.discoverWebsite("https://webair.example/"),
      await backend.discoverWebsite("https://127.0.0.1/"),
    ]);
    expect(outputs).not.toContain(endpoint.token);
    expect(outputs).not.toContain(endpoint.url);
  });
});

describe("the discovery projection", () => {
  const raw = (overrides: Record<string, unknown> = {}) => ({
    schema: "agentpkg-website-discovery-v0",
    requested_url: "https://shop.example/#top",
    final_url: "https://shop.example/",
    page_origin: "https://shop.example",
    redirects: [],
    discovery_status: "candidate",
    candidates: [
      {
        index: 0,
        href: "/agent.pkg",
        type_hint: null,
        resolved_url: "https://shop.example/agent.pkg",
        same_origin: true,
        accepted: true,
        rejection_reason: null,
        rejection_message: null,
      },
    ],
    accepted_count: 1,
    rejected_count: 0,
    links_not_listed: 0,
    page: { content_type: "text/html", html_sha256: "e".repeat(64), bytes_read: 10 },
    profile: { name: "same-origin-v0", rel: "agent-package", same_origin_required: true },
    trust: {
      conveys: "location_only",
      package_verified: false,
      publisher_trusted: false,
      permissions_granted: false,
    },
    execution: { performed: false, package_fetched: false },
    discovered_at: "2026-10-02T10:00:00+00:00",
    ...overrides,
  });

  it("projects a candidate and drops what the page does not need", () => {
    const view = projectDiscovery(raw());
    expect(view.candidates[0]!.resolvedUrl).toBe("https://shop.example/agent.pkg");
    expect(view.requestedUrl).toBe("https://shop.example/#top");
    expect(JSON.stringify(view)).not.toContain("schema");
  });

  it.each([
    ["trust", { package_verified: true, publisher_trusted: false, permissions_granted: false }],
    ["trust", { package_verified: false, publisher_trusted: true, permissions_granted: false }],
    ["trust", { package_verified: false, publisher_trusted: false, permissions_granted: true }],
    ["execution", { performed: true, package_fetched: false }],
    ["execution", { performed: false, package_fetched: true }],
    ["execution", {}],
  ])("refuses a result that claims more than a location (%s)", (key, value) => {
    expect(() => projectDiscovery(raw({ [key]: value }))).toThrow(/Unexpected discovery result|untrusted location/u);
  });

  it("refuses an accepted candidate whose address it would have to change", () => {
    const long = `https://shop.example/${"a".repeat(2100)}`;
    const candidate = { ...raw().candidates[0], resolved_url: long };
    expect(() => projectDiscovery(raw({ candidates: [candidate] }))).toThrow();
    expect(() =>
      projectDiscovery(raw({ candidates: [{ ...raw().candidates[0], resolved_url: null }] })),
    ).toThrow();
  });

  it("bounds the list and counts what it left out", () => {
    const many = Array.from({ length: 20 }, (_, index) => ({
      ...raw().candidates[0],
      index,
      accepted: false,
      rejection_reason: "duplicate",
    }));
    const view = projectDiscovery(raw({ candidates: many, links_not_listed: 3 }));
    expect(view.candidates).toHaveLength(16);
    expect(view.linksNotListed).toBe(7);
  });
});
