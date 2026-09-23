/**
 * The typed boundary between the Agent Browser page and its plugin backend.
 *
 * Two rules shape every schema here:
 *
 * 1. the browser receives a *projection*, never a pass-through of whatever the
 *    control plane returned, so nothing can leak by accident and every list is
 *    bounded on both sides;
 * 2. failures the UI must branch on are returned as typed results with stable
 *    codes, because the feature transport reduces a thrown error to a string.
 *
 * The control plane (agentpkgd) stays authoritative for validation, signature
 * checking, publisher trust, authorization and URL policy. Nothing in this file
 * or its implementations recomputes any of that.
 */
import { defineFeatureContract } from "openclaw/plugin-sdk/feature-contract";
import { Type } from "typebox";
import type { Static, TSchema } from "typebox";

export const PLUGIN_ID = "agent-browser";

/** UI-facing list bounds. The control plane has its own, lower limits. */
export const LIMITS = {
  capabilities: 64,
  skills: 64,
  tools: 64,
  workers: 64,
  nodes: 128,
  edges: 512,
  steps: 32,
  evals: 32,
  attestations: 32,
  warnings: 64,
  permissions: 64,
  toolApprovals: 64,
  blockingReasons: 64,
  sessions: 32,
  publishers: 128,
  tasks: 32,
  models: 128,
  capabilities_reported: 32,
  checks: 32,
  preferences: 16,
  notes: 16,
  domains: 32,
  ids: 64,
  text: 4096,
  shortText: 512,
} as const;

const Text = (maxLength: number = LIMITS.shortText) => Type.String({ maxLength });
const Id = () => Type.String({ maxLength: 200 });
const Nullable = <T extends TSchema>(schema: T) => Type.Union([schema, Type.Null()]);
const Obj = <T extends Record<string, TSchema>>(properties: T) =>
  Type.Object(properties, { additionalProperties: false });

/** Stable failure categories. The UI branches on `code`, never on prose. */
export const ERROR_CODES = [
  "service_unavailable",
  "service_start_failed",
  "invalid_request",
  "not_allowed",
  "url_rejected",
  "download_failed",
  "package_rejected",
  "source_rejected",
  "session_expired",
  "digest_mismatch",
  "trust_conflict",
  "signature_not_valid",
  "limit_reached",
  "control_plane_error",
  "model_catalog_unavailable",
  "model_unknown",
  "run_plan_refused",
  "run_plan_absent",
  "run_plan_stale",
  "probe_refused",
  "selected_model_unavailable",
  "model_call_not_authorized",
  "model_call_failed",
  "model_call_cancelled",
  "bridge_unavailable",
  "bridge_protocol_error",
  "bridge_timeout",
  "bridge_failed",
  "authorization_expiring",
  "execution_refused",
  "execution_active",
  "execution_unknown",
] as const;

export const FeatureError = Obj({
  code: Type.Union([
    Type.Literal("service_unavailable"),
    Type.Literal("service_start_failed"),
    Type.Literal("invalid_request"),
    Type.Literal("not_allowed"),
    Type.Literal("url_rejected"),
    Type.Literal("download_failed"),
    Type.Literal("package_rejected"),
    Type.Literal("source_rejected"),
    Type.Literal("session_expired"),
    Type.Literal("digest_mismatch"),
    Type.Literal("trust_conflict"),
    Type.Literal("signature_not_valid"),
    Type.Literal("limit_reached"),
    Type.Literal("control_plane_error"),
    Type.Literal("model_catalog_unavailable"),
    Type.Literal("model_unknown"),
    Type.Literal("run_plan_refused"),
    Type.Literal("run_plan_absent"),
    Type.Literal("run_plan_stale"),
    Type.Literal("probe_refused"),
    Type.Literal("selected_model_unavailable"),
    Type.Literal("model_call_not_authorized"),
    Type.Literal("model_call_failed"),
    Type.Literal("model_call_cancelled"),
    Type.Literal("bridge_unavailable"),
    Type.Literal("bridge_protocol_error"),
    Type.Literal("bridge_timeout"),
    Type.Literal("bridge_failed"),
    Type.Literal("authorization_expiring"),
    Type.Literal("execution_refused"),
    Type.Literal("execution_active"),
    Type.Literal("execution_unknown"),
  ]),
  /** Short human title for the UI heading. */
  title: Text(200),
  /** Explanation from the control plane, already free of internals. */
  detail: Text(LIMITS.text),
  retryable: Type.Boolean(),
  /** Layered validation, present when a package was structurally rejected. */
  validation: Type.Optional(Nullable(Type.Any())),
});
export type FeatureErrorView = Static<typeof FeatureError>;

const Result = <T extends TSchema>(value: T) =>
  Type.Union([
    Obj({ ok: Type.Literal(true), value }),
    Obj({ ok: Type.Literal(false), error: FeatureError }),
  ]);

// -- service ----------------------------------------------------------------
export const SERVICE_STATES = ["starting", "running", "stopped", "failed", "unconfigured"] as const;

