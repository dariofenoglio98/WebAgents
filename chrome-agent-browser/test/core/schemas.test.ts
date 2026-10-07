import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { EXTENSION_SCHEMA_FILES, EXTENSION_SCHEMAS } from "../../src/core/schemas/extensions/index.js";
import { SCHEMA_FILES, SCHEMAS } from "../../src/core/schemas/index.js";
import { PROJECT, ROOT } from "../helpers/paths.js";

const SOURCE = join(ROOT, "agentpkg", "src", "agentpkg", "schemas");
const COPY = join(PROJECT, "src", "core", "schemas");
const EXTENSION_SOURCE = join(ROOT, "spec", "extensions");
const EXTENSION_COPY = join(COPY, "extensions");

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

describe("the extension schemas beside the specs are copied the same way (D-040)", () => {
  it("every spec/extensions schema is copied byte for byte, and profiles-v0 is among them", () => {
    const originals = readdirSync(EXTENSION_SOURCE).filter((name) => name.endsWith(".schema.json")).sort();
    const copies = readdirSync(EXTENSION_COPY).filter((name) => name.endsWith(".schema.json")).sort();
    expect(copies).toEqual(originals);
    expect([...EXTENSION_SCHEMA_FILES]).toEqual(originals);
    expect(originals).toContain("profiles-v0.schema.json");
    for (const name of originals) {
      expect(readFileSync(join(EXTENSION_COPY, name)).equals(readFileSync(join(EXTENSION_SOURCE, name))), `${name} differs from spec/extensions; run npm run sync-schemas`).toBe(true);
      expect(EXTENSION_SCHEMAS[name.replace(/\.schema\.json$/u, "")]).toEqual(JSON.parse(readFileSync(join(EXTENSION_SOURCE, name), "utf8")));
    }
  });
});
