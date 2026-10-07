/**
 * One-time execution leases: how immutable bytes leave the control plane (`browser/lease.py`,
 * `control.py::issue_execution_lease`) and the runner-side re-verification the reference splits
 * across the plugin's preflight and `execution/artifact.py`.
 *
 * A lease is the smaller thing than a path: a private copy of the session's snapshot, created only
 * when the plan is ready *right now*, named by a random identifier, valid for a bounded time and
 * consumable once. Issuing one is gated on the same question every other gate asks, recomputed by
 * T3's `preflight` and handed in here (the registry never computes trust itself), plus the checks
 * the runner adds: the bytes verified against the plan (archive hash, digest, id, version,
 * signature, signer), every bound tool still the implementation it was approved as, every granted
 * resource still the record it was chosen as, the model still offered, the receipt outlasting the
 * run, and `once` spent by the first lease. The registry executes nothing.
 */
import { sha256Hex } from "../hash.js";
import type { JsonObject } from "../json.js";
import type { Package } from "../package.js";
import { bindingDigest, describeDefinition, findDefinition, type DescribeOptions, type ToolImplementationDefinition } from "../tools/definitions.js";
import type { ResourceResolver } from "../tools/resources.js";
import type { Reason, RunPlan, RunPlanPreflight } from "../types.js";
import { verifyExecutionArtifact, type ArtifactEvidence } from "./artifact.js";
import { ARTIFACT_MISMATCH, AUTHORIZATION_EXPIRING, AUTHORIZATION_ONCE_SPENT, ExecutionError, LEASE_ACTIVE, LEASE_UNKNOWN, RUN_PLAN_STALE, SELECTED_MODEL_UNAVAILABLE, TOOL_BINDING_STALE } from "./errors.js";

export const LEASE_SCHEMA = "agentpkg-execution-lease-v0";
/** Long enough to start, short enough that a forgotten lease is not a lasting copy. */
export const DEFAULT_LEASE_TTL_SECONDS = 900;

export interface ExecutionLease {
  schema: typeof LEASE_SCHEMA;
  lease_id: string;
  session_id: string;
  run_plan_id: string;
  run_plan_sha256: string;
  receipt_id: string;
  archive_sha256: string;
  archive_bytes: number;
  package_digest: string;
  created_at: string;
  expires_at: string;
  consumed: boolean;
  /** The bytes, verified; released with the lease. */
  readonly archive: Uint8Array;
  /** The package those bytes load to, verified against the plan. */
  readonly package: Package;
  readonly evidence: ArtifactEvidence;
  /** What was re-checked at issue, for the run record's `revalidated`. */
  readonly revalidated: string[];
  note: string;
}

export interface LeaseInputs {
  plan: RunPlan;
  /** T3's `preflight(plan, …)`, computed by the caller with `onceSpent: registry.onceSpent(plan)`. */
  preflight: RunPlanPreflight;
  archive: Uint8Array;
  /** The host's current tool definitions; every bound tool must still digest the same. Omit when the host has none. */
  definitions?: readonly ToolImplementationDefinition[] | null;
  describe?: DescribeOptions;
  /** The store that holds the person's resources, when the host has it: every granted resource must still be the one chosen. */
  resolver?: ResourceResolver | null;
  /** Whether the host still offers the planned model (null: unknown, which is not unavailable). */
  modelAvailable?: ((hostModelId: string) => boolean | null) | null;
  /** The run's effective deadline: the receipt must outlast it (the reference plugin's rule). */
  minimumReceiptRemainingSeconds?: number | null;
  sessionExpiresAt?: string | null;
  now?: Date;
}

export interface LeaseView extends JsonObject {
  schema: typeof LEASE_SCHEMA;
  lease_id: string;
  archive_sha256: string;
  archive_bytes: number;
  package_digest: string;
  run_plan_id: string;
  run_plan_sha256: string;
  created_at: string;
  expires_at: string;
  consumed: boolean;
  note: string;
}

