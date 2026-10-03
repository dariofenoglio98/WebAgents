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
import {
  LIMITS,
  TOOL_BINDING_STATUSES,
  type HostToolBindingViewType,
  type InputValidationViewType,
  type ModelCatalogViewType,
  type PackageViewType,
  type PermissionsViewType,
  type PresentationViewType,
  type ReceiptViewType,
  type RunPlanStateViewType,
  type RunPlanViewType,
  type TaskInputViewType,
  type ToolRegistryViewType,
  type WebsiteDiscoveryViewType,
} from "./contract.js";
import { AgentBrowserError } from "./errors.js";
import { BUDGETS, fitsJson } from "./json-limits.js";

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

/** The largest task input schema the page is given to render a form from (see `BUDGETS.inputSchema`). */
export const MAX_INPUT_SCHEMA_BYTES = BUDGETS.inputSchema.maxSerializedBytes;

const clipText = (value: unknown, max: number): string | null => {
  const text = str(value);
  return text ? (text.length > max ? `${text.slice(0, max - 1)}…` : text) : null;
};

/** The package's task input contract, bounded again on this side. */
export function projectTaskInput(value: unknown): TaskInputViewType {
  const source = rec(value);
  let document: unknown = source.document ?? null;
  let note = str(source.note);
  // A form needs the whole schema, and the package view that carries it must
  // stay inside the host's JSON limits: a schema too large *or* too intricate
  // for its budget is left out, and the task is edited as JSON instead.
  if (document !== null && !fitsJson(document, BUDGETS.inputSchema)) {
    document = null;
    note = "The input schema is too large to render as a form; edit the task as JSON.";
  }
  return {
    schemaPath: nullableStr(source.schema_path),
    schemaSha256: nullableStr(source.schema_sha256),
    bytes: Math.max(0, int(source.bytes)),
    document,
    note: note.slice(0, LIMITS.text),
  };
}

const WIDGET_SET = new Set(["multiline", "selected_files"]);
const GROUP_SET = new Set(["primary", "optional", "advanced"]);

/** Validated presentation hints -> the bounded view. Cosmetic only. */
export function projectPresentation(value: unknown): PresentationViewType | null {
  if (value === null || value === undefined) return null;
  const source = rec(value);
  const task = rec(source.task);
  const result = rec(source.result);
  return {
    task: {
      prompt: clipText(task.prompt, LIMITS.shortText),
      runLabel: clipText(task.run_label, 64),
      runningLabel: clipText(task.running_label, 128),
      completedLabel: clipText(task.completed_label, 128),
    },
    input: Object.entries(rec(source.input))
      .slice(0, 64)
      .map(([field, raw]) => {
        const hint = rec(raw);
        return {
          field: field.slice(0, 200),
          widget: WIDGET_SET.has(str(hint.widget)) ? (str(hint.widget) as never) : null,
          group: GROUP_SET.has(str(hint.group)) ? (str(hint.group) as never) : null,
          label: clipText(hint.label, 128),
          placeholder: clipText(hint.placeholder, LIMITS.shortText),
          rows:
            typeof hint.rows === "number" && Number.isInteger(hint.rows) && hint.rows >= 1 && hint.rows <= 12
              ? hint.rows
              : null,
          itemPlaceholder: clipText(hint.item_placeholder, LIMITS.shortText),
          keyLabel: clipText(hint.key_label, 128),
          keyPlaceholder: clipText(hint.key_placeholder, LIMITS.shortText),
        };
      }),
    nodes: Object.entries(rec(source.nodes))
      .slice(0, LIMITS.nodes)
      .map(([nodeId, label]) => ({ nodeId: nodeId.slice(0, 200), label: str(label).slice(0, 128) }))
      .filter((item) => item.label.length > 0),
    stages: arr(source.stages, 32).map((item) => {
      const stage = rec(item);
      return { label: str(stage.label).slice(0, 128), nodes: strings(stage.nodes, LIMITS.nodes) };
    }),
    result: {
      primaryExport: nullableStr(result.primary_export),
      summary: arr(result.summary, 8).map((item) => ({
        label: str(rec(item).label).slice(0, 128),
        export: str(rec(item).export).slice(0, 256),
      })),
    },
  };
}

