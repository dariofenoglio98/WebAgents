/**
 * What a package may declare about a conversation, checked at validation (conversation.v0 §2–§4,
 * V-1…V-20), before any host runs a turn: `agentpkg/conversation/declarations.py`.
 *
 * Refusals are `ValidationError`s whose text starts with the specification's code, so that both
 * runtimes refuse a package with the same message (the conformance suite compares refusals).
 * Nothing here executes anything (D-007).
 */
import { canonicalString } from "../canonical.js";
import { ValidationError } from "../errors.js";
import { isJsonObject, parseJson, type JsonObject, type JsonValue } from "../json.js";
import { packageJson, type Package } from "../package.js";
import { roleSteps } from "../network/analysis.js";
import { pyRepr } from "../repr.js";
import { references } from "../references.js";
import { describeFailure, failuresForSchema, PackageSchemas } from "../schema.js";
import { CONVERSATION_CONTRACTS } from "../schemas/conversation/index.js";
import { compareRelease } from "../version.js";

export const CONVERSATION_MINIMUM_VERSION = "0.6.0";
export const MAX_TURNS = 256;
export const MAX_TEXT_CHARS = 2000;
export const MAX_STATE_KEYS = 64;
/** Permission kinds a consent step may not decide: a model call and the run's own state are granted at authorization, not confirmed per action. */
export const GATE_EXEMPT_KINDS: ReadonlySet<string> = new Set(["model", "memory"]);
/** Tools bound to the host's memory (memory.v0): host-owned, consented through their permission and the memory's own review. */
export const UNGATED_BINDING_PREFIX = "host.memory.";
/** The one value a conditional consent step may yield when it is not asked. */
export const DENIAL: JsonObject = { literal: { accepted: false } };
export const DECISION_SCHEMA = "consent-decision.schema";
export const TRANSCRIPT_INPUT_SCHEMA = "transcript-input.schema";
export const TRANSCRIPT_SCHEMA = "transcript.schema";
export const TRANSCRIPT_SCHEMA_ID = "conversation.transcript.v0";

