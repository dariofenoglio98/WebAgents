/**
 * Every operation's output must fit what OpenClaw lets it carry.
 *
 * `defineFeaturePlugin` refuses any output over the host's plugin JSON limits
 * as INVALID_OUTPUT, before and regardless of its schema. The live UI
 * acceptance found three outputs that grew past them with real data: the run
 * list (4,096 nodes after nine runs), the artifact view (a 300 KiB audit) and
 * the download slice (256 KiB of base64 in one string). These tests use the
 * host's own check, loaded from the pinned OpenClaw build, as the oracle, and
 * feed each projection the largest data it can be given.
 */
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Value } from "typebox/value";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { HOST_JSON_LIMITS, contract, runSummary } from "../src/contract.js";
import {
  ARTIFACT_CHUNK_BYTES,
  MAX_ARTIFACT_BYTES,
  MAX_ECHOED_INPUT_BYTES,
  artifactContent,
  artifactSlice,
  echoTask,
} from "../src/execution.js";
import { BUDGETS, fitsJson } from "../src/json-limits.js";
import { fitCatalog, projectTaskInput } from "../src/project.js";
import { MAX_RECORDS, RunManager } from "../src/run-manager.js";
import { RUN_ID, literatureView, runRecord, screeningProgress } from "./run-fixtures.js";
import { discoveryView, hostModel, modelCatalogView, websiteCandidate } from "./fixtures.js";

// The pinned OpenClaw build this plugin is tested against (see package.json).
const HOST_DIST = join(dirname(fileURLToPath(import.meta.url)), "..", "node_modules", "openclaw", "dist");
const HOST_JSON_MODULE = join(
  HOST_DIST,
  readdirSync(HOST_DIST).find((name) => name.startsWith("host-hook-json-") && name.endsWith(".mjs"))!,
);

let hostAccepts: (value: unknown) => boolean;
beforeAll(async () => {
  // The function `defineFeaturePlugin` itself calls on every input and output.
  const module = (await import(pathToFileURL(HOST_JSON_MODULE).href)) as { t: (value: unknown) => boolean };
  hostAccepts = module.t;
});

type OperationId = keyof typeof contract.operations;

/** What the SDK checks for one operation's output: the host's limits, then its schema. */
function carries(operation: OperationId, value: unknown): boolean {
  const result = { ok: true, value };
  return hostAccepts(result) && Value.Check(contract.operations[operation].output, result);
}

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

describe("the host's limits", () => {
  it("are mirrored exactly", () => {
    const source = readFileSync(HOST_JSON_MODULE, "utf8");
    const block = source.slice(source.indexOf("PLUGIN_JSON_VALUE_LIMITS = {"), source.indexOf("};", source.indexOf("PLUGIN_JSON_VALUE_LIMITS = {")));
    const host = Object.fromEntries([...block.matchAll(/(\w+):\s*(\d+)/gu)].map((match) => [match[1], Number(match[2])]));
    expect(host).toEqual({ ...HOST_JSON_LIMITS });
  });

  it("are counted by fitsJson exactly as the host counts them", () => {
    const cases: unknown[] = [
      { a: "x".repeat(HOST_JSON_LIMITS.maxStringLength) },
      { a: "x".repeat(HOST_JSON_LIMITS.maxStringLength + 1) },
      Array.from({ length: HOST_JSON_LIMITS.maxNodes - 1 }, () => 0),
      Array.from({ length: HOST_JSON_LIMITS.maxNodes }, () => 0),
      Object.fromEntries(Array.from({ length: HOST_JSON_LIMITS.maxObjectKeys + 1 }, (_, i) => [`k${i}`, 0])),
      JSON.parse(`${"[".repeat(33)}${"]".repeat(33)}`),
      JSON.parse(`${"[".repeat(32)}${"]".repeat(32)}`),
      Array.from({ length: 5 }, () => "é".repeat(60_000)),
      { n: Number.NaN },
      new Date(0),
    ];
    for (const value of cases) expect(fitsJson(value)).toBe(hostAccepts(value));
  });
});

