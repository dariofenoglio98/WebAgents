/**
 * Running a signed package: the trusted host half.
 *
 * ```text
 *   ready run plan
 *        │
 *        ▼  preflight — the same one the router probe uses, plus "consent
 *        │              must outlast this run"
 *   execution lease  ── the control plane copies its immutable snapshot once
 *        │
 *        ▼  opened here, inherited as fd 3; a private run directory as fd 4
 *   agentpkg execution runner
 *        │  re-verifies hash, digest, signature and signer, then builds the
 *        ▼  generic Runtime and Workflow and runs the package's own graph
 *   OpenClaw api.runtime.llm.complete   (the exact model the plan bound)
 *        │
 *        ▼
 *   run record + artifacts on disk
 * ```
 *
 * Everything package-shaped happens in the child. This file's whole job is the
 * part that must not be delegated to a downloaded package: deciding whether the
 * run may happen, bounding it, owning the process, and writing down what it did.
 *
 * Nothing here interprets a graph, renders a prompt, chooses a model or knows
 * what the package is for.
 */
import { createHash } from "node:crypto";
import { closeSync, constants as fsConstants, openSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { ControlPlaneClient } from "./control-plane.js";
import type { RunArtifactContentViewType, RunRecordViewType } from "./contract.js";
import { AgentBrowserError, clip } from "./errors.js";
import { ExecutionBridge } from "./execution-bridge.js";
import type { HostLlm } from "./host-llm.js";
import type { HostCatalog } from "./host-models.js";
import { revalidate, type PreflightOutcome } from "./preflight.js";
import { RunManager, isTerminal } from "./run-manager.js";
import type { Logger } from "./service.js";
import { ToolBroker, type HttpTransport } from "./tool-broker.js";
import { pickFixture } from "./tool-fixtures.js";
import { buildToolRegistry, type ToolBindingDefinition, type ToolRegistry } from "./tool-registry.js";

/** The OpenClaw release this project's token accounting was verified against. */
export const VERIFIED_HOST_RUNTIME = "2026.9.5";

/** One workflow input is a task description, not a data transfer. */
export const MAX_INPUT_BYTES = 256 * 1024;
/** How much of one artifact `execution.artifact` will return. */
export const MAX_ARTIFACT_BYTES = 256 * 1024;

export type ExecutionPolicy = {
  totalTokens: number;
  maxRemoteCalls: number;
  maxParallelWorkers: number;
  maxOutputTokensPerCall: number;
  runTimeoutSeconds: number;
  /**
   * Refuse to run on an OpenClaw the token accounting was not verified against.
   *
   * The reservation invariant depends on how this host reports tokenization and
   * usage. That was established against one release; assuming it still holds on
   * an arbitrary future one would be asserting a proof nobody redid. An
   * operator who has re-verified can set this to false.
   */
  requireVerifiedHostRuntime: boolean;
  /** Ceiling on how often one run may call any one tool. Lowers, never raises. */
  maxCallsPerTool: number;
  /** Ceiling on one tool response, applied to every binding's own limit. */
  maxToolResponseBytes: number;
};

export const DEFAULT_POLICY: ExecutionPolicy = {
  totalTokens: 120_000,
  maxRemoteCalls: 32,
  maxParallelWorkers: 3,
  maxOutputTokensPerCall: 16_000,
  runTimeoutSeconds: 600,
  requireVerifiedHostRuntime: true,
  maxCallsPerTool: 32,
  maxToolResponseBytes: 512 * 1024,
};

function positive(value: unknown, fallback: number, max: number): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0
    ? Math.min(value, max)
    : fallback;
}

