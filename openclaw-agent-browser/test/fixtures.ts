import { readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  PackageViewType,
  PermissionsViewType,
  ReceiptViewType,
  ServiceStatusView,
} from "../src/contract.js";

const here = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(here, "..", "..");
export const AGENTPKG_BIN = join(REPO_ROOT, "agentpkg", ".venv", "bin", "agentpkg");
export const DIST = join(REPO_ROOT, "dist");
export const DEV_KEY_FINGERPRINT =
  "sha256:c7549e614dac7070e6b5b5355e7c2407e1185f831d7fff15670981229dd85a70";

export function hasAgentpkg(): boolean {
  try {
    return readdirSync(join(REPO_ROOT, "agentpkg", ".venv", "bin")).includes("agentpkg");
  } catch {
    return false;
  }
}

export const serviceStatus = (overrides: Partial<ServiceStatusView> = {}): ServiceStatusView => ({
  state: "running",
  detail: "The Agent Browser control plane is running.",
  since: "2026-09-21T10:00:00.000Z",
  starts: 1,
  controlPlane: {
    apiVersion: "v0",
    agentpkgVersion: "0.2.0",
    packageFormat: "agent.pkg 0.1",
    execution: "disabled",
  },
  sessions: { open: 1, max: 8 },
  capabilities: { openUrl: true, openLocal: true, localRoots: ["/packages"], trustPinning: true },
  executionSupported: false,
  ...overrides,
});

export const packageView = (overrides: Partial<PackageViewType> = {}): PackageViewType => ({
  sessionId: "session-abcdefgh1234",
  createdAt: "2026-09-21T10:00:00.000Z",
  expiresAt: "2026-09-21T10:15:00.000Z",
  ttlSeconds: 900,
  source: { kind: "url", display: "https://packages.example/review.agent.pkg" },
  snapshot: { archiveSha256: "a".repeat(64), archiveBytes: 280285 },
  identity: {
    packageId: "org.webagents.literature-review",
    name: "Literature Review Agent",
    version: "0.2.0",
    description: "Discover, screen, verify and synthesize scholarly literature.",
    createdAt: "2026-09-20T00:00:00Z",
    digest: "b".repeat(64),
    specVersion: "0.1",
    entrypoint: "workflow.v0",
    executionProfile: "workflow.v0",
    runtimeApi: "agentpkg-runtime-v0",
    minimumRuntimeVersion: "0.2.0",
  },
  validation: {
    container: "valid",
    integrity: "valid",
    schema: "valid",
    runtime: "compatible",
    supportedProfiles: ["workflow.v0"],
    errors: [],
  },
  publisher: {
    claimedId: "webagents-research",
    claimedName: "WebAgents Research Prototype",
    signatureStatus: "valid",
    signatureReason: "self_consistent_ed25519_signature",
    signerFingerprint: DEV_KEY_FINGERPRINT,
    signedDigestMatches: true,
    trustStatus: "unknown",
    trustReason: "signer_key_not_pinned",
    trustEntry: null,
    pinnedFingerprintsForClaimedPublisher: [],
  },
  capabilities: ["literature-review", "evidence-extraction"],
  skills: [
    { id: "literature-search", version: "0.1.0", path: "skills/literature-search/SKILL.md", bytes: 2048, sha256: "c".repeat(64) },
  ],
  tools: [
    {
      id: "scholarly-search",
      version: "0.1.0",
      description: "Search scholarly metadata.",
      execution: "remote",
      binding: "scholarly.search",
      endpointOrigin: "https://api.crossref.org",
      method: "GET",
      domains: ["api.crossref.org"],
      permissions: ["network.scholarly"],
      sideEffects: "read",
      approvalRequired: false,
      timeoutSeconds: 25,
      inputSchema: "schemas/search-input.schema.json",
      outputSchema: "schemas/search-output.schema.json",
    },
  ],
  workers: [
    {
      id: "LiteratureReviewCoordinator",
      kind: "packaged",
      isCoordinator: true,
      skills: [],
      tools: [],
      maxInstances: 1,
      stateRead: ["research_question"],
      stateWrite: ["draft"],
      budgetTokens: 30000,
      budgetRemoteCalls: 15,
    },
  ],
  workflow: {
    profile: "workflow.v0",
    coordinator: "LiteratureReviewCoordinator",
    deadlineSeconds: 1800,
    nodeCount: 2,
    nodeTypes: [
      { type: "llm", count: 1 },
      { type: "output", count: 1 },
    ],
    entryNodes: ["planning"],
    outputNodes: ["outputs"],
    maxDeclaredParallel: 3,
    nodes: [
      {
        id: "planning",
        type: "llm",
        worker: "PlanningWorker",
        dependsOn: [],
        timeoutSeconds: 120,
        writes: ["search_plan"],
        task: "plan",
        tool: null,
        maxParallel: null,
        maxItems: null,
        steps: [],
      },
    ],
    edges: [{ from: "planning", to: "outputs" }],
    exports: [{ path: "related-work.md", format: "text" }],
    fixtureDeclared: true,
    truncated: false,
  },
  evals: [],
  attestations: [],
  modelRequirements: {
    routing: "host",
    fallbackPolicy: "deny",
    privacy: null,
    latencyPreference: null,
    costSensitivity: null,
    tasks: [
      { id: "plan", capabilities: ["structured_output"], contextWindow: 16000, preferredTier: "reasoning" },
    ],
  },
  budget: {
    estimatedTokens: 24000,
    hardTokens: 180000,
    maxRemoteCalls: 45,
    maxParallelWorkers: 3,
    estimatedCostUsd: null,
    approvalThresholdTokens: null,
    maxCallsPerTool: [{ toolId: "scholarly-search", calls: 3 }],
  },
  delegation: { maxDepth: 1, allowRemote: false, approvedRoles: ["PlanningWorker"] },
  network: {
    allowedDomains: ["api.crossref.org"],
    httpsOnly: true,
    allowRedirects: false,
  },
  memory: { scope: "session", retention: "session", rawDocuments: false, sharing: "explicit_views" },
  payload: { fileCount: 54, totalBytes: 280285 },
  warnings: [
    {
      code: "publisher_unknown",
      severity: "warning",
      message: "The signing key is not pinned in this host's trust store.",
    },
  ],
  authorization: { state: "pending", receiptId: null, runnable: false },
  executionPerformed: false,
  ...overrides,
});

