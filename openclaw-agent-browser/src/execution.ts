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
import { open, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { ControlPlaneClient } from "./control-plane.js";
import type {
  RunArtifactChunkViewType,
  RunArtifactContentViewType,
  RunProgressViewType,
  RunReadinessViewType,
  RunRecordViewType,
  RunTaskViewType,
} from "./contract.js";
import { AgentBrowserError, clip } from "./errors.js";
import { BUDGETS, fitsJson } from "./json-limits.js";
import { ExecutionBridge } from "./execution-bridge.js";
import {
  attachmentsOf,
  type FileCapabilityStore,
  type FileCapabilityView,
} from "./file-capabilities.js";
import type { PdfReader } from "./pdf-reader.js";
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
/**
 * How much of one artifact `execution.artifact` will show: 48 KiB of bytes,
 * which decode to at most 49,152 characters — inside the host's longest
 * string (`HOST_JSON_LIMITS.maxStringLength`). Download has the whole file.
 */
export const MAX_ARTIFACT_BYTES = 48 * 1024;
/**
 * One `execution.artifact-chunk` slice: 48 KiB of bytes, whose base64 is
 * exactly 65,536 characters, the host's longest string.
 */
export const ARTIFACT_CHUNK_BYTES = 48 * 1024;
/** A run record echoes the task input only when it is this small, and fits `BUDGETS.echoedInput`. */
export const MAX_ECHOED_INPUT_BYTES = 16 * 1024;
/**
 * How long consent must outlast a run's deadline before one may start: the
 * margin covers spawning the runner and preparing the run.
 */
export const RECEIPT_MARGIN_SECONDS = 60;
/** An artifact is named by one plain filename, never a path. */
const ARTIFACT_NAME = /^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,127}$/u;
/** Opaque selected-file capability ids, wherever they appear in a task. */
const FILE_ID = /^file_[0-9a-f]{32}$/u;

export type ExecutionPolicy = {
  totalTokens: number;
  maxRemoteCalls: number;
  maxParallelWorkers: number;
  maxOutputTokensPerCall: number;
  runTimeoutSeconds: number;
  /**
   * How long one model completion may take, queueing at the model server
   * included. A local server that decodes one request at a time answers the
   * third of three concurrent workers only after the other two finish, so an
   * operator running one raises this. The package's node timeouts still bound
   * every call; this only stops the host from cutting one off first.
   */
  modelCallTimeoutSeconds: number;
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

/** The runner enforces the same ceiling on `model_call_timeout_seconds`. */
export const MAX_MODEL_CALL_TIMEOUT_SECONDS = 3_600;
/**
 * The runner times a completion out itself and cancels it, which aborts the
 * request here. This host-side timer is only the backstop for a runner that did
 * not, so it fires a little later and never races the runner's own report.
 */
const COMPLETION_BACKSTOP_SECONDS = 30;

function completionTimeoutMs(policy: ExecutionPolicy): number {
  return (policy.modelCallTimeoutSeconds + COMPLETION_BACKSTOP_SECONDS) * 1000;
}

export const DEFAULT_POLICY: ExecutionPolicy = {
  totalTokens: 120_000,
  maxRemoteCalls: 32,
  maxParallelWorkers: 3,
  maxOutputTokensPerCall: 16_000,
  runTimeoutSeconds: 600,
  modelCallTimeoutSeconds: 300,
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
    modelCallTimeoutSeconds: positive(
      raw.modelCallTimeoutSeconds,
      DEFAULT_POLICY.modelCallTimeoutSeconds,
      MAX_MODEL_CALL_TIMEOUT_SECONDS,
    ),
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
   * The person's selected files, as host-held capabilities. A run is given
   * the ones named at start and a file-reading tool can read nothing else.
   */
  files?: FileCapabilityStore;
  /** The trusted PDF parser a `selected_file` binding hands bytes to. */
  pdfReader?: () => PdfReader;
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
    onProgress?: (snapshot: Record<string, unknown>) => void;
  }) => Pick<ExecutionBridge, "run" | "cancel" | "probe">;
};

const WORKER_STATES = new Set(["queued", "active", "completed", "failed", "cancelled"]);

