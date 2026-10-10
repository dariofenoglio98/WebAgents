/**
 * Literature Review 0.2.7 against the faults that stopped or emptied 0.2.6 (T15, D-170, D-171): the
 * user's runs of 2026-10-09 (B-151) and the transient service failures T13 made the host recover
 * from. Each case runs both versions through this host's real paths: the bound router (which
 * re-asks a non-conforming answer, D-151) over a scripted reviewer that answers every task from its
 * request the way a careful model following the skills would, and the real tool registry, plan
 * records and broker over a scripted network (Crossref search, the Citation Resolver, Crossref's DOI
 * lookup). Nothing reaches a network. 0.2.6 is the shipped archive; 0.2.7 is the source tree.
 */
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { buildHostToolRegistry, evaluateRegistry, planToolBindings } from "../../../src/core/hosttools.js";
import type { JsonObject, JsonValue } from "../../../src/core/json.js";
import type { RenderedRequest } from "../../../src/core/models/render.js";
import { BoundModelRouter, type ProviderAdapter, type ProviderCompletion } from "../../../src/core/models/router.js";
import type { HttpRequest } from "../../../src/core/models/transport.js";
import { loadPackageBytes, type Package } from "../../../src/core/package.js";
import { normalizeToolBindings } from "../../../src/core/tools/bindings.js";
import { toolHandlers } from "../../../src/core/tools/broker.js";
import { definitionsFromRegistry } from "../../../src/core/tools/definitions.js";
import { Pacer } from "../../../src/core/tools/pacer.js";
import { runWorkflow, type WorkflowResult } from "../../../src/core/workflow/interpreter.js";
import { json, RESOLVER_HOST, scriptedNetwork, text, work, type Script } from "../../helpers/citation-package.js";
import { SHIPPED } from "../../helpers/paths.js";
import { loadSource, sourceTree } from "../../helpers/source-tree.js";

const NOW = new Date("2026-10-10T12:00:00.000Z");
const QUESTION = "What scripted defenses against prompt injection have been proposed?";

// -- the scripted corpus: three queries, two works each, one DOI found twice ------------------------
const ABSTRACT = (n: number) => `Scripted defense ${n} isolates untrusted text before it reaches the model. It reduces attack success in its own evaluation.`;
const WORKS: Record<string, number[]> = { "scripted query 1": [1, 2], "scripted query 2": [3, 1], "scripted query 3": [4, 5] };
const doi = (n: number) => `10.5555/scripted.${n}`;
const crossrefItem = (n: number) => ({ DOI: doi(n), title: [`Scripted Defense ${n}`], author: [{ given: "Ada", family: `Author${n}` }], published: { "date-parts": [[2026, 1]] }, "container-title": ["Scripted Proceedings"], abstract: ABSTRACT(n), URL: `https://doi.org/${doi(n)}` });
const FOUND = 5; // five distinct DOIs

const search: Script = (request) => {
  const query = new URL(request.url).searchParams.get("query.bibliographic")!;
  return json(200, { status: "ok", message: { items: (WORKS[query] ?? []).map(crossrefItem) } });
};
const resolved = (query: string): JsonObject => {
  const n = Number(query.split(".").pop());
  return {
    status: "resolved",
    query,
    detected_type: "doi",
    best_match: { title: `Scripted Defense ${n}`, authors: [{ name: `Ada Author${n}`, given: "Ada", family: `Author${n}`, orcid: null }], year: 2026, venue: "Scripted Proceedings", publisher: null, doi: query, arxiv_id: null, url: `https://doi.org/${query}`, publication_type: "journal-article", abstract: ABSTRACT(n), volume: null, issue: null, pages: null, journal_reference: null, provider_ids: { crossref: query }, source: "crossref", bibtex: null },
    match_score: 1,
    alternatives: [],
    sources: [{ provider: "crossref", status: "ok", error_code: null }],
    warnings: [],
    message: "Exact identifier verified against the provider record.",
  };
};
const resolverQuery = (request: HttpRequest) => (JSON.parse(request.body!) as { query: string }).query;
const resolver: Script = (request) => json(200, resolved(resolverQuery(request)));
/** Crossref's works/{doi} record for a scripted DOI, as T13's lookup reads it. */
const lookup: Script = (request) => {
  const query = decodeURIComponent(new URL(request.url).pathname.slice("/works/".length));
  const n = Number(query.split(".").pop());
  return json(200, work(query, { title: [`Scripted Defense ${n}`], abstract: ABSTRACT(n), author: [{ given: "Ada", family: `Author${n}`, sequence: "first", affiliation: [] }] }));
};

