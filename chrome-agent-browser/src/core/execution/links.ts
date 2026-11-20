/**
 * The run's links from the caller's Run Plan and the inner plans (link.v0 L-15, D-692;
 * `execution/session.py::_bind_links`, line for line).
 *
 * Nothing of a linked package is taken on trust from the caller's plan: each accepted link's
 * archive is verified here against its inner plan, the inner plan against the entry the caller's
 * plan names (its hash, its parent, its package, its signer), and its authorization passes the
 * checks the caller's passes. The caller's plan says only which inner plan the person agreed to. An
 * inner plan is authority only inside its caller's run: one handed over as a run's own plan is
 * refused (`link_plan_parent_mismatch`, L-15).
 */
import type { ComputeEngine } from "../compute/engine.js";
import type { JsonObject } from "../json.js";
import { packageWorstCase } from "../links/analysis.js";
import { LinkRefusal } from "../links/errors.js";
import { ACCEPTED, checkOnce, DENIED, LinkBinding, LinkHost, type InnerRunner } from "../links/host.js";
import type { JoinHost } from "../links/join.js";
import { checkModel as checkLinkModel, checkRecord } from "../links/resolve.js";
import type { ModelRouter } from "../models/contract.js";
import type { Package } from "../package.js";
import { toolHandlers, type BrokerDeps } from "../tools/broker.js";
import type { ToolHandler } from "../tools/handler.js";
import { MODE_MODEL } from "../types.js";
import type { Grants } from "../workflow/runtime.js";
import { verifyExecutionArtifact } from "./artifact.js";
import { ExecutionError, invalid, PERMISSION_DENIED } from "./errors.js";
import { runtimeLimits, type HostExecutionLimits } from "./limits.js";
import { normalizeAuthorization, normalizeExecutionPlan, type ExecutionAuthorization, type ExecutionPlan } from "./plan.js";
import { checkCapabilities, checkResourceGrants, checkTools, normalizeGrants } from "./policy.js";

/** An inner plan handed over is not the one the caller's plan names, names another caller, or is handed over as a run's own plan (L-15). */
export const LINK_PLAN_MISMATCH = "link_plan_parent_mismatch";

/** What a host hands a run for each accepted link: the inner plan and its authorization (`execution.begin`'s `links`). */
export interface InnerPlanHandover {
  run_plan: ExecutionPlan | unknown;
  authorization: ExecutionAuthorization | unknown;
}

export interface BindLinksInputs {
  plan: ExecutionPlan;
  pkg: Package;
  limits: HostExecutionLimits;
  router: ModelRouter | null;
  /** The inner plans by dependency id, as the host handed them over. */
  supplied: Record<string, InnerPlanHandover> | null;
  /** The accepted linked packages' archives by dependency id, read and verified here. */
  archives: Record<string, Uint8Array> | null;
  /** The host's tool deps (a model-backed plan), to bind an inner plan's tools as the caller's are bound. */
  tools: BrokerDeps | null;
  /**
   * The tool deps of one linked package, on a host whose implementations are derived per package
   * (the Chrome hosts): that package's own definitions over the host's transport, and nothing of the
   * caller's files, resources or memory (L-25). Absent, `tools` serves every inner plan, as on a host
   * whose implementations are its own (the reference).
   */
  linkTools?: ((linked: Package, dependency: string) => BrokerDeps | Promise<BrokerDeps>) | null;
  /** A fixture plan: each linked package answers from its own fixture (L-29). */
  fixture: ((pkg: Package) => { router: ModelRouter; handlers: Record<string, ToolHandler> }) | null;
  runner: InnerRunner;
  compute: ComputeEngine | null;
  joins: JoinHost | null;
}

/**
 * The checks a caller's plan and authorization pass, on a linked package's own
 * (`execution/session.py::check_authorization`): the decisions normalized, every required
 * permission granted, every tool binding re-derived and approved, every resource grant consistent.
 */
export function checkAuthorization(pkg: Package, plan: ExecutionPlan, authorization: ExecutionAuthorization, subject: string | null = null): { grants: Grants; tools: JsonObject; resources: JsonObject } {
  const grants = normalizeGrants(pkg, authorization.decisions);
  for (const permissionId of plan.execution.required_permission_ids) {
    if ((grants[permissionId] ?? "deny") === "deny") {
      throw new ExecutionError(PERMISSION_DENIED, `A model-backed run${subject !== null ? ` of linked package '${subject}'` : ""} requires permission '${permissionId}', which is denied.`, { detail: { permission: permissionId, ...(subject !== null ? { dependency: subject } : {}) } });
    }
  }
  const tools = plan.execution.fixture ? {} : checkTools(pkg, plan.tool_bindings, grants, authorization.tool_approvals);
  const resources = checkResourceGrants(pkg, plan.resource_grants, grants);
  return { grants, tools, resources };
}

