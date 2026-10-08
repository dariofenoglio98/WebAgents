#!/usr/bin/env node
/**
 * Build the extension and the CLI with esbuild (D-031).
 *
 *   dist/extension/   manifest.json, service-worker.js (ES module), content-script.js (classic
 *                     script, as Manifest V3 requires), sidepanel.html + .js, browser.html + .js,
 *                     execution.html + execution-page.js + execution-worker.js (the offscreen
 *                     execution host, T5), pdf-worker.js (the paper reader's parser, T6), styles.css, icons/
 *                     LICENSE.txt and THIRD_PARTY_NOTICES.txt (T7): WebAgents' license and the
 *                     notices of every third-party package the bundles contain, read from esbuild's
 *                     metafile so the list cannot drift from what is actually bundled
 *   dist/cli.js       the Node CLI, self-contained
 *
 * Nothing is minified: the shipped code must stay reviewable. The extension targets Chrome 137,
 * the first release with Ed25519 in WebCrypto (STATE.md §10).
 */
import { build } from "esbuild";
import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const project = resolve(here, "..");
const source = join(project, "src", "extension");
const out = join(project, "dist", "extension");

rmSync(join(project, "dist"), { recursive: true, force: true });
mkdirSync(out, { recursive: true });

/**
 * `@hyperjump/json-schema` depends on `@hyperjump/browser`, whose package.json carries a
 * `browser` map (`lib/index.js` → `lib/index.browser.js`, which registers no `file:` scheme
 * plugin and therefore imports nothing from `node:`). esbuild applies a package's `exports`
 * before its `browser` map, so the map is not honoured by itself; this plugin applies it,
 * exactly as declared, for the extension bundles. The CLI bundle targets Node and keeps the
 * Node entry. No other dependency has a Node-only path (`npm run build` fails loudly if one
 * appears, since nothing else is shimmed).
 */
function browserFieldPlugin() {
  const packageDir = join(project, "node_modules", "@hyperjump", "browser");
  const map = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8")).browser;
  return {
    name: "hyperjump-browser-field",
    setup(api) {
      api.onResolve({ filter: /^@hyperjump\/browser$/ }, () => ({ path: join(packageDir, map["./lib/index.js"]) }));
      api.onResolve({ filter: /\/context-uri\.js$/ }, (args) => {
        if (!args.importer.startsWith(packageDir)) return null;
        return { path: join(packageDir, map["./lib/browser/context-uri.js"]) };
      });
    },
  };
}

const common = {
  // Inputs (and the metafile's paths) resolve against the package, whatever the caller's working
  // directory: `node chrome-agent-browser/scripts/build.mjs` from the repository root works too.
  absWorkingDir: project,
  bundle: true,
  minify: false,
  sourcemap: false,
  legalComments: "inline",
  logLevel: "warning",
  target: ["chrome137"],
  format: "esm",
  platform: "browser",
  plugins: [browserFieldPlugin()],
  metafile: true,
};

/** Every input file of every extension bundle, for the notices below. */
const bundledInputs = new Set();
async function extensionBuild(options) {
  const result = await build(options);
  for (const input of Object.keys(result.metafile.inputs)) bundledInputs.add(input);
}

await extensionBuild({ ...common, entryPoints: [join(source, "background", "service-worker.ts")], outfile: join(out, "service-worker.js") });
await extensionBuild({ ...common, format: "iife", entryPoints: [join(source, "content", "content-script.ts")], outfile: join(out, "content-script.js") });
await extensionBuild({ ...common, entryPoints: [join(source, "sidepanel", "sidepanel.ts")], outfile: join(out, "sidepanel.js") });
await extensionBuild({ ...common, entryPoints: [join(source, "browser", "browser.ts")], outfile: join(out, "browser.js") });
// The execution host (T5, D-070): the offscreen document's page script and the per-run Worker (an ES module Worker).
await extensionBuild({ ...common, entryPoints: [join(source, "execution", "execution-page.ts")], outfile: join(out, "execution-page.js") });
await extensionBuild({ ...common, entryPoints: [join(source, "execution", "execution-worker.ts")], outfile: join(out, "execution-worker.js") });
// The paper reader's parser (T6, D-082): pdf.js in its own short-lived Worker per document.
await extensionBuild({ ...common, entryPoints: [join(source, "execution", "pdf-worker.ts")], outfile: join(out, "pdf-worker.js") });
await build({
  ...common,
  plugins: [],
  metafile: false,
  platform: "node",
  target: ["node24"],
  entryPoints: [join(project, "src", "cli.ts")],
  outfile: join(project, "dist", "cli.js"), // the source hashbang is hoisted to line 1
});

