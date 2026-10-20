/**
 * Build the real CLI once per test file and run it as a child process, so a test exercises
 * `dist/cli.js`'s behaviour (stdout, stderr, exit status) rather than the functions behind it.
 * The bundle goes to a private temporary directory; `npm run build` is not involved.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { build } from "esbuild";

import { PROJECT } from "./paths.js";

export interface CliResult {
  status: number;
  stdout: string;
  stderr: string;
}

export class BuiltCli {
  private constructor(
    readonly directory: string,
    readonly path: string,
  ) {}

  static async build(): Promise<BuiltCli> {
    const directory = mkdtempSync(join(tmpdir(), "agent-browser-cli-"));
    const path = join(directory, "cli.mjs");
    const options = { bundle: true, minify: false, sourcemap: false, logLevel: "silent" as const, platform: "node" as const, target: ["node24"], format: "esm" as const };
    await build({ ...options, entryPoints: [join(PROJECT, "src", "cli.ts")], outfile: path });
    // The CLI's compute Worker (compute.v0, D-251), beside the bundle as `npm run build` places it.
    await build({ ...options, entryPoints: [join(PROJECT, "src", "compute-worker-node.ts")], outfile: join(directory, "compute-worker.js") });
    return new BuiltCli(directory, path);
  }

  run(args: string[], options: { env?: Record<string, string>; timeoutMs?: number; cwd?: string } = {}): CliResult {
    const result = spawnSync(process.execPath, [this.path, ...args], {
      encoding: "utf8",
      timeout: options.timeoutMs ?? 120_000,
      env: { ...process.env, ...(options.env ?? {}) },
      cwd: options.cwd ?? PROJECT,
      maxBuffer: 64 * 1024 * 1024,
    });
    if (result.error) throw result.error;
    return { status: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
  }

  dispose(): void {
    rmSync(this.directory, { recursive: true, force: true });
  }
}
