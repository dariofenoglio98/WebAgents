/**
 * The Run Record (`run.json`): what a host keeps about one run, in the reference plugin's field
 * names (`RunRecordView`, camelCase), finalizing the draft T1 left in `types.ts`. Everything in it
 * is read from the begin report and the execution result; nothing is counted alongside them. A
 * record never carries a prompt, a model output, a tool payload, a value of a host resource or a
 * credential: identifiers, hashes, counts, codes and the bounded failure pointer only.
 */
import type { JsonObject, JsonValue } from "../json.js";
import type { ProgressSnapshot } from "./progress.js";
import type { BeginReport, ExecutionResult } from "./runner.js";

export const RUN_RECORD_SCHEMA = "chrome-agent-browser-run-record-v0";
export const HOST_RUNTIME = "chrome-agent-browser";

export type RunStatus = "preparing" | "running" | "completed" | "failed" | "cancelled" | "interrupted";

export interface RunRecord {
  schema: typeof RUN_RECORD_SCHEMA;
  runId: string;
  sessionId: string | null;
  runPlanId: string;
  runPlanSha256: string;
  runInvocationSha256: string | null;
  inputSha256: string | null;
  status: RunStatus;
  createdAt: string;
  startedAt: string | null;
  endedAt: string | null;
  durationMs: number | null;
  package: { packageId: string; name: string | null; version: string; digest: string; archiveSha256: string; executionProfile: string };
  selectedModel: { hostModelId: string; providerId: string; modelId: string; displayName: string | null; local: boolean | null } | null;
  model: { planned: string | null; invoked: string[]; calls: number; allCallsUsedPlannedModel: boolean; providers: string[]; responseModels: string[] } | null;
  grants: { decisions: Array<{ permissionId: string; decision: string }>; grantedPermissionIds: string[] };
  resources: Array<{ permissionId: string; resourceType: string; resourceId: string; resourceDigest: string }>;
  limits: { host: { totalTokens: number; maxRemoteCalls: number; maxParallelWorkers: number; maxOutputTokensPerCall: number; runTimeoutSeconds: number; modelCallTimeoutSeconds: number }; effectiveDeadlineSeconds: number | null };
  usage: { tokens: number; remoteCalls: number; peakParallelWorkers: number; toolCalls: number; limits: { hardTokens: number; maxRemoteCalls: number; maxParallelWorkers: number }; workers: Array<{ worker: string; tokens: number; remoteCalls: number }> } | null;
  cost: { status: string; totalUsd: number | null; calls: number; callsWithReportedCost: number } | null;
  audit: { events: number; chainValid: boolean; finalHash: string | null; actions: Array<{ action: string; count: number }>; workers: string[]; workersSpawned: number; nodesCompleted: number; modelCalls: number; toolCalls: number; tasksCalled: Array<{ task: string; count: number }> } | null;
  outputSha256: string | null;
  artifacts: Array<{ name: string; bytes: number; sha256: string }>;
  host: { runtime: string; runtimeVersion: string | null; verifiedVersion: string | null; versionVerified: boolean };
  deadlineExceeded: boolean;
  cancelRequested: boolean;
  errorCode: string | null;
  errorDetail: string | null;
  revalidated: string[];
  packageExecution: { workflowInstantiated: boolean; packageInstructionsLoaded: boolean; toolHandlersInstalled: number; toolCalls: number };
  task: { inputBytes: number; attachments: Array<{ fileId: string; sha256: string; bytes: number; mediaType: string }> };
  progress: ProgressSnapshot | null;
  tools: Array<{ toolId: string; bindingId: string; bindingSha256: string; remote: boolean; calls: number; displayName: string | null }>;
  failure: { nodeId: string | null; stepId: string | null; errorCode: string | null; failedCheck: JsonValue | null; call: { kind: string; action: string; tool: string | null; task: string | null; reason: string | null } | null } | null;
  origin: "live" | "fixture";
}

const rec = (value: unknown): JsonObject => (typeof value === "object" && value !== null && !Array.isArray(value) ? (value as JsonObject) : {});
const str = (value: unknown): string => (typeof value === "string" ? value : "");
const int = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : 0);
const clip = (value: string, max: number): string => (value.length > max ? value.slice(0, max) : value);
const strings = (value: unknown, max: number): string[] => (Array.isArray(value) ? value.filter((item): item is string => typeof item === "string").slice(0, max) : []);
const counts = <K extends string>(value: unknown, key: K, max: number): Array<Record<K, string> & { count: number }> =>
  Object.entries(rec(value))
    .slice(0, max)
    .map(([name, count]) => ({ [key]: clip(name, 128), count: int(count) }) as Record<K, string> & { count: number });