// -- the scripted reviewer -------------------------------------------------------------------------
type Fault = (task: string, attempt: number, answer: JsonValue, data: JsonObject) => JsonValue | undefined;
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/** Answers every Literature Review task from its request; `fault` may replace an answer. */
class Reviewer implements ProviderAdapter {
  readonly provider_id = "test";
  readonly model_id = "reviewer";
  readonly host_model_id = "test/reviewer";
  readonly remote = true;
  readonly reasoning = true;
  readonly context_window = 1_000_000;
  readonly domains = ["model.test"];
  readonly pricing = null;
  readonly calls: Array<{ task: string; attempt: number; correction: string | null }> = [];
  private readonly attempts = new Map<string, number>();

  constructor(private readonly fault: Fault = () => undefined) {}

  async complete(rendered: RenderedRequest, _max: number, signal: AbortSignal): Promise<ProviderCompletion> {
    if (signal.aborted) throw signal.reason;
    const task = /## Task\n([^\n]+)/u.exec(rendered.system)![1]!;
    const data = JSON.parse(rendered.user) as JsonObject;
    const key = `${task}:${rendered.user}`;
    const attempt = (this.attempts.get(key) ?? 0) + 1;
    this.attempts.set(key, attempt);
    this.calls.push({ task, attempt, correction: rendered.system.split("## Correction\n")[1] ?? null });
    const answer = this.answer(task, data, rendered.system);
    const given = this.fault(task, attempt, clone(answer), data);
    return { text: JSON.stringify(given === undefined ? answer : given), model_id: "test/reviewer", response_model: "reviewer", stop_reason: "stop", usage: { input_tokens: 100, output_tokens: 20 }, constrained: false, constraint_detail: "test" };
  }

