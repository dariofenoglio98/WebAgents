/**
 * Static properties of the source that no runtime test can prove on its own.
 *
 * The Run surface added a way for the page to start a package. These scans
 * hold what that must not have added: a browser-side path into backend code,
 * a package-specific branch, a hard-coded model or endpoint, a new subprocess
 * or network path, or markup built from strings.
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "src");
const read = (...parts: string[]) => readFileSync(join(SRC, ...parts), "utf8");
const BROWSER = ["control-ui.ts", ...readdirSync(join(SRC, "ui")).map((name) => join("ui", name))];
/** The generic execution path and the whole Run surface. */
const GENERIC = [
  "execution.ts",
  "execution-bridge.ts",
  "preflight.ts",
  "run-manager.ts",
  "backend.ts",
  "project.ts",
  "contract.ts",
  "ui/run.ts",
  "ui/form.ts",
  "ui/markdown.ts",
  "ui/page.ts",
];

function imports(source: string): string[] {
  return [...source.matchAll(/^\s*import\s+(?:type\s+)?(?:[^"']*from\s+)?["']([^"']+)["']/gmu)].map((match) => match[1]!);
}

describe("the browser half", () => {
  it("imports only the contract, its own modules and the Control UI SDK", () => {
    const allowed = new Set([
      "../contract.js",
      "./contract.js",
      "./dom.js",
      "./form.js",
      "./markdown.js",
      "./run.js",
      "./ui/page.js",
      "./control-ui.css",
      "openclaw/plugin-sdk/control-ui",
      "openclaw/plugin-sdk/feature-contract",
    ]);
    for (const file of BROWSER) {
      for (const target of imports(read(file))) {
        expect(allowed.has(target), `${file} imports ${target}`).toBe(true);
      }
    }
  });

  it("opens no socket, no request and no subprocess of its own", () => {
    for (const file of BROWSER) {
      const source = read(file);
      // Node modules are already excluded by the import allowlist above.
      expect(source, file).not.toMatch(/\bfetch\s*\(|XMLHttpRequest|new WebSocket|EventSource|sendBeacon|child_process/u);
    }
  });

  it("builds no markup from strings", () => {
    for (const file of BROWSER) {
      expect(read(file), file).not.toMatch(/\.(inner|outer)HTML\s*=|insertAdjacentHTML|document\.write|DOMParser|eval\(|new Function/u);
    }
  });
});

describe("the generic execution path", () => {
  it("contains no package, domain or model name", () => {
    for (const file of GENERIC) {
      const source = read(...file.split("/")).toLowerCase();
      for (const word of [
        "literature",
        "org.webagents",
        "related_work",
        "related-work",
        "bibliography",
        "evidence_items",
        "research_question",
        "qwen",
        "ollama",
        "crossref",
        "meeting",
        "agenda",
        // Website discovery is generic too: no site, airline or demo origin.
        "webair",
        "airline",
      ]) {
        expect(source.includes(word), `${file} mentions ${word}`).toBe(false);
      }
    }
  });

  it("hard-codes no endpoint", () => {
    for (const file of ["execution.ts", "preflight.ts", "run-manager.ts", "ui/run.ts", "ui/form.ts"]) {
      expect(read(...file.split("/")), file).not.toMatch(/https?:\/\/[a-z0-9]/iu);
    }
  });

  it("spawns processes only where it already did", () => {
    const spawning = readdirSync(SRC)
      .filter((name) => name.endsWith(".ts"))
      .filter((name) => read(name).includes("child_process"))
      .sort();
    expect(spawning).toEqual(["bridge-core.ts", "execution-bridge.ts", "pdf-reader.ts", "router-bridge.ts", "service.ts"]);
    for (const name of spawning) {
      // No shell: every spawn names an executable and an argument vector.
      expect(read(name), name).not.toMatch(/shell:\s*true|(?<![.\w])exec\(|execSync|spawnSync/u);
    }
  });

  it("starts runs through one operation, with no model or binding in its input", () => {
    const contract = read("contract.ts");
    const start = contract.slice(contract.indexOf('"execution.start": {'), contract.indexOf('"files.select-local": {'));
    const inputBlock = start.slice(start.indexOf("input: Obj({"), start.indexOf("output:"));
    const fields = [...inputBlock.matchAll(/^\s{8}(\w+):/gmu)].map((match) => match[1]);
    expect(fields).toEqual(["sessionId", "runPlanId", "runPlanSha256", "input", "files", "detach"]);
  });
});
