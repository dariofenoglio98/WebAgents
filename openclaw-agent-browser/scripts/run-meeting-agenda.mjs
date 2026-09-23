#!/usr/bin/env node
/**
 * Live acceptance driver for the first real execution of a portable agent package.
 *
 * It walks the exact sequence a person walks in the Agent Browser page — open,
 * trust, authorize, evaluate models, choose one, prepare a run plan — and then
 * invokes the operations the page does not offer: start an execution, wait for
 * it, and read what it produced.
 *
 * Every step goes through the running Gateway (`plugins.sessionAction`), so the
 * plugin backend answering is the installed one, with the real
 * `api.runtime.llm` and the operator's real model credentials. Nothing here
 * reaches a provider directly, renders a prompt, or names a model to the
 * runner: the model comes from the run plan, and the instructions come from the
 * signed package.
 *
 *   node scripts/run-meeting-agenda.mjs \
 *     --package /path/to/meeting-agenda.agent.pkg \
 *     --input   /path/to/meeting-agenda-input.json \
 *     [--model openai/gpt-5.6-luna] [--out report.json] [--keep]
 *
 * This spends real tokens on the selected model, once.
 */
import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { promisify } from "node:util";

const run = promisify(execFile);
const PLUGIN_ID = "agent-browser";

function parseArgs(argv) {
  const args = { keep: false };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--keep") args.keep = true;
    else if (flag.startsWith("--")) args[flag.slice(2)] = argv[++index];
  }
  if (!args.package) throw new Error("--package <path to .agent.pkg> is required");
  if (!args.input) throw new Error("--input <path to workflow input JSON> is required");
  return args;
}

/** One typed feature operation, dispatched through the live Gateway. */
async function call(actionId, payload, timeoutMs = 900_000) {
  const { stdout } = await run(
    "openclaw",
    [
      "gateway",
      "call",
      "plugins.sessionAction",
      "--json",
      "--timeout",
      String(timeoutMs),
      "--params",
      JSON.stringify({ pluginId: PLUGIN_ID, actionId, payload }),
    ],
    { maxBuffer: 64 * 1024 * 1024, env: { ...process.env, NO_COLOR: "1" } },
  );
  const envelope = JSON.parse(stdout);
  if (envelope.ok !== true) {
    throw new Error(`${actionId} failed at the Gateway: ${JSON.stringify(envelope).slice(0, 800)}`);
  }
  const result = envelope.result;
  // Feature results are themselves typed ok/error unions; service.status is not.
  if (result && typeof result === "object" && "ok" in result && result.ok === false) {
    const error = result.error ?? {};
    throw new Error(`${actionId} refused: ${error.code} — ${error.detail ?? error.title ?? ""}`);
  }
  return result && typeof result === "object" && "ok" in result ? result.value : result;
}

/** Everything a reviewer should be able to check about one run, in one place. */
function auditRun(record, chosenModel) {
  const actions = Object.fromEntries((record.audit?.actions ?? []).map((i) => [i.action, i.count]));
  const tasks = Object.fromEntries((record.audit?.tasksCalled ?? []).map((i) => [i.task, i.count]));
  return {
    status: record.status,
    errorCode: record.errorCode,
    llmCalls: record.audit?.modelCalls ?? 0,
    tasksCalled: tasks,
    workerIds: record.audit?.workers ?? [],
    workersSpawned: record.audit?.workersSpawned ?? 0,
    peakParallelWorkers: record.usage?.peakParallelWorkers ?? 0,
    plannedModel: record.selectedModel.hostModelId,
    invokedModels: record.model?.invoked ?? [],
    everyCallUsedPlannedModel: record.model?.allCallsUsedPlannedModel === true,
    modelMatchesChoice: record.selectedModel.hostModelId === chosenModel,
    totalTokens: record.usage?.tokens ?? 0,
    remoteCalls: record.usage?.remoteCalls ?? 0,
    toolCalls: record.audit?.toolCalls ?? 0,
    cost: record.cost,
    durationMs: record.durationMs,
    resultHash: record.outputSha256,
    auditEvents: record.audit?.events ?? 0,
    auditChainValid: record.audit?.chainValid === true,
    auditActions: actions,
    nodesCompleted: record.audit?.nodesCompleted ?? 0,
    artifacts: record.artifacts,
    packageExecution: record.packageExecution,
    hostRuntime: record.host,
    revalidated: record.revalidated,
  };
}

