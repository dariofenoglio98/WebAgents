// The benchmark's one OpenClaw host, assembled by the Agent Browser plugin's own
// host code (the built `openclaw-agent-browser/dist`), exactly as `backend.ts`
// assembles a host configured like the WebAir live demo:
//
//   hostResources.file   demo/webair/host-resources.json   -> HostResourceStore
//   tools.bindingsFile   demo/webair/host-bindings.json    -> parseOperatorBindings
//   built-in bindings    BUILT_IN_BINDINGS
//
// `toolDefinitions()` is the list `backend.ts` `toolHost()` hands to
// `buildToolRegistry`: the built-ins, one host-resource binding per resource
// type, then the operator's entries. Every package the benchmark opens sees the
// same host, as every package opened in one Agent Browser does.
//
// Shared by `generate_fixtures.mjs` (which records the registries) and by
// `tests/ts_revalidate.mjs` (which needs the live store a run start compares
// resource grants with). The only substitution is the store's digest key:
// production draws a random per-process key, which would make the recorded
// digests change on every generation, so a fixed, public benchmark key is used.
// Digests are equality-comparable references; nothing depends on the key being
// secret here.
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const ROOT = resolve(HERE, "../../..");
export const DIST = join(ROOT, "openclaw-agent-browser/dist");
export const HOST_RESOURCES_FILE = join(ROOT, "demo/webair/host-resources.json");
export const HOST_BINDINGS_FILE = join(ROOT, "demo/webair/host-bindings.json");
// `backend.ts` labels a file-loaded store this way.
export const HOST_RESOURCES_SOURCE = "openclaw plugin host resources file";
export const RESOURCE_DIGEST_KEY = createHash("sha256")
  .update("experiments/contract_overhead host-resource digest key v1")
  .digest();

export async function benchmarkHost() {
  const { HostResourceStore, readHostResourceFile } = await import(
    pathToFileURL(join(DIST, "host-resources.js")).href
  );
  const { BUILT_IN_BINDINGS, parseOperatorBindings, readOperatorBindingsFile } = await import(
    pathToFileURL(join(DIST, "tool-registry.js")).href
  );
  const store = new HostResourceStore(await readHostResourceFile(HOST_RESOURCES_FILE), {
    key: RESOURCE_DIGEST_KEY,
    source: HOST_RESOURCES_SOURCE,
  });
  const operator = parseOperatorBindings(await readOperatorBindingsFile(HOST_BINDINGS_FILE), [
    ...BUILT_IN_BINDINGS,
    ...store.bindings(),
  ]);
  return {
    store,
    toolDefinitions: () => [...BUILT_IN_BINDINGS, ...store.bindings(), ...operator],
  };
}
