#!/usr/bin/env node
/**
 * Generate the extension's icons as flat PNGs (a rounded square with a "WA" mark drawn from
 * rectangles), deterministically, with no image library. Run once; the outputs are committed
 * under src/extension/icons/.
 */
import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const out = resolve(here, "..", "src", "extension", "icons");
mkdirSync(out, { recursive: true });

const CRC_TABLE = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (bytes) => {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
};

function png(size) {
  const rows = [];
  const background = [0x0b, 0x6e, 0x4f, 0xff];
  const mark = [0xff, 0xff, 0xff, 0xff];
  const radius = Math.max(2, Math.round(size * 0.22));
  const inside = (x, y) => {
    const cx = x < radius ? radius : x >= size - radius ? size - radius - 1 : x;
    const cy = y < radius ? radius : y >= size - radius ? size - radius - 1 : y;
    return (x - cx) ** 2 + (y - cy) ** 2 <= radius ** 2;
  };
  // A simple "A" shape: two legs and a bar, scaled to the icon.
  const unit = size / 16;
  const shapes = [
    [4, 11, 6, 13], // left foot
    [10, 11, 12, 13], // right foot
    [5, 8, 7, 11],
    [9, 8, 11, 11],
    [6, 5, 10, 8], // head
    [6.5, 9.5, 9.5, 10.5], // bar
  ];
  const onMark = (x, y) => shapes.some(([x1, y1, x2, y2]) => x >= x1 * unit && x < x2 * unit && y >= y1 * unit && y < y2 * unit);
  for (let y = 0; y < size; y += 1) {
    const row = [0];
    for (let x = 0; x < size; x += 1) {
      if (!inside(x, y)) row.push(0, 0, 0, 0);
      else if (onMark(x, y)) row.push(...mark);
      else row.push(...background);
    }
    rows.push(Buffer.from(row));
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // RGBA
  header[10] = 0;
  header[11] = 0;
  header[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(Buffer.concat(rows), { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

for (const size of [16, 32, 48, 128]) writeFileSync(join(out, `icon-${size}.png`), png(size));
console.log(JSON.stringify({ icons: [16, 32, 48, 128].map((size) => `icon-${size}.png`), out }));
