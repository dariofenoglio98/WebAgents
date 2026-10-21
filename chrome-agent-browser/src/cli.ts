#!/usr/bin/env node
/**
 * The core's Node CLI (D-024, D-036, D-038): `verify`, `inspect` and `evaluate` with agentpkg's
 * flag names and report shapes, so the two runtimes can be compared side by side. `run` is
 * T4's and lives in `cli-run.ts`.
 *
 *   node dist/cli.js verify  <package.agent.pkg> --trust-key <publisher.pub.pem>
 *   node dist/cli.js inspect <package.agent.pkg>
 *   node dist/cli.js evaluate <package.agent.pkg> [--trust-store <trust.json>]
 *   node dist/cli.js run <package.agent.pkg> --mode fixture|live --grants <grants.json> …
 *
 * `verify` prints the same JSON as `agentpkg verify` and exits 0 only when the signature was
 * made by exactly the supplied key; like agentpkg, any refusal goes to stderr as one line
 * (`agent-browser: <message>`) with exit status 2 and nothing on stdout. `inspect` prints
 * `agentpkg inspect`'s report without any claim about publisher trust. `evaluate` prints the
 * control plane's layered view: the archive SHA-256, the four validation layers, the signature
 * report and the trust verdict against an optional Python `trust.json`, plus the browser
 * summary; a package that fails a structural layer prints its layered report and exits 1.
 *
 * Arguments are parsed the way `argparse` parses agentpkg's: an unknown flag, a surplus
 * positional, a flag without its value or a missing required flag is refused on stderr with
 * status 2 and argparse's wording (T1 review 2, nit 12), so T7 can compare the two CLIs by
 * exit status.
 */
import { readFileSync, writeFileSync } from "node:fs";

import { documentCommand } from "./cli-document.js";
import { converseCommand } from "./cli-converse.js";
import { runCommand } from "./cli-run.js";
import { PdfRefusal } from "./core/tools/adapters/selected-file.js";
import { ArgumentError, parseArguments, type ArgumentSpec } from "./cli-arguments.js";
import {
  buildSummary,
  CoreError,
  evaluateSnapshot,
  evaluationLayers,
  inspectPackage,
  loadPackageBytes,
  MemoryTrustStorage,
  publicKeyFromPem,
  publisherReport,
  sha256Hex,
  SignatureError,
  TrustStore,
  ValidationError,
  verifyWithTrustedKey,
  type TrustDocument,
  type TrustStorage,
} from "./core/index.js";

export const USAGE = [
  "usage: agent-browser-core <command> [options]",
  "",
  "  verify <package.agent.pkg> --trust-key <publisher.pub.pem>",
  "  inspect <package.agent.pkg>",
  "  evaluate <package.agent.pkg> [--trust-store <trust.json>]",
  "  run <package.agent.pkg> --mode fixture|live --grants <grants.json> [--input <input.json>]",
  "      [--approve-tool <tool-id>]... [--trust-key <publisher.pub.pem>] [--limits <limits.json>]",
  "      [--out <new-directory>] [live: --model <provider/model> [--ollama-url <url>]",
  "      [--context-tokens <n>] [--think] [--reasoning-effort low|medium|high] [--tool-bindings <bindings.json>]",
  "      [--host-resources <resources.json>] [--resource-grant <permission>=<resource-id>]...]",
  "  converse <package.agent.pkg> --mode fixture|live --grants <grants.json> [--transcript <transcript.json>]",
  "      [--approve-tool <tool-id>]... [--trust-key <publisher.pub.pem>] [--limits <limits.json>] --out <new-directory>",
  "      [live: the same model, binding and resource options as run]",
  "  pdf-text <document.pdf>",
  "  document sign --type agent-index|policy-bundle --key <private.pem> <content.json> --out <signed.json>",
  "  document verify --type agent-index|policy-bundle --key <public.pem> <signed.json>",
  "",
].join("\n");

function usage(): never {
  process.stderr.write(USAGE);
  process.exit(2);
}

