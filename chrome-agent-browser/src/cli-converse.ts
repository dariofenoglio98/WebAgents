/**
 * `converse` (conversation.v0, D-263): one conversation of a conversational package from a
 * transcript, the way `agentpkg converse` runs it, through the Chrome core's own conversation
 * runner, with agentpkg's flag names, directory layout and report shape so the two runtimes can
 * be compared side by side (the conformance suite's `converse` family, B-232).
 *
 *   converse <package.agent.pkg> [--transcript F] --mode fixture|live --grants F
 *            [--approve-tool ID]... [--trust-key PEM] [--limits F] --out DIR
 *            live: --model provider/model [--ollama-url URL] [--context-tokens N] [--think]
 *                  [--reasoning-effort low|medium|high] [--tool-bindings F] [--host-resources F]
 *                  [--resource-grant PERM=ID]...
 *
 * The operator is the host here: the grants are the plan's decisions for the whole conversation,
 * the transcript's consent decisions stand for the person's, and each turn's adapters are the ones
 * `run` would build (the fixture's replay, or the live router and the host's generic tool handlers
 * over the same bindings). Every turn's artifacts go to `turn-NNN/` under `--out` as the turn
 * ends; the conversation's transcript, state, one audit chain, usage and provenance are written
 * last. Live mode also writes each turn's `run.json`? No: as `agentpkg converse`, the turn
 * directories hold the interpreter's files; the Run Record is the extension's.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { parseArguments, type ArgumentSpec } from "./cli-arguments.js";
import { nodeComputeEngine } from "./cli-compute.js";
import { bindLive, jsonFile, prepareOutput, RUN_OPTIONS } from "./cli-run.js";
import { Conversation, fixtureTranscript, type TurnAdapters } from "./core/conversation/runner.js";
import { checkTranscript, readInputTranscript, type TranscriptInput } from "./core/conversation/transcript.js";
import { AgentPkgError } from "./core/errors.js";
import { artifactRecords } from "./core/execution/artifacts.js";
import { normalizeHostLimits, PERMISSIVE_HOST_LIMITS } from "./core/execution/limits.js";
import { fixtureAdapters } from "./core/fixtures.js";
import type { JsonObject } from "./core/json.js";
import { publicKeyFromPem } from "./core/keys.js";
import { checkMemoryBindings } from "./core/memory/run.js";
import { loadPackageBytes } from "./core/package.js";
import { pyJsonDumps } from "./core/pyjson.js";
import { verifyWithTrustedKey } from "./core/signature.js";
import { toolHandlers } from "./core/tools/broker.js";
import { checkApprovedTools, checkGrants, type Grants, type HostLimits } from "./core/workflow/runtime.js";

const CONVERSE: ArgumentSpec = { positional: ["package"], options: { ...RUN_OPTIONS, "--transcript": { kind: "value" } } };

function print(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

/** The directory's files, created exclusively, as `agentpkg converse` writes them (mode 0600). */
function writeFiles(directory: string, files: ReadonlyArray<readonly [string, Uint8Array]>): void {
  mkdirSync(directory, { mode: 0o700 });
  for (const [name, data] of files) writeFileSync(join(directory, name), data, { flag: "wx", mode: 0o600 });
}

const encode = (value: unknown): Uint8Array => new TextEncoder().encode(`${pyJsonDumps(value, { indent: 2 })}\n`);

