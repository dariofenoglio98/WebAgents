/**
 * memory.v0 test helpers (T19): the spec's worked examples as import files, the record examples
 * fenced in `spec/memory-v0.md`, and a store opened over one of them under a fixed key.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import type { ImportFile } from "../../src/core/memory/export.js";
import { KEY_BYTES } from "../../src/core/memory/digest.js";
import { emptyMemorySnapshot, MemoryStore } from "../../src/core/memory/store.js";
import { ROOT } from "./paths.js";

export const SPEC = join(ROOT, "spec", "memory-v0.md");
export const CONTRACTS = join(ROOT, "spec", "memory-v0");
export const EXAMPLES = join(CONTRACTS, "examples");
export const WEBAIR_EXAMPLE = join(EXAMPLES, "webair-0.6.0");
export const LITERATURE_EXAMPLE = join(EXAMPLES, "literature-review-0.2.8");
export const MEMORY_KEY = new Uint8Array(KEY_BYTES).map((_, index) => (index * 7) % 256);
export const NOW = new Date("2026-10-14T14:00:00Z");

/** Every file of a folder as `{path, text}`, paths relative to the folder with `/`. */
export function folderFiles(folder: string): ImportFile[] {
  const out: ImportFile[] = [];
  const walk = (directory: string): void => {
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name);
      if (statSync(path).isDirectory()) walk(path);
      else out.push({ path: relative(folder, path).split("\\").join("/"), text: readFileSync(path, "utf8") });
    }
  };
  walk(folder);
  return out;
}

/** The record examples fenced as ```md memory.record in the spec, in order. */
export function specRecords(): string[] {
  const text = readFileSync(SPEC, "utf8");
  const out: string[] = [];
  for (const match of text.matchAll(/^```md memory\.record\n([\s\S]*?)^```/gmu)) out.push(match[1]!);
  return out;
}

export function specExports(): string[] {
  const text = readFileSync(SPEC, "utf8");
  const out: string[] = [];
  for (const match of text.matchAll(/^```md memory\.export\n([\s\S]*?)^```/gmu)) out.push(match[1]!);
  return out;
}

export function readJson<T = unknown>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

let counter = 0;
/** Deterministic fresh ids for tests. */
export function testIds(prefix = 0): () => string {
  counter = 0;
  return () => `mem_${(prefix * 1000 + (counter += 1)).toString(16).padStart(32, "0")}`;
}

/** An empty store under the test key, with a fixed clock. */
export function emptyStore(options: { now?: Date; newId?: () => string } = {}): Promise<MemoryStore> {
  return MemoryStore.open({ key: MEMORY_KEY, snapshot: emptyMemorySnapshot(), now: () => options.now ?? NOW, newId: options.newId ?? testIds() });
}

/** A store holding a worked example's memory folder (sealed values in clear), imported through the folder codec. */
export async function exampleStore(folder: string, options: { now?: Date; newId?: () => string } = {}): Promise<MemoryStore> {
  const store = await emptyStore(options);
  const report = store.planImport(folderFiles(join(folder, "memory")));
  const refused = report.items.filter((item) => item.outcome.kind === "refused" || item.outcome.kind === "incomplete");
  if (refused.length > 0) throw new Error(`example import refused: ${JSON.stringify(refused.map((item) => [item.path, item.outcome]))}`);
  await store.applyImport(report);
  return store;
}
