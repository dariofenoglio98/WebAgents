#!/usr/bin/env node
/**
 * Live acceptance driver for a real Literature Review run.
 *
 * It walks the sequence a person walks in the Agent Browser page — open, record
 * what the host thought of the signer, pin that exact key at `package` scope if
 * it is not already trusted, set each permission, approve each tool, read what
 * this host implements, choose one model this host actually offers, prepare a
 * run plan — then starts the run **detached**, follows its live progress, and
 * reads what it produced through the same execution operations used by the UI.
 * Optional local file selection is performed through the host capability API.
 *
 * Every step goes through the running Gateway (`plugins.sessionAction`), so the
 * backend answering is the installed plugin with the real tool registry, the
 * real broker and the real `api.runtime.llm`. Nothing here reaches a model or a
 * service directly, renders a prompt or builds a request: the graph, the skills
 * and the schemas come from the signed package, the model from the run plan, and
 * every tool request from the host's own bindings.
 *
 *   node scripts/run-literature-review.mjs \
 *     --package /abs/path/dist/literature-review.agent.pkg \
 *     --input   /abs/path/examples/literature-review-live-input.json \
 *     --model   ollama/qwen3.5:9b \
 *     --out     /abs/path/examples/verification/literature-review-live-run.json \
 *     [--copy-artifacts /abs/path/examples/literature-review-live] \
 *     [--document 10.x/y=/abs/path/inside/localFiles/paper.pdf ...] \
 *     [--grants /abs/path/grants.json] [--keep]
 *
 *   node scripts/run-literature-review.mjs --attach RUN_ID --input … --model … --out …
 *     follows a run that is already executing (for example after this driver
 *     lost its connection), then applies the same checks. What only the original
 *     session could show — the run plan re-read afterwards — is reported as
 *     not observed rather than assumed.
 *
 * The package-specific part is the set of *checks* at the end — grounding,
 * bibliography provenance, quote containment — which re-derive the package's
 * own invariants from the run's artifacts. Nothing package-specific runs inside
 * the host.
 *
 * This spends real tokens on the selected model, once.
 */
import { execFile } from "node:child_process";
import { copyFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";

const run = promisify(execFile);
const PLUGIN_ID = "agent-browser";
const TERMINAL = new Set(["completed", "failed", "cancelled"]);
const EXPORTS = [
  "related-work.md",
  "bibliography.json",
  "evidence-table.json",
  "unresolved.json",
  "verification.json",
];
const HOST_FILES = ["result.json", "audit.json", "usage.json", "provenance.json", "run.json"];

function parseArgs(argv) {
  const args = { keep: false, document: [], poll: 15 };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--keep") args.keep = true;
    else if (flag === "--document") args.document.push(argv[++index]);
    else if (flag.startsWith("--")) args[flag.slice(2)] = argv[++index];
  }
  for (const required of [...(args.attach || args.reevaluate ? [] : ["package"]), "input", "model", "out"]) {
    if (!args[required]) throw new Error(`--${required} is required`);
  }
  args.poll = Number(args.poll) || 15;
  return args;
}

/** One typed feature operation, dispatched through the live Gateway. */
async function call(actionId, payload, timeoutMs = 300_000) {
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
  if (result && typeof result === "object" && "ok" in result && result.ok === false) {
    const error = result.error ?? {};
    throw new Error(`${actionId} refused: ${error.code} — ${error.detail ?? error.title ?? ""}`);
  }
  return result && typeof result === "object" && "ok" in result ? result.value : result;
}

function log(line) {
  process.stderr.write(`[${new Date().toISOString().slice(11, 19)}] ${line}\n`);
}

function progressLine(record) {
  const p = record.progress;
  if (!p) return `${record.status} — no progress yet`;
  return (
    `${record.status} ${Math.round(p.elapsedMs / 1000)}s · active [${p.activeNodes.join(", ")}] · ` +
    `nodes ${p.nodesCompleted} steps ${p.stepsCompleted} · workers ${p.workersActive}/${p.workersSpawned} ` +
    `(peak ${p.peakParallelWorkers}) · model ${p.modelCallsCompleted}/${p.modelCallsStarted} · ` +
    `tools ${p.toolCallsCompleted}/${p.toolCallsStarted} · tokens ${p.tokens}`
  );
}

// -- independent checks over the run's own artifacts ------------------------
/** JSON objects are unordered: compare values, not the order keys were written in. */
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function contains(text, quote) {
  return typeof text === "string" && typeof quote === "string" && quote.trim() !== "" && text.includes(quote);
}

