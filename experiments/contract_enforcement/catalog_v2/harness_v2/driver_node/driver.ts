/**
 * Catalog v2's Node driver (T30, D-302): the Chrome core composed in process exactly as the CLI's
 * `run` (`src/cli-run.ts`, fixture mode) and `converse` (`src/cli-converse.ts`) compose it, with
 * observation-only wrappers at the four seams: the fixture router, the fixture tool handlers, the
 * compute engine and the consent host. Each wrapper records what crossed the seam and then returns
 * (or throws) exactly what the wrapped object returned (or threw).
 *
 * This file is copied next to a private copy of `chrome-agent-browser/src` (one per enforcement
 * profile, `harness_v2/build.py`) and bundled with the core's own esbuild; nothing in the
 * production tree imports it, and no production flag selects a patched copy.
 *
 * Protocol: one JSON case per stdin line, one JSON record per stdout line. `{"op":"hello"}` answers
 * the build this process runs (its profile and key, written by the build into `build.json`).
 */
import { createRequire } from "node:module";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";

import { nodeComputeEngine } from "../src/cli-compute.js";
import { Conversation, type TurnAdapters } from "../src/core/conversation/runner.js";
import { checkTranscript, readInputTranscript } from "../src/core/conversation/transcript.js";
import { TranscriptConsent, type ConsentHost, type ConsentRequest } from "../src/core/conversation/host.js";
import type { ComputeEngine, ComputeOutcome } from "../src/core/compute/engine.js";
import type { ComputeLimits } from "../src/core/compute/limits.js";
import { AgentPkgError } from "../src/core/errors.js";
import { artifactRecords } from "../src/core/execution/artifacts.js";
import { normalizeHostLimits } from "../src/core/execution/limits.js";
import { localExecutionPlan } from "../src/core/execution/plan.js";
import { ExecutionSession } from "../src/core/execution/runner.js";
import { fixtureAdapters } from "../src/core/fixtures.js";
import { sha256Hex } from "../src/core/hash.js";
import type { JsonObject, JsonValue } from "../src/core/json.js";
import { fingerprint, publicKeyFromPem } from "../src/core/keys.js";
import { checkMemoryBindings } from "../src/core/memory/run.js";
import type { ModelRouter } from "../src/core/models/contract.js";
import { loadPackageBytes, type Package } from "../src/core/package.js";
import { embeddedPublicKey, verifyWithTrustedKey } from "../src/core/signature.js";
import type { ToolHandler } from "../src/core/tools/handler.js";
import { CORE_VERSION } from "../src/core/version.js";

const HOST_RUNTIME = "chrome-agent-browser";
const require = createRequire(import.meta.url);

interface CaseInput {
  id: string;
  archive: string;
  trust_key: string;
  mode: "run" | "converse" | "execution_layer";
  grants: Record<string, string>;
  approve: string[];
  limits: JsonObject | null;
  transcript: JsonObject | null;
  consent_host: "silent" | "invalid" | null;
  engine: boolean;
  taints: string[];
  observe?: boolean;
}

interface Seams {
  model: JsonObject[];
  tool: JsonObject[];
  compute: JsonObject[];
  consent: JsonObject[];
}