/** The package's own assertions, re-checked here against the written agenda. */
function checkAgenda(agenda, input) {
  const minutes = (agenda?.agenda ?? []).reduce((total, item) => total + item.minutes, 0);
  return {
    goalPreserved: agenda?.goal === input.goal,
    durationPreserved: agenda?.duration === input.duration,
    minutesSum: minutes,
    minutesSumMatchesDuration: minutes === input.duration,
    items: (agenda?.agenda ?? []).length,
    owners: [...new Set((agenda?.agenda ?? []).map((item) => item.owner))],
    hasPreparation: (agenda?.preparation_items ?? []).length > 0,
    hasDecisions: (agenda?.decisions ?? []).length > 0,
    hasQuestions: (agenda?.questions ?? []).length > 0,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const input = JSON.parse(await readFile(args.input, "utf8"));
  const report = { recordedAt: new Date().toISOString(), input, steps: {} };

  report.host = {
    openclaw: (await run("openclaw", ["--version"])).stdout.trim(),
    service: await call("service.status", {}, 30_000),
  };
  if (report.host.service.state !== "running") {
    throw new Error(`the Agent Browser service is ${report.host.service.state}`);
  }
  if (report.host.service.executionOperations !== true) {
    throw new Error("this backend reports no execution operations");
  }

  const opened = await call("packages.open-local", { path: args.package });
  const sessionId = opened.sessionId;
  try {
    // What the host thought of this signer *before* anyone decided anything.
    // A rotated signing key shows up here as `unknown`, or as `mismatch` when
    // another key is already pinned for the same claimed publisher.
    const trust = {
      statusOnOpen: opened.publisher.trustStatus,
      reasonOnOpen: opened.publisher.trustReason ?? null,
      signerFingerprint: opened.publisher.signerFingerprint,
      pinned: false,
      scope: null,
    };
    if (opened.publisher.trustStatus !== "trusted") {
      // The narrowest scope the trust store offers: this key, for this package
      // id, and nothing else in the publisher's namespace.
      const pinned = await call("trust.pin-session-publisher", {
        sessionId,
        signerFingerprint: opened.publisher.signerFingerprint,
        scope: "package",
      });
      trust.pinned = true;
      trust.scope = "package";
      trust.packageIdPrefix = pinned.pinned?.packageIdPrefix ?? null;
    }
    report.steps.trust = trust;
    const view = await call("packages.get", { sessionId });
    report.steps.package = {
      packageId: view.identity.packageId,
      version: view.identity.version,
      digest: view.identity.digest,
      archiveSha256: view.snapshot.archiveSha256,
      signatureStatus: view.publisher.signatureStatus,
      trustStatus: view.publisher.trustStatus,
      signerFingerprint: view.publisher.signerFingerprint,
      declaredTools: view.tools.length,
    };
    if (view.publisher.trustStatus !== "trusted") {
      throw new Error("the publisher key is not trusted on this host");
    }

    const permissions = await call("packages.permissions", { sessionId });
    const receipt = await call("packages.authorize", {
      sessionId,
      packageDigest: view.identity.digest,
      // Session-scoped consent for every declared permission. `once` is
      // deliberately not used: the runner refuses it for a multi-call workflow
      // rather than quietly widening it.
      decisions: permissions.permissions.map((item) => ({
        permissionId: item.id,
        decision: "session",
      })),
    });
    report.steps.authorization = {
      receiptId: receipt.receiptId,
      receiptSha256: receipt.receiptSha256,
      runnable: receipt.runnable,
      granted: receipt.grantedPermissionIds,
      decisions: permissions.permissions.map((item) => item.id),
    };

    const catalog = await call("models.evaluate", { sessionId });
    const usable = catalog.models.filter(
      (model) => model.selectableForRunPlan && model.status === "compatible",
    );
    const chosen = args.model
      ? catalog.models.find((model) => model.modelId === args.model)
      : usable[0];
    if (!chosen) {
      throw new Error(
        `no usable model${args.model ? ` matching ${args.model}` : ""}; host offers ` +
          catalog.models.map((model) => model.modelId).join(", "),
      );
    }
    report.steps.models = {
      host: catalog.host,
      catalogSha256: catalog.catalogSha256,
      offered: catalog.models.map((model) => ({ id: model.modelId, status: model.status })),
      selected: chosen.modelId,
      selectedExplicitly: Boolean(args.model),
    };

    const planState = await call("run-plan.prepare", {
      sessionId,
      packageDigest: view.identity.digest,
      receiptId: receipt.receiptId,
      modelId: chosen.modelId,
      executionMode: "model",
    });
    const plan = planState.plan;
    report.steps.runPlan = {
      runPlanId: plan.runPlanId,
      runPlanSha256: plan.runPlanSha256,
      ready: plan.readiness.ready,
      model: plan.modelBinding.hostModelId,
      compatibility: plan.modelBinding.compatibilityStatus,
      executionPerformed: plan.execution.performed,
    };
    if (!plan.readiness.ready) throw new Error("the prepared run plan is not ready");

    // --- the operation that runs the package ----------------------------
    const started = Date.now();
    const record = await call("execution.start", {
      sessionId,
      runPlanId: plan.runPlanId,
      runPlanSha256: plan.runPlanSha256,
      input,
    });
    report.steps.run = record;
    report.steps.audit = auditRun(record, chosen.modelId);
    report.steps.wallClockMs = Date.now() - started;

    if (record.status === "completed") {
      const agendaArtifact = await call("execution.artifact", {
        runId: record.runId,
        name: "agenda.json",
      });
      report.steps.agenda = agendaArtifact.json;
      report.steps.agendaChecks = checkAgenda(agendaArtifact.json, input);
      const provenance = await call("execution.artifact", {
        runId: record.runId,
        name: "provenance.json",
      });
      report.steps.provenance = provenance.json;
    }

    const after = await call("run-plan.get", { sessionId });
    report.steps.runPlanAfterExecution = {
      runPlanSha256: after.plan.runPlanSha256,
      unchanged: after.plan.runPlanSha256 === plan.runPlanSha256,
      executionPerformed: after.plan.execution.performed,
      ready: after.preflight.ready,
      pageRunAction: after.executionSupported,
    };

    const audit = report.steps.audit;
    report.passed =
      record.status === "completed" &&
      audit.everyCallUsedPlannedModel &&
      audit.invokedModels.length === 1 &&
      audit.invokedModels[0] === chosen.modelId &&
      audit.llmCalls > 1 &&
      audit.peakParallelWorkers >= 2 &&
      audit.toolCalls === 0 &&
      audit.auditChainValid &&
      audit.totalTokens > 0 &&
      report.steps.agendaChecks?.goalPreserved === true &&
      report.steps.agendaChecks?.durationPreserved === true &&
      report.steps.agendaChecks?.minutesSumMatchesDuration === true &&
      report.steps.runPlanAfterExecution.unchanged === true &&
      report.steps.runPlanAfterExecution.executionPerformed === false;
  } finally {
    if (!args.keep) await call("packages.close", { sessionId }).catch(() => undefined);
  }

  const text = `${JSON.stringify(report, null, 2)}\n`;
  if (args.out) await writeFile(args.out, text);
  process.stdout.write(text);
  if (!report.passed) process.exitCode = 1;
}

main().catch((error) => {
  process.stderr.write(`run-meeting-agenda: ${error.message}\n`);
  process.exitCode = 2;
});
