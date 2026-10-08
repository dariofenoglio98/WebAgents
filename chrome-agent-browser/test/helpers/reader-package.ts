/**
 * A minimal signed `workflow.v0` package whose one tool is `paper-reader` (`paper.read`), with
 * Literature Review 0.2.5's own reader schemas byte for byte (so the host's pinned contract
 * digests match), and a graph that reads the document the task names and outputs its pages. Not
 * a shipped artifact: it exists so a picked PDF can be followed from Settings → Files through a
 * run's invocation, the broker, the parser and the audit without a model or a network (T6).
 */
import { canonicalJson } from "../../src/core/canonical.js";
import { sha256HexSync } from "../../src/core/hash.js";
import type { JsonObject, JsonValue } from "../../src/core/json.js";
import { loadPackageBytes } from "../../src/core/package.js";
import { fingerprint } from "../../src/core/keys.js";
import { literatureReview } from "./fixtures.js";
import { generateKeyPair, signedArchive } from "./keys.js";

export const READER_URL = "https://reader.example/reader.agent.pkg";

export async function readerPackage(options: { filesRequired?: boolean } = {}): Promise<{ bytes: Uint8Array; fingerprint: string; digest: string }> {
  const lr = await literatureReview();
  const files = new Map<string, Uint8Array>();
  const encoder = new TextEncoder();
  const write = (path: string, value: JsonValue | string) => files.set(path, encoder.encode(typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`));
  files.set("schemas/reader-input.schema.json", lr.files.get("schemas/reader-input.schema.json")!);
  files.set("schemas/reader-output.schema.json", lr.files.get("schemas/reader-output.schema.json")!);
  const state: JsonObject = { $schema: "https://json-schema.org/draft/2020-12/schema", type: "object", additionalProperties: false, required: ["request", "document"], properties: { request: { type: "object" }, document: { type: ["object", "null"] } } };
  write("schemas/state.schema.json", state);
  write("skills/read.SKILL.md", "# Read\n\nRead the named document.\n");
  write("tools/paper-reader.tool.json", {
    spec_version: "0.1",
    id: "paper-reader",
    version: "0.1.0",
    description: "Host PDF text extraction limited to explicitly selected files.",
    execution: "local",
    binding: "paper.read",
    endpoint: null,
    method: null,
    input_schema: "schemas/reader-input.schema.json",
    output_schema: "schemas/reader-output.schema.json",
    permissions: ["files.pdfs"],
    domains: [],
    timeout_seconds: 20,
    retries: 0,
    side_effects: "read",
    approval_required: false,
    extensions: {},
  });
  write("policy/policy.json", {
    spec_version: "0.1",
    permissions: [
      { id: "files.pdfs", kind: "files.read", description: "Read only individually selected local PDF files.", required: options.filesRequired === true, resources: ["user-selected-pdfs"] },
      { id: "model.reasoning", kind: "model", description: "Declared so a run plan can bind a model.", required: false, resources: ["host-router"] },
      { id: "memory.session", kind: "memory", description: "Session state only.", required: true, resources: ["session"] },
    ],
    network: { allowed_domains: [], https_only: true, allow_redirects: false },
    memory: { scope: "session", retention: "session", raw_documents: false, state_schema: "schemas/state.schema.json", sharing: "explicit_views" },
    budget: { estimated_tokens: 10, hard_tokens: 1000, max_remote_calls: 4, max_calls_per_tool: { "paper-reader": 2 }, max_parallel_workers: 1, estimated_cost_usd: null, approval_threshold_tokens: null },
    delegation: { max_depth: 1, approved_roles: ["ReaderWorker"], allow_remote: false },
    extensions: {},
  });
  write("graph.json", {
    spec_version: "0.1",
    profile: "workflow.v0",
    coordinator: "ReaderCoordinator",
    workers: [
      { id: "ReaderCoordinator", kind: "packaged", skills: [], tools: [], max_instances: 1, budget: { tokens: 1000, remote_calls: 4 }, state_read: ["request", "document"], state_write: ["document"] },
      { id: "ReaderWorker", kind: "packaged", skills: ["read"], tools: ["paper-reader"], max_instances: 1, budget: { tokens: 1000, remote_calls: 4 }, state_read: ["request"], state_write: ["document"] },
    ],
    input_schema: "schemas/reader-input.schema.json",
    output_schema: "schemas/reader-output.schema.json",
    initial_state: { object: { request: { from: "input", path: "" }, document: { literal: null } } },
    deadline_seconds: 120,
    nodes: [
      { id: "read", type: "tool", worker: "ReaderWorker", tool: "paper-reader", depends_on: [], input: { object: { file_id: { from: "state", path: "/request/file_id" } } }, output_schema: "schemas/reader-output.schema.json", timeout_seconds: 60, writes: { "/document": { from: "result", path: "" } } },
      { id: "result", type: "output", worker: "ReaderCoordinator", depends_on: ["read"], input: { from: "state", path: "/document" }, output_schema: "schemas/reader-output.schema.json", timeout_seconds: 10, writes: {} },
    ],
    extensions: {},
  });
  write("MANIFEST.agent", {
    spec_version: "0.1",
    package_id: "org.example.reader",
    name: "Reader",
    version: "0.1.0",
    description: "Reads one picked PDF; used only to test the paper reader.",
    publisher: { id: "example", name: "Example" },
    created_at: "2026-10-08T00:00:00Z",
    runtime: { api: "agentpkg-runtime-v0", minimum_version: "0.2.0" },
    capabilities: ["reading"],
    entrypoint: "workflow.v0",
    graph: "graph.json",
    policy: "policy/policy.json",
    skills: [{ id: "read", version: "0.1.0", path: "skills/read.SKILL.md" }],
    tools: [{ id: "paper-reader", path: "tools/paper-reader.tool.json" }],
    schemas: [
      { id: "reader-input", path: "schemas/reader-input.schema.json" },
      { id: "reader-output", path: "schemas/reader-output.schema.json" },
      { id: "state", path: "schemas/state.schema.json" },
    ],
    model_requirements: { tasks: [{ id: "read", capabilities: ["structured_output"], context_window: 1000, preferred_tier: "any" }], routing: "host", fallback_policy: "deny", extensions: {} },
    evals: [],
    attestations: [],
    dependencies: [],
    update: { channel: "local", locator: null },
    extensions: {},
  });
  const built = new Map<string, Uint8Array>();
  for (const [name, data] of files) built.set(name, name.endsWith(".json") || name === "MANIFEST.agent" ? canonicalJson(JSON.parse(new TextDecoder().decode(data))) : data);
  const key = await generateKeyPair();
  const bytes = await signedArchive(built, key);
  const pkg = await loadPackageBytes(bytes);
  return { bytes, fingerprint: await fingerprint(key.publicKey), digest: pkg.digest };
}

export function sha(bytes: Uint8Array): string {
  return sha256HexSync(bytes);
}
