/**
 * The extension pages' content security policy (D-253): the extension's own scripts, and WebAssembly
 * compilation for a package's compute modules (`'wasm-unsafe-eval'`, compute.v0), and nothing that
 * evaluates text as code. `scripts/check-pack.mjs` applies the same rule to the packed zip.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { PROJECT } from "../helpers/paths.js";

const manifest = JSON.parse(readFileSync(join(PROJECT, "src", "extension", "manifest.json"), "utf8")) as { content_security_policy: { extension_pages: string } };
const policy = manifest.content_security_policy.extension_pages;
const directive = (name: string): string[] => (new RegExp(`(?:^|;)\\s*${name} ([^;]*)`, "u").exec(policy)?.[1] ?? "").trim().split(/\s+/u);

describe("the extension pages' CSP (D-253)", () => {
  it("allows the extension's own scripts and WebAssembly compilation, and no evaluation of text", () => {
    expect(directive("script-src")).toEqual(["'self'", "'wasm-unsafe-eval'"]);
    expect(policy).not.toMatch(/(?<!wasm-)unsafe-eval|unsafe-inline/u);
    expect(directive("object-src")).toEqual(["'self'"]);
  });
});
