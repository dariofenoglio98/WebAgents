/** The memory.v0 contracts copied into the core equal the spec's files (D-025, M-67), and the patched schemas admit the new kinds. */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { MEMORY_CONTRACT_FILES, MEMORY_CONTRACTS } from "../../../src/core/schemas/memory/index.js";
import { PATCHED_EXTENSION_SCHEMAS, PATCHED_SCHEMAS, validateDocument } from "../../../src/core/schema.js";
import { CONTRACTS } from "../../helpers/memory.js";

describe("the memory.v0 contracts", () => {
  it("are the spec's files, byte for byte, and nothing is missing", () => {
    const names = readdirSync(CONTRACTS).filter((name) => name.endsWith(".json")).sort();
    expect([...MEMORY_CONTRACT_FILES]).toEqual(names);
    for (const name of names) expect(JSON.stringify(MEMORY_CONTRACTS[name.replace(/\.json$/u, "")]), name).toBe(JSON.stringify(JSON.parse(readFileSync(join(CONTRACTS, name), "utf8"))));
  });

  it("the patches are applied idempotently: the policy schema admits memory.read, memory.write and memory_types; the workflow schema the memory.proposal format; the bundle the memory ceilings", async () => {
    const policy = PATCHED_SCHEMAS.policy as { properties: { permissions: { items: { properties: { kind: { enum: string[] } } } }; memory_types: unknown } };
    expect(policy.properties.permissions.items.properties.kind.enum).toContain("memory.read");
    expect(policy.properties.permissions.items.properties.kind.enum).toContain("memory.write");
    expect(policy.properties.memory_types).toBeDefined();
    const workflow = PATCHED_SCHEMAS.workflow as { properties: { exports: { items: { properties: { format: { enum: string[] } } } } } };
    expect(workflow.properties.exports.items.properties.format.enum).toContain("memory.proposal");
    const bundle = PATCHED_EXTENSION_SCHEMAS["policy-bundle-v0"] as { properties: { decisions: { properties: Record<string, unknown> }; memory: unknown } };
    expect(Object.keys(bundle.properties.decisions.properties)).toContain("memory.read");
    expect(bundle.properties.memory).toBeDefined();
    await expect(validateDocument({ spec_version: "0.1", permissions: [{ id: "m", kind: "memory.read", description: "d", required: false, resources: ["travel.profile"] }], network: { allowed_domains: [], https_only: true, allow_redirects: false }, memory: { scope: "session", retention: "session", raw_documents: false, state_schema: "s.json", sharing: "explicit_views" }, budget: { estimated_tokens: 1, hard_tokens: 1, max_remote_calls: 0, max_calls_per_tool: {}, max_parallel_workers: 1, estimated_cost_usd: null, approval_threshold_tokens: null }, delegation: { max_depth: 1, approved_roles: [], allow_remote: false }, extensions: {} }, "policy", "policy")).resolves.toBeUndefined();
  });
});
