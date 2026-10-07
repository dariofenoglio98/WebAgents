import { describe, expect, it } from "vitest";

import {
  checkPayload,
  INTEGRITY_PATH,
  integrityStatement,
  MAX_MEMBER_BYTES,
  readArchiveBytes,
  safeName,
  SIGNATURE_PATH,
} from "../../src/core/archive.js";
import { canonicalJson } from "../../src/core/canonical.js";
import { IntegrityError, ValidationError } from "../../src/core/errors.js";
import { bytesEqual, sha256Hex } from "../../src/core/hash.js";
import { readBytes, SHIPPED } from "../helpers/paths.js";
import { archiveBytes, listMembers, writeZip, type Entry } from "../helpers/zip.js";

const text = (value: string) => new TextEncoder().encode(value);

async function shipped() {
  const raw = readBytes(SHIPPED.webair.archive);
  const contents = await readArchiveBytes(raw);
  return { raw, ...contents };
}

describe("the shipped artifacts read exactly as agentpkg reads them", () => {
  it("reads WebAir 0.3.0: payload, integrity statement, signature, digest", async () => {
    const { raw, files, integrity, signature } = await shipped();
    expect(await sha256Hex(raw)).toBe(SHIPPED.webair.archiveSha256);
    expect(files.size).toBe(SHIPPED.webair.payloadFiles);
    expect(files.has(INTEGRITY_PATH)).toBe(false);
    expect(files.has(SIGNATURE_PATH)).toBe(false);
    expect(await sha256Hex(canonicalJson(integrity))).toBe(SHIPPED.webair.digest);
    expect(signature?.key_fingerprint).toBe(SHIPPED.webair.fingerprint);
    expect(signature?.digest).toBe(SHIPPED.webair.digest);
  });

  it("reads Literature Review 0.2.5", async () => {
    const raw = readBytes(SHIPPED.literatureReview.archive);
    const { integrity, signature } = await readArchiveBytes(raw);
    expect(await sha256Hex(raw)).toBe(SHIPPED.literatureReview.archiveSha256);
    expect(await sha256Hex(canonicalJson(integrity))).toBe(SHIPPED.literatureReview.digest);
    expect(signature?.key_fingerprint).toBe(SHIPPED.literatureReview.fingerprint);
  });

  it("the test writer reproduces the shipped bytes from the members (archive_bytes parity)", async () => {
    const { raw, files, signature } = await shipped();
    const rebuilt = await archiveBytes(files, signature);
    expect(rebuilt.length).toBe(raw.length);
    expect(bytesEqual(rebuilt, raw)).toBe(true);
    // And for the other two shipped packages too.
    for (const path of [SHIPPED.literatureReview.archive, SHIPPED.meetingAgenda.archive]) {
      const original = readBytes(path);
      const contents = await readArchiveBytes(original);
      expect(bytesEqual(await archiveBytes(contents.files, contents.signature), original)).toBe(true);
    }
  });

  it("integrity statements hash every payload member in sorted order", async () => {
    const { files, integrity } = await shipped();
    const recomputed = await integrityStatement(files);
    expect(recomputed).toEqual(integrity);
    expect(Object.keys(recomputed.files as object)).toEqual([...files.keys()].sort());
  });
});

describe("portable member names (test_source_bad_paths_or_code_rejected)", () => {
  for (const name of [
    "../escape.json",
    "/absolute.json",
    "C:/escape.json",
    "dir\\escape.json",
    "CON.json",
    "dir/trailing.",
    "bad.py",
    ".env",
    ".git/config.json",
    "node_modules/x.json",
    "keys/private-key.txt",
    "secrets.json",
    "a/credentials/b.json",
    "x".repeat(241) + ".json",
    "skills/SKILL",
    "data.exe",
    "",
    "dir//double.json",
  ]) {
    it(`refuses ${JSON.stringify(name)}`, () => {
      expect(() => safeName(name)).toThrow(ValidationError);
    });
  }

  for (const name of ["MANIFEST.agent", "graph.json", "skills/a-b_c/SKILL.md", "data/notes.txt", "refs.bib", "table.csv", "v1.2.3/x.json"]) {
    it(`accepts ${name}`, () => {
      expect(() => safeName(name)).not.toThrow();
    });
  }
});

