/**
 * The offscreen document (D-070): the execution host's shell. Created by the service worker on
 * the first run and kept until the extension unloads; it spawns one dedicated Worker per run,
 * forwards `host.start` and `host.cancel`, answers `host.status`, and relays the Worker's
 * progress and completion to the service worker as `host.progress` / `host.finished`. It holds
 * no state the stores do not hold: a run's truth is its IndexedDB record, written by the Worker.
 */
import { isHostCommand, type HostStatusReply, type WorkerEvent } from "./protocol.js";

interface Active {
  worker: Worker;
  status: "preparing" | "running" | "settling";
}

const active = new Map<string, Active>();

function report(message: { type: "host.progress" | "host.finished"; runId: string }): void {
  chrome.runtime.sendMessage(message).catch(() => {
    // The worker restarts on the next message; the record is in the store either way.
  });
}

chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
  if (!isHostCommand(message)) return false;
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
    case "host.start": {
      if (active.has(message.runId)) {
        sendResponse({ ok: false, error: { code: "execution_active", message: "This run is already executing" } });
        return false;
      }
      try {
        const worker = new Worker("execution-worker.js", { type: "module", name: message.runId });
        const entry: Active = { worker, status: "preparing" };
        active.set(message.runId, entry);
        worker.onmessage = (event: MessageEvent<WorkerEvent>) => {
          const data = event.data;
          if (data.kind === "progress") {
            entry.status = "running";
            report({ type: "host.progress", runId: data.runId });
          } else if (data.kind === "finished" || data.kind === "failed") {
            active.delete(message.runId);
            worker.terminate();
            report({ type: "host.finished", runId: data.runId });
          }
        };
        worker.onerror = () => {
          active.delete(message.runId);
          worker.terminate();
          report({ type: "host.finished", runId: message.runId });
        };
        worker.postMessage({ kind: "start", message });
        sendResponse({ ok: true, result: { started: true } });
      } catch (error) {
        sendResponse({ ok: false, error: { code: "execution_unavailable", message: `The execution Worker could not be created (${error instanceof Error ? error.name : "error"})` } });
      }
      return false;
    }
  }
});
