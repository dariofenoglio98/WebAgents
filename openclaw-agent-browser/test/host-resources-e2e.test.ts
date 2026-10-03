/**
 * The host-resource mechanism, end to end, with a package that is not WebAir.
 *
 * A one-node "work hours" package (`agentpkg/tests/resource_fakes.py`, built
 * and signed here under a throwaway key) asks the person's host for one
 * resource of type `personal.work_hours`. The host holds two. Everything
 * between them is real: control plane, authorization with a pick, receipt,
 * run plan, preflight, lease, runner, `Runtime`, bridge, broker, store. The
 * only stand-in is a model that is never called, because the graph has no
 * model step — which is also the point: a host resource reaches a package
 * through a tool and a grant, not through a model.
 */
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AgentBrowserBackend } from "../src/backend.js";
import type { HostLlm } from "../src/host-llm.js";
import type { ModelHost } from "../src/host-models.js";
import { AGENTPKG_BIN, HOST_CONFIG_WITH_MODEL_OVERRIDE, REPO_ROOT, hasAgentpkg } from "./fixtures.js";

const run = promisify(execFile);
const runs = hasAgentpkg();
const PYTHON = join(REPO_ROOT, "agentpkg", ".venv", "bin", "python");
const log = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

const llm: HostLlm = {
  complete: async () => {
    throw new Error("this graph has no model step");
  },
};
const host: ModelHost = {
  config: HOST_CONFIG_WITH_MODEL_OVERRIDE,
  runtimeVersion: "2026.9.5",
  browse: async () => ({
    byProvider: new Map([["acme", new Set(["big"])]]),
    modelCatalog: [
      {
        id: "big",
        name: "Big Model",
        provider: "acme",
        reasoning: true,
        input: ["text"],
        contextWindow: 400_000,
        contextTokens: 200_000,
        compat: { supportsTools: true, supportsJsonSchemaResponseFormat: true },
      },
    ] as never,
    modelNames: new Map([["acme/big", "Big Model"]]),
  }),
};

let stateDir = "";
let artifact = "";
let backend: AgentBrowserBackend;
const resolved: string[] = [];

function unwrap<T>(result: { ok: true; value: T } | { ok: false; error: { code: string; detail?: string } }): T {
  if (!result.ok) throw new Error(`expected ok, got ${result.error.code}: ${result.error.detail ?? ""}`);
  return result.value;
}

async function prepared(decision: "session" | "deny", pick?: string) {
  const view = unwrap(await backend.openLocal(artifact));
  await backend.pinSessionPublisher(view.sessionId, view.publisher.signerFingerprint!, "publisher");
  const digest = unwrap(await backend.getPackage(view.sessionId)).identity.digest;
  const permissions = unwrap(await backend.getPermissions(view.sessionId));
  const receipt = unwrap(
    await backend.authorize(
      view.sessionId,
      digest,
      [
        { permissionId: "calendar.hours", decision },
        { permissionId: "memory.session", decision: "session" },
        { permissionId: "model.any", decision: "session" },
      ],
      permissions.toolApprovals.map((tool) => ({ toolId: tool.toolId, approved: true })),
      pick ? [{ permissionId: "calendar.hours", resourceId: pick }] : [],
    ),
  );
  await backend.evaluateTools(view.sessionId);
  await backend.evaluateModels(view.sessionId);
  const plan = unwrap(await backend.prepareRunPlan(view.sessionId, digest, receipt.receiptId, "acme/big")).plan!;
  return { sessionId: view.sessionId, permissions, receipt, plan };
}

