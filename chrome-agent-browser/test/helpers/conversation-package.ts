/**
 * `conversation_probe.py`: a small generic conversation.v0 package (spec/conversation-v0.md), built
 * in memory so that each test can change one thing: the conversation object, a consent step, the
 * tool it gates, the persistent state, the fixture transcript. The shape is the ticket desk of
 * `examples/conversation/conversation-test`, reduced: one model step that reads a message (its
 * replay cases are keyed by the text alone, so a scenario's history never changes them), one
 * consent step before one write tool, two joins that carry the history and the orders across turns.
 *
 * `VARIANTS` are the named mutations the enforcement cases use (`examples/conversation/cases/
 * cases.json`), the same names as the Python probe's.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { canonicalJson } from "../../src/core/canonical.js";
import type { JsonObject, JsonValue } from "../../src/core/json.js";
import { loadPackageBytes, type Package } from "../../src/core/package.js";
import type { TranscriptInput } from "../../src/core/conversation/transcript.js";
import { generateKeyPair, signedArchive, type TestKeyPair } from "./keys.js";
import { ROOT } from "./paths.js";

export const CASES = join(ROOT, "examples", "conversation", "cases");
export const CONTRACTS = join(ROOT, "spec", "conversation-v0");
const SCHEMA = "https://json-schema.org/draft/2020-12/schema";
const DECISION_SCHEMA = JSON.parse(readFileSync(join(CONTRACTS, "consent-decision.schema.json"), "utf8")) as JsonObject;

export const MESSAGES: Record<string, JsonObject> = {
  "order A": { intent: "order", show: "Show A", quantity: 1, reply: "Order one ticket to Show A?" },
  "order B": { intent: "order", show: "Show B", quantity: 2, reply: "Order two tickets to Show B?" },
  hello: { intent: "chat", show: null, quantity: null, reply: "Hello! Which show?" },
  done: { intent: "done", show: null, quantity: null, reply: "Goodbye." },
};
export const ORDERS: Array<[show: string, quantity: number, answer: JsonObject]> = [
  ["Show A", 1, { order_id: "TD-0001", show: "Show A", quantity: 1, total_usd: 40 }],
  ["Show B", 2, { order_id: "TD-0002", show: "Show B", quantity: 2, total_usd: 90 }],
];

export interface CaseList {
  cases: Array<{
    id: string;
    title: string;
    stage: "validation" | "start" | "host" | "turn" | "run";
    code?: string;
    variant?: string;
    transcript?: Array<string | [string, Record<string, boolean>]>;
    transcript_raw?: JsonObject;
    grants?: Record<string, string>;
    limits?: Record<string, number>;
    reason?: string;
    host?: "silent" | "invalid";
    path?: "run";
    remote_tool?: boolean;
    expect?: JsonObject;
  }>;
}

export function caseList(): CaseList {
  return JSON.parse(readFileSync(join(CASES, "cases.json"), "utf8")) as CaseList;
}

export type Members = Record<string, JsonValue | string>;

const state = (path: string): JsonObject => ({ from: "state", path });
export const message = (text: string): JsonObject => ({ text });

/** `transcript(["order A", {confirm: true}], "done")`: a turn is a text or a [text, consents] pair. */
export function transcript(turns: Array<string | [string, Record<string, boolean>]>, end?: boolean): TranscriptInput {
  const document: TranscriptInput = { schema: "conversation.transcript.v0", turns: [] };
  for (const turn of turns) {
    const [text, consents] = typeof turn === "string" ? [turn, null] : turn;
    const entry: TranscriptInput["turns"][number] = { message: message(text) };
    if (consents !== null) entry.consents = consents;
    document.turns.push(entry);
  }
  if (end !== undefined) document.end = end;
  return document;
}

export function grants(overrides: Record<string, string> = {}): Record<string, "once" | "session" | "always" | "deny"> {
  return { "model.reasoning": "session", "memory.session": "session", "orders.place": "session", ...overrides } as Record<string, "once" | "session" | "always" | "deny">;
}

export interface FilesOptions {
  minimumVersion?: string;
  sideEffects?: "read" | "write";
  remoteTool?: boolean;
}

