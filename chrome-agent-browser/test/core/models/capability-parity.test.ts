/**
 * One source of truth for a bound model's capabilities (T11, D-130): for every provider route, the
 * router built from a plan's frozen descriptor delivers `reasoning` exactly when preflight's
 * evaluator found `capability:reasoning` satisfied on that same descriptor, and the policy's model
 * check at execution then agrees with the plan. Before T11 the built-in route hard-coded
 * `reasoning = false`, so a plan the person had prepared with "Reasons: yes" was refused at start
 * with `execution_model_incompatible`.
 */
import { describe, expect, it } from "vitest";

import { evaluateModel, normalizeDescriptor, requirementSet } from "../../../src/core/compatibility.js";
import { checkModel } from "../../../src/core/execution/policy.js";
import { modelBindingFromPlan } from "../../../src/core/execution/plan.js";
import type { JsonObject } from "../../../src/core/json.js";
import { UnavailableBuiltinPort } from "../../../src/core/models/adapters/chrome-builtin.js";
import { adapterFor } from "../../../src/core/models/providers.js";
import { BoundModelRouter, CAPABILITY_REASONING } from "../../../src/core/models/router.js";
import type { HttpTransport } from "../../../src/core/models/transport.js";
import type { ModelBinding } from "../../../src/core/types.js";
import { webair040 } from "../../helpers/fixtures.js";

const transport: HttpTransport = async () => ({ status: 200, headers: {}, body: "{}" });
const HOST = { transport, openai: { apiKey: "k" }, anthropic: { apiKey: "k" }, builtin: new UnavailableBuiltinPort() };
const ROUTES: Array<[provider: string, model: string]> = [
  ["ollama", "qwen3:30b"],
  ["openai", "gpt-4.1"],
  ["anthropic", "claude-opus-5-5"],
  ["chrome-builtin", "gemini-nano"],
];
const STATEMENTS: Array<[label: string, answer: JsonObject]> = [
  ["stated yes", { value: true, basis: "declared" }],
  ["stated no", { value: false, basis: "declared" }],
  ["not stated", { value: null, basis: "absent" }],
];

describe("a bound model's capabilities: preflight and execution read the same descriptor (D-130)", () => {
  for (const [provider, model] of ROUTES) {
    for (const [label, reasoning] of STATEMENTS) {
      it(`${provider}, reasoning ${label}`, async () => {
        const pkg = await webair040();
        const descriptor = normalizeDescriptor(
          {
            id: `${provider}/${model}`,
            provider_id: provider,
            model_id: model,
            display_name: model,
            available: true,
            capabilities: { reasoning, structured_output: { value: true, basis: "derived" } },
            limits: { context_tokens: 65536 },
            properties: { local: provider === "ollama" || provider === "chrome-builtin" },
          },
          0,
        );
        const verdict = evaluateModel(requirementSet(pkg), descriptor);
        const preflight = verdict.satisfied.includes("capability:reasoning");
        const binding = modelBindingFromPlan({ host_model_id: descriptor.id, provider_id: provider, model_id: model, display_name: model, descriptor: descriptor as unknown as JsonObject, compatibility: verdict as unknown as JsonObject } as unknown as ModelBinding);
        const router = new BoundModelRouter(adapterFor(binding, HOST));
        expect(router.capabilities.has(CAPABILITY_REASONING)).toBe(preflight);
        expect(preflight).toBe(reasoning.value === true);
        if (preflight) expect(checkModel(pkg, router)).toMatchObject({ router_capabilities: ["reasoning", "structured_output"], router_context_window: 65536 });
        else expect(() => checkModel(pkg, router)).toThrow(/does not deliver \['reasoning'\]/u);
      });
    }
  }
});