export const ServiceStatus = Obj({
  state: Type.Union([
    Type.Literal("starting"),
    Type.Literal("running"),
    Type.Literal("stopped"),
    Type.Literal("failed"),
    Type.Literal("unconfigured"),
  ]),
  detail: Text(LIMITS.text),
  /** ISO timestamp of the current state, when known. */
  since: Nullable(Text(64)),
  starts: Type.Integer({ minimum: 0 }),
  controlPlane: Nullable(
    Obj({
      apiVersion: Text(32),
      agentpkgVersion: Text(32),
      packageFormat: Text(64),
      execution: Text(32),
    }),
  ),
  sessions: Nullable(
    Obj({ open: Type.Integer({ minimum: 0 }), max: Type.Integer({ minimum: 0 }) }),
  ),
  /** What this host currently allows the page to offer. */
  capabilities: Obj({
    openUrl: Type.Boolean(),
    openLocal: Type.Boolean(),
    localRoots: Type.Array(Text(1024), { maxItems: 8 }),
    trustPinning: Type.Boolean(),
  }),
  /**
   * Whether this *page* offers a Run action. Always false.
   *
   * Execution itself exists behind operator-only operations (`execution.*`),
   * which the Control UI deliberately does not call. The two facts are kept in
   * separate fields so neither can be read as the other.
   */
  executionSupported: Type.Literal(false),
  /** Whether the operator-only execution operations can run a package here. */
  executionOperations: Type.Optional(Type.Boolean()),
});
export type ServiceStatusView = Static<typeof ServiceStatus>;

// -- package view -----------------------------------------------------------
export const LAYER_STATUS = [
  "valid",
  "invalid",
  "not_evaluated",
  "compatible",
  "incompatible",
] as const;
const LayerStatus = () =>
  Type.Union([
    Type.Literal("valid"),
    Type.Literal("invalid"),
    Type.Literal("not_evaluated"),
    Type.Literal("compatible"),
    Type.Literal("incompatible"),
  ]);

const Validation = Obj({
  container: LayerStatus(),
  integrity: LayerStatus(),
  schema: LayerStatus(),
  runtime: LayerStatus(),
  supportedProfiles: Type.Array(Text(64), { maxItems: 16 }),
  errors: Type.Array(Obj({ layer: Text(32), message: Text(LIMITS.text) }), { maxItems: 16 }),
});

const Publisher = Obj({
  claimedId: Text(200),
  claimedName: Text(200),
  signatureStatus: Type.Union([
    Type.Literal("valid"),
    Type.Literal("invalid"),
    Type.Literal("absent"),
  ]),
  signatureReason: Text(LIMITS.text),
  signerFingerprint: Nullable(Text(128)),
  signedDigestMatches: Type.Boolean(),
  trustStatus: Type.Union([
    Type.Literal("trusted"),
    Type.Literal("unknown"),
    Type.Literal("mismatch"),
  ]),
  trustReason: Text(200),
  trustEntry: Nullable(
    Obj({
      fingerprint: Text(128),
      displayName: Text(200),
      publisherId: Nullable(Text(200)),
      packageIdPrefix: Nullable(Text(200)),
      addedAt: Text(64),
    }),
  ),
  pinnedFingerprintsForClaimedPublisher: Type.Array(Text(128), { maxItems: 16 }),
});

const Tool = Obj({
  id: Id(),
  version: Text(64),
  description: Text(LIMITS.text),
  execution: Text(32),
  binding: Text(200),
  endpointOrigin: Nullable(Text(512)),
  method: Nullable(Text(16)),
  domains: Type.Array(Text(256), { maxItems: LIMITS.domains }),
  permissions: Type.Array(Id(), { maxItems: LIMITS.ids }),
  sideEffects: Text(32),
  approvalRequired: Type.Boolean(),
  timeoutSeconds: Type.Number(),
  inputSchema: Text(512),
  outputSchema: Text(512),
});

const Worker = Obj({
  id: Id(),
  kind: Text(32),
  isCoordinator: Type.Boolean(),
  skills: Type.Array(Id(), { maxItems: LIMITS.ids }),
  tools: Type.Array(Id(), { maxItems: LIMITS.ids }),
  maxInstances: Type.Integer(),
  stateRead: Type.Array(Id(), { maxItems: LIMITS.ids }),
  stateWrite: Type.Array(Id(), { maxItems: LIMITS.ids }),
  budgetTokens: Type.Integer(),
  budgetRemoteCalls: Type.Integer(),
});

const WorkflowNode = Obj({
  id: Id(),
  type: Text(32),
  worker: Id(),
  dependsOn: Type.Array(Id(), { maxItems: LIMITS.ids }),
  timeoutSeconds: Type.Number(),
  writes: Type.Array(Id(), { maxItems: LIMITS.ids }),
  task: Nullable(Id()),
  tool: Nullable(Id()),
  maxParallel: Nullable(Type.Integer()),
  maxItems: Nullable(Type.Integer()),
  steps: Type.Array(Obj({ id: Id(), type: Text(32), detail: Nullable(Id()) }), {
    maxItems: LIMITS.steps,
  }),
});

const Workflow = Obj({
  profile: Text(64),
  coordinator: Id(),
  deadlineSeconds: Nullable(Type.Number()),
  nodeCount: Type.Integer({ minimum: 0 }),
  nodeTypes: Type.Array(Obj({ type: Text(32), count: Type.Integer() }), { maxItems: 16 }),
  entryNodes: Type.Array(Id(), { maxItems: LIMITS.nodes }),
  outputNodes: Type.Array(Id(), { maxItems: LIMITS.nodes }),
  maxDeclaredParallel: Type.Integer({ minimum: 0 }),
  nodes: Type.Array(WorkflowNode, { maxItems: LIMITS.nodes }),
  edges: Type.Array(Obj({ from: Id(), to: Id() }), { maxItems: LIMITS.edges }),
  exports: Type.Array(Obj({ path: Text(256), format: Text(32) }), { maxItems: 32 }),
  fixtureDeclared: Type.Boolean(),
  /** True when the graph exceeded the browser bounds above. */
  truncated: Type.Boolean(),
});

