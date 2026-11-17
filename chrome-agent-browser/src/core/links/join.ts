/**
 * The join (link.v0 §6): a declared slot bound during the run to a package the runtime found,
 * verified and put before the person (`agentpkg/links/join.py`, line for line).
 *
 * What is here is host-neutral and decides nothing: where a slot may look (`locateUrls`), how it
 * looks (`findCandidate`, over the host's discovery and package fetch, each under its policy
 * unchanged), what refuses a candidate before any card (`refusalBeforeCard`), and the facts of the
 * card (`cardFacts`). The mediator (`Runtime.callJoin`) orders them, holds the reservation, asks
 * the person and records every step. A host supplies a `JoinHost`: its discovery and fetch, its
 * own trust evaluation, and what an accepted package's inner run is handed. Nothing here touches
 * the network: a host's `look` and `fetch` do, through the transport it already has.
 *
 * Nothing here is package-specific: the slot, its view and its ceiling come from the caller's
 * signed declaration, the candidate's facts from its own verified bytes.
 */
import { MAX_ARCHIVE_BYTES } from "../archive.js";
import { DEFAULT_LIMITS, discoverFromPage, mediaType, type DiscoveryResult } from "../discovery.js";
import { CoreError, ValidationError } from "../errors.js";
import { base64Decode } from "../keys.js";
import type { JsonObject, JsonValue } from "../json.js";
import type { ModelRouter } from "../models/contract.js";
import type { Package } from "../package.js";
import { validatePackageUrl } from "../policy.js";
import { deepCopy, select } from "../references.js";
import type { ToolHandler } from "../tools/handler.js";
import { codepoint, packageWorstCase, WORST_CASE_FIGURES, worstCaseFigures, type PackageWorstCase, type WorstCaseFigures } from "./analysis.js";
import { MAX_LOCATE_REFERENCES, MAX_REASON_CHARS } from "./declarations.js";
import { LinkRefusal } from "./errors.js";
import { checkModel, checkProfile, verifyLinked, type ResolvedLink, type TrustOf } from "./resolve.js";
import type { RunConsentHost, RunRequest } from "../conversation/host.js";

export type { RunConsentHost, RunRequest } from "../conversation/host.js";

/** A run shows at most this many join cards in all (L-39). */
export const MAX_RUN_CARDS = 2;
/** Why a slot step did not join (L-33, L-35, L-38): data to the caller's program. */
export const REASONS = ["unattended", "policy", "join_cap", "not_found", "verification", "conversational", "nested", "publisher_denied", "model_incompatible", "over_ceiling", "budget", "declined", "failed"] as const;
export const JOIN_FIXTURE_SCHEMA = "agentpkg-join-fixture-v0";

/** What an accepted joined package's inner run is handed by the host: its router (null: the caller's route) and its tool handlers. */
export interface JoinAdapters {
  router: ModelRouter | null;
  handlers: Record<string, ToolHandler>;
}

/**
 * What a host gives a run so that its slots can look and join. `look(url)` is website discovery of
 * one page; `download(url)` returns a candidate's bytes under the package-URL policy; both throw an
 * error that carries a `code`. `trust(signer, package)` is the person's own evaluation of a
 * publisher key; `adapters(package)` returns what an accepted package's inner run is handed.
 * `policy` is `forbid` where the host's signed policy forbids joins.
 */
export interface JoinHost {
  look(url: string): Promise<Pick<DiscoveryResult, "candidates">>;
  download(url: string): Promise<Uint8Array>;
  trust: TrustOf;
  adapters?: ((pkg: Package, decision: { grants: Readonly<Record<string, string>>; approvedTools: readonly string[] }) => JoinAdapters | Promise<JoinAdapters>) | null;
  policy?: "allow" | "forbid";
}

/** What a slot found by looking: every fetch it made, in order, and the candidate's bytes when a page advertised a package that could be fetched. */
export interface Found {
  fetches: JsonObject[];
  page_url: string | null;
  package_url: string | null;
  data: Uint8Array | null;
  /** `not_found` (no page advertised a package) or `verification` (its fetch failed). */
  reason: "not_found" | "verification" | null;
}

