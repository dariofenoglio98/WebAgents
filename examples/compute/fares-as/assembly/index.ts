// Fare totals as a compute.v0 module (AssemblyScript).
//
// The host hands this module one JSON text and reads one JSON text back; the module imports
// nothing, so it can only compute over those bytes (compute.v0 §3, D-185). Every amount is an
// integer number of cents, every check that fails is a trap (`unreachable`), which the runtime
// reports as `compute_error` with `trap_code: unreachable`: a module never returns half an
// answer. The JSON reader and writer below are the module's own, small and strict: no library
// is needed for a transform like this, and a reviewer can read the whole thing.
//
// Input
//   {"currency": "USD", "tax_rate_bps": 850,
//    "items": [{"label": "WA101 Economy Standard", "amount_cents": 42900, "quantity": 2}, ...]}
// Output
//   {"currency": "USD", "lines": [{"label": ..., "amount_cents": ..., "quantity": ...,
//    "total_cents": ...}], "subtotal_cents": ..., "tax_cents": ..., "total_cents": ...}
// Tax is rounded half up on the subtotal; totals stay below 2^53 so they survive any JSON
// reader; the build options (asconfig.json) remove the abort import and start the memory at
// one page with a declared maximum of 64.

// ---------------------------------------------------------------------------------------------
// The ABI (compute.v0 §3): `memory` is exported by the compiler; `alloc` hands the host a region
// for the input; `run` returns the output's pointer and length packed into one i64.

export function alloc(len: i32): i32 {
  return <i32>heap.alloc(<usize>len);
}

export function run(ptr: i32, len: i32): i64 {
  const text = String.UTF8.decodeUnsafe(<usize>ptr, <usize>len);
  const input = Parser.parse(text);
  const output = fareTotals(input);
  const bytes = String.UTF8.encode(output);
  return (<i64>changetype<usize>(bytes) << 32) | <i64>bytes.byteLength;
}

// ---------------------------------------------------------------------------------------------
// The transform.

const MAX_SAFE: i64 = 9007199254740991; // 2^53 - 1

function fareTotals(input: Json): string {
  const currency = input.field("currency").asString();
  if (currency.length < 3 || currency.length > 3) unreachable();
  const taxRate = input.field("tax_rate_bps").asInt();
  if (taxRate < 0 || taxRate > 10000) unreachable();
  const items = input.field("items").asArray();
  if (items.length == 0 || items.length > 64) unreachable();
  const out = new Writer();
  out.beginObject();
  out.key("currency").string(currency);
  out.key("lines").beginArray();
  let subtotal: i64 = 0;
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const label = item.field("label").asString();
    if (label.length == 0 || label.length > 200) unreachable();
    const amount = item.field("amount_cents").asInt();
    const quantity = item.field("quantity").asInt();
    if (amount < 0 || amount > MAX_SAFE || quantity < 1 || quantity > 9) unreachable();
    const total = amount * quantity;
    if (total > MAX_SAFE) unreachable();
    subtotal += total;
    if (subtotal > MAX_SAFE) unreachable();
    out.beginObject();
    out.key("label").string(label);
    out.key("amount_cents").integer(amount);
    out.key("quantity").integer(quantity);
    out.key("total_cents").integer(total);
    out.endObject();
  }
  out.endArray();
  // Half up: (subtotal × rate + 5000) / 10000 in integers; subtotal × 10000 stays far below 2^63.
  const tax: i64 = (subtotal * taxRate + 5000) / 10000;
  const grand: i64 = subtotal + tax;
  if (grand > MAX_SAFE) unreachable();
  out.key("subtotal_cents").integer(subtotal);
  out.key("tax_cents").integer(tax);
  out.key("total_cents").integer(grand);
  out.endObject();
  return out.text();
}

// ---------------------------------------------------------------------------------------------
// A strict JSON reader: RFC 8259 grammar, no duplicate member names, integers kept exact when
// they fit an i64 and carry no fraction or exponent. Anything else is a trap.

const enum Kind {
  Null,
  Bool,
  Number,
  String,
  Array,
  Object,
}

