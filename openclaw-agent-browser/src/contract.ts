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
/**
 * What any operation may carry through OpenClaw, whatever its schema says.
 *
 * `defineFeaturePlugin` (OpenClaw 2026.9.5) checks every operation's input and
 * output against the host's plugin JSON limits before its schema, and refuses
 * a value over any of them as `INVALID_INPUT` / `INVALID_OUTPUT`. These mirror
 * the host's `PLUGIN_JSON_VALUE_LIMITS`; `test/host-bounds.test.ts` reads the
 * host's own constant so the mirror cannot drift unnoticed. A projection that
 * could exceed them must bound itself first (see `src/json-limits.ts`).
 */
export const HOST_JSON_LIMITS = {
  maxDepth: 32,
  maxNodes: 4096,
  maxObjectKeys: 512,
  maxStringLength: 65_536,
  maxSerializedBytes: 262_144,
} as const;

/**
 * The person's words in a task, for a list or a title: its longest top-level
 * text. Key order says nothing (a form fills declared defaults such as a mode
 * first), and a short enum value is not what anyone typed. Shared by both
 * halves so a run is named the same way everywhere.
 */
export function taskText(input: unknown): string | null {
  if (typeof input === "string") return input.trim() || null;
  let best: string | null = null;
  if (input && typeof input === "object" && !Array.isArray(input)) {
    for (const value of Object.values(input as Record<string, unknown>)) {
      const text = typeof value === "string" ? value.trim() : "";
      if (text && (best === null || text.length > best.length)) best = text;
    }
  }
  return best;
}

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
  "tool_registry_unavailable",
  "tool_call_failed",
  "input_invalid",
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
    Type.Literal("tool_registry_unavailable"),
    Type.Literal("tool_call_failed"),
    Type.Literal("input_invalid"),
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
   * Whether this page offers a Run action for a ready, model-backed run plan.
   *
   * True only while the service runs and this backend holds OpenClaw's
   * completion runtime. Offering the action is not authority: every Run is
   * re-verified by the same preflight the operator path uses, and the page
   * enables it only when that preflight says the plan is current.
   */
  executionSupported: Type.Boolean(),
  /** Whether the execution operations can run a package here at all. */
  executionOperations: Type.Optional(Type.Boolean()),
  /** Whether PDFs can be selected for a run from operator-configured directories. */
  fileSelection: Type.Optional(Type.Boolean()),
  /** Host execution bounds the page needs to explain a disabled Run action. */
  execution: Type.Optional(
    Obj({
      runTimeoutSeconds: Type.Integer({ minimum: 0 }),
      modelCallTimeoutSeconds: Type.Integer({ minimum: 0 }),
      /** How long consent must outlast a run's deadline before one may start. */
      receiptMarginSeconds: Type.Integer({ minimum: 0 }),
      /** Directories PDFs may be selected from, for display only. */
      fileRoots: Type.Array(Text(1024), { maxItems: 8 }),
    }),
  ),
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

/**
 * The package's own task input contract, bundled into one offline document.
 *
 * The page renders a form from it; the control plane and the runner remain
 * the only judges of whether a task satisfies it.
 */
export const TaskInputView = Obj({
  schemaPath: Nullable(Text(512)),
  schemaSha256: Nullable(Text(128)),
  bytes: Type.Integer({ minimum: 0 }),
  /** Null when the schema exceeds the control plane's bound; edit as JSON then. */
  document: Nullable(Type.Unknown()),
  note: Text(LIMITS.text),
});
export type TaskInputViewType = Static<typeof TaskInputView>;

/**
 * Noncritical presentation hints from the signed package, already validated
 * and reduced to a closed vocabulary by the control plane. Cosmetic only:
 * nothing here can enable, authorize or change a run.
 */
