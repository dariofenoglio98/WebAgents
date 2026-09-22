/**
 * Backend implementation of every Agent Browser feature operation.
 *
 * Everything that needs authority happens here, in the Gateway process:
 * supervising the control plane, holding its bearer token, resolving operator
 * configured local roots, and projecting responses for the page. The browser
 * only ever invokes the typed operations in `contract.ts`.
 */
import { realpath } from "node:fs/promises";
import { isAbsolute, resolve as resolvePath, sep } from "node:path";
import type { ServiceStatusView } from "./contract.js";
import { ControlPlaneClient, type ControlPlaneTransport } from "./control-plane.js";
import { AgentBrowserError, asFeatureError, clip } from "./errors.js";
import {
  projectPackage,
  projectPermissions,
  projectReceipt,
  projectSessions,
  projectTrust,
  projectTrustEntry,
} from "./project.js";
import {
  ControlPlaneSupervisor,
  resolveAgentpkgPath,
  type Logger,
  type ServiceSnapshot,
} from "./service.js";

export type BackendConfig = {
  agentpkgPath?: string;
  localPackages?: { roots?: string[]; includeWorkspace?: boolean };
  sessionTtlSeconds?: number;
  maxSessions?: number;
};

export type BackendOptions = {
  config: BackendConfig;
  logger: Logger;
  /** Private plugin state directory supplied by the Gateway service context. */
  stateDir: string;
  workspaceDir?: string;
  transport?: ControlPlaneTransport;
  /** Test seam: supply a supervisor instead of spawning a real child. */
  supervisor?: ControlPlaneSupervisor;
  onChange?: (reason: string) => void;
};

type Ok<T> = { ok: true; value: T };
type Err = { ok: false; error: ReturnType<typeof asFeatureError> };

const ok = <T>(value: T): Ok<T> => ({ ok: true, value });

function positiveInt(value: unknown, fallback: number, max: number): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0
    ? Math.min(value, max)
    : fallback;
}

async function guard<T>(run: () => Promise<T>): Promise<Ok<T> | Err> {
  try {
    return ok(await run());
  } catch (error) {
    return { ok: false, error: asFeatureError(error) };
  }
}

/** Resolve an operator-supplied path inside the configured roots, or refuse. */
export async function resolveLocalPackage(
  candidate: string,
  roots: readonly string[],
): Promise<string> {
  if (roots.length === 0) {
    throw new AgentBrowserError(
      "not_allowed",
      "Local packages are not enabled",
      "This host has no configured local package directory. An operator must set " +
        "plugins.entries.agent-browser.config.localPackages.roots before local files can be opened.",
    );
  }
  if (!isAbsolute(candidate)) {
    throw new AgentBrowserError(
      "not_allowed",
      "Absolute path required",
      "Enter the full path of a .agent.pkg file inside an allowed directory.",
    );
  }
  if (!candidate.endsWith(".agent.pkg")) {
    throw new AgentBrowserError(
      "not_allowed",
      "Not an agent package",
      "Only built .agent.pkg artifacts can be opened.",
    );
  }
  let real: string;
  try {
    real = await realpath(candidate);
  } catch {
    throw new AgentBrowserError(
      "source_rejected",
      "File not found",
      "No readable .agent.pkg file exists at that path.",
    );
  }
  for (const root of roots) {
    let realRoot: string;
    try {
      realRoot = await realpath(root);
    } catch {
      continue;
    }
    if (real === realRoot || real.startsWith(realRoot.endsWith(sep) ? realRoot : realRoot + sep)) {
      return real;
    }
  }
  throw new AgentBrowserError(
    "not_allowed",
    "Path outside the allowed directories",
    "That file is not inside a directory this host allows the Agent Browser to read.",
  );
}

export class AgentBrowserBackend {
  private supervisor: ControlPlaneSupervisor | null = null;
  private roots: string[] = [];
  private stopped = false;

  constructor(private readonly options: BackendOptions) {}

