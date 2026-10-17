/**
 * The agent.pkg container, mirroring `agentpkg/package.py` rule for rule.
 *
 * An artifact is a standalone, single-disk ZIP_STORED archive: no prefix, suffix or
 * comments, no compression, encryption, directory entries, ZIP64, extra fields, data
 * descriptors, gaps between members, symlinks, special files or executable modes. Paths are
 * portable ASCII with the spec's character, case-collision and prefix-collision rules, the
 * payload is UTF-8 text in a short list of data formats, and every `.json` member and
 * `MANIFEST.agent` must be strict, canonicalizable JSON. The two generated envelope members
 * (`integrity.json`, optionally `signatures/publisher.json`) are parsed, schema-checked and
 * removed before the payload is hashed and compared with the integrity statement.
 *
 * No ZIP library enforces this layout, so the reader is written here against the format
 * rather than against a library's leniency. Structural, portability and resource failures
 * throw `ValidationError`; a payload that contradicts its own integrity statement throws the
 * narrower `IntegrityError`, which is how the control plane separates its container and
 * integrity layers.
 */
import { canonicalJson, canonicalString } from "./canonical.js";
import { crc32 } from "./crc32.js";
import { IntegrityError, ValidationError } from "./errors.js";
import { bytesEqual, sha256Hex } from "./hash.js";
import { hasWasmHeader, MAX_MODULE_BYTES } from "./compute/module.js";
import { decodeUtf8, isJsonObject, parseJson, type JsonObject } from "./json.js";
import { pyBytesRepr, pyRepr } from "./repr.js";
import { validateDocument } from "./schema.js";

export const MAX_FILES = 256;
export const MAX_MEMBER_BYTES = 8 * 1024 * 1024;
export const MAX_TOTAL_BYTES = 32 * 1024 * 1024;
/** The container limit plus the ZIP envelope slack `_archive_files` allows. */
export const MAX_ARCHIVE_BYTES = MAX_TOTAL_BYTES + MAX_FILES * 1024;
export const INTEGRITY_PATH = "integrity.json";
export const SIGNATURE_PATH = "signatures/publisher.json";
export const ENVELOPE: ReadonlySet<string> = new Set([INTEGRITY_PATH, SIGNATURE_PATH]);
export const ALLOWED_SUFFIXES: ReadonlySet<string> = new Set([".json", ".md", ".txt", ".bib", ".csv"]);
/**
 * compute.v0 (C-11): the one binary member class, a WebAssembly core module. It is admitted by its
 * header, bounded, and must be declared in the graph with its SHA-256; the graph's reader then
 * decides whether it is a tier-1 module (`compute/`).
 */
export const BINARY_SUFFIXES: ReadonlySet<string> = new Set([".wasm"]);
export const PORTABLE_PATH = /^[A-Za-z0-9_-][A-Za-z0-9_.-]*(?:\/[A-Za-z0-9_-][A-Za-z0-9_.-]*)*$/u;

const WINDOWS_RESERVED: ReadonlySet<string> = new Set([
  "CON",
  "PRN",
  "AUX",
  "NUL",
  ...Array.from({ length: 9 }, (_, index) => `COM${index + 1}`),
  ...Array.from({ length: 9 }, (_, index) => `LPT${index + 1}`),
]);
const FORBIDDEN_COMPONENTS: ReadonlySet<string> = new Set(["node_modules", "venv", "__pycache__", "id_rsa", "id_ed25519"]);
const CREDENTIAL_PATH = /(?:^|[/_.-])(?:private[-_]?key|secrets?|credentials)(?:[/_.-]|$)/iu;
const CREDENTIAL_CONTENT = /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----|\b(?:sk-proj-|sk-ant-)[A-Za-z0-9_-]{12,}/u;

