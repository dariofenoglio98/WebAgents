/**
 * `converse` on the built CLI (conversation.v0, D-263): the same flags, directory and report as
 * `agentpkg converse`; `run` refuses a conversational package by the profile (V-28).
 */
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { verifyAuditChain } from "../src/core/execution/report.js";
import type { JsonObject } from "../src/core/json.js";
import { BuiltCli } from "./helpers/cli.js";
import { CONVERSATION_TEST } from "./helpers/paths.js";

let cli: BuiltCli;
let scratch: string;
beforeAll(async () => {
  cli = await BuiltCli.build();
  scratch = mkdtempSync(join(tmpdir(), "agent-browser-converse-"));
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

  it("run refuses a conversational package by its profile (V-28)", () => {
    const result = cli.run(["run", CONVERSATION_TEST.archive, "--mode", "fixture", "--grants", CONVERSATION_TEST.grants, "--approve-tool", "place-order", "--trust-key", CONVERSATION_TEST.key, "--out", join(scratch, "run")]);
    expect(result.status).toBe(2);
    expect(result.stderr.trim()).toBe("agent-browser: conversation_profile: this package declares a conversation and runs turn by turn; use agentpkg converse");
    expect(existsSync(join(scratch, "run"))).toBe(false);
  });
});
