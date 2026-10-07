/**
 * From a Run Plan's model binding to a provider adapter (D-023): three routes, each bound to
 * exactly one model id, no fallback. The host supplies what the binding deliberately does not
 * carry: the transport, base URLs, the person's keys, and the built-in model port.
 */
import { AdapterError } from "../workflow/errors.js";
import { AnthropicAdapter } from "./adapters/anthropic.js";
import { ChromeBuiltinAdapter, type BuiltinModelPort } from "./adapters/chrome-builtin.js";
import { OllamaAdapter } from "./adapters/ollama.js";
import { OpenAIAdapter } from "./adapters/openai.js";
import { contextWindowFor, reasoningFor, type ModelBindingDescriptor } from "./binding.js";
import type { ProviderAdapter } from "./router.js";
import type { HttpTransport, ModelRequestObserver } from "./transport.js";

export interface ProviderHostSettings {
  transport: HttpTransport;
  observer?: ModelRequestObserver | null;
  ollama?: { baseUrl?: string; think?: boolean };
  openai?: { apiKey?: string | null; baseUrl?: string };
  anthropic?: { apiKey?: string | null; baseUrl?: string; effort?: "low" | "medium" | "high" | "xhigh" | "max" };
  builtin?: BuiltinModelPort;
}

export function adapterFor(binding: ModelBindingDescriptor, host: ProviderHostSettings): ProviderAdapter {
  const contextWindow = contextWindowFor(binding);
  const reasoning = reasoningFor(binding);
  const common = { transport: host.transport, observer: host.observer ?? null, contextWindow, reasoning, pricing: binding.pricing };
  switch (binding.provider_id) {
    case "ollama":
      return new OllamaAdapter({ ...common, model: binding.model_id, baseUrl: host.ollama?.baseUrl, think: host.ollama?.think });
    case "openai":
      return new OpenAIAdapter({ ...common, model: binding.model_id, apiKey: host.openai?.apiKey, baseUrl: host.openai?.baseUrl });
    case "anthropic":
      return new AnthropicAdapter({ ...common, model: binding.model_id, apiKey: host.anthropic?.apiKey, baseUrl: host.anthropic?.baseUrl, effort: host.anthropic?.effort });
    case "chrome-builtin":
      if (!host.builtin) throw new AdapterError("model_unavailable", "This host has no built-in model port");
      return new ChromeBuiltinAdapter(host.builtin, contextWindow);
    default:
      throw new AdapterError("selected_model_unavailable", `No adapter exists for provider ${JSON.stringify(binding.provider_id)}`);
  }
}
