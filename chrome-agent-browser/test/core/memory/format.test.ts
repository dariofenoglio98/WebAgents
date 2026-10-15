/**
 * The record format (§2, §8): the YAML subset, the canonical document, the export file, the stems
 * and the mirror, held to the spec's own examples byte for byte (M-7, M-9, M-55, M-57, M-59).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { documentToRecord, recordToDocument, stripMirror } from "../../../src/core/memory/document.js";
import { planImport } from "../../../src/core/memory/export.js";
import { aliasOf, type MemoryRecord, stemKey, stemOf, stemsFor, titleIndex } from "../../../src/core/memory/model.js";
import { TypeRegistry } from "../../../src/core/memory/types.js";
import { FrontmatterError, parseFrontmatter, splitDocument, writeFrontmatter } from "../../../src/core/memory/yaml.js";
import { folderFiles, LITERATURE_EXAMPLE, specExports, specRecords, testIds, WEBAIR_EXAMPLE } from "../../helpers/memory.js";

const types = new TypeRegistry();

describe("the YAML subset (M-7)", () => {
  it("reads and writes mappings, block and flow sequences, quoted and plain scalars, the empty mapping", () => {
    const text = ['id: "self"', "count: 3", "flag: true", "nothing: null", "empty: {}", "none: []", 'flow: [1, "two, three", "four\\"quoted"]', "tags:", '  - "a"', '  - "b"', "nested:", '  kind: "person"', "items:", '  - title: "x"', "    year: 2025", "  - {}"].join("\n");
    const value = parseFrontmatter(text);
    expect(value).toEqual({ id: "self", count: 3, flag: true, nothing: null, empty: {}, none: [], flow: [1, "two, three", 'four"quoted'], tags: ["a", "b"], nested: { kind: "person" }, items: [{ title: "x", year: 2025 }, {}] });
    // The writer always writes block sequences (the reference writer does); a flow sequence is read only.
    expect(writeFrontmatter(value)).toBe(text.replace('flow: [1, "two, three", "four\\"quoted"]', 'flow:\n  - 1\n  - "two, three"\n  - "four\\"quoted"'));
  });

  it("refuses what is outside the subset with the line", () => {
    for (const [text, reason] of [
      ["a: 'single'", "scalar outside the subset"],
      ["a:\tb", "tab"],
      ["a: 1\n\nb: 2", "blank line"],
      [" a: 1", "odd indentation"],
      ["a: 1\na: 2", "duplicate key"],
      ["a:", "has no value"],
      ["a: {b: 1}", "scalar outside the subset"],
      ["A: 1", "expected `key: value`"],
    ] as const) {
      expect(() => parseFrontmatter(text), text).toThrow(FrontmatterError);
      expect(() => parseFrontmatter(text), text).toThrow(reason);
    }
  });

  it("splits a document at the first `---` pair and tolerates an empty body", () => {
    expect(splitDocument('---\nid: "self"\n---\n\nbody\n')).toEqual(['id: "self"', "body\n"]);
    expect(splitDocument('---\nid: "self"\n---')).toEqual(['id: "self"', ""]);
    expect(() => splitDocument('id: "self"')).toThrow("does not start");
  });
});

describe("the canonical document (M-9) over the spec's examples", () => {
  it("every fenced record example parses, validates its shape and re-serializes byte for byte", () => {
    const examples = specRecords();
    expect(examples.length).toBeGreaterThanOrEqual(10);
    for (const text of examples) {
      const { record } = documentToRecord(text);
      const type = types.get(record.type)!;
      expect(type, record.type).toBeDefined();
      expect(recordToDocument(record, type.schema, { resolved: true })).toBe(text);
    }
  });

  it("the stored travel profile of §2.1, exported with the hub and the seat preference, is the spec's export example (M-57)", () => {
    const [stored] = specRecords();
    const { record } = documentToRecord(stored!);
    const records: MemoryRecord[] = [record];
    const exported = specExports()[0]!;
    const seat = specRecords().find((text) => text.includes('title: "Aisle seat"'))!;
    const hub = specRecords().find((text) => text.includes('id: "self"'))!;
    records.push(documentToRecord(seat).record, documentToRecord(hub).record);
    const linked: MemoryRecord = { ...record, links: [...(record.links ?? []), { to: records[1]!.id, rel: "prefers" }] };
    const stems = stemsFor([linked, ...records.slice(1)]);
    const titles = new Map(records.map((item) => [item.id, item.title] as const));
    expect(recordToDocument(linked, types.get("travel.profile")!.schema, { export: true, stems, titles })).toBe(exported);
  });
});

describe("the worked example folders (M-55, M-57)", () => {
  for (const [label, folder] of [
    ["WebAir 0.6.0", join(WEBAIR_EXAMPLE, "memory")],
    ["WebAir 0.6.0 omitted", join(WEBAIR_EXAMPLE, "memory-export-omitted")],
    ["Literature Review 0.2.8", join(LITERATURE_EXAMPLE, "memory")],
  ] as const) {
    it(`${label}: every file is named by the stem walk and re-serializes byte for byte`, () => {
      const files = folderFiles(folder).filter((file) => file.path.endsWith(".md") && file.path !== "index.md");
      const parsed = files.map((file) => ({ file, head: documentToRecord(file.text, { export: true }).record }));
      const stemsByFile = new Map(parsed.map(({ file, head }) => [head.id, file.path.split("/").pop()!.replace(/\.md$/u, "")] as const));
      const titles = new Map(parsed.map(({ head }) => [head.id, head.title] as const));
      const resolve = new Map<string, string>();
      for (const [id, stem] of stemsByFile) resolve.set(stemKey(stem), id);
      for (const [key, id] of titleIndex(titles)) if (!resolve.has(key)) resolve.set(key, id);
      const records = parsed.map(({ file }) => documentToRecord(file.text, { export: true, resolution: { resolve, titles } }).record);
      const stems = stemsFor(records);
      for (const [index, record] of records.entries()) {
        expect(stems.get(record.id), record.id).toBe(stemsByFile.get(record.id));
        const omitted = label.endsWith("omitted") && (record.sealed ?? []).length > 0;
        const text = recordToDocument(record, types.get(record.type)!.schema, { export: true, stems, titles, omitSealed: omitted });
        expect(text, files[index]!.path).toBe(files[index]!.text);
      }
    });
  }

  it("the example index.md lists every record by stem and id, and the import plan reads the usage log", () => {
    const files = folderFiles(join(WEBAIR_EXAMPLE, "memory"));
    const report = planImport(files, { types, records: new Map(), newId: testIds(9), now: new Date("2026-10-14T15:00:00Z") });
    expect(report.counts.refused).toBe(0);
    expect(report.counts.added + report.counts.hub).toBe(7);
    expect(report.usage.length).toBe(7);
    const index = readFileSync(join(WEBAIR_EXAMPLE, "memory", "index.md"), "utf8");
    for (const item of report.items) {
      const record = (item.outcome as { record: MemoryRecord }).record;
      expect(index).toContain(`\`${record.id}\``);
    }
  });
});

describe("stems (M-55)", () => {
  it("replaces unsafe characters, collapses whitespace, cuts to 100 code points and 200 bytes, then trims dots and spaces", () => {
    expect(stemOf('a/b\\c:d*e?f"g<h>i|j[k]l#m^n')).toBe("a-b-c-d-e-f-g-h-i-j-k-l-m-n");
    expect(stemOf("  two   words  ")).toBe("two words");
    expect(stemOf("...")).toBe("untitled");
    expect(stemOf(`${"x".repeat(99)} y`)).toBe("x".repeat(99));
    const cjk = "字".repeat(100);
    expect(new TextEncoder().encode(stemOf(cjk)).length).toBeLessThanOrEqual(200);
    expect(stemOf(cjk)).toBe("字".repeat(66));
  });

  it("walks heads first, compares names case-insensitively, never leaves an id-shaped stem bare, and resolves the Trip collision with the full id", () => {
    const record = (id: string, title: string, links: MemoryRecord["links"] = []): MemoryRecord => ({ id, type: "document.note", title, scope: "user", created: "2026-10-14T00:00:00Z", updated: "2026-10-14T00:00:00Z", source: { kind: "person" }, fields: {}, body: "", links });
    const a = record(`mem_${"1".repeat(32)}`, "Trip");
    const b = record(`mem_${"2".repeat(32)}`, "Trip");
    const c = record(`mem_${"3".repeat(32)}`, "Trip (22222222)");
    const d = record(`mem_${"4".repeat(32)}`, "trip", [{ to: a.id, rel: "supersedes" }]);
    const stems = stemsFor([a, b, c, d]);
    // Heads first: b, c, d; a is superseded and comes last.
    expect(stems.get(b.id)).toBe("Trip");
    expect(stems.get(c.id)).toBe("Trip (22222222)");
    expect(stems.get(d.id)).toBe("trip (44444444)");
    expect(stems.get(a.id)).toBe("Trip (11111111)");
    const selfNamed = record(`mem_${"5".repeat(32)}`, "self");
    expect(stemsFor([selfNamed]).get(selfNamed.id)).toBe("self (55555555)");
    expect(aliasOf("a[b]c|d")).toBe("a-b-c-d");
  });
});

describe("the mirror (M-57, M-59)", () => {
  it("is stripped as a block from the last marker line, keeping text typed after it, and reduced forms", () => {
    expect(stripMirror("body\n\n<!-- memory.v0 links -->\n## Links\n- about: [[Me]]").body).toBe("body");
    expect(stripMirror("body\n\n<!-- memory.v0 links -->\n## Links\n- about: [[Me]]\n\nTyped after.").body).toBe("body\n\nTyped after.");
    expect(stripMirror("<!-- memory.v0 links -->\n## Links").body).toBe("");
    expect(stripMirror("<!-- memory.v0 links -->   ").body).toBe("");
    expect(stripMirror("a\n<!-- memory.v0 links -->\nnot a link line").body).toBe("a\n\nnot a link line");
    const edited = stripMirror("body\n\n<!-- memory.v0 links -->\n## Links\n- about: [[Me]]\n- related: [[New note]]");
    expect(edited.lines).toEqual(["- about: [[Me]]", "- related: [[New note]]"]);
  });
});
