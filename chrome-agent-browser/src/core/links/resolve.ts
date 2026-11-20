/**
 * A dependency's bytes, verified and checked against its record (link.v0 §3, L-10…L-12;
 * `agentpkg/links/resolve.py`, line for line).
 *
 * Resolution is preparation: the bytes are read, verified and described; nothing of a linked
 * package runs here, and nothing here imports the interpreter. The bytes come from the record's
 * locator under the package-URL policy (a host's `fetch`, over its transport unchanged) or from an
 * archive the person supplied, accepted only by its digest. An execution host re-checks a linked
 * archive with the same code. Refusals are `LinkRefusal`s whose text starts with the code.
 */
import { AgentPkgError } from "../errors.js";
import { sha256Hex } from "../hash.js";
import type { JsonObject } from "../json.js";
import type { ModelRouter } from "../models/contract.js";
import { loadPackageBytes, type Package } from "../package.js";
import { pyRepr } from "../repr.js";
import { signatureReport } from "../signature.js";
import { composedRequirement, linkOperations, packageWorstCase, type PackageWorstCase } from "./analysis.js";
import { LinkRefusal } from "./errors.js";
import type { LinkCosts } from "../network/analysis.js";

/**
 * One linked package as preparation found it: verified bytes, the record it answers, its
 * publisher's key with the person's trust in it, and its own worst case (L-18); null for a join
 * candidate its profile refuses (no worst case is defined for it, L-33).
 */
export interface ResolvedLink {
  dependency: string;
  record: JsonObject;
  package: Package;
  archive_sha256: string;
  signer: string;
  trust: string;
  worst_case: PackageWorstCase | null;
  /** The verified bytes, which an execution host is handed beside the plan. */
  bytes: Uint8Array;
}

/** `ResolvedLink.facts()`: the package as a record states it. */
export function linkFacts(link: ResolvedLink): JsonObject {
  const manifest = link.package.manifest;
  return {
    package_id: manifest.package_id!,
    name: manifest.name!,
    version: manifest.version!,
    digest: link.package.digest,
    archive_sha256: link.archive_sha256,
    signer: link.signer,
    trust: link.trust,
  };
}

/** A package's trust in a publisher key as the person's own store evaluates it, as if the package had been opened directly (L-12). */
export type TrustOf = (signer: string, pkg: Package) => string | Promise<string>;

/**
 * L-10: the bytes verified as any package's (container, integrity, schemas), with a valid
 * signature, which a link always requires. Returns the package, the archive's SHA-256 and the
 * signer's fingerprint.
 */
export async function verifyLinked(data: Uint8Array, label: string): Promise<{ package: Package; archive_sha256: string; signer: string }> {
  let pkg: Package;
  try {
    pkg = await loadPackageBytes(data);
  } catch (error) {
    if (error instanceof AgentPkgError) throw new LinkRefusal("link_package_invalid", `${label}: ${error.message}`);
    throw error;
  }
  const report = await signatureReport(pkg);
  if (report.signature_status !== "valid") {
    throw new LinkRefusal("link_signature_invalid", `${label}: a linked package carries a valid publisher signature (${report.signature_status}: ${report.signature_reason})`);
  }
  return { package: pkg, archive_sha256: await sha256Hex(data), signer: report.signer_fingerprint! };
}

/**
 * Depth one (L-11, LK-5): why a package cannot be linked, or null. It declares a dependency, or
 * its graph holds a `link` step of either form, so its run could start a further run.
 */
export function nestedReason(pkg: Package): string | null {
  const dependencies = pkg.manifest.dependencies;
  if (Array.isArray(dependencies) && dependencies.length > 0) return "it declares dependencies of its own";
  if (linkOperations(pkg.graph).length > 0) return "its graph holds a link step";
  return null;
}

/** L-11's two profile checks, shared by a dependency and a join candidate. */
export function checkProfile(pkg: Package, label: string): void {
  if (pkg.manifest.entrypoint !== "workflow.v0" || (pkg.graph.conversation !== undefined && pkg.graph.conversation !== null)) {
    throw new LinkRefusal("link_target_conversational", `${label}: a linked package is a one-shot workflow.v0 package, not a conversation`);
  }
  const reason = nestedReason(pkg);
  if (reason !== null) throw new LinkRefusal("link_nested", `${label}: ${reason}; v0 links one level deep`);
}