  private answer(task: string, data: JsonObject, system: string): JsonValue {
    const verdict = { screening_status: "include", screening_rationale: "The abstract describes a defense." };
    switch (task) {
      case "plan":
        return { queries: Object.keys(WORKS), rationale: "One query per facet.", seed_queries: [] };
      case "normalize": {
        const documents = data.documents as Record<string, string>;
        const candidates = data.candidates as JsonObject[];
        if ("paper_id" in (candidates[0] ?? {})) {
          // 0.2.7: the papers are named; only each one's file id is asked for.
          return { candidates: candidates.map((paper) => ({ paper_id: paper.paper_id!, file_id: documents[paper.doi as string] ?? null })) };
        }
        // 0.2.6: deduplicate, name and copy every record, then one reference each.
        const seen = new Set<string>();
        const papers = candidates.filter((raw) => !seen.has(raw.doi as string) && seen.add(raw.doi as string)).map((raw) => ({
          paper_id: raw.doi!, title: raw.title!, doi: raw.doi!, arxiv_id: raw.arxiv_id ?? null, authors: raw.authors!, year: raw.year!, venue: raw.venue!, abstract: raw.abstract!, url: raw.url!, source: raw.source!, provenance: raw.provenance!,
          full_text_available: false, screening_status: "pending", screening_rationale: "",
        }));
        return { candidate_papers: papers, screening_refs: papers.map((paper) => ({ paper_id: paper.paper_id, file_id: null })) };
      }
      case "screen":
        // 0.2.6 asks for the whole paper back; 0.2.7 for the verdict only.
        return system.includes('"full_text_available"') ? { ...(data.paper as JsonObject), ...verdict } : { paper_id: (data.paper as JsonObject).paper_id!, ...verdict };
      case "select":
        if ("included_papers" in data) return { paper_ids: (data.included_papers as JsonObject[]).slice(0, 3).map((paper) => paper.paper_id!) };
        return (data.screened_papers as JsonObject[]).filter((paper) => paper.screening_status === "include").slice(0, 3);
      case "extract": {
        const paper = data.paper as JsonObject;
        const record = data.record as JsonObject;
        const abstract = ((record.metadata as JsonObject).abstract ?? paper.abstract) as string;
        const quote = abstract.split(". ")[0]! + ".";
        return [{ evidence_id: `${paper.paper_id as string}:e1`, paper_id: paper.paper_id!, text: quote, quote, category: "method", scope: "abstract", support_strength: "direct_quote", location: { page: null, section: "abstract" }, extraction_worker: "scripted", provenance: { source: "crossref", locator: paper.doi!, source_sha256: "", synthetic: false } }];
      }
      case "synthesize": {
        const evidence = data.evidence_items as JsonObject[];
        return {
          themes: [{ theme_id: "theme-1", label: "Isolation", evidence_ids: evidence.map((item) => item.evidence_id!), method_comparison: "Each isolates untrusted text.", limitations: [], inference_level: "extractive_grouping" }],
          claims: evidence.map((item, index) => ({ claim_id: `claim-${index + 1}`, text: null, paper_ids: [item.paper_id!], evidence_ids: [item.evidence_id!], support_type: "direct_quote", strength: "descriptive", verification_status: "pending", theme_id: "theme-1" })),
        };
      }
      case "write":
        return { draft: { title: "Related Work", claim_ids: (data.claims as JsonObject[]).map((claim) => claim.claim_id!) }, claims: data.claims! };
      case "verify": {
        const claims = (data.claims as JsonObject[]).map((claim) => ({ ...claim, verification_status: "supported" }));
        const cited = [...new Set(claims.flatMap((claim) => claim.paper_ids as string[]))].sort();
        const evidence = new Map((data.evidence_items as JsonObject[]).map((item) => [item.evidence_id as string, item]));
        return {
          related_work: "## Isolation\n\nScripted defenses isolate untrusted text [1].\n",
          bibliography: cited.map((paper_id, index) => ({ reference: index + 1, paper_id })),
          evidence_table: claims.flatMap((claim) => (claim.evidence_ids as string[]).map((id) => evidence.get(id)!)),
          unresolved: data.unresolved!,
          verification_results: claims.map((claim) => ({ claim_id: claim.claim_id!, status: "supported", checks: ["evidence_match"], reason: "Direct quote.", semantic_judgment: "not_needed" })),
          claims,
        };
      }
      default:
        throw new Error(`unscripted task ${task}`);
    }
  }
}

// -- one run through this host's paths ---------------------------------------------------------------
interface Outcome {
  result: WorkflowResult | null;
  error: (Error & { code?: string; node_id?: string | null; execution_report?: Record<string, unknown> }) | null;
  audit: Array<Record<string, unknown>>;
  reviewer: Reviewer;
  seen: Array<{ kind: string; url: string }>;
}

async function review(pkg: Package, options: { fault?: Fault; network?: { search?: Script; resolver?: Script; lookup?: Script } } = {}): Promise<Outcome> {
  const reviewer = new Reviewer(options.fault);
  const { transport, seen } = scriptedNetwork({ search, resolver, lookup, ...options.network });
  const registry = await buildHostToolRegistry(pkg, { resourceTypes: [], runtimeVersion: "0.1.0", now: NOW });
  const decisions = { "network.scholarly": "session", "network.citations": "session", "model.reasoning": "session", "memory.session": "session", "files.pdfs": "deny" } as const;
  const evaluation = await evaluateRegistry(pkg, registry, { decisions: { ...decisions }, toolApprovals: { "citation-resolver": true, "scholarly-search": true }, now: NOW });
  // The paper reader is not approved (no documents): it stays unbound, as in the CLI.
  const records = normalizeToolBindings(planToolBindings(evaluation).filter((binding) => binding.approved));
  // Backoffs are recorded, not waited for; Crossref's one-second pacing is real.
  const { handlers } = toolHandlers(records, { definitions: definitionsFromRegistry(registry), transport, pacer: new Pacer(), sleep: async () => undefined });
  const grants = { "network.scholarly": "session", "network.citations": "session", "model.reasoning": "session", "memory.session": "session", "files.pdfs": "deny" } as const;
  const input = { question: QUESTION, seeds: [], documents: {}, mode: "live" };
  try {
    const result = await runWorkflow(pkg, input, { router: new BoundModelRouter(reviewer), handlers, grants: { ...grants }, approvedTools: ["citation-resolver", "scholarly-search"] });
    return { result, error: null, audit: result.audit as unknown as Array<Record<string, unknown>>, reviewer, seen };
  } catch (error) {
    const failure = error as Outcome["error"] & object;
    return { result: null, error: failure, audit: (failure.execution_report?.audit ?? []) as Array<Record<string, unknown>>, reviewer, seen };
  }
}

