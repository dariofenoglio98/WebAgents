/**
 * The files a finished run leaves behind, as named bytes (`agentpkg/artifacts.py`). The writer is
 * the host's (the CLI owns a directory; the extension owns storage); this module owns the rules
 * both share: which names exist, which are reserved, and how a package-declared export becomes
 * bytes. What a package can influence is small: an export's filename, already constrained by the
 * static validator, and an export's value, a data constructor over the final result.
 */
import { ValidationError } from "../errors.js";
import { PROPOSALS_EXPORT_FORMAT } from "../memory/proposals.js";
import type { JsonObject, JsonValue } from "../json.js";
import type { Package } from "../package.js";
import { pyJsonDumps } from "../pyjson.js";
import { evaluate } from "../workflow/values.js";

/** Names the host writes itself; the static validator refuses an export that collides with them. */
export const HOST_RESULT_NAMES: readonly string[] = Object.freeze(["result.json", "audit.json", "usage.json", "provenance.json"]);
/** Refused as an export by the execution host (a host capability limit, not a format rule). */
export const RUN_RECORD_NAME = "run.json";
/** A blunt second stop on a pathological export; the interpreter already validated the result. */
export const MAX_ARTIFACT_BYTES = 64 * 1024 * 1024;

export type ArtifactRecord = readonly [name: string, data: Uint8Array];

/** `json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False) + "\n"`, UTF-8. */
export function encodeJson(value: unknown): Uint8Array {
  return new TextEncoder().encode(`${pyJsonDumps(value, { indent: 2 })}\n`);
}

/**
 * Render one execution report, and its package exports, into named bytes. `result` is a completed
 * run's return value or the `execution_report` a classified failure carried; exports are written
 * only for a completed run, because an export selects from a final output a failed run lacks.
 */
export function artifactRecords(result: JsonObject, pkg: Package | null = null): ArtifactRecord[] {
  const records: ArtifactRecord[] = [["result.json", encodeJson(result)]];
  for (const field of ["audit", "usage", "provenance"]) {
    if (Object.hasOwn(result, field)) records.push([`${field}.json`, encodeJson(result[field])]);
  }
  if (pkg !== null && result.status === "completed") {
    for (const entry of (pkg.graph.exports as JsonValue[] | undefined) ?? []) {
      const record = entry as JsonObject;
      const value = evaluate(record.value!, { result: result.output ?? null });
      let data: Uint8Array;
      if (record.format === "json" || record.format === PROPOSALS_EXPORT_FORMAT) data = encodeJson(value);
      else {
        if (typeof value !== "string") throw new ValidationError("Text exports must select strings");
        data = new TextEncoder().encode(value);
      }
      records.push([String(record.path), data]);
    }
  }
  const names = records.map(([name]) => name.toLowerCase());
  if (new Set(names).size !== names.length) throw new ValidationError("run artifacts would collide on a case-insensitive filesystem");
  for (const [name, data] of records) {
    if (data.length > MAX_ARTIFACT_BYTES) throw new ValidationError(`run artifact ${name} exceeds ${MAX_ARTIFACT_BYTES} bytes`);
  }
  return records;
}

/** Refuse a name the host must never be asked to create (`write_artifacts_fd`'s boundary check). */
export function checkArtifactName(name: string): void {
  if (name.includes("/") || name.includes("\\") || name === "" || name === "." || name === ".." || name.startsWith(".")) {
    throw new ValidationError(`unsafe run artifact name: ${JSON.stringify(name)}`);
  }
}
