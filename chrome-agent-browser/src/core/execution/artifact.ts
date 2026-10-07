/**
 * Independent verification of the exact bytes a runner was handed (`execution/artifact.py`). The
 * control plane already checked everything before it issued the lease; the runner is the process
 * that will put package instructions in front of a model, so it computes the identity again rather
 * than believing a claim about it. Publisher *trust* stays the host's decision (a trust store is
 * operator configuration); what is confirmed here is that the identity held is the identity that
 * was trusted. Any mismatch fails closed: no repair, no re-fetch.
 */
import { MAX_ARCHIVE_BYTES } from "../archive.js";
import { AgentPkgError } from "../errors.js";
import { bytesEqual, sha256Hex } from "../hash.js";
import type { JsonObject } from "../json.js";
import { fingerprint } from "../keys.js";
import { loadPackageBytes, type Package } from "../package.js";
import { checkSignature, embeddedPublicKey } from "../signature.js";
import { ARTIFACT_INVALID, ARTIFACT_MISMATCH, ExecutionError, SIGNATURE_INVALID } from "./errors.js";

export { MAX_ARCHIVE_BYTES };

export interface ExpectedIdentity {
  archive_sha256: string;
  digest: string;
  package_id: string;
  version: string;
  signer_fingerprint: string;
}

export interface ArtifactEvidence extends JsonObject {
  archive_sha256: string;
  archive_bytes: number;
  digest: string;
  package_id: string;
  version: string;
  signer_fingerprint: string;
  signature_status: "valid";
  entrypoint: string;
  execution_profile: string;
  verified: string[];
  note: string;
}

/** Constant-time comparison of two hex digests (`secrets.compare_digest`). */
function sameDigest(a: string, b: string): boolean {
  const encoder = new TextEncoder();
  return bytesEqual(encoder.encode(a), encoder.encode(b));
}

/** Load these bytes and confirm they are the artifact the run plan names. */
export async function verifyExecutionArtifact(data: Uint8Array, expected: ExpectedIdentity): Promise<{ package: Package; evidence: ArtifactEvidence }> {
  if (data.length === 0) throw new ExecutionError(ARTIFACT_INVALID, "The package bytes are empty");
  if (data.length > MAX_ARCHIVE_BYTES) throw new ExecutionError(ARTIFACT_INVALID, `The package archive exceeds the ${MAX_ARCHIVE_BYTES}-byte container limit`);
  const archiveSha256 = await sha256Hex(data);
  if (!sameDigest(archiveSha256, String(expected.archive_sha256))) {
    throw new ExecutionError(ARTIFACT_MISMATCH, "The archive handed to the runner is not the archive the run plan names", { detail: { expected: expected.archive_sha256, received: archiveSha256 } });
  }
  let pkg: Package;
  try {
    pkg = await loadPackageBytes(data);
  } catch (error) {
    if (!(error instanceof AgentPkgError)) throw error;
    throw new ExecutionError(ARTIFACT_INVALID, `The execution artifact failed structural validation: ${error.message}`);
  }
  if (!sameDigest(pkg.digest, String(expected.digest))) {
    throw new ExecutionError(ARTIFACT_MISMATCH, "The package digest does not match the run plan", { detail: { expected: expected.digest, received: pkg.digest } });
  }
  for (const field of ["package_id", "version"] as const) {
    if (pkg.manifest[field] !== expected[field]) {
      throw new ExecutionError(ARTIFACT_MISMATCH, `The package ${field} does not match the run plan`, { detail: { expected: expected[field], received: pkg.manifest[field] ?? null } });
    }
  }
  if (pkg.signature === null) throw new ExecutionError(SIGNATURE_INVALID, "The execution artifact carries no publisher signature");
  let signer: string;
  try {
    const key = await embeddedPublicKey(pkg.signature);
    signer = await fingerprint(key);
    await checkSignature(pkg, key);
  } catch (error) {
    if (!(error instanceof AgentPkgError)) throw error;
    throw new ExecutionError(SIGNATURE_INVALID, `The execution artifact signature is not valid: ${error.message}`);
  }
  if (!sameDigest(signer, String(expected.signer_fingerprint))) {
    // The signature verifies, but against a different key than the one the trust decision was
    // made about. Trust is the host's; the runner refuses an identity that is not the trusted one.
    throw new ExecutionError(ARTIFACT_MISMATCH, "The artifact was signed by a different key than the run plan recorded", { detail: { expected: expected.signer_fingerprint, received: signer } });
  }
  if (pkg.manifest.entrypoint !== "workflow.v0") {
    throw new ExecutionError(ARTIFACT_INVALID, `This runner executes workflow.v0 only; the package selects ${JSON.stringify(pkg.manifest.entrypoint)}`);
  }
  const evidence: ArtifactEvidence = {
    archive_sha256: archiveSha256,
    archive_bytes: data.length,
    digest: pkg.digest,
    package_id: String(pkg.manifest.package_id),
    version: String(pkg.manifest.version),
    signer_fingerprint: signer,
    signature_status: "valid",
    entrypoint: String(pkg.manifest.entrypoint),
    execution_profile: String(pkg.graph.profile ?? pkg.manifest.entrypoint),
    verified: ["archive_sha256", "container", "integrity", "schema", "package_digest", "package_identity", "publisher_signature", "signer_fingerprint", "execution_profile"],
    note: "Publisher trust remains the host's decision. The runner confirms that the cryptographic identity it received is the identity the run plan recorded.",
  };
  return { package: pkg, evidence };
}