function groundingChecks({ output, state }) {
  const resolvedJobs = state.resolved_jobs ?? [];
  const searchPapers = (state.search_batches ?? []).flatMap((batch) => batch.papers ?? []);
  const byPaper = new Map(resolvedJobs.map((job) => [job.paper?.paper_id, job]));
  // The genuine texts each paper's evidence may quote: what the Citation
  // Resolver returned for it, and what Crossref search returned for the same
  // DOI — both tool outputs, neither written by a model.
  const genuineTexts = (paperId) => {
    const job = byPaper.get(paperId);
    const texts = [];
    if (job?.response?.best_match?.abstract) texts.push(job.response.best_match.abstract);
    const doi = job?.paper?.doi ?? null;
    for (const paper of searchPapers) {
      if (doi && paper.doi === doi && paper.abstract) texts.push(paper.abstract);
    }
    return texts;
  };
  const evidence = state.evidence_items ?? [];
  const evidenceById = new Map(evidence.map((item) => [item.evidence_id, item]));
  const quoteResults = evidence.map((item) => ({
    evidence_id: item.evidence_id,
    paper_id: item.paper_id,
    scope: item.scope,
    quote_in_genuine_source: genuineTexts(item.paper_id).some((text) => contains(text, item.quote)),
    synthetic: item.provenance?.synthetic === true,
  }));
  const bibliography = (output.bibliography ?? []).map((entry) => {
    const job = byPaper.get(entry.paper_id);
    return {
      paper_id: entry.paper_id,
      resolved: job?.response?.status === "resolved",
      metadata_equals_resolver_record:
        canonical(entry.metadata) === canonical(job?.response?.best_match ?? null),
      title: entry.metadata?.title ?? null,
      doi: entry.metadata?.doi ?? null,
    };
  });
  const claims = output.claims ?? [];
  const results = output.verification_results ?? [];
  const claimIds = new Set(claims.map((claim) => claim.claim_id));
  const text = output.related_work ?? "";
  const mentionedPaperIds = [...new Set(text.match(/paper-[0-9a-f]{8,}/gu) ?? [])];
  const bibIds = new Set(bibliography.map((entry) => entry.paper_id));
  return {
    evidence_items: evidence.length,
    evidence_quotes_in_genuine_sources: quoteResults.filter((item) => item.quote_in_genuine_source).length,
    evidence_quote_results: quoteResults,
    evidence_table_rows: (output.evidence_table ?? []).length,
    evidence_table_rows_match_items: (output.evidence_table ?? []).every(
      (row) => canonical(row) === canonical(evidenceById.get(row.evidence_id)),
    ),
    bibliography,
    bibliography_all_resolved_and_exact: bibliography.every(
      (entry) => entry.resolved && entry.metadata_equals_resolver_record,
    ),
    claims: claims.length,
    claim_statuses: claims.map((claim) => ({
      claim_id: claim.claim_id,
      verification_status: claim.verification_status,
      support_type: claim.support_type,
      evidence_ids: claim.evidence_ids,
      paper_ids: claim.paper_ids,
    })),
    claims_reference_existing_evidence: claims.every((claim) =>
      claim.evidence_ids.every((id) => evidenceById.has(id)),
    ),
    // Not vacuously: a claim with no evidence or no paper is ungrounded.
    claims_cite_evidence_and_papers: claims.every(
      (claim) => claim.evidence_ids.length > 0 && claim.paper_ids.length > 0,
    ),
    claims_reference_resolved_papers: claims.every((claim) =>
      claim.paper_ids.every((id) => byPaper.get(id)?.response?.status === "resolved"),
    ),
    verification_results: results.length,
    verification_results_match_claims: results.every((result) => claimIds.has(result.claim_id)),
    unsupported_or_overstated: results.filter((result) => result.status !== "supported").length,
    related_work_chars: text.length,
    related_work_paper_ids_mentioned: mentionedPaperIds,
    related_work_mentions_only_bibliography: mentionedPaperIds.every((id) => bibIds.has(id)),
    unresolved: (output.unresolved ?? []).length,
  };
}

