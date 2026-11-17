/**
 * What a run holds about its links, and the runner that starts an inner run (link.v0 §3, §5;
 * `agentpkg/links/host.py`, line for line).
 *
 * A host (the developer CLI, the execution session, a campaign driver) resolves the caller's
 * dependencies, takes the person's decision on each linked publisher, and hands the run one
 * `LinkHost`: per dependency a `LinkBinding` with the verified package, the decision, and what an
 * accepted package was granted: its own grants, tool approvals, handlers and limits. The mediator
 * (`Runtime.callLink`) reserves, starts, settles and records; the inner run is an ordinary run of
 * the linked package's own program, built here from its binding alone, so nothing of the caller's
 * authority can reach it.
 *
 * Nothing here is package-specific, and nothing here decides: a binding is the person's decision,
 * written down by the host.
 */
import { canonicalJson } from "../canonical.js";
import type { ComputeEngine } from "../compute/engine.js";
import { sha256HexSync } from "../hash.js";
import type { JsonObject, JsonValue } from "../json.js";
import type { ModelRouter } from "../models/contract.js";
import { activationBound, networkOf, type LinkCosts } from "../network/analysis.js";
import type { Package } from "../package.js";
import { deepCopy } from "../references.js";
import { pyRepr } from "../repr.js";
import { ExecutionError, GRANT_UNSUPPORTED } from "../execution/errors.js";
import { consumptionCounts } from "../execution/policy.js";
import type { ToolHandler } from "../tools/handler.js";
import type { CancelToken } from "../workflow/cancel.js";
import type { ExecutionReport, Workflow as WorkflowClass } from "../workflow/interpreter.js";
import type { Grants, HostLimits } from "../workflow/runtime.js";
import { codepoint, linkOperations, packageWorstCase, worstCaseFigures, type WorstCaseFigures } from "./analysis.js";
import { LinkRefusal } from "./errors.js";
import { checkComposition, linkFacts, type ResolvedLink } from "./resolve.js";
import type { JoinHost } from "./join.js";

export const LINK_PLAN_SCHEMA = "agentpkg-link-plan-v0";
export const RUN_LINKS_SCHEMA = "agentpkg-run-links-v0";
export const ACCEPTED = "accepted";
export const DENIED = "denied";

/** The canonical SHA-256 of a plan (`links/host.py::plan_hash`). */
export function planHash(plan: JsonValue): string {
  return sha256HexSync(canonicalJson(plan));
}

/**
 * The inner plan a host without a control plane writes for an accepted link (L-14): the linked
 * package, its publisher as the person's store saw it, the decisions of its card, and the caller
 * it belongs to. A control plane prepares a full Run Plan instead, with the same `parent`.
 */
export function linkPlan(caller: Package, link: ResolvedLink, options: { grants: Readonly<Record<string, string>>; approvedTools: readonly string[]; parent?: JsonObject | null }): JsonObject {
  const facts = linkFacts(link);
  return {
    schema: LINK_PLAN_SCHEMA,
    parent: options.parent ?? { package_digest: caller.digest, dependency: link.dependency },
    package: { package_id: facts.package_id!, version: facts.version!, digest: facts.digest!, archive_sha256: facts.archive_sha256! },
    publisher: { signer_fingerprint: link.signer, trust_status: link.trust },
    decisions: sortedObject(options.grants),
    tool_approvals: [...options.approvedTools].sort(codepoint),
    worst_case: worstCaseFigures(link.worst_case!),
  };
}

export function sortedObject<T extends JsonValue>(value: Readonly<Record<string, T>>): Record<string, T> {
  return Object.fromEntries(Object.entries(value).sort(([a], [b]) => codepoint(a, b)));
}

/**
 * One linked package in a run: what was resolved, the person's decision on its publisher, and,
 * when accepted, exactly what its inner runs hold. `router` null means the caller's model route
 * (L-14); a fixture host supplies the linked package's own replay (L-29).
 */
/**
 * A link the person denied, as an execution host knows it from the caller's plan alone
 * (`links/host.py::DeniedLink`): no archive reaches a runner for it, so there is no package and no
 * worst case.
 */
export interface DeniedLink {
  denied: true;
  dependency: string;
  signer: string;
  entry: JsonObject;
  worst_case: null;
}