export const permissionsView = (
  overrides: Partial<PermissionsViewType> = {},
): PermissionsViewType => ({
  sessionId: "session-abcdefgh1234",
  packageId: "org.webagents.literature-review",
  packageVersion: "0.2.0",
  packageDigest: "b".repeat(64),
  decisionOptions: ["deny", "once", "session"],
  unsupportedDecisions: [
    { value: "always", reason: "This host has no persistent authorization store." },
  ],
  permissions: [
    {
      id: "network.scholarly",
      kind: "network",
      description: "Read Crossref scholarly metadata.",
      required: true,
      resources: ["api.crossref.org"],
      decision: "deny",
      linkedTools: ["scholarly-search"],
      linkedDomains: ["api.crossref.org"],
    },
    {
      id: "files.pdfs",
      kind: "files.read",
      description: "Read only individually selected local PDF files.",
      required: false,
      resources: ["user-selected-pdfs"],
      decision: "deny",
      linkedTools: ["paper-reader"],
      linkedDomains: [],
    },
  ],
  toolApprovals: [],
  blockingReasons: [
    {
      code: "required_permission_denied",
      message: "Required permission 'network.scholarly' is denied.",
      subject: "network.scholarly",
    },
  ],
  browserPolicy: {
    requireValidSignature: true,
    requireTrustedPublisher: true,
    requireSupportedProfile: true,
  },
  ...overrides,
});

export const receiptView = (overrides: Partial<ReceiptViewType> = {}): ReceiptViewType => ({
  receiptId: "5d1a1f2e-0000-4000-8000-000000000000",
  issuedAt: "2026-09-21T10:05:00.000Z",
  expiresAt: "2026-09-21T10:15:00.000Z",
  sessionId: "session-abcdefgh1234",
  packageId: "org.webagents.literature-review",
  packageName: "Literature Review Agent",
  packageVersion: "0.2.0",
  packageDigest: "b".repeat(64),
  archiveSha256: "a".repeat(64),
  executionProfile: "workflow.v0",
  publisher: {
    claimedId: "webagents-research",
    claimedName: "WebAgents Research Prototype",
    signerFingerprint: DEV_KEY_FINGERPRINT,
    signatureStatus: "valid",
    trustStatus: "trusted",
    trustReason: "operator_pinned_key",
  },
  trustStore: { entryCount: 1, stateSha256: "d".repeat(64) },
  decisions: [{ permissionId: "network.scholarly", decision: "session" }],
  toolApprovals: [],
  grantedPermissionIds: ["network.scholarly"],
  runnable: true,
  blockingReasons: [],
  receiptSha256: "e".repeat(64),
  executionPerformed: false,
  ...overrides,
});
