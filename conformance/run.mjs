#!/usr/bin/env node
// The cross-runtime conformance suite (T7, D-091): the Python runtime (agentpkg) and the Chrome
// core (chrome-agent-browser) run the same signed packages on the same inputs, and this runner
// compares what they did and what they refused. See conformance/README.md for what is compared,
// how it is normalized, and what the suite does not prove.
//
//   node conformance/run.mjs [--out DIR] [--only TEXT] [--no-write]
//
// Needs `agentpkg/.venv` (or AGENTPKG_CLI and AGENTPKG_PYTHON) and a built Chrome core
// (`cd chrome-agent-browser && npm ci && npm run build`). No network, model or credential: every
// run is fixture mode and the control-plane scenarios execute nothing. Exit status 0 when every
// case passed, 1 otherwise; the report is written either way.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { compareArtifacts, compareFailureRace, diff } from "./lib/normalize.mjs";
import { readStored, rebuild } from "./lib/zip.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const option = (name) => {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : null;
};
const ONLY = option("--only");
const WRITE = !args.includes("--no-write");
const PYTHON_CLI = process.env.AGENTPKG_CLI ?? join(ROOT, "agentpkg/.venv/bin/agentpkg");
const PYTHON = process.env.AGENTPKG_PYTHON ?? join(ROOT, "agentpkg/.venv/bin/python");
const NODE_CLI = join(ROOT, "chrome-agent-browser/dist/cli.js");
const DIST = (name) => join(ROOT, "dist", name);
const EXAMPLES = (name) => join(ROOT, "examples", name);
const KEYS = {
  webair: EXAMPLES("keys/webair-publisher.pub.pem"),
  review: EXAMPLES("keys/literature-review-publisher.pub.pem"),
  agenda: EXAMPLES("keys/meeting-agenda-publisher.pub.pem"),
};

for (const [what, path] of [["agentpkg CLI", PYTHON_CLI], ["agentpkg Python", PYTHON], ["Chrome core CLI (npm run build)", NODE_CLI]]) {
  if (!existsSync(path)) {
    process.stderr.write(`conformance: missing ${what}: ${path}\n`);
    process.exit(2);
  }
}

// agentpkg refuses an output path with a symlink component (macOS: /var -> /private/var).
const SCRATCH = mkdtempSync(join(realpathSync(tmpdir()), "conformance-"));
let counter = 0;
const fresh = (label) => join(SCRATCH, `${String((counter += 1)).padStart(3, "0")}-${label}`);

// -- running the two runtimes --------------------------------------------------------------
function spawn(command, argv, { cwd = ROOT, env = {} } = {}) {
  const result = spawnSync(command, argv, { cwd, encoding: "utf8", timeout: 300_000, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, ...env } });
  if (result.error) throw result.error;
  return { status: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
}

function collect(directory) {
  const files = {};
  if (!existsSync(directory)) return files;
  for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    // A subdirectory is reported as an entry of its own, so a runtime that writes one shows up as
    // a file-set difference rather than a crashed case (T7 review 1, nit 6).
    files[entry.isDirectory() ? `${entry.name}/` : entry.name] = entry.isDirectory() ? new Uint8Array() : new Uint8Array(readFileSync(join(directory, entry.name)));
  }
  return files;
}

const RUNTIMES = {
  python: { prefix: "agentpkg: ", cli: (argv) => spawn(PYTHON_CLI, argv) },
  node: { prefix: "agent-browser: ", cli: (argv) => spawn(process.execPath, [NODE_CLI, ...argv]) },
};

/** One CLI invocation in one runtime; `{out}` in argv is replaced by a fresh directory. */
function invoke(runtime, argv, label) {
  const out = fresh(`${label}-${runtime}`);
  const result = RUNTIMES[runtime].cli(argv.map((arg) => (arg === "{out}" ? out : arg)));
  const lines = result.stderr.split("\n").filter(Boolean);
  const prefix = RUNTIMES[runtime].prefix;
  const message = lines.length > 0 && lines.at(-1).startsWith(prefix) ? lines.at(-1).slice(prefix.length) : null;
  let report = null;
  try {
    report = result.stdout ? JSON.parse(result.stdout) : null;
  } catch {
    report = null;
  }
  return { status: result.status, report, message, stderr: result.stderr, files: collect(out) };
}

// -- inputs the negative suite builds -------------------------------------------------------
const inputs = {};
function writeInput(name, bytes) {
  const path = join(SCRATCH, "inputs", name);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, bytes);
  return path;
}

