#!/usr/bin/env node
/**
 * Write `test/fixtures/secret-store-vectors.json` (T16, D-191): one envelope under the production
 * scrypt parameters and one under the test parameters, both built from fixed "random" bytes, so a
 * later build must open exactly these bytes with the same passphrase, read the same entries and
 * refuse the same tampering. Regenerate only when the envelope format changes (a new schema
 * version), never for a refactor: the point of the file is that it does not change.
 *
 *   node scripts/make-secret-store-vectors.mjs
 */
import { writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const project = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { createEnvelope, SCRYPT_PARAMETERS } = await import(join(project, "src", "core", "secrets.ts"));

/** Deterministic bytes: a counter stream, distinct per call, never used outside this file. */
function fixedRandom() {
  let counter = 0;
  return (length) => {
    const out = new Uint8Array(length);
    for (let index = 0; index < length; index += 1) out[index] = (counter += 1) & 0xff;
    return out;
  };
}

const passphrase = "correct horse battery staple";
const entries = {
  "provider_key:openai": new TextEncoder().encode("sk-test-not-a-real-key-0123456789"),
  vault_key: new Uint8Array(32).map((_, index) => 255 - index),
  vault: new TextEncoder().encode(JSON.stringify({ schema: "chrome-agent-browser-vault-v0", types: [], records: [] })),
};
const now = () => new Date("2026-10-13T12:00:00.000Z");
const production = await createEnvelope(passphrase, entries, { now, random: fixedRandom() });
const test = await createEnvelope(passphrase, entries, { now, random: fixedRandom(), kdf: { n: 2 ** 14, r: 8, p: 1 } });
/** An empty envelope under the test parameters: the unit-test harness seeds its stores with it (unlocked) so every existing test starts with a passphrase set. */
const empty = await createEnvelope(passphrase, {}, { now, random: fixedRandom(), kdf: { n: 2 ** 14, r: 8, p: 1 } });
const encode = (bytes) => Buffer.from(bytes).toString("base64");
const vectors = {
  note: "Fixed-random envelopes for test/core/secrets.test.ts; the master keys are included so the entries can be checked directly. Regenerate only for a new envelope schema.",
  passphrase,
  wrong_passphrase: "correct horse battery stapler",
  entries: Object.fromEntries(Object.entries(entries).map(([name, bytes]) => [name, encode(bytes)])),
  production: { parameters: SCRYPT_PARAMETERS, master_key: encode(production.masterKey), envelope: production.envelope },
  test: { parameters: { ...SCRYPT_PARAMETERS, n: 2 ** 14 }, master_key: encode(test.masterKey), envelope: test.envelope },
  empty: { parameters: { ...SCRYPT_PARAMETERS, n: 2 ** 14 }, master_key: encode(empty.masterKey), envelope: empty.envelope },
};
const target = join(project, "test", "fixtures", "secret-store-vectors.json");
writeFileSync(target, `${JSON.stringify(vectors, null, 2)}\n`);
console.log(JSON.stringify({ written: target, production_n: production.envelope.kdf.n, test_n: test.envelope.kdf.n }));
