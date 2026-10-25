/**
 * network.v0 test packages (spec/network-v0.md): the probe of every enforcement case, written by the
 * conformance driver from agentpkg's own `network_probe.py` (so both runtimes face the same mutated
 * package and the same generated fixture, whose route cases carry the reference's exact request
 * data), and the shipped travel network's source tree. Built in memory, never on disk under the
 * repository.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

import type { JsonObject } from "../../src/core/json.js";
import { ROOT } from "./paths.js";
import type { Files } from "./source-tree.js";

export const PYTHON = process.env.AGENTPKG_PYTHON ?? join(ROOT, "agentpkg", ".venv", "bin", "python");
export const CASES_PATH = join(ROOT, "examples", "network", "cases", "cases.json");
export const NETWORK_TEST_ARCHIVE = join(ROOT, "examples", "network", "network-test.agent.pkg");
export const NETWORK_TEST_KEY = join(ROOT, "examples", "keys", "network-test-publisher.pub.pem");
export const TRAVEL_SOURCE = join(ROOT, "agents", "travel-network");

export interface NetworkCase {
  id: string;
  title: string;
  stage: "validation" | "grants" | "host" | "run";
  code: string;
  variant?: string;
  reason?: string;
  grants?: Record<string, string>;
  expect?: JsonObject;
}

export function caseList(): NetworkCase[] {
  return (JSON.parse(readFileSync(CASES_PATH, "utf8")) as { cases: NetworkCase[] }).cases;
}

function* walk(directory: string): Generator<string> {
  for (const name of readdirSync(directory).sort()) {
    if (name === ".DS_Store") continue;
    const path = join(directory, name);
    if (statSync(path).isDirectory()) yield* walk(path);
    else yield path;
  }
}

/** A directory as payload files keyed by their package-relative POSIX path. */
export function treeFiles(directory: string): Files {
  const files: Files = new Map();
  for (const path of walk(directory)) files.set(relative(directory, path).split("\\").join("/"), new Uint8Array(readFileSync(path)));
  return files;
}

export interface ProbeCase {
  case: NetworkCase;
  files: Files;
  grants: Record<string, "once" | "session" | "always" | "deny">;
}

let probes: Map<string, ProbeCase> | null = null;

/** Every case's probe, written once per test process by `conformance/drivers/network_probe.py --all`. */
export function probeCases(): Map<string, ProbeCase> {
  if (probes !== null) return probes;
  const scratch = mkdtempSync(join(realpathSync(tmpdir()), "network-probe-"));
  try {
    const result = spawnSync(PYTHON, [join(ROOT, "conformance", "drivers", "network_probe.py"), "--all", scratch], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
    if (result.status !== 0) throw new Error(`network probe driver failed: ${result.stderr}`);
    const written = JSON.parse(result.stdout) as Array<{ source: string; grants: string; case: NetworkCase }>;
    probes = new Map(written.map((entry) => [entry.case.id, { case: entry.case, files: treeFiles(entry.source), grants: JSON.parse(readFileSync(entry.grants, "utf8")) as ProbeCase["grants"] }]));
    return probes;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/** The probe's grants (`network_probe.py::grants`) with overrides. */
export function probeGrants(overrides: Record<string, string> = {}): Record<string, "once" | "session" | "always" | "deny"> {
  return { "model.reasoning": "session", "memory.session": "session", "desk.index": "session", ...overrides } as Record<string, "once" | "session" | "always" | "deny">;
}

/** Run Python over a JSON document and return its JSON answer (cross-runtime arithmetic checks). */
export function python(code: string, input: unknown): unknown {
  const result = spawnSync(PYTHON, ["-c", code], { input: JSON.stringify(input), encoding: "utf8", maxBuffer: 64 * 1024 * 1024, env: { ...process.env, PYTHONPATH: join(ROOT, "agentpkg", "src") } });
  if (result.status !== 0) throw new Error(`python failed: ${result.stderr}`);
  return JSON.parse(result.stdout);
}