export const PackageView = Obj({
  sessionId: Text(128),
  createdAt: Text(64),
  expiresAt: Text(64),
  ttlSeconds: Type.Integer(),
  source: Obj({ kind: Text(16), display: Text(2048) }),
  snapshot: Obj({ archiveSha256: Text(128), archiveBytes: Type.Integer() }),
  identity: Obj({
    packageId: Id(),
    name: Text(200),
    version: Text(64),
    description: Text(LIMITS.text),
    createdAt: Text(64),
    digest: Text(128),
    specVersion: Text(16),
    entrypoint: Text(64),
    executionProfile: Text(64),
    runtimeApi: Text(64),
    minimumRuntimeVersion: Text(32),
  }),
  validation: Validation,
  publisher: Publisher,
  capabilities: Type.Array(Text(200), { maxItems: LIMITS.capabilities }),
  skills: Type.Array(
    Obj({
      id: Id(),
      version: Text(64),
      path: Text(512),
      bytes: Type.Integer(),
      sha256: Text(128),
    }),
    { maxItems: LIMITS.skills },
  ),
  tools: Type.Array(Tool, { maxItems: LIMITS.tools }),
  workers: Type.Array(Worker, { maxItems: LIMITS.workers }),
  workflow: Workflow,
  evals: Type.Array(
    Obj({
      id: Id(),
      kind: Text(64),
      caseCount: Type.Integer(),
      description: Nullable(Text(LIMITS.text)),
      verifiedByHost: Type.Literal(false),
    }),
    { maxItems: LIMITS.evals },
  ),
  attestations: Type.Array(
    Obj({
      path: Text(512),
      bytes: Type.Integer(),
      sha256: Text(128),
      keys: Type.Array(Text(128), { maxItems: 32 }),
      verifiedByHost: Type.Literal(false),
    }),
    { maxItems: LIMITS.attestations },
  ),
  modelRequirements: Obj({
    routing: Text(64),
    fallbackPolicy: Text(64),
    privacy: Nullable(Text(64)),
    latencyPreference: Nullable(Text(64)),
    costSensitivity: Nullable(Text(64)),
    tasks: Type.Array(
      Obj({
        id: Id(),
        capabilities: Type.Array(Text(64), { maxItems: 32 }),
        contextWindow: Type.Integer(),
        preferredTier: Nullable(Text(64)),
      }),
      { maxItems: LIMITS.tasks },
    ),
  }),
  budget: Obj({
    estimatedTokens: Type.Integer(),
    hardTokens: Type.Integer(),
    maxRemoteCalls: Type.Integer(),
    maxParallelWorkers: Type.Integer(),
    estimatedCostUsd: Nullable(Type.Number()),
    approvalThresholdTokens: Nullable(Type.Integer()),
    maxCallsPerTool: Type.Array(Obj({ toolId: Id(), calls: Type.Integer() }), {
      maxItems: LIMITS.tools,
    }),
  }),
  delegation: Obj({
    maxDepth: Type.Integer(),
    allowRemote: Type.Boolean(),
    approvedRoles: Type.Array(Id(), { maxItems: LIMITS.workers }),
  }),
  network: Obj({
    allowedDomains: Type.Array(Text(256), { maxItems: LIMITS.domains }),
    httpsOnly: Type.Boolean(),
    allowRedirects: Type.Boolean(),
  }),
  memory: Obj({
    scope: Text(64),
    retention: Text(64),
    rawDocuments: Type.Boolean(),
    sharing: Text(64),
  }),
  payload: Obj({ fileCount: Type.Integer(), totalBytes: Type.Integer() }),
  warnings: Type.Array(
    Obj({
      code: Text(128),
      severity: Type.Union([
        Type.Literal("info"),
        Type.Literal("warning"),
        Type.Literal("critical"),
      ]),
      message: Text(LIMITS.text),
    }),
    { maxItems: LIMITS.warnings },
  ),
  authorization: Obj({
    state: Type.Union([Type.Literal("pending"), Type.Literal("issued")]),
    receiptId: Nullable(Text(128)),
    runnable: Type.Boolean(),
  }),
  /** Always false here. The page says so in words, too. */
  executionPerformed: Type.Literal(false),
});
export type PackageViewType = Static<typeof PackageView>;

// -- permissions ------------------------------------------------------------
export const DECISIONS = ["deny", "once", "session"] as const;
const Decision = Type.Union([
  Type.Literal("deny"),
  Type.Literal("once"),
  Type.Literal("session"),
]);

const BlockingReason = Obj({
  code: Text(128),
  message: Text(LIMITS.text),
  subject: Nullable(Text(200)),
});

export const PermissionsView = Obj({
  sessionId: Text(128),
  packageId: Id(),
  packageVersion: Text(64),
  packageDigest: Text(128),
  decisionOptions: Type.Array(Decision, { maxItems: 8 }),
  unsupportedDecisions: Type.Array(Obj({ value: Text(32), reason: Text(LIMITS.text) }), {
    maxItems: 8,
  }),
  permissions: Type.Array(
    Obj({
      id: Id(),
      kind: Text(64),
      description: Text(LIMITS.text),
      required: Type.Boolean(),
      resources: Type.Array(Text(256), { maxItems: LIMITS.domains }),
      decision: Decision,
      linkedTools: Type.Array(Id(), { maxItems: LIMITS.tools }),
      linkedDomains: Type.Array(Text(256), { maxItems: LIMITS.domains }),
    }),
    { maxItems: LIMITS.permissions },
  ),
  toolApprovals: Type.Array(
    Obj({
      toolId: Id(),
      approvalRequired: Type.Boolean(),
      sideEffects: Text(32),
      decision: Type.Boolean(),
    }),
    { maxItems: LIMITS.toolApprovals },
  ),
  blockingReasons: Type.Array(BlockingReason, { maxItems: LIMITS.blockingReasons }),
  browserPolicy: Obj({
    requireValidSignature: Type.Boolean(),
    requireTrustedPublisher: Type.Boolean(),
    requireSupportedProfile: Type.Boolean(),
  }),
});
export type PermissionsViewType = Static<typeof PermissionsView>;

