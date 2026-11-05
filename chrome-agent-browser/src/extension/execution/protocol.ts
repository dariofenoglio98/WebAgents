/**
 * The protocol between the service worker and the execution host (D-070). The host is an
 * offscreen document that runs each run in a dedicated Worker; the worker (the one state owner,
 * D-035) decides to start a run, writes its invocation to IndexedDB, and asks the host to run it.
 * The host never decides anything about authority: it re-verifies the bytes against the plan
 * (`ExecutionSession.begin`) and executes.
 *
 * What travels in `host.start` and nowhere else: the key of the provider the plan bound (and no
 * other, D-195), the memory when the plan grants a record or binds a memory tool (the person's
 * records, which the broker resolves for `host_resource` bindings and whose sealed values the
 * egress guards refuse anywhere else; null otherwise), and the origins the plan allows the run to reach (D-193), which the
 * host's transports enforce beneath the core URL gate. The secrets live encrypted in
 * `chrome.storage.local` (D-191) and in the host's memory for the run; no record, checkpoint or
 * artifact carries them.
 */
import type { OpenAIReasoningEffort } from "../../core/models/adapters/openai.js";
import type { MemorySnapshot } from "../../core/memory/store.js";
import type { TurnStart } from "../../core/execution/runner.js";
import type { InBrowserEntry } from "../../core/models/in-browser-catalog.js";

export interface HostCredentials {
  openai: string | null;
  anthropic: string | null;
}

export interface HostRunSettings {
  /** Ollama's base URL (loopback only, D-055), or null for the default. */
  ollamaBaseUrl: string | null;
  /** The hosted providers' base URLs when the person set one (Settings → Models): the origins the plan recorded (review 1, finding 3); absent means the provider's default. */
  openaiBaseUrl?: string | null;
  anthropicBaseUrl?: string | null;
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
  /**
   * The memory (T19, memory.v0 M-36): the whole store under its digest key when the plan grants a
   * record or binds a memory tool (the scan set is every sealed value; the resolver answers only
   * the plan's grants), and `snapshot: null` otherwise (the host then holds an empty store under a
   * throwaway key, D-195). Beside it, what the preset and the subscribed policy decide for the
   * agent document (M-50) and the proposals (M-54), and whether the memory is full (M-47).
   */
  memory: { key: string | null; snapshot: MemorySnapshot | null; agent_discard: "preset" | "policy" | null; policy_refuses_proposals: boolean; memory_full: boolean } | null;
  settings: HostRunSettings;
  /**
   * The origins (`https://host`) this run may reach: the plan's package, tool and provider origins
   * (D-193). The model transport may also reach Ollama on the loopback names; nothing else.
   */
  allowedOrigins: string[];
  /** conversation.v0 (D-270): the turn this run is, or null for a one-shot run. */
  turn?: TurnStart | null;
  /**
   * The in-browser route (T41, D-441, D-450): when the plan binds `in-browser/<entry>`, what the page
   * loads before the run starts (the entry at the plan's context, thinking as the switch says) and
   * the machine's budget the service worker computed; the page refuses before the run when the
   * model is not cached, verified and within the budget, or another model is in use. Null or
   * absent for every other route: such a run gets no engine port.
   */
  inBrowser?: InBrowserStart | null;
}

export interface InBrowserStart {
  entry: string;
  n_ctx: number;
  think: boolean;
  budget: { bytes: number; basis: string };
  idle_unload_minutes: number;
}

/** Settings → Models → In this browser: the cache's commands to the offscreen page (T41, D-444). */
export type HostModelsMessage =
  | { type: "host.models"; action: "download"; entry: InBrowserEntry }
  | { type: "host.models"; action: "list"; entry: InBrowserEntry }
  | { type: "host.models"; action: "cancel" | "verify" | "delete"; entryId: string }
  | { type: "host.models"; action: "status" | "files" };

/** The engine's commands from Settings (T41, D-450): never a completion, which only a run's port asks for. */
export type HostEngineMessage =
  | { type: "host.engine"; action: "probe" | "benchmark" | "status" | "unload" }
  | { type: "host.engine"; action: "load"; load: { entry: string; n_ctx: number; think: boolean; budget: { bytes: number; basis: string }; idle_unload_minutes: number } };

export interface HostCancelMessage {
  type: "host.cancel";
  runId: string;
}

/** conversation.v0 (D-270): the person's answer to the card a turn waits on; the record carries it too, so a lost message never hangs the step. */
export interface HostDecideMessage {
  type: "host.decide";
  runId: string;
  step: string;
  accepted: boolean;
}

export interface HostStatusMessage {
  type: "host.status";
}

export type HostCommand = HostStartMessage | HostCancelMessage | HostStatusMessage | HostDecideMessage | HostModelsMessage | HostEngineMessage;

export interface HostStatusReply {
  runs: Array<{ run_id: string; status: "preparing" | "running" | "settling" }>;
}

export const HOST_COMMAND_TYPES: readonly HostCommand["type"][] = ["host.start", "host.cancel", "host.status", "host.decide", "host.models", "host.engine"];

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
/** `start` transfers the engine port (T41, D-450) when the plan binds the in-browser route. */
export type WorkerCommand = { kind: "start"; message: HostStartMessage; enginePort?: MessagePort | null } | { kind: "cancel" } | { kind: "decide"; step: string; accepted: boolean };
export type WorkerEvent = { kind: "progress"; runId: string } | { kind: "finished"; runId: string; status: string } | { kind: "failed"; runId: string; code: string; message: string };
