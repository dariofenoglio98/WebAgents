import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    environmentMatchGlobs: [["test/ui*.test.ts", "happy-dom"]],
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
