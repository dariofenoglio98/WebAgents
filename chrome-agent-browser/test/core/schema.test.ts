/**
 * The schema registry cannot be poisoned by package data (review 1, finding 1). The library
 * behind `schema.ts` keeps one process-global registry and dialect table; a package member
 * carrying `"$id": "<the draft 2020-12 URI>"` with a reduced `$vocabulary` used to redefine
 * the dialect for the rest of the process, after which every manifest, integrity and
 * signature check accepted anything. The reference builds a fresh registry per call.
 */
import { describe, expect, it } from "vitest";

import { ValidationError } from "../../src/core/errors.js";
import { evaluateSnapshot } from "../../src/core/evaluation.js";
import { checkSchema, DIALECT, PackageSchemas, registrable, validateDocument, validateInstance } from "../../src/core/schema.js";
import { readBytes, SHIPPED } from "../helpers/paths.js";
import { archiveBytes, listMembers } from "../helpers/zip.js";

const encoder = new TextEncoder();
const json = (value: unknown) => encoder.encode(JSON.stringify(value));

/** The invalid integrity document the reviewer used: refused before the attack, must stay refused after. */
const INVALID_INTEGRITY = { format: 123, files: "nope" };

const POISONS: Array<[string, unknown]> = [
  ["a reduced core-only vocabulary under the dialect's own $id", { $id: DIALECT, $vocabulary: { "https://json-schema.org/draft/2020-12/vocab/core": true } }],
  ["an unknown vocabulary under the dialect's $id (the library deletes the dialect on that path)", { $id: DIALECT, $vocabulary: { "https://evil.example/vocab": true } }],
  ["the same, nested in a $defs entry", { type: "object", $defs: { x: { $id: DIALECT, $vocabulary: { "https://json-schema.org/draft/2020-12/vocab/core": true } } } }],
  ["an $id on one of agentpkg's own schema URIs", { $id: "https://agentpkg.local/spec/0.1/manifest.schema.json", type: "object", $vocabulary: { "https://json-schema.org/draft/2020-12/vocab/core": true } }],
  ["another dialect declared by $schema", { $schema: "http://json-schema.org/draft-07/schema#", type: "object" }],
  ["a dynamic anchor", { $dynamicAnchor: "node", type: "object" }],
];

async function stillStrict(): Promise<void> {
  await expect(validateDocument(INVALID_INTEGRITY, "integrity", "integrity.json")).rejects.toThrow(ValidationError);
  await expect(validateDocument({ format: "agent.pkg-integrity-v0.1", files: { "a.json": "0".repeat(64) } }, "integrity", "integrity.json")).resolves.toBeUndefined();
  await expect(checkSchema({ type: "nonsense" }, "x.json")).rejects.toThrow(/invalid JSON Schema/u);
  await expect(checkSchema({ type: "object" }, "x.json")).resolves.toBeUndefined();
}

describe("package data never reaches the global schema registry or dialect table", () => {
  it("the agentpkg schemas are strict before anything is opened", async () => {
    await stillStrict();
  });

  for (const [label, poison] of POISONS) {
    it(`is not registrable: ${label}`, () => {
      expect(registrable(poison)).toBe(false);
    });

    it(`opening a package carrying ${label} leaves every later check strict`, async () => {
      const files = new Map<string, Uint8Array>([
        ["schemas/state.json", json({ type: "object", properties: { a: { type: "string" } } })],
        ["extra/x.json", json(poison)],
      ]);
      // Without a declared list every .json member is a candidate; the guard must hold alone.
      const schemas = await PackageSchemas.open(files);
      try {
        await expect(schemas.validateInstance("schemas/state.json", { a: "ok" })).resolves.toBeUndefined();
        await expect(schemas.validateInstance("schemas/state.json", { a: 1 })).rejects.toThrow(/rule: type/u);
        // The poisoned member is a document of the package but not an addressable schema.
        await expect(schemas.validateInstance("extra/x.json", {})).rejects.toThrow(/invalid JSON Schema/u);
      } finally {
        schemas.close();
      }
      await stillStrict();
    });
  }

  it("ordinary schemas are registrable, including a draft 2020-12 $schema and anchors", () => {
    expect(registrable(true)).toBe(true);
    expect(registrable({ $schema: DIALECT, type: "object", $anchor: "root", properties: { x: { $ref: "other.json" } } })).toBe(true);
    expect(registrable({ type: ["object", "null"], required: ["a"], enum: [1, "x", null], items: [{ type: "string" }] })).toBe(true);
    expect(registrable([{ type: "string" }])).toBe(false);
    expect(registrable(null)).toBe(false);
    expect(registrable("string")).toBe(false);
  });

  it("with a declared list, undeclared .json members are never parsed or registered", async () => {
    const files = new Map<string, Uint8Array>([
      ["schemas/state.json", json({ type: "object" })],
      ["data/not-even-json.json", encoder.encode("{ this is not json")],
    ]);
    const schemas = await PackageSchemas.open(files, ["schemas/state.json"]);
    try {
      expect(schemas.document("data/not-even-json.json")).toBeUndefined();
      await expect(schemas.validateInstance("data/not-even-json.json", {})).rejects.toThrow(/undeclared schema/u);
    } finally {
      schemas.close();
    }
    await expect(validateInstance(files, "schemas/state.json", {}, "instance", ["schemas/state.json"])).resolves.toBeUndefined();
  });

  it("the reviewer's scenario end to end: an unsigned WebAir with the poisoned member, then an invalid integrity document", async () => {
    const members = listMembers(readBytes(SHIPPED.webair.archive));
    members.delete("integrity.json");
    members.delete("signatures/publisher.json");
    members.set("extra/x.json", json(POISONS[0]![1]));
    const evaluation = await evaluateSnapshot(await archiveBytes(members));
    // The extra member is harmless data, as it is for the reference: the package evaluates.
    expect(evaluation.container_status).toBe("valid");
    expect(evaluation.integrity_status).toBe("valid");
    expect(evaluation.schema_status).toBe("valid");
    await stillStrict();
  });
});
