/**
 * The Node CLI as a process: agentpkg's report shapes on success, one stderr line and status
 * 2 on refusal, and argparse's refusals for a command line that does not fit (T1 review 2,
 * nit 12).
 */
import { readFileSync } from "node:fs";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { BuiltCli } from "./helpers/cli.js";
import { ORIGINAL_KEY, SHIPPED } from "./helpers/paths.js";

let cli: BuiltCli;

beforeAll(async () => {
  cli = await BuiltCli.build();
});

afterAll(() => {
  cli.dispose();
});

describe("verify, inspect and evaluate", () => {
  it("verify prints agentpkg's report for the shipped WebAir with its publisher key", () => {
    const result = cli.run(["verify", SHIPPED.webair.archive, "--trust-key", SHIPPED.webair.key]);
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    const report = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(report.valid).toBe(true);
    expect(report.digest).toBe(SHIPPED.webair.digest);
    expect(report.key_fingerprint).toBe(SHIPPED.webair.fingerprint);
    expect(result.stdout.endsWith("}\n")).toBe(true);
  });

  it("verify with the wrong key refuses on stderr with status 2 and nothing on stdout", () => {
    const result = cli.run(["verify", SHIPPED.webair.archive, "--trust-key", ORIGINAL_KEY]);
    expect(result.status).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("agent-browser: publisher key is not the host-pinned trusted key\n");
  });

  it("inspect prints the package metadata without any trust claim", () => {
    const result = cli.run(["inspect", SHIPPED.literatureReview.archive]);
    expect(result.status).toBe(0);
    const report = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(report.digest).toBe(SHIPPED.literatureReview.digest);
    expect(report.signature_trust).toBe("not verified by inspect");
  });

  it("evaluate prints the layered view and the archive hash", () => {
    const result = cli.run(["evaluate", SHIPPED.webair.archive]);
    expect(result.status).toBe(0);
    const report = JSON.parse(result.stdout) as { archive_sha256: string; publisher: { trust_status: string } };
    expect(report.archive_sha256).toBe(SHIPPED.webair.archiveSha256);
    expect(report.publisher.trust_status).toBe("unknown");
  });
});

describe("the command line is parsed as argparse parses agentpkg's (nit 12)", () => {
  it("refuses an unknown flag on every command with status 2 and agentpkg's wording", () => {
    for (const args of [
      ["verify", SHIPPED.webair.archive, "--trust-key", SHIPPED.webair.key, "--extra"],
      ["inspect", SHIPPED.webair.archive, "--trust-key", SHIPPED.webair.key],
      ["evaluate", SHIPPED.webair.archive, "--nope", "x"],
    ]) {
      const result = cli.run(args);
      expect(result.status, args.join(" ")).toBe(2);
      expect(result.stdout, args.join(" ")).toBe("");
      expect(result.stderr, args.join(" ")).toMatch(/^agent-browser: unrecognized arguments: --/u);
    }
  });

  it("refuses a surplus positional, a flag without its value and a missing required flag", () => {
    expect(cli.run(["inspect", SHIPPED.webair.archive, "second.pkg"]).stderr).toBe("agent-browser: unrecognized arguments: second.pkg\n");
    expect(cli.run(["verify", SHIPPED.webair.archive, "--trust-key"]).stderr).toBe("agent-browser: argument --trust-key: expected one argument\n");
    expect(cli.run(["verify", SHIPPED.webair.archive, "--trust-key", "--extra"]).stderr).toBe("agent-browser: argument --trust-key: expected one argument\n");
    const missing = cli.run(["verify", SHIPPED.webair.archive]);
    expect(missing.status).toBe(2);
    expect(missing.stderr).toBe("agent-browser: verify: the following arguments are required: --trust-key\n");
    expect(cli.run(["verify"]).stderr).toBe("agent-browser: verify: the following arguments are required: package, --trust-key\n");
  });

  it("an unknown command prints the usage and exits 2", () => {
    const result = cli.run(["frobnicate"]);
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/^usage: agent-browser-core/u);
  });

  it("the usage text names every command", () => {
    const source = readFileSync(new URL("../src/cli.ts", import.meta.url), "utf8");
    for (const command of ["verify", "inspect", "evaluate", "run"]) expect(source).toContain(`  ${command} <package.agent.pkg>`);
  });
});
