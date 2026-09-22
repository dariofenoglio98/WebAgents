/**
 * Projection from control-plane JSON into the bounded browser DTOs.
 *
 * This layer exists so the page receives a stable, explicitly enumerated shape
 * instead of whatever the control plane happens to return. It renames fields
 * into camelCase, drops anything the UI does not need (snapshot paths, cache
 * locations, receipt internals), and truncates every list.
 *
 * It makes no security decisions: statuses are copied verbatim from the
 * control plane, never recomputed.
 */
import { LIMITS, type PackageViewType, type PermissionsViewType, type ReceiptViewType } from "./contract.js";

type Json = Record<string, unknown>;

const rec = (value: unknown): Json => (typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Json) : {});
const arr = (value: unknown, max: number): unknown[] => (Array.isArray(value) ? value.slice(0, max) : []);
const str = (value: unknown, fallback = ""): string => (typeof value === "string" ? value : fallback);
const nullableStr = (value: unknown): string | null => (typeof value === "string" ? value : null);
const num = (value: unknown, fallback = 0): number => (typeof value === "number" && Number.isFinite(value) ? value : fallback);
const int = (value: unknown, fallback = 0): number => Math.trunc(num(value, fallback));
const nullableNum = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);
const nullableInt = (value: unknown): number | null => {
  const value_ = nullableNum(value);
  return value_ === null ? null : Math.trunc(value_);
};
const bool = (value: unknown): boolean => value === true;
const strings = (value: unknown, max: number): string[] =>
  arr(value, max).map((item) => str(item)).filter((item) => item.length > 0);

const LAYERS = new Set(["valid", "invalid", "not_evaluated", "compatible", "incompatible"]);
const layer = (value: unknown): "valid" | "invalid" | "not_evaluated" | "compatible" | "incompatible" =>
  (LAYERS.has(str(value)) ? str(value) : "not_evaluated") as never;

const SEVERITIES = new Set(["info", "warning", "critical"]);
const DECISION_SET = new Set(["deny", "once", "session"]);
const decision = (value: unknown): "deny" | "once" | "session" =>
  (DECISION_SET.has(str(value)) ? str(value) : "deny") as never;