/**
 * The URLs a slot looks at, in order (L-7): each reference of `locate` read from the run's input or
 * an earlier tool step's result; a reference that selects nothing, or null, yields no URL; a
 * `coalesce` yields its first member that yields any. At most three.
 */
export function locateUrls(locate: JsonValue, environment: Readonly<Record<string, JsonValue | undefined>>): string[] {
  const read = (expression: JsonObject): string[] => {
    if ("from" in expression) {
      const source = environment[String(expression.from)];
      if (source === undefined) return [];
      let value: JsonValue;
      try {
        value = select(source, String(expression.path));
      } catch (error) {
        if (error instanceof ValidationError) return [];
        throw error;
      }
      return typeof value === "string" && value.length > 0 ? [value] : [];
    }
    if ("coalesce" in expression) {
      for (const member of expression.coalesce as JsonObject[]) {
        const found = read(member);
        if (found.length > 0) return found;
      }
      return [];
    }
    return (expression.array as JsonObject[]).flatMap((member) => read(member));
  };
  const urls: string[] = [];
  for (const url of read(locate as JsonObject)) if (!urls.includes(url)) urls.push(url);
  return urls.slice(0, MAX_LOCATE_REFERENCES);
}

const codeOf = (error: unknown): string => {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && code.length > 0 ? code : "failed";
};

/** Errors a host's look or fetch reports with a code; anything else is the host's fault and surfaces. */
const coded = (error: unknown): boolean => error instanceof CoreError || error instanceof LinkRefusal || (error instanceof Error && typeof (error as { code?: unknown }).code === "string");

/**
 * L-31, L-32: each URL looked at in order by discovery; the first page that advertises a package
 * gives the one candidate, whose bytes are fetched; a page that advertises none, or cannot be read,
 * moves to the next URL. Every fetch is listed, read or refused.
 */
export async function findCandidate(host: JoinHost, urls: readonly string[]): Promise<Found> {
  const found: Found = { fetches: [], page_url: null, package_url: null, data: null, reason: null };
  for (const url of urls) {
    let page: Pick<DiscoveryResult, "candidates">;
    try {
      page = await host.look(url);
    } catch (error) {
      if (!coded(error)) throw error;
      found.fetches.push({ url, kind: "discovery", status: codeOf(error) });
      continue;
    }
    const accepted = page.candidates.filter((candidate) => candidate.accepted);
    found.fetches.push({ url, kind: "discovery", status: accepted.length > 0 ? "ok" : "no_candidate" });
    if (accepted.length === 0) continue;
    found.page_url = url;
    found.package_url = accepted[0]!.resolved_url;
    let status = "ok";
    try {
      found.data = await host.download(found.package_url!);
    } catch (error) {
      if (!coded(error)) throw error;
      status = codeOf(error);
      found.reason = "verification";
    }
    found.fetches.push({ url: found.package_url, kind: "package", status });
    return found;
  }
  found.reason = "not_found";
  return found;
}

/** A slot's ceiling in the six figures of a worst case (L-6): a figure left out is zero, `tool_calls` is a total, and the step's time is its seconds. */
export function ceiling(step: JsonObject): { model_calls: number; tool_calls: number; compute_calls: number; remote_calls: number; tokens: number; seconds: number } {
  const declared = step.budget as JsonObject;
  const figure = (name: string): number => (typeof declared[name] === "number" ? (declared[name] as number) : 0);
  return {
    model_calls: figure("model_calls"),
    tool_calls: figure("tool_calls"),
    compute_calls: figure("compute_calls"),
    remote_calls: figure("remote_calls"),
    tokens: figure("tokens"),
    seconds: step.timeout_seconds as number,
  };
}