function agentpkg(argv) {
  const result = spawn(PYTHON_CLI, argv);
  if (result.status !== 0) throw new Error(`agentpkg ${argv[0]} failed: ${result.stderr}`);
  return result.stdout ? JSON.parse(result.stdout) : null;
}

function buildInputs() {
  const review = new Uint8Array(readFileSync(DIST("literature-review.agent.pkg")));
  // 1. One byte of graph.json flipped in transit; the recorded CRC no longer matches.
  inputs.tamperedCrc = writeInput(
    "tampered-crc.agent.pkg",
    rebuild(review, (members) => members.map((m) => (m.name === "graph.json" ? { ...m, data: flip(m.data) } : m)), { keepCrc: ["graph.json"] }),
  );
  // 2. The same change with a correct CRC: only the integrity statement can catch it.
  inputs.tamperedContent = writeInput(
    "tampered-content.agent.pkg",
    rebuild(review, (members) => members.map((m) => (m.name === "graph.json" ? { ...m, data: flip(m.data) } : m))),
  );
  // 3. A signature that claims the Meeting Agenda key (embedded key and fingerprint replaced),
  //    which the host pins, over a signature that key never made.
  const agendaSignature = JSON.parse(new TextDecoder().decode(readStored(new Uint8Array(readFileSync(DIST("meeting-agenda.agent.pkg")))).find((m) => m.name === "signatures/publisher.json").data));
  inputs.wrongKey = writeInput(
    "wrong-key.agent.pkg",
    rebuild(review, (members) =>
      members.map((m) => {
        if (m.name !== "signatures/publisher.json") return m;
        const signature = JSON.parse(new TextDecoder().decode(m.data));
        for (const field of Object.keys(signature)) if (/key|fingerprint/u.test(field) && field in agendaSignature) signature[field] = agendaSignature[field];
        return { ...m, data: new TextEncoder().encode(canonical(signature)) };
      }),
    ),
  );
  // 4–5. Two rebuilt Meeting Agenda variants, signed with a throwaway key made for this run.
  const keyDir = join(SCRATCH, "keys");
  mkdirSync(keyDir);
  agentpkg(["keygen", "--private-key", join(keyDir, "throwaway.pem"), "--public-key", join(keyDir, "throwaway.pub.pem")]);
  inputs.throwawayKey = join(keyDir, "throwaway.pub.pem");
  inputs.schemaInvalid = variant("schema-invalid", (source) => {
    // The planner's recorded answer is not what its output schema allows.
    const fixture = readJson(join(source, "fixtures/workflow.json"));
    fixture.models.plan[0].output = { focus: 42 };
    writeJson(join(source, "fixtures/workflow.json"), fixture);
  });
  inputs.budget = variant("budget", (source) => {
    // A package budget far below what its own fixture run needs.
    const policy = readJson(join(source, "policy/policy.json"));
    policy.budget.hard_tokens = 600;
    policy.budget.estimated_tokens = 500;
    writeJson(join(source, "policy/policy.json"), policy);
    const graph = readJson(join(source, "graph.json"));
    for (const worker of graph.workers) worker.budget.tokens = Math.min(worker.budget.tokens, 600);
    writeJson(join(source, "graph.json"), graph);
  });
  // 6–7. Answer checks (D-150, agentpkg 0.3.0): all three kinds on a node and on a map step; in the
  //      second, the recorded `write` answer names an owner who is not a participant.
  inputs.answerChecks = variant("answer-checks", withAnswerChecks);
  inputs.answerCheckRefused = variant("answer-check-refused", (source) => {
    withAnswerChecks(source);
    const fixture = readJson(join(source, "fixtures/workflow.json"));
    fixture.models.write[0].output.agenda[1].owner = "Dana";
    writeJson(join(source, "fixtures/workflow.json"), fixture);
  });
  // Grants files for the permission cases.
  const webairGrants = readJson(EXAMPLES("webair-0.2.0-grants.json"));
  inputs.webairNetworkDenied = writeInput("webair-network-denied.json", JSON.stringify({ ...webairGrants, "network.webair": "deny" }));
  const agendaGrants = readJson(EXAMPLES("meeting-agenda-grants.json"));
  inputs.agendaModelOnce = writeInput("agenda-model-once.json", JSON.stringify({ ...agendaGrants, "model.reasoning": "once" }));
  const reviewGrants = readJson(EXAMPLES("literature-review-grants.json"));
  inputs.webairQuote = writeInput("webair-quote.json", JSON.stringify({ ...readJson(EXAMPLES("webair-scenarios.json")).scenarios[0].input, booking: true }));
  inputs.reviewFilesDenied = writeInput("review-files-denied.json", JSON.stringify({ ...reviewGrants, "files.pdfs": "deny" }));
}

