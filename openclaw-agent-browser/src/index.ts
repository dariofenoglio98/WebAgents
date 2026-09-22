/**
 * Agent Browser plugin backend.
 *
 * Registration is synchronous, as the SDK requires; the long-lived control
 * plane is owned by `api.registerService`, which also gives the Gateway a
 * health reporter for a child that fails after startup.
 */
import { defineFeaturePlugin } from "openclaw/plugin-sdk/feature-plugin";
import { buildJsonPluginConfigSchema } from "openclaw/plugin-sdk/plugin-entry";
import { toolPluginMetadataSymbol } from "openclaw/plugin-sdk/tool-plugin";
import { AgentBrowserBackend, type BackendConfig } from "./backend.js";
import { contract } from "./contract.js";
import type { Logger } from "./service.js";

const SERVICE_ID = "agent-browser:control-plane";

/** Operator configuration. Kept small and explicit; no secrets belong here. */
export const CONFIG_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    agentpkgPath: {
      type: "string",
      description:
        "Absolute path to the agentpkg executable that provides `agentpkg browser-serve`.",
    },
    localPackages: {
      type: "object",
      additionalProperties: false,
      properties: {
        roots: {
          type: "array",
          maxItems: 8,
          items: { type: "string" },
          description: "Absolute directories the Agent Browser may open .agent.pkg files from.",
        },
        includeWorkspace: {
          type: "boolean",
          description: "Also allow the OpenClaw workspace directory. Defaults to true.",
        },
      },
    },
    sessionTtlSeconds: {
      type: "integer",
      minimum: 60,
      maximum: 86400,
      description: "Package session lifetime in the control plane.",
    },
    maxSessions: {
      type: "integer",
      minimum: 1,
      maximum: 32,
      description: "Maximum concurrently open package sessions.",
    },
  },
} as const;

const plugin = defineFeaturePlugin({
  contract,
  name: "Agent Browser",
  description:
    "Open, inspect and authorize signed agent packages through the local agentpkg control plane. " +
    "Nothing is executed.",
  setup(api, events) {
    let backend: AgentBrowserBackend | null = null;
    const logger = api.logger as unknown as Logger;

    const announce = (reason: string) => {
      try {
        events.emit("browser-changed", { reason });
      } catch {
        // The event service is not running yet; the page still polls on demand.
      }
    };

    api.registerService({
      id: SERVICE_ID,
      async start(ctx) {
        const instance = new AgentBrowserBackend({
          config: (api.pluginConfig ?? {}) as BackendConfig,
          logger: (ctx.logger ?? api.logger) as unknown as Logger,
          stateDir: ctx.stateDir,
          workspaceDir: ctx.workspaceDir,
          onChange: announce,
          // Model discovery reads the host's own published catalog. The current
          // config snapshot is preferred over the one captured at registration
          // so a provider configured after startup is visible without a reload.
          modelHost: {
            get config() {
              try {
                return api.runtime?.config?.current?.() ?? api.config;
              } catch {
                return api.config;
              }
            },
            workspaceDir: ctx.workspaceDir,
            runtimeVersion: api.runtime?.version ?? null,
          },
          // The host's own completion runtime, used only by the developer
          // router probe. Reading it through the live `api` keeps OpenClaw's
          // plugin LLM policy — including the operator's allowModelOverride
          // decision — in force on every call.
          llm: {
            complete: (params) =>
              (api.runtime as unknown as { llm: { complete: (p: unknown) => Promise<never> } }).llm.complete(
                params,
              ),
          },
        });
        await instance.initialize();
        backend = instance;
        // Deliberately nonblocking: a missing or slow Python child must not
        // hold up Gateway startup. Failure is reported through serviceHealth
        // and rendered by the page as "unavailable" with Retry.
        void instance.launch(ctx.serviceHealth).then(() => announce("service"));
      },
      async stop() {
        const instance = backend;
        backend = null;
        await instance?.stop();
      },
    });

    const active = () => {
      if (!backend) {
        throw new Error("The Agent Browser service is not running.");
      }
      return backend;
    };

    return {
      "service.status": () =>
        backend
          ? backend.status()
          : {
              state: "stopped" as const,
              detail: "The Agent Browser service has not started yet.",
              since: null,
              starts: 0,
              controlPlane: null,
              sessions: null,
              capabilities: {
                openUrl: false,
                openLocal: false,
                localRoots: [],
                trustPinning: false,
              },
              executionSupported: false as const,
            },
      "service.restart": () => active().restart(),
      "packages.list": () => active().listSessions(),
      "packages.get": ({ sessionId }) => active().getPackage(sessionId),
      "packages.permissions": ({ sessionId }) => active().getPermissions(sessionId),
      "packages.authorization": ({ sessionId }) => active().getAuthorization(sessionId),
      "packages.open-url": ({ url }) => active().openUrl(url),
      "packages.open-local": ({ path }) => active().openLocal(path),
      "packages.close": ({ sessionId }) => active().closeSession(sessionId),
      "packages.authorize": ({ sessionId, packageDigest, decisions, toolApprovals }) =>
        active().authorize(sessionId, packageDigest, decisions, toolApprovals ?? []),
      "models.evaluate": ({ sessionId }) => active().evaluateModels(sessionId),
      "run-plan.get": ({ sessionId }) => active().getRunPlan(sessionId),
      "run-plan.prepare": ({ sessionId, packageDigest, receiptId, modelId, executionMode }) =>
        active().prepareRunPlan(
          sessionId,
          packageDigest,
          receiptId,
          modelId,
          executionMode ?? "model",
        ),
      "run-plan.clear": ({ sessionId }) => active().clearRunPlan(sessionId),
      // Developer/operator only. It is not reachable from the Agent Browser
      // page, has no tool binding, and is not a Run action: see contract.ts.
      "router.probe": ({ sessionId, runPlanId, runPlanSha256 }) =>
        active().probeRouter(sessionId, runPlanId, runPlanSha256),
      "trust.list": () => active().listTrust(),
      "trust.pin-session-publisher": ({ sessionId, signerFingerprint, scope }) =>
        active().pinSessionPublisher(sessionId, signerFingerprint, scope),
      "trust.remove": ({ fingerprint }) => active().removeTrust(fingerprint),
    };
  },
});

/**
 * `defineFeaturePlugin` has no config-schema option in OpenClaw 2026.9.5, and it
 * publishes manifest metadata through the exported `toolPluginMetadataSymbol`
 * as a non-configurable property. Rebuilding the entry from its own property
 * descriptors keeps every piece of SDK-generated authoring metadata (a plain
 * spread would drop the symbol) while declaring this plugin's operator
 * configuration. Pinned to this host version.
 */
const descriptors = Object.getOwnPropertyDescriptors(plugin);
const generated = (descriptors as Record<PropertyKey, PropertyDescriptor>)[
  toolPluginMetadataSymbol
]?.value as Record<string, unknown>;
const entry = Object.defineProperties({} as typeof plugin, {
  ...descriptors,
  configSchema: {
    value: buildJsonPluginConfigSchema(CONFIG_SCHEMA),
    enumerable: true,
    configurable: true,
  },
  [toolPluginMetadataSymbol]: {
    value: { ...generated, configSchema: CONFIG_SCHEMA },
    enumerable: false,
    configurable: true,
  },
});

export default entry;