const LOCAL_HEADER = 0x04034b50;
const CENTRAL_HEADER = 0x02014b50;
const END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const ZIP64_LOCATOR = 0x07064b50;
const ZIP64_END_OF_CENTRAL_DIRECTORY = 0x06064b50;
/** General-purpose flag bits: 3 (data descriptor), 0 (encryption), 5 and 6 are refused by name; 11 (UTF-8 names) is the only accepted bit. */
const FLAG_ENCRYPTED = 0x1;
const FLAG_DATA_DESCRIPTOR = 0x8;
const FLAG_COMPRESSED_PATCH = 0x20;
const FLAG_STRONG_ENCRYPTION = 0x40;
const FLAG_UTF8_NAMES = 0x800;
const S_IFMT = 0o170000;
const S_IFREG = 0o100000;

export type Files = Map<string, Uint8Array>;

export interface ArchiveContents {
  /** Payload members in archive order, without the envelope. */
  readonly files: Files;
  readonly integrity: JsonObject;
  readonly signature: JsonObject | null;
}

/** `PurePosixPath(name).suffix.lower()` for an already portable path. */
function suffix(name: string): string {
  const last = name.slice(name.lastIndexOf("/") + 1);
  const dot = last.lastIndexOf(".");
  return dot > 0 ? last.slice(dot).toLowerCase() : "";
}

/** `package.py::_safe_name`. */
export function safeName(name: string): void {
  if (name.length > 240 || !PORTABLE_PATH.test(name)) {
    throw new ValidationError(`unsafe/nonportable package path: ${pyRepr(name)}`);
  }
  for (const part of name.split("/")) {
    if (part.endsWith(".") || WINDOWS_RESERVED.has(part.split(".")[0]!.toUpperCase())) {
      throw new ValidationError(`nonportable reserved path component: ${pyRepr(part)}`);
    }
    if (FORBIDDEN_COMPONENTS.has(part.toLowerCase())) {
      throw new ValidationError(`forbidden package directory/file: ${pyRepr(part)}`);
    }
  }
  if (name !== "MANIFEST.agent" && !ALLOWED_SUFFIXES.has(suffix(name)) && !BINARY_SUFFIXES.has(suffix(name))) {
    throw new ValidationError(`${name}: only declared UTF-8 data formats allowed, never executable payloads`);
  }
  if (CREDENTIAL_PATH.test(name)) {
    throw new ValidationError(`${name}: private credentials must remain outside the package`);
  }
}

/** `package.py::_check_payload`. */
export async function checkPayload(files: ReadonlyMap<string, Uint8Array>, options: { envelope?: boolean } = {}): Promise<void> {
  const limit = options.envelope ? MAX_FILES + ENVELOPE.size : MAX_FILES;
  if (files.size === 0 || files.size > limit) {
    throw new ValidationError(`package must contain 1..${MAX_FILES} files`);
  }
  const seen = new Set<string>();
  const spellings = new Map<string, string>();
  let total = 0;
  for (const [name, data] of files) {
    safeName(name);
    const lower = name.toLowerCase();
    const parts = name.split("/");
    for (let index = 1; index <= parts.length; index += 1) {
      const spelling = parts.slice(0, index).join("/");
      const folded = spelling.toLowerCase();
      const previous = spellings.get(folded);
      if (previous !== undefined && previous !== spelling) {
        throw new ValidationError(`case-colliding path component: ${spelling}`);
      }
      spellings.set(folded, spelling);
    }
    if (seen.has(lower)) throw new ValidationError(`case-colliding package member: ${name}`);
    seen.add(lower);
    const lowerParts = lower.split("/");
    for (let index = 1; index < lowerParts.length; index += 1) {
      if (seen.has(lowerParts.slice(0, index).join("/"))) {
        throw new ValidationError(`file/directory package path collision: ${name}`);
      }
    }
    for (const prior of seen) {
      if (prior.startsWith(`${lower}/`)) throw new ValidationError(`file/directory package path collision: ${name}`);
    }
    if (data.length > MAX_MEMBER_BYTES) {
      throw new ValidationError(`${name}: exceeds ${MAX_MEMBER_BYTES} byte member limit`);
    }
    total += data.length;
    if (total > MAX_TOTAL_BYTES) throw new ValidationError(`package exceeds ${MAX_TOTAL_BYTES} byte expanded limit`);
    let content: string;
    if (BINARY_SUFFIXES.has(suffix(name))) {
      if (data.length > MAX_MODULE_BYTES) throw new ValidationError(`${name}: a WebAssembly module is at most ${MAX_MODULE_BYTES} bytes`);
      if (!hasWasmHeader(data)) throw new ValidationError(`${name}: not a WebAssembly core module (magic number and version 1)`);
      // The credential scan below reads the bytes as text (Latin-1, as the reference does); a module is never decoded.
      content = Array.from(data, (byte) => String.fromCharCode(byte)).join("");
    } else {
      content = decodeUtf8(data, name);
      if (content.includes("\u0000")) throw new ValidationError(`${name}: NUL bytes are not allowed`);
    }
    if (CREDENTIAL_CONTENT.test(content)) {
      throw new ValidationError(`${name}: apparent private key or API credential in payload`);
    }
    if (name.endsWith(".json") || name === "MANIFEST.agent") canonicalJson(parseJson(data, name));
  }
}

