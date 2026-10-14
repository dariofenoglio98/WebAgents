/**
 * What a run holds about memory (§7, §9, §10): the scan set (M-36, M-37, M-62), the grants and
 * the types the proposals check needs (M-40), the agent document (M-50), and the facts the audit
 * and the Run Record carry (M-61). Built by the host before the run (the execution host from the
 * store, the CLI from a memory folder or the fixture) and handed to the runner as `SessionDeps.memory`.
 */
import { canonicalJson } from "../canonical.js";
import { sha256HexSync } from "../hash.js";
import type { JsonObject, JsonValue } from "../json.js";
import type { Package } from "../package.js";
import type { AgentMemoryContext } from "../tools/adapters/memory-agent.js";
import type { ResourceGrant } from "../types.js";
import { AGENT_RESOURCE, AGENT_SCOPE, memoryDeclarations, type MemoryDeclarations } from "./declarations.js";
import type { MemoryRecord } from "./model.js";
import { checkProposals, type ProposalCheckInput, ProposalRefusal, type ProposalsDocument } from "./proposals.js";
import { fixtureScanSet, type ScanSet } from "./scan.js";
import { TypeRegistry } from "./types.js";

/** `memory.proposed` (M-61) and the Run Record's `memory.proposals` summary. */
export interface ProposedFacts {
  count: number;
  types: string[];
  proposals_sha256: string;
  offered: number;
  reason: "permission_denied" | "policy" | "memory_full" | null;
}

export interface AgentOutcome {
  committed: { package_id: string; bytes: number; body_sha256: string } | null;
  discarded: "run_failed" | "cancelled" | "preset" | "policy" | null;
}

export interface MemoryRunReport {
  proposals: ProposedFacts | null;
  refused: { code: string; reason: string | null; index: number | null } | null;
  agent: AgentOutcome | null;
}

export interface MemoryRunOptions {
  types?: TypeRegistry;
  /** The run's scan set (M-36): the store's when opened with it, the fixture's (M-62), else empty. */
  scan?: ScanSet;
  /** The granted records by id, with their `sealed` additions and type (M-40 step 3). */
  targets?: ReadonlyMap<string, Pick<MemoryRecord, "sealed" | "type">>;
  /** The agent document as stored, when the plan binds the agent tools and the host persists it. */
  agentDocument?: { body: string; updated: string } | null;
  /** Why the agent document is not persisted: the preset or a policy (M-50); null when it is. */
  agentDiscard?: "preset" | "policy" | null;
  /** The subscribed policy refuses proposals (M-54), so none is offered. */
  policyRefusesProposals?: boolean;
  /** The store is full: proposals are checked and listed but not offered (M-47). */
  memoryFull?: boolean;
}

/** The per-run memory context the interpreter, the runtime and the broker read. */
export class MemoryRun {
  readonly declarations: MemoryDeclarations;
  readonly types: TypeRegistry;
  readonly scan: ScanSet;
  readonly granted: ReadonlyMap<string, string>;
  /** The plan's resource grants (record id, permission, type, digest), for M-36. */
  readonly grants: readonly ResourceGrant[];
  readonly agent: AgentMemoryContext | null;
  private readonly targets: ReadonlyMap<string, Pick<MemoryRecord, "sealed" | "type">>;
  private readonly writeDenied: boolean;
  private readonly options: MemoryRunOptions;

