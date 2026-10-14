/**
 * The YAML subset of memory.v0 (§2.3, M-7): mappings, block and flow sequences, double-quoted
 * strings with JSON escapes, plain scalars read as JSON literals or strings, the empty mapping
 * `{}`; no comments, anchors, tags, multi-line scalars, single quotes or tabs. Small enough to
 * implement without a library in both runtimes; this is the port of the reference reader and
 * writer in `scripts/check_memory_spec.py`, line for line, so both write identical bytes.
 */
import type { JsonObject, JsonValue } from "../json.js";

export class FrontmatterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FrontmatterError";
  }
}

const KEY = /^([a-z][a-z0-9_]{0,63}):(?: (.*))?$/u;
const PLAIN = /^[^"'[\]{}#&*!|>%@,\s][^#]*$/u;
const NUMBER = /^-?(0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?$/u;

type Entry = [line: number, indent: number, content: string];

function scalar(raw: string, line: number): JsonValue {
  const text = raw.trim();
  if (text.startsWith('"')) {
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch (error) {
      throw new FrontmatterError(`line ${line}: bad quoted string (${error instanceof Error ? error.message : "invalid"})`);
    }
    if (typeof value !== "string") throw new FrontmatterError(`line ${line}: a quoted scalar must be a string`);
    return value;
  }
  if (text === "{}") return {};
  if (text.startsWith("[") && text.endsWith("]")) {
    const inner = text.slice(1, -1).trim();
    if (inner === "") return [];
    return splitFlow(inner, line).map((item) => scalar(item, line));
  }
  if (!PLAIN.test(text)) throw new FrontmatterError(`line ${line}: scalar outside the subset: ${JSON.stringify(text.slice(0, 40))}`);
  if (text === "true") return true;
  if (text === "false") return false;
  if (text === "null") return null;
  if (NUMBER.test(text)) return JSON.parse(text) as number;
  return text;
}

/** Split a flow sequence on the commas outside double-quoted strings, keeping JSON escapes whole. */
function splitFlow(inner: string, line: number): string[] {
  const items: string[] = [];
  let current = "";
  let quoted = false;
  let index = 0;
  while (index < inner.length) {
    const char = inner[index]!;
    if (quoted && char === "\\" && index + 1 < inner.length) {
      current += char + inner[index + 1]!;
      index += 2;
      continue;
    }
    if (char === '"') quoted = !quoted;
    if (char === "," && !quoted) {
      items.push(current);
      current = "";
    } else current += char;
    index += 1;
  }
  if (quoted) throw new FrontmatterError(`line ${line}: unterminated string in a flow sequence`);
  items.push(current);
  return items.map((item) => item.trim());
}

export function parseFrontmatter(text: string): JsonObject {
  const entries: Entry[] = [];
  text.split("\n").forEach((raw, offset) => {
    const number = offset + 1;
    if (raw.trim() === "") throw new FrontmatterError(`line ${number}: blank line inside the frontmatter`);
    if (raw.includes("\t")) throw new FrontmatterError(`line ${number}: tab`);
    const indent = raw.length - raw.replace(/^ +/u, "").length;
    if (indent % 2 !== 0) throw new FrontmatterError(`line ${number}: odd indentation`);
    entries.push([number, indent, raw.slice(indent)]);
  });
  const [value, index] = mapping(entries, 0, 0);
  if (index !== entries.length) throw new FrontmatterError(`line ${entries[index]![0]}: unexpected content`);
  return value;
}

function mapping(entries: Entry[], start: number, indent: number): [JsonObject, number] {
  const result: JsonObject = {};
  let index = start;
  while (index < entries.length) {
    const [number, found, content] = entries[index]!;
    if (found < indent || content.startsWith("- ")) break;
    if (found > indent) throw new FrontmatterError(`line ${number}: unexpected indentation`);
    const match = KEY.exec(content);
    if (!match) throw new FrontmatterError(`line ${number}: expected \`key: value\``);
    const key = match[1]!;
    const rest = match[2];
    if (Object.hasOwn(result, key)) throw new FrontmatterError(`line ${number}: duplicate key ${key}`);
    let value: JsonValue;
    if (rest === undefined || rest === "") {
      index += 1;
      if (index < entries.length && entries[index]![1] >= indent) {
        const [, nested, nextContent] = entries[index]!;
        if (nextContent.startsWith("- ") && (nested === indent || nested === indent + 2)) [value, index] = sequence(entries, index, nested);
        else if (nested === indent + 2 && !nextContent.startsWith("- ")) [value, index] = mapping(entries, index, nested);
        else throw new FrontmatterError(`line ${number}: ${key} has no value`);
      } else throw new FrontmatterError(`line ${number}: ${key} has no value`);
    } else {
      value = scalar(rest, number);
      index += 1;
    }
    Object.defineProperty(result, key, { value, enumerable: true, writable: true, configurable: true });
  }
  return [result, index];
}

function sequence(entries: Entry[], start: number, indent: number): [JsonValue[], number] {
  const items: JsonValue[] = [];
  let index = start;
  while (index < entries.length) {
    const [number, found, content] = entries[index]!;
    if (found !== indent || !content.startsWith("- ")) break;
    const item = content.slice(2);
    let value: JsonValue;
    if (KEY.test(item)) {
      entries[index] = [number, indent + 2, item];
      [value, index] = mapping(entries, index, indent + 2);
    } else {
      value = scalar(item, number);
      index += 1;
    }
    items.push(value);
  }
  return [items, index];
}

function writeScalar(value: JsonValue): string {
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean" || value === null || typeof value === "number") {
    if (typeof value === "number" && !Number.isFinite(value)) throw new FrontmatterError("not a finite number");
    return JSON.stringify(value);
  }
  throw new FrontmatterError(`not a scalar: ${Array.isArray(value) ? "list" : typeof value}`);
}

function writeMapping(mapping: JsonObject, indent: number): string[] {
  const lines: string[] = [];
  const pad = " ".repeat(indent);
  for (const [key, value] of Object.entries(mapping)) {
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      if (Object.keys(value).length === 0) lines.push(`${pad}${key}: {}`);
      else {
        lines.push(`${pad}${key}:`);
        lines.push(...writeMapping(value, indent + 2));
      }
    } else if (Array.isArray(value)) {
      if (value.length === 0) lines.push(`${pad}${key}: []`);
      else {
        lines.push(`${pad}${key}:`);
        lines.push(...writeSequence(value, indent + 2));
      }
    } else lines.push(`${pad}${key}: ${writeScalar(value)}`);
  }
  return lines;
}

