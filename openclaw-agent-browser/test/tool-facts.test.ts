import { expect, it } from "vitest";
import { contentTypeCategory, safeToolFacts } from "../src/tool-facts.js";
import { toolError, TOOL_ERRORS } from "../src/tool-broker.js";
it("drops unknown fields and arbitrary strings even when they look like tokens", () => {
  expect(safeToolFacts({ body: "secret", authorization: "sk-secret", stage: "sk-secret",
    content_type: "sk-secret", response_bytes: -1, http_status: 999, timeout: "secret" })).toEqual({});
  expect(safeToolFacts({ stage: "timeout", timeout: true, response_bytes: 4 })).toEqual({
    stage: "timeout", timeout: true, response_bytes: 4 });
});
it("classifies rather than copying content types", () => {
  expect(contentTypeCategory("application/vnd.crossref-api-message+json; secret=x")).toBe("json_suffix");
  expect(contentTypeCategory("secret")).toBe("other");
});
it("timeout and TLS facts have fixed classifications", () => {
  expect(toolError(TOOL_ERRORS.timeout, "fixed").auditFacts).toEqual({ stage: "timeout", timeout: true });
  expect(toolError(TOOL_ERRORS.transport, "fixed", { stage: "tls" }).auditFacts).toEqual({ stage: "tls" });
});
