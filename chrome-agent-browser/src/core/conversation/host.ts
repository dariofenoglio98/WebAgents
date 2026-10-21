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
import type { JsonValue } from "../json.js";
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
