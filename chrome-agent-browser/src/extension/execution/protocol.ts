/**
 * The protocol between the service worker and the execution host (D-070). The host is an
 * offscreen document that runs each run in a dedicated Worker; the worker (the one state owner,
 * D-035) decides to start a run, writes its invocation to IndexedDB, and asks the host to run it.
 * The host never decides anything about authority: it re-verifies the bytes against the plan
 * (`ExecutionSession.begin`) and executes.
 *
 * What travels in `host.start` and nowhere else: the key of the provider the plan bound (and no
 * other, D-195), the vault when the plan grants records (the person's records, which the broker
 * resolves for `host_resource` bindings and whose sealed values the egress guard refuses anywhere
 * else; null otherwise), and the origins the plan allows the run to reach (D-193), which the
 * host's transports enforce beneath the core URL gate. The secrets live encrypted in
 * `chrome.storage.local` (D-191) and in the host's memory for the run; no record, checkpoint or
 * artifact carries them.
 */
import type { OpenAIReasoningEffort } from "../../core/models/adapters/openai.js";
import type { VaultDocument } from "../../core/vault.js";

export interface HostCredentials {
  openai: string | null;
  anthropic: string | null;
}

export interface HostRunSettings {
  /** Ollama's base URL (loopback only, D-055), or null for the default. */
  ollamaBaseUrl: string | null;
  think: boolean;
  /** OpenAI's reasoning effort (Settings → Models, D-123); absent means the adapter's default, `medium`. */
  openaiReasoningEffort?: OpenAIReasoningEffort;
  /** Test mode (D-028): record every outbound model and tool request body to the observation store. */
  recordRequests: boolean;
  runtimeVersion: string;
  verifiedVersion: string;
  /**
   * The person's Crossref contact address (Settings → Services, D-081), sent as `mailto` by the
   * scholarly-search adapter only; null when none was entered. Travels like the keys: in memory,
   * for this run, never in a record.
   */
  crossrefContact: string | null;
}

export interface HostStartMessage {
  type: "host.start";
  runId: string;
  credentials: HostCredentials;
  /** The vault, when the plan grants a record; null when it grants none (the host then holds an empty vault, D-195). */
  vault: { key: string; document: VaultDocument } | null;
  settings: HostRunSettings;
  /**
   * The origins (`https://host`) this run may reach: the plan's package, tool and provider origins
   * (D-193). The model transport may also reach Ollama on the loopback names; nothing else.
   */
  allowedOrigins: string[];
}

export interface HostCancelMessage {
  type: "host.cancel";
  runId: string;
}

export interface HostStatusMessage {
  type: "host.status";
}

export type HostCommand = HostStartMessage | HostCancelMessage | HostStatusMessage;

export interface HostStatusReply {
  runs: Array<{ run_id: string; status: "preparing" | "running" | "settling" }>;
}

export const HOST_COMMAND_TYPES: readonly HostCommand["type"][] = ["host.start", "host.cancel", "host.status"];

/**
 * The service worker's script, as the manifest names it (`background.service_worker`; a test
 * holds the two equal). The execution host accepts `host.*` commands only from a sender whose
 * URL is this script's: Chrome reports a service worker sender with its id and the worker
 * script URL and nothing else (observed in Chrome 154 through the live harness). An offscreen
 * document cannot read the manifest (`chrome.runtime.getManifest` is not exposed there), so the
 * name is a shared constant.
 */
export const SERVICE_WORKER_SCRIPT = "service-worker.js";

export function isHostCommand(value: unknown): value is HostCommand {
  return typeof value === "object" && value !== null && (HOST_COMMAND_TYPES as readonly string[]).includes((value as { type?: unknown }).type as string);
}

/** Messages the offscreen page and its Worker exchange (never seen outside the host). */
export type WorkerCommand = { kind: "start"; message: HostStartMessage } | { kind: "cancel" };
export type WorkerEvent = { kind: "progress"; runId: string } | { kind: "finished"; runId: string; status: string } | { kind: "failed"; runId: string; code: string; message: string };