/** Every member of the probe as JSON values (and the skill's text), before any mutation. */
export function files(options: FilesOptions = {}): Members {
  const minimumVersion = options.minimumVersion ?? "0.6.0";
  const sideEffects = options.sideEffects ?? "write";
  const remoteTool = options.remoteTool === true;
  const order: JsonObject = {
    type: "object",
    properties: { order_id: { type: "string" }, show: { type: "string" }, quantity: { type: "integer", minimum: 1 }, total_usd: { type: "integer", minimum: 0 } },
    required: ["order_id", "show", "quantity", "total_usd"],
    additionalProperties: false,
  };
  const entry: JsonObject = { type: "object", properties: { text: { type: "string" }, intent: { enum: ["order", "chat", "done"] } }, required: ["text", "intent"], additionalProperties: false };
  const interpretation: JsonObject = {
    type: "object",
    properties: { intent: { enum: ["order", "chat", "done"] }, show: { type: ["string", "null"] }, quantity: { type: ["integer", "null"], minimum: 1 }, reply: { type: "string", minLength: 1 } },
    required: ["intent", "show", "quantity", "reply"],
    additionalProperties: false,
  };
  const reply: JsonObject = { type: "object", properties: { reply: { type: "string" }, intent: { enum: ["order", "chat", "done"] }, order: { anyOf: [order, { type: "null" }] } }, required: ["reply", "intent", "order"], additionalProperties: false };
  const tool: JsonObject = {
    spec_version: "0.1",
    id: "place",
    version: "0.1.0",
    description: "Place one order at the fictional desk.",
    execution: remoteTool ? "remote" : "local",
    binding: "desk.place_order",
    endpoint: remoteTool ? "https://desk.example.org/api/orders" : null,
    method: remoteTool ? "POST" : null,
    input_schema: "schemas/order-input.schema.json",
    output_schema: "schemas/order.schema.json",
    permissions: ["orders.place", ...(remoteTool ? ["network.desk"] : [])],
    domains: remoteTool ? ["desk.example.org"] : [],
    timeout_seconds: 10,
    retries: 0,
    side_effects: sideEffects,
    approval_required: true,
    extensions: {},
  };
  const permissions: JsonObject[] = [
    { id: "model.reasoning", kind: "model", description: "Read each message.", required: true, resources: ["host-router"] },
    { id: "memory.session", kind: "memory", description: "Turn state.", required: true, resources: ["session"] },
    { id: "orders.place", kind: "payment", description: "Place an order (simulated).", required: false, resources: ["desk"] },
  ];
  if (remoteTool) permissions.push({ id: "network.desk", kind: "network", description: "Reach the desk.", required: true, resources: ["desk.example.org"] });
  const nodes: JsonObject[] = [
    { id: "interpret", type: "llm", worker: "Clerk", depends_on: [], task: "interpret", max_output_tokens: 300, input: { object: { text: state("/request/text") } }, output_schema: "schemas/interpretation.schema.json", timeout_seconds: 30, writes: { "/interpretation": { from: "result", path: "" } } },
    {
      id: "confirm",
      type: "consent",
      worker: "Coordinator",
      depends_on: ["interpret"],
      when: { left: state("/interpretation/intent"), op: "eq", right: { literal: "order" } },
      otherwise: { literal: { accepted: false } },
      permissions: ["orders.place"],
      text: state("/interpretation/reply"),
      input: { object: { show: state("/interpretation/show"), quantity: state("/interpretation/quantity") } },
      output_schema: "schemas/consent-decision.schema.json",
      timeout_seconds: 30,
      writes: { "/decision": { from: "result", path: "" } },
    },
    {
      id: "place",
      type: "tool",
      worker: "Desk",
      depends_on: ["confirm"],
      tool: "place",
      when: { left: state("/decision/accepted"), op: "eq", right: { literal: true } },
      otherwise: { literal: null },
      input: { object: { show: state("/interpretation/show"), quantity: state("/interpretation/quantity") } },
      output_schema: "schemas/order-result.schema.json",
      timeout_seconds: 20,
      writes: { "/order": { from: "result", path: "" } },
    },
    {
      id: "orders",
      type: "join",
      worker: "Coordinator",
      depends_on: ["place"],
      when: { left: state("/order"), op: "ne", right: { literal: null } },
      otherwise: state("/orders"),
      input: { array: [state("/orders"), { array: [state("/order")] }] },
      output_schema: "schemas/orders.schema.json",
      timeout_seconds: 10,
      writes: { "/orders": { from: "result", path: "" } },
    },
    {
      id: "history",
      type: "join",
      worker: "Coordinator",
      depends_on: ["interpret"],
      input: { array: [state("/history"), { array: [{ object: { text: state("/request/text"), intent: state("/interpretation/intent") } }] }] },
      output_schema: "schemas/history.schema.json",
      timeout_seconds: 10,
      writes: { "/history": { from: "result", path: "" } },
    },
    {
      id: "assemble",
      type: "validate",
      worker: "Coordinator",
      depends_on: ["orders", "history"],
      input: { object: { reply: state("/interpretation/reply"), intent: state("/interpretation/intent"), order: state("/order") } },
      output_schema: "schemas/reply.schema.json",
      timeout_seconds: 10,
      writes: { "/reply": { from: "result", path: "" } },
    },
    { id: "output", type: "output", worker: "Coordinator", depends_on: ["assemble"], input: state("/reply"), output_schema: "schemas/output.schema.json", timeout_seconds: 10, writes: {} },
  ];
  const graph: JsonObject = {
    spec_version: "0.1",
    profile: "workflow.v0",
    coordinator: "Coordinator",
    workers: [
      { id: "Coordinator", kind: "packaged", skills: [], tools: [], max_instances: 1, budget: { tokens: 0, remote_calls: 0 }, state_read: ["request", "history", "orders", "interpretation", "decision", "order", "reply"], state_write: ["decision", "orders", "history", "reply"] },
      { id: "Clerk", kind: "packaged", skills: ["desk"], tools: [], max_instances: 1, budget: { tokens: 4000, remote_calls: 0 }, state_read: ["request"], state_write: ["interpretation"] },
      { id: "Desk", kind: "packaged", skills: [], tools: ["place"], max_instances: 1, budget: { tokens: 0, remote_calls: remoteTool ? 1 : 0 }, state_read: ["interpretation", "decision"], state_write: ["order"] },
    ],
    input_schema: "schemas/input.schema.json",
    output_schema: "schemas/output.schema.json",
    initial_state: {
      object: {
        request: { from: "input", path: "" },
        history: { from: "conversation", path: "/history" },
        orders: { from: "conversation", path: "/orders" },
        interpretation: { literal: null },
        decision: { literal: null },
        order: { literal: null },
        reply: { literal: null },
      },
    },
    deadline_seconds: 60,
    conversation: {
      state_schema: "schemas/conversation-state.schema.json",
      initial: { literal: { history: [], orders: [] } },
      budget: { max_turns: 4, hard_tokens: 16000, max_remote_calls: 4, max_calls_per_tool: { place: 2 } },
      end: { when: { left: { from: "result", path: "/intent" }, op: "eq", right: { literal: "done" } } },
      fixture: "fixtures/transcript.json",
    },
    fixture: "fixtures/workflow.json",
    exports: [{ path: "reply.json", format: "json", value: { from: "result", path: "" } }],
    nodes,
    extensions: {},
  };
  const schemaNames = ["input", "state", "conversation-state", "interpretation", "consent-decision", "order-input", "order", "order-result", "history", "orders", "reply", "output", "any"];
  return {
    "MANIFEST.agent": {
      spec_version: "0.1",
      package_id: "org.example.conversation-probe",
      name: "Conversation Probe",
      version: "0.1.0",
      description: "A test package for conversation.v0.",
      publisher: { id: "example", name: "Example" },
      created_at: "2026-10-21T00:00:00Z",
      runtime: { api: "agentpkg-runtime-v0", minimum_version: minimumVersion },
      capabilities: [],
      entrypoint: "workflow.v0",
      graph: "graph.json",
      policy: "policy/policy.json",
      skills: [{ id: "desk", version: "0.1.0", path: "skills/desk/SKILL.md" }],
      tools: [{ id: "place", path: "tools/place.tool.json" }],
      schemas: schemaNames.map((name) => ({ id: name, path: `schemas/${name}.schema.json` })),
      model_requirements: { tasks: [{ id: "interpret", capabilities: ["structured_output"], context_window: 8000, preferred_tier: "reasoning" }], routing: "host", fallback_policy: "deny", extensions: {} },
      evals: [],
      attestations: [],
      dependencies: [],
      update: { channel: "local", locator: null },
      extensions: {},
    },
    "policy/policy.json": {
      spec_version: "0.1",
      permissions,
      network: { allowed_domains: remoteTool ? ["desk.example.org"] : [], https_only: true, allow_redirects: false },
      memory: { scope: "session", retention: "session", raw_documents: false, state_schema: "schemas/state.schema.json", sharing: "explicit_views" },
      budget: { estimated_tokens: 500, hard_tokens: 4000, max_remote_calls: remoteTool ? 1 : 0, max_calls_per_tool: { place: 1 }, max_parallel_workers: 2, estimated_cost_usd: null, approval_threshold_tokens: null },
      delegation: { max_depth: 1, approved_roles: ["Clerk", "Desk"], allow_remote: false },
      extensions: {},
    },
    "tools/place.tool.json": tool,
    "graph.json": graph,
    "skills/desk/SKILL.md": "# Desk\n\nRead the message; answer the JSON object.\n",
    "schemas/input.schema.json": { $schema: SCHEMA, type: "object", properties: { text: { type: "string", minLength: 1 } }, required: ["text"], additionalProperties: false },
    "schemas/any.schema.json": { $schema: SCHEMA },
    "schemas/history.schema.json": { $schema: SCHEMA, type: "array", items: entry, maxItems: 256 },
    "schemas/orders.schema.json": { $schema: SCHEMA, type: "array", items: order, maxItems: 256 },
    "schemas/conversation-state.schema.json": { $schema: SCHEMA, type: "object", properties: { history: { $ref: "history.schema.json" }, orders: { $ref: "orders.schema.json" } }, required: ["history", "orders"], additionalProperties: false },
    "schemas/interpretation.schema.json": { $schema: SCHEMA, ...interpretation },
    "schemas/consent-decision.schema.json": JSON.parse(JSON.stringify(DECISION_SCHEMA)) as JsonObject,
    "schemas/order-input.schema.json": { $schema: SCHEMA, type: "object", properties: { show: { type: "string" }, quantity: { type: "integer", minimum: 1 } }, required: ["show", "quantity"], additionalProperties: false },
    "schemas/order.schema.json": { $schema: SCHEMA, ...order },
    "schemas/order-result.schema.json": { $schema: SCHEMA, anyOf: [{ $ref: "order.schema.json" }, { type: "null" }] },
    "schemas/reply.schema.json": { $schema: SCHEMA, ...reply },
    "schemas/output.schema.json": { $schema: SCHEMA, ...reply },
    "schemas/state.schema.json": {
      $schema: SCHEMA,
      type: "object",
      properties: {
        request: { $ref: "input.schema.json" },
        history: { $ref: "history.schema.json" },
        orders: { $ref: "orders.schema.json" },
        interpretation: { anyOf: [{ $ref: "interpretation.schema.json" }, { type: "null" }] },
        decision: { anyOf: [{ $ref: "consent-decision.schema.json" }, { type: "null" }] },
        order: { $ref: "order-result.schema.json" },
        reply: { anyOf: [{ $ref: "reply.schema.json" }, { type: "null" }] },
      },
      required: ["request", "history", "orders", "interpretation", "decision", "order", "reply"],
      additionalProperties: false,
    },
    "fixtures/workflow.json": {
      profile: "workflow.fixture.v0",
      input: message("order A"),
      models: { interpret: Object.entries(MESSAGES).map(([text, answer]) => ({ input: { text }, output: answer })) },
      tools: { place: ORDERS.map(([show, quantity, answer]) => ({ input: { show, quantity }, output: answer })) },
    },
    "fixtures/transcript.json": transcript([["order A", { confirm: true }], "done"]) as unknown as JsonValue,
  };
}

