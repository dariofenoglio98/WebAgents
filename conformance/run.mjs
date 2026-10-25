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

import { compareArtifacts, compareConversation, compareFailureRace, diff } from "./lib/normalize.mjs";
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
// CONFORMANCE_CHROME names another built chrome-agent-browser checkout to compare against (for
// example a task branch's worktree before it is merged); its CLI and its runtime version are used.
const CHROME_ROOT = process.env.CONFORMANCE_CHROME ?? join(ROOT, "chrome-agent-browser");
const NODE_CLI = join(CHROME_ROOT, "dist/cli.js");
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

function collect(directory, prefix = "") {
  const files = {};
  if (!existsSync(directory)) return files;
  for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    // A subdirectory is reported as an entry of its own, so a runtime that writes one shows up as
    // a file-set difference rather than a crashed case (T7 review 1, nit 6); a conversation's
    // `turn-NNN/` directories (conversation.v0, D-263) are the one kind whose files are collected,
    // one level down, under their prefix.
    if (entry.isDirectory() && /^turn-\d{3}$/u.test(entry.name) && prefix === "") Object.assign(files, collect(join(directory, entry.name), `${entry.name}/`));
    else files[`${prefix}${entry.isDirectory() ? `${entry.name}/` : entry.name}`] = entry.isDirectory() ? new Uint8Array() : new Uint8Array(readFileSync(join(directory, entry.name)));
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
  // network.v0 (T26): the travel network's source, built and signed with the throwaway key until
  // its signed archive is shipped.
  const travelBuilt = join(SCRATCH, "travel-network.unsigned.agent.pkg");
  TRAVEL_NETWORK.archive = join(SCRATCH, "travel-network.agent.pkg");
  TRAVEL_NETWORK.key = inputs.throwawayKey;
  agentpkg(["build", EXAMPLES("network/travel-network"), "-o", travelBuilt]);
  agentpkg(["sign", travelBuilt, "--private-key", join(keyDir, "throwaway.pem"), "-o", TRAVEL_NETWORK.archive]);
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
  // memory.v0 (T20, M-64): the probe package and one variant per negative case, written by the
  // Python driver from agentpkg's own test package and signed with the throwaway key.
  inputs.memory = {};
  for (const name of MEMORY_VARIANTS) inputs.memory[name] = memoryVariant(name);
  // compute.v0 (T22, C-51, B-225): one probe per enforcement case of examples/compute/cases/cases.json,
  // written by the Python driver from agentpkg's own test package and signed with the throwaway key.
  // `engine-unavailable` has no CLI form (both CLIs have an engine here); each unit suite covers it.
  inputs.compute = {};
  for (const testCase of COMPUTE_CASES) if (testCase.id !== "engine-unavailable") inputs.compute[testCase.id] = computeCase(testCase);
  // N-16: the echo probe with one byte of its module changed and the CRC recomputed, so only the
  // integrity statement can catch it (C-12).
  inputs.compute["tampered-archive"].archive = writeInput(
    "compute-tampered.agent.pkg",
    rebuild(new Uint8Array(readFileSync(inputs.compute.echo.archive)), (members) => members.map((m) => (m.name === "modules/echo.wasm" ? { ...m, data: flip(m.data) } : m))),
  );
  // conversation.v0 (T24, B-232): one probe per enforcement case of examples/conversation/cases/cases.json,
  // written by the Python driver from agentpkg's own test package and signed with the throwaway key.
  // The two consent-host cases (`silent`, `invalid`) have no CLI form; each unit suite covers them.
  inputs.conversation = {};
  for (const testCase of CONVERSATION_CASES) if (!testCase.host) inputs.conversation[testCase.id] = conversationCase(testCase);
  // network.v0 (T26): one probe per enforcement case of examples/network/cases/cases.json, written by
  // the Python driver from agentpkg's own test package and signed with the throwaway key.
  inputs.network = {};
  for (const testCase of NETWORK_CASES) inputs.network[testCase.id] = networkCase(testCase);
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

const MEMORY_VARIANTS = [
  "fixture",
  "n1-type-undeclared",
  "n2-sealed-field",
  "n4-agent-write-over-cap",
  "n5-newer-runtime",
  "n6-view-mismatch",
  "n7-two-agent-writes",
  "n8-update-not-granted",
  "n9-link-to-no-proposal",
  "n10-publisher-scoped",
  "n11-sealed-value-to-a-model",
  "n12-write-without-export",
  "n13-sealed-value-in-a-proposal",
  "n14-link-not-granted",
  "n14-body-link-not-granted",
  "n15-supersedes-link",
  "n16-custom-type-shadows-sealed",
  "n17-custom-type-reserved",
  "n19-lower-index-first",
  "n21-custom-type-open",
  "n22-marker-line",
  "m36-sealed-value-to-a-tool",
  "m36-granted-sealed-value",
  "m36-two-sealed-values",
  "custom-type-proposal",
  "custom-type-read",
  "agent-family-read",
];

/**
 * One memory probe variant: its source written by `drivers/memory_probe.py`, built and signed with
 * the throwaway key when it builds (a variant the builder refuses is run from its source, so that
 * both CLIs meet the same validation refusal).
 */
function memoryVariant(name) {
  const source = join(SCRATCH, "memory", name);
  const written = spawn(PYTHON, [join(ROOT, "conformance/drivers/memory_probe.py"), source, name]);
  if (written.status !== 0) throw new Error(`memory probe ${name}: ${written.stderr}`);
  const { grants, tools } = JSON.parse(written.stdout);
  const built = join(SCRATCH, "memory", `${name}.unsigned.agent.pkg`);
  const signed = join(SCRATCH, "memory", `${name}.agent.pkg`);
  const build = spawn(PYTHON_CLI, ["build", source, "-o", built]);
  if (build.status === 0) {
    agentpkg(["sign", built, "--private-key", join(SCRATCH, "keys", "throwaway.pem"), "-o", signed]);
    return { archive: signed, source, grants, tools };
  }
  // A variant agentpkg refuses to build (a validation case): the same bytes, signed by the driver
  // without validating, so that both CLIs meet the refusal when they load the archive.
  const forged = spawn(PYTHON, [join(ROOT, "conformance/drivers/memory_probe.py"), "--signed-archive", source, signed, join(SCRATCH, "keys", "throwaway.pem")]);
  if (forged.status !== 0) throw new Error(`memory probe ${name}: ${forged.stderr}`);
  return { archive: signed, source, grants, tools, refusedAtBuild: build.stderr.trim() };
}

const COMPUTE_CASES = JSON.parse(spawn(PYTHON, [join(ROOT, "conformance/drivers/compute_probe.py"), "--cases"]).stdout);

/**
 * One compute probe case: its source written by `drivers/compute_probe.py`, built and signed with
 * the throwaway key when it builds (a case agentpkg refuses to build, a container or validation
 * case, is signed by the driver without validating, so that both CLIs meet the same refusal when
 * they load the archive).
 */
function computeCase(testCase) {
  const name = testCase.id;
  const source = join(SCRATCH, "compute", name);
  const written = spawn(PYTHON, [join(ROOT, "conformance/drivers/compute_probe.py"), source, name]);
  if (written.status !== 0) throw new Error(`compute probe ${name}: ${written.stderr}`);
  const { grants } = JSON.parse(written.stdout);
  const built = join(SCRATCH, "compute", `${name}.unsigned.agent.pkg`);
  const signed = join(SCRATCH, "compute", `${name}.agent.pkg`);
  const build = spawn(PYTHON_CLI, ["build", source, "-o", built]);
  if (build.status === 0) {
    agentpkg(["sign", built, "--private-key", join(SCRATCH, "keys", "throwaway.pem"), "-o", signed]);
    return { archive: signed, source, grants, case: testCase };
  }
  const forged = spawn(PYTHON, [join(ROOT, "conformance/drivers/compute_probe.py"), "--signed-archive", source, signed, join(SCRATCH, "keys", "throwaway.pem")]);
  if (forged.status !== 0) throw new Error(`compute probe ${name}: ${forged.stderr}`);
  return { archive: signed, source, grants, case: testCase, refusedAtBuild: build.stderr.trim() };
}

/** The travel network the suite runs (set in `buildInputs`). */
const TRAVEL_NETWORK = { archive: null, key: null };
const NETWORK_CASES = JSON.parse(spawn(PYTHON, [join(ROOT, "conformance/drivers/network_probe.py"), "--cases"]).stdout);

/**
 * One network probe case: its source and grants written by `drivers/network_probe.py`, built and
 * signed with the throwaway key when it builds (a case agentpkg refuses to build, a validation
 * case, is signed by the driver without validating, so that both CLIs meet the same refusal when
 * they load the archive).
 */
function networkCase(testCase) {
  const name = testCase.id;
  const source = join(SCRATCH, "network", name);
  const written = spawn(PYTHON, [join(ROOT, "conformance/drivers/network_probe.py"), source, name]);
  if (written.status !== 0) throw new Error(`network probe ${name}: ${written.stderr}`);
  const { grants } = JSON.parse(written.stdout);
  const built = join(SCRATCH, "network", `${name}.unsigned.agent.pkg`);
  const signed = join(SCRATCH, "network", `${name}.agent.pkg`);
  const build = spawn(PYTHON_CLI, ["build", source, "-o", built]);
  if (build.status === 0) {
    agentpkg(["sign", built, "--private-key", join(SCRATCH, "keys", "throwaway.pem"), "-o", signed]);
    return { archive: signed, source, grants, case: testCase };
  }
  const forged = spawn(PYTHON, [join(ROOT, "conformance/drivers/network_probe.py"), "--signed-archive", source, signed, join(SCRATCH, "keys", "throwaway.pem")]);
  if (forged.status !== 0) throw new Error(`network probe ${name}: ${forged.stderr}`);
  return { archive: signed, source, grants, case: testCase, refusedAtBuild: build.stderr.trim() };
}

const CONVERSATION_CASES = JSON.parse(spawn(PYTHON, [join(ROOT, "conformance/drivers/conversation_probe.py"), "--cases"]).stdout);

/**
 * One conversation probe case: its source, grants, input transcript and host limits written by
 * `drivers/conversation_probe.py`, built and signed with the throwaway key when it builds (a
 * validation case agentpkg refuses to build is signed by the driver without validating, so that
 * both CLIs meet the same refusal when they load the archive).
 */
function conversationCase(testCase) {
  const name = testCase.id;
  const source = join(SCRATCH, "conversation", name);
  const written = spawn(PYTHON, [join(ROOT, "conformance/drivers/conversation_probe.py"), source, name]);
  if (written.status !== 0) throw new Error(`conversation probe ${name}: ${written.stderr}`);
  const { grants, transcript, limits } = JSON.parse(written.stdout);
  const built = join(SCRATCH, "conversation", `${name}.unsigned.agent.pkg`);
  const signed = join(SCRATCH, "conversation", `${name}.agent.pkg`);
  const build = spawn(PYTHON_CLI, ["build", source, "-o", built]);
  if (build.status === 0) {
    agentpkg(["sign", built, "--private-key", join(SCRATCH, "keys", "throwaway.pem"), "-o", signed]);
    return { archive: signed, source, grants, transcript, limits, case: testCase };
  }
  const forged = spawn(PYTHON, [join(ROOT, "conformance/drivers/conversation_probe.py"), "--signed-archive", source, signed, join(SCRATCH, "keys", "throwaway.pem")]);
  if (forged.status !== 0) throw new Error(`conversation probe ${name}: ${forged.stderr}`);
  return { archive: signed, source, grants, transcript, limits, case: testCase, refusedAtBuild: build.stderr.trim() };
}

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");

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
const reviewMemoryTools = ["scholarly-search", "paper-reader", "citation-resolver", "research.profile", "agent-notes.read", "agent-notes.write"];
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
    // memory.v0 (T20): the two packages that use it, and the probe that uses every permission.
    { id: "webair-0.6.0/fixture", title: "WebAir 0.6.0 (the travel profile from memory, a remember step after a quote; T20), its fixture input, the search tools approved: the empty proposals document", argv: fixtureRun(DIST("webair-0.6.0.agent.pkg"), EXAMPLES("webair-0.6.0-grants.json"), ["search-flights", "get-fare-rules"]), memory: true },
    ...scenarios.map((scenario) => ({
      id: `webair-0.6.0/scenario-${scenario.id}`,
      title: `WebAir 0.6.0, scenario ${scenario.id}`,
      argv: fixtureRun(DIST("webair-0.6.0.agent.pkg"), EXAMPLES("webair-0.6.0-grants.json"), ["search-flights", "get-fare-rules"], ["--input", writeInput(`scenario-060-${scenario.id}.json`, JSON.stringify(scenario.input))]),
      memory: true,
    })),
    { id: "literature-review-0.2.8/fixture", title: "Literature Review 0.2.8, its fixture input (memory off): 0.2.7's review and an empty proposals document", argv: fixtureRun(DIST("literature-review-0.2.8.agent.pkg"), EXAMPLES("literature-review-0.2.8-grants.json"), reviewMemoryTools), allowTokens: true, memory: true },
    { id: "literature-review-0.2.8/memory", title: "Literature Review 0.2.8 with its memory switches on: the replayed research profile shapes the plan, the notes are read and staged, one research.review is proposed derived from the profile (grants from the fixture's views, D-230)", argv: fixtureRun(DIST("literature-review-0.2.8.agent.pkg"), EXAMPLES("literature-review-0.2.8-grants.json"), reviewMemoryTools, ["--input", EXAMPLES("literature-review-0.2.8-memory-input.json")]), allowTokens: true, memory: true },
    // compute.v0 in shipped packages (T22): WebAir 0.7.0 recomputes every fare total WebAir states in
    // its fares module; Literature Review 0.2.9 deduplicates its candidates in its bookkeeping module.
    { id: "webair-0.7.0/fixture", title: "WebAir 0.7.0 (fare totals verified by the fares module, T22), its fixture input, the search tools approved", argv: fixtureRun(DIST("webair-0.7.0.agent.pkg"), EXAMPLES("webair-0.7.0-grants.json"), ["search-flights", "get-fare-rules"]), requires: "0.5.0" },
    ...scenarios.map((scenario) => ({
      id: `webair-0.7.0/scenario-${scenario.id}`,
      title: `WebAir 0.7.0, scenario ${scenario.id}`,
      argv: fixtureRun(DIST("webair-0.7.0.agent.pkg"), EXAMPLES("webair-0.7.0-grants.json"), ["search-flights", "get-fare-rules"], ["--input", writeInput(`scenario-070-${scenario.id}.json`, JSON.stringify(scenario.input))]),
      requires: "0.5.0",
    })),
    { id: "literature-review-0.2.9/fixture", title: "Literature Review 0.2.9 (deduplication in the bookkeeping module, T22), its fixture input (memory off)", argv: fixtureRun(DIST("literature-review-0.2.9.agent.pkg"), EXAMPLES("literature-review-0.2.9-grants.json"), reviewMemoryTools), allowTokens: true, requires: "0.5.0" },
    { id: "literature-review-0.2.9/memory", title: "Literature Review 0.2.9 with its memory switches on (0.2.8's memory behaviour, the module's deduplication)", argv: fixtureRun(DIST("literature-review-0.2.9.agent.pkg"), EXAMPLES("literature-review-0.2.9-grants.json"), reviewMemoryTools, ["--input", EXAMPLES("literature-review-0.2.8-memory-input.json")]), allowTokens: true, requires: "0.5.0" },
    { id: "memory-probe/granted-sealed-value", title: "M-36 and D-230: the probe's replayed legacy identity e-mail sent to a tool that links the permission it was granted under (in fixture mode the replayed answer is held as granted under its tool's permission)", argv: fixtureRun(inputs.memory["m36-granted-sealed-value"].archive, inputs.memory["m36-granted-sealed-value"].grants, inputs.memory["m36-granted-sealed-value"].tools, ["--trust-key", inputs.throwawayKey]), memory: true },
    { id: "memory-probe/custom-type-proposal", title: "M-18 and D-228: the probe proposes its own custom type by its local id (the only form the proposals schema admits); the host resolves it through the package's aliases", argv: fixtureRun(inputs.memory["custom-type-proposal"].archive, inputs.memory["custom-type-proposal"].grants, inputs.memory["custom-type-proposal"].tools, ["--trust-key", inputs.throwawayKey]), memory: true },
    { id: "memory-probe/custom-type-read", title: "M-12, M-18 and D-228: a memory.read of the probe's own custom type by its local id, granted from the replayed view, and an update of the record it read", argv: fixtureRun(inputs.memory["custom-type-read"].archive, inputs.memory["custom-type-read"].grants, inputs.memory["custom-type-read"].tools, ["--trust-key", inputs.throwawayKey]), memory: true },
    { id: "memory-probe/fixture", title: "The memory probe (every memory.v0 permission: a record view, a legacy identity, the agent document, a create and an update proposal, a sealed value sent where its grant goes; throwaway key)", argv: fixtureRun(inputs.memory.fixture.archive, inputs.memory.fixture.grants, inputs.memory.fixture.tools, ["--trust-key", inputs.throwawayKey]), memory: true },
    { id: "answer-checks/fixture", title: "Answer checks that hold (D-150): Meeting Agenda rebuilt with a relation, a sum and an equality on its model answers, runtime minimum 0.3.0 (throwaway key)", argv: fixtureRun(inputs.answerChecks, EXAMPLES("meeting-agenda-grants.json"), [], ["--trust-key", inputs.throwawayKey]) },
    // compute.v0 (T21, T22; C-51): the model-free test package over the two example modules, and the
    // two control cases of the enforcement list. `requires` keeps the pending rule for a Chrome core
    // whose gate is below 0.5.0 (an older checkout under CONFORMANCE_CHROME).
    { id: "compute-test/fixture", title: "Compute Test 0.1.0 (compute.v0, T21): fare totals (AssemblyScript) and bookkeeping (Rust) modules in one wave and in a map step, the modules run for real in fixture mode", argv: fixtureRun(EXAMPLES("compute/compute-test.agent.pkg"), EXAMPLES("compute/compute-test-grants.json"), []), requires: "0.5.0" },
    { id: "compute/echo", title: "Control: the smallest conforming module answers its input (throwaway key)", argv: fixtureRun(inputs.compute.echo.archive, inputs.compute.echo.grants, [], ["--trust-key", inputs.throwawayKey]), requires: "0.5.0" },
    { id: "compute/with-start", title: "Control: a start function is allowed and runs inside the call (C-17; throwaway key)", argv: fixtureRun(inputs.compute["with-start"].archive, inputs.compute["with-start"].grants, [], ["--trust-key", inputs.throwawayKey]), requires: "0.5.0" },
  ];
  return [...cases.map((testCase) => ({ ...testCase, kind: "fixture parity", run: () => runPositive(testCase) })), ...networkPositiveCases(fixtureRun), ...conversationCases()];
}

