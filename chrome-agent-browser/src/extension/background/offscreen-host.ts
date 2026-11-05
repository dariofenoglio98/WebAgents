/**
 * The execution host as the service worker reaches it (D-070): one offscreen document
 * (`execution.html`, reason WORKERS: it runs each run in a dedicated Worker), created on the
 * first run and reused. Commands travel over `chrome.runtime.sendMessage`; the document answers
 * them and reports back with `host.progress` / `host.finished`.
 */
import type { ExecutionHostBridge, HostCancelAnswer } from "./runs.js";
import type { HostCommand, HostEngineMessage, HostModelsMessage, HostStartMessage, HostStatusReply } from "../execution/protocol.js";

const DOCUMENT = "execution.html";
const JUSTIFICATION = "Runs an authorized agent package in a dedicated Worker so that the run survives the side panel and the service worker being closed (WebAgents execution host).";

type Reply<T> = { ok: true; result: T } | { ok: false; error: { code: string; message: string } } | undefined;

export class OffscreenHostBridge implements ExecutionHostBridge {
  private creating: Promise<void> | null = null;
  /** The runs whose start is in progress here: a document being created is taking only these (T5 review 3, nit 3). */
  private readonly startingRuns = new Set<string>();

  available(): boolean {
    return typeof chrome !== "undefined" && typeof chrome.offscreen !== "undefined" && typeof chrome.offscreen.createDocument === "function";
  }

  private async ensure(): Promise<void> {
    if (await chrome.offscreen.hasDocument()) return;
    if (!this.creating) {
      this.creating = chrome.offscreen
        .createDocument({ url: DOCUMENT, reasons: [chrome.offscreen.Reason.WORKERS], justification: JUSTIFICATION })
        .catch((error: unknown) => {
          // Two starts racing: the second create fails because the first succeeded.
          if (error instanceof Error && /single offscreen document|already exists/iu.test(error.message)) return;
          throw error;
        })
        .finally(() => {
          this.creating = null;
        });
    }
    await this.creating;
  }

  private async send<T>(command: HostCommand): Promise<T> {
    const reply = (await chrome.runtime.sendMessage(command)) as Reply<T>;
    if (!reply) throw new Error("the execution host did not answer");
    if (!reply.ok) throw new Error(`${reply.error.code}: ${reply.error.message}`);
    return reply.result;
  }

  async start(message: HostStartMessage): Promise<void> {
    this.startingRuns.add(message.runId);
    try {
      await this.ensure();
      await this.send<{ started: true }>(message);
    } finally {
      this.startingRuns.delete(message.runId);
    }
  }

  async cancel(runId: string): Promise<HostCancelAnswer> {
    // No document yet: one being created *for this run* reads the stored cancel flag when it
    // starts it (review 2, finding 1); otherwise nothing can take the cancel.
    if (!(await chrome.offscreen.hasDocument())) return this.creating !== null && this.startingRuns.has(runId) ? "taken" : "no_host";
    // The page's own answer: whether a Worker held the run (T5 review 3, nit 3).
    const reply = await this.send<{ cancelled: boolean }>({ type: "host.cancel", runId });
    return reply.cancelled ? "taken" : this.startingRuns.has(runId) ? "taken" : "not_held";
  }

  async status(): Promise<HostStatusReply | null> {
    if (!(await chrome.offscreen.hasDocument())) return null;
    return this.send<HostStatusReply>({ type: "host.status" });
  }

  /**
   * The in-browser engine and the model cache (T41): a Settings command to the page, creating the
   * document when needed (a download or a load outlives the side panel and this worker).
   */
  async engine(message: HostModelsMessage | HostEngineMessage): Promise<unknown> {
    await this.ensure();
    return this.send<unknown>(message);
  }

  /** conversation.v0: the person's answer to a card, to the Worker that waits on it (the record carries it too). */
  async decide(runId: string, step: string, accepted: boolean): Promise<boolean> {
    if (!(await chrome.offscreen.hasDocument())) return false;
    const reply = await this.send<{ delivered: boolean }>({ type: "host.decide", runId, step, accepted });
    return reply.delivered;
  }
}
