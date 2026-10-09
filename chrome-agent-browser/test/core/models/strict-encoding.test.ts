/**
 * T10 (D-121, D-122, D-123; T9 review 1 nits 5 and 6): the OpenAI constraint for schemas with
 * optional properties and array roots, how an answer is read back from that encoding, the
 * reasoning effort, and a strict refusal remembered per schema.
 *
 * The diagnosis behind it: Literature Review's `normalize` was sent non-strict (optional provenance
 * fields) and Luna left `title` out of every paper in 3 of 7 attempts; `select` and `extract` (array
 * roots) were sent with no constraint at all. The decoding is deterministic and defined by the
 * package schema alone; validation against the full package schema still decides.
 */
import { describe, expect, it } from "vitest";

import type { JsonObject, JsonValue } from "../../../src/core/json.js";
import { DEFAULT_OPENAI_REASONING_EFFORT, OpenAIAdapter } from "../../../src/core/models/adapters/openai.js";
import { render } from "../../../src/core/models/render.js";
import { BoundModelRouter } from "../../../src/core/models/router.js";
import { admitsNull, decodeConstrained, envelopeArrayRoot, MAX_RESPONSE_FORMAT_BYTES, openAiConstraint } from "../../../src/core/models/schema-format.js";
import type { HttpRequest, HttpTransport } from "../../../src/core/models/transport.js";
import { failuresForSchema } from "../../../src/core/schema.js";

/** A bundled node schema, as `Workflow.modelSchema` writes it: optional fields, a nullable one, a nested reference. */
const PAPER: JsonObject = {
  $ref: "#/$defs/s0",
  $defs: {
    s0: {
      type: "object",
      additionalProperties: false,
      required: ["title", "provenance"],
      properties: {
        title: { type: "string", minLength: 1 },
        year: { type: ["integer", "null"] },
        venue: { type: "string" },
        provenance: { type: "array", items: { $ref: "#/$defs/s1" } },
      },
    },
    s1: {
      type: "object",
      additionalProperties: false,
      required: ["source"],
      properties: { source: { type: "string" }, locator: { type: ["string", "null"] }, retrieved_at: { type: "string" }, synthetic: { type: "boolean" } },
    },
  },
};

const LIST: JsonObject = { $ref: "#/$defs/s2", $defs: { s2: { type: "array", maxItems: 4, items: { $ref: "#/$defs/s3" } }, s3: { type: "object", additionalProperties: false, required: ["id"], properties: { id: { type: "string" }, note: { type: "string" } } } } };

