/**
 * The citation test package (T13): `test/fixtures/citation-package/`, a minimal `workflow.v0` source
 * tree that searches Crossref once (`scholarly.search`, Literature Review's own search schemas byte
 * for byte, so the host's pinned contract digests match) and resolves a list of identifiers through
 * a `citation.resolve` tool at the Citation Resolver's real origin that also declares
 * `api.crossref.org` (D-153). It calls no model. It is run here through the host's real tool path:
 * the registry derived from the package, the person's decisions, the frozen plan records and the
 * broker, over a scripted network. Never a shipped artifact.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import { buildHostToolRegistry, evaluateRegistry, planToolBindings } from "../../src/core/hosttools.js";
import type { JsonObject, JsonValue } from "../../src/core/json.js";
import type { HttpRequest, HttpResponse, HttpTransport } from "../../src/core/models/transport.js";
import type { Package } from "../../src/core/package.js";
import { normalizeToolBindings } from "../../src/core/tools/bindings.js";
import { toolHandlers, type BoundToolHandler, type BrokerDeps } from "../../src/core/tools/broker.js";
import { definitionsFromRegistry } from "../../src/core/tools/definitions.js";
import { Pacer } from "../../src/core/tools/pacer.js";
import { runWorkflow, type WorkflowResult } from "../../src/core/workflow/interpreter.js";
import { PROJECT } from "./paths.js";
import { loadSource, type Files } from "./source-tree.js";

export const RESOLVER_HOST = "webagents-citation-resolver-production.up.railway.app";
export const CITATION_SOURCE = join(PROJECT, "test", "fixtures", "citation-package");
const NOW = new Date("2026-10-10T12:00:00.000Z");

function walk(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

/** The source tree's members, keyed by package path. */
export function citationFiles(): Files {
  const files: Files = new Map();
  for (const path of walk(CITATION_SOURCE).sort()) files.set(relative(CITATION_SOURCE, path).split("\\").join("/"), new Uint8Array(readFileSync(path)));
  return files;
}

export function citationPackage(files: Files = citationFiles()): Promise<Package> {
  return loadSource(files);
}

export type Reply = HttpResponse | Error;
export type Script = (request: HttpRequest, index: number) => Reply;

export const json = (status: number, body: unknown, headers: Record<string, string> = {}): HttpResponse => ({ status, headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
export const text = (status: number, body: string, headers: Record<string, string> = {}): HttpResponse => ({ status, headers: { "content-type": "text/plain", ...headers }, body });

/** A network of scripted answers, per destination kind, recorded in order with the time each left. */
export function scriptedNetwork(script: { search?: Script; resolver?: Script; lookup?: Script }, clock: () => number = Date.now): { transport: HttpTransport; seen: Array<{ kind: string; url: string; at: number; body: string | null }> } {
  const seen: Array<{ kind: string; url: string; at: number; body: string | null }> = [];
  const counters = new Map<string, number>();
  const transport: HttpTransport = async (request) => {
    const url = new URL(request.url);
    const kind = url.hostname === RESOLVER_HOST ? "resolver" : url.hostname === "api.crossref.org" && url.pathname === "/works" ? "search" : url.hostname === "api.crossref.org" && url.pathname.startsWith("/works/") ? "lookup" : "other";
    const index = counters.get(kind) ?? 0;
    counters.set(kind, index + 1);
    seen.push({ kind, url: request.url, at: clock(), body: request.body });
    const answer = (script as Record<string, Script | undefined>)[kind]?.(request, index);
    if (answer === undefined) throw new Error(`no scripted answer for ${request.method} ${request.url}`);
    if (answer instanceof Error) throw answer;
    return answer;
  };
  return { transport, seen };
}

export const SEARCH_ANSWER = {
  status: "ok",
  message: {
    items: [
      { DOI: "10.5555/Prompt.Defense.1", title: ["Defending <i>agents</i> against prompt injection"], author: [{ given: "Ada", family: "Lovelace" }], published: { "date-parts": [[2025, 3]] }, "container-title": ["Journal of Examples"], abstract: "<jats:p>A synthetic abstract.</jats:p>", URL: "https://doi.org/10.5555/prompt.defense.1" },
    ],
  },
};

/** A synthetic Crossref work for the DOI lookup, in the shape `works/{doi}` answered on 2026-10-10 (T13 progress log). */
export function work(doi: string, overrides: JsonObject = {}): JsonObject {
  return {
    status: "ok",
    "message-type": "work",
    "message-version": "1.0.0",
    message: {
      DOI: doi,
      URL: `https://doi.org/${doi}`,
      title: ["On <i>synthetic</i> records"],
      author: [{ given: "Grace", family: "Hopper", sequence: "first", affiliation: [] }, { name: "The Example Consortium", sequence: "additional", affiliation: [] }],
      "container-title": ["Proceedings of Examples"],
      published: { "date-parts": [[2021, 3]] },
      issued: { "date-parts": [[2021, 3]] },
      publisher: "Example &amp; Sons",
      type: "proceedings-article",
      abstract: "<jats:p>We <jats:italic>describe</jats:italic> a synthetic record.</jats:p>",
      page: "610-623",
      ...overrides,
    },
  };
}

export const RESOLVED = (query: string): JsonObject => ({
  status: "resolved",
  query,
  detected_type: "doi",
  best_match: { title: "From the resolver", authors: [{ name: "R. Esolver" }], doi: query.toLowerCase(), source: "crossref" },
  match_score: 1,
  alternatives: [],
  sources: [{ provider: "crossref", status: "ok", error_code: null }],
  warnings: [],
  message: "Exact identifier verified against the provider record.",
});

export interface Run {
  result: WorkflowResult | null;
  error: (Error & { code?: string; node_id?: string | null; execution_report?: Record<string, unknown> }) | null;
  audit: Array<Record<string, unknown>>;
  bound: BoundToolHandler[];
}

/** Bind the package's tools as this Chrome host does, then run it over `transport`. */
export async function runCitations(pkg: Package, input: JsonValue, transport: HttpTransport, deps: Partial<BrokerDeps> = {}): Promise<Run> {
  const registry = await buildHostToolRegistry(pkg, { resourceTypes: [], runtimeVersion: "0.1.0", now: NOW });
  const decisions = { "network.scholarly": "session", "network.citations": "session", "model.reasoning": "deny", "memory.session": "session" } as const;
  const evaluation = await evaluateRegistry(pkg, registry, { decisions: { ...decisions }, toolApprovals: { "citation-resolver": true, "scholarly-search": true }, now: NOW });
  const records = normalizeToolBindings(planToolBindings(evaluation));
  const { handlers, bound } = toolHandlers(records, { definitions: definitionsFromRegistry(registry), transport, pacer: new Pacer(), ...deps });
  const grants = { "network.scholarly": "session", "network.citations": "session", "memory.session": "session" } as const;
  try {
    const result = await runWorkflow(pkg, input, { handlers, grants: { ...grants }, approvedTools: ["citation-resolver", "scholarly-search"] });
    return { result, error: null, audit: result.audit as unknown as Array<Record<string, unknown>>, bound };
  } catch (error) {
    const failure = error as Run["error"] & object;
    return { result: null, error: failure, audit: (failure.execution_report?.audit ?? []) as Array<Record<string, unknown>>, bound };
  }
}
