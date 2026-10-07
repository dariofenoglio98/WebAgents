import { describe, expect, it } from "vitest";

import { ValidationError } from "../../src/core/errors.js";
import type { JsonObject, JsonValue } from "../../src/core/json.js";
import { inspectPackage, loadPackageBytes, permissionsSummary } from "../../src/core/package.js";
import { evaluateSnapshot } from "../../src/core/evaluation.js";
import { validateInstance } from "../../src/core/schema.js";
import { checkDomain, validatePayload } from "../../src/core/validation.js";
import { readBytes, SHIPPED } from "../helpers/paths.js";
import { addTool, makeSource, mutate, writeJson, writeText } from "../helpers/source.js";
import { archiveBytes, listMembers } from "../helpers/zip.js";

async function load(source: Map<string, Uint8Array>) {
  return loadPackageBytes(await archiveBytes(source));
}

describe("the shipped packages pass every layer with the recorded digests", () => {
  for (const [label, shipped] of [
    ["WebAir 0.3.0", SHIPPED.webair],
    ["Literature Review 0.2.5", SHIPPED.literatureReview],
  ] as const) {
    it(`loads ${label}`, async () => {
      const pkg = await loadPackageBytes(readBytes(shipped.archive));
      expect(pkg.digest).toBe(shipped.digest);
      expect(pkg.manifest.package_id).toBe(shipped.packageId);
      expect(pkg.manifest.version).toBe(shipped.version);
      expect(pkg.signature).not.toBeNull();
      const evaluation = await evaluateSnapshot(readBytes(shipped.archive));
      expect(evaluation.container_status).toBe("valid");
      expect(evaluation.integrity_status).toBe("valid");
      expect(evaluation.schema_status).toBe("valid");
      expect(evaluation.runtime_status).toBe("compatible");
      expect(evaluation.errors).toEqual([]);
      expect(evaluation.package?.digest).toBe(shipped.digest);
    });
  }

  it("Meeting Agenda 0.2.2 loads too, with a workflow graph of nodes", async () => {
    const pkg = await loadPackageBytes(readBytes(SHIPPED.meetingAgenda.archive));
    expect(inspectPackage(pkg).execution_profile).toBe("workflow.v0");
    expect(Array.isArray(inspectPackage(pkg).nodes)).toBe(true);
  });
});

