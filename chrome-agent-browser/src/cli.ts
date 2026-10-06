#!/usr/bin/env node
/**
 * The core's Node CLI (D-024, D-036): `verify` and `inspect` with agentpkg's flag names and
 * report shapes, so the two runtimes can be compared side by side. T4 adds `run`.
 *
 *   node dist/cli.js verify  <package.agent.pkg> --trust-key <publisher.pub.pem>
 *   node dist/cli.js inspect <package.agent.pkg>
 *   node dist/cli.js evaluate <package.agent.pkg> [--trust-store <trust.json>]
 *
 * `verify` prints the same JSON as `agentpkg verify` and exits 0 only when the signature was
 * made by exactly the supplied key. `inspect` prints `agentpkg inspect`'s report without any
 * claim about publisher trust. `evaluate` prints the control plane's layered view: the four
 * validation layers, the signature report and the trust verdict against an optional Python
 * `trust.json`, plus the browser summary. Nothing here executes a package.
 */
import { readFileSync, writeFileSync } from "node:fs";

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
  SignatureError,
  TrustStore,
  ValidationError,
  verifyWithTrustedKey,
  type TrustDocument,
  type TrustStorage,
} from "./core/index.js";

function usage(): never {
  process.stderr.write(
    [
      "usage: agent-browser-core <command> [options]",
      "",
      "  verify <package.agent.pkg> --trust-key <publisher.pub.pem>",
      "  inspect <package.agent.pkg>",
      "  evaluate <package.agent.pkg> [--trust-store <trust.json>]",
      "",
    ].join("\n"),
  );
  process.exit(2);
}

function option(args: string[], name: string): string | null {
  const index = args.indexOf(name);
  if (index < 0) return null;
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--")) usage();
  return value;
}

function print(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function failure(error: unknown): { code: string; message: string } {
  if (error instanceof CoreError) return { code: error.code, message: error.message };
  if (error instanceof SignatureError) return { code: "signature_error", message: error.message };
  if (error instanceof ValidationError) return { code: "validation_error", message: error.message };
  return { code: "error", message: error instanceof Error ? error.message : String(error) };
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

async function verify(args: string[]): Promise<number> {
  const archive = args[0];
  const keyPath = option(args, "--trust-key");
  if (!archive || !keyPath) usage();
  try {
    const pkg = await loadPackageBytes(new Uint8Array(readFileSync(archive)));
    const report = await verifyWithTrustedKey(pkg, publicKeyFromPem(readFileSync(keyPath, "utf8")));
    print(report);
    return 0;
  } catch (error) {
    print({ valid: false, error: failure(error) });
    return 1;
  }
}

async function inspect(args: string[]): Promise<number> {
  const archive = args[0];
  if (!archive) usage();
  try {
    const pkg = await loadPackageBytes(new Uint8Array(readFileSync(archive)));
    print(inspectPackage(pkg));
    return 0;
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ error: failure(error) })}\n`);
    return 1;
  }
}

async function evaluate(args: string[]): Promise<number> {
  const archive = args[0];
  if (!archive) usage();
  const storePath = option(args, "--trust-store");
  const trust = new TrustStore(storePath ? new FileTrustStorage(storePath) : new MemoryTrustStorage("none"));
  const bytes = new Uint8Array(readFileSync(archive));
  const evaluation = await evaluateSnapshot(bytes);
  const layers = evaluationLayers(evaluation);
  if (evaluation.package === null) {
    print({ validation: layers, publisher: null, summary: null });
    return 1;
  }
  const publisher = await publisherReport(evaluation.package, trust);
  const summary = await buildSummary(evaluation.package, { evaluation: layers, publisher });
  print({ validation: layers, publisher, trust_store: await trust.state(), summary });
  return 0;
}

async function main(argv: string[]): Promise<number> {
  const [command, ...args] = argv;
  switch (command) {
    case "verify":
      return verify(args);
    case "inspect":
      return inspect(args);
    case "evaluate":
      return evaluate(args);
    default:
      return usage();
  }
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (error: unknown) => {
    process.stderr.write(`${JSON.stringify({ error: failure(error) })}\n`);
    process.exit(1);
  },
);
