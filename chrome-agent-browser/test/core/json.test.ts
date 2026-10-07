import { describe, expect, it } from "vitest";

import { ValidationError } from "../../src/core/errors.js";
import { parseJson } from "../../src/core/json.js";

const bytes = (text: string) => new TextEncoder().encode(text);

describe("strict JSON parsing (validation.py::parse_json and the rfc8785 domain rules)", () => {
  it("parses ordinary documents", () => {
    expect(parseJson(bytes('{"a":[1,2.5,"x",true,null],"b":{}}'), "doc")).toEqual({
      a: [1, 2.5, "x", true, null],
      b: {},
    });
    expect(parseJson(" \n\t[]\r\n", "doc")).toEqual([]);
  });

  it("refuses duplicate keys, as the reference does", () => {
    expect(() => parseJson('{"a":1,"a":2}', "extra.json")).toThrow(/extra\.json: duplicate JSON key 'a'/u);
    expect(() => parseJson('{"x":{"a":1,"b":2,"a":3}}', "n")).toThrow(/duplicate JSON key/u);
  });

  it("refuses the NaN and Infinity constants and malformed numbers", () => {
    for (const text of ['{"a":NaN}', "Infinity", "-Infinity", "[01]", "1.", ".5", "+1", "0x10", "1e", "--1"]) {
      expect(() => parseJson(text, "n"), text).toThrow(/strict UTF-8 JSON/u);
    }
  });

  it("refuses integers outside the safe integer domain and non-finite floats", () => {
    expect(parseJson("9007199254740991", "n")).toBe(9007199254740991);
    expect(parseJson("-9007199254740991", "n")).toBe(-9007199254740991);
    for (const text of ["9007199254740992", "9007199254740993", "-9007199254740992", "12345678901234567890"]) {
      expect(() => parseJson(text, "n"), text).toThrow(/exceeds safe integer domain/u);
    }
    expect(() => parseJson("1e400", "n")).toThrow(/not representable in JCS/u);
    // A float token of the same magnitude is a float in the reference and is accepted.
    expect(parseJson("9007199254740993.0", "n")).toBe(9007199254740992);
    expect(parseJson("1e20", "n")).toBe(1e20);
  });

  it("refuses malformed UTF-8, a byte-order mark, control characters and bad escapes", () => {
    expect(() => parseJson(new Uint8Array([0xff, 0xfe, 0x22]), "n")).toThrow(/malformed UTF-8/u);
    expect(() => parseJson(bytes("﻿{}"), "n")).toThrow(/unexpected character/u);
    expect(() => parseJson('"a\nb"', "n")).toThrow(/control character/u);
    expect(() => parseJson('"\\x41"', "n")).toThrow(/invalid escape/u);
    expect(() => parseJson('"\\u12"', "n")).toThrow(/invalid unicode escape/u);
    expect(() => parseJson('"\\ud800"', "n")).toThrow(/lone surrogate/u);
    expect(() => parseJson('"\\udc00"', "n")).toThrow(/lone surrogate/u);
    expect(parseJson('"\\ud83d\\ude00\\u00e9\\n\\/"', "n")).toBe("😀é\n/");
  });

  it("refuses trailing content, empty input and unterminated structures", () => {
    for (const text of ["{} x", "", "   ", "[1,2", '{"a":1', '"abc', "[1,]", '{"a":1,}', "{,}"]) {
      expect(() => parseJson(text, "n"), JSON.stringify(text)).toThrow(ValidationError);
    }
  });

  it("keeps __proto__ as an ordinary own key", () => {
    const value = parseJson('{"__proto__":{"polluted":true},"a":1}', "n") as Record<string, unknown>;
    expect(Object.prototype.hasOwnProperty.call(value, "__proto__")).toBe(true);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.getPrototypeOf(value)).toBe(Object.prototype);
  });

  it("bounds nesting depth", () => {
    const deep = "[".repeat(600) + "]".repeat(600);
    expect(() => parseJson(deep, "n")).toThrow(/nesting exceeds/u);
    const fine = "[".repeat(100) + "]".repeat(100);
    expect(parseJson(fine, "n")).toBeDefined();
  });
});