/** `package.py::integrity_statement`: every payload member hashed, in sorted order. */
export async function integrityStatement(files: ReadonlyMap<string, Uint8Array>): Promise<JsonObject> {
  const hashes: JsonObject = {};
  for (const name of [...files.keys()].sort()) hashes[name] = await sha256Hex(files.get(name)!);
  return { format: "agent.pkg-integrity-v0.1", files: hashes };
}

interface CentralRecord {
  nameBytes: Uint8Array;
  name: string;
  flags: number;
  method: number;
  crc: number;
  compressedSize: number;
  size: number;
  extraLength: number;
  commentLength: number;
  diskNumberStart: number;
  internalAttributes: number;
  externalAttributes: number;
  headerOffset: number;
}

function invalidZip(reason: string): ValidationError {
  return new ValidationError(`invalid ZIP artifact: ${reason}`);
}

function decodeName(bytes: Uint8Array, flags: number): string {
  if (flags & FLAG_UTF8_NAMES) {
    try {
      return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    } catch {
      throw invalidZip("member name is not UTF-8");
    }
  }
  // `zipfile` decodes as cp437 here; every byte above 0x7f becomes a non-ASCII character
  // either way, and the portable-path rule refuses it, so the exact mapping is immaterial.
  let out = "";
  for (const byte of bytes) out += String.fromCharCode(byte);
  return out;
}

