import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    env: {
      CODEX_RESET_KIT_TEST_MODE: "1",
    },
    environment: "node",
    include: ["tests/**/*.test.ts"],
    testTimeout: 10_000,
    hookTimeout: 10_000,
  },
});
