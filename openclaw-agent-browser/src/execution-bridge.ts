/**
 * The host side of the private execution bridge.
 *
 * It is the router bridge's sibling and shares its whole transport, because
 * the properties that matter — closed method sets, bounded frames, fail-closed
 * framing, one child, cancellation that reaches the provider — must not differ
 * between proving a model works and actually running a package on it.
 *
 * Three things are this bridge's own:
 *
 * * **a different protocol version.** `agentpkg-execution/0.1`. A probe parent
 *   and an execution child refuse each other's frames outright, so the two can
 *   never be confused for one another;
 * * **descriptors instead of paths.** The immutable package archive arrives at
 *   the child as fd 3 and the run's artifact directory as fd 4, both opened
 *   here and inherited. No filename crosses the wire in either direction, so
 *   the child can read exactly one file and write into exactly one directory;
 * * **cancellation as a request.** `execution.cancel` reaches the running
 *   workflow, which cancels its workers, which cancels their pending model
 *   calls, which aborts the provider request through the same `AbortSignal`
 *   the probe already used.
 *
 * ```text
 *   this process (Gateway)                                 spawned runner
 *   ──────────────────────                                 ──────────────
 *   execution.begin / run / cancel / end               ──▶  stdin
 *   model.count_tokens / model.complete                 ◀──  stdout
 *   logs and diagnostics                                ◀──  stderr
 *   the leased immutable archive (read-only)            ──▶  fd 3
 *   the run's private artifact directory                ──▶  fd 4
 * ```
 */
import type { spawn } from "node:child_process";
import { closeSync } from "node:fs";
import { ChildBridge, type BridgeLimits } from "./bridge-core.js";
import { AgentBrowserError } from "./errors.js";
import type { HostLlm } from "./host-llm.js";
import type { Logger } from "./service.js";
import type { ToolBroker } from "./tool-broker.js";

export const EXECUTION_PROTOCOL_VERSION = "agentpkg-execution/0.1";
/** Methods this process may ask the runner to perform. */
export const EXECUTION_METHODS = new Set([
  "execution.begin",
  "execution.run",
  "execution.cancel",
  "execution.end",
  "execution.tool_probe",
]);

export const DEFAULT_EXECUTION_LIMITS: BridgeLimits = {
  completionTimeoutMs: 300_000,
  sessionTimeoutMs: 900_000,
  // A workflow node declares its own cap in the graph; this is the ceiling the
  // runner refuses to exceed, never a value it silently lowers a node to.
  maxOutputTokens: 16_000,
};

export type ExecutionBridgeOptions = {
  agentpkgPath: string;
  /** The exact `host_model_id` this run may invoke, from the run plan. */
  modelId: string;
  llm: HostLlm;
  logger: Logger;
  /** The leased archive, opened read-only by the caller. Closed after spawn. */
  packageFd: number;
  /** The run's artifact directory, opened by the caller. Closed after spawn. */
  artifactsFd: number;
  limits?: Partial<BridgeLimits>;
  /**
   * This run's tool authority: exactly the bindings its plan froze.
   *
   * Without one the bridge has no tool vocabulary at all — `tool.call` is not
   * in its inbound method set — so a package that got as far as asking would
   * end the session rather than receive a refusal it might retry.
   */
  broker?: ToolBroker;
  /** Test seam; defaults to node:child_process.spawn. */
  spawnImpl?: typeof spawn;
};

export type ExecutionRequest = {
  run_id: string;
  run_plan: Record<string, unknown>;
  authorization: Record<string, unknown>;
  limits: Record<string, unknown>;
  input: unknown;
  host: Record<string, unknown>;
};

/** One execution session. Single use: construct, `run`, discard. */
export class ExecutionBridge extends ChildBridge {
  private begun = false;
  private cancelRequested = false;
  private cancelSent = false;

  constructor(options: ExecutionBridgeOptions) {
    const fds = [options.packageFd, options.artifactsFd];
    super({
      agentpkgPath: options.agentpkgPath,
      command: "execution-run",
      protocolVersion: EXECUTION_PROTOCOL_VERSION,
      childMethods: EXECUTION_METHODS,
      modelId: options.modelId,
      llm: options.llm,
      logger: options.logger,
      limits: { ...DEFAULT_EXECUTION_LIMITS, ...(options.limits ?? {}) },
      extraFds: fds,
      ...(options.broker ? { broker: options.broker } : {}),
      // A refusal from the runner is a decision, not a transport failure: the
      // package declared something this host will not run, the consent could
      // not be honoured, or the input did not satisfy the package's own schema.
      mapError: (code, message) =>
        code.startsWith("execution_") ||
        code === "tools_not_supported" ||
        code.startsWith("tool_")
          ? new AgentBrowserError(
              "execution_refused",
              "The run was refused",
              `${code}: ${message}`,
            )
          : null,
      afterSpawn: () => {
        // libuv duplicates the descriptors into the child during spawn, so the
        // parent's copies are surplus the moment spawn returns. Closing them
        // here means the leased archive has exactly one reader.
        for (const fd of fds) {
          try {
            closeSync(fd);
          } catch {
            // Already closed, or a test seam that never opened one.
          }
        }
      },
      ...(options.spawnImpl ? { spawnImpl: options.spawnImpl } : {}),
    });
  }

  /** Bind the plan, run the graph, end cleanly, and return both reports. */
  async run(
    request: ExecutionRequest,
  ): Promise<{ begin: Record<string, unknown>; result: Record<string, unknown> }> {
    return this.session(async () => {
      const begin = await this.call("execution.begin", { ...request });
      this.begun = true;
      // A cancellation that arrived while the session was still binding is
      // honoured here rather than lost: the run is stopped before its first
      // node, and still reports an audit.
      if (this.cancelRequested) await this.sendCancel();
      const result = await this.call("execution.run", {});
      await this.call("execution.end", {});
      return { begin, result };
    });
  }

  /**
   * Bind the plan and make exactly one mediated tool call.
   *
   * The same session shape as `run`, with `execution.run` replaced by one
   * `execution.tool_probe`. The child refuses to do both, so this cannot
   * become a quiet way to run a graph.
   */
  async probe(
    request: ExecutionRequest,
    tool: { toolId: string; args: unknown },
  ): Promise<{ begin: Record<string, unknown>; report: Record<string, unknown> }> {
    return this.session(async () => {
      const begin = await this.call("execution.begin", { ...request });
      this.begun = true;
      const report = await this.call("execution.tool_probe", {
        tool_id: tool.toolId,
        args: tool.args,
      });
      await this.call("execution.end", {});
      return { begin, report };
    });
  }

  /**
   * Ask the running workflow to stop. Safe before, during and after a run.
   *
   * This is deliberately a request rather than killing the child: a cancelled
   * run still has an audit, settled usage and artifacts to write, and a killed
   * process would have none of them. The child is killed only if it fails to
   * stop, which `ChildBridge.stop` handles.
   */
  async cancel(): Promise<boolean> {
    this.cancelRequested = true;
    // Before the session is bound there is nothing to address the request to
    // yet, so `run` sends it as soon as there is.
    if (!this.begun) return true;
    return this.sendCancel();
  }

  private async sendCancel(): Promise<boolean> {
    if (this.cancelSent) return false;
    this.cancelSent = true;
    try {
      await this.call("execution.cancel", {});
      return true;
    } catch {
      // A bridge that is already gone has already stopped running anything.
      return false;
    }
  }
}
