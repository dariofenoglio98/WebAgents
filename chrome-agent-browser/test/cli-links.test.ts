/**
 * The Node CLI's links (`src/cli-links.ts`): a dependency without `--link` is fetched from its
 * locator through the transport (GET, nothing but an Accept header: no body, cookie or referrer;
 * no redirect followed), and fixture mode dials nothing, a slot's look included: with a join
 * fixture that records no web, the slot looks at an empty recorded web and finds nothing (L-29,
 * D-699 (s)). The tests sit at the transport seam the CLI hands every request to.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { ParsedArguments } from "../src/cli-arguments.js";
import { cliLinks, fetchPackageBytes } from "../src/cli-links.js";
import { fixtureAdapters } from "../src/core/fixtures.js";
import type { JsonObject, JsonValue } from "../src/core/json.js";
import type { HttpRequest, HttpResponse, HttpTransport } from "../src/core/models/transport.js";
import { loadPackageBytes } from "../src/core/package.js";
import { runWorkflow, type ExecutionReport } from "../src/core/workflow/interpreter.js";
import { ROOT } from "./helpers/paths.js";

const read = (path: string): Uint8Array => new Uint8Array(readFileSync(resolve(ROOT, path)));
const jsonFile = (path: string): JsonValue => JSON.parse(readFileSync(resolve(ROOT, path), "utf8")) as JsonValue;

/** A transport that serves recorded bytes by URL and keeps every request it was handed. */
function recording(served: Record<string, Uint8Array> = {}): { transport: HttpTransport; requests: HttpRequest[] } {
  const requests: HttpRequest[] = [];
  const transport: HttpTransport = async (request): Promise<HttpResponse> => {
    requests.push(request);
    const bytes = served[request.url];
    if (bytes === undefined) return { status: 404, headers: {}, body: "" };
    return { status: 200, headers: { "content-type": "application/octet-stream" }, body: "", bytes };
  };
  return { transport, requests };
}

const args = (options: Record<string, string | string[]>): ParsedArguments => new ParsedArguments({ package: "-" }, new Map(Object.entries(options)));
const LINK_GRANTS = ["webair-flights=examples/link/webair-flights-grants.json", "hotel-aggregator=examples/link/staymere-hotels-grants.json"].map((pair) => pair.replace("=", `=${ROOT}/`));

describe("a dependency without --link (L-10)", () => {
  it("is fetched from its locator through the transport, a plain GET, and verified by its pinned digest", async () => {
    const pkg = await loadPackageBytes(read("dist/travel-planner-0.1.0.agent.pkg"));
    const records = pkg.manifest.dependencies as JsonObject[];
    const archives: Record<string, Uint8Array> = { "webair-flights": read("dist/webair-flights-0.1.0.agent.pkg"), "hotel-aggregator": read("dist/staymere-hotels-0.1.0.agent.pkg") };
    const { transport, requests } = recording(Object.fromEntries(records.map((record) => [String(record.locator), archives[String(record.id)]!])));
    const fixture = fixtureAdapters(pkg);
    const linked = await cliLinks(pkg, args({ "--link-grants": LINK_GRANTS, "--approve-tool": ["check-calendar", "webair-flights:search-flights", "hotel-aggregator:search-hotels"] }), { mode: "fixture", grants: {}, limits: null, router: fixture.router, compute: null, checkOwnApprovals: () => undefined, jsonFile: (path) => jsonFile(path), transport });
    expect([...linked.links!.bindings.keys()].sort()).toEqual(["hotel-aggregator", "webair-flights"]);
    expect(requests.map((request) => request.url).sort()).toEqual(records.map((record) => String(record.locator)).sort());
    for (const request of requests) {
      expect(request.method).toBe("GET");
      expect(request.body).toBeNull();
      expect(Object.keys(request.headers)).toEqual(["accept"]);
    }
  });

  it("refuses the run when the locator redirects or fails (link_fetch_failed)", async () => {
    const pkg = await loadPackageBytes(read("dist/travel-planner-0.1.0.agent.pkg"));
    const redirecting: HttpTransport = async () => ({ status: 302, headers: { location: "https://elsewhere.example/" }, body: "" });
    await expect(fetchPackageBytes("https://webair.example/agent.pkg", redirecting)).rejects.toMatchObject({ code: "download_redirect_denied" });
    await expect(fetchPackageBytes("https://webair.example/agent.pkg", recording().transport)).rejects.toMatchObject({ code: "download_failed" });
    const fixture = fixtureAdapters(pkg);
    await expect(cliLinks(pkg, args({ "--link-grants": LINK_GRANTS }), { mode: "fixture", grants: {}, limits: null, router: fixture.router, compute: null, checkOwnApprovals: () => undefined, jsonFile, transport: recording().transport })).rejects.toThrow(/^link_fetch_failed: dependency '(webair-flights|hotel-aggregator)': /u);
  });
});

describe("fixture mode never dials (L-29)", () => {
  it("with a join fixture that records no web, the slot looks at an empty recorded web: not found, and the transport is never handed a request", async () => {
    const pkg = await loadPackageBytes(read("dist/travel-planner-0.2.0.agent.pkg"));
    const directory = mkdtempSync(join(tmpdir(), "cli-links-"));
    const recorded = jsonFile("examples/link/join-fixture.json") as JsonObject;
    const decisionsOnly = join(directory, "decisions.json");
    writeFileSync(decisionsOnly, JSON.stringify({ schema: recorded.schema, decisions: recorded.decisions }));
    const fixture = fixtureAdapters(pkg);
    const { transport, requests } = recording();
    const grants = jsonFile("examples/link/travel-planner-0.2.0-grants.json") as Record<string, string>;
    const linked = await cliLinks(
      pkg,
      args({
        "--link": [`webair-flights=${ROOT}/dist/webair-flights-0.1.0.agent.pkg`, `hotel-aggregator=${ROOT}/dist/staymere-hotels-0.1.0.agent.pkg`],
        "--link-grants": LINK_GRANTS,
        "--approve-tool": ["check-calendar", "web.search", "webair-flights:search-flights", "hotel-aggregator:search-hotels"],
        "--join-fixture": decisionsOnly,
      }),
      { mode: "fixture", grants, limits: null, router: fixture.router, compute: null, checkOwnApprovals: () => undefined, jsonFile: (path) => JSON.parse(readFileSync(path, "utf8")) as JsonValue, transport },
    );
    let report: ExecutionReport;
    try {
      report = await runWorkflow(pkg, fixture.input, { grants, handlers: fixture.handlers, router: fixture.router, approvedTools: linked.approved, links: linked.links, consent: linked.consent, planHash: linked.planHash });
    } catch (error) {
      report = (error as { execution_report: ExecutionReport }).execution_report;
    }
    const decided = report.audit.filter((event) => event.action === "link.decided") as unknown as JsonObject[];
    expect(decided.map((event) => event.reason)).toEqual(["not_found"]);
    expect(requests).toEqual([]);
    expect(linked.web?.requests.map((request) => request.kind)).toEqual(["discovery"]);
  });
});
