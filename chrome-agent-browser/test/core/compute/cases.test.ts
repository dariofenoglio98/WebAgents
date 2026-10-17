/**
 * compute.v0 enforcement cases (`examples/compute/cases/cases.json`, spec §10): every case ends at
 * the stage with the code the list expects, on this runtime, as `test_compute_cases.py` asserts it
 * on the reference. The one engine difference the list states: a metering engine reports
 * `fuel_exhausted` where this one reports `deadline` (`non_metering_reason`).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { MAX_MODULE_BYTES } from "../../../src/core/compute/module.js";
import { IntegrityError, ValidationError } from "../../../src/core/errors.js";
import type { JsonObject } from "../../../src/core/json.js";
import { loadPackageBytes } from "../../../src/core/package.js";
import { fixtureAdapters } from "../../../src/core/fixtures.js";
import { PolicyError, WorkflowError } from "../../../src/core/workflow/errors.js";
import { runWorkflow } from "../../../src/core/workflow/interpreter.js";
import { buildTestEngine, type TestEngine } from "../../helpers/compute.js";
import { caseList, caseModule, computeNode, probeBytes, probeGrants, type ProbeOptions } from "../../helpers/compute-package.js";
import { listMembers, writeZip } from "../../helpers/zip.js";

const LIST = caseList();
let built: TestEngine;
beforeAll(async () => {
  built = await buildTestEngine();
});
afterAll(() => built.dispose());

type Case = (typeof LIST)["cases"][number];

function moduleBytes(testCase: Case): Uint8Array {
  if (testCase.generator === "oversized") {
    const big = new Uint8Array(MAX_MODULE_BYTES + 1);
    big.set(caseModule("echo"));
    return big;
  }
  if (testCase.generator === "not-wasm") return new TextEncoder().encode("not a module");
  return caseModule(testCase.module!);
}

/** The probe for one case: its module under the id `echo` unless a variant says otherwise. */
function options(testCase: Case): ProbeOptions {
  const data = moduleBytes(testCase);
  const built: ProbeOptions = { modules: { echo: data } };
  if (testCase.output_schema) built.outputSchema = testCase.output_schema;
  if (testCase.input_schema) built.inputSchema = testCase.input_schema;
  const node = computeNode("compute", { limits: testCase.node_limits ?? null });
  built.nodes = [node];
  switch (testCase.variant) {
    case "hash-mismatch":
      built.declared = [{ id: "echo", path: "modules/echo.wasm", sha256: "0".repeat(64) }];
      break;
    case "undeclared-member":
      built.extraFiles = { "modules/other.wasm": caseModule("echo") };
      break;
    case "unknown-module":
      node.module = "other";
      break;
    case "unused-module":
      built.modules = { echo: data, spare: caseModule("with-start") };
      break;
    case "no-permission":
      built.permission = false;
      break;
    case "wrong-resources":
      built.permissionResources = ["echo", "other"];
      break;
    case "minimum-0.4.0":
      built.minimumVersion = "0.4.0";
      break;
    default:
      break;
  }
  return built;
}

/** Flip one byte of a member and recompute its CRC, so only the integrity statement can catch it. */
function tamper(archive: Uint8Array, member: string): Uint8Array {
  const members = listMembers(archive);
  const data = members.get(member)!.slice();
  data[data.length - 1] = data[data.length - 1]! ^ 0x01;
  members.set(member, data);
  return writeZip(members);
}

describe.each(LIST.cases.map((c) => [c.id, c] as const))("%s", (_id, testCase) => {
  it(testCase.title, async () => {
    const stage = testCase.stage;
    if (stage === "container") {
      if (testCase.variant === "tamper-archive") {
        const { bytes } = await probeBytes(options(testCase));
        await expect(loadPackageBytes(tamper(bytes, "modules/echo.wasm"))).rejects.toSatisfy((error) => error instanceof IntegrityError && new RegExp(testCase.message!, "u").test((error as Error).message));
      } else {
        // The member rule (C-11) is the container's: it meets the bytes when the archive is read.
        const { bytes } = await probeBytes(options(testCase));
        await expect(loadPackageBytes(bytes)).rejects.toSatisfy((error) => error instanceof ValidationError && new RegExp(testCase.message!, "u").test((error as Error).message));
      }
      return;
    }
    if (stage === "validation") {
      await expect(probeBytes(options(testCase)).then(({ bytes }) => loadPackageBytes(bytes))).rejects.toSatisfy((error) => error instanceof ValidationError && (error as Error).message.startsWith(`${testCase.code}: `));
      return;
    }
    const { bytes } = await probeBytes(options(testCase));
    const pkg = await loadPackageBytes(bytes);
    const { router, handlers, input } = fixtureAdapters(pkg);
    const engine = testCase.variant === "no-engine" ? null : built.engine;
    const run = () => runWorkflow(pkg, input, { router, handlers, grants: probeGrants(pkg, testCase.grants ?? {}), approvedTools: [], compute: engine });
    if (stage === "preflight") {
      let caught: unknown = null;
      try {
        await run();
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(PolicyError);
      expect((caught as { code?: string }).code).toBe(testCase.code);
      expect((caught as Error).message.startsWith(`${testCase.code}: `)).toBe(true);
      return;
    }
    if (testCase.code === "completed") {
      const result = await run();
      expect(result.status).toBe("completed");
      expect((result.audit as unknown as JsonObject[]).filter((e) => String(e.action).startsWith("compute.")).map((e) => e.action)).toEqual(["compute.called", "compute.completed"]);
      return;
    }
    let caught: unknown = null;
    try {
      await run();
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(WorkflowError);
    const error = caught as WorkflowError & { execution_report: { audit: JsonObject[] } };
    expect(error.code).toBe(testCase.code);
    expect(error.node_id).toBe("compute");
    const audit = error.execution_report.audit;
    const failed = audit.find((event) => event.action === "compute.failed")!;
    expect(failed, "compute.failed recorded").toBeDefined();
    const reason = testCase.non_metering_reason ?? testCase.reason;
    expect(failed.reason).toBe(reason);
    if (testCase.trap_code) expect(failed.trap_code).toBe(testCase.trap_code);
    if (testCase.detail) expect(failed.detail).toBe(testCase.detail);
    if (testCase.memory_pages !== undefined) expect(failed.memory_pages).toBe(testCase.memory_pages);
    if (testCase.code === "compute_error") {
      const nodeFailed = audit.find((event) => event.action === "node.failed" && event.node_id === "compute")!;
      expect((nodeFailed.compute as JsonObject).reason).toBe(reason);
    }
    // Never the module's bytes, never V8's text (C-41, C-43).
    const text = JSON.stringify(failed);
    expect(text).not.toMatch(/RuntimeError|RangeError|two/u);
  });
});
