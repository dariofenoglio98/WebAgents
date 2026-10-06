/**
 * The core boundary (D-024, D-031): nothing under `src/core` may depend on Chrome, the DOM,
 * Node or the extension shell. `tsconfig.core.json` enforces it at the type level with an
 * empty `types` list and no DOM library; this test is the second, independent check over the
 * source text, so a `// @ts-ignore` or an `any` cannot smuggle a dependency past the compiler.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import { describe, expect, it } from "vitest";

import { PROJECT } from "../helpers/paths.js";

const CORE = join(PROJECT, "src", "core");

function* walk(directory: string): Generator<string> {
  for (const name of readdirSync(directory)) {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) yield* walk(path);
    else if (name.endsWith(".ts")) yield path;
  }
}

/** Source text without comments, so prose about "the document head" is not a violation. */
function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//gu, "").replace(/(^|[^:"'`])\/\/.*$/gmu, "$1");
}

const FORBIDDEN_GLOBALS = ["chrome", "browser", "document", "window", "self", "navigator", "localStorage", "sessionStorage", "indexedDB", "XMLHttpRequest", "WebSocket", "fetch", "process", "require", "Buffer", "__dirname"];
const FORBIDDEN_IMPORTS = [/from\s+["']node:/u, /from\s+["']\.\.\/extension/u, /from\s+["']\.\.\/\.\.\/extension/u, /from\s+["']chrome/u, /import\s+["']node:/u, /\brequire\(/u, /import\(/u];
const ALLOWED_DECLARATIONS = new Set(["TextEncoder", "TextDecoder", "URL", "crypto", "CoreCryptoKey", "CoreSubtleCrypto"]);

describe("the portable core has no Chrome, DOM, Node or shell dependency", () => {
  const files = [...walk(CORE)].filter((path) => !path.endsWith("globals.d.ts"));

  it("finds the core modules", () => {
    expect(files.length).toBeGreaterThan(15);
  });

  for (const file of files) {
    const name = relative(PROJECT, file);
    it(`${name} uses no forbidden global or import`, () => {
      const text = code(readFileSync(file, "utf8"));
      for (const global of FORBIDDEN_GLOBALS) {
        // A bare global used as a value: not preceded by `.`, a word character or a quote.
        const pattern = new RegExp(`(?<![.\\w"'\`$])${global}\\s*[.(\\[]`, "u");
        const match = pattern.exec(text);
        expect(match, `${name} uses ${global}: ${match?.[0]}`).toBeNull();
      }
      for (const pattern of FORBIDDEN_IMPORTS) {
        expect(pattern.exec(text), `${name} matches ${pattern}`).toBeNull();
      }
    });
  }

  it("the global allowlist declares only the WHATWG surface the core may use", () => {
    const text = readFileSync(join(CORE, "globals.d.ts"), "utf8");
    const declared = [...text.matchAll(/^(?:declare\s+(?:class|const)|interface)\s+(\w+)/gmu)].map((match) => match[1]!);
    expect(declared.length).toBeGreaterThan(0);
    for (const name of declared) expect(ALLOWED_DECLARATIONS.has(name), `unexpected global ${name}`).toBe(true);
  });

  it("the core tsconfig compiles with no DOM, Node or Chrome type library", () => {
    const raw = readFileSync(join(PROJECT, "tsconfig.core.json"), "utf8").replace(/^\s*\/\/.*$/gmu, "");
    const config = JSON.parse(raw) as { compilerOptions: { types: string[]; lib: string[] }; include: string[] };
    expect(config.compilerOptions.types).toEqual([]);
    expect(config.compilerOptions.lib.some((lib) => /dom/iu.test(lib))).toBe(false);
    expect(config.include).toEqual(["src/core/**/*.ts"]);
  });

  it("the core imports only its two runtime dependencies", () => {
    const external = new Set<string>();
    for (const file of files) {
      for (const match of code(readFileSync(file, "utf8")).matchAll(/from\s+["']([^."'][^"']*)["']/gu)) external.add(match[1]!);
    }
    expect([...external].sort()).toEqual(["@hyperjump/json-schema/draft-2020-12", "@noble/ed25519"]);
  });
});
