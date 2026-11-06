/**
 * The offscreen document (D-070): the execution host's shell. Created by the service worker on
 * the first run and kept until the extension unloads; it spawns one dedicated Worker per run,
 * forwards `host.start` and `host.cancel`, answers `host.status`, and relays the Worker's
 * progress and completion to the service worker as `host.progress` / `host.finished`. It holds
 * no state the stores do not hold: a run's truth is its IndexedDB record, written by the Worker.
 *
 * It obeys one sender: the extension's own service worker, the one state owner (D-035), judged
 * on facts Chrome vouches for (`MessageSender`), never on the message's shape alone. A content
 * script's `chrome.runtime.sendMessage` reaches this document too, with the website's tab and
 * URL on the sender; an extension view (the side panel, `browser.html`) has a document URL of
 * its own. Neither may start or cancel a run (T5 review 1, finding 3).
 */
import { Database } from "../storage/database.js";
import { IndexedDbModelStore } from "../storage/models.js";
import { EngineHost, EngineRefusal, type EngineWorkerLike } from "./engine-host.js";
import { ENGINE_WORKER_SCRIPT, MODELS_WORKER_SCRIPT } from "./engine-protocol.js";
import { ModelError, ModelManager, type ModelsWorkerLike } from "./models-manager.js";
import { isHostCommand, SERVICE_WORKER_SCRIPT, type HostEngineMessage, type HostModelsMessage, type HostStartMessage, type HostStatusReply, type WorkerEvent } from "./protocol.js";

interface Active {
  worker: Worker;
  status: "preparing" | "running" | "settling";
}

const active = new Map<string, Active>();

/**
 * The in-browser engine and the model cache (T41, D-441, D-450, D-451): owned by this page, which
 * outlives runs, so a loaded model serves the next run and a long download survives the side panel
 * and the service worker. Each Worker is created on first use.
 */
const models = new IndexedDbModelStore(new Database());
/** Tell the service worker the cache or the engine changed (Settings shows it; the catalog is re-read). */
let changeQueued = false;
function modelsChanged(): void {
  if (changeQueued) return;
  changeQueued = true;
  setTimeout(() => {
    changeQueued = false;
    chrome.runtime.sendMessage({ type: "host.modelsChanged" }).catch(() => undefined);
  }, 250);
}
const engineHost = new EngineHost({ spawn: () => new Worker(ENGINE_WORKER_SCRIPT, { type: "module", name: "engine" }) as unknown as EngineWorkerLike, models, onChange: modelsChanged });
const modelManager = new ModelManager({ spawn: () => new Worker(MODELS_WORKER_SCRIPT, { type: "module", name: "models" }) as unknown as ModelsWorkerLike, models, engine: engineHost, onChange: modelsChanged });
// The e2e harness reads these over CDP (as `__ab` in the pages): the engine's status and a CPU-only control load.
(globalThis as unknown as { __engine: { host: EngineHost; manager: ModelManager } }).__engine = { host: engineHost, manager: modelManager };

type Reply = { ok: true; result: unknown } | { ok: false; error: { code: string; message: string; details?: Record<string, unknown> } };
function failed(error: unknown): Reply {
  if (error instanceof EngineRefusal) return { ok: false, error: { code: error.code, message: error.message, details: error.detail } };
  if (error instanceof ModelError) return { ok: false, error: { code: error.code, message: error.message } };
  return { ok: false, error: { code: "engine_error", message: error instanceof Error ? error.message.slice(0, 500) : "the engine failed" } };
}

async function modelsCommand(message: HostModelsMessage): Promise<unknown> {
  switch (message.action) {
    case "download":
      return modelManager.download(message.entry);
    case "list":
      return modelManager.list(message.entry);
    case "cancel":
      return { cancelled: modelManager.cancel(message.entryId) };
    case "verify":
      return modelManager.verify(message.entryId);
    case "delete":
      await modelManager.delete(message.entryId);
      return { deleted: true };
    case "status":
      return { downloads: modelManager.status(), engine: engineHost.status(), orphans: await modelManager.cachedOrphans().catch(() => null) };
    case "files":
      return modelManager.files();
    case "prune":
      return modelManager.prune();
  }
}

async function engineCommand(message: HostEngineMessage): Promise<unknown> {
  switch (message.action) {
    case "probe":
      return engineHost.probe();
    case "benchmark":
      return engineHost.benchmark();
    case "status":
      return engineHost.status();
    case "unload":
      await engineHost.unload();
      return engineHost.status();
    case "load":
      engineHost.setIdleMinutes(message.load.idle_unload_minutes);
      return engineHost.ensure(message.load, null);
  }
}