export function node(members: Members, nodeId: string): JsonObject {
  const graph = members["graph.json"] as JsonObject;
  return (graph.nodes as JsonObject[]).find((item) => item.id === nodeId)!;
}

const graphOf = (m: Members): JsonObject => m["graph.json"] as JsonObject;
const worker = (m: Members, id: string): JsonObject => (graphOf(m).workers as JsonObject[]).find((item) => item.id === id)!;

// -- the named mutations of the enforcement cases ----------------------------------------------
function noConversation(m: Members): void {
  const graph = graphOf(m);
  delete graph.conversation;
  const initial = (graph.initial_state as JsonObject).object as JsonObject;
  initial.history = { literal: [] };
  initial.orders = { literal: [] };
}

function plain(m: Members): void {
  noConversation(m);
  const graph = graphOf(m);
  graph.nodes = (graph.nodes as JsonObject[]).filter((item) => item.id !== "confirm");
  const place = node(m, "place");
  place.depends_on = ["interpret"];
  place.when = { left: state("/interpretation/intent"), op: "eq", right: { literal: "order" } };
  (m["tools/place.tool.json"] as JsonObject).side_effects = "read";
}

function sourceOutside(m: Members): void {
  const graph = graphOf(m);
  delete graph.conversation;
  graph.nodes = (graph.nodes as JsonObject[]).filter((item) => item.id !== "confirm");
  node(m, "place").depends_on = ["interpret"];
  (m["tools/place.tool.json"] as JsonObject).side_effects = "read";
}