/**
 * network.v0 (T26): the signed test package's fixture walk, the shipped travel network's full tour,
 * and the probe's control cases (spec/network-v0.md §7: the walks that complete), each compared by
 * the fixture-parity rules. Every case carries `requires: 0.7.0`.
 */
function networkPositiveCases(fixtureRun) {
  const probe = (name) => inputs.network[name];
  const cases = [
    { id: "network-test/fixture", title: "Network Test 0.1.0 (network.v0, T25): the help desk's fixture walk Desk, Lookup, Desk, Writer, Desk, done, within the envelope", argv: fixtureRun(EXAMPLES("network/network-test.agent.pkg"), EXAMPLES("network/network-test-grants.json"), ["lookup"], ["--trust-key", EXAMPLES("keys/network-test-publisher.pub.pem")]) },
    { id: "travel-network/fixture", title: "Travel Network 0.1.0 (network.v0, T26): the front man consults flights, hotel and calendar once each, the full tour that attains the envelope", argv: fixtureRun(TRAVEL_NETWORK.archive, EXAMPLES("network/travel-network-grants.json"), ["search-flights", "search-hotels", "check-calendar"], ["--trust-key", TRAVEL_NETWORK.key]) },
    ...NETWORK_CASES.filter((testCase) => testCase.code === "completed").map((testCase) => ({
      id: `network/${testCase.id}`,
      title: `${testCase.title} (network.v0 §7, throwaway key)`,
      argv: fixtureRun(probe(testCase.id).archive, probe(testCase.id).grants, ["lookup"], ["--trust-key", inputs.throwawayKey]),
    })),
  ];
  return cases.map((testCase) => ({ ...testCase, kind: "fixture parity", requires: "0.7.0", run: () => runPositive(testCase) }));
}

