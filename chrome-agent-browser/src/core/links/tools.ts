/**
 * A linked or joined package's tools on a host whose tool registry is derived per package
 * (link.v0 L-25, L-36; the Chrome hosts: `hosttools.ts` gives one generic HTTPS JSON binding per
 * declared remote tool).
 *
 * The handlers are bound from the linked package's own declaration and the decisions of its own
 * card: its registry, its grants, the tools that card approved and nothing else (D-022). The
 * transport, the pacer and the observer are the host's; the caller's files, resources and memory
 * are not handed over, so nothing of the caller's authority reaches the inner run.
 */
import { buildHostToolRegistry, evaluateRegistry, planToolBindings } from "../hosttools.js";
import type { Package } from "../package.js";
import { normalizeToolBindings } from "../tools/bindings.js";
import { toolHandlers, type BrokerDeps } from "../tools/broker.js";
import { definitionsFromRegistry, type ToolImplementationDefinition } from "../tools/definitions.js";
import type { ToolHandler } from "../tools/handler.js";

/** What of a host's tool deps an inner run may use: how requests leave and are paced and observed, never what the caller was granted. */
export type LinkedBrokerDeps = Omit<BrokerDeps, "definitions" | "files" | "resources" | "memory">;

/** The host's implementations for one linked package: its own registry, with no record type and no agent document (an inner run holds nothing of the person's memory in this version). */
export async function linkedDefinitions(linkedPackage: Package, options: { runtimeVersion: string; now: Date; contactConfigured?: boolean }): Promise<{ registry: Awaited<ReturnType<typeof buildHostToolRegistry>>; definitions: ToolImplementationDefinition[] }> {
  const registry = await buildHostToolRegistry(linkedPackage, { resourceTypes: [], agentTools: null, runtimeVersion: options.runtimeVersion, now: options.now, contactConfigured: options.contactConfigured ?? false });
  return { registry, definitions: definitionsFromRegistry(registry) };
}

/** The tool handlers of a linked or joined package's inner runs, from its card's grants and approved tools. */
export async function linkedToolHandlers(
  linkedPackage: Package,
  decision: { grants: Readonly<Record<string, string>>; approvedTools: readonly string[] },
  tools: LinkedBrokerDeps,
  options: { runtimeVersion: string; now: Date; contactConfigured?: boolean },
): Promise<Record<string, ToolHandler>> {
  const { registry, definitions } = await linkedDefinitions(linkedPackage, options);
  const approvals = Object.fromEntries(Object.keys(linkedPackage.tools).map((toolId) => [toolId, decision.approvedTools.includes(toolId)]));
  const evaluation = await evaluateRegistry(linkedPackage, registry, { decisions: decision.grants as Record<string, "deny" | "once" | "session">, toolApprovals: approvals, now: options.now });
  const bindings = normalizeToolBindings(planToolBindings(evaluation).filter((item) => item.approved));
  return toolHandlers(bindings, { ...tools, definitions }).handlers;
}
