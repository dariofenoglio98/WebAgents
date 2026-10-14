/**
 * Runs, their checkpoints, their artifacts and the test-mode observations (D-071, D-073, D-028),
 * in the shared IndexedDB database. The service worker writes a run's invocation before the
 * execution host starts it; the host (an offscreen document's Worker) writes every checkpoint,
 * the artifacts and the final record; views read through the worker's `run.*` messages. Nothing
 * here carries a prompt, a model output in a record, a host value or a credential: the record
 * is identifiers, hashes, counts and codes (`record.ts`); the artifacts are the run's own files.
 */
import type { ExecutionAuthorization, ExecutionPlan } from "../../core/execution/plan.js";
import type { ProgressSnapshot } from "../../core/execution/progress.js";
import type { RunRecord } from "../../core/execution/record.js";
import type { HostExecutionLimits } from "../../core/execution/limits.js";
import type { JsonObject, JsonValue } from "../../core/json.js";
import type { SelectedFileAttachment } from "../../core/tools/adapters/selected-file.js";
import type { AuditEvent, RunPlan } from "../../core/types.js";
import { completion, Database, request } from "./database.js";

/** What the host needs to run, written by the worker before `host.start` (bytes come from the snapshot store). */
export interface RunInvocation {
  plan: ExecutionPlan;
  authorization: ExecutionAuthorization;
  /** T3's full Run Plan, for the export and the Technical details ("Decided by"). */
  run_plan: RunPlan;
  input: JsonValue;
  /** The picked files this run was given (the ones its task names), path-free (T6, D-083); absent on runs recorded before T6. */
  attachments?: SelectedFileAttachment[];
  limits: HostExecutionLimits;
  archive_sha256: string;
  /** The receipt's model, tool and resource facts a view shows beside the run. */
  profile_id: string | null;
}

export interface StoredRun {
  run_id: string;
  session_id: string;
  created_at: string;
  updated_at: string;
  /** The Run Record as the views read it; `status` is the run's lifecycle state. */
  record: RunRecord;
  invocation: RunInvocation;
  /** The task as a person would quote it (the longest top-level string of the input, clipped), or null. */
  task_text: string | null;
  /** The last checkpoint (D-071): after every wave, and at the end. */
  checkpoints: number;
  progress: ProgressSnapshot | null;
  audit: AuditEvent[];
  usage: JsonObject | null;
  /** `result.json`, once the run settled; its files are in the artifact store. */
  result: JsonObject | null;
  /** memory.v0 (T19): the agent body a completed run staged, until the service worker commits it (M-50); null once committed or when none. */
  memory_commit?: { package_id: string; package_version: string; name: string; body: string; bytes: number; body_sha256: string; at: string } | null;
  /** The usage entries the run's audit yields (M-29), until the service worker applied them to the memory. */
  memory_usage?: Array<{ record_id: string; use: "read" | "agent_read" | "agent_write"; package_id: string; package_version: string; run_id: string; at: string }> | null;
  /** The instant of the run's `memory.proposed` event (M-29). */
  memory_proposed_at?: string | null;
  /** The review's outcome, once the person decided (M-42); the sheet does not reopen. */
  memory_review?: { at: string; accepted: number; rejected: number } | null;
}

export interface StoredArtifact {
  key: string;
  run_id: string;
  name: string;
  bytes: Uint8Array;
  sha256: string;
}

/** One outbound request body, recorded only in test mode (D-028). */
export interface StoredObservation {
  id?: number;
  run_id: string;
  at: string;
  kind: "model" | "tool";
  /** `provider_id` for a model request, `tool_id` for a tool request. */
  subject: string;
  url: string;
  body_sha256: string;
  body_bytes: number;
  body: string;
}

export function artifactKey(runId: string, name: string): string {
  return `${runId}/${name}`;
}

export interface RunStore {
  putRun(run: StoredRun): Promise<void>;
  getRun(runId: string): Promise<StoredRun | null>;
  /**
   * One atomic read-modify-write on a run: `mutate` sees the record as stored at that moment and
   * returns the record to write, or null to leave it as it is. The result is what is stored
   * afterwards (null when the run is unknown). The service worker uses it for every write to a
   * run the execution host owns, so a settled run is never written back as in flight by a
   * writer that read it a moment earlier (T5 review 1, finding 1).
   */
  updateRun(runId: string, mutate: (run: StoredRun) => StoredRun | null): Promise<StoredRun | null>;
  listRuns(): Promise<StoredRun[]>;
  /** Removes the run, its artifacts and its observations. */
  deleteRun(runId: string): Promise<void>;
  /** Removes the run's artifacts only (a host whose final record was refused takes its files back). */
  deleteArtifacts(runId: string): Promise<void>;
  putArtifact(artifact: StoredArtifact): Promise<void>;
  getArtifact(runId: string, name: string): Promise<StoredArtifact | null>;
  listArtifacts(runId: string): Promise<Array<{ name: string; bytes: number; sha256: string }>>;
  putObservation(observation: StoredObservation): Promise<void>;
  listObservations(runId: string): Promise<StoredObservation[]>;
}

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/** In-memory store for tests and for the Node side. */
export class MemoryRunStore implements RunStore {
  readonly runs = new Map<string, StoredRun>();
  readonly artifacts = new Map<string, StoredArtifact>();
  readonly observations: StoredObservation[] = [];

  async putRun(run: StoredRun): Promise<void> {
    this.runs.set(run.run_id, clone(run));
  }

  async getRun(runId: string): Promise<StoredRun | null> {
    const run = this.runs.get(runId);
    return run ? clone(run) : null;
  }

