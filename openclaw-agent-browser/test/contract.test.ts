import { describe, expect, it } from "vitest";
import { Compile } from "typebox/compile";
import {
  contract,
  DECISIONS,
  PackageView,
  ReceiptView,
  RunRecordView,
  ServiceStatus,
} from "../src/contract.js";
import { packageView, receiptView, serviceStatus } from "./fixtures.js";

describe("feature contract", () => {
  it("uses host-valid operation and event identifiers", () => {
    for (const id of Object.keys(contract.operations)) {
      expect(id).toMatch(/^[a-z][a-z0-9._-]{0,127}$/u);
    }
    for (const id of Object.keys(contract.events)) {
      expect(id).toMatch(/^[a-z][a-z0-9_-]{0,127}$/u);
    }
    expect(contract.pluginId).toBe("agent-browser");
  });

  it("separates read queries from write actions", () => {
    const queries = Object.entries(contract.operations)
      .filter(([, operation]) => operation.kind === "query")
      .map(([id]) => id);
    const actions = Object.entries(contract.operations)
      .filter(([, operation]) => operation.kind === "action")
      .map(([id]) => id);
    // Queries map to operator.read and actions to operator.write in the SDK.
    expect(queries).toContain("service.status");
    expect(queries).toContain("packages.get");
    expect(queries).toContain("packages.permissions");
    expect(actions).toContain("packages.open-url");
    expect(actions).toContain("packages.authorize");
    expect(actions).toContain("trust.pin-session-publisher");
    for (const id of queries) expect(id.startsWith("packages.open")).toBe(false);
  });

  it("exposes no agent-callable tool in this milestone", () => {
    for (const operation of Object.values(contract.operations)) {
      expect(operation.tool).toBeUndefined();
    }
  });

  it("declares no package-execution operation anywhere", () => {
    const names = Object.keys(contract.operations);
    // `run-plan.*` prepares and reads a preflight artifact. Nothing in the
    // contract can start a workflow, a worker or a package tool.
    for (const name of names) {
      expect(name).not.toMatch(/execute|invoke|dispatch|complete/u);
      expect(/\brun\b/u.test(name.replace(/run-plan/gu, "plan"))).toBe(false);
    }
    expect(names).toContain("run-plan.prepare");
    expect(names).not.toContain("run-plan.execute");
    expect(names).not.toContain("packages.run");
    expect(names).not.toContain("workflow.run");
  });

  it("makes the router probe the only operation that can reach a model", () => {
    // One operation spends tokens, it is a write action, and it is a developer
    // conformance probe rather than a run: its own output schema says so.
    expect(contract.operations["router.probe"].kind).toBe("action");
    expect(contract.operations["router.probe"].tool).toBeUndefined();
    expect(contract.operations["router.probe"].description).toContain("not an agent run");
    const output = JSON.stringify(contract.operations["router.probe"].output);
    expect(output).toContain('"workflowExecuted"');
    expect(output).toContain('"const":false');
  });

  it("lets the probe caller choose nothing except which plan it believes is current", () => {
    const input = contract.operations["router.probe"].input as {
      properties: Record<string, unknown>;
      required?: string[];
    };
    expect(Object.keys(input.properties).sort()).toEqual([
      "runPlanId",
      "runPlanSha256",
      "sessionId",
    ]);
    // No prompt, no schema, no model, no budget: the request is host-owned.
    for (const forbidden of ["prompt", "model", "modelId", "schema", "maxOutputTokens", "input"]) {
      expect(input.properties[forbidden]).toBeUndefined();
    }
  });

  it("lets the tool probe caller choose a declared tool, a host fixture, a selected file and a declared role, and nothing else", () => {
    const operation = contract.operations["execution.tool-probe"];
    expect(operation.kind).toBe("action");
    expect(operation.tool).toBeUndefined();
    expect(operation.description).toContain("not an agent run");
    const input = operation.input as {
      properties: Record<string, unknown>;
    };
    expect(Object.keys(input.properties).sort()).toEqual([
      "fileId",
      "fixtureId",
      "role",
      "runPlanId",
      "runPlanSha256",
      "sessionId",
      "toolId",
    ]);
    // Nothing that could name a destination, a request, a path or an implementation.
    for (const forbidden of [
      "url",
      "endpoint",
      "origin",
      "method",
      "headers",
      "args",
      "input",
      "body",
      "bindingId",
      "path",
      "filePath",
    ]) {
      expect(input.properties[forbidden], forbidden).toBeUndefined();
    }
    // A file is named only by the opaque id the host issued for it.
    expect(JSON.stringify(input.properties.fileId)).toContain("^file_[0-9a-f]{32}$");
    // Its own output schema says a graph never ran and no token was spent.
    const output = JSON.stringify(operation.output);
    expect(output).toContain('"workflowExecuted"');
    expect(output).toContain('"modelCalls"');
    expect(output).toContain('"const":0');
  });

  it("keeps the tool registry a read and the probe a write", () => {
    expect(contract.operations["tools.evaluate"].kind).toBe("query");
    expect(contract.operations["execution.tool-probe"].kind).toBe("action");
  });

  it("names a selected file by opaque id everywhere except the one selection action", () => {
    expect(contract.operations["files.select-local"].kind).toBe("action");
    expect(contract.operations["files.release"].kind).toBe("action");
    expect(contract.operations["files.list"].kind).toBe("query");
    // Only selection takes a path; its result, the listing and a run take ids.
    const select = contract.operations["files.select-local"].input as {
      properties: Record<string, unknown>;
    };
    expect(Object.keys(select.properties).sort()).toEqual(["path", "sessionId"]);
    for (const id of ["files.select-local", "files.list"] as const) {
      const output = JSON.stringify(contract.operations[id].output);
      expect(output, id).not.toContain('"path"');
      expect(output, id).not.toContain("privatePath");
    }
    const start = contract.operations["execution.start"].input as {
      properties: Record<string, unknown>;
    };
    expect(JSON.stringify(start.properties.files)).toContain("^file_[0-9a-f]{32}$");
    expect(start.properties.path).toBeUndefined();
  });

  it("keeps run-plan preparation a write action and its reads queries", () => {
    expect(contract.operations["run-plan.prepare"].kind).toBe("action");
    expect(contract.operations["run-plan.clear"].kind).toBe("action");
    expect(contract.operations["run-plan.get"].kind).toBe("query");
    expect(contract.operations["models.evaluate"].kind).toBe("query");
  });

  it("bounds every input and output schema", () => {
    for (const [id, operation] of Object.entries(contract.operations)) {
      const input = operation.input as Record<string, unknown>;
      expect(input.type, `${id} input`).toBe("object");
      expect(input.additionalProperties, `${id} input`).toBe(false);
      expect(operation.output).toBeDefined();
    }
  });

  it("only offers decisions the control plane supports", () => {
    expect(DECISIONS).toEqual(["deny", "once", "session"]);
    expect(DECISIONS).not.toContain("always");
  });

  it("validates the projected views it publishes", () => {
    expect(Compile(PackageView).Check(packageView())).toBe(true);
    expect(Compile(ReceiptView).Check(receiptView())).toBe(true);
    expect(Compile(ServiceStatus).Check(serviceStatus())).toBe(true);
  });

  it("refuses a package view that claims execution happened", () => {
    const invalid = { ...packageView(), executionPerformed: true };
    expect(Compile(PackageView).Check(invalid)).toBe(false);
  });
});

describe("the run record's revalidation list", () => {
  it("holds everything a run that binds tools re-verifies", () => {
    // ~26 preflight checks, the input size, 16 runner facts, the handler count
    // and one entry per bound tool: a three-tool package overflowed the old 32.
    const check = Compile(RunRecordView.properties.revalidated);
    const composed = [
      ...Array.from({ length: 26 }, (_, i) => `preflight_check_${i}`),
      "input_bytes:245",
      ...Array.from({ length: 16 }, (_, i) => `runner:fact_${i}`),
      "runner:tool_handlers:3",
      ...Array.from({ length: 16 }, (_, i) => `runner:tool_bound:tool-${i}`),
    ];
    expect(composed).toHaveLength(60);
    expect(check.Check(composed)).toBe(true);
    expect(check.Check([...composed, ...Array.from({ length: 5 }, (_, i) => `extra_${i}`)])).toBe(false);
  });
});
