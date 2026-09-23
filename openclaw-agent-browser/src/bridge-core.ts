/**
 * The host side of a private JSONL bridge to a spawned `agentpkg` child.
 *
 * ```text
 *   this process (Gateway)                       spawned child
 *   ──────────────────────                       ─────────────
 *   one closed set of requests               ──▶  stdin
 *   model.count_tokens / model.complete       ◀──  stdout
 *   logs and diagnostics                      ◀──  stderr
 *   (optionally) inherited descriptors        ──▶  fd 3, fd 4, …
 * ```
 *
 * Two children use this: the router probe, which proves the ModelRouter
 * contract with one host-owned call, and the execution runner, which runs a
 * signed package's own graph. They differ in their protocol version, their
 * method set and what descriptors they inherit — and in nothing else, because
 * the parts that matter here are the parts that must not diverge.
 *
 * A pipe to a child this process spawned has no address, no listener and no
 * credential, which is why it is the transport rather than a local port. Three
 * rules keep it from becoming a general remote-procedure surface:
 *
 * * **the method set is closed, per direction.** There is no generic dispatch
 *   and no fallback handler, so an unexpected method is a protocol violation
 *   rather than something to try;
 * * **the child cannot name a model.** `model.complete` carries content, a
 *   schema and an output cap. The model comes from the run plan this bridge was
 *   constructed with, held here, checked here, and checked again against what
 *   the provider says answered;
 * * **a malformed frame ends the session.** The child is killed rather than
 *   resynchronized, because a desynchronized peer is exactly the state in which
 *   an answer could be attributed to the wrong request.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { AgentBrowserError, clip } from "./errors.js";
import { completeWithBoundModel, type HostLlm } from "./host-llm.js";
import type { Logger } from "./service.js";
import type { ToolBroker } from "./tool-broker.js";

export const MAX_FRAME_BYTES = 1024 * 1024;
export const MAX_PENDING = 16;
/** Methods the child may ask this process to perform. Nothing else exists. */
export const HOST_METHODS = new Set(["model.count_tokens", "model.complete"]);
/** The same set plus the one tool method, for a bridge that brokers tools. */
export const HOST_METHODS_WITH_TOOLS = new Set([...HOST_METHODS, "tool.call"]);
export const CANCEL_METHOD = "$/cancel";

const ID_PATTERN = /^[A-Za-z0-9_.:-]{1,64}$/u;
const MAX_CONTENT_BYTES = 512 * 1024;
const MAX_OUTPUT_TOKENS = 64_000;
const STDERR_KEEP = 4_000;
const CHILD_STOP_GRACE_MS = 2_000;

/**
 * OpenClaw 2026.9.5 publishes no tokenizer a plugin can call. Its own internal
 * estimate is `chars / 4` and is documented as approximate — compaction even
 * applies a 1.2 safety factor to it — so it is not an upper bound and saying
 * "supported" here would silently weaken the runtime's reservation invariant.
 * The child then applies its own provable bound and records that it did.
 */
export const TOKENIZER_ANSWER = {
  supported: false,
  detail:
    "OpenClaw 2026.9.5 exposes no tokenizer to a plugin. Its internal estimate is chars/4 and " +
    "documented as approximate, which is not an upper bound.",
};

export type BridgeLimits = {
  /** Deadline for one `model.complete`, including provider time. */
  completionTimeoutMs: number;
  /** Deadline for the whole child session. */
  sessionTimeoutMs: number;
  /** Hard ceiling on the output cap the child may request. */
  maxOutputTokens: number;
};

export type ChildBridgeOptions = {
  agentpkgPath: string;
  /** The subcommand this child runs, for example `host-bridge`. */
  command: string;
  /** The wire version both peers must carry on every frame. */
  protocolVersion: string;
  /** Requests this process may send. The child's set is `HOST_METHODS`. */
  childMethods: ReadonlySet<string>;
  /** The exact `host_model_id` this bridge will invoke, from the run plan. */
  modelId: string;
  llm: HostLlm;
  logger: Logger;
  limits: BridgeLimits;
  /** Descriptors the child inherits at fd 3, fd 4, … */
  extraFds?: readonly number[];
  /** Called once, synchronously, right after spawn returns; closes those fds. */
  afterSpawn?: () => void;
  /**
   * Turn one refusal the child sent into a typed failure.
   *
   * A child's stable error code is the contract; leaving every one of them as
   * `bridge_failed` would make a package this host cannot run indistinguishable
   * from a broken pipe.
   */
  mapError?: (code: string, message: string) => AgentBrowserError | null;
  /** Test seam; defaults to node:child_process.spawn. */
  spawnImpl?: typeof spawn;
  /**
   * This run's tool authority, or nothing.
   *
   * Absent, `tool.call` is not in the inbound method set at all, so a child
   * that asks for one ends the session rather than being refused per call: a
   * bridge with no broker has no tool vocabulary.
   */
  broker?: ToolBroker;
};

