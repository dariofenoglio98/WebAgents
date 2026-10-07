/**
 * `fixtures.py::fixture_adapters`: the package's declared fixture as a router, one handler per
 * fixture tool keyed by the tool's binding name, and the fixture input. Fixtures never grant
 * model or tool permissions; the runtime's checks run unchanged over them.
 */
import type { JsonObject, JsonValue } from "./json.js";
import { FixtureRouter, type FixtureCase } from "./models/fixture.js";
import { packageJson, type Package } from "./package.js";
import { deepCopy } from "./references.js";
import { fixtureToolHandler } from "./tools/adapters/fixture.js";
import type { ToolHandler } from "./tools/handler.js";
import { PolicyError } from "./workflow/errors.js";

export interface FixtureAdapters {
  router: FixtureRouter;
  handlers: Record<string, ToolHandler>;
  input: JsonValue;
}

export function fixtureAdapters(pkg: Package): FixtureAdapters {
  const path = pkg.graph.fixture;
  if (path === undefined || path === null) throw new PolicyError("Package has no declared workflow fixture");
  const fixture = packageJson(pkg, String(path)) as JsonObject;
  const handlers: Record<string, ToolHandler> = {};
  for (const [toolId, cases] of Object.entries(fixture.tools as JsonObject)) {
    const binding = String(pkg.tools[toolId]!.binding);
    if (Object.hasOwn(handlers, binding)) throw new PolicyError("Fixture tool bindings must be unique");
    handlers[binding] = fixtureToolHandler(toolId, cases as unknown as FixtureCase[]);
  }
  return { router: new FixtureRouter(fixture.models as JsonObject), handlers, input: deepCopy(fixture.input!) };
}
