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

/**
 * Source text without comments and without the contents of string literals, so prose about
 * "the document head" or "this browser" is not a violation. Template literals keep the code
 * inside `${…}`, which is where a reference could still hide.
 */
function code(text: string, strings: "strip" | "keep" = "strip"): string {
  let out = "";
  let index = 0;
  const templateDepth: number[] = []; // brace depth at each open `${`
  let braces = 0;
  const skipString = (quote: string): void => {
    const start = index;
    index += 1;
    while (index < text.length && text[index] !== quote && text[index] !== "\n") {
      if (text[index] === "\\") index += 1;
      index += 1;
    }
    index += 1;
    out += strings === "keep" ? text.slice(start, index) : " ";
  };
  const skipTemplate = (opening: boolean): void => {
    if (opening) index += 1;
    while (index < text.length && text[index] !== "`") {
      if (text[index] === "\\") index += 2;
      else if (text.startsWith("${", index)) {
        templateDepth.push(braces);
        index += 2;
        out += " ";
        return;
      } else index += 1;
    }
    index += 1;
  };
  while (index < text.length) {
    const char = text[index]!;
    if (text.startsWith("//", index)) {
      while (index < text.length && text[index] !== "\n") index += 1;
    } else if (text.startsWith("/*", index)) {
      const end = text.indexOf("*/", index + 2);
      index = end < 0 ? text.length : end + 2;
    } else if (char === '"' || char === "'") {
      skipString(char);
    } else if (char === "`") {
      skipTemplate(true);
      out += " ";
    } else if (char === "{") {
      braces += 1;
      out += char;
      index += 1;
    } else if (char === "}") {
      if (templateDepth.length > 0 && templateDepth[templateDepth.length - 1] === braces) {
        templateDepth.pop();
        index += 1;
        skipTemplate(false); // back inside the template literal, after the expression
      } else {
        braces -= 1;
        out += char;
        index += 1;
      }
    } else {
      out += char;
      index += 1;
    }
  }
  return out;
}

/**
 * Globals that are objects are only ever used through member access (`chrome.runtime`,
 * `document.head`, `process.env`); the callable ones also through a call or `new`. A local
 * function that happens to be called `document(path)` is therefore not a hit.
 */
const FORBIDDEN_OBJECTS = ["chrome", "browser", "document", "window", "self", "navigator", "localStorage", "sessionStorage", "indexedDB", "process", "__dirname"];
const FORBIDDEN_CALLABLES = ["XMLHttpRequest", "WebSocket", "fetch", "require", "Buffer"];
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
      const checks: Array<[global: string, pattern: RegExp]> = [
        // A bare global used as a value: not preceded by `.`, a word character or a quote.
        ...FORBIDDEN_OBJECTS.map((global): [string, RegExp] => [global, new RegExp(`(?<![.\\w"'\`$])${global}\\s*[.\\[]`, "u")]),
        ...FORBIDDEN_CALLABLES.map((global): [string, RegExp] => [global, new RegExp(`(?<![.\\w"'\`$])${global}\\s*[.(\\[]`, "u")]),
      ];
      for (const [global, pattern] of checks) {
        const match = pattern.exec(text);
        expect(match, `${name} uses ${global}: ${match?.[0]}`).toBeNull();
      }
      const withStrings = code(readFileSync(file, "utf8"), "keep");
      for (const pattern of FORBIDDEN_IMPORTS) {
        expect(pattern.exec(withStrings), `${name} matches ${pattern}`).toBeNull();
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
      for (const match of code(readFileSync(file, "utf8"), "keep").matchAll(/from\s+["']([^."'][^"']*)["']/gu)) external.add(match[1]!);
    }
    expect([...external].sort()).toEqual(["@hyperjump/json-schema/draft-2020-12", "@noble/ed25519"]);
  });
});