// ---------------------------------------------------------------------------------------------
// The offline guard: a refused socket, name lookup, child process or fetch is counted even if a
// caller swallows the exception, and turns the case into a harness error (v1's rule).
const guardRefusals: JsonObject[] = [];
function refuse(kind: string): never {
  guardRefusals.push({ kind });
  throw new Error(`catalog v2 driver refused ${kind}`);
}
function installGuard(): void {
  const net = require("node:net");
  net.Socket.prototype.connect = function connect() {
    return refuse("socket");
  };
  net.connect = net.createConnection = () => refuse("socket");
  const dns = require("node:dns");
  dns.lookup = () => refuse("dns");
  dns.promises.lookup = async () => refuse("dns");
  const child = require("node:child_process");
  for (const name of ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"]) child[name] = () => refuse("process");
  (globalThis as { fetch?: unknown }).fetch = async () => refuse("fetch");
}

// ---------------------------------------------------------------------------------------------
// Seams (observation only).
function taintFlags(value: unknown, taints: readonly string[]): string[] {
  if (taints.length === 0) return [];
  const text = JSON.stringify(value) ?? "";
  return taints.filter((taint) => text.includes(taint));
}

// `observe: false` in a case runs the same composition with the raw objects (the driver-identity test).
let observing = true;

function recordingRouter(router: ModelRouter, seams: Seams, taints: readonly string[], turn: number | null): ModelRouter {
  if (!observing) return router;
  return new Proxy(router, {
    get(target, property, receiver) {
      if (property === "complete") {
        return async (request: JsonObject, maxOutputTokens: number, signal: AbortSignal) => {
          const entry: JsonObject = { turn, task: (request.task as JsonValue) ?? null, input: (request.data as JsonValue) ?? null, taints: taintFlags(request, taints), max_output_tokens: maxOutputTokens };
          seams.model.push(entry);
          try {
            const result = await target.complete(request as never, maxOutputTokens, signal);
            entry.outcome = "answered";
            entry.answer = ((result as unknown as JsonObject).output as JsonValue) ?? null;
            return result;
          } catch (error) {
            entry.outcome = "threw";
            throw error;
          }
        };
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

function recordingHandlers(pkg: Package, handlers: Record<string, ToolHandler>, seams: Seams, taints: readonly string[], turn: number | null): Record<string, ToolHandler> {
  if (!observing) return handlers;
  const toolOf: Record<string, string> = {};
  for (const [toolId, tool] of Object.entries(pkg.tools)) toolOf[String((tool as JsonObject).binding)] = toolId;
  const wrapped: Record<string, ToolHandler> = {};
  for (const [binding, handler] of Object.entries(handlers)) {
    wrapped[binding] = async (context, payload, signal, bounds) => {
      const entry: JsonObject = { turn, tool: toolOf[binding] ?? null, binding, role: context.role, payload: payload ?? null, taints: taintFlags(payload, taints) };
      seams.tool.push(entry);
      try {
        const answer = await handler(context, payload, signal, bounds);
        entry.outcome = "answered";
        return answer;
      } catch (error) {
        entry.outcome = "threw";
        throw error;
      }
    };
  }
  return wrapped;
}

function outcomeFacts(outcome: ComputeOutcome): JsonObject {
  let output: JsonValue = null;
  let outputJson = false;
  if (outcome.output !== null) {
    try {
      output = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(outcome.output)) as JsonValue;
      outputJson = true;
    } catch {
      output = null;
    }
  }
  return {
    ok: outcome.reason === null && outcome.output !== null,
    reason: outcome.reason,
    trap_code: outcome.trap_code,
    detail: outcome.detail,
    memory_pages: outcome.memory_pages,
    elapsed_ms: outcome.elapsed_ms,
    output_bytes: outcome.output === null ? null : outcome.output.length,
    output_json: outputJson,
    output,
  };
}

function recordingEngine(engine: ComputeEngine, seams: Seams, turn: number | null): ComputeEngine {
  if (!observing) return engine;
  return {
    get id() {
      return engine.id;
    },
    get metersFuel() {
      return engine.metersFuel;
    },
    compile: (sha256: string, data: Uint8Array) => engine.compile(sha256, data),
    call: async (sha256: string, fn: string, data: Uint8Array, limits: ComputeLimits, signal: AbortSignal) => {
      const entry: JsonObject = { turn, module_sha256: sha256, function: fn, input_bytes: data.length, limits: { memory_pages: limits.memory_pages, wall_seconds: limits.wall_seconds, fuel: limits.fuel } };
      seams.compute.push(entry);
      try {
        const outcome = await engine.call(sha256, fn, data, limits, signal);
        entry.outcome = outcomeFacts(outcome);
        return outcome;
      } catch (error) {
        entry.outcome = { ok: false, threw: true };
        throw error;
      }
    },
  };
}

function recordingConsent(host: ConsentHost, seams: Seams): ConsentHost {
  if (!observing) return host;
  return {
    get used() {
      return host.used;
    },
    decide: async (request: ConsentRequest, signal: AbortSignal) => {
      const entry: JsonObject = { turn: request.turn, step: request.step, permissions: [...request.permissions], text: request.text, facts: request.facts };
      seams.consent.push(entry);
      const answer = await host.decide(request, signal);
      entry.answer = (answer ?? null) as JsonValue;
      return answer;
    },
  } as ConsentHost;
}

/** The two consent hosts a CLI cannot express (examples/conversation/cases: `silent`, `invalid`). */
class SilentConsent implements ConsentHost {
  readonly used = new Set<string>();
  decide(_request: ConsentRequest, signal: AbortSignal): Promise<unknown> {
    return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
  }
}
class InvalidConsent implements ConsentHost {
  readonly used = new Set<string>();
  async decide(): Promise<unknown> {
    return { accepted: "yes", decided_by: "nobody" };
  }
}

// ---------------------------------------------------------------------------------------------
const VOLATILE = new Set(["timestamp", "ts", "at", "time", "sequence", "seq", "hash", "prev_hash", "previous_hash", "event_hash", "run_id", "conversation_id"]);
function compactAudit(audit: readonly unknown[]): JsonObject[] {
  return audit.map((event) => Object.fromEntries(Object.entries(event as JsonObject).filter(([key]) => !VOLATILE.has(key))) as JsonObject);
}

function exportsOf(files: ReadonlyArray<readonly [string, Uint8Array]>): JsonObject {
  const fixed = new Set(["result.json", "audit.json", "usage.json", "provenance.json", "run.json"]);
  const exports: JsonObject = {};
  for (const [name, data] of files) {
    if (fixed.has(name)) continue;
    const text = new TextDecoder().decode(data);
    try {
      exports[name] = JSON.parse(text) as JsonValue;
    } catch {
      exports[name] = text;
    }
  }
  return exports;
}

function codeOf(error: unknown): string | null {
  const own = (error as { code?: unknown })?.code;
  if (typeof own === "string" && /^[a-z][a-z0-9_]*$/u.test(own)) return own;
  const message = error instanceof Error ? error.message : String(error);
  const workflow = /^workflow\.v0 ([a-z][a-z0-9_]*)/u.exec(message);
  if (workflow) return workflow[1]!;
  const prefix = /^([a-z][a-z0-9_]*): /u.exec(message);
  return prefix ? prefix[1]! : null;
}

function refusal(phase: string, error: unknown): JsonObject {
  return {
    phase,
    code: codeOf(error),
    error_class: error instanceof Error ? error.constructor.name : typeof error,
    agentpkg_error: error instanceof AgentPkgError || (error instanceof Error && "code" in error),
    message: (error instanceof Error ? error.message : String(error)).slice(0, 400),
  };
}

const DEFAULT_LIMITS_FOR = (limits: JsonObject | null): JsonObject => (limits === null ? (normalizeHostLimits(null) as unknown as JsonObject) : limits);

async function runCase(input: CaseInput): Promise<JsonObject> {
  observing = input.observe !== false;
  const seams: Seams = { model: [], tool: [], compute: [], consent: [] };
  const record: JsonObject = { id: input.id, runtime: "ts", refusal: null, result: null, audit: [], exports: {}, seams: seams as unknown as JsonObject, guard: [], harness_error: null };
  const guardBefore = guardRefusals.length;
  const started = performance.now();
  let phase = "load";
  try {
    const bytes = new Uint8Array(readFileSync(input.archive));
    const pkg = await loadPackageBytes(bytes);
    phase = "cli";
    if (pkg.manifest.entrypoint !== "workflow.v0") throw new AgentPkgError("Generic execution requires workflow.v0; use agentpkg-legacy for the archived development profile");
    const conversational = pkg.graph.conversation !== undefined && pkg.graph.conversation !== null;
    const trustKey = publicKeyFromPem(readFileSync(input.trust_key, "utf8"));
    const rawEngine = input.engine ? nodeComputeEngine(new URL("./compute-worker.js", import.meta.url)) : null;
    if (input.mode === "converse") {
      // cli-converse.ts, fixture mode.
      if (!conversational) throw new AgentPkgError("conversation_profile_required: this package declares no conversation; use agentpkg run");
      phase = "verify";
      await verifyWithTrustedKey(pkg, trustKey);
      if (pkg.signature === null) throw new AgentPkgError("This runner executes signed packages only; sign the artifact first (agentpkg sign)");
      phase = "start";
      const transcript = input.transcript !== null ? await readInputTranscript(input.transcript, "transcript.json") : null;
      if (transcript === null) {
        const { fixtureTranscript } = await import("../src/core/conversation/runner.js");
        const declared = fixtureTranscript(pkg);
        if (declared === null) throw new AgentPkgError("A conversation needs --transcript (in fixture mode the package's conversation fixture serves when it declares one)");
        return await converse(pkg, declared, input, seams, record, rawEngine, started, guardBefore);
      }
      return await converse(pkg, transcript, input, seams, record, rawEngine, started, guardBefore);
    }
    if (conversational && input.mode === "run") throw new AgentPkgError("conversation_profile: this package declares a conversation and runs turn by turn; use agentpkg converse");
    // cli-run.ts, fixture mode (`execution_layer` skips only the CLI's own profile check above, to
    // ask the execution layer itself, as conformance/drivers/execution-policy.ts does).
    phase = "verify";
    await verifyWithTrustedKey(pkg, trustKey);
    if (pkg.signature === null) throw new AgentPkgError("This runner executes signed packages only; sign the artifact first (agentpkg sign)");
    const signer = await fingerprint(await embeddedPublicKey(pkg.signature));
    const approved = [...new Set(input.approve)].sort();
    const limitsRaw = DEFAULT_LIMITS_FOR(input.limits);
    phase = "start";
    normalizeHostLimits(limitsRaw);
    const archiveSha256 = await sha256Hex(bytes);
    checkMemoryBindings(pkg);
    const fixture = fixtureAdapters(pkg);
    const router = recordingRouter(fixture.router, seams, input.taints, null);
    const handlers = recordingHandlers(pkg, fixture.handlers, seams, input.taints, null);
    const { plan, authorization } = localExecutionPlan({ pkg, archiveSha256, signerFingerprint: signer, decisions: input.grants, approvedTools: approved, fixture: true });
    const session = new ExecutionSession();
    phase = "admission";
    await session.begin(
      { run_id: `run_${randomBytes(16).toString("hex")}`, run_plan: plan, authorization, input: fixture.input, limits: limitsRaw, host: { runtime: HOST_RUNTIME, runtime_version: CORE_VERSION, verified_version: CORE_VERSION } },
      { archive: bytes, fixture: { router, handlers }, compute: rawEngine === null ? null : recordingEngine(rawEngine, seams, null) },
    );
    phase = "run";
    const outcome = await session.run();
    const result = outcome.result;
    const failure = (result.failure ?? null) as JsonObject | null;
    record.result = { status: result.status, error_code: result.error_code ?? null, failed_node: failure && typeof failure.node_id === "string" ? failure.node_id : null };
    record.audit = compactAudit(outcome.report.audit);
    record.exports = exportsOf(outcome.files);
    record.memory = (outcome.report.memory ?? null) as JsonValue;
  } catch (error) {
    record.refusal = refusal(phase, error);
  }
  return finish(record, started, guardBefore);
}

async function converse(pkg: Package, transcript: Awaited<ReturnType<typeof readInputTranscript>>, input: CaseInput, seams: Seams, record: JsonObject, engine: ComputeEngine | null, started: number, guardBefore: number): Promise<JsonObject> {
  let phase = "start";
  try {
    const grants = input.grants as never;
    const approved = [...new Set(input.approve)].sort();
    await checkTranscript(transcript, pkg, grants);
    checkMemoryBindings(pkg);
    let fixture: ReturnType<typeof fixtureAdapters> | null = null;
    const turnFiles: Record<string, JsonObject> = {};
    const consentHost = (turn: number, decisions: Record<string, boolean>): ConsentHost => {
      const host = input.consent_host === "silent" ? new SilentConsent() : input.consent_host === "invalid" ? new InvalidConsent() : new TranscriptConsent(decisions);
      void turn;
      return recordingConsent(host, seams);
    };
    const conversation = new Conversation(pkg, {
      grants,
      approvedTools: approved,
      adapters: (turn): TurnAdapters => ({
        router: recordingRouter(fixture!.router, seams, input.taints, turn),
        handlers: recordingHandlers(pkg, fixture!.handlers, seams, input.taints, turn),
        compute: engine === null ? null : recordingEngine(engine, seams, turn),
      }),
      limits: (input.limits ?? null) as never,
      consent: consentHost,
      onTurn: (index, report, status) => {
        const records = artifactRecords(report as unknown as JsonObject, status === "completed" ? pkg : null);
        turnFiles[String(index)] = exportsOf(records.map((item) => [item[0], item[1]] as const));
      },
    });
    // As cli-converse.ts: the conversation checks the host's inputs when it is built, then the
    // fixture's adapters are made.
    fixture = fixtureAdapters(pkg);
    phase = "run";
    const result = await conversation.run(transcript);
    const turns = (result.transcript.turns as JsonObject[]).map((turn) => ({ turn: turn.turn ?? null, status: turn.status ?? null, refusal: turn.refusal ?? null, error_code: turn.error_code ?? null, decisions: turn.decisions ?? [] }));
    record.result = { status: result.status, error_code: (turns.find((turn) => turn.status === "failed")?.error_code as JsonValue) ?? null, failed_node: null, turns: turns as unknown as JsonValue, ended: result.ended as unknown as JsonValue, state: result.state };
    record.audit = compactAudit(result.audit);
    record.exports = turnFiles;
  } catch (error) {
    record.refusal = refusal(phase, error);
  }
  return finish(record, started, guardBefore);
}

function finish(record: JsonObject, started: number, guardBefore: number): JsonObject {
  record.guard = guardRefusals.slice(guardBefore);
  record.elapsed_ms = Math.round(performance.now() - started);
  return record;
}

async function main(): Promise<void> {
  installGuard();
  const build = JSON.parse(readFileSync(new URL("./build.json", import.meta.url), "utf8")) as JsonObject;
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of lines) {
    if (line.trim() === "") continue;
    const message = JSON.parse(line) as JsonObject;
    let answer: JsonObject;
    if (message.op === "hello") answer = { op: "hello", runtime: "ts", build, core_version: CORE_VERSION };
    else {
      try {
        answer = await runCase(message as unknown as CaseInput);
      } catch (error) {
        answer = { id: String(message.id), runtime: "ts", harness_error: error instanceof Error ? `${error.name}: ${error.message}`.slice(0, 400) : String(error) };
      }
    }
    process.stdout.write(`${JSON.stringify(answer)}\n`);
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exit(1);
});
