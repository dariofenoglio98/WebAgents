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

  it("declares no run operation anywhere", () => {
    const names = Object.keys(contract.operations).join(" ");
    expect(names).not.toMatch(/run|execute|invoke-workflow/u);
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
