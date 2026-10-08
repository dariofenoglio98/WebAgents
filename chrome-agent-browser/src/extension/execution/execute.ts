/**
 * One run on the execution host (D-070, D-071): the portable half of the host, with no Worker,
 * Chrome or DOM dependency, so the same function runs inside the offscreen document's Worker and
 * inside the unit tests. It composes T4's `ExecutionSession` over the stores and transports the
 * host supplies, re-verifying the bytes against the plan (`begin`) before any instruction is
 * rendered, and writes a checkpoint after every wave (`state.committed`): the record, the
 * progress snapshot, the audit so far and the usage so far. At the end it writes the artifacts
 * and the settled record. Nothing here decides authority: the plan, the authorization and the
 * input were frozen by the service worker; the host refuses what does not re-verify.
 *
 * Every write is one atomic step that leaves a settled record alone (T5 review 1, finding 1):
 * when the service worker has already ended this run (it declared the host gone, D-071, or
 * cleared the run), the host's execution stops at its next checkpoint and writes nothing more,
 * so a record the worker settled is never overwritten by a host that was still alive. A cancel
 * the service worker stored is never lost either (T5 review 2, finding 1): the host reads the
 * flag when it starts and merges it on every write, so a Cancel accepted while the run was
 * still preparing, when no Worker existed to receive `host.cancel`, still ends the run.
 */
import { ExecutionError } from "../../core/execution/errors.js";
import type { ProgressSnapshot } from "../../core/execution/progress.js";
import { completeRunRecord, failRunRecord, HOST_RUNTIME, initialRunRecord, isTerminalStatus, type RunRecord } from "../../core/execution/record.js";
import { ExecutionSession, type BeginReport, type ExecutionOutcome, type SessionDeps } from "../../core/execution/runner.js";
import { sha256HexSync } from "../../core/hash.js";
import { buildHostToolRegistry } from "../../core/hosttools.js";
import type { JsonObject } from "../../core/json.js";
import type { BuiltinModelPort } from "../../core/models/adapters/chrome-builtin.js";
import { adapterFor } from "../../core/models/providers.js";
import { BoundModelRouter } from "../../core/models/router.js";
import type { HttpTransport, ModelRequestObserver } from "../../core/models/transport.js";
import { loadPackageBytes } from "../../core/package.js";
import type { PdfTextReader, SelectedFileAttachment, SelectedFiles } from "../../core/tools/adapters/selected-file.js";
import { CROSSREF_CONTACT_SOURCE } from "../../core/hosttools.js";
import { definitionsFromRegistry, type CredentialSource } from "../../core/tools/definitions.js";
import { Pacer } from "../../core/tools/pacer.js";
import type { AuditEvent } from "../../core/types.js";
import { Vault } from "../../core/vault.js";
import { AdapterError, CancelledError } from "../../core/workflow/errors.js";
import type { FileStore } from "../storage/files.js";
import type { SnapshotStore } from "../storage/snapshots.js";
import { artifactKey, type RunStore, type StoredRun } from "../storage/runs.js";
import type { HostStartMessage } from "./protocol.js";

export const HOST_UNLOADED = "host_unloaded";
/** The host was asked to run a record that is not a freshly leased one (T5 review 1, finding 3). */
export const RUN_NOT_PREPARING = "execution_refused";

export interface ExecuteDeps {
  runs: RunStore;
  snapshots: Pick<SnapshotStore, "getSnapshot">;
  message: HostStartMessage;
  transports: { model: HttpTransport; tool: HttpTransport };
  /** The Prompt API port of this context, when it has one. */
  builtin?: BuiltinModelPort | null;
  /** The picked files' stored copies (T6, D-083); a run reads only its attachments from it. */
  files?: Pick<FileStore, "get"> | null;
  /** The PDF parser: a killable Worker per read in the extension, in-process in tests (D-082). */
  pdfReader?: PdfTextReader | null;
  now?: () => Date;
  /** Called after every checkpoint or record change was written, so the host can notify the worker. */
  onCheckpoint?: ((runId: string, status: RunRecord["status"]) => void) | null;
}

export interface ExecutionHandle {
  readonly runId: string;
  /** Settles with the final status once the record and the artifacts are written; never rejects. */
  readonly done: Promise<RunRecord["status"]>;
  cancel(): void;
}

function decodeBase64(text: string): Uint8Array {
  const binary = atob(text);
  const out = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) out[index] = binary.charCodeAt(index);
  return out;
}

/** One writer at a time per run: checkpoints and the final record never interleave on the store. */
class StoreQueue {
  private tail: Promise<unknown> = Promise.resolve();

  run<T>(work: () => Promise<T>): Promise<T> {
    const next = this.tail.then(work, work);
    this.tail = next.catch(() => undefined);
    return next;
  }
}