/** Project one runner progress snapshot into the bounded record view. */
export function projectProgress(snapshot: Record<string, unknown>, elapsedMs: number): RunProgressViewType {
  const ids = (value: unknown, max: number) =>
    strings(value, max).map((item) => clip(item, 200));
  const workers = (Array.isArray(snapshot.workers) ? snapshot.workers : [])
    .slice(0, 64)
    .map((item) => {
      const row = rec(item);
      const duration = row.duration_ms;
      return {
        id: clip(str(row.id), 128),
        role: str(row.role) ? clip(str(row.role), 128) : null,
        node: str(row.node) ? clip(str(row.node), 200) : null,
        state: (WORKER_STATES.has(str(row.state)) ? str(row.state) : "queued") as never,
        modelCalls: Math.max(0, int(row.model_calls)),
        toolCalls: Math.max(0, int(row.tool_calls)),
        durationMs:
          typeof duration === "number" && Number.isFinite(duration) && duration >= 0 ? duration : null,
      };
    })
    .filter((row) => row.id.length > 0);
  return {
    updatedAt: new Date().toISOString(),
    events: int(snapshot.events),
    lastAction: str(snapshot.last_action) ? clip(str(snapshot.last_action), 64) : null,
    activeNodes: ids(snapshot.active_nodes, 64),
    completedNodes: ids(snapshot.completed_nodes, 128),
    failedNodes: ids(snapshot.failed_nodes, 64),
    nodesCompleted: Math.max(0, int(snapshot.nodes_completed)),
    stepsCompleted: Math.max(0, int(snapshot.steps_completed)),
    workersSpawned: Math.max(0, int(snapshot.workers_spawned)),
    workersActive: Math.max(0, int(snapshot.workers_active)),
    peakParallelWorkers: Math.max(0, int(snapshot.peak_parallel_workers)),
    activeWorkers: strings(snapshot.active_workers, 64).map((item) => clip(item, 128)),
    modelCallsStarted: Math.max(0, int(snapshot.model_calls_started)),
    modelCallsCompleted: Math.max(0, int(snapshot.model_calls_completed)),
    toolCallsStarted: Math.max(0, int(snapshot.tool_calls_started)),
    toolCallsCompleted: Math.max(0, int(snapshot.tool_calls_completed)),
    tokens: Math.max(0, int(snapshot.tokens)),
    remoteCalls: Math.max(0, int(snapshot.remote_calls)),
    elapsedMs: Math.max(0, elapsedMs),
    skippedNodes: ids(snapshot.skipped_nodes, 128),
    workers,
  };
}

/** Where a run that did not complete stopped, as the runner read it from its audit. */
export function projectFailure(value: unknown): RunRecordViewType["failure"] {
  if (!isRecord(value)) return null;
  const call = isRecord(value.call) ? value.call : null;
  const text = (item: unknown, max: number) => (str(item) ? clip(str(item), max) : null);
  let failedCheck: unknown = null;
  if (isRecord(value.failed_check)) {
    // Declared pointers and codes only; bounded again here.
    const serialized = JSON.stringify(value.failed_check);
    failedCheck = serialized.length <= 2048 ? value.failed_check : null;
  }
  return {
    nodeId: text(value.node_id, 200),
    stepId: text(value.step_id, 200),
    errorCode: text(value.error_code, 64),
    failedCheck,
    call: call
      ? {
          kind: clip(str(call.kind), 32),
          action: clip(str(call.action), 64),
          tool: text(call.tool, 200),
          task: text(call.task, 128),
          reason: text(call.reason, 64),
        }
      : null,
  };
}

/** Every selected-file id a task names, wherever in the task it appears. */
export function referencedFileIds(value: unknown, found = new Set<string>(), depth = 0): Set<string> {
  if (depth > 32) return found;
  if (typeof value === "string") {
    if (FILE_ID.test(value)) found.add(value);
  } else if (Array.isArray(value)) {
    for (const item of value) referencedFileIds(item, found, depth + 1);
  } else if (isRecord(value)) {
    for (const [key, item] of Object.entries(value)) {
      if (FILE_ID.test(key)) found.add(key);
      referencedFileIds(item, found, depth + 1);
    }
  }
  return found;
}

export class ExecutionService {
  readonly runs: RunManager;

  constructor(private readonly options: ExecutionServiceOptions) {
    this.runs = new RunManager(options.runtimeDir);
  }

