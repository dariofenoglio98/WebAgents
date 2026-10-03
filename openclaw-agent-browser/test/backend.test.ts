/**
 * Backend feature operations against a real agentpkgd child.
 *
 * Both shipped packages travel the identical generic path: no assertion here
 * depends on what "literature" or "agenda" mean, and neither does the backend.
 */
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { AgentBrowserBackend, resolveLocalPackage } from "../src/backend.js";
import { nodeTransport, type ControlPlaneTransport } from "../src/control-plane.js";
import {
  AGENDA_KEY_FINGERPRINT,
  AGENTPKG_BIN,
  DIST,
  hasAgentpkg,
  LITERATURE_KEY_FINGERPRINT,
} from "./fixtures.js";

const runs = hasAgentpkg();
const log = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
const REVIEW = join(DIST, "literature-review.agent.pkg");
const AGENDA = join(DIST, "meeting-agenda.agent.pkg");

let stateDir = "";
let backend: AgentBrowserBackend;
const changes: string[] = [];

async function makeBackend(config: Record<string, unknown> = {}) {
  const instance = new AgentBrowserBackend({
    config: { agentpkgPath: AGENTPKG_BIN, localPackages: { roots: [DIST] }, ...config },
    logger: log,
    stateDir,
    onChange: (reason) => changes.push(reason),
  });
  await instance.initialize();
  return instance;
}

function unwrap<T>(
  result: { ok: true; value: T } | { ok: false; error: { code: string; detail?: string } },
): T {
  if (!result.ok) {
    throw new Error(`expected ok, got ${result.error.code}: ${result.error.detail ?? ""}`);
  }
  return result.value;
}