export class LinkBinding {
  grants: Grants;
  approvedTools: string[];
  handlers: Record<string, ToolHandler>;
  router: ModelRouter | null;
  limits: HostLimits | null;
  plan: JsonObject | null = null;
  planHash: string | null = null;

  constructor(
    readonly link: ResolvedLink | DeniedLink,
    public decision: string,
    options: { grants?: Grants; approvedTools?: readonly string[]; handlers?: Record<string, ToolHandler>; router?: ModelRouter | null; limits?: HostLimits | null } = {},
  ) {
    this.grants = { ...(options.grants ?? {}) };
    this.approvedTools = [...(options.approvedTools ?? [])];
    this.handlers = { ...(options.handlers ?? {}) };
    this.router = options.router ?? null;
    this.limits = options.limits ?? null;
  }

  /** The verified package behind an accepted binding. */
  get resolved(): ResolvedLink {
    if ("denied" in this.link) throw new LinkRefusal("link_unresolved", `dependency ${pyRepr(this.link.dependency)} has no package in this run`);
    return this.link;
  }

  record(): JsonObject {
    const facts = "denied" in this.link ? Object.fromEntries(["package_id", "version", "digest", "archive_sha256", "signer", "trust"].map((key) => [key, (this.link as DeniedLink).entry[key] ?? null])) : linkFacts(this.link);
    return {
      dependency: this.link.dependency,
      ...facts,
      decision: this.decision,
      worst_case: this.link.worst_case ? worstCaseFigures(this.link.worst_case) : null,
      plan: this.plan === null ? null : deepCopy(this.plan),
      plan_hash: this.planHash,
    };
  }
}

/** What an inner run is built over: the interpreter, handed in so that this module never imports it (and its cycle back here). */
export interface InnerRunner {
  create(pkg: Package, options: Record<string, unknown>): Promise<WorkflowClass>;
}

/**
 * One inner run (L-25): the linked package's own program under its binding, with the token and
 * remote-call limits the caller reserved for it. Built before it is recorded as started, so that
 * the record names its run id.
 */
export class InnerRun {
  report: ExecutionReport | null = null;

  constructor(
    readonly binding: LinkBinding,
    readonly workflow: WorkflowClass,
  ) {}

  get run_id(): string {
    return this.workflow.runtime.run_id;
  }

  /**
   * The inner run's report, completed or failed; a cancellation passes through with its report kept
   * here. `token` is the caller's step: its cancellation (the step's time, the host) ends the inner
   * run, as the enclosing `asyncio.timeout` ends it in the reference.
   */
  async run(input: JsonValue, token: CancelToken): Promise<ExecutionReport> {
    const stop = () => this.workflow.cancel();
    if (token.cancelled) stop();
    token.signal.addEventListener("abort", stop, { once: true });
    try {
      this.report = await this.workflow.run(deepCopy(input));
    } catch (error) {
      const report = (error as { execution_report?: unknown }).execution_report as ExecutionReport | undefined;
      this.report = report ?? null;
      if (report === undefined || (error as Error).name === "CancelledError") throw error;
    } finally {
      token.signal.removeEventListener("abort", stop);
    }
    return this.report!;
  }

  /** What the inner run spent, from its own mediator: the figures the caller settles. */
  usage(): InnerUsage {
    const runtime = this.workflow.runtime;
    const usage = runtime.usage;
    return {
      tokens: usage.tokens as number,
      remote_calls: usage.remote_calls as number,
      model_calls: runtime.audit.filter((event) => event.action === "model.called").length,
      tool_calls: { ...(usage.tool_calls as Record<string, number>) },
      compute_calls: typeof usage.compute_calls === "number" ? usage.compute_calls : 0,
    };
  }
}

export interface InnerUsage extends JsonObject {
  tokens: number;
  remote_calls: number;
  model_calls: number;
  tool_calls: Record<string, number>;
  compute_calls: number;
}

/** Nothing spent: what a link that started no inner run charges (L-27). */
export const zeroUsage = (): InnerUsage => ({ tokens: 0, remote_calls: 0, model_calls: 0, tool_calls: {}, compute_calls: 0 });

/** What the host hands every inner run beside its binding: the interpreter and the host's compute engine. */
export interface LinkHostOptions {
  runner: InnerRunner;
  compute?: ComputeEngine | null;
  joins?: JoinHost | null;
  callerPlan?: JsonObject | null;
}

