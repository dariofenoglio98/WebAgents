/**
 * `workflow.py::bundle_schema`: one of a package's schemas with its package-relative references
 * bundled into one local `$defs` namespace: what a router is handed, self-contained. A slot's
 * request-building call bundles a joined package's input schema the same way (link.v0 L-37).
 */
import { isJsonObject, parseJson, type JsonObject, type JsonValue } from "../json.js";
import type { Package } from "../package.js";
import { schemaReference } from "../references.js";

export function bundleSchema(pkg: Package, path: string): JsonValue {
  const docs = new Map<string, JsonValue>();
  for (const entry of pkg.manifest.schemas as JsonObject[]) {
    const schemaPath = String(entry.path);
    docs.set(schemaPath, parseJson(pkg.files.get(schemaPath)!, schemaPath));
  }
  const names = new Map([...docs.keys()].sort().map((name, index) => [name, `s${index}`] as const));
  const bundle = (value: JsonValue, base: string): JsonValue => {
    if (Array.isArray(value)) return value.map((item) => bundle(item, base));
    if (!isJsonObject(value)) return value;
    const out: JsonObject = {};
    for (const [key, item] of Object.entries(value)) out[key] = bundle(item, base);
    if ("$ref" in value) {
      const [target, fragment] = schemaReference(base, String(value.$ref));
      out.$ref = `#/$defs/${names.get(target)!}${fragment}`;
    }
    return out;
  };
  const included: JsonObject = {};
  const pending: string[] = [path];
  const discover = (value: JsonValue, base: string): void => {
    if (isJsonObject(value)) {
      if ("$ref" in value) {
        const [target] = schemaReference(base, String(value.$ref));
        if (!(names.get(target)! in included) && !pending.includes(target)) pending.push(target);
      }
      for (const child of Object.values(value)) discover(child, base);
    } else if (Array.isArray(value)) {
      for (const child of value) discover(child, base);
    }
  };
  while (pending.length > 0) {
    const current = pending.pop()!;
    included[names.get(current)!] = bundle(docs.get(current)!, current);
    discover(docs.get(current)!, current);
  }
  return { $ref: `#/$defs/${names.get(path)!}`, $defs: included };
}