/** The first figure of a candidate's own worst case that passes the slot's ceiling. */
export function overCeiling(worst: WorstCaseFigures, step: JsonObject): string | null {
  const limit = ceiling(step);
  for (const figure of WORST_CASE_FIGURES) {
    const value = figure === "tool_calls" ? Object.values(worst.tool_calls).reduce((sum, count) => sum + count, 0) : (worst[figure] as number);
    if (value > limit[figure]) return figure;
  }
  return null;
}

/**
 * L-10 for a candidate: its bytes verified as any package's, with a valid signature, and described
 * as a resolved link is. Throws the `LinkRefusal` of `resolve`. The profile is read before the
 * worst case: W(p) is defined for a one-shot workflow.v0 package one level deep (L-18), and only
 * such a declaration is analysed. A candidate the profile refuses has no worst case.
 */
export async function verifyCandidate(found: Found, slot: string, host: JoinHost): Promise<ResolvedLink> {
  const label = `slot '${slot}'`;
  const { package: pkg, archive_sha256, signer } = await verifyLinked(found.data!, label);
  const manifest = pkg.manifest;
  let worst: PackageWorstCase | null;
  try {
    checkProfile(pkg, label);
    worst = packageWorstCase(pkg.graph, pkg.policy);
  } catch (error) {
    if (!(error instanceof LinkRefusal)) throw error;
    worst = null;
  }
  return {
    dependency: slot,
    record: { id: slot, package_id: manifest.package_id!, version: manifest.version!, digest: pkg.digest, locator: found.package_url },
    package: pkg,
    archive_sha256,
    signer,
    trust: await host.trust(signer, pkg),
    worst_case: worst,
    bytes: found.data!,
  };
}

/**
 * L-33: why a verified candidate is refused without a card, as `[reason, figure]`, or null. In this
 * order: the profile (a conversation; depth one; the caller itself), a key the person denied in
 * this run, the model route, the slot's ceiling.
 */
export function refusalBeforeCard(link: ResolvedLink, step: JsonObject, options: { caller: Package; deniedKeys: ReadonlySet<string>; router: ModelRouter | null }): [reason: string, figure: string | null] | null {
  const label = `slot '${String(step.slot)}'`;
  if (link.package.manifest.package_id === options.caller.manifest.package_id) return ["nested", null];
  try {
    checkProfile(link.package, label);
  } catch (error) {
    if (!(error instanceof LinkRefusal)) throw error;
    return [error.code === "link_target_conversational" ? "conversational" : "nested", null];
  }
  if (options.deniedKeys.has(link.signer)) return ["publisher_denied", null];
  try {
    checkModel(link, options.router);
  } catch (error) {
    if (!(error instanceof LinkRefusal)) throw error;
    return ["model_incompatible", null];
  }
  const figure = overCeiling(link.worst_case!, step);
  if (figure !== null) return ["over_ceiling", figure];
  return null;
}

export function candidateFacts(link: ResolvedLink): JsonObject {
  return { package_id: link.package.manifest.package_id!, version: link.package.manifest.version!, digest: link.package.digest, signer: link.signer };
}

/**
 * L-34: the join card, every member computed by the runtime from verified bytes and the caller's
 * signed declaration. Two members carry words: `package.name` and `package.description` are the
 * publisher's, `reason` is the agent's.
 */
