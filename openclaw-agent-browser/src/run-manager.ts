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
 * Records live in this process's memory and die with it. A Gateway restart does
 * not resume a run; it ends one, because the child that was doing the work is
 * gone. Nothing here is persistent run history.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { RunRecordViewType } from "./contract.js";
import { AgentBrowserError } from "./errors.js";
import type { ExecutionBridge } from "./execution-bridge.js";

export const MAX_RECORDS = 32;
export const RUN_RECORD_FILE = "run.json";

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

  list(sessionId?: string): { runs: RunRecordViewType[]; active: RunRecordViewType | null } {
    const all = this.order
      .map((id) => this.runs.get(id))
      .filter((entry): entry is RunEntry => Boolean(entry))
      .filter((entry) => !sessionId || entry.view.sessionId === sessionId);
    const active = all.find((entry) => !isTerminal(entry.view.status)) ?? null;
    return { runs: all.map((entry) => entry.view), active: active ? active.view : null };
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
}