describe("artifact downloads", () => {
  it("slice any artifact into chunks the host carries, and reassemble it exactly", () => {
    const data = randomBytes(600 * 1024 + 123);
    const parts: Buffer[] = [];
    for (let offset = 0; ; ) {
      const chunk = artifactSlice(RUN_ID, "audit.json", data, offset);
      expect(carries("execution.artifact-chunk", chunk)).toBe(true);
      expect(chunk.base64.length).toBeLessThanOrEqual(HOST_JSON_LIMITS.maxStringLength);
      parts.push(Buffer.from(chunk.base64, "base64"));
      offset += chunk.length;
      if (chunk.eof) break;
    }
    expect(parts).toHaveLength(Math.ceil(data.byteLength / ARTIFACT_CHUNK_BYTES));
    expect(Buffer.concat(parts).equals(data)).toBe(true);
  });

  it("use the longest slice the host allows", () => {
    // 48 KiB of bytes is exactly 65,536 base64 characters.
    expect(Buffer.alloc(ARTIFACT_CHUNK_BYTES).toString("base64").length).toBe(HOST_JSON_LIMITS.maxStringLength);
  });
});

describe("artifact views", () => {
  const audit = (events: number) =>
    Buffer.from(JSON.stringify({ events: Array.from({ length: events }, (_, i) => ({ seq: i, action: "tool.completed", ok: true })) }));

  it("show a large JSON artifact as bounded text, and say so", () => {
    const data = audit(12_000);
    expect(data.byteLength).toBeGreaterThan(300 * 1024);
    const view = artifactContent(RUN_ID, "audit.json", data);
    expect(carries("execution.artifact", view)).toBe(true);
    expect(view.truncated).toBe(true);
    expect(view.json).toBeUndefined();
    expect(view.shownBytes).toBe(MAX_ARTIFACT_BYTES);
    expect(view.bytes).toBe(data.byteLength);
  });

  it("send a small JSON artifact whose shape is too intricate as complete text", () => {
    // 8 KB, but 4,002 nodes: over the view's parsed-JSON budget.
    const data = Buffer.from(JSON.stringify({ values: Array.from({ length: 4000 }, () => 1) }));
    expect(data.byteLength).toBeLessThan(MAX_ARTIFACT_BYTES);
    const view = artifactContent(RUN_ID, "audit.json", data);
    expect(carries("execution.artifact", view)).toBe(true);
    expect(view.truncated).toBe(false);
    expect(view.json).toBeUndefined();
    expect(JSON.parse(view.text!)).toEqual(JSON.parse(data.toString()));
  });

  it("parse a small, simple JSON artifact", () => {
    const view = artifactContent(RUN_ID, "bibliography.json", Buffer.from(JSON.stringify([{ id: "a" }, { id: "b" }])));
    expect(carries("execution.artifact", view)).toBe(true);
    expect(view.json).toEqual([{ id: "a" }, { id: "b" }]);
  });

  it("bound text and bytes that are not text at all", () => {
    for (const data of [Buffer.from("# Title\n\n".concat("word ".repeat(80_000))), randomBytes(200 * 1024)]) {
      const view = artifactContent(RUN_ID, "related-work.md", data);
      expect(carries("execution.artifact", view)).toBe(true);
      expect(view.truncated).toBe(true);
    }
  });
});

describe("run lists and records", () => {
  it("list the most runs a backend holds, each with the most workers, within the limits", async () => {
    const root = await mkdtemp(join(tmpdir(), "ab-host-bounds-"));
    dirs.push(root);
    const runs = new RunManager(root);
    const progress = screeningProgress();
    const workers = Array.from({ length: 64 }, (_, i) => ({
      id: `ScreeningWorker:${i + 1}`,
      role: "ScreeningWorker",
      node: "screening",
      state: "completed" as const,
      modelCalls: 1,
      toolCalls: 1,
      durationMs: 1000,
    }));
    for (let index = 0; index < MAX_RECORDS; index += 1) {
      const view = runRecord({
        runId: `run_${index.toString(16).padStart(32, "0")}`,
        status: "completed",
        endedAt: "2026-09-26T11:00:00.000Z",
        durationMs: 2_000_000,
        progress: { ...progress, workers },
      });
      runs.register({ view, directory: root, lease: null, bridge: null, settled: true });
    }
    const listed = runs.list();
    expect(listed.runs).toHaveLength(MAX_RECORDS);
    expect(carries("execution.status", listed)).toBe(true);
    // One full record, too: the most workers a single run can report.
    expect(carries("execution.get", runRecord({ progress: { ...progress, workers } }))).toBe(true);
  });

  it("name each listed run by the person's words", () => {
    const record = runRecord({ task: { inputBytes: 90, input: { mode: "live", question: "What defenses exist?" }, attachments: [] } });
    expect(runSummary(record).taskText).toBe("What defenses exist?");
  });

  it("echo a task input only when it fits beside the record", () => {
    const small = { question: "q", seeds: [], documents: {}, mode: "live" };
    expect(echoTask(small, 60, []).input).toEqual(small);
    // Under the byte bound, but thousands of nodes: its size and hash are recorded, not the value.
    const intricate = { seeds: Array.from({ length: 3000 }, () => 1) };
    const bytes = JSON.stringify(intricate).length;
    expect(bytes).toBeLessThan(MAX_ECHOED_INPUT_BYTES);
    const task = echoTask(intricate, bytes, []);
    expect(task.input).toBeUndefined();
    expect(task.inputBytes).toBe(bytes);
    expect(carries("execution.get", runRecord({ task }))).toBe(true);
  });
});

