import path from "node:path";
import { defineConfig } from "vitest/config";

const core = (file: string) => path.resolve(import.meta.dirname, "../core/src", file);

export default defineConfig({
  // The sources, so that the tests do not depend on what was built last.
  resolve: {
    alias: [
      { find: "@voxium/core/node", replacement: core("node.ts") },
      { find: "@voxium/core", replacement: core("index.ts") },
    ],
  },
  test: { include: ["src/**/*.test.ts"], environment: "node" },
});
