#!/usr/bin/env node
/**
 * Live acceptance driver for the host tool broker.
 *
 * It walks the exact sequence a person walks in the Agent Browser page — open,
 * trust, authorize permissions *and* each tool, read what this host implements,
 * choose a model, prepare a run plan — and then invokes the one thing the page
 * does not offer: the developer tool probe.
 *
 * Every step goes through the running Gateway (`plugins.sessionAction`), so the
 * plugin backend answering is the installed one, with the real host tool
 * registry and the real transport. Nothing here reaches a service directly, and
 * nothing here chooses a destination: the probe takes a declared tool id and one
 * of the host's own fixture ids, and the host builds the request.
 *
 *   node scripts/tool-probe.mjs \
 *     --package /path/to/literature-review.agent.pkg \
 *     --tool citation-resolver [--fixture doi] \
 *     [--file /absolute/path/inside/localFiles/roots/paper.pdf --role ScreeningWorker] \
 *     [--out report.json] [--keep]
 *
 * For a file-reading tool, `--file` is selected through `files.select-local`
 * first — the host copies it and answers with an opaque id — and the probe then
 * names only that id. `--role` names the declared role to attribute the call to
 * when more than one role declares the tool.
 *
 * This makes ONE real call to whatever the bound implementation is. It spends
 * no tokens and runs no workflow.
 */
import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { promisify } from "node:util";

const run = promisify(execFile);
const PLUGIN_ID = "agent-browser";

