/**
 * Supervisor for the `agentpkg browser-serve` control plane.
 *
 * The plugin backend owns this process so an operator never starts it by hand.
 * Three properties matter:
 *
 * * **one child per plugin instance** — a single-flight start, a pid file, and
 *   an identity-checked reap of an orphan left by a crashed Gateway;
 * * **the bearer token stays in this process** — it is written by the child to
 *   a 0600 file, read once, then deleted, and it is never logged or returned;
 * * **failures are states, not exceptions** — the page renders "unavailable"
 *   with a Retry action instead of a stack trace.
 */
import { spawn, execFile, type ChildProcess } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import {
  access,
  mkdir,
  readFile,
  realpath,
  rm,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { delimiter, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { ControlPlaneEndpoint, ControlPlaneTransport } from "./control-plane.js";
import { ControlPlaneClient } from "./control-plane.js";
import { clip } from "./errors.js";

export type ServiceState = "unconfigured" | "stopped" | "starting" | "running" | "failed";

export type ServiceSnapshot = {
  state: ServiceState;
  detail: string;
  since: string | null;
  starts: number;
};

export type Logger = {
  debug?: (message: string, meta?: unknown) => void;
  info: (message: string, meta?: unknown) => void;
  warn: (message: string, meta?: unknown) => void;
  error: (message: string, meta?: unknown) => void;
};

export type SupervisorOptions = {
  /** Absolute path to the `agentpkg` executable, or null when unresolved. */
  agentpkgPath: string | null;
  /** Private per-plugin directory, normally `<stateDir>/agent-browser`. */
  runtimeDir: string;
  logger: Logger;
  sessionTtlSeconds?: number;
  maxSessions?: number;
  startTimeoutMs?: number;
  /** Test seam; defaults to node:child_process.spawn. */
  spawnImpl?: typeof spawn;
  /** Test seam for readiness probing. */
  transport?: ControlPlaneTransport;
  onChange?: (snapshot: ServiceSnapshot) => void;
};

const START_TIMEOUT_MS = 30_000;
const STOP_GRACE_MS = 5_000;
const STDERR_KEEP = 4_000;

/** Executable lookup: explicit config, then environment, then PATH. */
export async function resolveAgentpkgPath(
  configured: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | null> {
  const candidates: string[] = [];
  if (typeof configured === "string" && configured.trim()) candidates.push(configured.trim());
  if (typeof env.AGENTPKG_BIN === "string" && env.AGENTPKG_BIN.trim()) {
    candidates.push(env.AGENTPKG_BIN.trim());
  }
  for (const directory of (env.PATH ?? "").split(delimiter)) {
    if (directory) candidates.push(join(directory, "agentpkg"));
  }
  for (const candidate of candidates) {
    try {
      await access(candidate, fsConstants.X_OK);
      const info = await stat(candidate);
      if (info.isFile()) return candidate;
    } catch {
      // Try the next candidate.
    }
  }
  return null;
}

function parseListeningLine(line: string): { url: string } | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{")) return null;
  try {
    const value = JSON.parse(trimmed) as Record<string, unknown>;
    if (value.status === "listening" && typeof value.url === "string") {
      return { url: value.url };
    }
  } catch {
    return null;
  }
  return null;
}

export class ControlPlaneSupervisor {
  private state: ServiceState;
  private detail: string;
  private since: string | null = null;
  private starts = 0;
  private child: ChildProcess | null = null;
  private endpoint: ControlPlaneEndpoint | null = null;
  private starting: Promise<ControlPlaneEndpoint> | null = null;
  private stopped = false;

  private root: string;
  private runDir: string;
  private cacheDir: string;
  private trustStorePath: string;
  private tokenPath: string;
  private pidPath: string;

  constructor(private readonly options: SupervisorOptions) {
    this.root = options.runtimeDir;
    this.runDir = join(this.root, "run");
    this.cacheDir = join(this.runDir, "cache");
    // Publisher pins are persistent operator configuration, so they live
    // outside the per-run directory and survive restarts and reloads.
    this.trustStorePath = join(this.root, "trust.json");
    this.tokenPath = join(this.runDir, "token");
    this.pidPath = join(this.root, "control-plane.pid");
    this.state = options.agentpkgPath ? "stopped" : "unconfigured";
    this.detail = options.agentpkgPath
      ? "The control plane has not been started yet."
      : "No `agentpkg` executable was found. Set the plugin's agentpkgPath config value.";
  }

  snapshot(): ServiceSnapshot {
    return { state: this.state, detail: this.detail, since: this.since, starts: this.starts };
  }

  /** The trust store path, exposed for documentation and diagnostics only. */
  get trustStore(): string {
    return this.trustStorePath;
  }

  private setState(state: ServiceState, detail: string): void {
    if (this.state === state && this.detail === detail) return;
    this.state = state;
    this.detail = clip(detail, 2000);
    this.since = new Date().toISOString();
    this.options.onChange?.(this.snapshot());
  }

  /** Start if needed and return an endpoint, or throw a typed failure. */
  async ensureRunning(): Promise<ControlPlaneEndpoint> {
    if (this.endpoint && this.child && this.child.exitCode === null) return this.endpoint;
    if (this.starting) return this.starting;
    this.starting = this.start().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  async restart(): Promise<ServiceSnapshot> {
    await this.stop();
    this.stopped = false;
    try {
      await this.ensureRunning();
    } catch {
      // The failure is already recorded in the snapshot the caller reads.
    }
    return this.snapshot();
  }

  private async start(): Promise<ControlPlaneEndpoint> {
    const executable = this.options.agentpkgPath;
    if (!executable) {
      this.setState("unconfigured", this.detail);
      throw new Error(this.detail);
    }
    if (this.stopped) throw new Error("The Agent Browser service has been stopped.");

    this.setState("starting", "Starting the Agent Browser control plane…");
    await mkdir(this.options.runtimeDir, { recursive: true, mode: 0o700 });
    await this.usePhysicalPaths();
    await this.reapOrphan();
    await rm(this.runDir, { recursive: true, force: true });
    await mkdir(this.cacheDir, { recursive: true, mode: 0o700 });

    const args = [
      "browser-serve",
      "--host",
      "127.0.0.1",
      "--port",
      "0",
      "--quiet",
      "--token-file",
      this.tokenPath,
      "--cache-dir",
      this.cacheDir,
      "--trust-store",
      this.trustStorePath,
      "--session-ttl",
      String(this.options.sessionTtlSeconds ?? 900),
      "--max-sessions",
      String(this.options.maxSessions ?? 8),
    ];
    const spawnImpl = this.options.spawnImpl ?? spawn;
    const child = spawnImpl(executable, args, {
      cwd: this.options.runtimeDir,
      env: { ...process.env, NO_COLOR: "1", PYTHONUNBUFFERED: "1" },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    this.child = child;
    this.starts += 1;

    let stderr = "";
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      stderr = clip(`${stderr}${chunk}`.slice(-STDERR_KEEP), STDERR_KEEP);
    });

    const listening = this.awaitListening(child);
    child.on("exit", (code, signal) => {
      if (this.child !== child) return;
      this.child = null;
      this.endpoint = null;
      if (this.stopped) {
        this.setState("stopped", "The Agent Browser control plane was stopped.");
        return;
      }
      this.setState(
        "failed",
        `The control plane exited (${signal ? `signal ${signal}` : `code ${code ?? "unknown"}`}). ${
          stderr ? `Last output: ${clip(stderr.trim(), 600)}` : ""
        }`.trim(),
      );
    });
    child.on("error", (error: Error) => {
      if (this.child !== child) return;
      this.child = null;
      this.endpoint = null;
      this.setState("failed", `The control plane could not be launched: ${error.message}`);
    });

    let url: string;
    try {
      url = await listening;
    } catch (error) {
      await this.terminate(child);
      const detail = `${(error as Error).message}${stderr ? ` Last output: ${clip(stderr.trim(), 600)}` : ""}`;
      this.setState("failed", detail);
      throw new Error(detail);
    }

    let token: string;
    try {
      token = (await readFile(this.tokenPath, "utf8")).trim();
      if (!token) throw new Error("empty token file");
    } catch {
      await this.terminate(child);
      const detail = "The control plane did not provide a local authentication token.";
      this.setState("failed", detail);
      throw new Error(detail);
    }
    // The token now exists only in this process's memory.
    await unlink(this.tokenPath).catch(() => undefined);
    await writeFile(
      this.pidPath,
      JSON.stringify({ pid: child.pid, marker: this.cacheDir, startedAt: new Date().toISOString() }),
      { mode: 0o600 },
    ).catch(() => undefined);

    const endpoint: ControlPlaneEndpoint = { url, token };
    try {
      await new ControlPlaneClient(endpoint, this.options.transport).health();
    } catch {
      await this.terminate(child);
      const detail = "The control plane started but did not answer a health check.";
      this.setState("failed", detail);
      throw new Error(detail);
    }
    this.endpoint = endpoint;
    this.setState("running", "The Agent Browser control plane is running.");
    this.options.logger.info("agent-browser: control plane ready");
    return endpoint;
  }

  /**
   * agentpkg refuses to create files under a symlinked parent, which is the
   * normal shape of a macOS temporary or state directory. Resolving the
   * runtime root once keeps that safety rule satisfied wherever the Gateway
   * puts plugin state.
   */
  private async usePhysicalPaths(): Promise<void> {
    try {
      this.root = await realpath(this.options.runtimeDir);
    } catch {
      this.root = this.options.runtimeDir;
    }
    this.runDir = join(this.root, "run");
    this.cacheDir = join(this.runDir, "cache");
    this.trustStorePath = join(this.root, "trust.json");
    this.tokenPath = join(this.runDir, "token");
    this.pidPath = join(this.root, "control-plane.pid");
  }

  private awaitListening(child: ChildProcess): Promise<string> {
    const timeoutMs = this.options.startTimeoutMs ?? START_TIMEOUT_MS;
    return new Promise<string>((resolve, reject) => {
      let buffer = "";
      let settled = false;
      const finish = (error: Error | null, url?: string) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        child.stdout?.off("data", onData);
        child.off("exit", onExit);
        child.off("error", onError);
        if (error) reject(error);
        else resolve(url as string);
      };
      const onData = (chunk: string) => {
        // The startup line is compact JSON in --quiet mode; anything else is
        // bounded operational noise we deliberately do not forward.
        buffer = `${buffer}${chunk}`.slice(-16_000);
        let index = buffer.indexOf("\n");
        while (index >= 0) {
          const line = buffer.slice(0, index);
          buffer = buffer.slice(index + 1);
          const parsed = parseListeningLine(line);
          if (parsed) {
            finish(null, parsed.url);
            return;
          }
          index = buffer.indexOf("\n");
        }
      };
      const onExit = (code: number | null) =>
        finish(new Error(`The control plane exited during startup (code ${code ?? "unknown"}).`));
      const onError = (error: Error) =>
        finish(new Error(`The control plane could not be launched: ${error.message}`));
      const timer = setTimeout(
        () => finish(new Error("The control plane did not become ready in time.")),
        timeoutMs,
      );
      child.stdout?.setEncoding("utf8");
      child.stdout?.on("data", onData);
      child.on("exit", onExit);
      child.on("error", onError);
    });
  }

  /** Kill a child from a previous Gateway process, identified by its own argv. */
  private async reapOrphan(): Promise<void> {
    let record: { pid?: unknown; marker?: unknown };
    try {
      record = JSON.parse(await readFile(this.pidPath, "utf8")) as Record<string, unknown>;
    } catch {
      return;
    }
    const pid = typeof record.pid === "number" ? record.pid : 0;
    const marker = typeof record.marker === "string" ? record.marker : "";
    await unlink(this.pidPath).catch(() => undefined);
    if (!pid || !marker || pid === process.pid) return;
    try {
      process.kill(pid, 0);
    } catch {
      return; // Already gone.
    }
    const args = await processArgs(pid);
    if (!args || !args.includes(marker)) {
      // A live pid that is not ours: never signal it.
      this.options.logger.warn("agent-browser: stale pid file did not match a control plane");
      return;
    }
    this.options.logger.info("agent-browser: terminating an orphaned control plane");
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      return;
    }
    for (let waited = 0; waited < STOP_GRACE_MS; waited += 100) {
      await delay(100);
      try {
        process.kill(pid, 0);
      } catch {
        return;
      }
    }
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Nothing more to do.
    }
  }

  private async terminate(child: ChildProcess): Promise<void> {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    try {
      child.kill("SIGTERM");
    } catch {
      return;
    }
    const outcome = await Promise.race([exited, delay(STOP_GRACE_MS, "timeout" as const)]);
    if (outcome === "timeout") {
      try {
        child.kill("SIGKILL");
      } catch {
        // The process is already gone.
      }
      await Promise.race([exited, delay(2_000)]);
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    const child = this.child;
    this.child = null;
    this.endpoint = null;
    if (child) await this.terminate(child);
    await unlink(this.pidPath).catch(() => undefined);
    await rm(this.runDir, { recursive: true, force: true }).catch(() => undefined);
    this.setState("stopped", "The Agent Browser control plane was stopped.");
  }
}

async function processArgs(pid: number): Promise<string | null> {
  return new Promise((resolve) => {
    execFile("ps", ["-p", String(pid), "-o", "args="], { timeout: 3_000 }, (error, stdout) => {
      resolve(error ? null : stdout);
    });
  });
}
