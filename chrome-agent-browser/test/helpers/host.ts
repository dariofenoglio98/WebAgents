/**
 * The execution host for tests (T5): `executeRun` in-process over the harness's memory stores,
 * with a scripted model (an Ollama `/api/chat` that answers each task from a table) and a
 * scripted WebAir origin (the real origin's recorded answers, `test/fixtures/webair-origin-
 * answers.json`). Both transports record every outbound body, which is how the privacy
 * assertions of D-028 are made: no sealed value in any model request, a granted value only on
 * the tool endpoint that links its permission.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { BuiltinModelPort } from "../../src/core/models/adapters/chrome-builtin.js";
import { TransportError, type HttpRequest, type HttpTransport } from "../../src/core/models/transport.js";
import type { ExecutionHostBridge } from "../../src/extension/background/runs.js";
import { executeRun, type ExecutionHandle } from "../../src/extension/execution/execute.js";
import type { HostStartMessage, HostStatusReply } from "../../src/extension/execution/protocol.js";
import type { RunStore } from "../../src/extension/storage/runs.js";
import type { SnapshotStore } from "../../src/extension/storage/snapshots.js";
import { PROJECT } from "./paths.js";

export interface OriginAnswers {
  search: { input: Record<string, unknown>; output: Record<string, unknown> };
  fare_rules: Record<string, Record<string, unknown>>;
  prepare_booking: { input: Record<string, unknown>; output: Record<string, unknown> };
  simulate_purchase: { input: Record<string, unknown>; output: Record<string, unknown> };
}

export function originAnswers(): OriginAnswers {
  return JSON.parse(readFileSync(join(PROJECT, "test", "fixtures", "webair-origin-answers.json"), "utf8")) as OriginAnswers;
}

export interface SeenRequest {
  url: string;
  method: string;
  body: string | null;
  headers: Record<string, string>;
}

/** The WebAir origin as the recorded answers describe it: four operations, JSON in, JSON out; everything else 404. */
export function scriptedOrigin(answers: OriginAnswers = originAnswers(), seen: SeenRequest[] = []): { transport: HttpTransport; seen: SeenRequest[] } {
  const transport: HttpTransport = async (request: HttpRequest) => {
    seen.push({ url: request.url, method: request.method, body: request.body, headers: { ...request.headers } });
    if (request.signal.aborted) throw request.signal.reason;
    const url = new URL(request.url);
    const json = (status: number, value: unknown) => ({ status, headers: { "content-type": "application/json" }, body: JSON.stringify(value) });
    const args = request.body ? (JSON.parse(request.body) as Record<string, unknown>) : {};
    switch (url.pathname) {
      case "/api/v1/search_flights":
        return json(200, answers.search.output);
      case "/api/v1/get_fare_rules": {
        const rules = answers.fare_rules[String(args.fare_id)];
        return rules ? json(200, rules) : json(404, { error: { code: "fare_not_found", message: "no such fare", details: [] } });
      }
      case "/api/v1/prepare_booking":
        return json(200, answers.prepare_booking.output);
      case "/api/v1/simulate_purchase":
        if (args.quote_id !== answers.prepare_booking.output.quote_id) return json(422, { error: { code: "quote_mismatch", message: "the quote does not match", details: [] } });
        return json(200, answers.simulate_purchase.output);
      default:
        return json(404, { error: { code: "not_found", message: "not found", details: [] } });
    }
  };
  return { transport, seen };
}

export type TaskAnswers = Record<string, (userJson: unknown, system: string) => unknown>;

/** Ollama `/api/chat` as a table of answers per task (the `## Task` line of the system prompt). */
export function scriptedOllama(answers: TaskAnswers, seen: SeenRequest[] = [], model = "qwen3:30b"): { transport: HttpTransport; seen: SeenRequest[] } {
  const transport: HttpTransport = async (request: HttpRequest) => {
    seen.push({ url: request.url, method: request.method, body: request.body, headers: { ...request.headers } });
    if (request.signal.aborted) throw request.signal.reason;
    const body = JSON.parse(request.body ?? "{}") as { messages?: Array<{ role: string; content: string }>; model?: string };
    const system = body.messages?.find((message) => message.role === "system")?.content ?? "";
    const user = body.messages?.find((message) => message.role === "user")?.content ?? "null";
    const task = /^## Task\n(.+)$/mu.exec(system)?.[1] ?? "";
    const answer = answers[task];
    if (!answer) throw new TransportError(`no scripted answer for task ${JSON.stringify(task)}`, { stage: "transport" });
    const content = JSON.stringify(answer(JSON.parse(user), system));
    return { status: 200, headers: { "content-type": "application/json" }, body: JSON.stringify({ model: body.model ?? model, message: { role: "assistant", content }, done: true, done_reason: "stop", prompt_eval_count: Math.ceil(system.length / 4), eval_count: Math.ceil(content.length / 4) }) };
  };
  return { transport, seen };
}

