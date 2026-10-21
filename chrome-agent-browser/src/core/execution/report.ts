/**
 * Reading a finished run's own audit rather than narrating it separately (`execution/report.py`).
 * The runtime already emits a hash-chained audit and settled usage; this module verifies the chain
 * it was given and counts what is in it, so a report says "four model calls happened" because four
 * `model.completed` events exist. Pure functions of the report; no package word is special-cased
 * and raw model output never appears.
 */
import type { JsonObject, JsonValue } from "../json.js";
import { sameModel } from "../models/router.js";
import type { AuditEvent } from "../types.js";
import { digest } from "../workflow/runtime.js";

export const MAX_ACTION_KINDS = 64;
export const MAX_REPORT_WORKERS = 64;
export const MAX_MODELS = 16;

export interface ChainVerification {
  events: number;
  valid: boolean;
  broken: Array<{ sequence: JsonValue; reason: "event_hash" | "previous_hash" | "sequence" }>;
  final_hash: string | null;
  note: string;
}

/**
 * Recompute every event hash and every previous-hash link. An integrity check on a local record,
 * not an externally anchored log: it proves the report was not assembled from unrelated events.
 * A conversation turn's audit is a slice of one chain across the turns (conversation.v0 V-17):
 * with `continued`, its first event's link and sequence are the chain's (accepted as given; the
 * whole chain is verified by the conversation's record) and the rest must count on from it.
 */
export function verifyAuditChain(audit: readonly JsonObject[], options: { continued?: boolean } = {}): ChainVerification {
  const continued = options.continued === true && audit.length > 0;
  let previous: string | null = continued ? ((audit[0]!.previous_hash as string | null) ?? null) : null;
  const base = continued && typeof audit[0]!.sequence === "number" ? audit[0]!.sequence - 1 : 0;
  const broken: ChainVerification["broken"] = [];
  audit.forEach((event, index) => {
    const body: Record<string, JsonValue> = {};
    for (const [key, value] of Object.entries(event)) if (key !== "event_hash") body[key] = value;
    const expected = digest(body);
    const sequence = event.sequence ?? index;
    if (event.event_hash !== expected) broken.push({ sequence, reason: "event_hash" });
    else if ((event.previous_hash ?? null) !== previous) broken.push({ sequence, reason: "previous_hash" });
    else if (event.sequence !== base + index + 1) broken.push({ sequence, reason: "sequence" });
    previous = typeof event.event_hash === "string" ? event.event_hash : null;
  });
  return {
    events: audit.length,
    valid: broken.length === 0,
    broken: broken.slice(0, 8),
    final_hash: previous,
    note: "A local hash chain. It binds these events to each other; it is not an external tamper-proof audit service.",
  };
}

function counter(values: Iterable<string>): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const value of values) counts[value] = (counts[value] ?? 0) + 1;
  return counts;
}

function sortedSlice(counts: Record<string, number>, limit: number): Record<string, number> {
  const out: Record<string, number> = {};
  for (const key of Object.keys(counts).sort().slice(0, limit)) out[key] = counts[key]!;
  return out;
}

const text = (value: JsonValue | undefined): string | null => (typeof value === "string" && value.length > 0 ? value : null);

/** Counts, identities and model evidence, read out of the chain itself. */
export function auditSummary(audit: readonly JsonObject[], options: { continued?: boolean } = {}): JsonObject {
  const actions = counter(audit.map((event) => String(event.action)));
  const workers = [...new Set(audit.map((event) => text(event.worker)).filter((item): item is string => item !== null))].sort();
  const completions = audit.filter((event) => event.action === "model.completed");
  return {
    chain: verifyAuditChain(audit, options) as unknown as JsonObject,
    actions: sortedSlice(actions, MAX_ACTION_KINDS),
    workers: workers.slice(0, MAX_REPORT_WORKERS),
    worker_count: workers.length,
    workers_spawned: actions["worker.spawned"] ?? 0,
    nodes_completed: audit.filter((event) => event.action === "node.completed").length,
    model_calls: actions["model.completed"] ?? 0,
    model_count_calls: actions["model.count.called"] ?? 0,
    tool_calls: actions["tool.called"] ?? 0,
    models_used: sortedSlice(counter(completions.map((event) => String(event.model))), MAX_MODELS),
    tasks_called: sortedSlice(counter(completions.map((event) => String(event.task))), MAX_ACTION_KINDS),
    state_commits: actions["state.committed"] ?? 0,
    permission_checks: actions["permission.checked"] ?? 0,
  };
}

