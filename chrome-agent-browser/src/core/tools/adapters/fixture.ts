/**
 * Fixture tool handlers: the same generic exact-input replay for every tool
 * (`fixtures.py::fixture_adapters`). A declared remote fixture tool still counts against its
 * remote-call budget even though it performs no I/O; that is the runtime's accounting, not this
 * file's.
 */
import type { JsonValue } from "../../json.js";
import { deepCopy } from "../../references.js";
import { replay, type FixtureCase } from "../../models/fixture.js";
import type { ToolHandler } from "../handler.js";

export function fixtureToolHandler(toolId: string, cases: readonly FixtureCase[]): ToolHandler {
  const copied = deepCopy(cases as unknown as JsonValue) as unknown as FixtureCase[];
  return async (_context, payload) => {
    await Promise.resolve();
    return replay(copied, payload, toolId);
  };
}