function parseArgs(argv) {
  const args = { keep: false, tool: "citation-resolver" };
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
  if (result && typeof result === "object" && "ok" in result && result.ok === false) {
    const error = result.error ?? {};
    throw new Error(`${actionId} refused: ${error.code} — ${error.detail ?? error.title ?? ""}`);
  }
  return result && typeof result === "object" && "ok" in result ? result.value : result;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const report = { recordedAt: new Date().toISOString(), tool: args.tool, steps: {} };

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
    if (opened.publisher.trustStatus !== "trusted") {
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
      declaredTools: view.tools.map((tool) => ({
        id: tool.id,
        binding: tool.binding,
        execution: tool.execution,
        permissions: tool.permissions,
        domains: tool.domains,
      })),
    };
    if (view.publisher.trustStatus !== "trusted") {
      throw new Error("the publisher key is not trusted on this host");
    }

    // Permissions and tool approvals are two separate decisions, and this
    // makes both explicitly.
    const permissions = await call("packages.permissions", { sessionId });
    const receipt = await call("packages.authorize", {
      sessionId,
      packageDigest: view.identity.digest,
      decisions: permissions.permissions.map((item) => ({
        permissionId: item.id,
        decision: "session",
      })),
      toolApprovals: permissions.toolApprovals.map((item) => ({
        toolId: item.toolId,
        approved: true,
      })),
    });
    report.steps.authorization = {
      receiptId: receipt.receiptId,
      receiptSha256: receipt.receiptSha256,
      runnable: receipt.runnable,
      grantedPermissionIds: receipt.grantedPermissionIds,
      toolApprovals: receipt.toolApprovals,
    };

    const tools = await call("tools.evaluate", { sessionId });
    report.steps.tools = {
      host: tools.host,
      registrySha256: tools.registrySha256,
      counts: tools.counts,
      allToolsBound: tools.allToolsBound,
      declared: tools.tools.map((tool) => ({
        toolId: tool.toolId,
        status: tool.status,
        approved: tool.approved,
        permissionsGranted: tool.permissionsGranted,
        usable: tool.usable,
        reason: tool.reason,
        binding: tool.binding && {
          bindingId: tool.binding.bindingId,
          bindingSha256: tool.binding.bindingSha256,
          implementationKind: tool.binding.implementationKind,
          implementationVersion: tool.binding.implementationVersion,
          endpointOrigin: tool.binding.endpointOrigin,
          endpointPath: tool.binding.endpointPath,
          method: tool.binding.method,
          available: tool.binding.available,
          credentialsRequired: tool.binding.credentialsRequired,
          credentialsConfigured: tool.binding.credentialsConfigured,
          checks: tool.binding.checks,
        },
      })),
    };
    const target = tools.tools.find((tool) => tool.toolId === args.tool);
    if (!target) throw new Error(`this package declares no tool ${args.tool}`);
    if (target.status !== "bound") {
      throw new Error(`${args.tool} is ${target.status} on this host: ${target.reason ?? ""}`);
    }

    // A model-backed plan is authority to run the whole package, and needs
    // every declared tool bound. Recording whether it is refused, and why, is
    // part of the evidence: a probe must not look like a run.
    const catalog = await call("models.evaluate", { sessionId });
    const usable = catalog.models.filter(
      (model) => model.selectableForRunPlan && model.status === "compatible",
    );
    const chosen = args.model
      ? catalog.models.find((model) => model.modelId === args.model)
      : usable[0];
    report.steps.model = chosen
      ? { selected: chosen.modelId, status: chosen.status }
      : { selected: null, offered: catalog.models.map((model) => model.modelId) };
    if (chosen) {
      try {
        await call("run-plan.prepare", {
          sessionId,
          packageDigest: view.identity.digest,
          receiptId: receipt.receiptId,
          modelId: chosen.modelId,
          executionMode: "model",
        });
        report.steps.modelPlan = { prepared: true, model: chosen.modelId };
      } catch (error) {
        report.steps.modelPlan = {
          prepared: false,
          model: chosen.modelId,
          refusedBecause: error.message,
        };
      }
    } else {
      report.steps.modelPlan = {
        prepared: false,
        refusedBecause: "this host offers no compatible model, so a run plan was not attempted",
      };
    }

    // A tool probe plan is a strictly smaller authority: one mediated call to
    // one declared tool, binding no model at all.
    const planState = await call("run-plan.prepare", {
      sessionId,
      packageDigest: view.identity.digest,
      receiptId: receipt.receiptId,
      executionMode: "tool_probe",
      probeToolId: args.tool,
    });
    const plan = planState.plan;
    report.steps.runPlan = {
      runPlanId: plan.runPlanId,
      runPlanSha256: plan.runPlanSha256,
      ready: plan.readiness.ready,
      executionPerformed: plan.execution.performed,
      mode: plan.execution.mode,
      probeToolId: plan.execution.probeToolId,
      modelBinding: plan.modelBinding,
      toolBindings: plan.toolBindings,
      toolRegistry: plan.toolRegistry,
      preflight: planState.preflight,
    };
    if (!plan.readiness.ready) throw new Error("the prepared run plan is not ready");

    // --- a file-reading tool reads one file the operator selected --------
    let fileId = null;
    if (args.file) {
      const selected = await call("files.select-local", { sessionId, path: args.file });
      fileId = selected.fileId;
      report.steps.selectedFile = {
        fileId: selected.fileId,
        sha256: selected.sha256,
        bytes: selected.bytes,
        mediaType: selected.mediaType,
        displayName: selected.displayName,
        // Recorded so a reader can check the host never returned the path.
        pathReturned: JSON.stringify(selected).includes(args.file),
      };
    }

    // --- the one operation that calls a tool -----------------------------
    report.steps.probe = await call("execution.tool-probe", {
      sessionId,
      runPlanId: plan.runPlanId,
      runPlanSha256: plan.runPlanSha256,
      toolId: args.tool,
      ...(args.fixture ? { fixtureId: args.fixture } : {}),
      ...(fileId ? { fileId } : {}),
      ...(args.role ? { role: args.role } : {}),
    });

    const after = await call("run-plan.get", { sessionId });
    report.steps.runPlanAfterProbe = {
      runPlanSha256: after.plan.runPlanSha256,
      unchanged: after.plan.runPlanSha256 === plan.runPlanSha256,
      executionPerformed: after.plan.execution.performed,
      ready: after.preflight.ready,
      toolBindingsCurrent: after.preflight.toolBindingsCurrent,
      executionSupported: after.executionSupported,
    };

    const probe = report.steps.probe;
    const planned = plan.toolBindings.find((item) => item.toolId === args.tool);
    const probeText = JSON.stringify(probe);
    report.steps.pathLeak = args.file
      ? {
          inProbeReport: probeText.includes(args.file),
          inSelection: report.steps.selectedFile.pathReturned,
        }
      : null;
    if (args.file && fileId) {
      const output = probe.result.output ?? {};
      report.steps.fileChecks = {
        outputSha256MatchesSelection: output.sha256 === report.steps.selectedFile.sha256,
        pages: Array.isArray(output.pages) ? output.pages.length : 0,
        source: output.source,
        fixtureFileId: probe.fixture.fileId,
      };
    }
    report.passed =
      probe.status === "ok" &&
      probe.tool.id === args.tool &&
      probe.binding.bindingId === planned.bindingId &&
      probe.binding.bindingSha256 === planned.bindingSha256 &&
      probe.usage.toolCalls === 1 &&
      probe.usage.remoteCalls === (planned.remote ? 1 : 0) &&
      probe.usage.tokens === 0 &&
      plan.modelBinding === null &&
      plan.execution.mode === "tool_probe" &&
      probe.packageExecution.modelRouterInstalled === false &&
      probe.packageExecution.workflowInstantiated === false &&
      probe.packageExecution.modelCalls === 0 &&
      probe.packageExecution.workflowWorkersStarted === 0 &&
      probe.result.validatedByRuntime === true &&
      probe.audit.chainValid === true &&
      report.steps.runPlanAfterProbe.unchanged === true &&
      (!args.file ||
        (report.steps.pathLeak.inProbeReport === false &&
          report.steps.pathLeak.inSelection === false &&
          report.steps.fileChecks.outputSha256MatchesSelection === true &&
          report.steps.fileChecks.pages > 0 &&
          report.steps.fileChecks.fixtureFileId === fileId));
  } finally {
    if (!args.keep) await call("packages.close", { sessionId }).catch(() => undefined);
  }

  const text = `${JSON.stringify(report, null, 2)}\n`;
  if (args.out) await writeFile(args.out, text);
  process.stdout.write(text);
  if (!report.passed) process.exitCode = 1;
}

main().catch((error) => {
  process.stderr.write(`tool-probe: ${error.message}\n`);
  process.exitCode = 2;
});
