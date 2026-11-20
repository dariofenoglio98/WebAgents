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
import type { ComputeEngine } from "../../core/compute/engine.js";
import { ExecutionError } from "../../core/execution/errors.js";
import type { ProgressSnapshot } from "../../core/execution/progress.js";
import { completeRunRecord, failRunRecord, HOST_RUNTIME, initialRunRecord, isTerminalStatus, type RunRecord } from "../../core/execution/record.js";
import { ExecutionSession, type BeginReport, type ExecutionOutcome, type SessionDeps } from "../../core/execution/runner.js";
import { sha256HexSync } from "../../core/hash.js";
import { buildHostToolRegistry } from "../../core/hosttools.js";
import type { JsonObject, JsonValue } from "../../core/json.js";
import type { BuiltinModelPort } from "../../core/models/adapters/chrome-builtin.js";
import type { InBrowserEnginePort } from "../../core/models/adapters/in-browser.js";
import { adapterFor } from "../../core/models/providers.js";
import { BoundModelRouter } from "../../core/models/router.js";
import type { ModelRequestObserver } from "../../core/models/transport.js";
import { loadPackageBytes } from "../../core/package.js";
import type { PdfTextReader, SelectedFileAttachment, SelectedFiles } from "../../core/tools/adapters/selected-file.js";
import { CROSSREF_CONTACT_SOURCE } from "../../core/hosttools.js";
import { definitionsFromRegistry, type CredentialSource } from "../../core/tools/definitions.js";
import { Pacer } from "../../core/tools/pacer.js";
import type { AuditEvent } from "../../core/types.js";
import { generateVaultKey } from "../../core/vault.js";
import { emptyMemorySnapshot, MemoryStore } from "../../core/memory/store.js";
import { MemoryRun } from "../../core/memory/run.js";
import { agentToolDigests, requestedResourceTypes } from "../../core/memory/declarations.js";
import type { MemoryRecord } from "../../core/memory/model.js";
import { AdapterError, CancelledError } from "../../core/workflow/errors.js";
import { isLoopbackBase } from "../../core/models/catalog.js";
import { CoreError } from "../../core/errors.js";
import { httpsOrigin } from "../../core/origins.js";
import { grantsCover } from "../storage/permissions.js";
import { TransportError, type HttpTransport } from "../../core/models/transport.js";
import type { FileStore } from "../storage/files.js";
import type { SnapshotStore } from "../storage/snapshots.js";
import { artifactKey, type ConsentAnswer, type RunCardAnswer, type RunCardPending, type RunStore, type StoredRun } from "../storage/runs.js";
import type { HostStartMessage } from "./protocol.js";
import { NO_DECISION, type ConsentHost, type ConsentRequest, type RunConsentHost, type RunRequest } from "../../core/conversation/host.js";
import type { JoinHost } from "../../core/links/join.js";
import { linkedDefinitions, linkedToolHandlers } from "../../core/links/tools.js";
import { downloadPackage, lookAtPage } from "../../core/links/web.js";
import { fingerprint, rawBase64 } from "../../core/keys.js";
import { embeddedPublicKey } from "../../core/signature.js";
import { evaluateTrust } from "../../core/trust.js";
import { pyIsoTimestamp } from "../../core/pyjson.js";

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
  /** The in-browser engine's port the page transferred for this run (T41, D-450); absent for every other route. */
  inBrowser?: InBrowserEnginePort | null;
  /** The picked files' stored copies (T6, D-083); a run reads only its attachments from it. */
  files?: Pick<FileStore, "get"> | null;
  /** The PDF parser: a killable Worker per read in the extension, in-process in tests (D-082). */
  pdfReader?: PdfTextReader | null;
  /** compute.v0: the engine over nested Workers (D-251); absent, a package with compute nodes is refused before it starts. */
  compute?: ComputeEngine | null;
  now?: () => Date;
  /** Called after every checkpoint or record change was written, so the host can notify the worker. */
  onCheckpoint?: ((runId: string, status: RunRecord["status"]) => void) | null;
}