/** The run's `LinkHost` from the caller's plan and the inner plans; null for a package without dependencies. */
export async function bindLinks(input: BindLinksInputs): Promise<LinkHost | null> {
  const { plan, pkg } = input;
  const records = new Map(((pkg.manifest.dependencies as JsonObject[] | undefined) ?? []).map((record) => [String(record.id), record]));
  const planned = plan.links ?? {};
  const supplied = input.supplied ?? {};
  if (records.size === 0) {
    if (Object.keys(planned).length > 0 || Object.keys(supplied).length > 0) throw invalid("The run plan names links this package does not declare.");
    return null;
  }
  const missing = [...new Set([...records.keys(), ...Object.keys(planned)])].filter((name) => !records.has(name) || !Object.hasOwn(planned, name)).sort();
  if (missing.length > 0) throw new ExecutionError("execution_plan_invalid", "The run plan does not record a decision for every dependency of this package.", { detail: { dependencies: missing.slice(0, 8) } });
  const bindings = new Map<string, LinkBinding>();
  for (const name of Object.keys(planned).sort()) {
    const entry = planned[name]!;
    if (entry.decision !== ACCEPTED) {
      bindings.set(name, new LinkBinding({ denied: true, dependency: name, signer: entry.signer, entry, worst_case: null }, DENIED));
      continue;
    }
    const handover = supplied[name];
    if (handover === undefined || handover === null || typeof handover !== "object") throw invalid(`No inner plan was handed to the runner for linked package '${name}'.`);
    const archive = input.archives?.[name];
    if (archive === undefined) throw invalid(`No archive was handed to the runner for linked package '${name}'.`);
    const inner = normalizeExecutionPlan(handover.run_plan);
    const authorization = normalizeAuthorization(handover.authorization);
    const parent = inner.parent ?? {};
    if (
      inner.run_plan_sha256 !== entry.plan_hash ||
      Object.keys(parent).sort().join(",") !== "dependency,package_digest" ||
      parent.dependency !== name ||
      parent.package_digest !== pkg.digest ||
      inner.package.digest !== entry.digest ||
      inner.package.archive_sha256 !== entry.archive_sha256 ||
      inner.publisher.signer_fingerprint !== entry.signer
    ) {
      throw new ExecutionError(LINK_PLAN_MISMATCH, `The inner plan handed over for '${name}' is not the one this run plan names, or it was prepared for another caller.`, { detail: { dependency: name } });
    }
    const { package: linked, evidence } = await verifyExecutionArtifact(archive, {
      archive_sha256: inner.package.archive_sha256,
      digest: inner.package.digest,
      package_id: inner.package.package_id,
      version: inner.package.version,
      signer_fingerprint: inner.publisher.signer_fingerprint,
    });
    try {
      checkRecord(records.get(name)!, linked, entry.signer);
    } catch (error) {
      if (error instanceof LinkRefusal) throw new ExecutionError(error.code, error.message.slice(error.code.length + 2), { detail: { dependency: name } });
      throw error;
    }
    // The reference asks the engine globally (`compute.engine.available()`): a linked package's compute node runs on the caller's engine (L-26).
    checkCapabilities(linked, input.limits, { toolBindings: inner.tool_bindings, deniedTools: inner.execution.denied_tool_ids, fixture: inner.execution.fixture, computeAvailable: (input.compute ?? null) !== null });
    // L-14: an inner plan is a model-backed plan on the caller's route. The inner run is given the
    // caller's router whatever its plan says, so a plan that names another model would be a record
    // of a route the run never used.
    if (inner.execution.mode !== MODE_MODEL || inner.execution.fixture !== plan.execution.fixture || (plan.model_binding !== null && inner.model_binding?.host_model_id !== plan.model_binding.host_model_id)) {
      throw new ExecutionError("execution_plan_invalid", `The inner plan of '${name}' is not a model-backed plan on its caller's model route.`, { detail: { dependency: name } });
    }
    const { grants } = checkAuthorization(linked, inner, authorization, name);
    let handlers: Record<string, ToolHandler>;
    let router: ModelRouter | null = null;
    let approved: string[];
    if (input.fixture !== null) {
      const replay = input.fixture(linked);
      handlers = replay.handlers;
      router = replay.router;
      approved = Object.keys(authorization.tool_approvals).filter((toolId) => authorization.tool_approvals[toolId] === true && Object.hasOwn(linked.tools, toolId)).sort();
    } else {
      const tools = input.linkTools ? await input.linkTools(linked, name) : (input.tools ?? { definitions: [] });
      handlers = toolHandlers(inner.tool_bindings, { ...tools }).handlers;
      approved = inner.tool_bindings.map((binding) => binding.tool_id);
    }
    const route = router ?? input.router;
    if (route !== null && ((linked.manifest.model_requirements as JsonObject).tasks as JsonObject[]).length > 0) {
      try {
        checkLinkModel({ package: linked, dependency: name }, route);
      } catch (error) {
        if (error instanceof LinkRefusal) throw new ExecutionError(error.code, error.message.slice(error.code.length + 2), { detail: { dependency: name } });
        throw error;
      }
    }
    const binding = new LinkBinding(
      {
        dependency: name,
        record: { ...records.get(name)! },
        package: linked,
        archive_sha256: evidence.archive_sha256 as string,
        signer: entry.signer,
        trust: entry.trust ?? "unknown",
        worst_case: packageWorstCase(linked.graph, linked.policy),
        bytes: archive,
      },
      ACCEPTED,
      { grants, approvedTools: approved, handlers, router, limits: runtimeLimits(input.limits) },
    );
    binding.plan = inner as unknown as JsonObject;
    binding.planHash = inner.run_plan_sha256;
    bindings.set(name, binding);
  }
  let host: LinkHost;
  try {
    host = new LinkHost(pkg, bindings, { runner: input.runner, compute: input.compute, joins: input.joins });
  } catch (error) {
    if (error instanceof LinkRefusal) throw new ExecutionError(error.code, error.message.slice(error.code.length + 2));
    throw error;
  }
  checkOnce(pkg, host.bindings);
  return host;
}