const v026 = () => loadPackageBytes(new Uint8Array(readFileSync(SHIPPED.literatureReview026.archive)));
const v027 = () => loadSource(sourceTree("literature-review"));
const actions = (outcome: Outcome, action: string) => outcome.audit.filter((event) => event.action === action);
const output = (outcome: Outcome) => outcome.result!.output as JsonObject;
const papersFound = (outcome: Outcome) => (output(outcome).papers_found as JsonObject[]).map((paper) => paper.paper_id);
const ALL_FOUND = [1, 2, 3, 4, 5].map(doi);

/** 0.2.7 completed, re-asked `task` once, and lists every found paper; the review is grounded. */
function recoveredByReask(outcome: Outcome, task: string, correction: RegExp) {
  expect(outcome.error).toBeNull();
  expect(outcome.result!.status).toBe("completed");
  const calls = outcome.reviewer.calls.filter((call) => call.task === task);
  expect(calls.map((call) => call.attempt)).toContain(2);
  expect(calls.find((call) => call.attempt === 2)!.correction).toMatch(correction);
  expect(papersFound(outcome).sort()).toEqual(ALL_FOUND);
  expect((output(outcome).claims as JsonObject[]).length).toBeGreaterThan(0);
}

describe("the clean review (T15)", () => {
  it("0.2.7 screens every found paper, cites three, and lists all five in papers-found", async () => {
    const outcome = await review(await v027());
    expect(outcome.error).toBeNull();
    expect(papersFound(outcome)).toEqual(ALL_FOUND);
    expect((output(outcome).bibliography as JsonObject[]).map((row) => row.paper_id)).toEqual(ALL_FOUND.slice(0, 3));
    // No documents were selected: normalize is not asked (D-170), and nobody re-asks anything.
    expect(outcome.reviewer.calls.map((call) => call.task)).not.toContain("normalize");
    expect(outcome.reviewer.calls.every((call) => call.attempt === 1)).toBe(true);
    // join-search removed the DOI the second query found again, before any model saw it.
    expect(actions(outcome, "node.deduplicated").map((event) => event.node_id)).toEqual(["join-search"]);
  }, 30_000);

  it("0.2.6 completes the same review (the baseline the faults below break)", async () => {
    const outcome = await review(await v026());
    expect(outcome.error).toBeNull();
    expect((outcome.result!.output as JsonObject).bibliography).toHaveLength(3);
  }, 30_000);
});