describe("the strict encoding of optional properties (D-121)", () => {
  it("makes every property required; an optional one that does not admit null gets an explicit null alternative, one that does is left as it is", () => {
    const constraint = openAiConstraint(PAPER);
    expect(constraint.encodedOptional).toBe(true);
    expect(constraint.envelope).toBe(false);
    const strict = constraint.strict!;
    expect(strict.required).toEqual(["title", "year", "venue", "provenance"]);
    const properties = strict.properties as Record<string, JsonObject>;
    expect(properties.title).toEqual({ type: "string" }); // minLength dropped (strict mode refuses it)
    expect(properties.year).toEqual({ type: ["integer", "null"] });
    expect(properties.venue).toEqual({ anyOf: [{ type: "string" }, { type: "null" }] });
    const s1 = (strict.$defs as Record<string, JsonObject>).s1!;
    expect(s1.required).toEqual(["source", "locator", "retrieved_at", "synthetic"]);
    expect((s1.properties as Record<string, JsonObject>).retrieved_at).toEqual({ anyOf: [{ type: "string" }, { type: "null" }] });
    expect((s1.properties as Record<string, JsonObject>).locator).toEqual({ type: ["string", "null"] });
    // The non-strict copy is the package schema as before (the fallback when OpenAI refuses the strict one).
    expect(((constraint.nonStrict!.properties as Record<string, JsonObject>).title)).toEqual({ type: "string", minLength: 1 });
  });

  it("a schema without optional properties is strict without encoding", () => {
    const closed = JSON.parse(JSON.stringify(PAPER)) as JsonObject;
    const defs = closed.$defs as Record<string, JsonObject>;
    defs.s0!.required = ["title", "year", "venue", "provenance"];
    defs.s1!.required = ["source", "locator", "retrieved_at", "synthetic"];
    expect(openAiConstraint(closed)).toMatchObject({ encodedOptional: false, envelope: false });
  });

  it("reads null as admitted from a type list, an enum, a const, an anyOf or a reference", () => {
    const root: JsonObject = { $defs: { n: { type: "null" }, s: { type: "string" } } };
    expect(admitsNull({ type: ["string", "null"] }, root)).toBe(true);
    expect(admitsNull({ enum: ["a", null] }, root)).toBe(true);
    expect(admitsNull({ const: null }, root)).toBe(true);
    expect(admitsNull({ anyOf: [{ $ref: "#/$defs/s" }, { $ref: "#/$defs/n" }] }, root)).toBe(true);
    expect(admitsNull({ $ref: "#/$defs/s" }, root)).toBe(false);
    expect(admitsNull({ enum: ["a"] }, root)).toBe(false);
    expect(admitsNull({}, root)).toBe(true);
  });

  it("closes a nullable object in the strict copy (T9 review 1, nit 6)", () => {
    const schema: JsonObject = { type: "object", additionalProperties: false, required: ["search"], properties: { search: { type: ["object", "null"], required: ["origin"], properties: { origin: { type: "string" } } } } };
    const search = (openAiConstraint(schema).strict!.properties as Record<string, JsonObject>).search!;
    expect(search.additionalProperties).toBe(false);
  });
});

describe("the array-root envelope (D-122)", () => {
  it("wraps an array root as {items: …} with the $defs kept at the top, strict when the array qualifies", () => {
    expect(envelopeArrayRoot(PAPER)).toBeNull();
    const wrapped = envelopeArrayRoot(LIST)!;
    expect(wrapped).toMatchObject({ type: "object", required: ["items"], additionalProperties: false, properties: { items: { type: "array", maxItems: 4, items: { $ref: "#/$defs/s3" } } } });
    expect(Object.keys(wrapped.$defs as JsonObject)).toEqual(["s2", "s3"]);
    const constraint = openAiConstraint(LIST);
    expect(constraint).toMatchObject({ envelope: true, encodedOptional: true });
    expect(constraint.strict!.type).toBe("object");
    expect(constraint.nonStrict!.type).toBe("object");
  });

  it("an array whose items cannot be strict is still wrapped, non-strict", () => {
    const free: JsonObject = { type: "array", items: { type: "object", additionalProperties: { type: "string" } } };
    expect(openAiConstraint(free)).toMatchObject({ strict: null, envelope: true });
    expect(openAiConstraint(free).nonStrict).toMatchObject({ type: "object", properties: { items: { type: "array" } } });
  });
});