/**
 * conversation.v0 (T24, B-232; D-263): a conversation replayed from a transcript on both CLIs
 * (`converse`), compared by the transcript without ids and times, the state, the usage, the
 * provenance, one audit chain across the turns and every turn's files. The test package's own
 * fixture transcript, then every case of spec/conversation-v0.md §10 that runs: a case that
 * completes (the controls, a refused turn at the bound, V-30) exits 0 in both, a case whose turn
 * fails exits 1 in both with the same transcript; the validation and start cases are refusals of
 * `converse` (and `run`, for `run-refused`) with identical messages; `host-refused` compares the
 * two execution layers. Every case carries `requires: 0.6.0`.
 */
function conversationCases() {
  const converse = (archive, grants, extra = []) => ["converse", archive, "--mode", "fixture", "--grants", grants, "--out", "{out}", ...extra];
  const probe = (name) => inputs.conversation[name];
  const probeArgs = (name) => {
    const item = probe(name);
    return converse(item.archive, item.grants, ["--approve-tool", "place", "--trust-key", inputs.throwawayKey, ...(item.transcript ? ["--transcript", item.transcript] : []), ...(item.limits ? ["--limits", item.limits] : [])]);
  };
  const cases = [
    {
      id: "conversation-test/fixture",
      title: "Conversation Test 0.1.0 (conversation.v0, T23): the ticket desk's fixture transcript, an order confirmed then goodbye; one chain across two turns",
      argv: converse(EXAMPLES("conversation/conversation-test.agent.pkg"), EXAMPLES("conversation/conversation-test-grants.json"), ["--approve-tool", "place-order", "--trust-key", EXAMPLES("keys/conversation-test-publisher.pub.pem")]),
      exit: 0,
    },
    // WebAir 0.8.0 (T24, D-274): its signed conversation fixture (search, refine, goodbye), then each
    // conversation of the publisher's fixture family as a transcript (searches only; the quote and
    // purchase conversations need the demo host's data and are the demo's tests).
    ...webair080Conversations().map(({ id, transcript }) => ({
      id: `webair-0.8.0/${id === "fixture" ? "fixture" : `conversation-${id}`}`,
      title: `WebAir 0.8.0 (conversation.v0, T24), ${id === "fixture" ? "its fixture transcript" : `the fixture conversation ${id}`}, the search tools approved`,
      argv: converse(DIST("webair-0.8.0.agent.pkg"), EXAMPLES("webair-0.8.0-grants.json"), ["--approve-tool", "search-flights", "--approve-tool", "get-fare-rules", "--trust-key", EXAMPLES("keys/webair-publisher.pub.pem"), ...(id === "fixture" ? [] : ["--transcript", transcript])]),
      exit: 0,
    })),
  ];
  for (const testCase of CONVERSATION_CASES) {
    if (testCase.host) continue;
    const name = testCase.id;
    const title = `${testCase.title} (conversation.v0 §10, ${testCase.stage})`;
    if (testCase.stage === "turn" || testCase.stage === "run") {
      // A turn refused at the bound is the bound at work (V-30): the conversation completes; a turn
      // that fails makes it `failed`, and `converse` exits 1 with the transcript written.
      cases.push({ id: `conversation/${name}`, title, argv: probeArgs(name), exit: testCase.stage === "turn" || testCase.code === "completed" ? 0 : 1 });
    }
  }
  return cases.map((testCase) => ({ ...testCase, kind: "conversation parity", requires: "0.6.0", run: () => runConverse(testCase) }));
}