describe("model slips that stopped or emptied 0.2.6 (B-151)", () => {
  it("duplicate paper ids from normalize: 0.2.6 stops at check-screening-refs; 0.2.7 never asks normalize without documents", async () => {
    const duplicate: Fault = (task, _attempt, answer) => {
      if (task !== "normalize") return undefined;
      const value = answer as JsonObject;
      if (Array.isArray(value.candidate_papers)) {
        (value.candidate_papers as JsonObject[])[1]!.paper_id = (value.candidate_papers as JsonObject[])[0]!.paper_id!;
        (value.screening_refs as JsonObject[])[1]!.paper_id = (value.screening_refs as JsonObject[])[0]!.paper_id!;
      } else (value.candidates as JsonObject[])[1]!.paper_id = (value.candidates as JsonObject[])[0]!.paper_id!;
      return value;
    };
    const before = await review(await v026(), { fault: duplicate });
    expect([before.error?.code, before.error?.node_id]).toEqual(["schema_validation", "check-screening-refs"]);
    const after = await review(await v027(), { fault: duplicate });
    expect(after.result!.status).toBe("completed");
    expect(papersFound(after)).toEqual(ALL_FOUND);
  }, 30_000);

  it("a missing reference: 0.2.6 stops at screening-jobs (lookup no_match); 0.2.7 completes", async () => {
    const missing: Fault = (task, _attempt, answer) => {
      if (task !== "normalize") return undefined;
      const value = answer as JsonObject;
      if (Array.isArray(value.screening_refs)) value.screening_refs = (value.screening_refs as JsonObject[]).slice(1);
      else value.candidates = (value.candidates as JsonObject[]).slice(1);
      return value;
    };
    const before = await review(await v026(), { fault: missing });
    expect([before.error?.code, before.error?.node_id]).toEqual(["schema_validation", "screening-jobs"]);
    const after = await review(await v027(), { fault: missing });
    expect(after.result!.status).toBe("completed");
    expect(papersFound(after)).toEqual(ALL_FOUND);
  }, 30_000);

  it("an empty normalize answer: 0.2.6 completes with nothing screened and nothing cited; 0.2.7 screens all five", async () => {
    const empty: Fault = (task, _attempt, answer) => (task !== "normalize" ? undefined : Array.isArray((answer as JsonObject).candidate_papers) ? { candidate_papers: [], screening_refs: [] } : { candidates: [] });
    // 0.2.6 then asks select to choose from nothing, which a careful model answers with nothing.
    const before = await review(await v026(), { fault: empty });
    expect(before.result!.status).toBe("completed");
    expect((before.result!.output as JsonObject).bibliography).toEqual([]);
    expect(before.reviewer.calls.filter((call) => call.task === "screen")).toHaveLength(0);
    const after = await review(await v027(), { fault: empty });
    expect(after.result!.status).toBe("completed");
    expect(papersFound(after)).toEqual(ALL_FOUND);
    expect((output(after).bibliography as JsonObject[]).length).toBe(3);
  }, 30_000);

  it("an invented paper in select: 0.2.6 sends it to the resolver; 0.2.7 refuses it by name and is re-asked", async () => {
    const invent: Fault = (task, attempt, answer) => {
      if (task !== "select" || attempt > 1) return undefined;
      if (Array.isArray(answer)) return [{ ...(answer as JsonObject[])[0]!, paper_id: "paper-123", doi: "10.1234/5678", title: "Stock prices with neural networks" }];
      return { paper_ids: ["paper-123"] };
    };
    const unknownResolver: Script = (request) => (resolverQuery(request) === "10.1234/5678" ? json(200, { status: "not_found", query: "10.1234/5678", detected_type: "doi", best_match: null, match_score: null, alternatives: [], sources: [{ provider: "crossref", status: "not_found", error_code: null }], warnings: [], message: "No record." }) : resolver(request, 0));
    const before = await review(await v026(), { fault: invent, network: { resolver: unknownResolver } });
    // 0.2.6 completes on the invention: the resolver cannot find it, so nothing is grounded.
    expect(before.result!.status).toBe("completed");
    expect((before.result!.output as JsonObject).bibliography).toEqual([]);
    expect(before.seen.filter((call) => call.kind === "resolver")).toHaveLength(1);
    const after = await review(await v027(), { fault: invent, network: { resolver: unknownResolver } });
    recoveredByReask(after, "select", /answer check 0 \(relation\) failed: missing_target_key at \/paper_ids for "paper-123"\./u);
    // The invented id never reached a tool.
    expect(after.seen.filter((call) => call.kind === "resolver").map((call) => call.url)).toHaveLength(3);
  }, 30_000);

  it("a paraphrased quote: 0.2.6 stops at the evidence check; 0.2.7 names the check and is re-asked", async () => {
    const paraphrase: Fault = (task, attempt, answer) => {
      if (task !== "extract" || attempt > 1) return undefined;
      const items = answer as JsonObject[];
      items[0]!.quote = "Scripted defenses keep untrusted text away from the model.";
      return items;
    };
    const before = await review(await v026(), { fault: paraphrase });
    expect([before.error?.code, before.error?.node_id]).toEqual(["schema_validation", "evidence"]);
    const after = await review(await v027(), { fault: paraphrase });
    recoveredByReask(after, "extract", /answer check 2 \(relation\) failed: fields_do_not_match/u);
    expect(actions(after, "model.called").filter((event) => event.attempt === 2)).toHaveLength(3);
  }, 30_000);

  it("a screening verdict for another paper: 0.2.7 refuses it and is re-asked", async () => {
    const other: Fault = (task, attempt, answer) => (task === "screen" && attempt === 1 && (answer as JsonObject).paper_id === doi(2) ? { ...(answer as JsonObject), paper_id: doi(3) } : undefined);
    const after = await review(await v027(), { fault: other });
    recoveredByReask(after, "screen", /answer check 0 \(equal\) failed: values_differ\./u);
  }, 30_000);

  it("a slip that persists still fails, honestly: three refused answers, the named check, no invented paper", async () => {
    const invent: Fault = (task) => (task === "select" ? { paper_ids: ["paper-123"] } : undefined);
    const after = await review(await v027(), { fault: invent });
    expect([after.error?.code, after.error?.node_id]).toEqual(["model_error", "select-included"]);
    expect(after.reviewer.calls.filter((call) => call.task === "select").map((call) => call.attempt)).toEqual([1, 2, 3]);
    const failed = actions(after, "node.failed").find((event) => event.node_id === "select-included")!;
    expect(failed.failed_check).toMatchObject({ check: "answer_check", index: 0, kind: "relation", failure: "missing_target_key" });
    expect(after.seen.filter((call) => call.kind === "resolver")).toHaveLength(0);
  }, 30_000);
});