describe.runIf(runs)("backend feature operations", () => {
  beforeAll(async () => {
    stateDir = await mkdtemp(join(tmpdir(), "agent-browser-backend-"));
    backend = await makeBackend();
    await backend.launch();
  }, 90_000);

  afterAll(async () => {
    await backend?.stop();
    await rm(stateDir, { recursive: true, force: true });
  });

  it("reports a running service without leaking the bearer token", async () => {
    const status = await backend.status();
    expect(status.state).toBe("running");
    expect(status.controlPlane?.execution).toBe("disabled");
    expect(status.executionSupported).toBe(false);
    expect(status.capabilities).toEqual({
      openUrl: true,
      openLocal: true,
      localRoots: [DIST],
      trustPinning: true,
    });
    const serialized = JSON.stringify(status);
    expect(serialized).not.toMatch(/token|bearer|127\.0\.0\.1|localhost/iu);
  });

  it.each([
    // Literature Review 0.2.2 added `check-evidence`; 0.2.3 added `bibliography`
    // and `assemble-output`; 0.2.4 added four deterministic nodes; 0.2.5 adds
    // `materialize-evidence`: 25 total.
    ["literature-review", REVIEW, "org.webagents.literature-review", LITERATURE_KEY_FINGERPRINT, 7, 3, 9, 25],
    ["meeting-agenda", AGENDA, "org.webagents.meeting-agenda", AGENDA_KEY_FINGERPRINT, 3, 0, 4, 7],
  ])(
    "opens %s through the same generic path",
    async (_name, path, packageId, signer, skills, tools, workers, nodes) => {
      const view = unwrap(await backend.openLocal(path));
      expect(view.identity.packageId).toBe(packageId);
      expect(view.validation).toMatchObject({
        container: "valid",
        integrity: "valid",
        schema: "valid",
        runtime: "compatible",
      });
      expect(view.publisher.signatureStatus).toBe("valid");
      expect(view.publisher.signerFingerprint).toBe(signer);
      // A self-consistent signature from an unpinned key is not trust.
      expect(view.publisher.trustStatus).toBe("unknown");
      expect(view.skills).toHaveLength(skills);
      expect(view.tools).toHaveLength(tools);
      expect(view.workers).toHaveLength(workers);
      expect(view.workflow.nodeCount).toBe(nodes);
      expect(view.executionPerformed).toBe(false);
      await backend.closeSession(view.sessionId);
    },
    120_000,
  );

  it("starts every permission denied and refuses unsupported decisions", async () => {
    const view = unwrap(await backend.openLocal(REVIEW));
    const permissions = unwrap(await backend.getPermissions(view.sessionId));
    expect(permissions.permissions.length).toBeGreaterThan(0);
    expect(new Set(permissions.permissions.map((item) => item.decision))).toEqual(new Set(["deny"]));
    expect(permissions.decisionOptions).toEqual(["deny", "once", "session"]);
    expect(permissions.decisionOptions).not.toContain("always");
    expect(permissions.unsupportedDecisions.map((item) => item.value)).toContain("always");
    expect(permissions.permissions.some((item) => item.required)).toBe(true);
    expect(permissions.permissions.some((item) => !item.required)).toBe(true);

    const rejected = await backend.authorize(view.sessionId, view.identity.digest, [
      { permissionId: "memory.session", decision: "always" as never },
    ]);
    expect(rejected.ok).toBe(false);
    await backend.closeSession(view.sessionId);
  });

  it("authorizes, pins a publisher, and re-authorizes as runnable", async () => {
    const view = unwrap(await backend.openLocal(AGENDA));
    const session = view.sessionId;
    const permissions = unwrap(await backend.getPermissions(session));
    const grants = permissions.permissions.map((item) => ({
      permissionId: item.id,
      decision: "session" as const,
    }));

    // Untrusted publisher: the decisions are recorded, but nothing is runnable.
    const first = unwrap(await backend.authorize(session, view.identity.digest, grants));
    expect(first.runnable).toBe(false);
    expect(first.blockingReasons.map((item) => item.code)).toContain("publisher_not_trusted");
    expect(first.executionPerformed).toBe(false);

    const pinned = unwrap(
      await backend.pinSessionPublisher(session, view.publisher.signerFingerprint!, "package"),
    );
    expect(pinned.publisher.trustStatus).toBe("trusted");
    expect(pinned.pinned.packageIdPrefix).toBe("org.webagents.meeting-agenda");
    expect(JSON.stringify(pinned)).not.toMatch(/PRIVATE KEY/u);

    const refreshed = unwrap(await backend.getPackage(session));
    expect(refreshed.publisher.trustStatus).toBe("trusted");

    const second = unwrap(await backend.authorize(session, view.identity.digest, grants));
    expect(second.runnable).toBe(true);
    expect(second.blockingReasons).toEqual([]);
    expect(second.publisher.trustStatus).toBe("trusted");
    expect(second.executionPerformed).toBe(false);
    expect(second.receiptSha256).toHaveLength(64);

    const stored = unwrap(await backend.getAuthorization(session));
    expect(stored?.receiptId).toBe(second.receiptId);

    // Denying one required permission blocks the run again.
    const denied = unwrap(
      await backend.authorize(
        session,
        view.identity.digest,
        grants.map((item, index) => (index === 0 ? { ...item, decision: "deny" as const } : item)),
      ),
    );
    expect(denied.runnable).toBe(false);
    expect(denied.blockingReasons[0]?.code).toBe("required_permission_denied");
    expect(denied.blockingReasons[0]?.subject).toBe(grants[0]?.permissionId);

    const trusted = unwrap(await backend.listTrust());
    // The pin under test is this session's own signer, not a project-wide key.
    expect(trusted.publishers.map((item) => item.fingerprint)).toContain(AGENDA_KEY_FINGERPRINT);
    unwrap(await backend.removeTrust(AGENDA_KEY_FINGERPRINT));
    expect(unwrap(await backend.getPackage(session)).publisher.trustStatus).toBe("unknown");
    await backend.closeSession(session);
  }, 120_000);

  it("refuses a pin whose fingerprint was not the one displayed", async () => {
    const view = unwrap(await backend.openLocal(AGENDA));
    const result = await backend.pinSessionPublisher(
      view.sessionId,
      `sha256:${"0".repeat(64)}`,
      "package",
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("trust_conflict");
    expect(unwrap(await backend.listTrust()).publishers).toHaveLength(0);
    await backend.closeSession(view.sessionId);
  });

  it("refuses to authorize a digest the caller did not display", async () => {
    const review = unwrap(await backend.openLocal(REVIEW));
    const agenda = unwrap(await backend.openLocal(AGENDA));
    const result = await backend.authorize(review.sessionId, agenda.identity.digest, []);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("digest_mismatch");
    await backend.closeSession(review.sessionId);
    await backend.closeSession(agenda.sessionId);
  }, 120_000);

  it("reports a closed or expired session as a typed state", async () => {
    const view = unwrap(await backend.openLocal(AGENDA));
    unwrap(await backend.closeSession(view.sessionId));
    const missing = await backend.getPackage(view.sessionId);
    expect(missing.ok).toBe(false);
    if (!missing.ok) {
      expect(missing.error.code).toBe("session_expired");
      expect(missing.error.detail).not.toMatch(/Traceback|File "/u);
    }
    const permissions = await backend.getPermissions(view.sessionId);
    expect(permissions.ok).toBe(false);
  });

  it("lists open sessions and closes them", async () => {
    for (const open of unwrap(await backend.listSessions()).sessions) {
      await backend.closeSession(open.sessionId);
    }
    const view = unwrap(await backend.openLocal(REVIEW));
    const listed = unwrap(await backend.listSessions());
    expect(listed.sessions.map((item) => item.sessionId)).toContain(view.sessionId);
    expect(listed.sessions.every((item) => item.runnable === false)).toBe(true);
    unwrap(await backend.closeSession(view.sessionId));
    expect(unwrap(await backend.listSessions()).sessions).toHaveLength(0);
  }, 120_000);

  it("never returns the control-plane bearer token from any operation", async () => {
    let captured = "";
    const spy: ControlPlaneTransport = (endpoint, path, options) => {
      captured = endpoint.token;
      return nodeTransport(endpoint, path, options);
    };
    const dir = await mkdtemp(join(tmpdir(), "agent-browser-secrecy-"));
    const instance = new AgentBrowserBackend({
      config: { agentpkgPath: AGENTPKG_BIN, localPackages: { roots: [DIST] } },
      logger: log,
      stateDir: dir,
      transport: spy,
    });
    await instance.initialize();
    await instance.launch();
    try {
      const view = unwrap(await instance.openLocal(AGENDA));
      const outputs = JSON.stringify([
        await instance.status(),
        view,
        await instance.getPermissions(view.sessionId),
        await instance.listSessions(),
        await instance.listTrust(),
        await instance.authorize(view.sessionId, view.identity.digest, []),
        await instance.getAuthorization(view.sessionId),
      ]);
      expect(captured.length).toBeGreaterThan(20);
      expect(outputs).not.toContain(captured);
      expect(outputs).not.toMatch(/Bearer [A-Za-z0-9_-]{10}/u);
    } finally {
      await instance.stop();
      await rm(dir, { recursive: true, force: true });
    }
  }, 120_000);

  it("applies the control plane's URL policy without reimplementing it", async () => {
    const http = await backend.openUrl("http://packages.example/a.agent.pkg");
    expect(http.ok).toBe(false);
    if (!http.ok) expect(http.error.code).toBe("url_rejected");

    const loopback = await backend.openUrl("https://127.0.0.1/a.agent.pkg");
    expect(loopback.ok).toBe(false);
    if (!loopback.ok) {
      expect(loopback.error.code).toBe("url_rejected");
      expect(loopback.error.detail).toMatch(/loopback/iu);
    }

    const file = await backend.openUrl("file:///etc/passwd");
    expect(file.ok).toBe(false);
  }, 120_000);

  it("applies the same URL policy to website discovery", async () => {
    const before = unwrap(await backend.listSessions()).sessions.length;
    for (const url of [
      "http://shop.example/",
      "file:///etc/passwd",
      "https://user:secret@shop.example/",
      "https://shop.example:8443/",
    ]) {
      const result = await backend.discoverWebsite(url);
      expect(result.ok, url).toBe(false);
      if (!result.ok) expect(result.error.code).toBe("url_rejected");
    }
    // Resolved by the real resolver inside the control plane's own killable child.
    const loopback = await backend.discoverWebsite("https://localhost/");
    expect(loopback.ok).toBe(false);
    if (!loopback.ok) {
      expect(loopback.error.code).toBe("url_rejected");
      expect(loopback.error.detail).toMatch(/loopback/iu);
    }
    expect(unwrap(await backend.listSessions()).sessions).toHaveLength(before);
  }, 120_000);

  it("rejects a malformed package with its layered validation", async () => {
    const broken = join(stateDir, "broken.agent.pkg");
    await writeFile(broken, "PK\u0003\u0004 not a package");
    const instance = await makeBackend({ localPackages: { roots: [stateDir] } });
    (instance as unknown as { supervisor: unknown }).supervisor = (
      backend as unknown as { supervisor: unknown }
    ).supervisor;
    const result = await instance.openLocal(broken);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("package_rejected");
      expect(result.error.validation).toMatchObject({ container_status: "invalid" });
    }
  });
});

describe("local path policy", () => {
  let root = "";
  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true });
    root = "";
  });

  it("only opens .agent.pkg files inside configured roots", async () => {
    root = await mkdtemp(join(tmpdir(), "agent-browser-roots-"));
    const inside = join(root, "ok.agent.pkg");
    await writeFile(inside, "x");
    await expect(resolveLocalPackage(inside, [root])).resolves.toContain("ok.agent.pkg");
    await expect(resolveLocalPackage(inside, [])).rejects.toThrow(/no configured local package/u);
    await expect(resolveLocalPackage("relative.agent.pkg", [root])).rejects.toThrow(
      /full path/u,
    );
    await expect(resolveLocalPackage(join(root, "notes.txt"), [root])).rejects.toThrow(
      /\.agent\.pkg/u,
    );
    await expect(resolveLocalPackage("/etc/hosts.agent.pkg", [root])).rejects.toThrow();
  });

  it("refuses a symlink that escapes an allowed root", async () => {
    root = await mkdtemp(join(tmpdir(), "agent-browser-escape-"));
    const outside = join(root, "outside");
    const allowed = join(root, "allowed");
    await writeFile(join(root, "secret.agent.pkg"), "x");
    await import("node:fs/promises").then(({ mkdir }) => mkdir(allowed, { recursive: true }));
    await import("node:fs/promises").then(({ mkdir }) => mkdir(outside, { recursive: true }));
    const target = join(outside, "real.agent.pkg");
    await writeFile(target, "x");
    await symlink(target, join(allowed, "link.agent.pkg"));
    await expect(resolveLocalPackage(join(allowed, "link.agent.pkg"), [allowed])).rejects.toThrow(
      /not inside a directory/u,
    );
  });
});

