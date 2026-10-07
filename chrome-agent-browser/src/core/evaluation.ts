/**
 * Layered evaluation of one immutable snapshot, mirroring `agentpkg/browser/evaluation.py`
 * and the publisher report of `browser/control.py`.
 *
 * Each layer is reported on its own, so a UI can say "the archive parsed but its hashes
 * disagree" or "the signature is cryptographically valid but nobody has pinned that key"
 * without any layer implying another. Nothing downstream of a failed layer is evaluated,
 * because values read out of an unverified payload would not mean anything.
 */
import { pyRepr } from "./repr.js";
import { readArchiveBytes } from "./archive.js";
import { IntegrityError, ValidationError } from "./errors.js";
import { packageDigest, type Package } from "./package.js";
import { signatureReport, type SignatureReport } from "./signature.js";
import { RUNTIME_API, SUPPORTED_EXECUTION_PROFILES } from "./version.js";
import { validatePayload } from "./validation.js";

export const NOT_EVALUATED = "not_evaluated";

export type LayerStatus = "valid" | "invalid" | typeof NOT_EVALUATED;
export type RuntimeStatus = "compatible" | "incompatible" | typeof NOT_EVALUATED;

export interface EvaluationLayers {
  container_status: LayerStatus;
  integrity_status: LayerStatus;
  schema_status: LayerStatus;
  runtime_status: RuntimeStatus;
  supported_execution_profiles: string[];
  errors: Array<{ layer: "container" | "integrity" | "schema" | "runtime"; message: string }>;
}

export interface Evaluation extends EvaluationLayers {
  /** The loaded package when container, integrity and schema all passed. */
  package: Package | null;
}

export function structurallyValid(evaluation: EvaluationLayers): boolean {
  return (
    evaluation.container_status === "valid" && evaluation.integrity_status === "valid" && evaluation.schema_status === "valid"
  );
}

/** The layers without the package object, as the control plane serializes them. */
export function evaluationLayers(evaluation: Evaluation): EvaluationLayers {
  return {
    container_status: evaluation.container_status,
    integrity_status: evaluation.integrity_status,
    schema_status: evaluation.schema_status,
    runtime_status: evaluation.runtime_status,
    supported_execution_profiles: [...evaluation.supported_execution_profiles],
    errors: evaluation.errors.map((error) => ({ ...error })),
  };
}

/** `evaluation.py::evaluate_snapshot` over bytes captured once. */
export async function evaluateSnapshot(bytes: Uint8Array): Promise<Evaluation> {
  const report: Evaluation = {
    container_status: NOT_EVALUATED,
    integrity_status: NOT_EVALUATED,
    schema_status: NOT_EVALUATED,
    runtime_status: NOT_EVALUATED,
    supported_execution_profiles: [...SUPPORTED_EXECUTION_PROFILES],
    errors: [],
    package: null,
  };
  let contents;
  try {
    contents = await readArchiveBytes(bytes);
    report.container_status = "valid";
    report.integrity_status = "valid";
  } catch (error) {
    if (error instanceof IntegrityError) {
      // The ZIP structure and payload gate passed; only the hashes disagree.
      report.container_status = "valid";
      report.integrity_status = "invalid";
      report.errors.push({ layer: "integrity", message: error.message });
      return report;
    }
    if (error instanceof ValidationError) {
      report.container_status = "invalid";
      report.errors.push({ layer: "container", message: error.message });
      return report;
    }
    throw error;
  }
  let payload;
  try {
    payload = await validatePayload(contents.files);
    report.schema_status = "valid";
  } catch (error) {
    if (error instanceof ValidationError) {
      report.schema_status = "invalid";
      report.errors.push({ layer: "schema", message: error.message });
      return report;
    }
    throw error;
  }
  const { manifest, graph } = payload;
  report.package = {
    ...payload,
    files: contents.files,
    integrity: contents.integrity,
    signature: contents.signature,
    digest: await packageDigest(contents.integrity),
  };
  const profile = String(manifest.entrypoint);
  const runtime = manifest.runtime as Record<string, unknown>;
  const compatible =
    SUPPORTED_EXECUTION_PROFILES.includes(profile) && runtime.api === RUNTIME_API && (graph.profile ?? profile) === profile;
  report.runtime_status = compatible ? "compatible" : "incompatible";
  if (!compatible) {
    report.errors.push({
      layer: "runtime",
      message: `Execution profile ${pyRepr(profile)} is not installed in this host; the package remains inspectable but cannot be authorized for execution`,
    });
  }
  return report;
}

/** What a trust store answers about one signer (`TrustStore.evaluate`). */
export interface TrustVerdict {
  trust_status: "trusted" | "unknown" | "mismatch";
  trust_reason: string;
  trust_entry: Record<string, unknown> | null;
  pinned_fingerprints_for_claimed_publisher?: string[];
}

export interface TrustEvaluator {
  evaluate(input: { signerFingerprint: string | null; claimedPublisherId: string; packageId: string }): Promise<TrustVerdict>;
}

export interface PublisherReport extends SignatureReport, TrustVerdict {
  claimed_id: string;
  claimed_name: string;
}

/** `control.py::_publisher_report`: signature self-consistency first, then trust. */
export async function publisherReport(pkg: Package, trust: TrustEvaluator): Promise<PublisherReport> {
  const signature = await signatureReport(pkg);
  const publisher = pkg.manifest.publisher as Record<string, unknown>;
  const verdict = await trust.evaluate({
    signerFingerprint: signature.signature_status === "valid" ? signature.signer_fingerprint : null,
    claimedPublisherId: String(publisher.id),
    packageId: String(pkg.manifest.package_id),
  });
  return {
    claimed_id: String(publisher.id),
    claimed_name: String(publisher.name),
    ...signature,
    ...verdict,
  };
}