export function resolvePolicy(config: unknown): ExecutionPolicy {
  const raw = (config ?? {}) as Record<string, unknown>;
  return {
    totalTokens: positive(raw.totalTokens, DEFAULT_POLICY.totalTokens, 10_000_000),
    maxRemoteCalls: positive(raw.maxRemoteCalls, DEFAULT_POLICY.maxRemoteCalls, 10_000),
    maxParallelWorkers: positive(raw.maxParallelWorkers, DEFAULT_POLICY.maxParallelWorkers, 64),
    maxOutputTokensPerCall: positive(
      raw.maxOutputTokensPerCall,
      DEFAULT_POLICY.maxOutputTokensPerCall,
      200_000,
    ),
    runTimeoutSeconds: positive(raw.runTimeoutSeconds, DEFAULT_POLICY.runTimeoutSeconds, 86_400),
    requireVerifiedHostRuntime: raw.requireVerifiedHostRuntime !== false,
    maxCallsPerTool: positive(raw.maxCallsPerTool, DEFAULT_POLICY.maxCallsPerTool, 10_000),
    maxToolResponseBytes: positive(
      raw.maxToolResponseBytes,
      DEFAULT_POLICY.maxToolResponseBytes,
      4 * 1024 * 1024,
    ),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function rec(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function int(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : 0;
}

function strings(value: unknown, max: number): string[] {
  return (Array.isArray(value) ? value : []).map(str).filter(Boolean).slice(0, max);
}

function counts(value: unknown, key: string, max: number) {
  return Object.entries(rec(value))
    .slice(0, max)
    .map(([name, count]) => ({ [key]: clip(name, 64), count: int(count) })) as never;
}

export type ExecutionServiceOptions = {
  agentpkgPath: () => string;
  llm: () => HostLlm | undefined;
  logger: Logger;
  runtimeDir: string;
  policy: ExecutionPolicy;
  hostRuntimeVersion: () => string | null;
  /** The tool implementations this host registers, and how to describe them. */
  tools: () => { registry: ToolRegistry; definitions: readonly ToolBindingDefinition[] };
  /**
   * Test seam: replace the broker's HTTP mechanics.
   *
   * It replaces transport only. Binding resolution, the destination policy,
   * the header set, the credential lookup and the response contract all still
   * apply, so a test cannot reach somewhere a run could not.
   */
  toolTransport?: HttpTransport;
  /** Test seam: build a bridge instead of spawning a real runner. */
  createBridge?: (options: {
    modelId: string;
    packageFd: number;
    artifactsFd: number;
    broker: ToolBroker;
  }) => Pick<ExecutionBridge, "run" | "cancel" | "probe">;
};

export class ExecutionService {
  readonly runs: RunManager;

  constructor(private readonly options: ExecutionServiceOptions) {
    this.runs = new RunManager(options.runtimeDir);
  }

  /** Whether this backend can run a package at all. */
  available(): boolean {
    return Boolean(this.options.createBridge || this.options.llm());
  }

  // -- start ----------------------------------------------------------------
  async start(
    client: ControlPlaneClient,
    catalog: HostCatalog,
    request: { sessionId: string; runPlanId: string; runPlanSha256: string; input: unknown },
  ): Promise<RunRecordViewType> {
    if (!this.available()) {
      throw new AgentBrowserError(
        "bridge_unavailable",
        "Execution is unavailable",
        "This backend was started without access to the OpenClaw completion runtime.",
      );
    }
    const policy = this.options.policy;
    const inputBytes = this.measureInput(request.input);
    this.runs.assertNoActiveRun(request.runPlanId, request.sessionId);
    this.checkHostRuntime();

    // The same preflight the probe runs, plus the requirement that consent
    // outlast the whole run deadline. A margin covers spawn and preparation.
    const preflight: PreflightOutcome = await revalidate({
      client,
      catalog,
      sessionId: request.sessionId,
      runPlanId: request.runPlanId,
      runPlanSha256: request.runPlanSha256,
      minimumReceiptRemainingMs: policy.runTimeoutSeconds * 1000 + 60_000,
      toolRegistry: this.options.tools().registry,
      requireMode: "model",
    });

    const runId = this.runs.newRunId();
    const record = this.initialRecord(runId, request, preflight, inputBytes);
    const directory = await this.runs.prepareDirectory(runId);
    const entry = this.runs.register({
      view: record,
      directory,
      lease: null,
      bridge: null,
      settled: false,
    });

    try {
      const issued = rec(
        await client.issueExecutionLease(
          request.sessionId,
          preflight.packageDigest,
          request.runPlanId,
          request.runPlanSha256,
        ),
      );
      const leaseRecord = rec(issued.lease);
      entry.lease = { sessionId: request.sessionId, leaseId: str(leaseRecord.lease_id) };
      const path = str(leaseRecord.path);
      if (!path) {
        throw new AgentBrowserError(
          "execution_refused",
          "Execution refused",
          "The control plane issued no lease for this run.",
        );
      }
      return await this.execute(client, entry, preflight, request.input, path);
    } catch (error) {
      this.finishWithError(entry, error);
      // `execute` releases the lease on every path it reaches; this covers the
      // window before it, when one was issued but nothing was spawned.
      if (entry.lease) {
        await client
          .releaseExecutionLease(entry.lease.sessionId, entry.lease.leaseId)
          .catch(() => undefined);
        entry.lease = null;
      }
      await this.runs.persist(runId).catch(() => undefined);
      throw error;
    }
  }

  /** One run's tool authority, built from the plan the preflight re-verified. */
  private broker(preflight: PreflightOutcome): ToolBroker {
    const { definitions } = this.options.tools();
    return new ToolBroker({
      bound: preflight.tools,
      definitions,
      logger: this.options.logger,
      ...(this.options.toolTransport ? { transport: this.options.toolTransport } : {}),
    });
  }

  private measureInput(input: unknown): number {
    let serialized: string;
    try {
      serialized = JSON.stringify(input ?? null);
    } catch {
      throw new AgentBrowserError(
        "invalid_request",
        "The workflow input is not JSON",
        "The input must be a finite JSON value the package's own input schema can validate.",
      );
    }
    const bytes = Buffer.byteLength(serialized);
    if (bytes > MAX_INPUT_BYTES) {
      throw new AgentBrowserError(
        "invalid_request",
        "The workflow input is too large",
        `Inputs are limited to ${MAX_INPUT_BYTES} bytes; this one is ${bytes}.`,
      );
    }
    return bytes;
  }

  private checkHostRuntime(): void {
    const version = this.options.hostRuntimeVersion();
    if (!this.options.policy.requireVerifiedHostRuntime) return;
    if (version === null || version === VERIFIED_HOST_RUNTIME) return;
    throw new AgentBrowserError(
      "execution_refused",
      "This OpenClaw version has not been verified for execution",
      `The token-accounting and usage behaviour this runner relies on was verified against ` +
        `OpenClaw ${VERIFIED_HOST_RUNTIME}; this host reports ${version}. Re-verify, then set ` +
        "plugins.entries.agent-browser.config.execution.requireVerifiedHostRuntime to false.",
    );
  }

  private initialRecord(
    runId: string,
    request: { sessionId: string; runPlanId: string; runPlanSha256: string },
    preflight: PreflightOutcome,
    inputBytes: number,
  ): RunRecordViewType {
    const binding = rec(preflight.binding);
    const pkg = rec(binding.package);
    const model = rec(binding.model_binding);
    const policy = this.options.policy;
    const version = this.options.hostRuntimeVersion();
    return {
      runId,
      sessionId: request.sessionId,
      runPlanId: request.runPlanId,
      runPlanSha256: request.runPlanSha256,
      runInvocationSha256: null,
      inputSha256: null,
      status: "preparing",
      createdAt: new Date().toISOString(),
      startedAt: null,
      endedAt: null,
      durationMs: null,
      package: {
        packageId: str(pkg.package_id),
        name: str(pkg.name),
        version: str(pkg.version),
        digest: str(pkg.digest),
        archiveSha256: str(pkg.archive_sha256),
        executionProfile: str(pkg.execution_profile),
      },
      selectedModel: {
        hostModelId: str(model.host_model_id),
        providerId: str(model.provider_id),
        modelId: str(model.model_id),
        displayName: str(model.display_name),
      },
      model: null,
      grants: {
        decisions: Object.entries(preflight.authorization.decisions).map(
          ([permissionId, decision]) => ({ permissionId, decision: decision as never }),
        ),
        grantedPermissionIds: Object.entries(preflight.authorization.decisions)
          .filter(([, decision]) => decision !== "deny")
          .map(([permissionId]) => permissionId),
      },
      limits: {
        host: {
          totalTokens: policy.totalTokens,
          maxRemoteCalls: policy.maxRemoteCalls,
          maxParallelWorkers: policy.maxParallelWorkers,
          maxOutputTokensPerCall: policy.maxOutputTokensPerCall,
          runTimeoutSeconds: policy.runTimeoutSeconds,
        },
        effectiveDeadlineSeconds: null,
      },
      usage: null,
      cost: null,
      audit: null,
      outputSha256: null,
      artifacts: [],
      host: {
        runtime: "openclaw",
        runtimeVersion: version,
        verifiedVersion: VERIFIED_HOST_RUNTIME,
        versionVerified: version === VERIFIED_HOST_RUNTIME,
      },
      deadlineExceeded: false,
      cancelRequested: false,
      errorCode: null,
      errorDetail: null,
      revalidated: [...preflight.revalidated, `input_bytes:${inputBytes}`],
      packageExecution: {
        workflowInstantiated: false,
        packageInstructionsLoaded: false,
        toolHandlersInstalled: preflight.tools.length,
        toolCalls: 0,
      },
      tools: preflight.tools.map((tool) => ({
        toolId: tool.toolId,
        bindingId: tool.bindingId,
        bindingSha256: tool.bindingSha256,
        remote: tool.remote,
        calls: 0,
      })),
    };
  }

  private async execute(
    client: ControlPlaneClient,
    entry: ReturnType<RunManager["register"]>,
    preflight: PreflightOutcome,
    input: unknown,
    leasePath: string,
  ): Promise<RunRecordViewType> {
    const policy = this.options.policy;
    const runId = entry.view.runId;
    // Open both descriptors here, in trusted host code. The child never learns
    // either path, so these are the only two files it can touch.
    const packageFd = openSync(leasePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    let artifactsFd = -1;
    try {
      artifactsFd = openSync(
        entry.directory,
        fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW,
      );
    } catch (error) {
      closeSync(packageFd);
      throw error;
    }
    // This run's tool authority: exactly the bindings its plan froze, held
    // here and never in the child. A run with no bound tool gets a broker with
    // nothing in it, so `tool.call` is refused rather than absent-but-possible.
    const broker = this.broker(preflight);
    const bridge = this.options.createBridge
      ? this.options.createBridge({
          modelId: preflight.modelId,
          packageFd,
          artifactsFd,
          broker,
        })
      : new ExecutionBridge({
          agentpkgPath: this.options.agentpkgPath(),
          modelId: preflight.modelId,
          llm: this.options.llm()!,
          logger: this.options.logger,
          packageFd,
          artifactsFd,
          broker,
          limits: {
            maxOutputTokens: policy.maxOutputTokensPerCall,
            completionTimeoutMs: Math.min(policy.runTimeoutSeconds, 600) * 1000,
            // The whole child outlives the run deadline, so a run that hits its
            // own deadline reports a timeout rather than a killed bridge.
            sessionTimeoutMs: (policy.runTimeoutSeconds + 120) * 1000,
          },
        });
    entry.bridge = bridge as ExecutionBridge;
    this.runs.update(runId, { status: "running", startedAt: new Date().toISOString() });

    try {
      const outcome = await bridge.run({
        run_id: runId,
        run_plan: preflight.binding,
        authorization: {
          receipt_id: preflight.authorization.receiptId,
          receipt_sha256: preflight.authorization.receiptSha256,
          issued_at: preflight.authorization.issuedAt,
          expires_at: preflight.authorization.expiresAt,
          // Exactly the decisions the person left, unchanged. The runner
          // refuses anything it cannot honour rather than widening one.
          decisions: preflight.authorization.decisions,
          tool_approvals: preflight.authorization.toolApprovals,
        },
        limits: {
          total_tokens: policy.totalTokens,
          max_remote_calls: policy.maxRemoteCalls,
          max_parallel_workers: policy.maxParallelWorkers,
          max_output_tokens_per_call: policy.maxOutputTokensPerCall,
          run_timeout_seconds: policy.runTimeoutSeconds,
          max_calls_per_tool: policy.maxCallsPerTool,
        },
        input,
        host: {
          runtime: "openclaw",
          runtime_version: this.options.hostRuntimeVersion(),
          verified_version: VERIFIED_HOST_RUNTIME,
        },
      });
      this.applyOutcome(entry, outcome.begin, outcome.result);
    } catch (error) {
      this.finishWithError(entry, error);
      throw error;
    } finally {
      entry.bridge = null;
      entry.settled = true;
      if (entry.lease) {
        await client
          .releaseExecutionLease(entry.lease.sessionId, entry.lease.leaseId)
          .catch(() => undefined);
        entry.lease = null;
      }
      await this.runs.persist(runId).catch(() => undefined);
    }
    return this.runs.require(runId).view;
  }

  private applyOutcome(
    entry: ReturnType<RunManager["register"]>,
    begin: Record<string, unknown>,
    result: Record<string, unknown>,
  ): void {
    const runId = entry.view.runId;
    const status = str(result.status);
    const usage = rec(result.usage);
    const audit = rec(result.audit);
    const chain = rec(audit.chain);
    const cost = rec(result.cost);
    const model = rec(result.model);
    const limits = rec(result.limits);
    const execution = rec(rec(begin).execution);
    const started = entry.view.startedAt;
    const ended = new Date().toISOString();
    this.runs.update(runId, {
      status: (["completed", "failed", "cancelled"].includes(status)
        ? status
        : "failed") as RunRecordViewType["status"],
      runInvocationSha256: str(result.run_invocation_sha256) || null,
      inputSha256: str(result.input_sha256) || null,
      endedAt: ended,
      durationMs: started ? Date.parse(ended) - Date.parse(started) : null,
      limits: {
        ...entry.view.limits,
        effectiveDeadlineSeconds: int(limits.effective_deadline_seconds) || null,
      },
      model: {
        planned: str(model.planned),
        invoked: strings(model.invoked, 16),
        calls: int(model.calls),
        allCallsUsedPlannedModel: model.all_calls_used_planned_model === true,
        providers: strings(model.providers, 16),
        responseModels: strings(model.response_models, 16),
      },
      usage: {
        tokens: int(usage.tokens),
        remoteCalls: int(usage.remote_calls),
        peakParallelWorkers: int(usage.peak_parallel_workers),
        toolCalls: Object.keys(rec(usage.tool_calls)).length,
        limits: {
          hardTokens: int(rec(usage.limits).hard_tokens),
          maxRemoteCalls: int(rec(usage.limits).max_remote_calls),
          maxParallelWorkers: int(rec(usage.limits).max_parallel_workers),
        },
        workers: Object.entries(rec(usage.workers))
          .slice(0, 64)
          .map(([worker, value]) => ({
            worker: clip(worker, 128),
            tokens: int(rec(value).tokens),
            remoteCalls: int(rec(value).remote_calls),
          })),
      },
      cost: {
        status: str(cost.status) || "unknown",
        totalUsd: typeof cost.total_usd === "number" ? cost.total_usd : null,
        calls: int(cost.calls),
        callsWithReportedCost: int(cost.calls_with_reported_cost),
      },
      audit: {
        events: int(chain.events),
        chainValid: chain.valid === true,
        finalHash: str(chain.final_hash) || null,
        actions: counts(audit.actions, "action", 64),
        workers: strings(audit.workers, 64),
        workersSpawned: int(audit.workers_spawned),
        nodesCompleted: int(audit.nodes_completed),
        modelCalls: int(audit.model_calls),
        toolCalls: int(audit.tool_calls),
        tasksCalled: counts(audit.tasks_called, "task", 64),
      },
      outputSha256: str(rec(result.output).sha256) || null,
      artifacts: (Array.isArray(result.artifacts) ? result.artifacts : [])
        .slice(0, 64)
        .map((item) => ({
          name: clip(str(rec(item).name), 128),
          bytes: int(rec(item).bytes),
          sha256: str(rec(item).sha256),
        })),
      deadlineExceeded: result.deadline_exceeded === true,
      cancelRequested: result.cancel_requested === true,
      errorCode: str(result.error_code) || null,
      packageExecution: {
        workflowInstantiated: rec(result.package_execution).workflow_instantiated === true,
        packageInstructionsLoaded:
          rec(result.package_execution).package_instructions_loaded === true,
        toolHandlersInstalled: int(rec(result.package_execution).tool_handlers_installed),
        toolCalls: int(rec(result.package_execution).tool_calls),
      },
      tools: entry.view.tools.map((tool) => ({
        ...tool,
        calls: int(rec(rec(usage.tool_calls))[tool.toolId]),
      })),
      revalidated: [
        ...entry.view.revalidated,
        ...strings(rec(begin.package).verified, 16).map((name) => `runner:${name}`),
        `runner:tool_handlers:${int(execution.tool_handlers)}`,
        ...strings(rec(begin.tools).bound, 16).map((name) => `runner:tool_bound:${name}`),
      ],
    });
  }

  private finishWithError(entry: ReturnType<RunManager["register"]>, error: unknown): void {
    if (isTerminal(entry.view.status)) return;
    const failure =
      error instanceof AgentBrowserError
        ? error
        : new AgentBrowserError("execution_refused", "The run failed", "Unhandled error");
    const started = entry.view.startedAt;
    const ended = new Date().toISOString();
    this.runs.update(entry.view.runId, {
      status: failure.code === "model_call_cancelled" ? "cancelled" : "failed",
      endedAt: ended,
      durationMs: started ? Date.parse(ended) - Date.parse(started) : null,
      errorCode: failure.code,
      errorDetail: clip(failure.detail, 4096),
    });
  }

  // -- tool probe -----------------------------------------------------------
  /**
   * Make exactly one mediated tool call against a ready plan, and report it.
   *
   * The caller chooses *which declared tool* and *which host-owned fixture*.
   * It cannot choose a destination, a method, a header, an endpoint or an
   * argument of its own: the fixture table below is host code, the binding
   * comes from the plan, and the request is built by the broker. This is a way
   * to verify the broker, not a way to make a request.
   */
  async toolProbe(
    client: ControlPlaneClient,
    catalog: HostCatalog,
    request: {
      sessionId: string;
      runPlanId: string;
      runPlanSha256: string;
      toolId: string;
      fixtureId?: string;
    },
  ): Promise<{ begin: Record<string, unknown>; report: Record<string, unknown> }> {
    if (!this.available()) {
      throw new AgentBrowserError(
        "bridge_unavailable",
        "Execution is unavailable",
        "This backend was started without access to the OpenClaw completion runtime.",
      );
    }
    this.checkHostRuntime();
    const preflight = await revalidate({
      client,
      catalog,
      sessionId: request.sessionId,
      runPlanId: request.runPlanId,
      runPlanSha256: request.runPlanSha256,
      toolRegistry: this.options.tools().registry,
    });
    const bound = preflight.tools.find((tool) => tool.toolId === request.toolId);
    if (!bound) {
      throw new AgentBrowserError(
        "execution_refused",
        "That tool is not bound by this run plan",
        `This plan binds ${preflight.tools.map((tool) => tool.toolId).join(", ") || "no tools"}.`,
      );
    }
    let fixture;
    try {
      fixture = pickFixture(request.toolId, request.fixtureId);
    } catch (error) {
      throw new AgentBrowserError(
        "invalid_request",
        "No such probe fixture",
        clip((error as Error).message, 1000),
      );
    }
    const runId = this.runs.newRunId();
    const directory = await this.runs.prepareDirectory(runId);
    const issued = rec(
      await client.issueExecutionLease(
        request.sessionId,
        preflight.packageDigest,
        request.runPlanId,
        request.runPlanSha256,
      ),
    );
    const lease = rec(issued.lease);
    const leaseId = str(lease.lease_id);
    const path = str(lease.path);
    if (!path) {
      throw new AgentBrowserError(
        "execution_refused",
        "Execution refused",
        "The control plane issued no lease for this probe.",
      );
    }
    const packageFd = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    let artifactsFd = -1;
    try {
      artifactsFd = openSync(
        directory,
        fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW,
      );
    } catch (error) {
      closeSync(packageFd);
      throw error;
    }
    const policy = this.options.policy;
    const broker = this.broker(preflight);
    const bridge = this.options.createBridge
      ? this.options.createBridge({
          modelId: preflight.modelId,
          packageFd,
          artifactsFd,
          broker,
        })
      : new ExecutionBridge({
          agentpkgPath: this.options.agentpkgPath(),
          modelId: preflight.modelId,
          llm: this.options.llm()!,
          logger: this.options.logger,
          packageFd,
          artifactsFd,
          broker,
          limits: {
            maxOutputTokens: policy.maxOutputTokensPerCall,
            completionTimeoutMs: Math.min(policy.runTimeoutSeconds, 600) * 1000,
            sessionTimeoutMs: (policy.runTimeoutSeconds + 120) * 1000,
          },
        });
    try {
      const outcome = await bridge.probe(
        {
          run_id: runId,
          run_plan: preflight.binding,
          authorization: {
            receipt_id: preflight.authorization.receiptId,
            receipt_sha256: preflight.authorization.receiptSha256,
            issued_at: preflight.authorization.issuedAt,
            expires_at: preflight.authorization.expiresAt,
            decisions: preflight.authorization.decisions,
            tool_approvals: preflight.authorization.toolApprovals,
          },
          limits: {
            total_tokens: policy.totalTokens,
            max_remote_calls: policy.maxRemoteCalls,
            max_parallel_workers: policy.maxParallelWorkers,
            max_output_tokens_per_call: policy.maxOutputTokensPerCall,
            run_timeout_seconds: policy.runTimeoutSeconds,
            max_calls_per_tool: policy.maxCallsPerTool,
          },
          // The probe never reaches the graph, so the input is only what the
          // package's own input schema has to accept for `begin` to succeed.
          input: fixture.workflowInput,
          host: {
            runtime: "openclaw",
            runtime_version: this.options.hostRuntimeVersion(),
            verified_version: VERIFIED_HOST_RUNTIME,
          },
        },
        { toolId: request.toolId, args: fixture.args },
      );
      return {
        ...outcome,
        report: {
          ...outcome.report,
          fixture: { id: fixture.id, tool_id: request.toolId, source: "host_owned" },
          revalidated: preflight.revalidated,
          transport: {
            ...rec(outcome.report.transport),
            host_calls: broker.calls,
          },
        },
      };
    } finally {
      await client.releaseExecutionLease(request.sessionId, leaseId).catch(() => undefined);
      this.runs.clear({ runId });
    }
  }

  // -- control --------------------------------------------------------------
  async cancel(runId: string): Promise<RunRecordViewType> {
    const entry = this.runs.require(runId);
    if (isTerminal(entry.view.status)) return entry.view;
    this.runs.update(runId, { cancelRequested: true });
    const bridge = entry.bridge;
    if (bridge) await bridge.cancel();
    return this.runs.require(runId).view;
  }

  /** Read one artifact a run wrote. The directory's path never leaves here. */
  async artifact(runId: string, name: string): Promise<RunArtifactContentViewType> {
    const entry = this.runs.require(runId);
    if (name.includes("/") || name.includes("\\") || name.startsWith(".")) {
      throw new AgentBrowserError(
        "invalid_request",
        "Unsafe artifact name",
        "An artifact is named by one plain filename.",
      );
    }
    const listed = await readdir(entry.directory).catch(() => [] as string[]);
    if (!listed.includes(name)) {
      throw new AgentBrowserError(
        "execution_unknown",
        "No such artifact",
        `This run wrote no artifact named ${clip(name, 64)}.`,
      );
    }
    const data = await readFile(join(entry.directory, name));
    const truncated = data.byteLength > MAX_ARTIFACT_BYTES;
    const body = data.subarray(0, MAX_ARTIFACT_BYTES).toString("utf8");
    const view: RunArtifactContentViewType = {
      runId,
      name,
      bytes: data.byteLength,
      sha256: createHash("sha256").update(data).digest("hex"),
      truncated,
    };
    if (name.endsWith(".json") && !truncated) {
      try {
        view.json = JSON.parse(body) as unknown;
        return view;
      } catch {
        // Fall through to text.
      }
    }
    view.text = body;
    return view;
  }

  /** Stop every run in flight. Called when the Gateway stops the plugin. */
  async stopAll(): Promise<void> {
    for (const entry of this.runs.active()) {
      this.runs.update(entry.view.runId, {
        status: "cancelled",
        cancelRequested: true,
        endedAt: new Date().toISOString(),
        errorCode: "gateway_stopped",
        errorDetail:
          "The Agent Browser backend stopped while this run was in flight. Run state is " +
          "ephemeral, so an interrupted run ends rather than resuming.",
      });
      await entry.bridge?.cancel().catch(() => undefined);
    }
  }
}