/** Total real cost, or an explicit statement that it is not complete. Missing values are never estimated. */
export function costSummary(audit: readonly JsonObject[]): JsonObject {
  const completions = audit.filter((event) => event.action === "model.completed");
  const reported = completions.filter((event) => typeof event.cost_usd === "number");
  const total = reported.reduce((sum, event) => sum + (event.cost_usd as number), 0);
  const complete = completions.length > 0 && reported.length === completions.length;
  return {
    calls: completions.length,
    calls_with_reported_cost: reported.length,
    complete,
    total_usd: reported.length > 0 ? Math.round(total * 1e8) / 1e8 : null,
    status: complete ? "complete" : reported.length > 0 ? "partial" : "unknown",
    note: "Derived only from costs the host reported for individual calls. Missing values are never estimated.",
  };
}

/**
 * The call failure that decided a run: the first failed model or tool call, or refused model call,
 * **that its own retry did not follow** (D-115). A `model.failed` followed by `model.called` with
 * `attempt: 2` for the same worker and node was recovered from or superseded by that attempt, so it
 * is skipped (T9 review 1, finding 1). Without a retry this is the first failed call, as the
 * reference's `failure_summary` reads it.
 */
export function decisiveCallFailure(audit: readonly JsonObject[]): JsonObject | null {
  for (let index = 0; index < audit.length; index += 1) {
    const event = audit[index]!;
    if (!["model.failed", "tool.failed", "model.refused"].includes(String(event.action))) continue;
    const retried = event.action === "model.failed" && audit.slice(index + 1).some((later) => later.action === "model.called" && later.attempt === 2 && later.worker === event.worker && later.node_id === event.node_id);
    if (!retried) return event;
  }
  return null;
}

/** Where a run stopped and which declared check or call refused it: pointers, identifiers and codes only. */
export function failureSummary(audit: readonly JsonObject[]): JsonObject | null {
  const failed = audit.filter((event) => event.action === "node.failed");
  if (failed.length === 0) return null;
  const attributed = failed.filter((event) => typeof event.failed_check === "object" && event.failed_check !== null && !Array.isArray(event.failed_check));
  const event = (attributed.length > 0 ? attributed : failed)[0]!;
  const node = typeof event.node_id === "string" ? event.node_id : "";
  const slash = node.indexOf("/");
  const top = slash >= 0 ? node.slice(0, slash) : node;
  const step = slash >= 0 ? node.slice(slash + 1) : "";
  const call = decisiveCallFailure(audit);
  return {
    node_id: top || null,
    step_id: step || null,
    error_code: event.error_code ?? null,
    failed_check: attributed.length > 0 ? event.failed_check! : null,
    call: call
      ? {
          kind: String(call.action).split(".")[0]!,
          action: call.action!,
          tool: call.tool ?? null,
          task: call.task ?? null,
          reason: call.reason ?? null,
          ...(call.failure_facts ? { failure_facts: call.failure_facts } : {}),
        }
      : null,
  };
}

/** The per-call evidence a router keeps (`BoundModelRouter.invocations`); a router without it has no calls to show. */
export interface InvocationEvidence {
  model_id?: string | null;
  provider_id?: string | null;
  response_model?: string | null;
  constrained_by_host?: boolean | null;
  count_basis?: string | null;
}

const unique = (values: Array<string | null | undefined>): string[] => [...new Set(values.filter((value): value is string => typeof value === "string" && value.length > 0))].sort();

/**
 * Which model actually answered each call, straight from the adapter. `invoked` lists the ids
 * the provider reported; `all_calls_used_planned_model` judges them the way the router did
 * (`sameModel`: the bound id or a dated snapshot of it), so a hosted run answered by
 * `gpt-4o-2024-08-06` for a plan bound to `gpt-4o` is reported as the planned model it is
 * (review 1, finding 6).
 */
export function modelEvidence(router: { invocations?: readonly InvocationEvidence[] } | null, plannedModel: string): JsonObject {
  const invocations = [...(router?.invocations ?? [])];
  const invoked = unique(invocations.map((item) => item.model_id));
  return {
    planned: plannedModel,
    invoked: invoked.slice(0, MAX_MODELS),
    calls: invocations.length,
    all_calls_used_planned_model: invocations.length > 0 && invocations.every((item) => sameModel(plannedModel, item.model_id ?? null)),
    providers: unique(invocations.map((item) => item.provider_id)).slice(0, MAX_MODELS),
    response_models: unique(invocations.map((item) => item.response_model)).slice(0, MAX_MODELS),
    constrained_by_host: invocations.length > 0 ? invocations.every((item) => item.constrained_by_host === true) : null,
    token_bound_basis: unique(invocations.map((item) => item.count_basis)).slice(0, MAX_MODELS),
  };
}

export type { AuditEvent };