/** WebAir 0.8.0's fixture family (`examples/webair-0.8.0-conversations.json`), each written as an input transcript. */
function webair080Conversations() {
  const family = JSON.parse(readFileSync(EXAMPLES("webair-0.8.0-conversations.json"), "utf8")).fixture;
  return family.map((conversation) => ({
    id: conversation.id,
    transcript: writeInput(`webair-080-${conversation.id}.transcript.json`, JSON.stringify({ schema: "conversation.transcript.v0", turns: conversation.turns.map((turn) => ({ message: turn.message, consents: turn.consents ?? {} })) })),
  }));
}

function runConverse(testCase) {
  const label = testCase.id.replace(/\W+/gu, "_");
  const python = invoke("python", testCase.argv, label);
  const node = invoke("node", testCase.argv, label);
  const checks = [];
  const check = (name, differences) => checks.push({ name, passed: differences.length === 0, detail: differences });
  check(`exit status ${testCase.exit} in both`, [python.status, node.status].every((status) => status === testCase.exit) ? [] : [`python ${python.status}: ${python.message ?? ""}`, `node ${node.status}: ${node.message ?? ""}`]);
  if (python.report && node.report) {
    const strip = ({ output_directory: _o, conversation_id: _c, ended, ...rest }) => ({ ...rest, ended: ended ? { ...ended, at: "<at>" } : ended });
    check("report (minus the directory, the id and the instant)", diff(strip(python.report), strip(node.report)));
  } else check("report printed in both", [`python ${python.report !== null}`, `node ${node.report !== null}`]);
  const compared = compareConversation(python.files, node.files);
  checks.push(...compared.checks);
  const halves = { python: python.status === testCase.exit && python.report !== null && "transcript.json" in python.files, chromeVersionRefused: versionRefused(node) };
  return { checks, notes: [], halves, observed: { python: summary(python), node: summary(node) } };
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
  if (testCase.allowTokens) notes.push(`Allowlisted (D-063), printed: synthetic tokens python=${compared.tokens?.python ?? null} node=${compared.tokens?.node ?? null}.`);
  // For the pending rule (D-234): the Python half on its own, and whether Chrome refused by version.
  const halves = { python: python.status === 0 && python.report !== null && "result.json" in python.files, chromeVersionRefused: versionRefused(node) };
  return { checks, notes, halves, observed: { python: summary(python), node: summary(node) } };
}