  constructor(
    readonly pkg: Package,
    grants: readonly ResourceGrant[],
    decisions: Readonly<Record<string, string>>,
    options: MemoryRunOptions = {},
  ) {
    this.declarations = memoryDeclarations(pkg.manifest, pkg.policy, pkg.tools, pkg.files);
    this.types = options.types ?? new TypeRegistry([...new TypeRegistry().toJSON(), ...this.declarations.custom_types]);
    this.scan = options.scan ?? [];
    this.options = options;
    const granted = new Map<string, string>();
    for (const grant of grants) {
      const type = this.types.resolve(grant.resource_type);
      granted.set(grant.resource_id, type?.id ?? grant.resource_type);
    }
    this.granted = granted;
    this.grants = grants;
    this.targets = options.targets ?? new Map();
    const write = this.declarations.write;
    this.writeDenied = write !== null && (decisions[write.permission_id] ?? "deny") === "deny";
    const agent = this.declarations.agent;
    const agentGranted = agent !== null && (decisions[agent.permission_id] ?? "deny") !== "deny" && String((pkg.policy.memory as JsonObject).scope) === AGENT_SCOPE;
    this.agent = agentGranted ? { package_id: String(pkg.manifest.package_id), stored: options.agentDiscard ? null : (options.agentDocument ?? null), staged: null } : null;
  }

  /** Whether the package declares a `memory.proposal` export. */
  get proposes(): boolean {
    return this.declarations.write !== null;
  }

  /** M-40 over the export's value; throws `ProposalRefusal`. Returns the facts of `memory.proposed`. */
  async checkProposals(value: JsonValue): Promise<{ document: ProposalsDocument; facts: ProposedFacts }> {
    const input: ProposalCheckInput = { declared: new Set(this.declarations.write?.types ?? []), granted: this.granted, targets: this.targets, types: this.types, scan: this.scan };
    const parsed = await checkProposals(value, input);
    const count = parsed.proposals.length;
    const types = [...new Set(parsed.proposals.map((proposal) => proposal.type))].sort();
    let reason: ProposedFacts["reason"] = null;
    if (this.writeDenied) reason = "permission_denied";
    else if (this.options.policyRefusesProposals) reason = "policy";
    else if (this.options.memoryFull) reason = "memory_full";
    return { document: parsed, facts: { count, types, proposals_sha256: sha256HexSync(canonicalJson(parsed as unknown as JsonValue)), offered: reason === null ? count : 0, reason } };
  }

  /** M-50: what happens to a staged body at the terminal event. */
  agentOutcome(status: "completed" | "failed" | "cancelled"): AgentOutcome | null {
    if (this.agent === null) return null;
    const staged = this.agent.staged;
    if (staged === null) return { committed: null, discarded: null };
    if (status !== "completed") return { committed: null, discarded: status === "cancelled" ? "cancelled" : "run_failed" };
    if (this.options.agentDiscard) return { committed: null, discarded: this.options.agentDiscard };
    return { committed: { package_id: this.agent.package_id, bytes: staged.bytes, body_sha256: sha256HexSync(new TextEncoder().encode(staged.body)) }, discarded: null };
  }

  /** The staged body to commit, when the outcome says so. */
  stagedBody(): string | null {
    return this.agent?.staged?.body ?? null;
  }
}

/**
 * M-62: the scan set of a fixture run without a store, from the package's fixture answers: the
 * views' `sealed` pointers and the legacy types' sealed pointers (through the taxonomy's aliases).
 */
export function fixtureMemoryScan(pkg: Package, fixture: JsonObject, types: TypeRegistry = new TypeRegistry()): ScanSet {
  const answers: Array<{ binding: string; output: JsonValue; legacySealed?: readonly string[] }> = [];
  for (const [toolId, cases] of Object.entries((fixture.tools as JsonObject | undefined) ?? {})) {
    const tool = pkg.tools[toolId];
    if (!tool || !Array.isArray(cases)) continue;
    const binding = String(tool.binding);
    const legacyId = binding.startsWith("host.resource.") ? binding.slice("host.resource.".length) : null;
    const legacy = legacyId === null ? undefined : types.legacyOf(legacyId);
    const legacySealed = legacy === undefined ? [] : Object.entries(legacy.alias.projection).filter(([, recordPointer]) => legacy.type.sealed_fields.includes(recordPointer)).map(([legacyPointer]) => legacyPointer);
    for (const item of cases as JsonObject[]) answers.push({ binding, output: item.output ?? null, legacySealed });
  }
  return fixtureScanSet(answers);
}

export { AGENT_RESOURCE, ProposalRefusal };
