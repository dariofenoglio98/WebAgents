import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { canonicalJson, canonicalString } from "../../src/core/canonical.js";
import { ValidationError } from "../../src/core/errors.js";
import { sha256Hex, toHex, fromHex, concatBytes } from "../../src/core/hash.js";
import { parseJson } from "../../src/core/json.js";

type Vector = { input: string; canonical: string | null; rejected?: string; digest?: string; package?: string };

const here = dirname(fileURLToPath(import.meta.url));
const VECTORS = JSON.parse(readFileSync(join(here, "..", "fixtures", "jcs-vectors.json"), "utf8")) as Vector[];

describe("RFC 8785 canonicalization against the reference implementation's vectors", () => {
  it("has vectors generated from agentpkg's rfc8785", () => {
    expect(VECTORS.length).toBeGreaterThan(40);
    expect(VECTORS.filter((vector) => vector.package)).toHaveLength(3);
  });

  for (const vector of VECTORS) {
    const label = vector.package ?? vector.input.slice(0, 60);
    if (vector.canonical === null) {
      it(`refuses ${label} (${vector.rejected})`, () => {
        // The reference refuses at canonicalization; this port refuses the same inputs at parse
        // time, which is the same verdict for every package member.
        expect(() => canonicalString(parseJson(vector.input, "v"))).toThrow(ValidationError);
      });
    } else {
      it(`canonicalizes ${label}`, async () => {
        const value = parseJson(vector.input, "v");
        const canonical = canonicalJson(value);
        expect(new TextDecoder().decode(canonical)).toBe(vector.canonical);
        if (vector.digest) expect(await sha256Hex(canonical)).toBe(vector.digest);
      });
    }
  }

  it("normalizes numbers and sorts keys as the Python test does", () => {
    expect(new TextDecoder().decode(canonicalJson({ z: 1.0, a: 1e-7 }))).toBe('{"a":1e-7,"z":1}');
    expect(canonicalString(-0)).toBe("0");
    expect(() => canonicalString(Number.POSITIVE_INFINITY)).toThrow(ValidationError);
    expect(() => canonicalString(Number.NaN)).toThrow(ValidationError);
  });

  it("refuses values that are not JSON", () => {
    expect(() => canonicalString(undefined)).toThrow(ValidationError);
    expect(() => canonicalString({ a: undefined })).toThrow(ValidationError);
    expect(() => canonicalString(new Date(0))).toThrow(ValidationError);
    expect(() => canonicalString(new Map())).toThrow(ValidationError);
    expect(() => canonicalString(10n as unknown)).toThrow(ValidationError);
    expect(() => canonicalString(() => 1)).toThrow(ValidationError);
    expect(canonicalString(Object.create(null))).toBe("{}");
  });
});

describe("hash helpers", () => {
  it("hashes bytes like hashlib", async () => {
    expect(await sha256Hex(new Uint8Array())).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(await sha256Hex(new TextEncoder().encode("abc"))).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("round-trips hex and concatenates", () => {
    const bytes = new Uint8Array([0, 1, 0xab, 0xff]);
    expect(toHex(bytes)).toBe("0001abff");
    expect(fromHex("0001abff")).toEqual(bytes);
    expect(() => fromHex("ABCD")).toThrow(TypeError);
    expect(concatBytes(new Uint8Array([1]), new Uint8Array([]), new Uint8Array([2, 3]))).toEqual(new Uint8Array([1, 2, 3]));
  });
});