export interface ExecutionHandle {
  readonly runId: string;
  /** Settles with the final status once the record and the artifacts are written; never rejects. */
  readonly done: Promise<RunRecord["status"]>;
  cancel(): void;
  /** conversation.v0 (D-270): the person's answer to the card the turn waits on (`host.decide`). */
  decide(step: string, accepted: boolean): void;
  /** link.v0 §6, §7 (T66): the person's answer to a run's card (`host.card`). */
  card(cardId: string, answer: RunCardAnswer): void;
}

/** The audit events the delegation view folds (`core/links/delegation.ts`): the host checkpoints at each, so the view follows the run. */
const DELEGATION_EVENTS = new Set(["network.activated", "route.decided", "link.requested", "link.decided", "link.started", "link.completed", "link.failed", "link.refused", "link.denied", "budget.requested", "budget.raised"]);

/** How often the consent host re-reads the stored run while it waits for an answer (D-270). */
export const CONSENT_POLL_MS = 1000;

function decodeBase64(text: string): Uint8Array {
  const binary = atob(text);
  const out = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) out[index] = binary.charCodeAt(index);
  return out;
}

/**
 * The plan's origin allowlist on a transport (T16, D-193): a destination outside the origins the
 * plan recorded is refused before any connection, whatever the package or a binding names. The
 * model transport may also reach Ollama on this machine, over plain HTTP or HTTPS on a loopback
 * name (D-055; `settings.ts::isLoopbackBase` admits both, review 1 finding 3): loopback is never
 * in a plan's origin set. The core URL gate still runs inside the adapters. Chrome's grant is not
 * an egress check for an origin that answers with permissive CORS headers (threat model § Chrome).
 */
export function originGuard(transport: HttpTransport, allowedOrigins: readonly string[], options: { allowLoopback: boolean }): HttpTransport {
  const allowed = new Set(allowedOrigins);
  return async (request) => {
    let url: URL;
    try {
      url = new URL(request.url);
    } catch {
      throw new TransportError("the destination is not a URL", { stage: "address_policy" });
    }
    // One test for "loopback" with Settings' validation (T16 review 2, nit 7).
    const loopback = options.allowLoopback && isLoopbackBase(url.href);
    const origin = httpsOrigin(request.url);
    if (!loopback && (origin === null || !allowed.has(origin))) {
      throw new TransportError(`the destination ${url.origin} is outside the origins this run's plan recorded`, { stage: "address_policy", reason: "origin_not_in_plan" });
    }
    return transport(request);
  };
}

/**
 * A slot's look and a candidate's download only at origins Chrome was granted (T66 review 1,
 * finding 1). An extension's request to an origin it holds no host permission for is an ordinary
 * CORS request: Chrome sends it and lets it be read when the server allows. So the run refuses it
 * here, before the transport: `origin_not_granted`, which the slot lists in its `fetches` (the URL
 * policy's own refusals come first, in `core/links/web.ts`).
 */
export function grantedOnly(transport: HttpTransport, granted: readonly string[]): HttpTransport {
  return async (request) => {
    const origin = httpsOrigin(request.url);
    if (!grantsCover(granted, origin)) throw new CoreError("origin_not_granted", `This browser is not allowed to read ${origin ?? "this address"}; a slot looks only at sites you allowed it to read`, { status: 403 });
    return transport(request);
  };
}

/**
 * A run's cards one at a time (T66 review 1, nit 6): each `ask` is presented after the previous one
 * ended, in the order asked. A card whose own wait ended while it was queued is never presented: it
 * rejects with its signal's reason, as an unanswered card does.
 */