export function executeRun(deps: ExecuteDeps): ExecutionHandle {
  const { message } = deps;
  const runId = message.runId;
  const now = deps.now ?? (() => new Date());
  const session = new ExecutionSession();
  const queue = new StoreQueue();
  let cancelRequested = false;
  /** The service worker settled or cleared this run while it ran: the record is the worker's; nothing more is written. */
  let abandoned = false;
  let stored: StoredRun | null = null;

  const notify = (status: RunRecord["status"]): void => {
    try {
      deps.onCheckpoint?.(runId, status);
    } catch {
      // A notification that fails never steers the run.
    }
  };

  /** A cancel reached this execution: from the service worker's stored flag or from `host.cancel`. */
  const requestCancel = (): void => {
    cancelRequested = true;
    session.cancel();
  };

  /**
   * Write `run` unless the stored record is already settled. Returns true when written; false
   * when the worker owns the record now (settled or cleared), in which case this execution is
   * abandoned: cancelled, and silent from here on.
   *
   * The service worker's cancel flag is merged, never overwritten (T5 review 2, finding 1): a
   * flag the worker stored between this host's read and this write stays in the record, and it
   * is honoured here as if `host.cancel` had reached this Worker, which it may never do while
   * the run is still preparing.
   */
  const write = async (run: StoredRun): Promise<boolean> => {
    let applied = false;
    let flagged = false;
    const written = await deps.runs.updateRun(runId, (current) => {
      if (isTerminalStatus(current.record.status)) return null;
      applied = true;
      flagged = current.record.cancelRequested;
      if (flagged && !run.record.cancelRequested) run.record = { ...run.record, cancelRequested: true };
      return run;
    });
    if (flagged && !cancelRequested) requestCancel();
    if (applied && written !== null) return true;
    abandoned = true;
    session.cancel();
    return false;
  };

  /** Write the current record with the session's progress, audit and usage so far. */
  const checkpoint = (mutate?: (run: StoredRun) => void): Promise<void> =>
    queue.run(async () => {
      if (stored === null || abandoned) return;
      const run = stored;
      mutate?.(run);
      const snapshot: ProgressSnapshot | null = session.snapshot;
      run.progress = snapshot;
      run.record = { ...run.record, progress: snapshot, cancelRequested: run.record.cancelRequested || cancelRequested };
      run.audit = session.auditSoFar();
      run.usage = session.usageSoFar();
      run.checkpoints += 1;
      run.updated_at = now().toISOString();
      if (await write(run)) notify(run.record.status);
    });

  const settle = async (final: (run: StoredRun) => void, outcome: ExecutionOutcome | null): Promise<RunRecord["status"]> => {
    await queue.run(async () => {
      if (stored === null || abandoned) return;
      const run = stored;
      final(run);
      // A cancel that reached this host is part of the record even when the service worker's
      // own flag write lost the race with this final write (finding 1).
      run.record = { ...run.record, cancelRequested: run.record.cancelRequested || cancelRequested };
      if (outcome !== null) {
        for (const [name, data] of outcome.files) {
          await deps.runs.putArtifact({ key: artifactKey(runId, name), run_id: runId, name, bytes: data, sha256: sha256HexSync(data) });
        }
        run.result = outcome.result as unknown as JsonObject;
        run.audit = (outcome.report.audit ?? []) as unknown as AuditEvent[];
        run.usage = (outcome.report.usage as JsonObject | undefined) ?? null;
        run.progress = run.record.progress;
      }
      run.checkpoints += 1;
      run.updated_at = now().toISOString();
      if (await write(run)) {
        notify(run.record.status);
      } else if (outcome !== null) {
        // The worker settled this run first: its record stands, and the files of an outcome it never recorded go.
        await deps.runs.deleteArtifacts(runId).catch(() => undefined);
      }
    });
    if (abandoned) return "interrupted";
    return stored?.record.status ?? "failed";
  };

  const work = async (): Promise<RunRecord["status"]> => {
    const found = await deps.runs.getRun(runId);
    if (found === null) throw new ExecutionError("run_unknown", `No stored run ${JSON.stringify(runId)}`);
    if (found.record.status !== "preparing") {
      // The host executes a run exactly once, and only one the service worker has just leased
      // and written as `preparing`. A completed, cancelled, failed, interrupted or running record
      // is never executed again, whoever asks: the lease and the `once` accounting live in the
      // service worker, not here (finding 3). Nothing is written.
      throw new ExecutionError(RUN_NOT_PREPARING, `Run ${JSON.stringify(runId)} is ${found.record.status}, not preparing: a host executes a run exactly once`);
    }
    stored = found;
    // A Cancel the service worker accepted while this run was still preparing (the offscreen
    // document being created, this Worker loading) reached no Worker: the stored flag is the
    // cancel (T5 review 2, finding 1). The bytes are still re-verified and the record written
    // the usual way; the session cancels before its first wave, so nothing is dispatched.
    if (found.record.cancelRequested) requestCancel();
    const run = stored;
    const created = new Date(run.created_at);
    try {
      const snapshot = await deps.snapshots.getSnapshot(run.invocation.archive_sha256);
      if (snapshot === null) throw new ExecutionError("execution_artifact_mismatch", "The session snapshot this run was planned on is no longer stored");
      const archive = snapshot.bytes;
      // The package, for the host tool registry (the same derivation the plan was frozen from, D-054).
      const pkg = await loadPackageBytes(archive);
      const vault = await Vault.open(decodeBase64(message.vault.key), message.vault.document);
      const contact = message.settings.crossrefContact ?? null;
      const registry = await buildHostToolRegistry(pkg, {
        resourceTypes: vault.typeViews().map((type) => ({ id: type.id, display_name: type.display_name, permission_kind: type.permission_kind, schema_sha256: type.schema_sha256 })),
        runtimeVersion: message.settings.runtimeVersion,
        now: now(),
        contactConfigured: contact !== null,
      });
      const definitions = definitionsFromRegistry(registry);
      const plan = run.invocation.plan;
      if (plan.model_binding === null) throw new ExecutionError("execution_plan_invalid", "A browser run needs a model-bound plan");
      const recording = message.settings.recordRequests;
      const record = (kind: "model" | "tool", subject: string, url: string, body: string | null): void => {
        if (!recording) return;
        const text = body ?? "";
        const bytes = new TextEncoder().encode(text);
        void deps.runs.putObservation({ run_id: runId, at: now().toISOString(), kind, subject, url, body_sha256: sha256HexSync(bytes), body_bytes: bytes.length, body: text }).catch(() => undefined);
      };
      const observer: ModelRequestObserver = (request) => record("model", request.provider_id, request.url, request.body);
      const adapter = adapterFor(plan.model_binding, {
        transport: deps.transports.model,
        observer,
        ollama: { baseUrl: message.settings.ollamaBaseUrl ?? undefined, think: message.settings.think },
        openai: { apiKey: message.credentials.openai },
        anthropic: { apiKey: message.credentials.anthropic },
        ...(deps.builtin ? { builtin: deps.builtin } : {}),
      });
      const router = new BoundModelRouter(adapter, { requestTimeoutSeconds: run.invocation.limits.model_call_timeout_seconds });
      // The picked files this run was given (its invocation's attachments) and nothing else; their
      // stored copies are read and re-verified at call time (D-082, D-083).
      const attachments: SelectedFileAttachment[] = run.invocation.attachments ?? [];
      const store = deps.files ?? null;
      const files: SelectedFiles = {
        attached: new Map(attachments.map((file) => [file.file_id, file])),
        source: store === null ? null : { read: async (file) => {
          const held = await store.get(file.file_id);
          if (held === null) throw new Error("not held");
          return held.data;
        } },
        reader: deps.pdfReader ?? null,
      };
      // The one optional setting a binding may send: the person's Crossref contact (D-081).
      const optional = (credential: CredentialSource): string | null => (`${credential.kind}:${credential.name}` === CROSSREF_CONTACT_SOURCE ? contact : null);
      const sessionDeps: SessionDeps = {
        archive,
        router,
        tools: {
          definitions,
          transport: deps.transports.tool,
          credentials: optional,
          describe: { credentialConfigured: (credential) => optional(credential) !== null },
          files,
          pacer: new Pacer(),
          observe: (request) => record("tool", request.tool_id, request.url, request.body),
        },
        resolver: vault,
        onProgress: () => void checkpoint(),
        // D-071: a checkpoint after every wave, the moment its patches are committed.
        onAudit: (event) => {
          if (event.action === "state.committed") void checkpoint();
        },
        now,
      };
      const begin: BeginReport = await session.begin(
        { run_id: runId, run_plan: plan, authorization: run.invocation.authorization, input: run.invocation.input, attachments, limits: run.invocation.limits, host: { runtime: HOST_RUNTIME, runtime_version: message.settings.runtimeVersion, verified_version: message.settings.verifiedVersion } },
        sessionDeps,
      );
      const started = now();
      await checkpoint((current) => {
        current.record = initialRunRecord({
          begin,
          plan: { session_id: plan.session_id, package: { name: plan.package.name }, model_binding: plan.model_binding, tool_bindings: plan.tool_bindings, resource_grants: plan.resource_grants },
          createdAt: created,
          startedAt: started,
          host: { runtimeVersion: message.settings.runtimeVersion, verifiedVersion: message.settings.verifiedVersion },
          revalidated: current.record.revalidated,
          origin: "live",
        });
      });
      if (cancelRequested) session.cancel();
      const outcome = await session.run();
      const ended = now();
      return await settle((current) => {
        current.record = completeRunRecord(current.record, outcome.result, ended);
      }, outcome);
    } catch (error) {
      const ended = now();
      const code = error instanceof AdapterError ? error.code : error instanceof CancelledError ? "cancelled" : "execution_failed";
      const detail = error instanceof Error ? error.message : "The execution host failed";
      return await settle((current) => {
        current.record = failRunRecord(current.record, { code, message: detail }, ended, cancelRequested && code === "cancelled" ? "cancelled" : "failed");
      }, null);
    }
  };

  const done = work().catch(() => {
    // No stored run to write to: nothing more can be recorded here; the worker learns from `host.finished`.
    notify("failed");
    return "failed" as const;
  });
  return {
    runId,
    done,
    cancel: requestCancel,
  };
}
