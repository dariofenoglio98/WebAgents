/**
 * Return the one host resource this run was granted for a binding's type (`tool-broker.ts::
 * hostResource`). The argument set is closed to nothing at all: there is no field in which a
 * package or a model could name a resource, so a guessed id or another person's identifier has
 * nowhere to go. The grant is found among this run's grants by type and by a permission the
 * calling tool links, and the resolver re-checks its digest, so a resource removed or changed
 * since the person chose it is refused rather than substituted.
 */
import type { JsonObject, JsonValue } from "../../json.js";
import type { ResourceGrant } from "../../types.js";
import type { ToolBindingRecord } from "../bindings.js";
import type { ToolImplementationDefinition } from "../definitions.js";
import type { ResourceResolver } from "../resources.js";
import { toolError } from "./json-http.js";

export interface HostResourceContext {
  grants: readonly ResourceGrant[];
  resolver: ResourceResolver;
}

export function hostResourceCall(definition: ToolImplementationDefinition, binding: ToolBindingRecord, args: JsonValue, resources: HostResourceContext | null): { output: JsonObject; resource: ResourceGrant } {
  if (!definition.resourceType) throw toolError("tool_unavailable", "this host has no code for that resource implementation");
  if (typeof args !== "object" || args === null || Array.isArray(args) || Object.keys(args).length > 0) {
    throw toolError("tool_request_invalid", "a host resource read takes no arguments, so nothing a package sends can name a resource");
  }
  if (resources === null) throw toolError("tool_unavailable", "this host holds no resources for runs");
  const linked = new Set(binding.required_permission_ids);
  const matches = resources.grants.filter((grant) => grant.resource_type === definition.resourceType && linked.has(grant.permission_id));
  if (matches.length !== 1) throw toolError("tool_request_invalid", "this run was granted no host resource of that type for this tool");
  const grant = matches[0]!;
  let output: JsonObject;
  try {
    output = resources.resolver.resolve(grant);
  } catch {
    throw toolError("tool_unavailable", "the granted host resource is no longer the one that was granted, so it is not returned");
  }
  return { output, resource: { permission_id: grant.permission_id, resource_type: grant.resource_type, resource_id: grant.resource_id, resource_digest: grant.resource_digest } };
}