/** The control plane's verdict on one proposed task. */
export function projectInputValidation(value: unknown, sessionId: string): InputValidationViewType {
  const source = rec(value);
  return {
    sessionId,
    schemaPath: nullableStr(source.schema_path),
    valid: bool(source.valid),
    errors: arr(source.errors, 16).map((item) => ({
      pointer: str(rec(item).pointer).slice(0, 1024),
      rule: str(rec(item).rule).slice(0, 64),
      message: str(rec(item).message).slice(0, LIMITS.shortText),
    })),
    errorCount: Math.max(0, int(source.error_count)),
    inputSha256: nullableStr(source.input_sha256),
    inputBytes: Math.max(0, int(source.input_bytes)),
  };
}

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
      input: projectTaskInput(workflow.input),
      presentation: projectPresentation(workflow.presentation),
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

// -- website discovery -------------------------------------------------------
const MAX_CANDIDATES = 16;
const text = (value: unknown, max: number): string => {
  const value_ = str(value);
  return value_.length > max ? `${value_.slice(0, max - 1)}…` : value_;
};
const nullableText = (value: unknown, max: number): string | null =>
  typeof value === "string" ? text(value, max) : null;

function unexpectedDiscovery(detail: string): AgentBrowserError {
  return new AgentBrowserError("control_plane_error", "Unexpected discovery result", detail);
}

/**
 * What one web page advertises, bounded for the page.
 *
 * Every verdict is the control plane's. Two facts are checked rather than
 * merely copied, and a result that contradicts them is refused instead of
 * shown: discovery never verified, trusted, authorized, fetched or ran
 * anything, and an accepted candidate's URL reaches the page exactly as the
 * control plane resolved it, because that is what Inspect will open.
 */
export function projectDiscovery(value: unknown): WebsiteDiscoveryViewType {
  const source = rec(value);
  const page = rec(source.page);
  const profile = rec(source.profile);
  const trust = rec(source.trust);
  const execution = rec(source.execution);
  const claims = [
    trust.package_verified,
    trust.publisher_trusted,
    trust.permissions_granted,
    execution.package_fetched,
    execution.performed,
  ];
  if (claims.some((claim) => claim !== false)) {
    throw unexpectedDiscovery(
      "The control plane described an advertised package as more than an untrusted location.",
    );
  }
  const listed = Array.isArray(source.candidates) ? source.candidates : [];
  const candidates = listed.slice(0, MAX_CANDIDATES).map((item) => {
    const candidate = rec(item);
    const accepted = bool(candidate.accepted);
    const resolvedUrl = nullableText(candidate.resolved_url, 2048);
    if (accepted && (resolvedUrl === null || resolvedUrl !== candidate.resolved_url)) {
      throw unexpectedDiscovery("An accepted candidate has no usable address.");
    }
    return {
      index: Math.max(0, int(candidate.index)),
      href: nullableText(candidate.href, 2048),
      typeHint: nullableText(candidate.type_hint, 128),
      resolvedUrl,
      sameOrigin: typeof candidate.same_origin === "boolean" ? candidate.same_origin : null,
      accepted,
      rejectionReason: nullableText(candidate.rejection_reason, 64),
      rejectionMessage: nullableText(candidate.rejection_message, 1024),
    };
  });
  return {
    requestedUrl: text(source.requested_url, 2048),
    finalUrl: text(source.final_url, 2048),
    pageOrigin: text(source.page_origin, 512),
    redirects: arr(source.redirects, 5).map((item) => {
      const hop = rec(item);
      return {
        status: int(hop.status),
        fromUrl: text(hop.from_url, 2048),
        toUrl: text(hop.to_url, 2048),
      };
    }),
    // Copied as given; the contract's own schema refuses any other value.
    status: str(source.discovery_status) as WebsiteDiscoveryViewType["status"],
    candidates,
    acceptedCount: Math.max(0, int(source.accepted_count)),
    rejectedCount: Math.max(0, int(source.rejected_count)),
    linksNotListed:
      Math.max(0, int(source.links_not_listed)) + Math.max(0, listed.length - candidates.length),
    page: {
      contentType: text(page.content_type, 128),
      declaredCharset: nullableText(page.declared_charset, 128),
      decodedAs: text(page.decoded_as, 32),
      encodingSource: text(page.encoding_source, 16),
      contentCoding: text(page.content_coding, 16),
      bytesRead: Math.max(0, int(page.bytes_read)),
      truncated: bool(page.truncated),
      headEnded: bool(page.head_ended),
      htmlSha256: text(page.html_sha256, 64),
      baseElementIgnored: bool(page.base_element_ignored),
    },
    profile: {
      name: text(profile.name, 64),
      rel: text(profile.rel, 64),
      mediaType: text(profile.media_type, 128),
      sameOriginRequired: bool(profile.same_origin_required),
      maxRedirects: Math.max(0, int(profile.max_redirects)),
      maxHtmlBytes: Math.max(0, int(profile.max_html_bytes)),
    },
    discoveredAt: text(source.discovered_at, 64),
    packageVerified: false,
    publisherTrusted: false,
    permissionsGranted: false,
    packageFetched: false,
    executionPerformed: false,
  };
}

