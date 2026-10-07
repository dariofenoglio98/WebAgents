import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { canonicalString } from "../../src/core/canonical.js";
import { evaluateSnapshot, evaluationLayers, publisherReport } from "../../src/core/evaluation.js";
import type { JsonObject } from "../../src/core/json.js";
import { inputForm, presentationHints, validateTaskInput } from "../../src/core/presentation.js";
import { buildSummary, SUMMARY_SCHEMA, warnings } from "../../src/core/summary.js";
import { MemoryTrustStorage, TrustStore } from "../../src/core/trust.js";
import { PROJECT, readBytes, SHIPPED } from "../helpers/paths.js";

const FIXTURES = join(PROJECT, "test", "fixtures");

async function summarize(archive: string) {
  const evaluation = await evaluateSnapshot(readBytes(archive));
  const pkg = evaluation.package!;
  const trust = new TrustStore(new MemoryTrustStorage());
  const publisher = await publisherReport(pkg, trust);
  const summary = await buildSummary(pkg, { evaluation: evaluationLayers(evaluation), publisher });
  return { pkg, summary, publisher, evaluation };
}

/** The Python reference records `path` in its trust state; the summary itself carries none. */
function comparable(summary: unknown): unknown {
  return JSON.parse(JSON.stringify(summary));
}

describe("build_summary parity with the Python control plane (test/fixtures/summary-*.json)", () => {
  for (const [label, shipped, fixture] of [
    ["WebAir 0.3.0", SHIPPED.webair, "summary-webair-0.3.0.json"],
    ["Literature Review 0.2.5", SHIPPED.literatureReview, "summary-literature-review-0.2.5.json"],
    ["Meeting Agenda 0.2.2", SHIPPED.meetingAgenda, "summary-meeting-agenda-0.2.2.json"],
  ] as const) {
    it(`${label}: the TypeScript summary equals the Python one canonically`, async () => {
      const reference = JSON.parse(readFileSync(join(FIXTURES, fixture), "utf8")) as JsonObject;
      const { summary } = await summarize(shipped.archive);
      expect(summary.schema).toBe(SUMMARY_SCHEMA);
      // Compare section by section first, so a difference names its section.
      for (const key of Object.keys(reference)) {
        expect(canonicalString(comparable((summary as unknown as JsonObject)[key])), key).toBe(canonicalString(reference[key]));
      }
      expect(canonicalString(comparable(summary))).toBe(canonicalString(reference));
    });
  }
});

