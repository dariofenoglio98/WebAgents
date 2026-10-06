/**
 * A ZIP_STORED writer for tests and for `npm run pack`.
 *
 * By default it writes exactly what `agentpkg/package.py::archive_bytes` writes through
 * Python's `zipfile`: sorted ASCII names, timestamp 1980-01-01 00:00:00, Unix regular-file
 * mode 0644, version 2.0, no comments or extra fields. `test/core/archive.test.ts` asserts
 * that rebuilding the shipped WebAir package from its members reproduces its bytes. The
 * per-entry and per-archive knobs exist so tests can construct the hostile archives the
 * Python suite builds with `zipfile` directly: traversal names, duplicates, compression
 * flags, extra fields, data descriptors, gaps, comments, symlink and executable modes.
 */
import { canonicalJson } from "../../src/core/canonical.js";
import { crc32 } from "../../src/core/crc32.js";
import { concatBytes } from "../../src/core/hash.js";
import { integrityStatement, INTEGRITY_PATH, SIGNATURE_PATH } from "../../src/core/archive.js";
import type { JsonObject } from "../../src/core/json.js";

export interface EntryOptions {
  /** Name written to the headers, when it must differ from the map key. */
  name?: string;
  /** Local header name, when it must differ from the central one. */
  localName?: string;
  method?: number;
  flags?: number;
  externalAttributes?: number;
  extra?: Uint8Array;
  comment?: Uint8Array;
  /** Set the data-descriptor flag (bit 3) without writing one. */
  dataDescriptor?: boolean;
  crc?: number;
  compressedSize?: number;
  size?: number;
  localExtra?: Uint8Array;
  dosTime?: number;
  dosDate?: number;
}

export interface ArchiveOptions {
  prefix?: Uint8Array;
  suffix?: Uint8Array;
  comment?: Uint8Array;
  /** Bytes inserted before the named member's local header. */
  gapBefore?: Record<string, number>;
  /** Keep the given order instead of sorting by name. */
  unsorted?: boolean;
  /** Override the EOCD entry counts. */
  entriesTotal?: number;
  entriesOnDisk?: number;
}

export type Entry = [name: string, data: Uint8Array, options?: EntryOptions];

const VERSION_MADE_BY = 20 | (3 << 8); // zipfile: create_version 20, create_system 3 (Unix)
const VERSION_NEEDED = 20;
const DEFAULT_EXTERNAL = (0o100644 << 16) >>> 0;
const DEFAULT_DATE = 0x21; // 1980-01-01

const encoder = new TextEncoder();

function u16(value: number): Uint8Array {
  const out = new Uint8Array(2);
  new DataView(out.buffer).setUint16(0, value, true);
  return out;
}

function u32(value: number): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value >>> 0, true);
  return out;
}

export function writeZip(entries: Entry[] | Map<string, Uint8Array>, options: ArchiveOptions = {}): Uint8Array {
  const list: Entry[] = entries instanceof Map ? [...entries].map(([name, data]) => [name, data]) : [...entries];
  if (!options.unsorted) list.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const parts: Uint8Array[] = [];
  let offset = 0;
  if (options.prefix) {
    parts.push(options.prefix);
    offset += options.prefix.length;
  }
  const central: Uint8Array[] = [];
  for (const [key, data, entry = {}] of list) {
    const gap = options.gapBefore?.[key] ?? 0;
    if (gap) {
      parts.push(new Uint8Array(gap));
      offset += gap;
    }
    const name = encoder.encode(entry.name ?? key);
    const localName = encoder.encode(entry.localName ?? entry.name ?? key);
    const flags = (entry.flags ?? 0) | (entry.dataDescriptor ? 8 : 0);
    const method = entry.method ?? 0;
    const crc = entry.crc ?? crc32(data);
    const compressedSize = entry.compressedSize ?? data.length;
    const size = entry.size ?? data.length;
    const localExtra = entry.localExtra ?? new Uint8Array();
    const extra = entry.extra ?? new Uint8Array();
    const comment = entry.comment ?? new Uint8Array();
    const dosTime = entry.dosTime ?? 0;
    const dosDate = entry.dosDate ?? DEFAULT_DATE;
    const local = concatBytes(
      u32(0x04034b50),
      u16(VERSION_NEEDED),
      u16(flags),
      u16(method),
      u16(dosTime),
      u16(dosDate),
      u32(crc),
      u32(compressedSize),
      u32(size),
      u16(localName.length),
      u16(localExtra.length),
      localName,
      localExtra,
      data,
    );
    central.push(
      concatBytes(
        u32(0x02014b50),
        u16(VERSION_MADE_BY),
        u16(VERSION_NEEDED),
        u16(flags),
        u16(method),
        u16(dosTime),
        u16(dosDate),
        u32(crc),
        u32(compressedSize),
        u32(size),
        u16(name.length),
        u16(extra.length),
        u16(comment.length),
        u16(0),
        u16(0),
        u32(entry.externalAttributes ?? DEFAULT_EXTERNAL),
        u32(offset),
        name,
        extra,
        comment,
      ),
    );
    parts.push(local);
    offset += local.length;
  }
  const directory = concatBytes(...central);
  const comment = options.comment ?? new Uint8Array();
  const end = concatBytes(
    u32(0x06054b50),
    u16(0),
    u16(0),
    u16(options.entriesOnDisk ?? list.length),
    u16(options.entriesTotal ?? list.length),
    u32(directory.length),
    u32(offset),
    u16(comment.length),
    comment,
  );
  parts.push(directory, end);
  if (options.suffix) parts.push(options.suffix);
  return concatBytes(...parts);
}

/** `package.py::archive_bytes`: payload plus the canonical envelope, sorted. */
export async function archiveBytes(files: ReadonlyMap<string, Uint8Array>, signature: JsonObject | null = null): Promise<Uint8Array> {
  const payload = new Map(files);
  payload.set(INTEGRITY_PATH, canonicalJson(await integrityStatement(files)));
  if (signature !== null) payload.set(SIGNATURE_PATH, canonicalJson(signature));
  return writeZip(payload);
}

/** Members of a well-formed archive, read leniently for test setup only. */
export function listMembers(raw: Uint8Array): Map<string, Uint8Array> {
  const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  const end = raw.length - 22;
  const count = view.getUint16(end + 10, true);
  let position = view.getUint32(end + 16, true);
  const files = new Map<string, Uint8Array>();
  for (let index = 0; index < count; index += 1) {
    const nameLength = view.getUint16(position + 28, true);
    const extraLength = view.getUint16(position + 30, true);
    const commentLength = view.getUint16(position + 32, true);
    const size = view.getUint32(position + 24, true);
    const headerOffset = view.getUint32(position + 42, true);
    const name = new TextDecoder().decode(raw.slice(position + 46, position + 46 + nameLength));
    const localNameLength = view.getUint16(headerOffset + 26, true);
    const localExtraLength = view.getUint16(headerOffset + 28, true);
    const start = headerOffset + 30 + localNameLength + localExtraLength;
    files.set(name, raw.slice(start, start + size));
    position += 46 + nameLength + extraLength + commentLength;
  }
  return files;
}
