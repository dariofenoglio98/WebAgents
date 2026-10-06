import { defineConfig } from "vitest/config";

// UI tests select happy-dom with a `// @vitest-environment happy-dom` docblock; everything
// else, the core included, runs in plain Node so that a DOM dependency in the core fails.
export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
