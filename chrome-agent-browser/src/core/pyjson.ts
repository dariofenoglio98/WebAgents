/**
 * Python's `json.dumps` and `datetime.isoformat` layouts, where a byte count or a record
 * layout must agree with the reference.
 *
 * `FixtureRouter`'s synthetic accounting unit is `ceil(UTF-8 bytes of
 * json.dumps(value, ensure_ascii=False, sort_keys=True) / 4)` (`fixtures.py`), with Python's
 * default separators `", "` and `": "`. The string escaping of `json.dumps(ensure_ascii=False)`
 * is the one `JSON.stringify` performs (`"`, `\`, C0 controls), and sorting object keys by
 * UTF-16 code units equals Python's code-point order for every key without astral characters.
 * Numbers differ in one place: Python distinguishes `1.0` from `1`; JavaScript has one number
 * type, so an integral value is always written as an integer here (D-063 records the effect).
 */

/** `repr(float)` for a non-integral finite number: shortest round-trip digits, Python's thresholds. */
export function pyFloatRepr(value: number): string {
  if (!Number.isFinite(value)) throw new RangeError("non-finite float");
  if (Number.isInteger(value) && Math.abs(value) < 1e16) return `${value}.0`;
  const negative = value < 0;
  const scientific = Math.abs(value).toExponential();
  const [mantissa, exponentText] = scientific.split("e") as [string, string];
  const exponent = Number(exponentText);
  const digits = mantissa.replace(".", "");
  let text: string;
  if (exponent >= -4 && exponent < 16) {
    if (exponent >= 0) {
      const whole = digits.slice(0, exponent + 1).padEnd(exponent + 1, "0");
      const fraction = digits.slice(exponent + 1);
      text = fraction ? `${whole}.${fraction}` : `${whole}.0`;
    } else {
      text = `0.${"0".repeat(-exponent - 1)}${digits}`;
    }
  } else {
    const fraction = digits.slice(1);
    const sign = exponent < 0 ? "-" : "+";
    const magnitude = String(Math.abs(exponent)).padStart(2, "0");
    text = `${digits[0]}${fraction ? `.${fraction}` : ""}e${sign}${magnitude}`;
  }
  return negative ? `-${text}` : text;
}

function pyNumber(value: number): string {
  if (!Number.isFinite(value)) throw new RangeError("json.dumps(allow_nan=False) refuses a non-finite number");
  if (Number.isInteger(value)) return Object.is(value, -0) ? "-0.0" : `${value}`;
  return pyFloatRepr(value);
}

export interface DumpsOptions {
  sortKeys?: boolean;
  /** `separators=(",", ":")`; the default is Python's `(", ", ": ")`. */
  compact?: boolean;
}

/** `json.dumps(value, ensure_ascii=False, allow_nan=False, …)`. */
export function pyJsonDumps(value: unknown, options: DumpsOptions = {}): string {
  const item = options.compact ? "," : ", ";
  const key = options.compact ? ":" : ": ";
  const encode = (node: unknown): string => {
    if (node === null) return "null";
    switch (typeof node) {
      case "boolean":
        return node ? "true" : "false";
      case "number":
        return pyNumber(node);
      case "string":
        return JSON.stringify(node);
      case "object": {
        if (Array.isArray(node)) return `[${node.map(encode).join(item)}]`;
        const record = node as Record<string, unknown>;
        const keys = Object.keys(record);
        if (options.sortKeys) keys.sort();
        return `{${keys.map((name) => `${JSON.stringify(name)}${key}${encode(record[name])}`).join(item)}}`;
      }
      default:
        throw new TypeError(`Object of type ${typeof node} is not JSON serializable`);
    }
  };
  return encode(value);
}

/** UTF-8 byte length of a string. */
export function utf8Length(text: string): number {
  return new TextEncoder().encode(text).length;
}

/** `datetime.now(UTC).isoformat()`: microseconds (from milliseconds) and `+00:00`, no fraction when zero. */
export function pyIsoTimestamp(date: Date = new Date()): string {
  const base = date.toISOString(); // YYYY-MM-DDTHH:MM:SS.sssZ
  const milliseconds = date.getUTCMilliseconds();
  const stem = base.slice(0, 19);
  const fraction = milliseconds === 0 ? "" : `.${String(milliseconds * 1000).padStart(6, "0")}`;
  return `${stem}${fraction}+00:00`;
}