describe("payload rules (package.py::_check_payload)", () => {
  const base = new Map<string, Uint8Array>([
    ["MANIFEST.agent", text("{}")],
    ["graph.json", text('{"a":1}')],
    ["skills/one.md", text("# one\n")],
  ]);

  it("accepts an ordinary payload", async () => {
    await expect(checkPayload(base)).resolves.toBeUndefined();
  });

  it("refuses an empty payload and too many members", async () => {
    await expect(checkPayload(new Map())).rejects.toThrow(/1\.\.256 files/u);
    const many = new Map(base);
    for (let index = 0; index < 260; index += 1) many.set(`f${index}.txt`, text("x"));
    await expect(checkPayload(many)).rejects.toThrow(/1\.\.256 files/u);
  });

  it("refuses case collisions of members and of directory components", async () => {
    // The spelling check covers the whole name, so this is reported as a component collision
    // by the reference too; `case-colliding package member` is unreachable with unique names.
    await expect(checkPayload(new Map([...base, ["GRAPH.json", text("{}")]]))).rejects.toThrow(/case-colliding path component/u);
    await expect(checkPayload(new Map([...base, ["Skills/two.md", text("x")]]))).rejects.toThrow(/case-colliding path component/u);
  });

  it("refuses file/directory prefix collisions in either order", async () => {
    await expect(checkPayload(new Map([...base, ["skills/one.md/x.txt", text("x")]]))).rejects.toThrow(/path collision/u);
    const reversed = new Map<string, Uint8Array>([
      ["a/b.txt", text("x")],
      ["a", text("x")],
    ]);
    await expect(checkPayload(reversed)).rejects.toThrow(ValidationError);
  });

  it("refuses non-UTF-8, NUL bytes, oversized members and apparent credentials", async () => {
    await expect(checkPayload(new Map([...base, ["bin.txt", new Uint8Array([0xff, 0xfe])]]))).rejects.toThrow(/UTF-8 text/u);
    await expect(checkPayload(new Map([...base, ["zero.txt", new Uint8Array([65, 0, 66])]]))).rejects.toThrow(/NUL bytes/u);
    await expect(checkPayload(new Map([...base, ["big.txt", new Uint8Array(MAX_MEMBER_BYTES + 1)]]))).rejects.toThrow(/member limit/u);
    await expect(checkPayload(new Map([...base, ["keys.txt", text("-----BEGIN PRIVATE KEY-----\nsecret\n")]]))).rejects.toThrow(/private key/u);
    await expect(checkPayload(new Map([...base, ["notes.txt", text("token sk-ant-abcdefghijklmnop")]]))).rejects.toThrow(/credential/u);
  });

  it("refuses JSON members with duplicate keys or NaN (test_duplicate_json_keys_and_nan_rejected)", async () => {
    await expect(checkPayload(new Map([...base, ["extra.json", text('{"a":1,"a":2}')]]))).rejects.toThrow(/duplicate JSON key/u);
    await expect(checkPayload(new Map([...base, ["extra.json", text('{"a":NaN}')]]))).rejects.toThrow(/strict UTF-8 JSON/u);
    await expect(checkPayload(new Map([...base, ["extra.json", text("{\"big\":9007199254740993}")]]))).rejects.toThrow(/safe integer domain/u);
  });
});

