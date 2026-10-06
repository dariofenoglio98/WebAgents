import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { SCHEMA_FILES, SCHEMAS } from "../../src/core/schemas/index.js";
import { PROJECT, ROOT } from "../helpers/paths.js";

const SOURCE = join(ROOT, "agentpkg", "src", "agentpkg", "schemas");
const COPY = join(PROJECT, "src", "core", "schemas");

describe("agentpkg's JSON Schemas are the single source (D-025)", () => {
  it("every schema file is copied byte for byte and nothing else is there", () => {
    const originals = readdirSync(SOURCE).filter((name) => name.endsWith(".schema.json")).sort();
    const copies = readdirSync(COPY).filter((name) => name.endsWith(".schema.json")).sort();
    expect(copies).toEqual(originals);
    expect([...SCHEMA_FILES]).toEqual(originals);
    for (const name of originals) {
      const original = readFileSync(join(SOURCE, name));
      const copy = readFileSync(join(COPY, name));
      expect(copy.equals(original), `${name} differs from agentpkg; run npm run sync-schemas`).toBe(true);
    }
  });

  it("the index exposes each schema under the name validate_document uses", () => {
    for (const name of SCHEMA_FILES) {
      const key = name.replace(/\.schema\.json$/u, "");
      expect(SCHEMAS[key]).toEqual(JSON.parse(readFileSync(join(SOURCE, name), "utf8")));
    }
    expect(Object.keys(SCHEMAS).sort()).toEqual(SCHEMA_FILES.map((name) => name.replace(/\.schema\.json$/u, "")).sort());
  });
});
