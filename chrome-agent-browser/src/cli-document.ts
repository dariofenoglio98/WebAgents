/**
 * `document sign | verify` (T8): the publisher-side tool for the signed documents of
 * `spec/extensions/signed-document-v0.md`, an agent index, a policy bundle or a model catalog (T41).
 *
 *   node dist/cli.js document sign   --type agent-index|policy-bundle|model-catalog --key <private.pem> <content.json> --out <signed.json>
 *   node dist/cli.js document verify --type agent-index|policy-bundle|model-catalog --key <public.pem> <signed.json>
 *
 * `sign` reads the content as strict JSON, checks it against the content type's schema and
 * rules first (a publisher never signs a document a browser would refuse), signs it with an
 * Ed25519 private key in PKCS#8 PEM (read here, in Node; the core never sees a private key) and
 * writes the envelope to a path that must not exist yet. `verify` checks an envelope against one
 * pinned public key exactly as the extension does and prints what it verified. Refusals follow
 * the CLI's rule (D-038): one line on stderr, status 2, nothing on stdout.
 */
import { createPrivateKey, createPublicKey, sign as nodeSign, type KeyObject } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

import { parseArguments, type ArgumentSpec } from "./cli-arguments.js";
import {
  AGENT_INDEX_TYPE,
  buildSignedDocument,
  CoreError,
  isJsonObject,
  parseJson,
  MODEL_CATALOG_TYPE,
  POLICY_BUNDLE_TYPE,
  publicKeyFromPem,
  serializeSignedDocument,
  verifySignedDocument,
  type DocumentContentType,
  type JsonObject,
} from "./core/index.js";
import { readPolicyBundle } from "./core/policies/bundle.js";
import { extensionSchemaFailure } from "./core/schema.js";
import { readAgentIndex } from "./core/resolve/static-index.js";
import { readModelCatalog } from "./core/models/in-browser-catalog.js";

function print(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

/** The CLI's refusal (D-038): one line on stderr, status 2. */
function refuse(error: unknown): number {
  process.stderr.write(`agent-browser: ${error instanceof Error ? error.message : String(error)}\n`);
  return 2;
}

const TYPES: Readonly<Record<string, DocumentContentType>> = Object.freeze({ "agent-index": AGENT_INDEX_TYPE, "policy-bundle": POLICY_BUNDLE_TYPE, "model-catalog": MODEL_CATALOG_TYPE });
const CONTENT_SCHEMA: Readonly<Record<DocumentContentType, string>> = Object.freeze({ [AGENT_INDEX_TYPE]: "agent-index-v0", [POLICY_BUNDLE_TYPE]: "policy-bundle-v0", [MODEL_CATALOG_TYPE]: "model-catalog-v0" });
const SIGN: ArgumentSpec = { positional: ["content"], options: { "--type": { kind: "value", required: true, choices: Object.keys(TYPES) }, "--key": { kind: "value", required: true }, "--out": { kind: "value", required: true } } };
const VERIFY: ArgumentSpec = { positional: ["document"], options: { "--type": { kind: "value", required: true, choices: Object.keys(TYPES) }, "--key": { kind: "value", required: true } } };

/** The raw 32 bytes of an Ed25519 public key object. */
function rawPublicKey(key: KeyObject): Uint8Array {
  const der = key.export({ format: "der", type: "spki" });
  return new Uint8Array(der.subarray(der.length - 32));
}

/** What a verified document says about itself, for the printed report. */
async function describe(type: DocumentContentType, content: JsonObject): Promise<Record<string, unknown>> {
  if (type === AGENT_INDEX_TYPE) {
    const index = readAgentIndex(content);
    return { id: index.index_id, version: index.version, title: index.title, entries: index.entries.length, notes: index.notes, issued_at: index.issued_at, expires_at: index.expires_at };
  }
  if (type === MODEL_CATALOG_TYPE) {
    const catalog = readModelCatalog(content);
    return { id: catalog.catalog_id, version: catalog.version, title: catalog.title, entries: catalog.entries.map((entry) => ({ id: entry.id, bytes_total: entry.bytes_total, weights_digest: entry.weights_digest })), issued_at: catalog.issued_at, expires_at: catalog.expires_at };
  }
  const bundle = await readPolicyBundle(content);
  return {
    id: bundle.policy_id,
    version: bundle.version,
    title: bundle.title,
    trust_anchors: bundle.trust_anchors.map((anchor) => ({ kind: anchor.kind, fingerprint: anchor.fingerprint })),
    decisions: bundle.decisions,
    issued_at: bundle.issued_at,
    expires_at: bundle.expires_at,
  };
}

async function sign(args: string[]): Promise<number> {
  const parsed = parseArguments("document sign", args, SIGN);
  try {
    const type = TYPES[parsed.value("--type")!]!;
    const out = parsed.value("--out")!;
    if (existsSync(out)) throw new CoreError("output_exists", `${out} exists; signing never overwrites a document`);
    const content = parseJson(new Uint8Array(readFileSync(parsed.positional.content!)), "content");
    if (!isJsonObject(content)) throw new CoreError("document_content_invalid", "the content must be a JSON object");
    const failure = await extensionSchemaFailure(content, CONTENT_SCHEMA[type]);
    if (failure !== null) throw new CoreError("document_content_invalid", `the content is not a valid ${type}: ${failure}`);
    await describe(type, content); // the rules beyond the schema, before anything is signed
    const privateKey = createPrivateKey(readFileSync(parsed.value("--key")!));
    if (privateKey.asymmetricKeyType !== "ed25519") throw new CoreError("key_invalid", "the signing key must be an Ed25519 private key");
    const document = await buildSignedDocument(type, content, { publicKey: rawPublicKey(createPublicKey(privateKey)), sign: (message) => new Uint8Array(nodeSign(null, message, privateKey)) });
    const text = serializeSignedDocument(document);
    // The written bytes must verify under the key that signed them before they leave this tool.
    const verified = await verifySignedDocument(new TextEncoder().encode(text), type, [rawPublicKey(createPublicKey(privateKey))]);
    writeFileSync(out, text, { flag: "wx" });
    print({ written: out, content_type: type, signer_fingerprint: verified.signer_fingerprint, content_sha256: verified.content_sha256, document_sha256: verified.document_sha256, ...(await describe(type, verified.content)) });
    return 0;
  } catch (error) {
    return refuse(error);
  }
}

async function verify(args: string[]): Promise<number> {
  const parsed = parseArguments("document verify", args, VERIFY);
  try {
    const type = TYPES[parsed.value("--type")!]!;
    const key = publicKeyFromPem(readFileSync(parsed.value("--key")!, "utf8"));
    const verified = await verifySignedDocument(new Uint8Array(readFileSync(parsed.positional.document!)), type, [key]);
    print({ valid: true, content_type: type, signer_fingerprint: verified.signer_fingerprint, content_sha256: verified.content_sha256, document_sha256: verified.document_sha256, ...(await describe(type, verified.content)) });
    return 0;
  } catch (error) {
    return refuse(error);
  }
}

export async function documentCommand(args: string[]): Promise<number> {
  const [sub, ...rest] = args;
  if (sub === "sign") return sign(rest);
  if (sub === "verify") return verify(rest);
  process.stderr.write("agent-browser: document needs sign or verify\n");
  return 2;
}
