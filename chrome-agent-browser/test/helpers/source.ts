/**
 * The unrelated offline Meeting Agenda source `agentpkg/tests/test_format.py::make_source`
 * builds, as in-memory payload files, plus its `mutate` and `add_tool` helpers. The format
 * tests are mirrored on this package so that no shipped artifact is involved.
 */
import type { JsonObject, JsonValue } from "../../src/core/json.js";

const encoder = new TextEncoder();

export type Source = Map<string, Uint8Array>;

export function makeSource(): Source {
  const manifest: JsonObject = {
    spec_version: "0.1",
    package_id: "org.example.agenda",
    name: "Meeting Agenda",
    version: "1.0.0",
    description: "Organize user-supplied meeting topics without network access.",
    publisher: { id: "org.example", name: "Example research publisher" },
    created_at: "2026-09-19T00:00:00Z",
    runtime: { api: "agentpkg-runtime-v0", minimum_version: "0.1.0" },
    capabilities: ["agenda"],
    entrypoint: "example.agenda",
    graph: "graph.json",
    policy: "policy.json",
    skills: [{ id: "organize", version: "1.0.0", path: "skills/organize.md" }],
    tools: [],
    schemas: [{ id: "state", path: "schemas/state.json" }],
    model_requirements: { tasks: [], routing: "host", fallback_policy: "deny", extensions: {} },
    evals: [],
    attestations: [],
    dependencies: [],
    update: { channel: "local", locator: null },
    extensions: {},
  };
  const documents: Record<string, JsonValue> = {
    "MANIFEST.agent": manifest,
    "graph.json": {
      spec_version: "0.1",
      coordinator: "Coordinator",
      workers: [
        {
          id: "Coordinator",
          kind: "packaged",
          skills: ["organize"],
          tools: [],
          max_instances: 1,
          budget: { tokens: 100, remote_calls: 0 },
          state_read: ["topics"],
          state_write: ["agenda"],
        },
      ],
      stages: [{ id: "organize", worker: "Coordinator", depends_on: [], parallel: false, merge: "replace", extensions: {} }],
      extensions: {},
    },
    "policy.json": {
      spec_version: "0.1",
      permissions: [],
      network: { allowed_domains: [], https_only: true, allow_redirects: false },
      memory: {
        scope: "session",
        retention: "session",
        raw_documents: false,
        state_schema: "schemas/state.json",
        sharing: "explicit_views",
      },
      budget: {
        estimated_tokens: 10,
        hard_tokens: 100,
        max_remote_calls: 0,
        max_calls_per_tool: {},
        max_parallel_workers: 1,
        estimated_cost_usd: null,
        approval_threshold_tokens: null,
      },
      delegation: { max_depth: 1, approved_roles: [], allow_remote: false },
      extensions: {},
    },
    "schemas/state.json": {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      properties: {
        topics: { type: "array", items: { type: "string" } },
        agenda: { type: "string" },
      },
      additionalProperties: false,
    },
  };
  const source: Source = new Map();
  for (const [name, value] of Object.entries(documents)) source.set(name, encoder.encode(`${JSON.stringify(value, null, 2)}\n`));
  source.set("skills/organize.md", encoder.encode("# Organize agenda\nGroup related user-supplied topics.\n"));
  return source;
}

export function readJson(source: Source, path: string): JsonObject {
  return JSON.parse(new TextDecoder().decode(source.get(path)!)) as JsonObject;
}

export function writeJson(source: Source, path: string, value: JsonValue): void {
  source.set(path, encoder.encode(JSON.stringify(value)));
}

export function writeText(source: Source, path: string, value: string): void {
  source.set(path, encoder.encode(value));
}

/** `test_format.py::mutate`: apply an operation to one JSON member. */
export function mutate(source: Source, path: string, operation: (value: JsonObject) => void): void {
  const value = readJson(source, path);
  operation(value);
  writeJson(source, path, value);
}

/** `test_format.py::add_tool`: a remote calendar tool with its network permission. */
export function addTool(source: Source): void {
  writeJson(source, "tools/calendar.json", {
    spec_version: "0.1",
    id: "calendar",
    version: "1.0.0",
    description: "Read calendar events",
    execution: "remote",
    binding: "calendar.read",
    endpoint: "https://calendar.example.com/events",
    method: "GET",
    input_schema: "schemas/state.json",
    output_schema: "schemas/state.json",
    permissions: ["calendar-network"],
    domains: ["calendar.example.com"],
    timeout_seconds: 10,
    retries: 0,
    side_effects: "read",
    approval_required: false,
    extensions: {},
  });
  mutate(source, "MANIFEST.agent", (manifest) => {
    (manifest.tools as JsonValue[]).push({ id: "calendar", path: "tools/calendar.json" });
  });
  mutate(source, "policy.json", (policy) => {
    (policy.network as JsonObject).allowed_domains = ["calendar.example.com"];
    policy.permissions = [
      {
        id: "calendar-network",
        kind: "network",
        description: "Calendar host",
        required: true,
        resources: ["calendar.example.com"],
      },
    ];
    const budget = policy.budget as JsonObject;
    budget.max_calls_per_tool = { calendar: 2 };
    budget.max_remote_calls = 2;
  });
}