export const PresentationView = Obj({
  task: Obj({
    prompt: Nullable(Text(LIMITS.shortText)),
    runLabel: Nullable(Text(64)),
    runningLabel: Nullable(Text(128)),
    completedLabel: Nullable(Text(128)),
  }),
  input: Type.Array(
    Obj({
      field: Text(200),
      widget: Nullable(Type.Union([Type.Literal("multiline"), Type.Literal("selected_files")])),
      group: Nullable(
        Type.Union([Type.Literal("primary"), Type.Literal("optional"), Type.Literal("advanced")]),
      ),
      label: Nullable(Text(128)),
      placeholder: Nullable(Text(LIMITS.shortText)),
      rows: Nullable(Type.Integer({ minimum: 1, maximum: 12 })),
      itemPlaceholder: Nullable(Text(LIMITS.shortText)),
      keyLabel: Nullable(Text(128)),
      keyPlaceholder: Nullable(Text(LIMITS.shortText)),
    }),
    { maxItems: 64 },
  ),
  nodes: Type.Array(Obj({ nodeId: Id(), label: Text(128) }), { maxItems: LIMITS.nodes }),
  stages: Type.Array(
    Obj({ label: Text(128), nodes: Type.Array(Id(), { maxItems: LIMITS.nodes }) }),
    { maxItems: 32 },
  ),
  result: Obj({
    primaryExport: Nullable(Text(256)),
    summary: Type.Array(Obj({ label: Text(128), export: Text(256) }), { maxItems: 8 }),
  }),
});
export type PresentationViewType = Static<typeof PresentationView>;

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
  /** The task a person fills in to start a run. */
  input: Type.Optional(TaskInputView),
  /** Validated cosmetic hints, or null when the package carries none. */
  presentation: Type.Optional(Nullable(PresentationView)),
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

// -- host tool bindings -----------------------------------------------------
/**
 * What this host offers for one tool a package declares.
 *
 * `bound` is the only status that can back a ready plan. The others are kept
 * apart on purpose: "nobody implements this", "an implementation exists but
 * speaks a different contract", "two do", "one does but is down" and "one does
 * but nothing confirmed its contract" are five different problems with five
 * different fixes, and collapsing them would tell an operator to do the wrong
 * one.
 */
export const TOOL_BINDING_STATUSES = [
  "bound",
  "unverified",
  "unavailable",
  "ambiguous",
  "incompatible",
  "unbound",
] as const;

const ToolBindingStatus = Type.Union([
  Type.Literal("bound"),
  Type.Literal("unverified"),
  Type.Literal("unavailable"),
  Type.Literal("ambiguous"),
  Type.Literal("incompatible"),
  Type.Literal("unbound"),
]);

/** One declared package tool measured against one host implementation. */
const ToolCheck = Obj({
  id: Text(200),
  subject: Text(128),
  status: Type.Union([
    Type.Literal("satisfied"),
    Type.Literal("violated"),
    Type.Literal("unknown"),
  ]),
  detail: Nullable(Text(LIMITS.text)),
});

export const HostToolBindingView = Obj({
  toolId: Id(),
  bindingName: Text(200),
  status: ToolBindingStatus,
  reason: Nullable(Text(LIMITS.text)),
  required: Type.Boolean(),
  remote: Type.Boolean(),
  sideEffects: Text(32),
  declaredDomains: Type.Array(Text(256), { maxItems: LIMITS.domains }),
  permissionIds: Type.Array(Id(), { maxItems: LIMITS.ids }),
  /** The person's decisions, reported beside the host's, never derived from it. */
  approved: Type.Boolean(),
  permissionsGranted: Type.Boolean(),
  deniedPermissionIds: Type.Array(Id(), { maxItems: LIMITS.ids }),
  usable: Type.Boolean(),
  blocksPlan: Type.Boolean(),
  /** Present only when exactly one implementation was matched. */
  binding: Nullable(
    Obj({
      bindingId: Text(200),
      bindingSha256: Text(128),
      implementationKind: Text(64),
      implementationVersion: Text(64),
      displayName: Text(LIMITS.shortText),
      available: Type.Boolean(),
      availabilityReason: Nullable(Text(LIMITS.shortText)),
      endpointOrigin: Nullable(Text(256)),
      endpointPath: Nullable(Text(256)),
      method: Nullable(Text(16)),
      timeoutSeconds: Nullable(Type.Number()),
      /** Whether a credential is attached. Never what it is. */
      credentialsRequired: Type.Boolean(),
      credentialsConfigured: Type.Boolean(),
      checks: Type.Array(ToolCheck, { maxItems: LIMITS.checks }),
    }),
  ),
});
export type HostToolBindingViewType = Static<typeof HostToolBindingView>;

