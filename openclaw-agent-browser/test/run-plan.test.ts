/**
 * Model selection and run-plan preparation, end to end against a real
 * `agentpkg browser-serve` child.
 *
 * The OpenClaw catalog is stubbed so the suite is deterministic on any machine;
 * everything downstream of it — requirement semantics, compatibility statuses,
 * permission rules, plan binding, hashing and staleness — is the real control
 * plane answering. Both shipped packages take the identical path.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { AgentBrowserBackend } from "../src/backend.js";
import type { ModelHost } from "../src/host-models.js";
import { AGENTPKG_BIN, DIST, HOST_CONFIG_WITH_MODEL_OVERRIDE, hasAgentpkg } from "./fixtures.js";

const runs = hasAgentpkg();
const log = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
const REVIEW = join(DIST, "literature-review.agent.pkg");
const AGENDA = join(DIST, "meeting-agenda.agent.pkg");

type Row = Record<string, unknown>;

const COMPATIBLE: Row = {
  id: "big",
  name: "Big Model",
  provider: "acme",
  reasoning: true,
  input: ["text", "image"],
  contextWindow: 400_000,
  contextTokens: 200_000,
  compat: { supportsTools: true, supportsJsonSchemaResponseFormat: true },
};
const SMALL: Row = {
  id: "small",
  name: "Small Model",
  provider: "acme",
  reasoning: true,
  contextWindow: 8_000,
  contextTokens: 4_000,
  compat: { supportsTools: true },
};
const SILENT: Row = { id: "silent", name: "Silent Model", provider: "acme" };

/** A stub of exactly the OpenClaw surface `host-models.ts` reads. */
function makeHost(state: { rows: Row[]; offered: string[]; fail?: Error }): ModelHost {
  return {
    config: HOST_CONFIG_WITH_MODEL_OVERRIDE,
    runtimeVersion: "2026.9.5",
    browse: async () => {
      if (state.fail) throw state.fail;
      return {
        byProvider: new Map([["acme", new Set(state.offered)]]),
        modelCatalog: state.rows as never,
        modelNames: new Map(state.rows.map((row) => [`acme/${row.id}`, String(row.name)])),
      };
    },
  };
}

let stateDir = "";
let backend: AgentBrowserBackend;
let hostState: { rows: Row[]; offered: string[]; fail?: Error };

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
): { code: string; detail?: string } {
  if (result.ok) throw new Error("expected a failure");
  return result.error;
}

/** Open, trust the signer, and grant every declared permission. */
async function authorized(path: string) {
  const view = unwrap(await backend.openLocal(path));
  // Narrow scope: the two shipped packages carry two different signer keys, so
  // each pin binds one key to one package id. The pin may already exist from an
  // earlier case, and either way the session must end up trusted.
  await backend.pinSessionPublisher(view.sessionId, view.publisher.signerFingerprint!, "package");
  const refreshed = unwrap(await backend.getPackage(view.sessionId));
  expect(refreshed.publisher.trustStatus).toBe("trusted");
  const permissions = unwrap(await backend.getPermissions(view.sessionId));
  const receipt = unwrap(
    await backend.authorize(
      view.sessionId,
      refreshed.identity.digest,
      permissions.permissions.map((item) => ({
        permissionId: item.id,
        decision: "session" as const,
      })),
      // Approving a tool is a decision of its own; these cases are about the
      // model binding, so they approve every declared tool as well.
      permissions.toolApprovals.map((item) => ({ toolId: item.toolId, approved: true })),
    ),
  );
  return { view: refreshed, receipt };
}