// -- receipt ----------------------------------------------------------------
export const ReceiptView = Obj({
  receiptId: Text(128),
  issuedAt: Text(64),
  expiresAt: Text(64),
  sessionId: Text(128),
  packageId: Id(),
  packageName: Text(200),
  packageVersion: Text(64),
  packageDigest: Text(128),
  archiveSha256: Text(128),
  executionProfile: Text(64),
  publisher: Obj({
    claimedId: Text(200),
    claimedName: Text(200),
    signerFingerprint: Nullable(Text(128)),
    signatureStatus: Text(32),
    trustStatus: Text(32),
    trustReason: Text(200),
  }),
  trustStore: Obj({ entryCount: Type.Integer(), stateSha256: Text(128) }),
  decisions: Type.Array(Obj({ permissionId: Id(), decision: Decision }), {
    maxItems: LIMITS.permissions,
  }),
  toolApprovals: Type.Array(Obj({ toolId: Id(), approved: Type.Boolean() }), {
    maxItems: LIMITS.toolApprovals,
  }),
  grantedPermissionIds: Type.Array(Id(), { maxItems: LIMITS.permissions }),
  runnable: Type.Boolean(),
  blockingReasons: Type.Array(BlockingReason, { maxItems: LIMITS.blockingReasons }),
  receiptSha256: Text(128),
  /** Restated on the receipt so the page can never imply a run happened. */
  executionPerformed: Type.Literal(false),
});
export type ReceiptViewType = Static<typeof ReceiptView>;

// -- sessions and trust -----------------------------------------------------
export const SessionRowView = Obj({
  sessionId: Text(128),
  packageId: Id(),
  name: Text(200),
  version: Text(64),
  digest: Text(128),
  expiresAt: Text(64),
  source: Obj({ kind: Text(16), display: Text(2048) }),
  signatureStatus: Text(32),
  trustStatus: Text(32),
  authorizationState: Text(32),
  runnable: Type.Boolean(),
});

export const TrustedPublisherView = Obj({
  fingerprint: Text(128),
  displayName: Text(200),
  publisherId: Nullable(Text(200)),
  packageIdPrefix: Nullable(Text(200)),
  notes: Nullable(Text(LIMITS.shortText)),
  addedAt: Text(64),
});

// -- models and run plans ---------------------------------------------------
/**
 * Compatibility is deliberately tri-state. Collapsing "the host did not say"
 * into either boolean would tell the operator something nobody established.
 */
export const COMPATIBILITY_STATUSES = ["compatible", "unverified", "incompatible"] as const;
const CompatibilityStatus = Type.Union([
  Type.Literal("compatible"),
  Type.Literal("unverified"),
  Type.Literal("incompatible"),
]);

/** Where a host capability answer came from; see `host-models.ts`. */
const CapabilityBasis = Type.Union([
  Type.Literal("declared"),
  Type.Literal("host_default"),
  Type.Literal("derived"),
  Type.Literal("absent"),
]);

const CapabilityAnswer = Obj({
  name: Text(128),
  value: Nullable(Type.Boolean()),
  basis: CapabilityBasis,
  detail: Nullable(Text(LIMITS.text)),
});

/** One package requirement measured against one host model. */
const RequirementCheck = Obj({
  id: Text(200),
  kind: Text(32),
  subject: Text(128),
  operator: Text(32),
  /** Required value: `true` for a capability, a minimum for a context window. */
  required: Type.Union([Type.Boolean(), Type.Integer(), Type.Null()]),
  hostValue: Type.Union([Type.Boolean(), Type.Integer(), Type.Null()]),
  status: Type.Union([
    Type.Literal("satisfied"),
    Type.Literal("violated"),
    Type.Literal("unknown"),
  ]),
  basis: CapabilityBasis,
  source: Text(64),
  detail: Nullable(Text(LIMITS.text)),
  tasks: Type.Array(Id(), { maxItems: LIMITS.tasks }),
});

export const HostModelView = Obj({
  modelId: Text(256),
  providerId: Text(128),
  displayName: Text(LIMITS.shortText),
  available: Type.Boolean(),
  availabilityReason: Nullable(Text(LIMITS.shortText)),
  selectable: Type.Boolean(),
  status: CompatibilityStatus,
  /** True only when this host model could back a ready run plan. */
  selectableForRunPlan: Type.Boolean(),
  evidenceStrength: Type.Union([
    Type.Literal("declared"),
    Type.Literal("host_default"),
    Type.Literal("derived"),
    Type.Literal("none"),
  ]),
  contextTokens: Nullable(Type.Integer()),
  nativeContextWindow: Nullable(Type.Integer()),
  local: Nullable(Type.Boolean()),
  tags: Type.Array(Text(64), { maxItems: 16 }),
  capabilities: Type.Array(CapabilityAnswer, { maxItems: LIMITS.capabilities_reported }),
  checks: Type.Array(RequirementCheck, { maxItems: LIMITS.checks }),
  satisfied: Type.Array(Text(200), { maxItems: LIMITS.checks }),
  unknown: Type.Array(Text(200), { maxItems: LIMITS.checks }),
  violated: Type.Array(Text(200), { maxItems: LIMITS.checks }),
});
export type HostModelViewType = Static<typeof HostModelView>;

