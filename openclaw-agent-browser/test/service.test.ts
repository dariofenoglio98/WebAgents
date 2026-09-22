/**
 * Supervisor lifecycle: one child, clean stop, honest failure, secret token.
 *
 * These tests drive the real `agentpkg browser-serve` child when the repository
 * virtualenv is present, because process lifetime is exactly the thing a mock
 * would not prove.
 */
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { nodeTransport } from "../src/control-plane.js";
import { ControlPlaneSupervisor, resolveAgentpkgPath } from "../src/service.js";
import { AGENTPKG_BIN, hasAgentpkg } from "./fixtures.js";

const runs = hasAgentpkg();
const DEV_PUBLIC_KEY_PEM =
  "-----BEGIN PUBLIC KEY-----\n" +
  "MCowBQYDK2VwAyEAHOnGZWXq8RFj7a409vCakK4MtdpDhgMcPdK3Y775ens=\n" +
  "-----END PUBLIC KEY-----\n";
const log = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

let runtimeDir = "";
const supervisors: ControlPlaneSupervisor[] = [];

function makeSupervisor(overrides: Record<string, unknown> = {}) {
  const supervisor = new ControlPlaneSupervisor({
    agentpkgPath: AGENTPKG_BIN,
    runtimeDir,
    logger: log,
    startTimeoutMs: 30_000,
    ...overrides,
  });
  supervisors.push(supervisor);
  return supervisor;
}

/** Probe the control plane exactly as the plugin backend does. */
function probe(
  endpoint: { url: string; token: string },
  path: string,
  options: { method?: string; body?: unknown } = {},
) {
  return nodeTransport(endpoint, path, {
    method: options.method ?? "GET",
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    timeoutMs: 10_000,
  });
}

function livePids(): number[] {
  const output = execFileSync("ps", ["-A", "-o", "pid=,args="], { encoding: "utf8" });
  return output
    .split("\n")
    .filter((line) => line.includes("browser-serve") && line.includes(runtimeDir))
    .map((line) => Number(line.trim().split(/\s+/u)[0]))
    .filter((pid) => Number.isInteger(pid));
}

beforeEach(async () => {
  runtimeDir = await mkdtemp(join(tmpdir(), "agent-browser-service-"));
});

afterEach(async () => {
  for (const supervisor of supervisors.splice(0)) await supervisor.stop().catch(() => undefined);
  for (const pid of livePids()) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Already gone.
    }
  }
  await rm(runtimeDir, { recursive: true, force: true });
});

describe("agentpkg resolution", () => {
  it("prefers explicit configuration, then the environment, then PATH", async () => {
    expect(await resolveAgentpkgPath(AGENTPKG_BIN)).toBe(runs ? AGENTPKG_BIN : null);
    expect(await resolveAgentpkgPath(undefined, { PATH: "" })).toBe(null);
    expect(await resolveAgentpkgPath("/nonexistent/agentpkg", { PATH: "" })).toBe(null);
    if (runs) {
      expect(await resolveAgentpkgPath(undefined, { AGENTPKG_BIN, PATH: "" })).toBe(AGENTPKG_BIN);
    }
  });

  it("reports an unconfigured service instead of throwing", () => {
    const supervisor = new ControlPlaneSupervisor({
      agentpkgPath: null,
      runtimeDir,
      logger: log,
    });
    const snapshot = supervisor.snapshot();
    expect(snapshot.state).toBe("unconfigured");
    expect(snapshot.detail).toContain("agentpkgPath");
  });
});