export const ToolRegistryView = Obj({
  sessionId: Text(128),
  packageDigest: Text(128),
  host: Obj({
    runtime: Text(64),
    runtimeVersion: Nullable(Text(64)),
    source: Text(LIMITS.shortText),
    capturedAt: Text(64),
  }),
  registrySha256: Text(128),
  bindingCount: Type.Integer({ minimum: 0 }),
  tools: Type.Array(HostToolBindingView, { maxItems: LIMITS.tools }),
  counts: Obj({
    total: Type.Integer(),
    bound: Type.Integer(),
    unbound: Type.Integer(),
    incompatible: Type.Integer(),
    unverified: Type.Integer(),
    unavailable: Type.Integer(),
    approved: Type.Integer(),
    usable: Type.Integer(),
    blocking: Type.Integer(),
  }),
  allToolsBound: Type.Boolean(),
  allToolsUsable: Type.Boolean(),
  notes: Type.Array(Obj({ code: Text(128), detail: Nullable(Text(LIMITS.text)) }), {
    maxItems: LIMITS.notes,
  }),
  authorized: Type.Boolean(),
});
export type ToolRegistryViewType = Static<typeof ToolRegistryView>;

/** One tool implementation a run plan froze, as the plan records it. */
const PlannedToolBinding = Obj({
  toolId: Id(),
  bindingId: Text(200),
  bindingSha256: Text(128),
  implementationKind: Text(64),
  implementationVersion: Nullable(Text(64)),
  displayName: Nullable(Text(LIMITS.shortText)),
  remote: Type.Boolean(),
  endpointOrigin: Nullable(Text(256)),
  endpointPath: Nullable(Text(256)),
  method: Nullable(Text(16)),
  contractSha256: Text(128),
  requiredPermissionIds: Type.Array(Id(), { maxItems: LIMITS.ids }),
  timeoutSeconds: Nullable(Type.Number()),
  maxCalls: Nullable(Type.Integer()),
  credentialsRequired: Type.Boolean(),
  credentialsConfigured: Type.Boolean(),
  approved: Type.Literal(true),
  usable: Type.Boolean(),
});

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
    /** Set only on a `tool_probe` plan: the one tool it is authority for. */
    probeToolId: Nullable(Id()),
    /** Restated on the plan itself: a plan is preflight, never a run. */
    performed: Type.Literal(false),
    note: Text(LIMITS.text),
  }),
  /** Null for a `tool_probe` plan: it binds no model, by construction. */
  modelBinding: Nullable(
    Obj({
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
  ),
  requirements: ModelRequirementsView,
  /** Exactly what would run for each declared tool. Never a credential. */
  toolBindings: Type.Array(PlannedToolBinding, { maxItems: LIMITS.tools }),
  toolRegistry: Nullable(
    Obj({ registrySha256: Text(128), bindingCount: Type.Integer({ minimum: 0 }) }),
  ),
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
      /** Whether every implementation this plan bound is still that one. */
      toolBindingsCurrent: Type.Boolean(),
      toolBindingsBound: Type.Integer({ minimum: 0 }),
    }),
  ),
  /**
   * Whether this host can run a model-backed plan from the page. A plan is
   * still never *performed*: `plan.execution.performed` stays false, and a run
   * is a separate record that references the plan.
   */
  executionSupported: Type.Boolean(),
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

/**
 * What a run was asked, as the person's own task: the workflow input and the
 * selected files it was given. Never a path, never package output.
 *
 * The input is echoed only when it is small; a larger one is identified by its
 * hash and size, which the invocation already binds.
 */
export const RunTaskView = Obj({
  inputBytes: Type.Integer({ minimum: 0 }),
  input: Type.Optional(Type.Unknown()),
  attachments: Type.Array(
    Obj({
      fileId: Text(64),
      sha256: Text(128),
      bytes: Type.Integer({ minimum: 0 }),
      mediaType: Text(64),
    }),
    { maxItems: 16 },
  ),
});
export type RunTaskViewType = Static<typeof RunTaskView>;

/**
 * Live progress of a running workflow, derived by the runner from the audit
 * events it has already recorded. Identifiers and counts only: no prompt, no
 * model output, no tool payload.
 */
