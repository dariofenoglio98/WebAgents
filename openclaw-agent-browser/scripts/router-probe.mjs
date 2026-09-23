#!/usr/bin/env node
/**
 * Live acceptance driver for the model-router bridge.
 *
 * It walks the exact sequence a person walks in the Agent Browser page — open,
 * trust, authorize, evaluate models, choose one, prepare a run plan — and then
 * invokes the one thing the page does not offer: the developer router probe.
 *
 * Every step goes through the running Gateway (`plugins.sessionAction`), so the
 * plugin backend answering is the installed one, with the real
 * `api.runtime.llm` and the operator's real model credentials. Nothing here
 * reaches a provider directly.
 *
 *   node scripts/router-probe.mjs \
 *     --package /path/to/meeting-agenda.agent.pkg \
 *     [--model openai/gpt-5.6-luna] [--out report.json] [--keep]
 *
 * With no `--model`, the first compatible, selectable model the host offers is
 * used and named in the report. This spends a few hundred real tokens on the
 * selected model, once.
 */
import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
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
  return args;
}

/** One typed feature operation, dispatched through the live Gateway. */
async function call(actionId, payload, timeoutMs = 180_000) {
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
    { maxBuffer: 32 * 1024 * 1024, env: { ...process.env, NO_COLOR: "1" } },
  );
  const envelope = JSON.parse(stdout);
  if (envelope.ok !== true) {
    throw new Error(`${actionId} failed at the Gateway: ${JSON.stringify(envelope).slice(0, 600)}`);
  }
  const result = envelope.result;
  // Feature results are themselves typed ok/error unions; service.status is not.
  if (result && typeof result === "object" && "ok" in result && result.ok === false) {
    const error = result.error ?? {};
    throw new Error(`${actionId} refused: ${error.code} — ${error.detail ?? error.title ?? ""}`);
  }
  return result && typeof result === "object" && "ok" in result ? result.value : result;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const report = { recordedAt: new Date().toISOString(), steps: {} };

  report.host = {
    openclaw: (await run("openclaw", ["--version"])).stdout.trim(),
    service: await call("service.status", {}, 30_000),
  };
  if (report.host.service.state !== "running") {
    throw new Error(`the Agent Browser service is ${report.host.service.state}`);
  }

  const opened = await call("packages.open-local", { path: args.package });
  const sessionId = opened.sessionId;
  try {
    report.steps.trustOnOpen = {
      status: opened.publisher.trustStatus,
      reason: opened.publisher.trustReason ?? null,
      signerFingerprint: opened.publisher.signerFingerprint,
    };
    if (opened.publisher.trustStatus !== "trusted") {
      // Narrowest scope: this key, for this package id only.
      await call("trust.pin-session-publisher", {
        sessionId,
        signerFingerprint: opened.publisher.signerFingerprint,
        scope: "package",
      });
    }
    const view = await call("packages.get", { sessionId });
    report.steps.package = {
      packageId: view.identity.packageId,
      version: view.identity.version,
      digest: view.identity.digest,
      archiveSha256: view.snapshot.archiveSha256,
      signatureStatus: view.publisher.signatureStatus,
      trustStatus: view.publisher.trustStatus,
      signerFingerprint: view.publisher.signerFingerprint,
    };
    if (view.publisher.trustStatus !== "trusted") {
      throw new Error("the publisher key is not trusted on this host");
    }

    const permissions = await call("packages.permissions", { sessionId });
    const receipt = await call("packages.authorize", {
      sessionId,
      packageDigest: view.identity.digest,
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
      counts: catalog.counts,
      offered: catalog.models.map((model) => ({
        id: model.modelId,
        status: model.status,
        evidence: model.evidenceStrength,
        contextTokens: model.contextTokens,
      })),
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
      evidence: plan.modelBinding.evidenceStrength,
      executionPerformed: plan.execution.performed,
    };
    if (!plan.readiness.ready) throw new Error("the prepared run plan is not ready");

    // --- the one operation that spends tokens ---------------------------
    report.steps.probe = await call("router.probe", {
      sessionId,
      runPlanId: plan.runPlanId,
      runPlanSha256: plan.runPlanSha256,
    });

    const after = await call("run-plan.get", { sessionId });
    report.steps.runPlanAfterProbe = {
      runPlanSha256: after.plan.runPlanSha256,
      unchanged: after.plan.runPlanSha256 === plan.runPlanSha256,
      executionPerformed: after.plan.execution.performed,
      ready: after.preflight.ready,
      executionSupported: after.executionSupported,
    };
    report.passed =
      report.steps.probe.status === "ok" &&
      report.steps.probe.model.invoked === chosen.modelId &&
      report.steps.probe.workflowExecuted === false &&
      report.steps.runPlanAfterProbe.unchanged === true;
  } finally {
    if (!args.keep) await call("packages.close", { sessionId }).catch(() => undefined);
  }

  const text = `${JSON.stringify(report, null, 2)}\n`;
  if (args.out) await writeFile(args.out, text);
  process.stdout.write(text);
  if (!report.passed) process.exitCode = 1;
}

main().catch((error) => {
  process.stderr.write(`router-probe: ${error.message}\n`);
  process.exitCode = 2;
});
