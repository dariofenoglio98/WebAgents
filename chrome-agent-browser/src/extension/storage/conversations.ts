/**
 * Conversations (conversation.v0, D-270): the record the service worker owns between turns, in the
 * shared IndexedDB database. A conversation is data between turns: the frozen plan it runs under,
 * the persisted state, where its audit chain stands, what it has spent, the transcript so far and
 * the turn in flight. Each turn is a run in the `runs` store, tagged with the conversation and
 * its turn number; the host (`execution/execute.ts`) writes the turn, the service worker charges
 * it here. Nothing here carries a credential or a host value; the consent cards' text and facts
 * are the person's own record (V-16), kept in the transcript as the reference keeps them.
 */
import type { ChainTail } from "../../core/conversation/chain.js";
import type { ConversationLimits, Ended, TranscriptTurn } from "../../core/conversation/runner.js";
import type { ExecutionAuthorization, ExecutionPlan } from "../../core/execution/plan.js";
import type { HostExecutionLimits } from "../../core/execution/limits.js";
import type { JsonObject } from "../../core/json.js";
import type { AuditEvent, RunPlan } from "../../core/types.js";
import { completion, Database, request } from "./database.js";

export type ConversationStatus = "open" | "ended";

export interface StoredConversation {
  conversation_id: string;
  session_id: string;
  created_at: string;
  updated_at: string;
  started_at: string;
  /** The plan the whole conversation runs under (one conversation per Run Plan, spec §12). */
  plan: ExecutionPlan;
  authorization: ExecutionAuthorization;
  run_plan: RunPlan;
  limits: ConversationLimits;
  /** The host's turn limits, the same for every turn. */
  turn_limits: HostExecutionLimits;
  archive_sha256: string;
  package: { package_id: string; name: string | null; version: string; digest: string };
  /** The persisted state after the last completed turn (V-5). */
  state: JsonObject;
  /** Where the chain stands: the hash and the sequence of the last event, whoever wrote it. */
  chain_tail: ChainTail;
  /** The conversation-level events (`conversation.started`, `turn.*`, `conversation.ended`); a turn's events are in its run. */
  events: AuditEvent[];
  spent: { tokens: number; remote_calls: number; tool_calls: Record<string, number>; permissions: string[] };
  /** Whether a turn of this conversation leased the receipt and spent its `once` grants (V-13). */
  spent_receipt: boolean;
  /** The transcript's turns so far, in the output form (V-16). */
  turns: TranscriptTurn[];
  /** The run of the turn in flight, or null between turns. */
  active_run_id: string | null;
  /** The turn number the active run is (or the last turn started). */
  turns_started: number;
  status: ConversationStatus;
  ended: Ended | null;
  /** The first message, clipped, for the Runs page. */
  title: string | null;
}

export interface ConversationStore {
  putConversation(conversation: StoredConversation): Promise<void>;
  getConversation(conversationId: string): Promise<StoredConversation | null>;
  /** One atomic read-modify-write, as `RunStore.updateRun`: `mutate` returns the record to write, or null to leave it. */
  updateConversation(conversationId: string, mutate: (conversation: StoredConversation) => StoredConversation | null): Promise<StoredConversation | null>;
  listConversations(): Promise<StoredConversation[]>;
  deleteConversation(conversationId: string): Promise<void>;
}

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/** In-memory store for tests and for the Node side. */
export class MemoryConversationStore implements ConversationStore {
  readonly conversations = new Map<string, StoredConversation>();

  async putConversation(conversation: StoredConversation): Promise<void> {
    this.conversations.set(conversation.conversation_id, clone(conversation));
  }

  async getConversation(conversationId: string): Promise<StoredConversation | null> {
    const found = this.conversations.get(conversationId);
    return found ? clone(found) : null;
  }

  async updateConversation(conversationId: string, mutate: (conversation: StoredConversation) => StoredConversation | null): Promise<StoredConversation | null> {
    const current = this.conversations.get(conversationId);
    if (!current) return null;
    const next = mutate(clone(current));
    if (next !== null) this.conversations.set(conversationId, clone(next));
    return clone(this.conversations.get(conversationId)!);
  }

  async listConversations(): Promise<StoredConversation[]> {
    return [...this.conversations.values()].map((item) => clone(item));
  }

  async deleteConversation(conversationId: string): Promise<void> {
    this.conversations.delete(conversationId);
  }
}

/** The IndexedDB store, shared by the service worker and the views' reads through it. */
export class IndexedDbConversationStore implements ConversationStore {
  constructor(private readonly database: Database = new Database()) {}

  async putConversation(conversation: StoredConversation): Promise<void> {
    await request((await this.database.store("conversations", "readwrite")).put(conversation));
  }

  async getConversation(conversationId: string): Promise<StoredConversation | null> {
    const found = (await request((await this.database.store("conversations", "readonly")).get(conversationId))) as StoredConversation | undefined;
    return found ?? null;
  }

  async updateConversation(conversationId: string, mutate: (conversation: StoredConversation) => StoredConversation | null): Promise<StoredConversation | null> {
    const transaction = await this.database.transaction(["conversations"], "readwrite");
    const store = transaction.objectStore("conversations");
    const current = (await request(store.get(conversationId))) as StoredConversation | undefined;
    if (current === undefined) return null;
    const next = mutate(current);
    if (next !== null) store.put(next);
    await completion(transaction);
    return next ?? current;
  }

  async listConversations(): Promise<StoredConversation[]> {
    return (await request((await this.database.store("conversations", "readonly")).getAll())) as StoredConversation[];
  }

  async deleteConversation(conversationId: string): Promise<void> {
    await request((await this.database.store("conversations", "readwrite")).delete(conversationId));
  }
}
