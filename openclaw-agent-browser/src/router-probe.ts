/**
 * The router probe's own half: what it re-verifies is shared, what it reports is not.
 *
 * Preflight moved to `preflight.ts` when execution needed the same checks. That
 * was the point of writing it as a preflight rather than as a probe-shaped
 * detour: a run must not be able to end up behind a weaker gate than a probe.
 * What remains here is the projection of one probe report into the bounded view
 * the operator receives.
 */
import { revalidate, type PreflightOutcome } from "./preflight.js";
import type { RouterProbeViewType } from "./contract.js";

export { revalidate };
export type { PreflightOutcome };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function record(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** Project the child's probe report into the bounded view the page receives. */
export function projectProbe(
  report: Record<string, unknown>,
  revalidated: string[],
): RouterProbeViewType {
  const router = record(report.router);
  const model = record(report.model);
  const probe = record(report.probe);
  const structured = record(report.structured_output);
  const tokens = record(report.tokens);
  const usage = record(report.usage);
  const accounting = record(report.accounting);
  const pkg = record(report.package);
  const timing = record(report.timing);
  const status = str(report.status) === "ok" ? "ok" : "contract_violation";
  return {
    status,
    runPlanId: str(report.run_plan_id),
    runPlanSha256: str(report.run_plan_sha256),
    sessionId: str(report.session_id),
    package: {
      packageId: str(pkg.package_id),
      name: str(pkg.name),
      version: str(pkg.version),
      digest: str(pkg.digest),
      executionProfile: str(pkg.execution_profile),
    },
    router: {
      routerId: str(router.router_id),
      modelId: str(router.model_id),
      remote: router.remote === true,
      contextWindow: num(router.context_window),
      capabilities: (Array.isArray(router.capabilities) ? router.capabilities : []).map(str),
      notDeclared: (Array.isArray(router.not_declared) ? router.not_declared : []).map(str),
    },
    model: {
      planned: str(model.planned),
      invoked: str(model.invoked),
      providerId: str(model.provider_id) || null,
      responseModel: str(model.response_model) || null,
      stopReason: str(model.stop_reason) || null,
      executionMode: str(record(model.execution).mode) || null,
    },
    probe: { status: str(probe.status), echo: str(probe.echo) },
    structuredOutput: {
      validated: structured.validated === true,
      constrainedByHost: structured.constrained_by_host === true,
      constraintDetail: str(structured.constraint_detail) || null,
      parse: str(structured.parse) || null,
    },
    tokens: {
      countTokensBound: num(tokens.count_tokens_bound),
      basis: str(tokens.basis),
      hostTokenizer: tokens.host_tokenizer === true,
      hostTokenizerDetail: str(tokens.host_tokenizer_detail) || null,
      framingAllowance:
        typeof tokens.framing_allowance === "number" ? tokens.framing_allowance : null,
    },
    usage: {
      inputTokens: num(usage.input_tokens),
      outputTokens: num(usage.output_tokens),
      costUsd: typeof usage.cost_usd === "number" ? usage.cost_usd : null,
    },
    accounting: {
      maxOutputTokens: num(accounting.max_output_tokens),
      inputWithinBound: accounting.input_within_bound === true,
      outputWithinCap: accounting.output_within_cap === true,
    },
    durationMs: num(timing.duration_ms),
    workflowExecuted: false,
    packageExecution: {
      workflowInstantiated: false,
      workersStarted: 0,
      toolsCalled: 0,
      packageInstructionsLoaded: false,
      exportsWritten: 0,
    },
    revalidated,
  };
}
