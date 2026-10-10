/**
 * Fixture parity between the two runtimes (D-063, the seed of T7): `agentpkg run --mode
 * fixture` and the built `dist/cli.js run --mode fixture` on the same signed packages, same
 * grants, same approvals and same inputs, compared after the one normalization D-063 allows.
 *
 * Equal, exactly: the exit status and the success report (minus the output directory); the
 * file set; `result.json` without `audit` after masking `provenance.interpreter`; every export
 * (JSON parsed, text bytes); `usage` except worker instance suffixes, and for Literature Review
 * only `tokens` (the integral-float class, both numbers printed). The audit is compared as an
 * ordered backbone (runtime/workflow events and `state.committed` with its node lists) plus,
 * per wave, a sorted multiset of (action, node, role, task | tool | permission) over worker-level
 * events, because a wave's concurrent nodes record their events in whichever order their
 * asynchronous validation settles. Run ids, timestamps and hashes are dropped. Anything else
 * fails. The Python CLI is `AGENTPKG_CLI` or `agentpkg/.venv/bin/agentpkg`; its absence fails
 * the test rather than skipping it.
 */
import { accessSync, constants, existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { JsonObject, JsonValue } from "../../src/core/json.js";
import { BuiltCli } from "../helpers/cli.js";
import { ROOT, SHIPPED } from "../helpers/paths.js";

const PYTHON_CLI = process.env.AGENTPKG_CLI ?? join(ROOT, "agentpkg", ".venv", "bin", "agentpkg");

interface Case {
  name: string;
  archive: string;
  grants: string;
  tools: string[];
  input: JsonValue | null;
  tokensAllowlisted: boolean;
}

const webairTools = ["search-flights", "get-fare-rules", "prepare-booking", "simulate-purchase", "personal.travel_profile", "personal.passenger_identity", "wallet.payment_method"];
const scenarios = (JSON.parse(readFileSync(join(ROOT, "examples", "webair-scenarios.json"), "utf8")) as { scenarios: Array<{ id: string; input: JsonValue }> }).scenarios;

const CASES: Case[] = [
  { name: "webair-0.4.0 fixture input", archive: SHIPPED.webair040.archive, grants: join(ROOT, "examples", "webair-0.2.0-grants.json"), tools: webairTools, input: null, tokensAllowlisted: false },
  // The scenarios are the current package's (0.5.0 adds no-departure, which 0.4.0's fixture cannot replay).
  { name: "webair-0.5.0 fixture input", archive: SHIPPED.webair050.archive, grants: join(ROOT, "examples", "webair-0.2.0-grants.json"), tools: webairTools, input: null, tokensAllowlisted: false },
  ...scenarios.map((scenario) => ({ name: `webair-0.5.0 scenario ${scenario.id}`, archive: SHIPPED.webair050.archive, grants: join(ROOT, "examples", "webair-0.2.0-grants.json"), tools: webairTools, input: scenario.input, tokensAllowlisted: false })),
  { name: "literature-review-0.2.5 fixture input", archive: SHIPPED.literatureReview.archive, grants: join(ROOT, "examples", "literature-review-grants.json"), tools: ["scholarly-search", "paper-reader", "citation-resolver"], input: null, tokensAllowlisted: true },
  { name: "literature-review-0.2.6 fixture input", archive: SHIPPED.literatureReview026.archive, grants: join(ROOT, "examples", "literature-review-grants.json"), tools: ["scholarly-search", "paper-reader", "citation-resolver"], input: null, tokensAllowlisted: true },
  { name: "literature-review-0.2.7 fixture input", archive: SHIPPED.literatureReview027.archive, grants: join(ROOT, "examples", "literature-review-grants.json"), tools: ["scholarly-search", "paper-reader", "citation-resolver"], input: null, tokensAllowlisted: true },
  { name: "meeting-agenda-0.2.2 fixture input", archive: SHIPPED.meetingAgenda.archive, grants: join(ROOT, "examples", "meeting-agenda-grants.json"), tools: [], input: null, tokensAllowlisted: false },
];

let cli: BuiltCli;
let scratch: string;

beforeAll(async () => {
  accessSync(PYTHON_CLI, constants.X_OK);
  cli = await BuiltCli.build();
  // agentpkg refuses an output path with a symlink component (macOS: /var → /private/var).
  scratch = mkdtempSync(join(realpathSync(tmpdir()), "fixture-parity-"));
});

afterAll(() => {
  cli.dispose();
  rmSync(scratch, { recursive: true, force: true });
});

interface RunOutput {
  status: number;
  report: JsonObject | null;
  stderr: string;
  files: Record<string, Uint8Array>;
}

function collect(directory: string): Record<string, Uint8Array> {
  const files: Record<string, Uint8Array> = {};
  if (!existsSync(directory)) return files;
  for (const name of readdirSync(directory).sort()) files[name] = new Uint8Array(readFileSync(join(directory, name)));
  return files;
}

function runPython(testCase: Case, out: string, inputPath: string | null): RunOutput {
  const args = ["run", testCase.archive, "--mode", "fixture", "--grants", testCase.grants, "--out", out, ...testCase.tools.flatMap((tool) => ["--approve-tool", tool]), ...(inputPath ? ["--input", inputPath] : [])];
  const result = spawnSync(PYTHON_CLI, args, { encoding: "utf8", timeout: 300_000, maxBuffer: 64 * 1024 * 1024 });
  if (result.error) throw result.error;
  return { status: result.status ?? -1, report: result.stdout ? (JSON.parse(result.stdout) as JsonObject) : null, stderr: result.stderr, files: collect(out) };
}

function runNode(testCase: Case, out: string, inputPath: string | null): RunOutput {
  const args = ["run", testCase.archive, "--mode", "fixture", "--grants", testCase.grants, "--out", out, ...testCase.tools.flatMap((tool) => ["--approve-tool", tool]), ...(inputPath ? ["--input", inputPath] : [])];
  const result = cli.run(args, { timeoutMs: 300_000 });
  return { status: result.status, report: result.stdout ? (JSON.parse(result.stdout) as JsonObject) : null, stderr: result.stderr, files: collect(out) };
}

const decode = (data: Uint8Array): JsonValue => JSON.parse(new TextDecoder().decode(data)) as JsonValue;
const BACKBONE = /^(?:runtime|workflow)\./u;
/** `Role:7` → `Role:*`: instance numbers follow spawn order, which concurrency decides. */
const instance = (worker: unknown): unknown => (typeof worker === "string" ? worker.replace(/:\d+$/u, ":*") : worker);

/** D-063's view of a usage report: worker rows keyed by role, instance numbers dropped. */
function normalizeUsage(usage: JsonObject, allowTokens: boolean): JsonObject {
  const workers = Object.entries((usage.workers as JsonObject) ?? {})
    .map(([worker, row]) => [instance(worker) as string, row] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const rows: JsonObject = {};
  for (const [worker, row] of workers) {
    // Two instances of one role fold into one row: totals are what the comparison is about.
    const existing = (rows[worker] as JsonObject | undefined) ?? { tokens: 0, remote_calls: 0, tool_calls: {} };
    const record = row as JsonObject;
    const toolCalls = { ...(existing.tool_calls as JsonObject) };
    for (const [tool, count] of Object.entries((record.tool_calls as JsonObject) ?? {})) toolCalls[tool] = ((toolCalls[tool] as number) ?? 0) + (count as number);
    rows[worker] = { tokens: allowTokens ? 0 : (existing.tokens as number) + (record.tokens as number), remote_calls: (existing.remote_calls as number) + (record.remote_calls as number), tool_calls: toolCalls };
  }
  return { ...usage, tokens: allowTokens ? 0 : usage.tokens!, workers: rows };
}

/** D-063's view of an audit: the backbone in order, the rest per wave as a sorted multiset. */
function normalizeAudit(audit: JsonObject[], allowTokens: boolean): JsonValue[] {
  const view: JsonValue[] = [];
  let wave: string[] = [];
  const flush = () => {
    if (wave.length > 0) view.push([...wave].sort());
    wave = [];
  };
  for (const event of audit) {
    const action = String(event.action);
    if (BACKBONE.test(action) || action === "state.committed" || action === "memory.cleared") {
      flush();
      const entry: JsonObject = { action, node_id: event.node_id ?? null };
      if (action === "state.committed") entry.nodes = [...((event.nodes as string[]) ?? [])].sort();
      if (typeof event.error_code === "string") entry.error_code = event.error_code;
      view.push(entry);
      continue;
    }
    const facts: JsonValue[] = [action, event.node_id ?? null, event.role ?? null, event.task ?? event.tool ?? event.permission ?? null];
    if (action === "permission.checked") facts.push(event.allowed ?? null, event.grant ?? null);
    // The runtime records the settled count as `tokens` (review 1, finding 8).
    if (action === "model.completed" && !allowTokens) facts.push(event.tokens ?? null);
    wave.push(JSON.stringify(facts));
  }
  flush();
  return view;
}

describe("the two runtimes agree on every shipped fixture (D-063)", () => {
  for (const [index, testCase] of CASES.entries()) {
    it(testCase.name, () => {
      const base = join(scratch, `case-${index}`);
      let inputPath: string | null = null;
      if (testCase.input !== null) {
        inputPath = join(scratch, `input-${index}.json`);
        writeFileSync(inputPath, JSON.stringify(testCase.input));
      }
      const python = runPython(testCase, `${base}-py`, inputPath);
      const node = runNode(testCase, `${base}-node`, inputPath);
      expect(python.status, python.stderr).toBe(0);
      expect(node.status, node.stderr).toBe(0);
      // The report: identical apart from the directory each wrote into (and the usage view below).
      const { output_directory: _p, usage: pyUsage, ...pyReport } = python.report!;
      const { output_directory: _n, usage: nodeUsage, ...nodeReport } = node.report!;
      expect(nodeReport).toEqual(pyReport);
      expect(nodeReport.passed).toBe(true);
      expect(normalizeUsage(nodeUsage as JsonObject, testCase.tokensAllowlisted)).toEqual(normalizeUsage(pyUsage as JsonObject, testCase.tokensAllowlisted));
      if (testCase.tokensAllowlisted) {
        // The allowlisted difference is printed, never hidden (D-063: integral JSON floats in the fixture).
        console.log(`${testCase.name}: synthetic tokens python=${(pyUsage as JsonObject).tokens} node=${(nodeUsage as JsonObject).tokens}`);
      } else {
        expect((nodeUsage as JsonObject).tokens).toBe((pyUsage as JsonObject).tokens);
      }
      // The file set.
      expect(Object.keys(node.files)).toEqual(Object.keys(python.files));
      // result.json without the audit, the interpreter masked.
      const pyResult = decode(python.files["result.json"]!) as JsonObject;
      const nodeResult = decode(node.files["result.json"]!) as JsonObject;
      expect((nodeResult.provenance as JsonObject).interpreter).toBe("chrome-agent-browser.workflow.Workflow");
      expect((pyResult.provenance as JsonObject).interpreter).toBe("agentpkg.workflow.Workflow");
      // usage.json and provenance.json: each equals its own result's section, and the two
      // runtimes' files agree under result.json's normalisation (review 1, finding 8).
      expect(decode(node.files["usage.json"]!)).toEqual(nodeResult.usage);
      expect(decode(python.files["usage.json"]!)).toEqual(pyResult.usage);
      expect(normalizeUsage(decode(node.files["usage.json"]!) as JsonObject, testCase.tokensAllowlisted)).toEqual(normalizeUsage(decode(python.files["usage.json"]!) as JsonObject, testCase.tokensAllowlisted));
      const masked = (files: Record<string, Uint8Array>) => ({ ...(decode(files["provenance.json"]!) as JsonObject), interpreter: "<interpreter>" });
      expect(masked(node.files)).toEqual(masked(python.files));
      expect(masked(node.files)).toEqual({ ...(nodeResult.provenance as JsonObject), interpreter: "<interpreter>" });
      for (const result of [pyResult, nodeResult]) {
        (result.provenance as JsonObject).interpreter = "<interpreter>";
        result.usage = normalizeUsage(result.usage as JsonObject, testCase.tokensAllowlisted);
      }
      const { audit: pyAudit, ...pyRest } = pyResult;
      const { audit: nodeAudit, ...nodeRest } = nodeResult;
      expect(nodeRest).toEqual(pyRest);
      // Exports: JSON parsed, text bytes.
      for (const name of Object.keys(python.files)) {
        if (["result.json", "audit.json", "usage.json", "provenance.json"].includes(name)) continue;
        if (name.endsWith(".json")) expect(decode(node.files[name]!), name).toEqual(decode(python.files[name]!));
        else expect(Buffer.from(node.files[name]!).equals(Buffer.from(python.files[name]!)), name).toBe(true);
      }
      // The audit: same length, same backbone, same multiset per wave.
      const pyEvents = pyAudit as JsonObject[];
      const nodeEvents = nodeAudit as JsonObject[];
      expect(nodeEvents.length).toBe(pyEvents.length);
      expect(decode(node.files["audit.json"]!)).toEqual(nodeEvents);
      expect(normalizeAudit(nodeEvents, testCase.tokensAllowlisted)).toEqual(normalizeAudit(pyEvents, testCase.tokensAllowlisted));
      // Every event of either runtime is hash-linked to its predecessor within its own file.
      for (const events of [pyEvents, nodeEvents]) {
        events.forEach((event, at) => {
          expect(event.sequence).toBe(at + 1);
          expect(event.previous_hash ?? null).toBe(at === 0 ? null : events[at - 1]!.event_hash);
        });
      }
    });
  }
});