const ModelRequirementsView = Obj({
  routing: Text(64),
  fallbackPolicy: Text(64),
  privacy: Nullable(Text(64)),
  bindingStrategy: Text(64),
  hardRequirements: Type.Array(
    Obj({
      id: Text(200),
      kind: Text(32),
      subject: Text(128),
      operator: Text(32),
      required: Type.Union([Type.Boolean(), Type.Integer(), Type.Null()]),
      tasks: Type.Array(Id(), { maxItems: LIMITS.tasks }),
    }),
    { maxItems: LIMITS.checks },
  ),
  preferences: Type.Array(Obj({ id: Text(200), kind: Text(64), subject: Text(128) }), {
    maxItems: LIMITS.preferences,
  }),
});

export const ModelCatalogView = Obj({
  sessionId: Text(128),
  packageDigest: Text(128),
  host: Obj({
    runtime: Text(64),
    runtimeVersion: Nullable(Text(64)),
    source: Text(LIMITS.shortText),
    capturedAt: Text(64),
    agentId: Nullable(Text(128)),
  }),
  catalogSha256: Text(128),
  requirements: ModelRequirementsView,
  models: Type.Array(HostModelView, { maxItems: LIMITS.models }),
  counts: Obj({
    total: Type.Integer(),
    available: Type.Integer(),
    selectable: Type.Integer(),
    compatible: Type.Integer(),
    unverified: Type.Integer(),
    incompatible: Type.Integer(),
  }),
  notes: Type.Array(Obj({ code: Text(128), detail: Nullable(Text(LIMITS.text)) }), {
    maxItems: LIMITS.notes,
  }),
  /** Permission ids a model-backed run needs, on top of package requirements. */
  executionModePermissionIds: Type.Array(Id(), { maxItems: LIMITS.permissions }),
  /** Which of those the current authorization actually granted. */
  executionModePermissionsGranted: Type.Boolean(),
  authorized: Type.Boolean(),
});
export type ModelCatalogViewType = Static<typeof ModelCatalogView>;

export const RunPlanView = Obj({
  runPlanId: Text(128),
  runPlanVersion: Text(16),
  runPlanSha256: Text(128),
  createdAt: Text(64),
  expiresAt: Text(64),
  sessionId: Text(128),
  package: Obj({
    packageId: Id(),
    name: Text(200),
    version: Text(64),
    digest: Text(128),
    archiveSha256: Text(128),
    executionProfile: Text(64),
  }),
  publisher: Obj({
    claimedId: Text(200),
    claimedName: Text(200),
    signerFingerprint: Nullable(Text(128)),
    signatureStatus: Text(32),
    trustStatus: Text(32),
    trustReason: Text(200),
  }),
  authorization: Obj({
    receiptId: Text(128),
    receiptSha256: Text(128),
    issuedAt: Text(64),
    expiresAt: Text(64),
    grantedPermissionIds: Type.Array(Id(), { maxItems: LIMITS.permissions }),
  }),
  execution: Obj({
    profile: Text(64),
    mode: Text(32),
    bindingStrategy: Text(64),
    requiredPermissionIds: Type.Array(Id(), { maxItems: LIMITS.permissions }),
    /** Restated on the plan itself: a plan is preflight, never a run. */
    performed: Type.Literal(false),
    note: Text(LIMITS.text),
  }),
  modelBinding: Obj({
    hostModelId: Text(256),
    providerId: Text(128),
    displayName: Text(LIMITS.shortText),
    selectedAt: Text(64),
    compatibilityStatus: CompatibilityStatus,
    evidenceStrength: Text(32),
    contextTokens: Nullable(Type.Integer()),
    catalogSha256: Text(128),
    catalogModelCount: Type.Integer(),
    checks: Type.Array(RequirementCheck, { maxItems: LIMITS.checks }),
  }),
  requirements: ModelRequirementsView,
  readiness: Obj({
    state: Text(32),
    ready: Type.Boolean(),
    blockingReasons: Type.Array(BlockingReason, { maxItems: LIMITS.blockingReasons }),
  }),
});
export type RunPlanViewType = Static<typeof RunPlanView>;

export const RunPlanStateView = Obj({
  plan: Nullable(RunPlanView),
  preflight: Nullable(
    Obj({
      checkedAt: Text(64),
      state: Text(32),
      ready: Type.Boolean(),
      stale: Type.Boolean(),
      staleReasons: Type.Array(BlockingReason, { maxItems: LIMITS.blockingReasons }),
      blockingReasons: Type.Array(BlockingReason, { maxItems: LIMITS.blockingReasons }),
      trustStoreChanged: Type.Boolean(),
      /** Re-checked against the live host catalog, not the stored snapshot. */
      modelStillAvailable: Nullable(Type.Boolean()),
    }),
  ),
  /** Always false: this page has no Run action. See `ServiceStatus`. */
  executionSupported: Type.Literal(false),
});
export type RunPlanStateViewType = Static<typeof RunPlanStateView>;

// -- execution ---------------------------------------------------------------
export const RUN_STATUSES = ["preparing", "running", "completed", "failed", "cancelled"] as const;

export const RunStatus = Type.Union([
  Type.Literal("preparing"),
  Type.Literal("running"),
  Type.Literal("completed"),
  Type.Literal("failed"),
  Type.Literal("cancelled"),
]);

export const RunArtifact = Obj({
  name: Text(128),
  bytes: Type.Integer(),
  sha256: Text(128),
});

