/**
 * Strict JSON parsing, mirroring `agentpkg/validation.py::parse_json` together with the
 * domain rules `rfc8785` applies when the parsed value is canonicalized.
 *
 * `JSON.parse` cannot do this job: it keeps the last of duplicated keys silently, it rounds
 * an integer literal of magnitude 2^53 or more to a nearby double, and it strips nothing but
 * accepts a BOM-free input only. The reference refuses all three (duplicate keys and the
 * `NaN`/`Infinity` constants at parse time; oversized integers and non-finite numbers when
 * the member is canonicalized, which every `.json` member and `MANIFEST.agent` is). So this
 * parser refuses them too, at parse time, which for package members gives the same verdict.
 *
 * Deliberate differences, all stricter than the reference and documented here: a lone
 * surrogate escape is refused at parse time (Python accepts the string and fails to encode it
 * as UTF-8 later), and nesting deeper than `MAX_DEPTH` is refused instead of relying on a
 * recursion limit.
 */
import { pyRepr } from "./repr.js";
import { ValidationError } from "./errors.js";

export type JsonValue = null | boolean | number | string | JsonValue[] | JsonObject;
export type JsonObject = { [key: string]: JsonValue };

export const MAX_DEPTH = 512;

const WHITESPACE = new Set([" ", "\t", "\n", "\r"]);

/** Decode exact UTF-8, refusing malformed sequences; a byte-order mark is kept as text. */
export function decodeUtf8(data: Uint8Array, name: string, what = "payload"): string {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(data);
  } catch {
    throw new ValidationError(`${name}: ${what} must be UTF-8 text`);
  }
}

export function parseJson(data: Uint8Array | string, name: string): JsonValue {
  let text: string;
  if (typeof data === "string") {
    text = data;
  } else {
    try {
      text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(data);
    } catch {
      throw new ValidationError(`${name}: invalid strict UTF-8 JSON: malformed UTF-8`);
    }
  }
  const parser = new Parser(text, name);
  const value = parser.document();
  return value;
}

export function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

class Parser {
  private index = 0;

  constructor(
    private readonly text: string,
    private readonly name: string,
  ) {}

  private fail(reason: string): never {
    throw new ValidationError(`${this.name}: invalid strict UTF-8 JSON: ${reason} at position ${this.index}`);
  }

  document(): JsonValue {
    this.skipWhitespace();
    if (this.index >= this.text.length) this.fail("empty document");
    const value = this.value(0);
    this.skipWhitespace();
    if (this.index < this.text.length) this.fail("trailing content after the JSON value");
    return value;
  }

  private skipWhitespace(): void {
    while (this.index < this.text.length && WHITESPACE.has(this.text[this.index]!)) this.index += 1;
  }

  private value(depth: number): JsonValue {
    if (depth > MAX_DEPTH) this.fail(`nesting exceeds ${MAX_DEPTH} levels`);
    const char = this.text[this.index];
    switch (char) {
      case "{":
        return this.object(depth);
      case "[":
        return this.array(depth);
      case '"':
        return this.string();
      case "t":
        return this.literal("true", true);
      case "f":
        return this.literal("false", false);
      case "n":
        return this.literal("null", null);
      default:
        if (char === "-" || (char !== undefined && char >= "0" && char <= "9")) return this.number();
        return this.fail(char === undefined ? "unexpected end of input" : `unexpected character ${JSON.stringify(char)}`);
    }
  }

  private literal<T extends JsonValue>(word: string, value: T): T {
    if (this.text.startsWith(word, this.index)) {
      this.index += word.length;
      return value;
    }
    return this.fail(`invalid literal`);
  }