// -- models and run plans ----------------------------------------------------
const COMPAT = new Set(["compatible", "unverified", "incompatible"]);
const compatibility = (value: unknown): "compatible" | "unverified" | "incompatible" =>
  (COMPAT.has(str(value)) ? str(value) : "unverified") as never;

const BASES = new Set(["declared", "host_default", "derived", "absent"]);
const basis = (value: unknown) => (BASES.has(str(value)) ? str(value) : "absent") as never;

const CHECK_STATUS = new Set(["satisfied", "violated", "unknown"]);
const checkStatus = (value: unknown) =>
  (CHECK_STATUS.has(str(value)) ? str(value) : "unknown") as never;

/** Boolean-or-integer-or-null, the only shapes a requirement value takes. */
const scalar = (value: unknown): boolean | number | null => {
  if (typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return Math.trunc(value);
  return null;
};

function projectCheck(item: unknown) {
  const check = rec(item);
  return {
    id: str(check.id),
    kind: str(check.kind),
    subject: str(check.subject),
    operator: str(check.operator),
    required: scalar(check.value),
    hostValue: scalar(check.host_value),
    status: checkStatus(check.status),
    basis: basis(check.basis),
    source: str(check.source),
    detail: nullableStr(check.detail),
    tasks: strings(check.tasks, LIMITS.tasks),
  };
}

function projectRequirements(value: unknown) {
  const requirements = rec(value);
  return {
    routing: str(requirements.routing),
    fallbackPolicy: str(requirements.fallback_policy),
    privacy: nullableStr(requirements.privacy),
    bindingStrategy: str(requirements.binding_strategy, "single_model"),
    hardRequirements: arr(requirements.hard_requirements, LIMITS.checks).map((item) => {
      const requirement = rec(item);
      return {
        id: str(requirement.id),
        kind: str(requirement.kind),
        subject: str(requirement.subject),
        operator: str(requirement.operator),
        required: scalar(requirement.value),
        tasks: strings(requirement.tasks, LIMITS.tasks),
      };
    }),
    preferences: arr(requirements.preferences, LIMITS.preferences).map((item) => {
      const preference = rec(item);
      return {
        id: str(preference.id),
        kind: str(preference.kind),
        subject: str(preference.subject),
      };
    }),
  };
}

function projectModel(item: unknown) {
  const model = rec(item);
  const limits = rec(model.limits);
  const properties = rec(model.properties);
  return {
    modelId: str(model.model_id),
    providerId: str(model.provider_id),
    displayName: str(model.display_name),
    available: bool(model.available),
    availabilityReason: nullableStr(model.availability_reason),
    selectable: bool(model.selectable),
    status: compatibility(model.status),
    selectableForRunPlan: bool(model.selectable_for_run_plan),
    evidenceStrength: (["declared", "host_default", "derived", "none"].includes(
      str(model.evidence_strength),
    )
      ? str(model.evidence_strength)
      : "none") as never,
    contextTokens: nullableInt(limits.context_tokens),
    nativeContextWindow: nullableInt(limits.native_context_window),
    local: typeof properties.local === "boolean" ? properties.local : null,
    tags: strings(properties.tags, 16),
    capabilities: Object.entries(rec(model.capabilities))
      .slice(0, LIMITS.capabilities_reported)
      .map(([name, value]) => {
        const answer = rec(value);
        return {
          name,
          value: typeof answer.value === "boolean" ? answer.value : null,
          basis: basis(answer.basis),
          detail: nullableStr(answer.detail),
        };
      }),
    checks: arr(model.checks, LIMITS.checks).map(projectCheck),
    satisfied: strings(model.satisfied, LIMITS.checks),
    unknown: strings(model.unknown, LIMITS.checks),
    violated: strings(model.violated, LIMITS.checks),
  };
}

/** Control-plane evaluation -> the catalog the page renders. */
export function projectEvaluation(
  evaluation: unknown,
  extra: {
    sessionId: string;
    host: Record<string, unknown>;
    executionModePermissionIds: string[];
    executionModePermissionsGranted: boolean;
    authorized: boolean;
  },
): ModelCatalogViewType {
  const source = rec(evaluation);
  const counts = rec(source.counts);
  const catalog = rec(source.catalog);
  const host = rec(extra.host);
  return fitCatalog({
    sessionId: extra.sessionId,
    packageDigest: str(source.package_digest),
    host: {
      runtime: str(host.runtime),
      runtimeVersion: nullableStr(host.runtime_version),
      source: str(host.source),
      capturedAt: str(host.captured_at),
      agentId: nullableStr(host.agent_id),
    },
    catalogSha256: str(catalog.catalog_sha256),
    requirements: projectRequirements(source.requirements),
    models: arr(source.models, LIMITS.models).map(projectModel),
    counts: {
      total: int(counts.total),
      available: int(counts.available),
      selectable: int(counts.selectable),
      compatible: int(counts.compatible),
      unverified: int(counts.unverified),
      incompatible: int(counts.incompatible),
    },
    notes: arr(source.notes, LIMITS.notes).map((item) => ({
      code: str(rec(item).code),
      detail: nullableStr(rec(item).detail),
    })),
    executionModePermissionIds: extra.executionModePermissionIds.slice(0, LIMITS.permissions),
    executionModePermissionsGranted: extra.executionModePermissionsGranted,
    authorized: extra.authorized,
  });
}

const MODEL_RANK: Record<string, number> = { compatible: 1, unverified: 2, incompatible: 3 };

/**
 * A catalog the host can carry in one answer.
 *
 * Each model's detail is about a hundred JSON nodes, so a host reporting a few
 * dozen models would exceed the host's own output limit and the whole Model
 * section would fail. Every model is still counted; when the details do not
 * fit, the page gets the ones a plan could use first — selectable for a run
 * plan, then compatible, unverified, incompatible, each in the host's order —
 * and a note saying how many are not listed. A catalog that fits is unchanged.
 */
export function fitCatalog(view: ModelCatalogViewType): ModelCatalogViewType {
  const carried = (candidate: ModelCatalogViewType) => fitsJson({ ok: true, value: candidate });
  if (carried(view)) return view;
  const rank = (model: ModelCatalogViewType["models"][number]) =>
    model.selectableForRunPlan ? 0 : (MODEL_RANK[model.status] ?? 4);
  const ordered = [...view.models].sort((left, right) => rank(left) - rank(right));
  const listing = (count: number): ModelCatalogViewType => ({
    ...view,
    models: ordered.slice(0, count),
    notes: [
      {
        code: "models_not_listed",
        detail:
          `${ordered.length - count} of the ${ordered.length} models this host reports are not listed: ` +
          "their details do not fit one answer. Models a run plan could use are listed first.",
      },
      ...view.notes,
    ].slice(0, LIMITS.notes),
  });
  let low = 0;
  let high = ordered.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (carried(listing(middle))) low = middle;
    else high = middle - 1;
  }
  return listing(low);
}

