#!/usr/bin/env node
/**
 * Zip the built extension for distribution or Chrome Web Store upload:
 * dist/chrome-agent-browser-<version>.zip, with the manifest at the archive root.
 *
 * The archive is written here, deterministically, with no external tool (D-031): members in
 * sorted path order, deflate (stored when deflate does not shrink a member), timestamp
 * 1980-01-01 00:00:00, Unix regular-file mode 0644, no comments or extra fields. The same
 * build therefore always produces the same bytes. Requires `npm run build` first.
 */
import { crc32, deflateRawSync } from "node:zlib";
import { existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const project = resolve(here, "..");
const extension = join(project, "dist", "extension");
if (!existsSync(join(extension, "manifest.json"))) {
  console.error("dist/extension/manifest.json is missing; run `npm run build` first");
  process.exit(1);
}

function* walk(directory) {
  for (const name of readdirSync(directory).sort()) {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) yield* walk(path);
    else yield path;
  }
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

const DOS_TIME = 0; // 00:00:00
const DOS_DATE = 0x21; // 1980-01-01
const VERSION_NEEDED = 20;
const VERSION_MADE_BY = 20 | (3 << 8); // Unix
const EXTERNAL_ATTRIBUTES = (0o100644 << 16) >>> 0;

const members = [...walk(extension)]
  .map((path) => ({ name: relative(extension, path).split(sep).join("/"), data: readFileSync(path) }))
  .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

const locals = [];
const central = [];
let offset = 0;
for (const { name, data } of members) {
  if (!/^[\x20-\x7e]+$/u.test(name)) throw new Error(`non-ASCII member name: ${name}`);
  const nameBytes = Buffer.from(name, "ascii");
  const deflated = deflateRawSync(data, { level: 9 });
  const method = deflated.length < data.length ? 8 : 0;
  const payload = method === 8 ? deflated : data;
  const checksum = crc32(data);
  const fixed = [u16(0), u16(method), u16(DOS_TIME), u16(DOS_DATE), u32(checksum), u32(payload.length), u32(data.length)];
  const local = Buffer.concat([u32(0x04034b50), u16(VERSION_NEEDED), ...fixed, u16(nameBytes.length), u16(0), nameBytes, payload]);
  central.push(
    Buffer.concat([
      u32(0x02014b50),
      u16(VERSION_MADE_BY),
      u16(VERSION_NEEDED),
      ...fixed,
      u16(nameBytes.length),
      u16(0),
      u16(0),
      u16(0),
      u16(0),
      u32(EXTERNAL_ATTRIBUTES),
      u32(offset),
      nameBytes,
    ]),
  );
  locals.push(local);
  offset += local.length;
}
const directory = Buffer.concat(central);
const end = Buffer.concat([u32(0x06054b50), u16(0), u16(0), u16(members.length), u16(members.length), u32(directory.length), u32(offset), u16(0)]);
const archive = Buffer.concat([...locals, directory, end]);

const manifest = JSON.parse(readFileSync(join(extension, "manifest.json"), "utf8"));
const target = join(project, "dist", `chrome-agent-browser-${manifest.version}.zip`);
rmSync(target, { force: true });
writeFileSync(target, archive);
console.log(
  JSON.stringify({
    zip: target,
    version: manifest.version,
    files: members.length,
    zip_bytes: archive.length,
    uncompressed_bytes: members.reduce((sum, member) => sum + member.data.length, 0),
  }),
);
