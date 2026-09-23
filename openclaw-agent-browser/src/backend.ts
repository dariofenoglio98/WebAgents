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
  discoverHostModels,
  stillAvailable,
  type HostCatalog,
  type ModelHost,
} from "./host-models.js";
import {
  projectEvaluation,
  projectPackage,
  projectPermissions,
  projectReceipt,
  projectRunPlanState,
  projectSessions,
  projectToolRegistry,
  projectTrust,
  projectTrustEntry,
} from "./project.js";
import { projectToolProbe } from "./tool-probe.js";
import type { HttpTransport as ToolHttpTransport } from "./tool-broker.js";
import {
  buildToolRegistry,
  resolveBindings,
  type ToolBindingDefinition,
  type ToolRegistry,
  type ToolsConfig,
} from "./tool-registry.js";
import type { HostLlm } from "./host-llm.js";
import { projectProbe } from "./router-probe.js";
import { revalidate } from "./preflight.js";
import { RouterBridge, type BridgeLimits } from "./router-bridge.js";
import { ExecutionService, resolvePolicy, type ExecutionPolicy } from "./execution.js";
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
  /** Trusted host bounds for a run. They can only lower package declarations. */
  execution?: Partial<ExecutionPolicy>;
  /** Which tool implementations this host offers, and how they are configured. */
  tools?: ToolsConfig;
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
  /**
   * How this backend asks OpenClaw what models exist. Supplied by the plugin
   * entry from the live `api`; tests substitute a stub host so the suite never
   * depends on a configured provider.
   */
  modelHost?: ModelHost;
  /**
   * The host's own completion surface (`api.runtime.llm`). Present only so the
   * developer router probe can invoke the exact model a run plan bound; no
   * other operation in this backend touches it.
   */
  llm?: HostLlm;
  /** Test seam: build the bridge instead of spawning a real agentpkg child. */
  createBridge?: (options: { modelId: string }) => {
    probe: (plan: Record<string, unknown>) => Promise<Record<string, unknown>>;
  };
  /** Operator-tunable bridge deadlines; defaults live in router-bridge.ts. */
  bridgeLimits?: Partial<BridgeLimits>;
  /** Test seam: build an execution bridge instead of spawning a real runner. */
  createExecutionBridge?: ExecutionServiceSeam;
  /**
   * Test seam: the tool implementations this host registers.
   *
   * Code, not configuration. Operator configuration can disable, relabel,
   * retarget and bound a built-in; it can never add one, because a registry
   * entry is a claim that code in this process can serve it.
   */
  toolDefinitions?: readonly ToolBindingDefinition[];
  /** Test seam: replace the broker's HTTP mechanics, never its policy. */
  toolTransport?: ToolHttpTransport;
};

type ExecutionServiceSeam = NonNullable<
  ConstructorParameters<typeof ExecutionService>[0]["createBridge"]
>;

type Ok<T> = { ok: true; value: T };
type Err = { ok: false; error: ReturnType<typeof asFeatureError> };

const ok = <T>(value: T): Ok<T> => ({ ok: true, value });

