/**
 * D-115 (T9, the user's two Luna runs of 2026-10-09): force the package's format where the
 * provider can, and ask once more where it still is not met.
 *
 * - OpenAI gets a strict json_schema (constrained decoding) when the package schema can be one
 *   without changing its meaning, and the non-strict request otherwise, or when OpenAI refuses
 *   the strict copy.
 * - A live router's answer that breaks the output schema is asked for once more, with a fresh
 *   reservation and audit pair, charged what the provider reported; a replay router never is.
 */
import { describe, expect, it } from "vitest";

import { fixtureAdapters } from "../../../src/core/fixtures.js";
import type { JsonObject, JsonValue } from "../../../src/core/json.js";
import { OpenAIAdapter, strictSchemaRefused } from "../../../src/core/models/adapters/openai.js";
import type { ModelRequest, ModelResult, ModelRouter } from "../../../src/core/models/contract.js";
import { render } from "../../../src/core/models/render.js";
import { openAiStrictSchema } from "../../../src/core/models/schema-format.js";
import type { HttpRequest, HttpTransport } from "../../../src/core/models/transport.js";
import { loadPackageBytes } from "../../../src/core/package.js";
import { AdapterError, WorkflowError } from "../../../src/core/workflow/errors.js";
import { readBytes, SHIPPED } from "../../helpers/paths.js";
import { loadSource, sourceTree } from "../../helpers/source-tree.js";
import { createWorkflow, sessionGrants } from "../../helpers/workflow.js";
import { runWorkflow } from "../../../src/core/workflow/interpreter.js";

const CLOSED: JsonObject = {
  $ref: "#/$defs/s0",
  $defs: {
    s0: {
      type: "object",
      additionalProperties: false,
      required: ["date", "note", "rows"],
      properties: {
        date: { type: "string", pattern: "^[0-9]{4}-[0-9]{2}-[0-9]{2}$" },
        note: { type: ["string", "null"], minLength: 1, maxLength: 300 },
        rows: { type: "array", maxItems: 6, uniqueItems: true, items: { $ref: "#/$defs/s1" } },
      },
    },
    s1: { type: "object", required: ["id"], properties: { id: { type: "string", format: "uuid" } } },
  },
};