/**
 * The links of one run: a binding per dependency, the denials, the composed costs, the inner runs
 * made. A host builds it after resolution and the person's decisions; it refuses an undecided
 * dependency (L-17) and a composition the caller's budget cannot hold (L-20).
 */
export class LinkHost {
  readonly caller: Package;
  readonly bindings: Map<string, LinkBinding>;
  /** A denial is of the publisher's key for the run (L-13): every dependency it signed, and every key declined on a card since. */
  readonly deniedKeys: Set<string>;
  /** link.v0 §6: what lets this run's slots look and join, null where the host cannot. */
  readonly joins: JoinHost | null;
  /** The cards shown per slot (L-39). */
  readonly cards = new Map<string, number>();
  /** Every slot step's outcome, in order (L-30). */
  readonly joinRecords: JsonObject[] = [];
  /** The bindings of the packages joined, by their inner plan's hash. */
  readonly joined = new Map<string, LinkBinding>();
  /** The plan the run was decided under, where the host states one a decision made during the run can name (L-36, L-44). */
  readonly callerPlan: JsonObject | null;
  readonly callerPlanHash: string | null;
  readonly runs: JsonObject[] = [];
  readonly reports = new Map<string, ExecutionReport>();
  readonly runner: InnerRunner;
  readonly compute: ComputeEngine | null;

  constructor(caller: Package, bindings: ReadonlyMap<string, LinkBinding>, options: LinkHostOptions) {
    const declared = ((caller.manifest.dependencies as JsonObject[] | undefined) ?? []).map((record) => String(record.id));
    const missing = declared.filter((name) => !bindings.has(name));
    if (missing.length > 0) throw new LinkRefusal("link_undecided", `dependency ${pyRepr(missing[0]!)} has no decision; every linked publisher is decided before the run`);
    this.caller = caller;
    this.bindings = new Map(bindings);
    this.deniedKeys = new Set([...this.bindings.values()].filter((binding) => binding.decision !== ACCEPTED).map((binding) => binding.link.signer));
    for (const binding of this.bindings.values()) {
      if (this.deniedKeys.has(binding.link.signer)) binding.decision = DENIED;
      else if (binding.plan === null) binding.plan = linkPlan(caller, binding.resolved, { grants: binding.grants, approvedTools: binding.approvedTools });
      if (binding.decision === ACCEPTED && binding.planHash === null) binding.planHash = planHash(binding.plan!);
    }
    checkComposition(caller, this.worstCases);
    this.joins = options.joins ?? null;
    this.callerPlan = options.callerPlan ?? null;
    this.callerPlanHash = this.callerPlan !== null ? planHash(this.callerPlan) : null;
    this.runner = options.runner;
    this.compute = options.compute ?? null;
  }

  /** `linkCost`'s map: each dependency's worst case, null when denied. */
  get worstCases(): LinkCosts {
    const costs: Record<string, WorstCaseFigures | null> = {};
    for (const [name, binding] of this.bindings) costs[name] = binding.decision === ACCEPTED ? binding.link.worst_case : null;
    return costs;
  }

  binding(dependency: string): LinkBinding {
    return this.bindings.get(dependency)!;
  }

  /**
   * Whether a link may start no inner run now (L-13, L-35): the person denied it at the review, or
   * has since declined a join card of the key that signed it. A denial is of the publisher's key
   * and lasts for the run.
   */
  denied(binding: LinkBinding): boolean {
    return binding.decision !== ACCEPTED || this.deniedKeys.has(binding.link.signer);
  }

  /** L-24: the linked package's worst case under the effective limits, its own caps as the host lowered them, in the two figures a run reserves. */
  reservation(binding: LinkBinding): { tokens: number; remote_calls: number } {
    const pkg = binding.resolved.package;
    const caps: JsonObject = { ...(pkg.policy.budget as JsonObject) };
    for (const key of ["hard_tokens", "max_remote_calls"] as const) {
      const lowered = binding.limits?.[key];
      if (typeof lowered === "number") caps[key] = Math.min(caps[key] as number, lowered);
    }
    const effective = packageWorstCase(pkg.graph, pkg.policy, { budget: caps });
    return { tokens: effective.tokens, remote_calls: effective.remote_calls };
  }