function searchSummary(state) {
  return {
    queries: state.search_queries ?? [],
    batches: (state.search_batches ?? []).map((batch) => ({
      query: batch.query,
      source: batch.source,
      papers: (batch.papers ?? []).length,
      with_abstract: (batch.papers ?? []).filter((paper) => paper.abstract).length,
    })),
    raw_candidates: (state.raw_candidates ?? []).length,
    candidate_papers: (state.candidate_papers ?? []).length,
    screened: (state.screened_papers ?? []).map((paper) => ({
      paper_id: paper.paper_id,
      status: paper.screening_status,
      doi: paper.doi,
      title: paper.title,
      has_abstract: Boolean(paper.abstract),
      rationale: String(paper.screening_rationale ?? "").slice(0, 400),
    })),
    citation_jobs: (state.citation_jobs ?? []).length,
    resolver_statuses: (state.resolved_jobs ?? []).map((job) => ({
      paper_id: job.paper?.paper_id,
      query_doi: job.paper?.doi ?? null,
      status: job.response?.status,
      source: job.response?.best_match?.source ?? null,
    })),
  };
}

/** Poll one run to a terminal status, riding out transient Gateway failures. */
async function follow(runId, first, args) {
  const snapshots = [];
  let record = first;
  let lastLine = "";
  let failures = 0;
  while (!TERMINAL.has(record.status)) {
    await sleep(args.poll * 1000);
    let next;
    try {
      next = await call("execution.get", { runId }, 60_000);
      failures = 0;
    } catch (error) {
      // The run is detached and keeps going; one failed poll says nothing
      // about it. Only a Gateway that stays unreachable ends the watch.
      failures += 1;
      log(`poll failed (${failures}): ${String(error.message).slice(0, 160)}`);
      if (failures >= 20) throw error;
      continue;
    }
    if (!next) throw new Error("the run record disappeared");
    record = next;
    const line = progressLine(record);
    if (line !== lastLine) {
      log(line);
      lastLine = line;
    }
    if (record.progress && snapshots.length < 2000) {
      snapshots.push({ at: new Date().toISOString(), ...record.progress });
    }
  }
  return { record, snapshots };
}

