/**
 * Model discovery: what the plugin reads from OpenClaw, and what it refuses to
 * pass on.
 *
 * The host is stubbed here so the suite is deterministic and never depends on a
 * configured provider. The stub returns the exact shapes OpenClaw 2026.9.5's
 * `buildModelsProviderData` returns; the real call is exercised by hand against
 * a live host and recorded in the milestone report.
 */
import { describe, expect, it } from "vitest";
import { AgentBrowserError } from "../src/errors.js";
import {
  capabilitiesOf,
  discoverHostModels,
  stillAvailable,
  type ModelHost,
} from "../src/host-models.js";
import { HOST_CONFIG_WITH_MODEL_OVERRIDE } from "./fixtures.js";

type Row = Record<string, unknown>;

function host(
  data: {
    catalog?: Row[];
    /** `byProvider` for the host catalog view, i.e. what the host can route. */
    offered?: Record<string, string[]>;
    /** `byProvider` for the picker's default view, when a test cares. */
    picker?: Record<string, string[]>;
    /** Overrides the plugin LLM policy this host grants. */
    config?: unknown;
    names?: Record<string, string>;
    pending?: string[];
    refreshWarning?: string;
    fail?: Error;
    default?: { provider: string; model: string };
  } = {},
): ModelHost {
  const asMap = (rows: Record<string, string[]>) =>
    new Map(Object.entries(rows).map(([provider, models]) => [provider, new Set(models)]));
  return {
    config: data.config ?? HOST_CONFIG_WITH_MODEL_OVERRIDE,
    runtimeVersion: "2026.9.5",
    browse: async (_config, _agentId, options) => {
      if (data.fail) throw data.fail;
      return {
        byProvider: asMap(
          options.view === "all" ? (data.offered ?? {}) : (data.picker ?? data.offered ?? {}),
        ),
        modelCatalog: (data.catalog ?? []) as never,
        modelNames: new Map(Object.entries(data.names ?? {})),
        pendingProviders: data.pending,
        refreshWarning: data.refreshWarning,
        resolvedDefault: data.default,
      };
    },
  };
}

const row = (overrides: Row = {}): Row => ({
  id: "alpha",
  name: "Alpha",
  provider: "acme",
  reasoning: true,
  input: ["text", "image"],
  contextWindow: 400_000,
  contextTokens: 200_000,
  baseUrl: "https://api.acme.example/v1",
  compat: { supportsTemperature: false },
  ...overrides,
});

