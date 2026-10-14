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

/**
 * Ask Chrome for host access to these origins (T16, D-193). Called from a click handler, where
 * the user gesture Chrome requires is in force; never from the worker. Resolves with what Chrome
 * decided; a refusal is not an error here, the worker refuses the fetch by name and the view
 * offers Allow again.
 */
export async function requestOrigins(origins: readonly string[]): Promise<boolean> {
  const patterns = [...new Set(origins.map((origin) => (origin === "*" ? "https://*/*" : `${origin}/*`)))];
  if (patterns.length === 0) return true;
  try {
    if (await chrome.permissions.contains({ origins: patterns })) return true;
    return await chrome.permissions.request({ origins: patterns });
  } catch {
    return false;
  }
}

/** The `https://host` origin of a URL, for `requestOrigins`; null for anything that is not an HTTPS URL. */
export function originOfUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" ? parsed.origin : null;
  } catch {
    return null;
  }
}

/** The origins named by a refusal (`origin_not_granted`, `origins_not_granted`, `run_plan_refused` with missing origins), for the Allow button. */
export function refusedOrigins(error: { code: string; details: Record<string, unknown> }): string[] {
  const listed = error.details.origins ?? error.details.missing_origins;
  if (Array.isArray(listed)) return listed.filter((item): item is string => typeof item === "string");
  const reasons = error.details.blocking_reasons;
  if (Array.isArray(reasons)) {
    const reason = reasons.find((item) => typeof item === "object" && item !== null && (item as { code?: unknown }).code === "origins_not_granted") as { subject?: unknown } | undefined;
    if (typeof reason?.subject === "string") return reason.subject.split(",").map((item) => item.trim()).filter(Boolean);
  }
  return [];
}
