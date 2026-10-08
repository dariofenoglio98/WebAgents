#!/usr/bin/env node
/**
 * Reference answers for the Chrome Crossref adapter (T6, D-081): bundles the frozen plugin's own
 * `openclaw-agent-browser/src/tool-adapters.ts` with esbuild into a temporary module, runs its
 * `CROSSREF_WORKS_ADAPTER` over the captured Crossref response and a set of edge cases, and writes
 * the requests and normalized answers to `test/fixtures/crossref/reference-answers.json`. The two
 * projects never import each other; this file is how the port is held equal to the reference.
 *
 *   node scripts/make-crossref-reference.mjs [--out FILE]
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const here = dirname(fileURLToPath(import.meta.url));
const project = join(here, "..");
const root = join(project, "..");
const outIndex = process.argv.indexOf("--out");
const out = outIndex > 0 ? process.argv[outIndex + 1] : join(project, "test", "fixtures", "crossref", "reference-answers.json");

const scratch = mkdtempSync(join(tmpdir(), "crossref-reference-"));
try {
  const bundle = join(scratch, "adapters.mjs");
  await build({ entryPoints: [join(root, "openclaw-agent-browser", "src", "tool-adapters.ts")], bundle: true, format: "esm", platform: "node", outfile: bundle, logLevel: "silent" });
  const adapters = await import(pathToFileURL(bundle).href);
  const captured = JSON.parse(readFileSync(join(project, "test", "fixtures", "crossref", "crossref-works-select.json"), "utf8"));
  const retrieved = "2026-09-23T12:00:00.000Z";
  const responses = [
    { name: "captured", json: captured, args: { query: "communication topology multi-agent LLM", limit: 10 } },
    { name: "captured_limit_3", json: captured, args: { query: "q", limit: 3 } },
    {
      name: "rendering",
      args: { query: "q", limit: 5 },
      json: {
        status: "ok",
        message: {
          items: [
            {
              DOI: "10.1234/ABC.Def",
              title: ["A <i>marked</i> title &amp; more"],
              author: [{ given: "Ada", family: "Lovelace" }, { name: "The <b>Consortium</b>" }, { family: "" }, "not an author"],
              "published-online": { "date-parts": [[2024, 5]] },
              issued: { "date-parts": [[2023]] },
              "container-title": ["Proceedings of &quot;X&quot;"],
              abstract: "<jats:title>Abstract</jats:title><jats:p>We   study x.</jats:p>",
              URL: "https://doi.org/10.1234/abc.def",
            },
          ],
        },
      },
    },
    {
      name: "missing",
      args: { query: "q", limit: 20 },
      json: {
        status: "ok",
        message: {
          items: [
            { DOI: "10.1/a", title: [] },
            { DOI: "10.1/b" },
            { DOI: "10.1/c", title: ["Only a title"] },
            { title: ["No DOI at all"], URL: "javascript:alert(1)", author: "nobody" },
            { title: ["Bad dates"], issued: { "date-parts": [[null]] }, published: { "date-parts": [["2020"]] } },
            7,
            { DOI: " 10.5555/Upper Case ", title: ["Spaces"], URL: "http://user:pw@example.org/x" },
            { DOI: "10.12/short", title: ["Short registrant"], URL: "ftp://example.org" },
          ],
        },
      },
    },
  ];
  const requests = [
    { query: "communication topology multi-agent LLM", limit: 10 },
    { query: "Graph-of-Agents: “adaptive” topology & selection? #LLM+routing é/../x=1&rows=99", limit: 3 },
  ].map((args) => {
    const request = adapters.CROSSREF_WORKS_ADAPTER.request(args, "GET");
    return { args, query: request.query, encoded: adapters.encodeQuery(request.query) };
  });
  const document = {
    generator: "chrome-agent-browser/scripts/make-crossref-reference.mjs",
    reference: "openclaw-agent-browser/src/tool-adapters.ts CROSSREF_WORKS_ADAPTER",
    retrieved_at: retrieved,
    select: adapters.CROSSREF_SELECT,
    filter: adapters.CROSSREF_FILTER,
    requests,
    answers: responses.map((item) => ({ name: item.name, args: item.args, output: adapters.CROSSREF_WORKS_ADAPTER.response({ status: 200, json: item.json }, item.args, retrieved) })),
  };
  // The captured response is an input file already; the answers carry only what the adapter produced.
  for (const answer of document.answers) if (answer.name.startsWith("captured")) answer.input = "crossref-works-select.json";
  for (const answer of document.answers) if (!answer.input) answer.input = responses.find((item) => item.name === answer.name).json;
  writeFileSync(out, `${JSON.stringify(document, null, 1)}\n`);
  console.log(`wrote ${out}: ${document.answers.length} answers, ${document.requests.length} requests`);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
