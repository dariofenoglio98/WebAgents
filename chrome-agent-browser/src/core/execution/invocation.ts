/**
 * The Run Invocation: the immutable record of *what was asked* (`execution/invocation.py`).
 * A run plan says what may run and with whose authority; the invocation names a plan by
 * identity and hash and freezes exactly one input (and the selected files, by id and hash)
 * beside it. Hashing is RFC 8785 canonical JSON, the one rule every artifact here uses.
 */
import { canonicalJson } from "../canonical.js";
import { ValidationError } from "../errors.js";
import { sha256HexSync } from "../hash.js";
import type { JsonValue } from "../json.js";
import { pyIsoTimestamp } from "../pyjson.js";
import { RUN_INVOCATION_SCHEMA } from "../types.js";
import { ExecutionError, INPUT_INVALID, invalid } from "./errors.js";

export const RUN_INVOCATION_VERSION = "0.2";
/** A workflow input is one task description, not a data transfer. */
export const MAX_INPUT_BYTES = 256 * 1024;
export const MAX_ATTACHMENTS = 16;
export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
export const MEDIA_TYPES = new Set(["application/pdf"]);

export interface Attachment {
  file_id: string;
  sha256: string;
  bytes: number;
  media_type: string;
}

export interface RunInvocationRecord {
  schema: typeof RUN_INVOCATION_SCHEMA;
  run_invocation_version: string;
  run_id: string;
  run_plan_id: string;
  run_plan_sha256: string;
  session_id: string | null;
  package: { package_id: string; version: string; digest: string; archive_sha256: string };
  input_sha256: string;
  input_bytes: number;
  attachments: Attachment[];
  created_at: string;
  note: string;
  run_invocation_sha256: string;
}

function hex64(value: unknown, field: string): string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/u.test(value)) throw invalid(`${field} must be 64 lowercase hex characters`);
  return value;
}

/** The selected files a run was given, as a closed, bounded, path-free list. */
export function normalizeAttachments(raw: unknown): Attachment[] {
  if (raw === null || raw === undefined) return [];
  if (!Array.isArray(raw) || raw.length > MAX_ATTACHMENTS) throw invalid(`attachments must be a list of at most ${MAX_ATTACHMENTS} files`);
  const seen = new Set<string>();
  const records: Attachment[] = [];
  raw.forEach((item, index) => {
    const field = `attachments[${index}]`;
    if (typeof item !== "object" || item === null || Array.isArray(item) || Object.keys(item).sort().join(",") !== "bytes,file_id,media_type,sha256") {
      throw invalid(`${field} must carry exactly file_id, sha256, bytes and media_type`);
    }
    const record = item as Record<string, unknown>;
    const fileId = record.file_id;
    if (typeof fileId !== "string" || !fileId.startsWith("file_") || fileId.length !== 37 || !/^[0-9a-f]{32}$/u.test(fileId.slice(5))) {
      throw invalid(`${field}.file_id must be an opaque host file id`);
    }
    if (seen.has(fileId)) throw invalid(`${field}.file_id is duplicated`);
    seen.add(fileId);
    const size = record.bytes;
    if (typeof size !== "number" || !Number.isInteger(size)) throw invalid(`${field}.bytes must be an integer`);
    if (!(size > 0 && size <= MAX_ATTACHMENT_BYTES)) throw invalid(`${field}.bytes must be a positive size within the file limit`);
    if (typeof record.media_type !== "string" || !MEDIA_TYPES.has(record.media_type)) throw invalid(`${field}.media_type is not a supported selected-file type`);
    records.push({ file_id: fileId, sha256: hex64(record.sha256, `${field}.sha256`), bytes: size, media_type: record.media_type });
  });
  return records.sort((a, b) => (a.file_id < b.file_id ? -1 : a.file_id > b.file_id ? 1 : 0));
}

/** Canonicalize one workflow input, refusing anything oversized or non-finite. */
export function canonicalInput(value: unknown): Uint8Array {
  let data: Uint8Array;
  try {
    data = canonicalJson(value);
  } catch (error) {
    throw new ExecutionError(INPUT_INVALID, `The workflow input is not finite canonical JSON: ${(error as ValidationError).message}`);
  }
  if (data.length > MAX_INPUT_BYTES) {
    throw new ExecutionError(INPUT_INVALID, `The workflow input exceeds ${MAX_INPUT_BYTES} canonical bytes`, { detail: { bytes: data.length, limit: MAX_INPUT_BYTES } });
  }
  return data;
}

export interface InvocationPlanFacts {
  run_plan_id: string;
  run_plan_sha256: string;
  session_id?: string | null;
  package: { package_id: string; version: string; digest: string; archive_sha256: string };
}

/** Freeze one plan plus one input into a hashed, self-describing record. */
export function buildInvocation(options: { run_id: string; plan: InvocationPlanFacts; input: JsonValue; created_at?: Date; attachments?: unknown }): RunInvocationRecord {
  if (typeof options.run_id !== "string" || options.run_id.length === 0) throw invalid("run_id must be a non-empty string");
  const data = canonicalInput(options.input);
  const files = normalizeAttachments(options.attachments);
  const record = {
    schema: RUN_INVOCATION_SCHEMA,
    run_invocation_version: RUN_INVOCATION_VERSION,
    run_id: options.run_id,
    run_plan_id: options.plan.run_plan_id,
    run_plan_sha256: options.plan.run_plan_sha256,
    session_id: options.plan.session_id ?? null,
    package: {
      package_id: options.plan.package.package_id,
      version: options.plan.package.version,
      digest: options.plan.package.digest,
      archive_sha256: options.plan.package.archive_sha256,
    },
    input_sha256: sha256HexSync(data),
    input_bytes: data.length,
    attachments: files,
    created_at: pyIsoTimestamp(options.created_at ?? new Date()),
    note: "A run plan binds authority. This binds the task that authority was used for. Neither is a record of what happened; that is the run record.",
  };
  return { ...record, run_invocation_sha256: sha256HexSync(canonicalJson(record)) } as unknown as RunInvocationRecord;
}
