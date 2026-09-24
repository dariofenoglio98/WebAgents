/**
 * The tool probe's own half: what it re-verifies is shared, what it reports is not.
 *
 * Preflight lives in `preflight.ts`, because a probe must not be able to end up
 * behind a weaker gate than a run — or a stronger one. What remains here is the
 * projection of one probe report into the bounded view the operator receives.
 *
 * Two fields are literals in the contract rather than numbers copied from the
 * report: `workflowInstantiated` and `modelCalls`. A build in which the probe
 * ever ran a graph or spent a token would not typecheck, which is a stronger
 * statement than a passing assertion about one run.
 */
import type { ToolProbeViewType } from "./contract.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function record(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function nullableStr(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function nullableInt(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : null;
}

function strings(value: unknown, max: number): string[] {
  return (Array.isArray(value) ? value : []).map(str).filter(Boolean).slice(0, max);
}

/** Project the child's probe report into the bounded view the caller receives. */
export function projectToolProbe(report: Record<string, unknown>): ToolProbeViewType {
  const pkg = record(report.package);
  const tool = record(report.tool);
  const binding = record(report.binding);
  const authority = record(report.authority);
  const request = record(report.request);
  const result = record(report.result);
  const transport = record(report.transport);
  const usage = record(report.usage);
  const audit = record(report.audit);
  const chain = record(audit.chain);
  const fixture = record(report.fixture);
  const summary = record(result.summary);
  return {
    status: str(report.status) === "ok" ? "ok" : "failed",
    runPlanId: str(report.run_plan_id),
    runPlanSha256: str(report.run_plan_sha256),
    sessionId: str(report.session_id),
    package: {
      packageId: str(pkg.package_id),
      name: str(pkg.name),
      version: str(pkg.version),
      digest: str(pkg.digest),
    },
    tool: {
      id: str(tool.id),
      version: str(tool.version),
      binding: str(tool.binding),
      execution: str(tool.execution),
      remote: tool.remote === true,
      sideEffects: str(tool.side_effects),
      permissions: strings(tool.permissions, 64),
      domains: strings(tool.domains, 32),
      timeoutSeconds: num(tool.timeout_seconds),
      declaredEndpoint: nullableStr(tool.declared_endpoint),
    },
    binding: {
      bindingId: str(binding.binding_id),
      bindingSha256: str(binding.binding_sha256),
      implementationKind: str(binding.implementation_kind),
      implementationVersion: nullableStr(binding.implementation_version),
      displayName: nullableStr(binding.display_name),
      remote: binding.remote === true,
      endpointOrigin: nullableStr(binding.endpoint_origin),
      endpointPath: nullableStr(binding.endpoint_path),
      method: nullableStr(binding.method),
      credentialsRequired: binding.credentials_required === true,
      credentialsConfigured: binding.credentials_configured === true,
    },
    authority: {
      role: str(authority.role),
      roleNamedByHost: authority.role_named_by_host === true,
      workerContext: authority.worker_context === true,
      approved: true as const,
      grants: Object.entries(record(authority.grants))
        .slice(0, 64)
        .map(([permissionId, decision]) => ({ permissionId, decision: str(decision) })),
      permissionChecks: num(authority.permission_checks),
    },
    fixture: {
      id: str(fixture.id),
      source: "host_owned" as const,
      fileId: nullableStr(fixture.file_id),
    },
    request: { argsSha256: str(request.args_sha256), argsBytes: num(request.args_bytes) },
    result: {
      validatedByRuntime: result.validated_by_runtime === true,
      validatedAgainst: str(result.validated_against),
      outputSha256: nullableStr(result.output_sha256),
      outputBytes: num(result.output_bytes),
      outputKeys: strings(summary.keys, 64),
      ...(result.output === undefined ? {} : { output: result.output }),
    },
    transport: {
      durationMs: num(transport.duration_ms),
      hostCalls: (Array.isArray(transport.host_calls) ? transport.host_calls : [])
        .slice(0, 16)
        .map((entry) => {
          const call = record(entry);
          return {
            toolId: str(call.toolId),
            bindingId: str(call.bindingId),
            remote: call.remote === true,
            status: nullableInt(call.status),
            durationMs: num(call.durationMs),
            outcome: str(call.outcome),
          };
        }),
    },
    usage: {
      toolCalls: num(usage.tool_calls),
      remoteCalls: num(usage.remote_calls),
      tokens: num(usage.tokens),
    },
    audit: {
      events: num(chain.events),
      chainValid: chain.valid === true,
      finalHash: nullableStr(chain.final_hash),
      actions: Object.entries(record(audit.actions))
        .slice(0, 64)
        .map(([action, count]) => ({ action, count: num(count) })),
    },
    workflowExecuted: false as const,
    packageExecution: {
      workflowInstantiated: false as const,
      workflowNodesExecuted: 0 as const,
      workflowWorkersStarted: 0 as const,
      modelCalls: 0 as const,
      modelRouterInstalled: false as const,
      packageInstructionsLoaded: false as const,
      runtimeWorkerContexts: Math.min(
        1,
        Math.max(0, num(record(report.package_execution).runtime_worker_contexts)),
      ),
    },
    revalidated: strings(report.revalidated, 40),
  };
}
