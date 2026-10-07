/**
 * A deterministic ZIP (STORED) writer for the Runs export (D-073), in the page: fixed
 * timestamps, no comments or extra fields, members in the order given. The same files always
 * give the same bytes. CRC-32 comes from the core's `crc32`.
 */
import { crc32 } from "../../core/crc32.js";

const DOS_TIME = 0; // 00:00:00
const DOS_DATE = (1980 - 1980) << 9 | (1 << 5) | 1; // 1980-01-01

function u16(view: DataView, offset: number, value: number): void {
  view.setUint16(offset, value, true);
}

function u32(view: DataView, offset: number, value: number): void {
  view.setUint32(offset, value >>> 0, true);
}

export function writeZip(entries: ReadonlyArray<{ name: string; bytes: Uint8Array }>): Uint8Array {
  const encoder = new TextEncoder();
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = encoder.encode(entry.name);
    const crc = crc32(entry.bytes);
    const local = new Uint8Array(30 + name.length);
    const view = new DataView(local.buffer);
    u32(view, 0, 0x04034b50);
    u16(view, 4, 20);
    u16(view, 6, 0x0800); // UTF-8 names
    u16(view, 8, 0); // stored
    u16(view, 10, DOS_TIME);
    u16(view, 12, DOS_DATE);
    u32(view, 14, crc);
    u32(view, 18, entry.bytes.length);
    u32(view, 22, entry.bytes.length);
    u16(view, 26, name.length);
    u16(view, 28, 0);
    local.set(name, 30);
    locals.push(local, entry.bytes);
    const central = new Uint8Array(46 + name.length);
    const cview = new DataView(central.buffer);
    u32(cview, 0, 0x02014b50);
    u16(cview, 4, 20);
    u16(cview, 6, 20);
    u16(cview, 8, 0x0800);
    u16(cview, 10, 0);
    u16(cview, 12, DOS_TIME);
    u16(cview, 14, DOS_DATE);
    u32(cview, 16, crc);
    u32(cview, 20, entry.bytes.length);
    u32(cview, 24, entry.bytes.length);
    u16(cview, 28, name.length);
    u16(cview, 30, 0);
    u16(cview, 32, 0);
    u16(cview, 34, 0);
    u16(cview, 36, 0);
    u32(cview, 38, 0o100644 << 16); // -rw-r--r--
    u32(cview, 42, offset);
    central.set(name, 46);
    centrals.push(central);
    offset += local.length + entry.bytes.length;
  }
  const centralSize = centrals.reduce((sum, item) => sum + item.length, 0);
  const end = new Uint8Array(22);
  const eview = new DataView(end.buffer);
  u32(eview, 0, 0x06054b50);
  u16(eview, 4, 0);
  u16(eview, 6, 0);
  u16(eview, 8, entries.length);
  u16(eview, 10, entries.length);
  u32(eview, 12, centralSize);
  u32(eview, 16, offset);
  u16(eview, 20, 0);
  const total = offset + centralSize + end.length;
  const out = new Uint8Array(total);
  let position = 0;
  for (const part of [...locals, ...centrals, end]) {
    out.set(part, position);
    position += part.length;
  }
  return out;
}
