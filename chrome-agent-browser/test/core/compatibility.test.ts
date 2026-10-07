/**
 * Model compatibility (`hostmodels.py`): the catalog normalizes and hashes as the reference
 * does, the requirement set and the verdicts equal the reference's for the fixture catalog,
 * unknown is never a boolean, and the recorded local model's facts (STATE.md §5) evaluate
 * as the reference evaluator says they do.
 */
import { describe, expect, it } from "vitest";

import {
  catalogReference,
  evaluateCatalog,
  evaluateModel,
  findModel,
  normalizeCatalog,
  normalizeDescriptor,
  requirementSet,
  stillAvailable,
  type ModelDescriptor,
} from "../../src/core/compatibility.js";
import type { JsonObject } from "../../src/core/json.js";
import { fixture, inputs, literatureReview, webair040, without } from "../helpers/fixtures.js";

function qwen(limits: Partial<ModelDescriptor["limits"]>, extra: Partial<JsonObject> = {}): ModelDescriptor {
  const raw = JSON.parse(JSON.stringify((inputs().catalog.models as JsonObject[])[0])) as JsonObject;
  raw.limits = { ...(raw.limits as JsonObject), ...limits };
  return normalizeDescriptor({ ...raw, ...extra }, 0);
}

describe("the host model catalog", () => {
  it("normalizes and hashes exactly as the reference (catalog_sha256 of the fixture evaluation)", async () => {
    const catalog = await normalizeCatalog(inputs().catalog);
    expect(catalogReference(catalog)).toEqual(fixture("model_evaluation").catalog);
    expect(findModel(catalog, "ollama/qwen3:30b")?.model_id).toBe("qwen3:30b");
    expect(findModel(catalog, "ollama/other")).toBeNull();
    expect(stillAvailable(catalog, "ollama/qwen3:30b")).toBe(true);
  });

  it("refuses unknown fields, a capability without a basis for a null value, and duplicates", async () => {
    const raw = () => JSON.parse(JSON.stringify(inputs().catalog)) as JsonObject;
    const withModel = (mutate: (model: JsonObject) => void) => {
      const copy = raw();
      mutate((copy.models as JsonObject[])[0]!);
      return normalizeCatalog(copy);
    };
    await expect(withModel((model) => (model.base_url = "http://127.0.0.1:11434"))).rejects.toMatchObject({ code: "unknown_field" });
    await expect(withModel((model) => ((model.capabilities as JsonObject).reasoning = { value: null, basis: "declared" }))).rejects.toMatchObject({ code: "invalid_request" });
    await expect(withModel((model) => ((model.limits as JsonObject).context_tokens = -1))).rejects.toMatchObject({ code: "invalid_request" });
    const twice = raw();
    (twice.models as JsonObject[]).push({ ...(twice.models as JsonObject[])[0]! });
    await expect(normalizeCatalog(twice)).rejects.toThrow(/duplicate model id/u);
    await expect(normalizeCatalog({ ...raw(), schema: "other" })).rejects.toThrow(/catalog.schema must be/u);
  });
});

