/**
 * Answer checks (workflow.v0, agentpkg 0.3.0, D-150) in the Chrome core: the same checks, the same
 * refusals and the same audit as `agentpkg/tests/test_answer_checks.py`. A replay router asks no
 * model twice, so a refused check fails the call as a non-conforming answer exactly as the
 * reference does; the conformance suite compares the two runtimes on a package with checks.
 */
import { describe, expect, it } from "vitest";

import { ValidationError } from "../../../src/core/errors.js";
import type { JsonObject, JsonValue } from "../../../src/core/json.js";
import { AnswerCheckFailure, checkAnswer } from "../../../src/core/workflow/assertions.js";
import { WorkflowError } from "../../../src/core/workflow/errors.js";
import { agendaFiles, MINUTES_CHECK, type Nodes, OWNER_CHECK, ROLE_CHECK } from "../../helpers/agenda-checks.js";
import { loadSource } from "../../helpers/source-tree.js";
import { execute, executeFailing } from "../../helpers/workflow.js";

const models = (fixture: JsonObject) => fixture.models as Record<string, Array<{ output: JsonValue }>>;
const ownerDana = (fixture: JsonObject) => {
  (((models(fixture).write![0]!.output as JsonObject).agenda as JsonObject[])[1]!).owner = "Dana";
};
const minutesOff = (fixture: JsonObject) => {
  (((models(fixture).write![0]!.output as JsonObject).agenda as JsonObject[])[0]!).minutes = 6;
};
const focusTwice = (fixture: JsonObject) => {
  const focus = (models(fixture).plan![0]!.output as JsonObject).focus as JsonValue[];
  focus[2] = focus[0]!;
};
const roleWrong = (fixture: JsonObject) => {
  ((models(fixture).perspective![2]!.output as JsonObject[])[0]!).role = "Sales";
};

type Event = Record<string, unknown>;
const auditOf = (error: { execution_report?: Record<string, unknown> }) => error.execution_report!.audit as Event[];

describe("answer checks: evaluation (the reference's cases)", () => {
  it("checks that hold change nothing but the runtime minimum", async () => {
    const withChecks = await execute(await loadSource(agendaFiles()));
    const without = await execute(await loadSource(agendaFiles({ checks: false, minimum: "0.2.2" })));
    expect(withChecks.status).toBe("completed");
    expect(withChecks.output).toEqual(without.output);
    expect(withChecks.usage.tokens).toBe(without.usage.tokens);
    const actions = withChecks.audit.map((event) => event.action);
    expect(actions).not.toContain("model.failed");
    expect(actions.filter((action) => action === "model.completed")).toHaveLength(5);
  });

  const cases: Array<[string, (fixture: JsonObject) => void, string, string, JsonObject, string | null]> = [
    ["an owner who is not a participant", ownerDana, "write", "write", { check: "answer_check", index: 0, kind: "relation", failure: "missing_target_key", row_key: "/owner", target_key: "/name" }, "Dana"],
    ["minutes that do not add up", minutesOff, "write", "write", { check: "answer_check", index: 1, kind: "sum", failure: "sum_differs", path: "/minutes" }, null],
    ["a focus point twice", focusTwice, "plan", "plan", { check: "answer_check", index: 0, kind: "relation", failure: "duplicate_target_key", target_key: "" }, null],
    ["a perspective for the wrong role, inside a map step", roleWrong, "perspective", "perspectives", { check: "answer_check", index: 0, kind: "equal", failure: "values_differ" }, "Sales"],
  ];
  for (const [title, edit, task, node, failedCheck, secret] of cases) {
    it(`a refused check fails the call as a non-conforming answer: ${title}`, async () => {
      const error = await executeFailing(await loadSource(agendaFiles({ fixture: edit })));
      expect(error).toBeInstanceOf(WorkflowError);
      expect([error.code, error.node_id]).toEqual(["model_error", node]);
      const audit = auditOf(error);
      const failed = audit.filter((event) => event.action === "model.failed");
      expect(failed).toHaveLength(1);
      expect(failed[0]).toMatchObject({ task, error: "AnswerCheckFailure", reason: "model_output_not_conforming", failure_facts: { output_failure: "check" }, failed_check: failedCheck });
      // Charged what the replay router reported (its synthetic count), not the reservation.
      const called = audit.filter((event) => event.action === "model.called" && event.worker === failed[0]!.worker);
      expect(failed[0]!.tokens_charged as number).toBeLessThan(called.at(-1)!.reserved_tokens as number);
      const named = audit.filter((event) => event.action === "node.failed" && "failed_check" in event);
      expect(named.map((event) => event.node_id)).toEqual(node === "perspectives" ? ["perspectives/one-perspective", "perspectives"] : [node]);
      for (const event of named) expect(event.failed_check).toEqual(failedCheck);
      if (secret !== null) expect(JSON.stringify(audit)).not.toContain(secret);
    });
  }

  it("a check that cannot be evaluated on this answer fails as not_evaluable", async () => {
    const missingRow = { kind: "equal", left: { from: "result", path: "/agenda/9/topic" }, right: { literal: "x" } };
    const error = await executeFailing(await loadSource(agendaFiles({ graph: (nodes) => (nodes.write!.checks = [missingRow]) })));
    expect([error.code, error.node_id]).toEqual(["model_error", "write"]);
    expect(auditOf(error).find((event) => event.action === "model.failed")!.failed_check).toEqual({ check: "answer_check", index: 0, kind: "equal", failure: "not_evaluable" });
  });

  it("checkAnswer reads the answer as result and the operation's scope beside it", () => {
    const env = { state: { request: { participants: [{ name: "Ari" }], duration: 5 } } };
    checkAnswer([OWNER_CHECK, MINUTES_CHECK], env, { agenda: [{ owner: "Ari", minutes: 5 }] });
    let refused: unknown = null;
    try {
      checkAnswer([MINUTES_CHECK, OWNER_CHECK], env, { agenda: [{ owner: "Bo", minutes: 5 }] });
    } catch (error) {
      refused = error;
    }
    expect(refused).toBeInstanceOf(AnswerCheckFailure);
    const failure = refused as AnswerCheckFailure;
    expect(failure.failed_check.index).toBe(1);
    expect(failure.code).toBe("model_output_not_conforming");
    expect(failure.audit_facts).toEqual({ output_failure: "check" });
    expect(failure).not.toBeInstanceOf(ValidationError);
    expect(JSON.stringify(failure.failed_check)).not.toContain("Bo");
    // The key values it is about are kept apart, for a re-ask's feedback line only (D-151).
    expect(failure.offending).toEqual(["Bo"]);
  });
});