export const RunProgressView = Obj({
  updatedAt: Text(64),
  events: Type.Integer({ minimum: 0 }),
  lastAction: Nullable(Text(64)),
  activeNodes: Type.Array(Text(200), { maxItems: 64 }),
  completedNodes: Type.Array(Text(200), { maxItems: 128 }),
  failedNodes: Type.Array(Text(200), { maxItems: 64 }),
  nodesCompleted: Type.Integer({ minimum: 0 }),
  stepsCompleted: Type.Integer({ minimum: 0 }),
  workersSpawned: Type.Integer({ minimum: 0 }),
  workersActive: Type.Integer({ minimum: 0 }),
  peakParallelWorkers: Type.Integer({ minimum: 0 }),
  activeWorkers: Type.Array(Text(128), { maxItems: 64 }),
  modelCallsStarted: Type.Integer({ minimum: 0 }),
  modelCallsCompleted: Type.Integer({ minimum: 0 }),
  toolCallsStarted: Type.Integer({ minimum: 0 }),
  toolCallsCompleted: Type.Integer({ minimum: 0 }),
  tokens: Type.Integer({ minimum: 0 }),
  remoteCalls: Type.Integer({ minimum: 0 }),
  elapsedMs: Type.Number({ minimum: 0 }),
  /** Top-level nodes whose declared condition was false: completed, not performed. */
  skippedNodes: Type.Optional(Type.Array(Text(200), { maxItems: 128 })),
  /** One row per spawned worker: where it ran, how it ended, how many calls. */
  workers: Type.Optional(
    Type.Array(
      Obj({
        id: Text(128),
        role: Nullable(Text(128)),
        node: Nullable(Text(200)),
        state: Type.Union([
          Type.Literal("queued"),
          Type.Literal("active"),
          Type.Literal("completed"),
          Type.Literal("failed"),
          Type.Literal("cancelled"),
        ]),
        modelCalls: Type.Integer({ minimum: 0 }),
        toolCalls: Type.Integer({ minimum: 0 }),
        durationMs: Nullable(Type.Number({ minimum: 0 })),
      }),
      { maxItems: 64 },
    ),
  ),
});
export type RunProgressViewType = Static<typeof RunProgressView>;

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
    /** Whether the host reports this model as local. Null when it does not say. */
    local: Type.Optional(Nullable(Type.Boolean())),
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
      modelCallTimeoutSeconds: Type.Integer(),
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
  /**
   * What the preflight re-verified before a single token was spent, then what
   * the runner verified for itself: at most ~26 preflight checks, the input
   * size, 16 runner facts, the handler count and one entry per bound tool (16).
   */
  revalidated: Type.Array(Text(64), { maxItems: 64 }),
  packageExecution: Obj({
    workflowInstantiated: Type.Boolean(),
    packageInstructionsLoaded: Type.Boolean(),
    toolHandlersInstalled: Type.Integer({ minimum: 0 }),
    toolCalls: Type.Integer(),
  }),
  /** What was asked: the workflow input (when small) and the selected files given. */
  task: Type.Optional(RunTaskView),
  /** Live, while running; the last snapshot afterwards. Null before the first. */
  progress: Type.Optional(Nullable(RunProgressView)),
  /** Which implementation each declared tool was bound to, and how often used. */
  tools: Type.Array(
    Obj({
      toolId: Id(),
      bindingId: Text(200),
      bindingSha256: Text(128),
      remote: Type.Boolean(),
      calls: Type.Integer({ minimum: 0 }),
      /** The host implementation's display name, as the plan froze it. */
      displayName: Type.Optional(Nullable(Text(LIMITS.shortText))),
    }),
    { maxItems: LIMITS.tools },
  ),
  /**
   * Where a run that did not complete stopped, from its own audit: the node,
   * the map step, the stable code, the declared check that refused it and the
   * first failed call's reason. Codes and pointers only; never data.
   */
  failure: Type.Optional(
    Nullable(
      Obj({
        nodeId: Nullable(Text(200)),
        stepId: Nullable(Text(200)),
        errorCode: Nullable(Text(64)),
        failedCheck: Nullable(Type.Unknown()),
        call: Nullable(
          Obj({
            kind: Text(32),
            action: Text(64),
            tool: Nullable(Text(200)),
            task: Nullable(Text(128)),
            reason: Nullable(Text(64)),
          }),
        ),
      }),
    ),
  ),
  /**
   * `live` for a run this Gateway process started; `recovered` for a finished
   * run's record read back, unchanged, from this plugin's own run directory
   * after a restart. A recovered record is evidence to inspect, never
   * authority to act on.
   */
  origin: Type.Optional(Type.Union([Type.Literal("live"), Type.Literal("recovered")])),
});
export type RunRecordViewType = Static<typeof RunRecordView>;

export type RunArtifactType = Static<typeof RunArtifact>;

/**
 * One run in a list: enough to name it, date it and open it. A list carries
 * summaries, not records, so it stays inside the host's JSON limits however
 * many runs (up to 32) and however many workers each had; the full record is
 * one `execution.get` away.
 */
