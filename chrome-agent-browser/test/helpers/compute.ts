/**
 * The compute engine for tests (compute.v0, D-251): the Node CLI's own `worker_threads` engine over
 * the Worker entry, bundled once per test file into a private temporary directory with esbuild (the
 * TypeScript source cannot be loaded by a Worker directly). The deadline and cancellation tests need
 * the real Worker: an in-process engine could not stop a module that never returns.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { build } from "esbuild";

import { nodeComputeEngine } from "../../src/cli-compute.js";
import { compileModule, ENGINE_ERROR, EngineFault, type ComputeEngine } from "../../src/core/compute/engine.js";
import { runComputeCall } from "../../src/core/compute/worker-body.js";
import { PROJECT } from "./paths.js";

export interface TestEngine {
  engine: ComputeEngine;
  /** A fresh engine over the same Worker script (its own compiled-module cache). */
  fresh(): ComputeEngine;
  dispose(): void;
}

export async function buildTestEngine(): Promise<TestEngine> {
  const directory = mkdtempSync(join(tmpdir(), "agent-browser-compute-"));
  const script = join(directory, "compute-worker.js");
  await build({ bundle: true, minify: false, sourcemap: false, logLevel: "silent", platform: "node", target: ["node24"], format: "esm", entryPoints: [join(PROJECT, "src", "compute-worker-node.ts")], outfile: script });
  const url = pathToFileURL(script);
  return { engine: nodeComputeEngine(url), fresh: () => nodeComputeEngine(url), dispose: () => rmSync(directory, { recursive: true, force: true }) };
}

/**
 * The call body run in this process, for tests that run a package with modules and never need a
 * call stopped from outside (no Worker, so no deadline and no cancel inside a call). The workflow
 * helpers default to it; the engine tests and the deadline tests use the Worker engine above.
 */
export function inProcessComputeEngine(): ComputeEngine {
  const compiled = new Map<string, WebAssembly.Module>();
  return {
    id: `node/${process.version}`,
    metersFuel: false,
    async compile(sha256, data) {
      if (!compiled.has(sha256)) compiled.set(sha256, await compileModule(data));
    },
    async call(sha256, fn, data, _limits, signal) {
      if (signal.aborted) throw signal.reason;
      const module = compiled.get(sha256);
      if (module === undefined) throw new EngineFault("the module was not compiled before the call");
      const answer = runComputeCall(module, fn, data);
      if (answer.ok) return { output: new Uint8Array(answer.output), reason: null, trap_code: null, detail: null, memory_pages: answer.memory_pages, elapsed_ms: answer.elapsed_ms, fuel_consumed: null };
      if (answer.reason === ENGINE_ERROR) throw new EngineFault("the engine failed during the call");
      return { output: null, reason: answer.reason, trap_code: answer.trap_code ?? null, detail: answer.detail ?? null, memory_pages: answer.memory_pages, elapsed_ms: answer.elapsed_ms, fuel_consumed: null };
    },
  };
}
