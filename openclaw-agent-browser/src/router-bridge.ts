/**
 * The host side of the private model-router bridge.
 *
 * Framing, correlation, cancellation and child lifetime live in
 * `bridge-core.ts`, which the execution runner uses too. What is here is only
 * what makes this bridge the *probe* bridge: its protocol version, its three
 * lifecycle methods, and the one call sequence that proves the ModelRouter
 * contract against the exact model a run plan bound.
 *
 * ```text
 *   this process (Gateway)                       spawned child
 *   ──────────────────────                       ─────────────
 *   session.begin / probe.run / session.end  ──▶  stdin
 *   model.count_tokens / model.complete       ◀──  stdout
 *   logs and diagnostics                      ◀──  stderr
 * ```
 */
import type { spawn } from "node:child_process";
import {
  ChildBridge,
  HOST_METHODS,
  MAX_FRAME_BYTES,
  MAX_PENDING,
  TOKENIZER_ANSWER,
  readCompleteParams,
  type BridgeLimits,
} from "./bridge-core.js";
import type { HostLlm } from "./host-llm.js";
import type { Logger } from "./service.js";

export const PROTOCOL_VERSION = "agentpkg-host-bridge/0.1";
/** Methods this process may ask the child to perform. */
export const CHILD_METHODS = new Set(["session.begin", "probe.run", "session.end"]);

export { HOST_METHODS, MAX_FRAME_BYTES, MAX_PENDING, TOKENIZER_ANSWER, readCompleteParams };
export type { BridgeLimits };

export const DEFAULT_LIMITS: BridgeLimits = {
  completionTimeoutMs: 120_000,
  sessionTimeoutMs: 180_000,
  maxOutputTokens: 4_096,
};

export type BridgeOptions = {
  agentpkgPath: string;
  /** The exact `host_model_id` this bridge will invoke, from the run plan. */
  modelId: string;
  llm: HostLlm;
  logger: Logger;
  limits?: Partial<BridgeLimits>;
  /** Test seam; defaults to node:child_process.spawn. */
  spawnImpl?: typeof spawn;
};

/** One probe session. Single use: construct, `probe`, discard. */
export class RouterBridge extends ChildBridge {
  constructor(options: BridgeOptions) {
    super({
      agentpkgPath: options.agentpkgPath,
      command: "host-bridge",
      protocolVersion: PROTOCOL_VERSION,
      childMethods: CHILD_METHODS,
      modelId: options.modelId,
      llm: options.llm,
      logger: options.logger,
      limits: { ...DEFAULT_LIMITS, ...(options.limits ?? {}) },
      ...(options.spawnImpl ? { spawnImpl: options.spawnImpl } : {}),
    });
  }

  /** Bind the plan, run the one probe, end cleanly, and return its report. */
  async probe(plan: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.session(async () => {
      const begin = await this.call("session.begin", {
        run_plan: plan,
        limits: { request_timeout_seconds: this.limits.completionTimeoutMs / 1000 },
      });
      const report = await this.call("probe.run", {});
      await this.call("session.end", {});
      return { begin, report };
    });
  }
}
