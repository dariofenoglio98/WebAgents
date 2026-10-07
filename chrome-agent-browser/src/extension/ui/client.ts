/**
 * How a view talks to the service worker (D-035): one typed `send`, one `subscribe` for the
 * `event.*` broadcasts. Views hold no state of their own beyond what they are showing.
 */
import { CoreError } from "../../core/errors.js";
import { isEvent, type Event, type Request, type Response } from "../messages.js";

export async function send<T>(request: Request): Promise<T> {
  const response = (await chrome.runtime.sendMessage(request)) as Response<T> | undefined;
  if (!response) throw new CoreError("service_unavailable", "The extension's background service did not answer");
  if (!response.ok) throw new CoreError(response.error.code, response.error.message, { details: response.error.details ?? null });
  return response.result;
}

export function subscribe(handler: (event: Event) => void): () => void {
  const listener = (message: unknown) => {
    if (isEvent(message)) handler(message);
  };
  chrome.runtime.onMessage.addListener(listener);
  return () => chrome.runtime.onMessage.removeListener(listener);
}

export function describeError(error: unknown): { code: string; message: string; details: Record<string, unknown> } {
  if (error instanceof CoreError) return { code: error.code, message: error.message, details: error.details };
  return { code: "error", message: error instanceof Error ? error.message : String(error), details: {} };
}
