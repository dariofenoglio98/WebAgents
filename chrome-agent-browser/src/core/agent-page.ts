/**
 * The agent-page model (D-034): what a person sees first about one inspected package, as
 * data. The shell renders it; nothing here touches a DOM.
 *
 * Order and wording follow D-034: identity; publisher and trust **in words**; what it does;
 * what it will be able to access, grouped by permission kind in plain words; profiles when the
 * manifest declares them; where it came from; declared cost or "not stated". Then the
 * technical details. Every string that comes from the package is passed through unchanged so
 * the shell can put it in the document through `textContent`, and nothing is recomputed about
 * signature or trust: both come from the publisher report.
 */
import type { PublisherReport } from "./evaluation.js";
import { isJsonObject, type JsonObject, type JsonValue } from "./json.js";
import { packageJson, type Package } from "./package.js";
import { readProfiles, type Profile } from "./profiles.js";
import type { BrowserSummary, Warning } from "./summary.js";

export type Tone = "good" | "warn" | "bad" | "neutral";

export interface TrustWords {
  signature_status: PublisherReport["signature_status"];
  trust_status: PublisherReport["trust_status"];
  trust_reason: string;
  signer_fingerprint: string | null;
  headline: string;
  detail: string;
  tone: Tone;
  /** A pin is offered only for a valid signature from an unknown key (D-006). */
  can_pin: boolean;
}

export interface AccessItem {
  id: string;
  kind: string;
  description: string;
  required: boolean;
  resources: string[];
  linked_tools: string[];
}

export interface AccessGroup {
  kind: string;
  title: string;
  explanation: string;
  items: AccessItem[];
}

export interface ToolRow {
  id: string;
  description: string;
  execution: string;
  domains: string[];
  side_effects: string;
  approval_required: boolean;
}

export interface SourceInfo {
  kind: "url" | "website" | "file" | "unknown";
  /** The package URL or path. */
  display: string | null;
  /** The website that advertised it, when discovery led here. */
  advertised_on: string | null;
}

export interface AgentPageModel {
  identity: {
    name: string;
    version: string;
    package_id: string;
    publisher_name: string;
    publisher_id: string;
    created_at: string;
    execution_profile: string;
    runtime_status: string;
  };
  trust: TrustWords;
  about: {
    description: string;
    /** The package README's Markdown source, rendered by the shell through the sanitizer only. */
    readme: string | null;
    readme_path: string | null;
  };
  access: AccessGroup[];
  tools: { remote: ToolRow[]; local: ToolRow[] };
  profiles: Profile[] | null;
  profile_notes: string[];
  source: SourceInfo;
  cost: {
    estimated_cost_usd: number | null;
    estimated_tokens: number;
    hard_tokens: number;
    max_remote_calls: number;
    text: string;
  };
  technical: {
    validation: BrowserSummary["validation"];
    digest: string;
    archive_sha256: string | null;
    signer_fingerprint: string | null;
    signature_reason: string;
    extension_keys: string[];
    workers: JsonObject[];
    workflow: BrowserSummary["workflow"];
    evals: JsonObject[];
    attestations: JsonObject[];
    warnings: Warning[];
    manifest: JsonObject;
    payload: BrowserSummary["payload"];
  };
}

const KIND_TITLES: Record<string, [title: string, explanation: string]> = {
  network: ["Websites it can contact", "Only these exact hosts, over HTTPS, through tools the package declares."],
  "personal.read": ["Your personal data it can ask for", "Requested by type. You choose whether to share one of yours, and which, when you run it."],
  "files.read": ["Files it can read", "Only files you select for a run."],
  "files.write": ["Files it can write", "Writes happen only where you allow them."],
  model: ["Your AI model", "Runs on the model you choose and pay for; the package names no provider."],
  memory: ["Memory", "What it keeps while it runs. Nothing persists after the run."],
  payment: ["Payments (simulated here)", "This browser has no payment infrastructure; the permission only decides whether those tools may be called."],
  shell: ["Shell access", "Not available in this browser. The package cannot run commands here."],
};
const KIND_ORDER = ["personal.read", "payment", "network", "files.write", "files.read", "model", "memory", "shell"];