/**
 * The Chrome CLI's refusal of a package it is too old for: by version, or, for a package that ships
 * a WebAssembly module, at the container's member rule for that `.wasm` member, which an older
 * runtime reaches before the version check (compute.v0 C-10 states this limit; the pending rule
 * treats both as "too old"). The member rule refusing any other file is a failure, not "too old".
 */
const versionRefused = (observation) => observation.status === 2 && (/^manifest runtime\.minimum_version exceeds reference runtime /u.test(observation.message ?? "") || /^[^:]+\.wasm: only declared UTF-8 data formats allowed, never executable payloads$/u.test(observation.message ?? ""));

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
    ...memoryNegativeCases(cli, run),
    ...computeNegativeCases(cli, run, documented),
    ...conversationNegativeCases(cli, run, documented),
    ...networkNegativeCases(cli, run, documented),
    documented(
      "once-overused",
      "The model permission granted once, to a graph that calls the model more than once",
      run(DIST("meeting-agenda.agent.pkg"), inputs.agendaModelOnce, []),
      { python: { code: "permission_denied", node: "perspectives" }, node: { message: /^Permission 'model\.reasoning' was granted 'once', but this workflow would use it up to \d+ times\./u } },
      { archive: DIST("meeting-agenda.agent.pkg"), grants: inputs.agendaModelOnce, code: "execution_grant_unsupported" },
    ),
  ];
}

/** The negative cases of spec/memory-v0.md §10 (M-64) both runtimes must refuse identically. */
function memoryNegativeCases(cli, run) {
  const probe = (name) => inputs.memory[name];
  const runProbe = (name, extra = []) => {
    const item = probe(name);
    return run(item.archive ?? item.source, item.grants, [...approve(item.tools), "--trust-key", inputs.throwawayKey, ...extra]);
  };
  const workflow = (code, node = null) => ({ code, ...(node ? { node } : {}), artifacts: true });
  const refused = (code) => ({ code, message: new RegExp(`^${code}: `, "u") });
  const deniedProfile = writeInput("memory-profile-denied.json", JSON.stringify({ ...readJson(probe("fixture").grants), "memory.profile": "deny" }));
  const cases = [
    ["n1-type-undeclared", "N1: a proposal of a type outside memory.write's resources", workflow("permission_denied")],
    ["n2-sealed-field", "N2: a proposal carrying a sealed field", workflow("schema_validation")],
    ["n4-agent-write-over-cap", "N4: an agent write over 32,768 characters fails the tool's input schema", workflow("schema_validation", "notes-write")],
    ["n5-newer-runtime", "N5: a package whose runtime minimum is newer than the runtime is refused by version before anything runs", { code: "runtime_too_old", message: /^manifest runtime\.minimum_version exceeds reference runtime \d+\.\d+\.\d+$/u, ownVersion: true }],
    ["n6-view-mismatch", "N6: a memory.read tool whose output schema is not the type's record view is not bound", refused("binding_schema_mismatch")],
    ["n7-two-agent-writes", "N7: a second agent write in one run is over its max_calls_per_tool of 1", workflow("budget_exhausted", "notes-write-again")],
    ["n8-update-not-granted", "N8: an update whose target the run was not granted", workflow("permission_denied")],
    ["n9-link-to-no-proposal", "N9: a link #9 in a document of two proposals", workflow("schema_validation")],
    ["n10-publisher-scoped", "N10: memory.scope publisher-scoped stays refused", refused("agent_memory_scope")],
    // The refused model step runs in a wave beside the probe's echo: how far the sibling got is the
    // scheduler's (D-092), so the artifacts are compared as a failure inside a concurrent wave.
    ["n11-sealed-value-to-a-model", "N11: a graph that routes a sealed value into a model step: the model call is refused before anything leaves", { code: "permission_denied", node: "remember", artifacts: "race" }],
    ["n12-write-without-export", "N12: memory.write declared without the proposals.json export", refused("memory_proposal_undeclared")],
    ["n13-sealed-value-in-a-proposal", "N13: a proposal whose unsealed field holds a sealed value the run holds; no proposals.json is written", workflow("permission_denied")],
    ["n14-link-not-granted", "N14: a proposal link to a record id the run was not granted", workflow("permission_denied")],
    ["n14-body-link-not-granted", "N14 (body): the same as an id wikilink in the proposal's body", workflow("permission_denied")],
    ["n15-supersedes-link", "N15: a proposal link with rel supersedes fails the proposals schema", workflow("schema_validation")],
    ["n16-custom-type-shadows-sealed", "N16: a custom type with a nested property named like a sealed starter field", refused("custom_type_shadows_sealed_type")],
    ["n17-custom-type-reserved", "N17: a custom type whose local id is a well-known id", refused("custom_type_reserved")],
    ["agent-family-read", "M-38: a memory.read naming a type of the agent. family (its binding would be a reserved agent tool's name)", refused("memory_type_reserved")],
    ["n19-lower-index-first", "N19: two refusable proposals, index 0's link before index 1's type: proposal by proposal", workflow("permission_denied")],
    ["n21-custom-type-open", "N21: a custom type whose schema is not closed", refused("custom_type_schema_open")],
    ["n22-marker-line", "N22: a proposal body holding the mirror marker as a whole line fails the proposals schema", workflow("schema_validation")],
    ["m36-sealed-value-to-a-tool", "M-36: a granted sealed value sent to a tool that does not link its permission", workflow("permission_denied", "echo")],
    ["m36-two-sealed-values", "M-36: the echo carries the e-mail granted under the permission it links (the first hit) and a card token granted under another: every value is checked, so the card refuses it", workflow("permission_denied", "echo")],
  ];
  return [
    ...cases.map(([name, title, expectation]) => ({ ...cli(`memory/${name}`, title, [runProbe(name)], expectation), memory: true })),
    { ...cli("memory/n3-read-denied", "N3: a memory.read tool called under a denied permission stops at the mediator, before the tool", [run(probe("fixture").archive, deniedProfile, [...approve(probe("fixture").tools), "--trust-key", inputs.throwawayKey])], workflow("permission_denied", "profile")), memory: true },
  ];
}