/** Meeting Agenda with answer checks (D-150): a relation, a sum and an equality, on llm nodes and a map llm step. */
function withAnswerChecks(source) {
  const manifest = readJson(join(source, "MANIFEST.agent"));
  manifest.runtime.minimum_version = "0.3.0";
  writeJson(join(source, "MANIFEST.agent"), manifest);
  const graph = readJson(join(source, "graph.json"));
  const nodes = Object.fromEntries(graph.nodes.map((node) => [node.id, node]));
  nodes.plan.checks = [{ kind: "relation", rows: { from: "result", path: "/focus" }, targets: { from: "result", path: "/focus" }, row_key: "", target_key: "" }];
  nodes.perspectives.steps[0].checks = [{ kind: "equal", left: { from: "result", path: "/0/role" }, right: { from: "item", path: "/role" } }];
  nodes.write.checks = [
    { kind: "relation", rows: { from: "result", path: "/agenda" }, targets: { from: "state", path: "/request/participants" }, row_key: "/owner", target_key: "/name" },
    { kind: "sum", rows: { from: "result", path: "/agenda" }, path: "/minutes", equals: { from: "state", path: "/request/duration" } },
  ];
  writeJson(join(source, "graph.json"), graph);
}

function variant(name, change) {
  const source = join(SCRATCH, "variants", name);
  cpSync(join(ROOT, "agents/meeting-agenda"), source, { recursive: true, filter: (path) => !path.endsWith(".DS_Store") });
  const manifest = readJson(join(source, "MANIFEST.agent"));
  manifest.package_id = `org.webagents.conformance.${name}`;
  writeJson(join(source, "MANIFEST.agent"), manifest);
  change(source);
  const built = join(SCRATCH, "variants", `${name}.unsigned.agent.pkg`);
  const signed = join(SCRATCH, "variants", `${name}.agent.pkg`);
  agentpkg(["build", source, "-o", built]);
  agentpkg(["sign", built, "--private-key", join(SCRATCH, "keys", "throwaway.pem"), "-o", signed]);
  return signed;
}

const flip = (data) => {
  const copy = new Uint8Array(data);
  // A byte inside the JSON text, not its first brace: still parseable as a ZIP member.
  copy[Math.floor(copy.length / 2)] ^= 0x01;
  return copy;
};
const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
const writeJson = (path, value) => writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

// -- the cases -------------------------------------------------------------------------------
const webairTools = ["search-flights", "get-fare-rules", "prepare-booking", "simulate-purchase", "personal.travel_profile", "personal.passenger_identity", "wallet.payment_method"];
const approve = (tools) => tools.flatMap((tool) => ["--approve-tool", tool]);
const scenarios = readJson(EXAMPLES("webair-scenarios.json")).scenarios;