export const RunUsageView = Obj({
  tokens: Type.Integer(),
  remoteCalls: Type.Integer(),
  peakParallelWorkers: Type.Integer(),
  toolCalls: Type.Integer(),
  limits: Obj({
    hardTokens: Type.Integer(),
    maxRemoteCalls: Type.Integer(),
    maxParallelWorkers: Type.Integer(),
  }),
  workers: Type.Array(
    Obj({ worker: Text(128), tokens: Type.Integer(), remoteCalls: Type.Integer() }),
    { maxItems: LIMITS.workers },
  ),
});

/**
 * One run's record: what was asked, what happened, and how it ended.
 *
 * Deliberately not in here: the agentpkgd bearer token, the leased archive's
 * path, the run directory's path, the child's pid, and the package's own
 * output. Artifacts are named and hashed; their contents are read through
 * `execution.artifact`, which is bounded.
 */
export const RunRecordView = Obj({
  runId: Text(128),
  sessionId: Text(128),
  runPlanId: Text(128),
  runPlanSha256: Text(128),
  runInvocationSha256: Nullable(Text(128)),
  inputSha256: Nullable(Text(128)),
  status: RunStatus,
  createdAt: Text(64),
  startedAt: Nullable(Text(64)),
  endedAt: Nullable(Text(64)),
  durationMs: Nullable(Type.Number()),
  package: Obj({
    packageId: Id(),
    name: Text(200),
    version: Text(64),
    digest: Text(128),
    archiveSha256: Text(128),
    executionProfile: Text(64),
  }),
  selectedModel: Obj({
    hostModelId: Text(256),
    providerId: Text(128),
    modelId: Text(256),
    displayName: Text(200),
  }),
  /** Which model actually answered each call, from the adapter's own record. */
  model: Nullable(
    Obj({
      planned: Text(256),
      invoked: Type.Array(Text(256), { maxItems: LIMITS.models }),
      calls: Type.Integer(),
      allCallsUsedPlannedModel: Type.Boolean(),
      providers: Type.Array(Text(128), { maxItems: LIMITS.models }),
      responseModels: Type.Array(Text(256), { maxItems: LIMITS.models }),
    }),
  ),
  grants: Obj({
    decisions: Type.Array(Obj({ permissionId: Id(), decision: Decision }), {
      maxItems: LIMITS.permissions,
    }),
    grantedPermissionIds: Type.Array(Id(), { maxItems: LIMITS.ids }),
  }),
  limits: Obj({
    host: Obj({
      totalTokens: Type.Integer(),
      maxRemoteCalls: Type.Integer(),
      maxParallelWorkers: Type.Integer(),
      maxOutputTokensPerCall: Type.Integer(),
      runTimeoutSeconds: Type.Integer(),
    }),
    effectiveDeadlineSeconds: Nullable(Type.Integer()),
  }),
  usage: Nullable(RunUsageView),
  cost: Nullable(
    Obj({
      status: Text(32),
      totalUsd: Nullable(Type.Number()),
      calls: Type.Integer(),
      callsWithReportedCost: Type.Integer(),
    }),
  ),
  audit: Nullable(
    Obj({
      events: Type.Integer(),
      chainValid: Type.Boolean(),
      finalHash: Nullable(Text(128)),
      actions: Type.Array(Obj({ action: Text(64), count: Type.Integer() }), { maxItems: 64 }),
      workers: Type.Array(Text(128), { maxItems: LIMITS.workers }),
      workersSpawned: Type.Integer(),
      nodesCompleted: Type.Integer(),
      modelCalls: Type.Integer(),
      toolCalls: Type.Integer(),
      tasksCalled: Type.Array(Obj({ task: Text(64), count: Type.Integer() }), { maxItems: 64 }),
    }),
  ),
  outputSha256: Nullable(Text(128)),
  artifacts: Type.Array(RunArtifact, { maxItems: 64 }),
  host: Obj({
    runtime: Text(64),
    runtimeVersion: Nullable(Text(64)),
    verifiedVersion: Text(64),
    versionVerified: Type.Boolean(),
  }),
  deadlineExceeded: Type.Boolean(),
  cancelRequested: Type.Boolean(),
  errorCode: Nullable(Text(64)),
  errorDetail: Nullable(Text(LIMITS.text)),
  /** What the preflight re-verified before a single token was spent. */
  revalidated: Type.Array(Text(64), { maxItems: 32 }),
  packageExecution: Obj({
    workflowInstantiated: Type.Boolean(),
    packageInstructionsLoaded: Type.Boolean(),
    toolHandlersInstalled: Type.Literal(0),
    toolCalls: Type.Integer(),
  }),
});
export type RunRecordViewType = Static<typeof RunRecordView>;

export type RunArtifactType = Static<typeof RunArtifact>;

export const RunListView = Obj({
  runs: Type.Array(RunRecordView, { maxItems: 32 }),
  active: Nullable(RunRecordView),
});

export const RunArtifactContentView = Obj({
  runId: Text(128),
  name: Text(128),
  bytes: Type.Integer(),
  sha256: Text(128),
  truncated: Type.Boolean(),
  /** JSON artifacts come back parsed; anything else comes back as text. */
  json: Type.Optional(Type.Any()),
  text: Type.Optional(Text(262144)),
});
export type RunArtifactContentViewType = Static<typeof RunArtifactContentView>;
export type RunListViewType = Static<typeof RunListView>;

/**
 * The result of the developer router probe.
 *
 * This is a conformance report, not a run result: it says which model answered,
 * how structured output was obtained, what the token bound was, and what the
 * host actually billed. `workflowExecuted` is a literal `false` in the schema,
 * so a build that ever ran a workflow here could not typecheck.
 */