  private object(depth: number): JsonObject {
    this.index += 1; // {
    const result: JsonObject = {};
    this.skipWhitespace();
    if (this.text[this.index] === "}") {
      this.index += 1;
      return result;
    }
    for (;;) {
      this.skipWhitespace();
      if (this.text[this.index] !== '"') this.fail("expected a string key");
      const key = this.string();
      this.skipWhitespace();
      if (this.text[this.index] !== ":") this.fail("expected ':' after a key");
      this.index += 1;
      this.skipWhitespace();
      const value = this.value(depth + 1);
      if (Object.prototype.hasOwnProperty.call(result, key)) {
        throw new ValidationError(`${this.name}: duplicate JSON key ${pyRepr(key)}`);
      }
      // A plain object; `__proto__` as an own data property, never as a prototype write.
      Object.defineProperty(result, key, { value, enumerable: true, writable: true, configurable: true });
      this.skipWhitespace();
      const next = this.text[this.index];
      if (next === ",") {
        this.index += 1;
        continue;
      }
      if (next === "}") {
        this.index += 1;
        return result;
      }
      this.fail("expected ',' or '}' in object");
    }
  }

  private array(depth: number): JsonValue[] {
    this.index += 1; // [
    const result: JsonValue[] = [];
    this.skipWhitespace();
    if (this.text[this.index] === "]") {
      this.index += 1;
      return result;
    }
    for (;;) {
      this.skipWhitespace();
      result.push(this.value(depth + 1));
      this.skipWhitespace();
      const next = this.text[this.index];
      if (next === ",") {
        this.index += 1;
        continue;
      }
      if (next === "]") {
        this.index += 1;
        return result;
      }
      this.fail("expected ',' or ']' in array");
    }
  }

  private string(): string {
    this.index += 1; // opening quote
    let out = "";
    for (;;) {
      if (this.index >= this.text.length) this.fail("unterminated string");
      const char = this.text[this.index]!;
      const code = char.charCodeAt(0);
      if (char === '"') {
        this.index += 1;
        return out;
      }
      if (char === "\\") {
        const escape = this.text[this.index + 1];
        this.index += 2;
        switch (escape) {
          case '"':
            out += '"';
            break;
          case "\\":
            out += "\\";
            break;
          case "/":
            out += "/";
            break;
          case "b":
            out += "\b";
            break;
          case "f":
            out += "\f";
            break;
          case "n":
            out += "\n";
            break;
          case "r":
            out += "\r";
            break;
          case "t":
            out += "\t";
            break;
          case "u": {
            const unit = this.hex4();
            if (unit >= 0xd800 && unit <= 0xdbff) {
              // A high surrogate must be followed by an escaped low surrogate.
              if (this.text[this.index] !== "\\" || this.text[this.index + 1] !== "u") this.fail("lone surrogate escape");
              this.index += 2;
              const low = this.hex4();
              if (low < 0xdc00 || low > 0xdfff) this.fail("lone surrogate escape");
              out += String.fromCharCode(unit, low);
            } else if (unit >= 0xdc00 && unit <= 0xdfff) {
              this.fail("lone surrogate escape");
            } else {
              out += String.fromCharCode(unit);
            }
            break;
          }
          default:
            this.fail("invalid escape sequence");
        }
        continue;
      }
      if (code < 0x20) this.fail("invalid control character in string");
      out += char;
      this.index += 1;
    }
  }

  private hex4(): number {
    const digits = this.text.slice(this.index, this.index + 4);
    if (!/^[0-9a-fA-F]{4}$/u.test(digits)) this.fail("invalid unicode escape");
    this.index += 4;
    return Number.parseInt(digits, 16);
  }

  private number(): number {
    const start = this.index;
    const match = /^-?(?:0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?/u.exec(this.text.slice(start));
    if (!match) this.fail("invalid number");
    const token = match[0];
    this.index += token.length;
    const value = Number(token);
    if (!Number.isFinite(value)) {
      throw new ValidationError(`${this.name}: invalid strict UTF-8 JSON: ${token.slice(0, 40)} is not representable in JCS`);
    }
    const isInteger = match[1] === undefined && match[2] === undefined;
    if (isInteger && Math.abs(value) > Number.MAX_SAFE_INTEGER) {
      throw new ValidationError(
        `${this.name}: invalid strict UTF-8 JSON: ${token.slice(0, 40)} exceeds safe integer domain for JSON floats`,
      );
    }
    return value;
  }
}