describe.runIf(runs)("model selection and run plans", () => {
  beforeAll(async () => {
    stateDir = await mkdtemp(join(tmpdir(), "agent-browser-runplan-"));
    hostState = { rows: [COMPATIBLE, SMALL, SILENT], offered: ["big", "small", "silent"] };
    backend = new AgentBrowserBackend({
      config: { agentpkgPath: AGENTPKG_BIN, localPackages: { roots: [DIST] } },
      logger: log,
      stateDir,
      modelHost: makeHost(hostState),
    });
    await backend.initialize();
    await backend.launch();
  }, 90_000);

  afterEach(async () => {
    // Sessions are a bounded resource; a failing case must not starve the next.
    for (const open of unwrap(await backend.listSessions()).sessions) {
      await backend.closeSession(open.sessionId);
    }
  });

  afterAll(async () => {
    await backend?.stop();
    await rm(stateDir, { recursive: true, force: true });
  });

  it.each([
    ["literature-review", REVIEW],
    ["meeting-agenda", AGENDA],
  ])("evaluates the same host catalog for %s", async (_name, path) => {
    const { view } = await authorized(path);
    const catalog = unwrap(await backend.evaluateModels(view.sessionId));
    expect(catalog.host.runtime).toBe("openclaw");
    expect(catalog.catalogSha256).toHaveLength(64);
    expect(catalog.requirements.bindingStrategy).toBe("single_model");
    expect(catalog.requirements.hardRequirements.map((item) => item.id).sort()).toEqual([
      "capability:reasoning",
      "capability:structured_output",
      "context_tokens:minimum",
    ]);
    const statuses = Object.fromEntries(
      catalog.models.map((model) => [model.modelId, model.status]),
    );
    expect(statuses["acme/big"]).toBe("compatible");
    expect(statuses["acme/small"]).toBe("incompatible");
    // The silent row states no reasoning capability, so it is neither
    // confirmed nor refuted.
    expect(statuses["acme/silent"]).toBe("unverified");
    expect(catalog.counts).toMatchObject({
      total: 3,
      available: 3,
      compatible: 1,
      unverified: 1,
      incompatible: 1,
    });
    await backend.closeSession(view.sessionId);
  }, 120_000);

  it("explains each requirement instead of asserting a verdict", async () => {
    const { view } = await authorized(AGENDA);
    const catalog = unwrap(await backend.evaluateModels(view.sessionId));
    const small = catalog.models.find((model) => model.modelId === "acme/small")!;
    const context = small.checks.find((check) => check.id === "context_tokens:minimum")!;
    expect(context).toMatchObject({ required: 16000, hostValue: 4000, status: "violated" });
    expect(small.violated).toEqual(["context_tokens:minimum"]);

    const silent = catalog.models.find((model) => model.modelId === "acme/silent")!;
    // The silent row states neither a reasoning capability nor a context size.
    expect(silent.unknown).toEqual(["capability:reasoning", "context_tokens:minimum"]);
    expect(silent.violated).toEqual([]);
    const reasoning = silent.checks.find((c) => c.id === "capability:reasoning")!;
    expect(reasoning).toMatchObject({ hostValue: null, status: "unknown", basis: "absent" });
    // OpenClaw's tool default is host_default; nothing here claims it is declared.
    const structured = silent.checks.find((c) => c.id === "capability:structured_output")!;
    expect(structured.basis).toBe("derived");
    expect(structured.status).toBe("satisfied");
    const big = catalog.models.find((model) => model.modelId === "acme/big")!;
    expect(big.checks.find((c) => c.id === "capability:structured_output")!.basis).toBe("declared");
    expect(big.evidenceStrength).toBe("declared");
    await backend.closeSession(view.sessionId);
  }, 120_000);

  it("reports whether the run mode's own permission was granted", async () => {
    const view = unwrap(await backend.openLocal(REVIEW));
    await backend.pinSessionPublisher(
      view.sessionId,
      view.publisher.signerFingerprint!,
      "publisher",
    );
    const refreshed = unwrap(await backend.getPackage(view.sessionId));
    expect(refreshed.publisher.trustStatus).toBe("trusted");
    const permissions = unwrap(await backend.getPermissions(view.sessionId));
    // Grant everything the package marks required, but not the optional model one.
    const receipt = unwrap(
      await backend.authorize(
        view.sessionId,
        refreshed.identity.digest,
        permissions.permissions
          .filter((item) => item.required)
          .map((item) => ({ permissionId: item.id, decision: "session" as const })),
      ),
    );
    expect(receipt.runnable).toBe(true);

    const catalog = unwrap(await backend.evaluateModels(view.sessionId));
    expect(catalog.authorized).toBe(true);
    expect(catalog.executionModePermissionIds).toEqual(["model.reasoning"]);
    expect(catalog.executionModePermissionsGranted).toBe(false);
    // Models are still listed: the person may inspect before deciding.
    expect(catalog.models.length).toBeGreaterThan(0);

    const refused = expectError(
      await backend.prepareRunPlan(
        view.sessionId,
        refreshed.identity.digest,
        receipt.receiptId,
        "acme/big",
      ),
    );
    expect(refused.code).toBe("run_plan_refused");
    expect(refused.detail).toContain("model.reasoning");
    await backend.closeSession(view.sessionId);
  }, 120_000);

  it("prepares, reads and clears an immutable run plan", async () => {
    // The tool-free package: this host implements one of the three tools the
    // review package declares, so that one cannot reach a ready plan here.
    // "A partially bound package is refused" is its own case, below.
    const { view, receipt } = await authorized(AGENDA);
    const prepared = unwrap(
      await backend.prepareRunPlan(view.sessionId, view.identity.digest, receipt.receiptId, "acme/big"),
    );
    const plan = prepared.plan!;
    expect(plan.runPlanId).toMatch(/^rp_[0-9a-f]{32}$/u);
    expect(plan.runPlanSha256).toHaveLength(64);
    expect(plan.package.digest).toBe(view.identity.digest);
    expect(plan.authorization.receiptId).toBe(receipt.receiptId);
    expect(plan.modelBinding.hostModelId).toBe("acme/big");
    expect(plan.modelBinding.compatibilityStatus).toBe("compatible");
    expect(plan.modelBinding.catalogModelCount).toBe(3);
    expect(plan.execution).toMatchObject({
      mode: "model",
      bindingStrategy: "single_model",
      performed: false,
    });
    expect(plan.readiness.ready).toBe(true);
    // A package that declares no tool binds none, and says so rather than
    // leaving the field absent.
    expect(plan.toolBindings).toEqual([]);
    expect(prepared.preflight).toMatchObject({
      ready: true,
      stale: false,
      modelStillAvailable: true,
      toolBindingsCurrent: true,
      toolBindingsBound: 0,
    });
    expect(prepared.executionSupported).toBe(false);

    const read = unwrap(await backend.getRunPlan(view.sessionId));
    expect(read.plan?.runPlanId).toBe(plan.runPlanId);
    expect(read.plan?.runPlanSha256).toBe(plan.runPlanSha256);

    unwrap(await backend.clearRunPlan(view.sessionId));
    expect(unwrap(await backend.getRunPlan(view.sessionId)).plan).toBeNull();
    await backend.closeSession(view.sessionId);
  }, 120_000);

  it("binds every declared tool when this host implements all of them", async () => {
    const { view, receipt } = await authorized(REVIEW);
    const tools = unwrap(await backend.evaluateTools(view.sessionId));
    expect(tools.allToolsBound).toBe(true);
    expect(tools.counts.bound).toBe(3);
    expect(tools.counts.unbound).toBe(0);
    for (const tool of tools.tools) {
      expect(tool.status, tool.toolId).toBe("bound");
      expect(tool.approved, tool.toolId).toBe(true);
      expect(tool.binding?.bindingSha256, tool.toolId).toHaveLength(64);
      expect(tool.binding?.credentialsConfigured, tool.toolId).toBe(false);
      expect(tool.binding!.checks.every((check) => check.status === "satisfied"), tool.toolId).toBe(
        true,
      );
    }
    const search = tools.tools.find((tool) => tool.toolId === "scholarly-search")!;
    expect(search.binding?.endpointOrigin).toBe("https://api.crossref.org");
    expect(search.binding?.endpointPath).toBe("/works");
    expect(search.binding?.method).toBe("GET");
    const reader = tools.tools.find((tool) => tool.toolId === "paper-reader")!;
    expect(reader.remote).toBe(false);
    expect(reader.binding?.implementationKind).toBe("selected_file");
    expect(reader.binding?.endpointOrigin).toBeNull();

    const state = unwrap(
      await backend.prepareRunPlan(
        view.sessionId,
        view.identity.digest,
        receipt.receiptId,
        "acme/big",
      ),
    );
    expect(state.plan!.readiness.ready).toBe(true);
    expect(state.plan!.toolBindings.map((item) => item.toolId).sort()).toEqual([
      "citation-resolver",
      "paper-reader",
      "scholarly-search",
    ]);
    await backend.closeSession(view.sessionId);
  }, 120_000);

  it("refuses to bind an incompatible model", async () => {
    const { view, receipt } = await authorized(AGENDA);
    const error = expectError(
      await backend.prepareRunPlan(
        view.sessionId,
        view.identity.digest,
        receipt.receiptId,
        "acme/small",
      ),
    );
    expect(error.code).toBe("run_plan_refused");
    expect(error.detail).toMatch(/model requirements/iu);
    await backend.closeSession(view.sessionId);
  }, 120_000);

  it("refuses a model that vanished between listing and preparing", async () => {
    const { view, receipt } = await authorized(AGENDA);
    unwrap(await backend.evaluateModels(view.sessionId));
    // The host stops offering it while the page is open.
    hostState.offered = ["small", "silent"];
    try {
      const error = expectError(
        await backend.prepareRunPlan(
          view.sessionId,
          view.identity.digest,
          receipt.receiptId,
          "acme/big",
        ),
      );
      expect(error.code).toBe("model_unknown");
      expect(error.detail).toContain("no longer offers");
    } finally {
      hostState.offered = ["big", "small", "silent"];
    }
    await backend.closeSession(view.sessionId);
  }, 120_000);

  it("marks a prepared plan stale when its model stops being offered", async () => {
    const { view, receipt } = await authorized(AGENDA);
    unwrap(
      await backend.prepareRunPlan(view.sessionId, view.identity.digest, receipt.receiptId, "acme/big"),
    );
    hostState.offered = ["small"];
    try {
      const state = unwrap(await backend.getRunPlan(view.sessionId));
      expect(state.preflight?.modelStillAvailable).toBe(false);
      expect(state.preflight?.ready).toBe(false);
      expect(state.preflight?.staleReasons.map((item) => item.code)).toContain(
        "model_no_longer_available",
      );
    } finally {
      hostState.offered = ["big", "small", "silent"];
    }
    await backend.closeSession(view.sessionId);
  }, 120_000);

  it("marks a prepared plan stale when publisher trust is withdrawn", async () => {
    const { view, receipt } = await authorized(AGENDA);
    unwrap(
      await backend.prepareRunPlan(view.sessionId, view.identity.digest, receipt.receiptId, "acme/big"),
    );
    // Withdraw the pin on *this* package's signer, not whichever was added first.
    const pinned = unwrap(await backend.listTrust()).publishers.find(
      (item) => item.fingerprint === view.publisher.signerFingerprint,
    )!;
    unwrap(await backend.removeTrust(pinned.fingerprint));
    const state = unwrap(await backend.getRunPlan(view.sessionId));
    expect(state.preflight?.stale).toBe(true);
    expect(state.preflight?.ready).toBe(false);
    const codes = state.preflight!.staleReasons.map((item) => item.code);
    expect(codes).toContain("publisher_trust_changed");
    // The frozen plan still records what was true when consent was given.
    expect(state.plan?.publisher.trustStatus).toBe("trusted");
    await backend.closeSession(view.sessionId);
  }, 120_000);

  it("discards a plan when the package is authorized again", async () => {
    const { view, receipt } = await authorized(AGENDA);
    unwrap(
      await backend.prepareRunPlan(view.sessionId, view.identity.digest, receipt.receiptId, "acme/big"),
    );
    const permissions = unwrap(await backend.getPermissions(view.sessionId));
    unwrap(
      await backend.authorize(
        view.sessionId,
        view.identity.digest,
        permissions.permissions.map((item) => ({
          permissionId: item.id,
          decision: "session" as const,
        })),
      ),
    );
    expect(unwrap(await backend.getRunPlan(view.sessionId)).plan).toBeNull();
    await backend.closeSession(view.sessionId);
  }, 120_000);

  it("reports an unreachable host catalog without inventing an answer", async () => {
    const { view } = await authorized(AGENDA);
    hostState.fail = new Error("model catalog is not ready");
    try {
      const error = expectError(await backend.evaluateModels(view.sessionId));
      expect(error.code).toBe("model_catalog_unavailable");
      expect(error.detail).toContain("model catalog is not ready");
    } finally {
      delete hostState.fail;
    }
    await backend.closeSession(view.sessionId);
  }, 120_000);

  it("never returns a credential or an endpoint through any model operation", async () => {
    const { view, receipt } = await authorized(AGENDA);
    const catalog = unwrap(await backend.evaluateModels(view.sessionId));
    const plan = unwrap(
      await backend.prepareRunPlan(view.sessionId, view.identity.digest, receipt.receiptId, "acme/big"),
    );
    for (const payload of [catalog, plan]) {
      const serialized = JSON.stringify(payload);
      expect(serialized).not.toMatch(/bearer|api[_-]?key|sk-|PRIVATE KEY|127\.0\.0\.1/iu);
      expect(serialized).not.toMatch(/baseUrl|"headers"|authProfile|credential/iu);
      // Nothing that could locate a provider endpoint travels either.
      expect(serialized).not.toMatch(/https?:\/\//u);
    }
    await backend.closeSession(view.sessionId);
  }, 120_000);

  it("exposes no way to execute the prepared plan", async () => {
    const operations = Object.getOwnPropertyNames(Object.getPrototypeOf(backend));
    expect(operations).not.toContain("run");
    expect(operations).not.toContain("execute");
    expect(operations).not.toContain("runRunPlan");
    expect(operations).toContain("prepareRunPlan");
  });
});