describe("answer checks: static validation (the reference's cases)", () => {
  const refusals: Array<[string, (nodes: Nodes) => void, RegExp]> = [
    ["on a validate node", (nodes) => (nodes.validate!.checks = [MINUTES_CHECK]), /graph\.json/u],
    ["on a map node", (nodes) => (nodes.perspectives!.checks = [ROLE_CHECK]), /graph\.json/u],
    ["with a source the scope does not have", (nodes) => (nodes.plan!.checks = [{ kind: "equal", left: { from: "input", path: "/goal" }, right: { literal: 1 } }]), /source 'input' is unavailable in this scope/u],
    ["reading state outside the role's view", (nodes) => (nodes.plan!.checks = [{ kind: "equal", left: { from: "state", path: "/plan" }, right: { literal: 1 } }]), /projection exceeds Planner state_read/u],
    ["at a pointer the answer's schema does not declare", (nodes) => (nodes.plan!.checks = [{ kind: "equal", left: { from: "result", path: "/elsewhere" }, right: { literal: 1 } }]), /state\/data path component 'elsewhere' not declared/u],
    ["naming the step it belongs to", (nodes) => (((nodes.perspectives!.steps as JsonObject[])[0]!).checks = [{ kind: "equal", left: { from: "steps", path: "/one-perspective" }, right: { literal: 1 } }]), /unknown or forward step reference/u],
  ];
  for (const [title, graph, message] of refusals) {
    it(`refuses checks ${title}`, async () => {
      await expect(loadSource(agendaFiles({ graph }))).rejects.toThrow(message);
    });
  }

  it("a package with checks declares the runtime that evaluates them, even for an empty list", async () => {
    await expect(loadSource(agendaFiles({ minimum: "0.2.2" }))).rejects.toThrow(/answer checks require runtime\.minimum_version 0\.3\.0 or later/u);
    await expect(loadSource(agendaFiles({ minimum: "0.2.2", checks: false, graph: (nodes) => (nodes.plan!.checks = []) }))).rejects.toThrow(/answer checks require/u);
    const pkg = await loadSource(agendaFiles());
    expect((pkg.manifest.runtime as JsonObject).minimum_version).toBe("0.3.0");
  });
});