function writeSequence(items: JsonValue[], indent: number): string[] {
  const lines: string[] = [];
  const pad = " ".repeat(indent);
  for (const item of items) {
    if (typeof item === "object" && item !== null && !Array.isArray(item)) {
      if (Object.keys(item).length === 0) {
        lines.push(`${pad}- {}`);
        continue;
      }
      const nested = writeMapping(item, indent + 2);
      lines.push(`${pad}- ${nested[0]!.replace(/^ +/u, "")}`);
      lines.push(...nested.slice(1));
    } else if (Array.isArray(item)) throw new FrontmatterError("a sequence inside a sequence is outside the subset");
    else lines.push(`${pad}- ${writeScalar(item)}`);
  }
  return lines;
}

export function writeFrontmatter(mapping: JsonObject): string {
  return writeMapping(mapping, 0).join("\n");
}

/** The frontmatter text and the body of a record file (the body with its one leading empty line removed). */
export function splitDocument(text: string): [head: string, body: string] {
  if (!text.startsWith("---\n")) throw new FrontmatterError("line 1: the file does not start with `---`");
  const end = text.indexOf("\n---\n", 3);
  if (end < 0) {
    if (text.endsWith("\n---")) return [text.slice(4, -4), ""];
    throw new FrontmatterError("the frontmatter is not closed by `---`");
  }
  const head = text.slice(4, end);
  let body = text.slice(end + 5);
  if (body.startsWith("\n")) body = body.slice(1);
  return [head, body];
}