describe("reading an answer back (D-121, D-122)", () => {
  const both = { envelope: true, optional_nulls: true };

  it("drops a null only under a property the package leaves optional and whose schema does not admit null", async () => {
    const answer: JsonValue = { title: "T", year: null, venue: null, provenance: [{ source: "crossref", locator: null, retrieved_at: null, synthetic: null }] };
    const read = decodeConstrained(answer, PAPER, { envelope: false, optional_nulls: true });
    expect(read.value).toEqual({ title: "T", year: null, provenance: [{ source: "crossref", locator: null }] });
    expect(read).toMatchObject({ unwrapped: false, nullsDropped: 3 });
    expect(await failuresForSchema(PAPER, read.value)).toEqual([]);
  });

  it("leaves a null under a required property for validation to refuse", async () => {
    const read = decodeConstrained({ title: null, provenance: [] }, PAPER, { envelope: false, optional_nulls: true });
    expect(read.value).toEqual({ title: null, provenance: [] });
    expect(read.nullsDropped).toBe(0);
    expect((await failuresForSchema(PAPER, read.value)).length).toBeGreaterThan(0);
  });

  it("unwraps {items: …} and decodes inside it; anything else is left as it came", () => {
    expect(decodeConstrained({ items: [{ id: "a", note: null }] }, LIST, both)).toEqual({ value: [{ id: "a" }], unwrapped: true, nullsDropped: 1 });
    expect(decodeConstrained([{ id: "a" }], LIST, both)).toMatchObject({ value: [{ id: "a" }], unwrapped: false });
    expect(decodeConstrained({ items: [], extra: 1 }, LIST, both)).toMatchObject({ value: { items: [], extra: 1 }, unwrapped: false });
    // Without the envelope flag nothing is unwrapped.
    expect(decodeConstrained({ items: [] }, LIST, { envelope: false, optional_nulls: false }).value).toEqual({ items: [] });
  });

  it("follows an anyOf only when exactly one branch matches the value's type", () => {
    const schema: JsonObject = {
      anyOf: [
        { type: "object", properties: { a: { type: "string" } } },
        { type: "object", properties: { b: { type: "string" } } },
      ],
    };
    expect(decodeConstrained({ a: null }, schema, { envelope: false, optional_nulls: true }).value).toEqual({ a: null });
    const single: JsonObject = { anyOf: [{ type: "null" }, { type: "object", properties: { a: { type: "string" } } }] };
    expect(decodeConstrained({ a: null }, single, { envelope: false, optional_nulls: true }).value).toEqual({});
  });

  it("a schema whose forced null the decoder could not read back keeps the non-strict request (T10 review 1, finding 1; D-132)", async () => {
    // Two object branches with optional properties: a strict copy would force `a: null` into an
    // answer that the decoder, finding two matching branches, leaves for validation to refuse.
    const ambiguous: JsonObject = {
      type: "object",
      additionalProperties: false,
      required: ["pick"],
      properties: {
        pick: {
          anyOf: [
            { type: "object", additionalProperties: false, required: ["kind"], properties: { kind: { const: "a" }, a: { type: "string" } } },
            { type: "object", additionalProperties: false, required: ["kind"], properties: { kind: { const: "b" }, b: { type: "string" } } },
          ],
        },
      },
    };
    const forced = { pick: { kind: "a", a: null, b: null } };
    expect(decodeConstrained(forced, ambiguous, { envelope: false, optional_nulls: true }).value).toEqual(forced);
    expect((await failuresForSchema(ambiguous, forced, "x")).length).toBeGreaterThan(0);
    const constraint = openAiConstraint(ambiguous);
    expect(constraint).toMatchObject({ strict: null, encodedOptional: false });
    expect(constraint.nonStrict).not.toBeNull();
    // The same through a reference, and with an untyped branch (it matches every type).
    const viaRef: JsonObject = { $ref: "#/$defs/r", $defs: { r: { type: "object", additionalProperties: false, required: ["pick"], properties: { pick: { anyOf: [{ $ref: "#/$defs/o" }, { enum: ["none"] }] } } }, o: { type: "object", additionalProperties: false, required: [], properties: { note: { type: "string" } } } } };
    expect(openAiConstraint(viaRef).strict).toBeNull();
    // An integer branch and a number branch both match an integer value.
    const numeric: JsonObject = { type: "object", additionalProperties: false, required: ["v"], properties: { v: { anyOf: [{ type: "integer" }, { type: "number" }] }, note: { type: "string" } } };
    expect(openAiConstraint(numeric).strict).not.toBeNull(); // no optional beneath the anyOf: decodable
  });

  it("an anyOf whose branches differ by type, or that holds nothing encoded, stays strict and decodes", async () => {
    const distinct: JsonObject = {
      type: "object",
      additionalProperties: false,
      required: ["pick"],
      properties: { pick: { anyOf: [{ type: "string" }, { type: "object", additionalProperties: false, required: ["kind"], properties: { kind: { type: "string" }, note: { type: "string" } } }] } },
    };
    const constraint = openAiConstraint(distinct);
    expect(constraint).toMatchObject({ encodedOptional: true });
    expect(constraint.strict).not.toBeNull();
    const decoded = decodeConstrained({ pick: { kind: "k", note: null } }, distinct, { envelope: false, optional_nulls: true }).value;
    expect(decoded).toEqual({ pick: { kind: "k" } });
    expect(await failuresForSchema(distinct, decoded, "x")).toEqual([]);
    // Two object branches with every property required: nothing is forced, so nothing to read back.
    const closed: JsonObject = { type: "object", additionalProperties: false, required: ["pick"], properties: { pick: { anyOf: [{ type: "object", additionalProperties: false, required: ["a"], properties: { a: { type: "string" } } }, { type: "object", additionalProperties: false, required: ["b"], properties: { b: { type: "string" } } }] } } };
    expect(openAiConstraint(closed)).toMatchObject({ encodedOptional: false });
    expect(openAiConstraint(closed).strict).not.toBeNull();
  });

  it("does nothing when the request encoded nothing", () => {
    const answer = { title: "T", venue: null, provenance: [] };
    expect(decodeConstrained(answer, PAPER, { envelope: false, optional_nulls: false })).toEqual({ value: answer, unwrapped: false, nullsDropped: 0 });
  });
});