  /** Build an inner run over its binding alone (L-25). */
  async start(binding: LinkBinding, options: { router: ModelRouter | null; limits: { tokens: number; remote_calls: number }; deadlineSeconds: number; deadlineAt: number }): Promise<InnerRun> {
    const workflow = await this.runner.create(binding.resolved.package, {
      grants: { ...binding.grants },
      handlers: { ...binding.handlers },
      router: binding.router ?? options.router,
      limits: { ...(binding.limits ?? {}), hard_tokens: options.limits.tokens, max_remote_calls: options.limits.remote_calls },
      approvedTools: [...binding.approvedTools],
      deadlineSeconds: options.deadlineSeconds,
      deadlineAt: options.deadlineAt,
      compute: this.compute,
    });
    return new InnerRun(binding, workflow);
  }

  /** Keep an inner run's record beside the caller's (L-30); `key` is `dependency` for a planned link and `slot` for a join. */
  finished(inner: InnerRun, entry: { key: "dependency" | "slot"; name: string; nodeId: string | null; status: "completed" | "failed"; errorCode: string | null }): void {
    this.runs.push({ inner_run_id: inner.run_id, [entry.key]: entry.name, node_id: entry.nodeId, status: entry.status, error_code: entry.errorCode });
    if (inner.report !== null) this.reports.set(inner.run_id, inner.report);
  }

  /** The run record's `links` (L-30): each link with its publisher, decision and inner plan, and the inner runs made. */
  record(): JsonObject {
    const slots = linkOperations(this.caller.graph).some(([, step]) => "slot" in step);
    const joins = this.joinRecords.map((entry) => {
      const binding = typeof entry.inner_plan_hash === "string" ? this.joined.get(entry.inner_plan_hash) : undefined;
      let pkg: JsonObject | null = null;
      if (binding !== undefined) {
        const { dependency: _dependency, decision: _decision, ...kept } = binding.record();
        pkg = kept;
      }
      // An accepted join's package and inner plan, as a planned link's are kept.
      return { ...deepCopy(entry), package: pkg };
    });
    const names = [...this.bindings.keys()].sort(codepoint);
    return {
      schema: RUN_LINKS_SCHEMA,
      links: names.map((name) => this.bindings.get(name)!.record()),
      runs: deepCopy(this.runs),
      // Present exactly when the caller's graph holds a slot: every slot step's outcome, in order.
      ...(slots ? { joins } : {}),
      ...(this.callerPlan !== null ? { caller_plan: deepCopy(this.callerPlan), caller_plan_hash: this.callerPlanHash! } : {}),
    };
  }
}

/** How often a run can reach a dependency at most: a node once, a map step per item, a role step per activation of its role (R-20). */
export function linkMultiplicity(graph: JsonObject, dependency: string): number {
  const network = networkOf(graph);
  const nodes = new Map(((graph.nodes as JsonObject[] | undefined) ?? []).map((node) => [String(node.id), node]));
  let total = 0;
  for (const [label, step, where, roleId] of linkOperations(graph)) {
    if (step.dependency !== dependency) continue;
    if (where === "node") total += 1;
    else if (where === "map") total += nodes.get(label.split("/")[0]!)!.max_items as number;
    else total += activationBound(network!, roleId!);
  }
  return total;
}

/**
 * L-28 (network.v0 R-26 across a link): a `once` grant on a linked package's card is refused where
 * the composition could consume that permission more than once.
 */
export function checkOnce(caller: Package, bindings: ReadonlyMap<string, LinkBinding>): void {
  for (const [name, binding] of bindings) {
    if (binding.decision !== ACCEPTED) continue;
    const pkg = binding.resolved.package;
    const kinds = new Map((pkg.policy.permissions as JsonObject[]).map((permission) => [String(permission.id), String(permission.kind)]));
    const counts = consumptionCounts(pkg);
    const reached = linkMultiplicity(caller.graph, name);
    for (const [permission, scope] of Object.entries(binding.grants)) {
      const kind = kinds.get(permission);
      if (scope === "once" && reached * (kind !== undefined ? (counts[kind] ?? 0) : 0) > 1) {
        throw new ExecutionError(GRANT_UNSUPPORTED, `Permission ${pyRepr(permission)} of linked package ${pyRepr(name)} was granted 'once', and the composition could consume it more than once.`, { detail: { permission, dependency: name } });
      }
    }
  }
}
