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
import type { ComputeEngine } from "../../src/core/compute/engine.js";
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