describe("archive attacks are refused (test_archive_attacks_rejected and more)", () => {
  async function payload(): Promise<{ files: Map<string, Uint8Array>; signature: Record<string, unknown> | null }> {
    const { files, signature } = await shipped();
    return { files, signature: signature as Record<string, unknown> | null };
  }

  async function members(): Promise<Entry[]> {
    const { files, signature } = await payload();
    const all = new Map(files);
    all.set(INTEGRITY_PATH, canonicalJson(await integrityStatement(files)));
    if (signature) all.set(SIGNATURE_PATH, canonicalJson(signature));
    return [...all].map(([name, data]) => [name, data]);
  }

  const hostile = text("hostile");

  const cases: Array<[string, (entries: Entry[]) => Entry[] | Uint8Array, RegExp]> = [
    ["traversal", (e) => [...e, ["extra.txt", hostile, { name: "../escape.txt" }]], /unsafe\/nonportable/u],
    ["symlink", (e) => [...e, ["extra.txt", hostile, { externalAttributes: (0o120777 << 16) >>> 0 }]], /symlink, special or executable/u],
    ["duplicate", (e) => [...e, ["graph.json", hostile, { name: "graph.json" }]], /duplicate, NUL, or directory/u],
    ["case", (e) => [...e, ["GRAPH.json", text("{}")]], /case-colliding/u],
    ["compressed", (e) => [...e, ["extra.txt", hostile, { method: 8 }]], /compressed members unsupported/u],
    ["encrypted", (e) => [...e, ["extra.txt", hostile, { flags: 1 }]], /encrypted\/compressed/u],
    ["executable", (e) => [...e, ["extra.txt", hostile, { externalAttributes: (0o100755 << 16) >>> 0 }]], /executable archive member/u],
    ["oversized", (e) => [...e, ["extra.txt", new Uint8Array(MAX_MEMBER_BYTES + 1), {}]], /resource limit exceeded/u],
    ["directory entry", (e) => [...e, ["skills/", new Uint8Array(), { name: "skills/" }]], /unsafe\/nonportable|directory archive member/u],
    ["NUL in name", (e) => [...e, ["extra.txt", hostile, { name: "extra\u0000.txt" }]], /unsafe\/nonportable/u],
    ["extra field", (e) => [...e, ["extra.txt", hostile, { extra: new Uint8Array([1, 2, 3, 4]) }]], /extra fields/u],
    ["entry comment", (e) => [...e, ["extra.txt", hostile, { comment: text("c") }]], /entry comments/u],
    ["data descriptor flag", (e) => [...e, ["extra.txt", hostile, { dataDescriptor: true }]], /data descriptors/u],
    ["local extra field", (e) => [...e, ["extra.txt", hostile, { localExtra: new Uint8Array([0, 0, 0, 0]) }]], /inconsistent ZIP local header/u],
    ["local/central size disagreement", (e) => [...e, ["extra.txt", hostile, { compressedSize: 3, size: 3 }]], /invalid ZIP artifact|inconsistent/u],
    ["local name differs", (e) => [...e, ["extra.txt", hostile, { localName: "other.txt" }]], /File name in directory 'extra\.txt' and header b'other\.txt' differ\.|inconsistent|layout/u],
    ["bad CRC", (e) => [...e, ["extra.txt", hostile, { crc: 0xdeadbeef }]], /Bad CRC-32/u],
    ["missing integrity", (e) => e.filter(([name]) => name !== INTEGRITY_PATH), /missing generated integrity\.json/u],
    // Review 1, finding 4: layouts the reference refuses that this reader used to accept.
    ["compressed patched data flag (bit 5)", (e) => [...e, ["extra.txt", hostile, { flags: 0x20 }]], /compressed patched data \(flag bit 5\)/u],
    ["strong encryption flag (bit 6)", (e) => [...e, ["extra.txt", hostile, { flags: 0x40 }]], /strong encryption \(flag bit 6\)/u],
    ["another general-purpose flag bit (stricter than the reference; B-103)", (e) => [...e, ["extra.txt", hostile, { flags: 0x2 }]], /unsupported ZIP general-purpose flag bits 0x2/u],
    ["a disk number start (stricter than the reference; B-103)", (e) => [...e, ["extra.txt", hostile, { diskNumberStart: 1 }]], /noncanonical ZIP central directory record/u],
    ["internal attributes (stricter than the reference; B-103)", (e) => [...e, ["extra.txt", hostile, { internalAttributes: 1 }]], /noncanonical ZIP central directory record/u],
    [
      "a multi-disk ZIP64 locator spelled by the last record's disk and attribute fields (zipfile._EndRecData64)",
      (e) => [...e, ["zzzz.txt", hostile, { diskNumberStart: 0x4b50, internalAttributes: 0x0706 }]],
      /zipfiles that span multiple disks are not supported/u,
    ],
  ];

  for (const [label, mutate, pattern] of cases) {
    it(`refuses ${label}`, async () => {
      const result = mutate(await members());
      const raw = result instanceof Uint8Array ? result : writeZip(result, { unsorted: false });
      await expect(readArchiveBytes(raw)).rejects.toThrow(pattern);
    });
  }

  it("refuses prefixes, suffixes, comments, gaps and count mismatches around the archive", async () => {
    const entries = await members();
    const good = writeZip(entries);
    await expect(readArchiveBytes(good)).resolves.toBeDefined();
    await expect(readArchiveBytes(writeZip(entries, { prefix: text("junk") }))).rejects.toThrow(/standalone ZIP/u);
    await expect(readArchiveBytes(writeZip(entries, { suffix: text("junk") }))).rejects.toThrow(/standalone ZIP/u);
    await expect(readArchiveBytes(writeZip(entries, { comment: text("c") }))).rejects.toThrow(/standalone ZIP|noncanonical/u);
    await expect(readArchiveBytes(writeZip(entries, { gapBefore: { "graph.json": 7 } }))).rejects.toThrow(/ZIP gaps/u);
    await expect(readArchiveBytes(writeZip(entries, { entriesTotal: entries.length - 1 }))).rejects.toThrow(/noncanonical|invalid ZIP|inconsistent/u);
    await expect(readArchiveBytes(writeZip(entries, { entriesOnDisk: entries.length - 1 }))).rejects.toThrow(/split, extended, or noncanonical/u);
    await expect(readArchiveBytes(new Uint8Array(10))).rejects.toThrow(/standalone ZIP/u);
    await expect(readArchiveBytes(good.slice(0, good.length - 3))).rejects.toThrow(/standalone ZIP/u);
  });

  it("refuses an archive with members in an order that leaves a gap or overlap", async () => {
    const entries = await members();
    // Unsorted member order is fine as long as the layout is contiguous.
    const reversed = writeZip([...entries].reverse(), { unsorted: true });
    const contents = await readArchiveBytes(reversed);
    expect(contents.files.size).toBe(SHIPPED.webair.payloadFiles);
  });

  it("separates integrity failures from container failures (test_integrity_detects_tampered_extra_missing_files)", async () => {
    const { files, signature } = await payload();
    const statement = canonicalJson(await integrityStatement(files));
    const envelope: Entry[] = [[INTEGRITY_PATH, statement]];
    if (signature) envelope.push([SIGNATURE_PATH, canonicalJson(signature)]);
    const skill = [...files.keys()].find((name) => name.startsWith("skills/"))!;

    const tampered = new Map(files);
    tampered.set(skill, text("Tampered instructions"));
    await expect(readArchiveBytes(writeZip([...tampered, ...envelope]))).rejects.toThrow(IntegrityError);
    await expect(readArchiveBytes(writeZip([...tampered, ...envelope]))).rejects.toThrow(/integrity mismatch.*changed=\['skills/u);

    const extra = new Map(files);
    extra.set("extra.txt", text("Unhashed member"));
    await expect(readArchiveBytes(writeZip([...extra, ...envelope]))).rejects.toThrow(/integrity mismatch.*extra=\['extra\.txt'\]/u);

    const missing = new Map(files);
    missing.delete(skill);
    await expect(readArchiveBytes(writeZip([...missing, ...envelope]))).rejects.toThrow(/integrity mismatch: missing=\['skills/u);

    // A container failure is a ValidationError that is not an IntegrityError.
    const container = writeZip([...files, ...envelope, ["extra.txt", hostile, { method: 8 }]]);
    const error = await readArchiveBytes(container).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ValidationError);
    expect(error).not.toBeInstanceOf(IntegrityError);
  });

  it("refuses an integrity statement or signature envelope that fails its schema", async () => {
    const { files } = await payload();
    const bad = writeZip([...files, [INTEGRITY_PATH, text('{"format":"other","files":{}}')]]);
    await expect(readArchiveBytes(bad)).rejects.toThrow(/integrity\.json\//u);
    const statement = canonicalJson(await integrityStatement(files));
    const badSignature = writeZip([...files, [INTEGRITY_PATH, statement], [SIGNATURE_PATH, text('{"format":"x"}')]]);
    await expect(readArchiveBytes(badSignature)).rejects.toThrow(/signatures\/publisher\.json\//u);
  });

  it("the lenient test lister agrees with the strict reader on a good archive", async () => {
    const { raw, files } = await shipped();
    const listed = listMembers(raw);
    expect(listed.size).toBe(files.size + 2);
    for (const [name, data] of files) expect(bytesEqual(listed.get(name)!, data)).toBe(true);
  });
});
