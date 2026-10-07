/**
 * Python `repr()` for the values that appear in the reference's messages, so that a
 * refusal reads the same in both runtimes (D-038): `'graph.json'`, `b'other.txt'`,
 * `['a.json', 'b.json']`, `None`, `True`. Strings follow CPython's rule for the quote
 * character (single quotes unless the text contains one and no double quote), escape
 * `\\`, `\n`, `\r`, `\t` and the chosen quote, and write other non-printable code points
 * as `\xNN`, `\uNNNN` or `\UNNNNNNNN`. Printability is CPython's `str.isprintable`:
 * everything outside the C0/C1 controls, separators and the unassigned, surrogate,
 * private-use and format categories; Unicode property escapes give the same partition.
 */

const PRINTABLE_EXCEPTIONS = /[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}\p{Zl}\p{Zp}\p{Zs}]/u;

function isPrintable(character: string): boolean {
  if (character === " ") return true;
  return !PRINTABLE_EXCEPTIONS.test(character);
}

function escapeCodePoint(code: number): string {
  if (code < 0x100) return `\\x${code.toString(16).padStart(2, "0")}`;
  if (code < 0x10000) return `\\u${code.toString(16).padStart(4, "0")}`;
  return `\\U${code.toString(16).padStart(8, "0")}`;
}

/** `repr(str)`. */
export function pyStrRepr(text: string): string {
  const quote = text.includes("'") && !text.includes('"') ? '"' : "'";
  let out = quote;
  for (const character of text) {
    const code = character.codePointAt(0)!;
    if (character === quote || character === "\\") out += `\\${character}`;
    else if (character === "\n") out += "\\n";
    else if (character === "\r") out += "\\r";
    else if (character === "\t") out += "\\t";
    else if (isPrintable(character)) out += character;
    else out += escapeCodePoint(code);
  }
  return out + quote;
}

/** `repr(bytes)`: printable ASCII as is, everything else `\xNN`. */
export function pyBytesRepr(bytes: Uint8Array): string {
  let hasSingle = false;
  let hasDouble = false;
  for (const byte of bytes) {
    if (byte === 0x27) hasSingle = true;
    if (byte === 0x22) hasDouble = true;
  }
  const quote = hasSingle && !hasDouble ? '"' : "'";
  let out = `b${quote}`;
  for (const byte of bytes) {
    const character = String.fromCharCode(byte);
    if (character === quote || character === "\\") out += `\\${character}`;
    else if (byte === 0x0a) out += "\\n";
    else if (byte === 0x0d) out += "\\r";
    else if (byte === 0x09) out += "\\t";
    else if (byte >= 0x20 && byte < 0x7f) out += character;
    else out += `\\x${byte.toString(16).padStart(2, "0")}`;
  }
  return out + quote;
}

/** `repr(value)` for JSON-shaped values: strings, numbers, booleans, null, arrays, objects. */
export function pyRepr(value: unknown): string {
  if (typeof value === "string") return pyStrRepr(value);
  if (value === null || value === undefined) return "None";
  if (value === true) return "True";
  if (value === false) return "False";
  if (typeof value === "number") {
    if (Number.isInteger(value)) return String(value);
    return Number.isFinite(value) ? String(value) : value > 0 ? "inf" : value < 0 ? "-inf" : "nan";
  }
  if (value instanceof Uint8Array) return pyBytesRepr(value);
  if (Array.isArray(value)) return `[${value.map(pyRepr).join(", ")}]`;
  if (typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .map(([key, item]) => `${pyStrRepr(key)}: ${pyRepr(item)}`)
      .join(", ")}}`;
  }
  return String(value);
}