export async function converseCommand(args: string[]): Promise<number> {
  const parsed = parseArguments("converse", args, CONVERSE);
  const mode = parsed.value("--mode") as "fixture" | "live";
  const bytes = new Uint8Array(readFileSync(parsed.positional.package!));
  const pkg = await loadPackageBytes(bytes);
  if (pkg.graph.conversation === undefined || pkg.graph.conversation === null) throw new AgentPkgError("conversation_profile_required: this package declares no conversation; use agentpkg run");
  const trustKey = parsed.value("--trust-key");
  if (mode === "live" && !trustKey) throw new AgentPkgError("Live run requires a signed artifact and --trust-key PUBLIC_KEY");
  if (trustKey) await verifyWithTrustedKey(pkg, publicKeyFromPem(readFileSync(trustKey, "utf8")));
  if (pkg.signature === null) throw new AgentPkgError("This runner executes signed packages only; sign the artifact first (agentpkg sign)");
  const transcriptPath = parsed.value("--transcript");
  let transcript: TranscriptInput;
  if (transcriptPath) transcript = await readInputTranscript(jsonFile(transcriptPath, "object"), transcriptPath);
  else {
    const declared = mode === "fixture" ? fixtureTranscript(pkg) : null;
    if (declared === null) throw new AgentPkgError("A conversation needs --transcript (in fixture mode the package's conversation fixture serves when it declares one)");
    transcript = declared;
  }
  const grants = jsonFile(parsed.value("--grants")!, "object") as Grants;
  // An approval of an undeclared tool is refused by the conversation's own check, as `agentpkg converse` (T24 review 1 nit 11).
  const approved = [...new Set(parsed.list("--approve-tool"))].sort();
  await checkTranscript(transcript, pkg, grants);
  // As `agentpkg converse`: `--limits` is the host's document, the conversation's keys beside the
  // turn's; without it the host lowers nothing.
  const limits = parsed.value("--limits") ? (jsonFile(parsed.value("--limits")!, "object") as JsonObject) : null;
  checkMemoryBindings(pkg);
  let adapters: (turn: number) => TurnAdapters;
  if (mode === "fixture") {
    for (const flag of ["--model", "--ollama-url", "--context-tokens", "--reasoning-effort", "--tool-bindings", "--host-resources"]) {
      if (parsed.value(flag) !== null) throw new AgentPkgError(`${flag} applies to --mode live only`);
    }
    if (parsed.flag("--think") || parsed.list("--resource-grant").length > 0) throw new AgentPkgError("--think and --resource-grant apply to --mode live only");
    const fixture = fixtureAdapters(pkg);
    adapters = () => ({ router: fixture.router, handlers: fixture.handlers });
  } else {
    const hostLimits = normalizeHostLimits(limits === null ? { ...PERMISSIVE_HOST_LIMITS } : Object.fromEntries(Object.entries(limits).filter(([key]) => !key.startsWith("conversation_"))));
    // The conversation's own checks, in its order, before binding contacts a model provider
    // (as the reference, which refuses before any network; T24 review 2 nit 5).
    checkGrants(new Set((pkg.policy.permissions as JsonObject[]).map((permission) => String(permission.id))), grants);
    checkApprovedTools(pkg.tools, approved);
    const live = await bindLive(pkg, parsed, bytes, grants, approved, hostLimits.model_call_timeout_seconds);
    const tools = live.deps.tools!;
    adapters = () => {
      // The same generic handlers the execution session installs for a run, over the bindings the
      // approvals froze, built afresh per turn (a handler's dispatch log is a turn's).
      const { handlers } = toolHandlers(live.toolBindings, { ...tools, resources: live.store ? { grants: live.resourceGrants, resolver: live.store } : null });
      return { router: live.deps.router ?? null, handlers };
    };
  }
  const engine = nodeComputeEngine();
  // The output directory is checked before anything runs and created only once the conversation
  // refused nothing about its host inputs (D-265): a refused grant or limit leaves no --out behind.
  const out = prepareOutput(parsed.value("--out")!);
  const conversation = new Conversation(pkg, {
    grants,
    approvedTools: approved,
    adapters: (turn) => ({ ...adapters(turn), compute: engine }),
    limits: (limits ?? null) as (HostLimits & Record<string, number>) | null,
    onTurn: (index, report, status) => {
      const records = artifactRecords(report as unknown as JsonObject, status === "completed" ? pkg : null);
      writeFiles(join(out, `turn-${String(index).padStart(3, "0")}`), records);
    },
  });
  mkdirSync(out, { mode: 0o700 });
  const onSignal = () => {
    process.stderr.write("agent-browser: cancelling the conversation\n");
    conversation.cancel();
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  let result;
  try {
    result = await conversation.run(transcript);
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  }
  const files: Array<readonly [string, Uint8Array]> = [
    ["transcript.json", encode(result.transcript)],
    ["state.json", encode(result.state)],
    ["audit.json", encode(result.audit)],
    ["usage.json", encode(result.usage)],
    ["provenance.json", encode(result.provenance)],
  ];
  for (const [name, data] of files) writeFileSync(join(out, name), data, { flag: "wx", mode: 0o600 });
  const usage = result.usage;
  print({
    status: result.status,
    profile: "conversation.v0",
    conversation_id: String(result.provenance.conversation_id),
    output_directory: out,
    turns: (result.transcript.turns as JsonObject[]).map((turn) => ({ turn: turn.turn, status: turn.status })),
    ended: result.ended,
    usage: { turns: usage.turns!, tokens: usage.tokens!, remote_calls: usage.remote_calls!, tool_calls: usage.tool_calls! },
    approved_tools: approved,
    fixture_replay: mode === "fixture",
    passed: result.status === "completed",
  });
  return result.status === "completed" ? 0 : 1;
}
