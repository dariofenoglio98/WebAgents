/**
 * The Node CLI as a process: agentpkg's report shapes on success, one stderr line and status
 * 2 on refusal, and argparse's refusals for a command line that does not fit (T1 review 2,
 * nit 12).
 */
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { BuiltCli } from "./helpers/cli.js";
import { ORIGINAL_KEY, ROOT, SHIPPED } from "./helpers/paths.js";

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
    expect(source).toContain("  pdf-text <document.pdf>");
  });
});

describe("pdf-text (T6, D-082)", () => {
  it("prints the probe PDF's pages and the hash of its bytes, as agentpkg host-pdf-read does", () => {
    const path = join(ROOT, "examples", "probe-files", "paper-reader-probe.pdf");
    const result = cli.run(["pdf-text", path]);
    expect(result.status).toBe(0);
    const answer = JSON.parse(result.stdout) as { pages: Array<{ page: number; text: string }>; sha256: string; source: string };
    expect(answer.source).toBe("user_pdf");
    expect(answer.sha256).toBe(createHash("sha256").update(readFileSync(path)).digest("hex"));
    expect(answer.pages.map((page) => page.page)).toEqual([1, 2]);
  });

  it("refuses what is not a PDF with a stable reason and status 3", () => {
    const result = cli.run(["pdf-text", join(ROOT, "README.md")]);
    expect(result.status).toBe(3);
    expect(JSON.parse(result.stdout)).toEqual({ error: "not_a_pdf" });
  });
});