/** Signature and trust, in words a person can act on. Never recomputed; only phrased. */
export function trustWords(publisher: PublisherReport): TrustWords {
  const base = {
    signature_status: publisher.signature_status,
    trust_status: publisher.trust_status,
    trust_reason: publisher.trust_reason,
    signer_fingerprint: publisher.signer_fingerprint,
    can_pin: false,
  };
  if (publisher.signature_status === "absent") {
    return { ...base, headline: "Unsigned", detail: "This package carries no publisher signature. Nobody has vouched for its contents.", tone: "bad" };
  }
  if (publisher.signature_status === "invalid") {
    return {
      ...base,
      headline: "Signature invalid",
      detail: "The signature inside the package does not match its contents. Do not use this package.",
      tone: "bad",
    };
  }
  if (publisher.trust_status === "trusted" && publisher.trust_reason === "policy_anchor") {
    // Trusted because a policy the person subscribed to vouches for this key (T8, D-101): said as such.
    const entry = (publisher.trust_entry ?? {}) as Record<string, unknown>;
    return {
      ...base,
      headline: "Signed by a publisher your policy trusts",
      detail: `The signature is intact and the policy you subscribed to, ${String(entry.policy_title ?? "a policy")} (${String(entry.policy ?? "unknown")}), trusts this key${entry.display_name ? ` as “${String(entry.display_name)}”` : ""} for ${String(entry.package_id_prefix ?? "these packages")}. Unsubscribing from the policy withdraws this trust.`,
      tone: "good",
    };
  }
  if (publisher.trust_status === "trusted") {
    return {
      ...base,
      headline: "Signed by a publisher you trust",
      detail: `The signature is intact and you have trusted this key${publisher.trust_entry ? ` as “${String((publisher.trust_entry as Record<string, unknown>).display_name ?? publisher.claimed_name)}”` : ""}.`,
      tone: "good",
    };
  }
  if (publisher.trust_status === "mismatch") {
    const reasons: Record<string, string> = {
      claimed_publisher_pinned_to_other_key: `This package says it is from ${publisher.claimed_name}, but the key you trust for that publisher is a different one. A key rotation and an impersonation look the same; check with the publisher before trusting this key.`,
      pinned_key_bound_to_other_publisher: "You trust this key for a different publisher than the one this package claims.",
      package_id_outside_pinned_prefix: "You trust this key only for other package ids, not for this one.",
      policy_claimed_publisher_pinned_to_other_key: `This package says it is from ${publisher.claimed_name}, but the policy you subscribed to trusts a different key for that publisher. Treat it as an impersonation risk.`,
      policy_pinned_key_bound_to_other_publisher: "Your policy trusts this key for a different publisher than the one this package claims.",
      policy_package_id_outside_pinned_prefix: "Your policy trusts this key only for other package ids, not for this one.",
    };
    return {
      ...base,
      headline: "Possible impersonation",
      detail: reasons[publisher.trust_reason] ?? "The pinned key does not cover this package. Treat it as an impersonation risk.",
      tone: "bad",
    };
  }
  return {
    ...base,
    headline: "Signed, publisher unknown",
    detail: "The signature is intact, but nobody on this device has trusted the key that made it. Trust it only if you know this publisher.",
    tone: "warn",
    can_pin: true,
  };
}

function accessGroups(pkg: Package, summary: BrowserSummary): AccessGroup[] {
  const groups = new Map<string, AccessGroup>();
  const tools = Object.values(pkg.tools);
  for (const permission of pkg.policy.permissions as JsonObject[]) {
    const kind = String(permission.kind);
    const [title, explanation] = KIND_TITLES[kind] ?? [kind, ""];
    const group = groups.get(kind) ?? { kind, title, explanation, items: [] };
    const id = String(permission.id);
    group.items.push({
      id,
      kind,
      description: String(permission.description),
      required: permission.required === true,
      resources: (permission.resources as JsonValue[]).map(String),
      linked_tools: tools
        .filter((tool) => (tool.permissions as JsonValue[]).includes(id))
        .map((tool) => String(tool.id))
        .sort(),
    });
    groups.set(kind, group);
  }
  // The package's own warnings add groups a person must not miss even without a permission row.
  void summary;
  return [...groups.values()].sort((a, b) => {
    const left = KIND_ORDER.indexOf(a.kind);
    const right = KIND_ORDER.indexOf(b.kind);
    return (left < 0 ? KIND_ORDER.length : left) - (right < 0 ? KIND_ORDER.length : right);
  });
}