const conversation = (m: Members): JsonObject => graphOf(m).conversation as JsonObject;

export const VARIANTS: Record<string, (m: Members) => void> = {
  "consent-outside-conversation": noConversation,
  "conversation-source-outside": sourceOutside,
  "minimum-version": (m) => {
    ((m["MANIFEST.agent"] as JsonObject).runtime as JsonObject).minimum_version = "0.5.0";
  },
  "state-schema-undeclared": (m) => {
    conversation(m).state_schema = "schemas/missing.schema.json";
  },
  "state-schema-open": (m) => {
    delete (m["schemas/conversation-state.schema.json"] as JsonObject).additionalProperties;
  },
  "state-key-undeclared": (m) => {
    ((m["schemas/conversation-state.schema.json"] as JsonObject).properties as JsonObject).notes = { type: "string" };
  },
  "initial-not-literal": (m) => {
    conversation(m).initial = { from: "input", path: "" };
  },
  "initial-invalid": (m) => {
    conversation(m).initial = { literal: { history: [], orders: "none" } };
  },
  "budget-below-turn": (m) => {
    (conversation(m).budget as JsonObject).hard_tokens = 100;
  },
  "tool-cap-unknown": (m) => {
    (conversation(m).budget as JsonObject).max_calls_per_tool = { other: 1 };
  },
  "consent-on-worker": (m) => {
    const confirm = node(m, "confirm");
    confirm.worker = "Clerk";
    confirm.text = { literal: "Order?" };
    confirm.input = { literal: {} };
    delete confirm.when;
    delete confirm.otherwise;
    (worker(m, "Clerk").state_write as string[]).push("decision");
  },
  "consent-permission-unknown": (m) => {
    node(m, "confirm").permissions = ["orders.other"];
  },
  "consent-permission-kind": (m) => {
    node(m, "confirm").permissions = ["model.reasoning"];
    (m["tools/place.tool.json"] as JsonObject).side_effects = "read";
  },
  "consent-decision-schema": (m) => {
    node(m, "confirm").output_schema = "schemas/any.schema.json";
  },
  "consent-otherwise-accepts": (m) => {
    node(m, "confirm").otherwise = { literal: { accepted: true } };
  },
  "tool-before-consent": (m) => {
    const place = node(m, "place");
    place.depends_on = ["interpret"];
    place.input = { literal: { show: "Show A", quantity: 1 } };
    delete place.when;
    delete place.otherwise;
    (node(m, "assemble").depends_on as string[]).push("confirm");
  },
  "write-tool-ungated": (m) => {
    // The consent step stays and decides nothing the tool links.
    ((m["policy/policy.json"] as JsonObject).permissions as JsonObject[]).push({ id: "orders.confirm", kind: "payment", description: "Confirm.", required: false, resources: ["desk"] });
    node(m, "confirm").permissions = ["orders.confirm"];
  },
  "fixture-step-unknown": (m) => {
    ((m["fixtures/transcript.json"] as JsonObject).turns as JsonObject[])[0]!.consents = { other: true };
  },
  "fixture-too-many-turns": (m) => {
    (m["fixtures/transcript.json"] as JsonObject).turns = Array.from({ length: 5 }, () => ({ message: message("hello") }));
  },
  "fixture-message-invalid": (m) => {
    ((m["fixtures/transcript.json"] as JsonObject).turns as JsonObject[])[1]!.message = { text: "" };
  },
  "fixture-input-mismatch": (m) => {
    (m["fixtures/workflow.json"] as JsonObject).input = message("hello");
  },
  "consent-text-not-string": (m) => {
    node(m, "confirm").text = state("/interpretation/quantity");
  },
  "tool-after-denied-consent": (m) => {
    const place = node(m, "place");
    place.input = { literal: { show: "Show A", quantity: 1 } };
    delete place.when;
    delete place.otherwise;
  },
  "tool-after-skipped-consent": (m) => {
    VARIANTS["tool-after-denied-consent"]!(m);
  },
  "state-outside-schema": (m) => {
    // The turn builds a history entry the conversation's state schema refuses (an extra field),
    // while the turn's own state schema admits it.
    const history = m["schemas/history.schema.json"] as JsonObject;
    ((history.items as JsonObject).properties as JsonObject).extra = { type: "string" };
    const strict = JSON.parse(JSON.stringify(history)) as JsonObject;
    delete ((strict.items as JsonObject).properties as JsonObject).extra;
    m["schemas/history-strict.schema.json"] = strict;
    ((m["MANIFEST.agent"] as JsonObject).schemas as JsonObject[]).push({ id: "history-strict", path: "schemas/history-strict.schema.json" });
    ((m["schemas/conversation-state.schema.json"] as JsonObject).properties as JsonObject).history = { $ref: "history-strict.schema.json" };
    const input = node(m, "history").input as JsonObject;
    ((((input.array as JsonValue[])[1] as JsonObject).array as JsonValue[])[0] as JsonObject).object = { ...(((((input.array as JsonValue[])[1] as JsonObject).array as JsonValue[])[0] as JsonObject).object as JsonObject), extra: { literal: "x" } };
  },
  "tool-cap-one": (m) => {
    (conversation(m).budget as JsonObject).max_calls_per_tool = { place: 1 };
  },
  "two-steps": (m) => {
    // The tool links two gated permissions, each decided by its own step (V-9 is per permission).
    ((m["policy/policy.json"] as JsonObject).permissions as JsonObject[]).push({ id: "orders.charge", kind: "payment", description: "Charge the order (simulated).", required: false, resources: ["desk"] });
    ((m["tools/place.tool.json"] as JsonObject).permissions as string[]).push("orders.charge");
    const second = JSON.parse(JSON.stringify(node(m, "confirm"))) as JsonObject;
    second.id = "confirm2";
    second.permissions = ["orders.charge"];
    second.text = { literal: "Charge the order?" };
    second.writes = { "/decision2": { from: "result", path: "" } };
    const nodes = graphOf(m).nodes as JsonObject[];
    nodes.splice(nodes.indexOf(node(m, "place")), 0, second);
    node(m, "place").depends_on = ["confirm", "confirm2"];
    const coordinator = worker(m, "Coordinator");
    (coordinator.state_read as string[]).push("decision2");
    (coordinator.state_write as string[]).push("decision2");
    ((graphOf(m).initial_state as JsonObject).object as JsonObject).decision2 = { literal: null };
    const turnState = m["schemas/state.schema.json"] as JsonObject;
    (turnState.properties as JsonObject).decision2 = JSON.parse(JSON.stringify((turnState.properties as JsonObject).decision)) as JsonValue;
    (turnState.required as string[]).push("decision2");
  },
  plain,
};

export interface ProbeOptions extends FilesOptions {
  mutate?: ((m: Members) => void) | null;
}

/** The probe's payload files, canonical JSON members as `agentpkg build` writes them. */
export function probeSource(options: ProbeOptions = {}): Map<string, Uint8Array> {
  const members = files(options);
  options.mutate?.(members);
  const built = new Map<string, Uint8Array>();
  for (const [name, value] of Object.entries(members)) {
    built.set(name, typeof value === "string" ? new TextEncoder().encode(value) : canonicalJson(value));
  }
  return built;
}

/** Signed with a throwaway key; throws what `loadPackageBytes` throws when loaded. */
export async function probeBytes(options: ProbeOptions = {}): Promise<{ bytes: Uint8Array; key: TestKeyPair }> {
  const key = await generateKeyPair();
  return { bytes: await signedArchive(probeSource(options), key), key };
}

export async function probePackage(options: ProbeOptions = {}): Promise<{ pkg: Package; bytes: Uint8Array; key: TestKeyPair }> {
  const { bytes, key } = await probeBytes(options);
  return { pkg: await loadPackageBytes(bytes), bytes, key };
}
