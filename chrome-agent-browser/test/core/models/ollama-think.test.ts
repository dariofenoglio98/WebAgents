/** The Ollama adapter sends `think` as the host set it and states it (T6). */
import { describe, expect, it } from "vitest";

import { OllamaAdapter } from "../../../src/core/models/adapters/ollama.js";
import type { HttpRequest } from "../../../src/core/models/transport.js";

describe("Ollama thinking", () => {
  for (const think of [undefined, true]) {
    it(`think ${String(think)}: the request carries think ${String(think === true)}`, async () => {
      const seen: HttpRequest[] = [];
      const adapter = new OllamaAdapter({
        model: "qwen3:30b",
        contextWindow: 65536,
        think,
        transport: async (request) => {
          seen.push(request);
          return { status: 200, headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "qwen3:30b", message: { content: "{}" }, done_reason: "stop", prompt_eval_count: 1, eval_count: 1 }) };
        },
      });
      await adapter.complete({ system: "s", user: "u", output_schema: { type: "object" } } as never, 100, new AbortController().signal);
      expect(JSON.parse(seen[0]!.body!).think).toBe(think === true);
      expect(adapter.thinking).toBe(think === true);
    });
  }
});