export const RunSummaryView = Obj({
  runId: Text(128),
  sessionId: Text(128),
  runPlanId: Text(128),
  status: RunStatus,
  createdAt: Text(64),
  endedAt: Nullable(Text(64)),
  durationMs: Nullable(Type.Number()),
  package: Obj({ packageId: Id(), name: Text(200), version: Text(64) }),
  cancelRequested: Type.Boolean(),
  errorCode: Nullable(Text(64)),
  /** The task's own words (see `taskText`), clipped for a list. */
  taskText: Nullable(Text(400)),
  origin: Type.Optional(Type.Union([Type.Literal("live"), Type.Literal("recovered")])),
});
export type RunSummaryViewType = Static<typeof RunSummaryView>;

/** One run as a list shows it; both halves summarize a record this way. */
export function runSummary(view: RunRecordViewType): RunSummaryViewType {
  const text = taskText(view.task?.input);
  return {
    runId: view.runId,
    sessionId: view.sessionId,
    runPlanId: view.runPlanId,
    status: view.status,
    createdAt: view.createdAt,
    endedAt: view.endedAt,
    durationMs: view.durationMs,
    package: { packageId: view.package.packageId, name: view.package.name, version: view.package.version },
    cancelRequested: view.cancelRequested,
    errorCode: view.errorCode,
    taskText: text ? (text.length > 400 ? `${text.slice(0, 399)}…` : text) : null,
    ...(view.origin ? { origin: view.origin } : {}),
  };
}

export const RunListView = Obj({
  runs: Type.Array(RunSummaryView, { maxItems: 32 }),
  /** The one run still in flight, in full, so a page can reconnect to it. */
  active: Nullable(RunRecordView),
});

/** One bounded slice of an artifact, for downloading one larger than a view. */
export const RunArtifactChunkView = Obj({
  runId: Text(128),
  name: Text(128),
  /** The whole artifact's size and hash, so a download can be verified. */
  bytes: Type.Integer({ minimum: 0 }),
  sha256: Text(128),
  offset: Type.Integer({ minimum: 0 }),
  length: Type.Integer({ minimum: 0 }),
  /** At most 48 KiB of bytes: exactly the host's longest string once encoded. */
  base64: Text(HOST_JSON_LIMITS.maxStringLength),
  eof: Type.Boolean(),
});
export type RunArtifactChunkViewType = Static<typeof RunArtifactChunkView>;

/**
 * Whether a Run may start right now, answered by the same preflight that
 * `execution.start` runs, without starting anything.
 */
export const RunReadinessView = Obj({
  sessionId: Text(128),
  checkedAt: Text(64),
  ready: Type.Boolean(),
  executionAvailable: Type.Boolean(),
  runPlanId: Nullable(Text(128)),
  runPlanSha256: Nullable(Text(128)),
  /** The first thing that would refuse a start, with its stable code. */
  blocker: Nullable(Obj({ code: Text(64), title: Text(200), detail: Text(LIMITS.text) })),
  /** What the preflight re-verified before it stopped or finished. */
  checks: Type.Array(Text(64), { maxItems: 64 }),
  receipt: Nullable(
    Obj({
      expiresAt: Nullable(Text(64)),
      remainingSeconds: Nullable(Type.Integer()),
      requiredSeconds: Type.Integer({ minimum: 0 }),
    }),
  ),
  /** A run already in flight for this session, which a Run would be refused for. */
  activeRunId: Nullable(Text(128)),
});
export type RunReadinessViewType = Static<typeof RunReadinessView>;

/** The package's own verdict on one proposed task. */
export const InputValidationView = Obj({
  sessionId: Text(128),
  schemaPath: Nullable(Text(512)),
  valid: Type.Boolean(),
  errors: Type.Array(
    Obj({ pointer: Text(1024), rule: Text(64), message: Text(LIMITS.shortText) }),
    { maxItems: 16 },
  ),
  errorCount: Type.Integer({ minimum: 0 }),
  inputSha256: Nullable(Text(128)),
  inputBytes: Type.Integer({ minimum: 0 }),
});
export type InputValidationViewType = Static<typeof InputValidationView>;