export function print(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

export function failure(error: unknown): { code: string; message: string } {
  if (error instanceof CoreError) return { code: error.code, message: error.message };
  if (error instanceof SignatureError) return { code: "signature_error", message: error.message };
  if (error instanceof ValidationError) return { code: "validation_error", message: error.message };
  return { code: "error", message: error instanceof Error ? error.message : String(error) };
}

/** `agentpkg.cli.main`: one line on stderr, status 2, nothing on stdout. */
export function refuse(error: unknown): number {
  process.stderr.write(`agent-browser: ${failure(error).message}\n`);
  return 2;
}

/** A Python `trust.json` file as the trust storage, read-only unless written through `write`. */
class FileTrustStorage implements TrustStorage {
  readonly location: string;

  constructor(private readonly path: string) {
    this.location = path;
  }

  async read(): Promise<unknown> {
    try {
      return JSON.parse(readFileSync(this.path, "utf8")) as unknown;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  async write(document: TrustDocument): Promise<void> {
    writeFileSync(this.path, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600 });
  }
}

const VERIFY: ArgumentSpec = { positional: ["package"], options: { "--trust-key": { kind: "value", required: true } } };
const INSPECT: ArgumentSpec = { positional: ["package"], options: {} };
const EVALUATE: ArgumentSpec = { positional: ["package"], options: { "--trust-store": { kind: "value" } } };

async function verify(args: string[]): Promise<number> {
  const parsed = parseArguments("verify", args, VERIFY);
  try {
    const pkg = await loadPackageBytes(new Uint8Array(readFileSync(parsed.positional.package!)));
    const report = await verifyWithTrustedKey(pkg, publicKeyFromPem(readFileSync(parsed.value("--trust-key")!, "utf8")));
    print(report);
    return 0;
  } catch (error) {
    return refuse(error);
  }
}

async function inspect(args: string[]): Promise<number> {
  const parsed = parseArguments("inspect", args, INSPECT);
  try {
    const pkg = await loadPackageBytes(new Uint8Array(readFileSync(parsed.positional.package!)));
    print(inspectPackage(pkg));
    return 0;
  } catch (error) {
    return refuse(error);
  }
}

async function evaluate(args: string[]): Promise<number> {
  const parsed = parseArguments("evaluate", args, EVALUATE);
  const storePath = parsed.value("--trust-store");
  const trust = new TrustStore(storePath ? new FileTrustStorage(storePath) : new MemoryTrustStorage("none"));
  const bytes = new Uint8Array(readFileSync(parsed.positional.package!));
  const archiveSha256 = await sha256Hex(bytes);
  const evaluation = await evaluateSnapshot(bytes);
  const layers = evaluationLayers(evaluation);
  if (evaluation.package === null) {
    print({ archive_sha256: archiveSha256, archive_bytes: bytes.length, validation: layers, publisher: null, summary: null });
    return 1;
  }
  const publisher = await publisherReport(evaluation.package, trust);
  const summary = await buildSummary(evaluation.package, { evaluation: layers, publisher });
  print({ archive_sha256: archiveSha256, archive_bytes: bytes.length, validation: layers, publisher, trust_store: await trust.state(), summary });
  return 0;
}

/**
 * `pdf-text <file>`: the paper reader's parser over one local PDF (T6, D-082), the Chrome host's
 * counterpart of `agentpkg host-pdf-read`: `{pages, sha256, source}` on stdout and status 0, or
 * `{"error": reason}` and status 3 for a document the parser refuses (a stable reason, never
 * content). The live verifier uses it to re-extract a picked document with the parser the run
 * used, so a quote can be checked against the text that run saw.
 */
async function pdfText(args: string[]): Promise<number> {
  if (args.length !== 1 || args[0]!.startsWith("-")) return usage();
  const data = new Uint8Array(readFileSync(args[0]!));
  // Loaded here only: pdf.js's Node polyfills print to stderr when they load, and every other
  // command's stderr is agentpkg's exactly (D-038).
  const { extractPdfText } = await import("./pdf/extract.js");
  try {
    print(await extractPdfText(data));
    return 0;
  } catch (error) {
    if (error instanceof PdfRefusal) {
      print({ error: error.reason });
      return 3;
    }
    throw error;
  }
}

async function main(argv: string[]): Promise<number> {
  const [command, ...args] = argv;
  try {
    switch (command) {
      case "verify":
        return await verify(args);
      case "inspect":
        return await inspect(args);
      case "evaluate":
        return await evaluate(args);
      case "run":
        return await runCommand(args);
      case "converse":
        return await converseCommand(args);
      case "pdf-text":
        return await pdfText(args);
      case "document":
        return await documentCommand(args);
      default:
        return usage();
    }
  } catch (error) {
    if (error instanceof ArgumentError) {
      // argparse prints its usage and `<prog>: error: <message>` and exits 2; the message
      // text is argparse's, behind this CLI's one-line prefix (D-038).
      process.stderr.write(`agent-browser: ${error.message}\n`);
      return 2;
    }
    return refuse(error);
  }
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (error: unknown) => process.exit(refuse(error)),
);
