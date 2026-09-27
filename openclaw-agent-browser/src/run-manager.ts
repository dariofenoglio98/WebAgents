/**
 * Ephemeral run records, and the lifecycle rules that keep them honest.
 *
 * A **run plan** is a frozen preparation artifact and is never edited — not
 * even to say it was used. A **run invocation** freezes one plan plus one task
 * input. A **run record** is the third thing, and the only mutable one: what
 * actually happened.
 *
 * ```text
 *   preparing ──▶ running ──┬──▶ completed
 *                           ├──▶ failed
 *                           └──▶ cancelled
 * ```
 *
 * There is no transition out of a terminal state and at most one active run per
 * run plan, so a double-click — or a script that fires twice — gets a refusal
 * rather than two runs spending tokens against one authorization.
 *
 * Records live in this process's memory. A Gateway restart does not resume a
 * run; it ends one, because the child that was doing the work is gone.
 *
 * What a restart does not erase is what finished runs already wrote: each run
 * directory keeps its artifacts and the `run.json` this manager persisted when
 * the run settled. `recover()` reads the most recent of those back, validated
 * against the same contract a live record satisfies, so a completed run can
 * still be opened and inspected after a restart. A recovered record is read
 * only — it is evidence, never authority — and this is not a history database:
 * it is bounded, it is this plugin's own private directory, and nothing is
 * rewritten.
 */
import { lstat, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Value } from "typebox/value";
import { RunRecordView, runSummary, type RunRecordViewType, type RunSummaryViewType } from "./contract.js";
import { AgentBrowserError } from "./errors.js";
import type { ExecutionBridge } from "./execution-bridge.js";

export const MAX_RECORDS = 32;
export const RUN_RECORD_FILE = "run.json";
/** How many finished runs a restarted backend reads back from disk. */
export const MAX_RECOVERED = 16;
/** A run record is small; anything larger was not written by this manager. */
const MAX_RECORD_BYTES = 256 * 1024;
const RUN_ID = /^run_[0-9a-f]{32}$/u;

export type RunStatus = RunRecordViewType["status"];

/** Everything about a run, including the parts a caller never sees. */
export type RunEntry = {
  view: RunRecordViewType;
  /** Private: the run's artifact directory. Never projected. */
  directory: string;
  /** Private: the control-plane lease backing this run, released when it ends. */
  lease: { sessionId: string; leaseId: string } | null;
  bridge: ExecutionBridge | null;
  settled: boolean;
};

const TERMINAL: ReadonlySet<RunStatus> = new Set(["completed", "failed", "cancelled"]);

export function isTerminal(status: RunStatus): boolean {
  return TERMINAL.has(status);
}

export class RunManager {
  private readonly runs = new Map<string, RunEntry>();
  private readonly order: string[] = [];

  constructor(private readonly root: string) {}

  newRunId(): string {
    return `run_${randomUUID().replace(/-/gu, "")}`;
  }

  /** The private directory this run's artifacts are written into. */
  async prepareDirectory(runId: string): Promise<string> {
    const directory = join(this.root, "runs", runId);
    await mkdir(join(this.root, "runs"), { recursive: true, mode: 0o700 });
    // Exclusive: a run never writes into a directory that already exists.
    await mkdir(directory, { mode: 0o700 });
    return directory;
  }

  /**
   * Refuse a second run against a plan that already has one in flight.
   *
   * Checked before anything is prepared, so a double start costs nothing.
   */
  assertNoActiveRun(runPlanId: string, sessionId: string): void {
    for (const entry of this.runs.values()) {
      if (isTerminal(entry.view.status)) continue;
      if (entry.view.runPlanId === runPlanId || entry.view.sessionId === sessionId) {
        throw new AgentBrowserError(
          "execution_active",
          "A run is already in progress",
          `Run ${entry.view.runId} is ${entry.view.status} for this ` +
            `${entry.view.runPlanId === runPlanId ? "run plan" : "package session"}. ` +
            "Wait for it to finish, or cancel it.",
        );
      }
    }
  }

  register(entry: RunEntry): RunEntry {
    this.runs.set(entry.view.runId, entry);
    this.order.push(entry.view.runId);
    while (this.order.length > MAX_RECORDS) {
      const oldest = this.order.find((id) => isTerminal(this.runs.get(id)?.view.status ?? "failed"));
      if (!oldest) break;
      this.order.splice(this.order.indexOf(oldest), 1);
      this.runs.delete(oldest);
    }
    return entry;
  }

