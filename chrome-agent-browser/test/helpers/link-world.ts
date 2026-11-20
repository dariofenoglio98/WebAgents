/**
 * Agent Links in the shell's tests (T66): T65's signed packages served from their own origins, a
 * scripted model that answers every task from the packages' own fixtures by exact request data
 * (so a request the runtime did not build as the reference builds it finds no answer), and the
 * origins' services answering from the fixtures' tool cases. Nothing is modified on disk (D-003).
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { canonicalString } from "../../src/core/canonical.js";
import type { JsonObject, JsonValue } from "../../src/core/json.js";
import { TransportError, type HttpRequest, type HttpTransport } from "../../src/core/models/transport.js";
import { loadPackageBytes, type Package } from "../../src/core/package.js";
import type { SeenRequest } from "./host.js";
import { ROOT } from "./paths.js";
import { generateKeyPair, signedArchive } from "./keys.js";
import { PACKAGE_MEDIA_TYPE, type Route } from "./shell.js";
import { listMembers } from "./zip.js";

export const read = (path: string): Uint8Array => new Uint8Array(readFileSync(resolve(ROOT, path)));

export const TRIPWRIGHT = "https://webagents-tripwright-production.up.railway.app";
export const WEBAIR = "https://webagents-webair-production.up.railway.app";
export const STAYMERE = "https://webagents-staymere-production.up.railway.app";
export const SALITUBAM = "https://webagents-hotel-salitubam-production.up.railway.app";

export const PLANNER_URL = `${TRIPWRIGHT}/agent.pkg`;
/** The locators the planner's signed manifest pins. */
export const LOCATORS = {
  "webair-flights": `${WEBAIR}/packages/webair-flights-0.1.0.agent.pkg`,
  "hotel-aggregator": `${STAYMERE}/agent.pkg`,
} as const;

export const ARCHIVES = {
  planner010: "dist/travel-planner-0.1.0.agent.pkg",
  planner020: "dist/travel-planner-0.2.0.agent.pkg",
  flights: "dist/webair-flights-0.1.0.agent.pkg",
  staymere: "dist/staymere-hotels-0.1.0.agent.pkg",
  salitubam: "dist/hotel-salitubam-0.1.0.agent.pkg",
} as const;

export interface Fixture {
  input: JsonValue;
  models: Record<string, Array<{ input: JsonValue; output: JsonValue }>>;
  tools: Record<string, Array<{ input: JsonValue; output: JsonValue }>>;
}

export function fixtureOf(pkg: Package): Fixture {
  return JSON.parse(new TextDecoder().decode(pkg.files.get(String(pkg.graph.fixture))!)) as Fixture;
}

const packageRoute = (bytes: Uint8Array): Route => ({ headers: { "content-type": PACKAGE_MEDIA_TYPE, "content-length": String(bytes.length) }, body: bytes });

/** The origins as `fetch` routes: the planner at its address, each linked package at its locator. */
export function linkRoutes(planner: keyof typeof ARCHIVES = "planner010", overrides: Record<string, Route> = {}): Record<string, Route> {
  return {
    [PLANNER_URL]: packageRoute(read(ARCHIVES[planner])),
    [LOCATORS["webair-flights"]]: packageRoute(read(ARCHIVES.flights)),
    [LOCATORS["hotel-aggregator"]]: packageRoute(read(ARCHIVES.staymere)),
    ...overrides,
  };
}

/**
 * The planner 0.2.0 with its `FindHotel` role's token budget raised, signed with a throwaway key, in
 * memory (D-003: nothing on disk changes). The signed 0.2.0 gives that role 4,000 tokens per
 * activation, and its one model call, the request-building call (L-37), reserves its input bound
 * plus 1,500 output tokens. A Chrome host bounds the input by its UTF-8 bytes (D-115), which is
 * 2,886 for Hotel Salitubam, so the signed package's call is refused there (`worker_token_budget`);
 * with 6,000 the join runs. The composed worst case becomes 124,000 tokens, inside the package's
 * own 128,000.
 */
export async function plannerVariant(tokens = 6000): Promise<{ bytes: Uint8Array; fingerprint: string }> {
  const members = listMembers(read(ARCHIVES.planner020));
  const files = new Map([...members].filter(([name]) => name !== "integrity.json" && !name.startsWith("signatures/")));
  const graph = JSON.parse(new TextDecoder().decode(files.get("graph.json")!)) as { workers: Array<{ id: string; budget: { tokens: number } }> };
  graph.workers.find((worker) => worker.id === "FindHotel")!.budget.tokens = tokens;
  files.set("graph.json", new TextEncoder().encode(canonicalString(graph)));
  const key = await generateKeyPair();
  return { bytes: await signedArchive(files, key), fingerprint: key.fingerprint };
}

export interface ScriptedWorld {
  packages: Package[];
  model: HttpTransport;
  tool: HttpTransport;
  modelSeen: Array<SeenRequest & { task: string; matched: boolean; improvised: boolean }>;
  toolSeen: SeenRequest[];
}

/**
 * The scripted model and origins over these packages' fixtures. `pages` adds what a slot may look
 * at: a page by URL (its HTML) and a package by URL (its bytes), answered to a plain GET.
 */
