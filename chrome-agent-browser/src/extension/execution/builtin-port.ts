/**
 * Chrome's built-in model through the Prompt API (`LanguageModel`, D-023, D-072), as a
 * `BuiltinModelPort` for the core's adapter. One session per call, the system prompt as the
 * session's initial prompt, the bundled output schema as `responseConstraint`, and the API's own
 * `measureInputUsage` for the token counts the adapter records. Nothing leaves the device.
 */
import type { BuiltinAvailability, BuiltinModelPort, BuiltinSession } from "../../core/models/adapters/chrome-builtin.js";
import type { BuiltinAvailability as CatalogBuiltin } from "../../core/models/catalog.js";

/** The subset of the Prompt API this port uses, typed here because `@types/chrome` carries none of it. */
export interface LanguageModelApi {
  availability(options?: Record<string, unknown>): Promise<string>;
  create(options?: {
    initialPrompts?: Array<{ role: "system" | "user" | "assistant"; content: string }>;
    signal?: AbortSignal;
    monitor?: (monitor: { addEventListener(type: "downloadprogress", listener: (event: { loaded: number; total?: number }) => void): void }) => void;
  }): Promise<LanguageModelSessionApi>;
}

export interface LanguageModelSessionApi {
  prompt(input: string, options?: { responseConstraint?: Record<string, unknown>; omitResponseConstraintInput?: boolean; signal?: AbortSignal }): Promise<string>;
  measureInputUsage(input: string, options?: { signal?: AbortSignal }): Promise<number>;
  readonly inputQuota: number;
  readonly inputUsage: number;
  destroy(): void;
}

const KNOWN: readonly BuiltinAvailability[] = ["available", "downloadable", "downloading", "unavailable"];

export function languageModelApi(scope: unknown = globalThis): LanguageModelApi | null {
  const api = (scope as { LanguageModel?: Partial<LanguageModelApi> }).LanguageModel;
  return api && typeof api.availability === "function" && typeof api.create === "function" ? (api as LanguageModelApi) : null;
}

export class LanguageModelPort implements BuiltinModelPort {
  constructor(private readonly api: LanguageModelApi) {}

  async availability(): Promise<BuiltinAvailability> {
    try {
      const answer = await this.api.availability();
      return (KNOWN as readonly string[]).includes(answer) ? (answer as BuiltinAvailability) : "unavailable";
    } catch {
      return "unavailable";
    }
  }

  async createSession(options: { systemPrompt: string; responseConstraint?: Record<string, unknown> | null; signal: AbortSignal }): Promise<BuiltinSession> {
    const session = await this.api.create({ initialPrompts: [{ role: "system", content: options.systemPrompt }], signal: options.signal });
    const constraint = options.responseConstraint ?? null;
    return {
      inputQuota: session.inputQuota,
      constrained: constraint !== null,
      prompt: (text, signal) => session.prompt(text, { ...(constraint ? { responseConstraint: constraint } : {}), signal }),
      measureInputUsage: (text) => session.measureInputUsage(text),
      destroy: () => session.destroy(),
    };
  }
}

/** Start the built-in model's download (Settings → Models); progress in [0, 1]. Resolves when the session could be created. */
export async function downloadBuiltinModel(api: LanguageModelApi, onProgress: (fraction: number) => void, signal?: AbortSignal): Promise<void> {
  const session = await api.create({
    signal,
    monitor: (monitor) => {
      monitor.addEventListener("downloadprogress", (event) => onProgress(event.total ? event.loaded / event.total : event.loaded));
    },
  });
  session.destroy();
}

/**
 * The catalog's reading of the built-in model (D-055, D-113), as a function the service worker
 * calls on every probe: `availability()` as the API answers it (`unsupported` when this context
 * exposes no Prompt API, null when the call throws), and, once Chrome reports `available`, the
 * session quota, read by creating one session that is never prompted and destroying it. The quota
 * is a property of the model, so it is measured once per reader; a failure leaves it unknown and
 * the person can state the context in Settings → Models. Never a network request.
 */
export function builtinReader(scope: unknown = globalThis): () => Promise<CatalogBuiltin | null> {
  let quota: number | null = null;
  return async () => {
    const api = (scope as { LanguageModel?: { availability?: () => Promise<string>; create?: () => Promise<{ inputQuota?: unknown; destroy?: () => void }> } }).LanguageModel;
    if (!api || typeof api.availability !== "function") return { availability: "unsupported", input_quota: null };
    let answer: string;
    try {
      answer = await api.availability();
    } catch {
      return null;
    }
    const availability = (KNOWN as readonly string[]).includes(answer) ? (answer as BuiltinAvailability) : "unavailable";
    if (availability !== "available") return { availability, input_quota: null };
    if (quota === null && typeof api.create === "function") {
      try {
        const session = await api.create();
        if (typeof session.inputQuota === "number" && Number.isSafeInteger(session.inputQuota) && session.inputQuota > 0) quota = session.inputQuota;
        session.destroy?.();
      } catch {
        // unknown stays unknown
      }
    }
    return { availability, input_quota: quota };
  };
}
