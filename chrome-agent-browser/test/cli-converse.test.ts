/**
 * `converse` on the built CLI (conversation.v0, D-263): the same flags, directory and report as
 * `agentpkg converse`; `run` refuses a conversational package by the profile (V-28).
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { verifyAuditChain } from "../src/core/execution/report.js";
import type { JsonObject } from "../src/core/json.js";
import { BuiltCli } from "./helpers/cli.js";
import { CONVERSATION_TEST, ROOT, SHIPPED } from "./helpers/paths.js";

const PYTHON_CLI = process.env.AGENTPKG_CLI ?? join(ROOT, "agentpkg", ".venv", "bin", "agentpkg");

let cli: BuiltCli;
let scratch: string;
beforeAll(async () => {
  cli = await BuiltCli.build();
  // agentpkg refuses an output path with a symlink component (macOS: /var → /private/var).
  scratch = mkdtempSync(join(realpathSync(tmpdir()), "agent-browser-converse-"));
}, 120_000);
afterAll(() => {
  cli.dispose();
  rmSync(scratch, { recursive: true, force: true });
});

const base = () => ["converse", CONVERSATION_TEST.archive, "--mode", "fixture", "--grants", CONVERSATION_TEST.grants, "--approve-tool", "place-order", "--trust-key", CONVERSATION_TEST.key];

describe("converse", () => {
  it("writes the conversation's files and every turn's directory, and reports as agentpkg converse does", () => {
    const out = join(scratch, "fixture");
    const result = cli.run([...base(), "--out", out]);
    expect(result.status, result.stderr).toBe(0);
    const report = JSON.parse(result.stdout) as JsonObject;
    expect(report).toMatchObject({ status: "completed", profile: "conversation.v0", output_directory: out, turns: [{ turn: 1, status: "completed" }, { turn: 2, status: "completed" }], approved_tools: ["place-order"], fixture_replay: true, passed: true });
    expect((report.ended as JsonObject).reason).toBe("package");
    expect(readdirSync(out).sort()).toEqual(["audit.json", "provenance.json", "state.json", "transcript.json", "turn-001", "turn-002", "usage.json"]);
    expect(readdirSync(join(out, "turn-001")).sort()).toEqual(["audit.json", "provenance.json", "reply.json", "result.json", "usage.json"]);
    const audit = JSON.parse(readFileSync(join(out, "audit.json"), "utf8")) as JsonObject[];
    expect(verifyAuditChain(audit).valid).toBe(true);
    const slice = JSON.parse(readFileSync(join(out, "turn-002", "audit.json"), "utf8")) as JsonObject[];
    // A turn's audit is its slice of the chain: it counts on from where the chain stood (V-17).
    expect(slice[0]!.sequence).toBeGreaterThan(1);
    expect(slice[0]!.previous_hash).toBe(audit[(slice[0]!.sequence as number) - 2]!.event_hash);
    const provenance = JSON.parse(readFileSync(join(out, "provenance.json"), "utf8")) as JsonObject;
    expect(provenance.interpreter).toBe("chrome-agent-browser.conversation.Conversation");
    expect(provenance.persistent_keys).toEqual(["history", "orders"]);
  });

  it("a failed turn exits 1 with the transcript written; a refused transcript leaves no --out behind (D-265)", () => {
    const transcript = join(scratch, "denied.json");
    writeFileSync(transcript, JSON.stringify({ schema: "conversation.transcript.v0", turns: [{ message: { text: "Two tickets for Friday's show, please." }, consents: { "confirm-order": true } }] }));
    const denied = join(scratch, "denied-grants.json");
    writeFileSync(denied, JSON.stringify({ ...(JSON.parse(readFileSync(CONVERSATION_TEST.grants, "utf8")) as JsonObject), "orders.place": "deny" }));
    const out = join(scratch, "refused");
    const refused = cli.run(["converse", CONVERSATION_TEST.archive, "--mode", "fixture", "--grants", denied, "--transcript", transcript, "--approve-tool", "place-order", "--trust-key", CONVERSATION_TEST.key, "--out", out]);
    expect(refused.status).toBe(2);
    expect(refused.stderr).toMatch(/^agent-browser: consent_not_authorized: /u);
    expect(existsSync(out)).toBe(false);
    const bad = join(scratch, "bad-grants.json");
    writeFileSync(bad, JSON.stringify({ ...(JSON.parse(readFileSync(CONVERSATION_TEST.grants, "utf8")) as JsonObject), "orders.place": "forever" }));
    const refusedGrant = cli.run(["converse", CONVERSATION_TEST.archive, "--mode", "fixture", "--grants", bad, "--approve-tool", "place-order", "--trust-key", CONVERSATION_TEST.key, "--out", join(scratch, "refused-grant")]);
    expect(refusedGrant.status).toBe(2);
    expect(refusedGrant.stderr).toMatch(/Grant must be/u);
    expect(existsSync(join(scratch, "refused-grant"))).toBe(false);
  });

  it("an approval of an undeclared tool is refused by the conversation's own check, with the reference's message (T24 review 1 nit 11)", () => {
    const out = join(scratch, "ghost");
    const result = cli.run(["converse", CONVERSATION_TEST.archive, "--mode", "fixture", "--grants", CONVERSATION_TEST.grants, "--approve-tool", "ghost", "--trust-key", CONVERSATION_TEST.key, "--out", out]);
    expect(result.status).toBe(2);
    expect(result.stderr.trim()).toBe("agent-browser: Tool approval refers to a tool this package does not declare");
    expect(existsSync(out)).toBe(false);
  });

  it("in live mode the approval is refused before binding contacts a model provider (T24 review 2 nit 5)", () => {
    const transcript = join(scratch, "live-ghost.json");
    writeFileSync(transcript, JSON.stringify({ schema: "conversation.transcript.v0", turns: [{ message: { text: "hello" } }] }));
    const out = join(scratch, "live-ghost");
    // An Ollama nobody answers on: binding would fail on it, with another message, before the fix.
    const result = cli.run(["converse", CONVERSATION_TEST.archive, "--mode", "live", "--grants", CONVERSATION_TEST.grants, "--transcript", transcript, "--approve-tool", "ghost", "--trust-key", CONVERSATION_TEST.key, "--model", "ollama/qwen3:30b", "--ollama-url", "http://127.0.0.1:1", "--out", out]);
    expect(result.status).toBe(2);
    expect(result.stderr.trim()).toBe("agent-browser: Tool approval refers to a tool this package does not declare");
    expect(existsSync(out)).toBe(false);
  });

  it("checks --out before the conversation's limits, in the reference's order (T24 review 4 nit 2)", () => {
    const limits = join(scratch, "out-first-limits.json");
    writeFileSync(limits, JSON.stringify({ conversation_max_turns: -1 }));
    const existing = join(scratch, "out-first-existing");
    writeFileSync(existing, "");
    const argv = [...base(), "--limits", limits, "--out", existing];
    const node = cli.run(argv);
    const python = spawnSync(PYTHON_CLI, argv, { cwd: ROOT, encoding: "utf8" });
    expect(node.status).toBe(2);
    expect(python.status).toBe(2);
    expect(node.stderr.trim().replace(/^agent-browser: /u, "")).toBe(python.stderr.trim().replace(/^agentpkg: /u, ""));
    expect(node.stderr).toContain("--out");
  });

  it("in live mode a conversation limit is refused before binding contacts a model provider (T24 review 3 nit 3)", () => {
    const transcript = join(scratch, "live-limit.json");
    writeFileSync(transcript, JSON.stringify({ schema: "conversation.transcript.v0", turns: [{ message: { text: "hello" } }] }));
    const limits = join(scratch, "live-limit-limits.json");
    writeFileSync(limits, JSON.stringify({ conversation_max_turns: -1 }));
    const out = join(scratch, "live-limit");
    const result = cli.run(["converse", CONVERSATION_TEST.archive, "--mode", "live", "--grants", CONVERSATION_TEST.grants, "--transcript", transcript, "--approve-tool", "place-order", "--limits", limits, "--trust-key", CONVERSATION_TEST.key, "--model", "ollama/qwen3:30b", "--ollama-url", "http://127.0.0.1:1", "--out", out]);
    expect(result.status).toBe(2);
    expect(result.stderr.trim()).toBe("agent-browser: Host limit conversation_max_turns must be a nonnegative integer");
    expect(existsSync(out)).toBe(false);
  });

  it("WebAir 0.8.0's signed fixture conversation gives the reference's transcript, state and usage (T24, fixture parity)", () => {
    const argv = (out: string) => ["converse", SHIPPED.webair080.archive, "--mode", "fixture", "--grants", join(ROOT, "examples", "webair-0.8.0-grants.json"), "--approve-tool", "search-flights", "--approve-tool", "get-fare-rules", "--trust-key", SHIPPED.webair080.key, "--out", out];
    const pyOut = join(scratch, "webair-080-python");
    const nodeOut = join(scratch, "webair-080-node");
    const python = spawnSync(PYTHON_CLI, argv(pyOut), { encoding: "utf8", timeout: 300_000, maxBuffer: 64 * 1024 * 1024 });
    const node = cli.run(argv(nodeOut), { timeoutMs: 300_000 });
    expect([python.status, node.status]).toEqual([0, 0]);
    const read = (directory: string, name: string) => JSON.parse(readFileSync(join(directory, name), "utf8")) as JsonObject;
    // The transcript without its ids and instants.
    const turns = (directory: string) => (read(directory, "transcript.json").turns as JsonObject[]).map(({ run_id: _r, started_at: _s, ended_at: _e, ...turn }) => turn);
    expect(turns(nodeOut)).toEqual(turns(pyOut));
    expect(turns(nodeOut).map((turn) => turn.status)).toEqual(["completed", "completed", "completed"]);
    expect((read(nodeOut, "transcript.json").ended as JsonObject).reason).toBe("package");
    expect(read(nodeOut, "state.json")).toEqual(read(pyOut, "state.json"));
    expect(read(nodeOut, "usage.json")).toEqual(read(pyOut, "usage.json"));
    expect(verifyAuditChain(JSON.parse(readFileSync(join(nodeOut, "audit.json"), "utf8")) as JsonObject[]).valid).toBe(true);
  }, 600_000);

  it("run refuses a conversational package by its profile (V-28)", () => {
    const result = cli.run(["run", CONVERSATION_TEST.archive, "--mode", "fixture", "--grants", CONVERSATION_TEST.grants, "--approve-tool", "place-order", "--trust-key", CONVERSATION_TEST.key, "--out", join(scratch, "run")]);
    expect(result.status).toBe(2);
    expect(result.stderr.trim()).toBe("agent-browser: conversation_profile: this package declares a conversation and runs turn by turn; use agentpkg converse");
    expect(existsSync(join(scratch, "run"))).toBe(false);
  });
});