export const RouterProbeView = Obj({
  status: Type.Union([Type.Literal("ok"), Type.Literal("contract_violation")]),
  runPlanId: Text(128),
  runPlanSha256: Text(128),
  sessionId: Text(128),
  package: Obj({
    packageId: Id(),
    name: Text(200),
    version: Text(64),
    digest: Text(128),
    executionProfile: Text(64),
  }),
  router: Obj({
    routerId: Text(128),
    modelId: Text(256),
    remote: Type.Boolean(),
    contextWindow: Type.Integer(),
    capabilities: Type.Array(Text(64), { maxItems: LIMITS.capabilities_reported }),
    notDeclared: Type.Array(Text(64), { maxItems: LIMITS.capabilities_reported }),
  }),
  model: Obj({
    planned: Text(256),
    invoked: Text(256),
    providerId: Nullable(Text(128)),
    responseModel: Nullable(Text(256)),
    stopReason: Nullable(Text(64)),
    executionMode: Nullable(Text(64)),
  }),
  probe: Obj({ status: Text(64), echo: Text(LIMITS.shortText) }),
  structuredOutput: Obj({
    validated: Type.Boolean(),
    constrainedByHost: Type.Boolean(),
    constraintDetail: Nullable(Text(LIMITS.text)),
    parse: Nullable(Text(32)),
  }),
  tokens: Obj({
    countTokensBound: Type.Integer(),
    basis: Text(64),
    hostTokenizer: Type.Boolean(),
    hostTokenizerDetail: Nullable(Text(LIMITS.text)),
    framingAllowance: Nullable(Type.Integer()),
  }),
  usage: Obj({
    inputTokens: Type.Integer(),
    outputTokens: Type.Integer(),
    costUsd: Nullable(Type.Number()),
  }),
  accounting: Obj({
    maxOutputTokens: Type.Integer(),
    inputWithinBound: Type.Boolean(),
    outputWithinCap: Type.Boolean(),
  }),
  durationMs: Type.Number(),
  /** Always false. The probe is not an agent run and cannot become one. */
  workflowExecuted: Type.Literal(false),
  packageExecution: Obj({
    workflowInstantiated: Type.Literal(false),
    workersStarted: Type.Literal(0),
    toolsCalled: Type.Literal(0),
    packageInstructionsLoaded: Type.Literal(false),
    exportsWritten: Type.Literal(0),
  }),
  /** What was re-verified between reading the plan and spending a token. */
  revalidated: Type.Array(Text(64), { maxItems: 32 }),
});
export type RouterProbeViewType = Static<typeof RouterProbeView>;

const SessionId = Type.String({ minLength: 8, maxLength: 128, pattern: "^[A-Za-z0-9_-]+$" });
const Fingerprint = Type.String({ pattern: "^sha256:[0-9a-f]{64}$" });

