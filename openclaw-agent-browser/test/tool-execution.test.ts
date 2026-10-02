/**
 * The whole tool stack except the service, end to end.
 *
 * Real `agentpkg browser-serve` control plane, real authorization with real
 * per-tool approvals, real host tool registry, real compatibility evaluation,
 * real run plan with real binding digests, real execution lease, real inherited
 * descriptors, real `agentpkg execution-run` child, real `Runtime.call_tool`,
 * real private `tool.call` frames, real broker — and one stub in place of the
 * remote service's transport, so the suite is deterministic and reaches no
 * network.
 *
 * What is under test is the host's half of the tool boundary: that a
 * declaration is not a binding, a binding is not an approval, an approval is
 * not a permission, and that what finally runs is the one implementation all
 * three agreed on.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { AgentBrowserBackend } from "../src/backend.js";
import type { HostLlm } from "../src/host-llm.js";
import type { ModelHost } from "../src/host-models.js";
import type { HttpTransport } from "../src/tool-broker.js";
import { BUILT_IN_BINDINGS, type ToolBindingDefinition } from "../src/tool-registry.js";
import { AGENTPKG_BIN, DIST, HOST_CONFIG_WITH_MODEL_OVERRIDE, hasAgentpkg } from "./fixtures.js";
import { makePdf } from "./pdf.js";

// The broker resolves a tool's host before it calls the stubbed transport. Answer
// that lookup here with the public address the broker's unit tests use, so this
// suite needs neither DNS nor the hosted Citation Resolver's domain.
vi.mock("node:dns", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:dns")>();
  const lookup = (
    _hostname: string,
    _options: unknown,
    callback: (error: Error | null, addresses: { address: string; family: number }[]) => void,
  ) => callback(null, [{ address: "93.184.216.34", family: 4 }]);
  return { ...actual, lookup, default: { ...actual.default, lookup } };
});

const runs = hasAgentpkg();
const log = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
const REVIEW = join(DIST, "literature-review.agent.pkg");

/**
 * The implementations this plugin ships, copied so one test can change a
 * binding in place and prove the plan that approved it goes stale.
 */
const DEFINITIONS: ToolBindingDefinition[] = [...BUILT_IN_BINDINGS];

/**
 * A host that implements only one of the review package's three tools. Code,
 * supplied through the backend's test seam: the refusal of a partially bound
 * package is still a property worth proving now that this plugin ships all
 * three.
 */
const RESOLVER_ONLY: ToolBindingDefinition[] = BUILT_IN_BINDINGS.filter(
  (definition) => definition.toolId === "citation-resolver" || definition.toolId === "test.echo",
);

const RESOLVED = {
  status: "resolved",
  query: "10.1038/nphys1170",
  detected_type: "doi",
  message: "Resolved from a stubbed transport.",
  best_match: {
    title: "A stubbed record",
    source: "crossref",
    doi: "10.1038/nphys1170",
    authors: [{ name: "A. Person" }],
    year: 2009,
    bibtex: "@article{stub, title={A stubbed record}}",
  },
  match_score: 1,
  alternatives: [],
  sources: [{ provider: "crossref", status: "ok" }],
  warnings: [],
};

type Row = Record<string, unknown>;
const BIG: Row = {
  id: "big",
  name: "Big Model",
  provider: "acme",
  reasoning: true,
  input: ["text"],
  contextWindow: 400_000,
  contextTokens: 200_000,
  compat: { supportsTools: true, supportsJsonSchemaResponseFormat: true },
};

function makeHost(): ModelHost {
  return {
    config: HOST_CONFIG_WITH_MODEL_OVERRIDE,
    runtimeVersion: "2026.9.5",
    browse: async () => ({
      byProvider: new Map([["acme", new Set(["big"])]]),
      modelCatalog: [BIG] as never,
      modelNames: new Map([["acme/big", "Big Model"]]),
    }),
  };
}

const llm: HostLlm = {
  complete: async () => {
    throw new Error("the tool probe must not reach a model");
  },
};