describe("the package view", () => {
  it("carries a shipped package's input schema for its form", () => {
    const view = literatureView();
    expect(view.workflow.input.document).not.toBeNull();
    expect(carries("packages.get", view)).toBe(true);
  });

  it("leaves out an input schema too intricate to carry, and says why", () => {
    const properties = Object.fromEntries(
      Array.from({ length: 400 }, (_, i) => [`field_${i}`, { type: "string", enum: ["a", "b", "c", "d"] }]),
    );
    const document = { type: "object", properties };
    expect(JSON.stringify(document).length).toBeLessThan(BUDGETS.inputSchema.maxSerializedBytes);
    const projected = projectTaskInput({ schema_path: "schemas/in.json", schema_sha256: "0".repeat(64), bytes: 100, document, note: "" });
    expect(projected.document).toBeNull();
    expect(projected.note).toContain("edit the task as JSON");
  });
});

describe("the model catalog", () => {
  it("is unchanged when it fits", () => {
    const view = modelCatalogView();
    expect(fitCatalog(view)).toBe(view);
    expect(carries("models.evaluate", view)).toBe(true);
  });

  it("lists as many models as one answer can carry, the usable ones first, and says so", () => {
    // 128 models of real detail: far past the host's 4,096 nodes.
    const models = Array.from({ length: 128 }, (_, i) =>
      hostModel({
        modelId: `acme/model-${i}`,
        displayName: `Model ${i}`,
        ...(i % 4 === 0 ? {} : { status: "incompatible" as const, selectableForRunPlan: false, selectable: false }),
      }),
    );
    const view = modelCatalogView({ models });
    expect(fitsJson({ ok: true, value: view })).toBe(false);
    const fitted = fitCatalog(view);
    expect(carries("models.evaluate", fitted)).toBe(true);
    expect(fitted.models.length).toBeGreaterThan(20);
    expect(fitted.models.length).toBeLessThan(128);
    // Every model a plan could use comes before any it could not.
    const firstUnusable = fitted.models.findIndex((model) => !model.selectableForRunPlan);
    expect(fitted.models.slice(0, 32).every((model) => model.selectableForRunPlan)).toBe(true);
    expect(firstUnusable === -1 || firstUnusable >= 32).toBe(true);
    expect(fitted.notes[0]).toMatchObject({ code: "models_not_listed" });
    expect(fitted.notes[0]!.detail).toContain(`${128 - fitted.models.length} of the 128 models`);
    // The counts still describe the whole catalog.
    expect(fitted.counts).toEqual(view.counts);
  });
});

describe("website discovery", () => {
  it("carries the largest discovery view the control plane can produce", () => {
    // Every string at its bound and made of characters JSON must escape, so the
    // serialized answer is as large as the schema allows.
    const url = "\\".repeat(2048);
    const view = discoveryView({
      requestedUrl: url,
      finalUrl: url,
      pageOrigin: "\\".repeat(512),
      redirects: Array.from({ length: 5 }, () => ({ status: 308, fromUrl: url, toUrl: url })),
      candidates: Array.from({ length: 16 }, (_, index) =>
        websiteCandidate({
          index,
          href: url,
          typeHint: '"'.repeat(128),
          resolvedUrl: url,
          rejectionReason: '"'.repeat(64),
          rejectionMessage: '"'.repeat(1024),
        }),
      ),
      linksNotListed: 1000,
    });
    expect(JSON.stringify(view).length).toBeGreaterThan(200_000);
    expect(carries("websites.discover", view)).toBe(true);
    expect(carries("websites.discover", discoveryView())).toBe(true);
  });

  it("refuses, by schema, a discovery view that claims anything was verified or run", () => {
    for (const claim of [
      "packageVerified",
      "publisherTrusted",
      "permissionsGranted",
      "packageFetched",
      "executionPerformed",
    ] as const) {
      expect(carries("websites.discover", { ...discoveryView(), [claim]: true }), claim).toBe(false);
    }
  });
});