/**
 * The negative cases of spec/compute-v0.md §10 (C-51, B-225) both runtimes must refuse identically:
 * container and validation refusals by their message, a preflight refusal by each CLI's own stage
 * (D-091: `agentpkg run` refuses in the runtime's preflight, the Chrome CLI in its execution layer,
 * and the two execution layers are compared directly), run failures by the node's code and the
 * audit's `compute.failed` facts (C-46; the normalizer folds the two engine differences D-244 states).
 */
function computeNegativeCases(cli, run, documented) {
  const probe = (name) => inputs.compute[name];
  const runProbe = (name) => run(probe(name).archive, probe(name).grants, ["--trust-key", inputs.throwawayKey]);
  const cases = [];
  for (const testCase of COMPUTE_CASES) {
    const name = testCase.id;
    if (name === "engine-unavailable" || testCase.code === "completed") continue;
    const title = `${testCase.title} (compute.v0 §10, ${testCase.stage})`;
    if (testCase.stage === "container") {
      const message = name === "tampered-archive" ? /^content integrity mismatch: missing=\[\], extra=\[\], changed=\['modules\/echo\.wasm'\]$/u : new RegExp(escapeRegExp(testCase.message), "u");
      cases.push({ ...cli(`compute/${name}`, title, [runProbe(name)], { code: testCase.code, message }), requires: "0.5.0" });
    } else if (testCase.stage === "validation") {
      cases.push({ ...cli(`compute/${name}`, title, [runProbe(name)], { code: testCase.code, message: new RegExp(`^${testCase.code}: `, "u") }), requires: "0.5.0" });
    } else if (testCase.stage === "preflight") {
      cases.push({
        ...documented(
          `compute/${name}`,
          title,
          runProbe(name),
          { python: { message: new RegExp(`^${testCase.code}: `, "u") }, node: { message: /^Node compute runs module 'echo', whose declared memory maximum of 2048 pages is above this host's ceiling of 1024\./u } },
          { archive: probe(name).archive, grants: probe(name).grants, code: "execution_compute_limit_exceeded" },
        ),
        requires: "0.5.0",
      });
    } else if (name === "permission-denied") {
      // The compute permission denied: `agentpkg run` stops at the mediator, the Chrome CLI's execution layer before the run (as denied-permission/required).
      cases.push({
        ...documented(`compute/${name}`, title, runProbe(name), { python: { code: "permission_denied", node: "compute" }, node: { message: /^Required permission 'compute\.modules' is denied, so this package cannot run\.$/u } }, { archive: probe(name).archive, grants: probe(name).grants, code: "execution_permission_denied" }),
        requires: "0.5.0",
      });
    } else {
      cases.push({ ...cli(`compute/${name}`, title, [runProbe(name)], { code: testCase.code, node: "compute", artifacts: true }), requires: "0.5.0" });
    }
  }
  return cases;
}

/**
 * The refusals of spec/conversation-v0.md §10 both CLIs make before a conversation starts: the
 * validation cases (`converse` refuses to load the package, identical message), the start cases
 * (the transcript against the package and the plan's grants, identical message; `run-refused` is
 * `run` on a conversational package), and `host-refused`, which compares the execution layers.
 */
function conversationNegativeCases(cli, run, documented) {
  const probe = (name) => inputs.conversation[name];
  const converse = (name) => {
    const item = probe(name);
    return ["converse", item.archive, "--mode", "fixture", "--grants", item.grants, "--out", "{out}", "--approve-tool", "place", "--trust-key", inputs.throwawayKey, ...(item.transcript ? ["--transcript", item.transcript] : [])];
  };
  const cases = [];
  for (const testCase of CONVERSATION_CASES) {
    const name = testCase.id;
    const title = `${testCase.title} (conversation.v0 §10, ${testCase.stage})`;
    if (testCase.stage === "validation" || (testCase.stage === "start" && testCase.path !== "run")) {
      cases.push({ ...cli(`conversation/${name}`, title, [converse(name)], { code: testCase.code, message: new RegExp(`^${testCase.code}: `, "u") }), requires: "0.6.0" });
    } else if (testCase.stage === "start" && testCase.path === "run") {
      const item = probe(name);
      cases.push({ ...cli(`conversation/${name}`, title, [run(item.archive, item.grants, ["--approve-tool", "place", "--trust-key", inputs.throwawayKey])], { code: testCase.code, message: new RegExp(`^${testCase.code}: `, "u") }), requires: "0.6.0" });
    } else if (testCase.stage === "host") {
      const item = probe(name);
      // The one-shot execution host refuses a conversational package before anything runs (V-28);
      // `agentpkg run` and the Chrome CLI's `run` refuse it earlier, by the profile.
      cases.push({
        ...documented(`conversation/${name}`, title, run(item.archive, item.grants, ["--approve-tool", "place", "--trust-key", inputs.throwawayKey]), { python: { message: /^conversation_profile: /u }, node: { message: /^conversation_profile: /u } }, { archive: item.archive, grants: item.grants, code: "conversation_not_supported" }),
        requires: "0.6.0",
      });
    }
  }
  return cases;
}

/**
 * The negative cases of spec/network-v0.md §7 both runtimes must refuse identically: validation by
 * the message (the code first), run failures by the node's code and the compared artifacts (the
 * audit's `route.decided`, `network.*` and `model.failed` facts included), the `once` rule by each
 * CLI's own stage (D-091) with the execution layers compared, and the host's output-cap check by the
 * execution layers alone (`agentpkg run` applies no host ceiling). Last, the envelope both execution
 * layers record for the signed test package under the default host limits.
 */
function networkNegativeCases(cli, run, documented) {
  const probe = (name) => inputs.network[name];
  const runProbe = (name) => run(probe(name).archive, probe(name).grants, ["--approve-tool", "lookup", "--trust-key", inputs.throwawayKey]);
  const cases = [];
  for (const testCase of NETWORK_CASES) {
    const name = testCase.id;
    if (testCase.code === "completed") continue;
    const title = `${testCase.title} (network.v0 §7, ${testCase.stage})`;
    if (testCase.stage === "validation") {
      cases.push({ ...cli(`network/${name}`, title, [runProbe(name)], { code: testCase.code, message: new RegExp(`^${testCase.code}: `, "u") }), requires: "0.7.0" });
    } else if (testCase.stage === "grants") {
      const permission = Object.keys(testCase.grants)[0];
      cases.push({
        ...documented(`network/${name}`, title, runProbe(name), { python: { code: "permission_denied", node: "delegate" }, node: { message: new RegExp(`^Permission '${escapeRegExp(permission)}' was granted 'once', but this workflow would use it up to \\d+ times\\.`, "u") } }, { archive: probe(name).archive, grants: probe(name).grants, code: testCase.code }),
        requires: "0.7.0",
      });
    } else if (testCase.stage === "host") {
      cases.push({ id: `network/${name}`, title, kind: "execution-layer parity", requires: "0.7.0", run: () => runLayers(probe(name).archive, probe(name).grants, { outcome: "refused", code: testCase.code }) });
    } else {
      cases.push({ ...cli(`network/${name}`, title, [runProbe(name)], { code: testCase.code, node: testCase.expect?.node ?? "delegate", artifacts: true }), requires: "0.7.0" });
    }
  }
  cases.push({
    id: "network/execution-layer-envelope",
    title: "The envelope both execution layers record for Network Test 0.1.0 under the default host limits (R-24): every figure equal",
    kind: "execution-layer parity",
    requires: "0.7.0",
    run: () => runLayers(EXAMPLES("network/network-test.agent.pkg"), EXAMPLES("network/network-test-grants.json"), { outcome: "accepted" }),
  });
  return cases;
}

/** The two execution layers asked the same question (`drivers/execution_policy.py`, `execution-policy.ts`); their whole answers compared. */
function runLayers(archive, grants, expected) {
  const checks = [];
  const check = (name, differences) => checks.push({ name, passed: differences.length === 0, detail: differences });
  const outcomes = [spawn(PYTHON, [join(ROOT, "conformance/drivers/execution_policy.py"), archive, grants]), spawn(process.execPath, [join(SCRATCH, "drivers", "execution-policy.js"), archive, grants])].map((result) => (result.status === 0 ? JSON.parse(result.stdout) : { outcome: "driver_failed", message: result.stderr.slice(-400) }));
  check(`execution layers: both ${expected.outcome}${expected.code ? ` ${expected.code}` : ""}`, outcomes.every((o) => o.outcome === expected.outcome && (!expected.code || o.code === expected.code)) ? [] : outcomes.map((o) => JSON.stringify(o).slice(0, 400)));
  check("execution layers: identical answers", diff(outcomes[0], outcomes[1]));
  const halves = { python: outcomes[0].outcome === expected.outcome, chromeVersionRefused: /exceeds reference runtime/u.test(outcomes[1].message ?? "") };
  return { checks, notes: [], halves, observed: { execution_layers: outcomes } };
}

function runNegative(commands, expectation, options) {
  const checks = [];
  const check = (name, differences) => checks.push({ name, passed: differences.length === 0, detail: differences });
  const observed = [];
  const notes = [...(options.notes ?? [])];
  const halves = { python: true, chromeVersionRefused: true };
  for (const [index, argv] of commands.entries()) {
    const label = `${argv[0]}-${index}`;
    const python = invoke("python", argv, label);
    const node = invoke("node", argv, label);
    const refusals = { python: refusalOf(python, expectation), node: refusalOf(node, expectation) };
    halves.python &&= python.status === 2 && python.report === null && refusals.python.code === expectation.code && (!expectation.node || refusals.python.node === expectation.node);
    halves.chromeVersionRefused &&= versionRefused(node);
    observed.push({ command: argv[0], python: { ...summary(python), ...refusals.python }, node: { ...summary(node), ...refusals.node } });
    check(`${argv[0]}: refused with status 2 in both`, [python, node].every((o) => o.status === 2 && o.report === null) ? [] : [`python ${python.status}`, `node ${node.status}`]);
    check(`${argv[0]}: refusal code ${expectation.code}`, ["python", "node"].filter((r) => refusals[r].code !== expectation.code).map((r) => `${r}: ${refusals[r].code} (${r === "python" ? python.message : node.message})`));
    if (expectation.node) check(`${argv[0]}: at node ${expectation.node}`, ["python", "node"].filter((r) => refusals[r].node !== expectation.node).map((r) => `${r}: ${refusals[r].node}`));
    if (expectation.ownVersion) {
      // A refusal that names the runtime's own version: identical up to that version, and each
      // runtime names its own (they differ between a reference bump and its Chrome port).
      const own = { python: agentpkgVersion(), node: chromeRuntimeVersion() };
      check(`${argv[0]}: each runtime names its own version`, ["python", "node"].filter((r) => !(r === "python" ? python : node).message?.endsWith(` ${own[r]}`)).map((r) => `${r}: ${(r === "python" ? python : node).message} (own version ${own[r]})`));
      check(`${argv[0]}: identical message up to the version`, python.message?.replace(own.python, "<v>") === node.message?.replace(own.node, "<v>") ? [] : [`python: ${python.message}`, `node: ${node.message}`]);
    } else {
      check(`${argv[0]}: identical message`, python.message === node.message ? [] : [`python: ${python.message}`, `node: ${node.message}`]);
    }
    if (expectation.artifacts === "race") {
      const compared = compareFailureRace(python.files, node.files);
      checks.push(...compared.checks.map((item) => ({ ...item, name: `${argv[0]}: ${item.name}` })));
      notes.push(`A failure inside a concurrent wave (D-092): siblings' partial progress is the scheduler's, so their events and reserved tokens are not compared; tokens python=${compared.tokens?.python ?? null} node=${compared.tokens?.node ?? null}.`);
    } else if (expectation.artifacts) {
      checks.push(...compareArtifacts(python.files, node.files).checks.map((item) => ({ ...item, name: `${argv[0]}: ${item.name}` })));
    } else {
      check(`${argv[0]}: nothing written`, Object.keys(python.files).length + Object.keys(node.files).length === 0 ? [] : ["files written"]);
    }
  }
  return { checks, notes, halves, observed };
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
  if (expected.python.message) {
    // A refusal before the run in the runtime's own preflight (compute.v0 C-31): nothing written.
    check("agentpkg run: refused before the run, nothing written", python.status === 2 && expected.python.message.test(python.message ?? "") && Object.keys(python.files).length === 0 ? [] : [`${python.status}: ${python.message}`]);
  } else {
    check("agentpkg run: refused at the first use", python.status === 2 && pyRefusal.code === expected.python.code && pyRefusal.node === expected.python.node && "result.json" in python.files ? [] : [`${python.status}: ${python.message}`]);
  }
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

// -- memory.v0 and the Chrome core's version -------------------------------------------------
/** The runtime version the built Chrome core accepts packages up to (`SUPPORTED_RUNTIME_VERSION`). */
let chromeVersion;
function chromeRuntimeVersion() {
  if (chromeVersion === undefined) {
    const source = readFileSync(join(CHROME_ROOT, "src/core/version.ts"), "utf8");
    chromeVersion = /SUPPORTED_RUNTIME_VERSION = "([^"]+)"/u.exec(source)?.[1] ?? "unknown";
  }
  return chromeVersion;
}
const release = (version) => version.split("-")[0].split(".").map(Number);
let pythonVersion;
function agentpkgVersion() {
  if (pythonVersion === undefined) {
    const source = readFileSync(join(ROOT, "agentpkg/src/agentpkg/__init__.py"), "utf8");
    pythonVersion = /__version__\s*=\s*"([^"]+)"/u.exec(source)?.[1] ?? "unknown";
  }
  return pythonVersion;
}
const olderThan = (version, than) => {
  const [a, b, c] = release(version);
  const [x, y, z] = release(than);
  return a !== x ? a < x : b !== y ? b < y : c < z;
};
/** The Chrome core refuses packages that need a newer reference than its gate (`requires`). */
const chromeLacks = (requires) => olderThan(chromeRuntimeVersion(), requires);

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
    chrome_core: `chrome-agent-browser ${readJson(join(CHROME_ROOT, "package.json")).version} (runtime ${chromeRuntimeVersion()})${process.env.CONFORMANCE_CHROME ? ` from ${CHROME_ROOT}` : ""}`,
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
    packages: Object.fromEntries(["webair-0.4.0.agent.pkg", "webair-0.5.0.agent.pkg", "webair-0.6.0.agent.pkg", "literature-review.agent.pkg", "literature-review-0.2.6.agent.pkg", "literature-review-0.2.7.agent.pkg", "literature-review-0.2.8.agent.pkg", "meeting-agenda.agent.pkg"].map((name) => [name, sha(DIST(name))])),
  };
}

