/**
 * The host model-router contract (`agentpkg/interfaces.py::ModelRouter`, spec §7). No vendor
 * integration lives here; a router is bound to exactly one model id and selects nothing.
 *
 * `countTokens` must be a safe upper bound on every rendered input token: the runtime reserves
 * against it and treats a reported input above it as a contract violation that halts the run.
 * `complete` must enforce the output cap, report all billable and reasoning tokens, bound its
 * I/O and stop when `signal` aborts.
 */
import type { JsonObject, JsonValue } from "../json.js";

export interface ModelRequest {
  task: string;
  instructions: string[];
  data: JsonValue;
  output_schema: JsonValue;
  requirements: JsonObject;
  budget_context: { max_output_tokens: number };
  audit_context: { worker: string; node_id: string | null };
  /** A re-ask's one line naming why the previous answer was not accepted (D-151); absent on a first request. */
  feedback?: string;
}

export interface ModelResult {
  output: JsonValue;
  input_tokens: number;
  output_tokens: number;
  cost_usd?: number | null;
}

export interface ModelRouter {
  readonly remote: boolean;
  readonly model_id: string;
  readonly router_id: string;
  readonly capabilities: ReadonlySet<string>;
  readonly context_window: number;
  /** Network destinations the router reaches, recorded on `model.count.called` and `model.called`. */
  readonly domains?: readonly string[];
  /** A replay adapter whose accounting is a test unit, not a bill. */
  readonly synthetic?: boolean;
  /**
   * How many more times the runtime asks when the answer is not accepted
   * (`model_output_not_conforming`: a schema miss, no JSON, or a failed answer check): 2 for the
   * live router (D-151; 1 under D-115), absent (0) for a replay router, whose answer would not
   * change. Each re-ask is the request plus one `feedback` line naming what was wrong.
   */
  readonly nonconformingRetries?: number;
  /**
   * Whether `countTokens` itself reaches the network. Absent means it may (the reference's rule:
   * the count preflight of a remote router is a separately budgeted remote call); the Chrome bound
   * router counts locally (a UTF-8 bound) and says `false`, so only the requests it sends are
   * charged as remote calls (D-115).
   */
  readonly remoteCount?: boolean;
  countTokens(request: ModelRequest, signal: AbortSignal): Promise<number>;
  complete(request: ModelRequest, maxOutputTokens: number, signal: AbortSignal): Promise<ModelResult>;
}