function positiveCases() {
  const fixtureRun = (archive, grants, tools, extra = []) => ["run", archive, "--mode", "fixture", "--grants", grants, "--out", "{out}", ...approve(tools), ...extra];
  const cases = [
    { id: "webair-0.4.0/fixture", title: "WebAir 0.4.0, its fixture input, every tool approved", argv: fixtureRun(DIST("webair-0.4.0.agent.pkg"), EXAMPLES("webair-0.2.0-grants.json"), webairTools) },
    { id: "webair-0.5.0/fixture", title: "WebAir 0.5.0, its fixture input, every tool approved", argv: fixtureRun(DIST("webair-0.5.0.agent.pkg"), EXAMPLES("webair-0.2.0-grants.json"), webairTools) },
    // The search scenarios are the current package's: 0.5.0 adds no-departure, which 0.4.0's fixture cannot replay (T9).
    ...scenarios.map((scenario) => ({
      id: `webair-0.5.0/scenario-${scenario.id}`,
      title: `WebAir 0.5.0, scenario ${scenario.id}`,
      argv: fixtureRun(DIST("webair-0.5.0.agent.pkg"), EXAMPLES("webair-0.2.0-grants.json"), webairTools, ["--input", writeInput(`scenario-${scenario.id}.json`, JSON.stringify(scenario.input))]),
    })),
    { id: "webair-0.4.0/search-tools-only", title: "WebAir 0.4.0, only the two search tools approved (the 'search' profile's tools)", argv: fixtureRun(DIST("webair-0.4.0.agent.pkg"), EXAMPLES("webair-0.2.0-grants.json"), ["search-flights", "get-fare-rules"]) },
    { id: "literature-review-0.2.5/fixture", title: "Literature Review 0.2.5, its fixture input", argv: fixtureRun(DIST("literature-review.agent.pkg"), EXAMPLES("literature-review-grants.json"), ["scholarly-search", "paper-reader", "citation-resolver"]), allowTokens: true },
    { id: "literature-review-0.2.7/fixture", title: "Literature Review 0.2.7 (ids before any model, verdict-only screening, answer checks, papers-found; T15), its fixture input", argv: fixtureRun(DIST("literature-review-0.2.7.agent.pkg"), EXAMPLES("literature-review-grants.json"), ["scholarly-search", "paper-reader", "citation-resolver"]), allowTokens: true },
    { id: "literature-review-0.2.6/fixture", title: "Literature Review 0.2.6 (screening jobs built from the candidates, T10), its fixture input", argv: fixtureRun(DIST("literature-review-0.2.6.agent.pkg"), EXAMPLES("literature-review-grants.json"), ["scholarly-search", "paper-reader", "citation-resolver"]), allowTokens: true },
    { id: "meeting-agenda-0.2.2/fixture", title: "Meeting Agenda 0.2.2, its fixture input", argv: fixtureRun(DIST("meeting-agenda.agent.pkg"), EXAMPLES("meeting-agenda-grants.json"), []) },
    { id: "answer-checks/fixture", title: "Answer checks that hold (D-150): Meeting Agenda rebuilt with a relation, a sum and an equality on its model answers, runtime minimum 0.3.0 (throwaway key)", argv: fixtureRun(inputs.answerChecks, EXAMPLES("meeting-agenda-grants.json"), [], ["--trust-key", inputs.throwawayKey]) },
  ];
  return cases.map((testCase) => ({ ...testCase, kind: "fixture parity", run: () => runPositive(testCase) }));
}

function runPositive(testCase) {
  const python = invoke("python", testCase.argv, testCase.id.replace(/\W+/gu, "_"));
  const node = invoke("node", testCase.argv, testCase.id.replace(/\W+/gu, "_"));
  const checks = [];
  const check = (name, differences) => checks.push({ name, passed: differences.length === 0, detail: differences });
  check("exit status 0 in both", [python.status, node.status].every((status) => status === 0) ? [] : [`python ${python.status}: ${python.message ?? ""}`, `node ${node.status}: ${node.message ?? ""}`]);
  if (python.report && node.report) {
    const strip = ({ output_directory: _o, usage: _u, ...rest }) => rest;
    check("success report (minus output directory and usage)", diff(strip(python.report), strip(node.report)));
  }
  const compared = compareArtifacts(python.files, node.files, { allowTokens: Boolean(testCase.allowTokens) });
  checks.push(...compared.checks);
  const notes = [];
  if (testCase.allowTokens) notes.push(`Allowlisted (D-063), printed: synthetic tokens python=${compared.tokens.python} node=${compared.tokens.node}.`);
  return { checks, notes, observed: { python: summary(python), node: summary(node) } };
}

const summary = (observation) => ({ status: observation.status, message: observation.message, files: Object.keys(observation.files).length });

/** A refusal's code: `workflow.v0 <code>[ at node <id>]`, or the expected code when the message matches. */
function refusalOf(observation, expectation) {
  if (observation.message === null) return { code: null, node: null };
  const workflow = /^workflow\.v0 (\S+)(?: at node (\S+))?$/u.exec(observation.message);
  if (workflow) return { code: workflow[1], node: workflow[2] ?? null };
  return { code: expectation.message?.test(observation.message) ? expectation.code : "unexpected_message", node: null };
}

