import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: ["workers/*", { test: { name: "scripts", include: [".github/scripts/**/*.test.mjs"] } }],
  },
});
