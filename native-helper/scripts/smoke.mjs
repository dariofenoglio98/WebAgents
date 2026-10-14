#!/usr/bin/env node
/**
 * Smoke test of the built helper (T17, D-204), speaking Chrome's framing to the real binary:
 * `--version` answers; every request from anything but Google Chrome is refused `caller_refused`
 * in a well-framed reply (no args, a foreign origin, the right origin with a non-Chrome parent),
 * and no keychain item is touched. Usage: node scripts/smoke.mjs [path/to/webagents-helper]
 * (default: .build/release/webagents-helper). Prints JSON with "passed".
 */
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const binary = resolve(process.argv[2] ?? join(here, "..", ".build", "release", "webagents-helper"));
const ids = JSON.parse(readFileSync(join(here, "..", "..", "installer", "macos", "extension-ids.json"), "utf8")).extension_ids;
const checks = [];
const check = (name, ok, detail) => checks.push({ name, ok: Boolean(ok), ...(ok ? {} : { detail }) });

function frame(object) {
  const body = Buffer.from(JSON.stringify(object), "utf8");
  const length = Buffer.alloc(4);
  length.writeUInt32LE(body.length);
  return Buffer.concat([length, body]);
}

function call(path, args, input) {
  const result = spawnSync(path, args, { input, timeout: 15_000 });
  const out = result.stdout ?? Buffer.alloc(0);
  if (out.length < 4) return { status: result.status, reply: null, raw: out.toString("utf8") };
  const length = out.readUInt32LE(0);
  return { status: result.status, length, total: out.length, reply: JSON.parse(out.subarray(4, 4 + length).toString("utf8")) };
}

const version = spawnSync(binary, ["--version"]);
check("--version answers", version.status === 0 && /^webagents-helper \d+\.\d+\.\d+/u.test(version.stdout.toString()), version.stdout.toString());

const directory = mkdtempSync(join(tmpdir(), "webagents-helper-smoke-"));
try {
  const installed = join(directory, "webagents-helper");
  copyFileSync(binary, installed);
  chmodSync(installed, 0o755);
  writeFileSync(join(directory, "extension-ids.json"), JSON.stringify({ extension_ids: ids }));
  const origin = `chrome-extension://${ids[0]}/`;
  const status = frame({ op: "ollama.status" });
  const cases = [
    ["no caller origin", installed, [], "caller_refused"],
    ["a foreign origin", installed, ["chrome-extension://bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb/"], "caller_refused"],
    ["the extension's origin, a non-Chrome parent", installed, [origin], "caller_refused"],
    ["no id list beside the binary", binary, [origin], "caller_refused"],
  ];
  for (const [name, path, args, code] of cases) {
    const { status: exit, reply, length, total } = call(path, args, status);
    check(`${name}: refused ${code}`, reply?.ok === false && reply?.error?.code === code && exit === 1, reply);
    check(`${name}: one well-framed reply`, reply !== null && total === 4 + length, { length, total });
  }
  const wrap = call(installed, [origin], frame({ op: "keychain.wrap", key: Buffer.alloc(32).toString("base64") }));
  check("keychain.wrap from a non-Chrome parent is refused before the keychain", wrap.reply?.error?.code === "caller_refused" && wrap.reply?.blob === undefined, wrap.reply);
} finally {
  rmSync(directory, { recursive: true, force: true });
}

const passed = checks.every((item) => item.ok);
console.log(JSON.stringify({ binary, passed, checks }, null, 2));
process.exit(passed ? 0 : 1);