export interface RecordInputs {
  begin: BeginReport;
  /** The plan's own facts the begin report does not repeat. */
  plan: { session_id: string | null; package: { name: string | null }; model_binding: { host_model_id: string; provider_id: string; model_id: string; display_name: string | null; properties: { local: boolean | null } } | null; tool_bindings: ReadonlyArray<{ tool_id: string; binding_id: string; binding_sha256: string; remote: boolean; display_name: string | null }>; resource_grants: ReadonlyArray<{ permission_id: string; resource_type: string; resource_id: string; resource_digest: string }> };
  createdAt: Date;
  startedAt: Date | null;
  host: { runtimeVersion: string | null; verifiedVersion: string | null };
  revalidated?: readonly string[];
  origin: "live" | "fixture";
}

/** The record for a run that was bound and may have started: `preparing` until `complete` fills it. */
export function initialRunRecord(input: RecordInputs): RunRecord {
  const { begin, plan } = input;
  const host = rec(begin.limits.host);
  const decisions = rec(rec(begin.authorization).decisions);
  const budget = rec(begin.limits.budget);
  void budget;
  return {
    schema: RUN_RECORD_SCHEMA,
    runId: begin.run_id,
    sessionId: plan.session_id,
    runPlanId: begin.run_plan_id,
    runPlanSha256: begin.run_plan_sha256,
    runInvocationSha256: str(begin.invocation.run_invocation_sha256) || null,
    inputSha256: str(begin.invocation.input_sha256) || null,
    status: input.startedAt ? "running" : "preparing",
    createdAt: input.createdAt.toISOString(),
    startedAt: input.startedAt?.toISOString() ?? null,
    endedAt: null,
    durationMs: null,
    package: {
      packageId: begin.package.package_id,
      name: plan.package.name,
      version: begin.package.version,
      digest: begin.package.digest,
      archiveSha256: begin.package.archive_sha256,
      executionProfile: begin.package.execution_profile,
    },
    selectedModel: plan.model_binding
      ? { hostModelId: plan.model_binding.host_model_id, providerId: plan.model_binding.provider_id, modelId: plan.model_binding.model_id, displayName: plan.model_binding.display_name, local: plan.model_binding.properties.local }
      : null,
    model: null,
    grants: {
      decisions: Object.entries(decisions).map(([permissionId, decision]) => ({ permissionId, decision: str(decision) })),
      grantedPermissionIds: strings(rec(begin.authorization).granted_permission_ids, 64),
    },
    resources: plan.resource_grants.map((grant) => ({ permissionId: grant.permission_id, resourceType: grant.resource_type, resourceId: grant.resource_id, resourceDigest: grant.resource_digest })),
    limits: {
      host: {
        totalTokens: int(host.total_tokens),
        maxRemoteCalls: int(host.max_remote_calls),
        maxParallelWorkers: int(host.max_parallel_workers),
        maxOutputTokensPerCall: int(host.max_output_tokens_per_call),
        runTimeoutSeconds: int(host.run_timeout_seconds),
        modelCallTimeoutSeconds: int(host.model_call_timeout_seconds),
      },
      effectiveDeadlineSeconds: int(begin.limits.effective_deadline_seconds) || null,
    },
    usage: null,
    cost: null,
    audit: null,
    outputSha256: null,
    artifacts: [],
    host: { runtime: HOST_RUNTIME, runtimeVersion: input.host.runtimeVersion, verifiedVersion: input.host.verifiedVersion, versionVerified: input.host.runtimeVersion !== null && input.host.runtimeVersion === input.host.verifiedVersion },
    deadlineExceeded: false,
    cancelRequested: false,
    errorCode: null,
    errorDetail: null,
    revalidated: [...(input.revalidated ?? []), `input_bytes:${int(begin.invocation.input_bytes)}`, ...strings(begin.package.verified, 16).map((name) => `runner:${name}`), `runner:tool_handlers:${int(rec(begin.execution).tool_handlers)}`, ...strings(rec(begin.tools).bound, 64).map((name) => `runner:tool_bound:${name}`)],
    packageExecution: { workflowInstantiated: false, packageInstructionsLoaded: false, toolHandlersInstalled: int(rec(begin.execution).tool_handlers), toolCalls: 0 },
    task: {
      inputBytes: int(begin.invocation.input_bytes),
      attachments: (Array.isArray(begin.invocation.attachments) ? (begin.invocation.attachments as JsonObject[]) : []).map((file) => ({ fileId: str(file.file_id), sha256: str(file.sha256), bytes: int(file.bytes), mediaType: str(file.media_type) })),
    },
    progress: null,
    tools: plan.tool_bindings.map((binding) => ({ toolId: binding.tool_id, bindingId: binding.binding_id, bindingSha256: binding.binding_sha256, remote: binding.remote, calls: 0, displayName: binding.display_name ? clip(binding.display_name, 512) : null })),
    failure: null,
    origin: input.origin,
  };
}