const NOTE = "A one-time private copy of this session's immutable snapshot. The control plane does not execute it; a runner must re-verify its hash, digest and signature before running anything.";

function base64url(bytes: Uint8Array): string {
  let text = "";
  for (const byte of bytes) text += String.fromCharCode(byte);
  // The core has no btoa in its allowlist; a small table keeps the id URL-safe.
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  let out = "";
  for (let index = 0; index < bytes.length; index += 3) {
    const a = bytes[index]!;
    const b = bytes[index + 1];
    const c = bytes[index + 2];
    out += alphabet[a >> 2]!;
    out += alphabet[((a & 3) << 4) | ((b ?? 0) >> 4)]!;
    if (b !== undefined) out += alphabet[((b & 15) << 2) | ((c ?? 0) >> 6)]!;
    if (c !== undefined) out += alphabet[c & 63]!;
  }
  void text;
  return out;
}

export function grantsOnce(decisions: Readonly<Record<string, string>>): boolean {
  return Object.values(decisions).includes("once");
}

/** The lease as the host API shows it: identity and lifetime, never the bytes. */
export function leaseView(lease: ExecutionLease): LeaseView {
  return {
    schema: LEASE_SCHEMA,
    lease_id: lease.lease_id,
    archive_sha256: lease.archive_sha256,
    archive_bytes: lease.archive_bytes,
    package_digest: lease.package_digest,
    run_plan_id: lease.run_plan_id,
    run_plan_sha256: lease.run_plan_sha256,
    created_at: lease.created_at,
    expires_at: lease.expires_at,
    consumed: lease.consumed,
    note: lease.note,
  };
}

function stale(reasons: readonly Reason[], fallback: string, detail: Record<string, unknown>): ExecutionError {
  return new ExecutionError(RUN_PLAN_STALE, reasons[0]?.message ?? fallback, { detail });
}

/**
 * The leases of one host (per browser profile): outstanding copies by id and the receipts whose
 * `once` grants a run already used. The host persists `spentReceipts()` and restores it through
 * the constructor; nothing else survives a restart, which is what "one-time" means.
 */
export class LeaseRegistry {
  private readonly leases = new Map<string, ExecutionLease>();
  private readonly spent: Set<string>;
  private readonly ttl: number;

  constructor(options: { ttlSeconds?: number; spentReceipts?: Iterable<string> } = {}) {
    this.ttl = options.ttlSeconds ?? DEFAULT_LEASE_TTL_SECONDS;
    this.spent = new Set(options.spentReceipts ?? []);
  }

  /** Whether this plan's receipt granted something `once` that a lease already used (for T3's `preflight`). */
  onceSpent(plan: Pick<RunPlan, "authorization">): boolean {
    return this.spent.has(plan.authorization.receipt_id) && grantsOnce(plan.authorization.decisions);
  }

  spentReceipts(): string[] {
    return [...this.spent].sort();
  }

  outstanding(now: Date = new Date()): ExecutionLease[] {
    this.purgeExpired(now);
    return [...this.leases.values()];
  }

  purgeExpired(now: Date = new Date()): void {
    for (const [id, lease] of this.leases) if (Date.parse(lease.expires_at) <= now.getTime()) this.leases.delete(id);
  }