let stateDir = "";
let backend: AgentBrowserBackend;
let seen: Parameters<HttpTransport>[0][] = [];

const transport: HttpTransport = async (options) => {
  seen.push(options);
  return {
    status: 200,
    contentType: "application/json",
    body: JSON.stringify(RESOLVED),
  };
};

function unwrap<T>(
  result: { ok: true; value: T } | { ok: false; error: { code: string; detail?: string } },
): T {
  if (!result.ok) {
    throw new Error(`expected ok, got ${result.error.code}: ${result.error.detail ?? ""}`);
  }
  return result.value;
}

function expectError(
  result: { ok: true; value: unknown } | { ok: false; error: { code: string; detail?: string } },
) {
  if (result.ok) throw new Error("expected a failure");
  return result.error;
}

/** Open, trust, authorize (permissions and tools), evaluate, prepare. */
async function prepared(options: { approveTools?: boolean } = {}) {
  const view = unwrap(await backend.openLocal(REVIEW));
  await backend.pinSessionPublisher(view.sessionId, view.publisher.signerFingerprint!, "publisher");
  const refreshed = unwrap(await backend.getPackage(view.sessionId));
  const permissions = unwrap(await backend.getPermissions(view.sessionId));
  const receipt = unwrap(
    await backend.authorize(
      view.sessionId,
      refreshed.identity.digest,
      permissions.permissions.map((item) => ({
        permissionId: item.id,
        decision: "session" as const,
      })),
      permissions.toolApprovals.map((item) => ({
        toolId: item.toolId,
        approved: options.approveTools !== false,
      })),
    ),
  );
  const tools = unwrap(await backend.evaluateTools(view.sessionId));
  await backend.evaluateModels(view.sessionId);
  return { sessionId: view.sessionId, digest: refreshed.identity.digest, receipt, tools };
}