/** The WebAir search, booking and purchase answers a scripted model gives for the demo requests. */
export function webairModelAnswers(): TaskAnswers {
  const search = { origin: "BOS", destination: "ZRH", date: "2026-10-09", passengers: 1, nonstop_only: true, max_price_usd: 900, cabin: null };
  return {
    interpret: (user) => {
      const request = String((user as { request?: string }).request ?? "");
      return /paris/iu.test(request) ? { needs_travel_profile: false, search: null, unsupported_reason: "WebAir does not serve Paris." } : { needs_travel_profile: false, search, unsupported_reason: null };
    },
    select: (user) => {
      const flights = ((user as { search?: { flights?: Array<{ fares: Array<{ fare_id: string }> }> } }).search?.flights ?? []).flatMap((flight) => flight.fares.map((fare) => fare.fare_id));
      if (flights.length === 0) return { outcome: "no_matching_flights", fare_ids: [], selected_fare_id: null };
      // The package's own check (`check-options`) requires the selected fare to be one of the offered ones when options were found.
      const request = String((user as { request?: string }).request ?? "");
      const standard = flights.find((id) => id.endsWith("-STANDARD")) ?? flights[0]!;
      return { outcome: "options_found", fare_ids: flights.slice(0, 6), selected_fare_id: /standard|prepare|book/iu.test(request) ? standard : flights[0]! };
    },
    answer: (user) => {
      const input = user as { selection?: { fare_ids?: string[] }; booking_quote?: { quote_id?: string } | null; simulated_purchase?: { confirmation_id?: string } | null };
      const fares = input.selection?.fare_ids ?? [];
      const text = input.simulated_purchase?.confirmation_id
        ? `Simulated purchase confirmed (${input.simulated_purchase.confirmation_id}); nothing was charged.`
        : input.booking_quote?.quote_id
          ? `Quote ${input.booking_quote.quote_id} prepared for WA101 Economy Standard; nothing is booked.`
          : fares.length > 0
            ? `WebAir offers ${fares.length} fares from Boston to Zurich on 9 October.`
            : "WebAir returned no matching flights.";
      return { answer: text, mentioned_fare_ids: fares.slice(0, 24) };
    },
  };
}

export interface InProcessHostOptions {
  runs: RunStore;
  snapshots: SnapshotStore;
  model: HttpTransport;
  tool: HttpTransport;
  builtin?: BuiltinModelPort | null;
  now?: () => Date;
  available?: boolean;
  /** Fail `start` without running (an offscreen document that could not be created). */
  failStart?: boolean;
}

/** `executeRun` in this process: the offscreen document and its Worker, without Chrome. */
export class InProcessHost implements ExecutionHostBridge {
  readonly handles = new Map<string, ExecutionHandle>();
  readonly started: HostStartMessage[] = [];
  /** Late-bound: the harness points it at the controller's `host.*` handling. */
  report: (type: "host.progress" | "host.finished", runId: string) => Promise<unknown> = async () => undefined;
  /** Settles when every run started so far has finished and reported. */
  private settled: Promise<unknown> = Promise.resolve();

  constructor(private readonly options: InProcessHostOptions) {}

  available(): boolean {
    return this.options.available ?? true;
  }

  async start(message: HostStartMessage): Promise<void> {
    if (this.options.failStart) throw new Error("the offscreen document could not be created");
    this.started.push(message);
    const handle = executeRun({
      runs: this.options.runs,
      snapshots: this.options.snapshots,
      message,
      transports: { model: this.options.model, tool: this.options.tool },
      builtin: this.options.builtin ?? null,
      now: this.options.now,
      onCheckpoint: (runId) => void this.report("host.progress", runId).catch(() => undefined),
    });
    this.handles.set(message.runId, handle);
    const finished = handle.done.then(async () => {
      this.handles.delete(message.runId);
      await this.report("host.finished", message.runId).catch(() => undefined);
    });
    this.settled = Promise.all([this.settled, finished]);
  }

  async cancel(runId: string): Promise<void> {
    this.handles.get(runId)?.cancel();
  }

  async status(): Promise<HostStatusReply | null> {
    return { runs: [...this.handles.keys()].map((run_id) => ({ run_id, status: "running" as const })) };
  }

  /** Wait for every run in flight to finish and report. */
  async drain(): Promise<void> {
    let previous: Promise<unknown> | null = null;
    while (previous !== this.settled) {
      previous = this.settled;
      await previous;
    }
  }
}

/** A host that never receives a run (no network): starts refuse at the first model call. */
export function refusingTransport(): HttpTransport {
  return async () => {
    throw new TransportError("no network in this test", { stage: "transport" });
  };
}
