/**
 * Fixtures for the Run surface, built from the real shipped package sources.
 *
 * The page renders a form from a package's own input schema and labels its
 * progress from the package's own presentation hints, so these fixtures read
 * both straight from `agents/literature-review` and `agents/meeting-agenda`
 * rather than restating them — a test cannot pass against a shape the
 * package does not actually ship.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type {
  FileCapabilityViewType,
  PackageViewType,
  RunPlanStateViewType,
  RunReadinessViewType,
  RunRecordViewType,
} from "../src/contract.js";
import { projectPresentation } from "../src/project.js";
import { REPO_ROOT, packageView, runPlanStateView } from "./fixtures.js";

type Json = Record<string, unknown>;

function readJson(...parts: string[]): Json {
  return JSON.parse(readFileSync(join(REPO_ROOT, ...parts), "utf8")) as Json;
}

function workflowNodes(graph: Json): PackageViewType["workflow"]["nodes"] {
  return (graph.nodes as Json[]).map((node) => ({
    id: String(node.id),
    type: String(node.type),
    worker: String(node.worker),
    dependsOn: (node.depends_on as string[]) ?? [],
    timeoutSeconds: Number(node.timeout_seconds),
    writes: Object.keys((node.writes as Json) ?? {}),
    task: (node.task as string | undefined) ?? null,
    tool: (node.tool as string | undefined) ?? null,
    maxParallel: (node.max_parallel as number | undefined) ?? null,
    maxItems: (node.max_items as number | undefined) ?? null,
    steps: ((node.steps as Json[] | undefined) ?? []).map((step) => ({
      id: String(step.id),
      type: String(step.type),
      detail: (step.task as string | undefined) ?? (step.tool as string | undefined) ?? null,
    })),
  }));
}

/** The Literature Review 0.2.2 package view, as the page receives it. */
export function literatureView(overrides: Partial<PackageViewType> = {}): PackageViewType {
  const graph = readJson("agents", "literature-review", "graph.json");
  const manifest = readJson("agents", "literature-review", "MANIFEST.agent");
  const schema = readJson("agents", "literature-review", "schemas", "workflow-input.schema.json");
  const base = packageView();
  const presentation = projectPresentation(
    (graph.extensions as Json)["agentpkg:presentation"],
  );
  return packageView({
    identity: { ...base.identity, version: String(manifest.version) },
    publisher: { ...base.publisher, trustStatus: "trusted", trustReason: "operator_pinned_key" },
    tools: ["scholarly-search", "citation-resolver", "paper-reader"].map((id) => ({
      ...base.tools[0]!,
      id,
      permissions: id === "paper-reader" ? ["files.pdfs"] : [id === "citation-resolver" ? "network.citations" : "network.scholarly"],
    })),
    workflow: {
      ...base.workflow,
      nodeCount: (graph.nodes as unknown[]).length,
      nodes: workflowNodes(graph),
      exports: (graph.exports as Json[]).map((item) => ({
        path: String(item.path),
        format: String(item.format),
      })),
      input: {
        schemaPath: "schemas/workflow-input.schema.json",
        schemaSha256: "4".repeat(64),
        bytes: JSON.stringify(schema).length,
        document: schema,
        note: "The package's own declared input schema.",
      },
      presentation,
    },
    warnings: [],
    ...overrides,
  });
}

/** The Meeting Agenda 0.2.1 package view: no presentation hints at all. */
export function agendaView(): PackageViewType {
  const graph = readJson("agents", "meeting-agenda", "graph.json");
  const schema = readJson("agents", "meeting-agenda", "schemas", "input.schema.json");
  const base = packageView();
  return packageView({
    identity: {
      ...base.identity,
      packageId: "org.webagents.meeting-agenda",
      name: "Meeting Agenda Agent",
      version: "0.2.1",
    },
    publisher: { ...base.publisher, trustStatus: "trusted", trustReason: "operator_pinned_key" },
    tools: [],
    workflow: {
      ...base.workflow,
      nodeCount: (graph.nodes as unknown[]).length,
      nodes: workflowNodes(graph),
      exports: [{ path: "agenda.json", format: "json" }],
      input: {
        schemaPath: "schemas/input.schema.json",
        schemaSha256: "5".repeat(64),
        bytes: JSON.stringify(schema).length,
        document: schema,
        note: "",
      },
      presentation: null,
    },
    warnings: [],
  });
}

