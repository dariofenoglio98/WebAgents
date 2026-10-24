/**
 * A loaded package: the `Package` of `agentpkg/package.py`, built from bytes captured once.
 *
 * `loadPackageBytes` runs the container and integrity layers (`archive.ts`) and the schema
 * layer (`validation.ts`) and returns the validated documents, the payload files and the
 * digest. There is no path to reopen: a caller that has bytes has the snapshot. The
 * separate layered report a browser needs is `evaluation.ts`.
 */
import { readArchiveBytes } from "./archive.js";
import { canonicalJson } from "./canonical.js";
import { conversationRecords } from "./conversation/declarations.js";
import { ValidationError } from "./errors.js";
import { sha256Hex } from "./hash.js";
import { parseJson, type JsonObject, type JsonValue } from "./json.js";
import { validatePayload } from "./validation.js";

export interface Package {
  readonly manifest: JsonObject;
  readonly graph: JsonObject;
  readonly policy: JsonObject;
  readonly tools: Readonly<Record<string, JsonObject>>;
  /** Payload members, without the envelope. */
  readonly files: ReadonlyMap<string, Uint8Array>;
  readonly integrity: JsonObject;
  readonly signature: JsonObject | null;
  /** SHA-256 of the canonical integrity statement: the package digest, not the archive hash. */
  readonly digest: string;
}

export async function packageDigest(integrity: JsonObject): Promise<string> {
  return sha256Hex(canonicalJson(integrity));
}

/** `package.py::load_package_bytes`: one verified artifact from bytes. */
export async function loadPackageBytes(data: Uint8Array): Promise<Package> {
  const { files, integrity, signature } = await readArchiveBytes(data);
  const { manifest, graph, policy, tools } = await validatePayload(files);
  return { manifest, graph, policy, tools, files, integrity, signature, digest: await packageDigest(integrity) };
}

/** `Package.json(path)`: a parsed JSON member, or a `ValidationError` when it is missing. */
export function packageJson(pkg: Package, path: string): JsonValue {
  const data = pkg.files.get(path);
  if (data === undefined) throw new ValidationError(`missing package member ${path}`);
  return parseJson(data, path);
}

/** `package.py::permissions_summary`. */
export function permissionsSummary(pkg: Package): JsonObject {
  const summary: JsonObject = { package_id: pkg.manifest.package_id!, version: pkg.manifest.version! };
  for (const key of ["permissions", "network", "memory", "budget", "delegation"]) summary[key] = pkg.policy[key]!;
  return summary;
}

/** `package.py::inspect_package`: metadata without any claim about publisher trust. */
export function inspectPackage(pkg: Package): JsonObject {
  const graph = pkg.graph;
  const result: JsonObject = {
    manifest: pkg.manifest,
    digest: pkg.digest,
    integrity_valid: true,
    signature_present: pkg.signature !== null,
    signature_trust: "not verified by inspect",
    files: [...pkg.files.keys()].sort(),
    workers: graph.workers!,
    execution_profile: graph.profile ?? "legacy-host-entrypoint",
  };
  if ("nodes" in graph) result.nodes = graph.nodes!;
  else result.stages = graph.stages ?? [];
  // conversation.v0: the turns, the persistent keys and the consent steps, where declared (V-20).
  const conversation = conversationRecords(pkg);
  if (conversation !== null) result.conversation = conversation;
  return result;
}