export const contract = defineFeatureContract({
  pluginId: PLUGIN_ID,
  operations: {
    // -- queries (operator.read) --------------------------------------------
    "service.status": {
      kind: "query",
      description: "Report the local Agent Browser control-plane service state.",
      input: Obj({}),
      output: ServiceStatus,
    },
    "packages.list": {
      kind: "query",
      description: "List package sessions open in the control plane.",
      input: Obj({}),
      output: Result(
        Obj({
          sessions: Type.Array(SessionRowView, { maxItems: LIMITS.sessions }),
          max: Type.Integer(),
        }),
      ),
    },
    "packages.get": {
      kind: "query",
      description: "Inspect one open package session.",
      input: Obj({ sessionId: SessionId }),
      output: Result(PackageView),
    },
    "packages.permissions": {
      kind: "query",
      description: "Read the authorization request for one open package session.",
      input: Obj({ sessionId: SessionId }),
      output: Result(PermissionsView),
    },
    "packages.authorization": {
      kind: "query",
      description: "Read the authorization receipt issued for one session, if any.",
      input: Obj({ sessionId: SessionId }),
      output: Result(Nullable(ReceiptView)),
    },
    "models.evaluate": {
      kind: "query",
      description:
        "Discover this host's models and evaluate them against one package's requirements.",
      input: Obj({ sessionId: SessionId }),
      output: Result(ModelCatalogView),
    },
    "run-plan.get": {
      kind: "query",
      description: "Read the run plan prepared for one session, with a fresh preflight check.",
      input: Obj({ sessionId: SessionId }),
      output: Result(RunPlanStateView),
    },
    "execution.status": {
      kind: "query",
      description:
        "Operator-only. List this session's run records, and the active one if there is any. " +
        "Not rendered by the Agent Browser page.",
      input: Obj({ sessionId: Type.Optional(SessionId) }),
      output: Result(RunListView),
    },
    "execution.get": {
      kind: "query",
      description: "Operator-only. Read one run record by id.",
      input: Obj({ runId: Type.String({ minLength: 4, maxLength: 128 }) }),
      output: Result(Nullable(RunRecordView)),
    },
    "execution.artifact": {
      kind: "query",
      description:
        "Operator-only. Read one named artifact a completed run wrote, bounded. The run " +
        "directory's path is never returned; only the artifact's content is.",
      input: Obj({
        runId: Type.String({ minLength: 4, maxLength: 128 }),
        name: Type.String({ minLength: 1, maxLength: 128 }),
      }),
      output: Result(RunArtifactContentView),
    },
    "trust.list": {
      kind: "query",
      description: "List publisher keys pinned by this operator.",
      input: Obj({}),
      output: Result(
        Obj({ publishers: Type.Array(TrustedPublisherView, { maxItems: LIMITS.publishers }) }),
      ),
    },

    // -- actions (operator.write) -------------------------------------------
    "packages.open-url": {
      kind: "action",
      description: "Open an agent package from an HTTPS URL through the control plane.",
      input: Obj({ url: Type.String({ minLength: 8, maxLength: 2048 }) }),
      output: Result(PackageView),
    },
    "packages.open-local": {
      kind: "action",
      description: "Open an agent package from an operator-configured local directory.",
      input: Obj({ path: Type.String({ minLength: 1, maxLength: 4096 }) }),
      output: Result(PackageView),
    },
    "packages.close": {
      kind: "action",
      description: "Close a package session and delete its snapshot.",
      input: Obj({ sessionId: SessionId }),
      output: Result(Obj({ sessionId: Text(128), closed: Type.Boolean() })),
    },
    "packages.authorize": {
      kind: "action",
      description: "Record explicit permission decisions and issue an authorization receipt.",
      input: Obj({
        sessionId: SessionId,
        packageDigest: Type.String({ pattern: "^[0-9a-f]{64}$" }),
        decisions: Type.Array(Obj({ permissionId: Id(), decision: Decision }), {
          maxItems: LIMITS.permissions,
        }),
        toolApprovals: Type.Optional(
          Type.Array(Obj({ toolId: Id(), approved: Type.Boolean() }), {
            maxItems: LIMITS.toolApprovals,
          }),
        ),
      }),
      output: Result(ReceiptView),
    },
    "run-plan.prepare": {
      kind: "action",
      description:
        "Bind this package, its authorization and one explicitly chosen host model into an " +
        "immutable run plan. Nothing is executed.",
      input: Obj({
        sessionId: SessionId,
        packageDigest: Type.String({ pattern: "^[0-9a-f]{64}$" }),
        receiptId: Type.String({ minLength: 8, maxLength: 128 }),
        modelId: Type.String({ minLength: 1, maxLength: 256 }),
        executionMode: Type.Optional(Type.Literal("model")),
      }),
      output: Result(RunPlanStateView),
    },
    "router.probe": {
      kind: "action",
      description:
        "Developer/operator conformance probe. Re-verifies a ready run plan, then makes ONE " +
        "host-owned model call through the agentpkg ModelRouter bridge to prove the router " +
        "contract against the exact model the plan bound. It is not an agent run: no workflow " +
        "node, worker, package skill or package tool takes part in it, and it spends a few " +
        "hundred tokens.",
      input: Obj({
        sessionId: SessionId,
        runPlanId: Type.String({ minLength: 4, maxLength: 128 }),
        runPlanSha256: Type.String({ pattern: "^[0-9a-f]{64}$" }),
      }),
      output: Result(RouterProbeView),
    },
    "execution.start": {
      kind: "action",
      description:
        "Operator-only. Re-verify a ready run plan and execute the signed package's own " +
        "workflow.v0 graph on the exact model the plan bound. It accepts the workflow input " +
        "and nothing else: no prompt, no system text, no model id, no skill text and no " +
        "output schema, all of which come from the signed package and the run plan. It is " +
        "not rendered by the Agent Browser page, and it spends real tokens.",
      input: Obj({
        sessionId: SessionId,
        runPlanId: Type.String({ minLength: 4, maxLength: 128 }),
        runPlanSha256: Type.String({ pattern: "^[0-9a-f]{64}$" }),
        /**
         * The package's own declared input schema is what validates this, in
         * the runner, before any package instruction reaches a model.
         */
        input: Type.Unknown(),
      }),
      output: Result(RunRecordView),
    },
    "execution.cancel": {
      kind: "action",
      description:
        "Operator-only. Ask a running workflow to stop. Workers are cancelled, pending model " +
        "calls are aborted at the provider, and the run ends as cancelled with its audit and " +
        "usage intact.",
      input: Obj({ runId: Type.String({ minLength: 4, maxLength: 128 }) }),
      output: Result(RunRecordView),
    },
    "execution.clear": {
      kind: "action",
      description:
        "Operator-only. Forget finished run records held in memory. A running run is never " +
        "cleared.",
      input: Obj({
        runId: Type.Optional(Type.String({ minLength: 4, maxLength: 128 })),
        sessionId: Type.Optional(SessionId),
      }),
      output: Result(Obj({ cleared: Type.Integer() })),
    },
    "run-plan.clear": {
      kind: "action",
      description: "Discard the run plan prepared for one session.",
      input: Obj({ sessionId: SessionId }),
      output: Result(Obj({ sessionId: Text(128), cleared: Type.Boolean() })),
    },
    "trust.pin-session-publisher": {
      kind: "action",
      description: "Pin the publisher key that signed one open session, at the chosen scope.",
      input: Obj({
        sessionId: SessionId,
        signerFingerprint: Fingerprint,
        scope: Type.Union([Type.Literal("package"), Type.Literal("publisher")]),
      }),
      output: Result(Obj({ publisher: Publisher, pinned: TrustedPublisherView })),
    },
    "trust.remove": {
      kind: "action",
      description: "Remove one pinned publisher key.",
      input: Obj({ fingerprint: Fingerprint }),
      output: Result(Obj({ fingerprint: Text(128), removed: Type.Boolean() })),
    },
    "service.restart": {
      kind: "action",
      description: "Restart the local Agent Browser control-plane service.",
      input: Obj({}),
      output: ServiceStatus,
    },
  },
  events: {
    /** Emitted when the service state or the open-session set changes. */
    "browser-changed": Obj({ reason: Text(64) }),
  },
});

export type Contract = typeof contract;
