/**
 * The consent host of a conversation (conversation.v0 §3, §4): what a turn asks when it reaches a
 * consent step, the decision contract a host's answer must meet, and the one host the core ships,
 * which answers from a transcript (`agentpkg/conversation/host.py`).
 *
 * A host answers `accepted` or `denied` with its provenance. A host that cannot ask a person
 * answers `denied` with the reason `no_decision_available`, never `accepted` (V-12): the absence
 * of a yes is a no. A host never answers as the `plan`: that provenance is the runtime's own,
 * for a step it did not put to the host (T23 review 2, nit 4).
 */
import type { JsonObject, JsonValue } from "../json.js";
import { ConsentError } from "./errors.js";

export const DECIDED_BY = ["person", "transcript", "plan", "host", "preset", "policy"] as const;
export type DecidedBy = (typeof DECIDED_BY)[number];
/** What a host may say it was: never `plan`, which only the runtime records (V-12). */
export const HOST_DECIDED_BY: readonly DecidedBy[] = ["person", "transcript", "host", "preset", "policy"];
export const NO_DECISION = "no_decision_available";
/** The transcript schema's reason code: a lower-case identifier of at most 64 characters. */
const REASON = /^[a-z][a-z0-9_]{0,63}$/u;

/** What the person sees: the step, the permissions it decides, the sentence and the facts. */
export interface ConsentRequest {
  conversation_id: string;
  turn: number;
  step: string;
  permissions: readonly string[];
  text: string;
  facts: JsonValue;
  timeout_seconds: number;
}

export interface ConsentDecision {
  accepted: boolean;
  decided_by: DecidedBy;
  reason: string | null;
}

export interface ConsentHost {
  decide(request: ConsentRequest, signal: AbortSignal): Promise<unknown>;
  /** The steps the host decided from a record it was given (a transcript), for `unused_consents`. */
  readonly used?: Set<string>;
}

/**
 * A host's answer against the decision contract: `accepted` a boolean, `decided_by` one of the
 * provenance words a host may claim, an optional `reason` code. Anything else is the host's failure.
 */
export function checkDecision(value: unknown): ConsentDecision {
  const record = typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  if (
    record === null ||
    typeof record.accepted !== "boolean" ||
    !(HOST_DECIDED_BY as readonly string[]).includes(String(record.decided_by)) ||
    Object.keys(record).some((key) => !["accepted", "decided_by", "reason"].includes(key))
  ) {
    throw new ConsentError("consent_decision_invalid", "the consent host answered outside the decision contract ({accepted: bool, decided_by, reason?})");
  }
  const reason = record.reason ?? null;
  if (reason !== null && !(typeof reason === "string" && REASON.test(reason))) {
    throw new ConsentError("consent_decision_invalid", "the consent host's reason is not a code");
  }
  return { accepted: record.accepted, decided_by: record.decided_by as DecidedBy, reason: reason as string | null };
}

/** Decisions replayed from one turn of a transcript, by consent step id; a step the transcript does not decide is denied by the host (V-12). */
export class TranscriptConsent implements ConsentHost {
  readonly decisions: Record<string, boolean>;
  readonly used = new Set<string>();

  constructor(decisions: Readonly<Record<string, boolean>> | null | undefined) {
    this.decisions = {};
    for (const [step, value] of Object.entries(decisions ?? {})) this.decisions[step] = Boolean(value);
  }

  async decide(request: ConsentRequest): Promise<ConsentDecision> {
    if (Object.hasOwn(this.decisions, request.step)) {
      this.used.add(request.step);
      return { accepted: this.decisions[request.step]!, decided_by: "transcript", reason: null };
    }
    return { accepted: false, decided_by: "host", reason: NO_DECISION };
  }
}

/** What a run may ask the person outside a conversation's consent steps (link.v0 §6, §7): to join a package found during the run, and to raise their own run limit. */
export const RUN_REQUEST_KINDS = ["link.join", "budget.raise"] as const;
export type RunRequestKind = (typeof RUN_REQUEST_KINDS)[number];

/**
 * One card of a run: its kind, the run and the step that asks, and the facts the runtime computed
 * (`schemas/link-join-card.schema.json`, `schemas/budget-raise-card.schema.json`). Nothing on it is
 * a model's word except the member the facts mark as the agent's.
 */
export interface RunRequest {
  kind: RunRequestKind;
  run_id: string;
  node_id: string | null;
  facts: JsonObject;
  timeout_seconds: number;
}

/** The person's surface during a run (`RunConsentHost`): one `ask` per card; the signal ends the wait. */
export interface RunConsentHost {
  ask(request: RunRequest, signal: AbortSignal): Promise<unknown>;
  /**
   * The kinds of card this surface puts to the person; absent, both. A host whose signed policy
   * forbids the budget-raise request (D-682) leaves `budget.raise` out: the request is then never
   * made, as where nobody is there to ask (L-41), and nothing is recorded as asked.
   */
  readonly kinds?: readonly RunRequestKind[];
}

export interface RunDecision {
  accepted: boolean;
  provenance: string;
  grants?: Record<string, string>;
  approved_tools?: string[];
}

/**
 * A host's answer to a run's card against its contract (`check_run_decision`): `accepted` a boolean,
 * `provenance` a code naming where the answer came from (the host's surface, a fixture); for a join
 * that is accepted, the joined package's own `grants` and `approved_tools` (the card is that
 * package's authorization). Anything else is the host's failure, never a yes.
 */
export function checkRunDecision(kind: RunRequestKind, value: unknown): RunDecision {
  const record = typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  const allowed = new Set(["accepted", "provenance", ...(kind === "link.join" ? ["grants", "approved_tools"] : [])]);
  const provenance = record?.provenance;
  if (record === null || typeof record.accepted !== "boolean" || !(typeof provenance === "string" && REASON.test(provenance)) || Object.keys(record).some((key) => !allowed.has(key))) {
    throw new ConsentError("consent_decision_invalid", `the host answered a ${kind} card outside the decision contract ({accepted: bool, provenance: code, …})`);
  }
  const decision: RunDecision = { accepted: record.accepted, provenance: provenance as string };
  if (kind === "link.join") {
    const grants = record.grants ?? {};
    const approved = record.approved_tools ?? [];
    if (
      typeof grants !== "object" ||
      grants === null ||
      Array.isArray(grants) ||
      !Object.values(grants as Record<string, unknown>).every((scope) => typeof scope === "string") ||
      !Array.isArray(approved) ||
      !approved.every((tool) => typeof tool === "string")
    ) {
      throw new ConsentError("consent_decision_invalid", "a join decision's grants are a map of permission ids to scopes and its approved_tools a list of tool ids");
    }
    decision.grants = { ...(grants as Record<string, string>) };
    decision.approved_tools = [...new Set(approved as string[])].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  }
  return decision;
}
