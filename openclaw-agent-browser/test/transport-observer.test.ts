import { expect, it } from "vitest";
// @ts-expect-error The probe helper is an intentionally standalone ESM script.
import { transportFacts } from "../scripts/transport-observer.mjs";
it("observes post-sanitization shape without returning values from model data", () => {
  const schema = { type: "object" };
  const facts = transportFacts("https://api.openai.com/v1/responses?private=secret", JSON.stringify({
    model: "PRIVATE", input: "PRIVATE", text: { format: { type: "json_schema", schema } }, max_output_tokens: 50,
  }), schema);
  expect(facts).toMatchObject({route: "openai_api_responses", schema_present: true, schema_matches_requested: true,
    max_output_present: true, max_output_value: 50});
  expect(JSON.stringify(facts)).not.toContain("PRIVATE");
  expect(JSON.stringify(facts)).not.toContain("secret");
  expect(transportFacts("https://chatgpt.com/backend-api/codex/responses", '{"input":"PRIVATE"}', schema))
    .toMatchObject({route: "chatgpt_codex_responses", schema_present: false, max_output_present: false});
});
it("does not claim visibility into unknown routes", () => {
  expect(transportFacts("https://private.test/endpoint", '{}', {})).toBe(null);
});
