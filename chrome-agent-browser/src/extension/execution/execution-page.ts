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
import { isHostCommand, SERVICE_WORKER_SCRIPT, type HostStatusReply, type WorkerEvent } from "./protocol.js";

interface Active {
  worker: Worker;
  status: "preparing" | "running" | "settling";
}

const active = new Map<string, Active>();

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
    case "host.start": {
      if (active.has(message.runId)) {
        sendResponse({ ok: false, error: { code: "execution_active", message: "This run is already executing" } });
        return false;
      }
      try {
        const worker = new Worker("execution-worker.js", { type: "module", name: message.runId });
        const entry: Active = { worker, status: "preparing" };
        active.set(message.runId, entry);
        const ended = () => {
          active.delete(message.runId);
          worker.terminate();
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
        worker.postMessage({ kind: "start", message });
        sendResponse({ ok: true, result: { started: true } });
      } catch (error) {
        sendResponse({ ok: false, error: { code: "execution_unavailable", message: `The execution Worker could not be created (${error instanceof Error ? error.name : "error"})` } });
      }
      return false;
    }
  }
});