  /** Resolve configuration and prepare the supervisor. Never blocks on spawn. */
  async initialize(): Promise<void> {
    const config = this.options.config ?? {};
    const configuredRoots = Array.isArray(config.localPackages?.roots)
      ? config.localPackages.roots.filter((item) => typeof item === "string" && isAbsolute(item))
      : [];
    const roots = configuredRoots.map((item) => resolvePath(item));
    if (config.localPackages?.includeWorkspace !== false && this.options.workspaceDir) {
      roots.push(resolvePath(this.options.workspaceDir));
    }
    this.roots = [...new Set(roots)].slice(0, 8);

    if (this.options.supervisor) {
      this.supervisor = this.options.supervisor;
      return;
    }
    const agentpkgPath = await resolveAgentpkgPath(config.agentpkgPath);
    this.supervisor = new ControlPlaneSupervisor({
      agentpkgPath,
      runtimeDir: resolvePath(this.options.stateDir, "agent-browser"),
      logger: this.options.logger,
      sessionTtlSeconds: positiveInt(config.sessionTtlSeconds, 900, 86_400),
      maxSessions: positiveInt(config.maxSessions, 8, 32),
      transport: this.options.transport,
      onChange: () => this.options.onChange?.("service"),
    });
  }

  /** Begin the first launch without blocking Gateway startup. */
  async launch(report?: { reportFailure: (error: unknown) => void; clearFailure: () => void }) {
    if (!this.supervisor) return;
    try {
      await this.supervisor.ensureRunning();
      report?.clearFailure();
    } catch (error) {
      report?.reportFailure(error);
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    await this.supervisor?.stop();
  }

  private requireSupervisor(): ControlPlaneSupervisor {
    if (!this.supervisor || this.stopped) {
      throw new AgentBrowserError(
        "service_unavailable",
        "Agent Browser service unavailable",
        "The Agent Browser backend is not running.",
        true,
      );
    }
    return this.supervisor;
  }

  private async client(): Promise<ControlPlaneClient> {
    const supervisor = this.requireSupervisor();
    const snapshot = supervisor.snapshot();
    if (snapshot.state === "unconfigured") {
      throw new AgentBrowserError(
        "service_unavailable",
        "Agent Browser service not configured",
        snapshot.detail,
        false,
      );
    }
    if (snapshot.state === "failed") {
      throw new AgentBrowserError(
        "service_unavailable",
        "Agent Browser service unavailable",
        snapshot.detail,
        true,
      );
    }
    try {
      const endpoint = await supervisor.ensureRunning();
      return new ControlPlaneClient(endpoint, this.options.transport);
    } catch (error) {
      throw new AgentBrowserError(
        "service_unavailable",
        "Agent Browser service unavailable",
        clip((error as Error).message, 2000),
        true,
      );
    }
  }

  private snapshotView(snapshot: ServiceSnapshot, extra: Partial<ServiceStatusView> = {}) {
    const view: ServiceStatusView = {
      state: snapshot.state === "unconfigured" ? "unconfigured" : snapshot.state,
      detail: snapshot.detail,
      since: snapshot.since,
      starts: snapshot.starts,
      controlPlane: null,
      sessions: null,
      capabilities: {
        openUrl: snapshot.state === "running",
        openLocal: snapshot.state === "running" && this.roots.length > 0,
        localRoots: this.roots.slice(0, 8),
        trustPinning: snapshot.state === "running",
      },
      executionSupported: false,
      ...extra,
    };
    return view;
  }

  async status(): Promise<ServiceStatusView> {
    const supervisor = this.supervisor;
    if (!supervisor) {
      return this.snapshotView({
        state: "stopped",
        detail: "The Agent Browser backend is starting.",
        since: null,
        starts: 0,
      });
    }
    let snapshot = supervisor.snapshot();
    if (snapshot.state === "stopped" && !this.stopped) {
      // Opening the page is a reasonable trigger for the first launch; a failed
      // start is never retried automatically, only through Retry.
      await supervisor.ensureRunning().catch(() => undefined);
      snapshot = supervisor.snapshot();
    }
    if (snapshot.state !== "running") return this.snapshotView(snapshot);
    try {
      const client = await this.client();
      const status = (await client.status()) as Record<string, unknown>;
      return this.snapshotView(snapshot, {
        controlPlane: {
          apiVersion: String(status.api_version ?? ""),
          agentpkgVersion: String(status.agentpkg_version ?? ""),
          packageFormat: String(status.package_format ?? ""),
          execution: String(status.execution ?? ""),
        },
        sessions: {
          open: Number(status.open_sessions ?? 0),
          max: Number(
            (status.limits as Record<string, unknown> | undefined)?.max_sessions ?? 0,
          ),
        },
      });
    } catch {
      return this.snapshotView(supervisor.snapshot());
    }
  }

  async restart(): Promise<ServiceStatusView> {
    const supervisor = this.requireSupervisor();
    await supervisor.restart();
    this.options.onChange?.("service");
    return this.status();
  }

  // -- package operations ---------------------------------------------------
  openUrl(url: string) {
    return guard(async () => {
      const client = await this.client();
      const summary = await client.openUrl(url);
      this.options.onChange?.("packages");
      return projectPackage(summary);
    });
  }

  openLocal(path: string) {
    return guard(async () => {
      const resolved = await resolveLocalPackage(path, this.roots);
      const client = await this.client();
      const summary = await client.openFile(resolved);
      this.options.onChange?.("packages");
      return projectPackage(summary);
    });
  }

  getPackage(sessionId: string) {
    return guard(async () => projectPackage(await (await this.client()).getPackage(sessionId)));
  }

  getPermissions(sessionId: string) {
    return guard(async () =>
      projectPermissions(await (await this.client()).getPermissions(sessionId)),
    );
  }

  getAuthorization(sessionId: string) {
    return guard(async () => {
      try {
        return projectReceipt(await (await this.client()).getAuthorization(sessionId));
      } catch (error) {
        if (error instanceof AgentBrowserError && error.code === "session_expired") {
          // "No receipt yet" and "session gone" are distinct; only the first is null.
          const probe = await this.getPackage(sessionId);
          if (probe.ok) return null;
        }
        throw error;
      }
    });
  }

  authorize(
    sessionId: string,
    packageDigest: string,
    decisions: ReadonlyArray<{ permissionId: string; decision: string }>,
    toolApprovals: ReadonlyArray<{ toolId: string; approved: boolean }> = [],
  ) {
    return guard(async () => {
      const client = await this.client();
      const decisionMap: Record<string, string> = {};
      for (const entry of decisions) decisionMap[entry.permissionId] = entry.decision;
      const approvalMap: Record<string, boolean> = {};
      for (const entry of toolApprovals) approvalMap[entry.toolId] = entry.approved;
      const receipt = await client.authorize(sessionId, packageDigest, decisionMap, approvalMap);
      this.options.onChange?.("packages");
      return projectReceipt(receipt);
    });
  }

  closeSession(sessionId: string) {
    return guard(async () => {
      await (await this.client()).closeSession(sessionId);
      this.options.onChange?.("packages");
      return { sessionId, closed: true };
    });
  }

  listSessions() {
    return guard(async () => projectSessions(await (await this.client()).listSessions()));
  }

  // -- trust ----------------------------------------------------------------
  listTrust() {
    return guard(async () => projectTrust(await (await this.client()).listTrust()));
  }

  pinSessionPublisher(sessionId: string, signerFingerprint: string, scope: string) {
    return guard(async () => {
      const client = await this.client();
      const result = (await client.pinSessionPublisher(
        sessionId,
        signerFingerprint,
        scope,
      )) as Record<string, unknown>;
      this.options.onChange?.("trust");
      return {
        publisher: projectPackage({ publisher: result.publisher }).publisher,
        pinned: projectTrustEntry(result.added),
      };
    });
  }

  removeTrust(fingerprint: string) {
    return guard(async () => {
      await (await this.client()).removeTrust(fingerprint);
      this.options.onChange?.("trust");
      return { fingerprint, removed: true };
    });
  }
}
