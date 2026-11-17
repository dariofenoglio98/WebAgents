/**
 * `run`'s links (link.v0 §3, §6, §7 with the operator as the person): the flags of `agentpkg run`
 * (`--link`, `--link-grants`, `--deny-link`, `--approve-tool <id>:<tool>`, a repeatable
 * `--trust-key`, `--join-fixture`) read into the core's operator host (`core/links/operator.ts`),
 * and the transport a dependency's or a join candidate's fetch and a slot's look use.
 *
 * Every byte that leaves goes through `cli-net.ts` (D-067), the package-URL and discovery rules
 * unchanged: HTTPS, a public address, a pinned connection, no redirect, a byte cap, no body, no
 * cookie, no referrer. Fixture mode dials nothing: a slot looks at the join fixture's recorded web,
 * or at an empty one (L-29).
 */
import { readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";

import type { ParsedArguments } from "./cli-arguments.js";
import { nodeTransport } from "./cli-net.js";
import { MAX_ARCHIVE_BYTES } from "./core/archive.js";
import type { ComputeEngine } from "./core/compute/engine.js";
import { DEFAULT_LIMITS, discoverFromPage, mediaType, type DiscoveryResult } from "./core/discovery.js";
import { AgentPkgError, CoreError } from "./core/errors.js";
import { fixtureAdapters } from "./core/fixtures.js";
import type { JsonObject, JsonValue } from "./core/json.js";
import { fingerprint, publicKeyFromPem } from "./core/keys.js";
import { LinkRefusal } from "./core/links/errors.js";
import { planHash, type LinkHost } from "./core/links/host.js";
import { loadJoinFixture, RecordedWeb, type JoinHost } from "./core/links/join.js";
import { operatorLinks, operatorPlan, splitToolApprovals, type LinkAdapters, type OperatorDecision } from "./core/links/operator.js";
import type { ModelRouter } from "./core/models/contract.js";
import { TransportError, type HttpTransport } from "./core/models/transport.js";
import type { Package } from "./core/package.js";
import { validatePackageUrl } from "./core/policy.js";
import { pyRepr } from "./core/repr.js";
import type { RunConsentHost } from "./core/conversation/host.js";
import { Workflow, type WorkflowOptions } from "./core/workflow/interpreter.js";

/** Seconds a dependency's or a candidate's download, and a slot's look at one page, may take. */
const FETCH_TIMEOUT_MS = 60_000;

/** Repeatable `ID=VALUE` arguments as a map; an id named twice is refused (`cli.py::_pairs`). */
export function pairs(values: readonly string[], flag: string): Map<string, string> {
  const found = new Map<string, string>();
  for (const value of values) {
    const at = value.indexOf("=");
    const name = at >= 0 ? value.slice(0, at) : "";
    const rest = at >= 0 ? value.slice(at + 1) : "";
    if (at < 0 || !name || !rest) throw new AgentPkgError(`${flag} takes ID=VALUE, got ${pyRepr(value)}`);
    if (found.has(name)) throw new AgentPkgError(`${flag} names ${pyRepr(name)} twice`);
    found.set(name, rest);
  }
  return found;
}

/** A regular file's bytes under a cap (`package.read_regular_bytes`). */
function readArchive(path: string): Uint8Array {
  let size: number;
  try {
    const stat = statSync(path);
    if (!stat.isFile()) throw new AgentPkgError(`${path} is not a regular file`);
    size = stat.size;
  } catch (error) {
    if (error instanceof AgentPkgError) throw error;
    throw new AgentPkgError(`cannot read ${path}: ${(error as NodeJS.ErrnoException).code ?? "error"}`);
  }
  if (size > MAX_ARCHIVE_BYTES) throw new AgentPkgError(`${path} exceeds the ${MAX_ARCHIVE_BYTES}-byte archive limit`);
  return new Uint8Array(readFileSync(path));
}

function transportCode(error: unknown, operation: "download" | "discovery"): string {
  if (error instanceof TransportError && error.facts.stage === "body_size") return operation === "download" ? "download_too_large" : "discovery_too_large";
  if (error instanceof Error && error.name === "TimeoutError") return `${operation}_timeout`;
  return `${operation}_failed`;
}

/** A package's bytes at a URL under the package-URL policy, over the Node transport: no redirect, a byte cap, nothing sent but the request line. */
export async function fetchPackageBytes(url: string, transport: HttpTransport = nodeTransport({ allowLoopbackHttp: false })): Promise<Uint8Array> {
  validatePackageUrl(url);
  let response;
  try {
    response = await transport({ url, method: "GET", headers: { accept: "application/octet-stream" }, body: null, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), maxResponseBytes: MAX_ARCHIVE_BYTES });
  } catch (error) {
    if (error instanceof CoreError) throw error;
    throw new CoreError(transportCode(error, "download"), `Cannot download the package: ${error instanceof Error ? error.name : "error"}`, { status: 502 });
  }
  if (response.status >= 300 && response.status < 400) throw new CoreError("download_redirect_denied", "Package host returned a redirect; redirects are disabled", { status: 502 });
  if (response.status !== 200) throw new CoreError("download_failed", `Package host returned HTTP ${response.status}`, { status: 502 });
  return response.bytes ?? new TextEncoder().encode(response.body);
}

