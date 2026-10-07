/** `pyRepr` reproduces CPython's `repr()` for the values that appear in refusal messages (D-038). Expected strings come from the venv's Python 3.13. */
import { describe, expect, it } from "vitest";

import { pyBytesRepr, pyRepr, pyStrRepr } from "../../src/core/repr.js";

describe("pyRepr", () => {
  const vectors: Array<[unknown, string]> = [
    ["graph.json", "'graph.json'"],
    ["../evil.txt", "'../evil.txt'"],
    ["it's", "\"it's\""],
    ['say "hi"', "'say \"hi\"'"],
    ["both ' and \"", "'both \\' and \"'"],
    ["a\tb", "'a\\tb'"],
    ["a\nb\\c", "'a\\nb\\\\c'"],
    ["ünï", "'ünï'"],
    ["\u0001", "'\\x01'"],
    ["\u007f", "'\\x7f'"],
    ["​", "'\\u200b'"],
    ["\u{1f600}", "'\u{1f600}'"],
    [["a.json", "b.json"], "['a.json', 'b.json']"],
    [[], "[]"],
    [{ a: 1 }, "{'a': 1}"],
    [null, "None"],
    [true, "True"],
    [false, "False"],
    [1.5, "1.5"],
    [42, "42"],
    [new Uint8Array([0x6f, 0x74, 0x68, 0x65, 0x72]), "b'other'"],
    [new Uint8Array([0x01, 0xff]), "b'\\x01\\xff'"],
  ];
  for (const [value, expected] of vectors) {
    it(`repr(${JSON.stringify(value) ?? String(value)}) = ${expected}`, () => {
      expect(pyRepr(value)).toBe(expected);
    });
  }

  it("exposes the string and bytes forms", () => {
    expect(pyStrRepr("x")).toBe("'x'");
    expect(pyBytesRepr(new Uint8Array([0x27]))).toBe('b"\'"');
  });
});