describe.runIf(runs)("control-plane supervisor", () => {
  it("starts exactly one child and keeps the token out of the filesystem", async () => {
    const supervisor = makeSupervisor();
    const [first, second] = await Promise.all([
      supervisor.ensureRunning(),
      supervisor.ensureRunning(),
    ]);
    expect(first).toEqual(second);
    expect(first.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/u);
    expect(first.token.length).toBeGreaterThan(20);
    expect(supervisor.snapshot().state).toBe("running");
    expect(supervisor.snapshot().starts).toBe(1);
    expect(livePids()).toHaveLength(1);

    // The child wrote its token to a 0600 file; the supervisor consumed it.
    await expect(readFile(join(runtimeDir, "run", "token"), "utf8")).rejects.toThrow();

    const response = await probe(first, "/v0/status");
    expect(response.status).toBe(200);
    expect(JSON.parse(response.body).execution).toBe("disabled");
  });

  it("refuses the control plane without the in-memory token, and browser-shaped calls", async () => {
    const supervisor = makeSupervisor();
    const endpoint = await supervisor.ensureRunning();
    const anonymous = await probe({ url: endpoint.url, token: "wrong-token" }, "/v0/status");
    expect(anonymous.status).toBe(401);
    // Node's global fetch sends `sec-fetch-mode`, so the control plane's
    // rebinding defense refuses it. The backend therefore uses node:http.
    const browserShaped = await fetch(`${endpoint.url}/v0/health`);
    expect(browserShaped.status).toBe(403);
    expect((await browserShaped.json()).error.code).toBe("browser_request_refused");
  });

  it("stops and reaps its child", async () => {
    const supervisor = makeSupervisor();
    await supervisor.ensureRunning();
    expect(livePids()).toHaveLength(1);
    await supervisor.stop();
    expect(livePids()).toHaveLength(0);
    expect(supervisor.snapshot().state).toBe("stopped");
  });

  it("restarts without leaving an orphan", async () => {
    const supervisor = makeSupervisor();
    const first = await supervisor.ensureRunning();
    await supervisor.restart();
    const second = supervisor.snapshot();
    expect(second.state).toBe("running");
    expect(second.starts).toBe(2);
    expect(livePids()).toHaveLength(1);
    const endpoint = await supervisor.ensureRunning();
    expect(endpoint.url).not.toBe(first.url);
  });

  it("reaps an orphan left by a previous plugin instance", async () => {
    const first = makeSupervisor();
    await first.ensureRunning();
    const orphan = livePids()[0];
    expect(orphan).toBeGreaterThan(0);
    // Simulate a crashed Gateway: forget the child without stopping it.
    (first as unknown as { child: null }).child = null;

    const second = makeSupervisor();
    await second.ensureRunning();
    // The pid file identified the orphan by its own argv, so only it was killed.
    expect(livePids()).toHaveLength(1);
    expect(livePids()[0]).not.toBe(orphan);
  });

  it("never signals a live pid that is not a control plane", async () => {
    await writeFile(
      join(runtimeDir, "control-plane.pid"),
      JSON.stringify({ pid: process.pid, marker: join(runtimeDir, "run", "cache") }),
    );
    const supervisor = makeSupervisor();
    await supervisor.ensureRunning();
    // This test process is still alive: identity checking refused to kill it.
    expect(process.pid).toBeGreaterThan(0);
    expect(supervisor.snapshot().state).toBe("running");
  });

  it("preserves the trust store across restarts but not the snapshot cache", async () => {
    const supervisor = makeSupervisor();
    const endpoint = await supervisor.ensureRunning();
    const pinned = await probe(endpoint, "/v0/trust", {
      method: "POST",
      body: { public_key_pem: DEV_PUBLIC_KEY_PEM, display_name: "Test pin" },
    });
    expect(pinned.status).toBe(201);
    await supervisor.restart();
    const next = await supervisor.ensureRunning();
    const listed = await probe(next, "/v0/trust");
    expect(JSON.parse(listed.body).publishers).toHaveLength(1);
  });
});

describe("failed startup", () => {
  it("records a failure state instead of throwing a stack trace at the page", async () => {
    const supervisor = makeSupervisor({ agentpkgPath: "/bin/echo", startTimeoutMs: 2_000 });
    await expect(supervisor.ensureRunning()).rejects.toThrow();
    const snapshot = supervisor.snapshot();
    expect(snapshot.state).toBe("failed");
    expect(snapshot.detail).not.toContain("Traceback");
    expect(snapshot.detail.length).toBeLessThan(2_000);
  });
});
