/**
 * The conversation.v0 contracts copied into the core equal the spec's files (D-025, D-263), and the
 * signed test package (`org.webagents.conversation-test` 0.1.0, T23) runs on this core as the
 * spec says it does on the reference (`test_conversation_test_package.py`).
 */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { validateTranscriptDocument } from "../../../src/core/conversation/declarations.js";
import { Conversation, fixtureTranscript } from "../../../src/core/conversation/runner.js";
import { checkTranscript } from "../../../src/core/conversation/transcript.js";
import { verifyAuditChain } from "../../../src/core/execution/report.js";
import { fixtureAdapters } from "../../../src/core/fixtures.js";
import type { JsonObject } from "../../../src/core/json.js";
import { publicKeyFromPem } from "../../../src/core/keys.js";
import { loadPackageBytes } from "../../../src/core/package.js";
import { CONVERSATION_CONTRACT_FILES, CONVERSATION_CONTRACTS } from "../../../src/core/schemas/conversation/index.js";
import { verifyWithTrustedKey } from "../../../src/core/signature.js";
import { CONTRACTS } from "../../helpers/conversation-package.js";
import { CONVERSATION_TEST, readBytes, readText } from "../../helpers/paths.js";

describe("the conversation.v0 contracts", () => {
  it("are the spec's files, byte for byte, and nothing is missing", () => {
    const names = readdirSync(CONTRACTS).filter((name) => name.endsWith(".json")).sort();
    expect([...CONVERSATION_CONTRACT_FILES]).toEqual(names);
    expect(names).toEqual(["consent-decision.schema.json", "transcript-input.schema.json", "transcript.schema.json", "workflow.schema.patch.json"]);
    for (const name of names) expect(JSON.stringify(CONVERSATION_CONTRACTS[name.replace(/\.json$/u, "")]), name).toBe(JSON.stringify(JSON.parse(readFileSync(join(CONTRACTS, name), "utf8"))));
  });
});

describe("the signed conversation test package", () => {
  it("is pinned: the digest, the archive hash and the signer (D-003)", async () => {
    const bytes = readBytes(CONVERSATION_TEST.archive);
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(CONVERSATION_TEST.archiveSha256);
    const pkg = await loadPackageBytes(bytes);
    expect(pkg.digest).toBe(CONVERSATION_TEST.digest);
    expect(pkg.manifest.package_id).toBe(CONVERSATION_TEST.packageId);
    expect((pkg.manifest.runtime as JsonObject).minimum_version).toBe("0.6.0");
    const verified = await verifyWithTrustedKey(pkg, publicKeyFromPem(readText(CONVERSATION_TEST.key)));
    expect(verified.key_fingerprint).toBe(CONVERSATION_TEST.fingerprint);
    const conversation = pkg.graph.conversation as JsonObject;
    expect(conversation.budget).toEqual({ max_turns: 4, hard_tokens: 20000, max_remote_calls: 0, max_calls_per_tool: { "place-order": 1 } });
    expect((pkg.graph.nodes as JsonObject[]).filter((node) => node.type === "consent").map((node) => node.id)).toEqual(["confirm-order"]);
    expect(pkg.tools["place-order"]!.side_effects).toBe("write");
  });

  it("the fixture conversation runs as the spec says (§11): an order confirmed, then goodbye; one chain", async () => {
    const pkg = await loadPackageBytes(readBytes(CONVERSATION_TEST.archive));
    const grants = JSON.parse(readText(CONVERSATION_TEST.grants)) as Record<string, "session">;
    const document = fixtureTranscript(pkg)!;
    await checkTranscript(document, pkg, grants);
    const { router, handlers } = fixtureAdapters(pkg);
    const result = await new Conversation(pkg, { grants, approvedTools: ["place-order"], adapters: () => ({ router, handlers }) }).run(document);
    expect(result.status).toBe("completed");
    const turns = result.transcript.turns as JsonObject[];
    expect(turns.map((turn) => [turn.turn, turn.status])).toEqual([
      [1, "completed"],
      [2, "completed"],
    ]);
    expect(result.ended.reason).toBe("package");
    expect(result.usage.tool_calls).toEqual({ "place-order": 1 });
    await validateTranscriptDocument(result.transcript, "output", "transcript.json");
    const [first, second] = turns as [JsonObject, JsonObject];
    const decision = (first.decisions as JsonObject[])[0]!;
    expect(decision).toMatchObject({ step: "confirm-order", permissions: ["orders.place"], accepted: true, decided_by: "transcript", reason: null, text: "Place an order for two tickets to Friday's show?", facts: { show: "Friday's show", quantity: 2 } });
    const order = { order_id: "TD-0001", show: "Friday's show", quantity: 2, total_usd: 90 };
    expect((first.reply as JsonObject).order).toEqual(order);
    expect((first.reply as JsonObject).intent).toBe("order");
    expect(second.decisions).toEqual([]);
    expect((second.reply as JsonObject).intent).toBe("done");
    expect(result.transcript.state).toEqual({ history: [{ text: "Two tickets for Friday's show, please.", intent: "order" }, { text: "That's all, thanks.", intent: "done" }], orders: [order] });
    expect(result.transcript.spent_permissions).toEqual([]);
    const audit = result.audit as unknown as JsonObject[];
    expect(verifyAuditChain(audit).valid).toBe(true);
    expect(audit.map((event) => event.sequence)).toEqual(audit.map((_, index) => index + 1));
    expect(audit.filter((event) => String(event.action).startsWith("consent.")).map((event) => event.action)).toEqual(["consent.requested", "consent.decided"]);
    // The same figures the reference reports on this package (T23): 997 tokens, 100 events.
    expect(result.usage.tokens).toBe(997);
    expect(audit.length).toBe(100);
  });
});
