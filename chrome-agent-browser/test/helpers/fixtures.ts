/**
 * The Python control plane's records for WebAir 0.4.0 (`test/fixtures/authorization/`),
 * written by the T3 session's scratch script `make_authorization_fixtures.py` on 2026-10-06
 * from `agentpkg` 0.2.2: fixed inputs (`inputs.json`) and the reference's request, receipt,
 * evaluations, run plan and preflight. The Chrome core's tests rebuild each record from the
 * same inputs and compare, field by field and by hash.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { loadPackageBytes, type Package } from "../../src/core/package.js";
import type { JsonObject } from "../../src/core/json.js";
import { PROJECT, readBytes, SHIPPED } from "./paths.js";

const DIRECTORY = join(PROJECT, "test", "fixtures", "authorization");

export function fixture<T = JsonObject>(name: string): T {
  return JSON.parse(readFileSync(join(DIRECTORY, `${name}.json`), "utf8")) as T;
}

export interface FixtureInputs {
  package: string;
  session: {
    session_id: string;
    expires_at: string;
    archive_sha256: string;
    source: { kind: string; display: string; opened_at: string };
    instance_id: string;
    evaluation: JsonObject;
    publisher: JsonObject;
    trust_state: { path: string; entry_count: number; state_sha256: string };
    browser_policy: JsonObject;
  };
  decisions: Record<string, "deny" | "once" | "session">;
  tool_approvals: Record<string, boolean>;
  resource_selections: Record<string, string>;
  tool_registry: JsonObject;
  resource_registry: JsonObject;
  catalog: JsonObject;
}

export const inputs = (): FixtureInputs => fixture<FixtureInputs>("inputs");

let cached: Promise<Package> | null = null;
/** The shipped WebAir 0.4.0 package, loaded once per test file. */
export function webair040(): Promise<Package> {
  cached ??= loadPackageBytes(readBytes(SHIPPED.webair040.archive));
  return cached;
}

let literature: Promise<Package> | null = null;
export function literatureReview(): Promise<Package> {
  literature ??= loadPackageBytes(readBytes(SHIPPED.literatureReview.archive));
  return literature;
}

/** The demo host's resource definitions (`demo/webair/host-resources.json`): types with schemas and fictional records. */
export function demoHostResources(): { types: Array<{ id: string; display_name: string; description?: string; permission_kind: string; schema: JsonObject; sealed_fields?: string[] }>; resources: Array<{ id: string; type: string; label: string; value: JsonObject }> } {
  return JSON.parse(readFileSync(join(PROJECT, "..", "demo", "webair", "host-resources.json"), "utf8"));
}

/** A copy without the keys a comparison must ignore. */
export function without<T extends object>(value: T, paths: readonly string[]): T {
  const copy = JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
  for (const path of paths) {
    const parts = path.split(".");
    let cursor: Record<string, unknown> | undefined = copy;
    for (const part of parts.slice(0, -1)) {
      cursor = cursor?.[part] as Record<string, unknown> | undefined;
    }
    if (cursor) delete cursor[parts[parts.length - 1]!];
  }
  return copy as T;
}