  get(runId: string): RunEntry | undefined {
    return this.runs.get(runId);
  }

  require(runId: string): RunEntry {
    const entry = this.runs.get(runId);
    if (!entry) {
      throw new AgentBrowserError(
        "execution_unknown",
        "No such run",
        "This run is not held by the Agent Browser backend. Run records are ephemeral and do " +
          "not survive a Gateway restart.",
      );
    }
    return entry;
  }

  /**
   * The runs this backend holds, as summaries, plus the one in flight in full.
   * A list of full records would outgrow the host's JSON limits within a
   * handful of runs; a summary is a few dozen nodes whatever the run did.
   */
  list(sessionId?: string): { runs: RunSummaryViewType[]; active: RunRecordViewType | null } {
    const all = this.order
      .map((id) => this.runs.get(id))
      .filter((entry): entry is RunEntry => Boolean(entry))
      .filter((entry) => !sessionId || entry.view.sessionId === sessionId);
    const active = all.find((entry) => !isTerminal(entry.view.status)) ?? null;
    return { runs: all.map((entry) => runSummary(entry.view)), active: active ? active.view : null };
  }

  /** Move one run forward. A terminal state never changes again. */
  update(runId: string, patch: Partial<RunRecordViewType>): RunRecordViewType {
    const entry = this.require(runId);
    if (patch.status && isTerminal(entry.view.status) && patch.status !== entry.view.status) {
      // Reporting a cancellation after a failure, or a completion after a
      // cancellation, would rewrite what happened.
      return entry.view;
    }
    entry.view = { ...entry.view, ...patch };
    return entry.view;
  }

  /** Write the run record beside the artifacts the runner produced. */
  async persist(runId: string): Promise<void> {
    const entry = this.require(runId);
    const body = `${JSON.stringify(entry.view, null, 2)}\n`;
    await writeFile(join(entry.directory, RUN_RECORD_FILE), body, {
      mode: 0o600,
      flag: "wx",
    }).catch(() => undefined);
  }

  /** Forget finished records. A running one is never cleared. */
  clear(options: { runId?: string; sessionId?: string } = {}): number {
    let cleared = 0;
    for (const [id, entry] of [...this.runs]) {
      if (options.runId && id !== options.runId) continue;
      if (options.sessionId && entry.view.sessionId !== options.sessionId) continue;
      if (!isTerminal(entry.view.status)) continue;
      this.runs.delete(id);
      const index = this.order.indexOf(id);
      if (index >= 0) this.order.splice(index, 1);
      cleared += 1;
    }
    return cleared;
  }

  /** Every run still in flight, for Gateway shutdown. */
  active(): RunEntry[] {
    return [...this.runs.values()].filter((entry) => !isTerminal(entry.view.status));
  }

  /**
   * Read back the most recent finished runs this plugin persisted.
   *
   * Only a directory named like a run id, holding a regular `run.json` that
   * is a valid terminal record for that same id, is recovered. Anything else
   * — a probe's empty directory, a truncated file, a record that no longer
   * satisfies the contract — is skipped, never repaired.
   */
  async recover(): Promise<number> {
    const runs = join(this.root, "runs");
    const names = await readdir(runs).catch(() => [] as string[]);
    const found: Array<{ name: string; directory: string; mtimeMs: number }> = [];
    for (const name of names) {
      if (!RUN_ID.test(name) || this.runs.has(name)) continue;
      const directory = join(runs, name);
      const info = await lstat(join(directory, RUN_RECORD_FILE)).catch(() => null);
      if (!info || !info.isFile() || info.size > MAX_RECORD_BYTES) continue;
      found.push({ name, directory, mtimeMs: info.mtimeMs });
    }
    found.sort((a, b) => b.mtimeMs - a.mtimeMs);
    const recovered: RunEntry[] = [];
    for (const candidate of found.slice(0, MAX_RECOVERED)) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(await readFile(join(candidate.directory, RUN_RECORD_FILE), "utf8"));
      } catch {
        continue;
      }
      if (!Value.Check(RunRecordView, parsed)) continue;
      const view = parsed as RunRecordViewType;
      if (view.runId !== candidate.name || !isTerminal(view.status)) continue;
      recovered.push({
        view: { ...view, origin: "recovered" },
        directory: candidate.directory,
        lease: null,
        bridge: null,
        settled: true,
      });
    }
    // Oldest first, so the list keeps the order the runs happened in.
    for (const entry of recovered.reverse()) this.register(entry);
    return recovered.length;
  }
}