export function projectRunPlan(plan: unknown): RunPlanViewType {
  const source = rec(plan);
  const pkg = rec(source.package);
  const publisher = rec(source.publisher);
  const authorization = rec(source.authorization);
  const execution = rec(source.execution);
  const binding = rec(source.model_binding);
  const compat = rec(binding.compatibility);
  const catalog = rec(binding.catalog);
  const descriptor = rec(binding.descriptor);
  const limits = rec(descriptor.limits);
  const readiness = rec(source.readiness);
  return {
    runPlanId: str(source.run_plan_id),
    runPlanVersion: str(source.run_plan_version),
    runPlanSha256: str(source.run_plan_sha256),
    createdAt: str(source.created_at),
    expiresAt: str(source.expires_at),
    sessionId: str(source.session_id),
    package: {
      packageId: str(pkg.package_id),
      name: str(pkg.name),
      version: str(pkg.version),
      digest: str(pkg.digest),
      archiveSha256: str(pkg.archive_sha256),
      executionProfile: str(pkg.execution_profile),
    },
    publisher: {
      claimedId: str(publisher.claimed_id),
      claimedName: str(publisher.claimed_name),
      signerFingerprint: nullableStr(publisher.signer_fingerprint),
      signatureStatus: str(publisher.signature_status),
      trustStatus: str(publisher.trust_status),
      trustReason: str(publisher.trust_reason),
    },
    authorization: {
      receiptId: str(authorization.receipt_id),
      receiptSha256: str(authorization.receipt_sha256),
      issuedAt: str(authorization.issued_at),
      expiresAt: str(authorization.expires_at),
      grantedPermissionIds: strings(authorization.granted_permission_ids, LIMITS.permissions),
    },
    execution: {
      profile: str(execution.profile),
      mode: str(execution.mode),
      bindingStrategy: str(execution.binding_strategy),
      requiredPermissionIds: strings(execution.required_permission_ids, LIMITS.permissions),
      probeToolId: nullableStr(execution.probe_tool_id),
      performed: false as const,
      note: str(execution.note),
    },
    modelBinding: source.model_binding
      ? {
          hostModelId: str(binding.host_model_id),
          providerId: str(binding.provider_id),
          displayName: str(binding.display_name),
          selectedAt: str(binding.selected_at),
          compatibilityStatus: compatibility(compat.status),
          evidenceStrength: str(compat.evidence_strength, "none"),
          contextTokens: nullableInt(limits.context_tokens),
          catalogSha256: str(catalog.catalog_sha256),
          catalogModelCount: int(catalog.model_count),
          checks: arr(compat.checks, LIMITS.checks).map(projectCheck),
        }
      : null,
    requirements: projectRequirements(source.model_requirements),
    toolBindings: arr(source.tool_bindings, LIMITS.tools).map((entry) => {
      const bound = rec(entry);
      return {
        toolId: str(bound.tool_id),
        bindingId: str(bound.binding_id),
        bindingSha256: str(bound.binding_sha256),
        implementationKind: str(bound.implementation_kind),
        implementationVersion: nullableStr(bound.implementation_version),
        displayName: nullableStr(bound.display_name),
        remote: bool(bound.remote),
        endpointOrigin: nullableStr(bound.endpoint_origin),
        endpointPath: nullableStr(bound.endpoint_path),
        method: nullableStr(bound.method),
        contractSha256: str(bound.contract_sha256),
        requiredPermissionIds: strings(bound.required_permission_ids, LIMITS.ids),
        timeoutSeconds: nullableInt(bound.timeout_seconds),
        maxCalls: nullableInt(bound.max_calls),
        credentialsRequired: bool(bound.credentials_required),
        credentialsConfigured: bool(bound.credentials_configured),
        approved: true as const,
        usable: bound.usable !== false,
      };
    }),
    toolRegistry: source.tool_registry
      ? {
          registrySha256: str(rec(source.tool_registry).registry_sha256),
          bindingCount: int(rec(source.tool_registry).binding_count),
        }
      : null,
    readiness: {
      state: str(readiness.state),
      ready: bool(readiness.ready),
      blockingReasons: projectBlocking(readiness.blocking_reasons),
    },
  };
}