export function contract(name: string): JsonValue {
  const value = CONVERSATION_CONTRACTS[name];
  if (value === undefined) throw new Error(`unknown conversation contract ${name}`);
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

function refuse(code: string, message: string): ValidationError {
  return Object.assign(new ValidationError(`${code}: ${message}`), { code });
}

export function conversationOf(graph: JsonObject): JsonObject | null {
  const value = graph.conversation;
  return isJsonObject(value) ? value : null;
}

export function consentNodes(graph: JsonObject): JsonObject[] {
  return ((graph.nodes as JsonValue[] | undefined) ?? []).filter((node): node is JsonObject => isJsonObject(node) && node.type === "consent");
}

/** Every permission a consent step decides, with the steps that name it (V-9). */
export function gatedPermissions(graph: JsonObject): Record<string, string[]> {
  const gated: Record<string, string[]> = {};
  for (const node of consentNodes(graph)) {
    for (const permissionId of (node.permissions as JsonValue[]).map(String)) (gated[permissionId] ??= []).push(String(node.id));
  }
  return gated;
}

/** The persistent state's keys, in the order its schema declares them (V-3). */
export function persistentKeys(pkg: Package): string[] {
  const conversation = conversationOf(pkg.graph);
  if (conversation === null) return [];
  const schema = packageJson(pkg, String(conversation.state_schema));
  const properties = isJsonObject(schema) && isJsonObject(schema.properties) ? schema.properties : {};
  return Object.keys(properties);
}

/**
 * A transcript against the input or the output contract; the message names the first error as
 * `validate_document` does (the reference's `validate_transcript_document`).
 */
export async function validateTranscriptDocument(value: unknown, form: "input" | "output", label: string): Promise<JsonObject> {
  const name = form === "input" ? TRANSCRIPT_INPUT_SCHEMA : TRANSCRIPT_SCHEMA;
  const schema = contract(name);
  const failures = await failuresForSchema(schema, value, label);
  if (failures.length > 0) {
    // The reference sorts jsonschema's errors by path and names the first.
    const sorted = [...failures].sort((a, b) => (a.instancePath.join("/") < b.instancePath.join("/") ? -1 : a.instancePath.join("/") > b.instancePath.join("/") ? 1 : 0));
    const first = sorted[0]!;
    throw new ValidationError(`${label}/${first.instancePath.join("/") || "<root>"}: ${describeFailure(first, value, () => schema)}`);
  }
  return value as JsonObject;
}

type Documents = ReadonlyMap<string, JsonValue>;
type Schema = [schema: JsonValue, path: string];
type Env = Record<string, Schema | Record<string, Schema>>;

/**
 * The extra source a conversational graph's `initial_state` may read: the persisted state, typed by
 * `conversation.state_schema` (V-4). A graph without a conversation that reads it is refused here
 * with the code, before the generic scope check would name the source.
 */
export function conversationInitialEnv(graph: JsonObject, documents: Documents, schemaPaths: ReadonlySet<string>): Env {
  const conversation = conversationOf(graph);
  let referenced = false;
  for (const [source] of references(graph.initial_state!)) if (source === "conversation") referenced = true;
  if (conversation === null) {
    if (referenced) throw refuse("conversation_source_scope", "initial_state reads the conversation state and the graph declares no conversation");
    return {};
  }
  const path = String(conversation.state_schema);
  if (!schemaPaths.has(path)) throw refuse("conversation_state_schema_undeclared", `conversation.state_schema ${pyRepr(path)} is not a declared schema`);
  return { conversation: [documents.get(path)!, path] };
}

export interface DeclarationHooks {
  documents: Documents;
  schema: (path: unknown, label: string) => Schema;
  expression: (value: JsonValue, env: Env, label: string) => void;
  ancestors: ReadonlyMap<string, ReadonlySet<string>>;
  nodes: ReadonlyMap<string, JsonObject>;
  files: ReadonlyMap<string, Uint8Array>;
  schemaPaths: ReadonlySet<string>;
}

export interface ConversationDeclarations {
  keys: string[];
  gated: Record<string, string[]>;
  consent_steps: string[];
}

/**
 * The conversation object, the consent steps, the gate and the fixture transcript against the rest
 * of the graph; called by `validateWorkflow` after the nodes were checked. A graph without a
 * conversation returns null (and may hold no consent step).
 */
export async function checkConversationDeclarations(manifest: JsonObject, graph: JsonObject, policy: JsonObject, tools: Readonly<Record<string, JsonObject>>, hooks: DeclarationHooks): Promise<ConversationDeclarations | null> {
  const conversation = conversationOf(graph);
  const consents = consentNodes(graph);
  if (conversation === null) {
    if (consents.length > 0) throw refuse("consent_outside_conversation", `node ${consents[0]!.id}: a consent step belongs to a conversational graph (the graph declares no conversation)`);
    return null;
  }
  if (compareRelease(String((manifest.runtime as JsonObject).minimum_version), CONVERSATION_MINIMUM_VERSION) < 0) {
    throw refuse("conversation_minimum_version", `a conversation requires runtime.minimum_version ${CONVERSATION_MINIMUM_VERSION} or later`);
  }
  const statePath = String(conversation.state_schema);
  const stateSchema = hooks.documents.get(statePath);
  const turnState = hooks.documents.get(String((policy.memory as JsonObject).state_schema)) as JsonObject;
  const properties = isJsonObject(stateSchema) && isJsonObject(stateSchema.properties) ? stateSchema.properties : null;
  if (!isJsonObject(stateSchema) || stateSchema.type !== "object" || stateSchema.additionalProperties !== false || properties === null || Object.keys(properties).length > MAX_STATE_KEYS) {
    throw refuse("conversation_state_schema_open", `${statePath}: the persistent state is a closed object schema (type object, additionalProperties false) of at most ${MAX_STATE_KEYS} properties`);
  }
  const keys = Object.keys(properties);
  const turnProperties = isJsonObject(turnState.properties) ? turnState.properties : {};
  const missing = keys.filter((key) => !Object.hasOwn(turnProperties, key));
  if (missing.length > 0) {
    throw refuse("conversation_state_key_undeclared", `persistent key ${pyRepr(missing[0]!)} is not a top-level key of the turn's state schema ${(policy.memory as JsonObject).state_schema}`);
  }
  const initial = conversation.initial as JsonObject;
  if (!isJsonObject(initial) || !("literal" in initial)) throw refuse("conversation_initial_literal", "conversation.initial must be a literal");
  const schemas = await PackageSchemas.open(hooks.files, hooks.schemaPaths);
  try {
    await schemas.validateInstance(statePath, initial.literal!, "conversation.initial");
  } catch (error) {
    if (error instanceof ValidationError) throw refuse("conversation_initial_invalid", error.message);
    throw error;
  } finally {
    schemas.close();
  }
  const budget = conversation.budget as JsonObject;
  const turnBudget = policy.budget as JsonObject;
  if ((budget.hard_tokens as number) < (turnBudget.hard_tokens as number) || (budget.max_remote_calls as number) < (turnBudget.max_remote_calls as number)) {
    throw refuse("conversation_budget_below_turn", `conversation.budget must admit at least one turn: hard_tokens >= ${turnBudget.hard_tokens} and max_remote_calls >= ${turnBudget.max_remote_calls}`);
  }
  const unknown = Object.keys((budget.max_calls_per_tool as JsonObject | undefined) ?? {})
    .filter((toolId) => !Object.hasOwn(tools, toolId))
    .sort();
  if (unknown.length > 0) throw refuse("conversation_tool_unknown", `conversation.budget.max_calls_per_tool names undeclared tool ${pyRepr(unknown[0]!)}`);
  const end = conversation.end;
  if (isJsonObject(end)) {
    const env: Env = { result: hooks.schema(graph.output_schema, "conversation.end"), state: [stateSchema, statePath] };
    const when = end.when as JsonObject;
    for (const side of ["left", "right"] as const) hooks.expression(when[side]!, env, `conversation.end/when/${side}`);
  }
  const permissions = new Map((policy.permissions as JsonObject[]).map((permission) => [String(permission.id), permission]));
  const coordinator = String(graph.coordinator);
  const decision = canonicalString(contract(DECISION_SCHEMA));
  for (const node of consents) {
    const label = `workflow node ${node.id}`;
    if (node.worker !== coordinator) throw refuse("consent_role", `${label}: a consent step runs on the coordinator, not on a worker`);
    for (const permissionId of (node.permissions as JsonValue[]).map(String)) {
      const permission = permissions.get(permissionId);
      if (permission === undefined) throw refuse("consent_permission_unknown", `${label}: permission ${pyRepr(permissionId)} is not declared`);
      if (GATE_EXEMPT_KINDS.has(String(permission.kind))) {
        throw refuse("consent_permission_kind", `${label}: a consent step cannot decide a permission of kind ${permission.kind} (${permissionId})`);
      }
    }
    if (canonicalString(hooks.documents.get(String(node.output_schema))) !== decision) {
      throw refuse("consent_decision_schema", `${label}: output_schema must be the consent decision contract (${DECISION_SCHEMA}.json) exactly`);
    }
    if ("otherwise" in node && canonicalString(node.otherwise) !== canonicalString(DENIAL)) {
      throw refuse("consent_otherwise_accepts", `${label}: a consent step that is not asked yields {"literal": {"accepted": false}} and nothing else`);
    }
  }
  const gated = gatedPermissions(graph);
  for (const [nodeId, node] of hooks.nodes) {
    let operations: Array<[string, JsonObject]> = node.type === "tool" ? [[String(node.id), node]] : ((node.steps as JsonObject[] | undefined) ?? []).filter((step) => step.type === "tool").map((step) => [`${nodeId}/${step.id}`, step]);
    // network.v0: a role's tool step runs inside the network node, so the node holding the network
    // must depend on the consent step that gates the permission (R-25).
    if (node.type === "network") operations = roleSteps(graph).filter(([, step]) => step.type === "tool");
    for (const [name, operation] of operations) {
      for (const permissionId of (tools[String(operation.tool)]!.permissions as JsonValue[]).map(String)) {
        const steps = gated[permissionId];
        if (steps && !steps.some((step) => hooks.ancestors.get(nodeId)!.has(step))) {
          throw refuse("consent_missing_before_tool", `workflow node ${name}: tool ${pyRepr(String(operation.tool))} links ${permissionId}, which consent step(s) ${pyRepr(steps)} decide, and the node does not depend on one of them`);
        }
      }
    }
  }
  for (const toolId of Object.keys(tools).sort()) {
    const tool = tools[toolId]!;
    const binding = String(tool.binding ?? "");
    if (tool.side_effects === "write" && !binding.startsWith(UNGATED_BINDING_PREFIX) && !(tool.permissions as JsonValue[]).some((permissionId) => Object.hasOwn(gated, String(permissionId)))) {
      throw refuse("consent_required_for_write", `tool ${pyRepr(toolId)} has write side effects and links no permission a consent step decides; in a conversation every consequential tool is behind a consent step`);
    }
  }
  const fixturePath = conversation.fixture;
  if (fixturePath !== undefined && fixturePath !== null) await checkFixture(graph, hooks.files, hooks.schemaPaths, String(fixturePath), consents, budget);
  return { keys, gated, consent_steps: consents.map((node) => String(node.id)) };
}

async function checkFixture(graph: JsonObject, files: ReadonlyMap<string, Uint8Array>, schemaPaths: ReadonlySet<string>, path: string, consents: JsonObject[], budget: JsonObject): Promise<void> {
  const data = files.get(path);
  if (data === undefined) throw refuse("conversation_fixture_missing", `missing conversation fixture ${path}`);
  const transcript = parseJson(data, path) as JsonObject;
  try {
    await validateTranscriptDocument(transcript, "input", path);
  } catch (error) {
    if (error instanceof ValidationError) throw refuse("conversation_fixture_invalid", error.message);
    throw error;
  }
  if (!graph.fixture) throw refuse("conversation_fixture_requires_graph_fixture", `${path}: a conversation fixture replays the graph's own fixture, which the graph does not declare`);
  const turns = transcript.turns as JsonObject[];
  if (turns.length > (budget.max_turns as number)) throw refuse("conversation_fixture_turns", `${path}: ${turns.length} turns, above the conversation's max_turns of ${budget.max_turns}`);
  const steps = new Set(consents.map((node) => String(node.id)));
  const schemas = await PackageSchemas.open(files, schemaPaths);
  try {
    for (const [index, turn] of turns.entries()) {
      try {
        await schemas.validateInstance(String(graph.input_schema), turn.message!, `${path} turn ${index + 1} message`);
      } catch (error) {
        if (error instanceof ValidationError) throw refuse("conversation_fixture_message", error.message);
        throw error;
      }
      const unknown = Object.keys((turn.consents as JsonObject | undefined) ?? {})
        .filter((step) => !steps.has(step))
        .sort();
      if (unknown.length > 0) throw refuse("consent_step_unknown", `${path} turn ${index + 1}: no consent step ${pyRepr(unknown[0]!)} in the graph`);
    }
  } finally {
    schemas.close();
  }
  const graphFixture = parseJson(files.get(String(graph.fixture))!, String(graph.fixture)) as JsonObject;
  if (canonicalString(graphFixture.input ?? null) !== canonicalString(turns[0]!.message)) {
    throw refuse("conversation_fixture_input", `${graph.fixture}: its input must equal the conversation fixture's first message`);
  }
}

export interface ConsentStepRecord extends JsonObject {
  id: string;
  permissions: string[];
  timeout_seconds: number;
  conditional: boolean;
  depends_on: string[];
}

export interface ConversationRecords extends JsonObject {
  state_schema: string;
  persistent_keys: string[];
  budget: { max_turns: number; hard_tokens: number; max_remote_calls: number; max_calls_per_tool: Record<string, number> };
  end_declared: boolean;
  fixture_declared: boolean;
  consent_steps: ConsentStepRecord[];
  gated_permissions: Record<string, string[]>;
}

/** The conversation as `inspect` and the agent page list it (V-20): the persistent keys, the budget, the end rule, each consent step with the permissions it decides. */
export function conversationRecords(pkg: Package): ConversationRecords | null {
  const conversation = conversationOf(pkg.graph);
  if (conversation === null) return null;
  const budget = conversation.budget as JsonObject;
  return {
    state_schema: String(conversation.state_schema),
    persistent_keys: persistentKeys(pkg),
    budget: {
      max_turns: budget.max_turns as number,
      hard_tokens: budget.hard_tokens as number,
      max_remote_calls: budget.max_remote_calls as number,
      max_calls_per_tool: { ...((budget.max_calls_per_tool as Record<string, number> | undefined) ?? {}) },
    },
    end_declared: "end" in conversation,
    fixture_declared: "fixture" in conversation,
    consent_steps: consentNodes(pkg.graph).map((node) => ({
      id: String(node.id),
      permissions: (node.permissions as JsonValue[]).map(String),
      timeout_seconds: node.timeout_seconds as number,
      conditional: "when" in node,
      depends_on: (node.depends_on as JsonValue[]).map(String),
    })),
    gated_permissions: gatedPermissions(pkg.graph),
  };
}