type Frame = Record<string, unknown>;
type Pending = { resolve: (value: Frame) => void; reject: (error: Error) => void };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function violation(detail: string): AgentBrowserError {
  return new AgentBrowserError("bridge_protocol_error", "Bridge protocol error", detail);
}

/**
 * Turn one failure into the (code, message) pair the child receives.
 *
 * The broker encodes its stable code in `detail` as `tool_x: message`, because
 * `AgentBrowserError.code` is the page's vocabulary and the child's is
 * `agentpkg.toolbridge`'s. Splitting it here keeps one word for one fact on
 * both sides instead of translating twice.
 */
export function splitToolFailure(failure: AgentBrowserError): [string, string] {
  const match = /^(tool_[a-z_]+): ([\s\S]*)$/u.exec(failure.detail);
  return match ? [match[1]!, match[2]!] : [failure.code, failure.detail];
}

function text(value: unknown, field: string, limit = MAX_CONTENT_BYTES): string {
  if (typeof value !== "string") throw violation(`${field} must be a string`);
  if (Buffer.byteLength(value) > limit) throw violation(`${field} exceeds ${limit} bytes`);
  return value;
}

/** Accept only the bounded, model-free parameter set `model.complete` defines. */
export function readCompleteParams(
  params: Record<string, unknown>,
  limits: BridgeLimits,
): {
  system: string;
  user: string;
  outputSchema: unknown;
  maxOutputTokens: number;
  reasoning?: string;
} {
  const allowed = new Set(["system", "user", "output_schema", "max_output_tokens", "reasoning"]);
  for (const key of Object.keys(params)) {
    if (!allowed.has(key)) throw violation(`model.complete does not accept ${key}`);
  }
  const maxOutputTokens = params.max_output_tokens;
  if (
    typeof maxOutputTokens !== "number" ||
    !Number.isSafeInteger(maxOutputTokens) ||
    maxOutputTokens <= 0 ||
    maxOutputTokens > Math.min(limits.maxOutputTokens, MAX_OUTPUT_TOKENS)
  ) {
    throw violation("model.complete max_output_tokens is missing or out of range");
  }
  const reasoning = params.reasoning;
  if (reasoning !== undefined && typeof reasoning !== "string") {
    throw violation("model.complete reasoning must be a string");
  }
  return {
    system: text(params.system, "model.complete system"),
    user: text(params.user, "model.complete user"),
    outputSchema: params.output_schema,
    maxOutputTokens,
    ...(typeof reasoning === "string" ? { reasoning } : {}),
  };
}

/** One child session. Single use: construct, drive it, discard. */
export class ChildBridge {
  private child: ChildProcess | null = null;
  private buffer = "";
  private stderrText = "";
  private nextId = 1;
  private readonly pending = new Map<string, Pending>();
  private readonly inbound = new Map<string, AbortController>();
  private readonly seen = new Set<string>();
  protected readonly limits: BridgeLimits;
  private failure: AgentBrowserError | null = null;
  private finished = false;
  /** Every model invocation this bridge made, for the caller's report. */
  readonly completions: Array<{ modelId: string; responseModel: string | null }> = [];

  constructor(protected readonly options: ChildBridgeOptions) {
    this.limits = options.limits;
  }

  /** The child's last stderr, bounded, for a failure message. */
  get stderr(): string {
    return this.stderrText;
  }

