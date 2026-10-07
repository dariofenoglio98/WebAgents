/**
 * One run on the execution host (D-070, D-071): the portable half of the host, with no Worker,
 * Chrome or DOM dependency, so the same function runs inside the offscreen document's Worker and
 * inside the unit tests. It composes T4's `ExecutionSession` over the stores and transports the
 * host supplies, re-verifying the bytes against the plan (`begin`) before any instruction is
 * rendered, and writes a checkpoint after every wave (`state.committed`): the record, the
 * progress snapshot, the audit so far and the usage so far. At the end it writes the artifacts
 * and the settled record. Nothing here decides authority: the plan, the authorization and the
 * input were frozen by the service worker; the host refuses what does not re-verify.
 */
import { ExecutionError } from "../../core/execution/errors.js";
import type { ProgressSnapshot } from "../../core/execution/progress.js";
import { completeRunRecord, failRunRecord, initialRunRecord, type RunRecord } from "../../core/execution/record.js";
import { ExecutionSession, type BeginReport, type ExecutionOutcome, type SessionDeps } from "../../core/execution/runner.js";
import { sha256HexSync } from "../../core/hash.js";
import { buildHostToolRegistry } from "../../core/hosttools.js";
import type { JsonObject } from "../../core/json.js";
import type { BuiltinModelPort } from "../../core/models/adapters/chrome-builtin.js";
import { adapterFor } from "../../core/models/providers.js";
import { BoundModelRouter } from "../../core/models/router.js";
import type { HttpTransport, ModelRequestObserver } from "../../core/models/transport.js";
import { loadPackageBytes } from "../../core/package.js";
import { definitionsFromRegistry } from "../../core/tools/definitions.js";
import { Pacer } from "../../core/tools/pacer.js";
import type { AuditEvent } from "../../core/types.js";
import { Vault } from "../../core/vault.js";
import { AdapterError, CancelledError } from "../../core/workflow/errors.js";
import type { SnapshotStore } from "../storage/snapshots.js";
import { artifactKey, type RunStore, type StoredRun } from "../storage/runs.js";
import type { HostStartMessage } from "./protocol.js";

export const HOST_UNLOADED = "host_unloaded";
export const HOST_RUNTIME = "chrome-agent-browser";

export interface ExecuteDeps {
  runs: RunStore;
  snapshots: Pick<SnapshotStore, "getSnapshot">;
  message: HostStartMessage;
  transports: { model: HttpTransport; tool: HttpTransport };
  /** The Prompt API port of this context, when it has one. */
  builtin?: BuiltinModelPort | null;
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
  let stored: StoredRun | null = null;

  const notify = (status: RunRecord["status"]): void => {
    try {
      deps.onCheckpoint?.(runId, status);
    } catch {
      // A notification that fails never steers the run.
    }
  };

  /** Write the current record with the session's progress, audit and usage so far. */
  const checkpoint = (mutate?: (run: StoredRun) => void): Promise<void> =>
    queue.run(async () => {
      if (stored === null) return;
      const run = stored;
      mutate?.(run);
      const snapshot: ProgressSnapshot | null = session.snapshot;
      run.progress = snapshot;
      run.record = { ...run.record, progress: snapshot, cancelRequested: run.record.cancelRequested || cancelRequested };
      run.audit = session.auditSoFar();
      run.usage = session.usageSoFar();
      run.checkpoints += 1;
      run.updated_at = now().toISOString();
      await deps.runs.putRun(run);
      notify(run.record.status);
    });

  const settle = async (final: (run: StoredRun) => void, outcome: ExecutionOutcome | null): Promise<RunRecord["status"]> => {
    await queue.run(async () => {
      if (stored === null) return;
      const run = stored;
      final(run);
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
      await deps.runs.putRun(run);
      notify(run.record.status);
    });
    return stored?.record.status ?? "failed";
  };

  const work = async (): Promise<RunRecord["status"]> => {
    stored = await deps.runs.getRun(runId);
    if (stored === null) throw new ExecutionError("run_unknown", `No stored run ${JSON.stringify(runId)}`);
    const run = stored;
    const created = new Date(run.created_at);
    try {
      const snapshot = await deps.snapshots.getSnapshot(run.invocation.archive_sha256);
      if (snapshot === null) throw new ExecutionError("execution_artifact_mismatch", "The session snapshot this run was planned on is no longer stored");
      const archive = snapshot.bytes;
      // The package, for the host tool registry (the same derivation the plan was frozen from, D-054).
      const pkg = await loadPackageBytes(archive);
      const vault = await Vault.open(decodeBase64(message.vault.key), message.vault.document);
      const registry = await buildHostToolRegistry(pkg, {
        resourceTypes: vault.typeViews().map((type) => ({ id: type.id, display_name: type.display_name, permission_kind: type.permission_kind, schema_sha256: type.schema_sha256 })),
        runtimeVersion: message.settings.runtimeVersion,
        now: now(),
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
      const sessionDeps: SessionDeps = {
        archive,
        router,
        tools: { definitions, transport: deps.transports.tool, credentials: () => null, pacer: new Pacer(), observe: (request) => record("tool", request.tool_id, request.url, request.body) },
        resolver: vault,
        onProgress: () => void checkpoint(),
        // D-071: a checkpoint after every wave, the moment its patches are committed.
        onAudit: (event) => {
          if (event.action === "state.committed") void checkpoint();
        },
        now,
      };
      const begin: BeginReport = await session.begin(
        { run_id: runId, run_plan: plan, authorization: run.invocation.authorization, input: run.invocation.input, limits: run.invocation.limits, host: { runtime: HOST_RUNTIME, runtime_version: message.settings.runtimeVersion, verified_version: message.settings.verifiedVersion } },
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
    cancel: () => {
      cancelRequested = true;
      session.cancel();
    },
  };
}
