import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    // Every test file opens its own temporary SQLite database through a
    // process-wide connection, so files run one at a time.
    fileParallelism: false,
    testTimeout: 20000,
  },
});