export const RunArtifactContentView = Obj({
  runId: Text(128),
  name: Text(128),
  bytes: Type.Integer(),
  sha256: Text(128),
  truncated: Type.Boolean(),
  /** How many of the artifact's bytes this view carries (all, unless truncated). */
  shownBytes: Type.Optional(Type.Integer({ minimum: 0 })),
  /**
   * A small JSON artifact comes back parsed; anything else — including JSON
   * too large for the host's limits — comes back as at most 48 KiB of text.
   */
  json: Type.Optional(Type.Any()),
  text: Type.Optional(Text(HOST_JSON_LIMITS.maxStringLength)),
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
  revalidated: Type.Array(Text(64), { maxItems: 40 }),
});
export type RouterProbeViewType = Static<typeof RouterProbeView>;

/**
 * The result of the developer tool probe.
 *
 * A conformance report, not a run result: it says which declared tool was
 * called, which host implementation answered, under whose permission and
 * approval, what the runtime charged, and what came back. `workflowExecuted`
 * and `modelCalls` are literals in the schema, so a build that ever ran a graph
 * or spent a token here could not typecheck.
 */
export const ToolProbeView = Obj({
  status: Type.Union([Type.Literal("ok"), Type.Literal("failed")]),
  runPlanId: Text(128),
  runPlanSha256: Text(128),
  sessionId: Text(128),
  package: Obj({
    packageId: Id(),
    name: Text(200),
    version: Text(64),
    digest: Text(128),
  }),
  tool: Obj({
    id: Id(),
    version: Text(64),
    binding: Text(200),
    execution: Text(32),
    remote: Type.Boolean(),
    sideEffects: Text(32),
    permissions: Type.Array(Id(), { maxItems: LIMITS.ids }),
    domains: Type.Array(Text(256), { maxItems: LIMITS.domains }),
    timeoutSeconds: Type.Number(),
    declaredEndpoint: Nullable(Text(512)),
  }),
  binding: Obj({
    bindingId: Text(200),
    bindingSha256: Text(128),
    implementationKind: Text(64),
    implementationVersion: Nullable(Text(64)),
    displayName: Nullable(Text(LIMITS.shortText)),
    remote: Type.Boolean(),
    endpointOrigin: Nullable(Text(256)),
    endpointPath: Nullable(Text(256)),
    method: Nullable(Text(16)),
    credentialsRequired: Type.Boolean(),
    credentialsConfigured: Type.Boolean(),
  }),
  authority: Obj({
    role: Id(),
    /** Whether the operator named the role, because more than one declares the tool. */
    roleNamedByHost: Type.Optional(Type.Boolean()),
    workerContext: Type.Boolean(),
    approved: Type.Literal(true),
    grants: Type.Array(Obj({ permissionId: Id(), decision: Text(32) }), {
      maxItems: LIMITS.ids,
    }),
    permissionChecks: Type.Integer({ minimum: 0 }),
  }),
  /** The probe's input is host-owned; this says which fixture was sent. */
  fixture: Obj({
    id: Text(64),
    source: Type.Literal("host_owned"),
    /** For a file-reading tool: the selected-file capability the fixture was bound to. */
    fileId: Type.Optional(Nullable(Text(64))),
  }),
  request: Obj({ argsSha256: Text(128), argsBytes: Type.Integer({ minimum: 0 }) }),
  result: Obj({
    validatedByRuntime: Type.Boolean(),
    validatedAgainst: Text(512),
    outputSha256: Nullable(Text(128)),
    outputBytes: Type.Integer({ minimum: 0 }),
    outputKeys: Type.Array(Text(128), { maxItems: 64 }),
    /** The validated answer itself, bounded. This is operator evidence. */
    output: Type.Optional(Type.Any()),
  }),
  transport: Obj({
    durationMs: Type.Number(),
    hostCalls: Type.Array(
      Obj({
        toolId: Id(),
        bindingId: Text(200),
        remote: Type.Boolean(),
        status: Nullable(Type.Integer()),
        durationMs: Type.Number(),
        outcome: Text(16),
      }),
      { maxItems: 16 },
    ),
  }),
  usage: Obj({
    toolCalls: Type.Integer({ minimum: 0 }),
    remoteCalls: Type.Integer({ minimum: 0 }),
    tokens: Type.Integer({ minimum: 0 }),
  }),
  audit: Obj({
    events: Type.Integer({ minimum: 0 }),
    chainValid: Type.Boolean(),
    finalHash: Nullable(Text(128)),
    actions: Type.Array(Obj({ action: Text(64), count: Type.Integer() }), { maxItems: 64 }),
  }),
  /** Always false and always zero. The probe is not an agent run. */
  workflowExecuted: Type.Literal(false),
  packageExecution: Obj({
    workflowInstantiated: Type.Literal(false),
    workflowNodesExecuted: Type.Literal(0),
    workflowWorkersStarted: Type.Literal(0),
    modelCalls: Type.Literal(0),
    modelRouterInstalled: Type.Literal(false),
    packageInstructionsLoaded: Type.Literal(false),
    /**
     * One authorized worker context, because only a worker role may hold a
     * tool and `Runtime.call_tool` takes its authority from the caller's. A
     * probe that forged one would be bypassing the thing it tests.
     */
    runtimeWorkerContexts: Type.Integer({ minimum: 0, maximum: 1 }),
  }),
  revalidated: Type.Array(Text(64), { maxItems: 40 }),
});
export type ToolProbeViewType = Static<typeof ToolProbeView>;

