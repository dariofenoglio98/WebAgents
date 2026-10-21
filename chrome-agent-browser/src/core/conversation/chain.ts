/**
 * One audit chain across the turns of a conversation (conversation.v0 §6, V-17):
 * `agentpkg/conversation/chain.py`.
 *
 * Each turn's `Runtime` continues the chain it is given: its first event's `previous_hash` is the
 * last hash before it and `sequence` keeps counting, so `verifyAuditChain` reads the whole
 * conversation's `audit.json` as one record. The conversation-level events between turns are
 * written here with the same event shape and the same digest. A host that runs each turn in
 * another process (the extension's Worker per turn) hands the chain's tail across and advances
 * it with the events the turn recorded.
 */
import type { JsonValue } from "../json.js";
import { pyIsoTimestamp } from "../pyjson.js";
import { deepCopy } from "../references.js";
import type { AuditEvent } from "../types.js";
import { digest, type Observer } from "../workflow/runtime.js";

/** Where a chain stands: what the next event links to. */
export interface ChainTail {
  previous_hash: string | null;
  sequence: number;
}

export class AuditChain {
  readonly conversationId: string;
  turn = 0;
  previousHash: string | null;
  sequence: number;
  readonly events: AuditEvent[] = [];
  private readonly observer: Observer | null;

  constructor(conversationId: string, options: { observer?: Observer | null; tail?: ChainTail | null; now?: () => Date } = {}) {
    this.conversationId = conversationId;
    this.observer = options.observer ?? null;
    this.previousHash = options.tail?.previous_hash ?? null;
    this.sequence = options.tail?.sequence ?? 0;
    this.now = options.now ?? (() => new Date());
  }

  private readonly now: () => Date;

  /** What every event of the conversation carries beside the audit.v0 fields. */
  fields(): { conversation_id: string; turn: number } {
    return { conversation_id: this.conversationId, turn: this.turn };
  }

  tail(): ChainTail {
    return { previous_hash: this.previousHash, sequence: this.sequence };
  }

  /** A `Runtime` hands over each event it chained; the chain keeps the tail. */
  advance(event: AuditEvent): void {
    this.previousHash = event.event_hash;
    this.sequence = event.sequence;
    this.events.push(event);
  }

  /** A conversation-level event (`conversation.started`, `turn.*`, `conversation.ended`): the conversation's id as `run_id`, no worker, depth 0. */
  record(action: string, metadata: Record<string, JsonValue | undefined> = {}): AuditEvent {
    const event: Record<string, JsonValue> = {
      schema_version: "audit.v0",
      run_id: this.conversationId,
      sequence: this.sequence + 1,
      timestamp: pyIsoTimestamp(this.now()),
      action,
      worker: null,
      role: null,
      parent: null,
      depth: 0,
      node_id: null,
      previous_hash: this.previousHash,
      ...this.fields(),
    };
    for (const [key, value] of Object.entries(metadata)) if (value !== undefined) event[key] = value;
    event.event_hash = digest(event);
    const finished = event as unknown as AuditEvent;
    this.advance(finished);
    if (this.observer !== null) {
      try {
        this.observer(deepCopy(finished as unknown as JsonValue) as unknown as AuditEvent);
      } catch {
        // Observation must never affect a conversation.
      }
    }
    return finished;
  }
}
