/**
 * conversation.v0 enforcement cases (`examples/conversation/cases/cases.json`, spec §10): every
 * case ends at the stage with the code the list expects, on this runtime, as
 * `test_conversation_cases.py` asserts it on the reference.
 */
import { describe, expect, it } from "vitest";

import { Conversation } from "../../../src/core/conversation/runner.js";
import { checkTranscript, type TranscriptInput } from "../../../src/core/conversation/transcript.js";
import type { ConsentHost, ConsentRequest } from "../../../src/core/conversation/host.js";
import { ValidationError } from "../../../src/core/errors.js";
import { checkCapabilities } from "../../../src/core/execution/policy.js";
import { DEFAULT_HOST_LIMITS } from "../../../src/core/execution/limits.js";
import { ExecutionError } from "../../../src/core/execution/errors.js";
import { fixtureAdapters } from "../../../src/core/fixtures.js";
import type { JsonObject } from "../../../src/core/json.js";
import { loadPackageBytes, type Package } from "../../../src/core/package.js";
import { PolicyError } from "../../../src/core/workflow/errors.js";
import { runWorkflow } from "../../../src/core/workflow/interpreter.js";
import { caseList, grants, probeBytes, transcript, VARIANTS } from "../../helpers/conversation-package.js";

const LIST = caseList();
type Case = (typeof LIST)["cases"][number];

/** A host whose person never answers: the node's timeout ends the step. */
class SilentConsent implements ConsentHost {
  readonly used = new Set<string>();
  decide(_request: ConsentRequest, signal: AbortSignal): Promise<unknown> {
    return new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
  }
}

class InvalidConsent implements ConsentHost {
  readonly used = new Set<string>();
  async decide(): Promise<unknown> {
    return { accepted: "yes", decided_by: "nobody" };
  }
}

async function build(testCase: Case): Promise<Uint8Array> {
  return (await probeBytes({ mutate: testCase.variant ? VARIANTS[testCase.variant]! : null, remoteTool: testCase.remote_tool === true })).bytes;
}

function transcriptOf(testCase: Case): TranscriptInput {
  if (testCase.transcript_raw) return testCase.transcript_raw as unknown as TranscriptInput;
  return transcript(testCase.transcript ?? []);
}

async function converse(pkg: Package, testCase: Case) {
  const decisions = grants(testCase.grants ?? {});
  const document = transcriptOf(testCase);
  await checkTranscript(document, pkg, decisions);
  const { router, handlers } = fixtureAdapters(pkg);
  if (testCase.host === "silent") {
    // The node's timeout bounds the wait: one second here, so the case runs quickly.
    for (const node of pkg.graph.nodes as JsonObject[]) if (node.type === "consent") node.timeout_seconds = 1;
  }
  const consent = testCase.host === "silent" ? () => new SilentConsent() : testCase.host === "invalid" ? () => new InvalidConsent() : null;
  const conversation = new Conversation(pkg, { grants: decisions, approvedTools: ["place"], adapters: () => ({ router, handlers }), limits: (testCase.limits as Record<string, number> | undefined) ?? null, consent });
  return conversation.run(document);
}