function negativeCases() {
  const verify = (archive, key) => ["verify", archive, "--trust-key", key];
  const run = (archive, grants, extra) => ["run", archive, "--mode", "fixture", "--grants", grants, "--out", "{out}", ...extra];
  const cli = (id, title, commands, expectation, options = {}) => ({ id, title, kind: options.kind ?? "refusal", run: () => runNegative(commands, expectation, options) });
  const documented = (id, title, argv, expected, layer) => ({ id, title, kind: "documented difference", run: () => runDocumented(argv, expected, layer) });
  return [
    cli("tampered-bytes/crc", "One byte of graph.json changed in transit; the archive's CRC no longer matches", [verify(inputs.tamperedCrc, KEYS.review), run(inputs.tamperedCrc, EXAMPLES("literature-review-grants.json"), ["--trust-key", KEYS.review])], { code: "archive_crc_mismatch", message: /^invalid ZIP artifact: Bad CRC-32 for file 'graph\.json'$/u }),
    cli("tampered-bytes/content", "The same change with a recomputed CRC: the integrity statement no longer matches", [verify(inputs.tamperedContent, KEYS.review), run(inputs.tamperedContent, EXAMPLES("literature-review-grants.json"), ["--trust-key", KEYS.review])], { code: "integrity_mismatch", message: /^content integrity mismatch: missing=\[\], extra=\[\], changed=\['graph\.json'\]$/u }),
    cli("unpinned-key", "A valid signature by a key the host did not pin (Literature Review checked against the Meeting Agenda key)", [verify(DIST("literature-review.agent.pkg"), KEYS.agenda), run(DIST("literature-review.agent.pkg"), EXAMPLES("literature-review-grants.json"), ["--trust-key", KEYS.agenda])], { code: "publisher_key_not_pinned", message: /^publisher key is not the host-pinned trusted key$/u }),
    cli("wrong-key", "A signature that claims the pinned Meeting Agenda key, which never made it", [verify(inputs.wrongKey, KEYS.agenda), run(inputs.wrongKey, EXAMPLES("literature-review-grants.json"), ["--trust-key", KEYS.agenda])], { code: "signature_invalid", message: /^invalid Ed25519 publisher signature$/u }),
    cli("missing-approval", "Literature Review with every permission granted and no tool approved", [run(DIST("literature-review.agent.pkg"), EXAMPLES("literature-review-grants.json"), [])], { code: "permission_denied", node: "search", artifacts: true }),
    cli("denied-permission/optional", "WebAir 0.4.0 asked to quote, its personal tools approved and the optional passenger-identity permission denied", [run(DIST("webair-0.4.0.agent.pkg"), EXAMPLES("webair-0.2.0-grants.json"), [...approve(["search-flights", "get-fare-rules", "prepare-booking", "personal.travel_profile", "personal.passenger_identity"]), "--input", inputs.webairQuote])], { code: "permission_denied", node: "passenger", artifacts: true }),
    cli("denied-permission/optional-in-a-map", "Literature Review with its optional files.pdfs permission denied and the paper reader approved: the refusal happens inside a concurrent map", [run(DIST("literature-review.agent.pkg"), inputs.reviewFilesDenied, approve(["scholarly-search", "citation-resolver", "paper-reader"]))], { code: "permission_denied", node: "screening", artifacts: "race" }, { kind: "documented difference" }),
    documented(
      "denied-permission/required",
      "WebAir 0.4.0 with its search tools approved and the required network permission they travel under denied",
      run(DIST("webair-0.4.0.agent.pkg"), inputs.webairNetworkDenied, approve(["search-flights", "get-fare-rules"])),
      { python: { code: "permission_denied", node: "search" }, node: { message: /^Required permission 'network\.webair' is denied, so this package cannot run\.$/u } },
      { archive: DIST("webair-0.4.0.agent.pkg"), grants: inputs.webairNetworkDenied, code: "execution_permission_denied" },
    ),
    cli("schema-invalid-output", "A recorded model answer that its node's output schema refuses (rebuilt Meeting Agenda, throwaway key)", [run(inputs.schemaInvalid, EXAMPLES("meeting-agenda-grants.json"), ["--trust-key", inputs.throwawayKey])], { code: "schema_validation", node: "plan", artifacts: true }),
    cli("budget-overrun", "A package token budget below what its own fixture run needs (rebuilt Meeting Agenda, throwaway key)", [run(inputs.budget, EXAMPLES("meeting-agenda-grants.json"), ["--trust-key", inputs.throwawayKey])], { code: "budget_exhausted", node: "plan", artifacts: true }),
    cli("answer-check-refused", "A recorded model answer that its node's answer check refuses (D-150): a non-conforming answer, never re-asked by a replay router (rebuilt Meeting Agenda, throwaway key)", [run(inputs.answerCheckRefused, EXAMPLES("meeting-agenda-grants.json"), ["--trust-key", inputs.throwawayKey])], { code: "model_error", node: "write", artifacts: true }),
    documented(
      "once-overused",
      "The model permission granted once, to a graph that calls the model more than once",
      run(DIST("meeting-agenda.agent.pkg"), inputs.agendaModelOnce, []),
      { python: { code: "permission_denied", node: "perspectives" }, node: { message: /^Permission 'model\.reasoning' was granted 'once', but this workflow would use it up to \d+ times\./u } },
      { archive: DIST("meeting-agenda.agent.pkg"), grants: inputs.agendaModelOnce, code: "execution_grant_unsupported" },
    ),
  ];
}