const OK = (text: string) => ({ status: "completed", model: "gpt-5.6-luna", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text }] }], usage: { input_tokens: 300, output_tokens: 20, total_tokens: 320 } });

function scripted(answers: Array<{ status: number; body: unknown }>): { transport: HttpTransport; bodies: JsonObject[] } {
  const bodies: JsonObject[] = [];
  const transport: HttpTransport = async (request: HttpRequest) => {
    bodies.push(JSON.parse(request.body!) as JsonObject);
    const answer = answers[Math.min(bodies.length - 1, answers.length - 1)]!;
    return { status: answer.status, headers: { "content-type": "application/json" }, body: JSON.stringify(answer.body) };
  };
  return { transport, bodies };
}

const request = (schema: JsonObject) => ({
  task: "extract",
  instructions: ["Return the rows."],
  data: { x: 1 },
  output_schema: schema,
  requirements: { id: "extract", capabilities: ["structured_output"], context_window: 16000, preferred_tier: "reasoning" },
  budget_context: { max_output_tokens: 100 },
  audit_context: { worker: "W:1", node_id: "extract" },
});

const formatOf = (body: JsonObject) => (body.text as JsonObject | undefined)?.format as JsonObject | undefined;

describe("OpenAIAdapter and the bound router with the encoding", () => {
  it("an array root is sent wrapped and strict; the router unwraps and decodes the answer before validating it, and records that it did", async () => {
    const net = scripted([{ status: 200, body: OK('{"items":[{"id":"a","note":null},{"id":"b","note":"kept"}]}') }]);
    const adapter = new OpenAIAdapter({ transport: net.transport, model: "gpt-5.6-luna", apiKey: "sk-test", contextWindow: 272000, reasoning: true });
    const router = new BoundModelRouter(adapter);
    const result = await router.complete(request(LIST), 100, new AbortController().signal);
    expect(formatOf(net.bodies[0]!)).toMatchObject({ strict: true, schema: { type: "object", required: ["items"] } });
    expect(result.output).toEqual([{ id: "a" }, { id: "b", note: "kept" }]);
    expect(router.lastCompletion).toMatchObject({ decoded: { envelope_unwrapped: true, nulls_read_as_absent: 1 }, constrained_by_host: true });
    expect(String(router.lastCompletion!.constraint_detail)).toContain('wrapped as {"items": …}');
  });

  it("a bare array answer to a wrapped request is validated as it came", async () => {
    const net = scripted([{ status: 200, body: OK('[{"id":"a"}]') }]);
    const router = new BoundModelRouter(new OpenAIAdapter({ transport: net.transport, model: "gpt-5.6-luna", apiKey: "sk-test", contextWindow: 272000 }));
    expect((await router.complete(request(LIST), 100, new AbortController().signal)).output).toEqual([{ id: "a" }]);
  });

  it("after a refusal the non-strict copy is not null-decoded: a null the model wrote there is the model's own", async () => {
    const refusal = { error: { message: "Invalid schema for response_format 'agentpkg_node_output'", param: "text.format.schema" } };
    const net = scripted([{ status: 400, body: refusal }, { status: 200, body: OK('{"title":"T","venue":null,"provenance":[]}') }]);
    const router = new BoundModelRouter(new OpenAIAdapter({ transport: net.transport, model: "gpt-5.6-luna", apiKey: "sk-test", contextWindow: 272000 }));
    await expect(router.complete(request(PAPER), 100, new AbortController().signal)).rejects.toMatchObject({ code: "model_output_not_conforming" });
  });

  it("remembers a strict refusal per schema: later calls go non-strict directly and say so (T9 review 1, nit 5b)", async () => {
    const refusal = { error: { message: "Invalid schema for response_format 'agentpkg_node_output': 'anyOf' is not permitted", param: "text.format.schema" } };
    const net = scripted([{ status: 400, body: refusal }, { status: 200, body: OK('{"title":"T","provenance":[]}') }]);
    const adapter = new OpenAIAdapter({ transport: net.transport, model: "gpt-5.6-luna", apiKey: "sk-test", contextWindow: 272000 });
    const rendered = render(request(PAPER));
    await adapter.complete(rendered, 100, new AbortController().signal);
    const second = await adapter.complete(rendered, 100, new AbortController().signal);
    expect(net.bodies.map((body) => formatOf(body)?.strict)).toEqual([true, false, false]);
    expect(second.constraint_detail).toContain("remembered from an earlier call");
    expect(second.decoding).toBeUndefined();
  });

  it("when the strict copy is refused and no non-strict copy fits, the request goes without a format and says it was not constrained (T9 review 1, nit 5a)", async () => {
    // `examples` are dropped from the strict copy only: the non-strict copy is oversized, the strict one is not.
    const big: JsonObject = { type: "object", additionalProperties: false, required: ["a"], properties: { a: { type: "string", examples: ["x".repeat(MAX_RESPONSE_FORMAT_BYTES)] } } };
    expect(openAiConstraint(big)).toMatchObject({ nonStrict: null });
    expect(openAiConstraint(big).strict).not.toBeNull();
    const refusal = { error: { message: "Invalid schema for response_format 'agentpkg_node_output'", param: "text.format.schema" } };
    const net = scripted([{ status: 400, body: refusal }, { status: 200, body: OK('{"a":"y"}') }]);
    const answer = await new OpenAIAdapter({ transport: net.transport, model: "gpt-5.6-luna", apiKey: "sk-test", contextWindow: 272000 }).complete(render(request(big)), 100, new AbortController().signal);
    expect(formatOf(net.bodies[1]!)).toBeUndefined();
    expect(answer.constrained).toBe(false);
    expect(answer.constraint_detail).toContain("with no text format");
  });
});

describe("the OpenAI reasoning effort (D-123)", () => {
  it("defaults to medium for a model that reasons, takes the connection's setting, and is recorded in the router's description; a model that does not reason gets none", async () => {
    expect(DEFAULT_OPENAI_REASONING_EFFORT).toBe("medium");
    const efforts: unknown[] = [];
    for (const options of [{ reasoning: true }, { reasoning: true, reasoningEffort: "low" as const }, { reasoning: false, reasoningEffort: "high" as const }]) {
      const net = scripted([{ status: 200, body: OK('{"title":"T","provenance":[]}') }]);
      const adapter = new OpenAIAdapter({ transport: net.transport, model: "gpt-5.6-luna", apiKey: "sk-test", contextWindow: 272000, ...options });
      await adapter.complete(render(request(PAPER)), 100, new AbortController().signal);
      efforts.push([net.bodies[0]!.reasoning ?? null, new BoundModelRouter(adapter).describe().reasoning_effort ?? null]);
    }
    expect(efforts).toEqual([
      [{ effort: "medium" }, "medium"],
      [{ effort: "low" }, "low"],
      [null, null],
    ]);
  });
});