  async updateRun(runId: string, mutate: (run: StoredRun) => StoredRun | null): Promise<StoredRun | null> {
    // No await between the read and the write: the step is atomic in this process.
    const current = this.runs.get(runId);
    if (!current) return null;
    const next = mutate(clone(current));
    if (next !== null) this.runs.set(runId, clone(next));
    return clone(this.runs.get(runId)!);
  }

  async listRuns(): Promise<StoredRun[]> {
    return [...this.runs.values()].map((run) => clone(run));
  }

  async deleteRun(runId: string): Promise<void> {
    this.runs.delete(runId);
    for (const key of [...this.artifacts.keys()]) if (this.artifacts.get(key)!.run_id === runId) this.artifacts.delete(key);
    for (let index = this.observations.length - 1; index >= 0; index -= 1) if (this.observations[index]!.run_id === runId) this.observations.splice(index, 1);
  }

  async deleteArtifacts(runId: string): Promise<void> {
    for (const key of [...this.artifacts.keys()]) if (this.artifacts.get(key)!.run_id === runId) this.artifacts.delete(key);
  }

  async putArtifact(artifact: StoredArtifact): Promise<void> {
    this.artifacts.set(artifact.key, { ...artifact, bytes: artifact.bytes.slice() });
  }

  async getArtifact(runId: string, name: string): Promise<StoredArtifact | null> {
    const artifact = this.artifacts.get(artifactKey(runId, name));
    return artifact ? { ...artifact, bytes: artifact.bytes.slice() } : null;
  }

  async listArtifacts(runId: string): Promise<Array<{ name: string; bytes: number; sha256: string }>> {
    return [...this.artifacts.values()].filter((artifact) => artifact.run_id === runId).map((artifact) => ({ name: artifact.name, bytes: artifact.bytes.length, sha256: artifact.sha256 }));
  }

  async putObservation(observation: StoredObservation): Promise<void> {
    this.observations.push({ ...observation, id: this.observations.length + 1 });
  }

  async listObservations(runId: string): Promise<StoredObservation[]> {
    return this.observations.filter((observation) => observation.run_id === runId).map((observation) => ({ ...observation }));
  }
}

function deleteByRunId(transaction: IDBTransaction, name: "artifacts" | "observations", runId: string): void {
  const index = transaction.objectStore(name).index("run_id");
  const cursor = index.openKeyCursor(IDBKeyRange.only(runId));
  cursor.onsuccess = () => {
    const current = cursor.result;
    if (!current) return;
    transaction.objectStore(name).delete(current.primaryKey);
    current.continue();
  };
}

/** The IndexedDB store, shared by the service worker and the execution host. */
export class IndexedDbRunStore implements RunStore {
  constructor(private readonly database: Database = new Database()) {}

  async close(): Promise<void> {
    await this.database.close();
  }

  async putRun(run: StoredRun): Promise<void> {
    await request((await this.database.store("runs", "readwrite")).put(run));
  }

  async getRun(runId: string): Promise<StoredRun | null> {
    const run = (await request((await this.database.store("runs", "readonly")).get(runId))) as StoredRun | undefined;
    return run ?? null;
  }

  async updateRun(runId: string, mutate: (run: StoredRun) => StoredRun | null): Promise<StoredRun | null> {
    // The read and the write share one readwrite transaction: IndexedDB serializes it against
    // the host's writes on the same store, so what `mutate` sees is what the write replaces.
    const transaction = await this.database.transaction(["runs"], "readwrite");
    const store = transaction.objectStore("runs");
    const current = (await request(store.get(runId))) as StoredRun | undefined;
    if (current === undefined) return null;
    const next = mutate(current);
    if (next !== null) store.put(next);
    await completion(transaction);
    return next ?? current;
  }

  async listRuns(): Promise<StoredRun[]> {
    return (await request((await this.database.store("runs", "readonly")).getAll())) as StoredRun[];
  }

  async deleteRun(runId: string): Promise<void> {
    const transaction = await this.database.transaction(["runs", "artifacts", "observations"], "readwrite");
    transaction.objectStore("runs").delete(runId);
    for (const name of ["artifacts", "observations"] as const) deleteByRunId(transaction, name, runId);
    await completion(transaction);
  }

  async deleteArtifacts(runId: string): Promise<void> {
    const transaction = await this.database.transaction(["artifacts"], "readwrite");
    deleteByRunId(transaction, "artifacts", runId);
    await completion(transaction);
  }

  async putArtifact(artifact: StoredArtifact): Promise<void> {
    await request((await this.database.store("artifacts", "readwrite")).put(artifact));
  }

  async getArtifact(runId: string, name: string): Promise<StoredArtifact | null> {
    const artifact = (await request((await this.database.store("artifacts", "readonly")).get(artifactKey(runId, name)))) as StoredArtifact | undefined;
    return artifact ?? null;
  }

  async listArtifacts(runId: string): Promise<Array<{ name: string; bytes: number; sha256: string }>> {
    const store = await this.database.store("artifacts", "readonly");
    const artifacts = (await request(store.index("run_id").getAll(IDBKeyRange.only(runId)))) as StoredArtifact[];
    return artifacts.map((artifact) => ({ name: artifact.name, bytes: artifact.bytes.byteLength, sha256: artifact.sha256 }));
  }

  async putObservation(observation: StoredObservation): Promise<void> {
    const { id: _id, ...record } = observation;
    await request((await this.database.store("observations", "readwrite")).add(record));
  }

  async listObservations(runId: string): Promise<StoredObservation[]> {
    const store = await this.database.store("observations", "readonly");
    return (await request(store.index("run_id").getAll(IDBKeyRange.only(runId)))) as StoredObservation[];
  }
}