// The extension bundles must be free of Node built-ins: a `node:` specifier that survived
// bundling would fail at load time in Chrome, long after `npm run build` reported success.
for (const name of ["service-worker.js", "content-script.js", "sidepanel.js", "browser.js", "execution-page.js", "execution-worker.js", "pdf-worker.js"]) {
  const text = readFileSync(join(out, name), "utf8");
  const hit = /(?:from\s*|import\s*\(\s*|require\s*\(\s*)["']node:[^"']*["']/u.exec(text);
  if (hit) throw new Error(`${name} still references a Node built-in: ${hit[0]}`);
}

for (const name of ["manifest.json", "styles.css"]) cpSync(join(source, name), join(out, name));
cpSync(join(source, "sidepanel", "sidepanel.html"), join(out, "sidepanel.html"));
cpSync(join(source, "browser", "browser.html"), join(out, "browser.html"));
cpSync(join(source, "execution", "execution.html"), join(out, "execution.html"));
cpSync(join(source, "icons"), join(out, "icons"), { recursive: true });

// -- licenses (T7): the zip a person installs carries its own notices ---------------------
const repository = resolve(project, "..");
/** `node_modules/@scope/name/...` or `node_modules/name/...` -> the package directory, innermost. */
function packageDirectory(input) {
  const parts = input.split("/");
  const at = parts.lastIndexOf("node_modules");
  if (at < 0) return null;
  const length = parts[at + 1]?.startsWith("@") ? 3 : 2;
  return parts.slice(0, at + length).join("/");
}
const packages = [...new Set([...bundledInputs].map(packageDirectory).filter(Boolean))]
  .map((directory) => {
    const manifest = JSON.parse(readFileSync(join(project, directory, "package.json"), "utf8"));
    const licenseFile = readdirSync(join(project, directory)).find((name) => /^licen[cs]e(\.(md|txt))?$/iu.test(name));
    if (!licenseFile) throw new Error(`${manifest.name} is bundled but ships no license file`);
    return { name: manifest.name, version: manifest.version, license: manifest.license, text: readFileSync(join(project, directory, licenseFile), "utf8").trim() };
  })
  .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
// The CPython-derived core files (repository THIRD_PARTY_NOTICES.md §1) and the PSF text quoted there.
const repositoryNotices = readFileSync(join(repository, "THIRD_PARTY_NOTICES.md"), "utf8");
const cpython = /## 1\. CPython[\s\S]*?```text\n([\s\S]*?)```/u.exec(repositoryNotices);
if (!cpython) throw new Error("THIRD_PARTY_NOTICES.md §1 (CPython) not found");
const rule = "=".repeat(78);
const notices = [
  "Chrome Agent Browser: third-party notices",
  "",
  "The Chrome Agent Browser is part of WebAgents and is licensed under the Apache License,",
  "Version 2.0 (LICENSE.txt). The extension's bundles contain the third-party material below,",
  "distributed under the terms that follow each item. The repository's THIRD_PARTY_NOTICES.md",
  "describes the same material in more detail.",
  "",
  rule,
  "CPython 3.13 (Python Software Foundation License Version 2)",
  rule,
  "The character-reference tables in the bundles (from src/core/html-entities.ts) are",
  "CPython 3.13's html.entities.html5, html._invalid_charrefs and html._invalid_codepoints;",
  "the text extraction (src/core/html-text.ts) transcribes regular expressions from",
  "Lib/html/parser.py, Lib/_markupbase.py and Lib/html/__init__.py; src/core/urls.ts follows",
  "urllib.parse.urlsplit. CPython is distributed under the following terms:",
  "",
  cpython[1].trim(),
  "",
  ...packages.flatMap((item) => [rule, `${item.name} ${item.version} (${item.license})`, rule, item.text, ""]),
].join("\n");
writeFileSync(join(out, "THIRD_PARTY_NOTICES.txt"), `${notices}\n`);
cpSync(join(repository, "LICENSE"), join(out, "LICENSE.txt"));

const files = readdirSync(out).sort();
writeFileSync(
  join(project, "dist", "BUILD.json"),
  `${JSON.stringify({ built_at: new Date().toISOString(), extension_files: files, bundled_packages: packages.map(({ name, version, license }) => ({ name, version, license })) }, null, 2)}\n`,
);
console.log(JSON.stringify({ extension: out, files, cli: join(project, "dist", "cli.js") }));