/** What this host offers for each declared tool, as the page renders it. */
export function projectToolRegistry(
  evaluation: unknown,
  extra: { sessionId: string; authorized: boolean },
): ToolRegistryViewType {
  const source = rec(evaluation);
  const registry = rec(source.registry);
  const host = rec(registry.host);
  const counts = rec(source.counts);
  return {
    sessionId: extra.sessionId,
    packageDigest: str(source.package_digest),
    host: {
      runtime: str(host.runtime),
      runtimeVersion: nullableStr(host.runtime_version),
      source: str(host.source),
      capturedAt: str(host.captured_at),
    },
    registrySha256: str(registry.registry_sha256),
    bindingCount: int(registry.binding_count),
    tools: arr(source.tools, LIMITS.tools).map((entry) => {
      const tool = rec(entry);
      const binding = rec(tool.binding);
      return {
        toolId: str(tool.tool_id),
        bindingName: str(tool.binding_name),
        status: toolStatus(tool.status),
        reason: nullableStr(tool.reason),
        required: bool(tool.required),
        remote: bool(tool.remote),
        sideEffects: str(tool.side_effects),
        declaredDomains: strings(tool.declared_domains, LIMITS.domains),
        permissionIds: strings(tool.permission_ids, LIMITS.ids),
        approved: bool(tool.approved),
        permissionsGranted: bool(tool.permissions_granted),
        deniedPermissionIds: strings(tool.denied_permission_ids, LIMITS.ids),
        usable: bool(tool.usable),
        blocksPlan: bool(tool.blocks_plan),
        binding: tool.binding
          ? {
              bindingId: str(binding.binding_id),
              bindingSha256: str(binding.binding_sha256),
              implementationKind: str(binding.implementation_kind),
              implementationVersion: str(binding.implementation_version),
              displayName: str(binding.display_name),
              available: bool(binding.available),
              availabilityReason: nullableStr(binding.availability_reason),
              endpointOrigin: nullableStr(binding.endpoint_origin),
              endpointPath: nullableStr(binding.endpoint_path),
              method: nullableStr(binding.method),
              timeoutSeconds: nullableInt(binding.timeout_seconds),
              credentialsRequired: bool(binding.credentials_required),
              credentialsConfigured: bool(binding.credentials_configured),
              checks: arr(binding.checks, LIMITS.checks).map((item) => {
                const check = rec(item);
                return {
                  id: str(check.id),
                  subject: str(check.subject),
                  status: toolCheckStatus(check.status),
                  detail: nullableStr(check.detail),
                };
              }),
            }
          : null,
      };
    }),
    counts: {
      total: int(counts.total),
      bound: int(counts.bound),
      unbound: int(counts.unbound),
      incompatible: int(counts.incompatible),
      unverified: int(counts.unverified),
      unavailable: int(counts.unavailable),
      approved: int(counts.approved),
      usable: int(counts.usable),
      blocking: int(counts.blocking),
    },
    allToolsBound: bool(source.all_tools_bound),
    allToolsUsable: bool(source.all_tools_usable),
    notes: arr(source.notes, LIMITS.notes).map((item) => ({
      code: str(rec(item).code),
      detail: nullableStr(rec(item).detail),
    })),
    authorized: extra.authorized,
  };
}

