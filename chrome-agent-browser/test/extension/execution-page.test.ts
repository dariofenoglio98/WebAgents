/**
 * The offscreen execution host's shell (`execution-page.ts`, D-070) over a fake `chrome` API and
 * a fake `Worker`: it obeys the extension's own service worker and nobody else (T5 review 1,
 * finding 3), spawns one Worker per run, forwards cancel, answers status, and reports a Worker
 * that died as finished so the service worker can interrupt the run (finding 2).
 */
import { describe, expect, it, vi } from "vitest";

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { SERVICE_WORKER_SCRIPT, type HostStartMessage } from "../../src/extension/execution/protocol.js";
import { PROJECT } from "../helpers/paths.js";

type Listener = (message: unknown, sender: chrome.runtime.MessageSender, sendResponse: (response: unknown) => void) => boolean | undefined;

const EXTENSION_ID = "abcdefghijklmnopabcdefghijklmnop";
const ORIGIN = `chrome-extension://${EXTENSION_ID}`;
let listener: Listener | null = null;
const sent: unknown[] = [];

class FakeWorker {
  static created: FakeWorker[] = [];
  posted: unknown[] = [];
  terminated = false;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onmessageerror: ((event: unknown) => void) | null = null;
  constructor(
    readonly url: string,
    readonly options: unknown,
  ) {
    FakeWorker.created.push(this);
  }
  postMessage(message: unknown): void {
    this.posted.push(message);
  }
  terminate(): void {
    this.terminated = true;
  }
}

vi.stubGlobal("Worker", FakeWorker);
vi.stubGlobal("chrome", {
  runtime: {
    id: EXTENSION_ID,
    // No `getManifest`: an offscreen document does not have it (Chrome 154, observed live).
    getURL: (path: string) => `${ORIGIN}/${path}`,
    onMessage: {
      addListener: (candidate: Listener) => {
        listener = candidate;
      },
    },
    sendMessage: async (message: unknown) => {
      sent.push(message);
    },
  },
});

const { fromServiceWorker } = await import("../../src/extension/execution/execution-page.js");

const serviceWorker = { id: EXTENSION_ID, url: `${ORIGIN}/service-worker.js` } as unknown as chrome.runtime.MessageSender;
const contentScript = { id: EXTENSION_ID, url: "https://webair.example/", frameId: 0, tab: { id: 7, url: "https://webair.example/" } } as unknown as chrome.runtime.MessageSender;
const sidePanel = { id: EXTENSION_ID, url: `${ORIGIN}/sidepanel.html` } as unknown as chrome.runtime.MessageSender;
const fullPage = { id: EXTENSION_ID, url: `${ORIGIN}/browser.html`, frameId: 0, tab: { id: 9, url: `${ORIGIN}/browser.html` } } as unknown as chrome.runtime.MessageSender;
const impostor = { id: "someotherextensionidabcdefghijkl", url: `${ORIGIN}/service-worker.js` } as unknown as chrome.runtime.MessageSender;
const START: HostStartMessage = {
  type: "host.start",
  runId: "run_1",
  credentials: { openai: "sk-test", anthropic: null },
  vault: { key: "AAAA", document: { schema: "x", records: [] } as unknown as HostStartMessage["vault"]["document"] },
  settings: { ollamaBaseUrl: null, think: false, recordRequests: false, runtimeVersion: "0.1.0", verifiedVersion: "0.1.0" },
};

function ask(message: unknown, sender: chrome.runtime.MessageSender): { reply: unknown; returned: boolean | undefined } {
  let reply: unknown;
  const returned = listener!(message, sender, (response) => {
    reply = response;
  });
  return { reply, returned };
}