function runNegative(commands, expectation, options) {
  const checks = [];
  const check = (name, differences) => checks.push({ name, passed: differences.length === 0, detail: differences });
  const observed = [];
  const notes = [...(options.notes ?? [])];
  for (const [index, argv] of commands.entries()) {
    const label = `${argv[0]}-${index}`;
    const python = invoke("python", argv, label);
    const node = invoke("node", argv, label);
    const refusals = { python: refusalOf(python, expectation), node: refusalOf(node, expectation) };
    observed.push({ command: argv[0], python: { ...summary(python), ...refusals.python }, node: { ...summary(node), ...refusals.node } });
    check(`${argv[0]}: refused with status 2 in both`, [python, node].every((o) => o.status === 2 && o.report === null) ? [] : [`python ${python.status}`, `node ${node.status}`]);
    check(`${argv[0]}: refusal code ${expectation.code}`, ["python", "node"].filter((r) => refusals[r].code !== expectation.code).map((r) => `${r}: ${refusals[r].code} (${r === "python" ? python.message : node.message})`));
    if (expectation.node) check(`${argv[0]}: at node ${expectation.node}`, ["python", "node"].filter((r) => refusals[r].node !== expectation.node).map((r) => `${r}: ${refusals[r].node}`));
    check(`${argv[0]}: identical message`, python.message === node.message ? [] : [`python: ${python.message}`, `node: ${node.message}`]);
    if (expectation.artifacts === "race") {
      const compared = compareFailureRace(python.files, node.files);
      checks.push(...compared.checks.map((item) => ({ ...item, name: `${argv[0]}: ${item.name}` })));
      notes.push(`A failure inside a concurrent wave (D-092): siblings' partial progress is the scheduler's, so their events and reserved tokens are not compared; tokens python=${compared.tokens.python} node=${compared.tokens.node}.`);
    } else if (expectation.artifacts) {
      checks.push(...compareArtifacts(python.files, node.files).checks.map((item) => ({ ...item, name: `${argv[0]}: ${item.name}` })));
    } else {
      check(`${argv[0]}: nothing written`, Object.keys(python.files).length + Object.keys(node.files).length === 0 ? [] : ["files written"]);
    }
  }
  return { checks, notes, observed };
}

/**
 * A refusal the two CLIs make at different stages, by design (D-091): `agentpkg run` drives the
 * interpreter, which refuses at the first use; the Chrome CLI always runs through its execution
 * layer, which refuses before anything runs, as agentpkg's own execution runner does. Each CLI is
 * checked against its own documented behaviour, and the execution layers are compared directly.
 */
function runDocumented(argv, expected, layer) {
  const checks = [];
  const check = (name, differences) => checks.push({ name, passed: differences.length === 0, detail: differences });
  const python = invoke("python", argv, "documented");
  const node = invoke("node", argv, "documented");
  const pyRefusal = refusalOf(python, { code: null });
  check("agentpkg run: refused at the first use", python.status === 2 && pyRefusal.code === expected.python.code && pyRefusal.node === expected.python.node && "result.json" in python.files ? [] : [`${python.status}: ${python.message}`]);
  check("chrome CLI: refused before the run, nothing written", node.status === 2 && expected.node.message.test(node.message ?? "") && Object.keys(node.files).length === 0 ? [] : [`${node.status}: ${node.message}`]);
  const pyLayer = spawn(PYTHON, [join(ROOT, "conformance/drivers/execution_policy.py"), layer.archive, layer.grants]);
  const nodeLayer = spawn(process.execPath, [join(SCRATCH, "drivers", "execution-policy.js"), layer.archive, layer.grants]);
  const outcomes = [pyLayer, nodeLayer].map((result) => (result.status === 0 ? JSON.parse(result.stdout) : { outcome: "driver_failed", message: result.stderr.slice(-400) }));
  check(`execution layers: both refuse ${layer.code}`, outcomes.every((o) => o.outcome === "refused" && o.code === layer.code) ? [] : outcomes.map((o) => JSON.stringify(o)));
  check("execution layers: identical message", outcomes[0].message === outcomes[1].message ? [] : [`python: ${outcomes[0].message}`, `node: ${outcomes[1].message}`]);
  return {
    checks,
    notes: [`A recorded difference of the CLIs (D-091), not of the runtimes: agentpkg run says "${python.message}"; the Chrome CLI and both execution layers say "${node.message}".`],
    observed: { python: summary(python), node: summary(node), execution_layers: outcomes },
  };
}