export function oneCardAtATime(present: (request: RunRequest, signal: AbortSignal) => Promise<unknown>): (request: RunRequest, signal: AbortSignal) => Promise<unknown> {
  let tail: Promise<void> = Promise.resolve();
  return (request, signal) => {
    const shown = tail.then(() => (signal.aborted ? Promise.reject(signal.reason) : present(request, signal)));
    tail = shown.then(
      () => undefined,
      () => undefined,
    );
    return shown;
  };
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
  /** conversation.v0: the answers `host.decide` delivered, by step, for the card that waits on them. */
  const delivered = new Map<string, boolean>();
  const waiting = new Map<string, (accepted: boolean) => void>();
  const decide = (step: string, accepted: boolean): void => {
    delivered.set(step, accepted);
    waiting.get(step)?.(accepted);
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
      // conversation.v0 (D-270): the person's answers are the service worker's writes, merged the
      // same way, so a host checkpoint never drops an answer the record already carries.
      if (current.consent_decisions) run.consent_decisions = { ...(current.consent_decisions ?? {}), ...(run.consent_decisions ?? {}) };
      // link.v0 §6, §7 (T66): the answers to a run's cards, the service worker's writes too.
      if (current.run_card_answers) run.run_card_answers = { ...(current.run_card_answers ?? {}), ...(run.run_card_answers ?? {}) };
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

  /**
   * conversation.v0 (D-270): the consent host over the stored run. A card is written into the
   * record and the service worker told (the chat surface shows it, also after the panel was
   * closed); the answer arrives as `host.decide` or, should that message be lost, is read from
   * the record every second (the service worker writes it there first); the node's timeout ends
   * the wait through the signal (V-29). A pre-decided step never reaches this host: the session
   * answers it from the plan.
   */
  const consentHost: ConsentHost = {
    used: new Set<string>(),
    decide: (request: ConsentRequest, signal: AbortSignal): Promise<unknown> =>
      new Promise((resolve, reject) => {
        let timer: ReturnType<typeof setInterval> | null = null;
        const finish = (answer: { accepted: boolean; decided_by: "person" | "host"; reason: string | null }) => {
          if (timer !== null) clearInterval(timer);
          waiting.delete(request.step);
          signal.removeEventListener("abort", onAbort);
          void checkpoint((run) => {
            run.consent_pending = null;
          }).finally(() => resolve(answer));
        };
        const onAbort = () => {
          if (timer !== null) clearInterval(timer);
          waiting.delete(request.step);
          void checkpoint((run) => {
            run.consent_pending = null;
          }).finally(() => reject(signal.reason));
        };
        if (signal.aborted) {
          onAbort();
          return;
        }
        signal.addEventListener("abort", onAbort, { once: true });
        if (delivered.has(request.step)) {
          finish({ accepted: delivered.get(request.step)!, decided_by: "person", reason: null });
          return;
        }
        waiting.set(request.step, (accepted) => finish({ accepted, decided_by: "person", reason: null }));
        const pending = { step: request.step, permissions: [...request.permissions], text: request.text, facts: request.facts, timeout_seconds: request.timeout_seconds, requested_at: pyIsoTimestamp(now()) };
        void checkpoint((run) => {
          run.consent_pending = pending;
        });
        timer = setInterval(() => {
          void deps.runs.getRun(runId).then(
            (current) => {
              // The step was settled meanwhile (an answer by message, an abort): nothing to do.
              if (!waiting.has(request.step)) return;
              if (current === null) {
                // The record is gone: the service worker cleared the run; nobody can answer.
                finish({ accepted: false, decided_by: "host", reason: NO_DECISION });
                return;
              }
              const answer: ConsentAnswer | undefined = current.consent_decisions?.[request.step];
              if (answer !== undefined) finish({ accepted: answer.accepted, decided_by: "person", reason: null });
            },
            // A failed read is retried at the next tick; the node's timeout still bounds the wait (V-29).
            () => undefined,
          );
        }, CONSENT_POLL_MS);
      }),
  };

  /**
   * link.v0 §6, §7 (T66, D-703): the run's card surface over the stored run, the consent host's
   * pattern. A card is written into the record with the facts the core computed and validated, and
   * the service worker told (the run page shows it); the answer arrives as `host.card` or, should
   * that message be lost, is read from the record every second; the core's own wait ends through
   * the signal (an unanswered card is a no, L-35, L-43). `publishers` holds, by signer, what a pin
   * made from a join card would record: the candidate's own verified key.
   *
   * One card is shown at a time (T66 review 1, nit 6): a join card and a raise card can be asked
   * together when a top-level node runs beside a network; the second waits its turn instead of
   * replacing the first (which could then only time out, a no with the key denied). Its own wait runs
   * meanwhile, so a card that is never shown ends unanswered (`provenance: "timeout"`), never as a
   * person's no. A card whose answer the run took is listed in `run_card_taken` (nit 8).
   */
  let cardCount = 0;
  const cardDelivered = new Map<string, RunCardAnswer>();
  const cardWaiting = new Map<string, (answer: RunCardAnswer) => void>();
  const card = (cardId: string, answer: RunCardAnswer): void => {
    cardDelivered.set(cardId, answer);
    cardWaiting.get(cardId)?.(answer);
  };
  const publishers = new Map<string, NonNullable<RunCardPending["publisher"]>>();
  const present = (request: RunRequest, signal: AbortSignal): Promise<unknown> =>
      new Promise((resolve, reject) => {
        const cardId = `card_${(cardCount += 1)}`;
        let timer: ReturnType<typeof setInterval> | null = null;
        const clear = (taken: boolean): Promise<void> => {
          if (timer !== null) clearInterval(timer);
          cardWaiting.delete(cardId);
          signal.removeEventListener("abort", onAbort);
          return checkpoint((run) => {
            if (run.run_card_pending?.card_id === cardId) run.run_card_pending = null;
            if (taken) run.run_card_taken = [...(run.run_card_taken ?? []), cardId];
          });
        };
        const finish = (answer: RunCardAnswer | null) => {
          if (!cardWaiting.has(cardId)) return;
          // The decision contract of `checkRunDecision`: a join's grants and approved tools are the joined package's own.
          const decision = answer === null ? { accepted: false, provenance: NO_DECISION } : request.kind === "link.join" && answer.accepted ? { accepted: true, provenance: "person", grants: { ...(answer.grants ?? {}) }, approved_tools: [...(answer.approved_tools ?? [])] } : { accepted: answer.accepted, provenance: "person" };
          void clear(answer !== null).finally(() => resolve(decision));
        };
        const onAbort = () => void clear(false).finally(() => reject(signal.reason));
        if (signal.aborted) {
          onAbort();
          return;
        }
        signal.addEventListener("abort", onAbort, { once: true });
        cardWaiting.set(cardId, finish);
        const signer = request.kind === "link.join" ? String((request.facts.publisher as { signer?: unknown } | undefined)?.signer ?? "") : "";
        const pending: RunCardPending = { card_id: cardId, kind: request.kind, node_id: request.node_id, facts: request.facts, timeout_seconds: request.timeout_seconds, requested_at: pyIsoTimestamp(now()), ...(request.kind === "link.join" ? { publisher: publishers.get(signer) ?? null } : {}) };
        void checkpoint((run) => {
          run.run_card_pending = pending;
        });
        timer = setInterval(() => {
          void deps.runs.getRun(runId).then(
            (current) => {
              if (!cardWaiting.has(cardId)) return;
              if (current === null) {
                // The record is gone: the service worker cleared the run; nobody can answer.
                finish(null);
                return;
              }
              const answer = current.run_card_answers?.[cardId];
              if (answer !== undefined) finish(answer);
            },
            // A failed read is retried at the next tick; the core's wait still bounds it.
            () => undefined,
          );
        }, CONSENT_POLL_MS);
      });
  const shownOneAtATime = oneCardAtATime(present);
  const runConsent = (kinds: RunConsentHost["kinds"]): RunConsentHost => ({
    ...(kinds !== undefined ? { kinds } : {}),
    ask: shownOneAtATime,
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
      // The memory as the plan needs it (D-195, memory.v0 M-36): the whole store under its digest key
      // when the plan grants a record or binds a memory tool (the scan set is every sealed value; the
      // resolver answers only the plan's grants); an empty one under a throwaway key otherwise.
      const memoryMessage = message.memory ?? null;
      const withStore = memoryMessage !== null && memoryMessage.snapshot !== null && memoryMessage.key !== null;
      const memoryStore = withStore ? await MemoryStore.open({ key: decodeBase64(memoryMessage.key!), snapshot: memoryMessage.snapshot!, now }) : await MemoryStore.open({ key: generateVaultKey(), snapshot: emptyMemorySnapshot(), now });
      const grantedIds = new Set(run.invocation.plan.resource_grants.map((grant) => grant.resource_id));
      memoryStore.grantedIds = grantedIds;
      const transports = {
        model: originGuard(deps.transports.model, message.allowedOrigins ?? [], { allowLoopback: true }),
        tool: originGuard(deps.transports.tool, message.allowedOrigins ?? [], { allowLoopback: false }),
      };
      const contact = message.settings.crossrefContact ?? null;
      // The same derivations the plan was frozen from (review 1, nit 10): one helper for both registries.
      const requestedTypes = requestedResourceTypes(pkg.policy);
      const registry = await buildHostToolRegistry(pkg, {
        resourceTypes: withStore ? memoryStore.resourceTypeFacts(requestedTypes) : [],
        agentTools: withStore ? agentToolDigests() : null,
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
        transport: transports.model,
        observer,
        ollama: { baseUrl: message.settings.ollamaBaseUrl ?? undefined, think: message.settings.think },
        // The endpoint the plan's origin set was computed from (review 1, finding 3): the connection's base URL, when the person set one.
        openai: { apiKey: message.credentials.openai, ...(message.settings.openaiBaseUrl ? { baseUrl: message.settings.openaiBaseUrl } : {}), ...(message.settings.openaiReasoningEffort !== undefined ? { reasoningEffort: message.settings.openaiReasoningEffort } : {}) },
        anthropic: { apiKey: message.credentials.anthropic, ...(message.settings.anthropicBaseUrl ? { baseUrl: message.settings.anthropicBaseUrl } : {}) },
        ...(deps.builtin ? { builtin: deps.builtin } : {}),
        ...(deps.inBrowser ? { inBrowser: deps.inBrowser, inBrowserThink: message.inBrowser?.think === true } : {}),
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
      // The run's memory context (memory.v0 §7): the scan set, the granted targets, the agent document.
      const targets = new Map<string, Pick<MemoryRecord, "sealed" | "type">>();
      for (const id of grantedIds) {
        const record = memoryStore.get(id);
        if (record) targets.set(id, { sealed: record.sealed, type: record.type });
      }
      const agentDocument = withStore ? memoryStore.agentDocument(String(pkg.manifest.package_id)) : undefined;
      const memoryRun = new MemoryRun(pkg, plan.resource_grants, Object.fromEntries(Object.entries(run.invocation.authorization.decisions)) as Record<string, string>, {
        scan: withStore ? memoryStore.scanSet() : [],
        targets,
        agentDocument: agentDocument ? { body: agentDocument.body, updated: agentDocument.updated } : null,
        agentDiscard: memoryMessage?.agent_discard ?? null,
        policyRefusesProposals: memoryMessage?.policy_refuses_proposals ?? false,
        memoryFull: memoryMessage?.memory_full ?? false,
      });
      // link.v0 L-15 (T66, D-701): each accepted link's archive, read from the snapshot store by the hash the
      // invocation names and verified by the session against its inner plan; the inner plans beside them.
      const planned = run.invocation.links ?? null;
      const linkArchives: Record<string, Uint8Array> = {};
      for (const [name, link] of Object.entries(planned ?? {})) {
        const linked = await deps.snapshots.getSnapshot(link.archive_sha256);
        if (linked === null) throw new ExecutionError("execution_artifact_mismatch", `The snapshot of linked package ${JSON.stringify(name)} is no longer stored`);
        linkArchives[name] = linked.bytes;
      }
      // What every inner run's tools share with this run: how requests leave and are paced and
      // observed. Never the caller's files, resources or memory (L-25).
      const pacer = new Pacer();
      const linkedDeps = (subject: string, transport: HttpTransport) => ({
        transport,
        credentials: optional,
        describe: { credentialConfigured: (credential: CredentialSource) => optional(credential) !== null },
        pacer,
        observe: (request: { tool_id: string; url: string; body: string | null }) => record("tool", `${subject}:${request.tool_id}`, request.url, request.body),
      });
      // link.v0 §6 (D-703): what lets this run's slots look and join. A look and a candidate's
      // download go to an address the plan could not record (the person's, or a search result's):
      // one GET each under the discovery and package-URL rules, no body, cookie or referrer, over
      // the raw transport, and only at an origin the person granted Chrome (anything else is refused
      // before it is dialled, `grantedOnly`). A joined package's tools reach only the origins of the
      // tools its card approved.
      const cards = message.cards ?? null;
      const slotTransport = (subject: string, url: string): HttpTransport =>
        grantedOnly((request) => {
          record("tool", subject, url, null);
          return deps.transports.tool(request);
        }, cards?.granted ?? []);
      const trustOf: JoinHost["trust"] = async (signer, candidate) => {
        const claimed = candidate.manifest.publisher as { id?: unknown; name?: unknown };
        if (candidate.signature !== null) {
          const key = await embeddedPublicKey(candidate.signature);
          if ((await fingerprint(key)) === signer) publishers.set(signer, { public_key: rawBase64(key), claimed_id: String(claimed.id), claimed_name: String(claimed.name), package_id: String(candidate.manifest.package_id) });
        }
        const subject = { signerFingerprint: signer, claimedPublisherId: String(claimed.id), packageId: String(candidate.manifest.package_id) };
        const own = evaluateTrust(cards?.trust ?? [], subject);
        // The person's store decides whenever it has an opinion; the policy's anchors answer only for a signer it has never heard of.
        if (own.trust_status !== "unknown" || own.trust_reason !== "signer_key_not_pinned" || (cards?.anchors ?? []).length === 0) return own.trust_status;
        return evaluateTrust(cards!.anchors, subject).trust_status;
      };
      const joins: JoinHost | null =
        cards === null
          ? null
          : {
              policy: cards.join,
              look: (url) => {
                return lookAtPage(url, slotTransport("link.join:look", url));
              },
              download: (url) => {
                return downloadPackage(url, slotTransport("link.join:package", url));
              },
              trust: trustOf,
              adapters: async (joined, decision) => {
                const approved = new Set(decision.approvedTools);
                const origins = Object.entries(joined.tools).flatMap(([toolId, tool]) => (approved.has(toolId) && typeof tool.endpoint === "string" ? [httpsOrigin(tool.endpoint)] : [])).filter((origin): origin is string => origin !== null);
                const subject = `join:${String(joined.manifest.package_id)}`;
                return { router: null, handlers: await linkedToolHandlers(joined, decision, linkedDeps(subject, originGuard(deps.transports.tool, origins, { allowLoopback: false })), { runtimeVersion: message.settings.runtimeVersion, now: now(), contactConfigured: contact !== null }) };
              },
            };
      const sessionDeps: SessionDeps = {
        archive,
        consent: run.invocation.turn ? consentHost : null,
        router,
        tools: {
          definitions,
          transport: transports.tool,
          credentials: optional,
          describe: { credentialConfigured: (credential) => optional(credential) !== null },
          files,
          pacer,
          observe: (request) => record("tool", request.tool_id, request.url, request.body),
        },
        linkArchives: planned === null ? null : linkArchives,
        // The inner plan's bindings were frozen from the linked package's own registry (`core/links/tools.ts`), over this run's guarded transport.
        linkTools: async (linked, dependency) => ({ ...linkedDeps(dependency, transports.tool), definitions: (await linkedDefinitions(linked, { runtimeVersion: message.settings.runtimeVersion, now: now(), contactConfigured: contact !== null })).definitions }),
        joins,
        // A policy that forbids the raise leaves that card out of the surface: the request is never made (D-682).
        // A conversation's turn has no run-card surface (T66 review 1, finding 3): the chat draws only the
        // turn's consent card, and the conversation's reservation counted the limits the turn runs under
        // (V-10), so no raise is asked and a slot is `unattended`.
        runConsent: cards === null || run.invocation.turn ? null : runConsent(cards.raise === "forbid" ? ["link.join"] : undefined),
        // L-36, L-44: the plan a decision made during the run names.
        planHash: plan.run_plan_sha256,
        resolver: memoryStore,
        memory: memoryRun,
        compute: deps.compute ?? null,
        onProgress: () => void checkpoint(),
        // D-071: a checkpoint after every wave, the moment its patches are committed.
        // The delegation view (D-704) redraws from the stored audit: a checkpoint too at every event it folds.
        onAudit: (event) => {
          if (event.action === "state.committed" || DELEGATION_EVENTS.has(String(event.action))) void checkpoint();
        },
        now,
      };
      const begin: BeginReport = await session.begin(
        { run_id: runId, run_plan: plan, authorization: run.invocation.authorization, input: run.invocation.input, attachments, limits: run.invocation.limits, host: { runtime: HOST_RUNTIME, runtime_version: message.settings.runtimeVersion, verified_version: message.settings.verifiedVersion }, turn: run.invocation.turn ?? null, links: planned === null ? null : Object.fromEntries(Object.entries(planned).map(([name, link]) => [name, { run_plan: link.run_plan, authorization: link.authorization }])) },
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
          conversation: run.invocation.turn ? { conversationId: run.invocation.turn.conversation_id, turn: run.invocation.turn.turn } : null,
        });
      });
      if (cancelRequested) session.cancel();
      const outcome = await session.run();
      const ended = now();
      return await settle((current) => {
        current.record = completeRunRecord(current.record, outcome.result, ended);
        // memory.v0: what the service worker applies to the memory after the run (M-29, M-50): the
        // usage entries from the audit, the staged agent body a completed run commits, the instant
        // of `memory.proposed`. Never a value of a record.
        const audit = (outcome.report.audit ?? []) as unknown as JsonObject[];
        const packageVersion = String(pkg.manifest.version);
        const packageId = String(pkg.manifest.package_id);
        const usage: NonNullable<StoredRun["memory_usage"]> = [];
        for (const event of audit) {
          const at = String(event.timestamp ?? ended.toISOString());
          if (event.action === "memory.read" && typeof event.record_id === "string") usage.push({ record_id: event.record_id, use: "read", package_id: packageId, package_version: packageVersion, run_id: runId, at });
          if (event.action === "memory.agent.read" && event.present === true) usage.push({ record_id: agentDocument?.id ?? "", use: "agent_read", package_id: packageId, package_version: packageVersion, run_id: runId, at });
        }
        current.memory_usage = usage.filter((entry) => entry.record_id !== "");
        const committed = outcome.report.memory?.agent?.committed ?? null;
        const body = memoryRun.stagedBody();
        current.memory_commit = committed !== null && body !== null ? { package_id: committed.package_id, package_version: packageVersion, name: String(pkg.manifest.name ?? packageId), body, bytes: committed.bytes, body_sha256: committed.body_sha256, at: ended.toISOString() } : null;
        const proposed = audit.find((event) => event.action === "memory.proposed");
        current.memory_proposed_at = proposed ? String(proposed.timestamp) : null;
        // conversation.v0 (D-270): what the conversation charges from this turn, read once by the service worker.
        if (run.invocation.turn) {
          current.turn_outcome = { spent_permissions: outcome.spentPermissions, conversation_state: outcome.report.conversation_state ?? null, consents: outcome.report.consents ?? [], output: outcome.report.output ?? null };
          current.consent_pending = null;
        }
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
    decide,
    card,
  };
}