/** Control-plane package summary -> browser package view. */
export function projectPackage(summary: unknown): PackageViewType {
  const source = rec(summary);
  const session = rec(source.session);
  const pkg = rec(source.package);
  const runtime = rec(pkg.runtime);
  const validation = rec(source.validation);
  const publisher = rec(source.publisher);
  const trustEntry = rec(publisher.trust_entry);
  const policy = rec(source.policy);
  const budget = rec(policy.budget);
  const workflow = rec(source.workflow);
  const model = rec(source.model_requirements);
  const snapshot = rec(source.snapshot);
  const sourceInfo = rec(source.source);
  const authorization = rec(source.authorization);

  const nodes = arr(workflow.nodes, LIMITS.nodes);
  const edges = arr(workflow.edges, LIMITS.edges);
  const truncated =
    int(workflow.node_count) > LIMITS.nodes ||
    (Array.isArray(workflow.edges) && workflow.edges.length > LIMITS.edges);

  return {
    sessionId: str(session.id),
    createdAt: str(session.created_at),
    expiresAt: str(session.expires_at),
    ttlSeconds: int(session.ttl_seconds),
    source: { kind: str(sourceInfo.kind, "file"), display: str(sourceInfo.display) },
    snapshot: {
      archiveSha256: str(snapshot.archive_sha256),
      archiveBytes: int(snapshot.archive_bytes),
    },
    identity: {
      packageId: str(pkg.package_id),
      name: str(pkg.name),
      version: str(pkg.version),
      description: str(pkg.description),
      createdAt: str(pkg.created_at),
      digest: str(pkg.digest),
      specVersion: str(pkg.spec_version),
      entrypoint: str(pkg.entrypoint),
      executionProfile: str(pkg.execution_profile),
      runtimeApi: str(runtime.api),
      minimumRuntimeVersion: str(runtime.minimum_version),
    },
    validation: {
      container: layer(validation.container_status),
      integrity: layer(validation.integrity_status),
      schema: layer(validation.schema_status),
      runtime: layer(validation.runtime_status),
      supportedProfiles: strings(validation.supported_execution_profiles, 16),
      errors: arr(validation.errors, 16).map((item) => ({
        layer: str(rec(item).layer),
        message: str(rec(item).message),
      })),
    },
    publisher: {
      claimedId: str(publisher.claimed_id),
      claimedName: str(publisher.claimed_name),
      signatureStatus: (["valid", "invalid", "absent"].includes(str(publisher.signature_status))
        ? str(publisher.signature_status)
        : "absent") as never,
      signatureReason: str(publisher.signature_reason),
      signerFingerprint: nullableStr(publisher.signer_fingerprint),
      signedDigestMatches: bool(publisher.signed_digest_matches),
      trustStatus: (["trusted", "unknown", "mismatch"].includes(str(publisher.trust_status))
        ? str(publisher.trust_status)
        : "unknown") as never,
      trustReason: str(publisher.trust_reason),
      trustEntry:
        publisher.trust_entry === null || publisher.trust_entry === undefined
          ? null
          : {
              fingerprint: str(trustEntry.fingerprint),
              displayName: str(trustEntry.display_name),
              publisherId: nullableStr(trustEntry.publisher_id),
              packageIdPrefix: nullableStr(trustEntry.package_id_prefix),
              addedAt: str(trustEntry.added_at),
            },
      pinnedFingerprintsForClaimedPublisher: strings(
        publisher.pinned_fingerprints_for_claimed_publisher,
        16,
      ),
    },
    capabilities: strings(source.capabilities, LIMITS.capabilities),
    skills: arr(source.skills, LIMITS.skills).map((item) => {
      const skill = rec(item);
      return {
        id: str(skill.id),
        version: str(skill.version),
        path: str(skill.path),
        bytes: int(skill.bytes),
        sha256: str(skill.sha256),
      };
    }),
    tools: arr(source.tools, LIMITS.tools).map((item) => {
      const tool = rec(item);
      return {
        id: str(tool.id),
        version: str(tool.version),
        description: str(tool.description),
        execution: str(tool.execution),
        binding: str(tool.binding),
        endpointOrigin: nullableStr(tool.endpoint_origin),
        method: nullableStr(tool.method),
        domains: strings(tool.domains, LIMITS.domains),
        permissions: strings(tool.permissions, LIMITS.ids),
        sideEffects: str(tool.side_effects),
        approvalRequired: bool(tool.approval_required),
        timeoutSeconds: num(tool.timeout_seconds),
        inputSchema: str(tool.input_schema),
        outputSchema: str(tool.output_schema),
      };
    }),
    workers: arr(source.workers, LIMITS.workers).map((item) => {
      const worker = rec(item);
      const workerBudget = rec(worker.budget);
      return {
        id: str(worker.id),
        kind: str(worker.kind),
        isCoordinator: bool(worker.is_coordinator),
        skills: strings(worker.skills, LIMITS.ids),
        tools: strings(worker.tools, LIMITS.ids),
        maxInstances: int(worker.max_instances),
        stateRead: strings(worker.state_read, LIMITS.ids),
        stateWrite: strings(worker.state_write, LIMITS.ids),
        budgetTokens: int(workerBudget.tokens),
        budgetRemoteCalls: int(workerBudget.remote_calls),
      };
    }),
    workflow: {
      profile: str(workflow.profile, "unknown"),
      coordinator: str(workflow.coordinator),
      deadlineSeconds: nullableNum(workflow.deadline_seconds),
      nodeCount: int(workflow.node_count, int(workflow.stage_count)),
      nodeTypes: Object.entries(rec(workflow.node_types))
        .slice(0, 16)
        .map(([type, count]) => ({ type, count: int(count) })),
      entryNodes: strings(workflow.entry_nodes, LIMITS.nodes),
      outputNodes: strings(workflow.output_nodes, LIMITS.nodes),
      maxDeclaredParallel: int(workflow.max_declared_parallel, 1),
      nodes: nodes.map((item) => {
        const node = rec(item);
        return {
          id: str(node.id),
          type: str(node.type),
          worker: str(node.worker),
          dependsOn: strings(node.depends_on, LIMITS.ids),
          timeoutSeconds: num(node.timeout_seconds),
          writes: strings(node.writes, LIMITS.ids),
          task: nullableStr(node.task),
          tool: nullableStr(node.tool),
          maxParallel: nullableInt(node.max_parallel),
          maxItems: nullableInt(node.max_items),
          steps: arr(node.steps, LIMITS.steps).map((stepItem) => {
            const step = rec(stepItem);
            return {
              id: str(step.id),
              type: str(step.type),
              detail: nullableStr(step.task) ?? nullableStr(step.tool),
            };
          }),
        };
      }),
      edges: edges.map((item) => ({ from: str(rec(item).from), to: str(rec(item).to) })),
      exports: arr(workflow.exports, 32).map((item) => ({
        path: str(rec(item).path),
        format: str(rec(item).format),
      })),
      fixtureDeclared: bool(workflow.fixture_declared),
      truncated,
    },
    evals: arr(source.evals, LIMITS.evals).map((item) => {
      const value = rec(item);
      return {
        id: str(value.id),
        kind: str(value.kind),
        caseCount: int(value.case_count),
        description: nullableStr(value.description),
        verifiedByHost: false as const,
      };
    }),
    attestations: arr(source.attestations, LIMITS.attestations).map((item) => {
      const value = rec(item);
      return {
        path: str(value.path),
        bytes: int(value.bytes),
        sha256: str(value.sha256),
        keys: strings(value.keys, 32),
        verifiedByHost: false as const,
      };
    }),
    modelRequirements: {
      routing: str(model.routing),
      fallbackPolicy: str(model.fallback_policy),
      privacy: nullableStr(model.privacy),
      latencyPreference: nullableStr(model.latency_preference),
      costSensitivity: nullableStr(model.cost_sensitivity),
      tasks: arr(model.tasks, LIMITS.tasks).map((item) => {
        const task = rec(item);
        return {
          id: str(task.id),
          capabilities: strings(task.capabilities, 32),
          contextWindow: int(task.context_window),
          preferredTier: nullableStr(task.preferred_tier),
        };
      }),
    },
    budget: {
      estimatedTokens: int(budget.estimated_tokens),
      hardTokens: int(budget.hard_tokens),
      maxRemoteCalls: int(budget.max_remote_calls),
      maxParallelWorkers: int(budget.max_parallel_workers),
      estimatedCostUsd: nullableNum(budget.estimated_cost_usd),
      approvalThresholdTokens: nullableInt(budget.approval_threshold_tokens),
      maxCallsPerTool: Object.entries(rec(budget.max_calls_per_tool))
        .slice(0, LIMITS.tools)
        .map(([toolId, calls]) => ({ toolId, calls: int(calls) })),
    },
    delegation: {
      maxDepth: int(rec(policy.delegation).max_depth),
      allowRemote: bool(rec(policy.delegation).allow_remote),
      approvedRoles: strings(rec(policy.delegation).approved_roles, LIMITS.workers),
    },
    network: {
      allowedDomains: strings(rec(policy.network).allowed_domains, LIMITS.domains),
      httpsOnly: bool(rec(policy.network).https_only),
      allowRedirects: bool(rec(policy.network).allow_redirects),
    },
    memory: {
      scope: str(rec(policy.memory).scope),
      retention: str(rec(policy.memory).retention),
      rawDocuments: bool(rec(policy.memory).raw_documents),
      sharing: str(rec(policy.memory).sharing),
    },
    payload: {
      fileCount: int(rec(source.payload).file_count),
      totalBytes: int(rec(source.payload).total_bytes),
    },
    warnings: arr(source.warnings, LIMITS.warnings).map((item) => {
      const warning = rec(item);
      return {
        code: str(warning.code),
        severity: (SEVERITIES.has(str(warning.severity)) ? str(warning.severity) : "info") as never,
        message: str(warning.message),
      };
    }),
    authorization: {
      state: (str(authorization.state) === "issued" ? "issued" : "pending") as never,
      receiptId: nullableStr(authorization.receipt_id),
      runnable: bool(authorization.runnable),
    },
    executionPerformed: false as const,
  };
}