describe("the generic format tests (test_format.py) on an unrelated offline package", () => {
  it("accepts the unrelated generic package", async () => {
    const pkg = await load(makeSource());
    expect(pkg.manifest.package_id).toBe("org.example.agenda");
    expect(pkg.tools).toEqual({});
    expect(pkg.digest).toHaveLength(64);
    expect(permissionsSummary(pkg).permissions).toEqual([]);
    expect(inspectPackage(pkg).signature_trust).toBe("not verified by inspect");
    expect(inspectPackage(pkg).execution_profile).toBe("legacy-host-entrypoint");
    const evaluation = await evaluateSnapshot(await archiveBytes(makeSource()));
    expect(evaluation.schema_status).toBe("valid");
    // A legacy entrypoint is inspectable but not runnable here.
    expect(evaluation.runtime_status).toBe("incompatible");
    expect(evaluation.errors.map((error) => error.layer)).toEqual(["runtime"]);
  });

  const manifestCases: Array<[string, (manifest: JsonObject) => void, RegExp]> = [
    ["missing publisher", (m) => delete m.publisher, /publisher/u],
    ["spec_version 0.2", (m) => (m.spec_version = "0.2"), /0\.1/u],
    ["unknown security field", (m) => (m.unknown_security_field = true), /Additional properties/u],
    ["minimum_version too new", (m) => ((m.runtime as JsonObject).minimum_version = "99.0.0"), /minimum_version/u],
    ["unknown runtime api", (m) => ((m.runtime as JsonObject).api = "unknown"), /agentpkg-runtime-v0/u],
    ["duplicate skill id", (m) => (m.skills as JsonValue[]).push({ ...((m.skills as JsonObject[])[0] as JsonObject) }), /duplicate id/u],
    ["unnamespaced extension", (m) => ((m.extensions as JsonObject).unsafe = true), /does not match/u],
    ["malformed dependency", (m) => (m.dependencies as JsonValue[]).push({ id: "another" }), /package_id/u],
    ["traversal graph path", (m) => (m.graph = "../outside.json"), /does not match/u],
  ];
  for (const [label, mutation, pattern] of manifestCases) {
    it(`manifest fails closed: ${label}`, async () => {
      const source = makeSource();
      mutate(source, "MANIFEST.agent", mutation);
      await expect(load(source)).rejects.toThrow(pattern);
    });
  }

  const graphCases: Array<[string, (graph: JsonObject) => void, RegExp]> = [
    ["unknown skill", (g) => ((g.workers as JsonObject[])[0]!.skills as JsonValue[]).push("missing"), /unknown skills/u],
    ["unknown tool", (g) => ((g.workers as JsonObject[])[0]!.tools as JsonValue[]).push("missing"), /unknown tools/u],
    ["undeclared state key", (g) => ((g.workers as JsonObject[])[0]!.state_read as JsonValue[]).push("secret"), /state view/u],
    ["worker budget too large", (g) => (((g.workers as JsonObject[])[0]!.budget as JsonObject).tokens = 101), /budgets/u],
    ["coordinator instances", (g) => ((g.workers as JsonObject[])[0]!.max_instances = 2), /coordinator/u],
    ["cyclic stage", (g) => ((g.stages as JsonObject[])[0]!.depends_on as JsonValue[]).push("organize"), /cyclic/u],
    ["unknown dependency", (g) => ((g.stages as JsonObject[])[0]!.depends_on as JsonValue[]).push("missing"), /unknown dependency/u],
    ["unknown worker", (g) => ((g.stages as JsonObject[])[0]!.worker = "Unknown"), /unknown worker/u],
  ];
  for (const [label, mutation, pattern] of graphCases) {
    it(`graph constraint: ${label}`, async () => {
      const source = makeSource();
      mutate(source, "graph.json", mutation);
      await expect(load(source)).rejects.toThrow(pattern);
    });
  }

  const policyCases: Array<[string, (policy: JsonObject) => void, RegExp]> = [
    ["estimated above hard", (p) => ((p.budget as JsonObject).estimated_tokens = 101), /estimated_tokens/u],
    ["approval threshold above hard", (p) => ((p.budget as JsonObject).approval_threshold_tokens = 101), /approval_threshold/u],
    ["max_calls_per_tool for an unknown tool", (p) => (((p.budget as JsonObject).max_calls_per_tool as JsonObject).nonexistent = 1), /exactly every tool/u],
    ["delegation depth", (p) => ((p.delegation as JsonObject).max_depth = 2), /1 was expected/u],
    ["approved roles include the coordinator", (p) => ((p.delegation as JsonObject).approved_roles = ["Coordinator"]), /approved_roles/u],
    ["wildcard domain", (p) => ((p.network as JsonObject).allowed_domains as JsonValue[]).push("*.example.com"), /domain/u],
  ];
  for (const [label, mutation, pattern] of policyCases) {
    it(`policy constraint: ${label}`, async () => {
      const source = makeSource();
      mutate(source, "policy.json", mutation);
      await expect(load(source)).rejects.toThrow(pattern);
    });
  }

  const toolCases: Array<[string, (tool: JsonObject) => void, RegExp]> = [
    ["traversal binding", (t) => (t.binding = "../../execute"), /does not match/u],
    ["unknown permission", (t) => (t.permissions as JsonValue[]).push("unknown"), /unknown permission/u],
    ["endpoint off-domain", (t) => (t.endpoint = "https://evil.example.com/"), /domain\/method/u],
    ["credentials in endpoint", (t) => (t.endpoint = "https://user:password@calendar.example.com/"), /credential-free/u],
    ["odd port", (t) => (t.endpoint = "https://calendar.example.com:999/"), /credential-free/u],
    ["http endpoint", (t) => (t.endpoint = "http://calendar.example.com/"), /not valid under any|credential-free/u],
    ["fragment in endpoint", (t) => (t.endpoint = "https://calendar.example.com/x#frag"), /credential-free/u],
    ["backslash host trick", (t) => (t.endpoint = "https://calendar.example.com\\evil.example.com/"), /credential-free|domain\/method/u],
    ["undeclared input schema", (t) => (t.input_schema = "missing.json"), /declared schema/u],
    ["write without approval", (t) => (t.side_effects = "write"), /approval_required/u],
    ["local tool with endpoint", (t) => (t.execution = "local"), /local tools/u],
    ["method missing", (t) => (t.method = null), /domain\/method/u],
    ["retries", (t) => (t.retries = 1), /0 was expected/u],
  ];
  for (const [label, mutation, pattern] of toolCases) {
    it(`tool constraint: ${label}`, async () => {
      const source = makeSource();
      addTool(source);
      expect((await load(source)).tools.calendar!.binding).toBe("calendar.read");
      mutate(source, "tools/calendar.json", mutation);
      await expect(load(source)).rejects.toThrow(pattern);
    });
  }

  it("a remote tool whose domain has no linked network permission is refused", async () => {
    const source = makeSource();
    addTool(source);
    mutate(source, "policy.json", (policy) => {
      (policy.network as JsonObject).allowed_domains = ["calendar.example.com", "other.example.com"];
    });
    mutate(source, "tools/calendar.json", (tool) => {
      tool.domains = ["calendar.example.com", "other.example.com"];
    });
    await expect(load(source)).rejects.toThrow(/linked network permissions/u);
  });

  const schemaCases: Array<[string, JsonValue, RegExp]> = [
    ["nonsense type", { type: "nonsense" }, /invalid JSON Schema/u],
    ["remote ref", { type: "object", $ref: "https://example.com/schema" }, /offline/u],
    ["traversal ref", { type: "object", $ref: "../external.json" }, /traversal/u],
    ["undeclared ref", { type: "object", $ref: "missing.json" }, /missing or undeclared/u],
    ["unresolved fragment", { type: "object", $ref: "#/no-such-definition" }, /unresolved schema/u],
    ["$id", { type: "object", $id: "https://example.com/schema" }, /unsupported/u],
    ["$dynamicRef", { type: "object", $dynamicRef: "#node" }, /dynamic/u],
    ["other draft", { $schema: "http://json-schema.org/draft-07/schema#", type: "object" }, /draft 2020-12/u],
    ["non-pointer fragment", { type: "object", $ref: "#node" }, /JSON Pointer fragments/u],
    ["ref to a non-schema", { type: "object", $ref: "#/type" }, /does not point to a schema/u],
  ];
  for (const [label, schema, pattern] of schemaCases) {
    it(`malformed or remote schema: ${label}`, async () => {
      const source = makeSource();
      writeJson(source, "schemas/state.json", schema);
      await expect(load(source)).rejects.toThrow(pattern);
    });
  }

  it("resolves offline local schema references (test_offline_local_schema_reference)", async () => {
    const source = makeSource();
    writeJson(source, "schemas/common.json", { type: "string", minLength: 3 });
    mutate(source, "MANIFEST.agent", (manifest) => (manifest.schemas as JsonValue[]).push({ id: "common", path: "schemas/common.json" }));
    mutate(source, "schemas/state.json", (schema) => ((schema.properties as JsonObject).agenda = { $ref: "common.json" }));
    const pkg = await load(source);
    await expect(validateInstance(pkg.files, "schemas/state.json", { agenda: "done" })).resolves.toBeUndefined();
    await expect(validateInstance(pkg.files, "schemas/state.json", { agenda: "no" })).rejects.toThrow(/minLength/u);
    await expect(validateInstance(pkg.files, "schemas/state.json", { agenda: 1 })).rejects.toThrow(/type/u);
  });

  it("refuses a state schema that is not an object schema and references to undeclared members", async () => {
    const source = makeSource();
    writeJson(source, "schemas/state.json", { type: "array" });
    await expect(load(source)).rejects.toThrow(/type object/u);
    const other = makeSource();
    mutate(other, "policy.json", (policy) => ((policy.memory as JsonObject).state_schema = "schemas/other.json"));
    await expect(load(other)).rejects.toThrow(/missing referenced package member|declared schema/u);
  });

  it("refuses duplicate document roles, non-Markdown skills, unknown attestations and evals", async () => {
    const duplicate = makeSource();
    mutate(duplicate, "MANIFEST.agent", (manifest) => (manifest.attestations = ["graph.json"]));
    await expect(load(duplicate)).rejects.toThrow(/exactly one declared role/u);
    const skill = makeSource();
    writeText(skill, "skills/organize.txt", "x");
    mutate(skill, "MANIFEST.agent", (manifest) => ((manifest.skills as JsonObject[])[0]!.path = "skills/organize.txt"));
    await expect(load(skill)).rejects.toThrow(/Markdown instruction file/u);
    const attestation = makeSource();
    writeJson(attestation, "attestations/a.json", [1, 2]);
    mutate(attestation, "MANIFEST.agent", (manifest) => (manifest.attestations = ["attestations/a.json"]));
    await expect(load(attestation)).rejects.toThrow(/must be a JSON object/u);
    const evaluation = makeSource();
    writeJson(evaluation, "evals/e.json", { spec_version: "0.1", id: "other", description: "d", cases: [], extensions: {} });
    mutate(evaluation, "MANIFEST.agent", (manifest) => (manifest.evals = [{ id: "e", kind: "fixture", path: "evals/e.json" }]));
    await expect(load(evaluation)).rejects.toThrow(/eval id mismatch/u);
  });

  it("checks domains exactly as the reference does", () => {
    for (const good of ["example.com", "api.crossref.org", "a.b.c.d.example", "xn--bcher-kva.example"]) {
      expect(() => checkDomain(good), good).not.toThrow();
    }
    for (const bad of ["Example.com", "example", "*.example.com", "example.com:443", "https://example.com", "127.0.0.1", "service.local", "host.localhost", "-bad.example", "a..b", 7, "exa mple.com", `${"a".repeat(64)}.com`]) {
      expect(() => checkDomain(bad), String(bad)).toThrow(ValidationError);
    }
  });

  it("validatePayload returns the four documents", async () => {
    const source = makeSource();
    const payload = await validatePayload(source);
    expect(payload.manifest.package_id).toBe("org.example.agenda");
    expect(payload.graph.coordinator).toBe("Coordinator");
    expect(payload.policy.spec_version).toBe("0.1");
    expect(payload.tools).toEqual({});
  });
});

