/**
 * The reader test package (T6): `test/fixtures/reader-package/`, a minimal `workflow.v0` source
 * tree whose one tool is `paper-reader` (`paper.read`) with Literature Review 0.2.5's own reader
 * schemas byte for byte (so the host's pinned contract digests match; `files.test.ts` checks the
 * copies), and a graph that reads the document the task names and outputs its pages. It calls no
 * model. Not a shipped artifact: it exists so a picked PDF can be followed from Settings → Files
 * through a run's invocation, the broker, the parser and the audit, here in memory under a fresh
 * test key, and in a real Chrome by `scripts/e2e-paper-reader.mjs` (built and signed there with
 * agentpkg under a throwaway key).
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import { canonicalJson } from "../../src/core/canonical.js";
import { sha256HexSync } from "../../src/core/hash.js";
import { loadPackageBytes } from "../../src/core/package.js";
import { generateKeyPair, signedArchive } from "./keys.js";
import { PROJECT } from "./paths.js";

export const READER_URL = "https://reader.example/reader.agent.pkg";
export const READER_SOURCE = join(PROJECT, "test", "fixtures", "reader-package");

function walk(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

/** The source tree's members, JSON canonicalized as a build writes them. */
export function readerSource(): Map<string, Uint8Array> {
  const files = new Map<string, Uint8Array>();
  for (const path of walk(READER_SOURCE).sort()) {
    const name = relative(READER_SOURCE, path).split("\\").join("/");
    const data = new Uint8Array(readFileSync(path));
    files.set(name, name.endsWith(".json") || name === "MANIFEST.agent" ? canonicalJson(JSON.parse(new TextDecoder().decode(data))) : data);
  }
  return files;
}

export async function readerPackage(): Promise<{ bytes: Uint8Array; fingerprint: string; digest: string }> {
  const key = await generateKeyPair();
  const bytes = await signedArchive(readerSource(), key);
  const pkg = await loadPackageBytes(bytes);
  return { bytes, fingerprint: key.fingerprint, digest: pkg.digest };
}

export function sha(bytes: Uint8Array): string {
  return sha256HexSync(bytes);
}
