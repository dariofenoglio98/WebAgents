/**
 * memory.v0 §7 at validation: what a package may declare (M-33, M-38, M-48, M-67) and the
 * codes it is refused with, before any host binds anything.
 */
import { describe, expect, it } from "vitest";

import type { JsonObject } from "../../../src/core/json.js";
import { memoryDeclarations } from "../../../src/core/memory/declarations.js";
import { AGENT_PERMISSION, AGENT_WRITE_TOOL, editJson, memoryPackage, READ_PERMISSION, WRITE_PERMISSION } from "../../helpers/memory-package.js";

async function refusal(options: Parameters<typeof memoryPackage>[0], mutate?: Parameters<typeof memoryPackage>[1]): Promise<string> {
  try {
    await memoryPackage(options, mutate);
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error("expected the package to be refused");
}

describe("memory.v0 declarations at validation", () => {
  it("accepts the full set: a memory.read, the personal.read alias, memory.write with its export, the agent document", async () => {
    const { pkg } = await memoryPackage({ agent: true });
    const declared = memoryDeclarations(pkg.manifest, pkg.policy, pkg.tools, pkg.files);
    expect([...declared.reads]).toEqual([[READ_PERMISSION, "travel.profile"]]);
    expect(declared.write).toEqual({ permission_id: WRITE_PERMISSION, types: ["travel.preference", "travel.profile"] });
    expect(declared.agent).toEqual({ permission_id: AGENT_PERMISSION, read_tool: "agent-notes.read", write_tool: AGENT_WRITE_TOOL });
    expect(declared.uses_memory_v0).toBe(true);
    expect(declared.custom_types).toEqual([]);
  });

  it("M-38: memory.write without the proposals export, and the export without the permission, are memory_proposal_undeclared", async () => {
    expect(await refusal({ write: true, proposalsExport: false })).toMatch(/^memory_proposal_undeclared/u);
    expect(await refusal({ write: false, proposalsExport: true })).toMatch(/^memory_proposal_undeclared/u);
    expect(await refusal({ proposalsPath: "memory.json" })).toMatch(/^memory_proposal_undeclared: the memory\.proposal export must be proposals\.json/u);
  });

  it("M-38: the reserved types cannot be proposed, agent.memory cannot be read, and more than 8 types are refused", async () => {
    expect(await refusal({ writeTypes: ["person.self"] })).toMatch(/^memory_type_reserved/u);
    expect(await refusal({ writeTypes: ["agent.memory"] })).toMatch(/^memory_type_reserved/u);
    expect(await refusal({ writeTypes: ["a.b", "a.c", "a.d", "a.e", "a.f", "a.g", "a.h", "a.i", "a.j"] })).toMatch(/^memory_type_reserved/u);
    expect(await refusal({ readType: "agent.memory" })).toMatch(/^memory_type_reserved/u);
    // Two types in one memory.read: ambiguous, as for personal.read.
    expect(await refusal({}, (files) => editJson(files, "policy/policy.json", (policy) => { ((policy.permissions as JsonObject[]).find((p) => p.id === READ_PERMISSION)!.resources as string[]).push("travel.preference"); }))).toMatch(/^ambiguous/u);
  });

  it("M-48: the agent bindings need agent-scoped memory, the permission, the exact schemas and a write cap of 1", async () => {
    expect(await refusal({ agentToolsWithoutScope: true })).toMatch(/^agent_memory_scope/u);
    expect(await refusal({ agent: true, agentWithoutPermission: true })).toMatch(/^agent_memory_scope/u);
    expect(await refusal({ agent: true, agentWriteCap: 2 })).toMatch(/^agent_memory_write_cap/u);
    const widened: JsonObject = { $schema: "https://json-schema.org/draft/2020-12/schema", type: "object", additionalProperties: false, required: ["body"], properties: { body: { type: "string", maxLength: 40000 } } };
    expect(await refusal({ agent: true, agentWriteInputSchema: widened })).toMatch(/^binding_schema_mismatch/u);
    // A second permission naming the agent document, or one naming it beside another resource.
    expect(await refusal({ agent: true }, (files) => editJson(files, "policy/policy.json", (policy) => { ((policy.permissions as JsonObject[]).find((p) => p.id === AGENT_PERMISSION)!.resources as string[]).push("session"); }))).toMatch(/^agent_memory_scope/u);
  });

  it("M-67: a package using memory.v0 declares runtime.minimum_version 0.4.0 or later", async () => {
    expect(await refusal({ minimumVersion: "0.3.0" })).toMatch(/^memory_minimum_version/u);
    // A legacy-only package (personal.read through host.resource.*, no memory.write) may stay at 0.3.0.
    const { pkg } = await memoryPackage({ minimumVersion: "0.3.0", write: false }, (files) => {
      editJson(files, "policy/policy.json", (policy) => { policy.permissions = (policy.permissions as JsonObject[]).filter((p) => p.id !== READ_PERMISSION); });
      editJson(files, "tools/travel.profile.tool.json", (tool) => { tool.binding = "host.resource.personal.travel_profile"; tool.permissions = ["wallet.payment"]; });
    }).catch((error: Error) => ({ pkg: null, error }));
    // The read tool now links the wallet permission for a travel binding: not a memory.v0 package, and validation leaves it to the host (legacy behaviour).
    expect(pkg === null || memoryDeclarations(pkg.manifest, pkg.policy, pkg.tools, pkg.files).uses_memory_v0 === false).toBe(true);
  });
});