describe("summary contents", () => {
  it("WebAir's warnings are the declaration-derived ones, in the reference's order", async () => {
    const { pkg, summary, publisher, evaluation } = await summarize(SHIPPED.webair.archive);
    expect(summary.warnings.map((warning) => warning.code)).toEqual([
      "publisher_unknown",
      "requests_personal_data",
      "requests_personal_data",
      "requests_personal_data",
      "requests_payment_permission",
      "remote_tools_declared",
      "side_effecting_tools_declared",
      "no_evals_declared",
      "no_attestations_declared",
    ]);
    expect(warnings(pkg, evaluationLayers(evaluation), publisher)).toEqual(summary.warnings);
    expect(summary.tools.map((tool) => tool.id)).toEqual(Object.keys(pkg.tools).sort());
    expect(summary.payload.file_count).toBe(SHIPPED.webair.payloadFiles);
    expect(summary.package.digest).toBe(SHIPPED.webair.digest);
  });

  it("trust changes the publisher section and the warnings, nothing else", async () => {
    const evaluation = await evaluateSnapshot(readBytes(SHIPPED.literatureReview.archive));
    const pkg = evaluation.package!;
    const trust = new TrustStore(new MemoryTrustStorage());
    const before = await buildSummary(pkg, { evaluation: evaluationLayers(evaluation), publisher: await publisherReport(pkg, trust) });
    const { publicKeyFromPem } = await import("../../src/core/keys.js");
    const { readText } = await import("../helpers/paths.js");
    await trust.add(publicKeyFromPem(readText(SHIPPED.literatureReview.key)), { displayName: "LR", publisherId: "webagents-research" });
    const after = await buildSummary(pkg, { evaluation: evaluationLayers(evaluation), publisher: await publisherReport(pkg, trust) });
    expect(after.publisher.trust_status).toBe("trusted");
    expect(after.warnings.map((warning) => warning.code)).not.toContain("publisher_unknown");
    for (const key of ["package", "capabilities", "skills", "tools", "workers", "workflow", "model_requirements", "evals", "attestations", "policy", "payload"] as const) {
      expect(canonicalString(comparable(after[key])), key).toBe(canonicalString(comparable(before[key])));
    }
  });

  it("the input form bundles the declared schema and validates tasks", async () => {
    const { pkg } = await summarize(SHIPPED.webair.archive);
    const form = await inputForm(pkg);
    expect(form.schema_path).toBe("schemas/input.schema.json");
    expect(form.document).not.toBeNull();
    expect(form.bytes).toBeGreaterThan(0);
    const valid = await validateTaskInput(pkg, {
      request: "Find me a flight to Zurich on 9 October under $900.",
      booking: false,
      purchase: { quote_id: "", fare_id: "" },
    });
    expect(valid.valid, JSON.stringify(valid.errors)).toBe(true);
    expect(valid.input_sha256).toMatch(/^[0-9a-f]{64}$/u);
    const invalid = await validateTaskInput(pkg, { request: 42, booking: false, purchase: { quote_id: "", fare_id: "" }, unknown: true });
    expect(invalid.valid).toBe(false);
    expect(invalid.errors.map((error) => error.pointer)).toContain("/request");
    expect(invalid.errors.some((error) => error.message.includes("does not accept"))).toBe(true);
    const missing = await validateTaskInput(pkg, {});
    expect(missing.errors).toEqual([
      { pointer: "/request", rule: "required", message: "is required" },
      { pointer: "/booking", rule: "required", message: "is required" },
      { pointer: "/purchase", rule: "required", message: "is required" },
    ]);
    const badPattern = await validateTaskInput(pkg, { request: "x", booking: false, purchase: { quote_id: "nope", fare_id: "" } });
    expect(badPattern.errors.map((error) => [error.pointer, error.message])).toContainEqual(["/purchase/quote_id", "does not have the required format"]);
    const notJson = await validateTaskInput(pkg, { request: Number.NaN });
    expect(notJson.errors[0]?.rule).toBe("json");
  });

  it("presentation hints are validated and the Run label must say run", async () => {
    const { pkg } = await summarize(SHIPPED.literatureReview.archive);
    const [hints, notes] = presentationHints(pkg);
    expect(hints?.schema).toBe("agentpkg-presentation-v0");
    expect(hints?.noncritical).toBe(true);
    expect(notes).toEqual([]);
    const tampered = {
      ...pkg,
      graph: {
        ...pkg.graph,
        extensions: {
          "agentpkg:presentation": {
            schema: "agentpkg-presentation-v0",
            task: { run_label: "Install now", prompt: "x‮y" },
            nodes: { unknown: "Label" },
            stages: [{ label: "", nodes: [] }],
            result: { primary_export: "missing.txt" },
            input: { nope: { widget: "multiline" } },
          },
        },
      },
    };
    const [adjusted, adjustedNotes] = presentationHints(tampered);
    expect(adjusted?.task.run_label).toBeUndefined();
    expect(adjusted?.task.prompt).toBe("x y");
    expect(adjusted?.nodes).toEqual({});
    expect(adjusted?.stages).toEqual([]);
    expect(adjustedNotes.length).toBeGreaterThanOrEqual(4);
    const [ignored, ignoredNotes] = presentationHints({ ...pkg, graph: { ...pkg.graph, extensions: { "agentpkg:presentation": { schema: "other" } } } });
    expect(ignored).toBeNull();
    expect(ignoredNotes[0]).toMatch(/ignored/u);
  });
});