export function cardFacts(link: ResolvedLink, step: JsonObject, found: Found, options: { reason: string | null; left: { tokens: number; remote_calls: number }; cards: JsonObject }): JsonObject {
  const pkg = link.package;
  const manifest = pkg.manifest;
  const policy = pkg.policy;
  const pick = (record: JsonObject, keys: readonly string[]): JsonObject => Object.fromEntries(keys.map((key) => [key, deepCopy(record[key] ?? null)]));
  const requirements = manifest.model_requirements as JsonObject;
  return {
    slot: String(step.slot),
    publisher: { signer: link.signer, trust: link.trust },
    package: {
      package_id: manifest.package_id!,
      version: manifest.version!,
      digest: pkg.digest,
      archive_sha256: link.archive_sha256,
      name: manifest.name!,
      description: manifest.description!,
    },
    source: { page_url: found.page_url, package_url: found.package_url },
    requirements: {
      permissions: (policy.permissions as JsonObject[]).map((permission) => pick(permission, ["id", "kind", "description", "required", "resources"])),
      tools: Object.keys(pkg.tools)
        .sort(codepoint)
        .map((toolId) => {
          const tool = pkg.tools[toolId]!;
          return {
            id: toolId,
            execution: tool.execution!,
            endpoint: tool.endpoint ?? null,
            method: tool.method ?? null,
            domains: [...((tool.domains as JsonValue[] | undefined) ?? [])],
            permissions: [...(tool.permissions as JsonValue[])],
            side_effects: tool.side_effects!,
          };
        }),
      allowed_domains: [...((policy.network as JsonObject).allowed_domains as JsonValue[])],
      model: {
        tasks: (requirements.tasks as JsonObject[]).map((task) => pick(task, ["id", "capabilities", "context_window"])),
        privacy: requirements.privacy ?? null,
      },
    },
    // What the request to this package may draw from: the fields of the slot's `input`, which
    // validation requires to be an `object` constructor (`link_slot_input`), so that these names
    // are the whole of it.
    view: Object.keys((step.input as JsonObject).object as JsonObject).sort(codepoint),
    worst_case: worstCaseFigures(link.worst_case!),
    ceiling: ceiling(step),
    // The "at most" the person accepted before the run holds this join at its ceiling.
    at_most_unchanged: true,
    left: { ...options.left },
    reason: options.reason,
    cards: deepCopy(options.cards),
  };
}

/** A slot's stated reason as the card shows it: a string of at most 500 characters, else nothing (the agent's words are never a failure of the step). */
export function slotReason(value: JsonValue | undefined): string | null {
  if (typeof value !== "string" || value.trim().length === 0) return null;
  // Python slices by code point; a JavaScript string slices by UTF-16 unit.
  return [...value].slice(0, MAX_REASON_CHARS).join("");
}

// -- a recorded web: fixture mode's discovery and fetch (L-29) ----------------------------------

/** One recorded page: its body and, optionally, its status and content type. */
export interface RecordedPage {
  body: Uint8Array;
  status?: number;
  content_type?: string;
}

/**
 * Pages and package archives recorded by URL, replayed through the production discovery and
 * package-URL code: the URL, status, content, size and same-origin rules run unchanged over the
 * recorded bytes, and nothing touches the network. A URL that was not recorded answers 404 (a page)
 * or fails (a package).
 */
export class RecordedWeb {
  readonly requests: JsonObject[] = [];

  constructor(
    readonly pages: ReadonlyMap<string, RecordedPage>,
    readonly packages: ReadonlyMap<string, Uint8Array>,
  ) {}

  async look(url: string): Promise<DiscoveryResult> {
    this.requests.push({ url, kind: "discovery" });
    const hash = url.indexOf("#");
    const address = hash >= 0 ? url.slice(0, hash) : url;
    validatePackageUrl(address, "Website");
    const page = this.pages.get(address);
    const status = page === undefined ? 404 : (page.status ?? 200);
    if (status !== 200) {
      if (status >= 300 && status < 400) throw new CoreError("discovery_redirect_refused", "The website answered with a redirect, which discovery does not follow", { status: 502 });
      throw new CoreError("discovery_http_status", `The website answered HTTP ${status} instead of a page`, { status: 502, details: { status } });
    }
    const contentType = page!.content_type ?? "text/html; charset=utf-8";
    const [, parameters] = mediaType(contentType);
    const truncated = page!.body.length > DEFAULT_LIMITS.maxHtmlBytes;
    return discoverFromPage({
      requested_url: url,
      final_url: address,
      redirects: [],
      content_type: contentType,
      charset: parameters.charset ?? null,
      content_coding: "identity",
      body: truncated ? page!.body.slice(0, DEFAULT_LIMITS.maxHtmlBytes) : page!.body,
      truncated,
    });
  }