/** `package.py::_archive_payload` over bytes already in memory (`read_archive_bytes`). */
export async function readArchiveBytes(raw: Uint8Array): Promise<ArchiveContents> {
  if (!(raw instanceof Uint8Array)) throw new ValidationError("archive bytes expected");
  if (raw.length > MAX_ARCHIVE_BYTES) throw new ValidationError("archive exceeds total size limit");
  const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  const u16 = (offset: number) => view.getUint16(offset, true);
  const u32 = (offset: number) => view.getUint32(offset, true);
  if (
    raw.length > MAX_ARCHIVE_BYTES ||
    raw.length < 22 ||
    u32(0) !== LOCAL_HEADER ||
    u32(raw.length - 22) !== END_OF_CENTRAL_DIRECTORY
  ) {
    throw new ValidationError("artifact must be a standalone ZIP without prefix, suffix, or comments");
  }
  const end = raw.length - 22;
  const disk = u16(end + 4);
  const directoryDisk = u16(end + 6);
  const entriesOnDisk = u16(end + 8);
  const entriesTotal = u16(end + 10);
  const directorySize = u32(end + 12);
  const directoryOffset = u32(end + 16);
  const commentLength = u16(end + 20);
  if (
    disk !== 0 ||
    directoryDisk !== 0 ||
    entriesOnDisk !== entriesTotal ||
    commentLength !== 0 ||
    directorySize + directoryOffset !== raw.length - 22
  ) {
    throw new ValidationError("split, extended, or noncanonical ZIP directory unsupported");
  }
  // `zipfile._EndRecData64`: the 20 bytes before the end record are read as a ZIP64
  // locator when they carry its signature, and a multi-disk locator is refused there. In
  // this layout those bytes belong to the last central record, so the same bytes must give
  // the same verdict; a ZIP64 end record, which the format forbids, is refused outright.
  if (raw.length >= 42 && u32(end - 20) === ZIP64_LOCATOR) {
    if (u32(end - 16) !== 0 || u32(end - 4) > 1) throw invalidZip("zipfiles that span multiple disks are not supported");
    if (raw.length >= 98 && u32(end - 76) === ZIP64_END_OF_CENTRAL_DIRECTORY) throw new ValidationError("ZIP64 archives unsupported");
  }

  // The central directory, as `zipfile.infolist()` would report it.
  const records: CentralRecord[] = [];
  let position = directoryOffset;
  const directoryEnd = directoryOffset + directorySize;
  for (let index = 0; index < entriesTotal; index += 1) {
    if (position + 46 > directoryEnd || u32(position) !== CENTRAL_HEADER) {
      throw invalidZip("Bad magic number for central directory");
    }
    const flags = u16(position + 8);
    const nameLength = u16(position + 28);
    const extraLength = u16(position + 30);
    const entryCommentLength = u16(position + 32);
    const nameStart = position + 46;
    if (nameStart + nameLength + extraLength + entryCommentLength > directoryEnd) {
      throw invalidZip("truncated central directory");
    }
    const nameBytes = raw.slice(nameStart, nameStart + nameLength);
    records.push({
      nameBytes,
      name: decodeName(nameBytes, flags),
      flags,
      method: u16(position + 10),
      crc: u32(position + 16),
      compressedSize: u32(position + 20),
      size: u32(position + 24),
      extraLength,
      commentLength: entryCommentLength,
      diskNumberStart: u16(position + 34),
      internalAttributes: u16(position + 36),
      externalAttributes: u32(position + 38),
      headerOffset: u32(position + 42),
    });
    position = nameStart + nameLength + extraLength + entryCommentLength;
  }
  if (position !== directoryEnd) throw invalidZip("central directory size disagrees with its records");
  if (records.length > MAX_FILES + ENVELOPE.size) throw new ValidationError("archive member count exceeds limit");

  const files: Files = new Map();
  let expectedOffset = 0;
  let total = 0;
  for (const info of [...records].sort((a, b) => a.headerOffset - b.headerOffset)) {
    if (info.headerOffset !== expectedOffset || info.extraLength || info.commentLength || info.flags & FLAG_DATA_DESCRIPTOR) {
      throw new ValidationError("ZIP gaps, extra fields, entry comments, and data descriptors unsupported");
    }
    // The reference ignores these two fields; a canonical builder writes zero to both, and a
    // nonzero value is where a multi-disk marker could be smuggled in (see `ZIP64_LOCATOR`).
    if (info.diskNumberStart !== 0 || info.internalAttributes !== 0) {
      throw new ValidationError("noncanonical ZIP central directory record: disk number or internal attributes set");
    }
    const header = info.headerOffset;
    if (header + 30 > raw.length) throw new ValidationError("truncated ZIP local header");
    const localNameLength = u16(header + 26);
    const localExtraLength = u16(header + 28);
    if (
      u32(header) !== LOCAL_HEADER ||
      localExtraLength !== 0 ||
      u32(header + 18) !== info.compressedSize ||
      u32(header + 22) !== info.size
    ) {
      throw new ValidationError("inconsistent ZIP local header or extra fields");
    }
    expectedOffset += 30 + localNameLength + info.compressedSize;
    const name = info.name;
    safeName(name);
    if (name.includes("\u0000") || name.endsWith("/") || files.has(name)) {
      throw new ValidationError(`duplicate, NUL, or directory archive member: ${name}`);
    }
    const mode = info.externalAttributes >>> 16;
    const format = mode & S_IFMT;
    if ((format !== 0 && format !== S_IFREG) || mode & 0o111) {
      throw new ValidationError(`${name}: symlink, special or executable archive member forbidden`);
    }
    if (info.flags & FLAG_ENCRYPTED || info.method !== 0) {
      throw new ValidationError(`${name}: encrypted/compressed members unsupported; use ZIP_STORED`);
    }
    total += info.size;
    if (info.size > MAX_MEMBER_BYTES || total > MAX_TOTAL_BYTES) {
      throw new ValidationError(`${name}: archive resource limit exceeded`);
    }
    // What `archive.open(info)` checks before handing the bytes back, in its order.
    if (info.flags & FLAG_COMPRESSED_PATCH) throw invalidZip("compressed patched data (flag bit 5)");
    if (info.flags & FLAG_STRONG_ENCRYPTION) throw invalidZip("strong encryption (flag bit 6)");
    // The reference reads past any other flag bit; this reader accepts only the UTF-8 name bit.
    if (info.flags & ~(FLAG_UTF8_NAMES | FLAG_ENCRYPTED | FLAG_DATA_DESCRIPTOR | FLAG_COMPRESSED_PATCH | FLAG_STRONG_ENCRYPTION)) {
      throw new ValidationError(`${name}: unsupported ZIP general-purpose flag bits 0x${info.flags.toString(16)}`);
    }
    const localName = raw.slice(header + 30, header + 30 + localNameLength);
    if (!bytesEqual(localName, info.nameBytes)) {
      throw invalidZip(`File name in directory ${pyRepr(info.name)} and header ${pyBytesRepr(localName)} differ.`);
    }
    const dataStart = header + 30 + localNameLength;
    const dataEnd = dataStart + info.compressedSize;
    if (dataEnd > raw.length) throw invalidZip("truncated member data");
    if (info.compressedSize !== info.size) throw invalidZip("stored member sizes differ");
    const data = raw.slice(dataStart, dataEnd);
    if (crc32(data) !== info.crc) throw invalidZip(`Bad CRC-32 for file ${pyRepr(name)}`);
    files.set(name, data);
  }
  if (expectedOffset !== directoryOffset) throw new ValidationError("archive directory layout is inconsistent");

  await checkPayload(files, { envelope: true });
  const integrityBytes = files.get(INTEGRITY_PATH);
  if (integrityBytes === undefined) {
    throw new ValidationError("artifact missing generated integrity.json; use agentpkg build");
  }
  const statement = parseJson(integrityBytes, INTEGRITY_PATH);
  files.delete(INTEGRITY_PATH);
  await validateDocument(statement, "integrity", INTEGRITY_PATH);
  let signature: JsonObject | null = null;
  const signatureBytes = files.get(SIGNATURE_PATH);
  if (signatureBytes !== undefined) {
    const parsed = parseJson(signatureBytes, SIGNATURE_PATH);
    files.delete(SIGNATURE_PATH);
    await validateDocument(parsed, "signature", SIGNATURE_PATH);
    signature = parsed as JsonObject;
  }
  await checkPayload(files);
  const expected = await integrityStatement(files);
  if (!isJsonObject(statement) || canonicalString(statement) !== canonicalString(expected)) {
    const declared = isJsonObject(statement) && isJsonObject(statement.files) ? statement.files : {};
    const expectedFiles = expected.files as Record<string, string>;
    const missing = Object.keys(declared).filter((name) => !files.has(name)).sort();
    const extra = [...files.keys()].filter((name) => !Object.hasOwn(declared, name)).sort();
    const changed = [...files.keys()].filter((name) => Object.hasOwn(declared, name) && declared[name] !== expectedFiles[name]);
    throw new IntegrityError(`content integrity mismatch: missing=${pyRepr(missing)}, extra=${pyRepr(extra)}, changed=${pyRepr(changed)}`);
  }
  return { files, integrity: statement, signature };
}