export async function scriptedWorld(archives: ReadonlyArray<keyof typeof ARCHIVES>, pages: { html?: Record<string, string>; packages?: Record<string, Uint8Array>; improvise?: boolean } = {}): Promise<ScriptedWorld> {
  const packages = await Promise.all(archives.map((name) => loadPackageBytes(read(ARCHIVES[name]))));
  const fixtures = packages.map(fixtureOf);
  const modelSeen: ScriptedWorld["modelSeen"] = [];
  const toolSeen: SeenRequest[] = [];
  const model: HttpTransport = async (request: HttpRequest) => {
    if (request.signal.aborted) throw request.signal.reason;
    const body = JSON.parse(request.body ?? "{}") as { messages?: Array<{ role: string; content: string }>; model?: string };
    const system = body.messages?.find((message) => message.role === "system")?.content ?? "";
    const user = body.messages?.find((message) => message.role === "user")?.content ?? "null";
    const task = /^## Task\n(.+)$/mu.exec(system)?.[1] ?? "";
    const wanted = canonicalString(JSON.parse(user));
    const match = fixtures.flatMap((fixture) => fixture.models[task] ?? []).find((item) => canonicalString(item.input) === wanted);
    // A walk the fixture did not record (a denied publisher changes every route request): a planner that
    // asks each role still offered once, in the order offered, and then ends. Only where a test asks for it.
    const improvised = match === undefined && pages.improvise === true ? improvise(task, JSON.parse(user) as JsonObject) : undefined;
    modelSeen.push({ url: request.url, method: request.method, body: request.body, headers: { ...request.headers }, task, matched: match !== undefined, improvised: improvised !== undefined });
    if (match === undefined && improvised === undefined) throw new TransportError(`no fixture case for task ${JSON.stringify(task)} and these request data`, { stage: "transport" });
    const content = JSON.stringify(match !== undefined ? match.output : improvised);
    return { status: 200, headers: { "content-type": "application/json" }, body: JSON.stringify({ model: body.model ?? "qwen3:30b", message: { role: "assistant", content }, done: true, done_reason: "stop", prompt_eval_count: Math.ceil(system.length / 4), eval_count: Math.ceil(content.length / 4) }) };
  };
  // Each declared remote tool's endpoint, with the cases of the package that declares it.
  const services = new Map<string, Array<{ input: JsonValue; output: JsonValue }>>();
  packages.forEach((pkg, index) => {
    for (const [toolId, tool] of Object.entries(pkg.tools)) if (typeof tool.endpoint === "string") services.set(tool.endpoint, [...(services.get(tool.endpoint) ?? []), ...(fixtures[index]!.tools[toolId] ?? [])]);
  });
  const tool: HttpTransport = async (request: HttpRequest) => {
    toolSeen.push({ url: request.url, method: request.method, body: request.body, headers: { ...request.headers } });
    if (request.signal.aborted) throw request.signal.reason;
    const json = (status: number, value: unknown) => ({ status, headers: { "content-type": "application/json" }, body: JSON.stringify(value) });
    if (request.method === "GET") {
      const html = pages.html?.[request.url];
      if (html !== undefined) return { status: 200, headers: { "content-type": "text/html; charset=utf-8" }, body: html, bytes: new TextEncoder().encode(html) };
      const bytes = pages.packages?.[request.url];
      if (bytes !== undefined) return { status: 200, headers: { "content-type": PACKAGE_MEDIA_TYPE }, body: "", bytes };
      return json(404, { error: { code: "not_found", message: "not found", details: [] } });
    }
    const cases = services.get(request.url);
    if (cases === undefined) return json(404, { error: { code: "not_found", message: "not found", details: [] } });
    const wanted = canonicalString(JSON.parse(request.body ?? "null"));
    const match = cases.find((item) => canonicalString(item.input) === wanted);
    return match ? json(200, match.output) : json(422, { error: { code: "invalid_request", message: "no such request", details: [] } });
  };
  return { packages, model, tool, modelSeen, toolSeen };
}

/** The planner's two model tasks answered without a recording: the trip as the state holds it; the next role still offered, else the end. */
function improvise(task: string, data: JsonObject): JsonValue | undefined {
  // The planner 0.2.0 also restates the hotel the person named; a slot's refusal is in the state by its reason, which the recording holds only for `unattended`.
  if (task === "understand") return { summary: "As the shared state stands.", trip: data.trip ?? null, ...(Object.hasOwn(data, "hotel_name") ? { hotel_name: data.hotel_name ?? null } : {}) };
  if (task === "route") {
    const targets = (data.targets as Array<{ role: string; uses_left: number }> | undefined) ?? [];
    const next = (data.hops_left as number) >= 2 ? targets.find((target) => target.uses_left > 0) : undefined;
    return next !== undefined ? { message: { notes: "", text: `Ask ${next.role}.` }, next: next.role } : { message: { notes: "", text: "Answered with what was allowed." }, next: "done" };
  }
  return undefined;
}

/** The join fixture's recorded web (`examples/link/join-fixture.json`): the hotel's page and its package, by URL. */
export function recordedHotel(): { html: Record<string, string>; packages: Record<string, Uint8Array> } {
  const fixture = JSON.parse(readFileSync(resolve(ROOT, "examples/link/join-fixture.json"), "utf8")) as { pages: Record<string, { body: string }>; packages: Record<string, string> };
  return {
    html: Object.fromEntries(Object.entries(fixture.pages).map(([url, page]) => [url, page.body])),
    packages: Object.fromEntries(Object.entries(fixture.packages).map(([url, path]) => [url, read(`examples/link/${path}`)])),
  };
}

export const grantsOf = (path: string): Record<string, string> => JSON.parse(readFileSync(resolve(ROOT, path), "utf8")) as Record<string, string>;
export type { JsonObject };