class Json {
  kind: Kind;
  bool: bool = false;
  number: f64 = 0;
  isInteger: bool = false;
  integer: i64 = 0;
  text: string = "";
  items: Json[] = [];
  keys: string[] = [];
  values: Json[] = [];

  constructor(kind: Kind) {
    this.kind = kind;
  }

  field(name: string): Json {
    if (this.kind != Kind.Object) unreachable();
    for (let i = 0; i < this.keys.length; i++) {
      if (this.keys[i] == name) return this.values[i];
    }
    unreachable();
    return this; // unreachable
  }

  asString(): string {
    if (this.kind != Kind.String) unreachable();
    return this.text;
  }

  asInt(): i64 {
    if (this.kind != Kind.Number || !this.isInteger) unreachable();
    return this.integer;
  }

  asArray(): Json[] {
    if (this.kind != Kind.Array) unreachable();
    return this.items;
  }
}

class Parser {
  text: string;
  pos: i32 = 0;

  constructor(text: string) {
    this.text = text;
  }

  static parse(text: string): Json {
    const parser = new Parser(text);
    parser.skipSpace();
    const value = parser.value(0);
    parser.skipSpace();
    if (parser.pos != text.length) unreachable();
    return value;
  }

  private peek(): i32 {
    return this.pos < this.text.length ? this.text.charCodeAt(this.pos) : -1;
  }

  private next(): i32 {
    if (this.pos >= this.text.length) unreachable();
    return this.text.charCodeAt(this.pos++);
  }

  private expect(code: i32): void {
    if (this.next() != code) unreachable();
  }

  private skipSpace(): void {
    while (this.pos < this.text.length) {
      const c = this.text.charCodeAt(this.pos);
      if (c == 0x20 || c == 0x09 || c == 0x0a || c == 0x0d) this.pos++;
      else break;
    }
  }

  private value(depth: i32): Json {
    if (depth > 32) unreachable();
    const c = this.peek();
    if (c == 0x7b) return this.object(depth);
    if (c == 0x5b) return this.array(depth);
    if (c == 0x22) {
      const value = new Json(Kind.String);
      value.text = this.string();
      return value;
    }
    if (c == 0x74) return this.literal("true", Kind.Bool, true);
    if (c == 0x66) return this.literal("false", Kind.Bool, false);
    if (c == 0x6e) return this.literal("null", Kind.Null, false);
    if (c == 0x2d || (c >= 0x30 && c <= 0x39)) return this.number();
    unreachable();
    return new Json(Kind.Null);
  }

  private literal(word: string, kind: Kind, flag: bool): Json {
    for (let i = 0; i < word.length; i++) this.expect(word.charCodeAt(i));
    const value = new Json(kind);
    value.bool = flag;
    return value;
  }

  private object(depth: i32): Json {
    this.expect(0x7b);
    const value = new Json(Kind.Object);
    this.skipSpace();
    if (this.peek() == 0x7d) {
      this.pos++;
      return value;
    }
    while (true) {
      this.skipSpace();
      const key = this.string();
      for (let i = 0; i < value.keys.length; i++) if (value.keys[i] == key) unreachable();
      this.skipSpace();
      this.expect(0x3a);
      this.skipSpace();
      value.keys.push(key);
      value.values.push(this.value(depth + 1));
      this.skipSpace();
      const c = this.next();
      if (c == 0x7d) return value;
      if (c != 0x2c) unreachable();
    }
  }

  private array(depth: i32): Json {
    this.expect(0x5b);
    const value = new Json(Kind.Array);
    this.skipSpace();
    if (this.peek() == 0x5d) {
      this.pos++;
      return value;
    }
    while (true) {
      this.skipSpace();
      value.items.push(this.value(depth + 1));
      this.skipSpace();
      const c = this.next();
      if (c == 0x5d) return value;
      if (c != 0x2c) unreachable();
    }
  }