/** Website discovery of one page over the Node transport (`browser/discovery.py`'s rules: one page, a byte cap, no script, no redirect followed). */
export async function lookAtPage(url: string, transport: HttpTransport = nodeTransport({ allowLoopbackHttp: false })): Promise<DiscoveryResult> {
  const hash = url.indexOf("#");
  const document = hash >= 0 ? url.slice(0, hash) : url;
  validatePackageUrl(document, "Website");
  let response;
  try {
    response = await transport({ url: document, method: "GET", headers: { accept: "text/html, application/xhtml+xml" }, body: null, signal: AbortSignal.timeout(DEFAULT_LIMITS.timeoutSeconds * 1000), maxResponseBytes: DEFAULT_LIMITS.maxHtmlBytes });
  } catch (error) {
    if (error instanceof CoreError) throw error;
    throw new CoreError(transportCode(error, "discovery"), `Cannot read the website: ${error instanceof Error ? error.name : "error"}`, { status: 502 });
  }
  if (response.status >= 300 && response.status < 400) throw new CoreError("discovery_redirect_refused", "The website answered with a redirect, which discovery does not follow", { status: 502 });
  if (response.status !== 200) throw new CoreError("discovery_http_status", `The website answered HTTP ${response.status} instead of a page`, { status: 502, details: { status: response.status } });
  const contentType = response.headers["content-type"] ?? "";
  const [, parameters] = mediaType(contentType);
  return discoverFromPage({ requested_url: url, final_url: document, redirects: [], content_type: contentType, charset: parameters.charset ?? null, content_coding: "identity", body: response.bytes ?? new TextEncoder().encode(response.body), truncated: false });
}

/** What `run` hands the execution session for a package with links: the links, the person's recorded surface and the plan a decision names. */
export interface CliLinks {
  /** The caller's own approved tools (`--approve-tool` without a dependency prefix). */
  approved: string[];
  links: LinkHost | null;
  consent: RunConsentHost | null;
  planHash: string | null;
  /** The recorded web a fixture run's slots looked at, for a driver that lists what was looked at. */
  web: RecordedWeb | null;
}

/**
 * `agentpkg run`'s link options, in its order: the approvals split by owner, the decisions on the
 * linked publishers' cards, the trusted keys, the join fixture and the operator plan, then the
 * dependencies resolved and bound (`operator_links`). `adapters` gives an accepted linked package's
 * inner runs their router and handlers: its own fixture in fixture mode, the host's bindings live.
 */