/** A ready model plan binding every Literature Review tool. */
export function literaturePlan(overrides: Partial<NonNullable<RunPlanStateViewType["preflight"]>> = {}): RunPlanStateViewType {
  const base = runPlanStateView();
  const bindings = ["citation-resolver", "paper-reader", "scholarly-search"].map((toolId) => ({
    ...base.plan!.toolBindings[0]!,
    toolId,
    bindingId: `openclaw:${toolId}:1`,
    displayName:
      toolId === "scholarly-search" ? "Crossref works search" : toolId === "paper-reader" ? "Selected PDF text" : "Citation Resolver",
    implementationKind: toolId === "paper-reader" ? "selected_file" : "json_http",
    requiredPermissionIds: [toolId === "paper-reader" ? "files.pdfs" : toolId === "citation-resolver" ? "network.citations" : "network.scholarly"],
  }));
  return {
    ...base,
    plan: {
      ...base.plan!,
      package: { ...base.plan!.package, version: "0.2.2" },
      modelBinding: {
        ...base.plan!.modelBinding!,
        hostModelId: "ollama/qwen3:30b",
        providerId: "ollama",
        displayName: "Qwen 3 30B",
      },
      toolBindings: bindings,
    },
    preflight: {
      ...base.preflight!,
      ready: true,
      stale: false,
      staleReasons: [],
      blockingReasons: [],
      modelStillAvailable: true,
      toolBindingsCurrent: true,
      toolBindingsBound: 3,
      ...overrides,
    },
    executionSupported: true,
  };
}

export function readiness(overrides: Partial<RunReadinessViewType> = {}): RunReadinessViewType {
  const plan = runPlanStateView().plan!;
  return {
    sessionId: "session-abcdefgh1234",
    checkedAt: "2026-09-26T10:00:00.000Z",
    ready: true,
    executionAvailable: true,
    runPlanId: plan.runPlanId,
    runPlanSha256: plan.runPlanSha256,
    blocker: null,
    checks: ["run_plan_identity", "package_digest", "publisher_trust", "tool_bindings", "model_available"],
    receipt: { expiresAt: "2026-09-26T12:00:00.000Z", remainingSeconds: 6000, requiredSeconds: 4560 },
    activeRunId: null,
    ...overrides,
  };
}

export const RUN_ID = `run_${"a".repeat(32)}`;
export const FILE_ID = `file_${"b".repeat(32)}`;

export function fileCapability(overrides: Partial<FileCapabilityViewType> = {}): FileCapabilityViewType {
  return {
    fileId: FILE_ID,
    sessionId: "session-abcdefgh1234",
    sha256: "c".repeat(64),
    bytes: 20480,
    mediaType: "application/pdf",
    displayName: "defenses.pdf",
    selectedAt: "2026-09-26T10:00:00.000Z",
    expiresAt: "2026-09-26T11:00:00.000Z",
    ...overrides,
  };
}

const LITERATURE_EXPORTS = [
  "related-work.md",
  "bibliography.json",
  "evidence-table.json",
  "unresolved.json",
  "verification.json",
];