describe("host model discovery", () => {
  it("reports what the host currently offers as available", async () => {
    const catalog = await discoverHostModels(
      host({
        catalog: [row(), row({ id: "beta", name: "Beta" })],
        offered: { acme: ["alpha"] },
      }),
    );
    expect(catalog.schema).toBe("agentpkg-host-model-catalog-v0");
    expect(catalog.host.runtime).toBe("openclaw");
    expect(catalog.host.source).toContain("buildModelsProviderData");
    expect(catalog.models.map((model) => model.id)).toEqual(["acme/alpha", "acme/beta"]);
    const [available, unavailable] = catalog.models;
    expect(available).toMatchObject({ available: true, selectable: true, availability_reason: null });
    expect(unavailable).toMatchObject({
      available: false,
      selectable: false,
      availability_reason: "not_routable_by_host",
    });
  });

  /**
   * The regression this suite exists for.
   *
   * OpenClaw's picker view lists a provider's models only when it can confirm
   * auth readiness. A local provider whose credential lives in
   * `models.providers.<id>.apiKey` rather than the auth store is *indeterminate*,
   * so the picker shows only the configured one while the host routes them all.
   * Availability must follow what the host can route, not what its picker lists.
   */
  it("reports every routable model, not only the ones the picker lists", async () => {
    const catalog = await discoverHostModels(
      host({
        catalog: [
          row({ id: "small", name: "Small" }),
          row({ id: "medium", name: "Medium" }),
          row({ id: "large", name: "Large" }),
        ],
        // The host can address all three...
        offered: { acme: ["small", "medium", "large"] },
        // ...while its picker lists only the configured default.
        picker: { acme: ["small"] },
      }),
    );
    expect(catalog.models.filter((model) => model.available).map((model) => model.id)).toEqual([
      "acme/large",
      "acme/medium",
      "acme/small",
    ]);
    // The picker's listing survives as provenance, never as a veto.
    const small = catalog.models.find((model) => model.id === "acme/small")!;
    const large = catalog.models.find((model) => model.id === "acme/large")!;
    expect(small.properties.tags).toContain("host-picker");
    expect(large.properties.tags).not.toContain("host-picker");
    expect(large.availability_reason).toBeNull();
  });

  it("marks a model the host stopped routing unavailable", async () => {
    const catalog = await discoverHostModels(
      host({
        catalog: [row({ id: "small" }), row({ id: "gone" })],
        offered: { acme: ["small"] },
      }),
    );
    expect(stillAvailable(catalog, "acme/small")).toBe(true);
    expect(stillAvailable(catalog, "acme/gone")).toBe(false);
    expect(catalog.models.find((model) => model.id === "acme/gone")).toMatchObject({
      available: false,
      availability_reason: "not_routable_by_host",
    });
  });

  it("marks a removed model unavailable even when the picker still lists it", async () => {
    const catalog = await discoverHostModels(
      host({ catalog: [row({ id: "small" })], offered: { acme: ["small"] }, picker: { acme: ["gone"] } }),
    );
    expect(stillAvailable(catalog, "acme/gone")).toBe(false);
  });

  it("offers nothing when the operator never authorized a model override", async () => {
    // Without `llm.allowModelOverride`, `api.runtime.llm.complete` refuses every
    // named model, so offering one would be a promise this plugin cannot keep.
    const catalog = await discoverHostModels(
      host({ catalog: [row()], offered: { acme: ["alpha"] }, config: { plugins: { entries: {} } } }),
    );
    expect(catalog.models).toHaveLength(1);
    expect(catalog.models[0]).toMatchObject({
      available: false,
      availability_reason: "model_override_not_authorized",
    });
    expect(stillAvailable(catalog, "acme/alpha")).toBe(false);
  });

  it("honours an operator allowlist exactly as the host would", async () => {
    const config = {
      plugins: {
        entries: {
          "agent-browser": {
            llm: { allowModelOverride: true, allowedModels: ["acme/alpha"] },
          },
        },
      },
    };
    const catalog = await discoverHostModels(
      host({
        catalog: [row(), row({ id: "beta" })],
        offered: { acme: ["alpha", "beta"] },
        config,
      }),
    );
    expect(catalog.models.find((model) => model.id === "acme/alpha")).toMatchObject({
      available: true,
    });
    expect(catalog.models.find((model) => model.id === "acme/beta")).toMatchObject({
      available: false,
      availability_reason: "not_allowlisted_for_override",
    });
  });

  it("treats a wildcard allowlist as the host does", async () => {
    const config = {
      plugins: {
        entries: {
          "agent-browser": { llm: { allowModelOverride: true, allowedModels: ["*"] } },
        },
      },
    };
    const catalog = await discoverHostModels(
      host({ catalog: [row(), row({ id: "beta" })], offered: { acme: ["alpha", "beta"] }, config }),
    );
    expect(catalog.models.every((model) => model.available)).toBe(true);
  });

  it("honours a completion allowlist separately from the override allowlist", async () => {
    const config = {
      plugins: {
        entries: {
          "agent-browser": {
            llm: { allowModelOverride: true, allowedCompletionModels: ["acme/beta"] },
          },
        },
      },
    };
    const catalog = await discoverHostModels(
      host({ catalog: [row(), row({ id: "beta" })], offered: { acme: ["alpha", "beta"] }, config }),
    );
    expect(catalog.models.find((model) => model.id === "acme/alpha")).toMatchObject({
      available: false,
      availability_reason: "not_allowlisted_for_completion",
    });
    expect(catalog.models.find((model) => model.id === "acme/beta")).toMatchObject({
      available: true,
    });
  });

  it("refuses a retired model the host still lists", async () => {
    const catalog = await discoverHostModels(
      host({
        catalog: [row({ id: "old", status: "deprecated" }), row({ id: "gone", status: "disabled" })],
        offered: { acme: ["old", "gone"] },
      }),
    );
    expect(catalog.models.map((model) => model.availability_reason).sort()).toEqual([
      "model_deprecated",
      "model_disabled",
    ]);
    expect(catalog.models.every((model) => !model.available)).toBe(true);
  });

  it("keeps discovery alive when the picker view fails", async () => {
    const stub = host({ catalog: [row()], offered: { acme: ["alpha"] } });
    const browse = stub.browse!;
    stub.browse = async (config, agentId, options) => {
      if (options.view === "default") throw new Error("picker unavailable");
      return browse(config, agentId, options);
    };
    const catalog = await discoverHostModels(stub);
    expect(catalog.models[0]).toMatchObject({ available: true, availability_reason: null });
    expect(catalog.models[0]!.properties.tags).not.toContain("host-picker");
  });

  it("names no provider or model of its own", async () => {
    const source = await (await import("node:fs/promises")).readFile(
      new URL("../src/host-models.ts", import.meta.url),
      "utf8",
    );
    for (const vendor of ["ollama", "openai", "anthropic", "qwen", "llama", "gpt-", "claude"]) {
      expect(source.toLowerCase()).not.toContain(vendor);
    }
  });

  it("never sends an endpoint, a request parameter or anything else off-contract", async () => {
    const catalog = await discoverHostModels(
      host({
        catalog: [
          row({
            baseUrl: "https://api.acme.example/v1",
            params: { temperature: 0.4, apiKey: "sk-should-never-travel" },
            compat: { supportsTools: true, supportsJsonSchemaResponseFormat: true },
            api: "openai-completions",
          }),
        ],
        offered: { acme: ["alpha"] },
      }),
    );
    const serialized = JSON.stringify(catalog);
    expect(serialized).not.toContain("sk-should-never-travel");
    expect(serialized).not.toContain("api.acme.example");
    expect(serialized).not.toContain("openai-completions");
    expect(serialized).not.toMatch(/baseUrl|apiKey|authorization|bearer/iu);
    // Only the contract's fields exist on a descriptor.
    expect(Object.keys(catalog.models[0]).sort()).toEqual([
      "availability_reason",
      "available",
      "capabilities",
      "display_name",
      "id",
      "limits",
      "model_id",
      "properties",
      "provider_id",
      "selectable",
    ]);
  });

  it("classifies a local endpoint without disclosing it", async () => {
    const catalog = await discoverHostModels(
      host({
        catalog: [
          row({ id: "local-one", baseUrl: "http://127.0.0.1:11434/v1", provider: "ollama" }),
          row({ id: "remote-one" }),
          row({ id: "silent-one", baseUrl: undefined }),
        ],
        offered: { ollama: ["local-one"], acme: ["remote-one", "silent-one"] },
      }),
    );
    const byId = Object.fromEntries(catalog.models.map((model) => [model.id, model]));
    expect(byId["ollama/local-one"].properties.local).toBe(true);
    expect(byId["acme/remote-one"].properties.local).toBe(false);
    // No base URL at all is unknown, not "remote".
    expect(byId["acme/silent-one"].properties.local).toBeNull();
    expect(JSON.stringify(catalog)).not.toContain("11434");
  });

  it("marks the host default without selecting it", async () => {
    const catalog = await discoverHostModels(
      host({
        catalog: [row(), row({ id: "beta" })],
        offered: { acme: ["alpha", "beta"] },
        default: { provider: "acme", model: "beta" },
      }),
    );
    const beta = catalog.models.find((model) => model.id === "acme/beta")!;
    expect(beta.properties.tags).toContain("host-default");
    // Marking is all it does: nothing in the catalog pre-selects a model.
    expect(catalog.models.every((model) => "selectable" in model)).toBe(true);
  });

  it("reports an empty host catalog as an explained state, not an error", async () => {
    const catalog = await discoverHostModels(host());
    expect(catalog.models).toEqual([]);
    expect(catalog.notes.map((note) => note.code)).toContain("no_models_available");
  });

  it("passes provider discovery and refresh problems through as notes", async () => {
    const catalog = await discoverHostModels(
      host({
        catalog: [row()],
        offered: { acme: ["alpha"] },
        pending: ["slowprovider"],
        refreshWarning: "Some models could not be refreshed.",
      }),
    );
    const codes = catalog.notes.map((note) => note.code);
    expect(codes).toContain("provider_discovery_pending");
    expect(codes).toContain("catalog_refresh_failed");
    expect(catalog.notes.some((note) => note.detail?.includes("slowprovider"))).toBe(true);
  });

  it("turns a failing host into a typed, retryable failure", async () => {
    await expect(discoverHostModels(host({ fail: new Error("catalog not published") }))).rejects
      .toMatchObject({ code: "model_catalog_unavailable", retryable: true });
    await expect(
      discoverHostModels(host({ fail: new Error("catalog not published") })),
    ).rejects.toBeInstanceOf(AgentBrowserError);
  });

  it("keeps a model the host offers even when its catalog row was filtered out", async () => {
    const catalog = await discoverHostModels(
      host({ catalog: [], offered: { acme: ["ghost"] }, names: { "acme/ghost": "Ghost" } }),
    );
    expect(catalog.models).toHaveLength(1);
    expect(catalog.models[0]).toMatchObject({
      id: "acme/ghost",
      display_name: "Ghost",
      available: true,
    });
    // Nothing is claimed about a row that was never seen.
    expect(catalog.models[0].limits.context_tokens).toBeNull();
  });

  it("re-checks availability against a fresh catalog", async () => {
    const catalog = await discoverHostModels(
      host({ catalog: [row(), row({ id: "beta" })], offered: { acme: ["alpha"] } }),
    );
    expect(stillAvailable(catalog, "acme/alpha")).toBe(true);
    expect(stillAvailable(catalog, "acme/beta")).toBe(false);
    expect(stillAvailable(catalog, "acme/nothing")).toBe(false);
  });
});