/** Only the extension's own service worker: same extension, no tab, no frame, the worker script as the sender URL. */
export function fromServiceWorker(sender: chrome.runtime.MessageSender, workerUrl: string): boolean {
  return sender.id === chrome.runtime.id && sender.tab === undefined && sender.frameId === undefined && sender.url === workerUrl;
}

function report(message: { type: "host.progress" | "host.finished"; runId: string }): void {
  chrome.runtime.sendMessage(message).catch(() => {
    // The worker restarts on the next message; the record is in the store either way.
  });
}

// `chrome.runtime.getURL` is available to an offscreen document; `getManifest` is not (Chrome 154).
const WORKER_URL = chrome.runtime.getURL(SERVICE_WORKER_SCRIPT);

chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
  if (!isHostCommand(message)) return false;
  if (!fromServiceWorker(sender, WORKER_URL)) return false; // not ours to answer
  switch (message.type) {
    case "host.status": {
      const reply: HostStatusReply = { runs: [...active.entries()].map(([run_id, entry]) => ({ run_id, status: entry.status })) };
      sendResponse({ ok: true, result: reply });
      return false;
    }
    case "host.cancel": {
      active.get(message.runId)?.worker.postMessage({ kind: "cancel" });
      sendResponse({ ok: true, result: { cancelled: active.has(message.runId) } });
      return false;
    }
    case "host.decide": {
      // conversation.v0: the person's answer to the card; the Worker also reads it from the record.
      active.get(message.runId)?.worker.postMessage({ kind: "decide", step: message.step, accepted: message.accepted });
      sendResponse({ ok: true, result: { delivered: active.has(message.runId) } });
      return false;
    }
    case "host.models":
    case "host.engine": {
      (message.type === "host.models" ? modelsCommand(message) : engineCommand(message)).then((result) => sendResponse({ ok: true, result }), (error: unknown) => sendResponse(failed(error)));
      return true;
    }
    case "host.start": {
      if (active.has(message.runId)) {
        sendResponse({ ok: false, error: { code: "execution_active", message: "This run is already executing" } });
        return false;
      }
      if (message.inBrowser) {
        // The in-browser route (D-441): the model is loaded before the run starts, or the run is
        // refused with the reason before any node runs (principle 6: never another model).
        const start = message.inBrowser;
        engineHost.setIdleMinutes(start.idle_unload_minutes);
        engineHost.ensure({ entry: start.entry, n_ctx: start.n_ctx, think: start.think, budget: start.budget }, message.runId).then(
          () => {
            const channel = new MessageChannel();
            engineHost.attach(message.runId, channel.port1 as never);
            sendResponse(startRun(message, channel.port2));
          },
          (error: unknown) => sendResponse(failed(error)),
        );
        return true;
      }
      sendResponse(startRun(message, null));
      return false;
    }
  }
});

/** Spawn the run's Worker and hand it the start message (and the engine port, transferred, for an in-browser run). */
function startRun(message: HostStartMessage, enginePort: MessagePort | null): Reply {
  try {
    const worker = new Worker("execution-worker.js", { type: "module", name: message.runId });
    const entry: Active = { worker, status: "preparing" };
    active.set(message.runId, entry);
    const ended = () => {
      active.delete(message.runId);
      worker.terminate();
      engineHost.release(message.runId);
      report({ type: "host.finished", runId: message.runId });
    };
    worker.onmessage = (event: MessageEvent<WorkerEvent>) => {
      const data = event.data;
      if (data.kind === "progress") {
        entry.status = "running";
        report({ type: "host.progress", runId: data.runId });
      } else if (data.kind === "finished" || data.kind === "failed") {
        ended();
      }
    };
    // A Worker that dies (a module that fails to load, an uncaught exception, out of memory)
    // reports `host.finished` without having settled its record; the service worker then
    // marks the run interrupted (D-071; T5 review 1, finding 2).
    worker.onerror = ended;
    worker.onmessageerror = ended;
    worker.postMessage({ kind: "start", message, enginePort }, enginePort ? [enginePort] : []);
    return { ok: true, result: { started: true } };
  } catch (error) {
    engineHost.release(message.runId);
    return { ok: false, error: { code: "execution_unavailable", message: `The execution Worker could not be created (${error instanceof Error ? error.name : "error"})` } };
  }
}