describe("openAiStrictSchema", () => {
  it("makes a strict copy of a schema whose every object names all its properties as required: bounds strict mode refuses dropped, objects closed, the pattern kept", () => {
    const strict = openAiStrictSchema(CLOSED)!;
    expect(strict).not.toBeNull();
    expect(strict.type).toBe("object");
    const properties = strict.properties as Record<string, JsonObject>;
    expect(properties.date).toEqual({ type: "string", pattern: "^[0-9]{4}-[0-9]{2}-[0-9]{2}$" });
    expect(properties.note).toEqual({ type: ["string", "null"] });
    expect(properties.rows).toEqual({ type: "array", maxItems: 6, items: { $ref: "#/$defs/s1" } });
    expect((strict.$defs as Record<string, JsonObject>).s1).toEqual({ type: "object", required: ["id"], properties: { id: { type: "string" } }, additionalProperties: false });
  });

  it("keeps the non-strict request for a schema strict mode cannot express without changing its meaning", () => {
    const variant = (change: (root: JsonObject) => void): JsonObject => {
      const copy = JSON.parse(JSON.stringify(CLOSED)) as JsonObject;
      change((copy.$defs as Record<string, JsonObject>).s0!);
      return copy;
    };
    expect(openAiStrictSchema(variant((root) => (root.allOf = [{ required: ["date"] }]))), "allOf").toBeNull();
    expect(openAiStrictSchema(variant((root) => ((root.properties as JsonObject).extra = { type: "object", additionalProperties: { type: "string" } }) && (root.required as string[]).push("extra"))), "a free-form map").toBeNull();
  });

  it("on the shipped packages: WebAir's three model steps are strict; so are Literature Review's normalize, screen, select and extract (D-121, D-122), not its allOf/if steps", async () => {
    const strictness = async (archive: string, paths: string[]) => {
      const pkg = await loadPackageBytes(readBytes(archive));
      const workflow = await createWorkflow(pkg);
      return Object.fromEntries(paths.map((path) => [path, openAiStrictSchema(workflow.modelSchema(path)) !== null]));
    };
    expect(await strictness(SHIPPED.webair050.archive, ["schemas/plan.schema.json", "schemas/selection.schema.json", "schemas/answer.schema.json"])).toEqual({
      "schemas/plan.schema.json": true,
      "schemas/selection.schema.json": true,
      "schemas/answer.schema.json": true,
    });
    expect(await strictness(SHIPPED.literatureReview.archive, ["schemas/normalize.schema.json", "schemas/paper.schema.json", "schemas/selection.schema.json", "schemas/paper-evidence.schema.json", "schemas/synthesis.schema.json", "schemas/written.schema.json"])).toEqual({
      "schemas/normalize.schema.json": true,
      "schemas/paper.schema.json": true,
      "schemas/selection.schema.json": true,
      "schemas/paper-evidence.schema.json": true,
      "schemas/synthesis.schema.json": false,
      "schemas/written.schema.json": false,
    });
    // 0.2.6 (T10): normalize asks for references, still strict.
    expect(await strictness(SHIPPED.literatureReview026.archive, ["schemas/normalize.schema.json", "schemas/paper-evidence.schema.json"])).toEqual({ "schemas/normalize.schema.json": true, "schemas/paper-evidence.schema.json": true });
    // 0.2.7 (T15): every answer a model writes about papers is a short, strict one.
    const source = await createWorkflow(await loadSource(sourceTree("literature-review")));
    const v027 = ["schemas/normalize.schema.json", "schemas/screen-verdict.schema.json", "schemas/selection.schema.json", "schemas/paper-evidence.schema.json"];
    expect(Object.fromEntries(v027.map((path) => [path, openAiStrictSchema(source.modelSchema(path)) !== null]))).toEqual(Object.fromEntries(v027.map((path) => [path, true])));
  });
});

const RENDERED = render({
  task: "interpret",
  instructions: ["Return the date."],
  data: { request: "9 October" },
  output_schema: CLOSED,
  requirements: { id: "interpret", capabilities: ["structured_output"], context_window: 16000, preferred_tier: "reasoning" },
  budget_context: { max_output_tokens: 100 },
  audit_context: { worker: "W:1", node_id: "interpret" },
});

const OK = { status: "completed", model: "gpt-5.6-luna", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: '{"date":"2026-10-09","note":null,"rows":[]}' }] }], usage: { input_tokens: 300, output_tokens: 20, total_tokens: 320 } };

function scripted(answers: Array<{ status: number; body: unknown }>): { transport: HttpTransport; bodies: JsonObject[] } {
  const bodies: JsonObject[] = [];
  const transport: HttpTransport = async (request: HttpRequest) => {
    bodies.push(JSON.parse(request.body!) as JsonObject);
    const answer = answers[Math.min(bodies.length - 1, answers.length - 1)]!;
    return { status: answer.status, headers: { "content-type": "application/json" }, body: JSON.stringify(answer.body) };
  };
  return { transport, bodies };
}

const formatOf = (body: JsonObject) => (body.text as JsonObject).format as JsonObject;