const rec = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const str = (value: unknown): string => (typeof value === "string" ? value : "");

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
  private agentpkgPath: string | null = null;
  private execution: ExecutionService | null = null;

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

    const runtimeDir = resolvePath(this.options.stateDir, "agent-browser");
    this.execution = new ExecutionService({
      agentpkgPath: () => this.requireAgentpkgPath(),
      llm: () => this.options.llm,
      logger: this.options.logger,
      runtimeDir,
      policy: resolvePolicy(config.execution),
      hostRuntimeVersion: () => this.options.modelHost?.runtimeVersion ?? null,
      tools: () => this.toolHost(),
      ...(this.options.toolTransport ? { toolTransport: this.options.toolTransport } : {}),
      ...(this.options.createExecutionBridge
        ? { createBridge: this.options.createExecutionBridge }
        : {}),
    });

    if (this.options.supervisor) {
      this.supervisor = this.options.supervisor;
      return;
    }
    const agentpkgPath = await resolveAgentpkgPath(config.agentpkgPath);
    this.agentpkgPath = agentpkgPath;
    this.supervisor = new ControlPlaneSupervisor({
      agentpkgPath,
      runtimeDir,
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
    // Runs in flight end here rather than outliving the plugin: their child is
    // about to lose its parent, and run state is deliberately not persistent.
    await this.execution?.stopAll();
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
      // The page still has no Run action. Execution lives behind operator-only
      // operations, which is a different fact and a different field.
      executionSupported: false,
      executionOperations: Boolean(this.execution?.available()),
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

  // -- models and run plans -------------------------------------------------
  /**
   * Ask the host what it has, ask the control plane what it means.
   *
   * The split is the point: discovery is host knowledge, and every requirement
   * semantic, status and threshold comes back from agentpkgd. Nothing here
   * decides whether a model fits a package.
   */
  /**
   * What this host implements, right now.
   *
   * Built on every read rather than cached: whether a credential is present,
   * whether a binding is enabled and what an operator configured are live
   * facts, and a stale answer here would mean a plan bound to something that
   * is no longer there.
   */
  private toolHost(): { registry: ToolRegistry; definitions: readonly ToolBindingDefinition[] } {
    const config = this.options.config?.tools;
    const supplied = this.options.toolDefinitions;
    const { definitions } = resolveBindings(config, supplied);
    const registry = buildToolRegistry({
      ...(config ? { config } : {}),
      ...(supplied ? { definitions: supplied } : {}),
      host: {
        runtimeVersion: this.options.modelHost?.runtimeVersion ?? null,
      },
      policy: resolvePolicy(this.options.config?.execution),
    });
    return { registry, definitions };
  }

  evaluateTools(sessionId: string) {
    return guard(async () => {
      const client = await this.client();
      const summary = rec(await client.getPackage(sessionId));
      const digest = str(rec(summary.package).digest);
      let authorized = false;
      try {
        await client.getAuthorization(sessionId);
        authorized = true;
      } catch (error) {
        if (!(error instanceof AgentBrowserError && error.code === "session_expired")) throw error;
      }
      const evaluation = await client.evaluateTools(
        sessionId,
        digest,
        this.toolHost().registry,
      );
      return projectToolRegistry(evaluation, { sessionId, authorized });
    });
  }

  /**
   * Prove the tool boundary against one exact implementation.
   *
   * The only operation in this backend that can make a package's declared tool
   * run, and the caller chooses a *declared tool id* and one of this host's own
   * fixtures — nothing else. No URL, method, header, endpoint or argument is
   * caller-controlled, and no workflow, graph node or model takes part.
   */
  probeTool(
    sessionId: string,
    runPlanId: string,
    runPlanSha256: string,
    toolId: string,
    fixtureId?: string,
  ) {
    return guard(async () => {
      const execution = this.requireExecution();
      const client = await this.client();
      const catalog = await this.hostCatalog();
      const outcome = await execution.toolProbe(client, catalog, {
        sessionId,
        runPlanId,
        runPlanSha256,
        toolId,
        ...(fixtureId ? { fixtureId } : {}),
      });
      const view = projectToolProbe(outcome.report);
      this.options.logger.info("agent-browser: tool probe completed", {
        tool: view.tool.id,
        binding: view.binding.bindingId,
        status: view.status,
        remote: view.binding.remote,
        toolCalls: view.usage.toolCalls,
        modelCalls: 0,
      });
      return view;
    });
  }

  private async hostCatalog(): Promise<HostCatalog> {
    if (!this.options.modelHost) {
      throw new AgentBrowserError(
        "model_catalog_unavailable",
        "Model discovery unavailable",
        "This backend was started without access to the OpenClaw model catalog.",
        false,
      );
    }
    return discoverHostModels(this.options.modelHost);
  }

  evaluateModels(sessionId: string) {
    return guard(async () => {
      const client = await this.client();
      const catalog = await this.hostCatalog();
      const summary = (await client.getPackage(sessionId)) as Record<string, unknown>;
      const digest = String(
        ((summary.package as Record<string, unknown>) ?? {}).digest ?? "",
      );
      const requirements = (await client.modelRequirements(sessionId)) as Record<string, unknown>;
      const modeIds = (
        (requirements.mode_required_permission_ids as Record<string, unknown>) ?? {}
      ).model;
      const executionModePermissionIds = Array.isArray(modeIds)
        ? modeIds.filter((item): item is string => typeof item === "string")
        : [];
      let granted: string[] = [];
      let authorized = false;
      try {
        const receipt = (await client.getAuthorization(sessionId)) as Record<string, unknown>;
        authorized = true;
        granted = Array.isArray(receipt.granted_permission_ids)
          ? (receipt.granted_permission_ids as unknown[]).filter(
              (item): item is string => typeof item === "string",
            )
          : [];
      } catch (error) {
        // "Not authorized yet" is a state the page renders, not a failure.
        if (!(error instanceof AgentBrowserError && error.code === "session_expired")) throw error;
      }
      const evaluation = await client.evaluateModels(sessionId, digest, catalog);
      return projectEvaluation(evaluation, {
        sessionId,
        host: catalog.host as unknown as Record<string, unknown>,
        executionModePermissionIds,
        executionModePermissionsGranted:
          executionModePermissionIds.length > 0 &&
          executionModePermissionIds.every((id) => granted.includes(id)),
        authorized,
      });
    });
  }

  prepareRunPlan(
    sessionId: string,
    packageDigest: string,
    receiptId: string,
    modelId: string,
    executionMode = "model",
    probeToolId?: string,
  ) {
    return guard(async () => {
      const client = await this.client();
      // Re-read the catalog immediately before binding, so a plan can never
      // record a model the host stopped offering while the page was open.
      const catalog = await this.hostCatalog();
      // A tool probe binds no model, so there is nothing to re-check.
      if (executionMode === "model" && !stillAvailable(catalog, modelId)) {
        throw new AgentBrowserError(
          "model_unknown",
          "Model no longer available",
          `This OpenClaw host no longer offers ${modelId} as a usable choice. ` +
            "Refresh the model list and choose again.",
          true,
        );
      }
      const payload = await client.prepareRunPlan(sessionId, {
        packageDigest,
        receiptId,
        ...(executionMode === "model" ? { modelId } : {}),
        executionMode,
        ...(probeToolId ? { probeToolId } : {}),
        catalog,
        // A package that declares no tool gets no bindings; one that does
        // cannot have a plan prepared without them.
        toolRegistry: this.toolHost().registry,
      });
      this.options.onChange?.("run-plan");
      return projectRunPlanState(payload, true);
    });
  }

  getRunPlan(sessionId: string) {
    return guard(async () => {
      const client = await this.client();
      let payload: unknown;
      try {
        payload = await client.getRunPlan(sessionId);
      } catch (error) {
        if (error instanceof AgentBrowserError && error.code === "run_plan_absent") {
          return { plan: null, preflight: null, executionSupported: false as const };
        }
        throw error;
      }
      // Re-evaluate the live registry first, so the preflight this read
      // returns compares the plan with what this host offers *now*.
      const planned = rec((payload as Record<string, unknown>).run_plan);
      if (Array.isArray(planned.tool_bindings) && planned.tool_bindings.length > 0) {
        await client
          .evaluateTools(sessionId, str(rec(planned.package).digest), this.toolHost().registry)
          .catch(() => undefined);
        payload = await client.getRunPlan(sessionId);
      }
      const plan = (payload as Record<string, unknown>).run_plan as
        | Record<string, unknown>
        | undefined;
      const binding = (plan?.model_binding ?? {}) as Record<string, unknown>;
      const modelId = typeof binding.host_model_id === "string" ? binding.host_model_id : "";
      let available: boolean | null = null;
      if (modelId) {
        try {
          available = stillAvailable(await this.hostCatalog(), modelId);
        } catch {
          // An unreachable catalog is unknown availability, not unavailability.
          available = null;
        }
      }
      // A plan that binds no model — a tool probe — is not made unready by a
      // model it never named. `null` is "not applicable" here, as it is for an
      // unreachable catalog, and the projection treats it the same way.
      return projectRunPlanState(payload, available);
    });
  }

  clearRunPlan(sessionId: string) {
    return guard(async () => {
      await (await this.client()).clearRunPlan(sessionId);
      this.options.onChange?.("run-plan");
      return { sessionId, cleared: true };
    });
  }

  // -- developer router probe ------------------------------------------------
  /**
   * Prove the ModelRouter bridge against the exact model a run plan bound.
   *
   * This is the only operation in this backend that spends model tokens, and
   * the only one that reaches `api.runtime.llm`. It is deliberately not part of
   * the page: there is still no Run action, and this exists so an operator can
   * verify the router contract before a workflow is allowed to depend on it.
   *
   * Nothing about the request is caller-controlled. The model comes from the
   * plan, the prompt and schema are host-owned constants inside agentpkg, and
   * the caller supplies only which plan it believes is current.
   */
  probeRouter(sessionId: string, runPlanId: string, runPlanSha256: string) {
    return guard(async () => {
      const llm = this.options.llm;
      if (!llm && !this.options.createBridge) {
        throw new AgentBrowserError(
          "bridge_unavailable",
          "Model invocation is unavailable",
          "This backend was started without access to the OpenClaw completion runtime.",
        );
      }
      const client = await this.client();
      const catalog = await this.hostCatalog();
      const preflight = await revalidate({
        client,
        catalog,
        sessionId,
        runPlanId,
        runPlanSha256,
      });
      const bridge = this.options.createBridge
        ? this.options.createBridge({ modelId: preflight.modelId })
        : new RouterBridge({
            agentpkgPath: this.requireAgentpkgPath(),
            modelId: preflight.modelId,
            llm: llm!,
            logger: this.options.logger,
            ...(this.options.bridgeLimits ? { limits: this.options.bridgeLimits } : {}),
          });
      const outcome = await bridge.probe(preflight.binding);
      const report = (outcome.report ?? outcome) as Record<string, unknown>;
      const view = projectProbe(report, preflight.revalidated);
      if (view.model.invoked !== preflight.modelId) {
        // Belt and braces: the router and the host both check this, and a
        // report that still disagrees is not returned as a success.
        throw new AgentBrowserError(
          "selected_model_unavailable",
          "A different model answered",
          `The run plan bound ${preflight.modelId} but the probe reports ${view.model.invoked}.`,
        );
      }
      this.options.logger.info("agent-browser: router probe completed", {
        model: view.model.invoked,
        status: view.status,
        inputTokens: view.usage.inputTokens,
        outputTokens: view.usage.outputTokens,
      });
      return view;
    });
  }

  private requireAgentpkgPath(): string {
    if (!this.agentpkgPath) {
      throw new AgentBrowserError(
        "bridge_unavailable",
        "The agentpkg executable is not configured",
        "Set plugins.entries.agent-browser.config.agentpkgPath to the agentpkg executable.",
      );
    }
    return this.agentpkgPath;
  }

  // -- execution (operator only; the page never calls these) -----------------
  /**
   * Run the signed package this session holds, on the model its plan bound.
   *
   * The caller supplies which plan it believes is current and the workflow
   * input. Everything else — the instructions, the schemas, the graph, the
   * model, the budgets — comes from the signed package, the run plan and this
   * host's own policy. This is not a general completion endpoint.
   */
  startExecution(sessionId: string, runPlanId: string, runPlanSha256: string, input: unknown) {
    return guard(async () => {
      const execution = this.requireExecution();
      const client = await this.client();
      const catalog = await this.hostCatalog();
      const record = await execution.start(client, catalog, {
        sessionId,
        runPlanId,
        runPlanSha256,
        input,
      });
      this.options.onChange?.("execution");
      this.options.logger.info("agent-browser: execution finished", {
        run: record.runId,
        status: record.status,
        model: record.selectedModel.hostModelId,
        modelCalls: record.audit?.modelCalls ?? 0,
        tokens: record.usage?.tokens ?? 0,
      });
      return record;
    });
  }

  cancelExecution(runId: string) {
    return guard(async () => {
      const record = await this.requireExecution().cancel(runId);
      this.options.onChange?.("execution");
      return record;
    });
  }

  getExecution(runId: string) {
    return guard(async () => this.requireExecution().runs.get(runId)?.view ?? null);
  }

  listExecutions(sessionId?: string) {
    return guard(async () => this.requireExecution().runs.list(sessionId));
  }

  readExecutionArtifact(runId: string, name: string) {
    return guard(async () => this.requireExecution().artifact(runId, name));
  }

  clearExecutions(runId?: string, sessionId?: string) {
    return guard(async () => {
      const cleared = this.requireExecution().runs.clear({
        ...(runId ? { runId } : {}),
        ...(sessionId ? { sessionId } : {}),
      });
      if (cleared) this.options.onChange?.("execution");
      return { cleared };
    });
  }

  private requireExecution(): ExecutionService {
    if (!this.execution || this.stopped) {
      throw new AgentBrowserError(
        "service_unavailable",
        "Agent Browser service unavailable",
        "The Agent Browser backend is not running.",
        true,
      );
    }
    return this.execution;
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