describe.runIf(runs)("the host tool broker, end to end", () => {
  beforeAll(async () => {
    stateDir = await mkdtemp(join(tmpdir(), "agent-browser-tools-"));
    await mkdir(join(stateDir, "selectable"));
    backend = new AgentBrowserBackend({
      config: {
        agentpkgPath: AGENTPKG_BIN,
        localPackages: { roots: [DIST] },
        localFiles: { roots: [join(stateDir, "selectable")] },
      },
      logger: log,
      stateDir,
      modelHost: makeHost(),
      llm,
      toolDefinitions: DEFINITIONS,
      toolTransport: transport,
    });
    await backend.initialize();
  }, 120_000);

  afterAll(async () => {
    await backend?.stop();
    if (stateDir) await rm(stateDir, { recursive: true, force: true });
  }, 60_000);

  it("reports what this host implements for each declared tool", async () => {
    const { sessionId, tools } = await prepared();
    expect(tools.allToolsBound).toBe(true);
    expect(tools.counts.bound).toBe(3);
    const resolver = tools.tools.find((tool) => tool.toolId === "citation-resolver")!;
    expect(resolver.status).toBe("bound");
    expect(resolver.remote).toBe(true);
    expect(resolver.approved).toBe(true);
    expect(resolver.permissionsGranted).toBe(true);
    expect(resolver.usable).toBe(true);
    expect(resolver.binding!.bindingSha256).toHaveLength(64);
    expect(resolver.binding!.endpointPath).toBe("/resolve");
    expect(resolver.binding!.method).toBe("POST");
    expect(resolver.binding!.credentialsRequired).toBe(false);
    // Every check carries its own verdict, so a UI explains rather than asserts.
    expect(resolver.binding!.checks.every((check) => check.status === "satisfied")).toBe(true);
    await backend.closeSession(sessionId);
  }, 120_000);

  it("binds exactly one implementation per tool into an immutable plan", async () => {
    const { sessionId, digest, receipt } = await prepared();
    const state = unwrap(
      await backend.prepareRunPlan(sessionId, digest, receipt.receiptId, "acme/big"),
    );
    const plan = state.plan!;
    expect(plan.toolBindings.map((item) => item.toolId).sort()).toEqual([
      "citation-resolver",
      "paper-reader",
      "scholarly-search",
    ]);
    const resolver = plan.toolBindings.find((item) => item.toolId === "citation-resolver")!;
    expect(resolver.bindingId).toBe("openclaw:citation-resolver:1");
    expect(resolver.bindingSha256).toHaveLength(64);
    expect(resolver.approved).toBe(true);
    expect(resolver.remote).toBe(true);
    expect(resolver.endpointOrigin).toBe(
      "https://webagents-citation-resolver-production.up.railway.app",
    );
    expect(resolver.credentialsConfigured).toBe(false);
    expect(plan.toolRegistry!.registrySha256).toHaveLength(64);
    expect(state.preflight).toMatchObject({ toolBindingsCurrent: true, toolBindingsBound: 3 });
    // No credential-shaped value anywhere in the artifact the page receives.
    const text = JSON.stringify(plan).toLowerCase();
    for (const forbidden of ["bearer", "secret", "password", "api_key", "authorization:"]) {
      expect(text).not.toContain(forbidden);
    }
    await backend.closeSession(sessionId);
  }, 120_000);

  it("refuses a plan when a declared tool was not approved", async () => {
    const { sessionId, digest, receipt } = await prepared({ approveTools: false });
    const error = expectError(
      await backend.prepareRunPlan(sessionId, digest, receipt.receiptId, "acme/big"),
    );
    expect(error.code).toBe("run_plan_refused");
    expect(error.detail).toContain("not explicitly approved");
    await backend.closeSession(sessionId);
  }, 120_000);

  it("makes one mediated call through the bound implementation, and nothing else", async () => {
    seen = [];
    const { sessionId, digest, receipt } = await prepared();
    const state = unwrap(
      await backend.prepareRunPlan(sessionId, digest, receipt.receiptId, "acme/big"),
    );
    const plan = state.plan!;
    const report = unwrap(
      await backend.probeTool(
        sessionId,
        plan.runPlanId,
        plan.runPlanSha256,
        "citation-resolver",
        "doi",
      ),
    );

    expect(report.status).toBe("ok");
    expect(report.tool.id).toBe("citation-resolver");
    expect(report.binding.bindingId).toBe("openclaw:citation-resolver:1");
    expect(report.binding.bindingSha256).toBe(
      plan.toolBindings.find((item) => item.toolId === "citation-resolver")!.bindingSha256,
    );
    expect(report.fixture).toEqual({ id: "doi", source: "host_owned", fileId: null });
    expect(report.authority.role).toBe("CitationWorker");
    expect(report.authority.approved).toBe(true);

    // One tool call, one remote call, no tokens, no model, no workflow.
    expect(report.usage.toolCalls).toBe(1);
    expect(report.usage.remoteCalls).toBe(1);
    expect(report.usage.tokens).toBe(0);
    expect(report.packageExecution).toMatchObject({
      workflowInstantiated: false,
      workflowNodesExecuted: 0,
      workflowWorkersStarted: 0,
      modelCalls: 0,
      modelRouterInstalled: false,
      packageInstructionsLoaded: false,
      runtimeWorkerContexts: 1,
    });
    expect(report.audit.chainValid).toBe(true);
    expect(report.audit.actions.find((item) => item.action === "tool.completed")?.count).toBe(1);
    expect(report.audit.actions.some((item) => item.action.startsWith("model."))).toBe(false);

    // The result validated against the package's own declared output schema.
    expect(report.result.validatedByRuntime).toBe(true);
    expect(report.result.validatedAgainst).toBe("schemas/resolver-output.schema.json");
    expect((report.result.output as Record<string, unknown>).status).toBe("resolved");

    // Exactly one request, to exactly the binding's destination, with a fixed
    // header set and no credential.
    expect(seen).toHaveLength(1);
    expect(seen[0]!.hostname).toBe("webagents-citation-resolver-production.up.railway.app");
    expect(seen[0]!.path).toBe("/resolve");
    expect(seen[0]!.method).toBe("POST");
    expect(seen[0]!.headers.authorization).toBeUndefined();
    expect(JSON.parse(seen[0]!.body!)).toEqual({
      query: "10.1038/nphys1170",
      query_type: "doi",
      format: "bibtex",
    });

    await backend.closeSession(sessionId);
  }, 180_000);

  it("refuses to probe a tool the plan did not bind, and an unknown fixture", async () => {
    const { sessionId, digest, receipt } = await prepared();
    const plan = unwrap(
      await backend.prepareRunPlan(sessionId, digest, receipt.receiptId, "acme/big"),
    ).plan!;
    const undeclared = expectError(
      await backend.probeTool(sessionId, plan.runPlanId, plan.runPlanSha256, "secret-admin-tool"),
    );
    expect(undeclared.code).toBe("execution_refused");
    const unknownFixture = expectError(
      await backend.probeTool(
        sessionId,
        plan.runPlanId,
        plan.runPlanSha256,
        "citation-resolver",
        "nope",
      ),
    );
    expect(unknownFixture.code).toBe("invalid_request");
    // A file-reading fixture without a selected file cannot be probed at all:
    // the host never invents one.
    const noFile = expectError(
      await backend.probeTool(sessionId, plan.runPlanId, plan.runPlanSha256, "paper-reader"),
    );
    expect(noFile.code).toBe("invalid_request");
    // And a file id that is not a capability of this session is refused.
    const foreign = expectError(
      await backend.probeTool(
        sessionId,
        plan.runPlanId,
        plan.runPlanSha256,
        "paper-reader",
        "selected-pdf",
        `file_${"0".repeat(32)}`,
        "ScreeningWorker",
      ),
    );
    expect(foreign.code).toBe("invalid_request");
    await backend.closeSession(sessionId);
  }, 180_000);

  it("reads exactly the selected PDF through the real runner, the real broker and the real parser", async () => {
    const { sessionId, digest, receipt } = await prepared();
    const data = makePdf([["A selected page for the end-to-end reader test."], "Its second page."]);
    const path = join(stateDir, "selectable", "selected.pdf");
    await writeFile(path, data);
    const selected = unwrap(await backend.selectFile(sessionId, path));
    expect(selected.fileId).toMatch(/^file_[0-9a-f]{32}$/u);
    expect(JSON.stringify(selected)).not.toContain(stateDir);
    expect(unwrap(await backend.listFiles(sessionId)).files.map((file) => file.fileId)).toEqual([
      selected.fileId,
    ]);
    const plan = unwrap(
      await backend.prepareRunPlan(sessionId, digest, receipt.receiptId, "", "tool_probe", "paper-reader"),
    ).plan!;
    // Two roles declare the reader, so the operator names one.
    const report = unwrap(
      await backend.probeTool(
        sessionId,
        plan.runPlanId,
        plan.runPlanSha256,
        "paper-reader",
        "selected-pdf",
        selected.fileId,
        "EvidenceWorker",
      ),
    );
    expect(report.status).toBe("ok");
    expect(report.authority.role).toBe("EvidenceWorker");
    expect(report.authority.roleNamedByHost).toBe(true);
    expect(report.fixture).toEqual({ id: "selected-pdf", source: "host_owned", fileId: selected.fileId });
    expect(report.usage).toEqual({ toolCalls: 1, remoteCalls: 0, tokens: 0 });
    expect(report.result.validatedAgainst).toBe("schemas/reader-output.schema.json");
    const output = report.result.output as { pages: Array<{ page: number; text: string }>; sha256: string };
    expect(output.sha256).toBe(selected.sha256);
    expect(output.pages.map((page) => page.page)).toEqual([1, 2]);
    expect(output.pages[0]!.text).toContain("A selected page for the end-to-end reader test.");
    // No path anywhere in what the caller receives.
    expect(JSON.stringify(report)).not.toContain(stateDir);
    // Released with the session.
    await backend.closeSession(sessionId);
  }, 180_000);

  it("makes a plan stale when the implementation behind a binding changes", async () => {
    const { sessionId, digest, receipt } = await prepared();
    const plan = unwrap(
      await backend.prepareRunPlan(sessionId, digest, receipt.receiptId, "acme/big"),
    ).plan!;
    expect(plan.readiness.ready).toBe(true);
    const before = plan.toolBindings.find((item) => item.toolId === "citation-resolver")!;

    // The implementation behind the binding changes. Same tool, same binding
    // id, a different thing — so the plan that approved the old one is stale
    // rather than quietly retargeted.
    const index = DEFINITIONS.findIndex((item) => item.toolId === "citation-resolver");
    const original = DEFINITIONS[index]!;
    DEFINITIONS[index] = { ...original, timeoutSeconds: 11 };
    try {
      const evaluated = unwrap(await backend.evaluateTools(sessionId));
      const after = evaluated.tools.find((tool) => tool.toolId === "citation-resolver")!;
      expect(after.binding!.bindingSha256).not.toBe(before.bindingSha256);

      const state = unwrap(await backend.getRunPlan(sessionId));
      expect(state.preflight!.stale).toBe(true);
      expect(state.preflight!.toolBindingsCurrent).toBe(false);
      expect(state.preflight!.staleReasons.some((item) => item.code.startsWith("tool_"))).toBe(
        true,
      );

      const error = expectError(
        await backend.probeTool(
          sessionId,
          plan.runPlanId,
          plan.runPlanSha256,
          "citation-resolver",
          "doi",
        ),
      );
      expect(error.code).toBe("run_plan_stale");
      expect(error.detail).toMatch(/changed|no longer|different/u);
    } finally {
      DEFINITIONS[index] = original;
    }
    await backend.closeSession(sessionId);
  }, 180_000);

  it("makes a plan stale when an approval is withdrawn", async () => {
    const { sessionId, digest, receipt } = await prepared();
    const plan = unwrap(
      await backend.prepareRunPlan(sessionId, digest, receipt.receiptId, "acme/big"),
    ).plan!;
    const permissions = unwrap(await backend.getPermissions(sessionId));
    // Re-authorizing with one tool unapproved supersedes the plan outright,
    // which is the same answer by a shorter route: consent moved.
    unwrap(
      await backend.authorize(
        sessionId,
        digest,
        permissions.permissions.map((item) => ({
          permissionId: item.id,
          decision: "session" as const,
        })),
        permissions.toolApprovals.map((item) => ({
          toolId: item.toolId,
          approved: item.toolId !== "citation-resolver",
        })),
      ),
    );
    const error = expectError(
      await backend.probeTool(
        sessionId,
        plan.runPlanId,
        plan.runPlanSha256,
        "citation-resolver",
        "doi",
      ),
    );
    expect(["run_plan_absent", "run_plan_stale", "probe_refused"]).toContain(error.code);
    await backend.closeSession(sessionId);
  }, 180_000);
});