describe("service failures are typed, not thrown at the page", () => {
  it("reports an unconfigured executable", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agent-browser-unconfigured-"));
    const instance = new AgentBrowserBackend({
      config: { agentpkgPath: "/nonexistent/agentpkg" },
      logger: log,
      stateDir: dir,
    });
    await instance.initialize();
    const status = await instance.status();
    expect(status.state).toBe("unconfigured");
    expect(status.capabilities.openUrl).toBe(false);
    const result = await instance.openUrl("https://packages.example/a.agent.pkg");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("service_unavailable");
      expect(result.error.detail).toContain("agentpkgPath");
    }
    await rm(dir, { recursive: true, force: true });
  });

  it("maps a control-plane error body to a stable browser code", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agent-browser-mapped-"));
    const transport: ControlPlaneTransport = async (_endpoint, path) => {
      if (path === "/v0/health") return { status: 200, body: "{}" };
      return {
        status: 429,
        body: JSON.stringify({
          error: { code: "session_limit_reached", message: "At most 8 package sessions" },
        }),
      };
    };
    const instance = new AgentBrowserBackend({
      config: { agentpkgPath: AGENTPKG_BIN, localPackages: { roots: [DIST] } },
      logger: log,
      stateDir: dir,
      transport,
    });
    await instance.initialize();
    if (runs) {
      await instance.launch();
      const result = await instance.openLocal(join(DIST, "meeting-agenda.agent.pkg"));
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe("limit_reached");
      await instance.stop();
    }
    await rm(dir, { recursive: true, force: true });
  }, 90_000);
});