function markdown(report) {
  const lines = [
    "# Conformance report",
    "",
    `Generated ${report.generated_at} at commit \`${report.environment.commit}\`${report.environment.dirty ? " (working tree had uncommitted changes)" : ""}.`,
    `${report.environment.agentpkg}; ${report.environment.python}; ${report.environment.chrome_core}; Node ${report.environment.node}; ${report.environment.platform}.`,
    "",
    `**${report.summary.passed} of ${report.summary.cases} cases passed** (${report.summary.checks_passed} of ${report.summary.checks} checks)${report.summary.pending.length ? `; ${report.summary.pending.length} pending: ${report.summary.pending_reason}` : ""}.`,
    "",
    "| Case | Kind | Result | Checks |",
    "|---|---|---|---|",
    ...report.cases.map((c) => `| \`${c.id}\` | ${c.kind} | ${c.passed ? "pass" : c.pending ? "pending" : "**FAIL**"} | ${c.checks.filter((k) => k.passed).length}/${c.checks.length} |`),
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
    // A memory.v0 case is pending, not failed, while the Chrome CLI refuses 0.4.0 packages by
    // version (T20, D-233), and only when that refusal is what failed it and the Python half
    // passed on its own (D-234): a Python regression, or a Chrome failure of any other kind,
    // fails the suite. Once Chrome accepts 0.4.0 packages, the case counts.
    // A case whose package needs a reference version the Chrome core's gate does not reach yet
    // (memory.v0 needs 0.4.0, compute.v0 0.5.0) is pending, not failed, and only when that
    // refusal is what failed it and the Python half passed on its own (D-234): a Python
    // regression, or a Chrome failure of any other kind, fails the suite.
    const requires = testCase.requires ?? (testCase.memory ? "0.4.0" : null);
    const pending = !passed && requires !== null && chromeLacks(requires) && outcome.halves?.python === true && outcome.halves?.chromeVersionRefused === true;
    results.push({ id: testCase.id, title: testCase.title, kind: testCase.kind, passed, pending, ...(requires ? { requires } : {}), seconds: (Date.now() - started) / 1000, ...outcome });
    process.stdout.write(`${passed ? "pass" : pending ? "PEND" : "FAIL"}  ${testCase.id}${pending ? " (Python half passed; Chrome refused by version)" : ""}\n`);
    for (const check of outcome.checks.filter((item) => !item.passed)) process.stdout.write(`      ✗ ${check.name}: ${check.detail.join("; ")}\n`);
    for (const note of outcome.notes) process.stdout.write(`      note: ${note}\n`);
  }
  const counted = results.filter((r) => !r.pending);
  const allChecks = counted.flatMap((r) => r.checks);
  const report = {
    schema: "webagents-conformance-report-v0",
    generated_at: new Date().toISOString(),
    environment: environment(),
    summary: { cases: results.length, passed: results.filter((r) => r.passed).length, failed: counted.filter((r) => !r.passed).map((r) => r.id), pending: results.filter((r) => r.pending).map((r) => r.id), pending_reason: results.some((r) => r.pending) ? `the Chrome core CLI (runtime ${chromeRuntimeVersion()}) refuses by version the packages that need a newer reference (${[...new Set(results.filter((r) => r.pending).map((r) => r.requires ?? (r.memory ? "0.4.0" : "?")))].sort().join(", ")})` : null, checks: allChecks.length, checks_passed: allChecks.filter((c) => c.passed).length, filtered: ONLY },
    cases: results,
    passed: counted.length > 0 && counted.every((r) => r.passed),
  };
  if (WRITE) {
    const out = option("--out") ?? join(ROOT, "conformance/results", report.generated_at.replace(/[:.]/gu, "-"));
    mkdirSync(out, { recursive: true });
    writeFileSync(join(out, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
    writeFileSync(join(out, "report.md"), markdown(report));
    process.stdout.write(`report: ${relative(process.cwd(), out) || out}\n`);
  }
  process.stdout.write(`${report.summary.passed}/${report.summary.cases} cases passed${report.summary.pending.length ? `, ${report.summary.pending.length} pending (${report.summary.pending_reason})` : ""}\n`);
  rmSync(SCRATCH, { recursive: true, force: true });
  process.exit(report.passed ? 0 : 1);
}

main().catch((error) => {
  process.stderr.write(`conformance: ${error?.stack ?? error}\n`);
  rmSync(SCRATCH, { recursive: true, force: true });
  process.exit(2);
});
