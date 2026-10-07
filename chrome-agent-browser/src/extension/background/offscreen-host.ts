/**
 * The execution host as the service worker reaches it (D-070): one offscreen document
 * (`execution.html`, reason WORKERS: it runs each run in a dedicated Worker), created on the
 * first run and reused. Commands travel over `chrome.runtime.sendMessage`; the document answers
 * them and reports back with `host.progress` / `host.finished`.
 */
import type { ExecutionHostBridge } from "./runs.js";
import type { HostCommand, HostStartMessage, HostStatusReply } from "../execution/protocol.js";

const DOCUMENT = "execution.html";
const JUSTIFICATION = "Runs an authorized agent package in a dedicated Worker so that the run survives the side panel and the service worker being closed (WebAgents execution host).";

type Reply<T> = { ok: true; result: T } | { ok: false; error: { code: string; message: string } } | undefined;

export class OffscreenHostBridge implements ExecutionHostBridge {
  private creating: Promise<void> | null = null;

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
    await this.ensure();
    await this.send<{ started: true }>(message);
  }

  async cancel(runId: string): Promise<void> {
    if (!(await chrome.offscreen.hasDocument())) return;
    await this.send<{ cancelled: boolean }>({ type: "host.cancel", runId });
  }

  async status(): Promise<HostStatusReply | null> {
    if (!(await chrome.offscreen.hasDocument())) return null;
    return this.send<HostStatusReply>({ type: "host.status" });
  }
}
