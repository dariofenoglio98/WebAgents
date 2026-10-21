/**
 * The transcript (conversation.v0 §7, V-14…V-16): the input form a host replays, the output form a
 * conversation leaves behind, and the checks of an input transcript against the package and the
 * plan's grants before anything runs (`agentpkg/conversation/transcript.py`).
 */
import { ValidationError } from "../errors.js";
import type { JsonObject, JsonValue } from "../json.js";
import type { Package } from "../package.js";
import { pyRepr } from "../repr.js";
import { PackageSchemas } from "../schema.js";
import type { Grants } from "../workflow/runtime.js";
import { consentNodes, conversationOf, validateTranscriptDocument } from "./declarations.js";

export const MAX_TRANSCRIPT_BYTES = 8 * 1024 * 1024;

export interface TranscriptTurnInput {
  message: JsonValue;
  consents?: Record<string, boolean>;
}

export interface TranscriptInput {
  schema: "conversation.transcript.v0";
  turns: TranscriptTurnInput[];
  end?: boolean;
}

/** The decisions one input turn carries, by consent step id. */
export function turnDecisions(turn: TranscriptTurnInput | JsonObject): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  const consents = (turn as JsonObject).consents;
  if (typeof consents === "object" && consents !== null && !Array.isArray(consents)) {
    for (const [step, value] of Object.entries(consents)) out[step] = Boolean(value);
  }
  return out;
}

/** A document a host read, as the input form (`read_input_transcript`). */
export async function readInputTranscript(value: unknown, label: string): Promise<TranscriptInput> {
  return (await validateTranscriptDocument(value, "input", label)) as unknown as TranscriptInput;
}

/**
 * Refuse before the conversation starts what the transcript may not ask (V-15): a decision for a
 * step the graph does not declare (`consent_step_unknown`), an `accepted` for a step whose
 * permission the plan denies (`consent_not_authorized`: a transcript cannot widen the plan), and a
 * message the package's input schema refuses (`conversation_message_invalid`).
 */
export async function checkTranscript(transcript: TranscriptInput, pkg: Package, grants: Grants): Promise<void> {
  if (conversationOf(pkg.graph) === null) throw new ValidationError("conversation_profile_required: this package declares no conversation");
  const steps = new Map(consentNodes(pkg.graph).map((node) => [String(node.id), node]));
  const paths = (pkg.manifest.schemas as JsonObject[]).map((entry) => String(entry.path));
  const schemas = await PackageSchemas.open(pkg.files, paths);
  try {
    for (const [index, turn] of transcript.turns.entries()) {
      try {
        await schemas.validateInstance(String(pkg.graph.input_schema), turn.message, "message");
      } catch (error) {
        if (error instanceof ValidationError) throw new ValidationError(`conversation_message_invalid: turn ${index + 1}: ${error.message}`);
        throw error;
      }
      for (const [step, accepted] of Object.entries(turnDecisions(turn))) {
        const node = steps.get(step);
        if (node === undefined) throw new ValidationError(`consent_step_unknown: turn ${index + 1} decides ${pyRepr(step)}, which is not a consent step of this package`);
        const denied = (node.permissions as JsonValue[]).map(String).filter((permissionId) => (grants[permissionId] ?? "deny") === "deny");
        if (accepted && denied.length > 0) {
          throw new ValidationError(`consent_not_authorized: turn ${index + 1} accepts consent step ${pyRepr(step)}, whose permission(s) ${pyRepr(denied)} the plan denies; a transcript cannot widen a plan`);
        }
      }
    }
  } finally {
    schemas.close();
  }
}