  /** Whether this backend can run a package at all. */
  available(): boolean {
    return Boolean(this.options.createBridge || this.options.llm());
  }

  /** Resolve the files a run was given against its own session, or refuse. */
  private attach(sessionId: string, fileIds: readonly string[] | undefined): Map<string, FileCapabilityView> {
    if (!fileIds || fileIds.length === 0) return new Map();
    if (!this.options.files) {
      throw new AgentBrowserError(
        "not_allowed",
        "File selection is not available",
        "This backend holds no selected-file store, so a run cannot be given files.",
      );
    }
    return this.options.files.attach(sessionId, fileIds);
  }

  // -- start ----------------------------------------------------------------
  async start(
    client: ControlPlaneClient,
    catalog: HostCatalog,
    request: {
      sessionId: string;
      runPlanId: string;
      runPlanSha256: string;
      input: unknown;
      files?: readonly string[];
      detach?: boolean;
    },
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
    // Every named file must be a live capability of this session, before
    // anything is prepared; a path or another session's id is refused here.
    const attached = this.attach(request.sessionId, request.files);
    // ...and a task may only name the files this run is given. A stale id, or
    // one from another session, is refused now rather than at the first read.
    this.checkReferencedFiles(request.input, attached);
    // The package's own input schema, through the control plane, before a
    // lease exists: invalid input costs nothing and names the field.
    await this.checkInput(client, request.sessionId, request.input);

    // The same preflight the probe runs, plus the requirement that consent
    // outlast the whole run deadline. A margin covers spawn and preparation.
    const preflight: PreflightOutcome = await revalidate({
      client,
      catalog,
      sessionId: request.sessionId,
      runPlanId: request.runPlanId,
      runPlanSha256: request.runPlanSha256,
      minimumReceiptRemainingMs: (policy.runTimeoutSeconds + RECEIPT_MARGIN_SECONDS) * 1000,
      toolRegistry: this.options.tools().registry,
      requireMode: "model",
    });
    // Reading a selected file is a permission of its own; attaching one does
    // not grant it, and a run that could not read it is refused up front.
    this.checkFilePermission(preflight, attached);

    const runId = this.runs.newRunId();
    const record = this.initialRecord(runId, request, preflight, inputBytes, attached);
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
      return await this.execute(client, entry, preflight, request.input, path, {
        attached,
        detach: request.detach === true,
      });
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

  /**
   * One run's tool authority, built from the plan the preflight re-verified.
   *
   * It holds exactly the bindings the plan froze and exactly the selected
   * files this run was given; neither can grow after construction.
   */
  private broker(
    preflight: PreflightOutcome,
    attached: ReadonlyMap<string, FileCapabilityView> = new Map(),
  ): ToolBroker {
    const { definitions } = this.options.tools();
    return new ToolBroker({
      bound: preflight.tools,
      definitions,
      logger: this.options.logger,
      files: attached,
      ...(this.options.files ? { fileStore: this.options.files } : {}),
      ...(this.options.pdfReader ? { pdfReader: this.options.pdfReader() } : {}),
      ...(this.options.toolTransport ? { transport: this.options.toolTransport } : {}),
    });
  }

  private checkReferencedFiles(
    input: unknown,
    attached: ReadonlyMap<string, FileCapabilityView>,
  ): void {
    for (const fileId of referencedFileIds(input)) {
      if (!attached.has(fileId)) {
        throw new AgentBrowserError(
          "invalid_request",
          "The task names a file this run was not given",
          "Every selected-file id in the task must be one of this run's attached files. " +
            "Select the document again if its capability expired.",
        );
      }
    }
  }

  private async checkInput(client: ControlPlaneClient, sessionId: string, input: unknown): Promise<void> {
    const report = rec(await client.validateInput(sessionId, input));
    if (report.valid === true) return;
    const errors = Array.isArray(report.errors) ? report.errors.map(rec) : [];
    const listed = errors
      .slice(0, 4)
      .map((item) => `${str(item.pointer) || "(task)"} ${str(item.message)}`)
      .join("; ");
    throw new AgentBrowserError(
      "input_invalid",
      "The task does not match this package's input",
      clip(listed || "The package's own input schema refused this task.", 2000),
    );
  }

  private checkFilePermission(
    preflight: PreflightOutcome,
    attached: ReadonlyMap<string, FileCapabilityView>,
  ): void {
    if (attached.size === 0) return;
    const bindings = Array.isArray(preflight.plan.tool_bindings)
      ? preflight.plan.tool_bindings.map(rec)
      : [];
    const readers = bindings.filter((binding) => str(binding.implementation_kind) === "selected_file");
    if (readers.length === 0) {
      throw new AgentBrowserError(
        "execution_refused",
        "This package reads no selected files",
        "The run plan binds no tool that reads selected files, so a run cannot be given one.",
      );
    }
    const decisions = preflight.authorization.decisions;
    const denied = [
      ...new Set(
        readers.flatMap((binding) =>
          (Array.isArray(binding.required_permission_ids) ? binding.required_permission_ids : [])
            .map(str)
            .filter((id) => (decisions[id] ?? "deny") === "deny"),
        ),
      ),
    ];
    if (denied.length > 0) {
      throw new AgentBrowserError(
        "execution_refused",
        "Selected files need a permission that is denied",
        `Reading the selected documents requires ${denied.join(", ")}, which this authorization ` +
          "denies. Allow it under Permissions, authorize again and prepare a new run plan — " +
          "or run without documents.",
      );
    }
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

  private task(input: unknown, inputBytes: number, attached: ReadonlyMap<string, FileCapabilityView>): RunTaskViewType {
    return echoTask(
      input,
      inputBytes,
      attachmentsOf(attached).map((file) => ({
        fileId: file.file_id,
        sha256: file.sha256,
        bytes: file.bytes,
        mediaType: file.media_type,
      })),
    );
  }

  private initialRecord(
    runId: string,
    request: { sessionId: string; runPlanId: string; runPlanSha256: string; input: unknown },
    preflight: PreflightOutcome,
    inputBytes: number,
    attached: ReadonlyMap<string, FileCapabilityView> = new Map(),
  ): RunRecordViewType {
    const binding = rec(preflight.binding);
    const pkg = rec(binding.package);
    const model = rec(binding.model_binding);
    const local = rec(model.properties).local;
    const displayNames = new Map(
      (Array.isArray(preflight.plan.tool_bindings) ? preflight.plan.tool_bindings : [])
        .map(rec)
        .map((item) => [str(item.tool_id), str(item.display_name)] as const),
    );
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
        local: typeof local === "boolean" ? local : null,
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
          modelCallTimeoutSeconds: policy.modelCallTimeoutSeconds,
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
      task: this.task(request.input, inputBytes, attached),
      progress: null,
      tools: preflight.tools.map((tool) => ({
        toolId: tool.toolId,
        bindingId: tool.bindingId,
        bindingSha256: tool.bindingSha256,
        remote: tool.remote,
        calls: 0,
        displayName: clip(displayNames.get(tool.toolId) ?? "", 512) || null,
      })),
      failure: null,
      origin: "live",
    };
  }

  private async execute(
    client: ControlPlaneClient,
    entry: ReturnType<RunManager["register"]>,
    preflight: PreflightOutcome,
    input: unknown,
    leasePath: string,
    options: { attached: ReadonlyMap<string, FileCapabilityView>; detach: boolean } = {
      attached: new Map(),
      detach: false,
    },
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
    const broker = this.broker(preflight, options.attached);
    const startedMs = Date.now();
    // Live progress, derived by the runner from its own audit. Identifiers and
    // counts only; a terminal record is never rewritten by a late snapshot.
    const onProgress = (snapshot: Record<string, unknown>) => {
      const current = this.runs.get(runId);
      if (!current || isTerminal(current.view.status)) return;
      this.runs.update(runId, { progress: projectProgress(snapshot, Date.now() - startedMs) });
    };
    let signalBegun: (begin: Record<string, unknown>) => void = () => undefined;
    const begun = new Promise<Record<string, unknown>>((resolve) => {
      signalBegun = resolve;
    });
    const onBegin = (begin: Record<string, unknown>) => {
      const invocation = rec(begin.invocation);
      this.runs.update(runId, {
        runInvocationSha256: str(invocation.run_invocation_sha256) || null,
        inputSha256: str(invocation.input_sha256) || null,
      });
      signalBegun(begin);
    };
    const bridge = this.options.createBridge
      ? this.options.createBridge({
          modelId: preflight.modelId,
          packageFd,
          artifactsFd,
          broker,
          onProgress,
        })
      : new ExecutionBridge({
          agentpkgPath: this.options.agentpkgPath(),
          modelId: preflight.modelId,
          llm: this.options.llm()!,
          logger: this.options.logger,
          packageFd,
          artifactsFd,
          broker,
          onProgress,
          limits: {
            maxOutputTokens: policy.maxOutputTokensPerCall,
            completionTimeoutMs: completionTimeoutMs(policy),
            // The whole child outlives the run deadline, so a run that hits its
            // own deadline reports a timeout rather than a killed bridge.
            sessionTimeoutMs: (policy.runTimeoutSeconds + 120) * 1000,
          },
        });
    entry.bridge = bridge as ExecutionBridge;
    this.runs.update(runId, { status: "running", startedAt: new Date().toISOString() });

    const running = this.drive(client, entry, preflight, input, bridge, options.attached, onBegin);
    if (!options.detach) {
      await running;
      return this.runs.require(runId).view;
    }
    // Detached: answer once the runner has bound the plan (so a refusal is
    // still returned to the caller), and let the run finish in the background.
    const first = await Promise.race([
      begun.then(() => "begun" as const),
      running.then(
        () => "ended" as const,
        (error: unknown) => ({ error }),
      ),
    ]);
    if (typeof first === "object") throw first.error;
    running.catch(() => undefined);
    return this.runs.require(runId).view;
  }

  /** Bind, run and settle one execution; records the outcome however it ends. */
  private async drive(
    client: ControlPlaneClient,
    entry: ReturnType<RunManager["register"]>,
    preflight: PreflightOutcome,
    input: unknown,
    bridge: Pick<ExecutionBridge, "run" | "cancel" | "probe">,
    attached: ReadonlyMap<string, FileCapabilityView>,
    onBegin: (begin: Record<string, unknown>) => void,
  ): Promise<void> {
    const policy = this.options.policy;
    const runId = entry.view.runId;
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
          model_call_timeout_seconds: policy.modelCallTimeoutSeconds,
        },
        input,
        attachments: attachmentsOf(attached),
        host: {
          runtime: "openclaw",
          runtime_version: this.options.hostRuntimeVersion(),
          verified_version: VERIFIED_HOST_RUNTIME,
        },
      }, { onBegin });
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
    const elapsed = started ? Date.parse(ended) - Date.parse(started) : 0;
    this.runs.update(runId, {
      // The runner's own snapshot taken after the run settled, so the final
      // record is exact even if the last throttled update never arrived.
      ...(isRecord(result.progress)
        ? { progress: projectProgress(result.progress, Math.max(0, elapsed)) }
        : {}),
      failure: status === "completed" ? null : projectFailure(result.failure),
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
        // Every attempted dispatch, summed across tools.
        toolCalls: Object.values(rec(usage.tool_calls)).reduce<number>(
          (total, count) => total + int(count),
          0,
        ),
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
      fileId?: string;
      role?: string;
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
    // A file-reading fixture reads one capability the operator selected in
    // this session, and nothing else; the id is the host's, never a path.
    if (fixture.requiresFile && !request.fileId) {
      throw new AgentBrowserError(
        "invalid_request",
        "This probe reads a selected file",
        "Select a PDF for this session with files.select-local and pass its fileId.",
      );
    }
    if (!fixture.requiresFile && request.fileId) {
      throw new AgentBrowserError(
        "invalid_request",
        "This probe reads no file",
        "Only a file-reading fixture takes a fileId.",
      );
    }
    const attached = this.attach(request.sessionId, request.fileId ? [request.fileId] : []);
    const args = fixture.requiresFile ? { file_id: request.fileId } : fixture.args;
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
    const broker = this.broker(preflight, attached);
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
            completionTimeoutMs: completionTimeoutMs(policy),
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
            model_call_timeout_seconds: policy.modelCallTimeoutSeconds,
          },
          // The probe never reaches the graph, so the input is only what the
          // package's own input schema has to accept for `begin` to succeed.
          input: fixture.workflowInput,
          attachments: attachmentsOf(attached),
          host: {
            runtime: "openclaw",
            runtime_version: this.options.hostRuntimeVersion(),
            verified_version: VERIFIED_HOST_RUNTIME,
          },
        },
        { toolId: request.toolId, args, ...(request.role ? { role: request.role } : {}) },
      );
      return {
        ...outcome,
        report: {
          ...outcome.report,
          fixture: {
            id: fixture.id,
            tool_id: request.toolId,
            source: "host_owned",
            file_id: request.fileId ?? null,
          },
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

  /** Resolve one artifact name inside one run's directory, or refuse. */
  private async artifactEntry(runId: string, name: string) {
    const entry = this.runs.require(runId);
    if (!ARTIFACT_NAME.test(name) || name.includes("..")) {
      throw new AgentBrowserError(
        "invalid_request",
        "Unsafe artifact name",
        "An artifact is named by one plain filename.",
      );
    }
    // Only names this run actually wrote exist; nothing else in the host's
    // filesystem can be named through here.
    const listed = await readdir(entry.directory).catch(() => [] as string[]);
    if (!listed.includes(name)) {
      throw new AgentBrowserError(
        "execution_unknown",
        "No such artifact",
        `This run wrote no artifact named ${clip(name, 64)}.`,
      );
    }
    return entry;
  }

  /** Read one artifact a run wrote. The directory's path never leaves here. */
  async artifact(runId: string, name: string): Promise<RunArtifactContentViewType> {
    const entry = await this.artifactEntry(runId, name);
    const data = await this.readArtifactBytes(join(entry.directory, name));
    return artifactContent(runId, name, data);
  }

  /**
   * One bounded slice of an artifact, for downloading one larger than a view.
   *
   * The whole file's size and SHA-256 come back with every slice, so the page
   * can verify what it assembled. The file is opened without following links.
   */
  async artifactChunk(runId: string, name: string, offset: number): Promise<RunArtifactChunkViewType> {
    const entry = await this.artifactEntry(runId, name);
    const data = await this.readArtifactBytes(join(entry.directory, name));
    if (!Number.isInteger(offset) || offset < 0 || offset > data.byteLength) {
      throw new AgentBrowserError(
        "invalid_request",
        "Offset outside the artifact",
        `This artifact has ${data.byteLength} bytes.`,
      );
    }
    return artifactSlice(runId, name, data, offset);
  }

  private async readArtifactBytes(path: string): Promise<Buffer> {
    const handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.size > 64 * 1024 * 1024) {
        throw new AgentBrowserError(
          "invalid_request",
          "Artifact not readable",
          "An artifact is one regular file of bounded size.",
        );
      }
      return await handle.readFile();
    } finally {
      await handle.close().catch(() => undefined);
    }
  }

  /**
   * Whether a Run could start right now, by the checks `start` itself makes.
   *
   * Nothing is prepared, leased or spawned. The answer names the first check
   * that would refuse and everything that passed before it.
   */
  async readiness(
    client: ControlPlaneClient,
    catalog: HostCatalog | null,
    sessionId: string,
  ): Promise<RunReadinessViewType> {
    const policy = this.options.policy;
    const requiredSeconds = policy.runTimeoutSeconds + RECEIPT_MARGIN_SECONDS;
    const active = this.runs.list(sessionId).active;
    const view: RunReadinessViewType = {
      sessionId,
      checkedAt: new Date().toISOString(),
      ready: false,
      executionAvailable: this.available(),
      runPlanId: null,
      runPlanSha256: null,
      blocker: null,
      checks: [],
      receipt: null,
      activeRunId: active ? active.runId : null,
    };
    const block = (error: unknown) => {
      const failure =
        error instanceof AgentBrowserError
          ? error
          : new AgentBrowserError("execution_refused", "Run unavailable", "Unhandled error");
      view.blocker = {
        code: failure.code,
        title: clip(failure.title, 200),
        detail: clip(failure.detail, 4096),
      };
      const passed = (failure as AgentBrowserError & { revalidated?: string[] }).revalidated;
      if (Array.isArray(passed)) view.checks = passed.slice(0, 64);
      return view;
    };
    try {
      const receipt = rec(await client.getAuthorization(sessionId));
      const expiry = Date.parse(str(receipt.expires_at));
      view.receipt = {
        expiresAt: str(receipt.expires_at) || null,
        remainingSeconds: Number.isFinite(expiry) ? Math.floor((expiry - Date.now()) / 1000) : null,
        requiredSeconds,
      };
    } catch (error) {
      return block(
        error instanceof AgentBrowserError && error.code === "session_expired"
          ? new AgentBrowserError(
              "run_plan_absent",
              "Authorize this package first",
              "A run needs an authorization receipt and a prepared run plan.",
            )
          : error,
      );
    }
    let plan: Record<string, unknown>;
    try {
      plan = rec(rec(await client.getRunPlan(sessionId)).run_plan);
    } catch (error) {
      return block(error);
    }
    view.runPlanId = str(plan.run_plan_id) || null;
    view.runPlanSha256 = str(plan.run_plan_sha256) || null;
    try {
      if (!this.available()) {
        throw new AgentBrowserError(
          "bridge_unavailable",
          "Execution is unavailable",
          "This backend was started without access to the OpenClaw completion runtime.",
        );
      }
      this.checkHostRuntime();
      if (!catalog) {
        throw new AgentBrowserError(
          "model_catalog_unavailable",
          "Model discovery unavailable",
          "This backend cannot read the OpenClaw model catalog, so the bound model cannot be checked.",
        );
      }
      const preflight = await revalidate({
        client,
        catalog,
        sessionId,
        runPlanId: view.runPlanId ?? "",
        runPlanSha256: view.runPlanSha256 ?? "",
        minimumReceiptRemainingMs: requiredSeconds * 1000,
        toolRegistry: this.options.tools().registry,
        requireMode: "model",
      });
      view.checks = preflight.revalidated.slice(0, 64);
      if (active) {
        throw new AgentBrowserError(
          "execution_active",
          "A run is already in progress",
          `Run ${active.runId} is ${active.status} for this package session.`,
        );
      }
      view.ready = true;
      return view;
    } catch (error) {
      return block(error);
    }
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

/**
 * What `execution.artifact` returns for one artifact's bytes.
 *
 * At most `MAX_ARTIFACT_BYTES` of it, as text; a JSON artifact comes back
 * parsed only when the whole of it is shown and its shape fits
 * `BUDGETS.artifactJson`. Either way the view fits the host's JSON limits.
 */
export function artifactContent(runId: string, name: string, data: Buffer): RunArtifactContentViewType {
  const truncated = data.byteLength > MAX_ARTIFACT_BYTES;
  const shown = data.subarray(0, MAX_ARTIFACT_BYTES);
  const view: RunArtifactContentViewType = {
    runId,
    name,
    bytes: data.byteLength,
    sha256: createHash("sha256").update(data).digest("hex"),
    truncated,
    shownBytes: shown.byteLength,
  };
  const body = shown.toString("utf8");
  if (name.endsWith(".json") && !truncated) {
    try {
      const parsed = JSON.parse(body) as unknown;
      if (fitsJson(parsed, BUDGETS.artifactJson)) {
        view.json = parsed;
        return view;
      }
    } catch {
      // Not JSON after all: it is shown as the text it is.
    }
  }
  view.text = body;
  return view;
}

/** One `execution.artifact-chunk` slice of an artifact's bytes, with the whole file's hash. */
export function artifactSlice(runId: string, name: string, data: Buffer, offset: number): RunArtifactChunkViewType {
  const slice = data.subarray(offset, offset + ARTIFACT_CHUNK_BYTES);
  return {
    runId,
    name,
    bytes: data.byteLength,
    sha256: createHash("sha256").update(data).digest("hex"),
    offset,
    length: slice.byteLength,
    base64: slice.toString("base64"),
    eof: offset + slice.byteLength >= data.byteLength,
  };
}

/**
 * What a run record says it was asked. The input is echoed only when small in
 * shape as well as size (`BUDGETS.echoedInput`): the record carrying it must
 * still fit the host's JSON limits beside everything else it holds. Its size
 * and hash are always recorded; the input itself is in the run's own files.
 */
export function echoTask(input: unknown, inputBytes: number, attachments: RunTaskViewType["attachments"]): RunTaskViewType {
  return {
    inputBytes,
    ...(inputBytes <= MAX_ECHOED_INPUT_BYTES && fitsJson(input, BUDGETS.echoedInput) ? { input } : {}),
    attachments,
  };
}
