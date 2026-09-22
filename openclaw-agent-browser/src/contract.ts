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
  /** Never true in this milestone; the page states it explicitly. */
  executionSupported: Type.Literal(false),
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