export function projectPermissions(request: unknown): PermissionsViewType {
  const source = rec(request);
  const model = rec(source.decision_model);
  const policy = rec(source.browser_policy);
  return {
    sessionId: str(source.session_id),
    packageId: str(source.package_id),
    packageVersion: str(source.package_version),
    packageDigest: str(source.package_digest),
    decisionOptions: strings(model.supported, 8)
      .filter((value) => DECISION_SET.has(value))
      .map((value) => decision(value)),
    unsupportedDecisions: Object.entries(rec(model.unsupported))
      .slice(0, 8)
      .map(([value, reason]) => ({ value, reason: str(reason) })),
    permissions: arr(source.permissions, LIMITS.permissions).map((item) => {
      const permission = rec(item);
      return {
        id: str(permission.id),
        kind: str(permission.kind),
        description: str(permission.description),
        required: bool(permission.required),
        resources: strings(permission.resources, LIMITS.domains),
        decision: decision(permission.decision),
        linkedTools: strings(permission.linked_tools, LIMITS.tools),
        linkedDomains: strings(permission.linked_domains, LIMITS.domains),
      };
    }),
    toolApprovals: arr(source.tool_approvals, LIMITS.toolApprovals).map((item) => {
      const approval = rec(item);
      return {
        toolId: str(approval.tool_id),
        approvalRequired: bool(approval.approval_required),
        sideEffects: str(approval.side_effects),
        decision: bool(approval.decision),
      };
    }),
    blockingReasons: projectBlocking(source.blocking_reasons),
    browserPolicy: {
      requireValidSignature: bool(policy.require_valid_signature),
      requireTrustedPublisher: bool(policy.require_trusted_publisher),
      requireSupportedProfile: bool(policy.require_supported_profile),
    },
  };
}