describe("capability provenance", () => {
  it("records an explicit host declaration as declared", () => {
    const answers = capabilitiesOf(row({ compat: { supportsTools: true }, reasoning: true }));
    expect(answers.tool_use).toMatchObject({ value: true, basis: "declared" });
    expect(answers.reasoning).toMatchObject({ value: true, basis: "declared" });
  });

  it("records a tool opt-out without inferring structured-output transport support", () => {
    const answers = capabilitiesOf(row({ compat: { supportsTools: false } }));
    expect(answers.tool_use).toMatchObject({ value: false, basis: "declared" });
    // Tool use and responseFormat delivery are distinct capabilities.
    expect(answers.structured_output).toMatchObject({ value: true, basis: "derived" });
    expect(answers.structured_output_transport).toMatchObject({ value: null, basis: "absent" });
  });

  it("records OpenClaw's permissive tool default as host_default, not as a declaration", () => {
    const answers = capabilitiesOf(row({ compat: {} }));
    expect(answers.tool_use).toMatchObject({ value: true, basis: "host_default" });
    expect(answers.tool_use.detail).toContain("supportsModelTools");
    expect(answers.structured_output).toMatchObject({ value: true, basis: "derived" });
    expect(answers.structured_output_transport).toMatchObject({ value: null, basis: "absent" });
  });

  it("retains a catalog declaration as limited evidence, not transport proof", () => {
    const answers = capabilitiesOf(
      row({ compat: { supportsTools: true, supportsJsonSchemaResponseFormat: true } }),
    );
    expect(answers.structured_output).toMatchObject({ value: true, basis: "derived" });
    expect(answers.structured_output_transport).toMatchObject({ value: null, basis: "absent" });
    expect(answers.structured_output_transport.detail).toContain("supportsJsonSchemaResponseFormat=true");
    expect(answers.structured_output.detail).toContain("unverified");
  });

  it("reports a capability the host never states as unknown, not as false", () => {
    const answers = capabilitiesOf(row({ reasoning: undefined, input: undefined }));
    expect(answers.reasoning).toMatchObject({ value: null, basis: "absent" });
    expect(answers.multimodal).toMatchObject({ value: null, basis: "absent" });
  });

  it("derives multimodality from the modalities the host lists", () => {
    expect(capabilitiesOf(row({ input: ["text"] })).multimodal).toMatchObject({
      value: false,
      basis: "declared",
    });
    expect(capabilitiesOf(row({ input: ["text", "audio"] })).multimodal).toMatchObject({
      value: true,
      basis: "declared",
    });
  });
});