describe.runIf(runs)("a tool probe is authority for one call, not for a run", () => {
  /**
   * This backend registers one of the review package's three tools, so the
   * package has one bound tool and two unbound ones. A model-backed plan is
   * refused, and a tool probe plan for the bound tool is prepared and used.
   * Neither can stand in for the other, and that is the whole point of the two
   * modes. (The plugin now ships all three; the restriction is a test seam.)
   */
  let shipped: AgentBrowserBackend;
  let shippedState = "";

  beforeAll(async () => {
    shippedState = await mkdtemp(join(tmpdir(), "agent-browser-probe-"));
    shipped = new AgentBrowserBackend({
      config: { agentpkgPath: AGENTPKG_BIN, localPackages: { roots: [DIST] } },
      logger: log,
      stateDir: shippedState,
      modelHost: makeHost(),
      llm,
      toolDefinitions: RESOLVER_ONLY,
      toolTransport: transport,
    });
    await shipped.initialize();
  }, 120_000);

  afterAll(async () => {
    await shipped?.stop();
    if (shippedState) await rm(shippedState, { recursive: true, force: true });
  }, 60_000);

  async function authorized() {
    const view = unwrap(await shipped.openLocal(REVIEW));
    await shipped.pinSessionPublisher(
      view.sessionId,
      view.publisher.signerFingerprint!,
      "publisher",
    );
    const refreshed = unwrap(await shipped.getPackage(view.sessionId));
    const permissions = unwrap(await shipped.getPermissions(view.sessionId));
    const receipt = unwrap(
      await shipped.authorize(
        view.sessionId,
        refreshed.identity.digest,
        permissions.permissions.map((item) => ({
          permissionId: item.id,
          decision: "session" as const,
        })),
        permissions.toolApprovals.map((item) => ({ toolId: item.toolId, approved: true })),
      ),
    );
    await shipped.evaluateTools(view.sessionId);
    await shipped.evaluateModels(view.sessionId);
    return { sessionId: view.sessionId, digest: refreshed.identity.digest, receipt };
  }

  it("prepares a probe plan for a package this host cannot run", async () => {
    seen = [];
    const { sessionId, digest, receipt } = await authorized();

    // A run is refused, by name, because two tools have no implementation here.
    const refused = expectError(
      await shipped.prepareRunPlan(sessionId, digest, receipt.receiptId, "acme/big"),
    );
    expect(refused.code).toBe("run_plan_refused");
    expect(refused.detail).toMatch(/paper-reader|scholarly-search/u);

    // One mediated call to the one bound tool is a different, smaller thing.
    const state = unwrap(
      await shipped.prepareRunPlan(
        sessionId,
        digest,
        receipt.receiptId,
        "",
        "tool_probe",
        "citation-resolver",
      ),
    );
    const plan = state.plan!;
    expect(plan.execution.mode).toBe("tool_probe");
    expect(plan.execution.probeToolId).toBe("citation-resolver");
    // No model is bound at all, so no router can be built from this artifact.
    expect(plan.modelBinding).toBeNull();
    expect(plan.toolBindings.map((item) => item.toolId)).toEqual(["citation-resolver"]);
    expect(plan.readiness.ready).toBe(true);

    const report = unwrap(
      await shipped.probeTool(
        sessionId,
        plan.runPlanId,
        plan.runPlanSha256,
        "citation-resolver",
        "doi",
      ),
    );
    expect(report.status).toBe("ok");
    expect(report.usage.toolCalls).toBe(1);
    expect(report.usage.remoteCalls).toBe(1);
    expect(report.usage.tokens).toBe(0);
    expect(report.packageExecution.modelRouterInstalled).toBe(false);
    expect(report.packageExecution.modelCalls).toBe(0);
    expect(report.packageExecution.workflowInstantiated).toBe(false);
    expect(report.result.validatedByRuntime).toBe(true);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.path).toBe("/resolve");
    await shipped.closeSession(sessionId);
  }, 180_000);

  it("refuses to run a workflow under a probe plan", async () => {
    const { sessionId, digest, receipt } = await authorized();
    const plan = unwrap(
      await shipped.prepareRunPlan(
        sessionId,
        digest,
        receipt.receiptId,
        "",
        "tool_probe",
        "citation-resolver",
      ),
    ).plan!;
    const error = expectError(
      await shipped.startExecution(sessionId, plan.runPlanId, plan.runPlanSha256, {
        question: "anything",
        seeds: [],
        documents: {},
        mode: "live",
      }),
    );
    // Refused before a lease is issued: the plan's authority is the wrong kind.
    expect(["probe_refused", "run_plan_stale", "execution_refused"]).toContain(error.code);
    await shipped.closeSession(sessionId);
  }, 180_000);

  it("refuses a probe plan for a tool this host cannot implement", async () => {
    const { sessionId, digest, receipt } = await authorized();
    const error = expectError(
      await shipped.prepareRunPlan(
        sessionId,
        digest,
        receipt.receiptId,
        "",
        "tool_probe",
        "scholarly-search",
      ),
    );
    expect(error.code).toBe("run_plan_refused");
    expect(error.detail).toContain("scholarly-search");
    await shipped.closeSession(sessionId);
  }, 180_000);
});