/** L-11, in its order: identity, digest, declared signer, then the profile. */
export function checkRecord(record: JsonObject, pkg: Package, signer: string): void {
  const label = `dependency ${pyRepr(String(record.id))}`;
  const manifest = pkg.manifest;
  if (manifest.package_id !== record.package_id || manifest.version !== record.version) {
    throw new LinkRefusal("link_identity_mismatch", `${label}: the archive is ${String(manifest.package_id)} ${String(manifest.version)}, the record names ${String(record.package_id)} ${String(record.version)}`);
  }
  if (pkg.digest !== record.digest) throw new LinkRefusal("link_digest_mismatch", `${label}: the archive's package digest is not the pinned one`);
  if ("signer" in record && record.signer !== signer) throw new LinkRefusal("link_signer_mismatch", `${label}: signed by ${signer}, the record expects ${String(record.signer)}`);
  checkProfile(pkg, label);
}

/**
 * Every dependency of the caller resolved (L-10…L-12), in declaration order: `sources` holds the
 * archives the person supplied by dependency id; a dependency without one is fetched by
 * `fetch(record)`. `trust(signer, package)` is the person's own evaluation of a publisher key, as
 * if the package were opened directly; the caller's trust plays no part.
 */
export async function resolveLinks(caller: Package, sources: ReadonlyMap<string, Uint8Array>, options: { trust: TrustOf; fetch?: ((record: JsonObject) => Promise<Uint8Array>) | null }): Promise<Map<string, ResolvedLink>> {
  const records = (caller.manifest.dependencies as JsonObject[] | undefined) ?? [];
  const declared = new Set(records.map((record) => record.id));
  const unknown = [...sources.keys()].filter((id) => !declared.has(id)).sort();
  if (unknown.length > 0) throw new LinkRefusal("link_dependency_unknown", `an archive was supplied for ${pyRepr(unknown[0]!)}, which is not a declared dependency`);
  const resolved = new Map<string, ResolvedLink>();
  for (const record of records) {
    const id = String(record.id);
    let data = sources.get(id);
    if (data === undefined) {
      if (!options.fetch) throw new LinkRefusal("link_fetch_failed", `dependency ${pyRepr(id)}: this host fetches no package`);
      data = await options.fetch(record);
    }
    const verified = await verifyLinked(data, `dependency ${pyRepr(id)}`);
    checkRecord(record, verified.package, verified.signer);
    resolved.set(id, {
      dependency: id,
      record: { ...record },
      package: verified.package,
      archive_sha256: verified.archive_sha256,
      signer: verified.signer,
      trust: await options.trust(verified.signer, verified.package),
      worst_case: packageWorstCase(verified.package.graph, verified.package.policy),
      bytes: data,
    });
  }
  return resolved;
}

/**
 * L-20: the composed relaxation within the caller's own budget. `worstCases` maps each dependency
 * id to its worst case, or to null for a denied link (left out, L-22).
 */
export function checkComposition(caller: Package, worstCases: LinkCosts): void {
  const excess = composedRequirement(caller.graph, caller.policy, worstCases);
  if (excess !== null) {
    const [name, needed, cap] = excess;
    throw new LinkRefusal("link_bound_exceeds_budget", `with its links the package's worst case is ${needed} ${name.replaceAll("_", " ")}, above its own budget of ${cap}`);
  }
}

/**
 * L-14: the linked package runs on the caller's model route, which must meet its model
 * requirements as it must meet the caller's.
 */
export function checkModel(link: Pick<ResolvedLink, "package" | "dependency">, router: ModelRouter | null): void {
  const requirements = link.package.manifest.model_requirements as JsonObject;
  const label = `dependency ${pyRepr(link.dependency)}`;
  const tasks = requirements.tasks as JsonObject[];
  if (tasks.length === 0) return;
  if (router === null) throw new LinkRefusal("link_model_incompatible", `${label}: no model route is configured`);
  if (requirements.privacy === "local-only" && router.remote) throw new LinkRefusal("link_model_incompatible", `${label}: it requires a local-only model route`);
  for (const task of tasks) {
    const missing = (task.capabilities as string[]).filter((capability) => !router.capabilities.has(capability)).sort();
    if (missing.length > 0) throw new LinkRefusal("link_model_incompatible", `${label}: task ${pyRepr(String(task.id))} needs ${pyRepr(missing[0]!)}, which the route lacks`);
    if (router.context_window < (task.context_window as number)) {
      throw new LinkRefusal("link_model_incompatible", `${label}: task ${pyRepr(String(task.id))} needs a context window of ${String(task.context_window)}, the route has ${router.context_window}`);
    }
  }
}
