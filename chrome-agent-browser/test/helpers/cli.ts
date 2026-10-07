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
    await build({
      bundle: true,
      minify: false,
      sourcemap: false,
      logLevel: "silent",
      platform: "node",
      target: ["node24"],
      format: "esm",
      entryPoints: [join(PROJECT, "src", "cli.ts")],
      outfile: path,
    });
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