export async function cliLinks(
  pkg: Package,
  parsed: ParsedArguments,
  options: { mode: "fixture" | "live"; grants: Record<string, string>; limits: JsonObject | null; router: ModelRouter | null; compute: ComputeEngine | null; liveAdapters?: LinkAdapters | null; checkOwnApprovals: (approved: string[]) => void; jsonFile: (path: string) => JsonValue; transport?: HttpTransport },
): Promise<CliLinks> {
  // Every byte a link fetches or a slot looks at leaves through this transport (D-067); a test hands its own.
  const transport = options.transport ?? nodeTransport({ allowLoopbackHttp: false });
  const { own, linked } = splitToolApprovals(pkg, [...new Set(parsed.list("--approve-tool"))]);
  options.checkOwnApprovals(own);
  const decisions: Record<string, OperatorDecision> = {};
  for (const [name, path] of pairs(parsed.list("--link-grants"), "--link-grants")) {
    decisions[name] = { decision: "accepted", grants: options.jsonFile(path) as Record<string, string>, approved_tools: linked[name] ?? [] };
  }
  for (const name of parsed.list("--deny-link")) {
    if (Object.hasOwn(decisions, name)) throw new AgentPkgError(`--deny-link and --link-grants both name ${pyRepr(name)}`);
    decisions[name] = { decision: "denied" };
  }
  const adapters: LinkAdapters = (linkedPackage) => {
    if (options.mode === "fixture") {
      const fixture = fixtureAdapters(linkedPackage);
      return { router: fixture.router, handlers: fixture.handlers };
    }
    if (!options.liveAdapters) throw new AgentPkgError("this host binds no tools for a linked package");
    return options.liveAdapters(linkedPackage);
  };
  const trusted = new Set<string>();
  for (const path of parsed.list("--trust-key")) trusted.add(await fingerprint(publicKeyFromPem(readFileSync(path, "utf8"))));
  const trust = (signer: string): string => (trusted.has(signer) ? "trusted" : "unknown");
  let joins: JoinHost | null = null;
  let consent: RunConsentHost | null = null;
  let callerPlan: JsonObject | null = null;
  let web: RecordedWeb | null = null;
  const fixturePath = parsed.value("--join-fixture");
  if (fixturePath !== null) {
    // link.v0 §6, §7: the person's cards answered from a recording, and what a slot may look at:
    // the recorded web, or, in live mode only, the real one under the same policies.
    const directory = dirname(resolve(fixturePath));
    const loaded = await loadJoinFixture(options.jsonFile(fixturePath), async (path) => readArchive(resolve(directory, path)));
    web = loaded.web;
    consent = loaded.consent;
    // Fixture mode touches no network (L-29): a fixture that records no web is a web with nothing in it.
    if (web === null && options.mode === "fixture") web = new RecordedWeb(new Map(), new Map());
    const recorded = web;
    joins = {
      look: recorded !== null ? (url) => recorded.look(url) : (url) => lookAtPage(url, transport),
      download: recorded !== null ? (url) => recorded.download(url) : (url) => fetchPackageBytes(url, transport),
      trust,
      adapters,
    };
    callerPlan = operatorPlan(pkg, { grants: options.grants, approvedTools: own, limits: options.limits, decisions });
  }
  const archives = new Map<string, Uint8Array>();
  for (const [name, path] of pairs(parsed.list("--link"), "--link")) archives.set(name, readArchive(path));
  const links = await operatorLinks(pkg, {
    archives,
    decisions,
    trusted,
    requireTrusted: options.mode === "live",
    router: options.router,
    adapters,
    fetch: async (record) => {
      try {
        return await fetchPackageBytes(String(record.locator), transport);
      } catch (error) {
        if (error instanceof AgentPkgError) throw new LinkRefusal("link_fetch_failed", `dependency ${pyRepr(String(record.id))}: ${error.message}`);
        throw error;
      }
    },
    runner: { create: (linkedPackage, runOptions) => Workflow.create(linkedPackage, runOptions as WorkflowOptions) },
    compute: options.compute,
    joins,
    callerPlan,
  });
  return { approved: own, links, consent, planHash: callerPlan !== null ? planHash(callerPlan) : null, web };
}