/** Where a run that did not complete stopped, as the runner read it from its audit. */
export function projectFailure(value: unknown): RunRecord["failure"] {
  const record = rec(value);
  if (Object.keys(record).length === 0) return null;
  const call = typeof record.call === "object" && record.call !== null ? rec(record.call) : null;
  const text = (item: unknown, max: number): string | null => (str(item) ? clip(str(item), max) : null);
  let failedCheck: JsonValue | null = null;
  if (typeof record.failed_check === "object" && record.failed_check !== null) {
    const serialized = JSON.stringify(record.failed_check);
    failedCheck = serialized.length <= 2048 ? record.failed_check : null;
  }
  return {
    nodeId: text(record.node_id, 200),
    stepId: text(record.step_id, 200),
    errorCode: text(record.error_code, 64),
    failedCheck,
    call: call ? { kind: clip(str(call.kind), 32), action: clip(str(call.action), 64), tool: text(call.tool, 200), task: text(call.task, 128), reason: text(call.reason, 64) } : null,
  };
}

/** Fill a record from the settled result; the runner's own snapshot, so the record is exact. */
export function completeRunRecord(record: RunRecord, result: ExecutionResult, endedAt: Date): RunRecord {
  const usage = rec(result.usage);
  const audit = rec(result.audit);
  const chain = rec(audit.chain);
  const cost = rec(result.cost);
  const model = rec(result.model);
  const started = record.startedAt ? Date.parse(record.startedAt) : null;
  const status = result.status;
  const toolCalls = rec(usage.tool_calls);
  return {
    ...record,
    status: status === "completed" || status === "failed" || status === "cancelled" ? status : "failed",
    runInvocationSha256: str(result.run_invocation_sha256) || record.runInvocationSha256,
    inputSha256: str(result.input_sha256) || record.inputSha256,
    endedAt: endedAt.toISOString(),
    durationMs: started !== null ? Math.max(0, endedAt.getTime() - started) : null,
    limits: { ...record.limits, effectiveDeadlineSeconds: int(rec(result.limits).effective_deadline_seconds) || record.limits.effectiveDeadlineSeconds },
    model:
      Object.keys(model).length > 0
        ? { planned: str(model.planned) || null, invoked: strings(model.invoked, 16), calls: int(model.calls), allCallsUsedPlannedModel: model.all_calls_used_planned_model === true, providers: strings(model.providers, 16), responseModels: strings(model.response_models, 16) }
        : null,
    usage:
      Object.keys(usage).length > 0
        ? {
            tokens: int(usage.tokens),
            remoteCalls: int(usage.remote_calls),
            peakParallelWorkers: int(usage.peak_parallel_workers),
            toolCalls: Object.values(toolCalls).reduce<number>((total, count) => total + int(count), 0),
            limits: { hardTokens: int(rec(usage.limits).hard_tokens), maxRemoteCalls: int(rec(usage.limits).max_remote_calls), maxParallelWorkers: int(rec(usage.limits).max_parallel_workers) },
            workers: Object.entries(rec(usage.workers))
              .slice(0, 64)
              .map(([worker, value]) => ({ worker: clip(worker, 128), tokens: int(rec(value).tokens), remoteCalls: int(rec(value).remote_calls) })),
          }
        : null,
    cost: { status: str(cost.status) || "unknown", totalUsd: typeof cost.total_usd === "number" ? cost.total_usd : null, calls: int(cost.calls), callsWithReportedCost: int(cost.calls_with_reported_cost) },
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
    artifacts: (Array.isArray(result.artifacts) ? (result.artifacts as JsonObject[]) : []).slice(0, 64).map((item) => ({ name: clip(str(item.name), 128), bytes: int(item.bytes), sha256: str(item.sha256) })),
    deadlineExceeded: result.deadline_exceeded === true,
    cancelRequested: result.cancel_requested === true,
    errorCode: str(result.error_code) || null,
    packageExecution: {
      workflowInstantiated: rec(result.package_execution).workflow_instantiated === true,
      packageInstructionsLoaded: rec(result.package_execution).package_instructions_loaded === true,
      toolHandlersInstalled: int(rec(result.package_execution).tool_handlers_installed),
      toolCalls: int(rec(result.package_execution).tool_calls),
    },
    tools: record.tools.map((tool) => ({ ...tool, calls: int(toolCalls[tool.toolId]) })),
    progress: (result.progress as unknown as ProgressSnapshot | null) ?? null,
    failure: status === "completed" ? null : projectFailure(result.failure),
  };
}

/** The record for a run that failed before or outside the interpreter (a refusal, a host error). */
export function failRunRecord(record: RunRecord, error: { code?: string; message: string }, endedAt: Date, status: RunStatus = "failed"): RunRecord {
  const started = record.startedAt ? Date.parse(record.startedAt) : null;
  return { ...record, status, endedAt: endedAt.toISOString(), durationMs: started !== null ? Math.max(0, endedAt.getTime() - started) : null, errorCode: error.code ?? "execution_refused", errorDetail: clip(error.message, 4096) };
}