  /**
   * Copy the snapshot into a new lease, verifying everything that can be verified here. A
   * mismatch at any step is a refusal, not a repair; nothing is recorded until every check passed.
   */
  async issue(input: LeaseInputs): Promise<ExecutionLease> {
    const { plan, preflight } = input;
    const now = input.now ?? new Date();
    if (preflight.run_plan_id !== plan.run_plan_id || preflight.run_plan_sha256 !== plan.run_plan_sha256) {
      throw new ExecutionError("run_plan_mismatch", "The preflight does not describe this run plan", { detail: { preflight_run_plan_id: preflight.run_plan_id } });
    }
    const revalidated: string[] = [];
    if (!preflight.ready || preflight.stale) {
      const reasons = preflight.stale_reasons.length > 0 ? preflight.stale_reasons : preflight.blocking_reasons;
      if (reasons.some((reason) => reason.code === "authorization_once_spent")) {
        throw new ExecutionError(AUTHORIZATION_ONCE_SPENT, "This authorization granted something once, and a run has already used it. Authorize again to run again.", { detail: { receipt_id: plan.authorization.receipt_id } });
      }
      throw stale(reasons, "This run plan is not ready", { preflight: preflight as unknown as JsonObject });
    }
    revalidated.push("preflight_ready");
    if (this.onceSpent(plan)) {
      // The caller's preflight should have said so; the registry is the authority either way.
      throw new ExecutionError(AUTHORIZATION_ONCE_SPENT, "This authorization granted something once, and a run has already used it. Authorize again to run again.", { detail: { receipt_id: plan.authorization.receipt_id } });
    }
    revalidated.push("once_not_spent");
    const receiptExpiry = Date.parse(plan.authorization.expires_at);
    const remaining = Number.isFinite(receiptExpiry) ? (receiptExpiry - now.getTime()) / 1000 : null;
    if (remaining !== null && remaining <= 0) throw stale([{ code: "authorization_expired", message: "The authorization receipt has expired.", subject: null }], "expired", {});
    const required = input.minimumReceiptRemainingSeconds ?? 0;
    if (required > 0 && remaining !== null && remaining < required) {
      throw new ExecutionError(
        AUTHORIZATION_EXPIRING,
        `A run may take up to ${Math.round(required)}s, and this authorization has ${Math.max(0, Math.round(remaining))}s left. An authorization lasts only as long as its package session; authorize and prepare a new run plan before starting, so consent does not lapse in the middle of a run.`,
        { detail: { remaining_seconds: Math.max(0, Math.round(remaining)), required_seconds: Math.round(required) } },
      );
    }
    revalidated.push(required > 0 ? "receipt_outlasts_run_deadline" : "receipt_not_expired");
    this.purgeExpired(now);
    const live = [...this.leases.values()].find((lease) => lease.session_id === plan.session_id);
    if (live !== undefined) {
      // One active execution per session: a second lease would be a second run against the same consent.
      throw new ExecutionError(LEASE_ACTIVE, "An execution lease is already outstanding for this session; release it first", { detail: { lease_id: live.lease_id } });
    }
    if (plan.publisher.signer_fingerprint === null) {
      throw stale([{ code: "signer_unknown", message: "This plan records no publisher signer, so the bytes cannot be matched to a trusted identity.", subject: null }], "signer", {});
    }
    const archive = new Uint8Array(input.archive);
    const archiveSha256 = await sha256Hex(archive);
    if (archiveSha256 !== plan.package.archive_sha256) {
      throw new ExecutionError(ARTIFACT_MISMATCH, "The session snapshot no longer hashes to the value the run plan recorded", { detail: { expected: plan.package.archive_sha256, received: archiveSha256 } });
    }
    const { package: pkg, evidence } = await verifyExecutionArtifact(archive, {
      archive_sha256: plan.package.archive_sha256,
      digest: plan.package.digest,
      package_id: plan.package.package_id,
      version: plan.package.version,
      signer_fingerprint: plan.publisher.signer_fingerprint,
    });
    revalidated.push(...evidence.verified.map((name) => `artifact:${name}`));
    if (input.definitions !== undefined && input.definitions !== null) {
      for (const binding of plan.tool_bindings) {
        const definition = findDefinition(input.definitions, binding.binding_id);
        if (definition === undefined) {
          throw new ExecutionError(TOOL_BINDING_STALE, `This host no longer registers the implementation of ${binding.tool_id} that this plan bound.`, { detail: { tool_id: binding.tool_id, binding_id: binding.binding_id } });
        }
        const current = bindingDigest(describeDefinition(definition, input.describe ?? {}));
        if (current !== binding.binding_sha256) {
          throw new ExecutionError(TOOL_BINDING_STALE, `The host implementation of ${binding.tool_id} changed after this plan was prepared, so it is no longer the one that was approved.`, { detail: { tool_id: binding.tool_id, binding_id: binding.binding_id } });
        }
      }
      revalidated.push(`tool_bindings:${plan.tool_bindings.length}`);
    }
    // The preflight already compared the grants with the current registry; a host that holds the
    // store re-checks each granted record against it here as well.
    if (plan.resource_grants.length > 0 && input.resolver !== undefined && input.resolver !== null) {
      const resolver = input.resolver;
      for (const grant of plan.resource_grants) {
        const view = resolver.describe(grant.resource_id);
        if (view === undefined) throw stale([{ code: "resource_removed", message: `The host resource granted under ${grant.permission_id} no longer exists.`, subject: grant.permission_id }], "resources", { permission_id: grant.permission_id });
        if (view.type !== grant.resource_type || view.digest !== grant.resource_digest) {
          throw stale([{ code: "resource_changed", message: `The host resource granted under ${grant.permission_id} changed after this plan was prepared.`, subject: grant.permission_id }], "resources", { permission_id: grant.permission_id });
        }
      }
      revalidated.push(`resource_grants:${plan.resource_grants.length}`);
    }
    if (plan.model_binding !== null && input.modelAvailable) {
      const available = input.modelAvailable(plan.model_binding.host_model_id);
      if (available === false) {
        throw new ExecutionError(SELECTED_MODEL_UNAVAILABLE, `This host no longer offers ${plan.model_binding.host_model_id} as a usable choice, so the run plan's model cannot be invoked.`, { detail: { host_model_id: plan.model_binding.host_model_id } });
      }
      if (available === true) revalidated.push("model_still_available");
    }
    const sessionExpiry = input.sessionExpiresAt ? Date.parse(input.sessionExpiresAt) : Number.NaN;
    const ttl = Number.isFinite(sessionExpiry) ? Math.min(this.ttl, Math.max(1, Math.floor((sessionExpiry - now.getTime()) / 1000))) : this.ttl;
    const lease: ExecutionLease = {
      schema: LEASE_SCHEMA,
      lease_id: base64url(crypto.getRandomValues(new Uint8Array(18))),
      session_id: plan.session_id,
      run_plan_id: plan.run_plan_id,
      run_plan_sha256: plan.run_plan_sha256,
      receipt_id: plan.authorization.receipt_id,
      archive_sha256: archiveSha256,
      archive_bytes: archive.length,
      package_digest: pkg.digest,
      created_at: now.toISOString(),
      expires_at: new Date(now.getTime() + ttl * 1000).toISOString(),
      consumed: false,
      archive,
      package: pkg,
      evidence,
      revalidated,
      note: NOTE,
    };
    this.leases.set(lease.lease_id, lease);
    // Handing the bytes to a runner starts a run, and a run is what a one-time grant was for.
    if (grantsOnce(plan.authorization.decisions)) this.spent.add(plan.authorization.receipt_id);
    return lease;
  }

  /** Take the lease for a run: once, for the plan it was issued against, before it expires. */
  consume(leaseId: string, plan: Pick<RunPlan, "run_plan_id" | "run_plan_sha256">, now: Date = new Date()): ExecutionLease {
    this.purgeExpired(now);
    const lease = this.leases.get(leaseId);
    if (lease === undefined) throw new ExecutionError(LEASE_UNKNOWN, "No outstanding execution lease has that id; it was released, consumed or expired");
    if (lease.run_plan_id !== plan.run_plan_id || lease.run_plan_sha256 !== plan.run_plan_sha256) {
      throw new ExecutionError("run_plan_mismatch", "This lease was issued against a different run plan", { detail: { lease_run_plan_id: lease.run_plan_id } });
    }
    if (lease.consumed) throw new ExecutionError(LEASE_UNKNOWN, "This execution lease was already consumed; a lease is permission to read its bytes once");
    lease.consumed = true;
    return lease;
  }

  /** Drop a lease's private copy. Safe to call more than once. */
  release(leaseId: string): boolean {
    return this.leases.delete(leaseId);
  }
}