describe("package data named after Object.prototype members (review 1, finding 5)", () => {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  /** The shipped Meeting Agenda payload, unsigned, with its workflow graph edited. */
  async function agendaWith(edit: (graph: JsonObject) => void): Promise<Uint8Array> {
    const members = listMembers(readBytes(SHIPPED.meetingAgenda.archive));
    members.delete("integrity.json");
    members.delete("signatures/publisher.json");
    const graph = JSON.parse(decoder.decode(members.get("graph.json")!)) as JsonObject;
    edit(graph);
    members.set("graph.json", encoder.encode(JSON.stringify(graph)));
    return archiveBytes(members);
  }

  const node = (graph: JsonObject, id: string): JsonObject => (graph.nodes as JsonObject[]).find((item) => item.id === id)!;

  const cases: Array<[string, (graph: JsonObject) => void, RegExp]> = [
    ["a step reference to /constructor", (graph) => (node(graph, "perspectives").yield = { from: "steps", path: "/constructor" }), /unknown or forward step reference/u],
    [
      "a tool named constructor",
      (graph) => {
        const plan = node(graph, "plan");
        delete plan.task;
        delete plan.max_output_tokens;
        Object.assign(plan, { type: "tool", tool: "constructor" });
      },
      /unknown tool 'constructor'/u,
    ],
    [
      "a state path through toString where the schema forbids extra properties (the reference's wording)",
      (graph) => (node(graph, "plan").input = { from: "state", path: "/request/toString" }),
      /state\/data path component 'toString' not declared/u,
    ],
  ];
  for (const [label, edit, pattern] of cases) {
    it(`refuses ${label} as a validation error, never an internal one`, async () => {
      const bytes = await agendaWith(edit);
      await expect(loadPackageBytes(bytes)).rejects.toThrow(ValidationError);
      await expect(loadPackageBytes(bytes)).rejects.toThrow(pattern);
      const evaluation = await evaluateSnapshot(bytes);
      expect(evaluation.schema_status).toBe("invalid");
      expect(evaluation.errors.map((error) => error.layer)).toEqual(["schema"]);
      expect(evaluation.errors[0]?.message).toMatch(pattern);
    });
  }

  it("a state path through a property the schema leaves open is accepted, as the reference accepts it", async () => {
    // `schemas/plan.schema.json` is referenced through an anyOf; the request schema is closed.
    // An open object schema accepts any component, `toString` included: give the graph one.
    const members = listMembers(readBytes(SHIPPED.meetingAgenda.archive));
    members.delete("integrity.json");
    members.delete("signatures/publisher.json");
    const input = JSON.parse(decoder.decode(members.get("schemas/input.schema.json")!)) as JsonObject;
    delete input.additionalProperties;
    members.set("schemas/input.schema.json", encoder.encode(JSON.stringify(input)));
    const graph = JSON.parse(decoder.decode(members.get("graph.json")!)) as JsonObject;
    node(graph, "plan").input = { from: "state", path: "/request/toString" };
    members.set("graph.json", encoder.encode(JSON.stringify(graph)));
    const pkg = await loadPackageBytes(await archiveBytes(members));
    expect(pkg.manifest.package_id).toBe(SHIPPED.meetingAgenda.packageId);
  });
});
