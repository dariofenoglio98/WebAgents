import { describe, expect, it } from "vitest";
import { Compile } from "typebox/compile";
import { contract, DECISIONS, PackageView, ReceiptView, ServiceStatus } from "../src/contract.js";
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
