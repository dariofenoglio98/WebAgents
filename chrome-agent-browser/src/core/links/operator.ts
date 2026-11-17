/**
 * The links of a run whose operator is the person: the developer CLI, a conformance driver, a
 * campaign runner (link.v0 §3 without a control plane; `agentpkg/links/operator.py`, line for line).
 *
 * The operator supplies, per dependency, the archive (accepted only by its pinned digest) or
 * nothing (the locator is fetched under the package-URL policy), and the decision on that
 * publisher's card: accepted with that package's own grants and tool approvals, or denied. The
 * result is the `LinkHost` a run holds. Nothing of a linked package runs here.
 */
import { AgentPkgError } from "../errors.js";
import type { JsonObject, JsonValue } from "../json.js";
import type { ModelRouter } from "../models/contract.js";
import type { Package } from "../package.js";
import { pyRepr } from "../repr.js";
import type { ToolHandler } from "../tools/handler.js";
import type { Grants, HostLimits } from "../workflow/runtime.js";
import { codepoint, linkOperations } from "./analysis.js";
import { LinkRefusal } from "./errors.js";
import { ACCEPTED, DENIED, LinkBinding, LinkHost, sortedObject, type LinkHostOptions } from "./host.js";
import { checkModel, resolveLinks } from "./resolve.js";

export const OPERATOR_PLAN_SCHEMA = "agentpkg-operator-plan-v0";

/** The operator's decision on one linked publisher's card. */
export interface OperatorDecision {
  decision: "accepted" | "denied";
  grants?: Record<string, string>;
  approved_tools?: readonly string[];
  limits?: HostLimits | null;
}

/**
 * What an operator decided before a run, where no control plane prepared a Run Plan: the package,
 * its grants and tool approvals, the host's limits and the decision on each linked publisher. Its
 * canonical SHA-256 is the `plan_hash` a join's inner plan and a raise name (L-36, L-44).
 */
export function operatorPlan(caller: Package, options: { grants: Readonly<Record<string, string>> | null; approvedTools: readonly string[] | null; limits: JsonObject | null; decisions: Readonly<Record<string, OperatorDecision>> | null }): JsonObject {
  const manifest = caller.manifest;
  const links: JsonObject = {};
  for (const name of Object.keys(options.decisions ?? {}).sort(codepoint)) {
    const decision = options.decisions![name]!;
    links[name] = {
      decision: decision.decision === ACCEPTED ? ACCEPTED : DENIED,
      decisions: sortedObject(decision.grants ?? {}),
      tool_approvals: [...(decision.approved_tools ?? [])].sort(codepoint),
    };
  }
  return {
    schema: OPERATOR_PLAN_SCHEMA,
    package: { package_id: manifest.package_id!, version: manifest.version!, digest: caller.digest },
    decisions: sortedObject(options.grants ?? {}),
    tool_approvals: [...(options.approvedTools ?? [])].sort(codepoint),
    limits: sortedObject((options.limits ?? {}) as Record<string, JsonValue>),
    links,
  };
}

/**
 * `--approve-tool` values: a caller's own tool id, or `<dependency>:<tool>` for a linked package's.
 * A value that is exactly one of the caller's tools is the caller's.
 */
export function splitToolApprovals(caller: Package, approvals: readonly string[]): { own: string[]; linked: Record<string, string[]> } {
  const own = new Set<string>();
  const linked: Record<string, Set<string>> = {};
  const dependencies = new Set(((caller.manifest.dependencies as JsonObject[] | undefined) ?? []).map((record) => record.id));
  for (const value of approvals) {
    const at = value.indexOf(":");
    const name = at >= 0 ? value.slice(0, at) : value;
    const tool = at >= 0 ? value.slice(at + 1) : "";
    if (!Object.hasOwn(caller.tools, value) && tool && dependencies.has(name)) (linked[name] ??= new Set()).add(tool);
    else own.add(value);
  }
  return {
    own: [...own].sort(codepoint),
    linked: Object.fromEntries(Object.entries(linked).map(([name, tools]) => [name, [...tools].sort(codepoint)])),
  };
}

/** What an accepted linked package's inner runs are handed: its own fixture replay, or the host's handlers for its tools with null for the caller's route. */
export type LinkAdapters = (pkg: Package) => Promise<{ router: ModelRouter | null; handlers: Record<string, ToolHandler> }> | { router: ModelRouter | null; handlers: Record<string, ToolHandler> };

/**
 * Resolve the caller's dependencies and bind the operator's decisions. `archives`: supplied
 * archives by dependency id. `trusted`: the publisher key fingerprints the operator pinned for
 * this run. A package without dependencies and without a slot returns null.
 */
export async function operatorLinks(
  caller: Package,
  options: {
    archives?: ReadonlyMap<string, Uint8Array>;
    decisions?: Readonly<Record<string, OperatorDecision>>;
    trusted?: ReadonlySet<string>;
    requireTrusted?: boolean;
    router?: ModelRouter | null;
    adapters?: LinkAdapters | null;
    fetch?: ((record: JsonObject) => Promise<Uint8Array>) | null;
  } & LinkHostOptions,
): Promise<LinkHost | null> {
  const archives = new Map(options.archives ?? []);
  const decisions = { ...(options.decisions ?? {}) };
  const declared = ((caller.manifest.dependencies as JsonObject[] | undefined) ?? []).map((record) => String(record.id));
  const stray = [...new Set([...archives.keys(), ...Object.keys(decisions)])].filter((name) => !declared.includes(name)).sort(codepoint);
  if (stray.length > 0) throw new LinkRefusal("link_dependency_unknown", `${pyRepr(stray[0]!)} is not a dependency this package declares`);
  if (declared.length === 0 && linkOperations(caller.graph).length === 0) return null;
  const trusted = options.trusted ?? new Set<string>();
  const resolved = await resolveLinks(caller, archives, { trust: (signer) => (trusted.has(signer) ? "trusted" : "unknown"), fetch: options.fetch ?? null });
  const bindings = new Map<string, LinkBinding>();
  for (const [name, link] of resolved) {
    const decision = decisions[name];
    if (decision === undefined) continue;
    if (decision.decision !== ACCEPTED) {
      bindings.set(name, new LinkBinding(link, DENIED));
      continue;
    }
    if (options.requireTrusted && link.trust !== "trusted") {
      throw new LinkRefusal("link_publisher_untrusted", `dependency ${pyRepr(name)}: its publisher key ${link.signer} is not one this host trusts; pin it before accepting the link`);
    }
    const approved = [...new Set(decision.approved_tools ?? [])].sort(codepoint);
    const unknown = approved.filter((tool) => !Object.hasOwn(link.package.tools, tool)).sort(codepoint);
    if (unknown.length > 0) throw new AgentPkgError(`approved tool ${pyRepr(unknown[0]!)} is not declared by linked package ${pyRepr(name)}`);
    const adapters = options.adapters ? await options.adapters(link.package) : { router: null, handlers: {} };
    checkModel(link, adapters.router ?? options.router ?? null);
    bindings.set(name, new LinkBinding(link, ACCEPTED, { grants: { ...(decision.grants ?? {}) } as Grants, approvedTools: approved, handlers: adapters.handlers, router: adapters.router, limits: decision.limits ?? null }));
  }
  return new LinkHost(caller, bindings, { runner: options.runner, compute: options.compute ?? null, joins: options.joins ?? null, callerPlan: options.callerPlan ?? null });
}