function toolStatus(value: unknown): HostToolBindingViewType["status"] {
  const text = str(value);
  return (TOOL_BINDING_STATUSES as readonly string[]).includes(text)
    ? (text as HostToolBindingViewType["status"])
    : "unbound";
}

function toolCheckStatus(value: unknown): "satisfied" | "violated" | "unknown" {
  const text = str(value);
  return text === "satisfied" || text === "violated" ? text : "unknown";
}

export function projectRunPlanState(
  payload: unknown,
  modelStillAvailable: boolean | null,
  executionSupported = false,
): RunPlanStateViewType {
  const source = rec(payload);
  if (!source.run_plan) {
    return { plan: null, preflight: null, executionSupported };
  }
  const preflight = rec(source.preflight);
  return {
    plan: projectRunPlan(source.run_plan),
    preflight: {
      checkedAt: str(preflight.checked_at),
      state: str(preflight.state),
      // A model that vanished from the host catalog is not ready, whatever the
      // control plane concluded about the parts it can see.
      ready: bool(preflight.ready) && modelStillAvailable !== false,
      stale: bool(preflight.stale) || modelStillAvailable === false,
      staleReasons: [
        ...projectBlocking(preflight.stale_reasons),
        ...(modelStillAvailable === false
          ? [
              {
                code: "model_no_longer_available",
                message: "The selected model is no longer offered by this OpenClaw host.",
                subject: null,
              },
            ]
          : []),
      ].slice(0, LIMITS.blockingReasons),
      blockingReasons: projectBlocking(preflight.blocking_reasons),
      trustStoreChanged: bool(preflight.trust_store_changed),
      modelStillAvailable,
      toolBindingsCurrent: rec(preflight.tool_bindings).current !== false,
      toolBindingsBound: int(rec(preflight.tool_bindings).bound),
    },
    // A host that can run model-backed plans, and a plan of that kind.
    executionSupported:
      executionSupported && str(rec(rec(source.run_plan).execution).mode) === "model",
  };
}
