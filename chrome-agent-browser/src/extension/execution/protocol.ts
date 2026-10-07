/**
 * The protocol between the service worker and the execution host (D-070). The host is an
 * offscreen document that runs each run in a dedicated Worker; the worker (the one state owner,
 * D-035) decides to start a run, writes its invocation to IndexedDB, and asks the host to run it.
 * The host never decides anything about authority: it re-verifies the bytes against the plan
 * (`ExecutionSession.begin`) and executes.
 *
 * What travels in `host.start` and nowhere else: the provider keys the run needs and the vault
 * (the person's records, which the broker resolves for `host_resource` bindings and whose sealed
 * values the egress guard refuses anywhere else). They live in `chrome.storage.local` and in the
 * host's memory for the run; no record, checkpoint or artifact carries them.
 */
import type { VaultDocument } from "../../core/vault.js";

export interface HostCredentials {
  openai: string | null;
  anthropic: string | null;
}

export interface HostRunSettings {
  /** Ollama's base URL (loopback only, D-055), or null for the default. */
  ollamaBaseUrl: string | null;
  think: boolean;
  /** Test mode (D-028): record every outbound model and tool request body to the observation store. */
  recordRequests: boolean;
  runtimeVersion: string;
  verifiedVersion: string;
}

export interface HostStartMessage {
  type: "host.start";
  runId: string;
  credentials: HostCredentials;
  vault: { key: string; document: VaultDocument };
  settings: HostRunSettings;
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

export function isHostCommand(value: unknown): value is HostCommand {
  return typeof value === "object" && value !== null && (HOST_COMMAND_TYPES as readonly string[]).includes((value as { type?: unknown }).type as string);
}

/** Messages the offscreen page and its Worker exchange (never seen outside the host). */
export type WorkerCommand = { kind: "start"; message: HostStartMessage } | { kind: "cancel" };
export type WorkerEvent = { kind: "progress"; runId: string } | { kind: "finished"; runId: string; status: string } | { kind: "failed"; runId: string; code: string; message: string };