describe("run (D-064)", () => {
  const grants = join(ROOT, "examples", "webair-0.2.0-grants.json");
  const tools = ["search-flights", "get-fare-rules", "prepare-booking", "simulate-purchase", "personal.travel_profile", "personal.passenger_identity", "wallet.payment_method"];
  const approvals = tools.flatMap((tool) => ["--approve-tool", tool]);
  let scratch: string;

  beforeAll(() => {
    scratch = mkdtempSync(join(tmpdir(), "agent-browser-run-"));
  });

  afterAll(() => {
    rmSync(scratch, { recursive: true, force: true });
  });

  it("replays the WebAir fixture and prints agentpkg's report with exactly agentpkg's file set", () => {
    const out = join(scratch, "webair");
    const result = cli.run(["run", SHIPPED.webair040.archive, "--mode", "fixture", "--grants", grants, ...approvals, "--out", out]);
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    const report = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(Object.keys(report).sort()).toEqual(["approved_tools", "fixture_replay", "output_directory", "passed", "profile", "status", "usage"]);
    expect(report).toMatchObject({ status: "completed", profile: "workflow.v0", output_directory: out, approved_tools: [...tools].sort(), fixture_replay: true, passed: true });
    expect((report.usage as { tokens: number }).tokens).toBe(7544);
    expect(readdirSync(out).sort()).toEqual(["answer.md", "audit.json", "booking.json", "fare-rules.json", "provenance.json", "result.json", "search.json", "usage.json"]);
    const provenance = JSON.parse(readFileSync(join(out, "provenance.json"), "utf8")) as Record<string, unknown>;
    expect(provenance).toMatchObject({ profile: "workflow.v0", interpreter: "chrome-agent-browser.workflow.Workflow", synthetic: true, package_id: "org.webagents.webair" });
    // A second run into the same directory is refused: output is a new directory.
    const again = cli.run(["run", SHIPPED.webair040.archive, "--mode", "fixture", "--grants", grants, ...approvals, "--out", out]);
    expect(again.status).toBe(2);
    expect(again.stderr).toBe("agent-browser: --out must name a new directory under an existing parent\n");
  });

  it("a classified workflow failure writes the artifacts and exits 2 with agentpkg's message", () => {
    const limits = join(scratch, "limits.json");
    writeFileSync(limits, JSON.stringify({ total_tokens: 100 }));
    const out = join(scratch, "halted");
    const result = cli.run(["run", SHIPPED.webair040.archive, "--mode", "fixture", "--grants", grants, ...approvals, "--limits", limits, "--out", out]);
    expect(result.status).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toMatch(/^agent-browser: workflow\.v0 budget_exhausted at node [a-z-]+\n$/u);
    expect(readdirSync(out).sort()).toEqual(["audit.json", "provenance.json", "result.json", "usage.json"]);
    expect((JSON.parse(readFileSync(join(out, "result.json"), "utf8")) as { status: string; error_code: string }).error_code).toBe("budget_exhausted");
  });

  it("runs a scenario input and an unapproved tool is refused at dispatch, not silently skipped", () => {
    const scenarios = (JSON.parse(readFileSync(join(ROOT, "examples", "webair-scenarios.json"), "utf8")) as { scenarios: Array<{ input: unknown }> }).scenarios;
    const input = join(scratch, "input.json");
    writeFileSync(input, JSON.stringify(scenarios[0]!.input));
    const ok = cli.run(["run", SHIPPED.webair040.archive, "--mode", "fixture", "--grants", grants, ...approvals, "--input", input, "--out", join(scratch, "scenario")]);
    expect(ok.status, ok.stderr).toBe(0);
    const denied = cli.run(["run", SHIPPED.webair040.archive, "--mode", "fixture", "--grants", grants, "--approve-tool", "get-fare-rules", "--input", input, "--out", join(scratch, "denied")]);
    expect(denied.status).toBe(2);
    // agentpkg's line exactly: the node, never a step (`search`, not `search/search-query`).
    expect(denied.stderr).toBe("agent-browser: workflow.v0 permission_denied at node search\n");
    expect(existsSync(join(scratch, "denied", "result.json"))).toBe(true);
  });

  it("refuses with one stderr line: unknown tools, a bad mode, live without a trust key, live flags in fixture mode, a missing --out", () => {
    const cases: Array<[string[], RegExp]> = [
      [["run", SHIPPED.webair040.archive, "--grants", grants, "--approve-tool", "ghost", "--out", join(scratch, "x1")], /does not declare: \['ghost'\]/u],
      [["run", SHIPPED.webair040.archive, "--grants", grants, "--mode", "nope", "--out", join(scratch, "x2")], /invalid choice: 'nope'/u],
      [["run", SHIPPED.webair040.archive, "--grants", grants, "--mode", "live", "--out", join(scratch, "x3")], /Live run requires a signed artifact and --trust-key/u],
      [["run", SHIPPED.webair040.archive, "--grants", grants, "--model", "ollama/x", "--out", join(scratch, "x4")], /--model applies to --mode live only/u],
      [["run", SHIPPED.webair040.archive, "--grants", grants], /run: the following arguments are required: --out/u],
      [["run", SHIPPED.webair040.archive, "--grants", grants, "--out", join(scratch, "x5"), "--verbose"], /unrecognized arguments: --verbose/u],
      [["run", SHIPPED.webair040.archive, "--grants", grants, "--mode", "live", "--trust-key", SHIPPED.webair040.key, "--out", join(scratch, "x6")], /requires --input and --model/u],
    ];
    for (const [args, pattern] of cases) {
      const result = cli.run(args);
      expect(result.status, args.join(" ")).toBe(2);
      expect(result.stdout, args.join(" ")).toBe("");
      expect(result.stderr, args.join(" ")).toMatch(pattern);
      expect(result.stderr.startsWith("agent-browser: ")).toBe(true);
    }
  });

  it("live mode binds the model through the host's own probe and refuses a model the host does not offer", () => {
    const input = join(scratch, "live-input.json");
    writeFileSync(input, JSON.stringify({ request: "x", booking: false, purchase: { quote_id: "", fare_id: "" } }));
    // Port 1 answers nothing: the probe fails and the run is refused before any package instruction is rendered.
    const result = cli.run(["run", SHIPPED.webair040.archive, "--mode", "live", "--grants", grants, ...approvals, "--trust-key", SHIPPED.webair040.key, "--input", input, "--model", "ollama/qwen3:30b", "--ollama-url", "http://127.0.0.1:1", "--out", join(scratch, "live")]);
    expect(result.status).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toMatch(/^agent-browser: selected_model_unavailable: this host does not offer ollama\/qwen3:30b/u);
    expect(existsSync(join(scratch, "live"))).toBe(false);
  });
});