function projectBlocking(value: unknown) {
  return arr(value, LIMITS.blockingReasons).map((item) => {
    const reason = rec(item);
    return {
      code: str(reason.code),
      message: str(reason.message),
      subject: nullableStr(reason.subject),
    };
  });
}

export function projectReceipt(receipt: unknown): ReceiptViewType {
  const source = rec(receipt);
  const pkg = rec(source.package);
  const publisher = rec(source.publisher);
  const trustStore = rec(source.trust_store);
  return {
    receiptId: str(source.receipt_id),
    issuedAt: str(source.issued_at),
    expiresAt: str(source.expires_at),
    sessionId: str(source.session_id),
    packageId: str(pkg.package_id),
    packageName: str(pkg.name),
    packageVersion: str(pkg.version),
    packageDigest: str(pkg.digest),
    archiveSha256: str(pkg.archive_sha256),
    executionProfile: str(pkg.execution_profile),
    publisher: {
      claimedId: str(publisher.claimed_id),
      claimedName: str(publisher.claimed_name),
      signerFingerprint: nullableStr(publisher.signer_fingerprint),
      signatureStatus: str(publisher.signature_status),
      trustStatus: str(publisher.trust_status),
      trustReason: str(publisher.trust_reason),
    },
    trustStore: {
      entryCount: int(trustStore.entry_count),
      stateSha256: str(trustStore.state_sha256),
    },
    decisions: Object.entries(rec(source.decisions))
      .slice(0, LIMITS.permissions)
      .map(([permissionId, value]) => ({ permissionId, decision: decision(value) })),
    toolApprovals: Object.entries(rec(source.tool_approvals))
      .slice(0, LIMITS.toolApprovals)
      .map(([toolId, approved]) => ({ toolId, approved: bool(approved) })),
    grantedPermissionIds: strings(source.granted_permission_ids, LIMITS.permissions),
    runnable: bool(source.runnable),
    blockingReasons: projectBlocking(source.blocking_reasons),
    receiptSha256: str(source.receipt_sha256),
    executionPerformed: false as const,
  };
}

export function projectSessions(list: unknown) {
  const source = rec(list);
  return {
    sessions: arr(source.sessions, LIMITS.sessions).map((item) => {
      const session = rec(item);
      const authorization = rec(session.authorization);
      const sessionSource = rec(session.source);
      return {
        sessionId: str(session.session_id),
        packageId: str(session.package_id),
        name: str(session.package_id),
        version: str(session.version),
        digest: str(session.digest),
        expiresAt: str(session.expires_at),
        source: { kind: str(sessionSource.kind, "file"), display: str(sessionSource.display) },
        signatureStatus: str(session.signature_status),
        trustStatus: str(session.trust_status),
        authorizationState: str(authorization.state, "pending"),
        runnable: bool(authorization.runnable),
      };
    }),
    max: int(source.max_sessions),
  };
}

export function projectTrust(list: unknown) {
  const source = rec(list);
  return {
    publishers: arr(source.publishers, LIMITS.publishers).map((item) => {
      const entry = rec(item);
      return {
        fingerprint: str(entry.fingerprint),
        displayName: str(entry.display_name),
        publisherId: nullableStr(entry.publisher_id),
        packageIdPrefix: nullableStr(entry.package_id_prefix),
        notes: nullableStr(entry.notes),
        addedAt: str(entry.added_at),
      };
    }),
  };
}

export function projectTrustEntry(entry: unknown) {
  const value = rec(entry);
  return {
    fingerprint: str(value.fingerprint),
    displayName: str(value.display_name),
    publisherId: nullableStr(value.publisher_id),
    packageIdPrefix: nullableStr(value.package_id_prefix),
    notes: nullableStr(value.notes),
    addedAt: str(value.added_at),
  };
}

export function projectPublisher(publisher: unknown): PackageViewType["publisher"] {
  return projectPackage({ publisher }).publisher;
}
