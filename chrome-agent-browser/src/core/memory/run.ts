/**
 * What a run holds about memory (§7, §9, §10): the scan set (M-36, M-37, M-62), the grants and
 * the types the proposals check needs (M-40), the agent document (M-50), and the facts the audit
 * and the Run Record carry (M-61). Built by the host before the run (the execution host from the
 * store, the CLI from a memory folder or the fixture) and handed to the runner as `SessionDeps.memory`.
 */
import { canonicalJson, canonicalString } from "../canonical.js";
import { ValidationError } from "../errors.js";
import { sha256HexSync } from "../hash.js";
import type { JsonObject, JsonValue } from "../json.js";
import { type Package, packageJson } from "../package.js";
import type { AgentMemoryContext } from "../tools/adapters/memory-agent.js";
import type { ResourceGrant } from "../types.js";
import { AGENT_RESOURCE, AGENT_SCOPE, memoryDeclarations, type MemoryDeclarations } from "./declarations.js";
import type { MemoryRecord } from "./model.js";
import { checkProposals, type ProposalCheckInput, ProposalRefusal, type ProposalsDocument } from "./proposals.js";
import { fixtureScanSet, type ScanSet } from "./scan.js";
import { recordViewSchema, TypeRegistry } from "./types.js";

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
    // A grant names a custom type by its local id (the permission's resource): resolved through
    // the package's own aliases, as M-40 resolves a proposal's type (D-228, D-234).
    const aliases = customTypeAliases(String(pkg.manifest.package_id), this.declarations.custom_types);
    const granted = new Map<string, string>();
    for (const grant of grants) {
      const type = this.types.resolve(aliases.get(grant.resource_type) ?? grant.resource_type);
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
    const input: ProposalCheckInput = { declared: new Set(this.declarations.write?.types ?? []), granted: this.granted, targets: this.targets, types: this.types, scan: this.scan, aliases: customTypeAliases(String(this.pkg.manifest.package_id), this.declarations.custom_types) };
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

/**
 * D-230: what a fixture run without a store holds, as `agentpkg run` derives it: the scan set
 * (M-62), the grants and the targets. Each replayed `host.memory.<type>` view grants its `id`
 * under its tool's one permission, and each replayed `host.resource.<legacy id>` answer grants the
 * pseudo-record `fixture:<binding>` under its tool's permission, unless that permission is denied,
 * so that a package's own fixture can propose an update of, or link to, the record it read, and a
 * legacy value may go where its permission is linked (M-36). A pseudo-record has no digest.
 */
export function fixtureMemory(
  pkg: Package,
  fixture: JsonObject,
  decisions: Readonly<Record<string, string>>,
  types: TypeRegistry = new TypeRegistry(),
): { scan: ScanSet; grants: ResourceGrant[]; targets: Map<string, Pick<MemoryRecord, "sealed" | "type">> } {
  const grants: ResourceGrant[] = [];
  const add = (grant: ResourceGrant) => {
    if (!grants.some((item) => item.permission_id === grant.permission_id && item.resource_type === grant.resource_type && item.resource_id === grant.resource_id)) grants.push(grant);
  };
  for (const [toolId, cases] of Object.entries((fixture.tools as JsonObject | undefined) ?? {})) {
    const tool = pkg.tools[toolId];
    if (!tool || !Array.isArray(cases)) continue;
    const binding = String(tool.binding ?? "");
    const permissions = (tool.permissions as string[] | undefined) ?? [];
    const allowed = permissions.length === 1 && (decisions[permissions[0]!] ?? "deny") !== "deny";
    if (!allowed) continue;
    if (binding.startsWith("host.resource.")) {
      if (cases.length > 0) add({ permission_id: permissions[0]!, resource_type: binding.slice("host.resource.".length), resource_id: `fixture:${binding}`, resource_digest: "" });
    } else if (binding.startsWith("host.memory.") && !binding.startsWith("host.memory.agent.")) {
      for (const item of cases as JsonObject[]) {
        const output = item.output;
        if (typeof output === "object" && output !== null && !Array.isArray(output) && typeof output.id === "string") {
          add({ permission_id: permissions[0]!, resource_type: binding.slice("host.memory.".length), resource_id: output.id, resource_digest: "" });
        }
      }
    }
  }
  const targets = new Map<string, Pick<MemoryRecord, "sealed" | "type">>();
  for (const cases of Object.values((fixture.tools as JsonObject | undefined) ?? {})) {
    for (const item of Array.isArray(cases) ? (cases as JsonObject[]) : []) {
      const output = item.output;
      if (typeof output !== "object" || output === null || Array.isArray(output) || typeof output.id !== "string") continue;
      if (grants.some((grant) => grant.resource_id === output.id)) {
        targets.set(output.id, { sealed: Array.isArray(output.sealed) ? (output.sealed as string[]) : [], type: output.type as string });
      }
    }
  }
  return { scan: fixtureMemoryScan(pkg, fixture, types), grants, targets };
}

/**
 * M-16, as `agentpkg run` checks it before a run (`check_memory_bindings`, M-64 N6): a
 * `host.memory.<type>` tool is bound only when its output schema canonicalizes to the view the
 * host builds from its own type (`binding_schema_mismatch`); a type the host does not hold is
 * `memory_type_unknown`. A custom type is named by its local id.
 */
export function checkMemoryBindings(pkg: Package, types?: TypeRegistry): void {
  const declarations = memoryDeclarations(pkg.manifest, pkg.policy, pkg.tools, pkg.files);
  const registry = types ?? new TypeRegistry([...new TypeRegistry().toJSON(), ...declarations.custom_types]);
  const aliases = customTypeAliases(String(pkg.manifest.package_id), declarations.custom_types);
  for (const [toolId, tool] of Object.entries(pkg.tools)) {
    const binding = String(tool.binding ?? "");
    if (!binding.startsWith("host.memory.") || binding.startsWith("host.memory.agent.")) continue;
    const typeId = binding.slice("host.memory.".length);
    const type = registry.get(aliases.get(typeId) ?? typeId);
    if (type === undefined) throw new ValidationError(`memory_type_unknown: tool ${toolId} reads ${typeId}, which this host does not hold`);
    const output = packageJson(pkg, String(tool.output_schema));
    if (canonicalString(output) !== canonicalString(recordViewSchema(type))) {
      throw new ValidationError(`binding_schema_mismatch: tool ${toolId}: the output schema is not the record view of ${typeId}`);
    }
  }
}

export { AGENT_RESOURCE, ProposalRefusal };

/** The package's custom types by their local id (§4.4): what `proposals.json` names them by. */
export function customTypeAliases(packageId: string, custom: readonly { id: string }[]): Map<string, string> {
  const prefix = `${packageId}:`;
  return new Map(custom.filter((type) => type.id.startsWith(prefix)).map((type) => [type.id.slice(prefix.length), type.id] as const));
}