function toolRows(summary: BrowserSummary): { remote: ToolRow[]; local: ToolRow[] } {
  const rows = summary.tools.map((tool) => ({
    id: String(tool.id),
    description: String(tool.description),
    execution: String(tool.execution),
    domains: (tool.domains as JsonValue[]).map(String),
    side_effects: String(tool.side_effects),
    approval_required: tool.approval_required === true,
  }));
  return { remote: rows.filter((row) => row.execution === "remote"), local: rows.filter((row) => row.execution !== "remote") };
}

function readme(pkg: Package): { text: string | null; path: string | null } {
  const path = [...pkg.files.keys()].find((name) => name.toLowerCase() === "readme.md") ?? null;
  if (path === null) return { text: null, path: null };
  return { text: new TextDecoder().decode(pkg.files.get(path)!), path };
}

function costText(budget: JsonObject): string {
  const usd = budget.estimated_cost_usd;
  if (typeof usd === "number") return `The publisher estimates about $${usd.toFixed(2)} per run on a paid model; your model sets the real cost.`;
  return "Cost not stated by the publisher. It depends on the model you choose; a local model costs nothing to run.";
}

/** Build the agent-page model from a verified package, its summary and its publisher report. */
export function agentPageModel(
  pkg: Package,
  summary: BrowserSummary,
  options: { source?: Partial<SourceInfo>; archiveSha256?: string | null } = {},
): AgentPageModel {
  const manifest = pkg.manifest;
  const publisherClaim = manifest.publisher as JsonObject;
  const budget = pkg.policy.budget as JsonObject;
  const profiles = readProfiles(pkg);
  const about = readme(pkg);
  return {
    identity: {
      name: String(manifest.name),
      version: String(manifest.version),
      package_id: String(manifest.package_id),
      publisher_name: String(publisherClaim.name),
      publisher_id: String(publisherClaim.id),
      created_at: String(manifest.created_at),
      execution_profile: String(summary.package.execution_profile),
      runtime_status: summary.validation.runtime_status,
    },
    trust: trustWords(summary.publisher),
    about: { description: String(manifest.description), readme: about.text, readme_path: about.path },
    access: accessGroups(pkg, summary),
    tools: toolRows(summary),
    profiles: profiles.profiles,
    profile_notes: profiles.notes,
    source: {
      kind: options.source?.kind ?? "unknown",
      display: options.source?.display ?? null,
      advertised_on: options.source?.advertised_on ?? null,
    },
    cost: {
      estimated_cost_usd: typeof budget.estimated_cost_usd === "number" ? budget.estimated_cost_usd : null,
      estimated_tokens: budget.estimated_tokens as number,
      hard_tokens: budget.hard_tokens as number,
      max_remote_calls: budget.max_remote_calls as number,
      text: costText(budget),
    },
    technical: {
      validation: summary.validation,
      digest: pkg.digest,
      archive_sha256: options.archiveSha256 ?? null,
      signer_fingerprint: summary.publisher.signer_fingerprint,
      signature_reason: summary.publisher.signature_reason,
      extension_keys: (summary.package.extension_keys as JsonValue[]).map(String),
      workers: summary.workers,
      workflow: summary.workflow,
      evals: summary.evals,
      attestations: summary.attestations,
      warnings: summary.warnings,
      manifest,
      payload: summary.payload,
    },
  };
}

/** A declared-only extension value for the technical view, never interpreted. */
export function extensionValue(pkg: Package, key: string): JsonValue | null {
  const extensions = isJsonObject(pkg.manifest.extensions) ? pkg.manifest.extensions : {};
  return Object.hasOwn(extensions, key) ? extensions[key]! : null;
}

export { packageJson };
