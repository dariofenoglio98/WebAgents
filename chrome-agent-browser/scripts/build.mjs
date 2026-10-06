#!/usr/bin/env node
/**
 * Build the extension and the CLI with esbuild (D-031).
 *
 *   dist/extension/   manifest.json, service-worker.js (ES module), content-script.js (classic
 *                     script, as Manifest V3 requires), sidepanel.html + .js, browser.html + .js,
 *                     styles.css, icons/
 *   dist/cli.js       the Node CLI, self-contained
 *
 * Nothing is minified: the shipped code must stay reviewable. The extension targets Chrome 137,
 * the first release with Ed25519 in WebCrypto (STATE.md §10).
 */
import { build } from "esbuild";
import { cpSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const project = resolve(here, "..");
const source = join(project, "src", "extension");
const out = join(project, "dist", "extension");

rmSync(join(project, "dist"), { recursive: true, force: true });
mkdirSync(out, { recursive: true });

const common = {
  bundle: true,
  minify: false,
  sourcemap: false,
  legalComments: "inline",
  logLevel: "warning",
  target: ["chrome137"],
  format: "esm",
  platform: "browser",
};

await build({ ...common, entryPoints: [join(source, "background", "service-worker.ts")], outfile: join(out, "service-worker.js") });
await build({ ...common, format: "iife", entryPoints: [join(source, "content", "content-script.ts")], outfile: join(out, "content-script.js") });
await build({ ...common, entryPoints: [join(source, "sidepanel", "sidepanel.ts")], outfile: join(out, "sidepanel.js") });
await build({ ...common, entryPoints: [join(source, "browser", "browser.ts")], outfile: join(out, "browser.js") });
await build({
  ...common,
  platform: "node",
  target: ["node24"],
  entryPoints: [join(project, "src", "cli.ts")],
  outfile: join(project, "dist", "cli.js"),
  banner: { js: "#!/usr/bin/env node" },
});

for (const name of ["manifest.json", "styles.css"]) cpSync(join(source, name), join(out, name));
cpSync(join(source, "sidepanel", "sidepanel.html"), join(out, "sidepanel.html"));
cpSync(join(source, "browser", "browser.html"), join(out, "browser.html"));
cpSync(join(source, "icons"), join(out, "icons"), { recursive: true });

const files = readdirSync(out).sort();
writeFileSync(join(project, "dist", "BUILD.json"), `${JSON.stringify({ built_at: new Date().toISOString(), extension_files: files }, null, 2)}\n`);
console.log(JSON.stringify({ extension: out, files, cli: join(project, "dist", "cli.js") }));
