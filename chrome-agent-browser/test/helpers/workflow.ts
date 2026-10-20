/**
 * Running a package through the interpreter in tests, the way `test_workflow.py::execute`
 * does: the package's own fixture adapters, every permission granted for the session, every
 * declared tool approved, and any option overridden by the caller.
 */
import { fixtureAdapters } from "../../src/core/fixtures.js";
import type { JsonObject, JsonValue } from "../../src/core/json.js";
import type { ModelRequest, ModelResult, ModelRouter } from "../../src/core/models/contract.js";
import type { Package } from "../../src/core/package.js";
import { declaredSchemaPaths } from "../../src/core/presentation.js";
import { deepCopy } from "../../src/core/references.js";
import { PackageSchemas } from "../../src/core/schema.js";
import { CancelledError } from "../../src/core/workflow/errors.js";
import { runWorkflow, Workflow, type WorkflowOptions, type WorkflowResult } from "../../src/core/workflow/interpreter.js";
import { Runtime, type RuntimeOptions } from "../../src/core/workflow/runtime.js";
import { sleep } from "../../src/core/workflow/cancel.js";
import { inProcessComputeEngine } from "./compute.js";

export function sessionGrants(pkg: Package): Record<string, "session"> {
  return Object.fromEntries((pkg.policy.permissions as JsonObject[]).map((permission) => [String(permission.id), "session" as const]));
}

export function execute(pkg: Package, options: WorkflowOptions = {}): Promise<WorkflowResult> {
  const { router, handlers, input } = fixtureAdapters(pkg);
  return runWorkflow(pkg, input, {
    router,
    handlers,
    grants: sessionGrants(pkg),
    // Fixture replay exercises the same enforcement path as a live run, so every declared
    // tool needs its approval here too.
    approvedTools: Object.keys(pkg.tools).sort(),
    // compute.v0 (T22): a package's modules run in this process unless a test passes its own engine.
    compute: inProcessComputeEngine(),
    ...options,
  });
}

export async function executeFailing(pkg: Package, options: WorkflowOptions = {}): Promise<Error & { code?: string; node_id?: string | null; execution_report?: Record<string, unknown> }> {
  try {
    await execute(pkg, options);
  } catch (error) {
    return error as Error & { code?: string; node_id?: string | null; execution_report?: Record<string, unknown> };
  }
  throw new Error("expected the run to fail");
}

/** A `Workflow` instance for tests that need `cancel()`. */
export function createWorkflow(pkg: Package, options: WorkflowOptions = {}): Promise<Workflow> {
  const { router, handlers } = fixtureAdapters(pkg);
  return Workflow.create(pkg, { router, handlers, grants: sessionGrants(pkg), approvedTools: Object.keys(pkg.tools).sort(), compute: inProcessComputeEngine(), ...options });
}

/** A `Runtime` over a package's declared schemas; `close()` releases them. */
export async function openRuntime(pkg: Package, options: RuntimeOptions = {}): Promise<{ runtime: Runtime; close: () => void }> {
  const schemas = await PackageSchemas.open(pkg.files, declaredSchemaPaths(pkg));
  const runtime = new Runtime(pkg, schemas, options);
  return { runtime, close: () => schemas.close() };
}

/** `test_workflow.py::Router`: wraps a router, counts concurrency and cancellations, records requests. */
export class WrappingRouter implements ModelRouter {
  readonly remote: boolean = false;
  readonly capabilities: ReadonlySet<string> = new Set(["reasoning", "structured_output"]);
  readonly context_window = 1_000_000;
  readonly router_id = "test";
  readonly model_id = "test";
  active = 0;
  peak = 0;
  cancelled = 0;
  readonly calls: ModelRequest[] = [];

  constructor(readonly wrapped: ModelRouter) {}

  async countTokens(_request: ModelRequest, _signal: AbortSignal): Promise<number> {
    return 10;
  }

  async complete(request: ModelRequest, maxOutputTokens: number, signal: AbortSignal): Promise<ModelResult> {
    this.calls.push(deepCopy(request as unknown as JsonValue) as unknown as ModelRequest);
    this.active += 1;
    this.peak = Math.max(this.peak, this.active);
    try {
      await abortable(sleep(0.01), signal);
      const output = await this.wrapped.complete(request, maxOutputTokens, signal);
      return { ...output, input_tokens: 10, output_tokens: 10 };
    } catch (error) {
      if (error instanceof CancelledError) this.cancelled += 1;
      throw error;
    } finally {
      this.active -= 1;
    }
  }
}

/** Reject with the signal's reason (a `CancelledError`) as soon as it aborts, as a cancelled asyncio task would. */
export function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

/** `await asyncio.sleep(seconds)` that honours cancellation through the signal. */
export function sleepWithSignal(seconds: number, signal: AbortSignal): Promise<void> {
  return abortable(sleep(seconds), signal);
}
