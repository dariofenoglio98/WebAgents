// A ZIP_STORED reader and writer for building the negative suite's hostile inputs.
//
// The writer produces exactly what `agentpkg/package.py::archive_bytes` writes through Python's
// `zipfile`: sorted ASCII names, 1980-01-01 00:00:00, Unix regular-file mode 0644, version 2.0,
// no comments or extra fields. `rebuild` re-reads a shipped archive and writes it back, so a test
// can change one member (and choose whether its CRC is recomputed) while every other byte stays
// what the publisher signed. Nothing here validates: both runtimes do that.

const TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(data) {
  let crc = 0xffffffff;
  for (const byte of data) crc = TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** The members of a STORED archive in central-directory order: `[{name, data, crc}]`. */
export function readStored(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let at = bytes.length - 22; at >= 0; at -= 1) {
    if (view.getUint32(at, true) === 0x06054b50) {
      eocd = at;
      break;
    }
  }
  if (eocd < 0) throw new Error("no end of central directory");
  const count = view.getUint16(eocd + 10, true);
  let at = view.getUint32(eocd + 16, true);
  const members = [];
  for (let index = 0; index < count; index += 1) {
    if (view.getUint32(at, true) !== 0x02014b50) throw new Error("bad central directory");
    const crc = view.getUint32(at + 16, true);
    const size = view.getUint32(at + 20, true);
    const nameLength = view.getUint16(at + 28, true);
    const extraLength = view.getUint16(at + 30, true);
    const commentLength = view.getUint16(at + 32, true);
    const local = view.getUint32(at + 42, true);
    const name = new TextDecoder().decode(bytes.subarray(at + 46, at + 46 + nameLength));
    const localName = view.getUint16(local + 26, true);
    const localExtra = view.getUint16(local + 28, true);
    const start = local + 30 + localName + localExtra;
    members.push({ name, data: bytes.slice(start, start + size), crc });
    at += 46 + nameLength + extraLength + commentLength;
  }
  return members;
}

const u16 = (value) => {
  const out = Buffer.alloc(2);
  out.writeUInt16LE(value);
  return out;
};
const u32 = (value) => {
  const out = Buffer.alloc(4);
  out.writeUInt32LE(value >>> 0);
  return out;
};

/** Write `[{name, data, crc?}]` sorted by name; `crc` defaults to the data's own. */
export function writeStored(members) {
  const sorted = [...members].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const parts = [];
  const central = [];
  let offset = 0;
  for (const member of sorted) {
    const name = Buffer.from(member.name, "utf8");
    const crc = member.crc ?? crc32(member.data);
    const header = [u16(20), u16(0), u16(0), u16(0), u16(0x21), u32(crc), u32(member.data.length), u32(member.data.length), u16(name.length), u16(0)];
    const local = Buffer.concat([u32(0x04034b50), ...header, name, Buffer.from(member.data)]);
    central.push(Buffer.concat([u32(0x02014b50), u16(20 | (3 << 8)), ...header, u16(0), u16(0), u16(0), u32((0o100644 << 16) >>> 0), u32(offset), name]));
    parts.push(local);
    offset += local.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.concat([u32(0x06054b50), u16(0), u16(0), u16(sorted.length), u16(sorted.length), u32(directory.length), u32(offset), u16(0)]);
  return new Uint8Array(Buffer.concat([...parts, directory, end]));
}

/**
 * Re-read an archive and write it back with `change(members)` applied. `keepCrc` names members
 * whose recorded CRC is kept although their data changed (a torn or tampered transfer).
 */
export function rebuild(bytes, change, { keepCrc = [] } = {}) {
  const members = readStored(bytes).map((member) => ({ ...member }));
  const originals = new Map(members.map((member) => [member.name, member.crc]));
  const changed = change(members) ?? members;
  return writeStored(changed.map((member) => ({ name: member.name, data: member.data, crc: keepCrc.includes(member.name) ? originals.get(member.name) : undefined })));
}