describe.each(LIST.cases.map((c) => [c.id, c] as const))("%s", (_id, testCase) => {
  it(testCase.title, async () => {
    const stage = testCase.stage;
    if (stage === "validation") {
      await expect(build(testCase).then((bytes) => loadPackageBytes(bytes))).rejects.toSatisfy((error) => error instanceof ValidationError && (error as Error).message.startsWith(`${testCase.code}: `));
      return;
    }
    const pkg = await loadPackageBytes(await build(testCase));
    if (stage === "start") {
      if (testCase.path === "run") {
        // The one-shot interpreter refuses a conversational package before anything runs (V-28); the CLI's `run` says `conversation_profile`.
        const { router, handlers, input } = fixtureAdapters(pkg);
        await expect(runWorkflow(pkg, input, { router, handlers, grants: grants(), approvedTools: ["place"] })).rejects.toSatisfy((error) => error instanceof PolicyError && (error as Error).message.startsWith("conversation_turn_required: "));
        return;
      }
      await expect(checkTranscript(transcriptOf(testCase), pkg, grants(testCase.grants ?? {}))).rejects.toSatisfy((error) => error instanceof ValidationError && (error as Error).message.startsWith(`${testCase.code}: `));
      return;
    }
    if (stage === "host") {
      let caught: unknown = null;
      try {
        checkCapabilities(pkg, DEFAULT_HOST_LIMITS, { fixture: true });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(ExecutionError);
      expect((caught as ExecutionError).code).toBe(testCase.code);
      return;
    }
    const result = await converse(pkg, testCase);
    const record = result.transcript;
    const turns = record.turns as JsonObject[];
    const expectation = testCase.expect ?? {};
    const statuses = turns.map((turn) => turn.status);
    const audit = result.audit as unknown as JsonObject[];
    if (stage === "turn") {
      const refused = turns.filter((turn) => turn.status === "refused");
      expect(refused.length, JSON.stringify(statuses)).toBeGreaterThan(0);
      expect(refused[0]!.refusal).toBe(testCase.reason);
      expect(audit.filter((event) => event.action === "turn.refused").map((event) => event.reason)).toEqual([testCase.reason]);
    } else {
      if (testCase.code === "completed") expect(result.status, JSON.stringify(statuses)).toBe("completed");
      else {
        const failed = turns.filter((turn) => turn.status === "failed");
        expect(failed.length, JSON.stringify(statuses)).toBeGreaterThan(0);
        expect(failed[0]!.error_code).toBe(testCase.code);
        if (expectation.node) {
          const nodeFailures = audit.filter((event) => event.action === "node.failed" && event.node_id === expectation.node);
          expect(nodeFailures.length).toBeGreaterThan(0);
          expect(nodeFailures[0]!.error_code).toBe(testCase.code);
        }
      }
      if (testCase.reason) {
        const checks = audit.filter((event) => event.action === "permission.checked" && event.reason === testCase.reason);
        expect(checks.length).toBeGreaterThan(0);
        expect(checks[0]!.allowed).toBe(false);
      }
    }
    if (expectation.turns) expect(statuses).toEqual(expectation.turns);
    const toolCalls = audit.filter((event) => event.action === "tool.called").length;
    if (expectation.tool_called === false) expect(toolCalls).toBe(0);
    if (typeof expectation.tool_calls === "number") expect(toolCalls).toBe(expectation.tool_calls);
    if (expectation.ended) expect(result.ended.reason).toBe(expectation.ended);
    if (expectation.decided_by) {
      const decided = audit.filter((event) => event.action === "consent.decided");
      expect(decided.length).toBeGreaterThan(0);
      expect(decided[0]!.decided_by).toBe(expectation.decided_by);
      expect(decided[0]!.reason ?? null).toBe(expectation.reason ?? null);
    }
    if (Array.isArray(expectation.decided)) {
      // Every decision of the conversation, in order, as the chain and the transcript hold it.
      const keys = ["step", "accepted", "decided_by", "reason"] as const;
      const pick = (event: JsonObject) => Object.fromEntries(keys.map((key) => [key, event[key] ?? null]));
      const decided = audit.filter((event) => event.action === "consent.decided").map(pick);
      const expected = (expectation.decided as JsonObject[]).map((entry) => ({ ...entry, reason: entry.reason ?? null }));
      expect(decided).toEqual(expected);
      const taken = turns.flatMap((turn) => (turn.decisions as JsonObject[]).map(pick));
      expect(taken).toEqual(expected);
    }
    for (const [turnNumber, unused] of Object.entries((expectation.unused_consents as JsonObject | undefined) ?? {})) {
      expect(turns[Number(turnNumber) - 1]!.unused_consents).toEqual(unused);
    }
    if (expectation.history_after) expect(result.state.history).toEqual(expectation.history_after);
    if (typeof expectation.orders_after === "number") expect((result.state.orders as unknown[]).length).toBe(expectation.orders_after);
  });
});