describe("the offscreen execution host", () => {
  it("names the service worker script as the manifest does", () => {
    const manifest = JSON.parse(readFileSync(join(PROJECT, "src", "extension", "manifest.json"), "utf8")) as { background: { service_worker: string } };
    expect(manifest.background.service_worker).toBe(SERVICE_WORKER_SCRIPT);
  });

  it("judges the sender on Chrome's facts: the service worker and nothing else", () => {
    // What Chrome 154 reports for the service worker: its id and the worker script URL, no tab, no frame.
    const url = `${ORIGIN}/${SERVICE_WORKER_SCRIPT}`;
    expect(fromServiceWorker(serviceWorker, url)).toBe(true);
    for (const other of [contentScript, sidePanel, fullPage, impostor]) expect(fromServiceWorker(other, url)).toBe(false);
    expect(fromServiceWorker({ ...serviceWorker, url: undefined } as unknown as chrome.runtime.MessageSender, url)).toBe(false);
    expect(fromServiceWorker({ ...serviceWorker, frameId: 0 } as unknown as chrome.runtime.MessageSender, url)).toBe(false);
  });

  it("obeys host.* commands from the service worker only (finding 3)", () => {
    expect(listener).not.toBeNull();
    for (const other of [contentScript, sidePanel, fullPage, impostor]) {
      expect(ask(START, other)).toEqual({ reply: undefined, returned: false });
      expect(ask({ type: "host.status" }, other)).toEqual({ reply: undefined, returned: false });
      expect(ask({ type: "host.cancel", runId: "run_1" }, other)).toEqual({ reply: undefined, returned: false });
    }
    expect(FakeWorker.created).toHaveLength(0);
    expect(ask({ type: "run.get", runId: "run_1" }, serviceWorker)).toEqual({ reply: undefined, returned: false }); // not a host command
    expect(ask(START, serviceWorker).reply).toEqual({ ok: true, result: { started: true } });
    expect(FakeWorker.created).toHaveLength(1);
    const worker = FakeWorker.created[0]!;
    expect(worker.url).toBe("execution-worker.js");
    expect(worker.options).toEqual({ type: "module", name: "run_1" });
    expect(worker.posted).toEqual([{ kind: "start", message: START }]);
    expect(ask({ type: "host.status" }, serviceWorker).reply).toEqual({ ok: true, result: { runs: [{ run_id: "run_1", status: "preparing" }] } });
    expect(ask(START, serviceWorker).reply).toMatchObject({ ok: false, error: { code: "execution_active" } });
    // A cancel from a content script naming a known run is ignored; the service worker's reaches the Worker.
    expect(ask({ type: "host.cancel", runId: "run_1" }, contentScript).reply).toBeUndefined();
    expect(worker.posted).toHaveLength(1);
    expect(ask({ type: "host.cancel", runId: "run_1" }, serviceWorker).reply).toEqual({ ok: true, result: { cancelled: true } });
    expect(worker.posted[1]).toEqual({ kind: "cancel" });
    // Progress marks the run running and is relayed.
    worker.onmessage!({ data: { kind: "progress", runId: "run_1" } } as MessageEvent);
    expect(ask({ type: "host.status" }, serviceWorker).reply).toEqual({ ok: true, result: { runs: [{ run_id: "run_1", status: "running" }] } });
    expect(sent.at(-1)).toEqual({ type: "host.progress", runId: "run_1" });
  });

  it("a Worker that dies is terminated, forgotten and reported finished, so the service worker interrupts the run (finding 2)", () => {
    const worker = FakeWorker.created[0]!;
    worker.onerror!(new Error("module failed to load"));
    expect(worker.terminated).toBe(true);
    expect(sent.at(-1)).toEqual({ type: "host.finished", runId: "run_1" });
    expect(ask({ type: "host.status" }, serviceWorker).reply).toEqual({ ok: true, result: { runs: [] } });
    expect(ask({ type: "host.cancel", runId: "run_1" }, serviceWorker).reply).toEqual({ ok: true, result: { cancelled: false } });
    // The run can be started again only by the service worker's decision, which is a new start.
    expect(ask({ ...START, runId: "run_2" }, serviceWorker).reply).toEqual({ ok: true, result: { started: true } });
    const second = FakeWorker.created[1]!;
    second.onmessage!({ data: { kind: "finished", runId: "run_2", status: "completed" } } as MessageEvent);
    expect(second.terminated).toBe(true);
    expect(sent.at(-1)).toEqual({ type: "host.finished", runId: "run_2" });
  });
});
