/**
 * Plugin registration contract against a minimal fake plugin API.
 *
 * This is the seam the Gateway actually drives: session actions with scopes,
 * one background service, and no agent-callable tool.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import plugin from "../src/index.js";
import { contract } from "../src/contract.js";

type Registered = {
  actions: Map<string, { requiredScopes: string[]; handler: (action: unknown) => Promise<unknown> }>;
  services: Map<string, { start: (ctx: unknown) => unknown; stop?: (ctx: unknown) => unknown }>;
  tools: unknown[];
};

function fakeApi(pluginConfig: Record<string, unknown> = {}) {
  const registered: Registered = { actions: new Map(), services: new Map(), tools: [] };
  const api = {
    id: contract.pluginId,
    name: "Agent Browser",
    source: "test",
    registrationMode: "full",
    config: {},
    pluginConfig,
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    registerSessionAction: (registration: Record<string, unknown>) => {
      registered.actions.set(String(registration.id), {
        requiredScopes: registration.requiredScopes as string[],
        handler: registration.handler as (action: unknown) => Promise<unknown>,
      });
    },
    registerService: (service: Record<string, unknown>) => {
      registered.services.set(String(service.id), service as never);
    },
    registerTool: (tool: unknown) => registered.tools.push(tool),
    registerCommand: () => {
      throw new Error("no command surface expected");
    },
  };
  return { api, registered };
}

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

describe("plugin entry", () => {
  it("publishes manifest metadata the host build can read", () => {
    expect(plugin.id).toBe("agent-browser");
    expect(plugin.name).toBe("Agent Browser");
    expect(plugin.description).toContain("The page itself runs nothing");
    const schema = plugin.configSchema.jsonSchema as Record<string, unknown>;
    expect(Object.keys(schema.properties as object)).toEqual([
      "agentpkgPath",
      "localPackages",
      "sessionTtlSeconds",
      "maxSessions",
      "execution",
      "tools",
    ]);
    expect(schema.additionalProperties).toBe(false);
  });

  it("registers every operation with the right scope and no agent tool", () => {
    const { api, registered } = fakeApi();
    plugin.register(api as never);
    expect([...registered.actions.keys()].sort()).toEqual(Object.keys(contract.operations).sort());
    for (const [id, action] of registered.actions) {
      const kind = contract.operations[id as keyof typeof contract.operations].kind;
      expect(action.requiredScopes).toEqual([
        kind === "query" ? "operator.read" : "operator.write",
      ]);
    }
    expect(registered.tools).toHaveLength(0);
  });

  it("owns exactly one background service for the control plane", () => {
    const { api, registered } = fakeApi();
    plugin.register(api as never);
    const ids = [...registered.services.keys()];
    expect(ids).toContain("agent-browser:control-plane");
    // The SDK adds its own event service; this plugin adds one of its own.
    expect(ids.filter((id) => id === "agent-browser:control-plane")).toHaveLength(1);
  });

  it("answers operations only while its service is running", async () => {
    const { api, registered } = fakeApi({ agentpkgPath: "/nonexistent/agentpkg" });
    plugin.register(api as never);
    const status = registered.actions.get("service.status")!;

    const beforeStart = (await status.handler({ payload: {} })) as Record<string, unknown>;
    expect(beforeStart.ok).toBe(true);
    expect((beforeStart.result as Record<string, unknown>).state).toBe("stopped");

    const stateDir = await mkdtemp(join(tmpdir(), "agent-browser-plugin-"));
    dirs.push(stateDir);
    const service = registered.services.get("agent-browser:control-plane")!;
    await service.start({ stateDir, logger: api.logger, config: {} });

    const running = (await status.handler({ payload: {} })) as Record<string, unknown>;
    const view = running.result as Record<string, unknown>;
    expect(view.state).toBe("unconfigured");
    expect(view.executionSupported).toBe(false);
    expect((view.capabilities as Record<string, unknown>).openUrl).toBe(false);

    await service.stop?.({ stateDir, logger: api.logger, config: {} });
    const afterStop = (await status.handler({ payload: {} })) as Record<string, unknown>;
    expect((afterStop.result as Record<string, unknown>).state).toBe("stopped");
  });

  it("validates operation input before the handler sees it", async () => {
    const { api, registered } = fakeApi({ agentpkgPath: "/nonexistent/agentpkg" });
    plugin.register(api as never);
    const open = registered.actions.get("packages.open-url")!;
    const rejected = (await open.handler({ payload: { url: 5 } })) as Record<string, unknown>;
    expect(rejected.ok).toBe(false);
    expect(String(rejected.code)).toBe("INVALID_INPUT");
    const unknownField = (await open.handler({
      payload: { url: "https://packages.example/a.agent.pkg", extra: true },
    })) as Record<string, unknown>;
    expect(unknownField.ok).toBe(false);
  });
});
