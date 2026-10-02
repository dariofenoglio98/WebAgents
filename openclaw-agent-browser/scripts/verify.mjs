#!/usr/bin/env node
/**
 * Reproducible evidence for the Agent Browser plugin milestone.
 *
 * Builds the plugin, validates it, packs an artifact, installs that artifact
 * into a throwaway OpenClaw configuration, and reports what the host loaded.
 * It never touches the operator's real OpenClaw config or state.
 */
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OPENCLAW = join(ROOT, "node_modules", ".bin", "openclaw");

async function openclaw(args, env = {}) {
  const { stdout } = await run(OPENCLAW, args, {
    cwd: ROOT,
    env: { PATH: process.env.PATH, HOME: env.HOME ?? process.env.HOME, NO_COLOR: "1", ...env },
    maxBuffer: 32 * 1024 * 1024,
  });
  return stdout;
}

async function main() {
  const report = { passed: true, host: {}, build: {}, install: {}, tests: {} };
  // The pinned devDependency that builds, validates and installs the artifact
  // below; a globally installed OpenClaw is neither needed nor consulted.
  report.host.openclawVersion = (await openclaw(["--version"])).trim();

  await run("npx", ["tsc", "-p", "tsconfig.json"], { cwd: ROOT, maxBuffer: 32 * 1024 * 1024 });
  await openclaw(["plugins", "build"]);
  const validation = JSON.parse(await openclaw(["plugins", "validate", "--json"]));
  if (!validation.valid) throw new Error("plugin validation failed");
  report.build = { valid: validation.valid, pluginId: validation.pluginId };

  const artifact = join(ROOT, "agent-browser.tgz");
  await rm(artifact, { force: true });
  const packed = JSON.parse(await openclaw(["plugins", "pack", "--json"]));
  report.build.artifact = { sha256: packed.sha256, bytes: packed.bytes };

  const state = await mkdtemp(join(tmpdir(), "agent-browser-verify-"));
  try {
    const configPath = join(state, "openclaw.json");
    await writeFile(configPath, JSON.stringify({ gateway: { port: 1 } }));
    const env = {
      HOME: state,
      OPENCLAW_STATE_DIR: join(state, "state"),
      OPENCLAW_CONFIG_PATH: configPath,
      OPENCLAW_HOME: state,
    };
    await openclaw(
      ["plugins", "install", packed.path, "--force", "--accept-capabilities"],
      env,
    );
    const inspected = JSON.parse(await openclaw(["plugins", "inspect", "agent-browser", "--json"], env))
      .plugin;
    report.install = {
      isolatedConfig: true,
      status: inspected.status,
      activated: inspected.activated,
      version: inspected.version,
      builtWithOpenClawVersion: inspected.builtWithOpenClawVersion,
      // No agent-callable tool in this milestone.
      toolNames: inspected.toolNames,
      httpRoutes: inspected.httpRoutes,
      controlUiEntry: Boolean(inspected.controlUi?.entry),
      configProperties: Object.keys(inspected.configJsonSchema?.properties ?? {}),
    };
    if (inspected.status !== "loaded" || inspected.activated !== true) {
      throw new Error(`plugin did not load: ${inspected.status}`);
    }
    if ((inspected.toolNames ?? []).length > 0) throw new Error("unexpected agent tool");
  } finally {
    await rm(state, { recursive: true, force: true });
  }

  const resultsPath = join(ROOT, "vitest-report.json");
  await rm(resultsPath, { force: true });
  await run("npx", ["vitest", "run", "--reporter=json", `--outputFile=${resultsPath}`], {
    cwd: ROOT,
    maxBuffer: 64 * 1024 * 1024,
  }).catch(() => undefined);
  const results = JSON.parse(await readFile(resultsPath, "utf8"));
  await rm(resultsPath, { force: true });
  report.tests = {
    numTotalTests: results.numTotalTests,
    numPassedTests: results.numPassedTests,
    numFailedTests: results.numFailedTests,
  };
  if (results.numFailedTests > 0) throw new Error("plugin tests failed");

  console.log(JSON.stringify(report, null, 2));
}

main().catch((error) => {
  console.error(`verify failed: ${error.message}`);
  process.exitCode = 1;
});