describe("OpenAIAdapter: strict where possible, non-strict otherwise", () => {
  it("sends the strict copy when the schema can be strict, and says so", async () => {
    const net = scripted([{ status: 200, body: OK }]);
    const adapter = new OpenAIAdapter({ transport: net.transport, model: "gpt-5.6-luna", apiKey: "sk-test", contextWindow: 272000, reasoning: true });
    const answer = await adapter.complete(RENDERED, 100, new AbortController().signal);
    expect(net.bodies).toHaveLength(1);
    expect(formatOf(net.bodies[0]!)).toMatchObject({ type: "json_schema", name: "agentpkg_node_output", strict: true, schema: openAiStrictSchema(CLOSED) as JsonValue });
    expect(answer.constrained).toBe(true);
    expect(answer.constraint_detail).toMatch(/strict json_schema .*constrained decoding/u);
  });

  it("falls back to the non-strict request, once, when OpenAI refuses the strict schema; any other 400 is the provider's error", async () => {
    const refusal = { error: { message: "Invalid schema for response_format 'agentpkg_node_output': In context=('properties', 'date'), 'pattern' is not permitted.", type: "invalid_request_error", param: "text.format.schema", code: "invalid_json_schema" } };
    const net = scripted([{ status: 400, body: refusal }, { status: 200, body: OK }]);
    const adapter = new OpenAIAdapter({ transport: net.transport, model: "gpt-5.6-luna", apiKey: "sk-test", contextWindow: 272000 });
    const answer = await adapter.complete(RENDERED, 100, new AbortController().signal);
    expect(net.bodies.map((body) => formatOf(body).strict)).toEqual([true, false]);
    expect(answer.constraint_detail).toContain("OpenAI refused the strict json_schema (Invalid schema for response_format");
    const other = scripted([{ status: 400, body: { error: { message: "max_output_tokens is too large", param: "max_output_tokens" } } }]);
    const failing = new OpenAIAdapter({ transport: other.transport, model: "gpt-5.6-luna", apiKey: "sk-test", contextWindow: 272000 });
    await expect(failing.complete(RENDERED, 100, new AbortController().signal)).rejects.toMatchObject({ code: "model_provider_error" });
    expect(other.bodies).toHaveLength(1);
    expect(strictSchemaRefused(401, refusal)).toBe(false);
  });

  it("sends a schema that cannot be strict non-strict, as before", async () => {
    const loose = JSON.parse(JSON.stringify(CLOSED)) as JsonObject;
    ((loose.$defs as Record<string, JsonObject>).s0!).allOf = [{ required: ["date"] }];
    const rendered = render({ ...JSON.parse(JSON.stringify({ task: "interpret", instructions: [], data: {}, requirements: { id: "interpret", capabilities: [], context_window: 16000 }, budget_context: { max_output_tokens: 100 }, audit_context: { worker: "W:1", node_id: "n" } })), output_schema: loose } as ModelRequest);
    const net = scripted([{ status: 200, body: OK }]);
    const answer = await new OpenAIAdapter({ transport: net.transport, model: "gpt-5.6-luna", apiKey: "sk-test", contextWindow: 272000 }).complete(rendered, 100, new AbortController().signal);
    expect(formatOf(net.bodies[0]!).strict).toBe(false);
    expect(answer.constraint_detail).toContain("cannot be strict without changing its meaning");
  });
});

/** A live-like router over the package's fixture: the first `bad` answers break the schema, as the bound router reports them. */
class FlakyRouter implements ModelRouter {
  readonly remote = true;
  readonly capabilities: ReadonlySet<string> = new Set(["reasoning", "structured_output"]);
  readonly context_window = 1_000_000;
  readonly router_id = "test-flaky";
  readonly model_id = "test/flaky";
  readonly domains = ["model.test"];
  /** Its count is local, as the Chrome bound router's is: only dispatches are remote calls. */
  readonly remoteCount = false;
  calls = 0;
  constructor(
    private readonly wrapped: ModelRouter,
    private bad: number,
    readonly nonconformingRetries?: number,
    private readonly inputBound = 5_000,
  ) {}
  async countTokens(): Promise<number> {
    return this.inputBound;
  }
  async complete(request: ModelRequest, max: number, signal: AbortSignal): Promise<ModelResult> {
    this.calls += 1;
    if (this.bad > 0) {
      this.bad -= 1;
      throw new AdapterError("model_output_not_conforming", "The model output does not satisfy the requested schema", { audit_facts: { stop_reason: "stop", reported_input_tokens: 2_000, reported_output_tokens: 60, output_failure: "schema", schema_keyword: "pattern", schema_location: "$defs/s27/properties/search/properties/date/pattern", schema_violations: 1 } });
    }
    const output = await this.wrapped.complete(request, max, signal);
    return { ...output, input_tokens: 2_000, output_tokens: 60 };
  }
}

