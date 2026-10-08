#!/usr/bin/env node
/**
 * Build the extension and the CLI with esbuild (D-031).
 *
 *   dist/extension/   manifest.json, service-worker.js (ES module), content-script.js (classic
 *                     script, as Manifest V3 requires), sidepanel.html + .js, browser.html + .js,
 *                     execution.html + execution-page.js + execution-worker.js (the offscreen
 *                     execution host, T5), styles.css, icons/
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
  bundle: true,
  minify: false,
  sourcemap: false,
  legalComments: "inline",
  logLevel: "warning",
  target: ["chrome137"],
  format: "esm",
  platform: "browser",
  plugins: [browserFieldPlugin()],
};

await build({ ...common, entryPoints: [join(source, "background", "service-worker.ts")], outfile: join(out, "service-worker.js") });
await build({ ...common, format: "iife", entryPoints: [join(source, "content", "content-script.ts")], outfile: join(out, "content-script.js") });
await build({ ...common, entryPoints: [join(source, "sidepanel", "sidepanel.ts")], outfile: join(out, "sidepanel.js") });
await build({ ...common, entryPoints: [join(source, "browser", "browser.ts")], outfile: join(out, "browser.js") });
// The execution host (T5, D-070): the offscreen document's page script and the per-run Worker (an ES module Worker).
await build({ ...common, entryPoints: [join(source, "execution", "execution-page.ts")], outfile: join(out, "execution-page.js") });
await build({ ...common, entryPoints: [join(source, "execution", "execution-worker.ts")], outfile: join(out, "execution-worker.js") });
await build({
  ...common,
  plugins: [],
  platform: "node",
  target: ["node24"],
  entryPoints: [join(project, "src", "cli.ts")],
  outfile: join(project, "dist", "cli.js"), // the source hashbang is hoisted to line 1
});

// The extension bundles must be free of Node built-ins: a `node:` specifier that survived
// bundling would fail at load time in Chrome, long after `npm run build` reported success.
for (const name of ["service-worker.js", "content-script.js", "sidepanel.js", "browser.js", "execution-page.js", "execution-worker.js"]) {
  const text = readFileSync(join(out, name), "utf8");
  const hit = /(?:from\s*|import\s*\(\s*|require\s*\(\s*)["']node:[^"']*["']/u.exec(text);
  if (hit) throw new Error(`${name} still references a Node built-in: ${hit[0]}`);
}

for (const name of ["manifest.json", "styles.css"]) cpSync(join(source, name), join(out, name));
cpSync(join(source, "sidepanel", "sidepanel.html"), join(out, "sidepanel.html"));
cpSync(join(source, "browser", "browser.html"), join(out, "browser.html"));
cpSync(join(source, "execution", "execution.html"), join(out, "execution.html"));
cpSync(join(source, "icons"), join(out, "icons"), { recursive: true });

const files = readdirSync(out).sort();
writeFileSync(join(project, "dist", "BUILD.json"), `${JSON.stringify({ built_at: new Date().toISOString(), extension_files: files }, null, 2)}\n`);
console.log(JSON.stringify({ extension: out, files, cli: join(project, "dist", "cli.js") }));
