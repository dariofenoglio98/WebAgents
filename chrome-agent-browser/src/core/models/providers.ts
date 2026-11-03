/**
 * From a Run Plan's model binding to a provider adapter (D-023): five routes, each bound to
 * exactly one model id, no fallback. The host supplies what the binding deliberately does not
 * carry: the transport, base URLs, the person's keys, and the built-in model port.
 *
 * What the model delivers comes from the binding alone, for every route (D-130): the context
 * window (`contextWindowFor`) and reasoning (`reasoningFor`) are read from the frozen descriptor
 * that preflight evaluated, so the router's capabilities (`BoundModelRouter`) and the policy's
 * model check agree with the plan by construction.
 */
import { AdapterError } from "../workflow/errors.js";
import { AnthropicAdapter } from "./adapters/anthropic.js";
import { ChromeBuiltinAdapter, type BuiltinModelPort } from "./adapters/chrome-builtin.js";
import { IN_BROWSER_PROVIDER, InBrowserAdapter, type InBrowserEnginePort } from "./adapters/in-browser.js";
import { OllamaAdapter } from "./adapters/ollama.js";
import { OpenAIAdapter, type OpenAIReasoningEffort } from "./adapters/openai.js";
import { contextWindowFor, reasoningFor, type ModelBindingDescriptor } from "./binding.js";
import type { ProviderAdapter } from "./router.js";
import type { HttpTransport, ModelRequestObserver } from "./transport.js";

export interface ProviderHostSettings {
  transport: HttpTransport;
  observer?: ModelRequestObserver | null;
  ollama?: { baseUrl?: string; think?: boolean };
  openai?: { apiKey?: string | null; baseUrl?: string; reasoningEffort?: OpenAIReasoningEffort };
  anthropic?: { apiKey?: string | null; baseUrl?: string; effort?: "low" | "medium" | "high" | "xhigh" | "max" };
  builtin?: BuiltinModelPort;
  /** The in-browser engine's port (D-445), held by the shell that runs the engine Worker; absent on a host without one. */
  inBrowser?: InBrowserEnginePort;
  /** Whether the in-browser engine was loaded with thinking on (D-085). */
  inBrowserThink?: boolean;
}

export function adapterFor(binding: ModelBindingDescriptor, host: ProviderHostSettings): ProviderAdapter {
  const contextWindow = contextWindowFor(binding);
  const reasoning = reasoningFor(binding);
  const common = { transport: host.transport, observer: host.observer ?? null, contextWindow, reasoning, pricing: binding.pricing };
  switch (binding.provider_id) {
    case "ollama":
      return new OllamaAdapter({ ...common, model: binding.model_id, baseUrl: host.ollama?.baseUrl, think: host.ollama?.think });
    case "openai":
      return new OpenAIAdapter({ ...common, model: binding.model_id, apiKey: host.openai?.apiKey, baseUrl: host.openai?.baseUrl, reasoningEffort: host.openai?.reasoningEffort });
    case "anthropic":
      return new AnthropicAdapter({ ...common, model: binding.model_id, apiKey: host.anthropic?.apiKey, baseUrl: host.anthropic?.baseUrl, effort: host.anthropic?.effort });
    case "chrome-builtin":
      if (!host.builtin) throw new AdapterError("model_unavailable", "This host has no built-in model port");
      return new ChromeBuiltinAdapter(host.builtin, { contextWindow, reasoning });
    case IN_BROWSER_PROVIDER:
      if (!host.inBrowser) throw new AdapterError("model_unavailable", "This host runs no in-browser engine");
      return new InBrowserAdapter(host.inBrowser, { entry: binding.model_id, contextWindow, reasoning, think: host.inBrowserThink ?? false, observer: host.observer ?? null });
    default:
      throw new AdapterError("selected_model_unavailable", `No adapter exists for provider ${JSON.stringify(binding.provider_id)}`);
  }
}