// -- control-plane scenarios -----------------------------------------------------------------
let nodeDriver = null;
async function bundleDrivers() {
  // The Chrome core's TypeScript, bundled with the esbuild its own build uses.
  const esbuild = await import(pathToFileURL(join(ROOT, "chrome-agent-browser/node_modules/esbuild/lib/main.js")).href);
  const drivers = ["control-plane", "execution-policy"].map((name) => join(ROOT, "conformance/drivers", `${name}.ts`));
  await esbuild.build({ entryPoints: drivers, bundle: true, platform: "node", format: "esm", target: "node24", outdir: join(SCRATCH, "drivers"), outExtension: { ".js": ".js" }, logLevel: "warning" });
  // ESM output needs a module scope: name the directory a module package.
  writeFileSync(join(SCRATCH, "drivers", "package.json"), '{"type": "module"}\n');
  nodeDriver = join(SCRATCH, "drivers", "control-plane.js");
}

const controlScenarios = readJson(join(ROOT, "conformance/drivers/scenarios.json"));
/** A lease refusal's reason: the error code, or the first stale reason when the code is the generic `run_plan_stale`. */
const leaseReason = (step) => (step.code === "run_plan_stale" && step.stale_reasons?.length ? step.stale_reasons[0] : step.code ?? null);

function controlCases() {
  const documented = {
    // D-090: outside a profile the reference control plane cannot tell an unanswered approval from a refused one.
    partial_approvals_without_profile: {
      decision: "D-090",
      python: (steps) => steps[1]?.outcome === "refused" && steps[1].reasons.every((code) => code === "tool_not_approved") && steps[1].reasons.length === 5,
      node: (steps) => steps[1]?.outcome === "ready" && steps[2]?.outcome === "issued" && steps[1].denied_tool_ids.length === 5,
    },
  };
  return Object.entries(controlScenarios).map(([name, scenario]) => ({
    id: `control-plane/${name}`,
    title: scenario.title,
    kind: documented[name] ? "documented difference" : name.startsWith("profile") ? "control-plane parity" : "refusal",
    run: () => runControl(name, documented[name] ?? null),
  }));
}

function runControl(name, documented) {
  const python = spawn(PYTHON, [join(ROOT, "conformance/drivers/control_plane.py"), name]);
  const node = spawn(process.execPath, [nodeDriver, name], { env: { CONFORMANCE_ROOT: ROOT } });
  const checks = [];
  const check = (label, differences) => checks.push({ name: label, passed: differences.length === 0, detail: differences });
  check("both drivers completed", [python, node].every((r) => r.status === 0) ? [] : [`python ${python.status}: ${python.stderr.slice(-400)}`, `node ${node.status}: ${node.stderr.slice(-400)}`]);
  if (python.status !== 0 || node.status !== 0) return { checks, notes: [], observed: null };
  const py = JSON.parse(python.stdout).steps;
  const nd = JSON.parse(node.stdout).steps;
  if (documented) {
    check(`agentpkg behaves as ${documented.decision} records`, documented.python(py) ? [] : [JSON.stringify(py.slice(1))]);
    check(`chrome-agent-browser behaves as ${documented.decision} records`, documented.node(nd) ? [] : [JSON.stringify(nd.slice(1))]);
    return { checks, notes: [`A recorded difference (${documented.decision}), not a failure: each runtime is checked against its own documented behaviour.`], observed: { python: py, node: nd } };
  }
  // Lease refusals compare by reason (raw codes are printed): Chrome's lease names a spent `once`
  // `authorization_once_spent`, the Python control plane `run_plan_stale` with that stale reason.
  const view = (steps) => steps.map((step) => (step.step === "lease" && step.outcome === "refused" ? { ...step, code: undefined, reason: leaseReason(step) } : step));
  check("every step agrees (lease refusals by reason)", diff(JSON.parse(JSON.stringify(view(py))), JSON.parse(JSON.stringify(view(nd)))));
  const raw = py.flatMap((step, index) => (step.step === "lease" && step.outcome === "refused" ? [`lease ${index}: python ${step.code}, node ${nd[index]?.code}`] : []));
  return { checks, notes: raw.length ? [`Raw lease refusal codes: ${raw.join("; ")}.`] : [], observed: { python: py, node: nd } };
}