describe("requirements and verdicts", () => {
  it("the requirement set and every verdict equal the reference's for the fixture catalog", async () => {
    const pkg = await webair040();
    const catalog = await normalizeCatalog(inputs().catalog);
    const evaluation = evaluateCatalog(pkg, catalog);
    const reference = fixture("model_evaluation");
    expect(without(evaluation, ["evaluated_at"])).toEqual(without(reference, ["evaluated_at"]));
    expect(evaluation.models[0]).toMatchObject({ status: "compatible", selectable_for_run_plan: true, evidence_strength: "derived" });
  });

  it("the recorded local model (STATE.md §5): 65,536 and the 32,768 default both satisfy the declared 16,000-token minimum", async () => {
    // Literature Review's manifest declares 16,000 tokens of context for every task; the
    // 65,536 figure in STATE.md is the router's run-time reservation, not a compatibility
    // requirement (T3 progress log). The reference evaluator therefore calls both compatible.
    const requirements = requirementSet(await literatureReview());
    expect(requirements.hard_requirements.find((item) => item.kind === "context_tokens")).toMatchObject({ id: "context_tokens:minimum", value: 16000 });
    expect(evaluateModel(requirements, qwen({ context_tokens: 65536 })).status).toBe("compatible");
    expect(evaluateModel(requirements, qwen({ context_tokens: 32768 })).status).toBe("compatible");
    expect(evaluateModel(requirements, qwen({ context_tokens: 8192 }))).toMatchObject({ status: "incompatible", violated: ["context_tokens:minimum"], selectable_for_run_plan: false });
    // The window the host will actually request is what counts; the native window is the fallback.
    expect(evaluateModel(requirements, qwen({ context_tokens: null, native_context_window: 262144 })).checks.find((check) => check.kind === "context_tokens")).toMatchObject({ host_value: 262144, source: "limits.native_context_window" });
  });

  it("unknown is never a boolean: a silent host leaves a model unverified, and a preference never changes the verdict", async () => {
    const requirements = requirementSet(await webair040());
    const silent = qwen({ context_tokens: null, native_context_window: null });
    const verdict = evaluateModel(requirements, silent);
    expect(verdict.status).toBe("unverified");
    expect(verdict.unknown).toEqual(["context_tokens:minimum"]);
    expect(verdict.selectable_for_run_plan).toBe(true); // selectable, but the browser policy refuses an unverified plan
    const noCapability = normalizeDescriptor({ ...(inputs().catalog.models as JsonObject[])[0]!, capabilities: {} }, 0);
    const absent = evaluateModel(requirements, noCapability);
    expect(absent.status).toBe("unverified");
    expect(absent.unknown.sort()).toEqual(["capability:reasoning", "capability:structured_output"]);
    expect(absent.checks.every((check) => check.status !== "violated")).toBe(true);
    const violated = evaluateModel(requirements, normalizeDescriptor({ ...(inputs().catalog.models as JsonObject[])[0]!, capabilities: { reasoning: { value: false, basis: "declared", detail: null } } }, 0));
    expect(violated).toMatchObject({ status: "incompatible", violated: ["capability:reasoning"] });
    expect(verdict.preferences.map((item) => item.status)).toEqual(["unknown"]);
  });

  it("local-only privacy becomes a hard property requirement, and an unavailable model is evaluated but not selectable", async () => {
    const pkg = await webair040();
    const manifest = { ...pkg.manifest, model_requirements: { ...(pkg.manifest.model_requirements as JsonObject), privacy: "local-only" } };
    const requirements = requirementSet({ ...pkg, manifest });
    expect(requirements.hard_requirements.map((item) => item.id)).toContain("property:local");
    const hosted = qwen({}, { properties: { local: false, privacy_class: null, cost_class: null, status: null, tags: [] } });
    expect(evaluateModel(requirements, hosted)).toMatchObject({ status: "incompatible", violated: ["property:local"] });
    const unavailable = qwen({}, { available: false, availability_reason: "not_routable_by_host" });
    expect(evaluateModel(requirementSet(pkg), unavailable)).toMatchObject({ status: "compatible", available: false, selectable_for_run_plan: false });
  });

  it("orders models available first, then compatible before unverified before incompatible, then by id", async () => {
    const pkg = await webair040();
    const base = (inputs().catalog.models as JsonObject[])[0]!;
    const catalog = await normalizeCatalog({
      ...inputs().catalog,
      models: [
        { ...base, id: "z/unverified", model_id: "unverified", limits: {} },
        { ...base, id: "a/offline", model_id: "offline", available: false },
        { ...base, id: "m/incompatible", model_id: "incompatible", limits: { context_tokens: 100 } },
        { ...base, id: "b/ok", model_id: "ok" },
      ],
    });
    expect(evaluateCatalog(pkg, catalog).models.map((item) => item.model_id)).toEqual(["b/ok", "z/unverified", "m/incompatible", "a/offline"]);
    expect(evaluateCatalog(pkg, catalog).counts).toMatchObject({ compatible: 2, unverified: 1, incompatible: 1, total: 4, available: 3, selectable: 2 });
  });
});