/** Everything after the run: artifacts, independent checks, acceptance criteria. */
async function evaluate({ record, snapshots, report, args, fileIds, plan, sessionId, reuse = false }) {
  report.steps.run = record;
  // Re-evaluation keeps what was observed while the run was live.
  if (!reuse) {
    report.steps.progress = {
      snapshots: snapshots.length,
      first: snapshots[0] ?? null,
      last: snapshots.at(-1) ?? null,
      maxWorkersActive: Math.max(0, ...snapshots.map((item) => item.workersActive)),
      nodeTimeline: snapshots
        .map((item) => ({ at: item.at, completed: item.completedNodes.length, active: item.activeNodes }))
        .filter((item, index, all) => index === 0 || item.completed !== all[index - 1].completed),
    };
  }
  log(`run ${record.runId} ${record.status}${record.errorCode ? ` (${record.errorCode})` : ""}`);

  // --- what it produced ---------------------------------------------------
  const runsDir = args["runs-dir"] ?? join(homedir(), ".openclaw", "agent-browser", "runs");
  const runDir = join(runsDir, record.runId);
  const written = await readdir(runDir).catch(() => []);
  report.steps.artifacts = {
    listed: record.artifacts,
    written,
    exportsPresent: EXPORTS.filter((name) => written.includes(name)),
    hostFilesPresent: HOST_FILES.filter((name) => written.includes(name)),
  };
  // The API returns one bounded artifact at a time and never a path; the
  // grounding checks need the complete result, which this operator tool
  // reads from the operator's own OpenClaw state directory.
  const result = written.includes("result.json")
    ? JSON.parse(await readFile(join(runDir, "result.json"), "utf8"))
    : null;
  if (args["copy-artifacts"] && written.length > 0) {
    await mkdir(args["copy-artifacts"], { recursive: true });
    for (const name of written) await copyFile(join(runDir, name), join(args["copy-artifacts"], name));
    report.steps.artifacts.copiedTo = args["copy-artifacts"];
  }
  const relatedWork = await call("execution.artifact", { runId: record.runId, name: "related-work.md" }).catch(
    () => null,
  );
  report.steps.relatedWorkViaApi = relatedWork
    ? { bytes: relatedWork.bytes, sha256: relatedWork.sha256, truncated: relatedWork.truncated }
    : null;
  if (result) {
    report.steps.search = searchSummary(result.state ?? {});
    if (result.status === "completed") {
      report.steps.grounding = groundingChecks({ output: result.output, state: result.state });
    }
    report.steps.resultStatus = result.status;
    report.steps.resultErrorCode = result.error_code ?? null;
  }

  const after = reuse
    ? null
    : sessionId
      ? await call("run-plan.get", { sessionId }).catch(() => null)
      : null;
  if (!reuse) report.steps.runPlanAfterExecution = after
    ? {
        runPlanSha256: after.plan.runPlanSha256,
        unchanged: after.plan.runPlanSha256 === plan.runPlanSha256,
        executionPerformed: after.plan.execution.performed,
        toolBindingsCurrent: after.preflight?.toolBindingsCurrent ?? null,
        pageRunAction: after.executionSupported,
      }
    : { observed: false, reason: "the session that holds this run plan is no longer open" };

  // --- the acceptance criteria -------------------------------------------
  const audit = record.audit ?? {};
  const toolCalls = Object.fromEntries((record.tools ?? []).map((tool) => [tool.toolId, tool.calls]));
  const grounding = report.steps.grounding ?? {};
  const serialized = JSON.stringify({ result: result?.output ?? null, record });
  const criteria = {
    completed: record.status === "completed",
    profileWorkflowV0: report.steps.package.executionProfile === "workflow.v0",
    packageIsLiteratureReview: report.steps.package.packageId === "org.webagents.literature-review",
    signatureValid: report.steps.package.signatureStatus === "valid",
    signerTrusted: report.steps.package.trustStatus === "trusted",
    runnerReverifiedPackage: (record.revalidated ?? []).some((item) => item.startsWith("runner:")),
    oneExplicitModelEveryCall:
      record.model?.allCallsUsedPlannedModel === true &&
      (record.model?.invoked ?? []).length === 1 &&
      record.model.invoked[0] === args.model,
    zeroCostLocal: record.cost?.totalUsd === null || record.cost?.totalUsd === 0,
    scholarlySearchCalled: (toolCalls["scholarly-search"] ?? 0) > 0,
    citationResolverCalled: (toolCalls["citation-resolver"] ?? 0) > 0,
    paperReaderUseMatchesDocuments:
      fileIds.length === 0 ? (toolCalls["paper-reader"] ?? 0) === 0 : (toolCalls["paper-reader"] ?? 0) > 0,
    peakParallelAtLeastTwo: (record.usage?.peakParallelWorkers ?? 0) >= 2,
    auditChainValid: audit.chainValid === true,
    allExportsWritten: report.steps.artifacts.exportsPresent.length === EXPORTS.length,
    allHostFilesWritten: report.steps.artifacts.hostFilesPresent.length === HOST_FILES.length,
    relatedWorkNonEmpty: (grounding.related_work_chars ?? 0) > 0,
    bibliographyFromResolvedRecords:
      grounding.bibliography_all_resolved_and_exact === true && (grounding.bibliography?.length ?? 0) > 0,
    evidenceQuotesInGenuineSources:
      (grounding.evidence_items ?? 0) > 0 &&
      grounding.evidence_quotes_in_genuine_sources === grounding.evidence_items,
    evidenceTableMatchesItems: grounding.evidence_table_rows_match_items === true,
    claimsReferenceExistingEvidence: grounding.claims_reference_existing_evidence === true,
    claimsCiteEvidenceAndPapers: grounding.claims_cite_evidence_and_papers === true,
    claimsReferenceResolvedPapers: grounding.claims_reference_resolved_papers === true,
    verificationMatchesClaims: grounding.verification_results_match_claims === true,
    relatedWorkCitesOnlyBibliography: grounding.related_work_mentions_only_bibliography !== false,
    noSyntheticContent:
      !/SYNTHETIC/iu.test(result?.output?.related_work ?? "") &&
      (grounding.evidence_quote_results ?? []).every((item) => item.synthetic === false),
    noCredentialShapedText: !/bearer |authorization:|api[_-]?key|password/iu.test(serialized),
    // `null` when the session that holds the plan is gone: not observed, not assumed.
    runPlanUnchanged:
      report.steps.runPlanAfterExecution.observed === false
        ? null
        : report.steps.runPlanAfterExecution.unchanged === true &&
          report.steps.runPlanAfterExecution.executionPerformed === false,
    progressObserved: (reuse ? report.steps.progress?.snapshots ?? 0 : snapshots.length) > 0,
  };
  report.criteria = criteria;
  report.notObserved = Object.entries(criteria)
    .filter(([, value]) => value === null)
    .map(([name]) => name);
  report.passed = Object.values(criteria).every((value) => value === null || value === true);
}