// -- the report ------------------------------------------------------------------------------
function git(argv) {
  const result = spawnSync("git", argv, { cwd: ROOT, encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : null;
}

function environment() {
  const sha = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
  return {
    commit: git(["rev-parse", "HEAD"]),
    dirty: Boolean(git(["status", "--porcelain", "--untracked-files=no"])),
    agentpkg: spawn(PYTHON_CLI, ["--version"]).stdout.trim(),
    python: spawn(PYTHON, ["--version"]).stdout.trim(),
    chrome_core: `chrome-agent-browser ${readJson(join(ROOT, "chrome-agent-browser/package.json")).version}`,
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
    packages: Object.fromEntries(["webair-0.4.0.agent.pkg", "webair-0.5.0.agent.pkg", "literature-review.agent.pkg", "literature-review-0.2.6.agent.pkg", "literature-review-0.2.7.agent.pkg", "meeting-agenda.agent.pkg"].map((name) => [name, sha(DIST(name))])),
  };
}

function markdown(report) {
  const lines = [
    "# Conformance report",
    "",
    `Generated ${report.generated_at} at commit \`${report.environment.commit}\`${report.environment.dirty ? " (working tree had uncommitted changes)" : ""}.`,
    `${report.environment.agentpkg}; ${report.environment.python}; ${report.environment.chrome_core}; Node ${report.environment.node}; ${report.environment.platform}.`,
    "",
    `**${report.summary.passed} of ${report.summary.cases} cases passed** (${report.summary.checks_passed} of ${report.summary.checks} checks).`,
    "",
    "| Case | Kind | Result | Checks |",
    "|---|---|---|---|",
    ...report.cases.map((c) => `| \`${c.id}\` | ${c.kind} | ${c.passed ? "pass" : "**FAIL**"} | ${c.checks.filter((k) => k.passed).length}/${c.checks.length} |`),
    "",
  ];
  for (const c of report.cases) {
    lines.push(`## \`${c.id}\``, "", c.title, "");
    for (const k of c.checks) lines.push(`- ${k.passed ? "✓" : "✗"} ${k.name}${k.passed ? "" : `: ${k.detail.join("; ")}`}`);
    for (const note of c.notes) lines.push(`- Note: ${note}`);
    lines.push("");
  }
  lines.push("What these results do and do not show: see `conformance/README.md`.", "");
  return lines.join("\n");
}

async function main() {
  buildInputs();
  await bundleDrivers();
  const cases = [...positiveCases(), ...negativeCases(), ...controlCases()].filter((c) => ONLY === null || c.id.includes(ONLY));
  const results = [];
  for (const testCase of cases) {
    const started = Date.now();
    let outcome;
    try {
      outcome = testCase.run();
    } catch (error) {
      outcome = { checks: [{ name: "case ran", passed: false, detail: [String(error?.stack ?? error)] }], notes: [], observed: null };
    }
    const passed = outcome.checks.length > 0 && outcome.checks.every((check) => check.passed);
    results.push({ id: testCase.id, title: testCase.title, kind: testCase.kind, passed, seconds: (Date.now() - started) / 1000, ...outcome });
    process.stdout.write(`${passed ? "pass" : "FAIL"}  ${testCase.id}\n`);
    for (const check of outcome.checks.filter((item) => !item.passed)) process.stdout.write(`      ✗ ${check.name}: ${check.detail.join("; ")}\n`);
    for (const note of outcome.notes) process.stdout.write(`      note: ${note}\n`);
  }
  const allChecks = results.flatMap((r) => r.checks);
  const report = {
    schema: "webagents-conformance-report-v0",
    generated_at: new Date().toISOString(),
    environment: environment(),
    summary: { cases: results.length, passed: results.filter((r) => r.passed).length, failed: results.filter((r) => !r.passed).map((r) => r.id), checks: allChecks.length, checks_passed: allChecks.filter((c) => c.passed).length, filtered: ONLY },
    cases: results,
    passed: results.length > 0 && results.every((r) => r.passed),
  };
  if (WRITE) {
    const out = option("--out") ?? join(ROOT, "conformance/results", report.generated_at.replace(/[:.]/gu, "-"));
    mkdirSync(out, { recursive: true });
    writeFileSync(join(out, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
    writeFileSync(join(out, "report.md"), markdown(report));
    process.stdout.write(`report: ${relative(process.cwd(), out) || out}\n`);
  }
  process.stdout.write(`${report.summary.passed}/${report.summary.cases} cases passed\n`);
  rmSync(SCRATCH, { recursive: true, force: true });
  process.exit(report.passed ? 0 : 1);
}

main().catch((error) => {
  process.stderr.write(`conformance: ${error?.stack ?? error}\n`);
  rmSync(SCRATCH, { recursive: true, force: true });
  process.exit(2);
});