/** A run record in any state, shaped exactly like the backend's. */
export function runRecord(overrides: Partial<RunRecordViewType> = {}): RunRecordViewType {
  const plan = runPlanStateView().plan!;
  const artifacts = [...LITERATURE_EXPORTS, "result.json", "audit.json", "usage.json", "provenance.json"].map(
    (name, index) => ({ name, bytes: 1000 + index, sha256: String(index).repeat(64).slice(0, 64) }),
  );
  return {
    runId: RUN_ID,
    sessionId: "session-abcdefgh1234",
    runPlanId: plan.runPlanId,
    runPlanSha256: plan.runPlanSha256,
    runInvocationSha256: "7".repeat(64),
    inputSha256: "8".repeat(64),
    status: "running",
    createdAt: "2026-09-26T10:00:00.000Z",
    startedAt: new Date(Date.now() - 522_000).toISOString(),
    endedAt: null,
    durationMs: null,
    package: {
      packageId: "org.webagents.literature-review",
      name: "Literature Review Agent",
      version: "0.2.2",
      digest: "b".repeat(64),
      archiveSha256: "a".repeat(64),
      executionProfile: "workflow.v0",
    },
    selectedModel: {
      hostModelId: "ollama/qwen3:30b",
      providerId: "ollama",
      modelId: "qwen3:30b",
      displayName: "Qwen 3 30B",
      local: true,
    },
    model: null,
    grants: {
      decisions: [
        { permissionId: "network.scholarly", decision: "session" },
        { permissionId: "files.pdfs", decision: "deny" },
      ],
      grantedPermissionIds: ["network.scholarly"],
    },
    limits: {
      host: {
        totalTokens: 180000,
        maxRemoteCalls: 45,
        maxParallelWorkers: 3,
        maxOutputTokensPerCall: 16000,
        runTimeoutSeconds: 4500,
        modelCallTimeoutSeconds: 1200,
      },
      effectiveDeadlineSeconds: 4500,
    },
    usage: null,
    cost: null,
    audit: null,
    outputSha256: null,
    artifacts: [],
    host: { runtime: "openclaw", runtimeVersion: "2026.9.5", verifiedVersion: "2026.9.5", versionVerified: true },
    deadlineExceeded: false,
    cancelRequested: false,
    errorCode: null,
    errorDetail: null,
    revalidated: ["run_plan_identity", "package_digest", "runner:publisher_signature"],
    packageExecution: {
      workflowInstantiated: true,
      packageInstructionsLoaded: true,
      toolHandlersInstalled: 3,
      toolCalls: 0,
    },
    task: {
      inputBytes: 120,
      input: {
        question: "What defenses have been proposed against prompt injection attacks on LLM-integrated applications?",
        seeds: [],
        documents: {},
        mode: "live",
      },
      attachments: [],
    },
    progress: null,
    tools: [
      { toolId: "citation-resolver", bindingId: "openclaw:citation-resolver:1", bindingSha256: "c".repeat(64), remote: true, calls: 0, displayName: "Citation Resolver" },
      { toolId: "paper-reader", bindingId: "openclaw:paper-reader:1", bindingSha256: "d".repeat(64), remote: false, calls: 0, displayName: "Selected PDF text" },
      { toolId: "scholarly-search", bindingId: "openclaw:scholarly-search:1", bindingSha256: "e".repeat(64), remote: true, calls: 0, displayName: "Crossref works search" },
    ],
    failure: null,
    origin: "live",
    ...(overrides.status && overrides.status !== "running" && overrides.status !== "preparing" ? { artifacts } : {}),
    ...overrides,
  };
}

/** A progress snapshot in the middle of screening, as the runner reports one. */
export function screeningProgress(): NonNullable<RunRecordViewType["progress"]> {
  const worker = (id: string, node: string, state: "completed" | "active", modelCalls = 0, toolCalls = 0) => ({
    id,
    role: id.split(":")[0]!,
    node,
    state,
    modelCalls,
    toolCalls,
    durationMs: state === "completed" ? 4200 : null,
  });
  return {
    updatedAt: "2026-09-26T10:08:42.000Z",
    events: 180,
    lastAction: "model.called",
    activeNodes: ["screening"],
    completedNodes: ["planning", "seed-discovery", "search", "join-search", "normalize"],
    failedNodes: [],
    skippedNodes: [],
    nodesCompleted: 5,
    stepsCompleted: 12,
    workersSpawned: 8,
    workersActive: 2,
    peakParallelWorkers: 3,
    activeWorkers: ["ScreeningWorker:7", "ScreeningWorker:8"],
    modelCallsStarted: 8,
    modelCallsCompleted: 7,
    toolCallsStarted: 3,
    toolCallsCompleted: 3,
    tokens: 41240,
    remoteCalls: 3,
    elapsedMs: 522_000,
    workers: [
      worker("PlanningWorker:1", "planning", "completed", 1),
      worker("SearchWorker:2", "search", "completed", 0, 1),
      worker("SearchWorker:3", "search", "completed", 0, 1),
      worker("SearchWorker:4", "search", "completed", 0, 1),
      worker("PlanningWorker:5", "normalize", "completed", 1),
      worker("ScreeningWorker:6", "screening", "completed", 1),
      worker("ScreeningWorker:7", "screening", "active"),
      worker("ScreeningWorker:8", "screening", "active"),
    ],
  };
}

export const NO_RESULT_TEXT = (() => {
  const graph = readJson("agents", "literature-review", "graph.json");
  const verification = (graph.nodes as Json[]).find((node) => node.id === "verification")!;
  return ((((verification.otherwise as Json).object as Json).related_work as Json).literal as string);
})();