describe("service failures (D-152, D-153)", () => {
  const unavailable: Script = () => text(503, "Service Unavailable");

  it("the Citation Resolver unavailable: 0.2.6 stops (no fallback declared); 0.2.7 is answered by Crossref's DOI lookup", async () => {
    const before = await review(await v026(), { network: { resolver: unavailable } });
    expect([before.error?.code, before.error?.node_id]).toEqual(["tool_error", "citations"]);
    expect(actions(before, "tool.fallback")).toHaveLength(0);
    const after = await review(await v027(), { network: { resolver: unavailable } });
    expect(after.result!.status).toBe("completed");
    expect(actions(after, "tool.fallback")).toHaveLength(3);
    expect(papersFound(after)).toEqual(ALL_FOUND);
    expect((output(after).bibliography as JsonObject[]).length).toBe(3);
    expect(after.seen.filter((call) => call.kind === "lookup")).toHaveLength(3);
  }, 60_000);

  it("Crossref answering 429 during that lookup: 0.2.6 stops; 0.2.7's lookup is retried and answers", async () => {
    const busyOnce: Script = (request, index) => (index === 0 ? text(429, "", { "retry-after": "1" }) : lookup(request, index));
    const before = await review(await v026(), { network: { resolver: unavailable, lookup: busyOnce } });
    expect(before.error?.code).toBe("tool_error");
    const after = await review(await v027(), { network: { resolver: unavailable, lookup: busyOnce } });
    expect(after.result!.status).toBe("completed");
    expect(actions(after, "tool.retried").some((event) => event.http_status === 429)).toBe(true);
    expect((output(after).bibliography as JsonObject[]).length).toBe(3);
  }, 60_000);

  it("a Crossref search 429 is retried by the host for both versions (host behaviour, not the package's)", async () => {
    const busyOnce: Script = (request, index) => (index === 0 ? text(429, "", { "retry-after": "1" }) : search(request, index));
    for (const pkg of [await v026(), await v027()]) {
      const outcome = await review(pkg, { network: { search: busyOnce } });
      expect(outcome.result!.status).toBe("completed");
      expect(actions(outcome, "tool.retried")).toHaveLength(1);
    }
  }, 60_000);
});
