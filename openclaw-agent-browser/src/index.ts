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
    execution: {
      type: "object",
      additionalProperties: false,
      description:
        "Trusted host bounds for one run. Each one can only lower what a package already " +
        "declares; none of them can raise a package's own budget.",
      properties: {
        totalTokens: {
          type: "integer",
          minimum: 1,
          maximum: 10000000,
          description: "Upper bound on total tokens for one run.",
        },
        maxRemoteCalls: {
          type: "integer",
          minimum: 1,
          maximum: 10000,
          description: "Upper bound on remote calls for one run.",
        },
        maxParallelWorkers: {
          type: "integer",
          minimum: 1,
          maximum: 64,
          description: "Upper bound on simultaneously active workers.",
        },
        maxOutputTokensPerCall: {
          type: "integer",
          minimum: 1,
          maximum: 200000,
          description:
            "Ceiling on one call's output cap. A graph node asking for more is refused; its " +
            "declared cap is never silently lowered.",
        },
        runTimeoutSeconds: {
          type: "integer",
          minimum: 1,
          maximum: 86400,
          description: "Upper bound on a run's wall-clock time, tightening the graph deadline.",
        },
        requireVerifiedHostRuntime: {
          type: "boolean",
          description:
            "Refuse to run on an OpenClaw release this project's token accounting was not " +
            "verified against. Defaults to true.",
        },
        maxCallsPerTool: {
          type: "integer",
          minimum: 1,
          maximum: 10000,
          description:
            "Ceiling on how often one run may call any one tool. Lowers a package's own " +
            "per-tool cap; it can never raise one.",
        },
        maxToolResponseBytes: {
          type: "integer",
          minimum: 1024,
          maximum: 4194304,
          description: "Ceiling on one tool response, applied to every binding's own limit.",
        },
      },
    },
    tools: {
      type: "object",
      additionalProperties: false,
      description:
        "Which tool implementations this host offers. A package declares what it needs; " +
        "these entries say what this host will actually run for it. Configuration can " +
        "disable, relabel, retarget or bound a built-in implementation; it cannot add one, " +
        "because a registry entry is a claim that code in this plugin can serve it.",
      properties: {
        enabled: {
          type: "boolean",
          description:
            "Whether this host brokers package tools at all. Defaults to true; false means " +
            "no package that declares a tool can run here.",
        },
        bindings: {
          type: "array",
          maxItems: 32,
          description: "Per-tool configuration, matched to a built-in implementation by toolId.",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["toolId"],
            properties: {
              toolId: {
                type: "string",
                maxItems: 200,
                description: "The declared tool id this entry configures.",
              },
              enabled: { type: "boolean", description: "Disable this implementation." },
              origin: {
                type: "string",
                description:
                  "HTTPS origin on port 443, with no path, query or credentials. Remote " +
                  "bindings only. A package whose declared domains do not cover it is " +
                  "refused by the control plane rather than redirected here.",
              },
              path: { type: "string", description: "Absolute request path. Remote bindings only." },
              method: { enum: ["GET", "POST"], description: "Remote bindings only." },
              timeoutSeconds: { type: "integer", minimum: 1, maximum: 120 },
              displayName: { type: "string", maxLength: 200 },
              credentialEnv: {
                type: "string",
                description:
                  "Name of an environment variable this host reads at call time and sends as " +
                  "a bearer token. The value never reaches the package, the run plan, the " +
                  "audit or any report; only whether one is configured does.",
              },
            },
          },
        },
      },
    },
  },
} as const;

const plugin = defineFeaturePlugin({
  contract,
  name: "Agent Browser",
  description:
    "Open, inspect and authorize signed agent packages through the local agentpkg control plane. " +
    "The page itself runs nothing; operator-only execution operations run an authorized " +
    "package's own workflow on the model its run plan bound.",
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
              executionOperations: false,
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
      "tools.evaluate": ({ sessionId }) => active().evaluateTools(sessionId),
      "run-plan.get": ({ sessionId }) => active().getRunPlan(sessionId),
      "run-plan.prepare": ({
        sessionId,
        packageDigest,
        receiptId,
        modelId,
        executionMode,
        probeToolId,
      }) =>
        active().prepareRunPlan(
          sessionId,
          packageDigest,
          receiptId,
          modelId ?? "",
          executionMode ?? "model",
          probeToolId,
        ),
      "run-plan.clear": ({ sessionId }) => active().clearRunPlan(sessionId),
      // Developer/operator only. It is not reachable from the Agent Browser
      // page, has no tool binding, and is not a Run action: see contract.ts.
      "router.probe": ({ sessionId, runPlanId, runPlanSha256 }) =>
        active().probeRouter(sessionId, runPlanId, runPlanSha256),
      // Also developer/operator only, and also absent from the page. These do
      // run a package: `execution.start` executes the signed graph the run plan
      // named, on the model it bound, and spends real tokens.
      // Also developer/operator only. It makes ONE mediated call to one tool
      // the package declares, through the implementation the plan bound, with
      // a host-owned fixture. No workflow, no graph node and no model.
      "execution.tool-probe": ({ sessionId, runPlanId, runPlanSha256, toolId, fixtureId }) =>
        active().probeTool(sessionId, runPlanId, runPlanSha256, toolId, fixtureId),
      "execution.start": ({ sessionId, runPlanId, runPlanSha256, input }) =>
        active().startExecution(sessionId, runPlanId, runPlanSha256, input),
      "execution.cancel": ({ runId }) => active().cancelExecution(runId),
      "execution.get": ({ runId }) => active().getExecution(runId),
      "execution.status": ({ sessionId }) => active().listExecutions(sessionId),
      "execution.artifact": ({ runId, name }) => active().readExecutionArtifact(runId, name),
      "execution.clear": ({ runId, sessionId }) => active().clearExecutions(runId, sessionId),
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
