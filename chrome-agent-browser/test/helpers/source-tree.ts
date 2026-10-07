/**
 * A package source tree under `agents/<name>` as in-memory payload files, the way the Python
 * suite copies one into `tmp_path` and edits it (`test_workflow.py::source`, `change`). Shipped
 * sources are never modified on disk; variants are built in memory.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import { canonicalJson } from "../../src/core/canonical.js";
import { parseJson, type JsonObject, type JsonValue } from "../../src/core/json.js";
import { loadPackageBytes, type Package } from "../../src/core/package.js";
import { ROOT } from "./paths.js";
import { archiveBytes } from "./zip.js";

export type Files = Map<string, Uint8Array>;

function* walk(directory: string): Generator<string> {
  for (const name of readdirSync(directory).sort()) {
    if (name === ".DS_Store") continue;
    const path = join(directory, name);
    if (statSync(path).isDirectory()) yield* walk(path);
    else yield path;
  }
}

/** `agents/<name>` as payload files keyed by their package-relative POSIX path. */
export function sourceTree(name: string): Files {
  const base = join(ROOT, "agents", name);
  const files: Files = new Map();
  for (const path of walk(base)) files.set(relative(base, path).split("\\").join("/"), new Uint8Array(readFileSync(path)));
  return files;
}

export function readJsonFile(files: Files, path: string): JsonValue {
  return JSON.parse(new TextDecoder().decode(files.get(path)!)) as JsonValue;
}

/** `test_workflow.py::change`: edit one JSON member in place. */
export function change(files: Files, path: string, operation: (value: JsonObject) => void): void {
  const value = readJsonFile(files, path) as JsonObject;
  operation(value);
  files.set(path, new TextEncoder().encode(JSON.stringify(value)));
}

/**
 * Build (unsigned) and load the tree as a package. `package.py::build_package` canonicalizes
 * every JSON member (and `MANIFEST.agent`) with JCS and keeps other text verbatim, so the
 * built archive, and therefore its digest, is the shipped one.
 */
export async function loadSource(files: Files): Promise<Package> {
  const built: Files = new Map();
  for (const [name, data] of files) {
    built.set(name, name.endsWith(".json") || name === "MANIFEST.agent" ? canonicalJson(parseJson(data, name)) : data);
  }
  return loadPackageBytes(await archiveBytes(built));
}