/** Follow a run that is already executing, then apply the same checks. */
async function attach(args, input, report) {
  const first = await call("execution.get", { runId: args.attach }, 60_000);
  if (!first) throw new Error(`no run ${args.attach} on this host`);
  report.steps.attached = { runId: first.runId, statusWhenAttached: first.status };
  report.steps.started = { runId: first.runId, runInvocationSha256: first.runInvocationSha256, task: first.task };
  const { record, snapshots } = await follow(first.runId, first, args);
  // Signature and trust as the run itself established them: the runner
  // re-verified the signature (its facts arrive with the finished record), and
  // the preflight re-checked that trust was what the plan — which required a
  // trusted signer — had recorded.
  const revalidated = record.revalidated ?? [];
  report.steps.package = {
    ...record.package,
    signatureStatus: revalidated.includes("runner:publisher_signature") ? "valid" : "not_observed",
    trustStatus: revalidated.includes("publisher_trust") ? "trusted" : "not_observed",
  };
  const fileIds = (record.task?.attachments ?? []).map((item) => item.fileId);
  const plan = { runPlanId: record.runPlanId, runPlanSha256: record.runPlanSha256 };
  await evaluate({ record, snapshots, report, args, fileIds, plan, sessionId: record.sessionId });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const input = JSON.parse(await readFile(args.input, "utf8"));
  const grants = args.grants ? JSON.parse(await readFile(args.grants, "utf8")) : null;
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
  if (args.reevaluate) {
    // Re-score a finished run from its preserved artifacts with the current
    // independent checks; everything observed at run time is kept as recorded.
    const previous = JSON.parse(await readFile(args.reevaluate, "utf8"));
    const record = previous.steps.run;
    Object.assign(report, previous, { input, host: report.host });
    report.reevaluated = {
      at: new Date().toISOString(),
      from: args.reevaluate,
      reason: args.reason ?? "independent checks changed after the run",
    };
    const fileIds = (record.task?.attachments ?? []).map((item) => item.fileId);
    const plan = { runPlanId: record.runPlanId, runPlanSha256: record.runPlanSha256 };
    await evaluate({ record, snapshots: [], report, args, fileIds, plan, sessionId: null, reuse: true });
    await writeFile(args.out, `${JSON.stringify(report, null, 2)}\n`);
    process.stdout.write(`${JSON.stringify({ passed: report.passed, criteria: report.criteria }, null, 2)}\n`);
    if (!report.passed) process.exitCode = 1;
    return;
  }
  if (args.attach) {
    await attach(args, input, report);
    await writeFile(args.out, `${JSON.stringify(report, null, 2)}\n`);
    process.stdout.write(`${JSON.stringify({ passed: report.passed, criteria: report.criteria }, null, 2)}\n`);
    if (!report.passed) process.exitCode = 1;
    return;
  }

  const opened = await call("packages.open-local", { path: args.package });
  const sessionId = opened.sessionId;
  try {
    const trust = {
      statusOnOpen: opened.publisher.trustStatus,
      reasonOnOpen: opened.publisher.trustReason ?? null,
      signerFingerprint: opened.publisher.signerFingerprint,
      pinned: false,
      scope: null,
    };
    if (opened.publisher.trustStatus !== "trusted") {
      // The narrowest scope the store offers: this key, for this package id.
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
      entrypoint: view.identity.entrypoint,
      executionProfile: view.identity.executionProfile,
      validation: view.validation,
      signatureStatus: view.publisher.signatureStatus,
      trustStatus: view.publisher.trustStatus,
      signerFingerprint: view.publisher.signerFingerprint,
      declaredTools: view.tools.map((tool) => ({
        id: tool.id,
        binding: tool.binding,
        execution: tool.execution,
        permissions: tool.permissions,
      })),
    };
    if (view.publisher.trustStatus !== "trusted") throw new Error("the publisher key is not trusted");

    // Files first, so the permission for reading them follows from them.
    const documents = {};
    const fileIds = [];
    report.steps.files = [];
    for (const entry of args.document) {
      const at = entry.indexOf("=");
      const key = entry.slice(0, at);
      const path = entry.slice(at + 1);
      const selected = await call("files.select-local", { sessionId, path });
      documents[key] = selected.fileId;
      fileIds.push(selected.fileId);
      report.steps.files.push({
        key,
        fileId: selected.fileId,
        sha256: selected.sha256,
        bytes: selected.bytes,
        pathReturned: JSON.stringify(selected).includes(path),
      });
    }
    if (args.document.length > 0) input.documents = documents;

    // Permissions and tool approvals: two separate decisions, both explicit.
    const permissions = await call("packages.permissions", { sessionId });
    const decisionFor = (item) => {
      if (grants && grants[item.id]) return grants[item.id];
      if (item.kind === "files.read") return fileIds.length > 0 ? "session" : "deny";
      return "session";
    };
    const decisions = permissions.permissions.map((item) => ({
      permissionId: item.id,
      decision: decisionFor(item),
    }));
    const receipt = await call("packages.authorize", {
      sessionId,
      packageDigest: view.identity.digest,
      decisions,
      toolApprovals: permissions.toolApprovals.map((item) => ({ toolId: item.toolId, approved: true })),
    });
    report.steps.authorization = {
      receiptId: receipt.receiptId,
      receiptSha256: receipt.receiptSha256,
      runnable: receipt.runnable,
      decisions,
      grantedPermissionIds: receipt.grantedPermissionIds,
      toolApprovals: receipt.toolApprovals,
      expiresAt: receipt.expiresAt,
    };

    const tools = await call("tools.evaluate", { sessionId });
    report.steps.tools = {
      registrySha256: tools.registrySha256,
      counts: tools.counts,
      allToolsBound: tools.allToolsBound,
      declared: tools.tools.map((tool) => ({
        toolId: tool.toolId,
        status: tool.status,
        approved: tool.approved,
        usable: tool.usable,
        deniedPermissionIds: tool.deniedPermissionIds,
        blocksPlan: tool.blocksPlan,
        binding: tool.binding && {
          bindingId: tool.binding.bindingId,
          bindingSha256: tool.binding.bindingSha256,
          implementationKind: tool.binding.implementationKind,
          implementationVersion: tool.binding.implementationVersion,
          endpointOrigin: tool.binding.endpointOrigin,
          endpointPath: tool.binding.endpointPath,
          method: tool.binding.method,
          checks: tool.binding.checks.map((check) => `${check.id}:${check.status}`),
        },
      })),
    };

    const catalog = await call("models.evaluate", { sessionId });
    const chosen = catalog.models.find((model) => model.modelId === args.model);
    report.steps.models = {
      catalogSha256: catalog.catalogSha256,
      offered: catalog.models
        .filter((model) => model.local)
        .map((model) => ({
          id: model.modelId,
          status: model.status,
          available: model.available,
          contextTokens: model.contextTokens,
        })),
      selected: args.model,
      selectedStatus: chosen?.status ?? null,
      selectedContextTokens: chosen?.contextTokens ?? null,
    };
    // No fallback: the named model or nothing.
    if (!chosen) throw new Error(`this host does not offer ${args.model}`);
    if (!chosen.selectableForRunPlan || chosen.status !== "compatible") {
      throw new Error(`${args.model} is ${chosen.status} and not selectable for a run plan`);
    }

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
      blockingReasons: plan.readiness.blockingReasons,
      mode: plan.execution.mode,
      model: plan.modelBinding?.hostModelId ?? null,
      modelContextTokens: plan.modelBinding?.contextTokens ?? null,
      compatibility: plan.modelBinding?.compatibilityStatus ?? null,
      toolBindings: plan.toolBindings,
      toolRegistry: plan.toolRegistry,
      executionPerformed: plan.execution.performed,
    };
    if (!plan.readiness.ready) throw new Error("the prepared run plan is not ready");

    // --- the operation that runs the package ------------------------------
    const started = Date.now();
    const initial = await call("execution.start", {
      sessionId,
      runPlanId: plan.runPlanId,
      runPlanSha256: plan.runPlanSha256,
      input,
      ...(fileIds.length > 0 ? { files: fileIds } : {}),
      detach: true,
    });
    report.steps.started = {
      runId: initial.runId,
      status: initial.status,
      runInvocationSha256: initial.runInvocationSha256,
      task: initial.task,
    };
    log(`run ${initial.runId} ${initial.status}`);

    const { record, snapshots } = await follow(initial.runId, initial, args);
    report.steps.wallClockMs = Date.now() - started;
    await evaluate({ record, snapshots, report, args, fileIds, plan, sessionId });
  } finally {
    if (!args.keep) await call("packages.close", { sessionId }).catch(() => undefined);
  }

  const text = `${JSON.stringify(report, null, 2)}\n`;
  await writeFile(args.out, text);
  process.stdout.write(`${JSON.stringify({ passed: report.passed, criteria: report.criteria }, null, 2)}\n`);
  if (!report.passed) process.exitCode = 1;
}

main().catch((error) => {
  process.stderr.write(`run-literature-review: ${error.message}\n`);
  process.exitCode = 2;
});