  private string(): string {
    this.expect(0x22);
    let out = "";
    while (true) {
      const c = this.next();
      if (c == 0x22) return out;
      if (c < 0x20) unreachable();
      if (c != 0x5c) {
        out += String.fromCharCode(c);
        continue;
      }
      const e = this.next();
      if (e == 0x22 || e == 0x5c || e == 0x2f) out += String.fromCharCode(e);
      else if (e == 0x62) out += "\b";
      else if (e == 0x66) out += "\f";
      else if (e == 0x6e) out += "\n";
      else if (e == 0x72) out += "\r";
      else if (e == 0x74) out += "\t";
      else if (e == 0x75) out += String.fromCharCode(this.hex4());
      else unreachable();
    }
  }

  private hex4(): i32 {
    let value = 0;
    for (let i = 0; i < 4; i++) {
      const c = this.next();
      let digit: i32;
      if (c >= 0x30 && c <= 0x39) digit = c - 0x30;
      else if (c >= 0x61 && c <= 0x66) digit = c - 0x61 + 10;
      else if (c >= 0x41 && c <= 0x46) digit = c - 0x41 + 10;
      else {
        unreachable();
        digit = 0;
      }
      value = value * 16 + digit;
    }
    return value;
  }

  private number(): Json {
    const start = this.pos;
    let negative = false;
    if (this.peek() == 0x2d) {
      negative = true;
      this.pos++;
    }
    let integer: i64 = 0;
    let digits = 0;
    let first = this.peek();
    if (first == 0x30) {
      this.pos++;
      digits = 1;
      if (this.peek() >= 0x30 && this.peek() <= 0x39) unreachable();
    } else if (first >= 0x31 && first <= 0x39) {
      while (this.peek() >= 0x30 && this.peek() <= 0x39) {
        if (digits >= 18) unreachable();
        integer = integer * 10 + <i64>(this.next() - 0x30);
        digits++;
      }
    } else unreachable();
    let exact = true;
    if (this.peek() == 0x2e) {
      exact = false;
      this.pos++;
      if (!(this.peek() >= 0x30 && this.peek() <= 0x39)) unreachable();
      while (this.peek() >= 0x30 && this.peek() <= 0x39) this.pos++;
    }
    if (this.peek() == 0x65 || this.peek() == 0x45) {
      exact = false;
      this.pos++;
      if (this.peek() == 0x2b || this.peek() == 0x2d) this.pos++;
      if (!(this.peek() >= 0x30 && this.peek() <= 0x39)) unreachable();
      while (this.peek() >= 0x30 && this.peek() <= 0x39) this.pos++;
    }
    const value = new Json(Kind.Number);
    value.number = parseFloat(this.text.substring(start, this.pos));
    value.isInteger = exact;
    value.integer = negative ? -integer : integer;
    return value;
  }
}

// ---------------------------------------------------------------------------------------------
// A JSON writer for the output: members in the order written, strings escaped per RFC 8259.

class Writer {
  private out: string = "";
  private needComma: bool = false;

  private separator(): void {
    if (this.needComma) this.out += ",";
    this.needComma = true;
  }

  beginObject(): Writer {
    this.separator();
    this.out += "{";
    this.needComma = false;
    return this;
  }

  endObject(): Writer {
    this.out += "}";
    this.needComma = true;
    return this;
  }

  beginArray(): Writer {
    this.separator();
    this.out += "[";
    this.needComma = false;
    return this;
  }

  endArray(): Writer {
    this.out += "]";
    this.needComma = true;
    return this;
  }

  key(name: string): Writer {
    this.separator();
    this.out += Writer.quote(name) + ":";
    this.needComma = false;
    return this;
  }

  string(value: string): Writer {
    this.separator();
    this.out += Writer.quote(value);
    return this;
  }

  integer(value: i64): Writer {
    this.separator();
    this.out += value.toString();
    return this;
  }

  text(): string {
    return this.out;
  }

  static quote(value: string): string {
    let out = '"';
    for (let i = 0; i < value.length; i++) {
      const c = value.charCodeAt(i);
      if (c == 0x22) out += '\\"';
      else if (c == 0x5c) out += "\\\\";
      else if (c == 0x0a) out += "\\n";
      else if (c == 0x0d) out += "\\r";
      else if (c == 0x09) out += "\\t";
      else if (c < 0x20) out += "\\u" + ("000" + c.toString(16)).slice(-4);
      else out += String.fromCharCode(c);
    }
    return out + '"';
  }
}