describe.runIf(runs)("a host resource reaches a non-WebAir package only as granted", () => {
  beforeAll(async () => {
    stateDir = await realpath(await mkdtemp(join(tmpdir(), "agent-browser-hours-")));
    const source = join(stateDir, "hours-source");
    await run(PYTHON, ["-c", `import sys; sys.path.insert(0, ${JSON.stringify(join(REPO_ROOT, "agentpkg", "tests"))}); from resource_fakes import hours_source; hours_source(${JSON.stringify(source)})`]);
    const packages = join(stateDir, "packages");
    const keys = join(stateDir, "keys");
    await mkdir(packages);
    await mkdir(keys, { mode: 0o700 });
    artifact = join(packages, "hours.agent.pkg");
    await run(AGENTPKG_BIN, ["keygen", "--private-key", join(keys, "p.pem"), "--public-key", join(keys, "k.pem")]);
    await run(AGENTPKG_BIN, ["build", source, "-o", artifact]);
    await run(AGENTPKG_BIN, ["sign", artifact, "--private-key", join(keys, "p.pem")]);
    // The host's own definition of the type; the package declared the same schema.
    const schema = JSON.parse(readFileSync(join(source, "schemas", "hours.schema.json"), "utf8"));
    backend = new AgentBrowserBackend({
      config: { agentpkgPath: AGENTPKG_BIN, localPackages: { roots: [packages] }, execution: { runTimeoutSeconds: 60 } },
      logger: log,
      stateDir,
      modelHost: host,
      llm,
      hostResources: {
        schema: "openclaw-host-resources-v0",
        types: [
          { id: "personal.work_hours", display_name: "Work hours", permission_kind: "personal.read", schema, sealed_fields: ["/timezone"] },
        ],
        resources: [
          { id: "hours_weekday", type: "personal.work_hours", label: "Weekdays 9–5", value: { start: "09:00", end: "17:00", timezone: "Europe/Zurich" } },
          { id: "hours_early", type: "personal.work_hours", label: "Early 7–3", value: { start: "07:00", end: "15:00", timezone: "America/New_York" } },
        ],
      },
      hostResourceKey: Buffer.alloc(32, 3),
    });
    await backend.initialize();
    const store = backend.hostResourceStore()!;
    const resolve = store.resolve.bind(store);
    store.resolve = (grant) => {
      resolved.push(grant.resource_id);
      return resolve(grant);
    };
  }, 180_000);

  afterAll(async () => {
    await backend?.stop();
    if (stateDir) await rm(stateDir, { recursive: true, force: true });
  }, 60_000);

  it("returns exactly the picked resource to the package, through its tool", async () => {
    const session = await prepared("session", "hours_early");
    const request = session.permissions.permissions.find((item) => item.id === "calendar.hours")!;
    expect(request.hostResource?.options.map((option) => option.label)).toEqual(["Weekdays 9–5", "Early 7–3"]);
    expect(session.plan.resourceGrants.map((grant) => grant.resourceId)).toEqual(["hours_early"]);
    resolved.length = 0;
    const record = unwrap(await backend.startExecution(session.sessionId, session.plan.runPlanId, session.plan.runPlanSha256, {}));
    expect(record.status).toBe("completed");
    expect(resolved).toEqual(["hours_early"]);
    const directory = join(stateDir, "agent-browser", "runs", record.runId);
    const result = JSON.parse(await readFile(join(directory, "result.json"), "utf8"));
    expect(result.output).toEqual({ start: "07:00", end: "15:00", timezone: "America/New_York" });
    const audit = await readFile(join(directory, "audit.json"), "utf8");
    expect(audit).toContain('"resource_id": "hours_early"');
    expect(audit).not.toContain("America/New_York");
    expect(record.resources?.map((grant) => grant.resourceId)).toEqual(["hours_early"]);
    await backend.closeSession(session.sessionId);
  }, 180_000);

  it("resolves nothing when the person denies the permission", async () => {
    const session = await prepared("deny");
    expect(session.plan.resourceGrants).toEqual([]);
    resolved.length = 0;
    const record = unwrap(await backend.startExecution(session.sessionId, session.plan.runPlanId, session.plan.runPlanSha256, {}));
    expect(record.status).toBe("failed");
    expect(record.errorCode).toBe("permission_denied");
    expect(resolved).toEqual([]);
    await backend.closeSession(session.sessionId);
  }, 180_000);
});