  async download(url: string): Promise<Uint8Array> {
    this.requests.push({ url, kind: "package" });
    validatePackageUrl(url);
    const data = this.packages.get(url);
    if (data === undefined) throw new CoreError("download_failed", "The recorded web holds no such package", { status: 502 });
    if (data.length > MAX_ARCHIVE_BYTES) throw new CoreError("download_too_large", "Package exceeds the download limit", { status: 413 });
    return data;
  }
}

/**
 * A run's cards answered from a recorded list of decisions (`provenance: fixture`): a join by the
 * slot that asks, in order; the raise by its one decision. A card the recording does not decide is
 * declined: the absence of a yes is a no.
 */
export class FixtureConsent implements RunConsentHost {
  readonly asked: RunRequest[] = [];
  private readonly joins: Map<string, JsonObject[]>;

  constructor(
    joins: Readonly<Record<string, JsonValue>> | null = null,
    private readonly raise: JsonObject | null = null,
  ) {
    this.joins = new Map(Object.entries(joins ?? {}).map(([slot, decisions]) => [slot, [...(decisions as JsonObject[])]]));
  }

  async ask(request: RunRequest): Promise<unknown> {
    await Promise.resolve();
    this.asked.push(request);
    if (request.kind === "budget.raise") return { accepted: Boolean(this.raise?.accepted), provenance: "fixture" };
    const queue = this.joins.get(String(request.facts.slot)) ?? [];
    const decision = queue.shift() ?? {};
    if (!decision.accepted) return { accepted: false, provenance: "fixture" };
    return { accepted: true, provenance: "fixture", grants: { ...((decision.grants as JsonObject | undefined) ?? {}) }, approved_tools: [...((decision.approved_tools as JsonValue[] | undefined) ?? [])] };
  }
}

/**
 * A join fixture (`run --join-fixture`): the recorded web (`pages` by URL with their `body` as text
 * or `body_base64`; `packages` by URL as an archive the caller reads beside the fixture) and the
 * person's recorded decisions (`decisions.joins` by slot, `decisions.raise`). Either half may be
 * absent. Without `pages` and `packages` no web is returned: a fixture run then looks at an empty
 * recorded web, and only a live run looks at the real one. Without `decisions` nobody is there to
 * ask. `readArchive(path)` reads a package archive named relative to the fixture.
 */
export async function loadJoinFixture(recording: JsonValue, readArchive: (path: string) => Promise<Uint8Array>): Promise<{ web: RecordedWeb | null; consent: FixtureConsent | null }> {
  if (recording === null || typeof recording !== "object" || Array.isArray(recording) || recording.schema !== JOIN_FIXTURE_SCHEMA) {
    throw new ValidationError(`a join fixture declares schema '${JOIN_FIXTURE_SCHEMA}'`);
  }
  const unknown = Object.keys(recording).filter((key) => !["schema", "pages", "packages", "decisions"].includes(key)).sort(codepoint);
  if (unknown.length > 0) throw new ValidationError(`join fixture: unknown member '${unknown[0]!}'`);
  let web: RecordedWeb | null = null;
  if ("pages" in recording || "packages" in recording) {
    const pages = new Map<string, RecordedPage>();
    for (const [url, raw] of Object.entries((recording.pages as JsonObject | undefined) ?? {})) {
      const page = raw as JsonObject;
      const body = "body_base64" in page ? base64Decode(String(page.body_base64)) : new TextEncoder().encode(String(page.body));
      pages.set(url, { body, ...(typeof page.status === "number" ? { status: page.status } : {}), ...(typeof page.content_type === "string" ? { content_type: page.content_type } : {}) });
    }
    const packages = new Map<string, Uint8Array>();
    for (const [url, path] of Object.entries((recording.packages as JsonObject | undefined) ?? {})) packages.set(url, await readArchive(String(path)));
    web = new RecordedWeb(pages, packages);
  }
  let consent: FixtureConsent | null = null;
  if ("decisions" in recording) {
    const decisions = recording.decisions as JsonObject;
    consent = new FixtureConsent((decisions.joins as JsonObject | undefined) ?? null, (decisions.raise as JsonObject | undefined) ?? null);
  }
  return { web, consent };
}