/**
 * One selected file, as the operator may see it: an opaque id, its hash, size,
 * type and a display name. Never the path it was selected from or the private
 * copy's location.
 */
export const FileCapabilityView = Obj({
  fileId: Text(64),
  sessionId: Text(128),
  sha256: Text(128),
  bytes: Type.Integer({ minimum: 0 }),
  mediaType: Text(64),
  displayName: Text(200),
  selectedAt: Text(64),
  expiresAt: Text(64),
});
export type FileCapabilityViewType = Static<typeof FileCapabilityView>;

const SessionId = Type.String({ minLength: 8, maxLength: 128, pattern: "^[A-Za-z0-9_-]+$" });
const FileId = Type.String({ pattern: "^file_[0-9a-f]{32}$" });
/** Run ids are issued by this backend and nothing else has their shape. */
const RunId = Type.String({ pattern: "^run_[0-9a-f]{32}$" });
/** One plain filename: no separator, no leading dot, no traversal. */
const ArtifactName = Type.String({ pattern: "^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,127}$" });
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
    "tools.evaluate": {
      kind: "query",
      description:
        "Report what this host implements for each tool the package declares, and how that " +
        "meets the package's own contract. Nothing is called.",
      input: Obj({ sessionId: SessionId }),
      output: Result(ToolRegistryView),
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
        "List run records held by this backend — one session's, or all — and the active one " +
        "if there is any. Used by the page to reconnect to a run after a reload.",
      input: Obj({ sessionId: Type.Optional(SessionId) }),
      output: Result(RunListView),
    },
    "execution.get": {
      kind: "query",
      description: "Read one run record by the id this backend issued for it.",
      input: Obj({ runId: RunId }),
      output: Result(Nullable(RunRecordView)),
    },
    "execution.readiness": {
      kind: "query",
      description:
        "Whether a Run could start right now for this session's run plan: the same preflight " +
        "execution.start performs — plan identity and readiness, package bytes, signer, " +
        "trust, authorization and its remaining lifetime, tool bindings and the bound model — " +
        "run without starting anything.",
      input: Obj({ sessionId: SessionId }),
      output: Result(RunReadinessView),
    },
    "execution.validate-input": {
      kind: "query",
      description:
        "Check one proposed task against the package's own declared input schema, with the " +
        "control plane's offline validator. Nothing is started and nothing is stored.",
      input: Obj({ sessionId: SessionId, input: Type.Unknown() }),
      output: Result(InputValidationView),
    },
    "execution.artifact": {
      kind: "query",
      description:
        "Read one named artifact a run wrote, bounded. The run directory's path is never " +
        "returned; only the artifact's content is.",
      input: Obj({ runId: RunId, name: ArtifactName }),
      output: Result(RunArtifactContentView),
    },
    "execution.artifact-chunk": {
      kind: "query",
      description:
        "Read one bounded base64 slice of a named run artifact, so an artifact larger than a " +
        "view can be downloaded and verified against its SHA-256. Named by run id and plain " +
        "filename only.",
      input: Obj({ runId: RunId, name: ArtifactName, offset: Type.Integer({ minimum: 0 }) }),
      output: Result(RunArtifactChunkView),
    },
    "files.list": {
      kind: "query",
      description:
        "List the local files selected for one package session, by opaque id, hash and " +
        "display name. No path is ever returned.",
      input: Obj({ sessionId: SessionId }),
      output: Result(
        Obj({ files: Type.Array(FileCapabilityView, { maxItems: 16 }) }),
      ),
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
        /** Required for a model-backed plan; a tool probe binds none. */
        modelId: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
        /**
         * `model` is authority to run this package's graph, and needs every
         * declared tool bound. `tool_probe` is authority for one mediated call
         * to one declared tool, and binds no model. They are separate artifacts
         * so that neither can be mistaken for the other.
         */
        executionMode: Type.Optional(
          Type.Union([Type.Literal("model"), Type.Literal("tool_probe")]),
        ),
        /** Required for, and only for, a `tool_probe` plan. */
        probeToolId: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
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
    "execution.tool-probe": {
      kind: "action",
      description:
        "Developer/operator conformance probe for the tool boundary. Re-verifies a ready run " +
        "plan and makes ONE mediated call to one tool the package declares, through the host " +
        "implementation the plan bound. It accepts a tool id and a host-owned fixture id and " +
        "nothing else: no URL, no method, no header, no endpoint and no arguments of its own. " +
        "It is not an agent run — no workflow is instantiated, no graph node executes and no " +
        "model is called — and it is not rendered by the Agent Browser page.",
      input: Obj({
        sessionId: SessionId,
        runPlanId: Type.String({ minLength: 4, maxLength: 128 }),
        runPlanSha256: Type.String({ pattern: "^[0-9a-f]{64}$" }),
        toolId: Type.String({ minLength: 1, maxLength: 200 }),
        /** Which of this host's own fixtures to send. Not a request body. */
        fixtureId: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
        /**
         * For a file-reading tool: which selected-file capability of this
         * session the fixture reads. An opaque id the host issued, never a path.
         */
        fileId: Type.Optional(FileId),
        /**
         * The declared role to attribute the call to, required only when more
         * than one role declares the tool. The runner checks it is one of them.
         */
        role: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
      }),
      output: Result(ToolProbeView),
    },
    "execution.start": {
      kind: "action",
      description:
        "Re-verify a ready run plan and execute the signed package's own workflow.v0 graph " +
        "on the exact model the plan bound. It accepts the workflow input and selected-file " +
        "ids and nothing else: no prompt, no system text, no model id, no tool binding, no " +
        "skill text and no output schema, all of which come from the signed package and the " +
        "run plan. The page's Run action calls it detached; it spends real tokens.",
      input: Obj({
        sessionId: SessionId,
        runPlanId: Type.String({ minLength: 4, maxLength: 128 }),
        runPlanSha256: Type.String({ pattern: "^[0-9a-f]{64}$" }),
        /**
         * The package's own declared input schema is what validates this, in
         * the runner, before any package instruction reaches a model.
         */
        input: Type.Unknown(),
        /**
         * Selected-file capabilities of this session the run may read, by
         * opaque id. A file-reading tool can read these and nothing else.
         */
        files: Type.Optional(Type.Array(FileId, { maxItems: 16 })),
        /**
         * Return as soon as the runner has bound the plan and started, with the
         * record in `running`; follow it with `execution.get`. Refusals before
         * the run starts are still returned here. Defaults to waiting.
         */
        detach: Type.Optional(Type.Boolean()),
      }),
      output: Result(RunRecordView),
    },
    "files.select-local": {
      kind: "action",
      description:
        "Select one local PDF inside an operator-configured directory for a package session. " +
        "The host copies its bytes once into private storage and returns an opaque id, a " +
        "SHA-256 and a size; the path never reaches a package, a run plan, an audit or a " +
        "result.",
      input: Obj({
        sessionId: SessionId,
        path: Type.String({ minLength: 1, maxLength: 4096 }),
      }),
      output: Result(FileCapabilityView),
    },
    "files.release": {
      kind: "action",
      description: "Forget one selected file and delete its private copy.",
      input: Obj({ sessionId: SessionId, fileId: FileId }),
      output: Result(Obj({ fileId: Text(64), released: Type.Boolean() })),
    },
    "execution.cancel": {
      kind: "action",
      description:
        "Ask a running workflow to stop. Workers are cancelled, pending model calls are " +
        "aborted at the provider, and the run ends as cancelled with its audit and usage " +
        "intact.",
      input: Obj({ runId: RunId }),
      output: Result(RunRecordView),
    },
    "execution.clear": {
      kind: "action",
      description:
        "Forget finished run records held in memory. A running run is never cleared, and no " +
        "artifact is deleted.",
      input: Obj({
        runId: Type.Optional(RunId),
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