async function webair(router: (fixture: ModelRouter) => ModelRouter) {
  const pkg = await loadPackageBytes(readBytes(SHIPPED.webair050.archive));
  const { router: fixture, handlers, input } = fixtureAdapters(pkg);
  const built = router(fixture);
  const run = () => runWorkflow(pkg, input, { router: built, handlers, grants: sessionGrants(pkg), approvedTools: ["get-fare-rules", "search-flights"] });
  return { built, run };
}

describe("one more request for a non-conforming answer (runtime)", () => {
  it("a live router's non-conforming answer is asked for once more; the run completes, audited and charged what was reported", async () => {
    const { built, run } = await webair((fixture) => new FlakyRouter(fixture, 1, 1));
    const result = await run();
    expect(result.status).toBe("completed");
    expect((built as FlakyRouter).calls).toBe(4); // interpret twice, then select and answer
    const interpret = result.audit.filter((event) => (event.action === "model.called" || event.action === "model.failed" || event.action === "model.completed") && event.task === "interpret");
    expect(interpret.map((event) => [event.action, event.attempt ?? 1])).toEqual([["model.called", 1], ["model.failed", 1], ["model.called", 2], ["model.completed", 1]]);
    expect(interpret[1]).toMatchObject({ reason: "model_output_not_conforming", tokens_charged: 2_060 });
    expect(result.usage.tokens).toBe(2_060 * 4);
    // Within WebAir's Interpreter budget of 2 remote calls: the two dispatches, no count preflight.
    expect(((result.usage.workers as JsonObject)["Interpreter:1"] as JsonObject).remote_calls).toBe(2);
  });

  it("a second non-conforming answer fails the node as before; a replay router (no retries) is never asked again", async () => {
    const twice = await webair((fixture) => new FlakyRouter(fixture, 2, 1));
    const error = await twice.run().then(() => null, (caught: unknown) => caught);
    expect(error).toBeInstanceOf(WorkflowError);
    expect((error as WorkflowError).code).toBe("model_error");
    expect((twice.built as FlakyRouter).calls).toBe(2);
    const replay = await webair((fixture) => new FlakyRouter(fixture, 1));
    await expect(replay.run()).rejects.toBeInstanceOf(WorkflowError);
    expect((replay.built as FlakyRouter).calls).toBe(1);
  });

  it("a retry whose fresh reservation would exceed a bound is not sent: the node fails with the non-conforming answer, not as budget_exhausted (D-124)", async () => {
    // Interpreter: 40,000 tokens. The reservation is 33,000 + 6,000; attempt 1 is charged its
    // reported 2,060, so a second reservation (41,060 in all) cannot fit. This is luna-pi-2's shape
    // (T10): PlanningWorker 50,000, 14,095 charged, 43,696 more reserved.
    const tight = await webair((fixture) => new FlakyRouter(fixture, 1, 1, 33_000));
    const error = await tight.run().then(() => null, (caught: unknown) => caught);
    expect(error).toBeInstanceOf(WorkflowError);
    expect((error as WorkflowError).code).toBe("model_error");
    expect((tight.built as FlakyRouter).calls).toBe(1);
    const audit = (error as WorkflowError).execution_report!.audit as JsonObject[];
    expect(audit.some((event) => event.action === "model.refused")).toBe(false);
    expect(audit.filter((event) => event.action === "model.called")).toHaveLength(1);
    expect(audit.find((event) => event.action === "model.failed")).toMatchObject({ reason: "model_output_not_conforming", tokens_charged: 2_060 });
    expect(audit.find((event) => event.action === "model.retry_skipped")).toMatchObject({ task: "interpret", reason: "budget", bound: "worker_token_budget", reserved_tokens: 39_000, used_tokens: 2_060, held_tokens: 0, limit: 40_000 });
  });
});