  // -- child lifecycle -----------------------------------------------------
  protected start(): void {
    const spawnImpl = this.options.spawnImpl ?? spawn;
    const extra = this.options.extraFds ?? [];
    const child = spawnImpl(this.options.agentpkgPath, [this.options.command], {
      env: { ...process.env, NO_COLOR: "1", PYTHONUNBUFFERED: "1" },
      // Descriptors after stderr are inherited in order, so the child finds
      // them at fd 3, fd 4, … It never learns a path for any of them.
      stdio: ["pipe", "pipe", "pipe", ...extra],
      windowsHide: true,
    });
    this.child = child;
    this.options.afterSpawn?.();
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => this.onData(chunk));
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      this.stderrText = clip(`${this.stderrText}${chunk}`.slice(-STDERR_KEEP), STDERR_KEEP);
    });
    child.on("error", (error: Error) =>
      this.fail(
        new AgentBrowserError(
          "bridge_unavailable",
          "The agentpkg bridge could not be launched",
          error.message,
          true,
        ),
      ),
    );
    child.on("exit", (code, signal) => {
      if (this.finished) return;
      this.fail(
        new AgentBrowserError(
          "bridge_unavailable",
          "The agentpkg bridge exited",
          `The agentpkg bridge exited (${signal ? `signal ${signal}` : `code ${code ?? "unknown"}`}).` +
            (this.stderrText ? ` Last output: ${clip(this.stderrText.trim(), 600)}` : ""),
          true,
        ),
      );
    });
  }

  protected async stop(): Promise<void> {
    this.finished = true;
    const child = this.child;
    this.child = null;
    for (const controller of this.inbound.values()) controller.abort();
    this.inbound.clear();
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    child.stdin?.end();
    const outcome = await Promise.race([exited, delay(CHILD_STOP_GRACE_MS, "timeout" as const)]);
    if (outcome === "timeout") {
      // Cooperative stop did not work; escalate rather than leave it running.
      child.kill("SIGKILL");
      await Promise.race([exited, delay(1_000)]);
    }
  }

  protected fail(error: AgentBrowserError): void {
    this.failure ??= error;
    for (const pending of this.pending.values()) pending.reject(this.failure);
    this.pending.clear();
    for (const controller of this.inbound.values()) controller.abort();
    this.inbound.clear();
    this.child?.kill("SIGKILL");
  }

  /** Run one bounded session: start, drive, always stop. */
  protected async session<T>(drive: () => Promise<T>): Promise<T> {
    const deadline = AbortSignal.timeout(this.limits.sessionTimeoutMs);
    const onTimeout = () =>
      this.fail(
        new AgentBrowserError(
          "bridge_timeout",
          "The agentpkg bridge timed out",
          `The bridge session exceeded ${this.limits.sessionTimeoutMs} ms.`,
          true,
        ),
      );
    deadline.addEventListener("abort", onTimeout, { once: true });
    try {
      this.start();
      return await drive();
    } finally {
      deadline.removeEventListener("abort", onTimeout);
      await this.stop();
    }
  }

  // -- framing -------------------------------------------------------------
  private send(frame: Frame): void {
    const line = `${JSON.stringify(frame)}\n`;
    if (Buffer.byteLength(line) > MAX_FRAME_BYTES) {
      this.fail(violation("Refusing to send an oversized frame"));
      return;
    }
    this.child?.stdin?.write(line);
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    for (;;) {
      const index = this.buffer.indexOf("\n");
      if (index < 0) break;
      const line = this.buffer.slice(0, index);
      this.buffer = this.buffer.slice(index + 1);
      try {
        this.onLine(line);
      } catch (error) {
        this.fail(
          error instanceof AgentBrowserError ? error : violation("Malformed frame from the bridge"),
        );
        return;
      }
    }
    if (Buffer.byteLength(this.buffer) > MAX_FRAME_BYTES) {
      this.fail(violation("The bridge sent an oversized frame"));
    }
  }

  private onLine(line: string): void {
    if (line.trim().length === 0) throw violation("The bridge sent an empty frame");
    let frame: unknown;
    try {
      frame = JSON.parse(line);
    } catch {
      // Any non-frame byte on this stream — a log line, a warning, a traceback —
      // lands here, which is why the child logs to stderr only.
      throw violation("The bridge wrote something other than a protocol frame to stdout");
    }
    if (!isRecord(frame) || frame.v !== this.options.protocolVersion) {
      throw violation("Unsupported frame or protocol version");
    }
    if (frame.method === CANCEL_METHOD) {
      const params = frame.params;
      if (!isRecord(params) || typeof params.id !== "string") {
        throw violation("Malformed cancellation");
      }
      this.inbound.get(params.id)?.abort();
      return;
    }
    if (typeof frame.method === "string") {
      this.accept(frame);
      return;
    }
    const id = frame.id;
    if (typeof id !== "string") throw violation("A response must carry a string id");
    const pending = this.pending.get(id);
    if (!pending) throw violation("Response for an unknown or abandoned request id");
    this.pending.delete(id);
    if (frame.ok === true && isRecord(frame.result)) {
      pending.resolve(frame.result);
      return;
    }
    const error = isRecord(frame.error) ? frame.error : {};
    const code = String(error.code ?? "bridge_error");
    const message = clip(String(error.message ?? ""), 2000);
    pending.reject(
      this.options.mapError?.(code, message) ??
        new AgentBrowserError(
          "bridge_failed",
          "The agentpkg bridge refused an operation",
          `${code}: ${message}`,
        ),
    );
  }

  private accept(frame: Frame): void {
    const id = frame.id;
    const method = frame.method as string;
    if (typeof id !== "string" || !ID_PATTERN.test(id)) throw violation("Malformed request id");
    if (this.seen.has(id)) throw violation("Duplicate inbound request id");
    if (this.inbound.size >= MAX_PENDING) throw violation("Too many inbound bridge requests");
    const permitted = this.options.broker ? HOST_METHODS_WITH_TOOLS : HOST_METHODS;
    if (!permitted.has(method)) throw violation(`Unknown method ${clip(method, 64)}`);
    if (!isRecord(frame.params)) throw violation("Request params must be an object");
    this.seen.add(id);
    const controller = new AbortController();
    this.inbound.set(id, controller);
    const params = frame.params;
    void this.serve(id, method, params, controller).finally(() => this.inbound.delete(id));
  }

  private async serve(
    id: string,
    method: string,
    params: Record<string, unknown>,
    controller: AbortController,
  ): Promise<void> {
    try {
      const result =
        method === "model.count_tokens"
          ? { ...TOKENIZER_ANSWER }
          : method === "tool.call"
            ? ((await this.options.broker!.call(params, controller.signal)) as never)
            : await this.complete(params, controller.signal);
      this.send({ v: this.options.protocolVersion, id, ok: true, result });
    } catch (error) {
      const failure =
        error instanceof AgentBrowserError
          ? error
          : new AgentBrowserError("model_call_failed", "The call failed", "Unhandled error");
      this.options.logger.warn?.("agent-browser: bridge call failed", {
        method,
        code: failure.code,
      });
      // A tool refusal keeps its own stable code, which the child's handler
      // re-raises unchanged. `detail` is already credential-free by
      // construction: nothing in this process puts a secret in one.
      const [code, message] = splitToolFailure(failure);
      this.send({
        v: this.options.protocolVersion,
        id,
        ok: false,
        error: { code, message: clip(message, 2000) },
      });
    }
  }

  private async complete(
    params: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<Record<string, unknown>> {
    const request = readCompleteParams(params, this.limits);
    const timeout = AbortSignal.timeout(this.limits.completionTimeoutMs);
    const outcome = await completeWithBoundModel(this.options.llm, {
      // The binding is this process's, not the child's: the child never names
      // a model, so it cannot ask for one the person did not choose.
      modelId: this.options.modelId,
      system: request.system,
      user: request.user,
      outputSchema: request.outputSchema,
      maxOutputTokens: request.maxOutputTokens,
      ...(request.reasoning ? { reasoning: request.reasoning } : {}),
      signal: AbortSignal.any([signal, timeout]),
    });
    this.completions.push({ modelId: outcome.modelId, responseModel: outcome.responseModel });
    return {
      text: outcome.text,
      model_id: outcome.modelId,
      provider_id: outcome.providerId,
      response_model: outcome.responseModel,
      stop_reason: outcome.stopReason,
      execution: outcome.execution,
      constrained: outcome.constrained,
      constraint_detail: outcome.constraintDetail,
      usage: outcome.usage,
    };
  }

  // -- requests ------------------------------------------------------------
  protected call(method: string, params: Record<string, unknown>): Promise<Frame> {
    if (this.failure) return Promise.reject(this.failure);
    if (!this.options.childMethods.has(method)) {
      return Promise.reject(violation(`Method ${method} is not permitted in this direction`));
    }
    if (this.pending.size >= MAX_PENDING) {
      return Promise.reject(violation("Too many outstanding bridge requests"));
    }
    const id = `h${this.nextId++}`;
    return new Promise<Frame>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.send({ v: this.options.protocolVersion, id, method, params });
    });
  }
}
